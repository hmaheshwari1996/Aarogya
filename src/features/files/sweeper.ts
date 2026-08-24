/**
 * The sweeps that reconcile what the database claims with the bytes on the disk.
 *
 * `sweepPendingFileDeletes` finishes deletions that were decided and interrupted.
 * `sweepOrphanBriefcaseFiles` and `sweepOrphanPrescriptionPhotos` find bytes that no row
 * ever claimed — the mirror-image failure, and the one nothing used to look for. All three
 * run at boot; all three are documented where they are defined, and the long version of the
 * first is here.
 *
 * The two orphan sweeps are one function with two sets of arguments, because the difference
 * between them is a directory name and a "what is referenced" query, while every rule about
 * which way to fail is identical and has to stay identical.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The unlink sweeper: the half of "Remove" that touches the disk.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DELETING A FILE IS A TWO-PART OPERATION IN THIS APP
 *
 * `deleteDocument` soft-deletes the row and writes a `pending_file_delete` request in ONE
 * transaction, so the pair is atomic: either the document is still listed with its file
 * intact, or it is delisted AND a durable instruction to unlink exists. There is no state
 * in which she has been told a document is gone while its bytes are still on the phone
 * with nothing recorded that intends to remove them.
 *
 * This function is what turns that instruction into an actual unlink. The long version of
 * the reasoning is in `src/db/repositories/files.ts`; this is the loop it describes.
 *
 * ─── WHY IT LIVES HERE RATHER THAN IN THE BRIEFCASE ──────────────────────────
 *
 * It was written inside `src/app/briefcase/_lib.tsx`, whose own comment said it should end
 * up in `src/features/files/` and be called once at boot, and left the boot call as a note
 * because that batch did not own the boot screen. That note was the whole bug: the only
 * callers were the two briefcase screens, so an interrupted unlink — the app killed
 * between the transaction committing and the file being removed, which on MIUI is an
 * ordinary Tuesday — only finished if she happened to open the briefcase again. A queue
 * that drains only when someone visits the feature is a queue that fills up on the phones
 * where it matters most.
 *
 * `boot()` in `src/app/index.tsx` now calls it, and the briefcase screens still do after
 * every delete so the bytes go promptly while she is watching.
 *
 * A FILE THAT IS ALREADY GONE IS A SUCCESS. The queue is idempotent, the sweep may run
 * twice concurrently (boot and a briefcase mount, on a cold start straight into the
 * feature), and a phone restored from a capsule can carry requests for paths that never
 * existed on it. Completing those is correct — the post-condition is "this path does not
 * exist", and it does not.
 *
 * NO NATIVE IMPORT BEYOND `expo-file-system`, and no React. This module is reachable from
 * boot, and boot is the one place where an import-time failure is indistinguishable from a
 * corrupt install.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Directory, File, Paths } from 'expo-file-system';

import {
  completeFileDelete,
  listPendingFileDeletes,
  recordFileDeleteFailure,
  requestFileDelete,
} from '@/db/repositories/files';
import { listDocumentFileUris } from '@/db/repositories/contacts';
// `photoStore.ts` imports `expo-file-system` and the repositories and nothing else — no
// React, no second native package — so it is safe on a path boot reaches. It does not
// import this module, so there is no cycle.
import {
  PRESCRIPTION_PHOTO_DIR_NAME,
  listPrescriptionPhotoUris,
} from '@/features/prescriptions/photoStore';

/**
 * Drains `pending_file_delete`, returning how many files were actually removed.
 *
 * Never throws. Every caller is either boot (where a throw is a blank screen) or a
 * fire-and-forget `void` after a delete (where a throw is an unhandled rejection). The
 * failures it can meet are all ordinary: a file the OS will not let us touch, a database
 * that is briefly locked, a URI that no longer parses.
 */
export async function sweepPendingFileDeletes(): Promise<number> {
  let removed = 0;
  let pending: Awaited<ReturnType<typeof listPendingFileDeletes>>;
  try {
    pending = await listPendingFileDeletes();
  } catch (error) {
    console.warn('[files] could not read the file-deletion queue', error);
    return 0;
  }

  for (const request of pending) {
    try {
      const file = new File(request.fileUri);
      if (file.exists) file.delete();
      await completeFileDelete(request.id);
      removed += 1;
    } catch (error) {
      // Never a give-up threshold — a request that has failed forty times is still a file
      // she asked to have deleted. `attempts` and `lastError` are the record of why, and
      // the next sweep tries again. Dropping a request would leave a medical document on
      // the phone after the app said it was gone, which is the one outcome this whole
      // two-part design exists to make impossible.
      try {
        await recordFileDeleteFailure(request.id, describeError(error));
      } catch (nested) {
        console.warn('[files] could not record a failed unlink', nested);
      }
    }
  }
  return removed;
}

// ── The other half: bytes that no row ever claimed ───────────────────────────

/**
 * The briefcase directory's name, which is also what a backup capsule mirrors.
 *
 * It lives HERE rather than in `src/app/briefcase/_lib.tsx` — which re-exports it, as it
 * already does for the two functions in this file — because this module is imported by
 * boot and must not pull a React screen in behind it, and because two copies of the string
 * that decides which directory gets swept is not a risk worth taking to save an import.
 */
export const BRIEFCASE_DIR_NAME = 'briefcase';

/**
 * How settled a file has to be before it can be called an orphan.
 *
 * `copyIntoBriefcase` writes the file and `addDocument` writes the row, in that order and
 * milliseconds apart — but a sweep running in that gap would see a file with no row and be
 * exactly wrong. Ten minutes is far longer than any save takes and far shorter than the
 * time between the boot that misses an orphan and the next one that catches it.
 *
 * ─── THE PRESCRIPTION STORE'S GAP IS MINUTES, NOT MILLISECONDS ───────────────
 * `persistPrescriptionPhoto` copies a page at "Use this page"; nothing references it until
 * Done, which can be three photographs later. Ten minutes does not cover that, and it does
 * not have to: BOTH ORPHAN SWEEPS RUN ONLY AT BOOT. While she is on the capture screen the
 * process is alive and no sweep is running; if the process died, the pages really are
 * orphans and sweeping them is the correct answer, not a race lost. The floor is here for
 * the OTHER window — the one where a sweep and a write genuinely can overlap, which is
 * `repairPrescriptionPhotos()` copying a file in on the same boot moments earlier.
 *
 * IF EITHER SWEEP IS EVER CALLED FROM A SCREEN, this reasoning stops holding and the floor
 * has to become longer than a capture session. Read this before adding that call.
 */
const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Queues briefcase files that no document row refers to.
 *
 * ─── THE GAP THIS CLOSES, AND WHY THE OTHER SWEEP CANNOT ─────────────────────
 * `deleteDocument` guarantees that a deleted row's bytes are queued, atomically. Nothing
 * guaranteed the reverse: `copyIntoBriefcase` writes the file, `addDocument` writes the
 * row, and everything between them is JS-catchable EXCEPT the one thing that actually
 * happens — the process dying. An OOM kill during `bytes()` on a 30 MB PDF, a battery
 * pull, an ordinary MIUI kill, and there are bytes on disk that no row references. The
 * queue has no entry for them, because they never had a row to delete.
 *
 * Nothing in the app could then list them or remove them, and `features/backup/paths.ts`
 * walks the whole document tree — so an orphan rides inside every capsule she ever makes,
 * on the phone that had no room in the first place. That is the failure the header of
 * `src/db/repositories/files.ts` calls a privacy failure rather than an untidiness.
 *
 * ─── IT FAILS CLOSED, EVERYWHERE ─────────────────────────────────────────────
 * This function DELETES things, so every uncertainty resolves towards keeping the file:
 * an unreadable row set, an unreadable directory, an unreadable modification time and a
 * file younger than the age floor all mean "leave it alone". The one thing it must never
 * do is decide a file is unreferenced because the database would not answer — which is a
 * real state during a restore, when the connection is deliberately closed.
 *
 * ─── MATCHED ON THE FILE NAME, NOT THE WHOLE URI ─────────────────────────────
 * A row stores whatever `destination.uri` was on the day it was written, and a restored
 * capsule rewrites those URIs when the app's data directory changes name (see
 * `features/backup/restore.ts`). The names are `<uuid><ext>`, minted by this app and
 * unique inside one directory, so comparing names is both sufficient and immune to a
 * percent-encoding or prefix difference that would otherwise read as "unreferenced".
 *
 * Returns how many files it queued. At-least-once like everything else here: it queues,
 * `sweepPendingFileDeletes` unlinks, and running twice is harmless.
 */
export async function sweepOrphanBriefcaseFiles(): Promise<number> {
  return sweepOrphans(BRIEFCASE_DIR_NAME, listDocumentFileUris, 'the document rows');
}

/**
 * The same sweep, pointed at the prescription photo store.
 *
 * ─── WHY THIS DIRECTORY NEEDS ONE TOO ────────────────────────────────────────
 * `persistPrescriptionPhoto` copies a page into `Paths.document/prescriptions` when she
 * taps "Use this page", and nothing references it until she taps Done — which may be three
 * photographs and two minutes later. A process death anywhere in between (an OOM kill on a
 * 2 GB handset with the camera still warm is the ordinary case, not the exotic one) leaves
 * bytes in an app-owned directory that no row and no page list will ever name again.
 *
 * Left alone those bytes are invisible and permanent: no screen lists them, no delete
 * reaches them, and `features/backup/paths.ts` walks the whole tree under `Paths.document`
 * — so an abandoned photograph of a prescription rides inside every capsule she ever
 * makes, on the phone that was short of space to begin with. `photoStore.ts` named this
 * gap in its own header and exported `listPrescriptionPhotoUris()` for it rather than
 * half-building it; this is that function being used.
 *
 * ─── WHAT COUNTS AS REFERENCED IS WIDER THAN A COLUMN ────────────────────────
 * `listPrescriptionPhotoUris()` reads `image_uri` and `cropped_image_uri` AND every
 * `prescription_pages:*` blob in `app_meta`, because page 2 onwards exists only in that
 * blob. A sweep that read the columns alone would queue every page after the first for
 * deletion — which is not a tidy-up, it is destroying the back half of a prescription.
 *
 * ─── AND WHY THE REPAIR PASS RUNS BEFORE IT ──────────────────────────────────
 * `repairPrescriptionPhotos()` copies a cache-resident photograph into this directory and
 * only then re-points the row. A sweep interleaved between those two steps would see the
 * fresh copy as unreferenced. `boot()` awaits the repair first, and the age floor below is
 * the independent second guard: a file written seconds ago is never old enough to be
 * called an orphan by anybody.
 */
export async function sweepOrphanPrescriptionPhotos(): Promise<number> {
  return sweepOrphans(
    PRESCRIPTION_PHOTO_DIR_NAME,
    listPrescriptionPhotoUris,
    'the prescription rows and page lists',
  );
}

/**
 * The mechanism both sweeps are.
 *
 * Shared rather than copied because every safety property here is a decision that has to
 * hold in both directories, and a second copy is a place for one of them to quietly stop
 * being true: fail closed when the database will not answer, fail closed when the
 * directory will not list, fail closed on an unreadable modification time, match on the
 * FILE NAME rather than the whole URI, and never let one bad entry abandon the rest.
 *
 * `listReferenced` is passed as a function rather than a resolved list so the read happens
 * inside this function's try — a caller that awaited it first would have to repeat the
 * "the database is the authority" reasoning to get the failure direction right.
 */
async function sweepOrphans(
  dirName: string,
  listReferenced: () => Promise<readonly string[]>,
  sourceDescription: string,
): Promise<number> {
  let referenced: Set<string>;
  try {
    referenced = new Set(listNamesOf(await listReferenced()));
  } catch (error) {
    // The database is the authority on what is referenced. Without it, everything on disk
    // is unreferenced, which is precisely the wrong conclusion to act on.
    console.warn(`[files] could not read ${sourceDescription}; skipping the orphan sweep`, error);
    return 0;
  }

  let entries: (Directory | File)[];
  try {
    const directory = new Directory(Paths.document, dirName);
    if (!directory.exists) return 0;
    entries = directory.list();
  } catch (error) {
    console.warn(`[files] could not list the ${dirName} directory`, error);
    return 0;
  }

  const settledBefore = Date.now() - ORPHAN_MIN_AGE_MS;
  let queued = 0;

  for (const entry of entries) {
    // `instanceof Directory` rather than `instanceof File`, matching the walk in
    // `features/backup/paths.ts`: anything that is not a directory is a file, and a
    // subdirectory nobody expected must be stepped over rather than mistaken for one.
    if (entry instanceof Directory) continue;
    try {
      const name = entry.name.trim();
      if (name.length === 0 || referenced.has(name)) continue;
      // Null means the file could not be read at all — in which case it also cannot be
      // deleted, and guessing is worse than waiting for a boot where it can be read.
      const modified = entry.modificationTime;
      if (modified === null || modified > settledBefore) continue;
      await requestFileDelete(entry.uri, 'orphan');
      queued += 1;
    } catch (error) {
      // One unreadable entry is not a reason to abandon the rest, and a file that stays is
      // a file that is swept next time.
      console.warn(`[files] could not queue an orphaned file in ${dirName}`, error);
    }
  }
  return queued;
}

function listNamesOf(uris: readonly string[]): string[] {
  const names: string[] = [];
  for (const uri of uris) {
    const name = fileNameOf(uri);
    if (name !== null) names.push(name);
  }
  return names;
}

/** '9f1c…-ab.pdf' from a URI, or null when there is no last segment to speak of. */
function fileNameOf(uri: string): string | null {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // A malformed escape sequence is not worth a throw; the raw segment still compares
    // equal to another raw segment, which is all this is for.
  }
  const withoutQuery = decoded.split('?')[0] ?? decoded;
  const last = withoutQuery.split('/').pop() ?? '';
  const name = last.trim();
  return name.length > 0 ? name : null;
}

/** `TypeError: cannot read …` — an exception as one short line, for a stored reason. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
