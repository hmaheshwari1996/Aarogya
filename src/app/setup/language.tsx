/**
 * First-run language gate — the FIRST screen a new patient sees, before the numbered wizard.
 *
 * A user who cannot read English cannot be asked, in English, which language she reads. So
 * this screen carries almost no prose: a title, and a list of languages each written in its
 * OWN script (`LanguagePicker`). The choice applies THE MOMENT it is tapped — the whole UI
 * flips to it, which is the only confirmation someone who cannot read the old language can
 * act on — and Continue moves into the wizard proper.
 *
 * It is a PRE-STEP, not step 1, and carries no progress dots: the wizard's seven steps are
 * about the patient (name, conditions, dose times, …); the language is the precondition for
 * being able to answer any of them. `app/setup/index.tsx` remains step 1.
 *
 * REACHED FIRST only once the boot gate routes a first-run patient here — see the note in the
 * hand-off report. Until then this screen is correct and navigable but simply not the landing
 * route; it never double-asks, because Continue leads to step 1 either way.
 */

import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import { Screen, ScreenHeader } from '@/components/ui';
import { LanguagePicker } from '@/i18n/LanguagePicker';
import { useI18n } from '@/i18n';
import { setLanguagePref } from '@/db/repositories/settings';
import { spacing } from '@/theme';
import { WizardFooter } from './_layout';

const STRINGS: LocalStrings = {
  'setup.pickLanguage.title': { en: 'Choose Your Language', hi: 'अपनी भाषा चुनें' },
  'setup.pickLanguage.subtitle': {
    en: 'You can change this any time in Settings.',
    hi: 'इसे आप कभी भी सेटिंग में बदल सकती हैं।',
  },
};

export default function SetupLanguageScreen() {
  const router = useRouter();
  const t = useT(STRINGS);
  const { languageCode, setLang } = useI18n();

  const choose = useCallback(
    (next: string) => {
      // `setLang` flips the UI live and writes AsyncStorage — the source boot reads before
      // the database is open, so it stays the authority. `setLanguagePref` mirrors it into
      // `app_meta` (device-local, never synced) for any db-scoped reader. Fire-and-forget:
      // a failed mirror write must never undo the language she just saw take effect.
      if (next !== languageCode) {
        setLang(next);
        void setLanguagePref(next).catch(() => {});
      }
    },
    [languageCode, setLang],
  );

  return (
    <Screen
      variant="scroll"
      footer={
        <WizardFooter
          layout="stack"
          actions={[
            { title: t('common.continue'), onPress: () => router.push('/setup'), size: 'lg' },
          ]}
        />
      }
    >
      <View style={{ paddingTop: spacing.md }}>
        <ScreenHeader
          title={t('setup.pickLanguage.title')}
          subtitle={t('setup.pickLanguage.subtitle')}
        />
      </View>
      <LanguagePicker value={languageCode} onChange={choose} />
    </Screen>
  );
}
