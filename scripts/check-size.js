#!/usr/bin/env node
/**
 * APK size budget.  `node scripts/check-size.js [artifact.apk] [--budget=MB]`
 *
 * Called automatically at the end of scripts/build-android.sh, and runnable on
 * its own against any artifact in build-output/.
 *
 * WHY A BUDGET AND NOT JUST A NUMBER IN A REPORT
 * ──────────────────────────────────────────────
 * Nobody ever decides to make an app big. It happens one convenient dependency
 * at a time, each of which adds two megabytes that nobody notices, until the
 * install is a 60 MB download for a person on a metered connection with a
 * phone that has 900 MB free. A budget does not stop the app growing — it makes
 * growth a decision somebody made, on a specific day, by editing the number
 * below and saying why in docs/SIZE.md.
 *
 * The budget is stated in DOWNLOAD terms: the size of the .apk file on disk,
 * which is what the person copying it onto a phone actually deals with.
 *
 * See docs/SIZE.md for the levers that hold this number down and for the
 * measured baseline.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * THE BUDGET.
 *
 * 32 MB. Raise it only with a line in docs/SIZE.md saying what was added and
 * why it was worth it.
 *
 * The number is set where it is because of what the app already is: React
 * Native 0.81 + Hermes + the Expo modules + expo-sqlite + react-native-svg,
 * built arm64-only, minified by R8 with resource shrinking. Roughly two thirds
 * of the payload is native libraries that come with that stack and cannot be
 * removed; the remaining third is the Hermes bytecode bundle and resources,
 * which is the part that actually moves when a dependency is added.
 */
const BUDGET_MB = 32;

/** Warn — do not fail — once the artifact is within this fraction of budget. */
const WARN_AT = 0.9;

// ── arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const budgetArg = args.find((a) => a.startsWith('--budget='));
const budgetMb = budgetArg ? Number(budgetArg.slice('--budget='.length)) : BUDGET_MB;
const positional = args.filter((a) => !a.startsWith('--'));

function newestArtifact() {
  const dir = path.join(ROOT, 'build-output');
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.apk'))
    .map((name) => ({ name, full: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full ?? null;
}

const artifact = positional[0] ? path.resolve(process.cwd(), positional[0]) : newestArtifact();

if (!artifact) {
  console.error('size budget: no artifact given and nothing in build-output/*.apk.');
  console.error('             usage: node scripts/check-size.js <artifact.apk> [--budget=MB]');
  process.exit(2);
}
if (!fs.existsSync(artifact)) {
  console.error(`size budget: no such file: ${artifact}`);
  process.exit(2);
}

// ── measure ──────────────────────────────────────────────────────────────────

const bytes = fs.statSync(artifact).size;
const budgetBytes = budgetMb * 1048576;

/**
 * Uncompressed sizes per top-level group, read from the zip directory.
 *
 * Uncompressed, deliberately: it is what actually lands on the device, and it
 * is the number that tells you WHICH thing grew. The pass/fail above is on the
 * compressed file, because that is what a person downloads.
 */
function groupSizes() {
  let listing;
  try {
    listing = execFileSync('unzip', ['-l', artifact], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }

  const groups = new Map();
  const entries = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const size = Number(match[1]);
    const entryPath = match[2];
    if (!entryPath || entryPath === 'Name') continue;
    // Directory entries are zero-byte bookkeeping. Counting them adds a phantom
    // `lib/` group with no architecture, which then reads as "two architectures
    // shipped" and turns the arch warning into noise.
    if (entryPath.endsWith('/')) continue;

    entries.push({ size, path: entryPath });

    const parts = entryPath.split('/');
    let group = parts.length > 1 ? `${parts[0]}/` : '(root)';
    // Split lib/ by architecture — that is the interesting axis.
    if (parts[0] === 'lib' && parts.length > 2) group = `lib/${parts[1]}/`;
    groups.set(group, (groups.get(group) ?? 0) + size);
  }
  return { groups: [...groups].sort((a, b) => b[1] - a[1]), entries: entries.sort((a, b) => b.size - a.size) };
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

const relative = path.relative(ROOT, artifact);
const shown = relative.startsWith('..') ? artifact : relative;

console.log('size budget');
console.log(`  artifact  ${shown}`);
console.log(`  size      ${mb(bytes)}   (budget ${budgetMb} MB)`);

const breakdown = groupSizes();
if (breakdown) {
  console.log('\n  uncompressed contents, by group:');
  for (const [group, size] of breakdown.groups.slice(0, 8)) {
    console.log(`    ${mb(size).padStart(9)}  ${group}`);
  }
  console.log('\n  largest single entries:');
  for (const entry of breakdown.entries.slice(0, 8)) {
    console.log(`    ${mb(entry.size).padStart(9)}  ${entry.path}`);
  }

  // A second architecture is the single biggest way this budget gets blown, and
  // it is silent — the app works perfectly, it is just twice the size.
  const archs = breakdown.groups
    .map(([group]) => group)
    .filter((group) => group.startsWith('lib/'))
    .map((group) => group.slice(4).replace(/\/$/, ''));
  if (archs.length > 1) {
    console.log(`\n  ⚠ ${archs.length} native architectures shipped: ${archs.join(', ')}`);
    console.log('    arm64-v8a alone is the intended configuration — see docs/SIZE.md.');
  }
} else {
  console.log('  (unzip unavailable — reporting file size only)');
}

if (bytes > budgetBytes) {
  console.error(
    `\n✗ over budget by ${mb(bytes - budgetBytes)}.\n` +
      '  This is not a "bump the number" moment by default. Check first:\n' +
      '    • is lib/ carrying more than arm64-v8a?\n' +
      '    • did R8 minification / resource shrinking actually run? (release only)\n' +
      '    • what appeared in the largest-entries list that was not there before?\n' +
      '  If the growth is genuinely worth it, raise BUDGET_MB in this file AND\n' +
      '  record what was added, and why, in docs/SIZE.md.',
  );
  process.exit(1);
}

if (bytes > budgetBytes * WARN_AT) {
  console.log(
    `\n⚠ within ${Math.round((1 - WARN_AT) * 100)}% of the ${budgetMb} MB budget ` +
      `(${mb(budgetBytes - bytes)} of headroom left).`,
  );
} else {
  console.log(`\n✓ under budget — ${mb(budgetBytes - bytes)} of headroom.`);
}
process.exit(0);
