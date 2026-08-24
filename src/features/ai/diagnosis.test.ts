/**
 * THE QUESTION THIS SUITE ANSWERS: reading the log alone, with no cable and no source
 * code, could her son tell WHICH failure it was and what to do about it?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ASKED HERE AND NOT ON THE PHONE
 *
 * The instruction was "turn on Developer mode and try a scan". That takes her phone —
 * there is no device on the machine this suite runs on, and there is no honest way to
 * fake one. What CAN be done here is the part that decides whether the exercise on the
 * phone is worth doing at all: drive the REAL provider and the REAL retry loop against a
 * faked HTTP layer, one genuine Google failure body at a time, and read back what the
 * recorder actually kept.
 *
 * If a failure produces a log her son cannot act on, that is worth finding now, on a
 * laptop, rather than after an evening of re-typing an API key that was never wrong.
 *
 * ─── WHAT "DRIVE THE REAL CODE PATH" MEANS, PRECISELY ────────────────────────
 *
 * `generateWithRetry(createGeminiProvider(CONFIG).generate, …)` — the same composition
 * `createProvider()` performs in provider.ts. Nothing is stubbed except `globalThis.fetch`
 * and the retry loop's injected clock. Every `record()` call under test is the shipped
 * one, reached through the shipped branch, in the shipped order.
 *
 * TWO NOTES THIS SUITE CANNOT SEE, AND THE REASON IS NOT AN OVERSIGHT. `run.start` /
 * `run.end` (the bookends that group fifteen lines into one story) and `prep.page` (the
 * crop and encode) are written by `prescriptions/extract.ts`, which imports the database
 * and `expo-image-manipulator`. Reaching them from a plain `node --test` process is not
 * possible, and making it possible would mean giving this module a native import — the
 * one thing recorder.ts's header asks callers not to do. On the phone they bracket
 * everything below.
 *
 * ─── HOW THE ASSERTIONS ARE WRITTEN, AND WHY ON THE TEXT ─────────────────────
 *
 * Most of them run against `formatEntries()` — the exact string "Copy All" and the share
 * sheet hand over — as well as against the fields. That is deliberate: the bar is about
 * what a person READS, and a fact that is in `entry.fields` but comes out `[blocked]` on
 * the way to the clipboard has not been logged in any sense that helps him.
 *
 * ─── NO TEST BELOW IS MARKED "DEFECT" ANY MORE. FOUR USED TO BE ──────────────
 *
 * The convention, kept because it will be needed again: a test that pins what the code
 * does TODAY, wrongly, because a defect nobody can reproduce gets argued about instead of
 * fixed. It names, in its own comment, the assertion that must REPLACE it — so the fix
 * breaks the test, the test points at the operator guide in docs/AI-EXTRACTION.md, and the
 * guide's table cannot go stale behind a green suite.
 *
 * All four have now been fixed, and three of them are worth knowing as a SET rather than as
 * three bugs, because they are one shape. Every one decided something on ENGLISH PROSE
 * while the answer sat unread in a structured field beside it:
 *
 *   a daily 429 read as a per-minute one   — the fact was in `violations[].quotaId`, and
 *                                            `quotaValue: 0` said that even "tomorrow" was
 *                                            a lie. The message said none of it.
 *   four flavours of 403 wearing one code  — the fact was in `details[].reason`, a stable
 *                                            enum, while the code was chosen from a
 *                                            sentence that is also cut at 300 characters.
 *   a thinking-eaten budget read as a long — the fact was in `usageMetadata`, and the
 *   prescription                             function deciding the code was never handed
 *                                            it, though the log printed it two lines up.
 *
 * The fourth was a different shape and is the one to watch for next: THE FACT WAS NEVER
 * WRITTEN DOWN AT ALL. A bad crop and an unreadable photograph both ended at `medicines=0`
 * because the rectangle that was sent appeared nowhere in the log — no field to misread, no
 * prose to argue with, nothing. It is fixed in `imagePrep.ts`/`extract.ts` and asserted in
 * `imagePrep.test.ts`; what is left here is the assertion that the note is actually WIRED
 * UP, which is the half a unit test of a pure function cannot make.
 *
 * The tests for all four now assert the fix, and the fixtures they run against are still the
 * bodies Google actually sends. If a fifth turns up, look for one of those two shapes.
 *
 * NOTE ON THE IMPORTS: the same type-stripping loader constraint as every other suite in
 * this directory (`node --test --experimental-strip-types` resolves only fully-specified
 * paths, and this project's tsconfig does not enable `allowImportingTsExtensions`).
 * Loading through a non-literal specifier and re-typing the namespace satisfies both the
 * runner and `tsc`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import type { AiRequest } from './provider';

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

const GEMINI_MODULE = './gemini.ts';
const { createGeminiProvider } = (await import(GEMINI_MODULE)) as typeof import('./gemini');

const RETRY_MODULE = './retry.ts';
const { generateWithRetry } = (await import(RETRY_MODULE)) as typeof import('./retry');

const ERRORS_MODULE = './errors.ts';
const { aiError } = (await import(ERRORS_MODULE)) as typeof import('./errors');

const PROGRESS_MODULE = './progress.ts';
const { resetAiProgress } = (await import(PROGRESS_MODULE)) as typeof import('./progress');

const RECORDER_MODULE = '../devlog/recorder.ts';
const {
  clearEntries,
  devLogStats,
  formatEntries,
  listEntries,
  record,
  setRecording,
  subscribeDevLog,
  toNdjson,
} = (await import(RECORDER_MODULE)) as typeof import('../devlog/recorder');

type DevLogEntry = import('../devlog/types').DevLogEntry;
type ProviderConfig = import('./provider').ProviderConfig;

// ── The wire ─────────────────────────────────────────────────────────────────

type Wire = {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Throw instead of answering — the request never left the phone. */
  readonly reject?: Error;
  /** Never answer at all. The provider's own AbortController is what ends it. */
  readonly hang?: boolean;
};

/**
 * A key of the right SHAPE and the right LENGTH, and obviously not a key.
 *
 * 39 characters starting `AIza` is the public, documented form of every Google API key,
 * and both facts are what `secretFields()` reports. A test that used "test-key" would
 * assert that the fingerprint works on a string that could never be mistaken for the
 * thing it fingerprints.
 */
const FAKE_KEY = 'AIzaSyB0123456789abcdefghij_-KLMNOPQRST';

const CONFIG: ProviderConfig = {
  modelId: 'gemini-3.6-flash',
  thinkingLevel: 'high',
  getApiKey: async () => FAKE_KEY,
};

function stubFetch(wire: Wire): { restore: () => void; readonly calls: number } {
  const original = globalThis.fetch;
  let calls = 0;
  const headers = new Map(
    Object.entries(wire.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );

  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
    calls += 1;
    if (wire.reject) return Promise.reject(wire.reject);
    if (wire.hang) {
      // Exactly what a real `fetch` does when the caller's signal fires: reject with an
      // AbortError and nothing else. `gemini.ts` then has to decide, from `timedOut`
      // alone, whether that was our timer or a person leaving the screen.
      return new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort);
      });
    }
    const status = wire.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () =>
        typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body ?? {}),
    });
    // Structurally a Response, implementing only the four members the provider reads —
    // which is also a check that it reads no more.
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
 * Millisecond waits, borrowed from `retry.test.ts` rather than reinvented.
 *
 * `sleep()` uses a REAL `setTimeout` — the injected clock covers `now` and `random` only,
 * because the point of the sleep is that it is interruptible and a fake timer would test
 * a different function.
 *
 * `maxDelayMs: 20` is the compressed form of the shipped 30 s ceiling. Where a test turns
 * on that ceiling it says so, and names the shipped number.
 */
const FAST = { baseDelayMs: 2, maxDelayMs: 20, allowanceMs: 10_000, minAttemptMs: 1 };

/** Frozen, so a budget assertion is exact rather than approximate. */
const clock = { now: () => 1_000, random: () => 0.5 };

/**
 * The request one scan actually makes: a prompt, one cropped page, a response schema.
 *
 * The schema is a stand-in, and that is sound — the provider only ever asks whether it is
 * `undefined`, to decide between parsing the answer as JSON and taking it as prose (which
 * is what `testKey()` needs). The real one lives in `prescriptions/schema.ts`, whose file
 * this suite must not reach: it would drag the database in behind it.
 */
function scanRequest(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    prompt: 'You are transcribing a photograph of a medical prescription…',
    // Eight base64 characters carry six bytes. Small, and exactly checkable.
    images: [{ mimeType: 'image/jpeg', base64: 'AAAABBBB' }],
    responseSchema: { type: 'OBJECT' },
    seed: 1234567,
    timeoutMs: 5_000,
    ...overrides,
  };
}

type Run = {
  readonly ok: boolean;
  readonly code: string | null;
  /** Every note, oldest first — the order they happened, which is how the screen reads. */
  readonly notes: readonly DevLogEntry[];
  readonly events: readonly string[];
  /** What "Copy All" hands over. The thing a person actually reads. */
  readonly text: string;
  readonly calls: number;
};

/**
 * One scan against one wire, with the toggle ON.
 *
 * Everything between the two `setRecording` calls is the shipped path. The ring is emptied
 * before and the toggle put back after, because the recorder is a module-level singleton
 * by design and a test that leaves it on has quietly changed the next test's subject.
 */
async function scan(wire: Wire, request: AiRequest = scanRequest()): Promise<Run> {
  resetAiProgress();
  setRecording(false);
  clearEntries();
  setRecording(true);

  const stub = stubFetch(wire);
  try {
    const result = await generateWithRetry(
      (attempt) => createGeminiProvider(CONFIG).generate(attempt),
      request,
      FAST,
      clock,
    );
    const notes = listEntries().slice();
    return {
      ok: result.ok,
      code: result.ok ? null : result.error.code,
      notes,
      events: notes.map((note) => note.event),
      text: formatEntries(),
      calls: stub.calls,
    };
  } finally {
    stub.restore();
    setRecording(false);
    clearEntries();
  }
}

/** The first note of a kind, which for every event below is the one that matters. */
function noteOf(run: Run, event: string): DevLogEntry | undefined {
  return run.notes.find((note) => note.event === event);
}

function fieldOf(run: Run, event: string, name: string): unknown {
  return noteOf(run, event)?.fields[name];
}

/** Every note of a kind — for the events a retry sequence produces more than one of. */
function allOf(run: Run, event: string): readonly DevLogEntry[] {
  return run.notes.filter((note) => note.event === event);
}

// ── The bodies. Google's own shapes, not shapes invented to pass. ─────────────

/**
 * `finishReason: MAX_TOKENS`, no text part, `candidatesTokenCount: 0` and a large
 * `thoughtsTokenCount`.
 *
 * This is the failure written out over `DEFAULT_MAX_OUTPUT_TOKENS` in gemini.ts: on
 * Gemini 3 `maxOutputTokens` is the allowance for THINKING PLUS the answer, drawn from one
 * pot, so high thinking on a smudged line can spend the entire budget before a single
 * character of JSON exists. Note `thoughtsTokenCount` with the 's' — the API's own
 * spelling, and getting it wrong here is silent.
 */
const THINKING_ATE_THE_BUDGET = {
  candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'MAX_TOKENS' }],
  usageMetadata: {
    promptTokenCount: 5_112,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 32_768,
    totalTokenCount: 37_880,
  },
  modelVersion: 'gemini-3.6-flash',
};

/**
 * The same `finishReason`, and a completely different fault: the model produced a real
 * answer and ran out of room part-way through the eleventh medicine.
 */
const GENUINELY_TOO_LONG = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: `{"total_medicines_counted":14,"medicines":[${'{"name_as_written":"unknown"},'.repeat(
              10,
            )}{"name_as_written":"Tab. Am`,
          },
        ],
        role: 'model',
      },
      finishReason: 'MAX_TOKENS',
    },
  ],
  usageMetadata: {
    promptTokenCount: 5_112,
    candidatesTokenCount: 30_984,
    thoughtsTokenCount: 1_784,
    totalTokenCount: 37_880,
  },
  modelVersion: 'gemini-3.6-flash',
};

/**
 * A key restricted to Android apps, called from something that sent no `X-Android-Package`
 * header. `<empty>` is what Google prints when the header is absent, which is exactly this
 * app's case — `gemini.ts` sends `x-goog-api-key` and nothing else.
 *
 * THIS IS THE TRAP THE OPERATOR GUIDE EXISTS FOR. The user-facing sentence for it is
 * "The Google AI key saved on this phone was not accepted. Check it in Settings" — which
 * sends somebody to re-type a key that is perfectly correct, as many times as their
 * patience allows.
 */
const ANDROID_APP_BLOCKED = {
  error: {
    code: 403,
    message: 'Requests from this Android client application <empty> are blocked.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_ANDROID_APP_BLOCKED',
        domain: 'googleapis.com',
        metadata: {
          service: 'generativelanguage.googleapis.com',
          consumer: 'projects/123456789012',
        },
      },
    ],
  },
};

/** The API never switched on for the project the key belongs to. Also a 403. */
const SERVICE_DISABLED = {
  error: {
    code: 403,
    message:
      'Generative Language API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=123456789012 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        domain: 'googleapis.com',
        metadata: {
          service: 'generativelanguage.googleapis.com',
          consumer: 'projects/123456789012',
        },
      },
    ],
  },
};

/**
 * THE FREE-TIER DAILY 429, IN THE SHAPE THE API ACTUALLY SENDS IT.
 *
 * The `message` is generic — it does not contain the words "day", "daily" or "per day"
 * anywhere. The per-DAY fact lives in `details[].violations[].quotaId`, and `quotaValue`
 * is the limit itself: `"0"`, which is what a project that has never had the API enabled
 * for billing reports. A limit of zero is the case where "try again tomorrow" is not
 * merely unhelpful, it is false — tomorrow never comes.
 */
const DAILY_QUOTA_IN_DETAILS = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-3.6-flash', location: 'global' },
            quotaValue: '0',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '39s' },
    ],
  },
};

/**
 * The same free-tier shape with an allowance that EXISTS and has been spent.
 *
 * `quotaValue: "50"` rather than "0" — a per-day limit that genuinely comes back in the
 * morning. It is here so that "read the quota out of `details`" cannot be satisfied by
 * treating every structured 429 as the hopeless one: the difference between "come back
 * tomorrow" and "tomorrow is the same day" is this single field.
 */
const DAILY_QUOTA_SPENT = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-3.6-flash', location: 'global' },
            quotaValue: '50',
          },
        ],
      },
    ],
  },
};

/**
 * The generic message again, with a per-MINUTE violation in `details`.
 *
 * Preferring the structured field only helps if it is trusted in both directions. This is
 * the body that would be misread as a daily quota by a parser that looked at `details`
 * only to find a reason to say "day".
 */
const PER_MINUTE_IN_DETAILS = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-3.6-flash', location: 'global' },
            quotaValue: '10',
          },
        ],
      },
      // Ten milliseconds, for the same reason as PER_MINUTE_LIMIT below.
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' },
    ],
  },
};

/** The older 429 wording, which names the quota inside the message where we look. */
const PER_MINUTE_LIMIT = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Generate requests per minute' and limit 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' of service 'generativelanguage.googleapis.com' for consumer 'project_number:123456789012'.",
    status: 'RESOURCE_EXHAUSTED',
    details: [
      // A real server says "26s" here. Compressed to ten milliseconds so this suite does
      // not sit still for half a minute — the FIELD and its protobuf Duration spelling are
      // the API's, only the magnitude is the test's, and `maxDelayMs` is compressed to
      // match (see FAST).
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' },
    ],
  },
};

/** The same wording with the daily quota named where the parser can see it. */
const DAILY_QUOTA_IN_MESSAGE = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Generate requests per day' and limit 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' of service 'generativelanguage.googleapis.com'.",
    status: 'RESOURCE_EXHAUSTED',
  },
};

const OVERLOADED = {
  error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' },
};

const MODEL_NOT_FOUND = {
  error: {
    code: 404,
    message:
      'models/gemini-3.6-flash is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.',
    status: 'NOT_FOUND',
  },
};

/** Everything the envelope can hold, and nothing in it. Structurally empty. */
const NOTHING_AT_ALL = {
  candidates: [
    { content: { parts: [{ text: '{}' }], role: 'model' }, finishReason: 'STOP' },
  ],
  usageMetadata: {
    promptTokenCount: 5_112,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 902,
    totalTokenCount: 6_018,
  },
  modelVersion: 'gemini-3.6-flash',
};

/**
 * A complete, schema-shaped answer that found no medicines — the shape a page whose
 * medicine block was cropped away produces. Note `page_notes`: the model's own prose about
 * the photograph, which is free text and must never reach the log.
 */
const READ_NOTHING_ON_THE_PAGE = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              total_medicines_counted: 0,
              medicines: [],
              prescriber: 'unknown',
              clinic: 'unknown',
              prescribed_on: 'unknown',
              follow_up: { present: false, verbatim: 'unknown' },
              tests_advised: [],
              non_medicine_instructions: [],
              page_notes:
                'The top of the page is not in the picture; only a signature and a stamp are visible.',
            }),
          },
        ],
        role: 'model',
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 5_112,
    candidatesTokenCount: 148,
    thoughtsTokenCount: 1_204,
    totalTokenCount: 6_464,
  },
  modelVersion: 'gemini-3.6-flash',
};

/** A good read, of a TB regimen, which is the worst thing this log could ever leak. */
const A_GOOD_READ = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'Line two is smudged; I will transcribe the letters I can see.', thought: true },
          {
            text: JSON.stringify({
              total_medicines_counted: 2,
              medicines: [
                { name_as_written: 'Tab. Isoniazid 300 mg', frequency: { pattern_code: '1-0-0' } },
                { name_as_written: 'Tab. Rifampicin 450 mg', frequency: { pattern_code: '1-0-0' } },
              ],
              prescriber: 'unknown',
              tests_advised: [{ name_as_written: 'LFT' }],
              page_notes: 'unknown',
            }),
          },
        ],
        role: 'model',
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 5_112,
    candidatesTokenCount: 1_180,
    thoughtsTokenCount: 2_402,
    totalTokenCount: 8_694,
  },
  modelVersion: 'gemini-3.6-flash',
};

/**
 * Every wire above, in one table, so the toggle-OFF test drives the SAME set the
 * toggle-ON tests do rather than a convenient subset of it. A promise that holds for nine
 * of ten paths is not the promise that was made.
 */
const EVERY_FAILURE: readonly { readonly name: string; readonly wire: Wire }[] = [
  { name: 'thinking ate the budget', wire: { body: THINKING_ATE_THE_BUDGET } },
  { name: 'genuinely too long', wire: { body: GENUINELY_TOO_LONG } },
  { name: '403 Android-restricted key', wire: { status: 403, body: ANDROID_APP_BLOCKED } },
  { name: '403 service disabled', wire: { status: 403, body: SERVICE_DISABLED } },
  { name: '429 zero allowance, quota in details', wire: { status: 429, body: DAILY_QUOTA_IN_DETAILS } },
  { name: '429 daily allowance spent', wire: { status: 429, body: DAILY_QUOTA_SPENT } },
  { name: '429 daily, quota in message', wire: { status: 429, body: DAILY_QUOTA_IN_MESSAGE } },
  { name: '429 per minute, quota in details', wire: { status: 429, body: PER_MINUTE_IN_DETAILS } },
  { name: '429 per minute', wire: { status: 429, body: PER_MINUTE_LIMIT } },
  { name: '503 overloaded', wire: { status: 503, body: OVERLOADED } },
  { name: '404 model not found', wire: { status: 404, body: MODEL_NOT_FOUND } },
  { name: 'empty result', wire: { body: NOTHING_AT_ALL } },
  { name: 'nothing readable on the page', wire: { body: READ_NOTHING_ON_THE_PAGE } },
  { name: 'network timeout', wire: { hang: true } },
  { name: 'no signal at all', wire: { reject: new TypeError('Network request failed') } },
  { name: 'a good read', wire: { body: A_GOOD_READ } },
];

// ─────────────────────────────────────────────────────────────────────────────
// A. ONE FAILURE AT A TIME: what lands in the log, and whether it is enough
// ─────────────────────────────────────────────────────────────────────────────

test('a budget spent on thinking is told in three numbers beside the request that set it', async () => {
  const run = await scan({ body: THINKING_ATE_THE_BUDGET });

  // Its OWN code, not `truncated`. The two are one fault only if you never look at the
  // token counts, and the sentence behind `truncated` sends her to re-photograph a page
  // that will fail in exactly the same way.
  assert.equal(run.code, 'thinking_budget_exhausted');
  assert.equal(
    run.calls,
    1,
    'a budget eaten by thinking is not in RETRYABLE_CODES: the same request spends the same thinking',
  );

  // The request that set the budget, and the budget it set. This is the note that settles
  // the argument rather than leaving somebody to reconstruct it: 32768 is not a spend, and
  // seeing it beside `thinkingLevel=high` is what stops the next person "saving money".
  assert.equal(fieldOf(run, 'ai.request', 'maxOutputTokens'), 32_768);
  assert.equal(fieldOf(run, 'ai.request', 'thinkingLevel'), 'high');
  assert.equal(fieldOf(run, 'ai.request', 'modelId'), 'gemini-3.6-flash');

  // And the three numbers that name the fault. `outputTokens: 0` with `thoughtTokens` in
  // the thousands and `finishReason=MAX_TOKENS` is the whole story: the answer never
  // started, because the thinking had already spent the pot they share.
  assert.equal(fieldOf(run, 'ai.response', 'finishReason'), 'MAX_TOKENS');
  assert.equal(fieldOf(run, 'ai.response', 'outputTokens'), 0);
  assert.equal(fieldOf(run, 'ai.response', 'thoughtTokens'), 32_768);
  assert.equal(fieldOf(run, 'ai.response', 'textChars'), 0);
  assert.equal(fieldOf(run, 'ai.response', 'parts'), 0);

  // Written BEFORE `finishReasonError` decides the outcome, so the failure cannot skip it.
  assert.deepEqual(run.events, ['ai.attempt', 'ai.request', 'ai.response', 'ai.outcome']);
  assert.equal(fieldOf(run, 'ai.outcome', 'errorCode'), 'thinking_budget_exhausted');

  // All of it survives to the clipboard, which is the only form of it he will ever hold.
  assert.match(run.text, /finishReason=MAX_TOKENS/);
  assert.match(run.text, /outputTokens=0/);
  assert.match(run.text, /thoughtTokens=32768/);
});

test('a real truncation and a thinking-eaten budget are two codes, not one MAX_TOKENS', async () => {
  const thinking = await scan({ body: THINKING_ATE_THE_BUDGET });
  const tooLong = await scan({ body: GENUINELY_TOO_LONG });

  // ─── THE FIXED DEFECT, STATED AS AN ASSERTION ─────────────────────────────
  //
  // Both bodies carry `finishReason: MAX_TOKENS`, and for a long time both produced
  // `truncated` — whose sentence is "The prescription was too long to read in one go …
  // Photograph fewer lines at a time". That is sound advice for one of them and the exact
  // instruction that makes the other repeat, because the budget went on thinking either
  // way. `finishReasonError` is now handed the token counts and returns a different code,
  // so the LINE HE READS is the diagnosis rather than a coin toss between two of them.
  assert.notEqual(thinking.code, tooLong.code);
  assert.equal(thinking.code, 'thinking_budget_exhausted');
  assert.equal(tooLong.code, 'truncated');
  assert.notEqual(
    fieldOf(thinking, 'ai.outcome', 'errorCode'),
    fieldOf(tooLong, 'ai.outcome', 'errorCode'),
    'the code alone must be readable as a diagnosis, without reconstructing it from token counts',
  );

  // And the sentences say opposite things about the photograph, which is the point of the
  // split: one asks for fewer lines, the other says fewer lines will not help.
  assert.match(aiError('truncated').userMessage, /Photograph fewer lines/);
  assert.match(
    aiError('thinking_budget_exhausted').userMessage,
    /photographing fewer lines will not help/,
  );
  assert.match(aiError('thinking_budget_exhausted').userMessage, /problem in the app/);

  // What DOES separate them, and the only thing that does: the answer was produced.
  assert.equal(fieldOf(tooLong, 'ai.response', 'outputTokens'), 30_984);
  assert.ok((fieldOf(tooLong, 'ai.response', 'textChars') as number) > 300);
  assert.ok(
    (fieldOf(tooLong, 'ai.response', 'thoughtTokens') as number) <
      (fieldOf(tooLong, 'ai.response', 'outputTokens') as number),
    'a genuine truncation spends most of the pot on the answer; a thinking-eaten budget spends none of it',
  );

  // And the fragment of JSON it got through never reaches the log. `truncated` is never
  // parsed — a cut-off medicine list that parses is the silent failure — and the text of
  // it is not something a log built to be pasted into a chat window may carry.
  assert.ok(!tooLong.text.includes('name_as_written'));
  assert.ok(!tooLong.text.includes('Tab. Am'));
});

test('a key restricted to Android apps says so in Google’s own words, beside a key that is plainly fine', async () => {
  const run = await scan({ status: 403, body: ANDROID_APP_BLOCKED });

  // Its own code, because its own remedy. `invalid_key` says "Check it in Settings", which
  // is the one action that cannot work on a key whose characters are perfect.
  assert.equal(run.code, 'key_restricted');
  assert.equal(run.calls, 1, 'a rejected key does not get better on the second ask');
  assert.match(aiError('key_restricted').userMessage, /typing it in again will not change that/);
  assert.match(aiError('key_restricted').userMessage, /Google Cloud Console/);

  // The sentence that ends the evening. It exists nowhere else in the app.
  const apiMessage = String(fieldOf(run, 'ai.http', 'apiMessage'));
  assert.match(apiMessage, /Android client application/);
  assert.match(apiMessage, /blocked/);
  assert.equal(fieldOf(run, 'ai.http', 'apiStatus'), 'PERMISSION_DENIED');
  assert.equal(fieldOf(run, 'ai.http', 'httpStatus'), 403);

  // ─── AND THE HALF THAT PROVES RE-TYPING IS POINTLESS ──────────────────────
  //
  // The `ai.request` note two lines above says a key WAS sent, that it is 39 characters,
  // and that it starts `AIza`. A key of the right length and the right shape, rejected with
  // "Android client application … are blocked", is a key that is not wrong — it is a key
  // with a restriction on it. That pair is the whole diagnosis, and neither half is enough
  // on its own.
  assert.equal(fieldOf(run, 'ai.request', 'keyPresent'), true);
  assert.equal(fieldOf(run, 'ai.request', 'keyLength'), 39);
  assert.equal(fieldOf(run, 'ai.request', 'keyShape'), 'AIza');
  assert.ok(!run.text.includes(FAKE_KEY), 'the key itself is never in the log');
  assert.ok(!run.text.includes('AIzaSyB'), 'nor a prefix long enough to be one');

  // And Google's own machine discriminator, which is what decided the code — twenty
  // characters that survive translation, rewording and the scrubber's 300-character cap,
  // where the English prose beside them survives none of the three.
  assert.equal(fieldOf(run, 'ai.http', 'apiReason'), 'API_KEY_ANDROID_APP_BLOCKED');
  assert.match(run.text, /apiReason=API_KEY_ANDROID_APP_BLOCKED/);
});

test('a project with the API switched off is its own fault, and not a key to re-type', async () => {
  const blocked = await scan({ status: 403, body: ANDROID_APP_BLOCKED });
  const disabled = await scan({ status: 403, body: SERVICE_DISABLED });

  // Identical status, and `apiStatus` cannot separate them either — PERMISSION_DENIED
  // covers both. Everything that follows is about what DOES.
  assert.equal(
    fieldOf(blocked, 'ai.http', 'apiStatus'),
    fieldOf(disabled, 'ai.http', 'apiStatus'),
    'PERMISSION_DENIED covers both, so `apiStatus` cannot separate them',
  );

  // ─── THE MACHINE-READABLE DISCRIMINATOR, NOW READ AND NOW LOGGED ──────────
  //
  // `error.details[].reason` is a short, stable enum. It separates these two — and
  // API_KEY_HTTP_REFERRER_BLOCKED, and API_KEY_IP_ADDRESS_BLOCKED — without reading a word
  // of English, which matters because the English is capped at 300 characters by the
  // scrubber and the SERVICE_DISABLED message is long enough to lose its tail.
  assert.notEqual(blocked.code, disabled.code);
  assert.equal(blocked.code, 'key_restricted');
  assert.equal(disabled.code, 'api_not_enabled');
  assert.notEqual(
    fieldOf(blocked, 'ai.http', 'apiReason'),
    fieldOf(disabled, 'ai.http', 'apiReason'),
  );
  assert.equal(fieldOf(disabled, 'ai.http', 'apiReason'), 'SERVICE_DISABLED');
  assert.match(disabled.text, /apiReason=SERVICE_DISABLED/);

  // `apiMessage` still travels, and is still the most valuable prose in the log — it is
  // simply no longer the only thing standing between two different remedies. Its tail is
  // still cut, and the cut is still visible, which is why the enum had to exist.
  const message = String(fieldOf(disabled, 'ai.http', 'apiMessage'));
  assert.match(message, /has not been used in project/);
  assert.match(message, /disabled/);
  assert.match(message, /… \(\+\d+\)$/, 'the tail of the message is cut, and the cut is at least visible');

  // The sentence names the console, which is where the fix is. It must not name Settings.
  const sentence = aiError('api_not_enabled').userMessage;
  assert.match(sentence, /Google Cloud Console/);
  assert.match(sentence, /Generative Language API/);
  assert.ok(
    !/Check it in Settings/.test(sentence),
    'nothing on this phone fixes a project with the API switched off',
  );
});

test('the per-minute limit is read correctly, retried, and says the server named the wait', async () => {
  const run = await scan({ status: 429, body: PER_MINUTE_LIMIT });

  assert.equal(run.code, 'rate_limited');
  assert.equal(run.calls, 3, 'a per-minute limit clears itself, so the app asks again rather than asking her to');

  // Three attempts, two waits, one verdict each: the whole shape of "it kept trying" is on
  // the screen without a paragraph explaining it.
  assert.deepEqual(run.events, [
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome', 'ai.wait',
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome', 'ai.wait',
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome',
  ]);

  // `advised=true` is the single most useful fact when a rate limit is being investigated
  // from a phone: it says the WAIT came from the server, not from our curve, which means
  // the server is the thing to believe about when capacity returns.
  const wait = noteOf(run, 'ai.wait');
  assert.equal(wait?.fields['advised'], true);
  assert.equal(wait?.fields['errorCode'], 'rate_limited');
  assert.equal(fieldOf(run, 'ai.http', 'retryAfterMs'), 10);
});

test('a daily 429 whose message names the day is read as a day, and is never asked again', async () => {
  const run = await scan({ status: 429, body: DAILY_QUOTA_IN_MESSAGE });

  assert.equal(run.code, 'quota_exhausted');
  assert.equal(run.calls, 1, 'there is nothing left to spend, and retrying only delays the sentence she can act on');
  assert.equal(fieldOf(run, 'ai.outcome', 'errorCode'), 'quota_exhausted');
  assert.equal(run.events.includes('ai.wait'), false);

  // Which is the opposite advice from the per-minute case, on the same status code — so the
  // two must never print the same line.
  const perMinute = await scan({ status: 429, body: PER_MINUTE_LIMIT });
  assert.notEqual(run.code, perMinute.code);
});

test('a 429 whose quota lives only in `details` is read from `details` — and a limit of zero is its own answer', async () => {
  const run = await scan({ status: 429, body: DAILY_QUOTA_IN_DETAILS });

  // ─── THE FIX FOR THE MOST EXPENSIVE DEFECT IN THIS FILE ───────────────────
  //
  // This is the body the free tier actually sends. Its `message` is generic — "You exceeded
  // your current quota, please check your plan and billing details" — and contains none of
  // "day", "daily" or "per day". The per-DAY fact is in `details[].violations[].quotaId`,
  // and `quotaValue: "0"` is the limit itself.
  //
  // Matching the MESSAGE alone landed this on `rate_limited`: "wait a minute and try
  // again", forever, for a limit at which no minute exists. `quotaValue: 0` is stronger
  // still than per-day: it is not an allowance that has been used up, it is one that does
  // not exist, so "try again tomorrow" is false as well. Both of those sentences describe
  // a wait that ends. This one does not end, and the code says which.
  assert.equal(run.code, 'quota_zero');
  assert.equal(fieldOf(run, 'ai.outcome', 'errorCode'), 'quota_zero');

  // The evidence that decided it, on the line above, in the log he is reading.
  assert.equal(fieldOf(run, 'ai.http', 'quotaId'), 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.equal(fieldOf(run, 'ai.http', 'quotaValue'), 0);
  assert.match(run.text, /quotaValue=0/);
  assert.match(run.text, /PerDay/);

  // And the sentence tells him the truth about tomorrow, in the app's own voice.
  const sentence = aiError('quota_zero').userMessage;
  assert.match(sentence, /limit is zero/);
  assert.match(sentence, /waiting until tomorrow will not change it/);
  assert.match(sentence, /Google Cloud Console/);

  // Asked exactly once, and the server's own `RetryInfo` is deliberately DROPPED on the
  // floor — the same rule that keeps a `Retry-After` off a 403 (see gemini.test.ts, "no
  // advice is attached to a failure that must never be retried"). This body really does
  // carry `retryDelay: 39s`, and honouring it would put a countdown in front of her for a
  // wait that ends in the identical failure. `quota_zero` is not in RETRYABLE_CODES,
  // because no number of asks can find an allowance that does not exist.
  assert.equal(fieldOf(run, 'ai.http', 'retryAfterMs'), null);
  assert.equal(run.calls, 1);
  assert.equal(run.events.includes('ai.wait'), false);
});

test('a daily 429 with a real allowance is `quota_exhausted`, not `quota_zero` — tomorrow is true there', async () => {
  const run = await scan({ status: 429, body: DAILY_QUOTA_SPENT });

  // Same generic message, same QuotaFailure shape, same per-day quotaId. The ONLY
  // difference is that `quotaValue` is 50 rather than 0 — an allowance that exists and has
  // been spent, which does come back in the morning. Two sentences, one number apart, and
  // the number is the one thing the message never mentions.
  assert.equal(run.code, 'quota_exhausted');
  assert.equal(fieldOf(run, 'ai.http', 'quotaValue'), 50);
  assert.equal(fieldOf(run, 'ai.http', 'quotaId'), 'GenerateRequestsPerDayPerProjectPerModel-FreeTier');
  assert.match(aiError('quota_exhausted').userMessage, /Try again tomorrow/);
  assert.equal(run.calls, 1, 'there is nothing left to spend today');
  assert.equal(run.events.includes('ai.wait'), false);
});

test('a per-minute quotaId keeps the per-minute answer, whatever the prose says', async () => {
  // The structured field is preferred over the message — so it has to be right in BOTH
  // directions, or "prefer the structure" is just a different way of being wrong. Here the
  // violation names the minute and the message is the same generic quota sentence.
  const run = await scan({ status: 429, body: PER_MINUTE_IN_DETAILS });

  assert.equal(run.code, 'rate_limited');
  assert.equal(fieldOf(run, 'ai.http', 'quotaId'), 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
  assert.equal(run.calls, 3, 'a per-minute limit clears itself, so the app asks again rather than asking her to');
});

test('a busy model shows the whole asking-again sequence, with the delays it chose itself', async () => {
  const run = await scan({ status: 503, body: OVERLOADED });

  assert.equal(run.code, 'service_overloaded');
  assert.equal(run.calls, 3);
  assert.deepEqual(run.events, [
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome', 'ai.wait',
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome', 'ai.wait',
    'ai.attempt', 'ai.request', 'ai.http', 'ai.outcome',
  ]);

  // Attempt numbers on every line, so three round trips read as one story rather than as
  // three unexplained failures.
  assert.deepEqual(
    allOf(run, 'ai.attempt').map((note) => note.fields['attempt']),
    [1, 2, 3],
  );
  assert.deepEqual(
    allOf(run, 'ai.attempt').map((note) => note.fields['maxAttempts']),
    [3, 3, 3],
  );

  // Nobody named a delay, so the curve chose it: 2 ms then 4 ms under this policy, 2 s then
  // 4 s in production, each multiplied by jitter in [0.5, 1.5).
  const waits = allOf(run, 'ai.wait');
  assert.equal(waits.length, 2);
  assert.deepEqual(waits.map((note) => note.fields['advised']), [false, false]);
  assert.deepEqual(waits.map((note) => note.fields['retryInMs']), [2, 4]);

  // And the budget is visible shrinking, which is what makes "why did it only try twice?"
  // answerable on the timeout path.
  for (const note of allOf(run, 'ai.attempt')) {
    assert.equal(typeof note.fields['budgetLeftMs'], 'number');
    assert.equal(typeof note.fields['timeoutMs'], 'number');
  }
});

test('a wrong model id names the model that was asked for, on the line above the refusal', async () => {
  const run = await scan({ status: 404, body: MODEL_NOT_FOUND });

  assert.equal(run.code, 'model_not_found');
  assert.equal(run.calls, 1);
  assert.equal(fieldOf(run, 'ai.http', 'httpStatus'), 404);
  assert.equal(fieldOf(run, 'ai.http', 'apiStatus'), 'NOT_FOUND');
  // The model this build asked for, from the request note — so "is not found" and "which
  // one did it ask for" are two lines apart rather than a question.
  //
  // This is the one failure in this file where the LOG is complete and the ADVICE is not.
  // `model_not_found`'s sentence is "Pick a different one in Settings", and there is no
  // model picker: `setAiModel()` and `setThinkingLevel()` in ai/settings.ts have no caller
  // anywhere under src/app/. The model is `DEFAULT_MODEL_ID`, fixed in the build, so the
  // day Google retires it every installed phone 404s with no remedy short of a new APK.
  // Recorded in docs/AI-EXTRACTION.md §11.6 item 2.
  assert.equal(fieldOf(run, 'ai.request', 'modelId'), 'gemini-3.6-flash');
  assert.match(String(fieldOf(run, 'ai.http', 'apiMessage')), /is not found for API version/);
});

test('an empty envelope and a page with nothing readable on it are different lines', async () => {
  const empty = await scan({ body: NOTHING_AT_ALL });
  assert.equal(empty.code, 'empty_result');
  // `empty=true` is the model answering `{}` — it looked and returned no fields at all.
  assert.equal(fieldOf(empty, 'ai.parse', 'empty'), true);
  assert.equal(fieldOf(empty, 'ai.parse', 'topKeys'), '');
  assert.equal(fieldOf(empty, 'ai.parse', 'arrayCounts'), '');

  const nothingRead = await scan({ body: READ_NOTHING_ON_THE_PAGE });
  // A full envelope with an empty list is NOT `empty_result` — the provider succeeds and
  // the count is what says so. That distinction is the difference between "the model
  // refused to answer" and "the model answered, and the answer is zero medicines".
  assert.equal(nothingRead.ok, true);
  assert.equal(fieldOf(nothingRead, 'ai.parse', 'empty'), false);
  assert.match(String(fieldOf(nothingRead, 'ai.parse', 'arrayCounts')), /medicines=0/);
  assert.match(String(fieldOf(nothingRead, 'ai.parse', 'topKeys')), /total_medicines_counted/);

  // And the model's prose about the photograph does not travel, however useful it sounds.
  // `page_notes` is free text about a picture of her prescription; on another page it says
  // "the patient's name is written at the top".
  assert.ok(!nothingRead.text.includes('signature'));
  assert.ok(!nothingRead.text.includes('The top of the page'));
});

test('the rectangle that was sent reaches `prep.page`, spread in at the only call sites there are', () => {
  // ─── WHAT USED TO BE HERE, AND WHY REPLACING IT WAS NOT OPTIONAL ─────────
  //
  // A test stood here asserting that `cropOriginY`, `cropHeight`, `outWidth` and
  // `outHeight` appeared NOWHERE in a scan — the fourth defect, pinned, with a comment
  // naming the assertion that should replace it once a crop could be told from a blank
  // page. That has happened: the values are asserted in `imagePrep.test.ts`, which stubs
  // `expo-image-manipulator` and runs a real crop (3024×4032 in, `droppedTopPx=887`,
  // `defaultCrop=true` out).
  //
  // The old test would still be GREEN, and that is why it had to go rather than stay as a
  // harmless leftover. `prep.page` is written by `prescriptions/extract.ts`, which imports
  // the database — this suite's own header says so, twenty lines up — so no scan driven
  // from this process can produce that note however the code behaves. It asserted the
  // absence of four field names from a note that structurally cannot appear, which is a
  // pass with nothing behind it, under a title that reads as "the defect is still open".
  // A green test that describes a fixed defect is worse than no test: it is the one thing
  // in the repository that says, in its own words, not to look.
  //
  // What is genuinely still out of reach from here is the WIRING, and that is what this
  // checks instead. `prepFields()` and `cropFields()` are pure functions in `imagePrep.ts`;
  // a pure function with no call site is precisely the defect `observability.test.ts` was
  // written for — shipped, type-checked, and connected to nothing. `imagePrep.test.ts` can
  // prove the numbers are right and cannot prove anybody logs them. Asserted on the source
  // for the same reason as the guard test below: the module cannot be loaded here at all.
  const extract = maskLiteralsAndComments(readFileSync(EXTRACT_PATH, 'utf8'));
  const notes = callSpans(extract, 'record');
  assert.ok(notes.length > 0, 'extract.ts still records something');

  const spreadIntoANote = (name: string): number =>
    callSites(extract, name).filter((index) => notes.some((span) => index > span.start && index < span.end))
      .length;

  // Two notes carry the pixels that were actually CUT — the page that was sent, and the
  // page that was dropped for exceeding the inline budget. The third carries the rectangle
  // that was ASKED FOR, because a crop that failed has no pixels to report.
  assert.equal(spreadIntoANote('prepFields'), 2, '`prepFields()` must be spread into the prep.page notes');
  assert.equal(spreadIntoANote('cropFields'), 1, '`cropFields()` must be spread into the failed-crop note');

  // Counted rather than merely found, so deleting the spreads cannot make this pass by
  // leaving nothing to check — and so a fourth call site somewhere else has to be noticed.
  assert.equal(callSites(extract, 'prepFields').length, 2, 'and `prepFields()` is called nowhere else');
  assert.equal(callSites(extract, 'cropFields').length, 1, 'and `cropFields()` is called nowhere else');
});

test('a timeout is not an HTTP status, and the log must not let it look like one', async () => {
  // 30 ms per attempt rather than 300 s. The mechanism is the provider's own
  // AbortController either way; only the number is compressed.
  const run = await scan({ hang: true }, scanRequest({ timeoutMs: 30 }));

  assert.equal(run.code, 'timeout');
  assert.equal(run.calls, 3, 'a slow minute on a mobile network is not a verdict, so it is asked again');

  const note = noteOf(run, 'ai.http');
  assert.equal(note?.fields['errorCode'], 'timeout');
  assert.equal(note?.fields['timeoutMs'], 30);
  assert.equal(note?.level, 'warn');
  // No status, because there was no answer. A reader scanning for `httpStatus=` finds
  // nothing on this line, which is the correct impression: nothing came back at all.
  assert.equal(note?.fields['httpStatus'], undefined);
  assert.equal(note?.fields['apiMessage'], undefined);

  // Each later attempt is handed only what the budget has left, never a fresh timeout —
  // and both numbers are on the line, which is what makes "why did it stop trying?"
  // answerable without the source.
  assert.deepEqual(allOf(run, 'ai.attempt').map((entry) => entry.fields['timeoutMs']), [30, 30, 30]);

  // The caveat this test exists to pin: a timeout is filed under `ai.http`, an event whose
  // own table entry in devlog/types.ts reads "The HTTP answer." It is the honest place for
  // it only because `errorCode=timeout` and the missing status say what happened; if a
  // fourth event name is ever added, this is the line to revisit.
  assert.equal(note?.event, 'ai.http');
});

test('no signal at all is `offline`, with the class name that proves the request never left', async () => {
  const run = await scan({ reject: new TypeError('Network request failed') });

  assert.equal(run.code, 'offline');
  assert.equal(run.calls, 1, 'two seconds later there is still no signal; retrying hides the step that is hers');

  const note = noteOf(run, 'ai.http');
  assert.equal(note?.fields['errorCode'], 'offline');
  // `errorName`, not `errorMessage`. The message field is refused outright by redact.ts and
  // prints `[blocked]`; the CLASS NAME survives and is what separates "the request never
  // left the phone" (TypeError) from anything else that could reach here.
  assert.equal(note?.fields['errorName'], 'TypeError');
  assert.ok(!run.text.includes('Network request failed'));
});

test('a scan with no key never reaches the network, and the MISSING line is how you tell', async () => {
  resetAiProgress();
  setRecording(false);
  clearEntries();
  setRecording(true);
  const stub = stubFetch({ status: 200, body: A_GOOD_READ });
  try {
    const result = await generateWithRetry(
      (attempt) =>
        createGeminiProvider({ ...CONFIG, getApiKey: async () => null }).generate(attempt),
      scanRequest(),
      FAST,
      clock,
    );
    assert.equal(result.ok, false);
    assert.equal(stub.calls, 0, 'nothing is sent, so no allowance is spent proving there is no key');

    // ─── THE SHAPE, NOT THE FIELD ────────────────────────────────────────────
    //
    // `ai.request` is written by the provider AFTER it has a key in hand, so on this path
    // it does not exist at all. Two lines where every other failure has three or four, and
    // no `keyPresent=` anywhere, is the signature of "there is no key on this phone" — as
    // against `keyPresent=true keyLength=39` followed by a 403, which is a key that exists
    // and is being refused. Those two take completely different actions and this is what
    // separates them on the screen.
    const events = listEntries().map((entry) => entry.event);
    assert.deepEqual(events, ['ai.attempt', 'ai.outcome']);
    assert.equal(listEntries().at(-1)?.fields['errorCode'], 'no_key');
    assert.ok(!formatEntries().includes('keyPresent'));
  } finally {
    stub.restore();
    setRecording(false);
    clearEntries();
  }
});

test('a scan that WORKED still says how much it cost, and never what it read', async () => {
  const run = await scan({ body: A_GOOD_READ });

  assert.equal(run.ok, true);
  assert.deepEqual(run.events, ['ai.attempt', 'ai.request', 'ai.response', 'ai.parse', 'ai.outcome']);

  // Counts and token spend: enough to answer "is it working, and what does it cost",
  // which is the other half of what the log is for.
  assert.equal(fieldOf(run, 'ai.parse', 'arrayCounts'), 'medicines=2, tests_advised=1');
  assert.equal(fieldOf(run, 'ai.response', 'thoughtParts'), 1);
  assert.equal(fieldOf(run, 'ai.response', 'totalTokens'), 8_694);
  assert.equal(fieldOf(run, 'ai.outcome', 'ok'), true);
  assert.equal(fieldOf(run, 'ai.outcome', 'errorCode'), null);

  // ─── AND THE PROMISE THE SCREEN MAKES IN THE APP'S OWN VOICE ─────────────
  //
  // "They contain no medicines, no readings and no personal details." Two of these are a
  // first-line TB regimen; in an Indian OPD context that pair names the diagnosis to
  // anybody with a search engine, and this log is built on the assumption that it will be
  // pasted into a chat window with a stranger.
  for (const forbidden of ['Isoniazid', 'Rifampicin', '300 mg', '450 mg', '1-0-0', 'LFT']) {
    assert.ok(!run.text.includes(forbidden), `${forbidden} must never reach the log`);
  }
  // Nor the prompt, nor the photograph, nor the model's own reasoning.
  assert.ok(!run.text.includes('transcribing a photograph'));
  assert.ok(!run.text.includes('AAAABBBB'));
  assert.ok(!run.text.includes('Line two is smudged'));
});

// ─────────────────────────────────────────────────────────────────────────────
// B. THE TWO GUARANTEES, RE-VERIFIED WITH THE TOGGLE OFF
// ─────────────────────────────────────────────────────────────────────────────

test('every failure above, with the toggle off, records nothing at all — not one note', async () => {
  // Report 7, verbatim: "If developer option is not enabled, we will not store the logs at
  // all." The AI path calls `record()` from nine places, and any one of them can break that
  // promise on its own, on a phone belonging to someone who never asked for a second copy
  // of anything. So this drives the WHOLE table, not a sample of it.
  let notifications = 0;
  const unsubscribe = subscribeDevLog(() => {
    notifications += 1;
  });

  try {
    for (const { name, wire } of EVERY_FAILURE) {
      setRecording(false);
      clearEntries();
      // Zeroed AFTER the housekeeping above, because `clearEntries()` notifies by design —
      // the log screen has to redraw when somebody taps Delete. What is being counted here
      // is what the SCAN causes, which must be nothing.
      notifications = 0;
      const stub = stubFetch(wire);
      try {
        await generateWithRetry(
          (attempt) => createGeminiProvider(CONFIG).generate(attempt),
          wire.hang ? scanRequest({ timeoutMs: 20 }) : scanRequest(),
          FAST,
          clock,
        );
      } finally {
        stub.restore();
      }

      // Not "few". None.
      assert.deepEqual([...listEntries()], [], `${name}: the ring must be empty, not merely short`);
      const stats = devLogStats();
      assert.equal(stats.count, 0, name);
      assert.equal(stats.approxBytes, 0, name);
      assert.equal(stats.oldestTs, null, name);
      assert.equal(stats.newestTs, null, name);
      // Nothing to format, either — `formatEntries` and `toNdjson` are what the share sheet
      // and the file are built from, and both must come back empty rather than "[]" or a
      // header line. Off means no file at all (see store.ts, RULE TWO).
      assert.equal(formatEntries(), '', name);
      assert.equal(toNdjson(), '', name);
      // The recorder fires this on every note and every eviction. A whole scan — up to
      // three attempts, nine call sites, a failure body parsed — produced no change for a
      // subscriber to observe, which is the observable form of "nothing was written".
      assert.equal(notifications, 0, `${name}: a subscriber must not even learn that a scan happened`);
    }
  } finally {
    unsubscribe();
  }
});

test('with the toggle off a field bag is never built — the thunk is not invoked', () => {
  // This is the mechanism every hot call site in gemini.ts and retry.ts depends on, and it
  // is the reason they are written `if (isRecording()) record(…, () => ({ … }))` rather
  // than passing an object literal: the literal would be built before `record` is entered,
  // and the check inside cannot un-allocate it.
  setRecording(false);
  clearEntries();

  let built = 0;
  record('info', 'ai', 'ai.request', () => {
    built += 1;
    return { modelId: 'gemini-3.6-flash' };
  });
  assert.equal(built, 0, 'the thunk must not run — that is the whole cost model when off');
  assert.deepEqual([...listEntries()], []);

  // And a thunk that throws while ON loses its own note and nothing else, because a logger
  // that can throw into the middle of a scan converts a diagnosable failure into an
  // unhandled rejection three frames from anything that knows what was happening.
  setRecording(true);
  clearEntries();
  assert.doesNotThrow(() =>
    record('info', 'ai', 'ai.request', () => {
      throw new Error('a getter with an opinion');
    }),
  );
  assert.deepEqual([...listEntries()], []);
  setRecording(false);
  clearEntries();
});

test('every record() call site in the AI path sits behind an isRecording() guard', () => {
  // ─── WHY THIS IS ASSERTED ON THE SOURCE AND NOT ON BEHAVIOUR ─────────────
  //
  // A missing guard costs an ALLOCATION, not a note. `record()` still returns on its first
  // line, the ring still stays empty, `devLogStats()` still reads zero — every runtime
  // assertion in the test above still passes, and the promise in recorder.ts's header ("the
  // whole cost of a log call when the toggle is off is a boolean read") is quietly false on
  // a phone belonging to someone who never turned the feature on.
  //
  // There is no runtime observation that distinguishes those two worlds from outside the
  // module, so the only place the promise can be checked is where it is written down.
  // `.href` rather than the URL object: `lib.dom`'s `URL` and `node:url`'s are two
  // different declarations in this project's type graph, and only the string overload is
  // assignable from both.
  const dir = fileURLToPath(new URL('.', import.meta.url).href);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
  assert.ok(names.includes('gemini.ts') && names.includes('retry.ts'), 'the two recording files are in scope');

  // ─── AND `prescriptions/extract.ts`, WHICH IS THIS PATH TOO ──────────────
  //
  // It writes `run.start`, `run.end` and all three `prep.page` notes — a third of everything
  // one scan produces — and for as long as this scan was a `readdirSync` of one directory,
  // its guards were the only ones in the feature that nothing checked. That is not a
  // theoretical gap: the crop geometry was spread into those notes precisely because the
  // OFF cost of building the bag is nothing while the thunk is not invoked, and the thing
  // keeping the thunk uninvoked is a guard nobody was counting. Naming the file explicitly
  // rather than globbing another directory: this list is the AI path, and it should have to
  // be edited on purpose.
  const files = [
    ...names.map((name) => ({ name, path: `${dir}${name}` })),
    { name: 'prescriptions/extract.ts', path: EXTRACT_PATH },
  ];

  let guarded = 0;
  for (const { name, path } of files) {
    const source = maskLiteralsAndComments(readFileSync(path, 'utf8'));
    const spans = guardSpans(source);
    for (const index of callSites(source, 'record')) {
      const inside = spans.some((span) => index > span.start && index < span.end);
      assert.ok(
        inside,
        `${name}: a record() call at character ${index} is not inside an \`if (isRecording())\` block. ` +
          'The bag it passes is built on a phone that asked for nothing to be recorded.',
      );
      guarded += 1;
    }
  }
  // Thirteen today: six in gemini.ts, three in retry.ts, four in prescriptions/extract.ts.
  // Asserted so that DELETING the guards and the calls together cannot make this test pass
  // by having nothing left to check. Adding a call site is meant to fail here once, and to
  // be answered by raising this number deliberately rather than by loosening the check.
  assert.equal(guarded, 13, 'the AI path records from thirteen places, and all thirteen are guarded');
});

/**
 * Blanks every string, template literal and comment, preserving length and newlines.
 *
 * The brace matcher below counts `{` and `}`, and a brace inside a string ("`${x}`" in
 * keyStore.ts, for one) would throw the count off. Regex literals are deliberately NOT
 * masked — none of the files in scope contains a brace inside one, and a masker that tried
 * to recognise a regex literal would have to solve the division ambiguity to do it.
 */
function maskLiteralsAndComments(source: string): string {
  return source.replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

/** The character range covered by each `if (isRecording())`, braces or single statement. */
function guardSpans(source: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const guard = /if \(isRecording\(\)\)\s*/g;
  for (let match = guard.exec(source); match !== null; match = guard.exec(source)) {
    const start = match.index + match[0].length;
    if (source[start] !== '{') {
      // `if (isRecording()) record(…);` — legal, and the span runs to the statement's end.
      const semicolon = source.indexOf(';', start);
      spans.push({ start: start - 1, end: semicolon === -1 ? source.length : semicolon + 1 });
      continue;
    }
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push({ start, end: i });
          break;
        }
      }
    }
  }
  return spans;
}

/** Every `name(` in the source, as character offsets. `recordAppError(` does not match. */
function callSites(source: string, name: string): number[] {
  const out: number[] = [];
  const pattern = new RegExp(`\\b${name}\\(`, 'g');
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    out.push(match.index);
  }
  return out;
}

/**
 * Every `name(…)` call as a character RANGE, by matching its parentheses.
 *
 * `callSites` says where a call starts; this says where its arguments end, which is what
 * "is this expression inside that call" needs. Sound only on masked source — an unbalanced
 * parenthesis inside a string or a comment would run the span to the end of the file — and
 * every caller here masks first.
 */
function callSpans(source: string, name: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const start of callSites(source, name)) {
    const open = source.indexOf('(', start);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          spans.push({ start, end: i });
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * `prescriptions/extract.ts`, which cannot be IMPORTED here — it pulls in `expo-sqlite` —
 * and therefore has to be read as text by the two tests above. One constant so the two
 * cannot drift onto different files.
 */
const EXTRACT_PATH = fileURLToPath(new URL('../prescriptions/extract.ts', import.meta.url).href);
