/**
 * CSV — THE UNCONDITIONAL PATH.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE HAS NO DEPENDENCIES AND NEVER WILL
 *
 * "Give me my data" is a promise the app has to keep on the worst day, not the best one:
 * a phone about to be wiped, a patient changing to a different app, a relative who needs
 * the record and does not have this app. A dependency that fails to load, a native module
 * that is missing from a build, or a library whose tested matrix stops two React Native
 * versions ago, all turn that promise into an error dialog.
 *
 * So the export the app guarantees is CSV, written by hand, in pure TypeScript with no
 * runtime imports whatsoever — which also means Node's type-stripping test runner loads
 * this module on its own, and the writer below is unit-tested rather than assumed.
 * `./xlsx.ts` is a nicety layered on top; when it fails it falls back to exactly this.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LONG FORMAT, ONE FILE PER RECORD TYPE. A blood pressure is one row per number, not one
 * row with three columns, because the next reader is a spreadsheet pivot table or a
 * researcher's script and neither can guess that `v2` meant diastolic. Every file is
 * accompanied by `README.csv`, which names and explains every column of every file — an
 * export nobody can interpret is not an export.
 */

import type {
  ExportData,
  ReportDose,
  ReportLab,
  ReportMedChange,
  ReportMedicine,
  ReportReading,
  ReportSymptom,
  ReportTarget,
} from '../data/types';

export type CsvValue = string | number | boolean | null | undefined;

export type CsvColumn = { key: string; header: string; description: string };

export type CsvSheet = {
  /** File base name, without the extension. Also the worksheet name in XLSX. */
  name: string;
  title: string;
  purpose: string;
  columns: CsvColumn[];
  rows: CsvValue[][];
};

export type CsvFile = { name: string; content: string };

export type CsvOptions = {
  /**
   * A UTF-8 byte-order mark. ON by default: without it Excel on Windows reads the file as
   * the system code page and a Hindi note becomes mojibake, which is exactly the field a
   * doctor most wants to read and the one most likely to be in Devanagari.
   */
  bom?: boolean;
};

/** RFC 4180. Excel, LibreOffice and Google Sheets all accept it; some older tools require it. */
export const CSV_LINE_ENDING = '\r\n';
/** Written as an escape rather than a literal — an invisible character in source is a trap. */
export const UTF8_BOM = '\uFEFF';

// ── The writer ───────────────────────────────────────────────────────────────

/**
 * Does this text need neutralising before a spreadsheet treats it as a formula?
 *
 * A note field is free text typed by a patient, and a spreadsheet opening a cell that
 * begins `=` or `@` will evaluate it — historically including `=cmd|...` style payloads
 * in Excel. Prefixing an apostrophe makes it literal text.
 *
 * A cell that is simply a negative number ('-5', '-0.25') is left alone. Mangling every
 * negative value in the file to defend against a formula that cannot exist there would
 * corrupt real data to prevent a theoretical problem.
 */
export function needsFormulaGuard(text: string): boolean {
  if (text.length === 0) return false;
  if (!/^[=+\-@\t\r]/.test(text)) return false;
  return !/^-?\d+(\.\d+)?$/.test(text);
}

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    // NaN and Infinity have no CSV representation that a spreadsheet reads back as a
    // number, and writing the words would quietly become a string in a numeric column.
    return Number.isFinite(value) ? String(value) : '';
  }

  // 'yes'/'no' rather than TRUE/FALSE or 1/0: this file is opened by people, and README
  // says so. A raw 1 in a `was_backfilled` column is a footgun for a human reader.
  const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : value;

  const guarded = needsFormulaGuard(text) ? `'${text}` : text;

  const mustQuote =
    guarded.includes('"') ||
    guarded.includes(',') ||
    guarded.includes('\n') ||
    guarded.includes('\r') ||
    guarded !== guarded.trim();

  return mustQuote ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvLine(cells: readonly CsvValue[]): string {
  return cells.map(csvCell).join(',');
}

export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly CsvValue[])[],
  options: CsvOptions = {},
): string {
  const lines = [csvLine(headers), ...rows.map(csvLine)];
  const body = lines.join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
  return (options.bom ?? true) ? UTF8_BOM + body : body;
}

export function sheetToCsv(sheet: CsvSheet, options: CsvOptions = {}): string {
  return toCsv(
    sheet.columns.map((column) => column.header),
    sheet.rows,
    options,
  );
}

// ── Sheet builders ───────────────────────────────────────────────────────────

function contextText(context: Record<string, string> | null | undefined): string | null {
  if (!context) return null;
  const entries = Object.entries(context);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${value}`).join('; ');
}

function readingsSheet(readings: readonly ReportReading[]): CsvSheet {
  const rows: CsvValue[][] = [];
  for (const reading of readings) {
    for (const field of reading.fields) {
      // A field with no value still gets a row when the meter printed LO/HI: the reading
      // happened, the number simply is not a number, and dropping the row would delete
      // the most clinically loud result in the file.
      if (field.value === null && reading.qualifier === 'exact') continue;
      rows.push([
        reading.id,
        reading.localDate,
        reading.localTime,
        reading.atEpoch,
        reading.metricKey,
        reading.metricLabel,
        field.key,
        field.label,
        field.value,
        reading.unit,
        reading.qualifier,
        // The bound rides in its OWN column and the value column stays blank. Writing 20
        // into `value` would make the meter's limit indistinguishable from a measurement
        // to a pivot table, a script, and the doctor's own spreadsheet — qualifier
        // columns get dropped downstream, values do not.
        reading.qualifierBound,
        contextText(reading.context),
        reading.note,
        reading.wasBackfilled,
        reading.source,
        reading.editedCount,
      ]);
    }
  }

  return {
    name: 'readings',
    title: 'Measurements',
    purpose: 'One row per number. A blood pressure produces three rows: upper, lower and pulse.',
    columns: [
      { key: 'reading_id', header: 'reading_id', description: 'Identifier of the reading. Rows sharing it were recorded together.' },
      { key: 'local_date', header: 'local_date', description: 'Calendar date it was recorded for, in the phone\'s timezone at the time (YYYY-MM-DD).' },
      { key: 'local_time', header: 'local_time', description: 'Time of day, 24-hour (HH:MM).' },
      { key: 'at_epoch', header: 'at_epoch', description: 'Absolute time in milliseconds since 1 Jan 1970 UTC. Use this to sort.' },
      { key: 'metric_key', header: 'metric_key', description: 'Stable machine name of the measurement.' },
      { key: 'metric_label', header: 'metric_label', description: 'Human name of the measurement, in English.' },
      { key: 'field_key', header: 'field_key', description: 'Which number this row holds (for example systolic, diastolic, pulse).' },
      { key: 'field_label', header: 'field_label', description: 'Human name of that number.' },
      { key: 'value', header: 'value', description: 'The number, exactly as recorded. Blank when the meter printed LO or HI.' },
      { key: 'unit', header: 'unit', description: 'Unit of the measurement.' },
      { key: 'value_qualifier', header: 'value_qualifier', description: 'exact, or below_range / above_range when the meter printed LO / HI instead of a number.' },
      { key: 'qualifier_bound', header: 'qualifier_bound', description: 'The limit of the meter\'s measuring range, filled in only when value_qualifier is not exact. below_range means the true value is BELOW this number; above_range means it is ABOVE it. It is not a measurement — the value column is deliberately left blank for these rows, and this number must never be used as one. Blank here means the meter\'s range was never recorded, so all that is known is the direction.' },
      { key: 'context', header: 'context', description: 'Extra circumstances recorded with it, such as meal=fasting.' },
      { key: 'note', header: 'note', description: 'Free text the patient typed.' },
      { key: 'was_backfilled', header: 'was_backfilled', description: 'yes when the reading was entered more than five minutes after the time it records — that is, from memory rather than at the meter.' },
      { key: 'source', header: 'source', description: 'manual (typed), ocr (read from a photo by the app), import, or device.' },
      { key: 'edited_count', header: 'edited_count', description: 'How many times the reading was corrected after it was first saved. Every correction is kept in the app with its old and new value.' },
    ],
    rows,
  };
}

function dosesSheet(doses: readonly ReportDose[]): CsvSheet {
  const rows: CsvValue[][] = doses.map((dose) => [
    dose.occurrenceId,
    dose.threadId,
    dose.medicineName,
    dose.strength,
    dose.localDate,
    dose.timeLocal,
    dose.scheduledAtEpoch,
    dose.status,
    dose.recordedAtEpoch,
    dose.recordedOrigin,
    dose.recordedDelayMinutes,
  ]);

  return {
    name: 'doses',
    title: 'Scheduled doses',
    purpose:
      'One row per scheduled dose. The record column says what the app was told, which is not the same as what was swallowed.',
    columns: [
      { key: 'occurrence_id', header: 'occurrence_id', description: 'Identifier of this scheduled dose.' },
      { key: 'thread_id', header: 'thread_id', description: 'Identifier of the medicine across all its versions. Use this to follow one drug through dose changes.' },
      { key: 'medicine', header: 'medicine', description: 'Medicine name as it was written down.' },
      { key: 'strength', header: 'strength', description: 'Strength as written, for example 500 mg.' },
      { key: 'local_date', header: 'local_date', description: 'The day the dose was scheduled for (YYYY-MM-DD).' },
      { key: 'time_local', header: 'time_local', description: 'Wall-clock time the dose was scheduled for, 24-hour (HH:MM).' },
      { key: 'scheduled_at_epoch', header: 'scheduled_at_epoch', description: 'That moment as milliseconds since 1 Jan 1970 UTC.' },
      // The vocabulary is deliberately narrow, and the description explains the gap in it
      // without using the forbidden word — a data dictionary that spells it out would put
      // it back into the file that is meant not to contain it.
      { key: 'record', header: 'record', description: 'taken, skipped (recorded as not taken), no_record (nothing recorded either way), cancelled, snoozed, or pending (not yet due). There is deliberately no value meaning the dose was not swallowed: the app records taps, and a tap that never happened is silence rather than evidence.' },
      { key: 'recorded_at_epoch', header: 'recorded_at_epoch', description: 'When the app was told, in milliseconds. Blank when nothing was recorded.' },
      { key: 'recorded_origin', header: 'recorded_origin', description: 'Where the record came from: app, notification, widget, native (the alarm screen) or watchdog.' },
      { key: 'recorded_delay_minutes', header: 'recorded_delay_minutes', description: 'Minutes between the scheduled time and the record. Negative means it was recorded early. This file has no was_backfilled column because a dose record has no such flag — this column is the closest honest equivalent.' },
    ],
    rows,
  };
}

function medicinesSheet(medicines: readonly ReportMedicine[]): CsvSheet {
  const rows: CsvValue[][] = medicines.map((medicine) => [
    medicine.threadId,
    medicine.medicineId,
    medicine.version,
    medicine.name,
    medicine.strength,
    medicine.form,
    medicine.criticality,
    medicine.status,
    medicine.startedOn,
    medicine.stoppedOn,
    medicine.stopReason,
  ]);

  return {
    name: 'medicines',
    title: 'Medicines',
    purpose: 'One row per medicine version that was in force during the period.',
    columns: [
      { key: 'thread_id', header: 'thread_id', description: 'Identifier of the drug across all its versions.' },
      { key: 'medicine_id', header: 'medicine_id', description: 'Identifier of this particular version.' },
      { key: 'version', header: 'version', description: 'Version number. A dose change adds a version rather than editing the old one, so history stays correct.' },
      { key: 'name', header: 'name', description: 'Name exactly as written on the prescription or by the patient.' },
      { key: 'strength', header: 'strength', description: 'Strength as written.' },
      { key: 'form', header: 'form', description: 'tablet, capsule, syrup, injection, inhaler, drops, cream or other.' },
      { key: 'criticality', header: 'criticality', description: 'How loudly the reminder rings: critical, standard or low. Not a clinical grading.' },
      { key: 'status', header: 'status', description: 'active, stopped or superseded (replaced by a newer version).' },
      { key: 'started_on', header: 'started_on', description: 'First day it applied (YYYY-MM-DD).' },
      { key: 'stopped_on', header: 'stopped_on', description: 'Last day it applied. Blank while it is still being taken.' },
      { key: 'stop_reason', header: 'stop_reason', description: 'Why it was stopped, if a reason was recorded.' },
    ],
    rows,
  };
}

function schedulesSheet(medicines: readonly ReportMedicine[]): CsvSheet {
  const rows: CsvValue[][] = [];
  for (const medicine of medicines) {
    for (const slot of medicine.slots) {
      rows.push([
        medicine.threadId,
        medicine.name,
        slot.scheduleType,
        slot.timeLocal,
        slot.slotName,
        slot.slotKey,
        slot.quantity,
        slot.foodRelation,
        slot.daysLabel,
        slot.intervalDays,
        slot.startedOn,
        slot.stoppedOn,
      ]);
    }
  }

  return {
    name: 'schedules',
    title: 'Dose schedules',
    purpose: 'One row per scheduled time. A twice-daily medicine has two rows.',
    columns: [
      { key: 'thread_id', header: 'thread_id', description: 'Identifier of the drug across all its versions.' },
      { key: 'medicine', header: 'medicine', description: 'Medicine name.' },
      { key: 'schedule_type', header: 'schedule_type', description: 'FIXED (a set time) or PRN (only when needed).' },
      { key: 'time_local', header: 'time_local', description: 'Wall-clock time, 24-hour. Blank for PRN. This is never stored as an absolute timestamp, so it stays correct across a timezone change.' },
      { key: 'slot_name', header: 'slot_name', description: 'What this time of day is called — "Before breakfast", or the patient\'s own name for a time she added herself. Blank if the time has no name.' },
      { key: 'slot_key', header: 'slot_key', description: 'Machine identifier for the slot, kept for traceability. A time the patient named herself appears here as custom:<id>; read slot_name for the name.' },
      { key: 'quantity', header: 'quantity', description: 'How much, as recorded — including free text such as "half tablet".' },
      { key: 'food_relation', header: 'food_relation', description: 'before, after, with, empty (empty stomach) or any.' },
      { key: 'days', header: 'days', description: 'Which days of the week it applies to.' },
      { key: 'interval_days', header: 'interval_days', description: '1 for daily, 2 for alternate days, and so on, counted from started_on.' },
      { key: 'started_on', header: 'started_on', description: 'First day this timing applied.' },
      { key: 'stopped_on', header: 'stopped_on', description: 'Last day it applied. Blank while it is still in force.' },
    ],
    rows,
  };
}

function symptomsSheet(symptoms: readonly ReportSymptom[]): CsvSheet {
  const rows: CsvValue[][] = symptoms.map((symptom) => [
    symptom.id,
    symptom.localDate,
    symptom.localTime,
    symptom.label,
    symptom.severity,
    symptom.note,
    symptom.editedCount,
  ]);

  return {
    name: 'symptoms',
    title: 'Reported symptoms',
    purpose: 'One row per symptom the patient recorded.',
    columns: [
      { key: 'symptom_id', header: 'symptom_id', description: 'Identifier of the entry.' },
      { key: 'local_date', header: 'local_date', description: 'Date it was recorded for (YYYY-MM-DD).' },
      { key: 'local_time', header: 'local_time', description: 'Time of day, 24-hour.' },
      { key: 'symptom', header: 'symptom', description: 'The symptom, either from the app\'s list or in the patient\'s own words.' },
      { key: 'severity', header: 'severity', description: 'mild, moderate or severe. Blank when none was chosen.' },
      { key: 'note', header: 'note', description: 'Free text the patient typed.' },
      { key: 'edited_count', header: 'edited_count', description: 'How many times the entry was corrected after it was first saved.' },
    ],
    rows,
  };
}

function labsSheet(labs: readonly ReportLab[]): CsvSheet {
  const rows: CsvValue[][] = labs.map((lab) => [
    lab.id,
    lab.collectedOn,
    lab.label,
    lab.valueText,
    lab.valueNum,
    lab.unit,
    lab.refRangeText,
    lab.labName,
    lab.source,
    lab.confirmed,
  ]);

  return {
    name: 'labs',
    title: 'Laboratory results',
    purpose: 'One row per result, with the value exactly as the paper report printed it.',
    columns: [
      { key: 'lab_id', header: 'lab_id', description: 'Identifier of the result.' },
      { key: 'collected_on', header: 'collected_on', description: 'Date the sample was collected (YYYY-MM-DD). Blank when the report did not say — no date is guessed.' },
      { key: 'test', header: 'test', description: 'Test name, from the app\'s list or as typed.' },
      { key: 'value_text', header: 'value_text', description: 'The result exactly as printed, including results that are not numbers ("Negative", "Trace", "<0.01").' },
      { key: 'value_num', header: 'value_num', description: 'The same result as a number, but only when the printed value was a plain number. This is the column charts read.' },
      { key: 'unit', header: 'unit', description: 'Unit as printed.' },
      { key: 'ref_range_text', header: 'ref_range_text', description: 'Reference range TRANSCRIBED from the paper report. Blank when the report printed none — the app never supplies one, because it does not know the assay or the laboratory\'s method.' },
      { key: 'lab_name', header: 'lab_name', description: 'Laboratory that issued the report.' },
      { key: 'source', header: 'source', description: 'manual (typed by a person) or ocr (read from a photo by the app).' },
      { key: 'confirmed', header: 'confirmed', description: 'yes when a person has checked the row against the paper. An ocr row that says no has not been checked by anyone.' },
    ],
    rows,
  };
}

function targetsSheet(targets: readonly ReportTarget[]): CsvSheet {
  const rows: CsvValue[][] = targets.map((target) => [
    target.metricKey,
    target.field,
    target.low,
    target.high,
    contextText(target.context),
    target.setByLabel,
    target.setOn,
  ]);

  return {
    name: 'targets',
    title: 'Target ranges',
    purpose:
      'Every target range recorded, with who set it and when. The app ships none and infers none, so this file is empty unless a person entered one.',
    columns: [
      { key: 'metric_key', header: 'metric_key', description: 'Which measurement the target applies to.' },
      { key: 'field', header: 'field', description: 'Which number of that measurement (v1, v2, v3 — see readings.csv for what each holds).' },
      { key: 'low', header: 'low', description: 'Lower bound. Blank when only an upper bound was set.' },
      { key: 'high', header: 'high', description: 'Upper bound. Blank when only a lower bound was set.' },
      { key: 'applies_when', header: 'applies_when', description: 'Circumstances it applies to, such as meal=fasting. Blank means it is the fallback for every circumstance.' },
      { key: 'set_by', header: 'set_by', description: 'The named person who set it. Never the app.' },
      { key: 'set_on', header: 'set_on', description: 'The date they set it (YYYY-MM-DD).' },
    ],
    rows,
  };
}

function medChangesSheet(changes: readonly ReportMedChange[]): CsvSheet {
  const rows: CsvValue[][] = changes.map((change) => [
    change.localDate,
    change.kind,
    change.detail,
    change.threadId,
  ]);

  return {
    name: 'medicine-changes',
    title: 'Medicine changes',
    purpose: 'When a medicine was started, stopped, resumed, or its dose or timing changed.',
    columns: [
      { key: 'local_date', header: 'local_date', description: 'Date of the change (YYYY-MM-DD).' },
      { key: 'kind', header: 'kind', description: 'started, stopped, dose_changed, time_changed, resumed or prescription.' },
      { key: 'detail', header: 'detail', description: 'What was recorded about it, if anything.' },
      { key: 'thread_id', header: 'thread_id', description: 'Which drug it applies to. Matches thread_id in medicines.csv.' },
    ],
    rows,
  };
}

function visitsSheet(data: ExportData): CsvSheet {
  const rows: CsvValue[][] = data.visits.map((visit) => [
    visit.id,
    visit.visitedOn,
    visit.doctor,
    visit.clinic,
    visit.notes,
  ]);

  return {
    name: 'visits',
    title: 'Visits',
    purpose: 'Consultations the patient recorded.',
    columns: [
      { key: 'visit_id', header: 'visit_id', description: 'Identifier of the visit.' },
      { key: 'visited_on', header: 'visited_on', description: 'Date of the visit (YYYY-MM-DD).' },
      { key: 'doctor', header: 'doctor', description: 'Doctor seen, as recorded.' },
      { key: 'clinic', header: 'clinic', description: 'Clinic or hospital, as recorded.' },
      { key: 'notes', header: 'notes', description: 'Notes the patient wrote afterwards.' },
    ],
    rows,
  };
}

function questionsSheet(data: ExportData): CsvSheet {
  const rows: CsvValue[][] = data.questions.map((question) => [question.id, question.text, question.origin]);

  return {
    name: 'questions',
    title: 'Questions for the doctor',
    purpose: 'The running list the patient adds to between appointments.',
    columns: [
      { key: 'question_id', header: 'question_id', description: 'Identifier of the question.' },
      { key: 'text', header: 'text', description: 'The question.' },
      { key: 'origin', header: 'origin', description: 'user when the patient wrote it, auto when the app suggested it. An auto question is the app\'s wording, not hers.' },
    ],
    rows,
  };
}

function careSheet(data: ExportData): CsvSheet {
  const rows: CsvValue[][] = data.care.map((event) => [
    event.id,
    event.kind,
    event.title,
    event.dueOn,
    event.anchorSource,
    event.status,
  ]);

  return {
    name: 'care-plan',
    title: 'Appointments and tests',
    purpose: 'Follow-ups, tests and refills, with where each date came from.',
    columns: [
      { key: 'care_id', header: 'care_id', description: 'Identifier of the item.' },
      { key: 'kind', header: 'kind', description: 'visit, book_appointment, test_book, test_do, test_collect, refill or custom.' },
      { key: 'title', header: 'title', description: 'What it is.' },
      { key: 'due_on', header: 'due_on', description: 'The date it is due (YYYY-MM-DD).' },
      { key: 'anchor_source', header: 'anchor_source', description: 'transcribed = the doctor wrote this date on the prescription. inferred = the app worked it out by applying an offset of its own. manual = the patient typed it. Only transcribed rows are evidence of what a doctor said.' },
      { key: 'status', header: 'status', description: 'pending, done, dismissed or superseded.' },
    ],
    rows,
  };
}

// ── README ───────────────────────────────────────────────────────────────────

const README_COLUMNS: CsvColumn[] = [
  { key: 'file', header: 'file', description: 'Which file the column belongs to.' },
  { key: 'column', header: 'column', description: 'The column name as it appears in that file\'s header row.' },
  { key: 'meaning', header: 'meaning', description: 'What the column holds.' },
];

/**
 * The README is generated FROM the column definitions above, not written alongside them.
 *
 * A hand-maintained README drifts the first time a column is added under time pressure,
 * and a data dictionary that is wrong is worse than none: it makes a reader confident
 * about the wrong column. Generating it means the two cannot disagree.
 */
export function buildReadmeSheet(sheets: readonly CsvSheet[], data: ExportData): CsvSheet {
  const rows: CsvValue[][] = [];

  rows.push(['(about)', 'exported_for', data.patient.displayName]);
  rows.push(['(about)', 'period', `${data.range.fromDate} to ${data.range.toDate}`]);
  rows.push(['(about)', 'exported_at_epoch', String(data.generatedOnEpoch)]);
  rows.push(['(about)', 'exported_by', 'Aarogya, on the phone. Nothing was uploaded anywhere to produce this.']);
  rows.push(['(about)', 'adherence_note', data.adherenceDisclaimer]);
  rows.push([
    '(about)',
    'no_record_note',
    'A dose with nothing recorded either way is missing information, not a record of a dose not taken. No word in this export claims otherwise, because the app knows what was tapped and not what was swallowed.',
  ]);
  rows.push([
    '(about)',
    'yes_no_note',
    'Columns that hold yes or no are written as the words "yes" and "no", not as 1 and 0.',
  ]);
  // Stated at the top as well as against the column, because the single most likely
  // misuse of this export is averaging a glucose column that contains an emergency the
  // meter refused to put a number on.
  rows.push([
    '(about)',
    'lo_hi_note',
    'A meter that printed LO or HI produced an inequality, not a number: readings.csv leaves value blank for those rows and records the direction in value_qualifier and the meter\'s limit in qualifier_bound. Do not substitute the limit for the value. It biases any average towards the middle, and it does so in the direction that makes a hypoglycaemic or very high reading look milder than it was.',
  ]);
  rows.push([
    '(about)',
    'timezone_note',
    'Every record carries both a local date and time (as the phone showed it at the moment of recording) and an absolute at_epoch. Use at_epoch to sort, and the local columns to group by day.',
  ]);

  for (const sheet of sheets) {
    rows.push([`${sheet.name}.csv`, '(what it holds)', sheet.purpose]);
    for (const column of sheet.columns) {
      rows.push([`${sheet.name}.csv`, column.header, column.description]);
    }
  }

  return {
    name: 'README',
    title: 'What is in these files',
    purpose: 'Explains every column of every file in this export.',
    columns: README_COLUMNS,
    rows,
  };
}

// ── Bundle ───────────────────────────────────────────────────────────────────

/** Every record type, in the order a reader is most likely to want them. */
export function buildCsvSheets(data: ExportData): CsvSheet[] {
  return [
    readingsSheet(data.readings),
    dosesSheet(data.doses),
    medicinesSheet(data.medicines),
    schedulesSheet(data.medicines),
    symptomsSheet(data.symptoms),
    labsSheet(data.labs),
    targetsSheet(data.targets),
    medChangesSheet(data.medChanges),
    visitsSheet(data),
    questionsSheet(data),
    careSheet(data),
  ];
}

/**
 * The complete export: one CSV per record type, plus the generated README.
 *
 * The README is FIRST in the returned array so that a file manager sorting by insertion
 * order, and a share sheet listing attachments, both put it where a reader looks first.
 */
export function buildCsvBundle(data: ExportData, options: CsvOptions = {}): CsvFile[] {
  const sheets = buildCsvSheets(data);
  const readme = buildReadmeSheet(sheets, data);
  return [readme, ...sheets].map((sheet) => ({
    name: `${sheet.name}.csv`,
    content: sheetToCsv(sheet, options),
  }));
}
