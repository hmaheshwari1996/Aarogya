/**
 * The briefcase's own plumbing — file copying, the unlink sweeper, and the strings the
 * three briefcase screens share.
 *
 * ─── WHY THIS FILE HAS A DEFAULT EXPORT THAT REDIRECTS ────────────────────────
 * Expo Router turns EVERY `.ts`/`.tsx` file under the app root into a route, and there is
 * no "ignore this folder" convention — see the long note at the top of
 * `src/app/_shared/lib.tsx`, which solved the same problem the same way. `/briefcase/_lib`
 * is therefore a real, harmless route nobody links to, and the router never warns about a
 * missing default export.
 *
 * ─── WHAT A BRIEFCASE DOCUMENT IS ─────────────────────────────────────────────
 * A row in `document` with `owns_file = 1`, pointing at a file the app COPIED into
 * `Paths.document/briefcase/<uuid><ext>`. Three consequences, and all three are the
 * reason the copy is not optional:
 *
 *   1. Both pickers hand back a URI the app does not own. `expo-image-picker` returns one
 *      in the CACHE directory, which Android empties whenever storage runs low — on the
 *      2 GB handsets this app targets that is not hypothetical. `File.pickFileAsync`
 *      returns a `content://` SAF URI that belongs to Downloads, Drive or WhatsApp, and
 *      it stops resolving the moment she tidies up over there. Storing either one builds
 *      a briefcase that quietly empties itself.
 *
 *   2. The backup capsule takes the DIRECTORY TREE under `Paths.document`, not a list of
 *      `*_uri` columns (see `src/features/backup/paths.ts`). A file inside
 *      `Paths.document/briefcase` is therefore in every capsule she makes, for free and
 *      with nobody having to remember. A `content://` URI is in none of them.
 *
 *   3. `owns_file = 1` is what lets `deleteDocument` queue the bytes for deletion. A row
 *      that merely points at somebody else's file must never do that — see the ownership
 *      note in `src/db/repositories/contacts.ts`.
 *
 * ─── THE PICKERS, AND WHY THERE IS NO NEW DEPENDENCY ──────────────────────────
 * PDFs and .docx do NOT need `expo-document-picker`. `expo-file-system` 19 (already a
 * dependency) ships `File.pickFileAsync()`, which is `ACTION_OPEN_DOCUMENT` on Android and
 * takes a persistable read grant on the result. That is the same system picker, at zero
 * bytes of APK — worth knowing before anybody adds a package for it.
 *
 * IT COMES WITH ONE SHARP EDGE, and `copyIntoBriefcase` below exists mostly to handle it:
 * `File.copy()` is implemented in Kotlin as `javaFile.copyRecursively(...)`, and `javaFile`
 * THROWS for a `content://` URI ("This method cannot be used with content URIs"). The same
 * is true of `open()`/`FileHandle`, so there is no chunked read either. The only way to get
 * the bytes of a SAF-picked file is `bytes()`, which reads the whole thing into memory —
 * which is precisely why this feature has a size limit, and why the limit is where it is.
 */

import React from 'react';
import { Redirect } from 'expo-router';
import { Directory, File, Paths } from 'expo-file-system';

import type { TranslateFn } from '@/i18n';
import { newId } from '@/lib/ids';
// Imported as well as re-exported below: `export … from` publishes a name without binding
// it in this module's scope, and `copyIntoBriefcase` calls `describeError` twice.
import {
  BRIEFCASE_DIR_NAME,
  describeError,
  sweepPendingFileDeletes,
} from '@/features/files/sweeper';

import type { LocalStrings } from '../_shared/lib';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Where the files live, and how big one may be
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Directory under `Paths.document`. Its NAME is what the capsule mirrors, so it is fixed.
 *
 * Defined in `features/files/sweeper.ts` and re-exported here with the two sweep functions
 * — the orphan sweep runs at boot and lists this directory, and boot cannot import a
 * screen. One string, one owner; the briefcase's own vocabulary is unchanged.
 */
export { BRIEFCASE_DIR_NAME };

/**
 * The largest file the briefcase will take in: 32 MB.
 *
 * TWO INDEPENDENT REASONS, and the smaller of the two wins:
 *
 *   • THE COPY HAS TO PASS THROUGH MEMORY. A file chosen with `File.pickFileAsync` arrives
 *     as a `content://` URI, and the only read path for one of those is `bytes()` — the
 *     whole file, as one `Uint8Array`, on a phone with 2 GB of RAM shared with MIUI. A
 *     polite refusal is enormously better than a native out-of-memory kill in the middle
 *     of saving her discharge summary.
 *
 *   • THE BACKUP CAPSULE SKIPS ANYTHING OVER 48 MiB (`MAX_MEDIA_FILE_BYTES` in
 *     `src/features/backup/format.ts`). Sitting below that on purpose buys a property
 *     worth having and worth saying out loud on screen: EVERYTHING IN THE BRIEFCASE FITS
 *     IN A BACKUP. No file here is silently left out of a capsule, so a restore brings
 *     back the whole briefcase or the backup failed loudly.
 *
 * For scale: a scanned discharge summary is 200 KB to 3 MB, a phone photograph of a page
 * at quality 0.7 is around 1 MB, and a 40-page hospital PDF is rarely past 20 MB. The
 * limit is generous for real papers and firm about the one shape that would hurt.
 */
export const MAX_BRIEFCASE_FILE_BYTES = 32 * 1024 * 1024;

/**
 * Refuse the copy unless this much space is free ON TOP of the file itself.
 *
 * Filling the last byte of a phone's storage does not just fail this copy — it takes the
 * database's next write with it, and that database is her medicine history. Leaving a
 * floor is cheap insurance for the one file in this app that can be tens of megabytes.
 */
export const REQUIRED_FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Kinds
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `document.kind` → label key.
 *
 * The column is free TEXT with no CHECK, deliberately, so a row written by another feature
 * or an older build stays readable. Anything not listed here degrades to the generic label
 * rather than rendering a raw key — the same fallback `src/app/documents.tsx` uses.
 */
const KIND_KEYS: Readonly<Record<string, string>> = {
  prescription: 'briefcase.kind.prescription',
  lab_report: 'briefcase.kind.labReport',
  lab: 'briefcase.kind.labReport',
  discharge_summary: 'briefcase.kind.dischargeSummary',
  scan_report: 'briefcase.kind.scanReport',
  insurance: 'briefcase.kind.insurance',
  id_card: 'briefcase.kind.idCard',
  bill: 'briefcase.kind.bill',
  other: 'briefcase.kind.other',
};

export function kindLabelKey(kind: string): string {
  return KIND_KEYS[kind] ?? 'briefcase.kind.other';
}

/**
 * The order the chips are offered in — commonest first for this household, not
 * alphabetically. `other` is pinned last because it means "none of the above" and a
 * fallback that drifts up the list starts catching taps that belong to a real category.
 */
export const BRIEFCASE_KIND_ORDER = [
  'discharge_summary',
  'lab_report',
  'prescription',
  'scan_report',
  'id_card',
  'insurance',
  'bill',
  'other',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// 3. File types, names and sizes
// ═══════════════════════════════════════════════════════════════════════════════

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif', '.bmp'];

/** A trailing '.pdf' / '.docx'. Anchored on the LAST dot, which 'report.v2.pdf' needs. */
const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'text/plain': '.txt',
};

/**
 * Can the app draw this itself?
 *
 * The MIME type is trusted first because a SAF provider knows it and the URI often does
 * not; the extension is the fallback for a `file://` from the camera. Getting this wrong
 * in the "yes" direction shows an empty grey box, which `Thumb` already degrades into an
 * icon tile — so the failure mode is untidy, never broken.
 */
export function isImageDocument(mimeType: string | null, fileName: string | null): boolean {
  if (mimeType && mimeType.startsWith('image/')) return true;
  if (mimeType && mimeType !== '') return false;
  const name = (fileName ?? '').toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** A short type word for the row and the detail screen. Never a raw MIME string. */
export function fileTypeKey(mimeType: string | null, fileName: string | null): string {
  if (isImageDocument(mimeType, fileName)) return 'briefcase.type.picture';
  const name = (fileName ?? '').toLowerCase();
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'briefcase.type.pdf';
  if (name.endsWith('.doc') || name.endsWith('.docx') || (mimeType ?? '').includes('word')) {
    return 'briefcase.type.document';
  }
  return 'briefcase.type.file';
}

/**
 * '340 KB' / '1.2 MB'.
 *
 * Latin digits in Hindi too, exactly as `useDateFormat` insists on for dates: Devanagari
 * digits are correct Hindi and are read fluently by very few people over seventy.
 */
export function formatBytes(bytes: number | null, t: TranslateFn): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  const kb = bytes / 1024;
  if (kb < 1024) return t('briefcase.sizeKb', { n: Math.max(1, Math.round(kb)) });
  const mb = kb / 1024;
  return t('briefcase.sizeMb', { n: mb < 10 ? mb.toFixed(1) : String(Math.round(mb)) });
}

/**
 * The name the file arrived with, dug out of a URI.
 *
 * A `content://` URI from Documents looks like
 * `content://…/document/primary%3ADownload%2Fdischarge.pdf`, so the real name is in there
 * once it is percent-decoded — but a Downloads or Drive URI can just as easily end in
 * `msf%3A1000000123`, which is not a name at all. So this returns null unless what it
 * finds actually looks like a filename, and the caller treats null as "we never learned
 * it" rather than inventing something.
 */
export function originalNameFromUri(uri: string): string | null {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // A malformed escape sequence is not worth a crash; fall back to the raw URI.
  }
  const withoutQuery = decoded.split('?')[0] ?? decoded;
  const lastSegment = withoutQuery.split(/[/\\:]/).pop() ?? '';
  const name = lastSegment.trim();
  if (name.length === 0 || name.length > 120) return null;
  // Two tests, in this order, because 'report.v2.pdf' is a real filename and a single
  // pattern anchored on the FIRST dot rejects it. An extension of one to five characters,
  // and at least one letter in what is left — which is what separates 'discharge.pdf' and
  // 'राज.pdf' from 'msf:1000000123' and '1000000123.jpg'.
  if (!EXTENSION.test(name)) return null;
  if (!/[A-Za-zऀ-ॿ]/.test(name.replace(EXTENSION, ''))) return null;
  return name;
}

/**
 * A title worth pre-filling the field with, or null.
 *
 * `addDocument` refuses to default the title from the filename, and it is right to: a
 * briefcase whose rows all read 'Scan_0032.pdf' is a briefcase she cannot use. But
 * SUGGESTING a real name into a field she can edit is the opposite — it saves the son
 * typing 'Apollo discharge November' when the file is already called that.
 *
 * Camera-shaped names are deliberately not suggested. 'IMG_20260304_113522' tells this
 * user nothing, and an empty field is a clearer prompt than a meaningless one.
 */
export function suggestTitleFromName(fileName: string | null): string | null {
  if (!fileName) return null;
  const stem = fileName.replace(EXTENSION, '').trim();
  if (stem.length === 0 || stem.length > 60) return null;
  // 'IMG_20260304_113522', 'PXL-20260304-113522123', 'Scan 0032' — a prefix followed by
  // nothing but digits and separators. The separators have to be inside the repeated group,
  // not just after the prefix, or the second underscore in a camera name defeats the test.
  if (/^(img|dsc|dscn|pxl|photo|image|scan|screenshot|doc|file)[-_ ]?[\d\-_ ]+$/i.test(stem)) {
    return null;
  }
  if (!/[A-Za-zऀ-ॿ]/.test(stem)) return null;
  return stem.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Copying a picked file into the briefcase
// ═══════════════════════════════════════════════════════════════════════════════

export type PickedFile = {
  /** Where it is now: a picker cache `file://`, or a SAF `content://`. Never stored. */
  uri: string;
  originalFileName: string | null;
  /** '' from the platform is normalised to null — "we never learned it". */
  mimeType: string | null;
  sizeBytes: number | null;
};

/** Why a copy could not happen. Each maps to one sentence the user actually reads. */
export type CopyFailure = 'too_large' | 'no_space' | 'source_gone' | 'failed';

export class BriefcaseCopyError extends Error {
  readonly reason: CopyFailure;
  /**
   * The size this failure is about, when the app measured one the picker never gave.
   *
   * The refusal sentence names two numbers ("This file is 46 MB, which is more than…"),
   * and it reads as a bug when the first one is blank. A file too large to keep is exactly
   * the case where the picker most often reported nothing, so the number the copy path
   * discovered has to travel back with the refusal.
   */
  readonly measuredBytes: number | null;
  constructor(reason: CopyFailure, detail?: string, measuredBytes: number | null = null) {
    super(`briefcase copy failed: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'BriefcaseCopyError';
    this.reason = reason;
    this.measuredBytes = measuredBytes;
  }
}

function extensionFor(picked: PickedFile): string {
  const fromName = EXTENSION.exec(picked.originalFileName ?? '');
  if (fromName) return fromName[0].toLowerCase();
  if (picked.mimeType) {
    const mapped = MIME_TO_EXTENSION[picked.mimeType.toLowerCase()];
    if (mapped) return mapped;
  }
  // No extension is a legal, if unhelpful, state. The MIME type is stored on the row and
  // is what the share sheet uses, so nothing downstream depends on the suffix.
  return '';
}

/**
 * Copies a picked file into `Paths.document/briefcase` and returns the new URI.
 *
 * ─── THIS DELIBERATELY DOES NOT DO WHAT `persistPhoto` DOES ───────────────────
 * `persistPhoto` in `src/app/labs/new.tsx` returns the ORIGINAL cache URI when the copy
 * fails, on the reasoning that a fragile record beats no record. That is right there — the
 * row also carries typed values, and the photo is a bonus.
 *
 * Here it would be wrong. A briefcase row IS its file: the whole record is "this paper
 * exists and is on this phone". Falling back to a cache URI would list a discharge summary
 * that Android is free to delete tonight, and she would find out on the morning she needed
 * it. So a failed copy fails the SAVE — nothing is written, and she is told, while she is
 * still standing there holding the paper.
 *
 * ─── ORDER OF THE GUARDS ──────────────────────────────────────────────────────
 * Size first (cheap, and the one she can do something about), then free space, then the
 * copy. A partially written destination is deleted on the way out of the catch: a
 * half-file is worse than no file, because it looks like a document and opens as garbage.
 *
 * ─── AN UNKNOWN SIZE FAILS CLOSED, AND THAT IS NOT PEDANTRY ───────────────────
 * Both guards used to be written `size !== null && …`, so a pick whose size the platform
 * did not report skipped BOTH of them — and that is not an exotic case, it is the SAF case
 * this feature was written for. `File.pickFileAsync` resolves `.size` through
 * `DocumentFile.length()`, which returns 0 for any provider that does not publish
 * COLUMN_SIZE (Drive-backed and mail-attachment providers routinely do not), and
 * `add.tsx` correctly maps that 0 to "we never learned it". The guard that protects the
 * medicine database from a full disk therefore did not run on the phone it was written for,
 * and the 32 MB cap that keeps `bytes()` survivable did not either.
 *
 * So an unknown size is treated as the worst size the briefcase will ever accept. The
 * free-space demand becomes 32 + 16 MB, which a phone with any room at all clears, and
 * which a phone that cannot clear it should not be asked to write a discharge summary on.
 * The real size is then checked for real — from the byte array on the SAF path, from the
 * copied file on the native one — and an oversized file is refused with the same sentence
 * it would have got had the picker been honest.
 */
export async function copyIntoBriefcase(picked: PickedFile): Promise<string> {
  const size = picked.sizeBytes;
  if (size !== null && size > MAX_BRIEFCASE_FILE_BYTES) {
    throw new BriefcaseCopyError('too_large', String(size), size);
  }

  let available: number | null = null;
  try {
    available = Paths.availableDiskSpace;
  } catch {
    // Some ROMs refuse to answer. Unknown free space is not a reason to refuse the copy —
    // the copy itself will fail honestly if there is genuinely no room.
    available = null;
  }
  // The worst case is the only case the app can bound when the picker said nothing.
  const needed = size ?? MAX_BRIEFCASE_FILE_BYTES;
  if (available !== null && available < needed + REQUIRED_FREE_SPACE_MARGIN_BYTES) {
    throw new BriefcaseCopyError('no_space', `${available} free, needs ${needed}`);
  }

  const source = new File(picked.uri);
  const isContentUri = picked.uri.startsWith('content://');

  // `exists` on a SAF URI answers honestly and cheaply; on a picker cache URI it is the
  // check that turns "Android reclaimed the cache while she typed a title" into a sentence
  // instead of a stack trace.
  let sourceExists = false;
  try {
    sourceExists = source.exists;
  } catch {
    sourceExists = false;
  }
  if (!sourceExists) throw new BriefcaseCopyError('source_gone');

  const directory = new Directory(Paths.document, BRIEFCASE_DIR_NAME);
  try {
    if (!directory.exists) directory.create();
  } catch (error) {
    throw new BriefcaseCopyError('failed', describeError(error));
  }

  const destination = new File(directory, `${newId()}${extensionFor(picked)}`);

  try {
    if (isContentUri) {
      // The whole file, through memory. See the header: SAF gives no seekable handle, so
      // there is no chunked path to take. `MAX_BRIEFCASE_FILE_BYTES` is what keeps this
      // survivable.
      //
      // ── HALF OF THIS IS OFF THE JS THREAD AND HALF OF IT IS NOT ──────────────
      // `bytes()` is awaited rather than `bytesSync()`, and that half is genuine: the
      // native module registers it as an AsyncFunction, so a 20 MB READ happens off the
      // JS thread and the Save spinner keeps animating through it.
      //
      // `write()` is NOT async and cannot be made async. It is declared
      // `write(content): void` (expo-file-system 19, ExpoFileSystem.types.d.ts:207) and
      // runs on the calling thread, so on a cheap handset the largest file the briefcase
      // accepts stalls the spinner for a few hundred milliseconds at the end of the save.
      // Do not describe this function as "the copy is off-thread"; it is the read that is.
      //
      // The chunked rewrite is not the fix it looks like. `FileHandle.writeBytes` is
      // synchronous too (same file, line 309), so writing in slices would move nothing off
      // the thread — it would only bound peak memory, and only if the READ were chunked as
      // well, which needs a seekable handle on a `content://` URI that SAF does not give.
      // Meanwhile a partial destination is the one failure this whole function is built to
      // prevent, so the rewrite spends the risk where the benefit is not.
      const bytes = await source.bytes();
      // The first HONEST size on this path, and it arrives before a single byte is written.
      // A provider that would not tell the picker how big the file was has now told us, and
      // an 80 MB file gets the ordinary refusal rather than the last of her free space.
      if (bytes.length > MAX_BRIEFCASE_FILE_BYTES) {
        throw new BriefcaseCopyError('too_large', String(bytes.length), bytes.length);
      }
      destination.write(bytes);
    } else {
      // A plain file-to-file copy, done natively — no JS heap involved at any size.
      source.copy(destination);
      // Same check, after the fact, because a native copy has no size to check before it.
      // Nothing here is at risk of an out-of-memory kill; what is at stake is the property
      // the limit exists for — EVERYTHING IN THE BRIEFCASE FITS IN A BACKUP — which an
      // unmeasured 60 MB file would break silently, and only on the day of a restore.
      let copiedSize = 0;
      try {
        copiedSize = destination.size;
      } catch {
        // Unknowable twice over — the picker would not say and now the filesystem will
        // not either. Keep the copy: it is written and about to be referenced, and a guess
        // in the refusing direction throws away a paper she is standing there holding.
        copiedSize = 0;
      }
      if (copiedSize > MAX_BRIEFCASE_FILE_BYTES) {
        throw new BriefcaseCopyError('too_large', String(copiedSize), copiedSize);
      }
    }
  } catch (error) {
    try {
      if (destination.exists) destination.delete();
    } catch {
      // Best effort. A stray zero-length file is untidy; failing to report the real
      // error because the cleanup threw would be worse.
    }
    // Already the right answer, with the right reason on it. Re-wrapping a refusal as
    // 'failed' would turn "this file is too big, here is the limit" into a shrug.
    if (error instanceof BriefcaseCopyError) throw error;
    const detail = describeError(error);
    // Android reports a full disk as ENOSPC through several different exception types, so
    // the text is the only reliable signal — and getting this right is the difference
    // between "the phone has no space left" and a generic shrug.
    if (/enospc|no space/i.test(detail)) throw new BriefcaseCopyError('no_space', detail);
    throw new BriefcaseCopyError('failed', detail);
  }

  return destination.uri;
}

/**
 * Removes a file this screen copied in but never managed to reference from a row.
 *
 * The window is small — `copyIntoBriefcase` then `addDocument` — but it is not zero, and
 * bytes on disk that nothing in the app can list are exactly what the briefcase promises
 * not to leave lying around. Best effort by design: the alternative is failing a save that
 * has already failed.
 */
export function discardCopiedFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* nothing to do, and nothing worth telling her */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. The unlink sweeper — MOVED, and re-exported so the screens read the same
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `sweepPendingFileDeletes` used to be defined here, with a note saying it belonged in
 * `src/features/files/` and should be called once at boot. It now is, and it is —
 * `src/features/files/sweeper.ts`, called from `boot()` in `src/app/index.tsx`.
 *
 * That move was not tidying. While the only callers were the two briefcase screens, an
 * unlink interrupted between the transaction committing and the file being removed only
 * finished if she opened the briefcase again, so the queue filled up precisely on the
 * phones aggressive enough to kill the app mid-delete.
 *
 * Re-exported rather than repointed at the import sites because these two names are part
 * of the briefcase's own vocabulary and its three screens already import them from here.
 */
export { describeError, sweepPendingFileDeletes };

// ═══════════════════════════════════════════════════════════════════════════════
// 6. The strings the briefcase resolves through a computed key
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ONLY the string families that are looked up by a key BUILT AT RUNTIME —
 * `t(kindLabelKey(row.kind))`, `t(fileTypeKey(mime, name))`, `formatBytes`.
 *
 * ─── WHY THE REST OF THE COPY IS NOT HERE ─────────────────────────────────────
 * The instinct is to put every briefcase string in one place, and it is the wrong one.
 * `scripts/check-i18n.js` proves that a translate call with a literal key resolves by
 * looking for that key's declaration IN THE SAME FILE, one file at a time (and it scans
 * raw text, so even naming such a call inside a comment counts). A shared dictionary is
 * invisible to it, so every screen's copy would silently stop being checked — and the
 * failure that check exists to catch is a key path rendering on screen in front of someone
 * who cannot read English, let alone a dotted path. Losing the gate to save a few
 * duplicated lines is a bad trade, so each screen declares the strings it names directly.
 *
 * These families are the exception because no screen names them literally at all: the key
 * is assembled from a `document.kind` or a MIME type, which the checker correctly counts as
 * runtime-built and never verifies. They therefore gain nothing from being duplicated and
 * lose the one property that matters — eight category labels that agree with each other on
 * every screen that shows them.
 *
 * Every screen spreads this into its own map: `{ ...BRIEFCASE_SHARED_STRINGS, … }`.
 */
export const BRIEFCASE_SHARED_STRINGS: LocalStrings = {
  'briefcase.kind.prescription': { en: 'Prescription', hi: 'पर्चा' },
  'briefcase.kind.labReport': { en: 'Lab Report', hi: 'जाँच रिपोर्ट' },
  'briefcase.kind.dischargeSummary': { en: 'Discharge Summary', hi: 'डिस्चार्ज सारांश' },
  'briefcase.kind.scanReport': { en: 'Scan or X-ray Report', hi: 'स्कैन या एक्स-रे रिपोर्ट' },
  'briefcase.kind.insurance': { en: 'Insurance Paper', hi: 'बीमा का काग़ज़' },
  'briefcase.kind.idCard': { en: 'Identity or Health Card', hi: 'पहचान या हेल्थ कार्ड' },
  'briefcase.kind.bill': { en: 'Bill or Receipt', hi: 'बिल या रसीद' },
  'briefcase.kind.other': { en: 'Something Else', hi: 'कुछ और' },

  'briefcase.type.picture': { en: 'Picture', hi: 'तस्वीर' },
  'briefcase.type.pdf': { en: 'PDF', hi: 'PDF' },
  'briefcase.type.document': { en: 'Word document', hi: 'वर्ड दस्तावेज़' },
  'briefcase.type.file': { en: 'File', hi: 'फ़ाइल' },

  // Latin digits in Hindi too, exactly as `useDateFormat` insists on for dates.
  'briefcase.sizeKb': { en: '{{n}} KB', hi: '{{n}} KB' },
  'briefcase.sizeMb': { en: '{{n}} MB', hi: '{{n}} MB' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Route placeholder — see the file header.
// ═══════════════════════════════════════════════════════════════════════════════

export default function BriefcaseLibRoute() {
  return <Redirect href="/" />;
}
