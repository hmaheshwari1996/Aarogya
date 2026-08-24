/**
 * As-needed (PRN) doses.
 *
 * PRN medicines generate NO occurrences — there is no scheduled moment, so there is
 * nothing to be pending, nothing to be un-recorded, and nothing to remind her about.
 * This module is a log and only a log.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It does not compute a minimum interval. It does not say "you can take another in
 * 3 hours", it does not warn that a dose is too soon, and it does not cap a daily
 * count. Every one of those is a dosing decision, and a dosing decision made by an
 * app from a `quantity_text` string it OCR'd off a photograph is a dosing decision
 * made on no evidence.
 *
 * The honest product is: she taps, we write down that she took one and when. If she
 * wants to know whether she can take another, the person to ask is her doctor, and
 * the log below is what she can show them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DoseEvent } from '../../types';
import { addDays, toLocalDate, toLocalTime } from '../../lib/datetime';
import { occurrenceId } from '../../lib/ids';
import { type Tx, inTransaction, nowEpoch } from '../../db/repositories/_shared';
import { appendEvent, listPrnEvents } from '../../db/repositories/doseEvents';
import { getCurrentVersion } from '../../db/repositories/medicines';
import { getCurrentSchedules } from '../../db/repositories/schedules';

export type PrnLogResult = {
  eventId: string;
  /** Synthetic, and never backed by a `dose_occurrence` row. See below. */
  occurrenceId: string;
  atEpoch: number;
};

/**
 * Records one as-needed dose, taken now.
 *
 * `atEpoch` is now, not a scheduled time, because there was no scheduled time. The
 * occurrence id is synthesised from the thread and the current wall clock purely so
 * the event has a well-formed grouping key; no row is created for it, and
 * `deriveStatus` never runs against it.
 *
 * Each tap writes its own event with its own random id — NOT the content-derived id
 * the journal drain uses. Two taps a few minutes apart on a painkiller are two real
 * doses, and collapsing them into one would erase half of what she took.
 */
export async function logPrnDose(
  threadId: string,
  options: { atEpoch?: number; note?: string | null } = {},
  tx?: Tx,
): Promise<PrnLogResult> {
  return inTransaction(async (t) => {
    const medicine = await getCurrentVersion(threadId, t);
    if (!medicine) throw new Error(`No medicine thread ${threadId}`);

    // Same human-confirmation gate the scheduled path gets from a database trigger.
    // An AI-extracted "take as needed for pain" must not become a loggable dose
    // until somebody has read it.
    if (medicine.confirmedByUserAt === null) {
      throw new Error('Refused: this medicine has not been confirmed by a person yet.');
    }

    const atEpoch = options.atEpoch ?? nowEpoch();
    const when = new Date(atEpoch);
    const syntheticOccurrenceId = occurrenceId(threadId, toLocalDate(when), toLocalTime(when));

    const eventId = await appendEvent(
      {
        occurrenceId: syntheticOccurrenceId,
        threadId,
        medicineId: medicine.id,
        profileId: medicine.profileId,
        event: 'prn_taken',
        atEpoch,
        payload: options.note ? { note: options.note } : null,
        origin: 'app',
      },
      t,
    );

    return { eventId, occurrenceId: syntheticOccurrenceId, atEpoch };
  }, tx);
}

/** True when this thread's current schedule is as-needed rather than fixed. */
export async function isPrnThread(threadId: string, tx?: Tx): Promise<boolean> {
  const schedules = await getCurrentSchedules(threadId, tx);
  if (schedules.length === 0) return false;
  return schedules.every((s) => s.scheduleType === 'PRN');
}

/**
 * The log itself, newest first — what she shows a doctor.
 *
 * Returned as raw events with no derived rate, no average and no "usual time",
 * because summarising as-needed use into a pattern implies a pattern exists.
 */
export async function listPrnDoses(
  profileId: string,
  threadId: string,
  options: { fromDate?: string; toDate?: string } = {},
  tx?: Tx,
): Promise<DoseEvent[]> {
  const toDate = options.toDate ?? toLocalDate();
  const fromDate = options.fromDate ?? addDays(toDate, -30);
  return listPrnEvents(profileId, threadId, fromDate, toDate, tx);
}

/**
 * How many as-needed doses were logged on each day of a range.
 *
 * A plain count per date, for the calendar dots. It answers "what happened", never
 * "was that too many".
 */
export async function countPrnDosesByDate(
  profileId: string,
  threadId: string,
  fromDate: string,
  toDate: string,
  tx?: Tx,
): Promise<Map<string, number>> {
  const events = await listPrnEvents(profileId, threadId, fromDate, toDate, tx);
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.localDate, (counts.get(event.localDate) ?? 0) + 1);
  }
  return counts;
}
