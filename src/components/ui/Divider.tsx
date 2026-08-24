/**
 * A hairline separator.
 *
 * 1dp rather than `StyleSheet.hairlineWidth`: on the low-density panels this app targets
 * a hairline resolves to a sub-pixel line that disappears entirely for a user with
 * presbyopia, and the separator is doing real work — it is what tells her that yesterday's
 * reading and today's are two different rows.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

export type DividerProps = {
  /** Left/right inset, for dividers that sit inside a padded list. */
  inset?: number;
  vertical?: boolean;
  /** Use the stronger border token where a divider separates sections, not rows. */
  strong?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Divider({ inset = 0, vertical = false, strong = false, style }: DividerProps) {
  const { colors } = useTheme();
  const color = strong ? colors.borderStrong : colors.border;

  return (
    <View
      // Purely visual: never announced, and never focusable by TalkBack.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        vertical
          ? { width: 1, alignSelf: 'stretch', marginVertical: inset }
          : { height: 1, alignSelf: 'stretch', marginHorizontal: inset },
        { backgroundColor: color },
        style,
      ]}
    />
  );
}

/** Convenience for the common "divider between rows in a padded card" case. */
export const ROW_DIVIDER_INSET = spacing.lg;

export default Divider;
