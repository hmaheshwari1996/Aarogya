/**
 * The archive decision, kept pure so it can be tested without the database.
 *
 * `archiveProfile` in ./profiles.ts is mostly SQL; the part that can be wrong in a way tsc
 * cannot see is the branching, so it lives here as one function that imports nothing.
 *
 * Two invariants it holds, both of which strand or corrupt the app if dropped:
 *
 *  1. NEVER archive the last patient. A profile holds a health record and archiving is a
 *     soft delete, not a purge — but leaving zero live profiles opens the app to no patient
 *     at all, with no obvious way back in. Refuse it; the screen turns the throw into
 *     "create another patient first".
 *  2. EXACTLY ONE default must survive. Archiving the current default would leave zero
 *     defaults among live profiles, and the app opens on whichever row a query happened to
 *     return first. So archiving the default promotes the oldest remaining profile — the
 *     multi-profile echo of `setDefaultProfile`'s one-default rule.
 *
 * Archiving an unknown or already-archived id is a quiet no-op (target === null), so a
 * double tap cannot throw or double-promote.
 */

export type ArchivePlan = {
  /** False = nothing to do (already archived / unknown id). */
  readonly archive: boolean;
  /** A profile to promote to default because the archived one was default; null otherwise. */
  readonly promoteToDefaultId: string | null;
};

export function planProfileArchive(
  target: { readonly isDefault: boolean } | null,
  liveOtherIdsOldestFirst: readonly string[],
): ArchivePlan {
  if (!target) return { archive: false, promoteToDefaultId: null };
  if (liveOtherIdsOldestFirst.length === 0) {
    throw new Error('archiveProfile: cannot archive the only patient — create another profile first');
  }
  const heir = liveOtherIdsOldestFirst[0] ?? null;
  return { archive: true, promoteToDefaultId: target.isDefault ? heir : null };
}
