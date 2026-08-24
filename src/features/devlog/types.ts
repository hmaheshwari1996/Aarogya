/**
 * The shape of one technical note, and the closed list of events that can produce one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS LOG DESCRIBES THE PIPE, NOT THE WATER.
 *
 * That is the one sentence to hold in mind while adding anything here. A note in this
 * ring says how big a request was, which status came back, how many tokens were spent,
 * how long it took. It never says what the prescription said, what she weighs, what she
 * is taking, or who she is. If a field would still be meaningful to a stranger who has
 * never met her, it belongs; if it would tell that stranger something about her health,
 * it does not.
 *
 * The enforcement is not this comment — it is `redact.ts`, which every field passes
 * through on the way in. A field name that has not been reviewed cannot carry text at
 * all. See that file for why the allow-list runs that way round.
 *
 * WHY EVENT NAMES ARE A CLOSED TABLE. The whole point of the log screen is that her son
 * can look at fifteen lines and say "it was the key" or "it was the crop". That only
 * works if the same situation always produces the same event name, so he can learn six
 * names once instead of reading prose every time. A free-form string would drift within
 * a week — and a drifted name is a line he has to read carefully rather than recognise.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type DevLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Coarse on purpose. This is what the log screen filters on, and a person scanning a
 * list under presbyopia can hold three buckets in their head, not eleven.
 */
export type DevLogCategory =
  /** Anything on the way to or from the model. */
  | 'ai'
  /** Local image work: crop, resize, encode. Never the pixels. */
  | 'image'
  /** Everything else, including uncaught errors and unhandled rejections. */
  | 'app';

/** What a field may hold once it has been through `redact.ts`. Nothing nested, ever. */
export type DevLogValue = string | number | boolean | null;

/** What is stored. */
export type DevLogFields = Readonly<Record<string, DevLogValue>>;

/** What a caller may pass. Anything at all — it is the redactor's job to refuse it. */
export type DevLogInput = Readonly<Record<string, unknown>>;

export type DevLogEntry = {
  /**
   * Monotonic within one launch of the app, so two notes written in the same millisecond
   * still have an order. NOT stable across launches, and deliberately not a row id.
   */
  readonly seq: number;
  readonly ts: number;
  readonly level: DevLogLevel;
  readonly category: DevLogCategory;
  readonly event: DevLogEventName;
  /**
   * Groups every note belonging to one scan (or one key check).
   *
   * Random, minted per run, and never derived from the prescription id or any other row
   * id. A log that carried the prescription id would join straight back to her record the
   * moment it was pasted into a chat window — which is exactly the situation this whole
   * module assumes will happen.
   */
  readonly runId: string | null;
  readonly fields: DevLogFields;
};

/**
 * Every event name, in one table.
 *
 * The order below is the order they occur in one scan, which is also the order they will
 * appear on the screen. Read it as the pipeline itself:
 *
 *   run.start → prep.page (×pages) → ai.attempt → ai.request → ai.http
 *             → ai.response → ai.parse → [ai.wait → ai.attempt → …] → ai.outcome → run.end
 */
export const DEV_EVENTS = {
  /** One scan, or one key check, has begun. Carries the kind and nothing else. */
  runStart: 'run.start',
  /** One photograph cropped, resized and encoded. Sizes and fractions only. */
  prepPage: 'prep.page',
  /** The retry layer is about to ask. Carries the attempt number and the time left. */
  aiAttempt: 'ai.attempt',
  /** The request as it is about to leave the phone: model, budget, byte counts. */
  aiRequest: 'ai.request',
  /** The HTTP answer. Status, the API's own status string, and its own message. */
  aiHttp: 'ai.http',
  /** A 200 body, counted: finish reason, part counts, token usage. */
  aiResponse: 'ai.response',
  /** What came of parsing that body. Key NAMES and counts, never values. */
  aiParse: 'ai.parse',
  /** The retry layer is sleeping before asking again. */
  aiWait: 'ai.wait',
  /** She left. Where in the sequence, and after what. */
  aiCancelled: 'ai.cancelled',
  /** One attempt's verdict — the code, if it failed. */
  aiOutcome: 'ai.outcome',
  /** The whole sequence's verdict, including how many attempts it took. */
  runEnd: 'run.end',
  /** An uncaught error or an unhandled rejection anywhere in the app. */
  appError: 'app.error',
  /** A note the log itself needs to make about the log. */
  logNote: 'log.note',
} as const;

export type DevLogEventName = (typeof DEV_EVENTS)[keyof typeof DEV_EVENTS];

const EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(DEV_EVENTS));

/** Used when reading the file back: a line naming an event this build does not know. */
export function isKnownEvent(value: unknown): value is DevLogEventName {
  return typeof value === 'string' && EVENT_NAMES.has(value);
}

export function isLevel(value: unknown): value is DevLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

export function isCategory(value: unknown): value is DevLogCategory {
  return value === 'ai' || value === 'image' || value === 'app';
}
