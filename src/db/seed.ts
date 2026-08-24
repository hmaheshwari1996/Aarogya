/**
 * Reference data. The registry every other table points at.
 *
 * Nothing in this app works until this has run: `reading` has a foreign key to
 * `metric_def`, and the repositories refuse to create a reading for a metric
 * that is not registered. An empty `metric_def` is not a degraded app, it is an
 * app where the "Record blood pressure" button cannot do anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT IS NOT NEGOTIABLE
 *
 *   THIS FILE SEEDS NO TARGET RANGES. NOT ONE. NOT FOR ANY METRIC.
 *
 * `target_range` ships empty and stays empty until a human types a number into
 * Settings → Targets, at which point their name and the date are stored
 * alongside it (`set_by_label`, `set_on`) and printed in every chart legend.
 *
 * The reason is not caution, it is accuracy. "140/90" is not a fact about blood
 * pressure; it is a threshold from one guideline, for one population, and it
 * moves. What her cardiologist is actually aiming for at 71, on three drugs,
 * with the kidney function she has, is a number only he knows. An app-supplied
 * default would be anonymous, undated and unattributable — and it would be
 * believed, because it came from the phone. `scripts/check-clinical-language.js`
 * enforces this from the outside; the absence below is the primary defence.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BOUNDS ARE INSTRUMENT LIMITS, NEVER CLINICAL PLAUSIBILITY.
 *
 * `min`/`max` answer "could a device have produced this?" and nothing else. A
 * glucose of 18 mg/dL is a hypoglycaemic emergency — the single reading a
 * doctor would act on fastest — and an app that refuses to record it because it
 * looks implausible has failed at the exact moment it mattered. `softMin`/
 * `softMax` drive a "did you mean?" confirmation which the user can always
 * dismiss; they catch a slipped finger, never a real measurement.
 *
 * KEYS ARE FROZEN. `bp`, `blood_glucose` and `weight` are referenced by
 * `src/app/_shared/lib.tsx` (METRIC_BP / METRIC_SUGAR / METRIC_WEIGHT) and by
 * the entry screens. Renaming one here orphans every reading already recorded
 * against it. `bp` is not `blood_pressure` for exactly that reason.
 *
 * Idempotent: every statement is INSERT OR IGNORE, so it is safe on every boot
 * and safe to re-run after a migration adds a row. It deliberately does NOT
 * open a transaction, so it can be called from inside one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The database seam
// ─────────────────────────────────────────────────────────────────────────────

export type SeedBind = string | number | null;

/**
 * Structural, not `SQLiteDatabase`, so the seed can be run against a plain
 * `node:sqlite` handle in a test or in `scripts/seed-dev-data.ts` without
 * pulling a native module into Node.
 */
export type SeedDatabase = {
  runAsync(sql: string, params: SeedBind[]): Promise<unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Condition packs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pack ENABLES metrics, symptoms and tests. It never requires them, and
 * turning one off never deletes a recorded value. The setup screen asks "what
 * is your doctor treating you for" — a statement about a treatment in progress,
 * which is the only thing the app is entitled to record.
 */
export type ConditionPackSeed = {
  key: string;
  labelEn: string;
  labelHi: string;
  descriptionEn: string | null;
  sortOrder: number;
};

export const CONDITION_PACKS: readonly ConditionPackSeed[] = [
  {
    key: 'general',
    labelEn: 'General health',
    labelHi: 'सामान्य सेहत',
    descriptionEn: 'Weight and temperature. Always available, with or without any other pack.',
    sortOrder: 10,
  },
  {
    key: 'hypertension',
    labelEn: 'Blood pressure',
    labelHi: 'रक्तचाप',
    descriptionEn: 'Blood pressure readings and the medicines that go with them.',
    sortOrder: 20,
  },
  {
    key: 'diabetes',
    labelEn: 'Diabetes',
    labelHi: 'मधुमेह',
    descriptionEn: 'Blood sugar with the time it was measured, and HbA1c.',
    sortOrder: 30,
  },
  {
    key: 'cardiac',
    labelEn: 'Heart',
    labelHi: 'दिल',
    descriptionEn: 'Blood pressure, pulse and the sensations worth writing down.',
    sortOrder: 40,
  },
  {
    key: 'thyroid',
    labelEn: 'Thyroid',
    labelHi: 'थायरॉइड',
    descriptionEn: 'Weight, and the thyroid blood tests.',
    sortOrder: 50,
  },
  {
    key: 'respiratory',
    labelEn: 'Breathing',
    labelHi: 'साँस',
    descriptionEn: 'Oxygen, peak flow and breathing symptoms.',
    sortOrder: 60,
  },
  {
    key: 'kidney',
    labelEn: 'Kidney',
    labelHi: 'गुर्दा',
    descriptionEn: 'Blood pressure, weight and the kidney blood tests.',
    sortOrder: 70,
  },
  {
    key: 'anticoagulation',
    labelEn: 'Blood thinner',
    labelHi: 'खून पतला करने की दवा',
    descriptionEn: 'INR, and the things worth noticing while on a blood thinner.',
    sortOrder: 80,
  },
  {
    key: 'tb',
    labelEn: 'TB treatment',
    labelHi: 'टीबी का इलाज',
    descriptionEn: 'A fixed course. Weight, temperature and the sputum tests.',
    sortOrder: 90,
  },
  {
    key: 'post_surgery',
    labelEn: 'After an operation',
    labelHi: 'ऑपरेशन के बाद',
    descriptionEn: 'Temperature, oxygen and how the wound is doing.',
    sortOrder: 100,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

type FieldSeed = {
  slot: 'v1' | 'v2' | 'v3';
  key: string;
  labelEn: string;
  labelHi: string;
  min: number;
  max: number;
  softMin?: number;
  softMax?: number;
};

type ContextSeed = {
  key: string;
  labelEn: string;
  labelHi: string;
  options: { value: string; labelEn: string; labelHi: string; affectsTarget: boolean }[];
};

export type MetricSeed = {
  key: string;
  labelEn: string;
  labelHi: string;
  unit: string;
  valueKind: 'scalar' | 'pair' | 'triple' | 'ordinal' | 'boolean';
  chartKind: 'scatter' | 'line' | 'bar' | 'none';
  /** Instrument limits for the PRIMARY field. Mirrors schema.fields[primary]. */
  minValid: number;
  maxValid: number;
  sortOrder: number;
  schema: { fields: FieldSeed[]; primaryField: 'v1' | 'v2' | 'v3'; context?: ContextSeed };
};

/**
 * Glucose meal context.
 *
 * The key and the five option values are FROZEN — `src/app/entry/sugar.tsx`
 * writes exactly these into `reading.context_json`, and Settings → Targets
 * stores a separate target per context. Changing a value here silently detaches
 * every glucose reading already recorded under the old one from its target.
 *
 * `affectsTarget: false` on 'random' is the honest case: a sugar taken at an
 * unrecorded moment cannot be compared against a fasting or post-meal target,
 * so the app declines to compare it at all rather than compare it wrongly.
 */
const GLUCOSE_CONTEXT: ContextSeed = {
  key: 'meal',
  labelEn: 'When did you measure it?',
  labelHi: 'आपने कब नापा?',
  options: [
    { value: 'fasting', labelEn: 'Empty stomach', labelHi: 'खाली पेट', affectsTarget: true },
    { value: 'before_meal', labelEn: 'Before a meal', labelHi: 'खाने से पहले', affectsTarget: true },
    {
      value: 'after_meal',
      labelEn: 'Two hours after a meal',
      labelHi: 'खाने के दो घंटे बाद',
      affectsTarget: true,
    },
    { value: 'bedtime', labelEn: 'At bedtime', labelHi: 'सोते समय', affectsTarget: true },
    { value: 'random', labelEn: 'Some other time', labelHi: 'किसी और समय', affectsTarget: false },
  ],
};

export const METRICS: readonly MetricSeed[] = [
  {
    key: 'bp',
    labelEn: 'Blood pressure',
    labelHi: 'रक्तचाप',
    unit: 'mmHg',
    valueKind: 'triple',
    chartKind: 'scatter',
    minValid: 40,
    maxValid: 350,
    sortOrder: 10,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'systolic',
          labelEn: 'Upper number',
          labelHi: 'ऊपर वाला अंक',
          // An oscillometric home monitor reports roughly 60–260 and errors
          // outside that; the wider band exists so a value copied off a hospital
          // chart, or off an aneroid cuff, is never refused.
          min: 40,
          max: 350,
          softMin: 80,
          softMax: 200,
        },
        {
          slot: 'v2',
          key: 'diastolic',
          labelEn: 'Lower number',
          labelHi: 'नीचे वाला अंक',
          min: 20,
          max: 250,
          softMin: 45,
          softMax: 130,
        },
        {
          slot: 'v3',
          key: 'pulse',
          labelEn: 'Pulse',
          labelHi: 'नाड़ी',
          // 0 is recordable on purpose. A monitor that displays 0 has failed to
          // find a pulse, and "the machine showed nothing" is a fact worth
          // having in the record.
          min: 0,
          max: 300,
          softMin: 40,
          softMax: 150,
        },
      ],
    },
  },
  {
    key: 'blood_glucose',
    labelEn: 'Blood sugar',
    labelHi: 'ब्लड शुगर',
    unit: 'mg/dL',
    valueKind: 'scalar',
    chartKind: 'scatter',
    minValid: 0,
    maxValid: 1000,
    sortOrder: 20,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'Blood sugar',
          labelHi: 'ब्लड शुगर',
          // A glucometer prints LO below ~20 and HI above ~600 — recorded via
          // `reading.value_qualifier`, not by clamping. The 0–1000 band covers
          // a lab slip in mg/dL as well as the meter.
          min: 0,
          max: 1000,
          softMin: 50,
          softMax: 400,
        },
      ],
      context: GLUCOSE_CONTEXT,
    },
  },
  {
    key: 'weight',
    labelEn: 'Weight',
    labelHi: 'वज़न',
    unit: 'kg',
    valueKind: 'scalar',
    chartKind: 'line',
    minValid: 0,
    maxValid: 500,
    sortOrder: 30,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'Weight',
          labelHi: 'वज़न',
          min: 0,
          max: 500,
          softMin: 25,
          softMax: 200,
        },
      ],
    },
  },
  {
    key: 'spo2',
    labelEn: 'Oxygen (SpO2)',
    labelHi: 'ऑक्सीजन (SpO2)',
    unit: '%',
    valueKind: 'scalar',
    chartKind: 'scatter',
    minValid: 0,
    maxValid: 100,
    sortOrder: 40,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'Oxygen',
          labelHi: 'ऑक्सीजन',
          // A percentage cannot leave 0–100; that is arithmetic, not medicine.
          min: 0,
          max: 100,
          // A fingertip pulse oximeter reads low on cold hands, on nail polish
          // and on a poorly seated finger, far more often than a person's
          // oxygen is genuinely in the 70s. The prompt asks her to check the
          // probe and read it again — it never questions the answer.
          softMin: 85,
          softMax: 100,
        },
      ],
    },
  },
  {
    key: 'temperature',
    labelEn: 'Temperature',
    labelHi: 'तापमान',
    // °F, because that is what a household digital thermometer in India
    // displays. The unit is stored on the metric and printed everywhere the
    // number is, so there is never a bare figure whose scale must be guessed.
    unit: '°F',
    valueKind: 'scalar',
    chartKind: 'line',
    minValid: 80,
    maxValid: 120,
    sortOrder: 50,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'Temperature',
          labelHi: 'तापमान',
          // A clinical digital thermometer's own range is about 89.6–109.9 °F.
          min: 80,
          max: 120,
          softMin: 94,
          softMax: 106,
        },
      ],
    },
  },
  {
    key: 'inr',
    labelEn: 'INR',
    labelHi: 'आईएनआर',
    unit: '',
    valueKind: 'scalar',
    chartKind: 'line',
    minValid: 0,
    maxValid: 20,
    sortOrder: 60,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'INR',
          labelHi: 'आईएनआर',
          // A point-of-care coagulometer reports about 0.8–8.0 and reads "> 8"
          // above that. Lab INRs above 10 exist and must be recordable.
          min: 0,
          max: 20,
          softMin: 0.8,
          softMax: 6,
        },
      ],
    },
  },
  {
    key: 'peak_flow',
    labelEn: 'Peak flow',
    labelHi: 'पीक फ्लो',
    unit: 'L/min',
    valueKind: 'scalar',
    chartKind: 'line',
    minValid: 0,
    maxValid: 900,
    sortOrder: 70,
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'Peak flow',
          labelHi: 'पीक फ्लो',
          // A mini-Wright meter's scale runs 60–800 L/min.
          min: 0,
          max: 900,
          softMin: 60,
          softMax: 800,
        },
      ],
    },
  },
  {
    key: 'hba1c',
    labelEn: 'HbA1c',
    labelHi: 'एचबीए1सी',
    unit: '%',
    valueKind: 'scalar',
    chartKind: 'line',
    minValid: 0,
    maxValid: 25,
    sortOrder: 80,
    // Also present in `lab_test_def` — deliberately. The lab row transcribes a
    // paper report verbatim, including whatever reference range the lab
    // printed; the metric is the charted series over time. They answer
    // different questions and neither can stand in for the other.
    schema: {
      primaryField: 'v1',
      fields: [
        {
          slot: 'v1',
          key: 'value',
          labelEn: 'HbA1c',
          labelHi: 'एचबीए1सी',
          min: 0,
          max: 25,
          softMin: 4,
          softMax: 15,
        },
      ],
    },
  },
];

/** Which packs OFFER which metrics. A metric can belong to several. */
export const PACK_METRICS: readonly (readonly [string, string])[] = [
  ['general', 'weight'],
  ['general', 'temperature'],

  ['hypertension', 'bp'],
  ['hypertension', 'weight'],

  ['diabetes', 'blood_glucose'],
  ['diabetes', 'hba1c'],
  ['diabetes', 'weight'],

  ['cardiac', 'bp'],
  ['cardiac', 'weight'],
  ['cardiac', 'spo2'],

  ['thyroid', 'weight'],

  ['respiratory', 'spo2'],
  ['respiratory', 'peak_flow'],
  ['respiratory', 'temperature'],

  ['kidney', 'bp'],
  ['kidney', 'weight'],

  ['anticoagulation', 'inr'],

  ['tb', 'weight'],
  ['tb', 'temperature'],

  ['post_surgery', 'temperature'],
  ['post_surgery', 'spo2'],
  ['post_surgery', 'weight'],
];

// ─────────────────────────────────────────────────────────────────────────────
// Glucometers — the measuring range a meter prints LO and HI against
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PICKER LIST, NOT A DATABASE TABLE AND NOT A DEFAULT.
 *
 * This is the one place in the app that names a number next to a person's blood sugar,
 * so it is worth being exact about what these numbers are and are not.
 *
 * They are a property of a DEVICE. Every glucometer has an analytical measuring range;
 * below the floor it displays LO and above the ceiling HI. Those are not errors — an
 * unreadable strip gives an E-code instead — they are the meter saying "the true value
 * is outside what I can quantify". So "LO on a 20–600 meter" means `glucose < 20 mg/dL`:
 * an inequality, produced by the instrument, with real clinical content.
 *
 * They are NOT a clinical opinion, NOT a target, and NOT a threshold. Nothing here is
 * compared against a reading to produce a verdict. The only thing the app does with the
 * number is print the inequality the meter already asserted, and place an arrow at it on
 * a chart instead of dropping the reading on the floor.
 *
 * NOTHING IS PRESELECTED. `app_meta` ships with no meter recorded, `qualifier_bound`
 * stays NULL until a human picks one, and a LO recorded with no meter on file is still a
 * complete, honest record — it simply prints as "the meter could not read a number this
 * low" rather than "< 20 mg/dL". "I don't know" must be a first-class choice on the
 * settings screen, and the chosen range must be shown back so the human can check it
 * against the box the meter came in. These figures are the manufacturers' published
 * ranges for meters commonly sold in India; they are a convenience for a person who is
 * about to confirm them, never an assertion about the meter on her table.
 *
 * Storage lives in `app_meta` via `src/db/repositories/settings.ts`, alongside the name
 * of the human who set it and the date — the same provenance `target_range` carries, for
 * the same reason: the OPD report has to be able to say whose number this is.
 */
export type GlucometerSeed = {
  key: string;
  label: string;
  /** mg/dL. Below this the meter prints LO. */
  low: number;
  /** mg/dL. Above this the meter prints HI. */
  high: number;
};

export const GLUCOMETERS: readonly GlucometerSeed[] = [
  { key: 'onetouch_select_plus', label: 'OneTouch Select Plus', low: 20, high: 600 },
  { key: 'onetouch_verio', label: 'OneTouch Verio', low: 20, high: 600 },
  { key: 'accu_chek_instant', label: 'Accu-Chek Instant', low: 20, high: 600 },
  { key: 'accu_chek_active', label: 'Accu-Chek Active', low: 10, high: 600 },
  { key: 'contour_plus', label: 'Contour Plus', low: 10, high: 600 },
  { key: 'dr_morepen_gluco_one', label: 'Dr Morepen GlucoOne', low: 20, high: 600 },
  { key: 'accusure', label: 'Accusure', low: 20, high: 600 },
  { key: 'beato', label: 'BeatO', low: 20, high: 600 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Symptoms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every label is a DESCRIPTION OF A SENSATION, never an inference about its
 * cause. "Shaky or sweating", not "low sugar". "Yellow eyes", not "jaundice".
 * The app records what she noticed; naming the cause is a diagnosis, and it is
 * also frequently wrong.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 * There is no "orange urine" chip, and there will not be one.
 *
 * Rifampicin turns urine, sweat and tears orange in essentially everyone who
 * takes it. It is harmless, it is expected, and it is the single most common
 * reason a TB patient stops her tablets in week two. Offering it as a chip
 * would put it on the same visual footing as "blood in sputum" and teach a
 * six-month-long worry about a non-problem. Where it belongs is the medicine's
 * own information screen, said once, plainly, before it happens.
 *
 * "Dark urine" and "yellow eyes" DO stay, as neutral chips with no explanation
 * attached — they are things a person can observe about herself, and she is
 * entitled to record an observation without the app telling her what it means.
 * The chip carries the observation to the doctor. The doctor supplies the
 * meaning. That division is the whole design.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type SymptomSeed = {
  key: string;
  labelEn: string;
  labelHi: string;
  isBase: boolean;
  /**
   * EXPLICIT, never positional.
   *
   * This used to be the row's index in the array times ten, computed at seed time. That
   * made inserting a symptom in the middle a silent data change: a fresh install got the
   * new numbering, a phone that already had the rows kept the old one (INSERT OR IGNORE
   * cannot update an existing row), and the same build ordered the same chips two
   * different ways with nothing to see in the diff. Migration v4 brings existing phones
   * onto these numbers; the two lists must stay in step.
   */
  sortOrder: number;
  /**
   * Set on a key that must never be OFFERED again but must keep rendering for the events
   * that already point at it. Symptom labels are resolved from this table at read time,
   * so relabelling or deleting a row rewrites history on a page a doctor reads.
   */
  retiredAtEpoch?: number;
};

/**
 * 2026-08-12T00:00:00Z. A fixed constant, matching the literal in migration v4.
 *
 * `Date.now()` here would stamp a fresh install with the day that phone was set up,
 * which is not the day anything was retired.
 */
export const RETIRED_AT_EPOCH = 1786492800000;

/**
 * The base chips, offered to every profile whichever packs are on, ordered by how often
 * this patient group actually reports them rather than alphabetically. The first six
 * carry most of the taps, and a chip she has to hunt for is a symptom that never gets
 * recorded.
 *
 * Keys are FROZEN — `src/app/_shared/lib.tsx` names the first twelve, and a
 * `symptom_event` already recorded points at one by key.
 *
 * ── WHY `nausea` AND `vomiting` ARE TWO CHIPS ────────────────────────────────
 * They shipped as one, `nausea_vomiting` / "Feeling sick or vomiting". On a TB course
 * the two observations do different work: some nausea in the first weeks is ordinary and
 * expected, while vomiting that keeps happening is one of the things a doctor asks about
 * by name, particularly alongside "yellow eyes" or "dark urine". A single merged chip
 * means the record cannot tell them apart afterwards, and neither can the person reading
 * it.
 *
 * The old key is NOT relabelled and NOT deleted — see `retiredAtEpoch` above. Every event
 * she already recorded keeps the honest combined wording it was recorded under.
 */
export const BASE_SYMPTOMS: readonly SymptomSeed[] = [
  { key: 'breathless', labelEn: 'Breathless', labelHi: 'साँस फूलना', isBase: true, sortOrder: 10 },
  {
    key: 'chest_discomfort',
    labelEn: 'Discomfort in the chest',
    labelHi: 'छाती में तकलीफ़',
    isBase: true,
    sortOrder: 20,
  },
  {
    key: 'dizzy',
    labelEn: 'Dizzy or light-headed',
    labelHi: 'चक्कर आना',
    isBase: true,
    sortOrder: 30,
  },
  { key: 'very_tired', labelEn: 'Very tired', labelHi: 'बहुत थकान', isBase: true, sortOrder: 40 },
  {
    key: 'swollen_feet',
    labelEn: 'Swollen feet or ankles',
    labelHi: 'पैरों में सूजन',
    isBase: true,
    sortOrder: 50,
  },
  { key: 'cough', labelEn: 'Cough', labelHi: 'खाँसी', isBase: true, sortOrder: 60 },
  { key: 'fever', labelEn: 'Fever', labelHi: 'बुखार', isBase: true, sortOrder: 70 },
  {
    key: 'shaky_sweaty',
    labelEn: 'Shaky or sweating',
    labelHi: 'कँपकँपी या पसीना',
    isBase: true,
    sortOrder: 80,
  },
  {
    key: 'night_sweats',
    labelEn: 'Sweating at night',
    labelHi: 'रात में पसीना',
    isBase: true,
    sortOrder: 90,
  },
  {
    key: 'blurred_vision',
    labelEn: 'Blurred sight',
    labelHi: 'धुंधला दिखना',
    isBase: true,
    sortOrder: 100,
  },
  {
    key: 'numb_feet',
    labelEn: 'Numbness or tingling in the feet',
    labelHi: 'पैरों में सुन्नपन',
    isBase: true,
    sortOrder: 110,
  },
  { key: 'poor_appetite', labelEn: 'Not hungry', labelHi: 'भूख न लगना', isBase: true, sortOrder: 120 },
  { key: 'headache', labelEn: 'Headache', labelHi: 'सिरदर्द', isBase: true, sortOrder: 130 },
  { key: 'nausea', labelEn: 'Feeling sick', labelHi: 'जी मिचलाना', isBase: true, sortOrder: 140 },
  { key: 'vomiting', labelEn: 'Vomiting', labelHi: 'उल्टी', isBase: true, sortOrder: 150 },
  { key: 'stomach_pain', labelEn: 'Stomach pain', labelHi: 'पेट में दर्द', isBase: true, sortOrder: 160 },
  {
    key: 'sleep_trouble',
    labelEn: 'Trouble sleeping',
    labelHi: 'नींद न आना',
    isBase: true,
    sortOrder: 170,
  },
  { key: 'joint_pain', labelEn: 'Joint pain', labelHi: 'जोड़ों में दर्द', isBase: true, sortOrder: 180 },
  { key: 'itching', labelEn: 'Itching', labelHi: 'खुजली', isBase: true, sortOrder: 190 },
  // RETIRED — replaced by `nausea` + `vomiting` above. Kept, with its original wording
  // untouched, so that every event already recorded against it still reads back exactly
  // as it was recorded. Nothing offers it; `listSymptomDefs()` and friends filter it out.
  {
    key: 'nausea_vomiting',
    labelEn: 'Feeling sick or vomiting',
    labelHi: 'जी मिचलाना या उल्टी',
    isBase: true,
    sortOrder: 195,
    retiredAtEpoch: RETIRED_AT_EPOCH,
  },
];

/** Offered only when the relevant pack is on. */
export const PACK_SYMPTOMS_EXTRA: readonly SymptomSeed[] = [
  {
    key: 'chest_pain',
    labelEn: 'Pain in the chest',
    labelHi: 'छाती में दर्द',
    isBase: false,
    sortOrder: 200,
  },
  {
    key: 'palpitations',
    labelEn: 'Heart beating fast or fluttering',
    labelHi: 'दिल का तेज़ या अनियमित धड़कना',
    isBase: false,
    sortOrder: 210,
  },
  {
    key: 'breathless_lying',
    labelEn: 'Breathless when lying flat',
    labelHi: 'लेटने पर साँस फूलना',
    isBase: false,
    sortOrder: 220,
  },
  {
    key: 'slow_healing_wound',
    labelEn: 'A cut or wound that is slow to heal',
    labelHi: 'घाव देर से भरना',
    isBase: false,
    sortOrder: 230,
  },
  {
    key: 'blood_in_sputum',
    labelEn: 'Blood in the sputum',
    labelHi: 'बलगम में खून',
    isBase: false,
    sortOrder: 240,
  },
  { key: 'wheeze', labelEn: 'Wheezing', labelHi: 'साँस में सीटी', isBase: false, sortOrder: 250 },
  // Neutral observations. No explanation is attached to either, on purpose.
  { key: 'yellow_eyes', labelEn: 'Yellow eyes', labelHi: 'आँखें पीली', isBase: false, sortOrder: 260 },
  {
    key: 'dark_urine',
    labelEn: 'Dark urine',
    labelHi: 'गहरे रंग का पेशाब',
    isBase: false,
    sortOrder: 270,
  },
  {
    key: 'unusual_bruising',
    labelEn: 'Bruises appearing easily',
    labelHi: 'आसानी से नील पड़ना',
    isBase: false,
    sortOrder: 280,
  },
  {
    key: 'bleeding_gums',
    labelEn: 'Bleeding gums',
    labelHi: 'मसूड़ों से खून',
    isBase: false,
    sortOrder: 290,
  },
  {
    key: 'blood_in_urine',
    labelEn: 'Blood in the urine',
    labelHi: 'पेशाब में खून',
    isBase: false,
    sortOrder: 300,
  },
  { key: 'black_stool', labelEn: 'Black stool', labelHi: 'काला मल', isBase: false, sortOrder: 310 },
  {
    key: 'passing_less_urine',
    labelEn: 'Passing less urine than usual',
    labelHi: 'पेशाब कम आना',
    isBase: false,
    sortOrder: 320,
  },
  {
    key: 'wound_discharge',
    labelEn: 'Discharge or redness at the wound',
    labelHi: 'घाव से रिसाव या लाली',
    isBase: false,
    sortOrder: 330,
  },
  {
    key: 'neck_swelling',
    labelEn: 'Swelling in the neck',
    labelHi: 'गले में सूजन',
    isBase: false,
    sortOrder: 340,
  },
  {
    key: 'feeling_cold',
    labelEn: 'Feeling cold when others do not',
    labelHi: 'दूसरों से ज़्यादा ठंड लगना',
    isBase: false,
    sortOrder: 350,
  },
];

export const PACK_SYMPTOMS: readonly (readonly [string, string])[] = [
  // Heart
  ['cardiac', 'chest_pain'],
  ['cardiac', 'chest_discomfort'],
  ['cardiac', 'breathless'],
  ['cardiac', 'breathless_lying'],
  ['cardiac', 'palpitations'],
  ['cardiac', 'swollen_feet'],
  ['cardiac', 'dizzy'],
  ['cardiac', 'very_tired'],

  // Blood pressure
  ['hypertension', 'headache'],
  ['hypertension', 'dizzy'],
  ['hypertension', 'swollen_feet'],
  ['hypertension', 'blurred_vision'],

  // Diabetes
  ['diabetes', 'shaky_sweaty'],
  ['diabetes', 'numb_feet'],
  ['diabetes', 'blurred_vision'],
  ['diabetes', 'slow_healing_wound'],
  ['diabetes', 'very_tired'],

  // TB — note the absence of an "orange urine" chip; see the block comment above.
  ['tb', 'cough'],
  ['tb', 'blood_in_sputum'],
  ['tb', 'night_sweats'],
  ['tb', 'fever'],
  ['tb', 'poor_appetite'],
  ['tb', 'joint_pain'],
  ['tb', 'nausea'],
  ['tb', 'vomiting'],
  ['tb', 'yellow_eyes'],
  ['tb', 'dark_urine'],

  // Breathing
  ['respiratory', 'breathless'],
  ['respiratory', 'cough'],
  ['respiratory', 'wheeze'],
  ['respiratory', 'chest_discomfort'],

  // Kidney
  ['kidney', 'swollen_feet'],
  ['kidney', 'passing_less_urine'],
  ['kidney', 'itching'],
  ['kidney', 'nausea'],
  ['kidney', 'vomiting'],
  ['kidney', 'very_tired'],

  // Blood thinner
  ['anticoagulation', 'unusual_bruising'],
  ['anticoagulation', 'bleeding_gums'],
  ['anticoagulation', 'blood_in_urine'],
  ['anticoagulation', 'black_stool'],

  // Thyroid
  ['thyroid', 'very_tired'],
  ['thyroid', 'neck_swelling'],
  ['thyroid', 'feeling_cold'],
  ['thyroid', 'palpitations'],
  ['thyroid', 'sleep_trouble'],

  // After an operation
  ['post_surgery', 'fever'],
  ['post_surgery', 'wound_discharge'],
  ['post_surgery', 'stomach_pain'],
  ['post_surgery', 'nausea'],
  ['post_surgery', 'vomiting'],
  ['post_surgery', 'sleep_trouble'],

  // General
  ['general', 'fever'],
  ['general', 'headache'],
  ['general', 'very_tired'],
  ['general', 'nausea'],
  ['general', 'vomiting'],
  ['general', 'stomach_pain'],
  ['general', 'sleep_trouble'],
];

// ─────────────────────────────────────────────────────────────────────────────
// Lab tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `unit` is the unit the test is USUALLY reported in, offered as a default when
 * she types a value. It is editable, because Indian labs disagree with each
 * other about units more often than anyone expects.
 *
 * There is no reference range here, and there is no column for one. A lab
 * result's range belongs to the paper it was printed on and is transcribed into
 * `lab_result.ref_range_text` exactly as printed, assay and all. Two labs
 * measuring the same analyte routinely print different ranges; an app-supplied
 * range would silently contradict the report the doctor is holding.
 */
export type LabTestSeed = {
  key: string;
  labelEn: string;
  labelHi: string;
  unit: string | null;
  sortOrder: number;
};

export const LAB_TESTS: readonly LabTestSeed[] = [
  { key: 'hba1c', labelEn: 'HbA1c', labelHi: 'एचबीए1सी', unit: '%', sortOrder: 10 },
  {
    key: 'fasting_glucose',
    labelEn: 'Fasting blood sugar',
    labelHi: 'खाली पेट ब्लड शुगर',
    unit: 'mg/dL',
    sortOrder: 20,
  },
  {
    key: 'post_meal_glucose',
    labelEn: 'Post-meal blood sugar',
    labelHi: 'खाने के बाद ब्लड शुगर',
    unit: 'mg/dL',
    sortOrder: 30,
  },
  // ── Liver (LFT) ──
  {
    key: 'liver_alt',
    labelEn: 'Liver test (ALT/SGPT)',
    labelHi: 'लिवर जाँच (ALT/SGPT)',
    unit: 'U/L',
    sortOrder: 40,
  },
  {
    key: 'liver_ast',
    labelEn: 'Liver test (AST/SGOT)',
    labelHi: 'लिवर जाँच (AST/SGOT)',
    unit: 'U/L',
    sortOrder: 50,
  },
  {
    key: 'bilirubin',
    labelEn: 'Bilirubin (total)',
    labelHi: 'बिलीरुबिन (कुल)',
    unit: 'mg/dL',
    sortOrder: 60,
  },
  // ── Kidney ──
  {
    key: 'creatinine',
    labelEn: 'Creatinine',
    labelHi: 'क्रिएटिनिन',
    unit: 'mg/dL',
    sortOrder: 70,
  },
  {
    key: 'egfr',
    labelEn: 'eGFR',
    labelHi: 'ईजीएफआर',
    unit: 'mL/min/1.73m²',
    sortOrder: 80,
  },
  { key: 'urea', labelEn: 'Urea', labelHi: 'यूरिया', unit: 'mg/dL', sortOrder: 90 },
  {
    key: 'potassium',
    labelEn: 'Potassium',
    labelHi: 'पोटैशियम',
    unit: 'mmol/L',
    sortOrder: 100,
  },
  { key: 'sodium', labelEn: 'Sodium', labelHi: 'सोडियम', unit: 'mmol/L', sortOrder: 110 },
  {
    key: 'urine_protein',
    labelEn: 'Protein in urine',
    labelHi: 'पेशाब में प्रोटीन',
    unit: null,
    sortOrder: 120,
  },
  // ── Blood count ──
  {
    key: 'cbc',
    labelEn: 'Complete blood count (CBC)',
    labelHi: 'पूरी खून की जाँच (CBC)',
    unit: null,
    sortOrder: 130,
  },
  {
    key: 'haemoglobin',
    labelEn: 'Haemoglobin',
    labelHi: 'हीमोग्लोबिन',
    unit: 'g/dL',
    sortOrder: 140,
  },
  // ── Lipids ──
  {
    key: 'lipid_profile',
    labelEn: 'Lipid profile',
    labelHi: 'लिपिड प्रोफ़ाइल',
    unit: null,
    sortOrder: 150,
  },
  {
    key: 'total_cholesterol',
    labelEn: 'Total cholesterol',
    labelHi: 'कुल कोलेस्ट्रॉल',
    unit: 'mg/dL',
    sortOrder: 160,
  },
  {
    key: 'ldl',
    labelEn: 'LDL cholesterol',
    labelHi: 'एलडीएल कोलेस्ट्रॉल',
    unit: 'mg/dL',
    sortOrder: 170,
  },
  {
    key: 'hdl',
    labelEn: 'HDL cholesterol',
    labelHi: 'एचडीएल कोलेस्ट्रॉल',
    unit: 'mg/dL',
    sortOrder: 180,
  },
  {
    key: 'triglycerides',
    labelEn: 'Triglycerides',
    labelHi: 'ट्राइग्लिसराइड',
    unit: 'mg/dL',
    sortOrder: 190,
  },
  // ── Clotting, thyroid, TB ──
  { key: 'inr', labelEn: 'INR', labelHi: 'आईएनआर', unit: null, sortOrder: 200 },
  { key: 'tsh', labelEn: 'TSH', labelHi: 'टीएसएच', unit: 'µIU/mL', sortOrder: 210 },
  { key: 't3', labelEn: 'T3', labelHi: 'टी3', unit: 'ng/dL', sortOrder: 220 },
  { key: 't4', labelEn: 'T4 (free)', labelHi: 'टी4 (फ्री)', unit: 'ng/dL', sortOrder: 230 },
  {
    key: 'sputum_afb',
    labelEn: 'Sputum test (AFB)',
    labelHi: 'बलगम जाँच (AFB)',
    unit: null,
    sortOrder: 240,
  },
  {
    key: 'sputum_cbnaat',
    labelEn: 'Sputum test (CBNAAT)',
    labelHi: 'बलगम जाँच (CBNAAT)',
    unit: null,
    sortOrder: 250,
  },
  {
    key: 'chest_xray',
    labelEn: 'Chest X-ray',
    labelHi: 'छाती का एक्स-रे',
    unit: null,
    sortOrder: 260,
  },
];

export const PACK_LAB_TESTS: readonly (readonly [string, string])[] = [
  ['diabetes', 'hba1c'],
  ['diabetes', 'fasting_glucose'],
  ['diabetes', 'post_meal_glucose'],
  ['diabetes', 'creatinine'],
  ['diabetes', 'urine_protein'],
  ['diabetes', 'lipid_profile'],

  ['hypertension', 'creatinine'],
  ['hypertension', 'egfr'],
  ['hypertension', 'potassium'],
  ['hypertension', 'sodium'],
  ['hypertension', 'lipid_profile'],

  ['cardiac', 'lipid_profile'],
  ['cardiac', 'total_cholesterol'],
  ['cardiac', 'ldl'],
  ['cardiac', 'hdl'],
  ['cardiac', 'triglycerides'],
  ['cardiac', 'creatinine'],
  ['cardiac', 'potassium'],
  ['cardiac', 'cbc'],

  ['kidney', 'creatinine'],
  ['kidney', 'egfr'],
  ['kidney', 'urea'],
  ['kidney', 'potassium'],
  ['kidney', 'sodium'],
  ['kidney', 'haemoglobin'],
  ['kidney', 'urine_protein'],

  ['thyroid', 'tsh'],
  ['thyroid', 't3'],
  ['thyroid', 't4'],

  ['anticoagulation', 'inr'],
  ['anticoagulation', 'haemoglobin'],
  ['anticoagulation', 'cbc'],

  ['tb', 'sputum_afb'],
  ['tb', 'sputum_cbnaat'],
  ['tb', 'chest_xray'],
  ['tb', 'liver_alt'],
  ['tb', 'liver_ast'],
  ['tb', 'bilirubin'],
  ['tb', 'haemoglobin'],
  ['tb', 'cbc'],

  ['respiratory', 'cbc'],
  ['respiratory', 'chest_xray'],

  ['post_surgery', 'cbc'],
  ['post_surgery', 'haemoglobin'],
  ['post_surgery', 'creatinine'],

  ['general', 'cbc'],
  ['general', 'haemoglobin'],
];

// ─────────────────────────────────────────────────────────────────────────────
// The seed
// ─────────────────────────────────────────────────────────────────────────────

const INSERT_PACK = `INSERT OR IGNORE INTO condition_pack
  (key, label_en, label_hi, description_en, sort_order) VALUES (?, ?, ?, ?, ?);`;

const INSERT_METRIC = `INSERT OR IGNORE INTO metric_def
  (key, label_en, label_hi, unit, value_kind, schema_json, chart_kind,
   min_valid, max_valid, is_builtin, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?);`;

const INSERT_PACK_METRIC = `INSERT OR IGNORE INTO pack_metric (pack_key, metric_key) VALUES (?, ?);`;

const INSERT_SYMPTOM = `INSERT OR IGNORE INTO symptom_def
  (key, label_en, label_hi, is_base, sort_order, retired_at_epoch) VALUES (?, ?, ?, ?, ?, ?);`;

const INSERT_PACK_SYMPTOM = `INSERT OR IGNORE INTO pack_symptom (pack_key, symptom_key) VALUES (?, ?);`;

const INSERT_LAB = `INSERT OR IGNORE INTO lab_test_def
  (key, label_en, label_hi, unit, sort_order) VALUES (?, ?, ?, ?, ?);`;

const INSERT_PACK_LAB = `INSERT OR IGNORE INTO pack_lab_test (pack_key, test_key) VALUES (?, ?);`;

/** What a run inserted (or would have, had the rows been absent). */
export type SeedCounts = {
  packs: number;
  metrics: number;
  packMetrics: number;
  symptoms: number;
  packSymptoms: number;
  labTests: number;
  packLabTests: number;
  /** Always 0. Asserted by the caller in tests, and by review. */
  targetRanges: 0;
};

/**
 * Populate the reference registry. Idempotent; safe on every boot.
 *
 * The insert ORDER matters: `pack_metric`, `pack_symptom` and `pack_lab_test`
 * all carry foreign keys into the three definition tables and into
 * `condition_pack`, and `PRAGMA foreign_keys = ON` is set when the database is
 * opened. Definitions first, joins after.
 */
export async function seedReferenceData(db: SeedDatabase): Promise<SeedCounts> {
  for (const pack of CONDITION_PACKS) {
    await db.runAsync(INSERT_PACK, [
      pack.key,
      pack.labelEn,
      pack.labelHi,
      pack.descriptionEn,
      pack.sortOrder,
    ]);
  }

  for (const metric of METRICS) {
    await db.runAsync(INSERT_METRIC, [
      metric.key,
      metric.labelEn,
      metric.labelHi,
      metric.unit,
      metric.valueKind,
      JSON.stringify(metric.schema),
      metric.chartKind,
      metric.minValid,
      metric.maxValid,
      metric.sortOrder,
    ]);
  }

  // `sortOrder` comes off the row, NOT off the loop index. The positional version used
  // to renumber every later key whenever one was inserted in the middle — a change no
  // phone that already had the rows could ever receive, because INSERT OR IGNORE cannot
  // update an existing row. Migration v4 is what brings existing phones onto these
  // numbers; if you edit a `sortOrder` here, it needs a migration to go with it.
  const symptoms = [...BASE_SYMPTOMS, ...PACK_SYMPTOMS_EXTRA];
  for (const symptom of symptoms) {
    await db.runAsync(INSERT_SYMPTOM, [
      symptom.key,
      symptom.labelEn,
      symptom.labelHi,
      symptom.isBase ? 1 : 0,
      symptom.sortOrder,
      symptom.retiredAtEpoch ?? null,
    ]);
  }

  for (const lab of LAB_TESTS) {
    await db.runAsync(INSERT_LAB, [lab.key, lab.labelEn, lab.labelHi, lab.unit, lab.sortOrder]);
  }

  for (const [pack, metric] of PACK_METRICS) {
    await db.runAsync(INSERT_PACK_METRIC, [pack, metric]);
  }
  for (const [pack, symptom] of PACK_SYMPTOMS) {
    await db.runAsync(INSERT_PACK_SYMPTOM, [pack, symptom]);
  }
  for (const [pack, test] of PACK_LAB_TESTS) {
    await db.runAsync(INSERT_PACK_LAB, [pack, test]);
  }

  // No target_range write happens here, and none ever should. If you are adding
  // one because a screen looks empty without it: the empty state is the feature.
  // The chart draws no band until a named human has said what the band is.
  return {
    packs: CONDITION_PACKS.length,
    metrics: METRICS.length,
    packMetrics: PACK_METRICS.length,
    symptoms: symptoms.length,
    packSymptoms: PACK_SYMPTOMS.length,
    labTests: LAB_TESTS.length,
    packLabTests: PACK_LAB_TESTS.length,
    targetRanges: 0,
  };
}
