/**
 * Typed settings over `app_meta`.
 *
 * `app_meta` is a bare key/value table and `getMeta`/`setMeta` in
 * `src/app/_shared/lib.tsx` are the untyped door onto it. That is the right shape for a
 * boolean nobody else reads. It is the wrong shape for the two settings below, both of
 * which are read from more than one layer and one of which decides what a chart is
 * allowed to draw — so they get a name, a type, validation, and a comment saying what
 * they mean.
 *
 * Nothing here writes to `sync_outbox`. `app_meta` is not in TABLES and is deliberately
 * device-local: a meter is a thing on her table, and a developer toggle is a thing on the
 * phone being debugged. Neither belongs on a family member's handset.
 */

import { getDb, queryFirst, type Tx } from './_shared';
import { getMetricDef } from './metrics';

// ── Keys ─────────────────────────────────────────────────────────────────────
// Exported so a screen never retypes the literal. Two spellings of the same key is how
// a setting gets silently lost on the release that "tidied" one of them.

/** JSON: `Record<metricKey, InstrumentRange>`. */
export const META_INSTRUMENT_RANGES = 'instrument_ranges';
// The developer toggle's key is NOT declared here. It is `META_DEVLOG_ENABLED` in
// `src/features/devlog/store.ts`, next to the only function allowed to write it. See the
// note further down this file for what happened when there were two of them.

// ── Shapes ───────────────────────────────────────────────────────────────────

/**
 * The measuring range of the instrument the user actually owns.
 *
 * NOT a target and NOT a threshold: nothing compares a reading against this to produce a
 * verdict. It exists so that a meter which printed LO can be rendered as the inequality
 * it asserted (`< 20 mg/dL`) instead of vanishing.
 *
 * `low` and `high` are independently nullable because a person may know one end of her
 * meter's range and not the other, and half the answer is worth having: with only `low`
 * recorded, a LO prints as an inequality and a HI still prints as "the meter showed HI".
 *
 * `setByLabel` + `setOn` are the same provenance pair `target_range` carries, and for the
 * same reason — the printed report has to be able to say whose number this is and when
 * they wrote it down. The app never fills them in for her.
 */
export type InstrumentRange = {
  /** What the meter is, in her words or off the box. Printed alongside the range. */
  label: string;
  low: number | null;
  high: number | null;
  setByLabel: string;
  /** 'YYYY-MM-DD'. */
  setOn: string;
};

export type InstrumentRangeInput = {
  label: string;
  low?: number | null;
  high?: number | null;
  setByLabel: string;
  setOn: string;
};

type InstrumentRangeMap = Record<string, InstrumentRange>;

// ── Instrument ranges ────────────────────────────────────────────────────────

/**
 * The whole map, or `{}`. Never throws: a corrupt blob degrades to "no meter recorded",
 * which is a fully supported state, and a settings screen that crashed on it would be
 * worse than one that shows an empty picker.
 */
export async function getInstrumentRanges(tx?: Tx): Promise<InstrumentRangeMap> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [META_INSTRUMENT_RANGES],
    tx,
  );
  if (!row?.value) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as InstrumentRangeMap;
  } catch {
    return {};
  }
}

/** The range recorded for one metric, or null when the user has not recorded one. */
export async function getInstrumentRange(
  metricKey: string,
  tx?: Tx,
): Promise<InstrumentRange | null> {
  const ranges = await getInstrumentRanges(tx);
  return ranges[metricKey] ?? null;
}

/**
 * Record (or replace) the range for one metric.
 *
 * Validated against the metric's own instrument limits, because a range wider than what
 * the metric can hold would later place a chart arrow off the axis, and a range with the
 * ends swapped would print "below 600" for a LO. Both are typos, both are silent, and
 * both are cheap to refuse here.
 *
 * Read-modify-write on one JSON blob rather than a key per metric: the map is read on
 * every reading save, and one row beats N.
 */
export async function setInstrumentRange(
  metricKey: string,
  input: InstrumentRangeInput,
  tx?: Tx,
): Promise<void> {
  const label = input.label.trim();
  const setByLabel = input.setByLabel.trim();
  if (!label) throw new Error('setInstrumentRange: label is required');
  if (!setByLabel) {
    throw new Error('setInstrumentRange: setByLabel is required — a range with no name on it is unattributable');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.setOn)) {
    throw new Error(`setInstrumentRange: setOn must be 'YYYY-MM-DD', got ${input.setOn}`);
  }

  const low = input.low ?? null;
  const high = input.high ?? null;
  if (low === null && high === null) {
    throw new Error('setInstrumentRange: record at least one end of the range, or clear it instead');
  }

  const metric = await getMetricDef(metricKey, tx);
  if (!metric) throw new Error(`setInstrumentRange: unknown metric ${metricKey}`);
  const primary = metric.schema.fields.find((field) => field.slot === metric.schema.primaryField);
  if (!primary) throw new Error(`setInstrumentRange: ${metricKey} has no primary field`);

  for (const [name, value] of [
    ['low', low],
    ['high', high],
  ] as const) {
    if (value === null) continue;
    if (!Number.isFinite(value) || value < primary.min || value > primary.max) {
      throw new Error(
        `setInstrumentRange: ${name} of ${String(value)} is outside what ${metricKey} can hold ` +
          `(${primary.min}–${primary.max}).`,
      );
    }
  }
  if (low !== null && high !== null && low >= high) {
    throw new Error(`setInstrumentRange: low (${low}) must be below high (${high})`);
  }

  const ranges = await getInstrumentRanges(tx);
  ranges[metricKey] = { label, low, high, setByLabel, setOn: input.setOn };
  await writeRanges(ranges, tx);
}

/** Forget the meter. Readings already recorded keep the bound they were saved with. */
export async function clearInstrumentRange(metricKey: string, tx?: Tx): Promise<void> {
  const ranges = await getInstrumentRanges(tx);
  if (!(metricKey in ranges)) return;
  delete ranges[metricKey];
  await writeRanges(ranges, tx);
}

/**
 * The number a LO or HI is measured against, or null.
 *
 * This is the ONE place that turns a qualifier into a bound, so that "which end of the
 * range does below_range mean" is answered once rather than at every call site.
 */
export async function boundForQualifier(
  metricKey: string,
  qualifier: 'exact' | 'below_range' | 'above_range',
  tx?: Tx,
): Promise<number | null> {
  if (qualifier === 'exact') return null;
  const range = await getInstrumentRange(metricKey, tx);
  if (!range) return null;
  return qualifier === 'below_range' ? range.low : range.high;
}

async function writeRanges(ranges: InstrumentRangeMap, tx?: Tx): Promise<void> {
  const db = tx ? tx.db : await getDb();
  await db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [META_INSTRUMENT_RANGES, JSON.stringify(ranges)],
  );
}

// ── Developer mode — DELIBERATELY NOT HERE ───────────────────────────────────

/**
 * THE DEVELOPER TOGGLE LIVES IN `src/features/devlog/store.ts`. DO NOT ADD IT BACK HERE.
 *
 * This file briefly carried a second one: `META_DEVELOPER_MODE = 'developer_mode'` with a
 * `getDeveloperMode` / `setDeveloperMode` pair. It had no callers, and it was not harmless
 * dead code — it was a loaded gun pointing at the one guarantee report 7 rests on.
 *
 * TWO WAYS IT WOULD HAVE FIRED, both of which look like tidying up:
 *
 *  1. WRONG KEY. `store.ts` reads and writes `devlog_enabled`. A future Settings screen
 *     reaching for the obvious-looking repository function instead would have written
 *     `developer_mode`, which nothing reads. The switch would show ON, the menu would
 *     appear, and `record()` would keep returning on its first line — a debugging session
 *     spent reproducing a bug against a log that was never being written.
 *
 *  2. WRONG BEHAVIOUR. Its doc comment promised that turning the toggle off "does not
 *     delete what was already written". `setDevLogEnabled(false)` deletes the ring AND the
 *     file, on purpose: "if developer option is not enabled, we will not store the logs at
 *     all" has to survive being switched back off, or it only ever meant "not from now on".
 *     Two contradictory specifications for one user-facing switch is how the weaker one
 *     eventually wins.
 *
 * `setDevLogEnabled()` in `features/devlog/store.ts` is the ONLY way it can be flipped —
 * it sets the recorder's synchronous mirror before it writes the row, which is what makes
 * the mirror and the row incapable of disagreeing in the direction that matters. Anything
 * that needs to know the state calls `isDevLogEnabled()`.
 */
