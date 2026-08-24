/**
 * Streaks and badges — the database side.
 *
 * Recomputes from the event log rather than incrementing a counter. A retro-edit
 * seven days back would silently corrupt an incremental counter forever, whereas a
 * recomputation just tells the truth again on the next run.
 *
 * Read `./compute.ts` before changing anything here, in particular STREAK_RULES.
 */

import { addDays, toLocalDate } from '../../lib/datetime';
import {
  type Tx,
  createRecord,
  inTransaction,
  queryAll,
  queryFirst,
  upsertRecord,
} from '../../db/repositories/_shared';
import { listCompletedThreads } from '../../db/repositories/medicines';
import { listOccurrences } from '../../db/repositories/occurrences';
import { listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { deriveStatus } from '../dosing/deriveStatus';
import { buildDayTallies } from '../adherence';
import {
  type BadgeAward,
  type StreakDay,
  type StreakState,
  computeStreak,
  earnedPhaseBadges,
  earnedStreakBadges,
  mergeBest,
  STREAK_RULES,
  STREAK_THRESHOLDS,
} from './compute';

export {
  STREAK_RULES,
  STREAK_THRESHOLDS,
  computeStreak,
  earnedPhaseBadges,
  earnedStreakBadges,
};
export type { BadgeAward, StreakDay, StreakState } from './compute';

/**
 * How far back a recomputation walks.
 *
 * Comfortably past the 180-day badge, and bounded so the walk stays cheap on a
 * Go-class device. A streak longer than this reports as this — which understates,
 * never overstates, and there is no badge above it to fall short of.
 */
export const STREAK_LOOKBACK_DAYS = 400;

export type EarnedBadge = {
  id: string;
  key: string;
  earnedOn: string;
};

export type StreakRefresh = {
  state: StreakState;
  /** Badges written by THIS run. Empty on every run after the first that earned one. */
  newlyEarned: BadgeAward[];
};

export async function getStreakState(profileId: string, tx?: Tx): Promise<StreakState> {
  const row = await queryFirst<{
    current_streak: number;
    best_streak: number;
    last_counted_date: string | null;
  }>(
    `SELECT current_streak, best_streak, last_counted_date FROM streak_state WHERE profile_id = ?;`,
    [profileId],
    tx,
  );
  return {
    currentStreak: row?.current_streak ?? 0,
    bestStreak: row?.best_streak ?? 0,
    lastCountedDate: row?.last_counted_date ?? null,
  };
}

export async function listBadges(profileId: string, tx?: Tx): Promise<EarnedBadge[]> {
  const rows = await queryAll<{ id: string; key: string; earned_on: string }>(
    `SELECT id, key, earned_on FROM badge WHERE profile_id = ? ORDER BY earned_on ASC;`,
    [profileId],
    tx,
  );
  return rows.map((r) => ({ id: r.id, key: r.key, earnedOn: r.earned_on }));
}

/**
 * Recomputes the streak and writes any newly reached badges.
 *
 * Safe to call as often as you like: badge writes are `INSERT OR IGNORE` against
 * UNIQUE(profile_id, key), so a badge is written exactly once however many times
 * this runs.
 */
export async function refreshStreak(
  profileId: string,
  now: number = Date.now(),
): Promise<StreakRefresh> {
  const today = toLocalDate(new Date(now));
  const days = await buildStreakDays(profileId, now);
  const previous = await getStreakState(profileId);

  const computed = computeStreak(days, previous.bestStreak);
  const state: StreakState = {
    currentStreak: computed.currentStreak,
    // Belt and braces on top of computeStreak: a high-water mark that a refactor
    // could lower is not a high-water mark.
    bestStreak: mergeBest(previous.bestStreak, computed.bestStreak),
    lastCountedDate: computed.lastCountedDate ?? previous.lastCountedDate,
  };

  const completed = await listCompletedThreads(profileId);
  const candidates = [
    ...earnedStreakBadges(state.currentStreak, computed.lastCountedDate ?? today),
    ...earnedPhaseBadges(completed),
  ];

  const newlyEarned = await inTransaction(async (tx) => {
    await upsertRecord(
      'streak_state',
      {
        profile_id: profileId,
        current_streak: state.currentStreak,
        best_streak: state.bestStreak,
        last_counted_date: state.lastCountedDate,
      },
      tx,
    );

    const existing = new Set((await listBadges(profileId, tx)).map((b) => b.key));
    const awarded: BadgeAward[] = [];
    for (const badge of candidates) {
      if (existing.has(badge.key)) continue;
      await createRecord(
        'badge',
        { profile_id: profileId, key: badge.key, earned_on: badge.earnedOn },
        tx,
        { orIgnore: true },
      );
      awarded.push(badge);
    }
    return awarded;
  });

  return { state, newlyEarned };
}

/**
 * Per-day input for the streak walk.
 *
 * Reuses adherence's tallies — the two features are asking the same question of the
 * same rows, and a second implementation would eventually disagree with the first
 * about what a day contains.
 *
 * TODAY IS TRANSPARENT WHILE IT IS STILL IN PROGRESS. A day with an evening dose
 * still to come is not a day she has failed; counting it would make the number
 * flicker down every morning and up every night, which is exactly the anxious
 * mechanic STREAK_RULES exists to forbid.
 */
async function buildStreakDays(profileId: string, now: number): Promise<StreakDay[]> {
  const today = toLocalDate(new Date(now));
  const tallies = await buildDayTallies(profileId, STREAK_LOOKBACK_DAYS, now);
  const openToday = await hasOpenDosesToday(profileId, today, now);

  return tallies.map((day) => ({
    localDate: day.localDate,
    due: day.localDate === today && openToday ? 0 : day.due,
    recorded: day.recordedTaken + day.recordedNotTaken,
    isAway: day.isAway,
  }));
}

/** True while any of today's doses is still pending or snoozed — i.e. unanswered but not late. */
async function hasOpenDosesToday(
  profileId: string,
  today: string,
  now: number,
): Promise<boolean> {
  const occurrences = await listOccurrences(profileId, today, today);
  if (occurrences.length === 0) return false;

  const eventsByOccurrence = await listEventsForOccurrences(occurrences.map((o) => o.id));
  return occurrences.some((occurrence) => {
    const status = deriveStatus(
      eventsByOccurrence.get(occurrence.id) ?? [],
      occurrence.scheduledAtEpoch,
      now,
    );
    return status === 'pending' || status === 'snoozed';
  });
}

/**
 * Days remaining to the next milestone, for a quiet progress hint.
 *
 * Returns null once every threshold is passed rather than inventing an endless
 * ladder — there is no milestone after 180, and manufacturing one would turn a
 * finite encouragement into an infinite obligation.
 */
export function nextMilestone(
  currentStreak: number,
): { threshold: number; daysRemaining: number } | null {
  const next = STREAK_THRESHOLDS.find((threshold) => threshold > currentStreak);
  if (next === undefined) return null;
  return { threshold: next, daysRemaining: next - currentStreak };
}

/**
 * Badges are patient-facing only.
 *
 * Exported so an export/report builder can assert it rather than merely intend it:
 * a badge on a doctor-facing page reads as a clinical claim about compliance, and
 * it is nothing of the sort.
 */
export function badgesAllowedOnSurface(surface: 'patient' | 'clinical'): boolean {
  return surface === 'patient';
}

/** How far back `refreshStreak` looked, for display next to a long streak. */
export function lookbackStartDate(now: number = Date.now()): string {
  return addDays(toLocalDate(new Date(now)), -(STREAK_LOOKBACK_DAYS - 1));
}
