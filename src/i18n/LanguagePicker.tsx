/**
 * The language list, shared by the first-run gate (`app/setup/language.tsx`) and Settings
 * (`app/settings/language.tsx`). One component so the two places cannot drift on the parts
 * that matter: the 56dp touch target a tremor needs, and the dual selection signal.
 *
 * Each row is the language's OWN endonym, in its OWN script, never translated — a user who
 * cannot read the current UI language finds her row by the shape of her script, so a Hindi
 * label on a Bengali row would strand exactly the person this screen is for.
 *
 * SELECTION IS CARRIED BY A TICK AS WELL AS THE BORDER — never colour alone. It has to
 * survive a bright screen, a cheap panel and red/green colour deficiency, the same rule the
 * rest of the app follows for readings.
 *
 * Not re-exported from `index.ts`: that file is imported app-wide and stays free of
 * `@/components/ui` (this imports it), so keeping the picker in its own module avoids a
 * cycle — the same reason `useDateFormat` is imported by path.
 */

import React from 'react';
import { View } from 'react-native';

import { Card, Icon, PressableScale, Text } from '@/components/ui';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { LANGUAGES } from './languages';
import { useI18n } from './index';

export type LanguagePickerProps = {
  /** The selected language code. */
  value: string;
  /** Called with the tapped code. Applying it (and persisting) is the caller's job. */
  onChange: (code: string) => void;
};

export function LanguagePicker({ value, onChange }: LanguagePickerProps) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <View style={{ gap: spacing.md }}>
      {LANGUAGES.map((language) => {
        const selected = language.code === value;
        return (
          <PressableScale
            key={language.code}
            onPress={() => onChange(language.code)}
            accessibilityRole="radio"
            accessibilityLabel={language.endonym}
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
                  {language.endonym}
                </Text>
              </View>
            </Card>
          </PressableScale>
        );
      })}
    </View>
  );
}
