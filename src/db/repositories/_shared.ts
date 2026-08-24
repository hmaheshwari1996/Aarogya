/**
 * Shared write plumbing for every repository.
 *
 * Four invariants live here rather than being retyped (and eventually mistyped) in
 * sixteen repository modules:
 *
 *  1. EVERY value is bound, never interpolated. Only column and table NAMES are ever
 *     spliced into SQL, and `assertIdentifier` proves they are identifiers first — so
 *     even a future caller that passes a user-supplied "column" cannot inject.
 *
 *  2. EVERY write stamps `updated_at_epoch`, bumps `lamport`, and enqueues a
 *     `sync_outbox` row. L3 (family sync) is not a rewrite of this layer, it is a
 *     consumer of the outbox that already exists on day one. Tables that lack a
 *     lamport or updated_at column (see TABLES) simply skip that column — the outbox
 *     row is still written, because the row still needs to travel.
 *
 *  3. DELETE is always soft. Hard DELETE on reading/symptom_event/lab_result is
 *     refused by a database trigger, and the rest of the schema is soft-deleted by
 *     convention so that a family member's device can learn about the deletion.
 *
 *  4. Transactions are EXPLICIT and serialised. `Tx` is passed down by hand instead of
 *     being inferred from a module-level "are we in a transaction?" flag, because
 *     React Native has no AsyncLocalStorage: a global flag cannot tell "reconcile
 *     called me" apart from "the UI happened to save a reading while reconcile was
 *     mid-flight", and the second case would silently enrol an unrelated write into
 *     reconcile's transaction and roll it back on an unrelated failure.
 */

import type * as SQLite from 'expo-sqlite';

import { openDatabase } from '../index';
import { newId } from '../../lib/ids';

/** Everything SQLite can bind. Booleans are converted to 0/1 before they get here. */
export type Bind = string | number | null;

/**
 * A handle to an OPEN transaction. Repository functions take `tx?: Tx` as their last
 * argument; passing one enrols the write in the caller's transaction, omitting one
 * gives the write its own. There is no way to fake this object by accident.
 */
export type Tx = {
  readonly db: SQLite.SQLiteDatabase;
  readonly __transaction: true;
};

// ── Table registry ───────────────────────────────────────────────────────────
// Which metadata columns each table actually has. Driving the writers from data
// instead of from hand-written SQL per table is what stops "no such column:
// lamport" appearing at runtime on a table that never had one (contact, document,
// visit_question, badge, emergency_card all lack it).

type TableSpec = {
  /** Primary key column. */
  readonly pk: string;
  readonly hasCreatedAt: boolean;
  readonly hasUpdatedAt: boolean;
  readonly hasLamport: boolean;
  readonly hasSoftDelete: boolean;
  /**
   * Whether writes to this table belong in the sync outbox.
   *
   * `dose_occurrence`, `delivery_probe` and `health_check_result` are FALSE on
   * purpose. Occurrences are a derived cache that every device rebuilds from
   * medicines + schedules + events; syncing them would ship a second, disagreeing
   * copy of a truth we already sync. Probes and health checks are about one
   * device's OEM behaviour and mean nothing on another handset.
   *
   * `document` and `pending_file_delete` are FALSE for a second, stronger reason:
   * a screen PROMISED they would be, in words, to the user. See the note on each.
   * A `sync` flag here is not a performance decision — it is the machine-readable
   * half of a sentence somebody read on a screen and believed.
   *
   * WHERE THIS FLAG IS READ, IN THE ORDER A ROW MEETS THEM:
   *   1. `enqueueOutbox` (write time) — an unsynced table never enters the queue.
   *   2. `buildPayload` in `features/sync/outbox.ts` (drain time) — a queued `upsert`
   *      on an unsynced table is dropped rather than pushed, so a row that got in
   *      before the flag changed cannot get out afterwards. A `delete` is deliberately
   *      still sent: retraction must not be blocked by the flag that stopped the
   *      publishing.
   *   3. `republishRecords` — skipped entirely on rotation.
   *
   * TRAP, AND IT IS THE ONE THAT COST A MIGRATION: none of those can un-send what has
   * ALREADY been pushed. Turning a table off stops the tap and now also empties the
   * bucket, but the server keeps whatever it was given. Changing `true` → `false` on a
   * table that has ever shipped therefore still needs a migration to queue the
   * tombstones. See v5, which does that for `document`.
   *
   * `sync: true` IS A DECISION ABOUT THE TABLE, NOT ABOUT EVERY COLUMN IN IT. The drain
   * reads rows with `SELECT *`, so a column added to a syncing table starts travelling
   * with no further decision — and five of them should never have. A local file path is
   * removed before sealing by `stripLocalPaths()` in `features/sync/redact.ts`, which
   * decides on the COLUMN NAME and therefore covers a `*_uri` column that does not exist
   * yet. Adding a column here that must not leave the phone and is NOT named for a path
   * is a new decision, and this is the comment it belongs under. v6 retracts the paths
   * that were published before the strip existed.
   */
  readonly sync: boolean;
};

export const TABLES = {
  profile: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  reading: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  record_edit: { pk: 'id', hasCreatedAt: false, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: true },
  target_range: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  prescription: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  medicine: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  dose_schedule: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  dose_occurrence: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: false, sync: false },
  dose_event: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: false, hasLamport: true, hasSoftDelete: false, sync: true },
  dose_event_quarantine: { pk: 'id', hasCreatedAt: false, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: false },
  med_change_event: { pk: 'id', hasCreatedAt: false, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: true },
  medicine_stock: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  symptom_event: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  lab_result: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  care_event: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  visit_log: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: true, hasSoftDelete: true, sync: true },
  visit_question: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: true, sync: true },
  contact: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: true, sync: true },
  // The briefcase. NOT synced, and the reason is a promise the app makes in words: the
  // top of `src/app/briefcase/index.tsx` says "These papers live only on this phone —
  // not on Google, not on any cloud, not on another phone", undismissably, above the
  // list. A `document` row is `title`, `original_file_name`, `mime_type`, `size_bytes`
  // and `file_uri`; sealing that into `sync_record` puts the NAME of every paper she
  // keeps — 'AXIS-DISCHARGE-2024-11.pdf', 'TB DOTS card' — on a server, and in front of
  // whoever holds the link, which is exactly what that sentence says does not happen.
  //
  // It would also be pointless if it were harmless: like `pending_file_delete` below,
  // the row describes ONE handset's filesystem. `file_uri` names a path inside this
  // install's private data directory — a directory Android renumbers on reinstall — so
  // the row arrives on a family member's phone naming a file that has never existed
  // there, and the viewer has no screen that reads it (`src/app/(viewer)/saved.tsx`
  // reads the LOCAL document table, and the sealed snapshot in features/sync/snapshot.ts
  // carries no documents at all, deliberately: "No photographs", docs/SYNC-AND-BACKUP.md §17).
  //
  // Flipping this flag stops NEW rows being enqueued. It does not retract rows already
  // queued or already pushed, because `drainOutbox` never re-reads this registry — see
  // migration v5, which does the retracting.
  document: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: true, sync: false },
  emergency_card: { pk: 'profile_id', hasCreatedAt: false, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: false, sync: true },
  profile_condition: { pk: 'profile_id', hasCreatedAt: true, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: true },
  profile_metric: { pk: 'profile_id', hasCreatedAt: true, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: true },
  streak_state: { pk: 'profile_id', hasCreatedAt: false, hasUpdatedAt: true, hasLamport: false, hasSoftDelete: false, sync: false },
  badge: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: true },
  delivery_probe: { pk: 'id', hasCreatedAt: true, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: false },
  // Files whose row has been removed but whose bytes are still on this disk. No
  // created_at (it carries `requested_at_epoch`, which is the same fact under a name that
  // says what it is for), no lamport, and NOT synced: it describes one handset's
  // filesystem, and shipping "delete /data/user/0/…/briefcase/abc.pdf" to a family
  // member's phone would name a file that never existed there.
  pending_file_delete: { pk: 'id', hasCreatedAt: false, hasUpdatedAt: false, hasLamport: false, hasSoftDelete: false, sync: false },
} as const satisfies Record<string, TableSpec>;

export type TableName = keyof typeof TABLES;

// ── Connection & clock ───────────────────────────────────────────────────────

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  return openDatabase();
}

/** Single clock source, so tests can reason about "now" and code never drifts apart. */
export function nowEpoch(): number {
  return Date.now();
}

// ── Identifier safety ────────────────────────────────────────────────────────

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Column and table names cannot be bound as parameters, so they are the one thing
 * spliced into SQL. Proving they are plain identifiers keeps that splice safe even
 * if a caller ever builds a column list from something less trustworthy than a
 * string literal.
 */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

// ── Transactions ─────────────────────────────────────────────────────────────

/**
 * Serialises top-level transactions. expo-sqlite hands out ONE connection, so two
 * overlapping `BEGIN`s on it are not two transactions — they are one transaction
 * with two owners, and whichever finishes first commits the other's half-written
 * work. The queue makes overlap impossible instead of merely unlikely.
 */
let transactionQueue: Promise<unknown> = Promise.resolve();

export async function inTransaction<T>(
  work: (tx: Tx) => Promise<T>,
  existing?: Tx,
): Promise<T> {
  if (existing) return work(existing);

  const run = async (): Promise<T> => {
    const db = await getDb();
    const tx: Tx = { db, __transaction: true };
    // IMMEDIATE takes the write lock up front. Deferred BEGIN would let a read-only
    // start upgrade mid-transaction and fail with SQLITE_BUSY after work is done.
    await db.execAsync('BEGIN IMMEDIATE;');
    try {
      const result = await work(tx);
      await db.execAsync('COMMIT;');
      return result;
    } catch (error) {
      try {
        await db.execAsync('ROLLBACK;');
      } catch {
        // A failed ROLLBACK almost always means the transaction was already aborted
        // by SQLite (a trigger RAISE(ABORT) does exactly this). Swallow it so the
        // ORIGINAL error is what the caller sees, not the rollback noise.
      }
      throw error;
    }
  };

  const gated = transactionQueue.then(run, run);
  // The queue must never reject, or every later transaction inherits the failure.
  transactionQueue = gated.then(
    () => undefined,
    () => undefined,
  );
  return gated;
}

// ── Lamport clock ────────────────────────────────────────────────────────────

/**
 * A single monotonic counter in `app_meta`, not a per-row increment.
 *
 * A per-row counter answers "how many times did THIS row change", which is not the
 * question sync asks. Sync asks "what changed since I last looked", and only a
 * counter shared by every table can order a medicine edit against the dose event
 * that followed it. It also guarantees the `sync_outbox` UNIQUE(table,row,lamport)
 * constraint is never hit by two writes to the same row in the same millisecond.
 */
export async function nextLamport(tx: Tx): Promise<number> {
  return bumpLamport(tx);
}

/**
 * Skips the clock entirely for tables that neither store a lamport nor sync.
 *
 * `dose_occurrence` is the reason. A reconcile over a fifteen-medicine profile
 * materialises several hundred rows in one transaction, and charging each one a
 * read-modify-write against `app_meta` turns an instant operation into a visible
 * stall on a Go-class device — for a counter no consumer of that table reads.
 */
async function lamportFor(tx: Tx, spec: TableSpec): Promise<number> {
  if (!spec.hasLamport && !spec.sync) return 0;
  return bumpLamport(tx);
}

async function bumpLamport(tx: Tx): Promise<number> {
  const row = await tx.db.getFirstAsync<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = 'lamport';`,
  );
  const next = (row?.value ? Number(row.value) : 0) + 1;
  await tx.db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES ('lamport', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [String(next)],
  );
  return next;
}

// ── Outbox ───────────────────────────────────────────────────────────────────

export async function enqueueOutbox(
  tx: Tx,
  table: TableName,
  rowId: string,
  op: 'upsert' | 'delete',
  lamport: number,
): Promise<void> {
  if (!TABLES[table].sync) return;
  // OR IGNORE covers the replay case: re-running a reconcile that already enqueued
  // this exact (table,row,lamport) must not fail the whole transaction.
  await tx.db.runAsync(
    `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, ?);`,
    [newId(), table, rowId, op, lamport, nowEpoch()],
  );
}

// ── Generic writers ──────────────────────────────────────────────────────────

/**
 * Insert one row, stamped and enqueued.
 *
 * `values` carries only the table's own columns; created_at/updated_at/lamport are
 * added here from the registry so no caller can forget one.
 */
export async function createRecord(
  table: TableName,
  values: Record<string, Bind>,
  tx?: Tx,
  options?: { readonly orIgnore?: boolean; readonly orReplace?: boolean },
): Promise<string> {
  const spec = TABLES[table];
  return inTransaction(async (t) => {
    const lamport = await lamportFor(t, spec);
    const at = nowEpoch();

    const row: Record<string, Bind> = { ...values };
    if (row[spec.pk] === undefined || row[spec.pk] === null) {
      row[spec.pk] = newId();
    }
    if (spec.hasCreatedAt && row['created_at_epoch'] === undefined) row['created_at_epoch'] = at;
    if (spec.hasUpdatedAt && row['updated_at_epoch'] === undefined) row['updated_at_epoch'] = at;
    if (spec.hasLamport) row['lamport'] = lamport;

    const columns = Object.keys(row).map(assertIdentifier);
    const placeholders = columns.map(() => '?').join(', ');
    const conflict = options?.orReplace ? 'OR REPLACE ' : options?.orIgnore ? 'OR IGNORE ' : '';

    await t.db.runAsync(
      `INSERT ${conflict}INTO ${assertIdentifier(table)} (${columns.join(', ')}) VALUES (${placeholders});`,
      columns.map((c) => row[c] ?? null),
    );

    const id = String(row[spec.pk]);
    await enqueueOutbox(t, table, id, 'upsert', lamport);
    return id;
  }, tx);
}

/**
 * Patch a row's non-clinical columns.
 *
 * NOTE: this cannot be used to change a clinical column on `medicine` or
 * `dose_schedule` — a database trigger aborts that, and the correct move is
 * `createNewVersion()` in the relevant repository. That refusal is deliberate: an
 * in-place dose edit destroys the answer to "what was she taking in March?", which
 * is the only question the OPD report exists to answer.
 */
export async function updateRecord(
  table: TableName,
  id: string,
  patch: Record<string, Bind>,
  tx?: Tx,
): Promise<void> {
  const spec = TABLES[table];
  if (Object.keys(patch).length === 0) return;

  await inTransaction(async (t) => {
    const lamport = await lamportFor(t, spec);
    const row: Record<string, Bind> = { ...patch };
    if (spec.hasUpdatedAt) row['updated_at_epoch'] = nowEpoch();
    if (spec.hasLamport) row['lamport'] = lamport;

    const columns = Object.keys(row).map(assertIdentifier);
    const assignments = columns.map((c) => `${c} = ?`).join(', ');

    await t.db.runAsync(
      `UPDATE ${assertIdentifier(table)} SET ${assignments} WHERE ${assertIdentifier(spec.pk)} = ?;`,
      [...columns.map((c) => row[c] ?? null), id],
    );
    await enqueueOutbox(t, table, id, 'upsert', lamport);
  }, tx);
}

/** Soft delete. The row stays; `deleted_at_epoch` is what every read filters on. */
export async function softDeleteRecord(table: TableName, id: string, tx?: Tx): Promise<void> {
  const spec = TABLES[table];
  if (!spec.hasSoftDelete) {
    throw new Error(`${table} has no deleted_at_epoch column — it cannot be soft deleted.`);
  }
  await inTransaction(async (t) => {
    const lamport = await lamportFor(t, spec);
    const at = nowEpoch();
    const sets = ['deleted_at_epoch = ?'];
    const params: Bind[] = [at];
    if (spec.hasUpdatedAt) {
      sets.push('updated_at_epoch = ?');
      params.push(at);
    }
    if (spec.hasLamport) {
      sets.push('lamport = ?');
      params.push(lamport);
    }
    params.push(id);
    await t.db.runAsync(
      `UPDATE ${assertIdentifier(table)} SET ${sets.join(', ')} WHERE ${assertIdentifier(spec.pk)} = ?;`,
      params,
    );
    await enqueueOutbox(t, table, id, 'delete', lamport);
  }, tx);
}

/** Insert-or-update on a natural primary key (emergency_card, streak_state). */
export async function upsertRecord(
  table: TableName,
  values: Record<string, Bind>,
  tx?: Tx,
): Promise<string> {
  const spec = TABLES[table];
  const key = values[spec.pk];
  if (key === undefined || key === null) {
    throw new Error(`upsertRecord(${table}) needs a ${spec.pk}`);
  }
  return inTransaction(async (t) => {
    const existing = await t.db.getFirstAsync<Record<string, unknown>>(
      `SELECT ${assertIdentifier(spec.pk)} FROM ${assertIdentifier(table)} WHERE ${assertIdentifier(spec.pk)} = ?;`,
      [key],
    );
    if (existing) {
      const patch = { ...values };
      delete patch[spec.pk];
      await updateRecord(table, String(key), patch, t);
      return String(key);
    }
    return createRecord(table, values, t);
  }, tx);
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function queryAll<T>(sql: string, params: Bind[] = [], tx?: Tx): Promise<T[]> {
  const db = tx ? tx.db : await getDb();
  return db.getAllAsync<T>(sql, params);
}

export async function queryFirst<T>(sql: string, params: Bind[] = [], tx?: Tx): Promise<T | null> {
  const db = tx ? tx.db : await getDb();
  return (await db.getFirstAsync<T>(sql, params)) ?? null;
}

// ── Edit audit ───────────────────────────────────────────────────────────────

export type RecordKind = 'reading' | 'symptom_event';

/**
 * Append one audit line per changed field.
 *
 * `edited_count` on its own is a rumour — it says a number changed but not from
 * what, so a doctor looking at a corrected 180 systolic cannot tell whether the
 * original was 108 (a transposition) or 80 (a different arm). The audit row makes
 * the correction reviewable instead of merely countable.
 */
export async function recordEdit(
  kind: RecordKind,
  recordId: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
  tx?: Tx,
): Promise<void> {
  await createRecord(
    'record_edit',
    {
      record_kind: kind,
      record_id: recordId,
      field,
      old_value: oldValue,
      new_value: newValue,
      at_epoch: nowEpoch(),
    },
    tx,
  );
}

// ── Small conversions ────────────────────────────────────────────────────────

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

export function intToBool(value: number | null | undefined): boolean {
  return value === 1;
}

/** JSON columns are stored as TEXT; `null` stays `null` rather than the string "null". */
export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function fromJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    // A corrupt JSON blob must never take down a list screen. Losing one optional
    // context object is survivable; throwing here is not.
    return null;
  }
}
