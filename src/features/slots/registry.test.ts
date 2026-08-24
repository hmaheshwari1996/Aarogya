/**
 * Tests for the dose-slot registry.
 *
 * What is actually at stake here: this module decides WHEN a tablet rings and WHAT the
 * chip next to it says. Two failures matter more than the rest and are over-represented
 * below on purpose.
 *
 *  1. AN UPGRADE THAT SILENTLY MOVES A REMINDER. A phone in the field stores four keys.
 *     If the merge does not honour them, midday slides 13:00 → 12:00 and evening
 *     19:00 → 17:00 on a handset whose owner set them deliberately, with no notice.
 *
 *  2. TWO SLOTS ON ONE CLOCK TIME. `dose_schedule` has UNIQUE (thread_id, version,
 *     time_local), so a duplicate is a constraint abort that rolls the whole save back
 *     behind a generic error. Writes must refuse it and name both slots; reads must
 *     tolerate it deterministically, because a read that threw would brick a screen over
 *     a value already on disk.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy — same trick as
 * `features/prescriptions/frequency.test.ts`.
 *
 * The registry's five async functions reach SQLite through a dynamic import INSIDE the
 * function body, so importing the module here touches no native code. Nothing below calls
 * them; everything below is the pure half they are built on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = './registry.ts';
const {
  BUILTIN_SLOT_KEYS,
  DEFAULT_SLOT_TIMES,
  LEGACY_SLOT_KEYS,
  MAX_CUSTOM_SLOTS,
  MAX_CUSTOM_SLOT_LABEL,
  META_SLOT_TIMES_PREFIX,
  SLOT_MINUTE_STEP,
  SLOT_OWN_TIME_KEYS,
  SLOT_STRINGS,
  buildSlotDefinitions,
  defaultNewCustomSlotTime,
  isCustomSlotKey,
  isWallClock,
  joinWallClock,
  mergeSlotTimes,
  newCustomSlotKey,
  parseCustomSlots,
  slotDefForKey,
  slotForRow,
  slotForTime,
  slotI18nKey,
  slotLabel,
  splitWallClock,
  stepWallClock,
  validateCustomSlots,
  validateSlotTimes,
} = (await import(MODULE)) as typeof import('./registry');

type BuiltinSlotKey = import('./registry').BuiltinSlotKey;
type CustomSlot = import('./registry').CustomSlot;
type SlotDefinition = import('./registry').SlotDefinition;
type SlotTimes = Readonly<Record<BuiltinSlotKey, string>>;

/** English `t`, resolving through the same map the app uses. */
const en = (key: string): string => SLOT_STRINGS[key]?.en ?? key;
/** Hindi `t`. Present so "a custom label is identical in both languages" is a real test. */
const hi = (key: string): string => SLOT_STRINGS[key]?.hi ?? key;

function custom(key: string, label: string, time: string): CustomSlot {
  return { key, label, time };
}

function order(defs: readonly SlotDefinition[]): string[] {
  return defs.map((def) => `${def.key}@${def.time}`);
}

// ── The nine built-ins ───────────────────────────────────────────────────────

test('there are nine built-in slots and every one has a default time', () => {
  assert.equal(BUILTIN_SLOT_KEYS.length, 9);
  assert.equal(Object.keys(DEFAULT_SLOT_TIMES).length, 9);
  for (const slot of BUILTIN_SLOT_KEYS) {
    assert.ok(isWallClock(DEFAULT_SLOT_TIMES[slot]), `${slot} default is not HH:MM`);
  }
});

test('the defaults are the times the user asked for', () => {
  assert.deepEqual(DEFAULT_SLOT_TIMES, {
    before_breakfast: '08:00',
    after_breakfast: '08:30',
    midday: '12:00',
    before_lunch: '13:30',
    after_lunch: '14:00',
    evening: '17:00',
    before_dinner: '20:00',
    after_dinner: '20:30',
    bedtime: '22:00',
  });
});

test('no two built-in defaults share a clock time', () => {
  // The whole point of rule 3: two slots on one time is a UNIQUE-constraint abort on save.
  // Shipping defaults that already collide would make that reachable out of the box.
  const times = new Set(Object.values(DEFAULT_SLOT_TIMES));
  assert.equal(times.size, 9);
});

test('the canonical order is strictly increasing in the default times', () => {
  // The canonical order is the CLOCK order. If it ever stops matching the defaults, the
  // tie-break stops meaning "the earlier slot wins" and starts meaning nothing at all.
  let previous = '';
  for (const slot of BUILTIN_SLOT_KEYS) {
    const time = DEFAULT_SLOT_TIMES[slot];
    assert.ok(time > previous, `${slot} (${time}) is not after ${previous}`);
    previous = time;
  }
});

test('the storage key literal has not moved', () => {
  // Change one character and every phone in the field silently reverts to defaults.
  assert.equal(META_SLOT_TIMES_PREFIX, 'slot_times:');
});

// ── Names ────────────────────────────────────────────────────────────────────

test('every built-in and legacy key has both an English and a Hindi name', () => {
  for (const slot of [...BUILTIN_SLOT_KEYS, ...LEGACY_SLOT_KEYS]) {
    const entry = SLOT_STRINGS[slotI18nKey(slot)];
    assert.ok(entry, `${slot} has no strings`);
    assert.ok(entry.en.trim().length > 0, `${slot} has no English name`);
    assert.ok(entry.hi.trim().length > 0, `${slot} has no Hindi name`);
    // Untranslated Hindi is the failure this catches: a Devanagari-free "hi" is either a
    // copy-paste of the English or a transliteration, and both read as broken.
    assert.notEqual(entry.hi, entry.en, `${slot} Hindi is a copy of the English`);
  }
});

test('the English built-in names are all distinct', () => {
  // Nine names get close together. Two chips reading the same word, thirty minutes apart,
  // is the regression this whole change has to avoid.
  const names = BUILTIN_SLOT_KEYS.map((slot) => SLOT_STRINGS[slotI18nKey(slot)]?.en);
  assert.equal(new Set(names).size, 9);
});

test('the Hindi built-in names are all distinct', () => {
  const names = BUILTIN_SLOT_KEYS.map((slot) => SLOT_STRINGS[slotI18nKey(slot)]?.hi);
  assert.equal(new Set(names).size, 9);
});

test('no LIVE Hindi name collides with a retired one', () => {
  // A phone carrying an 'afternoon' schedule row shows a legacy section in the medicines
  // list. If a live slot shares that word, two sections carry one heading and only the
  // clock tells them apart — which is exactly what 'midday' → 'दोपहर' did.
  const live = new Set(BUILTIN_SLOT_KEYS.map((slot) => SLOT_STRINGS[slotI18nKey(slot)]?.hi));
  for (const key of LEGACY_SLOT_KEYS) {
    assert.ok(
      !live.has(SLOT_STRINGS[slotI18nKey(key)]?.hi),
      `retired ${key} shares its Hindi name with a slot that is still offered`,
    );
  }
});

// ── The Hindi before/after pairs ─────────────────────────────────────────────
//
// Hindi is head-final: '<meal> से पहले' / '<meal> के बाद' puts the ONE word that separates
// before from after at the END of a five-word phrase. The two members of a pair are thirty
// minutes apart, so they are ALWAYS adjacent in a time-sorted picker, and the chip renders
// `${label} · ${time}` — at a 1.3x font scale line one read 'दोपहर के खाने' on both chips
// and the deciding word wrapped out of sight. Reading the wrong one moves a TB dose from
// before food to after it. The two tests below pin the fix so a future rewording cannot
// quietly put the meal back in front; see the long note in `SLOT_STRINGS`.

/** The before/after pairs, by built-in key. The only slots that can be confused this way. */
const HINDI_PAIRS: readonly (readonly [string, string])[] = [
  ['before_breakfast', 'after_breakfast'],
  ['before_lunch', 'after_lunch'],
  ['before_dinner', 'after_dinner'],
];

/**
 * How many leading code units two strings share.
 *
 * Code units, not rendered width: a Devanagari matra is its own code point, so this counts
 * conservatively HIGH for Devanagari (नाश्ते is six units and four glyph clusters). A
 * conservative count is the right direction for a threshold that says "diverge by HERE".
 */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * The divergence budget. Roughly the first two short Devanagari words — comfortably inside
 * the first rendered line of a chip at her font scale, which is the whole point.
 */
const HINDI_PAIR_DIVERGENCE_LIMIT = 12;

test('the Hindi names in a before/after pair diverge early, not at the last word', () => {
  for (const [before, after] of HINDI_PAIRS) {
    const a = SLOT_STRINGS[`slots.${before}`]?.hi;
    const b = SLOT_STRINGS[`slots.${after}`]?.hi;
    assert.ok(a && b, `${before}/${after} is missing a Hindi name`);
    const shared = sharedPrefix(a, b);
    assert.ok(
      shared < HINDI_PAIR_DIVERGENCE_LIMIT,
      `${before} ("${a}") and ${after} ("${b}") share their first ${shared} characters. ` +
        'These two chips sit next to each other in every picker, so the word that tells ' +
        'them apart has to be reachable before the line wraps.',
    );
  }
});

/**
 * A cap on the label alone, chosen so `label · HH:MM` still fits one line on a 360dp phone
 * at a 1.3x font scale. Where a narrower phone does force a wrap, the four restructured
 * names break at their comma, which leaves the whole discriminator on line one.
 */
const HINDI_LABEL_MAX = 20;

test('no Hindi built-in name is long enough to wrap the discriminator out of sight', () => {
  for (const slot of BUILTIN_SLOT_KEYS) {
    const name = SLOT_STRINGS[slotI18nKey(slot)]?.hi;
    assert.ok(name);
    assert.ok(
      name.length <= HINDI_LABEL_MAX,
      `${slot} Hindi name "${name}" is ${name.length} characters; the cap is ${HINDI_LABEL_MAX}`,
    );
  }
});

test('the shared "where these times come from" sentence exists in both languages', () => {
  // Two screens describe this mechanism and they must not drift: one of them used to
  // promise that changing a slot time moves every existing reminder, which is false —
  // dose_schedule is append-only and reconcile never reads a slot time.
  const entry = SLOT_STRINGS['slots.settingsNote'];
  assert.ok(entry, 'the shared sentence is missing');
  assert.ok(entry.en.trim().length > 0 && entry.hi.trim().length > 0);
  assert.notEqual(entry.hi, entry.en);
});

test('a built-in label is translated; a custom label is not', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, [custom('custom:0011aabb', 'Chai time', '16:00')]);
  const builtin = defs.find((def) => def.key === 'after_lunch');
  const mine = defs.find((def) => def.key === 'custom:0011aabb');
  assert.ok(builtin && mine);

  assert.equal(slotLabel(builtin, en), 'After lunch');
  // Discriminator first, meal last — see the finding-12 note in SLOT_STRINGS. Pinned as a
  // literal on purpose: this is the one string in the file whose exact shape was the bug.
  assert.equal(slotLabel(builtin, hi), 'खाने के बाद, दोपहर');

  // The user's own words, byte-identical in both languages. It is not a key and must
  // never be routed through the bundle.
  assert.equal(slotLabel(mine, en), 'Chai time');
  assert.equal(slotLabel(mine, hi), 'Chai time');
});

// ── Merging stored times ─────────────────────────────────────────────────────

test('nothing stored gives the nine defaults', () => {
  assert.deepEqual(mergeSlotTimes(null), DEFAULT_SLOT_TIMES);
  assert.deepEqual(mergeSlotTimes(undefined), DEFAULT_SLOT_TIMES);
});

test('a malformed blob degrades to defaults instead of throwing', () => {
  // getMetaJson already turns unparseable text into null, so what arrives here is any
  // valid JSON at all — including the shapes below.
  for (const junk of ['nonsense', 42, [], true, { midday: 13 }, { midday: null }]) {
    assert.deepEqual(mergeSlotTimes(junk), DEFAULT_SLOT_TIMES);
  }
});

test('a malformed time falls back to that slot default and leaves the rest alone', () => {
  // Kotlin parses time_local strictly and would drop the rule outright, so a corrupt
  // character must not reach an alarm — it must become the default and stay visible.
  const merged = mergeSlotTimes({ midday: '25:00', evening: '18:15', bedtime: '9:00' });
  assert.equal(merged.midday, DEFAULT_SLOT_TIMES.midday);
  assert.equal(merged.bedtime, DEFAULT_SLOT_TIMES.bedtime, 'H:MM is not HH:MM');
  assert.equal(merged.evening, '18:15');
});

test('a partial blob overrides only the keys it carries', () => {
  const merged = mergeSlotTimes({ evening: '18:00' });
  assert.equal(merged.evening, '18:00');
  assert.equal(merged.before_breakfast, '08:00');
  assert.equal(merged.midday, '12:00');
});

test('unknown keys in the stored blob are ignored', () => {
  const merged = mergeSlotTimes({ brunch: '10:00', midday: '11:45' });
  assert.equal(merged.midday, '11:45');
  assert.equal(Object.keys(merged).length, 9);
});

// ── Backward compatibility with the shipped four-slot build ──────────────────

test('a blob holding ONLY the old four keys keeps all four configured times', () => {
  // THE UPGRADE CASE. This phone is in someone's hand today. midday and evening are the
  // dangerous pair: their DEFAULTS moved, so a merge that ignored storage would move a
  // reminder by an hour or two with no notice.
  const merged = mergeSlotTimes({
    morning: '06:30',
    midday: '13:00',
    evening: '19:00',
    bedtime: '21:45',
  });
  assert.equal(merged.midday, '13:00', 'the old midday must survive the default moving to 12:00');
  assert.equal(merged.evening, '19:00', 'the old evening must survive the default moving to 17:00');
  assert.equal(merged.bedtime, '21:45');

  // 'morning' is the one retired key with no successor — it split into before/after
  // breakfast. Adopting it as before_breakfast is what keeps her 06:30 dose named, and
  // keeps the one setup step the wizard will not let her skip from being thrown away.
  assert.equal(merged.before_breakfast, '06:30');
  assert.equal(merged.after_breakfast, '08:30', 'the new sibling still takes its default');
});

test('a stored before_breakfast beats a retired morning', () => {
  const merged = mergeSlotTimes({ morning: '06:30', before_breakfast: '07:15' });
  assert.equal(merged.before_breakfast, '07:15');
});

test('a retired morning is NOT adopted when it would collide with another built-in', () => {
  // Adoption must never manufacture the duplicate that rule 3 exists to prevent. 08:30 is
  // already after_breakfast's default, and after_breakfast will name that time anyway, so
  // nothing is lost by declining.
  const merged = mergeSlotTimes({ morning: '08:30' });
  assert.equal(merged.before_breakfast, '08:00');
  assert.equal(merged.after_breakfast, '08:30');
});

test('a malformed morning is not adopted', () => {
  assert.equal(mergeSlotTimes({ morning: 'half past six' }).before_breakfast, '08:00');
});

/**
 * Every blob an upgrading phone can plausibly be holding, merged, must be SAVEABLE.
 *
 * This is the gap that let a real defect through. The tests above pin individual keys, and
 * the `morning` adoption declines a collision — but nothing asserted that the RESULT AS A
 * WHOLE was collision-free, and the per-key merge manufactured one on its own: the old
 * build's midday 13:00 and evening 19:00 are each a stepper session away from a minute that
 * is now the default of one of the six NEW keys. `evening = '20:30'` lands on After
 * dinner's default; `midday = '14:00'` lands on After lunch's.
 *
 * Two things go wrong when it does, and neither announces itself: the prescription review
 * drops a dose (`plannedSlots` skips a slot whose time is already claimed, so a
 * four-times-a-day prescription writes three rows and reports itself as set up), and
 * Settings opens with Save disabled over a pair the user never touched.
 */
const UPGRADE_BLOBS: readonly Record<string, string>[] = [
  // The shipped four-slot defaults, untouched.
  { morning: '08:00', midday: '13:00', evening: '19:00', bedtime: '22:00' },
  // Evening moved to her real dinner hour — lands on After dinner / Before dinner.
  { morning: '08:00', midday: '13:00', evening: '20:30', bedtime: '22:00' },
  { morning: '08:00', midday: '13:00', evening: '20:00', bedtime: '22:00' },
  // Midday moved — lands on After lunch / Before lunch.
  { morning: '08:00', midday: '14:00', evening: '19:00', bedtime: '22:00' },
  { morning: '08:00', midday: '13:30', evening: '19:00', bedtime: '22:00' },
  // Bedtime moved early — lands on Before dinner.
  { morning: '08:00', midday: '13:00', evening: '19:00', bedtime: '20:00' },
  // Morning moved onto a new key's default.
  { morning: '08:30', midday: '13:00', evening: '19:00', bedtime: '22:00' },
  { morning: '12:00', midday: '13:00', evening: '19:00', bedtime: '22:00' },
  // A blob that already contradicts itself. Not writable by this build, but a read must
  // still return something the screen can save.
  { morning: '08:00', midday: '17:00', evening: '17:00', bedtime: '22:00' },
  // Partial blobs, each landing on a new key's default.
  { evening: '20:30' },
  { midday: '13:30' },
  { bedtime: '08:00' },
  {},
];

test('every realistic stored blob merges to a state that validates', () => {
  for (const blob of UPGRADE_BLOBS) {
    const merged = mergeSlotTimes(blob);
    const check = validateSlotTimes(merged);
    assert.equal(
      check.ok,
      true,
      `${JSON.stringify(blob)} merged to a duplicate: ${JSON.stringify(check.ok === false ? check.issue : null)}`,
    );
  }
});

test('settling never moves a time that came from storage', () => {
  // Invariant 4. The whole point of the merge is that an upgrade is invisible to a phone
  // whose owner set her times deliberately; a key still holding its DEFAULT is the only
  // one allowed to step aside.
  for (const blob of UPGRADE_BLOBS) {
    const merged = mergeSlotTimes(blob);
    for (const slot of BUILTIN_SLOT_KEYS) {
      const stored = blob[slot];
      if (typeof stored !== 'string' || !isWallClock(stored)) continue;
      // The one exception, documented on `settleSlotTimes`: two STORED values on one
      // minute cannot both be honoured, so the canonically-earlier one keeps it.
      const contested = BUILTIN_SLOT_KEYS.some(
        (other) => other !== slot && blob[other] === stored && BUILTIN_SLOT_KEYS.indexOf(other) < BUILTIN_SLOT_KEYS.indexOf(slot),
      );
      if (contested) continue;
      assert.equal(merged[slot], stored, `${slot} was moved off its stored time in ${JSON.stringify(blob)}`);
    }
  }
});

test('a default that has to move lands on the five-minute grid, just after', () => {
  // Deterministic and readable: After dinner pushed off Evening's 20:30 belongs at 20:35,
  // not 20:25, which would place it before the dinner it is named after.
  const merged = mergeSlotTimes({ evening: '20:30' });
  assert.equal(merged.evening, '20:30');
  assert.equal(merged.after_dinner, '20:35');
  assert.equal(merged.before_dinner, '20:00', 'an uncontested default does not move');
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test('definitions come back sorted by the time the user actually configured', () => {
  // Display order is her clock, not our array: Evening moved to 06:00 belongs at the top.
  const times = { ...DEFAULT_SLOT_TIMES, evening: '06:00' };
  const defs = buildSlotDefinitions(times, []);
  assert.equal(defs[0]?.key, 'evening');
  const sorted = defs.map((def) => def.time);
  assert.deepEqual(sorted, [...sorted].sort());
});

test('custom slots are interleaved by time, not appended', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, [
    custom('custom:00000001', 'Chai', '16:00'),
    custom('custom:00000002', 'Walk', '06:00'),
  ]);
  assert.equal(defs[0]?.key, 'custom:00000002', '06:00 sorts above every built-in');
  // Asserted against its neighbours rather than a literal index, so adding a built-in
  // later fails this test only if the ORDERING actually broke.
  const keys = order(defs).map((entry) => entry.split('@')[0]);
  const at = keys.indexOf('custom:00000001');
  assert.equal(keys[at - 1], 'after_lunch', '16:00 sits after the 14:00 slot');
  assert.equal(keys[at + 1], 'evening', '16:00 sits before the 17:00 slot');
});

test('a time tie is broken by canonical order, and the built-in wins over a custom', () => {
  // Two slots on one time is refused on save but reachable on disk, so the READ must be
  // total: the same list on every screen and every render, never "whichever came first".
  const times = { ...DEFAULT_SLOT_TIMES, after_lunch: '13:30' }; // equals before_lunch
  const defs = buildSlotDefinitions(times, [custom('custom:00000003', 'Tea', '13:30')]);
  const at1330 = defs.filter((def) => def.time === '13:30').map((def) => def.key);
  assert.deepEqual(at1330, ['before_lunch', 'after_lunch', 'custom:00000003']);
});

test('two customs on the same time are ordered by key, deterministically', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, [
    custom('custom:0000000b', 'B', '16:00'),
    custom('custom:0000000a', 'A', '16:00'),
  ]);
  const at1600 = defs.filter((def) => def.time === '16:00').map((def) => def.key);
  assert.deepEqual(at1600, ['custom:0000000a', 'custom:0000000b']);
});

test('slotForTime is deterministic regardless of the order it is handed', () => {
  const times = { ...DEFAULT_SLOT_TIMES, after_lunch: '13:30' };
  const defs = buildSlotDefinitions(times, []);
  assert.equal(slotForTime(defs, '13:30')?.key, 'before_lunch');
  assert.equal(slotForTime([...defs].reverse(), '13:30')?.key, 'before_lunch');
});

test('slotForTime returns null for a time no slot sits on', () => {
  assert.equal(slotForTime(buildSlotDefinitions(DEFAULT_SLOT_TIMES, []), '03:17'), null);
});

// ── Resolving a stored slot_key ──────────────────────────────────────────────

test('a built-in key resolves to its definition', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  const def = slotDefForKey(defs, 'bedtime');
  assert.equal(def?.kind, 'builtin');
  assert.equal(def?.time, '22:00');
});

test('a retired key still renders its name, forever', () => {
  // dose_schedule is append-only and trg_dose_schedule_no_update refuses a rewrite, so
  // rows carrying these keys can never be corrected. They must stay renderable.
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  for (const key of LEGACY_SLOT_KEYS) {
    const def = slotDefForKey(defs, key);
    assert.equal(def?.kind, 'legacy', `${key} did not resolve`);
    assert.equal(slotLabel(def!, en), SLOT_STRINGS[`slots.${key}`]?.en);
    // A retired key has no configured time. Inventing one would put a wrong clock time
    // next to a historical row; the caller uses the row's own time_local instead.
    assert.equal(def?.time, '');
  }
});

// ── slotForRow: the one rule three screens share ────────────────────────────────
// These four tests exist because this logic used to be three private copies, in
// `(tabs)/medicines.tsx`, `medicine/[id].tsx` and `dose/[occId].tsx`. Nothing failed
// when they agreed and nothing would have failed when they drifted — the three screens
// would simply have called the same dose by three names, silently. The rules are pinned
// here so a change to the precedence has to be made once, on purpose.

test('slotForRow: the configured slot wins over the stored key', () => {
  // The row was written by the four-slot build and still says 'morning', but 08:00 is
  // Before breakfast today. Every screen must say Before breakfast, or the medicines list
  // and the dose screen name one tablet two different things.
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  const def = slotForRow(defs, '08:00', 'morning');
  assert.equal(def?.key, 'before_breakfast');
});

test('slotForRow: a retired key names a time no live slot claims', () => {
  // 06:30 matches nothing she has configured. Without the legacy fallback this dose drops
  // into a nameless "Other times" heading, which reads as the app having forgotten it.
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  const def = slotForRow(defs, '06:30', 'morning');
  assert.equal(def?.kind, 'legacy');
  assert.equal(def?.key, 'morning');
});

test('slotForRow: a stale LIVE key is ignored rather than stating a wrong time', () => {
  // She moved After lunch to 14:30; this append-only row still rings at 14:00 and still
  // stores 'after_lunch'. Heading it "After lunch · 2:30 pm" over a 2:00 pm dose would be
  // a plain falsehood, so it falls through to the bare time.
  const defs = buildSlotDefinitions({ ...DEFAULT_SLOT_TIMES, after_lunch: '14:30' }, []);
  assert.equal(slotForRow(defs, '14:00', 'after_lunch'), null);
});

test('slotForRow: a deleted custom slot leaves the time unnamed, not mislabelled', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  assert.equal(slotForRow(defs, '15:45', 'custom:deadbeef'), null);
  assert.equal(slotForRow(defs, '15:45', null), null);
});

test('no retired key is offered as a built-in', () => {
  for (const key of LEGACY_SLOT_KEYS) {
    assert.ok(!(BUILTIN_SLOT_KEYS as readonly string[]).includes(key), `${key} is being offered`);
  }
});

test('an unknown key resolves to null so the caller can fall back to the raw time', () => {
  const defs = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
  assert.equal(slotDefForKey(defs, 'custom:deadbeef'), null, 'a since-deleted custom slot');
  assert.equal(slotDefForKey(defs, null), null);
  assert.equal(slotDefForKey(defs, ''), null);
});

// ── Built-in time validation ─────────────────────────────────────────────────

test('the defaults validate', () => {
  assert.deepEqual(validateSlotTimes(DEFAULT_SLOT_TIMES), { ok: true });
});

test('a non-wall-clock time is refused and the slot is named', () => {
  const result = validateSlotTimes({ ...DEFAULT_SLOT_TIMES, evening: '7pm' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.issue : null, {
    reason: 'not_wall_clock',
    slot: 'evening',
    time: '7pm',
  });
});

test('two built-ins on the same time are refused, and BOTH are named', () => {
  // The user must be told which two collapsed. Without the pair in the message her only
  // clue is that the save did nothing.
  const result = validateSlotTimes({ ...DEFAULT_SLOT_TIMES, before_lunch: '14:00' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false ? result.issue : null, {
    reason: 'duplicate_time',
    slots: ['before_lunch', 'after_lunch'],
    time: '14:00',
  });
});

test('the reported duplicate pair is stable across renders', () => {
  const times = { ...DEFAULT_SLOT_TIMES, midday: '22:00', evening: '22:00' };
  const first = validateSlotTimes(times);
  const second = validateSlotTimes({ ...times });
  assert.deepEqual(first, second);
  assert.deepEqual(first.ok === false ? first.issue.reason : null, 'duplicate_time');
});

// ── Custom slot validation ───────────────────────────────────────────────────

const NO_CUSTOMS: readonly CustomSlot[] = [];

function issueOf(slots: readonly CustomSlot[], times = DEFAULT_SLOT_TIMES) {
  const result = validateCustomSlots(slots, times);
  return result.ok ? null : result.issue;
}

test('a good custom slot validates and comes back with its label trimmed', () => {
  const result = validateCustomSlots([custom('custom:0011aabb', '  Chai time  ', '16:00')], DEFAULT_SLOT_TIMES);
  assert.equal(result.ok, true);
  // The caller stores what it gets back, not what it passed in — a trailing space must
  // never reach a chip or a TalkBack label.
  assert.deepEqual(result.ok ? result.slots : null, [
    { key: 'custom:0011aabb', label: 'Chai time', time: '16:00' },
  ]);
});

test('an empty list validates', () => {
  assert.deepEqual(validateCustomSlots(NO_CUSTOMS, DEFAULT_SLOT_TIMES), { ok: true, slots: [] });
});

test('a whitespace-only label is refused', () => {
  assert.deepEqual(issueOf([custom('custom:0011aabb', '   ', '16:00')]), { reason: 'label_empty' });
  assert.deepEqual(issueOf([custom('custom:0011aabb', '', '16:00')]), { reason: 'label_empty' });
});

test('a label longer than the cap is refused, and the cap is reported', () => {
  const tooLong = 'x'.repeat(MAX_CUSTOM_SLOT_LABEL + 1);
  assert.deepEqual(issueOf([custom('custom:0011aabb', tooLong, '16:00')]), {
    reason: 'label_too_long',
    max: MAX_CUSTOM_SLOT_LABEL,
  });
  // Exactly at the cap is fine — an off-by-one here is a label the user cannot finish.
  const atCap = 'x'.repeat(MAX_CUSTOM_SLOT_LABEL);
  assert.equal(validateCustomSlots([custom('custom:0011aabb', atCap, '16:00')], DEFAULT_SLOT_TIMES).ok, true);
});

test('a label that duplicates a built-in name is refused, in either language', () => {
  // Two chips reading "Evening", told apart only by their times, on the screen where
  // reading the wrong one moves a TB dose. The refusal names the slot it collides with,
  // because "one of the times above" is not something she can act on.
  assert.deepEqual(issueOf([custom('custom:0011aabb', 'Evening', '16:00')]), {
    reason: 'label_reserved',
    label: 'Evening',
    slot: 'evening',
  });
  assert.deepEqual(issueOf([custom('custom:0011aabb', ' शाम ', '16:00')]), {
    reason: 'label_reserved',
    label: 'शाम',
    slot: 'evening',
  });
  // Case and inner whitespace do not get you around it.
  assert.equal(issueOf([custom('custom:0011aabb', 'before   LUNCH', '16:00')])?.reason, 'label_reserved');
});

test('a RETIRED name is not reserved — it is in no picker to be confused with', () => {
  // सुबह / दोपहर / रात are the most natural Hindi names for a time of her own, and they
  // used to be refused with a message that named nothing she could see on screen.
  for (const label of ['सुबह', 'रात', 'दोपहर', 'Morning', 'Night', 'Afternoon', 'Another time']) {
    assert.equal(
      validateCustomSlots([custom('custom:0011aabb', label, '16:00')], DEFAULT_SLOT_TIMES).ok,
      true,
      `"${label}" was refused`,
    );
  }
});

test('every reserved label belongs to a slot that is actually offered', () => {
  // The property the bug violated: a refusal may only ever name something the user can
  // see in the list above the field.
  for (const slot of BUILTIN_SLOT_KEYS) {
    for (const language of ['en', 'hi'] as const) {
      const name = SLOT_STRINGS[slotI18nKey(slot)]?.[language];
      assert.ok(name);
      const issue = issueOf([custom('custom:0011aabb', name, '16:00')]);
      assert.equal(issue?.reason, 'label_reserved', `${slot} ${language} is not reserved`);
      assert.equal(issue?.reason === 'label_reserved' ? issue.slot : null, slot);
    }
  }
});

test('a label that merely contains a built-in name is allowed', () => {
  assert.equal(validateCustomSlots([custom('custom:0011aabb', 'Late evening walk', '16:00')], DEFAULT_SLOT_TIMES).ok, true);
});

test('a malformed key is refused', () => {
  for (const key of ['chai', 'custom:', 'custom:xyz', 'custom:0011AABB', 'custom:0011aabbc']) {
    assert.deepEqual(issueOf([custom(key, 'Chai', '16:00')]), { reason: 'bad_key', key }, key);
  }
});

test('a malformed time is refused', () => {
  assert.deepEqual(issueOf([custom('custom:0011aabb', 'Chai', '4pm')]), {
    reason: 'not_wall_clock',
    time: '4pm',
  });
});

test('a custom slot may not sit on a built-in time, and the built-in is named', () => {
  assert.deepEqual(issueOf([custom('custom:0011aabb', 'Chai', '14:00')]), {
    reason: 'duplicate_time',
    time: '14:00',
    otherKey: 'after_lunch',
  });
});

test('a custom slot may not sit on another custom slot time', () => {
  assert.deepEqual(
    issueOf([custom('custom:0011aabb', 'Chai', '16:00'), custom('custom:0011aabc', 'Walk', '16:00')]),
    { reason: 'duplicate_time', time: '16:00', otherKey: 'custom:0011aabb' },
  );
});

test('the collision is checked against the CONFIGURED times, not the defaults', () => {
  // She moved Evening to 16:00; a custom slot at 16:00 must now be refused even though
  // 16:00 is free in the shipping defaults.
  const times = { ...DEFAULT_SLOT_TIMES, evening: '16:00' };
  assert.deepEqual(issueOf([custom('custom:0011aabb', 'Chai', '16:00')], times), {
    reason: 'duplicate_time',
    time: '16:00',
    otherKey: 'evening',
  });
});

test('a repeated key is refused', () => {
  assert.deepEqual(
    issueOf([custom('custom:0011aabb', 'Chai', '16:00'), custom('custom:0011aabb', 'Walk', '15:00')]),
    { reason: 'duplicate_key', key: 'custom:0011aabb' },
  );
});

test('the failing entry is reported by index', () => {
  const result = validateCustomSlots(
    [custom('custom:00000001', 'Chai', '16:00'), custom('custom:00000002', '', '15:00')],
    DEFAULT_SLOT_TIMES,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.index : null, 1);
});

test('more custom slots than the cap is refused', () => {
  const many = Array.from({ length: MAX_CUSTOM_SLOTS + 1 }, (_unused, i) =>
    custom(`custom:0000000${i}`, `Slot ${i}`, `0${i}:05`),
  );
  assert.deepEqual(issueOf(many), { reason: 'too_many', max: MAX_CUSTOM_SLOTS });
});

// ── Parsing stored custom slots (tolerant, one entry at a time) ──────────────

test('a missing or malformed custom-slot blob parses to an empty list', () => {
  for (const junk of [null, undefined, 'nonsense', 42, {}, { slots: [] }]) {
    assert.deepEqual(parseCustomSlots(junk), []);
  }
});

test('one bad entry costs that entry and nothing else', () => {
  // This is a READ of a blob already on the phone. Refusing the whole array would empty
  // the medicines list over a stray character.
  const parsed = parseCustomSlots([
    { key: 'custom:00000001', label: 'Chai', time: '16:00' },
    { key: 'nope', label: 'Bad key', time: '15:00' },
    { key: 'custom:00000002', label: 'Bad time', time: '99:99' },
    { key: 'custom:00000003', label: '   ', time: '15:30' },
    { key: 'custom:00000004', label: 'x'.repeat(MAX_CUSTOM_SLOT_LABEL + 1), time: '15:45' },
    null,
    'garbage',
    { key: 'custom:00000005', label: '  Walk  ', time: '06:15' },
  ]);
  assert.deepEqual(parsed, [
    { key: 'custom:00000001', label: 'Chai', time: '16:00' },
    { key: 'custom:00000005', label: 'Walk', time: '06:15' },
  ]);
});

test('parsing drops a repeated key and a repeated time, keeping the first', () => {
  const parsed = parseCustomSlots([
    { key: 'custom:00000001', label: 'Chai', time: '16:00' },
    { key: 'custom:00000001', label: 'Chai again', time: '17:00' },
    { key: 'custom:00000002', label: 'Same time', time: '16:00' },
  ]);
  assert.deepEqual(parsed.map((slot) => slot.key), ['custom:00000001']);
});

test('parsing stops at the cap', () => {
  const stored = Array.from({ length: MAX_CUSTOM_SLOTS + 3 }, (_unused, i) => ({
    key: `custom:0000000${i}`,
    label: `Slot ${i}`,
    time: `0${i % 10}:05`,
  }));
  assert.equal(parseCustomSlots(stored).length, MAX_CUSTOM_SLOTS);
});

// ── Keys and times ───────────────────────────────────────────────────────────

test('newCustomSlotKey produces a well-formed key that validation accepts', () => {
  for (let i = 0; i < 200; i += 1) {
    const key = newCustomSlotKey();
    assert.match(key, /^custom:[0-9a-f]{8}$/);
    assert.ok(isCustomSlotKey(key));
  }
});

test('newCustomSlotKey does not repeat itself in a realistic run', () => {
  const keys = new Set(Array.from({ length: 500 }, () => newCustomSlotKey()));
  assert.ok(keys.size > 490, 'far too many collisions for a 32-bit identity');
});

test('isWallClock accepts every valid minute of the day and nothing else', () => {
  assert.ok(isWallClock('00:00'));
  assert.ok(isWallClock('23:59'));
  assert.ok(isWallClock('08:05'));
  for (const bad of ['24:00', '23:60', '7:00', '07:0', '0700', '07:00:00', '', ' 07:00', '07:00 ']) {
    assert.equal(isWallClock(bad), false, bad);
  }
});

// ── Clock arithmetic shared by both custom-slot flows ────────────────────────

test('the stepper grid is five minutes', () => {
  // Both creation screens step their minute counter by this. If it ever moves, the grid
  // `defaultNewCustomSlotTime` snaps to has to move with it or the form opens on a minute
  // the steppers cannot return to once she steps off it.
  assert.equal(SLOT_MINUTE_STEP, 5);
});

test('stepWallClock moves by whole minutes and wraps at midnight', () => {
  assert.equal(stepWallClock('08:00', 60), '09:00');
  assert.equal(stepWallClock('08:00', -60), '07:00');
  assert.equal(stepWallClock('08:00', SLOT_MINUTE_STEP), '08:05');
  assert.equal(stepWallClock('08:00', -SLOT_MINUTE_STEP), '07:55');
  // Wrapping, not clamping. A button that silently stops working near the ends of the day
  // is indistinguishable from a tap that did not register.
  assert.equal(stepWallClock('23:55', 5), '00:00');
  assert.equal(stepWallClock('00:00', -5), '23:55');
  assert.equal(stepWallClock('23:00', 60), '00:00');
  assert.equal(stepWallClock('00:30', -60), '23:30');
});

test('stepWallClock hands back anything that is not a wall clock, untouched', () => {
  // Coercing junk to a plausible time on the path that writes an alarm would turn a value
  // the app cannot account for into one it can.
  for (const bad of ['', '7pm', '24:00', 'नौ बजे']) {
    assert.equal(stepWallClock(bad, 5), bad);
  }
});

test('joinWallClock pads, and wraps a counter that runs off either end', () => {
  assert.equal(joinWallClock(8, 0), '08:00');
  assert.equal(joinWallClock(8, 5), '08:05');
  assert.equal(joinWallClock(23, 59), '23:59');
  // '24:00' is not a wall clock, so a counter that produced it would fail validation at
  // Save over a value she can see on screen and see nothing wrong with.
  assert.equal(joinWallClock(24, 0), '00:00');
  assert.equal(joinWallClock(-1, 30), '23:30');
  assert.ok(isWallClock(joinWallClock(24, 0)));
});

test('splitWallClock round-trips with joinWallClock for every minute of the day', () => {
  for (let total = 0; total < 1440; total += 1) {
    const time = joinWallClock(0, total);
    const { hour, minute } = splitWallClock(time);
    assert.equal(joinWallClock(hour, minute), time);
  }
});

test('splitWallClock degrades to midnight rather than to NaN', () => {
  // Unreachable in practice — every producer of these strings is validated — but a NaN
  // reaching a stepper renders 'NaN:NaN' on the one screen she cannot back out of.
  assert.deepEqual(splitWallClock('nonsense'), { hour: 0, minute: 0 });
});

// ── Where a new custom-slot form opens ───────────────────────────────────────
//
// The bug this replaces: `medicine/schedule.tsx` opened its picker on a hard-coded 09:00,
// so a woman who already had something on 09:00 typed a name, pressed Add, and was told
// the time was taken — by a value the app had pre-loaded for her.

/** Every time a profile occupies, built-ins and customs together. */
function occupied(times: SlotTimes, customs: readonly CustomSlot[] = []): Set<string> {
  return new Set([...BUILTIN_SLOT_KEYS.map((slot) => times[slot]), ...customs.map((c) => c.time)]);
}

test('a new custom slot opens in the middle of her day, and on the shipped defaults that is 15:00', () => {
  // 08:00 … 22:00 → 15:00. Byte-identical to what settings/slots.tsx already did from a
  // hard-coded anchor, so the flow she uses today does not change under her.
  assert.equal(defaultNewCustomSlotTime(DEFAULT_SLOT_TIMES, []), '15:00');
});

test('the opening time follows her day rather than a constant', () => {
  // A woman who eats and sleeps early gets a form that opens early; one who lives late
  // gets one that opens late. Neither gets a number someone typed into a screen once.
  const early: SlotTimes = {
    before_breakfast: '05:00',
    after_breakfast: '05:30',
    midday: '09:00',
    before_lunch: '11:00',
    after_lunch: '11:30',
    evening: '14:00',
    before_dinner: '17:00',
    after_dinner: '17:30',
    bedtime: '20:00',
  };
  assert.equal(defaultNewCustomSlotTime(early, []), '12:30');

  const late: SlotTimes = {
    before_breakfast: '09:00',
    after_breakfast: '09:30',
    midday: '13:00',
    before_lunch: '14:30',
    after_lunch: '15:00',
    evening: '18:00',
    before_dinner: '21:00',
    after_dinner: '21:30',
    bedtime: '23:00',
  };
  assert.equal(defaultNewCustomSlotTime(late, []), '16:00');
});

test('the opening time is never one that is already taken', () => {
  // THE POSTCONDITION. Everything else here is taste; this is the defect.
  const cases: readonly { times: SlotTimes; customs: CustomSlot[] }[] = [
    { times: { ...DEFAULT_SLOT_TIMES }, customs: [] },
    { times: { ...DEFAULT_SLOT_TIMES }, customs: [custom('custom:00000001', 'Chai', '15:00')] },
    {
      times: { ...DEFAULT_SLOT_TIMES },
      customs: [
        custom('custom:00000001', 'A', '15:00'),
        custom('custom:00000002', 'B', '15:05'),
        custom('custom:00000003', 'C', '15:10'),
      ],
    },
    // The old hard-coded 09:00, sitting exactly where the schedule screen used to open.
    { times: { ...DEFAULT_SLOT_TIMES, midday: '09:00' }, customs: [] },
    // A day squeezed into one hour, so the midpoint region is dense.
    {
      times: {
        before_breakfast: '12:00',
        after_breakfast: '12:05',
        midday: '12:10',
        before_lunch: '12:15',
        after_lunch: '12:20',
        evening: '12:25',
        before_dinner: '12:30',
        after_dinner: '12:35',
        bedtime: '12:40',
      },
      customs: [],
    },
  ];
  for (const { times, customs } of cases) {
    const opening = defaultNewCustomSlotTime(times, customs);
    assert.ok(isWallClock(opening), `${opening} is not a wall clock`);
    assert.ok(
      !occupied(times, customs).has(opening),
      `${opening} is already taken in ${JSON.stringify(times)} / ${JSON.stringify(customs)}`,
    );
    // On the grid, so her steppers can get back to it after she moves off it.
    assert.equal(Number(opening.slice(3)) % SLOT_MINUTE_STEP, 0, `${opening} is off the grid`);
  }
});

test('the opening time is one validateCustomSlots will actually accept', () => {
  // The two halves have to agree: a form seeded with a time the validator refuses is the
  // same failure as the hard-coded 09:00, just later in the flow.
  const time = defaultNewCustomSlotTime(DEFAULT_SLOT_TIMES, []);
  const result = validateCustomSlots([custom('custom:0011aabb', 'Chai', time)], DEFAULT_SLOT_TIMES);
  assert.equal(result.ok, true);
});

test('filling every custom slot never marches the form out of her waking day', () => {
  // Why the anchor is the MIDDLE and not "after the last configured time": that variant
  // opens at 22:05 on the defaults and pushes five minutes further into the night with
  // every slot she adds. Anchoring on the midpoint keeps successive adds clustered.
  const customs: CustomSlot[] = [];
  for (let i = 0; i < MAX_CUSTOM_SLOTS; i += 1) {
    const time = defaultNewCustomSlotTime(DEFAULT_SLOT_TIMES, customs);
    assert.ok(!occupied(DEFAULT_SLOT_TIMES, customs).has(time), `${time} collided on add ${i}`);
    assert.ok(time >= '08:00' && time <= '22:00', `add ${i} drifted to ${time}`);
    customs.push(custom(`custom:0000000${i}`, `Slot ${i}`, time));
  }
  assert.equal(new Set(customs.map((c) => c.time)).size, MAX_CUSTOM_SLOTS);
});

test('the opening time is deterministic — the two screens must agree', () => {
  const customs = [custom('custom:00000001', 'Chai', '15:00')];
  const first = defaultNewCustomSlotTime(DEFAULT_SLOT_TIMES, customs);
  const second = defaultNewCustomSlotTime({ ...DEFAULT_SLOT_TIMES }, [...customs]);
  assert.equal(first, second);
});

test('junk times are ignored, and an empty configuration still opens on a real time', () => {
  const broken: SlotTimes = {
    before_breakfast: '7am',
    after_breakfast: '',
    midday: '25:00',
    before_lunch: 'x',
    after_lunch: 'y',
    evening: 'z',
    before_dinner: '',
    after_dinner: '',
    bedtime: '',
  };
  const opening = defaultNewCustomSlotTime(broken, []);
  assert.ok(isWallClock(opening));
  // Nothing valid is configured, so the span comes from the shipped defaults.
  assert.equal(opening, '15:00');
});

// ── The shared "name a time of your own" copy ────────────────────────────────
//
// Two screens create custom slots and they disagreed on defaults, copy AND casing. The
// copy lives in SLOT_STRINGS so they cannot disagree again; these tests pin the contract
// the two screens code against.

test('every shared own-time key resolves, in both languages', () => {
  for (const [name, key] of Object.entries(SLOT_OWN_TIME_KEYS)) {
    const entry = SLOT_STRINGS[key];
    assert.ok(entry, `SLOT_OWN_TIME_KEYS.${name} points at ${key}, which is not in SLOT_STRINGS`);
    assert.ok(entry.en.trim().length > 0, `${key} has no English`);
    assert.ok(entry.hi.trim().length > 0, `${key} has no Hindi`);
    assert.notEqual(entry.hi, entry.en, `${key} Hindi is a copy of the English`);
  }
});

test('the shared own-time English is sentence case, like the rest of the app', () => {
  // The regression: seven Title Case strings — the only multi-word Title Case UI strings
  // outside proper nouns — on one screen, while the same action on the other screen was
  // sentence case. 'Remove The Name' additionally capitalised an article mid-phrase.
  for (const key of Object.values(SLOT_OWN_TIME_KEYS)) {
    const value = SLOT_STRINGS[key]?.en;
    assert.ok(value);
    assert.doesNotMatch(
      value,
      /^([A-Z][a-z]+ )+[A-Z][a-z]+$/,
      `"${value}" (${key}) is Title Case; the app writes UI strings in sentence case`,
    );
  }
});

test('every placeholder in the shared own-time copy exists in both languages', () => {
  // A {{max}} present in English and missing in Hindi renders a sentence with a hole in
  // it for the reader who needs the number most.
  const placeholders = (value: string): string[] =>
    [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort();
  for (const key of Object.values(SLOT_OWN_TIME_KEYS)) {
    const entry = SLOT_STRINGS[key];
    assert.ok(entry);
    assert.deepEqual(placeholders(entry.en), placeholders(entry.hi), `${key} placeholders differ`);
  }
});

test('the shared own-time keys are all distinct and all namespaced under slots.', () => {
  const keys = Object.values(SLOT_OWN_TIME_KEYS);
  assert.equal(new Set(keys).size, keys.length, 'two names point at one key');
  for (const key of keys) assert.match(key, /^slots\./);
});
