/**
 * What actually goes on the wire: sealed, padded records and key wrapping.
 *
 * ─── THE SERVER ONLY EVER HOLDS CIPHERTEXT ────────────────────────────────────────
 * Supabase's free tier is a Postgres database run by somebody else. Row-level security
 * keeps other USERS out; it does not keep the operator out, and it does not survive a
 * subpoena, a breach or a misconfigured policy. So the plaintext never leaves the phone:
 * every record is sealed here with the family key before `client.ts` is allowed to see
 * it, and the server stores an opaque blob with an id, a lamport number and nothing else.
 *
 * ─── WHY PADDING IS NOT OPTIONAL ──────────────────────────────────────────────────
 * Ciphertext length is plaintext length plus a constant. Without padding, an observer who
 * only ever sees encrypted rows still learns: this row is a symptom note with 300
 * characters of free text; this one is a bare reading; this profile suddenly started
 * writing much longer notes in March. That is a diary of somebody's illness reconstructed
 * from lengths alone. Bucketing to powers of two collapses that to a handful of
 * distinguishable sizes, at a cost of a few hundred wasted bytes per row.
 *
 * ─── ONE KEY, HANDED OUT WHOLE ────────────────────────────────────────────────────
 * There is no per-device key wrap here any more, and no X25519. The old model sealed the
 * family key to each viewer device's public key so that one viewer could be removed
 * without disturbing the others; a publicly shareable link has no viewer list to remove
 * anybody from, so the key is simply the thing the link carries. What replaces per-viewer
 * revocation is rotation: a new key, a new dataset id, and the old rows deleted. See
 * `./link.ts` and `./share.ts`.
 *
 * PURE. Randomness and clocks are injected. `node --test` loads this file directly.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { bytesToUtf8, concatBytes, readU32, u32, utf8Bytes } from '../backup/bytes';

/** The size of the key that opens a shared record. */
export const SHARE_KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

/** A random source. Injected so the tests are deterministic and the app uses the CSPRNG. */
export type RandomSource = (count: number) => Uint8Array;

/**
 * Size buckets, in bytes of padded plaintext.
 *
 * Powers of two from 256 up. The smallest is 256 because nothing this app syncs is
 * usefully smaller and a 64-byte bucket would put "a blood pressure reading" in a
 * distinguishable class of its own. The largest is 128 KiB; anything past that is a
 * photograph, and photographs do not travel through this path.
 */
export const PAD_BUCKETS: readonly number[] = [
  256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536, 131_072,
];

export const MAX_RECORD_BYTES = 131_072 - 4;

/** The smallest bucket that fits. Throws rather than leak an unbucketed length. */
export function bucketFor(byteLength: number): number {
  for (const bucket of PAD_BUCKETS) {
    if (byteLength <= bucket) return bucket;
  }
  throw new Error(`A sync record of ${byteLength} bytes is past the largest padding bucket.`);
}

/**
 * 4-byte length prefix, then the payload, then zeros to the bucket.
 *
 * The prefix rather than a trailing delimiter because the payload is arbitrary bytes and
 * a delimiter would need escaping — and an escaping bug in the padding layer would
 * corrupt records in a way that only shows up on the reader's device, weeks later.
 */
export function pad(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > MAX_RECORD_BYTES) {
    throw new Error(`A sync record of ${plaintext.length} bytes is too large to pad.`);
  }
  const bucket = bucketFor(plaintext.length + 4);
  const out = new Uint8Array(bucket);
  out.set(u32(plaintext.length), 0);
  out.set(plaintext, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error('Padded record is shorter than its length prefix');
  const length = readU32(padded, 0);
  if (length > padded.length - 4) throw new Error('Padded record claims to be longer than it is');
  return padded.subarray(4, 4 + length);
}

// ── Record sealing ───────────────────────────────────────────────────────────

const AAD_RECORD = utf8Bytes('aarogya.sync.record.v1');

/**
 * Associated data for a record.
 *
 * The row id and the lamport number are bound in, so the server cannot move a sealed
 * payload onto a different row or replay an old version of a row under a newer lamport.
 * Both values are already in the clear on the server; putting them in the AAD costs
 * nothing and takes those two rearrangements off the table.
 */
export function recordAad(rowKey: string, lamport: number): Uint8Array {
  return concatBytes(AAD_RECORD, utf8Bytes(rowKey), u32(lamport));
}

const AAD_SNAPSHOT = utf8Bytes('aarogya.sync.snapshot.v1');

/**
 * Associated data for the shared snapshot.
 *
 * The link id is bound in, so a snapshot cannot be copied from one dataset to another — an
 * operator who moved the blob from link A to link B would produce something that simply
 * fails to open on the phone holding link B's key, rather than showing one family another
 * family's record.
 */
export function snapshotAad(linkId: string): Uint8Array {
  return concatBytes(AAD_SNAPSHOT, utf8Bytes(linkId));
}

/** nonce ‖ ciphertext ‖ tag, as one blob, because the server stores exactly one column. */
export function sealRecord(
  shareKey: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  random: RandomSource,
): Uint8Array {
  assertKey(shareKey, 'share key');
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error('The random source returned a short nonce.');
  const sealed = xchacha20poly1305(shareKey, nonce, aad).encrypt(pad(plaintext));
  return concatBytes(nonce, Uint8Array.from(sealed));
}

/** Null on any failure — a wrong key, a tampered blob and a truncated one are all "no". */
export function openRecord(
  shareKey: Uint8Array,
  blob: Uint8Array,
  aad: Uint8Array,
): Uint8Array | null {
  if (shareKey.length !== SHARE_KEY_BYTES) return null;
  if (blob.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    const nonce = blob.subarray(0, NONCE_BYTES);
    const body = blob.subarray(NONCE_BYTES);
    const padded = Uint8Array.from(xchacha20poly1305(shareKey, nonce, aad).decrypt(body));
    return Uint8Array.from(unpad(padded));
  } catch {
    return null;
  }
}

export function sealJson(
  shareKey: Uint8Array,
  value: unknown,
  aad: Uint8Array,
  random: RandomSource,
): Uint8Array {
  return sealRecord(shareKey, utf8Bytes(JSON.stringify(value)), aad, random);
}

export function openJson<T>(shareKey: Uint8Array, blob: Uint8Array, aad: Uint8Array): T | null {
  const plain = openRecord(shareKey, blob, aad);
  if (!plain) return null;
  try {
    return JSON.parse(bytesToUtf8(plain)) as T;
  } catch {
    return null;
  }
}

function assertKey(key: Uint8Array, what: string): void {
  if (key.length !== SHARE_KEY_BYTES) {
    throw new Error(`The ${what} must be ${SHARE_KEY_BYTES} bytes, got ${key.length}`);
  }
}
