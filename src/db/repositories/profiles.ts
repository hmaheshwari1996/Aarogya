/**
 * Profiles, condition packs, and the link between them.
 *
 * A condition pack is DATA, never code (see the schema comment above
 * `condition_pack`): a pack ENABLES metrics, symptoms and tests — it never requires
 * them, and turning one off never deletes anything the user recorded.
 */

import type { Profile } from '../../types';
import {
  type Bind,
  type Tx,
  boolToInt,
  createRecord,
  enqueueOutbox,
  inTransaction,
  intToBool,
  nextLamport,
  nowEpoch,
  queryAll,
  queryFirst,
  softDeleteRecord,
  updateRecord,
} from './_shared';

// ── Row shapes ───────────────────────────────────────────────────────────────
// DB rows are snake_case; the domain types are camelCase. Writing the row shape out
// by hand is what makes a renamed column a compile error rather than an `undefined`
// that reaches a chart.

type ProfileRow = {
  id: string;
  display_name: string;
  year_of_birth: number | null;
  sex: string | null;
  blood_group: string | null;
  is_default: number;
};

type ConditionPackRow = {
  key: string;
  label_en: string;
  label_hi: string;
  description_en: string | null;
  sort_order: number;
};

type ProfileConditionRow = {
  profile_id: string;
  pack_key: string;
  started_on: string | null;
  ended_on: string | null;
};

/** `condition_pack` and `profile_condition` have no domain type in src/types.ts yet. */
export type ConditionPack = {
  key: string;
  labelEn: string;
  labelHi: string;
  descriptionEn: string | null;
  sortOrder: number;
};

export type ProfileCondition = {
  profileId: string;
  packKey: string;
  startedOn: string | null;
  /** Non-null means the pack is switched off. The readings it enabled all survive. */
  endedOn: string | null;
};

const PROFILE_COLUMNS = 'id, display_name, year_of_birth, sex, blood_group, is_default';

const SEXES = ['female', 'male', 'other', 'unstated'] as const;

/** Narrows without a cast, so a value the CHECK constraint could not produce becomes null. */
function toSex(value: string | null): Profile['sex'] {
  return SEXES.find((candidate) => candidate === value) ?? null;
}

function mapProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    yearOfBirth: row.year_of_birth,
    sex: toSex(row.sex),
    bloodGroup: row.blood_group,
    isDefault: intToBool(row.is_default),
  };
}

function mapConditionPack(row: ConditionPackRow): ConditionPack {
  return {
    key: row.key,
    labelEn: row.label_en,
    labelHi: row.label_hi,
    descriptionEn: row.description_en,
    sortOrder: row.sort_order,
  };
}

function mapProfileCondition(row: ProfileConditionRow): ProfileCondition {
  return {
    profileId: row.profile_id,
    packKey: row.pack_key,
    startedOn: row.started_on,
    endedOn: row.ended_on,
  };
}

// ── Profiles ─────────────────────────────────────────────────────────────────

export async function listProfiles(tx?: Tx): Promise<Profile[]> {
  const rows = await queryAll<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM profile
       WHERE deleted_at_epoch IS NULL
       ORDER BY is_default DESC, display_name;`,
    [],
    tx,
  );
  return rows.map(mapProfile);
}

export async function getProfile(id: string, tx?: Tx): Promise<Profile | null> {
  const row = await queryFirst<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM profile WHERE id = ? AND deleted_at_epoch IS NULL;`,
    [id],
    tx,
  );
  return row ? mapProfile(row) : null;
}

export async function getDefaultProfile(tx?: Tx): Promise<Profile | null> {
  const row = await queryFirst<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM profile
       WHERE is_default = 1 AND deleted_at_epoch IS NULL
       ORDER BY created_at_epoch
       LIMIT 1;`,
    [],
    tx,
  );
  return row ? mapProfile(row) : null;
}

export type CreateProfileInput = {
  displayName: string;
  yearOfBirth?: number | null;
  sex?: Profile['sex'];
  bloodGroup?: string | null;
  isDefault?: boolean;
};

export async function createProfile(input: CreateProfileInput, tx?: Tx): Promise<string> {
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new Error('createProfile: displayName is required');
  }

  return inTransaction(async (t) => {
    const id = await createRecord(
      'profile',
      {
        display_name: displayName,
        year_of_birth: input.yearOfBirth ?? null,
        sex: input.sex ?? null,
        blood_group: input.bloodGroup ?? null,
        is_default: boolToInt(false),
      },
      t,
    );
    // Inserted as 0 and promoted afterwards so setDefaultProfile stays the ONLY code
    // path that can produce a default — a second path is a second chance at two defaults.
    if (input.isDefault) await setDefaultProfile(id, t);
    return id;
  }, tx);
}

/** `isDefault` is absent on purpose: flipping it is `setDefaultProfile`, which is atomic. */
export type UpdateProfileInput = {
  displayName?: string;
  yearOfBirth?: number | null;
  sex?: Profile['sex'];
  bloodGroup?: string | null;
};

export async function updateProfile(
  id: string,
  patch: UpdateProfileInput,
  tx?: Tx,
): Promise<void> {
  const row: Record<string, Bind> = {};
  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim();
    if (!displayName) throw new Error('updateProfile: displayName cannot be blank');
    row['display_name'] = displayName;
  }
  // `!== undefined` rather than a truthiness test, because `null` is a real instruction
  // here: "clear the year of birth" must not be silently dropped.
  if (patch.yearOfBirth !== undefined) row['year_of_birth'] = patch.yearOfBirth;
  if (patch.sex !== undefined) row['sex'] = patch.sex;
  if (patch.bloodGroup !== undefined) row['blood_group'] = patch.bloodGroup;

  await updateRecord('profile', id, row, tx);
}

export async function deleteProfile(id: string, tx?: Tx): Promise<void> {
  await softDeleteRecord('profile', id, tx);
}

/**
 * Demote every other profile and promote this one, in ONE transaction.
 *
 * Two statements outside a transaction can be interrupted between them by a crash or
 * an OEM process kill, and both halves of that failure are bad: zero defaults means the
 * app opens to no profile at all, two defaults means readings land on whichever row the
 * query happened to return first.
 *
 * The demotions go row-by-row through updateRecord rather than as one bulk UPDATE
 * because each demoted row needs its own `sync_outbox` entry — a bulk statement would
 * change rows on this device that never travel to the family's.
 */
export async function setDefaultProfile(id: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const others = await queryAll<{ id: string }>(
      `SELECT id FROM profile
         WHERE id <> ? AND is_default = 1 AND deleted_at_epoch IS NULL;`,
      [id],
      t,
    );
    for (const other of others) {
      await updateRecord('profile', other.id, { is_default: boolToInt(false) }, t);
    }
    await updateRecord('profile', id, { is_default: boolToInt(true) }, t);
  }, tx);
}

// ── Condition packs ──────────────────────────────────────────────────────────
// `condition_pack` and `profile_condition` carry no `deleted_at_epoch` column (see
// migrations.ts) — packs are a seeded registry and the link row is switched off with
// `ended_on`, so there is no soft-delete predicate to add to these reads.

export async function listConditionPacks(tx?: Tx): Promise<ConditionPack[]> {
  const rows = await queryAll<ConditionPackRow>(
    `SELECT key, label_en, label_hi, description_en, sort_order
       FROM condition_pack
       ORDER BY sort_order, label_en;`,
    [],
    tx,
  );
  return rows.map(mapConditionPack);
}

/** Every pack ever enabled for the profile, including ones since ended. */
export async function listProfileConditions(
  profileId: string,
  tx?: Tx,
): Promise<ProfileCondition[]> {
  const rows = await queryAll<ProfileConditionRow>(
    `SELECT pc.profile_id AS profile_id, pc.pack_key AS pack_key,
            pc.started_on AS started_on, pc.ended_on AS ended_on
       FROM profile_condition pc
       JOIN condition_pack cp ON cp.key = pc.pack_key
       WHERE pc.profile_id = ?
       ORDER BY cp.sort_order, cp.label_en;`,
    [profileId],
    tx,
  );
  return rows.map(mapProfileCondition);
}

/**
 * The write plumbing `profile_condition` cannot borrow from _shared.
 *
 * Its primary key is COMPOSITE (profile_id, pack_key), but TABLES can only name one pk
 * column and names `profile_id`. `updateRecord()` would therefore emit
 * `WHERE profile_id = ?` and rewrite every pack the profile has — so the statement is
 * written here, still fully parameterised, and the two things updateRecord would have
 * done are done explicitly: bump the lamport clock, and enqueue the outbox row.
 *
 * The outbox `row_id` is the PROFILE id, deliberately, matching what `createRecord`
 * writes for this table. A sync consumer resolves an outbox row by the registered pk,
 * so a composite `profileId:packKey` would resolve to nothing and the change would
 * never travel. Addressing the profile's whole slice over-ships a few rows; the
 * alternative loses them.
 */
async function stampProfileConditionWrite(t: Tx, profileId: string): Promise<void> {
  const lamport = await nextLamport(t);
  await enqueueOutbox(t, 'profile_condition', profileId, 'upsert', lamport);
}

/**
 * Switch a pack on. Re-enabling a pack that was previously ended clears `ended_on`
 * and keeps the original `created_at_epoch`, so the link row's own history is intact.
 */
export async function enableCondition(
  profileId: string,
  packKey: string,
  startedOn: string,
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    await t.db.runAsync(
      `INSERT INTO profile_condition (profile_id, pack_key, started_on, ended_on, created_at_epoch)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(profile_id, pack_key)
       DO UPDATE SET started_on = excluded.started_on, ended_on = NULL;`,
      [profileId, packKey, startedOn, nowEpoch()],
    );
    await stampProfileConditionWrite(t, profileId);
  }, tx);
}

/**
 * Switch a pack off by dating it — and NOTHING else.
 *
 * A pack only ever ENABLED metrics, symptoms and tests; it never owned them. Deleting
 * a reading because the condition it was recorded under is no longer tracked would
 * destroy history the user (and her doctor) still needs: a year of glucose readings is
 * not less true because she stopped tracking diabetes. Untracking a metric is a
 * separate, explicit act — see `untrackMetric` in ./metrics.
 */
export async function disableCondition(
  profileId: string,
  packKey: string,
  endedOn: string,
  tx?: Tx,
): Promise<void> {
  await inTransaction(async (t) => {
    const result = await t.db.runAsync(
      `UPDATE profile_condition SET ended_on = ? WHERE profile_id = ? AND pack_key = ?;`,
      [endedOn, profileId, packKey],
    );
    if (result.changes === 0) return; // pack was never enabled — nothing to sync
    await stampProfileConditionWrite(t, profileId);
  }, tx);
}
