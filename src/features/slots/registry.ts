/**
 * Named dose slots — the single source of truth.
 *
 * ─── WHY THIS FILE IS NOT UNDER `src/app/` ────────────────────────────────────
 * Expo Router turns EVERY `.ts`/`.tsx` file under the app root into a route (see the
 * header of `src/app/_shared/lib.tsx`). This module is imported by eight screens and is
 * not a screen itself, so it lives outside the app root where it cannot become a route.
 * `src/app/_shared/lib.tsx` re-exports the whole surface so existing imports keep working.
 *
 * ─── WHY THE DATABASE IS REACHED THROUGH A DYNAMIC IMPORT ─────────────────────
 * `npm test` is `node --test --experimental-strip-types "src/**\/*.test.ts"`. That loader
 * resolves neither the `@/*` tsconfig alias nor `expo-sqlite`, so a top-level import of
 * the db layer would make this whole module unloadable in the test runner — and the pure
 * half (merge, validation, ordering, labelling) is exactly the half that is worth
 * testing, because it is the half that decides when a tablet rings. The five async
 * functions therefore `await import('../../db/repositories/_shared')` at call time, the
 * same trick `features/prescriptions/confirm.ts` uses for `reconcile`. Nothing in a test
 * calls them, so nothing in a test touches SQLite.
 *
 * ─── THE THREE RULES THIS MODULE EXISTS TO ENFORCE ────────────────────────────
 *  1. NO MIGRATION. `dose_schedule.slot_key` is plain `TEXT` with no CHECK and no FK
 *     (src/db/migrations.ts, the `CREATE TABLE dose_schedule` block). Every key shape
 *     below already fits the column as shipped. `SlotKey` is deliberately `string`.
 *
 *  2. HISTORY IS RENDERABLE FOREVER. `dose_schedule` is append-only and
 *     `trg_dose_schedule_no_update` aborts any attempt to rewrite `time_local` &c., so
 *     rows already on a phone carrying `slot_key = 'morning'` can never be corrected.
 *     They must keep resolving to a name — see `LEGACY_SLOT_KEYS` and `slotDefForKey` —
 *     and must never be OFFERED again in a picker.
 *
 *  3. NO TWO SLOTS ON THE SAME CLOCK TIME. `dose_schedule` has
 *     `UNIQUE (thread_id, version, time_local)` and `dose_occurrence.id` is
 *     `'<thread_id>:<local_date>:<time_local>'`. Two slots at 14:00, both ticked, is a
 *     constraint abort that rolls back the entire save behind a generic error. With
 *     Before lunch at 13:30 and After lunch at 14:00 that is one stepper tap away, so
 *     WRITES REFUSE a collision (`validateSlotTimes`, `validateCustomSlots`) while READS
 *     TOLERATE one deterministically (`buildSlotDefinitions`, `slotForTime`). A read that
 *     threw would brick the medicines list over a value already on disk.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 1. The built-in slots
// ═══════════════════════════════════════════════════════════════════════════════

export type BuiltinSlotKey =
  | 'before_breakfast'
  | 'after_breakfast'
  | 'midday'
  | 'before_lunch'
  | 'after_lunch'
  | 'evening'
  | 'before_dinner'
  | 'after_dinner'
  | 'bedtime';

/**
 * Canonical CLOCK order — the order the default times run in, not the order anything is
 * displayed in. Display sorts by the user's ACTUAL configured times (she may put Evening
 * before Midday if she wants); this array exists so that when two slots land on the same
 * time the tie is broken the same way on every screen and in every write.
 */
export const BUILTIN_SLOT_KEYS: readonly BuiltinSlotKey[] = [
  'before_breakfast',
  'after_breakfast',
  'midday',
  'before_lunch',
  'after_lunch',
  'evening',
  'before_dinner',
  'after_dinner',
  'bedtime',
];

/**
 * Defaults, not recommendations. They exist so the setup wizard has something on screen
 * to adjust; the wizard makes slot times the ONE step it will not let the user skip,
 * because every reminder in the app resolves through them.
 *
 * `midday`, `evening` and `bedtime` KEEP THE KEY NAMES THEY SHIPPED WITH even though two
 * of their defaults moved (midday 13:00 → 12:00, evening 19:00 → 17:00). A phone that
 * already has a stored value for those keys keeps it — see `mergeSlotTimes` — so this
 * change is invisible to an install whose owner deliberately set them.
 */
export const DEFAULT_SLOT_TIMES: Readonly<Record<BuiltinSlotKey, string>> = {
  before_breakfast: '08:00',
  after_breakfast: '08:30',
  midday: '12:00',
  before_lunch: '13:30',
  after_lunch: '14:00',
  evening: '17:00',
  before_dinner: '20:00',
  after_dinner: '20:30',
  bedtime: '22:00',
};

/**
 * Keys that were once written into `dose_schedule.slot_key` and are no longer offered.
 *
 * `'morning'` is the one that is actually out there: it is what the shipped four-slot
 * build wrote for the 08:00 dose. `'afternoon'` and `'night'` only ever reached the
 * column through `scripts/seed-dev-data.ts`, but they cost nothing to keep renderable and
 * a dev handset that hits an unnamed row is a bug report nobody can reproduce.
 *
 * These are DISPLAY-ONLY. Nothing may put them in a picker: the row that carries them
 * cannot be rewritten, but a new row must never be given one.
 */
export const LEGACY_SLOT_KEYS = ['morning', 'afternoon', 'night'] as const;

export type LegacySlotKey = (typeof LEGACY_SLOT_KEYS)[number];

/**
 * A key as STORED in `dose_schedule.slot_key`. Deliberately widened to `string`:
 * built-in keys, `'custom:<hex>'` keys and legacy keys all live in this one column.
 *
 * NEVER NARROW THIS BACK TO A UNION. `dose_schedule` is append-only, so historical rows
 * carry keys that are no longer offered; a union makes those rows unrepresentable and an
 * exhaustive `switch` over it silently drops — or crashes on — March's schedule.
 */
export type SlotKey = string;

/** A slot the user invented herself. `label` is her own words, in her own language. */
export type CustomSlot = { readonly key: string; readonly label: string; readonly time: string };

export type SlotDefinition = {
  readonly key: SlotKey;
  /**
   * `'HH:MM'` wall clock. EMPTY STRING for a `kind: 'legacy'` definition — a retired key
   * has no configured time, and inventing one would put a wrong clock time next to a
   * historical row. Callers rendering a legacy slot use the row's own `time_local`.
   */
  readonly time: string;
  readonly kind: 'builtin' | 'custom' | 'legacy';
  /** builtin/legacy → `'slots.<key>'`; custom → null, because user text is not a key. */
  readonly i18nKey: string | null;
  /** custom → the user's own text; builtin/legacy → null. */
  readonly label: string | null;
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Names, in both languages
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structurally identical to `LocalStrings` in `src/app/_shared/lib.tsx`, declared here
 * rather than imported so this module has no dependency on the route layer at all.
 */
export type SlotStrings = Readonly<Record<string, { readonly en: string; readonly hi: string }>>;

/**
 * Slot names live here and not in `src/i18n/*.json` because that bundle is owned
 * elsewhere and covers about a third of the keys the route layer needs; `useT()` consults
 * the bundle FIRST, so the day these keys land in en.json/hi.json the bundle silently
 * wins and this map becomes deletable in one pass.
 *
 * The Hindi is written, not transliterated. Every one of the nine names says which MEAL it
 * belongs to; a bare 'खाने से पहले' on both the lunch and the dinner slot would put two
 * chips six hours apart under one identical string, which is exactly the failure this whole
 * change is trying to avoid.
 *
 * ─── WHY THE MEAL COMES LAST IN THE FOUR MEAL-PAIR NAMES ──────────────────────
 * Hindi is head-final and postpositional: the natural phrase is '<meal> से पहले' /
 * '<meal> के बाद', which puts the ONE word that separates "before" from "after" at the very
 * END. In English the eye lands on 'Before' or 'After' first and the job is done in one
 * fixation. In Hindi, written the natural way, 'दोपहर के खाने से पहले' and
 * 'दोपहर के खाने के बाद' share their first THREE words, and the chip renders
 * `${slotLabel} · ${time}` — so at a 1.3x font scale line one read 'दोपहर के खाने' on both
 * chips and the deciding word wrapped onto line two together with the clock time. The two
 * chips are ADJACENT in every picker, because the picker sorts by time and the pair is
 * thirty minutes apart. She was being asked to choose between two rows whose first visible
 * line was identical, and choosing wrong moves a rifampicin dose from before food to after
 * it — the wrong direction for a TB drug, which is dosed on an empty stomach.
 *
 * There is no way to FRONT the discriminator and stay in real Hindi: 'पहले' and 'बाद' are
 * postpositional and cannot lead their complement, and every attempt to make them lead
 * ('पहले — दोपहर का खाना') reads as telegraphic label-speak rather than something a person
 * would say. So the pair is separated the other way the brief allows — by making the two
 * members stop sharing an opening. The discriminating phrase leads, the meal follows as a
 * qualifier:
 *
 *     दोपहर के खाने से पहले   →   खाने से पहले, दोपहर
 *     दोपहर के खाने के बाद    →   खाने के बाद, दोपहर
 *     रात के खाने से पहले     →   खाने से पहले, रात
 *     रात के खाने के बाद      →   खाने के बाद, रात
 *
 * Both members now diverge at character 6 — 'खाने से' vs 'खाने के', then 'पहले' vs 'बाद',
 * two tokens whose shapes are nothing like each other. Nineteen code units at most, so the
 * label fits one line beside the clock at her scale; and if a narrower phone or a larger
 * scale does force a wrap, the break falls at the comma, which leaves the whole
 * discriminator on line one. `registry.test.ts` pins both properties — the divergence point
 * and the length — so a future rewording cannot quietly put the meal back in front.
 *
 * WHAT THIS TRADES AWAY, stated plainly: the two BEFORE names now share their first three
 * words with each other, as do the two AFTER names. That is the cheaper confusion. Before
 * lunch and Before dinner are six and a half hours apart, so they are never neighbours in a
 * time-sorted picker and never in the same group heading on the settings screen (the groups
 * are 'दोपहर और खाना' and 'शाम और रात'). Before lunch and After lunch are always neighbours.
 * Separate the neighbours.
 *
 * `नाश्ते से पहले` / `नाश्ते के बाद` keep the natural meal-first order and are deliberately
 * NOT restructured: नाश्ता is a one-word meal, so both names are three short tokens that fit
 * one line whole, and 'खाने से पहले, नाश्ता' would be worse Hindi — नाश्ता is not खाना.
 *
 * LOOK-UP MUST STAY DYNAMIC. `scripts/check-i18n.js` resolves a hard-coded slot key —
 * one written as a quoted literal argument to the translate function — only against keys
 * declared in the SAME file, and spreading this map into a screen's own `STRINGS` does
 * not satisfy its regex. Every call site goes through `slotLabel(def, t)`, which the
 * checker counts as dynamic and skips.
 */
export const SLOT_STRINGS: SlotStrings = {
  'slots.before_breakfast': { en: 'Before breakfast', hi: 'नाश्ते से पहले' },
  'slots.after_breakfast': { en: 'After breakfast', hi: 'नाश्ते के बाद' },
  // 'दिन में', not 'दोपहर'. Two of the nine names already carry 'दोपहर' ('खाने से पहले,
  // दोपहर' and 'खाने के बाद, दोपहर'), as does the Midday group heading, so a bare 'दोपहर'
  // here made one card read the same word five times over — work the English reader never has
  // to do, on the one setup step that cannot be skipped. It was also BYTE-IDENTICAL to the
  // retired 'afternoon' below, so a phone carrying an 'afternoon' schedule row could show
  // two 'दोपहर' sections side by side in the medicines list with only the clock to tell
  // them apart. 'दिन में' is what a Delhi speaker says for a between-meals daytime dose.
  'slots.midday': { en: 'Midday', hi: 'दिन में' },
  // The four meal-pair names put the discriminator first and the meal last. See the
  // "WHY THE MEAL COMES LAST" note above — this is the finding-12 fix, not a stylistic
  // preference, and the two properties it depends on are pinned in the test file.
  'slots.before_lunch': { en: 'Before lunch', hi: 'खाने से पहले, दोपहर' },
  'slots.after_lunch': { en: 'After lunch', hi: 'खाने के बाद, दोपहर' },
  'slots.evening': { en: 'Evening', hi: 'शाम' },
  'slots.before_dinner': { en: 'Before dinner', hi: 'खाने से पहले, रात' },
  'slots.after_dinner': { en: 'After dinner', hi: 'खाने के बाद, रात' },
  'slots.bedtime': { en: 'Bedtime', hi: 'सोने से पहले' },

  // Retired keys. Rendered for history, never offered.
  'slots.morning': { en: 'Morning', hi: 'सुबह' },
  'slots.afternoon': { en: 'Afternoon', hi: 'दोपहर' },
  'slots.night': { en: 'Night', hi: 'रात' },

  /**
   * WHAT CHANGING A SLOT TIME ACTUALLY DOES, in one sentence.
   *
   * It lives here rather than in a screen because two screens have to agree about it and
   * they did not: `settings/slots.tsx` states the truth in its banner, while
   * `medicine/schedule.tsx` used to promise, under the very chips this sentence sits
   * above, that "changing them there changes every reminder". It does not.
   * `dose_schedule.time_local` is written once, when a medicine's schedule is saved, the
   * table is append-only (`trg_dose_schedule_no_update`), and `buildCandidates` /
   * `buildAlarmRules` read `schedule.timeLocal` and never consult a slot time at all. So a
   * user who read that line, moved Before breakfast to 07:00 and was told "the reminders
   * have been set again" would still be rung at 08:00 tomorrow — and would have no reason
   * to doubt it. Keep this sentence and `slots.warningBody` in settings saying the same
   * thing; they are the only two places the mechanism is described.
   */
  'slots.settingsNote': {
    en: 'These times come from your settings. Changing them there changes what you are offered next time — a medicine already set up keeps the time you gave it.',
    hi: 'ये समय आपकी सेटिंग से आते हैं। वहाँ बदलने पर अगली बार आपको यही नए समय दिखेंगे — जो दवाई पहले से लगी है वह उसी समय पर रहती है जो आपने उसे दिया था।',
  },

  'slots.custom': { en: 'Another time', hi: 'कोई और समय' },

  // ═══════════════════════════════════════════════════════════════════════════
  // NAMING A TIME OF HER OWN — shared by BOTH creation flows
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // There are two screens where a custom slot gets created: `settings/slots.tsx`
  // (a dialog) and `medicine/schedule.tsx` (an inline form). They were written weeks
  // apart and drifted on all three axes at once — different defaults, different copy
  // and different casing. The user meets the SAME action written two ways depending on
  // which door she came through: 'Add Your Own Time' on one screen, 'Add a time of your
  // own' on the other; 'Change This Time' against 'Give this time a name'.
  //
  // The copy lives here so the two screens cannot disagree again, and it is SENTENCE
  // CASE, which is what the rest of the app uses — a grep for a multi-word Title Case
  // `en:` value across `src/app` returns proper nouns and nothing else. Devanagari has
  // no case, so only the English changes; the Hindi below is the wording the settings
  // screen already shipped, adopted verbatim so a Hindi reader sees no churn at all.
  //
  // ── HOW A SCREEN REFERS TO THESE ──
  // NOT as a quoted literal. `scripts/check-i18n.js` resolves a translate call written
  // with a quoted key only against `LocalStrings` entries declared in the SAME FILE, and
  // spreading this map into a screen's own `STRINGS` does not satisfy that regex — so a
  // quoted 'slots.ownName' in a screen would fail the i18n gate even though the key
  // resolves perfectly at runtime. (The gate is literal enough that writing such a call
  // inside a COMMENT trips it too, which is why this paragraph describes one instead of
  // showing one.) Go through `SLOT_OWN_TIME_KEYS` below, exactly as `SLOT_SETTINGS_NOTE_KEY`
  // already does for the settings sentence: `t(SLOT_OWN_TIME_KEYS.name)` is a
  // runtime-built key as far as the checker is concerned, and is skipped.

  'slots.ownTitle': { en: 'Your own times', hi: 'आपके अपने समय' },
  'slots.ownAdd': { en: 'Add your own time', hi: 'अपना समय जोड़ें' },
  'slots.ownNewTitle': { en: 'Add your own time', hi: 'अपना समय जोड़ें' },
  'slots.ownEditTitle': { en: 'Change this time', hi: 'यह समय बदलें' },
  'slots.ownName': { en: 'Name for this time', hi: 'इस समय का नाम' },
  'slots.ownNameHelp': {
    en: 'Your own words — “with tea”, “after my walk”. Up to {{max}} letters.',
    hi: 'आपके अपने शब्द — “चाय के साथ”, “सैर के बाद”। ज़्यादा से ज़्यादा {{max}} अक्षर।',
  },
  'slots.ownAddConfirm': { en: 'Add this time', hi: 'यह समय जोड़ें' },
  'slots.ownKeep': { en: 'Keep this time', hi: 'यह समय रखें' },
  'slots.ownRemove': { en: 'Remove this time', hi: 'यह समय हटाएँ' },
  'slots.ownAdded': {
    en: '{{name}} is now one of your times.',
    hi: '{{name}} अब आपके समयों में शामिल है।',
  },
  'slots.ownFull': {
    en: 'You can have up to {{max}} times of your own.',
    hi: 'आप ज़्यादा से ज़्यादा {{max}} अपने समय रख सकती हैं।',
  },
  /**
   * The undo path, said out loud at the moment the slot is created.
   *
   * A custom slot added from the schedule screen is written to the profile immediately,
   * and from that screen there is no way to take it back — the only remove affordance is
   * in Settings, which nothing on the schedule screen mentions. Three experiments and the
   * picker is twelve chips long with no visible way to shorten it. The route is spelled
   * out in WORDS rather than with an arrow ('Settings → Medicine times of day') because
   * TalkBack reads '→' as "right arrow" in the middle of a sentence, or skips it, and
   * either way the one thing she needs out of this sentence is the thing that is lost.
   */
  'slots.ownRemoveHint': {
    en: 'You can remove it later in Settings, under Medicine times of day.',
    hi: 'इसे बाद में सेटिंग में, “दवाई के समय” में जाकर हटाया जा सकता है।',
  },

  // The clock stepper that sits inside the naming form. Both screens draw one; the
  // TalkBack labels below are the settings screen's wording, which reads better for a
  // clock than "बाद / पहले" (later/earlier for a time of day is आगे / पीछे, not
  // after/before, which a Hindi speaker hears as a meal relation on this of all screens).
  'slots.ownHour': { en: 'Hour', hi: 'घंटा' },
  'slots.ownMinute': { en: 'Minute', hi: 'मिनट' },
  'slots.ownHourUp': { en: 'One hour later', hi: 'एक घंटा आगे' },
  'slots.ownHourDown': { en: 'One hour earlier', hi: 'एक घंटा पीछे' },
  'slots.ownMinuteUp': { en: 'Five minutes later', hi: 'पाँच मिनट आगे' },
  'slots.ownMinuteDown': { en: 'Five minutes earlier', hi: 'पाँच मिनट पीछे' },
  'slots.ownClockNote': {
    en: 'The clock is 24-hour, so 20:00 means eight in the evening.',
    hi: 'घड़ी 24 घंटे की है, इसलिए 20:00 का मतलब शाम के आठ बजे।',
  },
};

/**
 * The keys of the shared "name a time of your own" copy, so a screen can render it
 * WITHOUT writing the key as a quoted literal — see the long note above the strings.
 *
 * `as const` so a typo is a compile error rather than a key path rendered on screen.
 */
export const SLOT_OWN_TIME_KEYS = {
  title: 'slots.ownTitle',
  add: 'slots.ownAdd',
  newTitle: 'slots.ownNewTitle',
  editTitle: 'slots.ownEditTitle',
  name: 'slots.ownName',
  nameHelp: 'slots.ownNameHelp',
  addConfirm: 'slots.ownAddConfirm',
  keep: 'slots.ownKeep',
  remove: 'slots.ownRemove',
  added: 'slots.ownAdded',
  full: 'slots.ownFull',
  removeHint: 'slots.ownRemoveHint',
  hour: 'slots.ownHour',
  minute: 'slots.ownMinute',
  hourUp: 'slots.ownHourUp',
  hourDown: 'slots.ownHourDown',
  minuteUp: 'slots.ownMinuteUp',
  minuteDown: 'slots.ownMinuteDown',
  clockNote: 'slots.ownClockNote',
} as const;

/**
 * The key of the sentence above, so a screen can render it WITHOUT writing the key as a
 * quoted literal.
 *
 * `scripts/check-i18n.js` resolves a literal `t('…')` key only against `LocalStrings`
 * entries declared in the SAME file; spreading `SLOT_STRINGS` into a screen's own map does
 * not satisfy its regex. Going through this constant is read as a runtime-built key and
 * skipped, exactly as `slotLabel(def, t)` already is — which is what lets the sentence
 * live in one file instead of being copied into every screen that shows it.
 */
export const SLOT_SETTINGS_NOTE_KEY = 'slots.settingsNote';

/**
 * The i18n key for a slot that HAS one.
 *
 * Narrowed to built-in and legacy keys on purpose. It used to take any `SlotKey`, and
 * under the widened `SlotKey` that would happily produce `'slots.custom:9f3a1c02'` — a
 * key that resolves to itself and puts a hex string on screen. Anything that might be a
 * custom slot goes through `slotLabel` instead.
 */
export function slotI18nKey(slot: BuiltinSlotKey | LegacySlotKey): string {
  return `slots.${slot}`;
}

/**
 * The visible name of a slot: the bundle's word for a built-in, the user's own words for
 * a custom one.
 *
 * A CUSTOM LABEL IS NEVER TRANSLATED. It renders verbatim in English and in Hindi,
 * because it is not a string the app wrote — it is something the patient typed, possibly
 * a doctor's word, possibly a family nickname for a tablet. Passing it through `t()`
 * would only return it unchanged by accident, and would return something else entirely
 * the day it happened to equal a bundle key.
 *
 * `t` is typed structurally (`(key: string) => string`) so this module stays free of
 * `@/i18n`, which pulls in React.
 */
export function slotLabel(def: SlotDefinition, t: (key: string) => string): string {
  if (def.label !== null) return def.label;
  if (def.i18nKey !== null) return t(def.i18nKey);
  // Unreachable by construction: every definition carries one or the other. Falling back
  // to the clock time still tells the truth rather than rendering an empty chip, which
  // TalkBack would announce as an unnamed checkbox.
  return def.time;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Wall-clock times and key shapes
// ═══════════════════════════════════════════════════════════════════════════════

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isWallClock(value: string): boolean {
  return TIME_PATTERN.test(value);
}

const CUSTOM_KEY_PATTERN = /^custom:[0-9a-f]{8}$/;

export function isCustomSlotKey(key: string): boolean {
  return CUSTOM_KEY_PATTERN.test(key);
}

export function isBuiltinSlotKey(key: string): key is BuiltinSlotKey {
  return (BUILTIN_SLOT_KEYS as readonly string[]).includes(key);
}

export function isLegacySlotKey(key: string): key is LegacySlotKey {
  return (LEGACY_SLOT_KEYS as readonly string[]).includes(key);
}

/**
 * A fresh key for a slot the user just invented.
 *
 * This is an IDENTITY, not a secret and not a sync id — it only has to stay distinct from
 * the handful of other slots on this one profile, and `validateCustomSlots` refuses a
 * duplicate outright. `Math.random` keeps the module free of `expo-crypto`, which would
 * drag a native dependency into the half of this file that must load under `node --test`.
 */
export function newCustomSlotKey(): string {
  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return `custom:${hex}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Reading stored state — tolerant, because it is already on disk
// ═══════════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stored times merged over the defaults, KEY BY KEY.
 *
 * This per-key merge is what makes nine slots invisible to an already-installed build: a
 * blob written by the four-slot version carries `midday`/`evening`/`bedtime` and those
 * three survive untouched, while the six new keys fall back to their defaults. Reading the
 * whole object and using it wholesale would blank every key the old blob does not carry.
 *
 * A MALFORMED STORED TIME FALLS BACK TO THE DEFAULT rather than propagating into an alarm
 * rule: Kotlin parses `time_local` strictly and would simply drop the rule, so a single
 * corrupt character would silently stop a reminder rather than showing a wrong one.
 *
 * ── ADOPTING A RETIRED `morning` ──
 * `'morning'` is the one old key with no successor: it split into `before_breakfast` and
 * `after_breakfast`. A generic per-key merge would therefore throw away the value of the
 * one setup step the wizard refuses to skip — a user who moved Morning to 06:00 would
 * find 08:00 back, and her existing 06:00 schedule rows would stop resolving to any named
 * slot at all. So a stored `morning` is adopted as `before_breakfast`, but ONLY when
 * `before_breakfast` has no stored value of its own AND the adopted time does not collide
 * with another built-in (rule 3 in the header: adoption must not manufacture a duplicate).
 * If it would collide, the colliding built-in already names that time and nothing is lost.
 *
 * ── WHY THE RESULT IS SETTLED AFTERWARDS ──
 * The per-key merge on its own MANUFACTURES the very duplicate rule 3 exists to prevent,
 * with no user action at all. The four-slot build shipped midday 13:00 and evening 19:00,
 * and each of those is one stepper session away from a minute that is now the DEFAULT of
 * one of the six new keys: a stored `evening = '20:30'` lands on `after_dinner`, a stored
 * `midday = '14:00'` lands on `after_lunch`, and so on. The consequences are not cosmetic —
 * `plannedSlots` in the prescription review drops a dose whose slot has already claimed
 * that minute, so a four-times-a-day prescription silently writes three rows; and
 * `settings/slots.tsx` disables Save while any pair clashes, so the screen opens dead over
 * a pair the user never touched. `settleSlotTimes` therefore guarantees the postcondition
 * this function has always been read as having: `validateSlotTimes(mergeSlotTimes(x))` is
 * `ok` for every input. Stored values keep their minute (invariant 4); a key still holding
 * its DEFAULT is the one that moves.
 */
export function mergeSlotTimes(stored: unknown): Record<BuiltinSlotKey, string> {
  const out: Record<BuiltinSlotKey, string> = { ...DEFAULT_SLOT_TIMES };
  if (!isRecord(stored)) return out;

  const fromStorage = new Set<BuiltinSlotKey>();
  for (const slot of BUILTIN_SLOT_KEYS) {
    const value = stored[slot];
    if (typeof value === 'string' && isWallClock(value)) {
      out[slot] = value;
      fromStorage.add(slot);
    }
  }

  if (!fromStorage.has('before_breakfast')) {
    const morning = stored.morning;
    if (typeof morning === 'string' && isWallClock(morning)) {
      const collides = BUILTIN_SLOT_KEYS.some(
        (slot) => slot !== 'before_breakfast' && out[slot] === morning,
      );
      if (!collides) {
        out.before_breakfast = morning;
        // Adopted from storage, so it is as pinned as any other stored value: if a default
        // has to move out of its way, the default is the one that moves.
        fromStorage.add('before_breakfast');
      }
    }
  }

  return settleSlotTimes(out, fromStorage);
}

const DAY_MINUTES = 1440;

/**
 * The grid every stepper in the app moves on. A nudge lands on it too.
 *
 * Exported because both custom-slot creation flows draw their own minute stepper and each
 * had its own private copy of this number. They agreed — which is exactly why it was worth
 * removing: the day one of them moves to a ten-minute grid, the other keeps offering
 * minutes the first can no longer reach, and `defaultNewCustomSlotTime` below (which snaps
 * to this grid) starts handing one of the two screens a time its own steppers cannot
 * return to once she has stepped off it.
 */
export const SLOT_MINUTE_STEP = 5;

const NUDGE_STEP = SLOT_MINUTE_STEP;

function toMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function fromMinutes(total: number): string {
  const wrapped = ((total % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hour = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const minute = String(wrapped % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * The nearest free five-minute position to `base`, searched outwards, later first.
 *
 * Later first because the key being moved is almost always the one whose meal has already
 * happened — After dinner pushed off Evening's 20:30 belongs at 20:35, not 20:25, which
 * would put it before the dinner it is named after. Nine slots on 288 positions means the
 * scan always finds one; the loop is bounded regardless.
 */
function firstFreeTime(base: number, taken: ReadonlySet<string>): string {
  for (let offset = NUDGE_STEP; offset < DAY_MINUTES; offset += NUDGE_STEP) {
    const later = fromMinutes(base + offset);
    if (!taken.has(later)) return later;
    const earlier = fromMinutes(base - offset);
    if (!taken.has(earlier)) return earlier;
  }
  return fromMinutes(base);
}

/**
 * Nine times with no two on one minute, preferring the ones that came from storage.
 *
 * `pinned` claims its minutes first, in canonical order, so an upgrade never moves a time
 * the user set. Everything else — a key still on its shipped default — is placed after,
 * and steps aside if its default is already spoken for.
 *
 * TWO PINNED VALUES ON ONE MINUTE still resolve, canonically-earlier wins, and the other
 * moves. That should not be reachable (`setSlotTimes` refuses to write such a pair) but a
 * blob from some older or future build could carry one, and this is a READ: returning a
 * state the screen then refuses to save would strand the user with a dead Save button over
 * a value she cannot see the origin of. Tolerating it deterministically is the lesser evil.
 */
function settleSlotTimes(
  times: Record<BuiltinSlotKey, string>,
  pinned: ReadonlySet<BuiltinSlotKey>,
): Record<BuiltinSlotKey, string> {
  const out = { ...times };
  const taken = new Set<string>();
  const order = [
    ...BUILTIN_SLOT_KEYS.filter((slot) => pinned.has(slot)),
    ...BUILTIN_SLOT_KEYS.filter((slot) => !pinned.has(slot)),
  ];
  for (const slot of order) {
    const wanted = out[slot];
    if (!taken.has(wanted)) {
      taken.add(wanted);
      continue;
    }
    const moved = firstFreeTime(toMinutes(wanted), taken);
    out[slot] = moved;
    taken.add(moved);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4b. The clock arithmetic both custom-slot flows need
// ═══════════════════════════════════════════════════════════════════════════════
//
// `settings/slots.tsx` and `medicine/schedule.tsx` both let the user invent a time, and
// both grew their own copy of this arithmetic — a `joinTime`, a pair of hour/minute
// counters, a wrap rule at midnight. The copies drifted in the only way that matters:
// settings seeds a new slot from a free minute, schedule hard-codes 09:00. Everything
// below is exported so the two screens share one answer, and it is all PURE, so it is all
// tested — this is the half of the module that decides which minute a tablet rings on.

/**
 * `time` moved by `deltaMinutes`, WRAPPING at midnight.
 *
 * This is the whole of what a stepper button does: `+60`, `-60`, `+SLOT_MINUTE_STEP`,
 * `-SLOT_MINUTE_STEP`. Wrapping rather than clamping is deliberate — a woman whose dose is
 * at 23:45 pressing "five minutes later" means 00:00 more often than she means "nothing
 * happens", and a clamp gives her a button that silently stops working near the ends of
 * the day with no way to tell whether the tap registered. That is the exact interaction
 * (see the tremor note in the UI guidelines) that teaches her to stop trusting taps.
 *
 * A NON-WALL-CLOCK INPUT COMES BACK UNCHANGED. The alternative — coercing junk to a
 * plausible time — would turn a value the app cannot account for into one it can, right on
 * the path that writes an alarm. Every producer of these strings (`DEFAULT_SLOT_TIMES`,
 * `mergeSlotTimes`, `parseCustomSlots`) is already validated, so this is unreachable in
 * practice; `isWallClock` is exported for a caller that wants to check first.
 */
export function stepWallClock(time: string, deltaMinutes: number): string {
  if (!isWallClock(time)) return time;
  return fromMinutes(toMinutes(time) + Math.trunc(deltaMinutes));
}

/**
 * `'HH:MM'` from an hour and a minute, wrapping and zero-padded.
 *
 * `medicine/schedule.tsx` holds the picker as two numbers rather than a string, so it
 * needs this on every render. Wrapping means `joinWallClock(24, 0)` is `'00:00'` and
 * `joinWallClock(-1, 30)` is `'23:30'` — a counter that runs past either end produces a
 * real time instead of `'24:00'`, which `isWallClock` refuses and which would therefore
 * fail validation at Save with a message about a time she can see on screen and cannot
 * see anything wrong with.
 */
export function joinWallClock(hour: number, minute: number): string {
  return fromMinutes(Math.trunc(hour) * 60 + Math.trunc(minute));
}

/**
 * The inverse. Midnight for anything unparseable — unreachable for the same reason as
 * `stepWallClock`, and returning a value keeps the caller's `useState<number>` honest
 * rather than forcing a null branch through every stepper.
 */
export function splitWallClock(time: string): { readonly hour: number; readonly minute: number } {
  if (!isWallClock(time)) return { hour: 0, minute: 0 };
  const total = toMinutes(time);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/** The first free five-minute position at or after `base`, wrapping once around the day. */
function firstFreeAtOrAfter(base: number, taken: ReadonlySet<string>): string {
  for (let offset = 0; offset < DAY_MINUTES; offset += SLOT_MINUTE_STEP) {
    const candidate = fromMinutes(base + offset);
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable: 288 grid positions against at most nine built-ins plus MAX_CUSTOM_SLOTS.
  return fromMinutes(base);
}

/**
 * The time a NEW custom-slot form should open on.
 *
 * ─── WHAT IT REPLACES ─────────────────────────────────────────────────────────
 * `medicine/schedule.tsx` opened its picker on a hard-coded 09:00. If she already had a
 * slot on 09:00 — her own, or a built-in she had moved there — the form opened ALREADY IN
 * CONFLICT: she typed a name, pressed "Add this time", and was told the time was taken.
 * The app pre-loaded a value that could never work and then blamed her for it. She then
 * has to discover on her own that the steppers are the way out. `settings/slots.tsx`
 * avoided that by walking forward from a hard-coded 15:00 instead, so the two flows also
 * disagreed about where a new time starts. One function, called by both, and the
 * postcondition is the one that matters: THE RETURNED TIME IS NEVER ALREADY TAKEN.
 *
 * ─── WHY THE MIDDLE OF HER DAY, AND NOT "AFTER THE LAST TIME" ─────────────────
 * The anchor is the midpoint between her EARLIEST and LATEST configured time, snapped down
 * to the stepper grid, then walked forward to the first free position. Three reasons:
 *
 *  1. It is derived from her actual day, not from a number someone typed. A woman whose
 *     slots run 05:30–20:00 gets a form opening near 12:45; one whose day runs 09:00–23:00
 *     gets 16:00. On the shipped defaults (08:00 … 22:00) it is 15:00 — BYTE-IDENTICAL to
 *     what the settings screen already did, so the flow she uses today does not change
 *     under her while the arbitrary constant goes away.
 *
 *  2. It lands in the part of the day the nine built-ins cover most thinly. The defaults
 *     are dense around the three meals and empty in the long afternoon, which is where
 *     the custom slots people actually invent live ("with tea", "after my walk").
 *
 *  3. It does not MARCH. "The next free minute after the last configured time" sounds
 *     tidier and is worse: on the defaults it opens at 22:05, which is nobody's tea time,
 *     and each slot she adds pushes the next one five minutes further into the night —
 *     22:05, 22:10, 22:15 — so the form drifts away from her waking day the more she uses
 *     it. Anchoring on the midpoint keeps every successive add clustered in the same
 *     place, and the walk-forward only ever steps over the ones she has already made.
 *
 * Times that are not wall clock are ignored rather than trusted, and if NOTHING valid is
 * configured the span is taken from `DEFAULT_SLOT_TIMES` — the caller still gets a real
 * time to open on instead of a form seeded with junk.
 *
 * Pure and total. The result is always on the `SLOT_MINUTE_STEP` grid, so the steppers can
 * always get back to it, and always free, so `validateCustomSlots` cannot refuse it for a
 * reason she did not cause.
 */
export function defaultNewCustomSlotTime(
  times: Readonly<Record<BuiltinSlotKey, string>>,
  customs: readonly CustomSlot[],
): string {
  const taken = new Set<string>();
  const configured: number[] = [];

  for (const slot of BUILTIN_SLOT_KEYS) {
    const time = times[slot];
    if (typeof time !== 'string' || !isWallClock(time)) continue;
    taken.add(time);
    configured.push(toMinutes(time));
  }
  for (const custom of customs) {
    if (typeof custom?.time !== 'string' || !isWallClock(custom.time)) continue;
    taken.add(custom.time);
    configured.push(toMinutes(custom.time));
  }

  if (configured.length === 0) {
    for (const slot of BUILTIN_SLOT_KEYS) configured.push(toMinutes(DEFAULT_SLOT_TIMES[slot]));
  }

  const earliest = Math.min(...configured);
  const latest = Math.max(...configured);
  const middle = Math.floor((earliest + latest) / 2 / SLOT_MINUTE_STEP) * SLOT_MINUTE_STEP;
  return firstFreeAtOrAfter(middle, taken);
}

/** How many slots the user may invent. See the note on `MAX_CUSTOM_SLOTS`. */
export const MAX_CUSTOM_SLOTS = 6;

/** Longest custom label, in characters after trimming. */
export const MAX_CUSTOM_SLOT_LABEL = 24;

/**
 * Stored custom slots, parsed defensively.
 *
 * Every rejection here is silent and per-entry: this is a READ of a blob that is already
 * on the phone, so one bad entry must cost that entry and nothing else. Refusing the
 * whole array — or throwing — would empty the medicines list over a stray character.
 * Writes are where the user is told what is wrong; see `validateCustomSlots`.
 */
export function parseCustomSlots(stored: unknown): CustomSlot[] {
  if (!Array.isArray(stored)) return [];
  const out: CustomSlot[] = [];
  const keys = new Set<string>();
  const times = new Set<string>();

  for (const entry of stored) {
    if (out.length >= MAX_CUSTOM_SLOTS) break;
    if (!isRecord(entry)) continue;
    const { key, label, time } = entry;
    if (typeof key !== 'string' || !isCustomSlotKey(key) || keys.has(key)) continue;
    if (typeof time !== 'string' || !isWallClock(time) || times.has(time)) continue;
    if (typeof label !== 'string') continue;
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CUSTOM_SLOT_LABEL) continue;
    keys.add(key);
    times.add(time);
    out.push({ key, label: trimmed, time });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Ordering and lookup
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Where a definition sits in the canonical clock order. Custom slots all rank after every
 * built-in, so a tie between a built-in and a custom slot always resolves to the built-in
 * — the one with a name the app can translate.
 */
function canonicalRank(def: SlotDefinition): number {
  const index = (BUILTIN_SLOT_KEYS as readonly string[]).indexOf(def.key);
  return index === -1 ? BUILTIN_SLOT_KEYS.length : index;
}

/** The tie-break, used both for sorting and for `slotForTime`. Total and locale-free. */
function compareCanonical(a: SlotDefinition, b: SlotDefinition): number {
  const rank = canonicalRank(a) - canonicalRank(b);
  if (rank !== 0) return rank;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

function compareDefs(a: SlotDefinition, b: SlotDefinition): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return compareCanonical(a, b);
}

/**
 * Built-ins and customs as one list, SORTED BY THE TIME THE USER ACTUALLY CONFIGURED.
 *
 * Display order is her clock, not our array: if she moves Evening to 06:00 it belongs at
 * the top of the picker, because the only thing she can reliably scan for is the time.
 * Ties fall back to the canonical clock order, then to the key, so the ordering is TOTAL
 * — two slots on the same time produce the same list on every screen and on every render.
 */
export function buildSlotDefinitions(
  times: Readonly<Record<BuiltinSlotKey, string>>,
  customs: readonly CustomSlot[],
): SlotDefinition[] {
  const defs: SlotDefinition[] = BUILTIN_SLOT_KEYS.map((key) => ({
    key,
    time: times[key],
    kind: 'builtin' as const,
    i18nKey: slotI18nKey(key),
    label: null,
  }));
  for (const custom of customs) {
    defs.push({
      key: custom.key,
      time: custom.time,
      kind: 'custom' as const,
      i18nKey: null,
      label: custom.label,
    });
  }
  return defs.sort(compareDefs);
}

/**
 * The definition a stored `slot_key` should be rendered as.
 *
 * ALSO RESOLVES RETIRED KEYS. A row written by the four-slot build carries `'morning'`,
 * which is in no picker and in no `defs` array, and `dose_schedule` cannot be rewritten to
 * say otherwise. Returning a synthetic `kind: 'legacy'` definition is what keeps March's
 * schedule saying "Morning" instead of showing a bare time or, worse, borrowing the name
 * of whatever slot happens to sit at that hour today.
 *
 * Returns null for a key that is neither known nor legacy — a custom slot the user has
 * since deleted, most likely. The caller falls back to the row's own `time_local`, which
 * is always true.
 */
export function slotDefForKey(
  defs: readonly SlotDefinition[],
  key: SlotKey | null | undefined,
): SlotDefinition | null {
  if (!key) return null;
  const found = defs.find((def) => def.key === key);
  if (found) return found;
  if (isLegacySlotKey(key)) {
    return { key, time: '', kind: 'legacy', i18nKey: slotI18nKey(key), label: null };
  }
  return null;
}

/**
 * Reverse lookup, so a schedule row built from a raw time still shows its slot name.
 *
 * Deterministic even when `defs` is unsorted and even when two slots share `timeLocal`:
 * every match is compared and the canonically-earliest one wins, rather than "whichever
 * came first in the array". That matters because this decides which section of the
 * medicines list a medicine appears under, and a list that reshuffles itself between
 * renders is unusable for the person this app is for.
 */
export function slotForTime(
  defs: readonly SlotDefinition[],
  timeLocal: string,
): SlotDefinition | null {
  let best: SlotDefinition | null = null;
  for (const def of defs) {
    if (def.time !== timeLocal) continue;
    if (best === null || compareCanonical(def, best) < 0) best = def;
  }
  return best;
}

/**
 * The name to show against ONE `dose_schedule` row — the only read path for `slot_key`
 * in the UI, and the only place the precedence between "her clock" and "the stored key"
 * is decided.
 *
 * This lived as three byte-identical private copies (`rowSlot` in `(tabs)/medicines.tsx`,
 * `namedSlot` in `medicine/[id].tsx`, and an inline pair of expressions in
 * `dose/[occId].tsx`). They agreed today, which is exactly why the duplication was
 * dangerous: the three screens name the SAME dose, so the day one copy is amended and the
 * other two are not, the medicines list files a dose under "Evening", the medicine page
 * calls it "After dinner", and the dose page calls it a third thing — and nothing fails,
 * because each screen is internally consistent. For a user who navigates between these
 * three screens to check whether she has already taken a tablet, that is the worst
 * possible failure: it is silent, and it makes the app look like it is describing two
 * different doses. One function, one answer, on all three screens.
 *
 * THE CONFIGURED SLOT WINS. A dose at 08:00 is called whatever she has sitting on 08:00
 * today, so no two screens can disagree and no heading can state a time the dose does not
 * ring at.
 *
 * THE STORED KEY IS THE FALLBACK, AND ONLY WHEN IT IS RETIRED. `dose_schedule` is
 * append-only, so a row written by the four-slot build still says `'morning'`; resolving
 * it through `slotDefForKey` is the one thing that keeps a medicine set up in March
 * saying "Morning" instead of dropping into a nameless "Other times" heading that reads
 * as the app having forgotten what the dose was.
 *
 * A stored key that is still a LIVE slot is deliberately ignored. If her After lunch has
 * since moved to 14:30 and this row still rings at 14:00, "After lunch · 2:30 pm" over a
 * 2:00 pm dose is a plain falsehood; falling through to the bare time is the honest
 * answer, because the app really has no name for 14:00 any more.
 */
export function slotForRow(
  defs: readonly SlotDefinition[],
  timeLocal: string,
  storedKey: SlotKey | null | undefined,
): SlotDefinition | null {
  const configured = slotForTime(defs, timeLocal);
  if (configured) return configured;
  const stored = slotDefForKey(defs, storedKey);
  return stored !== null && stored.kind === 'legacy' ? stored : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Validation — the write side, where the user is told what is wrong
// ═══════════════════════════════════════════════════════════════════════════════
//
// Everything below returns a TYPED RESULT rather than throwing a string, because the
// message has to be rendered in Hindi as often as in English and a thrown English
// sentence cannot be translated at the point it is caught. The screen matches on
// `reason`, looks up its own copy, and fills in the slot names and times it is handed.

export type SlotTimesIssue =
  | { readonly reason: 'not_wall_clock'; readonly slot: BuiltinSlotKey; readonly time: string }
  | {
      readonly reason: 'duplicate_time';
      readonly slots: readonly [BuiltinSlotKey, BuiltinSlotKey];
      readonly time: string;
    };

export type SlotTimesValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issue: SlotTimesIssue };

/**
 * All nine times, checked before anything is stored.
 *
 * TWO SLOTS ON THE SAME TIME IS REFUSED, and both are named. It is not a cosmetic clash:
 * a medicine ticked for both writes two `dose_schedule` rows with the same `time_local`,
 * the `UNIQUE (thread_id, version, time_local)` constraint aborts, and the whole save
 * rolls back behind a generic "could not save". The user's only clue would be that
 * nothing happened. Catching it here, on the screen where she set the times, is the only
 * place the message can name what she has to change.
 *
 * The pair is reported in canonical order and the earliest pair wins, so the message is
 * stable across renders.
 */
export function validateSlotTimes(
  times: Readonly<Record<BuiltinSlotKey, string>>,
): SlotTimesValidation {
  for (const slot of BUILTIN_SLOT_KEYS) {
    const time = times[slot];
    if (typeof time !== 'string' || !isWallClock(time)) {
      return { ok: false, issue: { reason: 'not_wall_clock', slot, time: String(time) } };
    }
  }
  const seen = new Map<string, BuiltinSlotKey>();
  for (const slot of BUILTIN_SLOT_KEYS) {
    const time = times[slot];
    const earlier = seen.get(time);
    if (earlier !== undefined) {
      return { ok: false, issue: { reason: 'duplicate_time', slots: [earlier, slot], time } };
    }
    seen.set(time, slot);
  }
  return { ok: true };
}

export type CustomSlotIssue =
  | { readonly reason: 'too_many'; readonly max: number }
  | { readonly reason: 'bad_key'; readonly key: string }
  | { readonly reason: 'duplicate_key'; readonly key: string }
  | { readonly reason: 'label_empty' }
  | { readonly reason: 'label_too_long'; readonly max: number }
  /** `slot` is the built-in whose name it collides with, so the message can name it. */
  | { readonly reason: 'label_reserved'; readonly label: string; readonly slot: BuiltinSlotKey }
  | { readonly reason: 'not_wall_clock'; readonly time: string }
  | {
      readonly reason: 'duplicate_time';
      readonly time: string;
      /** The slot already on that time — a built-in key, or another custom key. */
      readonly otherKey: SlotKey;
    };

export type CustomSlotsValidation =
  | { readonly ok: true; readonly slots: readonly CustomSlot[] }
  | { readonly ok: false; readonly index: number; readonly issue: CustomSlotIssue };

/** Case- and whitespace-insensitive form, for comparing a typed label to a known name. */
function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Every name that is OFFERED, in both languages, mapped to the slot that owns it.
 *
 * A custom slot called "Evening" sitting next to the built-in Evening is not a clash the
 * app can resolve — the two chips read identically and only the time tells them apart, on
 * the one screen where reading the wrong chip moves a TB dose. Both languages are
 * reserved regardless of the current one, because the app can be switched after the fact.
 *
 * BUILT-INS ONLY. It used to be built from every entry in `SLOT_STRINGS`, which meant the
 * three RETIRED names and the never-rendered `slots.custom` were reserved too — so the
 * most natural Hindi names for a custom time, सुबह / दोपहर / रात, were refused with a
 * message telling her Aarogya already used that name "for one of the times above", when
 * none of the nine names above was that word. The app was stating something false and
 * giving her nothing to act on. Legacy names appear in no picker; there is nothing for a
 * custom label to be confused with.
 *
 * The value is the owning slot so the refusal can NAME it rather than gesture at a list.
 */
const RESERVED_LABELS: ReadonlyMap<string, BuiltinSlotKey> = new Map(
  BUILTIN_SLOT_KEYS.flatMap((slot): [string, BuiltinSlotKey][] => {
    const entry = SLOT_STRINGS[slotI18nKey(slot)];
    if (!entry) return [];
    return [
      [normaliseLabel(entry.en), slot],
      [normaliseLabel(entry.hi), slot],
    ];
  }),
);

/**
 * The ONE place custom slots are checked, so a picker, a settings screen and the write
 * path can never disagree about what is acceptable.
 *
 * Returns the slots with labels already trimmed — the caller stores what it gets back,
 * not what it passed in, so a trailing space cannot reach a chip or a TalkBack label.
 *
 * `builtinTimes` is required because rule 3 in the header spans both kinds: a custom slot
 * may not sit on a built-in's time any more than on another custom's.
 */
export function validateCustomSlots(
  slots: readonly CustomSlot[],
  builtinTimes: Readonly<Record<BuiltinSlotKey, string>>,
): CustomSlotsValidation {
  if (slots.length > MAX_CUSTOM_SLOTS) {
    return { ok: false, index: MAX_CUSTOM_SLOTS, issue: { reason: 'too_many', max: MAX_CUSTOM_SLOTS } };
  }

  // Built-in times are seeded first so the message can name the built-in a custom slot
  // collides with, rather than saying "some other slot".
  const byTime = new Map<string, SlotKey>();
  for (const slot of BUILTIN_SLOT_KEYS) byTime.set(builtinTimes[slot], slot);

  const keys = new Set<string>();
  const out: CustomSlot[] = [];

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot === undefined) continue;

    if (!isCustomSlotKey(slot.key)) {
      return { ok: false, index, issue: { reason: 'bad_key', key: slot.key } };
    }
    if (keys.has(slot.key)) {
      return { ok: false, index, issue: { reason: 'duplicate_key', key: slot.key } };
    }

    const label = slot.label.trim();
    if (label.length === 0) return { ok: false, index, issue: { reason: 'label_empty' } };
    if (label.length > MAX_CUSTOM_SLOT_LABEL) {
      return { ok: false, index, issue: { reason: 'label_too_long', max: MAX_CUSTOM_SLOT_LABEL } };
    }
    const reserved = RESERVED_LABELS.get(normaliseLabel(label));
    if (reserved !== undefined) {
      return { ok: false, index, issue: { reason: 'label_reserved', label, slot: reserved } };
    }

    if (!isWallClock(slot.time)) {
      return { ok: false, index, issue: { reason: 'not_wall_clock', time: slot.time } };
    }
    const otherKey = byTime.get(slot.time);
    if (otherKey !== undefined) {
      return { ok: false, index, issue: { reason: 'duplicate_time', time: slot.time, otherKey } };
    }

    keys.add(slot.key);
    byTime.set(slot.time, slot.key);
    out.push({ key: slot.key, label, time: slot.time });
  }

  return { ok: true, slots: out };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Storage
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The `app_meta` key every install's configured times ALREADY live under.
 *
 * BYTE-IDENTICAL TO WHAT SHIPPED, on purpose. Change one character and every phone
 * silently reverts to defaults: midday moves 13:00 → 12:00 and evening 19:00 → 17:00 on a
 * handset whose owner deliberately set them, and tomorrow's reminders move by an hour or
 * two with no notice and no way to tell.
 */
export const META_SLOT_TIMES_PREFIX = 'slot_times:';

/** A SEPARATE key, so custom slots and built-in times can never overwrite each other. */
export const META_CUSTOM_SLOTS_PREFIX = 'custom_slots:';

// The two helpers below duplicate four lines of `getMetaJson`/`setMetaJson` from
// `src/app/_shared/lib.tsx`. Importing them instead would make this module depend on the
// route layer, which pulls in React and expo-router and would take the pure half of this
// file out of `node --test` reach — see the file header. Four lines of SQL against a
// two-column table is the cheaper of the two prices.

async function readMetaJson(key: string): Promise<unknown> {
  const { queryFirst } = await import('../../db/repositories/_shared');
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [key],
  );
  const raw = row?.value ?? null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A corrupt blob must degrade to "not set", never take down a screen.
    return null;
  }
}

async function writeMetaJson(key: string, value: unknown): Promise<void> {
  const { getDb } = await import('../../db/repositories/_shared');
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [key, JSON.stringify(value)],
  );
}

export async function getSlotTimes(profileId: string): Promise<Record<BuiltinSlotKey, string>> {
  return mergeSlotTimes(await readMetaJson(`${META_SLOT_TIMES_PREFIX}${profileId}`));
}

/**
 * Stores all nine times, or refuses the lot.
 *
 * The throw is the LAST line of defence, not the user-facing one: a screen calls
 * `validateSlotTimes` first so it can render the problem in the user's language and name
 * the two slots that clash. Reaching the throw means a caller skipped that step, and a
 * partial write here would be worse than an exception.
 *
 * Callers must run `reconcile(profileId)` after this. Alarms already sitting in
 * AlarmManager keep the old times until they are re-armed, and a screen that says "saved"
 * while tomorrow morning still rings at the old hour is the one failure mode this app
 * cannot afford.
 */
export async function setSlotTimes(
  profileId: string,
  times: Readonly<Record<BuiltinSlotKey, string>>,
): Promise<void> {
  const check = validateSlotTimes(times);
  if (!check.ok) {
    const { issue } = check;
    throw new Error(
      issue.reason === 'not_wall_clock'
        ? `Slot ${issue.slot} is not a HH:MM wall clock time`
        : `Slots ${issue.slots[0]} and ${issue.slots[1]} are both set to ${issue.time}`,
    );
  }
  await writeMetaJson(`${META_SLOT_TIMES_PREFIX}${profileId}`, times);
}

export async function getCustomSlots(profileId: string): Promise<CustomSlot[]> {
  return parseCustomSlots(await readMetaJson(`${META_CUSTOM_SLOTS_PREFIX}${profileId}`));
}

/**
 * Stores the user's own slots, or refuses the lot. Same reasoning as `setSlotTimes`:
 * `validateCustomSlots` is what a screen calls to show the problem; this throw only fires
 * when nobody did. Note it validates against the CURRENTLY STORED built-in times, so a
 * screen that changes both must save the times first.
 */
export async function setCustomSlots(
  profileId: string,
  slots: readonly CustomSlot[],
): Promise<void> {
  const times = await getSlotTimes(profileId);
  const check = validateCustomSlots(slots, times);
  if (!check.ok) {
    throw new Error(`Custom slot ${check.index} is invalid: ${check.issue.reason}`);
  }
  await writeMetaJson(`${META_CUSTOM_SLOTS_PREFIX}${profileId}`, check.slots);
}

/**
 * Every slot this profile has, built-in and custom, sorted by the time she set.
 *
 * This is what screens should hold instead of a `Record` of times: it carries the label,
 * the kind and the key together, so a chip can show "After lunch · 2:00 pm" and the write
 * path can store the right `slot_key` without a second lookup.
 */
export async function resolveSlots(profileId: string): Promise<SlotDefinition[]> {
  const [times, customs] = await Promise.all([getSlotTimes(profileId), getCustomSlots(profileId)]);
  return buildSlotDefinitions(times, customs);
}
