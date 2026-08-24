/**
 * Adherence arithmetic — PURE.
 *
 * No database, no clock, no date library. It takes an ordered list of per-day
 * tallies and returns the summary. That keeps every rule below unit-testable, and
 * it keeps the honesty rules in one readable place instead of spread across a query.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SUPPRESSION RULE, AND WHY IT IS NOT NEGOTIABLE
 *
 * A run of days with no records is MISSING DATA. It is not evidence of
 * non-adherence. The app cannot tell "she stopped taking her tablets" apart from
 * "her phone was off", "the OEM killed the alarm process", "she was in hospital" or
 * "she took every dose and never opened the app".
 *
 * A physician reading "31%" over a week-long hole in a TB patient's record may
 * escalate to directly-observed therapy, change the regimen, or record
 * non-compliance in her notes. Changing a person's treatment over an artefact the
 * app manufactured is the worst thing this feature could do, so when the record is
 * that incomplete we do not publish a number at all — we publish the reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AdherenceSummary } from '../../types';

/** One calendar day's worth of counted occurrences. Days are contiguous and ordered. */
export type DayTally = {
  localDate: string;
  /** Occurrences that had actually come due by "now" and belong to a live medicine version. */
  due: number;
  recordedTaken: number;
  recordedNotTaken: number;
  noRecord: number;
  /** A hospital stay or similar. Explained absence, not missing data. */
  isAway: boolean;
};

/** Three consecutive silent days is where a percentage stops meaning anything. */
export const NO_RECORD_RUN_SUPPRESSION_THRESHOLD = 3;

export type NoRecordRun = {
  /** Number of SILENT days in the run — transparent days between them are not counted. */
  days: number;
  fromDate: string;
  toDate: string;
};

/**
 * A day where doses were due and nothing at all was recorded.
 *
 * Partial days are not silent: recording one of two doses is incomplete, but it is
 * evidence that the app was working and being used, which is precisely what a
 * silent day fails to show.
 */
function isSilent(day: DayTally): boolean {
  return !day.isAway && day.due > 0 && day.recordedTaken + day.recordedNotTaken === 0;
}

/**
 * A day that proves the record was being kept.
 *
 * Days with nothing due, and away days, are neither silent nor informative — they
 * are TRANSPARENT. They do not extend a run and they do not break one. That matters
 * for an alternate-day medicine: without it, Monday and Wednesday being silent
 * would read as two unrelated one-day gaps rather than one continuing one, and a
 * genuinely unreadable record would publish a percentage anyway.
 */
function isInformative(day: DayTally): boolean {
  return !day.isAway && day.due > 0 && day.recordedTaken + day.recordedNotTaken > 0;
}

/** The longest stretch of silence, measured in silent days and spanned by real dates. */
export function longestNoRecordRun(days: readonly DayTally[]): NoRecordRun | null {
  let best: NoRecordRun | null = null;
  let count = 0;
  let start: string | null = null;
  let end: string | null = null;

  const flush = () => {
    if (count > 0 && start !== null && end !== null) {
      if (best === null || count > best.days) best = { days: count, fromDate: start, toDate: end };
    }
    count = 0;
    start = null;
    end = null;
  };

  for (const day of days) {
    if (isSilent(day)) {
      count += 1;
      if (start === null) start = day.localDate;
      end = day.localDate;
    } else if (isInformative(day)) {
      flush();
    }
    // transparent days fall through untouched
  }
  flush();
  return best;
}

export function summariseAdherence(
  days: readonly DayTally[],
  windowDays: number,
): AdherenceSummary {
  // Away days are removed from the denominator entirely. A week in hospital, where
  // the ward gave every dose and nobody tapped anything, must not read as a week of
  // non-adherence.
  const counted = days.filter((d) => !d.isAway);

  const due = sum(counted, (d) => d.due);
  const recordedTaken = sum(counted, (d) => d.recordedTaken);
  const recordedNotTaken = sum(counted, (d) => d.recordedNotTaken);
  const noRecord = sum(counted, (d) => d.noRecord);

  const run = longestNoRecordRun(days);
  const longestRun = run?.days ?? 0;

  if (due === 0) {
    return {
      windowDays,
      due: 0,
      recordedTaken,
      recordedNotTaken,
      noRecord,
      percent: null,
      suppressedReason: 'No scheduled doses in this period.',
      longestNoRecordRun: longestRun,
    };
  }

  if (run !== null && run.days >= NO_RECORD_RUN_SUPPRESSION_THRESHOLD) {
    return {
      windowDays,
      due,
      recordedTaken,
      recordedNotTaken,
      noRecord,
      percent: null,
      suppressedReason: `Records incomplete for ${run.days} ${
        run.days === 1 ? 'day' : 'days'
      } (${formatDateRange(run.fromDate, run.toDate)})`,
      longestNoRecordRun: longestRun,
    };
  }

  return {
    windowDays,
    due,
    recordedTaken,
    recordedNotTaken,
    noRecord,
    // Only doses recorded as TAKEN go on top. A skipped dose was a real decision and
    // belongs in the denominator, not quietly forgiven out of it.
    percent: Math.round((recordedTaken / due) * 100),
    suppressedReason: null,
    longestNoRecordRun: longestRun,
  };
}

/**
 * The sentence that goes on every export, report and share.
 *
 * It is the difference between a claim the app can support and one it cannot. The
 * app knows what was tapped. It does not know what was swallowed, and no amount of
 * tapping makes it know.
 */
export function adherenceDisclaimer(): string {
  return 'Self-reported in app. Records interaction with the app, not medication taken.';
}

// ── Date formatting ──────────────────────────────────────────────────────────

const MONTHS_EN = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * '2–5 Aug', '30 Jul – 2 Aug', '2 Aug', '28 Dec 2025 – 3 Jan 2026'.
 *
 * String slicing rather than Date arithmetic, so this module stays free of any
 * runtime import and can be loaded by the test runner on its own.
 */
export function formatDateRange(fromDate: string, toDate: string): string {
  const from = splitDate(fromDate);
  const to = splitDate(toDate);
  if (!from || !to) return fromDate === toDate ? fromDate : `${fromDate} – ${toDate}`;

  if (from.year !== to.year) {
    return `${from.day} ${from.month} ${from.year} – ${to.day} ${to.month} ${to.year}`;
  }
  if (from.month !== to.month) {
    return `${from.day} ${from.month} – ${to.day} ${to.month}`;
  }
  if (from.day === to.day) {
    return `${from.day} ${from.month}`;
  }
  // Same month: an en dash with no spaces, which is how a day range is set.
  return `${from.day}–${to.day} ${from.month}`;
}

function splitDate(
  localDate: string,
): { year: string; month: string; day: number } | null {
  const parts = localDate.split('-');
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  const monthName = MONTHS_EN[Number(month) - 1];
  if (!monthName) return null;
  return { year, month: monthName, day: Number(day) };
}

function sum(days: readonly DayTally[], pick: (d: DayTally) => number): number {
  return days.reduce((total, day) => total + pick(day), 0);
}
