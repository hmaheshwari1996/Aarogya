/**
 * An elevated surface.
 *
 * Cards are bordered rather than shadowed. A 1–2dp shadow is invisible to a presbyopic
 * eye and vanishes completely in dark mode; a solid border reads as an edge at any age
 * and in either scheme.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { PressableScale } from './PressableScale';

export type CardProps = {
  children: React.ReactNode;
  /** `sunken` is for read-only detail blocks nested inside another card. */
  variant?: 'elevated' | 'sunken' | 'outlined';
  padding?: number;
  onPress?: () => void;
  /** Required when `onPress` is set — a pressable card must announce what it does. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Card({
  children,
  variant = 'elevated',
  padding = spacing.lg,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  testID,
}: CardProps) {
  const { colors } = useTheme();

  const background =
    variant === 'sunken' ? colors.bgSunken : variant === 'outlined' ? 'transparent' : colors.bgElevated;

  const containerStyle: StyleProp<ViewStyle> = [
    {
      backgroundColor: background,
      borderRadius: radii.lg,
      borderWidth: variant === 'outlined' ? 2 : 1,
      borderColor: variant === 'outlined' ? colors.borderStrong : colors.border,
      padding,
      opacity: disabled ? 0.55 : 1,
    },
    style,
  ];

  if (!onPress) {
    return (
      <View style={containerStyle} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={containerStyle}
      testID={testID}
    >
      {children}
    </PressableScale>
  );
}

export default Card;
