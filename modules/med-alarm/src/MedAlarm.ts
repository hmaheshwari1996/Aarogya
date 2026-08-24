import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

import type { AlarmHorizon, JournalRecord } from '@/types';

/**
 * Typed façade over the `MedAlarm` native module.
 *
 * ── WHY THE IMPORT IS WRAPPED IN try/catch ────────────────────────────────────
 * `requireNativeModule()` THROWS AT MODULE SCOPE when the native module is not in the
 * binary — Expo Go, a stale dev client built before this module existed, the web bundle,
 * a Jest run. A throw at module scope is not a failed feature, it is a white screen: the
 * import chain unwinds and nothing renders. So the native handle is resolved defensively
 * once, and every method falls back to a no-op with `isAvailable === false`, which the
 * Reminder Health Check surfaces as "reminders are not installed on this build".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One journal record plus the file name Kotlin stored it under. */
export type JournalEntry = JournalRecord & { fileName: string };

export type ReconcileResult = {
  ok: boolean;
  /** 'ok' | 'no_horizon' | 'stale_horizon' */
  reason: string;
  /** Distinct dose occurrences inside the materialisation window. */
  occurrences: number;
  /** Individual alarms armed, i.e. occurrences × (base + escalations) + live snoozes. */
  armed: number;
  snoozesKept: number;
  /** True when exact alarms were unavailable and scheduling fell back to inexact. */
  degradedToInexact: boolean;
  horizonAgeDays: number;
  nextTriggerAtEpoch: number;
};

export type MedAlarmChannelState = {
  id: string;
  name: string;
  /** Android IMPORTANCE_*: 0 = the user switched this exact channel off. */
  importance: number;
  muted: boolean;
  hasSound: boolean;
  bypassDnd: boolean;
};

export type MedAlarmHealth = {
  sdkInt: number;
  manufacturer: string;
  model: string;
  notificationsEnabled: boolean;
  channels: MedAlarmChannelState[];
  canUseFullScreenIntent: boolean;
  canScheduleExactAlarms: boolean;
  isIgnoringBatteryOptimizations: boolean;
  alarmVolume: number;
  alarmVolumeMax: number;
  alarmVolumeIsZero: boolean;
  /** NotificationManager.INTERRUPTION_FILTER_*; 3 = Total Silence. */
  interruptionFilter: number;
  zenMode: number;
  isTotalSilence: boolean;
  /** 45 = RESTRICTED. -1 below Android 9, where the API does not exist. */
  standbyBucket: number;
  standbyBucketLabel: string;
  freeStorageBytes: number;
  horizonAgeDays: number;
  horizonIsStale: boolean;
  horizonRuleCount: number;
  /** Rules the native parser had to drop. Non-zero means a bug on the JS side. */
  horizonDroppedRules: number;
  horizonWrittenAtEpoch: number;
  armedCount: number;
  armedOccurrenceCount: number;
  nextTriggerAtEpoch: number;
  pendingJournalCount: number;
};

type NativeMedAlarm = {
  writeHorizon(json: string): Promise<void>;
  reconcileNow(): Promise<ReconcileResult>;
  cancelAll(): Promise<void>;
  readJournal(): Promise<string[]>;
  deleteJournalEntries(names: string[]): Promise<number>;
  probeHealth(): Promise<MedAlarmHealth>;
  openOemAutostartSettings(): boolean;
  openBatterySettings(): void;
  openExactAlarmSettings(): void;
  stopRinging(): void;
  testFire(channelId: string): Promise<void>;
};

let native: NativeMedAlarm | null = null;
let unavailableReason: string | null = null;

if (Platform.OS !== 'android') {
  // Not a failure: this module is Android-only by design. iOS gets its own layer, and
  // the web build has no alarms at all.
  unavailableReason = `MedAlarm is Android-only (running on ${Platform.OS})`;
} else {
  try {
    native = requireNativeModule<NativeMedAlarm>('MedAlarm');
  } catch (e) {
    unavailableReason =
      e instanceof Error ? e.message : 'MedAlarm native module is not present in this build';
  }
}

function warnOnce(fn: string): void {
  if (__DEV__) {
    console.warn(`[MedAlarm] ${fn}() ignored — ${unavailableReason ?? 'module unavailable'}`);
  }
}

/**
 * Parses one journal string. Returns null rather than throwing: a single malformed
 * record must not stop the drain, or it blocks every record behind it forever.
 */
function parseEntry(raw: string): JournalEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<JournalEntry>;
    if (!parsed || typeof parsed.fileName !== 'string' || typeof parsed.event !== 'string') {
      return null;
    }
    return parsed as JournalEntry;
  } catch {
    return null;
  }
}

export const MedAlarm = {
  /** False in Expo Go, on iOS/web, and in a dev client built before this module landed. */
  isAvailable: native !== null,
  unavailableReason,

  /**
   * Replaces the native rules file. RULES, not dates — the native side expands them
   * forward on its own, indefinitely, so reminders cannot run out on a phone that never
   * opens the app.
   *
   * Throws if the native side rejects the payload; the previous horizon stays intact.
   */
  async writeHorizon(horizon: AlarmHorizon): Promise<void> {
    if (!native) {
      warnOnce('writeHorizon');
      return;
    }
    await native.writeHorizon(JSON.stringify(horizon));
  },

  /** Re-materialise and re-arm. Idempotent; call it on every foreground. */
  async reconcileNow(): Promise<ReconcileResult | null> {
    if (!native) {
      warnOnce('reconcileNow');
      return null;
    }
    return native.reconcileNow();
  },

  async cancelAll(): Promise<void> {
    if (!native) {
      warnOnce('cancelAll');
      return;
    }
    await native.cancelAll();
  },

  /**
   * Every pending journal record.
   *
   * Records with `occurrenceId === 'system'` are native-level events (`rearmed`,
   * `receiver_error`) that belong to no dose — they carry empty `threadId`/`medicineId`
   * and must not be fed to parseOccurrenceId().
   */
  async readJournal(): Promise<JournalEntry[]> {
    if (!native) {
      warnOnce('readJournal');
      return [];
    }
    const raw = await native.readJournal();
    const out: JournalEntry[] = [];
    for (const item of raw) {
      const parsed = parseEntry(item);
      if (parsed) out.push(parsed);
    }
    return out;
  },

  /**
   * Unlink records that have been committed to the database.
   *
   * Only ever call this AFTER the transaction that ingested them has committed. Deleting
   * first turns a crash into a permanently lost dose record; deleting after, at worst,
   * replays one that the ingest de-duplicates.
   */
  async deleteJournalEntries(fileNames: string[]): Promise<number> {
    if (!native || fileNames.length === 0) {
      if (!native) warnOnce('deleteJournalEntries');
      return 0;
    }
    return native.deleteJournalEntries(fileNames);
  },

  async probeHealth(): Promise<MedAlarmHealth | null> {
    if (!native) {
      warnOnce('probeHealth');
      return null;
    }
    return native.probeHealth();
  },

  /**
   * @returns true if a manufacturer-specific autostart screen actually opened. False
   * means the user landed on the generic app-details page — say so, do not imply the
   * setting was reached. There is no API to read autostart state, so the app can never
   * confirm the user actually enabled it.
   */
  openOemAutostartSettings(): boolean {
    if (!native) {
      warnOnce('openOemAutostartSettings');
      return false;
    }
    try {
      return native.openOemAutostartSettings();
    } catch {
      return false;
    }
  },

  openBatterySettings(): void {
    if (!native) {
      warnOnce('openBatterySettings');
      return;
    }
    try {
      native.openBatterySettings();
    } catch {
      /* a help screen must never crash the app */
    }
  },

  openExactAlarmSettings(): void {
    if (!native) {
      warnOnce('openExactAlarmSettings');
      return;
    }
    try {
      native.openExactAlarmSettings();
    } catch {
      /* a help screen must never crash the app */
    }
  },

  /**
   * Silences a dose alarm that is ringing right now.
   *
   * A dose reminder on the `critical` or `standard` tier rings continuously — a looping
   * alarm tone plus vibration — until it is answered or until the native ~2 minute cap
   * stops it. Every native path that means "answered" already silences it (Taken, Snooze,
   * swiping the notification away, the full-screen alarm screen closing), so this is only
   * for the path that does not touch any of them: the user taps the notification body,
   * arrives in the app, and records the dose on screen while the phone is still ringing.
   *
   * Call it from the in-app record-a-dose flow. Safe to call when nothing is ringing.
   */
  stopRinging(): void {
    if (!native) {
      warnOnce('stopRinging');
      return;
    }
    try {
      native.stopRinging();
    } catch {
      /* silencing a sound that is not playing must never surface an error */
    }
  },

  /** Posts a real notification on `channelId` now. Writes nothing to the journal. */
  async testFire(channelId: string): Promise<void> {
    if (!native) {
      warnOnce('testFire');
      return;
    }
    await native.testFire(channelId);
  },
};

export default MedAlarm;
