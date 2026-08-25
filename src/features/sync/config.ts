/**
 * Sync configuration, and the reason every sync path can be a no-op.
 *
 * ─── L1 AND L2 SHIP LONG BEFORE ANY OF THIS ───────────────────────────────────────
 * The app is useful — reminders, records, reports, the OPD print-out — with no backend at
 * all, and that is the configuration almost every install will run in. Family sync is an
 * opt-in extra that needs somebody to create a free Supabase project and paste two values
 * into Settings.
 *
 * So `getSyncConfig()` returning null is the NORMAL case, not an error case, and every
 * function in this feature is required to check it and return quietly. Nothing here may
 * throw on an unconfigured device, log an error, or show anything to the user. A sync
 * feature that complains on a phone that never asked for sync is a bug.
 *
 * ─── WHY SUPABASE FREE ────────────────────────────────────────────────────────────
 * No credit card, 500 MB of Postgres, 1 GB of storage, and commercial use permitted. The
 * one operational catch is that free projects PAUSE after 7 days without database
 * activity, which a `pg_cron` heartbeat handles — see `docs/SYNC-AND-BACKUP.md`.
 *
 * The anon key is a PUBLIC value by Supabase's design: it identifies the project and
 * nothing else, and row-level security is what actually restricts access. It is stored in
 * `app_meta` rather than the keystore for exactly that reason. The family key — the one
 * that matters — lives in `expo-secure-store` and is never sent anywhere.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { inTransaction, queryFirst } from '../../db/repositories/_shared';
import { newId } from '../../lib/ids';
import Constants from 'expo-constants';

import { setShareHost } from './link';
import { canWriteNow, normaliseRole, type SyncRole } from './merge';

// The role type and its pure predicates (capabilities, the online write-gate, the legacy
// `'patient' → 'owner'` map) live in `./merge`, which loads under `node --test`; this file
// cannot (it reaches expo-constants and the db). Re-exported so the rest of the app keeps
// importing `SyncRole`/`canWriteNow` from the sync barrel, unaware of the split.
export { canWriteNow, type SyncRole };

/**
 * The one place `extra.inviteHost` is read at runtime.
 *
 * `app.config.ts` defines the host once and uses it for BOTH `android.intentFilters` and
 * this value, so the manifest Android verifies against and the links the app mints can
 * never disagree. They used to be written separately, and a mismatch is invisible: Android
 * fetches `assetlinks.json` from the host in the manifest, so a link built against a
 * different host silently opens a web page instead of the app, with nothing reporting why.
 *
 * The name `inviteHost` is kept because `app.config.ts` is where it is defined and that
 * file is not ours to rename. It is the SHARE link host now.
 *
 * It is injected into `./link.ts`, which imports nothing but the pure codecs. That is
 * deliberate: this file is reached from `./share.ts` through `./client.ts`, so putting the
 * host in `share.ts` would put it inside an import cycle whose module bodies run in an
 * order that leaves a `let` in its temporal dead zone — a start-up crash that only shows up
 * once something imports the feature barrel.
 *
 * An absent value leaves the placeholder in place, which makes `shareLinkUrl()` return null
 * and the screen fall back to the pasteable code — not an error, and not a crash.
 */
setShareHost(
  typeof Constants.expoConfig?.extra?.inviteHost === 'string'
    ? (Constants.expoConfig.extra.inviteHost as string)
    : null,
);

/**
 * The backend baked into the build (`app.config.ts` → `extra.supabaseUrl/supabaseAnonKey`).
 *
 * Every install ships pointing at the same relay, so nobody is asked to paste a URL and a key.
 * A stored value still WINS over these — Settings can point a build at a different backend —
 * but the common path needs no setup at all, which is the difference between a feature the
 * family uses and one nobody turns on.
 *
 * Empty when a build was made without the credentials in the environment. That is not an
 * error: it simply means sharing is unconfigured, exactly as it was before this existed.
 */
const BAKED_URL =
  typeof Constants.expoConfig?.extra?.supabaseUrl === 'string'
    ? (Constants.expoConfig.extra.supabaseUrl as string)
    : '';
const BAKED_ANON_KEY =
  typeof Constants.expoConfig?.extra?.supabaseAnonKey === 'string'
    ? (Constants.expoConfig.extra.supabaseAnonKey as string)
    : '';

/** True when this build can reach a relay without anyone configuring anything. */
export function hasBakedBackend(): boolean {
  return normaliseUrl(BAKED_URL) !== null && BAKED_ANON_KEY.trim().length > 0;
}

const KEY_URL = 'sync.supabaseUrl';
const KEY_ANON = 'sync.anonKey';
const KEY_ENABLED = 'sync.enabled';
const KEY_DEVICE_ID = 'sync.deviceId';
const KEY_DEVICE_LABEL = 'sync.deviceLabel';
const KEY_ROLE = 'sync.role';

export type SyncConfig = {
  /** Project URL, no trailing slash, https only. */
  readonly url: string;
  /** The public anon key. Not a secret; RLS is the control. */
  readonly anonKey: string;
  /** Stable id for THIS handset, minted once. */
  readonly deviceId: string;
  /** Human name shown in the approval prompt — "Redmi Note 12". */
  readonly deviceLabel: string;
  readonly role: SyncRole;
};

/**
 * Returns the configuration, or null when sync is off or half-configured.
 *
 * Never throws, including when the database has not been opened yet — the outbox drain
 * runs from app start-up and must not be able to break it.
 */
export async function getSyncConfig(): Promise<SyncConfig | null> {
  try {
    const enabled = await readMeta(KEY_ENABLED);
    if (enabled !== '1') return null;

    // A pasted value wins; otherwise the build's baked-in backend. The override exists so a
    // build can be pointed at a different relay without a rebuild — it is not the normal path.
    const url = normaliseUrl(await readMeta(KEY_URL)) ?? normaliseUrl(BAKED_URL);
    const stored = (await readMeta(KEY_ANON))?.trim() ?? '';
    const anonKey = stored.length > 0 ? stored : BAKED_ANON_KEY.trim();
    if (!url || anonKey.length === 0) return null;

    const deviceId = (await readMeta(KEY_DEVICE_ID))?.trim() ?? '';
    if (deviceId.length === 0) return null;

    // `normaliseRole` maps the legacy `'patient'` an existing owner phone stored to `'owner'`,
    // reads `'manager'`/`'viewer'` as themselves, and fails CLOSED (viewer) on a blank or a
    // value from a newer build — a corrupted role can only ever REMOVE ability, never grant a
    // silent owner. Both real setup flows write an explicit role, so this only bites corruption.
    const role = normaliseRole(await readMeta(KEY_ROLE));
    const deviceLabel = (await readMeta(KEY_DEVICE_LABEL))?.trim() ?? 'this phone';

    return { url, anonKey, deviceId, deviceLabel, role };
  } catch {
    return null;
  }
}

export async function isSyncConfigured(): Promise<boolean> {
  return (await getSyncConfig()) !== null;
}

export type SyncConfigPatch = {
  readonly url?: string;
  readonly anonKey?: string;
  readonly enabled?: boolean;
  readonly deviceLabel?: string;
  readonly role?: SyncRole;
};

/**
 * Writes settings and mints the device id on first use.
 *
 * The device id is a UUID generated here and never derived from anything on the handset.
 * An id built from a hardware identifier would be a stable cross-app tracker sitting in
 * somebody else's database, attached to a health record — which is precisely the thing
 * this design exists to avoid.
 */
export async function setSyncConfig(patch: SyncConfigPatch): Promise<void> {
  const pairs: [string, string][] = [];

  if (patch.url !== undefined) pairs.push([KEY_URL, normaliseUrl(patch.url) ?? '']);
  if (patch.anonKey !== undefined) pairs.push([KEY_ANON, patch.anonKey.trim()]);
  if (patch.enabled !== undefined) pairs.push([KEY_ENABLED, patch.enabled ? '1' : '0']);
  if (patch.deviceLabel !== undefined) pairs.push([KEY_DEVICE_LABEL, patch.deviceLabel.trim().slice(0, 60)]);
  if (patch.role !== undefined) pairs.push([KEY_ROLE, patch.role]);

  const existingDeviceId = await readMeta(KEY_DEVICE_ID);
  if (!existingDeviceId) pairs.push([KEY_DEVICE_ID, newId()]);

  if (pairs.length === 0) return;

  await inTransaction(async (tx) => {
    for (const [key, value] of pairs) {
      await tx.db.runAsync(
        `INSERT INTO app_meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        [key, value],
      );
    }
  });
}

/** Turns sync off without discarding the project settings, so it can be turned back on. */
export async function disableSync(): Promise<void> {
  await setSyncConfig({ enabled: false });
}

/**
 * What one probe of a project found. THREE answers, because there are three genuinely
 * different things that can be true, and "something went wrong" is none of them.
 *
 *   working      the project answered and accepted the key.
 *   rejected     the project answered and refused — a URL from a different project, or
 *                half a key. Something the person can fix by copying again.
 *   unreachable  no answer came back at all. Nothing has been judged, so the two values
 *                are not known to be wrong; the phone is offline, the project is asleep,
 *                or the request timed out.
 *
 * The difference matters more than it looks. "Rejected" tells somebody to go back and
 * re-copy; "unreachable" tells them to turn mobile data on and stop re-copying a key that
 * was fine all along. A single "could not connect" makes them do the wrong one half the time.
 */
export type SyncProbeResult = 'working' | 'rejected' | 'unreachable';

/** Shorter than a sync request's 20s. Somebody is watching a spinner. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * One real request against a project, before anything is saved.
 *
 * ─── WHY THE POSTGREST ROOT AND NOT A TABLE ───────────────────────────────────────
 * `GET /rest/v1/` returns the API description and needs a valid key, but needs no table to
 * exist. Probing `sync_record` instead would make a brand-new project — the exact case
 * this screen exists for — answer 404, which reads as "wrong URL or key" and would send
 * somebody off to re-copy two values that were correct.
 *
 * ─── A 200 IS NOT ENOUGH; IT HAS TO BE JSON ───────────────────────────────────────
 * The most likely wrong URL is the DASHBOARD address (`https://supabase.com/dashboard/...`)
 * rather than the project's own, and a web page answers 200 with HTML. Accepting that as
 * "working" would save settings that can never sync and report success while doing it.
 *
 * NEVER THROWS, and never returns anything derived from the response body — the body of a
 * refusal can echo request headers, and the key is in one of them.
 */
export async function testSyncConnection(url: string, anonKey: string): Promise<SyncProbeResult> {
  const base = normaliseUrl(url);
  const key = anonKey.trim();
  // Not reachable-vs-rejected at all: nothing was sent. Still "rejected" rather than a
  // fourth answer, because the fix is the same one — go and copy the value again.
  if (!base || key.length === 0) return 'rejected';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });

    // A paused free project, a gateway hiccup, a rate limit: the project never gave a
    // verdict, so neither value has been judged and the honest answer is "no answer".
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      return 'unreachable';
    }
    if (!response.ok) return 'rejected';

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    return contentType.includes('json') ? 'working' : 'rejected';
  } catch {
    // A dropped socket, a name that does not resolve, or the abort above. All of them mean
    // the same thing to the person holding the phone.
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTPS only, no trailing slash, no path.
 *
 * A plain-http project URL would put ciphertext on the wire unauthenticated, which is
 * survivable, and the anon key in the clear, which is not the point — the point is that
 * an app that quietly accepts `http://` teaches a user that it is fine.
 */
export function normaliseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  if (!/^https:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

async function readMeta(key: string): Promise<string | null> {
  const row = await queryFirst<{ value: string | null }>(`SELECT value FROM app_meta WHERE key = ?;`, [key]);
  return row?.value ?? null;
}
