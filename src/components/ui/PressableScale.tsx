/**
 * A Pressable that dips slightly while held.
 *
 * Two reasons this exists rather than relying on opacity:
 *  • The primary user has a tremor. A press that produces no immediate physical-feeling
 *    response invites a second press, and a second press on "Save" is a duplicate row.
 *    Scale reads as depression even when the finger covers most of the control.
 *  • It runs on the native driver, so the feedback survives a JS thread busy writing to
 *    SQLite — which is precisely the moment feedback matters most.
 *
 * Deliberately built on RN `Animated` rather than reanimated: a misconfigured babel
 * plugin must never be able to take out a press interaction.
 *
 * ─── ONE NODE. NEVER WRAP THE PRESSABLE IN AN Animated.View AGAIN ────────────────────
 * This component used to render `<Animated.View style={{transform}}><Pressable
 * style={style}/></Animated.View>`, and that shape silently ate every layout style any
 * caller ever passed. It is worth spelling out why, because the symptom looks nothing
 * like the cause and it shipped twice.
 *
 * The caller writes `style={{ flexBasis: '47%', flexGrow: 1 }}` and expects a tile that
 * is half a row wide. Two separate things then go wrong:
 *
 *  1. THE FLEX CHILD OF THE CALLER'S ROW IS THE WRAPPER, NOT THE PRESSABLE. The wrapper
 *     declared no flex properties at all, and Yoga's defaults are `flexGrow: 0` AND
 *     `flexShrink: 0` — RN's shrink default is 0, not the web's 1. So the wrapper took
 *     max-content width and could neither grow nor shrink. Four tiles that each measure
 *     wider than half the row therefore wrap onto four lines. That is exactly the "align
 *     dashboard card 2 in a row" report: not slightly-wrong widths, a single column.
 *  2. THE PERCENTAGE LANDED ON THE WRONG AXIS. `Animated.View` is a `flexDirection:
 *     'column'` box, so `flexBasis: '47%'` on the inner Pressable resolved against the
 *     COLUMN main axis — it meant HEIGHT — and since the wrapper's own height was auto,
 *     the percentage had no definite basis to resolve against and degraded to `auto`.
 *
 * The same pair broke the number pad (`flex: 1` on a digit key became `flexBasis: 0` on
 * its height, collapsing a 56dp key to glyph width), made `Chip`'s `grow` prop a no-op at
 * 42 call sites, and produced the earlier "buttons going out of screen (in footer)"
 * report that `Button.tsx` still carries a compensating wrapper View for.
 *
 * Rendering ONE node — an animated Pressable — is what fixes all of it: the caller's
 * style is on the element that is actually the flex child, so it means what it says.
 *
 * Two things about this shape that are not optional:
 *  • `createAnimatedComponent` is called at MODULE scope. It returns a fresh component
 *    type on every call, so calling it inside render would remount the button on each
 *    render and kill the animation mid-press.
 *  • The native driver still applies. `Pressable` forwards its ref to a host View that
 *    already sets `collapsable={false}`, so the animated node resolves to a real native
 *    view and `useNativeDriver: true` on the transform stays off the JS thread — which
 *    is the whole reason this component exists.
 *
 * A welcome side effect: the scale origin is now the button itself. The wrapper used to
 * stretch to the parent's cross size, so an `alignSelf: 'flex-start'` control like the
 * back button in `ScreenHeader` was scaled about a point far to its right and visibly
 * slid sideways on press instead of dipping in place.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { durations } from '@/theme';

/**
 * MODULE SCOPE, DELIBERATELY. See the header: this must be exactly one component type
 * for the life of the app, or every press remounts the button it is animating.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * `style` and `children` are narrowed away from Pressable's function forms. The
 * render-prop variants would fight the scale for who owns the transform, and nothing in
 * this app needs press-state styling that the scale does not already give.
 */
export type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  /** How far it dips. 0.97 is felt but not seen as movement. */
  activeScale?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

export function PressableScale({
  activeScale = 0.97,
  disabled,
  onPressIn,
  onPressOut,
  style,
  children,
  ...rest
}: PressableScaleProps) {
  /**
   * The driver for the dip. Held in lazily-initialised state rather than in a ref for two
   * reasons, and neither is a style preference:
   *
   *  • It is READ DURING RENDER (`composedStyle` below feeds it to the animated node), and
   *    a ref read during render is the thing React's ref rules exist to stop.
   *  • `useRef(new Animated.Value(1))` constructs a fresh Animated.Value on every single
   *    render and throws all but the first away. The lazy initialiser runs exactly once.
   *
   * The setter is deliberately not destructured: this is a stable per-instance slot, not
   * state that anything ever sets. The identity is guaranteed for the component's life,
   * which is what a running native animation requires.
   */
  const [scale] = useState(() => new Animated.Value(1));

  const animateTo = useCallback(
    (value: number, duration: number) => {
      Animated.timing(scale, {
        toValue: value,
        duration,
        useNativeDriver: true,
      }).start();
    },
    [scale],
  );

  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (event) => {
      if (!disabled) animateTo(activeScale, durations.fast);
      onPressIn?.(event);
    },
    [animateTo, activeScale, disabled, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (event) => {
      animateTo(1, durations.normal);
      onPressOut?.(event);
    },
    [animateTo, onPressOut],
  );

  /**
   * The caller's style and the dip now share one node, so they also share one `transform`
   * key — and a plain `style={[style, { transform: [{ scale }] }]}` would let ours
   * overwrite theirs. Last-wins on a whole property is the kind of loss nobody notices
   * until a rotated control stops being rotated, so the two are COMPOSED instead: the
   * caller's entries first, our scale last, so the dip is applied to whatever they built.
   *
   * `transform` may also be a string ('scale(2) rotate(45deg)'), which cannot be merged
   * into an array. Rather than drop one of the two without saying so, we keep the
   * caller's — theirs affects what the screen looks like, ours is only feedback — and
   * complain in development. No call site does this today.
   */
  const composedStyle = useMemo(() => {
    const flat = StyleSheet.flatten(style);
    const callerTransform = flat?.transform;

    if (typeof callerTransform === 'string') {
      if (__DEV__) {
        console.warn(
          '[PressableScale] `transform` was given as a string, which cannot be composed ' +
            'with the press animation. The press dip is disabled for this control. Pass ' +
            'the array form (e.g. [{ rotate: "45deg" }]) to keep both.',
        );
      }
      return flat;
    }

    return {
      ...flat,
      transform: callerTransform ? [...callerTransform, { scale }] : [{ scale }],
    };
  }, [style, scale]);

  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={composedStyle}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

export default PressableScale;
