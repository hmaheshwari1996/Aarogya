/**
 * The offsets, made editable.
 *
 * Every number in `DEFAULT_CARE_OFFSETS` is a guess about how clinics and laboratories
 * behave — two days to get an appointment, about a day for a routine biochemistry report.
 * Those guesses are wrong somewhere: a government hospital lab that returns cultures in a
 * week, a private centre that hands over imaging on the spot, a town where a slot needs a
 * fortnight's notice. When a user drags a date on the confirm screen, she is not
 * correcting our error, she is supplying information we never had — and it is worth
 * keeping, because the next prescription should not repeat the same wrong guess.
 *
 * Stored as one JSON blob in `app_meta`: a handful of small integers of device-local
 * preference, with no history worth keeping and nothing to sync.
 *
 * READS NEVER THROW. A corrupt or partly-written value falls back to the shipped default
 * field by field, because a settings row must never be able to stop a prescription being
 * reviewed.
 */

import { getDb, inTransaction, queryFirst, type Tx } from '../../db/repositories/_shared';
import type { TestCategory } from '../prescriptions/schema';
import { DEFAULT_CARE_OFFSETS, DEFAULT_TEST_TURNAROUND_DAYS, type CareOffsets } from './calendar';

const KEY = 'care.offsets';

/** Nothing sensible is more than a season away, and a typo of 3000 must not stick. */
const MAX_DAYS = 90;

export type CareOffsetsPatch = {
  readonly appointmentBookLeadDays?: number;
  readonly testBookLeadDays?: number;
  readonly reportInHandDays?: number;
  readonly turnaroundDays?: Partial<Record<TestCategory, number>>;
};

export async function getCareOffsets(tx?: Tx): Promise<CareOffsets> {
  try {
    await getDb();
    const row = await queryFirst<{ value: string | null }>(
      `SELECT value FROM app_meta WHERE key = ?;`,
      [KEY],
      tx,
    );
    if (!row?.value) return DEFAULT_CARE_OFFSETS;
    return merge(JSON.parse(row.value) as unknown);
  } catch {
    return DEFAULT_CARE_OFFSETS;
  }
}

export async function setCareOffsets(patch: CareOffsetsPatch, tx?: Tx): Promise<CareOffsets> {
  const current = await getCareOffsets(tx);
  const next = merge({
    appointmentBookLeadDays: patch.appointmentBookLeadDays ?? current.appointmentBookLeadDays,
    testBookLeadDays: patch.testBookLeadDays ?? current.testBookLeadDays,
    reportInHandDays: patch.reportInHandDays ?? current.reportInHandDays,
    turnaroundDays: { ...current.turnaroundDays, ...(patch.turnaroundDays ?? {}) },
  });

  await inTransaction(async (t) => {
    await t.db.runAsync(
      `INSERT INTO app_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [KEY, JSON.stringify(next)],
    );
  }, tx);
  return next;
}

export async function resetCareOffsets(tx?: Tx): Promise<CareOffsets> {
  await inTransaction(async (t) => {
    await t.db.runAsync(`DELETE FROM app_meta WHERE key = ?;`, [KEY]);
  }, tx);
  return DEFAULT_CARE_OFFSETS;
}

/** Field-by-field, so one bad number cannot discard the other five. */
function merge(stored: unknown): CareOffsets {
  const source = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const storedTurnaround =
    typeof source['turnaroundDays'] === 'object' && source['turnaroundDays'] !== null
      ? (source['turnaroundDays'] as Record<string, unknown>)
      : {};

  const turnaroundDays = { ...DEFAULT_TEST_TURNAROUND_DAYS };
  for (const key of Object.keys(turnaroundDays) as TestCategory[]) {
    turnaroundDays[key] = days(storedTurnaround[key], DEFAULT_TEST_TURNAROUND_DAYS[key]);
  }

  return {
    appointmentBookLeadDays: days(
      source['appointmentBookLeadDays'],
      DEFAULT_CARE_OFFSETS.appointmentBookLeadDays,
    ),
    testBookLeadDays: days(source['testBookLeadDays'], DEFAULT_CARE_OFFSETS.testBookLeadDays),
    reportInHandDays: days(source['reportInHandDays'], DEFAULT_CARE_OFFSETS.reportInHandDays),
    turnaroundDays,
  };
}

function days(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > MAX_DAYS) return fallback;
  return rounded;
}
