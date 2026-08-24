/**
 * The wall chart: an A4 month grid that is ticked by hand, with a pen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PAPER ARTEFACT IS PART OF A SOFTWARE PRODUCT
 *
 *  • Paper is the ultimate offline fallback. It works when the battery is flat, when the
 *    phone is with the son who took it to work, when the OEM has killed the alarm
 *    process, and after the app is uninstalled.
 *
 *  • It is the thing an elderly patient actually trusts. A tick she made herself, on a
 *    sheet on the wall by the medicine box, is evidence she can see. A percentage on a
 *    screen is a claim by a machine she did not ask for opinions from.
 *
 *  • It CAPTURES DOSES THE APP CANNOT SEE — the days the phone was dead, the week she was
 *    at her daughter's. Those are exactly the days that become a run of no-record days and
 *    suppress the adherence figure, and the chart is how they get back into the record:
 *    she brings it, and the days are backfilled through the catch-up flow.
 *
 * Landscape A4, and the month is split into two halves of about sixteen days. A single
 * 31-column grid gives each day roughly 7mm, which is narrower than the handwriting of
 * the person this is printed for. Splitting doubles it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BILINGUAL BY CONSTRUCTION, unlike the OPD report. This sheet lives in a house, not in a
 * consulting room: the caller passes the labels in the user's own language and the English
 * default is printed underneath in small type, so a visiting nurse or a doctor can also
 * read it. Where the caller passes English, the duplicate line is suppressed.
 */

import { formatDate, formatMonthYear, formatWeekdayShort, parseLocalDate } from '../lib/format';
import { escapeHtml } from '../lib/html';

export type WallChartMedicineRow = {
  name: string;
  strength: string | null;
  /** Wall-clock 'HH:MM' times, one box per time per day. */
  times: string[];
};

export type WallChartMeasurementRow = {
  label: string;
  unit: string;
};

export type WallChartLabels = {
  title: string;
  instructionsTicks: string;
  instructionsNumbers: string;
  medicineColumn: string;
  measurementColumn: string;
  broughtBack: string;
  patient: string;
};

const DEFAULT_LABELS: WallChartLabels = {
  title: 'Medicine chart',
  instructionsTicks: 'Put a tick in the box each time you take the medicine.',
  instructionsNumbers: 'Write the number you measured in the box.',
  medicineColumn: 'Medicine and time',
  measurementColumn: 'Measurement',
  broughtBack: 'Bring this sheet with you. The ticks can be entered into the app afterwards.',
  patient: 'Name',
};

export type WallChartInput = {
  patientName: string;
  /** Any date inside the month to chart, 'YYYY-MM-DD'. */
  month: string;
  medicines: readonly WallChartMedicineRow[];
  /** Blank rows to write measurements into. Defaults to blood pressure and blood sugar. */
  measurements?: readonly WallChartMeasurementRow[];
  /** Pass translated strings for a bilingual sheet. English is printed underneath. */
  labels?: Partial<WallChartLabels>;
};

const DEFAULT_MEASUREMENTS: WallChartMeasurementRow[] = [
  { label: 'Blood pressure', unit: 'mmHg' },
  { label: 'Blood sugar', unit: 'mg/dL' },
  { label: 'Weight', unit: 'kg' },
];

/** How many days in the month containing this date. */
export function daysInMonth(localDate: string): number {
  const parts = parseLocalDate(localDate);
  if (!parts) return 31;
  return new Date(parts.year, parts.month, 0).getDate();
}

function dateInMonth(localDate: string, day: number): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The caller's language on top, English underneath — unless they are the same string. */
function bilingual(primary: string, fallback: string, className = ''): string {
  const cls = className ? ` class="${escapeHtml(className)}"` : '';
  if (primary === fallback) return `<span${cls}>${escapeHtml(primary)}</span>`;
  return `<span${cls}>${escapeHtml(primary)}<span class="en">${escapeHtml(fallback)}</span></span>`;
}

export function buildWallChartHtml(input: WallChartInput): string {
  const labels: WallChartLabels = { ...DEFAULT_LABELS, ...input.labels };
  const measurements = input.measurements ?? DEFAULT_MEASUREMENTS;
  const total = daysInMonth(input.month);
  const half = Math.ceil(total / 2);

  const blocks = [
    renderBlock(input, labels, measurements, 1, half),
    renderBlock(input, labels, measurements, half + 1, total),
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(`${labels.title} — ${formatMonthYear(input.month)}`)}</title>`,
    `<style>${WALL_CHART_CSS}</style>`,
    '</head>',
    '<body>',
    '<header class="head">',
    `<div class="head__title">${bilingual(labels.title, DEFAULT_LABELS.title, 'title')}</div>`,
    `<div class="head__month">${escapeHtml(formatMonthYear(input.month))}</div>`,
    '</header>',
    '<div class="who">',
    `<span>${bilingual(labels.patient, DEFAULT_LABELS.patient)}: <strong>${escapeHtml(
      input.patientName,
    )}</strong></span>`,
    '</div>',
    '<p class="instructions">',
    bilingual(labels.instructionsTicks, DEFAULT_LABELS.instructionsTicks),
    ' ',
    bilingual(labels.instructionsNumbers, DEFAULT_LABELS.instructionsNumbers),
    '</p>',
    blocks,
    `<p class="footer">${bilingual(labels.broughtBack, DEFAULT_LABELS.broughtBack)}</p>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function renderBlock(
  input: WallChartInput,
  labels: WallChartLabels,
  measurements: readonly WallChartMeasurementRow[],
  firstDay: number,
  lastDay: number,
): string {
  const days: number[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) days.push(day);
  if (days.length === 0) return '';

  const firstDate = dateInMonth(input.month, firstDay);
  const lastDate = dateInMonth(input.month, lastDay);

  const headerNumbers = days.map((day) => `<th>${day}</th>`).join('');
  const headerWeekdays = days
    .map((day) => `<th class="wd">${escapeHtml(formatWeekdayShort(dateInMonth(input.month, day)).slice(0, 1))}</th>`)
    .join('');

  const medicineRows = input.medicines
    .flatMap((medicine) => {
      const times = medicine.times.length > 0 ? medicine.times : [''];
      return times.map((time, index) => {
        const name = medicine.strength ? `${medicine.name} ${medicine.strength}` : medicine.name;
        const label = index === 0 ? escapeHtml(name) : '<span class="cont">↳</span>';
        const timeLabel = time ? `<span class="time">${escapeHtml(time)}</span>` : '';
        const boxes = days.map(() => '<td class="tick"></td>').join('');
        return `<tr><th class="row-head">${label} ${timeLabel}</th>${boxes}</tr>`;
      });
    })
    .join('');

  const measurementRows = measurements
    .map((measurement) => {
      const boxes = days.map(() => '<td class="write"></td>').join('');
      return `<tr class="measure"><th class="row-head">${escapeHtml(measurement.label)} <span class="time">${escapeHtml(
        measurement.unit,
      )}</span></th>${boxes}</tr>`;
    })
    .join('');

  const emptyMedicineNote =
    input.medicines.length === 0
      ? `<tr><th class="row-head"><span class="cont">—</span></th>${days
          .map(() => '<td class="tick"></td>')
          .join('')}</tr>`
      : '';

  return [
    '<section class="block">',
    `<div class="block__range">${escapeHtml(`${formatDate(firstDate)} – ${formatDate(lastDate)}`)}</div>`,
    '<table>',
    '<thead>',
    `<tr><th class="row-head">${bilingual(labels.medicineColumn, DEFAULT_LABELS.medicineColumn)}</th>${headerNumbers}</tr>`,
    `<tr><th class="row-head sub">${bilingual(
      labels.measurementColumn,
      DEFAULT_LABELS.measurementColumn,
    )}</th>${headerWeekdays}</tr>`,
    '</thead>',
    '<tbody>',
    medicineRows,
    emptyMedicineNote,
    measurementRows,
    '</tbody>',
    '</table>',
    '</section>',
  ].join('\n');
}

/**
 * Landscape, and 10mm margins rather than the report's 12mm — every millimetre bought
 * here goes into the width of a box someone has to write inside.
 *
 * Same rule as the OPD report: `@page` owns the geometry, so `printToFileAsync` is called
 * with NO width or height. See `../opd/css.ts` for why the two must never both be set.
 */
const WALL_CHART_CSS = `
@page { size: A4 landscape; margin: 10mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Noto Sans", Roboto, Helvetica, Arial, sans-serif; color: #111; font-size: 10pt; }

.head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 2pt; }
.head__title .title { font-size: 16pt; font-weight: 700; }
.head__month { font-size: 13pt; font-weight: 700; }
.en { display: block; font-size: 7.5pt; font-weight: 400; color: #555; }
.who { margin: 4pt 0 2pt; font-size: 11pt; }
.instructions { margin: 0 0 6pt; font-size: 9pt; }

.block { break-inside: avoid; page-break-inside: avoid; margin-bottom: 8pt; }
.block__range { font-size: 9pt; font-weight: 700; margin-bottom: 2pt; }

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border: 1px solid #111; padding: 0; }
thead th { background: #EEE; font-size: 8pt; text-align: center; height: 12pt; }
thead th.wd { font-size: 7pt; font-weight: 400; color: #444; }

.row-head {
  width: 34%;
  text-align: left;
  padding: 2pt 4pt;
  font-size: 9pt;
  font-weight: 600;
  background: #FFF;
}
.row-head.sub { font-weight: 400; font-size: 8pt; }
.time { font-weight: 400; color: #444; font-size: 8pt; }
.cont { color: #777; }

/* A tick box has to be big enough for an unsteady hand. 16pt is about 5.6mm tall. */
td.tick { height: 16pt; background: #FFF; }
/* A number box needs more room than a tick, and a faint baseline to write on. */
tr.measure td.write { height: 22pt; background: #FCFCFC; }
tr.measure .row-head { background: #F4F4F4; }

.footer { margin-top: 6pt; font-size: 8.5pt; border-top: 1px solid #BBB; padding-top: 3pt; }
`.trim();

export { WALL_CHART_CSS };
