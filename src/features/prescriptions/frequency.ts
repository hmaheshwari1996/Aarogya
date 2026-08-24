/**
 * Indian dosing shorthand → structured slots. PURE, and unit-tested.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS THE MOST TESTED THING IN THE FEATURE
 *
 * "1-0-1 misread as QID" leaves the drug name perfectly correct and quadruples the dose.
 * The name is what a reviewer checks; the frequency is what a reviewer skims. So the
 * decoding of frequency is the single highest-consequence transformation in the app, and
 * it lives here — pure, with no network, no database and no model — so that it can be
 * exhaustively tested against every notation an Indian OPD actually writes.
 *
 * THE DECODER NEVER GUESSES. Everything it does not recognise comes back with
 * `recognised: false`, `dosesPerDay: null` and `needsHumanCheck: true`, which routes the
 * medicine to manual entry. A wrong-but-plausible frequency is worse than no frequency:
 * no frequency stops and asks, a wrong one rings four times a day.
 *
 * IT ALSO NEVER RETURNS CLOCK TIMES AS FACT, and it no longer owns any. The paper says
 * "1-0-1", never "08:00". This module names SLOTS; the clock times behind those names are
 * the user's, live in `src/features/slots/registry.ts`, and are edited by her in the setup
 * wizard before anything is confirmed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE REGISTRY IS IMPORTED AS A TYPE ONLY
 *
 * `npm test` is `node --test --experimental-strip-types`, whose loader does no extension
 * resolution: a value import of `'../slots/registry'` would make this module unloadable in
 * the runner and take the most-tested file in the app out of CI. An `import type` is erased
 * outright, so the vocabulary is shared with the registry while the runtime stays free of
 * it — which is the whole point, since this decoder needs the NAMES and never the times.
 *
 * This file used to declare its own `SlotKey` and its own `DEFAULT_SLOT_TIMES`, re-exported
 * from `./index` under the same names the UI used for different values. Nothing read them,
 * and that is exactly how a rival vocabulary survives: unused, exported, and one import
 * away from deciding when a tablet rings.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BuiltinSlotKey } from '../slots/registry';

/**
 * The hard ceiling on anything the AI path may schedule by itself.
 *
 * Four is the highest frequency that Indian shorthand expresses unambiguously (QID,
 * 1-1-1-1). Above that the notation is always hourly (Q4H, Q3H) or a taper, both of
 * which need real times from a human. Capping here means the worst case of a
 * misdecoded frequency is four reminders, not twelve.
 *
 * NINE SLOTS DO NOT RAISE THIS. The cap is about how much this app may infer from a
 * photograph, not about how many named times exist — the extra slots let the decoder say
 * WHICH four, not how many. A prescription that genuinely needs five or more doses still
 * goes to a person, who types the times herself.
 */
export const MAX_AI_DOSES_PER_DAY = 4;

export type DecodedSlot = {
  readonly slotKey: BuiltinSlotKey;
  /** Units taken at this slot: 1, 2, 0.5. Multiplies the medicine's own dose quantity. */
  readonly units: number;
  /** The token exactly as written ('1', '1/2', '½'), kept for the review screen. */
  readonly text: string;
};

export type FrequencyKind =
  /** A repeating pattern within one day. */
  | 'daily'
  /** Every N days (alternate-day, weekly). */
  | 'interval'
  /** Every N hours — needs real times from a human. */
  | 'hourly'
  /** As needed. No reminders, ever. */
  | 'prn'
  /** STAT: one dose, now. Not a schedule. */
  | 'one_off'
  | 'unknown';

export type FrequencyNote =
  | 'unrecognised'
  /** A two-part pattern ("1-1"). Refused like anything unreadable — but by name. */
  | 'ambiguous_two_part'
  | 'exceeds_ai_dose_cap'
  | 'as_needed'
  | 'one_off'
  | 'hourly_interval'
  | 'weekday_unspecified'
  | 'fractional_dose'
  | 'tapering';

export type DecodedFrequency = {
  /** What was fed in, untouched. */
  readonly input: string;
  /** Canonical code: 'OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT', '1-0-1', 'Q8H', ''. */
  readonly normalisedCode: string;
  readonly kind: FrequencyKind;
  readonly slots: readonly DecodedSlot[];
  /** '1-0-1' style rendering of the slots, or null when the pattern has no such form. */
  readonly slotNotation: string | null;
  /** Administrations per day. Null whenever there is no honest daily rhythm. */
  readonly dosesPerDay: number | null;
  /** Units (tablets, ml) per day — what the refill arithmetic divides by. */
  readonly unitsPerDay: number | null;
  /** 1 = every day, 2 = alternate days, 7 = weekly. */
  readonly intervalDays: number;
  /** Only meaningful for `kind: 'hourly'`. */
  readonly everyHours: number | null;
  /** 7-bit field, bit 0 = Monday. Always every day unless a weekday was actually named. */
  readonly daysMask: number;
  readonly scheduleType: 'FIXED' | 'PRN';
  readonly recognised: boolean;
  /** True whenever a human must supply or check something before this can be scheduled. */
  readonly needsHumanCheck: boolean;
  readonly notes: readonly FrequencyNote[];
};

export const ALL_DAYS_MASK = 127;

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Decode one frequency expression.
 *
 * Accepts the `pattern_code` the model returns, but is written to survive being handed
 * the raw `slot_notation` or a free-text phrase instead — the model is instructed to
 * normalise, and this must not fall over when it does not.
 */
export function decodeFrequency(raw: string | null | undefined): DecodedFrequency {
  const input = raw ?? '';
  const text = normalise(input);
  if (text.length === 0) return unknownFrequency(input);

  const intervalDays = detectIntervalDays(text);
  const notes: FrequencyNote[] = [];
  if (intervalDays === 7) notes.push('weekday_unspecified');

  // ── As needed ───────────────────────────────────────────────────────────
  // Checked first: "1 tab SOS" must never become a daily reminder because the '1'
  // matched something else. A PRN medicine generates no occurrences at all.
  if (/\b(sos|prn|as\s+needed|if\s+needed|when\s+needed|as\s+required|if\s+required|when\s+required)\b/.test(text)) {
    return {
      input,
      normalisedCode: 'SOS',
      kind: 'prn',
      slots: [],
      slotNotation: null,
      dosesPerDay: null,
      unitsPerDay: null,
      intervalDays: 1,
      everyHours: null,
      daysMask: ALL_DAYS_MASK,
      scheduleType: 'PRN',
      recognised: true,
      needsHumanCheck: false,
      notes: ['as_needed'],
    };
  }

  // ── One dose, now ───────────────────────────────────────────────────────
  if (/\bstat\b/.test(text)) {
    return {
      input,
      normalisedCode: 'STAT',
      kind: 'one_off',
      slots: [],
      slotNotation: null,
      dosesPerDay: null,
      unitsPerDay: null,
      intervalDays: 1,
      everyHours: null,
      daysMask: ALL_DAYS_MASK,
      scheduleType: 'FIXED',
      recognised: true,
      // A single immediate dose is not a recurring schedule, and modelling it as one
      // would keep reminding her every day for a tablet she swallowed in the clinic.
      needsHumanCheck: true,
      notes: ['one_off'],
    };
  }

  // ── Tapering ────────────────────────────────────────────────────────────
  // "40 mg x 3 days, then 20 mg x 3 days" is several schedules in a row. Recognising
  // that it IS a taper — and refusing to flatten it into one — is the whole job here.
  if (/\btaper|tapering|then\s+reduce|reducing\s+dose\b/.test(text)) {
    return {
      ...unknownFrequency(input),
      normalisedCode: 'TAPER',
      notes: ['tapering'],
    };
  }

  // ── Every N hours ───────────────────────────────────────────────────────
  const hourly = /\bq\s*(\d{1,2})\s*(?:h|hr|hrs|hourly)\b/.exec(text);
  if (hourly) {
    const hours = Number(hourly[1]);
    const dosesPerDay = hours > 0 && 24 % hours === 0 ? 24 / hours : null;
    return {
      input,
      normalisedCode: `Q${hours}H`,
      kind: 'hourly',
      // No named slots on purpose: Q6H means 00:00/06:00/12:00/18:00, and pushing it
      // into morning/afternoon/evening/night would move the doses by hours.
      slots: [],
      slotNotation: null,
      dosesPerDay,
      unitsPerDay: null,
      intervalDays: 1,
      everyHours: hours,
      daysMask: ALL_DAYS_MASK,
      scheduleType: 'FIXED',
      recognised: dosesPerDay !== null,
      // Always. An hourly regimen has no default times this app is entitled to invent.
      needsHumanCheck: true,
      notes:
        dosesPerDay !== null && dosesPerDay > MAX_AI_DOSES_PER_DAY
          ? ['hourly_interval', 'exceeds_ai_dose_cap']
          : ['hourly_interval'],
    };
  }

  // ── Slot notation: 1-0-1, 1-1-1-1, 1/2-0-1/2 ────────────────────────────
  const notation = decodeSlotNotation(text);
  if (notation) {
    return finish(input, notation.code, notation.slots, intervalDays, [
      ...notes,
      ...notation.notes,
    ]);
  }

  // ── Latin and English abbreviations ─────────────────────────────────────
  const abbreviated = decodeAbbreviation(text);
  if (abbreviated) {
    return finish(input, abbreviated.code, abbreviated.slots, intervalDays, notes);
  }

  // ── An interval with no rhythm: "alternate day", "weekly" on its own ─────
  if (intervalDays > 1) {
    // Same reasoning as OD: the paper gave a rhythm and no time of day, so the one dose
    // goes where a once-a-day dose goes and the user moves it if she needs to.
    return finish(
      input,
      intervalDays === 7 ? 'WEEKLY' : 'ALT_DAY',
      [oneSlot('after_breakfast')],
      intervalDays,
      notes,
    );
  }

  // ── The two-part pattern, refused BY NAME ───────────────────────────────
  //
  // Nothing changes about the refusal: "1-1" was already unreadable to this decoder and
  // still is, with `recognised: false` and `dosesPerDay: null`. What changes is that the
  // refusal can now be EXPLAINED. "We could not read how often" and "this can mean
  // morning and night, or morning and afternoon, and the paper does not say which" are
  // the same decision and two very different sentences to somebody holding the paper —
  // and the second one tells her exactly what to look at.
  if (TWO_PART_NOTATION.test(text)) {
    return { ...unknownFrequency(input), notes: ['unrecognised', 'ambiguous_two_part'] };
  }

  return unknownFrequency(input);
}

/**
 * Deliberately NARROWER than the notation regex above, because this one only picks a
 * sentence. Tokens are a single digit or a fraction, so "x 5-10 days" and a date like
 * "12-08" are left to the generic refusal — claiming that a printed range is an ambiguous
 * dose pattern would be a worse explanation than no explanation at all. Runs only after
 * `decodeSlotNotation` has already declined, so three- and four-part patterns never reach
 * it.
 */
const TWO_PART_NOTATION = /(?:^|\s)(?:\d(?:\.\d+)?|\d\/\d+)-(?:\d(?:\.\d+)?|\d\/\d+)(?:\s|$)/;

// ── Assembly ─────────────────────────────────────────────────────────────────

function finish(
  input: string,
  code: string,
  slots: DecodedSlot[],
  intervalDays: number,
  notes: FrequencyNote[],
): DecodedFrequency {
  const dosesPerDay = slots.length;
  const unitsPerDay = slots.reduce((sum, slot) => sum + slot.units, 0);
  const allNotes = [...notes];
  if (dosesPerDay > MAX_AI_DOSES_PER_DAY) allNotes.push('exceeds_ai_dose_cap');
  if (slots.some((slot) => !Number.isInteger(slot.units))) allNotes.push('fractional_dose');

  return {
    input,
    normalisedCode: code,
    kind: intervalDays > 1 ? 'interval' : 'daily',
    slots,
    slotNotation: renderSlotNotation(slots),
    dosesPerDay,
    unitsPerDay,
    intervalDays,
    everyHours: null,
    daysMask: ALL_DAYS_MASK,
    scheduleType: 'FIXED',
    recognised: true,
    needsHumanCheck: allNotes.includes('exceeds_ai_dose_cap') || allNotes.includes('weekday_unspecified'),
    notes: allNotes,
  };
}

function unknownFrequency(input: string): DecodedFrequency {
  return {
    input,
    normalisedCode: '',
    kind: 'unknown',
    slots: [],
    slotNotation: null,
    // Null, never a fallback of 1. "We could not read how often" and "once a day" are
    // different answers, and only one of them is safe to act on.
    dosesPerDay: null,
    unitsPerDay: null,
    intervalDays: 1,
    everyHours: null,
    daysMask: ALL_DAYS_MASK,
    scheduleType: 'FIXED',
    recognised: false,
    needsHumanCheck: true,
    notes: ['unrecognised'],
  };
}

// ── Notation ─────────────────────────────────────────────────────────────────

/**
 * INDIAN DOSING SHORTHAND IS MEAL-LINKED, AND THE SLOT VOCABULARY CAN FINALLY SAY SO.
 *
 * "1-0-1" is not "morning and night" in the abstract; it is the tablet taken with the
 * morning meal and the one taken with the evening meal, which is why the same prescription
 * carries "after food" so often that the phrase is nearly punctuation. The four-slot
 * vocabulary had no way to express that, so it used the neutral `morning`/`night` and left
 * the meal relationship to the food-relation field alone.
 *
 * With `after_breakfast` and `after_dinner` available, the AFTER slots are the honest
 * default: they are what the prescriber means, and they are the times the patient will
 * actually be at a table. Where the paper genuinely says nothing about food it still says
 * a meal — a "1-1-1" with no food note is three meals, not three arbitrary hours — so the
 * same layout applies and the BEFORE slots are left for the user to choose herself on the
 * schedule screen, where she can see the clock times.
 *
 * The MIDDAY slot is deliberately never produced here. It names a time between meals, and
 * nothing in the shorthand ever asks for one.
 */
const THREE_PART_LAYOUT: readonly BuiltinSlotKey[] = [
  'after_breakfast',
  'after_lunch',
  'after_dinner',
];

/** The four-part layout differs only in gaining a between-meals evening dose. */
const FOUR_PART_LAYOUT: readonly BuiltinSlotKey[] = [
  'after_breakfast',
  'after_lunch',
  'evening',
  'after_dinner',
];

/**
 * Three parts are breakfast-lunch-dinner; four insert an evening dose before dinner.
 *
 * TWO parts are refused outright. "1-1" is written by some prescribers for morning and
 * night and by others for morning and afternoon, and there is no way to tell from the
 * paper which one is meant. Refusing sends it to manual entry; guessing moves somebody's
 * evening dose to lunchtime.
 */
function decodeSlotNotation(
  text: string,
): { code: string; slots: DecodedSlot[]; notes: FrequencyNote[] } | null {
  const match = /(?:^|\s)((?:\d+(?:\.\d+)?|\d+\/\d+)(?:\s*-\s*(?:\d+(?:\.\d+)?|\d+\/\d+)){2,3})(?:\s|$)/.exec(
    text,
  );
  const captured = match?.[1];
  if (!captured) return null;

  const tokens = captured.split('-').map((token) => token.trim());
  const layout = tokens.length === 4 ? FOUR_PART_LAYOUT : THREE_PART_LAYOUT;

  const slots: DecodedSlot[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const slotKey = layout[index];
    if (token === undefined || slotKey === undefined) return null;
    const units = parseUnits(token);
    if (units === null) return null;
    // A zero means "nothing at this time of day" — it is information, not a dose.
    if (units === 0) continue;
    slots.push({ slotKey, units, text: token });
  }
  if (slots.length === 0) return null;

  return { code: tokens.join('-'), slots, notes: [] };
}

/**
 * '1-0-1' style rendering, or null when the pattern has no such form.
 *
 * NULL IS A REAL ANSWER HERE, and the reason it has to be is `bedtime`. HS decodes to a
 * single bedtime dose, and bedtime sits in neither layout — it is not the dinner dose, it
 * is the one taken hours after it. Forcing it into the three-part layout would render
 * '0-0-0' for a medicine that is very much prescribed, and the four-slot build's '0-0-1'
 * was only ever right by the accident of `night` doubling as both. With no notation the
 * label falls back to the code ('HS'), which is what the paper actually says.
 */
function renderSlotNotation(slots: readonly DecodedSlot[]): string | null {
  if (slots.length === 0) return null;
  const layout = slots.some((slot) => slot.slotKey === 'evening')
    ? FOUR_PART_LAYOUT
    : THREE_PART_LAYOUT;
  if (slots.some((slot) => !layout.includes(slot.slotKey))) return null;
  return layout
    .map((key) => slots.find((slot) => slot.slotKey === key)?.text ?? '0')
    .join('-');
}

/** '1' → 1, '0.5' → 0.5, '1/2' → 0.5. Null for anything else. */
function parseUnits(token: string): number | null {
  const fraction = /^(\d+)\/(\d+)$/.exec(token);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
  }
  if (!/^\d+(?:\.\d+)?$/.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

// ── Abbreviations ────────────────────────────────────────────────────────────

type AbbreviationRule = {
  readonly code: string;
  readonly pattern: RegExp;
  readonly slots: readonly BuiltinSlotKey[];
};

/**
 * Order matters: the longer, more specific patterns are tested first so that "OD HS"
 * resolves to a single bedtime dose rather than to a single breakfast one.
 *
 * QID/TDS/BD reuse the meal-linked layouts above, so "1-1-1" and "TDS" — the same
 * instruction written two ways — can never land on different slots.
 *
 * HS AND THE DINNER DOSE ARE NOW DIFFERENT INSTRUCTIONS, which is the correction that
 * matters most here. The four-slot build sent both to `night` at 21:00, so "HS" — at
 * bedtime, deliberately hours after food, which for a statin or a sedative is the point of
 * writing it — rang while she was still at the table. `bedtime` says what the paper says.
 */
const ABBREVIATIONS: readonly AbbreviationRule[] = [
  {
    code: 'QID',
    pattern: /\b(qid|qds|(?:4|four)\s*times(?:\s*a)?\s*(?:day|daily))\b/,
    slots: FOUR_PART_LAYOUT,
  },
  {
    code: 'TDS',
    pattern: /\b(tds|tid|(?:3|three)\s*times(?:\s*a)?\s*(?:day|daily)|thrice(?:\s*(?:a\s*)?(?:day|daily))?)\b/,
    slots: THREE_PART_LAYOUT,
  },
  {
    code: 'BD',
    pattern: /\b(bd|bid|(?:2|two)\s*times(?:\s*a)?\s*(?:day|daily)|twice(?:\s*(?:a\s*)?(?:day|daily))?)\b/,
    // The two-meal instruction, and the same two slots '1-0-1' produces.
    slots: ['after_breakfast', 'after_dinner'],
  },
  { code: 'HS', pattern: /\b(hs|at\s*night|nocte|bed\s*time|bedtime)\b/, slots: ['bedtime'] },
  {
    code: 'OM',
    pattern: /\b(om|mane|in\s*the\s*morning|every\s*morning)\b/,
    slots: ['after_breakfast'],
  },
  {
    code: 'OD',
    // 'daily' on its own lands here — but only after BD/TDS/QID have had their turn,
    // which is why "three times daily" cannot be read as once a day.
    //
    // OD says how OFTEN and not WHEN, so the slot is a choice rather than a reading. It
    // goes to `after_breakfast` because that is where the one-a-day half of '1-0-0' lands
    // and because a single daily tablet taken with the first meal is the habit most likely
    // to survive; she moves it on the schedule screen if her doctor said otherwise.
    pattern: /\b(od|once(?:\s*a)?\s*(?:day|daily)|(?:1|one)\s*time(?:\s*a)?\s*(?:day|daily)|daily)\b/,
    slots: ['after_breakfast'],
  },
];

function decodeAbbreviation(text: string): { code: string; slots: DecodedSlot[] } | null {
  for (const rule of ABBREVIATIONS) {
    if (rule.pattern.test(text)) {
      return { code: rule.code, slots: rule.slots.map((key) => oneSlot(key)) };
    }
  }
  return null;
}

function oneSlot(slotKey: BuiltinSlotKey): DecodedSlot {
  return { slotKey, units: 1, text: '1' };
}

// ── Interval modifiers ───────────────────────────────────────────────────────

function detectIntervalDays(text: string): number {
  if (/\b(alternate\s*days?|alt\s*days?|every\s*other\s*day|eod|qod|q\.o\.d)\b/.test(text)) return 2;
  if (/\b(weekly|once\s*a\s*week|per\s*week|qwk|q\s*week|every\s*week)\b/.test(text)) return 7;
  return 1;
}

// ── Normalisation ────────────────────────────────────────────────────────────

const UNICODE_FRACTIONS: Record<string, string> = {
  '½': '1/2',
  '¼': '1/4',
  '¾': '3/4',
  '⅓': '1/3',
  '⅔': '2/3',
};

/**
 * Everything that varies between prescribers but means the same thing, flattened.
 *
 * Note what is NOT removed: nothing is dropped that could change meaning. Periods inside
 * 'b.d.' go because 'bd' and 'b.d.' are the same instruction; digits, slashes and hyphens
 * all stay because they carry the pattern itself.
 */
function normalise(raw: string): string {
  let text = raw.toLowerCase().trim();
  for (const [glyph, replacement] of Object.entries(UNICODE_FRACTIONS)) {
    text = text.split(glyph).join(replacement);
  }
  return (
    text
      // Every dash people type — hyphen, non-breaking hyphen, en, em, minus — means '-'.
      .replace(/[‐-―−]/g, '-')
      .replace(/[×✕]/g, 'x')
      // Periods inside abbreviations go ('b.d.' and 'bd' are one instruction); periods
      // between digits STAY, because 0.5 is half a tablet and 05 is not.
      .replace(/(\d?)\.(\d?)/g, (match, before: string, after: string) =>
        before && after ? match : `${before}${after}`,
      )
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ── Presentation ─────────────────────────────────────────────────────────────

/**
 * A short English label for the diff on the review screen ("1-0-1 → 1-1-1").
 *
 * TRANSCRIPTION ONLY. It restates the pattern; it never explains, justifies or advises.
 */
export function frequencyLabelEn(decoded: DecodedFrequency): string {
  if (!decoded.recognised) return 'not read';
  if (decoded.kind === 'prn') return 'only when needed';
  if (decoded.kind === 'one_off') return 'one dose';
  if (decoded.kind === 'hourly') {
    return decoded.everyHours ? `every ${decoded.everyHours} hours` : 'hourly';
  }
  const base = decoded.slotNotation ?? decoded.normalisedCode;
  if (decoded.intervalDays === 2) return `${base}, alternate days`;
  if (decoded.intervalDays === 7) return `${base}, once a week`;
  return base;
}
