/**
 * The URI arithmetic behind the prescription photo store.
 *
 * Everything here can be decided without touching the disk, which is the only reason it is
 * a separate module: `photoStore.ts` imports `expo-file-system`, and a module that imports
 * a native package cannot be run by `node --test`. The decision that says whether a
 * prescription photograph is copied, re-pointed or left alone is precisely the decision
 * that loses a photograph when it is wrong, so it lives on this side of that line and has
 * a test file next to it.
 *
 * NO IMPORTS AT ALL, deliberately. The moment this file needs one, ask whether the thing
 * it needs belongs on the IO side instead.
 */

/**
 * A directory URI with exactly one trailing slash, built from a root that may or may not
 * have one.
 *
 * `Paths.document.uri` has ended with a slash on every version this app has shipped
 * against, and building `${root}${name}/` on the assumption is how a future version that
 * drops it produces `…filesprescriptions/` — a directory that is created, written to and
 * never found again by the prefix test below.
 */
export function directoryUri(rootUri: string, name: string): string {
  return `${rootUri.replace(/\/+$/, '')}/${name}/`;
}

/** Is this URI inside that directory? `prefix` must come from `directoryUri`. */
export function isUnder(uri: string, prefix: string): boolean {
  return uri.startsWith(prefix);
}

/**
 * '9f1c….jpg' from a URI, or null when there is no last segment worth the name.
 *
 * The same shape as `fileNameOf` in `features/files/sweeper.ts`, and for the same reason:
 * a name minted by this app is a UUID plus an extension, unique inside one directory, and
 * comparing names survives a percent-encoding or prefix difference that comparing whole
 * URIs would read as "a different file".
 */
export function fileNameOf(uri: string): string | null {
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

/**
 * The extension to give a copy, normalised and always present.
 *
 * `expo-image-picker` hands back '.jpeg' on Android and '.jpg' on some OEM camera apps,
 * and a HEIC on a phone that shoots HEIC. Whatever it is, it is kept — re-labelling a HEIC
 * as '.jpg' would make `ImageManipulator` guess from the suffix and fail on the one file
 * she most needs read. '.jpg' is only the fallback for a source with no suffix at all,
 * because `image_uri` is drawn by `<Image>` and read by the manipulator, and both of them
 * cope better with a wrong-but-plausible suffix than with none.
 */
export function photoExtension(sourceExtension: string): string {
  const trimmed = sourceExtension.trim().toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(trimmed)) return trimmed;
  return '.jpg';
}

// ── The repair decision ──────────────────────────────────────────────────────

/**
 * What to do about one URI already stored in the database.
 *
 *   keep     it is in the store and the bytes are there. Nothing to do.
 *   copy     the bytes are there but somewhere the app does not own — a picker cache URI
 *            written by a build that stored those directly. Copy it in and re-point.
 *   repoint  the URI does not resolve, but a file of that name IS in the store. This is
 *            what a restore onto a different handset looks like: the app's data directory
 *            changes name, `features/backup/restore.ts` rewrites every `*_uri` COLUMN, and
 *            page 2 onwards — which live in an `app_meta` JSON blob, not a column — are
 *            left pointing at the old install.
 *   lost     nothing resolves and nothing matches. The row is LEFT ALONE.
 */
export type PagePlan =
  | { readonly action: 'keep'; readonly uri: string }
  | { readonly action: 'copy'; readonly uri: string }
  | { readonly action: 'repoint'; readonly uri: string; readonly to: string }
  | { readonly action: 'lost'; readonly uri: string };

/**
 * The three questions the plan needs answered about the disk.
 *
 * Passed in rather than imported so this module stays free of `expo-file-system`, and so
 * the test can describe a phone — "this file is gone, that one is in the store under a
 * different root" — in four lines.
 */
export type PageProbe = {
  /** Is this URI inside the app's own prescription directory, as it is named TODAY? */
  readonly isStored: (uri: string) => boolean;
  /** Do the bytes exist at this URI right now? */
  readonly exists: (uri: string) => boolean;
  /** A file of this name inside the store, as a current URI — or null. */
  readonly storedNamed: (name: string) => string | null;
};

export function planPage(uri: string, probe: PageProbe): PagePlan {
  // A blank or whitespace URI is not a page. Treated as lost rather than dropped: this
  // planner never shortens the list, because a page silently missing from a prescription
  // is the failure the capture screen's counter exists to prevent.
  if (uri.trim().length === 0) return { action: 'lost', uri };

  if (probe.isStored(uri)) {
    // In the store and readable: the overwhelmingly common case, and the cheap one.
    if (probe.exists(uri)) return { action: 'keep', uri };
    // In the store by its URI and NOT on disk. Nothing in the app deletes a stored photo
    // except the deletion queue, which only runs after the row has gone — so this is a
    // file somebody removed from underneath us. There is nothing to re-point to; a
    // same-named lookup would return the URI we already know is dead.
    return { action: 'lost', uri };
  }

  // Not in the store. If the bytes are still there, they are in the picker's cache
  // directory and they are on borrowed time.
  if (probe.exists(uri)) return { action: 'copy', uri };

  // Not in the store and not readable. Either the cache was purged before this ran — the
  // whole failure this feature exists to prevent, and now unrecoverable — or the URI is
  // from a previous install and the file it names is sitting in the store under a name we
  // can match. Try the name before giving up on it.
  const name = fileNameOf(uri);
  const found = name === null ? null : probe.storedNamed(name);
  if (found !== null && found !== uri) return { action: 'repoint', uri, to: found };
  return { action: 'lost', uri };
}

export function planPages(uris: readonly string[], probe: PageProbe): PagePlan[] {
  return uris.map((uri) => planPage(uri, probe));
}

/** Every plan that leaves the list exactly as it is. */
export function planIsNoop(plans: readonly PagePlan[]): boolean {
  return plans.every((plan) => plan.action === 'keep' || plan.action === 'lost');
}
