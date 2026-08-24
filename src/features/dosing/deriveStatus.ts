/**
 * The single place an occurrence's status is decided.
 *
 * PURE, and deliberately so. It touches no database, no clock and no module state:
 * `now` is an argument, which is what makes every branch below testable and what
 * stops two callers computing two different answers from the same events.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WORD WE DO NOT USE
 *
 * There is no status meaning "she failed to take it". When the scheduled moment
 * passes with nothing recorded, the honest answer is `no_record` — the app knows
 * what it was told, and it was told nothing. It does not know whether she took the
 * tablet and forgot to tap, took it while the phone was charging in another room,
 * or did not take it at all.
 *
 * Every user-facing surface must render this as "not recorded as taken", never as
 * an accusation. An elderly patient who is doing everything right, on a phone whose
 * OEM killed the alarm process, must not open this app to a wall of red failures
 * that are the app's fault and not hers. See OCCURRENCE_STATUS_COPY below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DoseEvent, OccurrenceStatus } from '../../types';

/**
 * Precedence, highest first:
 *
 *   cancelled  — administrative withdrawal. Beats everything, including `taken`,
 *                because it is how an occurrence created in error (a misread
 *                frequency, a schedule edited after the fact) is retracted.
 *                Callers must therefore be careful about WHEN they emit one:
 *                `reconcile` refuses to cancel an occurrence that already carries a
 *                recorded outcome, so a real swallowed dose is never erased by a
 *                later schedule change.
 *   taken      — includes `prn_taken`. A positive record from any origin.
 *   skipped    — an explicit "no, I am not taking this one". Also a record.
 *   snoozed    — only while the snooze target is still in the future; a lapsed
 *                snooze is not a state, it is silence.
 *   pending    — the scheduled moment has not arrived.
 *   no_record  — it has, and nothing was recorded either way.
 *
 * Event kinds NOT listed above (`delivered`, `dismissed`, `rearmed`,
 * `receiver_error`) are intentionally inert. `dismissed` is the important one:
 * swiping a notification away is not a statement about the medicine, and counting
 * it as either taken or skipped would fabricate a clinical record out of a
 * cleaning-up gesture.
 */
export function deriveStatus(
  events: readonly DoseEvent[],
  scheduledAtEpoch: number,
  now: number,
): OccurrenceStatus {
  let cancelled = false;
  let taken = false;
  let skipped = false;

  // Only the most recent snooze counts. An earlier snooze whose target has passed
  // has already expired, and letting it linger would keep a dose "snoozed" forever.
  let latestSnoozeAt = Number.NEGATIVE_INFINITY;
  let latestSnoozeTarget: number | null = null;

  for (const event of events) {
    switch (event.event) {
      case 'cancelled':
        cancelled = true;
        break;
      case 'taken':
      case 'prn_taken':
        taken = true;
        break;
      case 'skipped':
        skipped = true;
        break;
      case 'snoozed':
        if (event.atEpoch >= latestSnoozeAt) {
          latestSnoozeAt = event.atEpoch;
          latestSnoozeTarget = snoozeTarget(event);
        }
        break;
      default:
        // delivered / dismissed / rearmed / receiver_error — see the note above.
        break;
    }
  }

  if (cancelled) return 'cancelled';
  if (taken) return 'taken';
  if (skipped) return 'skipped';
  if (latestSnoozeTarget !== null && latestSnoozeTarget > now) return 'snoozed';
  if (scheduledAtEpoch > now) return 'pending';
  return 'no_record';
}

/**
 * When a snooze runs out.
 *
 * `untilEpoch` is the canonical field. `snoozeMinutes` is accepted as a fallback
 * because this payload crosses the JS/Kotlin boundary, and that boundary is the one
 * contract in the app the compiler cannot check. A snooze we fail to parse degrades
 * to "not snoozed", which surfaces the dose on the catch-up card — the safe
 * direction. Silently treating an unparseable snooze as active would hide a dose.
 */
export function snoozeTarget(event: DoseEvent): number | null {
  const payload = event.payload;
  if (!payload) return null;

  const until = payload['untilEpoch'];
  if (typeof until === 'number' && Number.isFinite(until)) return until;

  const minutes = payload['snoozeMinutes'];
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return event.atEpoch + minutes * 60_000;
  }
  return null;
}

/**
 * Did the patient tell us anything about this dose, either way?
 *
 * This is the guard `reconcile` uses before retiring a stale occurrence, and the
 * predicate adherence uses to separate "we know" from "we do not know".
 */
export function hasRecordedOutcome(events: readonly DoseEvent[]): boolean {
  return events.some(
    (e) => e.event === 'taken' || e.event === 'prn_taken' || e.event === 'skipped',
  );
}

/** True for the two statuses that mean the patient answered. */
export function isRecordedOutcome(status: OccurrenceStatus): boolean {
  return status === 'taken' || status === 'skipped';
}

/**
 * The required phrasing for each status.
 *
 * Kept next to the logic rather than in the i18n bundle alone, so that anyone
 * reading `no_record` in code immediately sees the sentence it is allowed to
 * become. `en` is the source string; `i18nKey` is what the UI should actually
 * render through.
 */
export const OCCURRENCE_STATUS_COPY: Record<
  OccurrenceStatus,
  { readonly i18nKey: string; readonly en: string }
> = {
  pending: { i18nKey: 'dose.status.pending', en: 'Due' },
  taken: { i18nKey: 'dose.status.taken', en: 'Taken' },
  skipped: { i18nKey: 'dose.status.skipped', en: 'Skipped' },
  snoozed: { i18nKey: 'dose.status.snoozed', en: 'Snoozed' },
  cancelled: { i18nKey: 'dose.status.cancelled', en: 'Cancelled' },
  no_record: { i18nKey: 'dose.status.noRecord', en: 'Not recorded as taken' },
};
