/**
 * HTML escaping for everything the report layer prints.
 *
 * PURE, and with NO RUNTIME IMPORTS — the report builders are string builders, and
 * keeping this file free of any runtime dependency means any of them can be loaded by
 * Node's type-stripping test runner without dragging React Native in behind it.
 *
 * Every value that reaches an HTML template goes through `escapeHtml`. Not because a
 * doctor's report is a hostile environment, but because the values in it are typed by a
 * patient: a medicine written as "Losartan <25>", a note containing "BP > 140", a lab
 * called "T3/T4 & TSH". Each of those silently eats the rest of a table cell if it is
 * interpolated raw, and a report that quietly drops a row is worse than one that fails.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Attribute values need exactly the same treatment as text; the alias exists so a call
 * site reads as what it is doing, and so a future divergence has one place to happen.
 */
export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * The single em dash the report uses for "nothing recorded here".
 *
 * A blank cell is ambiguous — it reads as "the app lost it" as easily as "there was
 * nothing". An explicit mark says the row was looked at.
 */
export const EMPTY_CELL = '—';

export function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_CELL;
  const text = typeof value === 'number' ? String(value) : value.trim();
  return text.length > 0 ? escapeHtml(text) : EMPTY_CELL;
}

/** Joins rendered fragments, dropping the empty ones so blank sections leave no gap. */
export function joinHtml(parts: readonly (string | null | undefined)[], separator = '\n'): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(separator);
}
