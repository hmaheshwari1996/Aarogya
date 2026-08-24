/**
 * The OPD report surface.
 *
 * `buildOpdHtml` is pure and can be called anywhere. `printOpdPdf` is the one place that
 * decides page geometry, and it never passes `width`/`height` alongside `@page` — see
 * `./css.ts` for the whole argument.
 */

import type { OpdReportData } from '../data/types';
import { MIME, shareFile, type ShareOutcome } from '../exports/share';
import type { BuildOpdOptions } from './buildOpdHtml';
import { printOpdPdf, type GeneratedPdf, type PrintPdfOptions } from './print';

export { buildOpdHtml, describeSchedule, groupSymptoms, selectChartMetrics, DEFAULT_PAGE_ONE_LIMITS } from './buildOpdHtml';
export type { BuildOpdOptions, PageOneLimits } from './buildOpdHtml';

export { adherenceHeadline, renderAdherenceSection, suppressionText, NO_RECORD_PHRASE } from './adherenceSection';
export type { AdherenceSectionInput, AdherenceWindowInput } from './adherenceSection';

export { opdPrintCss, A4_POINTS, PAGE_MARGIN_MM } from './css';
export { renderDoseCalendar } from './doseCalendar';
export type { DoseCalendarInput } from './doseCalendar';

export { htmlToPdf, printOpdDirect, printOpdPdf } from './print';
export type { GeneratedPdf, PageSizeStrategy, PrintPdfOptions } from './print';

export type ShareOpdResult = { pdf: GeneratedPdf; share: ShareOutcome };

/** Build the PDF and open the share sheet — the default action on the reports screen. */
export async function shareOpdReport(
  data: OpdReportData,
  dialogTitle: string,
  options: PrintPdfOptions & { build?: BuildOpdOptions } = {},
): Promise<ShareOpdResult> {
  const pdf = await printOpdPdf(data, options);
  const share = await shareFile({ uri: pdf.uri, mimeType: MIME.pdf, dialogTitle });
  return { pdf, share };
}
