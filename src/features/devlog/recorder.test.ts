/**
 * Tests for the two promises the recorder makes to the person whose phone this is.
 *
 *   1. OFF MEANS NOTHING IS STORED. Her son's words, and the reason the ring is empty and
 *      the thunk is never invoked rather than merely "the screen is hidden".
 *   2. IT CANNOT GROW WITHOUT BOUND. A debug log that fills a 2 GB phone is a worse bug
 *      than the one it was added to find.
 *
 * The third promise — redaction — has its own file, because it is organised by forbidden
 * class rather than by function. See `redact.test.ts`.
 *
 * NOTE ON THE IMPORT: same type-stripping loader constraint as every other suite here.
 * The module under test deliberately imports nothing native, which is what lets this run
 * in a plain `node --test` process at all.
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

const MODULE = './recorder.ts';
const {
  MAX_BYTES,
  MAX_ENTRIES,
  beginRun,
  clearEntries,
  devLogStats,
  endRun,
  formatEntries,
  fromNdjson,
  isRecording,
  listEntries,
  record,
  seedEntries,
  setRecording,
  subscribeDevLog,
  toNdjson,
} = (await import(MODULE)) as typeof import('./recorder');

const EVENTS_MODULE = './types.ts';
const { DEV_EVENTS } = (await import(EVENTS_MODULE)) as typeof import('./types');

/** The module is a singleton by design, so every test starts from a known state. */
function reset(on: boolean): void {
  setRecording(false);
  clearEntries();
  setRecording(on);
}

// ── Promise 1: off means nothing is stored ───────────────────────────────────

test('with the toggle off nothing is stored, and the field bag is never even built', () => {
  reset(false);
  assert.equal(isRecording(), false);

  let thunkCalls = 0;
  for (let i = 0; i < 50; i += 1) {
    record('error', 'ai', DEV_EVENTS.aiHttp, () => {
      thunkCalls += 1;
      return { httpStatus: 500 };
    });
  }

  assert.equal(listEntries().length, 0, 'a note was stored with the toggle off');
  assert.equal(thunkCalls, 0, 'the field bag was built for a note that was never kept');
  assert.equal(devLogStats().approxBytes, 0);
  assert.equal(toNdjson(), '', 'there is nothing to write to a file');
});

test('a run cannot be opened while off, so nothing can be grouped into one either', () => {
  reset(false);
  const id = beginRun('scan');
  assert.equal(id, '');
  assert.equal(listEntries().length, 0);
});

test('turning it off empties the ring in the same tick — not "from now on"', () => {
  reset(true);
  record('info', 'ai', DEV_EVENTS.aiRequest, { httpStatus: 200 });
  assert.equal(listEntries().length, 1);

  setRecording(false);
  assert.equal(listEntries().length, 0, 'notes survived the toggle being turned off');
  assert.equal(devLogStats().approxBytes, 0);
});

test('turning it back on starts from empty rather than resurrecting anything', () => {
  reset(true);
  record('info', 'ai', DEV_EVENTS.aiRequest, { httpStatus: 200 });
  setRecording(false);
  setRecording(true);
  assert.equal(listEntries().length, 0);
});

test('a seed from a previous launch is refused while off — "not stored at all" survives a restart', () => {
  reset(true);
  record('info', 'ai', DEV_EVENTS.aiRequest, { httpStatus: 200 });
  const previous = [...listEntries()];

  reset(false);
  seedEntries(previous);
  assert.equal(listEntries().length, 0);

  // …and accepted when on, oldest first, because that is when they happened.
  reset(true);
  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 503 });
  seedEntries(previous);
  const list = listEntries();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.event, DEV_EVENTS.aiRequest, 'the previous launch must sort first');
  assert.equal(list[1]?.event, DEV_EVENTS.aiHttp);
});

// ── Promise 2: it cannot grow without bound ──────────────────────────────────

test('the entry cap evicts the oldest and keeps the newest', () => {
  reset(true);
  for (let i = 0; i < MAX_ENTRIES + 120; i += 1) {
    record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: i });
  }

  const list = listEntries();
  assert.equal(list.length, MAX_ENTRIES, `ring held ${list.length} entries`);
  // The newest survived…
  assert.equal(list[list.length - 1]?.fields['httpStatus'], MAX_ENTRIES + 119);
  // …and the oldest did not.
  assert.equal(list[0]?.fields['httpStatus'], 120);
});

test('the byte cap evicts too, even when the entry count is nowhere near its own cap', () => {
  reset(true);
  // Google error messages are the fat field in practice, so the fat field is what this
  // uses — several of them per note, so the ring runs out of BYTES a long way before it
  // runs out of entries. That is the case the second cap exists for: 400 notes is a
  // harmless number until each one is carrying a paragraph.
  const fat = 'quota exceeded for this project, '.repeat(20);
  for (let i = 0; i < MAX_ENTRIES; i += 1) {
    record('warn', 'ai', DEV_EVENTS.aiHttp, {
      apiMessage: fat,
      errorMessage: fat,
      stackTop: fat,
      topKeys: fat,
      arrayCounts: fat,
      httpStatus: i,
    });
  }

  const stats = devLogStats();
  assert.ok(stats.approxBytes <= MAX_BYTES, `ring held ${stats.approxBytes} bytes`);
  assert.ok(stats.count < MAX_ENTRIES, 'the byte cap should have bitten before the entry cap');
  assert.ok(stats.count > 0, 'the byte cap must not empty the ring');
  // Still the newest that survived.
  assert.equal(listEntries()[listEntries().length - 1]?.fields['httpStatus'], MAX_ENTRIES - 1);
});

test('the byte accounting stays honest across evictions rather than drifting upward', () => {
  reset(true);
  for (let i = 0; i < MAX_ENTRIES * 2; i += 1) {
    record('info', 'ai', DEV_EVENTS.aiHttp, { apiMessage: 'y'.repeat(200), httpStatus: i });
  }
  const measured = toNdjson().length;
  const claimed = devLogStats().approxBytes;
  // One byte per entry of newline slack, which is what `sizeOf` adds.
  assert.ok(
    Math.abs(measured - claimed) <= listEntries().length + 1,
    `claimed ${claimed} bytes, measured ${measured}`,
  );
});

// ── Grouping, so fifteen lines read as one story ─────────────────────────────

test('every note in a run carries the same id, and the id is not any row id', () => {
  reset(true);
  const id = beginRun('scan');
  record('info', 'ai', DEV_EVENTS.aiRequest, { httpStatus: 0 });
  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 200 });
  endRun(id);

  const inRun = listEntries().filter((entry) => entry.runId === id);
  assert.equal(inRun.length, 4, 'run.start, two notes, run.end');
  assert.ok(id.length <= 8, 'a run id is short and disposable');
  assert.doesNotMatch(id, /-/, 'a run id must not look like, or be, a UUID row id');

  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 204 });
  assert.equal(listEntries()[listEntries().length - 1]?.runId, null, 'the run was closed');
});

test('a nested run does not split one scan in two', () => {
  reset(true);
  const outer = beginRun('scan');
  const inner = beginRun('request');
  assert.equal(inner, outer);

  // The inner id is the outer id, so an inner `endRun` closes the outer run exactly once
  // and a second call is a no-op rather than a second run.end note.
  endRun(inner);
  const notes = listEntries().filter((entry) => entry.event === DEV_EVENTS.runEnd);
  assert.equal(notes.length, 1);
});

// ── Everything else that must not throw ──────────────────────────────────────

test('a thunk that throws loses its own note and nothing else', () => {
  reset(true);
  record('info', 'ai', DEV_EVENTS.aiRequest, () => {
    throw new Error('the caller built its fields badly');
  });
  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 200 });
  assert.equal(listEntries().length, 1);
  assert.equal(listEntries()[0]?.event, DEV_EVENTS.aiHttp);
});

test('a subscriber that throws does not stop the next note', () => {
  reset(true);
  const unsubscribe = subscribeDevLog(() => {
    throw new Error('a screen mid-unmount');
  });
  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 200 });
  record('info', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 201 });
  unsubscribe();
  assert.equal(listEntries().length, 2);
});

test('a file written by this build reads back as the same notes', () => {
  reset(true);
  record('warn', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 429, apiStatus: 'RESOURCE_EXHAUSTED' });
  const round = fromNdjson(toNdjson());
  assert.equal(round.length, 1);
  assert.equal(round[0]?.fields['httpStatus'], 429);
  assert.equal(round[0]?.fields['apiStatus'], 'RESOURCE_EXHAUSTED');
});

test('a corrupt or half-written file degrades to the lines that are readable', () => {
  const text = ['not json at all', '{"level":"info"}', '{"broken":', ''].join('\n');
  assert.deepEqual(fromNdjson(text), []);
});

test('a note read back from an older build is put through TODAY\'s redaction rules', () => {
  // The rules will be tightened. A file written last month must not walk past them.
  const smuggled = JSON.stringify({
    seq: 1,
    ts: Date.now(),
    level: 'info',
    category: 'ai',
    event: DEV_EVENTS.aiParse,
    runId: 'r1abcd',
    fields: { medicineName: 'Rifampicin', httpStatus: 200 },
  });
  const [entry] = fromNdjson(smuggled);
  assert.equal(entry?.fields['medicineName'], '[blocked]');
  assert.equal(entry?.fields['httpStatus'], 200);
});

test('the shared text is one readable line per note and carries no raw objects', () => {
  reset(true);
  record('error', 'ai', DEV_EVENTS.aiHttp, { httpStatus: 403, apiStatus: 'PERMISSION_DENIED' });
  const text = formatEntries();
  assert.match(text, /ERROR/);
  assert.match(text, /ai\.http/);
  assert.match(text, /httpStatus=403/);
  assert.match(text, /apiStatus=PERMISSION_DENIED/);
  assert.equal(text.split('\n').length, 1);
});
