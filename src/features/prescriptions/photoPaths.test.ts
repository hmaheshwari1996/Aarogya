/**
 * Tests for the prescription photo-store's URI arithmetic.
 *
 * The consequence here is asymmetric, which is why these cases lean the way they do. A
 * wrong `keep` costs nothing worse than a broken thumbnail on one screen. A wrong `lost`
 * costs a photograph of a prescription in an app that has no server, no cloud backup and
 * therefore no second copy of it anywhere in the world — so every case below that ends in
 * `lost` is there to prove the planner reached it only after trying everything else, and
 * every case that ends in a rewrite is there to prove the planner never invents, drops or
 * reorders a page while doing it.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy — same trick as
 * `features/prescriptions/frequency.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './photoPaths.ts';
const {
  directoryUri,
  fileNameOf,
  isUnder,
  photoExtension,
  planPage,
  planPages,
  planIsNoop,
} = (await import(MODULE)) as typeof import('./photoPaths');

type Probe = import('./photoPaths').PageProbe;

/** The store as it is on THIS install. */
const STORE = 'file:///data/user/0/in.aarogya.care/files/prescriptions/';
/** The picker's cache directory, which is where every URI used to come from. */
const CACHE = 'file:///data/user/0/in.aarogya.care/cache/ImagePicker/';
/** The same app's files directory on the phone the capsule was made on. */
const OLD_STORE = 'file:///data/user/0/in.aarogya.care.old/files/prescriptions/';

/**
 * A phone, described in one object.
 *
 * `present` is what is on the disk; `inStore` is what is in the store directory by name.
 * Nothing here touches a filesystem, which is the entire reason the planner is a separate
 * module from `photoStore.ts`.
 */
function phone(options: { present?: string[]; inStore?: string[] } = {}): Probe {
  const present = new Set(options.present ?? []);
  const inStore = new Set(options.inStore ?? []);
  return {
    isStored: (uri) => isUnder(uri, STORE),
    exists: (uri) => present.has(uri),
    storedNamed: (name) => (inStore.has(name) ? `${STORE}${name}` : null),
  };
}

// ── directoryUri ─────────────────────────────────────────────────────────────

test('a directory URI has exactly one trailing slash, whatever the root had', () => {
  assert.equal(directoryUri('file:///files/', 'prescriptions'), 'file:///files/prescriptions/');
  assert.equal(directoryUri('file:///files', 'prescriptions'), 'file:///files/prescriptions/');
  assert.equal(directoryUri('file:///files///', 'prescriptions'), 'file:///files/prescriptions/');
});

test('the prefix test does not match a sibling directory with the same first letters', () => {
  const prefix = directoryUri('file:///files', 'prescriptions');
  assert.equal(isUnder(`${prefix}a.jpg`, prefix), true);
  assert.equal(isUnder('file:///files/prescriptions-old/a.jpg', prefix), false);
  assert.equal(isUnder('file:///files/labs/a.jpg', prefix), false);
});

// ── fileNameOf ───────────────────────────────────────────────────────────────

test('the file name is the last segment, percent-decoded, without a query', () => {
  assert.equal(fileNameOf(`${STORE}9f1c.jpg`), '9f1c.jpg');
  assert.equal(fileNameOf(`${STORE}9f1c.jpg?ts=12`), '9f1c.jpg');
  assert.equal(fileNameOf('file:///a/b/%39f1c.jpg'), '9f1c.jpg');
});

test('a URI with no last segment has no name', () => {
  assert.equal(fileNameOf(''), null);
  assert.equal(fileNameOf('file:///a/b/'), null);
});

test('a malformed escape sequence still yields the raw segment', () => {
  // decodeURIComponent throws on a lone '%'. The raw segment still compares equal to
  // another raw segment, which is all the name lookup needs.
  assert.equal(fileNameOf('file:///a/100%.jpg'), '100%.jpg');
});

// ── photoExtension ───────────────────────────────────────────────────────────

test('the source extension is kept, lower-cased', () => {
  assert.equal(photoExtension('.JPEG'), '.jpeg');
  assert.equal(photoExtension('.heic'), '.heic');
  assert.equal(photoExtension('.png'), '.png');
});

test('a missing or implausible extension falls back to .jpg', () => {
  assert.equal(photoExtension(''), '.jpg');
  assert.equal(photoExtension('.'), '.jpg');
  assert.equal(photoExtension('.thisisnotanextension'), '.jpg');
  assert.equal(photoExtension('jpg'), '.jpg');
});

// ── The four decisions ───────────────────────────────────────────────────────

test('a photo already in the store, with its bytes, is left alone', () => {
  const uri = `${STORE}9f1c.jpg`;
  assert.deepEqual(planPage(uri, phone({ present: [uri] })), { action: 'keep', uri });
});

test('a cache photo whose bytes are still there is copied in', () => {
  const uri = `${CACHE}abcd.jpeg`;
  assert.deepEqual(planPage(uri, phone({ present: [uri] })), { action: 'copy', uri });
});

test('a page from a previous install is re-pointed at the file already in the store', () => {
  const uri = `${OLD_STORE}9f1c.jpg`;
  const plan = planPage(uri, phone({ inStore: ['9f1c.jpg'] }));
  assert.deepEqual(plan, { action: 'repoint', uri, to: `${STORE}9f1c.jpg` });
});

test('a cache photo Android already purged is lost, not silently dropped', () => {
  const uri = `${CACHE}abcd.jpeg`;
  assert.deepEqual(planPage(uri, phone()), { action: 'lost', uri });
});

test('a stored photo whose file has gone is lost, and is NOT re-pointed at itself', () => {
  // The name IS in the store index in this case — it is the same file — so a planner that
  // asked the name question first would hand back the URI it already knows is dead and
  // report a repair that did not happen.
  const uri = `${STORE}9f1c.jpg`;
  assert.deepEqual(planPage(uri, phone({ inStore: ['9f1c.jpg'] })), { action: 'lost', uri });
});

test('a blank URI is lost rather than removed from the list', () => {
  assert.deepEqual(planPage('   ', phone()), { action: 'lost', uri: '   ' });
});

// ── The list as a whole ──────────────────────────────────────────────────────

test('a mixed prescription is planned page by page, in order, with nothing dropped', () => {
  const kept = `${STORE}p1.jpg`;
  const cached = `${CACHE}p2.jpeg`;
  const restored = `${OLD_STORE}p3.jpg`;
  const gone = `${CACHE}p4.jpeg`;

  const plans = planPages(
    [kept, cached, restored, gone],
    phone({ present: [kept, cached], inStore: ['p1.jpg', 'p3.jpg'] }),
  );

  assert.equal(plans.length, 4, 'the plan must have exactly one entry per page');
  assert.deepEqual(
    plans.map((plan) => plan.action),
    ['keep', 'copy', 'repoint', 'lost'],
  );
  assert.deepEqual(
    plans.map((plan) => plan.uri),
    [kept, cached, restored, gone],
    'the original URI travels with every plan, in the original order',
  );
});

test('a prescription that needs nothing done is recognised as needing nothing done', () => {
  const first = `${STORE}p1.jpg`;
  const second = `${STORE}p2.jpg`;
  const plans = planPages([first, second], phone({ present: [first, second] }));
  assert.equal(planIsNoop(plans), true);
});

test('a page that resolves nowhere still counts as nothing to do — the row is left alone', () => {
  // `lost` must not trigger a rewrite: blanking the column would destroy the only record
  // that a photograph was ever attached to this prescription.
  const plans = planPages([`${CACHE}gone.jpeg`], phone());
  assert.equal(planIsNoop(plans), true);
});

test('one page needing a copy is enough to make the prescription need a rewrite', () => {
  const plans = planPages(
    [`${STORE}p1.jpg`, `${CACHE}p2.jpeg`],
    phone({ present: [`${STORE}p1.jpg`, `${CACHE}p2.jpeg`] }),
  );
  assert.equal(planIsNoop(plans), false);
});
