/**
 * The briefcase's display order — the one piece of the list screen worth testing on its
 * own.
 *
 * ─── WHY THIS LIVES IN features/, NOT IN THE SCREEN ───────────────────────────
 * Same reason `reviewGate.ts` does: a pure rule a test must reach cannot sit under
 * `src/app`. Two things forbid it there — `npm test` runs under a loader that resolves
 * neither the `@/*` alias nor React Native, and expo-router's `require.context` routes
 * EVERY file under `src/app` (test files included), so a `*.test.ts` there fails the
 * bundle export on `node:assert`. Kept here, the comparator is reachable by a test and the
 * screen is the only thing that imports it.
 */

import type { DocumentRecord } from '@/db/repositories/contacts';

export type BriefcaseSort = 'recent' | 'name' | 'kind';

/**
 * Order a set of papers for one section.
 *
 * The kind LABEL is passed in, never derived here, because the sort has to agree with the
 * words she reads on the row — 'Discharge Summary' — not the storage key `discharge_summary`,
 * which groups the papers in an order she recognises nowhere. `index.tsx` hands in
 * `t(kindLabelKey(kind))`.
 *
 * Name and kind both fall back to newest-first, so the order is total and stable and two
 * papers with the same name (or the same kind) still land in a defined, sensible order
 * instead of wherever `Array.sort` last left them.
 *
 * `localeCompare` with no explicit locale is the ceiling: enough to alphabetise a
 * household's folder, not a full Hindi collation.
 * ponytail: default-locale compare — swap in an `Intl.Collator(lang)` if real collation
 * ever matters, which for a few dozen papers it does not.
 */
export function sortDocuments(
  docs: readonly DocumentRecord[],
  sort: BriefcaseSort,
  kindLabelOf: (kind: string) => string,
): DocumentRecord[] {
  const byNewest = (a: DocumentRecord, b: DocumentRecord): number =>
    b.createdAtEpoch - a.createdAtEpoch;

  const copy = [...docs];
  if (sort === 'name') {
    copy.sort((a, b) => a.title.localeCompare(b.title) || byNewest(a, b));
  } else if (sort === 'kind') {
    copy.sort(
      (a, b) => kindLabelOf(a.kind).localeCompare(kindLabelOf(b.kind)) || byNewest(a, b),
    );
  } else {
    copy.sort(byNewest);
  }
  return copy;
}
