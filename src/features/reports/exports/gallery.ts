/**
 * Saving an image to the phone's gallery — the demoted, warned-about path.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT THE DEFAULT, AND WHY THE WARNING IS NEVER REMEMBERED
 *
 * MediaStore is a GLOBAL, UNENCRYPTED NAMESPACE. The moment a file lands in it:
 *
 *   • every gallery app, file manager, "cleaner" and social app with media permission
 *     can read it — that is the entire point of MediaStore, and it applies to a photo of
 *     a lab report exactly as it applies to a holiday snap;
 *   • Google Photos backup, if it is on, uploads it in the clear, and so does Mi Cloud
 *     gallery sync, Samsung Cloud and every OEM equivalent. On an Indian budget phone at
 *     least one of these is usually on and the user does not know it;
 *   • it survives uninstalling this app.
 *
 * For a health record that is a real disclosure, and it is irreversible in the way that
 * matters: the copy in someone else's cloud cannot be recalled by deleting the local file.
 *
 * So the share sheet is the default action everywhere in this feature, and this path sits
 * behind a BLOCKING dialog that is shown EVERY TIME. There is deliberately no "don't ask
 * again": consent to publish one day's summary to the family WhatsApp is not consent to
 * publish a TB prescription six months later, and a remembered checkbox turns the first
 * into the second.
 *
 * `writeOnly: true` on the permission request is load-bearing twice over. It keeps
 * `READ_MEDIA_IMAGES` out of the merged manifest, so this app never gains the ability to
 * read the user's photo library — and it sidesteps Google Play's Photo and Video
 * Permissions declaration, which an app with no reason to read the gallery should never
 * have to file.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import * as MediaLibrary from 'expo-media-library';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export const GALLERY_ALBUM_NAME = 'Aarogya';

export const GALLERY_WARNING_TITLE = 'Saving to the phone gallery makes this readable by other apps';

/**
 * The body of the blocking dialog. Plain sentences, no jargon, and it names the specific
 * consequence rather than gesturing at "privacy".
 *
 * The caller MUST show this every time, MUST require an explicit confirm, and MUST NOT
 * offer a "don't show this again" option.
 */
export const GALLERY_WARNING = [
  'Anything saved to the gallery can be opened by every photo app, file manager and cloud backup on this phone.',
  'If photo backup is switched on, a copy is uploaded to the internet and stays there even if you delete it here.',
  'It also stays on the phone after Aarogya is removed.',
  'Sending it directly to one person with the Send button is safer: only that person receives it.',
].join('\n\n');

/** For a confirm dialog whose buttons must not both read like agreement. */
export const GALLERY_CONFIRM_LABEL = 'Save to gallery anyway';
export const GALLERY_CANCEL_LABEL = 'Send it instead';

export type GalleryOutcome =
  | { saved: true; assetId: string; albumName: string }
  | { saved: false; reason: 'permission-denied' | 'failed'; error?: unknown };

export type SaveToGalleryOptions = {
  /** Defaults to `GALLERY_ALBUM_NAME`. */
  albumName?: string;
  /**
   * Must be `true`. An explicit, non-defaulted argument so that no caller reaches this
   * function without having shown `GALLERY_WARNING` and been told yes.
   */
  userAcceptedWarning: boolean;
};

/**
 * Re-encodes the image, which drops every EXIF block along with it.
 *
 * A PNG from `captureRef` carries no camera metadata, but this function also accepts
 * images that originated in the camera roll or the camera itself, and those carry GPS
 * coordinates, the device serial and a capture timestamp. Publishing a patient's home
 * coordinates alongside her medicine list is a far worse disclosure than the medicine
 * list, and it is invisible — nobody looking at the picture can see it is there.
 *
 * JPEG at high quality rather than PNG: MediaStore galleries and WhatsApp both re-encode
 * to JPEG anyway, and a lossless intermediate only doubles the bytes that get backed up.
 */
async function stripMetadata(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
  return result.uri;
}

export async function saveImageToGallery(
  uri: string,
  options: SaveToGalleryOptions,
): Promise<GalleryOutcome> {
  if (!options.userAcceptedWarning) {
    throw new Error(
      'saveImageToGallery: the user must be shown GALLERY_WARNING and accept it before this is called.',
    );
  }

  const albumName = options.albumName ?? GALLERY_ALBUM_NAME;

  // writeOnly — see the file header. Never pass false here.
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    return { saved: false, reason: 'permission-denied' };
  }

  try {
    const clean = await stripMetadata(uri);
    const asset = await MediaLibrary.createAssetAsync(clean);

    // A named album keeps clinical images out of the main camera roll, which is the roll
    // people scroll through in front of other people.
    const existing = await MediaLibrary.getAlbumAsync(albumName).catch(() => null);
    if (existing) {
      // copy: false — move the asset rather than leaving a duplicate in the camera roll.
      await MediaLibrary.addAssetsToAlbumAsync([asset], existing, false);
    } else {
      await MediaLibrary.createAlbumAsync(albumName, asset, false);
    }

    return { saved: true, assetId: asset.id, albumName };
  } catch (error) {
    console.warn('[reports] could not save to the gallery', error);
    return { saved: false, reason: 'failed', error };
  }
}

/**
 * MediaStore takes images, video and audio. A PDF is none of those, so the OPD report and
 * the wall chart go out through the share sheet only — which is the safer path anyway and
 * is why this is stated as a fact rather than worked around.
 */
export const GALLERY_SUPPORTS_PDF = false;
