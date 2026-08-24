/**
 * The pure heart of translation: walk a dotted key into a tree, and fall back to English
 * when the current language does not carry it.
 *
 * This file imports NOTHING — no JSON, no native module, no React. That is the whole point.
 * `index.ts` cannot be loaded under `node --test` (it imports `expo-localization` and the
 * `*.json` bundles, and a bare JSON import throws `ERR_IMPORT_ATTRIBUTE_MISSING` on the
 * type-stripping loader), so the one piece of logic that MUST be provable — that a language
 * with a missing key renders English rather than a raw key path — lives here, where a test
 * can reach it. `resolve.test.ts` pins exactly that. Same convention as
 * `features/slots/registry.ts`: keep the deciding half pure.
 *
 * English is the fallback for EVERY language but English, which is what makes an optional
 * language safe to ship half-translated: an untranslated key is English, never `medicines.
 * stopReason`. See `languages.ts` for how the optional bundles are wired.
 */

export type TranslationTree = { readonly [key: string]: string | TranslationTree };

/** Walk `a.b.c` into a tree. Returns undefined for a missing path or a non-leaf. */
export function lookup(tree: TranslationTree | undefined, key: string): string | undefined {
  let node: string | TranslationTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Resolve `key` in `language`, falling back to English. Returns undefined only when the key
 * is in NEITHER the language nor English — i.e. a genuinely missing key, which the caller
 * degrades to the key path. A key present in English but not `language` returns the English
 * value: that is the fallback an optional bundle relies on, and it is deliberately silent —
 * warning per key would fire hundreds of times for a user on a barely-translated language.
 *
 * `resources` is `{ en, hi, bn, … }`; an unknown code (or a language whose tree is missing)
 * resolves straight to English, because `lookup(undefined, …)` is undefined by construction.
 */
export function resolveKey(
  resources: Record<string, TranslationTree | undefined>,
  language: string,
  key: string,
): string | undefined {
  const direct = lookup(resources[language], key);
  if (direct !== undefined) return direct;
  if (language === 'en') return undefined;
  return lookup(resources.en, key);
}
