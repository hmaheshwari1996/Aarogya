/**
 * How long one call may take, how many times it may be asked again, and how long she waits
 * in between.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * A 503 from `generateContent` means "this model is busy for the next few seconds". It is
 * the single most common failure this app will ever see, it clears itself, and until now
 * the app handled it by putting a sentence in front of a woman in a clinic corridor and
 * asking HER to tap again. She has a tremor, one bar of signal and an auto-rickshaw
 * waiting. Asking a person to be the retry loop is a defect, not a design.
 *
 * So: the app asks again, up to twice more, backing off, telling her it is still trying,
 * and stopping the instant she backs out.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FOUR TRAPS THIS FILE EXISTS TO AVOID. Read them before changing a number here.
 *
 *  1. RETRYING THE WRONG FAILURE COSTS HER SOMETHING REAL. A wrong key, a missing model,
 *     a request the API refuses, a safety block: every one of those returns the identical
 *     result the second and third time, and on the free tier each attempt spends a request
 *     out of a daily allowance that, once gone, is gone until tomorrow. `RETRYABLE_CODES`
 *     below is therefore a short allow-list, not a "not obviously fatal" filter. Note in
 *     particular that of the THREE codes a 429 can produce, only `rate_limited` — the
 *     per-minute one — is in it. `quota_exhausted` (the daily allowance, back tomorrow)
 *     and `quota_zero` (a limit of zero, back never) are not. One status code, three
 *     answers, and two of them are "stop asking".
 *
 *  2. AN UNBOUNDED WAIT IS ITS OWN FAILURE. She is holding the phone watching a spinner.
 *     Every path through this file is bounded by a wall-clock DEADLINE computed once at the
 *     start, and each retry attempt is handed only the time that is left. The worst cases
 *     are written out over `DEFAULT_RETRY_POLICY` — they are numbers, not adjectives.
 *
 *  3. A SILENT RETRY IS INDISTINGUISHABLE FROM A HANG. `AiRequest.onAttempt` fires before
 *     every attempt and before every wait, so the screen can change while this is happening
 *     instead of showing the same spinner for a minute. A retry the user cannot see is a
 *     worse experience than the failure it replaced.
 *
 *     TWO THINGS THAT NARRATION MUST NOT SAY, both of which an earlier draft of this very
 *     comment suggested out loud. It must not name a COUNT: "attempt 2 of 3" is wrong when a
 *     caller overrides `maxAttempts`, wrong whenever the remaining budget cannot fund
 *     another attempt, and wrong on the timeout path below, where 300 s leaves room for two
 *     attempts rather than three. `errors.ts` reached the same conclusion for the failure
 *     copy ("a few times", never "three times") and `retry.test.ts` holds both to it. And it
 *     must not say READING during a `waiting` event — nothing is being read then, the app is
 *     sitting still, and that is precisely the fact she is owed. `prescription/[id].tsx`
 *     renders this as one announced sentence (the reader is busy; the app is waiting and
 *     will ask again on its own) plus a countdown driven off `retryInMs`.
 *
 *  4. A RETRY THAT IGNORES CANCELLATION SPENDS HER QUOTA AFTER SHE HAS LEFT. The wait
 *     between attempts is interruptible — `sleep()` resolves the moment the caller's
 *     `AbortSignal` fires, and the signal is re-checked before every attempt. Backing out
 *     of the screen stops the sequence within milliseconds, and reports `cancelled`
 *     (which the UI already knows means "your photo is saved"), not the failure that
 *     happened to be last.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 *   • It does not re-prepare the image. The retry wraps ONE `AiRequest`, and that request
 *     already holds the cropped, resized, base64-encoded page (see `imagePrep.ts`). Every
 *     attempt reuses the same `images` array by reference, so three attempts cost exactly
 *     one crop, one resize and one JPEG encode — the expensive part happens in
 *     `runExtraction()` before the network is touched, and is never repeated.
 *
 *   • It does not change the seed between attempts. The seed lives in the request the
 *     caller built. A retry here is "ask the same question again because nobody answered",
 *     not "ask a different question hoping for a nicer answer".
 *
 *   • IT DOES NOT CONFIRM ANYTHING, AND CANNOT. Retrying changes only how many times the
 *     app asks. Everything the model returns is still a proposal that a human confirms
 *     before it can become a medicine or a schedule — a rule the database enforces with
 *     `trg_occ_requires_confirmed_medicine`, not one this layer could weaken if it tried.
 *
 * This file is a LEAF on purpose: at runtime it imports only `./errors`, `./progress` and
 * `../devlog/recorder` (the `./provider` import is types only, which is what keeps the cycle
 * harmless). EVERY ONE OF THOSE THREE IS FREE OF NATIVE IMPORTS, and that is a property to
 * check before adding a fourth — `retry.test.ts` and `gemini.test.ts` both run in a plain
 * `node --test` process with a stubbed `fetch`, and the moment anything reachable from here
 * reaches for `expo-sqlite` or `react-native` those suites stop loading and the error
 * mapping goes back to being untested. `progress.ts` imports one type from `./errors`;
 * `devlog/recorder.ts` says the same thing in its own header and means it.
 *
 * ─── THIS FILE IS THE NARRATOR, BECAUSE IT IS THE ONE THAT COUNTS ────────────
 *
 * Progress events and technical notes are published from here rather than from the
 * provider for a single reason: `attempt` and `maxAttempts` are facts this loop owns and
 * nobody else has. The provider contributes the one instant it alone can see — the request
 * leaving the phone — through `AiRequest.onRequestSent`, which this loop hands it with the
 * attempt numbers already bound. See the note on that field in `./provider.ts`.
 */

import { isRecording, record } from '../devlog/recorder';
import { DEV_EVENTS } from '../devlog/types';
import { aiError, type AiError, type AiErrorCode } from './errors';
import {
  publishAiProgress,
  readingProgress,
  sendingProgress,
  waitingProgress,
} from './progress';
import type { AiFailure, AiRequest, AiResult } from './provider';

/**
 * 300 seconds for ONE attempt.
 *
 * Not generous — measured. A 2 MB upload on a clinic-corridor connection is minutes on its
 * own, and a thinking model then spends tens of seconds before the first token. A
 * 60-second timeout turns "slow but working" into "failed", and the retry re-uploads the
 * same 2 MB over the same connection. The draft row and the photo are both persisted
 * before the call starts, so a timeout costs waiting, never data.
 *
 * Lives here rather than in `provider.ts` because it is one of four numbers that together
 * decide how long she waits, and splitting them across two files is how one of them gets
 * changed without the others. `provider.ts` re-exports it, so no caller has to care.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** The codes that mean "nobody answered", as opposed to "the answer is no". */
export const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  /** 503. The model is busy. This is the failure that prompted the whole file. */
  'service_overloaded',
  /** 429 with the per-minute limit hit — clears itself in well under a minute. */
  'rate_limited',
  /** Our own AbortController fired. A slow minute on a mobile network is not a verdict. */
  'timeout',
]);

/**
 * EVERYTHING ELSE IS FINAL, AND THE INTERESTING OMISSIONS ARE THE ONES THAT LOOK TRANSIENT:
 *
 *   `quota_exhausted`  — the DAILY 429. Retrying spends nothing (there is nothing left to
 *                        spend) but it delays the only useful sentence she can act on:
 *                        type them in, or come back tomorrow.
 *   `quota_zero`       — the 429 whose limit is 0. THE ONE THAT LOOKS MOST RETRYABLE AND
 *                        IS LEAST: it is a 429, the server frequently attaches a
 *                        `RetryInfo` to it, and it can never succeed at any point in the
 *                        future, because there is no allowance to come back. Retrying here
 *                        costs no quota and buys nothing but her time and the belief that
 *                        the app is trying. The fix is in Google Cloud Console and the
 *                        sentence says so.
 *   `key_restricted`,  — a 403 the server explained. The key carries a restriction this
 *   `api_not_enabled`    app cannot satisfy, or the API is switched off for its project.
 *                        Identical on the second ask and on the thousandth.
 *   `thinking_budget_` — MAX_TOKENS with no answer at all. Same request, same seed, same
 *   `exhausted`          budget, same outcome — and each attempt is the most expensive
 *                        request this app makes, because the thinking is what it spends.
 *   `offline`          — `fetch` never left the phone. Two seconds later it still will not.
 *                        The next step is hers: turn on mobile data. Retrying hides that.
 *   `server_error`     — 500/502/504. Genuinely often transient, and the obvious candidate
 *                        for this list. Left OUT deliberately: a 500 from this endpoint has
 *                        also been seen to mean "this request will never work", and we have
 *                        no field evidence yet to tell the two apart on this app's traffic.
 *                        Adding it is one line in the Set above, once a real report shows a
 *                        500 that a retry cleared. Do not add it speculatively.
 *   `no_content`,      — the model answered, and the answer was unusable. Asking the same
 *   `malformed_json`,    question again with the same seed and the same image is very
 *   `schema_mismatch`    likely to produce the same unusable answer, and the existing
 *                        "read it again" button — a fresh seed, chosen by her — is the
 *                        honest remedy.
 *   `safety_blocked_*` — a refusal. Repeating it is asking a machine to change its mind.
 *   `invalid_key`, `model_not_found`, `bad_request`, `image_unreadable`, `crop_required`,
 *   `truncated`, `recitation`, `empty_result`, `no_key`, `cancelled`, `unknown` — each one
 *                        already carries the single next step that actually fixes it, and
 *                        a retry only postpones showing it to her.
 */
export function isRetryable(code: AiErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export type RetryPolicy = {
  /** Total attempts INCLUDING the first. 1 disables retrying entirely. */
  readonly maxAttempts: number;
  /** The un-jittered wait after the first failure. Doubles each time. */
  readonly baseDelayMs: number;
  /** Ceiling on any single wait, including one the server asked for. */
  readonly maxDelayMs: number;
  /**
   * How much wall time, beyond ONE attempt's timeout, the whole sequence may spend.
   * This is what makes the worst case a number instead of a hope.
   */
  readonly allowanceMs: number;
  /** Do not start an attempt with less than this much of the budget left. */
  readonly minAttemptMs: number;
};

/**
 * THE NUMBERS, AND THE WORST CASES THEY PRODUCE.
 *
 * Waits are `baseDelayMs × 2^(n-1)`, multiplied by a random factor in [0.5, 1.5):
 *   after attempt 1 → 1.0 s … 3.0 s
 *   after attempt 2 → 2.0 s … 6.0 s
 *   total time asleep, worst case, with no advice from the server → 9 s.
 *
 * The jitter is not decoration. Google's 503s arrive in bursts, and every phone that backs
 * off by exactly 2 s then 4 s comes back in the same instant as every other phone — the
 * retry storm that produced the 503 in the first place.
 *
 * WORST-CASE WALL TIME, END TO END, for the three shapes of failure:
 *
 *   • 503 / 429 that fail fast (the reported case): three round trips of a second or two,
 *     plus at most 9 s asleep → about 15 seconds before she sees a sentence. Today that
 *     same 15 seconds costs her two taps and two waits, with an unexplained failure in
 *     between.
 *
 *   • 503 / 429 where the SERVER names a delay (`RetryInfo.retryDelay` / `Retry-After`):
 *     we honour it, capped at `maxDelayMs` (30 s) per wait, and refuse to start a wait we
 *     cannot afford. Bounded by `allowanceMs` at 120 s of extra wall time.
 *
 *   • TIMEOUT: attempt 1 can legitimately burn the full 300 s. `allowanceMs` then leaves
 *     ~118 s, which is handed to attempt 2 AS ITS TIMEOUT (not a fresh 300 s), and attempt
 *     3 never starts because there is nothing left to give it. Absolute ceiling for a scan:
 *     300 + 120 = 420 s. For `testKey()`, which asks for 45 s: 45 + 120 = 165 s.
 *     Be honest about this one — a second attempt on a connection that just timed out is
 *     the least likely of the three to succeed, and it is included only because a timeout
 *     on a mobile network is very often one bad minute rather than a bad connection.
 *
 * Every one of those is narrated through `onAttempt` and interruptible at any moment, which
 * is the difference between a long wait and a hang.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  allowanceMs: 120_000,
  minAttemptMs: 10_000,
};

/**
 * What the screen is told while this is happening.
 *
 * A discriminated union rather than one shape with optional fields, so a UI that renders
 * the waiting state cannot forget that `retryInMs` and `lastError` are only meaningful
 * there. `attempt` is 1-based and `maxAttempts` travels with every event, because "2" on
 * its own is not a sentence anyone can read.
 */
export type AiAttemptEvent =
  | {
      readonly phase: 'attempt';
      /** 1-based. `attempt === 1` is the ordinary first try, not a retry. */
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  | {
      readonly phase: 'waiting';
      /** The attempt that just failed. The next one is `attempt + 1`. */
      readonly attempt: number;
      readonly maxAttempts: number;
      /** How long until the next attempt starts. Round UP when rendering seconds. */
      readonly retryInMs: number;
      /** Why we are waiting. Never rendered raw — the UI already has copy per code. */
      readonly lastError: AiError;
    };

export type AiAttemptListener = (event: AiAttemptEvent) => void;

/**
 * Wraps one `generate` in the policy above.
 *
 * Takes the function rather than the provider so it composes at the `createProvider`
 * boundary: every provider, present and future, gets the same behaviour and no provider
 * implements its own. A provider is still free to be called directly — `retry.maxAttempts:
 * 1` on the request turns this into a pass-through.
 */
export async function generateWithRetry(
  generate: (request: AiRequest) => Promise<AiResult>,
  request: AiRequest,
  overrides: Partial<RetryPolicy> = {},
  /** Injectable for the tests. Nothing else should pass these. */
  clock: { now: () => number; random: () => number } = { now: Date.now, random: Math.random },
): Promise<AiResult> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...request.retry, ...overrides };
  const startedAt = clock.now();
  const perAttemptTimeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Computed ONCE, from the start of the operation. Recomputing it per attempt is how a
  // bounded retry quietly becomes an unbounded one.
  const deadline = startedAt + perAttemptTimeoutMs + policy.allowanceMs;

  let attempt = 0;
  let last: AiResult | null = null;

  for (;;) {
    attempt += 1;

    // Checked here as well as inside `generate`, because the wait we may just have come out
    // of is not the only place she can leave from.
    if (request.signal?.aborted) {
      return cancelledAfter(last, attempt - 1, clock.now() - startedAt, 'before an attempt');
    }

    request.onAttempt?.({ phase: 'attempt', attempt, maxAttempts: policy.maxAttempts });

    const remaining = deadline - clock.now();

    // The bar moves to "Sending the photo, about 1.4 MB" here, and to "The reader is
    // looking at it" the moment the provider says the request has gone. Both events carry
    // the attempt numbers, which is the whole reason this loop publishes them and the
    // provider does not.
    publishAiProgress(sendingProgress(attempt, policy.maxAttempts, inlineBytes(request)));
    if (isRecording()) {
      record('info', 'ai', DEV_EVENTS.aiAttempt, {
        attempt,
        maxAttempts: policy.maxAttempts,
        timeoutMs: Math.max(1, Math.min(perAttemptTimeoutMs, remaining)),
        budgetLeftMs: Math.max(0, remaining),
      });
    }

    const result = await generate({
      ...request,
      // Never MORE than the caller asked for, and never more than the budget has left. On
      // attempt 1 with a fresh budget these are the same number.
      timeoutMs: Math.max(1, Math.min(perAttemptTimeoutMs, remaining)),
      // Bound to THIS attempt's numbers, so the provider can report the instant without
      // ever learning that attempts exist. Wrapped because `onRequestSent` is contractually
      // allowed to be called by any provider, and a listener that throws must not take down
      // a scan that is otherwise going fine.
      onRequestSent: () => {
        try {
          publishAiProgress(readingProgress(attempt, policy.maxAttempts));
        } catch {
          // A progress listener is a screen mid-unmount. Never fatal to the request.
        }
      },
    });
    last = result;

    if (isRecording()) {
      record(result.ok ? 'info' : 'warn', 'ai', DEV_EVENTS.aiOutcome, () => ({
        attempt,
        ok: result.ok,
        errorCode: result.ok ? null : result.error.code,
        httpStatus: result.ok ? null : (result.error.httpStatus ?? null),
        elapsedMs: result.elapsedMs,
      }));
    }

    if (result.ok) return tally(result, attempt, clock.now() - startedAt);
    if (attempt >= policy.maxAttempts) break;
    if (!isRetryable(result.error.code)) break;
    if (request.signal?.aborted) {
      return cancelledAfter(last, attempt, clock.now() - startedAt, 'while failing');
    }

    const delay = nextDelayMs(attempt, result.error.retryAfterMs, policy, clock.random);

    // The server asked for longer than we are willing to make her sit still for. Stopping
    // now and showing "wait a minute and try again" is more honest than a spinner that
    // outlasts her patience.
    if (delay === null) break;
    // No point starting an attempt we cannot give a usable amount of time to.
    if (clock.now() + delay + policy.minAttemptMs > deadline) break;

    request.onAttempt?.({
      phase: 'waiting',
      attempt,
      maxAttempts: policy.maxAttempts,
      retryInMs: delay,
      lastError: result.error,
    });
    // Published as well as narrated through `onAttempt`, because the two have different
    // audiences: `onAttempt` drives the screen's countdown, and this holds the BAR still
    // (`waitingProgress` carries estimate 0 and the clamp pins it where the last real step
    // left it — see progress.ts). The scan screen deliberately drops the bus's `waiting`
    // event on the floor so the countdown has exactly one owner.
    publishAiProgress(waitingProgress(attempt, policy.maxAttempts, delay, result.error.code));
    if (isRecording()) {
      record('info', 'ai', DEV_EVENTS.aiWait, {
        attempt,
        retryInMs: delay,
        errorCode: result.error.code,
        // Whether the server named the delay or we chose it. The single most useful fact
        // when a rate limit is being investigated from a phone.
        advised: result.error.retryAfterMs !== undefined,
      });
    }

    if ((await sleep(delay, request.signal)) === 'aborted') {
      return cancelledAfter(last, attempt, clock.now() - startedAt, 'while waiting to try again');
    }
  }

  // `last` is always set here: the loop cannot break before its first assignment.
  return tally(last as AiResult, attempt, clock.now() - startedAt);
}

/**
 * The wait after `attempt`, or null for "do not wait, stop".
 *
 * `advisedMs` is what the server itself asked for (`google.rpc.RetryInfo.retryDelay`, or a
 * `Retry-After` header). When it is present it WINS over our own curve — it is the only
 * party that knows when the capacity comes back — but it is still refused above
 * `maxDelayMs`, because a 90-second spinner is a failure with extra steps.
 */
export function nextDelayMs(
  attempt: number,
  advisedMs: number | undefined,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number | null {
  if (advisedMs !== undefined && Number.isFinite(advisedMs) && advisedMs > 0) {
    return advisedMs > policy.maxDelayMs ? null : Math.ceil(advisedMs);
  }
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  // [0.5, 1.5) — see DEFAULT_RETRY_POLICY for why a fixed curve is the wrong shape here.
  const jittered = exponential * (0.5 + random());
  return Math.max(1, Math.ceil(Math.min(jittered, policy.maxDelayMs)));
}

/**
 * A wait that a person can interrupt.
 *
 * `setTimeout` alone would keep her waiting for the full delay after she has already left
 * the screen, and then spend a request on her behalf. Every listener and timer is torn down
 * on both paths — a stray listener on a long-lived signal is a leak that only shows up on
 * the tenth scan.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve('aborted');
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * `Retry-After: 26` / `Retry-After: <HTTP-date>` / `{"retryDelay": "26s"}` → milliseconds.
 *
 * Exported because it is the fiddliest ten lines here and the one most likely to be handed
 * a shape nobody expected. Anything unparseable returns undefined, which simply means "use
 * our own backoff curve" — never a throw on a path that is already handling a failure.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;

  // "26s", "1.5s" — the protobuf Duration spelling used inside Google's error details.
  const duration = /^(\d+(?:\.\d+)?)s$/i.exec(text);
  if (duration?.[1] !== undefined) return Math.round(Number(duration[1]) * 1000);

  // A bare number is SECONDS, per RFC 9110. Reading it as milliseconds would turn a
  // 30-second wait into 30 milliseconds and hammer a service that just asked for room.
  if (/^\d+$/.test(text)) return Number(text) * 1000;

  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return undefined;
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Roughly how many bytes of photograph are about to leave the phone.
 *
 * Base64 carries 3 bytes in every 4 characters, so the decoded size is what a person on a
 * metered connection actually spends — quoting the encoded length would overstate her data
 * bill by a third. Padding is not subtracted: it is at most two characters per image and
 * the number is rendered as "about 1.4 MB".
 *
 * Computed per attempt rather than once, which costs a few additions and stays correct if a
 * caller ever varies the images between attempts. Nothing does today; `retry.ts`'s header
 * promises the opposite, and this is not the file that would break that promise.
 */
function inlineBytes(request: AiRequest): number {
  let total = 0;
  for (const image of request.images) total += Math.floor((image.base64.length * 3) / 4);
  return total;
}

/**
 * Stamps the whole operation onto the result.
 *
 * `elapsedMs` becomes the time SHE waited, across every attempt and every pause, rather
 * than the duration of whichever attempt happened to be last — that is the number
 * provenance and any future latency report should carry. `attempts` is how a support
 * conversation later can tell "it worked" from "it worked on the third ask".
 */
function tally(result: AiResult, attempts: number, elapsedMs: number): AiResult {
  // The two branches are identical on purpose: spreading a UNION into an object literal
  // loses the discriminant, so the union has to be narrowed first for this to typecheck.
  if (result.ok) return { ...result, attempts, elapsedMs };
  return { ...result, attempts, elapsedMs };
}

function cancelledAfter(
  last: AiResult | null,
  attempts: number,
  elapsedMs: number,
  where: string,
): AiFailure {
  const because = last && !last.ok ? ` after ${last.error.code}` : '';
  return {
    ok: false,
    // `cancelled` and not the last failure, because that is what happened: she left. The
    // failure that preceded it survives in `detail` for the support case.
    error: aiError('cancelled', { detail: `stopped ${where}${because}` }),
    modelId: last?.modelId ?? '',
    elapsedMs,
    attempts,
  };
}
