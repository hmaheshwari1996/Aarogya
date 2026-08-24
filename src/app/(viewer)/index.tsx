/**
 * The viewer dashboard — everything the link opens, and no way to change any of it.
 *
 * ─── WHERE THE DATA COMES FROM ────────────────────────────────────────────────────
 * A link the family member was sent, and nothing else. `getViewerLink()` returns the id
 * and the key she pasted or tapped; `fetchSharedSnapshot()` fetches the sealed blob that
 * id names and opens it with that key, IN MEMORY. Nothing is written to this phone's
 * database — not a reading, not a dose, not a medicine. The screen renders fields.
 *
 * ─── WHY THERE IS NOT A SINGLE WRITE CONTROL ON THIS SCREEN ───────────────────────
 * There are no entry tiles, no "mark taken", no edit, no delete. A record entered by
 * somebody else and stored indistinguishably from one she entered herself is a corrupted
 * record: the son taps "taken" from the office because he is fairly sure she took it, the
 * row is identical to a real one, and six months later a doctor reads a run of confirmed
 * doses that nobody can now separate into observed and assumed. The honest split is that
 * he watches and she records, and the cheapest way to guarantee it is not to build the
 * button.
 *
 * DOSE WORDING GOES THROUGH `deriveStatus()`, WHICH NEVER SAYS "MISSED". Silence means the
 * app was told nothing — which on these handsets is very often the app's own fault — and a
 * son reading "missed" next to his mother's name at 21:00 makes a phone call that starts
 * an argument about a tablet she took two hours ago.
 *
 * THE STATUS IS COMPUTED HERE, AGAINST THIS PHONE'S CLOCK, from the events in the
 * snapshot. A snapshot published at 08:00 therefore still reads correctly at 14:00 instead
 * of showing a frozen "Due" for the rest of the day.
 *
 * OUT-OF-RANGE IS NEVER RED, and a range is only ever shown against a `target_range` a
 * named human entered, with that name and date printed under it. With no target the card
 * says there is no target.
 *
 * NO PHOTOGRAPHS. Strip photos are files on the patient's handset; a `file://` path from
 * another phone is a broken image and a description of her storage layout, so the snapshot
 * does not carry one. See `src/features/sync/snapshot.ts`.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';

import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import { useFontSizes } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  StatCard,
  Text,
} from '@/components/ui';
import { deriveStatus, OCCURRENCE_STATUS_COPY } from '@/features/dosing/deriveStatus';
import {
  fetchSharedSnapshot,
  getViewerLink,
  type FetchOutcome,
  type SharedSnapshot,
} from '@/features/sync';
import { censoredDirection, censoredVsTarget } from '@/features/reports/data/censored';
import type { Reading, TargetRange } from '@/types';
import type { StatRange } from '@/components/ui/StatCard';
import {
  DOSE_STATUS_STRINGS,
  formatReadingUnit,
  formatReadingValue,
  matchTarget,
  metricUnit,
  rangeFor,
  targetFootnote,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';

/**
 * Only the dose wording, which lives next to `deriveStatus()` rather than in the bundle so
 * that the status vocabulary and the rule that produces it cannot drift apart. Everything
 * else on this screen comes from `en.json` / `hi.json`.
 */
const STRINGS: LocalStrings = { ...DOSE_STATUS_STRINGS };

type Row =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | {
      kind: 'entry';
      key: string;
      title: string;
      subtitle: string | null;
      meta: string | null;
    };

type Loaded =
  | { state: 'no_link' }
  | { state: 'error'; reason: Exclude<FetchOutcome, { ok: true }>['reason'] }
  | {
      state: 'ok';
      snapshot: SharedSnapshot;
      /**
       * The clock reading the dose statuses are derived against.
       *
       * Taken in the loader rather than during render: `deriveStatus()` needs a `now`, and
       * reading the clock while rendering makes the same list produce different rows on a
       * re-render nobody asked for. `useReloadOnFocus` re-runs the loader whenever the
       * screen comes back, which is when a family member is actually looking at it.
       */
      fetchedAtEpoch: number;
    };

export default function ViewerDashboardScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const fontSizes = useFontSizes();
  const { formatTime, formatDate, formatEpoch } = useDateFormat();

  const state = useAsync<Loaded>(async () => {
    const link = await getViewerLink();
    if (!link) return { state: 'no_link' };
    const outcome = await fetchSharedSnapshot(link);
    return outcome.ok
      ? { state: 'ok', snapshot: outcome.snapshot, fetchedAtEpoch: Date.now() }
      : { state: 'error', reason: outcome.reason };
  }, []);

  useReloadOnFocus(state.reload);

  const data = state.data;
  const snapshot = data?.state === 'ok' ? data.snapshot : null;
  const now = data?.state === 'ok' ? data.fetchedAtEpoch : 0;

  const rows = useMemo<Row[]>(() => {
    if (!snapshot) return [];
    const out: Row[] = [];

    out.push({ kind: 'section', key: 'sec-doses', title: t('viewer.section.doses') });
    if (snapshot.doses.length === 0) {
      out.push({ kind: 'note', key: 'note-doses', text: t('viewer.noDosesToday') });
    } else {
      for (const dose of snapshot.doses) {
        const status = dose.cancelled
          ? 'cancelled'
          : deriveStatus(dose.events, dose.scheduledAtEpoch, now);
        out.push({
          kind: 'entry',
          key: `dose-${dose.id}`,
          title: dose.name === '' ? t('common.unknown') : dose.name,
          subtitle: t('viewer.doseAt', { time: formatTime(dose.timeLocal) }),
          meta: t(OCCURRENCE_STATUS_COPY[status].i18nKey),
        });
      }
    }

    out.push({ kind: 'section', key: 'sec-meds', title: t('viewer.section.medicines') });
    if (snapshot.medicines.length === 0) {
      out.push({ kind: 'note', key: 'note-meds', text: t('viewer.noMedicines') });
    } else {
      for (const med of snapshot.medicines) {
        out.push({
          kind: 'entry',
          key: `med-${med.threadId}`,
          title: med.name,
          subtitle: med.strength,
          meta: med.startedOn ? t('medicines.startedOn', { date: formatDate(med.startedOn) }) : null,
        });
      }
    }

    out.push({ kind: 'section', key: 'sec-labs', title: t('viewer.section.labs') });
    if (snapshot.labs.length === 0) {
      out.push({ kind: 'note', key: 'note-labs', text: t('viewer.noLabs') });
    } else {
      for (const lab of snapshot.labs) {
        out.push({
          kind: 'entry',
          key: `lab-${lab.id}`,
          title: (lang === 'hi' ? lab.labelHi : lab.labelEn) || t('common.unknown'),
          subtitle: lab.value === '' ? null : lab.value,
          // A machine-read row nobody has checked against the paper says so, instead of
          // sitting next to the confirmed ones looking exactly as trustworthy.
          meta: lab.confirmed
            ? lab.collectedOn
              ? formatDate(lab.collectedOn)
              : null
            : t('prescription.notConfirmed'),
        });
      }
    }

    return out;
  }, [snapshot, now, lang, t, formatTime, formatDate]);

  /**
   * Row heights are FIXED but font-scaled.
   *
   * `fixedItemLayout()` assumes one height for a whole list, and this list has three
   * shapes in it, so the offsets are pre-computed instead — the same O(1) lookup, and the
   * same promise to FlatList that nothing has to be measured on the JS thread while she
   * scrolls. On a 2 GB handset that is the difference between a list that moves and one
   * that stutters, and a stuttering list is one this user taps twice.
   *
   * Derived from the live font scale rather than hardcoded: at 1.25× a hardcoded height
   * clips the third line off every row.
   */
  const layout = useMemo(() => {
    const line = (size: number, ratio: number) => Math.round(size * ratio);
    const sectionHeight = spacing.lg + spacing.sm + line(fontSizes.lg, 1.4);
    const noteHeight = spacing.md * 2 + line(fontSizes.md, 1.5) * 2;
    const entryHeight =
      spacing.md * 2 + line(fontSizes.md, 1.5) * 2 + spacing.xs * 2 + line(fontSizes.sm, 1.45);

    const heights = rows.map((row) =>
      row.kind === 'section' ? sectionHeight : row.kind === 'note' ? noteHeight : entryHeight,
    );
    const offsets: number[] = [];
    let running = 0;
    for (const height of heights) {
      offsets.push(running);
      running += height;
    }
    return { heights, offsets };
  }, [rows, fontSizes]);

  if (state.loading && !data) {
    return (
      <Screen variant="scroll">
        <ScreenHeader title={t('viewer.title')} />
        <View style={{ gap: spacing.md }}>
          <Skeleton height={140} label={t('common.loading')} />
          <Skeleton height={100} />
          <Skeleton height={100} />
        </View>
      </Screen>
    );
  }

  if (!data || data.state === 'no_link') {
    return (
      <Screen variant="scroll">
        <ScreenHeader title={t('viewer.title')} />
        <EmptyState
          icon="info"
          title={t('viewer.noLink')}
          message={t('viewer.noLinkMessage')}
          actionLabel={t('viewer.openLink')}
          onAction={() => router.push('/link')}
        />
      </Screen>
    );
  }

  if (data.state === 'error') {
    return (
      <Screen variant="scroll">
        <ScreenHeader title={t('viewer.title')} />
        <EmptyState
          icon="alert"
          title={t('viewer.loadFailed')}
          message={t(`viewer.fetch.${data.reason}`)}
          actionLabel={t('common.retry')}
          onAction={state.reload}
        />
        <View style={{ paddingTop: spacing.md }}>
          <Button
            title={t('viewer.openLink')}
            onPress={() => router.push('/link')}
            variant="secondary"
            size="lg"
            accessibilityLabel={t('viewer.link.a11yOpen')}
            fullWidth
          />
        </View>
      </Screen>
    );
  }

  const shown = data.snapshot;

  const header = (
    <View>
      <ScreenHeader title={t('viewer.title')} />

      {/*
        The alert is the first thing on the screen when there is one. It is the only
        reason this app can reach a family member at all in the link model — there is
        nobody to send a notification to, so this is where it has to land.
      */}
      {shown.alerts.map((alert) => (
        <Banner
          key={alert.id}
          variant="attention"
          title={t('viewer.alert.title')}
          message={t('viewer.alert.body', {
            count: String(alert.consecutive),
            when:
              alert.latestScheduledAtEpoch === null
                ? t('common.unknown')
                : formatEpoch(alert.latestScheduledAtEpoch),
          })}
        />
      ))}

      <Banner variant="info" title={t('viewer.readOnly')} message={t('viewer.readOnlyMessage')} />

      <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.md }}>
        {t('viewer.asOf', { when: formatEpoch(shown.builtAtEpoch) })}
      </Text>

      <SectionHeader title={t('viewer.section.readings')} />
      {shown.readings.length === 0 ? (
        <Text variant="body" tone="muted" style={{ paddingBottom: spacing.md }}>
          {t('viewer.noReadingsToday')}
        </Text>
      ) : (
        <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
          {shown.readings.map(({ def, reading }) => {
            const field = def.schema.primaryField;
            const primary = field === 'v1' ? reading.v1 : field === 'v2' ? reading.v2 : reading.v3;
            // Targets travel unresolved and are matched here, by exactly the same rule the
            // patient's own screens use — one implementation, no chance of the two
            // disagreeing about which target applies to a reading.
            const target = matchTarget(shown.targets, def.key, field, reading.context);
            return (
              <StatCard
                key={reading.id}
                label={lang === 'hi' ? def.labelHi : def.labelEn}
                // `t` is passed so a meter that printed LO says so in his language rather
                // than rendering as an em dash. See the long note on `formatReadingValue`:
                // this screen is where that bug mattered most, because he is reading it
                // from another city.
                value={formatReadingValue(reading, t)}
                unit={formatReadingUnit(reading, metricUnit(def, def.key))}
                range={viewerRange(reading, target, primary)}
                caption={formatTime(reading.localTime)}
                footnote={targetFootnote(t, target, formatDate)}
              />
            );
          })}
        </View>
      )}
    </View>
  );

  return (
    <Screen variant="fixed" padded={false}>
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        getItemLayout={(_data, index) => ({
          length: layout.heights[index] ?? 0,
          offset: layout.offsets[index] ?? 0,
          index,
        })}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }}
        initialNumToRender={10}
        windowSize={7}
        renderItem={({ item, index }) => {
          const height = layout.heights[index] ?? 0;

          if (item.kind === 'section') {
            return (
              <View style={{ height, justifyContent: 'flex-end' }}>
                <SectionHeader title={item.title} style={{ paddingTop: 0, paddingBottom: 0 }} />
              </View>
            );
          }

          if (item.kind === 'note') {
            return (
              <View style={{ height, justifyContent: 'center' }}>
                <Text variant="body" tone="muted" numberOfLines={2}>
                  {item.text}
                </Text>
              </View>
            );
          }

          // Built by hand rather than with ListRow so every line can declare
          // `numberOfLines`. A row that silently wraps to a fourth line would make the
          // pre-computed offsets a lie and the scroll position drift.
          const spoken = [item.title, item.subtitle, item.meta]
            .filter((part): part is string => Boolean(part))
            .join('. ');

          return (
            <View style={{ height }}>
              <View
                accessible
                accessibilityLabel={spoken}
                style={{ flex: 1, justifyContent: 'center', gap: spacing.xs }}
              >
                <Text variant="body" weight="600" numberOfLines={1}>
                  {item.title}
                </Text>
                {item.subtitle ? (
                  <Text variant="body" tone="muted" numberOfLines={1}>
                    {item.subtitle}
                  </Text>
                ) : null}
                {item.meta ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {item.meta}
                  </Text>
                ) : null}
              </View>
              <Divider />
            </View>
          );
        }}
      />
    </Screen>
  );
}

/**
 * Where a reading sits against a target, INCLUDING the ones the meter refused to number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `rangeFor` compares a number to a band and answers 'unknown' when there is no number.
 * That is correct for an ordinary reading and wrong for a censored one, where the record
 * often proves the answer without ever knowing the value.
 *
 * A meter showing LO asserted `v < B`, where B is its floor. If B sits at or below the
 * target's own floor L, then `v < B ≤ L` — the reading IS below target, proven, no
 * arithmetic on a value that does not exist. If B sits INSIDE the band, the true value
 * could be either side of L and the honest answer is that we cannot say. `censoredVsTarget`
 * carries that proof, is unit-tested in `features/reports/data/censored.test.ts`, and is
 * the same function the Today screen uses — one implementation, so his screen and hers can
 * never disagree about a hypo.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: substituting the bound for the value and running it
 * through `rangeFor`. It types, it looks reasonable, and it biases every comparison towards
 * the middle — making exactly the readings that matter most look milder than they were.
 * The same trap is written out at length beside `censoredVsTarget`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The remaining imperfection is `StatCard`'s vocabulary, not this function's: 'unknown'
 * renders as "No target set", which is false when a target exists and the comparison is
 * merely undecidable. Both cases land on 'unknown' until that component grows a fourth
 * state. Saying nothing is the right failure — it never claims a side.
 */
function viewerRange(
  reading: Reading,
  target: TargetRange | null,
  primary: number | null,
): StatRange {
  const direction = censoredDirection(reading.valueQualifier);
  if (!direction) return rangeFor(target, primary);
  if (!target) return 'unknown';
  return censoredVsTarget(direction, reading.qualifierBound, target) === 'outside'
    ? direction
    : 'unknown';
}
