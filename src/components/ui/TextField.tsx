/**
 * Labelled text input.
 *
 * The label is a full `label` variant (20sp, semibold) sitting above the field, never a
 * placeholder. A placeholder-as-label disappears the moment typing starts, which is
 * exactly when a user who has paused to think most needs to be told what she is filling in.
 *
 * The error state is spelled out in words with a warning icon, not signalled by a red
 * outline. Note that `colors.destructive` here describes a UI validation failure — a
 * field that has not been filled in — and never a clinical value.
 */

import React, { forwardRef, useState } from 'react';
import {
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';

import { Icon } from './Icon';
import { Text } from './Text';

export type TextFieldProps = Omit<TextInputProps, 'style'> & {
  /** Already translated by the caller. */
  label: string;
  /** Shown below the field when there is no error. */
  helper?: string;
  /** Non-empty puts the field into its error state. Already translated. */
  error?: string;
  required?: boolean;
  /** Grows the input into a multi-line note box. */
  multiline?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<ViewStyle>;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    helper,
    error,
    required = false,
    multiline = false,
    containerStyle,
    inputStyle,
    onFocus,
    onBlur,
    accessibilityLabel,
    accessibilityHint,
    ...rest
  },
  ref,
) {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);

  const hasError = Boolean(error);
  const borderColor = hasError
    ? colors.destructive
    : focused
      ? colors.primary
      : colors.borderStrong;

  return (
    <View style={[{ gap: spacing.sm }, containerStyle]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text variant="label">{label}</Text>
        {required ? (
          <Text variant="caption" tone="muted">
            {t('common.required')}
          </Text>
        ) : null}
      </View>

      <TextInput
        ref={ref}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        multiline={multiline}
        placeholderTextColor={colors.textMuted}
        // The label is not a sibling TalkBack would read automatically, so it is
        // attached explicitly, along with the error as the hint.
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint ?? error ?? helper}
        accessibilityState={{ disabled: rest.editable === false }}
        style={[
          {
            minHeight: multiline ? spacing.touchTarget * 2 : spacing.touchTarget,
            borderWidth: focused || hasError ? 3 : 2,
            borderColor,
            borderRadius: radii.md,
            backgroundColor: rest.editable === false ? colors.bgSunken : colors.bgElevated,
            color: colors.text,
            fontSize: fontSizes.lg,
            lineHeight: Math.round(fontSizes.lg * 1.4),
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.md,
            textAlignVertical: multiline ? 'top' : 'center',
          },
          inputStyle,
        ]}
        {...rest}
      />

      {hasError ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Icon name="alert" size={20} color={colors.destructive} />
          <Text variant="caption" tone="destructive" style={{ flexShrink: 1 }}>
            {error}
          </Text>
        </View>
      ) : helper ? (
        <Text variant="caption" tone="muted">
          {helper}
        </Text>
      ) : null}
    </View>
  );
});

export default TextField;
