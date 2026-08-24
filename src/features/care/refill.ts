/**
 * Refills: division, done early enough to matter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EARNS ITS PLACE
 *
 * Running out mid-course is the most preventable adherence failure there is. It is not a
 * memory problem and not a motivation problem — the strip simply ends on a Tuesday, the
 * chemist is shut, and by Thursday a six-month TB course has a two-day hole in it that no
 * reminder can undo. And detecting it costs nothing: quantity ÷ doses per day, with no
 * network, no model, and no clinical knowledge whatsoever.
 *
 * THE SECOND CHECK IS THE ONE PEOPLE MISS. A supply that runs out three days BEFORE the
 * next appointment is a supply that will not be renewed in time, because the renewal
 * happens at the appointment. Comparing those two dates is one subtraction, and it turns
 * "you will run out on the 24th" into "you will run out three days before you see the
 * doctor" — which is the sentence that actually changes what she does.
 *
 * NOTHING HERE IS A CLINICAL CLAIM. Same rule as `db/repositories/stock.ts`: this is
 * stationery-shop arithmetic on a number the user counted herself. It must surface as a
 * neutral reminder to buy more, never as a warning about her treatment, and never as a
 * reason to change a dose. `arithmetic` is returned in full so the screen can show the
 * working — a number a person can check is a number she can correct.
 *
 * PURE. The flooring rule deliberately matches `projectRunOut()` in
 * `db/repositories/stock.ts`; it is reimplemented rather than imported so this module
 * stays free of the SQLite import chain and remains unit-testable and offline.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { addDays, daysBetween } from '../../lib/datetime';

/** Matches `medicine_stock.refill_lead_days DEFAULT 5` in the schema. */
export const DEFAULT_REFILL_LEAD_DAYS = 5;

export type RefillInput = {
  /** The day the supply starts being counted down — normally the day it was counted. */
  readonly startOn: string;
  /** Units in hand on that day: tablets, ml, puffs. */
  readonly quantityDispensed: number;
  /**
   * Units consumed per day — the SUM of the per-slot quantities, not the number of
   * reminders. Two tablets twice a day is 4 units a day, and a box of 30 lasts a week,
   * not a fortnight.
   */
  readonly unitsPerDay: number;
  readonly refillLeadDays?: number;
  /** The next visit, when one is known. Enables the second check. */
  readonly nextVisitOn?: string | null;
  /** Defaults to `startOn`, so the function stays pure and testable. */
  readonly today?: string;
  readonly medicineName?: string;
};

export type RefillArithmetic = {
  readonly quantityDispensed: number;
  readonly unitsPerDay: number;
  readonly daysOfSupply: number;
  readonly startOn: string;
  readonly runOutOn: string;
  readonly refillLeadDays: number;
  readonly refillOn: string;
  /** One line of working, in words, for the confirm screen. */
  readonly workingEn: string;
};

export type RefillWarning = {
  readonly code: 'runs_out_before_next_visit';
  readonly message: string;
  readonly shortfallDays: number;
};

export type RefillProjection = {
  readonly daysOfSupply: number;
  readonly runOutOn: string;
  /** When to be reminded: `refillLeadDays` before running out, never before today. */
  readonly refillOn: string;
  /** Days of supply left counted from `today`, which may be after `startOn`. */
  readonly daysLeftFromToday: number;
  readonly dueNow: boolean;
  /** Null when no next visit is known — "we cannot say" is not "yes". */
  readonly coversNextVisit: boolean | null;
  /** How many days short of the visit the supply falls. Null when not applicable. */
  readonly shortfallDays: number | null;
  readonly arithmetic: RefillArithmetic;
  readonly warning: RefillWarning | null;
  readonly summaryEn: string;
};

/**
 * Returns null when there is no honest daily rate.
 *
 * A PRN medicine has no rate, so it has no run-out date; inventing one would put a refill
 * reminder on the calendar for a painkiller she takes twice a month, and a reminder that
 * is usually wrong teaches her to ignore the ones that are right. Null and zero are
 * different answers and the caller must be able to tell them apart.
 */
export function projectRefill(input: RefillInput): RefillProjection | null {
  const { quantityDispensed, unitsPerDay } = input;
  if (!Number.isFinite(unitsPerDay) || unitsPerDay <= 0) return null;
  if (!Number.isFinite(quantityDispensed) || quantityDispensed < 0) return null;

  const refillLeadDays = Number.isFinite(input.refillLeadDays ?? NaN)
    ? Math.max(0, input.refillLeadDays ?? DEFAULT_REFILL_LEAD_DAYS)
    : DEFAULT_REFILL_LEAD_DAYS;
  const today = input.today ?? input.startOn;

  // FLOORED. 4.8 days of tablets is 4 days of doses plus a fraction nobody can swallow;
  // rounding up hands her a refill date one day after the strip is already empty.
  const daysOfSupply = Math.max(0, Math.floor(quantityDispensed / unitsPerDay));
  const runOutOn = addDays(input.startOn, daysOfSupply);

  const rawRefillOn = addDays(runOutOn, -refillLeadDays);
  // Never in the past: a reminder dated last week is a reminder that never arrives.
  const refillOn = rawRefillOn < today ? today : rawRefillOn;

  const daysLeftFromToday = daysBetween(today, runOutOn);
  const name = input.medicineName ?? 'this medicine';

  const arithmetic: RefillArithmetic = {
    quantityDispensed,
    unitsPerDay,
    daysOfSupply,
    startOn: input.startOn,
    runOutOn,
    refillLeadDays,
    refillOn,
    workingEn:
      `${formatNumber(quantityDispensed)} ÷ ${formatNumber(unitsPerDay)} a day = ${daysOfSupply} days ` +
      `from ${input.startOn}, so it runs out on ${runOutOn}. Reminder ${refillLeadDays} days earlier, on ${refillOn}.`,
  };

  // ── The second check ──────────────────────────────────────────────────────
  let coversNextVisit: boolean | null = null;
  let shortfallDays: number | null = null;
  let warning: RefillWarning | null = null;

  if (input.nextVisitOn) {
    const gap = daysBetween(runOutOn, input.nextVisitOn);
    coversNextVisit = gap <= 0;
    shortfallDays = gap > 0 ? gap : 0;
    if (gap > 0) {
      warning = {
        code: 'runs_out_before_next_visit',
        // Neutral and factual: two dates and the gap between them. No instruction about
        // the medicine, no urgency language, nothing about what it might mean.
        message: `${name} runs out on ${runOutOn}, which is ${gap} day${gap === 1 ? '' : 's'} before the next visit on ${input.nextVisitOn}.`,
        shortfallDays: gap,
      };
    }
  }

  return {
    daysOfSupply,
    runOutOn,
    refillOn,
    daysLeftFromToday,
    dueNow: refillOn <= today,
    coversNextVisit,
    shortfallDays,
    arithmetic,
    warning,
    summaryEn: warning
      ? `${arithmetic.workingEn} ${warning.message}`
      : arithmetic.workingEn,
  };
}

// ── The calendar row ─────────────────────────────────────────────────────────

export type ProposedRefill = {
  readonly kind: 'refill';
  readonly title: string;
  readonly dueOn: string;
  readonly relatedThreadId: string;
  /** The lead time used, recorded so the row can explain itself later. */
  readonly offsetDays: number;
  readonly projection: RefillProjection;
};

/**
 * A refill row for the confirm screen.
 *
 * ON `anchor_source`: a refill hangs off no other calendar entry. Its inputs are the
 * quantity SHE counted and the schedule SHE confirmed, and the only thing this app adds
 * is a division and a lead time — both shown on screen at the moment she accepts them.
 * `db/repositories/care.ts` reserves 'inferred' for rows that can name the care_event
 * they were derived from and be recomputed when it moves; a refill has no such anchor,
 * and pointing it at an unrelated event would mean a rescheduled appointment silently
 * moved a date that has nothing to do with appointments. So this is written as a
 * confirmed row once she accepts it — with `offset_days` recording the lead time, and
 * `related_thread_id` recording which medicine it is about.
 */
export function proposeRefill(args: {
  readonly threadId: string;
  readonly medicineName: string;
  readonly input: RefillInput;
}): ProposedRefill | null {
  const projection = projectRefill({ ...args.input, medicineName: args.medicineName });
  if (!projection) return null;
  return {
    kind: 'refill',
    title: `Buy more ${args.medicineName}`,
    dueOn: projection.refillOn,
    relatedThreadId: args.threadId,
    offsetDays: -projection.arithmetic.refillLeadDays,
    projection,
  };
}

/** Trims the pointless '.0' so the working reads like something a person wrote. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
