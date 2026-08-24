/**
 * Tests for the Trends axis arithmetic.
 *
 * ─── WHY IT IS HERE AND NOT NEXT TO ITS SUBJECT ──────────────────────────────
 *
 * NOTHING THAT IS NOT A ROUTE MAY LIVE UNDER `src/app/`. Expo Router builds the
 * route table from `require.context(APP_ROOT, true, /…\.[tj]sx?$/)`, and that
 * pattern has no opinion about `.test.` — every `.ts` file under `src/app/` is
 * bundled into the app and evaluated at startup as a route module.
 *
 * This file therefore cannot sit beside `trends.tsx`, even though that is where
 * it belongs. It uses `import.meta.dirname` and imports `node:fs`, and Metro
 * bundling it broke the Android build outright:
 *
 *   Android Bundling failed  node_modules/expo-router/entry.js
 *   SyntaxError: src/app/(tabs)/trends.test.ts:
 *     `import.meta` is not supported in Hermes.
 *
 * No unit test, type check or lint rule catches that — `npx expo export` does,
 * and it is the only thing that does. `npm test` globs `src/**` and finds this
 * file perfectly well from here, which is where every other test already lives.
 *
 * ─── WHY THIS FILE READS ITS SUBJECT OFF DISK ────────────────────────────────
 *
 * `buildAxis` lives in `trends.tsx` and cannot be imported from here. Two
 * independent reasons, either one of which is fatal:
 *
 *   1. The test runner is `node --test --experimental-strip-types`, and Node's
 *      type stripping does not parse JSX. A `.tsx` file cannot be loaded at all.
 *   2. Even if it could, evaluating that module pulls in react-native,
 *      expo-router, expo-sqlite and a charting library, none of which exist
 *      outside a device.
 *
 * Moving `buildAxis` to its own `.ts` module would solve both, and is the right
 * answer the next time this file grows a second function worth testing. It was
 * not done here because this pass owns exactly two files.
 *
 * So instead of a COPY — which is the thing the brief allows as a last resort,
 * and which rots the first time someone edits the real function — this reads the
 * region between the `@axis-block` markers out of `trends.tsx`, writes it to a
 * temporary `.ts` file, and imports THAT. What runs below is the shipping
 * implementation, byte for byte. If the markers are ever removed or the block
 * stops being self-contained, this file fails loudly at load with a message
 * saying so, rather than quietly testing a stale duplicate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Axis = { maxValue: number; stepValue: number; noOfSections: number };
type BuildAxis = (values: readonly number[], extra?: readonly number[]) => Axis;

const SOURCE = path.join(import.meta.dirname, '..', '..', 'app', '(tabs)', 'trends.tsx');
const START = '@axis-block:start';
const END = '@axis-block:end';

function extractAxisBlock(): string {
  const text = fs.readFileSync(SOURCE, 'utf8');
  const startAt = text.indexOf(START);
  const endAt = text.indexOf(END);
  if (startAt === -1 || endAt <= startAt) {
    throw new Error(
      `Could not find the ${START} / ${END} markers in ${SOURCE}. ` +
        'They delimit the code this file tests; restore them, or move buildAxis into ' +
        'its own .ts module and import it directly.',
    );
  }
  // From the end of the opening marker comment to the start of the closing one.
  const bodyStart = text.indexOf('*/', startAt) + 2;
  const bodyEnd = text.lastIndexOf('/*', endAt);
  const block = text.slice(bodyStart, bodyEnd);
  if (!block.includes('function buildAxis')) {
    throw new Error(`The ${START} block in ${SOURCE} no longer contains buildAxis.`);
  }
  if (/^\s*import\s/m.test(block)) {
    throw new Error(
      `The ${START} block in ${SOURCE} has grown an import and is no longer ` +
        'self-contained, so it can no longer be lifted out and executed on its own.',
    );
  }
  return block;
}

const temporary = path.join(
  os.tmpdir(),
  `aarogya-trends-axis-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
);
fs.writeFileSync(temporary, `${extractAxisBlock()}\nexport { buildAxis };\n`, 'utf8');
const { buildAxis } = (await import(pathToFileURL(temporary).href)) as { buildAxis: BuildAxis };
fs.rmSync(temporary, { force: true });

// ─────────────────────────────────────────────────────────────────────────────
// The invariants every axis must satisfy, whatever it was built from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asserted on the result of every single case below, because these are the four
 * things the chart library assumes and never checks. It divides by `stepValue`,
 * it multiplies coordinates by `maxValue`, and it builds one gridline per
 * section — so a zero step, a NaN max or a fractional section count does not
 * throw where it is created. It throws, or silently draws nothing, several
 * frames later inside an SVG path.
 */
function assertDrawable(axis: Axis, what: string): void {
  assert.ok(Number.isFinite(axis.maxValue), `${what}: maxValue must be finite, got ${axis.maxValue}`);
  assert.ok(Number.isFinite(axis.stepValue), `${what}: stepValue must be finite, got ${axis.stepValue}`);
  assert.ok(axis.stepValue > 0, `${what}: stepValue must be above zero, got ${axis.stepValue}`);
  assert.ok(
    Number.isInteger(axis.noOfSections) && axis.noOfSections > 0,
    `${what}: noOfSections must be a positive whole number, got ${axis.noOfSections}`,
  );
  assert.equal(
    axis.maxValue,
    axis.stepValue * axis.noOfSections,
    `${what}: the three fields must agree — the library derives the top rule from them`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The five cases named in the brief
// ─────────────────────────────────────────────────────────────────────────────

test('no data at all still yields a drawable axis', () => {
  const axis = buildAxis([]);
  assertDrawable(axis, 'empty');
  assert.equal(axis.stepValue, 1);
  assert.equal(axis.maxValue, 4);
});

test('every value zero is not an empty axis', () => {
  // The real case: every dose in the period was recorded as NOT taken, so every
  // bar is zero. The chart must still draw its rules and its labels — a blank
  // card would read as "no record", which is a different and untrue statement.
  const axis = buildAxis([0, 0, 0, 0, 0, 0, 0]);
  assertDrawable(axis, 'all zeros');
  assert.equal(axis.stepValue, 1);
  assert.equal(axis.maxValue, 4);
  assert.deepEqual(axis, buildAxis([]), 'all-zeros and empty should agree');
});

test('a single data point gets a scale that contains it', () => {
  const axis = buildAxis([78]);
  assertDrawable(axis, 'single point');
  assert.ok(axis.maxValue > 78, `78 must sit inside the chart, top rule was ${axis.maxValue}`);
});

test('one huge outlier does not produce Infinity or NaN', () => {
  const axis = buildAxis([96, 102, 98, 1_000_000_000]);
  assertDrawable(axis, 'outlier');
  assert.ok(axis.maxValue > 1_000_000_000);
});

test('an absurd value cannot overflow the axis to Infinity', () => {
  // Number.MAX_VALUE / 4, rounded up to the next power of ten, is Infinity. The
  // ceiling exists so a corrupt row cannot turn every coordinate on the chart
  // into NaN.
  for (const absurd of [Number.MAX_VALUE, 1e300, 1e15]) {
    assertDrawable(buildAxis([absurd]), `absurd ${absurd}`);
  }
});

test('a target bound above the data widens the axis to include it', () => {
  // A doctor's upper limit of 140 written against a period whose highest recorded
  // reading is 118. If the axis ignored the bound, the target line would be drawn
  // above the top of its own chart — invisible, and invisible in exactly the
  // direction that matters.
  const withoutTarget = buildAxis([112, 118, 104]);
  const withTarget = buildAxis([112, 118, 104], [140]);
  assertDrawable(withTarget, 'target bound');
  assert.ok(withTarget.maxValue > 140, `top rule ${withTarget.maxValue} must clear the bound`);
  assert.ok(withTarget.maxValue >= withoutTarget.maxValue);
});

// ─────────────────────────────────────────────────────────────────────────────
// The properties the charts depend on
// ─────────────────────────────────────────────────────────────────────────────

test('the top of the scale is strictly above the largest value', () => {
  // The regression this guards: with four fixed sections, `stepValue * 4` lands
  // EXACTLY on any peak divisible by four — 4 symptom reports, 8 doses, a
  // systolic of 120. A marker on the top rule is drawn half outside the plot, and
  // the symptom chart's count label, drawn past the end of its bar, is cut off.
  for (const peak of [1, 2, 4, 8, 12, 20, 40, 100, 120, 200, 400]) {
    const axis = buildAxis([peak]);
    assertDrawable(axis, `peak ${peak}`);
    assert.ok(axis.maxValue > peak, `peak ${peak} must sit below the top rule ${axis.maxValue}`);
  }
});

test('values that are not finite numbers are ignored, not propagated', () => {
  // One NaN reaching Math.max turns maxValue, stepValue and every plotted
  // coordinate into NaN, and nothing downstream throws where it could be found.
  const clean = buildAxis([110, 120, 118]);
  const dirty = buildAxis([110, Number.NaN, 120, Number.POSITIVE_INFINITY, 118]);
  assertDrawable(dirty, 'non-finite values');
  assert.deepEqual(dirty, clean);

  const dirtyBound = buildAxis([110, 120], [Number.NaN]);
  assertDrawable(dirtyBound, 'non-finite bound');
  assert.deepEqual(dirtyBound, buildAxis([110, 120]));
});

test('negative values never drag the scale below zero', () => {
  const axis = buildAxis([-40, -1, 0]);
  assertDrawable(axis, 'negatives');
  assert.equal(axis.maxValue, 4);
});

test('every value in a series ends up inside the chart', () => {
  const series: number[][] = [
    [62.4, 62.9, 61.8], // weight, a spread under one unit
    [96, 210, 143, 88], // glucose, fasting and after-meal in one series
    [110, 72, 128, 84, 119, 76], // both halves of a blood pressure, one axis
    [1, 1, 1, 1, 1, 1], // six symptoms reported once each
    [0, 3, 2, 0, 3, 3, 1], // doses recorded as taken, day by day
  ];
  for (const values of series) {
    const axis = buildAxis(values);
    assertDrawable(axis, JSON.stringify(values));
    for (const value of values) {
      assert.ok(value < axis.maxValue, `${value} must sit inside a top rule of ${axis.maxValue}`);
    }
  }
});

test('a long series is not spread onto the call stack', () => {
  // `capSeries` caps at 90 today, but the previous implementation passed the whole
  // series through `Math.max(1, ...values)`, which is an argument list and has an
  // engine limit. The loop that replaced it has none.
  const long = Array.from({ length: 200_000 }, (_, i) => i % 150);
  const axis = buildAxis(long);
  assertDrawable(axis, 'long series');
  assert.ok(axis.maxValue > 149);
});
