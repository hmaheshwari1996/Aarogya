/**
 * THE TWO QUESTIONS THIS SUITE ANSWERS
 *
 *   1. When a scan reads nothing, can the log tell "the photograph is unreadable" apart
 *      from "the crop removed the medicines"? Those take OPPOSITE actions, and one of them
 *      fails identically however many times it is retried.
 *   2. When the crop itself fails, does a path off her phone travel with the reason?
 *      `AiError.detail` is stored in `prescription.extraction_error`, and that column
 *      SYNCS — so a leak here reaches a server, not just a screen.
 *
 * ─── HOW A FILE THAT IMPORTS A NATIVE MODULE IS TESTED AT ALL ────────────────
 *
 * `imagePrep.ts` imports `expo-image-manipulator`, whose own entry point is TypeScript
 * inside `node_modules` — which `node --test --experimental-strip-types` refuses outright
 * ("Stripping types is currently unsupported for files under node_modules"), before any
 * question of a native module arises. So the specifier is redirected by a resolve hook to a
 * stub that imitates the shipped API: `manipulate(uri)` returns a chainable context,
 * `.crop()` and `.resize()` record actions, `.renderAsync()` applies them.
 *
 * The stub APPLIES the geometry rather than returning fixed numbers. A stub that answered
 * 2576×2576 to everything would let a broken crop pass every assertion below, which is the
 * failure mode of most image tests. The arithmetic here — crop, then resize the long edge —
 * is the same arithmetic `renderCropped` asks the native side to perform, so an assertion
 * on the output dimensions is an assertion about real behaviour.
 *
 * The error strings are REAL. Every one of them is built by
 * `expo-image-manipulator/android/src/main/java/expo/modules/imagemanipulator/
 * ImageManipulatorExceptions.kt` and decorated by expo-modules-core's `DecoratedException`,
 * and both files are quoted where they are used. An invented message would be a test that
 * only proves the regex matches the string somebody wrote to make it match.
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── The stand-in for expo-image-manipulator ──────────────────────────────────
//
// A `data:` module rather than a fixture file: node keys its module cache on the resolved
// URL string, so the hook below and the `import` further down — both handed the identical
// string — get the identical module instance, and the test can reach into `__stub` to
// decide what the next render does. A fixture file under src/ would be a second thing for
// `npm test`'s glob and the bundler to have opinions about.

const STUB_SOURCE = `
export const __stub = { onRender: null };
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' };
export const ImageManipulator = {
  manipulate(uri) {
    const actions = [];
    const context = {
      crop(rect) { actions.push(['crop', rect]); return context; },
      resize(size) { actions.push(['resize', size]); return context; },
      renderAsync: async () => __stub.onRender(uri, actions),
    };
    return context;
  },
};
`;

const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-image-manipulator') return { url: STUB_URL, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Same type-stripping loader constraint as every other suite in this directory: it
      // resolves only fully-specified paths, and this project's tsconfig does not enable
      // `allowImportingTsExtensions`, so the source cannot spell the extension itself.
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

type Action = ['crop', { originX: number; originY: number; width: number; height: number }] | ['resize', { width?: number; height?: number }];
type Stub = { onRender: ((uri: string, actions: Action[]) => Promise<unknown>) | null };

const { __stub } = (await import(STUB_URL)) as { __stub: Stub };

const IMAGE_PREP_MODULE = './imagePrep.ts';
const {
  cropFields,
  cropToMedicineBlock,
  defaultMedicineBlockRect,
  HEADER_BAND_FRACTION,
  isDefaultMedicineBlockRect,
  MIN_LEGIBLE_LONG_EDGE,
  prepareForExtraction,
  prepFields,
} = (await import(IMAGE_PREP_MODULE)) as typeof import('./imagePrep');

const ERRORS_MODULE = './errors.ts';
const { toStoredError } = (await import(ERRORS_MODULE)) as typeof import('./errors');

const REDACT_MODULE = '../devlog/redact.ts';
const { isLoggableName, redactFields } = (await import(
  REDACT_MODULE
)) as typeof import('../devlog/redact');

// ── The camera ───────────────────────────────────────────────────────────────

/**
 * A phone photograph of a prescription, portrait, as a mid-range Android takes it.
 *
 * 3024×4032 is a real 12 MP sensor in portrait. The numbers below are checked against it by
 * hand rather than recomputed by the assertions, so a change to `toPixelRect`'s rounding is
 * something this suite notices instead of something it follows.
 */
const PHOTO = { width: 3024, height: 4032 };

/** Applies crop and resize the way the native side does, and encodes to `bytes` bytes. */
function photograph(source = PHOTO, bytes = 400_000): void {
  __stub.onRender = async (_uri, actions) => {
    let width = source.width;
    let height = source.height;
    for (const [kind, argument] of actions) {
      if (kind === 'crop') {
        width = argument.width;
        height = argument.height;
      } else if (argument.width !== undefined) {
        height = Math.round(height * (argument.width / width));
        width = argument.width;
      } else if (argument.height !== undefined) {
        width = Math.round(width * (argument.height / height));
        height = argument.height;
      }
    }
    return {
      width,
      height,
      saveAsync: async () => ({
        uri: 'file:///data/user/0/in.aarogya.app/cache/ImageManipulator/8a1f.jpg',
        width,
        height,
        // `approxBytes` is floor(length * 3 / 4), so this many base64 characters decode to
        // `bytes`. The encoder in the shipped code wraps at 76 characters on some devices,
        // which is why the newline is here: stripping it is behaviour under test.
        base64: `${'A'.repeat(Math.ceil((bytes * 4) / 3))}\n`,
      }),
    };
  };
}

/** The renderer throws, exactly as a native rejection arrives in JS. */
function fails(error: unknown): void {
  __stub.onRender = async () => {
    throw error;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. FAILURE 3 — a bad crop and a blank page are no longer the same log line
// ─────────────────────────────────────────────────────────────────────────────

test('the default crop reports how much of the page it removed, in pixels and in fractions', async () => {
  photograph();
  const result = await prepareForExtraction('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const fields = prepFields(result.image);

  // The photograph, unchanged. Without it a reader cannot turn a fraction into an amount of
  // paper, and 0.22 of an unknown page is not a fact anybody can act on.
  assert.equal(fields['srcWidth'], 3024);
  assert.equal(fields['srcHeight'], 4032);

  // THE NUMBER THE WHOLE FIX IS FOR. round(0.22 × 4032) rows of the photograph are above
  // the crop and were never sent — about a fifth of the page, and on a continuation sheet
  // that is where the first medicines are.
  assert.equal(fields['cropOriginY'], 0.22);
  assert.equal(fields['droppedTopPx'], 887);
  assert.equal(fields['cropHeight'], 0.78);
  // Nothing was taken off the sides, and saying so is what rules out a sideways crop
  // without a second run.
  assert.equal(fields['cropOriginX'], 0);
  assert.equal(fields['cropWidth'], 1);

  // The encoded page: 3024×3145 cropped, long edge resized to MAX_LONG_EDGE = 2576.
  assert.equal(fields['outHeight'], 2576);
  assert.equal(fields['outWidth'], 2477);
  assert.equal(fields['smallOutput'], false);
});

test('`defaultCrop` is the field that separates the two opposite actions', async () => {
  // ─── WHY THIS ONE FIELD DECIDES THE EVENING ──────────────────────────────
  //
  // `medicines=0` with `defaultCrop=true` means nobody ever looked at the rectangle — so
  // "the app cut the top off" is live, and the action is to drag it. `medicines=0` with
  // `defaultCrop=false` means she chose the rectangle herself and it still read nothing —
  // so the photograph is the problem, and the action is to retake it. Retaking the photo on
  // the first of those fails again, identically, every time.
  photograph();

  const untouched = await prepareForExtraction('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(untouched.ok, true);
  if (untouched.ok) assert.equal(prepFields(untouched.image)['defaultCrop'], true);

  // A rectangle dragged to the whole page — "send the whole page", which is hers to choose.
  const dragged = await prepareForExtraction('file:///photo.jpg', {
    originX: 0,
    originY: 0,
    width: 1,
    height: 1,
  });
  assert.equal(dragged.ok, true);
  if (dragged.ok) {
    const fields = prepFields(dragged.image);
    assert.equal(fields['defaultCrop'], false);
    assert.equal(fields['cropOriginY'], 0);
    assert.equal(fields['droppedTopPx'], 0, 'nothing was removed, and the log says zero');
  }

  // And a rectangle dragged to within a hair of the default is still a decision she made.
  assert.equal(isDefaultMedicineBlockRect(defaultMedicineBlockRect()), true);
  assert.equal(
    isDefaultMedicineBlockRect({ originX: 0, originY: 0.21, width: 1, height: 0.79 }),
    false,
  );
  assert.equal(HEADER_BAND_FRACTION, 0.22, 'the band the default removes, pinned');
});

test('an output too small to read anything says so, rather than leaving a reader to divide', async () => {
  // A photograph taken at the lowest resolution a cheap phone offers, then cropped: the
  // model gets barely more than one 768 px tile of a whole page. It will answer with an
  // empty list, and every other field on the line will look perfectly healthy.
  photograph({ width: 640, height: 960 });
  const small = await prepareForExtraction('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(small.ok, true);
  if (!small.ok) return;

  const fields = prepFields(small.image);
  assert.equal(fields['outWidth'], 640);
  assert.equal(fields['outHeight'], 749);
  assert.equal(fields['smallOutput'], true);
  assert.ok((fields['outHeight'] as number) < MIN_LEGIBLE_LONG_EDGE);

  // It is a FLAG and never a refusal. A small photograph is still hers to send, and an app
  // that would not even try is worse than one that tries and reads poorly.
  assert.ok(small.image.base64.length > 0);
});

test('a crop that produced no pixels still reports the rectangle it was asked for', () => {
  // `crop_required` arriving from a screen that believed it passed a rectangle is a code
  // with nothing behind it. These are the numbers that say what the screen actually sent.
  const fields = cropFields({ originX: 0, originY: 0.995, width: 1, height: 0.005 });
  assert.equal(fields['cropOriginY'], 0.995);
  assert.equal(fields['cropHeight'], 0.005);
  assert.equal(fields['defaultCrop'], false);

  // A rectangle carrying NaN — the shape `toPixelRect` refuses — must not put `NaN` in a
  // note. `null` is the honest reading and is what `DevLogValue` allows.
  const broken = cropFields({ originX: 0, originY: Number.NaN, width: 1, height: 0.78 });
  assert.equal(broken['cropOriginY'], null);
});

test('every geometry field survives the redactor unchanged — the names keep their promise', async () => {
  // ─── THE TEST THAT MATTERS MOST FOR A FIELD ADDED TO THIS LOG ────────────
  //
  // redact.ts is an ALLOW-LIST and a field name is a promise: a name that sounds clinical
  // is refused whatever it holds, including a number. A field that comes out `[blocked]` has
  // not been logged in any sense that helps her son — this is exactly how `medicinesRead: 7`
  // silently logged nothing at all. So the bag is driven through the real redactor and
  // compared value for value.
  photograph();
  const result = await prepareForExtraction('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const fields = prepFields(result.image);
  const redacted = redactFields(fields);

  assert.deepEqual(redacted, fields, 'nothing was blocked, dropped, renamed or reordered');
  for (const name of Object.keys(fields)) {
    assert.ok(isLoggableName(name), `${name} must pass the field-name shape gate`);
  }
  assert.equal(redacted['namesBlocked'], undefined);
  assert.equal(redacted['fieldsDropped'], undefined);

  // And the same for the failure bag.
  const crop = cropFields(defaultMedicineBlockRect());
  assert.deepEqual(redactFields(crop), crop);

  // Every value is a dimension, a fraction or a boolean — never a string that could carry
  // somebody's words, and never an object the redactor would have to walk.
  for (const value of Object.values(fields)) {
    assert.ok(
      typeof value === 'number' || typeof value === 'boolean' || value === null,
      `a geometry field must not be ${typeof value}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. THE LAST PATH LEAK — `AiError.detail` reaches a column that syncs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real thing, assembled from the shipped sources:
 *
 *   ImageManipulatorExceptions.kt:12
 *     ImageLoadingFailedException(image, cause) : DecoratedException("Could not load the
 *     image: $image", cause)
 *   expo-modules-core CodedException.kt:141
 *     DecoratedException → "$message${lineSeparator}→ Caused by: ${cause.localizedMessage}"
 *   CodedException.kt (FunctionCallException)
 *     "Call to function '$moduleName.$methodName' has been rejected."
 *
 * `$image` is `url.toString()` — the URI handed to `manipulate()`, which on this app's path
 * is the file expo-image-picker wrote into the app's own cache directory.
 */
const LOADING_FAILED =
  "Call to function 'ExpoImageManipulator.manipulate' has been rejected.\n" +
  '→ Caused by: Could not load the image: ' +
  'file:///data/user/0/in.aarogya.app/cache/ImagePicker/9f0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b.jpeg\n' +
  '→ Caused by: java.io.FileNotFoundException: open failed: ENOENT (No such file or directory)';

/** ImageManipulatorExceptions.kt:15 — thrown from FileUtils.kt:19 with `dir.path`. */
const WRITE_FAILED =
  'Writing image data to the file has failed: ' +
  '/data/user/0/in.aarogya.app/cache/ImageManipulator';

test('a native load failure loses the path and keeps the diagnosis', async () => {
  fails(Object.assign(new Error(LOADING_FAILED), { code: 'ERR_IMAGE_LOADING_FAILED' }));

  const result = await cropToMedicineBlock('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(result.ok, false);
  if (result.ok) return;

  const detail = result.error.detail ?? '';
  assert.equal(result.error.code, 'image_unreadable');

  // ─── WHAT MUST NOT BE THERE ──────────────────────────────────────────────
  //
  // This string is put through `toStoredError()` into `prescription.extraction_error`, and
  // that column is sealed and uploaded by sync/redact.ts, which drops `*_uri` COLUMNS and
  // cannot see a path sitting inside the TEXT of one that has to travel.
  const stored = toStoredError(result.error);
  for (const forbidden of ['file://', '/data/', 'ImagePicker', 'in.aarogya.app', '9f0e1a2b']) {
    assert.ok(!detail.includes(forbidden), `${forbidden} must not reach AiError.detail`);
    assert.ok(!stored.includes(forbidden), `${forbidden} must not reach extraction_error`);
  }

  // ─── WHAT MUST STILL BE THERE ────────────────────────────────────────────
  //
  // Over-redaction that removes the reason is not a fix, it is the same failure with a
  // different cause. "Could not load the image" separates a photograph the decoder could
  // not open from a rectangle the native side refused, and the extension says what KIND of
  // file it was — which is the diagnostic half of a path, without the half that is hers.
  assert.match(detail, /Could not load the image/);
  assert.match(detail, /\[file omitted \.jpeg\]/);
  assert.match(stored, /^image_unreadable: /);

  // One line. `extraction_error` is read in a table cell and in a support conversation, and
  // the errno text arrives with two hard newlines in it.
  assert.ok(!detail.includes('\n'));
});

test('a native write failure leaks no path either — the crop stage is scrubbed too', async () => {
  // The SECOND call site. The first (`measureImage`) and this one (`renderCropped`) are
  // separate try/catch blocks, and a fix applied to one of them is the kind of thing that
  // looks complete in a diff and is not.
  let renders = 0;
  __stub.onRender = async () => {
    renders += 1;
    if (renders === 1) return { width: PHOTO.width, height: PHOTO.height };
    throw new Error(WRITE_FAILED);
  };

  const result = await cropToMedicineBlock('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(result.ok, false);
  if (result.ok) return;

  const detail = result.error.detail ?? '';
  assert.ok(renders > 1, 'the measure succeeded and the crop is what failed');
  assert.ok(!detail.includes('/data/'), 'an absolute path must not reach a column that syncs');
  assert.ok(!detail.includes('in.aarogya.app'));
  assert.match(detail, /Writing image data to the file has failed/);
  assert.ok(!toStoredError(result.error).includes('/data/'));
});

test('a thrown non-Error is washed as well, because String() is where a URI hides', async () => {
  // Native rejections do not always arrive as an `Error`. `describe()` falls through to
  // `String(error)` for those, and that branch used to be the unscrubbed one.
  fails({ toString: () => `rejected: file:///data/user/0/in.aarogya.app/cache/x.jpg` });

  const result = await cropToMedicineBlock('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(!(result.error.detail ?? '').includes('file://'));
  assert.match(result.error.detail ?? '', /\[file omitted \.jpg\]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The rules the crop exists for, still true
// ─────────────────────────────────────────────────────────────────────────────

test('no rectangle means no upload, and the base64 never carries a newline', async () => {
  photograph();

  // The crop is the privacy control. A missing rectangle is refused before any pixel is
  // touched — there is no path from here to the network that sends a whole page by omission.
  const missing = await prepareForExtraction('file:///photo.jpg', null);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'crop_required');

  const ready = await prepareForExtraction('file:///photo.jpg', defaultMedicineBlockRect());
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  // A newline inside `inlineData.data` is a 400 with a message about an invalid argument,
  // which is a miserable thing to debug from a field report.
  assert.ok(!/\s/.test(ready.image.base64));
  assert.equal(ready.image.mimeType, 'image/jpeg');
});
