/**
 * Tests for the retry policy: what is asked again, how long she waits, and what happens
 * the moment she leaves.
 *
 * NOTE ON THE IMPORT BELOW: Node's type-stripping loader (`node --test
 * --experimental-strip-types`, see the `test` script in package.json) resolves only
 * fully-specified `./x.ts` paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`, so a static `from './retry.ts'` would run but fail
 * `tsc --noEmit`. Loading through a non-literal specifier and re-typing the namespace
 * satisfies both. Collapse it to a plain static import the day that option is turned on.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE CLOCK. `generateWithRetry` takes an injected
 * `{ now, random }` precisely so these assertions can be exact rather than approximate —
 * a backoff test written against the real clock is a flaky test, and a flaky test in a
 * medicines app is one people learn to re-run instead of read.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AiRequest, AiResult } from './provider';

// The module under test imports `./errors` without an extension, which the ESM loader
// cannot resolve on its own. Same hook as features/backup/capsule.test.ts — appended, not
// invented here, so both suites keep failing and passing for the same reasons.
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
const {
  DEFAULT_RETRY_POLICY,
  RETRYABLE_CODES,
  generateWithRetry,
  isRetryable,
  nextDelayMs,
  parseRetryAfterMs,
  sleep,
} = (await import(RETRY_MODULE)) as typeof import('./retry');

const ERRORS_MODULE = './errors.ts';
const { AI_ERROR_CODES, aiError } = (await import(ERRORS_MODULE)) as typeof import('./errors');

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A request carrying an "image" whose identity we can assert is never rebuilt. */
function request(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    prompt: 'read this',
    images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
    ...overrides,
  };
}

function failure(
  code: Parameters<typeof aiError>[0],
  options: Parameters<typeof aiError>[1] = {},
): AiResult {
  return { ok: false, error: aiError(code, options), modelId: 'model-x', elapsedMs: 5 };
}

function success(): AiResult {
  return {
    ok: true,
    text: '{}',
    json: {},
    usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 },
    modelId: 'model-x',
    finishReason: 'STOP',
    elapsedMs: 5,
  };
}

/**
 * A fake clock that advances only when the code under test would actually wait.
 *
 * `sleep` is real (it is the thing being tested for interruptibility), so the delays the
 * policy produces are scaled down to single-digit milliseconds by shrinking the policy, not
 * by faking timers. `now` is a counter the test drives, which keeps the deadline arithmetic
 * deterministic.
 */
function clock(random = 1): { now: () => number; random: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    random: () => random,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Collects every attempt, so a failing test says WHICH call went wrong. */
function recorder(results: AiResult[]) {
  const seen: AiRequest[] = [];
  let index = 0;
  return {
    seen,
    generate: async (r: AiRequest): Promise<AiResult> => {
      seen.push(r);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result ?? failure('unknown');
    },
  };
}

/** Small enough that the whole suite runs in a few milliseconds of real waiting. */
const FAST = { baseDelayMs: 2, maxDelayMs: 20, allowanceMs: 10_000, minAttemptMs: 1 };

// ── What is retried, and what is not ─────────────────────────────────────────

test('the retryable set is exactly the three transient classes', () => {
  const retryable = AI_ERROR_CODES.filter((code) => isRetryable(code));
  assert.deepEqual(retryable.sort(), ['rate_limited', 'service_overloaded', 'timeout']);
});

test('a 503 is asked again and can succeed on the second ask', async () => {
  const calls = recorder([failure('service_overloaded'), success()]);
  const result = await generateWithRetry(calls.generate, request(), FAST, clock());

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.seen.length, 2);
});

test('three 503s stop at maxAttempts and report the real failure, not a generic one', async () => {
  const calls = recorder([failure('service_overloaded')]);
  const result = await generateWithRetry(calls.generate, request(), FAST, clock());

  assert.equal(result.ok, false);
  assert.equal(calls.seen.length, DEFAULT_RETRY_POLICY.maxAttempts);
  if (!result.ok) {
    assert.equal(result.error.code, 'service_overloaded');
    // The sentence she reads is still the one calibrated for this failure — it names the
    // reader being busy rather than degrading to something generic.
    assert.match(result.error.userMessage, /busy/i);
    assert.equal(result.error.nextStep, 'retry_later');
  }
  assert.equal(result.attempts, 3);
});

/**
 * THE COPY HAS TO ADMIT THE RETRY, OR THE RETRY MAKES THINGS WORSE.
 *
 * By the time any of these three sentences reaches a screen the app has already asked
 * again, spending up to three requests and up to nine seconds of her time. The old copy
 * was written for a system that did not do that: it said "try again in a few minutes" and
 * nothing else, so she waited three times as long, read the identical sentence she had
 * already reported once from the device, and the only instruction it gave her was the
 * thing the app had just done twice on her behalf — so she tapped it again and spent a
 * fourth request out of a daily free allowance.
 *
 * This asserts the PROPERTY (the message says the app already asked again, and offers the
 * one action that is not another identical request), not a particular phrase — the wording
 * is allowed to be rewritten, the promise is not. It is driven off `RETRYABLE_CODES` so a
 * code added to that Set without its copy being revisited fails here.
 */
test('every automatically retried code tells her the app already asked again', () => {
  for (const code of RETRYABLE_CODES) {
    const message = aiError(code).userMessage;
    assert.match(
      message,
      /Aarogya (waited and )?asked again|Aarogya waited/,
      `${code} is retried without asking her, so its copy must say so. Got: ${message}`,
    );
    assert.match(
      message,
      /type the medicines in yourself/,
      `${code} must offer the one next step that is not another identical request. Got: ${message}`,
    );
  }
});

test('the per-minute 429 is retried and the daily 429 is not — same status, opposite answer', async () => {
  const perMinute = recorder([failure('rate_limited'), success()]);
  assert.equal((await generateWithRetry(perMinute.generate, request(), FAST, clock())).ok, true);
  assert.equal(perMinute.seen.length, 2);

  const daily = recorder([failure('quota_exhausted'), success()]);
  const result = await generateWithRetry(daily.generate, request(), FAST, clock());
  assert.equal(daily.seen.length, 1, 'a daily quota failure must not spend another request');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'quota_exhausted');
});

test('nothing that costs her quota to reproduce the same answer is retried', async () => {
  // The whole point of the allow-list: each of these returns identically the second time,
  // and each already carries the one next step that actually fixes it.
  const final = [
    'invalid_key',
    // A key with an app or website restriction, and a project with the API switched off.
    // Both are refusals Google explained, and both are identical on the thousandth ask.
    'key_restricted',
    'api_not_enabled',
    'model_not_found',
    'bad_request',
    'safety_blocked_prompt',
    'safety_blocked_response',
    'quota_exhausted',
    // THE ONE THAT LOOKS MOST RETRYABLE AND IS LEAST: a 429, frequently with the server's
    // own `RetryInfo` attached, for a limit of zero. Asking again costs no quota — there is
    // none — and buys nothing but her time and the belief that the app is getting somewhere.
    'quota_zero',
    'offline',
    'server_error',
    'truncated',
    // Same request, same seed, same budget: the thinking spends the pot again. And it is
    // the most expensive request this app makes, because the thinking is what it spends.
    'thinking_budget_exhausted',
    'recitation',
    'empty_result',
    'malformed_json',
    'schema_mismatch',
    'no_content',
    'no_key',
    'image_unreadable',
    'crop_required',
  ] as const;

  for (const code of final) {
    const calls = recorder([failure(code)]);
    const result = await generateWithRetry(calls.generate, request(), FAST, clock());
    assert.equal(calls.seen.length, 1, `${code} must be asked exactly once`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('maxAttempts: 1 on the request turns the wrapper into a pass-through', async () => {
  const calls = recorder([failure('service_overloaded')]);
  const result = await generateWithRetry(
    calls.generate,
    request({ retry: { maxAttempts: 1 } }),
    { ...FAST, maxAttempts: 1 },
    clock(),
  );
  assert.equal(calls.seen.length, 1);
  assert.equal(result.attempts, 1);
});

// ── The image is prepared once, never per attempt ────────────────────────────

test('every attempt reuses the same encoded image — three asks, one encode', async () => {
  const calls = recorder([failure('service_overloaded'), failure('service_overloaded'), success()]);
  const original = request();
  await generateWithRetry(calls.generate, original, FAST, clock());

  assert.equal(calls.seen.length, 3);
  for (const seen of calls.seen) {
    // Identity, not equality: a copy would mean the base64 was rebuilt somewhere.
    assert.equal(seen.images, original.images);
    assert.equal(seen.prompt, original.prompt);
  }
});

test('the seed is not changed between attempts — a retry asks the same question', async () => {
  const calls = recorder([failure('service_overloaded'), success()]);
  await generateWithRetry(calls.generate, request({ seed: 4242 }), FAST, clock());
  assert.deepEqual(
    calls.seen.map((r) => r.seed),
    [4242, 4242],
  );
});

// ── She can see it happening ─────────────────────────────────────────────────

test('onAttempt narrates every attempt and every wait, in order', async () => {
  const events: string[] = [];
  const calls = recorder([failure('service_overloaded'), failure('service_overloaded'), success()]);
  await generateWithRetry(
    calls.generate,
    request({
      onAttempt: (event) =>
        events.push(
          event.phase === 'attempt'
            ? `attempt ${event.attempt}/${event.maxAttempts}`
            : `waiting after ${event.lastError.code}`,
        ),
    }),
    FAST,
    clock(),
  );

  assert.deepEqual(events, [
    'attempt 1/3',
    'waiting after service_overloaded',
    'attempt 2/3',
    'waiting after service_overloaded',
    'attempt 3/3',
  ]);
});

test('a successful first attempt still fires exactly one event and no wait', async () => {
  const events: unknown[] = [];
  const calls = recorder([success()]);
  await generateWithRetry(
    calls.generate,
    request({ onAttempt: (event) => events.push(event) }),
    FAST,
    clock(),
  );
  assert.equal(events.length, 1);
});

// ── She can stop it ──────────────────────────────────────────────────────────

test('aborting during the wait stops immediately and reports cancelled', async () => {
  const controller = new AbortController();
  const calls = recorder([failure('service_overloaded')]);

  const pending = generateWithRetry(
    calls.generate,
    request({
      signal: controller.signal,
      // She backs out while the app is waiting to ask again.
      onAttempt: (event) => {
        if (event.phase === 'waiting') controller.abort();
      },
    }),
    { ...FAST, baseDelayMs: 5_000 },
    clock(),
  );

  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'cancelled');
    // The failure that preceded it survives for the support case.
    assert.match(result.error.detail ?? '', /service_overloaded/);
    assert.match(result.error.userMessage, /photo is saved/);
  }
  assert.equal(calls.seen.length, 1, 'no further request may be spent after she leaves');
});

test('a signal that is already aborted spends nothing at all', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = recorder([success()]);
  const result = await generateWithRetry(
    calls.generate,
    request({ signal: controller.signal }),
    FAST,
    clock(),
  );
  assert.equal(calls.seen.length, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'cancelled');
});

test('sleep resolves as aborted the moment the signal fires, not when the timer would', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = sleep(60_000, controller.signal);
  controller.abort();
  assert.equal(await pending, 'aborted');
  assert.ok(Date.now() - startedAt < 1_000, 'the wait must not outlive the cancellation');
});

test('sleep resolves as slept when nobody interrupts it', async () => {
  assert.equal(await sleep(1), 'slept');
});

// ── The wait is bounded, and the numbers are the documented ones ─────────────

test('backoff doubles and jitter stays inside [0.5, 1.5) of the curve', () => {
  const policy = DEFAULT_RETRY_POLICY;
  for (const [attempt, expected] of [
    [1, 2_000],
    [2, 4_000],
  ] as const) {
    assert.equal(nextDelayMs(attempt, undefined, policy, () => 0), expected * 0.5);
    // Math.random() never returns 1, so 1.5x is the open upper bound.
    assert.ok((nextDelayMs(attempt, undefined, policy, () => 0.999) ?? 0) < expected * 1.5);
    assert.equal(nextDelayMs(attempt, undefined, policy, () => 0.5), expected);
  }
});

test('total time asleep with no advice from the server is at most 9 seconds', () => {
  const policy = DEFAULT_RETRY_POLICY;
  const worst = [1, 2]
    .map((attempt) => nextDelayMs(attempt, undefined, policy, () => 0.999999) ?? 0)
    .reduce((a, b) => a + b, 0);
  assert.ok(worst <= 9_000, `worst-case sleeping was ${worst} ms`);
});

test('a delay the server asks for wins over our curve, and one that is too long stops us', () => {
  const policy = DEFAULT_RETRY_POLICY;
  assert.equal(nextDelayMs(1, 26_000, policy, () => 0.5), 26_000);
  // Longer than we are willing to make a person sit still for: stop and show the sentence.
  assert.equal(nextDelayMs(1, 45_000, policy, () => 0.5), null);
});

test('a server-advised delay beyond the cap ends the sequence rather than stalling', async () => {
  const calls = recorder([failure('rate_limited', { retryAfterMs: 45_000 })]);
  const result = await generateWithRetry(calls.generate, request(), FAST, clock());
  assert.equal(calls.seen.length, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'rate_limited');
});

test('a later attempt is handed only the time the budget has left, never a fresh timeout', async () => {
  // Attempt 1 burns its whole 300 s timeout, exactly as a real timeout would.
  const c = clock(0.5);
  const calls = {
    seen: [] as AiRequest[],
    generate: async (r: AiRequest): Promise<AiResult> => {
      calls.seen.push(r);
      c.advance(r.timeoutMs ?? 0);
      return failure('timeout');
    },
  };

  await generateWithRetry(calls.generate, request(), { baseDelayMs: 1, minAttemptMs: 10_000 }, c);

  assert.equal(calls.seen[0]?.timeoutMs, 300_000);
  const second = calls.seen[1]?.timeoutMs ?? 0;
  assert.ok(second > 0 && second <= 120_000, `second attempt got ${second} ms`);
  // 300 s + a 120 s allowance leaves no room for a third: that is the 420 s ceiling.
  assert.equal(calls.seen.length, 2);
});

test('no attempt is started that the budget cannot give a usable amount of time to', async () => {
  const c = clock(0.5);
  const calls = {
    seen: [] as AiRequest[],
    generate: async (r: AiRequest): Promise<AiResult> => {
      calls.seen.push(r);
      c.advance(r.timeoutMs ?? 0);
      return failure('service_overloaded');
    },
  };
  // One attempt's worth of timeout, and an allowance too small to fit another.
  await generateWithRetry(
    calls.generate,
    request({ timeoutMs: 30_000 }),
    { baseDelayMs: 1, allowanceMs: 5_000, minAttemptMs: 10_000 },
    c,
  );
  assert.equal(calls.seen.length, 1);
});

test('elapsedMs is what she waited overall, not what the last attempt took', async () => {
  const c = clock(0.5);
  const calls = {
    seen: [] as AiRequest[],
    generate: async (r: AiRequest): Promise<AiResult> => {
      calls.seen.push(r);
      c.advance(7_000);
      return calls.seen.length < 2 ? failure('service_overloaded') : success();
    },
  };
  const result = await generateWithRetry(calls.generate, request(), FAST, c);
  assert.equal(result.ok, true);
  assert.equal(result.elapsedMs, 14_000, 'both attempts must be counted, not just the last');
});

// ── Reading the server's advice off the wire ─────────────────────────────────

test('parseRetryAfterMs understands every spelling the API actually sends', () => {
  assert.equal(parseRetryAfterMs('26s'), 26_000);
  assert.equal(parseRetryAfterMs('1.5s'), 1_500);
  // RFC 9110: a bare Retry-After is SECONDS. Reading it as milliseconds would turn a
  // 30-second request for room into 30 milliseconds of hammering.
  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs('  12s  '), 12_000);
});

test('parseRetryAfterMs handles an HTTP-date and refuses to go negative', () => {
  const now = Date.UTC(2026, 7, 10, 12, 0, 0);
  assert.equal(parseRetryAfterMs('Mon, 10 Aug 2026 12:00:20 GMT', now), 20_000);
  assert.equal(parseRetryAfterMs('Mon, 10 Aug 2026 11:59:00 GMT', now), 0);
});

test('parseRetryAfterMs returns undefined for anything it cannot read, and never throws', () => {
  for (const value of [null, undefined, '', '   ', 'soon', 'NaN', '{}']) {
    assert.equal(parseRetryAfterMs(value), undefined);
  }
});
