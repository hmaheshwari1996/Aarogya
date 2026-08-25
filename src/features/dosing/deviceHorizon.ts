/**
 * The DEVICE-WIDE alarm horizon — the R1 safety seam for multiple profiles.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TB-DOSE-DROP BUG THIS FILE EXISTS TO PREVENT (safety rule R1)
 *
 * `horizon.json` is ONE file for the WHOLE device. Kotlin's `Materializer` reads it and
 * expands its rules forward indefinitely — that is the only thing that makes an alarm
 * ring for a user who never opens the app.
 *
 * Before multiple profiles existed, `reconcile(profileId)` built a horizon from that one
 * profile's medicines and published it, and that was correct because there was only ever
 * one profile. The moment a second patient exists, that model is a medical bug: reconciling
 * grandmother (because her profile is being VIEWED, or her Today screen foregrounded)
 * would publish a horizon holding only HER rules, OVERWRITING the file — and Kotlin would
 * stop expanding mother's active-TB doses. The viewed profile is a VIEW selector; it must
 * never be an alarm selector. Switching who is on screen cannot be allowed to silence
 * anyone's reminders.
 *
 * THE MODEL: the alarm horizon is DEVICE-scoped, never view-scoped. It is the UNION of
 * `buildAlarmRules` over EVERY non-archived profile's active medicines. `reconcile` still
 * does its per-profile DB work (occurrences are a per-profile UI cache), but it publishes
 * THIS whole-device horizon instead of its own single-profile one. A view switch then only
 * changes which occurrence rows the screens read; it can never trigger a single-profile
 * horizon rewrite, so it can never drop a TB dose.
 *
 * Archived profiles are excluded on purpose — `listProfiles()` returns only live ones.
 * Archiving is an explicit, protected act (it holds a health record; it is gated like
 * deleting a backup), and stopping an archived patient's reminders is the intended result
 * of it. That is the ONLY way a profile's rules leave the horizon.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─── WHY EVERY DB IMPORT HERE IS DYNAMIC ─────────────────────────────────────
 * `node --test` resolves neither the `@/*` alias nor `expo-sqlite`, so a module that
 * top-level-imports the db layer is unloadable under the test runner (see CLAUDE.md). The
 * pure decision `buildDeviceHorizon` must stay reachable from `deviceHorizon.test.ts`, so
 * nothing db-tainted is imported at module scope — `publishDeviceHorizon` `await import`s
 * the db half at call time. Keeping `buildAlarmRules` behind a dynamic import also breaks
 * what would otherwise be a static import cycle with `reconcile.ts`, which imports
 * `publishDeviceHorizon` from here.
 */

import type { AlarmException, AlarmHorizon, AlarmRule } from '../../types';

/**
 * The quiet dose channel. A rule on it does NOT ring: `Materializer.kt` decides ringing as
 * `critical || channelId != dose_low_v1`, and the channel is IMPORTANCE_DEFAULT with
 * `sound: null` and USAGE_NOTIFICATION (src/constants/channels.js). Kotlin tests this exact id
 * (`Const.DOSE_LOW_CHANNEL_ID`), so it is a contract, not a preference.
 */
const QUIET_DOSE_CHANNEL_ID = 'dose_low_v1';

/**
 * The same doses, made silent — what a shared profile looks like on a phone that is NOT its
 * owner.
 *
 * Every member device already holds the whole (encrypted) record, so it already knows when the
 * doses are. It does not need to be TOLD at 8pm — it can schedule its own quiet reminder from
 * data it synced hours ago. That works with NO NETWORK at dose time (a push does not), tells no
 * third party that a reminder happened, needs no push token, and reuses the scheduler that is
 * already proven rather than adding a second, weaker path.
 *
 * The owner's phone (the one with the patient) keeps its real alarm: the medicine's own channel,
 * its criticality, its escalations. Every other member device gets the SAME occurrence at the
 * SAME minute, downgraded here — no alarm sound even on silent, no full-screen intent, no
 * looping player, and NO ESCALATIONS: re-pinging a relative in another city every fifteen
 * minutes about a dose they cannot give is harassment, and it teaches them to swipe away the one
 * that matters.
 *
 * `critical` is cleared as well as the channel, because `ringsAsAlarm` is
 * `critical || channelId != dose_low_v1` — leaving `critical: true` would make a TB dose ring on
 * all four phones despite the quiet channel. Both halves are required; neither alone is.
 *
 * Pure, so the property is provable without a database or a device.
 */
export function toQuietRules(rules: readonly AlarmRule[]): AlarmRule[] {
  return rules.map((rule) => ({
    ...rule,
    channelId: QUIET_DOSE_CHANNEL_ID,
    critical: false,
    escalateAfterMin: [],
  }));
}

/**
 * ─── WHY A NON-OWNER DEVICE SCHEDULES NOTHING (not even a quiet reminder) ─────────────
 * The owner's decision is LOCKED (docs/MULTI-DEVICE-SYNC-DESIGN.md, "Reminders"): the OWNER
 * device rings, and "Managers and Viewers get push only, never a local alarm." Task constraint
 * C3 restates it: "A non-owner device schedules NO alarms for a profile it is not owner of."
 * `members.ts` and `owner.ts` say the same — `listOwnedProfileIds` is "the whole of" that rule.
 *
 * An earlier revision instead scheduled the member's copy on a QUIET channel ("it works with no
 * network, needs no push token"). That is a genuinely reasonable design — but it is a DIFFERENT
 * one, adopted only in this file while the doc, the task, and the sibling repos still said
 * "schedules nothing". A quiet rule is still an alarm-layer entry expanded forever by
 * `Materializer.kt` from possibly-stale synced data — a second scheduler on every relative's
 * phone, which is exactly what "push only" closed. Reintroducing it is a doc change to make with
 * the owner FIRST, not a reinterpretation to smuggle in through the horizon builder. So member
 * profiles are dropped here; the member is told by push (`features/sync/push.ts::sendFamilyPing`)
 * once the receive path is decided (task C1) — not by this device scheduling anything.
 */

/**
 * The horizon is now the whole device's, not one profile's, so its `profileId` field is no
 * longer a real profile id. It stays on the native-contract type (`AlarmHorizon`, unchanged)
 * as an informational marker; Kotlin does not key anything off it once the rules are a union.
 *
 * KOTLIN COORDINATION: the `Materializer` must treat `horizon.json` as device-wide — it must
 * expand ALL rules regardless of this value, and must NOT filter or partition by `profileId`.
 * Today it does not partition (there was only one profile), so a union publishes correctly
 * with no Kotlin change; this sentinel exists so a future reader does not mistake it for a
 * profile to scope by.
 */
export const DEVICE_HORIZON_PROFILE_ID = '*';

/**
 * The pure union: one horizon whose rules are every profile's rules concatenated.
 *
 * Split out from `publishDeviceHorizon` so the R1 property is provable without the database:
 * given profile A's rules and profile B's rules, the horizon carries BOTH. A regression that
 * "optimised" this back to a single profile's rules is exactly the TB-dose-drop above, and
 * `deviceHorizon.test.ts` fails on it.
 */
export function buildDeviceHorizon(
  now: number,
  perProfileRules: readonly (readonly AlarmRule[])[],
  exceptions: readonly AlarmException[] = [],
): AlarmHorizon {
  return {
    schemaVersion: 1,
    writtenAtEpoch: now,
    profileId: DEVICE_HORIZON_PROFILE_ID,
    rules: perProfileRules.flatMap((rules) => [...rules]),
    // Per-date ring moves, unioned across profiles like the rules. Empty is the norm and
    // leaves the native expansion byte-identical to before this feature existed.
    exceptions: [...exceptions],
  };
}

/**
 * Build the device-wide horizon from the live database and arm the native layer.
 *
 * Called by `reconcile` AFTER its transaction commits (a JSI round trip must never be held
 * open across SQLite's write lock — see the note in reconcile.ts). Returns false rather than
 * throwing when the alarm layer is unavailable; the caller reports that through
 * `ReconcileResult.alarmsArmed`, and the Reminder Health Check surfaces it.
 *
 * O(profiles) queries per call — trivial at the one-to-three profiles this app holds. If a
 * device ever carried many profiles, batch the per-profile loads; not worth it now.
 * // ponytail: per-profile loop, batch the loads if profile count ever grows.
 */
export async function publishDeviceHorizon(now: number = Date.now()): Promise<boolean> {
  const [{ listProfiles }, { listActiveMedicines }, { getCurrentSchedulesForThreads }, { buildAlarmRules }, { publishHorizon }] =
    await Promise.all([
      import('../../db/repositories/profiles'),
      import('../../db/repositories/medicines'),
      import('../../db/repositories/schedules'),
      import('./reconcile'),
      import('./medAlarm'),
    ]);

  const { listHorizonOverrides } = await import('../../db/repositories/occurrences');
  const { toLocalDate } = await import('../../lib/datetime');
  const { listOwnedProfileIds } = await import('../../db/repositories/members');
  const { getSyncConfig } = await import('../../features/sync/config');
  // Never move a ring in the past; the override only matters from today forward.
  const fromDate = toLocalDate(new Date(now));

  // C3 — EXACTLY ONE PHONE RINGS, and the others are still told.
  //
  // The owned set is "not shared (owner_device_id IS NULL) OR owned by this device".
  // Unconfigured sync = deviceId null = every profile owned = the exact pre-sharing behaviour
  // (R1: the union over every non-archived profile).
  //
  // A profile owned by ANOTHER device — this phone is a manager or viewer of it — is NOT
  // dropped. Dropping it was correct only while the design still had a PUSH channel to tell
  // that phone instead; there is none. `expo-notifications` was removed and no receive path was
  // ever built, so "members get push only" now resolves to members getting NOTHING: a daughter
  // who accepted an invite would see the record and never be reminded of a single dose, with
  // nothing on screen admitting it.
  //
  // So those rules go through `toQuietRules` instead: the same dose, at the same minute, on the
  // quiet channel with no escalations. It needs no push service, no token, and no network AT
  // DOSE TIME — the phone already synced the schedule and can remind itself from data it has
  // held for hours, which a push cannot do when the signal is gone. See `toQuietRules` for why
  // BOTH the channel and the `critical` flag have to be cleared for it to stay silent.
  const config = await getSyncConfig().catch(() => null);
  const owned = await listOwnedProfileIds(config?.deviceId ?? null);

  const profiles = await listProfiles(); // every non-archived profile; ownership decides LOUD vs QUIET
  const perProfileRules: AlarmRule[][] = [];
  const exceptions: AlarmException[] = [];
  for (const profile of profiles) {
    const medicines = await listActiveMedicines(profile.id);
    const schedulesByThread = await getCurrentSchedulesForThreads(
      medicines.map((m) => m.threadId),
    );
    const rules = buildAlarmRules(medicines, schedulesByThread);
    // The owner's phone rings; every other member device schedules the same dose quietly.
    perProfileRules.push(owned.has(profile.id) ? rules : toQuietRules(rules));
    exceptions.push(...(await listHorizonOverrides(profile.id, fromDate)));
  }

  return publishHorizon(buildDeviceHorizon(now, perProfileRules, exceptions));
}
