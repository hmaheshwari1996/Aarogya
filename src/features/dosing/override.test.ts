/**
 * R2 — the per-day override must MOVE exactly one occurrence and never let the original
 * ring as well. The structural "one row, not two" half is guaranteed by the occurrence id
 * (the override rides the slot-time id, so buildCandidates matches it rather than minting a
 * second row) and is asserted at the DB layer. What THIS file guards is the half that a
 * later edit to reconcile could quietly drop: that the moved dose stays moved.
 *
 * The failure it fails on: someone removes the override handling from `reconcile`, so the
 * next foreground recomputes the epoch from the slot time and an 08:00 dose she moved to
 * 10:00 snaps back to 08:00. `effectiveScheduledEpoch` is exactly that decision, extracted
 * so it is loadable here — reconcile itself imports SQLite and cannot be.
 *
 * On the resolver hook and the dynamic import: Node's ESM loader does not resolve the
 * extensionless `../../lib/datetime` that `override.ts` imports, and this project cannot use
 * '.ts' specifiers in source (`allowImportingTsExtensions` is off). Same trick as
 * `features/care/calendar.test.ts`: teach the resolver the one extension it is missing, here,
 * and nothing in the app changes.
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

const OVERRIDE = './override.ts';
const DATETIME = '../../lib/datetime.ts';

const { effectiveScheduledEpoch } = (await import(OVERRIDE)) as typeof import('./override');
const { wallClockToEpoch } = (await import(DATETIME)) as typeof import('../../lib/datetime');

const DATE = '2026-08-24';
const SLOT_EPOCH = wallClockToEpoch(DATE, '08:00');

test('no override → the slot epoch stands unchanged', () => {
  assert.equal(effectiveScheduledEpoch(DATE, null, SLOT_EPOCH), SLOT_EPOCH);
});

test('an override moves the dose to the new time, never the slot time', () => {
  const moved = effectiveScheduledEpoch(DATE, '10:00', SLOT_EPOCH);
  assert.equal(moved, wallClockToEpoch(DATE, '10:00'));
  // The R2 bug this whole path exists to prevent: reconcile resetting 10:00 back to 08:00.
  assert.notEqual(moved, SLOT_EPOCH);
});

test('the override is resolved against the occurrence own local date', () => {
  // A dose two days back keeps its own date — the override is not silently reanchored to
  // today, or a catch-up card would show it at the wrong moment.
  const past = '2026-08-22';
  assert.equal(
    effectiveScheduledEpoch(past, '21:30', wallClockToEpoch(past, '20:00')),
    wallClockToEpoch(past, '21:30'),
  );
});
