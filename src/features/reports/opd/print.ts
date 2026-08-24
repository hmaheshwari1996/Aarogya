/**
 * HTML → PDF, through the Android WebView print engine.
 *
 * THE ONE THING TO GET RIGHT HERE IS THE PAGE GEOMETRY, AND IT IS DECIDED IN `./css.ts`:
 * the report declares `@page { size: A4; margin: 12mm }` and this module passes NEITHER
 * `width` NOR `height` to `printToFileAsync`. Passing both sources of truth double-applies
 * the margin and walks the last table column off the paper.
 *
 * `pageSize: 'native-a4'` is the documented escape hatch for a device whose WebView turns
 * out to ignore `@page`. It swaps the two over — the geometry comes from the arguments and
 * the `@page` rule is dropped from the stylesheet in the same call — so the two are never
 * both in force. It is not a fallback that fires automatically, because "the PDF came out
 * the wrong size" is not something this code can detect.
 */

import * as Print from 'expo-print';

import { adoptIntoExports, timestampedFileName } from '../exports/files';
import type { OpdReportData } from '../data/types';
import { buildOpdHtml, type BuildOpdOptions } from './buildOpdHtml';
import { A4_POINTS } from './css';

export type PageSizeStrategy = 'css-a4' | 'native-a4';

export type GeneratedPdf = {
  uri: string;
  fileName: string;
  /** As reported by the print engine. Useful for "this is a 4-page report" copy. */
  pages: number;
};

export type PrintPdfOptions = {
  fileName?: string;
  pageSize?: PageSizeStrategy;
  now?: number;
};

/**
 * The shared HTML→PDF step. Every PDF this feature produces goes through here, so the
 * width/height decision exists in exactly one place.
 */
export async function htmlToPdf(html: string, options: PrintPdfOptions & { baseName: string }): Promise<GeneratedPdf> {
  const strategy = options.pageSize ?? 'css-a4';

  const result = await Print.printToFileAsync(
    strategy === 'native-a4'
      ? // The stylesheet must have been built with includePageRule: false to match.
        { html, width: A4_POINTS.width, height: A4_POINTS.height }
      : // Deliberately no width/height. The stylesheet owns the page. See ./css.ts.
        { html },
  );

  const fileName = options.fileName ?? timestampedFileName(options.baseName, '.pdf', options.now);
  const uri = adoptIntoExports(result.uri, fileName);
  return { uri, fileName, pages: result.numberOfPages };
}

export async function printOpdPdf(
  data: OpdReportData,
  options: PrintPdfOptions & { build?: BuildOpdOptions } = {},
): Promise<GeneratedPdf> {
  const strategy = options.pageSize ?? 'css-a4';
  const html = buildOpdHtml(data, {
    ...options.build,
    // The two page-geometry sources are mutually exclusive, and this is where that is
    // enforced rather than left to the caller to remember.
    includePageRule: strategy === 'css-a4',
  });

  const base = `aarogya-report-${data.patient.displayName}`;
  return htmlToPdf(html, { ...options, baseName: base });
}

/** Straight to a physical printer, skipping the file entirely. */
export async function printOpdDirect(data: OpdReportData, build?: BuildOpdOptions): Promise<void> {
  await Print.printAsync({ html: buildOpdHtml(data, { ...build, includePageRule: true }) });
}
