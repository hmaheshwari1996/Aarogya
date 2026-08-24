/**
 * Tests for the pinned-band ranking.
 *
 * What is actually at stake: this decides where a chip is on a screen used daily by
 * someone with a tremor, at 1.3× font scale, who navigates by muscle memory. The failures
 * worth catching are not "the sort is wrong" — they are:
 *
 *   1. THE BAND RESHUFFLES. If the pinned items are ordered by count, every recorded
 *      symptom can swap two of them. The band must be in canonical order, always.
 *   2. A ONE-TAP DIFFERENCE MOVES A CHIP. Six versus five is noise. If that pins one and
 *      not the other, the list is different every week for no reason.
 *   3. A FALLBACK GETS PROMOTED. "Something else" at the top of a symptom list starts
 *      catching taps that belonged to a real symptom, and that lands in the record.
 *   4. A FRESH INSTALL IS NOT THE CANONICAL LIST. With no history the output has to be
 *      byte-identical to the input order, or every new user gets an arbitrary arrangement.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy — same trick as
 * `features/slots/registry.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './index.ts';
const { pinMostUsed } = (await import(MODULE)) as typeof import('./index');

type Chip = { key: string };

const CANONICAL: Chip[] = [
  { key: 'breathless' },
  { key: 'chest_discomfort' },
  { key: 'dizzy' },
  { key: 'very_tired' },
  { key: 'cough' },
  { key: 'fever' },
  { key: 'vomiting' },
  { key: 'other' },
];

const keyOf = (chip: Chip) => chip.key;
const keys = (items: readonly Chip[]) => items.map(keyOf);

test('no history leaves the canonical list exactly as it was', () => {
  const result = pinMostUsed(CANONICAL, keyOf, []);
  assert.deepEqual(result.pinned, []);
  assert.deepEqual(keys(result.rest), keys(CANONICAL));
});

test('an empty list is a no-op rather than a crash', () => {
  const result = pinMostUsed([], keyOf, [{ key: 'cough', count: 99 }]);
  assert.deepEqual(result.pinned, []);
  assert.deepEqual(result.rest, []);
});

test('a clearly dominant key is pinned and removed from the remainder', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 20 },
    { key: 'fever', count: 1 },
  ]);
  assert.deepEqual(keys(result.pinned), ['cough']);
  assert.ok(!keys(result.rest).includes('cough'), 'a pinned chip must not also appear below');
  assert.deepEqual(keys(result.rest), [
    'breathless',
    'chest_discomfort',
    'dizzy',
    'very_tired',
    'fever',
    'vomiting',
    'other',
  ]);
});

test('THE BAND IS IN CANONICAL ORDER, NOT COUNT ORDER', () => {
  // cough is recorded far more often than breathless, but breathless comes first in the
  // clinical order — so breathless is first in the band. This is the property that stops
  // the band rearranging itself as counts drift.
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 40 },
    { key: 'breathless', count: 20 },
  ]);
  assert.deepEqual(keys(result.pinned), ['breathless', 'cough']);
});

test('one more tap does not change the band', () => {
  const before = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 40 },
    { key: 'breathless', count: 20 },
  ]);
  const after = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 40 },
    { key: 'breathless', count: 21 },
  ]);
  assert.deepEqual(keys(after.pinned), keys(before.pinned));
  assert.deepEqual(keys(after.rest), keys(before.rest));
});

test('neighbours a hair apart pin nothing at all', () => {
  // 10 / 9 / 8 / 8 with a margin of 2: no key clears the next one, so the app makes no
  // claim about which she prefers and the canonical list is left alone.
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 10 },
    { key: 'fever', count: 9 },
    { key: 'dizzy', count: 8 },
    { key: 'vomiting', count: 8 },
  ]);
  assert.deepEqual(result.pinned, []);
  assert.deepEqual(keys(result.rest), keys(CANONICAL));
});

test('the margin is measured against the best UNPINNED contender', () => {
  // cough(12) clears fever(3) by 9. fever(3) does not clear dizzy(2) by 2, so it is
  // dropped even though it is above minCount.
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 12 },
    { key: 'fever', count: 3 },
    { key: 'dizzy', count: 2 },
  ]);
  assert.deepEqual(keys(result.pinned), ['cough']);
});

test('a key below minCount is never pinned however lonely the list', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [{ key: 'vomiting', count: 2 }]);
  assert.deepEqual(result.pinned, []);
});

test('a low-count key still blocks a rival that barely beats it', () => {
  // dizzy has only been recorded twice, so it cannot be pinned itself — but cough is one
  // tap ahead of it, and one tap is not a preference. Nothing is pinned.
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 3 },
    { key: 'dizzy', count: 2 },
  ]);
  assert.deepEqual(result.pinned, []);
});

test('a never-pinned key is out of the competition, not merely un-pinnable', () => {
  // 'other' is tapped more than anything else, but its place is fixed by what it MEANS.
  // It neither takes the band nor blocks it — otherwise a list whose default is a
  // fallback (food relation's "any") could never form a band at all.
  const result = pinMostUsed(
    CANONICAL,
    keyOf,
    [
      { key: 'other', count: 30 },
      { key: 'cough', count: 20 },
      { key: 'fever', count: 1 },
    ],
    { neverPin: ['other'] },
  );
  assert.deepEqual(keys(result.pinned), ['cough']);
});

test('a fallback is never promoted even when it dominates outright', () => {
  const result = pinMostUsed(
    CANONICAL,
    keyOf,
    [
      { key: 'other', count: 50 },
      { key: 'cough', count: 20 },
      { key: 'fever', count: 1 },
    ],
    { neverPin: ['other'] },
  );
  assert.deepEqual(keys(result.pinned), ['cough']);
  assert.equal(keys(result.rest).at(-1), 'other', 'the fallback stays last');
});

test('the band is capped at maxPinned and the cap is respected from the top', () => {
  const result = pinMostUsed(
    CANONICAL,
    keyOf,
    [
      { key: 'vomiting', count: 40 },
      { key: 'fever', count: 30 },
      { key: 'cough', count: 20 },
      { key: 'dizzy', count: 10 },
      { key: 'very_tired', count: 3 },
    ],
    { maxPinned: 3 },
  );
  // Top three by count are vomiting/fever/cough; rendered in canonical order.
  assert.deepEqual(keys(result.pinned), ['cough', 'fever', 'vomiting']);
  assert.deepEqual(keys(result.rest), [
    'breathless',
    'chest_discomfort',
    'dizzy',
    'very_tired',
    'other',
  ]);
});

test('maxPinned of zero disables the band entirely', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [{ key: 'cough', count: 99 }], { maxPinned: 0 });
  assert.deepEqual(result.pinned, []);
  assert.deepEqual(keys(result.rest), keys(CANONICAL));
});

test('counts for keys that are not in the list are ignored', () => {
  // A retired symptom key still has events pointing at it, so it still has a count. It is
  // not offerable, so it is not in `items`, and it must not affect anything.
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'nausea_vomiting', count: 99 },
    { key: 'cough', count: 20 },
    { key: 'fever', count: 1 },
  ]);
  assert.deepEqual(keys(result.pinned), ['cough']);
});

test('duplicate count rows are summed, not overwritten', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 2 },
    { key: 'cough', count: 2 },
    { key: 'fever', count: 1 },
  ]);
  assert.deepEqual(keys(result.pinned), ['cough'], 'two rows of 2 make 4, which clears minCount');
});

test('a negative count cannot drag a key below zero', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: -50 },
    { key: 'fever', count: 5 },
  ]);
  assert.deepEqual(keys(result.pinned), ['fever']);
});

test('THE TRIM CASCADES: one tap can dissolve the whole band, and that is intended', () => {
  // This is the behaviour that looks like a bug in review, so it is written down as a
  // test rather than left to be rediscovered and "fixed". See the module header.
  //
  // Three keys are clearly ahead of the field, so all three pin: the weakest of them
  // (dizzy, 8) clears the best contender (vomiting, 6) by the margin of 2.
  const before = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 10 },
    { key: 'fever', count: 9 },
    { key: 'dizzy', count: 8 },
    { key: 'vomiting', count: 6 },
  ]);
  assert.deepEqual(keys(before.pinned), ['dizzy', 'cough', 'fever'], 'canonical order, not count order');

  // She records vomiting twice more. Now four keys sit at 10/9/8/8 — one cluster, with
  // nothing distinguishable from its neighbour — so the app makes NO claim at all and the
  // list reverts to the canonical clinical order. Not two chips, not one: none.
  //
  // Keeping a partial band here would mean asserting a preference the record does not
  // support, and whichever member the assertion landed on would flip again on the next
  // tap. The all-or-nothing band is what stops that flapping.
  const after = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 10 },
    { key: 'fever', count: 9 },
    { key: 'dizzy', count: 8 },
    { key: 'vomiting', count: 8 },
  ]);
  assert.deepEqual(after.pinned, [], 'a bunched field pins nothing, however large the counts');
  assert.deepEqual(keys(after.rest), keys(CANONICAL), 'and the fallback is the canonical list');
});

test('every item appears exactly once across pinned and rest', () => {
  const result = pinMostUsed(CANONICAL, keyOf, [
    { key: 'cough', count: 40 },
    { key: 'vomiting', count: 20 },
    { key: 'fever', count: 1 },
  ]);
  const all = [...keys(result.pinned), ...keys(result.rest)].sort();
  assert.deepEqual(all, keys(CANONICAL).slice().sort());
});
