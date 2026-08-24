/**
 * Domain types — the shared contract. These mirror `src/db/migrations.ts` exactly.
 * If you change a column, change it here in the same commit.
 */

export type Criticality = 'critical' | 'standard' | 'low';
export type ValueQualifier = 'exact' | 'below_range' | 'above_range';
export type MedicineStatus = 'active' | 'stopped' | 'superseded';
export type ScheduleType = 'FIXED' | 'PRN';

export type OccurrenceStatus =
  | 'pending'
  | 'taken'
  | 'skipped'
  | 'snoozed'
  | 'cancelled'
  /** Scheduled time passed with no record either way. NOT the same as "missed". */
  | 'no_record';

export type DoseEventKind =
  | 'delivered'
  | 'taken'
  | 'skipped'
  | 'snoozed'
  | 'cancelled'
  | 'dismissed'
  | 'prn_taken'
  | 'rearmed'
  | 'receiver_error';

export type DoseEventOrigin = 'app' | 'notification' | 'widget' | 'native' | 'watchdog';

export type Profile = {
  id: string;
  displayName: string;
  yearOfBirth: number | null;
  sex: 'female' | 'male' | 'other' | 'unstated' | null;
  bloodGroup: string | null;
  isDefault: boolean;
};

export type MetricValueKind = 'scalar' | 'pair' | 'triple' | 'ordinal' | 'boolean';

/** Describes a metric's fields so UI, charts and reports are data-driven, not switch-driven. */
export type MetricSchema = {
  fields: {
    slot: 'v1' | 'v2' | 'v3';
    key: string;
    labelEn: string;
    labelHi: string;
    /** INSTRUMENT limits, never clinical plausibility. */
    min: number;
    max: number;
    /** Values outside this trigger a soft "did you mean?" confirmation, never a refusal. */
    softMin?: number;
    softMax?: number;
  }[];
  primaryField: 'v1' | 'v2' | 'v3';
  /** e.g. glucose meal context. Presented as large chips, never a dropdown. */
  context?: {
    key: string;
    labelEn: string;
    labelHi: string;
    options: { value: string; labelEn: string; labelHi: string; affectsTarget: boolean }[];
  };
};

export type MetricDef = {
  key: string;
  labelEn: string;
  labelHi: string;
  unit: string;
  valueKind: MetricValueKind;
  schema: MetricSchema;
  chartKind: 'scatter' | 'line' | 'bar' | 'none';
  isBuiltin: boolean;
  sortOrder: number;
};

export type Reading = {
  id: string;
  profileId: string;
  metricKey: string;
  v1: number | null;
  v2: number | null;
  v3: number | null;
  valueQualifier: ValueQualifier;
  /**
   * The limit of the instrument's measuring range at the moment this was entered, and
   * ONLY on a reading whose qualifier is not 'exact'.
   *
   * A meter showing LO asserted `value < qualifierBound`; showing HI, `value > qualifierBound`.
   * It is an inequality the instrument produced, not a measurement — which is why it has
   * a column of its own instead of being written into `v1`, and why a database trigger
   * refuses any row that carries both. NULL means the meter's range was never recorded;
   * that is a supported state, and the reading is still complete.
   *
   * Anything that prints this must print it as an inequality ("< 20 mg/dL", "Meter showed
   * LO"). A bare number here is indistinguishable from a measurement to whoever reads it
   * next.
   */
  qualifierBound: number | null;
  context: Record<string, string> | null;
  note: string | null;
  atEpoch: number;
  localDate: string;
  localTime: string;
  wasBackfilled: boolean;
  source: 'manual' | 'ocr' | 'import' | 'device';
  editedCount: number;
};

export type TargetRange = {
  id: string;
  profileId: string;
  metricKey: string;
  context: Record<string, string> | null;
  field: 'v1' | 'v2' | 'v3';
  low: number | null;
  high: number | null;
  /** Named human + date. Printed in every chart legend. The app never invents one. */
  setByLabel: string;
  setOn: string;
};

export type Medicine = {
  id: string;
  /** Stable identity of "this drug" across versions. Adherence history hangs off this. */
  threadId: string;
  version: number;
  profileId: string;
  nameAsWritten: string;
  genericGuess: string | null;
  strength: string | null;
  form: string | null;
  criticality: Criticality;
  criticalityProposed: Criticality | null;
  criticalityReason: string | null;
  status: MedicineStatus;
  stopReason: string | null;
  startedOn: string | null;
  stoppedOn: string | null;
  source: 'manual' | 'ai';
  prescriptionId: string | null;
  stripPhotoUri: string | null;
  /** NULL means no human has confirmed this. A DB trigger refuses to schedule it. */
  confirmedByUserAt: number | null;
};

export type DoseSchedule = {
  id: string;
  medicineId: string;
  threadId: string;
  version: number;
  scheduleType: ScheduleType;
  /** WALL CLOCK 'HH:MM'. Never an absolute timestamp. Null for PRN. */
  timeLocal: string | null;
  slotKey: string | null;
  /** 7-bit field, bit 0 = Monday. */
  daysMask: number;
  intervalDays: number;
  quantityValue: number | null;
  quantityUnit: string | null;
  quantityText: string | null;
  foodRelation: 'before' | 'after' | 'with' | 'empty' | 'any' | null;
  startedOn: string;
  stoppedOn: string | null;
  /** Separate from the medicine's confirmation — frequency errors are the dangerous ones. */
  confirmedByUserAt: number | null;
};

export type DoseOccurrence = {
  id: string;
  profileId: string;
  medicineId: string;
  threadId: string;
  doseScheduleId: string;
  localDate: string;
  /** The schedule's SLOT time and part of the occurrence id. Stable; the override moves the ring, not this. */
  timeLocal: string;
  /**
   * A per-day exception to `timeLocal` for THIS occurrence only — 'HH:MM' wall clock, or null
   * to ring at the slot time. Set via `setOccurrenceTimeOverride`; `scheduled_at_epoch` is
   * re-derived from `overrideTimeLocal ?? timeLocal`. It moves one occurrence and leaves the
   * schedule (and every other day's dose) untouched — no second dose is ever created.
   */
  overrideTimeLocal: string | null;
  scheduledAtEpoch: number;
  /** DERIVED CACHE. Recomputed by deriveStatus(). Never the source of truth. */
  status: OccurrenceStatus;
  channelId: string;
};

export type DoseEvent = {
  id: string;
  occurrenceId: string;
  threadId: string;
  medicineId: string | null;
  profileId: string;
  event: DoseEventKind;
  atEpoch: number;
  localDate: string;
  payload: Record<string, unknown> | null;
  origin: DoseEventOrigin;
};

/**
 * The rules file handed to the native alarm layer.
 *
 * RULES, NOT MATERIALISED DATES. The Kotlin boot receiver expands these forward
 * indefinitely on its own. A list of pre-computed dates would run out on day 8 for a
 * user who never opens the app — which is exactly the user this app is designed for.
 */
export type AlarmRule = {
  threadId: string;
  medicineId: string;
  title: string;
  body: string;
  timeLocal: string;
  daysMask: number;
  intervalDays: number;
  startedOn: string;
  stoppedOn: string | null;
  channelId: string;
  critical: boolean;
  /** Minutes after the scheduled time to re-ping if nothing was recorded. */
  escalateAfterMin: number[];
};

/**
 * A one-off per-date time move for a single occurrence. The native layer SHIFTS the
 * matching occurrence's ring to `overrideTimeLocal` on that date only — it never adds a
 * second alarm, so there is no double dose (see Materializer.kt). `timeLocal` is the
 * occurrence's ORIGINAL slot time, which is what the occurrence id is built from, so the
 * identity is unchanged and a "taken" still attaches.
 */
export type AlarmException = {
  threadId: string;
  localDate: string;
  timeLocal: string;
  overrideTimeLocal: string;
};

export type AlarmHorizon = {
  schemaVersion: 1;
  writtenAtEpoch: number;
  profileId: string;
  rules: AlarmRule[];
  /** Per-date ring moves. Empty is the norm; when empty the native expansion is unchanged. */
  exceptions: AlarmException[];
};

/** One small file per event, written atomically by Kotlin, ingested and unlinked by JS. */
export type JournalRecord = {
  occurrenceId: string;
  threadId: string;
  medicineId: string;
  event: DoseEventKind;
  atEpoch: number;
  origin: DoseEventOrigin;
  payload?: Record<string, unknown>;
};

export type SymptomEvent = {
  id: string;
  profileId: string;
  symptomKey: string | null;
  customLabel: string | null;
  severity: 'mild' | 'moderate' | 'severe' | null;
  note: string | null;
  photoUri: string | null;
  atEpoch: number;
  localDate: string;
  localTime: string;
  linkedReadingId: string | null;
  linkedThreadId: string | null;
};

export type CareEventKind =
  | 'visit'
  | 'book_appointment'
  | 'test_book'
  | 'test_do'
  | 'test_collect'
  | 'refill'
  | 'custom';

export type CareEvent = {
  id: string;
  profileId: string;
  kind: CareEventKind;
  title: string;
  dueOn: string;
  anchorEventId: string | null;
  /**
   * 'transcribed' — the doctor wrote this on the prescription. AI may only produce these.
   * 'inferred'    — the APP derived it by applying an offset we own and the user can edit.
   * 'manual'      — the user typed it.
   */
  anchorSource: 'transcribed' | 'inferred' | 'manual';
  offsetDays: number;
  relatedTestKey: string | null;
  relatedThreadId: string | null;
  status: 'pending' | 'done' | 'dismissed' | 'superseded';
  confirmedAtEpoch: number | null;
};

/** Adherence, stated honestly. This is app interaction, never medication swallowed. */
export type AdherenceSummary = {
  windowDays: number;
  due: number;
  recordedTaken: number;
  recordedNotTaken: number;
  /** Neither confirmed nor refused — the honest third bucket. */
  noRecord: number;
  /** Null when noRecord runs ≥3 consecutive days — a percentage would be a lie. */
  percent: number | null;
  suppressedReason: string | null;
  longestNoRecordRun: number;
};

export type Distribution = 'personal' | 'play';
