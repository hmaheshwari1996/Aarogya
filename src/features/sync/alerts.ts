/**
 * Telling the family that something has gone quiet.
 *
 * ═══ A PUBLIC LINK CANNOT DELIVER A PUSH, AND SAYING SO IS THE POINT ══════════════
 *
 * This module used to send a content-free ping to every APPROVED VIEWER. There is no
 * viewer list any more: the patient has one link and gives it to whoever she likes, and
 * the app never learns who that was — no account, no device registration, no phone number,
 * nothing to address a notification to. That is the price of the sharing model, and it is
 * a real one, so it is written down here rather than quietly absorbed.
 *
 * WHAT REPLACES IT, IN ORDER OF WHAT ACTUALLY REACHES A PERSON:
 *
 *   1. THE WHATSAPP DRAFT, which is the active path. `composeWhatsAppMessage()` puts a
 *      message one tap away and the app never sends it. This is the only mechanism here
 *      that can reach somebody who is not already looking at their phone.
 *   2. THE ALERT ON THE SHARED VIEW. `recordQuietDoseAlert()` writes the alert onto this
 *      phone, and it rides in the next snapshot (`./snapshot.ts`) so it is the first thing
 *      at the top of the shared view whenever a viewer next opens the link. Passive, but
 *      it costs nothing and it means the family member who does check is not left
 *      comparing dates.
 *
 * Automatic sending stays off the table. It would put a health disclosure in somebody's
 * chat history without the person it is about being in the room, and it would do it on the
 * app's schedule rather than hers.
 *
 * ─── TWO CONSECUTIVE DOSES, ON ANY MEDICINE ───────────────────────────────────────
 * The threshold is two, and it counts EVERY medicine rather than only the critical ones.
 *
 * That is the opposite of the obvious design, and it is the right one. Criticality is a
 * per-drug clinical tier that answers "how bad is missing this one"; it does not answer the
 * question a family actually cares about, which is "has she stopped using the phone / has
 * something happened". Two silent doses in a row across ANY medicine is the earliest honest
 * signal of that, and restricting it to the critical tier would mean a woman on three
 * ordinary tablets could go dark for a week without anyone hearing.
 *
 * One dose is noise — a phone face-down, a nap, an alarm that Doze swallowed. Two in a row
 * is a pattern.
 *
 * ─── THE ALERT CARRIES NO MEDICAL CONTENT ─────────────────────────────────────────
 * A count and a time, and nothing else. No medicine name, no condition, no number. The
 * snapshot is encrypted, but this row is the one most likely to be read over a shoulder,
 * and there is no version of "she has not recorded her Metformin" that is worth the risk of
 * that being the line somebody else reads.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

import { listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { listOccurrences } from '../../db/repositories/occurrences';
import { addDays, toLocalDate } from '../../lib/datetime';
import type { DoseOccurrence } from '../../types';
import { lastAlertAtEpoch, publishSnapshot, recordSharedAlert } from './snapshot';

/** Two in a row. See the header for why it is two and why it is not tier-filtered. */
export const CONSECUTIVE_THRESHOLD = 2;

/** How far back to look. Long enough to span a weekend of doses, short enough to be cheap. */
export const LOOKBACK_DAYS = 3;

/**
 * A dose is not "silent" until its scheduled moment is properly past.
 *
 * Ninety minutes, because an alarm that fired at 08:00 and was answered at 09:10 is a
 * completely ordinary morning, and alerting the family about it would train them to ignore
 * the one that matters.
 */
export const GRACE_MS = 90 * 60 * 1000;

/** Never more than one alert a day, however bad the pattern looks. */
export const MIN_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type DoseSilence = {
  /** Consecutive doses, most recent first, with nothing recorded either way. */
  readonly silent: readonly DoseOccurrence[];
  readonly consecutive: number;
  readonly shouldAlert: boolean;
  /** When the last of those doses was due. Used for the one-a-day gate. */
  readonly latestScheduledAtEpoch: number | null;
};

/**
 * The whole rule, pure.
 *
 * Takes occurrences already ordered by scheduled time and a predicate saying whether each
 * had ANY dose event — `delivered` and `dismissed` count, deliberately. This is not an
 * adherence measure and must not become one: the question is "is the phone being used", and
 * a notification that was delivered and swiped away answers it.
 */
export function evaluateSilence(
  occurrences: readonly DoseOccurrence[],
  hasEvent: (occurrenceId: string) => boolean,
  now: number,
  threshold: number = CONSECUTIVE_THRESHOLD,
): DoseSilence {
  const passed = occurrences
    .filter((occurrence) => occurrence.scheduledAtEpoch + GRACE_MS <= now)
    .filter((occurrence) => occurrence.status !== 'cancelled')
    .sort((a, b) => b.scheduledAtEpoch - a.scheduledAtEpoch);

  const silent: DoseOccurrence[] = [];
  for (const occurrence of passed) {
    // The run must be UNBROKEN and must end at the most recent dose. A gap three days ago
    // followed by two days of perfect recording is not something to alert about.
    if (hasEvent(occurrence.id)) break;
    silent.push(occurrence);
  }

  return {
    silent,
    consecutive: silent.length,
    shouldAlert: silent.length >= threshold,
    latestScheduledAtEpoch: silent[0]?.scheduledAtEpoch ?? null,
  };
}

/**
 * Reads the last few days and applies the rule.
 *
 * Deliberately does not record anything — `recordQuietDoseAlert` does that — so the check
 * can be run by a screen that only wants to show the state.
 */
export async function checkDoseSilence(profileId: string, now: number = Date.now()): Promise<DoseSilence> {
  const today = toLocalDate(new Date(now));
  const occurrences = await listOccurrences(profileId, addDays(today, -LOOKBACK_DAYS), today);
  if (occurrences.length === 0) {
    return { silent: [], consecutive: 0, shouldAlert: false, latestScheduledAtEpoch: null };
  }

  // A Map<occurrenceId, DoseEvent[]> with an entry for EVERY id asked for, including the
  // ones with no events — so "recorded something" is a non-empty list, not a present key.
  const byOccurrence = await listEventsForOccurrences(occurrences.map((occurrence) => occurrence.id));

  return evaluateSilence(occurrences, (id) => (byOccurrence.get(id)?.length ?? 0) > 0, now);
}

export type AlertOutcome = {
  readonly recorded: boolean;
  readonly reason: 'recorded' | 'nothing_to_report' | 'too_soon' | 'failed';
  /**
   * True when the alert also reached the server, so it will be on the shared view the next
   * time somebody opens the link. False is not a failure — the alert is on this phone and
   * the next successful publish carries it.
   */
  readonly published: boolean;
};

/**
 * Checks, and records an alert on this phone if the rule fires.
 *
 * A background path: an unconfigured phone and an offline one both return quietly. Nothing
 * is sent to anybody — see the header. What this produces is a line at the top of the
 * shared view, plus a signal the screen can use to offer the WhatsApp draft.
 */
export async function recordQuietDoseAlert(
  profileId: string,
  now: number = Date.now(),
): Promise<AlertOutcome> {
  const silence = await checkDoseSilence(profileId, now);
  if (!silence.shouldAlert) {
    return { recorded: false, reason: 'nothing_to_report', published: false };
  }

  const last = await lastAlertAtEpoch(now);
  if (last !== null && now - last < MIN_ALERT_INTERVAL_MS) {
    return { recorded: false, reason: 'too_soon', published: false };
  }

  try {
    await recordSharedAlert(
      {
        kind: 'quiet_doses',
        atEpoch: now,
        consecutive: silence.consecutive,
        latestScheduledAtEpoch: silence.latestScheduledAtEpoch,
      },
      now,
    );
  } catch (error) {
    console.warn('[sync] the alert could not be recorded', error);
    return { recorded: false, reason: 'failed', published: false };
  }

  const outcome = await publishSnapshot(now);
  return { recorded: true, reason: 'recorded', published: outcome.published };
}

// ── The message she sends herself ────────────────────────────────────────────

export type WhatsAppDraft = {
  readonly en: string;
  readonly hi: string;
};

/**
 * Composes a message the user can send herself. It is never sent by the app.
 *
 * Written to be forwardable without embarrassing anybody: it names no medicine, no
 * condition and no number. "Amma has not marked her tablets since yesterday evening" is the
 * whole content, because a WhatsApp message is not a private channel — it sits in a chat
 * that gets read over shoulders and backed up to a Drive that is not end-to-end encrypted
 * unless the user turned that on.
 *
 * `patientName` is whatever the profile is called, which the family already knows.
 */
export function composeWhatsAppMessage(
  patientName: string,
  silence: DoseSilence,
  formatWhen: (epoch: number) => string,
): WhatsAppDraft {
  const when = silence.latestScheduledAtEpoch === null ? '' : formatWhen(silence.latestScheduledAtEpoch);
  const count = silence.consecutive;

  return {
    en:
      `${patientName} has not marked ${count === 1 ? 'a dose' : `${count} doses`} in Aarogya` +
      `${when ? ` since ${when}` : ''}. It may be nothing — could you check in?`,
    hi:
      `${patientName} ने आरोग्य में ${count === 1 ? 'एक खुराक' : `${count} खुराकें`} दर्ज नहीं की${
        when ? `, ${when} से` : ''
      }। शायद कोई बात न हो — क्या आप एक बार पूछ लेंगे?`,
  };
}

/**
 * A `wa.me` deep link, which OPENS WhatsApp with the text prefilled and stops there.
 *
 * There is no phone number in it and there cannot be — the app holds none — so it opens the
 * contact picker. That is the point: the user chooses the recipient, in WhatsApp's own UI,
 * and presses send herself. The app never learns who it went to.
 */
export function whatsAppShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
