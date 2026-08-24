/**
 * Turning the record into chart specs.
 *
 * This is where the target rules are actually applied, so read them here rather than
 * inferring them from the drawing code:
 *
 *  • A point is marked out-of-range ONLY when a `target_range` row exists for that
 *    metric AND that field AND that reading's context. No row, no mark. There is no
 *    fallback table of "normal" values anywhere in this app and there must never be one.
 *
 *  • Context matching is EXACT JSON-string equality, exactly as `getTargetsForMetric`
 *    does it, with a null-context row acting as the fallback. "Fasting 80–130,
 *    everything else 80–180" therefore resolves the same way on the chart as it does in
 *    the database, and a "close enough" match — a fasting band applied to a post-meal
 *    sugar — is a wrong line drawn under a real decision.
 *
 *  • ONE band per chart, for the metric's primary field. A blood pressure chart carries
 *    a systolic band; the diastolic target still governs that series' hollow markers and
 *    is printed in full in the appendix. Two overlapping shaded regions on one axis are
 *    unreadable in greyscale, which is the only way this page will ever be seen.
 *
 *  • A LO/HI READING IS PLOTTED AT THE METER'S LIMIT, AS A CHEVRON, NEVER AS A POINT.
 *    This file used to drop every non-exact reading before the series was built, so a
 *    hypoglycaemic episode was absent from the one chart a doctor is handed — and where
 *    a period contained only LO/HI readings, the chart said "no readings recorded". A LO
 *    is not a missing value; it is the inequality `v < 20 mg/dL`, and it is drawn as one.
 *    It is excluded from the line, excluded from the point count, and never given the
 *    hollow out-of-target treatment. A censored reading with no recorded meter range has
 *    no honest position and is still not drawn — but it is counted and named in words.
 *    See `../data/censored.ts` for the arithmetic of what may be said about one.
 */

import { formatDate, formatNumber } from '../lib/format';
import { svgToDataUri } from '../lib/base64';
import type { ReportMetric, ReportReading, ReportTarget } from '../data/types';
import { censoredDirection, usableBound } from '../data/censored';
import {
  renderEmptyChartSvg,
  renderSeriesChartSvg,
  type CensoredPoint,
  type ChartBand,
  type ChartPoint,
  type ChartSeries,
  type ChartSpec,
} from './seriesChart';
import type { MarkerShape } from './svg';

export { renderSeriesChartSvg, renderEmptyChartSvg } from './seriesChart';
export type { ChartSpec, ChartSeries, ChartPoint, ChartBand, CensoredPoint } from './seriesChart';
export { INK } from './svg';

/** Field order decides marker shape, so systolic is always the circle on every page. */
const SHAPES: readonly MarkerShape[] = ['circle', 'square', 'triangle', 'diamond'];

export type BuiltChart = {
  metricKey: string;
  title: string;
  /** The raw SVG document. */
  svg: string;
  /** The same document as a `data:` URI — no network reference of any kind. */
  dataUri: string;
  /** How many readings the chart is drawn from. Zero means the placeholder was used. */
  pointCount: number;
  /**
   * The band's attribution as PLAIN TEXT, or null when no target exists.
   *
   * It is drawn inside the chart AND returned here so the page can repeat it as real
   * HTML. The chart is an inlined image: its words are pixels, so they are invisible to
   * a screen reader, unsearchable in the PDF, and gone entirely if the image fails to
   * decode. The one line on the page that must survive all three is the one naming who
   * set the threshold a reader is about to judge these numbers against.
   */
  bandLegend: string | null;
  /**
   * LO/HI readings that could not be drawn because no meter range was ever recorded for
   * that metric, so there is no honest y for them.
   *
   * This used to mean "every LO/HI reading", which is why the caption it feeds says they
   * are listed rather than plotted. Once a meter range exists they ARE plotted, and this
   * drops to zero — which is the one thing that makes filling the range in worth doing.
   */
  offScaleCount: number;
  /** LO/HI readings actually drawn, as chevrons at the meter's limit. */
  censoredCount: number;
};

function contextKey(context: Record<string, string> | null | undefined): string {
  return context === null || context === undefined ? 'null' : JSON.stringify(context);
}

/**
 * The target that applies to one reading, for one field.
 *
 * Context-specific rows win over the null-context fallback, which is the same preference
 * the repository encodes in its ORDER BY.
 */
export function resolveTarget(
  targets: readonly ReportTarget[],
  metricKey: string,
  field: 'v1' | 'v2' | 'v3',
  context: Record<string, string> | null,
): ReportTarget | null {
  const candidates = targets.filter((t) => t.metricKey === metricKey && t.field === field);
  const wanted = contextKey(context);
  return (
    candidates.find((t) => contextKey(t.context) === wanted) ??
    candidates.find((t) => t.context === null) ??
    null
  );
}

/**
 * PURE. True only when a band exists and the value falls outside it.
 *
 * A MEASUREMENT ONLY. A censored reading has no `value` to pass here, and it must not be
 * given one: substituting the meter's limit and comparing that would count a LO as
 * "inside" whenever the meter's floor happens to sit inside the target, which is the
 * cheerful direction to be wrong in. `censoredVsTarget` in `../data/censored.ts` decides
 * that case, and it returns 'undecidable' rather than a guess — which is also why the
 * chevron never takes the hollow treatment: the app cannot always tell, and a mark that
 * silently means two different things is worse than a mark that means one.
 */
export function isOutsideTarget(value: number, target: ReportTarget | null): boolean {
  if (!target) return false;
  if (target.low !== null && value < target.low) return true;
  if (target.high !== null && value > target.high) return true;
  return false;
}

/** 'Target 80–130 mg/dL (upper number), set by Dr Rao on 12 Jul 2026'. */
export function bandLegend(target: ReportTarget, unit: string, fieldLabel: string): string {
  const low = target.low !== null ? formatNumber(target.low) : null;
  const high = target.high !== null ? formatNumber(target.high) : null;
  const range =
    low !== null && high !== null
      ? `${low}–${high}`
      : low !== null
        ? `${low} and above`
        : high !== null
          ? `up to ${high}`
          : '';
  const unitPart = unit ? ` ${unit}` : '';
  return `Target ${range}${unitPart} (${fieldLabel}), set by ${target.setByLabel} on ${formatDate(target.setOn)}`;
}

export type BuildChartInput = {
  metric: ReportMetric;
  readings: readonly ReportReading[];
  targets: readonly ReportTarget[];
  fromDate: string;
  toDate: string;
  /** Bare vertical rules on the date axis. Unannotated, by schema policy. */
  changeMarkers: readonly string[];
  width?: number;
  height?: number;
};

export function buildMetricChart(input: BuildChartInput): BuiltChart {
  const { metric, targets, fromDate, toDate } = input;
  const readings = input.readings
    .filter((r) => r.metricKey === metric.key)
    .slice()
    .sort((a, b) => a.atEpoch - b.atEpoch);

  const measured = readings.filter((r) => r.qualifier === 'exact');
  // A censored reading is drawable only where a meter range was recorded with it. The
  // rest are counted so the page can say how many are not on the chart.
  const censoredReadings = readings.filter((r) => r.qualifier !== 'exact');
  const drawableCensored = censoredReadings.filter((r) => usableBound(r.qualifierBound));
  const offScaleCount = censoredReadings.length - drawableCensored.length;

  const series: ChartSeries[] = [];
  metric.fields.forEach((field, index) => {
    const points: ChartPoint[] = [];
    for (const reading of measured) {
      const value = reading.fields.find((f) => f.slot === field.slot)?.value;
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      const target = resolveTarget(targets, metric.key, field.slot, reading.context);
      points.push({
        localDate: reading.localDate,
        localTime: reading.localTime,
        value,
        outOfTarget: isOutsideTarget(value, target),
      });
    }

    // A meter prints ONE word for the whole reading, so the inequality belongs to the
    // metric's primary field — a blood pressure cuff has no way to say "the lower number
    // was below range". Attaching it to every field would draw one event as two or three.
    const censored: CensoredPoint[] =
      field.slot === metric.primaryField
        ? drawableCensored.flatMap((reading) => {
            const direction = censoredDirection(reading.qualifier);
            if (!direction || !usableBound(reading.qualifierBound)) return [];
            return [
              {
                localDate: reading.localDate,
                localTime: reading.localTime,
                bound: reading.qualifierBound,
                direction,
              },
            ];
          })
        : [];

    if (points.length === 0 && censored.length === 0) return;
    series.push({
      label: field.label,
      shape: SHAPES[index % SHAPES.length] ?? 'circle',
      // A scatter metric is one whose points are not comparable in sequence — a glucose
      // measured fasting on Monday and after lunch on Tuesday. Joining them draws a
      // trend that does not exist.
      connect: metric.chartKind === 'line',
      points,
      censored,
    });
  });

  // The point count is MEASUREMENTS ONLY. It decides whether a chart can be drawn at all
  // and it is reported to the page; a chevron is not a measurement and must not inflate
  // it. `censoredCount` is carried separately for the same reason.
  const pointCount = series.reduce((total, s) => total + s.points.length, 0);
  const censoredCount = series.reduce((total, s) => total + (s.censored?.length ?? 0), 0);
  const title = metric.label;

  // Distinct bounds, in the order they were met. Two only happen when the meter changed
  // mid-period, which is exactly when a single line would be wrong.
  const meterBounds: { value: number; direction: 'below' | 'above' }[] = [];
  for (const s of series) {
    for (const point of s.censored ?? []) {
      if (!meterBounds.some((b) => b.value === point.bound && b.direction === point.direction)) {
        meterBounds.push({ value: point.bound, direction: point.direction });
      }
    }
  }

  if (pointCount === 0 && censoredCount === 0) {
    const message =
      readings.length > 0
        ? 'Readings in this period were LO/HI on the meter and its range is not recorded — see the table'
        : 'No readings recorded in this period';
    const svg = renderEmptyChartSvg(title, message, input.width);
    return {
      metricKey: metric.key,
      title,
      svg,
      dataUri: svgToDataUri(svg),
      pointCount: 0,
      bandLegend: null,
      offScaleCount,
      censoredCount: 0,
    };
  }

  // The band follows the PRIMARY field, and only when a real target row exists for it.
  const primaryField = metric.fields.find((f) => f.slot === metric.primaryField) ?? metric.fields[0];
  let band: ChartBand | null = null;
  if (primaryField) {
    const primaryTarget = resolveTarget(targets, metric.key, primaryField.slot, null);
    const anyTarget =
      primaryTarget ?? targets.find((t) => t.metricKey === metric.key && t.field === primaryField.slot) ?? null;
    if (anyTarget) {
      band = {
        low: anyTarget.low,
        high: anyTarget.high,
        legend: bandLegend(anyTarget, metric.unit, primaryField.label),
      };
    }
  }

  const spec: ChartSpec = {
    title,
    unit: metric.unit,
    fromDate,
    toDate,
    series,
    band,
    changeMarkers: input.changeMarkers,
    offScaleCount,
    meterBounds,
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  };

  const svg = renderSeriesChartSvg(spec);
  return {
    metricKey: metric.key,
    title,
    svg,
    dataUri: svgToDataUri(svg),
    pointCount,
    bandLegend: band?.legend ?? null,
    offScaleCount,
    censoredCount,
  };
}
