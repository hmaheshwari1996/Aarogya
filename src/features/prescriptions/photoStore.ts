/**
 * Where a prescription photograph actually lives — and why it was not living there.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS MODULE EXISTS FOR
 *
 * `expo-image-picker` does not hand back the photograph. It hands back a COPY of it that
 * the picker wrote into the app's CACHE directory — `…/cache/ImagePicker/<uuid>.jpeg` —
 * for both doors, the camera and the gallery. Android is free to empty that directory
 * whenever the device is short of storage, without asking and without telling the app, and
 * on the 2 GB handsets this app is built for that is not a hypothetical: it is a normal
 * Tuesday on a Xiaomi with 400 MB free.
 *
 * `capture.tsx` used to write that cache URI straight into `prescription.image_uri` and
 * into the `app_meta` page list. Nothing in the prescription path imported
 * `expo-file-system` at all. So the row survived and the photograph did not, and the two
 * places that then read it fail in different but equally bad ways:
 *
 *   • `<Image source={{ uri }}>` on the detail screen draws an empty grey box.
 *   • `measureImage()` throws, `cropToMedicineBlock` turns that into `image_unreadable`,
 *     and she is told "This photo could not be opened. Please take it again." — about the
 *     photograph of a prescription she may no longer physically have.
 *
 * And it made a sentence the app repeats in nine different error strings — "Your photo is
 * saved" — quietly untrue. In a capture-first design for an app with NO SERVER AND NO
 * CLOUD BACKUP, that photograph is the only copy of what the doctor wrote. There is
 * nowhere to get it back from.
 *
 * It was worse than a broken thumbnail, because of `features/backup/paths.ts`: the backup
 * capsule takes the DIRECTORY TREE under `Paths.document`, and the cache directory is not
 * in it. Every capsule she has ever made contains a database full of prescription URIs and
 * not one prescription photograph. The header of that file says the photograph is "the ONLY
 * evidence of what the doctor actually wrote"; it was also the one thing the capsule never
 * carried. Copying into `Paths.document` fixes the backup at the same time as the purge,
 * for free and with nobody having to remember.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `Paths.document/prescriptions`, AND NOT ANY OF THE ALTERNATIVES
 *
 * On Android `Paths.document` is `context.getFilesDir()` — internal, app-private storage.
 * Four properties were required of the destination and this is the only place with all
 * four:
 *
 *   • IT SURVIVES AN APP UPDATE. filesDir is not touched by an install of a newer APK.
 *   • NO OTHER APP CAN READ IT, and it is not in MediaStore, so the photograph does not
 *     appear in the phone's Gallery or in WhatsApp's picker. This matters more here than
 *     anywhere else in the app: a prescription photograph carries her diagnosis, her
 *     doctor's name and her doctor's clinic in one frame, and a woman with active
 *     tuberculosis has a specific and well-founded interest in that not showing up in a
 *     photo grid somebody else scrolls through.
 *   • IT IS DELETED WHEN THE APP IS UNINSTALLED, which is what the app promises on the
 *     settings screen and in the backup copy. Anything on shared/external storage would
 *     outlive the uninstall and make that promise false.
 *   • IT IS NOT BACKED UP ANYWHERE. `plugins/withNoBackup.js` sets allowBackup=false and
 *     excludes every domain from both `<cloud-backup>` and `<device-transfer>`, so these
 *     bytes never reach Google Drive or a phone-to-phone transfer. Only the capsule she
 *     makes herself, with a passphrase she chose, carries them.
 *
 * What was rejected, and why it is worth writing down:
 *
 *   • THE CACHE DIRECTORY — the status quo. Fails the first property, catastrophically.
 *   • `Paths.document/briefcase` — tempting, because the copy machinery already exists
 *     there. It would be a serious bug. `sweepOrphanBriefcaseFiles` lists that directory
 *     at every boot and queues for deletion every file that no `document` ROW references.
 *     A prescription page has no `document` row, so the boot after the capture would
 *     cheerfully queue every page of her prescription for unlinking. The briefcase
 *     directory belongs to the briefcase.
 *   • MediaStore / `expo-media-library` — puts the prescription in the Gallery. No.
 *   • The external files dir — readable by anything with storage permission, and its
 *     lifetime across uninstall is OEM-dependent.
 *
 * `Paths.document/labs` already exists for exactly this reason (`persistPhoto` in
 * `src/app/labs/new.tsx`), so `prescriptions` is a sibling in a layout that is already the
 * house style, and the capsule walker picks it up with no change at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELETION REUSES `pending_file_delete`. IT DOES NOT INVENT A SECOND MECHANISM.
 *
 * `deletePrescriptionWithPhotos` below soft-deletes the row and queues its files in ONE
 * transaction, which is exactly what `deleteDocument` does for the briefcase and for the
 * reasons set out at length in `src/db/repositories/files.ts`. The unlink itself is done by
 * `sweepPendingFileDeletes`, which already runs at boot. Nothing here touches the
 * filesystem inside a transaction, nothing here gets one attempt, and a process killed
 * between the commit and the unlink still ends with the bytes gone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STILL NOT GUARANTEED, SAID OUT LOUD
 *
 * A page copied in and then abandoned by a PROCESS DEATH — not a back press, which is
 * handled, but an OOM kill while the capture screen is open — leaves bytes in the store
 * that no row will ever reference. `sweepOrphanPrescriptionPhotos()` in
 * `features/files/sweeper.ts` now collects those at boot, using `listPrescriptionPhotoUris()`
 * below as its "what is referenced" query. TWO THINGS ABOUT IT THAT MUST NOT DRIFT:
 *
 *   • That query reads the `app_meta` page lists as well as the two columns. Page 2 of a
 *     prescription exists NOWHERE ELSE, so a sweep given only the columns would queue the
 *     back half of every multi-page prescription for deletion.
 *   • `boot()` awaits `repairPrescriptionPhotos()` BEFORE the sweep. The repair copies a
 *     file in and re-points the row afterwards; a sweep in between would see its own
 *     rescue as an orphan. The sweep's age floor is the second guard on the same window.
 */

import { Directory, File, Paths } from 'expo-file-system';

import { newId } from '../../lib/ids';
import { inTransaction, queryAll, queryFirst, type Tx } from '../../db/repositories/_shared';
import { requestFileDelete } from '../../db/repositories/files';
import { deletePrescription, updatePrescription } from '../../db/repositories/prescriptions';
import {
  directoryUri,
  isUnder,
  photoExtension,
  planPages,
  type PagePlan,
} from './photoPaths';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Where things live
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The directory under `Paths.document`. Its NAME is what a capsule mirrors and what a
 * restore re-points into, so it is fixed and it is written down once.
 */
export const PRESCRIPTION_PHOTO_DIR_NAME = 'prescriptions';

/**
 * Where the pages after the first one live.
 *
 * `prescription` has exactly two image columns (`image_uri`, `cropped_image_uri`) and no
 * page table. Page 1 goes in `image_uri` so every other screen's thumbnail keeps working,
 * and the full ordered list is kept in `app_meta` under this prefix.
 *
 * It is declared HERE rather than in `src/app/prescription/capture.tsx`, which is where it
 * was and which still re-exports it so the two screens that import it from there are
 * unchanged. The reason is the same one `BRIEFCASE_DIR_NAME` moved out of
 * `src/app/briefcase/_lib.tsx`: this module has to read and write that key to delete a
 * prescription's files and to repair them, and a feature module that imports a screen
 * drags React and expo-router in behind it.
 */
export const PRESCRIPTION_PAGES_META_PREFIX = 'prescription_pages:';

/**
 * Refuse a copy unless this much space is free ON TOP of the photograph itself.
 *
 * The same number and the same reasoning as `REQUIRED_FREE_SPACE_MARGIN_BYTES` in
 * `src/app/briefcase/_lib.tsx`, declared again rather than imported because that file is a
 * screen. Filling the last byte of a phone does not only fail this copy — it takes the
 * database's next write with it, and that database is her medicine history.
 */
const REQUIRED_FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

/**
 * The size to assume when the filesystem will not say how big the source is.
 *
 * An unknown size fails CLOSED, exactly as the briefcase copy does: a phone that cannot
 * spare 12 MB plus the margin is a phone that should not be asked to write a photograph at
 * all. For scale, a 0.85-quality camera photograph of an A4 page is 1–4 MB, so this is
 * several times the worst plausible real case and still trivially clearable by any phone
 * with room.
 */
const ASSUMED_PHOTO_BYTES = 12 * 1024 * 1024;

/**
 * How many photographs one repair pass will copy.
 *
 * A bound, not a target. The pass runs on a screen the user is waiting on, and whatever is
 * left is picked up by the next one — the rows are durable, so stopping early drops
 * nothing. No real record comes close: this is insurance against a database that somehow
 * did.
 */
const MAX_REPAIR_COPIES = 100;

function photoDirectory(): Directory {
  return new Directory(Paths.document, PRESCRIPTION_PHOTO_DIR_NAME);
}

/** The store's URI prefix, with its trailing slash. Read fresh — see `directoryUri`. */
function storePrefix(): string {
  return directoryUri(Paths.document.uri, PRESCRIPTION_PHOTO_DIR_NAME);
}

/** Is this URI a file the app itself wrote into the prescription store? */
export function isStoredPrescriptionPhoto(uri: string): boolean {
  try {
    return isUnder(uri, storePrefix());
  } catch {
    // `Paths.document` is a native getter. If it will not answer, the honest response is
    // "we cannot prove this file is ours", and every caller treats that as "leave it".
    return false;
  }
}

/**
 * A URI the app is allowed to unlink on her behalf.
 *
 * The store, plus the app's own cache directory — which is where `expo-image-picker` put
 * every photograph before this module existed, and where `imagePrep` still writes the
 * cropped copy it sends to the model. Both are inside this app's private storage and were
 * written by this app or on its behalf. Anything else — a `content://` from another app, a
 * path in shared storage, a photograph in her Gallery — is somebody else's file and is
 * never queued for deletion, no matter what a row says.
 */
function isAppOwnedPhoto(uri: string): boolean {
  if (uri.trim().length === 0) return false;
  if (isStoredPrescriptionPhoto(uri)) return true;
  try {
    return isUnder(uri, `${Paths.cache.uri.replace(/\/+$/, '')}/`);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Copying a photograph in
// ═══════════════════════════════════════════════════════════════════════════════

/** Why a photograph could not be kept. Each maps to one sentence she actually reads. */
export type PhotoStoreFailure = 'no_space' | 'source_gone' | 'failed';

export class PrescriptionPhotoError extends Error {
  readonly reason: PhotoStoreFailure;
  constructor(reason: PhotoStoreFailure, detail?: string) {
    super(`prescription photo copy failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'PrescriptionPhotoError';
    this.reason = reason;
  }
}

export function isPrescriptionPhotoError(error: unknown): error is PrescriptionPhotoError {
  return error instanceof PrescriptionPhotoError;
}

/**
 * Copies a picked or captured photograph into the store and returns the new URI.
 *
 * ─── IT THROWS RATHER THAN FALLING BACK, AND THAT IS THE POINT ────────────────
 * `persistPhoto` in `src/app/labs/new.tsx` returns the ORIGINAL cache URI when the copy
 * fails, reasoning that a fragile record beats no record. That is right there — a lab row
 * also carries typed values she entered by hand, and the photograph is a bonus.
 *
 * It is wrong here, for the same reason it is wrong in the briefcase. A prescription IS its
 * photograph until somebody confirms medicines off it; a row pointing into the cache is a
 * row that will be showing "This photo could not be opened" in three weeks, with nothing
 * anywhere to restore it from. So a failed copy fails the PAGE — she is told immediately,
 * while she is still standing there holding the paper and can simply photograph it again.
 *
 * ─── ORDER OF THE GUARDS, AND THE HALF-FILE ───────────────────────────────────
 * Source first (cheap, and the one case where nothing can be done), then free space, then
 * the copy, then a size check on what was actually written. A partially written
 * destination is deleted on the way out of every failure path: a truncated JPEG is worse
 * than no file at all, because it looks like a photograph, it satisfies `exists`, and it
 * fails only when the manipulator tries to decode it — which is weeks later, on the day it
 * matters.
 *
 * ─── HOW MUCH OF THIS IS OFF THE JS THREAD: NONE OF IT ────────────────────────
 * `File.copy` is declared `copy(destination): void` and runs on the calling thread. The
 * `async` here buys ordering for the caller, not concurrency. That is acceptable because
 * the copy is native file-to-file inside one filesystem — no JS heap, no base64, tens of
 * milliseconds for a 3 MB photograph — and it is the honest description; do not describe
 * this function as "the copy happens in the background".
 */
export async function persistPrescriptionPhoto(sourceUri: string): Promise<string> {
  const source = new File(sourceUri);

  // `exists` is what turns "Android reclaimed the cache while she looked at the preview"
  // into a sentence instead of a stack trace.
  let sourceExists = false;
  try {
    sourceExists = source.exists;
  } catch {
    sourceExists = false;
  }
  if (!sourceExists) throw new PrescriptionPhotoError('source_gone');

  let sourceSize = 0;
  try {
    sourceSize = source.size;
  } catch {
    // 0 means "we never learned it" here, exactly as it does in the briefcase.
    sourceSize = 0;
  }

  let available: number | null = null;
  try {
    available = Paths.availableDiskSpace;
  } catch {
    // Some ROMs refuse to answer. Unknown free space is not a reason to refuse the copy —
    // the copy itself will fail honestly if there is genuinely no room.
    available = null;
  }
  const needed = sourceSize > 0 ? sourceSize : ASSUMED_PHOTO_BYTES;
  if (available !== null && available < needed + REQUIRED_FREE_SPACE_MARGIN_BYTES) {
    throw new PrescriptionPhotoError('no_space', `${available} free, needs ${needed}`);
  }

  const directory = photoDirectory();
  try {
    directory.create({ intermediates: true, idempotent: true });
  } catch (error) {
    throw new PrescriptionPhotoError('failed', describe(error));
  }

  let extension = '';
  try {
    extension = source.extension;
  } catch {
    extension = '';
  }
  const destination = new File(directory, `${newId()}${photoExtension(extension)}`);

  try {
    source.copy(destination);

    // Proving the bytes arrived, not merely that a file did. Android reports a full disk
    // through several different exception types and, on some OEM kernels, through a short
    // write with no exception at all — which is the case that leaves a half-photograph
    // looking healthy. When the source size is unknown there is nothing to compare
    // against, so a non-empty file is all that can be asserted.
    let written = 0;
    try {
      written = destination.size;
    } catch {
      written = 0;
    }
    if (written === 0 || (sourceSize > 0 && written !== sourceSize)) {
      throw new PrescriptionPhotoError(
        'failed',
        `copied ${written} of ${sourceSize > 0 ? sourceSize : 'unknown'} bytes`,
      );
    }
  } catch (error) {
    discardPrescriptionPhoto(destination.uri);
    if (isPrescriptionPhotoError(error)) throw error;
    const detail = describe(error);
    // The text is the only reliable signal for ENOSPC on Android, and getting it right is
    // the difference between "the phone has no space left" and a generic shrug.
    if (/enospc|no space/i.test(detail)) throw new PrescriptionPhotoError('no_space', detail);
    throw new PrescriptionPhotoError('failed', detail);
  }

  return destination.uri;
}

/**
 * Removes a photograph the capture screen copied in but never referenced from a row.
 *
 * Best effort by design, and it is NOT the deletion path for a saved prescription — that
 * one goes through `pending_file_delete` so it survives a crash. This is for the window
 * before any row exists at all: a page she removed from the list, a capture she abandoned,
 * a copy that failed its own size check. Nothing durable can be recorded about those,
 * because there is nothing durable to record it against.
 *
 * Refuses to touch anything outside the store, so a caller that hands it the wrong string
 * cannot delete her Gallery.
 */
export function discardPrescriptionPhoto(uri: string): void {
  if (!isStoredPrescriptionPhoto(uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* nothing to do, and nothing worth telling her */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. The page list in `app_meta`
// ═══════════════════════════════════════════════════════════════════════════════

function pagesKey(prescriptionId: string): string {
  return `${PRESCRIPTION_PAGES_META_PREFIX}${prescriptionId}`;
}

/** The stored page list for one prescription, or `[]`. Never throws on a corrupt blob. */
async function readPageList(prescriptionId: string, tx?: Tx): Promise<string[]> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [pagesKey(prescriptionId)],
    tx,
  );
  return parsePageList(row?.value ?? null);
}

function parsePageList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    // A corrupt blob degrades to "no page list", and the caller falls back to `image_uri`.
    // Throwing here would take down a screen over a JSON comma.
    return [];
  }
}

async function writePageList(prescriptionId: string, pages: readonly string[], tx: Tx): Promise<void> {
  await tx.db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [pagesKey(prescriptionId), JSON.stringify(pages)],
  );
}

/**
 * Every photograph URI any live prescription currently claims.
 *
 * Both columns and every page list, because a page after the first exists ONLY in
 * `app_meta` and a sweep that did not read it would treat page 2 as unreferenced. Exposed
 * because this is the query an orphan sweep for this directory needs — see the note at the
 * end of the file header.
 */
export async function listPrescriptionPhotoUris(tx?: Tx): Promise<string[]> {
  const uris: string[] = [];

  const rows = await queryAll<{ image_uri: string | null; cropped_image_uri: string | null }>(
    `SELECT image_uri, cropped_image_uri FROM prescription WHERE deleted_at_epoch IS NULL;`,
    [],
    tx,
  );
  for (const row of rows) {
    if (row.image_uri) uris.push(row.image_uri);
    if (row.cropped_image_uri) uris.push(row.cropped_image_uri);
  }

  for (const meta of await listPageListRows(tx)) {
    uris.push(...parsePageList(meta.value));
  }
  return uris;
}

type PageListRow = { key: string; value: string | null };

/**
 * Every `prescription_pages:*` row.
 *
 * `substr(key, 1, ?) = ?` rather than `key LIKE 'prescription_pages:%'` because the prefix
 * contains underscores, and `_` is LIKE's single-character wildcard. Today nothing else
 * would match; a rule that is only accidentally correct is not worth keeping.
 */
async function listPageListRows(tx?: Tx): Promise<PageListRow[]> {
  return queryAll<PageListRow>(
    `SELECT key, value FROM app_meta WHERE substr(key, 1, ?) = ?;`,
    [PRESCRIPTION_PAGES_META_PREFIX.length, PRESCRIPTION_PAGES_META_PREFIX],
    tx,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Deleting a prescription, bytes included
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Removes a prescription and guarantees its photographs follow.
 *
 * ONE TRANSACTION, which is the whole design and is `deleteDocument`'s design verbatim:
 * either the prescription is still listed with its pages intact, or it is delisted AND a
 * durable instruction to unlink each page exists on disk. There is no state in which she
 * has been told a prescription is gone while a photograph of her diagnosis is still on the
 * phone with nothing in the app able to find it, list it or remove it. The unlink itself is
 * `sweepPendingFileDeletes`, which runs at boot and after a briefcase delete.
 *
 * TWO GUARDS BEFORE ANYTHING IS QUEUED, and they are the ones `deleteDocument` uses:
 *
 *   1. The URI must be a file this app owns — the store, or its own cache. A row that
 *      points somewhere else points at somebody else's file.
 *   2. No OTHER live prescription may claim the same path. Every page is copied to its own
 *      UUID so sharing should be impossible, but "should be impossible" is not a
 *      guarantee, and the failure mode is a photograph vanishing from a prescription
 *      nobody touched. (It is reachable today: a Done that writes the row and then fails
 *      writing the page list, pressed a second time, produces two rows over one set of
 *      files.)
 *
 * The `app_meta` page list is HARD deleted along with it, unlike the row, which is soft
 * deleted so a family member's device can learn about the deletion. Keeping it would be
 * keeping a list of paths to files we have just asked the phone to destroy, which is the
 * exact thing `src/db/repositories/files.ts` refuses to do with its own rows. It is
 * device-local and never synced, so nothing else can want it.
 *
 * An unknown or already-deleted id is a no-op, so a double tap cannot queue twice.
 *
 * NOTE: nothing in the app calls this yet — there is no "remove this prescription" control
 * on any screen, and `deletePrescription` in the repository has never had a caller. This is
 * the function that control must use when it is built; a screen that calls the repository
 * directly would delist the prescription and leave every page of it on the disk.
 */
export async function deletePrescriptionWithPhotos(id: string, tx?: Tx): Promise<void> {
  await inTransaction(async (t) => {
    const row = await queryFirst<{ image_uri: string | null; cropped_image_uri: string | null }>(
      `SELECT image_uri, cropped_image_uri FROM prescription
        WHERE id = ? AND deleted_at_epoch IS NULL;`,
      [id],
      t,
    );
    if (!row) return;

    const pages = await readPageList(id, t);

    await deletePrescription(id, t);
    await t.db.runAsync(`DELETE FROM app_meta WHERE key = ?;`, [pagesKey(id)]);

    const candidates = unique(
      [...pages, row.image_uri ?? '', row.cropped_image_uri ?? ''].filter(
        (uri) => uri.length > 0 && isAppOwnedPhoto(uri),
      ),
    );
    if (candidates.length === 0) return;

    // Read AFTER the soft delete and the meta removal, so this prescription's own pages
    // cannot appear in it and protect themselves from being queued.
    const stillClaimed = new Set(await listPrescriptionPhotoUris(t));
    for (const uri of candidates) {
      if (stillClaimed.has(uri)) continue;
      await requestFileDelete(uri, 'prescription', t);
    }
  }, tx);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. The one-time repair of rows written before this module existed
// ═══════════════════════════════════════════════════════════════════════════════

export type PhotoRepairResult = {
  /** Photographs rescued out of the picker's cache into the store. */
  readonly copied: number;
  /** URIs from a previous install re-pointed at the file already in the store. */
  readonly repointed: number;
  /** URIs that resolve to nothing anywhere. The rows are left exactly as they were. */
  readonly lost: number;
};

const NOTHING_DONE: PhotoRepairResult = { copied: 0, repointed: 0, lost: 0 };

/**
 * Once per process. A remount of the capture screen must not restart a pass that is still
 * copying, and a second pass would find nothing to do anyway.
 */
let repairStarted = false;

/**
 * Brings every existing prescription's photographs into the store, and re-points the ones
 * a restore left behind.
 *
 * ─── WHY EXISTING ROWS ARE MIGRATED AT ALL ────────────────────────────────────
 * Because she has prescriptions on the phone RIGHT NOW whose files are sitting in the
 * picker's cache directory, one storage-pressure event away from being gone, with no
 * server and no capsule containing them. Doing nothing would fix the next photograph she
 * takes and abandon every one she has already taken — including, for a person on a
 * six-month multi-drug tuberculosis regimen, the paper that says what the regimen is.
 *
 * The copy is cheap (a native file-to-file copy of a couple of megabytes), it is
 * idempotent, and it is NON-DESTRUCTIVE: the source in the cache is never deleted by this
 * function. Android owns that directory and will reclaim it in its own time. Deleting it
 * ourselves would buy a few megabytes and risk destroying the only copy in the window
 * between the copy and the commit.
 *
 * A URI that resolves to nothing is LEFT ALONE. Blanking `image_uri` would be tidier and
 * would also destroy the only remaining evidence that a photograph was ever attached, and
 * the empty-state on the detail screen ("This prescription has no photo saved with it")
 * already reads correctly for a URI that does not load.
 *
 * ─── THE SECOND JOB: A RESTORE ONTO A DIFFERENT HANDSET ───────────────────────
 * `features/backup/restore.ts` re-points every `*_uri` COLUMN when the app's data
 * directory changes name, discovering the columns from `PRAGMA table_info`. It cannot see
 * inside `app_meta`, so page 2 onwards — which live in a JSON blob there — keep pointing at
 * the previous install. That gap did not matter while those URIs pointed into a cache that
 * was never in a capsule; it matters the moment the pages are real. So a URI that does not
 * resolve but whose FILE NAME is present in the store is re-pointed at it — matched on the
 * name for the same reason `sweepOrphanBriefcaseFiles` matches on the name, and safe
 * because every name in there is a UUID this app minted.
 *
 * ─── WHERE IT IS CALLED FROM, AND WHERE IT SHOULD BE ──────────────────────────
 * `boot()` in `src/app/index.tsx` is the right caller — it is where the two file sweeps
 * already run, and it is the only place that fires whether or not she visits a particular
 * screen. This change does not own that file, so the capture screen fires it on mount
 * instead: that is the screen this bug was found in, it is where she goes to add the next
 * prescription, and the pass is idempotent and bounded. Moving the call to `boot()` is one
 * line and nothing else has to change.
 *
 * NEVER THROWS. It is a fire-and-forget `void` from a screen effect, where a rejection is
 * an unhandled promise, and every failure it can meet is one where leaving the row exactly
 * as it is remains a correct outcome.
 */
export async function repairPrescriptionPhotos(): Promise<PhotoRepairResult> {
  if (repairStarted) return NOTHING_DONE;
  repairStarted = true;

  let rows: { id: string; image_uri: string | null }[];
  let metaRows: PageListRow[];
  try {
    rows = await queryAll<{ id: string; image_uri: string | null }>(
      `SELECT id, image_uri FROM prescription WHERE deleted_at_epoch IS NULL;`,
    );
    metaRows = await listPageListRows();
  } catch (error) {
    // The database is the authority on what exists. Without it there is nothing to repair
    // and nothing to conclude — a restore deliberately closes the connection, and a pass
    // that ran during one and saw no rows must not act on that.
    console.warn('[prescriptions] could not read the rows to repair', error);
    return NOTHING_DONE;
  }

  const probe = buildProbe();
  const pageLists = new Map<string, string[]>();
  for (const meta of metaRows) {
    const id = meta.key.slice(PRESCRIPTION_PAGES_META_PREFIX.length);
    if (id.length > 0) pageLists.set(id, parsePageList(meta.value));
  }

  let copied = 0;
  let repointed = 0;
  let lost = 0;

  for (const row of rows) {
    const stored = pageLists.get(row.id);
    // The same fallback the detail and review screens use: the page list when there is
    // one, otherwise the single column.
    const hasList = stored !== undefined && stored.length > 0;
    const pages = hasList ? stored : row.image_uri ? [row.image_uri] : [];
    if (pages.length === 0) continue;

    const plans = planPages(pages, probe);
    const resolved: string[] = [];
    let changed = false;

    for (const plan of plans) {
      const outcome = await applyPlan(plan, copied);
      if (outcome.copiedOne) copied += 1;
      if (outcome.repointedOne) repointed += 1;
      if (outcome.lostOne) lost += 1;
      if (outcome.uri !== plan.uri) changed = true;
      resolved.push(outcome.uri);
    }

    if (!changed) continue;

    try {
      await inTransaction(async (t) => {
        // The page list is only written when one already existed. Creating one here would
        // invent a multi-page prescription out of a single-column row, and every reader
        // treats a present list as authoritative.
        if (hasList) await writePageList(row.id, resolved, t);
        const first = resolved[0];
        if (first !== undefined && first !== row.image_uri) {
          // Through the repository, so the write is stamped and enqueued like every other.
          // The outbox entry is noise for a family device — a local path means nothing
          // there — but `image_uri` has always been a synced column and inventing an
          // exception to the writers here would be a worse trade than one wasted row.
          await updatePrescription(row.id, { imageUri: first }, t);
        }
      });
    } catch (error) {
      // The bytes are copied and the row still points at the old URI. Nothing is lost: the
      // next pass finds the same source (the cache copy was not deleted) and tries again;
      // the file written this time is the residual orphan named in the file header.
      console.warn('[prescriptions] could not re-point a repaired prescription', error);
    }
  }

  if (copied > 0 || repointed > 0 || lost > 0) {
    console.warn(
      `[prescriptions] photo repair: ${copied} copied into the store, ${repointed} re-pointed, ${lost} unresolved`,
    );
  }
  return { copied, repointed, lost };
}

type PlanOutcome = {
  readonly uri: string;
  readonly copiedOne: boolean;
  readonly repointedOne: boolean;
  readonly lostOne: boolean;
};

async function applyPlan(plan: PagePlan, copiedSoFar: number): Promise<PlanOutcome> {
  switch (plan.action) {
    case 'keep':
      return { uri: plan.uri, copiedOne: false, repointedOne: false, lostOne: false };
    case 'repoint':
      return { uri: plan.to, copiedOne: false, repointedOne: true, lostOne: false };
    case 'lost':
      return { uri: plan.uri, copiedOne: false, repointedOne: false, lostOne: true };
    case 'copy': {
      if (copiedSoFar >= MAX_REPAIR_COPIES) {
        return { uri: plan.uri, copiedOne: false, repointedOne: false, lostOne: false };
      }
      try {
        const uri = await persistPrescriptionPhoto(plan.uri);
        return { uri, copiedOne: true, repointedOne: false, lostOne: false };
      } catch (error) {
        // A full disk, most likely, and this is where the free-space guard earns its
        // keep: the copy is refused before it starts rather than filling the last byte
        // and taking the database's next write with it. The row keeps the cache URI it
        // already had — no worse than a minute ago — and the next pass tries again.
        console.warn('[prescriptions] could not copy a photo into the store', error);
        return { uri: plan.uri, copiedOne: false, repointedOne: false, lostOne: false };
      }
    }
  }
}

/**
 * The three disk questions the planner asks, answered once per pass.
 *
 * The store's contents are listed ONCE and held as a name→URI map: the alternative is a
 * directory listing per page, and the whole point of the name lookup is that it is the
 * fallback path, not the common one. A directory that cannot be listed yields an empty map,
 * which makes every `repoint` decision come back `lost` — the safe direction, since a
 * `lost` leaves the row untouched.
 */
function buildProbe(): {
  isStored: (uri: string) => boolean;
  exists: (uri: string) => boolean;
  storedNamed: (name: string) => string | null;
} {
  const byName = new Map<string, string>();
  try {
    const directory = photoDirectory();
    if (directory.exists) {
      for (const entry of directory.list()) {
        // `instanceof Directory` rather than `instanceof File`, matching the walks in
        // `features/files/sweeper.ts` and `features/backup/paths.ts`: anything that is not
        // a directory is a file, and a subdirectory nobody expected is stepped over.
        if (entry instanceof Directory) continue;
        const name = entry.name.trim();
        if (name.length > 0) byName.set(name, entry.uri);
      }
    }
  } catch (error) {
    console.warn('[prescriptions] could not list the photo store', error);
  }

  return {
    isStored: (uri) => isStoredPrescriptionPhoto(uri),
    exists: (uri) => {
      try {
        return new File(uri).exists;
      } catch {
        // An unparseable URI is not a file that exists. Said explicitly because the
        // planner's next question — is a file of this name in the store — is the right
        // one to ask about a URI from an install that no longer exists.
        return false;
      }
    },
    storedNamed: (name) => byName.get(name) ?? null,
  };
}

// ── Small shared bits ────────────────────────────────────────────────────────

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** `TypeError: cannot read …` — an exception as one short line, for a stored reason. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
