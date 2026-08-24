/**
 * Tests for the CSV writer.
 *
 * The writer is tested and the rest of the export layer is not, for the same reason
 * `src/features/adherence/compute.ts` is the tested half of adherence: this is the piece
 * that is pure, that has no database under it, and that quietly corrupts a record when it
 * is wrong. A misplaced quote does not throw — it produces a file that opens, looks
 * plausible, and has a patient's note in the wrong column.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy. It is the same shape as
 * `src/features/adherence/adherence.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './csv.ts';
const {
  buildCsvBundle,
  buildCsvSheets,
  buildReadmeSheet,
  csvCell,
  csvLine,
  needsFormulaGuard,
  sheetToCsv,
  toCsv,
  CSV_LINE_ENDING,
  UTF8_BOM,
} = (await import(MODULE)) as typeof import('./csv');

type ExportData = import('../data/types').ExportData;
type ReportReading = import('../data/types').ReportReading;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function reading(overrides: Partial<ReportReading> = {}): ReportReading {
  return {
    id: 'r1',
    metricKey: 'bp',
    metricLabel: 'Blood pressure',
    unit: 'mmHg',
    localDate: '2026-08-09',
    localTime: '08:10',
    atEpoch: 1_786_000_000_000,
    fields: [
      { slot: 'v1', key: 'systolic', label: 'Upper number', value: 142 },
      { slot: 'v2', key: 'diastolic', label: 'Lower number', value: 88 },
      { slot: 'v3', key: 'pulse', label: 'Pulse', value: null },
    ],
    primarySlot: 'v1',
    qualifier: 'exact',
    qualifierBound: null,
    context: null,
    contextLabel: null,
    note: null,
    wasBackfilled: false,
    source: 'manual',
    editedCount: 0,
    ...overrides,
  };
}

function exportData(overrides: Partial<ExportData> = {}): ExportData {
  return {
    generatedOnEpoch: 1_786_000_000_000,
    range: { fromDate: '2026-08-03', toDate: '2026-08-09' },
    patient: {
      displayName: 'Kamla Devi',
      ageYears: 71,
      sex: 'female',
      bloodGroup: 'B+',
      conditions: ['High blood pressure'],
    },
    adherenceDisclaimer: 'Self-reported in app. Records interaction with the app, not medication taken.',
    readings: [reading()],
    targets: [],
    medicines: [],
    doses: [],
    symptoms: [],
    labs: [],
    questions: [],
    medChanges: [],
    visits: [],
    care: [],
    ...overrides,
  };
}

// ── Cell quoting ─────────────────────────────────────────────────────────────

test('a plain value is written bare', () => {
  assert.equal(csvCell('Metformin'), 'Metformin');
  assert.equal(csvCell(142), '142');
  assert.equal(csvCell(61.4), '61.4');
});

test('nothing is written for a missing value, and never the word null', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(''), '');
});

test('booleans are the words a person reads, not 1 and 0', () => {
  assert.equal(csvCell(true), 'yes');
  assert.equal(csvCell(false), 'no');
});

test('a value that is not a finite number is written as blank rather than as NaN', () => {
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(Number.POSITIVE_INFINITY), '');
});

test('a comma is quoted rather than allowed to split the row', () => {
  assert.equal(csvCell('Metformin, 500 mg'), '"Metformin, 500 mg"');
});

test('a quote is doubled inside quotes', () => {
  assert.equal(csvCell('she said "no"'), '"she said ""no"""');
});

test('a newline inside a note is preserved, quoted', () => {
  // A patient's note is free text and genuinely contains line breaks. Stripping them
  // would edit her words; leaving them unquoted would break the file.
  assert.equal(csvCell('felt dizzy\nthen better'), '"felt dizzy\nthen better"');
  assert.equal(csvCell('carriage\r\nreturn'), '"carriage\r\nreturn"');
});

test('leading and trailing spaces are preserved by quoting', () => {
  assert.equal(csvCell(' 500 '), '" 500 "');
});

test('Devanagari passes through untouched', () => {
  assert.equal(csvCell('चक्कर आना'), 'चक्कर आना');
});

// ── Formula injection ────────────────────────────────────────────────────────

test('a cell that a spreadsheet would evaluate is neutralised', () => {
  assert.ok(needsFormulaGuard('=SUM(A1:A9)'));
  assert.ok(needsFormulaGuard('@import'));
  assert.ok(needsFormulaGuard('+1+1'));
  assert.ok(needsFormulaGuard('\tstarts with a tab'));
  assert.equal(csvCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
});

test('a negative number is left exactly as it is', () => {
  // Guarding every leading hyphen would corrupt real data — a delay of -5 minutes, a
  // change of -0.25 kg — to defend against a formula that cannot occur in those columns.
  assert.equal(needsFormulaGuard('-5'), false);
  assert.equal(needsFormulaGuard('-0.25'), false);
  assert.equal(csvCell('-5'), '-5');
  assert.equal(csvCell(-5), '-5');
});

test('text that begins with a hyphen but is not a number is still guarded', () => {
  assert.ok(needsFormulaGuard('-cmd|calc'));
  assert.equal(csvCell('-cmd|calc'), "'-cmd|calc");
});

test('an empty string needs no guard', () => {
  assert.equal(needsFormulaGuard(''), false);
});

// ── Rows and files ───────────────────────────────────────────────────────────

test('a row is comma separated with every cell escaped', () => {
  assert.equal(csvLine(['a', 'b,c', null, 3]), 'a,"b,c",,3');
});

test('a file starts with the header row and uses CRLF endings', () => {
  const csv = toCsv(['one', 'two'], [[1, 2]], { bom: false });
  assert.equal(csv, `one,two${CSV_LINE_ENDING}1,2${CSV_LINE_ENDING}`);
});

test('the byte-order mark is written by default, so Excel reads Hindi correctly', () => {
  const csv = toCsv(['note'], [['चक्कर आना']]);
  assert.ok(csv.startsWith(UTF8_BOM));
  assert.equal(UTF8_BOM.charCodeAt(0), 0xfeff);
});

test('the byte-order mark can be switched off for machine consumers', () => {
  assert.equal(toCsv(['a'], [], { bom: false }).startsWith(UTF8_BOM), false);
});

test('a sheet writes its column headers, in order', () => {
  const sheets = buildCsvSheets(exportData());
  const readings = sheets.find((sheet) => sheet.name === 'readings');
  assert.ok(readings);
  const firstLine = sheetToCsv(readings, { bom: false }).split(CSV_LINE_ENDING)[0];
  assert.equal(firstLine, readings.columns.map((column) => column.header).join(','));
});

// ── Long format ──────────────────────────────────────────────────────────────

test('a blood pressure becomes one row per number, not one row with three columns', () => {
  const sheets = buildCsvSheets(exportData());
  const readings = sheets.find((sheet) => sheet.name === 'readings');
  assert.ok(readings);
  // Pulse was not recorded, so two of the three fields produce rows.
  assert.equal(readings.rows.length, 2);
  const fieldColumn = readings.columns.findIndex((column) => column.header === 'field_key');
  assert.deepEqual(
    readings.rows.map((row) => row[fieldColumn]),
    ['systolic', 'diastolic'],
  );
});

test('a LO/HI reading keeps its row even though it has no number', () => {
  // This is the single most clinically loud result the app can hold. Dropping it because
  // the value column is empty would delete the reading a doctor would act on fastest.
  const sheets = buildCsvSheets(
    exportData({
      readings: [
        reading({
          qualifier: 'below_range',
          fields: [
            { slot: 'v1', key: 'glucose', label: 'Blood sugar', value: null },
          ],
          metricKey: 'glucose',
        }),
      ],
    }),
  );
  const readings = sheets.find((sheet) => sheet.name === 'readings');
  assert.ok(readings);
  assert.equal(readings.rows.length, 1);
  const qualifierColumn = readings.columns.findIndex((column) => column.header === 'value_qualifier');
  assert.equal(readings.rows[0]?.[qualifierColumn], 'below_range');
});

test('the meter\'s limit is exported in its own column and never as the value', () => {
  // The whole risk this column carries: a reader — or a future edit — treating 20 as a
  // measurement. `value` must stay blank on the same row, forever.
  const sheets = buildCsvSheets(
    exportData({
      readings: [
        reading({
          metricKey: 'glucose',
          qualifier: 'below_range',
          qualifierBound: 20,
          fields: [{ slot: 'v1', key: 'glucose', label: 'Blood sugar', value: null }],
        }),
      ],
    }),
  );
  const readings = sheets.find((sheet) => sheet.name === 'readings');
  assert.ok(readings);
  const valueColumn = readings.columns.findIndex((column) => column.header === 'value');
  const boundColumn = readings.columns.findIndex((column) => column.header === 'qualifier_bound');
  assert.ok(boundColumn >= 0);
  assert.equal(readings.rows[0]?.[valueColumn], null);
  assert.equal(readings.rows[0]?.[boundColumn], 20);

  // And an ordinary reading carries no bound at all — a bound on an exact reading would
  // be a meter limit attached to a number the meter actually produced.
  const ordinary = buildCsvSheets(exportData({ readings: [reading()] }));
  const ordinaryReadings = ordinary.find((sheet) => sheet.name === 'readings');
  assert.ok(ordinaryReadings);
  assert.equal(ordinaryReadings.rows[0]?.[boundColumn], null);
});

test('the README explains the LO/HI columns without being hand-written', () => {
  const sheets = buildCsvSheets(exportData({ readings: [reading()] }));
  const readme = buildReadmeSheet(sheets, exportData({ readings: [reading()] }));
  const flat = readme.rows.map((row) => row.join(' ')).join('\n');
  assert.match(flat, /qualifier_bound/);
  // The instruction that stops the column being misused has to survive into the file a
  // researcher actually opens, not just live in a code comment.
  assert.match(flat, /Do not substitute the limit for the value/);
});

test('was_backfilled and edited_count are both exported', () => {
  const sheets = buildCsvSheets(exportData({ readings: [reading({ wasBackfilled: true, editedCount: 2 })] }));
  const readings = sheets.find((sheet) => sheet.name === 'readings');
  assert.ok(readings);
  const headers = readings.columns.map((column) => column.header);
  assert.ok(headers.includes('was_backfilled'));
  assert.ok(headers.includes('edited_count'));

  const csv = sheetToCsv(readings, { bom: false });
  assert.match(csv, /,yes,manual,2/);
});

// ── The bundle and its README ────────────────────────────────────────────────

test('the bundle leads with the README and every file is a .csv', () => {
  const files = buildCsvBundle(exportData());
  assert.equal(files[0]?.name, 'README.csv');
  for (const file of files) assert.match(file.name, /\.csv$/);
});

test('the README explains every column of every file', () => {
  // The whole point of generating it from the column definitions: it cannot fall behind.
  const data = exportData();
  const sheets = buildCsvSheets(data);
  const readme = buildReadmeSheet(sheets, data);
  const described = new Set(readme.rows.map((row) => `${String(row[0])}|${String(row[1])}`));

  for (const sheet of sheets) {
    for (const column of sheet.columns) {
      assert.ok(
        described.has(`${sheet.name}.csv|${column.header}`),
        `README does not explain ${sheet.name}.csv → ${column.header}`,
      );
    }
  }
});

test('the README carries the adherence disclaimer verbatim', () => {
  const data = exportData();
  const readme = buildReadmeSheet(buildCsvSheets(data), data);
  const values = readme.rows.map((row) => String(row[2]));
  assert.ok(values.includes(data.adherenceDisclaimer));
});

test('one file exists per record type, and each is named after it', () => {
  const names = buildCsvSheets(exportData()).map((sheet) => sheet.name);
  for (const expected of [
    'readings',
    'doses',
    'medicines',
    'schedules',
    'symptoms',
    'labs',
    'targets',
    'medicine-changes',
    'visits',
    'questions',
    'care-plan',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}.csv`);
  }
});

test('the export never uses the word "missed" anywhere, including in its own documentation', () => {
  // The app knows what was tapped. It does not know what was swallowed.
  const everything = buildCsvBundle(exportData())
    .map((file) => file.content)
    .join('\n');
  assert.doesNotMatch(everything, /\bmissed\b/i);
});

test('an empty record still produces a complete, readable bundle', () => {
  const files = buildCsvBundle(
    exportData({ readings: [], doses: [], medicines: [], symptoms: [], labs: [] }),
  );
  assert.ok(files.length > 1);
  for (const file of files) {
    // Header row plus the trailing line ending: never a zero-byte file with no columns.
    assert.ok(file.content.length > 0);
    assert.ok(file.content.includes(CSV_LINE_ENDING));
  }
});
