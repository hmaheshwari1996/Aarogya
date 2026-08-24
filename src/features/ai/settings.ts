/**
 * Which model reads the prescription, and how hard it is allowed to think.
 *
 * Stored in `app_meta` rather than in a new table: this is three strings of device-local
 * preference, it has no history worth keeping, and adding a migration for it would put a
 * schema change in the path of a settings toggle.
 *
 * NOTHING HERE IS CLINICAL. Changing the model changes cost and accuracy of the
 * TRANSCRIPTION step only. It cannot change what the app is allowed to schedule, because
 * every medicine and every schedule still has to pass a human confirmation the database
 * itself enforces (`trg_occ_requires_confirmed_medicine` / `..._schedule`).
 */

import { getDb, inTransaction, queryFirst, type Tx } from '../../db/repositories/_shared';

export type AiProviderId = 'gemini';

/** How much reasoning to buy. Gemini 3 replaced `thinkingBudget` with this. */
export type ThinkingLevel = 'low' | 'high';

export type AiModel = {
  readonly id: string;
  readonly providerId: AiProviderId;
  readonly labelEn: string;
  /** One line the settings screen can show under the name. */
  readonly noteEn: string;
};

/**
 * Model ids current as of August 2026.
 *
 * The 2.5 family is NOT deprecated despite what several widely-linked blog posts claim;
 * only `gemini-2.5-flash-image` carries a shutdown date, and this app never used it. The
 * list below is therefore a choice between cost and accuracy, not a migration deadline.
 */
export const AI_MODELS: readonly AiModel[] = [
  {
    id: 'gemini-3.6-flash',
    providerId: 'gemini',
    labelEn: 'Standard',
    noteEn: 'The default. Best balance of accuracy and cost on handwriting.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    providerId: 'gemini',
    labelEn: 'Cheapest',
    noteEn: 'Fastest and cheapest. Good on printed prescriptions, weaker on handwriting.',
  },
  {
    id: 'gemini-3.1-pro-preview',
    providerId: 'gemini',
    labelEn: 'Most careful',
    noteEn: 'Slowest and dearest. Worth trying on a prescription the others struggle with.',
  },
] as const;

/**
 * NO AUTOMATIC FALLBACK TO A SECOND MODEL. Considered, and deliberately not built.
 *
 * The tempting version is: after two 503s from `DEFAULT_MODEL_ID`, quietly try
 * `gemini-3.5-flash-lite` instead. Three separate reasons it is not here.
 *
 *  1. A 503 IS NOT EVIDENCE ABOUT THE MODEL ID. `service_overloaded` is what a real,
 *     existing, currently-busy model returns. A model id that is wrong — rolled back,
 *     renamed, or not enabled for this key — comes back as 404 and already has its own
 *     code (`model_not_found`), its own sentence and its own next step: pick another one
 *     in Settings. Treating a 503 as a hint about the id would mean acting on a symptom
 *     that cannot distinguish the two cases.
 *
 *  2. THE FALLBACK IS THE WEAKER READER. `flash-lite`'s own note here says it is weaker on
 *     handwriting, and handwriting is the entire difficulty of an Indian OPD prescription.
 *     Silently swapping in a less accurate transcriber to avoid a fifteen-second wait
 *     trades a delay the user can see for an inaccuracy she cannot — on a screen whose
 *     output is a list of medicines. Waiting is the better failure.
 *
 *  3. NOBODY WOULD KNOW IT HAPPENED. She picked a reader in Settings. An app that uses a
 *     different one without saying so makes "Most careful" a label that is sometimes true.
 *
 * If a model is later found to 503 persistently while another does not, the honest form of
 * this is a VISIBLE offer after the retries are exhausted — "the standard reader is busy;
 * try the cheaper one?" — with her tapping it. That belongs on the scan screen, not in a
 * silent branch of a network layer.
 */
export const DEFAULT_PROVIDER_ID: AiProviderId = 'gemini';
export const DEFAULT_MODEL_ID = 'gemini-3.6-flash';

/**
 * The cheap model, used by `testKey()` and nothing else.
 *
 * Verifying a key must not cost what a real scan costs, or nobody will verify it — and an
 * unverified key fails for the first time in a clinic corridor, which is the one place it
 * must not.
 */
export const KEY_TEST_MODEL_ID = 'gemini-3.5-flash-lite';

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export type AiSettings = {
  readonly providerId: AiProviderId;
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  providerId: DEFAULT_PROVIDER_ID,
  modelId: DEFAULT_MODEL_ID,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
};

const KEY_PROVIDER = 'ai.provider';
const KEY_MODEL = 'ai.model';
const KEY_THINKING = 'ai.thinkingLevel';

async function readMeta(key: string, tx?: Tx): Promise<string | null> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [key],
    tx,
  );
  return row?.value ?? null;
}

async function writeMeta(key: string, value: string, tx?: Tx): Promise<void> {
  // `app_meta` is a plain key/value store with no lamport, no soft delete and no outbox
  // row, so it is written directly rather than through createRecord(). It is device-local
  // preference — syncing "which model this handset uses" to a family member's phone would
  // be meaningless there.
  await inTransaction(async (t) => {
    await t.db.runAsync(
      `INSERT INTO app_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [key, value],
    );
  }, tx);
}

function isKnownModel(id: string | null): id is string {
  return id !== null && AI_MODELS.some((m) => m.id === id);
}

/**
 * Never throws and never blocks a screen.
 *
 * A missing row, a corrupt value, or a database that has not finished migrating all
 * resolve to the defaults. The scan path can then fail on the one thing that genuinely
 * stops it — a missing key — instead of on a settings read.
 */
export async function getAiSettings(tx?: Tx): Promise<AiSettings> {
  try {
    await getDb();
    const [provider, model, thinking] = await Promise.all([
      readMeta(KEY_PROVIDER, tx),
      readMeta(KEY_MODEL, tx),
      readMeta(KEY_THINKING, tx),
    ]);
    return {
      providerId: provider === 'gemini' ? 'gemini' : DEFAULT_PROVIDER_ID,
      // An unknown model id means a build that offered it was rolled back, or the row was
      // hand-edited. Falling back to the default is better than sending a 404 to the API
      // and reporting "model not found" to someone who never chose a model.
      modelId: isKnownModel(model) ? model : DEFAULT_MODEL_ID,
      thinkingLevel: thinking === 'low' || thinking === 'high' ? thinking : DEFAULT_THINKING_LEVEL,
    };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export async function setAiModel(modelId: string, tx?: Tx): Promise<void> {
  const model = AI_MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown AI model: ${modelId}`);
  await writeMeta(KEY_MODEL, model.id, tx);
  await writeMeta(KEY_PROVIDER, model.providerId, tx);
}

export async function setThinkingLevel(level: ThinkingLevel, tx?: Tx): Promise<void> {
  await writeMeta(KEY_THINKING, level, tx);
}

export function modelById(id: string): AiModel | null {
  return AI_MODELS.find((m) => m.id === id) ?? null;
}
