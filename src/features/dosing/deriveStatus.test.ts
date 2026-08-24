/**
 * Tests for the one function that decides what happened to a dose.
 *
 * NOTE ON THE IMPORT BELOW: Node's type-stripping loader (`node --test
 * --experimental-strip-types`, see the `test` script in package.json) resolves only
 * fully-specified `./x.ts` paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`, so a static `from './deriveStatus.ts'` would run but
 * fail `tsc --noEmit`. Loading through a non-literal specifier and re-typing the
 * namespace satisfies both: the runtime gets the extension it needs, and the
 * compiler still checks every call below against the real module's types.
 * Collapse this to a plain static import the day that compiler option is turned on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DoseEvent, DoseEventKind, OccurrenceStatus } from '../../types';

const MODULE = './deriveStatus.ts';
const { deriveStatus, hasRecordedOutcome, snoozeTarget, OCCURRENCE_STATUS_COPY } = (await import(
  MODULE
)) as typeof import('./deriveStatus');

// A fixed, arbitrary wall of time. Nothing here reads the real clock.
const SCHEDULED = 1_770_000_000_000; // the dose's own moment
const BEFORE = SCHEDULED - 60_000;
const AFTER = SCHEDULED + 60_000;
const MUCH_LATER = SCHEDULED + 3_600_000;

let seq = 0;
function ev(
  event: DoseEventKind,
  atEpoch: number,
  payload: Record<string, unknown> | null = null,
): DoseEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    occurrenceId: 'occ-1',
    threadId: 'thread-1',
    medicineId: 'med-1',
    profileId: 'profile-1',
    event,
    atEpoch,
    localDate: '2026-02-02',
    payload,
    origin: 'app',
  };
}

function status(events: DoseEvent[], now: number): OccurrenceStatus {
  return deriveStatus(events, SCHEDULED, now);
}

// ── The two states with no events at all ─────────────────────────────────────

test('no events, scheduled moment still ahead → pending', () => {
  assert.equal(status([], BEFORE), 'pending');
});

test('no events, scheduled moment passed → no_record', () => {
  assert.equal(status([], AFTER), 'no_record');
});

test('exactly at the scheduled moment is no longer pending', () => {
  // `pending` means "not yet due". At the stroke of the hour it is due, and the
  // honest answer is that nothing has been recorded about it.
  assert.equal(status([], SCHEDULED), 'no_record');
});

// ── Inert events must not fabricate a record ─────────────────────────────────

test('a delivered notification is not a record of anything', () => {
  assert.equal(status([ev('delivered', SCHEDULED)], AFTER), 'no_record');
});

test('dismissing the notification is NOT taking the medicine', () => {
  // The single most important negative case in this file. Swiping a notification
  // away is housekeeping, not a clinical statement, and treating it as one would
  // invent a swallowed dose out of nothing.
  assert.equal(status([ev('dismissed', SCHEDULED)], AFTER), 'no_record');
});

test('rearmed and receiver_error are inert', () => {
  const events = [ev('rearmed', SCHEDULED), ev('receiver_error', SCHEDULED)];
  assert.equal(status(events, AFTER), 'no_record');
  assert.equal(status(events, BEFORE), 'pending');
});

// ── Positive and negative records ────────────────────────────────────────────

test('taken wins over the clock', () => {
  assert.equal(status([ev('taken', BEFORE)], AFTER), 'taken');
  assert.equal(status([ev('taken', BEFORE)], BEFORE), 'taken');
});

test('prn_taken reports as taken', () => {
  assert.equal(status([ev('prn_taken', AFTER)], MUCH_LATER), 'taken');
});

test('skipped is a record, and beats the clock', () => {
  assert.equal(status([ev('skipped', SCHEDULED)], AFTER), 'skipped');
  assert.equal(status([ev('skipped', BEFORE)], BEFORE), 'skipped');
});

// ── Precedence ───────────────────────────────────────────────────────────────

test('taken beats skipped regardless of which came first', () => {
  assert.equal(status([ev('skipped', BEFORE), ev('taken', AFTER)], MUCH_LATER), 'taken');
  assert.equal(status([ev('taken', BEFORE), ev('skipped', AFTER)], MUCH_LATER), 'taken');
});

test('cancelled beats everything, including taken', () => {
  assert.equal(status([ev('taken', BEFORE), ev('cancelled', AFTER)], MUCH_LATER), 'cancelled');
  assert.equal(status([ev('cancelled', BEFORE), ev('taken', AFTER)], MUCH_LATER), 'cancelled');
  assert.equal(status([ev('skipped', BEFORE), ev('cancelled', AFTER)], MUCH_LATER), 'cancelled');
});

test('cancelled alone is cancelled even before the scheduled moment', () => {
  assert.equal(status([ev('cancelled', BEFORE)], BEFORE), 'cancelled');
});

test('precedence does not depend on array order', () => {
  const events = [
    ev('delivered', BEFORE),
    ev('snoozed', BEFORE, { untilEpoch: MUCH_LATER }),
    ev('skipped', SCHEDULED),
    ev('taken', AFTER),
  ];
  const forwards = deriveStatus(events, SCHEDULED, MUCH_LATER);
  const backwards = deriveStatus([...events].reverse(), SCHEDULED, MUCH_LATER);
  assert.equal(forwards, 'taken');
  assert.equal(backwards, 'taken');
});

// ── Snooze ───────────────────────────────────────────────────────────────────

test('a snooze whose target is still ahead reads as snoozed', () => {
  const events = [ev('snoozed', SCHEDULED, { untilEpoch: MUCH_LATER })];
  assert.equal(status(events, AFTER), 'snoozed');
});

test('a lapsed snooze is not a state — it falls through to no_record', () => {
  const events = [ev('snoozed', SCHEDULED, { untilEpoch: AFTER })];
  assert.equal(status(events, MUCH_LATER), 'no_record');
});

test('a snooze target exactly equal to now has already lapsed', () => {
  const events = [ev('snoozed', SCHEDULED, { untilEpoch: AFTER })];
  assert.equal(status(events, AFTER), 'no_record');
});

test('a lapsed snooze on a dose that is still in the future is pending, not no_record', () => {
  const events = [ev('snoozed', SCHEDULED - 120_000, { untilEpoch: SCHEDULED - 90_000 })];
  assert.equal(status(events, BEFORE), 'pending');
});

test('only the most recent snooze counts', () => {
  // An early long snooze followed by a later short one must not keep the dose
  // parked: the patient's most recent instruction is the one that holds.
  const events = [
    ev('snoozed', BEFORE, { untilEpoch: MUCH_LATER }),
    ev('snoozed', SCHEDULED, { untilEpoch: AFTER }),
  ];
  assert.equal(status(events, MUCH_LATER - 1), 'no_record');
});

test('a later snooze can extend an earlier one', () => {
  const events = [
    ev('snoozed', BEFORE, { untilEpoch: SCHEDULED }),
    ev('snoozed', SCHEDULED, { untilEpoch: MUCH_LATER }),
  ];
  assert.equal(status(events, AFTER), 'snoozed');
});

test('taken after a snooze wins', () => {
  const events = [
    ev('snoozed', SCHEDULED, { untilEpoch: MUCH_LATER }),
    ev('taken', AFTER),
  ];
  assert.equal(status(events, AFTER), 'taken');
});

test('skipped after a snooze wins', () => {
  const events = [
    ev('snoozed', SCHEDULED, { untilEpoch: MUCH_LATER }),
    ev('skipped', AFTER),
  ];
  assert.equal(status(events, AFTER), 'skipped');
});

test('snoozeMinutes is accepted as a fallback for untilEpoch', () => {
  const events = [ev('snoozed', SCHEDULED, { snoozeMinutes: 30 })];
  assert.equal(status(events, SCHEDULED + 29 * 60_000), 'snoozed');
  assert.equal(status(events, SCHEDULED + 31 * 60_000), 'no_record');
});

test('an unparseable snooze payload degrades to surfacing the dose, never to hiding it', () => {
  for (const payload of [
    null,
    {},
    { untilEpoch: 'soon' },
    { untilEpoch: Number.NaN },
    { snoozeMinutes: -5 },
    { snoozeMinutes: 0 },
  ]) {
    const events = [ev('snoozed', SCHEDULED, payload as Record<string, unknown> | null)];
    assert.equal(
      status(events, AFTER),
      'no_record',
      `payload ${JSON.stringify(payload)} should not park the dose`,
    );
  }
});

test('snoozeTarget reads the canonical field first', () => {
  const both = ev('snoozed', SCHEDULED, { untilEpoch: MUCH_LATER, snoozeMinutes: 1 });
  assert.equal(snoozeTarget(both), MUCH_LATER);
  assert.equal(snoozeTarget(ev('snoozed', SCHEDULED, { snoozeMinutes: 10 })), SCHEDULED + 600_000);
  assert.equal(snoozeTarget(ev('snoozed', SCHEDULED)), null);
});

// ── hasRecordedOutcome ───────────────────────────────────────────────────────

test('hasRecordedOutcome is true only for an answer from the patient', () => {
  assert.equal(hasRecordedOutcome([]), false);
  assert.equal(hasRecordedOutcome([ev('delivered', SCHEDULED)]), false);
  assert.equal(hasRecordedOutcome([ev('dismissed', SCHEDULED)]), false);
  assert.equal(hasRecordedOutcome([ev('snoozed', SCHEDULED)]), false);
  assert.equal(hasRecordedOutcome([ev('cancelled', SCHEDULED)]), false);
  assert.equal(hasRecordedOutcome([ev('taken', SCHEDULED)]), true);
  assert.equal(hasRecordedOutcome([ev('skipped', SCHEDULED)]), true);
  assert.equal(hasRecordedOutcome([ev('prn_taken', SCHEDULED)]), true);
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('no_record is worded as an absence of information, not as a failure', () => {
  assert.equal(OCCURRENCE_STATUS_COPY.no_record.en, 'Not recorded as taken');
  for (const entry of Object.values(OCCURRENCE_STATUS_COPY)) {
    assert.doesNotMatch(
      entry.en,
      /miss|fail|forgot|late|bad|wrong/i,
      `status copy must not blame the patient: "${entry.en}"`,
    );
  }
});

test('every status has copy', () => {
  const all: OccurrenceStatus[] = [
    'pending',
    'taken',
    'skipped',
    'snoozed',
    'cancelled',
    'no_record',
  ];
  for (const s of all) {
    assert.ok(OCCURRENCE_STATUS_COPY[s], `missing copy for ${s}`);
    assert.ok(OCCURRENCE_STATUS_COPY[s].i18nKey.startsWith('dose.status.'));
  }
});
