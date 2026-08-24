/**
 * Loading placeholder.
 *
 * DELIBERATELY BUILT ON RN `Animated`, NOT REANIMATED. Reanimated needs its babel plugin
 * to be present and last in the plugin list; when that goes wrong the failure mode is a
 * runtime throw inside the worklet, which would take out the loading state — the very
 * first thing rendered on a cold start. A pulse is not worth a class of crash that can
 * only be reproduced after a dependency bump. `Animated` with `useNativeDriver` needs no
 * build configuration at all and animates off the JS thread just the same.
 *
 * Skeletons are hidden from TalkBack by default: a screen reader user gains nothing from
 * "grey rectangle" repeated six times. Pass `label` on the outermost skeleton of a screen
 * to announce the load instead.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { radii } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

export type SkeletonProps = {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  /** When set, the placeholder is announced instead of hidden. Already translated. */
  label?: string;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({
  width = '100%',
  height = 20,
  radius = radii.sm,
  label,
  style,
}: SkeletonProps) {
  const { colors } = useTheme();
  /**
   * Still RN `Animated` (see the header) — only where the value LIVES has changed. A ref
   * is the wrong home for it: `animatedStyle` reads it during render, and reading a ref
   * during render is what React's ref rules forbid. Lazily-initialised state gives the
   * same guarantee a ref was being used for — one value, created once, stable identity for
   * the life of the component, which the running loop below depends on — without the
   * render-time read, and without re-constructing an Animated.Value on every render the
   * way `useRef(new Animated.Value(0))` quietly did. The setter is never called.
   */
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    // Stopped explicitly on unmount: a looping animation left running keeps the
    // native driver awake behind a screen the user has already left.
    return () => animation.stop();
  }, [pulse]);

  const animatedStyle = useMemo(
    () => ({
      opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.85] }),
    }),
    [pulse],
  );

  const a11yProps: {
    accessible?: boolean;
    accessibilityRole?: 'progressbar';
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: 'no-hide-descendants';
  } = label
    ? { accessible: true, accessibilityRole: 'progressbar', accessibilityLabel: label }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };

  return (
    <Animated.View
      {...a11yProps}
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.bgSunken },
        animatedStyle,
        style,
      ]}
    />
  );
}

export default Skeleton;
