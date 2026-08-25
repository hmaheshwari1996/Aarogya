/**
 * Tests for the pure multi-writer decisions: the LWW comparator, the dose_event union, and
 * the role matrix / online write-gate.
 *
 * These are the three things the task asks be proved without a device. Everything ELSE about
 * v2 — cross-device convergence, key wrap between two phones, push delivery, ring ownership —
 * is device-gated and cannot be unit-verified (see the contract §7 and the report). What is
 * provable is that the comparator both sides run agrees with itself, that a "taken" never
 * loses a merge, and that a viewer cannot write while a manager can only write online.
 *
 * On the dynamic import + `.ts` resolve hook: see `sync.test.ts` in this directory.
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

// Non-literal specifier so the type-stripping loader gets the extension while tsc does
// not reject it — same trick as deviceHorizon.test.ts / migrations.test.ts.
const MERGE_MODULE = './merge.ts';
const {
  canWriteNow,
  isReminderTable,
  mergeStrategyFor,
  normaliseRole,
  roleCapabilities,
  rowIsNewer,
} = (await import(MERGE_MODULE)) as typeof import('./merge');

// ── LWW comparator ─────────────────────────────────────────────────────────────

test('the higher millisecond wins, regardless of device', () => {
  assert.equal(rowIsNewer({ modifiedAtMs: 1000, deviceId: 'a' }, { modifiedAtMs: 999, deviceId: 'z' }), true);
  assert.equal(rowIsNewer({ modifiedAtMs: 999, deviceId: 'z' }, { modifiedAtMs: 1000, deviceId: 'a' }), false);
});

test('an exact-millisecond tie breaks on the lexically higher device_id', () => {
  assert.equal(rowIsNewer({ modifiedAtMs: 500, deviceId: 'b' }, { modifiedAtMs: 500, deviceId: 'a' }), true);
  assert.equal(rowIsNewer({ modifiedAtMs: 500, deviceId: 'a' }, { modifiedAtMs: 500, deviceId: 'b' }), false);
});

test('an identical stamp is NOT newer — re-delivering the winner changes nothing', () => {
  // The property that makes an incremental pull idempotent: the current winner arriving again
  // must not overwrite (and, on the relay, must not bump written_at_epoch into a loop).
  assert.equal(rowIsNewer({ modifiedAtMs: 500, deviceId: 'a' }, { modifiedAtMs: 500, deviceId: 'a' }), false);
});

test('the comparator is a total order — for any two distinct stamps exactly one is newer', () => {
  const stamps = [
    { modifiedAtMs: 1, deviceId: 'a' },
    { modifiedAtMs: 1, deviceId: 'b' },
    { modifiedAtMs: 2, deviceId: 'a' },
    { modifiedAtMs: 2, deviceId: 'b' },
  ];
  for (const x of stamps) {
    for (const y of stamps) {
      if (x === y) continue;
      // Exactly one direction holds — never both (would double-apply), never neither (would
      // strand a real edit). This is the convergence guarantee for two phones.
      assert.notEqual(rowIsNewer(x, y), rowIsNewer(y, x), `${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
  }
});

// ── Merge shape by table ────────────────────────────────────────────────────────

test('dose_event unions; every other table is last-write-wins', () => {
  assert.equal(mergeStrategyFor('dose_event'), 'union');
  for (const table of ['reading', 'symptom_event', 'lab_result', 'medicine', 'dose_schedule', 'document']) {
    assert.equal(mergeStrategyFor(table), 'lww', table);
  }
});

test('only medicine and dose_schedule are reminder tables (the C2 confirmed-gate)', () => {
  assert.equal(isReminderTable('medicine'), true);
  assert.equal(isReminderTable('dose_schedule'), true);
  for (const table of ['reading', 'symptom_event', 'lab_result', 'document', 'dose_event', 'visit_log']) {
    assert.equal(isReminderTable(table), false, table);
  }
});

// ── Roles ────────────────────────────────────────────────────────────────────

test('the online write-gate: owner always, manager only online, viewer never', () => {
  assert.equal(canWriteNow('owner', false), true);
  assert.equal(canWriteNow('owner', true), true);
  assert.equal(canWriteNow('manager', true), true);
  assert.equal(canWriteNow('manager', false), false);
  assert.equal(canWriteNow('viewer', true), false);
  assert.equal(canWriteNow('viewer', false), false);
});

test('role capabilities: only the owner rings and manages members; only a viewer cannot write', () => {
  assert.equal(roleCapabilities('owner').rings, true);
  assert.equal(roleCapabilities('owner').manageMembers, true);
  assert.equal(roleCapabilities('manager').rings, false);
  assert.equal(roleCapabilities('manager').manageMembers, false);
  assert.equal(roleCapabilities('manager').writeData, true);
  assert.equal(roleCapabilities('viewer').writeData, false);
  assert.equal(roleCapabilities('viewer').writeReminders, false);
  // Every role sees the full offline copy — that is the whole point of holding the key.
  for (const role of ['owner', 'manager', 'viewer'] as const) {
    assert.equal(roleCapabilities(role).see, true, role);
  }
});

test('a legacy patient role reads as owner; anything unknown fails closed to viewer', () => {
  assert.equal(normaliseRole('patient'), 'owner');
  assert.equal(normaliseRole('owner'), 'owner');
  assert.equal(normaliseRole('manager'), 'manager');
  assert.equal(normaliseRole('viewer'), 'viewer');
  assert.equal(normaliseRole(null), 'viewer');
  assert.equal(normaliseRole('something-from-a-newer-build'), 'viewer');
});
