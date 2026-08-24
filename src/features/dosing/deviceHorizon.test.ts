/**
 * The R1 device-horizon union, proved without a database.
 *
 * The medical property: a horizon built for a device carries EVERY profile's rules, so
 * switching which profile is on screen cannot drop another profile's TB dose. This pins the
 * union so a regression back to a single profile's rules fails here rather than on her phone.
 *
 * `deviceHorizon.ts` top-level-imports only types, so it loads under the type-stripping
 * runner. The db half (`publishDeviceHorizon`) is dynamic-imported at call time and is not
 * exercised here — this is the pure decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AlarmRule } from '../../types';

// Non-literal specifier so the type-stripping loader gets the extension while tsc does not
// reject it — same trick as profileArchive.test.ts / migrations.test.ts.
const MODULE = './deviceHorizon.ts';
const { buildDeviceHorizon, DEVICE_HORIZON_PROFILE_ID } = (await import(
  MODULE
)) as typeof import('./deviceHorizon');

function rule(threadId: string): AlarmRule {
  return {
    threadId,
    medicineId: `${threadId}-med`,
    title: threadId,
    body: '',
    timeLocal: '08:00',
    daysMask: 0b1111111,
    intervalDays: 1,
    startedOn: '2026-01-01',
    stoppedOn: null,
    channelId: 'dose_standard_v1',
    critical: false,
    escalateAfterMin: [],
  };
}

test('both profiles ring — the union carries every profile’s rules (R1)', () => {
  const mother = [rule('tb-isoniazid'), rule('metformin')];
  const grandmother = [rule('amlodipine')];

  const horizon = buildDeviceHorizon(1000, [mother, grandmother]);

  const threads = horizon.rules.map((r) => r.threadId);
  // The TB dose must survive alongside the newly-added patient's rule.
  assert.ok(threads.includes('tb-isoniazid'), 'mother’s TB rule dropped from the device horizon');
  assert.ok(threads.includes('amlodipine'), 'grandmother’s rule dropped from the device horizon');
  assert.equal(horizon.rules.length, 3);
});

test('the horizon is device-wide, not scoped to any one profile', () => {
  const horizon = buildDeviceHorizon(1000, [[rule('a')], [rule('b')]]);
  assert.equal(horizon.profileId, DEVICE_HORIZON_PROFILE_ID);
  assert.equal(horizon.schemaVersion, 1);
  assert.equal(horizon.writtenAtEpoch, 1000);
});

test('no profiles (a fresh viewer-only device) is a valid empty horizon, never a throw', () => {
  const horizon = buildDeviceHorizon(1000, []);
  assert.deepEqual(horizon.rules, []);
});

test('buildDeviceHorizon carries per-date ring moves through unchanged (per-day override)', () => {
  const ex = [{ threadId: 't1', localDate: '2026-08-25', timeLocal: '08:00', overrideTimeLocal: '10:00' }];
  const h = buildDeviceHorizon(1_000, [[]], ex);
  assert.equal(h.exceptions.length, 1);
  assert.deepEqual(h.exceptions[0], ex[0]);
});

test('buildDeviceHorizon defaults to an empty exceptions list — the native no-op path', () => {
  const h = buildDeviceHorizon(1_000, [[]]);
  assert.deepEqual(h.exceptions, []);
});
