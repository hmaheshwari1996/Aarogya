/**
 * The human sign-off. Reviewed extraction → real `medicine` and `dose_schedule` rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH CONFIRMATIONS, EVERY TIME
 *
 * `medicine.confirmed_by_user_at` AND `dose_schedule.confirmed_by_user_at` are set here,
 * separately, because they fail separately and the database enforces both
 * (`trg_occ_requires_confirmed_medicine`, `trg_occ_requires_confirmed_schedule`). A
 * medicine whose name was checked but whose frequency was not is the dangerous case:
 * "1-0-1 misread as QID" leaves the name flawless and quadruples the dose. Confirming
 * the name is not confirming the frequency, and nothing in this file lets one stand in
 * for the other.
 *
 * THE FOUR-DOSE CAP
 *
 * An AI-proposed schedule may never exceed `MAX_AI_DOSES_PER_DAY`. Four is the highest
 * frequency Indian shorthand expresses unambiguously (QID, 1-1-1-1); anything above it is
 * hourly dosing or a taper, both of which need real times from a person. A medicine that
 * exceeds the cap still gets created — she photographed it, it is part of her treatment,
 * and losing it would be worse — but it gets NO schedule, so the database itself cannot
 * produce a single occurrence for it. It comes back in `needsManualSchedule` and the UI
 * sends her to manual entry.
 *
 * NOTHING IS ALL-OR-NOTHING. A medicine that cannot be scheduled never blocks the four
 * that can. Every refusal is reported per-medicine with a reason, and the rest commit.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Criticality } from '../../types';
import { toLocalDate } from '../../lib/datetime';
import { inTransaction, type Tx } from '../../db/repositories/_shared';
import {
  createMedicine,
  createNewVersion,
  insertMedChangeEvent,
} from '../../db/repositories/medicines';
import {
  createInitialSchedules,
  createScheduleVersion,
  type ScheduleSlot,
} from '../../db/repositories/schedules';
import { confirmPrescription } from '../../db/repositories/prescriptions';
// The cap lives with the decoder that detects it, so the rule and the detection of it
// cannot drift apart. It is re-exported here because the review screen needs the number
// to cap its own doses-per-day field, and importing it from the module that ENFORCES it
// is what keeps the screen and the writer agreeing about what the limit is.
import { ALL_DAYS_MASK, MAX_AI_DOSES_PER_DAY } from './frequency';

export { MAX_AI_DOSES_PER_DAY } from './frequency';

// ── Input ────────────────────────────────────────────────────────────────────

export type ReviewedSlot = {
  /** 'HH:MM', 24-hour, wall clock. Chosen by the user — never read off the paper. */
  readonly timeLocal: string;
  readonly slotKey?: string | null;
  readonly quantityValue?: number | null;
  readonly quantityUnit?: string | null;
  /** Free text for anything that is not a clean number: "half tablet", "2 puffs". */
  readonly quantityText?: string | null;
  readonly foodRelation?: 'before' | 'after' | 'with' | 'empty' | 'any' | null;
};

export type ReviewedSchedule =
  | {
      readonly kind: 'fixed';
      readonly slots: readonly ReviewedSlot[];
      readonly daysMask?: number;
      readonly intervalDays?: number;
    }
  | {
      readonly kind: 'prn';
      readonly quantityValue?: number | null;
      readonly quantityUnit?: string | null;
      readonly quantityText?: string | null;
      readonly foodRelation?: 'before' | 'after' | 'with' | 'empty' | 'any' | null;
    }
  /** The review screen already decided a person must type the timings. */
  | { readonly kind: 'manual_required'; readonly reason: string }
  /**
   * A dose that was given once and is being written down, not scheduled — a STAT line on
   * a discharge summary, swallowed in the ward before she came home.
   *
   * IT IS NOT `manual_required` WEARING A DIFFERENT REASON STRING, and the difference is
   * a sentence the caller prints. `manual_required` means "timings still owed", and the
   * post-save dialog says so and offers a button that goes and asks for them. Telling her
   * to set the timings of an injection she was already given contradicts the answer she
   * has just given on the review card. Both produce the same ROW — a confirmed medicine
   * with no schedule, structurally incapable of ringing — and they must not produce the
   * same sentence, which is why the reason travels as a code and not as prose.
   */
  | { readonly kind: 'record_only'; readonly reason: string };

export type ReviewedMedicine = {
  readonly nameAsWritten: string;
  readonly genericGuess?: string | null;
  readonly strength?: string | null;
  readonly form?: string | null;
  /** What the HUMAN chose. Not what the model proposed. */
  readonly criticality: Criticality;
  /** What the model proposed, kept alongside so the two never merge in the record. */
  readonly proposedCriticality?: Criticality | null;
  readonly criticalityReason?: string | null;
  readonly startedOn?: string;
  readonly schedule: ReviewedSchedule;
  /**
   * The human ticked this line. Anything without it is skipped — there is no default
   * and no "confirm all" shortcut that reaches this function without per-line intent.
   */
  readonly confirmed: boolean;
  /** Set by `./reconcile.ts` when this is a changed dose of a drug she is already on. */
  readonly supersedesThreadId?: string | null;
  /** Index into the extraction's medicines array, for the audit trail. */
  readonly sourceIndex?: number;
};

export type ConfirmInput = {
  readonly profileId: string;
  readonly prescriptionId: string;
  readonly medicines: readonly ReviewedMedicine[];
  /** 'ai' enforces the four-dose cap. 'manual' is hand entry and is not capped. */
  readonly source?: 'ai' | 'manual';
  readonly startedOn?: string;
  /** Marks the prescription row itself confirmed. Defaults to true. */
  readonly confirmPrescriptionRow?: boolean;
  /** Re-arms reminders after the commit. Defaults to true. */
  readonly refreshAlarms?: boolean;
};

// ── Output ───────────────────────────────────────────────────────────────────

/**
 * Two of the user's slots sitting on one clock time, so one dose was merged into the other.
 *
 * CARRIED OUT OF HERE RATHER THAN DROPPED. The merge below is unavoidable —
 * `UNIQUE (thread_id, version, time_local)` would abort the whole confirmation and take
 * every other medicine down with it — but it used to be a bare `continue`. A
 * four-times-a-day prescription then wrote three rows, reported `dosesPerDay: 3`, and the
 * post-save dialog counted the medicine as set up with reminders. The only thing on screen
 * was a muted grey caption two scrolls up that named neither the medicine nor the two
 * timings. Rule 3 in the slot registry is explicit that she has to be told WHICH two
 * collapsed, and only the caller knows their names.
 */
export type CollapsedDose = {
  readonly timeLocal: string;
  /** The slot that kept the minute — first in the order the review screen planned. */
  readonly keptSlotKey: string | null;
  /** The slot whose dose was merged into it. */
  readonly droppedSlotKey: string | null;
};

export type ConfirmedRow = {
  readonly threadId: string;
  readonly medicineId: string;
  readonly name: string;
  readonly scheduleIds: readonly string[];
  readonly dosesPerDay: number;
  /** Empty in the normal case. Non-empty means this medicine rings fewer times than asked. */
  readonly collapsed: readonly CollapsedDose[];
};

export type ManualScheduleNeeded = {
  readonly threadId: string;
  readonly medicineId: string;
  readonly name: string;
  readonly reason: ManualReason;
  readonly detail: string;
};

export type ManualReason =
  | 'exceeds_ai_dose_cap'
  | 'no_times_chosen'
  | 'invalid_time'
  | 'review_screen_requested'
  /**
   * Nothing is owed. She said on the review card that this dose was already given, so the
   * medicine is written down with no schedule and no timings are missing. The caller must
   * report this row in its own words — see `ReviewedSchedule`'s `record_only`.
   */
  | 'recorded_only';

export type SkippedRow = {
  readonly name: string;
  readonly reason: 'not_confirmed' | 'no_name';
};

export type ConfirmResult = {
  readonly prescriptionId: string;
  readonly created: readonly ConfirmedRow[];
  /** Changed doses: a NEW VERSION on the SAME thread, never a stop-and-start. */
  readonly updated: readonly ConfirmedRow[];
  readonly needsManualSchedule: readonly ManualScheduleNeeded[];
  readonly skipped: readonly SkippedRow[];
  /** False when the native alarm layer could not be reached. The rows are committed. */
  readonly alarmsArmed: boolean;
};

// ── The one entry point ──────────────────────────────────────────────────────

export async function confirmExtraction(input: ConfirmInput, tx?: Tx): Promise<ConfirmResult> {
  const source = input.source ?? 'ai';
  const startedOn = input.startedOn ?? toLocalDate();

  const created: ConfirmedRow[] = [];
  const updated: ConfirmedRow[] = [];
  const needsManualSchedule: ManualScheduleNeeded[] = [];
  const skipped: SkippedRow[] = [];

  await inTransaction(async (t) => {
    for (const reviewed of input.medicines) {
      if (reviewed.confirmed !== true) {
        skipped.push({ name: reviewed.nameAsWritten, reason: 'not_confirmed' });
        continue;
      }
      const name = reviewed.nameAsWritten.trim();
      if (name.length === 0) {
        skipped.push({ name: reviewed.nameAsWritten, reason: 'no_name' });
        continue;
      }

      const plan = planSchedule(reviewed.schedule, source);
      const medicineStartedOn = reviewed.startedOn ?? startedOn;

      // ── The medicine row ──────────────────────────────────────────────────
      let threadId: string;
      let medicineId: string;
      let isNewVersion = false;

      if (reviewed.supersedesThreadId) {
        // SAME THREAD. A dose change is version N+1 of the same drug, so six months of
        // adherence history stays attached to it. Modelling it as stop-and-start would
        // silently reset a TB patient's streak on the day her dose was adjusted.
        threadId = reviewed.supersedesThreadId;
        medicineId = await createNewVersion(
          threadId,
          {
            nameAsWritten: name,
            genericGuess: reviewed.genericGuess ?? null,
            strength: reviewed.strength ?? null,
            form: reviewed.form ?? null,
            criticality: reviewed.criticality,
            criticalityProposed: reviewed.proposedCriticality ?? null,
            criticalityReason: reviewed.criticalityReason ?? null,
            startedOn: medicineStartedOn,
          },
          { confirmedByUser: true, changeKind: 'dose_changed', detail: name },
          t,
        );
        isNewVersion = true;
      } else {
        const result = await createMedicine(
          {
            profileId: input.profileId,
            nameAsWritten: name,
            genericGuess: reviewed.genericGuess ?? null,
            strength: reviewed.strength ?? null,
            form: reviewed.form ?? null,
            criticality: reviewed.criticality,
            criticalityProposed: reviewed.proposedCriticality ?? null,
            criticalityReason: reviewed.criticalityReason ?? null,
            startedOn: medicineStartedOn,
            source: 'ai',
            prescriptionId: input.prescriptionId,
            // THE HUMAN GATE, half one. Without this the database refuses to create a
            // single dose occurrence for this row.
            confirmedByUser: true,
          },
          t,
        );
        threadId = result.threadId;
        medicineId = result.id;
      }

      // ── The schedule rows ─────────────────────────────────────────────────
      if (plan.kind === 'manual') {
        // The medicine exists and is confirmed; it simply has no schedule, so it is
        // structurally incapable of ringing. That is the safe half of the failure.
        needsManualSchedule.push({
          threadId,
          medicineId,
          name,
          reason: plan.reason,
          detail: plan.detail,
        });
        continue;
      }

      const scheduleIds = isNewVersion
        ? await createScheduleVersion(
            {
              threadId,
              medicineId,
              startedOn: medicineStartedOn,
              slots: plan.slots,
              // THE HUMAN GATE, half two — and the half that matters most.
              confirmedByUser: true,
            },
            t,
          )
        : await createInitialSchedules(
            {
              threadId,
              medicineId,
              startedOn: medicineStartedOn,
              slots: plan.slots,
              confirmedByUser: true,
            },
            t,
          );

      const row: ConfirmedRow = {
        threadId,
        medicineId,
        name,
        scheduleIds,
        dosesPerDay: plan.dosesPerDay,
        collapsed: plan.collapsed,
      };
      if (isNewVersion) updated.push(row);
      else created.push(row);
    }

    // One marker per prescription, on the chart's shared date axis. Never annotated —
    // the schema comment is explicit that these are visible, not explained.
    if (created.length > 0 || updated.length > 0) {
      await insertMedChangeEvent(
        {
          profileId: input.profileId,
          kind: 'prescription',
          localDate: startedOn,
          prescriptionId: input.prescriptionId,
          detail: `${created.length + updated.length} medicines confirmed`,
        },
        t,
      );
    }

    // Confirms the PAPER only. It grants the medicines and schedules nothing — each of
    // those was confirmed above, individually, or was not confirmed at all.
    if (input.confirmPrescriptionRow !== false) {
      await confirmPrescription(input.prescriptionId, t);
    }
  }, tx);

  // Deliberately AFTER the commit, and outside any transaction — the same ordering
  // `dosing/reconcile.ts` uses, and for the same reason: a JSI round trip inside an open
  // write transaction holds SQLite's write lock across a boundary we do not control.
  const alarmsArmed =
    input.refreshAlarms === false ? false : await refreshAlarms(input.profileId);

  return { prescriptionId: input.prescriptionId, created, updated, needsManualSchedule, skipped, alarmsArmed };
}

// ── Schedule planning ────────────────────────────────────────────────────────

type SchedulePlan =
  | { kind: 'slots'; slots: ScheduleSlot[]; dosesPerDay: number; collapsed: CollapsedDose[] }
  | { kind: 'manual'; reason: ManualReason; detail: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function planSchedule(schedule: ReviewedSchedule, source: 'ai' | 'manual'): SchedulePlan {
  if (schedule.kind === 'manual_required') {
    return { kind: 'manual', reason: 'review_screen_requested', detail: schedule.reason };
  }

  // The same row as above — medicine, no schedule — under a reason code that says nothing
  // is outstanding. The two are separated here rather than at the caller so that the
  // distinction survives the round trip through `ConfirmResult`.
  if (schedule.kind === 'record_only') {
    return { kind: 'manual', reason: 'recorded_only', detail: schedule.reason };
  }

  if (schedule.kind === 'prn') {
    // PRN carries no time at all and generates no occurrences. A placeholder time would
    // eventually be read as a real slot and start ringing for an as-needed painkiller.
    return {
      kind: 'slots',
      dosesPerDay: 0,
      collapsed: [],
      slots: [
        {
          timeLocal: null,
          scheduleType: 'PRN',
          quantityValue: schedule.quantityValue ?? null,
          quantityUnit: schedule.quantityUnit ?? null,
          quantityText: schedule.quantityText ?? null,
          foodRelation: schedule.foodRelation ?? null,
        },
      ],
    };
  }

  // Duplicate times are merged rather than rejected: UNIQUE(thread_id, version,
  // time_local) would otherwise abort the whole transaction and take every other
  // medicine's confirmation down with it.
  const seen = new Map<string, string | null>();
  const collapsed: CollapsedDose[] = [];
  const slots: ScheduleSlot[] = [];
  for (const slot of schedule.slots) {
    const timeLocal = slot.timeLocal.trim();
    if (!TIME_PATTERN.test(timeLocal)) {
      return {
        kind: 'manual',
        reason: 'invalid_time',
        detail: `"${slot.timeLocal}" is not a 24-hour HH:MM time`,
      };
    }
    if (seen.has(timeLocal)) {
      // Merged, and RECORDED. The caller turns this into a sentence naming both slots
      // beside the medicine; without it the dialog says the medicine is set up and the
      // dose that vanished is never mentioned anywhere.
      collapsed.push({
        timeLocal,
        keptSlotKey: seen.get(timeLocal) ?? null,
        droppedSlotKey: slot.slotKey ?? null,
      });
      continue;
    }
    seen.set(timeLocal, slot.slotKey ?? null);
    slots.push({
      timeLocal,
      slotKey: slot.slotKey ?? null,
      scheduleType: 'FIXED',
      daysMask: schedule.daysMask ?? ALL_DAYS_MASK,
      intervalDays: schedule.intervalDays ?? 1,
      quantityValue: slot.quantityValue ?? null,
      quantityUnit: slot.quantityUnit ?? null,
      quantityText: slot.quantityText ?? null,
      foodRelation: slot.foodRelation ?? null,
    });
  }

  if (slots.length === 0) {
    return { kind: 'manual', reason: 'no_times_chosen', detail: 'no times were chosen' };
  }

  // THE CAP. Only the AI path is capped; hand entry is the escape hatch it routes to,
  // and capping that too would leave a genuine Q4H antibiotic with nowhere to go.
  if (source === 'ai' && slots.length > MAX_AI_DOSES_PER_DAY) {
    return {
      kind: 'manual',
      reason: 'exceeds_ai_dose_cap',
      detail: `${slots.length} doses a day is above the ${MAX_AI_DOSES_PER_DAY} this app will schedule from a photograph`,
    };
  }

  return { kind: 'slots', slots, dosesPerDay: slots.length, collapsed };
}

/**
 * Re-arms reminders after the rows are committed.
 *
 * Imported lazily so that the native alarm module is not pulled into every import chain
 * that merely wants to confirm a medicine — it is absent in Expo Go and under the test
 * runner, and `dosing/reconcile.ts` already degrades to a logged no-op when it is.
 */
async function refreshAlarms(profileId: string): Promise<boolean> {
  try {
    const { reconcile } = await import('../dosing/reconcile');
    const result = await reconcile(profileId);
    return result.alarmsArmed;
  } catch (error) {
    // The medicines are saved. Reminders being unavailable is a degraded state the
    // Reminder Health Check surfaces; it is not a reason to fail the confirmation.
    console.warn('[confirm] could not re-arm reminders', error);
    return false;
  }
}
