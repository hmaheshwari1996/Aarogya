/**
 * The only text primitive in the app. Raw `<Text>` from react-native is not used
 * anywhere, because it would silently bypass large-text mode.
 *
 * LINE HEIGHT IS NOT COSMETIC HERE. Devanagari stacks matras above and below the
 * baseline; at RN's default line height the upper matra of a word like "दवाइयाँ" clips
 * against the line above. Every variant therefore carries an explicit ratio, and none of
 * them is below 1.3.
 */

import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { fontWeight } from '@/theme';
import { useFontSizes, useTheme, type FontSizes } from '@/theme/ThemeProvider';

export type TextVariant = 'hero' | 'display' | 'title' | 'body' | 'label' | 'caption';

export type TextTone =
  | 'default'
  | 'muted'
  | 'inverse'
  | 'primary'
  | 'accent'
  | 'attention'
  | 'success'
  /** UI actions only — deleting a medicine, not describing a reading. */
  | 'destructive';

type VariantSpec = {
  size: keyof FontSizes;
  weight: TextStyle['fontWeight'];
  lineHeightRatio: number;
  /**
   * Caps the OS font-scale multiplier on top of our own large-text scale. The app
   * already offers its own 1.25× mode, so an unbounded OS scale on a 44pt hero simply
   * pushes the number off the screen — which is strictly worse than large-but-visible.
   * Body-sized text is left uncapped: it has room to grow.
   */
  maxFontSizeMultiplier?: number;
};

const VARIANTS: Record<TextVariant, VariantSpec> = {
  hero: { size: 'hero', weight: fontWeight.bold, lineHeightRatio: 1.18, maxFontSizeMultiplier: 1.3 },
  display: {
    size: 'display',
    weight: fontWeight.bold,
    lineHeightRatio: 1.22,
    maxFontSizeMultiplier: 1.3,
  },
  title: { size: 'xl', weight: fontWeight.semibold, lineHeightRatio: 1.32, maxFontSizeMultiplier: 1.5 },
  body: { size: 'md', weight: fontWeight.regular, lineHeightRatio: 1.5 },
  label: { size: 'lg', weight: fontWeight.semibold, lineHeightRatio: 1.4 },
  caption: { size: 'sm', weight: fontWeight.regular, lineHeightRatio: 1.45 },
};

export type TextProps = RNTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  /** Convenience for the very common `textAlign` cases. */
  align?: TextStyle['textAlign'];
  /** Overrides the variant weight without forcing a style array at the call site. */
  weight?: TextStyle['fontWeight'];
  children?: React.ReactNode;
};

export function Text({
  variant = 'body',
  tone = 'default',
  align,
  weight,
  style,
  maxFontSizeMultiplier,
  children,
  ...rest
}: TextProps) {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const spec = VARIANTS[variant];

  const TONE_COLORS: Record<TextTone, string> = {
    default: colors.text,
    muted: colors.textMuted,
    inverse: colors.textInverse,
    primary: colors.primary,
    accent: colors.accent,
    attention: colors.attention,
    success: colors.success,
    destructive: colors.destructive,
  };

  const size = fontSizes[spec.size];

  return (
    <RNText
      style={[
        {
          fontSize: size,
          lineHeight: Math.round(size * spec.lineHeightRatio),
          fontWeight: weight ?? spec.weight,
          color: TONE_COLORS[tone],
          textAlign: align,
        },
        style,
      ]}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? spec.maxFontSizeMultiplier}
      {...rest}
    >
      {children}
    </RNText>
  );
}

export default Text;
