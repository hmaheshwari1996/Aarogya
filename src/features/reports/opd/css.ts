/**
 * Print CSS for the OPD report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAGE-SIZE DECISION, AND WHY IT IS RECORDED IN CODE
 *
 * There are two ways to tell the Android WebView print path how big a page is:
 *
 *   (a) `@page { size: A4; margin: 12mm }` in CSS, and NO `width`/`height` arguments to
 *       `printToFileAsync`; or
 *   (b) `printToFileAsync({ width: 595, height: 842 })` — A4 at 72 PPI — and NO `@page`
 *       size or margin rule.
 *
 * Doing BOTH double-applies the margins: the print adapter lays the document out inside
 * a page of the size you passed, and the stylesheet then insets the content again, so a
 * 12mm margin becomes 24mm on one edge and the last column of every wide table walks off
 * the paper. It is not a rendering bug so much as two people answering the same question.
 *
 * THIS REPORT PICKS (a). The reasons are that the margin belongs with the typography
 * rather than with the call site, that a caller who forgets the numbers gets US Letter
 * silently, and that `@page` is the only one of the two that a future landscape appendix
 * could override per-page.
 *
 * `printOpdPdf` therefore passes NEITHER width NOR height. If a device is ever found
 * whose WebView ignores `@page`, `printOpdPdf({ pageSize: 'native-a4' })` switches to (b)
 * and drops the `@page` rule in the same breath — the two are never both in force.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EVERYTHING HERE IS GREYSCALE. OPD printers are black and white and roughly 8% of men
 * have red/green colour deficiency, so no meaning is ever carried by hue: out-of-range is
 * a hollow marker, "not taken" is a striped fill, "no record" is a dashed outline, and
 * each of them is also written out in words in a key.
 */

/** A4 at 72 PPI, for the `native-a4` escape hatch only. See the header. */
export const A4_POINTS = { width: 595, height: 842 } as const;

export const PAGE_MARGIN_MM = 12;

/**
 * @param includePageRule false for the `native-a4` strategy, where the page geometry
 *        comes from `printToFileAsync` instead and the two must not both be in force.
 */
export function opdPrintCss(includePageRule = true): string {
  const pageRule = includePageRule
    ? `@page { size: A4; margin: ${PAGE_MARGIN_MM}mm; }`
    : '/* page geometry supplied by printToFileAsync — @page deliberately omitted */';

  return `
${pageRule}

/* Greys and stripes are information, not decoration. Without this the print engine is
   free to drop backgrounds, which would erase the three-way adherence split entirely. */
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: "Noto Sans", Roboto, Helvetica, Arial, sans-serif;
  font-size: 9.6pt;
  line-height: 1.35;
  color: #111;
  background: #fff;
}

h1 { font-size: 15pt; margin: 0 0 2pt; }
h2 {
  font-size: 10.5pt;
  margin: 0 0 3pt;
  padding-bottom: 2pt;
  border-bottom: 1px solid #111;
  text-transform: uppercase;
  letter-spacing: 0.4pt;
}
h3 { font-size: 9.6pt; margin: 6pt 0 2pt; }
p { margin: 0 0 3pt; }
ul, ol { margin: 0 0 3pt; padding-left: 14pt; }
li { margin: 0 0 1pt; }
strong { font-weight: 700; }

/* Nothing on this page is allowed to be cut in half by a page break. A section that
   cannot fit moves whole; a table row that cannot fit moves whole. */
.section { margin: 0 0 7pt; break-inside: avoid; page-break-inside: avoid; }
.page-break { break-after: page; page-break-after: always; }

/* ── Header ──────────────────────────────────────────────────────────────── */
.masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 10pt; margin-bottom: 6pt; }
.masthead__meta { text-align: right; font-size: 8.4pt; color: #333; }
.patient-line { font-size: 9.6pt; }
.patient-line span + span::before { content: "  •  "; color: #666; }
.conditions { font-size: 9pt; }
.delta-table td, .delta-table th { padding: 1.5pt 5pt; }

/* ── Tables ──────────────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
/* Repeats the header row at the top of every page a long table spills onto. Without it
   the second page of a readings table is a wall of unlabelled numbers. */
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid #BBB; padding: 2pt 4pt; text-align: left; vertical-align: top; }
th { background: #EEE; font-weight: 700; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:nth-child(even) td { background: #FAFAFA; }
.table-note { font-size: 8pt; color: #444; margin-top: 2pt; }

/* ── Charts ──────────────────────────────────────────────────────────────── */
.chart { margin: 0 0 4pt; break-inside: avoid; page-break-inside: avoid; }
.chart img { width: 100%; height: auto; display: block; }
/* Real text, not pixels — see the caption comment in buildOpdHtml.ts. */
.chart-caption { font-size: 8pt; color: #222; margin-top: 1pt; }

/* ── Adherence ───────────────────────────────────────────────────────────── */
.adh-period { font-size: 8.8pt; color: #333; }
.adh-headline { font-size: 11pt; font-weight: 700; margin-bottom: 3pt; }
.adh-suppressed {
  font-size: 11pt;
  font-weight: 700;
  margin-bottom: 2pt;
  padding: 3pt 5pt;
  border: 1.5px solid #111;
  background: #F2F2F2;
}
.adh-suppressed__why { font-size: 8.6pt; color: #222; }
.adh-run { font-size: 8.6pt; }
.adh-bar { display: flex; width: 100%; height: 12pt; border: 1px solid #111; margin: 3pt 0 3pt; overflow: hidden; }
.adh-seg { display: block; height: 100%; }
.adh-seg--taken { background: #111; }
/* A stripe, not a second colour: it survives greyscale AND a monochrome laser. */
.adh-seg--not-taken {
  background: #FFF;
  background-image: repeating-linear-gradient(45deg, #111 0, #111 1.4pt, #FFF 1.4pt, #FFF 4pt);
}
.adh-seg--no-record { background: #FFF; }
.adh-key { list-style: none; padding: 0; margin: 0 0 3pt; font-size: 8.6pt; }
.adh-key li { display: inline-block; margin-right: 12pt; }
.adh-key__total { color: #333; }
.adh-swatch { display: inline-block; width: 9pt; height: 9pt; border: 1px solid #111; margin-right: 3pt; vertical-align: -1pt; }
.adh-swatch.adh-seg--no-record { border-style: dashed; }
.adh-windows { margin-top: 3pt; }
.adh-note { font-size: 8pt; color: #333; }
.disclaimer { font-size: 8.2pt; color: #222; margin-top: 3pt; font-style: italic; }

/* ── Dose calendar (DOTS-style) ──────────────────────────────────────────── */
.dots { border-collapse: collapse; font-size: 7pt; table-layout: fixed; }
.dots th, .dots td { border: 1px solid #BBB; padding: 0; text-align: center; height: 13pt; }
.dots th { background: #EEE; font-size: 6.6pt; font-weight: 700; }
.dots th.dots__med, .dots td.dots__med {
  text-align: left;
  padding: 1pt 3pt;
  width: 30%;
  font-size: 8pt;
  background: #fff;
}
.dots__cell { display: block; width: 100%; height: 100%; line-height: 13pt; font-size: 6.6pt; font-weight: 700; }
.dots__cell--taken { background: #111; color: #FFF; }
.dots__cell--not-taken {
  color: #111;
  background-image: repeating-linear-gradient(45deg, #BBB 0, #BBB 1.2pt, #FFF 1.2pt, #FFF 3.4pt);
}
.dots__cell--no-record { color: #111; border: 1px dashed #111; }
.dots__cell--away { background: #DDD; color: #111; }
.dots__cell--none { color: #CCC; }
.dots-key { list-style: none; padding: 0; margin: 3pt 0 0; font-size: 8pt; }
.dots-key li { display: inline-block; margin-right: 10pt; }

/* ── Symptoms, labs, questions ───────────────────────────────────────────── */
.timeline-dates { font-size: 8.4pt; }
.note-row td { padding-top: 0; border-top: 0; }
.symptom-notes { margin: 0 0 2pt 0; padding-left: 12pt; font-size: 8.4pt; color: #333; }
.symptom-notes li { margin: 0; }
.tag {
  display: inline-block;
  border: 1px solid #666;
  border-radius: 2pt;
  padding: 0 2.5pt;
  font-size: 7.4pt;
  margin-left: 3pt;
  color: #333;
}
.question-list li { margin-bottom: 2pt; }
.muted { color: #444; }
.footer {
  margin-top: 8pt;
  padding-top: 3pt;
  border-top: 1px solid #BBB;
  font-size: 7.8pt;
  color: #333;
}
`.trim();
}
