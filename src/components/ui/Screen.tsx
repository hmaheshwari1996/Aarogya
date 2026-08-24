/**
 * Safe-area screen wrapper.
 *
 * `scroll` is the default because large text plus a 1.25× multiplier means almost any
 * screen can overflow on a small device, and content silently cut off at the bottom is
 * how a user misses the Save button entirely. A screen only opts into `fixed` when it
 * manages its own scrolling (a FlatList) or must not scroll at all (the number pad).
 *
 * `footer` renders outside the scroll area and above the bottom inset — a primary action
 * pinned there is always reachable without scrolling, which is the whole point.
 *
 * THE BOTTOM INSET IS ADDED TO THE PADDING, NEVER max()'d WITH IT. This is the bug that
 * cut the setup wizard's Skip/Next in half on a Xiaomi running MIUI: `Math.max(inset, md)`
 * spends the entire gesture-bar clearance AS the footer's breathing room, so on any phone
 * whose inset is at least `spacing.md` the buttons' bottom border lands exactly on the
 * gesture bar — and MIUI draws its gesture hint a few dp taller than the inset it reports,
 * so "exactly on" reads as "underneath". The two numbers answer different questions:
 * `insets.bottom` is how much of the screen the system has taken, `spacing.md` is how far
 * a control should sit from the edge of the thing it is inside. Both are owed.
 *
 * A screen with NO footer needs the same clearance on its scroll content, for the same
 * reason — the app is edge-to-edge (Expo SDK 54 default, and mandatory at targetSdk 35+),
 * so the window extends behind the navigation bar whether or not anything is pinned there.
 */

import React, { useContext } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';
// Declared in package.json rather than relied on transitively through expo-router.
// Importing from an undeclared package is what caused the Trends crash: a peer that is
// present today and gone after an unrelated dependency bump, with nothing to warn you.
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

export type ScreenProps = {
  children: React.ReactNode;
  variant?: 'scroll' | 'fixed';
  /** Horizontal padding on the content. Set false for edge-to-edge lists. */
  padded?: boolean;
  /** Pinned below the scroll area, above the bottom safe-area inset. */
  footer?: React.ReactNode;
  /** `bgSunken` suits screens made of cards; `bg` suits plain content. */
  background?: 'bg' | 'bgSunken' | 'bgElevated';
  edges?: readonly Edge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Screen({
  children,
  variant = 'scroll',
  padded = true,
  footer,
  background = 'bg',
  edges = ['top', 'left', 'right'],
  contentContainerStyle,
  style,
  testID,
}: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const backgroundColor =
    background === 'bgSunken'
      ? colors.bgSunken
      : background === 'bgElevated'
        ? colors.bgElevated
        : colors.bg;

  /**
   * How much of the bottom of the screen the system has taken from THIS screen.
   *
   * Two separate ways it can already be spent, and both have to be subtracted or the
   * clearance is counted twice and shows up as a dead band above the navigation bar:
   *
   *  1. `edges` includes 'bottom' — SafeAreaView has padded it itself.
   *
   *  2. This screen is inside the bottom-tab navigator. The tab bar sits BELOW the
   *     scene (its `tabBarStyle` has no `position: 'absolute'`, so it is not overlaid),
   *     and `(tabs)/_layout.tsx` already folds `insets.bottom` into the bar's own height.
   *     The scene's bottom edge is therefore the top of the tab bar, with no system inset
   *     between them — but `SafeAreaInsetsContext` is NOT overridden per scene by
   *     `BottomTabView`, so `useSafeAreaInsets()` still reports the full 24–48dp here.
   *     Trusting it added a second gesture-bar's worth of padding to all five tab routes.
   *
   * `BottomTabBarHeightContext` is defined only inside a bottom-tab navigator, so its
   * presence is the reliable test for case 2 — reliable in a way that checking the route
   * name or passing a prop from five call sites is not, because it cannot be forgotten
   * when a sixth tab is added.
   */
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const insideTabNavigator = tabBarHeight != null;
  const bottomInset = edges.includes('bottom') || insideTabNavigator ? 0 : insets.bottom;

  const contentPadding: ViewStyle = {
    paddingHorizontal: padded ? spacing.lg : 0,
    // With a footer, the footer is what has to clear the navigation bar and the content
    // stops above it. Without one, the last row of content IS the bottom of the screen.
    paddingBottom: spacing.xl + (footer ? 0 : bottomInset),
  };

  const body =
    variant === 'scroll' ? (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[contentPadding, contentContainerStyle]}
        keyboardShouldPersistTaps="handled"
        // Keeps the scroll indicator visible long enough to be noticed.
        persistentScrollbar
        testID={testID}
      >
        {children}
      </ScrollView>
    ) : (
      <View style={[{ flex: 1 }, contentPadding, contentContainerStyle]} testID={testID}>
        {children}
      </View>
    );

  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor }, style]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // Android resizes the window itself (adjustResize); adding padding on top of
        // that double-counts the keyboard and leaves a dead band above it.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {body}
        {footer ? (
          <View
            style={{
              paddingHorizontal: padded ? spacing.lg : 0,
              paddingTop: spacing.md,
              paddingBottom: bottomInset + spacing.md,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor,
              // The footer sizes to its content and the scroll area above takes what is
              // left. Spelled out because the default is what a two-line button label at
              // 1.25× depends on: the footer must GROW, and must never be the thing that
              // gets squeezed when the content above it is long.
              flexGrow: 0,
              flexShrink: 0,
            }}
          >
            {footer}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default Screen;
