/**
 * Change owner — hand the RINGING (and the key-holder authority) to another member device.
 *
 * ═══ WHY IT IS A TWO-STEP HANDSHAKE, NOT A FLIP ═══════════════════════════════════
 * A dropped transfer must NEVER leave a window where nobody rings a TB dose. So ownership moves
 * in two steps over the blind relay, and the OLD owner keeps ringing until the NEW owner has
 * acknowledged:
 *
 *   1. `changeOwner` (old owner) publishes an `owner:<shareId>` row, phase 'offered'. It does
 *      NOT touch its own `owner_device_id` yet — it is still the ringer.
 *   2. The new owner pulls that row (`applyOwnerRow`), takes ownership LOCALLY, re-arms its own
 *      alarms, and publishes phase 'accepted'.
 *   3. The old owner pulls 'accepted', drops the profile from its owned set, stops scheduling.
 *
 * Between 1 and 2 the old owner rings; between 2 and 3 BOTH could ring for a beat (safe — a
 * double reminder is survivable, a silent TB dose is not). Only after 3 does exactly one ring.
 *
 * The ring set itself is `members.listOwnedProfileIds` (C3), read fresh by `publishDeviceHorizon`
 * — so "re-arm" / "stop scheduling" is just re-running the device horizon after the local
 * `owner_device_id` changes. A non-owner device schedules nothing for this profile.
 *
 * The "notify both devices" line the design calls for is UI (a toast); this module does the DATA
 * + re-arm and surfaces the transition, and the notification is device-gated (see the report).
 */

import { getProfileByShareId, setProfileShare } from '../../db/repositories/members';
import { getSyncConfig } from './config';
import { getProfileKey } from './profileKey';
import { publishStreamRow } from './rowStream';

type OwnerPhase = 'offered' | 'accepted';

export type OwnerRow = {
  readonly newOwnerDeviceId: string;
  readonly phase: OwnerPhase;
  readonly atMs: number;
};

function ownerRowKey(shareId: string): string {
  return `owner:${shareId}`;
}

/**
 * Old owner initiates. Publishes the offer; keeps ringing. Throws on a misconfigured call — the
 * caller is an owner action that can be told it failed.
 */
export async function changeOwner(shareId: string, newDeviceId: string): Promise<void> {
  const config = await getSyncConfig();
  if (!config) throw new Error('changeOwner: sharing is not configured');
  const share = await getProfileByShareId(shareId);
  if (!share) throw new Error('changeOwner: unknown share on this device');
  if (share.ownerDeviceId !== config.deviceId) throw new Error('changeOwner: only the current owner can transfer ownership');
  if (newDeviceId === config.deviceId) return; // transferring to self is a no-op
  const keyState = await getProfileKey(shareId);
  if (!keyState) throw new Error('changeOwner: this device does not hold the profile key');

  const value: OwnerRow = { newOwnerDeviceId: newDeviceId, phase: 'offered', atMs: Date.now() };
  const ok = await publishStreamRow(config, shareId, keyState.key, keyState.generation, config.deviceId, ownerRowKey(shareId), value);
  if (!ok) throw new Error('changeOwner: could not publish the ownership offer');
}

/**
 * New owner accepts. Takes ownership locally, re-arms its own alarms (via the device horizon,
 * which now includes this profile), and publishes 'accepted' so the old owner steps down.
 */
export async function acknowledgeOwnership(shareId: string): Promise<void> {
  const config = await getSyncConfig();
  if (!config) throw new Error('acknowledgeOwnership: sharing is not configured');
  const share = await getProfileByShareId(shareId);
  if (!share) throw new Error('acknowledgeOwnership: unknown share on this device');
  const keyState = await getProfileKey(shareId);
  if (!keyState) throw new Error('acknowledgeOwnership: this device does not hold the profile key');

  await setProfileShare(share.profileId, { ownerDeviceId: config.deviceId });
  await rearmAlarms();

  const value: OwnerRow = { newOwnerDeviceId: config.deviceId, phase: 'accepted', atMs: Date.now() };
  await publishStreamRow(config, shareId, keyState.key, keyState.generation, config.deviceId, ownerRowKey(shareId), value);
}

/**
 * Drive the handshake from a pulled `owner:` row (called by `rowStream.pullAndApplyShare`).
 *
 *   • 'offered' at THIS device → acknowledge (take ownership, re-arm, publish 'accepted').
 *   • 'accepted' by someone else while WE are the current local owner → step down (drop the
 *     profile from our owned set, re-arm so the device horizon stops scheduling it).
 *
 * A malformed/undecryptable row (`value` null) is ignored — never a crash on a background pull.
 */
export async function applyOwnerRow(shareId: string, value: unknown): Promise<void> {
  const row = asOwnerRow(value);
  if (!row) return;
  const config = await getSyncConfig();
  if (!config) return;
  const share = await getProfileByShareId(shareId);
  if (!share) return;

  if (row.phase === 'offered' && row.newOwnerDeviceId === config.deviceId && share.ownerDeviceId !== config.deviceId) {
    await acknowledgeOwnership(shareId);
    return;
  }

  if (row.phase === 'accepted' && share.ownerDeviceId === config.deviceId && row.newOwnerDeviceId !== config.deviceId) {
    // We were the owner; the new owner has taken over. Step down: it stops us scheduling this
    // profile's alarms on the next horizon publish (C3), with no gap — the new owner is already
    // ringing by the time it published 'accepted'.
    await setProfileShare(share.profileId, { ownerDeviceId: row.newOwnerDeviceId });
    await rearmAlarms();
  }
}

/** Re-publish the device-wide horizon so the owned-profile set (C3) is re-read and alarms re-armed. */
async function rearmAlarms(): Promise<void> {
  try {
    const { publishDeviceHorizon } = await import('../dosing/deviceHorizon');
    await publishDeviceHorizon();
  } catch (error) {
    // Alarm re-arm failing is surfaced by the Reminder Health Check on the owning device; a
    // background ownership pull must not throw.
    console.warn('[sync] could not re-arm alarms after an ownership change', error);
  }
}

function asOwnerRow(value: unknown): OwnerRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const newOwnerDeviceId = record['newOwnerDeviceId'];
  const phase = record['phase'];
  const atMs = record['atMs'];
  if (typeof newOwnerDeviceId !== 'string') return null;
  if (phase !== 'offered' && phase !== 'accepted') return null;
  return { newOwnerDeviceId, phase, atMs: typeof atMs === 'number' ? atMs : 0 };
}
