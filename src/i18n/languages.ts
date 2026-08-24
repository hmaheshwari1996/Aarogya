/**
 * The language registry — the ONE place a language is added.
 *
 * Adding an Indian language is a DROP-IN of DATA, by design:
 *
 *   1. create `src/i18n/optional/<code>.json` (start it as `{}`), and
 *   2. add one row to `LANGUAGES` below with the code, its endonym, and the import.
 *
 * Nothing else in the app changes. No `LocalStrings` object is touched, no screen is
 * edited, no type is widened by hand. The picker (`LanguagePicker.tsx`) renders whatever
 * is in this array; `index.ts` resolves against whatever this array carries; the parity
 * gate (`scripts/check-i18n.js`) only ever reads `en.json` and `hi.json`, so an optional
 * bundle never has to reach key-parity and can be shipped one string at a time.
 *
 * TWO KINDS OF BUNDLE:
 *   • en + hi are the FULL bundles. Every key exists in both, byte-for-byte for `report.*`,
 *     and `check:i18n` asserts it. These are the two languages the app was written in.
 *   • Everything else is OPTIONAL: a partial (possibly empty) per-key map. A key it does
 *     not carry falls back to English at lookup time (`resolve.ts::resolveKey`). An optional
 *     language shipped empty is a wholly-English app that a human can translate later, key
 *     by key, with no code change and no migration.
 *
 * The `endonym` is the language's own name in its own script — the single string on the
 * picker that is NEVER translated, because a user who cannot read the current UI language
 * has to be able to find the row that gets her out of it, and the only landmark that
 * survives is the shape of her own script. It is a standard name, not a translation we
 * invent — and no medical string is ever invented for an optional bundle.
 *
 * NOT INCLUDED, ON PURPOSE: Urdu and other right-to-left scripts. This app has no RTL
 * layout pass (no `I18nManager.forceRTL`, no mirrored components), so offering an RTL
 * language would ship a left-to-right app with right-to-left text — worse than not offering
 * it. Add RTL languages only alongside the layout work, not as a data drop-in.
 */

import type { TranslationTree } from './resolve';

import en from './en.json';
import hi from './hi.json';
import bn from './optional/bn.json';
import mr from './optional/mr.json';
import te from './optional/te.json';
import ta from './optional/ta.json';
import gu from './optional/gu.json';
import kn from './optional/kn.json';
import ml from './optional/ml.json';
import pa from './optional/pa.json';
import or from './optional/or.json';

export type LanguageDef = {
  /** BCP-47 primary subtag; the value stored as the preference and matched against the
   *  device locale. Kept `string` on purpose — the set is data, never a compile-time union. */
  readonly code: string;
  /** The language's own name, in its own script. Shown untranslated in every language. */
  readonly endonym: string;
  /** en/hi are complete; the rest are optional per-key maps with an English fallback. */
  readonly translations: TranslationTree;
};

export const LANGUAGES: readonly LanguageDef[] = [
  { code: 'en', endonym: 'English', translations: en },
  { code: 'hi', endonym: 'हिंदी', translations: hi },
  { code: 'bn', endonym: 'বাংলা', translations: bn },
  { code: 'mr', endonym: 'मराठी', translations: mr },
  { code: 'te', endonym: 'తెలుగు', translations: te },
  { code: 'ta', endonym: 'தமிழ்', translations: ta },
  { code: 'gu', endonym: 'ગુજરાતી', translations: gu },
  { code: 'kn', endonym: 'ಕನ್ನಡ', translations: kn },
  { code: 'ml', endonym: 'മലയാളം', translations: ml },
  { code: 'pa', endonym: 'ਪੰਜਾਬੀ', translations: pa },
  { code: 'or', endonym: 'ଓଡ଼ିଆ', translations: or },
];

/** `{ en: <tree>, hi: <tree>, … }` — the shape `resolveKey` resolves against. */
export const RESOURCES: Record<string, TranslationTree> = Object.fromEntries(
  LANGUAGES.map((language) => [language.code, language.translations]),
);

export const SUPPORTED_LANGUAGE_CODES: ReadonlySet<string> = new Set(
  LANGUAGES.map((language) => language.code),
);

export function endonymOf(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.endonym ?? code;
}
