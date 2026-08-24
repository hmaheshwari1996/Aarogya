/**
 * Prescriptions — `prescription`.
 *
 * A prescription row is the PAPER: the photo, who wrote it, when, and (once extraction
 * has run) the raw model output. It is the evidence the medicines were derived from.
 *
 * CONFIRMING THE PRESCRIPTION IS NOT CONFIRMING THE MEDICINES OR THE SCHEDULES.
 * `status = 'confirmed'` here means "yes, this is my prescription and the header details
 * are right". It says nothing about the drugs and frequencies extracted from it, and it
 * deliberately grants them nothing. Each `medicine` and each `dose_schedule` carries its
 * own `confirmed_by_user_at`, and `trg_occ_requires_confirmed_medicine` /
 * `trg_occ_requires_confirmed_schedule` make the database itself refuse to create a dose
 * occurrence while either is NULL. The two confirmations are separate because they fail
 * separately: a model can read "Tab. Metformin 500" perfectly and still turn "1-0-1" into
 * QID, which leaves the name flawless and doubles the dose. Nothing in this file may ever
 * write `confirmed_by_user_at` on a medicine or a schedule on the strength of the
 * prescription being confirmed.
 */

import {
  createRecord,
  fromJson,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  toJson,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Public shapes ────────────────────────────────────────────────────────────

export type PrescriptionStatus = 'draft' | 'extracting' | 'extracted' | 'confirmed' | 'failed';

/**
 * The follow-up instruction, kept as an inseparable pair.
 *
 * `raw` is what the paper says — "review after 1 month", "f/u 2 wks", "come back if fever
 * persists". `on` is OUR interpretation of it as a date. They are one parameter rather
 * than two optional fields so that no code path can record the interpretation while
 * dropping the evidence: once the raw text is gone, a wrong parse is unfalsifiable, and
 * "review after 1 month" written on 31 January is exactly the case where our arithmetic
 * needs to remain checkable against the source. `on` may be null when the text does not
 * resolve to a date at all — an unparsed instruction is still worth showing the user.
 */
export type FollowUp = {
  raw: string | null;
  on: string | null;
};

export type Prescription = {
  id: string;
  profileId: string;
  imageUri: string | null;
  croppedImageUri: string | null;
  prescriber: string | null;
  clinic: string | null;
  prescribedOn: string | null;
  /** Our parsed date. Always read alongside followUpRaw. */
  followUpOn: string | null;
  /** The literal text on the paper. The evidence for followUpOn. */
  followUpRaw: string | null;
  status: PrescriptionStatus;
  /** Raw extraction output, kept verbatim so a re-parse never needs the model again. */
  extraction: Record<string, unknown> | null;
  extractionError: string | null;
  /** Confirms THIS ROW only — never the medicines or schedules it produced. */
  confirmedAtEpoch: number | null;
};

export type CreatePrescriptionInput = {
  profileId: string;
  imageUri?: string | null;
  croppedImageUri?: string | null;
  prescriber?: string | null;
  clinic?: string | null;
  prescribedOn?: string | null;
  followUp?: FollowUp;
};

export type PrescriptionPatch = {
  imageUri?: string | null;
  croppedImageUri?: string | null;
  prescriber?: string | null;
  clinic?: string | null;
  prescribedOn?: string | null;
  followUp?: FollowUp;
};

// ── Row type & mapper ────────────────────────────────────────────────────────

type PrescriptionRow = {
  id: string;
  profile_id: string;
  image_uri: string | null;
  cropped_image_uri: string | null;
  prescriber: string | null;
  clinic: string | null;
  prescribed_on: string | null;
  follow_up_on: string | null;
  follow_up_raw: string | null;
  status: string;
  extraction_json: string | null;
  extraction_error: string | null;
  confirmed_at_epoch: number | null;
};

function mapPrescription(row: PrescriptionRow): Prescription {
  return {
    id: row.id,
    profileId: row.profile_id,
    imageUri: row.image_uri,
    croppedImageUri: row.cropped_image_uri,
    prescriber: row.prescriber,
    clinic: row.clinic,
    prescribedOn: row.prescribed_on,
    followUpOn: row.follow_up_on,
    followUpRaw: row.follow_up_raw,
    // The column's CHECK constraint is what makes this cast safe.
    status: row.status as PrescriptionStatus,
    extraction: fromJson<Record<string, unknown>>(row.extraction_json),
    extractionError: row.extraction_error,
    confirmedAtEpoch: row.confirmed_at_epoch,
  };
}

const COLUMNS = `id, profile_id, image_uri, cropped_image_uri, prescriber, clinic,
     prescribed_on, follow_up_on, follow_up_raw, status, extraction_json,
     extraction_error, confirmed_at_epoch`;

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listPrescriptions(profileId: string, tx?: Tx): Promise<Prescription[]> {
  // prescribed_on is nullable and SQLite sorts NULL last under DESC, so an undated
  // prescription sinks below the dated ones instead of leading the list.
  const rows = await queryAll<PrescriptionRow>(
    `SELECT ${COLUMNS}
       FROM prescription
      WHERE profile_id = ? AND deleted_at_epoch IS NULL
      ORDER BY prescribed_on DESC, created_at_epoch DESC;`,
    [profileId],
    tx,
  );
  return rows.map(mapPrescription);
}

export async function getPrescription(id: string, tx?: Tx): Promise<Prescription | null> {
  const row = await queryFirst<PrescriptionRow>(
    `SELECT ${COLUMNS} FROM prescription WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapPrescription(row) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Starts as 'draft': the photo exists, nothing has been read off it yet. */
export async function createPrescription(
  input: CreatePrescriptionInput,
  tx?: Tx,
): Promise<string> {
  return createRecord(
    'prescription',
    {
      profile_id: input.profileId,
      image_uri: input.imageUri ?? null,
      cropped_image_uri: input.croppedImageUri ?? null,
      prescriber: nonEmpty(input.prescriber),
      clinic: nonEmpty(input.clinic),
      prescribed_on: nonEmpty(input.prescribedOn),
      ...followUpValues(input.followUp),
      status: 'draft',
      extraction_json: null,
      extraction_error: null,
      confirmed_at_epoch: null,
    },
    tx,
  );
}

export async function setExtracting(id: string, tx?: Tx): Promise<void> {
  // The previous error is cleared on the way in, so a stale failure message can never sit
  // next to a fresh successful extraction.
  await updateRecord('prescription', id, { status: 'extracting', extraction_error: null }, tx);
}

/**
 * Store the model's output verbatim.
 *
 * Pass the PARSED object; it is serialised here. Keeping the whole response — not just
 * the fields the current build understands — means a later, better parser can re-derive
 * medicines from it without asking the user to photograph the paper again.
 *
 * This does not confirm anything. Extracted rows are proposals until a human confirms
 * each medicine and each schedule individually.
 */
export async function setExtracted(id: string, extraction: unknown, tx?: Tx): Promise<void> {
  await updateRecord(
    'prescription',
    id,
    { status: 'extracted', extraction_json: toJson(extraction), extraction_error: null },
    tx,
  );
}

export async function setExtractionFailed(id: string, error: string, tx?: Tx): Promise<void> {
  await updateRecord('prescription', id, { status: 'failed', extraction_error: error }, tx);
}

/**
 * Undo `setExtracting()` because the reading was ABANDONED, not because it went wrong.
 *
 * The user pressing Stop, or walking back to Today while a prescription is being read, is
 * the case this exists for. Before it existed the only way out of `'extracting'` was
 * `setExtractionFailed`, so a cancel left the row saying `failed` and the detail screen
 * saying "Could not read this prescription" — an accusation of a malfunction that never
 * happened, still on screen tomorrow.
 *
 * `previous` is the status and error the row carried BEFORE extraction started, read by the
 * caller in the same operation, so this restores rather than invents. Three properties are
 * deliberate:
 *
 *   • `'extracting'` is excluded from the type. Restoring to it would strand the row
 *     mid-flight with nothing in flight — the exact state this function exists to leave.
 *   • `'confirmed'` is allowed and does NOT stamp `confirmed_at_epoch`. The timestamp
 *     already on the row is the moment a human actually signed off the paper; rewriting it
 *     here would forge that moment. This is a restore, not a confirmation, which is why it
 *     does not go through `confirmPrescription()`.
 *   • The previous `extraction_error` is put back verbatim. Clearing it would silently
 *     erase the reason an earlier reading failed just because a later one was cancelled.
 *
 * It writes no `extraction_json`: a cancelled reading produced nothing, and whatever an
 * earlier reading stored is still sitting in the column untouched.
 */
export async function restoreExtractionStatus(
  id: string,
  previous: {
    status: Exclude<PrescriptionStatus, 'extracting'>;
    extractionError: string | null;
  },
  tx?: Tx,
): Promise<void> {
  await updateRecord(
    'prescription',
    id,
    { status: previous.status, extraction_error: previous.extractionError },
    tx,
  );
}

/**
 * The user has looked at this prescription and says it is theirs and the header is right.
 *
 * No state-machine guard here on purpose: a hand-entered prescription that never went
 * through extraction is a perfectly ordinary thing to confirm, and so is one whose
 * extraction failed and whose details the user then typed in.
 *
 * Again — this confirms the PAPER. The medicines and dose schedules it produced each need
 * their own confirmation before the database will let a single dose be scheduled.
 */
export async function confirmPrescription(id: string, tx?: Tx): Promise<void> {
  await updateRecord(
    'prescription',
    id,
    { status: 'confirmed', confirmed_at_epoch: nowEpoch() },
    tx,
  );
}

export async function updatePrescription(
  id: string,
  patch: PrescriptionPatch,
  tx?: Tx,
): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.imageUri !== undefined) values['image_uri'] = patch.imageUri ?? null;
  if (patch.croppedImageUri !== undefined) values['cropped_image_uri'] = patch.croppedImageUri ?? null;
  if (patch.prescriber !== undefined) values['prescriber'] = nonEmpty(patch.prescriber);
  if (patch.clinic !== undefined) values['clinic'] = nonEmpty(patch.clinic);
  if (patch.prescribedOn !== undefined) values['prescribed_on'] = nonEmpty(patch.prescribedOn);
  if (patch.followUp !== undefined) Object.assign(values, followUpValues(patch.followUp));

  // status is not patchable here — it moves only through the named transitions above, so
  // there is no path that marks a prescription confirmed without stamping the timestamp.
  await updateRecord('prescription', id, values, tx);
}

export async function deletePrescription(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('prescription', id, tx);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Both columns move together, always — the parsed date never travels without its source. */
function followUpValues(followUp: FollowUp | undefined): Record<string, Bind> {
  if (followUp === undefined) return {};
  return {
    follow_up_raw: nonEmpty(followUp.raw),
    follow_up_on: nonEmpty(followUp.on),
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
