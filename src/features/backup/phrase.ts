/**
 * The recovery-phrase alphabet and its arithmetic. Pure — no storage, no platform.
 *
 * Split out from `./passphrase.ts` so `node --test` can load it: the storage half imports
 * `expo-secure-store`, which does not exist off a device, and the interesting half is the
 * part a test can actually check — that the sampling is unbiased, that a phrase typed
 * back in with the dashes missing and the caps lock off still matches, and that a
 * mis-transcribed O is REJECTED rather than silently repaired.
 */

/**
 * No I, L, O, U, 0 or 1.
 *
 * Every removed character is one somebody copies off a piece of paper wrongly. U is out
 * as well — not for legibility, but because a randomly generated string that happens to
 * spell something unfortunate is a support conversation nobody wants to have.
 */
export const PHRASE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const GROUP_SIZE = 4;
export const GROUP_COUNT = 6;
/** 24 characters from a 30-symbol alphabet ≈ 117 bits. Far past any offline attack. */
export const PHRASE_LENGTH = GROUP_SIZE * GROUP_COUNT;

/**
 * Generates a phrase with no modulo bias.
 *
 * 256 is not a multiple of 30, so `byte % 30` would make the first 16 symbols very
 * slightly likelier than the rest. Rejecting the tail costs a handful of extra random
 * bytes and removes the argument entirely.
 *
 * `randomBytes` is injected so the test can feed it the exact byte values that would
 * expose a biased implementation.
 */
export function buildRecoveryPhrase(randomBytes: (count: number) => Uint8Array): string {
  const limit = Math.floor(256 / PHRASE_ALPHABET.length) * PHRASE_ALPHABET.length;
  const symbols: string[] = [];

  let guard = 0;
  while (symbols.length < PHRASE_LENGTH) {
    guard += 1;
    if (guard > 1000) throw new Error('The random source is not producing usable bytes.');
    const batch = randomBytes(PHRASE_LENGTH);
    if (batch.length === 0) throw new Error('The random source returned nothing.');
    for (let i = 0; i < batch.length && symbols.length < PHRASE_LENGTH; i += 1) {
      const byte = batch[i] ?? 0;
      if (byte >= limit) continue;
      symbols.push(PHRASE_ALPHABET[byte % PHRASE_ALPHABET.length] ?? 'A');
    }
  }

  const groups: string[] = [];
  for (let i = 0; i < PHRASE_LENGTH; i += GROUP_SIZE) {
    groups.push(symbols.slice(i, i + GROUP_SIZE).join(''));
  }
  return groups.join('-');
}

/**
 * Accepts the phrase however it was typed back in.
 *
 * Lower case, missing dashes, spaces instead of dashes, a stray trailing space from a
 * paste — all of it normalises to the same thing. The one substitution NOT made is
 * O→0 or I→1: those characters are not in the alphabet, so a phrase containing them was
 * mis-transcribed, and quietly "fixing" it would turn a legible error into an
 * inexplicable wrong-passphrase on the one screen where that is unaffordable.
 */
export function normalisePhrase(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isWellFormedPhrase(input: string): boolean {
  const bare = normalisePhrase(input);
  if (bare.length !== PHRASE_LENGTH) return false;
  for (const character of bare) {
    if (!PHRASE_ALPHABET.includes(character)) return false;
  }
  return true;
}

/** Grouped for display. Idempotent, so it is safe to call on an already-grouped phrase. */
export function formatPhrase(input: string): string {
  const bare = normalisePhrase(input);
  const groups: string[] = [];
  for (let i = 0; i < bare.length; i += GROUP_SIZE) groups.push(bare.slice(i, i + GROUP_SIZE));
  return groups.join('-');
}
