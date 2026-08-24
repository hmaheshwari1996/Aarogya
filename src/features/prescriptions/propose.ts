/**
 * What the reading PROPOSES — and, when it proposes nothing, why not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A PROPOSAL IS NOT A DEFAULT, AND THAT IS THE WHOLE FILE
 *
 * The request behind this module was "the AI should fill in how many times a day, which
 * the user can edit if required". A pre-filled editable field is exactly the shape that
 * must not be built, and the reason is one sentence: the accepting path becomes DOING
 * NOTHING. `review.tsx` has said so since it was written — "a number on screen turns
 * typing into copying" — and the database says it structurally, because
 * `trg_occ_requires_confirmed_schedule` refuses to create a single dose occurrence for a
 * schedule no human confirmed. That trigger can tell a confirmation from no confirmation;
 * it cannot tell a considered confirmation from a reflex one. Only the screen can, and
 * only if what it renders is a QUESTION rather than an answer sitting in a box.
 *
 * So this module hands the screen a proposition, never a value:
 *
 *   • the number, and the slots it lands on;
 *   • the words it read, so the claim is checkable against the thing in her hand rather
 *     than against her memory of what the doctor said. THEY ARE A TRANSCRIPTION AND NOT
 *     THE PAPER, and the screen has to say so in those terms. Every field here comes from
 *     ONE response to ONE image: a glyph the model misread produces a `verbatim` that
 *     carries the misreading, `slot_notation` and `pattern_code` that agree with it, and a
 *     high self-rating — the ordinary outcome on a PRINTED discharge summary, where the
 *     model has no reason to doubt itself. The corroboration below detects
 *     MISNORMALISATION (a correct transcription turned into the wrong code); no amount of
 *     it can detect a shared misread. So the evidence line is an instruction to go and
 *     LOOK — "the app read these words, find them on the photo" — and never a claim about
 *     what is printed on the paper, which this app has no way to check;
 *   • how sure the model said it was;
 *   • or, instead of all of that, a REASON WHY NOT, so the screen can say "the paper does
 *     not say which" instead of showing an empty box and no explanation.
 *
 * Nothing here writes anything, and nothing here sets `confirmed_by_user_at`. A proposal
 * that is never accepted must leave the app in exactly the state it is in today.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FREQUENCY IS HARD TO EARN AND THE FOOD RELATION IS NOT
 *
 * They fail differently, so they are gated differently, and the asymmetry is deliberate.
 *
 * FREQUENCY IS A MULTIPLIER. "1-0-1 misread as QID" leaves the drug name perfectly
 * correct and quadruples the dose — the failure the whole feature is written against. So
 * a frequency proposal has to survive every check below, and where it does not survive
 * one, the screen falls back to precisely today's behaviour: an empty field she fills in
 * herself. THAT IS THE PROPERTY THAT MAKES THIS SAFE TO SHIP — a refusal costs one typed
 * digit, which is what the app costs her today, so this module can improve on the status
 * quo and can never be worse than it.
 *
 * FOOD RELATION IS A DISPLACEMENT, and today it is not reviewed at all. The model's
 * `food_relation` is already written into a confirmed `dose_schedule` row by the review
 * screen, and from there it speaks in the alarm body ("on an empty stomach"), on the OPD
 * one-pager and in the CSV — having never appeared on screen. The comparison for the food
 * half is therefore not against a careful review, it is against no review, so a gate as
 * strict as the frequency's would keep the silent write and show her nothing. It is gated
 * on its own evidence and its own confidence, and NOT on the line-level
 * `needs_human_check` flag, which is true whenever any part of the line was unclear —
 * usually the drug name. An "a/f" is often the clearest mark on a messy line.
 *
 * WHAT BOTH HALVES DO SHARE is that the evidence is READ and not merely counted. The
 * frequency refuses when two transcriptions of one line decode differently
 * (`sources_disagree`); the food relation refuses when the quoted words decode to a
 * DIFFERENT relation than the enum (`evidence_disagrees`). "empty stomach" printed above a
 * selected chip reading "After food" is worse than showing nothing at all, because a
 * quotation sitting above an answer is read as the paper agreeing with the app.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO CLOCK TIMES, EVER — AND THE CONDITION THAT KEEPS THAT TRUE
 *
 * A proposal names SLOTS (`after_breakfast`), never times. The mapping from "1-0-1" to
 * those names is `decodeFrequency`, a pure local function with no model in it; the clock
 * time behind each name is the user's own, set in the setup wizard, and lives in
 * `features/slots/registry.ts`.
 *
 * That distinction is real but CONDITIONAL. On this app's own terms a slot IS a clock
 * time: the review screen writes `slot.time` into `dose_schedule.time_local`, the table is
 * append-only, and moving the slot in Settings afterwards does not move a medicine already
 * confirmed against it. The claim "the app never picks clock times" survives only while
 * the confirmation sits on the far side of a preview that prints the LITERAL TIMES —
 * "8:30 am and 8:30 pm" — rather than the slot names. If that preview is ever reduced to
 * "after breakfast and after dinner" because the names read more nicely, the claim becomes
 * false and this module is proposing clock times. Somebody will propose that change; this
 * paragraph is the answer to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO
 *
 * No English, no Hindi, no sentences. Refusal reasons are stable codes; the copy for each
 * one belongs in the screen's `LocalStrings` map in both languages. `FREQUENCY_REFUSALS`
 * and `FOOD_REFUSALS` are exported as arrays so a screen can key a `Record<>` off them and
 * have `tsc` fail the build when a new code arrives without a sentence.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BuiltinSlotKey } from '../slots/registry';
// Type-only, and it must stay that way: `confirm.ts` imports the database layer at the top
// level, and a value import here would make this module — and its tests — unloadable under
// `node --test --experimental-strip-types`. The type itself is the point, see
// `ProposedFoodRelation`.
import type { ReviewedSlot } from './confirm';
import {
  MAX_AI_DOSES_PER_DAY,
  decodeFrequency,
  type DecodedFrequency,
  type DecodedSlot,
} from './frequency';
import type { ConfidenceLevel, ParsedMedicine } from './schema';

// ── Refusal vocabulary ───────────────────────────────────────────────────────

/**
 * Every reason a frequency proposal is withheld. Each one deserves a DIFFERENT sentence
 * on screen: "the paper does not say which" and "this medicine is only taken when needed"
 * are both "no number", and telling her the wrong one of the two wastes her afternoon.
 */
export const FREQUENCY_REFUSALS = [
  /** No frequency was transcribed at all — no code, no notation, no words. */
  'not_written',
  /** Something was written and the decoder could not read it. */
  'not_readable',
  /** "1-1" — morning and night, or morning and afternoon. The paper does not decide it. */
  'ambiguous_two_part',
  /** SOS / PRN. A positive reading, and it means no reminders at all rather than none read. */
  'as_needed',
  /** STAT. One dose, already taken in the clinic. Not a recurring schedule. */
  'one_off',
  /** A stepped-down course: several schedules in a row, never flattened into one. */
  'tapering',
  /** Q6H and friends. Real times from a person; 00:00/06:00/12:00/18:00 are not meals. */
  'hourly',
  /** Two transcriptions of the same line decode to different instructions. */
  'sources_disagree',
  /** The model's own `doses_per_day` disagrees with what its own notation decodes to. */
  'model_count_disagrees',
  /** "Weekly" with no weekday named. Proposing one would silently pick today. */
  'weekday_unspecified',
  /** Above `MAX_AI_DOSES_PER_DAY`. Hand entry is where this belongs. */
  'exceeds_ai_dose_cap',
  /** The model set `needs_human_check` — it had to choose between two readings. */
  'flagged_by_reader',
  /** The model rated its own frequency reading low, or could not rate it. */
  'low_confidence',
  /** It decoded cleanly and there are no words to show beside the number. */
  'no_evidence',
] as const;

export type FrequencyRefusal = (typeof FREQUENCY_REFUSALS)[number];

/** Every reason a food-relation proposal is withheld. See the header on the asymmetry. */
export const FOOD_REFUSALS = [
  /** The paper said nothing about food. NOT the same as "food does not matter". */
  'not_written',
  /** A relation came back with no words behind it — an enum produced out of nothing. */
  'no_evidence',
  /** The model rated its own reading of the food mark low, or could not rate it. */
  'low_confidence',
  /**
   * The quoted words say one thing and the enum beside them says another.
   *
   * "empty stomach" under a chip reading "After food" is worse than no evidence at all,
   * because it LOOKS like corroboration: the line above the chips is read as the paper
   * agreeing with the app. The frequency half of this module has refused on exactly this
   * shape since it was written (`sources_disagree`); this is the same check on the field
   * whose stake `slots/registry.ts` names — an anti-TB drug is dosed on an empty stomach
   * and moving it to after food is the wrong direction.
   */
  'evidence_disagrees',
] as const;

export type FoodRefusal = (typeof FOOD_REFUSALS)[number];

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * Which transcribed field the words on screen came from.
 *
 * `pattern_code` is deliberately NOT a member. It is the app's vocabulary, not the
 * doctor's: a paper reading "1-0-1" can arrive with `pattern_code: "BD"`, and printing
 * "BD" beside the number would ask her to check the app against the app.
 */
export type EvidenceField = 'verbatim' | 'slot_notation';

export type FrequencyEvidence = {
  /** The paper's own words. Null when the model transcribed none. */
  readonly text: string | null;
  readonly field: EvidenceField | null;
  /**
   * The model's rating of its own frequency reading.
   *
   * USED IN ONE DIRECTION ONLY. Low or unknown removes a proposal; high never earns one.
   * It is an uncalibrated self-report on handwriting, and treating "high" as permission
   * would make the model the judge of whether the model may be trusted.
   */
  readonly confidence: ConfidenceLevel;
};

/** The same, once a proposal exists — where the words are guaranteed present. */
export type ProvenFrequencyEvidence = {
  readonly text: string;
  readonly field: EvidenceField;
  readonly confidence: ConfidenceLevel;
};

export type FoodEvidence = {
  /** The mark on the paper: "a/f", "before food", "empty stomach". */
  readonly text: string | null;
  readonly confidence: ConfidenceLevel;
};

export type ProvenFoodEvidence = {
  readonly text: string;
  readonly confidence: ConfidenceLevel;
};

// ── Proposals ────────────────────────────────────────────────────────────────

export type FrequencyProposal =
  | {
      readonly kind: 'proposal';
      /** 1 … `MAX_AI_DOSES_PER_DAY`. Never a value to seed a text field with. */
      readonly dosesPerDay: number;
      /** WHICH named slots, in clock order. The times behind them are hers. */
      readonly slotKeys: readonly BuiltinSlotKey[];
      /** The same slots with their units and the token they came from ('1', '1/2'). */
      readonly slots: readonly DecodedSlot[];
      /**
       * 1 every day, 2 alternate days, 7 weekly.
       *
       * THE SCREEN MUST CARRY THIS INTO `ReviewedSchedule.intervalDays`. Dropping it turns
       * an alternate-day medicine into a daily one, silently, with the proposal on screen
       * saying nothing is wrong.
       */
      readonly intervalDays: number;
      /** 'BD', '1-0-1'. The app's vocabulary — for a diff line, never for the evidence. */
      readonly normalisedCode: string;
      readonly evidence: ProvenFrequencyEvidence;
    }
  | {
      readonly kind: 'none';
      readonly reason: FrequencyRefusal;
      /** Still carried: the words may exist even where the number does not. */
      readonly evidence: FrequencyEvidence;
    };

/**
 * Exactly what `confirmExtraction` will accept, DERIVED FROM IT rather than retyped.
 *
 * If somebody adds a sixth food relation to the schema's vocabulary and not to the
 * writer's, `proposeFoodRelation` stops compiling instead of proposing a value that the
 * `food_relation` CHECK constraint would reject at the end of the confirmation, taking
 * every other medicine in the transaction with it.
 */
export type ProposedFoodRelation = NonNullable<ReviewedSlot['foodRelation']>;

export type FoodProposal =
  | {
      readonly kind: 'proposal';
      readonly relation: ProposedFoodRelation;
      readonly evidence: ProvenFoodEvidence;
    }
  | {
      /**
       * There are words, they do not contradict the enum, and this module could not read
       * them either way — "khaya jane ke baad", a mark in a script the table below has
       * never seen, a phrase nobody has written down here yet.
       *
       * IT IS SHOWN AND NOT SELECTED, which is the whole distinction. Showing the quote
       * puts the paper's own mark in front of her, which is still strictly better than
       * today's silent write; PRE-SELECTING a relation nothing corroborated would let an
       * invented enum reach a confirmed row by doing nothing, which is the shape this
       * whole feature exists to refuse.
       */
      readonly kind: 'unverified';
      readonly relation: ProposedFoodRelation;
      readonly evidence: ProvenFoodEvidence;
    }
  | { readonly kind: 'none'; readonly reason: FoodRefusal; readonly evidence: FoodEvidence };

export type MedicineProposal = {
  readonly frequency: FrequencyProposal;
  readonly food: FoodProposal;
};

// ── Entry point ──────────────────────────────────────────────────────────────

/** Both proposals for one transcribed line. Pure: no database, no network, no model. */
export function proposeForMedicine(medicine: ParsedMedicine): MedicineProposal {
  return { frequency: proposeFrequency(medicine), food: proposeFoodRelation(medicine) };
}

/**
 * The number, the slots and the words behind them — or the reason there are none.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE DESIGN. Facts about the paper come first (what
 * was written, what the decoder could make of it), then disagreements between two
 * readings of it, then the model's opinion of itself, then the evidence requirement. A
 * user is better served by "the paper says this is only when needed" than by "the reader
 * was unsure", and the first is true of the paper while the second is only true of the
 * model.
 */
export function proposeFrequency(medicine: ParsedMedicine): FrequencyProposal {
  const evidence = frequencyEvidenceOf(medicine);
  const refuse = (reason: FrequencyRefusal): FrequencyProposal => ({
    kind: 'none',
    reason,
    evidence,
  });

  const readings = readingsOf(medicine);
  if (readings.length === 0) return refuse('not_written');

  // 1. Positive readings that are not a daily count. These are ANSWERS, not failures, and
  //    they must not be reported as "could not read" — a PRN painkiller generates no
  //    occurrences at all, and STAT was swallowed in the clinic.
  const blocking = firstBlocking(readings);
  if (blocking) return refuse(blocking);

  // 2. Anything the decoder could not read. Note this covers EVERY transcription, not just
  //    the one `frequencyExpression` would have picked: if `pattern_code` says "OD" while
  //    the words on the paper are ones this decoder has never heard of, the "OD" was
  //    normalised out of something nothing here can corroborate. That is the misnormalised
  //    class, and it is the one a reviewer cannot catch by looking at the drug name.
  if (readings.some((reading) => !isCountable(reading.decoded))) return refuse('not_readable');

  // Safe: `readings` is non-empty and every entry is countable. The guards are for
  // `noUncheckedIndexedAccess`, and they refuse rather than assert.
  const primary = readings[0];
  if (!primary) return refuse('not_readable');
  const decoded = primary.decoded;
  const dosesPerDay = decoded.dosesPerDay;
  if (dosesPerDay === null || decoded.slots.length === 0) return refuse('not_readable');

  // 3. Every transcription of this one line must decode to the same instruction. This is
  //    the cheapest detector of a correct transcription that was then normalised wrong —
  //    "1-0-1" in `slot_notation` and "QID" in `pattern_code` — and it is the same trick
  //    `total_medicines_counted` plays against `medicines.length`.
  //
  //    WHICH READING IS "PRIMARY" THEREFORE CANNOT MATTER: a proposal only exists when they
  //    all agree, so any of them would produce the same slots. The order below is kept in
  //    step with `frequencyExpression` anyway, so the preview and the proposal are computed
  //    from the same string on the refusal paths too.
  if (readings.some((reading) => !agrees(reading.decoded, decoded))) {
    return refuse('sources_disagree');
  }

  // 4. Things the decoder recognised and still will not schedule from a photograph.
  if (decoded.notes.includes('weekday_unspecified')) return refuse('weekday_unspecified');
  if (dosesPerDay > MAX_AI_DOSES_PER_DAY) return refuse('exceeds_ai_dose_cap');

  // 5. The model's own count, which is a fourth independent answer and is currently read
  //    by nothing. It is not used to DERIVE anything — "3 times a day" says nothing about
  //    which three times — only to disagree.
  const modelCount = medicine.frequency.dosesPerDay;
  if (modelCount !== null && modelCount !== dosesPerDay) return refuse('model_count_disagrees');

  // 6. The model's opinion of itself, in the removing direction only.
  if (medicine.needsHumanCheck) return refuse('flagged_by_reader');
  if (isLowConfidence(evidence.confidence)) return refuse('low_confidence');

  // 7. No words, no proposal. A number with no provenance is the thing this app refuses to
  //    show: she cannot check "2" against a piece of paper, she can only accept it.
  const { text, field } = evidence;
  if (text === null || field === null) return refuse('no_evidence');

  return {
    kind: 'proposal',
    dosesPerDay,
    slotKeys: decoded.slots.map((slot) => slot.slotKey),
    slots: decoded.slots,
    intervalDays: decoded.intervalDays,
    normalisedCode: decoded.normalisedCode,
    evidence: { text, field, confidence: evidence.confidence },
  };
}

/**
 * Before / after / with food / empty stomach — proposed, with the mark it came from.
 *
 * Deliberately NOT gated on `needsHumanCheck`; see the header. The stake is named in
 * `slots/registry.ts`: moving a dose from before food to after it is "the wrong direction
 * for a TB drug, which is dosed on an empty stomach". Today that value reaches a confirmed
 * schedule row with nobody having seen it, so showing it — selected, with its evidence, and
 * changeable — is strictly safer than the status quo in the direction this screen is built.
 *
 * THE EVIDENCE IS READ, NOT MERELY COUNTED, and that is the correction this function most
 * needed. Requiring the words to EXIST catches an enum invented out of nothing; it does
 * nothing at all about an enum that contradicts the words quoted beside it, and the screen
 * prints those words directly above the selected chip. `food_relation: "after"` carrying
 * `food_relation_verbatim: "empty stomach"` used to render as "After food" under a line
 * quoting the paper saying the opposite — a display that reads as corroboration and is the
 * exact inversion `slots/registry.ts` warns about. `decodeFoodMark` is the cheapest
 * possible version of the check the frequency half has always had, and its three answers
 * are three different outcomes: AGREES → propose, DISAGREES → refuse and select nothing,
 * CANNOT TELL → show the words, select nothing.
 */
export function proposeFoodRelation(medicine: ParsedMedicine): FoodProposal {
  const evidence: FoodEvidence = {
    text: medicine.foodRelationVerbatim,
    confidence: medicine.confidence.food,
  };
  const refuse = (reason: FoodRefusal): FoodProposal => ({ kind: 'none', reason, evidence });

  const relation = medicine.foodRelation;
  // "Nothing was written" and "food does not matter" are different instructions and the
  // schema keeps them apart: 'unknown' is silence, 'any' is a paper that says so.
  if (relation === 'unknown') return refuse('not_written');
  const { text } = evidence;
  if (text === null) return refuse('no_evidence');
  if (isLowConfidence(evidence.confidence)) return refuse('low_confidence');

  // Compiles only while the schema's vocabulary and the writer's are the same set — that
  // is the whole job of `ProposedFoodRelation`.
  const proposed: ProposedFoodRelation = relation;
  const proven: ProvenFoodEvidence = { text, confidence: evidence.confidence };

  const read = decodeFoodMark(text);
  if (read !== null && read !== proposed) return refuse('evidence_disagrees');
  if (read === null) return { kind: 'unverified', relation: proposed, evidence: proven };
  return { kind: 'proposal', relation: proposed, evidence: proven };
}

/**
 * The mark on the paper → the relation it states, or null when this table cannot tell.
 *
 * NULL IS A FIRST-CLASS ANSWER and it must stay cheap to reach. This decoder exists to
 * catch a CONTRADICTION, not to widen what may be pre-selected: everything it does not
 * recognise comes back null and the screen shows the words with nothing chosen, which is
 * the same place an unrecognised mark ended up before it existed. Adding a pattern here
 * therefore only ever converts "shown, not chosen" into "shown and chosen", so a pattern
 * that is not certain of its meaning does not belong in it.
 *
 * WHAT IS DELIBERATELY ABSENT: a bare "b/f". Half of Indian prescribing writes it for
 * "before food" and half for "breakfast", so "1 tab after b/f" and "1 tab b/f" mean
 * opposite things and no table can hold both. It stays unreadable here, which costs one
 * tap on the chips and cannot invert a dose.
 */
export function decodeFoodMark(raw: string): ProposedFoodRelation | null {
  const text = normaliseMark(raw);
  if (text.length === 0) return null;
  for (const { relation, pattern } of FOOD_MARKS) {
    if (pattern.test(text)) return relation;
  }
  return null;
}

/**
 * Everything that varies between prescribers and means the same thing, flattened.
 *
 * The one non-obvious rule is the first: a single letter, a separator and a single letter
 * is ONE token, so "a/f", "a.f." and "a-f" all become "af" and can be matched with a word
 * boundary. Multi-letter words either side of a slash are left alone, or "with/without
 * food" would be welded into a word no pattern could see.
 */
function normaliseMark(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])\s*[./\-]\s*([a-z])(?![a-z])/g, '$1$2$3')
    .replace(/[.,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ordered most specific first. "empty stomach" leads because it is the one whose inversion
 * the app was built around, and the phrases lead the abbreviations because "after b/f" must
 * never be read by the token half of the table.
 *
 * Devanagari is matched without `\b`: JavaScript's word boundary is defined over ASCII
 * `\w`, so a boundary either side of खाली matches nothing at all.
 */
const FOOD_MARKS: readonly { relation: ProposedFoodRelation; pattern: RegExp }[] = [
  {
    relation: 'empty',
    pattern: /\b(empty\s*stomach|on\s*an?\s*empty\s*stomach|nil\s*per\s*os|npo|nil\s*by\s*mouth|nbm|khali\s*pet|khaali\s*pet)\b|खाली\s*पेट/,
  },
  {
    relation: 'any',
    pattern: /\b(with\s*or\s*without\s*food|any\s*time|anytime|irrespective\s*of\s*(food|meals?)|food\s*(does\s*not|doesnt|does'?nt)\s*matter)\b/,
  },
  {
    relation: 'before',
    pattern: /\b(before\s*(food|meals?|eating|bf|breakfast|lunch|dinner)|ante\s*cibum|khane\s*se\s*pehle|bhojan\s*se\s*pehle)\b|खाने\s*से\s*पहले/,
  },
  {
    relation: 'after',
    pattern: /\b(after\s*(food|meals?|eating|bf|breakfast|lunch|dinner)|post\s*cibum|khane\s*ke\s*baad|bhojan\s*ke\s*baad)\b|खाने\s*के\s*बाद/,
  },
  {
    relation: 'with',
    pattern: /\b(with\s*(food|meals?|a\s*meal)|during\s*(the\s*)?meals?|along\s*with\s*food|khane\s*ke\s*saath)\b|खाने\s*के\s*साथ/,
  },
  // The Latin abbreviations, last: they are single tokens and a phrase above says more.
  { relation: 'after', pattern: /\b(af|pc)\b/ },
  { relation: 'before', pattern: /\bac\b/ },
];

/**
 * "The model was not sure, or could not say."
 *
 * `unknown` counts as low, never as fine: a field the model declined to rate is exactly as
 * strong a reason to look at the paper as one it rated badly, and treating the two
 * differently silently drops half the warnings. Exported because the review screen needs
 * the identical predicate for its own flags, and two copies of it are how they drift.
 */
export function isLowConfidence(level: ConfidenceLevel): boolean {
  return level === 'low' || level === 'unknown';
}

// ── Internals ────────────────────────────────────────────────────────────────

type ReadingField = 'pattern_code' | 'slot_notation' | 'verbatim';

type Reading = {
  readonly field: ReadingField;
  readonly text: string;
  readonly decoded: DecodedFrequency;
};

/**
 * Every transcription of this line that the model actually filled in, decoded separately.
 *
 * The order matches `frequencyExpression` in `schema.ts` — normalised code, then slot
 * notation, then the words — so that the string this module treats as primary is the same
 * string the review screen's `planSlots` decodes.
 */
function readingsOf(medicine: ParsedMedicine): Reading[] {
  const readings: Reading[] = [];
  const add = (field: ReadingField, text: string | null): void => {
    if (text === null) return;
    readings.push({ field, text, decoded: decodeFrequency(text) });
  };
  add('pattern_code', medicine.frequency.patternCode);
  add('slot_notation', medicine.frequency.slotNotation);
  add('verbatim', medicine.frequency.verbatim);
  return readings;
}

/**
 * The words to print beside the number.
 *
 * `verbatim` first because it is the paper's own characters; `slot_notation` second
 * because it is at least transcribed rather than translated. `pattern_code` is never used
 * here — see `EvidenceField`.
 */
function frequencyEvidenceOf(medicine: ParsedMedicine): FrequencyEvidence {
  const confidence = medicine.confidence.frequency;
  const { verbatim, slotNotation } = medicine.frequency;
  if (verbatim !== null) return { text: verbatim, field: 'verbatim', confidence };
  if (slotNotation !== null) return { text: slotNotation, field: 'slot_notation', confidence };
  return { text: null, field: null, confidence };
}

/**
 * A reading that says something definite OTHER than "n times a day".
 *
 * Ordered most specific first, and a taper leads because it is the one that must never be
 * flattened: "40 mg x 3 days then 20 mg x 3 days" is several schedules in a row, and any
 * single number proposed for it is wrong for at least half the course.
 */
function firstBlocking(readings: readonly Reading[]): FrequencyRefusal | null {
  const any = (test: (decoded: DecodedFrequency) => boolean): boolean =>
    readings.some((reading) => test(reading.decoded));

  if (any((decoded) => decoded.notes.includes('tapering'))) return 'tapering';
  if (any((decoded) => decoded.kind === 'prn')) return 'as_needed';
  if (any((decoded) => decoded.kind === 'one_off')) return 'one_off';
  if (any((decoded) => decoded.kind === 'hourly')) return 'hourly';
  if (any((decoded) => decoded.notes.includes('ambiguous_two_part'))) return 'ambiguous_two_part';
  return null;
}

/** A decode this app is allowed to turn into a daily rhythm. */
function isCountable(decoded: DecodedFrequency): boolean {
  return (
    decoded.recognised &&
    (decoded.kind === 'daily' || decoded.kind === 'interval') &&
    decoded.dosesPerDay !== null &&
    decoded.slots.length > 0
  );
}

/**
 * Two readings of one line saying the same thing.
 *
 * SLOT KEYS, NOT JUST THE COUNT. "1-1-0" and "BD" are both twice a day and they are not
 * the same instruction — one is breakfast and lunch, the other breakfast and dinner. A
 * count-only check would pass that and move an evening dose to lunchtime, which is the
 * exact failure the two-part refusal exists to prevent.
 *
 * UNITS ARE EXCLUDED ON PURPOSE. `BD` decodes with units of 1 by construction (the
 * abbreviation table has no quantity in it) while "1/2-0-1/2" decodes with 0.5, and those
 * are the same instruction written two ways. Comparing units would manufacture a
 * disagreement out of the decoder's own representation. How much is taken at one time is
 * confirmed in its own field, against `dose_quantity.verbatim`.
 */
function agrees(candidate: DecodedFrequency, primary: DecodedFrequency): boolean {
  if (candidate.dosesPerDay !== primary.dosesPerDay) return false;
  if (candidate.intervalDays !== primary.intervalDays) return false;
  if (candidate.slots.length !== primary.slots.length) return false;
  return candidate.slots.every((slot, index) => slot.slotKey === primary.slots[index]?.slotKey);
}
