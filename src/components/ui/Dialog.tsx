/**
 * Themed modal.
 *
 * The header uses surface tokens (`bgSunken` + a border) rather than a brand-coloured
 * bar. A saturated header competes with the content for attention, and the content of a
 * dialog in this app is usually the thing that must be read most carefully.
 *
 * `dismissOnBackdrop` defaults to true, but every dialog that gates a database write
 * turns it off — see ReadBackDialog. A stray tap outside must never be able to resolve a
 * confirmation.
 */

import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Text } from './Text';

export type DialogProps = {
  visible: boolean;
  /** Already translated by the caller. */
  title?: string;
  message?: string;
  children?: React.ReactNode;
  /** Action row. When omitted and `onRequestClose` is set, a Close button is rendered. */
  footer?: React.ReactNode;
  onRequestClose?: () => void;
  dismissOnBackdrop?: boolean;
  /** Long bodies scroll rather than overflowing — relevant in large-text mode. */
  scrollable?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Dialog({
  visible,
  title,
  message,
  children,
  footer,
  onRequestClose,
  dismissOnBackdrop = true,
  scrollable = true,
  contentStyle,
  testID,
}: DialogProps) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { height } = useWindowDimensions();

  const body = (
    <View style={[{ padding: spacing.lg, gap: spacing.md }, contentStyle]}>
      {message ? <Text variant="body">{message}</Text> : null}
      {children}
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's hardware back must be handled or the dialog becomes a trap.
      onRequestClose={onRequestClose}
      statusBarTranslucent
      testID={testID}
    >
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: 'center' }}>
        <Pressable
          // Covers the backdrop only; the card below sits on top of it.
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          onPress={dismissOnBackdrop ? onRequestClose : undefined}
          accessible={false}
          importantForAccessibility="no"
        />

        <View
          accessibilityViewIsModal
          style={{
            marginHorizontal: spacing.lg,
            maxHeight: height * 0.85,
            backgroundColor: colors.bgElevated,
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          {title ? (
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.lg,
                backgroundColor: colors.bgSunken,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Text variant="title" accessibilityRole="header">
                {title}
              </Text>
            </View>
          ) : null}

          {scrollable ? (
            <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView>
          ) : (
            body
          )}

          {footer ? (
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingBottom: spacing.lg,
                paddingTop: spacing.sm,
                gap: spacing.md,
              }}
            >
              {footer}
            </View>
          ) : onRequestClose ? (
            <View style={{ padding: spacing.lg, paddingTop: spacing.sm }}>
              <Button
                title={t('common.close')}
                onPress={onRequestClose}
                variant="secondary"
                size="md"
                fullWidth
              />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

export default Dialog;
