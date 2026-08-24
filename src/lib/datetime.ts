/**
 * Date/time helpers. No date library — `local_date` strings plus a handful of pure
 * functions cover everything this app needs, and keep the bundle small on a Go-class device.
 *
 * THE CENTRAL RULE: schedules are WALL CLOCK. A dose is "08:00 daily", never an absolute
 * timestamp. Absolute epochs are derived at reconcile time and are always disposable.
 * Persisting a future epoch is the bug that fires a TB alarm at 04:30 after the user
 * crosses a timezone.
 */

/** 'YYYY-MM-DD' in the device's current local timezone. */
export function toLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'HH:MM' 24-hour, local. The app never displays 12-hour time — ambiguity is a dosing risk. */
export function toLocalTime(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

export function tzOffsetMinutes(d: Date = new Date()): number {
  return -d.getTimezoneOffset();
}

/** Resolves a wall-clock schedule against a local date into an absolute epoch. */
export function wallClockToEpoch(localDate: string, timeLocal: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = timeLocal.split(':').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).getTime();
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return toLocalDate(dt);
}

export function daysBetween(fromDate: string, toDate: string): number {
  const a = wallClockToEpoch(fromDate, '12:00');
  const b = wallClockToEpoch(toDate, '12:00');
  return Math.round((b - a) / 86_400_000);
}

/**
 * Adds calendar months, clamping to the end of the target month.
 * "Review after 1 month" written on 31 January resolves to 28/29 February, not 3 March.
 */
export function addMonthsClamped(localDate: string, months: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const year = y ?? 1970;
  const monthIndex = (m ?? 1) - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(d ?? 1, lastDay);
  return toLocalDate(new Date(targetYear, targetMonth, day));
}

/** Bit 0 = Monday … bit 6 = Sunday. Matches `dose_schedule.days_mask`. */
export function dayBit(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  const jsDay = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay(); // 0=Sun
  const isoIndex = (jsDay + 6) % 7; // 0=Mon
  return 1 << isoIndex;
}

export function isDayEnabled(daysMask: number, localDate: string): boolean {
  return (daysMask & dayBit(localDate)) !== 0;
}

export const ALL_DAYS = 127;
