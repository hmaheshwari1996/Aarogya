/**
 * Dose schedules — ALSO append-only versioned, on the same `thread_id` as the medicine.
 *
 * TWO THINGS ABOUT THE SHAPE OF THIS TABLE ARE EASY TO GET WRONG:
 *
 *  1. A schedule "version" is a SET OF ROWS, not one row. A twice-daily medicine at
 *     version 3 is two rows — (thread, 3, '08:00') and (thread, 3, '20:00') — which
 *     is exactly what UNIQUE(thread_id, version, time_local) encodes. Every write
 *     here therefore takes a list of slots and writes the whole set atomically;
 *     writing one slot at a time would leave a half-version live between statements.
 *
 *  2. `time_local` is WALL CLOCK ('08:00') and never an absolute epoch. Occurrence
 *     epochs are recomputed from it at every reconcile. Persisting a future
 *     timestamp is the bug that fires a TB alarm at 04:30 after the user crosses a
 *     timezone.
 *
 * `started_on` and `stopped_on` are INCLUSIVE bounds. A version that stops on
 * 2026-08-09 is still in force for the whole of 9 August. Adherence relies on this,
 * so changing it would silently change every historical percentage.
 *
 * Confirmation is separate from the medicine's. The schema comment says why:
 * "1-0-1 misread as QID" leaves the drug name perfectly correct and quadruples the
 * doses, so frequency carries its own human sign-off and its own trigger.
 */

import type { DoseSchedule, ScheduleType } from '../../types';
import { addDays, daysBetween, isDayEnabled, ALL_DAYS } from '../../lib/datetime';
import {
  type Tx,
  createRecord,
  inTransaction,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
} from './_shared';

export type ScheduleSlot = {
  /** 'HH:MM' wall clock. Null only for PRN. */
  timeLocal: string | null;
  /** Optional human label for the slot ('morning', 'after lunch'). */
  slotKey?: string | null;
  scheduleType?: ScheduleType;
  daysMask?: number;
  intervalDays?: number;
  quantityValue?: number | null;
  quantityUnit?: string | null;
  /** Free text for anything that is not a clean number ("half tablet", "2 puffs"). */
  quantityText?: string | null;
  foodRelation?: DoseSchedule['foodRelation'];
};

type ScheduleRow = {
  id: string;
  medicine_id: string;
  thread_id: string;
  version: number;
  schedule_type: ScheduleType;
  time_local: string | null;
  slot_key: string | null;
  days_mask: number;
  interval_days: number;
  quantity_value: number | null;
  quantity_unit: string | null;
  quantity_text: string | null;
  food_relation: DoseSchedule['foodRelation'];
  started_on: string;
  stopped_on: string | null;
  confirmed_by_user_at: number | null;
};

function mapSchedule(row: ScheduleRow): DoseSchedule {
  return {
    id: row.id,
    medicineId: row.medicine_id,
    threadId: row.thread_id,
    version: row.version,
    scheduleType: row.schedule_type,
    timeLocal: row.time_local,
    slotKey: row.slot_key,
    daysMask: row.days_mask,
    intervalDays: row.interval_days,
    quantityValue: row.quantity_value,
    quantityUnit: row.quantity_unit,
    quantityText: row.quantity_text,
    foodRelation: row.food_relation,
    startedOn: row.started_on,
    stoppedOn: row.stopped_on,
    confirmedByUserAt: row.confirmed_by_user_at,
  };
}

const SELECT_SCHEDULE = `
  SELECT id, medicine_id, thread_id, version, schedule_type, time_local, slot_key,
         days_mask, interval_days, quantity_value, quantity_unit, quantity_text,
         food_relation, started_on, stopped_on, confirmed_by_user_at
    FROM dose_schedule`;

const CURRENT_VERSION_PREDICATE = `
  s.deleted_at_epoch IS NULL
  AND s.version = (SELECT MAX(v.version) FROM dose_schedule v
                    WHERE v.thread_id = s.thread_id AND v.deleted_at_epoch IS NULL)`;

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getSchedule(id: string, tx?: Tx): Promise<DoseSchedule | null> {
  const row = await queryFirst<ScheduleRow>(
    `${SELECT_SCHEDULE} WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapSchedule(row) : null;
}

/** Every slot of the newest version of one thread. */
export async function getCurrentSchedules(threadId: string, tx?: Tx): Promise<DoseSchedule[]> {
  const rows = await queryAll<ScheduleRow>(
    `${SELECT_SCHEDULE} s WHERE s.thread_id = ? AND ${CURRENT_VERSION_PREDICATE}
       ORDER BY s.time_local ASC;`,
    [threadId],
    tx,
  );
  return rows.map(mapSchedule);
}

/**
 * Current slots for many threads at once.
 *
 * Reconcile runs over every active medicine on every foreground, and one query per
 * thread turns a fifteen-medicine profile into fifteen round trips on a Go-class
 * device. `IN` with generated placeholders keeps every value bound.
 */
export async function getCurrentSchedulesForThreads(
  threadIds: string[],
  tx?: Tx,
): Promise<Map<string, DoseSchedule[]>> {
  const byThread = new Map<string, DoseSchedule[]>();
  for (const threadId of threadIds) byThread.set(threadId, []);

  for (const chunk of chunked(threadIds, 200)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await queryAll<ScheduleRow>(
      `${SELECT_SCHEDULE} s WHERE s.thread_id IN (${placeholders}) AND ${CURRENT_VERSION_PREDICATE}
         ORDER BY s.time_local ASC;`,
      chunk,
      tx,
    );
    for (const row of rows) {
      const list = byThread.get(row.thread_id);
      if (list) list.push(mapSchedule(row));
      else byThread.set(row.thread_id, [mapSchedule(row)]);
    }
  }
  return byThread;
}

export async function listScheduleVersions(threadId: string, tx?: Tx): Promise<DoseSchedule[]> {
  const rows = await queryAll<ScheduleRow>(
    `${SELECT_SCHEDULE} WHERE thread_id = ? AND deleted_at_epoch IS NULL
       ORDER BY version ASC, time_local ASC;`,
    [threadId],
    tx,
  );
  return rows.map(mapSchedule);
}

export async function listUnconfirmedSchedules(
  profileId: string,
  tx?: Tx,
): Promise<DoseSchedule[]> {
  const rows = await queryAll<ScheduleRow>(
    `${SELECT_SCHEDULE} s
       JOIN medicine m ON m.id = s.medicine_id AND m.deleted_at_epoch IS NULL
      WHERE m.profile_id = ? AND s.confirmed_by_user_at IS NULL AND ${CURRENT_VERSION_PREDICATE}
      ORDER BY s.time_local ASC;`,
    [profileId],
    tx,
  );
  return rows.map(mapSchedule);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Writes version 1 of a thread's schedule.
 *
 * `confirmedByUser` is required for the same reason it is on the medicine: an
 * AI-proposed frequency must produce rows the database refuses to schedule until a
 * human agrees. `trg_occ_requires_confirmed_schedule` is what enforces that.
 */
export async function createInitialSchedules(
  input: {
    threadId: string;
    medicineId: string;
    startedOn: string;
    slots: ScheduleSlot[];
    confirmedByUser: boolean;
  },
  tx?: Tx,
): Promise<string[]> {
  return inTransaction(async (t) => {
    return writeSlots(t, {
      threadId: input.threadId,
      medicineId: input.medicineId,
      version: 1,
      startedOn: input.startedOn,
      slots: input.slots,
      confirmedByUser: input.confirmedByUser,
    });
  }, tx);
}

/**
 * Appends the next schedule version and closes the previous one.
 *
 * The previous version stops the day BEFORE the new one starts, because the bounds
 * are inclusive. If both versions claimed the same day, that day would generate
 * occurrences from the old time and the new one, and the patient would be reminded
 * twice for one dose.
 */
export async function createScheduleVersion(
  input: {
    threadId: string;
    medicineId: string;
    startedOn: string;
    slots: ScheduleSlot[];
    confirmedByUser: boolean;
  },
  tx?: Tx,
): Promise<string[]> {
  return inTransaction(async (t) => {
    const previous = await getCurrentSchedules(input.threadId, t);
    const nextVersion = previous.reduce((max, s) => Math.max(max, s.version), 0) + 1;

    const closeOn = addDays(input.startedOn, -1);
    for (const row of previous) {
      // stopped_on is a lifecycle column, so the append-only trigger permits it.
      // Only move it earlier — a version that already ended must not be extended.
      if (row.stoppedOn === null || row.stoppedOn > closeOn) {
        await updateRecord('dose_schedule', row.id, { stopped_on: closeOn }, t);
      }
    }

    return writeSlots(t, {
      threadId: input.threadId,
      medicineId: input.medicineId,
      version: nextVersion,
      startedOn: input.startedOn,
      slots: input.slots,
      confirmedByUser: input.confirmedByUser,
    });
  }, tx);
}

async function writeSlots(
  t: Tx,
  input: {
    threadId: string;
    medicineId: string;
    version: number;
    startedOn: string;
    slots: ScheduleSlot[];
    confirmedByUser: boolean;
  },
): Promise<string[]> {
  const confirmedAt = input.confirmedByUser ? nowEpoch() : null;
  const ids: string[] = [];

  for (const slot of input.slots) {
    const scheduleType = slot.scheduleType ?? (slot.timeLocal ? 'FIXED' : 'PRN');
    if (scheduleType === 'FIXED' && !slot.timeLocal) {
      throw new Error('A FIXED schedule slot needs a wall-clock time_local.');
    }
    const id = await createRecord(
      'dose_schedule',
      {
        medicine_id: input.medicineId,
        thread_id: input.threadId,
        version: input.version,
        schedule_type: scheduleType,
        // PRN carries no time at all; a placeholder time would eventually be read
        // as a real slot and start ringing for an as-needed painkiller.
        time_local: scheduleType === 'PRN' ? null : (slot.timeLocal ?? null),
        slot_key: slot.slotKey ?? null,
        days_mask: slot.daysMask ?? ALL_DAYS,
        interval_days: slot.intervalDays ?? 1,
        quantity_value: slot.quantityValue ?? null,
        quantity_unit: slot.quantityUnit ?? null,
        quantity_text: slot.quantityText ?? null,
        food_relation: slot.foodRelation ?? null,
        started_on: input.startedOn,
        confirmed_by_user_at: confirmedAt,
      },
      t,
    );
    ids.push(id);
  }
  return ids;
}

export async function confirmSchedule(id: string, tx?: Tx): Promise<void> {
  await updateRecord('dose_schedule', id, { confirmed_by_user_at: nowEpoch() }, tx);
}

/** Confirms every slot of the thread's current version in one transaction. */
export async function confirmCurrentSchedules(threadId: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const current = await getCurrentSchedules(threadId, t);
    const at = nowEpoch();
    for (const row of current) {
      if (row.confirmedByUserAt === null) {
        await updateRecord('dose_schedule', row.id, { confirmed_by_user_at: at }, t);
      }
    }
  }, tx);
}

export async function stopSchedules(threadId: string, stoppedOn: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const current = await getCurrentSchedules(threadId, t);
    for (const row of current) {
      if (row.stoppedOn === null || row.stoppedOn > stoppedOn) {
        await updateRecord('dose_schedule', row.id, { stopped_on: stoppedOn }, t);
      }
    }
  }, tx);
}

export async function deleteScheduleThread(threadId: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const rows = await queryAll<{ id: string }>(
      `SELECT id FROM dose_schedule WHERE thread_id = ? AND deleted_at_epoch IS NULL;`,
      [threadId],
      t,
    );
    for (const row of rows) await softDeleteRecord('dose_schedule', row.id, t);
  }, tx);
}

// ── Pure calendar logic ──────────────────────────────────────────────────────

/**
 * Does this schedule slot produce a dose on this local date?
 *
 * PURE — reconcile calls it once per slot per day across a 17-day window, and it is
 * the one place the three independent recurrence rules are combined:
 *   • the inclusive started_on…stopped_on window,
 *   • the 7-bit days_mask (bit 0 = Monday),
 *   • interval_days, counted from started_on.
 *
 * Both the mask and the interval must pass. An alternate-day medicine restricted to
 * weekdays is unusual but legal, and silently ignoring one of the two rules would
 * either add doses that were never prescribed or drop doses that were.
 */
export function occursOn(schedule: DoseSchedule, localDate: string): boolean {
  if (schedule.scheduleType !== 'FIXED' || !schedule.timeLocal) return false;
  if (localDate < schedule.startedOn) return false;
  if (schedule.stoppedOn !== null && localDate > schedule.stoppedOn) return false;
  if (!isDayEnabled(schedule.daysMask, localDate)) return false;

  if (schedule.intervalDays > 1) {
    const offset = daysBetween(schedule.startedOn, localDate);
    if (offset < 0 || offset % schedule.intervalDays !== 0) return false;
  }
  return true;
}

/** How many fixed doses this thread's current version expects on a given date. */
export function dosesDueOn(schedules: DoseSchedule[], localDate: string): number {
  return schedules.reduce((count, s) => (occursOn(s, localDate) ? count + 1 : count), 0);
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
