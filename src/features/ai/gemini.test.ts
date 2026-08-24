/**
 * Tests for the mapping every failure in this app depends on: HTTP status and response
 * body → one error code, one sentence, one next step.
 *
 * WHY THIS IS WORTH TESTING AT ALL. The whole argument of `errors.ts` is that "something
 * went wrong" is useless to a woman standing in a clinic corridor, because retake the
 * photo, turn on mobile data, fix the key and come back tomorrow are four different
 * actions. That argument is only as good as the branch that picks between them, and two of
 * those branches — the 400 that is really a bad key, and the 429 that is really a daily
 * quota — are decided by matching text in an error message. Text matching is exactly the
 * kind of thing that rots silently when an API changes its wording.
 *
 * NOTE ON THE IMPORT BELOW: Node's type-stripping loader (`node --test
 * --experimental-strip-types`) resolves only fully-specified `./x.ts` paths, while this
 * project's tsconfig does not enable `allowImportingTsExtensions`. Loading through a
 * non-literal specifier and re-typing the namespace satisfies both the runtime and `tsc`.
 *
 * This file can exist at all only because `gemini.ts` has no runtime import of
 * `provider.ts` (and therefore none of `settings.ts` → `expo-sqlite`). Keep it that way:
 * the moment a value is imported from `./provider` here, this suite stops loading in Node
 * and the error mapping goes back to being untested.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderConfig } from './provider';

// `gemini.ts` imports `./errors` and `./retry` without extensions, which the ESM loader
// cannot resolve. Same hook as features/backup/capsule.test.ts.
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

const MODULE = './gemini.ts';
const { createGeminiProvider } = (await import(MODULE)) as typeof import('./gemini');

// ── A fetch that answers exactly what a test wants it to ─────────────────────

type Wire = {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Throw instead of answering — the phone never reached the network. */
  readonly reject?: Error;
};

const CONFIG: ProviderConfig = {
  modelId: 'test-model',
  thinkingLevel: 'low',
  getApiKey: async () => 'AIza-test-key',
};

function stubFetch(wire: Wire): { restore: () => void; calls: number } {
  const original = globalThis.fetch;
  let calls = 0;
  const headers = new Map(
    Object.entries(wire.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );

  globalThis.fetch = (async () => {
    calls += 1;
    if (wire.reject) throw wire.reject;
    const status = wire.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body ?? {})),
    };
    // The stub is a structural stand-in for Response; only the four members the provider
    // actually reads are implemented, which is also a check that it reads no more.
  }) as unknown as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get calls() {
      return calls;
    },
  };
}

/**
 * One call against a stubbed wire.
 *
 * `retry: { maxAttempts: 1 }` is not needed — the provider returned by
 * `createGeminiProvider` is the BARE one. Retrying is applied by `createProvider()` in
 * provider.ts, and keeping it out of here is what makes these assertions about mapping
 * only. See retry.test.ts for the loop.
 */
async function call(wire: Wire, prompt = 'read this') {
  const stub = stubFetch(wire);
  try {
    return await createGeminiProvider(CONFIG).generate({
      prompt,
      images: [],
      timeoutMs: 5_000,
    });
  } finally {
    stub.restore();
  }
}

function apiError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code: status, message, status: 'ERROR', ...extra } };
}

// ── HTTP status → code ───────────────────────────────────────────────────────

test('503 is service_overloaded — the failure the retry policy exists for', async () => {
  const result = await call({ status: 503, body: apiError(503, 'The model is overloaded.') });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'service_overloaded');
    assert.equal(result.error.httpStatus, 503);
    assert.equal(result.error.retryable, true);
  }
});

test('500 stays server_error and is NOT quietly folded into the 503 case', async () => {
  const result = await call({ status: 500, body: apiError(500, 'Internal error.') });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'server_error');
});

test('429 splits on the wording: per-minute is retryable, per-day is not', async () => {
  const perMinute = await call({ status: 429, body: apiError(429, 'Quota exceeded: requests per minute') });
  assert.equal(perMinute.ok, false);
  if (!perMinute.ok) assert.equal(perMinute.error.code, 'rate_limited');

  for (const wording of [
    'Quota exceeded for quota metric requests per day',
    'You exceeded your current quota: GenerateRequestsPerDayPerProject',
    'Daily limit reached',
  ]) {
    const daily = await call({ status: 429, body: apiError(429, wording) });
    assert.equal(daily.ok, false);
    if (!daily.ok) {
      assert.equal(daily.error.code, 'quota_exhausted', wording);
      // The advice is the opposite one, and it is the whole reason the split exists.
      assert.equal(daily.error.nextStep, 'type_manually');
    }
  }
});

// ── 429: three faults, one status, decided on `details` before the prose ─────

function quotaFailure(quotaId: string, quotaValue: unknown, extra: readonly unknown[] = []) {
  return {
    error: {
      // The free tier's real message. It contains none of "day", "daily" or "per day" —
      // which is the whole reason the structured field has to be read first.
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaMetric: 'generate_content_free_tier_requests', quotaId, quotaValue }],
        },
        ...extra,
      ],
    },
  };
}

test('a per-day quotaId beats a message that never mentions a day', async () => {
  const result = await call({
    status: 429,
    body: quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '50'),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'quota_exhausted');
    assert.equal(result.error.nextStep, 'type_manually');
    assert.match(String(result.error.detail), /quotaId=GenerateRequestsPerDay/);
    assert.match(String(result.error.detail), /quotaValue=50/);
  }
});

test('a per-minute quotaId beats the message too — the preference works in both directions', async () => {
  const result = await call({
    status: 429,
    body: quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '10'),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'rate_limited');
});

test('a quota of ZERO is its own code — there is no minute and no tomorrow at which it works', async () => {
  // A limit of 0 is what a project reports when the API has never been enabled for it. It
  // is not an allowance that has been used up, so BOTH of the other two sentences ("wait a
  // minute", "try again tomorrow") describe a wait that ends, and this one does not.
  for (const value of ['0', 0]) {
    const result = await call({
      status: 429,
      body: quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier', value, [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39s' },
      ]),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'quota_zero', String(value));
      assert.equal(result.error.retryable, false);
      // The server's advice is dropped: honouring it would put a 39-second countdown in
      // front of her, ending in the identical failure.
      assert.equal(result.error.retryAfterMs, undefined);
      assert.match(String(result.error.detail), /quotaValue=0/);
    }
  }
});

test('a zero anywhere in the violations wins over a limit listed before it', async () => {
  const result = await call({
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' },
              { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '0' },
            ],
          },
        ],
      },
    },
  });
  assert.equal(result.ok, false);
  // A body naming two limits has one fact in it worth acting on, and it is not the one
  // that happened to be listed first.
  if (!result.ok) assert.equal(result.error.code, 'quota_zero');
});

test('an empty or missing quotaValue is NOT zero — Number(“”) is the expensive direction', async () => {
  // `Number('')`, `Number(' ')` and `Number(null)` are all 0. Reading the field with a bare
  // `Number()` would tell somebody with a perfectly good project that their allowance does
  // not exist, on the strength of a field the body did not fill in.
  for (const value of ['', '   ', null, undefined, {}, [], 'unlimited', '-1', '1e3']) {
    const result = await call({
      status: 429,
      body: quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', value),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'rate_limited', JSON.stringify(value));
  }
});

test('a QuotaFailure full of shapes we do not understand falls back to the message', async () => {
  const result = await call({
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'Quota exceeded for quota metric requests per day',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          null,
          42,
          'text',
          { violations: 'not an array' },
          { violations: [null, 7, 'x', {}] },
        ],
      },
    },
  });
  assert.equal(result.ok, false);
  // The prose fallback is kept precisely for this: a shape that changed, or a body with no
  // `details` at all. A discriminator with one source has one point of failure.
  if (!result.ok) assert.equal(result.error.code, 'quota_exhausted');
});

test('400 splits on the wording: a key problem is hers to fix, anything else is ours', async () => {
  const key = await call({ status: 400, body: apiError(400, 'API key not valid. Please pass a valid API key.') });
  assert.equal(key.ok, false);
  if (!key.ok) {
    assert.equal(key.error.code, 'invalid_key');
    assert.equal(key.error.nextStep, 'check_key');
  }

  const ours = await call({ status: 400, body: apiError(400, 'Invalid JSON payload received.') });
  assert.equal(ours.ok, false);
  if (!ours.ok) {
    assert.equal(ours.error.code, 'bad_request');
    assert.equal(ours.error.nextStep, 'report_bug');
    // It says so, too: this one is not her photograph's fault.
    assert.match(ours.error.userMessage, /problem in the app/);
  }
});

// ── 403: four faults, one status, told apart by `details[].reason` ───────────
//
// Every one of these used to be `invalid_key`, whose sentence is "Check it in Settings" —
// correct for exactly one of them. The other three send somebody to re-type a key whose
// characters are perfect, which is an evening, and then a second evening with a fresh key
// that carries the same restriction.

function errorWithReason(status: number, message: string, reason: string) {
  return {
    error: {
      code: status,
      message,
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason,
          domain: 'googleapis.com',
          metadata: { service: 'generativelanguage.googleapis.com' },
        },
      ],
    },
  };
}

test('a key restricted to an app, a website or an IP is `key_restricted`, never a key to re-type', async () => {
  for (const reason of [
    'API_KEY_ANDROID_APP_BLOCKED',
    'API_KEY_IOS_APP_BLOCKED',
    'API_KEY_HTTP_REFERRER_BLOCKED',
    'API_KEY_IP_ADDRESS_BLOCKED',
  ]) {
    const result = await call({
      status: 403,
      body: errorWithReason(403, 'Requests from this Android client application <empty> are blocked.', reason),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'key_restricted', reason);
      // NOT `check_key`. That button opens the screen where the key is re-typed.
      assert.equal(result.error.nextStep, 'type_manually', reason);
      assert.equal(result.error.retryable, false, reason);
      // The reason travels on the detail too, so `prescription.extraction_error` carries
      // the discriminator and not only the prose.
      assert.match(String(result.error.detail), new RegExp(`reason=${reason}`));
    }
  }
});

test('an API switched off for the project is `api_not_enabled` — a console fix, not a phone fix', async () => {
  for (const reason of ['SERVICE_DISABLED', 'API_KEY_SERVICE_BLOCKED']) {
    const result = await call({
      status: 403,
      body: errorWithReason(403, 'Generative Language API has not been used in project 1 before or it is disabled.', reason),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'api_not_enabled', reason);
      assert.match(result.error.userMessage, /Google Cloud Console/);
    }
  }
});

test('a 403 Google does not explain stays `invalid_key` — the branch never invents a reason', async () => {
  // No `details` at all, and a `details` naming something nobody has mapped. Both fall
  // through to the generic sentence rather than guessing at a remedy; the reason still
  // reaches the log and the stored detail, which is how an unmapped fault becomes visible
  // without this branch pretending to understand it.
  const bare = await call({ status: 403, body: apiError(403, 'permission denied') });
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.equal(bare.error.code, 'invalid_key');

  const unmapped = await call({
    status: 403,
    body: errorWithReason(403, 'permission denied', 'SOMETHING_NOBODY_HAS_SEEN_YET'),
  });
  assert.equal(unmapped.ok, false);
  if (!unmapped.ok) {
    assert.equal(unmapped.error.code, 'invalid_key');
    assert.match(String(unmapped.error.detail), /reason=SOMETHING_NOBODY_HAS_SEEN_YET/);
  }
});

test('a `reason` that is not a SCREAMING_SNAKE identifier is treated as absent', async () => {
  // This value decides a user-facing sentence and is printed into a log built to be pasted
  // into a chat window. A body carrying prose, a URL or a whole object under this key gets
  // the generic path — the shape is checked, not trusted.
  for (const reason of [
    'this is a sentence, not an enum',
    'https://example.test/why',
    'lowercase_reason',
    '',
  ]) {
    const result = await call({ status: 403, body: errorWithReason(403, 'nope', reason) });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_key', reason);
      assert.ok(!String(result.error.detail).includes('reason='), reason);
    }
  }
});

test('401, 403 and 404 each get their own code', async () => {
  for (const [status, code] of [
    [401, 'invalid_key'],
    [403, 'invalid_key'],
    [404, 'model_not_found'],
  ] as const) {
    const result = await call({ status, body: apiError(status, 'nope') });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});

test('an unreadable error body still produces a precise code, not a parse failure', async () => {
  // A captive portal answering with HTML is the realistic version of this.
  const result = await call({ status: 503, body: '<html>Service Unavailable</html>' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'service_overloaded');
});

// ── The server's own retry advice ────────────────────────────────────────────

test("RetryInfo.retryDelay in the body is carried through to the retry layer", async () => {
  const result = await call({
    status: 429,
    body: apiError(429, 'Quota exceeded: requests per minute', {
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '26s' },
      ],
    }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.retryAfterMs, 26_000);
});

test('a Retry-After header is used when the body says nothing', async () => {
  const result = await call({
    status: 503,
    body: apiError(503, 'overloaded'),
    headers: { 'Retry-After': '12' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.retryAfterMs, 12_000);
});

test('the body wins over the header when both are present', async () => {
  const result = await call({
    status: 503,
    body: apiError(503, 'overloaded', { details: [{ retryDelay: '5s' }] }),
    headers: { 'Retry-After': '99' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.retryAfterMs, 5_000);
});

test('a details array full of shapes we do not understand does not throw', async () => {
  const result = await call({
    status: 503,
    body: apiError(503, 'overloaded', { details: [null, 42, 'text', {}, { retryDelay: 7 }] }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'service_overloaded');
    assert.equal(result.error.retryAfterMs, undefined);
  }
});

test('no advice is attached to a failure that must never be retried', async () => {
  const result = await call({
    status: 403,
    body: apiError(403, 'permission denied'),
    headers: { 'Retry-After': '5' },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_key');
    assert.equal(result.error.retryAfterMs, undefined, 'a bad key does not get better in 5 seconds');
  }
});

// ── The other failure paths, unchanged by this work but easy to break ────────

test('a network rejection is offline, and an abort is cancelled — never the same sentence', async () => {
  const offline = await call({ reject: new TypeError('Network request failed') });
  assert.equal(offline.ok, false);
  if (!offline.ok) {
    assert.equal(offline.error.code, 'offline');
    assert.equal(offline.error.nextStep, 'check_connection');
  }

  const controller = new AbortController();
  controller.abort();
  const stub = stubFetch({ status: 200 });
  try {
    const cancelled = await createGeminiProvider(CONFIG).generate({
      prompt: 'read this',
      images: [],
      signal: controller.signal,
    });
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(stub.calls, 0, 'an already-cancelled request must not reach the network');
  } finally {
    stub.restore();
  }
});

test('a missing key is reported before anything is sent', async () => {
  const stub = stubFetch({ status: 200 });
  try {
    const result = await createGeminiProvider({ ...CONFIG, getApiKey: async () => null }).generate({
      prompt: 'read this',
      images: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'no_key');
    assert.equal(stub.calls, 0);
  } finally {
    stub.restore();
  }
});

test('a safety block before generation is not confused with one during it', async () => {
  const before = await call({ body: { promptFeedback: { blockReason: 'SAFETY' } } });
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.error.code, 'safety_blocked_prompt');

  const during = await call({
    body: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] },
  });
  assert.equal(during.ok, false);
  if (!during.ok) assert.equal(during.error.code, 'safety_blocked_response');
});

test('a cut-off answer is never parsed — a truncated medicine list is the silent failure', async () => {
  const result = await call({
    body: {
      candidates: [
        { finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"medicines":[{"name":"Met' }] } },
      ],
    },
  });
  assert.equal(result.ok, false);
  // Text in hand and no usage numbers at all: an answer WAS produced and cut, so the older
  // and blunter sentence is the right one. Absent evidence, this path does not guess.
  if (!result.ok) assert.equal(result.error.code, 'truncated');
});

test('MAX_TOKENS with no answer at all is the thinking budget, not a long prescription', async () => {
  // `maxOutputTokens` is a COMBINED thinking + answer budget on Gemini 3, so this finish
  // reason covers two faults that take opposite actions. `outputTokens: 0` with thousands
  // of thought tokens is the one where "photograph fewer lines at a time" is not merely
  // useless — it is the instruction that makes the failure repeat, which is exactly how
  // "AI prescription scanning is not working" was reported.
  const result = await call({
    body: {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [], role: 'model' } }],
      usageMetadata: {
        promptTokenCount: 5_112,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 32_768,
        totalTokenCount: 37_880,
      },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'thinking_budget_exhausted');
    assert.equal(result.error.nextStep, 'report_bug');
    assert.match(result.error.userMessage, /problem in the app/);
    assert.match(result.error.userMessage, /photographing fewer lines will not help/);
    // The three numbers that prove it, on the error itself and not only in the log.
    assert.match(String(result.error.detail), /thoughtTokens=32768/);
    assert.match(String(result.error.detail), /outputTokens=0/);
  }
});

test('MAX_TOKENS with the answer mostly written stays `truncated`, with the numbers to prove it', async () => {
  const result = await call({
    body: {
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ text: '{"medicines":[{"name_as_written":"Tab. Am' }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 5_112,
        candidatesTokenCount: 30_984,
        thoughtsTokenCount: 1_784,
        totalTokenCount: 37_880,
      },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'truncated');
    assert.equal(result.error.nextStep, 'retake_photo');
    assert.match(String(result.error.detail), /outputTokens=30984/);
  }
});

test('MAX_TOKENS with no text and no thinking spent is not blamed on thinking', async () => {
  // Nothing in this body says where the budget went, so nothing here claims to know. The
  // conservative direction is the older sentence, not a confident wrong one.
  const result = await call({
    body: {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'truncated');
});

test('thought parts are dropped before the answer is read', async () => {
  const result = await call({
    body: {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: 'Let me look at the second line…', thought: true },
              { text: '{"medicines":[]}' },
            ],
          },
        },
      ],
      // `thoughtsTokenCount`, with the 's' — the API's own spelling. Getting it wrong here
      // is silent: the total simply comes out low, which is exactly why this is asserted.
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, '{"medicines":[]}');
    // Thinking tokens are billed as output but reported apart; a total that ignores them
    // understates the bill on a thinking model.
    assert.equal(result.usage.totalTokens, 20);
  }
});
