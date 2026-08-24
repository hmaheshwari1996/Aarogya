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
  // Never move a ring in the past; the override only matters from today forward.
  const fromDate = toLocalDate(new Date(now));

  const profiles = await listProfiles(); // non-archived only
  const perProfileRules: AlarmRule[][] = [];
  const exceptions: AlarmException[] = [];
  for (const profile of profiles) {
    const medicines = await listActiveMedicines(profile.id);
    const schedulesByThread = await getCurrentSchedulesForThreads(
      medicines.map((m) => m.threadId),
    );
    perProfileRules.push(buildAlarmRules(medicines, schedulesByThread));
    exceptions.push(...(await listHorizonOverrides(profile.id, fromDate)));
  }

  return publishHorizon(buildDeviceHorizon(now, perProfileRules, exceptions));
}
