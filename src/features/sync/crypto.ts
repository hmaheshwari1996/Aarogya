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

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { mintLinkId, mintShareKey, toBase64Url } from './link';
import { recordAad, sealJson, SHARE_KEY_BYTES, type RandomSource } from './sealed';

const KEY_STORE_ENTRY = 'aarogya_sync_share_key';

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


function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
