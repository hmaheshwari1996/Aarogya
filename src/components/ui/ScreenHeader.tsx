/**
 * Screen title bar.
 *
 * The back control is a labelled 56dp target, not a bare 24dp chevron. A chevron alone
 * is both too small to hit with a tremor and meaningless to a user who has never learned
 * the convention, so the word "Back" sits next to it.
 *
 * `onBack` is passed in rather than calling `router.back()` internally: this is a UI
 * primitive and must not depend on the router, and several screens need to intercept
 * the gesture to ask "leave without saving?".
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ScreenHeaderProps = {
  title: string;
  subtitle?: string;
  /** Renders the back control when supplied. */
  onBack?: () => void;
  backLabel?: string;
  /** Trailing slot — usually a ghost Button or an icon control. */
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  right,
  style,
}: ScreenHeaderProps) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <View style={[{ paddingTop: spacing.md, paddingBottom: spacing.lg, gap: spacing.sm }, style]}>
      {onBack ? (
        <PressableScale
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={backLabel ?? t('a11y.back')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.xs,
            minHeight: spacing.touchTarget,
            paddingRight: spacing.md,
            borderRadius: radii.md,
            alignSelf: 'flex-start',
          }}
        >
          <Icon name="chevronLeft" size={28} color={colors.primary} />
          <Text variant="label" tone="primary">
            {backLabel ?? t('common.back')}
          </Text>
        </PressableScale>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ flex: 1, gap: spacing.xs }}>
          {/* `header` role makes this a TalkBack navigation landmark, so the user can
              jump between screens' titles instead of swiping through every control. */}
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="body" tone="muted">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ? <View>{right}</View> : null}
      </View>
    </View>
  );
}

export default ScreenHeader;
