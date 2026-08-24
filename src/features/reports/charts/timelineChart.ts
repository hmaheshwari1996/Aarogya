/**
 * The medication timeline: which drug was in force when, drawn on the same date axis as
 * the readings charts.
 *
 * This is the picture that answers the only question an OPD report exists to answer —
 * "what was she taking in March?" — and it is drawable at all only because `medicine` and
 * `dose_schedule` are append-only versioned on a shared `thread_id`. An app that edited a
 * dose in place could show today's regimen and nothing else.
 *
 * Change markers are TICKS ONLY. The schema comment on `med_change_event` is explicit
 * that these are never annotated and never explained; a caption reading "BP fell after
 * the dose changed" would be this app asserting causation it has no standing to assert.
 * The reader has the dates, the readings chart above it, and her own training.
 */

import { formatDateShort, parseLocalDate } from '../lib/format';
import { svgToDataUri } from '../lib/base64';
import type { ReportMedChange, ReportMedicine } from '../data/types';
import { addDaysUtc, dayIndex } from './seriesChart';
import { INK, line, rect, svgDocument, text } from './svg';

const WIDTH = 900;
const ROW_HEIGHT = 20;
const PAD = { top: 26, right: 18, bottom: 34, left: 190 } as const;

export type TimelineInput = {
  medicines: readonly ReportMedicine[];
  changes: readonly ReportMedChange[];
  fromDate: string;
  toDate: string;
};

export type BuiltTimeline = { svg: string; dataUri: string; rowCount: number };

export function buildMedicationTimeline(input: TimelineInput): BuiltTimeline {
  const rows = input.medicines
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 24); // beyond this the rows are thinner than the type and stop informing

  const height = PAD.top + PAD.bottom + Math.max(1, rows.length) * ROW_HEIGHT;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const spanDays = Math.max(1, dayIndex(input.fromDate, input.toDate) ?? 1);

  const xFor = (localDate: string): number => {
    const index = dayIndex(input.fromDate, localDate) ?? 0;
    const clamped = Math.min(Math.max(index, 0), spanDays);
    return PAD.left + (clamped / spanDays) * plotWidth;
  };

  const parts: string[] = [];
  parts.push(text(8, 16, 'Medicines in force during this period', { size: 13, weight: 700, fill: INK.strong }));

  // Date gridlines, at most seven, so the eye can place a bar without counting.
  const labelCount = Math.min(7, spanDays + 1);
  for (let i = 0; i < labelCount; i += 1) {
    const dayOffset = labelCount === 1 ? 0 : Math.round((i * spanDays) / (labelCount - 1));
    const x = PAD.left + (dayOffset / spanDays) * plotWidth;
    parts.push(line(x, PAD.top - 6, x, height - PAD.bottom + 4, { stroke: INK.grid }));
    parts.push(
      text(x, height - PAD.bottom + 18, formatDateShort(addDaysUtc(input.fromDate, dayOffset)), {
        anchor: 'middle',
        size: 10,
      }),
    );
  }

  if (rows.length === 0) {
    parts.push(text(PAD.left, PAD.top + 14, 'No medicines recorded for this period', { size: 11 }));
    const empty = svgDocument(WIDTH, height, parts.join(''));
    return { svg: empty, dataUri: svgToDataUri(empty), rowCount: 0 };
  }

  const changesByThread = new Map<string, ReportMedChange[]>();
  for (const change of input.changes) {
    if (!change.threadId) continue;
    const list = changesByThread.get(change.threadId) ?? [];
    list.push(change);
    changesByThread.set(change.threadId, list);
  }

  rows.forEach((medicine, index) => {
    const y = PAD.top + index * ROW_HEIGHT;
    const label = medicine.strength ? `${medicine.name} ${medicine.strength}` : medicine.name;
    parts.push(text(8, y + 12, truncate(label, 30), { size: 10, fill: INK.strong }));

    // A medicine with no started_on is one whose start date nobody recorded. Clamping it
    // to the window start would invent a date; the bar simply begins where the page does
    // and the appendix table still shows the column as blank.
    const start = clampDate(medicine.startedOn ?? input.fromDate, input.fromDate, input.toDate);
    const end = clampDate(medicine.stoppedOn ?? input.toDate, input.fromDate, input.toDate);
    if (end < start) return;

    const x1 = xFor(start);
    const x2 = xFor(end);
    const barY = y + 4;
    const stopped = medicine.status === 'stopped';

    // Stopped courses are hollow, in-force courses solid — shape and fill, never colour.
    parts.push(
      rect(x1, barY, Math.max(2, x2 - x1), 10, {
        fill: stopped ? INK.paper : INK.strong,
        stroke: INK.strong,
        strokeWidth: 1,
        ...(stopped ? { dash: '3 2' } : {}),
      }),
    );

    for (const change of changesByThread.get(medicine.threadId) ?? []) {
      const x = xFor(clampDate(change.localDate, input.fromDate, input.toDate));
      parts.push(line(x, barY - 3, x, barY + 13, { stroke: INK.strong, width: 1.4 }));
    }
  });

  parts.push(
    text(PAD.left, height - 6, 'Solid bar: in force.  Dashed bar: stopped.  Vertical tick: a recorded change.', {
      size: 9,
    }),
  );

  const svg = svgDocument(WIDTH, height, parts.join(''));
  return { svg, dataUri: svgToDataUri(svg), rowCount: rows.length };
}

function clampDate(localDate: string, fromDate: string, toDate: string): string {
  if (!parseLocalDate(localDate)) return fromDate;
  if (localDate < fromDate) return fromDate;
  if (localDate > toDate) return toDate;
  return localDate;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
