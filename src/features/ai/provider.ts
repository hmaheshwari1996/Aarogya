/**
 * The provider boundary. One interface, one factory, one place to change.
 *
 * THE POINT OF THIS FILE: everything above it — `prescriptions/extract.ts`, the review
 * screen, `care/calendar.ts` — talks about "an image and a prompt in, parsed JSON out".
 * Nothing above it knows the word "Gemini", the shape of a `generateContent` body, or
 * that `thinkingLevel` exists. Swapping to Claude or OpenAI is therefore one new file
 * implementing `AiProvider` plus one line in `FACTORIES` below, not an edit spread across
 * the extraction pipeline.
 *
 * `generate()` RETURNS failures, it does not throw them. A thrown error loses the
 * distinction between "no key", "no signal" and "the model refused" by the time it
 * reaches a catch block three frames up, and those three need three different sentences
 * in front of the user. See `./errors.ts`.
 *
 * RETRYING LIVES HERE, NOT IN THE PROVIDER. `createProvider()` wraps whatever the factory
 * returns in `generateWithRetry` (see `./retry.ts`), so a transient 503 is asked again
 * without the user tapping, and so every future provider inherits the same bounded,
 * cancellable, narrated policy instead of inventing its own. A provider implementation
 * therefore performs exactly ONE HTTP request and knows nothing about attempts.
 */

import type { AiError } from './errors';
import { createGeminiProvider } from './gemini';
import { generateWithRetry, type AiAttemptListener, type RetryPolicy } from './retry';
import {
  DEFAULT_THINKING_LEVEL,
  getAiSettings,
  type AiProviderId,
  type ThinkingLevel,
} from './settings';

// ── Request ──────────────────────────────────────────────────────────────────

export type AiImagePart = {
  /** 'image/jpeg' for everything this app sends. */
  readonly mimeType: string;
  /** Base64 with no newlines. See imagePrep.ts — whitespace is stripped there. */
  readonly base64: string;
};

export type AiRequest = {
  /** The full instruction text. See prescriptions/prompt.ts. */
  readonly prompt: string;
  readonly images: readonly AiImagePart[];
  /**
   * Provider-native JSON schema for structured output. Kept `unknown` on purpose: this
   * is the one part of the contract that is genuinely provider-specific, and pretending
   * otherwise would mean inventing a lowest-common-denominator schema language.
   */
  readonly responseSchema?: unknown;
  /**
   * Determinism comes from HERE, never from temperature.
   *
   * Gemini 3's own documentation warns that lowering temperature causes looping and
   * degraded reasoning, so the provider pins temperature at 1.0 and varies only the seed.
   * Re-reading the same photo with the same seed gives the same answer, which is what
   * makes a "read it again" button meaningful.
   */
  readonly seed?: number;
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxOutputTokens?: number;
  /**
   * Per ATTEMPT, not for the whole operation. Defaults to `DEFAULT_TIMEOUT_MS`.
   *
   * The retry wrapper never hands an attempt more than this, and hands later attempts less
   * when the overall budget has been eaten — see `retry.ts`.
   */
  readonly timeoutMs?: number;
  /**
   * Caller-owned cancellation (the user navigating away), separate from the timeout.
   *
   * It also stops the RETRY sequence, including mid-wait. Passing it is the only way the
   * app can promise that backing out of the scan screen stops spending her free quota, so
   * a screen that starts an extraction should always own one.
   */
  readonly signal?: AbortSignal;
  /**
   * Called before every attempt, and before every wait between attempts.
   *
   * THIS IS HOW SHE KNOWS IT IS STILL TRYING. Without it a retry is indistinguishable from
   * a frozen screen, which is a worse experience than the failure being retried. Synchronous
   * and best-effort: it is invoked inside the retry loop, so it must not throw and must not
   * block. See `AiAttemptEvent` in `./retry.ts` for the shape and for the copy it implies.
   */
  readonly onAttempt?: AiAttemptListener;
  /**
   * Called by the provider at the ONE moment it can see and the retry layer cannot: the
   * request has been handed to the platform and there is nothing left to do but wait.
   *
   * ─── WHY THIS EXISTS AT ALL, AND WHY IT TAKES NO ARGUMENTS ─────────────────
   *
   * The progress bar has two phases either side of this instant — `sending` ("Sending the
   * photo, about 1.4 MB") and `reading` ("The reader is looking at it. This is the long
   * part."). That second sentence is the one that matters: it is what stops a woman in a
   * clinic corridor deciding a 200-second silence means the phone has frozen. Showing it
   * requires knowing when the request left, and NOTHING ELSE IN THE APP KNOWS THAT.
   * `generateWithRetry` sees one opaque `await generate(...)`; React Native's `fetch`
   * reports no upload progress, and for a non-streaming `generateContent` the promise does
   * not settle until the model has finished thinking — so by the time the retry layer is
   * given control again, the long part is already over.
   *
   * It takes NO ARGUMENTS on purpose. Everything a progress event needs beyond "it has
   * gone" — which attempt this is, how many are allowed — belongs to the retry layer, and
   * the retry layer supplies this callback with those numbers already bound. That is what
   * keeps the sentence at the top of this file true: a provider performs exactly one HTTP
   * request and knows nothing about attempts. It reports an instant, not a position.
   *
   * Narration only. Synchronous, must not throw, must not block — same contract as
   * `onAttempt`. A provider that never calls it is correct, merely quieter.
   */
  readonly onRequestSent?: () => void;
  /**
   * Overrides for the retry policy. Omit it — the default is the considered one.
   *
   * `{ maxAttempts: 1 }` disables retrying for one call, which is the only override with an
   * obvious use: a caller that wants to show a failure the instant it happens.
   */
  readonly retry?: Partial<RetryPolicy>;
};

// ── Result ───────────────────────────────────────────────────────────────────

export type AiUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Reasoning tokens. Billed as output, reported separately by Gemini 3. */
  readonly thoughtTokens: number;
  readonly totalTokens: number;
};

/**
 * `elapsedMs` and `attempts` are both about the WHOLE operation.
 *
 * A provider fills in `elapsedMs` for its single request; the retry wrapper then replaces
 * it with the time the user actually waited — every attempt plus every pause between them
 * — and sets `attempts`. That is the number worth storing in provenance: "it took 40
 * seconds and needed three asks" is a support conversation, "the third attempt took two
 * seconds" is a fragment of one.
 */
export type AiSuccess = {
  readonly ok: true;
  /** The raw text the model returned, kept for debugging a bad parse. */
  readonly text: string;
  /** `JSON.parse` of that text. Shape is the caller's problem — validate it with zod. */
  readonly json: unknown;
  readonly usage: AiUsage;
  readonly modelId: string;
  readonly finishReason: string;
  readonly elapsedMs: number;
  /** 1 when it worked first time. Absent only if a provider was called without the wrapper. */
  readonly attempts?: number;
};

export type AiFailure = {
  readonly ok: false;
  readonly error: AiError;
  readonly modelId: string;
  readonly elapsedMs: number;
  /** How many times we asked before giving up. See `AiSuccess.attempts`. */
  readonly attempts?: number;
};

export type AiResult = AiSuccess | AiFailure;

// ── The interface ────────────────────────────────────────────────────────────

export type AiProvider = {
  readonly id: AiProviderId;
  readonly modelId: string;
  generate(request: AiRequest): Promise<AiResult>;
};

export type ProviderConfig = {
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  /**
   * Supplied by the caller so the provider never reaches into SecureStore itself.
   * `keyStore.ts` owns key storage; the provider owns the wire format. Keeping those
   * apart is what lets `testKey()` verify a key that has not been saved yet.
   */
  getApiKey(): Promise<string | null>;
};

/**
 * The per-attempt timeout, and the retry vocabulary, both re-exported from `./retry.ts`.
 *
 * They live there because they are one set of numbers that decide together how long a
 * person waits, and every existing importer knows this file. Moving them was not cosmetic:
 * it also broke the runtime dependency from `gemini.ts` onto this module, which is what
 * lets the provider be exercised in a plain `node --test` process with a stubbed `fetch`
 * instead of only on a device.
 */
export { DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_POLICY, RETRYABLE_CODES, isRetryable } from './retry';
export type { AiAttemptEvent, AiAttemptListener, RetryPolicy } from './retry';

type ProviderFactory = (config: ProviderConfig) => AiProvider;

/** Add a provider: write the file, add the line. Nothing else in the app changes. */
const FACTORIES: Record<AiProviderId, ProviderFactory> = {
  gemini: createGeminiProvider,
};

/**
 * The configured provider, wrapped in the retry policy.
 *
 * EVERY path to a model goes through here — `getProvider()` for a scan, `testKey()` for a
 * key check — so wrapping at this one point is what makes "a busy model is asked again"
 * true of the whole app rather than of one screen. The wrapper is transparent: it returns
 * the provider's own `AiResult`, so nothing downstream has to know it exists.
 */
export function createProvider(providerId: AiProviderId, config: ProviderConfig): AiProvider {
  const provider = FACTORIES[providerId](config);
  return {
    id: provider.id,
    modelId: provider.modelId,
    generate: (request) => generateWithRetry((attempt) => provider.generate(attempt), request),
  };
}

/**
 * The configured provider, ready to call.
 *
 * `getApiKey` is passed as a thunk rather than a value so the key is read at the moment
 * of the request. A provider object held across a settings change would otherwise keep
 * using the key it captured, and "I fixed the key but it still says it is wrong" is an
 * unfalsifiable bug report.
 */
export async function getProvider(
  overrides: { modelId?: string; thinkingLevel?: ThinkingLevel } = {},
): Promise<AiProvider> {
  const settings = await getAiSettings();
  const { getApiKey } = await import('./keyStore');
  return createProvider(settings.providerId, {
    modelId: overrides.modelId ?? settings.modelId,
    thinkingLevel: overrides.thinkingLevel ?? settings.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    getApiKey: () => getApiKey(settings.providerId),
  });
}
