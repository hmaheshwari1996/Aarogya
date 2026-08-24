/**
 * "Put the ones I actually use at the top."
 *
 * She asked for the option lists to be sorted most-used first so she does not have to
 * scroll every time. That request is right and the obvious implementation of it is wrong,
 * so this module exists to hold the difference.
 *
 * ── WHY NOT JUST SORT BY COUNT ───────────────────────────────────────────────────
 *
 * The user of this app has a tremor and presbyopia and reads at 1.3× font scale. She taps
 * the same three chips most days. Within a week her finger knows where they are, and that
 * muscle memory is the single biggest speed-up available on a list of twenty-six full-width
 * rows — bigger than any sort.
 *
 * A total re-sort by usage destroys it in three separate ways:
 *
 *   1. THE LIST IS DIFFERENT ON EVERY VISIT. Every recorded symptom changes a count, and
 *      a count change reorders neighbours. The list she learned on Tuesday is not the list
 *      she meets on Wednesday.
 *
 *   2. NEIGHBOURS FLIP ON A DIFFERENCE OF ONE. Recorded 6 times versus 5 times is not a
 *      real preference — it is noise — but a naive comparator treats it as an order.
 *
 *   3. A CHIP CAN MOVE OUT FROM UNDER A FINGER ALREADY DESCENDING, if the order is
 *      recomputed while the screen is open. On this screen that is a wrong symptom
 *      recorded, and the record is what a doctor reads.
 *
 * So this module does something narrower and duller, on purpose:
 *
 *   • It PINS a few clearly-dominant keys into a band at the top, under their own heading.
 *   • Everything else stays in its canonical order — the clinical order, the temporal
 *     order, whatever the list already meant. Nothing is thrown away.
 *   • THE PINNED BAND IS ITSELF IN CANONICAL ORDER, not in count order. So the band's
 *     internal arrangement never changes as counts drift. Only its MEMBERSHIP can change,
 *     and it changes only between visits — never while the screen is open.
 *   • Membership requires a MARGIN over the best contender. Two keys a hair apart are
 *     treated as equally used, and neither is pinned, because the app has no basis for
 *     claiming one is her favourite.
 *
 * ── THE BAND IS ALL-OR-NOTHING, AND THAT IS THE DESIGN, NOT A BUG ────────────────
 *
 * Read this before "fixing" the trim loop, because it looks wrong and is not.
 *
 * The tail trim CASCADES. Counts of cough 10, fever 9, dizzy 8, vomiting 6 pin all three
 * of cough/fever/dizzy — the weakest pinned key clears the best contender by the margin.
 * Record vomiting twice more and it reaches 8, and now the WHOLE BAND DISSOLVES: dizzy 8
 * cannot clear vomiting 8, so it is trimmed; fever 9 then cannot clear dizzy 8, so it is
 * trimmed; cough 10 then cannot clear fever 9, so it is trimmed too. Three chips to none
 * on a single tap, and everything below shifts up by three rows plus a heading and a
 * divider.
 *
 * That is the correct outcome, and the alternative is worse. Once four keys sit at 10, 9,
 * 8, 8 they are one cluster and the app cannot honestly say which of them she prefers.
 * Keeping a band anyway would mean claiming a preference the record does not support, and
 * whichever member the claim landed on would flip again on the next tap — which is the
 * flapping this whole module exists to prevent. When nothing dominates, the app makes NO
 * claim and the list reverts to the canonical clinical order: the same arrangement a fresh
 * install shows, not an arbitrary one. `neighbours a hair apart pin nothing at all` in the
 * test file pins that invariant down.
 *
 * The obvious softening — hysteresis, "once in the band, require margin+1 to leave" —
 * cannot be built here and should not be built elsewhere. It requires knowing what the
 * band was LAST time, which means this function stops being a pure function of (items,
 * counts, options) and starts owning persisted UI state that can disagree with the record
 * it claims to describe. A dissolving band costs one scroll; a stored band that drifts out
 * of step with the counts is a list that is wrong for reasons nobody can reconstruct.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not reorder anything whose ORDER IS THE INFORMATION. Severity mild → moderate →
 * severe is an ordinal scale; 0.5 / 1 / 2 tablets is a quantity; the nine dose slots are a
 * clock; the twenty-six lab tests are grouped by organ panel because that is how a printed
 * lab report is transcribed; "a week / a month / three months" is a duration. Sorting any
 * of those by how often they were picked turns a scale into a jumble. Those lists must not
 * be passed to this module at all — which is why it takes an explicit list and has no
 * "apply everywhere" entry point.
 *
 * It also does not touch the "none of the above" member of a list. `other`, `random` and
 * `any` are fallbacks whose meaning depends on being last; pinning one to the top would
 * start catching taps that belong to a real answer. `neverPin` is how a caller says so.
 *
 * ── PURE, AND ORDERED ONCE ───────────────────────────────────────────────────────
 *
 * Everything here is a pure function of (items, counts, options). It reads nothing and
 * caches nothing. The stability requirement is a CALL-SITE property: call it once when the
 * screen loads — inside the same `useAsync` block that fetches the options — and never
 * again while the screen is open. A screen that recomputed on every render would reorder
 * under her finger no matter how careful this file is.
 *
 * The counts themselves are per-profile, local, and derived from the record (see
 * `countSymptomUsage`). They are a UI convenience and nothing else: no count computed here
 * may reach a report, an export, or a chart. "She tapped this chip nine times" is not a
 * clinical observation.
 *
 * ── ONLY THE SYMPTOM LIST IS PINNED, AND ONLY THE SYMPTOM LIST SHOULD BE ─────────
 *
 * Her report was about option lists in general — "for all options frequently selected,
 * sort them most-selected first so the user does not have to scroll down every time". The
 * operative words are SCROLL DOWN. There is exactly one list in this app long enough to
 * scroll: the symptom chips, twenty-six full-width rows on a profile carrying three
 * condition packs. That is the list this module serves, from `entry/symptom.tsx`.
 *
 * The other two candidates were measured and deliberately left alone:
 *
 *   • The medicine FORM chips (`medicine/new.tsx`) are eight short chips in a wrapping
 *     row — two or three lines, all of it visible at once, with `tablet` preselected.
 *   • The care KIND chips (`care/index.tsx`) are five, in a sheet, also wrapping.
 *
 * Neither is ever scrolled past, so pinning would buy nothing — and it would COST
 * something real, because a band is not just an order: it is a heading, a divider and a
 * second group. Splitting an eight-chip grid that reads at a glance into a band of three
 * and a remainder of five makes it slower to read, not faster, and it moves chips between
 * visits on a screen where nothing was hard to find. `countMedicineFormUsage` and
 * `countCareKindUsage` were written for that and have been deleted rather than left
 * sitting in the repositories reading as though they were wired up.
 *
 * The rule for the next long list: pin it when it scrolls, not when it repeats.
 */

/** One key and how many times this profile has chosen it. Missing keys count as zero. */
export type UsageCount = {
  readonly key: string;
  readonly count: number;
};

export type PinOptions = {
  /**
   * How many keys may sit in the pinned band. Three, by default: a band that fills the
   * screen is a second list, and the point of the band is that it is glanceable.
   */
  maxPinned?: number;
  /**
   * How many times a key must have been chosen before it is a candidate at all. Below
   * this, the "most used" claim is being made from one or two taps.
   */
  minCount?: number;
  /**
   * How far ahead of the best unpinned contender a key must be. This is the anti-flap
   * rule: at the default of 2, "six times versus five" pins nothing, because the app
   * cannot honestly tell those apart.
   */
  margin?: number;
  /**
   * Keys that are OUT OF THE COMPETITION ALTOGETHER — not pinnable, and not counted as a
   * contender either. See the header: these are the "none of the above" members whose
   * position is fixed by their meaning, not earned by use.
   *
   * Excluding them from the contender side too is deliberate. `any` on the food-relation
   * list is the DEFAULT choice and will out-tap everything for the life of the app; if it
   * were allowed to set the bar, the band could never form on that list at all. A member
   * that cannot move is not competing for the top of the list.
   */
  neverPin?: readonly string[];
};

export type PinnedOrder<T> = {
  /** In CANONICAL order, not count order. Empty whenever nothing dominates clearly. */
  readonly pinned: readonly T[];
  /** Everything else, in the order it was given. Never contains a pinned item. */
  readonly rest: readonly T[];
};

const DEFAULT_MAX_PINNED = 3;
const DEFAULT_MIN_COUNT = 3;
const DEFAULT_MARGIN = 2;

/**
 * Splits a canonical list into a small pinned band and the untouched remainder.
 *
 * `items` is the list in its canonical order — the order it would render in if nobody had
 * ever tapped anything. That order is the tie-break for everything below, which is what
 * makes an empty history render exactly today's arrangement.
 *
 * With no counts, no history, or nothing dominant, this returns `{ pinned: [], rest: items }`
 * and the caller renders precisely what it renders today. That is the intended common case
 * for a new install and it must stay a no-op.
 */
export function pinMostUsed<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  counts: readonly UsageCount[],
  options: PinOptions = {},
): PinnedOrder<T> {
  const maxPinned = options.maxPinned ?? DEFAULT_MAX_PINNED;
  const minCount = options.minCount ?? DEFAULT_MIN_COUNT;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const neverPin = new Set(options.neverPin ?? []);

  if (items.length === 0 || maxPinned <= 0) return { pinned: [], rest: items };

  const countFor = new Map<string, number>();
  for (const entry of counts) {
    // Duplicate keys are summed rather than last-one-wins: two callers merging two
    // count sources (say, a lifetime count and a recent one) should not silently lose
    // half their data to a Map overwrite.
    const previous = countFor.get(entry.key) ?? 0;
    countFor.set(entry.key, previous + Math.max(0, entry.count));
  }

  type Ranked = { item: T; key: string; count: number; index: number };
  const ranked: Ranked[] = items.map((item, index) => {
    const key = keyOf(item);
    return { item, key, count: countFor.get(key) ?? 0, index };
  });

  // Two different exclusions, and they are not the same exclusion.
  //
  //   • `neverPin` leaves the competition entirely (see PinOptions) — it is neither a
  //     candidate nor a contender.
  //   • A key merely below `minCount` is still a CONTENDER: it cannot be pinned on two
  //     taps, but a candidate one tap ahead of it has not earned the band either.
  const competing = ranked.filter((row) => !neverPin.has(row.key));
  const candidates = competing
    .filter((row) => row.count >= minCount)
    .sort((a, b) => b.count - a.count || a.index - b.index);

  let take = candidates.slice(0, maxPinned);

  // Trim from the tail until the weakest pinned key clears the best unpinned one by the
  // margin. Trimming from the TAIL rather than filtering each row independently is what
  // keeps the result sane when everything is bunched: counts of 10, 9, 8, 8 pin nothing,
  // because no single one of them is distinguishable from the next.
  while (take.length > 0) {
    const weakest = take[take.length - 1];
    if (!weakest) break;
    const taken = new Set(take.map((row) => row.key));
    let bestOther = 0;
    for (const row of competing) {
      if (taken.has(row.key)) continue;
      if (row.count > bestOther) bestOther = row.count;
    }
    if (weakest.count - bestOther >= margin) break;
    take = take.slice(0, -1);
  }

  if (take.length === 0) return { pinned: [], rest: items };

  const pinnedKeys = new Set(take.map((row) => row.key));
  // Back into canonical order. This is the line that makes the band stable: its contents
  // are arranged by the clinical order, so a count changing can add or remove a member
  // but can never shuffle the ones already there.
  const pinned = ranked.filter((row) => pinnedKeys.has(row.key)).map((row) => row.item);
  const rest = ranked.filter((row) => !pinnedKeys.has(row.key)).map((row) => row.item);

  return { pinned, rest };
}
