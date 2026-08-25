/**
 * The pure decisions the multi-writer sync layer makes — no IO, no crypto, no clock.
 *
 * ═══ WHY THIS FILE IS PURE, AND SEPARATE ══════════════════════════════════════════
 * `config.ts` reaches expo-constants and the db layer; `rowStream.ts` reaches the profile
 * key and SQLite. Neither can load under `node --test --experimental-strip-types`, which
 * resolves neither `expo-*` nor the `@/*` alias (CLAUDE.md). So the two decisions that MUST
 * be provable without a device — "which of two concurrent writes wins" and "what may this
 * role do" — live here, imported by both, and `merge.test.ts` loads this file directly.
 *
 * It holds two axes, both pure policy:
 *   1. THE MERGE RULE — last-write-wins by (modified_at_ms, device_id), plus the per-table
 *      shape (dose_event unions, medicine/schedule ride the C2 confirmed-gate).
 *   2. THE ROLE MATRIX — owner / manager / viewer capabilities and the online write-gate.
 *
 * The comparator here is BYTE-IDENTICAL in intent to `sync_row_lww()` in
 * `supabase/schema.sql`. If the relay and the puller disagree on the winner, two devices
 * diverge and never reconverge — the one bug this whole design exists to avoid. Change one,
 * change both, and `merge.test.ts` pins the tie-break.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

// ── Roles ──────────────────────────────────────────────────────────────────────

/**
 * Exactly one Owner (creator) + N Managers + N Viewers per profile.
 *
 * `'patient'` is the LEGACY value an old phone stored (config.ts's single-writer era). It is
 * never narrowed away — `normaliseRole` maps a stored `'patient'` to `'owner'` on read, and
 * the column stays tolerant so an un-upgraded device's row still parses.
 */
export type SyncRole = 'owner' | 'manager' | 'viewer';

/** What a role may do. Booleans only; the online write-gate is `canWriteNow`, not here. */
export type RoleCapabilities = {
  /** Every key-holder sees the full offline copy. */
  readonly see: boolean;
  /** Add/edit non-reminder data (readings, symptoms, labs, notes, documents). */
  readonly writeData: boolean;
  /** Add/edit a medicine or a dose_schedule — what the owner phone RINGS (C2). */
  readonly writeReminders: boolean;
  /** Runs the Kotlin alarm layer and is the push sender. Owner only (C3). */
  readonly rings: boolean;
  /** Invite / approve / deny / change-role / remove / change-owner. Owner only. */
  readonly manageMembers: boolean;
};

const OWNER: RoleCapabilities = {
  see: true,
  writeData: true,
  writeReminders: true,
  rings: true,
  manageMembers: true,
};
const MANAGER: RoleCapabilities = {
  see: true,
  writeData: true,
  // A manager CAN author a medicine/schedule version, but it lands owner-pending — it does
  // not arm until the owner confirms it (C2, §3.4). The capability is "may author", not
  // "may arm"; the confirmed-gate downstream is what withholds the ring.
  writeReminders: true,
  rings: false,
  manageMembers: false,
};
const VIEWER: RoleCapabilities = {
  see: true,
  writeData: false,
  writeReminders: false,
  rings: false,
  manageMembers: false,
};

const CAPS: Record<SyncRole, RoleCapabilities> = {
  owner: OWNER,
  manager: MANAGER,
  viewer: VIEWER,
};

/** Maps a legacy `'patient'` (and any unknown string) to a v2 role. Never throws. */
export function normaliseRole(stored: string | null | undefined): SyncRole {
  if (stored === 'owner' || stored === 'patient') return 'owner';
  if (stored === 'manager') return 'manager';
  // Everything else — 'viewer', a blank, a value from a newer build — reads as the least
  // capable role. Failing closed here means a corrupted role can only ever REMOVE ability.
  return 'viewer';
}

export function roleCapabilities(role: SyncRole): RoleCapabilities {
  return CAPS[role];
}

/**
 * The online write-gate (§3.3). LOCKED: a Manager writes ONLY while the relay is reachable;
 * offline they are read-only. This is what keeps concurrent offline edits rare, which is what
 * makes the wall-clock LWW below (F2) acceptable.
 *
 *   owner   → always (it is the source of truth and the ringer; it writes offline freely)
 *   manager → only while online (a successful relay round-trip is currently believed possible)
 *   viewer  → never
 *
 * `online` is NOT a presence table — it is "the last relay call did not fail offline/timeout"
 * (SyncClientError.kind). The relay is blind and cannot enforce a role, so this gate is
 * client-side (F3): it is trusted among key-holders, not a cryptographic boundary.
 */
export function canWriteNow(role: SyncRole, online: boolean): boolean {
  if (role === 'owner') return true;
  if (role === 'manager') return online;
  return false;
}

// ── The merge rule ───────────────────────────────────────────────────────────

/** The two clear-text ordering columns the relay stores, and the LWW key. */
export type RowStamp = {
  readonly modifiedAtMs: number;
  readonly deviceId: string;
};

/**
 * Is `incoming` strictly newer than `stored`, by (modified_at_ms, device_id)?
 *
 * IDENTICAL to the relay trigger `sync_row_lww()`: the millisecond wins; an exact-millisecond
 * tie breaks on the lexically HIGHER device_id. Arbitrary but TOTAL, so every device converges
 * on the same winner (F2). A device_id NEVER ties with itself here — a device only ever
 * compares an inbound row against its own stored copy, and re-applying its own write is a
 * no-op either way.
 *
 * Strict `>`: equal stamps are NOT newer, so re-delivering the current winner changes nothing.
 */
export function rowIsNewer(incoming: RowStamp, stored: RowStamp): boolean {
  if (incoming.modifiedAtMs > stored.modifiedAtMs) return true;
  if (incoming.modifiedAtMs < stored.modifiedAtMs) return false;
  return incoming.deviceId > stored.deviceId;
}

/** How a table's rows combine when two devices touch the same dataset. */
export type MergeStrategy = 'lww' | 'union';

/**
 * `dose_event` is the ONE union table (§3.2). It is append-only truth: each real event has its
 * own row_key (the native journal's ids are content-addressed, app events are UUIDv4), so
 * unioning can never drop a "taken". Everything else is independent rows where the later ms
 * wins. Derived caches (`dose_occurrence`, `streak_state`, badges) are `sync:false` and never
 * reach this path — each device rebuilds them from the merged events.
 */
export function mergeStrategyFor(table: string): MergeStrategy {
  return table === 'dose_event' ? 'union' : 'lww';
}

/**
 * The C2 tables: a medicine or a dose_schedule is WHAT THE OWNER PHONE RINGS.
 *
 * When the OWNER device applies an incoming version of one of these authored by a NON-OWNER,
 * it lands with `confirmed_by_user_at = NULL` — the owner's apply path never trusts an inbound
 * confirmation stamp for these two tables (§3.4). The DB triggers
 * `trg_occ_requires_confirmed_{medicine,schedule}` then refuse to generate any
 * `dose_occurrence` from it, so it does not ring until the owner accepts it. Those triggers are
 * the enforcement; this predicate only tells the apply layer WHICH rows to strip the stamp on.
 */
export function isReminderTable(table: string): boolean {
  return table === 'medicine' || table === 'dose_schedule';
}
