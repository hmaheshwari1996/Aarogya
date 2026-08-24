/**
 * The one-page A4 a doctor reads in 45 seconds, plus an appendix she can read at leisure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF PAGE ONE IS THE PRODUCT
 *
 *   1. Who this is        — name, age, conditions, period, and what has moved since the
 *                           last visit. Four seconds.
 *   2. The reminder record — stated honestly, suppressed when it cannot be stated.
 *   3. The charts          — the shape of the numbers, with a target band ONLY if a named
 *                           human set one.
 *   4. Current medicines   — what she is actually on, with doses and times.
 *   5. Symptoms            — what she reported, and when.
 *   6. Labs                — values exactly as the paper printed them.
 *   7. Her questions       — the reason she came, in her own words.
 *
 * An OPD consultation in a government hospital can be four minutes long. Anything that
 * does not survive being read in the first forty-five seconds of it belongs in the
 * appendix, and page one is therefore a SUMMARY: it caps each section and says so, with
 * the complete record on the pages behind it and in the CSV export.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PURE. `buildOpdHtml(data)` is a function from a snapshot to a string — no database, no
 * clock, no network. Charts are rasterised into `data:` URIs by the chart layer before
 * they get here, so the document has no external reference of any kind and builds on a
 * phone in a village with no signal.
 *
 * ENGLISH ONLY, DELIBERATELY. The app's UI is bilingual; this page is not. It is written
 * in English so that any doctor at any OPD can read it, which is the same reason the
 * `report.*` translation keys carry English values in both language files.
 */

import { buildMetricChart } from '../charts';
import { buildMedicationTimeline } from '../charts/timelineChart';
import {
  ageFromYearOfBirth,
  formatDate,
  formatDateLong,
  formatDateRangeLong,
  formatEpochDateTime,
  formatNumber,
  formatSex,
  formatTime,
  plural,
} from '../lib/format';
import { cellText, escapeAttr, escapeHtml, joinHtml } from '../lib/html';
import { censoredUnitText, censoredValueText, inequalityText } from '../data/censored';
import type {
  OpdReportData,
  ReportDose,
  ReportLab,
  ReportMedicine,
  ReportMetric,
  ReportReading,
  ReportSymptom,
} from '../data/types';
import { renderAdherenceSection } from './adherenceSection';
import { opdPrintCss } from './css';
import { renderDoseCalendar } from './doseCalendar';

/**
 * What page one is allowed to show before it defers to the appendix.
 *
 * These are editorial limits, not technical ones. A page that spills onto a second sheet
 * has stopped being the thing a doctor scans while the patient is still sitting down.
 */
export type PageOneLimits = {
  charts: number;
  medicines: number;
  symptoms: number;
  labs: number;
  questions: number;
};

export const DEFAULT_PAGE_ONE_LIMITS: PageOneLimits = {
  charts: 2,
  medicines: 12,
  symptoms: 6,
  labs: 6,
  questions: 6,
};

/** The appendix is long, not infinite. Past this, the CSV export is the right tool. */
const APPENDIX_ROW_CAP = 400;

/** Her notes on page one, per symptom, newest first. The rest wait in the appendix. */
const SYMPTOM_NOTES_ON_PAGE_ONE = 2;

export type BuildOpdOptions = {
  limits?: Partial<PageOneLimits>;
  /** False produces page one alone — the "just the summary" share. */
  includeAppendix?: boolean;
  /** False drops `@page` so `printToFileAsync` can own the geometry. See `./css.ts`. */
  includePageRule?: boolean;
};

export function buildOpdHtml(data: OpdReportData, options: BuildOpdOptions = {}): string {
  const limits: PageOneLimits = { ...DEFAULT_PAGE_ONE_LIMITS, ...options.limits };
  const includeAppendix = options.includeAppendix ?? true;

  const body = joinHtml([
    renderHeader(data),
    renderAdherence(data),
    renderCharts(data, limits),
    renderMedicines(data, limits),
    renderSymptoms(data, limits),
    renderLabs(data, limits),
    renderQuestions(data, limits),
    renderFooter(data),
    includeAppendix ? renderAppendix(data) : null,
  ]);

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(`Health record summary — ${data.patient.displayName}`)}</title>`,
    `<style>${opdPrintCss(options.includePageRule ?? true)}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

// ── 1. Header ────────────────────────────────────────────────────────────────

function renderHeader(data: OpdReportData): string {
  const { patient } = data;
  const age = patient.ageYears ?? ageFromYearOfBirth(null);

  const identity = [
    age === null ? null : `${age} ${plural(age, 'year')} (from year of birth)`,
    formatSex(patient.sex),
    patient.bloodGroup ? `Blood group ${patient.bloodGroup}` : null,
  ].filter((part): part is string => part !== null);

  const parts: string[] = [];
  parts.push('<section class="section">');
  parts.push('<div class="masthead">');
  parts.push('<div>');
  parts.push(`<h1>${escapeHtml(patient.displayName)}</h1>`);
  parts.push(
    `<div class="patient-line">${identity.map((part) => `<span>${escapeHtml(part)}</span>`).join('')}</div>`,
  );
  if (patient.conditions.length > 0) {
    parts.push(`<div class="conditions">Conditions tracked: ${escapeHtml(patient.conditions.join(', '))}</div>`);
  }
  parts.push('</div>');
  parts.push('<div class="masthead__meta">');
  parts.push('<div><strong>Health record summary</strong></div>');
  parts.push(`<div>Period: ${escapeHtml(formatDateRangeLong(data.range.fromDate, data.range.toDate))}</div>`);
  parts.push(`<div>Prepared ${escapeHtml(formatEpochDateTime(data.generatedOnEpoch))}</div>`);
  parts.push('<div>Patient-maintained record — no clinical interpretation</div>');
  parts.push('</div>');
  parts.push('</div>');
  parts.push(renderSinceLastVisit(data));
  parts.push('</section>');
  return parts.join('\n');
}

function renderSinceLastVisit(data: OpdReportData): string {
  const visit = data.sinceLastVisit;
  if (!visit) {
    return '<p class="muted">No previous visit recorded, so there is nothing to compare against.</p>';
  }

  const who = [visit.doctor, visit.clinic].filter((v): v is string => !!v).join(', ');
  const heading = `Since the last recorded visit on ${formatDate(visit.visitedOn)}${who ? ` (${who})` : ''}`;

  if (visit.deltas.length === 0) {
    return `<p class="muted">${escapeHtml(heading)}: no measurement has been recorded both before and after it.</p>`;
  }

  const rows = visit.deltas
    .map((delta) => {
      // The direction is a WORD. An arrow alone is a glyph a fax turns into a smudge,
      // and a colour alone is a verdict this app is not entitled to render.
      // Three cases, and the middle one is the reason this is not a one-liner:
      //   • both ends measured        → '18 lower', the magnitude and the word.
      //   • one end LO/HI, provable   → 'lower', the word alone. There is no magnitude to
      //                                 print: 'was 180, now below 20' supports no
      //                                 subtraction, and 160 would be a number nobody
      //                                 measured.
      //   • one end LO/HI, unprovable → '—'. The app does not pick the likely side.
      // The unit is appended only to a real difference; 'lower mg/dL' is not a sentence.
      const change =
        delta.change !== null && delta.direction !== null
          ? `${delta.direction === 'unchanged' ? 'unchanged' : `${formatNumber(Math.abs(delta.change))} ${delta.direction}`}${
              delta.direction === 'unchanged' || !delta.unit ? '' : ` ${delta.unit}`
            }`
          : delta.direction !== null
            ? delta.direction
            : '—';
      return [
        '<tr>',
        `<td>${escapeHtml(`${delta.metricLabel} — ${delta.fieldLabel}`)}</td>`,
        `<td class="num">${cellText(delta.thenText)}</td>`,
        `<td>${cellText(delta.thenOn === null ? null : formatDate(delta.thenOn))}</td>`,
        `<td class="num">${cellText(delta.nowText)}</td>`,
        `<td>${cellText(delta.nowOn === null ? null : formatDate(delta.nowOn))}</td>`,
        `<td>${escapeHtml(change)}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');

  return [
    `<h3>${escapeHtml(heading)}</h3>`,
    '<table class="delta-table">',
    '<thead><tr><th>Measurement</th><th class="num">Then</th><th>On</th><th class="num">Now</th><th>On</th><th>Change</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
  ].join('\n');
}

// ── 2. Adherence ─────────────────────────────────────────────────────────────

function renderAdherence(data: OpdReportData): string {
  return renderAdherenceSection({
    primary: { label: data.primaryAdherenceLabel, summary: data.primaryAdherence },
    windows: data.adherenceWindows,
    disclaimer: data.adherenceDisclaimer,
  });
}

// ── 3. Charts ────────────────────────────────────────────────────────────────

/**
 * Which metrics get a chart.
 *
 * Metric keys are seed data, not constants in this file, so the choice is made from the
 * registry's own `sort_order` with a light nudge: anything that reads as a blood pressure
 * or a blood sugar floats to the front, because those two are what a follow-up
 * consultation is usually about. It is a preference, not a rule — a profile that tracks
 * neither still gets its two most important charts.
 */
export function selectChartMetrics(
  metrics: readonly ReportMetric[],
  readings: readonly ReportReading[],
  limit: number,
): ReportMetric[] {
  const counts = new Map<string, number>();
  for (const reading of readings) {
    counts.set(reading.metricKey, (counts.get(reading.metricKey) ?? 0) + 1);
  }

  const priority = (metric: ReportMetric): number => {
    const key = metric.key.toLowerCase();
    if (key.includes('bp') || key.includes('pressure')) return 0;
    if (key.includes('sugar') || key.includes('glucose')) return 1;
    return 2;
  };

  return metrics
    .filter((metric) => metric.chartKind !== 'none' && (counts.get(metric.key) ?? 0) > 0)
    .sort((a, b) => priority(a) - priority(b) || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

function renderCharts(data: OpdReportData, limits: PageOneLimits): string {
  const chosen = selectChartMetrics(data.metrics, data.readings, limits.charts);
  if (chosen.length === 0) {
    return '<section class="section"><h2>Measurements</h2><p class="muted">No measurements recorded in this period.</p></section>';
  }

  const changeMarkers = data.medChanges.map((change) => change.localDate);

  const charts = chosen
    .map((metric) => {
      const chart = buildMetricChart({
        metric,
        readings: data.readings,
        targets: data.targets,
        fromDate: data.range.fromDate,
        toDate: data.range.toDate,
        changeMarkers,
        height: 230,
      });
      // The caption repeats what the chart already draws, as real text. The chart is an
      // inlined image — its words are pixels — and the target's attribution is the one
      // line that must survive a screen reader, a text search, and an image that fails
      // to decode. Where there is no target, saying so is just as load-bearing: a reader
      // who sees no band must know that nobody set one rather than assume a rendering
      // failure.
      const caption =
        chart.bandLegend ??
        'No target range has been recorded for this measurement, so no target band is drawn. The app does not supply clinical targets.';
      // Two different facts, and conflating them is what made "scanning is not working"
      // out of a chart that was quietly discarding data. A chevron IS on the chart and
      // has to be explained; a reading with no recorded meter range is NOT on the chart
      // and has to be declared. Both are stated as real text under the image.
      const censored =
        chart.censoredCount > 0
          ? ` ${chart.censoredCount} reading${chart.censoredCount === 1 ? '' : 's'} showed LO or HI on the meter and ${
              chart.censoredCount === 1 ? 'is' : 'are'
            } drawn as an arrow at the limit of the meter's measuring range — that is where the meter stopped reading, not a value it produced.`
          : '';
      const offScale =
        chart.offScaleCount > 0
          ? ` ${chart.offScaleCount} reading${chart.offScaleCount === 1 ? '' : 's'} showed LO/HI on a meter whose measuring range has not been recorded, so ${
              chart.offScaleCount === 1 ? 'it is' : 'they are'
            } listed in the appendix rather than plotted.`
          : '';

      return [
        '<figure class="chart">',
        `<img src="${escapeAttr(chart.dataUri)}" alt="${escapeAttr(`${chart.title} over the selected period`)}" />`,
        `<figcaption class="chart-caption">${escapeHtml(caption + censored + offScale)}</figcaption>`,
        '</figure>',
      ].join('');
    })
    .join('\n');

  return ['<section class="section">', '<h2>Measurements</h2>', charts, '</section>'].join('\n');
}

// ── 4. Medicines ─────────────────────────────────────────────────────────────

/** '1 tablet at 08:00, 20:00 — after food'. Free text wins where a number would lie. */
export function describeSchedule(medicine: ReportMedicine): string {
  const fixed = medicine.slots.filter((slot) => slot.scheduleType === 'FIXED');
  const prn = medicine.slots.filter((slot) => slot.scheduleType === 'PRN');

  const groups = new Map<string, string[]>();
  for (const slot of fixed) {
    const quantity = slot.quantity ?? '';
    const list = groups.get(quantity) ?? [];
    if (slot.timeLocal) list.push(formatTime(slot.timeLocal));
    groups.set(quantity, list);
  }

  const phrases: string[] = [];
  for (const [quantity, times] of groups) {
    const timePart = times.length > 0 ? ` at ${times.sort().join(', ')}` : '';
    phrases.push(`${quantity || 'Dose not recorded'}${timePart}`);
  }
  if (prn.length > 0) {
    const quantity = prn[0]?.quantity;
    phrases.push(`${quantity ?? 'Dose not recorded'} only when needed`);
  }

  const first = fixed[0];
  const days = first && first.daysLabel !== 'Every day' ? ` (${first.daysLabel})` : '';
  const food = first?.foodRelation ? ` — ${first.foodRelation}` : '';
  return phrases.length === 0 ? 'No schedule recorded' : `${phrases.join('; ')}${days}${food}`;
}

function renderMedicines(data: OpdReportData, limits: PageOneLimits): string {
  const active = data.medicines.filter((m) => m.status === 'active');
  const stopped = data.medicines.filter((m) => m.status !== 'active');
  const shown = active.slice(0, limits.medicines);

  if (data.medicines.length === 0) {
    return '<section class="section"><h2>Current medicines</h2><p class="muted">No medicines recorded.</p></section>';
  }

  const rows = shown
    .map((medicine) =>
      [
        '<tr>',
        `<td><strong>${escapeHtml(medicine.name)}</strong>${
          medicine.form ? ` <span class="tag">${escapeHtml(medicine.form)}</span>` : ''
        }</td>`,
        `<td>${cellText(medicine.strength)}</td>`,
        `<td>${escapeHtml(describeSchedule(medicine))}</td>`,
        `<td>${cellText(medicine.startedOn === null ? null : formatDate(medicine.startedOn))}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  const notes: string[] = [];
  if (active.length > shown.length) {
    notes.push(`${active.length - shown.length} more current ${plural(active.length - shown.length, 'medicine')} listed in the appendix.`);
  }
  if (stopped.length > 0) {
    const names = stopped
      .slice(0, 6)
      .map((m) => `${m.name}${m.stoppedOn ? ` (stopped ${formatDate(m.stoppedOn)})` : ''}`)
      .join('; ');
    notes.push(`Stopped in or before this period: ${names}${stopped.length > 6 ? '; and others' : ''}.`);
  }

  return [
    '<section class="section">',
    '<h2>Current medicines</h2>',
    '<table>',
    '<thead><tr><th>Medicine</th><th>Strength</th><th>Dose and times</th><th>Since</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    notes.length > 0 ? `<p class="table-note">${escapeHtml(notes.join(' '))}</p>` : '',
    '</section>',
  ].join('\n');
}

// ── 5. Symptoms ──────────────────────────────────────────────────────────────

type SymptomGroup = {
  label: string;
  count: number;
  dates: string[];
  severities: Set<string>;
  lastOn: string;
  /** Her own words, newest first — what she typed when she logged this symptom. */
  notes: { date: string; note: string }[];
};

export function groupSymptoms(symptoms: readonly ReportSymptom[]): SymptomGroup[] {
  const groups = new Map<string, SymptomGroup>();
  for (const symptom of symptoms) {
    const group = groups.get(symptom.label) ?? {
      label: symptom.label,
      count: 0,
      dates: [],
      severities: new Set<string>(),
      lastOn: symptom.localDate,
      notes: [],
    };
    group.count += 1;
    if (!group.dates.includes(symptom.localDate)) group.dates.push(symptom.localDate);
    if (symptom.severity) group.severities.add(symptom.severity);
    if (symptom.localDate > group.lastOn) group.lastOn = symptom.localDate;
    // A blank/whitespace note is not a note. Newest first, so the summary shows what she
    // said most recently and the appendix carries the rest verbatim.
    const trimmed = symptom.note?.trim();
    if (trimmed) group.notes.unshift({ date: symptom.localDate, note: trimmed });
    groups.set(symptom.label, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastOn.localeCompare(a.lastOn));
}

function renderSymptoms(data: OpdReportData, limits: PageOneLimits): string {
  if (data.symptoms.length === 0) {
    return '<section class="section"><h2>Reported symptoms</h2><p class="muted">None reported in this period.</p></section>';
  }

  const groups = groupSymptoms(data.symptoms);
  const shown = groups.slice(0, limits.symptoms);

  const rows = shown
    .map((group) => {
      const dates = group.dates.slice().sort();
      const shownDates = dates.slice(-10).map(formatDate).join(', ');
      const more = dates.length > 10 ? ` (+${dates.length - 10} earlier)` : '';
      const main = [
        '<tr>',
        `<td>${escapeHtml(group.label)}</td>`,
        `<td class="num">${group.count}</td>`,
        `<td>${cellText([...group.severities].join(', '))}</td>`,
        `<td class="timeline-dates">${escapeHtml(shownDates + more)}</td>`,
        '</tr>',
      ].join('');
      // Her notes UNDER the symptom, most recent first — page one is a summary, so cap it
      // and defer the rest to the appendix's full "All reported symptoms" table.
      const notes = group.notes.slice().sort((a, b) => b.date.localeCompare(a.date));
      const noteShown = notes.slice(0, SYMPTOM_NOTES_ON_PAGE_ONE);
      if (noteShown.length === 0) return main;
      const items = noteShown
        .map((n) => `<li>${escapeHtml(`${formatDate(n.date)}: “${n.note}”`)}</li>`)
        .join('');
      const overflow =
        notes.length > noteShown.length
          ? `<li class="muted">${escapeHtml(
              `${notes.length - noteShown.length} more in the appendix.`,
            )}</li>`
          : '';
      const noteRow = `<tr class="note-row"><td colspan="4"><ul class="symptom-notes">${items}${overflow}</ul></td></tr>`;
      return main + noteRow;
    })
    .join('');

  const note =
    groups.length > shown.length
      ? `<p class="table-note">${escapeHtml(
          `${groups.length - shown.length} further symptom ${plural(groups.length - shown.length, 'type')} listed in the appendix.`,
        )}</p>`
      : '';

  return [
    '<section class="section">',
    '<h2>Reported symptoms</h2>',
    '<table>',
    '<thead><tr><th>Symptom</th><th class="num">Times</th><th>Severity reported</th><th>On</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    note,
    '</section>',
  ].join('\n');
}

// ── 6. Labs ──────────────────────────────────────────────────────────────────

function labValue(lab: ReportLab): string {
  const value = lab.valueText ?? (lab.valueNum === null ? null : formatNumber(lab.valueNum));
  return value === null ? '—' : `${escapeHtml(value)}${lab.unit ? ` ${escapeHtml(lab.unit)}` : ''}`;
}

function renderLabs(data: OpdReportData, limits: PageOneLimits): string {
  if (data.labs.length === 0) {
    return '<section class="section"><h2>Laboratory results</h2><p class="muted">None recorded for this period.</p></section>';
  }

  const shown = data.labs.slice(0, limits.labs);
  const rows = shown.map(renderLabRow).join('');

  const note = [
    data.labs.length > shown.length
      ? `${data.labs.length - shown.length} further ${plural(data.labs.length - shown.length, 'result')} in the appendix.`
      : '',
    'Reference ranges are transcribed from the paper report. Where a report printed none, the column is blank — the app does not supply one.',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return [
    '<section class="section">',
    '<h2>Laboratory results</h2>',
    '<table>',
    '<thead><tr><th>Test</th><th>Result</th><th>Reference range as printed</th><th>Collected</th><th>Lab</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    `<p class="table-note">${escapeHtml(note)}</p>`,
    '</section>',
  ].join('\n');
}

function renderLabRow(lab: ReportLab): string {
  // An OCR row nobody has checked against the paper is marked on the page, not silently
  // presented as equal to a value a human typed.
  const flags = [
    lab.source === 'ocr' && !lab.confirmed ? '<span class="tag">read by app, unchecked</span>' : '',
    lab.beforeRange ? '<span class="tag">before this period</span>' : '',
  ].join('');
  return [
    '<tr>',
    `<td>${escapeHtml(lab.label)}${flags}</td>`,
    `<td>${labValue(lab)}</td>`,
    `<td>${cellText(lab.refRangeText)}</td>`,
    `<td>${cellText(lab.collectedOn === null ? null : formatDate(lab.collectedOn))}</td>`,
    `<td>${cellText(lab.labName)}</td>`,
    '</tr>',
  ].join('');
}

// ── 7. Questions ─────────────────────────────────────────────────────────────

function renderQuestions(data: OpdReportData, limits: PageOneLimits): string {
  if (data.questions.length === 0) return '';

  const shown = data.questions.slice(0, limits.questions);
  const items = shown
    .map(
      (question) =>
        // An 'auto' question was composed by the app, not by the patient. Marking it is
        // not a nicety: she should never have to defend a sentence she did not write,
        // and the doctor is entitled to know which lines came from the patient.
        `<li>${escapeHtml(question.text)}${
          question.origin === 'auto' ? '<span class="tag">suggested by the app</span>' : ''
        }</li>`,
    )
    .join('');

  const note =
    data.questions.length > shown.length
      ? `<p class="table-note">${escapeHtml(`${data.questions.length - shown.length} more in the appendix.`)}</p>`
      : '';

  return [
    '<section class="section">',
    '<h2>Questions the patient wants to ask</h2>',
    `<ol class="question-list">${items}</ol>`,
    note,
    '</section>',
  ].join('\n');
}

function renderFooter(data: OpdReportData): string {
  return [
    '<div class="footer">',
    escapeHtml(
      'This is a record kept by the patient in the Aarogya app. It contains no diagnosis and no clinical interpretation. ',
    ),
    escapeHtml(data.adherenceDisclaimer),
    '</div>',
  ].join('');
}

// ── Appendix ─────────────────────────────────────────────────────────────────

function renderAppendix(data: OpdReportData): string {
  return joinHtml([
    '<div class="page-break"></div>',
    '<section class="section"><h2>Appendix — complete record</h2>' +
      `<p class="muted">${escapeHtml(
        `Everything recorded between ${formatDateLong(data.range.fromDate)} and ${formatDateLong(data.range.toDate)}. Tables longer than ${APPENDIX_ROW_CAP} rows are cut off here; the CSV export contains every row.`,
      )}</p></section>`,
    renderAllMedicines(data),
    renderTargets(data),
    renderInstruments(data),
    renderAllReadings(data),
    renderAllSymptoms(data),
    renderAllLabs(data),
    renderAllQuestions(data),
    '<div class="page-break"></div>',
    renderDoseCalendarSection(data),
    renderTimelineSection(data),
    renderAllDoses(data),
  ]);
}

function renderAllMedicines(data: OpdReportData): string {
  if (data.medicines.length === 0) return '';
  const rows = data.medicines
    .map((medicine) =>
      [
        '<tr>',
        `<td>${escapeHtml(medicine.name)}</td>`,
        `<td>${cellText(medicine.strength)}</td>`,
        `<td>${cellText(medicine.form)}</td>`,
        `<td>${escapeHtml(describeSchedule(medicine))}</td>`,
        `<td>${cellText(medicine.startedOn === null ? null : formatDate(medicine.startedOn))}</td>`,
        `<td>${cellText(medicine.stoppedOn === null ? null : formatDate(medicine.stoppedOn))}</td>`,
        `<td>${escapeHtml(medicine.status)}</td>`,
        `<td>${cellText(medicine.stopReason)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  return [
    '<section class="section">',
    '<h3>All medicines in this period</h3>',
    '<table>',
    '<thead><tr><th>Medicine</th><th>Strength</th><th>Form</th><th>Dose and times</th><th>Started</th><th>Stopped</th><th>Status</th><th>Reason for stopping</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

function renderTargets(data: OpdReportData): string {
  if (data.targets.length === 0) {
    return [
      '<section class="section">',
      '<h3>Target ranges</h3>',
      '<p class="muted">No target range has been recorded for any measurement. The app does not supply clinical targets, so no chart in this report shows a target band.</p>',
      '</section>',
    ].join('\n');
  }

  const metricLabel = (key: string): string => data.metrics.find((m) => m.key === key)?.label ?? key;
  const fieldLabel = (metricKey: string, field: string): string =>
    data.metrics.find((m) => m.key === metricKey)?.fields.find((f) => f.slot === field)?.label ?? field;

  const rows = data.targets
    .map((target) =>
      [
        '<tr>',
        `<td>${escapeHtml(metricLabel(target.metricKey))}</td>`,
        `<td>${escapeHtml(fieldLabel(target.metricKey, target.field))}</td>`,
        `<td class="num">${cellText(target.low === null ? null : formatNumber(target.low))}</td>`,
        `<td class="num">${cellText(target.high === null ? null : formatNumber(target.high))}</td>`,
        `<td>${cellText(target.context === null ? null : JSON.stringify(target.context))}</td>`,
        `<td>${escapeHtml(target.setByLabel)}</td>`,
        `<td>${escapeHtml(formatDate(target.setOn))}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  return [
    '<section class="section">',
    '<h3>Target ranges</h3>',
    '<table>',
    '<thead><tr><th>Measurement</th><th>Field</th><th class="num">Low</th><th class="num">High</th><th>Applies when</th><th>Set by</th><th>On</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '<p class="table-note">Every target above was entered because a named person said so on a named date. The app ships none and infers none.</p>',
    '</section>',
  ].join('\n');
}

/**
 * The meters themselves — what they are, what they can read, and who said so.
 *
 * SEPARATE FROM "Target ranges", AND THAT SEPARATION IS THE POINT. A target is a clinical
 * opinion about this patient; a measuring range is a specification of a device on her
 * table. Printed in one table they would read as two kinds of the same thing, and the
 * next reader would take `20–600` for a range someone wants her to stay inside.
 *
 * It carries a name and a date for the same reason every target does: this section is
 * where an inequality on the chart and in the table gets its authority, and an
 * unattributed one would be the app asserting a number about equipment it has never seen.
 */
function renderInstruments(data: OpdReportData): string {
  if (data.instruments.length === 0) {
    // Nothing recorded and nothing to explain: a report from a period with no LO or HI in
    // it does not need a paragraph about meter ranges, and a section that appears on every
    // report regardless is a section nobody reads by the third one.
    if (!data.readings.some((reading) => reading.qualifier !== 'exact')) return '';
    // Otherwise, said out loud rather than omitted. A reader who sees "Meter showed LO"
    // with no inequality beside it is entitled to know that nobody has told the app what
    // the meter's range is — the alternative reading is that the app lost the number.
    return [
      '<section class="section">',
      '<h3>Measuring instruments</h3>',
      '<p class="muted">No measuring range has been recorded for any instrument. Where a meter printed LO or HI, this report says so but cannot say what number that was below or above.</p>',
      '</section>',
    ].join('\n');
  }

  const rows = data.instruments
    .map((instrument) => {
      const range =
        instrument.low !== null && instrument.high !== null
          ? `${formatNumber(instrument.low)}–${formatNumber(instrument.high)}${instrument.unit ? ` ${instrument.unit}` : ''}`
          : // Only one end known. Half the answer is worth printing: it is what lets a LO
            // be read as an inequality even where nobody knew the meter's ceiling.
            instrument.low !== null
            ? `reads LO ${inequalityText('below', instrument.low, instrument.unit)}; upper limit not recorded`
            : instrument.high !== null
              ? `reads HI ${inequalityText('above', instrument.high, instrument.unit)}; lower limit not recorded`
              : '';
      return [
        '<tr>',
        `<td>${escapeHtml(instrument.metricLabel)}</td>`,
        `<td>${escapeHtml(instrument.label)}</td>`,
        `<td>${cellText(range === '' ? null : range)}</td>`,
        `<td>${escapeHtml(instrument.setByLabel)}</td>`,
        `<td>${escapeHtml(formatDate(instrument.setOn))}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');

  return [
    '<section class="section">',
    '<h3>Measuring instruments</h3>',
    '<table>',
    '<thead><tr><th>Measurement</th><th>Instrument</th><th>Measuring range</th><th>Recorded by</th><th>On</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '<p class="table-note">A measuring range is what the device can read, not a range anyone is aiming for. It is the only reason this report can turn a meter that printed LO into "below 20 mg/dL". It was recorded by the named person above, and each reading kept the range that was in force on the day it was taken.</p>',
    '</section>',
  ].join('\n');
}

function readingValueText(reading: ReportReading): string {
  // 'Meter showed LO (below 20 mg/dL)'. The inequality is the whole point: a doctor who
  // sees an arrow sitting at 20 on the chart must be able to find, in the table, the row
  // that says the meter never produced a 20.
  const censored = censoredValueText(reading.qualifier, reading.qualifierBound, reading.unit);
  if (censored) return censored;
  const values = reading.fields
    .filter((field) => field.value !== null)
    .map((field) => formatNumber(field.value));
  return values.length > 0 ? values.join(' / ') : '—';
}

function renderAllReadings(data: OpdReportData): string {
  if (data.readings.length === 0) return '';
  const ordered = data.readings.slice().sort((a, b) => b.atEpoch - a.atEpoch);
  const shown = ordered.slice(0, APPENDIX_ROW_CAP);

  const rows = shown
    .map((reading) => {
      const flags = [
        // Both flags exist because the strength of the evidence differs. A reading typed
        // from memory hours later, or corrected afterwards, is still a real reading — but
        // the reader is entitled to know which is which.
        reading.wasBackfilled ? '<span class="tag">added later</span>' : '',
        reading.editedCount > 0 ? `<span class="tag">corrected ${reading.editedCount}×</span>` : '',
      ].join('');
      return [
        '<tr>',
        `<td>${escapeHtml(formatDate(reading.localDate))}</td>`,
        `<td>${escapeHtml(formatTime(reading.localTime))}</td>`,
        `<td>${escapeHtml(reading.metricLabel)}${flags}</td>`,
        `<td class="num">${escapeHtml(readingValueText(reading))}</td>`,
        // Empty for a LO/HI row: `readingValueText` has already printed the unit inside
        // 'below 20 mg/dL', and repeating it here reads as 'below 20 mg/dL | mg/dL'. The
        // rule is `censoredUnitText`, shared with the app screens so the printout and the
        // screen cannot drift apart again.
        `<td>${cellText(censoredUnitText(reading.qualifier, reading.unit))}</td>`,
        `<td>${cellText(reading.contextLabel)}</td>`,
        `<td>${cellText(reading.note)}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');

  const note =
    ordered.length > shown.length
      ? `<p class="table-note">${escapeHtml(`${ordered.length - shown.length} earlier readings are in the CSV export.`)}</p>`
      : '';

  return [
    '<section class="section">',
    '<h3>All measurements</h3>',
    '<table>',
    '<thead><tr><th>Date</th><th>Time</th><th>Measurement</th><th class="num">Value</th><th>Unit</th><th>Context</th><th>Note</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    note,
    '</section>',
  ].join('\n');
}

function renderAllSymptoms(data: OpdReportData): string {
  if (data.symptoms.length === 0) return '';
  const shown = data.symptoms.slice(0, APPENDIX_ROW_CAP);
  const rows = shown
    .map((symptom) =>
      [
        '<tr>',
        `<td>${escapeHtml(formatDate(symptom.localDate))}</td>`,
        `<td>${escapeHtml(formatTime(symptom.localTime))}</td>`,
        `<td>${escapeHtml(symptom.label)}${
          symptom.editedCount > 0 ? `<span class="tag">corrected ${symptom.editedCount}×</span>` : ''
        }</td>`,
        `<td>${cellText(symptom.severity)}</td>`,
        `<td>${cellText(symptom.note)}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  return [
    '<section class="section">',
    '<h3>All reported symptoms</h3>',
    '<table>',
    '<thead><tr><th>Date</th><th>Time</th><th>Symptom</th><th>Severity</th><th>Note</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

function renderAllLabs(data: OpdReportData): string {
  if (data.labs.length === 0) return '';
  return [
    '<section class="section">',
    '<h3>All laboratory results</h3>',
    '<table>',
    '<thead><tr><th>Test</th><th>Result</th><th>Reference range as printed</th><th>Collected</th><th>Lab</th></tr></thead>',
    `<tbody>${data.labs.slice(0, APPENDIX_ROW_CAP).map(renderLabRow).join('')}</tbody>`,
    '</table>',
    '</section>',
  ].join('\n');
}

function renderAllQuestions(data: OpdReportData): string {
  if (data.questions.length === 0) return '';
  const items = data.questions
    .map(
      (question) =>
        `<li>${escapeHtml(question.text)}${
          question.origin === 'auto' ? '<span class="tag">suggested by the app</span>' : ''
        }</li>`,
    )
    .join('');
  return [
    '<section class="section">',
    '<h3>All questions</h3>',
    `<ol class="question-list">${items}</ol>`,
    '</section>',
  ].join('\n');
}

function renderDoseCalendarSection(data: OpdReportData): string {
  return [
    '<section class="section">',
    '<h2>Dose calendar</h2>',
    renderDoseCalendar({ doses: data.doses, days: data.doseDays }),
    '</section>',
  ].join('\n');
}

function renderTimelineSection(data: OpdReportData): string {
  const timeline = buildMedicationTimeline({
    medicines: data.medicines,
    changes: data.medChanges,
    fromDate: data.range.fromDate,
    toDate: data.range.toDate,
  });

  const changes =
    data.medChanges.length === 0
      ? '<p class="muted">No medicine change was recorded in this period.</p>'
      : [
          '<table>',
          '<thead><tr><th>Date</th><th>Change</th><th>Detail</th></tr></thead>',
          `<tbody>${data.medChanges
            .map(
              (change) =>
                `<tr><td>${escapeHtml(formatDate(change.localDate))}</td><td>${escapeHtml(
                  change.kind.replace(/_/g, ' '),
                )}</td><td>${cellText(change.detail)}</td></tr>`,
            )
            .join('')}</tbody>`,
          '</table>',
        ].join('');

  return [
    '<section class="section">',
    '<h2>Medication timeline</h2>',
    `<figure class="chart"><img src="${escapeAttr(timeline.dataUri)}" alt="${escapeAttr(
      'Which medicines were in force during the period',
    )}" /></figure>`,
    changes,
    '</section>',
  ].join('\n');
}

function doseStatusText(dose: ReportDose): string {
  switch (dose.status) {
    case 'taken':
      return 'Recorded as taken';
    case 'skipped':
      return 'Recorded as not taken';
    case 'cancelled':
      return 'Withdrawn';
    case 'snoozed':
      return 'Snoozed';
    case 'pending':
      return 'Not yet due';
    // The word is never "missed". See src/features/dosing/deriveStatus.ts.
    case 'no_record':
    default:
      return 'No record either way';
  }
}

function renderAllDoses(data: OpdReportData): string {
  if (data.doses.length === 0) return '';
  const ordered = data.doses.slice().sort((a, b) => b.scheduledAtEpoch - a.scheduledAtEpoch);
  const shown = ordered.slice(0, APPENDIX_ROW_CAP);

  const rows = shown
    .map((dose) =>
      [
        '<tr>',
        `<td>${escapeHtml(formatDate(dose.localDate))}</td>`,
        `<td>${escapeHtml(formatTime(dose.timeLocal))}</td>`,
        `<td>${escapeHtml(dose.strength ? `${dose.medicineName} ${dose.strength}` : dose.medicineName)}</td>`,
        `<td>${escapeHtml(doseStatusText(dose))}</td>`,
        `<td>${cellText(dose.recordedAtEpoch === null ? null : formatEpochDateTime(dose.recordedAtEpoch))}</td>`,
        '</tr>',
      ].join(''),
    )
    .join('');

  const note =
    ordered.length > shown.length
      ? `<p class="table-note">${escapeHtml(`${ordered.length - shown.length} earlier doses are in the CSV export.`)}</p>`
      : '';

  return [
    '<section class="section">',
    '<h3>All scheduled doses</h3>',
    '<table>',
    '<thead><tr><th>Date</th><th>Due at</th><th>Medicine</th><th>Record</th><th>Recorded at</th></tr></thead>',
    `<tbody>${rows}</tbody>`,
    '</table>',
    note,
    '<p class="table-note">The "recorded at" column is when the app was told, which is not necessarily when the dose was taken.</p>',
    '</section>',
  ].join('\n');
}
