/**
 * The care-calendar feature's public surface.
 *
 * The order below is the order the pipeline runs in, and it is worth reading as a
 * sequence: DERIVE proposals from a confirmed extraction, VALIDATE them against the
 * evidence, BUILD the confirm screen's model, and only then WRITE what the user accepted.
 * Nothing skips a step — `persist.ts` is the only module here that touches the database,
 * and it is documented as taking accepted rows only.
 */

// ── Derivation (pure) ────────────────────────────────────────────────────────
export {
  DEFAULT_CARE_OFFSETS,
  DEFAULT_TEST_TURNAROUND_DAYS,
  deriveCareCalendar,
  deriveTestChain,
  resolveFollowUpDate,
  type CalendarInput,
  type CalendarRefusal,
  type CalendarRefusalCode,
  type CareOffsets,
  type ProposedAnchorSource,
  type ProposedCalendar,
  type ProposedCareEvent,
  type TestNeedingDate,
  type VisitResolution,
} from './calendar';

// ── Refills (pure) ───────────────────────────────────────────────────────────
export {
  DEFAULT_REFILL_LEAD_DAYS,
  projectRefill,
  proposeRefill,
  type ProposedRefill,
  type RefillArithmetic,
  type RefillInput,
  type RefillProjection,
  type RefillWarning,
} from './refill';

// ── The gate (pure) ──────────────────────────────────────────────────────────
export {
  buildConfirmModel,
  validateProposedCalendar,
  type CalendarConfirmModel,
  type CalendarEvidence,
  type ConfirmRow,
  type Rejection,
  type RejectionCode,
  type ValidationResult,
} from './guards';

// ── Writing (the only module here that touches the database) ─────────────────
export {
  writeConfirmedCalendar,
  writeConfirmedRefill,
  writeUserDatedTest,
  type AcceptedCareRow,
  type WriteCalendarInput,
  type WriteCalendarResult,
  type WrittenRow,
} from './persist';

export {
  getCareOffsets,
  resetCareOffsets,
  setCareOffsets,
  type CareOffsetsPatch,
} from './settings';
