/**
 * The recorder: a bounded ring of technical notes that does not exist until a human
 * turns it on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HER SON'S REQUIREMENT, QUOTED: "If developer option is not enabled, we will not store
 * the logs at all."
 *
 * That is a stronger statement than "we hide the log screen", and it is honoured here
 * literally. With the toggle off:
 *
 *   • `isRecording()` returns a module-level boolean. No await, no database, no file.
 *   • `record()` returns on the first line, BEFORE the field bag is touched, so a thunk
 *     is never invoked, no string is formatted and no object is allocated.
 *   • No file is created. Not an empty one, not a header line. `Paths.cache/aarogya-devlog`
 *     does not exist on a phone that has never had the toggle on (see store.ts).
 *   • Turning the toggle OFF deletes what is already there. Otherwise "not stored at all"
 *     would mean "not stored from now on", and an untoggled phone would still be carrying
 *     a second copy of everything the last debugging session saw.
 *
 * THE COST WHEN OFF IS A BOOLEAN READ, AND THAT IS ONLY TRUE IF CALL SITES HELP. Passing
 * an object literal to `record()` builds that object whether or not it is stored — the
 * check inside cannot un-allocate it. So hot call sites read
 *
 *     if (isRecording()) record('info', 'ai', DEV_EVENTS.aiRequest, { … });
 *
 * and expensive bags are passed as a thunk, which `record` only invokes once it knows it
 * is going to keep the result. Both forms are supported; the guard is the free one.
 *
 * ─── WHERE THE TOGGLE LIVES, AND WHY THE CACHE CANNOT GO STALE ───────────────
 *
 * The truth is a row in `app_meta`, which is an async SQLite read — far too slow to ask
 * on every log call and unavailable before the database opens. So it is read ONCE at
 * boot by `initDevLog()` (store.ts) and mirrored into `enabled` below.
 *
 * That mirror is only ever written by two functions: `setRecording()`, which store.ts
 * calls after hydrating, and `setDevLogEnabled()`, which is the ONLY way the toggle can
 * be flipped and which sets the mirror synchronously BEFORE it writes the row. There is
 * no third writer, so there is no window in which the row and the mirror disagree in a
 * direction that matters: the mirror leads, the row follows.
 *
 * The one honest limitation: notes produced before `initDevLog()` finishes are dropped,
 * because the default is off and off is the fail-closed direction. Boot runs
 * `initDevLog()` in the same step that opens the database, which is long before a
 * prescription can be scanned — so nothing in the AI path is affected. A crash in the
 * first few hundred milliseconds of launch is the case this cannot catch, and pretending
 * otherwise would mean buffering notes on a phone whose owner said not to.
 *
 * ─── THIS FILE IMPORTS NOTHING NATIVE, ON PURPOSE ────────────────────────────
 *
 * No expo, no react-native, no database. Two reasons, both load-bearing:
 *   1. `features/ai/gemini.ts` and `features/ai/retry.ts` are exercised by `node --test`
 *      with a stubbed `fetch`, and they now import this module. The moment anything here
 *      reaches for a native module, those two suites stop loading and the error mapping
 *      goes back to being untested.
 *   2. A logger that can fail to load is a logger that takes the app down at import time.
 *
 * Everything that touches a disk lives in `store.ts` and arrives here as a `sink`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { redactFields } from './redact';
import {
  DEV_EVENTS,
  isCategory,
  isKnownEvent,
  isLevel,
  type DevLogCategory,
  type DevLogEntry,
  type DevLogEventName,
  type DevLogFields,
  type DevLogInput,
  type DevLogLevel,
} from './types';

/**
 * THE TWO CAPS, AND WHY THESE NUMBERS.
 *
 * 400 entries: one failing scan with three attempts writes about fifteen notes, so 400
 * holds roughly twenty-five reproductions — comfortably more than a debugging session,
 * and few enough that the screen can render the whole list without pagination.
 *
 * 256 KB: the ring is rewritten to disk in one synchronous `File.write`, and a quarter of
 * a megabyte is a few milliseconds on the cheapest phone this app targets. It is also
 * small enough that the whole log can be shared through the ordinary share sheet as text
 * without the receiving app choking.
 *
 * Whichever cap is reached first, the OLDEST entries go. Newest-wins is the right
 * direction for a debugger: the failure she just reproduced is the one on screen.
 */
export const MAX_ENTRIES = 400;
export const MAX_BYTES = 256 * 1024;

// ── State. All module-level, all cheap to read. ──────────────────────────────

let enabled = false;
let entries: DevLogEntry[] = [];
let bytes = 0;
let seq = 0;
let runId: string | null = null;
let runCounter = 0;
const listeners = new Set<() => void>();

/**
 * The whole cost of a log call when the toggle is off.
 *
 * Read it at the call site and guard on it, rather than trusting `record()` to bail out:
 * the object literal you would have passed is built before `record` is entered.
 */
export function isRecording(): boolean {
  return enabled;
}

/**
 * Flips the mirror described in the header. Called by `store.ts` and by nothing else.
 *
 * Turning it OFF empties the ring immediately, in the same tick, so there is no moment
 * where a note survives the decision to stop keeping notes. The FILE is store.ts's to
 * delete — it owns everything that touches a disk.
 */
export function setRecording(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (!on) {
    entries = [];
    bytes = 0;
    runId = null;
  }
  notify();
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Records one note. Silently does nothing when the toggle is off.
 *
 * `fields` may be a bag or a function returning one. The function form exists for bags
 * that cost something to build — it is not invoked unless the note is being kept.
 *
 * NEVER THROWS. A logger that can throw into the middle of a prescription scan is worse
 * than no logger at all: it converts a diagnosable failure into an unhandled rejection
 * three frames from anything that knows what was happening.
 */
export function record(
  level: DevLogLevel,
  category: DevLogCategory,
  event: DevLogEventName,
  fields?: DevLogInput | (() => DevLogInput),
): void {
  if (!enabled) return;
  try {
    const raw = typeof fields === 'function' ? fields() : fields;
    push({
      seq: (seq += 1),
      ts: Date.now(),
      level,
      category,
      event,
      runId,
      fields: redactFields(raw),
    });
  } catch {
    // Including a throwing thunk, a getter with an opinion, or a Date.now that someone
    // has stubbed into a corner. The note is lost; nothing else is.
  }
}

function push(entry: DevLogEntry): void {
  const size = sizeOf(entry);
  entries.push(entry);
  bytes += size;

  // Both caps, oldest first. `shift()` on an array of a few hundred is not worth a
  // circular-buffer index dance that would have to be right about wrap-around.
  while (entries.length > MAX_ENTRIES || (bytes > MAX_BYTES && entries.length > 1)) {
    const dropped = entries.shift();
    if (!dropped) break;
    bytes -= sizeOf(dropped);
  }
  if (entries.length === 0) bytes = 0;
  notify();
}

/**
 * Approximate serialized size, computed once per entry rather than per eviction.
 *
 * `JSON.stringify` is the honest measure because the file on disk is exactly this, one
 * entry per line. A failed stringify (a field bag containing a cycle — which the redactor
 * makes impossible, but belt and braces) falls back to a generous constant rather than
 * letting the byte cap silently stop working.
 */
function sizeOf(entry: DevLogEntry): number {
  try {
    return JSON.stringify(entry).length + 1;
  } catch {
    return 512;
  }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/**
 * Opens a run, so every note from one scan carries the same id and the screen can group
 * fifteen lines into one story.
 *
 * The id is random and short. It is NOT the prescription id and must never become it —
 * see the note on `DevLogEntry.runId`.
 *
 * Nesting: a second `beginRun` while one is open returns the OUTER id and does not
 * replace it, so a provider that opens its own run inside an extraction does not split
 * that extraction in two. `endRun` closes only the run it was given.
 */
export function beginRun(kind: string): string {
  if (!enabled) return '';
  if (runId) return runId;
  runCounter += 1;
  runId = `r${runCounter}${Math.random().toString(36).slice(2, 6)}`;
  record('info', 'app', DEV_EVENTS.runStart, { runKind: kind });
  return runId;
}

export function endRun(id: string, fields?: DevLogInput): void {
  if (!enabled || !id || runId !== id) return;
  record('info', 'app', DEV_EVENTS.runEnd, fields);
  runId = null;
}

/** The open run, or null. Used by the AI layer to stamp notes it did not open a run for. */
export function currentRunId(): string | null {
  return runId;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Oldest first — the order things happened, which is the order they read best. */
export function listEntries(): readonly DevLogEntry[] {
  return entries;
}

export function devLogStats(): {
  count: number;
  approxBytes: number;
  oldestTs: number | null;
  newestTs: number | null;
} {
  return {
    count: entries.length,
    approxBytes: bytes,
    oldestTs: entries[0]?.ts ?? null,
    newestTs: entries[entries.length - 1]?.ts ?? null,
  };
}

/**
 * Fires after every change: a new note, a purge, the toggle flipping.
 *
 * The listener is given nothing. The screen re-reads `listEntries()`, and `store.ts` uses
 * it to schedule a debounced write. Passing the entry would tempt a listener into keeping
 * its own copy, which is a second store nobody purges.
 */
export function subscribeDevLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A screen that throws in its own re-render must not stop the next note.
    }
  }
}

/**
 * Empties the ring. The FILE is store.ts's to delete — call `purgeDevLog()` from there
 * for both halves.
 */
export function clearEntries(): void {
  entries = [];
  bytes = 0;
  runId = null;
  notify();
}

// ── Serialisation ────────────────────────────────────────────────────────────

/** One JSON object per line. What goes on disk, and what "Copy All" hands over. */
export function toNdjson(list: readonly DevLogEntry[] = entries): string {
  const lines: string[] = [];
  for (const entry of list) {
    try {
      lines.push(JSON.stringify(entry));
    } catch {
      // Skip rather than abandon the whole file for one bad line.
    }
  }
  return lines.join('\n');
}

/**
 * Reads a file back, dropping anything this build does not recognise.
 *
 * Every field is put through the redactor AGAIN on the way in. The file was written by
 * this app, so in theory that is redundant — but the redaction rules are the thing most
 * likely to be tightened later, and a note written by last month's build must not be able
 * to walk past this month's rules on its way to the screen.
 */
export function fromNdjson(text: string): DevLogEntry[] {
  const out: DevLogEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object') continue;
      const row = parsed as Record<string, unknown>;
      if (!isLevel(row['level']) || !isCategory(row['category']) || !isKnownEvent(row['event'])) {
        continue;
      }
      const ts = row['ts'];
      const rowSeq = row['seq'];
      const rowRun = row['runId'];
      const rowFields = row['fields'];
      out.push({
        seq: typeof rowSeq === 'number' ? rowSeq : 0,
        ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : 0,
        level: row['level'],
        category: row['category'],
        event: row['event'],
        runId: typeof rowRun === 'string' && rowRun.length > 0 ? rowRun : null,
        fields:
          rowFields !== null && typeof rowFields === 'object' && !Array.isArray(rowFields)
            ? redactFields(rowFields as Record<string, unknown>)
            : {},
      });
    } catch {
      // A half-written last line after a kill. Expected, not exceptional.
    }
  }
  return out;
}

/**
 * Restores notes from a previous launch, so an error that killed the app is still there
 * when it comes back up.
 *
 * Refuses to do anything when the toggle is off, which is what makes "we will not store
 * the logs at all" survive a restart: an install whose toggle was turned off never reads
 * the file, and store.ts deletes it at the same moment anyway.
 */
export function seedEntries(previous: readonly DevLogEntry[]): void {
  if (!enabled || previous.length === 0) return;
  // Prepended, because they happened first. `seq` from a previous launch is meaningless
  // here, so it is renumbered below the current counter to keep the ordering total.
  const renumbered = previous.map((entry, index) => ({ ...entry, seq: index - previous.length }));
  entries = [...renumbered, ...entries];
  bytes = entries.reduce((total, entry) => total + sizeOf(entry), 0);
  while (entries.length > MAX_ENTRIES || (bytes > MAX_BYTES && entries.length > 1)) {
    const dropped = entries.shift();
    if (!dropped) break;
    bytes -= sizeOf(dropped);
  }
  notify();
}

// ── Human-readable rendering ─────────────────────────────────────────────────

/**
 * One line per note, for the share sheet and for the log screen's monospace list.
 *
 * ISO timestamps rather than local ones: the person reading this is comparing it against
 * a server's own logs, and "10:04" without a zone is a puzzle. The screen is free to show
 * something friendlier; this is the copyable form.
 */
export function formatEntry(entry: DevLogEntry): string {
  const time = new Date(entry.ts).toISOString();
  const run = entry.runId ? ` ${entry.runId}` : '';
  const fields = Object.entries(entry.fields)
    .map(([name, value]) => `${name}=${renderValue(value)}`)
    .join(' ');
  return `${time} ${entry.level.toUpperCase().padEnd(5)} ${entry.event}${run}${
    fields ? ` ${fields}` : ''
  }`;
}

function renderValue(value: DevLogFields[string]): string {
  if (typeof value === 'string') return value.includes(' ') ? `"${value}"` : value;
  return String(value);
}

export function formatEntries(list: readonly DevLogEntry[] = entries): string {
  return list.map(formatEntry).join('\n');
}
