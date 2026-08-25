/**
 * The v2 multi-writer stream: seal a local row, pull siblings' rows, apply them under LWW.
 *
 * ═══ THIS IS THE READER THE RECORD STREAM NEVER HAD ═══════════════════════════════
 * The baseline `outbox.ts` header says the patient device is the ONLY writer and there is no
 * merge; `redact.ts` says "nothing reads the record stream yet". v2 RETIRES both: every member
 * device writes one profile, and this file is the reader + the merge. It supersedes those notes
 * for the `sync_row` stream only — the legacy `sync_record`/`sync_share` path is untouched.
 *
 * ═══ THE MERGE, IN TWO PLACES, ONE COMPARATOR ═════════════════════════════════════
 * LWW by (modified_at_ms, device_id), enforced on the relay (the `trg_sync_row_lww` trigger,
 * which holds the single winner) AND here on the puller (a device can hold a locally-newer edit
 * than the relay's winner at pull time). Both use `rowIsNewer` from `./merge` — if they ever
 * disagree, two phones diverge. The publish-BEFORE-pull ordering (see `outbox.publishSharedProfiles`
 * and `appOpen`) is what lets the puller compare against `updated_at_epoch` alone without
 * tracking each remote author: this device's own edits are already on the relay before it
 * applies anything, so the pulled winner is the true merged result and re-applying our own row
 * is idempotent.
 *
 * ═══ THREE RULES THE APPLY PATH HOLDS ═════════════════════════════════════════════
 *   • C2 — ANY inbound medicine/dose_schedule lands `confirmed_by_user_at = NULL` on the OWNER
 *     device, so `trg_occ_requires_confirmed_*` refuses to ring it until the owner accepts it.
 *     The stamp is cleared author-BLIND (device_id is self-asserted under a key every member
 *     holds, so it cannot gate the ring — see `upsertDecryptedRow`); the owner's own
 *     confirmations happen locally and its own rows round-trip as no-ops, so nothing legitimate
 *     is lost. That clearing is the enforcement; the triggers stay intact.
 *   • dose_event UNIONS (append-only, INSERT OR IGNORE) — a "taken" is never dropped by LWW.
 *   • INBOUND SYNC NEVER CALLS INTO `modules/med-alarm`. Marking a dose taken from a sibling
 *     records an event that merges; it CANNOT silence the owner's live ring (the ~2-min
 *     MediaPlayer stops only on the owner tapping Taken or on its own timeout, C2).
 *
 * ═══ WHY DB IMPORTS ARE DYNAMIC ═══════════════════════════════════════════════════
 * `sealRowPayload`/`buildRowUpsert` are pure (profile key injected) and must stay loadable
 * where `node --test` runs; the apply/pull halves `await import` the db layer at call time,
 * exactly like `dosing/deviceHorizon.ts`.
 */

import * as Crypto from 'expo-crypto';
import type * as SQLite from 'expo-sqlite';

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import type { SyncConfig } from './config';
import { rowIsNewer, isReminderTable, mergeStrategyFor } from './merge';
import { stripLocalPaths } from './redact';
import { rowAad, sealJson, openJson } from './sealed';

const random = (count: number): Uint8Array => Crypto.getRandomBytes(count);

/** The clear-text envelope sealed under the profile key. `row`/`id` depend on `op`. */
type RowEnvelope =
  | { readonly op: 'upsert'; readonly table: string; readonly row: Record<string, unknown> }
  | { readonly op: 'delete'; readonly table: string; readonly id: string };

/**
 * Seal one row for the `sync_row` stream. Base64, because the server column is text.
 *
 * The four ordering columns are bound into the AAD (`rowAad`), so the relay cannot move the
 * payload onto another row, replay it under a newer millisecond, swap the device_id, or claim a
 * different generation. The profile key is passed in (not fetched) so this stays pure and the
 * caller fetches it once per profile. `value` is already stripped of local paths by the caller
 * — this function seals tombstones and `device:`/`member:` rows too and has no business knowing
 * what a clinical row is (the same reason `sealRecordPayload` does not strip).
 */
export function sealRowPayload(
  rowKey: string,
  op: 'upsert' | 'delete',
  modifiedAtMs: number,
  deviceId: string,
  keyGeneration: number,
  value: unknown,
  profileKey: Uint8Array,
  random: (count: number) => Uint8Array,
): string {
  return bytesToBase64(sealJson(profileKey, value, rowAad(rowKey, modifiedAtMs, deviceId, keyGeneration), random));
}

/** The POST body for one `sync_row` upsert. `written_at_epoch` is DELIBERATELY absent — the relay stamps it. */
export function buildRowUpsert(args: {
  linkId: string;
  rowKey: string;
  deviceId: string;
  modifiedAtMs: number;
  op: 'upsert' | 'delete';
  payload: string;
  keyGeneration: number;
}): Record<string, unknown> {
  return {
    link_id: args.linkId,
    row_key: args.rowKey,
    device_id: args.deviceId,
    modified_at_ms: args.modifiedAtMs,
    op: args.op,
    payload: args.payload,
    key_generation: args.keyGeneration,
  };
}

// ── Pull ───────────────────────────────────────────────────────────────────────

/** One decrypted, still-generic pulled row, ready for `applyPulledRow`. */
export type PulledRow = {
  readonly rowKey: string;
  readonly deviceId: string;
  readonly modifiedAtMs: number;
  readonly keyGeneration: number;
  readonly op: 'upsert' | 'delete';
  /** The raw sealed payload; decryption happens in `applyPulledRow` under the current key. */
  readonly payload: string;
  readonly writtenAtEpoch: number;
};

const HWM_PREFIX = 'sync.pull_hwm.';

/** The per-share incremental-pull cursor (the relay's arrival clock of the last applied row). */
export async function getPullHighWaterMark(shareId: string): Promise<number> {
  const { queryFirst } = await import('../../db/repositories/_shared');
  const row = await queryFirst<{ value: string | null }>(`SELECT value FROM app_meta WHERE key = ?;`, [
    `${HWM_PREFIX}${shareId}`,
  ]);
  const value = row?.value ? Number(row.value) : 0;
  return Number.isFinite(value) ? value : 0;
}

export async function setPullHighWaterMark(shareId: string, writtenAtEpoch: number): Promise<void> {
  const { inTransaction } = await import('../../db/repositories/_shared');
  await inTransaction(async (t) => {
    await t.db.runAsync(
      `INSERT INTO app_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [`${HWM_PREFIX}${shareId}`, String(writtenAtEpoch)],
    );
  });
}

/**
 * Pull rows written after `sinceHwm`, oldest first. Null on an unconfigured phone or a network
 * failure — every caller is a background pass that must return quietly (config.ts).
 *
 * RLS filters `sync_row` on `X-Share-Id`, so the client pointed at this share sees only its own
 * rows; the `written_at_epoch` filter and ordering are the incremental cursor. A late-arriving
 * OLD edit still shows up here (its arrival clock is recent even if its modified-ms is old), so
 * the puller runs the same LWW and drops it if a newer local row already exists.
 */
export async function pullRows(shareId: string, sinceHwm: number): Promise<readonly PulledRow[] | null> {
  const [{ getSyncConfig }, { clientFor }] = await Promise.all([import('./config'), import('./client')]);
  const config = await getSyncConfig();
  if (!config) return null;
  const client = clientFor(config, shareId);
  const query = `written_at_epoch=gt.${encodeURIComponent(String(sinceHwm))}&order=written_at_epoch.asc`;
  const response = await client.select<{
    row_key: string;
    device_id: string;
    modified_at_ms: number;
    key_generation: number;
    op: 'upsert' | 'delete';
    payload: string;
    written_at_epoch: number;
  }>('sync_row', query);
  if (!response.ok) return null;
  return response.data.map((r) => ({
    rowKey: r.row_key,
    deviceId: r.device_id,
    modifiedAtMs: r.modified_at_ms,
    keyGeneration: r.key_generation,
    op: r.op,
    payload: r.payload,
    writtenAtEpoch: r.written_at_epoch,
  }));
}

// ── Apply ──────────────────────────────────────────────────────────────────────

export type ApplyContext = {
  /** This device's id (config.deviceId). */
  readonly thisDeviceId: string;
  /** True when THIS device owns the profile — only then does the C2 confirmed-gate bite. */
  readonly isOwnerDevice: boolean;
  /** The device id that owns the profile, to recognise an owner-authored reminder row. */
  readonly ownerDeviceId: string | null;
  readonly profileKey: Uint8Array;
};

export type ApplyOutcome = 'applied' | 'skipped_stale' | 'undecryptable' | 'ignored';

/**
 * Decrypt one pulled row and apply it locally under LWW + the C2 gate.
 *
 * Returns without touching the alarm layer, ever. Sealed `device:`/`member:` rows are handled
 * by membership/push, not here — this applies only `<table>:<id>` clinical rows.
 */
export async function applyPulledRow(row: PulledRow, ctx: ApplyContext): Promise<ApplyOutcome> {
  const colon = row.rowKey.indexOf(':');
  if (colon < 0) return 'ignored';
  const table = row.rowKey.slice(0, colon);
  const id = row.rowKey.slice(colon + 1);
  // device:/member: rows are the roster/push stream, applied elsewhere.
  if (table === 'device' || table === 'member' || table === 'owner') return 'ignored';

  const envelope = openJson<RowEnvelope>(
    ctx.profileKey,
    base64ToBytesSafe(row.payload),
    rowAad(row.rowKey, row.modifiedAtMs, row.deviceId, row.keyGeneration),
  );
  // Null = wrong-generation key (a removed member's stale key, or one written before a rotation
  // this device has not yet re-keyed to) or tampering. Never a crash; the row is simply not
  // for us this generation.
  if (!envelope || envelope.table !== table) return 'undecryptable';

  const { inTransaction, TABLES, assertIdentifier, queryFirst } = await import('../../db/repositories/_shared');
  const known = Object.prototype.hasOwnProperty.call(TABLES, table);
  if (!known) return 'ignored';
  const spec = (TABLES as Record<string, { pk: string; hasSoftDelete: boolean; sync: boolean }>)[table]!;
  if (!spec.sync) return 'ignored'; // a table the registry says never travels — refuse to apply it

  return inTransaction(async (t) => {
    // ── Puller-side LWW ──────────────────────────────────────────────────────
    // dose_event unions (append-only): never overwrite, just insert-if-absent. Everything else
    // compares (modified_at_ms, device_id) against the local row and applies only if strictly
    // newer. The local author is read as '' (lowest) so the relay's winner takes exact-ms ties
    // — safe because we publish before we pull, so our own edits are already the relay winner
    // by the time we get here.
    if (mergeStrategyFor(table) === 'lww') {
      const local = await queryFirst<{ updated_at_epoch: number | null }>(
        `SELECT updated_at_epoch FROM ${assertIdentifier(table)} WHERE ${assertIdentifier(spec.pk)} = ?;`,
        [id],
        t,
      );
      if (local) {
        const localMs = typeof local.updated_at_epoch === 'number' ? local.updated_at_epoch : 0;
        if (!rowIsNewer({ modifiedAtMs: row.modifiedAtMs, deviceId: row.deviceId }, { modifiedAtMs: localMs, deviceId: '' })) {
          return 'skipped_stale';
        }
      }
    }

    if (envelope.op === 'delete') {
      // A tombstone is a soft delete on tables that carry it; on tables that do not, the delete
      // is meaningless (they are insert-only) and is dropped.
      if (spec.hasSoftDelete) {
        await t.db.runAsync(
          `UPDATE ${assertIdentifier(table)} SET deleted_at_epoch = ?, updated_at_epoch = ?
             WHERE ${assertIdentifier(spec.pk)} = ?;`,
          [row.modifiedAtMs, row.modifiedAtMs, id],
        );
      }
      return 'applied';
    }

    await upsertDecryptedRow(t.db, table, spec.pk, envelope.row, {
      isReminder: isReminderTable(table),
      isOwnerDevice: ctx.isOwnerDevice,
    });
    return 'applied';
  });
}

/**
 * Generic upsert of a decrypted row, WITHOUT the `_shared` writers — applying a received row
 * must NOT re-enqueue it to the outbox (an infinite echo) or re-bump the lamport clock.
 *
 * dose_event and the versioned tables (medicine/dose_schedule) collide only on an id we already
 * hold, so INSERT OR IGNORE is correct for them: their rows are immutable once written. The C2
 * gate rewrites `confirmed_by_user_at` to NULL for a non-owner-authored medicine/schedule on the
 * owner device, so the confirmed-medicine triggers refuse to ring it until the owner accepts it.
 * Independent rows (readings, symptoms, labs, …) UPSERT by primary key.
 */
async function upsertDecryptedRow(
  db: SQLite.SQLiteDatabase,
  table: string,
  pk: string,
  row: Record<string, unknown>,
  gate: { isReminder: boolean; isOwnerDevice: boolean },
): Promise<void> {
  const value = { ...row };

  // C2: the owner device NEVER trusts an inbound confirmation for a reminder row — the stamp is
  // cleared here whatever the row claims about its author, and that clearing is the whole gate
  // (the DB trigger then withholds the ring until the owner accepts it locally).
  //
  // Why author-blind and not "only when a non-owner wrote it": `device_id` is self-ASSERTED, not
  // authenticated. The profile key is held by every member (a viewer needs it to read), so any
  // key-holder can seal a `medicine:`/`dose_schedule:` row that sets `confirmed_by_user_at` and
  // stamps `device_id = ownerDeviceId` (public, on every roster row) — the AAD binds that id but
  // does nothing to stop a key-holder CHOOSING it. Trusting it would let a forged row arm an
  // unconfirmed dose on the owner's phone: the exact C2 outcome. The safe invariant costs
  // nothing legitimate: the owner's OWN confirmations happen locally in the app, and its own
  // rows round-trip as INSERT OR IGNORE no-ops (below), so no genuine owner confirmation ever
  // arrives through this path to be cleared. Real per-writer authorship needs a signature over
  // the row (device keypair), a larger change tracked separately; until then device_id is
  // untrusted for the ring gate.
  if (gate.isReminder && gate.isOwnerDevice) {
    value['confirmed_by_user_at'] = null;
  }

  // Append-only / versioned tables: the id is unique per version, so a conflict means we already
  // have it. INSERT OR IGNORE never overwrites immutable truth.
  const insertOnly = table === 'dose_event' || table === 'medicine' || table === 'dose_schedule';

  const columns = Object.keys(value).map((c) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`applyPulledRow: unsafe column ${c}`);
    return c;
  });
  if (columns.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  // Decrypted JSON columns are string | number | boolean | null — all bindable. Booleans are
  // already 0/1 (SQLite has no bool type), so this is the row exactly as it left the writer.
  const params = columns.map((c) => (value[c] ?? null) as SQLite.SQLiteBindValue);

  if (insertOnly) {
    await db.runAsync(
      `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders});`,
      params,
    );
    return;
  }

  const assignments = columns.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
  await db.runAsync(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(${pk}) DO UPDATE SET ${assignments};`,
    params,
  );
}

/** base64 → bytes, tolerant: a malformed payload becomes empty and fails the AEAD as "not for us". */
function base64ToBytesSafe(text: string): Uint8Array {
  try {
    return base64ToBytes(text);
  } catch {
    // A throw here means the relay stored something that is not our ciphertext; the caller
    // already treats an empty/failing decrypt as "undecryptable", never a crash.
    return new Uint8Array(0);
  }
}

/**
 * Strip a row for the row stream: local paths (identical to the legacy record stream) AND the
 * contact phone number, dropped by NAME (LOCKED: phones stay local). Name-based only — never
 * value-sniffing, which would rewrite her own words in `symptom_event.note` (redact.ts).
 */
export function stripForRowStream(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripLocalPaths(row);
  if (table === 'contact') {
    const { phone: _phone, ...rest } = stripped as { phone?: unknown } & Record<string, unknown>;
    return rest;
  }
  return stripped;
}

// ── The publish / republish / drive helpers (device-gated) ──────────────────────

const STREAM_BATCH = 50;

/**
 * Publish ONE arbitrary row (a `member:`/`device:`/`owner:` control row) into the stream, sealed
 * under the profile key with a fresh millisecond stamp. LWW by ms like any row.
 */
export async function publishStreamRow(
  config: SyncConfig,
  shareId: string,
  key: Uint8Array,
  generation: number,
  deviceId: string,
  rowKey: string,
  value: unknown,
  op: 'upsert' | 'delete' = 'upsert',
): Promise<boolean> {
  const { clientFor, REMOTE_TABLES } = await import('./client');
  const modifiedAtMs = Date.now();
  const payload = sealRowPayload(rowKey, op, modifiedAtMs, deviceId, generation, value, key, random);
  const client = clientFor(config, shareId);
  const response = await client.upsert(
    REMOTE_TABLES.row,
    [buildRowUpsert({ linkId: shareId, rowKey, deviceId, modifiedAtMs, op, payload, keyGeneration: generation })],
    'link_id,row_key',
  );
  return response.ok;
}

/**
 * Re-encrypt and republish every profile-scoped row (plus each active member's roster row) under
 * the CURRENT key/generation. Called after a key rotation (`membership.removeMember`) so a removed
 * device's old-generation key opens nothing written from now on. Never throws — the local db is
 * the truth and a later pass picks up whatever a failed batch missed.
 */
export async function republishProfileStream(shareId: string): Promise<number> {
  try {
    const [{ getSyncConfig }, { clientFor, REMOTE_TABLES }, { getProfileByShareId, listActiveMembers, PROFILE_SCOPED_SYNC_TABLES }, { getProfileKey }, { queryAll, assertIdentifier, TABLES }] =
      await Promise.all([
        import('./config'),
        import('./client'),
        import('../../db/repositories/members'),
        import('./profileKey'),
        import('../../db/repositories/_shared'),
      ]);

    const config = await getSyncConfig();
    if (!config) return 0;
    const share = await getProfileByShareId(shareId);
    if (!share) return 0;
    const keyState = await getProfileKey(shareId);
    if (!keyState) return 0;

    const client = clientFor(config, shareId);
    let published = 0;

    // Every re-encrypted row is stamped with ONE fresh millisecond, ascending across the batch.
    // This is deliberate and load-bearing for revocation: the relay's LWW trigger DROPS an
    // upsert whose (modified_at_ms, device_id) is not strictly greater than what it holds, so
    // re-publishing under the row's ORIGINAL ms would be rejected and the old-generation
    // ciphertext would survive on the relay — readable by the just-removed device's old key. A
    // fresh, strictly-greater ms guarantees the generation-G+1 ciphertext overwrites it. Safe
    // because the owner has just pulled (removeMember pulls before rotating), so its local state
    // already includes every remaining member's edits — there is no newer edit to clobber.
    let stamp = Date.now();

    for (const table of PROFILE_SCOPED_SYNC_TABLES) {
      const spec = (TABLES as Record<string, { pk: string; sync: boolean } | undefined>)[table];
      if (!spec || !spec.sync) continue;
      const whereCol = spec.pk === 'profile_id' ? 'profile_id' : 'profile_id';
      let rows: Record<string, unknown>[];
      try {
        rows = await queryAll<Record<string, unknown>>(
          `SELECT * FROM ${assertIdentifier(table)} WHERE ${assertIdentifier(whereCol)} = ?;`,
          [share.profileId],
        );
      } catch {
        continue; // a table with no profile_id column (or an unreadable one) is skipped
      }
      for (let start = 0; start < rows.length; start += STREAM_BATCH) {
        const batch = rows.slice(start, start + STREAM_BATCH);
        const payloads: Record<string, unknown>[] = [];
        for (const localRow of batch) {
          const id = localRow[spec.pk];
          if (typeof id !== 'string') continue;
          const rowKey = `${table}:${id}`;
          const modifiedAtMs = (stamp += 1);
          let payload: string;
          try {
            payload = sealRowPayload(
              rowKey,
              'upsert',
              modifiedAtMs,
              config.deviceId,
              keyState.generation,
              { op: 'upsert', table, row: stripForRowStream(table, localRow) },
              keyState.key,
              random,
            );
          } catch {
            continue; // one oversized row must not cost the republish
          }
          payloads.push(
            buildRowUpsert({ linkId: shareId, rowKey, deviceId: config.deviceId, modifiedAtMs, op: 'upsert', payload, keyGeneration: keyState.generation }),
          );
        }
        if (payloads.length === 0) continue;
        const response = await client.upsert(REMOTE_TABLES.row, payloads, 'link_id,row_key');
        if (response.ok) published += payloads.length;
      }
    }

    // Re-publish each remaining member's roster row under the new generation, so a device pulling
    // with the rotated key still learns who is in the share.
    for (const member of await listActiveMembers(shareId)) {
      await publishStreamRow(config, shareId, keyState.key, keyState.generation, config.deviceId, `member:${member.deviceId}`, {
        deviceId: member.deviceId,
        role: member.role,
        label: member.deviceLabel,
        publicKey: member.publicKey,
      });
    }

    return published;
  } catch (error) {
    console.warn('[sync] a profile stream could not be republished', error);
    return 0;
  }
}

/**
 * Pull one share's new rows and apply them: clinical rows through `applyPulledRow` (LWW + C2),
 * `member:` rows into the local roster. `device:` rows are left in the stream (push reads them at
 * send time); `owner:` rows are handed to the ownership handler. Advances the high-water mark to
 * the newest arrival applied. Returns the count applied, or null when unconfigured/offline.
 */
export async function pullAndApplyShare(shareId: string): Promise<number | null> {
  const [{ getSyncConfig }, { getProfileByShareId, upsertMember }, { getProfileKey }, { normaliseRole }] =
    await Promise.all([
      import('./config'),
      import('../../db/repositories/members'),
      import('./profileKey'),
      import('./merge'),
    ]);

  const config = await getSyncConfig();
  if (!config) return null;
  const share = await getProfileByShareId(shareId);
  if (!share) return null;
  const keyState = await getProfileKey(shareId);
  if (!keyState) return null;

  const hwm = await getPullHighWaterMark(shareId);
  const rows = await pullRows(shareId, hwm);
  if (rows === null) return null;

  const ctx: ApplyContext = {
    thisDeviceId: config.deviceId,
    isOwnerDevice: share.ownerDeviceId === config.deviceId,
    ownerDeviceId: share.ownerDeviceId,
    profileKey: keyState.key,
  };

  let applied = 0;
  let cursor = hwm;
  // Once a row cannot be decrypted, FREEZE the cursor below it. Rows arrive ordered by
  // written_at_epoch asc, so an undecryptable row (a wrong-generation payload — most often the
  // whole stream re-encrypted at G+1 after a rotation, reached before this device has re-keyed)
  // must stay retryable: advancing past it would strand every one of those republished rows
  // BELOW the high-water mark, and once the G+1 key lands they would never be re-pulled — the
  // member's record silently frozen at the pre-rotation state. Re-pulling the already-consumed
  // rows above the old hwm on the next pass is a harmless no-op (LWW/INSERT OR IGNORE).
  let stalled = false;
  for (const row of rows) {
    let consumed = true;
    if (row.rowKey.startsWith('member:')) {
      const value = decryptStreamRow<{ deviceId: string; role: string; label: string | null; publicKey: string | null }>(row, keyState.key);
      if (value) {
        await upsertMember({
          shareId,
          deviceId: value.deviceId,
          publicKey: value.publicKey ?? null,
          deviceLabel: value.label ?? null,
          role: normaliseRole(value.role),
          addedAtEpoch: row.modifiedAtMs,
        });
        applied += 1;
      } else {
        consumed = false; // a wrong-generation roster row: retry after the key rotates in
      }
    } else if (row.rowKey.startsWith('device:')) {
      // tokens are read at push-send time; nothing to decrypt or apply here.
    } else if (row.rowKey.startsWith('owner:')) {
      const value = decryptStreamRow(row, keyState.key);
      if (value) {
        const { applyOwnerRow } = await import('./owner');
        await applyOwnerRow(shareId, value);
        applied += 1;
      } else {
        consumed = false;
      }
    } else {
      const outcome = await applyPulledRow(row, ctx);
      if (outcome === 'applied') applied += 1;
      if (outcome === 'undecryptable') consumed = false;
    }
    if (!consumed) stalled = true;
    if (!stalled) cursor = Math.max(cursor, row.writtenAtEpoch);
  }

  if (cursor > hwm) await setPullHighWaterMark(shareId, cursor);
  return applied;
}

/** Pull and decrypt every stream row whose key has a given prefix (e.g. `device:`). */
export async function readStreamRowsByPrefix<T>(shareId: string, prefix: string, key: Uint8Array): Promise<readonly T[]> {
  const rows = await pullRows(shareId, 0);
  if (!rows) return [];
  const out: T[] = [];
  for (const row of rows) {
    if (!row.rowKey.startsWith(prefix)) continue;
    const value = decryptStreamRow<T>(row, key);
    if (value !== null) out.push(value);
  }
  return out;
}

/** Decrypt a control/clinical row's sealed value under `key`, or null if it is not for this key. */
export function decryptStreamRow<T>(row: PulledRow, key: Uint8Array): T | null {
  return openJson<T>(key, base64ToBytesSafe(row.payload), rowAad(row.rowKey, row.modifiedAtMs, row.deviceId, row.keyGeneration));
}
