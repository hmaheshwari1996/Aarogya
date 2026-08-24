/**
 * Writing the capsule. This is the only disaster-recovery path in the product.
 *
 * ─── WHY THIS IS NOT OPTIONAL POLISH ──────────────────────────────────────────────
 * Storage is local-only by design and there is no cloud copy of anything. That is the
 * right privacy position and it has exactly one cost, which lands entirely on the user:
 * a phone that is lost, stolen, dropped in water or simply factory-reset takes the whole
 * history with it. The situation is worse than it first looks, because this app can only
 * be upgraded in place while the signing keystore survives — lose the keystore and the
 * only way to install the next build is to uninstall the current one, which wipes app
 * storage. So even the boring, planned path can destroy the record.
 *
 * The capsule is the answer to all of that, and it is only an answer if it is ONE FILE
 * the user can put somewhere else.
 *
 * ─── WHY `VACUUM INTO` AND NOT A FILE COPY ────────────────────────────────────────
 * The database runs in WAL mode. Copying `aarogya.db`, `-wal` and `-shm` as three files
 * can capture them mid-checkpoint, producing a set that is individually intact and
 * collectively inconsistent — a backup that opens fine and is missing yesterday. A
 * checkpoint followed by `VACUUM INTO` is one statement that produces one file which
 * SQLite guarantees is a consistent snapshot. `src/db/index.ts` already takes
 * pre-migration snapshots this way; this is the same move for the same reason.
 *
 * ─── WHY TWO PASSES OVER THE FILES ────────────────────────────────────────────────
 * The manifest carries a SHA-256 per file and is sealed as frame 0, before any payload —
 * so it has to be complete before the first byte of payload is written. Hashing during
 * the encrypting pass would mean either buffering everything (impossible at this size) or
 * putting the manifest at the end (where a truncated capsule loses the very thing that
 * would have told you it was truncated). So: pass one hashes, pass two encrypts. Reading
 * a few hundred megabytes twice off flash costs a couple of seconds. It buys a capsule
 * that can prove what is inside it before it starts unpacking.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';

import { openDatabase } from '../../db';
import { getProfile } from '../../db/repositories/profiles';
import { toLocalDate } from '../../lib/datetime';
import { bytesToBase64 } from './bytes';
import {
  chunkAad,
  deriveCapsuleKey,
  frameNonce,
  KDF_PARAMS,
  manifestAad,
  NONCE_BASE_BYTES,
  SALT_BYTES,
  seal,
  sha256Stream,
} from './crypto';
import {
  CHUNK_BYTES,
  capsuleFileName,
  defaultHeader,
  encodeHeader,
  encodeManifest,
  frameBytes,
  framesFor,
  MAGIC_BYTES,
  MAX_CAPSULE_BYTES,
  type CapsuleEntry,
  type CapsuleManifest,
  type SkippedFile,
} from './format';
import { ensureRecoveryPhrase } from './passphrase';
import {
  backupDirectory,
  clearWorkDirectory,
  DB_CAPSULE_PATH,
  documentRootPath,
  scanMediaFiles,
  toFsPath,
  workDirectory,
  type MediaCandidate,
} from './paths';
import { recordCapsuleWritten } from './nudge';

export type ExportProgress = {
  readonly phase: 'snapshot' | 'inventory' | 'sealing' | 'finishing';
  /** 0…1, or null while the total is not yet known. */
  readonly fraction: number | null;
  readonly framesWritten: number;
  readonly framesTotal: number;
};

export type CapsuleExportResult = {
  readonly uri: string;
  readonly fileName: string;
  /** Size of the finished, encrypted file. */
  readonly bytes: number;
  readonly manifest: CapsuleManifest;
  /**
   * The phrase this capsule was sealed with, when the app supplied it.
   *
   * Null when the caller passed its own passphrase. NON-NULL means the UI is obliged to
   * show it — a capsule whose passphrase exists only in this phone's keystore is not a
   * backup, it is a second copy of a file that dies with the handset.
   */
  readonly recoveryPhrase: string | null;
  /** True the first time a phrase was generated. That is when to insist she writes it down. */
  readonly recoveryPhraseIsNew: boolean;
  readonly skipped: readonly SkippedFile[];
  readonly elapsedMs: number;
};

export type ExportOptions = {
  readonly onProgress?: (progress: ExportProgress) => void;
  /** Injectable for tests; production always uses the platform CSPRNG. */
  readonly randomBytes?: (count: number) => Uint8Array;
  readonly now?: () => number;
};

/** Frames written between yields. Keeps the export spinner animating on a Go-class phone. */
const FRAMES_PER_BREATH = 8;

/**
 * Writes one encrypted capsule and returns where it landed.
 *
 * THROWS on every failure. The backup screen treats resolution as success and shows
 * "the copy could not be made" on rejection, and that mapping is only correct if there is
 * no such thing as a resolved failure here.
 *
 * @param profileId whose record is being saved. Recorded in the manifest; the capsule
 *   itself always contains the whole database, because a schema with foreign keys across
 *   profiles cannot be usefully cut in half.
 * @param passphrase optional. Omitted — which is what the screen does — means the app's
 *   own recovery phrase is used and returned in the result for display.
 */
export async function exportCapsule(
  profileId: string,
  passphrase?: string,
  options: ExportOptions = {},
): Promise<CapsuleExportResult> {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((count: number) => Crypto.getRandomBytes(count));
  const startedAt = now();
  const report = options.onProgress ?? (() => undefined);

  let suppliedPhrase: string | null = null;
  let phraseIsNew = false;
  let effectivePassphrase = passphrase?.trim() ?? '';
  if (effectivePassphrase.length === 0) {
    const generated = await ensureRecoveryPhrase();
    suppliedPhrase = generated.phrase;
    phraseIsNew = generated.created;
    effectivePassphrase = generated.phrase;
  }

  const work = workDirectory();
  const snapshot = new File(work, `snapshot-${startedAt}.db`);
  let output: File | null = null;

  try {
    // ── 1. A consistent copy of the database ────────────────────────────────
    report({ phase: 'snapshot', fraction: null, framesWritten: 0, framesTotal: 0 });

    const db = await openDatabase();
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    if (snapshot.exists) snapshot.delete();
    // Single-quoted literal, and the path is one this module built from `Paths.cache`
    // plus a numeric timestamp — there is no user-supplied text anywhere in it.
    await db.execAsync(`VACUUM INTO '${toFsPath(snapshot.uri)}';`);

    const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
    const schemaUserVersion = versionRow?.user_version ?? 0;
    const profile = await getProfile(profileId);

    // ── 2. Inventory: hash everything, decide the frame table ───────────────
    report({ phase: 'inventory', fraction: null, framesWritten: 0, framesTotal: 0 });

    const media = scanMediaFiles();
    const snapshotBytes = snapshot.size;
    const totalPlaintextBytes = snapshotBytes + media.totalBytes;

    if (totalPlaintextBytes > MAX_CAPSULE_BYTES) {
      throw new Error(
        `This record is ${Math.round(totalPlaintextBytes / (1024 * 1024))} MB, which is past the ` +
          `${Math.round(MAX_CAPSULE_BYTES / (1024 * 1024))} MB a single capsule can safely carry on this phone.`,
      );
    }

    const skipped: SkippedFile[] = [...media.skipped];
    const entries: CapsuleEntry[] = [];
    let nextFrame = 1;

    entries.push({
      kind: 'database',
      path: DB_CAPSULE_PATH,
      bytes: snapshotBytes,
      sha256: hashFile(snapshot),
      firstFrame: nextFrame,
      frameCount: framesFor(snapshotBytes),
    });
    nextFrame += framesFor(snapshotBytes);

    const included: MediaCandidate[] = [];
    for (const candidate of media.files) {
      let digest: string;
      try {
        digest = hashFile(new File(candidate.uri));
      } catch (error) {
        // A file that vanished between the scan and the hash (a cache eviction, a photo
        // the user deleted mid-export) is skipped by name rather than failing the whole
        // capsule. Everything else still gets saved.
        console.warn(`[backup] could not read "${candidate.capsulePath}" — skipping it`, error);
        skipped.push({ path: candidate.capsulePath, bytes: candidate.bytes, reason: 'unreadable' });
        continue;
      }
      const frameCount = framesFor(candidate.bytes);
      entries.push({
        kind: 'media',
        path: candidate.capsulePath,
        bytes: candidate.bytes,
        sha256: digest,
        firstFrame: nextFrame,
        frameCount,
      });
      nextFrame += frameCount;
      included.push(candidate);
    }

    const manifest: CapsuleManifest = {
      format: 'aarogya.capsule.manifest',
      v: 1,
      createdAtEpoch: startedAt,
      createdLocalDate: toLocalDate(new Date(startedAt)),
      appVersion: appVersion(),
      schemaUserVersion,
      profileId,
      profileName: profile?.displayName ?? null,
      documentRoot: documentRootPath(),
      entries,
      skipped,
      totalPlaintextBytes,
    };

    // ── 3. Seal and write ───────────────────────────────────────────────────
    const salt = randomBytes(SALT_BYTES);
    const nonceBase = randomBytes(NONCE_BASE_BYTES);
    const header = defaultHeader(bytesToBase64(salt), bytesToBase64(nonceBase), startedAt, CHUNK_BYTES);
    const { prefix, headerBytes } = encodeHeader(header);
    const manifestBytes = encodeManifest(manifest);

    const key = await deriveCapsuleKey(effectivePassphrase, salt, KDF_PARAMS);

    const fileName = capsuleFileName(startedAt);
    output = new File(backupDirectory(), fileName);
    if (output.exists) output.delete();
    output.create({ overwrite: true, intermediates: true });

    const handle = output.open();
    const framesTotal = nextFrame - 1;
    let framesWritten = 0;

    try {
      handle.writeBytes(prefix);
      handle.writeBytes(headerBytes);
      writeFrame(handle, seal(key, frameNonce(nonceBase, 0), manifestBytes, manifestAad(headerBytes)));

      report({ phase: 'sealing', fraction: 0, framesWritten: 0, framesTotal });

      // The database first, then media, in exactly the order the manifest promised.
      const sources: { entry: CapsuleEntry; uri: string }[] = [
        { entry: entries[0] as CapsuleEntry, uri: snapshot.uri },
        ...included.map((candidate, index) => ({
          entry: entries[index + 1] as CapsuleEntry,
          uri: candidate.uri,
        })),
      ];

      for (const source of sources) {
        const reader = new File(source.uri).open();
        try {
          for (let i = 0; i < source.entry.frameCount; i += 1) {
            const plain = reader.readBytes(CHUNK_BYTES);
            if (plain.length === 0) break;
            const frameIndex = source.entry.firstFrame + i;
            writeFrame(
              handle,
              seal(
                key,
                frameNonce(nonceBase, frameIndex),
                plain,
                chunkAad(headerBytes, manifestBytes, frameIndex),
              ),
            );
            framesWritten += 1;
            if (framesWritten % FRAMES_PER_BREATH === 0) {
              report({
                phase: 'sealing',
                fraction: framesTotal > 0 ? framesWritten / framesTotal : 1,
                framesWritten,
                framesTotal,
              });
              await breathe();
            }
          }
        } finally {
          reader.close();
        }
      }
    } finally {
      handle.close();
    }

    report({ phase: 'finishing', fraction: 1, framesWritten, framesTotal });

    const bytes = output.size;
    await recordCapsuleWritten(startedAt, bytes);

    return {
      uri: output.uri,
      fileName,
      bytes,
      manifest,
      recoveryPhrase: suppliedPhrase,
      recoveryPhraseIsNew: phraseIsNew,
      skipped,
      elapsedMs: now() - startedAt,
    };
  } catch (error) {
    // A half-written capsule is worse than none: the backup screen lists it by name and
    // the user would believe they had a copy.
    if (output) {
      try {
        if (output.exists) output.delete();
      } catch (cleanupError) {
        console.warn('[backup] could not remove the half-written capsule', cleanupError);
      }
    }
    throw error;
  } finally {
    // The snapshot is the whole health record IN THE CLEAR. It does not outlive this call.
    try {
      if (snapshot.exists) snapshot.delete();
    } catch (cleanupError) {
      console.warn('[backup] could not delete the plaintext snapshot', cleanupError);
    }
    clearWorkDirectory();
  }
}

/**
 * Lists the capsules sitting on this phone, newest first.
 *
 * EVERY ROW HAS BEEN CHECKED FOR THE SIGNATURE, and that is not tidiness. This list is
 * what the backup screen counts, badges and offers to restore from, and the count decides
 * which sentence the delete dialog shows — "one other copy stays here" against "this is
 * the only copy on this phone". A raw directory listing makes all three answers wrong in
 * the same direction, towards reassurance:
 *
 *   • `exportCapsule` creates the output file BEFORE writing it and only removes a
 *     half-written one from its own catch block. A process kill or an OOM mid-export
 *     therefore leaves a truncated `.aarogya` behind, carrying a perfectly parseable
 *     timestamp in its name — so it sorts newest, takes the "Newest copy" badge on the
 *     one screen where she is choosing which file to keep, and offers "Bring this copy
 *     back" for a file that cannot be brought back.
 *   • Anything else copied into `backups/` from a computer counts just the same.
 *
 * A file that fails this check is DROPPED rather than shown greyed out, on the reasoning
 * already in this file's export path: a half-written capsule is worse than none, because
 * the screen lists it by name and she believes she has a copy. It is not deleted — this
 * function only reads, and unlinking a file the user may have put there deliberately is
 * not a listing's job.
 *
 * The check is the SIGNATURE ONLY: no key, no passphrase, no manifest. It separates "not
 * one of ours / never finished" from "ours"; whether the contents open is `importCapsule`'s
 * question and needs her recovery phrase to answer.
 */
export function listCapsules(): { name: string; uri: string; bytes: number; modifiedAtEpoch: number }[] {
  let contents: (Directory | File)[];
  try {
    contents = backupDirectory().list();
  } catch (error) {
    console.warn('[backup] could not list the backups folder', error);
    return [];
  }
  return contents
    .filter((entry): entry is File => entry instanceof File)
    .filter(startsWithCapsuleSignature)
    .map((file) => ({
      name: file.name,
      uri: file.uri,
      bytes: file.size,
      modifiedAtEpoch: file.modificationTime ?? file.creationTime ?? 0,
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * What actually happened on disk. The screen says different things for each, and the
 * difference matters: "deleted" is an act she performed, "already_absent" is a file that
 * had gone before she asked — she may have removed it from a file manager, or restored a
 * different phone's storage over this one. Reporting the second as the first is a small
 * lie that makes the app look like it lost track of its own files; reporting it as a
 * FAILURE is worse, because the outcome she wanted is exactly what she already has.
 */
export type CapsuleDeleteOutcome = 'deleted' | 'already_absent';

/**
 * Deletes one capsule.
 *
 * Wired to a button plus `useConfirm()` on the backup screen, and deliberately NOT to a
 * swipe gesture anywhere. Removing a copy of a health record should take a deliberate
 * confirmation, not a thumb sliding past.
 *
 * THE UNLINK IS VERIFIED, NOT ASSUMED. The screen drops the row on the strength of this
 * return value, and there is no orphan sweep over `backups/` the way there is over the
 * prescription photo directories — so a list that quietly stops showing a file which is
 * still sitting on disk is a user who believes she deleted something she did not, and a
 * capsule that keeps occupying storage with nothing pointing at it. Throwing here is what
 * keeps the row on screen.
 *
 * `pending_file_delete` is deliberately NOT used. That queue exists to make an unlink
 * atomic with the removal of the ROW that owned the file; a capsule has no row. Compare
 * `prescription/capture.tsx`, which unlinks directly for the same reason.
 */
export function deleteCapsule(uri: string): CapsuleDeleteOutcome {
  const file = new File(uri);
  if (!file.exists) return 'already_absent';

  file.delete();

  // Re-stat through a fresh handle rather than trusting the one we just deleted through.
  if (new File(uri).exists) {
    throw new Error('the copy is still on this phone after deleting it');
  }
  return 'deleted';
}

// ── internals ────────────────────────────────────────────────────────────────

type WritableHandle = { writeBytes(bytes: Uint8Array): void };

function writeFrame(handle: WritableHandle, sealed: Uint8Array): void {
  handle.writeBytes(frameBytes(sealed));
}

/**
 * Do this file's first bytes spell `AAROGYA1`?
 *
 * Eight bytes off the front of each file, which is one page read — the whole backups
 * folder costs less than the `file.size` calls already in the map below.
 *
 * FALSE ON ANY FAILURE, deliberately. A file that cannot be opened or read is a file that
 * cannot be restored either, so counting it as a copy she has would be the same false
 * reassurance as counting a truncated one. `decodeHeader` throws exactly this comparison's
 * message ('Not an Aarogya capsule: wrong file signature'); this is the same check made
 * cheaply and without raising, because a listing must never fail over one bad entry.
 */
function startsWithCapsuleSignature(file: File): boolean {
  let handle: ReturnType<File['open']>;
  try {
    handle = file.open();
  } catch (error) {
    console.warn(`[backup] could not open "${file.name}" while listing the copies`, error);
    return false;
  }
  try {
    const head = handle.readBytes(MAGIC_BYTES.length);
    if (head.length < MAGIC_BYTES.length) return false;
    for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
      if (head[i] !== MAGIC_BYTES[i]) return false;
    }
    return true;
  } catch (error) {
    console.warn(`[backup] could not read "${file.name}" while listing the copies`, error);
    return false;
  } finally {
    handle.close();
  }
}

/** Streams a file through SHA-256 without ever holding more than one chunk. */
function hashFile(file: File): string {
  const hasher = sha256Stream();
  const handle = file.open();
  try {
    for (;;) {
      const chunk = handle.readBytes(CHUNK_BYTES);
      if (chunk.length === 0) break;
      hasher.update(chunk);
      if (chunk.length < CHUNK_BYTES) break;
    }
  } finally {
    handle.close();
  }
  return hasher.hex();
}

function appVersion(): string {
  const version = Constants.expoConfig?.version;
  return typeof version === 'string' && version.length > 0 ? version : 'unknown';
}

/** Hands the JS thread back so the spinner can paint. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
