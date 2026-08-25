/**
 * Anonymous X25519 sealed-box — wrap arbitrary bytes to a device's public key.
 *
 * ═══ WHAT THIS IS, AND WHY IT IS NOT INVENTED CRYPTO ══════════════════════════════
 * This is the libsodium `crypto_box_seal` construction rebuilt on `@noble/*`: an ephemeral
 * X25519 keypair per message, ECDH to the recipient's long-lived public key, an HKDF to a
 * symmetric wrap key, then the SAME XChaCha20-Poly1305 AEAD `sealed.ts` already uses. Every
 * primitive is audited and already (or newly, F1) a dependency. Nothing here is a home-grown
 * cipher; the construction below is transcribed from the contract (§2.3) verbatim and MUST
 * NOT be varied — a variation IS inventing crypto.
 *
 * Used twice, ONE primitive:
 *   • wrap the profile key to a member device's public key (`sync_key_wrap.wrap`);
 *   • seal a join request's device label to the owner's public key (`sync_join_request.label_wrap`).
 * The relay stores an opaque blob either way; only the holder of the recipient's PRIVATE key,
 * which never leaves that phone, can open it.
 *
 * ═══ ONE-WAY BY DESIGN ════════════════════════════════════════════════════════════
 * The sender needs only the recipient's PUBLIC key, so the owner can wrap to a device it has
 * never met, and the ephemeral secret is discarded after sealing — there is nothing to steal
 * from the sender afterwards, and the sender itself cannot re-open what it sealed. That is the
 * property that lets an invite carry the owner's public key in the clear (§4.2).
 *
 * PURE. Randomness is injected; no storage, no clock, no expo. `node --test` loads it directly
 * and `keywrap.test.ts` pins the round trip, the wrong-key null, the tamper null, and the
 * unwrapped-length assertion.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { concatBytes, utf8Bytes } from '../backup/bytes';
import { NONCE_BYTES, SHARE_KEY_BYTES, type RandomSource } from './sealed';

/** X25519 public and secret keys are both 32 bytes. */
export const PUBLIC_KEY_BYTES = 32;
export const SECRET_KEY_BYTES = 32;

/** The HKDF domain separator. Bumping the `.v1` is the only sanctioned way to change the KDF. */
const KDF_INFO = utf8Bytes('aarogya.sync.keywrap.v1');

/** ephPub(32) ‖ nonce(24) — the fixed header before the AEAD body. */
const HEADER_BYTES = PUBLIC_KEY_BYTES + NONCE_BYTES;

/**
 * The wrap key both sides derive: HKDF-SHA256 over the ECDH secret, domain-separated and bound
 * to BOTH public keys so a blob cannot be replayed against a different recipient.
 */
function wrapKey(sharedSecret: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const info = concatBytes(KDF_INFO, ephPub, recipientPub);
  return hkdf(sha256, sharedSecret, undefined, info, SHARE_KEY_BYTES);
}

/**
 * Seal `plaintext` so ONLY the holder of `recipientPub`'s private key can open it.
 *
 * Returns ephPub(32) ‖ nonce(24) ‖ ciphertext ‖ tag(16). The AEAD's associated data binds the
 * ephemeral public key and the recipient public key, so neither header field can be swapped
 * without the tag failing.
 */
export function sealAnon(recipientPub: Uint8Array, plaintext: Uint8Array, random: RandomSource): Uint8Array {
  if (recipientPub.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`sealAnon: recipient public key must be ${PUBLIC_KEY_BYTES} bytes, got ${recipientPub.length}`);
  }
  // The ephemeral secret comes from the INJECTED `random`, never `x25519.utils.randomSecretKey()`.
  // That noble helper calls `@noble/hashes` `randomBytes`, which throws "crypto.getRandomValues
  // must be defined" whenever `globalThis.crypto` is absent — which is exactly Hermes/RN 0.81 here
  // (no polyfill; the whole feature threads a RandomSource for this reason). A Montgomery x25519
  // secret IS just 32 uniform bytes returned verbatim — the curve clamps at decodeScalar — so this
  // is byte-for-byte the same key, sourced from expo-crypto instead of a global that would throw
  // and take the profile-key wrap (the entire invite/key-release flow) down on the real phone.
  const ephSecret = random(SECRET_KEY_BYTES);
  if (ephSecret.length !== SECRET_KEY_BYTES) throw new Error('sealAnon: the random source returned a short ephemeral secret.');
  const ephPub = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientPub);
  const wk = wrapKey(shared, ephPub, recipientPub);

  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new Error('sealAnon: the random source returned a short nonce.');

  const aad = concatBytes(ephPub, recipientPub);
  const body = xchacha20poly1305(wk, nonce, aad).encrypt(plaintext);
  return concatBytes(ephPub, nonce, Uint8Array.from(body));
}

/**
 * Open a sealed blob with the recipient's SECRET key. Null on ANY failure — a wrong key, a
 * tampered blob and a truncated one are all "no", never a throw, so a malformed row on the
 * relay degrades to "this wrap is not for me" rather than crashing a background pull.
 */
export function openAnon(recipientSecret: Uint8Array, blob: Uint8Array): Uint8Array | null {
  if (recipientSecret.length !== SECRET_KEY_BYTES) return null;
  if (blob.length < HEADER_BYTES) return null;
  try {
    const ephPub = blob.subarray(0, PUBLIC_KEY_BYTES);
    const nonce = blob.subarray(PUBLIC_KEY_BYTES, HEADER_BYTES);
    const body = blob.subarray(HEADER_BYTES);
    const recipientPub = x25519.getPublicKey(recipientSecret);
    const shared = x25519.getSharedSecret(recipientSecret, ephPub);
    const wk = wrapKey(shared, ephPub, recipientPub);
    const aad = concatBytes(ephPub, recipientPub);
    return Uint8Array.from(xchacha20poly1305(wk, nonce, aad).decrypt(body));
  } catch {
    return null;
  }
}

// ── The profile-key case: thin wrappers so callers read intent, not crypto ──────

/** Wrap the 32-byte profile key to a member device's public key. */
export function wrapProfileKey(profileKey: Uint8Array, recipientPub: Uint8Array, random: RandomSource): Uint8Array {
  if (profileKey.length !== SHARE_KEY_BYTES) {
    throw new Error(`wrapProfileKey: profile key must be ${SHARE_KEY_BYTES} bytes, got ${profileKey.length}`);
  }
  return sealAnon(recipientPub, profileKey, random);
}

/**
 * Unwrap a profile key with this device's secret key.
 *
 * Returns null on any failure, AND null if the opened bytes are not exactly a profile key —
 * a blob that decrypts to the wrong length is a wrap of something else (a mistake or an
 * attack), never a key, and must not be installed as one.
 */
export function unwrapProfileKey(blob: Uint8Array, recipientSecret: Uint8Array): Uint8Array | null {
  const opened = openAnon(recipientSecret, blob);
  if (!opened || opened.length !== SHARE_KEY_BYTES) return null;
  return opened;
}
