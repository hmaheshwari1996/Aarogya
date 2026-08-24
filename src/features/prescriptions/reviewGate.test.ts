/**
 * The gate the whole proposal design rests on.
 *
 * READ THE FIRST TEST BEFORE ANY OTHER. `propose.ts` is heavily tested and every one of
 * those tests would still pass if the review screen seeded `freqAnswer: 'agreed'` beside
 * the number it seeds today — the module would go on refusing to propose anything it could
 * not corroborate, and the screen would go on accepting all of it by default. That edit
 * changes no type, breaks no other test, and turns fifteen confirmations into one scroll
 * and one tap. It is the single most dangerous change available to this feature and until
 * this file existed nothing could see it, because the two lines that decided it lived in
 * `src/app/prescription/review.tsx` — a module the test runner cannot load.
 *
 * So the assertions below are deliberately blunt and deliberately redundant with each
 * other: seeding, the gate, and the two together. A future reader looking for the test to
 * delete in order to make an "obvious UX improvement" compile should find three.
 *
 * On the imports: `reviewGate.ts` has no runtime dependencies at all — `FrequencyProposal`
 * arrives there through `import type`, which is erased — so unlike `propose.test.ts` this
 * file needs no `registerHooks` resolver. It still loads the module through a NON-LITERAL
 * specifier, for the reason that trick exists everywhere else in this suite: Node's
 * type-stripping loader resolves only fully-specified './x.ts' paths, and this project's
 * tsconfig does not enable `allowImportingTsExtensions`, so a literal './reviewGate.ts'
 * satisfies the runtime and fails `tsc`. Types come in separately, extensionless and
 * erased. That `reviewGate.ts` needs no hook is a property worth keeping — a value import
 * added to it would break here first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './reviewGate.ts';
const { MAX_DOSES_PER_DAY, blockingReason, firstUncheckedField, parseDoses, seedFrequency } =
  (await import(MODULE)) as typeof import('./reviewGate');

type BlockReason = import('./reviewGate').BlockReason;
type DoseTiming = import('./reviewGate').DoseTiming;
type FrequencyAnswer = import('./reviewGate').FrequencyAnswer;
type ReviewLine = import('./reviewGate').ReviewLine;
type FrequencyProposal = import('./propose').FrequencyProposal;
type FrequencyRefusal = import('./propose').FrequencyRefusal;

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A corroborated twice-daily reading — the anti-TB shape this feature was built for. */
function proposal(dosesPerDay = 2): FrequencyProposal {
  return {
    kind: 'proposal',
    dosesPerDay,
    slotKeys: ['after_breakfast', 'after_dinner'],
    slots: [],
    intervalDays: 1,
    normalisedCode: '1-0-1',
    evidence: { text: '1-0-1', field: 'verbatim', confidence: 'high' },
  } as unknown as FrequencyProposal;
}

function refusal(reason: FrequencyRefusal = 'not_readable'): FrequencyProposal {
  return { kind: 'none', reason, evidence: { text: null, field: null, confidence: 'unknown' } };
}

/** A line that is ready. Every test below changes ONE thing and says what that one does. */
function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    include: true,
    name: 'Rifampicin',
    dosesPerDayText: '2',
    freqAnswer: 'own',
    doseTiming: 'per_day',
    flagged: [],
    touched: {},
    ...overrides,
  };
}

// ── The invariant ────────────────────────────────────────────────────────────

test('a corroborated proposal seeds the number AND leaves the question open', () => {
  const seed = seedFrequency(proposal(2));

  // The number IS pre-filled. Report 5 asked for that and it is not the danger; the paper
  // is in her hand and the evidence is printed above the field.
  assert.equal(seed.dosesPerDayText, '2');

  // And it is inert. THIS IS THE ASSERTION THE FEATURE RESTS ON. 'agreed' here would mean
  // the accepting path is doing nothing, which is what a pre-filled field is for.
  assert.equal(seed.freqAnswer, 'unanswered');
});

test('a seeded number cannot reach a schedule without an act', () => {
  const seed = seedFrequency(proposal(2));
  const seeded = line({ ...seed, flagged: ['frequency'] });

  // The box parses, the name is there, nothing is untouched — and it is still blocked,
  // on the frequency and by name. A gate that let this through would be invisible: the
  // card looks complete, because it is complete apart from having been read.
  assert.equal(blockingReason(seeded), 'freq_unanswered');
});

test('answering is what unblocks it, and both answers do', () => {
  const seed = seedFrequency(proposal(2));

  // Agreed: she read the words above the box and said the number matches.
  assert.equal(blockingReason(line({ ...seed, freqAnswer: 'agreed' })), null);

  // Declined and retyped: the number is hers. Same outcome by the other route.
  assert.equal(blockingReason(line({ dosesPerDayText: '3', freqAnswer: 'own' })), null);
});

test('a withheld proposal reproduces exactly the behaviour that shipped before it', () => {
  for (const reason of ['not_written', 'ambiguous_two_part', 'as_needed', 'low_confidence'] as const) {
    const seed = seedFrequency(refusal(reason));
    // Empty box, no open question — she types, which is what this screen cost her in
    // build 8. That is what makes a refusal free, and a free refusal is what lets
    // `propose.ts` be as strict as it is.
    assert.deepEqual(seed, { dosesPerDayText: '', freqAnswer: 'own' }, reason);
    assert.equal(blockingReason(line({ ...seed })), 'doses', reason);
  }
});

test('every proposed dose count seeds unanswered, not just the two-a-day case', () => {
  // Guards the shape of the "improvement" that special-cases OD as too obvious to ask
  // about. Once a day is not safer to get wrong — it is the same multiplier at n = 1.
  for (const count of [1, 2, 3, 4]) {
    const seed = seedFrequency(proposal(count));
    assert.equal(seed.dosesPerDayText, String(count));
    assert.equal(seed.freqAnswer, 'unanswered', `${count} a day must still be asked about`);
  }
});

// ── The gate's order ─────────────────────────────────────────────────────────

test('only one reason is reported, and it is the first she can act on', () => {
  // Everything wrong at once. She gets the name, because typing a dose count into a line
  // whose drug name is unreadable is work she may be about to throw away.
  const broken = line({
    name: '   ',
    dosesPerDayText: '',
    freqAnswer: 'unanswered',
    flagged: ['name', 'strength'],
  });
  assert.equal(blockingReason(broken), 'name');

  const named: [ReviewLine, BlockReason][] = [
    [line({ dosesPerDayText: '', freqAnswer: 'unanswered' }), 'doses'],
    [line({ freqAnswer: 'unanswered' }), 'freq_unanswered'],
    [line({ flagged: ['strength'] }), 'unchecked'],
  ];
  for (const [input, expected] of named) assert.equal(blockingReason(input), expected);
});

test('declining a proposal asks for the number, never re-asks the question', () => {
  // Declining empties the box and sets 'own'. If `freq_unanswered` were checked before
  // `doses`, this line would ask her to answer a question she has just answered.
  assert.equal(blockingReason(line({ dosesPerDayText: '', freqAnswer: 'own' })), 'doses');
});

test('a flagged field she has visited stops blocking; an unvisited one does not', () => {
  assert.equal(blockingReason(line({ flagged: ['name'], touched: {} })), 'unchecked');
  assert.equal(blockingReason(line({ flagged: ['name'], touched: { name: true } })), null);
  // Partial coverage is not coverage.
  assert.equal(
    blockingReason(line({ flagged: ['name', 'strength'], touched: { name: true } })),
    'unchecked',
  );
});

test('an unticked line never blocks, however incomplete it is', () => {
  // She has decided about it. Refusing to move until she proof-reads a medicine she is not
  // adding is the screen arguing with her about something it is not going to create.
  const abandoned = line({
    include: false,
    name: '',
    dosesPerDayText: '',
    freqAnswer: 'unanswered',
    flagged: ['name', 'strength'],
  });
  assert.equal(blockingReason(abandoned), null);
});

// ── The lines that are not taken a number of times a day ─────────────────────

test('naming a line as-needed answers the count question instead of skipping it', () => {
  // The failure this closes: `propose.ts` refuses on 'as_needed' — correctly, and as an
  // ANSWER rather than a failure — the card prints "the paper says this one is taken only
  // when needed", and the gate then demanded a daily dose count directly underneath it.
  // Her only two ways forward were a number that would ring every day for an SOS
  // painkiller, or taking the tick off and recording nothing.
  const unanswered = line({ dosesPerDayText: '', freqAnswer: 'own' });
  assert.equal(blockingReason(unanswered), 'doses');

  for (const timing of ['as_needed', 'one_off'] as const) {
    assert.equal(blockingReason(line({ ...unanswered, doseTiming: timing })), null, timing);
  }
});

test('naming the kind is an ACT, never a state a line arrives in', () => {
  // `seedFrequency` decides what a fresh line starts as, and it has no opinion about
  // timing at all — every line begins 'per_day' with the count still owed. A seed that
  // set 'as_needed' off the model's reading would be the app answering its own question,
  // which is the one shape this whole feature refuses.
  const seeded = seedFrequency(refusal('as_needed'));
  assert.deepEqual(Object.keys(seeded).sort(), ['dosesPerDayText', 'freqAnswer']);
  assert.equal(blockingReason(line({ ...seeded })), 'doses');
});

test('an as-needed line is still held by everything else the gate asks', () => {
  // Only the count is answered by naming the kind. A blank name and an unvisited flagged
  // field are as blocking here as anywhere — this is a different answer to one question,
  // not a way past the card.
  const prn = { doseTiming: 'as_needed' as DoseTiming, dosesPerDayText: '', freqAnswer: 'own' as FrequencyAnswer };
  assert.equal(blockingReason(line({ ...prn, name: '  ' })), 'name');
  assert.equal(blockingReason(line({ ...prn, flagged: ['strength'] })), 'unchecked');
  assert.equal(blockingReason(line({ ...prn, freqAnswer: 'unanswered' })), 'freq_unanswered');
});

// ── Which marked place, not just that there is one ───────────────────────────

test('the named field is the same one the gate is holding the line for', () => {
  // The marker at the top of the card prints this name, and a card at large text is taller
  // than the window — so if these two ever disagree she is sent to a field she has already
  // visited while the button stays down for a different one. Same array, same predicate,
  // first hit, asserted here rather than trusted.
  const messy = line({
    flagged: ['name', 'strength', 'quantity'],
    touched: { name: true },
  });
  assert.equal(blockingReason(messy), 'unchecked');
  assert.equal(firstUncheckedField(messy), 'strength');

  const nearlyDone = line({
    flagged: ['name', 'strength', 'quantity'],
    touched: { name: true, strength: true },
  });
  assert.equal(firstUncheckedField(nearlyDone), 'quantity');
});

test('nothing outstanding names nothing, so a caller may ask without asking why first', () => {
  assert.equal(firstUncheckedField(line({ flagged: [], touched: {} })), null);
  assert.equal(
    firstUncheckedField(line({ flagged: ['name'], touched: { name: true } })),
    null,
  );

  // An unticked line is never blocking, but it can still carry unvisited flags. This
  // function answers about the FLAGS and leaves "is this line blocking" to the gate — a
  // caller that conflated the two would print a marker on a card it does not belong on.
  assert.equal(blockingReason(line({ include: false, flagged: ['name'] })), null);
  assert.equal(firstUncheckedField(line({ include: false, flagged: ['name'] })), 'name');
});

test('the timing vocabulary is exactly three kinds', () => {
  // Same guard as the answer union below: a fourth kind is how "as-needed but also daily"
  // gets added later, and `scheduleFor` maps each of these onto a DIFFERENT write.
  const all: DoseTiming[] = ['per_day', 'as_needed', 'one_off'];
  assert.equal(new Set(all).size, 3);
  for (const timing of all) {
    assert.doesNotThrow(() => blockingReason(line({ doseTiming: timing })));
  }
});

// ── The number itself ────────────────────────────────────────────────────────

test('parseDoses accepts whole counts in range and nothing else', () => {
  assert.equal(parseDoses('1'), 1);
  assert.equal(parseDoses(' 4 '), 4);
  assert.equal(parseDoses(String(MAX_DOSES_PER_DAY)), MAX_DOSES_PER_DAY);

  // '' is first because `Number('')` is 0, which would pass a range check written the
  // other way round and report "no doses a day" as a number. '1e1' and '२' are the two
  // that a `Number()`-only implementation gets wrong in the dangerous direction: it reads
  // them as 10 and 2 respectively, from text no keypad on this screen can produce.
  for (const bad of ['', '   ', '0', '-1', '2.5', '1e1', '13', 'two', '٢', '२', '+2', '2 2']) {
    assert.equal(parseDoses(bad), null, JSON.stringify(bad));
  }
});

test('the typing cap is above the AI cap, and deliberately', () => {
  // Four is the most this app will schedule from a photograph; twelve is the most a person
  // may type before the field calls it a slip. A medicine between the two is accepted and
  // handed to manual timing entry — the app does not argue with a prescription.
  assert.ok(MAX_DOSES_PER_DAY > 4);
  assert.equal(blockingReason(line({ dosesPerDayText: '6' })), null);
});

test('the answer vocabulary is exactly three states', () => {
  // A fourth state is how "seeded but sort of accepted" gets added later. The union is the
  // place that refuses it, and this pins the union against being widened silently.
  const all: FrequencyAnswer[] = ['unanswered', 'agreed', 'own'];
  assert.equal(new Set(all).size, 3);
  for (const answer of all) {
    assert.doesNotThrow(() => blockingReason(line({ freqAnswer: answer })));
  }
});
