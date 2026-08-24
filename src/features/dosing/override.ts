/**
 * Per-day dose-time override — the pure half.
 *
 * "Today, take the 08:00 dose at 10:00" moves ONE occurrence for ONE day and leaves the
 * schedule rule — and therefore every other day — untouched. The occurrence keeps its id
 * and its `time_local` (the slot time, part of that id); only `override_time_local` and the
 * re-derived `scheduled_at_epoch` change. So there is exactly one occurrence for this dose
 * before and after: the original does not stay behind and ring as well.
 *
 * WHY THIS ONE LINE LIVES IN ITS OWN MODULE. `reconcile.ts` recomputes every occurrence's
 * epoch from wall clock on every foreground (that is how a DST shift or a flight moves an
 * alarm instead of stranding it an hour out). Its candidate epoch is derived from the SLOT
 * time, so without this function reconcile would compare a moved 10:00 occurrence against an
 * 08:00 candidate, see them differ, and reset the epoch back to 08:00 — silently undoing the
 * override on the next app open. That is the R2 double-safety bug in reverse: the dose she
 * moved snaps back to its old time. reconcile imports the SQLite layer and so cannot be
 * loaded under the node test runner; this pure function can, which is where the check lives.
 *
 * ── THE NATIVE RING (wired) ───────────────────────────────────────────────────────────
 * `horizon.json` carries recurrence RULES ("08:00 daily") plus a sibling `exceptions` array
 * (`AlarmException`, built by `deviceHorizon.ts` from `dose_occurrence.override_time_local`
 * across every non-archived profile). `Materializer.kt` SHIFTS the matching occurrence's ring
 * to the override time on that one date — it changes only the trigger epoch, keeps the occId
 * built from the ORIGINAL slot time, and never emits a second spec. So a moved dose rings once
 * at the new time (no double, no journal mismatch), and a day with no override is byte-identical
 * to before this feature. An empty `exceptions` array is the norm and changes nothing native.
 */

import { wallClockToEpoch } from '../../lib/datetime';

/**
 * The absolute epoch an occurrence should ring at on its day, honouring a per-day override.
 *
 * `slotEpoch` is the epoch derived from the schedule's own slot time (what reconcile builds
 * for a fresh candidate). When `overrideTimeLocal` is set it wins and is resolved against the
 * SAME local date, so the override survives every reconcile; when it is null the slot time
 * stands. Wall clock stays authoritative either way — nothing here reads a stored epoch.
 */
export function effectiveScheduledEpoch(
  localDate: string,
  overrideTimeLocal: string | null,
  slotEpoch: number,
): number {
  return overrideTimeLocal ? wallClockToEpoch(localDate, overrideTimeLocal) : slotEpoch;
}
