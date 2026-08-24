/**
 * The wall chart as a shareable, printable PDF.
 *
 * Same page-geometry rule as the OPD report: the stylesheet carries `@page`, so no
 * `width`/`height` reaches `printToFileAsync`. `htmlToPdf` is the single place that
 * decision is applied.
 */

import { htmlToPdf, type GeneratedPdf, type PrintPdfOptions } from '../opd/print';
import { buildWallChartHtml, type WallChartInput } from './buildWallChartHtml';

export { buildWallChartHtml, daysInMonth, WALL_CHART_CSS } from './buildWallChartHtml';
export type {
  WallChartInput,
  WallChartLabels,
  WallChartMeasurementRow,
  WallChartMedicineRow,
} from './buildWallChartHtml';

export async function printWallChartPdf(
  input: WallChartInput,
  options: PrintPdfOptions = {},
): Promise<GeneratedPdf> {
  return htmlToPdf(buildWallChartHtml(input), {
    ...options,
    // 'native-a4' would force portrait, which is the one thing this sheet must not be.
    pageSize: 'css-a4',
    baseName: `aarogya-wall-chart-${input.month.slice(0, 7)}`,
  });
}
