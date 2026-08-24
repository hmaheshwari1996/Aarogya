/**
 * The handful of SVG primitives the report charts are built from.
 *
 * WHY HAND-ROLLED SVG RATHER THAN A CHART LIBRARY: the OPD report has to build with no
 * network and no React tree. `react-native-gifted-charts` renders into a live view
 * hierarchy, which would mean mounting a component, waiting for it to draw and
 * screenshotting it — the same fragile capture path the day card needs and pays for. A
 * chart on the doctor's page is a string of coordinates; producing it as a string keeps
 * the report a pure function and keeps it printable at the printer's resolution instead
 * of the screen's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MONOCHROME AND COLOUR-BLIND SAFE, BY CONSTRUCTION
 *
 * Everything in this file is greyscale. OPD printers are black and white, roughly 8% of
 * men have red/green colour deficiency, and — the reason that outranks both — a red
 * number is a clinical verdict this app has no standing to render. Meaning is therefore
 * carried by SHAPE (circle, square, triangle, diamond), by FILL (solid vs hollow) and by
 * a WORD in the legend. Never by hue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { escapeHtml } from '../lib/html';

/** The greyscale the whole report draws in. */
export const INK = {
  /** Axis lines, markers, series strokes. */
  strong: '#111111',
  /** Tick labels, secondary text. */
  muted: '#444444',
  /** Grid lines. */
  grid: '#CCCCCC',
  /** The target band fill — light enough to print behind data without hiding it. */
  band: '#E8E8E8',
  /** Band edges and change markers. */
  bandEdge: '#8A8A8A',
  paper: '#FFFFFF',
} as const;

export const CHART_FONT = 'Helvetica, Arial, "Noto Sans", sans-serif';

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond';

function fmt(value: number): string {
  // Three decimals is far more than a 900px canvas can resolve, and it keeps the
  // document small enough that base64-inlining a page of charts stays cheap.
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0';
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  options: { stroke?: string; width?: number; dash?: string } = {},
): string {
  const dash = options.dash ? ` stroke-dasharray="${escapeHtml(options.dash)}"` : '';
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${
    options.stroke ?? INK.grid
  }" stroke-width="${options.width ?? 1}"${dash} />`;
}

export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  options: { fill?: string; stroke?: string; strokeWidth?: number; dash?: string } = {},
): string {
  const stroke = options.stroke ? ` stroke="${options.stroke}" stroke-width="${options.strokeWidth ?? 1}"` : '';
  const dash = options.dash ? ` stroke-dasharray="${escapeHtml(options.dash)}"` : '';
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.max(0, width))}" height="${fmt(
    Math.max(0, height),
  )}" fill="${options.fill ?? 'none'}"${stroke}${dash} />`;
}

export function text(
  x: number,
  y: number,
  content: string,
  options: {
    size?: number;
    anchor?: 'start' | 'middle' | 'end';
    fill?: string;
    weight?: 400 | 600 | 700;
  } = {},
): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-family="${CHART_FONT}" font-size="${
    options.size ?? 11
  }" font-weight="${options.weight ?? 400}" text-anchor="${options.anchor ?? 'start'}" fill="${
    options.fill ?? INK.muted
  }">${escapeHtml(content)}</text>`;
}

export function polyline(points: readonly { x: number; y: number }[], options: { width?: number } = {}): string {
  if (points.length < 2) return '';
  const path = points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
  return `<polyline points="${path}" fill="none" stroke="${INK.strong}" stroke-width="${
    options.width ?? 1.4
  }" stroke-linejoin="round" stroke-linecap="round" />`;
}

/**
 * One data point.
 *
 * `hollow` is the ONLY encoding of "outside the recorded target band", and it is only
 * ever set when a band exists. A solid marker therefore means "in range OR nothing to be
 * out of", which is exactly the claim the app is entitled to make.
 */
export function marker(
  x: number,
  y: number,
  shape: MarkerShape,
  options: { hollow?: boolean; size?: number } = {},
): string {
  const size = options.size ?? 4.2;
  const fill = options.hollow ? INK.paper : INK.strong;
  const strokeWidth = options.hollow ? 1.6 : 1;

  switch (shape) {
    case 'square':
      return `<rect x="${fmt(x - size)}" y="${fmt(y - size)}" width="${fmt(size * 2)}" height="${fmt(
        size * 2,
      )}" fill="${fill}" stroke="${INK.strong}" stroke-width="${strokeWidth}" />`;
    case 'triangle': {
      const h = size * 1.15;
      const path = `${fmt(x)},${fmt(y - h)} ${fmt(x + size)},${fmt(y + h * 0.7)} ${fmt(x - size)},${fmt(
        y + h * 0.7,
      )}`;
      return `<polygon points="${path}" fill="${fill}" stroke="${INK.strong}" stroke-width="${strokeWidth}" />`;
    }
    case 'diamond': {
      const path = `${fmt(x)},${fmt(y - size * 1.25)} ${fmt(x + size * 1.1)},${fmt(y)} ${fmt(x)},${fmt(
        y + size * 1.25,
      )} ${fmt(x - size * 1.1)},${fmt(y)}`;
      return `<polygon points="${path}" fill="${fill}" stroke="${INK.strong}" stroke-width="${strokeWidth}" />`;
    }
    case 'circle':
    default:
      return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(size)}" fill="${fill}" stroke="${
        INK.strong
      }" stroke-width="${strokeWidth}" />`;
  }
}

/**
 * A reading the meter refused to put a number on, drawn at the limit of its range.
 *
 * ─── WHY THIS IS NOT A FIFTH `MarkerShape` ───────────────────────────────────
 * The four shapes are spent on the four FIELDS of a metric, so that a censored systolic
 * can still be told from a censored diastolic. More importantly, a censored point is not
 * a fifth kind of measurement — it is not a measurement at all, and giving it a shape
 * from the same alphabet would file it alongside the numbers rather than apart from them.
 *
 * ─── WHY AN OPEN CHEVRON ─────────────────────────────────────────────────────
 * It is the limit-of-detection convention from analytical chemistry, and it is the one
 * mark on this page that cannot be read as a point: every marker above is a CLOSED shape,
 * filled or hollow. This is two strokes that do not close, pointing the way the true
 * value went. A reader who has never seen the legend still reads "it continued past
 * here", which is exactly what the meter said.
 *
 * It is deliberately NOT given the hollow treatment as well. A hollow arrow beside a
 * solid arrow at 4.2px, in greyscale, on a fax, is unreadable — and double-encoding one
 * mark with two meanings is the misreading the file header exists to prevent. Whether a
 * censored reading also sits outside a target is stated in WORDS or not at all.
 */
export function censoredMarker(
  x: number,
  y: number,
  direction: 'below' | 'above',
  options: { size?: number } = {},
): string {
  const size = options.size ?? 5;
  const tip = direction === 'below' ? y + size : y - size;
  const wing = direction === 'below' ? y - size * 0.6 : y + size * 0.6;
  return [
    `<polyline points="${fmt(x - size)},${fmt(wing)} ${fmt(x)},${fmt(tip)} ${fmt(x + size)},${fmt(wing)}"`,
    ` fill="none" stroke="${INK.strong}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />`,
  ].join('');
}

export function svgDocument(width: number, height: number, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" `,
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" role="img">`,
    rect(0, 0, width, height, { fill: INK.paper }),
    body,
    '</svg>',
  ].join('');
}
