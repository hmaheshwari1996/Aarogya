/**
 * Tests for the frequency decoder.
 *
 * This is the highest-consequence transformation in the feature: the drug name is what a
 * reviewer checks and the frequency is what a reviewer skims, so "1-0-1 misread as QID"
 * survives review with the name looking perfectly correct and the dose quadrupled. Hence
 * the volume of cases below, and hence the deliberate over-representation of things the
 * decoder must REFUSE — an unrecognised pattern routes to manual entry, which is safe; a
 * plausible wrong pattern rings four times a day, which is not.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy — same trick as
 * `features/adherence/adherence.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './frequency.ts';
const { decodeFrequency, frequencyLabelEn, MAX_AI_DOSES_PER_DAY } = (await import(
  MODULE
)) as typeof import('./frequency');

/**
 * The slot registry, loaded the same way, purely so the assertions below check the decoder
 * against the REAL vocabulary rather than against a list retyped in this file.
 *
 * That is the whole point of the change these tests cover: the decoder used to own a
 * private `SlotKey` union and a private `DEFAULT_SLOT_TIMES`, and a test that hard-codes
 * the names is how a second vocabulary stays alive without anyone noticing.
 */
const REGISTRY = '../slots/registry.ts';
const { BUILTIN_SLOT_KEYS } = (await import(REGISTRY)) as typeof import('../slots/registry');

type Decoded = import('./frequency').DecodedFrequency;

function slots(decoded: Decoded): string[] {
  return decoded.slots.map((slot) => `${slot.slotKey}:${slot.units}`);
}

// ── Slot notation ────────────────────────────────────────────────────────────

test('1-0-1 is the two meal doses, twice a day', () => {
  const decoded = decodeFrequency('1-0-1');
  assert.equal(decoded.recognised, true);
  assert.equal(decoded.dosesPerDay, 2);
  assert.equal(decoded.unitsPerDay, 2);
  assert.deepEqual(slots(decoded), ['after_breakfast:1', 'after_dinner:1']);
  assert.equal(decoded.slotNotation, '1-0-1');
  assert.equal(decoded.scheduleType, 'FIXED');
  assert.equal(decoded.needsHumanCheck, false);
});

test('a three-part pattern never produces an evening dose', () => {
  // Three parts are the three meals in Indian usage. Reading the middle value as "evening"
  // would move a lunchtime tablet to five o'clock on every three-part script.
  const decoded = decodeFrequency('1-1-1');
  assert.deepEqual(slots(decoded), ['after_breakfast:1', 'after_lunch:1', 'after_dinner:1']);
});

test('1-1-1-1 is four doses, and only the fourth one is the evening', () => {
  const decoded = decodeFrequency('1-1-1-1');
  assert.equal(decoded.dosesPerDay, 4);
  assert.deepEqual(slots(decoded), [
    'after_breakfast:1',
    'after_lunch:1',
    'evening:1',
    'after_dinner:1',
  ]);
  assert.equal(decoded.needsHumanCheck, false, 'four a day is exactly at the cap, not over it');
});

test('0-0-1 is a single dose after dinner, not at bedtime', () => {
  // The distinction the nine-slot vocabulary exists to make: the third part of a slot
  // notation is the evening MEAL. Only HS/nocte means bedtime.
  const decoded = decodeFrequency('0-0-1');
  assert.equal(decoded.dosesPerDay, 1);
  assert.deepEqual(slots(decoded), ['after_dinner:1']);
});

test('halves survive as halves, in both number and text', () => {
  const decoded = decodeFrequency('1/2-0-1/2');
  assert.equal(decoded.dosesPerDay, 2);
  assert.equal(decoded.unitsPerDay, 1);
  assert.deepEqual(slots(decoded), ['after_breakfast:0.5', 'after_dinner:0.5']);
  // The verbatim token is kept because "1/2" and 0.5 are the same quantity but not the
  // same instruction to someone holding a strip.
  assert.equal(decoded.slots[0]?.text, '1/2');
  assert.ok(decoded.notes.includes('fractional_dose'));
});

test('a unicode half is the same as 1/2', () => {
  assert.deepEqual(slots(decodeFrequency('½-0-½')), ['after_breakfast:0.5', 'after_dinner:0.5']);
});

test('two tablets twice a day is two administrations and four units', () => {
  // The distinction the refill arithmetic depends on: a box of 30 lasts a week here,
  // not a fortnight.
  const decoded = decodeFrequency('2-0-2');
  assert.equal(decoded.dosesPerDay, 2);
  assert.equal(decoded.unitsPerDay, 4);
});

// ── Abbreviations ────────────────────────────────────────────────────────────

test('the standard abbreviations decode to the expected number of doses', () => {
  const cases: [string, number][] = [
    ['OD', 1],
    ['od', 1],
    ['o.d.', 1],
    ['BD', 2],
    ['BID', 2],
    ['b.d.', 2],
    ['TDS', 3],
    ['TID', 3],
    ['t.d.s.', 3],
    ['QID', 4],
    ['QDS', 4],
    ['HS', 1],
    ['OM', 1],
  ];
  for (const [input, expected] of cases) {
    assert.equal(decodeFrequency(input).dosesPerDay, expected, `${input} should be ${expected}/day`);
  }
});

test('HS is at bedtime and NOT with dinner', () => {
  // The four-slot build sent both HS and the third part of '1-0-1' to `night` at 21:00, so
  // "1 tab HS" — deliberately hours after food, which for a statin or a sedative is the
  // reason it is written that way — rang while she was still at the table.
  for (const input of ['HS', 'hs', 'nocte', 'at bedtime', '1 tab at night']) {
    assert.deepEqual(slots(decodeFrequency(input)), ['bedtime:1'], input);
  }
  assert.notDeepEqual(slots(decodeFrequency('HS')), slots(decodeFrequency('0-0-1')));
});

test('a bedtime dose has no slot notation, and its label says HS', () => {
  // Bedtime sits in neither layout, so there is no honest '1-0-1' form for it. Rendering
  // one would print '0-0-0' for a medicine that is very much prescribed.
  const decoded = decodeFrequency('HS');
  assert.equal(decoded.slotNotation, null);
  assert.equal(decoded.normalisedCode, 'HS');
  assert.equal(frequencyLabelEn(decoded), 'HS');
});

test('OM and OD both land on the first meal of the day', () => {
  assert.deepEqual(slots(decodeFrequency('OM')), ['after_breakfast:1']);
  assert.deepEqual(slots(decodeFrequency('OD')), ['after_breakfast:1']);
  assert.deepEqual(slots(decodeFrequency('once daily')), ['after_breakfast:1']);
});

test('"OD HS" is a bedtime dose, because the specific pattern is tested first', () => {
  assert.deepEqual(slots(decodeFrequency('OD HS')), ['bedtime:1']);
});

test('the same instruction written two ways decodes to the same slots', () => {
  // 'TDS' and '1-1-1' are one prescription in two hands. If the abbreviation table and the
  // notation layout ever drift apart, the same medicine gets different times depending on
  // how the doctor happened to write it.
  const pairs: [string, string][] = [
    ['BD', '1-0-1'],
    ['TDS', '1-1-1'],
    ['QID', '1-1-1-1'],
  ];
  for (const [abbreviation, notation] of pairs) {
    assert.deepEqual(
      slots(decodeFrequency(abbreviation)),
      slots(decodeFrequency(notation)),
      `${abbreviation} and ${notation}`,
    );
  }
});

test('"three times daily" is three doses, not one', () => {
  // The trap: "daily" also appears in the once-a-day pattern. If the more specific
  // patterns are not tested first, a thrice-daily antibiotic silently becomes once a day.
  assert.equal(decodeFrequency('three times daily').dosesPerDay, 3);
  assert.equal(decodeFrequency('twice daily').dosesPerDay, 2);
  assert.equal(decodeFrequency('four times a day').dosesPerDay, 4);
  assert.equal(decodeFrequency('once daily').dosesPerDay, 1);
});

test('a frequency embedded in a longer instruction still decodes', () => {
  assert.equal(decodeFrequency('1 tab BD x 5 days').dosesPerDay, 2);
  assert.equal(decodeFrequency('Tab 1-0-1 after food').dosesPerDay, 2);
});

// ── As needed, and one-off ───────────────────────────────────────────────────

test('SOS and PRN are as-needed and never schedule anything', () => {
  for (const input of ['SOS', 'prn', '1 tab SOS', 'as needed']) {
    const decoded = decodeFrequency(input);
    assert.equal(decoded.kind, 'prn', input);
    assert.equal(decoded.scheduleType, 'PRN', input);
    // Null, not 0: "no daily rhythm" and "zero doses" are different answers, and only
    // one of them means "do not put this on a calendar".
    assert.equal(decoded.dosesPerDay, null, input);
    assert.equal(decoded.slots.length, 0, input);
  }
});

test('an as-needed instruction containing a number is still as-needed', () => {
  // "1 tab SOS" must not decode as a daily dose because of the leading 1.
  assert.equal(decodeFrequency('1 tab SOS').kind, 'prn');
});

test('STAT is a single dose and is sent to a human', () => {
  const decoded = decodeFrequency('STAT');
  assert.equal(decoded.kind, 'one_off');
  assert.equal(decoded.dosesPerDay, null);
  assert.equal(decoded.needsHumanCheck, true);
  assert.ok(decoded.notes.includes('one_off'));
});

// ── Intervals ────────────────────────────────────────────────────────────────

test('alternate-day dosing sets interval_days to 2', () => {
  for (const input of ['alternate day', 'alt day', 'every other day', 'EOD', 'QOD']) {
    assert.equal(decodeFrequency(input).intervalDays, 2, input);
  }
});

test('a rhythm and an interval combine', () => {
  const decoded = decodeFrequency('OD alternate day');
  assert.equal(decoded.dosesPerDay, 1);
  assert.equal(decoded.intervalDays, 2);
  assert.equal(decoded.kind, 'interval');
});

test('weekly dosing asks for a human, because no weekday was named', () => {
  const decoded = decodeFrequency('once a week');
  assert.equal(decoded.intervalDays, 7);
  assert.equal(decoded.needsHumanCheck, true);
  assert.ok(decoded.notes.includes('weekday_unspecified'));
});

// ── Hourly ───────────────────────────────────────────────────────────────────

test('Q6H is four doses a day but supplies no slots', () => {
  const decoded = decodeFrequency('Q6H');
  assert.equal(decoded.kind, 'hourly');
  assert.equal(decoded.dosesPerDay, 4);
  assert.equal(decoded.everyHours, 6);
  // Q6H is 00:00/06:00/12:00/18:00. Pushing it into morning/afternoon/evening/night
  // would move every dose by hours, so no slots are offered and a person sets the times.
  assert.deepEqual(decoded.slots, []);
  assert.equal(decoded.needsHumanCheck, true);
});

test('Q4H exceeds the four-dose cap and says so', () => {
  const decoded = decodeFrequency('q4h');
  assert.equal(decoded.dosesPerDay, 6);
  assert.ok(decoded.notes.includes('exceeds_ai_dose_cap'));
  assert.equal(decoded.needsHumanCheck, true);
});

test('an hour count that does not divide the day is not recognised', () => {
  const decoded = decodeFrequency('Q5H');
  assert.equal(decoded.dosesPerDay, null);
  assert.equal(decoded.recognised, false);
});

// ── The refusals. These matter more than the successes. ─────────────────────

test('a two-part pattern is refused rather than guessed', () => {
  // Some prescribers mean morning and night by "1-1"; others mean morning and afternoon.
  // There is nothing on the paper that decides it, so the decoder must not.
  const decoded = decodeFrequency('1-1');
  assert.equal(decoded.recognised, false);
  assert.equal(decoded.dosesPerDay, null);
  assert.equal(decoded.needsHumanCheck, true);
});

test('the two-part refusal is named, so it can be explained rather than lumped in', () => {
  // Same decision as above, and the note is what lets the review screen say "this can mean
  // morning and night, or morning and afternoon" instead of "we could not read it". The
  // second sentence sends her looking for something that is not there.
  for (const input of ['1-1', '1 - 1', '1/2-1/2', '2-2']) {
    const decoded = decodeFrequency(input);
    assert.equal(decoded.recognised, false, input);
    assert.equal(decoded.dosesPerDay, null, input);
    assert.ok(decoded.notes.includes('ambiguous_two_part'), input);
  }
});

test('the two-part note never fires on a three- or four-part pattern', () => {
  for (const input of ['1-0-1', '1-1-1', '0-0-1', '1-1-1-1', '1/2-0-1/2']) {
    assert.equal(decodeFrequency(input).notes.includes('ambiguous_two_part'), false, input);
  }
});

test('a printed range is not claimed to be an ambiguous dose pattern', () => {
  // "x 5-10 days" and a date like "12-08" reach this decoder inside a verbatim frequency
  // string. They are unreadable, and that is all they are — over-claiming that a range is
  // a dose pattern would be a worse explanation on screen than the generic one.
  for (const input of ['x 5-10 days', '12-08', 'review 10-15 days']) {
    const decoded = decodeFrequency(input);
    assert.equal(decoded.recognised, false, input);
    assert.equal(decoded.notes.includes('ambiguous_two_part'), false, input);
  }
});

test('unreadable text produces no frequency at all', () => {
  for (const input of ['', '   ', 'as advised', 'see note', 'xyzzy', '???']) {
    const decoded = decodeFrequency(input);
    assert.equal(decoded.recognised, false, input);
    assert.equal(decoded.dosesPerDay, null, input);
    assert.equal(decoded.unitsPerDay, null, input);
    assert.equal(decoded.needsHumanCheck, true, input);
  }
});

test('null and undefined are handled like blank text', () => {
  assert.equal(decodeFrequency(null).recognised, false);
  assert.equal(decodeFrequency(undefined).recognised, false);
});

test('a tapering course is recognised as a taper and never flattened', () => {
  const decoded = decodeFrequency('40 mg x 3 days then taper');
  assert.equal(decoded.recognised, false);
  assert.equal(decoded.normalisedCode, 'TAPER');
  assert.ok(decoded.notes.includes('tapering'));
  assert.equal(decoded.dosesPerDay, null);
});

test('nothing recognised as daily ever exceeds the cap without flagging it', () => {
  for (const input of ['1-0-1', '1-1-1', '1-1-1-1', 'OD', 'BD', 'TDS', 'QID']) {
    const decoded = decodeFrequency(input);
    const doses = decoded.dosesPerDay ?? 0;
    if (doses > MAX_AI_DOSES_PER_DAY) {
      assert.ok(decoded.notes.includes('exceeds_ai_dose_cap'), input);
      assert.equal(decoded.needsHumanCheck, true, input);
    }
  }
});

// ── Presentation ─────────────────────────────────────────────────────────────

test('labels restate the pattern and never explain it', () => {
  assert.equal(frequencyLabelEn(decodeFrequency('1-0-1')), '1-0-1');
  assert.equal(frequencyLabelEn(decodeFrequency('OD alternate day')), '1-0-0, alternate days');
  assert.equal(frequencyLabelEn(decodeFrequency('SOS')), 'only when needed');
  assert.equal(frequencyLabelEn(decodeFrequency('nonsense')), 'not read');
});

// ── One vocabulary ───────────────────────────────────────────────────────────

test('every slot the decoder can produce is a built-in slot in the registry', () => {
  // This test replaces one that asserted the decoder's OWN four-key `DEFAULT_SLOT_TIMES`.
  // That constant is gone: the decoder names slots and the registry owns the times, and a
  // key here that the registry does not know would render as a bare clock time on the
  // medicines list — or, worse, resolve to nothing and drop the dose out of every section.
  const known = new Set<string>(BUILTIN_SLOT_KEYS);
  const inputs = [
    '1-0-1',
    '1-1-1',
    '1-1-1-1',
    '0-0-1',
    '1/2-0-1/2',
    'OD',
    'OM',
    'BD',
    'TDS',
    'QID',
    'HS',
    'once a week',
    'alternate day',
    'OD alternate day',
  ];
  for (const input of inputs) {
    for (const slot of decodeFrequency(input).slots) {
      assert.ok(known.has(slot.slotKey), `${input} produced unknown slot ${slot.slotKey}`);
    }
  }
});

test('the decoder never invents a before-meal or midday dose', () => {
  // Nothing in Indian shorthand asks for one. `before_*` and `midday` exist for the user to
  // choose on the schedule screen, where she can see the clock time she is choosing.
  const forbidden = new Set([
    'before_breakfast',
    'before_lunch',
    'before_dinner',
    'midday',
    'after_lunch_snack',
  ]);
  for (const input of ['1-0-1', '1-1-1', '1-1-1-1', 'OD', 'BD', 'TDS', 'QID', 'HS', 'OM']) {
    for (const slot of decodeFrequency(input).slots) {
      assert.ok(!forbidden.has(slot.slotKey), `${input} produced ${slot.slotKey}`);
    }
  }
});

test('a rhythm with no time of day still lands on exactly one named slot', () => {
  // 'weekly' and 'alternate day' say how often and never when. One slot, not zero — a
  // schedule with no time cannot ring at all — and the user moves it afterwards.
  for (const input of ['once a week', 'alternate day']) {
    assert.deepEqual(slots(decodeFrequency(input)), ['after_breakfast:1'], input);
  }
});
