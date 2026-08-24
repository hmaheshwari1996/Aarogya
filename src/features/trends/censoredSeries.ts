/**
 * Deciding what a chart may draw for a reading the meter refused to number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT FOUR LINES INSIDE `trends.tsx`
 *
 * The rule it encodes is the one that was got wrong: `readings.filter(r => r.v1 !== null)`
 * looks like tidying and is actually a deletion. Every LO and HI vanished from the Trends
 * screen, and — worse — the screen then reported "No blood sugar recorded yet" over a
 * period in which she had recorded a hypoglycaemic episode. Nothing about that filter
 * announced itself, and nothing could test it: it lived in a `.tsx` file that the Node
 * type-stripping runner cannot load at all.
 *
 * So the decision lives here, in a file with no imports, no JSX and no chart library, and
 * `./censoredSeries.test.ts` holds it to the three properties that matter:
 *
 *   1. NOTHING IS SILENTLY DROPPED. Every reading comes back in one of three buckets, and
 *      the buckets add up to the input. A caller that renders only `entries` still has
 *      `undrawable` in hand and cannot claim the period was empty.
 *   2. A BOUND IS NEVER A VALUE. A censored entry carries `direction` and is typed apart
 *      from a measured one, so the two cannot be summed, averaged or joined by accident —
 *      the type system refuses before a reviewer has to notice.
 *   3. ORDER IS PRESERVED. These charts plot by position, not by date, so a reading
 *      removed from the middle silently renumbers everything after it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The minimum of a `Reading` this module needs. Kept structural so tests need no fixture. */
export type CensorableReading = {
  v1: number | null;
  valueQualifier: 'exact' | 'below_range' | 'above_range';
  qualifierBound: number | null;
};

export type SeriesEntry<T> =
  | { kind: 'measured'; value: number; reading: T }
  | {
      /**
       * The meter said the true value lies past `value`, and `value` is the limit of what
       * it can read. It is a position on the axis, not a measurement, and every renderer
       * has to mark it as visibly different from a point.
       */
      kind: 'censored';
      value: number;
      direction: 'below' | 'above';
      reading: T;
    };

export type SeriesPlan<T> = {
  /** Everything that can be drawn, in input order. */
  entries: SeriesEntry<T>[];
  /** How many of `entries` are real measurements. */
  measuredCount: number;
  /** How many of `entries` are LO/HI marks drawn at a meter limit. */
  censoredCount: number;
  /**
   * LO/HI readings that cannot be drawn at all, because no meter range was ever recorded
   * with them and there is therefore no honest position for them on the axis.
   *
   * This number is why the caller must never gate an empty state on `entries.length`.
   * A period containing nothing but these has a chart with no marks on it AND a real
   * record behind it, and the screen has to say the second thing.
   */
  undrawableCount: number;
  /** Every number that must fit on the value axis, measurements and limits alike. */
  scaleValues: number[];
};

/** A bound is only usable when it is a real, finite, positive number. */
function usable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function planSeries<T extends CensorableReading>(readings: readonly T[]): SeriesPlan<T> {
  const entries: SeriesEntry<T>[] = [];
  const scaleValues: number[] = [];
  let measuredCount = 0;
  let censoredCount = 0;
  let undrawableCount = 0;

  for (const reading of readings) {
    if (reading.valueQualifier === 'exact') {
      // A qualifier of 'exact' with no number is not a censored reading — it is a row
      // that holds nothing for this field, which is what a blood pressure with no pulse
      // looks like. Nothing to draw and nothing to declare.
      if (!Number.isFinite(reading.v1 ?? Number.NaN)) continue;
      const value = reading.v1 as number;
      entries.push({ kind: 'measured', value, reading });
      scaleValues.push(value);
      measuredCount += 1;
      continue;
    }

    if (!usable(reading.qualifierBound)) {
      undrawableCount += 1;
      continue;
    }

    entries.push({
      kind: 'censored',
      value: reading.qualifierBound,
      direction: reading.valueQualifier === 'below_range' ? 'below' : 'above',
      reading,
    });
    scaleValues.push(reading.qualifierBound);
    censoredCount += 1;
  }

  return { entries, measuredCount, censoredCount, undrawableCount, scaleValues };
}

/**
 * Trim a plan to a drawing budget WITHOUT letting a LO or a HI be the thing that is
 * dropped.
 *
 * The screen caps every series at ninety marks, because ninety is roughly what a 200dp
 * chart can separate — and above that it subsamples evenly. Run that subsample across the
 * whole list and a woman testing twice a day for three months has a one-in-two chance of
 * her single hypoglycaemic reading being the one thrown away, silently, by a function
 * whose job was to keep the chart legible.
 *
 * So the measurements are subsampled and the censored marks are not. There are never many
 * of the latter — if there were, the chart is not the problem — and each one is the
 * loudest thing in the period. `subsample` is passed in rather than reimplemented so this
 * module and the screen cannot drift into two different ideas of "evenly".
 */
export function capPlan<T>(
  plan: SeriesPlan<T>,
  max: number,
  subsample: (items: readonly SeriesEntry<T>[], max: number) => SeriesEntry<T>[],
): SeriesPlan<T> {
  if (plan.entries.length <= max) return plan;

  const censored = plan.entries.filter((entry) => entry.kind === 'censored');
  const measured = plan.entries.filter((entry) => entry.kind === 'measured');
  // At least one measurement survives even in the pathological case where the censored
  // marks alone exceed the budget: a chart of nothing but limits is worse than a crowded
  // one, and the caption reports the true counts either way.
  const budget = Math.max(1, max - censored.length);
  const kept = new Set(subsample(measured, budget));

  const entries = plan.entries.filter((entry) => entry.kind === 'censored' || kept.has(entry));
  return {
    ...plan,
    entries,
    measuredCount: entries.filter((entry) => entry.kind === 'measured').length,
    scaleValues: entries.map((entry) => entry.value),
  };
}

/**
 * The distinct meter limits a plan drew at, in the order they were met.
 *
 * More than one is not a bug: a period spanning a change of meter legitimately carries
 * two, and each reading keeps the limit that was in force on the day it was taken.
 */
export function planBounds<T>(plan: SeriesPlan<T>): number[] {
  const out: number[] = [];
  for (const entry of plan.entries) {
    if (entry.kind !== 'censored') continue;
    if (!out.includes(entry.value)) out.push(entry.value);
  }
  return out;
}
