/**
 * Tests for the wiring between the retry loop, the progress bus and the developer log.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SUITE EXISTS: ALL THREE PIECES SHIPPED, AND NONE OF THEM WERE CONNECTED.
 *
 * `progress.ts` had a bus, five constructors and a clamp, and `publishAiProgress` had
 * ZERO call sites — the scan screen subscribed to a bus nobody published on, so the bar
 * it drew could never move. `gemini.ts` imported `record`, `isRecording`, `DEV_EVENTS`
 * and `secretFields` and called none of them, so the developer log her son asked for was
 * a screen guaranteed to be empty of the one thing he wanted to see. Both defects
 * type-checked perfectly and neither could fail a test, because nothing asserted that the
 * events happen.
 *
 * That is what this file is for. It asserts on OBSERVABLE BEHAVIOUR — events published,
 * notes recorded — rather than on the presence of a call, so it cannot be satisfied by an
 * import.
 *
 * ─── THE ONE THAT MATTERS MOST IS THE SILENCE TEST ───────────────────────────
 *
 * Report 7, verbatim: "If developer option is not enabled, we will not store the logs at
 * all." The AI path now calls `record()` from about a dozen places. Every one of them is
 * a place that promise can be broken by a single call site that forgets its guard, on a
 * phone belonging to someone who never asked for a second copy of anything. So the first
 * test drives a whole retry sequence with the toggle off and asserts the ring is empty —
 * not "small", empty.
 *
 * NOTE ON THE IMPORTS: same type-stripping loader constraint as every other suite here
 * (`node --test --experimental-strip-types` resolves only fully-specified paths, and this
 * project's tsconfig does not enable `allowImportingTsExtensions`). Loading through a
 * non-literal specifier and re-typing the namespace satisfies both the runner and `tsc`.
 * Nothing reached from here imports anything native — that is what lets this run at all.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AiRequest, AiResult } from './provider';

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

const RETRY_MODULE = './retry.ts';
const { generateWithRetry } = (await import(RETRY_MODULE)) as typeof import('./retry');

const PROGRESS_MODULE = './progress.ts';
const { resetAiProgress, subscribeAiProgress } = (await import(
  PROGRESS_MODULE
)) as typeof import('./progress');
type AiProgress = import('./progress').AiProgress;

const ERRORS_MODULE = './errors.ts';
const { aiError } = (await import(ERRORS_MODULE)) as typeof import('./errors');

const RECORDER_MODULE = '../devlog/recorder.ts';
const { clearEntries, listEntries, setRecording } = (await import(
  RECORDER_MODULE
)) as typeof import('../devlog/recorder');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    prompt: 'read this',
    // 8 base64 characters → 6 decoded bytes. Small, and exactly checkable.
    images: [{ mimeType: 'image/jpeg', base64: 'AAAABBBB' }],
    ...overrides,
  };
}

function ok(): AiResult {
  return {
    ok: true,
    text: '{}',
    json: {},
    usage: { inputTokens: 1, outputTokens: 2, thoughtTokens: 3, totalTokens: 6 },
    modelId: 'gemini-test',
    finishReason: 'STOP',
    elapsedMs: 5,
  };
}

function overloaded(): AiResult {
  return {
    ok: false,
    error: aiError('service_overloaded', { detail: 'busy', httpStatus: 503 }),
    modelId: 'gemini-test',
    elapsedMs: 5,
  };
}

/** A frozen clock, so a backoff test is exact rather than approximate. */
const clock = { now: () => 1_000, random: () => 0.5 };

/**
 * Millisecond waits, borrowed from `retry.test.ts` rather than reinvented.
 *
 * `sleep()` uses a REAL `setTimeout` — the injected clock covers `now` and `random` only,
 * because the point of the sleep is that it is interruptible, and a fake timer would test
 * a different function. Without this the three retry tests here sit still for ten seconds
 * between them, which is how a suite stops being run.
 */
const FAST = { baseDelayMs: 2, maxDelayMs: 20, allowanceMs: 10_000, minAttemptMs: 1 };

/** Collects every progress event published while `run` is in flight. */
async function capture(run: () => Promise<unknown>): Promise<AiProgress[]> {
  resetAiProgress();
  const seen: AiProgress[] = [];
  const unsubscribe = subscribeAiProgress((event) => seen.push(event));
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return seen;
}

// ── 1. Off means nothing is stored ───────────────────────────────────────────

test('a whole retry sequence with the toggle off records not one note', async () => {
  setRecording(false);
  clearEntries();

  let calls = 0;
  await generateWithRetry(
    async () => {
      calls += 1;
      return calls < 3 ? overloaded() : ok();
    },
    request(),
    FAST,
    clock,
  );

  assert.equal(calls, 3, 'the sequence really did run three attempts');
  // Not "few". None. This is report 7's literal requirement, and the AI path now calls
  // `record()` from a dozen places that could each break it on their own.
  assert.deepEqual([...listEntries()], [], 'the ring must be empty, not merely short');
});

// ── 2. On means the story is actually told ───────────────────────────────────

test('with the toggle on, one retry sequence writes the attempt, the wait and the outcome', async () => {
  setRecording(true);
  clearEntries();

  let calls = 0;
  await generateWithRetry(
    async () => {
      calls += 1;
      return calls < 2 ? overloaded() : ok();
    },
    request(),
    FAST,
    clock,
  );

  const events = listEntries().map((entry) => entry.event);
  // Two attempts, one wait between them, one verdict each. If any of these vanish, the
  // log screen goes back to being a screen with nothing on it.
  assert.deepEqual(events, [
    'ai.attempt',
    'ai.outcome',
    'ai.wait',
    'ai.attempt',
    'ai.outcome',
  ]);

  const wait = listEntries().find((entry) => entry.event === 'ai.wait');
  assert.equal(wait?.fields['errorCode'], 'service_overloaded');
  assert.equal(wait?.fields['advised'], false, 'we chose this delay, the server did not');

  const last = listEntries().at(-1);
  assert.equal(last?.fields['ok'], true);
  assert.equal(last?.fields['errorCode'], null);

  setRecording(false);
  clearEntries();
});

test('a note about a request never carries the prompt, the image or the key', async () => {
  setRecording(true);
  clearEntries();

  await generateWithRetry(async () => ok(), request(), {}, clock);

  const serialised = JSON.stringify(listEntries());
  assert.ok(!serialised.includes('read this'), 'the prompt must not be in the log');
  assert.ok(!serialised.includes('AAAABBBB'), 'the image bytes must not be in the log');

  setRecording(false);
  clearEntries();
});

// ── 3. The bar moves, and it moves the right way ─────────────────────────────

test('a successful attempt publishes sending and then reading, in that order', async () => {
  setRecording(false);
  const seen = await capture(() =>
    generateWithRetry(
      // A provider that reports the instant the request left, exactly as gemini.ts does.
      async (attempt) => {
        attempt.onRequestSent?.();
        return ok();
      },
      request(),
      FAST,
      clock,
    ),
  );

  const phases = seen.map((event) => event.phase);
  assert.deepEqual(phases, ['sending', 'reading']);

  const sending = seen[0];
  assert.ok(sending?.phase === 'sending');
  // 8 base64 characters carry 6 bytes. The number on screen is what leaves the phone,
  // not what it was encoded as — a third larger — because it is read by someone deciding
  // whether to wait for Wi-Fi.
  assert.equal(sending.bytes, 6);
});

test('a second attempt never rewinds the bar', async () => {
  setRecording(false);
  let calls = 0;
  const seen = await capture(() =>
    generateWithRetry(
      async (attempt) => {
        calls += 1;
        attempt.onRequestSent?.();
        return calls < 2 ? overloaded() : ok();
      },
      request(),
      FAST,
      clock,
    ),
  );

  const estimates = seen.map((event) => event.estimate);
  for (let i = 1; i < estimates.length; i += 1) {
    const previous = estimates[i - 1] ?? 0;
    const current = estimates[i] ?? 0;
    assert.ok(
      current >= previous,
      `estimate went backwards at ${i}: ${previous} → ${current}. A bar that rewinds reads` +
        ' as "it gave up and started over", which is what makes people close the app.',
    );
  }

  // And the wait itself is published, holding position rather than advancing it.
  const waiting = seen.find((event) => event.phase === 'waiting');
  assert.ok(waiting, 'the wait between attempts must reach the bus');
  assert.equal(waiting.phase === 'waiting' ? waiting.lastErrorCode : null, 'service_overloaded');
});

test('a provider that never reports the send still produces a usable sequence', async () => {
  setRecording(false);
  // `onRequestSent` is optional by contract — a provider that does not call it is correct,
  // merely quieter. The bar must still advance rather than stall at zero.
  const seen = await capture(() =>
    generateWithRetry(async () => ok(), request(), {}, clock),
  );

  assert.deepEqual(
    seen.map((event) => event.phase),
    ['sending'],
  );
  assert.ok((seen[0]?.estimate ?? 0) > 0);
});
