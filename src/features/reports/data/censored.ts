/**
 * A reading the meter refused to put a number on, and the arithmetic of what may
 * honestly be said about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A LO IS NOT A MISSING VALUE. IT IS AN INEQUALITY THE INSTRUMENT PRODUCED.
 *
 * A glucometer has an analytical measuring range. Below the floor it prints LO, above
 * the ceiling HI. Neither is an error — an unreadable strip gives an E-code instead —
 * and both are the readings a clinician acts on first. What the meter asserted when it
 * printed LO is `glucose < 20 mg/dL`, where 20 is that meter's floor. That is a fact
 * with real content, and the app throws away half of it if it records only the
 * direction.
 *
 * So `reading.qualifier_bound` stores the limit, `reading.v1` stays NULL, and a database
 * trigger refuses any row carrying both (see migration v4). This module is the single
 * place that turns the pair back into words and into comparisons.
 *
 * THE ONE RULE EVERYTHING HERE EXISTS TO ENFORCE: the bound is never printed as a bare
 * number. `20` in a value column is indistinguishable from a measurement to the next
 * reader — a spreadsheet, a script, a doctor. `below 20 mg/dL` is not. Every exported
 * surface goes through a function in this file so there is one place to check.
 *
 * NOTHING HERE IS A VERDICT. `censoredVsTarget` answers "does the record PROVE this sits
 * outside the range a named human wrote down", which is arithmetic on an inequality, not
 * an opinion about the patient. When the record does not prove it, it says so, and the
 * caller must print that rather than pick a side.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PURE, AND NO RUNTIME IMPORTS. It is loaded by the Node type-stripping test runner and
 * unit-tested in `./censored.test.ts`.
 */

import type { ValueQualifier } from '../../../types';
import { formatNumber } from '../lib/format';

/** Which end of the instrument's range the reading fell off. */
export type CensoredDirection = 'below' | 'above';

/** 'below' for a meter showing LO, 'above' for HI, null for an ordinary reading. */
export function censoredDirection(qualifier: ValueQualifier): CensoredDirection | null {
  if (qualifier === 'below_range') return 'below';
  if (qualifier === 'above_range') return 'above';
  return null;
}

export function isCensored(qualifier: ValueQualifier): boolean {
  return censoredDirection(qualifier) !== null;
}

/** The two letters the meter itself displayed. Not a translation — it is what she saw. */
export function meterWord(direction: CensoredDirection): 'LO' | 'HI' {
  return direction === 'below' ? 'LO' : 'HI';
}

/**
 * A bound is only usable if it is a real, finite number.
 *
 * A meter range of zero or less is not a quiet "unknown"; it is a row that means nothing,
 * and drawing an inequality against it would put an unexplained number under a real
 * reading. Treated exactly as "no range recorded", which is a fully supported state.
 */
export function usableBound(bound: number | null | undefined): bound is number {
  return typeof bound === 'number' && Number.isFinite(bound) && bound > 0;
}

/** 'below 20 mg/dL' / 'above 600 mg/dL'. Empty when no range was ever recorded. */
export function inequalityText(
  direction: CensoredDirection,
  bound: number | null,
  unit: string,
): string {
  if (!usableBound(bound)) return '';
  const unitPart = unit ? ` ${unit}` : '';
  return `${direction === 'below' ? 'below' : 'above'} ${formatNumber(bound)}${unitPart}`;
}

/**
 * The sentence the appendix, the day card and the delta table all print.
 *
 * With a range recorded: 'Meter showed LO (below 20 mg/dL)'.
 * Without one:          'Meter showed LO'.
 *
 * The second form is not a degraded record — it is the honest one when nobody has told
 * the app what the meter's range is. It is also the sentence that makes filling that in
 * worth doing, which is why it says nothing apologetic.
 */
export function censoredValueText(
  qualifier: ValueQualifier,
  bound: number | null,
  unit: string,
): string | null {
  const direction = censoredDirection(qualifier);
  if (!direction) return null;
  const inequality = inequalityText(direction, bound, unit);
  return inequality ? `Meter showed ${meterWord(direction)} (${inequality})` : `Meter showed ${meterWord(direction)}`;
}

/**
 * The unit that belongs in a UNIT COLUMN beside `censoredValueText`, which is none.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT A LINE IN EACH RENDERER ──────────────────
 * `censoredValueText` already ends in the unit, inside the inequality where it modifies
 * the bound it actually describes. A unit column that then prints it again gives the OPD
 * appendix 'Meter showed LO (below 20 mg/dL) | mg/dL' — a stutter in the one row a reader
 * is sent to BY the chart's own caption, and the row where the reading has to be read
 * carefully rather than skimmed.
 *
 * `formatReadingUnit` in `src/app/_shared/lib.tsx` has enforced this on the app screens
 * since the censored qualifier existed; the printed report had no equivalent and drifted.
 * Both now come through here, so the page a doctor holds and the screen she reads cannot
 * disagree about it.
 */
export function censoredUnitText(qualifier: ValueQualifier, unit: string): string {
  return censoredDirection(qualifier) === null ? unit : '';
}

/**
 * The same fact in the day card's voice — a card forwarded through WhatsApp, read by a
 * daughter-in-law rather than a physician. 'LO on the meter (below 20 mg/dL)'.
 */
export function censoredDayCardText(
  qualifier: ValueQualifier,
  bound: number | null,
  unit: string,
): string | null {
  const direction = censoredDirection(qualifier);
  if (!direction) return null;
  const inequality = inequalityText(direction, bound, unit);
  return inequality
    ? `${meterWord(direction)} on the meter (${inequality})`
    : `${meterWord(direction)} on the meter`;
}

/**
 * DECIDABILITY. Whether the record PROVES a censored reading sits outside a target band.
 *
 * LO means `v < B`. A target floor says `v ≥ L`.
 *   • B ≤ L  →  v < B ≤ L, so `v < L` is proven. It IS outside. Count it, no hedging.
 *   • B > L  →  v could sit anywhere below B, including between L and B. Undecidable.
 *   • B unknown → undecidable.
 * HI is the mirror image: `v > B` against a ceiling `v ≤ H` is proven when B ≥ H.
 *
 * WHY THIS FUNCTION EXISTS EVEN THOUGH NOTHING COUNTS OUT-OF-RANGE READINGS TODAY.
 * The app publishes no "9 of 30 mornings were outside the target" figure, and it should
 * not acquire one casually. But the first person to write one will reach for the obvious
 * two implementations, and both are wrong in the same silent way: substituting the bound
 * and comparing it biases the count in the safe-looking direction, and dropping censored
 * readings deletes the loudest results in the period from the summary entirely. The rule
 * is written down here, with the proof, so that a future count is either right or does
 * not compile.
 *
 * In practice B ≤ L holds for every real target a clinician writes, so the common case
 * counts cleanly. The rule exists so the uncommon case fails loudly instead of quietly.
 */
export type CensoredComparison = 'outside' | 'undecidable';

export function censoredVsTarget(
  direction: CensoredDirection,
  bound: number | null,
  target: { low: number | null; high: number | null } | null,
): CensoredComparison {
  if (!target || !usableBound(bound)) return 'undecidable';
  if (direction === 'below') {
    return target.low !== null && bound <= target.low ? 'outside' : 'undecidable';
  }
  return target.high !== null && bound >= target.high ? 'outside' : 'undecidable';
}

/**
 * The same proof against another MEASUREMENT rather than a target — which is what the
 * "since your last visit" table needs.
 *
 * A censored reading versus an exact one: LO means `v < B`, so any measurement at or
 * above B is provably higher than it. The MAGNITUDE of the change is never knowable, so
 * no caller may print a difference; only the direction survives, and only sometimes.
 */
export function censoredVsValue(
  direction: CensoredDirection,
  bound: number | null,
  other: number,
): 'lower' | 'higher' | 'undecidable' {
  if (!usableBound(bound) || !Number.isFinite(other)) return 'undecidable';
  if (direction === 'below') return other >= bound ? 'lower' : 'undecidable';
  return other <= bound ? 'higher' : 'undecidable';
}
