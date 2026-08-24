/**
 * Tests for the proposal layer.
 *
 * WEIGHTED TOWARDS THE REFUSALS, like `frequency.test.ts` and for the same reason: a
 * withheld proposal costs one typed digit — which is exactly what the app costs her today
 * — while a proposal that is accepted by reflex and wrong rings four times a day. Every
 * case below that ends in `kind: 'none'` is a case where this module must fall back to the
 * behaviour that already shipped.
 *
 * The invariant that the rest of the design rests on, asserted here and worth defending in
 * review: NOTHING in this file returns a value the screen may seed a text field with. A
 * proposal is a proposition with its evidence attached, and the screen must require an act
 * to accept it. See the header of `propose.ts`.
 *
 * On the dynamic imports: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths and this project's tsconfig does not enable `allowImportingTsExtensions`,
 * so the namespace is loaded through a non-literal specifier and re-typed — the same trick
 * `frequency.test.ts` uses, plus the `registerHooks` resolver from `care/calendar.test.ts`
 * so that `propose.ts` may import `./frequency` the way every other file in the app does.
 *
 * `schema.ts` is deliberately never loaded here: it reaches `zod` and `../ai/errors`, and
 * pulling the whole parser into a test of a pure decision layer would be the wrong
 * dependency. `ParsedMedicine` is used in type position only, where it is erased — which
 * is also why `propose.ts` imports it with `import type` and must keep doing so.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** See `features/care/calendar.test.ts`: teaches Node the one thing Metro already knows. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const MODULE = './propose.ts';
const {
  FOOD_REFUSALS,
  FREQUENCY_REFUSALS,
  decodeFoodMark,
  isLowConfidence,
  proposeFoodRelation,
  proposeForMedicine,
  proposeFrequency,
} = (await import(MODULE)) as typeof import('./propose');

const FREQUENCY = './frequency.ts';
const { MAX_AI_DOSES_PER_DAY, decodeFrequency } = (await import(
  FREQUENCY
)) as typeof import('./frequency');

type Parsed = import('./schema').ParsedMedicine;
type FrequencyProposal = import('./propose').FrequencyProposal;
type FoodProposal = import('./propose').FoodProposal;

// ── Fixtures ─────────────────────────────────────────────────────────────────

type FrequencyBits = {
  patternCode?: string | null;
  slotNotation?: string | null;
  dosesPerDay?: number | null;
  intervalDays?: number | null;
  verbatim?: string | null;
};

/**
 * A line that reads perfectly, so every test below changes ONE thing and states what that
 * one thing does. The defaults are the honest happy path: a real anti-TB twice-daily
 * pattern, transcribed three ways that agree, with the words from the paper attached.
 */
function medicine(
  overrides: Partial<Omit<Parsed, 'frequency' | 'confidence'>> & {
    frequency?: FrequencyBits;
    confidence?: Partial<Parsed['confidence']>;
  } = {},
): Parsed {
  const { frequency, confidence, ...rest } = overrides;
  return {
    nameAsWritten: 'Tab. Rifampicin',
    genericGuess: 'rifampicin',
    strength: '450 mg',
    form: 'tablet',
    doseQuantity: { value: 1, unit: 'tablet', verbatim: '1 tab' },
    frequency: {
      patternCode: '1-0-1',
      slotNotation: '1-0-1',
      dosesPerDay: 2,
      intervalDays: 1,
      verbatim: '1-0-1',
      ...frequency,
    },
    foodRelation: 'empty',
    foodRelationVerbatim: 'empty stomach',
    duration: { kind: 'months', value: 6, verbatim: 'x 6 months' },
    route: 'oral',
    proposedCriticality: 'critical',
    criticalityReason: 'a fixed-duration antitubercular course',
    confidence: {
      name: 'high',
      strength: 'high',
      frequency: 'high',
      food: 'high',
      duration: 'high',
      ...confidence,
    },
    needsHumanCheck: false,
    notes: null,
    ...rest,
  };
}

function frequencyOf(overrides: FrequencyBits): FrequencyProposal {
  return proposeFrequency(medicine({ frequency: overrides }));
}

function refusal(proposal: FrequencyProposal): string {
  return proposal.kind === 'none' ? proposal.reason : `proposed ${proposal.dosesPerDay}`;
}

function foodRefusal(proposal: FoodProposal): string {
  return proposal.kind === 'none' ? proposal.reason : `proposed ${proposal.relation}`;
}

// ── The proposal that should exist ───────────────────────────────────────────

test('three agreeing readings of 1-0-1 propose twice a day, with the paper beside it', () => {
  const proposal = proposeFrequency(medicine());
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  assert.equal(proposal.dosesPerDay, 2);
  assert.deepEqual([...proposal.slotKeys], ['after_breakfast', 'after_dinner']);
  assert.equal(proposal.intervalDays, 1);
  assert.equal(proposal.normalisedCode, '1-0-1');
  // The evidence is the paper's characters, not the app's code for them.
  assert.equal(proposal.evidence.text, '1-0-1');
  assert.equal(proposal.evidence.field, 'verbatim');
  assert.equal(proposal.evidence.confidence, 'high');
});

test('the slots proposed are the decoder\'s, not a second copy of the layout', () => {
  const proposal = proposeFrequency(medicine());
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  // Every agreeing reading decodes to the same slots, which is why "which one is primary"
  // cannot change the answer — assert that against each source independently.
  for (const source of ['1-0-1', 'BD']) {
    assert.deepEqual(
      decodeFrequency(source).slots.map((slot) => slot.slotKey),
      [...proposal.slotKeys],
      source,
    );
  }
});

test('BD and 1/2-0-1/2 are the same instruction, and half a tablet is not a disagreement', () => {
  // The abbreviation table has no quantity in it, so `BD` decodes with units of 1 while the
  // notation decodes with 0.5. Comparing units would manufacture a disagreement out of the
  // decoder's own representation and refuse a perfectly readable line.
  const proposal = frequencyOf({
    patternCode: 'BD',
    slotNotation: '1/2-0-1/2',
    verbatim: '1/2-0-1/2',
    dosesPerDay: 2,
  });
  assert.equal(refusal(proposal), 'proposed 2');
});

test('an alternate-day rhythm proposes its interval rather than flattening to daily', () => {
  const proposal = frequencyOf({
    patternCode: 'OD alternate day',
    slotNotation: null,
    verbatim: '1 OD alternate day',
    dosesPerDay: 1,
  });
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  assert.equal(proposal.dosesPerDay, 1);
  assert.equal(proposal.intervalDays, 2);
});

test('slot_notation carries the evidence when the words are missing', () => {
  const proposal = frequencyOf({ verbatim: null });
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  assert.equal(proposal.evidence.field, 'slot_notation');
  assert.equal(proposal.evidence.text, '1-0-1');
});

test('the model may leave doses_per_day out without costing the proposal', () => {
  assert.equal(refusal(frequencyOf({ dosesPerDay: null })), 'proposed 2');
});

// ── The refusals. These matter more than the successes. ─────────────────────

test('nothing transcribed at all is "not written", not "not readable"', () => {
  const proposal = frequencyOf({
    patternCode: null,
    slotNotation: null,
    verbatim: null,
    dosesPerDay: null,
  });
  assert.equal(refusal(proposal), 'not_written');
  assert.equal(proposal.kind === 'none' && proposal.evidence.text, null);
});

test('the two-part pattern is refused BY NAME so the screen can explain it', () => {
  // "1-1" is morning and night to some prescribers and morning and afternoon to others.
  // The decoder has always refused it; the point of this case is that the refusal arrives
  // with a reason specific enough to print.
  const proposal = frequencyOf({ patternCode: null, slotNotation: '1-1', verbatim: '1-1' });
  assert.equal(refusal(proposal), 'ambiguous_two_part');
  // And the words survive the refusal, so the screen can still show what is on the paper.
  assert.equal(proposal.kind === 'none' && proposal.evidence.text, '1-1');
});

test('a two-part pattern anywhere in the line vetoes a confident pattern_code', () => {
  // The dangerous shape: the model normalised "1-1" into a clean "BD" and would have been
  // believed. Decoding every transcription and not just the first one is what catches it.
  assert.equal(refusal(frequencyOf({ patternCode: 'BD', slotNotation: '1-1', verbatim: '1-1' })), 'ambiguous_two_part');
});

test('a taper is refused as a taper and never flattened into one number', () => {
  const proposal = frequencyOf({
    patternCode: null,
    slotNotation: null,
    verbatim: '40 mg x 3 days then taper',
    dosesPerDay: null,
  });
  assert.equal(refusal(proposal), 'tapering');
});

test('SOS is an answer, not a failure to read', () => {
  const proposal = frequencyOf({
    patternCode: 'SOS',
    slotNotation: null,
    verbatim: '1 tab SOS',
    dosesPerDay: null,
  });
  assert.equal(refusal(proposal), 'as_needed');
});

test('STAT is one dose already taken, not a daily rhythm', () => {
  const proposal = frequencyOf({
    patternCode: 'STAT',
    slotNotation: null,
    verbatim: 'STAT',
    dosesPerDay: null,
  });
  assert.equal(refusal(proposal), 'one_off');
});

test('an hourly regimen has no meal times a photograph may supply', () => {
  for (const code of ['Q6H', 'Q8H', 'Q4H']) {
    const proposal = frequencyOf({
      patternCode: code,
      slotNotation: null,
      verbatim: code,
      dosesPerDay: null,
    });
    assert.equal(refusal(proposal), 'hourly', code);
  }
});

test('an hour count that does not divide the day is refused too', () => {
  const proposal = frequencyOf({
    patternCode: 'Q5H',
    slotNotation: null,
    verbatim: 'Q5H',
    dosesPerDay: null,
  });
  // Reported as hourly rather than unreadable: the paper DID say every five hours, and
  // telling her it could not be read would send her looking for something else.
  assert.equal(refusal(proposal), 'hourly');
});

test('text the decoder has never heard of proposes nothing', () => {
  for (const words of ['as advised', 'see chart', 'morning & evening', 'as per doctor']) {
    const proposal = frequencyOf({
      patternCode: null,
      slotNotation: null,
      verbatim: words,
      dosesPerDay: null,
    });
    assert.equal(refusal(proposal), 'not_readable', words);
  }
});

test('a clean pattern_code cannot rescue words the decoder cannot corroborate', () => {
  // THE MISNORMALISATION CLASS. "OD" is the app's vocabulary; "morning & evening" is the
  // paper's, and it is twice a day. If only the first transcription were decoded, this
  // would propose once a day against a paper that says two.
  const proposal = frequencyOf({
    patternCode: 'OD',
    slotNotation: null,
    verbatim: 'morning & evening',
    dosesPerDay: 1,
  });
  assert.equal(refusal(proposal), 'not_readable');
});

test('two readings that decode to different counts are refused, not reconciled', () => {
  const proposal = frequencyOf({
    patternCode: 'QID',
    slotNotation: '1-0-1',
    verbatim: '1-0-1',
    dosesPerDay: 4,
  });
  assert.equal(refusal(proposal), 'sources_disagree');
});

test('the same count at different times of day is still a disagreement', () => {
  // "1-1-0" and "BD" are both twice a day; one is breakfast and lunch, the other breakfast
  // and dinner. A count-only check passes this and moves an evening dose to lunchtime.
  const proposal = frequencyOf({
    patternCode: 'BD',
    slotNotation: '1-1-0',
    verbatim: '1-1-0',
    dosesPerDay: 2,
  });
  assert.equal(refusal(proposal), 'sources_disagree');
});

test('the same pattern on different intervals is a disagreement', () => {
  const proposal = frequencyOf({
    patternCode: 'OD',
    slotNotation: null,
    verbatim: 'OD alternate day',
    dosesPerDay: 1,
  });
  assert.equal(refusal(proposal), 'sources_disagree');
});

test("the model's own dose count is a fourth answer and may veto the other three", () => {
  const proposal = frequencyOf({ dosesPerDay: 4 });
  assert.equal(refusal(proposal), 'model_count_disagrees');
});

test('weekly with no weekday named proposes nothing, rather than picking today', () => {
  const proposal = frequencyOf({
    patternCode: 'weekly',
    slotNotation: null,
    verbatim: 'once a week',
    dosesPerDay: 1,
  });
  assert.equal(refusal(proposal), 'weekday_unspecified');
});

test('nothing above the four-dose cap is ever proposed', () => {
  // The cap is the writer's rule (`confirm.ts` enforces it for source 'ai'); proposing a
  // number the writer would then refuse would put a dead end on screen.
  const proposal = frequencyOf({
    patternCode: '1-1-1-1-1',
    slotNotation: '1-1-1-1-1',
    verbatim: '1-1-1-1-1',
    dosesPerDay: 5,
  });
  assert.notEqual(refusal(proposal), 'proposed 5');
});

test('the cap holds at exactly four, and four is proposable', () => {
  assert.equal(MAX_AI_DOSES_PER_DAY, 4);
  const proposal = frequencyOf({
    patternCode: '1-1-1-1',
    slotNotation: '1-1-1-1',
    verbatim: '1-1-1-1',
    dosesPerDay: 4,
  });
  assert.equal(refusal(proposal), 'proposed 4');
});

test('a line the reader itself flagged proposes nothing', () => {
  assert.equal(refusal(proposeFrequency(medicine({ needsHumanCheck: true }))), 'flagged_by_reader');
});

test('low confidence removes a proposal, and high never earns one on its own', () => {
  for (const level of ['low', 'unknown'] as const) {
    const proposal = proposeFrequency(medicine({ confidence: { frequency: level } }));
    assert.equal(refusal(proposal), 'low_confidence', level);
  }
  // The reverse direction: 'high' cannot save a reading the decoder refused. If it could,
  // the model's self-assessment would be the gate, which is the thing the design refuses.
  const unreadable = proposeFrequency(
    medicine({
      frequency: { patternCode: null, slotNotation: null, verbatim: 'as advised', dosesPerDay: null },
      confidence: { frequency: 'high' },
    }),
  );
  assert.equal(refusal(unreadable), 'not_readable');
});

test('a number with no words behind it is not shown', () => {
  // Decodes perfectly, agrees with itself, and there is nothing for her to check it
  // against. "BD" is the app's vocabulary and is not evidence of what the doctor wrote.
  const proposal = frequencyOf({
    patternCode: 'BD',
    slotNotation: null,
    verbatim: null,
    dosesPerDay: 2,
  });
  assert.equal(refusal(proposal), 'no_evidence');
});

// ── The food relation ────────────────────────────────────────────────────────

test('a written food instruction is proposed with the mark it came from', () => {
  const proposal = proposeFoodRelation(medicine());
  assert.equal(proposal.kind, 'proposal');
  if (proposal.kind !== 'proposal') return;
  assert.equal(proposal.relation, 'empty');
  assert.equal(proposal.evidence.text, 'empty stomach');
  assert.equal(proposal.evidence.confidence, 'high');
});

test('silence about food proposes nothing, and is never turned into "any"', () => {
  const proposal = proposeFoodRelation(
    medicine({ foodRelation: 'unknown', foodRelationVerbatim: null }),
  );
  assert.equal(foodRefusal(proposal), 'not_written');
});

test('a food relation with nothing quoted behind it is an invented enum', () => {
  // The cheapest guard against the failure the whole prompt is written against: "after" is
  // the most probable value for an Indian prescription whether or not the paper says a word
  // about food, and it currently reaches a confirmed schedule row unseen.
  const proposal = proposeFoodRelation(
    medicine({ foodRelation: 'after', foodRelationVerbatim: null }),
  );
  assert.equal(foodRefusal(proposal), 'no_evidence');
});

test('every extraction stored before this field existed proposes no food relation', () => {
  // `foodRelationVerbatim` parses to null on an older row, which is the honest answer: that
  // row has no recorded evidence, so it gets no proposal and she picks it herself.
  const proposal = proposeFoodRelation(
    medicine({ foodRelation: 'before', foodRelationVerbatim: null }),
  );
  assert.equal(foodRefusal(proposal), 'no_evidence');
});

test('a low-confidence food mark proposes nothing', () => {
  for (const level of ['low', 'unknown'] as const) {
    const proposal = proposeFoodRelation(medicine({ confidence: { food: level } }));
    assert.equal(foodRefusal(proposal), 'low_confidence', level);
  }
});

test('a food mark that contradicts the enum beside it is refused, not shown as agreement', () => {
  // The failure this check exists for, and the reason it is not merely cosmetic: the screen
  // prints the quoted words directly ABOVE the selected chip, so "empty stomach" under a
  // ticked "After food" reads as the paper agreeing with the app. `slots/registry.ts` names
  // the stake — an anti-TB drug is dosed on an empty stomach, and after food is the wrong
  // direction — and nothing else in the flow asks about food again.
  const proposal = proposeFoodRelation(
    medicine({ foodRelation: 'after', foodRelationVerbatim: 'empty stomach' }),
  );
  assert.equal(foodRefusal(proposal), 'evidence_disagrees');
});

test('a mark this app cannot read is shown and NOT selected', () => {
  // The third answer, and the one that must not collapse into either of the others. There
  // are words, they contradict nothing, and nothing here can vouch for the enum — so the
  // screen quotes them and leaves the chips blank. Pre-selecting would let an enum nobody
  // corroborated reach a confirmed row by doing nothing.
  const proposal = proposeFoodRelation(
    medicine({ foodRelation: 'after', foodRelationVerbatim: 'khana khane ke turant baad hi' }),
  );
  assert.equal(proposal.kind, 'unverified');
  if (proposal.kind !== 'unverified') return;
  assert.equal(proposal.relation, 'after');
  assert.equal(proposal.evidence.text, 'khana khane ke turant baad hi');
});

test('the food marks an Indian prescription actually carries, decoded', () => {
  // `a/f` and `a/c` differ by one character and mean opposite things, which is the entire
  // reason this table exists rather than a substring test.
  const cases: [string, string | null][] = [
    ['empty stomach', 'empty'],
    ['खाली पेट', 'empty'],
    ['before food', 'before'],
    ['a/c', 'before'],
    ['ante cibum', 'before'],
    ['खाने से पहले', 'before'],
    ['after food', 'after'],
    ['a/f', 'after'],
    ['p.c.', 'after'],
    ['after b/f', 'after'],
    ['with meals', 'with'],
    ['with or without food', 'any'],
    // Refused BY NAME below, and it must stay refused: half of prescribing writes b/f for
    // "before food" and half for "breakfast", so a table that decided would invert a dose
    // on every paper that meant the other one.
    ['b/f', null],
    ['as directed', null],
    ['', null],
  ];
  for (const [text, expected] of cases) {
    assert.equal(decodeFoodMark(text), expected, text);
  }
});

test('the food proposal survives a line the reader flagged, and the frequency does not', () => {
  // The asymmetry, asserted rather than merely described. `needs_human_check` is true
  // whenever ANY part of the line was unclear — usually the drug name — and an "a/f" is
  // often the clearest mark on a messy line. Frequency is a multiplier; food is not, and
  // the comparison for food is against today's silent, unreviewed write.
  const flagged = medicine({ needsHumanCheck: true });
  assert.equal(foodRefusal(proposeFoodRelation(flagged)), 'proposed empty');
  assert.equal(refusal(proposeFrequency(flagged)), 'flagged_by_reader');
});

// ── The contract itself ──────────────────────────────────────────────────────

test('both proposals come back from one call', () => {
  const proposal = proposeForMedicine(medicine());
  assert.equal(proposal.frequency.kind, 'proposal');
  assert.equal(proposal.food.kind, 'proposal');
});

test('every refusal code returned is one the screen was told about', () => {
  // The screen keys its copy off these arrays, in `en` and `hi`. A code returned from
  // outside them is a sentence that does not exist on a screen she is reading.
  const frequencyCodes = new Set<string>(FREQUENCY_REFUSALS);
  const foodCodes = new Set<string>(FOOD_REFUSALS);
  const cases: Parsed[] = [
    medicine(),
    medicine({ needsHumanCheck: true }),
    medicine({ confidence: { frequency: 'low', food: 'low' } }),
    medicine({ foodRelation: 'unknown', foodRelationVerbatim: null }),
    medicine({ foodRelation: 'with', foodRelationVerbatim: null }),
    medicine({ frequency: { patternCode: null, slotNotation: null, verbatim: null, dosesPerDay: null } }),
    medicine({ frequency: { patternCode: 'SOS', slotNotation: null, verbatim: 'SOS' } }),
    medicine({ frequency: { patternCode: 'STAT', slotNotation: null, verbatim: 'STAT' } }),
    medicine({ frequency: { patternCode: 'Q6H', slotNotation: null, verbatim: 'Q6H' } }),
    medicine({ frequency: { patternCode: null, slotNotation: '1-1', verbatim: '1-1' } }),
    medicine({ frequency: { patternCode: 'QID', slotNotation: '1-0-1', verbatim: '1-0-1' } }),
    medicine({ frequency: { patternCode: null, slotNotation: null, verbatim: 'as advised' } }),
    medicine({ frequency: { patternCode: 'weekly', slotNotation: null, verbatim: 'weekly' } }),
    medicine({ frequency: { patternCode: 'BD', slotNotation: null, verbatim: null } }),
  ];
  for (const parsed of cases) {
    const { frequency, food } = proposeForMedicine(parsed);
    if (frequency.kind === 'none') assert.ok(frequencyCodes.has(frequency.reason), frequency.reason);
    if (food.kind === 'none') assert.ok(foodCodes.has(food.reason), food.reason);
  }
});

test('a proposal never exceeds the cap and never carries an empty slot list', () => {
  // The two properties a screen is entitled to rely on without re-checking them, and the
  // two a future "small improvement" is most likely to break.
  const cases: Parsed[] = [
    medicine(),
    medicine({ frequency: { patternCode: 'TDS', slotNotation: '1-1-1', verbatim: '1-1-1', dosesPerDay: 3 } }),
    medicine({ frequency: { patternCode: 'HS', slotNotation: null, verbatim: 'HS', dosesPerDay: 1 } }),
    medicine({ frequency: { patternCode: '1-1-1-1', slotNotation: '1-1-1-1', verbatim: '1-1-1-1', dosesPerDay: 4 } }),
  ];
  for (const parsed of cases) {
    const proposal = proposeFrequency(parsed);
    assert.equal(proposal.kind, 'proposal', parsed.frequency.patternCode ?? '');
    if (proposal.kind !== 'proposal') continue;
    assert.ok(proposal.dosesPerDay >= 1 && proposal.dosesPerDay <= MAX_AI_DOSES_PER_DAY);
    assert.equal(proposal.slotKeys.length, proposal.dosesPerDay);
    assert.ok(proposal.evidence.text.length > 0);
  }
});

test('unknown confidence counts as low, never as fine', () => {
  assert.equal(isLowConfidence('low'), true);
  assert.equal(isLowConfidence('unknown'), true);
  assert.equal(isLowConfidence('medium'), false);
  assert.equal(isLowConfidence('high'), false);
});
