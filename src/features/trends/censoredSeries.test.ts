/**
 * The rule that a chart may not delete a reading, held to it.
 *
 * The bug these tests exist to prevent is not a crash — it is a screen that quietly says
 * "No blood sugar recorded yet" over a fortnight containing a hypoglycaemic episode. So
 * the assertions are mostly about COUNTS ADDING UP, which is the shape that failure took.
 *
 * On the dynamic import: see `src/features/adherence/adherence.test.ts` — Node's
 * type-stripping loader resolves only fully-specified './x.ts' paths, while this
 * project's tsconfig does not enable `allowImportingTsExtensions`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './censoredSeries.ts';
const { planSeries, planBounds, capPlan } = (await import(MODULE)) as typeof import('./censoredSeries');

type Reading = import('./censoredSeries').CensorableReading;

const measured = (v1: number): Reading => ({ v1, valueQualifier: 'exact', qualifierBound: null });
const lo = (bound: number | null): Reading => ({
  v1: null,
  valueQualifier: 'below_range',
  qualifierBound: bound,
});
const hi = (bound: number | null): Reading => ({
  v1: null,
  valueQualifier: 'above_range',
  qualifierBound: bound,
});

test('every reading lands in exactly one bucket and the buckets add up', () => {
  const plan = planSeries([measured(126), lo(20), hi(600), lo(null), measured(148)]);
  assert.equal(plan.measuredCount, 2);
  assert.equal(plan.censoredCount, 2);
  assert.equal(plan.undrawableCount, 1);
  assert.equal(plan.measuredCount + plan.censoredCount + plan.undrawableCount, 5);
  assert.equal(plan.entries.length, 4);
});

test('a censored entry is typed apart from a measurement and carries a direction', () => {
  const plan = planSeries([lo(20), hi(600)]);
  const [first, second] = plan.entries;
  assert.equal(first?.kind, 'censored');
  assert.equal(second?.kind, 'censored');
  assert.equal(first?.kind === 'censored' ? first.direction : null, 'below');
  assert.equal(second?.kind === 'censored' ? second.direction : null, 'above');
  // The value is the meter's limit, and it is the number the chart positions the mark at.
  assert.equal(first?.value, 20);
  assert.equal(second?.value, 600);
});

test('input order is preserved, because these charts plot by position', () => {
  const plan = planSeries([measured(90), lo(20), measured(150)]);
  assert.deepEqual(
    plan.entries.map((entry) => entry.kind),
    ['measured', 'censored', 'measured'],
  );
  assert.deepEqual(
    plan.entries.map((entry) => entry.value),
    [90, 20, 150],
  );
});

test('a LO with no recorded meter range is counted, never drawn, and never dropped', () => {
  // This is the state the app ships in: nobody has told it what her meter can read.
  const plan = planSeries([lo(null), lo(0), lo(Number.NaN)]);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.undrawableCount, 3);
  // The caller therefore cannot conclude "nothing was recorded" from an empty entry list,
  // which is precisely the conclusion the screen used to draw.
  assert.ok(plan.undrawableCount > 0);
});

test('the meter limits go into the axis alongside the measurements', () => {
  const plan = planSeries([measured(150), hi(600)]);
  assert.deepEqual(plan.scaleValues, [150, 600]);
  // Without the 600 the axis would top out near 150 and the HI mark would be drawn off
  // the top of the chart, where the reader cannot see it.
  assert.deepEqual(planBounds(plan), [600]);
});

test('two meters in one period produce two limits, not one', () => {
  const plan = planSeries([lo(20), lo(10), lo(20)]);
  assert.deepEqual(planBounds(plan), [20, 10]);
});

test('capping a crowded chart never drops the LO', () => {
  // Twice a day for three months, with one hypoglycaemic reading buried in the middle —
  // the exact case where an even subsample across the whole list would be free to throw
  // away the one mark that matters.
  const readings: Reading[] = [];
  for (let i = 0; i < 180; i += 1) readings.push(i === 91 ? lo(20) : measured(120 + (i % 40)));

  // The stand-in subsampler is deliberately the crudest possible: take the first N. If
  // the censored mark survived only because the real sampler happened to keep it, this
  // test would pass for the wrong reason.
  const plan = capPlan(planSeries(readings), 90, (items, max) => items.slice(0, max));
  assert.equal(plan.entries.length, 90);
  assert.equal(plan.censoredCount, 1);
  assert.equal(plan.entries.filter((entry) => entry.kind === 'censored').length, 1);
  assert.equal(plan.measuredCount, 89);
  // And the total on the page still reflects the whole period, not the sample.
  assert.equal(plan.undrawableCount, 0);
});

test('capping leaves a plan that already fits completely alone', () => {
  const plan = planSeries([measured(120), lo(20)]);
  assert.equal(capPlan(plan, 90, () => []), plan);
});

test('an exact reading with no number is neither drawn nor declared', () => {
  // A blood pressure that recorded no pulse is not a censored reading; there is simply
  // nothing in that field. Counting it as undrawable would put a sentence on the screen
  // about a reading the meter never refused.
  const plan = planSeries([{ v1: null, valueQualifier: 'exact', qualifierBound: null }]);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.undrawableCount, 0);
  assert.equal(plan.measuredCount, 0);
});
