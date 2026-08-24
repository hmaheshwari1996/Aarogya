/**
 * The one place the native alarm module is imported.
 *
 * Funnelling every call through this file buys two things:
 *
 *  • A single, explicit statement of the JS↔Kotlin contract. Everything below this
 *    line is compile-checked; the boundary itself is not, so it is worth having in
 *    one readable place rather than smeared across reconcile, the drain and the
 *    watchdog.
 *
 *  • A survivable absence. The module is not linked in Expo Go, and is not present
 *    at all under the node test runner. Reminders failing is bad; the app refusing
 *    to record a dose because reminders are unavailable is worse — the database is
 *    the part that must never stop working. Every wrapper here degrades to a
 *    logged no-op and reports failure through its return value.
 */

import { MedAlarm as NativeMedAlarm } from '../../../modules/med-alarm';
import type { AlarmHorizon } from '../../types';

/** One journal file written by Kotlin: an opaque name plus the JSON it contains. */
export type JournalEntry = {
  /** Opaque handle used to unlink the file after its row commits. */
  readonly name: string;
  readonly json: string;
};

/**
 * The module is the source of truth for this contract, so we bind to it directly
 * rather than restating it. An earlier version declared its own `MedAlarmContract`
 * and cast to it, which silently drifted the moment the module's signature changed —
 * the cast compiled while the argument types no longer matched at all.
 *
 * The one shape that IS translated here is the journal entry. The module hands back
 * an already-parsed `JournalRecord & { fileName }`; the drain deliberately re-validates
 * a raw string, because the native boundary is not compile-checked and a malformed
 * `event` value must be quarantined rather than trusted. Re-serialising preserves that
 * check at the cost of one cheap round trip.
 */
const alarm = NativeMedAlarm;

export function isAlarmAvailable(): boolean {
  return Boolean(alarm?.isAvailable);
}

/**
 * Publishes the horizon and asks the native side to re-arm.
 *
 * Returns false rather than throwing. A caller that has just committed a correct
 * set of occurrences should not have that work reported as a failure because the
 * alarm layer is unavailable — the Reminder Health Check is the surface that tells
 * the user reminders are degraded, and it reads this signal.
 */
export async function publishHorizon(horizon: AlarmHorizon): Promise<boolean> {
  if (!isAlarmAvailable()) {
    console.warn('[medAlarm] native module unavailable — horizon not armed');
    return false;
  }
  try {
    // The module serialises internally — passing the typed object keeps the
    // AlarmHorizon shape compile-checked all the way to the module boundary.
    await alarm.writeHorizon(horizon);
    // Writing the file only updates the rules on disk. Without this the new rules
    // take effect at the next boot or the next already-scheduled alarm, which for
    // a user whose 08:00 dose just moved to 07:30 means tomorrow.
    await alarm.reconcileNow();
    return true;
  } catch (error) {
    console.warn('[medAlarm] failed to publish horizon', error);
    return false;
  }
}

/**
 * Silences a dose alarm that is ringing right now.
 *
 * A dose on the critical or standard tier rings continuously — a looping alarm tone plus
 * vibration — until it is answered or the native ~2 minute cap stops it. Every path that
 * means "answered" on the NATIVE side already silences it: the notification's own Taken
 * and Snooze actions, the full-screen alarm screen, swiping the notification away, and
 * the timeout. The one path that touches none of them is the in-app one — she taps the
 * notification BODY, lands on the dose screen, and records the dose there.
 *
 * Call it AFTER the event is written. Never throws and never reports failure: the record
 * of a swallowed tablet is the thing that must survive, and a phone that keeps ringing
 * for another minute is a far smaller harm than a write that was rolled back because the
 * speaker would not stop.
 */
export function stopRinging(): void {
  if (!isAlarmAvailable()) {
    console.warn('[medAlarm] native module unavailable — nothing to silence');
    return;
  }
  try {
    alarm.stopRinging();
  } catch (error) {
    console.warn('[medAlarm] failed to stop the alarm', error);
  }
}

/** Never throws: an unreadable journal must not stop the app from starting. */
export async function readJournal(): Promise<JournalEntry[]> {
  if (!isAlarmAvailable()) return [];
  try {
    const entries = await alarm.readJournal();
    if (!Array.isArray(entries)) return [];
    return entries.map(({ fileName, ...record }) => ({
      name: fileName,
      json: JSON.stringify(record),
    }));
  } catch (error) {
    console.warn('[medAlarm] failed to read journal', error);
    return [];
  }
}

/**
 * Unlinks journal files whose rows are safely committed.
 *
 * Deleting in a batch after the commit is deliberate. Deleting before would lose a
 * dose on a crash; the reverse order at worst replays one, and replays are harmless
 * because journal-sourced events carry a content-derived primary key.
 */
export async function deleteJournalEntries(names: string[]): Promise<void> {
  if (names.length === 0 || !isAlarmAvailable()) return;
  try {
    await alarm.deleteJournalEntries(names);
  } catch (error) {
    // The rows are already committed, so the only cost of a failed unlink is that
    // the next drain sees the same files again and no-ops on them.
    console.warn('[medAlarm] failed to unlink journal entries', error);
  }
}
