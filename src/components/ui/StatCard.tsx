/**
 * A single recorded value, shown large.
 *
 * ─── OUT-OF-RANGE IS NEVER RED ────────────────────────────────────────────────
 * The value keeps `colors.text` whatever its range. Out-of-range is carried by a HOLLOW
 * RING MARKER drawn in that same colour, plus the words "Above your target".
 *
 * Three reasons, smallest first:
 *   • Roughly 8% of men have red/green deficiency, and the son is a user of this app too.
 *   • OPD printers are monochrome, so a colour-coded value prints as a grey value.
 *   • Most importantly: a red number is a CLINICAL VERDICT, and this app is not permitted
 *     to render one. "Above the range your doctor wrote down on 4 March" is a fact. "Bad"
 *     is a judgement, and a judgement rendered by an app is one a patient acts on without
 *     the doctor who would have qualified it.
 *
 * `range` therefore only ever describes a comparison against a `target_range` row that a
 * named human entered. With no target row the caller passes 'unknown' and the card says
 * so — the app never invents a threshold to compare against.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '@/i18n';
import { spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';

import { Card } from './Card';
import { Icon } from './Icon';
import { Text } from './Text';

export type StatRange = 'in' | 'above' | 'below' | 'unknown';

export type StatCardProps = {
  /** Already translated by the caller. */
  label: string;
  /** Pre-formatted for display — '142/88', '7.4', '62.5'. */
  value: string;
  unit?: string;
  /** Comparison against a target a human recorded. 'unknown' means no target exists. */
  range?: StatRange;
  /** Secondary line — when it was recorded, or the meal context. */
  caption?: string;
  /**
   * Provenance line. Every chart and card that shows a range comparison must name who
   * set the target and when: `t('reading.targetSetBy', { name, date })`.
   */
  footnote?: string;
  onPress?: () => void;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function StatCard({
  label,
  value,
  unit,
  range = 'unknown',
  caption,
  footnote,
  onPress,
  compact = false,
  style,
  testID,
}: StatCardProps) {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const { t } = useI18n();

  const rangeWord =
    range === 'above'
      ? t('reading.aboveRange')
      : range === 'below'
        ? t('reading.belowRange')
        : range === 'in'
          ? t('reading.inRange')
          : t('reading.noTarget');

  const showMarker = range === 'above' || range === 'below';

  /**
   * `footnote` IS IN HERE, AND LEAVING IT OUT WAS A SILENT PROVENANCE FAILURE.
   *
   * The wrapper below is `accessible={!onPress}`, which on Android collapses the whole
   * subtree into ONE node — so every child Text that is not named in this string is
   * unreachable to TalkBack, not merely deprioritised. With `footnote` omitted, a screen
   * reader heard "Blood pressure. 142/88 mmHg. Above your target. 08:30" and never heard
   * "Target set by Dr Sharma on 4 March".
   *
   * That is not a missing nicety. `StatCardProps.footnote` above states the rule this
   * component exists to keep: every range comparison names who set the target and when.
   * Announcing "Above your target" without naming whose target is an UNATTRIBUTED
   * CLINICAL COMPARISON — the exact thing the file header forbids — and it was invisible
   * to any check that reads the screen rather than listening to it.
   *
   * Order matters: …rangeWord, caption, footnote reads as one sentence in both languages.
   */
  const spokenLabel = [label, `${value}${unit ? ` ${unit}` : ''}`, rangeWord, caption, footnote]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={onPress ? spokenLabel : undefined}
      padding={compact ? spacing.md : spacing.lg}
      style={style}
      testID={testID}
    >
      {/* One a11y node for the whole card — a value split across four nodes is read as
          four disconnected fragments. When the Card itself is pressable it already owns
          that node, and nesting a second `accessible` view inside it makes Android
          announce the card twice. */}
      <View accessible={!onPress} accessibilityLabel={spokenLabel} style={{ gap: spacing.sm }}>
        <Text variant="caption" tone="muted" numberOfLines={2}>
          {label}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
          <Text
            style={{
              fontSize: compact ? fontSizes.xxl : fontSizes.hero,
              lineHeight: Math.round((compact ? fontSizes.xxl : fontSizes.hero) * 1.15),
              fontWeight: '700',
              // Unchanged by range, on purpose. See the header comment.
              color: colors.text,
            }}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {value}
          </Text>
          {unit ? (
            <Text
              tone="muted"
              style={{
                fontSize: fontSizes.xs,
                lineHeight: Math.round(fontSizes.xs * 1.5),
                paddingBottom: spacing.xs,
              }}
            >
              {unit}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {showMarker ? (
            <Icon
              name={range === 'above' ? 'rangeAbove' : 'rangeBelow'}
              size={22}
              // Same colour as the value: a marker, not a warning light.
              color={colors.text}
              strokeWidth={2}
            />
          ) : null}
          <Text variant="caption" tone="muted" style={{ flexShrink: 1 }}>
            {rangeWord}
          </Text>
        </View>

        {caption ? (
          <Text variant="caption" tone="muted">
            {caption}
          </Text>
        ) : null}

        {footnote ? (
          <Text variant="caption" tone="muted" style={{ fontSize: fontSizes.xs }}>
            {footnote}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

export default StatCard;
