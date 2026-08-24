/**
 * The plain-text block that travels alongside the day card image.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ANDROID CANNOT SHARE AN IMAGE AND TEXT IN ONE INTENT
 *
 * `ACTION_SEND` carries either `EXTRA_STREAM` or `EXTRA_TEXT`, and the major messaging
 * apps — WhatsApp above all — ignore the text when a stream is present. There is no flag
 * that fixes this and no library that works around it; it is the platform.
 *
 * So the flow is:
 *
 *   1. copy this text to the clipboard,
 *   2. tell the user "Text copied — paste it below the photo",
 *   3. open the share sheet with the IMAGE.
 *
 * And therefore: THE IMAGE MUST BE SELF-SUFFICIENT. Anyone who never pastes must still
 * receive a complete, readable day. The text is a bonus — it makes the day searchable in
 * a chat history, readable by a screen reader, and quotable in a reply — and nothing that
 * only exists here is allowed to matter.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * NO MARKDOWN. WhatsApp renders *bold*, _italic_ and ~strike~ from bare punctuation, so a
 * medicine written as "Vitamin B_12" or a note containing an asterisk would silently
 * change how the message looks. This builder emits plain text and strips those characters
 * from values it did not author.
 */

import { formatDateLong, formatTime } from '../lib/format';
import type { DayCardData, DayCardReading } from '../data/types';

export type DayCardTextLabels = {
  bloodPressure: string;
  bloodSugar: string;
  weight: string;
  medicines: string;
  symptoms: string;
  taken: string;
  notTaken: string;
  noRecord: string;
  nothingRecorded: string;
  disclaimer: string;
};

export const DEFAULT_DAY_CARD_TEXT_LABELS: DayCardTextLabels = {
  bloodPressure: 'Blood pressure',
  bloodSugar: 'Blood sugar',
  weight: 'Weight',
  medicines: 'Medicines',
  symptoms: 'How I felt',
  taken: 'taken',
  notTaken: 'recorded as not taken',
  noRecord: 'not recorded as taken',
  nothingRecorded: 'Nothing was recorded on this day.',
  disclaimer: 'Recorded in the Aarogya app. It shows what was recorded, not what was swallowed.',
};

/**
 * The toast shown after the text is copied. The caller should translate it; this is the
 * English source string and the key the translation is expected to live under.
 */
export const DAY_CARD_CLIPBOARD_NOTICE = 'Text copied — paste it below the photo';
export const DAY_CARD_CLIPBOARD_NOTICE_KEY = 'reports.dayCard.textCopied';

/** WhatsApp's formatting characters, removed from anything the user typed. */
function plain(value: string): string {
  return value.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
}

function readingLine(entry: DayCardReading): string {
  const value = `${plain(entry.text)}${entry.unit ? ` ${plain(entry.unit)}` : ''}`;
  const context = entry.contextLabel ? ` (${plain(entry.contextLabel)})` : '';
  return `  ${formatTime(entry.localTime)}  ${value}${context}`;
}

export type BuildDayCardTextOptions = {
  labels?: Partial<DayCardTextLabels>;
  /** Defaults to 'Aarogya'. */
  appName?: string;
};

export function buildDayCardText(data: DayCardData, options: BuildDayCardTextOptions = {}): string {
  const labels: DayCardTextLabels = { ...DEFAULT_DAY_CARD_TEXT_LABELS, ...options.labels };
  const appName = options.appName ?? 'Aarogya';

  const lines: string[] = [];
  lines.push(`${appName} — ${formatDateLong(data.localDate)}`);
  lines.push(plain(data.patientName));

  const section = (title: string, body: readonly string[]) => {
    if (body.length === 0) return;
    lines.push('');
    lines.push(title);
    lines.push(...body);
  };

  section(labels.bloodPressure, data.bloodPressure.map(readingLine));
  section(labels.bloodSugar, data.bloodSugar.map(readingLine));
  section(labels.weight, data.weight ? [readingLine(data.weight)] : []);
  for (const group of data.otherReadings) {
    section(plain(group.label), group.entries.map(readingLine));
  }

  const doseLines: string[] = [];
  for (const row of data.doses) {
    const name = row.strength ? `${plain(row.medicineName)} ${plain(row.strength)}` : plain(row.medicineName);
    doseLines.push(`  ${name}`);
    for (const mark of row.marks) {
      // The word for a dose with nothing recorded is never "missed". The app knows what
      // was tapped; it does not know what was swallowed.
      const word =
        mark.state === 'taken'
          ? labels.taken
          : mark.state === 'skipped'
            ? labels.notTaken
            : mark.state === 'cancelled'
              ? ''
              : labels.noRecord;
      if (word === '') continue;
      doseLines.push(`    ${formatTime(mark.timeLocal)}  ${word}`);
    }
  }
  section(labels.medicines, doseLines);

  section(
    labels.symptoms,
    data.symptoms.map(
      (symptom) =>
        `  ${formatTime(symptom.localTime)}  ${plain(symptom.label)}${
          symptom.severity ? ` (${plain(symptom.severity)})` : ''
        }`,
    ),
  );

  if (lines.length === 2) {
    lines.push('');
    lines.push(labels.nothingRecorded);
  }

  lines.push('');
  lines.push(labels.disclaimer);

  return lines.join('\n');
}
