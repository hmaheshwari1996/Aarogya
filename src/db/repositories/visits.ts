/**
 * Visits and the questions taken into them — `visit_log` + `visit_question`.
 *
 * A visit_log row is a plain record of "I saw this doctor on this day". The questions
 * are the part that matters: an OPD appointment in a government hospital can be four
 * minutes long, and a written list is the difference between asking and forgetting.
 *
 * NOTE: `visit_question` has NO `lamport` column (see TABLES in _shared.ts). The
 * write helpers already know that; do not add one here.
 */

import {
  createRecord,
  inTransaction,
  intToBool,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
  type Bind,
  type Tx,
} from './_shared';

// ── Types ────────────────────────────────────────────────────────────────────

export type VisitLog = {
  id: string;
  profileId: string;
  /** 'YYYY-MM-DD'. */
  visitedOn: string;
  doctor: string | null;
  clinic: string | null;
  notes: string | null;
  prescriptionId: string | null;
};

/**
 * Who authored the question.
 *
 * 'user' — she typed it.
 * 'auto' — the APP composed it from something it noticed (an unexplained run of high
 *          evening readings, a medicine stopped without a reason). An 'auto' question
 *          MUST be rendered visibly differently from a 'user' one, and must stay
 *          editable and dismissable, because the alternative is the app putting words
 *          in her mouth in front of her doctor. She should never have to defend a
 *          sentence she did not write, and a doctor reading the list is entitled to
 *          know which lines came from the patient.
 */
export type QuestionOrigin = 'user' | 'auto';

export type VisitQuestion = {
  id: string;
  profileId: string;
  /** Null until the question is attached to a specific visit. */
  visitId: string | null;
  text: string;
  origin: QuestionOrigin;
  answered: boolean;
  answerText: string | null;
};

export type CreateVisitInput = {
  profileId: string;
  visitedOn: string;
  doctor?: string | null;
  clinic?: string | null;
  notes?: string | null;
  prescriptionId?: string | null;
};

export type VisitPatch = {
  visitedOn?: string;
  doctor?: string | null;
  clinic?: string | null;
  notes?: string | null;
  prescriptionId?: string | null;
};

export type ListQuestionsOptions = {
  /**
   * Filter by visit. A string matches that visit; an explicit `null` matches the
   * questions not yet attached to any visit — the running list she adds to between
   * appointments. Omit the key entirely for "all questions".
   */
  visitId?: string | null;
  unansweredOnly?: boolean;
};

type VisitRow = {
  id: string;
  profile_id: string;
  visited_on: string;
  doctor: string | null;
  clinic: string | null;
  notes: string | null;
  prescription_id: string | null;
};

type QuestionRow = {
  id: string;
  profile_id: string;
  visit_id: string | null;
  text: string;
  origin: string;
  answered: number;
  answer_text: string | null;
};

const VISIT_COLUMNS = 'id, profile_id, visited_on, doctor, clinic, notes, prescription_id';
const QUESTION_COLUMNS = 'id, profile_id, visit_id, text, origin, answered, answer_text';

function mapVisit(row: VisitRow): VisitLog {
  return {
    id: row.id,
    profileId: row.profile_id,
    visitedOn: row.visited_on,
    doctor: row.doctor,
    clinic: row.clinic,
    notes: row.notes,
    prescriptionId: row.prescription_id,
  };
}

function mapQuestion(row: QuestionRow): VisitQuestion {
  return {
    id: row.id,
    profileId: row.profile_id,
    visitId: row.visit_id,
    text: row.text,
    // The CHECK constraint guarantees the column holds one of the two values; the cast
    // narrows the driver's `string` without pretending to validate anything.
    origin: row.origin === 'auto' ? 'auto' : 'user',
    answered: intToBool(row.answered),
    answerText: row.answer_text,
  };
}

// ── Visits ───────────────────────────────────────────────────────────────────

export async function listVisits(profileId: string, tx?: Tx): Promise<VisitLog[]> {
  const rows = await queryAll<VisitRow>(
    `SELECT ${VISIT_COLUMNS} FROM visit_log
      WHERE profile_id = ? AND deleted_at_epoch IS NULL
      ORDER BY visited_on DESC, created_at_epoch DESC;`,
    [profileId],
    tx,
  );
  return rows.map(mapVisit);
}

export async function getVisit(id: string, tx?: Tx): Promise<VisitLog | null> {
  const row = await queryFirst<VisitRow>(
    `SELECT ${VISIT_COLUMNS} FROM visit_log
      WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapVisit(row) : null;
}

export async function createVisit(input: CreateVisitInput, tx?: Tx): Promise<string> {
  return createRecord(
    'visit_log',
    {
      profile_id: input.profileId,
      visited_on: input.visitedOn,
      doctor: input.doctor ?? null,
      clinic: input.clinic ?? null,
      notes: input.notes ?? null,
      prescription_id: input.prescriptionId ?? null,
    },
    tx,
  );
}

export async function updateVisit(id: string, patch: VisitPatch, tx?: Tx): Promise<void> {
  const values: Record<string, Bind> = {};
  if (patch.visitedOn !== undefined) values['visited_on'] = patch.visitedOn;
  if (patch.doctor !== undefined) values['doctor'] = patch.doctor;
  if (patch.clinic !== undefined) values['clinic'] = patch.clinic;
  if (patch.notes !== undefined) values['notes'] = patch.notes;
  if (patch.prescriptionId !== undefined) values['prescription_id'] = patch.prescriptionId;
  if (Object.keys(values).length === 0) return;
  await updateRecord('visit_log', id, values, tx);
}

/**
 * Soft-deletes the visit only. Its questions keep their `visit_id` and are left
 * alone: they were still asked, and a mistyped visit date should not silently take
 * the list of questions with it.
 */
export async function deleteVisit(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('visit_log', id, tx);
}

// ── Questions ────────────────────────────────────────────────────────────────

/** Oldest first — the order she thought of them is the order she wants to ask them. */
export async function listQuestions(
  profileId: string,
  options: ListQuestionsOptions = {},
  tx?: Tx,
): Promise<VisitQuestion[]> {
  const where = ['profile_id = ?', 'deleted_at_epoch IS NULL'];
  const params: Bind[] = [profileId];

  if (options.visitId !== undefined) {
    if (options.visitId === null) {
      where.push('visit_id IS NULL');
    } else {
      where.push('visit_id = ?');
      params.push(options.visitId);
    }
  }
  if (options.unansweredOnly) {
    where.push('answered = 0');
  }

  const rows = await queryAll<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM visit_question
      WHERE ${where.join(' AND ')}
      ORDER BY created_at_epoch ASC;`,
    params,
    tx,
  );
  return rows.map(mapQuestion);
}

export async function getQuestion(id: string, tx?: Tx): Promise<VisitQuestion | null> {
  const row = await queryFirst<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM visit_question
      WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapQuestion(row) : null;
}

/**
 * `origin` is an explicit argument rather than always 'user' because the app itself
 * needs to be able to add prompts — but it defaults to 'user' so that a caller who
 * forgets to think about it cannot accidentally label her own words as generated.
 */
export async function addQuestion(
  profileId: string,
  text: string,
  visitId?: string | null,
  origin: QuestionOrigin = 'user',
  tx?: Tx,
): Promise<string> {
  return createRecord(
    'visit_question',
    {
      profile_id: profileId,
      visit_id: visitId ?? null,
      text,
      origin,
      answered: 0,
      answer_text: null,
    },
    tx,
  );
}

/** Records what the doctor said. Answering is what marks a question done. */
export async function answerQuestion(id: string, answerText: string, tx?: Tx): Promise<void> {
  await updateRecord('visit_question', id, { answered: 1, answer_text: answerText }, tx);
}

export async function deleteQuestion(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('visit_question', id, tx);
}

/**
 * Attaches a batch of loose questions to one visit, all or nothing.
 *
 * One transaction because a half-attached list is worse than an unattached one: she
 * walks into the room believing the screen is showing everything she wanted to ask,
 * and the three questions that failed to attach are simply not there.
 */
export async function attachQuestionsToVisit(
  questionIds: readonly string[],
  visitId: string,
  tx?: Tx,
): Promise<void> {
  if (questionIds.length === 0) return;
  await inTransaction(async (t) => {
    for (const questionId of questionIds) {
      await updateRecord('visit_question', questionId, { visit_id: visitId }, t);
    }
  }, tx);
}
