/**
 * Today. The screen this app is judged on.
 *
 * ─── THE HIERARCHY, AND WHY EACH LEVEL WEIGHS WHAT IT WEIGHS ─────────────────
 * The version before this one was six full-width slabs of near-equal weight stacked down
 * a dark page — a date, a name, an amber warning, a teal card, a heading, four tiles, two
 * buttons — and every single one of them carried a 2dp border. Nothing on it was first,
 * because everything was. Borders everywhere is the same as borders nowhere, and the one
 * thing the screen exists to answer (what do I take, and have I taken it) was a
 * low-contrast line of text competing with a warning about the app's own plumbing.
 *
 * There is now exactly ONE object allowed to shout, and it only shouts when it has
 * something to say:
 *
 *   LEVEL 1 — THE DOSE CARD, while a dose is actually waiting. It is the only thing on
 *     the screen with a 3dp edge and the only `display` line.
 *     `fontSize.display` is documented in the theme as "the dose name on a notification
 *     screen"; this is the same sentence in a different place, so it is the same size.
 *     That is what "reads at arm length" means concretely: 34sp, bold, on a tinted field
 *     inside a heavy edge, with a 56dp medallion beside it.
 *
 *     WHAT CARRIES THAT RANK IS THE EDGE AND THE TYPE, NOT THE FILL. This used to say
 *     "the only filled tint", and the measurement does not support it: `primarySoft`
 *     #D6EBE4 on this screen's `bgSunken` #E4DFD5 page is 1.06:1 in LIGHT — a fill that
 *     is not perceptible as a fill at all. (Dark is 1.59:1, which is why the son testing
 *     on a Xiaomi in dark mode sees the hierarchy this file describes and she does not.)
 *     The fill is decoration. The 3dp `primary` edge and the 34sp bold line are the rank,
 *     and they work in both schemes. Do not "restore" the claim by darkening
 *     `primarySoft`: it is also the field behind `text` (13.3:1) and the medallion's
 *     `primary` ring (5.8:1), and both of those floors move the wrong way.
 *
 *     WHICH IS WHY NOTHING BELOW IT MAY BE `variant="primary"`. A solid `colors.primary`
 *     slab measures 5.48:1 against the page. Put one under a 1.06:1 tinted card and the
 *     loudest object on the screen is whatever is wearing it — see the catch-up card.
 *
 *     WHEN THERE IS NOTHING TO TAKE, THE CARD DEMOTES ITSELF — neutral surface, 1dp
 *     edge, `title` (24sp). The screen calms down once the day is done, which is the
 *     opposite of an app that is loudest when it is idle. It still leads by position,
 *     by size and by the medallion; it simply stops competing for a glance it does not
 *     need. The glyph changes with the state too (clock / check / info / plus), so the
 *     state is legible before the sentence is read.
 *
 *   LEVEL 2 — The four record tiles, 2×2, as ONE calm group. See the tile note below.
 *
 *   LEVEL 3 — Page-level type with no container at all: the date, the greeting, the
 *     section headings, the empty-state sentences. Nothing but type size separates them,
 *     which is what makes them read as a background layer rather than as more objects.
 *
 *   CHROME — The reminder-delivery notice, and only the notice. It used to be a 130dp
 *     amber box with its own button, sitting ABOVE the answer on every single launch.
 *     An unactioned amber box at the top of every launch is wallpaper inside a week.
 *     It is now one 56dp row.
 *
 * ─── THE BORDER LADDER ───────────────────────────────────────────────────────
 *   3dp `primary`  the dose card, active. Exactly one on the screen, and often zero.
 *   1dp `border`   every other surface, without exception.
 * There is deliberately no 2dp anywhere. That is the entire mechanism: a heavy edge is
 * rare here, so a heavy edge means something.
 *
 * ─── THE NOTICE MOVED BELOW THE DOSE CARD, AND THE OLD REASON STILL APPLIES ──
 * It used to go first, and the reason given was sound: it is the explanation for
 * everything else looking empty, and she should not spend a second wondering whether the
 * emptiness is her fault. That reasoning is about ADJACENCY to the thing it explains, not
 * about being first on the screen — so it now sits immediately under the dose card,
 * touching what it explains, with the answer above it. It is still above the fold at
 * every scale we budget for (see the vertical budget below).
 *
 * ─── ONE SURFACE COMPONENT, EVERYWHERE ───────────────────────────────────────
 * The dose card, the notice, the catch-up card and all four tiles are `Card`. Not "look
 * like a card" — literally the same component, with the dose card overriding two colours
 * and a border width. That is what makes the four tiles read as four instances of one
 * object rather than four competing objects, and it means the surface language lives in
 * exactly one file. A tile is a Card that happens to be half a row wide.
 *
 * ─── THE TILES: 2×2 IS NOW STRUCTURAL, NOT EMERGENT ──────────────────────────
 * They used to be one `flexWrap: 'wrap'` row of four items at `flexBasis: '47%'`, which
 * is a layout that DECIDES each frame whether to be 2×2 or 4×1 — and the day
 * `PressableScale` ate the caller's style, it decided 4×1 and stayed there. (That is
 * fixed; see the header of `PressableScale.tsx`.) A percentage basis plus a gap is a
 * fragile pair even when it works: it holds only while `2 × basis + gap ≤ 100%`, so it
 * is one edit to `gap` or to `basis` away from silently collapsing to a single column
 * again, with nothing in the type system or the tests to notice.
 *
 * The tiles are therefore chunked into FIXED ROWS OF TWO, each row `flexDirection: 'row'`
 * with the default `flexWrap: 'nowrap'` and each tile `flex: 1`. A nowrap row cannot
 * break, so there is no decision left to get wrong: the grid is 2×2 by construction, at
 * every width, every font scale and every gap. `flex: 1` also means `flexBasis: 0`, so
 * the two halves are exactly equal regardless of how long "Blood pressure" renders — the
 * percentage version made them equal only by rounding luck.
 *
 * ─── THE TILES HAVE ICONS. THAT WAS A REVERSAL, AND THE REASON STILL HOLDS ───
 * They used to have none, and the reason given was sound: the app's shared icon set is
 * navigational, it holds no blood-pressure mark and no scale, and pressing `plus` into
 * service for "blood sugar" would have been a symbol that means something else. A wrong
 * icon is worse than none.
 *
 * The answer to that was not "no icons" — it was "draw the right four". A heart, a drop,
 * a weighing scale and a face are drawn below on the same 24×24 grid as `@/components/ui`
 * and live here, next to the only screen that uses them, exactly as the tab bar's glyphs
 * live in `_layout.tsx`. They carry no meaning the label does not already carry; they
 * exist so the tile can be found without reading it, which for a reader with presbyopia
 * is the difference between a glance and a hunt.
 *
 * WHERE THE TINT MOVED, AND WHY THE THREE CUES SURVIVED IT. The tile used to be a large
 * field of the category's `wash` inside a 2dp `ink` edge — four saturated slabs, which is
 * most of why the screen shouted. The tile surface is now the app's ordinary
 * `bgElevated` + 1dp `border`, and the whole tint has moved into a MEDALLION: `wash` fill,
 * 2dp `ink` ring, `ink` glyph. Each tile still differs from its neighbours in THREE
 * independent ways — glyph shape, tint, and word. Hand the screen to someone with
 * red/green deficiency, or print it, and the four are still four. Concentrating the colour
 * also made it *easier* to tell apart: a small saturated disc separates better than a
 * large pale field, which is exactly the discrimination an ageing lens loses first.
 *
 * THE THREE CUES ARE NOT INTERCHANGEABLE, AND THIS NOTE USED TO CLAIM THEY WERE. It said
 * "any one of the three alone is enough", which is false of the TINT and was always going
 * to be: four inks that each have to clear 3:1 against one background cannot also be four
 * distinct steps of lightness. Measured, in dark, the tints separate 1.05:1 (teal↔amber)
 * to 1.33:1 (blue↔violet) — a monochrome reader gets nothing useful from them. The glyph
 * alone IS enough and the word alone IS enough, which is what the rule actually needs. The
 * one property the tints must hold is that no pair is left distinguishable only by a hue
 * step an ageing lens loses; tile 3 and tile 4 were exactly that pair at 1.00:1 in dark
 * (identical luminance, blue versus violet) until `theme/index.ts` moved tile 4's ink
 * along the lightness axis. Read the note on `CategoryTint` before touching either.
 *
 * THE MEDALLION IS 40dp, NOT 48, AND THAT IS A FOLD DECISION. See the vertical budget
 * below: the medallion plus its gap costs 48dp of every tile before a word is drawn, and
 * across two rows that is what decided whether the words "Weight" and "How I Feel" were
 * on the screen or under the tab bar. The glyph is the third cue, the redundant one — it
 * must not be the thing that pushes the first cue off the page.
 *
 * ─── FIRST RUN IS A BEGINNING, NOT A LIST OF FAILURES ────────────────────────
 * The old screen greeted a brand-new user with "Nothing recorded yet" four times over,
 * a fifth "Nothing recorded today yet" in a bordered card, and "No medicines are
 * scheduled for today". Six statements of absence before she had done anything wrong.
 *
 * Now: a tile with no reading simply has no value line — the absence is the blank space,
 * which needs no sentence — and the two places that do speak say what happens next
 * ("Tap here to add the medicines you take", "This is where your readings will appear").
 * The dose card distinguishes "you have no medicines yet" from "you have medicines, none
 * are due today", because those are different situations and only one of them has a next
 * step.
 *
 * ─── THE VERTICAL BUDGET ─────────────────────────────────────────────────────
 * Nothing important may sit below the fold: recording a reading has to stay one VISIBLE
 * tap away. Measured against a 393×873dp handset (a Xiaomi at 440dpi), a ~24dp status
 * inset and the tab bar's own 91dp + a 24dp gesture inset at OS font scale 1.3, the usable
 * scene is 734dp. Everything below is at OS 1.3× with the app's large-text mode OFF.
 *
 * EVERY LINE BOX BELOW IS THE OS SCALE APPLIED TO AN EXPLICIT `lineHeight`, NOT TO THE
 * FONT SIZE. That is the trap that made the previous version of this table wrong by 39dp
 * on one row. `@/components/ui/Text` sets an explicit lineHeight per variant, and Android
 * scales fontSize through `PixelUtil.toPixelFromSP(size, maxFontSizeMultiplier)` — which
 * CLAMPS — but lineHeight through the one-argument overload, which does NOT. So a variant
 * with no `maxFontSizeMultiplier` (`label`, `body`, `caption`) grows its box the full 1.3×
 * whatever the glyphs do, and `adjustsFontSizeToFit` shrinks the glyphs without shrinking
 * the box. Budget the box, never the size.
 *
 *   header block        86.2   12 padding + caption 28.6 + gap 4 + title 41.6
 *   BLOCK_GAP           24
 *   dose card (active) 215     32 padding + 6 border + row 93.7 + 8 + rule 1 + 8
 *                              + dots 24 + 8 + summary 33.8.  Row = headline 53.3
 *                              + 4 + detail 36.4, for a ONE-LINE medicine name.
 *   BLOCK_GAP           24
 *   reminder notice     99     ONLY when the check is actually failing.
 *                              24 padding + 2 border + title 72.8 — the title is
 *                              `label` (20sp → 28dp box → 36.4 at 1.3×) and
 *                              "Reminders may not reach you" is ~372px against 255px
 *                              of text column, so it is TWO lines, always, in English.
 *                              This line said 60 and the row has never been 60.
 *   BLOCK_GAP           24
 *   section heading     36.4
 *   INNER_GAP           12
 *   tile row 1         208     worst case: 24 padding + 2 border + medallion 40 + 8
 *                              + label 72.8 + 4 + value 57.2 (both two-line)
 *   ────────────────────────
 *   notice ABSENT (the ordinary day)
 *     row 1 ends at    605.6  <  734   ✓ fully visible
 *     row 2 starts at  617.6, and its LABEL's first line runs 677.6 → 714.4  ✓ readable
 *   notice PRESENT (the failure state)
 *     row 1 ends at    728.6  <  734   ✓ fully visible, with 5dp to spare
 *     row 2 starts at  740.6 — below the fold and visibly scrollable, as intended
 *
 * TWO STATES BREAK THE ROW-1 GUARANTEE AND NO LAYOUT AT THIS SCALE COULD SAVE THEM.
 * A medicine name that takes both its lines adds 53.3dp to the dose card (215 → 268).
 * With the notice also showing, row 1 ends at 781.6 and its value line is under the tab
 * bar. That is a 1.3× OS scale, a two-line 34sp headline, a two-line warning and two-line
 * tile labels all at once; the same is true of the app's own 1.25× large-text mode on top
 * of the OS 1.3× (1.63× effective), where nothing survives above the fold. That is
 * precisely why `Screen` scrolls by default, and why the medallion is 40 rather than 48 —
 * every dp recovered here is a dp of margin against a state like that one.
 *
 * On first run — no dose card dots, no notice, no value lines — the whole 2×2 grid ends
 * around 570dp and everything fits with room to spare.
 *
 * WHEN YOU CHANGE A NUMBER IN THIS FILE, RE-DERIVE THIS TABLE. A budget nobody re-derives
 * is a comment that documents a layout that no longer exists, and it is worse than no
 * budget at all because the next person trusts it.
 *
 * NOTHING ON THIS SCREEN USES RED, and nothing uses the word "missed". A dose with no
 * record is "not recorded as taken", which is the only thing the app actually knows.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { router } from 'expo-router';

import { useI18n, type TranslateFn } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing, type CategoryTint } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Button,
  Card,
  Divider,
  Icon,
  ListRow,
  Screen,
  SectionHeader,
  Skeleton,
  StatCard,
  Text,
  type IconName,
  type StatRange,
} from '@/components/ui';
import type { OccurrenceStatus, Reading, TargetRange } from '@/types';
import { toLocalDate } from '@/lib/datetime';
import { getProfile } from '@/db/repositories/profiles';
import { getLatestReading, listRecentReadings } from '@/db/repositories/readings';
import { listTargets } from '@/db/repositories/targets';
import { listOccurrencesForDate } from '@/db/repositories/occurrences';
import { listEventsForOccurrences } from '@/db/repositories/doseEvents';
import { getMedicine, listActiveMedicines } from '@/db/repositories/medicines';
import { listSymptomDefs, listSymptomEvents } from '@/db/repositories/symptoms';
import { deriveStatus } from '@/features/dosing/deriveStatus';
import { findCatchUp, type CatchUpList } from '@/features/dosing/watchdog';
import { getStreakState } from '@/features/streaks';
import type { StreakState } from '@/features/streaks/compute';

import {
  DOSE_STATUS_STRINGS,
  METRIC_BP,
  METRIC_SUGAR,
  METRIC_WEIGHT,
  formatReadingValue,
  loadReminderHealth,
  matchTarget,
  metricUnit,
  rangeFor,
  resolveProfileId,
  targetFootnote,
  trimNumber,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
  type ReminderHealthSummary,
} from '../_shared/lib';
// The censored-reading rules live in one module for the whole app — the report layer is
// simply where they were needed first. Reimplementing "does this LO prove she was under
// the target" per screen is how two surfaces end up disagreeing about one reading.
import { censoredDirection, censoredVsTarget } from '@/features/reports/data/censored';

/**
 * TITLE CASE, ON THE STRINGS THIS SCREEN OWNS.
 *
 * The house rule is Title Case on buttons, tabs, titles and labels — UI chrome, the words
 * that name a control. It is applied here to every such string this file introduces
 * ("What to Record", "Share Today", "As-Needed Medicines", "Fill These In").
 *
 * It is deliberately NOT applied to sentences that are content rather than chrome — a
 * medicine's own name, "Everything recorded for today", "Nothing recorded today yet".
 * Title-casing a sentence is not the rule, it is a misreading of it, and it would make
 * this screen read like a form.
 *
 * Several chrome strings on this screen still come from `src/i18n/*.json` in sentence
 * case ("Blood pressure", "Fix this"). Those bundles are shared and are being edited by
 * another workstream right now, so they are reported rather than rewritten from here — a
 * casing sweep is one commit, and it belongs in one commit.
 */
const STRINGS: LocalStrings = {
  ...DOSE_STATUS_STRINGS,
  'today.recordHeading': { en: 'What to Record', hi: 'क्या दर्ज करें' },
  // An accessibility HINT, so it describes the outcome rather than naming a control.
  // One hint for all four tiles: naming the metric inside it would need a different
  // Hindi postposition per metric, and four near-identical hints is noise in TalkBack.
  'today.recordHint': {
    en: 'Opens the screen where you record it',
    hi: 'वह स्क्रीन खोलता है जहाँ आप इसे दर्ज करती हैं',
  },
  'today.dosesSummary': {
    en: '{{taken}} of {{total}} recorded as taken',
    hi: '{{total}} में से {{taken}} ली गई दर्ज हैं',
  },
  'today.dotsLabel': {
    en: 'Today: {{taken}} recorded as taken, {{waiting}} still waiting, out of {{total}}',
    hi: 'आज: {{total}} में से {{taken}} ली गई दर्ज हैं, {{waiting}} अभी बाकी हैं',
  },
  'today.noDoses': { en: 'No medicines are scheduled for today', hi: 'आज कोई दवा तय नहीं है' },
  'today.nextAt': { en: 'Next at {{time}}', hi: 'अगली {{time}} बजे' },
  // The genuinely-new-user case, kept separate from "nothing due today": one of the two
  // has a next step and the other does not, and telling her they are the same thing is
  // how a first run turns into a dead end.
  'today.noMedicinesYet': { en: 'No medicines added yet', hi: 'अभी कोई दवा नहीं जोड़ी गई' },
  'today.noMedicinesYetDetail': {
    en: 'Tap here to add the medicines you take.',
    hi: 'आप जो दवाइयाँ लेती हैं, उन्हें जोड़ने के लिए यहाँ दबाइए।',
  },
  // An accessibility HINT, so it describes the outcome rather than naming a control.
  'today.openMedicines': {
    en: 'Opens your list of medicines',
    hi: 'आपकी दवाइयों की सूची खोलता है',
  },
  'today.openReminderCheck': {
    en: 'Opens the reminder check',
    hi: 'रिमाइंडर जाँच खोलता है',
  },
  'today.asNeeded': { en: 'As-Needed Medicines', hi: 'ज़रूरत पड़ने पर दवाइयाँ' },
  // रीडिंग IS FEMININE IN THIS APP, AND THESE TWO USED TO DISAGREE WITH IT.
  // hi.json already writes "जैसे ही आप कोई रीडिंग दर्ज करेंगी, वह यहाँ दिखेगी।" (feminine)
  // and `report.day.readings` is already "आज की रीडिंग". These two new screen-local
  // strings had "आज के रीडिंग" and "…रीडिंग दिखेंगे" — masculine — so within one session
  // she read the same noun agreeing two different ways, on Today and on Readings. To a
  // fluent reader that is the signature of machine translation, and this app's entire tone
  // strategy rests on sounding like a person wrote it for her.
  'today.readingsTitle': { en: "Today's Readings", hi: 'आज की रीडिंग' },
  'today.noReadingsToday': {
    en: 'Nothing recorded today yet. Tap one of the four buttons above.',
    hi: 'आज अभी कुछ दर्ज नहीं है। ऊपर दिए चार बटनों में से कोई एक दबाइए।',
  },
  'today.firstReadings': {
    en: 'This is where your readings will appear. Tap any of the four buttons above to record your first one.',
    hi: 'यहाँ आपकी दर्ज की गई रीडिंग दिखेंगी। पहली दर्ज करने के लिए ऊपर दिए चार बटनों में से कोई एक दबाइए।',
  },
  // ── A meter that showed a word instead of a number ──────────────────────
  // The big line stays SHORT — 'Meter showed LO' — because it is rendered in the
  // card's display type with `numberOfLines={1}` and `adjustsFontSizeToFit`, and a
  // sentence in that slot shrinks to something an ageing lens cannot read. The
  // inequality goes in the caption underneath, at full size, where it belongs.
  'today.meterBelow': { en: 'below {{bound}} {{unit}}', hi: '{{bound}} {{unit}} से कम' },
  'today.meterAbove': { en: 'above {{bound}} {{unit}}', hi: '{{bound}} {{unit}} से ज़्यादा' },
  'today.share': { en: 'Share Today', hi: 'आज का हाल भेजिए' },
  'today.shareHint': {
    en: 'Shows you exactly what will be sent before anything leaves the phone.',
    hi: 'फ़ोन से कुछ भी जाने से पहले आपको दिखाया जाएगा कि क्या भेजा जा रहा है।',
  },
  'today.catchUpTitle': {
    en: '{{count}} doses have no record',
    hi: '{{count}} खुराकों का कोई रिकॉर्ड नहीं है',
  },
  'today.catchUpTitleOne': { en: '1 dose has no record', hi: '1 खुराक का कोई रिकॉर्ड नहीं है' },
  'today.catchUpMessage': {
    en: 'You may well have taken them. Fill in whatever you remember — leaving one blank is fine.',
    hi: 'हो सकता है आपने ले भी ली हों। जो याद हो वही भरिए — कोई खाली छोड़ना भी ठीक है।',
  },
  'today.catchUpAction': { en: 'Fill These In', hi: 'ये भरिए' },
  // 'HIDE', NOT 'LATER'. This control collapses a list. It defers nothing: the card, the
  // count and the primary action all stay exactly where they were, the doses still have no
  // record, and the next launch shows the same card. 'Later' promised a deferral the
  // button cannot deliver, which teaches her that the button does not work — the same
  // class of lie `reminder-health.tsx` calls out by name about its own "Set the reminders
  // again" ("WITH NOTHING TO ARM, … IS A LIE ABOUT WHAT THE BUTTON DOES … the tap looks
  // like a dead control"). A genuine defer would be a different control that snoozes the
  // catch-up card for the day; this is not it, so it does not get to claim it is.
  'today.catchUpHide': { en: 'Hide', hi: 'छिपाइए' },
  // Hindi 'और' carries BOTH "and" and "more", so the literal mapping of "and {{count}}
  // more" produced 'और {{count}} और' — "and 3 and", read by a native speaker as a mistake
  // in the app rather than as a count, at the foot of a card that is already telling her
  // doses have no record.
  'today.catchUpMore': { en: 'and {{count}} more', hi: '{{count}} और बाकी हैं' },
  'today.streak': { en: '{{count}} days in a row', hi: 'लगातार {{count}} दिन' },
  'today.loading': { en: 'Loading your day', hi: 'आपका दिन खुल रहा है' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Tile glyphs
// ═══════════════════════════════════════════════════════════════════════════════
//
// Authored on the same 24×24 grid as `@/components/ui/Icon`, stroked and never filled,
// so they inherit a tint the way every other mark in the app does. They live here rather
// than in the shared set for the reason the file header gives: they are the four record
// categories, this is the only screen that has them, and the tab bar sets the precedent.
//
// The face is deliberately NEUTRAL — a straight mouth, not a smile and not a frown. "How
// I feel" records a description of a sensation; a graded face would be the app putting a
// verdict on her own report of her own body.

const GLYPH_HEART = [
  'M12 20.4 C12 20.4 4 15.2 4 9.9 A4.4 4.4 0 0 1 12 7.3 A4.4 4.4 0 0 1 20 9.9 C20 15.2 12 20.4 12 20.4 Z',
];
const GLYPH_DROP = ['M12 3.2 C12 3.2 5.5 10.4 5.5 14.6 A6.5 6.5 0 0 0 18.5 14.6 C18.5 10.4 12 3.2 12 3.2 Z'];
const GLYPH_SCALE = [
  'M4.2 4.6 H19.8 A1.7 1.7 0 0 1 21.5 6.3 V17.7 A1.7 1.7 0 0 1 19.8 19.4 H4.2 A1.7 1.7 0 0 1 2.5 17.7 V6.3 A1.7 1.7 0 0 1 4.2 4.6 Z',
  'M7 15.4 A5 5 0 0 1 17 15.4',
  'M12 15.4 L15.3 11.6',
];
const GLYPH_FACE = [
  'M12 2.8 A9.2 9.2 0 1 0 12 21.2 A9.2 9.2 0 1 0 12 2.8',
  'M9 9.6 V9.7',
  'M15 9.6 V9.7',
  'M8.6 15.2 H15.4',
];

function TileGlyph({ paths, color, size }: { paths: readonly string[]; color: string; size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false} pointerEvents="none">
      {paths.map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The rhythm
// ═══════════════════════════════════════════════════════════════════════════════
//
// TWO numbers, used everywhere, and no ad-hoc `marginTop` on any child. The old screen
// mixed `marginTop: lg` on some blocks, `paddingTop: md` on others, and inherited
// SectionHeader's own `paddingTop: lg + paddingBottom: sm` on top of both — so the gap
// above a heading was 16, 24 or 40 depending on what happened to precede it, and no two
// blocks on the screen were the same distance apart. Every top-level block is now a child
// of one column with one gap, and the two headings have their internal padding zeroed so
// the column's gap is the only spacing that exists.

/** Between top-level blocks. */
const BLOCK_GAP = spacing.xl;
/** Between a heading and the thing it heads, and between siblings inside one block. */
const INNER_GAP = spacing.md;

/** A tile is at least this tall before its label is measured. */
const TILE_MIN_HEIGHT = 120;
/** The gutter between tiles, in both directions — one number, so the grid is square. */
const TILE_GAP = spacing.md;
/**
 * 40, and it used to be 48. The 8dp is not a taste change.
 *
 * The medallion plus its 8dp gap is 48dp of vertical space spent in EVERY tile before a
 * single word is drawn, and there are two rows of them. At OS 1.3× that cost decided
 * whether the second row's labels — "Weight" and "How I Feel" — were on the screen or
 * under the tab bar; see the vertical budget in the file header. What she saw of the
 * bottom two tiles was two coloured discs and no words, which is the tile's third and
 * most redundant cue evicting its first.
 *
 * TILE_MIN_HEIGHT came down with it so the first-run grid (no value lines) does not sit
 * on a floor that is now taller than its own content.
 */
const TILE_MEDALLION = 40;
const TILE_GLYPH_SIZE = 22;
/** The medallion on the dose card. Also the app's minimum tap target, not by accident. */
const MEDALLION = spacing.touchTarget;
const DOSE_GLYPH_SIZE = 28;
/**
 * The one heavy edge on the screen. See "THE BORDER LADDER" in the file header: this is
 * the only value above 1, so it is the only edge that carries rank.
 */
const LEAD_BORDER = 3;

/**
 * One dose dot. 24 rather than the 28 this used to be, and the reason is arithmetic
 * rather than taste. On a 320dp handset — the narrowest width the app supports — the
 * ACTIVE card's content box is
 *
 *   320 − 32 (screen padding) − 32 (card padding) − 6 (LEAD_BORDER, both sides) = 250dp
 *
 * and 9 dots is 9 × 24 + 8 × 4 = 248. Fits, with 2dp to spare. At 28dp with `spacing.sm`
 * between them it would have been 316 and wrapped on every phone made.
 *
 * THE 6dp OF BORDER USED TO BE MISSING FROM THAT SUM, and the sum is only worth writing
 * down if it is the real box: the dots are drawn in the state where the card wears its
 * 3dp edge, so 256 was never the number.
 */
const DOSE_DOT = 24;

/**
 * How many dots may be drawn at all.
 *
 * ONE DOT PER OCCURRENCE, NOT PER SLOT — that is the thing to understand before changing
 * this. `doseSummary.doses` is `listOccurrencesForDate`, which is one row per medicine per
 * time, so the count is (medicines × times), not (times). The comment on `DOSE_DOT` above
 * used to be read as budgeting for nine dots because the slot registry is moving from four
 * daily dose times to nine — but nine SLOTS with this user's regimen (cardiac + type-2
 * diabetes + a four-drug TB combination, most of it twice daily) is comfortably 12 to 20
 * OCCURRENCES, and 20 dots is three wrapped rows and +56dp on a card the budget sizes at
 * 215.
 *
 * `flexWrap: 'wrap'` below stops that from clipping, so this was never a visual break —
 * it was a glanceable cue that had quietly stopped being glanceable. Twenty 24dp
 * hollow-or-filled circles is not a countable display for a presbyopic reader; nobody
 * counts past about six at a glance, and the sentence underneath ("4 of 14 recorded as
 * taken") is doing all of the actual work by then.
 *
 * So past this many, the dots are not drawn and the sentence carries it alone. Drawing
 * SOME of them would be worse than drawing none: they are unlabelled and untappable, so a
 * truncated row of them is a proportion the reader would reasonably believe and that would
 * be wrong.
 *
 * 9 is the same arithmetic as `DOSE_DOT`: the most that fits on one line at 320dp.
 */
const MAX_DOSE_DOTS = 9;

type DoseRow = {
  occurrenceId: string;
  medicineName: string;
  timeLocal: string;
  scheduledAtEpoch: number;
  status: OccurrenceStatus;
};

type TodayData = {
  profileId: string;
  displayName: string;
  latestBp: Reading | null;
  latestSugar: Reading | null;
  latestWeight: Reading | null;
  lastSymptomLabel: string | null;
  readingsToday: Reading[];
  targets: TargetRange[];
  doses: DoseRow[];
  /**
   * Whether she has ANY confirmed, active medicine — not whether one is due today.
   * Without this the dose card cannot tell a brand-new install ("add your first
   * medicine", which has a next step) from a settled one whose medicines simply are not
   * due today ("nothing scheduled", which has none), and it would greet both with the
   * same dead end.
   */
  hasMedicines: boolean;
  catchUp: CatchUpList;
  health: ReminderHealthSummary;
  streak: StreakState;
};

async function loadToday(lang: 'en' | 'hi'): Promise<TodayData | null> {
  // The ACTIVE (viewed) profile, not the default. With multiple patients on one phone these
  // diverge the moment she switches to grandmother, and Today is where the quick-entry tiles
  // live — a home screen showing mother's readings while a BP tile writes to grandmother (the
  // entry screens all resolve the active profile) is exactly the wrong-patient error the
  // profile pointer exists to prevent. `resolveProfileId` re-reads the pointer after a switch
  // invalidates the memo, and this screen reloads on focus, so switching swings Today too.
  const profileId = await resolveProfileId();
  if (!profileId) return null;
  const profile = await getProfile(profileId);
  if (!profile) return null;
  const today = toLocalDate();

  const [
    latestBp,
    latestSugar,
    latestWeight,
    recent,
    targets,
    occurrences,
    activeMedicines,
    symptomEvents,
    symptomDefs,
    catchUp,
    health,
    streak,
  ] = await Promise.all([
    getLatestReading(profileId, METRIC_BP),
    getLatestReading(profileId, METRIC_SUGAR),
    getLatestReading(profileId, METRIC_WEIGHT),
    listRecentReadings(profileId, 40),
    listTargets(profileId),
    listOccurrencesForDate(profileId, today),
    listActiveMedicines(profileId),
    listSymptomEvents(profileId, { limit: 1 }),
    listSymptomDefs(),
    findCatchUp(profileId),
    loadReminderHealth(),
    getStreakState(profileId),
  ]);

  const events = await listEventsForOccurrences(occurrences.map((o) => o.id));
  const now = Date.now();

  // Distinct medicines in a single day are few, so a small cache beats a join here and
  // keeps the occurrence query on its own index.
  const nameCache = new Map<string, string>();
  const doses: DoseRow[] = [];
  for (const occurrence of occurrences) {
    let name = nameCache.get(occurrence.medicineId);
    if (name === undefined) {
      const medicine = await getMedicine(occurrence.medicineId);
      name = medicine?.nameAsWritten ?? '';
      nameCache.set(occurrence.medicineId, name);
    }
    doses.push({
      occurrenceId: occurrence.id,
      medicineName: name,
      // The EFFECTIVE time: a dose moved for today only (per-day override, item 1) shows and
      // sorts by where it will actually ring — "Next at 10:00", not the untouched slot's 8:00.
      // Ordering already keys on `scheduledAtEpoch`, which the override re-derives in place.
      timeLocal: occurrence.overrideTimeLocal ?? occurrence.timeLocal,
      scheduledAtEpoch: occurrence.scheduledAtEpoch,
      // Recomputed from the events rather than read off `occurrence.status`: the cached
      // column can be one drain behind, and a stale "waiting" on a dose she answered
      // from the notification is the single most annoying thing this screen could do.
      status: deriveStatus(events.get(occurrence.id) ?? [], occurrence.scheduledAtEpoch, now),
    });
  }

  const lastSymptom = symptomEvents[0];
  let lastSymptomLabel: string | null = null;
  if (lastSymptom) {
    if (lastSymptom.customLabel) lastSymptomLabel = lastSymptom.customLabel;
    else if (lastSymptom.symptomKey) {
      const def = symptomDefs.find((d) => d.key === lastSymptom.symptomKey);
      lastSymptomLabel = def ? (lang === 'hi' ? def.labelHi : def.labelEn) : null;
    }
  }

  return {
    profileId,
    displayName: profile.displayName,
    latestBp,
    latestSugar,
    latestWeight,
    lastSymptomLabel,
    readingsToday: recent.filter((r) => r.localDate === today),
    targets,
    doses,
    hasMedicines: activeMedicines.length > 0,
    catchUp,
    health,
    streak,
  };
}

type RecordTile = {
  key: string;
  label: string;
  /**
   * The last recorded value, or NULL when there is none.
   *
   * Null rather than "Nothing recorded yet" on purpose. Four repetitions of an absence is
   * what made a brand-new install read as a list of failures; a tile with no value line
   * simply has no value line, and the blank space says the same thing without a sentence.
   */
  value: string | null;
  paths: readonly string[];
  tint: CategoryTint;
  onPress: () => void;
};

/**
 * Fixed rows of two.
 *
 * The 2×2 grid is built by chunking rather than by wrapping — see the file header. The
 * point of returning rows instead of setting `flexWrap` is that a nowrap row has no
 * decision to make, so there is no width, gap or font scale at which it can decide to be
 * one column.
 */
function pairUp<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push(items.slice(index, index + 2));
  }
  return rows;
}

export default function TodayScreen() {
  const { colors } = useTheme();
  const { lang } = useI18n();
  const t = useT(STRINGS);
  const dates = useDateFormat();
  const [catchUpOpen, setCatchUpOpen] = useState(false);

  const load = useCallback(() => loadToday(lang), [lang]);
  const { data, loading, reload } = useAsync(load, [lang]);
  useReloadOnFocus(reload);

  const tiles = useMemo<RecordTile[]>(() => {
    // Destructured rather than indexed. The tuple in the theme guarantees four entries;
    // destructuring is what makes the compiler agree, and it also makes it impossible to
    // hand two tiles the same tint by fumbling an index.
    const [bpTint, sugarTint, weightTint, symptomTint] = colors.categoryTints;

    const describe = (reading: Reading | null, _metricKey: string): string | null => {
      if (!reading) return null;
      const when = `${dates.formatDayLabel(reading.localDate)} ${dates.formatTime(reading.localTime)}`;
      const shown = readingDisplay(reading, t);
      const head = shown.unit ? `${shown.value} ${shown.unit}` : shown.value;
      // 'Meter showed LO · below 20 mg/dL · Yesterday 7:10 am'. The tile is two lines at
      // `numberOfLines={2}`, which holds this at the base scale and truncates the DATE
      // first at 1.3× — the right thing to lose, since the reading itself is above it.
      return shown.inequality ? `${head} · ${shown.inequality} · ${when}` : `${head} · ${when}`;
    };

    return [
      {
        key: 'bp',
        label: t('entry.bp.tile'),
        value: describe(data?.latestBp ?? null, METRIC_BP),
        paths: GLYPH_HEART,
        tint: bpTint,
        onPress: () => router.push('/entry/bp'),
      },
      {
        key: 'sugar',
        label: t('entry.sugar.tile'),
        value: describe(data?.latestSugar ?? null, METRIC_SUGAR),
        paths: GLYPH_DROP,
        tint: sugarTint,
        onPress: () => router.push('/entry/sugar'),
      },
      {
        key: 'weight',
        label: t('entry.weight.tile'),
        value: describe(data?.latestWeight ?? null, METRIC_WEIGHT),
        paths: GLYPH_SCALE,
        tint: weightTint,
        onPress: () => router.push('/entry/weight'),
      },
      {
        key: 'symptom',
        label: t('entry.symptom.tile'),
        value: data?.lastSymptomLabel ?? null,
        paths: GLYPH_FACE,
        tint: symptomTint,
        onPress: () => router.push('/entry/symptom'),
      },
    ];
  }, [data, t, dates, colors]);

  const tileRows = useMemo(() => pairUp(tiles), [tiles]);

  const doseSummary = useMemo(() => {
    const doses = data?.doses ?? [];
    const taken = doses.filter((d) => d.status === 'taken').length;
    const waiting = doses.filter((d) => d.status === 'pending' || d.status === 'snoozed').length;
    const next = doses
      .filter((d) => d.status === 'pending' || d.status === 'snoozed')
      .sort((a, b) => a.scheduledAtEpoch - b.scheduledAtEpoch)[0];
    return { doses, taken, waiting, total: doses.length, next };
  }, [data]);

  if (loading && !data) {
    return (
      <Screen variant="scroll" background="bgSunken">
        {/* The skeleton mirrors the real layout block for block — one wide line, one
            card, then 2×2 — so the page does not jump when the data lands.

            EVERY PLACEHOLDER OVERRIDES ITS OWN FILL, AND THAT IS NOT DECORATION.
            `Skeleton` paints itself `colors.bgSunken` and pulses only its opacity, and
            `bgSunken` is this screen's own background — so an un-overridden skeleton here
            is bgSunken over bgSunken: a 1.00:1 rectangle, i.e. nothing at all, on every
            one of the ~20 screens in this app that pass `background="bgSunken"`. The
            override is a local patch over a defect that belongs in `Skeleton` itself
            (it should pick its fill from the surface it is on, or take a `surface` prop);
            fixing it there is a change to a component this screen does not own. */}
        <View style={{ gap: BLOCK_GAP, paddingTop: spacing.md }}>
          <Skeleton
            label={t('today.loading')}
            height={32}
            width="55%"
            style={{ backgroundColor: colors.bgElevated }}
          />
          <Skeleton
            height={140}
            radius={radii.lg}
            style={{ backgroundColor: colors.bgElevated }}
          />
          <View style={{ gap: TILE_GAP }}>
            {[0, 1].map((row) => (
              <View key={row} style={{ flexDirection: 'row', gap: TILE_GAP }}>
                <Skeleton
                  height={TILE_MIN_HEIGHT}
                  radius={radii.lg}
                  style={{ flex: 1, backgroundColor: colors.bgElevated }}
                />
                <Skeleton
                  height={TILE_MIN_HEIGHT}
                  radius={radii.lg}
                  style={{ flex: 1, backgroundColor: colors.bgElevated }}
                />
              </View>
            ))}
          </View>
        </View>
      </Screen>
    );
  }

  const health = data?.health;
  /**
   * THE EXACT CONDITION THE REMINDER-HEALTH REWRITE SPECIFIED.
   *
   * `!health.allOk` used to be ANDed in front of this and has been dropped, because it
   * was never doing any work and it was actively misleading about what it meant.
   * `failed.length > 0` already implies `!allOk`, and `allOk` is additionally FALSE when
   * no check has ever run at all — "we have not looked yet" — which is not something to
   * warn a patient about and which the failed-list correctly reports as empty.
   *
   * The rule the health screen now guarantees, and the only reason this single line is
   * now trustworthy: Today may only warn about a finding that this build can re-run, is
   * currently asserting, and is drawing an amber card for. Rows written by an older build
   * under keys this one no longer owns are pruned before the read, so a stale row cannot
   * light this banner forever — which is exactly what the device report
   * ("warning not removed even after fixing") was.
   */
  const showHealthBanner = Boolean(health && health.failed.length > 0);
  const catchUp = data?.catchUp;
  const catchUpTotal = catchUp?.total ?? 0;

  /**
   * The dose card's four states. `active` is the only one that leads; the other three
   * deliberately step down to an ordinary card, because a card that shouts when there is
   * nothing to do teaches her to stop reading it.
   *
   * There is no "Next medicine" overline above the name: it said the same thing as the
   * line below it and the clock beside it, and a third line of text is 31dp that the
   * fourth tile needs in large-text mode. The glyph differs per state as well as the
   * words, so the state is legible before the sentence is read.
   */
  const next = doseSummary.next;
  const hasMedicines = data?.hasMedicines ?? false;
  const doseActive = Boolean(next);
  const firstRun = !doseActive && doseSummary.total === 0 && !hasMedicines;

  const doseGlyph: IconName = next
    ? 'clock'
    : doseSummary.total > 0
      ? 'check'
      : firstRun
        ? 'plus'
        : 'info';
  const doseHeadline = next
    ? next.medicineName
    : doseSummary.total > 0
      ? t('today.allDone')
      : firstRun
        ? t('today.noMedicinesYet')
        : t('today.noDoses');
  const doseDetail = next
    ? t('today.nextAt', { time: dates.formatTime(next.timeLocal) })
    : firstRun
      ? t('today.noMedicinesYetDetail')
      : null;

  /**
   * The medallion always carries the card's OTHER surface, so it reads as a disc in every
   * state without a second rule: `primarySoft` inside a `bgElevated` card, `bgElevated`
   * inside a `primarySoft` one. Its 2dp `primary` ring is what actually delimits it —
   * measured at 5.8:1 against `primarySoft` and 7.0:1 against `bgElevated` in light,
   * 6.1:1 and 7.2:1 in dark — so the fill is decoration and never load-bearing.
   */
  const doseMedallionFill = doseActive ? colors.bgElevated : colors.primarySoft;

  const hasEverRecorded = Boolean(
    data && (data.latestBp || data.latestSugar || data.latestWeight || data.lastSymptomLabel),
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <View style={{ gap: BLOCK_GAP }}>
        {/* ── Date, then her name. Small then large, so the eye lands on the name.
            Both sit on the bare page with no container: at this level type size is the
            only thing doing the ranking, which is what keeps them a background layer
            underneath the one card that matters. ── */}
        <View style={{ paddingTop: spacing.md, gap: spacing.xs }}>
          <Text variant="caption" tone="muted">
            {dates.formatDate(toLocalDate())}
          </Text>
          <Text variant="title" accessibilityRole="header">
            {data ? t('today.greeting', { name: data.displayName }) : t('today.title')}
          </Text>
        </View>

        {/* ── THE DOSE CARD. The one thing on this screen that leads. ────────────
            The WHOLE card opens the medicine list, rather than carrying a button that
            would cost another 68dp and push the tiles towards the fold. The chevron is
            the affordance every other row in this app uses, so the gesture is one she
            has already been taught somewhere else.

            It is also ONE accessibility node. The alternative — a summary for the state,
            another for the dots, and a button — is three swipes to learn one sentence.

            It is a `Card`, like everything else here, overriding exactly three things in
            its active state: the fill, the border colour and the border WIDTH. That third
            override is the whole hierarchy — see "THE BORDER LADDER" in the header. ── */}
        <Card
          onPress={() => router.push('/medicines')}
          accessibilityLabel={[
            doseHeadline,
            doseDetail,
            doseSummary.total > 0
              ? t('today.dotsLabel', {
                  taken: doseSummary.taken,
                  waiting: doseSummary.waiting,
                  total: doseSummary.total,
                })
              : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join('. ')}
          accessibilityHint={t('today.openMedicines')}
          style={
            doseActive
              ? {
                  borderWidth: LEAD_BORDER,
                  borderColor: colors.primary,
                  backgroundColor: colors.primarySoft,
                  gap: spacing.sm,
                }
              : { gap: spacing.sm }
          }
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
            <View
              style={{
                width: MEDALLION,
                height: MEDALLION,
                borderRadius: radii.pill,
                borderWidth: 2,
                borderColor: colors.primary,
                backgroundColor: doseMedallionFill,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={doseGlyph} size={DOSE_GLYPH_SIZE} color={colors.primary} />
            </View>

            <View style={{ flex: 1, gap: spacing.xs }}>
              {/* `display` ONLY for a medicine's own name. The other three headlines are
                  sentences, and a sentence at 34sp wraps to three lines and stops being
                  readable at arm's length rather than starting to be. `numberOfLines` is
                  2 either way: a long combination name is allowed to take both.

                  ─── THE ONE TRUNCATION THIS APP CANNOT AFFORD ─────────────────────────
                  `adjustsFontSizeToFit` is not polish here. This column is 209dp on her
                  handset — 393 − 32 (Screen) − 32 (Card) − 6 (LEAD_BORDER ×2) − 56
                  (MEDALLION) − 16 (gap) − 26 (chevron) − 16 (gap) — and `display` is 34sp
                  with `maxFontSizeMultiplier: 1.3`, so at her OS font scale of 1.3 it
                  renders at 44.2px: roughly nine characters a line, seventeen over the
                  two. Her TB regimen is a four-drug fixed-dose combination — "Isoniazid +
                  Rifampicin + Pyrazinamide + Ethambutol", or a brand like "Forecox Trac
                  Kit" — so the one thing this whole screen exists to say (what do I take)
                  was the thing being cut, as "Isoniazid + Rifa…".

                  It was also INVISIBLE to every check we have: the full name is in the
                  Card's `accessibilityLabel` above, so TalkBack was unaffected, and
                  nothing but a photograph of the running screen would have shown it.

                  0.7 matches what `StatCard.tsx` does to a reading and what the tab label
                  in `_layout.tsx` does to a tab name, so it is the app's existing answer
                  rather than a new one. A short name ("Metformin") still renders at the
                  full 34sp; a long combination degrades to ~31sp COMPLETE instead of 44sp
                  truncated.

                  BE HONEST ABOUT THE RESIDUAL: 0.7 buys about 24 characters, not 50. A
                  genuinely long FDC still ellipsises, and going lower would put the dose
                  name below body size, which loses the "reads at arm's length" property
                  this card exists for. The full name remains one tap away in Medicines and
                  is spoken in full by TalkBack. Nothing here shrinks the LINE BOX — RN
                  scales an explicit `lineHeight` uncapped — so this costs no vertical
                  budget either way. */}
              <Text
                variant={doseActive ? 'display' : 'title'}
                numberOfLines={2}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {doseHeadline}
              </Text>
              {doseDetail ? (
                /* `tone="default"`, not `primary`. `primary` on `primarySoft` measures
                   5.8:1 light / 6.1:1 dark — fine for WCAG large text, but under this
                   app's own ≥7:1 floor for anything a person has to read. Default text on
                   the same field is 13.3:1 and 9.6:1. The emphasis comes from the 20sp
                   semibold, which does not cost contrast.

                   `label` for a time ("Next at 8:00 am"), `body` for the first-run
                   invitation: the invitation is a sentence, and a sentence set at 20sp
                   semibold in a 215dp column is three lines of shouting under a headline
                   that is already doing the shouting. */
                <Text variant={doseActive ? 'label' : 'body'}>{doseDetail}</Text>
              ) : null}
            </View>

            <Icon name="chevronRight" size={26} color={colors.textMuted} />
          </View>

          {doseSummary.total > 0 ? (
            <>
              <Divider strong />
              <View style={{ gap: spacing.sm }}>
                {/* ONE ROW OF DOTS OR NONE — see MAX_DOSE_DOTS. `flexWrap` stays as the
                    safety net for a narrow panel or an unusual scale; it is no longer
                    what stops a twenty-dose day from growing three rows of circles. */}
                {doseSummary.total <= MAX_DOSE_DOTS ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
                    {doseSummary.doses.map((dose) => {
                      const recorded = dose.status === 'taken';
                      return (
                        <View
                          key={dose.occurrenceId}
                          style={{
                            width: DOSE_DOT,
                            height: DOSE_DOT,
                            borderRadius: radii.pill,
                            borderWidth: 3,
                            // Hollow, not red. An un-recorded dose is an absence of
                            // information, not a fault, and the border colour is the same
                            // neutral one the rest of the card uses. Filled-versus-hollow
                            // is a SHAPE difference, so the dots survive being printed and
                            // survive red/green deficiency; the sentence under them is the
                            // word that says the same thing a third way.
                            borderColor: recorded ? colors.primary : colors.borderStrong,
                            backgroundColor: recorded ? colors.primary : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {recorded ? (
                            <Icon
                              name="check"
                              size={14}
                              color={colors.primaryText}
                              strokeWidth={3}
                            />
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : null}
                <Text variant="body" tone="muted">
                  {t('today.dosesSummary', { taken: doseSummary.taken, total: doseSummary.total })}
                </Text>
              </View>
            </>
          ) : null}
        </Card>

        {/* ── Catch-up, collapsed to one line plus an action. ────────────────────
            The watchdog can legitimately return twelve items; twelve rows here would push
            the whole purpose of the screen off-screen, and a wall of un-recorded doses
            reads as an accusation rather than a to-do list. So the count is the card, and
            the list is one tap behind it. ── */}
        {catchUp && catchUpTotal > 0 ? (
          <Card>
            <View style={{ gap: INNER_GAP }}>
              <View
                accessible
                accessibilityRole="summary"
                accessibilityLabel={`${
                  catchUpTotal === 1
                    ? t('today.catchUpTitleOne')
                    : t('today.catchUpTitle', { count: catchUpTotal })
                }. ${t('today.catchUpMessage')}`}
                style={{ gap: spacing.sm }}
              >
                <Text variant="label">
                  {catchUpTotal === 1
                    ? t('today.catchUpTitleOne')
                    : t('today.catchUpTitle', { count: catchUpTotal })}
                </Text>
                <Text variant="body" tone="muted">
                  {t('today.catchUpMessage')}
                </Text>
              </View>

              {catchUpOpen ? (
                <View style={{ gap: spacing.xs }}>
                  {catchUp.items.map((item) => (
                    <View key={item.occurrenceId}>
                      <Divider />
                      <ListRow
                        title={item.medicineName}
                        subtitle={[item.strength, item.quantityText]
                          .filter((part): part is string => Boolean(part))
                          .join(' · ')}
                        meta={`${dates.formatDayLabel(item.localDate)} ${dates.formatTime(item.timeLocal)}`}
                        onPress={() => router.push(`/dose/${item.occurrenceId}`)}
                      />
                    </View>
                  ))}
                  {catchUp.andMore > 0 ? (
                    <Text variant="caption" tone="muted">
                      {t('today.catchUpMore', { count: catchUp.andMore })}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {/* `secondary` IN BOTH STATES, AND IT USED TO BE `primary` WHEN COLLAPSED.
                  A full-width `colors.primary` slab measures 5.48:1 against this page.
                  The dose card immediately above it — the object this screen's whole
                  hierarchy is built around — carries a `primarySoft` fill measuring
                  1.06:1 in light, so its rank rests entirely on a 3dp edge and 34sp type.
                  A solid saturated 56dp bar at 5.5:1 out-shouts a 1.06:1 tinted field
                  every time, and for a three-condition regimen "some doses have no record"
                  is most mornings — so the first 400dp of Today contained two competing
                  attractors on most launches and the LOUDER one was the secondary object.
                  In dark the numbers invert (1.59:1), which is why the son testing on a
                  Xiaomi in dark mode saw the intended hierarchy and she did not.

                  On the merits too: catching up on doses with no record is a deferred
                  tidy-up, not the screen's primary action. `secondary` is `bgElevated` +
                  a `borderStrong` 2dp edge with `text` at 15.91:1 — quieter, and higher
                  contrast than the fill it replaces. It stays 56dp and full width. */}
              <Button
                title={catchUpOpen ? t('today.catchUpHide') : t('today.catchUpAction')}
                onPress={() => setCatchUpOpen((open) => !open)}
                variant="secondary"
                size="md"
                fullWidth
              />
            </View>
          </Card>
        ) : null}

        {/* ── Reminder delivery. Amber, never red: this is the app's own failure, and
            dressing an app problem in the red used for "delete this medicine" trains her
            to ignore both.

            ONE ROW, not a box. It was a 130dp padded banner with its own heading, body
            copy and button, sitting above the answer on every launch. It now carries the
            same four signals — the alert triangle, the amber field, the amber edge and the
            words — in 56dp, and the body copy survives in the spoken label rather than on
            the screen, so a TalkBack user loses nothing. The whole row is the target and
            it goes to the same place the button did. ── */}
        {showHealthBanner ? (
          <Card
            onPress={() => router.push('/reminder-health')}
            accessibilityLabel={`${t('healthCheck.warningBanner.title')}. ${t('healthCheck.warningBanner.message')}`}
            accessibilityHint={t('today.openReminderCheck')}
            padding={INNER_GAP}
            style={{
              paddingHorizontal: spacing.lg,
              minHeight: spacing.touchTarget,
              borderColor: colors.attention,
              backgroundColor: colors.attentionSoft,
              flexDirection: 'row',
              alignItems: 'center',
              gap: INNER_GAP,
            }}
          >
            <Icon name="alert" size={24} color={colors.attention} />
            <Text variant="label" style={{ flex: 1 }}>
              {t('healthCheck.warningBanner.title')}
            </Text>
            <Icon name="chevronRight" size={24} color={colors.textMuted} />
          </Card>
        ) : null}

        {/* ── The four tiles. 2×2 by construction — see the file header. ────────── */}
        <View style={{ gap: INNER_GAP }}>
          <SectionHeader
            title={t('today.recordHeading')}
            style={{ paddingTop: 0, paddingBottom: 0 }}
          />
          <View style={{ gap: TILE_GAP }}>
            {tileRows.map((row) => (
              <View
                key={row.map((tile) => tile.key).join('-')}
                style={{ flexDirection: 'row', gap: TILE_GAP }}
              >
                {row.map((tile) => (
                  <Card
                    key={tile.key}
                    onPress={tile.onPress}
                    accessibilityLabel={tile.value ? `${tile.label}. ${tile.value}` : tile.label}
                    accessibilityHint={t('today.recordHint')}
                    // Tighter vertically than horizontally. In large-text mode the label
                    // and the value each take two lines, and those eight extra points per
                    // tile are the difference between the fourth tile being on the screen
                    // and being under the tab bar.
                    padding={spacing.md}
                    style={{
                      flex: 1,
                      paddingHorizontal: spacing.lg,
                      minHeight: TILE_MIN_HEIGHT,
                      justifyContent: 'space-between',
                      gap: spacing.sm,
                    }}
                  >
                    {/* The medallion. The whole of the category's tint lives in here:
                        `wash` fill, 2dp `ink` ring, `ink` glyph. The RING is what makes it
                        read as a disc — measured 5.9:1 to 10.0:1 against `bgElevated` in
                        light and 6.5:1 to 7.6:1 in dark, all well past the 3:1 floor for a
                        graphical object. The fill is not load-bearing and must never be
                        asked to be: two of the four dark washes sit at 1.01–1.04 against
                        `bgElevated`, which is invisible on purpose — it is a whisper of
                        colour behind a ring that is doing the actual work. */}
                    <View
                      style={{
                        width: TILE_MEDALLION,
                        height: TILE_MEDALLION,
                        borderRadius: radii.pill,
                        borderWidth: 2,
                        borderColor: tile.tint.ink,
                        backgroundColor: tile.tint.wash,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <TileGlyph paths={tile.paths} color={tile.tint.ink} size={TILE_GLYPH_SIZE} />
                    </View>
                    <View style={{ gap: spacing.xs }}>
                      <Text variant="label">{tile.label}</Text>
                      {tile.value ? (
                        <Text variant="caption" tone="muted" numberOfLines={2}>
                          {tile.value}
                        </Text>
                      ) : null}
                    </View>
                  </Card>
                ))}
                {/* Four tiles pair evenly, so this never renders today. It is here so that
                    a fifth category does not silently become a full-width tile: a lone
                    tile keeps its half of the row and the grid stays a grid. */}
                {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
              </View>
            ))}
          </View>
        </View>

        {/* ── Today's readings ─────────────────────────────────────────────────── */}
        <View style={{ gap: INNER_GAP }}>
          <SectionHeader
            title={t('today.readingsTitle')}
            style={{ paddingTop: 0, paddingBottom: 0 }}
          />
          {data && data.readingsToday.length > 0 ? (
            <View style={{ gap: INNER_GAP }}>
              {data.readingsToday.map((reading) => {
                const target = matchTarget(data.targets, reading.metricKey, 'v1', reading.context);
                const shown = readingDisplay(reading, t);
                return (
                  <StatCard
                    key={reading.id}
                    compact
                    label={metricLabelKey(reading.metricKey, t)}
                    value={shown.value}
                    unit={shown.unit}
                    // `rangeFor` returns 'unknown' for a null value, which is right for a
                    // reading that has no number and wrong for one that has an inequality.
                    range={
                      reading.valueQualifier === 'exact'
                        ? rangeFor(target, reading.v1)
                        : censoredRange(reading, target)
                    }
                    caption={
                      shown.inequality
                        ? `${shown.inequality} · ${dates.formatTime(reading.localTime)}`
                        : dates.formatTime(reading.localTime)
                    }
                    footnote={targetFootnote(t, target, dates.formatDate)}
                  />
                );
              })}
            </View>
          ) : (
            /* A sentence on the page, not a bordered card containing a sentence. An empty
               section does not need a container to prove it is a section — the heading
               above it already did that — and a card here was one more slab of equal
               weight arguing with the four tiles.

               Which sentence depends on whether she has EVER recorded anything. On a
               brand-new install the honest message is what will happen next, not what has
               not happened yet. */
            <Text variant="body" tone="muted">
              {hasEverRecorded ? t('today.noReadingsToday') : t('today.firstReadings')}
            </Text>
          )}
        </View>

        {/* ── The two things that leave this screen. Both below the fold, both calm.
            ─── THEY ARE THE SAME SIZE NOW, AND THE RANK THEY USED TO CARRY WAS WRONG ───
            The previous version made "As-Needed Medicines" a short `md` button and "Share
            Today" a full-width `lg` one, ranking them by FREQUENCY: as-needed dosing is
            rare, sharing is not. It was reported as looking unfinished, and it was — but
            the visual complaint is the smaller half of the problem.

            FREQUENCY IS THE WRONG AXIS FOR THIS PARTICULAR CONTROL. An as-needed medicine
            is a rescue dose: sorbitrate under the tongue, a reliever inhaler. It is used
            rarely and it is used in a hurry, and the app cannot know which of those two
            facts today is about. Shrinking a control because it is seldom needed makes it
            hardest to hit on precisely the occasion it is needed — and this user has a
            tremor, for which a full-bleed target is measurably easier than a ~190dp one.

            THE LAYOUT COMPLAINT WAS ALSO REAL, AND IT IS WORSE IN HINDI. A button with no
            `fullWidth` sizes to its own label, so the ragged right edge she saw in English
            is a DIFFERENT ragged edge in Hindi ("ज़रूरत पड़ने पर दवाइयाँ" is far longer
            than "As-Needed Medicines"). A control whose geometry is decided by translation
            length cannot be aligned with anything, at any scale, in either language.

            SIDE BY SIDE WAS THE OTHER CANDIDATE AND IT IS WORSE. Two half-width buttons
            with these labels wrap to three lines at OS 1.3× — see the header of
            `Button.tsx` for the clipped-mid-label footer that shape produced on device.

            SO: identical geometry, full width, `lg`, `secondary`. What is left to carry
            the difference between them is not geometry and does not need to be — position
            (sharing is last, at the exit of the screen), the caption that belongs to
            "Share Today" alone, and the verbs themselves.

            STILL NOT `variant="primary"`: a solid `colors.primary` slab measures 5.48:1
            against this page and would out-shout the dose card, which is the one object
            allowed to shout. And still not `ghost`, whose label sits at 5.48:1 — past
            WCAG AA, under this app's own ≥7:1 floor. `secondary` puts both labels on
            `bgElevated` at 15.91:1 light / 11.32:1 dark. Both are 64dp tall.

            VERTICAL BUDGET: +8dp against the previous pair (56 → 64 on the first button),
            all of it below the fold in every state the budget table above covers. ── */}
        <View style={{ gap: INNER_GAP }}>
          <Button
            title={t('today.asNeeded')}
            onPress={() => router.push('/dose/prn')}
            variant="secondary"
            size="lg"
            fullWidth
          />
          <Button
            title={t('today.share')}
            onPress={() => router.push('/report/day')}
            variant="secondary"
            size="lg"
            fullWidth
          />
          <Text variant="caption" tone="muted">
            {t('today.shareHint')}
          </Text>
        </View>

        {/* ── Streak. Quiet, last, and never punitive — there is no "you lost it". ── */}
        {data && data.streak.currentStreak > 0 ? (
          <View style={{ alignItems: 'center' }}>
            <Text variant="caption" tone="muted">
              {t('today.streak', { count: data.streak.currentStreak })}
            </Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * A reading as a person would say it — INCLUDING the ones where the meter said a word.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT JUST `formatReadingValue`
 *
 * `formatReadingValue` returns '—' whenever `v1` is null, and it never looks at the
 * qualifier it already has in hand. So a glucose of LO — a hypoglycaemic emergency,
 * and the single reading a doctor would act on fastest — rendered on this screen as
 * '— mg/dL', which reads as "nothing was recorded". It did the same on the son's
 * remote viewer screen.
 *
 * The durable fix is in that shared formatter, so no future screen can forget; it
 * lives in `src/app/_shared/lib.tsx`, which this pass does not own, and it has been
 * reported. This wrapper fixes the two call sites on this screen without touching a
 * file someone else is editing, and it is written to be harmless afterwards: if the
 * shared formatter learns about qualifiers, this branch returns first with the same
 * sentence and nothing is printed twice.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The two halves are returned separately because they are rendered in different
 * places and at different sizes — see the note on `today.meterBelow`.
 */
function readingDisplay(
  reading: Reading,
  t: TranslateFn,
): { value: string; unit: string; inequality: string | null } {
  if (reading.valueQualifier === 'exact') {
    return {
      value: formatReadingValue(reading),
      unit: metricUnit(null, reading.metricKey),
      inequality: null,
    };
  }

  const word =
    reading.valueQualifier === 'below_range' ? t('reading.qualifierLow') : t('reading.qualifierHigh');
  const bound = reading.qualifierBound;
  // No recorded meter range is a complete record, not a broken one: the meter said LO
  // and nobody has yet told the app what LO means on her particular device.
  if (bound === null || !Number.isFinite(bound)) return { value: word, unit: '', inequality: null };

  return {
    value: word,
    unit: '',
    inequality: t(
      reading.valueQualifier === 'below_range' ? 'today.meterBelow' : 'today.meterAbove',
      { bound: trimNumber(bound), unit: metricUnit(null, reading.metricKey) },
    ),
  };
}

/**
 * Where a censored reading sits against a target — but only where the record PROVES it.
 *
 * LO means `value < bound`. If the meter's floor is at or below the target's floor, then
 * `value < target.low` is proven and the card may say "Below your target". If the floor
 * sits INSIDE the target the true value could be either side of it, and the card says
 * nothing rather than the likely thing. `censoredVsTarget` carries that proof and is unit
 * tested; the rule is written out in full in `src/features/reports/data/censored.ts`.
 */
function censoredRange(reading: Reading, target: TargetRange | null): StatRange {
  const direction = censoredDirection(reading.valueQualifier);
  if (!direction || !target) return 'unknown';
  return censoredVsTarget(direction, reading.qualifierBound, target) === 'outside'
    ? direction
    : 'unknown';
}

/** Metric label, without a second round trip to `metric_def` just for a heading. */
function metricLabelKey(metricKey: string, t: (key: string) => string): string {
  if (metricKey === METRIC_BP) return t('entry.bp.title');
  if (metricKey === METRIC_SUGAR) return t('entry.sugar.title');
  if (metricKey === METRIC_WEIGHT) return t('entry.weight.title');
  return metricKey;
}
