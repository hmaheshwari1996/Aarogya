/**
 * Medicines — the list she scans at 08:00 with the strip in her other hand.
 *
 * ─── WHY THE PHOTO IS THE FIRST THING IN EVERY ROW ───────────────────────────
 * "The small white round one" is matchable from a picture and unmatchable from a
 * 9-point drug name. For a user with presbyopia the photo is not decoration; it is
 * the primary identifier, and the name is the confirmation.
 *
 * ─── WHY THE LIST IS GROUPED BY WHEN THE NEXT DOSE FALLS ─────────────────────
 * An alphabetical list answers "what am I on?", which is a question she asks once a
 * month. The question she asks every morning is "what do I take now?", so the rows
 * are grouped under the named slot their next dose belongs to, and each row states
 * the literal clock time as well as the slot name — "Morning" is not a time, and a
 * doctor asking "when do you take it?" wants 08:00.
 *
 * ─── WHY UNCONFIRMED MEDICINES LOOK DIFFERENT AND SAY SO ─────────────────────
 * A medicine no human has checked physically cannot produce a dose occurrence — a
 * database trigger refuses it. A row that looked normal but silently never reminded
 * her would be the worst failure this screen can have, so those rows are taller,
 * carry the words, and lead straight to the screen where she can confirm it.
 *
 * ─── WHY THE PRESCRIPTION CAMERA LIVES HERE ──────────────────────────────────
 * The whole capture flow — photograph, read, check, reconcile — existed with NOTHING
 * anywhere in the app linking to it. Settings had a screen for the AI key and that was
 * all a user could find, so on a real phone the feature simply did not exist. This is
 * the screen someone opens when they want to add a medicine, so this is where the
 * camera belongs, in the footer next to the manual add, in BOTH the empty and the
 * populated state — the empty state is precisely when a new user needs it most.
 *
 * The button is never hidden for want of an AI key. The photograph of the paper is
 * worth having on its own; `prescription/[id]` already makes typing the medicines in
 * the primary action when extraction cannot run.
 *
 * ─── WHY UNFINISHED PRESCRIPTIONS GET THEIR OWN SECTION ──────────────────────
 * A prescription is photographed in a clinic corridor and the phone goes back in the
 * bag. Without a list, that row is unreachable forever: it produced no medicine, so
 * nothing below it mentions it, and no other screen links to a prescription by id.
 * Anything not confirmed AND with no medicine derived from it is shown here, so the
 * capture can be picked up later instead of being silently stranded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  SLOT_STRINGS,
  Thumb,
  resolveSlots,
  slotForRow,
  slotLabel,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
  type SlotDefinition,
} from '@/app/_shared/lib';
import { Button, Card, EmptyState, Screen, ScreenHeader, SectionHeader, Skeleton, Text } from '@/components/ui';
import type { TranslateFn } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { daysBetween, toLocalDate, toLocalTime, ALL_DAYS } from '@/lib/datetime';
import { listCurrentMedicines } from '@/db/repositories/medicines';
import {
  listPrescriptions,
  type Prescription,
  type PrescriptionStatus,
} from '@/db/repositories/prescriptions';
import { getCurrentSchedulesForThreads } from '@/db/repositories/schedules';
import { listStock, needsRefill, projectRunOut, type MedicineStock } from '@/db/repositories/stock';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { DoseSchedule, Medicine } from '@/types';

const STRINGS: LocalStrings = {
  ...SLOT_STRINGS,
  'medicines.groupOther': { en: 'Other times', hi: 'दूसरे समय' },
  'medicines.groupUnscheduled': { en: 'No timings set yet', hi: 'अभी समय तय नहीं हुए' },
  'medicines.nextDose': { en: 'Next dose {{time}}', hi: 'अगली खुराक {{time}}' },
  'medicines.nextDoseSlot': { en: 'Next dose {{slot}}, {{time}}', hi: 'अगली खुराक {{slot}}, {{time}}' },
  'medicines.noTimings': {
    en: 'No timings set yet — tap to add them',
    hi: 'अभी कोई समय तय नहीं — जोड़ने के लिए दबाएँ',
  },
  // ── Counted things, in the singular as well as the plural ──────────────────
  // Every `{{count}}` string below comes in a pair, and `t()` has no plural machinery —
  // the call site picks the key (see `medicineCountLabel` and `stockLabel`). Doing it
  // per-language rather than per-number matters, because the two languages do not agree
  // on where the work is:
  //
  //   English  1 medicine  / 2 medicines      1 day / 2 days          — both inflect
  //   Hindi    1 दवाई      / 2 दवाइयाँ         1 दिन / 2 दिन            — only the first
  //
  // `दवाई` → `दवाइयाँ` is a stem change, not an "s". `दिन` is invariant in this frame
  // ("एक दिन का सामान", "पाँच दिन का सामान"), so the two Hindi day strings below are
  // BYTE-IDENTICAL TO THEIR PLURALS ON PURPOSE. That is the correct Hindi, not a
  // copy-paste slip, and it must not be "fixed" into an invented singular.
  'medicines.daysLeft': { en: '{{count}} days of stock left', hi: '{{count}} दिन का सामान बचा है' },
  'medicines.daysLeftOne': { en: '{{count}} day of stock left', hi: '{{count}} दिन का सामान बचा है' },
  // NOT `medicines.stockLow`, which counts tablets. This one counts days: a number of
  // days dropped into a sentence that says "tablets" reads as a full box and the refill
  // never happens.
  'medicines.daysLeftLow': {
    en: 'Only {{count}} days of stock left',
    hi: 'सिर्फ़ {{count}} दिन का सामान बचा है',
  },
  'medicines.daysLeftLowOne': {
    en: 'Only {{count}} day of stock left',
    hi: 'सिर्फ़ {{count}} दिन का सामान बचा है',
  },
  'medicines.noStockCount': { en: 'Stock not counted yet', hi: 'बचा हुआ सामान अभी गिना नहीं गया' },
  'medicines.stripPhotoOf': { en: 'Photo of the {{name}} strip', hi: '{{name}} की पत्ती की फोटो' },
  'medicines.showStopped': { en: 'Show', hi: 'दिखाएँ' },
  'medicines.hideStopped': { en: 'Hide', hi: 'छिपाएँ' },
  'medicines.openHint': { en: 'Opens this medicine', hi: 'यह दवाई खोलती है' },
  'medicines.stoppedRow': { en: 'Stopped', hi: 'बंद है' },
  'medicines.count': { en: '{{count}} medicines', hi: '{{count}} दवाइयाँ' },
  'medicines.countOne': { en: '{{count}} medicine', hi: '{{count}} दवाई' },

  // ── The prescription camera ────────────────────────────────────────────────
  'medicines.scan': { en: 'Scan a prescription', hi: 'पर्चे की फोटो लें' },
  'medicines.scanHint': {
    en: 'Opens the camera to photograph the prescription',
    hi: 'पर्चे की फोटो लेने के लिए कैमरा खोलता है',
  },

  // ── Prescriptions photographed but never finished ──────────────────────────
  // Short because a section heading should be short. It used to be short because it had
  // to fit a declared row height; rows are measured now, so it may wrap to as many lines
  // as the user's text size needs.
  'medicines.drafts.title': { en: 'Prescriptions to finish', hi: 'अधूरे पर्चे' },
  'medicines.drafts.draft': {
    en: 'Photographed. Nothing has been read from it yet.',
    hi: 'फोटो ले ली गई है। अभी इसमें से कुछ पढ़ा नहीं गया।',
  },
  'medicines.drafts.extracting': {
    en: 'Reading it was started and never finished.',
    hi: 'इसे पढ़ना शुरू हुआ था, पूरा नहीं हुआ।',
  },
  'medicines.drafts.extracted': {
    en: 'Read by the app. Waiting for you to check every line.',
    hi: 'ऐप ने पढ़ लिया है। अब आपको हर पंक्ति जाँचनी है।',
  },
  'medicines.drafts.failed': {
    en: 'The photo could not be read. You can type the medicines in yourself.',
    hi: 'फोटो पढ़ी नहीं जा सकी। आप दवाइयाँ खुद लिख सकती हैं।',
  },
  'medicines.drafts.carryOn': { en: 'Tap to carry on', hi: 'आगे बढ़ने के लिए दबाएँ' },
  'medicines.drafts.openHint': { en: 'Opens this prescription', hi: 'यह पर्चा खोलता है' },
  'medicines.drafts.photoOf': { en: 'Photo of this prescription', hi: 'इस पर्चे की फोटो' },
};

/**
 * ─── THERE ARE NO ROW HEIGHTS IN THIS FILE ANY MORE ──────────────────────────
 * There used to be three — `HEADER_HEIGHT = 76`, `ROW_HEIGHT = 176`,
 * `WARN_ROW_HEIGHT = 272` — feeding a `getItemLayout` that told FlatList where every
 * row started without measuring any of them. Every one of the three was wrong, and the
 * arithmetic is worth writing down because the same temptation will come back:
 *
 *   text scale              header content   declared 76     row content   declared 164
 *   base, OS 1.0×                     54dp   fits                  140dp   fits
 *   large-text 1.25×, OS 1.0×         67dp   fits                  165dp   OVER by 1dp
 *   large-text 1.25×, OS 1.15×        76dp   OVER                  184dp   OVER by 20dp
 *   large-text 1.25×, OS 1.3×         86dp   OVER by 10dp          203dp   OVER by 39dp
 *
 * The constants were calibrated against the app's own 1.25× mode at an OS font scale of
 * exactly 1.0 — the emulator default. They survive nothing else. The row height was
 * already 1dp short before the OS was consulted at all.
 *
 * What an overflow LOOKS like is the reported bug: the cell's box stays 76dp, the
 * content is centred in it and paints 5dp above and below (RN defaults to
 * `overflow: 'visible'`), and the next cell — an opaque `Card` — is a later sibling, so
 * it paints on top. The user sees a subtitle sliced through the middle with the next
 * row's photo placeholder floating over it.
 *
 * Increasing the numbers does not fix this. It re-calibrates them for one more device
 * and leaves the next text size to find. The list is tens of rows, not thousands, so
 * the O(1) offset maths `getItemLayout` buys was never worth a number that can be
 * wrong: FlatList measures each cell instead, and a measured cell cannot disagree with
 * itself. `initialNumToRender` and `windowSize` still bound how much is mounted.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const THUMB = 72;

/**
 * Height of one loading placeholder.
 *
 * The last surviving fixed height, and legitimately so: NOTHING IS POSITIONED FROM IT.
 * A skeleton is a guess about a row that has not loaded yet, drawn before there is any
 * content to measure, so being approximately row-sized is the whole specification. No
 * offset is computed from it and no sibling is placed relative to it, which is exactly
 * what the three constants above could not say for themselves.
 */
const SKELETON_ROW_HEIGHT = 164;

type MedicineRow = {
  medicine: Medicine;
  schedules: DoseSchedule[];
  /** 'HH:MM' of the next fixed dose in the daily cycle, or null. */
  nextTime: string | null;
  /** The named slot that dose falls under, or null when nothing on this phone names it. */
  slot: SlotDefinition | null;
  isPrn: boolean;
  /** Whole days of supply left as of today, or null when never counted. */
  daysLeft: number | null;
  refillDue: boolean;
};

/**
 * ─── THERE IS NO `GROUP_ORDER` CONSTANT ANY MORE ─────────────────────────────
 * There used to be one — `[...SLOT_KEYS, 'other', 'prn', 'unscheduled']` — and it worked
 * only while the slots were four fixed keys in a fixed order. Neither is true now: the
 * user can invent slots of her own at runtime, and she can move any slot's time, so the
 * order sections should appear in is HER CLOCK, not an array written here. A module
 * constant cannot know either, so the sections are assembled per render from
 * `resolveSlots()` (already sorted by her configured times) and the three buckets that
 * are not times at all — "Other times", as-needed, no-timings — are appended last.
 * ─────────────────────────────────────────────────────────────────────────────
 */
type ListItem =
  | { kind: 'header'; key: string; title: string; subtitle?: string; actionLabel?: string; onAction?: () => void }
  | { kind: 'row'; key: string; row: MedicineRow }
  | { kind: 'warnRow'; key: string; row: MedicineRow }
  | { kind: 'draft'; key: string; prescription: Prescription };

type ScreenData = {
  rows: MedicineRow[];
  /** Photographed, not confirmed, and no medicine has come out of it yet. */
  drafts: Prescription[];
};

export default function MedicinesScreen() {
  const t = useT(STRINGS);
  const router = useRouter();
  const { colors } = useTheme();
  const { formatTime, formatDate } = useDateFormat();

  const [showStopped, setShowStopped] = useState(false);

  const profile = useProfileId();
  const profileId = profile.data;

  const state = useAsync<ScreenData | null>(async () => {
    if (!profileId) return null;

    const medicines = await listCurrentMedicines(profileId);
    const [schedulesByThread, stock, slots, prescriptions] = await Promise.all([
      getCurrentSchedulesForThreads(medicines.map((m) => m.threadId)),
      listStock(profileId),
      // Every slot she has, built-in and invented, already sorted by the time she set.
      resolveSlots(profileId),
      listPrescriptions(profileId),
    ]);

    // A prescription that already produced a medicine is not stranded — that medicine is
    // a row further down this very list, and repeating the paper above it would read as
    // "you still have something to do" when there is nothing left to do.
    const usedPrescriptionIds = new Set(
      medicines
        .map((medicine) => medicine.prescriptionId)
        .filter((value): value is string => value !== null),
    );
    const drafts = prescriptions.filter(
      (prescription) =>
        prescription.status !== 'confirmed' && !usedPrescriptionIds.has(prescription.id),
    );

    const stockByThread = new Map<string, MedicineStock>();
    for (const count of stock) stockByThread.set(count.threadId, count);

    const now = toLocalTime();
    const today = toLocalDate();

    const rows = medicines.map<MedicineRow>((medicine) => {
      const schedules = schedulesByThread.get(medicine.threadId) ?? [];
      const fixed = schedules.filter((s) => s.scheduleType === 'FIXED' && s.timeLocal);
      const isPrn = schedules.length > 0 && fixed.length === 0;

      const times = fixed
        .map((s) => s.timeLocal)
        .filter((time): time is string => time !== null)
        .sort();
      // The next slot in the daily cycle. Deliberately ignores days_mask: this is a
      // grouping heading, not a promise about tomorrow, and the row's own screen is
      // where the exact recurrence is spelled out.
      const nextTime = times.find((time) => time >= now) ?? times[0] ?? null;
      // The schedule row that dose comes from, kept for the `slot_key` it was written
      // with — see `slotForRow`. `find` on the fixed rows rather than a second query: the
      // UNIQUE (thread_id, version, time_local) constraint means at most one can match.
      const nextSchedule = nextTime === null ? null : fixed.find((s) => s.timeLocal === nextTime);

      const perDay = dosesPerDay(fixed);
      const count = stockByThread.get(medicine.threadId);
      let daysLeft: number | null = null;
      let refillDue = false;
      if (count) {
        const projection = projectRunOut(count.countedOn, count.quantityOnHand, perDay);
        if (projection) {
          daysLeft = Math.max(0, daysBetween(today, projection.runOutOn));
          refillDue = needsRefill(
            count.countedOn,
            count.quantityOnHand,
            perDay,
            count.refillLeadDays,
            today,
          );
        }
      }

      return {
        medicine,
        schedules,
        nextTime,
        slot: nextTime === null ? null : slotForRow(slots, nextTime, nextSchedule?.slotKey ?? null),
        isPrn,
        daysLeft,
        refillDue,
      };
    });

    return { rows, drafts };
  }, [profileId]);

  useReloadOnFocus(state.reload);

  const openMedicine = useCallback(
    (threadId: string) => router.push(`/medicine/${threadId}`),
    [router],
  );

  const openPrescription = useCallback(
    (prescriptionId: string) => router.push(`/prescription/${prescriptionId}`),
    [router],
  );

  const scanPrescription = useCallback(() => router.push('/prescription/capture'), [router]);

  const items = useMemo<ListItem[]>(() => {
    const rows = state.data?.rows ?? [];
    const drafts = state.data?.drafts ?? [];
    if (rows.length === 0 && drafts.length === 0) return [];

    const out: ListItem[] = [];

    // Above the medicines, because it is the only unfinished business on this screen and
    // because a prescription with nothing under it would otherwise be invisible.
    if (drafts.length > 0) {
      out.push({ kind: 'header', key: 'header-drafts', title: t('medicines.drafts.title') });
      for (const prescription of drafts) {
        out.push({ kind: 'draft', key: `draft-${prescription.id}`, prescription });
      }
    }

    const active = rows.filter((row) => row.medicine.status !== 'stopped');
    const stopped = rows.filter((row) => row.medicine.status === 'stopped');

    // Named slots keep their own bucket; the three that are not clock times keep theirs.
    // Keying by `def.key` rather than by the definition object is what lets two rows that
    // resolved the same slot on separate passes land in one section.
    const bySlot = new Map<string, { def: SlotDefinition; rows: MedicineRow[] }>();
    const other: MedicineRow[] = [];
    const prn: MedicineRow[] = [];
    const unscheduled: MedicineRow[] = [];

    for (const row of active) {
      if (row.isPrn) prn.push(row);
      else if (row.nextTime === null) unscheduled.push(row);
      else if (row.slot === null) other.push(row);
      else {
        const bucket = bySlot.get(row.slot.key);
        if (bucket) bucket.rows.push(row);
        else bySlot.set(row.slot.key, { def: row.slot, rows: [row] });
      }
    }

    // NO COUNT UNDER A SECTION OF ONE. With nine named slots plus her own, a regimen of
    // eight medicines spreads across six sections, and a header costs about two-thirds of a
    // medicine card in height — so the count line was turning the screen she opens at 08:00
    // to answer "what do I take now?" into a list of headings, five of which said
    // "1 medicine" above a single visible row. A count is worth its line when it tells her
    // something she cannot see.
    for (const section of orderSections(bySlot, t, formatTime)) {
      out.push({
        kind: 'header',
        key: `header-${section.key}`,
        title: section.title,
        subtitle: sectionCountLabel(t, section.rows.length),
      });
      for (const row of section.rows) out.push(rowItem(row));
    }

    // Last, and in this order. None of the three is a time, so none of them has a place
    // in the day; putting them among the slots would break the one thing the list is for,
    // which is reading down it and finding what comes next.
    const trailing: readonly { key: string; title: string; rows: MedicineRow[] }[] = [
      { key: 'other', title: t('medicines.groupOther'), rows: other },
      { key: 'prn', title: t('medicines.asNeeded'), rows: prn },
      { key: 'unscheduled', title: t('medicines.groupUnscheduled'), rows: unscheduled },
    ];
    for (const group of trailing) {
      if (group.rows.length === 0) continue;
      out.push({
        kind: 'header',
        key: `header-${group.key}`,
        title: group.title,
        subtitle: sectionCountLabel(t, group.rows.length),
      });
      for (const row of group.rows) out.push(rowItem(row));
    }

    if (stopped.length > 0) {
      out.push({
        kind: 'header',
        key: 'header-stopped',
        title: t('medicines.stopped'),
        subtitle: medicineCountLabel(t, stopped.length),
        actionLabel: showStopped ? t('medicines.hideStopped') : t('medicines.showStopped'),
        onAction: () => setShowStopped((value) => !value),
      });
      // Collapsed by default and never interleaved with the active list: a stopped
      // drug appearing among the ones she is taking is exactly how a stopped drug
      // gets taken.
      if (showStopped) for (const row of stopped) out.push(rowItem(row));
    }

    return out;
  }, [state.data, showStopped, t, formatTime]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.kind === 'header') {
        // No wrapper and no zeroed padding: the header carries its own vertical rhythm
        // and its own height, whatever the text scale makes that.
        return (
          <SectionHeader
            title={item.title}
            subtitle={item.subtitle}
            actionLabel={item.actionLabel}
            onAction={item.onAction}
          />
        );
      }
      if (item.kind === 'draft') {
        return (
          <DraftCard
            prescription={item.prescription}
            t={t}
            formatDate={formatDate}
            attention={colors.attention}
            onPress={() => openPrescription(item.prescription.id)}
          />
        );
      }
      return (
        <MedicineCard
          item={item}
          t={t}
          formatTime={formatTime}
          formatDate={formatDate}
          attention={colors.attention}
          onPress={() => openMedicine(item.row.medicine.threadId)}
        />
      );
    },
    [t, formatTime, formatDate, colors.attention, openMedicine, openPrescription],
  );

  const loading = profile.loading || state.loading;

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        // Two ways in, always both on screen. The camera is primary because it is the
        // one a user cannot otherwise find, and because photographing the paper is worth
        // doing even when nothing can read it yet — the capture flow itself decides what
        // to offer once the photo exists.
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('medicines.scan')}
            onPress={scanPrescription}
            variant="primary"
            size="lg"
            fullWidth
            accessibilityHint={t('medicines.scanHint')}
          />
          <Button
            title={t('medicines.add')}
            onPress={() => router.push('/medicine/new')}
            variant="secondary"
            size="lg"
            icon="plus"
            fullWidth
          />
        </View>
      }
    >
      <ScreenHeader title={t('medicines.title')} />

      {loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={SKELETON_ROW_HEIGHT} label={t('a11y.loading')} />
          <Skeleton height={SKELETON_ROW_HEIGHT} />
          <Skeleton height={SKELETON_ROW_HEIGHT} />
        </View>
      ) : state.error ? (
        <EmptyState
          title={t('errors.loadFailed')}
          message={t('errors.tryAgain')}
          icon="alert"
          actionLabel={t('common.retry')}
          onAction={state.reload}
        />
      ) : items.length === 0 ? (
        // No action of its own: both ways to start are pinned in the footer below, in
        // the same place they sit once the list has something in it.
        <EmptyState title={t('medicines.empty')} message={t('medicines.emptyMessage')} />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          // No `getItemLayout` — see the note above `THUMB`. Cells are measured.
          //
          // No `removeClippedSubviews` either. It is an Android-only optimisation that
          // detaches cells it believes are off-screen, and what it believes comes from
          // the same layout bookkeeping the declared heights were corrupting. With rows
          // that measure taller than the list thinks, it detaches cells that are in fact
          // visible — the blank band in the bug report. It exists to save work on long
          // lists; this one is tens of rows, and correctness is not a trade here.
          initialNumToRender={6}
          windowSize={7}
          showsVerticalScrollIndicator
          contentContainerStyle={{ paddingBottom: spacing.xl }}
        />
      )}
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Row
// ═══════════════════════════════════════════════════════════════════════════════

type CardProps = {
  item: Extract<ListItem, { kind: 'row' | 'warnRow' }>;
  t: TranslateFn;
  formatTime: (localTime: string) => string;
  formatDate: (localDate: string) => string;
  attention: string;
  onPress: () => void;
};

const MedicineCard = React.memo(function MedicineCard({
  item,
  t,
  formatTime,
  formatDate,
  attention,
  onPress,
}: CardProps) {
  const { medicine, nextTime, slot, isPrn, daysLeft, refillDue } = item.row;
  const unconfirmed = item.kind === 'warnRow';

  const subtitle = [medicine.strength, medicine.form ? t(`medicines.form.${medicine.form}`) : null]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const timingLine =
    medicine.status === 'stopped'
      ? medicine.stoppedOn
        ? t('medicines.stoppedOn', { date: formatDate(medicine.stoppedOn) })
        : t('medicines.stoppedRow')
      : isPrn
        ? t('medicines.asNeeded')
        : nextTime === null
          ? t('medicines.noTimings')
          : slot
            ? // `slotLabel`, never `t(slotI18nKey(...))`: a slot she invented herself has
              // no bundle key, and putting `custom:9f3a1c02` through `t()` would print the
              // hex back at her.
              t('medicines.nextDoseSlot', { slot: slotLabel(slot, t), time: formatTime(nextTime) })
            : t('medicines.nextDose', { time: formatTime(nextTime) });

  const stockLine = stockLabel(t, daysLeft, refillDue);

  const spoken = [medicine.nameAsWritten, subtitle, timingLine, stockLine, unconfirmed ? t('medicines.needsConfirmation') : null]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  // The row is as tall as what is in it. No `maxFontSizeMultiplier` anywhere below:
  // the cap existed only to stop text growing past a height this row no longer claims,
  // and capping the OS font scale is a strange thing for an app whose first setting is
  // "make the text bigger" to do. `numberOfLines` survives only on the two fields a
  // human types — a name pasted from a discharge summary should not own the screen.
  return (
    <View style={{ paddingBottom: spacing.md }}>
      <Card
        onPress={onPress}
        accessibilityLabel={spoken}
        accessibilityHint={t('medicines.openHint')}
        padding={spacing.md}
      >
        <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
          <Thumb
            uri={medicine.stripPhotoUri}
            size={THUMB}
            label={t('medicines.stripPhotoOf', { name: medicine.nameAsWritten })}
          />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="label" numberOfLines={2}>
              {medicine.nameAsWritten}
            </Text>
            <Text variant="body" tone="muted">
              {subtitle || t('common.none')}
            </Text>
            {/* Wraps rather than truncates. This line carries the clock time, and an
                ellipsis through "Next dose Morning, 08:00" hides the one number on the
                row a doctor would ask her for. */}
            <Text variant="body">{timingLine}</Text>
            <Text variant="caption" tone="muted">
              {stockLine}
            </Text>
          </View>
        </View>

        {unconfirmed ? (
          <View style={{ paddingTop: spacing.sm, gap: spacing.xs }}>
            {/* `attention`, never `destructive`: this is the app waiting for her, not a
                warning about the medicine itself. */}
            <Text variant="caption" style={{ color: attention }}>
              {t('medicines.needsConfirmation')}
            </Text>
            <Text variant="caption" tone="muted">
              {t('medicines.notConfirmedWarning')}
            </Text>
          </View>
        ) : null}
      </Card>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unfinished prescription row
// ═══════════════════════════════════════════════════════════════════════════════

type DraftCardProps = {
  prescription: Prescription;
  t: TranslateFn;
  formatDate: (localDate: string) => string;
  attention: string;
  onPress: () => void;
};

/**
 * One photographed-but-unfinished prescription.
 *
 * Deliberately the same height and shape as a medicine row — it is a thing with a photo
 * and a state, and making it a special banner would push the medicines she actually takes
 * off the first screenful. `attention`, never `destructive`: nothing has gone wrong, a
 * step is simply outstanding.
 */
const DraftCard = React.memo(function DraftCard({
  prescription,
  t,
  formatDate,
  attention,
  onPress,
}: DraftCardProps) {
  const title = prescription.prescriber ?? prescription.clinic ?? t('prescription.title');
  const detail = t(draftStatusKey(prescription.status));
  const footnote = prescription.prescribedOn
    ? formatDate(prescription.prescribedOn)
    : t('medicines.drafts.carryOn');

  const spoken = [title, detail, footnote].join('. ');

  return (
    <View style={{ paddingBottom: spacing.md }}>
      <Card
        onPress={onPress}
        accessibilityLabel={spoken}
        accessibilityHint={t('medicines.drafts.openHint')}
        padding={spacing.md}
      >
        <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
          <Thumb
            uri={prescription.imageUri}
            size={THUMB}
            label={t('medicines.drafts.photoOf')}
          />
          <View style={{ flex: 1, gap: spacing.xs }}>
            {/* Capped, like the medicine name and for the same reason: a prescriber or
                clinic name arrives from a human or from an extraction, not from us. */}
            <Text variant="label" numberOfLines={2}>
              {title}
            </Text>
            <Text variant="body" style={{ color: attention }}>
              {detail}
            </Text>
            <Text variant="caption" tone="muted">
              {footnote}
            </Text>
          </View>
        </View>
      </Card>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * What is outstanding on a prescription, said plainly.
 *
 * `confirmed` never reaches here — those rows are filtered out of the section — but the
 * switch is total so a new status added to the repository is a compile error rather than
 * a blank line on this screen.
 */
function draftStatusKey(status: PrescriptionStatus): string {
  switch (status) {
    case 'extracting':
      return 'medicines.drafts.extracting';
    case 'extracted':
      return 'medicines.drafts.extracted';
    case 'failed':
      return 'medicines.drafts.failed';
    case 'draft':
    case 'confirmed':
    default:
      return 'medicines.drafts.draft';
  }
}

function rowItem(row: MedicineRow): ListItem {
  const key = row.medicine.threadId;
  // An unconfirmed medicine gets its own row kind, because it carries two extra lines
  // of explanation that a confirmed one does not. The kinds used to differ in declared
  // height as well; now they differ only in what they say, which is all they ever
  // really meant.
  return row.medicine.confirmedByUserAt === null
    ? { kind: 'warnRow', key, row }
    : { kind: 'row', key, row };
}

/**
 * "1 medicine" / "5 medicines", in whichever language.
 *
 * `t()` has no plural rules and is not getting any for two strings — see the note on
 * the count keys in STRINGS. Both keys are called as string literals so that
 * scripts/check-i18n.js can still verify statically that each one resolves; building
 * the key with a ternary inside `t(...)` would hide it from that check.
 */
function medicineCountLabel(t: TranslateFn, count: number): string {
  return count === 1 ? t('medicines.countOne', { count }) : t('medicines.count', { count });
}

/**
 * The count under a section heading — or nothing, when the section holds one row.
 *
 * "1 medicine" above exactly one visible medicine card is a line of chrome that states
 * what the eye has already taken in, and with nine slots there can be six of them on one
 * screen. The Stopped header keeps its count unconditionally: it is collapsible, so when
 * it is collapsed the count is the only thing saying anything is under it.
 */
function sectionCountLabel(t: TranslateFn, count: number): string | undefined {
  return count > 1 ? medicineCountLabel(t, count) : undefined;
}

/**
 * How much supply is left, said in days.
 *
 * Zero takes the plural in both languages ("0 days of stock left"), which is correct
 * English and correct Hindi — only exactly one is singular.
 */
function stockLabel(t: TranslateFn, daysLeft: number | null, refillDue: boolean): string {
  if (daysLeft === null) return t('medicines.noStockCount');
  if (refillDue) {
    return daysLeft === 1
      ? t('medicines.daysLeftLowOne', { count: daysLeft })
      : t('medicines.daysLeftLow', { count: daysLeft });
  }
  return daysLeft === 1
    ? t('medicines.daysLeftOne', { count: daysLeft })
    : t('medicines.daysLeft', { count: daysLeft });
}

type Section = { key: string; title: string; rows: MedicineRow[] };

/**
 * The slot sections, in the order the day runs.
 *
 * Sorted by the time SHE set, not by any order declared in this file or in the registry:
 * if she moves Evening to 06:00 it belongs at the top, because the only thing that can be
 * scanned reliably down a list of nine-plus headings is the clock. Ties fall back to the
 * key so the order is total and the list cannot reshuffle itself between renders.
 *
 * A retired slot has no configured time of its own, so it is placed — and titled — by the
 * doses actually filed under it, and only when they all agree on one. Two "Morning" rows
 * at 06:00 and 06:30 under a heading that claims 06:00 would be a heading that lies about
 * one of them, so in that case the heading gives the name alone and each row states its
 * own clock time on its own line, as it always does.
 */
function orderSections(
  bySlot: ReadonlyMap<string, { def: SlotDefinition; rows: MedicineRow[] }>,
  t: TranslateFn,
  formatTime: (localTime: string) => string,
): Section[] {
  return [...bySlot.values()]
    .map(({ def, rows }) => {
      const times = rows.map((row) => row.nextTime).filter((time): time is string => time !== null);
      const earliest = times.reduce((min, time) => (time < min ? time : min), times[0] ?? '');
      const agreed = times.every((time) => time === earliest);
      const time = def.kind === 'legacy' ? (agreed ? earliest : null) : def.time;
      return {
        key: def.key,
        sortTime: def.kind === 'legacy' ? earliest : def.time,
        // The slot name alone is not a time. Both, always — and through `formatTime`, so
        // the heading reads in the same 12- or 24-hour form as the row beneath it.
        title: time ? `${slotLabel(def, t)} · ${formatTime(time)}` : slotLabel(def, t),
        rows,
      };
    })
    .sort((a, b) =>
      a.sortTime === b.sortTime
        ? a.key === b.key
          ? 0
          : a.key < b.key
            ? -1
            : 1
        : a.sortTime < b.sortTime
          ? -1
          : 1,
    )
    .map(({ key, title, rows }) => ({ key, title, rows }));
}

/**
 * Average fixed doses per day across a thread's current schedule.
 *
 * Fractional on purpose: a Monday/Thursday medicine is 2/7 of a dose per day, and the
 * stock projection is division, not a claim about any particular day.
 */
function dosesPerDay(schedules: readonly DoseSchedule[]): number {
  let total = 0;
  for (const schedule of schedules) {
    if (schedule.scheduleType !== 'FIXED' || !schedule.timeLocal) continue;
    const days = countDays(schedule.daysMask) / 7;
    const interval = Math.max(1, schedule.intervalDays);
    total += days / interval;
  }
  return total;
}

function countDays(daysMask: number): number {
  let mask = daysMask & ALL_DAYS;
  let count = 0;
  while (mask !== 0) {
    count += mask & 1;
    mask >>= 1;
  }
  return count;
}
