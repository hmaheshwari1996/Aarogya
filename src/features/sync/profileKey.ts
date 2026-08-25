/**
 * The per-profile data key — custody, one key per shared profile.
 *
 * ═══ ONE KEY PER PROFILE, NOT ONE PER PHONE ═══════════════════════════════════════
 * The baseline `crypto.ts` holds a single share key per DEVICE (the public-link era). v2 keys
 * per PROFILE: mother's record and grandmother's record are two independent datasets that
 * happen to share a phone, and a manager of one must not hold the key to the other. So each
 * profile's key lives under its own `aarogya_profile_key_<shareId>` entry.
 *
 * The OWNER device mints the key and holds it from the start; a manager/viewer stores the
 * unwrapped key (via `setProfileKey`) the moment its `sync_key_wrap` is approved and opened.
 *
 * ═══ WHY {key, generation} ARE STORED TOGETHER, ATOMICALLY ════════════════════════
 * `generation` counts how many times the profile's key has ROTATED (a member was removed —
 * §4.3). Rotation must be all-or-nothing: a crash that left a phone holding the NEW key under
 * the OLD generation number would present as "the link works but nothing decrypts" — the least
 * debuggable failure this feature has. One JSON entry, one write, so the pair can never split.
 * This is exactly the reasoning `crypto.ts` states for its {key, linkId} pair.
 *
 * FAILS SOFT on read (null); only the explicit mint/rotate paths, whose caller is a user
 * action that can be told it failed, may throw.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { mintShareKey } from './link';
import { SHARE_KEY_BYTES, type RandomSource } from './sealed';

const STORE_PREFIX = 'aarogya_profile_key_';

/** Same accessibility as every other sync secret: readable while locked, for background pulls. */
const ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK;

export type ProfileKeyState = {
  readonly key: Uint8Array;
  /** How many times this profile's key has rotated. Carried on every published row. */
  readonly generation: number;
};

type Stored = { generation: number; key: string };

/**
 * SecureStore keys accept only [A-Za-z0-9._-]. A share id is base64url (`link.ts`), whose
 * alphabet is a subset of that, so the concatenation is always valid — but assert it rather
 * than trust it, so a future non-base64url id fails loudly here instead of at the keystore.
 */
function entryFor(shareId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(shareId)) {
    throw new Error('profileKey: share id is not a well-formed keystore-safe id');
  }
  return `${STORE_PREFIX}${shareId}`;
}

/** 32 random bytes. Owner-only, on first share. Reuses the share-key mint (`link.ts`). */
export function mintProfileKey(random: RandomSource): Uint8Array {
  return mintShareKey(random);
}

export async function getProfileKey(shareId: string): Promise<ProfileKeyState | null> {
  try {
    const raw = await SecureStore.getItemAsync(entryFor(shareId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const keyB64 = record['key'];
    const generation = record['generation'];
    if (typeof keyB64 !== 'string') return null;
    const key = base64ToBytes(keyB64);
    if (key.length !== SHARE_KEY_BYTES) return null;
    return { key, generation: typeof generation === 'number' ? generation : 1 };
  } catch (error) {
    console.warn('[sync] could not read a profile key', describe(error));
    return null;
  }
}

/**
 * Store a key at a known generation.
 *
 * Two callers: the owner on first mint (generation 1), and a member the instant it unwraps its
 * `sync_key_wrap` (whatever generation that wrap was at). The generation is passed in, never
 * inferred, so a member that receives a G+1 rewrap after a removal stores G+1 — a member must
 * never silently downgrade its own generation.
 */
export async function setProfileKey(shareId: string, key: Uint8Array, generation: number): Promise<void> {
  if (key.length !== SHARE_KEY_BYTES) {
    throw new Error(`setProfileKey: key must be ${SHARE_KEY_BYTES} bytes, got ${key.length}`);
  }
  const stored: Stored = { generation, key: bytesToBase64(key) };
  await SecureStore.setItemAsync(entryFor(shareId), JSON.stringify(stored), { keychainAccessible: ACCESSIBLE });
}

/**
 * Owner-only: mint a fresh key, bump the generation, in ONE store write.
 *
 * Does NOT touch the relay — that is `removeMember` in `membership.ts`, which knows the order
 * the re-wrap and the republish must happen in. Keeping the two apart means this cannot
 * half-rotate: the phone holds either the new pair or the old one.
 */
export async function rotateProfileKey(shareId: string): Promise<ProfileKeyState> {
  const previous = await getProfileKey(shareId);
  const key = mintProfileKey((count) => Crypto.getRandomBytes(count));
  const generation = (previous?.generation ?? 0) + 1;
  await setProfileKey(shareId, key, generation);
  return { key, generation };
}

export async function forgetProfileKey(shareId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(entryFor(shareId));
  } catch (error) {
    console.warn('[sync] could not clear a profile key', describe(error));
  }
}

// ── internals ──────────────────────────────────────────────────────────────────

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
