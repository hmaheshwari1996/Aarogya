/**
 * What a list shows before it has anything in it.
 *
 * The message always says what will make the emptiness end ("Once you record a reading
 * it will appear here"), never just "No data". A user who is not sure whether the app is
 * broken or simply new will stop using it, and this screen is the difference.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type EmptyStateProps = {
  /** Already translated by the caller. */
  title: string;
  message?: string;
  icon?: IconName;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function EmptyState({
  title,
  message,
  icon = 'info',
  actionLabel,
  onAction,
  style,
  testID,
}: EmptyStateProps) {
  const { colors } = useTheme();

  return (
    <View
      testID={testID}
      style={[
        {
          alignItems: 'center',
          gap: spacing.md,
          paddingVertical: spacing.xxl,
          paddingHorizontal: spacing.lg,
        },
        style,
      ]}
    >
      <Icon name={icon} size={44} color={colors.textMuted} strokeWidth={1.8} />

      {/* Title and message read as one announcement; the action stays separately focusable. */}
      <View accessible accessibilityLabel={message ? `${title}. ${message}` : title} style={{ gap: spacing.sm }}>
        <Text variant="label" align="center">
          {title}
        </Text>
        {message ? (
          <Text variant="body" tone="muted" align="center">
            {message}
          </Text>
        ) : null}
      </View>

      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} variant="primary" size="lg" />
      ) : null}
    </View>
  );
}

export default EmptyState;
