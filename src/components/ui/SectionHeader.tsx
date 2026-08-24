/**
 * A heading between groups of content.
 *
 * The title carries `accessibilityRole="header"`, which is what lets a TalkBack user
 * jump between sections with a single gesture instead of swiping through every row of
 * the medicine list to reach the one below it.
 *
 * ─── THIS COMPONENT'S HEIGHT IS ITS CONTENT'S HEIGHT ─────────────────────────
 * It has no intrinsic height and it must never be given one. Two lines of text whose
 * point size is multiplied by the app's 1.25× large-text mode AND again by whatever the
 * OS font scale is set to cannot be predicted by a constant, and a caller that writes
 * one down is writing down a number that is right on the machine it was measured on.
 *
 * That is not hypothetical. The medicine list used to draw this inside
 * `<View style={{ height: 76, justifyContent: 'center' }}>`, sized against English at
 * base scale. On a phone whose system font is one notch above default, the real content
 * is ~86dp: Yoga centred it, let it overflow 5dp above and below its box — RN's default
 * is `overflow: 'visible'` — and the next list row, an opaque card, painted straight
 * over the bottom half of the subtitle. The bug reads as "the text is cut in half and
 * something is floating on top of it", which is what an overlap always looks like.
 *
 * So the root shrinks and clips. If some future caller does constrain the height,
 * `flexShrink: 1` lets Yoga compress this box to the space it was given instead of
 * spilling out of it, and `overflow: 'hidden'` clips whatever no longer fits. Both are
 * inert when nobody constrains it — there is no negative free space to shrink into and
 * nothing outside the bounds to clip — so the normal case is unchanged. What they buy
 * is the failure mode: truncated text that is visibly missing beats text that is drawn
 * over the row below it and silently unreadable.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing } from '@/theme';

import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type SectionHeaderProps = {
  /** Already translated by the caller. */
  title: string;
  subtitle?: string;
  /** Trailing text action — "See all". */
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function SectionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
  style,
}: SectionHeaderProps) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: spacing.md,
          paddingTop: spacing.lg,
          paddingBottom: spacing.sm,
          // See the header of this file: these two turn "a caller constrained me" from
          // an overlap into a truncation. They do nothing at all when it did not.
          flexShrink: 1,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="label" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {actionLabel && onAction ? (
        <PressableScale
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={{
            // 56 in BOTH directions. The minimum height was already here; a short label
            // in either language ("Show", "दिखाएँ") can still leave the box narrower
            // than the finger that has to hit it.
            minHeight: spacing.touchTarget,
            minWidth: spacing.touchTarget,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing.sm,
          }}
        >
          <Text variant="body" tone="primary" weight="600">
            {actionLabel}
          </Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

export default SectionHeader;
