/**
 * The prescription pipeline's public surface.
 *
 * Everything is re-exported explicitly rather than with `export *`: the modules below
 * deliberately share vocabulary (`MAX_AI_DOSES_PER_DAY` belongs to the decoder and is
 * enforced by the confirmer), and a star export would let a future rename silently drop a
 * name that a screen imports through this file.
 *
 * The screens use `extractPrescription` and `confirmExtraction`. Everything else is here
 * because the review, reconcile and calendar screens each need one piece of it.
 */

// ── Reading a photograph ─────────────────────────────────────────────────────
export {
  MAX_PAGES,
  PROMPT_VERSION,
  PROVENANCE_KEY,
  RAW_RESPONSE_KEY,
  EXTRACTION_ENVELOPE_VERSION,
  PrescriptionExtractionError,
  buildStoredExtraction,
  capturePrescription,
  extractPrescription,
  isExtractionError,
  parseStoredPrescription,
  readStoredExtraction,
  runExtraction,
  type CaptureInput,
  type ExtractInput,
  type ExtractOutcome,
  type ExtractionProvenance,
  type StoredExtraction,
} from './extract';

// ── The contract with the model ──────────────────────────────────────────────
export {
  PRESCRIPTION_RESPONSE_SCHEMA,
  frequencyExpression,
  parsePrescriptionExtraction,
  parseStoredExtraction,
  type ConfidenceLevel,
  type DurationKind,
  type FoodRelation,
  type InstructionKind,
  type MedicineForm,
  type ParseResult,
  type ParseWarning,
  type ParsedDoseQuantity,
  type ParsedDuration,
  type ParsedFollowUp,
  type ParsedFrequency,
  type ParsedMedicine,
  type ParsedPrescription,
  type ParsedTest,
  type RelativeUnit,
  type Route,
  type TestCategory,
} from './schema';

export { PRESCRIPTION_PROMPT, buildPrescriptionPrompt } from './prompt';

// ── Indian dosing shorthand ──────────────────────────────────────────────────
//
// NO SLOT VOCABULARY IS EXPORTED FROM HERE ANY MORE. This block used to re-export a
// `SlotKey` and a `DEFAULT_SLOT_TIMES` that the decoder declared for itself — four names
// and four times that had drifted from the ones every screen actually uses, published
// under exactly the names the UI imports from `@/app/_shared/lib`. Nothing read them, but
// one autocomplete would have been enough to schedule a dose against times no user had
// ever seen. Slots now have exactly one home: `src/features/slots/registry.ts`.
export {
  ALL_DAYS_MASK,
  MAX_AI_DOSES_PER_DAY,
  decodeFrequency,
  frequencyLabelEn,
  type DecodedFrequency,
  type DecodedSlot,
  type FrequencyKind,
  type FrequencyNote,
} from './frequency';

// ── What the reading proposes, and why it sometimes proposes nothing ─────────
//
// A PROPOSAL IS NOT A CONFIRMATION. Nothing in this block writes a row or sets
// `confirmed_by_user_at`; it produces a proposition and the evidence for it, and the
// screen turns that into a question a human answers per medicine. The refusal arrays are
// exported so a screen can key its copy off them and fail the build on a code with no
// sentence in `en` and `hi`.
export {
  FOOD_REFUSALS,
  FREQUENCY_REFUSALS,
  isLowConfidence,
  proposeFoodRelation,
  proposeForMedicine,
  proposeFrequency,
  type EvidenceField,
  type FoodEvidence,
  type FoodProposal,
  type FoodRefusal,
  type FrequencyEvidence,
  type FrequencyProposal,
  type FrequencyRefusal,
  type MedicineProposal,
  type ProposedFoodRelation,
  type ProvenFoodEvidence,
  type ProvenFrequencyEvidence,
} from './propose';

// ── The gate that makes a proposal a question ────────────────────────────────
//
// The other half of the block above, and the half that actually holds the line. A proposal
// is only safe because the review screen seeds the number WITHOUT seeding acceptance, and
// refuses to let an unanswered one through. Those two rules live here rather than in the
// screen for one reason: nothing under `src/app/` can be loaded by `node --test`, so as
// long as they lived there the most dangerous edit in the feature was also the only one no
// gate could see. `reviewGate.test.ts` stands over them now.
export {
  MAX_DOSES_PER_DAY,
  blockingReason,
  parseDoses,
  seedFrequency,
  type BlockReason,
  type FrequencyAnswer,
  type FrequencySeed,
  type ReviewLine,
} from './reviewGate';

// ── The human sign-off ───────────────────────────────────────────────────────
export {
  confirmExtraction,
  type ConfirmInput,
  type ConfirmResult,
  type ConfirmedRow,
  type ManualReason,
  type ManualScheduleNeeded,
  type ReviewedMedicine,
  type ReviewedSchedule,
  type ReviewedSlot,
  type SkippedRow,
} from './confirm';

// ── Supersession ─────────────────────────────────────────────────────────────
export {
  applySupersession,
  buildSupersessionDiff,
  loadCurrentMedicines,
  normaliseDrugName,
  planSupersession,
  toIncoming,
  type AddedRow,
  type ApplyResult,
  type ChangedRow,
  type ContinuedRow,
  type CurrentMedicine,
  type FieldChange,
  type IncomingMedicine,
  type NotOnPrescriptionRow,
  type PlanResult,
  type PrescriptionDiff,
  type SupersessionMode,
  type SupersessionPlan,
  type SupersessionRefusal,
  type ThreadDecision,
} from './reconcile';
