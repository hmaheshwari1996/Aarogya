/**
 * Photos → cropped images → model → parsed extraction → `prescription.extraction_json`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CAPTURE FIRST. ALWAYS.
 *
 * The row and the photographs are persisted BEFORE the network is touched, and the call
 * that touches the network is a separate, repeatable action against a row that already
 * exists. That ordering is the whole design of this file, and it is not a nicety:
 *
 *   • The photo is taken in a clinic corridor with one bar of signal, sixty seconds
 *     before the auto-rickshaw leaves. If extraction has to succeed for the prescription
 *     to be saved, a failed extraction loses the only copy of the paper.
 *   • A 300-second timeout is survivable when it costs a wait. It is not survivable when
 *     it costs the record.
 *   • "Read it again" becomes an ordinary button rather than a re-photograph.
 *
 * `capturePrescription()` writes the draft (the capture screen does this itself today).
 * `runExtraction()` is then a retryable operation on that draft, and every failure leaves
 * the draft where it was, with a stored reason and the photographs intact.
 *
 * THE CROP IS NOT OPTIONAL. Every page goes through `cropToMedicineBlock()` before it is
 * encoded; when the caller supplies no rectangle, the app's default band is applied,
 * which removes the letterhead and the patient block. There is no path from here to the
 * network that sends a whole page. See `ai/imagePrep.ts` for why that matters on the free
 * tier.
 *
 * NOTHING HERE CONFIRMS ANYTHING. Everything this file writes lands in
 * `extraction_json` as a proposal. No `medicine`, `dose_schedule` or `care_event` row is
 * created here — see `./confirm.ts` and `../care/`, both of which require a human first.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { toLocalDate } from '../../lib/datetime';
import { inTransaction, type Tx } from '../../db/repositories/_shared';
import {
  createPrescription,
  getPrescription,
  restoreExtractionStatus,
  setExtracted,
  setExtractionFailed,
  setExtracting,
  updatePrescription,
  type Prescription,
} from '../../db/repositories/prescriptions';
import { beginRun, endRun, isRecording, record } from '../devlog/recorder';
import { DEV_EVENTS } from '../devlog/types';
import { aiError, toStoredError, type AiError } from '../ai/errors';
import {
  cropFields,
  defaultMedicineBlockRect,
  prepareForExtraction,
  prepFields,
  type CropRect,
  type PreparedImage,
} from '../ai/imagePrep';
import {
  doneProgress,
  preparingProgress,
  publishAiProgress,
  resetAiProgress,
  savingProgress,
} from '../ai/progress';
import { getProvider, type AiAttemptListener, type AiUsage } from '../ai/provider';
import { decodeFrequency } from './frequency';
import { buildPrescriptionPrompt } from './prompt';
import {
  PRESCRIPTION_RESPONSE_SCHEMA,
  frequencyExpression,
  parsePrescriptionExtraction,
  type ParsedMedicine,
  type ParsedPrescription,
  type ParseWarning,
} from './schema';

/** Bumped whenever the stored shape changes. Old rows stay readable. */
export const EXTRACTION_ENVELOPE_VERSION = 1;

/**
 * Bumped whenever `prompt.ts` changes in a way that could change output.
 *
 * Stored with every extraction so a wrong reading found six months later can be traced to
 * the instruction that produced it. Without it, "the model got worse" and "we changed the
 * prompt" are indistinguishable.
 */
export const PROMPT_VERSION = 2;

/**
 * Four pages, and a total inline budget well under the API's limit.
 *
 * A prescription longer than four photographed pages is a scanning problem, and pushing
 * twenty megabytes up a clinic-corridor connection fails slowly rather than quickly —
 * which is the worst way for anything to fail.
 */
export const MAX_PAGES = 4;
const MAX_TOTAL_INLINE_BYTES = 12_000_000;

export type CaptureInput = {
  readonly profileId: string;
  /** Local URI of the FULL-resolution photograph. It never leaves the phone. */
  readonly imageUri: string;
};

export type ExtractInput = {
  readonly prescriptionId: string;
  /** Optional: the profile is read from the prescription row, never trusted from here. */
  readonly profileId?: string;
  /** A single page. Use this or `imageUris`; both are accepted. */
  readonly imageUri?: string;
  /** Several pages, in order, page 1 first. Wins over `imageUri` when both are given. */
  readonly imageUris?: readonly string[];
  /**
   * One rectangle applied to every page.
   *
   * Supplying it is how a screen passes on a choice the USER made in a crop dialog —
   * including "send the whole page", which is hers to make. When nothing is supplied the
   * app's default band is used, so the letterhead is removed either way and there is no
   * path from here to the network that sends an uncropped page by omission.
   */
  readonly crop?: CropRect | null;
  /** Per-page rectangles. Entry `i` wins over `crop` for page `i`. */
  readonly crops?: readonly (CropRect | null | undefined)[];
  /** Recorded with the result so a specific reading can be reproduced exactly. */
  readonly seed?: number;
  /** The user navigating away. Separate from the provider's own timeout. */
  readonly signal?: AbortSignal;
  /**
   * Narration for the screen while this is running: one event before every attempt, and
   * one before every wait between attempts.
   *
   * WHY A SCREEN HAS TO PASS THIS. A 503 is retried automatically now (`ai/retry.ts`), and
   * a retry nobody can see is worse than the failure it replaced — fifteen seconds of an
   * unchanging "Reading the prescription" is indistinguishable from a frozen phone, and the
   * reasonable response to a frozen phone is to kill the app, which throws away the very
   * wait that was about to succeed. `retry.ts` names this trap in its own header; this
   * field is the only way the news gets out of that loop and onto a screen.
   *
   * The type is `AiAttemptListener` from the provider boundary, NOT a shape invented here.
   * One vocabulary for attempts means the copy, the tests and the loop all move together.
   *
   * OPTIONAL, and it must stay optional. `confirm.ts`, the reconcile screen and every test
   * call `runExtraction` without it; a required listener would be a compile error in a
   * dozen call sites that have no screen to narrate to.
   *
   * Contract inherited from `AiRequest.onAttempt`: called synchronously from inside the
   * retry loop, so it must not throw and must not block. A `setState` is fine; an `await`
   * is not.
   */
  readonly onAttempt?: AiAttemptListener;
  readonly todayLocalDate?: string;
  readonly modelId?: string;
};

export type ExtractionProvenance = {
  readonly envelopeVersion: number;
  readonly promptVersion: number;
  readonly modelId: string;
  readonly seed: number | null;
  readonly receivedAtEpoch: number;
  readonly usage: AiUsage;
  readonly pagesSent: number;
  readonly croppedImageUris: readonly string[];
  readonly warnings: readonly ParseWarning[];
};

export type ExtractOutcome =
  | {
      ok: true;
      prescriptionId: string;
      extraction: ParsedPrescription;
      warnings: readonly ParseWarning[];
      provenance: ExtractionProvenance;
    }
  | { ok: false; prescriptionId: string; error: AiError };

/**
 * Thrown by `extractPrescription()`.
 *
 * `message` is the plain-language sentence the user should see, so a caller that only
 * knows how to display `error.message` still says something useful. `error` carries the
 * code and the next step for a caller that wants to be smarter than that.
 */
export class PrescriptionExtractionError extends Error {
  readonly error: AiError;

  constructor(error: AiError) {
    super(error.userMessage);
    this.name = 'PrescriptionExtractionError';
    this.error = error;
  }
}

export function isExtractionError(value: unknown): value is PrescriptionExtractionError {
  return value instanceof PrescriptionExtractionError;
}

/**
 * Step one, and it never fails for a reason outside this device.
 *
 * The capture screen writes the row the moment the shutter closes, before anything else
 * happens, so everything after it is recoverable. This exists for callers that do not.
 */
export async function capturePrescription(input: CaptureInput, tx?: Tx): Promise<string> {
  return createPrescription({ profileId: input.profileId, imageUri: input.imageUri }, tx);
}

/**
 * Step two, separately retryable, returning a typed outcome.
 *
 * Never throws for an expected failure: each one has its own sentence and its own next
 * step (see `ai/errors.ts`), and collapsing them into a thrown Error three frames up is
 * how "check your key" becomes "something went wrong".
 */
export async function runExtraction(input: ExtractInput): Promise<ExtractOutcome> {
  // ── THE RUN'S TWO BOOKENDS, AND WHY THEY ARE A WRAPPER RATHER THAN INLINE ──
  //
  // `extractOnce` below has eleven `return` statements — a missing photograph, a crop that
  // failed, a cancel, four flavours of provider failure, a parse failure, success. Opening
  // a log run and finishing the progress bar at each of them is a maintenance promise
  // nobody keeps: the twelfth exit gets added next year and the bar hangs at 92% forever
  // on whatever path it takes.
  //
  // So the bookends live here, in a `finally`, and cover the throws as well — an exception
  // out of the database layer is exactly when somebody wants to know where the scan got to.
  //
  // `resetAiProgress()` is called here and ALSO by the scan screen. It is idempotent, and
  // the screen's own comment already anticipates this; the duplication is deliberate,
  // because `confirm.ts` and the reconcile screen call `runExtraction` with no screen at
  // all, and a bar that starts wherever the last scan finished is a bar that lies on the
  // second scan of the day.
  resetAiProgress();
  const runId = beginRun('scan');
  let outcome: ExtractOutcome | null = null;
  try {
    outcome = await extractOnce(input);
    return outcome;
  } finally {
    // `outcome === null` means `extractOnce` threw rather than returned. That is not one of
    // the app's own failure codes, and saying `unknown` is the honest reading of it.
    publishAiProgress(
      outcome === null
        ? doneProgress(false, 'unknown')
        : doneProgress(outcome.ok, outcome.ok ? null : outcome.error.code),
    );
    endRun(runId, {
      ok: outcome?.ok ?? false,
      errorCode: outcome === null ? 'unknown' : outcome.ok ? null : outcome.error.code,
      threw: outcome === null,
    });
  }
}

async function extractOnce(input: ExtractInput): Promise<ExtractOutcome> {
  const { prescriptionId } = input;

  const existing = await getPrescription(prescriptionId);
  if (!existing) {
    return {
      ok: false,
      prescriptionId,
      error: aiError('unknown', { detail: `prescription ${prescriptionId} not found` }),
    };
  }

  const pages = resolvePages(input);
  if (pages.length === 0) {
    const error = aiError('image_unreadable', { detail: 'no photographs were supplied' });
    await setExtractionFailed(prescriptionId, toStoredError(error));
    return { ok: false, prescriptionId, error };
  }

  // ── 1. Crop and encode every page, before anything is marked in progress ──
  const prepared: PreparedImage[] = [];
  let lastPrepError: AiError | null = null;
  let totalBytes = 0;

  for (const [index, uri] of pages.entries()) {
    // Published BEFORE the work, so "Getting photo 2 of 4 ready" is on screen while photo 2
    // is being cropped rather than after it is done. This is the only genuinely measurable
    // stretch of a scan — a known number of photographs, each taking about as long as the
    // last — which is why it is the one phase that drives a determinate bar.
    publishAiProgress(preparingProgress(index + 1, pages.length));

    const crop = input.crops?.[index] ?? input.crop ?? defaultMedicineBlockRect();
    const result = await prepareForExtraction(uri, crop);
    if (!result.ok) {
      lastPrepError = result.error;
      if (isRecording()) {
        // The rectangle as ASKED FOR — there are no pixels to report, because none were
        // produced. `crop_required` reaching here from a screen that believed it passed a
        // rectangle is otherwise a code with nothing behind it.
        record('warn', 'image', DEV_EVENTS.prepPage, () => ({
          page: index + 1,
          pages: pages.length,
          ok: false,
          errorCode: result.error.code,
          ...cropFields(crop),
        }));
      }
      continue;
    }
    if (totalBytes + result.image.approxBytes > MAX_TOTAL_INLINE_BYTES) {
      // Worth a note of its own: a scan that silently sends three of four pages produces a
      // medicine list missing whatever was on page four, and nothing else in the app ever
      // says why. Sizes only — the pixels are not mentioned and never leave the crop.
      if (isRecording()) {
        record('warn', 'image', DEV_EVENTS.prepPage, () => ({
          page: index + 1,
          pages: pages.length,
          ok: false,
          errorCode: 'budget_exceeded',
          approxBytes: result.image.approxBytes,
          totalBytes,
          budgetBytes: MAX_TOTAL_INLINE_BYTES,
          ...prepFields(result.image),
        }));
      }
      break;
    }
    totalBytes += result.image.approxBytes;
    prepared.push(result.image);
    if (isRecording()) {
      // ── THE LINE THAT SEPARATES A BAD CROP FROM A BLANK PAGE ──────────────
      //
      // Until `prepFields()` was spread in here, a page that read nothing and a page whose
      // first three medicines were above the crop produced the SAME note — page, pages, ok,
      // bytes, mime — and then the same `medicines=0`. They take opposite actions: retake
      // the photograph, or drag the rectangle. Retaking it fixes the first and fails
      // identically on the second, for as many evenings as anybody is willing to spend.
      //
      // The geometry is what tells them apart, and every field of it is a dimension or a
      // fraction of a page: it describes the photograph and never its content. The names
      // are chosen in imagePrep.ts, beside the values, because redact.ts believes a name.
      record('debug', 'image', DEV_EVENTS.prepPage, () => ({
        page: index + 1,
        pages: pages.length,
        ok: true,
        approxBytes: result.image.approxBytes,
        mimeType: result.image.mimeType,
        ...prepFields(result.image),
      }));
    }
  }

  if (prepared.length === 0) {
    const error = lastPrepError ?? aiError('image_unreadable');
    await setExtractionFailed(prescriptionId, toStoredError(error));
    return { ok: false, prescriptionId, error };
  }

  // ── 1a. She may have left while the pages were being cropped ──────────────
  //
  // Cropping, resizing and base64-encoding up to four 12 MP photographs is local work, but
  // it is not instant on a cheap phone, and it is the one stretch of this function that
  // runs BEFORE the row is moved to 'extracting'. Leaving here is therefore free: no
  // request is sent, no status is touched, and the row is left exactly as she found it.
  //
  // Without this check the sequence would still be safe — `generateWithRetry` re-checks the
  // signal before its first attempt and `gemini.ts` refuses an already-aborted request — but
  // the row would have been flipped to 'extracting' and then had to be flipped back for a
  // call that never happened.
  if (input.signal?.aborted) {
    return {
      ok: false,
      prescriptionId,
      error: aiError('cancelled', { detail: 'stopped before the request was sent' }),
    };
  }

  // The cropped file is persisted on the row before the call. If the app dies mid-request
  // we still know exactly which pixels were sent — the only way to audit what left the
  // device. The column holds one URI; the rest are recorded in the provenance block.
  const firstCropped = prepared[0]?.uri;
  if (firstCropped) await updatePrescription(prescriptionId, { croppedImageUri: firstCropped });
  await setExtracting(prescriptionId);

  // ── 2. The call ───────────────────────────────────────────────────────────
  const seed = input.seed ?? randomSeed();
  const provider = await getProvider(input.modelId ? { modelId: input.modelId } : {});
  const result = await provider.generate({
    prompt: buildPrescriptionPrompt({ todayLocalDate: input.todayLocalDate ?? toLocalDate() }),
    images: prepared.map((image) => ({ mimeType: image.mimeType, base64: image.base64 })),
    responseSchema: PRESCRIPTION_RESPONSE_SCHEMA,
    seed,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onAttempt ? { onAttempt: input.onAttempt } : {}),
  });

  if (!result.ok) {
    // ── A CANCEL IS NOT A FAILURE, AND MUST NOT BE STORED AS ONE ────────────
    //
    // `setExtractionFailed` writes `status = 'failed'` and an `extraction_error` that the
    // detail screen renders as "Could not read this prescription." Putting that sentence in
    // front of someone who pressed Stop — or who simply walked back to Today — accuses the
    // app of breaking when it did exactly what she asked. Worse, it is STICKY: a toast is
    // gone in four seconds, but a row marked failed still says so tomorrow morning.
    //
    // So the row goes back to the status it held before `setExtracting()` moved it, error
    // and all. A prescription that was already 'extracted' keeps its earlier reading and its
    // "Check the medicines" button; a fresh draft is a draft again. Nothing about this path
    // touches `image_uri` or `cropped_image_uri` — the photographs were saved before the
    // network was touched and a cancel never puts them at risk.
    if (result.error.code === 'cancelled') {
      await restoreExtractionStatus(prescriptionId, previousExtractionState(existing));
      return { ok: false, prescriptionId, error: result.error };
    }
    await setExtractionFailed(prescriptionId, toStoredError(result.error));
    return { ok: false, prescriptionId, error: result.error };
  }

  // ── 3. Parse ──────────────────────────────────────────────────────────────
  //
  // "Saving what came back" starts here rather than at the transaction below: from the
  // user's point of view validating the answer and writing it are one step, and both are
  // fast. Splitting them would put a fifth sentence on screen for a few milliseconds.
  publishAiProgress(savingProgress());

  const parsed = parsePrescriptionExtraction(result.json);
  if (!parsed.ok) {
    await setExtractionFailed(prescriptionId, toStoredError(parsed.error));
    return { ok: false, prescriptionId, error: parsed.error };
  }
  if (isRecording()) {
    record('info', 'ai', DEV_EVENTS.aiParse, () => ({
      // `itemsRead`, NOT `medicinesRead`, and the ugly name is the correct one.
      //
      // `redactFields` refuses any field whose NAME matches /medicine|drug|patient|…/,
      // whatever it holds, because the rule it enforces is "a name that promises a
      // measurement is refused even when it is a number" — `glucose: 18` being the case
      // that rule exists for. A count is indistinguishable from a measurement once it is
      // a number in a JSON object, so `medicinesRead: 7` came out as `[blocked]` and this
      // line silently logged nothing at all.
      //
      // Renaming is the fix rather than exempting numbers from the clinical gate: the
      // exemption would publish every reading in the database to buy back one count. See
      // the header of features/devlog/redact.ts. Read alongside `arrayCounts` from
      // gemini.ts ("medicines=7", the model's raw answer), this is what SURVIVED parsing,
      // and the two disagreeing is what `countMismatch` below is about.
      itemsRead: parsed.value.medicines.length,
      warningCodes: parsed.warnings.map((warning) => warning.code).join(', '),
      countMismatch: parsed.value.countMismatch,
      attempts: result.attempts ?? 1,
      elapsedMs: result.elapsedMs,
    }));
  }

  const provenance: ExtractionProvenance = {
    envelopeVersion: EXTRACTION_ENVELOPE_VERSION,
    promptVersion: PROMPT_VERSION,
    modelId: result.modelId,
    seed,
    receivedAtEpoch: Date.now(),
    usage: result.usage,
    pagesSent: prepared.length,
    croppedImageUris: prepared.map((image) => image.uri),
    warnings: parsed.warnings,
  };

  // ── 4. Persist, in one transaction ────────────────────────────────────────
  await inTransaction(async (tx) => {
    await setExtracted(prescriptionId, buildStoredExtraction(parsed.value, result.json, provenance), tx);
    await updatePrescription(prescriptionId, headerPatch(existing, parsed.value), tx);
  });

  return {
    ok: true,
    prescriptionId,
    extraction: parsed.value,
    warnings: parsed.warnings,
    provenance,
  };
}

/**
 * The screen-facing entry point: resolves on success, throws a
 * `PrescriptionExtractionError` carrying the user-facing sentence on failure.
 *
 * Two entry points with two error styles is deliberate. `runExtraction()` is the core and
 * returns a union, because programmatic callers need to branch on the code. This wrapper
 * exists because a React screen's `catch` block is the natural place for "show her a
 * sentence and offer the manual path", and forcing that screen to unpack a union to find
 * the sentence guarantees the generic message wins.
 *
 * ─── A CANCEL ARRIVES HERE AS A THROW, AND IT IS NOT A FAILURE ───────────────
 *
 * `cancelled` is an ordinary outcome now, not a rare one: the reading is retried
 * automatically, the prescription screen owns an `AbortController`, and both the Stop button
 * and simply walking away land here. This wrapper cannot tell those apart from a genuine
 * failure — it throws for every non-ok outcome — so a screen whose `catch` renders
 * `error.message` in a banner will accuse the app of breaking every time she stops a
 * reading, and will keep accusing it after she has moved on.
 *
 * A screen that passes a `signal` should therefore use `runExtraction()` and return early on
 * `outcome.error.code === 'cancelled'`, which is what `prescription/[id].tsx` does. Use this
 * wrapper only where nothing can be cancelled. The row itself is already safe either way:
 * `runExtraction` restores the status it had rather than marking it failed.
 */
export async function extractPrescription(input: ExtractInput): Promise<{
  prescriptionId: string;
  extraction: ParsedPrescription;
  warnings: readonly ParseWarning[];
  provenance: ExtractionProvenance;
}> {
  const outcome = await runExtraction(input);
  if (!outcome.ok) throw new PrescriptionExtractionError(outcome.error);
  return {
    prescriptionId: outcome.prescriptionId,
    extraction: outcome.extraction,
    warnings: outcome.warnings,
    provenance: outcome.provenance,
  };
}

// ── What gets stored ─────────────────────────────────────────────────────────

/** Where the model's untouched JSON lives inside `extraction_json`. */
export const RAW_RESPONSE_KEY = '_raw';
/** Where the provenance block lives inside `extraction_json`. */
export const PROVENANCE_KEY = '_extraction';

/**
 * The stored blob: a normalised projection at the top level, the verbatim response
 * underneath it, and provenance beside both.
 *
 * WHY A PROJECTION AT ALL. The review screen is a separate module with a deliberately
 * tolerant reader that looks for `medicines[]` with keys like `nameAsWritten` and
 * `strength`. The wire schema is snake_case and nests `dose_quantity` and `frequency`,
 * because that is the shape the model transcribes most reliably. Storing only the wire
 * shape would leave the reviewer with an empty list and the user with "no medicines were
 * read from this photo" on a photograph that read perfectly.
 *
 * WHY THE RAW RESPONSE IS KEPT ANYWAY. `_raw` is the model's own JSON, field for field,
 * including anything this build does not understand. A better parser shipped next year
 * can re-derive medicines from it without asking her to photograph the paper again.
 */
export function buildStoredExtraction(
  parsed: ParsedPrescription,
  raw: unknown,
  provenance: ExtractionProvenance,
): Record<string, unknown> {
  return {
    medicines: parsed.medicines.map(toReviewMedicine),
    prescriber: parsed.prescriber,
    clinic: parsed.clinic,
    prescribedOn: parsed.prescribedOn,
    prescribedOnVerbatim: parsed.prescribedOnVerbatim,
    followUp: parsed.followUp,
    testsAdvised: parsed.testsAdvised,
    nonMedicineInstructions: parsed.nonMedicineInstructions,
    pageNotes: parsed.pageNotes,
    totalMedicinesCounted: parsed.totalMedicinesCounted,
    countMismatch: parsed.countMismatch,
    [RAW_RESPONSE_KEY]: raw,
    [PROVENANCE_KEY]: provenance,
  };
}

/**
 * One medicine, in the vocabulary the rest of the app uses.
 *
 * NOTE WHAT IS NOT HERE: clock times. The paper says "1-0-1", never "08:00", so no times
 * are projected and the review screen uses the slot times the user set up herself. A
 * suggested time here would silently override hers.
 */
function toReviewMedicine(medicine: ParsedMedicine): Record<string, unknown> {
  const decoded = decodeFrequency(frequencyExpression(medicine));
  const quantityText =
    medicine.doseQuantity.verbatim ??
    (medicine.doseQuantity.value !== null
      ? `${medicine.doseQuantity.value}${medicine.doseQuantity.unit ? ` ${medicine.doseQuantity.unit}` : ''}`
      : null);

  return {
    nameAsWritten: medicine.nameAsWritten,
    genericGuess: medicine.genericGuess,
    strength: medicine.strength,
    form: medicine.form === 'unknown' ? null : medicine.form,
    quantityText,
    quantityValue: medicine.doseQuantity.value,
    quantityUnit: medicine.doseQuantity.unit,
    dosesPerDay: decoded.dosesPerDay ?? medicine.frequency.dosesPerDay,
    patternCode: decoded.recognised ? decoded.normalisedCode : null,
    slotNotation: decoded.slotNotation,
    intervalDays: decoded.intervalDays,
    scheduleType: decoded.scheduleType,
    frequencyVerbatim: medicine.frequency.verbatim,
    frequencyRecognised: decoded.recognised,
    foodRelation: medicine.foodRelation === 'unknown' ? null : medicine.foodRelation,
    // The mark the line above came from. Projected beside it so the mirror stays complete;
    // `propose.ts` reads the parsed shape, not this, and refuses a relation with no words.
    foodRelationVerbatim: medicine.foodRelationVerbatim,
    route: medicine.route === 'unknown' ? null : medicine.route,
    duration: medicine.duration,
    proposedCriticality: medicine.proposedCriticality,
    criticalityReason: medicine.criticalityReason,
    confidence: {
      // 'unknown' is projected as 'low'. A field the model could not rate is a field a
      // person should look at, and the review screen flags on 'low'.
      name: confidenceOut(medicine.confidence.name),
      strength: confidenceOut(medicine.confidence.strength),
      quantity: confidenceOut(medicine.confidence.frequency),
    },
    lowConfidenceFields: lowConfidenceFields(medicine, decoded.recognised),
    needsHumanCheck: medicine.needsHumanCheck || !decoded.recognised || decoded.needsHumanCheck,
    notes: medicine.notes,
  };
}

function confidenceOut(level: ParsedMedicine['confidence']['name']): string {
  return level === 'unknown' ? 'low' : level;
}

/**
 * Which fields the reviewer should be nudged to check.
 *
 * Errs upward on purpose: flagging too much costs her reading time, flagging too little
 * costs a wrong medicine. An unreadable frequency flags the quantity box, because that is
 * where the dose she types will land.
 */
function lowConfidenceFields(medicine: ParsedMedicine, frequencyRecognised: boolean): string[] {
  const flagged = new Set<string>();
  const weak = (level: string) => level === 'low' || level === 'unknown';

  if (weak(medicine.confidence.name) || !medicine.nameAsWritten) flagged.add('name');
  if (weak(medicine.confidence.strength)) flagged.add('strength');
  if (weak(medicine.confidence.frequency) || !frequencyRecognised) flagged.add('quantity');
  if (medicine.needsHumanCheck) {
    flagged.add('name');
    flagged.add('strength');
    flagged.add('quantity');
  }
  return [...flagged];
}

/**
 * Header fields, filled in ONLY where the row is still empty.
 *
 * A value the user typed always wins over a value the model read: she has the paper in
 * her hand and the model has a JPEG. This also makes "read it again" safe to press
 * repeatedly — a second reading cannot overwrite a correction made after the first.
 *
 * `prescriber` and `clinic` will usually be null here, and that is the crop working as
 * designed: the letterhead never leaves the phone, so the model never sees the names. The
 * prescription screen asks for them locally.
 */
function headerPatch(
  existing: {
    prescriber: string | null;
    clinic: string | null;
    prescribedOn: string | null;
    followUpRaw: string | null;
    followUpOn: string | null;
  },
  parsed: ParsedPrescription,
): {
  prescriber?: string | null;
  clinic?: string | null;
  prescribedOn?: string | null;
  followUp?: { raw: string | null; on: string | null };
} {
  const patch: {
    prescriber?: string | null;
    clinic?: string | null;
    prescribedOn?: string | null;
    followUp?: { raw: string | null; on: string | null };
  } = {};

  if (!existing.prescriber && parsed.prescriber) patch.prescriber = parsed.prescriber;
  if (!existing.clinic && parsed.clinic) patch.clinic = parsed.clinic;
  if (!existing.prescribedOn && parsed.prescribedOn) patch.prescribedOn = parsed.prescribedOn;

  // The RAW follow-up text is evidence and is stored now. The DATE is deliberately left
  // alone: resolving "review after 1 month" into a day is `care/calendar.ts`'s job, it
  // has to survive `care/guards.ts`, and it has to be confirmed by a human before it can
  // sit on a calendar. Writing follow_up_on here would smuggle a date past all three.
  if (!existing.followUpRaw && parsed.followUp.present && parsed.followUp.verbatim) {
    patch.followUp = { raw: parsed.followUp.verbatim, on: existing.followUpOn };
  }
  return patch;
}

// ── Reading it back ──────────────────────────────────────────────────────────

export type StoredExtraction = {
  readonly provenance: ExtractionProvenance | null;
  /** The model's verbatim JSON if it is there, otherwise whatever was stored. */
  readonly raw: unknown;
};

/**
 * Reads back what `setExtracted` stored, tolerating shapes this build did not write —
 * a row from an earlier build, or one a future build wraps differently. A prescription
 * must never become unopenable because its blob has an unexpected key.
 */
export function readStoredExtraction(stored: unknown): StoredExtraction {
  if (stored === null || typeof stored !== 'object') return { provenance: null, raw: stored };
  const record = stored as Record<string, unknown>;

  const provenance = record[PROVENANCE_KEY];
  return {
    provenance:
      provenance && typeof provenance === 'object'
        ? (provenance as ExtractionProvenance)
        : null,
    raw: RAW_RESPONSE_KEY in record ? record[RAW_RESPONSE_KEY] : stored,
  };
}

/**
 * Re-derives the parsed view from a stored row, so the review and calendar screens do not
 * need the network to reopen a prescription that was read yesterday.
 */
export function parseStoredPrescription(stored: unknown) {
  return parsePrescriptionExtraction(readStoredExtraction(stored).raw);
}

/**
 * Where the row was before `setExtracting()` moved it, so a cancel can put it back.
 *
 * The `'extracting'` fallback is for a row this function did not leave tidy: the app being
 * killed mid-call leaves `status = 'extracting'` with nothing running, and restoring THAT
 * would hand the screen a prescription that claims forever to be being read. 'draft' is the
 * honest reading of "photographed, nothing extracted yet", which is exactly what such a row
 * is.
 */
function previousExtractionState(existing: Prescription): {
  status: Exclude<Prescription['status'], 'extracting'>;
  extractionError: string | null;
} {
  return {
    status: existing.status === 'extracting' ? 'draft' : existing.status,
    extractionError: existing.extractionError,
  };
}

/**
 * One page or several, capped.
 *
 * Both spellings are accepted because both are natural at the call site: a screen showing
 * one photograph passes `imageUri`, and a multi-page prescription passes `imageUris`.
 * Refusing one of them would only produce a type error at the moment somebody is trying
 * to do the obvious thing.
 */
function resolvePages(input: ExtractInput): string[] {
  const pages = input.imageUris ?? (input.imageUri ? [input.imageUri] : []);
  return pages.filter((uri) => typeof uri === 'string' && uri.length > 0).slice(0, MAX_PAGES);
}

/**
 * A per-attempt seed, recorded with the result.
 *
 * Not derived from the prescription id on purpose. A stable seed would make "read it
 * again" return the identical wrong answer, which is the one thing a retry must not do.
 * Recording the seed still makes any single reading reproducible for a support case.
 */
function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}
