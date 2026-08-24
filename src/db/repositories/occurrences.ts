/**
 * Dose occurrences — a DERIVED CACHE that is always safe to rebuild.
 *
 * The truth is `dose_event`. An occurrence row exists so the UI has something to
 * render and the alarm layer has something to point at; its `status` column is a
 * cache of `deriveStatus(events)` and is never consulted to decide what actually
 * happened.
 *
 * THERE IS NO DELETE IN THIS FILE, ON PURPOSE. Occurrences carry no
 * `deleted_at_epoch` and nothing stops SQLite from hard-deleting one — but the id
 * is the join key that `dose_event` rows carry, and deleting an occurrence would
 * orphan a real record of a swallowed dose. Withdrawing an occurrence is done by
 * appending a `cancelled` event, which is visible, reversible and auditable.
 */

import type { Criticality, DoseOccurrence, OccurrenceStatus } from '../../types';
import { occurrenceId } from '../../lib/ids';
import { wallClockToEpoch } from '../../lib/datetime';
import { TIER_TO_CHANNEL } from '../../constants/channels';
import {
  type Bind,
  type Tx,
  createRecord,
  queryAll,
  queryFirst,
  updateRecord,
} from './_shared';

type OccurrenceRow = {
  id: string;
  profile_id: string;
  medicine_id: string;
  thread_id: string;
  dose_schedule_id: string;
  local_date: string;
  time_local: string;
  override_time_local: string | null;
  scheduled_at_epoch: number;
  status: OccurrenceStatus;
  channel_id: string;
};

function mapOccurrence(row: OccurrenceRow): DoseOccurrence {
  return {
    id: row.id,
    profileId: row.profile_id,
    medicineId: row.medicine_id,
    threadId: row.thread_id,
    doseScheduleId: row.dose_schedule_id,
    localDate: row.local_date,
    timeLocal: row.time_local,
    overrideTimeLocal: row.override_time_local,
    scheduledAtEpoch: row.scheduled_at_epoch,
    status: row.status,
    channelId: row.channel_id,
  };
}

const SELECT_OCCURRENCE = `
  SELECT id, profile_id, medicine_id, thread_id, dose_schedule_id, local_date, time_local,
         override_time_local, scheduled_at_epoch, status, channel_id
    FROM dose_occurrence`;

const TIME_LOCAL = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Criticality decides which notification channel a dose rings on.
 *
 * The fallback is unreachable while the CHECK constraint on `medicine.criticality`
 * holds; it exists so a future tier added to the enum degrades to an audible
 * everyday reminder rather than to `undefined` and a silent NOT NULL failure.
 */
export function channelForCriticality(criticality: Criticality): string {
  return TIER_TO_CHANNEL[criticality] ?? 'dose_standard_v1';
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getOccurrence(id: string, tx?: Tx): Promise<DoseOccurrence | null> {
  const row = await queryFirst<OccurrenceRow>(`${SELECT_OCCURRENCE} WHERE id = ?;`, [id], tx);
  return row ? mapOccurrence(row) : null;
}

export async function occurrenceExists(id: string, tx?: Tx): Promise<boolean> {
  const row = await queryFirst<{ one: number }>(
    `SELECT 1 AS one FROM dose_occurrence WHERE id = ?;`,
    [id],
    tx,
  );
  return row !== null;
}

export async function listOccurrences(
  profileId: string,
  fromDate: string,
  toDate: string,
  tx?: Tx,
): Promise<DoseOccurrence[]> {
  const rows = await queryAll<OccurrenceRow>(
    `${SELECT_OCCURRENCE} WHERE profile_id = ? AND local_date >= ? AND local_date <= ?
       ORDER BY scheduled_at_epoch ASC;`,
    [profileId, fromDate, toDate],
    tx,
  );
  return rows.map(mapOccurrence);
}

export async function listOccurrencesForDate(
  profileId: string,
  localDate: string,
  tx?: Tx,
): Promise<DoseOccurrence[]> {
  const rows = await queryAll<OccurrenceRow>(
    `${SELECT_OCCURRENCE} WHERE profile_id = ? AND local_date = ? ORDER BY scheduled_at_epoch ASC;`,
    [profileId, localDate],
    tx,
  );
  return rows.map(mapOccurrence);
}

export async function listOccurrencesForThreadOnDate(
  threadId: string,
  localDate: string,
  tx?: Tx,
): Promise<DoseOccurrence[]> {
  const rows = await queryAll<OccurrenceRow>(
    `${SELECT_OCCURRENCE} WHERE thread_id = ? AND local_date = ? ORDER BY time_local ASC;`,
    [threadId, localDate],
    tx,
  );
  return rows.map(mapOccurrence);
}

/**
 * Occurrences whose scheduled moment has passed with nothing recorded at all.
 *
 * The NOT EXISTS is against `dose_event`, not against `status`, because status is a
 * cache: if a drain wrote a `taken` event but the status recompute had not run yet,
 * a status-based query would put a dose she already took on the catch-up card.
 */
export async function listOccurrencesWithoutEvents(
  profileId: string,
  fromEpoch: number,
  toEpoch: number,
  tx?: Tx,
): Promise<DoseOccurrence[]> {
  const rows = await queryAll<OccurrenceRow>(
    `${SELECT_OCCURRENCE} o
      WHERE o.profile_id = ?
        AND o.scheduled_at_epoch >= ? AND o.scheduled_at_epoch <= ?
        AND NOT EXISTS (SELECT 1 FROM dose_event e WHERE e.occurrence_id = o.id)
      ORDER BY o.scheduled_at_epoch DESC;`,
    [profileId, fromEpoch, toEpoch],
    tx,
  );
  return rows.map(mapOccurrence);
}

// ── Writes ───────────────────────────────────────────────────────────────────

export type NewOccurrence = {
  profileId: string;
  medicineId: string;
  threadId: string;
  doseScheduleId: string;
  localDate: string;
  timeLocal: string;
  scheduledAtEpoch: number;
  channelId: string;
};

/**
 * Creates an occurrence if it does not already exist.
 *
 * Returns whether a row was actually inserted, which reconcile needs: a delivery
 * probe belongs to a NEWLY armed dose, and re-probing an occurrence that has been
 * sitting there for a week would report a phantom delivery failure every time the
 * app is opened.
 *
 * The id is deterministic — '<threadId>:<localDate>:<timeLocal>' — so running
 * reconcile twice cannot duplicate a dose. That property is what makes it safe to
 * call this on every foreground.
 */
export async function insertOccurrenceIfAbsent(
  input: NewOccurrence,
  tx?: Tx,
): Promise<{ id: string; created: boolean }> {
  const id = occurrenceId(input.threadId, input.localDate, input.timeLocal);
  const existing = await occurrenceExists(id, tx);
  if (existing) return { id, created: false };

  await createRecord(
    'dose_occurrence',
    {
      id,
      profile_id: input.profileId,
      medicine_id: input.medicineId,
      thread_id: input.threadId,
      dose_schedule_id: input.doseScheduleId,
      local_date: input.localDate,
      time_local: input.timeLocal,
      scheduled_at_epoch: input.scheduledAtEpoch,
      status: 'pending',
      channel_id: input.channelId,
    },
    tx,
    // OR IGNORE as well as the existence check: two reconciles racing on the same
    // deterministic id must lose the race quietly, not abort a transaction that is
    // also carrying a real dose event.
    { orIgnore: true },
  );
  return { id, created: true };
}

/**
 * Re-derives the volatile columns of an existing occurrence.
 *
 * `scheduled_at_epoch` is recomputed from wall clock at every reconcile, so a DST
 * shift or a flight moves the alarm rather than stranding it an hour out. The
 * channel is refreshed because a medicine's criticality can be raised after the
 * occurrence was armed, and the louder channel should take effect immediately.
 */
export async function refreshOccurrence(
  id: string,
  patch: { scheduledAtEpoch?: number; channelId?: string; doseScheduleId?: string },
  tx?: Tx,
): Promise<void> {
  const updates: Record<string, Bind> = {};
  if (patch.scheduledAtEpoch !== undefined) updates['scheduled_at_epoch'] = patch.scheduledAtEpoch;
  if (patch.channelId !== undefined) updates['channel_id'] = patch.channelId;
  if (patch.doseScheduleId !== undefined) updates['dose_schedule_id'] = patch.doseScheduleId;
  if (Object.keys(updates).length === 0) return;
  await updateRecord('dose_occurrence', id, updates, tx);
}

/** Writes the derived status cache. Only `deriveStatus` should decide the value. */
export async function setStatus(id: string, status: OccurrenceStatus, tx?: Tx): Promise<void> {
  await updateRecord('dose_occurrence', id, { status }, tx);
}

/**
 * Move ONE occurrence to a different time for its day, or clear the override.
 *
 * "Take today's 08:00 dose at 10:00" — the schedule rule is untouched, so tomorrow's 08:00
 * dose is unaffected. `overrideTimeLocal` is 'HH:MM' wall clock, or null to ring at the
 * schedule's own slot time again.
 *
 * WHY THIS IS ONE ROW AND NEVER TWO. The occurrence keeps its id and its `time_local` (the
 * slot time, which is part of that id); only `override_time_local` and the re-derived
 * `scheduled_at_epoch` change. So there is exactly one occurrence for this dose before and
 * after — the original does not stay behind and ring as well. That "no double dose" property
 * is structural here, not a guard that a later edit could drop.
 *
 * `scheduled_at_epoch` is re-derived from the override (or the slot time on clear) in the
 * same write, so the day card is correct immediately — but wall clock stays authoritative:
 * reconcile recomputes this epoch every run, and MUST derive it from `override_time_local`
 * when present, or the next foreground resets an overridden 10:00 back to the slot's 08:00.
 *
 * The native alarm layer is rule-based and cannot yet express a one-off per-date exception;
 * until the Kotlin side reads a per-date exceptions channel, an override changes the in-app
 * schedule and the reconcile but not the native ring time. See migration v7 and the build
 * report. No status guard here: whether an already-answered dose may be moved is the
 * screen's call, not the data layer's.
 */
export async function setOccurrenceTimeOverride(
  id: string,
  overrideTimeLocal: string | null,
  tx?: Tx,
): Promise<void> {
  if (overrideTimeLocal !== null && !TIME_LOCAL.test(overrideTimeLocal)) {
    throw new Error(`setOccurrenceTimeOverride: override must be 'HH:MM' 24-hour, got ${overrideTimeLocal}`);
  }
  const occurrence = await getOccurrence(id, tx);
  if (!occurrence) throw new Error(`setOccurrenceTimeOverride: occurrence ${id} does not exist`);

  await updateRecord(
    'dose_occurrence',
    id,
    {
      override_time_local: overrideTimeLocal,
      scheduled_at_epoch: wallClockToEpoch(
        occurrence.localDate,
        overrideTimeLocal ?? occurrence.timeLocal,
      ),
    },
    tx,
  );
}

/**
 * Per-date ring moves for the alarm horizon: occurrences on/after `fromDate` that carry a
 * per-day time override. Drives `AlarmHorizon.exceptions`; the native layer shifts exactly
 * these occurrences' ring times, never duplicating them.
 */
export async function listHorizonOverrides(
  profileId: string,
  fromDate: string,
  tx?: Tx,
): Promise<{ threadId: string; localDate: string; timeLocal: string; overrideTimeLocal: string }[]> {
  const rows = await queryAll<{
    thread_id: string;
    local_date: string;
    time_local: string;
    override_time_local: string;
  }>(
    `SELECT thread_id, local_date, time_local, override_time_local
       FROM dose_occurrence
      WHERE profile_id = ? AND override_time_local IS NOT NULL AND local_date >= ?;`,
    [profileId, fromDate],
    tx,
  );
  return rows.map((r) => ({
    threadId: r.thread_id,
    localDate: r.local_date,
    timeLocal: r.time_local,
    overrideTimeLocal: r.override_time_local,
  }));
}
