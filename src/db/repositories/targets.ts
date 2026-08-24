/**
 * Target ranges — the only clinical thresholds this app will ever hold.
 *
 * `target_range` SHIPS EMPTY, ALWAYS. The app does not seed a single value, does not
 * infer one from a guideline, and does not carry a "typical range" table waiting to be
 * switched on. Every row here was entered because a named human said so on a named
 * date, and `set_by_label` + `set_on` are printed in every chart legend so the reader
 * can see whose line she is looking at.
 *
 * That is why `setByLabel` and `setOn` are REQUIRED arguments below and have no
 * default — not "App", not today's date. An unattributed target is not a slightly worse
 * target; it is the app quietly issuing medical advice under its own name. Making the
 * arguments mandatory means no caller can produce one, even by forgetting.
 */

import type { TargetRange } from '../../types';
import {
  type Bind,
  type Tx,
  createRecord,
  fromJson,
  inTransaction,
  queryAll,
  queryFirst,
  softDeleteRecord,
  toJson,
  updateRecord,
} from './_shared';

type TargetRangeRow = {
  id: string;
  profile_id: string;
  metric_key: string;
  context_json: string | null;
  field: string;
  low: number | null;
  high: number | null;
  set_by_label: string;
  set_on: string;
};

const TARGET_COLUMNS =
  'id, profile_id, metric_key, context_json, field, low, high, set_by_label, set_on';

const FIELDS = ['v1', 'v2', 'v3'] as const;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toField(value: string): TargetRange['field'] {
  const field = FIELDS.find((candidate) => candidate === value);
  if (!field) {
    // `field` has a DEFAULT but no CHECK constraint, so a bad value is storable in
    // principle. Falling back keeps the chart drawable; the warning keeps it findable.
    console.warn(`[targets] unknown target_range.field "${value}", reading it as v1`);
    return 'v1';
  }
  return field;
}

function mapTarget(row: TargetRangeRow): TargetRange {
  return {
    id: row.id,
    profileId: row.profile_id,
    metricKey: row.metric_key,
    context: fromJson<Record<string, string>>(row.context_json),
    field: toField(row.field),
    low: row.low,
    high: row.high,
    setByLabel: row.set_by_label,
    setOn: row.set_on,
  };
}

/**
 * `set_by_label` and `set_on` are NOT NULL, but NOT NULL does not stop `''` — and a
 * blank legend line is exactly the unattributed target the columns exist to prevent.
 */
function assertLabel(setByLabel: string): string {
  const label = setByLabel.trim();
  if (!label) {
    throw new Error('target_range.set_by_label must name the person who set this target');
  }
  return label;
}

function assertSetOn(setOn: string): string {
  if (!LOCAL_DATE.test(setOn)) {
    throw new Error(`target_range.set_on must be a local date (YYYY-MM-DD), got: ${setOn}`);
  }
  return setOn;
}

function assertBand(low: number | null, high: number | null): void {
  if (low === null && high === null) {
    throw new Error('A target needs at least one of low/high — an open band targets nothing');
  }
  if (low !== null && high !== null && low > high) {
    throw new Error(`Target low (${low}) is above high (${high})`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listTargets(profileId: string, tx?: Tx): Promise<TargetRange[]> {
  const rows = await queryAll<TargetRangeRow>(
    `SELECT ${TARGET_COLUMNS} FROM target_range
       WHERE profile_id = ? AND deleted_at_epoch IS NULL
       ORDER BY metric_key, field, (context_json IS NOT NULL) DESC, updated_at_epoch DESC;`,
    [profileId],
    tx,
  );
  return rows.map(mapTarget);
}

/**
 * The resolved target for each of the metric's fields.
 *
 * CONTEXT MATCHING IS EXACT JSON-STRING EQUALITY on the stored `context_json` — not a
 * subset test, and not a comparison of parsed objects. `{"meal":"fasting"}` and
 * `{"meal":"post_meal"}` are different targets for the same metric, and a caller must
 * build the context object the same way the writer did (same keys, same order) or the
 * comparison misses. That is a deliberate trade: exact equality is a rule a reader can
 * hold in her head, and a "close enough" match on a glucose target is a wrong line
 * drawn under a real decision.
 *
 * A row with a NULL context is the FALLBACK — the target that applies when no
 * context-specific one exists. Both are fetched together and the context-specific row
 * wins per field, so "fasting 80–130, everything else 80–180" resolves correctly
 * without the caller running two queries and implementing the preference itself.
 */
export async function getTargetsForMetric(
  profileId: string,
  metricKey: string,
  context?: Record<string, string> | null,
  tx?: Tx,
): Promise<TargetRange[]> {
  const contextJson = toJson(context ?? null);
  const rows = await queryAll<TargetRangeRow>(
    `SELECT ${TARGET_COLUMNS} FROM target_range
       WHERE profile_id = ? AND metric_key = ? AND deleted_at_epoch IS NULL
         AND (context_json IS ? OR context_json IS NULL)
       ORDER BY field, (context_json IS NOT NULL) DESC, updated_at_epoch DESC;`,
    [profileId, metricKey, contextJson],
    tx,
  );

  // The ORDER BY already puts the context-specific row ahead of the fallback within a
  // field, so the first row seen per field is the winner.
  const resolved: TargetRange[] = [];
  const seenFields = new Set<string>();
  for (const row of rows) {
    const target = mapTarget(row);
    if (seenFields.has(target.field)) continue;
    seenFields.add(target.field);
    resolved.push(target);
  }
  return resolved;
}

/**
 * The single best-matching target, preferring a context-specific row over the NULL
 * fallback.
 *
 * A metric with several fields (blood pressure: systolic in v1, diastolic in v2) holds
 * one target row PER FIELD, and this returns the lowest-numbered field that has one —
 * for BP, the systolic target. Anything charting both bands wants
 * `getTargetsForMetric`, which resolves each field under the same context rule.
 */
export async function getTarget(
  profileId: string,
  metricKey: string,
  context?: Record<string, string> | null,
  tx?: Tx,
): Promise<TargetRange | null> {
  const resolved = await getTargetsForMetric(profileId, metricKey, context, tx);
  return resolved[0] ?? null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export type SetTargetInput = {
  profileId: string;
  metricKey: string;
  /** REQUIRED. The named human who set this. The app must never sign one itself. */
  setByLabel: string;
  /** REQUIRED, 'YYYY-MM-DD'. The date they set it — printed beside the label. */
  setOn: string;
  field?: TargetRange['field'];
  low?: number | null;
  high?: number | null;
  /** Exact-match context, e.g. `{ meal: 'fasting' }`. Omit for the fallback target. */
  context?: Record<string, string> | null;
};

/**
 * Record a target, superseding whatever it replaces.
 *
 * Any live row for the same (profile, metric, field, context) is SOFT-deleted in the
 * same transaction before the new one is inserted. Two live targets for one context
 * would put two bands and two attributions on one chart with no way to tell which the
 * doctor meant — and updating the old row in place instead would erase who set the
 * previous target and when, which is the one thing this table exists to remember.
 * Superseded rows stay readable in the DB, and travel to the family's devices as their
 * own delete.
 */
export async function setTarget(input: SetTargetInput, tx?: Tx): Promise<string> {
  const setByLabel = assertLabel(input.setByLabel);
  const setOn = assertSetOn(input.setOn);
  const low = input.low ?? null;
  const high = input.high ?? null;
  assertBand(low, high);

  const field = input.field ?? 'v1';
  const contextJson = toJson(input.context ?? null);

  return inTransaction(async (t) => {
    const superseded = await queryAll<{ id: string }>(
      `SELECT id FROM target_range
         WHERE profile_id = ? AND metric_key = ? AND field = ? AND context_json IS ?
           AND deleted_at_epoch IS NULL;`,
      [input.profileId, input.metricKey, field, contextJson],
      t,
    );
    for (const row of superseded) {
      await softDeleteRecord('target_range', row.id, t);
    }

    return createRecord(
      'target_range',
      {
        profile_id: input.profileId,
        metric_key: input.metricKey,
        context_json: contextJson,
        field,
        low,
        high,
        set_by_label: setByLabel,
        set_on: setOn,
      },
      t,
    );
  }, tx);
}

/**
 * Correct an existing target in place — a mistyped bound, a misspelled doctor.
 *
 * Attribution can be corrected but never blanked, so a patch that touches
 * `setByLabel`/`setOn` is validated exactly as `setTarget` validates them.
 */
export type UpdateTargetInput = {
  low?: number | null;
  high?: number | null;
  field?: TargetRange['field'];
  context?: Record<string, string> | null;
  setByLabel?: string;
  setOn?: string;
};

export async function updateTarget(
  id: string,
  patch: UpdateTargetInput,
  tx?: Tx,
): Promise<void> {
  const row: Record<string, Bind> = {};

  // Both bounds are only checked against each other when both are in the patch —
  // validating one against the stored other would need a read this write does not
  // otherwise need, and `setTarget` is the path that guarantees a sane starting band.
  if (patch.low !== undefined && patch.high !== undefined) {
    assertBand(patch.low ?? null, patch.high ?? null);
  }
  if (patch.low !== undefined) row['low'] = patch.low;
  if (patch.high !== undefined) row['high'] = patch.high;
  if (patch.field !== undefined) row['field'] = patch.field;
  if (patch.context !== undefined) row['context_json'] = toJson(patch.context);
  if (patch.setByLabel !== undefined) row['set_by_label'] = assertLabel(patch.setByLabel);
  if (patch.setOn !== undefined) row['set_on'] = assertSetOn(patch.setOn);

  await updateRecord('target_range', id, row, tx);
}

export async function deleteTarget(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('target_range', id, tx);
}

/** Convenience read for an editor screen that already holds a target id. */
export async function getTargetById(id: string, tx?: Tx): Promise<TargetRange | null> {
  const row = await queryFirst<TargetRangeRow>(
    `SELECT ${TARGET_COLUMNS} FROM target_range WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapTarget(row) : null;
}
