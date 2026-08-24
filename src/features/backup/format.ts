/**
 * The capsule file format. One file, self-describing, openable by nothing but the
 * passphrase.
 *
 * ─── LAYOUT ───────────────────────────────────────────────────────────────────────
 *
 *   "AAROGYA1"                8 bytes, magic
 *   headerLength              4 bytes, uint32 big-endian
 *   header                    headerLength bytes, canonical JSON, CLEARTEXT
 *   ┌ frame 0                 the manifest
 *   │   frameLength           4 bytes, uint32 big-endian
 *   │   sealed bytes          ciphertext ‖ 16-byte Poly1305 tag
 *   ├ frame 1 … frame N       the payload, in manifest entry order
 *   └ …
 *
 * The header is in the clear because it HAS to be: it carries the salt and the KDF cost,
 * which are exactly what you need in order to try a passphrase. It is authenticated as
 * associated data on frame 0, so it can be read but not altered.
 *
 * Everything else — the database, every photograph, the file inventory, even how many
 * files there are — is inside the sealed frames.
 *
 * ─── WHY FRAMES AND NOT ONE BLOB ──────────────────────────────────────────────────
 * A one-shot `encrypt(wholeCapsule)` needs the whole capsule in memory, twice, plus a
 * base64 copy to hand to the file API. On a 2 GB handset with a 200 MB record that is not
 * slow, it is an out-of-memory crash — and it crashes in the export path, so the user
 * learns their backup does not work at the exact moment they need one. Frames cap
 * residency at one chunk.
 *
 * PURE. No expo, no React Native. `node --test` loads this file directly.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { bytesToUtf8, canonicalJson, concatBytes, readU32, u32, utf8Bytes } from './bytes';
import { KDF_PARAMS, MAX_ACCEPTED_N, MIN_ACCEPTED_N, type KdfParams } from './crypto';

export const MAGIC = 'AAROGYA1';
export const MAGIC_BYTES = utf8Bytes(MAGIC);
export const FORMAT_VERSION = 1;

/** '.aarogya' rather than '.bin': a share sheet full of files should be readable. */
export const CAPSULE_EXTENSION = '.aarogya';

/**
 * 256 KiB of plaintext per frame.
 *
 * Small enough that peak residency stays under a megabyte even counting the ciphertext
 * copy; large enough that a 200 MB capsule is 800 frames rather than 200 000, and the
 * per-frame overhead (4-byte length + 16-byte tag) stays under 0.01%.
 */
export const CHUNK_BYTES = 256 * 1024;

/**
 * The practical ceiling on one capsule: 512 MiB of plaintext.
 *
 * Not a limit of the format — frames would happily carry more — but of the phone. Above
 * roughly this, writing takes long enough that Android may kill a backgrounded app
 * mid-export, and the resulting truncated file looks like a backup while being useless.
 * Exceeding it is reported, not silently truncated.
 */
export const MAX_CAPSULE_BYTES = 512 * 1024 * 1024;

/**
 * One media file above 48 MiB is skipped and recorded in the manifest as skipped.
 *
 * This is the honest trade. A 100 MB video somebody attached is not worth failing an
 * entire backup over, and it is not worth silently pretending to have saved either — so
 * it is listed by name in `skipped`, the export result carries a warning, and the restore
 * screen can say which files were not in the capsule.
 */
export const MAX_MEDIA_FILE_BYTES = 48 * 1024 * 1024;

export type CapsuleHeader = {
  readonly format: 'aarogya.capsule';
  readonly v: number;
  readonly kdf: KdfParams;
  /** base64, 32 bytes. Cleartext by necessity. */
  readonly salt: string;
  /** base64, 16 bytes. The frame counter is appended to make each 24-byte nonce. */
  readonly nonceBase: string;
  readonly chunkBytes: number;
  readonly createdAtEpoch: number;
};

export type CapsuleEntryKind = 'database' | 'media';

export type CapsuleEntry = {
  readonly kind: CapsuleEntryKind;
  /**
   * Path INSIDE the capsule, always relative and always '/'-separated.
   * 'db/aarogya.db' for the database; 'files/labs/<uuid>.jpg' for media.
   */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Frame index of this entry's first chunk. Frames are contiguous and in entry order. */
  readonly firstFrame: number;
  readonly frameCount: number;
};

export type SkippedFile = {
  readonly path: string;
  readonly bytes: number;
  readonly reason: 'too_large' | 'unreadable';
};

export type CapsuleManifest = {
  readonly format: 'aarogya.capsule.manifest';
  readonly v: number;
  readonly createdAtEpoch: number;
  readonly createdLocalDate: string;
  /** From `app.config.ts` — which build wrote this, for a human reading a support thread. */
  readonly appVersion: string;
  /** `PRAGMA user_version` at export time. Restore refuses anything above its own LATEST_VERSION. */
  readonly schemaUserVersion: number;
  readonly profileId: string;
  readonly profileName: string | null;
  /** Absolute document directory of the writing install. Restore rewrites URIs off this. */
  readonly documentRoot: string;
  readonly entries: readonly CapsuleEntry[];
  readonly skipped: readonly SkippedFile[];
  readonly totalPlaintextBytes: number;
};

// ── Header framing ───────────────────────────────────────────────────────────

export function encodeHeader(header: CapsuleHeader): { prefix: Uint8Array; headerBytes: Uint8Array } {
  const headerBytes = utf8Bytes(canonicalJson(header));
  return { prefix: concatBytes(MAGIC_BYTES, u32(headerBytes.length)), headerBytes };
}

/** One length-prefixed frame, ready to be written. The writer's only framing rule. */
export function frameBytes(sealed: Uint8Array): Uint8Array {
  return concatBytes(u32(sealed.length), sealed);
}

/**
 * Reads one frame out of a byte array.
 *
 * `restore.ts` reads frames off a file handle instead, because it must never hold a whole
 * capsule in memory. This variant exists so the format can be exercised end to end by a
 * test with no filesystem — and it is the same length rule, in one place, so the two
 * cannot drift.
 */
export function readFrameAt(
  bytes: Uint8Array,
  offset: number,
  chunkBytes: number = CHUNK_BYTES,
): { sealed: Uint8Array; next: number } {
  const length = readU32(bytes, offset);
  // 16 is the Poly1305 tag; anything shorter cannot be a sealed frame at all.
  if (length < 16 || length > chunkBytes + 16) {
    throw new Error(`Capsule frame length ${length} is impossible`);
  }
  const start = offset + 4;
  const end = start + length;
  if (end > bytes.length) throw new Error('Capsule is truncated inside a frame');
  return { sealed: bytes.subarray(start, end), next: end };
}

export type DecodedHeader = {
  readonly header: CapsuleHeader;
  /** The exact bytes that were hashed into the manifest's AAD. Never re-serialise these. */
  readonly headerBytes: Uint8Array;
  /** Byte offset of frame 0. */
  readonly bodyOffset: number;
};

export const HEADER_PREFIX_BYTES = MAGIC_BYTES.length + 4;

/**
 * Reads the cleartext header from the front of a capsule.
 *
 * Takes a byte window rather than the whole file so a caller can read the first few
 * kilobytes off disk and decide whether this file is a capsule at all before committing
 * to anything larger.
 */
export function decodeHeader(bytes: Uint8Array): DecodedHeader {
  if (bytes.length < HEADER_PREFIX_BYTES) throw new Error('Not an Aarogya capsule: file is too short');
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error('Not an Aarogya capsule: wrong file signature');
  }

  const headerLength = readU32(bytes, MAGIC_BYTES.length);
  // A header is a few hundred bytes. A four-megabyte "header" is a malformed or hostile
  // file, and allocating for it before any MAC has been checked is the wrong move.
  if (headerLength === 0 || headerLength > 64 * 1024) {
    throw new Error(`Not an Aarogya capsule: implausible header length ${headerLength}`);
  }
  const bodyOffset = HEADER_PREFIX_BYTES + headerLength;
  if (bytes.length < bodyOffset) throw new Error('Capsule is truncated inside its header');

  const headerBytes = bytes.subarray(HEADER_PREFIX_BYTES, bodyOffset);
  const header = parseHeader(bytesToUtf8(headerBytes));
  return { header, headerBytes: Uint8Array.from(headerBytes), bodyOffset };
}

export function parseHeader(json: string): CapsuleHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Capsule header is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Capsule header is not an object');
  const record = raw as Record<string, unknown>;

  if (record['format'] !== 'aarogya.capsule') throw new Error('Capsule header has the wrong format tag');

  const v = record['v'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error('Capsule header has no version');
  if (v > FORMAT_VERSION) {
    throw new Error(
      `This capsule uses format version ${v} and this app understands ${FORMAT_VERSION}. Update Aarogya first.`,
    );
  }

  const kdf = parseKdf(record['kdf']);
  const salt = requireString(record, 'salt');
  const nonceBase = requireString(record, 'nonceBase');
  const chunkBytes = record['chunkBytes'];
  if (typeof chunkBytes !== 'number' || !Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 8 * 1024 * 1024) {
    throw new Error(`Capsule header has an implausible chunk size: ${String(chunkBytes)}`);
  }
  const createdAtEpoch = record['createdAtEpoch'];
  if (typeof createdAtEpoch !== 'number' || !Number.isFinite(createdAtEpoch)) {
    throw new Error('Capsule header has no creation time');
  }

  return { format: 'aarogya.capsule', v, kdf, salt, nonceBase, chunkBytes, createdAtEpoch };
}

function parseKdf(value: unknown): KdfParams {
  if (typeof value !== 'object' || value === null) throw new Error('Capsule header has no KDF block');
  const record = value as Record<string, unknown>;
  if (record['name'] !== 'scrypt') throw new Error(`Unsupported KDF in capsule header: ${String(record['name'])}`);

  const N = record['N'];
  const r = record['r'];
  const p = record['p'];
  const dkLen = record['dkLen'];
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number' || typeof dkLen !== 'number') {
    throw new Error('Capsule header KDF block is incomplete');
  }
  // Repeated here as well as in assertKdfParams so a malformed header is rejected at
  // parse time, before anything allocates 32 MiB on its say-so.
  if (N < MIN_ACCEPTED_N || N > MAX_ACCEPTED_N) {
    throw new Error(`Refusing a capsule whose scrypt cost is ${N}`);
  }
  if (dkLen !== 32) throw new Error(`Refusing a capsule with a ${dkLen}-byte key`);
  return { name: 'scrypt', N, r, p, dkLen: 32 };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Capsule header is missing "${key}"`);
  }
  return value;
}

export function defaultHeader(
  saltB64: string,
  nonceBaseB64: string,
  createdAtEpoch: number,
  chunkBytes: number = CHUNK_BYTES,
): CapsuleHeader {
  return {
    format: 'aarogya.capsule',
    v: FORMAT_VERSION,
    kdf: KDF_PARAMS,
    salt: saltB64,
    nonceBase: nonceBaseB64,
    chunkBytes,
    createdAtEpoch,
  };
}

// ── Manifest ─────────────────────────────────────────────────────────────────

export function encodeManifest(manifest: CapsuleManifest): Uint8Array {
  return utf8Bytes(canonicalJson(manifest));
}

/**
 * Parses and STRUCTURALLY VALIDATES a manifest.
 *
 * The MAC has already proved these bytes were written by somebody who knew the
 * passphrase. It has proved nothing about whether they make sense — a manifest can be
 * authentic and still claim a frame range that runs off the end of the file, or a path
 * with '..' in it. Restore walks the frame table and writes files to disk from these
 * values, so every one of them is checked here rather than trusted there.
 */
export function parseManifest(bytes: Uint8Array): CapsuleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytesToUtf8(bytes));
  } catch {
    throw new Error('Capsule manifest is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Capsule manifest is not an object');
  const record = raw as Record<string, unknown>;

  if (record['format'] !== 'aarogya.capsule.manifest') throw new Error('Capsule manifest has the wrong format tag');
  const v = record['v'];
  if (typeof v !== 'number' || v < 1) throw new Error('Capsule manifest has no version');
  if (v > FORMAT_VERSION) throw new Error(`Capsule manifest is version ${v}; this app understands ${FORMAT_VERSION}`);

  const schemaUserVersion = record['schemaUserVersion'];
  if (typeof schemaUserVersion !== 'number' || !Number.isInteger(schemaUserVersion) || schemaUserVersion < 0) {
    throw new Error('Capsule manifest has no schema version');
  }

  const entriesRaw = record['entries'];
  if (!Array.isArray(entriesRaw)) throw new Error('Capsule manifest has no entry list');

  const entries: CapsuleEntry[] = [];
  let expectedFrame = 1;
  for (const item of entriesRaw) {
    const entry = parseEntry(item);
    if (entry.firstFrame !== expectedFrame) {
      throw new Error(
        `Capsule manifest frame table is not contiguous: expected frame ${expectedFrame} for "${entry.path}", got ${entry.firstFrame}`,
      );
    }
    expectedFrame += entry.frameCount;
    entries.push(entry);
  }

  const databases = entries.filter((entry) => entry.kind === 'database');
  if (databases.length !== 1) {
    throw new Error(`A capsule must contain exactly one database, this one lists ${databases.length}`);
  }

  return {
    format: 'aarogya.capsule.manifest',
    v,
    createdAtEpoch: numberOr(record['createdAtEpoch'], 0),
    createdLocalDate: stringOr(record['createdLocalDate'], ''),
    appVersion: stringOr(record['appVersion'], 'unknown'),
    schemaUserVersion,
    profileId: stringOr(record['profileId'], ''),
    profileName: typeof record['profileName'] === 'string' ? record['profileName'] : null,
    documentRoot: stringOr(record['documentRoot'], ''),
    entries,
    skipped: parseSkipped(record['skipped']),
    totalPlaintextBytes: numberOr(record['totalPlaintextBytes'], 0),
  };
}

function parseEntry(value: unknown): CapsuleEntry {
  if (typeof value !== 'object' || value === null) throw new Error('Capsule manifest has a malformed entry');
  const record = value as Record<string, unknown>;

  const kind = record['kind'];
  if (kind !== 'database' && kind !== 'media') throw new Error(`Unknown capsule entry kind: ${String(kind)}`);

  const path = record['path'];
  if (typeof path !== 'string' || path.length === 0) throw new Error('Capsule entry has no path');
  assertSafeRelativePath(path);

  const bytes = record['bytes'];
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error(`Capsule entry "${path}" has an implausible size`);
  }
  const sha256 = record['sha256'];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Capsule entry "${path}" has no usable checksum`);
  }
  const firstFrame = record['firstFrame'];
  const frameCount = record['frameCount'];
  if (
    typeof firstFrame !== 'number' ||
    !Number.isInteger(firstFrame) ||
    firstFrame < 1 ||
    typeof frameCount !== 'number' ||
    !Number.isInteger(frameCount) ||
    frameCount < 0
  ) {
    throw new Error(`Capsule entry "${path}" has a malformed frame range`);
  }

  return { kind, path, bytes, sha256, firstFrame, frameCount };
}

function parseSkipped(value: unknown): SkippedFile[] {
  if (!Array.isArray(value)) return [];
  const out: SkippedFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = record['path'];
    const reason = record['reason'];
    if (typeof path !== 'string') continue;
    out.push({
      path,
      bytes: numberOr(record['bytes'], 0),
      reason: reason === 'unreadable' ? 'unreadable' : 'too_large',
    });
  }
  return out;
}

/**
 * The path-traversal guard.
 *
 * Restore writes these paths under the document directory. A manifest entry of
 * '../../../databases/other.db' would write outside it, and the manifest is attacker-
 * controlled the moment a user is talked into restoring a capsule somebody sent them.
 * Absolute paths, '..' segments, backslashes and NUL are all refused.
 */
export function assertSafeRelativePath(path: string): string {
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new Error(`Unsafe capsule path (absolute): ${path}`);
  if (path.includes('\\')) throw new Error(`Unsafe capsule path (backslash): ${path}`);
  if (path.includes('\0')) throw new Error(`Unsafe capsule path (NUL): ${path}`);
  for (const segment of path.split('/')) {
    if (segment === '..') throw new Error(`Unsafe capsule path (parent segment): ${path}`);
  }
  return path;
}

export function isSafeRelativePath(path: string): boolean {
  try {
    assertSafeRelativePath(path);
    return true;
  } catch {
    return false;
  }
}

/** How many frames an entry of this many bytes occupies. Zero-byte files take zero frames. */
export function framesFor(byteLength: number, chunkBytes: number = CHUNK_BYTES): number {
  return Math.ceil(byteLength / chunkBytes);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Shared by the writer and the reader below, so the two cannot drift apart. */
const CAPSULE_NAME_PREFIX = 'aarogya-';

/**
 * 'aarogya-2026-08-09-1432.aarogya'.
 *
 * The date is in the NAME because the backup screen sorts by filename and shows it to the
 * user as the identity of the copy — "replace everything with the copy from 9 August" is
 * a question she can answer, and "replace everything with capsule 7f3a" is not.
 */
export function capsuleFileName(now: number): string {
  const at = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${CAPSULE_NAME_PREFIX}${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${CAPSULE_EXTENSION}`;
}

/** The wall clock a capsule's own filename records. */
export type CapsuleStamp = {
  /** 'YYYY-MM-DD', the same shape every clinical row in this app stores. */
  readonly localDate: string;
  /** 'HH:MM', 24-hour. */
  readonly localTime: string;
};

/**
 * The inverse of `capsuleFileName`, so a screen can identify a copy by its DATE rather
 * than by 'aarogya-2026-08-09-1432.aarogya'. A confirmation that says "delete the copy
 * from 9 August 2026, 14:32?" is a question she can answer; one quoting a filename asks
 * her to compare two nearly identical strings of digits, which is how the wrong file gets
 * deleted.
 *
 * WALL CLOCK, NOT AN EPOCH, on purpose. `capsuleFileName` wrote LOCAL getters, so the
 * digits in the name are what the clock on the wall said when the copy was made. Turning
 * them back into an epoch would re-interpret them in whatever zone the phone is in now,
 * and a user who has travelled since would be shown a time she never saw. Handing the
 * parts straight to the app's date formatter prints the digits the name carries, which is
 * the one reading that cannot drift — the same reason schedules store '08:00' and never
 * an absolute timestamp.
 *
 * Returns null rather than guessing for anything that is not one of our names: a capsule
 * copied back from a computer under a different name, or one the user renamed. The caller
 * falls back to the filename, which is still true.
 */
export function capsuleStampFromName(name: string): CapsuleStamp | null {
  if (!name.endsWith(CAPSULE_EXTENSION)) return null;
  const stem = name.slice(0, name.length - CAPSULE_EXTENSION.length);
  if (!stem.startsWith(CAPSULE_NAME_PREFIX)) return null;

  const digits = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(
    stem.slice(CAPSULE_NAME_PREFIX.length),
  );
  if (!digits) return null;
  const [, year, month, day, hour, minute] = digits;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }

  // Range-checked rather than trusted. The display formatter renders whatever it is
  // handed, and '2026-45-99' printed on a delete confirmation is worse than the filename
  // it replaced — it looks like the app has lost track of which file it is holding.
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;

  return { localDate: `${year}-${month}-${day}`, localTime: `${hour}:${minute}` };
}
