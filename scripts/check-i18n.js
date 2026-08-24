#!/usr/bin/env node
/**
 * Translation parity gate.  `npm run check:i18n`
 *
 * Three separate assertions, in order of how badly the failure hurts:
 *
 *  1. KEY SETS MATCH.  en.json and hi.json must carry exactly the same dotted
 *     keys. A key present only in English silently degrades to English for a
 *     Hindi-reading user (src/i18n/index.ts falls back rather than throwing) —
 *     which is the correct runtime behaviour and precisely why the gap is
 *     invisible without this check. A key present only in Hindi is worse: an
 *     English user sees the raw key path.
 *
 *  2. EVERY `report.*` VALUE IS BYTE-IDENTICAL IN BOTH FILES.  This is the
 *     property that keeps the doctor's printed page in English no matter which
 *     language the patient reads the app in. An OPD in India is staffed by
 *     doctors who read English; a report that flips to Hindi because the
 *     patient set the UI to Hindi is a report the doctor may not be able to
 *     read, on the one occasion when reading it matters. The value is compared
 *     byte-for-byte, not "is it Latin script": a translated string that happens
 *     to be transliterated is still a divergence, and divergence is the thing
 *     that decays.
 *
 *  3. EVERY STATIC `t('…')` KEY RESOLVES.  A missing key does not crash — it
 *     renders the key path — so it ships. This finds it at build time instead.
 *
 * The app has TWO string sources by design: the shared JSON bundles, and
 * per-screen `LocalStrings` maps (`const STRINGS: LocalStrings = { 'a.b': { en,
 * hi } }` + `useT(STRINGS)`), used for strings only one screen ever shows. A
 * key is considered resolvable if it is in either. Keys built at runtime
 * (`t(\`x.${y}\`)`, `t(someVariable)`) cannot be checked statically and are
 * counted and reported, never failed.
 *
 * Exit code 1 on any failure.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'src', 'i18n');
const SRC_DIR = path.join(ROOT, 'src');

const REPORT_PREFIX = 'report.';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Flattens a nested translation tree to `{ 'a.b.c': 'value' }`. */
function flatten(tree, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(tree)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, dotted, out);
    } else {
      out.set(dotted, value);
    }
  }
  return out;
}

function readBundle(name) {
  const file = path.join(I18N_DIR, `${name}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`could not read ${path.relative(ROOT, file)}: ${error.message}`);
    process.exit(1);
  }
  try {
    return { file, values: flatten(JSON.parse(raw)) };
  } catch (error) {
    fail(`${path.relative(ROOT, file)} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

/** Every .ts/.tsx under src/, excluding tests. */
function listSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      listSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** 1-indexed line number of a character offset. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

const problems = [];
function fail(message) {
  problems.push(message);
}

// ── 1 + 2: the two bundles ───────────────────────────────────────────────────

const en = readBundle('en');
const hi = readBundle('hi');

const enKeys = new Set(en.values.keys());
const hiKeys = new Set(hi.values.keys());

const missingInHi = [...enKeys].filter((key) => !hiKeys.has(key)).sort();
const missingInEn = [...hiKeys].filter((key) => !enKeys.has(key)).sort();

if (missingInHi.length > 0) {
  fail(
    `hi.json is missing ${missingInHi.length} key(s) that en.json has:\n` +
      missingInHi.map((key) => `      ${key}`).join('\n'),
  );
}
if (missingInEn.length > 0) {
  fail(
    `en.json is missing ${missingInEn.length} key(s) that hi.json has:\n` +
      missingInEn.map((key) => `      ${key}`).join('\n'),
  );
}

const reportKeys = [...enKeys].filter((key) => key.startsWith(REPORT_PREFIX)).sort();
const divergentReportKeys = [];
for (const key of reportKeys) {
  if (!hiKeys.has(key)) continue; // already reported above
  if (en.values.get(key) !== hi.values.get(key)) {
    divergentReportKeys.push(key);
  }
}
if (divergentReportKeys.length > 0) {
  fail(
    `${divergentReportKeys.length} \`${REPORT_PREFIX}*\` value(s) differ between en.json and hi.json.\n` +
      '      The printed report is English in BOTH bundles by design, so that any doctor\n' +
      '      at any OPD can read it regardless of the app language. Copy the English\n' +
      '      value into hi.json verbatim.\n' +
      divergentReportKeys
        .map(
          (key) =>
            `      ${key}\n` +
            `        en: ${JSON.stringify(en.values.get(key))}\n` +
            `        hi: ${JSON.stringify(hi.values.get(key))}`,
        )
        .join('\n'),
  );
}

// ── 3: static t('…') keys ────────────────────────────────────────────────────

/**
 * `t('a.b')`, `t("a.b")`, and the two-argument form with params. Also matches
 * `useT(...)`-bound `t` — same call shape. Deliberately does NOT match
 * `t(\`a.${b}\`)`; those are counted separately.
 */
const STATIC_T = /(?<![A-Za-z0-9_$.])t\(\s*(['"])([A-Za-z0-9_.]+)\1/g;
const DYNAMIC_T = /(?<![A-Za-z0-9_$.])t\(\s*(?:`[^`]*\$\{|[A-Za-z_$][A-Za-z0-9_$]*\s*[,)])/g;

/**
 * Keys declared in a per-screen `LocalStrings` map:
 *
 *   'setup.stepOf': { en: '…', hi: '…' },
 *
 * Matched structurally (quoted key → object whose first property is `en`)
 * rather than by looking for the `LocalStrings` type name, so a map that is
 * inlined or aliased still counts.
 */
const LOCAL_STRING_KEY = /(['"])([A-Za-z0-9_.]+)\1\s*:\s*\{\s*(?:\/\/[^\n]*\n\s*)*en\s*:/g;

const sources = listSources(SRC_DIR);
const unresolved = [];
let staticCount = 0;
let dynamicCount = 0;

for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');

  const local = new Set();
  for (const match of text.matchAll(LOCAL_STRING_KEY)) local.add(match[2]);

  for (const match of text.matchAll(DYNAMIC_T)) {
    void match;
    dynamicCount += 1;
  }

  for (const match of text.matchAll(STATIC_T)) {
    const key = match[2];
    staticCount += 1;
    if (enKeys.has(key) || hiKeys.has(key) || local.has(key)) continue;
    unresolved.push({
      file: path.relative(ROOT, file),
      line: lineAt(text, match.index),
      key,
    });
  }
}

if (unresolved.length > 0) {
  fail(
    `${unresolved.length} t('…') key(s) resolve in neither bundle nor a local STRINGS map.\n` +
      '      At runtime these render as the raw key path on the screen.\n' +
      unresolved.map((u) => `      ${u.file}:${u.line}  ${u.key}`).join('\n'),
  );
}

// ── 4: keys a TYPE promises, that no call site spells out ────────────────────
//
// Assertion 3 above can only see keys that are written down as literals. Some of this
// app's keys are not: `src/features/ai/errors.ts` builds `errors.ai.${code}` from a union
// member, so every one of ~23 AI failure messages is invisible to the scan by
// construction. That is not a hypothetical gap — the whole `errors.ai` namespace was
// missing from BOTH bundles and nothing noticed, so a Hindi reader got every AI failure in
// English (`translate()` returns the key path, and the screen falls back to the English
// literal in errors.ts). A template-literal key needs a check driven by the type that
// generates it, not by the call sites that consume it.
//
// The union is parsed out of the source rather than imported, because this script is plain
// CommonJS run by node with no TypeScript in the loop. Parsing is exact here: the shape is
// `export type X = | 'a' | 'b' …;` and the declaration is read only up to its first `;`.
//
// Add a family to this list when a new key prefix is built from a union anywhere.
const TYPE_DRIVEN_KEYS = [
  {
    label: 'AiErrorCode',
    file: path.join('src', 'features', 'ai', 'errors.ts'),
    typeName: 'AiErrorCode',
    prefix: 'errors.ai.',
    builtAt: 'src/features/ai/errors.ts  `messageKey: `errors.ai.${code}``',
  },
];

let typeDrivenCount = 0;

for (const family of TYPE_DRIVEN_KEYS) {
  const full = path.join(ROOT, family.file);
  let source;
  try {
    source = fs.readFileSync(full, 'utf8');
  } catch (error) {
    fail(`could not read ${family.file} to check ${family.label} keys: ${error.message}`);
    continue;
  }

  const declaration = new RegExp(`export type ${family.typeName}\\s*=([\\s\\S]*?);`).exec(source);
  if (!declaration?.[1]) {
    fail(
      `could not find \`export type ${family.typeName}\` in ${family.file}.\n` +
        '      This check is what keeps a template-literal i18n key honest. If the type was\n' +
        '      renamed or moved, update TYPE_DRIVEN_KEYS in this script — do not delete it.',
    );
    continue;
  }

  const members = [...declaration[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
  if (members.length === 0) {
    fail(`\`${family.typeName}\` in ${family.file} parsed to zero members — the check is blind.`);
    continue;
  }

  typeDrivenCount += members.length;

  const missing = members
    .map((member) => `${family.prefix}${member}`)
    .filter((key) => !enKeys.has(key) || !hiKeys.has(key))
    .sort();

  if (missing.length > 0) {
    fail(
      `${missing.length} \`${family.typeName}\` key(s) are missing from a bundle.\n` +
        `      Built at ${family.builtAt}, so no static t('…') scan can see them.\n` +
        '      A missing one renders in English to a Hindi reader, silently.\n' +
        missing
          .map(
            (key) =>
              `      ${key}` +
              `${enKeys.has(key) ? '' : '  [missing in en.json]'}` +
              `${hiKeys.has(key) ? '' : '  [missing in hi.json]'}`,
          )
          .join('\n'),
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────────

console.log('i18n parity');
console.log(`  en.json            ${enKeys.size} keys`);
console.log(`  hi.json            ${hiKeys.size} keys`);
console.log(`  report.* keys      ${reportKeys.length} (must be byte-identical in both)`);
console.log(`  files scanned      ${sources.length}`);
console.log(`  static t() calls   ${staticCount}`);
console.log(`  runtime-built keys ${dynamicCount} (not statically checkable)`);
console.log(`  type-driven keys   ${typeDrivenCount} (checked against the union, not the call site)`);

if (problems.length === 0) {
  console.log('\n✓ i18n OK');
  process.exit(0);
}

console.error('');
for (const problem of problems) console.error(`  ✗ ${problem}`);
console.error(`\n✗ i18n check failed (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
process.exit(1);
