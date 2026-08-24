/**
 * The pieces BOTH slot screens draw — one copy, so they cannot disagree again.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `src/app/setup/slots.tsx` and `src/app/settings/slots.tsx` lay out the same nine times.
 * Both files said, in their own headers, that they were verbatim copies of each other and
 * that a shared component "would have to live under `src/app/`, where Expo Router would
 * turn it into a route". That was never quite true — `src/features/` has always been
 * reachable — and the copies were not identical either:
 *
 *   • setup drew the stepper as `[−] label [+]`, with the two buttons at opposite ends of
 *     the dialog. settings drew it as `label [−][+]`, with the two buttons 12dp apart.
 *     Adjacent opposite-direction controls are the arrangement most likely to be hit in
 *     the wrong direction by a hand with a tremor, and settings is the screen she comes
 *     back to every time a meal time drifts. `[−] label [+]` wins, everywhere.
 *
 *   • TalkBack heard two different sentences for the same button. setup announced
 *     "नाश्ते से पहले: एक घंटा बाद" — slot-qualified, but बाद/पहले, which on THIS screen a
 *     Hindi speaker hears as a meal relation ("after"), not a direction on a clock.
 *     settings announced a bare "एक घंटा आगे" — the right Hindi, but with nothing saying
 *     WHICH time is moving. Now: the registry's आगे/पीछे wording, qualified with the slot
 *     name. A blind user who learns one screen has learnt the other.
 *
 *   • The arithmetic had drifted into an outright bug. settings moved the minutes with a
 *     private `shiftTime` that snapped to the five-minute grid but never carried into the
 *     hour: from 08:55, "five minutes later" landed on 08:00 — an hour EARLIER, on the one
 *     control whose whole job is to be unambiguous. Everything here moves time through
 *     `stepWallClock` in the registry, which is pure and is tested.
 *
 * So the rule the two headers were asking for is now enforced by there being one copy.
 *
 * ─── HOW THE STRINGS WORK ─────────────────────────────────────────────────────
 * These components take `t` as a PROP rather than calling `useT` themselves, exactly as
 * `slotLabel(def, t)` already does — it keeps `src/features/` from depending on
 * `src/app/`, and it means the screen's own language state drives everything on it.
 *
 * The price is one line per screen: a screen that draws any of this MUST spread
 * `SLOT_EDITOR_STRINGS` into its own `STRINGS` map, or the shared markup renders raw key
 * paths. `SLOT_EDITOR_STRINGS` re-spreads `SLOT_STRINGS`, so that one line is the whole
 * obligation — a screen never needs both.
 *
 * Every key used below is written as a literal HERE, in the same file that declares it,
 * which is what `scripts/check-i18n.js` needs to resolve it. Slot names and the shared
 * "your own times" copy go through `slotI18nKey()` / `SLOT_OWN_TIME_KEYS` instead, because
 * those live in the registry and the checker only resolves a quoted key against the file
 * it is written in. See the long note above `SLOT_STRINGS`.
 */

import React from 'react';
import { View } from 'react-native';

import { Card, Icon, PressableScale, Text } from '@/components/ui';
import type { TranslateFn } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';

import {
  BUILTIN_SLOT_KEYS,
  SLOT_MINUTE_STEP,
  SLOT_OWN_TIME_KEYS,
  SLOT_STRINGS,
  slotI18nKey,
  type BuiltinSlotKey,
  type SlotStrings,
} from './registry';

/**
 * The three groups the nine slots read as, plus the row and stepper wording.
 *
 * `...SLOT_STRINGS` first so a screen spreads exactly one map: the slot names, the shared
 * "a time of your own" copy and the layout's own strings arrive together, and there is no
 * way to end up with a screen that has half of them.
 */
export const SLOT_EDITOR_STRINGS: SlotStrings = {
  ...SLOT_STRINGS,

  'slots.groupMorning': { en: 'Morning', hi: 'सुबह' },
  // 'दोपहर और खाना', not 'दोपहर और दोपहर का खाना'. With the three rows under it the longer
  // form put the word दोपहर on screen five times in one card; the English reader saw
  // "Midday and lunch" over Midday / Before lunch / After lunch and had strictly less work
  // to do. See the note on `slots.midday` in the registry.
  'slots.groupMidday': { en: 'Midday and lunch', hi: 'दोपहर और खाना' },
  'slots.groupEvening': { en: 'Evening and night', hi: 'शाम और रात' },

  'slots.rowHint': {
    en: 'Opens the buttons to move this time',
    hi: 'इस समय को बदलने के बटन खुलते हैं',
  },
  'slots.changeTitle': { en: 'Change {{slot}}', hi: '{{slot}} बदलें' },
  'slots.conflictRow': { en: 'Same time as {{other}}', hi: '{{other}} के समय जैसा ही' },

  /**
   * A stepper's TalkBack label, with the slot it moves in front of it.
   *
   * A template rather than `${name}: ${action}` in code, because the separator is
   * punctuation and punctuation is translated — and because a screen reader pauses at it,
   * which is the whole point of qualifying the label at all.
   */
  'slots.stepFor': { en: '{{slot}}: {{action}}', hi: '{{slot}}: {{action}}' },
};

type SlotGroupKey = 'slots.groupMorning' | 'slots.groupMidday' | 'slots.groupEvening';

/**
 * A `Record` over `BuiltinSlotKey` RATHER THAN a hand-written list of groups, so the
 * grouping is total by construction: add a tenth key to the registry and this file stops
 * compiling until it has been placed. A list would simply have dropped the new slot off
 * the only screens that can set it, silently, and a slot nobody can set is a reminder
 * nobody can move.
 *
 * Grouped by the part of the DAY, not by the meal, because that is the question the user
 * is actually asking ("where is my evening one?").
 */
const GROUP_OF: Readonly<Record<BuiltinSlotKey, SlotGroupKey>> = {
  before_breakfast: 'slots.groupMorning',
  after_breakfast: 'slots.groupMorning',
  midday: 'slots.groupMidday',
  before_lunch: 'slots.groupMidday',
  after_lunch: 'slots.groupMidday',
  evening: 'slots.groupEvening',
  before_dinner: 'slots.groupEvening',
  after_dinner: 'slots.groupEvening',
  bedtime: 'slots.groupEvening',
};

const GROUP_ORDER: readonly SlotGroupKey[] = [
  'slots.groupMorning',
  'slots.groupMidday',
  'slots.groupEvening',
];

/** Order WITHIN a group comes from the registry's canonical clock order, so a group always
 *  reads top to bottom in time no matter how `GROUP_OF` happens to be written. */
export const SLOT_GROUPS: readonly {
  readonly titleKey: SlotGroupKey;
  readonly slots: readonly BuiltinSlotKey[];
}[] = GROUP_ORDER.map((titleKey) => ({
  titleKey,
  slots: BUILTIN_SLOT_KEYS.filter((slot) => GROUP_OF[slot] === titleKey),
}));

/** The title of the dialog that moves one slot. Both screens open the same dialog. */
export function slotChangeTitle(t: TranslateFn, slotName: string): string {
  return t('slots.changeTitle', { slot: slotName });
}

/** 'Same time as Evening' — the caption under a row, and the line inside the dialog. */
export function slotConflictLine(t: TranslateFn, otherName: string): string {
  return t('slots.conflictRow', { other: otherName });
}

/**
 * One slot as a row: name, time, chevron. The WHOLE row is the target — 56dp minimum, not
 * a small "change" link at the end of a line of text.
 *
 * Name and time collapse into ONE accessibility node. "Before breakfast" and "08:00"
 * arriving as two separate swipes is two chances to attach the time to the wrong name,
 * and these nine names are deliberately similar to each other.
 *
 * `conflictWith` is the OTHER slot's visible name, or null. Colour is never the only
 * signal: the clash is a sentence under the name, and the same sentence is inside the
 * dialog that opens.
 */
export function SlotRow({
  t,
  name,
  time,
  conflictWith,
  onPress,
}: {
  t: TranslateFn;
  name: string;
  time: string;
  conflictWith: string | null;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const warning = conflictWith === null ? null : slotConflictLine(t, conflictWith);

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={warning ? `${name}, ${time}. ${warning}` : `${name}, ${time}`}
      accessibilityHint={t('slots.rowHint')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: spacing.touchTarget,
        paddingVertical: spacing.sm,
      }}
    >
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="body" weight="600">
          {name}
        </Text>
        {warning ? (
          <Text variant="caption" tone="destructive">
            {warning}
          </Text>
        ) : null}
      </View>
      <Text variant="title">{time}</Text>
      <Icon name="chevronRight" size={24} color={colors.textMuted} />
    </PressableScale>
  );
}

/**
 * The nine built-in slots, as three named cards of rows.
 *
 * The fast path — which is most people, because the defaults are ordinary Indian
 * mealtimes — is READ THREE CARDS AND MOVE ON, with no picker touched at all. The three
 * groups exist so that "which one do I want" is answered by looking at a heading instead
 * of scanning nine names, four of which differ only by before/after.
 */
export function SlotGroupCards({
  t,
  times,
  formatTime,
  conflictNameFor,
  onEdit,
}: {
  t: TranslateFn;
  times: Readonly<Record<BuiltinSlotKey, string>>;
  formatTime: (time: string) => string;
  /** The visible name of the slot this one collides with, or null. */
  conflictNameFor: (slot: BuiltinSlotKey) => string | null;
  onEdit: (slot: BuiltinSlotKey) => void;
}) {
  const { colors } = useTheme();

  return (
    <>
      {SLOT_GROUPS.map((group) => (
        <Card key={group.titleKey} style={{ gap: spacing.xs }}>
          <Text variant="label" accessibilityRole="header">
            {t(group.titleKey)}
          </Text>
          {group.slots.map((slot, index) => (
            <View key={slot}>
              {index > 0 ? <View style={{ height: 1, backgroundColor: colors.border }} /> : null}
              <SlotRow
                t={t}
                name={t(slotI18nKey(slot))}
                time={formatTime(times[slot])}
                conflictWith={conflictNameFor(slot)}
                onPress={() => onEdit(slot)}
              />
            </View>
          ))}
        </Card>
      ))}
    </>
  );
}

/**
 * The number being changed, read back at `display` size.
 *
 * `accessibilityLiveRegion` is what makes the steppers usable with TalkBack: the readout
 * re-announces after every tap, so the user hears the time she is moving to rather than
 * having to hunt back to it after each press.
 */
export function SlotTimeReadout({ name, time }: { name: string; time: string }) {
  const fontSizes = useFontSizes();
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={name ? `${name}, ${time}` : time}
      style={{ alignItems: 'center' }}
    >
      <Text
        style={{
          fontSize: fontSizes.display,
          lineHeight: Math.round(fontSizes.display * 1.2),
          fontWeight: '700',
        }}
      >
        {time}
      </Text>
    </View>
  );
}

/**
 * One ± pair with its label between them.
 *
 * 72×56 — wider than the 56dp minimum, because these two are pressed repeatedly and in
 * opposite directions — and separated by the whole width of the label, which is the
 * arrangement a hand with a tremor is least likely to get the wrong way round.
 */
function StepButton({
  direction,
  label,
  onPress,
}: {
  direction: 'up' | 'down';
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: spacing.touchTargetLarge,
        height: spacing.touchTarget,
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgElevated,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name={direction === 'up' ? 'plus' : 'minus'}
        size={28}
        color={colors.primary}
        strokeWidth={2.6}
      />
    </PressableScale>
  );
}

/**
 * The clock control: an hour row and a minute row, `[−] label [+]`.
 *
 * Minutes move in fives. A doctor says "eight o'clock", never "eight-oh-seven", and sixty
 * taps to cross an hour is not a control. `onShift` is handed a signed number of MINUTES —
 * ±60 or ±`SLOT_MINUTE_STEP` — and the caller moves the time with `stepWallClock`, which
 * wraps at midnight rather than clamping.
 *
 * `slotName` qualifies every TalkBack label ("Before breakfast: one hour later"), so a
 * user swiping through four buttons is never told only the direction. It is optional
 * because a brand-new time of her own has no name yet — the form opens with the field
 * empty — and ": one hour later" announced with nothing in front of the colon is worse
 * than the plain sentence.
 */
export function SlotStepper({
  t,
  slotName,
  onShift,
}: {
  t: TranslateFn;
  slotName?: string;
  onShift: (deltaMinutes: number) => void;
}) {
  const qualify = (action: string): string => {
    const name = slotName?.trim() ?? '';
    return name === '' ? action : t('slots.stepFor', { slot: name, action });
  };

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <StepButton
          direction="down"
          label={qualify(t(SLOT_OWN_TIME_KEYS.hourDown))}
          onPress={() => onShift(-60)}
        />
        <Text variant="body" align="center" tone="muted" style={{ flex: 1 }}>
          {t(SLOT_OWN_TIME_KEYS.hour)}
        </Text>
        <StepButton
          direction="up"
          label={qualify(t(SLOT_OWN_TIME_KEYS.hourUp))}
          onPress={() => onShift(60)}
        />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <StepButton
          direction="down"
          label={qualify(t(SLOT_OWN_TIME_KEYS.minuteDown))}
          onPress={() => onShift(-SLOT_MINUTE_STEP)}
        />
        <Text variant="body" align="center" tone="muted" style={{ flex: 1 }}>
          {t(SLOT_OWN_TIME_KEYS.minute)}
        </Text>
        <StepButton
          direction="up"
          label={qualify(t(SLOT_OWN_TIME_KEYS.minuteUp))}
          onPress={() => onShift(SLOT_MINUTE_STEP)}
        />
      </View>
    </>
  );
}
