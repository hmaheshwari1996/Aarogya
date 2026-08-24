/**
 * Setup step 1 — language, whose phone this is, and what to call her.
 *
 * The language choice is applied THE MOMENT IT IS TAPPED, before anything else on the
 * screen is read. A user who cannot read English cannot be asked to read an English
 * question about which language she reads; the two options are therefore written in
 * their own scripts and are the only strings on this screen that are never translated.
 *
 * "Whose phone is this?" is asked once and only once, here, because the answer decides
 * which app the person is holding for the rest of its life. Choosing the family member's
 * answer ends the wizard immediately: a viewer has no medicines, no dose times and no
 * emergency contact of her own to enter, and walking him through five screens of
 * questions that do not apply to him would teach him to tap Next without reading.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Chip, Screen, ScreenHeader, SectionHeader, Skeleton, Text, TextField, useToast } from '@/components/ui';
import { WizardFooter } from './_layout';
import { createProfile, getDefaultProfile, updateProfile } from '@/db/repositories/profiles';
import {
  META_ROLE,
  META_SETUP_DONE,
  ensureRegistrySeeded,
  invalidateProfileCache,
  setMeta,
  useAsync,
  useT,
  type AppRole,
  type LocalStrings,
} from '@/app/_shared/lib';

const SETUP_STEPS = 7;

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.welcome': { en: 'Welcome to Aarogya', hi: 'आरोग्य में आपका स्वागत है' },
  'setup.language.title': { en: 'Choose your language', hi: 'अपनी भाषा चुनें' },
  // Deliberately identical in both bundles: a language name is only useful to someone
  // who can already read it.
  'setup.language.english': { en: 'English', hi: 'English' },
  'setup.language.hindi': { en: 'हिंदी', hi: 'हिंदी' },
  'setup.whose.title': { en: 'Who will use this phone?', hi: 'इस फ़ोन को कौन चलाएगा?' },
  'setup.whose.patient': {
    en: 'I take the medicines myself',
    hi: 'दवाइयाँ मैं खुद लेती हूँ',
  },
  'setup.whose.viewer': {
    en: 'I am family. I only want to see how they are.',
    hi: 'मैं परिवार से हूँ। मैं सिर्फ़ देखना चाहता हूँ कि वे कैसे हैं।',
  },
  'setup.whose.viewerNote': {
    en: 'On this phone you will be able to look at everything, but not record anything. Only she can record her own readings and doses.',
    hi: 'इस फ़ोन पर आप सब कुछ देख सकेंगे, पर कुछ दर्ज नहीं कर सकेंगे। अपनी रीडिंग और दवाइयाँ सिर्फ़ वही दर्ज कर सकती हैं।',
  },
  'setup.name.title': { en: 'What should we call you?', hi: 'हम आपको क्या कहकर बुलाएँ?' },
  'setup.name.label': { en: 'Your name', hi: 'आपका नाम' },
  'setup.name.helper': {
    en: 'Only used to greet you and to head your doctor’s report. You can change it later in Settings.',
    hi: 'सिर्फ़ आपका स्वागत करने और डॉक्टर की रिपोर्ट के ऊपर लिखने के लिए। बाद में सेटिंग में बदल सकती हैं।',
  },
  /** Used when she presses Skip. Neutral, changeable, and never a guess at her name. */
  'setup.name.default': { en: 'You', hi: 'आप' },
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

export default function SetupLanguageScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);
  const { lang, setLang } = useI18n();

  // The registry seed runs before anything else in the app's life: `createReading()`
  // refuses an unknown metric_key, so without it the four entry tiles cannot write.
  // The existing profile is read in the same pass so that coming BACK to this step
  // updates the row she already has instead of creating a second default.
  const existing = useAsync(async () => {
    await ensureRegistrySeeded();
    return getDefaultProfile();
  }, []);

  const [role, setRole] = useState<AppRole>('patient');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  // Seeded during render, once per load, rather than from an effect: the field must
  // already carry her existing name on the first painted frame, and coming BACK to this
  // step must not re-seed over whatever she has since typed.
  const [seededFrom, setSeededFrom] = useState<typeof existing.data>(null);
  if (existing.data && existing.data !== seededFrom) {
    setSeededFrom(existing.data);
    setName(existing.data.displayName);
  }

  const finish = useCallback(
    async (keepName: boolean) => {
      if (saving) return;
      setSaving(true);
      try {
        if (role === 'viewer') {
          // A viewer profile is deliberately NOT created. This phone owns no clinical
          // record; it displays one that arrives later. An empty profile written here
          // would be an impostor row for the real record to collide with.
          await setMeta(META_ROLE, 'viewer');
          await setMeta(META_SETUP_DONE, '1');
          router.replace('/(viewer)');
          return;
        }

        await setMeta(META_ROLE, 'patient');
        const typed = keepName ? name.trim() : '';
        const current = existing.data;
        if (current) {
          // Skip must never overwrite a name she has already given. Coming back to this
          // step and pressing Skip means "leave it as it is", not "call me You".
          if (typed !== '') await updateProfile(current.id, { displayName: typed });
        } else {
          await createProfile({
            displayName: typed === '' ? t('setup.name.default') : typed,
            isDefault: true,
          });
        }
        invalidateProfileCache();
        router.push('/setup/conditions');
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setSaving(false);
      }
    },
    [saving, role, name, existing.data, router, t, toast],
  );

  const busy = existing.loading || saving;

  return (
    <Screen
      variant="scroll"
      footer={
        // Skip and the primary action are the same size and the same width. A skip
        // buried in small grey text is how a setup gets abandoned rather than finished,
        // and the app is fully usable without a name.
        <WizardFooter
          actions={[
            {
              title: t('common.skip'),
              onPress: () => void finish(false),
              variant: 'secondary',
              size: 'lg',
              disabled: busy,
            },
            {
              title: role === 'viewer' ? t('common.continue') : t('common.next'),
              onPress: () => void finish(true),
              size: 'lg',
              loading: saving,
              disabled: existing.loading,
            },
          ]}
        />
      }
    >
      <StepDots step={1} />
      <ScreenHeader title={t('setup.welcome')} />

      <View style={{ gap: spacing.md }}>
        <Text variant="label">{t('setup.language.title')}</Text>
        <Chip
          label={t('setup.language.english')}
          selected={lang === 'en'}
          onPress={() => setLang('en')}
          selectionMode="single"
          grow
        />
        <Chip
          label={t('setup.language.hindi')}
          selected={lang === 'hi'}
          onPress={() => setLang('hi')}
          selectionMode="single"
          grow
        />
      </View>

      <SectionHeader title={t('setup.whose.title')} />
      <View style={{ gap: spacing.md }}>
        <Chip
          label={t('setup.whose.patient')}
          selected={role === 'patient'}
          onPress={() => setRole('patient')}
          selectionMode="single"
          grow
        />
        <Chip
          label={t('setup.whose.viewer')}
          selected={role === 'viewer'}
          onPress={() => setRole('viewer')}
          selectionMode="single"
          grow
        />
        {role === 'viewer' ? (
          <Text variant="body" tone="muted">
            {t('setup.whose.viewerNote')}
          </Text>
        ) : null}
      </View>

      {role === 'patient' ? (
        <>
          <SectionHeader title={t('setup.name.title')} />
          {existing.loading ? (
            <Skeleton height={spacing.touchTarget} label={t('common.loading')} />
          ) : (
            <TextField
              label={t('setup.name.label')}
              helper={t('setup.name.helper')}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={60}
              returnKeyType="done"
            />
          )}
        </>
      ) : null}
    </Screen>
  );
}
