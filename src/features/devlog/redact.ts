/**
 * The gate every logged field passes through, and the reason this module can be trusted
 * with a feature whose whole premise is that the output will be screenshotted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREAT MODEL, WRITTEN DOWN
 *
 * Her son turns the developer toggle on, reproduces the failure, taps Copy All, and
 * pastes the result into a chat window — with a stranger, or into a bug tracker, or to
 * whoever on the internet answered a similar question. That is not a misuse of this
 * feature; it is the ONLY use of it. So the correct question is never "is this field
 * useful" but "am I willing for this field to be in that chat window".
 *
 * Under that question, a medicine name is a diagnosis. An Indian OPD prescription for
 * isoniazid and rifampicin says "this person has tuberculosis" to anyone who can use a
 * search engine, and in India that has consequences at work and at home. A file path
 * names a file that still exists on her phone. A hash of the API key is a stable
 * identifier for the key. None of those are close calls.
 *
 * ─── WHY THE ALLOW-LIST RUNS THIS WAY ROUND ──────────────────────────────────
 *
 * The obvious design is a deny-list: block `apiKey`, block `medicineName`, block
 * `imageBase64`. It fails the first time somebody logs a field nobody thought of —
 * and the failure is silent, permanent, and only discovered in that chat window.
 *
 * So the rule here is inverted and blunt:
 *
 *   • A NUMBER or a BOOLEAN is always allowed (unless its name is clinical). A count
 *     cannot carry a drug name; 8192 is 8192 whoever reads it.
 *   • A STRING is allowed only if its field name is on `TEXT_FIELDS` below — a list
 *     that fits on one screen and was reviewed one name at a time. Everything else
 *     becomes `[blocked]`, which is itself a useful signal: it means somebody tried to
 *     log free text and the recorder said no.
 *   • Anything else — objects, arrays of objects, functions, undefined — is dropped
 *     with its type named, so a caller who passes the whole response object gets
 *     `[dropped object]` rather than a prescription.
 *
 * The cost of that strictness is that adding a new text field is a two-line edit here.
 * That is the point: it makes the review happen.
 *
 * ─── AND THEN THE VALUE IS SCRUBBED ANYWAY ───────────────────────────────────
 *
 * Even an allowed string is washed, because the allowed strings are mostly *someone
 * else's* text. `apiMessage` is Google's own error prose, and Google's error prose has
 * been known to echo parts of the request back. So keys, base64 runs, data URIs, file
 * paths, e-mail addresses and long digit runs are removed from every string that gets
 * through, and the result is capped. Belt and braces, on the one path where a mistake
 * cannot be taken back.
 *
 * ─── THE RULE, IN ONE SENTENCE: THE NAME DECIDES ─────────────────────────────
 *
 * Two review findings arrived together and read like opposites — "the redactor leaks"
 * and "the redactor blocks the one number the log exists to show". Both were true, both
 * were about the same mechanism, and neither is fixed by loosening or tightening a
 * scrubber:
 *
 *   A FIELD NAME IS A PROMISE ABOUT WHAT THE FIELD CAN HOLD. The gate believes the
 *   promise, because the name is the only thing it can judge that a caller chose
 *   deliberately.
 *
 * Everything else follows, in both directions:
 *
 *  • A name that promises a measurement is refused WHATEVER IT HOLDS, including a
 *    number — `glucose: 18` is the sensitive fact this app is built around, and nothing
 *    can tell that number apart from a count by looking at it. The consequence is not a
 *    bug in the rule, it is the rule: A COUNT MUST NOT BE NAMED AFTER THE THING IT
 *    COUNTS. `medicinesRead: 7` is refused and deserves to be; the same number travels
 *    as `itemsRead` from `features/prescriptions/extract.ts`, and as
 *    `arrayCounts: "medicines=7"`, whose key is fixed in our own schema. Letting numbers
 *    through the clinical gate would have bought that one count at the price of the only
 *    rule standing between this log and every reading in the database.
 *
 *  • A name that cannot promise machine text does not go on the allow-list, however
 *    useful it is. `errorMessage` was on it and is not any more; the case against it is
 *    written out beside the list, with the two shipped error classes that prove it.
 *
 * So when a field comes out `[blocked]`, the fix is never to weaken the gate. It is to
 * ask what the field is really carrying, and to give it a name that says so.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { DevLogFields, DevLogInput, DevLogValue } from './types';

/** Per string. Long enough for a Google error message, short enough to read on a phone. */
export const MAX_TEXT_CHARS = 300;

/** Per entry. A note with forty fields is not a note, it is a dump. */
export const MAX_FIELDS = 32;

/**
 * Field names whose STRING value is allowed through, lower-cased.
 *
 * Every one of these carries text written by a machine — Google's API, this app's own
 * error table, an enum from the wire — and never text written by a human, read off a
 * prescription, or typed into a form. Read the list as a series of individual decisions,
 * because that is what it is.
 */
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  // Google's own words about the failure. The single most valuable field in the whole
  // log: "Android client application ... blocked" and "limit: 0" live nowhere else.
  'apimessage',
  // e.g. RESOURCE_EXHAUSTED, PERMISSION_DENIED. An enum.
  'apistatus',
  // google.rpc.ErrorInfo.reason — API_KEY_ANDROID_APP_BLOCKED, SERVICE_DISABLED,
  // API_KEY_HTTP_REFERRER_BLOCKED. The same class of string as `apistatus` above, one
  // level finer: a documented SCREAMING_SNAKE identifier, checked against that shape by
  // `errorReasonFromDetails` in features/ai/gemini.ts before it is ever passed here. It is
  // the field that separates four different 403s that are otherwise one sentence.
  'apireason',
  // Which quota was hit, when the body names one. An identifier, not a value:
  // GenerateRequestsPerDayPerProjectPerModel-FreeTier names the PERIOD, which is the fact
  // the 429 message itself frequently omits. Its companion `quotaValue` — the limit, and
  // `0` is the whole diagnosis — is deliberately NOT here: it travels as a NUMBER, so it
  // needs no allow-list, and a number named after a LIMIT is not a number named after a
  // measurement. See the header on why that distinction is the whole rule.
  'quotaid',
  // The raw Retry-After header, and the RetryInfo duration string. "26s".
  'retryafterheader',
  'retryafterdetail',
  // This app's own AiErrorCode. A closed union, defined in features/ai/errors.ts.
  'errorcode',
  // STOP / MAX_TOKENS / SAFETY. An enum from the wire.
  'finishreason',
  // promptFeedback.blockReason. Also an enum.
  'blockreason',
  // Which model was asked, and which one the server says answered. Not always the same.
  'modelid',
  'modelversion',
  // low / high. An enum.
  'thinkinglevel',
  // 'image/jpeg', and nothing else this app has ever sent.
  'mimetype',
  // 'AIza' or 'other'. FOUR characters that are constant across every Google key on
  // earth, or the word saying they were absent. See `fingerprintSecret`.
  'keyshape',
  // Where in a sequence something happened: 'before an attempt', 'while waiting'.
  'where',
  // The kind of run: 'scan' or 'keycheck'.
  'runkind',
  // TOP-LEVEL KEY NAMES of the model's JSON — 'medicines', 'prescriber'. These are OUR
  // schema's field names, fixed in features/prescriptions/schema.ts, never field values.
  'topkeys',
  // 'medicines=7'. Counts, keyed by those same fixed names.
  'arraycounts',
  // Parser warning codes. A closed union in schema.ts.
  'warningcodes',
  // An Error's CONSTRUCTOR NAME — 'TypeError', 'InstrumentBoundsError'. A class name is
  // written in this repository, at a `class X extends Error` line, and can be enumerated
  // by grep. It is machine text by construction in the strict sense the list requires.
  'errorname',
  // The first stack frame. Same reasoning: a function name and a bundle path, both
  // written by a programmer. ABS_PATH below takes the path out and leaves the function
  // and the :line:col, which is the half that locates the bug.
  'stacktop',
  // ── `errormessage` USED TO BE HERE. IT IS NOT COMING BACK ─────────────────
  //
  // It was allowed on the argument that a JS error message is machine text "in every case
  // anyone has been able to construct". Two cases were shipped in this repository:
  //
  //   InstrumentBoundsError  (src/db/repositories/readings.ts:150)
  //     "Blood sugar of 412 is outside what any instrument can report (10–900)."
  //     A metric name and a MEASUREMENT. DIGIT_RUN wants a ten-character run before it
  //     fires, so 412 walks out untouched, and so would a systolic of 180.
  //
  //   BriefcaseCopyError     (src/app/briefcase/_lib.tsx:293)
  //     "briefcase copy failed: failed (Error: /storage/emulated/0/Download/TB
  //      discharge summary.pdf: open failed: ENOENT)"
  //     The name of a paper she chose. ABS_PATH used to stop at the first space, so
  //     everything from "discharge" onwards survived.
  //
  // The second hole is closed below and was worth closing anyway. The first cannot be:
  // removing a three-digit number from prose would take `httpStatus`-shaped facts, the
  // "limit: 0" in Google's quota text and the "26s" in a Retry-After with it — the exact
  // numbers this log exists to show — and no washer can recognise "Blood sugar" as a
  // metric without a dictionary of every clinical word in two languages.
  //
  // What settles it is not the scrubber, it is the sentence on `src/app/devlog/index.tsx`,
  // in the app's own voice, above the list, with no hedge in it:
  //
  //     "Technical notes about how the app itself is working. They contain no medicines,
  //      no readings and no personal details."
  //
  // A field that can carry a reading makes that sentence false, and she is reading it
  // while deciding whether to let her son send the log to a stranger. A less useful log is
  // recoverable — the run can be repeated. A leaked diagnosis is not.
  //
  // What is left still answers the question the log is for. A failed scan reports
  // `errorCode`, `apiStatus`, `httpStatus` and `apiMessage` — Google's own prose, which is
  // where the diagnostic sentence actually lives — and an uncaught crash reports
  // `errorName` and `stackTop`. `recordAppError` in store.ts still passes `errorMessage`;
  // it now prints as `[blocked]`, which is the honest thing for it to say.
]);

/**
 * Field names that are refused whatever their type, including numbers.
 *
 * The rule "a number cannot leak" has exactly one exception, and it is the one this app
 * exists for: a glucose of 18 IS the sensitive fact. So the measurements are named here
 * and blocked outright, in case a future caller ever reaches for this logger from an
 * entry screen. Nothing in the AI path passes any of them today; that is the point.
 */
const CLINICAL_FIELDS: ReadonlySet<string> = new Set([
  'glucose',
  'sugar',
  'bp',
  'systolic',
  'diastolic',
  'spo2',
  'oxygen',
  'pulse',
  'weight',
  'inr',
  'reading',
  'readings',
  'value',
  'values',
  'v1',
  'v2',
  'dose',
  'quantity',
  'strength',
  'symptom',
  'medicine',
  'medicines',
  'patient',
  'profile',
  'profileid',
  'prescriptionid',
  // Secrets, refused by exact name as well as by the pattern below, because a caller who
  // logs `{ key: 39 }` meaning "the length" has still named a field after the secret.
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'auth',
  'authorization',
  'credential',
]);

/**
 * Also refused whatever the type, on a substring match. Catches `patientName`, `imageUri`,
 * `accessToken`.
 *
 * TRAP, PAID FOR ONCE, THE OTHER WAY ROUND: this refuses `medicinesRead: 7` — a plain
 * count, and the single number report 7 exists to surface — because the name contains
 * "medicine". That is working as intended and must stay that way. The alternative on
 * offer was "let numbers through the clinical gate", which is the same edit as "publish
 * `glucose: 18`", because a count and a measurement are the same eight bits of JSON. The
 * count is renamed at its call site instead (`itemsRead`), and the rule it illustrates is
 * in the header: a count must not be named after the thing it counts.
 *
 * TRAP, PAID FOR ONCE: the secret half of this cannot simply say `token`. Half the useful
 * fields in the AI log are `promptTokens`, `outputTokens`, `thoughtTokens` and
 * `maxOutputTokens` — the exact numbers that prove the thinking budget ate the answer —
 * and a bare `token` blocks all four, turning the log into a wall of `[blocked]` on the
 * one failure it was built to diagnose. So the secret-ish spellings are named instead.
 */
const CLINICAL_SUBSTRING = /(medicine|drug|patient|profile|symptom|diagnos|prescriptionid)/i;

const SECRET_SUBSTRING =
  /(api[_-]?key|secret|password|passphrase|credential|(?:auth|access|bearer|refresh|id)[_-]?token)/i;

// ── Scrubbers, applied in this order to every allowed string ─────────────────
//
// Order matters. A data: URI contains base64; strip the whole URI first or the tail of it
// survives as a "long run". A Google key is shorter than the base64 threshold, so it must
// have its own pattern or it goes through untouched.

/** `data:image/jpeg;base64,…` — the whole photograph, in one string. */
const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/**
 * A Google API key.
 *
 * Deliberately greedy on length and deliberately NOT anchored: a key that has been
 * concatenated into a sentence ("key AIzaSy… is invalid") must still be caught.
 */
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{10,}/g;

/**
 * A file:// or content:// URI, and an absolute Android/POSIX path. A path in a shared log
 * names a file that still exists on her phone, and its last segment is frequently the
 * name SHE gave a paper.
 *
 * ─── WHY THESE STOP WHERE THEY STOP ──────────────────────────────────────────
 * They used to run to the first whitespace, which is wrong in the one case that matters:
 * a picked file is called "TB discharge summary.pdf", not "TBdischargesummary.pdf". A
 * path is only ever ended by a DELIMITER — a quote, a bracket, a comma, a semicolon, or
 * the ": " that every errno string in the world puts before its explanation — so those
 * are what the run stops at, and a space in the middle of a file name is consumed like
 * any other character.
 *
 * The cost, stated: a path followed by bare unpunctuated prose ("/data/x.pdf failed after
 * three tries") takes the prose with it. That is over-redaction, which is the direction
 * this file errs in on purpose, and it does not fire on either field that carries a path
 * today — `stackTop` (no spaces, and its `:line:col` now survives, which is an
 * improvement) and `apiMessage` (Google has never seen one of her paths).
 *
 * Neither character class contains a `*` inside a `+`, so there is nothing here that can
 * backtrack quadratically on a hostile string.
 */
const FILE_URI = /(?:file|content):\/\/[^"'()[\]{}<>,;:\n\r\t]*/gi;

const ABS_PATH = /\/(?:data|storage|sdcard|Users|users|var|private|tmp)\/[^"'()[\]{}<>,;:\n\r\t]*/g;

/** Any long unbroken base64-ish run: an image, a blob, an encoded body. */
const BASE64_RUN = /[A-Za-z0-9+/]{64,}={0,2}/g;

const EMAIL = /[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/g;

/**
 * A phone number, an Aadhaar, a hospital registration number.
 *
 * Ten digits is the floor ON PURPOSE and is not the place to catch a measurement. Pulling
 * it down far enough to remove a systolic of 180 would also remove the 403, the 429, the
 * "limit: 0" and the "26s" that are the entire diagnostic content of the fields this runs
 * over. A short number is kept out by refusing the FIELD (see CLINICAL_FIELDS and the
 * header), which is a decision made once at a name rather than guessed at every value.
 */
const DIGIT_RUN = /\+?\d[\d\s-]{8,}\d/g;

/** Collapses newlines and runs of spaces so one note stays one line. */
const WHITESPACE = /\s+/g;

/**
 * Washes one string. Exported because it is worth testing on its own.
 *
 * Never throws and never returns undefined: a scrubber that can fail is a scrubber that
 * gets wrapped in a try/catch that swallows it and logs the raw value instead.
 */
export function scrubText(input: string, maxChars: number = MAX_TEXT_CHARS): string {
  const washed = input
    .replace(DATA_URI, '[image omitted]')
    .replace(GOOGLE_KEY, '[key omitted]')
    .replace(FILE_URI, (match) => `[file omitted${extensionOf(match)}]`)
    .replace(ABS_PATH, (match) => `[file omitted${extensionOf(match)}]`)
    .replace(BASE64_RUN, (match) => `[binary omitted, ${match.length} chars]`)
    .replace(EMAIL, '[email omitted]')
    .replace(DIGIT_RUN, '[digits omitted]')
    .replace(WHITESPACE, ' ')
    .trim();

  if (washed.length <= maxChars) return washed;
  return `${washed.slice(0, maxChars)}… (+${washed.length - maxChars})`;
}

/** '.jpg' from a path, or '' — enough to know what KIND of file it was. */
function extensionOf(path: string): string {
  const match = /\.([A-Za-z0-9]{1,5})(?:[?#]|$)/.exec(path);
  return match?.[1] ? ` .${match[1].toLowerCase()}` : '';
}

// ── The secret fingerprint ───────────────────────────────────────────────────

export type SecretFingerprint = {
  readonly present: boolean;
  readonly length: number;
  /** 'AIza' when it starts the way every Google key does, 'other' when it does not. */
  readonly shape: 'AIza' | 'other' | 'none';
};

/**
 * Everything it is safe to say about a secret, and nothing else.
 *
 * ─── WHY THERE IS NO HASH HERE, AND MUST NOT BE ──────────────────────────────
 * The instinct is `sha256(key).slice(0, 8)` so two logs can be compared. Do not. A hash
 * of a secret IS a stable identifier for that secret: it survives being pasted into a
 * chat, it lets anyone confirm a guess offline, and it is one rainbow table away from
 * being the key itself. It also buys almost nothing here — the questions this log has to
 * answer are "is there a key at all", "is it the right length" and "does it look like a
 * Google key", and all three are answered below without a single byte of the secret.
 *
 * `length` is a plain integer, and 39 is the public, documented length of every Google
 * API key. `shape` is the four characters that are identical across all of them.
 */
export function fingerprintSecret(secret: string | null | undefined): SecretFingerprint {
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    return { present: false, length: 0, shape: 'none' };
  }
  const trimmed = secret.trim();
  return {
    present: true,
    length: trimmed.length,
    shape: trimmed.startsWith('AIza') ? 'AIza' : 'other',
  };
}

/** The fingerprint as three loggable fields, so no call site has to spell them out. */
export function secretFields(secret: string | null | undefined): DevLogFields {
  const print = fingerprintSecret(secret);
  return { keyPresent: print.present, keyLength: print.length, keyShape: print.shape };
}

// ── The field gate ───────────────────────────────────────────────────────────

/**
 * The shape a field NAME has to have before it is printed.
 *
 * ─── THE ONE DOOR THE ALLOW-LIST LEFT OPEN ───────────────────────────────────
 * Everything above scrubs a field's VALUE. `formatEntry` prints `name=value`, so the name
 * is published too — and until this gate existed nothing looked at it at all. A caller who
 * computes a key rather than typing one walks past every rule in this file:
 *
 *   record('info', 'ai', DEV_EVENTS.aiParse, () =>
 *     Object.fromEntries(medicines.map((m) => [m.name, 1])));
 *
 * Every value there is a harmless number, the redactor reports no objection, and the log
 * line reads `isoniazid=1 rifampicin=1` — which in an Indian OPD context names the
 * diagnosis, the exact harm the header of this file opens by describing. The second reader
 * is the journal replay in `recorder.ts`, which pushes names straight off a file on disk
 * back through `redactFields`; the values are re-washed there and the names were not.
 *
 * ─── WHAT THIS GATE DOES AND DOES NOT PROMISE ────────────────────────────────
 * It is a SHAPE test, and shape cannot tell a programmer's `maxAttempts` from a lower-case
 * drug name. What it does do is refuse everything a computed key looks like in practice —
 * spaces, dots, digits, punctuation, Devanagari, a capital first letter, anything past 32
 * characters, the empty string — and leave only the lower-camelCase identifiers every call
 * site in this app actually writes. A key drawn from a prescription, a filename, a URL, a
 * user's own words or a JSON body from the wire fails it in the overwhelming majority of
 * cases; a key a programmer typed passes it every time.
 *
 * The real guarantee is still the rule this codifies: FIELD NAMES ARE LITERALS. If you
 * find yourself computing one, that is the bug — not this regex.
 */
const LOGGABLE_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

export function isLoggableName(name: string): boolean {
  return LOGGABLE_NAME.test(name);
}

/**
 * Applies every rule above to a whole field bag.
 *
 * Returns a new object; the input is never mutated and never retained. Field ORDER is
 * preserved, because the order a caller wrote them in is the order that reads best.
 *
 * A field whose NAME fails `isLoggableName` is dropped whole — name and value — and only
 * counted. Emitting the name beside a placeholder would defeat the point, and emitting the
 * value under some invented key would print a number nobody can interpret. The count is
 * kept because a silent drop is how a caller never learns their field is not being logged.
 */
export function redactFields(input: DevLogInput | undefined): DevLogFields {
  if (!input) return {};
  const out: Record<string, DevLogValue> = {};
  let kept = 0;
  let namesBlocked = 0;

  for (const [name, value] of Object.entries(input)) {
    if (kept >= MAX_FIELDS) {
      out['fieldsDropped'] = Object.keys(input).length - kept - namesBlocked;
      break;
    }
    if (!isLoggableName(name)) {
      namesBlocked += 1;
      continue;
    }
    out[name] = redactValue(name, value);
    kept += 1;
  }
  if (namesBlocked > 0) out['namesBlocked'] = namesBlocked;
  return out;
}

/** One field. Exported for the tests, which assert on it one forbidden class at a time. */
export function redactValue(name: string, value: unknown): DevLogValue {
  const lower = name.toLowerCase();

  // 1. Clinical and secret names are refused whatever they hold. A number is normally
  //    harmless; a glucose reading is the exception this whole app is built around, and a
  //    field named after a secret is a field somebody will one day put the secret in.
  if (
    CLINICAL_FIELDS.has(lower) ||
    CLINICAL_SUBSTRING.test(lower) ||
    SECRET_SUBSTRING.test(lower)
  ) {
    return '[blocked]';
  }

  // 2. Numbers and booleans carry no content, so they need no allow-list.
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;

  // 3. Text only from a reviewed name, and only after washing.
  if (typeof value === 'string') {
    return TEXT_FIELDS.has(lower) ? scrubText(value) : '[blocked]';
  }

  // 4. An array of primitives is joined and then treated exactly as text would be, so a
  //    list of key names is allowed and a list of medicines is not.
  if (Array.isArray(value)) {
    if (!TEXT_FIELDS.has(lower)) return '[blocked]';
    const flat = value
      .slice(0, 24)
      .map((item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
          ? String(item)
          : '?',
      )
      .join(', ');
    return scrubText(flat);
  }

  // 5. Everything else. Naming the type is the useful part: it tells whoever reads the
  //    log that a caller tried to hand the recorder an object.
  return `[dropped ${typeof value}]`;
}
