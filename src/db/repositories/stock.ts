/**
 * Medicine stock — `medicine_stock`.
 *
 * Stock is counted per THREAD, never per medicine version. `medicine` and
 * `dose_schedule` append a new version whenever the dose changes, but the tablets in
 * the box do not care that the doctor halved the dose: the same 30 tablets are still
 * sitting on the shelf. Keying stock to `medicine_id` would zero the count on every
 * dose change and tell her to buy a strip she already owns.
 *
 * A COUNT IS AN OBSERVATION ON A DATE. Counts are appended, never rewritten, because
 * the sequence of counts is the only evidence of how fast the box is actually
 * emptying — overwriting yesterday's 30 with today's 24 destroys the one fact that
 * made the estimate possible. `updateStock` exists for correcting a typo, not for
 * "the number changed".
 *
 * NOTHING IN THIS FILE IS A CLINICAL CLAIM. `projectRunOut` and `needsRefill` are
 * division on a number the user typed in herself. They answer "at this rate the box
 * empties around then", which is stationery-shop arithmetic, not advice. They must
 * surface as a neutral refill reminder and must never be phrased as an instruction
 * about medication, never as a warning, and never as a reason to change a dose.
 */

import { addDays, daysBetween, toLocalDate } from '../../lib/datetime';
import {
  createRecord,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Types ────────────────────────────────────────────────────────────────────

export type MedicineStock = {
  id: string;
  /** Stable identity of the drug across dose versions. */
  threadId: string;
  profileId: string;
  quantityOnHand: number;
  /** 'YYYY-MM-DD' — the day the tablets were counted, not the day the row was saved. */
  countedOn: string;
  unitCost: number | null;
  refillLeadDays: number;
};

export type RecordCountInput = {
  profileId: string;
  threadId: string;
  quantityOnHand: number;
  /** Defaults to today. Set it explicitly when back-entering a count from Sunday. */
  countedOn?: string;
  unitCost?: number | null;
  refillLeadDays?: number;
};

export type StockPatch = {
  quantityOnHand?: number;
  countedOn?: string;
  unitCost?: number | null;
  refillLeadDays?: number;
};

export type RunOutProjection = {
  /** Whole days of supply left from `countedOn`. Always floored. */
  daysRemaining: number;
  /** 'YYYY-MM-DD' the supply is projected to reach zero. */
  runOutOn: string;
};

/** Matches `medicine_stock.refill_lead_days DEFAULT 5` in the schema. */
export const DEFAULT_REFILL_LEAD_DAYS = 5;

type MedicineStockRow = {
  id: string;
  thread_id: string;
  profile_id: string;
  quantity_on_hand: number;
  counted_on: string;
  unit_cost: number | null;
  refill_lead_days: number;
};

const STOCK_COLUMNS =
  'id, thread_id, profile_id, quantity_on_hand, counted_on, unit_cost, refill_lead_days';

function mapStock(row: MedicineStockRow): MedicineStock {
  return {
    id: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    quantityOnHand: row.quantity_on_hand,
    countedOn: row.counted_on,
    unitCost: row.unit_cost,
    refillLeadDays: row.refill_lead_days,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The most recent count for one thread, or null if she has never counted it.
 *
 * `created_at_epoch` breaks ties: two counts bearing the same `counted_on` mean she
 * recounted after finding more strips in the cupboard, and the later entry is the
 * one she meant.
 */
export async function getLatestCount(
  profileId: string,
  threadId: string,
  tx?: Tx,
): Promise<MedicineStock | null> {
  const row = await queryFirst<MedicineStockRow>(
    `SELECT ${STOCK_COLUMNS} FROM medicine_stock
      WHERE profile_id = ? AND thread_id = ? AND deleted_at_epoch IS NULL
      ORDER BY counted_on DESC, created_at_epoch DESC
      LIMIT 1;`,
    [profileId, threadId],
    tx,
  );
  return row ? mapStock(row) : null;
}

/** Latest count per thread — one row per drug she has ever counted. */
export async function listStock(profileId: string, tx?: Tx): Promise<MedicineStock[]> {
  // Correlated "id = (pick the newest for this thread)" rather than a GROUP BY on
  // MAX(counted_on): grouping returns the max date but arbitrary columns from some
  // other row in the group, which silently pairs Monday's date with Friday's count.
  const rows = await queryAll<MedicineStockRow>(
    `SELECT ${STOCK_COLUMNS} FROM medicine_stock s
      WHERE s.profile_id = ?
        AND s.deleted_at_epoch IS NULL
        AND s.id = (
          SELECT s2.id FROM medicine_stock s2
           WHERE s2.profile_id = s.profile_id
             AND s2.thread_id = s.thread_id
             AND s2.deleted_at_epoch IS NULL
           ORDER BY s2.counted_on DESC, s2.created_at_epoch DESC
           LIMIT 1
        )
      ORDER BY s.counted_on DESC, s.created_at_epoch DESC;`,
    [profileId],
    tx,
  );
  return rows.map(mapStock);
}

/** Every count for one thread, newest first — the run-rate history behind a projection. */
export async function listCountsForThread(
  profileId: string,
  threadId: string,
  tx?: Tx,
): Promise<MedicineStock[]> {
  const rows = await queryAll<MedicineStockRow>(
    `SELECT ${STOCK_COLUMNS} FROM medicine_stock
      WHERE profile_id = ? AND thread_id = ? AND deleted_at_epoch IS NULL
      ORDER BY counted_on DESC, created_at_epoch DESC;`,
    [profileId, threadId],
    tx,
  );
  return rows.map(mapStock);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Appends a new count. This is the ONLY normal way stock changes. */
export async function recordCount(input: RecordCountInput, tx?: Tx): Promise<string> {
  return createRecord(
    'medicine_stock',
    {
      profile_id: input.profileId,
      thread_id: input.threadId,
      quantity_on_hand: input.quantityOnHand,
      counted_on: input.countedOn ?? toLocalDate(),
      unit_cost: input.unitCost ?? null,
      refill_lead_days: input.refillLeadDays ?? DEFAULT_REFILL_LEAD_DAYS,
    },
    tx,
  );
}

/**
 * Corrects one existing count row.
 *
 * Reserved for fixing an entry error ("I typed 3 instead of 30"). Recording that the
 * box has emptied since is `recordCount`, not this — see the file header.
 */
export async function updateStock(id: string, patch: StockPatch, tx?: Tx): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.quantityOnHand !== undefined) values['quantity_on_hand'] = patch.quantityOnHand;
  if (patch.countedOn !== undefined) values['counted_on'] = patch.countedOn;
  if (patch.unitCost !== undefined) values['unit_cost'] = patch.unitCost;
  if (patch.refillLeadDays !== undefined) values['refill_lead_days'] = patch.refillLeadDays;
  if (Object.keys(values).length === 0) return;
  await updateRecord('medicine_stock', id, values, tx);
}

export async function deleteStockCount(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('medicine_stock', id, tx);
}

// ── Pure projections (no DB — unit-testable in isolation) ────────────────────

/**
 * Arithmetic, not prognosis: quantity ÷ daily rate, from the date of the count.
 *
 * Returns null for `dosesPerDay <= 0`. A PRN medicine has no daily rate, so there is
 * no honest run-out date for it; inventing one would put a refill reminder on the
 * calendar for a drug she takes twice a month. "We cannot say" and "you have plenty"
 * are different answers and the caller must be able to tell them apart, which is why
 * this is null rather than Infinity or a large number.
 *
 * Days are FLOORED. 4.8 days of tablets is 4 days of doses plus a fraction that
 * cannot be swallowed; rounding up would hand her a refill date one day after the
 * strip is already empty.
 */
export function projectRunOut(
  countedOn: string,
  quantityOnHand: number,
  dosesPerDay: number,
): RunOutProjection | null {
  if (!Number.isFinite(dosesPerDay) || dosesPerDay <= 0) return null;
  if (!Number.isFinite(quantityOnHand)) return null;

  const daysRemaining = Math.max(0, Math.floor(quantityOnHand / dosesPerDay));
  return { daysRemaining, runOutOn: addDays(countedOn, daysRemaining) };
}

/**
 * Whether the projected run-out is within the refill lead time as of `asOf`.
 *
 * False when there is no projection at all (PRN, or a nonsense rate): silence is the
 * correct output when we do not know, and a false refill prompt on a medicine she
 * takes occasionally teaches her to ignore the real ones.
 */
export function needsRefill(
  countedOn: string,
  quantityOnHand: number,
  dosesPerDay: number,
  refillLeadDays: number = DEFAULT_REFILL_LEAD_DAYS,
  asOf: string = toLocalDate(),
): boolean {
  const projection = projectRunOut(countedOn, quantityOnHand, dosesPerDay);
  if (!projection) return false;

  // Measured from TODAY, not from the count date — a count taken three weeks ago has
  // already been eaten into, and its `daysRemaining` is stale by exactly that much.
  const daysLeft = daysBetween(asOf, projection.runOutOn);
  const lead = Number.isFinite(refillLeadDays) ? Math.max(0, refillLeadDays) : DEFAULT_REFILL_LEAD_DAYS;
  return daysLeft <= lead;
}
