/**
 * The file-deletion queue — how "Remove" is guaranteed to reach the disk.
 *
 * ─── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────
 * When she removes a document from the briefcase, two things have to happen: the row
 * goes, and the bytes go. There is no server, so the bytes are the only copy — which
 * cuts both ways. It means a wrongly deleted file is gone for good, and it means a file
 * left behind after she said "remove" is a copy of a discharge summary sitting on the
 * phone with nothing in the app that can find it, list it, or delete it again. In an app
 * whose entire promise is "this stays here and it goes when you say so", the second is a
 * privacy failure, not an untidiness.
 *
 * The naive fix is to unlink inside the delete call. It is wrong in two ways at once:
 *
 *   • A repository that touches the filesystem cannot be tested without one, and cannot
 *     take part in a transaction — the row commits, the unlink throws, and nothing knows.
 *   • It gets exactly one attempt. A crash, a battery pull, or an OEM process kill in the
 *     window between COMMIT and unlink strands the bytes forever, silently.
 *
 * So the request is DATA. The soft delete of the row and the row in this table are
 * written in the SAME transaction, which makes the pair atomic: either the document is
 * still listed and its file is intact, or it is delisted and there is a durable
 * instruction on disk to remove the file. A sweeper drains the queue — after the delete,
 * and again at every boot, so an interrupted delete finishes itself. At-least-once, which
 * is the correct delivery guarantee for an idempotent operation ("make sure this path
 * does not exist").
 *
 * ─── WHAT THIS TABLE IS NOT ───────────────────────────────────────────────────────
 * It is not a trash can. Nothing here can restore a file, and a queued path is not
 * recoverable through this module — it is a to-do list for an unlink that has already
 * been decided on. It also never enqueues a file the app does not own; see
 * `document.owns_file` and `deleteDocument`.
 *
 * ─── WHO CALLS WHAT ───────────────────────────────────────────────────────────────
 * This module owns the ROWS. It never imports expo-file-system and never will. The
 * sweeper that owns the BYTES lives outside the database layer, and its whole shape is:
 *
 *   for (const pending of await listPendingFileDeletes()) {
 *     try { deleteTheFileIfItExists(pending.fileUri); await completeFileDelete(pending.id); }
 *     catch (error) { await recordFileDeleteFailure(pending.id, describe(error)); }
 *   }
 *
 * A file that is ALREADY GONE is a success, not a failure — the queue is idempotent, the
 * sweeper may run twice, and a phone that was factory-restored from a capsule can carry
 * requests for paths that never existed on it.
 */

import {
  createRecord,
  inTransaction,
  nowEpoch,
  queryAll,
  queryFirst,
  type Bind,
  type Tx,
} from './_shared';

export type PendingFileDelete = {
  id: string;
  fileUri: string;
  /** Where the request came from — 'document' today. Free text, for diagnosis only. */
  reason: string;
  requestedAtEpoch: number;
  attempts: number;
  lastError: string | null;
};

type PendingFileDeleteRow = {
  id: string;
  file_uri: string;
  reason: string;
  requested_at_epoch: number;
  attempts: number;
  last_error: string | null;
};

const COLUMNS = 'id, file_uri, reason, requested_at_epoch, attempts, last_error';

function map(row: PendingFileDeleteRow): PendingFileDelete {
  return {
    id: row.id,
    fileUri: row.file_uri,
    reason: row.reason,
    requestedAtEpoch: row.requested_at_epoch,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/**
 * Queue a path for deletion.
 *
 * Deduplicated on the path, because a second request for the same file buys nothing and
 * a failing unlink would then be retried twice as often for no reason. Returns the id of
 * the request that now covers this path — the new one, or the one that was already there.
 *
 * Pass the caller's `tx`. A request written outside the transaction that removed the row
 * is exactly the atomicity this table exists to provide, thrown away.
 */
export async function requestFileDelete(
  fileUri: string,
  reason: string,
  tx?: Tx,
): Promise<string> {
  const uri = fileUri.trim();
  if (!uri) throw new Error('requestFileDelete: fileUri is required');

  return inTransaction(async (t) => {
    const existing = await queryFirst<{ id: string }>(
      `SELECT id FROM pending_file_delete WHERE file_uri = ? LIMIT 1;`,
      [uri],
      t,
    );
    if (existing) return existing.id;

    return createRecord(
      'pending_file_delete',
      {
        file_uri: uri,
        reason,
        // `pending_file_delete` has no created_at column (see TABLES) — the timestamp is
        // named for what it is, so nothing has to guess whether it means "queued" or
        // "swept".
        requested_at_epoch: nowEpoch(),
        attempts: 0,
      },
      t,
    );
  }, tx);
}

/**
 * Oldest first, so a request that has been waiting through several boots is retried
 * before one queued a second ago.
 *
 * The default limit keeps one sweep bounded: unlinking is IO, it runs at app start, and
 * a queue that somehow grew to thousands must not hold the first screen. Whatever is left
 * is picked up by the next sweep — the queue is durable, so nothing is dropped by
 * stopping early.
 */
export async function listPendingFileDeletes(limit = 50, tx?: Tx): Promise<PendingFileDelete[]> {
  const rows = await queryAll<PendingFileDeleteRow>(
    `SELECT ${COLUMNS} FROM pending_file_delete
      ORDER BY requested_at_epoch ASC, id ASC
      LIMIT ?;`,
    [limit],
    tx,
  );
  return rows.map(map);
}

export async function countPendingFileDeletes(tx?: Tx): Promise<number> {
  const row = await queryFirst<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pending_file_delete;`,
    [],
    tx,
  );
  return row?.n ?? 0;
}

/**
 * The bytes are gone (or were never there). Drop the request.
 *
 * A hard DELETE, and one of the few in this codebase. Every other table is soft-deleted
 * so a family member's device can learn about the deletion, but this row IS the deletion
 * and it means nothing on another handset — keeping a tombstone would be keeping a record
 * of a file path after being asked to destroy the file, which is the opposite of the
 * point.
 */
export async function completeFileDelete(id: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(`DELETE FROM pending_file_delete WHERE id = ?;`, [id]);
  }, tx);
}

/**
 * The unlink failed. Count the attempt and keep the reason.
 *
 * There is NO give-up threshold, deliberately. A request that has failed forty times is
 * still a file she asked to have deleted, and the honest response is to keep trying and
 * to be able to show her why it has not happened — not to quietly forget. The developer
 * log screen is where `attempts` and `lastError` become visible.
 */
export async function recordFileDeleteFailure(
  id: string,
  error: string,
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    const params: Bind[] = [error.slice(0, 300), id];
    await t.db.runAsync(
      `UPDATE pending_file_delete SET attempts = attempts + 1, last_error = ? WHERE id = ?;`,
      params,
    );
  }, tx);
}
