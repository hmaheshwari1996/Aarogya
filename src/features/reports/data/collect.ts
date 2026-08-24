/**
 * ONE READ PASS, THREE SURFACES.
 *
 * Every builder in this feature is pure; this module is the only part that touches the
 * database. It assembles the plain snapshots in `./types.ts` that the OPD page, the CSV
 * bundle and the day card are all rendered from.
 *
 * Two things it is careful about, because both are easy to get wrong and expensive when
 * they are:
 *
 *  • IT NEVER RECOMPUTES ADHERENCE ITSELF. The rules that decide when a percentage may be
 *    published live in `src/features/adherence/`, they are unit-tested there, and there is
 *    exactly one implementation of them. A second count written here to "save a query"
 *    would eventually disagree with the dashboard, and the two numbers a doctor and a
 *    patient are looking at would differ with no way to tell which is right.
 *
 *  • IT NEVER INVENTS A TARGET, A REFERENCE RANGE OR A DATE. Where the record is silent,
 *    the snapshot carries null and the page prints that it is silent.
 */

import type { DoseEvent, Medicine, MetricDef, Reading } from '../../../types';
import { addDays, daysBetween, toLocalDate } from '../../../lib/datetime';
import {
  adherenceDisclaimer,
  computeAdherence,
  computeAdherenceWindows,
} from '../../adherence';
import { deriveStatus } from '../../dosing/deriveStatus';
import {
  SLOT_STRINGS,
  resolveSlots,
  slotForRow,
  slotLabel,
  type SlotDefinition,
} from '../../slots/registry';
import { isAwayOn, listAwayRanges } from '../../dosing/watchdog';
import { listCareEvents } from '../../../db/repositories/care';
import { listEventsForOccurrences } from '../../../db/repositories/doseEvents';
import { listLabResults, listLabTestDefs } from '../../../db/repositories/labs';
import { getMedicine, listCurrentMedicines, listMedChangeEvents } from '../../../db/repositories/medicines';
import { listTrackedMetrics } from '../../../db/repositories/metrics';
import { listOccurrences } from '../../../db/repositories/occurrences';
import { getProfile, listConditionPacks, listProfileConditions } from '../../../db/repositories/profiles';
import { listReadings } from '../../../db/repositories/readings';
import { getInstrumentRanges } from '../../../db/repositories/settings';
import { getCurrentSchedulesForThreads } from '../../../db/repositories/schedules';
import { listSymptomDefs, listSymptomEvents } from '../../../db/repositories/symptoms';
import { listTargets } from '../../../db/repositories/targets';
import { listQuestions, listVisits } from '../../../db/repositories/visits';
import { ageFromYearOfBirth, formatDate, formatDateRangeLong, formatDaysMask, formatNumber } from '../lib/format';
import { censoredDayCardText, censoredDirection, censoredValueText, censoredVsValue } from './censored';
import type {
  AdherenceWindowRow,
  DayCardData,
  DayCardDoseRow,
  DayCardReading,
  ExportData,
  OpdReportData,
  ReportDelta,
  ReportDose,
  ReportDoseDay,
  ReportInstrument,
  ReportLab,
  ReportMedChange,
  ReportMedicine,
  ReportMetric,
  ReportPatient,
  ReportQuestion,
  ReportRange,
  ReportReading,
  ReportSymptom,
  ReportTarget,
  SinceLastVisit,
} from './types';

/** How many measurements the "since last visit" block compares. Four fits the header. */
const MAX_DELTAS = 4;
/** Lab results recorded before the period, kept for continuity. */
const LABS_BEFORE_RANGE = 3;
const READING_QUERY_LIMIT = 1000;

// ── Patient ──────────────────────────────────────────────────────────────────

async function loadPatient(profileId: string, now: number): Promise<ReportPatient> {
  const profile = await getProfile(profileId);
  if (!profile) throw new Error(`No profile ${profileId} — nothing to report on.`);

  const [conditions, packs] = await Promise.all([listProfileConditions(profileId), listConditionPacks()]);
  const labels = new Map(packs.map((pack) => [pack.key, pack.labelEn]));

  return {
    displayName: profile.displayName,
    ageYears: ageFromYearOfBirth(profile.yearOfBirth, now),
    sex: profile.sex,
    bloodGroup: profile.bloodGroup,
    // A pack that has been switched off no longer describes what she is being treated
    // for, so it does not belong in the header of a consultation summary.
    conditions: conditions
      .filter((condition) => condition.endedOn === null)
      .map((condition) => labels.get(condition.packKey) ?? condition.packKey),
  };
}

// ── Metrics and readings ─────────────────────────────────────────────────────

function toReportMetric(def: MetricDef, sortOrder: number): ReportMetric {
  return {
    key: def.key,
    label: def.labelEn,
    unit: def.unit,
    chartKind: def.chartKind,
    primaryField: def.schema.primaryField,
    fields: def.schema.fields.map((field) => ({ slot: field.slot, key: field.key, label: field.labelEn })),
    sortOrder,
  };
}

/** Maps a stored context object onto the metric's own English option labels. */
function contextLabel(def: MetricDef, context: Record<string, string> | null): string | null {
  if (!context) return null;
  const schema = def.schema.context;
  if (!schema) {
    return Object.values(context).join(', ') || null;
  }
  const value = context[schema.key];
  if (value === undefined) return Object.values(context).join(', ') || null;
  return schema.options.find((option) => option.value === value)?.labelEn ?? value;
}

function toReportReading(reading: Reading, def: MetricDef): ReportReading {
  return {
    id: reading.id,
    metricKey: reading.metricKey,
    metricLabel: def.labelEn,
    unit: def.unit,
    localDate: reading.localDate,
    localTime: reading.localTime,
    atEpoch: reading.atEpoch,
    fields: def.schema.fields.map((field) => ({
      slot: field.slot,
      key: field.key,
      label: field.labelEn,
      value: field.slot === 'v1' ? reading.v1 : field.slot === 'v2' ? reading.v2 : reading.v3,
    })),
    primarySlot: def.schema.primaryField,
    qualifier: reading.valueQualifier,
    qualifierBound: reading.qualifierBound,
    context: reading.context,
    contextLabel: contextLabel(def, reading.context),
    note: reading.note,
    wasBackfilled: reading.wasBackfilled,
    source: reading.source,
    editedCount: reading.editedCount,
  };
}

async function loadMetrics(profileId: string): Promise<{ metrics: ReportMetric[]; defs: Map<string, MetricDef> }> {
  const tracked = await listTrackedMetrics(profileId);
  const defs = new Map(tracked.map((entry) => [entry.def.key, entry.def]));
  const metrics = tracked.map((entry) => toReportMetric(entry.def, entry.sortOrder));
  return { metrics, defs };
}

async function loadReadings(
  defs: Map<string, MetricDef>,
  profileId: string,
  range: ReportRange,
): Promise<ReportReading[]> {
  const perMetric = await Promise.all(
    [...defs.values()].map(async (def) => {
      const rows = await listReadings(profileId, def.key, {
        fromDate: range.fromDate,
        toDate: range.toDate,
        limit: READING_QUERY_LIMIT,
      });
      return rows.map((row) => toReportReading(row, def));
    }),
  );
  return perMetric.flat().sort((a, b) => a.atEpoch - b.atEpoch);
}

/**
 * The meter ranges a human recorded, joined to the metrics being reported.
 *
 * A range for a metric this profile does not track is dropped rather than printed: the
 * page would otherwise carry a line about a device whose readings appear nowhere on it.
 */
async function loadInstruments(metrics: readonly ReportMetric[]): Promise<ReportInstrument[]> {
  const ranges = await getInstrumentRanges();
  const out: ReportInstrument[] = [];
  for (const metric of metrics) {
    const range = ranges[metric.key];
    if (!range) continue;
    out.push({
      metricKey: metric.key,
      metricLabel: metric.label,
      unit: metric.unit,
      label: range.label,
      low: range.low,
      high: range.high,
      setByLabel: range.setByLabel,
      setOn: range.setOn,
    });
  }
  return out;
}

async function loadTargets(profileId: string): Promise<ReportTarget[]> {
  const rows = await listTargets(profileId);
  return rows.map((row) => ({
    metricKey: row.metricKey,
    field: row.field,
    low: row.low,
    high: row.high,
    setByLabel: row.setByLabel,
    setOn: row.setOn,
    context: row.context,
  }));
}

// ── Medicines ────────────────────────────────────────────────────────────────

const FOOD_WORDS: Readonly<Record<string, string>> = {
  before: 'before food',
  after: 'after food',
  with: 'with food',
  empty: 'on an empty stomach',
  any: 'food does not matter',
};

function quantityText(value: number | null, unit: string | null, text: string | null): string | null {
  // Free text wins: "half tablet" and "2 puffs" are what the prescription said, and
  // rounding them into a number is how a dose gets misread.
  if (text) return text;
  if (value === null) return null;
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

/**
 * The English name of the slot a schedule row belongs to.
 *
 * ENGLISH, DELIBERATELY, like every other word in this file (see `FOOD_WORDS`, and the
 * `report.*` rule in `scripts/check-i18n.js`): the printed page and the CSV go to an OPD
 * staffed by doctors who read English, whatever language the patient has the app in. A
 * label the patient typed herself is the one exception — it is her words, and it is
 * carried verbatim, because translating it would be inventing.
 *
 * Resolved through `slotForRow`, so the export agrees with what the medicines list, the
 * medicine page and the dose page all call the same dose.
 */
function englishSlotName(
  defs: readonly SlotDefinition[],
  timeLocal: string | null,
  slotKey: string | null,
): string | null {
  if (timeLocal === null) return null; // PRN carries no time and belongs to no slot.
  const def = slotForRow(defs, timeLocal, slotKey);
  return def === null ? null : slotLabel(def, (key) => SLOT_STRINGS[key]?.en ?? key);
}

async function loadMedicines(profileId: string): Promise<ReportMedicine[]> {
  const current = await listCurrentMedicines(profileId);
  if (current.length === 0) return [];

  const [schedules, slotDefs] = await Promise.all([
    getCurrentSchedulesForThreads(current.map((medicine) => medicine.threadId)),
    resolveSlots(profileId),
  ]);

  return current
    .map((medicine) => ({
      threadId: medicine.threadId,
      medicineId: medicine.id,
      name: medicine.nameAsWritten,
      strength: medicine.strength,
      form: medicine.form,
      status: medicine.status,
      criticality: medicine.criticality,
      startedOn: medicine.startedOn,
      stoppedOn: medicine.stoppedOn,
      stopReason: medicine.stopReason,
      version: medicine.version,
      slots: (schedules.get(medicine.threadId) ?? []).map((slot) => ({
        scheduleType: slot.scheduleType,
        timeLocal: slot.timeLocal,
        slotKey: slot.slotKey,
        slotName: englishSlotName(slotDefs, slot.timeLocal, slot.slotKey),
        quantity: quantityText(slot.quantityValue, slot.quantityUnit, slot.quantityText),
        foodRelation: slot.foodRelation ? (FOOD_WORDS[slot.foodRelation] ?? slot.foodRelation) : null,
        daysLabel: formatDaysMask(slot.daysMask),
        intervalDays: slot.intervalDays,
        startedOn: slot.startedOn,
        stoppedOn: slot.stoppedOn,
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadMedChanges(profileId: string, range: ReportRange): Promise<ReportMedChange[]> {
  const rows = await listMedChangeEvents(profileId, range.fromDate, range.toDate);
  return rows.map((row) => ({
    localDate: row.localDate,
    kind: row.kind,
    detail: row.detail,
    threadId: row.threadId,
  }));
}

// ── Doses ────────────────────────────────────────────────────────────────────

/** The last event that says anything about the outcome — not a delivery or a dismissal. */
function outcomeEvent(events: readonly DoseEvent[]): DoseEvent | null {
  let latest: DoseEvent | null = null;
  for (const event of events) {
    if (event.event !== 'taken' && event.event !== 'prn_taken' && event.event !== 'skipped') continue;
    if (latest === null || event.atEpoch > latest.atEpoch) latest = event;
  }
  return latest;
}

type DoseLoad = { doses: ReportDose[]; days: ReportDoseDay[] };

async function loadDoses(profileId: string, range: ReportRange, now: number): Promise<DoseLoad> {
  const away = await listAwayRanges(profileId);

  // Contiguous days, built before anything is counted. `longestNoRecordRun` in the
  // adherence module depends on contiguity, and the calendar grid depends on it too: a
  // sparse list would draw a two-week gap as two adjacent columns.
  const byDate = new Map<string, ReportDoseDay>();
  for (let date = range.fromDate; date <= range.toDate; date = addDays(date, 1)) {
    byDate.set(date, {
      localDate: date,
      due: 0,
      recordedTaken: 0,
      recordedNotTaken: 0,
      noRecord: 0,
      isAway: isAwayOn(away, date),
    });
  }

  const occurrences = await listOccurrences(profileId, range.fromDate, range.toDate);
  if (occurrences.length === 0) return { doses: [], days: [...byDate.values()] };

  const eventsByOccurrence = await listEventsForOccurrences(occurrences.map((o) => o.id));

  const medicineCache = new Map<string, Medicine | null>();
  const medicineFor = async (id: string): Promise<Medicine | null> => {
    const cached = medicineCache.get(id);
    if (cached !== undefined) return cached;
    const loaded = await getMedicine(id);
    medicineCache.set(id, loaded);
    return loaded;
  };

  const doses: ReportDose[] = [];
  for (const occurrence of occurrences) {
    const medicine = await medicineFor(occurrence.medicineId);
    if (!medicine) continue;

    const events = eventsByOccurrence.get(occurrence.id) ?? [];
    const status = deriveStatus(events, occurrence.scheduledAtEpoch, now);
    const outcome = outcomeEvent(events);

    doses.push({
      occurrenceId: occurrence.id,
      threadId: occurrence.threadId,
      medicineName: medicine.nameAsWritten,
      strength: medicine.strength,
      localDate: occurrence.localDate,
      timeLocal: occurrence.timeLocal,
      scheduledAtEpoch: occurrence.scheduledAtEpoch,
      status,
      recordedAtEpoch: outcome?.atEpoch ?? null,
      recordedOrigin: outcome?.origin ?? null,
      recordedDelayMinutes:
        outcome === null ? null : Math.round((outcome.atEpoch - occurrence.scheduledAtEpoch) / 60_000),
    });

    // The day tallies follow the same exclusions the adherence module applies, so the
    // calendar and the percentage cannot tell different stories about the same day.
    const day = byDate.get(occurrence.localDate);
    if (!day) continue;
    if (occurrence.scheduledAtEpoch > now) continue;
    if (medicine.startedOn && occurrence.localDate < medicine.startedOn) continue;
    if (medicine.stoppedOn && occurrence.localDate > medicine.stoppedOn) continue;
    if (status === 'cancelled' || status === 'snoozed' || status === 'pending') continue;

    day.due += 1;
    if (status === 'taken') day.recordedTaken += 1;
    else if (status === 'skipped') day.recordedNotTaken += 1;
    else day.noRecord += 1;
  }

  return { doses, days: [...byDate.values()] };
}

// ── Symptoms, labs, questions, care ──────────────────────────────────────────

async function loadSymptoms(profileId: string, range: ReportRange): Promise<ReportSymptom[]> {
  const [events, defs] = await Promise.all([
    listSymptomEvents(profileId, { fromDate: range.fromDate, toDate: range.toDate }),
    listSymptomDefs(),
  ]);
  const labels = new Map(defs.map((def) => [def.key, def.labelEn]));

  return events.map((event) => ({
    id: event.id,
    localDate: event.localDate,
    localTime: event.localTime,
    label: event.symptomKey ? (labels.get(event.symptomKey) ?? event.symptomKey) : (event.customLabel ?? 'Symptom'),
    severity: event.severity,
    note: event.note,
    // `edited_count` is not on the domain type; the disclosure lives on the app screen.
    editedCount: 0,
  }));
}

async function loadLabs(profileId: string, range: ReportRange): Promise<ReportLab[]> {
  const [results, defs] = await Promise.all([listLabResults(profileId, { limit: 300 }), listLabTestDefs()]);
  const labels = new Map(defs.map((def) => [def.key, def.labelEn]));

  const toReport = (result: (typeof results)[number], beforeRange: boolean): ReportLab => ({
    id: result.id,
    collectedOn: result.collectedOn,
    label: result.testKey ? (labels.get(result.testKey) ?? result.testKey) : (result.customLabel ?? 'Test'),
    valueText: result.valueText,
    valueNum: result.valueNum,
    unit: result.unit,
    refRangeText: result.refRangeText,
    labName: result.labName,
    source: result.source,
    confirmed: result.confirmedAt !== null,
    beforeRange,
  });

  const inRange = results.filter(
    (result) =>
      // An undated result has nothing to place it outside the period, and dropping it
      // would silently lose a report the patient photographed without a date on it.
      result.collectedOn === null ||
      (result.collectedOn >= range.fromDate && result.collectedOn <= range.toDate),
  );

  const earlier = results
    .filter((result) => result.collectedOn !== null && result.collectedOn < range.fromDate)
    .slice(0, LABS_BEFORE_RANGE);

  return [...inRange.map((result) => toReport(result, false)), ...earlier.map((result) => toReport(result, true))];
}

async function loadQuestions(profileId: string): Promise<ReportQuestion[]> {
  // The loose list — questions not yet attached to a visit — is the one she is taking in.
  const rows = await listQuestions(profileId, { visitId: null, unansweredOnly: true });
  return rows.map((row) => ({ id: row.id, text: row.text, origin: row.origin }));
}

// ── Since the last visit ─────────────────────────────────────────────────────

async function loadSinceLastVisit(
  profileId: string,
  range: ReportRange,
  metrics: readonly ReportMetric[],
  defs: Map<string, MetricDef>,
  readings: readonly ReportReading[],
): Promise<SinceLastVisit> {
  const visits = await listVisits(profileId);
  const previous = visits.find((visit) => visit.visitedOn <= range.toDate);
  if (!previous) return null;

  const deltas: ReportDelta[] = [];
  for (const metric of metrics) {
    if (deltas.length >= MAX_DELTAS) break;
    const def = defs.get(metric.key);
    if (!def) continue;

    const latest = [...readings].reverse().find((reading) => reading.metricKey === metric.key);
    if (!latest) continue;

    const before = await listReadings(profileId, metric.key, { toDate: previous.visitedOn, limit: 1 });
    const earlier = before[0];
    if (!earlier) continue;

    const slot = metric.primaryField;
    const fieldLabel = metric.fields.find((field) => field.slot === slot)?.label ?? slot;
    const then = slot === 'v1' ? earlier.v1 : slot === 'v2' ? earlier.v2 : earlier.v3;
    const nowValue = latest.fields.find((field) => field.slot === slot)?.value ?? null;
    if (earlier.id === latest.id) continue;

    // ── THE ONE SUMMARY THIS APP COMPUTES OVER READINGS, AND THE ONE PLACE A CENSORED
    //    READING COULD CORRUPT IT ───────────────────────────────────────────────────
    //
    // There is no average anywhere in this app, deliberately — see `medicine/[id].tsx`,
    // which states the doctrine in user-facing copy. This "then versus now" pair is the
    // only arithmetic over the record that reaches a doctor, so it is the only place the
    // rule has to be applied.
    //
    // It used to `continue` whenever either end had no number, which silently deleted
    // the whole row when the most recent glucose was a LO — the exact reading the visit
    // is most likely to be about. A hypoglycaemic episode disappearing from "since your
    // last visit" is worse than an imprecise row.
    //
    // So: a censored end is PRINTED as the inequality it is, the MAGNITUDE is refused
    // (there is no subtracting a number from an inequality), and the DIRECTION is stated
    // only where the inequality proves it. `censoredVsValue` carries the proof.
    const thenCensored = censoredDirection(earlier.valueQualifier);
    const nowCensored = censoredDirection(latest.qualifier);
    const thenText =
      censoredValueText(earlier.valueQualifier, earlier.qualifierBound, metric.unit) ??
      (then === null ? '' : formatNumber(then));
    const nowText =
      censoredValueText(latest.qualifier, latest.qualifierBound, metric.unit) ??
      (nowValue === null ? '' : formatNumber(nowValue));
    if (thenText === '' || nowText === '') continue;

    let change: number | null = null;
    let direction: ReportDelta['direction'] = null;
    if (!thenCensored && !nowCensored && then !== null && nowValue !== null) {
      change = nowValue - then;
      direction = change === 0 ? 'unchanged' : change > 0 ? 'higher' : 'lower';
    } else if (nowCensored && !thenCensored && then !== null) {
      // The censored end is NOW, so the proof is about `now` directly.
      const proof = censoredVsValue(nowCensored, latest.qualifierBound, then);
      direction = proof === 'undecidable' ? null : proof;
    } else if (thenCensored && !nowCensored && nowValue !== null) {
      // The censored end is THEN, so the proof is about `then` and has to be inverted:
      // if the earlier reading is provably the lower of the two, the change is upward.
      const proof = censoredVsValue(thenCensored, earlier.qualifierBound, nowValue);
      direction = proof === 'undecidable' ? null : proof === 'lower' ? 'higher' : 'lower';
    }

    deltas.push({
      metricKey: metric.key,
      metricLabel: metric.label,
      fieldLabel,
      unit: metric.unit,
      then: thenCensored ? null : then,
      thenOn: earlier.localDate,
      now: nowCensored ? null : nowValue,
      nowOn: latest.localDate,
      thenText,
      nowText,
      change,
      direction,
    });
  }

  return {
    visitedOn: previous.visitedOn,
    doctor: previous.doctor,
    clinic: previous.clinic,
    deltas,
  };
}

// ── Adherence ────────────────────────────────────────────────────────────────

async function loadAdherence(
  profileId: string,
  range: ReportRange,
  now: number,
): Promise<{ primary: OpdReportData['primaryAdherence']; label: string; windows: AdherenceWindowRow[] }> {
  const today = toLocalDate(new Date(now));
  const windows = await computeAdherenceWindows(profileId, now);

  const rows: AdherenceWindowRow[] = [
    { label: 'Last 7 days', summary: windows.last7 },
    { label: 'Last 30 days', summary: windows.last30 },
  ];
  if (windows.sinceTreatmentStart && windows.treatmentStartedOn) {
    rows.push({
      label: `Since treatment started (${formatDate(windows.treatmentStartedOn)})`,
      summary: windows.sinceTreatmentStart,
    });
  }

  // `computeAdherence` measures a window ending TODAY. When the selected period ends
  // today — which is what "last 7 days" and "last 30 days" produce, and that is nearly
  // every report — the two are the same window and the headline can be the period the
  // rest of the page covers. When the period ends in the past they are not the same, and
  // silently labelling one as the other would put a figure under a heading it does not
  // belong to.
  if (range.toDate >= today) {
    const spanDays = Math.max(1, daysBetween(range.fromDate, range.toDate) + 1);
    return {
      primary: await computeAdherence(profileId, spanDays, now),
      label: `Selected period — ${formatDateRangeLong(range.fromDate, range.toDate)}`,
      windows: rows,
    };
  }

  return {
    primary: windows.last30,
    label: 'Last 30 days (the selected period ended in the past, so the standard window is shown)',
    windows: rows,
  };
}

// ── Public collectors ────────────────────────────────────────────────────────

export async function collectOpdReport(
  profileId: string,
  range: ReportRange,
  now: number = Date.now(),
): Promise<OpdReportData> {
  const patient = await loadPatient(profileId, now);
  const { metrics, defs } = await loadMetrics(profileId);

  const [readings, targets, medicines, medChanges, symptoms, labs, questions, doseLoad, adherence] =
    await Promise.all([
      loadReadings(defs, profileId, range),
      loadTargets(profileId),
      loadMedicines(profileId),
      loadMedChanges(profileId, range),
      loadSymptoms(profileId, range),
      loadLabs(profileId, range),
      loadQuestions(profileId),
      loadDoses(profileId, range, now),
      loadAdherence(profileId, range, now),
    ]);

  const [sinceLastVisit, instruments] = await Promise.all([
    loadSinceLastVisit(profileId, range, metrics, defs, readings),
    loadInstruments(metrics),
  ]);

  return {
    generatedOnEpoch: now,
    range,
    patient,
    primaryAdherence: adherence.primary,
    primaryAdherenceLabel: adherence.label,
    adherenceWindows: adherence.windows,
    // Verbatim, never paraphrased. It is the sentence that says what the number is worth.
    adherenceDisclaimer: adherenceDisclaimer(),
    metrics,
    readings,
    targets,
    instruments,
    medicines,
    symptoms,
    labs,
    questions,
    medChanges,
    doses: doseLoad.doses,
    doseDays: doseLoad.days,
    sinceLastVisit,
  };
}

export async function collectExportData(
  profileId: string,
  range: ReportRange,
  now: number = Date.now(),
): Promise<ExportData> {
  const patient = await loadPatient(profileId, now);
  const { defs } = await loadMetrics(profileId);

  const [readings, targets, medicines, medChanges, symptoms, labs, questions, doseLoad, visits, care] =
    await Promise.all([
      loadReadings(defs, profileId, range),
      loadTargets(profileId),
      loadMedicines(profileId),
      loadMedChanges(profileId, range),
      loadSymptoms(profileId, range),
      loadLabs(profileId, range),
      loadQuestions(profileId),
      loadDoses(profileId, range, now),
      listVisits(profileId),
      // Ninety days ahead as well as the period itself: an export taken to a consultation
      // should carry the appointments that are still to come.
      listCareEvents(profileId, { fromDate: range.fromDate, toDate: addDays(range.toDate, 90) }),
    ]);

  return {
    generatedOnEpoch: now,
    range,
    patient,
    adherenceDisclaimer: adherenceDisclaimer(),
    readings,
    targets,
    medicines,
    doses: doseLoad.doses,
    symptoms,
    labs,
    questions,
    medChanges,
    visits: visits.map((visit) => ({
      id: visit.id,
      visitedOn: visit.visitedOn,
      doctor: visit.doctor,
      clinic: visit.clinic,
      notes: visit.notes,
    })),
    care: care.map((event) => ({
      id: event.id,
      kind: event.kind,
      title: event.title,
      dueOn: event.dueOn,
      anchorSource: event.anchorSource,
      status: event.status,
    })),
  };
}

// ── Day card ─────────────────────────────────────────────────────────────────

export type MetricRole = 'bp' | 'sugar' | 'weight' | 'other';

/**
 * Which of the day card's fixed slots a metric belongs in.
 *
 * Metric keys are seed data rather than constants in this file, so the match is on the
 * key's shape. A metric that matches nothing lands in `other` and is still shown — the
 * card never drops a reading because it could not classify it.
 */
export function classifyMetric(key: string): MetricRole {
  const lower = key.toLowerCase();
  if (lower.includes('bp') || lower.includes('pressure')) return 'bp';
  if (lower.includes('sugar') || lower.includes('glucose')) return 'sugar';
  if (lower.includes('weight')) return 'weight';
  return 'other';
}

/**
 * '142/88 mmHg, pulse 76' · '126' + 'mg/dL' · the meter's own LO/HI.
 *
 * A paired measurement carries its unit INSIDE the text, because the trailing fields come
 * after it: "142/88, pulse 76 mmHg" reads as though the pulse were in millimetres of
 * mercury. A single-value measurement leaves the unit separate so the card can set it in
 * smaller type beside the number.
 */
function readingParts(reading: ReportReading, unit: string): { text: string; unit: string } {
  // The unit is folded INTO the text for a censored reading, because the text is an
  // inequality — 'LO on the meter (below 20 mg/dL)' — and a unit set separately beside it
  // would render as '… (below 20 mg/dL) mg/dL'.
  const censored = censoredDayCardText(reading.qualifier, reading.qualifierBound, unit);
  if (censored) return { text: censored, unit: '' };

  const present = reading.fields.filter((field) => field.value !== null);
  if (present.length === 0) return { text: '—', unit: '' };
  if (present.length === 1) return { text: formatNumber(present[0]?.value ?? null), unit };

  const [first, second, ...rest] = present;
  const head = `${formatNumber(first?.value ?? null)}/${formatNumber(second?.value ?? null)}`;
  const tail = rest.map((field) => `${field.label.toLowerCase()} ${formatNumber(field.value)}`).join(', ');
  const withUnit = unit ? `${head} ${unit}` : head;
  return { text: tail ? `${withUnit}, ${tail}` : withUnit, unit: '' };
}

function toDayCardReading(reading: ReportReading, unit: string): DayCardReading {
  const parts = readingParts(reading, unit);
  return {
    localTime: reading.localTime,
    text: parts.text,
    unit: parts.unit,
    contextLabel: reading.contextLabel,
    qualifier: reading.qualifier,
  };
}

export async function collectDayCard(
  profileId: string,
  localDate: string,
  now: number = Date.now(),
): Promise<DayCardData> {
  const range: ReportRange = { fromDate: localDate, toDate: localDate };
  const patient = await loadPatient(profileId, now);
  const { metrics, defs } = await loadMetrics(profileId);

  const [readings, symptoms, doseLoad] = await Promise.all([
    loadReadings(defs, profileId, range),
    loadSymptoms(profileId, range),
    loadDoses(profileId, range, now),
  ]);

  const unitFor = (metricKey: string): string => metrics.find((m) => m.key === metricKey)?.unit ?? '';
  const pick = (role: MetricRole): ReportReading[] =>
    readings.filter((reading) => classifyMetric(reading.metricKey) === role);

  const weightReadings = pick('weight');
  const lastWeight = weightReadings[weightReadings.length - 1];

  const otherByMetric = new Map<string, ReportReading[]>();
  for (const reading of pick('other')) {
    const list = otherByMetric.get(reading.metricKey) ?? [];
    list.push(reading);
    otherByMetric.set(reading.metricKey, list);
  }

  const doses: DayCardDoseRow[] = [];
  const byThread = new Map<string, DayCardDoseRow>();
  for (const dose of doseLoad.doses) {
    // A withdrawn occurrence is not an obligation and must not appear as an unfilled dot.
    if (dose.status === 'cancelled') continue;
    let row = byThread.get(dose.threadId);
    if (!row) {
      row = {
        threadId: dose.threadId,
        medicineName: dose.medicineName,
        strength: dose.strength,
        marks: [],
      };
      byThread.set(dose.threadId, row);
      doses.push(row);
    }
    row.marks.push({ timeLocal: dose.timeLocal, state: dose.status });
  }
  for (const row of doses) row.marks.sort((a, b) => a.timeLocal.localeCompare(b.timeLocal));

  return {
    localDate,
    patientName: patient.displayName,
    bloodPressure: pick('bp').map((reading) => toDayCardReading(reading, unitFor(reading.metricKey))),
    bloodSugar: pick('sugar').map((reading) => toDayCardReading(reading, unitFor(reading.metricKey))),
    weight: lastWeight ? toDayCardReading(lastWeight, unitFor(lastWeight.metricKey)) : null,
    otherReadings: [...otherByMetric.entries()].map(([metricKey, entries]) => ({
      label: metrics.find((m) => m.key === metricKey)?.label ?? metricKey,
      entries: entries.map((reading) => toDayCardReading(reading, unitFor(metricKey))),
    })),
    doses,
    symptoms: symptoms.map((symptom) => ({
      localTime: symptom.localTime,
      label: symptom.label,
      severity: symptom.severity,
    })),
  };
}
