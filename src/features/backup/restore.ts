/**
 * Reading the capsule back. A backup with no implemented restore is a file, not a backup.
 *
 * ─── THE ORDER OF OPERATIONS IS THE WHOLE DESIGN ──────────────────────────────────
 * Restore replaces the only copy of a health record, so nothing destructive happens until
 * everything non-destructive has already succeeded:
 *
 *   1. MAC first. The manifest frame is authenticated against the cleartext header, so a
 *      wrong passphrase and a tampered header are both caught before a byte is written.
 *   2. Schema version next. A capsule from a NEWER build is refused outright — running an
 *      old migration list over a newer schema is how you corrupt a database that was
 *      perfectly fine a moment ago.
 *   3. Unpack to a STAGING path in the cache directory. The live database is untouched.
 *   4. `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the staged file.
 *   5. Rewrite every `*_uri` column against THIS install's document directory. Absolute
 *      paths from the old install do not resolve here — Android's per-install data
 *      directory changes on reinstall — so without this step a restore succeeds and every
 *      prescription photograph is a broken image.
 *   6. Only then swap. The previous database is moved aside, not deleted, and is put back
 *      if the reopened database does not verify.
 *
 * ─── WHY A TYPED FAILURE AND NOT A STRING ─────────────────────────────────────────
 * "Restore failed" is useless on this screen. Wrong passphrase, truncated download,
 * capsule from a newer app and a genuinely corrupt file need four different sentences and
 * three different next actions, so the failure carries a `reason` the UI can switch on.
 * Every failure is thrown rather than returned: the backup screen treats resolution as
 * success, and a resolved failure there would tell the user her record had been restored
 * when it had not.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import { __setDatabaseForTests, DB_NAME, openDatabase } from '../../db';
import { LATEST_VERSION } from '../../db/migrations';
import { assertIdentifier } from '../../db/repositories/_shared';
import { base64ToBytes, readU32 } from './bytes';
import {
  chunkAad,
  deriveCapsuleKey,
  frameNonce,
  manifestAad,
  open as openSealed,
  sha256Stream,
  TAG_BYTES,
} from './crypto';
import {
  decodeHeader,
  HEADER_PREFIX_BYTES,
  parseManifest,
  type CapsuleEntry,
  type CapsuleManifest,
} from './format';
import { getStoredRecoveryPhrase } from './passphrase';
import {
  clearWorkDirectory,
  documentRootPath,
  excludedTopLevelNames,
  MEDIA_PREFIX,
  sqliteDirectoryPath,
  toFsPath,
  workDirectory,
} from './paths';

export type RestoreFailureReason =
  /** The file is not an Aarogya capsule at all. */
  | 'not_a_capsule'
  /** The manifest MAC failed. Overwhelmingly the most likely cause is a typo. */
  | 'wrong_passphrase'
  /** No passphrase was supplied and this phone has no stored recovery phrase. */
  | 'no_passphrase'
  /** A frame MAC failed, or the manifest is internally inconsistent. */
  | 'corrupt'
  /** The file ends before the manifest says it should. */
  | 'truncated'
  /** Written by a newer build of Aarogya than this one. */
  | 'newer_schema'
  /** The staged database failed `integrity_check` or `foreign_key_check`. */
  | 'integrity_failed'
  /** Unpacking and verification succeeded but the swap did not. The old record is back. */
  | 'swap_failed';

export const RESTORE_FAILURE_COPY: Record<
  RestoreFailureReason,
  { readonly i18nKey: string; readonly en: string }
> = {
  not_a_capsule: {
    i18nKey: 'restore.fail.notACapsule',
    en: 'That file is not an Aarogya copy.',
  },
  wrong_passphrase: {
    i18nKey: 'restore.fail.wrongPassphrase',
    en: 'That recovery phrase does not open this copy. Check it and try again.',
  },
  no_passphrase: {
    i18nKey: 'restore.fail.noPassphrase',
    en: 'This copy needs its recovery phrase, and this phone does not have one saved.',
  },
  corrupt: {
    i18nKey: 'restore.fail.corrupt',
    en: 'This copy is damaged and cannot be opened. Nothing on this phone has changed.',
  },
  truncated: {
    i18nKey: 'restore.fail.truncated',
    en: 'This copy is incomplete — it may not have finished transferring. Nothing has changed.',
  },
  newer_schema: {
    i18nKey: 'restore.fail.newerSchema',
    en: 'This copy was made by a newer version of Aarogya. Update the app, then bring it back.',
  },
  integrity_failed: {
    i18nKey: 'restore.fail.integrity',
    en: 'The record inside this copy did not pass its checks, so it was not used. Nothing has changed.',
  },
  swap_failed: {
    i18nKey: 'restore.fail.swap',
    en: 'The copy could not be put in place. Your existing record has been left as it was.',
  },
};

export class RestoreError extends Error {
  readonly reason: RestoreFailureReason;
  readonly i18nKey: string;
  readonly detail: string | null;

  constructor(reason: RestoreFailureReason, detail?: string) {
    const copy = RESTORE_FAILURE_COPY[reason];
    super(detail ? `${copy.en} (${detail})` : copy.en);
    this.name = 'RestoreError';
    this.reason = reason;
    this.i18nKey = copy.i18nKey;
    this.detail = detail ?? null;
  }
}

export function isRestoreError(error: unknown): error is RestoreError {
  return error instanceof RestoreError;
}

export type RestoreResult = {
  readonly restoredAtEpoch: number;
  readonly manifest: CapsuleManifest;
  readonly filesRestored: number;
  /**
   * Media the capsule did not contain or could not verify — by capsule path.
   *
   * A NON-FATAL outcome with a name. The database is restored and usable; some
   * photographs are gone, and the UI should say which rather than leaving the user to
   * discover it one broken thumbnail at a time.
   */
  readonly mediaMissing: readonly string[];
  readonly partialMedia: boolean;
  /** How many `*_uri` values were re-pointed at this install's document directory. */
  readonly urisRewritten: number;
  /** URIs that pointed outside the old document root and could not be re-pointed. */
  readonly urisUnresolved: number;
  /** Where the pre-restore database was parked, in case somebody needs it. */
  readonly rollbackPath: string | null;
};

export type RestoreProgress = {
  readonly phase: 'reading' | 'verifying' | 'staging' | 'swapping';
  readonly fraction: number | null;
};

export type ImportOptions = {
  readonly onProgress?: (progress: RestoreProgress) => void;
  readonly now?: () => number;
};

/**
 * Restores a capsule over the live record.
 *
 * @param uri the capsule file.
 * @param passphrase optional. Omitted means "use the recovery phrase this phone stored",
 *   which is the case that matters on the SAME handset; a capsule opened on a NEW handset
 *   always needs the phrase typed in, because the keystore did not survive the journey.
 */
export async function importCapsule(
  uri: string,
  passphrase?: string,
  options: ImportOptions = {},
): Promise<RestoreResult> {
  const now = options.now ?? Date.now;
  const report = options.onProgress ?? (() => undefined);
  const startedAt = now();

  const capsule = new File(uri);
  if (!capsule.exists) throw new RestoreError('not_a_capsule', 'the file is not there');

  let effectivePassphrase = passphrase?.trim() ?? '';
  if (effectivePassphrase.length === 0) {
    const stored = await getStoredRecoveryPhrase();
    if (!stored) throw new RestoreError('no_passphrase');
    effectivePassphrase = stored;
  }

  const staging = new Directory(workDirectory(), `restore-${startedAt}`);
  staging.create({ intermediates: true, idempotent: true });

  try {
    report({ phase: 'reading', fraction: null });

    const handle = capsule.open();
    let manifest: CapsuleManifest;
    let staged: StagedFiles;

    try {
      // ── header ──────────────────────────────────────────────────────────
      const prefix = handle.readBytes(HEADER_PREFIX_BYTES);
      if (prefix.length < HEADER_PREFIX_BYTES) throw new RestoreError('not_a_capsule', 'shorter than a header');
      const declaredHeaderLength = readU32(prefix, prefix.length - 4);
      const headerJsonBytes = handle.readBytes(declaredHeaderLength);
      if (headerJsonBytes.length < declaredHeaderLength) throw new RestoreError('truncated', 'header');

      let decoded;
      try {
        decoded = decodeHeader(concat(prefix, headerJsonBytes));
      } catch (error) {
        throw new RestoreError(
          message(error).includes('format version') ? 'newer_schema' : 'not_a_capsule',
          message(error),
        );
      }
      const { header, headerBytes } = decoded;

      const salt = base64ToBytes(header.salt);
      const nonceBase = base64ToBytes(header.nonceBase);
      const key = await deriveCapsuleKey(effectivePassphrase, salt, header.kdf);

      // ── frame 0: the manifest ───────────────────────────────────────────
      const manifestFrame = readFrame(handle, header.chunkBytes);
      const manifestBytes = openSealed(key, frameNonce(nonceBase, 0), manifestFrame, manifestAad(headerBytes));
      // The ONLY thing a failure here plausibly means. The header is authenticated by the
      // same tag, so a tampered header lands in the same place — and telling a user her
      // passphrase is wrong when the file was edited is a far better failure than the
      // reverse.
      if (!manifestBytes) throw new RestoreError('wrong_passphrase');

      try {
        manifest = parseManifest(manifestBytes);
      } catch (error) {
        throw new RestoreError('corrupt', message(error));
      }

      // ── the version gate, before anything is written ────────────────────
      if (manifest.schemaUserVersion > LATEST_VERSION) {
        throw new RestoreError(
          'newer_schema',
          `capsule schema v${manifest.schemaUserVersion}, this build knows v${LATEST_VERSION}`,
        );
      }

      report({ phase: 'staging', fraction: 0 });
      staged = unpack(handle, {
        key,
        nonceBase,
        headerBytes,
        manifestBytes,
        chunkBytes: header.chunkBytes,
        manifest,
        staging,
        report,
      });
    } finally {
      handle.close();
    }

    // ── verify the staged database ────────────────────────────────────────
    report({ phase: 'verifying', fraction: null });
    const rewrite = await verifyAndRepoint(staged.databaseDirectory, manifest.documentRoot);

    // ── swap ──────────────────────────────────────────────────────────────
    report({ phase: 'swapping', fraction: null });
    const rollbackPath = await swapIn(staged);

    return {
      restoredAtEpoch: now(),
      manifest,
      filesRestored: staged.mediaRestored,
      mediaMissing: staged.mediaMissing,
      partialMedia: staged.mediaMissing.length > 0 || manifest.skipped.length > 0,
      urisRewritten: rewrite.rewritten,
      urisUnresolved: rewrite.unresolved,
      rollbackPath,
    };
  } finally {
    try {
      if (staging.exists) staging.delete();
    } catch (error) {
      console.warn('[restore] could not clear the staging directory', error);
    }
    clearWorkDirectory();
  }
}

// ── unpacking ────────────────────────────────────────────────────────────────

type StagedFiles = {
  /** Directory holding the staged `aarogya.db`, ready for `openDatabaseAsync(name, {}, dir)`. */
  readonly databaseDirectory: string;
  readonly databaseFile: File;
  /** Absolute staged path → absolute destination path under the document directory. */
  readonly media: readonly { readonly staged: File; readonly destinationUri: string }[];
  readonly mediaRestored: number;
  readonly mediaMissing: readonly string[];
};

type UnpackContext = {
  readonly key: Uint8Array;
  readonly nonceBase: Uint8Array;
  readonly headerBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly chunkBytes: number;
  readonly manifest: CapsuleManifest;
  readonly staging: Directory;
  readonly report: (progress: RestoreProgress) => void;
};

type ReadableHandle = { readBytes(length: number): Uint8Array };

function unpack(handle: ReadableHandle, context: UnpackContext): StagedFiles {
  const excluded = new Set(excludedTopLevelNames());
  const media: { staged: File; destinationUri: string }[] = [];
  const mediaMissing: string[] = [];

  let databaseFile: File | null = null;
  let databaseDirectory = '';

  const totalFrames = context.manifest.entries.reduce((sum, entry) => sum + entry.frameCount, 0);
  let framesDone = 0;

  for (const entry of context.manifest.entries) {
    const target = stagedFileFor(entry, context.staging);
    if (target.exists) target.delete();
    target.create({ overwrite: true, intermediates: true });

    const hasher = sha256Stream();
    const writer = target.open();
    try {
      for (let i = 0; i < entry.frameCount; i += 1) {
        const frameIndex = entry.firstFrame + i;
        const sealed = readFrame(handle, context.chunkBytes);
        const plain = openSealed(
          context.key,
          frameNonce(context.nonceBase, frameIndex),
          sealed,
          chunkAad(context.headerBytes, context.manifestBytes, frameIndex),
        );
        // Every frame is authenticated under the same key that already opened the
        // manifest, so a failure here is damage to the file, never a bad passphrase.
        if (!plain) throw new RestoreError('corrupt', `frame ${frameIndex} of "${entry.path}"`);
        hasher.update(plain);
        writer.writeBytes(plain);
        framesDone += 1;
      }
    } finally {
      writer.close();
    }

    context.report({ phase: 'staging', fraction: totalFrames > 0 ? framesDone / totalFrames : 1 });

    const digest = hasher.hex();
    if (digest !== entry.sha256) {
      if (entry.kind === 'database') {
        // The MACs passed and the hash did not, which means the capsule is internally
        // inconsistent. Never usable.
        throw new RestoreError('corrupt', 'the database checksum does not match the manifest');
      }
      // One bad photograph is not worth refusing the whole record over.
      console.warn(`[restore] checksum mismatch on "${entry.path}" — leaving it out`);
      mediaMissing.push(entry.path);
      try {
        target.delete();
      } catch {
        /* the staging directory is deleted wholesale in the caller's finally */
      }
      continue;
    }

    if (entry.kind === 'database') {
      databaseFile = target;
      databaseDirectory = toFsPath(target.parentDirectory.uri).replace(/\/+$/, '');
      continue;
    }

    const relative = entry.path.slice(MEDIA_PREFIX.length);
    const firstSegment = relative.split('/')[0] ?? '';
    if (excluded.has(firstSegment)) {
      // A capsule that claims a media file belongs in 'SQLite/' or 'backups/' is either
      // malformed or hostile. Neither is worth honouring.
      console.warn(`[restore] refusing to write "${entry.path}" into a reserved directory`);
      mediaMissing.push(entry.path);
      continue;
    }
    media.push({
      staged: target,
      destinationUri: `${Paths.document.uri.replace(/\/+$/, '')}/${relative}`,
    });
  }

  if (!databaseFile) throw new RestoreError('corrupt', 'the capsule contains no database');

  for (const path of context.manifest.skipped.map((entry) => entry.path)) mediaMissing.push(path);

  return {
    databaseDirectory,
    databaseFile,
    media,
    mediaRestored: media.length,
    mediaMissing,
  };
}

function stagedFileFor(entry: CapsuleEntry, staging: Directory): File {
  // `parseManifest` already proved the path is relative and free of '..', so joining it
  // onto the staging directory cannot escape it.
  return new File(staging, entry.path);
}

/** Reads one length-prefixed frame, refusing implausible lengths before allocating. */
function readFrame(handle: ReadableHandle, chunkBytes: number): Uint8Array {
  const lengthBytes = handle.readBytes(4);
  if (lengthBytes.length < 4) throw new RestoreError('truncated', 'frame length');
  const length = readU32(lengthBytes, 0);
  if (length < TAG_BYTES || length > chunkBytes + TAG_BYTES) {
    throw new RestoreError('corrupt', `frame length ${length} is impossible`);
  }
  const sealed = handle.readBytes(length);
  if (sealed.length < length) throw new RestoreError('truncated', 'frame body');
  return sealed;
}

// ── verification and URI repointing ──────────────────────────────────────────

type RepointResult = { readonly rewritten: number; readonly unresolved: number };

/**
 * Opens the staged database, proves it is sound, and re-points every `*_uri` column.
 *
 * The column list is DISCOVERED from `PRAGMA table_info` rather than hard-coded. There
 * are six URI columns across five tables today, and the day somebody adds a seventh, a
 * hard-coded list would silently leave that one pointing at a directory belonging to a
 * previous install — a broken image with no error anywhere.
 */
async function verifyAndRepoint(databaseDirectory: string, oldDocumentRoot: string): Promise<RepointResult> {
  const staged = await SQLite.openDatabaseAsync(DB_NAME, {}, databaseDirectory);
  try {
    const integrity = await staged.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    if (!integrity || integrity.integrity_check !== 'ok') {
      throw new RestoreError('integrity_failed', integrity?.integrity_check ?? 'no result');
    }

    await staged.execAsync('PRAGMA foreign_keys = ON;');
    const violations = await staged.getAllAsync('PRAGMA foreign_key_check;');
    if (violations.length > 0) {
      throw new RestoreError('integrity_failed', `${violations.length} foreign key violation(s)`);
    }

    const newRoot = documentRootPath();
    let rewritten = 0;
    let unresolved = 0;

    const tables = await staged.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';`,
    );

    for (const table of tables) {
      const tableName = assertIdentifier(table.name);
      const columns = await staged.getAllAsync<{ name: string }>(`PRAGMA table_info(${tableName});`);
      for (const column of columns) {
        if (!/_uri$/.test(column.name) && column.name !== 'uri') continue;
        const columnName = assertIdentifier(column.name);

        // Both spellings, because the app stores `file://…` URIs and a hand-written row
        // could carry a bare path. Longest prefix first so the scheme-qualified form is
        // not half-rewritten by the bare one.
        for (const [oldPrefix, newPrefix] of [
          [`file://${oldDocumentRoot}`, `file://${newRoot}`],
          [oldDocumentRoot, newRoot],
        ] as const) {
          if (oldPrefix.length === 0) continue;
          try {
            const result = await staged.runAsync(
              `UPDATE ${tableName}
                  SET ${columnName} = ? || substr(${columnName}, ?)
                WHERE ${columnName} IS NOT NULL
                  AND substr(${columnName}, 1, ?) = ?;`,
              [newPrefix, oldPrefix.length + 1, oldPrefix.length, oldPrefix],
            );
            rewritten += result.changes;
          } catch (error) {
            // An append-only guard trigger refusing this UPDATE is survivable: the row
            // keeps a URI pointing at the old install, which is one broken thumbnail.
            // Aborting the whole restore over it would cost the entire clinical history.
            // Counted as unresolved below, so the UI can still say what is missing.
            console.warn(`[restore] could not re-point ${tableName}.${columnName}`, error);
          }
        }

        const leftover = await staged.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${tableName}
            WHERE ${columnName} IS NOT NULL
              AND ${columnName} <> ''
              AND substr(${columnName}, 1, ?) <> ?;`,
          [`file://${newRoot}`.length, `file://${newRoot}`],
        );
        unresolved += leftover?.n ?? 0;
      }
    }

    return { rewritten, unresolved };
  } finally {
    await staged.closeAsync();
  }
}

// ── the swap ─────────────────────────────────────────────────────────────────

/**
 * Puts the staged record in place, keeping the previous one until the new one verifies.
 *
 * The live connection is closed first and the module-level handle in `src/db/index.ts` is
 * dropped through its exported seam — without that, every repository in the app would go
 * on talking to a file that has just been moved out from under it, and the first write
 * would fail somewhere unrelated and unexplainable.
 */
async function swapIn(staged: StagedFiles): Promise<string | null> {
  const liveDirectory = sqliteDirectoryPath();
  const rollback = new Directory(workDirectory(), `rollback-${Date.now()}`);
  const parked: { from: string; to: File }[] = [];

  await closeLiveDatabase();
  rollback.create({ intermediates: true, idempotent: true });

  try {
    // WAL and SHM go too. Leaving a stale `-wal` beside a replaced `.db` is a database
    // that opens and then replays journal entries belonging to a different file.
    for (const suffix of ['', '-wal', '-shm']) {
      const existing = new File(`file://${liveDirectory}/${DB_NAME}${suffix}`);
      if (!existing.exists) continue;
      const parkedFile = new File(rollback, `${DB_NAME}${suffix}`);
      existing.move(parkedFile);
      parked.push({ from: existing.uri, to: parkedFile });
    }

    const destination = new File(`file://${liveDirectory}/${DB_NAME}`);
    staged.databaseFile.copy(destination);

    for (const item of staged.media) {
      try {
        const target = new File(item.destinationUri);
        if (target.exists) target.delete();
        target.create({ overwrite: true, intermediates: true });
        item.staged.copy(target);
      } catch (error) {
        // A photograph that will not land is a partial restore, not a failed one. The
        // database — which is what carries the clinical history — is already in place.
        console.warn(`[restore] could not put back "${item.destinationUri}"`, error);
      }
    }

    // Prove it. `openDatabase` re-runs the version gate, applies any migrations the
    // capsule predates, and verifies integrity again on the file that is now live.
    const reopened = await openDatabase();
    const check = await reopened.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    if (!check || check.integrity_check !== 'ok') {
      throw new RestoreError('swap_failed', check?.integrity_check ?? 'no result');
    }

    return rollback.uri;
  } catch (error) {
    console.warn('[restore] the swap failed — putting the previous record back', error);
    try {
      await closeLiveDatabase();
      for (const suffix of ['', '-wal', '-shm']) {
        const replaced = new File(`file://${liveDirectory}/${DB_NAME}${suffix}`);
        if (replaced.exists) replaced.delete();
      }
      for (const item of parked) {
        item.to.copy(new File(item.from));
      }
      await openDatabase();
    } catch (rollbackError) {
      console.warn('[restore] the rollback ALSO failed', rollbackError);
    }
    throw error instanceof RestoreError ? error : new RestoreError('swap_failed', message(error));
  }
}

/**
 * Closes the app-wide connection and clears the cached handle.
 *
 * `__setDatabaseForTests` is named for its original purpose, but it is the only exported
 * way to invalidate that module-level cache, and restore is the one production caller
 * that genuinely has to. Reaching in through it is deliberate and documented here so it
 * does not read as a mistake — the alternative would be editing `src/db/index.ts`, which
 * this feature does not own.
 */
async function closeLiveDatabase(): Promise<void> {
  try {
    const live = await openDatabase();
    await live.closeAsync();
  } catch (error) {
    console.warn('[restore] could not close the live database cleanly', error);
  } finally {
    __setDatabaseForTests(null);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
