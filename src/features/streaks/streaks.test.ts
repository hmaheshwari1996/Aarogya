/**
 * Tests for the streak arithmetic and, just as importantly, for the rules that say
 * what must never be built on top of it.
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
  computeStreak,
  earnedStreakBadges,
  earnedPhaseBadges,
  mergeBest,
  STREAK_RULES,
  STREAK_THRESHOLDS,
} = (await import(MODULE)) as typeof import('./compute');

type Day = import('./compute').StreakDay;

function day(localDate: string, due: number, recorded: number, isAway = false): Day {
  return { localDate, due, recorded, isAway };
}

/** `count` consecutive days from 2026-08-01, described by a callback. */
function series(count: number, make: (index: number) => Omit<Day, 'localDate'>): Day[] {
  const start = new Date(Date.UTC(2026, 7, 1));
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const localDate = d.toISOString().slice(0, 10);
    return { localDate, ...make(i) };
  });
}

// ── The basic count ──────────────────────────────────────────────────────────

test('an unbroken run counts every day', () => {
  const days = series(5, () => ({ due: 2, recorded: 2, isAway: false }));
  const state = computeStreak(days);
  assert.equal(state.currentStreak, 5);
  assert.equal(state.bestStreak, 5);
  assert.equal(state.lastCountedDate, '2026-08-05');
});

test('a skipped dose still counts — she told us', () => {
  // The streak measures record-keeping, not obedience. A deliberate skip is an
  // answer, and treating it as a failure would push people to lie to the app.
  const days = [day('2026-08-01', 2, 2), day('2026-08-02', 2, 2), day('2026-08-03', 2, 2)];
  assert.equal(computeStreak(days).currentStreak, 3);
});

test('an unanswered dose breaks the run', () => {
  const days = [
    day('2026-08-01', 2, 2),
    day('2026-08-02', 2, 1),
    day('2026-08-03', 2, 2),
    day('2026-08-04', 2, 2),
  ];
  const state = computeStreak(days);
  assert.equal(state.currentStreak, 2, 'restarts after the break, counting 3rd and 4th');
});

test('a break restarts at one rather than going negative or being penalised', () => {
  const days = [day('2026-08-01', 1, 1), day('2026-08-02', 1, 0), day('2026-08-03', 1, 1)];
  const state = computeStreak(days);
  assert.equal(state.currentStreak, 1);
  assert.ok(state.currentStreak >= 0);
});

// ── Transparent days ─────────────────────────────────────────────────────────

test('a day with no doses due does not break the run', () => {
  // A Sunday with no medicines is not a failure to take medicine.
  const days = [
    day('2026-08-01', 1, 1),
    day('2026-08-02', 0, 0),
    day('2026-08-03', 0, 0),
    day('2026-08-04', 1, 1),
  ];
  assert.equal(computeStreak(days).currentStreak, 2);
});

test('a day with no doses due does not inflate the run either', () => {
  const days = series(10, (i) => ({ due: i % 2 === 0 ? 1 : 0, recorded: i % 2 === 0 ? 1 : 0, isAway: false }));
  assert.equal(computeStreak(days).currentStreak, 5);
});

test('away days neither break nor extend the run', () => {
  // A week in hospital: the ward gave the doses, nobody tapped anything, and the
  // streak she had before it is still hers.
  const days = [
    day('2026-08-01', 2, 2),
    day('2026-08-02', 2, 2),
    day('2026-08-03', 2, 0, true),
    day('2026-08-04', 2, 0, true),
    day('2026-08-05', 2, 0, true),
    day('2026-08-06', 2, 2),
  ];
  const state = computeStreak(days);
  assert.equal(state.currentStreak, 3);
  assert.equal(state.lastCountedDate, '2026-08-06');
});

// ── best_streak ──────────────────────────────────────────────────────────────

test('best_streak is never reduced by a later break', () => {
  const days = [
    ...series(10, () => ({ due: 1, recorded: 1, isAway: false })),
    day('2026-08-11', 1, 0),
    day('2026-08-12', 1, 1),
  ];
  const state = computeStreak(days);
  assert.equal(state.currentStreak, 1);
  assert.equal(state.bestStreak, 10);
});

test('best_streak carried in from storage is never lowered by a recomputation', () => {
  // A shorter lookback window, or a retro-edit, must not take away a record she
  // genuinely set.
  const days = [day('2026-08-01', 1, 1)];
  assert.equal(computeStreak(days, 42).bestStreak, 42);
  assert.equal(mergeBest(42, 3), 42);
  assert.equal(mergeBest(3, 42), 42);
});

test('an empty history is a zero streak, not an error', () => {
  const state = computeStreak([]);
  assert.deepEqual(state, { currentStreak: 0, bestStreak: 0, lastCountedDate: null });
});

test('a history of only transparent days leaves the streak untouched', () => {
  const days = series(5, () => ({ due: 0, recorded: 0, isAway: false }));
  const state = computeStreak(days, 4);
  assert.equal(state.currentStreak, 0);
  assert.equal(state.bestStreak, 4);
  assert.equal(state.lastCountedDate, null);
});

// ── Badges ───────────────────────────────────────────────────────────────────

test('badges are offered at every threshold already reached', () => {
  const badges = earnedStreakBadges(31, '2026-08-31');
  assert.deepEqual(
    badges.map((b) => b.key),
    ['streak:7', 'streak:30'],
  );
  assert.equal(badges[0]?.earnedOn, '2026-08-31');
  assert.equal(badges[0]?.kind, 'streak');
});

test('a streak below the first threshold earns nothing', () => {
  assert.deepEqual(earnedStreakBadges(6, '2026-08-06'), []);
});

test('every threshold is reachable and they are strictly increasing', () => {
  const thresholds: number[] = [...STREAK_THRESHOLDS];
  const increasing = thresholds.every(
    (value, index) => index === 0 || value > (thresholds[index - 1] ?? Number.NEGATIVE_INFINITY),
  );
  assert.ok(increasing, 'thresholds must increase');
  assert.equal(earnedStreakBadges(180, '2026-08-01').length, thresholds.length);
});

test('a completed course earns a badge dated when the course ended', () => {
  const badges = earnedPhaseBadges([
    { threadId: 'thread-abc', name: 'Isoniazid', stoppedOn: '2026-06-30' },
  ]);
  assert.equal(badges.length, 1);
  assert.equal(badges[0]?.key, 'phase:thread-abc');
  assert.equal(badges[0]?.earnedOn, '2026-06-30');
  assert.equal(badges[0]?.kind, 'phase');
});

test('badge keys are unique per profile so they can only be written once', () => {
  const badges = [
    ...earnedStreakBadges(180, '2026-08-01'),
    ...earnedPhaseBadges([
      { threadId: 't1', name: 'A', stoppedOn: '2026-01-01' },
      { threadId: 't2', name: 'B', stoppedOn: '2026-02-01' },
    ]),
  ];
  const keys = badges.map((b) => b.key);
  assert.equal(new Set(keys).size, keys.length);
});

// ── The rules that protect the patient ───────────────────────────────────────

test('STREAK_RULES forbids every punitive surface', () => {
  assert.equal(STREAK_RULES.neverNotifyOnBreak, true);
  assert.equal(STREAK_RULES.neverRenderFailureState, true);
  assert.equal(STREAK_RULES.neverCelebrateIntrusively, true);
  assert.equal(STREAK_RULES.neverUseShamingCopy, true);
  assert.equal(STREAK_RULES.breakQuietlyRestarts, true);
  assert.equal(STREAK_RULES.bestStreakNeverDecreases, true);
  assert.equal(STREAK_RULES.neverRenderBadgesOnClinicalReports, true);
});

test('STREAK_RULES is frozen, so it cannot be relaxed at runtime', () => {
  assert.ok(Object.isFrozen(STREAK_RULES));
  assert.ok(Object.isFrozen(STREAK_RULES.prohibited));
});

test('the prohibited list names the specific things not to build', () => {
  const joined = STREAK_RULES.prohibited.join(' | ').toLowerCase();
  for (const forbidden of ['notification', 'failure state', 'confetti', 'shaming', 'report']) {
    assert.ok(joined.includes(forbidden), `prohibited list should mention ${forbidden}`);
  }
});

test('badge labels are encouraging without implying a clinical claim', () => {
  const labels = [
    ...earnedStreakBadges(180, '2026-08-01'),
    ...earnedPhaseBadges([{ threadId: 't', name: 'Isoniazid', stoppedOn: '2026-01-01' }]),
  ].map((b) => b.label);

  for (const label of labels) {
    assert.doesNotMatch(
      label,
      /perfect|compliant|compliance|adherence|100%|never missed|don't break/i,
      `badge label must not read as a clinical claim: "${label}"`,
    );
  }
});
