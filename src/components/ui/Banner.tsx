/**
 * A persistent inline notice.
 *
 * The `attention` variant is what the reminder-delivery warning uses — "some reminders
 * did not arrive". Note the token it draws on: `colors.attention`, which the theme header
 * describes as neutral emphasis. It is deliberately NOT `destructive`. The app is telling
 * the user that ITS OWN delivery failed; that is an app problem, and dressing it in the
 * same red used for "delete this medicine" trains her to ignore both.
 *
 * A banner never auto-dismisses. The condition it describes is still true.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type BannerVariant = 'info' | 'attention';

export type BannerProps = {
  variant?: BannerVariant;
  /** Already translated by the caller. */
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Renders a dismiss control. Omit for conditions the user cannot clear. */
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Banner({
  variant = 'info',
  title,
  message,
  actionLabel,
  onAction,
  onDismiss,
  style,
  testID,
}: BannerProps) {
  const { colors } = useTheme();
  const { t } = useI18n();

  const isAttention = variant === 'attention';
  const accent = isAttention ? colors.attention : colors.primary;
  const background = isAttention ? colors.attentionSoft : colors.primarySoft;

  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          gap: spacing.md,
          padding: spacing.lg,
          borderRadius: radii.lg,
          borderWidth: 2,
          borderColor: accent,
          backgroundColor: background,
        },
        style,
      ]}
    >
      {/* Icon differs by variant, so the two are separable without colour. */}
      <Icon name={isAttention ? 'alert' : 'info'} size={26} color={accent} />

      <View style={{ flex: 1, gap: spacing.sm }}>
        {/* The TEXT is grouped into one announcement, but the action and the dismiss
            control stay outside it. `accessible` on a container hides its descendants
            from TalkBack on Android, so wrapping the whole banner would make the
            "Fix this" button unreachable by a screen reader. */}
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={message ? `${title}. ${message}` : title}
          style={{ gap: spacing.sm }}
        >
          <Text variant="label">{title}</Text>
          {message ? <Text variant="body">{message}</Text> : null}
        </View>
        {actionLabel && onAction ? (
          <Button
            title={actionLabel}
            onPress={onAction}
            variant="secondary"
            size="md"
            style={{ marginTop: spacing.xs }}
          />
        ) : null}
      </View>

      {onDismiss ? (
        <PressableScale
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.dismissMessage')}
          style={{
            width: spacing.touchTarget,
            height: spacing.touchTarget,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: -spacing.sm,
            marginRight: -spacing.sm,
          }}
        >
          <Icon name="close" size={24} color={colors.textMuted} />
        </PressableScale>
      ) : null}
    </View>
  );
}

export default Banner;
