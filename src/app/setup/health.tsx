/**
 * Setup step 6 — the reminder check.
 *
 * ENDING THE WIZARD HERE IS THE POINT OF THE WIZARD. Everything before this asked her for
 * something; this one tells her something, and it is the only promise the app actually
 * makes: that an alarm arrives. On the handsets this ships to, the alarm not arriving is
 * the normal case until somebody goes and turns three OEM settings off, and a medication
 * app that discovers that on day nine has already failed.
 *
 * This screen is a SUMMARY, not the check. `/reminder-health` owns the nine rows and the
 * fixes; here we count how many of them are already failing so the button she taps next
 * is an informed one.
 *
 * WHAT IS DELIBERATELY NOT COUNTED: horizon staleness. At the end of setup she has no
 * medicines, so there are no alarm rules and the horizon is legitimately empty. Counting
 * that as a fault would put a red-flavoured number on the last screen of setup for a
 * problem that does not exist and that she cannot act on.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Banner, Icon, Screen, ScreenHeader, Skeleton, Text, useToast } from '@/components/ui';
import { WizardFooter } from './_layout';
import { MedAlarm } from '../../../modules/med-alarm';
import { META_SETUP_DONE, setMeta, useAsync, useT, type LocalStrings } from '@/app/_shared/lib';

const SETUP_STEPS = 7;

/** Android's UsageStatsManager.STANDBY_BUCKET_RESTRICTED. */
const STANDBY_RESTRICTED = 45;

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.health.title': { en: 'One last thing', hi: 'आख़िरी एक बात' },
  'setup.health.why': {
    en: 'Aarogya is only useful if a reminder actually reaches you. Many phones quietly stop apps in the background, and then the reminder never rings. The reminder check finds that, and shows you exactly what to change.',
    hi: 'आरोग्य तभी काम का है जब याद-दिलावट सचमुच आप तक पहुँचे। कई फ़ोन ऐप को पीछे से चुपचाप बंद कर देते हैं, और फिर याद-दिलावट कभी बजती ही नहीं। यह जाँच वही पकड़ती है और बताती है कि क्या बदलना है।',
  },
  'setup.health.cannotCheck': {
    en: 'Aarogya could not look at the phone’s settings',
    hi: 'आरोग्य फ़ोन की सेटिंग नहीं देख पाया',
  },
  'setup.health.cannotCheckDetail': {
    en: 'The reminder part of Aarogya is not installed in this copy of the app. Open the reminder check to see what it can still tell you.',
    hi: 'ऐप की इस कॉपी में आरोग्य का याद-दिलावट वाला हिस्सा नहीं है। जाँच खोलकर देखें कि वह अब भी क्या बता सकता है।',
  },
  'setup.health.check': { en: 'Check my reminders', hi: 'मेरी याद-दिलावट जाँचें' },
  'setup.health.finish': { en: 'Finish', hi: 'हो गया' },
  'setup.health.finishNote': {
    en: 'You can run this check any time from Settings.',
    hi: 'यह जाँच आप सेटिंग से कभी भी चला सकती हैं।',
  },
  'setup.health.allGoodDetail': {
    en: 'Nothing on this phone is stopping a reminder right now.',
    hi: 'अभी इस फ़ोन पर कोई चीज़ याद-दिलावट को रोक नहीं रही।',
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

/** null means "we could not look", which is NOT the same answer as zero. */
type Summary = { failures: number } | null;

export default function SetupHealthScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);
  const { colors } = useTheme();

  const [finishing, setFinishing] = useState(false);

  const probe = useAsync<Summary>(async () => {
    try {
      const health = await MedAlarm.probeHealth();
      if (!health) return null;

      // One count, not a re-implementation of the nine rows — /reminder-health owns
      // those, their wording and their fixes.
      const problems = [
        !health.notificationsEnabled,
        !health.canScheduleExactAlarms,
        !health.isIgnoringBatteryOptimizations,
        health.alarmVolumeIsZero,
        health.isTotalSilence,
        health.standbyBucket === STANDBY_RESTRICTED,
        // A channel the user muted, silenced or switched off in phone settings. Counted
        // once however many channels are affected — she has one thing to go and fix.
        health.channels.some(
          (channel) => channel.importance === 0 || channel.muted || !channel.hasSound,
        ),
      ];
      return { failures: problems.filter(Boolean).length };
    } catch {
      return null;
    }
  }, []);

  const finish = useCallback(async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await setMeta(META_SETUP_DONE, '1');
      router.replace('/(tabs)');
    } catch {
      // Setup that cannot record its own completion would loop her back to step 1 on
      // the next cold start, so this is worth surfacing rather than swallowing.
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      setFinishing(false);
    }
  }, [finishing, router, toast, t]);

  const summary = probe.data;

  return (
    <Screen
      variant="scroll"
      footer={
        // Stacked: the check is the 72dp primary action of the whole wizard and Finish is
        // the way past it. They are not a pair of equals, so they do not share a row.
        <WizardFooter
          layout="stack"
          actions={[
            {
              title: t('setup.health.check'),
              onPress: () => router.push('/reminder-health'),
              size: 'xl',
            },
            {
              title: t('setup.health.finish'),
              onPress: () => void finish(),
              variant: 'secondary',
              size: 'lg',
              loading: finishing,
            },
          ]}
        />
      }
    >
      <StepDots step={7} />
      <ScreenHeader
        title={t('setup.health.title')}
        subtitle={t('setup.health.why')}
        onBack={() => router.back()}
      />

      {probe.loading ? (
        <Skeleton height={120} label={t('healthCheck.running')} />
      ) : summary === null ? (
        <Banner
          variant="info"
          title={t('setup.health.cannotCheck')}
          message={t('setup.health.cannotCheckDetail')}
        />
      ) : summary.failures === 0 ? (
        <View
          accessible
          accessibilityLabel={`${t('healthCheck.allGood')}. ${t('setup.health.allGoodDetail')}`}
          style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
        >
          <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Text variant="label">{t('healthCheck.allGood')}</Text>
            <Text variant="body" tone="muted">
              {t('setup.health.allGoodDetail')}
            </Text>
          </View>
        </View>
      ) : (
        // `attention`, never `destructive`: this is Aarogya reporting that ITS OWN
        // delivery is at risk, which is an app problem and not a verdict about her.
        <Banner
          variant="attention"
          title={t('healthCheck.problemsFound', { count: summary.failures })}
          message={t('healthCheck.warningBanner.message')}
        />
      )}

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xl }}>
        {t('setup.health.finishNote')}
      </Text>
    </Screen>
  );
}
