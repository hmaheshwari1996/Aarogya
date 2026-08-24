/**
 * Dose events — the APPEND-ONLY TRUTH.
 *
 * Everything else about dosing is derived from this table. `dose_occurrence.status`
 * is a cache of `deriveStatus(events)`; adherence is a count over these rows; the
 * streak is a walk over these rows. Two triggers refuse UPDATE and DELETE outright,
 * so the only operation this file offers is append.
 *
 * WHY APPEND-ONLY IS THE ONLY WORKABLE MODEL HERE: the Kotlin alarm layer can write
 * while the JS engine is not running, and JS writes while Kotlin is not running.
 * Neither side can read the other's in-flight state. Append-only is the one shape
 * where two writers who never see each other cannot disagree — there is no cell for
 * them to fight over, only rows to add.
 */

import type { DoseEvent, DoseEventKind, DoseEventOrigin } from '../../types';
import { toLocalDate } from '../../lib/datetime';
import { newId } from '../../lib/ids';
import {
  type Bind,
  type Tx,
  createRecord,
  fromJson,
  nowEpoch,
  queryAll,
  queryFirst,
  toJson,
} from './_shared';

export type NewDoseEvent = {
  occurrenceId: string;
  threadId: string;
  medicineId?: string | null;
  profileId: string;
  event: DoseEventKind;
  atEpoch?: number;
  payload?: Record<string, unknown> | null;
  origin?: DoseEventOrigin;
  /**
   * Supply for anything replayed from the native journal, omit for a live tap.
   * See `deterministicEventId` for why the distinction matters.
   */
  id?: string;
};

type DoseEventRow = {
  id: string;
  occurrence_id: string;
  thread_id: string;
  medicine_id: string | null;
  profile_id: string;
  event: DoseEventKind;
  at_epoch: number;
  local_date: string;
  payload_json: string | null;
  origin: DoseEventOrigin;
};

function mapEvent(row: DoseEventRow): DoseEvent {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    threadId: row.thread_id,
    medicineId: row.medicine_id,
    profileId: row.profile_id,
    event: row.event,
    atEpoch: row.at_epoch,
    localDate: row.local_date,
    payload: fromJson<Record<string, unknown>>(row.payload_json),
    origin: row.origin,
  };
}

const SELECT_EVENT = `
  SELECT id, occurrence_id, thread_id, medicine_id, profile_id, event, at_epoch,
         local_date, payload_json, origin
    FROM dose_event`;

/**
 * A content-addressed id for a journal record.
 *
 * The drain deletes a journal file only AFTER its insert commits, which means a
 * crash in that gap replays the record on the next drain. With a random id the
 * replay would be a second "taken" for the same dose; with an id derived from
 * (occurrence, event, timestamp) it collides on the primary key and INSERT OR
 * IGNORE turns the replay into the no-op it should be.
 *
 * Live in-app taps deliberately do NOT use this: two taps a minute apart on a PRN
 * painkiller are two real doses, and collapsing them would lose one.
 */
export function deterministicEventId(
  occurrenceId: string,
  event: DoseEventKind,
  atEpoch: number,
): string {
  return `${occurrenceId}#${event}@${atEpoch}`;
}

// ── Append ───────────────────────────────────────────────────────────────────

export async function appendEvent(input: NewDoseEvent, tx?: Tx): Promise<string> {
  const atEpoch = input.atEpoch ?? nowEpoch();
  return createRecord(
    'dose_event',
    {
      id: input.id ?? newId(),
      occurrence_id: input.occurrenceId,
      thread_id: input.threadId,
      medicine_id: input.medicineId ?? null,
      profile_id: input.profileId,
      event: input.event,
      at_epoch: atEpoch,
      // Derived from the event's OWN timestamp, not from today. A dose taken at
      // 23:58 and drained at 00:03 belongs to the day she took it.
      local_date: toLocalDate(new Date(atEpoch)),
      payload_json: toJson(input.payload ?? null),
      origin: input.origin ?? 'app',
    },
    tx,
    { orIgnore: true },
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listEventsForOccurrence(
  occurrenceId: string,
  tx?: Tx,
): Promise<DoseEvent[]> {
  const rows = await queryAll<DoseEventRow>(
    `${SELECT_EVENT} WHERE occurrence_id = ? ORDER BY at_epoch ASC;`,
    [occurrenceId],
    tx,
  );
  return rows.map(mapEvent);
}

/**
 * Events for many occurrences at once, grouped by occurrence id.
 *
 * Reconcile and adherence both need "the events for these N occurrences", and doing
 * that one query at a time is what makes a month view take seconds. Chunked at 400
 * to stay well inside SQLite's bound-parameter limit.
 */
export async function listEventsForOccurrences(
  occurrenceIds: string[],
  tx?: Tx,
): Promise<Map<string, DoseEvent[]>> {
  const byOccurrence = new Map<string, DoseEvent[]>();
  for (const id of occurrenceIds) byOccurrence.set(id, []);

  for (let i = 0; i < occurrenceIds.length; i += 400) {
    const chunk = occurrenceIds.slice(i, i + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await queryAll<DoseEventRow>(
      `${SELECT_EVENT} WHERE occurrence_id IN (${placeholders}) ORDER BY at_epoch ASC;`,
      chunk as Bind[],
      tx,
    );
    for (const row of rows) {
      const list = byOccurrence.get(row.occurrence_id);
      if (list) list.push(mapEvent(row));
      else byOccurrence.set(row.occurrence_id, [mapEvent(row)]);
    }
  }
  return byOccurrence;
}

export async function listEventsInRange(
  profileId: string,
  fromDate: string,
  toDate: string,
  tx?: Tx,
): Promise<DoseEvent[]> {
  const rows = await queryAll<DoseEventRow>(
    `${SELECT_EVENT} WHERE profile_id = ? AND local_date >= ? AND local_date <= ?
       ORDER BY at_epoch ASC;`,
    [profileId, fromDate, toDate],
    tx,
  );
  return rows.map(mapEvent);
}

/** As-needed doses, which have no occurrence to hang off. */
export async function listPrnEvents(
  profileId: string,
  threadId: string,
  fromDate: string,
  toDate: string,
  tx?: Tx,
): Promise<DoseEvent[]> {
  const rows = await queryAll<DoseEventRow>(
    `${SELECT_EVENT} WHERE profile_id = ? AND thread_id = ? AND event = 'prn_taken'
        AND local_date >= ? AND local_date <= ?
      ORDER BY at_epoch DESC;`,
    [profileId, threadId, fromDate, toDate],
    tx,
  );
  return rows.map(mapEvent);
}

export async function hasAnyEvent(occurrenceId: string, tx?: Tx): Promise<boolean> {
  const row = await queryFirst<{ one: number }>(
    `SELECT 1 AS one FROM dose_event WHERE occurrence_id = ? LIMIT 1;`,
    [occurrenceId],
    tx,
  );
  return row !== null;
}

// ── Quarantine ───────────────────────────────────────────────────────────────

/**
 * A journal record that could not be attached to anything.
 *
 * Quarantined rather than dropped, and — critically — quarantining is what lets the
 * drain unlink the file and move on. One unattachable record must never be able to
 * park itself at the head of the queue and hold every later dose behind it.
 */
export async function quarantineEvent(
  raw: unknown,
  reason: string,
  tx?: Tx,
): Promise<string> {
  return createRecord(
    'dose_event_quarantine',
    {
      raw_json: safeStringify(raw),
      reason,
      at_epoch: nowEpoch(),
    },
    tx,
  );
}

export async function listQuarantinedEvents(
  limit = 100,
  tx?: Tx,
): Promise<{ id: string; raw: string; reason: string; atEpoch: number }[]> {
  const rows = await queryAll<{ id: string; raw_json: string; reason: string; at_epoch: number }>(
    `SELECT id, raw_json, reason, at_epoch FROM dose_event_quarantine
      ORDER BY at_epoch DESC LIMIT ?;`,
    [limit],
    tx,
  );
  return rows.map((r) => ({ id: r.id, raw: r.raw_json, reason: r.reason, atEpoch: r.at_epoch }));
}

/**
 * The quarantine row is the last copy of a record we already failed to place, so
 * `JSON.stringify` throwing on a cycle must not be what finally loses it.
 */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
