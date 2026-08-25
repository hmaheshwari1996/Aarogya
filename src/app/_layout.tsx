/**
 * The root layout — providers, the app lock, and the navigation stack.
 *
 * PROVIDER ORDER IS NOT ARBITRARY. Theme is outermost because every other provider
 * renders UI that reads colour tokens and the large-text scale. I18n comes next because
 * Toast and Confirm both render translated buttons. Toast and Confirm sit above the
 * navigator so a screen deep in the stack can raise either without owning a host, and so
 * a confirmation survives the screen that asked for it being replaced.
 *
 * The app lock is the innermost wrapper: it must render inside the theme and the
 * language, and it must be able to use the same Button the rest of the app uses. It is
 * NOT a route — a route would be dismissible with the hardware back button.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View, type AppStateStatus } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';

import { hydrateDevLogFromMirror, recordAppError } from '@/features/devlog';
import { I18nProvider, useI18n } from '@/i18n';
import { spacing } from '@/theme';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import {
  Button,
  ConfirmProvider,
  Icon,
  Screen,
  Text,
  ToastProvider,
  useToast,
} from '@/components/ui';

import { getMeta, useT, type LocalStrings } from './_shared/lib';

// Held until the language preference has been read, so the first frame is never English
// text that flips to Hindi a moment later in front of a user who reads only one of them.
void SplashScreen.preventAutoHideAsync();

export const SECURITY_LOCK_META_KEY = 'security_biometric_lock';

const STRINGS: LocalStrings = {
  'lock.title': { en: 'Aarogya is locked', hi: 'आरोग्य लॉक है' },
  'lock.message': {
    en: 'Unlock with your fingerprint or screen lock to continue.',
    hi: 'आगे बढ़ने के लिए अपनी उँगली या स्क्रीन लॉक से खोलिए।',
  },
  'lock.unlock': { en: 'Unlock', hi: 'खोलिए' },
  'lock.prompt': { en: 'Unlock Aarogya', hi: 'आरोग्य खोलिए' },
  'lock.unavailable': {
    en: 'This phone cannot check your fingerprint right now, so Aarogya has opened anyway.',
    hi: 'यह फ़ोन अभी उँगली की जाँच नहीं कर पा रहा, इसलिए आरोग्य वैसे ही खुल गया है।',
  },
  'error.title': { en: 'Aarogya hit a problem', hi: 'आरोग्य में कोई दिक्कत आई' },
};

/**
 * The app lock.
 *
 * IT FAILS OPEN, ON PURPOSE, IN EVERY FAILURE MODE — no hardware, nothing enrolled, a
 * sensor that errors, a database read that throws. A woman locked out of her own
 * medicine reminders by a fingerprint sensor that stopped working is in a strictly worse
 * position than one whose app was never locked. The lock protects a health record from a
 * casual glance; it is not, and must not become, a security boundary that can strand her.
 */
function AppLock({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const t = useT(STRINGS);

  const [required, setRequired] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const promptOpen = useRef(false);

  const authenticate = useCallback(async () => {
    if (promptOpen.current) return;
    promptOpen.current = true;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('lock.prompt'),
        // The device PIN/pattern must stay available: a fingerprint that has stopped
        // reading (dry skin, a cracked sensor) is common on the handsets this ships to.
        disableDeviceFallback: false,
      });
      if (result.success) setUnlocked(true);
    } catch {
      setDegraded(true);
      setUnlocked(true);
    } finally {
      promptOpen.current = false;
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // ── THIS IS THE FIRST `openDatabase()` OF THE PROCESS, NOT `boot()`'s ──────
        //
        // The line below reads one `app_meta` row, which opens the database — running
        // every pending migration, taking the `VACUUM INTO` snapshot, and running
        // `integrity_check` and `foreign_key_check` over it. All of that happens HERE,
        // before `src/app/index.tsx` mounts at all, because this component holds `<Stack>`
        // unmounted until the read resolves.
        //
        // So the developer log has to be awake before it, or the most valuable error this
        // app can produce is thrown, caught below, and forgotten — while `boot()`'s own
        // recording of it, added for exactly this reason, only fires on the SECOND attempt.
        // A deterministic failure (a bad migration, a corrupt file) fails again there and is
        // recorded; a failure that happens ONCE would have been survived in silence.
        //
        // One AsyncStorage read, awaited, on a path that is about to await a SQLite open —
        // so it costs nothing measurable, and it stores nothing whatsoever unless a human
        // turned the toggle on. It is idempotent; `boot()` calls it again and it returns on
        // its first line.
        await hydrateDevLogFromMirror();
        const enabled = (await getMeta(SECURITY_LOCK_META_KEY)) === '1';
        if (!enabled) {
          if (!cancelled) setRequired(false);
          return;
        }
        const [hasHardware, enrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (cancelled) return;
        if (!hasHardware || !enrolled) {
          setDegraded(true);
          setRequired(false);
          return;
        }
        setRequired(true);
        void authenticate();
      } catch (error) {
        // Includes the database being unopenable. The boot screen will surface that
        // properly; the lock's only job here is to get out of the way — it FAILS OPEN, and
        // that is not changing.
        //
        // But it must not fail SILENT as well. This catch used to swallow the first, and on
        // a transient failure the only, migration or integrity error the process would ever
        // produce. The note costs nothing when the toggle is off (`recordAppError` returns
        // on a module-level boolean before it touches the error) and it is the difference
        // between "the app opened oddly one morning" and a line her son can read.
        //
        // Not flushed to disk here, unlike `boot()`'s: nothing is about to rethrow, the app
        // carries on to the boot screen, and the ordinary debounced write picks it up.
        //
        // The tag is `lock/init` and not `lock/openDatabase`, because this catch also covers
        // the two `LocalAuthentication` probes above. A `where` that names a cause the log
        // cannot actually vouch for is worse than a vague one — `errorName` says which it
        // was, and a tag that lied would send the reader to the wrong file.
        recordAppError(error, 'lock/init');
        if (!cancelled) setRequired(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticate]);

  // Re-lock when the app has been in the background. Checked on every foreground rather
  // than on a timer, because a timer keeps running while the phone is in a handbag.
  useEffect(() => {
    if (required !== true) return;
    const onChange = (state: AppStateStatus) => {
      if (state === 'background') setUnlocked(false);
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [required]);

  if (required === null) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  if (required && !unlocked) {
    return (
      <Screen variant="fixed" background="bg">
        <View style={{ flex: 1, justifyContent: 'center', gap: spacing.xl }}>
          <View style={{ alignItems: 'center', gap: spacing.md }}>
            <Icon name="info" size={48} color={colors.primary} strokeWidth={1.8} />
            <Text variant="title" align="center" accessibilityRole="header">
              {t('lock.title')}
            </Text>
            <Text variant="body" tone="muted" align="center">
              {t('lock.message')}
            </Text>
          </View>
          <Button title={t('lock.unlock')} onPress={() => void authenticate()} size="xl" fullWidth />
        </View>
      </Screen>
    );
  }

  return (
    <>
      <DegradedLockNotice degraded={degraded} />
      {children}
    </>
  );
}

/**
 * Says out loud that the lock was skipped.
 *
 * A lock that silently does nothing is worse than no lock: she believes the app is
 * protected when it is not. Announced once, as information rather than an alarm.
 */
function DegradedLockNotice({ degraded }: { degraded: boolean }) {
  const toast = useToast();
  const t = useT(STRINGS);
  const announced = useRef(false);

  useEffect(() => {
    if (!degraded || announced.current) return;
    announced.current = true;
    toast.show({ message: t('lock.unavailable'), variant: 'info' });
  }, [degraded, toast, t]);

  return null;
}

function Providers({ children }: { children: React.ReactNode }) {
  const { ready } = useI18n();

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppLock>{children}</AppLock>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/**
 * Pull family changes when the app comes BACK to the foreground, not only on a cold start.
 *
 * `src/app/index.tsx` syncs once at boot, but boot happens rarely: Android keeps this process
 * alive for hours, so a phone that was opened this morning and is opened again this evening
 * never re-runs it. On a shared profile that means looking at a record that a sister updated
 * at the hospital and seeing this morning's version, with nothing on screen admitting it.
 *
 * Always mounted and deliberately NOT tied to the biometric lock — the AppState listener in
 * `AppLock` above only runs when the lock is on, and sync has to work for everyone else too.
 *
 * `syncNow` shares the boot sync's in-flight guard, so a resume that races the cold-start sync
 * is a no-op rather than a second publish. Fire-and-forget: this is the network, and the
 * screen she is returning to must paint now, not after a slow relay answers.
 */
function useSyncOnForeground(): void {
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state !== 'active') return;
      void import('@/features/sync')
        .then(({ syncNow }) => syncNow())
        // Swallowed for the same reason boot swallows it: sharing failing is a visibility
        // problem for the family, and the record on this phone is untouched either way.
        .catch(() => {});
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);
}

export default function RootLayout() {
  useSyncOnForeground();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <I18nProvider>
            <ThemedStatusBar />
            <Providers>
              {/* Headers are off everywhere: every screen renders its own ScreenHeader,
                  whose back control is a labelled 56dp target rather than the 24dp
                  chevron a native header would give a user with a tremor. */}
              <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
            </Providers>
          </I18nProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ThemedStatusBar() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

/**
 * Last-resort error screen.
 *
 * It re-establishes Theme and I18n itself: expo-router renders this OUTSIDE the layout
 * component that normally provides them, so `useTheme()` here would throw inside the
 * handler for a throw — and a crashed error boundary is a white screen.
 *
 * The message is deliberately reassuring about data. Nothing this boundary catches can
 * have lost a recorded reading: every write is committed inside its own transaction
 * before the UI is told about it.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nProvider>
          <ErrorBoundaryBody error={error} retry={retry} />
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function ErrorBoundaryBody({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const t = useT(STRINGS);
  const { colors } = useTheme();

  return (
    <Screen variant="scroll" background="bg">
      <View style={{ paddingTop: spacing.xxl, gap: spacing.lg }}>
        <Icon name="alert" size={44} color={colors.attention} strokeWidth={1.8} />
        <Text variant="title" accessibilityRole="header">
          {t('error.title')}
        </Text>
        <Text variant="body">{t('errors.unexpected')}</Text>
        <Text variant="caption" tone="muted" selectable>
          {error.message}
        </Text>
        <Button title={t('common.retry')} onPress={() => void retry()} size="lg" fullWidth />
      </View>
    </Screen>
  );
}
