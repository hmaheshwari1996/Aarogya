/**
 * The gate. Nothing reaches `care_event` without passing through here first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REFUSES, AND WHY EACH REFUSAL EXISTS
 *
 *   • An event the extraction does not support. Every row must trace back to something on
 *     the paper or to an offset this app owns and can explain.
 *   • A follow-up interval that appears nowhere on the prescription. This is the one that
 *     matters most: a date on a calendar carries the doctor's authority whether or not
 *     the doctor said it.
 *   • A test that was not advised. "Repeat the LFT" is an instruction; "an LFT would
 *     usually be done" is the model talking, and it never reaches the calendar.
 *   • An inferred row that cannot name its anchor, or whose date does not equal
 *     anchor + offset. Arithmetic that cannot be re-checked is not arithmetic, it is a
 *     claim.
 *   • A transcribed row with no quoted words behind it.
 *
 * The guard re-derives the follow-up date with `resolveFollowUpDate()` — the same
 * function the deriver used — rather than re-implementing it. Two implementations of the
 * same arithmetic disagree eventually, and the disagreement always surfaces as a wrong
 * date rather than as a caught bug.
 *
 * `buildConfirmModel()` is the second half of this file: the shape the human confirm
 * screen consumes. It keeps TRANSCRIBED and INFERRED in separate lists so the screen
 * cannot accidentally render them the same way. "The doctor wrote: review after 1 month"
 * and "Aarogya suggests booking 2 days ahead" are different kinds of statement, and a UI
 * that shows them identically has quietly undone the whole design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { addDays } from '../../lib/datetime';
import type { ParsedFollowUp, ParsedTest } from '../prescriptions/schema';
import {
  resolveFollowUpDate,
  type CalendarRefusal,
  type ProposedCareEvent,
} from './calendar';

// ── Evidence ─────────────────────────────────────────────────────────────────

/** Everything a proposal is allowed to be justified by. Nothing else counts. */
export type CalendarEvidence = {
  readonly prescribedOn: string | null;
  readonly followUp: ParsedFollowUp;
  readonly testsAdvised: readonly ParsedTest[];
};

export type RejectionCode =
  | 'unsupported_kind'
  | 'bad_date'
  | 'transcribed_without_evidence'
  | 'follow_up_not_on_prescription'
  | 'follow_up_date_does_not_match'
  | 'test_not_advised'
  | 'inferred_without_anchor'
  | 'inferred_without_derivation'
  | 'anchor_rejected'
  | 'offset_does_not_explain_date'
  | 'before_prescription_date';

export type Rejection = {
  readonly proposal: ProposedCareEvent;
  readonly code: RejectionCode;
  /** Developer-facing. The user sees the plain-language line on the confirm screen. */
  readonly message: string;
};

export type ValidationResult = {
  readonly accepted: readonly ProposedCareEvent[];
  readonly rejected: readonly Rejection[];
};

/** The kinds this path may ever produce. `refill` and `custom` are not extraction-derived. */
const ALLOWED_KINDS = new Set(['visit', 'book_appointment', 'test_book', 'test_do', 'test_collect']);

/** A derived date more than this far from its anchor is a bug, not an offset. */
const MAX_OFFSET_DAYS = 60;

export function validateProposedCalendar(
  proposals: readonly ProposedCareEvent[],
  evidence: CalendarEvidence,
): ValidationResult {
  const accepted: ProposedCareEvent[] = [];
  const rejected: Rejection[] = [];
  const acceptedByKey = new Map<string, ProposedCareEvent>();

  // Order-independent, by repeated passes until nothing new is accepted.
  //
  // The deriver emits a test chain in the order the steps HAPPEN — book, then do, then
  // collect — while the dependency runs the other way, because each step is derived
  // backwards from the visit. A single pass in array order would reject "book the test"
  // for having an anchor it simply had not reached yet, which is a validator failing on
  // presentation order rather than on evidence.
  let pending = [...proposals];
  let progressed = true;

  while (pending.length > 0 && progressed) {
    progressed = false;
    const undecided = new Set(pending.map((proposal) => proposal.key));
    const deferred: ProposedCareEvent[] = [];

    for (const proposal of pending) {
      const failure = check(proposal, evidence, acceptedByKey);
      if (!failure) {
        accepted.push(proposal);
        acceptedByKey.set(proposal.key, proposal);
        progressed = true;
        continue;
      }
      // Only a missing anchor is worth another pass, and only while that anchor is still
      // undecided. Every other failure is about this row's own evidence and will not
      // change however many times it is re-checked.
      if (
        failure.code === 'anchor_rejected' &&
        proposal.anchorKey &&
        proposal.anchorKey !== proposal.key &&
        undecided.has(proposal.anchorKey)
      ) {
        deferred.push(proposal);
        continue;
      }
      rejected.push({ proposal, code: failure.code, message: failure.message });
    }
    pending = deferred;
  }

  // Whatever is left is a cycle, or hangs off something that was rejected.
  for (const proposal of pending) {
    rejected.push({
      proposal,
      code: 'anchor_rejected',
      message: `Its anchor ('${proposal.anchorKey ?? 'none'}') was not accepted, so this cannot stand on its own.`,
    });
  }

  return { accepted, rejected };
}

type Failure = { code: RejectionCode; message: string };

function check(
  proposal: ProposedCareEvent,
  evidence: CalendarEvidence,
  acceptedByKey: ReadonlyMap<string, ProposedCareEvent>,
): Failure | null {
  if (!ALLOWED_KINDS.has(proposal.kind)) {
    return {
      code: 'unsupported_kind',
      message: `'${proposal.kind}' is not a kind that can be derived from a prescription.`,
    };
  }
  if (!isIsoDate(proposal.dueOn)) {
    return { code: 'bad_date', message: `'${proposal.dueOn}' is not a valid YYYY-MM-DD date.` };
  }

  if (proposal.anchorSource === 'transcribed') {
    return checkTranscribed(proposal, evidence);
  }
  return checkInferred(proposal, evidence, acceptedByKey);
}

function checkTranscribed(proposal: ProposedCareEvent, evidence: CalendarEvidence): Failure | null {
  if (!proposal.evidence) {
    return {
      code: 'transcribed_without_evidence',
      message: 'A transcribed row must quote the words it came from.',
    };
  }

  // Only the visit is ever transcribed from a prescription. Test dates are always ours.
  if (proposal.kind !== 'visit') {
    return {
      code: 'unsupported_kind',
      message: `'${proposal.kind}' cannot be transcribed — only the follow-up visit is written on the paper.`,
    };
  }

  if (!evidence.followUp.present || !evidence.followUp.verbatim) {
    return {
      code: 'follow_up_not_on_prescription',
      message: 'No follow-up instruction was found on this prescription.',
    };
  }
  if (proposal.evidence !== evidence.followUp.verbatim) {
    return {
      code: 'follow_up_not_on_prescription',
      message: `The quoted follow-up ("${proposal.evidence}") is not what was read from the prescription ("${evidence.followUp.verbatim}").`,
    };
  }

  // Re-derive and compare. This is what catches a date that was resolved against today
  // instead of the prescription date, and a month added as 30 days instead of clamped.
  const resolved = resolveFollowUpDate(evidence.followUp, evidence.prescribedOn);
  if (resolved.kind !== 'resolved') {
    return {
      code: 'follow_up_not_on_prescription',
      message:
        resolved.kind === 'refused'
          ? resolved.refusal.message
          : 'The follow-up instruction does not resolve to a date.',
    };
  }
  if (resolved.dueOn !== proposal.dueOn) {
    return {
      code: 'follow_up_date_does_not_match',
      message: `The follow-up resolves to ${resolved.dueOn}, not ${proposal.dueOn}.`,
    };
  }

  if (evidence.prescribedOn && proposal.dueOn < evidence.prescribedOn) {
    return {
      code: 'before_prescription_date',
      message: `A follow-up on ${proposal.dueOn} is before the prescription was written (${evidence.prescribedOn}).`,
    };
  }
  return null;
}

function checkInferred(
  proposal: ProposedCareEvent,
  evidence: CalendarEvidence,
  acceptedByKey: ReadonlyMap<string, ProposedCareEvent>,
): Failure | null {
  if (!proposal.anchorKey) {
    return {
      code: 'inferred_without_anchor',
      message: 'An app-derived date must name the event it was derived from.',
    };
  }
  const anchor = acceptedByKey.get(proposal.anchorKey);
  if (!anchor) {
    return {
      code: 'anchor_rejected',
      message: `Its anchor ('${proposal.anchorKey}') was not accepted, so this cannot stand on its own.`,
    };
  }
  if (!proposal.derivation) {
    return {
      code: 'inferred_without_derivation',
      message: 'An app-derived date must be able to explain how it was worked out.',
    };
  }
  if (Math.abs(proposal.offsetDays) > MAX_OFFSET_DAYS) {
    return {
      code: 'offset_does_not_explain_date',
      message: `An offset of ${proposal.offsetDays} days from its anchor is out of range.`,
    };
  }
  // The stored offset must actually produce the stored date, because that is the pair the
  // database keeps and `recomputeInferredDueDate()` will later rely on when the anchor
  // moves. A row whose offset and date disagree silently jumps the first time it is
  // recomputed.
  if (addDays(anchor.dueOn, proposal.offsetDays) !== proposal.dueOn) {
    return {
      code: 'offset_does_not_explain_date',
      message: `${anchor.dueOn} offset by ${proposal.offsetDays} days is not ${proposal.dueOn}.`,
    };
  }

  // A test row has to name a test the doctor actually wrote.
  if (proposal.kind !== 'book_appointment') {
    const index = testIndexOf(proposal.relatedTestKey);
    if (index === null) {
      return {
        code: 'test_not_advised',
        message: 'This test reminder does not say which advised test it belongs to.',
      };
    }
    const test = evidence.testsAdvised[index];
    if (!test) {
      return {
        code: 'test_not_advised',
        message: 'This test was not among the tests written on the prescription.',
      };
    }
    const name = test.normalisedName ?? test.nameAsWritten;
    if (!name) {
      return {
        code: 'test_not_advised',
        message: 'The advised test it refers to has no readable name.',
      };
    }
  }

  if (evidence.prescribedOn && proposal.dueOn < evidence.prescribedOn) {
    return {
      code: 'before_prescription_date',
      message: `${proposal.dueOn} is before the prescription was written (${evidence.prescribedOn}).`,
    };
  }
  return null;
}

function testIndexOf(relatedTestKey: string | null): number | null {
  if (!relatedTestKey) return null;
  const match = /^test:(\d+)$/.exec(relatedTestKey);
  if (!match?.[1]) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

// ── The confirm screen's model ───────────────────────────────────────────────

export type ConfirmRow = {
  readonly key: string;
  readonly kind: ProposedCareEvent['kind'];
  readonly title: string;
  readonly dueOn: string;
  readonly testName: string | null;
  readonly anchorKey: string | null;
  /**
   * 'transcribed' — show it as what the doctor wrote, with the quoted words.
   * 'inferred'    — show it as the app's suggestion, with the working and an editable
   *                 number of days. These must never look the same on screen.
   */
  readonly source: 'transcribed' | 'inferred';
  /** The words on the paper. Non-null exactly when `source` is 'transcribed'. */
  readonly evidence: string | null;
  /** The arithmetic. Non-null exactly when `source` is 'inferred'. */
  readonly derivation: string | null;
  readonly offsetDays: number;
  readonly editable: { readonly date: boolean; readonly offsetDays: boolean };
  /** Set when the date was pulled forward to keep it out of the past. */
  readonly adjustedNote: string | null;
};

export type CalendarConfirmModel = {
  /** Rendered under "The doctor wrote this". */
  readonly transcribed: readonly ConfirmRow[];
  /** Rendered under "Aarogya worked this out", each showing its offset. */
  readonly inferred: readonly ConfirmRow[];
  /** Shown so the user knows what was deliberately NOT proposed, and why. */
  readonly notProposed: readonly { code: string; message: string }[];
  /**
   * Always true. It is a literal rather than a comment because it is the invariant this
   * whole feature rests on: nothing is written to `care_event` until a person accepts it.
   */
  readonly requiresConfirmation: true;
};

export function buildConfirmModel(
  validation: ValidationResult,
  refusals: readonly CalendarRefusal[] = [],
): CalendarConfirmModel {
  const rows = validation.accepted.map(toConfirmRow);
  return {
    transcribed: rows.filter((row) => row.source === 'transcribed'),
    inferred: rows.filter((row) => row.source === 'inferred'),
    notProposed: [
      ...refusals.map((refusal) => ({ code: refusal.code, message: refusal.message })),
      // A rejected proposal is also something the user should know was not proposed —
      // silence here would look like the app simply had nothing to say.
      ...validation.rejected.map((rejection) => ({
        code: rejection.code,
        message: rejection.message,
      })),
    ],
    requiresConfirmation: true,
  };
}

function toConfirmRow(proposal: ProposedCareEvent): ConfirmRow {
  const isTranscribed = proposal.anchorSource === 'transcribed';
  return {
    key: proposal.key,
    kind: proposal.kind,
    title: proposal.title,
    dueOn: proposal.dueOn,
    testName: proposal.testName,
    anchorKey: proposal.anchorKey,
    source: isTranscribed ? 'transcribed' : 'inferred',
    evidence: proposal.evidence,
    derivation: proposal.derivation,
    offsetDays: proposal.offsetDays,
    editable: {
      // A transcribed date IS editable — the app may have misread it and she has the
      // paper in front of her. What is not editable is the offset, because a transcribed
      // row has none: it is not derived from anything.
      date: true,
      offsetDays: !isTranscribed,
    },
    adjustedNote: proposal.adjustedNote,
  };
}
