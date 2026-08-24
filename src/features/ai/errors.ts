/**
 * Every way reading a prescription can fail, as ONE closed union.
 *
 * WHY THIS FILE EXISTS AT ALL: the single worst thing this feature can say to a woman
 * standing in a clinic corridor is "Something went wrong." She cannot tell from that
 * whether to retake the photo, turn on mobile data, wait five minutes, or give up and
 * type the medicines in by hand — and those are four completely different actions. So
 * every failure path in `gemini.ts` maps to exactly one code below, and every code
 * carries the sentence the user reads AND the single next step she should take.
 *
 * `nextStep` is deliberately not a boolean "retryable". "Try again" is useless advice
 * when the key is wrong, and "check the photo" is useless advice when the phone is
 * offline. The UI switches on `nextStep` to decide which button to show.
 *
 * `messageKey` points at an i18n key so the Hindi build reads naturally; `userMessage`
 * is the English fallback and the exact copy the key should carry. Both are here so a
 * missing translation degrades to a sentence that still tells her what to do.
 */

export type AiErrorCode =
  /** No API key stored yet. Not an error — a setup step that has not happened. */
  | 'no_key'
  /** The key exists but the service rejected it (401/403), and nothing named a reason. */
  | 'invalid_key'
  /**
   * 403 whose details name a restriction ON THE KEY — an Android app, a website
   * referrer, an IP range. The characters of the key are correct and it can never be
   * used from this app, so re-typing it is the one action that cannot help.
   */
  | 'key_restricted'
  /**
   * 403 SERVICE_DISABLED — the key is fine and the API is switched off for the project
   * it belongs to. Fixed in Google Cloud Console, never on the phone.
   */
  | 'api_not_enabled'
  /** fetch() never reached the network. */
  | 'offline'
  /** The request was aborted by our own timeout. */
  | 'timeout'
  /** 429 with quota left — too many requests too quickly. */
  | 'rate_limited'
  /** 429 with the daily allowance gone. It comes back tomorrow. */
  | 'quota_exhausted'
  /**
   * 429 whose quota limit is literally zero. Not an allowance that has been used up —
   * an allowance that does not exist, so tomorrow is identical to today.
   */
  | 'quota_zero'
  /** 400 — we built a request the API would not accept. Our bug, not hers. */
  | 'bad_request'
  /** 404 — the configured model id does not exist (or is not available to this key). */
  | 'model_not_found'
  /** 5xx. */
  | 'server_error'
  /** 503 — the model is busy right now. */
  | 'service_overloaded'
  /** promptFeedback.blockReason — the REQUEST was blocked before generation. */
  | 'safety_blocked_prompt'
  /** finishReason SAFETY — generation started and was cut off. */
  | 'safety_blocked_response'
  /** finishReason MAX_TOKENS with an answer in hand — it was cut mid-JSON. */
  | 'truncated'
  /**
   * finishReason MAX_TOKENS with NO answer at all and thinking tokens spent. The budget
   * went on reasoning before one character of JSON existed. An app-side fault, and the
   * one case where photographing fewer lines fails identically.
   */
  | 'thinking_budget_exhausted'
  /** finishReason RECITATION. */
  | 'recitation'
  /** finishReason OTHER/unspecified, or candidates present but no text part. */
  | 'no_content'
  /** We got text, it was not JSON. */
  | 'malformed_json'
  /** Valid JSON, wrong shape. */
  | 'schema_mismatch'
  /** Right shape, nothing in it — no medicines, no tests, no follow-up. */
  | 'empty_result'
  /** The photo could not be resized/cropped/encoded at all. */
  | 'image_unreadable'
  /** A crop rectangle was not supplied. The uncropped path does not exist. */
  | 'crop_required'
  /** The user (or a screen unmounting) aborted the request. Not a fault. */
  | 'cancelled'
  /** Genuinely unclassified. Should be rare enough to be worth investigating. */
  | 'unknown';

/** What the user should do next. The UI renders one button per value. */
export type AiNextStep =
  | 'add_key'
  | 'check_key'
  | 'check_connection'
  | 'retry'
  | 'retry_later'
  | 'retake_photo'
  | 'adjust_crop'
  | 'type_manually'
  | 'report_bug';

export type AiError = {
  readonly code: AiErrorCode;
  /** Plain language, no jargon, ready to render as-is. */
  readonly userMessage: string;
  /** Preferred i18n key. `userMessage` is the English fallback for it. */
  readonly messageKey: string;
  readonly nextStep: AiNextStep;
  /**
   * Whether repeating the same request unchanged could plausibly succeed.
   *
   * NOT the same question as "will the app retry this by itself", and the two must not be
   * merged. `retryable` is advice to the UI about whether to offer her a Try Again button;
   * `RETRYABLE_CODES` in ./retry.ts is the much shorter list the app retries WITHOUT
   * asking. `empty_result` is retryable-by-her (a better photograph might work) and never
   * retried automatically (the same photograph will not).
   */
  readonly retryable: boolean;
  /** Developer-facing. Logged, never rendered. */
  readonly detail?: string;
  readonly httpStatus?: number;
  /**
   * How long the SERVER asked us to wait, in milliseconds, when it said so — a
   * `Retry-After` header or a `google.rpc.RetryInfo.retryDelay`.
   *
   * Advice, not an instruction: ./retry.ts honours it in preference to its own backoff
   * curve (the server is the only party that knows when capacity returns) but still refuses
   * a delay longer than it is willing to make a person sit through, and never consults it
   * for a code it would not retry anyway.
   */
  readonly retryAfterMs?: number;
};

type ErrorTemplate = {
  readonly userMessage: string;
  readonly nextStep: AiNextStep;
  readonly retryable: boolean;
};

/**
 * The copy, in one table.
 *
 * Rules that every line here follows:
 *   • It names what happened in words the reader already knows.
 *   • It says what to do next, once.
 *   • It never blames her, and never implies the medicines were read wrongly when the
 *     request never reached the model at all.
 *   • It never says "error", "failed", "invalid" or "exception".
 *
 * ─── THE THREE RETRIED CODES SAY THAT THEY WERE RETRIED ──────────────────────
 * `service_overloaded`, `rate_limited` and `timeout` are the three members of
 * `RETRYABLE_CODES` in ./retry.ts, which means that by the time ANY of these three
 * sentences reaches a screen, the app has already asked again — up to three attempts with
 * up to nine seconds asleep in between — without her touching anything.
 *
 * The copy used to be written for a system that did not do that. It said "try again in a
 * few minutes", full stop. So she waited three times as long as before, read the identical
 * sentence she had already reported once from the device, and the only instruction it gave
 * her was the thing the app had just done twice on her behalf — so she tapped it again and
 * spent a fourth request out of a daily free allowance that, once gone, is gone until
 * tomorrow. A message that hides the retry turns a fixed defect back into the original one.
 *
 * So each of the three now states that the app already asked again, and then offers the
 * ONE remaining action that is not another identical request: type them in.
 *
 * "a few times" and not "three times", deliberately. `maxAttempts` is a policy a caller can
 * override, the loop stops early when the remaining budget cannot fund another attempt, and
 * a 300-second timeout leaves room for two attempts rather than three. A sentence that
 * names a count would be wrong in every one of those cases, and this file does not get to
 * be wrong about what the app did.
 *
 * ─── FOUR SENTENCES THAT NAME A FIX THAT IS NOT ON THIS PHONE ────────────────
 * `key_restricted`, `api_not_enabled`, `quota_zero` and `thinking_budget_exhausted` all
 * used to be something else — three of them were `invalid_key` or `rate_limited`, and the
 * fourth was `truncated`. Each of those older sentences named an action, and in these four
 * situations the action it named CANNOT WORK, ever, however many times it is taken:
 *
 *   check the key in Settings   · when the key is perfect and carries a restriction this
 *                                 app cannot satisfy — it sends no X-Android-Package and
 *                                 no Referer, so the restriction is unsatisfiable by
 *                                 construction and a fresh key with the same restriction
 *                                 fails identically.
 *   wait a minute and try again · when the limit is zero. There is no minute.
 *   try again tomorrow          · when the limit is zero. Tomorrow is the same day.
 *   photograph fewer lines      · when the answer never started, because the budget went
 *                                 on thinking. Fewer lines spend the same thinking.
 *
 * An instruction that cannot work is worse than no instruction, because it is followed,
 * repeatedly, and each round costs a request out of the same allowance. So these four say
 * plainly that the fix is elsewhere, and where elsewhere is. They are longer than the rest
 * of this table for that reason — the reader of these particular four is whoever set the
 * phone up, and a Console path he can follow beats a short sentence he cannot act on.
 */
const TEMPLATES: Record<AiErrorCode, ErrorTemplate> = {
  no_key: {
    userMessage:
      'Reading prescriptions needs a Google AI key. You can add one in Settings, or type the medicines in yourself.',
    nextStep: 'add_key',
    retryable: false,
  },
  invalid_key: {
    userMessage:
      'The Google AI key saved on this phone was not accepted. Check it in Settings, or type the medicines in yourself.',
    nextStep: 'check_key',
    retryable: false,
  },
  key_restricted: {
    // NOT `check_key`. That button opens the screen where the key is re-typed, which is
    // precisely the action that can never work here — see the note above the table.
    userMessage:
      'The Google AI key on this phone is locked to one particular app or website, so Aarogya cannot use it — typing it in again will not change that. Whoever set the key up can remove that restriction in Google Cloud Console, or make a key without one. You can type the medicines in yourself for now.',
    nextStep: 'type_manually',
    retryable: false,
  },
  api_not_enabled: {
    userMessage:
      'The prescription reader is not switched on for the Google project this key belongs to. That is fixed in Google Cloud Console, not in Aarogya — switch on the Generative Language API for that project, wait a few minutes, then read the prescription again. You can type the medicines in yourself for now.',
    nextStep: 'type_manually',
    retryable: false,
  },
  offline: {
    userMessage:
      'Reading a prescription needs the internet. Your photo is saved — turn on mobile data or Wi-Fi and try again.',
    nextStep: 'check_connection',
    retryable: true,
  },
  timeout: {
    userMessage:
      'Reading the prescription took too long, most likely a slow connection. Aarogya waited and asked again, and it was still too slow. Your photo is saved — try again when the signal is better, or type the medicines in yourself.',
    nextStep: 'retry_later',
    retryable: true,
  },
  rate_limited: {
    userMessage:
      'Too many prescriptions were read just now. Aarogya waited and asked again a few times, and the reader is still holding requests back. Your photo is saved — wait a minute and try again, or type the medicines in yourself.',
    nextStep: 'retry_later',
    retryable: true,
  },
  quota_exhausted: {
    userMessage:
      "Today's free allowance for reading prescriptions is used up. Try again tomorrow, or type the medicines in yourself.",
    nextStep: 'type_manually',
    retryable: false,
  },
  quota_zero: {
    // The sentence above with "tomorrow" taken out of it, because tomorrow is the lie.
    userMessage:
      'The Google project this key belongs to has no allowance for reading prescriptions at all — its limit is zero, so waiting until tomorrow will not change it. Whoever set the key up can switch on the Generative Language API for that project in Google Cloud Console, and add billing details if it asks for them. You can type the medicines in yourself for now.',
    nextStep: 'type_manually',
    retryable: false,
  },
  bad_request: {
    userMessage:
      'Aarogya could not put this photo into a form the reader accepts. This is a problem in the app, not in your photo. Please type the medicines in yourself.',
    nextStep: 'report_bug',
    retryable: false,
  },
  model_not_found: {
    userMessage:
      'The prescription reader chosen in Settings is not available for your key. Pick a different one in Settings.',
    nextStep: 'check_key',
    retryable: false,
  },
  server_error: {
    userMessage:
      'The prescription reader is having trouble at its end. Your photo is saved — try again in a few minutes.',
    nextStep: 'retry_later',
    retryable: true,
  },
  service_overloaded: {
    userMessage:
      'The prescription reader is busy. Aarogya asked again a few times and it stayed busy. Your photo is saved — try again in a few minutes, or type the medicines in yourself.',
    nextStep: 'retry_later',
    retryable: true,
  },
  safety_blocked_prompt: {
    userMessage:
      'The reader would not look at this photo. Make sure only the medicine list is in the picture, then try again.',
    nextStep: 'adjust_crop',
    retryable: true,
  },
  safety_blocked_response: {
    userMessage:
      'The reader stopped part-way through this prescription and returned nothing. Please type the medicines in yourself.',
    nextStep: 'type_manually',
    retryable: false,
  },
  truncated: {
    // Only reached when an answer was actually produced and then cut. The case where no
    // answer was produced at all is `thinking_budget_exhausted` below, and this sentence
    // is exactly the wrong thing to say to it.
    userMessage:
      'The prescription was too long to read in one go and the answer was cut off. Photograph fewer lines at a time, or type the medicines in yourself.',
    nextStep: 'retake_photo',
    retryable: false,
  },
  thinking_budget_exhausted: {
    userMessage:
      'The reader used up its whole budget working out what the page said and never wrote the answer. This is a problem in the app, not in your photo — photographing fewer lines will not help. Please type the medicines in yourself this time.',
    nextStep: 'report_bug',
    retryable: false,
  },
  recitation: {
    userMessage:
      'The reader stopped because the text looked like something it is not allowed to repeat. Please type the medicines in yourself.',
    nextStep: 'type_manually',
    retryable: false,
  },
  no_content: {
    userMessage:
      'The reader sent nothing back for this photo. Your photo is saved — try again, or type the medicines in yourself.',
    nextStep: 'retry',
    retryable: true,
  },
  malformed_json: {
    userMessage:
      'The reader sent back something Aarogya could not understand. Your photo is saved — please try again.',
    nextStep: 'retry',
    retryable: true,
  },
  schema_mismatch: {
    userMessage:
      'The reader sent back an answer in the wrong shape, so nothing was saved. Your photo is kept — please try again.',
    nextStep: 'retry',
    retryable: true,
  },
  empty_result: {
    userMessage:
      'No medicines could be read in this photo. Make sure the medicine list is sharp, well lit and fully inside the frame.',
    nextStep: 'retake_photo',
    retryable: true,
  },
  image_unreadable: {
    userMessage: 'This photo could not be opened. Please take it again.',
    nextStep: 'retake_photo',
    retryable: false,
  },
  crop_required: {
    userMessage:
      'Choose the part of the prescription that lists the medicines before it is read. The top of the page, with names on it, never leaves this phone.',
    nextStep: 'adjust_crop',
    retryable: false,
  },
  cancelled: {
    userMessage: 'Reading the prescription was stopped. Your photo is saved.',
    nextStep: 'retry',
    retryable: true,
  },
  unknown: {
    userMessage:
      'The prescription could not be read this time. Your photo is saved — try again, or type the medicines in yourself.',
    nextStep: 'retry',
    retryable: true,
  },
};

/**
 * ─── `messageKey` IS A TEMPLATE LITERAL, SO IT NEEDS A TYPE-DRIVEN GATE ──────
 * `errors.ai.<code>` is built here rather than written at a call site, which means
 * `npm run check:i18n`'s static `t('…')` scan — the check that catches every other missing
 * key in this app — cannot see it. It is scoped to literal call sites by construction.
 *
 * For a while there was no `errors.ai` namespace in either bundle at all. Nothing failed:
 * `translate()` returns the key path when it is missing, the prescription screen notices
 * that and falls back to `userMessage`, and `userMessage` is the hard-coded ENGLISH
 * sentence below. So a Hindi reader got every single AI failure in English — including the
 * exact "busy right now" sentence that was reported from the device — and no gate,
 * typecheck or test said a word.
 *
 * `scripts/check-i18n.js` now parses the `AiErrorCode` union out of THIS file and asserts a
 * bundle key per member, in both languages. Adding a code to the union above without adding
 * its two sentences is a build failure from now on.
 */
export function aiError(
  code: AiErrorCode,
  options: { detail?: string; httpStatus?: number; retryAfterMs?: number } = {},
): AiError {
  const template = TEMPLATES[code];
  return {
    code,
    userMessage: template.userMessage,
    messageKey: `errors.ai.${code}`,
    nextStep: template.nextStep,
    retryable: template.retryable,
    // Each optional field is spread in only when it has a value, so a stored or logged
    // error never carries `"httpStatus": undefined` — noise in the one place someone reads
    // six months later trying to work out what happened.
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    ...(options.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
  };
}

/** Every code, for the docs table and for a settings screen that lists what can happen. */
export const AI_ERROR_CODES = Object.keys(TEMPLATES) as AiErrorCode[];

/**
 * Short, stable string for `prescription.extraction_error`.
 *
 * The COLUMN stores the code, not the sentence: the sentence is presentation and will be
 * rewritten and translated, while the code is what a support conversation six months from
 * now needs to be able to match on.
 */
export function toStoredError(error: AiError): string {
  return error.detail ? `${error.code}: ${error.detail}` : error.code;
}

export function isAiError(value: unknown): value is AiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'userMessage' in value &&
    'nextStep' in value
  );
}
