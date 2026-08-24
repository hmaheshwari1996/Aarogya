/**
 * Locale-aware display of the `local_date` ('YYYY-MM-DD') and `local_time` ('HH:MM')
 * strings that every clinical record in this app carries.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE:
 *
 *  1. 24-HOUR CLOCK ALWAYS, IN BOTH LANGUAGES. "8:00" with the am/pm marker missed,
 *     misread or clipped is a dose taken twelve hours from when it was meant to be.
 *     `local_time` is already stored 24-hour, so this formatter's job is to never
 *     "helpfully" convert it. There is no 12-hour option and there must never be one.
 *
 *  2. LATIN DIGITS IN HINDI TOO. Devanagari digits (०१२) are correct Hindi but are read
 *     fluently by very few people under seventy — and a blood pressure is the last place
 *     to find out which group a reader belongs to. Month and weekday NAMES are
 *     translated; the numbers are not.
 *
 * Month and weekday names come from the translation files rather than `Intl`, so output
 * is identical on every Android build regardless of which ICU data the ROM shipped.
 */

import { useCallback, useMemo } from 'react';

import { daysBetween, toLocalDate } from '@/lib/datetime';

import { useI18n } from './index';

export type DateFormatter = {
  /** '9 August 2026' / '9 अगस्त 2026' */
  formatDate: (localDate: string) => string;
  /** '9 Aug' / '9 अग' */
  formatShortDate: (localDate: string) => string;
  /** 'Monday' / 'सोमवार' */
  formatWeekday: (localDate: string, short?: boolean) => string;
  /** 'August 2026' / 'अगस्त 2026' */
  formatMonthYear: (localDate: string) => string;
  /** '08:05' — 24-hour, zero-padded, always. */
  formatTime: (localTime: string) => string;
  /** '9 August 2026, 08:05' */
  formatDateTime: (localDate: string, localTime: string) => string;
  /** 'Today' / 'Yesterday' / 'Tomorrow', otherwise the full date. */
  formatDayLabel: (localDate: string) => string;
  /** '1 August 2026 to 9 August 2026' */
  formatDateRange: (fromDate: string, toDate: string) => string;
  /** Absolute epoch → date + time, for `at_epoch` columns and dose events. */
  formatEpoch: (epoch: number) => string;
  formatEpochTime: (epoch: number) => string;
  formatEpochDate: (epoch: number) => string;
};

type DateParts = { year: number; month: number; day: number };

function parseLocalDate(localDate: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** ISO weekday, 1 = Monday … 7 = Sunday. Matches `dose_schedule.days_mask` bit order. */
function isoWeekday(parts: DateParts): number {
  const jsDay = new Date(parts.year, parts.month - 1, parts.day).getDay(); // 0 = Sunday
  return ((jsDay + 6) % 7) + 1;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

export function useDateFormat(): DateFormatter {
  const { t } = useI18n();

  const formatDate = useCallback(
    (localDate: string): string => {
      const parts = parseLocalDate(localDate);
      // A malformed date is shown verbatim rather than swallowed. Silently rendering
      // an empty string would hide a corrupt row instead of surfacing it.
      if (!parts) return localDate;
      return t('date.longPattern', {
        day: parts.day,
        month: t(`date.month.${parts.month}`),
        year: parts.year,
      });
    },
    [t],
  );

  const formatShortDate = useCallback(
    (localDate: string): string => {
      const parts = parseLocalDate(localDate);
      if (!parts) return localDate;
      return t('date.shortPattern', {
        day: parts.day,
        month: t(`date.monthShort.${parts.month}`),
      });
    },
    [t],
  );

  const formatWeekday = useCallback(
    (localDate: string, short = false): string => {
      const parts = parseLocalDate(localDate);
      if (!parts) return localDate;
      const index = isoWeekday(parts);
      return t(short ? `date.weekdayShort.${index}` : `date.weekday.${index}`);
    },
    [t],
  );

  const formatMonthYear = useCallback(
    (localDate: string): string => {
      const parts = parseLocalDate(localDate);
      if (!parts) return localDate;
      return t('date.monthYearPattern', {
        month: t(`date.month.${parts.month}`),
        year: parts.year,
      });
    },
    [t],
  );

  const formatTime = useCallback((localTime: string): string => {
    const match = /^(\d{1,2}):(\d{2})/.exec(localTime);
    if (!match) return localTime;
    const [, h, m] = match;
    if (h === undefined || m === undefined) return localTime;
    const hours = Number(h);
    const minutes = Number(m);
    if (hours > 23 || minutes > 59) return localTime;
    // Re-padded rather than passed through: '8:00' from an older row must still render
    // as '08:00' so a column of times lines up and cannot be misread at a glance.
    return `${two(hours)}:${two(minutes)}`;
  }, []);

  const formatDateTime = useCallback(
    (localDate: string, localTime: string): string =>
      t('date.dateTimePattern', { date: formatDate(localDate), time: formatTime(localTime) }),
    [t, formatDate, formatTime],
  );

  const formatDayLabel = useCallback(
    (localDate: string): string => {
      if (!parseLocalDate(localDate)) return localDate;
      const delta = daysBetween(toLocalDate(), localDate);
      if (delta === 0) return t('date.today');
      if (delta === -1) return t('date.yesterday');
      if (delta === 1) return t('date.tomorrow');
      return formatDate(localDate);
    },
    [t, formatDate],
  );

  const formatDateRange = useCallback(
    (fromDate: string, toDate: string): string =>
      t('date.rangePattern', { from: formatDate(fromDate), to: formatDate(toDate) }),
    [t, formatDate],
  );

  const epochToParts = useCallback((epoch: number): { date: string; time: string } | null => {
    if (!Number.isFinite(epoch)) return null;
    const d = new Date(epoch);
    if (Number.isNaN(d.getTime())) return null;
    return { date: toLocalDate(d), time: `${two(d.getHours())}:${two(d.getMinutes())}` };
  }, []);

  const formatEpoch = useCallback(
    (epoch: number): string => {
      const parts = epochToParts(epoch);
      if (!parts) return t('common.unknown');
      return formatDateTime(parts.date, parts.time);
    },
    [epochToParts, formatDateTime, t],
  );

  const formatEpochTime = useCallback(
    (epoch: number): string => {
      const parts = epochToParts(epoch);
      return parts ? parts.time : t('common.unknown');
    },
    [epochToParts, t],
  );

  const formatEpochDate = useCallback(
    (epoch: number): string => {
      const parts = epochToParts(epoch);
      return parts ? formatDate(parts.date) : t('common.unknown');
    },
    [epochToParts, formatDate, t],
  );

  return useMemo<DateFormatter>(
    () => ({
      formatDate,
      formatShortDate,
      formatWeekday,
      formatMonthYear,
      formatTime,
      formatDateTime,
      formatDayLabel,
      formatDateRange,
      formatEpoch,
      formatEpochTime,
      formatEpochDate,
    }),
    [
      formatDate,
      formatShortDate,
      formatWeekday,
      formatMonthYear,
      formatTime,
      formatDateTime,
      formatDayLabel,
      formatDateRange,
      formatEpoch,
      formatEpochTime,
      formatEpochDate,
    ],
  );
}

export default useDateFormat;
