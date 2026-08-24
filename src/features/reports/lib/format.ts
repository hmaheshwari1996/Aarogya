/**
 * Formatting for the DOCTOR-FACING surfaces. English, always.
 *
 * The app's UI is bilingual. The printout is not, and that is a deliberate product
 * decision recorded in `src/i18n/index.ts`: the `report.*` keys are English in both
 * translation files so that any doctor at any OPD — including one who reads no Hindi —
 * can read the page a patient hands across the desk. This module is the arithmetic side
 * of that decision, so it carries its own month table rather than reaching into i18n.
 *
 * PURE, with no runtime imports. Same reason as `./html.ts`.
 *
 * Two formatting rules that are not stylistic:
 *
 *  • 24-hour time, always. '8:00' with the am/pm marker clipped is a dose read twelve
 *    hours out. `local_time` is stored 24-hour; nothing here converts it.
 *  • Dates are always written with the month as a WORD. '09/08/2026' is 9 August in
 *    India and 8 September in the United States, and a report is exactly the artefact
 *    that travels between people who disagree about that.
 */

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export type DateParts = { year: number; month: number; day: number };

/** 'YYYY-MM-DD' → parts, or null when the string is not one. Never throws. */
export function parseLocalDate(localDate: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: Number(y), month, day };
}

/** '9 Aug 2026'. A malformed date is echoed verbatim rather than hidden. */
export function formatDate(localDate: string): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  return `${parts.day} ${MONTHS_SHORT[parts.month - 1] ?? '?'} ${parts.year}`;
}

/** '9 August 2026' — for the one date at the top of a page. */
export function formatDateLong(localDate: string): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  return `${parts.day} ${MONTHS_LONG[parts.month - 1] ?? '?'} ${parts.year}`;
}

/** '9 Aug' — for a dense axis or a table that already states the year. */
export function formatDateShort(localDate: string): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  return `${parts.day} ${MONTHS_SHORT[parts.month - 1] ?? '?'}`;
}

/** 'August 2026'. */
export function formatMonthYear(localDate: string): string {
  const parts = parseLocalDate(localDate);
  if (!parts) return localDate;
  return `${MONTHS_LONG[parts.month - 1] ?? '?'} ${parts.year}`;
}

/**
 * '1 Aug 2026 to 9 Aug 2026'.
 *
 * Spelled with the word "to" rather than an en dash: this string is read aloud across a
 * desk as often as it is read on paper, and a dash between two dates is silent.
 */
export function formatDateRangeLong(fromDate: string, toDate: string): string {
  if (fromDate === toDate) return formatDate(fromDate);
  return `${formatDate(fromDate)} to ${formatDate(toDate)}`;
}

/** '08:05'. Re-padded, so a column of times lines up and cannot be misread at a glance. */
export function formatTime(localTime: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(localTime);
  if (!match) return localTime;
  const [, h, m] = match;
  if (h === undefined || m === undefined) return localTime;
  const hours = Number(h);
  const minutes = Number(m);
  if (hours > 23 || minutes > 59) return localTime;
  return `${two(hours)}:${two(minutes)}`;
}

export function formatEpochDate(epoch: number): string {
  const parts = epochParts(epoch);
  return parts ? formatDate(parts.date) : '';
}

export function formatEpochDateTime(epoch: number): string {
  const parts = epochParts(epoch);
  return parts ? `${formatDate(parts.date)}, ${parts.time}` : '';
}

function epochParts(epoch: number): { date: string; time: string } | null {
  if (!Number.isFinite(epoch)) return null;
  const d = new Date(epoch);
  if (Number.isNaN(d.getTime())) return null;
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return { date, time: `${two(d.getHours())}:${two(d.getMinutes())}` };
}

/** 'Mon' … 'Sun'. Monday-first, matching `dose_schedule.days_mask` bit order. */
export function formatWeekdayShort(localDate: string): string {
  const index = isoWeekdayIndex(localDate);
  return index === null ? '' : (WEEKDAYS_SHORT[index] ?? '');
}

/** 0 = Monday … 6 = Sunday, or null for a malformed date. */
export function isoWeekdayIndex(localDate: string): number | null {
  const parts = parseLocalDate(localDate);
  if (!parts) return null;
  const jsDay = new Date(parts.year, parts.month - 1, parts.day).getDay(); // 0 = Sunday
  return (jsDay + 6) % 7;
}

/**
 * Numbers as a person would write them: no trailing '.0', at most one decimal place for
 * anything that is not already whole.
 *
 * A weight of 61.4 must not print as 61.40, and a systolic of 142 must not print as
 * 142.0 — a spurious decimal on a blood pressure reads as a precision the cuff does not
 * have, and invites the reader to wonder what else has been massaged.
 */
export function formatNumber(value: number | null | undefined, maxDecimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  const factor = 10 ** Math.max(0, maxDecimals);
  const rounded = Math.round(value * factor) / factor;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Age from the year of birth alone — which is all the profile stores.
 *
 * Returned as a whole number with the caller expected to label it "from year of birth",
 * because it is accurate to within a year and pretending otherwise would be a small lie
 * on a page whose whole value is that it does not tell them.
 */
export function ageFromYearOfBirth(
  yearOfBirth: number | null | undefined,
  now: number = Date.now(),
): number | null {
  if (yearOfBirth === null || yearOfBirth === undefined) return null;
  if (!Number.isFinite(yearOfBirth) || yearOfBirth < 1900) return null;
  const age = new Date(now).getFullYear() - yearOfBirth;
  return age >= 0 && age < 130 ? age : null;
}

/** 'Female' / 'Male' / 'Other' / 'Not stated'. */
export function formatSex(sex: string | null | undefined): string {
  switch (sex) {
    case 'female':
      return 'Female';
    case 'male':
      return 'Male';
    case 'other':
      return 'Other';
    default:
      return 'Not stated';
  }
}

/** A 7-bit `days_mask` as words: 'Every day', 'Mon, Wed, Fri', 'No days'. */
export function formatDaysMask(daysMask: number): string {
  if (daysMask === 127) return 'Every day';
  const days: string[] = [];
  for (let bit = 0; bit < 7; bit += 1) {
    if ((daysMask & (1 << bit)) !== 0) days.push(WEEKDAYS_SHORT[bit] ?? '');
  }
  return days.length === 0 ? 'No days' : days.join(', ');
}

/** Pluralises without the '(s)' construction, which reads as a form and not a sentence. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}
