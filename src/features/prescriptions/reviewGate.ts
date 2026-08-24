/**
 * The two decisions the review screen makes about a proposed frequency — lifted out of the
 * screen so they can be asserted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * `propose.ts` is careful, pure and heavily tested, and none of that protects the thing it
 * was written to protect. Its whole safety argument rests on a claim that lives somewhere
 * else entirely: that the SCREEN, having been handed a corroborated number, still requires
 * an act before that number may become a reminder. Two lines in `review.tsx` carried the
 * claim —
 *
 *     dosesPerDayText: frequency.kind === 'proposal' ? String(frequency.dosesPerDay) : '',
 *     freqAnswer:      frequency.kind === 'proposal' ? 'unanswered' : 'own',
 *
 * — and nothing could reach them. `src/app/prescription/review.tsx` imports React Native
 * and resolves through the `@/*` alias, so `node --test --experimental-strip-types` cannot
 * load it; `tsc` is happy either way, because seeding `'agreed'` is perfectly well-typed.
 * The single most dangerous edit anybody could make to this feature was therefore the one
 * edit no gate could see.
 *
 * That is what these functions are for. They hold no React, no theme, no strings and no
 * runtime import of any kind (`FrequencyProposal` arrives through `import type`, which is
 * erased), so the file loads under the test runner as plain TypeScript and the invariant
 * below is pinned by `reviewGate.test.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT, STATED ONCE
 *
 *   A number may be SEEDED into the field. `freqAnswer` is 'unanswered' whenever one is.
 *
 * A number without the question attached is a default, and a default is accepted by doing
 * nothing — which is exactly the failure `trg_occ_requires_confirmed_schedule` cannot see.
 * That trigger knows whether a human confirmed a schedule; it has no way of knowing whether
 * the human confirmed a number she read or a number she scrolled past. Only the screen can
 * hold that line, and only if `seedFrequency` and `blockingReason` agree with each other:
 * the first puts a proposition on screen, the second refuses to let the proposition through
 * until it has been answered.
 *
 * The specific "improvement" this file exists to fail: seeding `'agreed'` alongside the
 * number, or deleting `freqAnswer` and inferring acceptance from the box being non-empty.
 * Either turns fifteen confirmations into one scroll and one tap, and neither changes a
 * single type.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE GATE IS ONE FUNCTION AND NOT FIVE PREDICATES
 *
 * `blockingReason` answers the confirm button, the per-card "Not Ready" marker, the footer
 * count, the jump to the first unfinished card, and the split between what the reminder
 * preview lists and what it holds back. Those five used to be one inline `included.some(…)`
 * and four things that did not exist. Adding them as separate copies is precisely how the
 * button ends up dead while every card on screen claims to be fine — the report that
 * produced this work in the first place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Type-only, and it must stay that way: a value import from `./propose` would pull in
// `./frequency`, and a later value import from anywhere would pull in the database layer
// through `./confirm`. This module's testability is the point of it.
import type { FrequencyProposal } from './propose';

/**
 * The largest number the doses-per-day field will accept.
 *
 * NOT `MAX_AI_DOSES_PER_DAY`, and the two must not be merged. Four is the most this app
 * will schedule FROM A PHOTOGRAPH; twelve is the most a person may type before the field
 * calls it a slip. A medicine between the two is accepted, saved, and handed to manual
 * timing entry — refusing to record it would be the app arguing with a prescription.
 */
export const MAX_DOSES_PER_DAY = 12;

/**
 * Where the number in the doses-per-day field stands. THE START STATE IS THE WHOLE POINT.
 *
 *   'unanswered' — the proposal is in the box and she has said nothing about it. The
 *                  confirm button is inert and the card says which line is holding it.
 *                  Every proposed line starts here; nothing seeds 'agreed'.
 *   'agreed'     — she read the paper's words above the box and said the number matches.
 *   'own'        — the number is hers: typed, stepped, or the proposal declined. A line
 *                  with no proposal starts here, which is exactly the behaviour this
 *                  screen had before proposals existed.
 */
export type FrequencyAnswer = 'unanswered' | 'agreed' | 'own';

/**
 * What KIND of instruction this line carries — and the reason a dose count is not always
 * the answer to "how often".
 *
 *   'per_day'   — a number of doses every day. The ordinary case, and the default: a line
 *                 arrives here and stays here until she says otherwise.
 *   'as_needed' — SOS / PRN. The paper says "when needed", so there is no count to give.
 *   'one_off'   — STAT. One dose, already given. Not a recurring schedule.
 *
 * WHY THIS EXISTS AT ALL. `propose.ts` reads "SOS" correctly and refuses to propose a
 * number for it — `as_needed` and `one_off` are its two POSITIVE refusals, answers rather
 * than failures — and the card duly printed "The paper says this one is taken only when
 * needed." directly above a gate demanding a daily dose count. There was no third answer
 * on the screen, so a ticked PRN painkiller could only be saved by typing a number that
 * would then ring every day, or by taking the tick off and recording nothing at all. On a
 * discharge summary carrying an SOS analgesic and a STAT injection, both of those are
 * wrong, and one of them rings.
 *
 * NEITHER VALUE IS EVER SEEDED. Both are transcriptions of what the paper says, but the
 * app does not make them on her behalf: the line starts 'per_day' with an empty box, and
 * the gate below holds it until she either types a count or names the kind. The invariant
 * above is unchanged — nothing here is accepted by doing nothing.
 */
export type DoseTiming = 'per_day' | 'as_needed' | 'one_off';

/** What `seedFrequency` decides, and the only two draft fields it is allowed to touch. */
export type FrequencySeed = {
  /** '' whenever the proposal was withheld — an empty box she fills in, as before. */
  readonly dosesPerDayText: string;
  readonly freqAnswer: FrequencyAnswer;
};

/**
 * Turn one proposal into the two fields a fresh draft starts life with.
 *
 * READ THE TWO BRANCHES TOGETHER: they are the same decision stated twice, and they are
 * what `reviewGate.test.ts` asserts. A refusal produces EXACTLY the state that shipped
 * before proposals existed — empty box, `'own'`, she types — which is the property that
 * makes the whole feature safe: the worst a withheld proposal can cost her is one typed
 * digit, so this can improve on the status quo and cannot be worse than it.
 *
 * A proposal produces a number AND the open question, never a number alone.
 */
export function seedFrequency(proposal: FrequencyProposal): FrequencySeed {
  if (proposal.kind !== 'proposal') return { dosesPerDayText: '', freqAnswer: 'own' };
  return { dosesPerDayText: String(proposal.dosesPerDay), freqAnswer: 'unanswered' };
}

/**
 * '2' → 2. Anything that is not a plain whole number in range → null.
 *
 * Null is the gate's "not filled in", so this is deliberately strict about what counts as
 * a number: '', ' ', '0', '13' and '2.5' are all not-a-dose-count.
 *
 * THE SHAPE IS CHECKED BEFORE THE VALUE, and both surprises that forces are worth naming.
 * `Number('1e1')` is 10 and `Number('२')` is 2 — so a range check written over `Number`
 * alone accepts exponent notation as ten doses a day and Devanagari numerals as ASCII
 * ones. Neither can be produced by the review screen today (its field is a number pad and
 * its `onChangeText` strips everything outside `[0-9]`), which is exactly why the guard
 * belongs HERE rather than being left to that strip: this function is exported, the strip
 * is in a screen, and a second caller would inherit the surprise with nothing to warn it.
 * `Number('')` is 0, which is why the empty check comes first rather than relying on the
 * range.
 */
export function parseDoses(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DOSES_PER_DAY) return null;
  return value;
}

/**
 * The subset of a review draft the gate reads. Structural on purpose — the screen's `Draft`
 * satisfies it without declaring that it does, so this module never has to know about
 * supersession threads, criticality or parsed extractions.
 */
export type ReviewLine = {
  /** Unticked lines are not going to be created, so they are never blocking. */
  readonly include: boolean;
  readonly name: string;
  readonly dosesPerDayText: string;
  readonly freqAnswer: FrequencyAnswer;
  /**
   * 'per_day' unless she has named the line as as-needed or a single dose. Required, not
   * optional: a screen that forgot to carry it would silently reinstate the old gate on
   * every PRN line, and an optional field defaulting to 'per_day' is exactly how that
   * would go unnoticed.
   */
  readonly doseTiming: DoseTiming;
  /** Field names the extractor was unsure of, plus 'frequency' whenever one was proposed. */
  readonly flagged: readonly string[];
  readonly touched: Readonly<Record<string, boolean>>;
};

export type BlockReason = 'name' | 'doses' | 'freq_unanswered' | 'unchecked';

/**
 * Why one ticked medicine is not ready, or null when it is.
 *
 * AN UNTICKED LINE IS NEVER BLOCKING. It is not going to be created, so demanding she
 * proof-read it would be a wall between her and a prescription she has already decided
 * about. And the tick itself is deliberately NOT gated on completeness: she has to be able
 * to mark a line as wanted before she has finished checking it, or the screen refuses to
 * hold the thing she came here to say.
 *
 * THE ORDER IS THE MESSAGE. Only one reason is ever shown, so it has to be the first thing
 * she can act on. The two frequency cases are split because they are different jobs — an
 * empty box wants a number typed off the paper, an unanswered proposal wants her eyes on
 * the photograph and one tap — and collapsing them into "check the frequency" would send
 * her looking for the wrong thing.
 *
 * `freq_unanswered` sits AFTER `doses` and that ordering carries weight: declining a
 * proposal empties the box, so a declined-and-not-yet-retyped line must ask for the number
 * rather than re-ask a question she has already answered.
 *
 * A LINE THAT IS NOT TAKEN A NUMBER OF TIMES A DAY IS NOT MISSING A NUMBER. `doseTiming`
 * is the only thing that lifts the count requirement, and it is only ever set by her
 * naming the line — so this is a different answer to the question, never an exemption
 * from it. Everything after this point still applies: an as-needed line with an untouched
 * flagged field is as blocked as any other.
 */
export function blockingReason(line: ReviewLine): BlockReason | null {
  if (!line.include) return null;
  if (line.name.trim().length === 0) return 'name';
  if (line.doseTiming === 'per_day' && parseDoses(line.dosesPerDayText) === null) return 'doses';
  if (line.freqAnswer === 'unanswered') return 'freq_unanswered';
  if (line.flagged.some((field) => !line.touched[field])) return 'unchecked';
  return null;
}

/**
 * WHICH marked place is still unvisited — the direction that `'unchecked'` cannot carry.
 *
 * `BlockReason` is deliberately left alone: it is a closed union with a sentence per member
 * in both languages, and widening it to one member per field would multiply that table by
 * the field list and make every new flaggable field a `check:i18n` failure for no gain.
 * The reason code stays the same; this answers the separate question of what to point at.
 *
 * WHY IT IS NEEDED AT ALL. `flaggedFields` adds `name`, `strength` AND `quantity` together
 * the moment the extractor sets `needsHumanCheck`, so one card can carry three marked
 * fields — and at OS 1.3× a `DraftCard` is taller than the window, so the marker at the top
 * of the card and the field it is about are never on screen together. "A marked place on
 * this card has not been looked at yet" is then a rule rather than a direction, one level
 * down and inside the fix for exactly that complaint: she is left scanning for amber icons
 * on a card whose every warning uses the same glyph.
 *
 * THE ORDER MATCHES `blockingReason`'s `.some(…)` BY CONSTRUCTION — same array, same
 * predicate, first hit. Two traversals that could disagree are how the marker would name a
 * field she has already visited while the button stays down for a different one.
 *
 * Null whenever nothing is outstanding, so a caller may ask without first asking why.
 */
export function firstUncheckedField(line: ReviewLine): string | null {
  return line.flagged.find((field) => !line.touched[field]) ?? null;
}
