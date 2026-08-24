/**
 * A row in a list — a medicine, a dose, a past reading, a settings item.
 *
 * The whole row is the target, never just the chevron, and it is at least 56dp tall.
 * A row also collapses into ONE accessibility node: title, subtitle and the trailing
 * status read as a single sentence, because "Metformin" / "500 mg, twice a day" /
 * "Taken" arriving as three separate swipes is three chances to lose which medicine the
 * status belonged to.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ListRowProps = {
  /** Already translated by the caller. */
  title: string;
  subtitle?: string;
  /** Third line — provenance, timing, or a status word. */
  meta?: string;
  /** Leading slot: an icon, an avatar, a criticality marker. */
  leading?: React.ReactNode;
  /** Trailing slot: a status chip, a value, a switch. */
  trailing?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  /** Shows the affordance chevron. Ignored when there is no `onPress`. */
  showChevron?: boolean;
  /**
   * Replaces the spoken sentence built from `title`/`subtitle`/`meta` — for the case where
   * one of those lines is on screen to be LOOKED at rather than listened to.
   *
   * The row is one accessibility node by design, so anything in `meta` is read out before
   * she can reach a control. `backup.tsx` puts the capsule's filename there so a row can be
   * matched against what a file manager shows; spoken, `aarogya-2026-08-09-1432.aarogya` is
   * a string of digit groups and dashes, five of them in a row, on the screen where she is
   * choosing which file to delete.
   *
   * It is an override and not a `hideMeta` flag because the substitute has to be WRITTEN —
   * a row that silently drops its third line speaks less than it shows, which is the same
   * failure in the other direction.
   */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function ListRow({
  title,
  subtitle,
  meta,
  leading,
  trailing,
  onPress,
  disabled = false,
  showChevron = true,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: ListRowProps) {
  const { colors } = useTheme();

  const spokenLabel =
    accessibilityLabel ??
    [title, subtitle, meta].filter((part): part is string => Boolean(part)).join('. ');

  const content = (
    <>
      {leading ? <View>{leading}</View> : null}

      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="body" weight="600">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="body" tone="muted">
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text variant="caption" tone="muted">
            {meta}
          </Text>
        ) : null}
      </View>

      {trailing ? <View>{trailing}</View> : null}
      {onPress && showChevron ? (
        <Icon name="chevronRight" size={24} color={colors.textMuted} />
      ) : null}
    </>
  );

  const rowStyle: StyleProp<ViewStyle> = [
    {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: spacing.touchTarget,
      paddingVertical: spacing.md,
      opacity: disabled ? 0.55 : 1,
    },
    style,
  ];

  if (!onPress) {
    return (
      <View accessible accessibilityLabel={spokenLabel} style={rowStyle} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={rowStyle}
      testID={testID}
    >
      {content}
    </PressableScale>
  );
}

export default ListRow;
