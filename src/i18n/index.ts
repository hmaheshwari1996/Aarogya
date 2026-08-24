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

import en from './en.json';
import hi from './hi.json';

export type Language = 'en' | 'hi';

export type TranslationParams = Readonly<Record<string, string | number>>;

export type TranslateFn = (key: string, params?: TranslationParams) => string;

type TranslationTree = { readonly [key: string]: string | TranslationTree };

const LANGUAGE_STORAGE_KEY = 'aarogya.ui.language';

export const SUPPORTED_LANGUAGES: readonly Language[] = ['en', 'hi'];

const RESOURCES: Record<Language, TranslationTree> = { en, hi };

function isLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'hi';
}

/**
 * Device default. Wrapped in try/catch because `getLocales()` reads a native module,
 * and this function runs at module scope — before any error boundary exists.
 */
function detectDeviceLanguage(): Language {
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
let currentLanguage: Language = detectDeviceLanguage();

export function getLanguage(): Language {
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

function lookup(tree: TranslationTree, key: string): string | undefined {
  let node: string | TranslationTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

function translate(language: Language, key: string, params?: TranslationParams): string {
  let value = lookup(RESOURCES[language], key);

  if (value === undefined && language !== 'en') {
    // English is the fallback, not the key. A doctor-facing or freshly added string
    // showing in English is recoverable; showing 'medicines.stopReason' is not.
    value = lookup(RESOURCES.en, key);
    if (value !== undefined && __DEV__) {
      console.warn(`[i18n] key "${key}" is missing in "${language}", fell back to English`);
    }
  }

  if (value === undefined) {
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
  lang: Language;
  setLang: (next: Language) => void;
  t: TranslateFn;
  /** False until the stored preference has been read. Useful for holding the splash. */
  ready: boolean;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(currentLanguage);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isLanguage(stored)) {
          currentLanguage = stored;
          setLangState(stored);
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

  const setLang = useCallback((next: Language) => {
    // The module-level pointer is updated first, so a notification scheduled in the
    // same tick as the switch is already built in the new language.
    currentLanguage = next;
    setLangState(next);
    AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next).catch((error) => {
      console.warn('[i18n] could not save the language preference', error);
    });
  }, []);

  const boundTranslate = useCallback<TranslateFn>(
    (key, params) => translate(lang, key, params),
    [lang],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t: boundTranslate, ready }),
    [lang, setLang, boundTranslate, ready],
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
