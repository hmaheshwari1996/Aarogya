/**
 * The report layer's own view of the record — a plain, serialisable snapshot.
 *
 * WHY THE BUILDERS DO NOT READ THE DATABASE THEMSELVES:
 *
 * Every builder in this feature (`buildOpdHtml`, `buildWallChartHtml`, `buildCsvBundle`,
 * `buildDayCardText`) is a pure function from one of these shapes to a string. That
 * separation buys three things that matter for a clinical artefact:
 *
 *  1. The output is reproducible. The same snapshot renders the same page, so a
 *     disagreement about what the report said is settleable.
 *  2. The rules that could mislead a doctor — adherence suppression, target bands,
 *     out-of-range marking — are testable without a SQLite instance.
 *  3. One read pass fills every surface. Assembling the OPD page, the CSV bundle and the
 *     dose calendar from three independent query storms would take visible seconds on the
 *     Go-class device this app is built for.
 *
 * TYPE-ONLY FILE. It contains no runtime code, so importing it costs nothing and any
 * module can `import type` from here without becoming un-loadable in the test runner.
 */

import type {
  AdherenceSummary,
  Criticality,
  MedicineStatus,
  OccurrenceStatus,
  Profile,
  ScheduleType,
  ValueQualifier,
} from '../../../types';

/** Inclusive on both ends, 'YYYY-MM-DD', exactly like every other range in this app. */
export type ReportRange = { fromDate: string; toDate: string };

export type ReportPatient = {
  displayName: string;
  /** Derived from `year_of_birth`, so accurate to within a year. Labelled as such. */
  ageYears: number | null;
  sex: Profile['sex'];
  bloodGroup: string | null;
  /** English condition-pack labels. Empty when no pack is enabled. */
  conditions: string[];
};

export type ReportFieldValue = {
  slot: 'v1' | 'v2' | 'v3';
  key: string;
  label: string;
  value: number | null;
};

export type ReportReading = {
  id: string;
  metricKey: string;
  metricLabel: string;
  unit: string;
  localDate: string;
  localTime: string;
  atEpoch: number;
  fields: ReportFieldValue[];
  primarySlot: 'v1' | 'v2' | 'v3';
  /** 'below_range' / 'above_range' is a meter that printed LO / HI, not a judgement. */
  qualifier: ValueQualifier;
  /**
   * The limit of the meter's measuring range AT THE MOMENT THIS WAS ENTERED, and only on
   * a reading whose qualifier is not 'exact'. LO asserts `value < qualifierBound`.
   *
   * It is a snapshot rather than a lookup because meters get replaced: a LO recorded in
   * March on a meter that floors at 20 must not re-render at 10 because a different meter
   * was bought in July. Null means the range was never recorded, which is a complete
   * record — the reading then prints as 'Meter showed LO' with no inequality.
   *
   * NEVER print this on its own. See `./censored.ts`, which every surface goes through.
   */
  qualifierBound: number | null;
  context: Record<string, string> | null;
  contextLabel: string | null;
  note: string | null;
  /** True when the reading was entered from memory rather than at the meter. */
  wasBackfilled: boolean;
  source: 'manual' | 'ocr' | 'import' | 'device';
  editedCount: number;
};

/**
 * A target that a NAMED HUMAN set on a NAMED DATE. There is no other kind.
 *
 * The app ships no thresholds and infers none, so the absence of a row here is the
 * normal case and means exactly one thing to every chart: draw no band, mark no value.
 */
export type ReportTarget = {
  metricKey: string;
  field: 'v1' | 'v2' | 'v3';
  low: number | null;
  high: number | null;
  setByLabel: string;
  setOn: string;
  context: Record<string, string> | null;
};

/**
 * The measuring range of an instrument the patient actually owns.
 *
 * IT IS NOT A TARGET, AND IT MUST NEVER BE DRAWN AS ONE. A target is a clinical opinion
 * about the patient; this is a fact about a device on her table, and the only thing it
 * licenses is turning a LO into `below 20 mg/dL`. It carries a name and a date for the
 * same reason `ReportTarget` does: a reader who is about to see an inequality is entitled
 * to know who told the app what the meter's range was, and when.
 *
 * Empty is the normal state. The app ships no instrument ranges and infers none.
 */
export type ReportInstrument = {
  metricKey: string;
  metricLabel: string;
  unit: string;
  /** What the meter is, in her words or off the box. */
  label: string;
  low: number | null;
  high: number | null;
  setByLabel: string;
  setOn: string;
};

export type ReportMetric = {
  key: string;
  label: string;
  unit: string;
  chartKind: 'scatter' | 'line' | 'bar' | 'none';
  primaryField: 'v1' | 'v2' | 'v3';
  fields: { slot: 'v1' | 'v2' | 'v3'; key: string; label: string }[];
  sortOrder: number;
};

export type ReportScheduleSlot = {
  scheduleType: ScheduleType;
  /** Wall clock 'HH:MM'. Null for PRN. */
  timeLocal: string | null;
  /** The raw `dose_schedule.slot_key`. A machine identifier — `custom:9f3a1c02` for a slot
   *  the patient invented. Never the only thing shown to a human; see `slotName`. */
  slotKey: string | null;
  /**
   * What that slot is CALLED, in English, resolved the same way the app resolves it on
   * screen — a built-in's English name, or the patient's own words for a slot of her own.
   * Null when no slot claims the row's time and the stored key is not a retired one.
   *
   * Exists because the export is read by a doctor: "With tea" is the only record of why a
   * thyroxine dose sits at 06:30, and before this it reached no export at all while the
   * column meant to say what the dose is called printed a hex string.
   */
  slotName: string | null;
  /** Free text where the quantity is not a clean number ("half tablet", "2 puffs"). */
  quantity: string | null;
  foodRelation: string | null;
  daysLabel: string;
  intervalDays: number;
  startedOn: string;
  stoppedOn: string | null;
};

export type ReportMedicine = {
  threadId: string;
  medicineId: string;
  name: string;
  strength: string | null;
  form: string | null;
  status: MedicineStatus;
  criticality: Criticality;
  startedOn: string | null;
  stoppedOn: string | null;
  stopReason: string | null;
  version: number;
  slots: ReportScheduleSlot[];
};

export type ReportSymptom = {
  id: string;
  localDate: string;
  localTime: string;
  label: string;
  severity: 'mild' | 'moderate' | 'severe' | null;
  note: string | null;
  editedCount: number;
};

export type ReportLab = {
  id: string;
  collectedOn: string | null;
  label: string;
  valueText: string | null;
  valueNum: number | null;
  unit: string | null;
  /** Transcribed from the paper report, or null. The app never supplies one. */
  refRangeText: string | null;
  labName: string | null;
  source: 'manual' | 'ocr';
  confirmed: boolean;
  /** True for a result that predates the selected period, shown for continuity. */
  beforeRange: boolean;
};

export type ReportQuestion = {
  id: string;
  text: string;
  /** 'auto' rows were composed by the app and are marked as such on the page. */
  origin: 'user' | 'auto';
};

export type ReportMedChange = {
  localDate: string;
  kind: 'started' | 'stopped' | 'dose_changed' | 'time_changed' | 'resumed' | 'prescription';
  detail: string | null;
  threadId: string | null;
};

/** One occurrence, with whatever the record says happened to it. */
export type ReportDose = {
  occurrenceId: string;
  threadId: string;
  medicineName: string;
  strength: string | null;
  localDate: string;
  timeLocal: string;
  scheduledAtEpoch: number;
  status: OccurrenceStatus;
  /** When the outcome was recorded, which is not when the dose was due. */
  recordedAtEpoch: number | null;
  recordedOrigin: string | null;
  /** Minutes between the scheduled moment and the record. Negative means early. */
  recordedDelayMinutes: number | null;
};

/** One calendar day of the dose calendar grid. Contiguous and ordered. */
export type ReportDoseDay = {
  localDate: string;
  due: number;
  recordedTaken: number;
  recordedNotTaken: number;
  noRecord: number;
  /** A hospital stay or similar. Explained absence, never missing data. */
  isAway: boolean;
};

export type ReportDelta = {
  metricKey: string;
  metricLabel: string;
  fieldLabel: string;
  unit: string;
  then: number | null;
  thenOn: string | null;
  now: number | null;
  nowOn: string | null;
  /**
   * What to PRINT for each end, already resolved.
   *
   * An end is either a measurement ('126') or an inequality the meter produced ('Meter
   * showed LO (below 20 mg/dL)'), and only the first has a number in `then` / `now`. The
   * text is built here rather than in the renderer for the same reason `contextLabel` and
   * `daysLabel` are: there are three renderers and one snapshot, and a rule about how a
   * censored reading may appear must not be re-derived in each of them.
   */
  thenText: string;
  nowText: string;
  /**
   * now − then, or null when either end is missing OR censored.
   *
   * A difference against an inequality has no magnitude: 'was 180, now below 20' supports
   * no subtraction, and 160 printed there would be a number nobody measured.
   */
  change: number | null;
  /**
   * 'higher' / 'lower' / 'unchanged'. A WORD, never a colour or an arrow alone.
   *
   * With a censored end this is set ONLY where the inequality proves it — see
   * `censoredVsValue` in `./censored.ts`. Where it does not, the direction is null and
   * the page prints no direction rather than the likely one.
   */
  direction: 'higher' | 'lower' | 'unchanged' | null;
};

export type SinceLastVisit = {
  visitedOn: string;
  doctor: string | null;
  clinic: string | null;
  deltas: ReportDelta[];
} | null;

export type AdherenceWindowRow = {
  label: string;
  summary: AdherenceSummary;
};

/** Everything the OPD page and its appendix are built from. */
export type OpdReportData = {
  generatedOnEpoch: number;
  range: ReportRange;
  patient: ReportPatient;

  /**
   * The figure printed at the top of the page, and the label that says which span it
   * covers. Never a bare number with no period attached to it.
   */
  primaryAdherence: AdherenceSummary;
  primaryAdherenceLabel: string;
  /** Last 7 / last 30 / since treatment start, as available. */
  adherenceWindows: AdherenceWindowRow[];
  /** Verbatim `adherenceDisclaimer()`. Printed under every adherence figure. */
  adherenceDisclaimer: string;

  metrics: ReportMetric[];
  readings: ReportReading[];
  targets: ReportTarget[];
  /** Meter ranges a human recorded. Empty unless someone filled one in. */
  instruments: ReportInstrument[];
  medicines: ReportMedicine[];
  symptoms: ReportSymptom[];
  labs: ReportLab[];
  questions: ReportQuestion[];
  medChanges: ReportMedChange[];
  doses: ReportDose[];
  doseDays: ReportDoseDay[];
  sinceLastVisit: SinceLastVisit;
};

/** The one day a share card describes. */
export type DayCardDoseMark = {
  timeLocal: string;
  state: OccurrenceStatus;
};

export type DayCardDoseRow = {
  threadId: string;
  medicineName: string;
  strength: string | null;
  marks: DayCardDoseMark[];
};

export type DayCardReading = {
  localTime: string;
  /** Already formatted for display: '142/88', '126', '61.4'. */
  text: string;
  unit: string;
  contextLabel: string | null;
  qualifier: ValueQualifier;
};

/**
 * The day card's payload.
 *
 * NOTE WHAT IS NOT HERE: no prescription image, no lab report image, no address, no
 * phone number. This artefact is built to be forwarded through WhatsApp, which means it
 * will end up in group chats and in other people's photo backups. Everything on it is
 * something the patient would say out loud to the person she is sending it to.
 */
export type DayCardData = {
  localDate: string;
  patientName: string;
  bloodPressure: DayCardReading[];
  bloodSugar: DayCardReading[];
  weight: DayCardReading | null;
  otherReadings: { label: string; entries: DayCardReading[] }[];
  doses: DayCardDoseRow[];
  symptoms: { localTime: string; label: string; severity: string | null }[];
};

/** The snapshot the CSV/XLSX bundle is written from. */
export type ExportData = {
  generatedOnEpoch: number;
  range: ReportRange;
  patient: ReportPatient;
  adherenceDisclaimer: string;
  readings: ReportReading[];
  targets: ReportTarget[];
  medicines: ReportMedicine[];
  doses: ReportDose[];
  symptoms: ReportSymptom[];
  labs: ReportLab[];
  questions: ReportQuestion[];
  medChanges: ReportMedChange[];
  visits: { id: string; visitedOn: string; doctor: string | null; clinic: string | null; notes: string | null }[];
  care: { id: string; kind: string; title: string; dueOn: string; anchorSource: string; status: string }[];
};
