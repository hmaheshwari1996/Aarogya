/**
 * Reporting, export and sharing.
 *
 * FOUR ARTEFACTS, EACH FOR A DIFFERENT READER:
 *
 *   dayCard/    a 1080×1350 picture of one day, for the family WhatsApp group.
 *   opd/        a one-page A4 the doctor reads in 45 seconds, plus an appendix.
 *   exports/    CSV always, XLSX when it can — "give me my data", kept unconditionally.
 *   wallchart/  a printable month grid ticked by hand, for the wall by the medicine box.
 *
 * THE RULES THAT CUT ACROSS ALL FOUR:
 *
 *  • Adherence is stated honestly or not stated. The word "missed" appears nowhere; a
 *    dose with nothing recorded is "not recorded as taken", and a run of silent days
 *    suppresses the percentage in favour of the reason. See `opd/adherenceSection.ts`.
 *
 *  • A chart may draw a target band only when a `target_range` row exists, and the legend
 *    names the person and the date who set it. No target, no band, no marked values.
 *
 *  • Nothing encodes meaning by colour alone: out-of-range is a hollow marker, "not taken"
 *    is a stripe, "no record" is a dashed outline, and every one of them is also a word.
 *
 *  • No badge, no streak, no gamification on any doctor-facing surface, ever.
 *
 *  • Everything builds offline. Charts are inlined as `data:` URIs and no document in this
 *    feature references a network resource of any kind.
 *
 * The share sheet is the default way anything leaves the app. Saving to the phone gallery
 * is demoted behind a blocking, never-remembered warning — see `exports/gallery.ts`.
 */

export * from './data/types';
export { classifyMetric, collectDayCard, collectExportData, collectOpdReport } from './data/collect';
export type { MetricRole } from './data/collect';

export {
  bandLegend,
  buildMetricChart,
  isOutsideTarget,
  renderEmptyChartSvg,
  renderSeriesChartSvg,
  resolveTarget,
} from './charts';
export type { BuiltChart, ChartBand, ChartPoint, ChartSeries, ChartSpec } from './charts';
export { buildMedicationTimeline } from './charts/timelineChart';
export type { BuiltTimeline, TimelineInput } from './charts/timelineChart';

export * from './dayCard';
export * from './opd';
export * from './exports';
export * from './wallchart';

export { escapeHtml } from './lib/html';
export { svgToDataUri, utf8ToBase64 } from './lib/base64';
export {
  ageFromYearOfBirth,
  formatDate,
  formatDateLong,
  formatDateRangeLong,
  formatDaysMask,
  formatNumber,
  formatTime,
} from './lib/format';
