/**
 * A tiny stroked icon set drawn with react-native-svg.
 *
 * WHY NOT AN ICON FONT: the project has no icon package, and adding one for nine glyphs
 * costs a font file, a load race on first paint (an unloaded icon font renders tofu, and
 * a tofu box next to a blood pressure value is worse than no icon) and a second theming
 * mechanism. Stroked paths inherit `colors.*` directly and are always present.
 *
 * Icons are DECORATIVE by default and are hidden from TalkBack — every icon in this app
 * sits next to a real word, because meaning is never carried by a symbol alone, exactly
 * as it is never carried by a colour alone.
 */

import React from 'react';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '@/theme/ThemeProvider';

/** All paths are authored on a 24×24 grid. */
const ICON_PATHS = {
  chevronLeft: ['M15 5 L8 12 L15 19'],
  chevronRight: ['M9 5 L16 12 L9 19'],
  chevronDown: ['M5 9 L12 16 L19 9'],
  check: ['M4 12.5 L9.5 18 L20 6'],
  close: ['M5 5 L19 19', 'M19 5 L5 19'],
  plus: ['M12 5 V19', 'M5 12 H19'],
  minus: ['M5 12 H19'],
  /** Triangle plus bang. The dot is a zero-length round-capped stroke. */
  alert: ['M12 3 L22.5 20.5 H1.5 Z', 'M12 9.5 V14.5', 'M12 17.6 V17.7'],
  info: ['M12 2.5 A9.5 9.5 0 1 0 12 21.5 A9.5 9.5 0 1 0 12 2.5', 'M12 11 V17', 'M12 7.3 V7.4'],
  clock: ['M12 2.5 A9.5 9.5 0 1 0 12 21.5 A9.5 9.5 0 1 0 12 2.5', 'M12 6.5 V12 L16 14.5'],
  /**
   * Out-of-range markers. A HOLLOW ring with a direction arrow, drawn in the SAME colour
   * as the value it sits beside — never red, never filled. An out-of-range reading is a
   * fact about a target the user's own doctor set, not a verdict this app is allowed to
   * render, and it has to survive a monochrome OPD printer and red/green colour deficiency.
   */
  rangeAbove: [
    'M12 2.5 A9.5 9.5 0 1 0 12 21.5 A9.5 9.5 0 1 0 12 2.5',
    'M12 16.5 V8',
    'M8.5 11.5 L12 8 L15.5 11.5',
  ],
  rangeBelow: [
    'M12 2.5 A9.5 9.5 0 1 0 12 21.5 A9.5 9.5 0 1 0 12 2.5',
    'M12 7.5 V16',
    'M8.5 12.5 L12 16 L15.5 12.5',
  ],
} as const;

export type IconName = keyof typeof ICON_PATHS;

export type IconProps = {
  name: IconName;
  /** Rendered box in dp. Deliberately not tied to the font scale — icons are landmarks. */
  size?: number;
  /** Defaults to `colors.text`. Pass a theme token, never a literal. */
  color?: string;
  strokeWidth?: number;
};

export function Icon({ name, size = 24, color, strokeWidth = 2.2 }: IconProps) {
  const { colors } = useTheme();
  const stroke = color ?? colors.text;
  const paths = ICON_PATHS[name];

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false} pointerEvents="none">
      {paths.map((d) => (
        <Path
          key={d}
          d={d}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  );
}

export default Icon;
