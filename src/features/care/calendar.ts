/**
 * Turning a confirmed extraction into proposed calendar entries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEPARATION THAT MAKES THIS SAFE
 *
 * The AI supplies CLINICAL ANCHORS and nothing else: the date of the next visit, and
 * which tests the doctor wrote down. Both of those are on the paper, so both can be
 * checked against the photograph by the person confirming them.
 *
 * THE APP OWNS EVERY OFFSET. Book the appointment two days ahead; a routine biochemistry
 * report takes about a day; collect the report before the visit rather than on the way in.
 * None of those numbers appears anywhere on a prescription. If a model produced them,
 * nobody — not the user, not a doctor, not us — could check them against anything, and a
 * number that cannot be checked is a number that must not be attributed to a clinician.
 *
 * So: anchors are written with `anchor_source: 'transcribed'` and carry the words that
 * justify them. Everything the app computes is `'inferred'`, carries the anchor and the
 * offset that produced it, and is editable by the user. `'manual'` is what she types.
 * `care_event.anchor_source` is the column that keeps those three apart forever, and
 * `db/repositories/care.ts` refuses to let an inferred row exist without its anchor.
 *
 * NO PRESCRIPTION DATE, NO PROPOSALS. If the date the prescription was written cannot be
 * read, a relative instruction like "review after 1 month" has no anchor. Resolving it
 * against today would produce a date that looks exactly like a transcribed one and is
 * wrong by however long the paper sat in a handbag. This file proposes nothing in that
 * case and says why.
 *
 * PURE. No database, no clock beyond the `today` you pass in, no imports that reach the
 * network — so every rule here is unit-testable, and it is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { addDays, addMonthsClamped, daysBetween } from '../../lib/datetime';
import type { CareEventKind } from '../../types';
import type { ParsedFollowUp, ParsedTest, TestCategory } from '../prescriptions/schema';

// ── Offsets: ours, proposed, and editable ────────────────────────────────────

/**
 * How long a report usually takes to come back.
 *
 * THESE ARE PROPOSED OPERATIONAL DEFAULTS, NOT CLINICAL OR LABORATORY STANDARDS. They are
 * a starting guess at how Indian labs behave so that a reminder lands on a useful day;
 * they vary by lab, by city and by test. Every one of them is user-editable, and the
 * confirm screen shows the number it used. Nothing here should ever be presented as a
 * fact about a test.
 */
export const DEFAULT_TEST_TURNAROUND_DAYS: Record<TestCategory, number> = {
  routine_biochemistry: 1,
  culture: 3,
  histopathology: 5,
  /** Reported at the scan itself, more often than not. */
  imaging: 0,
  other: 1,
  unknown: 1,
};

export type CareOffsets = {
  /** Days before the visit to be reminded to book it. */
  readonly appointmentBookLeadDays: number;
  /** Days before the test to be reminded to book it. */
  readonly testBookLeadDays: number;
  /** Days before the visit the report should be in hand. */
  readonly reportInHandDays: number;
  readonly turnaroundDays: Record<TestCategory, number>;
};

export const DEFAULT_CARE_OFFSETS: CareOffsets = {
  appointmentBookLeadDays: 2,
  testBookLeadDays: 2,
  reportInHandDays: 1,
  turnaroundDays: DEFAULT_TEST_TURNAROUND_DAYS,
};

// ── Shapes ───────────────────────────────────────────────────────────────────

export type ProposedAnchorSource = 'transcribed' | 'inferred';

export type ProposedCareEvent = {
  /** Stable within one proposal set; how inferred rows point at their anchor. */
  readonly key: string;
  readonly kind: CareEventKind;
  /** English fallback. The UI builds its own label from `kind` and `testName`. */
  readonly title: string;
  readonly dueOn: string;
  readonly anchorSource: ProposedAnchorSource;
  /** The key of the proposal this hangs off. Null only for a transcribed anchor. */
  readonly anchorKey: string | null;
  /** Negative = before the anchor. Always 0 on a transcribed row. */
  readonly offsetDays: number;
  readonly relatedTestKey: string | null;
  readonly testName: string | null;
  /** The words on the paper. REQUIRED on a transcribed row — it is the evidence. */
  readonly evidence: string | null;
  /** The arithmetic, in words. REQUIRED on an inferred row — it is the justification. */
  readonly derivation: string | null;
  /** True when the computed date was moved to keep it out of the past. */
  readonly adjusted: boolean;
  readonly adjustedNote: string | null;
};

export type CalendarRefusalCode =
  | 'prescription_date_unknown'
  | 'follow_up_not_resolvable'
  | 'follow_up_without_evidence'
  | 'test_without_name';

export type CalendarRefusal = {
  readonly code: CalendarRefusalCode;
  /** Plain language, ready to show. The user is told what was NOT proposed, and why. */
  readonly message: string;
  readonly detail: string | null;
};

/** A test the doctor wrote with no date anywhere to hang it on. */
export type TestNeedingDate = {
  readonly index: number;
  readonly name: string;
  readonly category: TestCategory;
  readonly evidence: string | null;
};

export type ProposedCalendar = {
  readonly proposals: readonly ProposedCareEvent[];
  readonly refusals: readonly CalendarRefusal[];
  /** Tests with no anchor: the UI asks her to pick a day, then calls `deriveTestChain`. */
  readonly testsNeedingDate: readonly TestNeedingDate[];
};

export type CalendarInput = {
  /** 'YYYY-MM-DD', or null when the date on the paper could not be read. */
  readonly prescribedOn: string | null;
  readonly followUp: ParsedFollowUp;
  readonly testsAdvised: readonly ParsedTest[];
  /** Used ONLY to keep proposals out of the past. Never used as an anchor. */
  readonly today: string;
};

// ── The derivation ───────────────────────────────────────────────────────────

export function deriveCareCalendar(
  input: CalendarInput,
  offsets: CareOffsets = DEFAULT_CARE_OFFSETS,
): ProposedCalendar {
  const proposals: ProposedCareEvent[] = [];
  const refusals: CalendarRefusal[] = [];
  const testsNeedingDate: TestNeedingDate[] = [];

  // The floor. Never an anchor — only a guard that stops a derived reminder landing on a
  // day that has already gone.
  const floor = laterOf(input.today, input.prescribedOn);

  // ── 1. The visit ──────────────────────────────────────────────────────────
  const visit = resolveVisit(input);
  if (visit.kind === 'refused') refusals.push(visit.refusal);

  let visitEvent: ProposedCareEvent | null = null;
  if (visit.kind === 'resolved') {
    visitEvent = {
      key: 'visit',
      kind: 'visit',
      title: 'Visit the doctor again',
      dueOn: visit.dueOn,
      // The doctor wrote this. Where it was written as an interval, the date is that
      // interval applied to the date the prescription itself carries — two transcribed
      // facts and calendar arithmetic, with no number of ours in between.
      anchorSource: 'transcribed',
      anchorKey: null,
      offsetDays: 0,
      relatedTestKey: null,
      testName: null,
      evidence: visit.evidence,
      derivation: visit.derivation,
      adjusted: false,
      adjustedNote: null,
    };
    proposals.push(visitEvent);

    proposals.push(
      inferred({
        key: 'book_appointment',
        kind: 'book_appointment',
        title: 'Book the appointment',
        anchor: visitEvent,
        offsetDays: -offsets.appointmentBookLeadDays,
        floor,
        relatedTestKey: null,
        testName: null,
        reason: `${offsets.appointmentBookLeadDays} days before the visit, so there is time to get a slot`,
      }),
    );
  }

  // ── 2. The tests ──────────────────────────────────────────────────────────
  for (const [index, test] of input.testsAdvised.entries()) {
    const name = test.normalisedName ?? test.nameAsWritten;
    if (!name) {
      refusals.push({
        code: 'test_without_name',
        message: 'A test was noted but its name could not be read, so nothing was put on the calendar for it.',
        detail: null,
      });
      continue;
    }

    if (!visitEvent) {
      // No visit date means no anchor. Rather than inventing one, the test is handed to
      // the user to date herself — which produces a 'manual' row, not a fabricated one.
      testsNeedingDate.push({
        index,
        name,
        category: test.category,
        evidence: test.verbatimInstruction ?? test.nameAsWritten,
      });
      continue;
    }

    proposals.push(
      ...deriveTestChain({
        anchor: visitEvent,
        test: { index, name, category: test.category },
        offsets,
        floor,
      }),
    );
  }

  return { proposals, refusals, testsNeedingDate };
}

/**
 * book → do → collect, chained backwards from an anchor.
 *
 * Exported so the manual path can reuse it: when the user picks a date for a test the
 * doctor gave no date for, that typed date becomes a 'manual' anchor and the same three
 * offsets hang off it. One implementation, so the offsets cannot drift apart.
 */
export function deriveTestChain(args: {
  /** The visit (transcribed) or a date the user typed (manual). */
  readonly anchor: Pick<ProposedCareEvent, 'key' | 'dueOn'>;
  readonly test: { readonly index: number; readonly name: string; readonly category: TestCategory };
  readonly offsets?: CareOffsets;
  /** Nothing is proposed before this date. Pass `today` (or the prescription date). */
  readonly floor: string;
}): ProposedCareEvent[] {
  const offsets = args.offsets ?? DEFAULT_CARE_OFFSETS;
  const turnaround = offsets.turnaroundDays[args.test.category] ?? DEFAULT_TEST_TURNAROUND_DAYS.other;
  const testKey = `test:${args.test.index}`;

  // Backwards from the visit: the report has to be in hand BEFORE the appointment, the
  // sample has to be given far enough ahead for the report to come back, and the slot has
  // to be booked before that.
  const collect = inferred({
    key: `${testKey}:collect`,
    kind: 'test_collect',
    title: `Collect the ${args.test.name} report`,
    anchor: args.anchor,
    offsetDays: -offsets.reportInHandDays,
    floor: args.floor,
    relatedTestKey: testKey,
    testName: args.test.name,
    reason: `${offsets.reportInHandDays} day before the visit, so the report is in hand for it`,
  });

  const doIt = inferred({
    key: `${testKey}:do`,
    kind: 'test_do',
    title: `Get the ${args.test.name} done`,
    anchor: collect,
    offsetDays: -turnaround,
    floor: args.floor,
    relatedTestKey: testKey,
    testName: args.test.name,
    reason:
      turnaround === 0
        ? 'the result is usually available on the day'
        : `reports of this kind usually take about ${turnaround} day${turnaround === 1 ? '' : 's'}`,
  });

  const book = inferred({
    key: `${testKey}:book`,
    kind: 'test_book',
    title: `Book the ${args.test.name}`,
    anchor: doIt,
    offsetDays: -offsets.testBookLeadDays,
    floor: args.floor,
    relatedTestKey: testKey,
    testName: args.test.name,
    reason: `${offsets.testBookLeadDays} days ahead, so there is time to get an appointment`,
  });

  // Emitted in the order they happen, which is the order the confirm screen lists them.
  return [book, doIt, collect];
}

// ── Visit resolution ─────────────────────────────────────────────────────────

export type VisitResolution =
  | { kind: 'none' }
  | { kind: 'resolved'; dueOn: string; evidence: string; derivation: string }
  | { kind: 'refused'; refusal: CalendarRefusal };

/**
 * The follow-up date, resolved from the follow-up instruction and the prescription date.
 *
 * Exported so `guards.ts` can re-derive it independently and refuse a visit date that
 * does not match. One implementation, checked twice: the guard is worthless if it shares
 * a bug with the thing it is guarding, and it is also worthless if it re-implements the
 * same arithmetic slightly differently.
 */
export function resolveFollowUpDate(
  followUp: ParsedFollowUp,
  prescribedOn: string | null,
): VisitResolution {
  return resolveVisit({ followUp, prescribedOn, testsAdvised: [], today: prescribedOn ?? '' });
}

function resolveVisit(input: CalendarInput): VisitResolution {
  const followUp = input.followUp;
  if (!followUp.present) return { kind: 'none' };

  // Evidence first. A follow-up with no quoted words behind it cannot be checked against
  // the photograph by the person confirming it, which makes it indistinguishable from an
  // invention. `care/guards.ts` refuses it too; refusing here as well means the user is
  // told about it rather than silently shown nothing.
  const evidence = followUp.verbatim;
  if (!evidence) {
    return {
      kind: 'refused',
      refusal: {
        code: 'follow_up_without_evidence',
        message:
          'A follow-up was reported but the words on the prescription could not be quoted, so no appointment was proposed.',
        detail: null,
      },
    };
  }

  if (followUp.absoluteDate) {
    return {
      kind: 'resolved',
      dueOn: followUp.absoluteDate,
      evidence,
      derivation: `the prescription gives the date: "${evidence}"`,
    };
  }

  const value = followUp.relativeValue;
  const unit = followUp.relativeUnit;
  if (!value || unit === 'unknown') {
    return {
      kind: 'refused',
      refusal: {
        code: 'follow_up_not_resolvable',
        message: `"${evidence}" could not be turned into a date, so nothing was put on the calendar. You can add a date yourself.`,
        detail: evidence,
      },
    };
  }

  // THE REFUSAL THAT MATTERS MOST. A relative instruction needs the date the prescription
  // was written. Anchoring it to today instead would be wrong by exactly as long as the
  // paper went unphotographed, and would look identical to a date the doctor gave.
  if (!input.prescribedOn) {
    return {
      kind: 'refused',
      refusal: {
        code: 'prescription_date_unknown',
        message: `The prescription says "${evidence}", but the date it was written could not be read — so there is nothing to count from. Add the date and this will work out on its own.`,
        detail: evidence,
      },
    };
  }

  const from = input.prescribedOn;
  switch (unit) {
    case 'day':
      return resolved(addDays(from, value), evidence, `${from} + ${value} day(s)`);
    case 'week':
      return resolved(addDays(from, value * 7), evidence, `${from} + ${value} week(s)`);
    case 'month':
      // addMonthsClamped, not "+30 days". "Review after 1 month" written on 31 January
      // is 28 (or 29) February, not 2 March.
      return resolved(
        addMonthsClamped(from, value),
        evidence,
        `${from} + ${value} month(s), clamped to the end of the month`,
      );
    case 'year':
      return resolved(
        addMonthsClamped(from, value * 12),
        evidence,
        `${from} + ${value} year(s), clamped to the end of the month`,
      );
    default:
      return {
        kind: 'refused',
        refusal: {
          code: 'follow_up_not_resolvable',
          message: `"${evidence}" could not be turned into a date, so nothing was put on the calendar.`,
          detail: evidence,
        },
      };
  }
}

function resolved(dueOn: string, evidence: string, arithmetic: string): VisitResolution {
  return { kind: 'resolved', dueOn, evidence, derivation: `"${evidence}" → ${arithmetic} = ${dueOn}` };
}

// ── Inferred rows ────────────────────────────────────────────────────────────

/**
 * One app-derived row: anchor + an offset WE chose, clamped out of the past.
 *
 * The clamp never moves the anchor itself (a transcribed date is the doctor's and is not
 * ours to recompute — `recomputeInferredDueDate` refuses that outright). It only pulls a
 * derived date forward to today, and says so, so that a prescription photographed a week
 * late does not produce a "book the test" reminder for last Tuesday.
 */
function inferred(args: {
  key: string;
  kind: CareEventKind;
  title: string;
  anchor: Pick<ProposedCareEvent, 'key' | 'dueOn'>;
  offsetDays: number;
  floor: string;
  relatedTestKey: string | null;
  testName: string | null;
  reason: string;
}): ProposedCareEvent {
  const raw = addDays(args.anchor.dueOn, args.offsetDays);
  let dueOn = raw;
  let adjustedNote: string | null = null;

  if (raw < args.floor) {
    // Cap at the anchor as well: pulling a "book it" reminder forward must never push it
    // past the day of the thing it is booking.
    dueOn = args.floor <= args.anchor.dueOn ? args.floor : args.anchor.dueOn;
    adjustedNote =
      dueOn === args.anchor.dueOn
        ? 'This date has already passed, so it is shown on the day itself.'
        : `Moved to ${dueOn}, because ${raw} has already passed.`;
  }

  const offsetDays = daysBetween(args.anchor.dueOn, dueOn);
  return {
    key: args.key,
    kind: args.kind,
    title: args.title,
    dueOn,
    anchorSource: 'inferred',
    anchorKey: args.anchor.key,
    offsetDays,
    relatedTestKey: args.relatedTestKey,
    testName: args.testName,
    evidence: null,
    // Always populated. An inferred date that cannot say where it came from is
    // indistinguishable from something the doctor said, which is the entire failure
    // `anchor_source` exists to prevent.
    derivation: `${args.anchor.dueOn} ${formatOffset(offsetDays)} — ${args.reason}`,
    adjusted: adjustedNote !== null,
    adjustedNote,
  };
}

function formatOffset(offsetDays: number): string {
  if (offsetDays === 0) return 'on the day';
  const magnitude = Math.abs(offsetDays);
  const unit = magnitude === 1 ? 'day' : 'days';
  return offsetDays < 0 ? `minus ${magnitude} ${unit}` : `plus ${magnitude} ${unit}`;
}

function laterOf(a: string, b: string | null): string {
  if (!b) return a;
  return a > b ? a : b;
}
