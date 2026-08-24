/**
 * The metric registry (`metric_def`, `pack_metric`) and the user's own tracked set
 * (`profile_metric`).
 *
 * None of these three tables has a `deleted_at_epoch` column — the first two are a
 * seeded registry and the third is switched off with `enabled = 0` — so there is no
 * soft-delete predicate to add to the reads below. That is the schema's choice, not an
 * omission here.
 */

import type { MetricDef, MetricSchema, MetricValueKind } from '../../types';
import {
  type Bind,
  type Tx,
  assertIdentifier,
  boolToInt,
  createRecord,
  enqueueOutbox,
  fromJson,
  inTransaction,
  intToBool,
  nextLamport,
  queryAll,
  queryFirst,
} from './_shared';

// ── Row shapes ───────────────────────────────────────────────────────────────

type MetricDefRow = {
  key: string;
  label_en: string;
  label_hi: string;
  unit: string;
  value_kind: string;
  schema_json: string;
  chart_kind: string;
  is_builtin: number;
  sort_order: number;
};

type TrackedMetricRow = MetricDefRow & {
  /** The profile's own ordering, which wins over the registry's. */
  profile_sort_order: number;
};

/** A metric the profile tracks, with the position she put it in. */
export type TrackedMetric = {
  def: MetricDef;
  sortOrder: number;
};

/** INSTRUMENT limits from `metric_def`. See `getInstrumentBounds`. */
export type InstrumentBounds = {
  minValid: number | null;
  maxValid: number | null;
};

const METRIC_DEF_COLUMNS =
  'key, label_en, label_hi, unit, value_kind, schema_json, chart_kind, is_builtin, sort_order';

const VALUE_KINDS = ['scalar', 'pair', 'triple', 'ordinal', 'boolean'] as const;
const CHART_KINDS = ['scatter', 'line', 'bar', 'none'] as const;

function toValueKind(value: string): MetricValueKind | null {
  return VALUE_KINDS.find((candidate) => candidate === value) ?? null;
}

function toChartKind(value: string): MetricDef['chartKind'] | null {
  return CHART_KINDS.find((candidate) => candidate === value) ?? null;
}

/**
 * `fromJson` proves the blob is JSON, not that it is a metric schema. Everything that
 * renders or charts a metric reads `schema.fields`, so a blob without them is not a
 * degraded metric — it is one the app cannot draw an input for at all.
 */
function isMetricSchema(value: unknown): value is MetricSchema {
  if (typeof value !== 'object' || value === null) return false;
  if (!('fields' in value) || !('primaryField' in value)) return false;
  return Array.isArray(value.fields) && typeof value.primaryField === 'string';
}

/**
 * Returns null for a metric the app cannot use. Callers skip it and warn rather than
 * throwing: one unusable row in the registry must not take down the whole metric list,
 * which would take down the screen the user records her readings from.
 */
function mapMetricDef(row: MetricDefRow): MetricDef | null {
  const schema = fromJson<unknown>(row.schema_json);
  if (!isMetricSchema(schema)) return null;

  const valueKind = toValueKind(row.value_kind);
  const chartKind = toChartKind(row.chart_kind);
  if (!valueKind || !chartKind) return null;

  return {
    key: row.key,
    labelEn: row.label_en,
    labelHi: row.label_hi,
    unit: row.unit,
    valueKind,
    schema,
    chartKind,
    isBuiltin: intToBool(row.is_builtin),
    sortOrder: row.sort_order,
  };
}

function mapUsableDefs(rows: MetricDefRow[], context: string): MetricDef[] {
  const defs: MetricDef[] = [];
  for (const row of rows) {
    const def = mapMetricDef(row);
    if (!def) {
      console.warn(`[metrics] ${context}: skipping unusable metric_def "${row.key}"`);
      continue;
    }
    defs.push(def);
  }
  return defs;
}

// ── Registry reads ───────────────────────────────────────────────────────────

export async function listMetricDefs(tx?: Tx): Promise<MetricDef[]> {
  const rows = await queryAll<MetricDefRow>(
    `SELECT ${METRIC_DEF_COLUMNS} FROM metric_def ORDER BY sort_order, key;`,
    [],
    tx,
  );
  return mapUsableDefs(rows, 'listMetricDefs');
}

export async function getMetricDef(key: string, tx?: Tx): Promise<MetricDef | null> {
  const row = await queryFirst<MetricDefRow>(
    `SELECT ${METRIC_DEF_COLUMNS} FROM metric_def WHERE key = ?;`,
    [key],
    tx,
  );
  if (!row) return null;
  const def = mapMetricDef(row);
  if (!def) console.warn(`[metrics] getMetricDef: metric_def "${key}" is unusable`);
  return def;
}

export async function listMetricsForPack(packKey: string, tx?: Tx): Promise<MetricDef[]> {
  const rows = await queryAll<MetricDefRow>(
    // Aliased explicitly: without an AS clause SQLite does not guarantee the result
    // column of `d.key` is named `key`, and the row mapper addresses columns by name.
    `SELECT d.key AS key, d.label_en AS label_en, d.label_hi AS label_hi, d.unit AS unit,
            d.value_kind AS value_kind, d.schema_json AS schema_json,
            d.chart_kind AS chart_kind, d.is_builtin AS is_builtin, d.sort_order AS sort_order
       FROM pack_metric pm
       JOIN metric_def d ON d.key = pm.metric_key
       WHERE pm.pack_key = ?
       ORDER BY d.sort_order, d.key;`,
    [packKey],
    tx,
  );
  return mapUsableDefs(rows, `listMetricsForPack(${packKey})`);
}

/**
 * `min_valid` / `max_valid` are INSTRUMENT limits and are not part of `MetricDef` in
 * src/types.ts, which is the shared contract with the UI and the report layer. Rather
 * than return a structurally wider object that would quietly drift from that contract,
 * the bounds get their own accessor. An unknown metric yields two nulls: "no bound
 * recorded" and "this metric does not exist" both mean the caller must not clamp.
 */
export async function getInstrumentBounds(key: string, tx?: Tx): Promise<InstrumentBounds> {
  const row = await queryFirst<{ min_valid: number | null; max_valid: number | null }>(
    `SELECT min_valid, max_valid FROM metric_def WHERE key = ?;`,
    [key],
    tx,
  );
  return { minValid: row?.min_valid ?? null, maxValid: row?.max_valid ?? null };
}

// ── The tracked set ──────────────────────────────────────────────────────────

export async function listTrackedMetrics(profileId: string, tx?: Tx): Promise<TrackedMetric[]> {
  const rows = await queryAll<TrackedMetricRow>(
    `SELECT d.key AS key, d.label_en AS label_en, d.label_hi AS label_hi, d.unit AS unit,
            d.value_kind AS value_kind, d.schema_json AS schema_json,
            d.chart_kind AS chart_kind, d.is_builtin AS is_builtin, d.sort_order AS sort_order,
            pm.sort_order AS profile_sort_order
       FROM profile_metric pm
       JOIN metric_def d ON d.key = pm.metric_key
       WHERE pm.profile_id = ? AND pm.enabled = 1
       ORDER BY pm.sort_order, d.sort_order, d.key;`,
    [profileId],
    tx,
  );

  const tracked: TrackedMetric[] = [];
  for (const row of rows) {
    const def = mapMetricDef(row);
    if (!def) {
      console.warn(`[metrics] listTrackedMetrics: skipping unusable metric_def "${row.key}"`);
      continue;
    }
    tracked.push({ def, sortOrder: row.profile_sort_order });
  }
  return tracked;
}

/**
 * The write plumbing `profile_metric` cannot borrow from _shared.
 *
 * Its primary key is COMPOSITE (profile_id, metric_key), but TABLES can only name one
 * pk column and names `profile_id`. `updateRecord()` would therefore emit
 * `WHERE profile_id = ?` and rewrite every metric the profile tracks — untracking one
 * would untrack all of them. So the statement is written here, still fully
 * parameterised, and the two things updateRecord would have done are done explicitly:
 * bump the lamport clock, and enqueue the outbox row.
 *
 * The outbox `row_id` is the PROFILE id, matching what `createRecord` writes for this
 * table: a sync consumer resolves an outbox row by the registered pk, so a composite
 * `profileId:metricKey` would resolve to nothing and the change would never travel.
 */
async function patchProfileMetric(
  t: Tx,
  profileId: string,
  metricKey: string,
  patch: Record<string, Bind>,
): Promise<void> {
  const columns = Object.keys(patch).map(assertIdentifier);
  if (columns.length === 0) return;

  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const result = await t.db.runAsync(
    `UPDATE profile_metric SET ${assignments} WHERE profile_id = ? AND metric_key = ?;`,
    [...columns.map((column) => patch[column] ?? null), profileId, metricKey],
  );
  // Nothing changed means there was no such row; enqueueing would ship a phantom.
  if (result.changes === 0) return;

  const lamport = await nextLamport(t);
  await enqueueOutbox(t, 'profile_metric', profileId, 'upsert', lamport);
}

/** New metrics land at the end of the user's list rather than jumping into the middle. */
async function nextSortOrder(t: Tx, profileId: string): Promise<number> {
  const row = await queryFirst<{ max_sort: number | null }>(
    `SELECT MAX(sort_order) AS max_sort FROM profile_metric WHERE profile_id = ?;`,
    [profileId],
    t,
  );
  return (row?.max_sort ?? -1) + 1;
}

export async function trackMetric(profileId: string, metricKey: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const existing = await queryFirst<{ enabled: number }>(
      `SELECT enabled FROM profile_metric WHERE profile_id = ? AND metric_key = ?;`,
      [profileId, metricKey],
      t,
    );

    if (!existing) {
      await createRecord(
        'profile_metric',
        {
          profile_id: profileId,
          metric_key: metricKey,
          enabled: boolToInt(true),
          sort_order: await nextSortOrder(t, profileId),
        },
        t,
      );
      return;
    }

    // Already on. Re-enqueueing would churn the outbox for a no-op write.
    if (intToBool(existing.enabled)) return;
    await patchProfileMetric(t, profileId, metricKey, { enabled: boolToInt(true) });
  }, tx);
}

/**
 * Switch a metric off. The row stays, and so does its `sort_order`.
 *
 * The tracked set is the USER'S, not the condition pack's: she may have been recording
 * weight for a year before any pack mentioned it. Deleting the row would also orphan
 * the readings that reference this metric_key from any "what do you track" listing, and
 * would silently lose the position she put it in when she turns it back on.
 */
export async function untrackMetric(profileId: string, metricKey: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    await patchProfileMetric(t, profileId, metricKey, { enabled: boolToInt(false) });
  }, tx);
}

/**
 * Rewrite the whole ordering in one transaction, so a crash cannot leave half the list
 * renumbered — which reads to the user as her metrics having shuffled themselves.
 * Keys the profile does not track are skipped by `patchProfileMetric` (0 rows changed).
 */
export async function reorderTrackedMetrics(
  profileId: string,
  orderedKeys: readonly string[],
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    for (let index = 0; index < orderedKeys.length; index += 1) {
      const metricKey = orderedKeys[index];
      if (metricKey === undefined) continue;
      await patchProfileMetric(t, profileId, metricKey, { sort_order: index });
    }
  }, tx);
}

/**
 * Copy a pack's metrics into the profile's tracked set, and return the keys added.
 *
 * The tracked set is MATERIALISED rather than derived from the profile's enabled packs,
 * because the user owns it. If it were a view over `pack_metric`, turning a pack off
 * later would delete metrics she has been recording for months, and adding a metric a
 * pack does not list would be impossible.
 *
 * The same ownership is why an existing row is left completely alone (INSERT OR IGNORE
 * semantics) instead of being re-enabled: a metric she deliberately untracked must not
 * come back just because a pack that mentions it was switched on again.
 */
export async function materialiseMetricsForPack(
  profileId: string,
  packKey: string,
  tx?: Tx,
): Promise<string[]> {
  return inTransaction(async (t) => {
    const missing = await queryAll<{ metric_key: string }>(
      `SELECT pm.metric_key AS metric_key
         FROM pack_metric pm
         JOIN metric_def d ON d.key = pm.metric_key
         LEFT JOIN profile_metric existing
                ON existing.profile_id = ? AND existing.metric_key = pm.metric_key
        WHERE pm.pack_key = ? AND existing.metric_key IS NULL
        ORDER BY d.sort_order, d.key;`,
      [profileId, packKey],
      t,
    );
    if (missing.length === 0) return [];

    let sortOrder = await nextSortOrder(t, profileId);
    const added: string[] = [];
    for (const row of missing) {
      await createRecord(
        'profile_metric',
        {
          profile_id: profileId,
          metric_key: row.metric_key,
          enabled: boolToInt(true),
          sort_order: sortOrder,
        },
        t,
        { orIgnore: true },
      );
      sortOrder += 1;
      added.push(row.metric_key);
    }
    return added;
  }, tx);
}
