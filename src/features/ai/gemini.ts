/**
 * Gemini over raw `fetch`. There is no Node SDK in React Native, and there is no need
 * for one: `generateContent` is a single POST with a JSON body.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE SETTINGS PEOPLE GET WRONG, WRITTEN DOWN SO NOBODY "FIXES" THEM
 *
 *  1. `temperature: 1.0`, ALWAYS. The instinct on an extraction task is to drop it to 0
 *     for determinism. Gemini 3's documentation explicitly warns that lowering
 *     temperature causes looping and degraded reasoning — on a smudged handwritten line
 *     that shows up as the model repeating a drug name it already emitted. Determinism
 *     comes from `seed`. Do not touch this value.
 *
 *  2. `thinkingLevel`, not `thinkingBudget`. Gemini 3 replaced the token budget with a
 *     level. Sending the old field is silently ignored, which looks exactly like thinking
 *     being disabled and reads as "the model got worse for no reason".
 *
 *  3. NO `anyOf` ANYWHERE in the response schema. The structured-output subset excludes
 *     recursive schemas and most constraint keywords, and `propertyOrdering` behaviour
 *     inside a union is undocumented. Every optional-shaped field in this app's schema is
 *     therefore a flat field with an explicit "unknown" member instead of a union.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EVERY failure path below produces its own code. A generic catch-all here would collapse
 * "your key is wrong", "you have no signal" and "the model refused to look at this photo"
 * into one useless sentence — see ./errors.ts for why that matters more here than in most
 * apps.
 *
 * ONE REQUEST, ONE ANSWER. There is no retry loop in this file and there must not be one:
 * `createProvider()` in ./provider.ts wraps every provider in ./retry.ts, so a 503 is asked
 * again there, once, for everybody. What this file DOES owe the retry layer is the one
 * thing only it can see — whether the server named a delay of its own. That is parsed out
 * of `Retry-After` and `RetryInfo` below and travels on `AiError.retryAfterMs`.
 *
 * The import of `./retry` rather than `./provider` for `DEFAULT_TIMEOUT_MS` is deliberate:
 * it leaves this module with no runtime dependency on `provider.ts` (and therefore none on
 * `settings.ts` → `expo-sqlite`), which is what makes it loadable in a plain Node test
 * process with a stubbed `fetch`. See gemini.test.ts.
 */

import { record, isRecording } from '../devlog/recorder';
import { DEV_EVENTS } from '../devlog/types';
import { secretFields } from '../devlog/redact';
import { aiError, type AiError } from './errors';
import type {
  AiFailure,
  AiProvider,
  AiRequest,
  AiResult,
  AiUsage,
  ProviderConfig,
} from './provider';
import { DEFAULT_TIMEOUT_MS, parseRetryAfterMs } from './retry';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Fixed. See the header. This is not a tuning knob.
 */
const TEMPERATURE = 1.0;

/**
 * ─── THIS NUMBER WAS THE BUG. READ BEFORE LOWERING IT AGAIN. ─────────────────
 *
 * It used to be 8192, with a comment reasoning that 8192 was "enough for ~25 medicines
 * with per-field confidence", so a prescription that overran it was a photograph problem
 * and `MAX_TOKENS` said so honestly. Every clause of that is true about the ANSWER and
 * wrong about the BUDGET, because on Gemini 3 `maxOutputTokens` is not the answer's
 * allowance — it is the allowance for THINKING PLUS the answer, drawn from one pot.
 *
 * This app asks for `thinkingLevel: 'high'` on handwriting, against a schema with about
 * twenty-five required fields per medicine. High thinking on a smudged line routinely
 * costs thousands of tokens before a single character of JSON exists. So the sequence on
 * a real eight-drug prescription was: thinking spends the 8192, generation stops at
 * `MAX_TOKENS` with an empty text part, and the user is told "the prescription was too
 * long to read in one go — photograph fewer lines at a time". She photographs fewer
 * lines. It fails identically, because the budget went on thinking either way. Nothing is
 * auto-retried (`truncated` is not in RETRYABLE_CODES), so it reads as a permanent,
 * unexplainable refusal — which is exactly how it was reported: "AI prescription scanning
 * is not working."
 *
 * 32768 leaves room for the thinking this app deliberately buys AND the answer it needs,
 * and is well inside Gemini 3 Flash's output ceiling. IT COSTS NOTHING WHEN UNUSED — a
 * cap is not a spend, and a four-medicine prescription still emits four medicines' worth
 * of tokens. Lowering it to "save money" saves nothing and reinstates the defect.
 *
 * `finishReasonError()` below is handed the token counts and returns a DIFFERENT CODE for
 * the two cases — `thinking_budget_exhausted` when no answer was produced at all, and
 * `truncated` only when one was produced and cut. For a long time the comment here claimed
 * that and the function did not: it received `finishReason` and `text`, no usage numbers,
 * and could not have told them apart if it wanted to. Both cases came out `truncated`,
 * whose sentence is "photograph fewer lines at a time" — the advice that made the original
 * bug repeat. The claim is now true, and the numbers that prove it are on the `ai.response`
 * note beside the code.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

// ── Wire types (only the fields we actually read) ─────────────────────────────

type GeminiPart = {
  text?: string;
  /** Gemini 3 can return thought summaries as parts. They are NOT the answer. */
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
};

type GeminiCandidate = {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
};

type GeminiErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    /**
     * `google.rpc.RetryInfo` and friends. Typed loosely on purpose — this is an
     * open-ended array of `@type`-tagged messages and pinning a shape to it would break
     * the moment Google adds a member.
     */
    details?: readonly unknown[];
  };
};

// ── Provider ─────────────────────────────────────────────────────────────────

export function createGeminiProvider(config: ProviderConfig): AiProvider {
  return {
    id: 'gemini',
    modelId: config.modelId,
    generate: (request) => generate(config, request),
  };
}

async function generate(config: ProviderConfig, request: AiRequest): Promise<AiResult> {
  const startedAt = Date.now();
  const fail = (error: AiError): AiFailure => ({
    ok: false,
    error,
    modelId: config.modelId,
    elapsedMs: Date.now() - startedAt,
  });

  // ── 1. Key ────────────────────────────────────────────────────────────────
  // Read at call time, never captured. A key added in Settings must work on the very
  // next scan without restarting the app.
  let apiKey: string | null = null;
  try {
    apiKey = await config.getApiKey();
  } catch (error) {
    return fail(aiError('no_key', { detail: describe(error) }));
  }
  if (!apiKey) return fail(aiError('no_key'));

  // ── 2. Timeout, composed with the caller's own cancellation ───────────────
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) {
      clearTimeout(timer);
      return fail(aiError('cancelled'));
    }
    request.signal.addEventListener('abort', onCallerAbort);
  }

  const url = `${API_BASE}/models/${encodeURIComponent(config.modelId)}:generateContent`;
  const body = buildRequestBody(config, request);
  const payloadText = JSON.stringify(body);

  // WHAT WE ARE ABOUT TO ASK FOR, IN NUMBERS ONLY.
  //
  // This is the note that settles the argument the file header is about: `maxOutputTokens`
  // and `thinkingLevel` are right here beside the request size, so "the budget went on
  // thinking" stops being a theory somebody has to reconstruct. `secretFields` reduces the
  // key to present/length/shape — never the key, and never a prefix long enough to be one.
  // No prompt text, no base64, no image: `redact.ts` would refuse them anyway, and a field
  // it has to refuse is a field that should not have been offered.
  if (isRecording()) {
    record('info', 'ai', DEV_EVENTS.aiRequest, () => ({
      modelId: config.modelId,
      thinkingLevel: request.thinkingLevel ?? config.thinkingLevel,
      maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      images: request.images.length,
      requestBytes: payloadText.length,
      structured: request.responseSchema !== undefined,
      timeoutMs,
      ...secretFields(apiKey),
    }));
  }

  try {
    let response: Response;
    try {
      // SPLIT FROM ITS `await` ON PURPOSE — THIS IS THE PROGRESS BAR'S ONE HONEST MOMENT.
      //
      // Calling `fetch` hands the request to the platform; everything after this line is
      // waiting. That instant is invisible to every other layer (see the note on
      // `AiRequest.onRequestSent` in ./provider.ts), and it is what moves the screen from
      // "Sending the photo" to "The reader is looking at it. This is the long part." —
      // the sentence that stops a 200-second silence reading as a frozen phone.
      //
      // Being precise about what this does NOT mean: React Native's `fetch` reports no
      // upload progress, so the megabyte going up is counted inside the waiting phase
      // rather than beside it. The alternative is a bar that sits still through the only
      // part of a scan anybody notices, which is the defect this replaces.
      const pending = fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, not `?key=` — a query parameter ends up in proxy logs, crash
          // reports and anything that ever prints a URL.
          'x-goog-api-key': apiKey,
        },
        body: payloadText,
        signal: controller.signal,
      });
      // Guarded even though the contract says it must not throw. If it did, the throw
      // would escape BEFORE `pending` is awaited — leaving a live request nobody is
      // waiting on, whose eventual rejection surfaces as an unhandled rejection with no
      // connection to the scan that caused it. A narration callback is never worth that.
      try {
        request.onRequestSent?.();
      } catch {
        // The screen is mid-unmount, or a listener has an opinion. The request is fine.
      }
      response = await pending;
    } catch (error) {
      // fetch() rejects for exactly two reasons that matter: we aborted it, or the
      // request never left the phone.
      if (isAbort(error)) {
        const cancelled = !timedOut;
        if (isRecording()) {
          record(
            'warn',
            'ai',
            cancelled ? DEV_EVENTS.aiCancelled : DEV_EVENTS.aiHttp,
            cancelled
              ? { where: 'while waiting for the answer' }
              : { errorCode: 'timeout', timeoutMs },
          );
        }
        return fail(
          timedOut
            ? aiError('timeout', { detail: `no response in ${timeoutMs} ms` })
            : aiError('cancelled'),
        );
      }
      if (isRecording()) {
        record('warn', 'ai', DEV_EVENTS.aiHttp, () => ({
          errorCode: 'offline',
          // `errorName`, not `errorMessage`. The message field is refused outright by
          // `redact.ts` — a JS error message is not machine text, and this one printed a
          // constant `[blocked]`, which is worse than nothing because it looks like a
          // fact. The CLASS NAME survives the gate and is what actually separates the two
          // failures behind "offline": a `TypeError` is the request never leaving the
          // phone, an `AbortError` reaching here at all would mean `isAbort` is wrong.
          errorName: error instanceof Error ? error.name : typeof error,
        }));
      }
      return fail(aiError('offline', { detail: describe(error) }));
    }

    // ── 3. HTTP-level failures ──────────────────────────────────────────────
    if (!response.ok) {
      const raw = await safeText(response);
      // `headers.get` is defensive: a fetch polyfill that returns a bare object here would
      // otherwise throw INSIDE the failure path, replacing a precise 503 with a crash.
      const retryAfter =
        typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null;
      const error = httpError(response.status, raw, retryAfter);
      // Google's own words, kept verbatim-ish through the scrubber — and, beside them, the
      // three MACHINE facts the words only hint at.
      //
      // `apiReason` is `details[].reason`: API_KEY_ANDROID_APP_BLOCKED, SERVICE_DISABLED,
      // API_KEY_HTTP_REFERRER_BLOCKED. It is what decided the code above, so putting it on
      // the line means the log can be read as "this is why", not "this is what we guessed".
      // `quotaId` and `quotaValue` do the same job for the 429 — `quotaValue=0` is the one
      // fact in the whole body that says waiting cannot work, and it appears nowhere in the
      // sentence Google sends.
      //
      // All three are safe by the rule in devlog/redact.ts: `apiReason` and `quotaId` are
      // enums and identifiers from the wire (allowed by name, then washed), and
      // `quotaValue` travels as a NUMBER — a limit, not a measurement, and not named after
      // one. None of them can carry a word off the prescription.
      if (isRecording()) {
        const parsed = parseErrorBody(raw);
        const quota = quotaFromDetails(parsed);
        record('error', 'ai', DEV_EVENTS.aiHttp, () => ({
          httpStatus: response.status,
          errorCode: error.code,
          apiStatus: parsed?.error?.status ?? null,
          apiReason: errorReasonFromDetails(parsed),
          apiMessage: parsed?.error?.message ?? snippet(raw),
          quotaId: quota.id,
          quotaValue: quota.value,
          retryAfterHeader: retryAfter,
          retryAfterMs: error.retryAfterMs ?? null,
        }));
      }
      return fail(error);
    }

    // ── 4. Body ─────────────────────────────────────────────────────────────
    const raw = await safeText(response);
    let payload: GeminiResponse;
    try {
      payload = JSON.parse(raw) as GeminiResponse;
    } catch {
      // A 200 whose body is not JSON is almost always a captive portal or a
      // transparent proxy having an opinion about the connection.
      return fail(aiError('malformed_json', { detail: `envelope: ${snippet(raw)}` }));
    }

    // ── 5. Blocked before generation ────────────────────────────────────────
    const blockReason = payload.promptFeedback?.blockReason;
    if (blockReason) {
      return fail(
        aiError('safety_blocked_prompt', {
          detail: `${blockReason}${
            payload.promptFeedback?.blockReasonMessage
              ? `: ${payload.promptFeedback.blockReasonMessage}`
              : ''
          }`,
        }),
      );
    }

    // ── 6. Blocked, cut off, or empty during generation ─────────────────────
    const candidate = payload.candidates?.[0];
    if (!candidate) return fail(aiError('no_content', { detail: 'no candidates returned' }));

    const finishReason = candidate.finishReason ?? 'STOP';
    // Thought parts are the model narrating to itself. Concatenating them into the
    // answer produces a JSON.parse failure that looks like a model bug.
    const text = (candidate.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    // THE NOTE THAT DIAGNOSES THE BUG IN THIS FILE'S HEADER.
    //
    // `thoughtTokens` beside `outputTokens` and `finishReason=MAX_TOKENS` is the whole
    // story of a scan whose budget went on thinking, told in three numbers. `textParts`
    // versus `thoughtParts` catches the other shape of the same failure — a response that
    // is all reasoning and no answer. Written BEFORE `finishReasonError` decides the
    // outcome, so the note survives the failure rather than being skipped by it.
    // Read ONCE, above the log, because `finishReasonError` needs the same numbers to
    // decide between "the answer was cut" and "there was never an answer". Reading it
    // inside the recording branch is how the log came to know something the code did not.
    const usage = readUsage(payload);

    if (isRecording()) {
      const parts = candidate.content?.parts ?? [];
      record('info', 'ai', DEV_EVENTS.aiResponse, () => ({
        finishReason,
        modelVersion: payload.modelVersion ?? null,
        parts: parts.length,
        thoughtParts: parts.filter((part) => part.thought === true).length,
        textChars: text.length,
        promptTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtTokens: usage.thoughtTokens,
        totalTokens: usage.totalTokens,
      }));
    }

    const finishFailure = finishReasonError(finishReason, text, usage);
    if (finishFailure) return fail(finishFailure);

    if (text.length === 0) {
      return fail(aiError('no_content', { detail: `finishReason=${finishReason}, no text part` }));
    }

    // ── 7. JSON ─────────────────────────────────────────────────────────────
    // Only when structured output was actually requested. `testKey()` asks for one word
    // of prose, and parsing that as JSON would report a perfectly good key as broken.
    let json: unknown = null;
    if (request.responseSchema !== undefined) {
      try {
        json = JSON.parse(stripCodeFence(text));
      } catch (error) {
        return fail(aiError('malformed_json', { detail: `${describe(error)} · ${snippet(text)}` }));
      }

      // KEY NAMES AND COUNTS. NEVER VALUES.
      //
      // `topKeys` is our own schema's field list (`prescriptions/schema.ts`), fixed at build
      // time, and `arrayCounts` is "medicines=7" — how many things were read, never what
      // they were. That pair answers the report this feature exists for: "scanning is not
      // working" is a different bug when the answer parsed and held seven medicines than
      // when it parsed and held none. `redact.ts` allows exactly these two field names, and
      // its comment beside them says why; do not widen this to sample a value.
      if (isRecording()) {
        record('info', 'ai', DEV_EVENTS.aiParse, () => ({
          topKeys: topLevelKeys(json),
          arrayCounts: arrayCounts(json),
          empty: isStructurallyEmpty(json),
        }));
      }

      // A schema-valid but EMPTY object is its own failure. It is not a parse problem and
      // it is not a model refusal — it is "the model looked and found nothing", and the
      // only useful response to it is a better photograph.
      if (isStructurallyEmpty(json)) {
        return fail(aiError('empty_result', { detail: 'response contained no fields' }));
      }
    }

    return {
      ok: true,
      text,
      json,
      usage,
      modelId: payload.modelVersion ?? config.modelId,
      finishReason,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}

// ── Request body ─────────────────────────────────────────────────────────────

function buildRequestBody(config: ProviderConfig, request: AiRequest): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];
  for (const image of request.images) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
  }

  const generationConfig: Record<string, unknown> = {
    // See the file header. Not a knob.
    temperature: TEMPERATURE,
    candidateCount: 1,
    maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingConfig: { thinkingLevel: request.thinkingLevel ?? config.thinkingLevel },
  };
  if (request.seed !== undefined) generationConfig['seed'] = request.seed;
  if (request.responseSchema !== undefined) {
    generationConfig['responseMimeType'] = 'application/json';
    generationConfig['responseSchema'] = request.responseSchema;
  }

  // safetySettings is deliberately NOT sent. The default thresholds are what the
  // `safety_blocked_prompt` / `safety_blocked_response` codes are calibrated against, and
  // a category name that has drifted turns every scan into a hard 400 — a far worse
  // failure than the occasional block those settings would have avoided. If blocks ever
  // become common in the field, add it here deliberately and re-test, do not guess.
  return {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
}

// ── Failure mapping ──────────────────────────────────────────────────────────

function httpError(status: number, raw: string, retryAfterHeader: string | null = null): AiError {
  const parsed = parseErrorBody(raw);
  const message = parsed?.error?.message ?? snippet(raw);
  const apiStatus = parsed?.error?.status ?? '';
  const baseDetail = `HTTP ${status}${apiStatus ? ` ${apiStatus}` : ''}: ${message}`;

  // Google's machine-readable account of the same failure. Read BEFORE the message,
  // everywhere it exists, for the reason written out over `errorReasonFromDetails`.
  const reason = errorReasonFromDetails(parsed);
  const detail = reason === null ? baseDetail : `${baseDetail} · reason=${reason}`;

  // Only ever ADVICE, and only consulted for a code the retry layer already considers
  // transient. A `Retry-After` on a 403 does not make a wrong key worth asking about twice.
  const retryAfterMs =
    parseRetryAfterMs(retryDelayFromDetails(parsed)) ?? parseRetryAfterMs(retryAfterHeader);
  const advised = retryAfterMs !== undefined ? { retryAfterMs } : {};

  if (status === 400) {
    // Google returns 400 INVALID_ARGUMENT both for a malformed request AND for a key
    // that is not a key at all. Telling those apart matters: one is our bug, the other
    // is a settings problem the user can fix in ten seconds. The enum decides when it is
    // there, the prose when it is not.
    if (reason === 'API_KEY_INVALID' || /api[\s_-]?key/i.test(message)) {
      return aiError('invalid_key', { detail, httpStatus: status });
    }
    return aiError('bad_request', { detail, httpStatus: status });
  }
  if (status === 401 || status === 403) {
    // ─── FOUR FAULTS, ONE STATUS, AND THE ENUM THAT SEPARATES THEM ──────────
    //
    // A 403 from this endpoint can mean: the key is restricted to an Android app or a
    // website; the API is switched off for its project; the key really is wrong or
    // revoked. Those take three different actions in three different places, and until
    // this branch existed all of them said "check the key in Settings" — the correct
    // action for exactly one of them, and an evening with no end for the other two.
    //
    // `reason` is what Google itself calls the fault. Anything it does not name falls
    // through to `invalid_key`, deliberately: an unrecognised reason still reaches the
    // log (see the `ai.http` note), so a fault we have not met yet is visible without
    // this branch inventing a sentence about it.
    if (reason !== null && KEY_RESTRICTION_REASONS.has(reason)) {
      return aiError('key_restricted', { detail, httpStatus: status });
    }
    if (reason !== null && API_OFF_REASONS.has(reason)) {
      return aiError('api_not_enabled', { detail, httpStatus: status });
    }
    return aiError('invalid_key', { detail, httpStatus: status });
  }
  if (status === 404) return aiError('model_not_found', { detail, httpStatus: status });
  if (status === 429) {
    // THREE FAULTS, ONE STATUS. A per-minute limit clears itself in a minute; a per-day
    // limit does not clear until tomorrow; a limit of ZERO never clears at all, and the
    // free tier reports all three with the same generic sentence. Only the first is ever
    // retried automatically — see RETRYABLE_CODES in ./retry.ts.
    const quota = quotaFromDetails(parsed);
    const quotaDetail = `${detail}${quota.id === null ? '' : ` · quotaId=${quota.id}`}${
      quota.value === null ? '' : ` · quotaValue=${quota.value}`
    }`;

    // Zero first, and ahead of the day/minute question, because it answers a different
    // one. "Used up" and "does not exist" are not degrees of the same thing: one of them
    // ends tomorrow morning and the other one never ends.
    if (quota.value === 0) {
      return aiError('quota_zero', { detail: quotaDetail, httpStatus: status });
    }
    return isDailyQuota(quota.id, message)
      ? aiError('quota_exhausted', { detail: quotaDetail, httpStatus: status })
      : aiError('rate_limited', { detail: quotaDetail, httpStatus: status, ...advised });
  }
  if (status === 503) {
    return aiError('service_overloaded', { detail, httpStatus: status, ...advised });
  }
  if (status >= 500) return aiError('server_error', { detail, httpStatus: status, ...advised });
  return aiError('unknown', { detail, httpStatus: status });
}

/**
 * `error.details[].retryDelay` — the server's own answer to "when should I ask again".
 *
 * Google returns it as a protobuf Duration string ("26s") inside an `@type`-tagged
 * `google.rpc.RetryInfo` member of an open-ended array. Everything here is written to
 * survive that array containing something else entirely, because it frequently does: this
 * runs while the request has ALREADY failed, and a throw here would replace a precise,
 * actionable error code with an unhandled rejection.
 */
function retryDelayFromDetails(parsed: GeminiErrorBody | null): string | null {
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue;
    const delay = (entry as { retryDelay?: unknown }).retryDelay;
    if (typeof delay === 'string' && delay.length > 0) return delay;
  }
  return null;
}

/**
 * `error.details[].reason` — Google's own name for the fault, from `google.rpc.ErrorInfo`.
 *
 * ─── WHY A SHORT ENUM BEATS THE SENTENCE BESIDE IT ───────────────────────────
 *
 * The prose in `error.message` is written for a human, is not part of any contract, is
 * ENGLISH, and is capped at 300 characters by the log scrubber — the SERVICE_DISABLED
 * message is long enough that its tail is lost, and the tail is the "wait a few minutes
 * for the action to propagate" half. `reason` is a documented, stable identifier that says
 * the same thing in twenty characters. Matching on prose is how a working diagnosis stops
 * working the week Google rewords a sentence, silently, on a phone in another country.
 *
 * The SHAPE is checked rather than trusted. This value decides a user-facing sentence and
 * is printed into a log built to be pasted into a chat window, so anything that is not a
 * SCREAMING_SNAKE identifier is treated as absent — a body carrying prose, a URL or
 * somebody's idea of a joke under this key gets the generic path, not a starring role.
 */
const REASON_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

function errorReasonFromDetails(parsed: GeminiErrorBody | null): string | null {
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue;
    const reason = (entry as { reason?: unknown }).reason;
    if (typeof reason === 'string' && REASON_SHAPE.test(reason)) return reason;
  }
  return null;
}

/**
 * The 403 reasons that mean THE KEY IS CORRECT AND CANNOT BE USED FROM HERE.
 *
 * Every one of them is a restriction Google enforces by reading a header that this app
 * does not send and cannot send: `X-Android-Package` and `X-Android-Cert` come from
 * Google's own Android SDKs, `Referer` comes from a browser, and the IP of a phone on
 * mobile data is not a thing anybody can allow-list. `gemini.ts` is a plain `fetch` with
 * one `x-goog-api-key` header, so the restriction is unsatisfiable BY CONSTRUCTION, and a
 * freshly generated key carrying the same restriction fails in exactly the same way.
 *
 * They are one code rather than four because they take one action: remove the application
 * restriction in Google Cloud Console. Which of them it was is in the log, on `apiReason`.
 */
const KEY_RESTRICTION_REASONS: ReadonlySet<string> = new Set([
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
]);

/**
 * The 403 reasons that mean THE KEY IS CORRECT AND THE API IS NOT AVAILABLE TO IT.
 *
 * `SERVICE_DISABLED` is the project-level fact (the Generative Language API was never
 * switched on) and `API_KEY_SERVICE_BLOCKED` is the key-level one (the key carries an API
 * restriction that does not include this API). Same console, adjacent screens, and neither
 * is fixed by touching anything on the phone — which is the distinction that matters, and
 * the reason they share a sentence. `apiReason` in the log says which.
 */
const API_OFF_REASONS: ReadonlySet<string> = new Set([
  'SERVICE_DISABLED',
  'API_KEY_SERVICE_BLOCKED',
]);

/**
 * What `google.rpc.QuotaFailure` says about the limit that was hit.
 *
 * `id` is `quotaId` — an identifier like GenerateRequestsPerDayPerProjectPerModel-FreeTier,
 * which names the PERIOD the message frequently does not. `value` is `quotaValue`, the
 * limit itself, and a limit of 0 is its own diagnosis: a project that has never had the
 * API enabled reports zero, and no amount of waiting turns zero into one.
 */
type QuotaFact = { readonly id: string | null; readonly value: number | null };

const NO_QUOTA: QuotaFact = { id: null, value: null };

function quotaFromDetails(parsed: GeminiErrorBody | null): QuotaFact {
  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return NO_QUOTA;

  let first: QuotaFact | null = null;
  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue;
    const violations = (entry as { violations?: unknown }).violations;
    if (!Array.isArray(violations)) continue;
    for (const violation of violations) {
      if (violation === null || typeof violation !== 'object') continue;
      const fact = {
        id: quotaIdOf((violation as { quotaId?: unknown }).quotaId),
        value: quotaValueOf((violation as { quotaValue?: unknown }).quotaValue),
      };
      if (fact.id === null && fact.value === null) continue;
      // A zero WINS over anything earlier in the array. A body naming two violations —
      // say a per-minute limit and a per-day limit of zero — has one fact in it worth
      // acting on, and it is not the one that happened to be listed first.
      if (fact.value === 0) return fact;
      first ??= fact;
    }
  }
  return first ?? NO_QUOTA;
}

/** Bounded, because it is printed into the log and into `prescription.extraction_error`. */
function quotaIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/**
 * `quotaValue` arrives as a protobuf int64, which JSON spells as a STRING ("0").
 *
 * TRAP, AND IT IS THE EXPENSIVE DIRECTION: `Number('')` is 0, and so is `Number(' ')` and
 * `Number(null)`. Handing this straight to `Number()` would turn a body with an empty or
 * absent quota field into a confident "this project has no allowance at all" — the one
 * sentence in the table that tells somebody their setup is broken when it is not. So a
 * string has to LOOK like a whole number before it is read as one.
 */
function quotaValueOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * Per-day or per-minute, decided on the identifier first and the prose second.
 *
 * ─── WHY THE ORDER IS THIS WAY ROUND, WRITTEN AS THE FAILURE IT PREVENTS ─────
 *
 * The free tier's 429 message is generic: "You exceeded your current quota, please check
 * your plan and billing details." It contains none of "day", "daily" or "per day". The
 * per-DAY fact is in `quotaId`, and for a long time nothing here read it — so the daily
 * 429 came out as `rate_limited`, whose sentence is "wait a minute and try again", for a
 * limit at which no minute exists. She waits, taps again, spends another request out of an
 * allowance that is already gone, and the app says the same thing forever.
 *
 * The prose match is KEPT as the fallback rather than deleted. Older 429s name the quota
 * inside the message and carry no `details` at all, and a shape can change back — a
 * discriminator with one source is a discriminator with one point of failure.
 */
const PER_DAY_ID = /per\s*day/i;
const PER_MINUTE_ID = /per\s*minute/i;
const PER_DAY_MESSAGE = /per\s*day|daily|PerDay|requests per day/i;

function isDailyQuota(quotaId: string | null, message: string): boolean {
  if (quotaId !== null) {
    if (PER_DAY_ID.test(quotaId)) return true;
    // A quotaId that names the minute settles it too — and only then does the message get
    // a vote, because an id naming neither period is not evidence about either.
    if (PER_MINUTE_ID.test(quotaId)) return false;
  }
  return PER_DAY_MESSAGE.test(message);
}

/**
 * `finishReason` is the model's own account of why it stopped, and each value needs a
 * different sentence:
 *   MAX_TOKENS  — the budget ran out. TWO FAULTS WEAR THIS ONE VALUE, see below.
 *   SAFETY / PROHIBITED_CONTENT / SPII / IMAGE_SAFETY — it refused. Retrying is pointless.
 *   RECITATION  — it stopped to avoid reproducing memorised text.
 *   anything else with no text — unclassified emptiness.
 *
 * ─── WHY THIS TAKES `usage`, AND WHY IT IS NOT OPTIONAL ──────────────────────
 *
 * `maxOutputTokens` is a COMBINED thinking + answer budget (see the constant at the top of
 * this file), so MAX_TOKENS means one of two completely different things:
 *
 *   an answer was produced and then cut   → the prescription really is long for one photo,
 *                                           and "photograph fewer lines" is sound advice.
 *   no answer was produced at all         → the thinking spent the pot first. Fewer lines
 *                                           spend the same thinking and fail identically,
 *                                           so that advice is not merely useless, it sends
 *                                           somebody round the loop that produced the
 *                                           original report.
 *
 * Nothing in `finishReason` separates them, and nothing in `text` does either once it is
 * empty — the ONLY witness is the token counts. `outputTokens` is the honest discriminator
 * and `text.length` is the corroborating one: a body with no `usageMetadata` at all still
 * lands on `truncated` when it carried a fragment of an answer, which is the conservative
 * direction (the older, blunter sentence) rather than a guess.
 */
function finishReasonError(finishReason: string, text: string, usage: AiUsage): AiError | null {
  switch (finishReason) {
    case 'STOP':
      return null;
    case 'MAX_TOKENS': {
      // The JSON is provably incomplete either way, so it is never parsed: parsing would
      // either throw or — worse — succeed on a truncated medicine list and silently drop
      // the last drug.
      const answerStarted = text.length > 0 || usage.outputTokens > 0;
      if (!answerStarted && usage.thoughtTokens > 0) {
        return aiError('thinking_budget_exhausted', {
          detail:
            `no answer was produced: thoughtTokens=${usage.thoughtTokens}, ` +
            `outputTokens=${usage.outputTokens}, textChars=0`,
        });
      }
      return aiError('truncated', {
        detail:
          `output stopped at the token limit after ${text.length} characters ` +
          `(outputTokens=${usage.outputTokens}, thoughtTokens=${usage.thoughtTokens})`,
      });
    }
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return aiError('safety_blocked_response', { detail: `finishReason=${finishReason}` });
    case 'RECITATION':
      return aiError('recitation', { detail: `finishReason=${finishReason}` });
    default:
      if (text.length > 0) return null; // e.g. FINISH_REASON_UNSPECIFIED with a full answer.
      return aiError('no_content', { detail: `finishReason=${finishReason}` });
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

function readUsage(payload: GeminiResponse): AiUsage {
  const usage = payload.usageMetadata ?? {};
  const input = numberOr(usage.promptTokenCount, 0);
  const output = numberOr(usage.candidatesTokenCount, 0);
  const thoughts = numberOr(usage.thoughtsTokenCount, 0);
  return {
    inputTokens: input,
    outputTokens: output,
    thoughtTokens: thoughts,
    // Thinking tokens are billed as output but reported separately, so a total built by
    // adding only prompt + candidates understates the bill on a thinking model.
    totalTokens: numberOr(usage.totalTokenCount, input + output + thoughts),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseErrorBody(raw: string): GeminiErrorBody | null {
  try {
    return JSON.parse(raw) as GeminiErrorBody;
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    return `<body unreadable: ${describe(error)}>`;
  }
}

/**
 * Models occasionally wrap JSON in a markdown fence even when `responseMimeType` is
 * `application/json`. Stripping it is three lines and removes a whole class of
 * "malformed JSON" reports that are not malformed at all.
 */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return fenced?.[1] ?? text;
}

function isStructurallyEmpty(json: unknown): boolean {
  if (json === null || json === undefined) return true;
  if (Array.isArray(json)) return json.length === 0;
  if (typeof json === 'object') return Object.keys(json).length === 0;
  return false;
}

/**
 * The parsed answer's TOP-LEVEL FIELD NAMES, for the log. 'medicines, prescriber, clinic'.
 *
 * ─── WHY THIS IS SAFE, STATED PRECISELY, BECAUSE IT LOOKS LIKE IT IS NOT ─────
 *
 * These are OUR key names, not the model's content. The response schema is fixed in
 * `prescriptions/schema.ts` and shipped in the binary, so the set of strings this can
 * possibly emit is known at build time and contains nothing read off a prescription. That
 * is the entire justification, and it is why the function is capped at the TOP level: one
 * step deeper and it would start reporting the keys of objects the model composed.
 *
 * `redact.ts` allows the field name `topkeys` on exactly this reasoning — its comment there
 * and this one have to stay true together. Anyone tempted to make this recursive, or to
 * include a value alongside a key, is looking at the wrong function: there is no version of
 * "just a sample" that does not put a drug name in a log built to be pasted into a chat
 * window with a stranger.
 */
function topLevelKeys(json: unknown): string {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return '';
  return Object.keys(json).slice(0, 24).join(', ');
}

/**
 * 'medicines=7, testsAdvised=2' — how many things came back under each top-level array.
 *
 * The number is the diagnosis. "Scanning is not working" with `medicines=0` is a photograph
 * or a crop problem; the same sentence with `medicines=7` is a parse or a confirm problem,
 * and those get looked at in completely different places. Same top-level-only rule, same
 * reason, as `topLevelKeys`.
 */
function arrayCounts(json: unknown): string {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return '';
  const counts: string[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (Array.isArray(value)) counts.push(`${key}=${value.length}`);
  }
  return counts.slice(0, 12).join(', ');
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Bounded so a 40 KB HTML error page cannot end up inside `extraction_error`. */
function snippet(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
