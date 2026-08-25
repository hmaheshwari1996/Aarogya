/**
 * The device's long-lived X25519 keypair — custody, not crypto.
 *
 * ═══ ONE KEYPAIR PER HANDSET, MINTED ON FIRST USE, NEVER LEAVES ═══════════════════
 * Family sharing wraps a profile key TO a device, which means every device needs a stable
 * public key others can wrap to. The private half is minted here, lives in `expo-secure-store`
 * (Android's hardware-backed keystore) under `aarogya_sync_device_key`, and leaves the phone
 * in exactly ZERO ways — not in a link, not in a join request, not in a log. Only the PUBLIC
 * half is ever published (the join request's `device_pubkey`, and it is safe: a public key
 * reveals nothing).
 *
 * The `device_id` this key pairs with is the existing `sync.deviceId` in `config.ts` — a minted
 * UUID, deliberately NOT a hardware id (a hardware id would be a stable cross-app tracker
 * attached to a health record). Keep that separation: this file holds the key, config holds
 * the id.
 *
 * ═══ WHY ONLY THE SECRET IS STORED ════════════════════════════════════════════════
 * The public key is a pure function of the secret (`x25519.getPublicKey`), so storing both
 * would be a second copy that could drift. The secret is the single source of truth; the
 * public half is derived on read.
 *
 * FAILS SOFT on read, like `crypto.ts`: a keystore that will not open presents as "no device
 * key yet" (null), which the callers handle, rather than a crash. Only `getOrCreate`, an
 * explicit user action, mints — and it is the one path that may throw if the store is broken,
 * because its caller (joining a share) can be told it failed.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { PUBLIC_KEY_BYTES, SECRET_KEY_BYTES } from './keywrap';
import { x25519 } from '@noble/curves/ed25519.js';

const STORE_ENTRY = 'aarogya_sync_device_key';

/**
 * Readable while the phone is locked — a member device pulls and approves from background
 * passes, and requiring an unlocked screen would stall those. Same reasoning as the share key.
 */
const ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK;

export type DeviceKeyPair = {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
};

/** The stored secret, or null when none has been minted or the store will not open. */
async function readSecret(): Promise<Uint8Array | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORE_ENTRY);
    if (!raw) return null;
    const secret = base64ToBytes(raw);
    return secret.length === SECRET_KEY_BYTES ? secret : null;
  } catch (error) {
    // The key is never in the message, and never logged in full.
    console.warn('[sync] could not read the device key', describe(error));
    return null;
  }
}

/**
 * Loads the keypair, minting it on first use.
 *
 * The mint-and-store is not wrapped in try/catch: this is called from an explicit user action
 * (accepting an invite), and a store that cannot hold a key must surface as a failed action,
 * not a silent half-join that can never be approved.
 */
export async function getOrCreateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const existing = await readSecret();
  if (existing) return { secretKey: existing, publicKey: x25519.getPublicKey(existing) };

  // The secret comes from expo-crypto, NEVER `x25519.utils.randomSecretKey()`. That noble helper
  // calls `@noble/hashes` `randomBytes`, which throws "crypto.getRandomValues must be defined"
  // whenever `globalThis.crypto` is absent — which is exactly Hermes/RN 0.81 here (no polyfill;
  // the whole feature sources randomness from expo-crypto for this reason — see keywrap.ts). A
  // Montgomery X25519 secret IS just 32 uniform bytes, clamped by the curve at decodeScalar, so
  // this is byte-for-byte an equivalent key — sourced from a generator that works on-device
  // instead of one that would throw and take the entire invite/join/key-release flow down.
  const secretKey = Crypto.getRandomBytes(SECRET_KEY_BYTES);
  await SecureStore.setItemAsync(STORE_ENTRY, bytesToBase64(secretKey), { keychainAccessible: ACCESSIBLE });
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The public half, base64, safe to publish. Mints on first use like `getOrCreate`. */
export async function getDevicePublicKeyB64(): Promise<string> {
  const pair = await getOrCreateDeviceKeyPair();
  return bytesToBase64(pair.publicKey);
}

/** Parse a published base64 public key, or null if it is not a well-formed X25519 point size. */
export function parsePublicKeyB64(value: string): Uint8Array | null {
  try {
    const bytes = base64ToBytes(value);
    return bytes.length === PUBLIC_KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** Wipes the keypair. Sign-out / "forget this device". */
export async function forgetDeviceKeyPair(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORE_ENTRY);
  } catch (error) {
    console.warn('[sync] could not clear the device key', describe(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
