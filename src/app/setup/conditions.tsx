/**
 * Setup step 2 — what her doctor is treating her for.
 *
 * THE QUESTION IS "WHAT IS YOUR DOCTOR TREATING YOU FOR", NEVER "WHAT IS WRONG WITH YOU".
 * The difference is not politeness. A woman with active TB has spent months being asked
 * the second question by people who then treated her differently; the app is not going to
 * be one of them, and the framing also happens to be the accurate one — a condition pack
 * is a statement about a treatment in progress, not a diagnosis this app is entitled to
 * record.
 *
 * The step is fully skippable because a pack only ever ENABLES metrics, symptoms and
 * tests. Nothing downstream requires one: with no pack at all every entry tile, every
 * chart and every report still works, they simply offer a shorter list.
 *
 * Each tap is written immediately. Un-selecting calls `disableCondition`, which DATES the
 * pack off and deletes nothing — the metrics it materialised stay tracked, because a year
 * of glucose readings is not less true because she stopped tracking diabetes.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { useI18n } from '@/i18n';
import { toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Banner, Chip, Screen, ScreenHeader, Skeleton, Text, useToast } from '@/components/ui';
import { WizardFooter } from './_layout';
import {
  disableCondition,
  enableCondition,
  listConditionPacks,
  listProfileConditions,
  type ConditionPack,
} from '@/db/repositories/profiles';
import { materialiseMetricsForPack } from '@/db/repositories/metrics';
import { resolveProfileId, useAsync, useT, type LocalStrings } from '@/app/_shared/lib';

const SETUP_STEPS = 7;

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.conditions.title': {
    en: 'What is your doctor treating you for?',
    hi: 'डॉक्टर आपका किस चीज़ का इलाज कर रहे हैं?',
  },
  'setup.conditions.help': {
    en: 'Choose as many as apply. This only decides what Aarogya offers to record — nothing here is added to your emergency card, and you can change it any time.',
    hi: 'जितने लागू हों उतने चुनें। इससे सिर्फ़ यह तय होता है कि आरोग्य क्या दर्ज करने को कहेगा — इसमें से कुछ भी आपके आपातकालीन कार्ड पर नहीं जाता, और आप इसे कभी भी बदल सकती हैं।',
  },
  'setup.conditions.skipNote': {
    en: 'You can leave this. Everything in Aarogya works without it.',
    hi: 'आप इसे छोड़ सकती हैं। इसके बिना भी आरोग्य में सब कुछ चलता है।',
  },
  'setup.conditions.noProfile': {
    en: 'Let us start from the first question',
    hi: 'चलिए पहले सवाल से शुरू करते हैं',
  },
  'setup.conditions.noProfileMessage': {
    en: 'Aarogya does not have your name yet, so there is nothing to attach this to.',
    hi: 'आरोग्य के पास अभी आपका नाम नहीं है, इसलिए इसे किससे जोड़ें यह पता नहीं है।',
  },
  'setup.conditions.goBack': { en: 'Go to the first question', hi: 'पहले सवाल पर जाएँ' },
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

type Loaded = {
  profileId: string | null;
  packs: ConditionPack[];
  enabled: string[];
};

export default function SetupConditionsScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);
  const { lang } = useI18n();

  const state = useAsync<Loaded>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) return { profileId: null, packs: [], enabled: [] };
    const [packs, conditions] = await Promise.all([
      listConditionPacks(),
      listProfileConditions(profileId),
    ]);
    return {
      profileId,
      packs,
      enabled: conditions.filter((row) => row.endedOn === null).map((row) => row.packKey),
    };
  }, []);

  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Seeded during render, once per load. An effect would land a frame later, showing the
  // chips unselected before her existing packs snapped on; and re-seeding on any later
  // render would fight the optimistic toggle below.
  const [seededFrom, setSeededFrom] = useState<Loaded | null>(null);
  if (state.data && state.data !== seededFrom) {
    setSeededFrom(state.data);
    setSelected(state.data.enabled);
  }

  const profileId = state.data?.profileId ?? null;

  const toggle = useCallback(
    async (packKey: string) => {
      if (!profileId || busyKey !== null) return;
      const wasOn = selected.includes(packKey);
      // Applied optimistically so the checkmark lands under her finger immediately, then
      // reverted if the write fails. A chip that waits on SQLite invites a second tap.
      setSelected((current) =>
        wasOn ? current.filter((key) => key !== packKey) : [...current, packKey],
      );
      setBusyKey(packKey);
      try {
        const today = toLocalDate();
        if (wasOn) {
          await disableCondition(profileId, packKey, today);
        } else {
          await enableCondition(profileId, packKey, today);
          await materialiseMetricsForPack(profileId, packKey);
        }
      } catch {
        setSelected((current) =>
          wasOn ? [...current, packKey] : current.filter((key) => key !== packKey),
        );
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusyKey(null);
      }
    },
    [profileId, busyKey, selected, toast, t],
  );

  if (!state.loading && profileId === null) {
    return (
      <Screen variant="scroll">
        <StepDots step={2} />
        <ScreenHeader title={t('setup.conditions.title')} onBack={() => router.back()} />
        <Banner
          variant="attention"
          title={t('setup.conditions.noProfile')}
          message={t('setup.conditions.noProfileMessage')}
          actionLabel={t('setup.conditions.goBack')}
          onAction={() => router.replace('/setup')}
        />
      </Screen>
    );
  }

  return (
    <Screen
      variant="scroll"
      footer={
        <WizardFooter
          actions={[
            {
              title: t('common.skip'),
              onPress: () => router.push('/setup/slots'),
              variant: 'secondary',
              size: 'lg',
            },
            {
              title: t('common.next'),
              onPress: () => router.push('/setup/slots'),
              size: 'lg',
            },
          ]}
        />
      }
    >
      <StepDots step={2} />
      <ScreenHeader
        title={t('setup.conditions.title')}
        subtitle={t('setup.conditions.help')}
        onBack={() => router.back()}
      />

      {state.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={spacing.touchTarget} label={t('common.loading')} />
          <Skeleton height={spacing.touchTarget} />
          <Skeleton height={spacing.touchTarget} />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          {/* Bounded by the seeded registry — three packs today, and the seed is the only
              thing that can add a fourth. */}
          {state.data?.packs.map((pack) => (
            <Chip
              key={pack.key}
              label={lang === 'hi' ? pack.labelHi : pack.labelEn}
              selected={selected.includes(pack.key)}
              onPress={() => void toggle(pack.key)}
              selectionMode="multiple"
              disabled={busyKey !== null && busyKey !== pack.key}
              grow
            />
          ))}
        </View>
      )}

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.lg }}>
        {t('setup.conditions.skipNote')}
      </Text>
    </Screen>
  );
}
