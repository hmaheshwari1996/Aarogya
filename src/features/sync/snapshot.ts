/**
 * What a shared link actually opens: one sealed snapshot of the record.
 *
 * ═══ WHY A SNAPSHOT AND NOT A REPLAY ══════════════════════════════════════════════
 *
 * The record stream in `./outbox.ts` is row-level and append-only, and it is the durable
 * copy. It is not what a family member wants when she taps a link on a bus: she wants a
 * screen. So the patient's device also seals ONE blob containing exactly what the viewer
 * dashboard renders, and the viewer fetches that single row and decrypts it.
 *
 * Three things fall out of that, all of them good:
 *
 *   • One blob has ONE length. The padding argument in `./sealed.ts` — that ciphertext
 *     length leaks how much was written — applies to the whole dataset at once instead of
 *     per row.
 *   • The viewer needs no schema knowledge, no occurrence generator and no migration
 *     history. It renders fields.
 *   • Rotation is cheap: re-seal one blob under the new key at the new id.
 *
 * ─── WHAT IS DELIBERATELY NOT IN IT ───────────────────────────────────────────────
 * No file paths. `stripPhotoUri` is a `file://` path on the patient's handset: it would be
 * a broken image on anybody else's phone AND it describes her storage layout. Photographs
 * do not travel through this path at all.
 *
 * ─── THE STATUS IS NOT BAKED IN ───────────────────────────────────────────────────
 * Doses ship as their scheduled time plus the events recorded against them, not as a
 * status string. The viewer runs `deriveStatus()` against its own clock, so a snapshot
 * published at 08:00 still reads correctly at 14:00 — and it still never says "missed",
 * because that wording does not exist anywhere in `OCCURRENCE_STATUS_COPY`.
 *
 * ─── THE KEY ──────────────────────────────────────────────────────────────────────
 * Sealing uses the key from the keystore; opening uses the key from the link's fragment.
 * Neither is ever logged, put in a query string, or sent in a request body — the only
 * thing that travels here is `link_id` and ciphertext.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { inTransaction, queryFirst } from '../../db/repositories/_shared';
import { listEventsForOccurrences } from '../../db/repositories/doseEvents';
import { listLabResults, listLabTestDefs } from '../../db/repositories/labs';
import { listActiveMedicines, listCurrentMedicines } from '../../db/repositories/medicines';
import { listTrackedMetrics } from '../../db/repositories/metrics';
import { listOccurrencesForDate } from '../../db/repositories/occurrences';
import { getDefaultProfile } from '../../db/repositories/profiles';
import { getLatestReading } from '../../db/repositories/readings';
import { listTargets } from '../../db/repositories/targets';
import { toLocalDate } from '../../lib/datetime';
import { newId } from '../../lib/ids';
import type { DoseEvent, MetricDef, Reading, TargetRange } from '../../types';
import { clientFor, createPatientClient, eq, REMOTE_TABLES, type RemoteShare } from './client';
import { getSyncConfig } from './config';
import { getShareKey } from './crypto';
import { fromBase64Url, type ShareLinkParts } from './link';
import { openJson, sealJson, snapshotAad, SHARE_KEY_BYTES, type RandomSource } from './sealed';

import * as Crypto from 'expo-crypto';

const random: RandomSource = (count) => Crypto.getRandomBytes(count);

/** Bumped only for a change a viewer running an older build could not render. */
export const SNAPSHOT_VERSION = 1;

/** Bounded on purpose, and small: this is a dashboard, not an archive. */
const MAX_READING_CARDS = 6;
const MAX_LAB_ROWS = 6;

// ── The wire shape ───────────────────────────────────────────────────────────

/**
 * Something the family should see at the top of the shared view.
 *
 * It carries counts and times, never a medicine name and never a diagnosis — the same rule
 * the old content-free push followed, kept for the same reason: this row is the one most
 * likely to be read over somebody's shoulder.
 */
export type SharedAlert = {
  readonly id: string;
  readonly kind: 'quiet_doses';
  readonly atEpoch: number;
  readonly consecutive: number;
  readonly latestScheduledAtEpoch: number | null;
};

export type SharedReading = {
  readonly def: MetricDef;
  readonly reading: Reading;
};

export type SharedDose = {
  readonly id: string;
  readonly name: string;
  readonly timeLocal: string;
  readonly scheduledAtEpoch: number;
  readonly cancelled: boolean;
  readonly events: readonly DoseEvent[];
};

export type SharedMedicine = {
  readonly threadId: string;
  readonly name: string;
  readonly strength: string | null;
  readonly startedOn: string | null;
};

export type SharedLab = {
  readonly id: string;
  readonly labelEn: string;
  readonly labelHi: string;
  readonly value: string;
  readonly collectedOn: string | null;
  readonly confirmed: boolean;
};

export type SharedSnapshot = {
  readonly version: number;
  readonly builtAtEpoch: number;
  readonly patientName: string;
  readonly alerts: readonly SharedAlert[];
  readonly readings: readonly SharedReading[];
  /** Every target the patient has, unresolved. The viewer matches them to a reading. */
  readonly targets: readonly TargetRange[];
  readonly doses: readonly SharedDose[];
  readonly medicines: readonly SharedMedicine[];
  readonly labs: readonly SharedLab[];
};

// ── Building ─────────────────────────────────────────────────────────────────

/**
 * Reads the local database and produces exactly what the viewer dashboard renders.
 *
 * Null when there is no profile yet, which is the state of a phone that has not finished
 * setup — a background path, so it says nothing.
 */
export async function buildSnapshot(now: number = Date.now()): Promise<SharedSnapshot | null> {
  const profile = await getDefaultProfile();
  if (!profile) return null;

  const today = toLocalDate(new Date(now));

  const [tracked, targets, currentMeds, activeMeds, labResults, labDefs, occurrences] =
    await Promise.all([
      listTrackedMetrics(profile.id),
      listTargets(profile.id),
      // Current version of EVERY thread, including stopped ones — a dose recorded this
      // morning for a medicine stopped this afternoon still needs its name.
      listCurrentMedicines(profile.id),
      listActiveMedicines(profile.id),
      listLabResults(profile.id, { limit: MAX_LAB_ROWS }),
      listLabTestDefs(),
      listOccurrencesForDate(profile.id, today),
    ]);

  const eventsByOccurrence = await listEventsForOccurrences(occurrences.map((row) => row.id));
  const nameByThread = new Map(currentMeds.map((med) => [med.threadId, med.nameAsWritten]));
  const labDefByKey = new Map(labDefs.map((def) => [def.key, def]));

  const readings: SharedReading[] = [];
  for (const { def } of tracked.slice(0, MAX_READING_CARDS)) {
    const reading = await getLatestReading(profile.id, def.key);
    // "Today's readings" means today's. Yesterday's number under a heading that says Today
    // is how a family member concludes she measured when she did not.
    if (!reading || reading.localDate !== today) continue;
    readings.push({ def, reading });
  }

  return {
    version: SNAPSHOT_VERSION,
    builtAtEpoch: now,
    patientName: profile.displayName,
    alerts: await listSharedAlerts(now),
    readings,
    targets,
    doses: occurrences.map((occurrence) => ({
      id: occurrence.id,
      name: nameByThread.get(occurrence.threadId) ?? '',
      timeLocal: occurrence.timeLocal,
      scheduledAtEpoch: occurrence.scheduledAtEpoch,
      cancelled: occurrence.status === 'cancelled',
      events: eventsByOccurrence.get(occurrence.id) ?? [],
    })),
    medicines: activeMeds.map((med) => ({
      threadId: med.threadId,
      name: med.nameAsWritten,
      strength: med.strength,
      startedOn: med.startedOn,
      // No `stripPhotoUri`. See the header: a file:// path from another phone is a broken
      // image and a description of her storage layout, and it buys nothing.
    })),
    labs: labResults.map((row) => {
      const def = row.testKey === null ? undefined : labDefByKey.get(row.testKey);
      const unit = row.unit ?? def?.unit ?? null;
      const printed = row.valueText ?? '';
      return {
        id: row.id,
        labelEn: row.customLabel ?? def?.labelEn ?? row.testKey ?? '',
        labelHi: row.customLabel ?? def?.labelHi ?? row.testKey ?? '',
        value: printed === '' ? '' : unit ? `${printed} ${unit}` : printed,
        collectedOn: row.collectedOn,
        confirmed: row.confirmedAt !== null,
      };
    }),
  };
}

// ── Publishing ───────────────────────────────────────────────────────────────

export type PublishOutcome = {
  readonly published: boolean;
  readonly reason: 'published' | 'not_configured' | 'no_profile' | 'failed';
};

/**
 * Seals the snapshot and puts it where the link points.
 *
 * A BACKGROUND PATH: an unconfigured phone, a phone with no profile and a phone with no
 * signal all return quietly. Nothing here throws into a caller, because callers include
 * app-open and the quiet-day check.
 */
export async function publishSnapshot(now: number = Date.now()): Promise<PublishOutcome> {
  let client;
  try {
    client = await createPatientClient();
  } catch {
    return { published: false, reason: 'not_configured' };
  }
  if (!client || !client.linkId) return { published: false, reason: 'not_configured' };

  const state = await getShareKey();
  if (!state) return { published: false, reason: 'not_configured' };

  let snapshot: SharedSnapshot | null;
  try {
    snapshot = await buildSnapshot(now);
  } catch (error) {
    // Never throws into a caller: this is called without `await` from the Sharing screen
    // precisely so that a slow connection cannot hold the link off the screen.
    console.warn('[sync] the shared view could not be built', error);
    return { published: false, reason: 'failed' };
  }
  if (!snapshot) return { published: false, reason: 'no_profile' };

  // Sealed with the key from the keystore. The key does not appear in the row, in the
  // filter, or in any log line — only `link_id` and ciphertext leave this function.
  const payload = bytesToBase64(
    sealJson(state.key, snapshot, snapshotAad(state.linkId), random),
  );

  const response = await client.upsert<RemoteShare>(
    REMOTE_TABLES.share,
    [
      {
        link_id: state.linkId,
        payload,
        key_generation: state.generation,
        updated_at_epoch: now,
      },
    ],
    'link_id',
  );

  if (!response.ok) {
    console.warn('[sync] the shared view could not be published', response.error.message);
    return { published: false, reason: 'failed' };
  }
  return { published: true, reason: 'published' };
}

// ── Reading, on the viewer's phone ───────────────────────────────────────────

export type FetchOutcome =
  | { readonly ok: true; readonly snapshot: SharedSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'not_configured' | 'not_found' | 'unreadable' | 'network';
    };

/**
 * Fetches and opens the snapshot a link points at.
 *
 * The link id goes in the request; THE KEY DOES NOT. It is used locally, on the bytes that
 * come back, and never travels — that is the whole reason it lives in the fragment.
 *
 * `unreadable` covers a key that does not open the blob, a blob for a different link id,
 * and a payload from a newer build. All three are the same to a reader: this link does not
 * show anything, ask her for a new one.
 */
export async function fetchSharedSnapshot(link: ShareLinkParts): Promise<FetchOutcome> {
  const config = await getSyncConfig();
  if (!config) return { ok: false, reason: 'not_configured' };

  const key = fromBase64Url(link.keyB64url);
  if (!key || key.length !== SHARE_KEY_BYTES) return { ok: false, reason: 'unreadable' };

  const client = clientFor(config, link.linkId);
  const response = await client.select<RemoteShare>(
    REMOTE_TABLES.share,
    `${eq('link_id', link.linkId)}&select=link_id,payload,key_generation,updated_at_epoch`,
  );
  if (!response.ok) {
    return { ok: false, reason: response.error.retryable ? 'network' : 'not_found' };
  }

  const row = response.data[0];
  if (!row || typeof row.payload !== 'string') return { ok: false, reason: 'not_found' };

  let blob: Uint8Array;
  try {
    blob = base64ToBytes(row.payload);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  const snapshot = openJson<SharedSnapshot>(key, blob, snapshotAad(link.linkId));
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'unreadable' };
  if (!Array.isArray(snapshot.doses) || !Array.isArray(snapshot.readings)) {
    return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, snapshot };
}

// ── The alert list, kept locally ─────────────────────────────────────────────

const ALERTS_META_KEY = 'sync.alerts';

/** Five is more than a family will ever read, and this blob rides in every snapshot. */
const MAX_SHARED_ALERTS = 5;

/** A week. Past that the family either noticed or the situation resolved itself. */
const ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Records an alert on THIS phone, to be carried in the next snapshot.
 *
 * There is nobody to push to — see the header of `./alerts.ts`. The honest thing a
 * public-link model can do is make sure the alert is the first thing a viewer sees the
 * next time she opens the link, and that is what this is.
 */
export async function recordSharedAlert(
  alert: Omit<SharedAlert, 'id'>,
  now: number = Date.now(),
): Promise<void> {
  const existing = await listSharedAlerts(now);
  const next = [{ ...alert, id: newId() }, ...existing].slice(0, MAX_SHARED_ALERTS);
  try {
    await inTransaction(async (tx) => {
      await tx.db.runAsync(
        `INSERT INTO app_meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        [ALERTS_META_KEY, JSON.stringify(next)],
      );
    });
  } catch (error) {
    console.warn('[sync] could not record an alert for the shared view', error);
  }
}

/** Newest first, expired ones dropped. Never throws — it runs inside a background build. */
export async function listSharedAlerts(now: number = Date.now()): Promise<SharedAlert[]> {
  try {
    const row = await queryFirst<{ value: string | null }>(
      `SELECT value FROM app_meta WHERE key = ?;`,
      [ALERTS_META_KEY],
    );
    if (!row?.value) return [];
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];

    const out: SharedAlert[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const atEpoch = record['atEpoch'];
      const id = record['id'];
      if (typeof atEpoch !== 'number' || typeof id !== 'string') continue;
      if (now - atEpoch > ALERT_TTL_MS) continue;
      out.push({
        id,
        kind: 'quiet_doses',
        atEpoch,
        consecutive: typeof record['consecutive'] === 'number' ? record['consecutive'] : 0,
        latestScheduledAtEpoch:
          typeof record['latestScheduledAtEpoch'] === 'number'
            ? record['latestScheduledAtEpoch']
            : null,
      });
    }
    return out.sort((a, b) => b.atEpoch - a.atEpoch).slice(0, MAX_SHARED_ALERTS);
  } catch {
    return [];
  }
}

/** When the last alert was recorded, for the one-a-day gate in `./alerts.ts`. */
export async function lastAlertAtEpoch(now: number = Date.now()): Promise<number | null> {
  const alerts = await listSharedAlerts(now);
  return alerts[0]?.atEpoch ?? null;
}
