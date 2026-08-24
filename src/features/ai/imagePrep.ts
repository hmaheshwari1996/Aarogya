/**
 * Getting the photograph ready to leave the phone — and deciding how much of it does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CROP IS NOT AN OPTIMISATION. IT IS THE PRIVACY CONTROL.
 *
 * Content sent on Google's free tier may be used to improve their products and may be
 * reviewed by humans. An Indian OPD prescription carries, in its top band: the patient's
 * full name, frequently her age and sex, the doctor's name and registration number, and
 * the hospital's name and address. Together those identify a named person and the clinic
 * she attends — and the medicines below them say what she is being treated for. A TB or
 * HIV regimen next to a full name is not a privacy abstraction in India; it has
 * consequences at work and at home.
 *
 * So the header never leaves the device. `cropToMedicineBlock()` is the ONLY function
 * here that produces an uploadable image, it REQUIRES a rectangle, and
 * `prescriptions/extract.ts` has no code path that reaches the network without going
 * through it. The full-resolution original stays in local storage, referenced by
 * `prescription.image_uri`, and is what the user re-reads when she wants to check
 * something the app got wrong.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { scrubText } from '../devlog/redact';
import type { DevLogFields } from '../devlog/types';
import { aiError, type AiError } from './errors';

/**
 * 2576 px on the long edge.
 *
 * Gemini tiles images at 768 px, so anything past a few thousand pixels buys tokens
 * rather than legibility. Below about 2000 px, though, the strength on a handwritten
 * '500' starts dropping characters — and a misread strength is exactly the failure this
 * pipeline cannot have. 2576 is 3.35 tiles across: comfortably above the legibility
 * floor, comfortably below the point where the bill grows for nothing.
 */
export const MAX_LONG_EDGE = 2576;

/** JPEG. PNG on a photograph of paper is three times the bytes for no extra detail. */
export const JPEG_QUALITY = 0.85;

/**
 * Inline data is base64 inside the request body, so it inflates by a third. Well under
 * the API's own limit, and low enough that a corridor connection can still finish it.
 */
export const MAX_INLINE_BYTES = 6_000_000;

/** A rectangle in FRACTIONS of the image (0…1), so it survives any later resize. */
export type CropRect = {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The rectangle that was ACTUALLY cut, in source pixels, after clamping.
 *
 * Pixels rather than the caller's fractions, because the two can differ: `toPixelRect()`
 * clamps a rectangle to the image and then pulls the far edge back a pixel after rounding.
 * A log that echoed the request rather than the result would say the crop was fine on
 * exactly the day it was not.
 */
export type AppliedCrop = {
  /** The photograph as measured, before anything was cut. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  /** The app's default band, or a rectangle she dragged. See `prepFields()`. */
  readonly wasDefault: boolean;
};

export type PreparedImage = {
  /** Local file URI of the cropped, resized JPEG. Safe to persist and to display. */
  readonly uri: string;
  /** Base64, guaranteed free of newlines and padding whitespace. */
  readonly base64: string;
  readonly mimeType: 'image/jpeg';
  readonly width: number;
  readonly height: number;
  /** Decoded size, for the cost estimate and the "this will use data" notice. */
  readonly approxBytes: number;
  /** What was cut, and from what. Never the pixels — see `prepFields()`. */
  readonly crop: AppliedCrop;
};

export type PrepResult = { ok: true; image: PreparedImage } | { ok: false; error: AiError };

/**
 * The top band of a typical OPD prescription: letterhead, patient name, age, date.
 *
 * A PROPOSAL, not a rule. Layouts vary enormously — some clinics print the patient block
 * down the right-hand side, some hand-write it at the bottom — so the crop UI opens with
 * this rectangle and the user drags it. The app never crops unattended.
 *
 * ─── 0.22 WAS RE-EXAMINED AND IS STAYING. HERE IS THE REASONING ──────────────
 *
 * The charge against it is real and is written up at `isDefaultMedicineBlockRect()` below:
 * on a continuation sheet, or on a photograph framed tightly on the medicine list, this
 * band removes drugs rather than a letterhead, and the resulting empty answer is
 * indistinguishable from an unreadable photograph.
 *
 * Lowering the number does not fix that; it trades a failure that is recoverable for one
 * that is not. A crop that is too generous sends the patient block to a free tier whose
 * content may be reviewed by a human, next to a TB regimen, ONCE — and there is no version
 * of "undo" for that. A crop that is too aggressive costs one drag of a rectangle. The
 * asymmetry is the whole argument, and it does not depend on how often either happens.
 *
 * So the fix is not a smaller band, it is making the aggressive case VISIBLE the first time
 * it happens instead of the third evening: `prepFields()` puts the origin, the pixels
 * removed and the encoded size on the same log line, and `defaultCrop` says whether anybody
 * looked at the rectangle. What remains genuinely unsolved is upstream of this file and
 * belongs to whoever owns the crop dialog: "Send the whole page" reads as a privacy
 * downgrade, so the one user careful enough to need it is the one who will never choose it.
 * A control that offered "the medicines start higher up this page" — the same rectangle,
 * named after the problem it solves rather than after the protection it drops — would be
 * picked. That is a copy change in the dialog, not a change to this constant.
 */
export const HEADER_BAND_FRACTION = 0.22;

export function defaultMedicineBlockRect(): CropRect {
  return { originX: 0, originY: HEADER_BAND_FRACTION, width: 1, height: 1 - HEADER_BAND_FRACTION };
}

/**
 * Whether the chosen rectangle still contains the top band.
 *
 * ADVISORY. It powers a warning in the crop UI ("the top of the page is included — names
 * printed there will be sent"), never a refusal: a user who deliberately wants the doctor's
 * name read off the letterhead is making an informed choice about her own data, and an app
 * that silently overrides that choice is worse than one that asks.
 */
export function includesPageHeader(rect: CropRect): boolean {
  return rect.originY < HEADER_BAND_FRACTION;
}

/**
 * Whether this rectangle is the app's proposal, untouched.
 *
 * ─── THE ONE FACT THAT SPLITS TWO OPPOSITE ACTIONS ───────────────────────────
 * "No medicines could be read in this photo" has two causes that read identically
 * everywhere else:
 *
 *   • the photograph is genuinely unreadable — retake it, better light;
 *   • the default band above removed the top 22% of a page whose medicine block starts
 *     high (a continuation sheet has no letterhead to remove, and a photo framed tightly
 *     on the medicine list — which is what a careful person takes — has its first drugs
 *     sliced off). The action is to drag the rectangle. Retaking the photo fails again,
 *     identically, for as many evenings as anyone is willing to spend on it.
 *
 * `defaultCrop=true` next to `medicines=0` is the second one. `defaultCrop=false` — she
 * chose the rectangle and it still read nothing — is the first. The comparison is exact
 * rather than approximate: a rectangle she dragged back to within a hair of the default is
 * still a rectangle she looked at and decided on, and the log should say so.
 */
export function isDefaultMedicineBlockRect(rect: CropRect): boolean {
  const fallback = defaultMedicineBlockRect();
  return (
    rect.originX === fallback.originX &&
    rect.originY === fallback.originY &&
    rect.width === fallback.width &&
    rect.height === fallback.height
  );
}

/**
 * Below this, on the long edge of the ENCODED image, a page of handwriting is not going to
 * be read and the answer will be an empty list.
 *
 * Gemini tiles at 768 px. A whole prescription rendered at barely more than one tile has
 * roughly ten pixels per line of text, which is under the floor for a printed strength and
 * far under it for a handwritten one. This is a REPORTED FLAG and never a refusal: a small
 * photograph is still hers to send, and an app that refused it would turn "the reading was
 * poor" into "the app will not even try", which is worse. It exists so the log can say
 * `smallOutput=true` beside a zero rather than leaving a reader to divide two numbers.
 */
export const MIN_LEGIBLE_LONG_EDGE = 1000;

// ── What the developer log is told about a crop ──────────────────────────────
//
// ─── WHY THESE BAGS ARE BUILT HERE AND NOT AT THE `record()` CALL ────────────
//
// `redact.ts` states the rule these have to satisfy: A FIELD NAME IS A PROMISE ABOUT WHAT
// THE FIELD CAN HOLD. The gate believes the name, so the name has to be chosen by whoever
// knows what the value is — and that is this file, not `prescriptions/extract.ts`, which
// only has a `PreparedImage` in its hand. Naming them here means the promise and the value
// are written on the same screen and reviewed together.
//
// Every field below is a DIMENSION, a PIXEL COUNT, a FRACTION OF A PAGE or a BOOLEAN. None
// of them describes the content of the photograph: 3024×4032 is the same number for a
// prescription, a gas bill and a picture of a cat, and `cropOriginY=0.22` says a fifth of a
// page was cut without saying what was on it. That is the test the header of `redact.ts`
// asks for — "am I willing for this field to be in that chat window" — and these pass it.
//
// They are PURE. No `record()` call lives in this file, deliberately: the caller already
// owns a `prep.page` note per page, and a second producer of the same event would print two
// half-lines per photograph that a reader has to pair up by eye. These are spread into that
// one note, and the `if (isRecording())` guard that wraps it keeps the OFF cost at nothing —
// the thunk that calls these is not invoked at all.

/** Three decimal places, or null for anything that is not a number. */
function fraction(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/**
 * The geometry of a page that WAS prepared, ready to spread into a `prep.page` note.
 *
 * `srcHeight=4032 cropOriginY=0.22 droppedTopPx=887 outHeight=2576` is the line that
 * answers "did the crop eat the medicines?" without the source, a cable or a second run.
 * Without `droppedTopPx` a reader has to multiply two numbers on a phone screen to find out
 * how much of the page went missing, and a diagnosis nobody performs is not a diagnosis.
 */
export function prepFields(image: PreparedImage): DevLogFields {
  const { crop } = image;
  return {
    srcWidth: crop.sourceWidth,
    srcHeight: crop.sourceHeight,
    cropOriginX: fraction(crop.originX / crop.sourceWidth),
    cropOriginY: fraction(crop.originY / crop.sourceHeight),
    cropWidth: fraction(crop.width / crop.sourceWidth),
    cropHeight: fraction(crop.height / crop.sourceHeight),
    /** How many rows of the photograph are above the crop. The 22%, in pixels. */
    droppedTopPx: crop.originY,
    outWidth: image.width,
    outHeight: image.height,
    defaultCrop: crop.wasDefault,
    smallOutput: Math.max(image.width, image.height) < MIN_LEGIBLE_LONG_EDGE,
  };
}

/**
 * The geometry of a page that was NOT prepared — the rectangle as asked for, in fractions.
 *
 * A crop that failed has no pixels to report, and the caller's own `errorCode` says which
 * way it failed. What it cannot say is whether the rectangle was ever plausible, which is
 * the whole question when `crop_required` comes back from a screen that thought it had
 * passed one.
 */
export function cropFields(rect: CropRect): DevLogFields {
  return {
    cropOriginX: fraction(rect.originX),
    cropOriginY: fraction(rect.originY),
    cropWidth: fraction(rect.width),
    cropHeight: fraction(rect.height),
    defaultCrop: isDefaultMedicineBlockRect(rect),
  };
}

/**
 * The mandatory step. Crop → resize → JPEG → base64.
 *
 * Returns a result rather than throwing, so the caller can put the same plain-language
 * sentence in front of the user as it does for a network failure.
 */
export async function cropToMedicineBlock(
  uri: string,
  rect: CropRect,
  options: { maxLongEdge?: number; quality?: number } = {},
): Promise<PrepResult> {
  const maxLongEdge = options.maxLongEdge ?? MAX_LONG_EDGE;
  const quality = options.quality ?? JPEG_QUALITY;

  let size: { width: number; height: number };
  try {
    size = await measureImage(uri);
  } catch (error) {
    return { ok: false, error: aiError('image_unreadable', { detail: describe(error) }) };
  }
  if (size.width < 1 || size.height < 1) {
    return { ok: false, error: aiError('image_unreadable', { detail: 'image has no dimensions' }) };
  }

  const pixels = toPixelRect(rect, size);
  if (pixels === null) {
    return {
      ok: false,
      error: aiError('crop_required', { detail: `unusable crop rectangle ${JSON.stringify(rect)}` }),
    };
  }

  const applied: AppliedCrop = {
    sourceWidth: size.width,
    sourceHeight: size.height,
    ...pixels,
    wasDefault: isDefaultMedicineBlockRect(rect),
  };

  try {
    const first = await renderCropped(uri, applied, maxLongEdge, quality);
    if (first.approxBytes <= MAX_INLINE_BYTES) return { ok: true, image: first };

    // One retry at a smaller size before giving up. A 12 MP phone photograph of a glossy
    // printed prescription can stay large even after cropping, and re-encoding once is
    // far better for the user than an error telling her to photograph less of the paper.
    const second = await renderCropped(uri, applied, 2048, 0.7);
    if (second.approxBytes <= MAX_INLINE_BYTES) return { ok: true, image: second };

    return {
      ok: false,
      error: aiError('bad_request', {
        detail: `cropped image is still ${second.approxBytes} bytes after re-encoding`,
      }),
    };
  } catch (error) {
    return { ok: false, error: aiError('image_unreadable', { detail: describe(error) }) };
  }
}

/**
 * What `extract.ts` calls. The crop rectangle is a REQUIRED argument, by type and at
 * runtime, so there is no accidental path that uploads a whole prescription.
 */
export async function prepareForExtraction(
  uri: string,
  crop: CropRect | null | undefined,
  options: { maxLongEdge?: number; quality?: number } = {},
): Promise<PrepResult> {
  if (!crop) return { ok: false, error: aiError('crop_required') };
  return cropToMedicineBlock(uri, crop, options);
}

/** Width and height in pixels, without writing a file. */
export async function measureImage(uri: string): Promise<{ width: number; height: number }> {
  const image = await ImageManipulator.manipulate(uri).renderAsync();
  return { width: image.width, height: image.height };
}

// ── Internals ────────────────────────────────────────────────────────────────

async function renderCropped(
  uri: string,
  pixels: AppliedCrop,
  maxLongEdge: number,
  quality: number,
): Promise<PreparedImage> {
  const context = ImageManipulator.manipulate(uri).crop({
    originX: pixels.originX,
    originY: pixels.originY,
    width: pixels.width,
    height: pixels.height,
  });

  // Resize AFTER cropping, and only when the crop is actually larger than the target:
  // upscaling a small crop invents pixels the model then reads as detail.
  const longEdge = Math.max(pixels.width, pixels.height);
  if (longEdge > maxLongEdge) {
    if (pixels.width >= pixels.height) context.resize({ width: maxLongEdge });
    else context.resize({ height: maxLongEdge });
  }

  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: quality,
    base64: true,
  });

  // Some encoders wrap base64 at 76 characters. A newline inside `inlineData.data` is a
  // 400 from the API with a message about an invalid argument, which is a miserable
  // thing to debug from a field report.
  const base64 = (saved.base64 ?? '').replace(/\s+/g, '');
  if (base64.length === 0) throw new Error('the encoder returned no base64 data');

  return {
    uri: saved.uri,
    base64,
    mimeType: 'image/jpeg',
    width: saved.width,
    height: saved.height,
    approxBytes: Math.floor((base64.length * 3) / 4),
    crop: pixels,
  };
}

/**
 * Fractions → pixels, clamped to the image.
 *
 * Returns null rather than a degenerate rectangle for anything unusable. A zero-width
 * crop would otherwise reach the native side as a valid-looking request and come back as
 * an opaque decoding failure.
 */
function toPixelRect(
  rect: CropRect,
  size: { width: number; height: number },
): { originX: number; originY: number; width: number; height: number } | null {
  const values = [rect.originX, rect.originY, rect.width, rect.height];
  if (values.some((v) => !Number.isFinite(v))) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;

  const originX = clamp(rect.originX, 0, 1);
  const originY = clamp(rect.originY, 0, 1);
  const width = clamp(rect.width, 0, 1 - originX);
  const height = clamp(rect.height, 0, 1 - originY);

  const px = {
    originX: Math.round(originX * size.width),
    originY: Math.round(originY * size.height),
    width: Math.round(width * size.width),
    height: Math.round(height * size.height),
  };
  if (px.width < 1 || px.height < 1) return null;

  // Rounding four values independently can push the far edge one pixel past the image.
  px.width = Math.min(px.width, size.width - px.originX);
  px.height = Math.min(px.height, size.height - px.originY);
  if (px.width < 1 || px.height < 1) return null;
  return px;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Everything that reaches `AiError.detail` from a foreign thrower, washed.
 *
 * ─── THE LAST PATH LEAK OUT OF THIS APP, AND WHY IT IS FIXED *HERE* ──────────
 *
 * Both callers put this string in `aiError(…, { detail })`, `extract.ts` puts that through
 * `toStoredError()`, and it lands in `prescription.extraction_error` — a TEXT column, and
 * one that SYNCS. `sync/redact.ts::stripLocalPaths()` drops every `*_uri` COLUMN before a
 * row is sealed, which is the right rule and does nothing at all for this: the path is not
 * in a column named after a path, it is in the middle of a sentence in a column that has to
 * travel. Its own header says so — "if a JSON column ever starts carrying a path inside its
 * text, that is a producer-side bug and must be fixed at the producer". This is the
 * producer.
 *
 * And expo-image-manipulator's messages carry the URI by construction, not by accident:
 *
 *   ImageLoadingFailedException  →  "Could not load the image: file:///data/user/0/…"
 *   ImageWriteFailedException    →  "Writing image data to the file has failed: /data/…"
 *
 * Both are wrapped again on the way to JS ("Call to function
 * 'ExpoImageManipulator.manipulate' has been rejected.\n→ Caused by: …"), so the path
 * arrives inside prose, several frames from anything that knows it is a path.
 *
 * ─── ONE SET OF PATTERNS, TWO CONSUMERS ──────────────────────────────────────
 *
 * `scrubText` is `devlog/redact.ts`'s own washer, and it is reused rather than reinvented
 * on purpose. A second copy of `FILE_URI` and `ABS_PATH` living here is a second copy to
 * forget: the day somebody widens the developer log's patterns for a path shape nobody had
 * seen, the sync path would keep leaking it, and nothing would say a word. Widen there,
 * both get it.
 *
 * What SURVIVES is the diagnosis: "Could not load the image: [file omitted .jpg]" still
 * separates a photograph the decoder could not open from a crop rectangle the native side
 * refused, which is the whole reason `detail` exists. The extension is kept because the
 * KIND of file is diagnostic and the name is what is hers.
 *
 * `scrubText` never throws and never returns undefined — that is stated at its definition
 * — so nothing here needs a try/catch that would end up storing the raw string instead.
 */
function describe(error: unknown): string {
  return scrubText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}
