/**
 * Reconcile — turns medicines + schedules into occurrences, statuses and alarms.
 *
 * Runs on every foreground, after every edit, and after every journal drain. It is
 * idempotent by construction: occurrence ids are deterministic, so running it twice
 * changes nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DOUBLE-DOSE BUG THIS FILE EXISTS TO PREVENT
 *
 * At 10:00 a user moves a slot from 08:00 to 07:30. This morning's 08:00 dose was
 * already taken. A naive materialiser walks today's dates, sees 07:30 has no
 * occurrence, and creates one — `pending`, in the past. The catch-up card then
 * tells an elderly patient to take a dose she swallowed two hours ago.
 *
 * Two rules below stop that, and neither is optional:
 *
 *   RULE A — never materialise an occurrence whose scheduled moment has already
 *            passed unless a row for it already exists. A dose that was never armed
 *            cannot retroactively become due.
 *   RULE B — retire the stale same-day occurrences from the OLD time first, in the
 *            same transaction, and only those with nothing recorded against them.
 *            An occurrence carrying a real `taken` event is history and is left
 *            exactly where it is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AlarmRule,
  Criticality,
  DoseOccurrence,
  DoseSchedule,
  Medicine,
} from '../../types';
import { addDays, toLocalDate, wallClockToEpoch } from '../../lib/datetime';
import {
  type Tx,
  createRecord,
  inTransaction,
  queryAll,
} from '../../db/repositories/_shared';
import { insertMedChangeEvent, listActiveMedicines } from '../../db/repositories/medicines';
import { getCurrentSchedulesForThreads, occursOn } from '../../db/repositories/schedules';
import {
  channelForCriticality,
  insertOccurrenceIfAbsent,
  listOccurrences,
  refreshOccurrence,
  setStatus,
} from '../../db/repositories/occurrences';
import { appendEvent, listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { deriveStatus, hasRecordedOutcome } from './deriveStatus';
import { effectiveScheduledEpoch } from './override';
import { publishDeviceHorizon } from './deviceHorizon';

/**
 * Two days back, fourteen forward.
 *
 * Backwards, because a phone that was off overnight needs yesterday's slots to
 * exist so the drain has somewhere to attach its events. Forwards, because the
 * horizon file gives the native layer RULES it expands indefinitely — the fourteen
 * days here are only what the UI needs to draw, not what the alarms depend on.
 */
export const RECONCILE_PAST_DAYS = 2;
export const RECONCILE_FUTURE_DAYS = 14;

/**
 * Re-ping ladders, in minutes after the scheduled time, applied only while nothing
 * has been recorded. These are reminders of the SAME dose, never a second dose.
 * `low` is empty on purpose: a supplement that nags is a supplement that gets the
 * whole app muted, taking the critical channel down with it.
 */
export const ESCALATION_MINUTES: Record<Criticality, number[]> = {
  critical: [15, 45, 90],
  standard: [20, 60],
  low: [],
};

export type ReconcileResult = {
  profileId: string;
  fromDate: string;
  toDate: string;
  occurrencesCreated: number;
  occurrencesRetired: number;
  statusesChanged: number;
  probesInserted: number;
  rules: number;
  /** False when the native alarm layer could not be reached. DB work still committed. */
  alarmsArmed: boolean;
};

type Candidate = {
  threadId: string;
  medicineId: string;
  profileId: string;
  doseScheduleId: string;
  localDate: string;
  timeLocal: string;
  scheduledAtEpoch: number;
  channelId: string;
};

export async function reconcile(profileId: string, now: number = Date.now()): Promise<ReconcileResult> {
  const today = toLocalDate(new Date(now));
  const fromDate = addDays(today, -RECONCILE_PAST_DAYS);
  const toDate = addDays(today, RECONCILE_FUTURE_DAYS);

  const { result } = await inTransaction(async (tx) => {
    // ── 1. What is she actually on right now ────────────────────────────────
    const medicines = await listActiveMedicines(profileId, tx);
    const schedulesByThread = await getCurrentSchedulesForThreads(
      medicines.map((m) => m.threadId),
      tx,
    );

    // ── 2. What the calendar says should exist ──────────────────────────────
    const candidates = buildCandidates(medicines, schedulesByThread, fromDate, toDate);
    const candidateById = new Map(candidates.map((c) => [keyOf(c), c]));

    const existing = await listOccurrences(profileId, fromDate, toDate, tx);

    // ── 3. RULE B: retire what the calendar no longer expects, first ────────
    const retired = await retireStaleOccurrences({
      tx,
      profileId,
      today,
      existing,
      candidateById,
      candidates,
      now,
    });

    // ── 4. RULE A: materialise, but never backwards into the past ───────────
    const created: Candidate[] = [];
    const existingById = new Map(existing.map((o) => [o.id, o]));

    for (const candidate of candidates) {
      const id = candidateOccurrenceId(candidate);
      const already = existingById.get(id);

      if (already) {
        // Wall clock is authoritative; the epoch is re-derived every time so a DST
        // change or a flight moves the alarm instead of stranding it an hour out.
        //
        // R2 — HONOUR A PER-DAY OVERRIDE. The candidate epoch is built from the SLOT time.
        // If this occurrence carries `override_time_local` (she moved today's 08:00 dose to
        // 10:00), the effective epoch is the OVERRIDE's, not the slot's. Without this, the
        // comparison below sees a moved 10:00 occurrence differ from an 08:00 candidate and
        // resets it to 08:00 — silently snapping the dose she moved back to its old time on
        // the next foreground, which is exactly the "original still fires" half R2 forbids.
        // The override rides the same slot-time occurrence id, so buildCandidates matched it
        // here rather than minting a second row — there is one occurrence, and it stays moved.
        const effectiveEpoch = effectiveScheduledEpoch(
          already.localDate,
          already.overrideTimeLocal,
          candidate.scheduledAtEpoch,
        );
        if (
          already.scheduledAtEpoch !== effectiveEpoch ||
          already.channelId !== candidate.channelId ||
          already.doseScheduleId !== candidate.doseScheduleId
        ) {
          await refreshOccurrence(
            id,
            {
              scheduledAtEpoch: effectiveEpoch,
              channelId: candidate.channelId,
              doseScheduleId: candidate.doseScheduleId,
            },
            tx,
          );
        }
        continue;
      }

      // THE RULE. A slot moved to a time that has already passed today does not get
      // a fresh pending occurrence — there is nothing left to remind her about, and
      // inventing one is how a dose gets taken twice.
      if (candidate.scheduledAtEpoch < now) continue;

      const inserted = await insertOccurrenceIfAbsent(candidate, tx);
      if (inserted.created) created.push(candidate);
    }

    // ── 5. Recompute every status in the window from the event log ──────────
    const statusesChanged = await recomputeStatuses(tx, profileId, fromDate, toDate, now);

    // ── 6. Probes for the doses we just armed ───────────────────────────────
    const probesInserted = await insertDeliveryProbes(tx, created);

    // This profile's own rule count, for the result only. The ARMED horizon is the
    // device-wide UNION published below — see step 7 and deviceHorizon.ts (R1).
    const rules = buildAlarmRules(medicines, schedulesByThread);

    return {
      result: {
        profileId,
        fromDate,
        toDate,
        occurrencesCreated: created.length,
        occurrencesRetired: retired,
        statusesChanged,
        probesInserted,
        rules: rules.length,
        alarmsArmed: false,
      } satisfies ReconcileResult,
    };
  });

  // ── 7. Arm the native layer — deliberately OUTSIDE the transaction ────────
  // A JSI round trip inside an open write transaction holds SQLite's write lock
  // across a boundary we do not control. If this fails, the database is already
  // correct and the next reconcile re-publishes; the reverse ordering could leave
  // the write lock held by a call that never returns.
  //
  // R1: the horizon is the WHOLE DEVICE's, not this one profile's. Publishing a
  // single-profile horizon here would overwrite the file and stop Kotlin expanding
  // every OTHER profile's doses — a switched-away patient's TB alarm would go silent.
  // `publishDeviceHorizon` unions buildAlarmRules over every non-archived profile, so a
  // reconcile triggered by viewing one patient can never drop another's reminders.
  const alarmsArmed = await publishDeviceHorizon(now);
  return { ...result, alarmsArmed };
}

// ── Candidate generation ─────────────────────────────────────────────────────

function keyOf(candidate: Candidate): string {
  return candidateOccurrenceId(candidate);
}

function candidateOccurrenceId(candidate: Candidate): string {
  return `${candidate.threadId}:${candidate.localDate}:${candidate.timeLocal}`;
}

function buildCandidates(
  medicines: Medicine[],
  schedulesByThread: Map<string, DoseSchedule[]>,
  fromDate: string,
  toDate: string,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const medicine of medicines) {
    const schedules = schedulesByThread.get(medicine.threadId) ?? [];
    const channelId = channelForCriticality(medicine.criticality);

    for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
      // The medicine's own window gates the schedule's. A schedule inherited from
      // an earlier version can start before the drug did, and generating doses for
      // days before treatment began would put phantom rows into adherence's
      // denominator.
      if (medicine.startedOn && date < medicine.startedOn) continue;
      if (medicine.stoppedOn && date > medicine.stoppedOn) continue;

      for (const schedule of schedules) {
        // THE SCHEDULE HALF OF THE AI SAFETY GATE, SKIPPED RATHER THAN HIT.
        //
        // `trg_occ_requires_confirmed_schedule` aborts the INSERT for a schedule no human
        // signed off, and `insertOccurrenceIfAbsent` uses INSERT OR IGNORE, which does NOT
        // swallow a trigger's RAISE(ABORT) — verified against sqlite3: the statement still
        // errors with SQLITE_CONSTRAINT. So one unconfirmed row does not fail quietly, it
        // takes the WHOLE reconcile transaction down, and with it every other medicine's
        // occurrences: nothing materialises, `refreshAlarms` swallows the throw, and all
        // she is shown is "The reminders could not be set".
        //
        // That row is reachable. `medicine/schedule.tsx` writes its rows with
        // `confirmedByUser: false` and confirms them in a SEPARATE transaction one line
        // later, so a throw or a process kill between the two persists an unconfirmed
        // CURRENT schedule for one thread.
        //
        // `listActiveMedicines` has carried the identical filter for the medicine half
        // since v1, and says why in the same words: the trigger is the guarantee, this is
        // so an unconfirmed row is a quiet no-op for ONE medicine rather than an abort for
        // all of them. `buildAlarmRules` skips the same rows for the same reason. This was
        // the one of the three that did not.
        //
        // WHAT THIS COSTS, STATED: that one thread now produces no candidates, so Rule B
        // retires its future occurrences (only the ones with nothing recorded — history is
        // untouched). That is the honest state rather than a loss, because
        // `buildAlarmRules` has always refused to arm those rows: they were occurrences
        // that could never ring. One thread visibly unscheduled beats every thread
        // silently unscheduled.
        if (schedule.confirmedByUserAt === null) continue;
        if (!occursOn(schedule, date)) continue;
        const timeLocal = schedule.timeLocal;
        if (!timeLocal) continue;

        candidates.push({
          threadId: medicine.threadId,
          medicineId: medicine.id,
          profileId: medicine.profileId,
          doseScheduleId: schedule.id,
          localDate: date,
          timeLocal,
          // Resolved from wall clock at this instant, never stored as a future
          // absolute time. This is the whole point of the wall-clock design.
          scheduledAtEpoch: wallClockToEpoch(date, timeLocal),
          channelId,
        });
      }
    }
  }
  return candidates;
}

// ── Retirement ───────────────────────────────────────────────────────────────

async function retireStaleOccurrences(args: {
  tx: Tx;
  profileId: string;
  today: string;
  existing: DoseOccurrence[];
  candidateById: Map<string, Candidate>;
  candidates: Candidate[];
  now: number;
}): Promise<number> {
  const { tx, profileId, today, existing, candidateById, candidates, now } = args;

  // Only today and forward. Occurrences from before today are history: a schedule
  // edited on Tuesday must not reach back and erase Monday's record of a dose that
  // really was armed and really was answered.
  const suspect = existing.filter((o) => o.localDate >= today && !candidateById.has(o.id));
  if (suspect.length === 0) return 0;

  const eventsByOccurrence = await listEventsForOccurrences(
    suspect.map((o) => o.id),
    tx,
  );

  // Times the calendar still expects today, per thread — used to tell a genuine
  // time change apart from a medicine that simply has no dose today.
  const stillExpectedToday = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.localDate !== today) continue;
    const set = stillExpectedToday.get(candidate.threadId) ?? new Set<string>();
    set.add(candidate.timeLocal);
    stillExpectedToday.set(candidate.threadId, set);
  }

  const timeChangeMarked = new Set<string>();
  let retired = 0;

  for (const occurrence of suspect) {
    const events = eventsByOccurrence.get(occurrence.id) ?? [];

    // THE GUARD. She told us what happened to this dose. The schedule changing
    // afterwards does not un-swallow a tablet, and `cancelled` outranks `taken` in
    // deriveStatus — so cancelling here would delete a true clinical record.
    if (hasRecordedOutcome(events)) continue;
    if (occurrence.status === 'cancelled') continue;

    await appendEvent(
      {
        occurrenceId: occurrence.id,
        threadId: occurrence.threadId,
        medicineId: occurrence.medicineId,
        profileId,
        event: 'cancelled',
        atEpoch: now,
        payload: { reason: 'schedule_changed', retiredTimeLocal: occurrence.timeLocal },
        origin: 'app',
      },
      tx,
    );
    await setStatus(occurrence.id, 'cancelled', tx);
    retired += 1;

    // One marker per thread per run. The chart draws a vertical line on the day
    // the timing changed; three lines for a thrice-daily medicine would say
    // nothing extra and clutter the axis.
    const expected = stillExpectedToday.get(occurrence.threadId);
    if (
      occurrence.localDate === today &&
      expected &&
      expected.size > 0 &&
      !timeChangeMarked.has(occurrence.threadId)
    ) {
      timeChangeMarked.add(occurrence.threadId);
      await insertMedChangeEvent(
        {
          profileId,
          threadId: occurrence.threadId,
          kind: 'time_changed',
          localDate: today,
          detail: `${occurrence.timeLocal} → ${[...expected].sort().join(', ')}`,
        },
        tx,
      );
    }
  }
  return retired;
}

// ── Status recomputation ─────────────────────────────────────────────────────

async function recomputeStatuses(
  tx: Tx,
  profileId: string,
  fromDate: string,
  toDate: string,
  now: number,
): Promise<number> {
  // Re-read rather than reuse the earlier snapshot: retirement and materialisation
  // have both run since, and this pass has to see their results.
  const occurrences = await listOccurrences(profileId, fromDate, toDate, tx);
  if (occurrences.length === 0) return 0;

  const eventsByOccurrence = await listEventsForOccurrences(
    occurrences.map((o) => o.id),
    tx,
  );

  let changed = 0;
  for (const occurrence of occurrences) {
    const events = eventsByOccurrence.get(occurrence.id) ?? [];
    const next = deriveStatus(events, occurrence.scheduledAtEpoch, now);
    if (next !== occurrence.status) {
      await setStatus(occurrence.id, next, tx);
      changed += 1;
    }
  }
  return changed;
}

// ── Delivery probes ──────────────────────────────────────────────────────────

/**
 * One probe per newly armed dose.
 *
 * Instrumenting the ABSENCE of delivery is what turns OEM process-killing from an
 * invisible failure into a visible one: if `delivered_epoch` is still NULL well
 * after `expected_epoch`, the reminder never reached her and the health check can
 * say so out loud instead of the app quietly looking like she ignored it.
 */
async function insertDeliveryProbes(tx: Tx, created: Candidate[]): Promise<number> {
  let inserted = 0;
  for (const candidate of created) {
    const occurrenceId = candidateOccurrenceId(candidate);
    const existing = await queryAll<{ id: string }>(
      `SELECT id FROM delivery_probe WHERE occurrence_id = ? AND expected_epoch = ? LIMIT 1;`,
      [occurrenceId, candidate.scheduledAtEpoch],
      tx,
    );
    if (existing.length > 0) continue;

    await createRecord(
      'delivery_probe',
      { occurrence_id: occurrenceId, expected_epoch: candidate.scheduledAtEpoch },
      tx,
    );
    inserted += 1;
  }
  return inserted;
}

/** Called by the notification receiver when a reminder actually appears. */
export async function markProbeDelivered(
  occurrenceId: string,
  deliveredEpoch: number,
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(
      `UPDATE delivery_probe SET delivered_epoch = ?, checked_epoch = ?
        WHERE occurrence_id = ? AND delivered_epoch IS NULL;`,
      [deliveredEpoch, deliveredEpoch, occurrenceId],
    );
  }, tx);
}

// ── Alarm horizon ────────────────────────────────────────────────────────────

/**
 * RULES, not dates.
 *
 * The Kotlin boot receiver expands these forward on its own, indefinitely. A list
 * of pre-computed timestamps would run out on day eight for a user who never opens
 * the app — and that user is precisely who this app is built for.
 */
export function buildAlarmRules(
  medicines: Medicine[],
  schedulesByThread: Map<string, DoseSchedule[]>,
): AlarmRule[] {
  const rules: AlarmRule[] = [];

  for (const medicine of medicines) {
    const schedules = schedulesByThread.get(medicine.threadId) ?? [];
    for (const schedule of schedules) {
      if (schedule.scheduleType !== 'FIXED' || !schedule.timeLocal) continue;
      if (schedule.confirmedByUserAt === null) continue;

      rules.push({
        threadId: medicine.threadId,
        medicineId: medicine.id,
        title: alarmTitle(medicine),
        body: alarmBody(schedule),
        timeLocal: schedule.timeLocal,
        daysMask: schedule.daysMask,
        intervalDays: schedule.intervalDays,
        // Intersect the drug's window with the schedule's: the later start and the
        // earlier stop both apply, or the native side rings on days the medicine
        // was not actually being taken.
        startedOn: laterOf(medicine.startedOn, schedule.startedOn),
        stoppedOn: earlierOf(medicine.stoppedOn, schedule.stoppedOn),
        channelId: channelForCriticality(medicine.criticality),
        critical: medicine.criticality === 'critical',
        escalateAfterMin: ESCALATION_MINUTES[medicine.criticality],
      });
    }
  }
  return rules;
}

function alarmTitle(medicine: Medicine): string {
  return medicine.strength
    ? `${medicine.nameAsWritten} ${medicine.strength}`
    : medicine.nameAsWritten;
}

/**
 * The notification body transcribes the prescription and nothing else.
 *
 * No dosing advice, no "don't forget", no encouragement. Everything here came off
 * the paper or out of the user's own typing.
 */
function alarmBody(schedule: DoseSchedule): string {
  const parts: string[] = [];
  const quantity =
    schedule.quantityText ??
    (schedule.quantityValue !== null
      ? `${schedule.quantityValue}${schedule.quantityUnit ? ` ${schedule.quantityUnit}` : ''}`
      : null);
  if (quantity) parts.push(quantity);

  const food: Record<NonNullable<DoseSchedule['foodRelation']>, string> = {
    before: 'before food',
    after: 'after food',
    with: 'with food',
    empty: 'on an empty stomach',
    any: '',
  };
  if (schedule.foodRelation) {
    const label = food[schedule.foodRelation];
    if (label) parts.push(label);
  }
  return parts.join(' · ');
}

function laterOf(a: string | null, b: string): string {
  if (!a) return b;
  return a > b ? a : b;
}

function earlierOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
