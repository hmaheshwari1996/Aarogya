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
const { buildDeviceHorizon, DEVICE_HORIZON_PROFILE_ID, toQuietRules } = (await import(
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

// ── Shared profiles: exactly one phone rings ────────────────────────────────────────────
// LOCKED (docs/MULTI-DEVICE-SYNC-DESIGN.md "Reminders"): the owner phone rings; managers and
// viewers get "push only, never a local alarm" (task C3). The DROP happens in the db-half
// `publishDeviceHorizon` (it skips profiles not in `listOwnedProfileIds`), which the
// type-stripping runner cannot load — so what stays provable here is the pure union that a
// horizon built from ONLY the owned profiles' rules carries exactly those rules and no others.
// A member's rules never reach `buildDeviceHorizon`, so they can never appear in the horizon.

test('the horizon carries exactly the rules it is given — owned profiles only, nothing injected', () => {
  // The db-half passes ONLY owned profiles' rules; a member profile contributes an empty slot
  // or is absent. Either way the union is exactly the owner's rules — no quiet member copy.
  const ownedGran: AlarmRule[] = [rule('gran')];
  const horizon = buildDeviceHorizon(1_000, [ownedGran, []]);
  const threads = horizon.rules.map((r) => r.threadId);
  assert.deepEqual(threads, ['gran']);
  // The owned dose is untouched — same channel/criticality it was authored with.
  assert.equal(horizon.rules[0]?.channelId, 'dose_standard_v1');
});

// ── Shared profiles: exactly one phone rings ────────────────────────────────────────────
// These exist because this behaviour was ONCE REGRESSED: a later pass reverted the horizon to
// dropping non-owned profiles entirely, on the assumption that a push would tell those phones
// instead. There is no push (expo-notifications is removed and banned), so that silently left a
// family member with no reminder at all. Ringing is decided by
// `critical || channelId != 'dose_low_v1'`, so BOTH halves have to be cleared.

test('a non-owner device gets the dose on the QUIET channel — it must not ring', () => {
  const critical: AlarmRule = {
    threadId: 't-tb', medicineId: 'm1', title: 'x', body: 'y',
    timeLocal: '20:00', daysMask: 127, intervalDays: 1,
    startedOn: '2026-01-01', stoppedOn: null,
    channelId: 'dose_critical_v1', critical: true, escalateAfterMin: [15, 30],
  };
  const [quiet] = toQuietRules([critical]);
  assert.ok(quiet);
  assert.equal(quiet.channelId, 'dose_low_v1');
  assert.equal(quiet.critical, false);
  assert.deepEqual(quiet.escalateAfterMin, []);
  // The dose itself is unchanged — same medicine, same minute.
  assert.equal(quiet.timeLocal, '20:00');
  assert.equal(quiet.threadId, 't-tb');
});

test('toQuietRules does not mutate the owner rules it was handed', () => {
  const rule: AlarmRule = {
    threadId: 't1', medicineId: 'm1', title: 'x', body: 'y',
    timeLocal: '08:00', daysMask: 127, intervalDays: 1,
    startedOn: '2026-01-01', stoppedOn: null,
    channelId: 'dose_critical_v1', critical: true, escalateAfterMin: [15],
  };
  toQuietRules([rule]);
  // One phone is usually OWNER of one profile and member of another; a mutating transform
  // would silence the patient's own phone as a side effect of syncing someone else's.
  assert.equal(rule.channelId, 'dose_critical_v1');
  assert.equal(rule.critical, true);
  assert.deepEqual(rule.escalateAfterMin, [15]);
});

test('one horizon carries the owner\'s loud dose and a member\'s quiet one at once', () => {
  const base = {
    medicineId: 'm', title: 't', body: 'b', timeLocal: '20:00',
    daysMask: 127, intervalDays: 1, startedOn: '2026-01-01', stoppedOn: null,
    escalateAfterMin: [15],
  };
  const owned: AlarmRule[] = [{ ...base, threadId: 'gran', channelId: 'dose_critical_v1', critical: true }];
  const member: AlarmRule[] = [{ ...base, threadId: 'mum', channelId: 'dose_critical_v1', critical: true }];

  const horizon = buildDeviceHorizon(1_000, [owned, toQuietRules(member)]);
  const gran = horizon.rules.find((r) => r.threadId === 'gran');
  const mum = horizon.rules.find((r) => r.threadId === 'mum');
  assert.ok(gran);
  assert.ok(mum);

  assert.equal(gran.critical, true);              // owned → rings
  assert.equal(mum.channelId, 'dose_low_v1');      // member → silent
  assert.equal(mum.critical, false);
  assert.equal(mum.timeLocal, '20:00');            // …but still reminded, at the same minute
});

