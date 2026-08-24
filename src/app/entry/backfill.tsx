/**
 * Filling in days that have already passed — the night before an OPD visit.
 *
 * ─── THIS FILE ALSO OWNS THE `?date=…&time=…` CONTRACT ────────────────────────
 * Every entry screen accepts `?date` and `?time`, and every one of them has to turn
 * those two strings into an `atEpoch`. Four independent implementations of that
 * conversion is four chances for one screen to file a reading on the wrong day, which
 * is a defect nobody notices until a doctor is reading the printout. So the conversion,
 * the compact time control that edits it, and the soft "did you mean?" dialog all live
 * here — the module that owns the flow which produces those params — and the four entry
 * screens import them. `src/app/_shared/lib.tsx` belongs to another author and cannot
 * hold them.
 *
 * The soft-confirm in particular is written ONCE on purpose: `shouldPromptPlausibility`
 * is advisory, and the one way it can turn into a refusal is a screen that reimplements
 * the dialog and forgets the "yes, that is what it showed" path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { useI18n, type TranslateFn } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  BigButtonGrid,
  Button,
  Card,
  Dialog,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
} from '@/components/ui';
import { ActiveProfileTag } from '@/app/profiles/_lib';
import { addDays, toLocalDate, wallClockToEpoch } from '@/lib/datetime';
import {
  METRIC_BP,
  METRIC_SUGAR,
  METRIC_WEIGHT,
  fixedItemLayout,
  formatReadingValue,
  isWallClock,
  metricUnit,
  resolveProfileId,
  trimNumber,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { listReadings, type InstrumentBoundsError, type PlausibilityWarning } from '@/db/repositories/readings';
import { listSymptomDefs, listSymptomEvents } from '@/db/repositories/symptoms';
import type { Reading, SymptomEvent } from '@/types';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared entry-screen strings
// ═══════════════════════════════════════════════════════════════════════════════

export const ENTRY_COMMON_STRINGS: LocalStrings = {
  'entry.when.recordingFor': {
    en: 'Recording for {{date}}, {{time}}',
    hi: '{{date}}, {{time}} बजे के लिए दर्ज हो रहा है',
  },
  'entry.when.change': { en: 'Change the time', hi: 'समय बदलें' },
  'entry.when.timeTitle': { en: 'What time was it?', hi: 'यह किस समय था?' },
  'entry.when.hour': { en: 'Hour', hi: 'घंटा' },
  'entry.when.minute': { en: 'Minute', hi: 'मिनट' },
  'entry.when.hourEarlier': { en: 'One hour earlier', hi: 'एक घंटा पहले' },
  'entry.when.hourLater': { en: 'One hour later', hi: 'एक घंटा बाद' },
  'entry.when.minuteEarlier': { en: 'Five minutes earlier', hi: 'पाँच मिनट पहले' },
  'entry.when.minuteLater': { en: 'Five minutes later', hi: 'पाँच मिनट बाद' },

  'entry.check.title': { en: 'Please check this number', hi: 'यह नंबर एक बार जाँच लें' },
  'entry.check.message': {
    en: 'This is different from most readings. If that is what the machine showed, save it exactly as it is.',
    hi: 'यह ज़्यादातर रीडिंग से अलग है। अगर मशीन पर यही दिख रहा था, तो इसे वैसे ही सेव करें।',
  },
  'entry.check.fieldLine': { en: '{{label}}: {{value}}', hi: '{{label}}: {{value}}' },
  'entry.check.confirm': { en: 'Yes, that is what it showed', hi: 'हाँ, यही दिख रहा था' },

  'entry.bounds.title': { en: 'This number could not be saved', hi: 'यह नंबर सेव नहीं हो पाया' },
  // Direction-neutral on purpose: the bound can be crossed from either side, and a
  // message that says "too high" about a value that was too low sends her hunting for
  // the wrong mistake.
  'entry.bounds.message': {
    en: '{{label}} of {{value}} is outside what any machine can show. Your numbers are still on the screen — please check them once and send them again.',
    hi: '{{label}} {{value}} — कोई भी मशीन ऐसा नंबर नहीं दिखाती। आपके नंबर अभी भी स्क्रीन पर हैं, एक बार जाँचकर फिर से भेजें।',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// `?date=…&time=…` → atEpoch
// ═══════════════════════════════════════════════════════════════════════════════

/** The time a tile hands to an entry screen when only a date has been chosen. */
export const DEFAULT_BACKFILL_TIME = '09:00';

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Moves a wall-clock time by whole minutes, wrapping inside the same day.
 *
 * Wrapping rather than clamping keeps the two step controls independent — pressing
 * "one hour earlier" at 00:30 gives 23:30 on the SAME date, and the date is only ever
 * changed by the date stepper. A control that silently moved the reading to another day
 * would be the exact error this screen exists to prevent.
 */
export function shiftWallClock(time: string, deltaMinutes: number): string {
  const parts = time.split(':');
  const hours = Number(parts[0] ?? '0');
  const minutes = Number(parts[1] ?? '0');
  const base = (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  const total = (((base + deltaMinutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

export type EntryWhen = {
  /** True only when the screen was opened for a day that has already passed. */
  isBackfill: boolean;
  localDate: string;
  timeLocal: string;
  setTimeLocal: (next: string) => void;
  /**
   * `undefined` means "let the repository stamp the clock". `createReading` derives
   * `was_backfilled` from this value, so a screen that fabricated `Date.now()` here
   * would file every backfilled reading as if it had been taken at the meter.
   */
  atEpoch: number | undefined;
  /** ReadBackDialog `detail` — names the date and time the row will carry. */
  readBackDetail: string | undefined;
};

export function useEntryWhen(): EntryWhen {
  const params = useLocalSearchParams<{ date?: string | string[]; time?: string | string[] }>();
  const t = useT(ENTRY_COMMON_STRINGS);
  const { formatDate, formatTime } = useDateFormat();

  const dateParam = firstParam(params.date);
  const timeParam = firstParam(params.time);

  const today = toLocalDate();
  // A malformed date, or one that has not happened yet, is not a backfill — it is a bad
  // deep link, and the only safe reading of a bad link is "this is happening now".
  const backfillDate =
    dateParam && LOCAL_DATE_PATTERN.test(dateParam) && dateParam <= today ? dateParam : null;

  const [timeLocal, setTimeLocal] = useState<string>(() =>
    timeParam && isWallClock(timeParam) ? timeParam : DEFAULT_BACKFILL_TIME,
  );

  const localDate = backfillDate ?? today;
  const atEpoch = backfillDate ? wallClockToEpoch(backfillDate, timeLocal) : undefined;

  return {
    isBackfill: backfillDate !== null,
    localDate,
    timeLocal,
    setTimeLocal,
    atEpoch,
    readBackDetail: backfillDate
      ? t('readBack.recordedAt', { date: formatDate(backfillDate), time: formatTime(timeLocal) })
      : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// The time control
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hour and minute steppers.
 *
 * NOT a native time picker. Several OEM skins render the platform picker in 12-hour form
 * regardless of the app's own formatting, and an am/pm marker misread on a reading — or
 * on a dose — is a twelve-hour error in a record a doctor will act on. Two large plus and
 * minus keys are unambiguous, tremor-friendly, and identical on every handset.
 */
export function TimeStepper({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useT(ENTRY_COMMON_STRINGS);
  const { colors } = useTheme();
  const { formatTime } = useDateFormat();

  const shown = formatTime(value);
  const parts = shown.split(':');

  const key = (icon: 'minus' | 'plus', label: string, onPress: () => void) => (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: spacing.touchTarget,
        height: spacing.touchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgElevated,
      }}
    >
      <Icon name={icon} size={26} color={colors.text} />
    </PressableScale>
  );

  const row = (
    label: string,
    shownValue: string,
    minusLabel: string,
    plusLabel: string,
    delta: number,
  ) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <Text variant="label" style={{ flex: 1 }}>
        {label}
      </Text>
      {key('minus', minusLabel, () => onChange(shiftWallClock(value, -delta)))}
      {/* Labelled live region so TalkBack speaks '<Hour|Minute> <value>' on every step;
          a bare '08' next to the caption reads without a unit and steps announce nothing. */}
      <Text
        variant="title"
        align="center"
        style={{ minWidth: 56 }}
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${label} ${shownValue}`}
      >
        {shownValue}
      </Text>
      {key('plus', plusLabel, () => onChange(shiftWallClock(value, delta)))}
    </View>
  );

  return (
    <View style={{ gap: spacing.md }}>
      {row(
        t('entry.when.hour'),
        parts[0] ?? '00',
        t('entry.when.hourEarlier'),
        t('entry.when.hourLater'),
        60,
      )}
      {row(
        t('entry.when.minute'),
        parts[1] ?? '00',
        t('entry.when.minuteEarlier'),
        t('entry.when.minuteLater'),
        5,
      )}
    </View>
  );
}

/**
 * The one-line "recording for 7 August, 09:00 — change the time" bar.
 *
 * Deliberately a single 56dp row rather than the steppers inline: on the blood-pressure
 * screen it sits above a number pad that already fills a small handset in large-text
 * mode, and pushing the Save button off the bottom to save two taps is a bad trade.
 */
export function EntryWhenBar({ when }: { when: EntryWhen }) {
  const t = useT(ENTRY_COMMON_STRINGS);
  const { colors } = useTheme();
  const { formatDate, formatTime } = useDateFormat();
  const [open, setOpen] = useState(false);

  if (!when.isBackfill) return null;

  const sentence = t('entry.when.recordingFor', {
    date: formatDate(when.localDate),
    time: formatTime(when.timeLocal),
  });

  return (
    <View>
      <PressableScale
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={sentence}
        accessibilityHint={t('entry.when.change')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          minHeight: spacing.touchTarget,
          paddingHorizontal: spacing.md,
          borderRadius: radii.md,
          borderWidth: 2,
          borderColor: colors.borderStrong,
          backgroundColor: colors.bgSunken,
        }}
      >
        <Icon name="clock" size={24} color={colors.textMuted} />
        <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>
          {sentence}
        </Text>
        <Text variant="body" tone="primary" weight="600">
          {t('common.change')}
        </Text>
      </PressableScale>

      <Dialog
        visible={open}
        title={t('entry.when.timeTitle')}
        onRequestClose={() => setOpen(false)}
        footer={
          <Button
            title={t('common.done')}
            onPress={() => setOpen(false)}
            variant="primary"
            size="lg"
            fullWidth
          />
        }
      >
        <TimeStepper value={when.timeLocal} onChange={when.setTimeLocal} />
      </Dialog>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The soft "did you mean?" step
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A CONFIRMATION, NEVER A REFUSAL.
 *
 * `shouldPromptPlausibility` returns every field that fell outside its soft band. A
 * glucose of 42 is not a typo to be corrected away — it is the reading a doctor would act
 * on fastest — so the affirmative button writes the value completely unchanged, and there
 * is no third button that edits or clamps anything.
 */
export function PlausibilityDialog({
  visible,
  warnings,
  labelFor,
  onCorrect,
  onConfirm,
}: {
  visible: boolean;
  warnings: readonly PlausibilityWarning[];
  /** Already-translated field name for a warning. */
  labelFor: (warning: PlausibilityWarning) => string;
  onCorrect: () => void;
  onConfirm: () => void;
}) {
  const t = useT(ENTRY_COMMON_STRINGS);

  return (
    <Dialog
      visible={visible}
      title={t('entry.check.title')}
      // A stray tap outside must not resolve a step that gates a write; hardware back
      // means "let me look at it again", which is the harmless direction.
      dismissOnBackdrop={false}
      onRequestClose={onCorrect}
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('readBack.correct')}
            onPress={onCorrect}
            variant="secondary"
            size="lg"
            fullWidth
          />
          <Button
            title={t('entry.check.confirm')}
            onPress={onConfirm}
            variant="primary"
            size="lg"
            fullWidth
          />
        </View>
      }
    >
      <View style={{ gap: spacing.md }}>
        {warnings.map((warning) => (
          <Text key={warning.slot} variant="title">
            {t('entry.check.fieldLine', {
              label: labelFor(warning),
              value: trimNumber(warning.value),
            })}
          </Text>
        ))}
        <Text variant="body" tone="muted">
          {t('entry.check.message')}
        </Text>
      </View>
    </Dialog>
  );
}

/** The kind, specific sentence for the one error `createReading` can refuse a value with. */
export function instrumentBoundsMessage(
  t: TranslateFn,
  error: InstrumentBoundsError,
  label: string,
): string {
  return t('entry.bounds.message', { label, value: trimNumber(error.value) });
}

// ═══════════════════════════════════════════════════════════════════════════════
// The backfill screen
// ═══════════════════════════════════════════════════════════════════════════════

const STRINGS: LocalStrings = {
  ...ENTRY_COMMON_STRINGS,
  'entry.backfill.title': { en: 'Fill in an earlier day', hi: 'पिछला दिन भरें' },
  'entry.backfill.subtitle': {
    en: 'Add what you remember for a day that has already gone by.',
    hi: 'जो दिन बीत चुका है, उसके लिए जो याद है वह जोड़ें।',
  },
  'entry.backfill.previousDay': { en: 'The day before', hi: 'एक दिन पहले' },
  'entry.backfill.nextDay': { en: 'The day after', hi: 'एक दिन बाद' },
  'entry.backfill.noFuture': {
    en: 'Today is as far as this goes. A day that has not happened yet cannot be filled in.',
    hi: 'आज तक ही जा सकते हैं। जो दिन अभी आया ही नहीं, वह नहीं भरा जा सकता।',
  },
  'entry.backfill.noticeMessage': {
    en: 'Anything you add here is kept in your record as added later, and the copy your doctor sees will say the same. That is only about when it was written down, not about the reading itself.',
    hi: 'यहाँ जो भी जोड़ेंगी वह आपके रिकॉर्ड में “बाद में जोड़ा गया” के रूप में रहेगा, और डॉक्टर वाली कॉपी में भी यही लिखा रहेगा। यह सिर्फ़ लिखने के समय के बारे में है, रीडिंग के बारे में नहीं।',
  },
  'entry.backfill.timeForNew': { en: 'Time for what you add next', hi: 'अब जो जोड़ेंगी उसका समय' },
  'entry.backfill.addForDay': { en: 'Add for this day', hi: 'इस दिन के लिए जोड़ें' },
  'entry.backfill.tileRecorded': { en: '{{count}} already recorded', hi: '{{count}} पहले से दर्ज' },
  'entry.backfill.alreadyRecorded': { en: 'Already on this day', hi: 'इस दिन पहले से' },
  'entry.backfill.nothingYet': { en: 'Nothing recorded for this day', hi: 'इस दिन कुछ दर्ज नहीं है' },
  'entry.backfill.nothingYetMessage': {
    en: 'Use the four buttons above to add what you remember.',
    hi: 'ऊपर दिए चार बटनों से जो याद है वह जोड़ें।',
  },
  'entry.backfill.rowValue': { en: '{{label}}: {{value}} {{unit}}', hi: '{{label}}: {{value}} {{unit}}' },
  'entry.backfill.rowValueNoUnit': { en: '{{label}}: {{value}}', hi: '{{label}}: {{value}}' },
  'entry.backfill.detailJoin': { en: '{{a}} · {{b}}', hi: '{{a}} · {{b}}' },
};

const ROW_HEIGHT = 88;

/** Registry context value → the suffix of its `entry.sugar.context.*` bundle key. */
const SUGAR_CONTEXT_I18N: Record<string, string> = {
  fasting: 'fasting',
  before_meal: 'beforeMeal',
  after_meal: 'afterMeal',
  bedtime: 'bedtime',
  random: 'random',
};

type DayData = {
  bp: Reading[];
  sugar: Reading[];
  weight: Reading[];
  symptoms: SymptomEvent[];
  symptomLabels: Record<string, { en: string; hi: string }>;
};

type DayRow = { id: string; title: string; detail: string };

export default function BackfillScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const { formatDayLabel, formatWeekday, formatTime } = useDateFormat();
  // Symptom labels live in the database in both languages, so the row builder has to
  // pick a column — `t()` cannot help with a value that is not a bundle key.
  const { lang } = useI18n();

  const today = toLocalDate();
  const [date, setDate] = useState<string>(() => addDays(today, -1));
  const [timeLocal, setTimeLocal] = useState<string>(DEFAULT_BACKFILL_TIME);

  const isToday = date >= today;

  const day = useAsync<DayData>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) throw new Error('No profile is set up on this device yet.');
    const oneDay = { fromDate: date, toDate: date };
    const [bp, sugar, weight, symptoms, defs] = await Promise.all([
      listReadings(profileId, METRIC_BP, oneDay),
      listReadings(profileId, METRIC_SUGAR, oneDay),
      listReadings(profileId, METRIC_WEIGHT, oneDay),
      listSymptomEvents(profileId, oneDay),
      listSymptomDefs(),
    ]);
    const symptomLabels: Record<string, { en: string; hi: string }> = {};
    for (const def of defs) symptomLabels[def.key] = { en: def.labelEn, hi: def.labelHi };
    return { bp, sugar, weight, symptoms, symptomLabels };
  }, [date]);

  // Coming back from an entry screen must show what was just added, without a refresh
  // gesture this user has no reason to know about.
  useReloadOnFocus(day.reload);

  const join = useCallback(
    (parts: (string | null)[]): string =>
      parts
        .filter((part): part is string => Boolean(part))
        .reduce((acc, part) => (acc === '' ? part : t('entry.backfill.detailJoin', { a: acc, b: part })), ''),
    [t],
  );

  const rows = useMemo<DayRow[]>(() => {
    const data = day.data;
    if (!data) return [];
    const out: DayRow[] = [];

    const pushReading = (reading: Reading, label: string) => {
      const context = reading.context?.['meal'];
      // A meter that printed LO or HI never gave us a number, and an em dash in its place
      // would read as "nothing was recorded" for a reading that is anything but.
      const isExact = reading.valueQualifier === 'exact';
      out.push({
        id: reading.id,
        title: isExact
          ? t('entry.backfill.rowValue', {
              label,
              value: formatReadingValue(reading),
              unit: metricUnit(null, reading.metricKey),
            })
          : t('entry.backfill.rowValueNoUnit', {
              label,
              value:
                reading.valueQualifier === 'below_range'
                  ? t('reading.qualifierLow')
                  : t('reading.qualifierHigh'),
            }),
        detail: join([
          formatTime(reading.localTime),
          context ? t(`entry.sugar.context.${SUGAR_CONTEXT_I18N[context] ?? context}`) : null,
          reading.wasBackfilled ? t('reading.backfilled') : null,
        ]),
      });
    };

    for (const reading of data.bp) pushReading(reading, t('entry.bp.tile'));
    for (const reading of data.sugar) pushReading(reading, t('entry.sugar.tile'));
    for (const reading of data.weight) pushReading(reading, t('entry.weight.tile'));

    for (const event of data.symptoms) {
      const known = event.symptomKey ? data.symptomLabels[event.symptomKey] : undefined;
      const title = known ? (lang === 'hi' ? known.hi : known.en) : (event.customLabel ?? t('common.unknown'));
      out.push({
        id: event.id,
        title,
        detail: join([
          formatTime(event.localTime),
          event.severity ? t(`entry.symptom.severity.${event.severity}`) : null,
        ]),
      });
    }
    return out;
  }, [day.data, t, join, formatTime, lang]);

  const openEntry = useCallback(
    (path: string) => {
      router.push(`${path}?date=${date}&time=${timeLocal}`);
    },
    [date, timeLocal],
  );

  const counts = day.data;
  const tiles = [
    {
      key: 'bp',
      label: t('entry.bp.tile'),
      sublabel: counts && counts.bp.length > 0 ? t('entry.backfill.tileRecorded', { count: counts.bp.length }) : undefined,
      onPress: () => openEntry('/entry/bp'),
    },
    {
      key: 'sugar',
      label: t('entry.sugar.tile'),
      sublabel:
        counts && counts.sugar.length > 0 ? t('entry.backfill.tileRecorded', { count: counts.sugar.length }) : undefined,
      onPress: () => openEntry('/entry/sugar'),
    },
    {
      key: 'weight',
      label: t('entry.weight.tile'),
      sublabel:
        counts && counts.weight.length > 0 ? t('entry.backfill.tileRecorded', { count: counts.weight.length }) : undefined,
      onPress: () => openEntry('/entry/weight'),
    },
    {
      key: 'symptom',
      label: t('entry.symptom.tile'),
      sublabel:
        counts && counts.symptoms.length > 0
          ? t('entry.backfill.tileRecorded', { count: counts.symptoms.length })
          : undefined,
      onPress: () => openEntry('/entry/symptom'),
    },
  ];

  const stepperKey = (
    icon: 'chevronLeft' | 'chevronRight',
    label: string,
    onPress: () => void,
    disabled: boolean,
  ) => (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        width: spacing.touchTargetLarge,
        height: spacing.touchTargetLarge,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: disabled ? colors.border : colors.borderStrong,
        backgroundColor: disabled ? colors.bgSunken : colors.bgElevated,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon name={icon} size={30} color={disabled ? colors.textMuted : colors.primary} />
    </PressableScale>
  );

  const header = (
    <View style={{ gap: spacing.md }}>
      <ScreenHeader
        title={t('entry.backfill.title')}
        subtitle={t('entry.backfill.subtitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />

      {/* Whose record this is — the active profile is a device-global pointer a carer can
          have switched, and back-dating fills real health data. No-ops when solo. */}
      <ActiveProfileTag />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          {stepperKey('chevronLeft', t('entry.backfill.previousDay'), () => setDate(addDays(date, -1)), false)}
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="title" align="center">
              {formatDayLabel(date)}
            </Text>
            <Text variant="caption" tone="muted" align="center">
              {formatWeekday(date)}
            </Text>
          </View>
          {/* Forward is off on today. There is no honest reading to record for a day
              that has not happened, and a date stepper that walks into next week is how
              a reading ends up filed in the future where no report will ever show it. */}
          {stepperKey('chevronRight', t('entry.backfill.nextDay'), () => setDate(addDays(date, 1)), isToday)}
        </View>
        {isToday ? (
          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.md }}>
            {t('entry.backfill.noFuture')}
          </Text>
        ) : null}
      </Card>

      <Banner variant="info" title={t('reading.backfilled')} message={t('entry.backfill.noticeMessage')} />

      <Card variant="sunken">
        <View style={{ gap: spacing.md }}>
          <Text variant="label">{t('entry.backfill.timeForNew')}</Text>
          <TimeStepper value={timeLocal} onChange={setTimeLocal} />
        </View>
      </Card>

      <SectionHeader title={t('entry.backfill.addForDay')} />
      <BigButtonGrid items={tiles} />

      <SectionHeader title={t('entry.backfill.alreadyRecorded')} />
      {day.loading ? <Skeleton height={ROW_HEIGHT} label={t('a11y.loading')} /> : null}
      {day.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={day.reload}
        />
      ) : null}
    </View>
  );

  return (
    <Screen variant="fixed" background="bgSunken">
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(item) => item.id}
        getItemLayout={fixedItemLayout(ROW_HEIGHT)}
        ListHeaderComponent={header}
        ListEmptyComponent={
          day.loading || day.error ? null : (
            <EmptyState
              title={t('entry.backfill.nothingYet')}
              message={t('entry.backfill.nothingYetMessage')}
            />
          )
        }
        renderItem={({ item }) => (
          // The outer box is exactly ROW_HEIGHT, gap included, because `getItemLayout`
          // promises that number to FlatList and a row that is really 8dp taller makes
          // the scroll position drift further out with every item.
          <View style={{ height: ROW_HEIGHT, paddingBottom: spacing.sm }}>
            <View
              accessible
              accessibilityLabel={`${item.title}. ${item.detail}`}
              style={{
                flex: 1,
                justifyContent: 'center',
                gap: spacing.xs,
                paddingHorizontal: spacing.lg,
                borderRadius: radii.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.bgElevated,
              }}
            >
              <Text variant="body" weight="600" numberOfLines={1}>
                {item.title}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {item.detail}
              </Text>
            </View>
          </View>
        )}
      />
    </Screen>
  );
}
