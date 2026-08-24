/**
 * The adherence block on the doctor's page — the single most dangerous thing this app
 * prints, and therefore the one piece of the report that is pure and unit-tested.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR RULES, NONE OF THEM NEGOTIABLE
 *
 *  1. THE WORD "MISSED" NEVER APPEARS. The app knows what was tapped. It does not know
 *     what was swallowed. The phrase for a dose with nothing recorded is
 *     "not recorded as taken", and there is no shorter way to say it honestly.
 *
 *  2. THE SPLIT IS ALWAYS THREE-WAY: recorded taken / recorded not taken / no record.
 *     Collapsing the third bucket into the second turns missing data into refusal, and
 *     a two-segment bar is a two-segment lie.
 *
 *  3. A NULL PERCENT PRINTS THE REASON, NEVER A NUMBER. `summariseAdherence` suppresses
 *     the percentage after three consecutive silent days because a run of no-record days
 *     is missing data, not evidence of non-adherence — the phone was off, the OEM killed
 *     the alarm process, she was in hospital, or she took every dose and never opened the
 *     app. A physician reading "31%" over a week-long hole in a TB patient's record may
 *     escalate to directly-observed therapy or record non-compliance in her notes.
 *     Changing a person's treatment over an artefact the app manufactured is the worst
 *     thing this feature could do.
 *
 *  4. `adherenceDisclaimer()` IS PRINTED EVERY TIME. It is the difference between a
 *     claim the app can support and one it cannot. The caller must pass it; a blank one
 *     throws rather than rendering a number with nothing qualifying it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NO BADGES, NO STREAKS, NO GAMIFICATION — here or anywhere else on a doctor-facing
 * surface. `streak_state` and `badge` exist to keep a patient going; rendering either on
 * a clinical page turns a private encouragement into a performance review conducted in
 * front of her physician.
 *
 * PURE, with no runtime imports (only the erased `import type`), so Node's type-stripping
 * test runner can load it on its own. That is also why the two-line HTML escaper below is
 * duplicated from `../lib/html` rather than imported.
 */

import type { AdherenceSummary } from '../../../types';

export type AdherenceWindowInput = {
  /** 'Last 7 days', 'Since treatment started (12 Feb 2026)'. */
  label: string;
  summary: AdherenceSummary;
};

export type AdherenceSectionInput = {
  /** The figure at the top of the block, with the period it covers. */
  primary: AdherenceWindowInput;
  /** Secondary windows shown as a small table. May be empty. */
  windows: readonly AdherenceWindowInput[];
  /** Verbatim `adherenceDisclaimer()`. Required, and required to be non-empty. */
  disclaimer: string;
  /** Defaults to the wording used by the `report.section.adherence` translation key. */
  heading?: string;
};

/** The only phrase this app uses for a dose with nothing recorded either way. */
export const NO_RECORD_PHRASE = 'not recorded as taken';

const SEGMENT_LABELS = {
  taken: 'Recorded as taken',
  notTaken: 'Recorded as not taken',
  noRecord: 'No record either way',
} as const;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

/**
 * The sentence printed where a percentage would have gone.
 *
 * `summariseAdherence` already composes the honest reason ("Records incomplete for 3
 * days (2–4 Aug)", "No scheduled doses in this period."). It is printed verbatim; the
 * fallback exists only so a future summary that forgets to explain itself still cannot
 * publish a bare number.
 */
export function suppressionText(summary: AdherenceSummary): string {
  if (summary.suppressedReason && summary.suppressedReason.trim().length > 0) {
    return summary.suppressedReason.trim();
  }
  return 'A percentage is not shown: the record for this period is not complete enough to support one.';
}

/**
 * PURE. The headline for one window — either a percentage with its denominator, or the
 * reason there is no percentage. Never both, and never a number when `percent` is null.
 */
export function adherenceHeadline(summary: AdherenceSummary): string {
  if (summary.percent === null) return suppressionText(summary);
  return `${summary.recordedTaken} of ${summary.due} scheduled doses recorded as taken (${summary.percent}%)`;
}

function renderSplitBar(summary: AdherenceSummary): string {
  const total = summary.due;
  const widths = {
    taken: pct(summary.recordedTaken, total),
    notTaken: pct(summary.recordedNotTaken, total),
    noRecord: pct(summary.noRecord, total),
  };

  // Fill, stripe and dashed outline — three visual treatments that survive a monochrome
  // printer and a red/green-deficient reader. Every segment also carries its word and
  // its count in the key below, so the bar is never the only place the split is stated.
  return [
    '<div class="adh-bar" role="img" aria-label="Three-way split of scheduled doses">',
    `<span class="adh-seg adh-seg--taken" style="width:${widths.taken.toFixed(2)}%"></span>`,
    `<span class="adh-seg adh-seg--not-taken" style="width:${widths.notTaken.toFixed(2)}%"></span>`,
    `<span class="adh-seg adh-seg--no-record" style="width:${widths.noRecord.toFixed(2)}%"></span>`,
    '</div>',
    '<ul class="adh-key">',
    `<li><span class="adh-swatch adh-seg--taken"></span>${esc(SEGMENT_LABELS.taken)}: <strong>${
      summary.recordedTaken
    }</strong></li>`,
    `<li><span class="adh-swatch adh-seg--not-taken"></span>${esc(SEGMENT_LABELS.notTaken)}: <strong>${
      summary.recordedNotTaken
    }</strong></li>`,
    `<li><span class="adh-swatch adh-seg--no-record"></span>${esc(SEGMENT_LABELS.noRecord)} (${esc(
      NO_RECORD_PHRASE,
    )}): <strong>${summary.noRecord}</strong></li>`,
    `<li class="adh-key__total">Scheduled doses counted: <strong>${summary.due}</strong></li>`,
    '</ul>',
  ].join('');
}

function renderWindowRow(row: AdherenceWindowInput): string {
  const { summary } = row;
  const figure = summary.percent === null ? '—' : `${summary.percent}%`;
  const note = summary.percent === null ? suppressionText(summary) : '';
  return [
    '<tr>',
    `<td>${esc(row.label)}</td>`,
    `<td class="num">${esc(figure)}</td>`,
    `<td class="num">${summary.recordedTaken}</td>`,
    `<td class="num">${summary.recordedNotTaken}</td>`,
    `<td class="num">${summary.noRecord}</td>`,
    `<td class="num">${summary.due}</td>`,
    `<td class="adh-note">${esc(note)}</td>`,
    '</tr>',
  ].join('');
}

export function renderAdherenceSection(input: AdherenceSectionInput): string {
  const disclaimer = input.disclaimer.trim();
  if (disclaimer.length === 0) {
    // Deliberately fatal. A number on this page without the sentence that says what the
    // number is worth is the exact artefact this whole feature exists to avoid.
    throw new Error(
      'renderAdherenceSection: the adherence disclaimer is required. Pass adherenceDisclaimer().',
    );
  }

  const heading = input.heading ?? 'Reminder record';
  const primary = input.primary;
  const suppressed = primary.summary.percent === null;

  const parts: string[] = [];
  parts.push('<section class="section section--adherence">');
  parts.push(`<h2>${esc(heading)}</h2>`);
  parts.push(`<p class="adh-period">${esc(primary.label)}</p>`);

  if (suppressed) {
    // The reason takes the visual weight the number would have had, so a reader
    // skimming for a percentage lands on the explanation instead of on nothing.
    parts.push(`<p class="adh-suppressed">${esc(suppressionText(primary.summary))}</p>`);
    parts.push(
      '<p class="adh-suppressed__why">A run of days with no entry is missing information, not a record of doses not taken. No percentage is shown for this period.</p>',
    );
  } else {
    parts.push(`<p class="adh-headline">${esc(adherenceHeadline(primary.summary))}</p>`);
  }

  if (primary.summary.due > 0) parts.push(renderSplitBar(primary.summary));

  if (primary.summary.longestNoRecordRun > 0) {
    const days = primary.summary.longestNoRecordRun;
    parts.push(
      `<p class="adh-run">Longest run of days with no entry either way: <strong>${days}</strong> ${
        days === 1 ? 'day' : 'days'
      }.</p>`,
    );
  }

  if (input.windows.length > 0) {
    parts.push('<table class="adh-windows">');
    parts.push(
      '<thead><tr><th>Period</th><th class="num">Recorded taken</th><th class="num">Taken</th><th class="num">Not taken</th><th class="num">No record</th><th class="num">Scheduled</th><th>Note</th></tr></thead>',
    );
    parts.push('<tbody>');
    for (const row of input.windows) parts.push(renderWindowRow(row));
    parts.push('</tbody></table>');
  }

  parts.push(`<p class="disclaimer">${esc(disclaimer)}</p>`);
  parts.push(
    '<p class="disclaimer">Days the patient recorded as away — a hospital stay, a stretch with family — are left out of the count entirely.</p>',
  );
  parts.push('</section>');

  return parts.join('\n');
}
