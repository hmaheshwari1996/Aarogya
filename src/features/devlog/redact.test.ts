/**
 * Tests for the one thing in this feature that cannot be allowed to be wrong once.
 *
 * A bug in the ring costs a lost note. A bug in the redactor puts a woman's tuberculosis
 * regimen into a chat window, and there is no taking it back. So the assertions below are
 * organised by FORBIDDEN CLASS — her name, a medicine, the photograph, the API key, a
 * reading — rather than by function, because the classes are the requirement and the
 * functions are just where they happen to be enforced today.
 *
 * NOTE ON THE IMPORT: Node's type-stripping loader resolves only fully-specified `./x.ts`
 * paths, while this project's tsconfig does not enable `allowImportingTsExtensions`.
 * Loading through a non-literal specifier and re-typing the namespace satisfies both the
 * runtime and `tsc`. Same hook as `features/ai/gemini.test.ts`.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const MODULE = './redact.ts';
const {
  MAX_TEXT_CHARS,
  fingerprintSecret,
  isLoggableName,
  redactFields,
  redactValue,
  scrubText,
  secretFields,
} = (await import(MODULE)) as typeof import('./redact');

/** Everything in the log, flattened, so an assertion can look at the whole note at once. */
function everything(fields: Record<string, unknown>): string {
  return JSON.stringify(redactFields(fields));
}

// ── Forbidden class 1: her name, and anything else about the person ──────────

test('a name never survives, whatever the field is called', () => {
  for (const field of ['name', 'patientName', 'profileName', 'fullName', 'firstName']) {
    const out = everything({ [field]: 'Kamala Devi Sharma' });
    assert.doesNotMatch(out, /Kamala/, `${field} leaked a name`);
    assert.doesNotMatch(out, /Sharma/, `${field} leaked a name`);
  }
});

test('a profile or prescription id never survives — an id joins straight back to her record', () => {
  const out = everything({
    profileId: '9f1c2a4e-0000-4000-8000-1234567890ab',
    prescriptionId: '3b7d1e55-0000-4000-8000-abcdefabcdef',
  });
  assert.doesNotMatch(out, /9f1c2a4e/);
  assert.doesNotMatch(out, /3b7d1e55/);
});

// ── Forbidden class 2: a medicine ────────────────────────────────────────────

test('a medicine name never survives, in any field, in any container', () => {
  const cases: Record<string, unknown>[] = [
    { medicineName: 'Isoniazid 300 mg' },
    { medicines: ['Rifampicin', 'Metformin'] },
    { drug: 'Telmisartan' },
    { firstMedicine: 'Pyrazinamide' },
    // The careless-caller case this module exists for: the whole parsed answer, handed
    // to the logger by somebody in a hurry.
    { response: { medicines: [{ nameAsWritten: 'Ethambutol' }] } },
    // And the same thing under a name that sounds innocent.
    { detail: 'schema_mismatch: {"medicines":[{"name_as_written":"Ethambutol"}]}' },
  ];
  for (const fields of cases) {
    const out = everything(fields);
    for (const drug of ['Isoniazid', 'Rifampicin', 'Metformin', 'Telmisartan', 'Pyrazinamide', 'Ethambutol']) {
      assert.doesNotMatch(out, new RegExp(drug), `${JSON.stringify(fields)} leaked ${drug}`);
    }
  }
});

test('an unreviewed text field is blocked rather than trusted — that is the whole design', () => {
  // The point of an allow-list: a field name nobody has thought about yet fails CLOSED.
  assert.equal(redactValue('somethingNobodyReviewed', 'anything at all'), '[blocked]');
  // …while a field name that WAS reviewed passes, washed.
  assert.equal(redactValue('apiStatus', 'PERMISSION_DENIED'), 'PERMISSION_DENIED');
});

// ── Forbidden class 3: the photograph ────────────────────────────────────────

test('the prescription image never survives, as a data URI, as base64, or as a path', () => {
  const base64 = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs'.repeat(4);

  const dataUri = scrubText(`sent data:image/jpeg;base64,${base64} to the model`);
  assert.doesNotMatch(dataUri, /R0lGOD/);
  assert.match(dataUri, /\[image omitted\]/);

  const raw = scrubText(base64);
  assert.doesNotMatch(raw, /R0lGOD/);
  assert.match(raw, /\[binary omitted, \d+ chars\]/);

  // A URI in a shared log names a file that still exists on her phone.
  const uri = scrubText('failed to open file:///data/user/0/in.aarogya/cache/IMG_0042.jpg');
  assert.doesNotMatch(uri, /IMG_0042/);
  assert.doesNotMatch(uri, /aarogya\/cache/);
  // The KIND of file survives, because that is diagnostic and harmless.
  assert.match(uri, /\[file omitted \.jpg\]/);

  // ─── THE SCHEME IS FILE_URI'S OWN JOB, AND NOTHING ELSE'S ────────────────
  //
  // Everything above ALSO matches ABS_PATH: `/data/user/0/…` is caught whether or not
  // `file://` is ever recognised, so those three assertions stayed green while FILE_URI was
  // deleted outright. That is a hole rather than a redundancy, because it is only true for
  // the roots ABS_PATH knows.
  //
  // `content://` is under none of them. It is also what expo-image-picker hands back on
  // Android for anything chosen from the gallery, and `sync/redact.ts` and `backup/restore.ts`
  // both treat it as a local path for exactly that reason — so it is a real value that a
  // real field carries, and with FILE_URI gone it would travel whole into a chat window.
  const content = scrubText('could not open content://media/external/images/media/10427');
  assert.doesNotMatch(content, /content:\/\//);
  assert.doesNotMatch(content, /10427/);
  assert.match(content, /\[file omitted\]/);

  // Same argument, one step further: a `file://` URI outside every ABS_PATH root. If the
  // scheme is not recognised on its own, this one walks out untouched.
  const elsewhere = scrubText('failed to open file:///mnt/expand/0000/media/0/Pictures/rx.jpg');
  assert.doesNotMatch(elsewhere, /Pictures/);
  assert.doesNotMatch(elsewhere, /mnt/);
  assert.match(elsewhere, /\[file omitted \.jpg\]/);

  // And the field-level rule refuses the whole class by name too.
  assert.equal(redactValue('imageUri', 'file:///whatever.jpg'), '[blocked]');
  assert.equal(redactValue('imageBase64', base64), '[blocked]');
});

// ── Forbidden class 4: the API key ───────────────────────────────────────────

test('the key never survives — not whole, not as a prefix, not inside a sentence', () => {
  const key = 'AIzaSyD-EXAMPLE-not-a-real-key-000000000';

  assert.equal(redactValue('apiKey', key), '[blocked]');
  assert.equal(redactValue('key', key), '[blocked]');
  assert.equal(redactValue('token', key), '[blocked]');

  // Google echoes the key back inside its own error prose more often than it should.
  const echoed = scrubText(`API key not valid: ${key}. Please pass a valid API key.`);
  assert.doesNotMatch(echoed, /AIzaSyD/);
  assert.doesNotMatch(echoed, /EXAMPLE/);
  assert.match(echoed, /\[key omitted\]/);
});

test('the fingerprint answers the three real questions and carries no bytes of the secret', () => {
  const key = 'AIzaSyD-EXAMPLE-not-a-real-key-000000000';
  const print = fingerprintSecret(key);

  assert.equal(print.present, true);
  assert.equal(print.length, key.length);
  assert.equal(print.shape, 'AIza');

  // Nothing else. In particular there is no hash: a hash of a secret is a stable
  // identifier for that secret, and this log is assumed to end up in a chat window.
  assert.deepEqual(Object.keys(print).sort(), ['length', 'present', 'shape']);
  const serialised = JSON.stringify(secretFields(key));
  assert.doesNotMatch(serialised, /SyD/);
  assert.doesNotMatch(serialised, /EXAMPLE/);

  const missing = fingerprintSecret(null);
  assert.deepEqual(missing, { present: false, length: 0, shape: 'none' });
  // An empty-after-trim key is "no key", not a key of length zero that exists.
  assert.equal(fingerprintSecret('   ').present, false);
});

// ── Forbidden class 5: a reading ─────────────────────────────────────────────

test('a measurement is refused even though it is only a number', () => {
  // The one exception to "a number cannot leak". A glucose of 18 IS the sensitive fact,
  // and it is the reason this app exists.
  for (const field of ['glucose', 'sugar', 'systolic', 'diastolic', 'spo2', 'weight', 'value']) {
    assert.equal(redactValue(field, 18), '[blocked]', `${field} leaked a reading`);
  }
  // Counts and sizes, which look identical to a regex and are not remotely the same
  // thing, are untouched.
  assert.equal(redactValue('outputTokens', 18), 18);
  assert.equal(redactValue('approxBytes', 512_000), 512_000);
});

test('a count must not be named after the thing it counts — and having been renamed, it is logged', () => {
  // The pair that pins the rule down. Both are the number 7. One is named after a drug
  // and is refused; the other says what it actually is and goes through. Nothing about
  // the VALUE distinguishes them, which is exactly why the NAME has to decide.
  assert.equal(redactValue('medicinesRead', 7), '[blocked]');
  assert.equal(redactValue('itemsRead', 7), 7);

  // The whole note from features/prescriptions/extract.ts, which report 7 reads.
  const out = redactFields({
    itemsRead: 7,
    warningCodes: 'missing_strength, ambiguous_frequency',
    countMismatch: true,
    attempts: 2,
    elapsedMs: 8_400,
  });
  assert.equal(out['itemsRead'], 7);
  assert.equal(out['countMismatch'], true);
  assert.equal(out['attempts'], 2);
  assert.match(String(out['warningCodes']), /ambiguous_frequency/);
});

test('an error MESSAGE is refused, because two of this repo\'s own errors put a reading in one', () => {
  // Not hypothetical. Both strings below are what these constructors actually build:
  //   InstrumentBoundsError — src/db/repositories/readings.ts
  //   BriefcaseCopyError    — src/app/briefcase/_lib.tsx
  const measurement = 'Blood sugar of 412 is outside what any instrument can report (10–900).';
  const paper =
    'briefcase copy failed: failed (Error: /storage/emulated/0/Download/TB discharge summary.pdf: open failed: ENOENT)';

  assert.equal(redactValue('errorMessage', measurement), '[blocked]');
  assert.equal(redactValue('errorMessage', paper), '[blocked]');

  // Whole-bag, the way `recordAppError` actually calls it: the reading is gone and the
  // two fields that ARE machine text by construction still say what happened.
  const out = redactFields({
    where: 'uncaught',
    errorName: 'InstrumentBoundsError',
    errorMessage: measurement,
    stackTop: 'at assertInstrumentBounds (/data/user/0/in.aarogya.care/files/bundle.js:9:1)',
  });
  assert.doesNotMatch(JSON.stringify(out), /412/, 'a measurement reached the log');
  assert.doesNotMatch(JSON.stringify(out), /Blood sugar/);
  assert.equal(out['errorMessage'], '[blocked]');
  assert.equal(out['errorName'], 'InstrumentBoundsError');
  assert.equal(out['where'], 'uncaught');
  // The frame keeps its line and column — the path is what had to go, not the position.
  assert.match(String(out['stackTop']), /assertInstrumentBounds/);
  assert.match(String(out['stackTop']), /:9:1/);
  assert.doesNotMatch(String(out['stackTop']), /in\.aarogya\.care/);
});

test('a file name with spaces in it does not survive a path — the scrubbers stop at delimiters, not at the first space', () => {
  // THE HOLE THIS CLOSES: the run used to end at whitespace, so everything from the
  // second word of the file name onwards walked out. A paper is called "TB discharge
  // summary.pdf", and the name of that paper is the diagnosis.
  const inParens = scrubText(
    'copy failed (Error: /storage/emulated/0/Download/TB discharge summary.pdf: open failed)',
  );
  assert.doesNotMatch(inParens, /discharge/i, 'a file name leaked past the path');
  assert.doesNotMatch(inParens, /summary/i);
  assert.doesNotMatch(inParens, /emulated/);
  // The delimiter is what ends it, so the errno explanation is still readable.
  assert.match(inParens, /open failed/);

  const uri = scrubText('could not read "file:///data/user/0/in.aarogya.care/files/Sugar chart Nov.pdf"');
  assert.doesNotMatch(uri, /Sugar|chart|Nov/i);
  assert.match(uri, /\[file omitted/);

  // And the ordinary no-spaces path is unchanged, extension hint and all.
  assert.match(
    scrubText('failed to open file:///data/user/0/in.aarogya/cache/IMG_0042.jpg'),
    /\[file omitted \.jpg\]/,
  );
});

// ── What DOES get through, because a log that says nothing is not a log ──────

test('the fields that make a failure diagnosable all survive', () => {
  const fields = redactFields({
    httpStatus: 403,
    apiStatus: 'PERMISSION_DENIED',
    apiMessage: 'Requests from this Android client application are blocked.',
    modelId: 'gemini-3.6-flash',
    finishReason: 'MAX_TOKENS',
    thoughtTokens: 8_100,
    outputTokens: 0,
    keyPresent: true,
    keyLength: 39,
    keyShape: 'AIza',
    elapsedMs: 4_312,
  });

  assert.equal(fields['httpStatus'], 403);
  assert.equal(fields['apiStatus'], 'PERMISSION_DENIED');
  assert.match(String(fields['apiMessage']), /Android client application are blocked/);
  assert.equal(fields['modelId'], 'gemini-3.6-flash');
  assert.equal(fields['finishReason'], 'MAX_TOKENS');
  assert.equal(fields['thoughtTokens'], 8_100);
  assert.equal(fields['outputTokens'], 0);
  assert.equal(fields['keyShape'], 'AIza');
});

// ── Shape rules ──────────────────────────────────────────────────────────────

test('nothing nested ever reaches the ring, whatever a caller passes', () => {
  assert.equal(redactValue('modelId', { id: 'x' }), '[dropped object]');
  assert.equal(
    redactValue('modelId', () => 'x'),
    '[dropped function]',
  );
  assert.equal(redactValue('modelId', undefined), null);
  assert.equal(redactValue('outputTokens', Number.NaN), null);
  assert.equal(redactValue('outputTokens', Number.POSITIVE_INFINITY), null);
});

test('long text is capped, and says how much was cut', () => {
  // Words, not one long run of characters — a 550-character unbroken alphanumeric string
  // is caught by the base64 scrubber first, which is itself correct and is asserted above.
  const long = 'quota exceeded '.repeat(40);
  const out = scrubText(long);
  const expectedOverflow = long.trim().length - MAX_TEXT_CHARS;
  assert.ok(out.length < MAX_TEXT_CHARS + 40, `capped output was ${out.length} chars`);
  assert.match(out, new RegExp(`… \\(\\+${expectedOverflow}\\)$`));
});

test('a note cannot become a dump — the field count is capped and the overflow is named', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 60; i += 1) many[`count${i}`] = i;
  const out = redactFields(many);
  assert.ok(Object.keys(out).length <= 33, `kept ${Object.keys(out).length} fields`);
  assert.equal(out['fieldsDropped'], 28);
});

test('a field NAME is published too, so a computed key is refused before it is printed', () => {
  // The failure this guards: a caller builds the bag out of the model's answer instead of
  // typing the keys. Every VALUE is a harmless number and every rule above says yes, while
  // `formatEntry` prints `name=value` and the line names the regimen.
  const out = everything({
    'Isoniazid 300mg': 1,
    'Rifampicin (RCin)': 1,
    'तपेदिक': 1,
    '/data/user/0/in.aarogya/files/page1.jpg': 2,
    '': 3,
  });
  assert.doesNotMatch(out, /Isoniazid/i);
  assert.doesNotMatch(out, /Rifampicin|RCin/i);
  assert.doesNotMatch(out, /तपेदिक/);
  assert.doesNotMatch(out, /page1\.jpg/);
  // Refused, not silently swallowed: a caller whose fields vanish has to be able to see it.
  assert.equal(JSON.parse(out)['namesBlocked'], 5);

  // And the names the app actually writes all still go through untouched.
  for (const name of [
    'httpStatus',
    'apiMessage',
    'maxOutputTokens',
    'keyShape',
    'ok',
    'ts',
    'count0',
  ]) {
    assert.equal(isLoggableName(name), true, `${name} should be loggable`);
  }
});

test('an e-mail address and a long digit run are removed from otherwise-allowed prose', () => {
  const out = scrubText('contact ramesh@example.com or 98765 43210 about quota');
  assert.doesNotMatch(out, /ramesh@example\.com/);
  assert.doesNotMatch(out, /98765/);
  assert.match(out, /quota/);
});
