/**
 * The chart the doctor actually reads: a dated series with an optional target band.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TARGET RULE, WHICH IS THE WHOLE POINT OF THIS FILE
 *
 * A band is drawn ONLY when `spec.band` is present, and `spec.band` can only be built
 * from a `target_range` row — a threshold a NAMED HUMAN set on a NAMED DATE. The legend
 * prints that name and that date, every time, with no exception and no default.
 *
 * No target means: no band, no shaded region, no hollow markers, no "high"/"low" word
 * anywhere on the chart. The reader sees dated numbers and draws her own conclusion,
 * which is the only conclusion anyone here is qualified to draw.
 *
 * `spec.band.legend` is therefore REQUIRED and non-empty. An unattributed band is not a
 * slightly worse band; it is this app quietly issuing a clinical threshold under its own
 * name, on a page a physician may act on.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Out-of-range is a HOLLOW marker. Never red, never a different hue, never bold. See the
 * header of `./svg.ts` for why.
 */

import { formatDateShort, formatNumber, parseLocalDate } from '../lib/format';
import { censoredMarker, INK, line, marker, polyline, rect, svgDocument, text, type MarkerShape } from './svg';

export type ChartPoint = {
  localDate: string;
  localTime: string;
  value: number;
  /** Set only when a target band exists. Renders as a hollow marker. */
  outOfTarget: boolean;
};

/**
 * A reading whose meter printed LO or HI, drawn at the limit of that meter's range.
 *
 * `bound` is NOT a measurement and is never treated as one: it is excluded from the
 * polyline, drawn as an open chevron rather than a marker, and folded into the y-scale
 * only so the chevron lands inside the plot area instead of off the edge of it.
 *
 * A censored reading with no recorded meter range has no honest y and never reaches
 * here — `buildMetricChart` counts it and the page says so in words instead.
 */
export type CensoredPoint = {
  localDate: string;
  localTime: string;
  bound: number;
  direction: 'below' | 'above';
};

export type ChartSeries = {
  label: string;
  shape: MarkerShape;
  /** Whether consecutive points are joined. False for readings whose context differs. */
  connect: boolean;
  points: ChartPoint[];
  /**
   * LO/HI readings for this field. Kept in their own list rather than mixed into
   * `points` so that no future edit can accidentally join one into the line or count one
   * as a value: the two are different kinds of fact and the type says so.
   */
  censored?: CensoredPoint[];
};

export type ChartBand = {
  low: number | null;
  high: number | null;
  /** REQUIRED. Names the person and the date. See the file header. */
  legend: string;
};

export type ChartSpec = {
  title: string;
  unit: string;
  fromDate: string;
  toDate: string;
  series: ChartSeries[];
  /** Null when no target exists for this metric — which is the app's default state. */
  band: ChartBand | null;
  /**
   * Medicine changes, as bare vertical rules on the shared date axis. Never annotated
   * and never explained: putting "BP fell because the dose changed" beside one would be
   * the app making a causal claim it cannot support.
   */
  changeMarkers: readonly string[];
  /**
   * Readings whose meter printed LO/HI AND whose meter range was never recorded.
   *
   * These are the ones that still cannot be drawn: without a range there is no honest y
   * for them. They are counted here and named in the legend, because a reading that
   * cannot be plotted must not also be invisible.
   */
  offScaleCount?: number;
  /**
   * The meter limits that censored points were drawn at, for the dashed rules and the
   * legend. One entry per distinct bound — a period spanning a change of meter can
   * legitimately have two.
   */
  meterBounds?: readonly { value: number; direction: 'below' | 'above' }[];
  width?: number;
  height?: number;
};

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 300;
const PAD = { top: 26, right: 18, bottom: 56, left: 58 } as const;

/** Whole days between two 'YYYY-MM-DD' strings. UTC arithmetic — no DST to trip over. */
function dayIndex(fromDate: string, localDate: string): number | null {
  const from = parseLocalDate(fromDate);
  const at = parseLocalDate(localDate);
  if (!from || !at) return null;
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(at.year, at.month - 1, at.day);
  return Math.round((b - a) / 86_400_000);
}

type Scale = { min: number; max: number; ticks: number[] };

/**
 * A y-scale with round tick values.
 *
 * The band is folded into the domain before it is computed, so a target the readings
 * never approach still appears on the chart — a patient whose sugars sit far above the
 * band must be able to see the band.
 */
function buildScale(values: readonly number[], band: ChartBand | null): Scale {
  const all = [...values];
  if (band?.low !== null && band?.low !== undefined) all.push(band.low);
  if (band?.high !== null && band?.high !== undefined) all.push(band.high);

  if (all.length === 0) return { min: 0, max: 1, ticks: [0, 1] };

  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    // A single distinct value would collapse the axis to a line through the middle.
    min -= 1;
    max += 1;
  }
  const padding = (max - min) * 0.12;
  min -= padding;
  max += padding;

  const step = niceStep((max - min) / 4);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return { min: niceMin, max: niceMax, ticks };
}

function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const stepped = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return stepped * magnitude;
}

export function renderSeriesChartSvg(spec: ChartSpec): string {
  const width = spec.width ?? DEFAULT_WIDTH;
  const height = spec.height ?? DEFAULT_HEIGHT;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;

  const spanDays = Math.max(1, dayIndex(spec.fromDate, spec.toDate) ?? 1);
  // Meter limits go into the domain alongside the measurements. A chevron at 20 on a
  // chart scaled 90–250 would be drawn below the axis, where the reader cannot see the
  // one reading she most needs to — the same reasoning `buildScale` already applies to
  // the target band.
  const values = [
    ...spec.series.flatMap((s) => s.points.map((p) => p.value)),
    ...spec.series.flatMap((s) => (s.censored ?? []).map((c) => c.bound)),
  ];
  const scale = buildScale(values, spec.band);

  const xFor = (localDate: string): number | null => {
    const index = dayIndex(spec.fromDate, localDate);
    if (index === null) return null;
    const clamped = Math.min(Math.max(index, 0), spanDays);
    return PAD.left + (clamped / spanDays) * plotWidth;
  };
  const yFor = (value: number): number =>
    PAD.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight;

  const parts: string[] = [];

  parts.push(text(PAD.left, 16, `${spec.title}${spec.unit ? ` (${spec.unit})` : ''}`, {
    size: 13,
    weight: 700,
    fill: INK.strong,
  }));

  // ── Target band ────────────────────────────────────────────────────────────
  // Drawn first so every data point sits on top of it and nothing is obscured.
  if (spec.band) {
    const top = spec.band.high !== null ? yFor(spec.band.high) : PAD.top;
    const bottom = spec.band.low !== null ? yFor(spec.band.low) : PAD.top + plotHeight;
    parts.push(rect(PAD.left, Math.min(top, bottom), plotWidth, Math.abs(bottom - top), { fill: INK.band }));
    if (spec.band.high !== null) {
      parts.push(line(PAD.left, top, PAD.left + plotWidth, top, { stroke: INK.bandEdge, dash: '5 3' }));
    }
    if (spec.band.low !== null) {
      parts.push(line(PAD.left, bottom, PAD.left + plotWidth, bottom, { stroke: INK.bandEdge, dash: '5 3' }));
    }
  }

  // ── Grid and y axis ────────────────────────────────────────────────────────
  for (const tick of scale.ticks) {
    const y = yFor(tick);
    if (y < PAD.top - 0.5 || y > PAD.top + plotHeight + 0.5) continue;
    parts.push(line(PAD.left, y, PAD.left + plotWidth, y, { stroke: INK.grid }));
    parts.push(text(PAD.left - 8, y + 3.5, formatNumber(tick), { anchor: 'end', size: 10 }));
  }
  parts.push(line(PAD.left, PAD.top, PAD.left, PAD.top + plotHeight, { stroke: INK.strong }));
  parts.push(
    line(PAD.left, PAD.top + plotHeight, PAD.left + plotWidth, PAD.top + plotHeight, { stroke: INK.strong }),
  );

  // ── X axis ─────────────────────────────────────────────────────────────────
  // At most six labels, evenly spaced. More than that on a 900px canvas overlaps and
  // becomes unreadable exactly when the period is long enough to matter.
  const labelCount = Math.min(6, spanDays + 1);
  for (let i = 0; i < labelCount; i += 1) {
    const dayOffset = labelCount === 1 ? 0 : Math.round((i * spanDays) / (labelCount - 1));
    const x = PAD.left + (dayOffset / spanDays) * plotWidth;
    const at = addDaysUtc(spec.fromDate, dayOffset);
    parts.push(text(x, PAD.top + plotHeight + 16, formatDateShort(at), { anchor: 'middle', size: 10 }));
  }

  // ── Medicine-change markers ────────────────────────────────────────────────
  for (const markerDate of spec.changeMarkers) {
    const x = xFor(markerDate);
    if (x === null) continue;
    parts.push(line(x, PAD.top, x, PAD.top + plotHeight, { stroke: INK.bandEdge, dash: '2 4' }));
    parts.push(
      `<polygon points="${x},${PAD.top - 2} ${x + 4},${PAD.top - 9} ${x - 4},${PAD.top - 9}" fill="${
        INK.bandEdge
      }" />`,
    );
  }

  // ── Series ─────────────────────────────────────────────────────────────────
  for (const series of spec.series) {
    const placed = series.points
      .map((point) => {
        const x = xFor(point.localDate);
        return x === null ? null : { x, y: yFor(point.value), point };
      })
      .filter((p): p is { x: number; y: number; point: ChartPoint } => p !== null)
      .sort((a, b) => a.x - b.x);

    // The polyline is built from `placed` alone, and `placed` is built from `points`
    // alone. That is the structural guarantee that a censored reading is never joined
    // into the line: it is not in the array the line is drawn from.
    if (series.connect) parts.push(polyline(placed.map((p) => ({ x: p.x, y: p.y }))));
    for (const p of placed) {
      parts.push(marker(p.x, p.y, series.shape, { hollow: p.point.outOfTarget }));
    }

    for (const point of series.censored ?? []) {
      const x = xFor(point.localDate);
      if (x === null) continue;
      parts.push(censoredMarker(x, yFor(point.bound), point.direction));
    }
  }

  // ── Meter limits ───────────────────────────────────────────────────────────
  // Drawn AFTER the data so the label is not overprinted, and labelled in words that
  // cannot be mistaken for a target: a target says what someone is aiming for, this says
  // what the device can read. It is dashed like the band edge but carries no fill, and
  // the legend spells out the difference.
  for (const bound of spec.meterBounds ?? []) {
    const y = yFor(bound.value);
    if (y < PAD.top - 0.5 || y > PAD.top + plotHeight + 0.5) continue;
    parts.push(line(PAD.left, y, PAD.left + plotWidth, y, { stroke: INK.bandEdge, dash: '1 3' }));
    parts.push(
      text(PAD.left + plotWidth, y - 4, `meter's limit ${formatNumber(bound.value)}`, {
        anchor: 'end',
        size: 9,
      }),
    );
  }

  parts.push(renderLegend(spec, width, height));

  return svgDocument(width, height, parts.join(''));
}

function renderLegend(spec: ChartSpec, width: number, height: number): string {
  const parts: string[] = [];
  const baseline = height - 26;
  let x = PAD.left;

  for (const series of spec.series) {
    parts.push(marker(x + 5, baseline - 3.5, series.shape, { size: 4 }));
    parts.push(text(x + 14, baseline, series.label, { size: 10, fill: INK.strong }));
    x += 16 + series.label.length * 5.6 + 14;
  }

  if (spec.changeMarkers.length > 0) {
    parts.push(line(x + 5, baseline - 8, x + 5, baseline + 1, { stroke: INK.bandEdge, dash: '2 3' }));
    parts.push(text(x + 12, baseline, 'medicine change', { size: 10 }));
    x += 12 + 'medicine change'.length * 5.6 + 14;
  }

  // The chevron key. Without this line a reader sees a mark sitting at 20 and has no way
  // to know the meter never produced a 20 — which is the whole failure this drawing
  // exists to fix, reintroduced one legend line later.
  const censoredCount = spec.series.reduce((total, s) => total + (s.censored?.length ?? 0), 0);
  if (censoredCount > 0) {
    parts.push(censoredMarker(x + 5, baseline - 4, 'below', { size: 4 }));
    parts.push(
      text(x + 14, baseline, 'meter showed LO/HI — drawn at its limit, not measured', {
        size: 10,
        fill: INK.strong,
      }),
    );
  }

  // The band's attribution and the hollow-marker key are one unit: both exist only
  // because a target exists, and neither is meaningful without the other.
  const second = height - 10;
  if (spec.band) {
    parts.push(rect(PAD.left, second - 8, 14, 9, { fill: INK.band, stroke: INK.bandEdge, dash: '3 2' }));
    parts.push(text(PAD.left + 19, second, spec.band.legend, { size: 10, fill: INK.strong }));
    const bandLegendEnd = PAD.left + 19 + spec.band.legend.length * 5.4 + 16;
    parts.push(marker(bandLegendEnd + 4, second - 3.5, 'circle', { size: 4, hollow: true }));
    parts.push(text(bandLegendEnd + 13, second, 'outside that range', { size: 10 }));
  } else {
    // Said out loud rather than left blank. A doctor who sees no band is entitled to
    // know whether nobody set a target or the app simply failed to draw it.
    parts.push(text(PAD.left, second, 'No target range recorded. The app does not supply one.', { size: 10 }));
  }

  // What is left over: LO/HI readings with no recorded meter range, which have no honest
  // position on this axis. Named rather than dropped — "3 readings are not on this chart"
  // is a fact the reader needs before drawing any conclusion from what IS on it.
  const offScale = spec.offScaleCount ?? 0;
  if (offScale > 0) {
    parts.push(
      text(
        width - PAD.right,
        second,
        `${offScale} LO/HI reading${offScale === 1 ? '' : 's'} not drawn — meter's range not recorded; see the table`,
        { size: 10, anchor: 'end' },
      ),
    );
  }

  return parts.join('');
}

/** Date arithmetic in UTC so a DST boundary cannot shift a chart label by a day. */
function addDaysUtc(localDate: string, days: number): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  const at = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  at.setUTCDate(at.getUTCDate() + days);
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Kept exported so the appendix's date columns and the axis cannot drift apart. */
export { addDaysUtc, dayIndex };

/** A chart that could not be drawn says so, in the space the chart would have taken. */
export function renderEmptyChartSvg(title: string, message: string, width = DEFAULT_WIDTH, height = 120): string {
  return svgDocument(
    width,
    height,
    [
      text(PAD.left, 20, title, { size: 13, weight: 700, fill: INK.strong }),
      rect(PAD.left, 32, width - PAD.left - PAD.right, height - 48, { stroke: INK.grid, dash: '4 4' }),
      text(width / 2, height / 2 + 8, message, { anchor: 'middle', size: 11 }),
    ].join(''),
  );
}
