/**
 * The one place sharing is driven from the app lifecycle.
 *
 * Everything else in this feature is a function nobody calls until something calls it.
 * Before this file existed, sharing was code-complete and inert: a patient could generate a
 * link, send it, and the viewer would see whatever happened to be on the server at that
 * moment — which was nothing, for ever, because no code path ever published.
 *
 * WHY THIS IS FIRE-AND-FORGET, NOT AWAITED
 *
 * Boot already blocks on three things that must finish before the UI is safe to show:
 * migrations, the journal drain, and reconcile. Sharing is not one of them. Publishing
 * involves network I/O to Supabase, and on a clinic-corridor connection that can take
 * tens of seconds or hang outright — blocking the app's first paint on it would mean an
 * elderly patient staring at a spinner because a feature she does not use is timing out.
 *
 * So this returns immediately and does its work in the background. Nothing in the app reads
 * its result; failures are logged and retried on the next app open, which is the correct
 * cadence for a snapshot that is only ever read by someone opening a link.
 *
 * ORDER MATTERS: drain, then publish.
 *
 * The outbox holds row-level changes queued by the repositories since the last successful
 * push. The snapshot is a single sealed blob of current state. Publishing first would seal
 * a snapshot that omits everything still sitting in the queue, and the next drain would push
 * rows into a dataset the viewer has already fetched — so the viewer would see a stale
 * snapshot with no indication anything was missing. Draining first means the snapshot is
 * sealed from a database that is already caught up.
 */

import { drainOutboxFully, publishSharedProfiles } from './outbox';
import { publishSnapshot } from './snapshot';

let inFlight = false;

/**
 * Runs the sharing work for one app open.
 *
 * Safe to call unconditionally. Every step below returns a "not configured" outcome rather
 * than throwing when sharing has never been set up, which is the case for every install
 * until somebody deliberately turns it on — so on the overwhelmingly common path this costs
 * one `await` that resolves immediately and touches no network.
 */
export async function syncOnAppOpen(): Promise<void> {
  // A second call while the first is still running would push the same outbox rows twice
  // and seal two snapshots racing for the same row. Boot can re-run (a remount, a returning
  // foreground), so this is not hypothetical.
  if (inFlight) return;
  inFlight = true;

  try {
    const drained = await drainOutboxFully();

    // v2 family sharing runs whether or not the legacy path had a global key. PUBLISH BEFORE
    // PULL: draining our own edits to `sync_row` first is what makes the puller-side LWW safe
    // (our edits are the relay winner before we apply anyone's — rowStream.ts). A device with no
    // family-shared profile finds nothing here and returns quietly.
    await syncFamilyShares();

    // The legacy public-link snapshot only makes sense on a device that has the old global key.
    if (drained.skipped === 'not_configured' || drained.skipped === 'no_key') return;
    await publishSnapshot();
  } catch (error) {
    // Deliberately swallowed. Sharing failing is a visibility problem for family; the
    // patient's own record is on this device and is untouched by any of it. Surfacing an
    // error here would put a scary banner in front of the person least able to act on it.
    console.warn('[sync] app-open sync did not complete; will retry on next open', error);
  } finally {
    inFlight = false;
  }
}

/**
 * Publish then pull every family-shared profile.
 *
 * Publish-before-pull is the whole reason the puller-side LWW in rowStream can compare against a
 * bare `updated_at_epoch`: this device's edits reach the relay before it applies anyone else's,
 * so the pulled winner is the true merged result. Each step no-ops quietly when unconfigured;
 * failures are swallowed by the caller and retried next open.
 */
async function syncFamilyShares(): Promise<void> {
  await publishSharedProfiles();

  const { getSyncConfig } = await import('./config');
  const { listSharedProfiles } = await import('../../db/repositories/members');
  const { pullAndApplyShare } = await import('./rowStream');
  const { acceptProfileKeyWrap } = await import('./membership');
  const config = await getSyncConfig();
  const shared = await listSharedProfiles();
  if (shared.length === 0) return;

  for (const profile of shared) {
    if (!profile.shareId) continue;
    // A MEMBER (non-owner) device re-checks for a wrapped profile key it has not installed yet:
    // the first release after the owner approves it, and every later generation-G+1 re-wrap after
    // a removal rotates the key. The owner holds its key from mint and skips this. When a newer
    // generation lands, acceptProfileKeyWrap resets the pull cursor, so the pull just below
    // re-reads the stream re-encrypted under the key it just gained — without that a rotated-in
    // member would decrypt nothing and freeze at its old generation.
    if (config && profile.ownerDeviceId !== config.deviceId) {
      await acceptProfileKeyWrap(profile.shareId);
    }
    await pullAndApplyShare(profile.shareId);
  }

  // Stamped only after every shared profile pulled without throwing, so the time shown in
  // Settings means "this phone genuinely had the others' changes then". A stamp written on
  // attempt would turn a week of failed syncs into a reassuring recent timestamp, which is
  // the one thing a family member checking whether the record is current must not be told.
  const { setLastSyncAt } = await import('../../db/repositories/settings');
  await setLastSyncAt(Date.now());
}

/** Test seam — lets a test observe the guard without waiting for a real run. */
export function __resetSyncInFlightForTests(): void {
  inFlight = false;
}

/**
 * Sync now, on demand.
 *
 * Shares `syncOnAppOpen`'s in-flight guard, so a tap while a boot sync is still running is a
 * no-op rather than a second racing publish. Returns whether a run actually happened, which
 * is what lets the caller say "already syncing" instead of flashing a success it did not do.
 */
export async function syncNow(): Promise<boolean> {
  if (inFlight) return false;
  await syncOnAppOpen();
  return true;
}

