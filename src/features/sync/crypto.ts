/**
 * Key custody: the one key that opens the shared record, and where it lives.
 *
 * ─── ONE KEY, ONE LINK, BOTH REPLACED TOGETHER ────────────────────────────────────
 * There is one symmetric key per profile, generated ON THE PATIENT'S HANDSET, in
 * `expo-secure-store`, which on Android is the hardware-backed keystore. It is never
 * uploaded, never derived from anything the server knows, and it leaves the phone in
 * exactly one way: inside the fragment of a link the patient chooses to send. See
 * `./link.ts` for why the fragment is the only place it can safely ride.
 *
 * The key is stored alongside the `linkId` it belongs to, in a single keystore entry, and
 * `rotate()` replaces BOTH at once. Storing them together is what makes that atomic: a
 * crash can never leave a phone holding a new key that points at the old dataset, which
 * would present as "the link works but nothing decrypts" — the least debuggable failure
 * this feature could have.
 *
 * ─── WHY THERE IS NO KEYRING ANY MORE ─────────────────────────────────────────────
 * The old model wrapped the family key to each viewer device's X25519 public key, so
 * removing one viewer meant rotating the key and re-wrapping for everybody else — and a
 * device that kept only the newest key would lose its history, so devices kept eight
 * generations. None of that survives a public link. Rotation now re-encrypts the whole
 * dataset under the new key and deletes the old rows (`./share.ts`), so there is exactly
 * one key that can open exactly one dataset, and a second generation would only ever be
 * something old enough to be unable to open anything.
 *
 * `generation` survives as a counter — how many times this profile has rotated — because
 * it is carried on every row and is the cheapest way to tell, from a server dump, that a
 * rotation happened. It is not a key selector.
 *
 * ─── EVERYTHING HERE FAILS SOFT ───────────────────────────────────────────────────
 * A keystore that will not open must present as "sharing is not set up", which the whole
 * feature already handles, rather than as a crash. Reads return null; only the explicit
 * ensure/rotate paths, where the caller is a user action that can be told it failed, throw.
 *
 * The primitives are in `./sealed.ts`, which is pure and tested. This file is custody and
 * nothing else.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { x25519 } from '@noble/curves/ed25519.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { mintLinkId, mintShareKey, toBase64Url } from './link';
import { recordAad, sealJson, SHARE_KEY_BYTES, type RandomSource } from './sealed';

const KEY_STORE_ENTRY = 'aarogya_sync_share_key';

/** THIS handset's long-lived X25519 keypair. Its secret half opens every wrap aimed at us. */
const DEVICE_KEY_STORE_ENTRY = 'aarogya_sync_device_key';

/** Prefix for a per-profile symmetric key, suffixed with the profile's opaque share id. */
const PROFILE_KEY_STORE_PREFIX = 'aarogya_profile_key_';

/**
 * The key must be readable while the phone is locked.
 *
 * The outbox drains from a background pass and the quiet-day check runs on a timer;
 * requiring an unlocked screen would mean the shared view only ever updates while somebody
 * is looking at the app, which defeats the point of a family member seeing anything before
 * she picks up the phone.
 */
const ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK;

export type ShareKeyState = {
  readonly key: Uint8Array;
  /** The opaque id naming this dataset on the server. Replaced on every rotation. */
  readonly linkId: string;
  /** How many times this profile has rotated. Carried on rows; not a key selector. */
  readonly generation: number;
};

type StoredKey = {
  linkId: string;
  generation: number;
  /** base64 (NOT base64url — this never goes near a URL). */
  key: string;
};

const random: RandomSource = (count) => Crypto.getRandomBytes(count);

async function read(): Promise<StoredKey | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY_STORE_ENTRY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;

    const linkId = record['linkId'];
    const key = record['key'];
    const generation = record['generation'];
    if (typeof linkId !== 'string' || typeof key !== 'string') return null;
    return { linkId, key, generation: typeof generation === 'number' ? generation : 1 };
  } catch (error) {
    // The key itself is never in the message, and never in a log line anywhere.
    console.warn('[sync] could not read the share key', describe(error));
    return null;
  }
}

async function write(state: StoredKey): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORE_ENTRY, JSON.stringify(state), {
    keychainAccessible: ACCESSIBLE,
  });
}

export async function getShareKey(): Promise<ShareKeyState | null> {
  const stored = await read();
  if (!stored) return null;
  try {
    const key = base64ToBytes(stored.key);
    if (key.length !== SHARE_KEY_BYTES) return null;
    return { key, linkId: stored.linkId, generation: stored.generation };
  } catch {
    return null;
  }
}

/** Generates the key and the link id on first use. Only the patient's device calls this. */
export async function ensureShareKey(): Promise<ShareKeyState> {
  const existing = await getShareKey();
  if (existing) return existing;

  const key = mintShareKey(random);
  const linkId = mintLinkId(random);
  await write({ linkId, generation: 1, key: bytesToBase64(key) });
  return { key, linkId, generation: 1 };
}

/**
 * A brand new key AND a brand new link id, in one write.
 *
 * Does NOT touch the server — that is `rotateShareLink()` in `./share.ts`, which knows the
 * order the republish and the delete have to happen in. Keeping the two apart means this
 * function cannot half-rotate: either the phone holds the new pair or it holds the old one.
 */
export async function rotateShareKey(): Promise<ShareKeyState> {
  const previous = await read();
  const key = mintShareKey(random);
  const linkId = mintLinkId(random);
  const generation = (previous?.generation ?? 0) + 1;
  await write({ linkId, generation, key: bytesToBase64(key) });
  return { key, linkId, generation };
}

/** Forgets everything. Used when sharing is turned off, and on sign-out. */
export async function forgetShareKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_STORE_ENTRY);
  } catch (error) {
    console.warn('[sync] could not clear the share key', describe(error));
  }
}

/**
 * The key as it appears in a link's fragment.
 *
 * NEVER log the return value, never put it in a query string, and never send it in a
 * request body. It is handed to the share sheet and to the clipboard and nowhere else.
 */
export function shareKeyToFragmentValue(key: Uint8Array): string {
  return toBase64Url(key);
}

// ── Payloads ─────────────────────────────────────────────────────────────────

export type SealedPayload = { readonly payload: string; readonly generation: number };

/**
 * Seals one record for upload. Returns base64 — the server column is text.
 *
 * `rowKey` and `lamport` are bound in as associated data, so the server cannot move a
 * payload onto another row or replay an older version under a newer number. Null when this
 * device has no share key, which is the normal state on a phone that never turned sharing
 * on.
 */
export async function sealRecordPayload(
  rowKey: string,
  lamport: number,
  value: unknown,
): Promise<SealedPayload | null> {
  const state = await getShareKey();
  if (!state) return null;
  return {
    payload: bytesToBase64(sealJson(state.key, value, recordAad(rowKey, lamport), random)),
    generation: state.generation,
  };
}


// ── The device keypair ─────────────────────────────────────────────────────────
//
// Long-lived, per HANDSET (not per profile). Minted on first use and never replaced:
// rotating it would strand every wrap already aimed at this device. The SECRET HALF NEVER
// LEAVES — not in a link, not in a join request, not in a log. Only the public half is
// published (into a join request, and into the `member:` roster rows). The `device_id` that
// pairs with this key is the minted-UUID `sync.deviceId` in `./config.ts`; this is its key.
//
// Only the secret is stored; the public half is DERIVED on load. One source of truth means
// the two can never drift into a published pubkey that the stored secret cannot answer for —
// the same reasoning the share key uses for storing its {key, linkId} pair together.

export type DeviceKeyPair = {
  /** The public half, safe to publish. */
  readonly publicKey: Uint8Array;
  /** The private half. NEVER leaves this module and the keystore. */
  readonly secretKey: Uint8Array;
};

async function readDeviceSecret(): Promise<Uint8Array | null> {
  try {
    const raw = await SecureStore.getItemAsync(DEVICE_KEY_STORE_ENTRY);
    if (!raw) return null;
    const secret = base64ToBytes(raw);
    // A wrong length means a corrupted entry; treat it as absent so the caller re-mints,
    // rather than feeding a short scalar into X25519 where it would throw far from here.
    return secret.length === SHARE_KEY_BYTES ? secret : null;
  } catch (error) {
    // The secret is never in the message, and never in a log line anywhere.
    console.warn('[sync] could not read the device key', describe(error));
    return null;
  }
}

/**
 * Loads the device keypair, minting it on first use.
 *
 * An X25519 secret is just 32 CSPRNG bytes, drawn from `expo-crypto` (`random` above) — the
 * one random source this app trusts on Hermes, where a global `crypto` cannot be assumed
 * (`backup/bytes.ts` header). After a mint it reads the value back and uses whatever the store
 * now holds, so two callers racing on first use converge on ONE key rather than one of them
 * publishing a pubkey whose secret was overwritten under it.
 */
export async function getOrCreateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const existing = await readDeviceSecret();
  if (existing) return { secretKey: existing, publicKey: x25519.getPublicKey(existing) };

  const minted = random(SHARE_KEY_BYTES);
  await SecureStore.setItemAsync(DEVICE_KEY_STORE_ENTRY, bytesToBase64(minted), {
    keychainAccessible: ACCESSIBLE,
  });
  // Read back: if another call minted first, its value won the write, and we adopt it.
  const secretKey = (await readDeviceSecret()) ?? minted;
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** The public half as base64, safe to put in a join request or a `member:` row. */
export async function getDevicePublicKeyB64(): Promise<string> {
  const pair = await getOrCreateDeviceKeyPair();
  return bytesToBase64(pair.publicKey);
}

/** Wipes the keypair. Sign-out, or "forget this device". Fails soft. */
export async function forgetDeviceKeyPair(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(DEVICE_KEY_STORE_ENTRY);
  } catch (error) {
    console.warn('[sync] could not clear the device key', describe(error));
  }
}

// ── Per-profile keys ─────────────────────────────────────────────────────────
//
// One symmetric key per shared PROFILE (mother, grandmother), plus a `generation` counter —
// how many times that profile's key has rotated. Held only by devices granted it: the owner
// always (it mints it), managers and viewers after their join request is approved and the
// key is unwrapped from `sync_key_wrap`. This is the per-profile generalisation of the single
// global share key above; both live in the same keystore under distinct entries.
//
// `{key, generation}` are stored TOGETHER in one write for the same reason the share key
// stores its pair together: a crash must never leave a phone holding a new key stamped with
// the old generation, which presents as "the stream is there but nothing decrypts" — the
// least debuggable failure this feature has.

export type ProfileKeyState = {
  readonly key: Uint8Array;
  /** How many times this profile has rotated. Carried on every `sync_row`; selects nothing. */
  readonly generation: number;
};

type StoredProfileKey = { key: string; generation: number };

function profileEntry(shareId: string): string {
  return `${PROFILE_KEY_STORE_PREFIX}${shareId}`;
}

/**
 * 32 random bytes for a brand-new profile. Owner-only.
 *
 * It IS `mintShareKey` — a profile key and the old global share key are the same 256-bit
 * secret with the same length guard — re-exported under the name the callers reason in, so
 * there is one minting path and not two that could drift on key length.
 */
export const mintProfileKey: (random: RandomSource) => Uint8Array = mintShareKey;

async function readProfile(shareId: string): Promise<StoredProfileKey | null> {
  try {
    const raw = await SecureStore.getItemAsync(profileEntry(shareId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const key = record['key'];
    const generation = record['generation'];
    if (typeof key !== 'string') return null;
    return { key, generation: typeof generation === 'number' ? generation : 1 };
  } catch (error) {
    console.warn('[sync] could not read a profile key', describe(error));
    return null;
  }
}

async function writeProfile(shareId: string, state: StoredProfileKey): Promise<void> {
  await SecureStore.setItemAsync(profileEntry(shareId), JSON.stringify(state), {
    keychainAccessible: ACCESSIBLE,
  });
}

export async function getProfileKey(shareId: string): Promise<ProfileKeyState | null> {
  const stored = await readProfile(shareId);
  if (!stored) return null;
  try {
    const key = base64ToBytes(stored.key);
    if (key.length !== SHARE_KEY_BYTES) return null;
    return { key, generation: stored.generation };
  } catch {
    return null;
  }
}

/**
 * Stores a profile key at a given generation. The owner calls it once with the freshly-minted
 * key; a member calls it on accept with the key it just UNWRAPPED and the generation the wrap
 * was stamped with. Throws on a wrong-length key: it is reached from a user action (turning on
 * sharing, accepting an invite) that can be told it failed, and a bad key must not be stored.
 */
export async function setProfileKey(shareId: string, key: Uint8Array, generation: number): Promise<void> {
  if (key.length !== SHARE_KEY_BYTES) {
    throw new Error(`A profile key must be ${SHARE_KEY_BYTES} bytes, got ${key.length}`);
  }
  await writeProfile(shareId, { key: bytesToBase64(key), generation });
}

/**
 * A brand-new key at generation+1, in one write. Owner-only.
 *
 * Does NOT touch the server — that is the membership layer's `removeMember`/republish, which
 * knows the order the re-wrap and the re-encrypt have to happen in (contract §4.3). Keeping
 * the two apart means this cannot half-rotate: either the phone holds the new pair or the old
 * one. Mirrors `rotateShareKey` exactly, per profile.
 */
export async function rotateProfileKey(shareId: string): Promise<ProfileKeyState> {
  const previous = await readProfile(shareId);
  const key = mintShareKey(random);
  const generation = (previous?.generation ?? 0) + 1;
  await writeProfile(shareId, { key: bytesToBase64(key), generation });
  return { key, generation };
}

/** Forgets one profile's key. Leaving a share, or being removed from it. Fails soft. */
export async function forgetProfileKey(shareId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(profileEntry(shareId));
  } catch (error) {
    console.warn('[sync] could not clear a profile key', describe(error));
  }
}

// ── The last-write-wins clock ──────────────────────────────────────────────────
//
// LOCKED chose LWW by MILLISECOND modified-time, not a lamport counter, so every `sync_row`
// carries `modified_at_ms` = the writing device's edit time (already stamped as
// `updated_at_epoch` by the repository layer — this helper is for the few sites that stamp
// fresh). Defined once, here, so there is exactly one clock the merge reasons about.
//
// It TRUSTS the device clock (contract flag F2): a phone whose clock is badly wrong can win
// or lose a merge it should not, and an exact-millisecond tie is broken downstream on
// `device_id` (lexically higher wins) so every device still converges. That trade is the
// price of the LOCKED decision — do NOT "fix" it by reaching for a lamport here.
//
// NOTE (build coordination): this sits in `crypto.ts` because that is a file this agent owns
// and the ms stamp is a sibling wire-concern to the profile-key generation above. It is a
// bare `Date.now()` with no keystore dependency, so a pure consumer that cannot import this
// module (it pulls in SecureStore) can safely call `Date.now()` directly — they are the same
// clock. If the sync-protocol layer prefers it in a pure module, it is a trivial one-line move.
export const nowMs = (): number => Date.now();

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
