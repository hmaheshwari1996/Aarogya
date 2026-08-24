/**
 * A grid of giant entry tiles — the shape the Today screen made familiar, reused wherever
 * a screen offers a small fixed set of "record this" choices.
 *
 * THE WHOLE POINT IS THAT NOTHING IMPORTANT LIVES BELOW THE FOLD. Two columns of tiles
 * at 120dp minimum fill the first screen, so recording a reading is always one visible
 * tap from opening the app. Anything that needs a scroll to reach is, for this user,
 * something that does not exist.
 *
 * 120dp is a floor, not a fixed height: in large-text mode the label grows and the tile
 * grows with it, rather than clipping the word.
 *
 * ─── THE COLUMN COUNT IS STRUCTURAL, NOT EMERGENT ────────────────────────────
 * This used to be a single `flexWrap: 'wrap'` row whose items carried `flexBasis: '47%'`,
 * and letting the wrap algorithm DECIDE the column count each frame is what makes that
 * shape fragile. It holds only while `columns × basis + (columns − 1) × gap ≤ 100%` — so
 * it is one edit to `gap`, one edit to the basis, or one narrow display away from
 * silently laying four tiles out in a single column, with nothing in the types and
 * nothing in a test to notice. It has already failed that way once: while `PressableScale`
 * wrapped its Pressable in an unflexed `Animated.View`, the caller's basis never reached
 * the flex child at all and the Today grid shipped as 4×1. (See the header of
 * `PressableScale.tsx` — that wrapper is gone.)
 *
 * The items are therefore CHUNKED into fixed rows, each row a plain `flexDirection: 'row'`
 * with the default `flexWrap: 'nowrap'`, and each tile `flex: 1`. A nowrap row cannot
 * break, so there is no decision left to get wrong: the grid has exactly `columns`
 * columns at every width, every gap and every font scale. `flex: 1` also implies
 * `flexBasis: 0`, so the columns are exactly equal however long a label renders — the
 * percentage version was equal only by rounding luck, and drifted as soon as one label
 * wrapped and another did not.
 *
 * A short final row is padded with invisible spacers rather than allowed to stretch. Five
 * tiles in a two-column grid means the fifth keeps its half of the row; a fifth tile
 * silently becoming full-width is a layout change nobody asked for.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type BigButtonItem = {
  key: string;
  /** Already translated by the caller. */
  label: string;
  /** Optional second line — last value, or when it was last recorded. */
  sublabel?: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
};

export type BigButtonGridProps = {
  items: readonly BigButtonItem[];
  /** Two columns is the design; one column exists for very narrow displays. */
  columns?: 1 | 2;
  minTileHeight?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const DEFAULT_MIN_TILE_HEIGHT = 120;

/** The gutter, used in BOTH directions so the grid is square. */
const GRID_GAP = spacing.md;

export function BigButtonGrid({
  items,
  columns = 2,
  minTileHeight = DEFAULT_MIN_TILE_HEIGHT,
  style,
  testID,
}: BigButtonGridProps) {
  const { colors } = useTheme();

  // Chunked here rather than in a `useMemo`: the work is one pass over at most a handful
  // of items, and a memo keyed on an array prop that most callers rebuild every render
  // would cost more than it saves.
  const rows: BigButtonItem[][] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns));
  }

  return (
    <View testID={testID} style={[{ gap: GRID_GAP }, style]}>
      {rows.map((row) => (
        <View
          key={row.map((item) => item.key).join('-')}
          style={{ flexDirection: 'row', gap: GRID_GAP }}
        >
          {row.map((item) => (
            <PressableScale
              key={item.key}
              onPress={item.onPress}
              disabled={item.disabled}
              accessibilityRole="button"
              accessibilityLabel={item.sublabel ? `${item.label}. ${item.sublabel}` : item.label}
              accessibilityHint={item.accessibilityHint}
              accessibilityState={{ disabled: Boolean(item.disabled) }}
              style={{
                // Equal halves by construction. See the header: no percentage, no wrap,
                // no decision.
                flex: 1,
                minHeight: minTileHeight,
                padding: spacing.lg,
                borderRadius: radii.lg,
                borderWidth: 2,
                borderColor: colors.borderStrong,
                backgroundColor: colors.bgElevated,
                justifyContent: 'space-between',
                gap: spacing.sm,
                opacity: item.disabled ? 0.55 : 1,
              }}
            >
              {item.icon ? <Icon name={item.icon} size={32} color={colors.primary} /> : null}
              <View style={{ gap: spacing.xs }}>
                <Text variant="label">{item.label}</Text>
                {item.sublabel ? (
                  <Text variant="caption" tone="muted" numberOfLines={2}>
                    {item.sublabel}
                  </Text>
                ) : null}
              </View>
            </PressableScale>
          ))}

          {/* Spacers for a short final row. `accessibilityElementsHidden` keeps TalkBack
              from stopping on an empty box between the last tile and whatever follows. */}
          {Array.from({ length: columns - row.length }, (_, spacer) => (
            <View
              key={`spacer-${spacer}`}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ flex: 1 }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export default BigButtonGrid;
