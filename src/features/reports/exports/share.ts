/**
 * The share sheet. This is the DEFAULT way anything leaves this app.
 *
 * WHY THE SHARE SHEET IS THE DEFAULT AND THE GALLERY IS NOT:
 *
 * `shareAsync` hands a single file to a single app the user picks, through a FileProvider
 * URI with a temporary grant. Nothing else on the phone gains access, nothing is indexed,
 * and nothing is backed up as a side effect. Saving the same file to the gallery writes it
 * into MediaStore — a global, unencrypted namespace that every gallery app, file manager
 * and cloud sync client can read. See `./gallery.ts`.
 *
 * So: share is one tap and needs no warning. Gallery is demoted behind a blocking one.
 */

import * as Sharing from 'expo-sharing';

import { schedulePruneAfterShare } from './files';

export type ShareOutcome =
  | { shared: true }
  | { shared: false; reason: 'unavailable' | 'failed'; error?: unknown };

export type ShareRequest = {
  uri: string;
  /** Android uses this to decide which apps appear in the chooser. */
  mimeType: string;
  dialogTitle: string;
};

export const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  text: 'text/plain',
} as const;

export async function shareFile(request: ShareRequest): Promise<ShareOutcome> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    // Reported rather than thrown: the caller's job is to tell the user the file is
    // saved and where, not to surface a stack trace.
    console.warn('[reports] sharing is not available on this device');
    return { shared: false, reason: 'unavailable' };
  }

  try {
    await Sharing.shareAsync(request.uri, {
      mimeType: request.mimeType,
      dialogTitle: request.dialogTitle,
    });
  } catch (error) {
    console.warn('[reports] the share sheet failed', error);
    return { shared: false, reason: 'failed', error };
  }

  // NOT an immediate prune. On Android this promise resolves when the chooser appears,
  // and the receiving app reads the URI afterwards — see the header of ./files.ts.
  schedulePruneAfterShare();
  return { shared: true };
}
