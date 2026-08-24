/**
 * Theme + large-text provider.
 *
 * Two things live here, deliberately together:
 *
 *  1. The colour scheme, tracked reactively from the OS via `useColorScheme()`.
 *     There is no in-app light/dark switch — one less setting for a user who does not
 *     want settings, and the OS already has one.
 *
 *  2. LARGE-TEXT MODE. For the primary user this is not an accessibility extra bolted
 *     on the side; it is a core feature, and it is the first row in Settings. Turning
 *     it on multiplies EVERY size in `fontSize` by 1.25 — body 17 → 21, the read-back
 *     number 34 → 43 — which is the size at which she can read a value without hunting
 *     for her reading glasses. Because it multiplies the token scale rather than
 *     overriding individual components, nothing can opt out of it by accident.
 *
 * The preference is persisted. A large-text setting that silently reverted on every
 * cold start would be a real defect for this user, not a cosmetic one.
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
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { darkColors, fontSize, lightColors, type ThemeColors } from './index';

export type ColorSchemeName = 'light' | 'dark';

/**
 * The same keys as `fontSize`, but widened to `number`. `fontSize` is declared
 * `as const`, so its members carry literal types (`xs: 13`) and a scaled copy would
 * not be assignable back to it.
 */
export type FontSizes = { readonly [K in keyof typeof fontSize]: number };

/** Multiplier applied to every font size when large-text mode is on. */
export const LARGE_TEXT_SCALE = 1.25;

const LARGE_TEXT_STORAGE_KEY = 'aarogya.ui.largeText';

export type ThemeContextValue = {
  colors: ThemeColors;
  scheme: ColorSchemeName;
  isLargeText: boolean;
  setLargeText: (value: boolean) => void;
};

/**
 * `fontSizes` rides along in the same context object so `useTheme()` and
 * `useFontSizes()` share one value and one re-render, while `useTheme()` still
 * advertises exactly the four members its consumers are supposed to use.
 */
type InternalThemeValue = ThemeContextValue & { fontSizes: FontSizes };

const ThemeContext = createContext<InternalThemeValue | null>(null);

function scaleFontSizes(scale: number): FontSizes {
  const keys = Object.keys(fontSize) as (keyof typeof fontSize)[];
  const scaled: Record<string, number> = {};
  for (const key of keys) {
    // Rounded to whole points: fractional font sizes render blurry on Android's
    // low-density Go-class panels this app is expected to run on.
    scaled[key] = Math.round(fontSize[key] * scale);
  }
  return scaled as FontSizes;
}

/** Computed once at module load — the scale is a constant, not a slider. */
const LARGE_FONT_SIZES: FontSizes = scaleFontSizes(LARGE_TEXT_SCALE);
const BASE_FONT_SIZES: FontSizes = fontSize;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [isLargeText, setIsLargeText] = useState(false);

  // `useColorScheme()` returns null while the OS value is unknown. Falling back to
  // light rather than dark keeps first paint consistent with the splash screen.
  const scheme: ColorSchemeName = systemScheme === 'dark' ? 'dark' : 'light';

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LARGE_TEXT_STORAGE_KEY)
      .then((stored) => {
        if (!cancelled && stored !== null) setIsLargeText(stored === '1');
      })
      .catch((error) => {
        // A storage read failure must never block the UI — it just means the user
        // sees the default size until she sets it again.
        console.warn('[theme] could not read the large-text preference', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLargeText = useCallback((value: boolean) => {
    // Applied optimistically. The write is fire-and-forget: the toggle must feel
    // instant, and a failed write only costs the setting on the next cold start.
    setIsLargeText(value);
    AsyncStorage.setItem(LARGE_TEXT_STORAGE_KEY, value ? '1' : '0').catch((error) => {
      console.warn('[theme] could not save the large-text preference', error);
    });
  }, []);

  const value = useMemo<InternalThemeValue>(
    () => ({
      colors: scheme === 'dark' ? darkColors : lightColors,
      scheme,
      isLargeText,
      setLargeText,
      fontSizes: isLargeText ? LARGE_FONT_SIZES : BASE_FONT_SIZES,
    }),
    [scheme, isLargeText, setLargeText],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeInternal(): InternalThemeValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme() was called outside <ThemeProvider>. Wrap the app root in it.');
  }
  return value;
}

export function useTheme(): ThemeContextValue {
  return useThemeInternal();
}

/**
 * Font sizes already multiplied by the large-text scale. Components must read sizes
 * from here rather than importing `fontSize` directly, or they will silently ignore
 * large-text mode.
 */
export function useFontSizes(): FontSizes {
  return useThemeInternal().fontSizes;
}
