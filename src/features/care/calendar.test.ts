/**
 * Tests for the care-calendar derivation, its guards, and the refill arithmetic.
 *
 * All three modules are pure — no database, no clock they do not receive, no network —
 * which is the point: the rules that decide what may be written onto somebody's calendar
 * are exactly the rules that must be checkable without a device in the room.
 *
 * The cases below are weighted towards REFUSALS and PROVENANCE. Getting a date right is
 * ordinary; refusing to produce one when the anchor is missing, and keeping "the doctor
 * wrote this" separate from "the app worked this out", is what stops an app-chosen number
 * being read as clinical instruction.
 *
 * On the dynamic import: see `features/adherence/adherence.test.ts` — Node's
 * type-stripping loader needs a fully-specified './x.ts' specifier, and this project does
 * not enable `allowImportingTsExtensions`.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Lets these modules import `../../lib/datetime` the way every other file in the app does.
 *
 * Metro resolves extensionless relative specifiers; Node's ESM resolver does not, and
 * this project cannot use explicit '.ts' specifiers in source because
 * `allowImportingTsExtensions` is off. The alternative would be a second copy of
 * `addDays`/`addMonthsClamped`/`daysBetween` living inside `care/` purely so the tests
 * can load it — and a second implementation of the month-clamping rule is exactly the
 * kind of quiet divergence these tests exist to catch. So the resolver is taught the one
 * thing it is missing, here, in the test file, and nothing in the app changes.
 *
 * `registerHooks` is synchronous and in-thread, so it applies to the dynamic imports
 * below. `node --test` runs each test file in its own process, so it affects nothing else.
 */
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

const CALENDAR = './calendar.ts';
const GUARDS = './guards.ts';
const REFILL = './refill.ts';

const { deriveCareCalendar, deriveTestChain, DEFAULT_CARE_OFFSETS } = (await import(
  CALENDAR
)) as typeof import('./calendar');
const { validateProposedCalendar, buildConfirmModel } = (await import(
  GUARDS
)) as typeof import('./guards');
const { projectRefill, proposeRefill } = (await import(REFILL)) as typeof import('./refill');

type FollowUp = import('../prescriptions/schema').ParsedFollowUp;
type Test = import('../prescriptions/schema').ParsedTest;
type Proposal = import('./calendar').ProposedCareEvent;
type Category = import('../prescriptions/schema').TestCategory;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NO_FOLLOW_UP: FollowUp = {
  present: false,
  verbatim: null,
  absoluteDate: null,
  relativeValue: null,
  relativeUnit: 'unknown',
  confidence: 'unknown',
};

function relativeFollowUp(value: number, unit: FollowUp['relativeUnit'], verbatim: string): FollowUp {
  return { present: true, verbatim, absoluteDate: null, relativeValue: value, relativeUnit: unit, confidence: 'high' };
}

function absoluteFollowUp(date: string, verbatim = `come back on ${date}`): FollowUp {
  return { present: true, verbatim, absoluteDate: date, relativeValue: null, relativeUnit: 'unknown', confidence: 'high' };
}

function advisedTest(name: string, category: Category = 'routine_biochemistry'): Test {
  return {
    nameAsWritten: name,
    normalisedName: null,
    category,
    verbatimInstruction: `repeat ${name}`,
    confidence: 'high',
  };
}

function byKey(proposals: readonly Proposal[], key: string): Proposal {
  const found = proposals.find((proposal) => proposal.key === key);
  assert.ok(found, `expected a proposal with key ${key}`);
  return found;
}

// ── The visit ────────────────────────────────────────────────────────────────

test('a written date becomes a transcribed visit, quoting the paper', () => {
  const { proposals, refusals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: absoluteFollowUp('2026-09-01', 'review on 01/09'),
    testsAdvised: [],
    today: '2026-08-01',
  });

  assert.deepEqual(refusals, []);
  const visit = byKey(proposals, 'visit');
  assert.equal(visit.dueOn, '2026-09-01');
  assert.equal(visit.anchorSource, 'transcribed');
  assert.equal(visit.evidence, 'review on 01/09');
  assert.equal(visit.offsetDays, 0);
});

test('"review after 1 month" on 31 January lands on 28 February, not 3 March', () => {
  // The whole reason `addMonthsClamped` exists. Adding 30 days would put the appointment
  // in the following month, on a date the doctor never wrote.
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-01-31',
    followUp: relativeFollowUp(1, 'month', 'review after 1 month'),
    testsAdvised: [],
    today: '2026-01-31',
  });

  const visit = byKey(proposals, 'visit');
  assert.equal(visit.dueOn, '2026-02-28');
  assert.equal(visit.anchorSource, 'transcribed');
  assert.match(visit.derivation ?? '', /clamped/);
});

test('weeks and days are counted from the prescription date', () => {
  const weeks = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: relativeFollowUp(2, 'week', 'f/u 2 wks'),
    testsAdvised: [],
    today: '2026-08-01',
  });
  assert.equal(byKey(weeks.proposals, 'visit').dueOn, '2026-08-15');

  const days = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: relativeFollowUp(10, 'day', 'review in 10 days'),
    testsAdvised: [],
    today: '2026-08-01',
  });
  assert.equal(byKey(days.proposals, 'visit').dueOn, '2026-08-11');
});

test('the appointment reminder is inferred, two days ahead, and says so', () => {
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: absoluteFollowUp('2026-09-01'),
    testsAdvised: [],
    today: '2026-08-01',
  });

  const book = byKey(proposals, 'book_appointment');
  assert.equal(book.dueOn, '2026-08-30');
  assert.equal(book.anchorSource, 'inferred');
  assert.equal(book.anchorKey, 'visit');
  assert.equal(book.offsetDays, -DEFAULT_CARE_OFFSETS.appointmentBookLeadDays);
  assert.equal(book.evidence, null, 'an inferred row has no evidence — it has a derivation');
  assert.ok(book.derivation, 'an inferred row must be able to explain itself');
});

// ── The refusals ─────────────────────────────────────────────────────────────

test('an unreadable prescription date proposes nothing for a relative follow-up', () => {
  // Anchoring "after 1 month" to today would be wrong by however long the paper sat in a
  // handbag, and the result would look exactly like a date the doctor gave.
  const { proposals, refusals } = deriveCareCalendar({
    prescribedOn: null,
    followUp: relativeFollowUp(1, 'month', 'review after 1 month'),
    testsAdvised: [],
    today: '2026-08-09',
  });

  assert.deepEqual(proposals, []);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.code, 'prescription_date_unknown');
});

test('an unreadable prescription date still allows a follow-up written as a date', () => {
  // Nothing is being counted from anywhere here — the day is on the paper.
  const { proposals, refusals } = deriveCareCalendar({
    prescribedOn: null,
    followUp: absoluteFollowUp('2026-09-01'),
    testsAdvised: [],
    today: '2026-08-09',
  });

  assert.equal(byKey(proposals, 'visit').dueOn, '2026-09-01');
  assert.deepEqual(refusals, []);
});

test('a follow-up with no quoted words is refused', () => {
  const { proposals, refusals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: { ...relativeFollowUp(1, 'month', 'x'), verbatim: null },
    testsAdvised: [],
    today: '2026-08-01',
  });

  assert.deepEqual(proposals, []);
  assert.equal(refusals[0]?.code, 'follow_up_without_evidence');
});

test('no follow-up on the paper means no visit and no complaint', () => {
  const { proposals, refusals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: NO_FOLLOW_UP,
    testsAdvised: [],
    today: '2026-08-01',
  });

  assert.deepEqual(proposals, []);
  assert.deepEqual(refusals, []);
});

// ── Test chains ──────────────────────────────────────────────────────────────

test('a routine test chains book → do → collect, backwards from the visit', () => {
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: absoluteFollowUp('2026-09-01'),
    testsAdvised: [advisedTest('LFT')],
    today: '2026-08-01',
  });

  const collect = byKey(proposals, 'test:0:collect');
  const doIt = byKey(proposals, 'test:0:do');
  const book = byKey(proposals, 'test:0:book');

  assert.equal(collect.dueOn, '2026-08-31', 'report in hand the day before the visit');
  assert.equal(doIt.dueOn, '2026-08-30', 'routine biochemistry turns around in about a day');
  assert.equal(book.dueOn, '2026-08-28', 'booked two days ahead');

  assert.equal(collect.anchorKey, 'visit');
  assert.equal(doIt.anchorKey, 'test:0:collect');
  assert.equal(book.anchorKey, 'test:0:do');
  for (const row of [collect, doIt, book]) {
    assert.equal(row.anchorSource, 'inferred');
    assert.equal(row.relatedTestKey, 'test:0');
  }
});

test('a culture is given a longer turnaround than a routine test', () => {
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: absoluteFollowUp('2026-09-01'),
    testsAdvised: [advisedTest('Urine culture', 'culture')],
    today: '2026-08-01',
  });

  assert.equal(byKey(proposals, 'test:0:collect').dueOn, '2026-08-31');
  assert.equal(byKey(proposals, 'test:0:do').dueOn, '2026-08-28', 'three days for a culture');
  assert.equal(byKey(proposals, 'test:0:book').dueOn, '2026-08-26');
});

test('imaging reports on the day, so doing and collecting coincide', () => {
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: absoluteFollowUp('2026-09-01'),
    testsAdvised: [advisedTest('USG abdomen', 'imaging')],
    today: '2026-08-01',
  });

  assert.equal(byKey(proposals, 'test:0:collect').dueOn, '2026-08-31');
  assert.equal(byKey(proposals, 'test:0:do').dueOn, '2026-08-31');
});

test('turnaround defaults are editable, and editing them moves the chain', () => {
  const { proposals } = deriveCareCalendar(
    {
      prescribedOn: '2026-08-01',
      followUp: absoluteFollowUp('2026-09-01'),
      testsAdvised: [advisedTest('LFT')],
      today: '2026-08-01',
    },
    {
      ...DEFAULT_CARE_OFFSETS,
      testBookLeadDays: 7,
      turnaroundDays: { ...DEFAULT_CARE_OFFSETS.turnaroundDays, routine_biochemistry: 4 },
    },
  );

  assert.equal(byKey(proposals, 'test:0:do').dueOn, '2026-08-27');
  assert.equal(byKey(proposals, 'test:0:book').dueOn, '2026-08-20');
});

test('a test with no visit to hang off is handed back for the user to date', () => {
  const { proposals, testsNeedingDate } = deriveCareCalendar({
    prescribedOn: '2026-08-01',
    followUp: NO_FOLLOW_UP,
    testsAdvised: [advisedTest('CBC')],
    today: '2026-08-01',
  });

  assert.deepEqual(proposals, []);
  assert.equal(testsNeedingDate.length, 1);
  assert.equal(testsNeedingDate[0]?.name, 'CBC');
});

test('a chain hung off a date the user typed uses the same offsets', () => {
  const chain = deriveTestChain({
    anchor: { key: 'manual', dueOn: '2026-09-10' },
    test: { index: 0, name: 'CBC', category: 'routine_biochemistry' },
    floor: '2026-08-01',
  });

  assert.deepEqual(
    chain.map((row) => [row.kind, row.dueOn]),
    [
      ['test_book', '2026-09-06'],
      ['test_do', '2026-09-08'],
      ['test_collect', '2026-09-09'],
    ],
  );
});

// ── Clamping ─────────────────────────────────────────────────────────────────

test('a derived date is never proposed in the past, and says it was moved', () => {
  // Photographed the day before a visit, with a five-day histopathology turnaround: the
  // arithmetic wants last week. Reminding someone about last Tuesday helps nobody.
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-08-09',
    followUp: absoluteFollowUp('2026-08-11'),
    testsAdvised: [advisedTest('Biopsy', 'histopathology')],
    today: '2026-08-09',
  });

  const doIt = byKey(proposals, 'test:0:do');
  assert.equal(doIt.dueOn, '2026-08-09');
  assert.equal(doIt.adjusted, true);
  assert.ok(doIt.adjustedNote);

  // And the recorded offset still explains the recorded date — the pair the database
  // keeps, and what `recomputeInferredDueDate()` will rely on when the visit moves.
  const collect = byKey(proposals, 'test:0:collect');
  assert.equal(doIt.offsetDays, -1);
  assert.equal(collect.dueOn, '2026-08-10');
});

test('a transcribed date is never clamped, even when it has already passed', () => {
  const { proposals } = deriveCareCalendar({
    prescribedOn: '2026-07-01',
    followUp: absoluteFollowUp('2026-07-20'),
    testsAdvised: [],
    today: '2026-08-09',
  });

  // The doctor wrote it. It is evidence, not a suggestion, and moving it would replace a
  // date the doctor gave with one this app computed — while keeping the doctor's weight.
  assert.equal(byKey(proposals, 'visit').dueOn, '2026-07-20');
  assert.equal(byKey(proposals, 'visit').adjusted, false);
});

// ── Guards ───────────────────────────────────────────────────────────────────

const EVIDENCE = {
  prescribedOn: '2026-08-01',
  followUp: absoluteFollowUp('2026-09-01'),
  testsAdvised: [advisedTest('LFT')],
};

test('a derivation from real evidence passes the guard whole', () => {
  const { proposals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const { accepted, rejected } = validateProposedCalendar(proposals, EVIDENCE);

  assert.equal(rejected.length, 0);
  assert.equal(accepted.length, proposals.length);
});

test('a follow-up that appears nowhere on the prescription is refused', () => {
  const fabricated: Proposal = {
    key: 'visit',
    kind: 'visit',
    title: 'Visit the doctor again',
    dueOn: '2026-09-01',
    anchorSource: 'transcribed',
    anchorKey: null,
    offsetDays: 0,
    relatedTestKey: null,
    testName: null,
    evidence: 'review after 1 month',
    derivation: null,
    adjusted: false,
    adjustedNote: null,
  };

  const { accepted, rejected } = validateProposedCalendar([fabricated], {
    ...EVIDENCE,
    followUp: NO_FOLLOW_UP,
  });

  assert.deepEqual(accepted, []);
  assert.equal(rejected[0]?.code, 'follow_up_not_on_prescription');
});

test('a visit date that does not match the instruction is refused', () => {
  const { proposals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const visit = byKey(proposals, 'visit');
  const tampered: Proposal = { ...visit, dueOn: '2026-09-08' };

  const { rejected } = validateProposedCalendar([tampered], EVIDENCE);
  assert.equal(rejected[0]?.code, 'follow_up_date_does_not_match');
});

test('a test that was never advised is refused', () => {
  const { proposals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const { rejected } = validateProposedCalendar(proposals, { ...EVIDENCE, testsAdvised: [] });

  assert.ok(rejected.some((row) => row.code === 'test_not_advised'));
  assert.equal(rejected.length, 3, 'all three rows of the chain go');
});

test('an inferred row whose offset does not explain its date is refused', () => {
  const { proposals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const visit = byKey(proposals, 'visit');
  const book = byKey(proposals, 'book_appointment');
  const tampered: Proposal = { ...book, dueOn: '2026-08-20' };

  const { rejected } = validateProposedCalendar([visit, tampered], EVIDENCE);
  assert.equal(rejected[0]?.code, 'offset_does_not_explain_date');
});

test('rejecting an anchor rejects everything hanging off it', () => {
  const { proposals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const withoutVisit = proposals.filter((row) => row.key !== 'visit');

  const { accepted, rejected } = validateProposedCalendar(withoutVisit, EVIDENCE);
  assert.deepEqual(accepted, []);
  assert.ok(rejected.every((row) => row.code === 'anchor_rejected'));
});

test('the confirm model keeps what the doctor wrote apart from what the app worked out', () => {
  const { proposals, refusals } = deriveCareCalendar({ ...EVIDENCE, today: '2026-08-01' });
  const model = buildConfirmModel(validateProposedCalendar(proposals, EVIDENCE), refusals);

  assert.equal(model.requiresConfirmation, true);
  assert.equal(model.transcribed.length, 1);
  assert.equal(model.transcribed[0]?.kind, 'visit');
  assert.ok(model.transcribed[0]?.evidence, 'a transcribed row shows the words on the paper');
  assert.equal(model.transcribed[0]?.editable.offsetDays, false);

  assert.equal(model.inferred.length, 4, 'book the appointment, plus the three test rows');
  for (const row of model.inferred) {
    assert.ok(row.derivation, 'an inferred row shows its working');
    assert.equal(row.evidence, null);
    assert.equal(row.editable.offsetDays, true, 'the offset is ours, so she can change it');
  }
});

// ── Refills ──────────────────────────────────────────────────────────────────

test('thirty tablets at two a day run out in fifteen days', () => {
  const projection = projectRefill({
    startOn: '2026-08-01',
    quantityDispensed: 30,
    unitsPerDay: 2,
  });

  assert.ok(projection);
  assert.equal(projection.daysOfSupply, 15);
  assert.equal(projection.runOutOn, '2026-08-16');
  assert.equal(projection.refillOn, '2026-08-11', 'five days of lead by default');
  assert.equal(projection.dueNow, false);
  assert.match(projection.arithmetic.workingEn, /30 ÷ 2 a day = 15 days/);
});

test('part-days are floored, because half a day of tablets is not a day', () => {
  const projection = projectRefill({
    startOn: '2026-08-01',
    quantityDispensed: 24,
    unitsPerDay: 5,
  });
  assert.equal(projection?.daysOfSupply, 4, '4.8 days is four days of doses');
  assert.equal(projection?.runOutOn, '2026-08-05');
});

test('running out before the next visit is warned about, with the gap', () => {
  const projection = projectRefill({
    startOn: '2026-08-01',
    quantityDispensed: 30,
    unitsPerDay: 2,
    nextVisitOn: '2026-08-20',
    medicineName: 'Metformin',
  });

  assert.equal(projection?.coversNextVisit, false);
  assert.equal(projection?.shortfallDays, 4);
  assert.equal(projection?.warning?.code, 'runs_out_before_next_visit');
  assert.match(projection?.warning?.message ?? '', /4 days before the next visit/);
});

test('a supply that lasts past the visit raises nothing', () => {
  const projection = projectRefill({
    startOn: '2026-08-01',
    quantityDispensed: 30,
    unitsPerDay: 2,
    nextVisitOn: '2026-08-10',
  });

  assert.equal(projection?.coversNextVisit, true);
  assert.equal(projection?.warning, null);
  assert.equal(projection?.shortfallDays, 0);
});

test('an as-needed medicine has no run-out date at all', () => {
  // "We cannot say" and "you have plenty" are different answers. Null keeps them apart,
  // and keeps a refill reminder off the calendar for a painkiller taken twice a month.
  assert.equal(projectRefill({ startOn: '2026-08-01', quantityDispensed: 20, unitsPerDay: 0 }), null);
  assert.equal(proposeRefill({
    threadId: 't',
    medicineName: 'Paracetamol',
    input: { startOn: '2026-08-01', quantityDispensed: 20, unitsPerDay: 0 },
  }), null);
});

test('a refill reminder is never dated in the past', () => {
  const projection = projectRefill({
    startOn: '2026-08-01',
    quantityDispensed: 4,
    unitsPerDay: 2,
    today: '2026-08-09',
  });

  assert.equal(projection?.runOutOn, '2026-08-03');
  assert.equal(projection?.refillOn, '2026-08-09', 'pulled up to today rather than left behind');
  assert.equal(projection?.dueNow, true);
});

test('a refill proposal carries the working it was accepted on', () => {
  const proposal = proposeRefill({
    threadId: 'thread-1',
    medicineName: 'Metformin',
    input: { startOn: '2026-08-01', quantityDispensed: 30, unitsPerDay: 2 },
  });

  assert.ok(proposal);
  assert.equal(proposal.kind, 'refill');
  assert.equal(proposal.dueOn, '2026-08-11');
  assert.equal(proposal.relatedThreadId, 'thread-1');
  assert.equal(proposal.offsetDays, -5);
  assert.ok(proposal.projection.arithmetic.workingEn.length > 0);
});
