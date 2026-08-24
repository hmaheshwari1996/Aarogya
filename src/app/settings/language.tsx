/**
 * Language.
 *
 * Each option is written IN ITS OWN SCRIPT — "English" and "हिंदी" — never "Hindi" in
 * Latin letters. A user who cannot read the current language has to be able to find the
 * row that gets her out of it, and the only reliable landmark is the shape of her own
 * script.
 *
 * The change applies immediately, with no Save button and no restart. There is exactly
 * one thing to do on this screen and doing it is the confirmation.
 */

import React, { useCallback } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Card,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Text,
  useToast,
} from '@/components/ui';
import { SUPPORTED_LANGUAGES, useI18n, type Language } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

const STRINGS: LocalStrings = {
  'language.subtitle': {
    en: 'Choose the language you read most easily.',
    hi: 'वह भाषा चुनें जो आप सबसे आसानी से पढ़ पाती हैं।',
  },
  'language.changed': { en: 'Language changed', hi: 'भाषा बदल गई' },
};

const LABEL_KEYS: Record<Language, string> = {
  en: 'settings.languageEnglish',
  hi: 'settings.languageHindi',
};

export default function LanguageScreen() {
  const t = useT(STRINGS);
  const { lang, setLang } = useI18n();
  const { colors } = useTheme();
  const toast = useToast();

  const choose = useCallback(
    (next: Language) => {
      if (next !== lang) setLang(next);
      toast.show({ message: t('language.changed'), variant: 'success' });
    },
    [lang, setLang, t, toast],
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('settings.language')}
        subtitle={t('language.subtitle')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        {SUPPORTED_LANGUAGES.map((option) => {
          const selected = option === lang;
          const label = t(LABEL_KEYS[option]);
          return (
            <PressableScale
              key={option}
              onPress={() => choose(option)}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked: selected, selected }}
              accessibilityValue={{ text: selected ? t('a11y.selected') : t('a11y.notSelected') }}
            >
              <Card style={selected ? { borderColor: colors.primary, borderWidth: 3 } : undefined}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    minHeight: spacing.touchTargetLarge,
                  }}
                >
                  {/* Selection is carried by a tick as well as the border, so it survives
                      a bright screen, a cheap panel and colour deficiency alike. */}
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: radii.pill,
                      borderWidth: 2,
                      borderColor: selected ? colors.primary : colors.borderStrong,
                      backgroundColor: selected ? colors.primarySoft : colors.bgElevated,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {selected ? <Icon name="check" size={24} color={colors.primary} /> : null}
                  </View>
                  <Text variant="title" style={{ flex: 1 }}>
                    {label}
                  </Text>
                </View>
              </Card>
            </PressableScale>
          );
        })}
      </View>
    </Screen>
  );
}
