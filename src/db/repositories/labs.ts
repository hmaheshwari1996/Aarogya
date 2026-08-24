/**
 * Lab results — the `lab_test_def` registry, its per-pack mapping, and `lab_result`.
 *
 * TWO RULES RUN THROUGH THIS WHOLE FILE:
 *
 *  1. `ref_range_text` is TRANSCRIBED, NEVER ASSERTED. It is whatever the paper report
 *     printed, character for character. This app does not know the assay, the analyser,
 *     the units convention or the population the lab calibrated against, and a reference
 *     range that looks plausible but belongs to a different method is how a normal result
 *     gets read as abnormal. Nothing below fills it in, defaults it, infers it from the
 *     test key, or copies it forward from an earlier result — if the report did not print
 *     one, the column stays NULL and the UI says so.
 *
 *  2. `source = 'ocr'` means a machine read it, and a machine-read row is UNCONFIRMED
 *     until a human sets `confirmed_at`. `listUnconfirmedLabResults` is that review queue.
 *
 * `lab_test_def` and `pack_lab_test` are shipped reference data with no `deleted_at_epoch`;
 * the soft-delete filter applies to `lab_result`.
 */

import {
  createRecord,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Public shapes ────────────────────────────────────────────────────────────

export type LabSource = 'manual' | 'ocr';

export type LabTestDef = {
  key: string;
  labelEn: string;
  labelHi: string;
  unit: string | null;
  sortOrder: number;
};

export type LabResult = {
  id: string;
  profileId: string;
  testKey: string | null;
  customLabel: string | null;
  /** Always the value AS PRINTED, numeric or not. */
  valueText: string | null;
  /** Set only when the printed value is a plain number — this is what charts read. */
  valueNum: number | null;
  unit: string | null;
  /** Transcribed from the report. Never generated. See the file header. */
  refRangeText: string | null;
  collectedOn: string | null;
  labName: string | null;
  reportUri: string | null;
  source: LabSource;
  /** NULL on an OCR row until a human has checked it against the paper. */
  confirmedAt: number | null;
};

/** Same one-identity rule as symptom_event: a known test key, or free text. Never both. */
type LabIdentity =
  | { testKey: string; customLabel?: never }
  | { customLabel: string; testKey?: never };

export type CreateLabResultInput = LabIdentity & {
  profileId: string;
  /** The value exactly as the report printed it: '5.6', 'Negative', 'Trace', '<0.01'. */
  value?: string | null;
  unit?: string | null;
  /** Transcribed from the report, or omitted. There is no third option. */
  refRangeText?: string | null;
  /** 'YYYY-MM-DD'. Left NULL when unknown — a guessed collection date is not evidence. */
  collectedOn?: string | null;
  labName?: string | null;
  reportUri?: string | null;
  source?: LabSource;
};

/** Omitting both identity keys leaves the existing one alone; setting one clears the other. */
export type LabResultPatch = {
  value?: string | null;
  unit?: string | null;
  refRangeText?: string | null;
  collectedOn?: string | null;
  labName?: string | null;
  reportUri?: string | null;
} & (
  | { testKey: string; customLabel?: never }
  | { customLabel: string; testKey?: never }
  | { testKey?: never; customLabel?: never }
);

export type LabResultFilter = {
  testKey?: string;
  limit?: number;
};

// ── Row types & mappers ──────────────────────────────────────────────────────

type LabTestDefRow = {
  key: string;
  label_en: string;
  label_hi: string;
  unit: string | null;
  sort_order: number;
};

type LabResultRow = {
  id: string;
  profile_id: string;
  test_key: string | null;
  custom_label: string | null;
  value_text: string | null;
  value_num: number | null;
  unit: string | null;
  ref_range_text: string | null;
  collected_on: string | null;
  lab_name: string | null;
  report_uri: string | null;
  source: string;
  confirmed_at: number | null;
};

function mapLabTestDef(row: LabTestDefRow): LabTestDef {
  return {
    key: row.key,
    labelEn: row.label_en,
    labelHi: row.label_hi,
    unit: row.unit,
    sortOrder: row.sort_order,
  };
}

function mapLabResult(row: LabResultRow): LabResult {
  return {
    id: row.id,
    profileId: row.profile_id,
    testKey: row.test_key,
    customLabel: row.custom_label,
    valueText: row.value_text,
    valueNum: row.value_num,
    unit: row.unit,
    refRangeText: row.ref_range_text,
    collectedOn: row.collected_on,
    labName: row.lab_name,
    reportUri: row.report_uri,
    // The column's CHECK constraint is what makes this cast safe.
    source: row.source as LabSource,
    confirmedAt: row.confirmed_at,
  };
}

const DEF_COLUMNS = 'key, label_en, label_hi, unit, sort_order';

const RESULT_COLUMNS = `id, profile_id, test_key, custom_label, value_text, value_num, unit,
     ref_range_text, collected_on, lab_name, report_uri, source, confirmed_at`;

// A result with no collection date has nothing to sort by, and SQLite orders NULL last
// under DESC — exactly where an undated result belongs. created_at_epoch breaks ties so
// two results from the same report keep the order they were entered in.
const RESULT_ORDER = 'ORDER BY collected_on DESC, created_at_epoch DESC';

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listLabTestDefs(tx?: Tx): Promise<LabTestDef[]> {
  const rows = await queryAll<LabTestDefRow>(
    `SELECT ${DEF_COLUMNS} FROM lab_test_def ORDER BY sort_order, label_en;`,
    [],
    tx,
  );
  return rows.map(mapLabTestDef);
}

export async function listLabTestsForPack(packKey: string, tx?: Tx): Promise<LabTestDef[]> {
  const rows = await queryAll<LabTestDefRow>(
    `SELECT ${DEF_COLUMNS}
       FROM lab_test_def
      WHERE key IN (SELECT test_key FROM pack_lab_test WHERE pack_key = ?)
      ORDER BY sort_order, label_en;`,
    [packKey],
    tx,
  );
  return rows.map(mapLabTestDef);
}

export async function listLabResults(
  profileId: string,
  filter: LabResultFilter = {},
  tx?: Tx,
): Promise<LabResult[]> {
  const conditions = ['profile_id = ?', 'deleted_at_epoch IS NULL'];
  const params: Bind[] = [profileId];

  if (filter.testKey !== undefined) {
    conditions.push('test_key = ?');
    params.push(filter.testKey);
  }

  let sql = `SELECT ${RESULT_COLUMNS}
       FROM lab_result
      WHERE ${conditions.join(' AND ')}
      ${RESULT_ORDER}`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }

  const rows = await queryAll<LabResultRow>(`${sql};`, params, tx);
  return rows.map(mapLabResult);
}

/**
 * The OCR review queue.
 *
 * Manual entries are stamped confirmed at creation (a human typed them, so they are
 * already checked), which makes `confirmed_at IS NULL` exactly the set of machine-read
 * rows nobody has looked at yet.
 */
export async function listUnconfirmedLabResults(profileId: string, tx?: Tx): Promise<LabResult[]> {
  const rows = await queryAll<LabResultRow>(
    `SELECT ${RESULT_COLUMNS}
       FROM lab_result
      WHERE profile_id = ? AND deleted_at_epoch IS NULL AND confirmed_at IS NULL
      ${RESULT_ORDER};`,
    [profileId],
    tx,
  );
  return rows.map(mapLabResult);
}

export async function getLabResult(id: string, tx?: Tx): Promise<LabResult | null> {
  const row = await queryFirst<LabResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM lab_result WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapLabResult(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createLabResult(input: CreateLabResultInput, tx?: Tx): Promise<string> {
  const identity = resolveIdentity(input.testKey, input.customLabel);
  const value = splitValue(input.value);
  const source: LabSource = input.source ?? 'manual';

  return createRecord(
    'lab_result',
    {
      profile_id: input.profileId,
      test_key: identity.testKey,
      custom_label: identity.customLabel,
      value_text: value.text,
      value_num: value.num,
      unit: nonEmpty(input.unit),
      // Transcription only. If the caller has nothing, this stays NULL — we never fill it.
      ref_range_text: nonEmpty(input.refRangeText),
      collected_on: nonEmpty(input.collectedOn),
      lab_name: nonEmpty(input.labName),
      report_uri: input.reportUri ?? null,
      source,
      // A manual row was typed by the person reading the report, so it is confirmed by
      // construction. An OCR row is not, and must stay NULL until confirmLabResult().
      confirmed_at: source === 'manual' ? nowEpoch() : null,
    },
    tx,
  );
}

export async function updateLabResult(id: string, patch: LabResultPatch, tx?: Tx): Promise<void> {
  const values: Record<string, Bind> = {};

  if (patch.testKey !== undefined) {
    values['test_key'] = requireNonEmpty(patch.testKey, 'testKey');
    values['custom_label'] = null;
  } else if (patch.customLabel !== undefined) {
    values['custom_label'] = requireNonEmpty(patch.customLabel, 'customLabel');
    values['test_key'] = null;
  }

  if (patch.value !== undefined) {
    const value = splitValue(patch.value);
    values['value_text'] = value.text;
    // Cleared together with the text: a stale value_num left behind after the text was
    // corrected to 'Negative' would keep plotting the old number on the chart.
    values['value_num'] = value.num;
  }
  if (patch.unit !== undefined) values['unit'] = nonEmpty(patch.unit);
  // Editable because transcription can be mistyped — not because the app may supply one.
  if (patch.refRangeText !== undefined) values['ref_range_text'] = nonEmpty(patch.refRangeText);
  if (patch.collectedOn !== undefined) values['collected_on'] = nonEmpty(patch.collectedOn);
  if (patch.labName !== undefined) values['lab_name'] = nonEmpty(patch.labName);
  if (patch.reportUri !== undefined) values['report_uri'] = patch.reportUri ?? null;

  await updateRecord('lab_result', id, values, tx);
}

/** A human has checked this row against the paper report. */
export async function confirmLabResult(id: string, tx?: Tx): Promise<void> {
  await updateRecord('lab_result', id, { confirmed_at: nowEpoch() }, tx);
}

/** Soft delete. A hard DELETE on this table is refused by trg_lab_no_hard_delete. */
export async function deleteLabResult(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('lab_result', id, tx);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `value_text` and `value_num` coexist because most lab results are not numbers.
 * 'Negative', 'Trace', 'Nil', 'Not detected', '<0.01' are all real printed results, and
 * none of them can be charted — but all of them have to be storable and readable back
 * verbatim on the OPD report.
 *
 * So: `value_text` ALWAYS holds what the report printed. `value_num` is added only when
 * the printed value is a plain number, and it is the only column the charts read.
 */
function splitValue(raw: string | null | undefined): { text: string | null; num: number | null } {
  const text = nonEmpty(raw);
  if (text === null) return { text: null, num: null };
  return { text, num: strictNumber(text) };
}

/** Deliberately strict — no exponent, no thousands separators, no trailing junk. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/**
 * parseFloat is the wrong tool here: parseFloat('12 something') is 12, and a
 * half-understood value silently becomes a chart point. Refusing to parse anything that
 * is not a bare number keeps the text-only path — which renders the value exactly as
 * printed — as the fallback for everything ambiguous.
 */
function strictNumber(text: string): number | null {
  if (!PLAIN_NUMBER.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireNonEmpty(value: string, what: string): string {
  const trimmed = nonEmpty(value);
  if (trimmed === null) throw new Error(`${what} cannot be blank.`);
  return trimmed;
}

/** Re-checked at runtime because the OCR path is not type-checked against this union. */
function resolveIdentity(
  testKey: string | undefined,
  customLabel: string | undefined,
): { testKey: string | null; customLabel: string | null } {
  const key = testKey === undefined ? null : requireNonEmpty(testKey, 'testKey');
  const label = customLabel === undefined ? null : requireNonEmpty(customLabel, 'customLabel');
  if ((key === null) === (label === null)) {
    throw new Error('A lab result needs exactly one of testKey or customLabel, not both and not neither.');
  }
  return { testKey: key, customLabel: label };
}
