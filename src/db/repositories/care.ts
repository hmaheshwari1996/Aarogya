/**
 * The care calendar — `care_event`.
 *
 * `anchor_source` is the entire reason this table exists as its own thing rather than a
 * list of dates:
 *
 *   'transcribed' — THE DOCTOR WROTE THIS. "Review on 14/08", "repeat LFT after 2 weeks".
 *                   It is evidence. AI extraction may produce ONLY these rows, because
 *                   transcribing what is on the paper is the one thing a model can be
 *                   held to; anything else is the model inventing clinical instruction.
 *   'inferred'    — THE APP DERIVED THIS by applying an offset WE chose (book the
 *                   appointment a few days before the review, collect the report a day
 *                   after the test). There is no evidence for that offset anywhere on the
 *                   prescription. It is our convenience, so it is always user-editable.
 *   'manual'      — the user typed it.
 *
 * Only `deriveInferredCareEvent()` writes 'inferred', and `createCareEvent()` refuses that
 * value outright, so an inferred row cannot exist without the anchor and offset that
 * explain it.
 */

import { addDays } from '../../lib/datetime';
import type { CareEvent, CareEventKind } from '../../types';
import {
  createRecord,
  inTransaction,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Public shapes ────────────────────────────────────────────────────────────

export type AnchorSource = CareEvent['anchorSource'];
export type CareStatus = CareEvent['status'];

/** 'inferred' is absent on purpose — see deriveInferredCareEvent(). */
export type CreateCareEventInput = {
  profileId: string;
  kind: CareEventKind;
  title: string;
  /** 'YYYY-MM-DD'. */
  dueOn: string;
  anchorSource: Exclude<AnchorSource, 'inferred'>;
  anchorEventId?: string | null;
  prescriptionId?: string | null;
  relatedTestKey?: string | null;
  relatedThreadId?: string | null;
};

export type InferredCareEventInput = {
  profileId: string;
  kind: CareEventKind;
  title: string;
  /** The care_event this hangs off — normally the transcribed row the doctor wrote. */
  anchorEventId: string;
  /** The anchor's own due date, 'YYYY-MM-DD'. */
  anchorDueOn: string;
  /** Negative = before the anchor (book ahead), positive = after (collect the report). */
  offsetDays: number;
  prescriptionId?: string | null;
  relatedTestKey?: string | null;
  relatedThreadId?: string | null;
};

export type CareEventPatch = {
  title?: string;
  dueOn?: string;
  offsetDays?: number;
  relatedTestKey?: string | null;
  relatedThreadId?: string | null;
};

export type CareEventRange = {
  /** Inclusive 'YYYY-MM-DD', compared against the stored due_on. */
  fromDate: string;
  toDate: string;
  /** Defaults to every status. */
  statuses?: readonly CareStatus[];
};

// ── Row type & mapper ────────────────────────────────────────────────────────

type CareEventRow = {
  id: string;
  profile_id: string;
  kind: string;
  title: string;
  due_on: string;
  anchor_event_id: string | null;
  anchor_source: string;
  offset_days: number;
  related_test_key: string | null;
  related_thread_id: string | null;
  status: string;
  confirmed_at_epoch: number | null;
};

function mapCareEvent(row: CareEventRow): CareEvent {
  return {
    id: row.id,
    profileId: row.profile_id,
    // The column CHECK constraints are what make these casts safe.
    kind: row.kind as CareEventKind,
    title: row.title,
    dueOn: row.due_on,
    anchorEventId: row.anchor_event_id,
    anchorSource: row.anchor_source as AnchorSource,
    offsetDays: row.offset_days,
    relatedTestKey: row.related_test_key,
    relatedThreadId: row.related_thread_id,
    status: row.status as CareStatus,
    confirmedAtEpoch: row.confirmed_at_epoch,
  };
}

// `prescription_id` is stored for provenance but is not part of the CareEvent contract in
// src/types.ts, so it is not selected or mapped here — the repository does not invent a
// domain field the shared type does not have.
const COLUMNS = `id, profile_id, kind, title, due_on, anchor_event_id, anchor_source,
     offset_days, related_test_key, related_thread_id, status, confirmed_at_epoch`;

// ── Reads ────────────────────────────────────────────────────────────────────

/** The home-screen queue: what is still outstanding, soonest first. */
export async function listPendingCare(
  profileId: string,
  options: { throughDate?: string } = {},
  tx?: Tx,
): Promise<CareEvent[]> {
  const conditions = ['profile_id = ?', 'deleted_at_epoch IS NULL', "status = 'pending'"];
  const params: Bind[] = [profileId];

  if (options.throughDate !== undefined) {
    conditions.push('due_on <= ?');
    params.push(options.throughDate);
  }

  const rows = await queryAll<CareEventRow>(
    `SELECT ${COLUMNS}
       FROM care_event
      WHERE ${conditions.join(' AND ')}
      ORDER BY due_on, created_at_epoch;`,
    params,
    tx,
  );
  return rows.map(mapCareEvent);
}

export async function listCareEvents(
  profileId: string,
  range: CareEventRange,
  tx?: Tx,
): Promise<CareEvent[]> {
  const conditions = ['profile_id = ?', 'deleted_at_epoch IS NULL', 'due_on >= ?', 'due_on <= ?'];
  const params: Bind[] = [profileId, range.fromDate, range.toDate];

  if (range.statuses !== undefined && range.statuses.length > 0) {
    // Placeholders are generated from the LENGTH of the list; every status itself is bound.
    conditions.push(`status IN (${range.statuses.map(() => '?').join(', ')})`);
    params.push(...range.statuses);
  }

  const rows = await queryAll<CareEventRow>(
    `SELECT ${COLUMNS}
       FROM care_event
      WHERE ${conditions.join(' AND ')}
      ORDER BY due_on, created_at_epoch;`,
    params,
    tx,
  );
  return rows.map(mapCareEvent);
}

export async function getCareEvent(id: string, tx?: Tx): Promise<CareEvent | null> {
  const row = await queryFirst<CareEventRow>(
    `SELECT ${COLUMNS} FROM care_event WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapCareEvent(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createCareEvent(input: CreateCareEventInput, tx?: Tx): Promise<string> {
  // Belt and braces: the type excludes 'inferred', but the AI extraction path crosses a
  // JSON boundary where types stop applying.
  if ((input.anchorSource as AnchorSource) === 'inferred') {
    throw new Error(
      "anchorSource 'inferred' cannot be created directly — use deriveInferredCareEvent(), " +
        'which records the anchor and the offset that justify the date.',
    );
  }

  return createRecord(
    'care_event',
    {
      profile_id: input.profileId,
      kind: input.kind,
      title: input.title,
      due_on: input.dueOn,
      anchor_event_id: input.anchorEventId ?? null,
      anchor_source: input.anchorSource,
      offset_days: 0,
      prescription_id: input.prescriptionId ?? null,
      related_test_key: input.relatedTestKey ?? null,
      related_thread_id: input.relatedThreadId ?? null,
      status: 'pending',
      // A row the user typed is confirmed the moment it exists. A transcribed row is a
      // machine's reading of someone's handwriting and stays unconfirmed until checked.
      confirmed_at_epoch: input.anchorSource === 'manual' ? nowEpoch() : null,
    },
    tx,
  );
}

/**
 * Build an 'inferred' row: anchor date + an offset THIS APP chose.
 *
 * The offset is our guess and nothing more. Nowhere on the prescription does it say to
 * book the appointment three days early or to collect the report the next morning — that
 * lead time is a convenience we invented because it is usually right, and "usually right"
 * is precisely why the row is marked as ours and left editable. The user moving this date
 * is not correcting an error; they are supplying the information we never had.
 *
 * Which is also why it is a separate function from createCareEvent: an inferred date that
 * cannot name the anchor it came from is indistinguishable from something the doctor said.
 */
export async function deriveInferredCareEvent(
  input: InferredCareEventInput,
  tx?: Tx,
): Promise<string> {
  return createRecord(
    'care_event',
    {
      profile_id: input.profileId,
      kind: input.kind,
      title: input.title,
      due_on: addDays(input.anchorDueOn, input.offsetDays),
      anchor_event_id: input.anchorEventId,
      anchor_source: 'inferred',
      offset_days: input.offsetDays,
      prescription_id: input.prescriptionId ?? null,
      related_test_key: input.relatedTestKey ?? null,
      related_thread_id: input.relatedThreadId ?? null,
      status: 'pending',
      // Ours, not the user's, and not the doctor's — unconfirmed until someone agrees.
      confirmed_at_epoch: null,
    },
    tx,
  );
}

/**
 * Re-derive an inferred row's due date after its anchor moved (the review got rescheduled,
 * so the "book it" reminder has to move with it).
 *
 * REFUSES a 'transcribed' row, loudly. Silently replacing a date the doctor wrote with one
 * this app computed is the exact failure `anchor_source` exists to make impossible: the
 * result looks identical to the original in the UI, is wrong, and carries the doctor's
 * authority while being wrong. 'manual' rows are refused for the same reason — the user's
 * own date is not ours to recompute either.
 *
 * @returns the resulting due_on.
 */
export async function recomputeInferredDueDate(
  id: string,
  newAnchorDate: string,
  tx?: Tx,
): Promise<string> {
  return inTransaction(async (t) => {
    const row = await queryFirst<CareEventRow>(
      `SELECT ${COLUMNS} FROM care_event WHERE id = ? AND deleted_at_epoch IS NULL;`,
      [id],
      t,
    );
    if (!row) throw new Error(`care_event ${id} not found (or deleted).`);

    if (row.anchor_source === 'transcribed') {
      throw new Error(
        `care_event ${id} is transcribed from the prescription — its date is what the doctor ` +
          'wrote and cannot be recomputed. Create an inferred event anchored to it instead.',
      );
    }
    if (row.anchor_source !== 'inferred') {
      throw new Error(
        `care_event ${id} has anchor_source '${row.anchor_source}'; only inferred dates are ` +
          'derived from an anchor and may be recomputed.',
      );
    }

    const dueOn = addDays(newAnchorDate, row.offset_days);
    if (dueOn !== row.due_on) {
      await updateRecord('care_event', id, { due_on: dueOn }, t);
    }
    return dueOn;
  }, tx);
}

export async function updateCareEvent(id: string, patch: CareEventPatch, tx?: Tx): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.title !== undefined) values['title'] = patch.title;
  if (patch.dueOn !== undefined) values['due_on'] = patch.dueOn;
  if (patch.offsetDays !== undefined) values['offset_days'] = patch.offsetDays;
  if (patch.relatedTestKey !== undefined) values['related_test_key'] = patch.relatedTestKey ?? null;
  if (patch.relatedThreadId !== undefined) values['related_thread_id'] = patch.relatedThreadId ?? null;

  // anchor_source is intentionally not patchable: relabelling an app-computed date as
  // 'transcribed' would launder a guess into evidence.
  await updateRecord('care_event', id, values, tx);
}

/** A human has accepted this row — the review gate for 'transcribed' and 'inferred' dates. */
export async function confirmCareEvent(id: string, tx?: Tx): Promise<void> {
  await updateRecord('care_event', id, { confirmed_at_epoch: nowEpoch() }, tx);
}

export async function markCareDone(id: string, tx?: Tx): Promise<void> {
  await updateRecord('care_event', id, { status: 'done' }, tx);
}

/** "Not doing this." Kept, not deleted, so it stops reappearing without vanishing. */
export async function dismissCareEvent(id: string, tx?: Tx): Promise<void> {
  await updateRecord('care_event', id, { status: 'dismissed' }, tx);
}

/** Replaced by a newer prescription's version of the same instruction. */
export async function supersedeCareEvent(id: string, tx?: Tx): Promise<void> {
  await updateRecord('care_event', id, { status: 'superseded' }, tx);
}

export async function deleteCareEvent(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('care_event', id, tx);
}

// ── THERE IS NO `countCareKindUsage`, AND THAT IS ON PURPOSE ─────────────────
//
// There was one, counting `care_event` rows per `kind` so the "what kind of thing?" chips
// on `care/index.tsx` could be ordered by what this household actually adds — her "sort
// frequently selected options most-used first" report.
//
// It had no callers, and it should not get one. Those chips are FIVE, wrapping, inside an
// add sheet: all of them are visible the moment the sheet opens, so there is no scroll to
// save, and splitting five chips into a pinned band plus a remainder costs a heading and a
// divider to reorder something nobody was hunting for. The report was about scrolling, and
// the symptom list is the only list here long enough to scroll. See the header of
// `src/features/frequency`.
//
// Left as a comment rather than deleted silently: a dead exported query reads to the next
// maintainer as "this is wired up".
