/**
 * Symptoms — the `symptom_def` registry, its per-pack mapping, and the `symptom_event`
 * log itself.
 *
 * `symptom_def` and `pack_symptom` are reference data shipped with the app: they carry
 * no `deleted_at_epoch`, so the "every read filters soft deletes" rule bites only on
 * `symptom_event` here.
 *
 * ── TWO KINDS OF READ, AND THEY MUST NOT BE CONFUSED ────────────────────────────
 *
 * "What may she TAP?" and "what does this recorded event SAY?" are different questions
 * and this module answers them with different functions.
 *
 * A symptom key can be RETIRED (`symptom_def.retired_at_epoch`, added in migration v4).
 * `nausea_vomiting` is the first: it merged two observations that a TB course needs kept
 * apart, and it was replaced by `nausea` and `vomiting`. Its row stays, with its original
 * wording untouched, because `symptom_event` stores nothing but the key and every label
 * on the OPD report is resolved from here at read time — relabelling would rewrite what
 * she recorded months ago, on the page a doctor reads.
 *
 *   • `listSymptomDefs()` returns EVERY key, retired included. It is the REGISTRY read,
 *     and every existing caller uses it to build a key→label map for events already
 *     recorded — the Today screen, Trends, the backfill editor, the visit-questions
 *     screen, and `features/reports/data/collect.ts`, which is the OPD report and the
 *     CSV. If it filtered, a symptom she logged in July would print on her doctor's page
 *     as the raw string `nausea_vomiting`.
 *   • `listSymptomDefsForProfile()` and `listOfferableSymptomDefs()` are the CHIP reads
 *     and exclude retired keys. Nothing may offer one again.
 *
 * That is the way round it has to be. A label lookup that misses a key prints gibberish
 * on a printed medical record, in five places; a chip list that uses the wrong function
 * shows one extra chip on one screen. The louder failure gets the safer default.
 *
 * A symptom event stores all three timestamp forms (`at_epoch` for ordering, `local_date`
 * for grouping, `local_time` for time-of-day patterns) plus the offset that produced them,
 * so a symptom logged before a flight still groups onto the day it was felt.
 */

import { toLocalDate, toLocalTime, tzOffsetMinutes } from '../../lib/datetime';
import type { SymptomEvent } from '../../types';
import {
  createRecord,
  inTransaction,
  intToBool,
  nowEpoch,
  queryAll,
  queryFirst,
  recordEdit,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Public shapes ────────────────────────────────────────────────────────────

/** Derived from the domain type so the two can never drift apart. */
export type Severity = NonNullable<SymptomEvent['severity']>;

export type SymptomDef = {
  key: string;
  labelEn: string;
  labelHi: string;
  /** Base symptoms are offered to every profile, whichever condition packs are on. */
  isBase: boolean;
  sortOrder: number;
  /**
   * Non-null means this key is kept for the events that already point at it and is never
   * offered again. See the file header.
   */
  retiredAtEpoch: number | null;
};

/** One key and how many times this profile has recorded it. */
export type SymptomUsage = {
  symptomKey: string;
  count: number;
};

/**
 * A symptom is EITHER a known key from the registry OR free text the user typed —
 * never both, and never neither. Both set would double-count the same complaint on the
 * OPD report (once under the key, once under the label); neither set is an event nobody
 * can read back.
 */
type SymptomIdentity =
  | { symptomKey: string; customLabel?: never }
  | { customLabel: string; symptomKey?: never };

export type LogSymptomInput = SymptomIdentity & {
  profileId: string;
  severity?: Severity | null;
  note?: string | null;
  photoUri?: string | null;
  /** Defaults to now. Pass a Date to backfill "I had this yesterday evening". */
  at?: Date;
  /** Hangs the symptom off the reading it came with (dizziness at a BP of 90/60). */
  linkedReadingId?: string | null;
  /** Hangs it off a medicine THREAD, not a version — a side effect outlives a dose change. */
  linkedThreadId?: string | null;
};

/** Omitting both identity keys leaves the existing one alone; setting one clears the other. */
export type SymptomEventPatch = {
  severity?: Severity | null;
  note?: string | null;
  photoUri?: string | null;
  at?: Date;
} & (
  | { symptomKey: string; customLabel?: never }
  | { customLabel: string; symptomKey?: never }
  | { symptomKey?: never; customLabel?: never }
);

export type SymptomEventFilter = {
  /** Inclusive 'YYYY-MM-DD'. Compared against the STORED local_date, never a computed one. */
  fromDate?: string;
  toDate?: string;
  limit?: number;
};

// ── Row types & mappers ──────────────────────────────────────────────────────

type SymptomDefRow = {
  key: string;
  label_en: string;
  label_hi: string;
  is_base: number;
  sort_order: number;
  retired_at_epoch: number | null;
};

type SymptomEventRow = {
  id: string;
  profile_id: string;
  symptom_key: string | null;
  custom_label: string | null;
  severity: string | null;
  note: string | null;
  photo_uri: string | null;
  at_epoch: number;
  local_date: string;
  local_time: string;
  tz_offset_minutes: number;
  linked_reading_id: string | null;
  linked_thread_id: string | null;
  edited_count: number;
};

function mapSymptomDef(row: SymptomDefRow): SymptomDef {
  return {
    key: row.key,
    labelEn: row.label_en,
    labelHi: row.label_hi,
    isBase: intToBool(row.is_base),
    sortOrder: row.sort_order,
    retiredAtEpoch: row.retired_at_epoch,
  };
}

function mapSymptomEvent(row: SymptomEventRow): SymptomEvent {
  return {
    id: row.id,
    profileId: row.profile_id,
    symptomKey: row.symptom_key,
    customLabel: row.custom_label,
    // The column's CHECK constraint is what makes this cast safe: SQLite refuses to
    // store anything outside the three severities.
    severity: row.severity as Severity | null,
    note: row.note,
    photoUri: row.photo_uri,
    atEpoch: row.at_epoch,
    localDate: row.local_date,
    localTime: row.local_time,
    linkedReadingId: row.linked_reading_id,
    linkedThreadId: row.linked_thread_id,
  };
}

const DEF_COLUMNS = 'key, label_en, label_hi, is_base, sort_order, retired_at_epoch';

/** The chip-list predicate, written once so no read can forget half of it. */
const OFFERABLE = 'retired_at_epoch IS NULL';

/**
 * Chips are ordered by `sort_order` and tie-broken on the English label.
 *
 * The tiebreak matters more than it looks: before v4 every `sort_order` was derived from
 * a position in an array, and a phone that skipped a renumbering could hold duplicates.
 * Without a deterministic second key SQLite is free to return tied rows in any order it
 * likes, and the chip grid would reshuffle itself between visits — which, for someone
 * navigating by muscle memory at 1.3x font scale, is worse than a wrong order.
 */
const DEF_ORDER = 'ORDER BY sort_order, label_en';

const EVENT_COLUMNS = `id, profile_id, symptom_key, custom_label, severity, note, photo_uri,
     at_epoch, local_date, local_time, tz_offset_minutes,
     linked_reading_id, linked_thread_id, edited_count`;

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * THE REGISTRY. Every key, retired ones included.
 *
 * Use this to resolve what a recorded event SAYS. Do not use it to decide what she may
 * tap — see `listSymptomDefsForProfile` for that, and the file header for why the two
 * are separate functions rather than one with a flag.
 */
export async function listSymptomDefs(tx?: Tx): Promise<SymptomDef[]> {
  const rows = await queryAll<SymptomDefRow>(
    `SELECT ${DEF_COLUMNS} FROM symptom_def ${DEF_ORDER};`,
    [],
    tx,
  );
  return rows.map(mapSymptomDef);
}

/**
 * Every key that may still be offered, ignoring which packs are on.
 *
 * For a "show everything" affordance behind the profile's own chips. A screen listing
 * chips for one person wants `listSymptomDefsForProfile` instead.
 */
export async function listOfferableSymptomDefs(tx?: Tx): Promise<SymptomDef[]> {
  const rows = await queryAll<SymptomDefRow>(
    `SELECT ${DEF_COLUMNS} FROM symptom_def WHERE ${OFFERABLE} ${DEF_ORDER};`,
    [],
    tx,
  );
  return rows.map(mapSymptomDef);
}

export async function listSymptomsForPack(packKey: string, tx?: Tx): Promise<SymptomDef[]> {
  const rows = await queryAll<SymptomDefRow>(
    `SELECT ${DEF_COLUMNS}
       FROM symptom_def
      WHERE ${OFFERABLE}
        AND key IN (SELECT symptom_key FROM pack_symptom WHERE pack_key = ?)
      ${DEF_ORDER};`,
    [packKey],
    tx,
  );
  return rows.map(mapSymptomDef);
}

/**
 * THE CHIP LIST. Base symptoms, plus the symptoms of every pack this profile currently
 * has switched on.
 *
 * This is the read the "How I feel" screen needs and did not have. It used to call
 * `listSymptomDefs()` — every key in the registry, no profile, no packs — and then slice
 * the first twelve off the front. Two consequences, both invisible from the outside:
 *
 *   • the merged nausea/vomiting chip ranked fourteenth and was cut, which is the bug
 *     that was reported; and
 *   • NO pack symptom has ever been reachable in any build, because every one of them
 *     sorts after the base set. On a TB course that means "blood in the sputum", "yellow
 *     eyes" and "dark urine" — the three the pack exists to offer — could not be recorded
 *     at all.
 *
 * There is no limit parameter and callers must not reintroduce one. The right way to keep
 * the screen short is a "show more" fold, which hides nothing permanently; a slice hides
 * things permanently and silently.
 *
 * A pack is ON while its `profile_condition` row has no `ended_on`. Switching a pack off
 * withdraws its chips and touches nothing she recorded, which is the whole contract of a
 * pack.
 */
export async function listSymptomDefsForProfile(
  profileId: string,
  tx?: Tx,
): Promise<SymptomDef[]> {
  const rows = await queryAll<SymptomDefRow>(
    `SELECT ${DEF_COLUMNS}
       FROM symptom_def
      WHERE ${OFFERABLE}
        AND (is_base = 1
             OR key IN (SELECT ps.symptom_key
                          FROM pack_symptom ps
                          JOIN profile_condition pc ON pc.pack_key = ps.pack_key
                         WHERE pc.profile_id = ? AND pc.ended_on IS NULL))
      ${DEF_ORDER};`,
    [profileId],
    tx,
  );
  return rows.map(mapSymptomDef);
}

/**
 * How often this profile has recorded each symptom, most-recorded first.
 *
 * Derived from `symptom_event` rather than kept in a counter column: a stored count can
 * drift from the record it claims to describe, and a derived one cannot. At this
 * volume — a few hundred rows over a year — the grouped scan is far below anything a
 * person could perceive.
 *
 * Free-text symptoms are excluded: they have no key to order a chip by.
 *
 * `sinceDate` exists so a caller can weigh recent months over a long-forgotten fortnight.
 * Compared against the STORED `local_date`, never a computed one.
 *
 * For the caller ordering a chip grid with this: sort ONCE, when the screen loads, and
 * never again while it is open. A list that re-sorts under her finger between one tap and
 * the next is worse than a fixed one — and tie-break on the existing clinical order, so
 * an empty history renders exactly today's arrangement.
 */
export async function countSymptomUsage(
  profileId: string,
  options: { sinceDate?: string } = {},
  tx?: Tx,
): Promise<SymptomUsage[]> {
  const clauses = ['profile_id = ?', 'deleted_at_epoch IS NULL', 'symptom_key IS NOT NULL'];
  const params: Bind[] = [profileId];
  if (options.sinceDate !== undefined) {
    clauses.push('local_date >= ?');
    params.push(options.sinceDate);
  }

  const rows = await queryAll<{ symptom_key: string; n: number }>(
    `SELECT symptom_key, COUNT(*) AS n
       FROM symptom_event
      WHERE ${clauses.join(' AND ')}
      GROUP BY symptom_key
      ORDER BY n DESC, symptom_key ASC;`,
    params,
    tx,
  );
  return rows.map((row) => ({ symptomKey: row.symptom_key, count: row.n }));
}

export async function listSymptomEvents(
  profileId: string,
  filter: SymptomEventFilter = {},
  tx?: Tx,
): Promise<SymptomEvent[]> {
  const conditions = ['profile_id = ?', 'deleted_at_epoch IS NULL'];
  const params: Bind[] = [profileId];

  if (filter.fromDate !== undefined) {
    conditions.push('local_date >= ?');
    params.push(filter.fromDate);
  }
  if (filter.toDate !== undefined) {
    conditions.push('local_date <= ?');
    params.push(filter.toDate);
  }

  let sql = `SELECT ${EVENT_COLUMNS}
       FROM symptom_event
      WHERE ${conditions.join(' AND ')}
      ORDER BY at_epoch DESC`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  const rows = await queryAll<SymptomEventRow>(`${sql};`, params, tx);
  return rows.map(mapSymptomEvent);
}

export async function getSymptomEvent(id: string, tx?: Tx): Promise<SymptomEvent | null> {
  const row = await queryFirst<SymptomEventRow>(
    `SELECT ${EVENT_COLUMNS} FROM symptom_event WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapSymptomEvent(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function logSymptom(input: LogSymptomInput, tx?: Tx): Promise<string> {
  const identity = resolveIdentity(input.symptomKey, input.customLabel);
  // One clock source, then three derived forms of it. Deriving them from a single Date
  // is what stops at_epoch and local_date disagreeing across a midnight boundary.
  const when = input.at ?? new Date(nowEpoch());

  return createRecord(
    'symptom_event',
    {
      profile_id: input.profileId,
      symptom_key: identity.symptomKey,
      custom_label: identity.customLabel,
      severity: input.severity ?? null,
      note: nonEmpty(input.note),
      photo_uri: input.photoUri ?? null,
      at_epoch: when.getTime(),
      local_date: toLocalDate(when),
      local_time: toLocalTime(when),
      tz_offset_minutes: tzOffsetMinutes(when),
      linked_reading_id: input.linkedReadingId ?? null,
      linked_thread_id: input.linkedThreadId ?? null,
      edited_count: 0,
    },
    tx,
  );
}

/**
 * Correct a logged symptom.
 *
 * Two things happen together or not at all, which is why this is one transaction rather
 * than an update followed by some audit calls:
 *
 *   1. every changed field appends a `record_edit` row, and
 *   2. `edited_count` goes up by one.
 *
 * `edited_count` alone is a rumour. It tells a doctor that this row was touched but not
 * what it used to say — so a symptom corrected from 'severe' to 'mild' is indistinguishable
 * from a fixed typo in the note, and the one case where that matters is the one where the
 * patient walked it back. A correction has to be REVIEWABLE, not merely countable.
 *
 * Writing the audit outside the transaction would be worse than not writing it: a crash
 * between the two leaves an edit count with no explanation, or an explanation of an edit
 * that never landed.
 *
 * @returns true when something actually changed. An empty patch writes nothing at all —
 *          no audit row, no count bump, no outbox traffic.
 */
export async function editSymptomEvent(
  id: string,
  patch: SymptomEventPatch,
  tx?: Tx,
): Promise<boolean> {
  return inTransaction(async (t) => {
    // Read inside the transaction: `edited_count` is a read-modify-write, and reading it
    // outside would let two concurrent corrections both write count+1.
    const row = await queryFirst<SymptomEventRow>(
      `SELECT ${EVENT_COLUMNS} FROM symptom_event WHERE id = ? AND deleted_at_epoch IS NULL;`,
      [id],
      t,
    );
    if (!row) {
      throw new Error(`symptom_event ${id} not found (or deleted) — nothing to edit.`);
    }

    const changes: { column: string; before: Bind; after: Bind }[] = [];
    const note = (column: string, before: Bind, after: Bind) => {
      if (before !== after) changes.push({ column, before, after });
    };

    let nextKey = row.symptom_key;
    let nextLabel = row.custom_label;
    if (patch.symptomKey !== undefined) {
      nextKey = requireNonEmpty(patch.symptomKey, 'symptomKey');
      nextLabel = null;
    } else if (patch.customLabel !== undefined) {
      nextLabel = requireNonEmpty(patch.customLabel, 'customLabel');
      nextKey = null;
    }
    note('symptom_key', row.symptom_key, nextKey);
    note('custom_label', row.custom_label, nextLabel);

    if (patch.severity !== undefined) note('severity', row.severity, patch.severity ?? null);
    if (patch.note !== undefined) note('note', row.note, nonEmpty(patch.note));
    if (patch.photoUri !== undefined) note('photo_uri', row.photo_uri, patch.photoUri ?? null);

    if (patch.at !== undefined) {
      // Re-deriving all four together keeps them consistent; `note()` then audits only the
      // ones that genuinely moved (a time correction inside the same day leaves local_date
      // alone, and an untouched column should not appear in the audit trail).
      note('at_epoch', row.at_epoch, patch.at.getTime());
      note('local_date', row.local_date, toLocalDate(patch.at));
      note('local_time', row.local_time, toLocalTime(patch.at));
      note('tz_offset_minutes', row.tz_offset_minutes, tzOffsetMinutes(patch.at));
    }

    if (changes.length === 0) return false;

    for (const change of changes) {
      await recordEdit('symptom_event', id, change.column, auditText(change.before), auditText(change.after), t);
    }

    const values: Record<string, Bind> = { edited_count: row.edited_count + 1 };
    for (const change of changes) values[change.column] = change.after;
    await updateRecord('symptom_event', id, values, t);

    return true;
  }, tx);
}

/** Soft delete. A hard DELETE on this table is refused by trg_symptom_no_hard_delete. */
export async function deleteSymptomEvent(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('symptom_event', id, tx);
}

/**
 * The audit trail for one symptom event, newest first. Powers the "edited" disclosure.
 *
 * Without this read, the record_edit rows written above would be reviewable only by
 * someone with a SQL client — which makes the whole point of writing them theoretical.
 */
export async function listSymptomEdits(
  id: string,
  tx?: Tx,
): Promise<{ field: string; oldValue: string | null; newValue: string | null; atEpoch: number }[]> {
  const rows = await queryAll<{
    field: string;
    old_value: string | null;
    new_value: string | null;
    at_epoch: number;
  }>(
    `SELECT field, old_value, new_value, at_epoch FROM record_edit
      WHERE record_kind = 'symptom_event' AND record_id = ? ORDER BY at_epoch DESC;`,
    [id],
    tx,
  );
  return rows.map((r) => ({
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    atEpoch: r.at_epoch,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireNonEmpty(value: string, what: string): string {
  const trimmed = nonEmpty(value);
  if (trimmed === null) throw new Error(`${what} cannot be blank.`);
  return trimmed;
}

/**
 * The discriminated union above is a compile-time promise, and the UI is not the only
 * caller — an OCR path handing back `{}` when it recognised nothing would sail through
 * untyped JS. Enforced again here so an unreadable event can never reach the table.
 */
function resolveIdentity(
  symptomKey: string | undefined,
  customLabel: string | undefined,
): { symptomKey: string | null; customLabel: string | null } {
  const key = symptomKey === undefined ? null : requireNonEmpty(symptomKey, 'symptomKey');
  const label = customLabel === undefined ? null : requireNonEmpty(customLabel, 'customLabel');
  if ((key === null) === (label === null)) {
    throw new Error('A symptom needs exactly one of symptomKey or customLabel, not both and not neither.');
  }
  return { symptomKey: key, customLabel: label };
}

function auditText(value: Bind): string | null {
  return value === null ? null : String(value);
}
