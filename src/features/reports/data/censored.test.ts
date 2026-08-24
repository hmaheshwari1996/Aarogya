/**
 * The censored-reading vocabulary, tested where it is cheapest to test.
 *
 * Everything in `./censored.ts` is pure and has no runtime imports, so it loads in the
 * Node type-stripping runner with no SQLite, no React and no device. The assertions that
 * matter are the NEGATIVE ones: that a bound never appears as a bare number, and that an
 * undecidable comparison stays undecidable rather than picking the convenient side.
 *
 * On the dynamic import and the resolver hook: Node's ESM resolver does not resolve
 * extensionless relative specifiers and this project cannot write '.ts' in source
 * (`allowImportingTsExtensions` is off), so `censored.ts` importing `../lib/format` the
 * way every other file does is unloadable here without help. The alternative would be a
 * second copy of `formatNumber` living inside `data/` purely so this file can load — and
 * a second number formatter is exactly the quiet divergence that puts '61.40' on one
 * surface and '61.4' on another. Same shape, and same reasoning, as
 * `src/features/care/calendar.test.ts`.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const MODULE = './censored.ts';
const {
  censoredDayCardText,
  censoredDirection,
  censoredUnitText,
  censoredValueText,
  censoredVsTarget,
  censoredVsValue,
  inequalityText,
  isCensored,
  meterWord,
  usableBound,
} = (await import(MODULE)) as typeof import('./censored');

test('censoredDirection maps the two meter states and nothing else', () => {
  assert.equal(censoredDirection('below_range'), 'below');
  assert.equal(censoredDirection('above_range'), 'above');
  assert.equal(censoredDirection('exact'), null);
  assert.equal(isCensored('exact'), false);
  assert.equal(isCensored('above_range'), true);
  assert.equal(meterWord('below'), 'LO');
  assert.equal(meterWord('above'), 'HI');
});

test('a bound that is not a real positive number is treated as no range recorded', () => {
  assert.equal(usableBound(20), true);
  assert.equal(usableBound(null), false);
  assert.equal(usableBound(0), false);
  assert.equal(usableBound(-5), false);
  assert.equal(usableBound(Number.NaN), false);
  assert.equal(usableBound(Number.POSITIVE_INFINITY), false);
});

test('the bound is always printed as an inequality, never as a bare number', () => {
  assert.equal(inequalityText('below', 20, 'mg/dL'), 'below 20 mg/dL');
  assert.equal(inequalityText('above', 600, 'mg/dL'), 'above 600 mg/dL');
  // No unit recorded: still an inequality, just without one.
  assert.equal(inequalityText('below', 20, ''), 'below 20');
  // No range recorded: nothing to assert, so nothing is asserted.
  assert.equal(inequalityText('below', null, 'mg/dL'), '');
});

test('the printed sentence names the meter and never stands as a measurement', () => {
  assert.equal(censoredValueText('below_range', 20, 'mg/dL'), 'Meter showed LO (below 20 mg/dL)');
  assert.equal(censoredValueText('above_range', 600, 'mg/dL'), 'Meter showed HI (above 600 mg/dL)');
  assert.equal(censoredValueText('below_range', null, 'mg/dL'), 'Meter showed LO');
  assert.equal(censoredValueText('exact', null, 'mg/dL'), null);

  assert.equal(censoredDayCardText('below_range', 20, 'mg/dL'), 'LO on the meter (below 20 mg/dL)');
  assert.equal(censoredDayCardText('above_range', null, 'mg/dL'), 'HI on the meter');
  assert.equal(censoredDayCardText('exact', 20, 'mg/dL'), null);

  // The property that matters more than any exact wording: whatever comes out, the bound
  // is never the whole of it.
  for (const text of [
    censoredValueText('below_range', 20, 'mg/dL'),
    censoredDayCardText('below_range', 20, 'mg/dL'),
  ]) {
    assert.notEqual(text, '20');
    assert.ok(text !== null && /below 20/.test(text));
  }
});

test('a unit column beside a censored value is empty, so the unit is printed once', () => {
  // The value cell already reads 'Meter showed LO (below 20 mg/dL)'. A unit column that
  // prints mg/dL again gives the OPD appendix a stutter in the row a doctor is sent to.
  assert.equal(censoredUnitText('below_range', 'mg/dL'), '');
  assert.equal(censoredUnitText('above_range', 'mg/dL'), '');
  // …and no range recorded does not change it: 'Meter showed LO mg/dL' is not a sentence
  // either, and there is still no number for the unit to belong to.
  assert.equal(censoredUnitText('below_range', ''), '');
  assert.equal(censoredUnitText('exact', 'mg/dL'), 'mg/dL');
});

test('censoredVsTarget only says "outside" when the record proves it', () => {
  // Meter floor 20, target floor 80: LO means v < 20 < 80. Proven.
  assert.equal(censoredVsTarget('below', 20, { low: 80, high: 180 }), 'outside');
  // Meter floor 20, target floor 10: v could be 15, which is inside the target. Not proven.
  assert.equal(censoredVsTarget('below', 20, { low: 10, high: 180 }), 'undecidable');
  // A target with no floor cannot be undercut.
  assert.equal(censoredVsTarget('below', 20, { low: null, high: 180 }), 'undecidable');
  // No meter range recorded — the app has no idea where the reading sits.
  assert.equal(censoredVsTarget('below', null, { low: 80, high: 180 }), 'undecidable');
  // No target at all. There is nothing to be outside of, which is the app's normal state.
  assert.equal(censoredVsTarget('below', 20, null), 'undecidable');

  // HI is the mirror image.
  assert.equal(censoredVsTarget('above', 600, { low: 80, high: 180 }), 'outside');
  assert.equal(censoredVsTarget('above', 600, { low: 80, high: 900 }), 'undecidable');
  assert.equal(censoredVsTarget('above', 600, { low: 80, high: null }), 'undecidable');

  // Exactly on the bound counts: LO with floor 80 against a target floor of 80 means
  // v < 80, which is outside a range that starts AT 80.
  assert.equal(censoredVsTarget('below', 80, { low: 80, high: 180 }), 'outside');
});

test('censoredVsValue proves a direction or refuses to name one', () => {
  // LO (< 20) against a measured 180: provably the lower of the two.
  assert.equal(censoredVsValue('below', 20, 180), 'lower');
  // LO (< 20) against a measured 15: the true value could be above or below 15.
  assert.equal(censoredVsValue('below', 20, 15), 'undecidable');
  assert.equal(censoredVsValue('below', null, 180), 'undecidable');
  // HI (> 600) against a measured 150: provably the higher.
  assert.equal(censoredVsValue('above', 600, 150), 'higher');
  assert.equal(censoredVsValue('above', 600, 700), 'undecidable');
  assert.equal(censoredVsValue('below', 20, Number.NaN), 'undecidable');
});
