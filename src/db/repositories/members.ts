/**
 * Membership + per-profile share identity — the LOCAL state family sharing manages.
 *
 * ═══ WHAT LIVES HERE, AND WHY IT IS LOCAL-ONLY ════════════════════════════════════
 * Two shapes, both reserved empty by migration v7 (see migrations.ts §C):
 *   • `profile.share_id` + `profile.owner_device_id` — a profile's stable public identity once
 *     shared, and which device OWNS its alarms (the ringer). NULL until shared, which is the
 *     normal state for most profiles.
 *   • `profile_member` — one row per (share_id, device_id): the roster the owner curates
 *     (public key, label, role, added/removed stamps).
 *
 * `profile_member` is `sync: false` in TABLES: membership is MANAGED by the owner, not merged
 * between devices. The roster that TRAVELS is the sealed `member:<id>` rows in `sync_row`
 * (features/sync/rowStream); this table is each device's own local copy of who is in the share.
 * So writes here go through hand-written SQL — like `profile_condition`, whose composite key the
 * generic `_shared` writers cannot address — and NONE of them enqueue an outbox row.
 *
 * The C3 seam is here too: `listOwnedProfileIds` is the whole of "a non-owner device schedules
 * no alarms for a profile it does not own" (deviceHorizon reads it).
 */

import { normaliseRole, type SyncRole } from '../../features/sync/merge';
import { type Tx, assertIdentifier, inTransaction, queryAll, queryFirst } from './_shared';

// ── Per-profile share identity ───────────────────────────────────────────────

export type ProfileShare = {
  readonly profileId: string;
  /** The dataset id the profile's rows ride under (base64url), or null until shared. */
  readonly shareId: string | null;
  /** The device that owns the alarms/key for this profile, or null when not yet shared. */
  readonly ownerDeviceId: string | null;
};

type ShareRow = { id: string; share_id: string | null; owner_device_id: string | null };

export async function getProfileShare(profileId: string, tx?: Tx): Promise<ProfileShare | null> {
  const row = await queryFirst<ShareRow>(
    `SELECT id, share_id, owner_device_id FROM profile WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [profileId],
    tx,
  );
  if (!row) return null;
  return { profileId: row.id, shareId: row.share_id, ownerDeviceId: row.owner_device_id };
}

/** Every profile that has been shared (has a share_id), for the app-open publish/pull sweep. */
export async function listSharedProfiles(tx?: Tx): Promise<ProfileShare[]> {
  const rows = await queryAll<ShareRow>(
    `SELECT id, share_id, owner_device_id FROM profile
       WHERE deleted_at_epoch IS NULL AND share_id IS NOT NULL;`,
    [],
    tx,
  );
  return rows.map((row) => ({ profileId: row.id, shareId: row.share_id, ownerDeviceId: row.owner_device_id }));
}

/** Find the local profile a pulled/owned dataset belongs to. */
export async function getProfileByShareId(shareId: string, tx?: Tx): Promise<ProfileShare | null> {
  const row = await queryFirst<ShareRow>(
    `SELECT id, share_id, owner_device_id FROM profile WHERE share_id = ? AND deleted_at_epoch IS NULL;`,
    [shareId],
    tx,
  );
  if (!row) return null;
  return { profileId: row.id, shareId: row.share_id, ownerDeviceId: row.owner_device_id };
}

/**
 * Set (or clear) a profile's share id and owning device.
 *
 * Written straight to the `profile` row WITHOUT the generic writers on purpose: `share_id` and
 * `owner_device_id` are sharing-control columns, not clinical ones, and must NOT enqueue a
 * `sync_outbox` row or bump the lamport clock — they are device-local routing, and shipping
 * them into the record stream would be nonsense on another handset. A `null` is a real value
 * here (turning sharing off, or handing ownership to another device), so both are bound
 * directly rather than skipped when absent.
 */
export async function setProfileShare(
  profileId: string,
  patch: { shareId?: string | null; ownerDeviceId?: string | null },
  tx?: Tx,
): Promise<void> {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (patch.shareId !== undefined) {
    sets.push('share_id = ?');
    params.push(patch.shareId);
  }
  if (patch.ownerDeviceId !== undefined) {
    sets.push('owner_device_id = ?');
    params.push(patch.ownerDeviceId);
  }
  if (sets.length === 0) return;
  params.push(profileId);
  await inTransaction(async (t) => {
    await t.db.runAsync(`UPDATE profile SET ${sets.join(', ')} WHERE id = ?;`, params);
  }, tx);
}

/**
 * The profile ids whose alarms THIS device is responsible for ringing (C3).
 *
 * `owner_device_id IS NULL` — the profile is not shared, so this device rings it as it always
 * has — OR `owner_device_id = thisDeviceId` — this device is the owner. A profile owned by
 * ANOTHER device (this phone is a manager/viewer of it) is excluded, so `deviceHorizon` never
 * publishes an alarm rule for it: managers/viewers get push only, never a local alarm.
 *
 * `thisDeviceId` null means sync is unconfigured; then every profile sits at
 * `owner_device_id IS NULL` and all are owned — identical to the pre-sharing behaviour.
 */
export async function listOwnedProfileIds(thisDeviceId: string | null, tx?: Tx): Promise<Set<string>> {
  const rows = await queryAll<{ id: string }>(
    `SELECT id FROM profile
       WHERE deleted_at_epoch IS NULL
         AND (owner_device_id IS NULL OR owner_device_id = ?);`,
    [thisDeviceId ?? ''],
    tx,
  );
  return new Set(rows.map((r) => r.id));
}

// ── The roster (profile_member) ──────────────────────────────────────────────

export type ProfileMember = {
  readonly shareId: string;
  readonly deviceId: string;
  readonly publicKey: string | null;
  readonly deviceLabel: string | null;
  readonly role: SyncRole;
  readonly addedAtEpoch: number | null;
  /** Non-null once removed; the row is kept so a later rotation knows whom NOT to re-wrap. */
  readonly removedAtEpoch: number | null;
};

type MemberRow = {
  share_id: string;
  device_id: string;
  public_key: string | null;
  device_label: string | null;
  role: string | null;
  added_at_epoch: number | null;
  removed_at_epoch: number | null;
};

function mapMember(row: MemberRow): ProfileMember {
  return {
    shareId: row.share_id,
    deviceId: row.device_id,
    publicKey: row.public_key,
    deviceLabel: row.device_label,
    role: normaliseRole(row.role),
    addedAtEpoch: row.added_at_epoch,
    removedAtEpoch: row.removed_at_epoch,
  };
}

/** Everyone ever in the share, removed members included (they carry `removedAtEpoch`). */
export async function listMembers(shareId: string, tx?: Tx): Promise<ProfileMember[]> {
  const rows = await queryAll<MemberRow>(
    `SELECT share_id, device_id, public_key, device_label, role, added_at_epoch, removed_at_epoch
       FROM profile_member WHERE share_id = ? ORDER BY added_at_epoch;`,
    [shareId],
    tx,
  );
  return rows.map(mapMember);
}

/** Only members still in the share — the set a rotation re-wraps to. */
export async function listActiveMembers(shareId: string, tx?: Tx): Promise<ProfileMember[]> {
  return (await listMembers(shareId, tx)).filter((m) => m.removedAtEpoch === null);
}

export async function getMember(shareId: string, deviceId: string, tx?: Tx): Promise<ProfileMember | null> {
  const row = await queryFirst<MemberRow>(
    `SELECT share_id, device_id, public_key, device_label, role, added_at_epoch, removed_at_epoch
       FROM profile_member WHERE share_id = ? AND device_id = ?;`,
    [shareId, deviceId],
    tx,
  );
  return row ? mapMember(row) : null;
}

/**
 * Insert or update one roster row. Re-adding a previously-removed device clears its
 * `removed_at_epoch` (a re-invite is a real thing — a phone lost then found).
 */
export async function upsertMember(
  member: {
    shareId: string;
    deviceId: string;
    publicKey?: string | null;
    deviceLabel?: string | null;
    role: SyncRole;
    addedAtEpoch: number;
  },
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(
      `INSERT INTO profile_member
         (share_id, device_id, public_key, device_label, role, added_at_epoch, removed_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(share_id, device_id) DO UPDATE SET
         public_key   = excluded.public_key,
         device_label = excluded.device_label,
         role         = excluded.role,
         removed_at_epoch = NULL;`,
      [
        member.shareId,
        member.deviceId,
        member.publicKey ?? null,
        member.deviceLabel ?? null,
        member.role,
        member.addedAtEpoch,
      ],
    );
  }, tx);
}

/** Change a member's role in place (owner action). No-op if the device is not on the roster. */
export async function setMemberRole(shareId: string, deviceId: string, role: SyncRole, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(`UPDATE profile_member SET role = ? WHERE share_id = ? AND device_id = ?;`, [
      role,
      shareId,
      deviceId,
    ]);
  }, tx);
}

/**
 * Stamp a member removed. The row STAYS: a rotation needs to know this device exists so it can
 * deliberately NOT re-wrap the new-generation key to it (that absence is the revocation, §4.3),
 * and the honest UI ("Anything already saved stays on their phone") depends on remembering who
 * was removed and when.
 */
export async function markMemberRemoved(shareId: string, deviceId: string, atEpoch: number, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(`UPDATE profile_member SET removed_at_epoch = ? WHERE share_id = ? AND device_id = ?;`, [
      atEpoch,
      shareId,
      deviceId,
    ]);
  }, tx);
}

/**
 * Every syncable table that carries a `profile_id`, for the per-profile publish/pull.
 *
 * Spliced into SQL, so each is proven a plain identifier by `assertIdentifier` at the call site.
 * `record_edit` is absent on purpose — it has no `profile_id` column (it hangs off a
 * reading/symptom via `record_id`), so it cannot be routed to a profile stream generically this
 * round; its audit rows stay local until a follow-up resolves them through their target row.
 */
export const PROFILE_SCOPED_SYNC_TABLES: readonly string[] = [
  'reading',
  'target_range',
  'prescription',
  'medicine',
  'dose_schedule',
  'dose_event',
  'med_change_event',
  'medicine_stock',
  'symptom_event',
  'lab_result',
  'care_event',
  'visit_log',
  'visit_question',
  'contact',
  'emergency_card',
  'profile_condition',
  'profile_metric',
  'badge',
  'document',
].map(assertIdentifier);
