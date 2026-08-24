/**
 * Drains the native alarm journal into `dose_event`.
 *
 * Kotlin writes one small file per event, atomically, while the JS engine may not
 * even be running. This is the only path those records take into the database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STALLED-QUEUE BUG THIS FILE EXISTS TO PREVENT
 *
 * The obvious implementation reads every file, inserts them all in one transaction
 * and unlinks them. One malformed record then fails the transaction, nothing is
 * unlinked, and the SAME record fails again on every subsequent drain — silently
 * holding every dose behind it out of the database, forever. The user sees an app
 * that stopped recording anything and has no idea why.
 *
 * So: each record is parsed, inserted and unlinked INDEPENDENTLY. A record that
 * cannot be placed is written to `dose_event_quarantine` and unlinked, because a
 * quarantined record is recoverable and a stuck queue is not.
 *
 * `INSERT OR IGNORE` is necessary but NOT sufficient on its own — it swallows
 * uniqueness conflicts, not referential ones. A record whose occurrence row is
 * missing is the realistic case (the app was reinstalled, or reconcile has not run
 * since a schedule change), and that is what the reconstruct-then-quarantine ladder
 * below handles.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DoseEventKind, DoseEventOrigin, JournalRecord } from '../../types';
import { occurrenceId as buildOccurrenceId, parseOccurrenceId } from '../../lib/ids';
import { wallClockToEpoch } from '../../lib/datetime';
import { type Tx, inTransaction } from '../../db/repositories/_shared';
import {
  appendEvent,
  deterministicEventId,
  listEventsForOccurrences,
  quarantineEvent,
} from '../../db/repositories/doseEvents';
import {
  channelForCriticality,
  getOccurrence,
  insertOccurrenceIfAbsent,
  setStatus,
} from '../../db/repositories/occurrences';
import { getCurrentVersion } from '../../db/repositories/medicines';
import { listScheduleVersions } from '../../db/repositories/schedules';
import { deleteJournalEntries, readJournal, type JournalEntry } from './medAlarm';
import { deriveStatus } from './deriveStatus';

export type DrainResult = {
  scanned: number;
  inserted: number;
  /** Records whose occurrence row had to be rebuilt before the event could land. */
  reconstructed: number;
  quarantined: number;
  /** Left on disk for the next drain because even quarantining them failed. */
  retained: number;
  statusesChanged: number;
};

const VALID_EVENTS: ReadonlySet<string> = new Set<DoseEventKind>([
  'delivered',
  'taken',
  'skipped',
  'snoozed',
  'cancelled',
  'dismissed',
  'prn_taken',
  'rearmed',
  'receiver_error',
]);

const VALID_ORIGINS: ReadonlySet<string> = new Set<DoseEventOrigin>([
  'app',
  'notification',
  'widget',
  'native',
  'watchdog',
]);

export async function drainJournal(now: number = Date.now()): Promise<DrainResult> {
  const entries = await readJournal();
  const result: DrainResult = {
    scanned: entries.length,
    inserted: 0,
    reconstructed: 0,
    quarantined: 0,
    retained: 0,
    statusesChanged: 0,
  };
  if (entries.length === 0) return result;

  const unlink: string[] = [];
  const touchedOccurrences = new Set<string>();

  for (const entry of entries) {
    const outcome = await drainOne(entry);
    switch (outcome.kind) {
      case 'inserted':
        result.inserted += 1;
        if (outcome.reconstructed) result.reconstructed += 1;
        touchedOccurrences.add(outcome.occurrenceId);
        unlink.push(entry.name);
        break;
      case 'quarantined':
        result.quarantined += 1;
        unlink.push(entry.name);
        break;
      case 'retained':
        // Quarantining itself failed — almost certainly the database being
        // unavailable, which is transient. Keep the file so the record is not lost,
        // and note that it does not block anything: the loop has already moved on.
        result.retained += 1;
        break;
    }
  }

  // Unlink only after every insert has committed. The reverse order loses a dose on
  // a crash; this order at worst replays one, and replays collide on the
  // content-derived primary key and become no-ops.
  await deleteJournalEntries(unlink);

  result.statusesChanged = await recomputeTouched([...touchedOccurrences], now);
  return result;
}

type DrainOutcome =
  | { kind: 'inserted'; occurrenceId: string; reconstructed: boolean }
  | { kind: 'quarantined' }
  | { kind: 'retained' };

async function drainOne(entry: JournalEntry): Promise<DrainOutcome> {
  let record: JournalRecord;
  try {
    record = parseRecord(entry.json);
  } catch (error) {
    return quarantine(entry.json, `unparseable: ${String(error)}`);
  }

  try {
    return await inTransaction(async (tx) => {
      let reconstructed = false;

      const existing = await getOccurrence(record.occurrenceId, tx);
      if (!existing) {
        // PRN doses legitimately have no occurrence row — the schema says PRN
        // medicines generate none — so an event that is inherently occurrence-less
        // is not a broken reference and must not be rebuilt or quarantined.
        if (record.event !== 'prn_taken') {
          const rebuilt = await reconstructOccurrence(record, tx);
          if (!rebuilt) {
            throw new UnplaceableRecord(
              `no occurrence ${record.occurrenceId} and it could not be reconstructed`,
            );
          }
          reconstructed = true;
        }
      }

      const profileId = existing?.profileId ?? (await profileIdForThread(record.threadId, tx));
      if (!profileId) {
        throw new UnplaceableRecord(`no medicine thread ${record.threadId}`);
      }

      await appendEvent(
        {
          // Content-derived, so an unlink that never happened replays into a no-op
          // instead of a second swallowed dose.
          id: deterministicEventId(record.occurrenceId, record.event, record.atEpoch),
          occurrenceId: record.occurrenceId,
          threadId: record.threadId,
          medicineId: record.medicineId ?? existing?.medicineId ?? null,
          profileId,
          event: record.event,
          atEpoch: record.atEpoch,
          payload: record.payload ?? null,
          origin: record.origin,
        },
        tx,
      );

      return { kind: 'inserted', occurrenceId: record.occurrenceId, reconstructed } as const;
    });
  } catch (error) {
    return quarantine(
      entry.json,
      error instanceof UnplaceableRecord ? error.message : `insert failed: ${String(error)}`,
    );
  }
}

class UnplaceableRecord extends Error {}

async function quarantine(raw: string, reason: string): Promise<DrainOutcome> {
  try {
    await quarantineEvent(raw, reason);
    return { kind: 'quarantined' };
  } catch (error) {
    console.warn('[journalDrain] could not quarantine record', reason, error);
    return { kind: 'retained' };
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Validates a journal file's contents field by field.
 *
 * This is the one boundary in the app the compiler cannot check, so nothing is
 * assumed. A record that fails any check is quarantined intact rather than coerced
 * — guessing at a malformed timestamp would write a dose onto the wrong day.
 */
function parseRecord(json: string): JournalRecord {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  const raw = parsed as Record<string, unknown>;

  const occurrenceId = raw['occurrenceId'];
  const threadId = raw['threadId'];
  const event = raw['event'];
  const atEpoch = raw['atEpoch'];

  if (typeof occurrenceId !== 'string' || occurrenceId.length === 0) {
    throw new Error('missing occurrenceId');
  }
  if (typeof threadId !== 'string' || threadId.length === 0) throw new Error('missing threadId');
  if (typeof event !== 'string' || !VALID_EVENTS.has(event)) throw new Error(`bad event: ${String(event)}`);
  if (typeof atEpoch !== 'number' || !Number.isFinite(atEpoch)) throw new Error('bad atEpoch');

  const medicineId = raw['medicineId'];
  const origin = raw['origin'];
  const payload = raw['payload'];

  return {
    occurrenceId,
    threadId,
    medicineId: typeof medicineId === 'string' ? medicineId : '',
    event: event as DoseEventKind,
    atEpoch,
    // Anything arriving through this file came from the native layer by definition;
    // an unrecognised origin is relabelled rather than rejected, because the origin
    // is metadata and the dose is not.
    origin:
      typeof origin === 'string' && VALID_ORIGINS.has(origin)
        ? (origin as DoseEventOrigin)
        : 'native',
    payload:
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : undefined,
  };
}

// ── Reconstruction ───────────────────────────────────────────────────────────

/**
 * Rebuilds a missing occurrence row from its own id.
 *
 * The id is the deterministic composite '<threadId>:<localDate>:<timeLocal>', so it
 * carries everything needed except the schedule row it came from — which is found
 * by matching the wall-clock time against the thread's schedule history.
 *
 * NOTE how this differs from `reconcile`, which refuses to materialise anything in
 * the past. That refusal exists because a past occurrence with no history behind it
 * would be an invented obligation. Here the opposite is true: an event PROVES the
 * dose was armed and answered, so recreating its row restores a record rather than
 * inventing one.
 */
async function reconstructOccurrence(record: JournalRecord, tx: Tx): Promise<boolean> {
  const parts = parseOccurrenceId(record.occurrenceId);
  if (!parts) return false;

  const medicine = await getCurrentVersion(parts.threadId, tx);
  if (!medicine) return false;
  // The database refuses to create an occurrence for an unconfirmed medicine, and
  // that refusal must not become a thrown error that discards the event.
  if (medicine.confirmedByUserAt === null) return false;

  const schedules = await listScheduleVersions(parts.threadId, tx);
  const match = schedules.find(
    (s) =>
      s.timeLocal === parts.timeLocal &&
      s.confirmedByUserAt !== null &&
      s.startedOn <= parts.localDate &&
      (s.stoppedOn === null || s.stoppedOn >= parts.localDate),
  );
  // Fall back to any confirmed slot at that wall-clock time. The schedule window may
  // have been closed since the alarm fired, and losing a real dose over a boundary
  // date is a worse outcome than attaching it to a slightly stale schedule row.
  const schedule =
    match ?? schedules.find((s) => s.timeLocal === parts.timeLocal && s.confirmedByUserAt !== null);
  if (!schedule) return false;

  const inserted = await insertOccurrenceIfAbsent(
    {
      profileId: medicine.profileId,
      medicineId: medicine.id,
      threadId: parts.threadId,
      doseScheduleId: schedule.id,
      localDate: parts.localDate,
      timeLocal: parts.timeLocal,
      scheduledAtEpoch: wallClockToEpoch(parts.localDate, parts.timeLocal),
      channelId: channelForCriticality(medicine.criticality),
    },
    tx,
  );
  // Guard against an id that does not round-trip: if the rebuilt row would answer to
  // a different id than the event references, the event would dangle again.
  return (
    inserted.id === buildOccurrenceId(parts.threadId, parts.localDate, parts.timeLocal) &&
    inserted.id === record.occurrenceId
  );
}

async function profileIdForThread(threadId: string, tx: Tx): Promise<string | null> {
  const medicine = await getCurrentVersion(threadId, tx);
  return medicine?.profileId ?? null;
}

// ── Status refresh ───────────────────────────────────────────────────────────

async function recomputeTouched(occurrenceIds: string[], now: number): Promise<number> {
  if (occurrenceIds.length === 0) return 0;

  return inTransaction(async (tx) => {
    const eventsByOccurrence = await listEventsForOccurrences(occurrenceIds, tx);
    let changed = 0;
    for (const id of occurrenceIds) {
      const occurrence = await getOccurrence(id, tx);
      // A PRN event has no occurrence row by design; there is no cache to refresh.
      if (!occurrence) continue;
      const next = deriveStatus(
        eventsByOccurrence.get(id) ?? [],
        occurrence.scheduledAtEpoch,
        now,
      );
      if (next !== occurrence.status) {
        await setStatus(id, next, tx);
        changed += 1;
      }
    }
    return changed;
  });
}
