#!/usr/bin/env node
/**
 * Clinical-language gate.  `npm run check:clinical`
 *
 * This app records what a person tapped and what a machine displayed. It does
 * not diagnose, it does not grade, and it does not advise. Those are not
 * stylistic positions — they are the boundary between a health record and an
 * unlicensed medical device, and the boundary is only ever crossed one string
 * at a time, by someone being helpful. This script is the thing that notices.
 *
 * WHAT IT REFUSES, AND WHY
 * ────────────────────────
 *  1. "missed" — the app knows a dose was not RECORDED as taken. It does not
 *     know whether she swallowed it. Every honest phrase in this codebase is
 *     "not recorded as taken". "Missed" asserts a fact the app cannot observe,
 *     and a son reading "missed 3 doses" next to his mother's name makes a
 *     phone call about something that may never have happened.
 *
 *  2. Diagnostic verdicts on a reading — "abnormal", "dangerous", "too high",
 *     "too low", "critical" (as a description of a VALUE), "normal range"
 *     asserted by the app. A blood pressure of 150/95 is a number. Whether it
 *     is a problem depends on her age, her other conditions, what her doctor
 *     is aiming for and what she was doing ten minutes earlier. The app has
 *     none of that. It prints the number.
 *
 *  3. Hardcoded clinical thresholds. Target ranges ship BLANK and are entered
 *     by a human, with that human's name and the date attached — see
 *     `target_range.set_by_label`, which is printed in every chart legend. A
 *     number like `140` baked into a component is an anonymous, undated,
 *     unattributable clinical opinion, and it will outlive everyone who
 *     remembers where it came from.
 *
 *  4. Advice verbs — "you should take", "increase your dose", "consult
 *     immediately". Prescribing is a doctor's job. So is deciding what counts
 *     as an emergency.
 *
 * WHAT IT SCANS
 * ─────────────
 * User-facing and printed surfaces only, because that is where the harm is:
 *
 *   • src/i18n/en.json and hi.json — every value.
 *   • String literals in src/app/**, src/components/** (the screens) and
 *     src/features/reports/** (the printed page).
 *   • Any `{ en: '…', hi: '…' }` pair ANYWHERE in src/ — that is the app's
 *     inline per-screen translation convention (`LocalStrings` + `useT`), and
 *     it is user-facing wherever it lives.
 *
 * Comments and identifiers are exempt by construction: the source is scanned
 * with a real tokenizer and only string/template literals are examined. That
 * matters — this codebase discusses "missed" and "dangerous" at length in its
 * comments, precisely because it is careful about them, and a grep-based check
 * would fail on the documentation of the rule it is enforcing.
 *
 * Threshold detection (rule 3) is scanned across ALL of src/, since a magic
 * number buried in a chart renderer is exactly the case worth catching.
 *
 * ESCAPE HATCH
 * ────────────
 *   // clinical-language-ok: <reason>
 * on the offending line, or on the line directly above it. The reason is
 * mandatory — an unexplained suppression is a finding in itself.
 *
 * Exit code 1 on any finding.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

// ─────────────────────────────────────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────────────────────────────────────

/** Directories whose string literals reach a person's eyes or a printed page. */
const USER_FACING_PREFIXES = [
  path.join('src', 'app'),
  path.join('src', 'components'),
  path.join('src', 'features', 'reports'),
];

/**
 * Individual files outside those directories that are still user-facing.
 * `src/db/seed.ts` carries every condition-pack, metric, symptom and lab-test
 * label the app shows — a symptom chip is as user-facing as a screen.
 */
const USER_FACING_FILES = [path.join('src', 'db', 'seed.ts')];

/**
 * Files exempt from the THRESHOLD rule only — never from the wording rules.
 *
 *   settings/targets.tsx, repositories/targets.ts  the screen and the store
 *     whose entire purpose is a human-entered clinical range.
 *   db/seed.ts, app/_shared/lib.tsx  carry INSTRUMENT limits (what the device
 *     can physically report), which are a property of the glucometer, not of
 *     the patient. Those are additionally recognised structurally below.
 */
const THRESHOLD_EXEMPT_FILES = [
  path.join('src', 'app', 'settings', 'targets.tsx'),
  path.join('src', 'db', 'repositories', 'targets.ts'),
  path.join('src', 'db', 'seed.ts'),
  path.join('src', 'app', '_shared', 'lib.tsx'),
];

const ESCAPE = /\/\/\s*clinical-language-ok\s*:\s*\S/;

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

/** Words that, in a string, describe a READING rather than a medicine tier. */
const READING_WORDS =
  /\b(reading|readings|value|values|number|numbers|level|levels|result|results|bp|blood pressure|pressure|sugar|glucose|spo2|oxygen|pulse|weight|inr)\b/i;

const WORDING_RULES = [
  {
    id: 'missed',
    test: (s) => /\bmissed\b/i.test(s),
    message:
      'the word "missed". The app knows a dose was not RECORDED as taken; it cannot know ' +
      'whether it was swallowed. Use "not recorded as taken".',
  },
  {
    id: 'missed-hi',
    // "छूट गई / छूट गया / छूटी" — the Hindi for a missed dose. Deliberately NOT
    // a bare /छूट/: "चलने की छूट" (permission to run) is a different word and
    // is used correctly in healthCheck.check.battery.ok.
    test: (s) => /छूट\s*(गई|गयी|गया|गए|गये)/.test(s) || /छूटी\s*हुई/.test(s),
    message:
      'the Hindi for "missed" (छूट गई / छूटी). Use the "दर्ज नहीं" ("not recorded") ' +
      'construction — the app cannot know whether the dose was taken.',
  },
  {
    id: 'abnormal',
    test: (s) => /\babnormal(ly)?\b/i.test(s) || /असामान्य/.test(s),
    message: 'the verdict "abnormal". The app prints the number; it does not grade it.',
  },
  {
    id: 'dangerous',
    test: (s) => /\bdanger(ous|ously)?\b/i.test(s) || /खतरनाक/.test(s),
    message: 'the verdict "dangerous". Only a clinician can say that about a reading.',
  },
  {
    id: 'too-high-low',
    // The Hindi half requires a Hindi READING word in the same string. Without
    // that guard it fires on `entry.symptom.severity.severe` = "बहुत ज़्यादा",
    // which is a severity chip the user picks for how a symptom FEELS — her own
    // report of her own body, which is the one judgement the app must not
    // second-guess.
    test: (s) =>
      /\btoo\s+(high|low)\b/i.test(s) ||
      (/(ज़्यादा|अधिक|कम)\s*(है|हो)/.test(s) &&
        /(शुगर|रक्तचाप|बीपी|रीडिंग|रीडिंग्स|स्तर|नाड़ी|वज़न|ऑक्सीजन)/.test(s)),
    message:
      '"too high" / "too low". High or low compared to WHAT? The app has no target ' +
      'unless a human entered one, and even then the comparison is the doctor\'s to make.',
  },
  {
    id: 'critical-reading',
    // `critical` is a legitimate criticality tier for a MEDICINE ("Critical
    // medicine reminders"). It is not a legitimate description of a VALUE.
    test: (s) => /\bcritical(ly)?\b/i.test(s) && READING_WORDS.test(s),
    message:
      '"critical" used about a reading. It is a reminder-loudness tier for a medicine, ' +
      'not a verdict on a number.',
  },
  {
    id: 'normal-range',
    test: (s) =>
      /\bnormal\s+(range|limits?|levels?|values?)\b/i.test(s) ||
      /\b(within|outside|out of)\s+(the\s+)?normal\b/i.test(s) ||
      /सामान्य\s*(सीमा|स्तर|श्रेणी)/.test(s),
    message:
      'the app asserting a "normal range". A reference range belongs to the lab report ' +
      'it was printed on (`lab_result.ref_range_text`, transcribed verbatim) or to a ' +
      'target a named human entered. The app never supplies one.',
  },
  {
    id: 'advice',
    test: (s) =>
      /\byou\s+(should|must|need to)\s+(take|stop|start|increase|reduce|double|skip)\b/i.test(s) ||
      /\b(increase|reduce|decrease|double|halve)\s+(your|the)\s+dose\b/i.test(s) ||
      /\bconsult\s+(a\s+)?(doctor\s+)?immediately\b/i.test(s) ||
      /\b(see|call)\s+(a\s+|your\s+)?doctor\s+(immediately|right away|at once)\b/i.test(s) ||
      /\btake\s+an?\s+extra\s+(dose|tablet|pill)\b/i.test(s),
    message:
      'medical advice. The app records; it does not prescribe, and it does not decide ' +
      'what counts as an emergency.',
  },
];

/**
 * Rule 3 — a clinical threshold hardcoded into the app.
 *
 * Two shapes are caught:
 *   a) a comparison against a numeric literal on a line that also names a
 *      clinical quantity — `if (systolic > 140)`;
 *   b) an identifier that IS a threshold being given a number — `const
 *      normalMax = 140`, `{ dangerLevel: 250 }`.
 *
 * INSTRUMENT limits are not clinical thresholds and are recognised
 * structurally: a line declaring `min:` / `max:` / `softMin:` / `softMax:` /
 * `min_valid` / `max_valid` is describing what a device can physically report,
 * which is a fact about the glucometer, not an opinion about the patient.
 */
const CLINICAL_QUANTITY =
  /\b(systolic|diastolic|pulse|bpm|glucose|sugar|hba1c|spo2|oxygen|saturation|inr|creatinine|egfr|peak[_ ]?flow|temperature|mmhg|mg\/dl|mmol)\b/i;

/**
 * A comparison against a standalone numeric literal.
 *
 * The lookarounds are load-bearing. Without them the `1` in `readings.v1 ===
 * null` reads as a number being compared, and every slot accessor in the entry
 * screens becomes a false positive — which would have made this rule useless on
 * its first run.
 *
 * 0 and 1 are excluded: `.length === 0`, `count > 0` and `version === 1` are
 * everywhere, and no clinical threshold in medicine is 0 or 1. `.length` on
 * either side is excluded for the same reason — an array size is not a reading.
 */
const COMPARISON_WITH_NUMBER =
  /(?:[<>]=?|[!=]==?)\s*(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.$])|(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.$])\s*(?:[<>]=?|[!=]==?)/;

function comparesAgainstThreshold(codeLine) {
  if (/\.length\b/.test(codeLine)) return false;
  const match = COMPARISON_WITH_NUMBER.exec(codeLine);
  if (!match) return false;
  const value = Number(match[1] ?? match[2]);
  return Number.isFinite(value) && value >= 2;
}

const THRESHOLD_IDENTIFIER =
  /\b(normal(Min|Max|Low|High|Range)|threshold|thresholds|cut[_ ]?off|danger(Level|Threshold)?|criticalValue|refLow|refHigh|targetLow|targetHigh|upperLimit|lowerLimit|safeMax|safeMin)\b\s*[:=]\s*(\d+(?:\.\d+)?)/i;

const INSTRUMENT_BOUND_LINE =
  /\b(soft)?(min|max)(_valid|Valid)?\s*:|\bmin_valid\b|\bmax_valid\b|\bminValid\b|\bmaxValid\b/;

// ─────────────────────────────────────────────────────────────────────────────
// Source tokenizer — comments out, string literals in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `{ literals, strippedLines }` for a TS/TSX source.
 *
 * `literals` is every string / template literal with its 1-indexed line.
 * `strippedLines` is the source with comments and string CONTENT blanked, so
 * the threshold regexes above see code and never prose.
 *
 * Hand-rolled rather than regex-based because the three things that must not
 * be confused — a comment, a string, and a regex literal — are only
 * distinguishable by walking the text in order.
 */
function tokenize(text) {
  const literals = [];
  const stripped = Array.from(text);

  let line = 1;
  let i = 0;
  /** Last significant character, used to tell `/` (divide) from `/` (regex). */
  let prevSignificant = '';

  const blank = (from, to) => {
    for (let k = from; k < to && k < stripped.length; k += 1) {
      if (stripped[k] !== '\n') stripped[k] = ' ';
    }
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    // Line comment
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let k = i; k < stop; k += 1) if (text[k] === '\n') line += 1;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Regex literal. Only where a value cannot already have ended — otherwise
    // `a / b` would be read as the start of one.
    if (c === '/' && !'})]abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$'.includes(prevSignificant)) {
      let k = i + 1;
      let inClass = false;
      let closed = false;
      while (k < text.length) {
        const r = text[k];
        if (r === '\\') {
          k += 2;
          continue;
        }
        if (r === '\n') break;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) {
          closed = true;
          k += 1;
          break;
        }
        k += 1;
      }
      if (closed) {
        blank(i, k);
        i = k;
        prevSignificant = '/';
        continue;
      }
      // Not a regex after all; fall through and treat as an operator.
    }

    // String / template literal
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const startLine = line;
      let k = i + 1;
      let value = '';
      while (k < text.length) {
        const r = text[k];
        if (r === '\\') {
          value += text[k + 1] ?? '';
          k += 2;
          continue;
        }
        if (r === quote) break;
        if (r === '\n') {
          if (quote !== '`') break; // unterminated — bail rather than run away
          line += 1;
        }
        value += r;
        k += 1;
      }
      literals.push({ line: startLine, value });
      blank(i + 1, k);
      i = Math.min(k + 1, text.length);
      prevSignificant = quote;
      continue;
    }

    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  return { literals, strippedLines: stripped.join('').split('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────────────────────────────────────

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      listFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const findings = [];
function report(file, line, ruleId, message, text) {
  findings.push({ file, line, ruleId, message, text });
}

/** True when the line, or the one above it, carries an explained escape. */
function isSuppressed(lines, line) {
  const here = lines[line - 1] ?? '';
  const above = lines[line - 2] ?? '';
  return ESCAPE.test(here) || ESCAPE.test(above);
}

function isUserFacingFile(relative) {
  if (USER_FACING_FILES.includes(relative)) return true;
  return USER_FACING_PREFIXES.some((prefix) => relative.startsWith(prefix + path.sep));
}

function checkWording(file, line, value, rawLines) {
  if (!value || value.length < 3) return;
  if (isSuppressed(rawLines, line)) return;
  for (const rule of WORDING_RULES) {
    if (rule.test(value)) {
      report(file, line, rule.id, rule.message, value.trim().slice(0, 120));
    }
  }
}

/**
 * `{ en: '…', hi: '…' }` pairs — the inline translation convention. Located on
 * the ORIGINAL text (not the stripped copy) so the literal values survive, and
 * matched loosely enough to cover both one-line and wrapped forms.
 */
const LOCAL_STRING_PAIR = /\b(en|hi)\s*:\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;

for (const absolute of listFiles(SRC_DIR)) {
  const relative = path.relative(ROOT, absolute);
  if (/\.test\.tsx?$/.test(relative)) continue;

  const text = fs.readFileSync(absolute, 'utf8');
  const rawLines = text.split('\n');
  const { literals, strippedLines } = tokenize(text);

  // ── wording, on user-facing files ──────────────────────────────────────────
  if (isUserFacingFile(relative)) {
    for (const literal of literals) checkWording(relative, literal.line, literal.value, rawLines);
  } else {
    // ── wording, on the inline `en:`/`hi:` convention anywhere else ──────────
    for (const match of text.matchAll(LOCAL_STRING_PAIR)) {
      const line = text.slice(0, match.index).split('\n').length;
      checkWording(relative, line, match[3], rawLines);
    }
  }

  // ── thresholds, everywhere ────────────────────────────────────────────────
  if (THRESHOLD_EXEMPT_FILES.includes(relative)) continue;
  strippedLines.forEach((codeLine, index) => {
    const line = index + 1;
    if (!codeLine.trim()) return;
    if (INSTRUMENT_BOUND_LINE.test(codeLine)) return;
    if (isSuppressed(rawLines, line)) return;

    const identifierMatch = THRESHOLD_IDENTIFIER.exec(codeLine);
    if (identifierMatch) {
      report(
        relative,
        line,
        'hardcoded-threshold',
        'a clinical threshold baked into the app. Targets ship blank and are entered by a ' +
          'named human (target_range.set_by_label), so the chart legend can say whose ' +
          'number it is and when they set it.',
        (rawLines[index] ?? '').trim().slice(0, 120),
      );
      return;
    }

    if (CLINICAL_QUANTITY.test(codeLine) && comparesAgainstThreshold(codeLine)) {
      report(
        relative,
        line,
        'hardcoded-threshold',
        'a clinical quantity compared against a hardcoded number. If this is an instrument ' +
          'limit, express it as min/max in metric_def. If it is a clinical judgement, it ' +
          'belongs in target_range, entered by a human.',
        (rawLines[index] ?? '').trim().slice(0, 120),
      );
    }
  });
}

// ── i18n bundles ─────────────────────────────────────────────────────────────

function flatten(tree, prefix = '', out = []) {
  for (const [key, value] of Object.entries(tree)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') flatten(value, dotted, out);
    else out.push([dotted, String(value)]);
  }
  return out;
}

for (const bundle of ['en', 'hi']) {
  const file = path.join('src', 'i18n', `${bundle}.json`);
  const absolute = path.join(ROOT, file);
  const raw = fs.readFileSync(absolute, 'utf8');
  const rawLines = raw.split('\n');
  const parsed = JSON.parse(raw);

  for (const [key, value] of flatten(parsed)) {
    for (const rule of WORDING_RULES) {
      if (!rule.test(value)) continue;
      // Locate the leaf so the finding carries a real line number.
      const leaf = key.split('.').pop();
      const index = rawLines.findIndex((l) => l.includes(`"${leaf}"`) && l.includes(value.slice(0, 20)));
      const line = index === -1 ? 1 : index + 1;
      if (isSuppressed(rawLines, line)) continue;
      report(file, line, rule.id, rule.message, `${key} = ${value.slice(0, 100)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log('clinical language');
  console.log('  ✓ no banned wording, verdict, threshold or advice on a user-facing surface');
  process.exit(0);
}

console.error('clinical language — FAILED\n');
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    [${f.ruleId}] ${f.message}`);
  console.error(`    → ${f.text}`);
  console.error('');
}
console.error(
  `${findings.length} finding${findings.length === 1 ? '' : 's'}.\n` +
    'If one is genuinely fine, put `// clinical-language-ok: <reason>` on that line\n' +
    'or the line above it. The reason is not optional.',
);
process.exit(1);
