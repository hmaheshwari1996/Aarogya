/**
 * Language.
 *
 * Every option is rendered in its OWN script by `LanguagePicker` — "English", "हिंदी",
 * "বাংলা" — never a transliteration. A user who cannot read the current language has to be
 * able to find the row that gets her out of it, and the only reliable landmark is the shape
 * of her own script.
 *
 * The change applies immediately, with no Save button and no restart. There is exactly one
 * thing to do on this screen and doing it is the confirmation.
 *
 * The set of languages lives in `src/i18n/languages.ts`; this screen renders whatever is
 * there. en + hi are complete; the rest fall back to English for any key not yet translated,
 * so a language added as a data file shows up here with no change to this file.
 */

import React, { useCallback } from 'react';
import { router } from 'expo-router';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import { Screen, ScreenHeader, useToast } from '@/components/ui';
import { LanguagePicker } from '@/i18n/LanguagePicker';
import { useI18n } from '@/i18n';
import { setLanguagePref } from '@/db/repositories/settings';

const STRINGS: LocalStrings = {
  'language.subtitle': {
    en: 'Choose the language you read most easily.',
    hi: 'वह भाषा चुनें जो आप सबसे आसानी से पढ़ पाती हैं।',
  },
  'language.changed': { en: 'Language changed', hi: 'भाषा बदल गई' },
};

export default function LanguageScreen() {
  const t = useT(STRINGS);
  const { languageCode, setLang } = useI18n();
  const toast = useToast();

  const choose = useCallback(
    (next: string) => {
      // `setLang` flips the live UI and persists to AsyncStorage — the source boot reads
      // BEFORE the database is open, so it must stay the authority. `setLanguagePref` mirrors
      // the same choice into `app_meta` for any db-scoped reader; a mirror write that fails
      // must not swallow the language change she just saw, so it is fire-and-forget.
      if (next !== languageCode) {
        setLang(next);
        void setLanguagePref(next).catch(() => {});
      }
      toast.show({ message: t('language.changed'), variant: 'success' });
    },
    [languageCode, setLang, t, toast],
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('settings.language')}
        subtitle={t('language.subtitle')}
        onBack={() => router.back()}
      />
      <LanguagePicker value={languageCode} onChange={choose} />
    </Screen>
  );
}
