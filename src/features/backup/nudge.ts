/**
 * "Days since the last copy" — and the monthly reminder to take one off the phone.
 *
 * ─── WHY THIS IS A FEATURE AND NOT A NAG ──────────────────────────────────────────
 * Every other reminder in this app is about a medicine and is written to be quiet,
 * non-punitive and easy to ignore, because guilt does not improve adherence. This one is
 * different in kind. It is the only mitigation for a class of loss that is total,
 * silent and irreversible: there is no cloud copy, no account, no server-side history and
 * no way for anybody — including us — to reconstruct a record from a phone that is gone.
 *
 * So it earns a number on the screen ("last copy: 47 days ago") rather than a banner that
 * appears and is dismissed. A number is a status; a banner is an interruption, and an
 * interruption is what gets trained away.
 *
 * ─── A CAPSULE THAT NEVER LEFT THE PHONE IS NOT A BACKUP ──────────────────────────
 * `backups/` lives in app storage, which a factory reset, an uninstall and a dead handset
 * all take with them. Writing the capsule is half the job; sending it somewhere else is
 * the other half, and this module tracks the two separately so the UI can say which one
 * is outstanding.
 *
 * `evaluateNudge` is pure and takes its clock, so the whole policy is unit-testable
 * without a device or a database.
 */

import { inTransaction, queryFirst } from '../../db/repositories/_shared';

const KEY_LAST_CAPSULE = 'backup.lastCapsuleAtEpoch';
const KEY_LAST_CAPSULE_BYTES = 'backup.lastCapsuleBytes';
const KEY_LAST_OFF_DEVICE = 'backup.lastOffDeviceAtEpoch';
const KEY_LAST_NUDGE = 'backup.lastNudgeAtEpoch';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Monthly. Frequent enough to bound the loss, rare enough not to become wallpaper. */
export const NUDGE_INTERVAL_DAYS = 30;

/** Past this the wording escalates from "worth doing" to "this is now a real exposure". */
export const OVERDUE_DAYS = 90;

/** However bad it looks, the reminder is not shown more often than this. */
export const MIN_REPROMPT_DAYS = 7;

export type BackupState = {
  readonly lastCapsuleAtEpoch: number | null;
  readonly lastCapsuleBytes: number | null;
  /** When a capsule was last handed to the share sheet. Null means none ever left. */
  readonly lastOffDeviceAtEpoch: number | null;
  readonly lastNudgeAtEpoch: number | null;
};

export type NudgeLevel =
  /** No capsule has ever been written. The whole record has no second copy at all. */
  | 'never'
  /** A recent capsule exists but has never left this phone. */
  | 'on_device_only'
  /** The newest capsule is older than the interval. */
  | 'due'
  /** Considerably older than the interval. */
  | 'overdue'
  /** Nothing to say. */
  | 'ok';

export type BackupNudge = {
  readonly level: NudgeLevel;
  readonly daysSinceCapsule: number | null;
  readonly daysSinceOffDevice: number | null;
  /**
   * Whether the UI should actively interrupt, as opposed to just showing the number.
   * The number is always safe to show; this is the gate on anything modal.
   */
  readonly shouldPrompt: boolean;
  /** English source strings. The UI renders through `i18nKey`. */
  readonly i18nKey: string;
  readonly en: string;
};

export const NUDGE_COPY: Record<NudgeLevel, { readonly i18nKey: string; readonly en: string }> = {
  never: {
    i18nKey: 'backup.nudge.never',
    en: 'Your record has never been copied off this phone. If the phone is lost, so is all of it.',
  },
  on_device_only: {
    i18nKey: 'backup.nudge.onDeviceOnly',
    en: 'The copy is still on this phone. Send it to a computer, a pen drive or another phone.',
  },
  due: {
    i18nKey: 'backup.nudge.due',
    en: 'It has been a month since you saved a copy.',
  },
  overdue: {
    i18nKey: 'backup.nudge.overdue',
    en: 'The last copy is months old. Anything recorded since then exists only here.',
  },
  ok: { i18nKey: 'backup.nudge.ok', en: 'A recent copy exists off this phone.' },
};

/** Whole days, floored. 23 hours ago is "today", which is what a human means by it. */
export function daysBetweenEpochs(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/**
 * The whole policy, pure.
 *
 * Order matters: "never" outranks everything, and "still on this phone" outranks "due",
 * because a user who has been diligently writing monthly capsules that never leave the
 * handset has no backup at all and needs to be told that, not congratulated on the date.
 */
export function evaluateNudge(state: BackupState, now: number): BackupNudge {
  const daysSinceCapsule =
    state.lastCapsuleAtEpoch === null ? null : daysBetweenEpochs(state.lastCapsuleAtEpoch, now);
  const daysSinceOffDevice =
    state.lastOffDeviceAtEpoch === null ? null : daysBetweenEpochs(state.lastOffDeviceAtEpoch, now);

  const quietUntilDays =
    state.lastNudgeAtEpoch === null ? Number.POSITIVE_INFINITY : daysBetweenEpochs(state.lastNudgeAtEpoch, now);
  const mayPrompt = quietUntilDays >= MIN_REPROMPT_DAYS;

  const level = ((): NudgeLevel => {
    if (daysSinceCapsule === null) return 'never';
    if (daysSinceOffDevice === null) return 'on_device_only';
    // Measured from whichever happened later. A capsule written yesterday and shared
    // yesterday is fine; a capsule written yesterday and last shared in March is not.
    const staleness = Math.min(daysSinceCapsule, daysSinceOffDevice);
    if (staleness >= OVERDUE_DAYS) return 'overdue';
    if (staleness >= NUDGE_INTERVAL_DAYS) return 'due';
    return 'ok';
  })();

  const copy = NUDGE_COPY[level];
  return {
    level,
    daysSinceCapsule,
    daysSinceOffDevice,
    shouldPrompt: level !== 'ok' && mayPrompt,
    i18nKey: copy.i18nKey,
    en: copy.en,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────
// `app_meta` is a plain key/value table and is not in the repositories' TABLE registry,
// so these read and write it directly rather than through createRecord/updateRecord.
// Reads never throw: a missing row, a corrupt value or a database that is not open yet
// must all present as "no backup recorded", which every caller already handles.

export async function readBackupState(): Promise<BackupState> {
  return {
    lastCapsuleAtEpoch: await readNumber(KEY_LAST_CAPSULE),
    lastCapsuleBytes: await readNumber(KEY_LAST_CAPSULE_BYTES),
    lastOffDeviceAtEpoch: await readNumber(KEY_LAST_OFF_DEVICE),
    lastNudgeAtEpoch: await readNumber(KEY_LAST_NUDGE),
  };
}

export async function getBackupNudge(now: number = Date.now()): Promise<BackupNudge> {
  return evaluateNudge(await readBackupState(), now);
}

/** The figure the backup screen shows. Null when no capsule has ever been written. */
export async function daysSinceLastCapsule(now: number = Date.now()): Promise<number | null> {
  const state = await readBackupState();
  return state.lastCapsuleAtEpoch === null ? null : daysBetweenEpochs(state.lastCapsuleAtEpoch, now);
}

export async function recordCapsuleWritten(atEpoch: number, bytes: number): Promise<void> {
  await writeMeta([
    [KEY_LAST_CAPSULE, String(atEpoch)],
    [KEY_LAST_CAPSULE_BYTES, String(bytes)],
  ]);
}

/**
 * Call this when a capsule has actually been handed to the share sheet.
 *
 * Recorded optimistically: Android's share promise resolves when the chooser appears, not
 * when the receiving app has finished, so this cannot know the file arrived anywhere. The
 * alternative — never recording it — would leave every user permanently in
 * `on_device_only` and train them to ignore the warning, which is worse than being
 * occasionally too generous.
 */
export async function recordCopyTakenOffDevice(atEpoch: number = Date.now()): Promise<void> {
  await writeMeta([[KEY_LAST_OFF_DEVICE, String(atEpoch)]]);
}

/** Call after showing a prompt, so the next one is at least MIN_REPROMPT_DAYS away. */
export async function recordNudgeShown(atEpoch: number = Date.now()): Promise<void> {
  await writeMeta([[KEY_LAST_NUDGE, String(atEpoch)]]);
}

async function readNumber(key: string): Promise<number | null> {
  try {
    const row = await queryFirst<{ value: string | null }>(`SELECT value FROM app_meta WHERE key = ?;`, [key]);
    if (!row?.value) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeMeta(pairs: readonly (readonly [string, string])[]): Promise<void> {
  try {
    await inTransaction(async (tx) => {
      for (const [key, value] of pairs) {
        await tx.db.runAsync(
          `INSERT INTO app_meta(key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
          [key, value],
        );
      }
    });
  } catch (error) {
    // Losing the bookkeeping is survivable — the capsule itself is already on disk, and
    // the worst outcome is a reminder that fires a little early next month.
    console.warn('[backup] could not record backup bookkeeping', error);
  }
}
