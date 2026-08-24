/**
 * Tests for the adherence block on the doctor's page.
 *
 * This is the one piece of the report that can change a person's treatment by being
 * wrong. `summariseAdherence` decides WHETHER a percentage may be published and is tested
 * in `src/features/adherence/adherence.test.ts`; these tests cover the other half — that
 * a suppressed summary actually renders as its reason and never as a number, that the
 * three-way split is always three-way, and that the forbidden word never appears.
 *
 * Same dynamic-import shape as the adherence tests, and for the same reason: Node's
 * type-stripping loader wants a fully-specified './x.ts', and the tsconfig does not enable
 * `allowImportingTsExtensions`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './adherenceSection.ts';
const { renderAdherenceSection, adherenceHeadline, suppressionText, NO_RECORD_PHRASE } = (await import(
  MODULE
)) as typeof import('./adherenceSection');

type AdherenceSummary = import('../../../types').AdherenceSummary;

const DISCLAIMER = 'Self-reported in app. Records interaction with the app, not medication taken.';

function summary(overrides: Partial<AdherenceSummary> = {}): AdherenceSummary {
  return {
    windowDays: 7,
    due: 14,
    recordedTaken: 12,
    recordedNotTaken: 1,
    noRecord: 1,
    percent: 86,
    suppressedReason: null,
    longestNoRecordRun: 1,
    ...overrides,
  };
}

/** A suppressed week: 2–4 August silent, exactly what `summariseAdherence` produces. */
function suppressed(): AdherenceSummary {
  return summary({
    due: 14,
    recordedTaken: 8,
    recordedNotTaken: 0,
    noRecord: 6,
    percent: null,
    suppressedReason: 'Records incomplete for 3 days (2–4 Aug)',
    longestNoRecordRun: 3,
  });
}

/** Only the visible words. Style attributes carry percentage widths that are not text. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

function render(primary: AdherenceSummary, windows: { label: string; summary: AdherenceSummary }[] = []): string {
  return renderAdherenceSection({
    primary: { label: 'Selected period — 3 Aug 2026 to 9 Aug 2026', summary: primary },
    windows,
    disclaimer: DISCLAIMER,
  });
}

// ── Suppression ──────────────────────────────────────────────────────────────

test('a suppressed summary prints the reason where the number would have been', () => {
  const html = render(suppressed());
  assert.ok(html.includes('Records incomplete for 3 days (2–4 Aug)'));
});

test('a suppressed summary prints NO percentage anywhere a reader can see it', () => {
  // THE CASE THIS WHOLE MODULE EXISTS FOR. A physician reading "57%" over a three-day
  // hole in a TB patient's record may escalate to directly-observed therapy over an
  // artefact the app manufactured.
  const text = visibleText(render(suppressed()));
  assert.doesNotMatch(text, /\d+\s*%/);
});

test('a suppressed summary says why, in the reader\'s language rather than the app\'s', () => {
  const text = visibleText(render(suppressed()));
  assert.match(text, /missing information/i);
  assert.match(text, /No percentage is shown/i);
});

test('the counts are still published when the percentage is not', () => {
  // Suppression withholds the derived figure, not the record. The doctor still sees
  // exactly how many doses were recorded each way.
  const html = render(suppressed());
  assert.ok(html.includes('>8<'), 'recorded taken count missing');
  assert.ok(html.includes('>6<'), 'no-record count missing');
  assert.ok(html.includes('>14<'), 'scheduled count missing');
});

test('a summary with nothing due says so rather than showing zero per cent', () => {
  const html = render(
    summary({
      due: 0,
      recordedTaken: 0,
      recordedNotTaken: 0,
      noRecord: 0,
      percent: null,
      suppressedReason: 'No scheduled doses in this period.',
      longestNoRecordRun: 0,
    }),
  );
  assert.ok(html.includes('No scheduled doses in this period.'));
  assert.doesNotMatch(visibleText(html), /\d+\s*%/);
});

test('a summary that suppresses without saying why still refuses to print a number', () => {
  const html = render(summary({ percent: null, suppressedReason: null }));
  assert.doesNotMatch(visibleText(html), /\d+\s*%/);
  assert.match(visibleText(html), /not complete enough/i);
});

test('suppressionText is the summary\'s own sentence, trimmed', () => {
  assert.equal(suppressionText(suppressed()), 'Records incomplete for 3 days (2–4 Aug)');
});

// ── The three-way split ──────────────────────────────────────────────────────

test('the split is always three segments, never two', () => {
  const html = render(summary());
  assert.ok(html.includes('adh-seg--taken'));
  assert.ok(html.includes('adh-seg--not-taken'));
  assert.ok(html.includes('adh-seg--no-record'));
});

test('every segment is named in words as well as drawn', () => {
  // The bar can be lost to a monochrome photocopier or to a print engine that drops
  // backgrounds. The words cannot.
  const text = visibleText(render(summary()));
  assert.match(text, /Recorded as taken/);
  assert.match(text, /Recorded as not taken/);
  assert.match(text, /No record either way/);
});

test('the no-record bucket carries the required phrase', () => {
  assert.equal(NO_RECORD_PHRASE, 'not recorded as taken');
  assert.ok(visibleText(render(summary())).includes('not recorded as taken'));
});

test('the three buckets shown add up to the scheduled total', () => {
  const s = summary({ due: 10, recordedTaken: 6, recordedNotTaken: 2, noRecord: 2, percent: 60 });
  const text = visibleText(render(s));
  assert.match(text, /Recorded as taken: 6/);
  assert.match(text, /Recorded as not taken: 2/);
  assert.match(text, /No record either way \(not recorded as taken\): 2/);
  assert.match(text, /Scheduled doses counted: 10/);
});

// ── The published figure ─────────────────────────────────────────────────────

test('a published percentage always carries its denominator', () => {
  // "86%" alone is unreadable: 86% of six doses and 86% of six hundred are different
  // claims, and only one of them is worth changing a regimen over.
  assert.equal(
    adherenceHeadline(summary()),
    '12 of 14 scheduled doses recorded as taken (86%)',
  );
  assert.ok(visibleText(render(summary())).includes('12 of 14 scheduled doses recorded as taken (86%)'));
});

test('the headline of a suppressed summary is the reason, not a number', () => {
  assert.equal(adherenceHeadline(suppressed()), 'Records incomplete for 3 days (2–4 Aug)');
});

test('the longest silent run is reported even when a percentage is published', () => {
  const text = visibleText(render(summary({ longestNoRecordRun: 2 })));
  assert.match(text, /Longest run of days with no entry either way: 2 days/);
});

// ── Language ─────────────────────────────────────────────────────────────────

test('the word "missed" never appears', () => {
  const outputs = [render(summary()), render(suppressed()), render(summary({ due: 0, percent: null }))];
  for (const html of outputs) assert.doesNotMatch(html, /\bmissed\b/i);
});

test('no other accusation appears either', () => {
  const html = render(suppressed());
  assert.doesNotMatch(html, /non-?compliant|non-?adherent|failed to take|forgot/i);
});

test('no badge, streak or other gamification reaches a doctor-facing surface', () => {
  // `streak_state` and `badge` exist to keep a patient going. On a clinical page they
  // would turn a private encouragement into a performance review held in front of her
  // physician.
  const html = render(summary());
  assert.doesNotMatch(html, /badge|streak|award|congratulat|well done|keep it up/i);
});

// ── The disclaimer ───────────────────────────────────────────────────────────

test('the disclaimer is printed verbatim, every time', () => {
  for (const s of [summary(), suppressed()]) {
    assert.ok(render(s).includes(DISCLAIMER));
  }
});

test('a blank disclaimer is fatal rather than silently omitted', () => {
  // A number on this page without the sentence that says what the number is worth is
  // exactly the artefact the whole feature exists to avoid.
  assert.throws(
    () =>
      renderAdherenceSection({
        primary: { label: 'Last 7 days', summary: summary() },
        windows: [],
        disclaimer: '   ',
      }),
    /disclaimer is required/,
  );
});

test('away days are explained, so a hospital stay does not read as a gap in effort', () => {
  assert.match(visibleText(render(summary())), /recorded as away/i);
});

// ── Secondary windows ────────────────────────────────────────────────────────

test('a secondary window that is suppressed shows a dash and its reason, not a number', () => {
  const html = render(summary(), [
    { label: 'Last 7 days', summary: suppressed() },
    { label: 'Last 30 days', summary: summary({ percent: 91 }) },
  ]);
  assert.ok(html.includes('Records incomplete for 3 days (2–4 Aug)'));
  assert.ok(html.includes('91%'));
  // The suppressed row's figure cell is an em dash.
  assert.match(html, /<td class="num">—<\/td>/);
});

test('the period the headline covers is always stated next to it', () => {
  assert.ok(visibleText(render(summary())).includes('Selected period — 3 Aug 2026 to 9 Aug 2026'));
});
