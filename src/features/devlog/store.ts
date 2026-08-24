/**
 * Where the toggle is kept, where the notes are kept, and the two rules that decide both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE ONE: THE NOTES DO NOT GO IN THE DATABASE.
 *
 * A `devlog` table would have been half the code of this file. It is refused for four
 * reasons, and the second one is the serious one.
 *
 *  1. `openDatabase()` is deliberately paranoid — every migration takes a `VACUUM INTO`
 *     snapshot and then runs `integrity_check` and `foreign_key_check` over the result,
 *     because that file is the only copy of her health record. A high-churn table of
 *     disposable notes makes every one of those snapshots bigger and every check slower,
 *     for data that is worthless the moment the bug is fixed.
 *
 *  2. THE BACKUP CAPSULE EXPORTS THE DATABASE WHOLE. `features/backup/paths.ts` copies it
 *     with `VACUUM INTO` into `db/aarogya.db` inside every capsule. A log table would
 *     therefore ride inside every backup her son ever moves between phones or mails to
 *     himself — silently, permanently, and long after the debugging session ended. The
 *     same argument rules out `Paths.document`, because the capsule walker takes that
 *     whole directory tree by design.
 *
 *  3. A log write would take the same write lock as a dose write.
 *
 *  4. It would need a migration and a `TABLES` entry — permanent schema surface for a
 *     temporary feature, in a codebase whose migration list is append-only.
 *
 * So: `Paths.cache`. The capsule walker never enters it, Android may reclaim it under
 * storage pressure (which for a debug log is a feature), and it is excluded from Android
 * auto-backup along with everything else by `plugins/withNoBackup.js`. This is the same
 * argument `backup/paths.ts` already makes for its plaintext `VACUUM INTO` target.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE TWO: OFF MEANS NO FILE.
 *
 * Not an empty file, not a header, not a directory. `aarogya-devlog/` does not exist on a
 * phone that has never had the toggle on, and it is DELETED the moment the toggle goes
 * off — because "we will not store the logs at all" has to survive turning the feature
 * off, or it only ever meant "from now on".
 *
 * WHAT A BOOT WITH THE TOGGLE OFF ACTUALLY COSTS, END TO END: one `AsyncStorage.getItem`
 * that comes back empty, and one `Directory.exists` on a directory that is not there. No
 * file is opened or created, no key is written (see `mirrorOnDisk` below, which is what
 * removed the last write), `record()` returns on its first line before it touches a field
 * bag, and `recordAppError` returns before it touches the error. Nothing is stored,
 * allocated or formatted on any path — that list is the whole of it, and it is meant to
 * stay short enough to re-check by reading.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE THREE: THE TOGGLE HAS TO BE READABLE BEFORE THE DATABASE IS.
 *
 * The truth about the toggle is a row in `app_meta`, and reading it means opening the
 * database. That ordering quietly excluded the most valuable errors in the app from the
 * log: `openDatabase()` runs migrations, takes a `VACUUM INTO` snapshot, and then runs
 * `integrity_check` and `foreign_key_check` over the result — and every one of those can
 * fail on a phone whose health record is the only copy there is. Boot could not record any
 * of them, because the only thing that knew whether to record had not been able to run yet.
 *
 * So the toggle is MIRRORED into AsyncStorage every time it is flipped, and boot reads that
 * copy first — no SQLite, no migrations, nothing that can fail in the way we are trying to
 * observe. `app_meta` remains the authority: `initDevLog()` still reads the row once the
 * database is open and corrects both the recorder and the mirror if they disagree.
 *
 * A NOTE ON THE WORD "MIRROR", WHICH NOW MEANS TWO THINGS. `recorder.ts` calls its
 * synchronous in-memory boolean the mirror, because it mirrors the stored preference. This
 * one is on disk and exists so the preference can be read before the database can. It is
 * called the BOOT MIRROR wherever the difference matters.
 *
 * THREE THINGS THE BOOT MIRROR IS NOT, because each would break a promise made elsewhere:
 *
 *  1. It is NOT a second copy of the notes. It holds one character, '1', and only while the
 *     toggle is on. Turning the toggle off REMOVES the key rather than writing '0' — same
 *     reasoning as the file: an install that never turned this on carries no trace of it.
 *
 *  2. It is NOT a second way to flip the toggle. `setDevLogEnabled()` is still the only
 *     one; the mirror is written by it, never independently, and any disagreement is
 *     resolved in favour of the row.
 *
 *  3. It does NOT ride in the backup capsule. AsyncStorage on Android is a SQLite database
 *     under `databases/`, and the capsule walker takes `Paths.document` — a different
 *     directory. (`app_meta` itself is inside the health record and therefore already
 *     travels in every capsule, which is a fact about the row, not something this adds.)
 *
 * The window that stays honest: notes produced BEFORE the mirror has been read are still
 * dropped, because the recorder defaults to off and off is the fail-closed direction. That
 * window is now a single AsyncStorage read at the very top of boot instead of an entire
 * migration run.
 *
 * The one case where the mirror can be WRONG, stated rather than glossed over: the row was
 * set to '0' and the matching key removal failed. That phone then records boot notes for as
 * long as the database takes to open, and `initDevLog()` ends it — `setRecording(false)`
 * empties the ring in the same tick and the file is deleted, so nothing survives the boot
 * it was written in. It can only happen on a phone where a human had the toggle ON and
 * turned it off; an install that never enabled this has no key to be stale.
 *
 * ─── WHY THE WHOLE RING IS REWRITTEN RATHER THAN APPENDED ────────────────────
 *
 * The file is exactly the ring, serialised: same 400 notes, same 256 KB cap, same
 * eviction. That makes rotation a non-problem (the ring already evicts), makes the screen
 * and the file impossible to disagree, and makes purge one `delete()`. The cost is one
 * synchronous write of at most a quarter of a megabyte, debounced, on a feature that is
 * off unless somebody deliberately turned it on.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { getDb, queryFirst } from '../../db/repositories/_shared';
import {
  clearEntries,
  formatEntries,
  fromNdjson,
  isRecording,
  listEntries,
  record,
  seedEntries,
  setRecording,
  subscribeDevLog,
  toNdjson,
} from './recorder';
import { DEV_EVENTS } from './types';

/** `app_meta` key. '1' is on; anything else, including a missing row, is off. */
export const META_DEVLOG_ENABLED = 'devlog_enabled';

/**
 * The BOOT MIRROR: the AsyncStorage copy of that row. See RULE THREE in the header.
 *
 * Named in the same family as `aarogya.ui.largeText` and `aarogya.ui.language`, the app's
 * only other AsyncStorage keys, so a future reader finds all three at once. '1' is on;
 * ABSENT is off — the key is removed rather than set to '0'.
 */
const MIRROR_KEY = 'aarogya.devlog.enabled';

const DIR_NAME = 'aarogya-devlog';
const FILE_NAME = 'log.ndjson';

/**
 * How long after the last note the ring is written out.
 *
 * Long enough that a burst of fifteen notes during one scan costs one write, short enough
 * that a note is on disk before somebody navigates away and reads it. An `error` shortens
 * it to almost nothing, because the interesting thing about a fatal error is that the
 * process may not be alive in a second's time.
 */
const FLUSH_IDLE_MS = 1_200;
const FLUSH_URGENT_MS = 50;

let hydrated = false;
let initialised = false;
/**
 * What the BOOT MIRROR was last seen or last written to hold, so a boot that changes
 * nothing writes nothing.
 *
 * WHY THIS EXISTS. `initDevLog()` ends by calling `writeMirror(on)`, and on the phone this
 * feature is off on — which is every phone, almost always — that meant an
 * `AsyncStorage.removeItem` on EVERY COLD START, deleting a key that was not there. It
 * stores nothing, so the promise held; but it is a SQLite write transaction charged to a
 * feature whose whole claim is that it costs nothing while it is off, and "we do a pointless
 * write per boot but only a harmless one" is not the sentence anybody wants to have to make.
 *
 * 'unknown' is the fail-safe value and every uncertainty resolves to it: the read threw, a
 * write threw, or nobody has looked yet. From 'unknown' the write always happens, which is
 * exactly the old behaviour — this can therefore skip a write it should have made only if
 * something claimed to know the disk's contents and was wrong, and the two places that set
 * it are the read and the write themselves.
 */
let mirrorOnDisk: '1' | 'absent' | 'unknown' = 'unknown';
/**
 * Whether the previous launch's notes have already been read back in.
 *
 * Without it the two hydration passes below would each call `seedEntries(readFile())` and
 * the screen would show every note from the previous launch twice — the file is prepended
 * to the ring, not merged with it.
 */
let seededFromFile = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

// ── The toggle ───────────────────────────────────────────────────────────────

/**
 * PASS ONE: the toggle as the BOOT MIRROR last saw it, with no database involved.
 *
 * Call this FIRST in boot, before `openDatabase()`. That ordering is the whole point —
 * see RULE THREE in the header. A migration that fails, an `integrity_check` that comes
 * back with something other than 'ok', a `foreign_key_check` with rows in it: those are
 * the errors most worth having, and until this existed the app could not be recording yet
 * when any of them happened.
 *
 * IT ONLY EVER TURNS RECORDING ON. A missing or '0' mirror leaves the recorder exactly as
 * it starts — off, storing nothing — and deliberately does NOT delete the log file, which
 * is pass two's job. The reason is an upgrade: a phone whose toggle was turned on by a
 * build older than this mirror has an `app_meta` row saying on and no mirror at all, and
 * deleting the file here on that hearsay would destroy last night's crash a few hundred
 * milliseconds before the row could say "keep it". Nothing is STORED in that window either
 * way, which is the guarantee that actually matters.
 *
 * Never throws.
 */
export async function hydrateDevLogFromMirror(): Promise<void> {
  if (hydrated || initialised) return;
  hydrated = true;
  try {
    const stored = await AsyncStorage.getItem(MIRROR_KEY);
    // Remembered BEFORE the early return, so the overwhelmingly common case — the key is
    // absent because nobody ever turned this on — lets pass two skip its write entirely.
    mirrorOnDisk = stored === '1' ? '1' : 'absent';
    if (stored !== '1') return;
    startRecording();
  } catch {
    // Leave recording off, and leave `mirrorOnDisk` at 'unknown' so pass two writes rather
    // than trusting a read that did not happen. Pass two gets the authoritative answer a
    // moment later either way.
  }
}

/**
 * PASS TWO: the stored preference, from the row that owns it.
 *
 * Call it once the database is open. It is what makes `app_meta` the authority: whatever
 * pass one guessed from the mirror, this either confirms it, corrects it, or — on the
 * install where the mirror did not exist yet — writes the mirror so the next boot does not
 * have to guess at all.
 *
 * IDEMPOTENT, and still safe to call from the Settings screen, which uses it to refuse to
 * render a switch whose position it has not established.
 *
 * Never throws. A logger that can stop an app from booting is a defect several orders of
 * magnitude worse than the bug it was added to find.
 */
export async function initDevLog(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    const on = await readStoredFlag();
    if (on) {
      startRecording();
    } else {
      // A phone whose toggle is off must not be carrying yesterday's notes.
      stopRecording();
    }
    writeMirror(on);
  } catch {
    // The row could not be read — which on this path almost certainly means the database
    // did not open, the exact failure pass one exists to keep recordable. So the boot
    // mirror's answer STANDS rather than being downgraded to off: it is the last thing a human
    // actually chose, and turning recording off here would silence the one launch worth
    // observing. Still fail-closed on an install that never turned the toggle on, because
    // then the mirror said off too.
  }
}

/** The cached mirror. Synchronous, and the only thing a hot call site should consult. */
export function isDevLogEnabled(): boolean {
  return isRecording();
}

/**
 * Flips the toggle. THE ONLY WAY IT CAN BE FLIPPED.
 *
 * The recorder's own in-memory flag is set FIRST and synchronously, so no note slips
 * through between the user's tap and the row being written — in either direction. The row
 * is then updated; if that write fails the in-memory flag still governs this session and
 * the next boot re-reads whatever is on disk, which is the safe way round for a feature
 * that defaults to off.
 *
 * TURNING IT OFF DELETES WHAT IS ALREADY RECORDED, in memory and on disk. The screen must
 * say so before it calls this — see the copy suggested in the module README comment.
 */
export async function setDevLogEnabled(on: boolean): Promise<void> {
  if (on) startRecording();
  else stopRecording();
  // Written before the row, and fire-and-forget. It is a cache of the row for the next
  // boot, so a failed write costs the first few hundred milliseconds of ONE launch and
  // nothing else — pass two corrects it as soon as the database opens.
  writeMirror(on);
  try {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO app_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [META_DEVLOG_ENABLED, on ? '1' : '0'],
    );
  } catch {
    // The recorder's own mirror already governs this session.
  }
}

/**
 * Both hydration passes and the toggle itself go through this pair, so the three paths
 * cannot drift apart — which is how one of them ends up recording without persisting, or
 * deleting the file without emptying the ring.
 *
 * Both are idempotent: `setRecording` returns early when the value has not changed,
 * `startPersisting` returns early when it is already subscribed, and `deleteFile` on a
 * directory that does not exist is a no-op.
 */
function startRecording(): void {
  setRecording(true);
  if (!seededFromFile) {
    seededFromFile = true;
    // AFTER `setRecording(true)` — `seedEntries` refuses to restore anything while the
    // toggle is off, which is what makes "not stored at all" survive a restart.
    seedEntries(readFile());
  }
  startPersisting();
}

function stopRecording(): void {
  setRecording(false); // empties the ring in the same tick
  stopPersisting();
  deleteFile();
  // There is nothing left on disk to seed from, so a later `startRecording()` must not
  // think there is: the file it would read is the one this just deleted.
  seededFromFile = false;
}

async function readStoredFlag(): Promise<boolean> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [META_DEVLOG_ENABLED],
  );
  return row?.value === '1';
}

/**
 * Keeps the BOOT MIRROR in step with the row. Fire-and-forget, and it swallows everything.
 *
 * OFF REMOVES THE KEY rather than writing '0'. Same argument as the log file: "we will not
 * store the logs at all" is a statement about a phone that has this feature off, and a
 * leftover key is a small permanent trace of a debugging session that ended.
 */
function writeMirror(on: boolean): void {
  const target = on ? '1' : 'absent';
  // Already in that state, and we know it because we read it or wrote it. The boot this
  // saves is the ordinary one: toggle off, key absent, nothing to say.
  if (mirrorOnDisk === target) return;
  mirrorOnDisk = target;

  const write = on ? AsyncStorage.setItem(MIRROR_KEY, '1') : AsyncStorage.removeItem(MIRROR_KEY);
  void write.catch(() => {
    // Back to not knowing, so the next call retries instead of believing this one. The
    // cost of the failure itself is the first few hundred milliseconds of ONE later launch,
    // and pass two corrects it as soon as the database opens — never worth a throw on the
    // path that is flipping a debug switch.
    mirrorOnDisk = 'unknown';
  });
}

// ── Persistence ──────────────────────────────────────────────────────────────

function startPersisting(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeDevLog(scheduleFlush);
}

function stopPersisting(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

function scheduleFlush(): void {
  if (!isRecording()) return;
  const list = listEntries();
  const urgent = list[list.length - 1]?.level === 'error';
  const delay = urgent ? FLUSH_URGENT_MS : FLUSH_IDLE_MS;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeFile();
  }, delay);
}

/**
 * Writes now rather than in a second's time.
 *
 * The log screen calls this before sharing or copying, so what leaves the phone is what
 * is on the screen rather than what happened to have been flushed.
 */
export function flushDevLog(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  writeFile();
}

/**
 * Deletes everything: the ring, the file, the directory.
 *
 * The button her son asked for. Deliberately does NOT turn the toggle off — clearing the
 * notes to start a clean reproduction is a different intention from deciding to stop
 * keeping notes, and merging the two would make the clean-slate button also close the
 * feature he is in the middle of using.
 */
export function purgeDevLog(): void {
  clearEntries();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  deleteFile();
}

/** Everything currently held, as text. What "Copy All" and the share sheet hand over. */
export function devLogShareText(): string {
  return formatEntries();
}

/** The machine-readable form, for anyone who wants to grep it off a desk. */
export function devLogNdjson(): string {
  return toNdjson();
}

// ── Files. Every one of these swallows its own failures. ─────────────────────

function logDirectory(): Directory {
  return new Directory(Paths.cache, DIR_NAME);
}

function logFile(): File {
  return new File(logDirectory(), FILE_NAME);
}

function writeFile(): void {
  if (!isRecording()) return;
  try {
    const dir = logDirectory();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = logFile();
    if (!file.exists) file.create({ overwrite: true });
    file.write(toNdjson());
  } catch {
    // A full disk, a reclaimed cache directory mid-write, a device in a state the OS will
    // not let us write to. The notes stay in memory and the screen still shows them.
  }
}

function readFile(): ReturnType<typeof fromNdjson> {
  try {
    const file = logFile();
    if (!file.exists) return [];
    return fromNdjson(file.textSync());
  } catch {
    return [];
  }
}

function deleteFile(): void {
  try {
    const dir = logDirectory();
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to be done, and nothing depends on it.
  }
}

// ── Uncaught errors ──────────────────────────────────────────────────────────

/**
 * Records an error that nothing else caught.
 *
 * Report 7 asks for "all other error logs of app", and this is the honest version of it:
 * WHERE it happened, the error's CLASS NAME, and the FIRST STACK FRAME. Those three are on
 * the allow-list in `redact.ts` and are scrubbed and capped on the way in.
 *
 * ─── `errorMessage` IS PASSED AND IS DELIBERATELY NOT PRINTED ────────────────
 *
 * It comes out as `[blocked]`, every time, by design. `redact.ts` dropped the name from
 * `TEXT_FIELDS` because two shipped error classes prove a JS message is not machine text:
 * `InstrumentBoundsError` says "Blood sugar of 412 is outside what any instrument can
 * report", and `BriefcaseCopyError` embeds the path of a file she named herself. The log
 * screen tells her, in the app's own voice and with no hedge, that these notes contain no
 * readings — and she is reading that while deciding whether to let her son paste the whole
 * thing into a chat with a stranger.
 *
 * The field is still handed over rather than deleted at this call site, so the line says
 * out loud that a message existed and was refused. If that ever reads as noise, delete it
 * HERE — never by putting the name back on the allow-list.
 */
export function recordAppError(error: unknown, where: string): void {
  if (!isRecording()) return;
  record('error', 'app', DEV_EVENTS.appError, () => ({
    where,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    stackTop: error instanceof Error ? firstFrame(error.stack) : null,
  }));
}

function firstFrame(stack: string | undefined): string | null {
  if (!stack) return null;
  const lines = stack.split('\n');
  // Line 0 is "TypeError: …", which is already in `errorName`/`errorMessage`.
  return lines[1]?.trim() ?? null;
}

/** The uninstaller for the handler currently in place, or null when none is. */
let uninstallGlobalHandler: (() => void) | null = null;

/**
 * Chains this recorder onto React Native's global handler.
 *
 * `ErrorUtils` is a React Native global with no type declaration, hence the narrowing.
 * The PREVIOUS handler is always called afterwards — replacing it would stop the red box
 * in development and, worse, stop whatever else the app does on a fatal error.
 *
 * ─── INSTALLING IS IDEMPOTENT, AND HAS TO BE ─────────────────────────────────
 *
 * Boot calls this and discards the uninstaller, which is fine exactly because of the guard
 * below. Boot is not a once-per-process event: the boot screen's "Try again" button
 * re-runs the whole sequence, and a fast refresh in development remounts it. Without the
 * guard each of those chained ANOTHER copy of this handler onto the one already installed
 * — because our own handler becomes the "previous" of the next one. Three retries meant
 * one crash recorded four times, flushed four times, and four handlers in a chain that
 * only grows for the life of the process.
 *
 * So: already installed, already correct. The existing uninstaller is returned so a caller
 * that genuinely wants the old handler back still gets one.
 *
 * The uninstaller restores whatever was in place when we installed. If something else has
 * since set its own handler, putting ours back is the wrong answer — but nothing in
 * `ErrorUtils` can tell us that, and the same was true before the guard existed. Nothing in
 * this app installs one apart from React Native itself.
 */
export function installGlobalErrorRecorder(): () => void {
  if (uninstallGlobalHandler) return uninstallGlobalHandler;

  const holder = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const utils = holder.ErrorUtils;
  // Nothing was installed, so nothing can stack. Deliberately does not arm the guard: a
  // later call on a platform that does have `ErrorUtils` should still install.
  if (!utils?.getGlobalHandler || !utils.setGlobalHandler) return () => {};

  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    recordAppError(error, isFatal ? 'fatal' : 'uncaught');
    // Straight to disk: this process may not be alive in a second's time.
    flushDevLog();
    previous(error, isFatal);
  });

  const uninstall = (): void => {
    // Called twice, or after somebody else reinstalled: do nothing rather than shove a
    // stale handler back into place.
    if (uninstallGlobalHandler !== uninstall) return;
    uninstallGlobalHandler = null;
    utils.setGlobalHandler?.(previous);
  };
  uninstallGlobalHandler = uninstall;
  return uninstall;
}
