/**
 * The DOTS-style dose calendar for the appendix.
 *
 * Modelled on the paper treatment card a DOTS provider ticks in front of the patient,
 * because that is the artefact a TB or hypertension clinic already knows how to read: one
 * row per medicine, one column per day, one mark per day.
 *
 * WHAT THE MARKS MEAN, AND WHY THERE ARE FOUR OF THEM RATHER THAN TWO:
 *
 *   T   every scheduled dose that day was recorded as taken
 *   N   every scheduled dose that day was recorded as not taken (an explicit decision)
 *   ·   the day passed with nothing recorded either way — MISSING DATA, not a failure
 *   A   the patient recorded being away (a hospital stay, a stretch with family)
 *   1/2 a mixed day, shown as recorded-taken over scheduled
 *   ␣   nothing was scheduled
 *
 * A two-state grid — took it / did not take it — is the version of this table that lies,
 * because it has nowhere to put the day the phone was off. The dashed empty box is the
 * whole reason the calendar is worth printing.
 *
 * Every cell carries a LETTER as well as a fill. The fill alone would vanish on a
 * monochrome fax of a photocopy, which is a realistic fate for this page.
 */

import { formatDate, formatWeekdayShort, parseLocalDate } from '../lib/format';
import { escapeHtml } from '../lib/html';
import type { ReportDose, ReportDoseDay } from '../data/types';

/** Beyond this a row is too narrow to read, so the grid continues in a second table. */
const MAX_COLUMNS_PER_BLOCK = 31;

type CellState = 'taken' | 'not-taken' | 'no-record' | 'away' | 'none';

type Cell = { state: CellState; label: string };

type DayTotals = { due: number; taken: number; notTaken: number; noRecord: number };

function emptyTotals(): DayTotals {
  return { due: 0, taken: 0, notTaken: 0, noRecord: 0 };
}

function cellFor(totals: DayTotals | undefined, isAway: boolean): Cell {
  if (isAway) return { state: 'away', label: 'A' };
  if (!totals || totals.due === 0) return { state: 'none', label: '' };
  if (totals.taken === totals.due) return { state: 'taken', label: 'T' };
  if (totals.notTaken === totals.due) return { state: 'not-taken', label: 'N' };
  if (totals.noRecord === totals.due) return { state: 'no-record', label: '·' };
  return {
    state: totals.taken > 0 ? 'taken' : 'not-taken',
    label: `${totals.taken}/${totals.due}`,
  };
}

export type DoseCalendarInput = {
  doses: readonly ReportDose[];
  /** Supplies the away flag per day, and the contiguous list of dates to draw. */
  days: readonly ReportDoseDay[];
};

export function renderDoseCalendar(input: DoseCalendarInput): string {
  const dates = input.days.map((d) => d.localDate);
  if (dates.length === 0) {
    return '<p class="muted">No scheduled doses in this period.</p>';
  }

  const awayByDate = new Map(input.days.map((d) => [d.localDate, d.isAway]));

  // thread → date → totals. Cancelled and not-yet-due occurrences are not obligations
  // and must not appear as a box the patient failed to fill in.
  const byThread = new Map<string, { name: string; days: Map<string, DayTotals> }>();
  for (const dose of input.doses) {
    if (dose.status === 'cancelled' || dose.status === 'pending' || dose.status === 'snoozed') continue;
    let row = byThread.get(dose.threadId);
    if (!row) {
      row = { name: dose.strength ? `${dose.medicineName} ${dose.strength}` : dose.medicineName, days: new Map() };
      byThread.set(dose.threadId, row);
    }
    const totals = row.days.get(dose.localDate) ?? emptyTotals();
    totals.due += 1;
    if (dose.status === 'taken') totals.taken += 1;
    else if (dose.status === 'skipped') totals.notTaken += 1;
    else totals.noRecord += 1;
    row.days.set(dose.localDate, totals);
  }

  if (byThread.size === 0) {
    return '<p class="muted">No scheduled doses in this period.</p>';
  }

  const rows = [...byThread.values()].sort((a, b) => a.name.localeCompare(b.name));

  const blocks: string[] = [];
  for (let start = 0; start < dates.length; start += MAX_COLUMNS_PER_BLOCK) {
    const slice = dates.slice(start, start + MAX_COLUMNS_PER_BLOCK);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;

    const header = [
      '<thead><tr>',
      `<th class="dots__med">Medicine — ${escapeHtml(formatDate(first))} to ${escapeHtml(formatDate(last))}</th>`,
      ...slice.map((date) => `<th>${escapeHtml(dayNumber(date))}</th>`),
      '</tr><tr>',
      '<th class="dots__med"></th>',
      ...slice.map((date) => `<th>${escapeHtml(formatWeekdayShort(date).slice(0, 1))}</th>`),
      '</tr></thead>',
    ].join('');

    const body = rows
      .map((row) => {
        const cells = slice
          .map((date) => {
            const cell = cellFor(row.days.get(date), awayByDate.get(date) ?? false);
            return `<td><span class="dots__cell dots__cell--${cell.state}">${escapeHtml(cell.label)}</span></td>`;
          })
          .join('');
        return `<tr><td class="dots__med">${escapeHtml(row.name)}</td>${cells}</tr>`;
      })
      .join('');

    blocks.push(`<table class="dots">${header}<tbody>${body}</tbody></table>`);
  }

  return [
    blocks.join('\n'),
    '<ul class="dots-key">',
    '<li><span class="dots__cell dots__cell--taken" style="display:inline-block;width:11pt">T</span> recorded as taken</li>',
    '<li><span class="dots__cell dots__cell--not-taken" style="display:inline-block;width:11pt">N</span> recorded as not taken</li>',
    '<li><span class="dots__cell dots__cell--no-record" style="display:inline-block;width:11pt">·</span> no record either way</li>',
    '<li><span class="dots__cell dots__cell--away" style="display:inline-block;width:11pt">A</span> recorded as away</li>',
    '<li>1/2 — recorded as taken out of scheduled, on a mixed day</li>',
    '<li>blank — nothing scheduled</li>',
    '</ul>',
    '<p class="table-note">A day with no entry either way is missing information. It is not a record of a dose not taken.</p>',
  ].join('\n');
}

function dayNumber(localDate: string): string {
  const parts = parseLocalDate(localDate);
  return parts ? String(parts.day) : localDate;
}
