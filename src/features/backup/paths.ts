/**
 * Which files belong in a capsule, and where they live on the way back.
 *
 * ─── WHY THE MEDIA TREE IS DISCOVERED AND NOT LISTED ──────────────────────────────
 * The obvious implementation reads `prescription.image_uri`, `medicine.strip_photo_uri`,
 * `symptom_event.photo_uri`, `lab_result.report_uri` and `document.file_uri` out of the
 * database and copies exactly those. It is also the implementation that quietly stops
 * being complete the first time somebody adds a sixth image column — and the failure is
 * invisible until a restore, months later, on a phone that no longer has the originals.
 *
 * So the capsule takes the DIRECTORY TREE instead: everything under the document
 * directory except the four things that are explicitly not user data. A new feature that
 * writes photographs somewhere new is backed up on the day it ships, by nobody having to
 * remember anything.
 *
 * ─── WHY MEDIA AT ALL ─────────────────────────────────────────────────────────────
 * A database-only backup restores a schema full of `*_uri` strings pointing at files that
 * no longer exist. That is not a partial restore, it is a specific and severe one: the
 * prescription photograph is the ONLY evidence of what the doctor actually wrote, and the
 * strip photograph is what powers "the white round one" on the Medicines tab, which is
 * how a user who cannot read the pack identifies her own tablets.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import { assertSafeRelativePath, MAX_MEDIA_FILE_BYTES, type SkippedFile } from './format';

/** Path inside the capsule for the database. */
export const DB_CAPSULE_PATH = 'db/aarogya.db';
/** Every media entry is stored under this prefix, mirroring the document tree beneath it. */
export const MEDIA_PREFIX = 'files/';

/** Where a capsule is written, and where the backup screen lists them from. */
export const BACKUP_DIR_NAME = 'backups';
/** Scratch space for the export's `VACUUM INTO` target and for restore staging. */
export const WORK_DIR_NAME = 'aarogya-capsule-work';

/**
 * Document-directory children that are never user data.
 *
 * `backups` — capsules. Nesting a capsule inside a capsule doubles the file every time.
 * `dbsnapshots` — pre-migration copies, derived from a database that is itself in here.
 * `SQLite` — the live database and its WAL. Handled by `VACUUM INTO`, never byte-copied.
 * the work dir — half-written temporaries by definition.
 */
export const EXCLUDED_TOP_LEVEL = [BACKUP_DIR_NAME, 'dbsnapshots', WORK_DIR_NAME] as const;

/** A path with no scheme prefix — what SQLite and `VACUUM INTO` want. */
export function toFsPath(uriOrPath: string): string {
  return uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
}

export function documentRootPath(): string {
  return stripTrailingSlash(toFsPath(Paths.document.uri));
}

/**
 * The directory expo-sqlite actually keeps databases in.
 *
 * `defaultDatabaseDirectory` is typed `any` by the package, so it is narrowed here rather
 * than at four call sites. On Android it is `<filesDir>/SQLite`, which sits INSIDE the
 * document directory — which is exactly why the walker has to know about it.
 */
export function sqliteDirectoryPath(): string {
  const raw: unknown = SQLite.defaultDatabaseDirectory;
  if (typeof raw === 'string' && raw.length > 0) return stripTrailingSlash(toFsPath(raw));
  return `${documentRootPath()}/SQLite`;
}

/** Name of the SQLite directory relative to the document root, when it is inside it. */
function sqliteDirName(): string | null {
  const root = documentRootPath();
  const sqliteDir = sqliteDirectoryPath();
  if (!sqliteDir.startsWith(`${root}/`)) return null;
  const relative = sqliteDir.slice(root.length + 1);
  const firstSegment = relative.split('/')[0];
  return firstSegment && firstSegment.length > 0 ? firstSegment : null;
}

export function excludedTopLevelNames(): readonly string[] {
  const sqlite = sqliteDirName();
  return sqlite ? [...EXCLUDED_TOP_LEVEL, sqlite] : EXCLUDED_TOP_LEVEL;
}

export type MediaCandidate = {
  /** Absolute `file://` URI on this device. */
  readonly uri: string;
  /** Path inside the capsule, always beginning 'files/'. */
  readonly capsulePath: string;
  readonly bytes: number;
};

export type MediaScan = {
  readonly files: readonly MediaCandidate[];
  readonly skipped: readonly SkippedFile[];
  readonly totalBytes: number;
};

/**
 * Walks the document tree and returns everything a capsule should carry.
 *
 * Depth-limited and count-limited on purpose. A symlink loop or a runaway cache
 * directory must not turn a backup into an infinite walk on a phone with 4% battery, and
 * the bounds are generous enough that no plausible record reaches them.
 */
export function scanMediaFiles(options?: {
  readonly maxFileBytes?: number;
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}): MediaScan {
  const maxFileBytes = options?.maxFileBytes ?? MAX_MEDIA_FILE_BYTES;
  const maxDepth = options?.maxDepth ?? 8;
  const maxFiles = options?.maxFiles ?? 20_000;

  const excluded = new Set(excludedTopLevelNames());
  const files: MediaCandidate[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  const walk = (directory: Directory, prefix: string, depth: number): void => {
    if (depth > maxDepth || files.length >= maxFiles) return;

    let contents: (Directory | File)[];
    try {
      contents = directory.list();
    } catch (error) {
      console.warn(`[backup] could not list "${prefix || '.'}"`, error);
      skipped.push({ path: `${MEDIA_PREFIX}${prefix}`, bytes: 0, reason: 'unreadable' });
      return;
    }

    for (const entry of contents) {
      if (files.length >= maxFiles) return;

      if (entry instanceof Directory) {
        const name = entry.name;
        if (depth === 0 && excluded.has(name)) continue;
        walk(entry, `${prefix}${name}/`, depth + 1);
        continue;
      }

      const relative = `${prefix}${entry.name}`;
      const capsulePath = `${MEDIA_PREFIX}${relative}`;
      if (!isSafeCapsulePath(capsulePath)) {
        skipped.push({ path: capsulePath, bytes: 0, reason: 'unreadable' });
        continue;
      }

      let size = 0;
      try {
        size = entry.size;
      } catch (error) {
        console.warn(`[backup] could not stat "${relative}"`, error);
        skipped.push({ path: capsulePath, bytes: 0, reason: 'unreadable' });
        continue;
      }

      if (size > maxFileBytes) {
        // Named, not silently dropped. The export result carries this list and the UI is
        // expected to say which files did not fit.
        skipped.push({ path: capsulePath, bytes: size, reason: 'too_large' });
        continue;
      }

      files.push({ uri: entry.uri, capsulePath, bytes: size });
      totalBytes += size;
    }
  };

  try {
    walk(new Directory(Paths.document), '', 0);
  } catch (error) {
    console.warn('[backup] could not walk the document directory', error);
  }

  // Sorted so two exports of an unchanged record produce byte-identical manifests, which
  // makes "did anything change" answerable by comparing checksums.
  const sorted = [...files].sort((a, b) => a.capsulePath.localeCompare(b.capsulePath));
  return { files: sorted, skipped, totalBytes };
}

function isSafeCapsulePath(path: string): boolean {
  try {
    assertSafeRelativePath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns a capsule path back into an absolute URI on THIS device.
 *
 * The only place restore is allowed to build a destination path, so the traversal guard
 * has exactly one site to live at.
 */
export function capsulePathToDeviceUri(capsulePath: string): string {
  assertSafeRelativePath(capsulePath);
  if (!capsulePath.startsWith(MEDIA_PREFIX)) {
    throw new Error(`Not a media path: ${capsulePath}`);
  }
  const relative = capsulePath.slice(MEDIA_PREFIX.length);
  return `${Paths.document.uri.replace(/\/+$/, '')}/${relative}`;
}

export function backupDirectory(): Directory {
  const dir = new Directory(Paths.document, BACKUP_DIR_NAME);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Scratch space, in the CACHE directory.
 *
 * An unencrypted `VACUUM INTO` of the whole health record briefly exists here, and the
 * cache directory is both excluded from Android backup by this app's config and
 * reclaimable by the OS. Anything left behind by a crash is therefore transient rather
 * than a permanent plaintext copy sitting in app storage.
 */
export function workDirectory(): Directory {
  const dir = new Directory(Paths.cache, WORK_DIR_NAME);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Best-effort cleanup. A leftover temporary is not worth failing an operation over. */
export function clearWorkDirectory(): void {
  try {
    const dir = new Directory(Paths.cache, WORK_DIR_NAME);
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn('[backup] could not clear the capsule work directory', error);
  }
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}
