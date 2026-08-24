/**
 * The one property that must not break as languages become drop-in data: an optional
 * language renders English where it has no translation, never a raw key path.
 *
 * Pins `resolve.ts` only — the pure module `index.ts` delegates to. `index.ts` and
 * `languages.ts` import JSON and a native module and cannot load under `node --test`, which
 * is exactly why the resolution logic was split out to here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same dance as registry.test.ts: the `.ts` extension node needs lives in a variable so tsc
// does not reject it (TS5097), and the types come in extension-free via `typeof import(...)`.
const MODULE = './resolve.ts';
const { lookup, resolveKey } = (await import(MODULE)) as typeof import('./resolve');
type TranslationTree = import('./resolve').TranslationTree;

const RESOURCES: Record<string, TranslationTree> = {
  en: { common: { continue: 'Continue' }, greeting: 'Hello' },
  hi: { common: { continue: 'जारी रखें' }, greeting: 'नमस्ते' },
  // An optional bundle with ONE key translated and the rest empty — the real shape a
  // half-translated Indian language ships in.
  bn: { greeting: 'হ্যালো' },
};

test('a translated key resolves in its own language', () => {
  assert.equal(resolveKey(RESOURCES, 'hi', 'common.continue'), 'जारी रखें');
  assert.equal(resolveKey(RESOURCES, 'bn', 'greeting'), 'হ্যালো');
});

test('an untranslated key in an optional language falls back to English', () => {
  // The load-bearing case: Bengali has no `common.continue`, so it renders the English word,
  // NOT the dotted path. This is what makes an empty optional bundle safe to ship.
  assert.equal(resolveKey(RESOURCES, 'bn', 'common.continue'), 'Continue');
});

test('a key missing in BOTH the language and English is undefined (caller shows the key)', () => {
  assert.equal(resolveKey(RESOURCES, 'bn', 'nope.missing'), undefined);
  assert.equal(resolveKey(RESOURCES, 'hi', 'nope.missing'), undefined);
});

test('English never self-falls-back: a missing English key is undefined, not a loop', () => {
  assert.equal(resolveKey(RESOURCES, 'en', 'nope.missing'), undefined);
});

test('an unknown language code resolves straight to English', () => {
  // A stale stored preference for a language since removed must degrade to English, not crash.
  assert.equal(resolveKey(RESOURCES, 'zz', 'greeting'), 'Hello');
});

test('lookup walks nested keys and rejects non-leaf / missing paths', () => {
  assert.equal(lookup(RESOURCES.en, 'common.continue'), 'Continue');
  assert.equal(lookup(RESOURCES.en, 'common'), undefined); // a branch, not a string
  assert.equal(lookup(RESOURCES.en, 'common.nope'), undefined);
  assert.equal(lookup(undefined, 'anything'), undefined);
});
