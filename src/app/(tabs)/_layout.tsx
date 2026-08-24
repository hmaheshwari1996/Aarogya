/**
 * The four tabs: Today · Trends · Medicines · More.
 *
 * ─── WHY THE TAB BAR IS SO TALL, AND WHY IT MEASURES ITSELF ──────────────────
 * The default React Navigation tab bar is 49–56dp with a 10sp label. On this app's
 * floor — presbyopia plus a tremor — a 10sp label is unreadable and a 49dp strip split
 * four ways gives each target about 90×49dp with no margin for a shaking finger landing
 * between two of them. So the bar is sized from its own contents: the active pill, the
 * padding React Navigation puts around it, and the real line height of a label riding
 * BOTH the app's large-text scale and the OS font scale. Every one of those is read from
 * a live value or a named constant — there is no magic total anywhere in this file, and
 * the sum is written out above `barHeight` so the next change can be checked against it.
 *
 * THE BOTTOM INSET IS ADDED ON TOP, and that is a fix rather than a detail. Setting a
 * numeric `height` in `tabBarStyle` replaces React Navigation's computed height — but
 * NOT the `paddingBottom: insets.bottom` it also applies. A fixed 84 on a handset with
 * a 24–48dp gesture bar therefore left 36–60dp of usable bar, which is smaller than the
 * default this code was written to replace. The inset is now part of the sum.
 *
 * ─── THE ACTIVE TAB IS FILLED, NOT MERELY TINTED ─────────────────────────────
 * A colour change alone is the one signal this user cannot rely on: it is the exact
 * distinction lost to a yellowing lens, to red/green deficiency, and to a phone held at
 * arm's length in daylight. The current tab is therefore a FILLED pill with a 2dp edge,
 * a heavier glyph stroke, and a bolder label — four cues, only one of which is colour.
 *
 * The glyphs are drawn here rather than added to `@/components/ui/Icon`, because they
 * are navigation chrome that exists in exactly one place and nowhere else in the app
 * needs a pill or a bar-chart mark.
 *
 * ─── WHY THE PILL USED TO SIT ON TOP OF THE WORD, AND WHY IT NOW CANNOT ───────
 * React Navigation reserves a FIXED 31×28dp box for whatever `tabBarIcon` returns
 * (`wrapperUikit`, @react-navigation/bottom-tabs/src/views/TabBarIcon.tsx) and lays the
 * label out as the NEXT CHILD of a `flexDirection: 'column'`, `justifyContent:
 * 'flex-start'` Pressable (`tabVerticalUiKit`, BottomTabItem.tsx). A 42dp pill dropped
 * into a 28dp box is centred and overhangs 7dp above and 7dp below it, and the item
 * wrapper sets `overflow: 'visible'` — so the bottom 7dp is painted straight over the
 * top of the word. That was the reported "menu icon circle overlapping text".
 *
 * No `tabBarStyle` height arithmetic can reach it: the overlap happens INSIDE the tab
 * item, and the bar's height only decides how much room the items get. Nor does
 * `tabBarShowLabel: false` plus a hand-rolled label inside `tabBarIcon` — that puts a
 * ~68dp subtree inside the same 28dp centred box and makes it overhang UPWARD through
 * the bar's top border as well.
 *
 * The fix is `tabBarIconStyle`, which is merged AFTER `wrapperUikit` and so resizes the
 * reserved box itself. The pill is then drawn at width/height '100%' of that box, which
 * is what makes the property structural rather than arithmetical: the pill is the size
 * of its box by construction and cannot overhang it whatever these constants become.
 * The label lays out below a box that is honestly 42dp tall. React Navigation keeps
 * ownership of the label, so `role="tab"` / `aria-selected` / `aria-label` — and hence
 * TalkBack announcing "Today, selected, tab" — are untouched.
 */

import React from 'react';
import { View, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';

import { fontWeight, radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui';
import { useT, type LocalStrings } from '../_shared/lib';

/**
 * `nav.today` and `nav.medicines` come from the shared bundles; these two are local
 * because nothing else in the app names them.
 *
 * MORE IS 'अधिक', NOT 'और'. It was 'और', which is this app's own word for the conjunction
 * "and" (`common.and` in hi.json is literally "और"). A bar reading आज · रुझान · दवाइयाँ ·
 * और presents its fourth item as the word that would JOIN the third to a missing fourth —
 * a dangling conjunction, read at a glance, under a pill, by someone scanning four short
 * words. 'अधिक' is the ordinary Hindi UI word for a More menu and cannot be read as
 * anything else.
 *
 * 'रुझान' for Trends is correct but journalistic; 'बदलाव' (changes) would be plainer for
 * this reader. Left alone deliberately — that is a question for her, not a fix.
 */
const STRINGS: LocalStrings = {
  'nav.trends': { en: 'Trends', hi: 'रुझान' },
  'nav.more': { en: 'More', hi: 'अधिक' },
};

/**
 * All paths authored on the same 24×24 grid as `@/components/ui/Icon`.
 *
 * ─── A GLYPH MUST NOT BE READABLE AS TEXT ────────────────────────────────────
 * These are drawn from strokes, and a stroke that touches nothing else is not read as
 * part of a picture — it is read as a character. The Medicines mark learnt this the
 * expensive way: an upright capsule with a bar across its waist plus a detached vertical
 * stroke under a detached dot spelled "θi" on a real phone, and a tab that spells a word
 * is worse than a tab with no icon at all, because she trusts what she reads.
 *
 * So the rule these four now hold to: every element either touches another element or is
 * part of a mark whose whole is unmistakably a picture. Nothing floats alone.
 */
const TODAY_GLYPH = ['M3 11 L12 3.5 L21 11', 'M5.5 9.5 V20.5 H18.5 V9.5'];
// The bars start ON the baseline rather than 4 units above it. Floating bars are a
// second reading of the same failure: three unattached vertical strokes are "|||".
const TRENDS_GLYPH = [
  'M3.5 20.5 V4',
  'M3.5 20.5 H21',
  'M7.5 20.5 V12',
  'M12 20.5 V7.5',
  'M16.5 20.5 V10',
];
/**
 * A capsule lying at 45°, split across its short axis — the universal medicine mark.
 *
 * ONE closed object and one chord, not four strokes. The outline is a stadium: a
 * semicircular cap at each end (r=4.2, centres (15.2527, 8.7473) and (8.7473, 15.2527))
 * joined by two straight flanks 6.5 long. The seam is a chord across the waist whose two
 * ends land exactly on the midpoints of those flanks — it is fused into the outline, so
 * there is no bar hanging in space and nothing that can be read on its own.
 *
 * It occupies 2.8–21.2 on both axes, which is the same optical mass as the house and the
 * bar chart; a diagonal shape drawn to the same bounding box as an upright one looks
 * smaller than it is, so it is sized a little past them on purpose.
 */
const MEDICINES_GLYPH = [
  'M12.2828 5.7775 A4.2 4.2 0 0 1 18.2225 11.7172 L11.7172 18.2225 A4.2 4.2 0 0 1 5.7775 12.2828 Z',
  'M9.0302 9.0302 L14.9699 14.9699',
];
// Three parallel strokes, but the hamburger is the most-recognised mark in mobile
// navigation and its only lookalike (≡) is not a letter in either script.
const MORE_GLYPH = ['M4 7.5 H20', 'M4 12 H20', 'M4 16.5 H20'];

/**
 * The filled indicator behind the current tab's glyph.
 *
 * PILL_WIDTH is a MAXIMUM, not a width — see `pillWidth` in the layout below. PILL_HEIGHT
 * is the real number: it is handed to `tabBarIconStyle`, so it becomes the size of the box
 * React Navigation reserves, and every part of the bar's height sum is measured from it.
 */
const PILL_WIDTH = 62;
const PILL_HEIGHT = 42;
const GLYPH_SIZE = 30;

/**
 * The tab Pressable's own padding — `tabVerticalUiKit` in BottomTabItem.tsx, `padding: 5`.
 * It is NOT cancellable from `tabBarItemStyle`: that style goes on the outer wrapper View,
 * and only its `flex` is lifted onto the Pressable. So it is a constant to be budgeted for,
 * not a value to be zeroed.
 */
const TAB_ITEM_PADDING = 5;

/** Our own `borderTopWidth` below. Inside the height, because Yoga's box model is border-box. */
const BAR_BORDER = 2;

/** Today · Trends · Medicines · More. Declared once so the width share below stays honest. */
const TAB_COUNT = 4;

/**
 * NOTE FOR WHOEVER EDITS THIS NEXT: `tabBarIcon` is rendered TWICE per tab — once with
 * `focused: true` and once with `focused: false` — and the two are crossfaded by opacity
 * (TabBarIcon.tsx renders both layers absolutely, one over the other). So `focused` here is
 * the LAYER IDENTITY, not the navigation state. That is harmless for a pure render like
 * this one, but any effect, haptic, measurement or log added inside would fire twice per
 * tab, for eight live copies across the bar.
 */
function TabGlyph({ d, focused }: { d: readonly string[]; focused: boolean }) {
  const { colors } = useTheme();
  const stroke = focused ? colors.primary : colors.textMuted;

  return (
    <View
      style={{
        // '100%' of the box `tabBarIconStyle` set, rather than the constants again. Sized
        // from its container, the pill can never overhang it and re-create the overlap.
        width: '100%',
        height: '100%',
        borderRadius: radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
        // Both states declare the same border width, so the glyph does not shift by 2dp
        // as the selection moves — movement reads as a glitch, not as feedback.
        borderWidth: 2,
        borderColor: focused ? colors.primary : 'transparent',
        backgroundColor: focused ? colors.primarySoft : 'transparent',
      }}
    >
      <Svg
        width={GLYPH_SIZE}
        height={GLYPH_SIZE}
        viewBox="0 0 24 24"
        accessible={false}
        pointerEvents="none"
      >
        {d.map((path) => (
          <Path
            key={path}
            d={path}
            stroke={stroke}
            strokeWidth={focused ? 2.8 : 2.1}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
      </Svg>
    </View>
  );
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const t = useT(STRINGS);

  // The label rides the app's own scale, so the bar is measured from it rather than
  // from a constant that a 1.25× multiplier would silently overflow.
  const labelSize = fontSizes.md;
  // 1.3 is the floor for Devanagari: the matra above "दवाइयाँ" clips into the line above
  // at anything tighter (see the header of `@/components/ui/Text`). This is why the label
  // keeps an explicit lineHeight instead of letting the box shrink with the glyphs.
  const labelLine = Math.round(labelSize * 1.3);

  /**
   * ─── THE LABEL'S LINE BOX IS NOT `labelLine`, AND THAT IS AN ANDROID TRAP ────────
   * `fontSize` and `lineHeight` are scaled by the OS font setting through two DIFFERENT
   * conversions. `TextAttributeProps.setFontSize` calls `PixelUtil.toPixelFromSP(value,
   * maxFontSizeMultiplier)` — the two-argument overload, which clamps. `setLineHeight`
   * calls `PixelUtil.toPixelFromSP(value)` — the one-argument overload, with NO cap.
   *
   * So at an OS scale of 1.5 our `maxFontSizeMultiplier: 1.15` holds the glyphs to 1.15×
   * while the line box still grows the full 1.5×. Measuring the bar from `labelLine`
   * alone was short by a third of a line at the top of the range, which is how a label
   * ends up pushed down onto the gesture bar. The live scale is multiplied in instead —
   * this is the "measures itself from its contents" rule applied to the one input that
   * was being read as a constant.
   *
   * `useWindowDimensions()` can report 0 for a frame on some Android skins, so the scale
   * is floored at 1 rather than allowed to collapse the bar.
   */
  const labelBox = Math.ceil(labelLine * (fontScale > 0 ? fontScale : 1));

  /**
   * ─── THE SUM ────────────────────────────────────────────────────────────────────
   *   barHeight = BAR_BORDER        2   our own borderTopWidth
   *             + spacing.sm        8   our own tabBarStyle paddingTop
   *             + TAB_ITEM_PADDING  5   the tab Pressable's own padding, uncancellable
   *             + PILL_HEIGHT      42   the icon box, now real (see the header)
   *             + labelBox              one line of label at the live font scale
   *             + TAB_ITEM_PADDING  5   the same padding underneath
   *             + insets.bottom         ADDED ON TOP — see the header; this is the
   *                                     regression that is easy to reintroduce
   *
   * Worked through at 17sp body, no large-text mode (labelLine = 22), before the inset:
   *   0.85× → 62 + 19 = 81dp · 1.0× → 84dp · 1.3× (her handset) → 91dp · 1.5× → 95dp.
   * In large-text mode (1.25×, labelSize 21, labelLine 27): 1.0× → 89dp, 1.5× → 103dp.
   *
   * AT EVERY ONE OF THOSE the label's box starts at 2 + 8 + 5 + 42 = 57dp below the top
   * of the bar, and the pill ends at exactly 57dp, because the pill is 100% of a box the
   * label is laid out after. The two cannot meet at any scale — the sum decides how much
   * room the word gets, not whether the pill is sitting on it.
   *
   * TOUCH TARGET: the tab Pressable is `flex: 1` inside this height, so the target is the
   * whole item — 74dp tall at 1.0×, and the floor of the range (0.85×) is 71dp. Both are
   * above the 56dp house minimum, and it only grows from there.
   */
  const barHeight =
    BAR_BORDER +
    spacing.sm +
    TAB_ITEM_PADDING +
    PILL_HEIGHT +
    labelBox +
    TAB_ITEM_PADDING +
    insets.bottom;

  /**
   * The pill's width, measured rather than asserted. Now that `tabBarIconStyle` makes the
   * icon box a real 62dp wide, that width has to actually exist: four items share the bar,
   * each loses `spacing.xs` either side to `tabBarItemStyle` and 5dp either side to the
   * Pressable's own padding. On a 360dp panel that leaves 72dp and 62 fits; on a 320dp
   * panel it leaves exactly 62dp — no margin at all, and any less would have adjacent
   * pills touching, since the item wrapper is `overflow: 'visible'`.
   *
   * The floor keeps the 30dp glyph from ever being squeezed. The 0-width guard is the same
   * bad-frame case as the font scale above.
   */
  const itemContentWidth =
    windowWidth > 0
      ? Math.floor((windowWidth - Math.max(insets.left, insets.right) * 2) / TAB_COUNT) -
        spacing.xs * 2 -
        TAB_ITEM_PADDING * 2
      : PILL_WIDTH;
  const pillWidth = Math.max(GLYPH_SIZE + spacing.sm, Math.min(PILL_WIDTH, itemContentWidth));

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarShowLabel: true,
        // Rendered by hand so the word obeys large-text mode, caps the OS multiplier on
        // top of it, and shrinks rather than truncating — a tab whose only word reads
        // "Medicine…" has lost the thing it was there to say. `adjustsFontSizeToFit` is
        // declared under `TextPropsIOS` in RN's types, which reads as iOS-only; it is not,
        // Android implements it. But it buys WIDTH only: the explicit lineHeight below
        // holds the vertical box open regardless, which is exactly why `labelBox` above
        // budgets for the full uncapped line height rather than trusting the shrink.
        // THE ACTIVE LABEL IS `text`, NOT `primary`, AND THAT IS A MEASUREMENT.
        // `colors.primary` #0A6254 on `bgElevated` #FCFAF5 is 6.9711:1 — past WCAG AA,
        // and UNDER this app's own ≥7:1 floor for anything a person reads. The same
        // commit that wrote this file rejected `variant="ghost"` on Today for exactly
        // that argument at 5.48:1 ("a measured floor is not tradable for a tidier
        // silhouette"), and a tab label is text a person reads. Dark passed at 7.1908:1,
        // so it was a light-mode-only miss — the mode the device is NOT being tested in,
        // which is how a 0.03 miss survives a review.
        //
        // Nothing is lost by dropping the colour. The header above lists the four cues
        // that mark selection: the filled pill, its 2dp edge, the heavier glyph stroke
        // and the bolder label. The label's own tint was a fifth. `text` on `bgElevated`
        // measures 15.91:1 light, and the inactive `textMuted` is 7.62:1 — so selected is
        // now also the HIGHER-contrast of the two, which is the right way round.
        tabBarLabel: ({ focused, children }) => (
          <Text
            variant="caption"
            align="center"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            maxFontSizeMultiplier={1.15}
            weight={focused ? fontWeight.bold : fontWeight.medium}
            style={{
              fontSize: labelSize,
              lineHeight: labelLine,
              color: focused ? colors.text : colors.textMuted,
            }}
          >
            {children}
          </Text>
        ),
        /**
         * The box React Navigation reserves for `tabBarIcon`. This one line is the whole
         * overlap fix: `iconStyle` is merged after the framework's fixed 31×28 `wrapperUikit`,
         * so the reserved box becomes the pill's own size and the label starts below it.
         */
        tabBarIconStyle: { width: pillWidth, height: PILL_HEIGHT },
        // Horizontal only. A `paddingVertical` here would be a lie: this style lands on the
        // outer wrapper View, while the 5dp above and below the icon belongs to the
        // Pressable inside it and cannot be reached from here. It is budgeted for in the
        // height sum as TAB_ITEM_PADDING instead.
        tabBarItemStyle: { paddingHorizontal: spacing.xs },
        tabBarStyle: {
          height: barHeight,
          paddingTop: spacing.sm,
          backgroundColor: colors.bgElevated,
          borderTopWidth: BAR_BORDER,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.today'),
          tabBarAccessibilityLabel: t('nav.today'),
          tabBarIcon: ({ focused }) => <TabGlyph d={TODAY_GLYPH} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="trends"
        options={{
          title: t('nav.trends'),
          tabBarAccessibilityLabel: t('nav.trends'),
          tabBarIcon: ({ focused }) => <TabGlyph d={TRENDS_GLYPH} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="medicines"
        options={{
          title: t('nav.medicines'),
          tabBarAccessibilityLabel: t('nav.medicines'),
          tabBarIcon: ({ focused }) => <TabGlyph d={MEDICINES_GLYPH} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t('nav.more'),
          tabBarAccessibilityLabel: t('nav.more'),
          tabBarIcon: ({ focused }) => <TabGlyph d={MORE_GLYPH} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
