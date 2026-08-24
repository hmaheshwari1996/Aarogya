/**
 * Foreground watchdog — the safety net under the alarm layer.
 *
 * Android OEMs kill background processes aggressively, Doze defers alarms, and a
 * force-stopped app receives nothing at all. When that happens the reminder never
 * arrived, and the patient did nothing wrong. This runs on every foreground and
 * quietly offers to catch up.
 *
 * TWO WINDOW CHOICES, BOTH DELIBERATE:
 *
 *  • 15 minutes of grace before a dose is considered un-recorded. Anything shorter
 *    puts a card on screen while the notification is still sitting in the shade.
 *
 *  • SEVEN DAYS of history, aligned with the retro-edit window. A 72-hour window
 *    looks generous until someone spends a week in hospital, or a fortnight at a
 *    relative's house with the phone off — and everything older than three days is
 *    then silently unreachable, with no prompt and no way in. A week is the span
 *    that actually matches how people's lives interrupt them.
 */

import type { DoseOccurrence } from '../../types';
import { addDays, toLocalDate } from '../../lib/datetime';
import { newId } from '../../lib/ids';
import {
  type Tx,
  inTransaction,
  nowEpoch,
  queryAll,
  queryFirst,
} from '../../db/repositories/_shared';
import { appendEvent, listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { listOccurrences, setStatus } from '../../db/repositories/occurrences';
import { hasRecordedOutcome } from './deriveStatus';

export const CATCH_UP_GRACE_MINUTES = 15;
export const CATCH_UP_WINDOW_DAYS = 7;

/**
 * The catch-up card shows at most twelve. A list of forty un-recorded doses is not
 * a to-do list, it is an accusation — and it is unusable on a small screen. The
 * remainder is reachable behind an "and N more" affordance rather than dropped.
 */
export const CATCH_UP_MAX_ITEMS = 12;

/**
 * A span of days the patient was not managing her own medicines — a hospital stay,
 * a stretch with family, a phone that was off.
 *
 * Defined here rather than in `src/types.ts` because v1 has no table for it: the
 * ranges live as a small JSON list in `app_meta`, which needs no migration and is
 * trivially readable by adherence, streaks and the catch-up card alike.
 */
export type AwayRange = {
  id: string;
  /** Inclusive. */
  fromDate: string;
  /** Inclusive. */
  toDate: string;
  note: string | null;
  createdAtEpoch: number;
};

export type CatchUpItem = {
  occurrenceId: string;
  threadId: string;
  medicineId: string;
  medicineName: string;
  strength: string | null;
  quantityText: string | null;
  localDate: string;
  timeLocal: string;
  scheduledAtEpoch: number;
};

export type CatchUpList = {
  /** Most recent first, capped at CATCH_UP_MAX_ITEMS. */
  items: CatchUpItem[];
  /** How many more exist behind the cap. Zero when everything fits. */
  andMore: number;
  total: number;
  fromDate: string;
};

type CatchUpRow = {
  id: string;
  thread_id: string;
  medicine_id: string;
  local_date: string;
  time_local: string;
  scheduled_at_epoch: number;
  name_as_written: string;
  strength: string | null;
  quantity_text: string | null;
  quantity_value: number | null;
  quantity_unit: string | null;
};

/**
 * Doses whose moment passed with nothing recorded, inside the retro-edit window.
 *
 * The absence test is `NOT EXISTS (dose_event)` rather than `status = 'no_record'`,
 * because status is a derived cache: if a journal drain wrote a `taken` event but
 * the recompute has not run yet, a status-based query would ask her to record a
 * dose she has already taken.
 */
export async function findCatchUp(
  profileId: string,
  now: number = Date.now(),
): Promise<CatchUpList> {
  const today = toLocalDate(new Date(now));
  const fromDate = addDays(today, -CATCH_UP_WINDOW_DAYS);
  const cutoff = now - CATCH_UP_GRACE_MINUTES * 60_000;

  // One join rather than N lookups: the card needs the medicine's name and dose to
  // be answerable at all ("Metformin 500 — 1 tablet, 08:00"), and a fifteen-medicine
  // week would otherwise be a hundred round trips on every foreground.
  const rows = await queryAll<CatchUpRow>(
    `SELECT o.id, o.thread_id, o.medicine_id, o.local_date, o.time_local, o.scheduled_at_epoch,
            m.name_as_written, m.strength,
            s.quantity_text, s.quantity_value, s.quantity_unit
       FROM dose_occurrence o
       -- Deleting a medicine must also stop it asking to be caught up on. Its past
       -- occurrences are never retired (history is not rewritten), so without this
       -- filter a drug she removed keeps appearing on the card for another week.
       JOIN medicine m ON m.id = o.medicine_id AND m.deleted_at_epoch IS NULL
       LEFT JOIN dose_schedule s ON s.id = o.dose_schedule_id
      WHERE o.profile_id = ?
        AND o.local_date >= ?
        AND o.scheduled_at_epoch <= ?
        AND o.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM dose_event e WHERE e.occurrence_id = o.id)
      ORDER BY o.scheduled_at_epoch DESC
      LIMIT 500;`,
    [profileId, fromDate, cutoff],
  );

  // Away days are filtered here rather than in SQL: the ranges live in app_meta as
  // a small JSON list, and a week of them is cheaper to intersect in memory than to
  // express as a generated WHERE clause.
  const away = await listAwayRanges(profileId);
  const visible = rows.filter((row) => !isAwayOn(away, row.local_date));

  const items = visible.slice(0, CATCH_UP_MAX_ITEMS).map(toCatchUpItem);
  return {
    items,
    andMore: Math.max(0, visible.length - items.length),
    total: visible.length,
    fromDate,
  };
}

function toCatchUpItem(row: CatchUpRow): CatchUpItem {
  const quantity =
    row.quantity_text ??
    (row.quantity_value !== null
      ? `${row.quantity_value}${row.quantity_unit ? ` ${row.quantity_unit}` : ''}`
      : null);
  return {
    occurrenceId: row.id,
    threadId: row.thread_id,
    medicineId: row.medicine_id,
    medicineName: row.name_as_written,
    strength: row.strength,
    quantityText: quantity,
    localDate: row.local_date,
    timeLocal: row.time_local,
    scheduledAtEpoch: row.scheduled_at_epoch,
  };
}

// ── Away ranges ──────────────────────────────────────────────────────────────

const AWAY_KEY_PREFIX = 'away_ranges:';

function awayKey(profileId: string): string {
  return `${AWAY_KEY_PREFIX}${profileId}`;
}

/**
 * Marks a span of days as "away", so it counts as neither taken nor un-recorded.
 *
 * A WEEK IN HOSPITAL MUST NOT READ AS NON-ADHERENCE. During an inpatient stay the
 * ward gives the medicines and nobody taps anything; without this, the app
 * manufactures a seven-day hole and the adherence figure — the number a physician
 * may change treatment over — reports a collapse that never happened.
 *
 * Two things are written, on purpose:
 *   1. The range itself, in `app_meta`. Adherence and streaks consult it by date,
 *      so days that never had an occurrence row are covered too.
 *   2. A `cancelled` event on each affected occurrence that has no recorded
 *      outcome, tagged `reason: 'away'`. That is what keeps the catch-up card
 *      quiet and stops the alarm layer nagging a hospital bed.
 *
 * Occurrences that DO carry a recorded outcome are left alone — if she managed to
 * tap "taken" from her hospital bed, that is a real record and it stands.
 */
export async function markAwayRange(
  profileId: string,
  fromDate: string,
  toDate: string,
  options: { note?: string | null } = {},
  tx?: Tx,
): Promise<AwayRange> {
  if (toDate < fromDate) throw new Error('markAwayRange: toDate is before fromDate');

  return inTransaction(async (t) => {
    const range: AwayRange = {
      id: newId(),
      fromDate,
      toDate,
      note: options.note ?? null,
      createdAtEpoch: nowEpoch(),
    };

    const existing = await readAwayRanges(profileId, t);
    await writeAwayRanges(profileId, [...existing, range], t);

    const occurrences = await listOccurrences(profileId, fromDate, toDate, t);
    if (occurrences.length > 0) {
      const eventsByOccurrence = await listEventsForOccurrences(
        occurrences.map((o) => o.id),
        t,
      );
      for (const occurrence of occurrences) {
        const events = eventsByOccurrence.get(occurrence.id) ?? [];
        if (hasRecordedOutcome(events)) continue;
        if (occurrence.status === 'cancelled') continue;
        await retireForAway(occurrence, profileId, range.id, t);
      }
    }
    return range;
  }, tx);
}

async function retireForAway(
  occurrence: DoseOccurrence,
  profileId: string,
  awayRangeId: string,
  tx: Tx,
): Promise<void> {
  await appendEvent(
    {
      occurrenceId: occurrence.id,
      threadId: occurrence.threadId,
      medicineId: occurrence.medicineId,
      profileId,
      event: 'cancelled',
      // The reason is what makes this distinguishable from an ordinary cancel, both
      // for the UI ("you were away") and for anyone reading the raw log later.
      payload: { reason: 'away', awayRangeId },
      origin: 'watchdog',
    },
    tx,
  );
  await setStatus(occurrence.id, 'cancelled', tx);
}

export async function listAwayRanges(profileId: string, tx?: Tx): Promise<AwayRange[]> {
  return readAwayRanges(profileId, tx);
}

/**
 * Stops future days being treated as away.
 *
 * It does NOT un-cancel days already retired: `dose_event` is append-only, and the
 * app cannot un-say something it recorded. Those days stay out of the denominator,
 * which is the non-punitive direction to fail in.
 */
export async function clearAwayRange(profileId: string, rangeId: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const existing = await readAwayRanges(profileId, t);
    await writeAwayRanges(
      profileId,
      existing.filter((r) => r.id !== rangeId),
      t,
    );
  }, tx);
}

/** PURE. Inclusive on both ends, matching every other date range in this app. */
export function isAwayOn(ranges: readonly AwayRange[], localDate: string): boolean {
  return ranges.some((r) => localDate >= r.fromDate && localDate <= r.toDate);
}

async function readAwayRanges(profileId: string, tx?: Tx): Promise<AwayRange[]> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [awayKey(profileId)],
    tx,
  );
  if (!row?.value) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAwayRange);
  } catch {
    // A corrupt blob must not make the app claim she was never away, and it must
    // not crash the dashboard either. Empty plus a warning is the honest middle.
    console.warn('[watchdog] away ranges for', profileId, 'were unreadable');
    return [];
  }
}

function isAwayRange(value: unknown): value is AwayRange {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['fromDate'] === 'string' &&
    typeof r['toDate'] === 'string'
  );
}

async function writeAwayRanges(profileId: string, ranges: AwayRange[], tx: Tx): Promise<void> {
  await tx.db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [awayKey(profileId), JSON.stringify(ranges)],
  );
}
