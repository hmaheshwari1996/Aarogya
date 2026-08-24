/**
 * The developer log: what a screen imports.
 *
 * ─── WHAT THIS FEATURE IS ────────────────────────────────────────────────────
 * Her son reported that prescription scanning "is not working" and asked for a way to see
 * why from the phone, with no cable and no laptop. This module is that way: a bounded
 * ring of technical notes about the app's own plumbing, off by default, deleted when
 * turned off, and redacted so hard that the worst case — the whole thing pasted into a
 * chat with a stranger — says nothing about her.
 *
 * ─── IMPORTING IT ───────────────────────────────────────────────────────────
 * A SCREEN imports from here. It gets the toggle, the list, the purge and the share text.
 *
 * A FEATURE MODULE THAT WRITES NOTES imports `./recorder` DIRECTLY, never this file. This
 * one re-exports `./store`, which imports `expo-file-system` and the database — and
 * `features/ai/gemini.ts` and `features/ai/retry.ts` are both exercised by `node --test`
 * with a stubbed `fetch`, which they can only do while every module they reach is free of
 * native imports. One convenience import from here would end that quietly.
 *
 * ─── THE COPY THE LOG SCREEN OWES HER ───────────────────────────────────────
 * Not written here, because screen copy belongs in the screen's own `LocalStrings` in
 * both languages. But the screen must say, in the app's ordinary voice, three things:
 *
 *   • what these notes are:   "Technical notes about how the app is working. They contain
 *                              no medicines, no readings and no personal details."
 *   • what the toggle costs:  "Nothing is recorded until you turn this on."
 *   • what turning it off does: "Turning this off deletes the notes already recorded."
 *
 * and it must show the delete button plainly, because that is what he asked for.
 */

export {
  DEV_EVENTS,
  type DevLogCategory,
  type DevLogEntry,
  type DevLogEventName,
  type DevLogFields,
  type DevLogLevel,
} from './types';

export {
  MAX_BYTES,
  MAX_ENTRIES,
  clearEntries,
  devLogStats,
  formatEntries,
  formatEntry,
  isRecording,
  listEntries,
  subscribeDevLog,
} from './recorder';

export {
  META_DEVLOG_ENABLED,
  devLogNdjson,
  devLogShareText,
  flushDevLog,
  // Two passes, in this order, and boot is the only caller that needs both: the mirror
  // before the database opens, the `app_meta` row once it has. See RULE THREE in store.ts.
  hydrateDevLogFromMirror,
  initDevLog,
  installGlobalErrorRecorder,
  isDevLogEnabled,
  purgeDevLog,
  recordAppError,
  setDevLogEnabled,
} from './store';

export { fingerprintSecret, scrubText, type SecretFingerprint } from './redact';
