/**
 * Emergency card — `emergency_card`.
 *
 * This is the highest-stakes privacy surface in the app: it is the one screen designed
 * to be readable by a stranger, potentially without unlocking the phone. Everything on
 * it is opt-in PER LINE.
 *
 * `show_conditions` defaults to 0 — OFF — and that default is not a UX preference. As
 * the schema puts it: "a visible TB diagnosis on a lock screen carries real
 * consequences in India". A landlord, an employer, a neighbour or a relative reading a
 * diagnosis off a lock screen can cost someone their housing, their job or their
 * marriage, and none of that is undone by the fact that a paramedic might also have
 * found it useful. So a diagnosis reaches the card only when the patient herself turns
 * that line on, one line at a time. Any future code that flips a `show_*` default to 1
 * is making that decision on her behalf; it must not.
 *
 * `neutral_treatment_line` is the escape hatch that makes the OFF default liveable: it
 * lets her write "On regular treatment — please contact my doctor" and get the
 * clinically useful signal to a responder without naming the condition to everyone
 * else who picks up the phone. It is free text she authored, so it carries no
 * `show_*` flag — leaving it blank is how it stays off.
 *
 * SCHEMA NOTE: `emergency_card` has no `deleted_at_epoch` (so reads here filter
 * nothing), no `created_at_epoch` and no `lamport`; its primary key is `profile_id`.
 * The TABLES registry in _shared.ts already encodes all of that.
 */

import {
  createRecord,
  inTransaction,
  boolToInt,
  intToBool,
  queryFirst,
  upsertRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Types ────────────────────────────────────────────────────────────────────

export type EmergencyCard = {
  profileId: string;
  showName: boolean;
  showAge: boolean;
  showBloodGroup: boolean;
  showAllergies: boolean;
  showMedicines: boolean;
  /** Defaults to FALSE. See the file header before changing anything about this. */
  showConditions: boolean;
  /** e.g. "On regular treatment — contact my doctor". Says nothing about what. */
  neutralTreatmentLine: string | null;
  allergiesText: string | null;
};

export type EmergencyCardPatch = Partial<Omit<EmergencyCard, 'profileId'>>;

export type EmergencyCardField =
  | 'name'
  | 'age'
  | 'blood_group'
  | 'allergies'
  | 'medicines'
  | 'conditions'
  | 'treatment_note';

/**
 * A line carries a field key, not an English label. The app is bilingual and the card
 * is the surface most likely to be read by someone other than the user; localisation
 * belongs to the view, not to a value assembled in the data layer.
 */
export type EmergencyCardLine = {
  field: EmergencyCardField;
  value: string;
};

/** Everything the card could possibly display. What it actually displays is the flags' decision. */
export type EmergencyCardData = {
  name: string | null;
  age: number | null;
  bloodGroup: string | null;
  /** Optional override; falls back to the card's own `allergiesText`. */
  allergies?: string | null;
  medicineNames: readonly string[];
  conditionLabels: readonly string[];
};

type EmergencyCardRow = {
  profile_id: string;
  show_name: number;
  show_age: number;
  show_blood_group: number;
  show_allergies: number;
  show_medicines: number;
  show_conditions: number;
  neutral_treatment_line: string | null;
  allergies_text: string | null;
};

const CARD_COLUMNS =
  'profile_id, show_name, show_age, show_blood_group, show_allergies, show_medicines, ' +
  'show_conditions, neutral_treatment_line, allergies_text';

/** Mirrors the column defaults in migrations.ts exactly — including conditions OFF. */
const CARD_DEFAULTS = {
  show_name: 1,
  show_age: 1,
  show_blood_group: 1,
  show_allergies: 1,
  show_medicines: 1,
  show_conditions: 0,
  neutral_treatment_line: null,
  allergies_text: null,
} as const satisfies Record<string, Bind>;

function mapCard(row: EmergencyCardRow): EmergencyCard {
  return {
    profileId: row.profile_id,
    showName: intToBool(row.show_name),
    showAge: intToBool(row.show_age),
    showBloodGroup: intToBool(row.show_blood_group),
    showAllergies: intToBool(row.show_allergies),
    showMedicines: intToBool(row.show_medicines),
    showConditions: intToBool(row.show_conditions),
    neutralTreatmentLine: row.neutral_treatment_line,
    allergiesText: row.allergies_text,
  };
}

// ── Reads & writes ───────────────────────────────────────────────────────────

export async function getEmergencyCard(profileId: string, tx?: Tx): Promise<EmergencyCard | null> {
  const row = await queryFirst<EmergencyCardRow>(
    `SELECT ${CARD_COLUMNS} FROM emergency_card WHERE profile_id = ?;`,
    [profileId],
    tx,
  );
  return row ? mapCard(row) : null;
}

/**
 * Returns the card, creating it with the schema's defaults if it does not exist.
 *
 * Read and create share ONE transaction so two callers opening the emergency screen at
 * once cannot both decide the row is missing and race to insert it.
 */
export async function getOrCreateEmergencyCard(profileId: string, tx?: Tx): Promise<EmergencyCard> {
  return inTransaction(async (t) => {
    const existing = await getEmergencyCard(profileId, t);
    if (existing) return existing;

    await createRecord('emergency_card', { profile_id: profileId, ...CARD_DEFAULTS }, t);
    const created = await getEmergencyCard(profileId, t);
    if (!created) {
      throw new Error(`emergency_card for ${profileId} vanished immediately after insert`);
    }
    return created;
  }, tx);
}

/** Applies a partial change and returns the card as it now stands. */
export async function updateEmergencyCard(
  profileId: string,
  patch: EmergencyCardPatch,
  tx?: Tx,
): Promise<EmergencyCard> {
  return inTransaction(async (t) => {
    // Materialise first so the insert path uses CARD_DEFAULTS in full rather than
    // whatever subset of columns this particular patch happens to mention — a patch of
    // only `allergiesText` must not be what decides where `show_conditions` lands.
    await getOrCreateEmergencyCard(profileId, t);

    const values: Record<string, Bind> = { profile_id: profileId };
    if (patch.showName !== undefined) values['show_name'] = boolToInt(patch.showName);
    if (patch.showAge !== undefined) values['show_age'] = boolToInt(patch.showAge);
    if (patch.showBloodGroup !== undefined) {
      values['show_blood_group'] = boolToInt(patch.showBloodGroup);
    }
    if (patch.showAllergies !== undefined) values['show_allergies'] = boolToInt(patch.showAllergies);
    if (patch.showMedicines !== undefined) values['show_medicines'] = boolToInt(patch.showMedicines);
    if (patch.showConditions !== undefined) {
      values['show_conditions'] = boolToInt(patch.showConditions);
    }
    if (patch.neutralTreatmentLine !== undefined) {
      values['neutral_treatment_line'] = patch.neutralTreatmentLine;
    }
    if (patch.allergiesText !== undefined) values['allergies_text'] = patch.allergiesText;

    if (Object.keys(values).length > 1) {
      await upsertRecord('emergency_card', values, t);
    }

    const updated = await getEmergencyCard(profileId, t);
    if (!updated) {
      throw new Error(`emergency_card for ${profileId} missing after update`);
    }
    return updated;
  }, tx);
}

// ── Pure rendering ───────────────────────────────────────────────────────────

/**
 * The redacted view. This is the ONLY shape the line assembler is allowed to see, and
 * it is produced in exactly one place — so a field whose flag is 0 is not "skipped
 * later", it is absent from the data the renderer works with. There is no branch
 * downstream that could reach past a flag, because there is nothing downstream to
 * reach into.
 */
type VisibleEmergencyData = {
  name: string | null;
  age: number | null;
  bloodGroup: string | null;
  allergies: string | null;
  medicines: readonly string[];
  conditions: readonly string[];
  treatmentNote: string | null;
};

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanList(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v.length > 0);
}

function redact(card: EmergencyCard, data: EmergencyCardData): VisibleEmergencyData {
  return {
    name: card.showName ? cleanText(data.name) : null,
    age: card.showAge ? data.age : null,
    bloodGroup: card.showBloodGroup ? cleanText(data.bloodGroup) : null,
    allergies: card.showAllergies ? cleanText(data.allergies ?? card.allergiesText) : null,
    medicines: card.showMedicines ? cleanList(data.medicineNames) : [],
    conditions: card.showConditions ? cleanList(data.conditionLabels) : [],
    // No flag of its own: she wrote this line specifically for this card, so writing it
    // IS the opt-in and clearing it is how it goes away.
    treatmentNote: cleanText(card.neutralTreatmentLine),
  };
}

function assemble(visible: VisibleEmergencyData): EmergencyCardLine[] {
  const lines: EmergencyCardLine[] = [];

  if (visible.name) lines.push({ field: 'name', value: visible.name });
  if (visible.age !== null && Number.isFinite(visible.age) && visible.age >= 0) {
    lines.push({ field: 'age', value: String(Math.floor(visible.age)) });
  }
  if (visible.bloodGroup) lines.push({ field: 'blood_group', value: visible.bloodGroup });
  // Allergies sit above medicines: it is the line a responder acts on before giving
  // anything, and the one whose absence does harm fastest.
  if (visible.allergies) lines.push({ field: 'allergies', value: visible.allergies });
  if (visible.medicines.length > 0) {
    lines.push({ field: 'medicines', value: visible.medicines.join(', ') });
  }
  if (visible.conditions.length > 0) {
    lines.push({ field: 'conditions', value: visible.conditions.join(', ') });
  }
  if (visible.treatmentNote) {
    lines.push({ field: 'treatment_note', value: visible.treatmentNote });
  }

  return lines;
}

/**
 * Builds the card's display lines, honouring every flag. Pure: no DB, no clock, no
 * device state, so the redaction rules can be tested exhaustively on their own.
 */
export function buildEmergencyCardLines(
  card: EmergencyCard,
  data: EmergencyCardData,
): EmergencyCardLine[] {
  return assemble(redact(card, data));
}
