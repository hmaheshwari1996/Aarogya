/**
 * The API key: stored in the Android keystore, asked for once, verified before it is
 * relied on.
 *
 * THREE RULES THIS FILE ENFORCES
 *
 *  1. NEVER A LAUNCH BLOCKER. Nothing here throws and nothing here is called during
 *     start-up. A missing key is a normal state of this app: everything except reading a
 *     photograph of a prescription works without one, and the medicines can always be
 *     typed in by hand. The key is prompted for lazily, on the first scan, and refusing
 *     to supply it must leave a working app.
 *
 *  2. VERIFY BEFORE RELYING. `testKey()` makes one real call against the cheapest model,
 *     because the alternative is that a mistyped key fails for the first time in a clinic
 *     corridor with a prescription in one hand — the exact moment the app must not need
 *     debugging.
 *
 *  3. THE KEY IS NEVER LOGGED, NEVER PUT IN A URL, AND NEVER RETURNED TO A SCREEN THAT
 *     ONLY NEEDS TO KNOW WHETHER ONE EXISTS. `hasKey()` is what the settings screen calls.
 */

import * as SecureStore from 'expo-secure-store';

import { aiError, type AiError, type AiErrorCode } from './errors';
import { createProvider } from './provider';
import { KEY_TEST_MODEL_ID, type AiProviderId } from './settings';

/**
 * THE STORAGE KEY IS SHARED WITH THE SETTINGS SCREEN, ON PURPOSE.
 *
 * `src/app/_shared/lib.tsx` owns the entry field and writes the key under
 * 'aarogya_ai_api_key'. Reading it under a different name here would mean a key the user
 * has just typed into Settings is invisible to the scanner — which presents as "add a
 * key" on a phone that already has one, and is unfixable from the user's side.
 *
 * A second provider would get its own name; today there is one, and it uses the name the
 * screen already writes. SecureStore keys may contain only alphanumerics, '.', '-', '_'.
 */
const SHARED_KEY_NAME = 'aarogya_ai_api_key';

function storeKeyFor(providerId: AiProviderId): string {
  return providerId === 'gemini' ? SHARED_KEY_NAME : `aarogya_ai_key_${providerId}`;
}

/**
 * Reads the stored key, or null.
 *
 * Swallows every failure on purpose. A keystore that is unavailable (a corrupt keystore
 * after a bad restore, a device in a state the OS will not decrypt for) must present as
 * "no key" — which the app already handles gracefully — rather than as a crash on the
 * scan screen.
 */
export async function getApiKey(providerId: AiProviderId = 'gemini'): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(storeKeyFor(providerId));
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    console.warn('[keyStore] could not read the stored key', describe(error));
    return null;
  }
}

export async function hasKey(providerId: AiProviderId = 'gemini'): Promise<boolean> {
  return (await getApiKey(providerId)) !== null;
}

/**
 * Saves the key.
 *
 * TRIMMED, always. A key pasted from an email or a browser arrives with a trailing
 * newline more often than not, and an untrimmed key produces a 400 whose message talks
 * about an invalid argument — sending the user hunting for a problem that is one
 * whitespace character long.
 */
export async function setApiKey(key: string, providerId: AiProviderId = 'gemini'): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error('An empty key cannot be saved.');
  await SecureStore.setItemAsync(storeKeyFor(providerId), trimmed, {
    // The key is only ever used while the user is in the app, so there is no reason for
    // it to be readable before first unlock.
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function clearApiKey(providerId: AiProviderId = 'gemini'): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storeKeyFor(providerId));
  } catch (error) {
    console.warn('[keyStore] could not clear the stored key', describe(error));
  }
}

/**
 * A hint for the entry field, NOT a gate.
 *
 * Google keys currently start with 'AIza' and are 39 characters, but a format that is
 * true today is not a rule, and refusing a valid key because its prefix changed would be
 * a bug nobody could work around. The UI may use this to say "that does not look like a
 * key — save it anyway?", never to disable the button.
 */
export function looksLikeGoogleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{30,}$/.test(key.trim());
}

export type KeyTestResult = { ok: true; modelId: string; elapsedMs: number } | { ok: false; error: AiError };

/**
 * ─── THIS NUMBER WAS 16, AND 16 COULD NOT PASS A PERFECT KEY. ────────────────
 *
 * The answer really is two tokens ("ok"), and 16 was chosen to say so. That is the same
 * mistake, in miniature, that `DEFAULT_MAX_OUTPUT_TOKENS` in ./gemini.ts is a forty-line
 * comment about: on Gemini 3 `maxOutputTokens` is not the ANSWER's allowance, it is the
 * allowance for THINKING PLUS the answer, out of one pot. This request asks for
 * `thinkingLevel: 'low'`, and low is not off — there is no off in the type. Sixteen tokens
 * cannot survive any thinking at all.
 *
 * So the near-certain result on a PERFECTLY VALID KEY was: the budget goes on thinking,
 * generation stops at `MAX_TOKENS` with no text part, `finishReasonError()` returns
 * `truncated`, and the check reports a failure. The screens show "Google could not answer
 * just now — the key was neither accepted nor refused. Try checking again in a few
 * minutes" (`ai.resultNoAnswer` in settings/ai.tsx and setup/ai-key.tsx), which is exactly
 * as wrong the fourth time as the first, and reads to the person setting up the phone like
 * a key that does not work. If he never got past that screen he never saved a key, and
 * every scan afterwards failed with `no_key` — one bad number, two screens away from the
 * feature it broke.
 *
 * 8192 IS A CAP, NOT A SPEND. Nothing is billed for a token that is never generated, the
 * prompt is six words, there is no image and the answer is one word — so this changes what
 * the check costs by nothing at all, and changes what it can survive by three orders of
 * magnitude. Do not lower it to "save money" on a request that has nothing to save.
 *
 * It is deliberately NOT the scan's 32768: this call has no schema and no photograph, so
 * a reply that somehow ran to thousands of tokens would mean something had gone wrong in
 * a way worth stopping on. And it is deliberately not left to the provider default either
 * — the budget a key check needs is a fact about the key check, and it belongs in the file
 * that makes the request.
 */
const KEY_TEST_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Failure codes that PROVE the key was accepted, and therefore answer this function's one
 * question with a YES.
 *
 * ─── WHY A FAILED REQUEST CAN STILL BE A GOOD KEY ────────────────────────────
 *
 * `testKey()` asks exactly one thing: WILL GOOGLE ACCEPT THIS KEY. Every code below is
 * something that happened AFTER the answer to that was yes — the request authenticated,
 * a model ran, and then the reply was not useful for a reason that has nothing to do with
 * the key:
 *
 *   truncated                — generation started and hit the token cap. It ran.
 *   thinking_budget_exhausted — the same cap, reached before the answer started, with the
 *                              budget spent on thinking. It still ran, and running is the
 *                              entire question this function asks.
 *   no_content               — a 200 with a candidate and no text in it. It ran.
 *   recitation               — the model stopped itself. It ran.
 *   safety_blocked_prompt    — a filter refused six words of English. Absurd, and still
 *   safety_blocked_response    only reachable once the request was authorised.
 *
 * Reporting any of those as a failed key check is a FALSE NEGATIVE, and a false negative
 * here costs more than anywhere else in the app: this screen is the app's whole answer to
 * "is my setup right?", it is used once, by someone who is not the patient, and its wrong
 * answer is unfalsifiable from his side. He concludes the key is bad, does not save it,
 * and prescription scanning is dead on a phone whose key was fine all along.
 *
 * WHAT IS DELIBERATELY NOT ON THIS LIST, and why each one is a real answer rather than a
 * false negative:
 *   invalid_key, no_key      — the actual no. The whole point.
 *   key_restricted,          — also a no, and a more specific one: the key is real and
 *   api_not_enabled            carries a restriction this app can never satisfy, or its
 *                              project has the API switched off. Reporting either as
 *                              "works" would send somebody to save a key that cannot read
 *                              a single prescription, and the failure would then only
 *                              appear in a clinic corridor.
 *   quota_zero                 — the key authenticated, so it is not a verdict on the key,
 *                              and it is still not a working setup: an allowance of zero
 *                              reads exactly like a working key until the first scan.
 *   model_not_found          — the key authenticated, but our own check model is gone. It
 *                              is our constant that is stale, and a check that answered
 *                              "works" would hide the one thing an app update must fix.
 *   rate_limited,            — the key is real, and both already say so in their own copy
 *   quota_exhausted            ("too many just now", "today's allowance is used up"),
 *                              which is more use than "it works" when it currently cannot.
 *   offline, timeout         — nothing reached Google, so nothing was learned about the
 *                              key. The screens say exactly that, in those words, and say
 *                              it is not yet a verdict on the key.
 *   malformed_json           — a 200 whose body was not JSON, which is a captive portal or
 *                              a proxy with opinions rather than Google. (The other route
 *                              to this code needs a `responseSchema`, and none is sent
 *                              below — same reason `empty_result` and `schema_mismatch`
 *                              cannot occur here at all.)
 *   bad_request, server_error, service_overloaded, unknown, cancelled — not evidence
 *                              either way.
 */
const CODES_THAT_PROVE_THE_KEY_WORKS: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'truncated',
  'thinking_budget_exhausted',
  'no_content',
  'recitation',
  'safety_blocked_prompt',
  'safety_blocked_response',
]);

/**
 * One real, cheap call — the only honest way to know a key works.
 *
 * Uses the flash-lite model, no image and a one-word answer, so verifying costs a fraction
 * of a paisa and finishes in a second or two. Deliberately does NOT use the model the user
 * picked for scanning: this question is "is this key accepted", and answering it should not
 * depend on whether the pro preview happens to be busy.
 *
 * IT IS BIASED TOWARDS SAYING YES, ON PURPOSE. Anything that proves the request got past
 * authentication is reported as a working key even when the reply itself was useless — see
 * `CODES_THAT_PROVE_THE_KEY_WORKS`. The cost of wrongly saying "this key works" is one
 * clear failure later, with its own sentence and its own next step. The cost of wrongly
 * saying it does not is a phone that never gets a key at all.
 *
 * `key` may be supplied directly so the settings screen can verify BEFORE saving. Nothing
 * is written here either way — saving is `setApiKey`, and keeping the two apart is what
 * stops a bad key from replacing a good one that was working a minute ago.
 */
export async function testKey(
  key?: string,
  providerId: AiProviderId = 'gemini',
): Promise<KeyTestResult> {
  const candidate = key?.trim() ?? (await getApiKey(providerId));
  if (!candidate) return { ok: false, error: aiError('no_key') };

  const provider = createProvider(providerId, {
    modelId: KEY_TEST_MODEL_ID,
    thinkingLevel: 'low',
    getApiKey: async () => candidate,
  });

  const result = await provider.generate({
    // Deliberately trivial and non-clinical. A key check must not send a photograph, and
    // must not be the thing that trips a safety filter.
    prompt: 'Reply with the single word: ok',
    images: [],
    // Thinking plus answer, out of one pot. See the constant — this was the bug.
    maxOutputTokens: KEY_TEST_MAX_OUTPUT_TOKENS,
    thinkingLevel: 'low',
    // 45 seconds. A key check happens while the user watches a spinner in Settings, on a
    // connection they are not in a hurry on; the 300 s scan timeout would feel broken.
    timeoutMs: 45_000,
  });

  if (result.ok) return { ok: true, modelId: result.modelId, elapsedMs: result.elapsedMs };

  // No `responseSchema` is sent above, so the provider does not try to parse the reply as
  // JSON and a plain-prose answer counts as success — a good key cannot fail here for
  // being chatty. What is left are failures that either say something real about the key,
  // or say nothing about it because they happened after it was already accepted. The
  // second kind is a yes, and is answered as one.
  if (CODES_THAT_PROVE_THE_KEY_WORKS.has(result.error.code)) {
    return { ok: true, modelId: result.modelId, elapsedMs: result.elapsedMs };
  }

  return { ok: false, error: result.error };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
