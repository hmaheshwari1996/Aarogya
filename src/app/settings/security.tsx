/**
 * App lock.
 *
 * ─── THE LOCK FAILS OPEN. THIS IS THE WHOLE DESIGN. ───────────────────────────
 * If the fingerprint reader is missing, broken, wet, disabled by the OS, or simply
 * throws, Aarogya opens anyway. It is a curtain, not a safe.
 *
 * The reasoning is not about threat models, it is about who is standing in front of the
 * phone: an elderly woman with three conditions whose reminders are the only thing
 * telling her which tablet is due. A sensor that stops recognising a worn fingertip —
 * which happens, routinely, on cheap handsets — would lock her out of her own medicine
 * schedule. Someone in her house reading her blood pressure history is a far smaller
 * harm than that. So a failed or unavailable check NEVER blocks entry; it is only ever
 * allowed to skip the prompt.
 *
 * Turning the lock OFF does not ask for a fingerprint either, for the same reason: the
 * only way to reach this screen is to have already passed the lock, and demanding a
 * second successful read to undo it is exactly how someone gets stuck.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useState } from 'react';
import { Linking, Switch, View } from 'react-native';
import { router } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';

import { getMeta, setMeta, useAsync, useReloadOnFocus, useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Card,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useToast,
} from '@/components/ui';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

/** Read by the app root before it renders anything the lock is supposed to cover. */
const BIOMETRIC_LOCK_KEY = 'security_biometric_lock';

const STRINGS: LocalStrings = {
  'security.title': { en: 'Lock the app', hi: 'ऐप पर ताला' },
  'security.subtitle': {
    en: 'Ask for your fingerprint before Aarogya opens.',
    hi: 'आरोग्य खुलने से पहले आपका फिंगरप्रिंट माँगा जाए।',
  },
  'security.toggle': { en: 'Ask for a fingerprint', hi: 'फिंगरप्रिंट माँगें' },
  'security.toggleHelp': {
    en: 'Only on this phone. Nothing changes on your family’s phones.',
    hi: 'सिर्फ़ इसी फोन पर। परिवार के फोनों पर कुछ नहीं बदलता।',
  },
  'security.failOpenTitle': {
    en: 'If the fingerprint reader does not work, Aarogya still opens',
    hi: 'अगर फिंगरप्रिंट रीडर काम न करे, तो भी आरोग्य खुल जाएगा',
  },
  'security.failOpenBody': {
    en: 'This lock is a curtain, not a safe. If the reader is broken or wet, or the phone forgets your fingerprint, the app opens anyway. Being shut out of your own medicine reminders would be far worse than somebody reading them.',
    hi: 'यह ताला एक परदा है, तिजोरी नहीं। अगर रीडर ख़राब हो या उँगली गीली हो, या फोन आपका फिंगरप्रिंट भूल जाए, तो भी ऐप खुल जाएगा। अपनी ही दवाई के रिमाइंडर से बाहर रह जाना, किसी के उन्हें पढ़ लेने से कहीं ज़्यादा बुरा है।',
  },
  'security.noHardware': {
    en: 'This phone has no fingerprint reader, so the lock cannot be switched on.',
    hi: 'इस फोन में फिंगरप्रिंट रीडर नहीं है, इसलिए ताला चालू नहीं किया जा सकता।',
  },
  'security.notEnrolled': {
    en: 'No fingerprint has been saved on this phone yet. Save one in the phone’s own settings first, then come back here.',
    hi: 'इस फोन में अभी कोई फिंगरप्रिंट सहेजा नहीं गया है। पहले फोन की अपनी सेटिंग में एक सहेजें, फिर यहाँ वापस आएँ।',
  },
  'security.prompt': {
    en: 'Touch the fingerprint reader to switch the lock on',
    hi: 'ताला चालू करने के लिए फिंगरप्रिंट रीडर छुएँ',
  },
  'security.enabled': { en: 'The lock is on.', hi: 'ताला चालू हो गया है।' },
  'security.disabled': { en: 'The lock is off.', hi: 'ताला बंद हो गया है।' },
  'security.checkFailed': {
    en: 'The phone could not read your fingerprint, so the lock has been left off.',
    hi: 'फोन आपका फिंगरप्रिंट नहीं पढ़ पाया, इसलिए ताला बंद ही रहने दिया गया है।',
  },
  'security.saveFailed': {
    en: 'That could not be saved.',
    hi: 'यह सहेजा नहीं जा सका।',
  },
};

type Capability = {
  hasHardware: boolean;
  isEnrolled: boolean;
  enabled: boolean;
};

export default function SecurityScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const state = useAsync<Capability>(async () => {
    // Every probe is guarded: on a handset whose biometric HAL is missing these can
    // throw rather than return false, and a throw here would leave the screen unusable.
    const hasHardware = await LocalAuthentication.hasHardwareAsync().catch(() => false);
    const isEnrolled = hasHardware
      ? await LocalAuthentication.isEnrolledAsync().catch(() => false)
      : false;
    const enabled = (await getMeta(BIOMETRIC_LOCK_KEY)) === '1';
    return { hasHardware, isEnrolled, enabled };
  }, []);

  const { reload } = state;
  useReloadOnFocus(reload);

  const usable = Boolean(state.data?.hasHardware && state.data.isEnrolled);
  const enabled = state.data?.enabled ?? false;

  const toggle = useCallback(
    async (next: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        if (next) {
          // Proving the reader works BEFORE storing the preference is the only way to
          // avoid switching on a lock that will greet her with a prompt she cannot pass.
          const result = await LocalAuthentication.authenticateAsync({
            promptMessage: t('security.prompt'),
            cancelLabel: t('common.cancel'),
            // No PIN fallback: she does not have one, and being sent to a keypad she
            // never set is exactly the dead end this screen is written to avoid.
            disableDeviceFallback: true,
          }).catch(() => ({ success: false }) as const);

          if (!result.success) {
            toast.show({ message: t('security.checkFailed'), variant: 'error' });
            return;
          }
          await setMeta(BIOMETRIC_LOCK_KEY, '1');
          toast.show({ message: t('security.enabled'), variant: 'success' });
        } else {
          await setMeta(BIOMETRIC_LOCK_KEY, '0');
          toast.show({ message: t('security.disabled'), variant: 'success' });
        }
        reload();
      } catch (error) {
        console.warn('[security] could not change the lock setting', error);
        toast.show({ message: t('security.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [busy, t, toast, reload],
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('security.title')}
        subtitle={t('security.subtitle')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        {state.loading && !state.data ? <Skeleton height={96} label={t('a11y.loading')} /> : null}

        {state.data ? (
          <>
            <Card>
              <PressableScale
                onPress={() => void toggle(!enabled)}
                disabled={!usable || busy}
                accessibilityRole="switch"
                accessibilityLabel={`${t('security.toggle')}. ${t('security.toggleHelp')}`}
                accessibilityState={{ checked: enabled, disabled: !usable || busy }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  minHeight: spacing.touchTarget,
                  paddingVertical: spacing.md,
                  opacity: usable ? 1 : 0.55,
                }}
              >
                <View style={{ flex: 1, gap: spacing.xs }}>
                  <Text variant="body" weight="600">
                    {t('security.toggle')}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {t('security.toggleHelp')}
                  </Text>
                </View>
                <View
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Switch
                    value={enabled}
                    onValueChange={(next) => void toggle(next)}
                    disabled={!usable || busy}
                    trackColor={{ false: colors.border, true: colors.primarySoft }}
                    thumbColor={enabled ? colors.primary : colors.borderStrong}
                  />
                </View>
              </PressableScale>
            </Card>

            {!state.data.hasHardware ? (
              <Banner variant="info" title={t('security.title')} message={t('security.noHardware')} />
            ) : null}

            {state.data.hasHardware && !state.data.isEnrolled ? (
              <Banner
                variant="attention"
                title={t('security.title')}
                message={t('security.notEnrolled')}
                actionLabel={t('healthCheck.openSettings')}
                onAction={() => {
                  void Linking.openSettings().catch(() => undefined);
                }}
              />
            ) : null}

            {/* Stated on screen, in her words, not only in a code comment. */}
            <Banner
              variant="info"
              title={t('security.failOpenTitle')}
              message={t('security.failOpenBody')}
            />
          </>
        ) : null}

        {state.error ? (
          <Banner
            variant="attention"
            title={t('errors.loadFailed')}
            message={state.error.message}
            actionLabel={t('common.retry')}
            onAction={reload}
          />
        ) : null}
      </View>
    </Screen>
  );
}

export { BIOMETRIC_LOCK_KEY };
