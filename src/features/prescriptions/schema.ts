/**
 * The contract with the model: the Gemini `responseSchema` and the zod parser that
 * refuses to trust it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR DECISIONS THAT SHAPE EVERY FIELD BELOW
 *
 * 1. NO `anyOf`, ANYWHERE. The structured-output subset drops recursive schemas and most
 *    constraint keywords, and `propertyOrdering` behaviour inside a union is
 *    undocumented. So there are no unions: a field that might be absent is a plain field
 *    with an explicit "unknown" member (strings and enums) or the value 0 (numbers).
 *
 * 2. LARGE BUT SHALLOW. Nesting stays at or under five levels — root → medicines array →
 *    a medicine → `frequency` → its primitives. Nothing nests deeper, which is why
 *    `frequency`, `dose_quantity`, `duration` and `confidence` hold primitives only.
 *
 * 3. EVERY FIELD IS REQUIRED. A model that may omit a field will omit different fields on
 *    different runs, and the parser can then never tell "not on the paper" from "did not
 *    answer". Requiring everything, with "unknown" as a first-class value, makes silence
 *    explicit and countable.
 *
 * 4. THE PARSER IS TOLERANT, THE SCHEMA IS STRICT. The schema asks for exactly one shape;
 *    the zod pass then accepts an unexpected enum value, a number sent as a string, or a
 *    missing array without discarding the other fourteen medicines that came back
 *    perfectly. Every such lenience is recorded as a warning the review screen can show.
 *
 * `total_medicines_counted` deserves its own note: the model counts the medicine lines it
 * can SEE before it transcribes them, and the parser compares that number against the
 * length of the array. Disagreement is the cheapest available detector of a dropped
 * line — the failure mode that is otherwise invisible, because a list of four correct
 * medicines looks exactly like a correct list of four.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';

import { aiError, type AiError } from '../ai/errors';
import type { Criticality } from '../../types';

// ── Vocabularies (shared by the Gemini schema and the zod parser) ────────────

const UNKNOWN = 'unknown';

export const FORM_VALUES = [
  'tablet',
  'capsule',
  'syrup',
  'injection',
  'inhaler',
  'drops',
  'cream',
  'other',
  UNKNOWN,
] as const;

export const FOOD_RELATION_VALUES = ['before', 'after', 'with', 'empty', 'any', UNKNOWN] as const;

export const ROUTE_VALUES = [
  'oral',
  'topical',
  'inhaled',
  'injection',
  'ophthalmic',
  'otic',
  'nasal',
  'rectal',
  'vaginal',
  'sublingual',
  'other',
  UNKNOWN,
] as const;

export const CRITICALITY_VALUES = ['critical', 'standard', 'low', UNKNOWN] as const;

export const CONFIDENCE_VALUES = ['high', 'medium', 'low', UNKNOWN] as const;

export const DURATION_KIND_VALUES = [
  'days',
  'weeks',
  'months',
  /** "continue", "to be continued", no end written. */
  'continue',
  /** "till review", "until next visit". */
  'until_review',
  /** A stepped-down course. Never flattened into one schedule. */
  'tapering',
  UNKNOWN,
] as const;

export const RELATIVE_UNIT_VALUES = ['day', 'week', 'month', 'year', UNKNOWN] as const;

/**
 * Test categories exist for ONE reason: the care calendar's turnaround defaults. They are
 * an operational bucket (how long a report usually takes to come back), not a clinical
 * classification.
 */
export const TEST_CATEGORY_VALUES = [
  'routine_biochemistry',
  'culture',
  'histopathology',
  'imaging',
  'other',
  UNKNOWN,
] as const;

export const INSTRUCTION_KIND_VALUES = [
  'diet',
  'activity',
  'wound_care',
  /** "come back if the fever does not settle" — a condition attached to the follow-up. */
  'return_condition',
  'other',
  UNKNOWN,
] as const;

export type MedicineForm = (typeof FORM_VALUES)[number];
export type FoodRelation = (typeof FOOD_RELATION_VALUES)[number];
export type Route = (typeof ROUTE_VALUES)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_VALUES)[number];
export type DurationKind = (typeof DURATION_KIND_VALUES)[number];
export type RelativeUnit = (typeof RELATIVE_UNIT_VALUES)[number];
export type TestCategory = (typeof TEST_CATEGORY_VALUES)[number];
export type InstructionKind = (typeof INSTRUCTION_KIND_VALUES)[number];

// ── Gemini response schema ───────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

const S = {
  string(description: string): JsonSchema {
    return { type: 'STRING', description };
  },
  enumOf(values: readonly string[], description: string): JsonSchema {
    return { type: 'STRING', format: 'enum', enum: [...values], description };
  },
  number(description: string): JsonSchema {
    return { type: 'NUMBER', description };
  },
  integer(description: string): JsonSchema {
    return { type: 'INTEGER', description };
  },
  boolean(description: string): JsonSchema {
    return { type: 'BOOLEAN', description };
  },
  /** Every property is required, and declaration order is the emission order. */
  object(properties: Record<string, JsonSchema>, description: string): JsonSchema {
    const keys = Object.keys(properties);
    return { type: 'OBJECT', description, properties, required: keys, propertyOrdering: keys };
  },
  array(items: JsonSchema, description: string): JsonSchema {
    return { type: 'ARRAY', description, items };
  },
} as const;

/** The value that means "not written on the paper, or not readable". */
const UNKNOWN_NOTE = `Use the exact string "${UNKNOWN}" when it is not written or cannot be read. Never guess.`;
const ZERO_NOTE = 'Use 0 when it is not written or cannot be read. Never guess.';

const MEDICINE_SCHEMA = S.object(
  {
    name_as_written: S.string(
      `The drug name exactly as it appears, including the prefix (Tab., Cap., Syp., Inj.) if written. ${UNKNOWN_NOTE}`,
    ),
    generic_guess: S.string(
      `The generic/molecule name if you are confident of it from the brand name. ${UNKNOWN_NOTE}`,
    ),
    strength: S.string(`Strength as written, with units: "500 mg", "10 ml", "40 IU". ${UNKNOWN_NOTE}`),
    form: S.enumOf(FORM_VALUES, 'The dosage form, from the prefix or the wording.'),
    dose_quantity: S.object(
      {
        value: S.number(`How many units are taken at ONE time: 1, 2, 0.5. ${ZERO_NOTE}`),
        unit: S.string(`The unit of that quantity: "tablet", "ml", "puff", "drop". ${UNKNOWN_NOTE}`),
        verbatim: S.string(
          `The quantity exactly as written, including fractions: "1/2", "½", "1 tab". ${UNKNOWN_NOTE}`,
        ),
      },
      'How much is taken at one time — a number AND the text it came from.',
    ),
    frequency: S.object(
      {
        pattern_code: S.string(
          `The frequency in a normalised code. Use one of: a slot pattern like "1-0-1" or "1-1-1-1"; OD; BD; TDS; QID; HS; SOS; STAT; Q6H (or any Q<n>H); "alternate day"; "weekly". Combine a rhythm with a modifier where both are written, e.g. "OD alternate day". ${UNKNOWN_NOTE}`,
        ),
        slot_notation: S.string(
          `The morning-afternoon-night pattern if the prescription uses that notation, exactly as written: "1-0-1", "1/2-0-1/2". Three parts are morning-afternoon-night; four are morning-afternoon-evening-night. ${UNKNOWN_NOTE}`,
        ),
        doses_per_day: S.number(`How many times per day it is taken. ${ZERO_NOTE}`),
        interval_days: S.number(
          `1 for every day, 2 for alternate days, 7 for weekly. ${ZERO_NOTE}`,
        ),
        verbatim: S.string(`The frequency exactly as written on the paper. ${UNKNOWN_NOTE}`),
      },
      'How often it is taken. Transcribe the notation; do not convert it into clock times.',
    ),
    food_relation: S.enumOf(
      FOOD_RELATION_VALUES,
      'Only if written (a/f, p/c, before food, empty stomach). "any" only if the paper says food does not matter.',
    ),
    /**
     * THE EVIDENCE FOR THE FIELD ABOVE, and the reason it can be shown to a person at all.
     *
     * `food_relation` is an enum, and an enum is the easiest thing in this response for a
     * model to produce out of nothing: "after" is the most probable value for an Indian
     * prescription whether or not the paper says a word about food. Requiring the words
     * that produced it turns that into a check — `proposeFoodRelation` refuses any
     * relation with nothing quoted here, so an invented enum reaches no one.
     *
     * It also fixes the direction that matters in this household: an anti-TB drug is
     * dosed on an empty stomach, and moving it to "after food" is the wrong way round.
     */
    food_relation_verbatim: S.string(
      `The words that told you the food instruction, exactly as written: "a/f", "p/c", "before food", "empty stomach". ${UNKNOWN_NOTE} A food_relation with nothing quoted here is read as though the paper said nothing about food.`,
    ),
    duration: S.object(
      {
        kind: S.enumOf(DURATION_KIND_VALUES, 'What kind of duration is written.'),
        value: S.number(`The number of days/weeks/months written ("x 5 days" is 5). ${ZERO_NOTE}`),
        verbatim: S.string(`The duration exactly as written: "x 5 days", "1 month". ${UNKNOWN_NOTE}`),
      },
      'How long it is to be taken for.',
    ),
    route: S.enumOf(ROUTE_VALUES, 'Route of administration, if it can be told from the paper.'),
    proposed_criticality: S.enumOf(
      CRITICALITY_VALUES,
      'A PROPOSAL for how loudly the reminder should sound: "critical" for a medicine where a missed dose matters most, "standard" for everyday medicines, "low" for supplements and as-needed medicines. This is a proposal about REMINDER LOUDNESS only. It is never advice and a human always decides.',
    ),
    criticality_reason: S.string(
      `One short factual sentence for the proposal above, grounded in what is written (for example "a fixed-duration antibiotic course"). No clinical advice. ${UNKNOWN_NOTE}`,
    ),
    confidence: S.object(
      {
        name: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the drug name.'),
        strength: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the strength.'),
        frequency: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the frequency.'),
        // Rates the food mark alone — an "a/f" scribble is often clear on a line whose
        // drug name is not, and the reverse. A per-line flag cannot say that.
        food: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the food instruction.'),
        duration: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the duration.'),
      },
      'Per-field confidence. Be honest: "low" is useful, a confident wrong answer is not.',
    ),
    needs_human_check: S.boolean(
      'True if ANY part of this line is unclear, ambiguous, overwritten, or you had to choose between two readings.',
    ),
    notes: S.string(
      `Anything about this line a person should know before trusting it — "the strength is overwritten", "the line runs off the edge of the photo". ${UNKNOWN_NOTE}`,
    ),
  },
  'One prescribed medicine, transcribed.',
);

export const PRESCRIPTION_RESPONSE_SCHEMA: JsonSchema = S.object(
  {
    total_medicines_counted: S.integer(
      'Count the numbered or bulleted medicine lines you can SEE, before transcribing any of them. This is a cross-check against the length of the medicines array — if they disagree, a line was missed.',
    ),
    medicines: S.array(MEDICINE_SCHEMA, 'One entry per prescribed medicine, in the order written.'),
    prescriber: S.string(
      `The doctor's name, ONLY if it appears in this image. Usually it does not, because the letterhead is cropped away before the photo is sent. ${UNKNOWN_NOTE}`,
    ),
    clinic: S.string(
      `The clinic or hospital name, ONLY if it appears in this image. ${UNKNOWN_NOTE}`,
    ),
    prescribed_on: S.string(
      `The date the prescription was written, as YYYY-MM-DD. Indian prescriptions write DD/MM/YY or DD-MM-YYYY; a two-digit year in the 20s means 20xx. ${UNKNOWN_NOTE}`,
    ),
    prescribed_on_verbatim: S.string(
      `That date exactly as written on the paper: "12/8/26". ${UNKNOWN_NOTE}`,
    ),
    prescribed_on_confidence: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the date.'),
    follow_up: S.object(
      {
        present: S.boolean('True ONLY if a follow-up or review instruction is actually written.'),
        verbatim: S.string(
          `The follow-up instruction exactly as written: "review after 1 month", "f/u 2 wks", "come back on 14/08". ${UNKNOWN_NOTE}`,
        ),
        absolute_date: S.string(
          `An explicit follow-up DATE if one is written, as YYYY-MM-DD. ${UNKNOWN_NOTE}`,
        ),
        relative_value: S.number(
          `The number in a relative instruction ("after 2 weeks" is 2). ${ZERO_NOTE}`,
        ),
        relative_unit: S.enumOf(RELATIVE_UNIT_VALUES, 'The unit of that relative instruction.'),
        confidence: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of the follow-up instruction.'),
      },
      'The follow-up instruction. Set present=false and everything else to unknown/0 if none is written. Never infer a follow-up from the medicines.',
    ),
    tests_advised: S.array(
      S.object(
        {
          name_as_written: S.string('The test exactly as written: "LFT", "CBC", "USG abdomen".'),
          normalised_name: S.string(
            `The full name of that test if you are confident: "Liver function test". ${UNKNOWN_NOTE}`,
          ),
          category: S.enumOf(
            TEST_CATEGORY_VALUES,
            'Which kind of test this is. Used only to estimate how long the report takes.',
          ),
          verbatim_instruction: S.string(
            `Any timing written with it: "repeat LFT after 2 weeks", "before next visit". ${UNKNOWN_NOTE}`,
          ),
          confidence: S.enumOf(CONFIDENCE_VALUES, 'How sure you are of this test.'),
        },
        'One advised test.',
      ),
      'Tests the doctor actually wrote. Empty array if none are written. Never suggest a test.',
    ),
    non_medicine_instructions: S.array(
      S.object(
        {
          text: S.string('The instruction transcribed exactly as written.'),
          kind: S.enumOf(INSTRUCTION_KIND_VALUES, 'What kind of instruction it is.'),
        },
        'One non-medicine instruction.',
      ),
      'Written instructions that are not medicines and not tests. Empty array if none.',
    ),
    page_notes: S.string(
      `Anything about the PHOTO a person should know: "the bottom edge is cut off", "this looks like page 2". ${UNKNOWN_NOTE}`,
    ),
  },
  'Everything transcribed from one photographed prescription.',
);

// ── zod parser ───────────────────────────────────────────────────────────────

/**
 * Strings that a model uses to say "nothing here". All of them collapse to null, so
 * downstream code has exactly one way to ask "was this written?".
 */
const EMPTY_STRINGS = new Set([
  '',
  'unknown',
  'n/a',
  'na',
  'none',
  'nil',
  'not written',
  'not specified',
  'not mentioned',
  'not legible',
  'illegible',
  '-',
  '--',
  'null',
  'undefined',
]);

/** Any string → trimmed text, or null. Never throws, never rejects. */
const text = z.unknown().optional().transform((value): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (EMPTY_STRINGS.has(trimmed.toLowerCase())) return null;
  return trimmed;
});

/**
 * Any number → a finite positive number, or null.
 *
 * Accepts a numeric string because a model that has been told "0 means unknown" will
 * occasionally send "0". Zero and negatives both mean "not written" by the schema's own
 * convention, and neither is a meaningful dose, duration or interval.
 */
const positiveNumber = z.unknown().optional().transform((value): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
});

const integerOrNull = z.unknown().optional().transform((value): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
});

const flag = z.unknown().optional().transform((value): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
});

/**
 * An enum that cannot fail.
 *
 * A model returning "twice_daily" where the schema said "unknown" must not throw away the
 * other thirteen medicines in the response. The unrecognised value lands on the fallback,
 * and the caller counts it as a field a human has to look at.
 */
function tolerantEnum<T extends string>(values: readonly T[], fallback: T) {
  const allowed = new Set<string>(values);
  return z.unknown().optional().transform((value): T => {
    if (typeof value !== 'string') return fallback;
    const normalised = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return allowed.has(normalised) ? (normalised as T) : fallback;
  });
}

/** 'YYYY-MM-DD' or null. A date the app cannot parse is not a date it may act on. */
const isoDate = z.unknown().optional().transform((value): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [year, month, day] = trimmed.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-tripping catches 2026-02-31, which passes every range check above.
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return trimmed;
});

const medicineSchema = z.object({
  name_as_written: text,
  generic_guess: text,
  strength: text,
  form: tolerantEnum(FORM_VALUES, UNKNOWN),
  dose_quantity: z
    .object({ value: positiveNumber, unit: text, verbatim: text })
    .partial()
    .default({}),
  frequency: z
    .object({
      pattern_code: text,
      slot_notation: text,
      doses_per_day: positiveNumber,
      interval_days: positiveNumber,
      verbatim: text,
    })
    .partial()
    .default({}),
  food_relation: tolerantEnum(FOOD_RELATION_VALUES, UNKNOWN),
  food_relation_verbatim: text,
  duration: z
    .object({
      kind: tolerantEnum(DURATION_KIND_VALUES, UNKNOWN),
      value: positiveNumber,
      verbatim: text,
    })
    .partial()
    .default({}),
  route: tolerantEnum(ROUTE_VALUES, UNKNOWN),
  proposed_criticality: tolerantEnum(CRITICALITY_VALUES, UNKNOWN),
  criticality_reason: text,
  confidence: z
    .object({
      name: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
      strength: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
      frequency: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
      food: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
      duration: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
    })
    .partial()
    .default({}),
  needs_human_check: flag,
  notes: text,
});

const rawExtractionSchema = z.object({
  total_medicines_counted: integerOrNull,
  medicines: z.array(medicineSchema).default([]),
  prescriber: text,
  clinic: text,
  prescribed_on: isoDate,
  prescribed_on_verbatim: text,
  prescribed_on_confidence: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
  follow_up: z
    .object({
      present: flag,
      verbatim: text,
      absolute_date: isoDate,
      relative_value: positiveNumber,
      relative_unit: tolerantEnum(RELATIVE_UNIT_VALUES, UNKNOWN),
      confidence: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
    })
    .partial()
    .default({}),
  tests_advised: z
    .array(
      z.object({
        name_as_written: text,
        normalised_name: text,
        category: tolerantEnum(TEST_CATEGORY_VALUES, UNKNOWN),
        verbatim_instruction: text,
        confidence: tolerantEnum(CONFIDENCE_VALUES, UNKNOWN),
      }),
    )
    .default([]),
  non_medicine_instructions: z
    .array(z.object({ text, kind: tolerantEnum(INSTRUCTION_KIND_VALUES, UNKNOWN) }))
    .default([]),
  page_notes: text,
});

// ── Domain shapes (what the rest of the app sees) ────────────────────────────

export type ParsedDoseQuantity = {
  readonly value: number | null;
  readonly unit: string | null;
  /** The text it came from. Kept because "1/2" is not 0.5 to a person reading a strip. */
  readonly verbatim: string | null;
};

export type ParsedFrequency = {
  readonly patternCode: string | null;
  readonly slotNotation: string | null;
  readonly dosesPerDay: number | null;
  readonly intervalDays: number | null;
  readonly verbatim: string | null;
};

export type ParsedDuration = {
  readonly kind: DurationKind;
  readonly value: number | null;
  readonly verbatim: string | null;
};

export type ParsedMedicine = {
  readonly nameAsWritten: string | null;
  readonly genericGuess: string | null;
  readonly strength: string | null;
  readonly form: MedicineForm;
  readonly doseQuantity: ParsedDoseQuantity;
  readonly frequency: ParsedFrequency;
  readonly foodRelation: FoodRelation;
  /**
   * The words behind `foodRelation`. Null means the paper said nothing about food —
   * and, because an enum is cheap for a model to invent, null ALSO means `foodRelation`
   * must not be acted on. `propose.ts` enforces that; nothing else may relax it.
   *
   * Null on every extraction stored before this field existed, which is correct: those
   * rows genuinely have no recorded evidence, and a proposal without evidence is the one
   * thing this pipeline refuses to show.
   */
  readonly foodRelationVerbatim: string | null;
  readonly duration: ParsedDuration;
  readonly route: Route;
  /** A proposal about reminder loudness. Never applied without a human. */
  readonly proposedCriticality: Criticality | null;
  readonly criticalityReason: string | null;
  readonly confidence: {
    readonly name: ConfidenceLevel;
    readonly strength: ConfidenceLevel;
    readonly frequency: ConfidenceLevel;
    readonly food: ConfidenceLevel;
    readonly duration: ConfidenceLevel;
  };
  readonly needsHumanCheck: boolean;
  readonly notes: string | null;
};

export type ParsedTest = {
  readonly nameAsWritten: string | null;
  readonly normalisedName: string | null;
  readonly category: TestCategory;
  readonly verbatimInstruction: string | null;
  readonly confidence: ConfidenceLevel;
};

export type ParsedFollowUp = {
  readonly present: boolean;
  readonly verbatim: string | null;
  readonly absoluteDate: string | null;
  readonly relativeValue: number | null;
  readonly relativeUnit: RelativeUnit;
  readonly confidence: ConfidenceLevel;
};

export type ParsedPrescription = {
  readonly medicines: readonly ParsedMedicine[];
  readonly totalMedicinesCounted: number | null;
  readonly prescriber: string | null;
  readonly clinic: string | null;
  readonly prescribedOn: string | null;
  readonly prescribedOnVerbatim: string | null;
  readonly prescribedOnConfidence: ConfidenceLevel;
  readonly followUp: ParsedFollowUp;
  readonly testsAdvised: readonly ParsedTest[];
  readonly nonMedicineInstructions: readonly { text: string; kind: InstructionKind }[];
  readonly pageNotes: string | null;
  /** True when the model's own count disagrees with the array it returned. */
  readonly countMismatch: boolean;
};

export type ParseWarning = {
  readonly code:
    | 'count_mismatch'
    | 'medicine_without_name'
    | 'medicine_without_frequency'
    | 'no_medicines'
    | 'follow_up_without_evidence';
  readonly detail: string;
};

export type ParseResult =
  | { ok: true; value: ParsedPrescription; warnings: readonly ParseWarning[] }
  | { ok: false; error: AiError };

/**
 * Turn whatever came back into a `ParsedPrescription`, or into one typed failure.
 *
 * Two distinct failures, never merged: `schema_mismatch` means the response was not the
 * agreed shape at all, and `empty_result` means it was — and contained nothing. The first
 * is worth retrying; the second needs a better photograph. Telling the user to do the
 * wrong one of those wastes her afternoon.
 */
export function parsePrescriptionExtraction(json: unknown): ParseResult {
  const parsed = rawExtractionSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'unknown issue';
    return {
      ok: false,
      error: aiError('schema_mismatch', {
        detail: `${parsed.error.issues.length} issue(s), first at ${where}`,
      }),
    };
  }

  const raw = parsed.data;
  const warnings: ParseWarning[] = [];

  const medicines: ParsedMedicine[] = raw.medicines.map((m) => ({
    nameAsWritten: m.name_as_written,
    genericGuess: m.generic_guess,
    strength: m.strength,
    form: m.form,
    doseQuantity: {
      value: m.dose_quantity.value ?? null,
      unit: m.dose_quantity.unit ?? null,
      verbatim: m.dose_quantity.verbatim ?? null,
    },
    frequency: {
      patternCode: m.frequency.pattern_code ?? null,
      slotNotation: m.frequency.slot_notation ?? null,
      dosesPerDay: m.frequency.doses_per_day ?? null,
      intervalDays: m.frequency.interval_days ?? null,
      verbatim: m.frequency.verbatim ?? null,
    },
    foodRelation: m.food_relation,
    foodRelationVerbatim: m.food_relation_verbatim,
    duration: {
      kind: m.duration.kind ?? UNKNOWN,
      value: m.duration.value ?? null,
      verbatim: m.duration.verbatim ?? null,
    },
    route: m.route,
    proposedCriticality: m.proposed_criticality === UNKNOWN ? null : m.proposed_criticality,
    criticalityReason: m.criticality_reason,
    confidence: {
      name: m.confidence.name ?? UNKNOWN,
      strength: m.confidence.strength ?? UNKNOWN,
      frequency: m.confidence.frequency ?? UNKNOWN,
      food: m.confidence.food ?? UNKNOWN,
      duration: m.confidence.duration ?? UNKNOWN,
    },
    needsHumanCheck: m.needs_human_check,
    notes: m.notes,
  }));

  for (const [index, medicine] of medicines.entries()) {
    if (!medicine.nameAsWritten) {
      warnings.push({
        code: 'medicine_without_name',
        detail: `medicine ${index + 1} came back with no readable name`,
      });
    }
    if (!frequencyExpression(medicine)) {
      warnings.push({
        code: 'medicine_without_frequency',
        detail: `${medicine.nameAsWritten ?? `medicine ${index + 1}`} came back with no frequency`,
      });
    }
  }

  const counted = raw.total_medicines_counted;
  const countMismatch = counted !== null && counted !== medicines.length;
  if (countMismatch) {
    warnings.push({
      code: 'count_mismatch',
      detail: `the reader counted ${counted} medicine lines but returned ${medicines.length}`,
    });
  }

  const followUp: ParsedFollowUp = {
    present: raw.follow_up.present ?? false,
    verbatim: raw.follow_up.verbatim ?? null,
    absoluteDate: raw.follow_up.absolute_date ?? null,
    relativeValue: raw.follow_up.relative_value ?? null,
    relativeUnit: raw.follow_up.relative_unit ?? UNKNOWN,
    confidence: raw.follow_up.confidence ?? UNKNOWN,
  };

  // A follow-up with no words behind it is the one thing in this response that can put a
  // date on a calendar, so it is the one thing that must never be inferred. No verbatim
  // text means no evidence, and `care/guards.ts` will refuse it — this warning is so the
  // refusal is explainable rather than mysterious.
  if (followUp.present && !followUp.verbatim) {
    warnings.push({
      code: 'follow_up_without_evidence',
      detail: 'a follow-up was reported with no quoted text from the prescription',
    });
  }

  const value: ParsedPrescription = {
    medicines,
    totalMedicinesCounted: counted,
    prescriber: raw.prescriber,
    clinic: raw.clinic,
    prescribedOn: raw.prescribed_on,
    prescribedOnVerbatim: raw.prescribed_on_verbatim,
    prescribedOnConfidence: raw.prescribed_on_confidence,
    followUp,
    testsAdvised: raw.tests_advised.map((t) => ({
      nameAsWritten: t.name_as_written,
      normalisedName: t.normalised_name,
      category: t.category,
      verbatimInstruction: t.verbatim_instruction,
      confidence: t.confidence,
    })),
    nonMedicineInstructions: raw.non_medicine_instructions
      .filter((i): i is { text: string; kind: InstructionKind } => i.text !== null)
      .map((i) => ({ text: i.text, kind: i.kind })),
    pageNotes: raw.page_notes,
    countMismatch,
  };

  if (isNothing(value)) {
    return { ok: false, error: aiError('empty_result', { detail: 'nothing was transcribed' }) };
  }
  if (medicines.length === 0) {
    warnings.push({ code: 'no_medicines', detail: 'no medicines were transcribed' });
  }

  return { ok: true, value, warnings };
}

/**
 * "Right shape, nothing in it."
 *
 * Distinct from `medicines.length === 0`: a prescription that advises two tests and no
 * drugs is a real prescription and must reach the review screen.
 */
function isNothing(value: ParsedPrescription): boolean {
  return (
    value.medicines.length === 0 &&
    value.testsAdvised.length === 0 &&
    value.nonMedicineInstructions.length === 0 &&
    !value.followUp.present &&
    !value.prescribedOn
  );
}

/**
 * The best available string to feed to `decodeFrequency`.
 *
 * Order matters: the normalised code is what the model was asked for, the slot notation
 * is the next most structured, and the verbatim text is the last resort. `dosesPerDay`
 * alone is deliberately NOT used to synthesise a pattern — "3 times a day" says nothing
 * about which three times, and inventing morning/afternoon/night from a bare number is
 * exactly the guess this pipeline is built to refuse.
 *
 * THIS PICKS ONE AND DISCARDS TWO, which is right for a single decode and wrong for a
 * proposal. `propose.ts` decodes all three and requires them to agree before it will put
 * a number in front of anybody — a correct transcription that was then normalised wrong
 * ("1-0-1" in `slot_notation`, "QID" in `pattern_code`) is invisible here and is exactly
 * what that agreement check exists to catch. Keep the order below in step with it.
 */
export function frequencyExpression(medicine: ParsedMedicine): string | null {
  return medicine.frequency.patternCode ?? medicine.frequency.slotNotation ?? medicine.frequency.verbatim;
}

/** Typed view of `prescription.extraction_json` when it is read back from the database. */
export function parseStoredExtraction(stored: unknown): ParseResult {
  return parsePrescriptionExtraction(stored);
}
