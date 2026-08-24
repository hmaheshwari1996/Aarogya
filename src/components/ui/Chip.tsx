/**
 * A large selectable chip — meal context on the sugar screen, symptoms on the symptom
 * screen, day-of-week on a schedule.
 *
 * WHY CHIPS AND NOT A DROPDOWN: a picker hides every option but one behind a tap, and a
 * user who cannot read the closed state cannot discover what she is choosing between.
 * Chips put all four or five options on screen at 56dp each.
 *
 * SELECTED STATE IS TRIPLY ENCODED — fill, a 3dp border, and a checkmark. Any one of the
 * three alone fails somebody: fill and border both fail in bright sunlight on a cheap
 * panel, colour fails for red/green deficiency, and the checkmark is the one that
 * survives all of it.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ChipProps = {
  /** Already translated by the caller. */
  label: string;
  selected: boolean;
  onPress: () => void;
  /**
   * Drives the TalkBack role: 'single' announces a radio, 'multiple' a checkbox.
   * Getting this wrong is the difference between "you may pick one" and "you may pick
   * several", which TalkBack states out loud and the visual design cannot.
   */
  selectionMode?: 'single' | 'multiple';
  disabled?: boolean;
  /** Lets a chip stretch to fill a row in a wrapping group. */
  grow?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Chip({
  label,
  selected,
  onPress,
  selectionMode = 'single',
  disabled = false,
  grow = false,
  accessibilityHint,
  style,
  testID,
}: ChipProps) {
  const { colors } = useTheme();
  const { t } = useI18n();

  const borderColor = disabled
    ? colors.border
    : selected
      ? colors.primary
      : colors.borderStrong;

  const backgroundColor = disabled
    ? colors.bgSunken
    : selected
      ? colors.primarySoft
      : colors.bgElevated;

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={selectionMode === 'multiple' ? 'checkbox' : 'radio'}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked: selected, selected, disabled }}
      // Belt and braces: some TalkBack builds ignore `checked` on a custom view, so the
      // state is also part of the spoken value.
      accessibilityValue={{ text: selected ? t('a11y.selected') : t('a11y.notSelected') }}
      testID={testID}
      style={[
        {
          minHeight: spacing.touchTarget,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          borderRadius: radii.lg,
          borderWidth: selected ? 3 : 2,
          borderColor,
          backgroundColor,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          flexGrow: grow ? 1 : 0,
          opacity: disabled ? 0.6 : 1,
        },
        style,
      ]}
    >
      {/* A fixed-width slot so selecting a chip does not reflow the row it sits in. */}
      <View style={{ width: 26, alignItems: 'center' }}>
        {selected ? <Icon name="check" size={26} color={colors.primary} strokeWidth={2.8} /> : null}
      </View>
      <Text variant="body" weight={selected ? '700' : '400'} style={{ flexShrink: 1 }}>
        {label}
      </Text>
    </PressableScale>
  );
}

export default Chip;
