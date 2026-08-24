/**
 * Medicines — APPEND-ONLY VERSIONS on a shared `thread_id`.
 *
 * `thread_id` is the stable identity of "this drug". A dose change appends version
 * N+1 on the same thread; it never edits version N. Two things depend on that:
 *
 *   • "What was she taking in March?" — the only question an OPD report exists to
 *     answer — is answerable only if March's row still says what it said in March.
 *   • Adherence hangs off the thread, so a dose change must not look like
 *     stop-one-drug-start-another. Modelling it that way silently resets a TB
 *     patient's six-month streak on the day her dose is adjusted.
 *
 * A database trigger (`trg_medicine_no_update`) aborts any UPDATE of
 * name_as_written / strength / form / thread_id / version, so the rule is enforced
 * below the application, not merely agreed to by it. Lifecycle columns (status,
 * stopped_on, confirmed_by_user_at, superseded_by) may still be patched in place.
 *
 * THE AI SAFETY GATE: `confirmed_by_user_at` NULL means no human has seen this row,
 * and `trg_occ_requires_confirmed_medicine` makes such a row structurally incapable
 * of producing a dose occurrence. `createNewVersion` therefore forces every caller
 * to state, explicitly, whether a human authored the change.
 */

import type { Criticality, Medicine, MedicineStatus } from '../../types';
import { toLocalDate } from '../../lib/datetime';
import { newId } from '../../lib/ids';
import {
  type Tx,
  createRecord,
  inTransaction,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
} from './_shared';

export type NewMedicine = {
  profileId: string;
  nameAsWritten: string;
  genericGuess?: string | null;
  strength?: string | null;
  form?: Medicine['form'];
  criticality?: Criticality;
  criticalityProposed?: Criticality | null;
  criticalityReason?: string | null;
  startedOn?: string | null;
  source?: 'manual' | 'ai';
  prescriptionId?: string | null;
  stripPhotoUri?: string | null;
  /**
   * True only when a human typed or approved this. An AI extraction passes false,
   * and the row then cannot be scheduled until `confirmMedicine` is called.
   */
  confirmedByUser: boolean;
};

/** The clinical columns a new version may change. Lifecycle columns are patched instead. */
export type MedicineVersionPatch = {
  nameAsWritten?: string;
  genericGuess?: string | null;
  strength?: string | null;
  form?: Medicine['form'];
  criticality?: Criticality;
  criticalityProposed?: Criticality | null;
  criticalityReason?: string | null;
  startedOn?: string | null;
};

type MedicineRow = {
  id: string;
  thread_id: string;
  version: number;
  profile_id: string;
  name_as_written: string;
  generic_guess: string | null;
  strength: string | null;
  form: string | null;
  criticality: Criticality;
  criticality_proposed: Criticality | null;
  criticality_reason: string | null;
  status: MedicineStatus;
  stop_reason: string | null;
  started_on: string | null;
  stopped_on: string | null;
  source: 'manual' | 'ai';
  prescription_id: string | null;
  strip_photo_uri: string | null;
  confirmed_by_user_at: number | null;
  superseded_by: string | null;
};

function mapMedicine(row: MedicineRow): Medicine {
  return {
    id: row.id,
    threadId: row.thread_id,
    version: row.version,
    profileId: row.profile_id,
    nameAsWritten: row.name_as_written,
    genericGuess: row.generic_guess,
    strength: row.strength,
    form: row.form,
    criticality: row.criticality,
    criticalityProposed: row.criticality_proposed,
    criticalityReason: row.criticality_reason,
    status: row.status,
    stopReason: row.stop_reason,
    startedOn: row.started_on,
    stoppedOn: row.stopped_on,
    source: row.source,
    prescriptionId: row.prescription_id,
    stripPhotoUri: row.strip_photo_uri,
    confirmedByUserAt: row.confirmed_by_user_at,
  };
}

const SELECT_MEDICINE = `
  SELECT id, thread_id, version, profile_id, name_as_written, generic_guess, strength, form,
         criticality, criticality_proposed, criticality_reason, status, stop_reason,
         started_on, stopped_on, source, prescription_id, strip_photo_uri,
         confirmed_by_user_at, superseded_by
    FROM medicine`;

/**
 * The newest surviving version of each thread.
 *
 * MAX(version) rather than `status <> 'superseded'`, because status is a lifecycle
 * column that a partial write could leave stale, whereas the version number is
 * assigned once at insert and is guarded by a UNIQUE constraint.
 */
const CURRENT_VERSION_PREDICATE = `
  m.deleted_at_epoch IS NULL
  AND m.version = (SELECT MAX(v.version) FROM medicine v
                    WHERE v.thread_id = m.thread_id AND v.deleted_at_epoch IS NULL)`;

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getMedicine(id: string, tx?: Tx): Promise<Medicine | null> {
  const row = await queryFirst<MedicineRow>(
    `${SELECT_MEDICINE} WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapMedicine(row) : null;
}

export async function getCurrentVersion(threadId: string, tx?: Tx): Promise<Medicine | null> {
  const row = await queryFirst<MedicineRow>(
    `${SELECT_MEDICINE} m WHERE m.thread_id = ? AND ${CURRENT_VERSION_PREDICATE};`,
    [threadId],
    tx,
  );
  return row ? mapMedicine(row) : null;
}

/** Full history for one drug, oldest first. This is the OPD report's raw material. */
export async function listVersions(threadId: string, tx?: Tx): Promise<Medicine[]> {
  const rows = await queryAll<MedicineRow>(
    `${SELECT_MEDICINE} WHERE thread_id = ? AND deleted_at_epoch IS NULL ORDER BY version ASC;`,
    [threadId],
    tx,
  );
  return rows.map(mapMedicine);
}

export async function listCurrentMedicines(profileId: string, tx?: Tx): Promise<Medicine[]> {
  const rows = await queryAll<MedicineRow>(
    `${SELECT_MEDICINE} m WHERE m.profile_id = ? AND ${CURRENT_VERSION_PREDICATE}
       ORDER BY m.name_as_written COLLATE NOCASE;`,
    [profileId],
    tx,
  );
  return rows.map(mapMedicine);
}

/**
 * What reconcile schedules from: current version, status active, human-confirmed.
 *
 * The `confirmed_by_user_at IS NOT NULL` filter duplicates a database trigger on
 * purpose. The trigger is the guarantee; this filter is so an unconfirmed medicine
 * produces a quiet no-op in reconcile instead of aborting the whole transaction
 * and taking every other medicine's occurrences down with it.
 */
export async function listActiveMedicines(profileId: string, tx?: Tx): Promise<Medicine[]> {
  const rows = await queryAll<MedicineRow>(
    `${SELECT_MEDICINE} m
      WHERE m.profile_id = ? AND m.status = 'active' AND m.confirmed_by_user_at IS NOT NULL
        AND ${CURRENT_VERSION_PREDICATE}
      ORDER BY m.name_as_written COLLATE NOCASE;`,
    [profileId],
    tx,
  );
  return rows.map(mapMedicine);
}

/** The review queue: AI-extracted medicines no human has approved yet. */
export async function listUnconfirmedMedicines(profileId: string, tx?: Tx): Promise<Medicine[]> {
  const rows = await queryAll<MedicineRow>(
    `${SELECT_MEDICINE} m
      WHERE m.profile_id = ? AND m.confirmed_by_user_at IS NULL AND ${CURRENT_VERSION_PREDICATE}
      ORDER BY m.created_at_epoch ASC;`,
    [profileId],
    tx,
  );
  return rows.map(mapMedicine);
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createMedicine(
  input: NewMedicine,
  tx?: Tx,
): Promise<{ id: string; threadId: string }> {
  return inTransaction(async (t) => {
    const threadId = newId();
    const id = await createRecord(
      'medicine',
      {
        thread_id: threadId,
        version: 1,
        profile_id: input.profileId,
        name_as_written: input.nameAsWritten,
        generic_guess: input.genericGuess ?? null,
        strength: input.strength ?? null,
        form: input.form ?? null,
        criticality: input.criticality ?? 'standard',
        criticality_proposed: input.criticalityProposed ?? null,
        criticality_reason: input.criticalityReason ?? null,
        status: 'active',
        started_on: input.startedOn ?? toLocalDate(),
        source: input.source ?? 'manual',
        prescription_id: input.prescriptionId ?? null,
        strip_photo_uri: input.stripPhotoUri ?? null,
        confirmed_by_user_at: input.confirmedByUser ? nowEpoch() : null,
      },
      t,
    );

    if (input.confirmedByUser) {
      await insertMedChangeEvent(
        { profileId: input.profileId, threadId, kind: 'started', detail: input.nameAsWritten },
        t,
      );
    }
    return { id, threadId };
  }, tx);
}

/**
 * Appends version N+1 and marks version N superseded — one transaction, both halves.
 *
 * `confirmedByUser` is REQUIRED rather than defaulted, and that is the point. An
 * AI re-reading a prescription and "correcting" a strength must produce a row the
 * database refuses to schedule until a human looks at it. A default of true would
 * make forgetting the argument the dangerous case; there is no default, so the
 * caller has to decide.
 */
export async function createNewVersion(
  threadId: string,
  patch: MedicineVersionPatch,
  options: { confirmedByUser: boolean; changeKind?: 'dose_changed' | 'resumed'; detail?: string },
  tx?: Tx,
): Promise<string> {
  return inTransaction(async (t) => {
    const previous = await getCurrentVersion(threadId, t);
    if (!previous) throw new Error(`No medicine thread ${threadId}`);

    const nextId = await createRecord(
      'medicine',
      {
        thread_id: threadId,
        version: previous.version + 1,
        profile_id: previous.profileId,
        name_as_written: patch.nameAsWritten ?? previous.nameAsWritten,
        generic_guess: patch.genericGuess !== undefined ? patch.genericGuess : previous.genericGuess,
        strength: patch.strength !== undefined ? patch.strength : previous.strength,
        form: patch.form !== undefined ? patch.form : previous.form,
        criticality: patch.criticality ?? previous.criticality,
        criticality_proposed:
          patch.criticalityProposed !== undefined
            ? patch.criticalityProposed
            : previous.criticalityProposed,
        criticality_reason:
          patch.criticalityReason !== undefined
            ? patch.criticalityReason
            : previous.criticalityReason,
        // A new version is always active: superseding a stopped medicine is a
        // resume, and resuming is what this call means.
        status: 'active',
        stop_reason: null,
        started_on: patch.startedOn !== undefined ? patch.startedOn : previous.startedOn,
        stopped_on: null,
        source: previous.source,
        prescription_id: previous.prescriptionId,
        strip_photo_uri: previous.stripPhotoUri,
        confirmed_by_user_at: options.confirmedByUser ? nowEpoch() : null,
      },
      t,
    );

    // Lifecycle columns only — the trigger permits these and refuses the clinical ones.
    await updateRecord('medicine', previous.id, { status: 'superseded', superseded_by: nextId }, t);

    await insertMedChangeEvent(
      {
        profileId: previous.profileId,
        threadId,
        kind: options.changeKind ?? 'dose_changed',
        detail: options.detail ?? null,
      },
      t,
    );
    return nextId;
  }, tx);
}

/** A human has looked at this row and agreed with it. Until then it cannot be scheduled. */
export async function confirmMedicine(id: string, tx?: Tx): Promise<void> {
  await updateRecord('medicine', id, { confirmed_by_user_at: nowEpoch() }, tx);
}

export async function stopMedicine(
  threadId: string,
  options: { reason?: string | null; stoppedOn?: string } = {},
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    const current = await getCurrentVersion(threadId, t);
    if (!current) throw new Error(`No medicine thread ${threadId}`);
    const stoppedOn = options.stoppedOn ?? toLocalDate();
    await updateRecord(
      'medicine',
      current.id,
      { status: 'stopped', stop_reason: options.reason ?? null, stopped_on: stoppedOn },
      t,
    );
    await insertMedChangeEvent(
      {
        profileId: current.profileId,
        threadId,
        kind: 'stopped',
        localDate: stoppedOn,
        detail: options.reason ?? null,
      },
      t,
    );
  }, tx);
}

export async function updateCriticality(
  id: string,
  criticality: Criticality,
  reason: string | null,
  tx?: Tx,
): Promise<void> {
  // Criticality decides the notification channel, not the clinical content, so it
  // is a lifecycle patch rather than a new version. Changing it does not change
  // what she was taking in March.
  await updateRecord(
    'medicine',
    id,
    { criticality, criticality_reason: reason, criticality_proposed: null },
    tx,
  );
}

export async function deleteMedicineThread(threadId: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const rows = await queryAll<{ id: string }>(
      `SELECT id FROM medicine WHERE thread_id = ? AND deleted_at_epoch IS NULL;`,
      [threadId],
      t,
    );
    // Every version goes, or the MAX(version) reads would resurrect an older one
    // as "current" and the drug would reappear with an out-of-date dose.
    for (const row of rows) await softDeleteRecord('medicine', row.id, t);
  }, tx);
}

// ── Change markers ───────────────────────────────────────────────────────────

export type MedChangeKind =
  | 'started'
  | 'stopped'
  | 'dose_changed'
  | 'time_changed'
  | 'resumed'
  | 'prescription';

export type MedChangeEvent = {
  id: string;
  profileId: string;
  threadId: string | null;
  kind: MedChangeKind;
  localDate: string;
  atEpoch: number;
  detail: string | null;
  prescriptionId: string | null;
};

/**
 * Vertical markers on the charts.
 *
 * The schema comment is explicit that these are never annotated and never explained
 * — just visible on a shared date axis. Putting "BP fell because the dose changed"
 * next to one would be the app making a causal claim it has no standing to make.
 */
export async function insertMedChangeEvent(
  input: {
    profileId: string;
    threadId?: string | null;
    kind: MedChangeKind;
    localDate?: string;
    detail?: string | null;
    prescriptionId?: string | null;
  },
  tx?: Tx,
): Promise<string> {
  return createRecord(
    'med_change_event',
    {
      profile_id: input.profileId,
      thread_id: input.threadId ?? null,
      kind: input.kind,
      local_date: input.localDate ?? toLocalDate(),
      at_epoch: nowEpoch(),
      detail: input.detail ?? null,
      prescription_id: input.prescriptionId ?? null,
    },
    tx,
  );
}

export async function listMedChangeEvents(
  profileId: string,
  fromDate: string,
  toDate: string,
  tx?: Tx,
): Promise<MedChangeEvent[]> {
  const rows = await queryAll<{
    id: string;
    profile_id: string;
    thread_id: string | null;
    kind: MedChangeKind;
    local_date: string;
    at_epoch: number;
    detail: string | null;
    prescription_id: string | null;
  }>(
    `SELECT id, profile_id, thread_id, kind, local_date, at_epoch, detail, prescription_id
       FROM med_change_event
      WHERE profile_id = ? AND local_date >= ? AND local_date <= ?
      ORDER BY local_date ASC, at_epoch ASC;`,
    [profileId, fromDate, toDate],
    tx,
  );
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    threadId: r.thread_id,
    kind: r.kind,
    localDate: r.local_date,
    atEpoch: r.at_epoch,
    detail: r.detail,
    prescriptionId: r.prescription_id,
  }));
}

/**
 * Earliest treatment date on record — the anchor for the "since treatment start"
 * adherence window. Null when nothing has been started yet.
 */
export async function getTreatmentStartDate(profileId: string, tx?: Tx): Promise<string | null> {
  const row = await queryFirst<{ started_on: string | null }>(
    `SELECT MIN(started_on) AS started_on FROM medicine
      WHERE profile_id = ? AND deleted_at_epoch IS NULL AND started_on IS NOT NULL;`,
    [profileId],
    tx,
  );
  return row?.started_on ?? null;
}

/** Threads whose current version is stopped, with the date — used for phase badges. */
export async function listCompletedThreads(
  profileId: string,
  tx?: Tx,
): Promise<{ threadId: string; name: string; stoppedOn: string }[]> {
  const rows = await queryAll<{ thread_id: string; name_as_written: string; stopped_on: string }>(
    `${SELECT_MEDICINE} m
      WHERE m.profile_id = ? AND m.status = 'stopped' AND m.stopped_on IS NOT NULL
        AND ${CURRENT_VERSION_PREDICATE};`,
    [profileId],
    tx,
  );
  return rows.map((r) => ({
    threadId: r.thread_id,
    name: r.name_as_written,
    stoppedOn: r.stopped_on,
  }));
}

// ── THERE IS NO `countMedicineFormUsage`, AND THAT IS ON PURPOSE ─────────────
//
// There was one. It counted DISTINCT thread_id per `form` — the careful version, because
// `medicine` is append-only versioned and one drug whose dose changed six times is six
// rows — and it existed to order the form chips on `medicine/new.tsx` by what she picks
// most, under her "sort frequently selected options most-used first" report.
//
// It had no callers, and it should not get one. Those chips are eight short labels in a
// wrapping row with `tablet` preselected: the whole set is on screen at once and is never
// scrolled past, so reordering buys nothing, while the band it would arrive in — heading,
// divider, two groups — makes a grid that reads at a glance slower to read. The report was
// about SCROLLING, and the only list in this app long enough to scroll is the symptom
// chips. See the header of `src/features/frequency`.
//
// Left as a comment rather than deleted silently: a dead exported query reads to the next
// maintainer as "this is wired up", which is how the reasoning gets lost and the function
// gets re-added.
