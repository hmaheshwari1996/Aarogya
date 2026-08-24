/**
 * Draining `sync_outbox`: read in lamport order, seal, push, delete.
 *
 * ═══ THE ASSUMPTION THAT MAKES THIS SIMPLE, STATED SO NOBODY BREAKS IT ═════════════
 *
 *   THE PATIENT'S DEVICE IS THE ONLY WRITER. VIEWERS ARE READ-ONLY, BY DESIGN.
 *
 * That is why there is no conflict resolution anywhere in this file — no vector clocks,
 * no last-write-wins arbitration, no merge. One writer means the lamport counter is a
 * total order, and replaying it on any reader reproduces the patient's state exactly.
 *
 * `src/app/(viewer)/index.tsx` has no write control on it ON PURPOSE, and the reason is
 * clinical rather than technical: a son tapping "taken" from his office produces a row
 * indistinguishable from one his mother entered, and six months later a doctor reads a
 * run of confirmed doses that nobody can separate into observed and assumed.
 *
 * IF VIEWER WRITES ARE EVER ADDED, this file is wrong and must be rewritten first. What
 * would be needed, at minimum: a per-device id in the lamport tuple, a deterministic
 * tie-break, a merge rule per table, and a decision about what a viewer's write MEANS on
 * a report. None of that is here. Adding an upload path elsewhere and assuming this drain
 * will cope is the failure mode this comment exists to prevent.
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ WHAT A ROW LOSES ON ITS WAY OUT ══════════════════════════════════════════════
 *
 * BOTH upload paths in this file read a row with `SELECT *` and seal the whole thing. That
 * is the right shape — the record stream is the durable copy and a hand-written column list
 * would go stale — but it means a column added anywhere in the schema starts travelling
 * without anybody deciding that it should.
 *
 * `stripLocalPaths()` from `./redact.ts` is the one decision that has been made: a local
 * file path is removed before sealing, because it is worthless on any other handset and
 * describes this one's storage. THERE ARE EXACTLY TWO PLACES A ROW BECOMES A SEALED
 * PAYLOAD — `buildPayload` and `republish` below — and both call it. A THIRD upload path
 * added later must call it too; it is not enforced by the type system, and the reason it
 * cannot be is written on `sealRecordPayload`, which seals tombstones as well as rows and
 * has no business knowing what a row is.
 *
 * Everything below is a background path: unconfigured, offline and mid-migration all
 * return quietly. Nothing here may throw into a caller, because the caller is app
 * start-up.
 */

import { inTransaction, queryAll, TABLES, assertIdentifier, type TableName } from '../../db/repositories/_shared';
import { createClient, REMOTE_TABLES, type SyncClient } from './client';
import { getShareKey, sealRecordPayload } from './crypto';
import { stripLocalPaths } from './redact';

/**
 * Rows per push.
 *
 * Small because the target connection is a 2G-ish corridor on a metered plan: a batch
 * that fails at row 400 costs the whole batch, and 50 padded records is around 100 KB
 * of body, which is a request that finishes.
 */
export const BATCH_SIZE = 50;

/** Doubling from 30 s, capped at an hour. Index = the row's `attempts` value. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;

/**
 * After this many failures a row stops being retried and stops holding up the queue.
 *
 * It is NOT deleted and NOT lost: the local record is still the source of truth, the
 * outbox row keeps its `last_error`, and a later full resync picks it up. What this
 * prevents is one permanently-rejected row (a payload the server's constraints will never
 * accept) blocking every subsequent record forever.
 */
export const MAX_ATTEMPTS = 12;

export type DrainOutcome = {
  readonly pushed: number;
  readonly failed: number;
  readonly remaining: number;
  readonly skipped: 'not_configured' | 'no_key' | 'offline' | null;
};

const IDLE: DrainOutcome = { pushed: 0, failed: 0, remaining: 0, skipped: 'not_configured' };

type OutboxRow = {
  id: string;
  table_name: string;
  row_id: string;
  op: 'upsert' | 'delete';
  lamport: number;
  attempts: number;
  created_at_epoch: number;
};

/**
 * One pass over the outbox.
 *
 * Ordered by lamport, not by insertion time: the lamport counter is what a reader replays
 * in, and pushing out of order would let a reader briefly see a medicine's newer version
 * before the schedule change that justified it.
 */
export async function drainOutbox(now: number = Date.now()): Promise<DrainOutcome> {
  let client: SyncClient | null;
  try {
    client = await createClient();
  } catch {
    return IDLE;
  }
  if (!client) return IDLE;

  const share = await getShareKey();
  if (!share) return { pushed: 0, failed: 0, remaining: 0, skipped: 'no_key' };

  let pending: OutboxRow[];
  try {
    pending = await queryAll<OutboxRow>(
      `SELECT id, table_name, row_id, op, lamport, attempts, created_at_epoch
         FROM sync_outbox
        WHERE attempts < ?
        ORDER BY lamport ASC
        LIMIT ?;`,
      [MAX_ATTEMPTS, BATCH_SIZE],
    );
  } catch {
    // The database may not be open yet — the drain runs from start-up.
    return IDLE;
  }

  const due = pending.filter((row) => isDue(row, now));
  if (due.length === 0) {
    return { pushed: 0, failed: 0, remaining: pending.length, skipped: null };
  }

  const payloads: Record<string, unknown>[] = [];
  const included: OutboxRow[] = [];
  const unbuildable: OutboxRow[] = [];

  for (const row of due) {
    const built = await buildPayload(row, share.linkId);
    if (built) {
      payloads.push(built);
      included.push(row);
    } else {
      unbuildable.push(row);
    }
  }

  // A row whose local record has vanished cannot be sent and will never become sendable.
  // Dropping it is correct: a delete for that same row id is already in the queue.
  if (unbuildable.length > 0) await forget(unbuildable.map((row) => row.id));

  if (payloads.length === 0) {
    return { pushed: 0, failed: 0, remaining: await countPending(), skipped: null };
  }

  // The composite key, matching the server's primary key. Conflicting on `row_key` alone
  // would let two datasets in one project overwrite each other's rows.
  const response = await client.upsert(REMOTE_TABLES.record, payloads, 'link_id,row_key');
  if (!response.ok) {
    await recordFailure(included, response.error.message);
    return {
      pushed: 0,
      failed: included.length,
      remaining: await countPending(),
      skipped: response.error.kind === 'offline' ? 'offline' : null,
    };
  }

  await forget(included.map((row) => row.id));
  return { pushed: included.length, failed: 0, remaining: await countPending(), skipped: null };
}

/**
 * Drains repeatedly until the queue is empty, the network fails, or the cap is hit.
 *
 * The cap exists because this can be called on app start-up on a phone that has been
 * offline for a fortnight, and an unbounded loop there is a foreground stall on a
 * Go-class device.
 */
export async function drainOutboxFully(maxBatches = 20): Promise<DrainOutcome> {
  let pushed = 0;
  let failed = 0;
  let remaining = 0;
  let skipped: DrainOutcome['skipped'] = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const outcome = await drainOutbox();
    pushed += outcome.pushed;
    failed += outcome.failed;
    remaining = outcome.remaining;
    skipped = outcome.skipped;
    if (outcome.pushed === 0 || outcome.remaining === 0 || outcome.skipped !== null) break;
  }
  return { pushed, failed, remaining, skipped };
}

export async function outboxDepth(): Promise<number> {
  return countPending();
}

/**
 * Re-seals every syncable local row under the CURRENT key and publishes it under the
 * current link id. Called by `rotateShareLink()` in `./share.ts`.
 *
 * The old dataset is deleted whole when a link is rotated, so without this the record
 * stream would be permanently truncated at every rotation — a family that rotates twice
 * would be left with whatever happened to be written since the second rotation. The local
 * database is the source of truth and still holds all of it, so "re-encrypt the dataset"
 * is literally: read it back out and seal it again with the new key.
 *
 * NEVER THROWS. It is called without `await` from `rotateShareLink()`, so a rejection here
 * would be an unhandled one — and every individual failure it can hit (a table that will
 * not read, a row too large to pad, a batch the server refuses) is survivable: the local
 * database is still the truth and publishing again picks up whatever was missed.
 */
export async function republishRecords(): Promise<number> {
  try {
    return await republish();
  } catch (error) {
    console.warn('[sync] the record stream could not be republished', error);
    return 0;
  }
}

async function republish(): Promise<number> {
  const client = await createClient();
  if (!client) return 0;
  const share = await getShareKey();
  if (!share) return 0;

  let published = 0;

  for (const [table, spec] of Object.entries(TABLES)) {
    if (!spec.sync) continue;

    let rows: Record<string, unknown>[];
    try {
      rows = await queryAll<Record<string, unknown>>(`SELECT * FROM ${assertIdentifier(table)};`);
    } catch (error) {
      console.warn(`[sync] could not re-read ${table} for republishing`, error);
      continue;
    }

    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      const payloads: Record<string, unknown>[] = [];

      for (const row of batch) {
        const id = row[spec.pk];
        if (typeof id !== 'string') continue;
        const rowKey = `${table}:${id}`;
        // Rows on tables with no lamport column sync under 0, which is what the outbox
        // does for them too — the AAD only has to agree with itself.
        const lamport = typeof row['lamport'] === 'number' ? row['lamport'] : 0;

        // Per row, because `pad()` throws on anything past the largest bucket. One
        // oversized row — a long extraction blob — must not cost the whole republish.
        let sealed: Awaited<ReturnType<typeof sealRecordPayload>>;
        try {
          // Stripped here as well as in `buildPayload`, and NOT once at the `SELECT`: a
          // rotation re-seals rows that were first published by the other path, so a strip
          // that lived in only one of them would republish under the new key exactly the
          // paths the other one had stopped sending. See ./redact.ts.
          sealed = await sealRecordPayload(rowKey, lamport, {
            op: 'upsert',
            table,
            row: stripLocalPaths(row),
          });
        } catch (error) {
          console.warn(`[sync] ${rowKey} could not be re-sealed`, error);
          continue;
        }
        if (!sealed) continue;
        payloads.push({
          row_key: rowKey,
          link_id: share.linkId,
          lamport,
          op: 'upsert',
          payload: sealed.payload,
          key_generation: sealed.generation,
          updated_at_epoch: Date.now(),
        });
      }

      if (payloads.length === 0) continue;
      const response = await client.upsert(REMOTE_TABLES.record, payloads, 'link_id,row_key');
      if (response.ok) published += payloads.length;
      else console.warn(`[sync] a republish batch for ${table} failed`, response.error.message);
    }
  }

  return published;
}

// ── internals ────────────────────────────────────────────────────────────────

function isDue(row: OutboxRow, now: number): boolean {
  if (row.attempts === 0) return true;
  const index = Math.min(row.attempts - 1, BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[index] ?? 3_600_000;
  return now - row.created_at_epoch >= delay;
}

/**
 * Builds one server row: an opaque blob plus the few fields the server needs to order it.
 *
 * `row_key` is `<table>:<id>` and is the ONLY thing about the local schema that reaches
 * the server. It has to be there — a reader needs to know which table a decrypted payload
 * belongs to — and it is a fixed, small vocabulary rather than anything derived from the
 * patient's data. The clinical content is entirely inside `payload`.
 */
async function buildPayload(row: OutboxRow, linkId: string): Promise<Record<string, unknown> | null> {
  const rowKey = `${row.table_name}:${row.row_id}`;

  // ── THE REGISTRY GETS THE LAST WORD, AND IT GETS IT HERE ────────────────────
  //
  // `enqueueOutbox` checks `TABLES[t].sync` when a row is WRITTEN. That is the tap, and
  // for a while it was the only check on this path — so `document` rows queued before the
  // flag was flipped would still have gone out on the next start-up, after the fix. That
  // is what migration v5 was written to clean up, one time, on every phone.
  //
  // This is the same check at the other end of the pipe, so the next table anyone turns
  // off does not need a migration to be safe. A row refused here returns null, joins
  // `unbuildable`, and is dropped from the queue by `forget()` — which is the right
  // outcome: it is content that must not be published and never will be.
  //
  // A DELETE IS DELIBERATELY STILL ALLOWED, and the asymmetry is the point. An upsert
  // publishes; a delete retracts. Retraction must never be blocked by the flag that
  // stopped the publishing, or turning a table off would strand every tombstone that
  // exists to un-say what it already said. v5's whole retraction is exactly this shape —
  // `op='delete'` rows on `document`, a table whose `sync` is now false — and a blanket
  // refusal here would silently throw them away and leave the briefcase titles sitting on
  // the server forever.
  if (row.op === 'upsert' && isKnownTable(row.table_name) && !TABLES[row.table_name].sync) {
    return null;
  }

  if (row.op === 'delete') {
    // A delete still carries a sealed body — the tombstone names the row and when — so
    // that a reader applying it goes through the same decrypt path as everything else.
    const sealed = await sealRecordPayload(rowKey, row.lamport, {
      op: 'delete',
      table: row.table_name,
      id: row.row_id,
    });
    if (!sealed) return null;
    return {
      row_key: rowKey,
      link_id: linkId,
      lamport: row.lamport,
      op: 'delete',
      payload: sealed.payload,
      key_generation: sealed.generation,
      updated_at_epoch: Date.now(),
    };
  }

  const record = await readLocalRow(row.table_name, row.row_id);
  if (!record) return null;

  const sealed = await sealRecordPayload(rowKey, row.lamport, {
    op: 'upsert',
    table: row.table_name,
    // The strip is HERE rather than inside `readLocalRow`, one line up, on purpose: that
    // function is a plain generic read and the next caller to want a whole local row —
    // a diagnostic, a future exporter — must not silently be handed a censored one. What
    // is being censored is the UPLOAD, not the read.
    row: stripLocalPaths(record),
  });
  if (!sealed) return null;

  return {
    row_key: rowKey,
    link_id: linkId,
    lamport: row.lamport,
    op: 'upsert',
    payload: sealed.payload,
    key_generation: sealed.generation,
    updated_at_epoch: Date.now(),
  };
}

/**
 * Reads a row generically, by the primary key the table registry declares.
 *
 * The table name is checked against `TABLES` before it is spliced into SQL, so a
 * malformed outbox row cannot turn into an injection — and `assertIdentifier` proves the
 * primary-key column is a plain identifier for the same reason.
 */
async function readLocalRow(tableName: string, rowId: string): Promise<Record<string, unknown> | null> {
  if (!isKnownTable(tableName)) return null;
  const spec = TABLES[tableName];
  try {
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT * FROM ${assertIdentifier(tableName)} WHERE ${assertIdentifier(spec.pk)} = ? LIMIT 1;`,
      [rowId],
    );
    return rows[0] ?? null;
  } catch (error) {
    console.warn(`[sync] could not read ${tableName}:${rowId} for upload`, error);
    return null;
  }
}

function isKnownTable(name: string): name is TableName {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}

async function forget(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await inTransaction(async (tx) => {
      for (const id of ids) {
        await tx.db.runAsync(`DELETE FROM sync_outbox WHERE id = ?;`, [id]);
      }
    });
  } catch (error) {
    console.warn('[sync] could not clear drained outbox rows', error);
  }
}

/**
 * Bumps `attempts` and stamps `created_at_epoch` forward.
 *
 * Reusing `created_at_epoch` as the backoff anchor is deliberate: the schema has no
 * `next_attempt_at` column and adding one would be a migration for a value that is only
 * ever compared against `now`. What it costs is the row's original enqueue time, which
 * nothing reads.
 */
async function recordFailure(rows: readonly OutboxRow[], error: string): Promise<void> {
  if (rows.length === 0) return;
  const at = Date.now();
  try {
    await inTransaction(async (tx) => {
      for (const row of rows) {
        await tx.db.runAsync(
          `UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?, created_at_epoch = ?
             WHERE id = ?;`,
          [error.slice(0, 300), at, row.id],
        );
      }
    });
  } catch (writeError) {
    console.warn('[sync] could not record an outbox failure', writeError);
  }
}

async function countPending(): Promise<number> {
  try {
    const rows = await queryAll<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_outbox WHERE attempts < ?;`,
      [MAX_ATTEMPTS],
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
