/**
 * Adherence — the database side.
 *
 * Turns occurrences + events into the per-day tallies that `./compute.ts` reduces.
 * All the honesty rules live in that pure module; this one is about counting the
 * right rows.
 *
 * WHAT COUNTS AS "DUE" (each exclusion below is a way a naive count lies):
 *
 *   • Not yet reached. A dose scheduled for 20:00 is not outstanding at 14:00.
 *     Counting today's later doses as un-recorded makes every afternoon look like
 *     a relapse.
 *   • Outside the medicine version's started_on…stopped_on window. A discontinued
 *     drug must contribute nothing — otherwise stopping a medicine tanks the
 *     percentage of the ones she is still taking.
 *   • Cancelled. Withdrawn occurrences, including everything retired by an away
 *     range, are not obligations.
 *   • Snoozed with the snooze still running. The question is open, not answered.
 */

import type { AdherenceSummary, Medicine } from '../../types';
import { addDays, daysBetween, toLocalDate } from '../../lib/datetime';
import { getMedicine, getTreatmentStartDate } from '../../db/repositories/medicines';
import { listOccurrences } from '../../db/repositories/occurrences';
import { listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { deriveStatus } from '../dosing/deriveStatus';
import { isAwayOn, listAwayRanges } from '../dosing/watchdog';
import { type DayTally, summariseAdherence } from './compute';

export { adherenceDisclaimer, longestNoRecordRun, NO_RECORD_RUN_SUPPRESSION_THRESHOLD } from './compute';
export type { DayTally, NoRecordRun } from './compute';

export const ADHERENCE_WINDOW_SHORT = 7;
export const ADHERENCE_WINDOW_LONG = 30;

export type AdherenceWindows = {
  last7: AdherenceSummary;
  last30: AdherenceSummary;
  /** Null when no medicine has a start date yet — there is no treatment to measure. */
  sinceTreatmentStart: AdherenceSummary | null;
  treatmentStartedOn: string | null;
};

export async function computeAdherence(
  profileId: string,
  windowDays: number,
  now: number = Date.now(),
): Promise<AdherenceSummary> {
  const days = await buildDayTallies(profileId, windowDays, now);
  return summariseAdherence(days, windowDays);
}

/** The three windows the dashboard and the OPD report both show. */
export async function computeAdherenceWindows(
  profileId: string,
  now: number = Date.now(),
): Promise<AdherenceWindows> {
  const today = toLocalDate(new Date(now));
  const treatmentStartedOn = await getTreatmentStartDate(profileId);

  const [last7, last30] = await Promise.all([
    computeAdherence(profileId, ADHERENCE_WINDOW_SHORT, now),
    computeAdherence(profileId, ADHERENCE_WINDOW_LONG, now),
  ]);

  let sinceTreatmentStart: AdherenceSummary | null = null;
  if (treatmentStartedOn) {
    // Inclusive of both ends: a treatment started today is a one-day window, not zero.
    const span = daysBetween(treatmentStartedOn, today) + 1;
    sinceTreatmentStart = await computeAdherence(profileId, Math.max(1, span), now);
  }

  return { last7, last30, sinceTreatmentStart, treatmentStartedOn };
}

/**
 * One tally per calendar day, contiguous and in order.
 *
 * Contiguity is load-bearing: `longestNoRecordRun` walks this array assuming each
 * entry is the next day. A sparse array built only from days that happen to have
 * occurrences would make a two-week gap look like two adjacent silent days.
 */
export async function buildDayTallies(
  profileId: string,
  windowDays: number,
  now: number = Date.now(),
): Promise<DayTally[]> {
  const today = toLocalDate(new Date(now));
  const fromDate = addDays(today, -(Math.max(1, windowDays) - 1));

  const byDate = new Map<string, DayTally>();
  const away = await listAwayRanges(profileId);
  for (let date = fromDate; date <= today; date = addDays(date, 1)) {
    byDate.set(date, {
      localDate: date,
      due: 0,
      recordedTaken: 0,
      recordedNotTaken: 0,
      noRecord: 0,
      isAway: isAwayOn(away, date),
    });
  }

  const occurrences = await listOccurrences(profileId, fromDate, today);
  if (occurrences.length === 0) return [...byDate.values()];

  const eventsByOccurrence = await listEventsForOccurrences(occurrences.map((o) => o.id));

  // Distinct medicine VERSIONS in a window are few (one per version per drug), so a
  // small cache beats both a join and a per-row lookup.
  const medicineCache = new Map<string, Medicine | null>();
  const medicineFor = async (id: string): Promise<Medicine | null> => {
    const cached = medicineCache.get(id);
    if (cached !== undefined) return cached;
    const loaded = await getMedicine(id);
    medicineCache.set(id, loaded);
    return loaded;
  };

  for (const occurrence of occurrences) {
    const day = byDate.get(occurrence.localDate);
    if (!day) continue;

    // Not yet due. See the header note.
    if (occurrence.scheduledAtEpoch > now) continue;

    const medicine = await medicineFor(occurrence.medicineId);
    if (!medicine) continue;
    if (medicine.startedOn && occurrence.localDate < medicine.startedOn) continue;
    if (medicine.stoppedOn && occurrence.localDate > medicine.stoppedOn) continue;

    const status = deriveStatus(
      eventsByOccurrence.get(occurrence.id) ?? [],
      occurrence.scheduledAtEpoch,
      now,
    );
    if (status === 'cancelled' || status === 'snoozed' || status === 'pending') continue;

    day.due += 1;
    if (status === 'taken') day.recordedTaken += 1;
    else if (status === 'skipped') day.recordedNotTaken += 1;
    else day.noRecord += 1;
  }

  return [...byDate.values()];
}
