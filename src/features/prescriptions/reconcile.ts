/**
 * Supersession: what a NEW prescription means for the medicines she is already on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR BUCKETS, AND WHY THEY ARE NOT THREE
 *
 *   Continued              — on both papers, unchanged. Nothing happens.
 *   Changed                — same drug, different dose or timing. A NEW VERSION ON THE
 *                            SAME THREAD. Never a stop plus a start.
 *   New                    — not on any current thread.
 *   Not on this prescription — she is taking it, this paper does not mention it.
 *
 * The fourth bucket is the whole reason this file exists, and its name is deliberately
 * not "stopped". A prescription that does not mention Metformin usually means "carry on
 * with your Metformin, I am writing you an antibiotic" — not "stop your Metformin". The
 * default is therefore KEEP, in every mode, for every medicine.
 *
 * WHY 'CHANGED' MUST STAY ON THE SAME THREAD
 *
 * Adherence, streaks and the OPD report all hang off `thread_id`. Modelling a dose change
 * as stop-one-and-start-another gives an identical-looking medicine list and silently
 * resets a TB patient's six-month adherence history on the day her dose was adjusted.
 * `medicine` and `dose_schedule` are append-only versioned precisely so this is
 * expressible; splitting the thread throws that away.
 *
 * THREE REFUSALS THAT ARE NOT NEGOTIABLE
 *
 *   • Replace-all must ENUMERATE what it stops, and the caller must hand that exact list
 *     back. "Replace everything" tapped without seeing the list is not consent.
 *   • A `critical` medicine can never be stopped by a bulk action. Per-medicine, with the
 *     name on screen, yes. In a sweep, never.
 *   • Nothing may result in zero medicines. That outcome is always a misunderstanding.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Criticality } from '../../types';
import { toLocalDate } from '../../lib/datetime';
import { inTransaction, type Tx } from '../../db/repositories/_shared';
import { listCurrentMedicines, stopMedicine } from '../../db/repositories/medicines';
import { getCurrentSchedulesForThreads, stopSchedules } from '../../db/repositories/schedules';
import { decodeFrequency, frequencyLabelEn, type DecodedFrequency } from './frequency';
import { frequencyExpression, type ParsedMedicine, type ParsedPrescription } from './schema';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** What she is on right now, flattened to just the fields a diff needs. */
export type CurrentMedicine = {
  readonly threadId: string;
  readonly medicineId: string;
  readonly name: string;
  readonly genericGuess: string | null;
  readonly strength: string | null;
  readonly criticality: Criticality;
  /** Fixed slots on the current version, in time order. */
  readonly timeLocals: readonly string[];
  readonly intervalDays: number;
  readonly isPrn: boolean;
};

export type IncomingMedicine = {
  /** Index into `ParsedPrescription.medicines`. */
  readonly index: number;
  readonly name: string;
  readonly genericGuess: string | null;
  readonly strength: string | null;
  readonly decoded: DecodedFrequency;
  readonly parsed: ParsedMedicine;
};

export type FieldChange = {
  readonly field: 'strength' | 'frequency' | 'interval' | 'food' | 'quantity';
  readonly from: string;
  readonly to: string;
};

export type ContinuedRow = {
  readonly threadId: string;
  readonly name: string;
  readonly incomingIndex: number;
  /** True when the two lines were matched on the generic name, not the written name. */
  readonly matchedOnGeneric: boolean;
};

export type ChangedRow = ContinuedRow & { readonly changes: readonly FieldChange[] };

export type AddedRow = {
  readonly incomingIndex: number;
  readonly name: string;
  /** Set when the name resembled more than one current medicine. Treated as new, flagged. */
  readonly ambiguousWith: readonly string[];
};

export type NotOnPrescriptionRow = {
  readonly threadId: string;
  readonly name: string;
  readonly criticality: Criticality;
};

export type PrescriptionDiff = {
  readonly continued: readonly ContinuedRow[];
  readonly changed: readonly ChangedRow[];
  readonly added: readonly AddedRow[];
  readonly notOnThisPrescription: readonly NotOnPrescriptionRow[];
};

export type SupersessionMode = 'keep_all' | 'pick_per_medicine' | 'replace_all';

export type ThreadDecision = 'keep' | 'stop';

export type SupersessionRefusal = {
  readonly code:
    | 'stop_list_not_acknowledged'
    | 'critical_cannot_be_bulk_stopped'
    | 'would_leave_no_medicines';
  readonly message: string;
  readonly threadIds: readonly string[];
};

export type SupersessionPlan = {
  readonly mode: SupersessionMode;
  readonly toStop: readonly NotOnPrescriptionRow[];
  readonly toKeep: readonly NotOnPrescriptionRow[];
  /** Threads that get a new version rather than a new thread. */
  readonly toVersion: readonly ChangedRow[];
  readonly toCreate: readonly AddedRow[];
  /** How many medicines she will be on afterwards. Never allowed to be zero. */
  readonly resultingMedicineCount: number;
};

export type PlanResult =
  | { ok: true; plan: SupersessionPlan }
  | { ok: false; refusal: SupersessionRefusal };

// ── Loading current state ────────────────────────────────────────────────────

export async function loadCurrentMedicines(profileId: string, tx?: Tx): Promise<CurrentMedicine[]> {
  const medicines = await listCurrentMedicines(profileId, tx);
  const active = medicines.filter((m) => m.status === 'active');
  const schedules = await getCurrentSchedulesForThreads(
    active.map((m) => m.threadId),
    tx,
  );

  return active.map((medicine) => {
    const slots = schedules.get(medicine.threadId) ?? [];
    const fixed = slots.filter((s) => s.scheduleType === 'FIXED' && s.timeLocal !== null);
    return {
      threadId: medicine.threadId,
      medicineId: medicine.id,
      name: medicine.nameAsWritten,
      genericGuess: medicine.genericGuess,
      strength: medicine.strength,
      criticality: medicine.criticality,
      timeLocals: fixed
        .map((s) => s.timeLocal ?? '')
        .filter((t) => t.length > 0)
        .sort(),
      intervalDays: fixed[0]?.intervalDays ?? 1,
      isPrn: fixed.length === 0 && slots.length > 0,
    };
  });
}

/** Extraction → the shape the diff compares against. */
export function toIncoming(extraction: ParsedPrescription): IncomingMedicine[] {
  const incoming: IncomingMedicine[] = [];
  for (const [index, medicine] of extraction.medicines.entries()) {
    const name = medicine.nameAsWritten;
    // A line with no readable name cannot be matched against anything, and guessing which
    // current medicine it "probably" is would be the same invention this pipeline refuses
    // everywhere else. It reaches the review screen as an unnamed line instead.
    if (!name) continue;
    incoming.push({
      index,
      name,
      genericGuess: medicine.genericGuess,
      strength: medicine.strength,
      decoded: decodeFrequency(frequencyExpression(medicine)),
      parsed: medicine,
    });
  }
  return incoming;
}

// ── The diff (pure) ──────────────────────────────────────────────────────────

export function buildSupersessionDiff(
  current: readonly CurrentMedicine[],
  incoming: readonly IncomingMedicine[],
): PrescriptionDiff {
  const continued: ContinuedRow[] = [];
  const changed: ChangedRow[] = [];
  const added: AddedRow[] = [];
  const matchedThreads = new Set<string>();

  for (const line of incoming) {
    const matches = findMatches(current, line);

    if (matches.length === 0) {
      added.push({ incomingIndex: line.index, name: line.name, ambiguousWith: [] });
      continue;
    }
    if (matches.length > 1) {
      // Two current medicines both look like this line. Picking one would attach a dose
      // change to the wrong drug, which is worse than treating it as new and letting a
      // person say which it is.
      added.push({
        incomingIndex: line.index,
        name: line.name,
        ambiguousWith: matches.map((m) => m.medicine.threadId),
      });
      continue;
    }

    const match = matches[0];
    if (!match) continue;
    matchedThreads.add(match.medicine.threadId);

    const changes = compareMedicine(match.medicine, line);
    const row: ContinuedRow = {
      threadId: match.medicine.threadId,
      name: line.name,
      incomingIndex: line.index,
      matchedOnGeneric: match.onGeneric,
    };
    if (changes.length === 0) continued.push(row);
    else changed.push({ ...row, changes });
  }

  const notOnThisPrescription: NotOnPrescriptionRow[] = current
    .filter((medicine) => !matchedThreads.has(medicine.threadId))
    .map((medicine) => ({
      threadId: medicine.threadId,
      name: medicine.name,
      criticality: medicine.criticality,
    }));

  return { continued, changed, added, notOnThisPrescription };
}

type Match = { medicine: CurrentMedicine; onGeneric: boolean };

function findMatches(current: readonly CurrentMedicine[], line: IncomingMedicine): Match[] {
  const name = normaliseDrugName(line.name);
  const byName = current.filter((m) => normaliseDrugName(m.name) === name && name.length > 0);
  if (byName.length > 0) return byName.map((medicine) => ({ medicine, onGeneric: false }));

  // Falling back to the generic name catches a brand switch (Glycomet → Metformin), which
  // is a very common reason the written name changes while the drug does not. It is
  // weaker evidence, so it is flagged and the review screen says so out loud.
  const generic = normaliseDrugName(line.genericGuess ?? '');
  if (generic.length === 0) return [];
  return current
    .filter((m) => normaliseDrugName(m.genericGuess ?? '') === generic)
    .map((medicine) => ({ medicine, onGeneric: true }));
}

/**
 * Strips the form prefix and punctuation, keeps the drug.
 *
 * "Tab. Metformin 500" and "T Metformin" are the same drug written by two people. The
 * STRENGTH is deliberately not stripped here — it is compared separately, because a
 * strength change is exactly the kind of change this diff exists to surface.
 */
export function normaliseDrugName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|inj|injection|susp|suspension|oint|ointment|drops?|sol|solution|inh|inhaler|t|c)\b\.?/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compareMedicine(currentMedicine: CurrentMedicine, line: IncomingMedicine): FieldChange[] {
  const changes: FieldChange[] = [];

  const currentStrength = normaliseValue(currentMedicine.strength);
  const incomingStrength = normaliseValue(line.strength);
  // Only when BOTH are known. A strength that this reading could not make out is not
  // evidence that the strength changed, and reporting it as one would invite a person to
  // confirm a dose change that never happened.
  if (currentStrength && incomingStrength && currentStrength !== incomingStrength) {
    changes.push({
      field: 'strength',
      from: currentMedicine.strength ?? '',
      to: line.strength ?? '',
    });
  }

  // "THE DECODER COULD NOT READ THE NEW FREQUENCY" IS NOT "THE FREQUENCY DID NOT CHANGE",
  // AND FILING IT AS THE SECOND IS THE WORST OUTCOME IN THIS FILE.
  //
  // Everything below is gated on `recognised`, which is right — an unread line is no
  // evidence of a change and must never print "3 a day → 2 a day" out of nothing. But
  // producing NO FieldChange sends the line to `continued`, and `continued` is a bucket
  // with no card, no tick and no way to disagree, sitting under a heading that reads
  // "Already being taken — nothing changes" and a note that says this prescription writes
  // it "the same as before". A doctor who doubled a dose in a notation this app cannot
  // parse would have that fact reported to her as reassurance, and no control on the
  // screen could reach it.
  //
  // So an unread frequency is stated as what it is. The line becomes `changed`, gets a
  // full card, and her own reading of the paper decides the number — which is precisely
  // the path a new medicine already takes when the app cannot read its frequency.
  // 'not read' is `frequencyLabelEn`'s own word for this, so the diff line and every other
  // surface say it identically.
  //
  // IT TURNS ON WORDS BEING THERE, NOT ON THE DECODER FAILING, and the two are different
  // prescriptions. `decodeFrequency` returns the identical unrecognised shape for "1-1"
  // and for nothing at all, because the decoder's job ends at "no honest daily rhythm".
  // But a follow-up slip reading "T. Metformin 500" with no frequency on it is not
  // asserting anything about how often — "carry on as before" is the ordinary meaning, and
  // "continued" is the true answer. A line that DOES carry words the decoder could not
  // read is asserting something, and what it asserts is unknown. Only the second is a
  // change. `decoded.input` is the expression exactly as it was fed in, so this asks the
  // structured field rather than re-deriving anything.
  //
  // Deliberately NOT extended to a line whose strength is unreadable: an unread strength
  // leaves the schedule alone, so the same-as-before claim stays true of the thing that
  // rings.
  if (!line.decoded.recognised && line.decoded.input.trim().length > 0) {
    changes.push({
      field: 'frequency',
      from: currentMedicine.isPrn
        ? 'only when needed'
        : `${currentMedicine.timeLocals.length} a day`,
      to: frequencyLabelEn(line.decoded),
    });
  }

  if (line.decoded.recognised) {
    const currentDoses = currentMedicine.timeLocals.length;
    const incomingDoses = line.decoded.dosesPerDay ?? 0;
    const currentIsPrn = currentMedicine.isPrn;
    const incomingIsPrn = line.decoded.kind === 'prn';

    if (currentIsPrn !== incomingIsPrn) {
      changes.push({
        field: 'frequency',
        from: currentIsPrn ? 'only when needed' : `${currentDoses} a day`,
        to: frequencyLabelEn(line.decoded),
      });
    } else if (!incomingIsPrn && currentDoses !== incomingDoses) {
      changes.push({
        field: 'frequency',
        from: `${currentDoses} a day`,
        to: frequencyLabelEn(line.decoded),
      });
    }

    if (line.decoded.intervalDays !== currentMedicine.intervalDays) {
      changes.push({
        field: 'interval',
        from: intervalLabel(currentMedicine.intervalDays),
        to: intervalLabel(line.decoded.intervalDays),
      });
    }
  }

  return changes;
}

function intervalLabel(intervalDays: number): string {
  if (intervalDays === 1) return 'every day';
  if (intervalDays === 2) return 'alternate days';
  if (intervalDays === 7) return 'once a week';
  return `every ${intervalDays} days`;
}

function normaliseValue(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

// ── Planning (pure, and where every refusal lives) ───────────────────────────

export function planSupersession(
  diff: PrescriptionDiff,
  mode: SupersessionMode,
  options: {
    /** Per-thread choices for 'pick_per_medicine'. Anything missing DEFAULTS TO KEEP. */
    readonly decisions?: Readonly<Record<string, ThreadDecision>>;
    /** For 'replace_all': the exact threads the user was shown as stopping. */
    readonly acknowledgedStopThreadIds?: readonly string[];
  } = {},
): PlanResult {
  const candidates = diff.notOnThisPrescription;
  let toStop: NotOnPrescriptionRow[] = [];

  if (mode === 'keep_all') {
    toStop = [];
  } else if (mode === 'pick_per_medicine') {
    // Default Keep, per medicine, always. A blank decision is not permission.
    toStop = candidates.filter((row) => options.decisions?.[row.threadId] === 'stop');
  } else {
    toStop = [...candidates];

    const acknowledged = new Set(options.acknowledgedStopThreadIds ?? []);
    const missing = toStop.filter((row) => !acknowledged.has(row.threadId));
    const extra = [...acknowledged].filter((id) => !toStop.some((row) => row.threadId === id));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        refusal: {
          code: 'stop_list_not_acknowledged',
          message:
            'Replacing everything must list exactly which medicines stop, and that list must be the one the user saw.',
          threadIds: [...missing.map((row) => row.threadId), ...extra],
        },
      };
    }

    // The bulk ban. Per-medicine, with the name on screen, a critical medicine can be
    // stopped; in a sweep it cannot, because a sweep is one tap and this is the class of
    // medicine where stopping quietly does the most harm.
    const critical = toStop.filter((row) => row.criticality === 'critical');
    if (critical.length > 0) {
      return {
        ok: false,
        refusal: {
          code: 'critical_cannot_be_bulk_stopped',
          message:
            'These are marked as very important medicines. They can only be stopped one at a time, on purpose.',
          threadIds: critical.map((row) => row.threadId),
        },
      };
    }
  }

  const stopped = new Set(toStop.map((row) => row.threadId));
  const toKeep = candidates.filter((row) => !stopped.has(row.threadId));

  const resultingMedicineCount =
    diff.continued.length + diff.changed.length + diff.added.length + toKeep.length;

  if (resultingMedicineCount === 0) {
    return {
      ok: false,
      refusal: {
        code: 'would_leave_no_medicines',
        message:
          'This would leave no medicines at all, which is almost always a misreading of the prescription rather than an instruction to stop everything.',
        threadIds: toStop.map((row) => row.threadId),
      },
    };
  }

  return {
    ok: true,
    plan: {
      mode,
      toStop,
      toKeep,
      toVersion: diff.changed,
      toCreate: diff.added,
      resultingMedicineCount,
    },
  };
}

// ── Applying (the only part that writes) ─────────────────────────────────────

export type ApplyResult = {
  readonly stoppedThreadIds: readonly string[];
  /** False when the native alarm layer could not be reached. The rows are committed. */
  readonly alarmsArmed: boolean;
};

/**
 * Stops what the plan says to stop, and nothing else.
 *
 * ON "APPENDS A STOPPED VERSION": stopping is recorded as the current version moving to
 * `status='stopped'` with `stop_reason` and `stopped_on`, plus an append-only
 * `med_change_event` — which is what `stopMedicine()` does. Every earlier version stays
 * byte-for-byte intact, so "what was she taking in March?" still answers correctly; that
 * is the property append-only versioning protects, and it is preserved here.
 *
 * The alternative — `createNewVersion()` then stopping it — was rejected deliberately: it
 * forces `status='active'` on the way through, emits a `dose_changed` marker that would
 * draw a false "the dose changed" line on the charts, and duplicates a row whose clinical
 * fields are identical to the one above it.
 *
 * Alarms are cancelled by the reconcile that runs immediately after the commit: it
 * retires the now-unexpected occurrences and republishes the horizon without the stopped
 * threads. That happens outside the transaction for the reason `dosing/reconcile.ts`
 * documents — a JSI round trip must not be made while holding SQLite's write lock.
 */
export async function applySupersession(
  profileId: string,
  plan: SupersessionPlan,
  options: { reason?: string; stoppedOn?: string; refreshAlarms?: boolean } = {},
  tx?: Tx,
): Promise<ApplyResult> {
  const stoppedOn = options.stoppedOn ?? toLocalDate();
  const reason = options.reason ?? 'Not on the latest prescription';

  await inTransaction(async (t) => {
    for (const row of plan.toStop) {
      // Both halves, same transaction. Stopping the medicine without closing its
      // schedules would leave rows the reconciler still considers current.
      await stopMedicine(row.threadId, { reason, stoppedOn }, t);
      await stopSchedules(row.threadId, stoppedOn, t);
    }
  }, tx);

  const alarmsArmed =
    options.refreshAlarms === false || plan.toStop.length === 0
      ? false
      : await refreshAlarms(profileId);

  return { stoppedThreadIds: plan.toStop.map((row) => row.threadId), alarmsArmed };
}

async function refreshAlarms(profileId: string): Promise<boolean> {
  try {
    const { reconcile } = await import('../dosing/reconcile');
    const result = await reconcile(profileId);
    return result.alarmsArmed;
  } catch (error) {
    console.warn('[supersession] could not re-arm reminders', error);
    return false;
  }
}
