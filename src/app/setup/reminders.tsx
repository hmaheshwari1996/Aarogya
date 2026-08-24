/**
 * Setup step 5 — permission to show reminders.
 *
 * ─── WHY THIS ASKS THROUGH `PermissionsAndroid` AND NOT `expo-notifications` ──────
 * `expo-notifications` is not a dependency of this project, and adding one to ask a
 * single Android runtime permission would be a lot of package for one call. RN's own
 * `PermissionsAndroid.request(POST_NOTIFICATIONS)` IS the real system prompt — the same
 * dialog, the same three outcomes — so nothing here is simulated. On Android 12 and
 * below the permission does not exist at all; it is granted at install time, so there is
 * nothing to ask for and the screen says the honest thing rather than showing a button
 * that would do nothing.
 *
 * The CURRENT state is read from `MedAlarm.probeHealth().notificationsEnabled`, which is
 * what the OS actually thinks, not what we last remembered. When the native module is not
 * in this build the answer is genuinely unknown, and the screen says "we cannot check
 * this" and offers phone settings. It never claims a state it does not have.
 *
 * `never_ask_again` is a wall: the system will not show the dialog again, so re-prompting
 * would be a button that visibly does nothing. From there the only route is phone
 * settings, and the screen says so plainly.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useState } from 'react';
import { Linking, PermissionsAndroid, Platform, View, type Permission } from 'react-native';
import { useRouter } from 'expo-router';

import { spacing, radii } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Banner, Button, Icon, Screen, ScreenHeader, Skeleton, Text } from '@/components/ui';
import { WizardFooter } from './_layout';
import { MedAlarm } from '../../../modules/med-alarm';
import { useAsync, useT, type LocalStrings } from '@/app/_shared/lib';

const SETUP_STEPS = 7;

/** POST_NOTIFICATIONS was introduced in Android 13 (API 33). */
const TIRAMISU = 33;

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.reminders.title': {
    en: 'May Aarogya remind you?',
    hi: 'क्या आरोग्य आपको याद दिला सकता है?',
  },
  'setup.reminders.why': {
    en: 'A reminder is how Aarogya tells you a medicine is due. The phone will not let any reminder appear until you say yes.',
    hi: 'याद-दिलावट से ही आरोग्य आपको बताता है कि दवा का समय हो गया है। जब तक आप हाँ नहीं कहतीं, फ़ोन कोई याद-दिलावट दिखने नहीं देगा।',
  },
  'setup.reminders.allowed': { en: 'Reminders are allowed', hi: 'याद-दिलावट की अनुमति है' },
  'setup.reminders.allowedDetail': {
    en: 'The phone will let Aarogya show you a reminder when a medicine is due.',
    hi: 'दवा का समय होने पर फ़ोन आरोग्य को याद-दिलावट दिखाने देगा।',
  },
  'setup.reminders.notAllowed': {
    en: 'Reminders are not allowed yet',
    hi: 'अभी याद-दिलावट की अनुमति नहीं है',
  },
  'setup.reminders.unknown': {
    en: 'Aarogya cannot check this on this build',
    hi: 'इस बिल्ड पर आरोग्य यह जाँच नहीं कर सकता',
  },
  'setup.reminders.unknownDetail': {
    en: 'The reminder part of Aarogya is not installed in this copy of the app, so it cannot ask the phone. Open phone settings to see the answer yourself.',
    hi: 'ऐप की इस कॉपी में आरोग्य का याद-दिलावट वाला हिस्सा नहीं है, इसलिए वह फ़ोन से पूछ नहीं सकता। जवाब खुद देखने के लिए फ़ोन की सेटिंग खोलें।',
  },
  'setup.reminders.switchedOff': {
    en: 'On this version of Android there is nothing to ask for — Aarogya’s notifications have been switched off in phone settings, and only phone settings can switch them back on.',
    hi: 'एंड्रॉइड के इस संस्करण में पूछने को कुछ नहीं है — फ़ोन की सेटिंग में आरोग्य की सूचनाएँ बंद कर दी गई हैं, और उन्हें वहीं से वापस चालू किया जा सकता है।',
  },
  'setup.reminders.allow': { en: 'Allow reminders', hi: 'अनुमति दें' },
  'setup.reminders.blocked': {
    en: 'The phone will not ask again. You can still allow it in phone settings, under Notifications.',
    hi: 'फ़ोन दोबारा नहीं पूछेगा। आप फ़ोन की सेटिंग में “सूचनाएँ” के नीचे जाकर अब भी अनुमति दे सकती हैं।',
  },
  'setup.reminders.recheck': { en: 'Check again', hi: 'फिर से जाँचें' },
  'setup.reminders.skipNote': {
    en: 'You can skip this. Until it is allowed, no reminder can appear on this phone — everything else in Aarogya still works.',
    hi: 'आप इसे छोड़ सकती हैं। जब तक अनुमति नहीं मिलती, इस फ़ोन पर कोई याद-दिलावट नहीं दिख सकती — आरोग्य में बाकी सब कुछ फिर भी चलता है।',
  },
};

/**
 * Seven dots, filled up to the step showing. Duplicated verbatim in every setup step —
 * see the note in `_layout.tsx`. Keep the copies identical.
 */
function StepDots({ step }: { step: number }) {
  const { colors } = useTheme();
  const t = useT(STRINGS);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('setup.stepOf', { step, total: SETUP_STEPS })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.md }}
    >
      {Array.from({ length: SETUP_STEPS }, (_, index) => (
        <View
          key={index}
          style={{
            width: index + 1 === step ? 32 : 14,
            height: 14,
            borderRadius: radii.pill,
            borderWidth: 2,
            borderColor: index < step ? colors.primary : colors.borderStrong,
            backgroundColor: index < step ? colors.primary : colors.bg,
          }}
        />
      ))}
    </View>
  );
}

/** 'allowed' | 'denied' — what the OS says. 'unknown' — we genuinely could not ask. */
type PermissionState = 'allowed' | 'denied' | 'unknown';

function canAskAtRuntime(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= TIRAMISU;
}

export default function SetupRemindersScreen() {
  const router = useRouter();
  const t = useT(STRINGS);
  const { colors } = useTheme();

  const [override, setOverride] = useState<PermissionState | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [asking, setAsking] = useState(false);

  const probe = useAsync<PermissionState>(async () => {
    try {
      const health = await MedAlarm.probeHealth();
      if (!health) return 'unknown';
      return health.notificationsEnabled ? 'allowed' : 'denied';
    } catch {
      return 'unknown';
    }
  }, []);

  const state: PermissionState = override ?? probe.data ?? 'unknown';

  const recheck = useCallback(async () => {
    try {
      const health = await MedAlarm.probeHealth();
      if (health) setOverride(health.notificationsEnabled ? 'allowed' : 'denied');
    } catch {
      /* leave the state as it was — a failed probe is not a new answer */
    }
  }, []);

  const ask = useCallback(async () => {
    if (asking) return;
    setAsking(true);
    try {
      // Typed as always-present, but a device or an older RN could still hand back
      // undefined here; absence means "nothing to ask for", never "the request failed".
      const permission: Permission | undefined = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
      if (!canAskAtRuntime() || !permission) {
        await recheck();
        return;
      }
      const result = await PermissionsAndroid.request(permission);
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        setOverride('allowed');
        setBlocked(false);
      } else {
        setOverride('denied');
        setBlocked(result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
      }
    } catch {
      setOverride('denied');
      // The system dialog failed to appear at all, so phone settings is the only route
      // left; saying so is more useful than a retry that will fail the same way.
      setBlocked(true);
    } finally {
      setAsking(false);
    }
  }, [asking, recheck]);

  const openSettings = useCallback(() => {
    void Linking.openSettings().catch(() => {
      /* Nothing to fall back to. The blocked note already names the setting by hand. */
    });
  }, []);

  const runtimeAskable = canAskAtRuntime();

  return (
    <Screen
      variant="scroll"
      footer={
        <WizardFooter
          actions={[
            {
              title: t('common.skip'),
              onPress: () => router.push('/setup/ai-key'),
              variant: 'secondary',
              size: 'lg',
            },
            {
              title: t('common.next'),
              onPress: () => router.push('/setup/ai-key'),
              size: 'lg',
            },
          ]}
        />
      }
    >
      <StepDots step={5} />
      <ScreenHeader
        title={t('setup.reminders.title')}
        subtitle={t('setup.reminders.why')}
        onBack={() => router.back()}
      />

      {probe.loading ? (
        <Skeleton height={120} label={t('common.loading')} />
      ) : state === 'allowed' ? (
        <View
          accessible
          accessibilityLabel={`${t('setup.reminders.allowed')}. ${t('setup.reminders.allowedDetail')}`}
          style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
        >
          <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Text variant="label">{t('setup.reminders.allowed')}</Text>
            <Text variant="body" tone="muted">
              {t('setup.reminders.allowedDetail')}
            </Text>
          </View>
        </View>
      ) : state === 'unknown' ? (
        // Not being able to READ the setting does not stop us ASKING for it: the system
        // dialog is a separate API from the probe, and its answer is more authoritative
        // than anything we could have read anyway.
        <View style={{ gap: spacing.lg }}>
          <Banner
            variant="info"
            title={t('setup.reminders.unknown')}
            message={t('setup.reminders.unknownDetail')}
          />
          {runtimeAskable ? (
            <Button
              title={t('setup.reminders.allow')}
              onPress={() => void ask()}
              size="xl"
              fullWidth
              loading={asking}
            />
          ) : null}
          <Button
            title={t('healthCheck.openSettings')}
            onPress={openSettings}
            variant="secondary"
            size="lg"
            fullWidth
          />
        </View>
      ) : !runtimeAskable ? (
        // Android 12 and below: the permission is install-time, so the OS answer above
        // ("not enabled") means she switched Aarogya's notifications off by hand.
        <Banner
          variant="attention"
          title={t('setup.reminders.notAllowed')}
          message={t('setup.reminders.switchedOff')}
          actionLabel={t('healthCheck.openSettings')}
          onAction={openSettings}
        />
      ) : (
        <View style={{ gap: spacing.lg }}>
          <Banner
            variant="attention"
            title={t('setup.reminders.notAllowed')}
            message={t('healthCheck.check.notifications.fail')}
          />
          {blocked ? (
            <>
              <Text variant="body">{t('setup.reminders.blocked')}</Text>
              <Button
                title={t('healthCheck.openSettings')}
                onPress={openSettings}
                size="lg"
                fullWidth
              />
              <Button
                title={t('setup.reminders.recheck')}
                onPress={() => void recheck()}
                variant="secondary"
                size="md"
                fullWidth
              />
            </>
          ) : (
            <Button
              title={t('setup.reminders.allow')}
              onPress={() => void ask()}
              size="xl"
              fullWidth
              loading={asking}
            />
          )}
        </View>
      )}

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xl }}>
        {t('setup.reminders.skipNote')}
      </Text>
    </Screen>
  );
}
