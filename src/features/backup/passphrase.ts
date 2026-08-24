/**
 * Where the recovery phrase is kept, and why it is a phrase at all.
 *
 * ─── THE PROBLEM THIS SOLVES, AND THE ONE IT DOES NOT ─────────────────────────────
 * A capsule is only useful if it can be opened on a phone that is not this phone. That
 * rules out the obvious convenience — sealing it with a key held in this device's
 * keystore — because a key that dies with the handset makes the backup die with it too,
 * which is precisely the failure the capsule exists to survive.
 *
 * So the capsule is sealed with a PASSPHRASE. The backup screen calls
 * `exportCapsule(profileId)` without one, because asking a 62-year-old to invent and
 * remember a passphrase on the spot is how you get "1234" or an abandoned backup. Instead
 * the app generates a recovery phrase once, keeps a copy in the keystore for convenience,
 * and RETURNS IT in the export result so the UI can put it in front of the user with the
 * only instruction that matters: write this down somewhere that is not this phone.
 *
 * The keystore copy is a convenience, never the plan. If the phone is gone, so is it.
 * `docs/SYNC-AND-BACKUP.md` says this in the same words, and the UI must too.
 *
 * A user-chosen passphrase is fully supported — pass one to `exportCapsule` and it is
 * used verbatim, and nothing is stored.
 *
 * The alphabet and the normalisation rules live in `./phrase.ts`, which is pure and
 * therefore actually tested.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { buildRecoveryPhrase } from './phrase';

/** SecureStore keys may contain only alphanumerics, '.', '-' and '_'. */
const STORE_KEY = 'aarogya_capsule_recovery_phrase';

export {
  formatPhrase,
  isWellFormedPhrase,
  normalisePhrase,
  GROUP_COUNT,
  GROUP_SIZE,
  PHRASE_ALPHABET,
  PHRASE_LENGTH,
} from './phrase';

export function generateRecoveryPhrase(
  randomBytes: (count: number) => Uint8Array = (count) => Crypto.getRandomBytes(count),
): string {
  return buildRecoveryPhrase(randomBytes);
}

/**
 * Reads the stored phrase, or null.
 *
 * Never throws. A keystore that will not open (a device mid-upgrade, a profile the OS is
 * refusing to decrypt for) must present as "no phrase yet" — which the caller handles —
 * rather than as a crash on the backup screen.
 */
export async function getStoredRecoveryPhrase(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(STORE_KEY);
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    console.warn('[backup] could not read the stored recovery phrase', describe(error));
    return null;
  }
}

/**
 * Returns the phrase, generating and storing one on first use.
 *
 * `created` tells the caller whether this is the first time — which is when the UI must
 * insist the user writes it down, rather than mentioning it in passing.
 */
export async function ensureRecoveryPhrase(): Promise<{ phrase: string; created: boolean }> {
  const existing = await getStoredRecoveryPhrase();
  if (existing) return { phrase: existing, created: false };

  const phrase = generateRecoveryPhrase();
  try {
    await SecureStore.setItemAsync(STORE_KEY, phrase, {
      // Backups can be triggered while the phone sits locked on a bedside table, so the
      // phrase has to be readable after first unlock rather than only while the screen
      // is on.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch (error) {
    // A phrase that could not be persisted is still a usable phrase for THIS capsule, and
    // it is returned to the caller who will show it. Failing the export instead would
    // leave the user with no backup at all, which is strictly worse.
    console.warn('[backup] could not store the recovery phrase — show it to the user', describe(error));
  }
  return { phrase, created: true };
}

/**
 * Replaces the stored phrase. Old capsules keep opening with the OLD phrase.
 *
 * That is not a bug and the UI must say so: rotation protects future capsules, and there
 * is no way to re-key a capsule that has already left the device.
 */
export async function replaceRecoveryPhrase(): Promise<string> {
  const phrase = generateRecoveryPhrase();
  await SecureStore.setItemAsync(STORE_KEY, phrase, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return phrase;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
