/**
 * The export surface.
 *
 * The ordering of the two entry points below is the product decision: `shareExport` is the
 * default everywhere, and `saveImageToGallery` sits behind `GALLERY_WARNING`. See
 * `./gallery.ts` for why that asymmetry exists.
 */

import type { ExportData } from '../data/types';
import { MIME, shareFile, type ShareOutcome } from './share';
import { writeSpreadsheetExport, type SpreadsheetOptions, type WorkbookOutcome } from './xlsx';

export {
  buildCsvBundle,
  buildCsvSheets,
  buildReadmeSheet,
  csvCell,
  csvLine,
  needsFormulaGuard,
  sheetToCsv,
  toCsv,
  CSV_LINE_ENDING,
  UTF8_BOM,
} from './csv';
export type { CsvColumn, CsvFile, CsvOptions, CsvSheet, CsvValue } from './csv';

export { sanitiseSheetName, writeSpreadsheetExport } from './xlsx';
export type { ExportedFile, SpreadsheetOptions, WorkbookOutcome } from './xlsx';

export {
  adoptIntoExports,
  cancelScheduledPrune,
  exportsDirectory,
  listExportFiles,
  pruneExports,
  pruneExportsOnAppStart,
  sanitiseFileName,
  schedulePruneAfterShare,
  timestampedFileName,
  writeExportBase64,
  writeExportBytes,
  writeExportText,
  EXPORT_DIR_NAME,
  KEEP_NEWEST,
  MAX_AGE_MS,
  PRUNE_DELAY_AFTER_SHARE_MS,
} from './files';

export { shareFile, MIME } from './share';
export type { ShareOutcome, ShareRequest } from './share';

export {
  saveImageToGallery,
  GALLERY_ALBUM_NAME,
  GALLERY_CANCEL_LABEL,
  GALLERY_CONFIRM_LABEL,
  GALLERY_SUPPORTS_PDF,
  GALLERY_WARNING,
  GALLERY_WARNING_TITLE,
} from './gallery';
export type { GalleryOutcome, SaveToGalleryOptions } from './gallery';

export type ExportAndShareResult = {
  outcome: WorkbookOutcome;
  share: ShareOutcome;
};

/**
 * Write the data export and hand it to the share sheet.
 *
 * The CSV fallback produces a dozen files and `shareAsync` takes exactly one, so the
 * README is what gets shared and the rest sit in the exports folder. That is a deliberate
 * limitation rather than a zip: adding an archiver to the dependency-free path would put a
 * library between the user and "give me my data", which is the one thing `./csv.ts` exists
 * to prevent. The caller should tell the user where the other files are.
 */
export async function exportAndShareData(
  data: ExportData,
  dialogTitle: string,
  options: SpreadsheetOptions = {},
): Promise<ExportAndShareResult> {
  const outcome = await writeSpreadsheetExport(data, options);
  const first = outcome.files[0];

  if (!first) {
    return { outcome, share: { shared: false, reason: 'failed' } };
  }

  const share = await shareFile({
    uri: first.uri,
    mimeType: outcome.format === 'xlsx' ? MIME.xlsx : MIME.csv,
    dialogTitle,
  });

  return { outcome, share };
}
