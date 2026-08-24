/**
 * Translation layer.
 *
 * Design decisions worth knowing before changing anything here:
 *
 *  • `t()` exists BOTH as a React hook value and as a module-level function. Notification
 *    text, alarm rule titles and report headings are built outside the React tree — by the
 *    scheduler, by the journal drain, by the PDF builder — and those strings still have to
 *    be in the user's language. A hook-only API would have forced English into exactly the
 *    surfaces the user reads at 06:00 when a dose fires.
 *
 *  • A MISSING KEY NEVER THROWS. It falls back to English, then to the key itself, and
 *    warns in dev. A translation gap must degrade to an ugly screen, never to a crash on
 *    a screen that is about to record a blood pressure.
 *
 *  • `report.*` is English in BOTH files, by design. The UI is bilingual; the printout a
 *    doctor reads is always English, so any doctor at any OPD can read it. The parity
 *    script checks the key sets match — it does not check that the values differ.
 *
 * The JSON files are nested objects; keys are dotted paths ('entry.bp.systolic').
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';

import { LANGUAGES, RESOURCES, SUPPORTED_LANGUAGE_CODES } from './languages';
import { resolveKey } from './resolve';

/**
 * THE TWO LANGUAGE TYPES, AND WHY THERE ARE TWO.
 *
 * `LanguageCode` is any code the registry offers — 'en', 'hi', 'bn', … It is the FULL UI
 * language: what `t()` resolves against, what the picker selects, what is stored. The set is
 * DATA (see `languages.ts`), never a compile-time union, so a language added there needs no
 * change here.
 *
 * `Language` is the narrower 'en' | 'hi' — the BILINGUAL BASE. A great deal of this app picks
 * between exactly two hand-authored strings: a DB row's `labelEn`/`labelHi`, an inline
 * `{ en, hi }`, the `report.*` bundle that must stay English. There is no third column and
 * never will be one per optional language, so those sites receive `lang`, which is the full
 * language REDUCED to its base: en/hi map to themselves, and every optional language reduces
 * to 'en' — which is precisely its English fallback. Keeping `lang` at 'en' | 'hi' is what
 * lets an optional language ship without touching a single one of those bilingual call sites:
 * they were already correct for 'en', and an untranslated optional language IS 'en' to them.
 *
 * So: read `lang` to choose between two authored strings; read `languageCode` (or call `t`)
 * when you need the actual UI language.
 */
export type Language = 'en' | 'hi';
export type LanguageCode = string;

export type TranslationParams = Readonly<Record<string, string | number>>;

export type TranslateFn = (key: string, params?: TranslationParams) => string;

const LANGUAGE_STORAGE_KEY = 'aarogya.ui.language';

export { LANGUAGES, endonymOf } from './languages';
export type { LanguageDef } from './languages';

export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = LANGUAGES.map(
  (language) => language.code,
);

/** Reduce a full UI language to the base it draws its two authored strings from. */
export function baseLanguage(code: LanguageCode): Language {
  return code === 'hi' ? 'hi' : 'en';
}

function isSupportedCode(value: string | null | undefined): value is LanguageCode {
  return typeof value === 'string' && SUPPORTED_LANGUAGE_CODES.has(value);
}

/**
 * Device default. Wrapped in try/catch because `getLocales()` reads a native module,
 * and this function runs at module scope — before any error boundary exists.
 *
 * DELIBERATELY only auto-selects a FULL bundle (en/hi). A phone set to, say, Bengali does
 * NOT auto-select the optional Bengali bundle: shipped empty, it would render a wholly
 * English app while claiming to be Bengali, which is worse than plain English. An optional
 * language is opt-IN through the picker, where the choice is explicit. Once its bundle
 * carries real strings a human can add its code to this check.
 */
function detectDeviceLanguage(): LanguageCode {
  try {
    const locales = Localization.getLocales();
    const primary = locales[0];
    if (primary?.languageCode === 'hi') return 'hi';
  } catch (error) {
    console.warn('[i18n] could not read the device locale, defaulting to English', error);
  }
  return 'en';
}

/**
 * The language module-level `t()` reads. Initialised synchronously from the device
 * locale so a `t()` call that happens before React mounts (a cold-start notification
 * rebuild, for instance) is already in the right language, then corrected once the
 * stored preference is hydrated.
 */
let currentLanguage: LanguageCode = detectDeviceLanguage();

export function getLanguage(): LanguageCode {
  return currentLanguage;
}

/** '{{name}}' — whitespace tolerant, dotted names allowed. */
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

function interpolate(template: string, params: TranslationParams): string {
  return template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      if (__DEV__) console.warn(`[i18n] no value supplied for placeholder "${name}"`);
      return whole;
    }
    return String(value);
  });
}

function translate(language: LanguageCode, key: string, params?: TranslationParams): string {
  // `resolveKey` walks the current language, then falls back to English — the fallback that
  // makes an optional bundle safe to ship half-translated. It returns undefined ONLY when
  // the key is in neither, which is a real missing key, not a translation gap.
  const value = resolveKey(RESOURCES, language, key);

  if (value === undefined) {
    // Degrade to the key itself, never a throw: a gap must give an ugly screen, not a crash
    // on a screen about to record a blood pressure. (No per-key "fell back to English" warn:
    // on a barely-translated optional language that would fire on almost every string.)
    if (__DEV__) console.warn(`[i18n] missing translation key "${key}"`);
    return key;
  }

  return params ? interpolate(value, params) : value;
}

/**
 * Module-level translate. Safe to call from anywhere, including outside React.
 * Inside a component prefer `const { t } = useI18n()` — that one re-renders when the
 * language changes, this one does not.
 */
export function t(key: string, params?: TranslationParams): string {
  return translate(currentLanguage, key, params);
}

export type I18nContextValue = {
  /** The bilingual base ('en' | 'hi'): what to pass a two-string chooser. Optional → 'en'. */
  lang: Language;
  /** The full UI language ('en' | 'hi' | 'bn' | …): what the picker selects and stores. */
  languageCode: LanguageCode;
  setLang: (next: LanguageCode) => void;
  t: TranslateFn;
  /** False until the stored preference has been read. Useful for holding the splash. */
  ready: boolean;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [languageCode, setLanguageCode] = useState<LanguageCode>(currentLanguage);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isSupportedCode(stored)) {
          currentLanguage = stored;
          setLanguageCode(stored);
        }
      })
      .catch((error) => {
        console.warn('[i18n] could not read the stored language', error);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLang = useCallback((next: LanguageCode) => {
    // The module-level pointer is updated first, so a notification scheduled in the
    // same tick as the switch is already built in the new language.
    currentLanguage = next;
    setLanguageCode(next);
    AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next).catch((error) => {
      console.warn('[i18n] could not save the language preference', error);
    });
  }, []);

  // The full code drives translation (bn resolves bn→en per key); the reduced base is what
  // the bilingual call sites read. Both derive from the one piece of state.
  const lang = baseLanguage(languageCode);

  const boundTranslate = useCallback<TranslateFn>(
    (key, params) => translate(languageCode, key, params),
    [languageCode],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ lang, languageCode, setLang, t: boundTranslate, ready }),
    [lang, languageCode, setLang, boundTranslate, ready],
  );

  // No JSX here on purpose: this file is `index.ts`, not `.tsx`, because the whole
  // rest of the app imports `@/i18n` and a single element does not justify the rename.
  return React.createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n() was called outside <I18nProvider>. Wrap the app root in it.');
  }
  return value;
}

// `useDateFormat` is deliberately NOT re-exported here. It imports `useI18n` from this
// file, and re-exporting it would create an import cycle that only misbehaves at cold
// start under Metro. Import it from '@/i18n/useDateFormat' instead.
