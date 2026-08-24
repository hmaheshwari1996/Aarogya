/**
 * Tests for the adherence arithmetic.
 *
 * Only `./compute.ts` is exercised here, and that is by design: it is pure, it
 * holds every rule that could mislead a doctor, and it has no database underneath
 * it to mock. `./index.ts` is the part that decides which rows reach these
 * functions; it is thin, and it has SQLite under it.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and
 * re-typing the namespace keeps both the runtime and `tsc --noEmit` happy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './compute.ts';
const {
  summariseAdherence,
  longestNoRecordRun,
  formatDateRange,
  adherenceDisclaimer,
  NO_RECORD_RUN_SUPPRESSION_THRESHOLD,
} = (await import(MODULE)) as typeof import('./compute');

type Day = import('./compute').DayTally;

function day(
  localDate: string,
  due: number,
  taken: number,
  notTaken: number,
  options: { away?: boolean } = {},
): Day {
  return {
    localDate,
    due,
    recordedTaken: taken,
    recordedNotTaken: notTaken,
    noRecord: due - taken - notTaken,
    isAway: options.away ?? false,
  };
}

/** A run of days, all identical, starting at 2026-08-01. */
function days(count: number, make: (index: number) => Omit<Day, 'localDate'>): Day[] {
  return Array.from({ length: count }, (_, i) => ({
    localDate: `2026-08-${String(i + 1).padStart(2, '0')}`,
    ...make(i),
  }));
}

// ── Basic counting ───────────────────────────────────────────────────────────

test('a perfect week is 100%', () => {
  const week = days(7, () => ({
    due: 2,
    recordedTaken: 2,
    recordedNotTaken: 0,
    noRecord: 0,
    isAway: false,
  }));
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.due, 14);
  assert.equal(summary.recordedTaken, 14);
  assert.equal(summary.percent, 100);
  assert.equal(summary.suppressedReason, null);
});

test('a skipped dose stays in the denominator', () => {
  // Skipping is a decision she made and recorded. Forgiving it out of the
  // denominator would flatter the number and hide a real clinical signal.
  const week = days(7, (i) =>
    i === 0
      ? { due: 2, recordedTaken: 1, recordedNotTaken: 1, noRecord: 0, isAway: false }
      : { due: 2, recordedTaken: 2, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.due, 14);
  assert.equal(summary.recordedTaken, 13);
  assert.equal(summary.recordedNotTaken, 1);
  assert.equal(summary.percent, 93);
});

test('the three buckets always account for every due dose', () => {
  const week = [
    day('2026-08-01', 3, 2, 1),
    day('2026-08-02', 3, 1, 0),
    day('2026-08-03', 3, 3, 0),
    day('2026-08-04', 2, 0, 2),
    day('2026-08-05', 2, 1, 1),
    day('2026-08-06', 2, 2, 0),
    day('2026-08-07', 2, 1, 1),
  ];
  const s = summariseAdherence(week, 7);
  assert.equal(s.recordedTaken + s.recordedNotTaken + s.noRecord, s.due);
});

// ── Suppression ──────────────────────────────────────────────────────────────

test('two silent days still publish a percentage', () => {
  const week = days(7, (i) =>
    i === 2 || i === 3
      ? { due: 2, recordedTaken: 0, recordedNotTaken: 0, noRecord: 2, isAway: false }
      : { due: 2, recordedTaken: 2, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.longestNoRecordRun, 2);
  assert.equal(summary.percent, 71);
  assert.equal(summary.suppressedReason, null);
});

test('three silent days suppress the percentage entirely', () => {
  const week = days(7, (i) =>
    i >= 1 && i <= 3
      ? { due: 2, recordedTaken: 0, recordedNotTaken: 0, noRecord: 2, isAway: false }
      : { due: 2, recordedTaken: 2, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.longestNoRecordRun, 3);
  assert.equal(summary.percent, null);
  assert.equal(summary.suppressedReason, 'Records incomplete for 3 days (2–4 Aug)');
});

test('the suppression threshold is the documented constant, not a magic number', () => {
  assert.equal(NO_RECORD_RUN_SUPPRESSION_THRESHOLD, 3);
  const atThreshold = days(NO_RECORD_RUN_SUPPRESSION_THRESHOLD, () => ({
    due: 1,
    recordedTaken: 0,
    recordedNotTaken: 0,
    noRecord: 1,
    isAway: false,
  }));
  assert.equal(summariseAdherence(atThreshold, 3).percent, null);
});

test('the suppressed reason names the actual dates', () => {
  const week = days(7, (i) =>
    i >= 3
      ? { due: 1, recordedTaken: 0, recordedNotTaken: 0, noRecord: 1, isAway: false }
      : { due: 1, recordedTaken: 1, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.suppressedReason, 'Records incomplete for 4 days (4–7 Aug)');
});

test('a partial day is evidence the record was kept, and breaks a run', () => {
  // 1 of 2 doses recorded is incomplete, but it proves the app was working. Two
  // silent days either side of it are two runs of one, not a run of three.
  const week = [
    day('2026-08-01', 2, 0, 0),
    day('2026-08-02', 2, 0, 0),
    day('2026-08-03', 2, 1, 0),
    day('2026-08-04', 2, 0, 0),
    day('2026-08-05', 2, 0, 0),
    day('2026-08-06', 2, 2, 0),
    day('2026-08-07', 2, 2, 0),
  ];
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.longestNoRecordRun, 2);
  assert.notEqual(summary.percent, null);
});

test('a silent run at the very end of the window is still found', () => {
  const week = days(7, (i) =>
    i >= 4
      ? { due: 1, recordedTaken: 0, recordedNotTaken: 0, noRecord: 1, isAway: false }
      : { due: 1, recordedTaken: 1, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  assert.equal(summariseAdherence(week, 7).longestNoRecordRun, 3);
});

test('the LONGEST run is what counts, not the first', () => {
  const week = [
    day('2026-08-01', 1, 0, 0),
    day('2026-08-02', 1, 1, 0),
    day('2026-08-03', 1, 0, 0),
    day('2026-08-04', 1, 0, 0),
    day('2026-08-05', 1, 0, 0),
    day('2026-08-06', 1, 0, 0),
    day('2026-08-07', 1, 1, 0),
  ];
  const run = longestNoRecordRun(week);
  assert.deepEqual(run, { days: 4, fromDate: '2026-08-03', toDate: '2026-08-06' });
});

// ── Days with nothing due ────────────────────────────────────────────────────

test('a day with no doses due is not a silent day', () => {
  const week = [
    day('2026-08-01', 1, 1, 0),
    day('2026-08-02', 0, 0, 0),
    day('2026-08-03', 0, 0, 0),
    day('2026-08-04', 0, 0, 0),
    day('2026-08-05', 1, 1, 0),
    day('2026-08-06', 1, 1, 0),
    day('2026-08-07', 1, 1, 0),
  ];
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.longestNoRecordRun, 0);
  assert.equal(summary.percent, 100);
});

test('non-due days are transparent: they join silent days rather than splitting them', () => {
  // An alternate-day medicine. Without transparency this reads as three unrelated
  // one-day gaps and publishes a percentage over a record that is entirely silent.
  const week = [
    day('2026-08-01', 1, 0, 0),
    day('2026-08-02', 0, 0, 0),
    day('2026-08-03', 1, 0, 0),
    day('2026-08-04', 0, 0, 0),
    day('2026-08-05', 1, 0, 0),
    day('2026-08-06', 0, 0, 0),
    day('2026-08-07', 1, 1, 0),
  ];
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.longestNoRecordRun, 3);
  assert.equal(summary.percent, null);
  assert.equal(summary.suppressedReason, 'Records incomplete for 3 days (1–5 Aug)');
});

test('a window with nothing due reports no percentage and says why', () => {
  const week = days(7, () => ({
    due: 0,
    recordedTaken: 0,
    recordedNotTaken: 0,
    noRecord: 0,
    isAway: false,
  }));
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.due, 0);
  assert.equal(summary.percent, null);
  assert.equal(summary.suppressedReason, 'No scheduled doses in this period.');
});

// ── Away days ────────────────────────────────────────────────────────────────

test('a hospital stay does not read as non-adherence', () => {
  // THE CASE THIS RULE EXISTS FOR. Five inpatient days where the ward gave every
  // dose and nobody tapped anything must not appear as five days of failure.
  const week = [
    day('2026-08-01', 2, 2, 0),
    day('2026-08-02', 2, 0, 0, { away: true }),
    day('2026-08-03', 2, 0, 0, { away: true }),
    day('2026-08-04', 2, 0, 0, { away: true }),
    day('2026-08-05', 2, 0, 0, { away: true }),
    day('2026-08-06', 2, 0, 0, { away: true }),
    day('2026-08-07', 2, 2, 0),
  ];
  const summary = summariseAdherence(week, 7);
  assert.equal(summary.due, 4, 'away days must leave the denominator');
  assert.equal(summary.recordedTaken, 4);
  assert.equal(summary.percent, 100);
  assert.equal(summary.suppressedReason, null);
});

test('away days do not count toward a silent run', () => {
  const week = days(7, (i) =>
    i >= 1 && i <= 5
      ? { due: 2, recordedTaken: 0, recordedNotTaken: 0, noRecord: 2, isAway: true }
      : { due: 2, recordedTaken: 2, recordedNotTaken: 0, noRecord: 0, isAway: false },
  );
  assert.equal(summariseAdherence(week, 7).longestNoRecordRun, 0);
});

// ── Date range formatting ────────────────────────────────────────────────────

test('date ranges read the way a person writes them', () => {
  assert.equal(formatDateRange('2026-08-02', '2026-08-05'), '2–5 Aug');
  assert.equal(formatDateRange('2026-08-02', '2026-08-02'), '2 Aug');
  assert.equal(formatDateRange('2026-07-30', '2026-08-02'), '30 Jul – 2 Aug');
  assert.equal(formatDateRange('2025-12-28', '2026-01-03'), '28 Dec 2025 – 3 Jan 2026');
});

test('a malformed date degrades instead of throwing', () => {
  assert.equal(formatDateRange('nonsense', '2026-08-05'), 'nonsense – 2026-08-05');
});

// ── The disclaimer ───────────────────────────────────────────────────────────

test('the disclaimer says exactly what the number is', () => {
  assert.equal(
    adherenceDisclaimer(),
    'Self-reported in app. Records interaction with the app, not medication taken.',
  );
});

test('nothing in a summary ever claims medication was taken', () => {
  const summary = summariseAdherence([day('2026-08-01', 1, 0, 0)], 1);
  assert.doesNotMatch(String(summary.suppressedReason ?? ''), /miss|fail|non-?compliant/i);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test('an empty window is handled', () => {
  const summary = summariseAdherence([], 7);
  assert.equal(summary.due, 0);
  assert.equal(summary.percent, null);
  assert.equal(summary.longestNoRecordRun, 0);
});

test('a single silent day is a run of one, not a suppression', () => {
  const summary = summariseAdherence([day('2026-08-01', 1, 0, 0)], 1);
  assert.equal(summary.longestNoRecordRun, 1);
  assert.equal(summary.percent, 0);
  assert.equal(summary.suppressedReason, null);
});

test('percent is rounded, never truncated toward flattery or blame', () => {
  // 2 of 3 is 66.67 → 67, not 66.
  const summary = summariseAdherence([day('2026-08-01', 3, 2, 0)], 1);
  assert.equal(summary.percent, 67);
});
