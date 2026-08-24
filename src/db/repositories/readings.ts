/**
 * Readings — every measured value, in one table.
 *
 * THE RULE THAT MATTERS MOST IN THIS FILE:
 *
 *   Storage is gated by INSTRUMENT limits. It is never gated by clinical plausibility.
 *
 * A glucose of 18 mg/dL is not a typo — it is a hypoglycaemic emergency, and it is
 * the single reading a doctor would act on fastest. A validator that "sanity checks"
 * it away deletes the most important record the app will ever hold. So:
 *
 *   • `assertInstrumentBounds` refuses only what no device could have produced
 *     (a negative blood pressure, a glucose of 90,000).
 *   • `plausibilityWarning` is SEPARATE, PURE, and advisory. The UI shows it as a
 *     soft "did you mean?" confirmation with a plainly-labelled "Yes, that's right"
 *     path. It must never be wired to a refusal.
 *
 * `value_qualifier` records a glucometer that showed LO or HI instead of a number.
 * Those readings are clinically loud and must survive the round trip intact.
 *
 * ── A CENSORED READING IS AN INEQUALITY, NOT A MISSING VALUE ─────────────────────
 *
 * A meter printing LO has not failed. It has asserted `value < 20 mg/dL` — the bottom of
 * what it can quantify — and that inequality is frequently the most important thing in
 * the window. Two columns hold it, and they are not interchangeable:
 *
 *   • `v1` is a MEASUREMENT. A number the instrument produced.
 *   • `qualifier_bound` is a LIMIT. The edge of the instrument's range at the moment of
 *     entry, and only ever on a row whose qualifier is not 'exact'.
 *
 * Writing the limit into `v1` would make a number the meter never produced
 * indistinguishable from one it did — to the CSV, to the OPD table, to any future
 * average, and to any doctor's own spreadsheet. Qualifier columns get dropped downstream;
 * value columns do not. So the exclusivity is enforced by a database trigger
 * (`trg_reading_bound_is_not_a_value_*`), not by the care of whoever edits this file
 * next, and the functions below fail loudly and early rather than letting SQLite abort a
 * transaction with a message a screen cannot use.
 *
 * The bound is a per-row SNAPSHOT, derived here from the recorded meter rather than
 * accepted from the caller — same reasoning as `was_backfilled` below. She will replace
 * the meter; a LO recorded in March on a 20-floor meter must not silently re-plot at 10
 * because a different meter was configured in July.
 */

import type { MetricDef, Reading, ValueQualifier } from '../../types';
import { toLocalDate, toLocalTime, tzOffsetMinutes } from '../../lib/datetime';
import { getMetricDef } from './metrics';
import { boundForQualifier, getInstrumentRange } from './settings';
import {
  type Bind,
  type Tx,
  createRecord,
  fromJson,
  inTransaction,
  intToBool,
  nowEpoch,
  queryAll,
  queryFirst,
  recordEdit,
  softDeleteRecord,
  toJson,
  updateRecord,
} from './_shared';

export type ValueSlot = 'v1' | 'v2' | 'v3';

export type ReadingValues = {
  v1: number | null;
  v2?: number | null;
  v3?: number | null;
};

export type NewReading = {
  profileId: string;
  metricKey: string;
  values: ReadingValues;
  /** 'below_range' / 'above_range' is a meter showing LO / HI. */
  valueQualifier?: ValueQualifier;
  context?: Record<string, string> | null;
  note?: string | null;
  /** Omit for "now". Supply for a backfilled reading taken earlier. */
  atEpoch?: number;
  source?: Reading['source'];
};

export type ReadingPatch = {
  values?: ReadingValues;
  valueQualifier?: ValueQualifier;
  context?: Record<string, string> | null;
  note?: string | null;
  atEpoch?: number;
};

type ReadingRow = {
  id: string;
  profile_id: string;
  metric_key: string;
  v1: number | null;
  v2: number | null;
  v3: number | null;
  value_qualifier: ValueQualifier;
  qualifier_bound: number | null;
  context_json: string | null;
  note: string | null;
  at_epoch: number;
  local_date: string;
  local_time: string;
  was_backfilled: number;
  source: Reading['source'];
  edited_count: number;
};

function mapReading(row: ReadingRow): Reading {
  return {
    id: row.id,
    profileId: row.profile_id,
    metricKey: row.metric_key,
    v1: row.v1,
    v2: row.v2,
    v3: row.v3,
    valueQualifier: row.value_qualifier,
    qualifierBound: row.qualifier_bound,
    context: fromJson<Record<string, string>>(row.context_json),
    note: row.note,
    atEpoch: row.at_epoch,
    localDate: row.local_date,
    localTime: row.local_time,
    wasBackfilled: intToBool(row.was_backfilled),
    source: row.source,
    editedCount: row.edited_count,
  };
}

const SELECT_READING = `
  SELECT id, profile_id, metric_key, v1, v2, v3, value_qualifier, qualifier_bound,
         context_json, note, at_epoch, local_date, local_time, was_backfilled, source,
         edited_count
    FROM reading`;

// ── Validation ───────────────────────────────────────────────────────────────

export class InstrumentBoundsError extends Error {
  constructor(
    readonly slot: ValueSlot,
    readonly value: number,
    readonly min: number,
    readonly max: number,
    readonly fieldLabelEn: string,
  ) {
    super(`${fieldLabelEn} of ${value} is outside what any instrument can report (${min}–${max}).`);
    this.name = 'InstrumentBoundsError';
  }
}

/**
 * PURE. Throws only for values no real device could have produced.
 *
 * These bounds come from `MetricSchema.fields[].min/max`, which the schema comments
 * describe as instrument limits. Do not tighten them toward "normal" ranges here or
 * anywhere else — the abnormal reading is the one worth recording.
 */
export function assertInstrumentBounds(metric: MetricDef, values: ReadingValues): void {
  for (const field of metric.schema.fields) {
    const value = readSlot(values, field.slot);
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value)) {
      throw new InstrumentBoundsError(field.slot, value, field.min, field.max, field.labelEn);
    }
    if (value < field.min || value > field.max) {
      throw new InstrumentBoundsError(field.slot, value, field.min, field.max, field.labelEn);
    }
  }
}

/**
 * Thrown when a caller tries to save a measurement and a limit on the same row.
 *
 * Its own class, not a bare Error, so a screen can tell "you asked me to record a value
 * the meter never produced" apart from "the value is outside instrument range" and say
 * something useful about each.
 */
export class CensoredReadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CensoredReadingError';
  }
}

/**
 * PURE. The application-layer twin of the database trigger.
 *
 * The trigger is the guarantee; this is the error message. Letting SQLite abort the
 * transaction would work, but the caller would receive a constraint failure from three
 * layers down with no way to tell the user what to do about it — and the whole
 * surrounding transaction would already have rolled back.
 */
export function assertQualifierExclusivity(
  qualifier: ValueQualifier,
  values: ReadingValues,
): void {
  if (qualifier !== 'exact' && values.v1 !== null && values.v1 !== undefined) {
    throw new CensoredReadingError(
      `A reading marked ${qualifier} cannot also carry a value: the meter printed a word, not a number. ` +
        `Pass v1: null and let the bound come from the recorded instrument range.`,
    );
  }
}

export type PlausibilityWarning = {
  slot: ValueSlot;
  fieldKey: string;
  fieldLabelEn: string;
  fieldLabelHi: string;
  value: number;
  /** Which side of the soft band the value fell on. */
  direction: 'low' | 'high';
  softMin: number | null;
  softMax: number | null;
};

/**
 * PURE and ADVISORY. Returns every field that fell outside its soft band.
 *
 * Returns an array rather than a single warning because a blood pressure can be
 * surprising in both numbers at once, and showing the user only the first would
 * hide half of what she needs to check.
 *
 * Callers MUST treat a non-empty result as a confirmation prompt, never as a
 * rejection, and the confirm path must record the value unchanged.
 */
export function plausibilityWarning(metric: MetricDef, values: ReadingValues): PlausibilityWarning[] {
  const warnings: PlausibilityWarning[] = [];
  for (const field of metric.schema.fields) {
    const value = readSlot(values, field.slot);
    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    const softMin = field.softMin ?? null;
    const softMax = field.softMax ?? null;
    const base = {
      slot: field.slot,
      fieldKey: field.key,
      fieldLabelEn: field.labelEn,
      fieldLabelHi: field.labelHi,
      value,
      softMin,
      softMax,
    };
    if (softMin !== null && value < softMin) warnings.push({ ...base, direction: 'low' });
    else if (softMax !== null && value > softMax) warnings.push({ ...base, direction: 'high' });
  }
  return warnings;
}

/**
 * A meter that printed LO or HI never gave us a number to second-guess, so asking
 * "did you mean?" about it is pure noise on top of an already-alarming result.
 */
export function shouldPromptPlausibility(
  metric: MetricDef,
  values: ReadingValues,
  qualifier: ValueQualifier,
): PlausibilityWarning[] {
  if (qualifier !== 'exact') return [];
  return plausibilityWarning(metric, values);
}

function readSlot(values: ReadingValues, slot: ValueSlot): number | null | undefined {
  if (slot === 'v1') return values.v1;
  if (slot === 'v2') return values.v2;
  return values.v3;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getReading(id: string, tx?: Tx): Promise<Reading | null> {
  const row = await queryFirst<ReadingRow>(
    `${SELECT_READING} WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapReading(row) : null;
}

export async function listReadings(
  profileId: string,
  metricKey: string,
  options: { fromDate?: string; toDate?: string; limit?: number } = {},
  tx?: Tx,
): Promise<Reading[]> {
  // local_date is compared as a stored string. Computing a date inside the WHERE
  // clause would both defeat idx_reading_profile_metric_date and reintroduce the
  // timezone ambiguity the three-timestamp design exists to remove.
  const clauses = ['profile_id = ?', 'metric_key = ?', 'deleted_at_epoch IS NULL'];
  const params: Bind[] = [profileId, metricKey];
  if (options.fromDate) {
    clauses.push('local_date >= ?');
    params.push(options.fromDate);
  }
  if (options.toDate) {
    clauses.push('local_date <= ?');
    params.push(options.toDate);
  }
  params.push(options.limit ?? 500);

  const rows = await queryAll<ReadingRow>(
    `${SELECT_READING} WHERE ${clauses.join(' AND ')} ORDER BY at_epoch DESC LIMIT ?;`,
    params,
    tx,
  );
  return rows.map(mapReading);
}

export async function listRecentReadings(
  profileId: string,
  limit = 50,
  tx?: Tx,
): Promise<Reading[]> {
  const rows = await queryAll<ReadingRow>(
    `${SELECT_READING} WHERE profile_id = ? AND deleted_at_epoch IS NULL
       ORDER BY at_epoch DESC LIMIT ?;`,
    [profileId, limit],
    tx,
  );
  return rows.map(mapReading);
}

export async function getLatestReading(
  profileId: string,
  metricKey: string,
  tx?: Tx,
): Promise<Reading | null> {
  const row = await queryFirst<ReadingRow>(
    `${SELECT_READING} WHERE profile_id = ? AND metric_key = ? AND deleted_at_epoch IS NULL
       ORDER BY at_epoch DESC LIMIT 1;`,
    [profileId, metricKey],
    tx,
  );
  return row ? mapReading(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Records a reading.
 *
 * Instrument bounds are checked; plausibility is NOT. If the UI wanted to prompt,
 * it already did so via `shouldPromptPlausibility` before calling here — by the time
 * a value reaches this function the user has said "yes, that is what the meter said"
 * and our job is to write it down faithfully.
 */
export async function createReading(input: NewReading, tx?: Tx): Promise<string> {
  const metric = await getMetricDef(input.metricKey, tx);
  if (!metric) throw new Error(`Unknown metric: ${input.metricKey}`);

  const qualifier = input.valueQualifier ?? 'exact';
  assertQualifierExclusivity(qualifier, input.values);
  assertInstrumentBounds(metric, input.values);

  // Derived, never passed in — the caller cannot forget it, and cannot invent one either.
  // Null when no meter has been recorded, which is a complete and supported record: the
  // reading still says LO, it simply cannot yet say what LO was measured against.
  const qualifierBound = await boundForQualifier(input.metricKey, qualifier, tx);

  const atEpoch = input.atEpoch ?? nowEpoch();
  const when = new Date(atEpoch);

  return createRecord(
    'reading',
    {
      profile_id: input.profileId,
      metric_key: input.metricKey,
      v1: input.values.v1,
      v2: input.values.v2 ?? null,
      v3: input.values.v3 ?? null,
      value_qualifier: qualifier,
      qualifier_bound: qualifierBound,
      context_json: toJson(input.context ?? null),
      note: input.note ?? null,
      at_epoch: atEpoch,
      local_date: toLocalDate(when),
      local_time: toLocalTime(when),
      tz_offset_minutes: tzOffsetMinutes(when),
      // Derived rather than passed in, so a caller cannot forget it. A reading
      // entered from memory hours later is weaker evidence than one taken at the
      // meter, and the report has to be able to say which it was.
      was_backfilled: atEpoch < nowEpoch() - BACKFILL_GRACE_MS ? 1 : 0,
      source: input.source ?? 'manual',
    },
    tx,
  );
}

/** Five minutes of slack for a slow form fill; beyond that it is genuinely backfill. */
const BACKFILL_GRACE_MS = 5 * 60 * 1000;

/**
 * Corrects a reading, leaving a reviewable trail.
 *
 * Every changed field appends a `record_edit` row carrying the OLD and NEW values,
 * and `edited_count` goes up by one — all inside one transaction, so a crash can
 * never leave a value changed with no record of what it used to be. A doctor
 * looking at a corrected 180 systolic needs to know whether the original was 108
 * (a transposition) or 80 (the other arm); a bare counter cannot tell her.
 *
 * CHANGING THE QUALIFIER CHANGES THE OTHER TWO COLUMNS WITH IT, and audits every part:
 *
 *   • exact → LO/HI: the number is cleared, because the correction being made is "the
 *     meter never gave me one", and the bound is taken from the meter recorded today.
 *     The number is not lost — the `record_edit` row carries it, which is exactly the
 *     mechanism that makes a correction reviewable rather than merely countable.
 *   • LO/HI → exact: the bound is cleared, because there is nothing left to bound.
 *
 * Doing this here rather than making every screen remember it is what keeps a database
 * trigger from aborting somebody's whole save with a constraint message. A bound is
 * re-derived ONLY when the qualifier actually moves; editing the note on a two-year-old
 * LO must not silently re-stamp it with the range of a meter she bought last month.
 */
export async function editReading(id: string, patch: ReadingPatch, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const before = await getReading(id, t);
    if (!before) throw new Error(`Reading ${id} not found or deleted`);

    const metric = await getMetricDef(before.metricKey, t);
    if (!metric) throw new Error(`Unknown metric: ${before.metricKey}`);

    const nextQualifier = patch.valueQualifier ?? before.valueQualifier;
    const qualifierMoved = nextQualifier !== before.valueQualifier;

    const nextValues: ReadingValues = patch.values
      ? { v1: patch.values.v1, v2: patch.values.v2 ?? null, v3: patch.values.v3 ?? null }
      : { v1: before.v1, v2: before.v2, v3: before.v3 };
    // A caller that hands over a number for a row marked LO or HI is confused about which
    // of the two it means, and quietly picking one on its behalf is how a fabricated
    // value ends up in the record. Refuse, loudly, and only when values were actually
    // supplied — clearing `v1` because the QUALIFIER moved is a correction, not a
    // contradiction, and it is audited below.
    if (patch.values) assertQualifierExclusivity(nextQualifier, patch.values);
    if (nextQualifier !== 'exact') nextValues.v1 = null;
    assertInstrumentBounds(metric, nextValues);

    const updates: Record<string, Bind> = {};
    const audits: { field: string; oldValue: string | null; newValue: string | null }[] = [];

    const compare = (field: string, oldValue: Bind, newValue: Bind) => {
      if (oldValue === newValue) return;
      updates[field] = newValue;
      audits.push({
        field,
        oldValue: oldValue === null ? null : String(oldValue),
        newValue: newValue === null ? null : String(newValue),
      });
    };

    if (patch.values || qualifierMoved) {
      compare('v1', before.v1, nextValues.v1);
      compare('v2', before.v2, nextValues.v2 ?? null);
      compare('v3', before.v3, nextValues.v3 ?? null);
    }
    if (patch.valueQualifier !== undefined) {
      compare('value_qualifier', before.valueQualifier, patch.valueQualifier);
    }
    if (qualifierMoved) {
      const nextBound =
        nextQualifier === 'exact'
          ? null
          : await boundForQualifier(before.metricKey, nextQualifier, t);
      compare('qualifier_bound', before.qualifierBound, nextBound);
    }
    if (patch.note !== undefined) compare('note', before.note, patch.note);
    if (patch.context !== undefined) {
      compare('context_json', toJson(before.context), toJson(patch.context));
    }
    if (patch.atEpoch !== undefined && patch.atEpoch !== before.atEpoch) {
      const when = new Date(patch.atEpoch);
      compare('at_epoch', before.atEpoch, patch.atEpoch);
      compare('local_date', before.localDate, toLocalDate(when));
      compare('local_time', before.localTime, toLocalTime(when));
      updates['tz_offset_minutes'] = tzOffsetMinutes(when);
    }

    // A no-op save must not inflate edited_count. An edit count that grows every
    // time someone opens and closes the form tells a reader nothing.
    if (audits.length === 0) return;

    updates['edited_count'] = before.editedCount + 1;
    await updateRecord('reading', id, updates, t);
    for (const audit of audits) {
      await recordEdit('reading', id, audit.field, audit.oldValue, audit.newValue, t);
    }
  }, tx);
}

export async function deleteReading(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('reading', id, tx);
}

/**
 * Attach the recorded instrument range to LO/HI readings that were saved before anyone
 * told the app what meter she uses.
 *
 * THE CALLER MUST HAVE ASKED HER FIRST, in words, whether those earlier readings were
 * taken on this meter. This function cannot know that and does not guess: it is a
 * transcription of a human's answer, exactly like `target_range.set_by_label`, and
 * calling it without the question is the app inventing a fact about a device.
 *
 * Only rows with NO bound are touched, so a reading that already carries the range of a
 * previous meter keeps it — the earlier snapshot is the more accurate one, and
 * overwriting it would be the exact drift the per-row column exists to prevent.
 *
 * `edited_count` is deliberately NOT bumped. Nothing she recorded has changed; a limit
 * has been attached to an observation that always meant this. The `record_edit` row is
 * still written, so the attachment itself is reviewable.
 *
 * @returns how many readings gained a bound.
 */
export async function applyRecordedBoundToPastReadings(
  profileId: string,
  metricKey: string,
  tx?: Tx,
): Promise<number> {
  return inTransaction(async (t) => {
    const range = await getInstrumentRange(metricKey, t);
    if (!range) return 0;

    const rows = await queryAll<{ id: string; value_qualifier: ValueQualifier }>(
      `SELECT id, value_qualifier FROM reading
        WHERE profile_id = ? AND metric_key = ? AND deleted_at_epoch IS NULL
          AND value_qualifier <> 'exact' AND qualifier_bound IS NULL;`,
      [profileId, metricKey],
      t,
    );

    let updated = 0;
    for (const row of rows) {
      const bound = row.value_qualifier === 'below_range' ? range.low : range.high;
      if (bound === null) continue; // she recorded only one end of the range
      await updateRecord('reading', row.id, { qualifier_bound: bound }, t);
      await recordEdit('reading', row.id, 'qualifier_bound', null, String(bound), t);
      updated += 1;
    }
    return updated;
  }, tx);
}

/** The audit trail for one reading, newest first. Powers the "edited" disclosure. */
export async function listReadingEdits(
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
      WHERE record_kind = 'reading' AND record_id = ? ORDER BY at_epoch DESC;`,
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
