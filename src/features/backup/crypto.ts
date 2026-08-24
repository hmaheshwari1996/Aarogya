/**
 * The capsule's cryptography, and nothing else.
 *
 * ─── WHY PURE JS AND NOT A NATIVE MODULE ──────────────────────────────────────────
 * `react-native-quick-crypto` is the obvious reach, and it is the wrong one here: its own
 * maintainers document AES-256-GCM support as incomplete, and "incomplete AEAD" in the
 * one code path that decides whether a health record can ever be read again is not a
 * trade worth making for a few hundred milliseconds. `@noble/ciphers` is audited, pure,
 * has no native surface to get out of sync with a Gradle upgrade, and — because it is
 * ordinary JavaScript — the round trip below is exercised by `node --test` on every CI
 * run rather than only on a device somebody remembered to plug in.
 *
 * ─── THE THREE CHOICES ────────────────────────────────────────────────────────────
 *
 * XChaCha20-Poly1305, not AES-GCM. The 24-byte nonce is the point: a capsule is written
 * in hundreds of chunks under one key, and with a 96-bit nonce that is a birthday
 * argument you have to think about. With 192 bits a random nonce base plus a counter is
 * unarguable. ChaCha is also constant-time in pure JS, which AES is not.
 *
 * scrypt, not PBKDF2. The attacker holding a stolen capsule is running a GPU or an ASIC
 * against a passphrase a human chose; scrypt's memory-hardness is the only parameter that
 * costs them more than it costs the phone. N = 2^15, r = 8, p = 1 → 32 MiB and roughly a
 * second on a Go-class handset. Higher N is available in `KDF_PARAMS` and the header
 * records what was actually used, so a future build can raise it and still open today's
 * capsules.
 *
 * THE MANIFEST IS ASSOCIATED DATA, NOT JUST CONTENT. A capsule whose payload MACs pass
 * but whose header was swapped would restore the right bytes under the wrong description
 * — wrong schema version, wrong profile, wrong file inventory. Binding the header into
 * the manifest's AAD and the manifest into every chunk's AAD makes that undetectable
 * substitution detectable.
 *
 * PURE. No expo, no React Native, no clock. `node --test` loads this file directly.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, concatBytes, u32, u64, utf8Bytes } from './bytes';

/** Key-derivation parameters, recorded verbatim in the capsule header. */
export type KdfParams = {
  readonly name: 'scrypt';
  /** CPU/memory cost. Must be a power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: 32;
};

/**
 * 32 MiB and about a second on the target hardware.
 *
 * Do not lower this without changing `MIN_ACCEPTED_N` as well — a capsule is only as
 * strong as the weakest parameters this build is willing to accept on the way back in.
 */
export const KDF_PARAMS: KdfParams = { name: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 };

/**
 * The floor for a capsule being READ.
 *
 * A capsule's header states its own KDF cost, which means a forged header could state a
 * cost of 2 and invite an offline attack that finishes instantly. Refusing anything below
 * the floor closes that, at the price of being unable to open a capsule written by some
 * hypothetical past build with weaker parameters — of which there are none.
 */
export const MIN_ACCEPTED_N = 16384;

/** Ceiling, so a hostile header cannot ask the phone to allocate gigabytes. */
export const MAX_ACCEPTED_N = 1 << 20;

export const SALT_BYTES = 32;
/** 16 random + an 8-byte frame counter = the full 24-byte XChaCha nonce. */
export const NONCE_BASE_BYTES = 16;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

/**
 * Derives the capsule key from a passphrase.
 *
 * Async so scrypt's internal ticks can yield: on a Go-class phone the synchronous variant
 * freezes the UI thread for the whole second, which reads as a hang on the one screen
 * where the user is already nervous.
 */
export async function deriveCapsuleKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = KDF_PARAMS,
): Promise<Uint8Array> {
  assertKdfParams(params);
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Capsule salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  }
  // Normalised so a passphrase typed with a trailing space on one keyboard and without on
  // another still derives the same key. NFC because Devanagari and a composed Latin
  // accent both have more than one valid encoding, and the user cannot see which they
  // typed. `normalize` exists in Hermes.
  const normalised = passphrase.normalize('NFC').trim();
  if (normalised.length === 0) throw new Error('A capsule cannot be sealed with an empty passphrase.');

  const key = await scryptAsync(utf8Bytes(normalised), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
    // Yield roughly every 20 ms so the spinner keeps spinning.
    asyncTick: 20,
  });
  return Uint8Array.from(key);
}

export function assertKdfParams(params: KdfParams): void {
  if (params.name !== 'scrypt') throw new Error(`Unsupported KDF: ${String(params.name)}`);
  if (!Number.isInteger(params.N) || params.N < MIN_ACCEPTED_N || params.N > MAX_ACCEPTED_N) {
    throw new Error(`Refusing scrypt N=${params.N}: outside [${MIN_ACCEPTED_N}, ${MAX_ACCEPTED_N}]`);
  }
  if ((params.N & (params.N - 1)) !== 0) throw new Error(`scrypt N must be a power of two, got ${params.N}`);
  if (!Number.isInteger(params.r) || params.r < 1 || params.r > 32) throw new Error(`Bad scrypt r: ${params.r}`);
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 8) throw new Error(`Bad scrypt p: ${params.p}`);
  if (params.dkLen !== 32) throw new Error(`Capsule keys are 32 bytes, header asked for ${params.dkLen}`);
}

/**
 * Frame nonce = 16 random bytes ‖ big-endian frame index.
 *
 * Unique by construction for every frame under one key, and the key is unique per capsule
 * because the salt is random. No state, no counter to persist, nothing to get wrong on a
 * resumed export.
 */
export function frameNonce(nonceBase: Uint8Array, frameIndex: number): Uint8Array {
  if (nonceBase.length !== NONCE_BASE_BYTES) {
    throw new Error(`Nonce base must be ${NONCE_BASE_BYTES} bytes, got ${nonceBase.length}`);
  }
  return concatBytes(nonceBase, u64(frameIndex));
}

const AAD_MANIFEST = utf8Bytes('aarogya.capsule.manifest.v1');
const AAD_CHUNK = utf8Bytes('aarogya.capsule.chunk.v1');

/** AAD for frame 0. Binds the cleartext header — salt, KDF cost, chunk size — to the manifest. */
export function manifestAad(headerBytes: Uint8Array): Uint8Array {
  return concatBytes(AAD_MANIFEST, sha256(headerBytes));
}

/**
 * AAD for frames 1..N. Binds header AND manifest AND position.
 *
 * The frame index is in there so two chunks cannot be swapped: without it, a capsule's
 * chunks could be reordered and every individual MAC would still verify.
 */
export function chunkAad(
  headerBytes: Uint8Array,
  manifestBytes: Uint8Array,
  frameIndex: number,
): Uint8Array {
  return concatBytes(AAD_CHUNK, sha256(headerBytes), sha256(manifestBytes), u32(frameIndex));
}

export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error(`Nonce must be ${NONCE_BYTES} bytes`);
  return Uint8Array.from(xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

/**
 * Opens one frame. Returns null on any MAC failure rather than throwing.
 *
 * Null is the right shape because the CALLER knows what a failure means and this function
 * does not: a failed manifest frame means "wrong passphrase", a failed chunk means
 * "corrupt or truncated", and the restore screen must be able to say which. Throwing
 * would flatten the two into one unhelpful sentence.
 */
export function open(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Uint8Array | null {
  if (nonce.length !== NONCE_BYTES) return null;
  if (sealed.length < TAG_BYTES) return null;
  try {
    return Uint8Array.from(xchacha20poly1305(key, nonce, aad).decrypt(sealed));
  } catch {
    return null;
  }
}

/** Incremental SHA-256, so a 30 MB photo is hashed without ever being fully resident. */
export function sha256Stream(): { update(chunk: Uint8Array): void; hex(): string } {
  const hasher = sha256.create();
  return {
    update(chunk: Uint8Array) {
      hasher.update(chunk);
    },
    hex() {
      return bytesToHex(Uint8Array.from(hasher.digest()));
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(Uint8Array.from(sha256(bytes)));
}
