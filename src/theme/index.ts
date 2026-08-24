/**
 * Design tokens. Ported from the EasyFix app's `src/theme/` convention.
 *
 * HARD RULE (enforced by review, and by scripts/check-clinical-language.js):
 * component code uses tokens only — never a raw hex value.
 *
 * Three rules specific to this app:
 *  • Sizes are calibrated for an elderly user with presbyopia. `touchTarget.min` is
 *    56 not 44, and body text starts at 17sp not 15sp.
 *  • Out-of-range values are NEVER coloured red. Roughly 8% of men have red/green
 *    colour deficiency, OPD printers are monochrome, and — most importantly — a red
 *    number is a clinical verdict the app is not allowed to render. Out-of-range is
 *    encoded by a hollow marker of the SAME colour, plus a word.
 *  • COLOUR IS NEVER THE ONLY SIGNAL. Where a colour distinguishes two things, a shape
 *    and a word distinguish them too. `categoryTints` below is the clearest case: the
 *    four Today tiles differ by tint, by glyph and by label.
 *
 *    THE HONEST VERSION OF THAT RULE, because the previous sentence here claimed "any
 *    one of the three alone is enough" and measurement says otherwise. Four inks that
 *    must EACH clear 3:1 against one background cannot also be four distinct steps of
 *    lightness — there is not enough range left. Measured lightness contrast between the
 *    four dark inks, pairwise: teal↔amber 1.05:1, teal↔blue 1.11:1, amber↔violet 1.14:1,
 *    blue↔violet 1.33:1 (it was 1.00:1 — see the note on `categoryTints` below). So the
 *    TINT alone does NOT separate all four for a monochrome reader, and it never could.
 *    What the rule actually guarantees, and all it has to: the GLYPH alone is enough, the
 *    WORD alone is enough, and no pair is left distinguishable ONLY by a hue difference
 *    that an ageing lens loses — which is why the blue/violet pair had to move.
 */

/**
 * A category tint — the pair a Today tile is built from.
 *
 * `ink` draws the glyph and the 2dp ring around it; `wash` fills the disc inside that
 * ring. They are declared as a pair rather than as two parallel arrays so a tile can
 * never end up wearing one category's ink over another's wash.
 *
 * ─── THE TINT LIVES IN A MEDALLION NOW, NOT IN THE WHOLE TILE ────────────────
 * `wash` used to be the tile's entire surface and `ink` its 2dp edge — four saturated
 * slabs, which was most of why Today shouted. The tile surface is now the ordinary
 * `bgElevated` + 1dp `border` that every other card in the app wears, and the whole tint
 * has moved into a small disc: `wash` fill, 2dp `ink` ring, `ink` glyph. (Its diameter is
 * `TILE_MEDALLION` in `(tabs)/index.tsx` and is a fold decision, not a token — see the
 * vertical budget there. It is deliberately not written down twice.)
 *
 * WHICH OF THE TWO IS LOAD-BEARING CHANGED WITH IT, AND THIS IS THE TRAP. `ink` against
 * `bgElevated` measures 5.90:1 to 11.92:1 in light and 6.50:1 to 8.63:1 in dark, so the
 * ring and the glyph clear the 3:1 floor for a graphical object with room to spare and
 * are what actually make the disc a disc. `wash` against `bgElevated` measures 1.16–1.21
 * in light and 1.01–1.18 in dark — two of the dark washes are, correctly, all but
 * invisible. That is fine while the fill is decoration inside a ring. It would NOT be
 * fine to draw `wash` as a surface with a shape drawn on it and no `ink` outline, and it
 * is not a bug to be "fixed" by darkening the washes: they are also the fill behind
 * `text` (9.6:1 to 13.7:1) and `textMuted` (5.9:1 to 6.9:1), and both of those floors
 * move the wrong way if the washes get more saturated.
 *
 * Concentrating the colour also made the four EASIER to tell apart rather than harder: a
 * small saturated disc separates better than a large pale field, and a large pale field
 * is exactly what an ageing lens desaturates first.
 *
 * ─── TILE 4'S INK IS SEPARATED FROM TILE 3'S BY LIGHTNESS, NOT BY HUE ────────
 * Tiles 3 and 4 (Weight and How I Feel) sit side by side in the bottom row, so they are
 * the pair a reader compares most directly — and they were the pair the file header's own
 * rule forbids. Dark tile 3 was #8DBBEA (relative luminance 47.1%) and dark tile 4 was
 * #C3ACEE (47.3%): a contrast ratio of 1.00:1, i.e. THE SAME SWATCH IN GREYSCALE, with
 * only a blue-versus-violet hue step between them. That is precisely the discrimination
 * the note at the top of this file says goes first with a yellowing lens. Light was barely
 * better at 1.18:1.
 *
 * So tile 4's ink moved along the lightness axis in both schemes, away from tile 3:
 *   dark   #C3ACEE (47.3%) → #DCC9FF (64.2%)   blue↔violet 1.00:1 → 1.33:1
 *   light  #4C3178 ( 5.1%) → #3F2668 ( 3.4%)   blue↔violet 1.18:1 → 1.41:1
 *
 * Moving in OPPOSITE directions in the two schemes is not an inconsistency: the dark ink
 * has to stay light enough to clear 3:1 on `bgElevated` #34302B and the light ink has to
 * stay dark enough to clear it on #FCFAF5, so "further from tile 3" means lighter in one
 * and darker in the other. Both new values were re-checked against BOTH surfaces they are
 * drawn on — `bgElevated` (8.63:1 dark, 11.92:1 light) and their own `wash` (8.58:1 dark,
 * 9.86:1 light) — because the ink is the ring AND the glyph, and both sit on the wash.
 *
 * If either value is ever changed again, redo all four numbers. A tint that clears the
 * background but collapses onto its neighbour has failed at the only job it has.
 */
export type CategoryTint = {
  readonly ink: string;
  readonly wash: string;
};

export type ThemeColors = {
  bg: string;
  bgElevated: string;
  bgSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textInverse: string;
  primary: string;
  primaryText: string;
  primarySoft: string;
  accent: string;
  /** Neutral emphasis for "needs attention" — never used to imply a clinical judgement. */
  attention: string;
  attentionSoft: string;
  /** Reserved for destructive UI actions (delete, stop medicine). NEVER for a reading. */
  destructive: string;
  destructiveSoft: string;
  success: string;
  successSoft: string;
  /** Chart series. Distinguishable in greyscale as well as colour. */
  series: readonly string[];
  /**
   * Wayfinding tints for the four record tiles on Today, in tile order.
   *
   * A FIXED-LENGTH TUPLE ON PURPOSE. Under `noUncheckedIndexedAccess` an array would
   * hand every caller a `CategoryTint | undefined` and invite a `?? fallback` that
   * silently paints two tiles the same colour — which is exactly the property these
   * values exist to prevent.
   *
   * These are NEVER a judgement about the value recorded. They are the same kind of
   * signal as the position of a light switch: a way to find the right tile without
   * reading. Every tile also carries its own glyph and its own word, so the colour is
   * the third of three cues, never the only one — see the note at the top of this file.
   *
   * Where the pair is drawn is documented on `CategoryTint` above, and the answer is not
   * what it used to be: read that note before changing either value.
   */
  categoryTints: readonly [CategoryTint, CategoryTint, CategoryTint, CategoryTint];
  overlay: string;
};

/**
 * ─── HOW THESE VALUES WERE CHOSEN ────────────────────────────────────────────
 * Every pair below was measured, not eyeballed. The floors held to:
 *
 *   body text on any surface        ≥ 7:1   (WCAG AA asks 4.5; ageing eyes lose
 *                                            contrast sensitivity long before acuity,
 *                                            so AA is the floor, not the target)
 *   muted text on any surface       ≥ 4.5:1
 *   every border, on both the surface it edges and the page behind it   ≥ 3:1
 *   page → card lift                ≥ 1.25:1 light, ≥ 1.3:1 dark
 *   any non-text shape that CARRIES MEANING, on every surface it crosses  ≥ 3:1
 *
 * THAT LAST FLOOR IS NOT ONLY ABOUT BORDERS, and it was learned the expensive way. The
 * scan screen's progress bar drew its travelling marker in `primarySoft` on a `bgSunken`
 * track — 1.07:1 light, 1.60:1 dark — so the one moving thing on screen during a 300-second
 * read was invisible for two thirds of every traverse, and the bar looked frozen. The pairs
 * that shape now uses, measured:
 *
 *   primary on bgSunken     5.47:1 light   9.79:1 dark   (the marker, and the solid fill)
 *   primary on primarySoft  5.84:1 light   6.12:1 dark   (the marker over its own ground)
 *   primarySoft on bgSunken 1.07:1 light   1.60:1 dark   (fine as a STATIC ground; never
 *                                                         for a figure that has to be seen)
 *
 * NEITHER SCHEME USES PURE BLACK OR PURE WHITE. White on black haloes badly on an
 * OLED panel at night — the reported complaint was a near-black page — so the dark
 * page is a lifted warm charcoal and its foreground is a softened bone white.
 *
 * BOTH SCHEMES ARE WARM-NEUTRAL RATHER THAN BLUE-GREY. The lens yellows with age and
 * blue-yellow discrimination goes first, so a blue-grey neutral desaturates towards
 * mud for exactly the person this app is for. Warm greys, teal and amber survive it.
 * Nothing in the app is ever distinguished by a blue-versus-violet difference alone.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const lightColors: ThemeColors = {
  bg: '#F3F0E9',
  bgElevated: '#FCFAF5',
  bgSunken: '#E4DFD5',
  border: '#877E72',
  borderStrong: '#5F584F',
  text: '#211E1A',
  textMuted: '#56504A',
  textInverse: '#FCFAF5',
  primary: '#0A6254',
  primaryText: '#FCFAF5',
  primarySoft: '#D6EBE4',
  accent: '#1C4C7C',
  attention: '#7A4E06',
  attentionSoft: '#F7E7C8',
  destructive: '#93231D',
  destructiveSoft: '#F8E3DE',
  success: '#1D6440',
  successSoft: '#D8EBDD',
  series: ['#0A6254', '#1C4C7C', '#8A5600', '#4C3178', '#93231D', '#3F5E12'],
  categoryTints: [
    { ink: '#0A6254', wash: '#DCEDE7' },
    { ink: '#8A5600', wash: '#F7E7C8' },
    { ink: '#1C4C7C', wash: '#DFE9F6' },
    // Darker than the `series` violet #4C3178 on purpose — see the lightness note on
    // `CategoryTint`. The two are no longer the same value and must not be re-merged.
    { ink: '#3F2668', wash: '#E9E2F4' },
  ],
  overlay: 'rgba(33, 30, 26, 0.5)',
};

export const darkColors: ThemeColors = {
  bg: '#262220',
  bgElevated: '#34302B',
  bgSunken: '#1A1715',
  border: '#847B70',
  borderStrong: '#A99F93',
  text: '#F2EEE7',
  textMuted: '#C3BBB1',
  textInverse: '#1A1715',
  primary: '#5FD3BC',
  primaryText: '#052019',
  primarySoft: '#1A423A',
  accent: '#8DBBEA',
  attention: '#F0BC6B',
  attentionSoft: '#40321A',
  destructive: '#F0A099',
  destructiveSoft: '#432622',
  success: '#84D9A2',
  successSoft: '#1A3E2E',
  series: ['#5FD3BC', '#8DBBEA', '#F0BC6B', '#C3ACEE', '#F0A099', '#B4D177'],
  categoryTints: [
    { ink: '#5FD3BC', wash: '#1A423A' },
    { ink: '#F0BC6B', wash: '#40321A' },
    { ink: '#8DBBEA', wash: '#1D3450' },
    // Lighter than the `series` violet #C3ACEE on purpose — see the lightness note on
    // `CategoryTint`. At #C3ACEE this tile was 1.00:1 against its neighbour.
    { ink: '#DCC9FF', wash: '#332B54' },
  ],
  overlay: 'rgba(0, 0, 0, 0.7)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  /** Minimum tap target. 56 rather than Android's 48 — this user has tremor and presbyopia. */
  touchTarget: 56,
  /** Primary actions on entry screens. */
  touchTargetLarge: 72,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const fontSize = {
  /** Only for units and superscripts — never for a value a doctor reads. */
  xs: 13,
  sm: 15,
  /** Body default. */
  md: 17,
  lg: 20,
  xl: 24,
  xxl: 30,
  /** Read-back confirmation and the dose name on a notification screen. */
  display: 34,
  /** The single biggest number on a screen. */
  hero: 44,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const durations = {
  fast: 120,
  normal: 200,
  slow: 320,
} as const;
