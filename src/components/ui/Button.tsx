/**
 * The app's button.
 *
 * SIZING IS A SAFETY PROPERTY, NOT A STYLE CHOICE. `md` is already 56dp tall — Android's
 * 48dp guidance assumes a steady finger, which this user does not have — and `xl`, used
 * for the single primary action on an entry screen, is 72dp. Those are MINIMA: a Hindi
 * label that wraps to two lines at 1.25× has to make the button taller, never spill out
 * of it.
 *
 * ─── WHY THE CALLER'S `style` GOES ON A WRAPPER AND NOT ON THE PRESSABLE ──────────
 * Every call site that lays two buttons out side by side passes `style={{ flex: 1 }}`.
 * `PressableScale` puts an `Animated.View` (the scale transform) between us and the
 * caller's row, so that `flex: 1` used to land on the Pressable INSIDE that wrapper —
 * a column box whose main axis is vertical. There it meant `flexBasis: 0` on the
 * HEIGHT, which Yoga resolves against the wrapper's own auto height: the button
 * collapsed to exactly `minHeight` and stopped being able to grow, while the two
 * buttons in the row stayed content-width instead of splitting it. One 56/64dp box
 * with a two-line label inside it is precisely the clipped-mid-label footer seen on the
 * device, and it only appears at large text, which is how it shipped.
 *
 * Putting the caller's style on a plain wrapper View makes it a real flex child of the
 * caller's row — `flex: 1` now means half the width, as written — and leaves the
 * button's own height content-driven and floored by `minHeight`.
 * ──────────────────────────────────────────────────────────────────────────────────
 *
 * MEANING IS NEVER CARRIED BY COLOUR ALONE:
 *  • `destructive` gets a warning icon as well as a colour, because ~8% of men cannot
 *    reliably separate it from `primary`.
 *  • `disabled` changes the fill AND the border AND sets `accessibilityState.disabled`,
 *    rather than only dropping opacity — a faded button and a normal one look identical
 *    through a cataract.
 *  • `loading` keeps the label visible next to the spinner and marks the control busy,
 *    so the button never becomes an unlabelled grey rectangle mid-save.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { fontWeight, radii, spacing } from '@/theme';
import { useFontSizes, useTheme, type FontSizes } from '@/theme/ThemeProvider';

import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'md' | 'lg' | 'xl';

type SizeSpec = {
  minHeight: number;
  paddingHorizontal: number;
  fontSize: keyof FontSizes;
  iconSize: number;
  gap: number;
};

const SIZES: Record<ButtonSize, SizeSpec> = {
  md: {
    minHeight: spacing.touchTarget,
    paddingHorizontal: spacing.lg,
    fontSize: 'md',
    iconSize: 22,
    gap: spacing.sm,
  },
  lg: {
    minHeight: 64,
    paddingHorizontal: spacing.xl,
    fontSize: 'lg',
    iconSize: 26,
    gap: spacing.md,
  },
  xl: {
    minHeight: spacing.touchTargetLarge,
    paddingHorizontal: spacing.xl,
    fontSize: 'xl',
    iconSize: 30,
    gap: spacing.md,
  },
};

export type ButtonProps = {
  /** Already translated by the caller. */
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  /** Optional leading icon. `destructive` supplies its own if none is given. */
  icon?: IconName;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const spec = SIZES[size];

  // A loading button is not pressable — a second tap on "Save" while the first write is
  // in flight is the classic duplicate-reading bug.
  const isInert = disabled || loading;

  const palette = useMemo(() => {
    if (isInert) {
      return {
        background: variant === 'ghost' ? 'transparent' : colors.bgSunken,
        border: colors.border,
        content: colors.textMuted,
      };
    }
    switch (variant) {
      case 'primary':
        return { background: colors.primary, border: colors.primary, content: colors.primaryText };
      case 'secondary':
        return { background: colors.bgElevated, border: colors.borderStrong, content: colors.text };
      case 'ghost':
        return { background: 'transparent', border: 'transparent', content: colors.primary };
      case 'destructive':
        return {
          background: colors.destructiveSoft,
          border: colors.destructive,
          content: colors.destructive,
        };
    }
  }, [variant, isInert, colors]);

  // The icon is what keeps "delete" distinguishable from "save" without colour.
  const resolvedIcon: IconName | undefined = icon ?? (variant === 'destructive' ? 'alert' : undefined);

  return (
    <View style={[{ alignSelf: fullWidth ? 'stretch' : 'flex-start' }, style]}>
      <PressableScale
        onPress={onPress}
        disabled={isInert}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: isInert, busy: loading }}
        testID={testID}
        style={{
          // A floor, never a height. Nothing below may set `height`, and no caller can
          // reach in and pin it — see the note at the top of the file.
          minHeight: spec.minHeight,
          paddingHorizontal: spec.paddingHorizontal,
          paddingVertical: spacing.sm,
          borderRadius: radii.lg,
          borderWidth: 2,
          borderColor: palette.border,
          backgroundColor: palette.background,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spec.gap,
        }}
      >
        {loading ? (
          <ActivityIndicator color={palette.content} size="small" />
        ) : resolvedIcon ? (
          <Icon name={resolvedIcon} size={spec.iconSize} color={palette.content} />
        ) : null}

        {/* flexShrink lets a long Hindi label wrap to two lines rather than overflow. */}
        <View style={{ flexShrink: 1 }}>
          <Text
            align="center"
            weight={fontWeight.semibold}
            style={{
              fontSize: fontSizes[spec.fontSize],
              lineHeight: Math.round(fontSizes[spec.fontSize] * 1.3),
              color: palette.content,
            }}
          >
            {title}
          </Text>
        </View>
      </PressableScale>
    </View>
  );
}

export default Button;
