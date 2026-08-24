/**
 * XLSX — the nicety. CSV is the guarantee; this is the version that opens with the
 * columns already named and the sheets already tabbed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SHEETJS CAVEAT, WRITTEN DOWN SO NOBODY HAS TO REDISCOVER IT
 *
 *  • SheetJS is NOT on npm. The maintained distribution moved to a tarball served from
 *    cdn.sheetjs.com, so `npm i xlsx` gets an abandoned 0.18.x fork with published
 *    advisories. Installing it means adding the CDN tarball explicitly, and this project
 *    has deliberately not done so yet — which is precisely why the code below must cope
 *    with the module being absent.
 *
 *  • Its own tested matrix stops at React Native 0.79.2. This app runs 0.81.5 on Hermes.
 *    The zip writer it uses does large typed-array work, and nobody has verified that on
 *    this engine. It may work perfectly. It may also throw, or return an empty string, or
 *    produce a file Excel refuses.
 *
 * THEREFORE:
 *
 *  1. The module is required LAZILY and INDIRECTLY. Lazily, so a load failure cannot take
 *     down app start-up — this file is imported by the exports barrel, and a throw at
 *     module scope would break the screen that opens it. Indirectly (the specifier is
 *     assembled at runtime), so Metro's static dependency collection never sees it and
 *     the bundle still BUILDS when the package is not installed at all. Metro's runtime
 *     `require` rejects a non-literal specifier, which is exactly the failure this code
 *     is written to absorb.
 *
 *  2. Every capability is feature-detected before use, and the produced payload is
 *     checked for being a non-empty string before it is written.
 *
 *  3. Any failure falls back to the CSV bundle SILENTLY as far as the user is concerned —
 *     she asked for her data and she gets it — but LOUDLY in the log, because a silent
 *     permanent fallback is how a feature quietly stops existing.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { ExportData } from '../data/types';
import { buildCsvSheets, buildReadmeSheet, sheetToCsv, type CsvSheet, type CsvValue } from './csv';
import { timestampedFileName, writeExportBase64, writeExportText } from './files';

/*
 * `Requirer` and `isSheetJs` below are intentionally retained but unused. They are the
 * scaffolding for the three-step "enable XLSX later" path documented on loadSheetJs():
 * `isSheetJs` in particular is the shape guard a future static import still needs, and
 * rewriting it from scratch later is how a subtly different check gets introduced.
 * Deleting them would be tidier and would lose the thing that makes re-enabling safe.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

/** Declared locally so an indirect lookup type-checks without pulling in Node types. */
declare const require: unknown;

type Requirer = (id: string) => unknown;

type SheetJsWorkbook = { SheetNames: string[]; Sheets: Record<string, unknown> };

type SheetJsModule = {
  utils: {
    book_new: () => SheetJsWorkbook;
    book_append_sheet: (workbook: SheetJsWorkbook, sheet: unknown, name?: string) => void;
    aoa_to_sheet: (rows: CsvValue[][]) => unknown;
  };
  write: (workbook: SheetJsWorkbook, options: { type: string; bookType: string }) => unknown;
};

export type WorkbookOutcome =
  | { format: 'xlsx'; uri: string; fileName: string; files: ExportedFile[] }
  | { format: 'csv'; files: ExportedFile[]; reason: string };

export type ExportedFile = { uri: string; fileName: string };

/** Excel's rules, not ours: 31 characters, and none of []:*?/\ */
export function sanitiseSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, '-').trim();
  return (cleaned.length > 0 ? cleaned : 'Sheet').slice(0, 31);
}

function isSheetJs(candidate: unknown): candidate is SheetJsModule {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const module = candidate as Partial<SheetJsModule>;
  const utils = module.utils;
  return (
    typeof module.write === 'function' &&
    typeof utils === 'object' &&
    utils !== null &&
    typeof utils.book_new === 'function' &&
    typeof utils.book_append_sheet === 'function' &&
    typeof utils.aoa_to_sheet === 'function'
  );
}

/**
 * SheetJS is deliberately NOT installed, so this always reports unavailable and
 * `writeSpreadsheetExport` falls back to CSV. That fallback is not a degraded mode —
 * CSV is the primary, dependency-free path, and every spreadsheet application opens it.
 *
 * WHY THIS IS NOT A RUNTIME `require`:
 *
 * An earlier version assembled the specifier at runtime — `require(['x','l','s','x'].join(''))` —
 * to avoid Metro resolving a package that isn't installed. The intent was right and the
 * mechanism was wrong: **Metro's Babel transform rejects a non-literal `require()` at
 * transform time**, as a hard `SyntaxError: Invalid call at line 93: require(specifier)`.
 * It never reaches resolution, so the whole release bundle failed to build.
 *
 * It also only failed in RELEASE. A debug build serves modules from the Metro dev server
 * on demand, so a file nothing imports at startup is never transformed; a release build
 * bundles every module up front. That is worth remembering — the release bundle is the
 * first place a whole class of defect becomes visible.
 *
 * TO ENABLE XLSX LATER (three steps, in this order):
 *   1. `npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (SheetJS is not on npm)
 *   2. Replace this function body with a static `import * as XLSX from 'xlsx'` at the top
 *      of the file and `return isSheetJs(XLSX) ? { module: XLSX } : { module: null, reason: … }`
 *   3. Verify on a real device. SheetJS's own tested matrix stops at RN 0.79.2, so Hermes
 *      on RN 0.81 is unproven — and it adds roughly a megabyte to a bundle being kept small.
 */
function loadSheetJs(): { module: SheetJsModule } | { module: null; reason: string } {
  return {
    module: null,
    reason: 'the spreadsheet library is not bundled in this build; exporting CSV instead',
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sheetRows(sheet: CsvSheet): CsvValue[][] {
  // Booleans become the same 'yes'/'no' words the CSV writes, so the two exports of the
  // same record are readable the same way and README describes both correctly.
  const body = sheet.rows.map((row) => row.map((cell) => (typeof cell === 'boolean' ? (cell ? 'yes' : 'no') : cell)));
  return [sheet.columns.map((column) => column.header), ...body];
}

export type SpreadsheetOptions = {
  baseName?: string;
  /** Set false to skip the attempt entirely — for a "plain CSV please" affordance. */
  preferXlsx?: boolean;
  now?: number;
};

/**
 * Writes the export and reports which format actually happened.
 *
 * The caller must handle both outcomes without treating `csv` as an error: the
 * doctor-facing requirement — the patient can walk away with her record — is met either
 * way, and telling her the export "failed" because a spreadsheet library is missing would
 * be false.
 */
export async function writeSpreadsheetExport(
  data: ExportData,
  options: SpreadsheetOptions = {},
): Promise<WorkbookOutcome> {
  const now = options.now ?? Date.now();
  const baseName = options.baseName ?? 'aarogya-data';
  const sheets = buildCsvSheets(data);
  const allSheets: CsvSheet[] = [buildReadmeSheet(sheets, data), ...sheets];

  if (options.preferXlsx === false) {
    return { format: 'csv', files: writeCsvFiles(allSheets, data, now), reason: 'CSV requested' };
  }

  const loaded = loadSheetJs();
  if (loaded.module === null) {
    console.warn(`[reports] XLSX export unavailable — wrote CSV instead. Reason: ${loaded.reason}`);
    return { format: 'csv', files: writeCsvFiles(allSheets, data, now), reason: loaded.reason };
  }

  try {
    const xlsx = loaded.module;
    const workbook = xlsx.utils.book_new();
    for (const sheet of allSheets) {
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(sheetRows(sheet)), sanitiseSheetName(sheet.name));
    }

    const payload = xlsx.write(workbook, { type: 'base64', bookType: 'xlsx' });
    // A library that silently returns '' or a Buffer-like object on an untested engine
    // would otherwise produce a zero-byte .xlsx that Excel refuses to open — which looks
    // to the user exactly like losing her data.
    if (typeof payload !== 'string' || payload.length < 512) {
      throw new Error('the spreadsheet library returned an empty or unexpected payload');
    }

    const fileName = timestampedFileName(baseName, '.xlsx', now);
    const uri = writeExportBase64(fileName, payload);
    return { format: 'xlsx', uri, fileName, files: [{ uri, fileName }] };
  } catch (error) {
    const reason = `writing the workbook failed: ${describe(error)}`;
    console.warn(`[reports] XLSX export failed — wrote CSV instead. Reason: ${reason}`);
    return { format: 'csv', files: writeCsvFiles(allSheets, data, now), reason };
  }
}

function writeCsvFiles(sheets: readonly CsvSheet[], data: ExportData, now: number): ExportedFile[] {
  // One shared stamp across the bundle, so the twelve files sort together in a file
  // manager instead of interleaving with an earlier export taken a minute before.
  const stamp = timestampedFileName(`data-${data.range.toDate}`, '.csv', now).replace(/\.csv$/, '');
  return sheets.map((sheet) => {
    const fileName = `aarogya-${sheet.name}-${stamp}.csv`;
    return { uri: writeExportText(fileName, sheetToCsv(sheet)), fileName };
  });
}
