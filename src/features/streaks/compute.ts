/**
 * Streak arithmetic — PURE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS GAMIFICATION FOR SOMEONE WITH A CHRONIC ILLNESS.
 *
 * The person on the other side of this number may be managing tuberculosis,
 * diabetes and hypertension at once, on a phone whose manufacturer kills background
 * processes, in a week when her daughter is ill. She is not a user to be retained.
 * A streak here can only ever be a small, quiet encouragement — and the moment it
 * can also be a punishment, it is a net harm and should not exist.
 *
 * So: a break costs nothing. Nothing is announced, nothing turns red, `best_streak`
 * is never reduced, and the count simply starts again at one. See STREAK_RULES,
 * which is the enforceable form of this paragraph.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One calendar day. `recorded` counts BOTH taken and deliberately skipped doses. */
export type StreakDay = {
  localDate: string;
  /** Doses that had come due on this day. Zero means the day asks nothing. */
  due: number;
  /** Doses with any recorded answer — taken or skipped. Both are her telling us. */
  recorded: number;
  isAway: boolean;
};

export type StreakState = {
  currentStreak: number;
  bestStreak: number;
  lastCountedDate: string | null;
};

/** Consecutive-day milestones. Nothing beyond 180 — a year-long counter is a leash. */
export const STREAK_THRESHOLDS = [7, 30, 60, 90, 180] as const;

/**
 * The design constraints, written down where they can be asserted rather than
 * remembered. `streaks.test.ts` checks this object, so a future change that
 * introduces a punitive surface has to consciously edit a file that says, in
 * English, not to.
 */
export const STREAK_RULES = Object.freeze({
  /** A break is silent. No notification, no email, no in-app interruption. */
  neverNotifyOnBreak: true,
  /** No red, no warning icon, no struck-through counter, no "you lost it". */
  neverRenderFailureState: true,
  /** No confetti, no fanfare, no animation that demands a response. */
  neverCelebrateIntrusively: true,
  /** No "don't break the chain", no guilt, no comparison to other users. */
  neverUseShamingCopy: true,
  /** A break restarts at one. Nothing is deducted and nothing is announced. */
  breakQuietlyRestarts: true,
  /** `best_streak` is a high-water mark. It only ever goes up. */
  bestStreakNeverDecreases: true,
  /**
   * Badges are patient-facing encouragement and nothing else. A doctor reading a
   * badge on a report would read it as a clinical claim about compliance, which it
   * is not — it is a count of app interactions with a nice icon on it.
   */
  neverRenderBadgesOnClinicalReports: true,
  prohibited: Object.freeze([
    'streak-lost notification',
    'red or warning failure state for a broken streak',
    'confetti or celebratory interstitial',
    'shaming or guilt-inducing copy',
    'badges on any doctor-facing export or report',
  ] as readonly string[]),
} as const);

/**
 * Walks the days oldest-first and returns the streak as of the last day given.
 *
 * A day is one of three things:
 *   • EARNING     — doses were due and every one of them has an answer. +1.
 *   • TRANSPARENT — nothing was due, or she was away. Neither adds nor breaks.
 *                   A Sunday with no medicines is not a failure to take medicine,
 *                   and neither is a week in hospital.
 *   • BREAKING    — doses were due and at least one has no answer. Resets to 0,
 *                   silently.
 *
 * `previousBest` comes from `streak_state` and is only ever raised.
 */
export function computeStreak(days: readonly StreakDay[], previousBest = 0): StreakState {
  let current = 0;
  let best = Math.max(0, previousBest);
  let lastCountedDate: string | null = null;

  for (const day of days) {
    if (day.isAway || day.due === 0) continue;

    if (day.recorded >= day.due) {
      current += 1;
      lastCountedDate = day.localDate;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }

  return { currentStreak: current, bestStreak: best, lastCountedDate };
}

export type BadgeAward = {
  /** Stable, unique per profile. `badge` has UNIQUE(profile_id, key). */
  key: string;
  earnedOn: string;
  kind: 'streak' | 'phase';
  /** For a streak badge, the threshold reached. */
  threshold?: number;
  label: string;
};

/**
 * Which consecutive-day badges a streak has reached.
 *
 * Every threshold at or below the current streak is returned, not just the newest.
 * A user whose 7-day badge was never written because the app was closed at the
 * moment she crossed it should still have it; the UNIQUE constraint makes
 * re-offering it free.
 */
export function earnedStreakBadges(currentStreak: number, asOfDate: string): BadgeAward[] {
  return STREAK_THRESHOLDS.filter((threshold) => currentStreak >= threshold).map((threshold) => ({
    key: `streak:${threshold}`,
    earnedOn: asOfDate,
    kind: 'streak' as const,
    threshold,
    label: `${threshold} days of keeping your record`,
  }));
}

/**
 * A badge for each completed course of treatment.
 *
 * "Treatment phase" has no table of its own in v1, so it is defined here as a
 * medicine thread that reached a recorded stop date — finishing a six-month TB
 * course, or a two-week antibiotic. That is a real thing to have completed, and
 * unlike a streak it cannot be lost by a phone being switched off.
 *
 * The badge is earned on the day the course ended, not the day the app noticed.
 */
export function earnedPhaseBadges(
  completed: readonly { threadId: string; name: string; stoppedOn: string }[],
): BadgeAward[] {
  return completed.map((course) => ({
    key: `phase:${course.threadId}`,
    earnedOn: course.stoppedOn,
    kind: 'phase' as const,
    label: `Completed your course of ${course.name}`,
  }));
}

/** Never lower a high-water mark, whatever a recomputation says. */
export function mergeBest(previousBest: number, computedBest: number): number {
  return Math.max(previousBest, computedBest);
}
