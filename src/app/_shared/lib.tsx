/**
 * Shared plumbing for the route layer.
 *
 * ─── WHY THIS FILE HAS A DEFAULT EXPORT THAT REDIRECTS ────────────────────────
 * Expo Router turns EVERY `.ts`/`.tsx` file under the app root into a route — the only
 * exclusions are `_layout`, `+html`, `+api` and `+middleware` (see
 * expo-router/_ctx.android.js and build/getRoutesCore.js). There is no "ignore this
 * folder" convention. A helper module therefore becomes a route whose `loadRoute()`
 * warns "missing the required default export" the moment anything touches it — the
 * sitemap, a deep link typo, a dev-menu tap.
 *
 * The cheapest honest answer is to give it a real default export that sends the user
 * home. `/\_shared/lib` is then a valid, harmless route nobody links to, and the router
 * never warns. The alternative — duplicating the metric registry, the target-matching
 * rules and the "not recorded as taken" wording across sixty screens — is how two
 * screens end up disagreeing about what a reading means.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, View, type ImageStyle, type StyleProp } from 'react-native';
import { Redirect, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

import { useI18n, type Language, type TranslateFn, type TranslationParams } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Icon, Text } from '@/components/ui';
import type { MetricDef, OccurrenceStatus, Reading, TargetRange } from '@/types';
import { OCCURRENCE_STATUS_COPY } from '@/features/dosing/deriveStatus';
import { censoredUnitText } from '@/features/reports/data/censored';
import { seedReferenceData } from '@/db/seed';
import { getDb, queryAll, queryFirst, type Tx } from '@/db/repositories/_shared';
import { getDefaultProfile, listProfiles } from '@/db/repositories/profiles';
import { getActiveProfileId } from '@/db/repositories/settings';
import type { StatRange } from '@/components/ui';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Translation with a per-screen fallback dictionary
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A screen's own strings, keyed exactly like the bundle.
 *
 * `src/i18n/*.json` is owned by another part of the codebase and covers roughly a third
 * of the keys the route layer needs. `t()` degrades a missing key to the key itself,
 * which would put `entry.bp.armLeft` on screen in front of a user who cannot read
 * English, let alone a dotted path. So each screen declares the strings it introduces
 * next to the JSX that uses them, and `useT()` consults the bundle FIRST — the day those
 * keys land in en.json/hi.json the bundle silently wins and these become dead weight
 * that can be deleted in one pass.
 *
 * This is not a second translation system: the key is still the contract, both languages
 * are still mandatory, and nothing is ever a bare literal in JSX.
 */
export type LocalStrings = Readonly<Record<string, { readonly en: string; readonly hi: string }>>;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function fill(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

function resolve(
  bundled: TranslateFn,
  lang: Language,
  extra: LocalStrings | undefined,
  key: string,
  params?: TranslationParams,
): string {
  const fromBundle = bundled(key, params);
  // `t()` returns the key verbatim when it is missing. That exact identity is the
  // signal — a real translation is never equal to its own dotted path.
  if (fromBundle !== key) return fromBundle;
  const local = extra?.[key];
  if (!local) return key;
  return fill(lang === 'hi' ? local.hi : local.en, params);
}

/** The translate function every screen in this folder uses. */
export function useT(extra?: LocalStrings): TranslateFn {
  const { t, lang } = useI18n();
  return useCallback<TranslateFn>(
    (key, params) => resolve(t, lang, extra, key, params),
    [t, lang, extra],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Async loading
// ═══════════════════════════════════════════════════════════════════════════════

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Re-run the loader WITHOUT raising `loading`, so the screen keeps what it is showing
   * until the new answer replaces it. See the note on `refresh` in the hook below for
   * when this is the right handle and when it is a way to hide a real wait.
   */
  refresh: () => void;
};

/** React's own dependency comparison: same length, `Object.is` element by element. */
function sameDeps(a: React.DependencyList, b: React.DependencyList): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Load-on-mount with a reload handle.
 *
 * THE SEQUENCE GUARD ONLY GATES THE *RESULT*, NEVER THE `loading = false`. Gating both
 * is the classic bug where a superseded run leaves the skeleton on screen forever: the
 * newest run is the only one allowed to write data, and it is also the only one whose
 * completion can clear the spinner, so there is always exactly one owner of both.
 *
 * `loading` GOES BACK UP WHERE THE RUN IS ASKED FOR, NOT INSIDE THE EFFECT. There are
 * exactly two ways a fresh run starts — `reload()`, which is an event, and the caller's
 * deps changing, which is detectable during render by comparing them the way React does.
 * Raising the flag at those two points instead of in the effect body keeps the skeleton
 * and the run in the same commit (an effect would paint one frame of stale, not-loading
 * content first) and keeps this hook clear of a setState-inside-an-effect cascade.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The loader identity changes on every render at most call sites, so the effect is
  // keyed on the caller's declared deps instead. That is the same contract useEffect
  // itself offers, and it keeps screens from having to memoise every query.
  //
  // The ref is refreshed in an effect of its own rather than during render. Declaration
  // order is the guarantee that matters: this effect is declared ABOVE the loading
  // effect, so on any commit where both run, the newest loader is in place before the
  // run that calls it.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  // Deps changing means a different question is being asked, so the previous answer must
  // stop being shown as if it were the answer to the new one.
  const [seenDeps, setSeenDeps] = useState<React.DependencyList>(deps);
  if (!sameDeps(seenDeps, deps)) {
    setSeenDeps(deps);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    const mine = ++seq.current;
    loaderRef
      .current()
      .then((value) => {
        if (!mounted.current || mine !== seq.current) return;
        setData(value);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!mounted.current || mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the caller's declared deps, exactly as useEffect itself would be; `loaderRef` is a ref and `seq`/`mounted` are refs too.
  }, [...deps, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setTick((n) => n + 1);
  }, []);

  /**
   * The same run, without the skeleton — for a re-read that CONFIRMS something the screen
   * has already told the user happened.
   *
   * `reload()` is right when the answer on screen has become a question mark: different
   * deps, a failed attempt, a pull-to-refresh she asked for. It is wrong after a small,
   * already-reported, already-succeeded local edit, because raising `loading` swaps the
   * whole list for two skeleton bars and back. Deleting the fourth of five backup copies
   * collapsed roughly 900dp of content to ~180dp, the ScrollView clamped the offset, and
   * she landed at the top of the screen with a success toast over it — having to find her
   * place again to delete the next one, which is the workflow the delete button exists for.
   *
   * NOT a licence to hide waiting. If the caller cannot say what the screen should show
   * while the run is in flight — because it has nothing, or has something now known to be
   * wrong — that IS a loading state and `reload()` is the honest handle. `error` still
   * clears here: a stale failure must not outlive the run that was meant to answer it.
   */
  const refresh = useCallback(() => {
    setError(null);
    setTick((n) => n + 1);
  }, []);

  return { data, loading, error, reload, refresh };
}

/**
 * Re-run a loader whenever the screen comes back into view.
 *
 * Almost every list in this app is reachable from a screen that can change it — record a
 * reading, come back to Today, and the tile must already show it. Polling would cost
 * battery on a Go-class phone; focus is the exact moment the answer can have changed.
 */
export function useReloadOnFocus(reload: () => void): void {
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. app_meta — the app's small key/value store
// ═══════════════════════════════════════════════════════════════════════════════

export const META_SETUP_DONE = 'setup_complete';
export const META_ROLE = 'app_role';
export const META_LAST_HEALTH_RUN = 'health_check_last_run';
export const META_BP_STICKY = 'entry_bp_sticky';
export const META_REGISTRY_SEEDED = 'registry_seed_version';

// `META_SLOT_TIMES_PREFIX` used to be declared here. It now belongs to the slot registry
// (re-exported from section 6 below) — two copies of an app_meta key literal is how one
// of them eventually gets "tidied" and every install silently loses its configured times.
export { META_SLOT_TIMES_PREFIX } from '@/features/slots/registry';

export async function getMeta(key: string, tx?: Tx): Promise<string | null> {
  const row = await queryFirst<{ value: string | null }>(
    `SELECT value FROM app_meta WHERE key = ?;`,
    [key],
    tx,
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO app_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [key, value],
  );
}

export async function getMetaJson<T>(key: string): Promise<T | null> {
  const raw = await getMeta(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt blob must degrade to "not set", never take down a screen.
    return null;
  }
}

export async function setMetaJson(key: string, value: unknown): Promise<void> {
  await setMeta(key, JSON.stringify(value));
}

export type AppRole = 'patient' | 'viewer';

export async function getAppRole(): Promise<AppRole> {
  return (await getMeta(META_ROLE)) === 'viewer' ? 'viewer' : 'patient';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. The metric / symptom / lab registry
// ═══════════════════════════════════════════════════════════════════════════════
//
// `migrations.ts` creates the registry tables but seeds no rows — the schema is data,
// and the data belongs to the product. `createReading()` refuses an unknown metric_key,
// so without this seed the four entry tiles cannot write anything at all.
//
// Every statement is INSERT OR IGNORE against a natural primary key, so it is safe to
// run on every cold start and safe to run alongside a future migration that seeds the
// same rows. Nothing here is a clinical threshold: `min`/`max` are INSTRUMENT limits,
// `softMin`/`softMax` only trigger a "did you mean?" confirmation, and `target_range`
// stays empty exactly as designed.

export const METRIC_BP = 'bp';
export const METRIC_SUGAR = 'blood_glucose';
export const METRIC_WEIGHT = 'weight';

export const PACK_CARDIAC = 'cardiac';
export const PACK_DIABETES = 'diabetes';
export const PACK_TB = 'tb';

/** Sugar contexts, in the order the chips are shown. */
export const SUGAR_CONTEXTS = [
  { value: 'fasting', i18nKey: 'entry.sugar.context.fasting' },
  { value: 'before_meal', i18nKey: 'entry.sugar.context.beforeMeal' },
  { value: 'after_meal', i18nKey: 'entry.sugar.context.afterMeal' },
  { value: 'bedtime', i18nKey: 'entry.sugar.context.bedtime' },
  { value: 'random', i18nKey: 'entry.sugar.context.random' },
] as const;

export type SugarContext = (typeof SUGAR_CONTEXTS)[number]['value'];

/** The context key written into `reading.context` for glucose. */
export const SUGAR_CONTEXT_KEY = 'meal';

/**
 * `SYMPTOM_SEED` USED TO BE HERE. IT IS GONE, AND THIS NOTE IS WHY IT MUST NOT COME BACK.
 *
 * It was a hard-coded list of twelve symptom chips, used by the symptom entry screen as
 * its offline fallback. It was also the whole of report 4: "In How I Feel, there should be
 * an option to select 'Vomiting' as well."
 *
 * There already was one. `src/db/seed.ts` defines `nausea_vomiting` — "Feeling sick or
 * vomiting" / "जी मिचलाना या उल्टी" — and maps it to the tuberculosis pack. It never
 * reached the screen, because this list did not contain it and the screen also capped
 * itself at twelve chips. Three of the symptoms that matter most to somebody on TB
 * treatment (`blood_in_sputum`, `yellow_eyes`, `dark_urine`) were unreachable in every
 * build ever shipped, for the same reason.
 *
 * The screen now reads `listSymptomDefsForProfile()`, so the chips are whatever the
 * database says her conditions call for — which is the only list that can be right, since
 * pack membership lives in the database and cannot be mirrored in a constant here without
 * going stale exactly like this one did. The degraded path uses `BASE_SYMPTOMS` from
 * `@/db/seed`, which is the same data the seed inserts rather than a second copy of it.
 *
 * A future "helpful" reintroduction of a literal list in this file rebuilds the bug.
 */

export const LAB_SEED = [
  { key: 'hba1c', en: 'HbA1c', hi: 'एचबीए1सी', unit: '%' },
  { key: 'fasting_glucose', en: 'Fasting blood sugar', hi: 'खाली पेट ब्लड शुगर', unit: 'mg/dL' },
  { key: 'post_meal_glucose', en: 'Post-meal blood sugar', hi: 'खाने के बाद ब्लड शुगर', unit: 'mg/dL' },
  { key: 'creatinine', en: 'Creatinine', hi: 'क्रिएटिनिन', unit: 'mg/dL' },
  { key: 'total_cholesterol', en: 'Total cholesterol', hi: 'कुल कोलेस्ट्रॉल', unit: 'mg/dL' },
  { key: 'ldl', en: 'LDL cholesterol', hi: 'एलडीएल कोलेस्ट्रॉल', unit: 'mg/dL' },
  { key: 'hdl', en: 'HDL cholesterol', hi: 'एचडीएल कोलेस्ट्रॉल', unit: 'mg/dL' },
  { key: 'triglycerides', en: 'Triglycerides', hi: 'ट्राइग्लिसराइड', unit: 'mg/dL' },
  { key: 'haemoglobin', en: 'Haemoglobin', hi: 'हीमोग्लोबिन', unit: 'g/dL' },
  { key: 'potassium', en: 'Potassium', hi: 'पोटैशियम', unit: 'mmol/L' },
  { key: 'liver_alt', en: 'Liver test (ALT/SGPT)', hi: 'लिवर जाँच (ALT/SGPT)', unit: 'U/L' },
  { key: 'sputum_afb', en: 'Sputum test (AFB)', hi: 'बलगम जाँच (AFB)', unit: null },
  { key: 'chest_xray', en: 'Chest X-ray', hi: 'छाती का एक्स-रे', unit: null },
] as const;

// THE METRIC FIELD SCHEMAS USED TO BE DUPLICATED HERE. They are not any more.
//
// `src/db/seed.ts` carries the single definition of every metric's fields, instrument
// limits and `softMin`/`softMax` plausibility band, and `ensureRegistrySeeded()` below
// delegates to it. The copies that used to sit at this spot were already dead code — read
// by nothing, and free to drift from the values actually written to the database.

const REGISTRY_SEED_VERSION = '1';

/**
 * Idempotent registry seed. Cheap enough to run on every boot (three SELECT-free
 * INSERT OR IGNORE batches), and short-circuited by a marker in `app_meta` after the
 * first success so a warm start does no SQL at all.
 */
export async function ensureRegistrySeeded(): Promise<void> {
  if ((await getMeta(META_REGISTRY_SEEDED)) === REGISTRY_SEED_VERSION) return;

  // Delegates to the single seeder in src/db/seed.ts.
  //
  // This function used to carry its own narrower copy — 3 condition packs and 3
  // metrics, with tighter bounds. Two independent implementations of the same
  // reference data is a divergence waiting to happen: whichever ran first won, and
  // the loser silently disagreed about instrument limits. That is the kind of defect
  // that surfaces months later as "this glucometer reading will not save".
  //
  // The keys are deliberately frozen and identical on both sides (bp, blood_glucose,
  // weight, cardiac, diabetes, tb, …) — see the header of src/db/seed.ts.
  const db = await getDb();
  await seedReferenceData(db);

  await setMeta(META_REGISTRY_SEEDED, REGISTRY_SEED_VERSION);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Profile
// ═══════════════════════════════════════════════════════════════════════════════

let cachedProfileId: string | null = null;

/**
 * Drop the memo so the next `resolveProfileId()` re-reads the active pointer.
 *
 * MUST be called by the profile switcher after `setActiveProfileId`, and by anything that
 * archives or creates a profile. Without it a switch would set the pointer in `app_meta` but
 * every already-mounted screen would keep reading the OLD profile from this memo until the
 * process restarted — a wrong-patient view, which invites a wrong-patient ENTRY. Screens
 * re-run their loaders on focus (`useReloadOnFocus`), so a switch + invalidate + navigate is
 * all it takes for the whole app to swing to the new profile.
 */
export function invalidateProfileCache(): void {
  cachedProfileId = null;
}

/**
 * The profile whose data every screen reads and writes — the ACTIVE (viewed) profile.
 *
 * ─── VIEW SELECTOR, NOT ALARM SELECTOR (safety rule R1) ──────────────────────
 * This chooses whose rows the UI shows. It does NOT choose whose reminders ring: the alarm
 * horizon is device-wide (see `features/dosing/deviceHorizon.ts`), so every non-archived
 * profile's doses keep ringing no matter who is on screen. Switching this value moves the
 * view and nothing else — it can never stop, drop or double another profile's TB dose.
 *
 * The active pointer lives in `app_meta` (device-local, never synced — see
 * repositories/settings.ts). It is VALIDATED here rather than trusted: a pointer can be null
 * (never chosen — the single-profile install), or stale (its profile was archived, and
 * `archiveProfile` deliberately does not reach in to clear it). Either way we fall back to
 * the default profile, which `archiveProfile`/`setDefaultProfile` guarantee always exists.
 * `listProfiles()` returns only live (non-archived) profiles, so an archived id fails the
 * membership check and drops to the fallback.
 */
export async function resolveProfileId(): Promise<string | null> {
  if (cachedProfileId) return cachedProfileId;

  const active = await getActiveProfileId();
  if (active) {
    const profiles = await listProfiles();
    if (profiles.some((profile) => profile.id === active)) {
      cachedProfileId = active;
      return cachedProfileId;
    }
  }

  const fallback = await getDefaultProfile();
  cachedProfileId = fallback?.id ?? null;
  return cachedProfileId;
}

/**
 * The active profile id, as async screen state.
 *
 * A lookup with a module-level memo rather than a context: a context would force every
 * screen through a provider it does not otherwise need, and the id changes only when the
 * user switches profiles — at which point `invalidateProfileCache()` clears the memo and
 * screens reload on focus.
 */
export function useProfileId(): AsyncState<string | null> {
  return useAsync(() => resolveProfileId(), []);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Named dose slots
// ═══════════════════════════════════════════════════════════════════════════════

//
// THE SLOT REGISTRY MOVED TO `src/features/slots/registry.ts`.
//
// It grew past four names: nine built-ins plus slots the user invents herself, each with
// stored times, validation and an ordering that has to be identical on every screen. That
// is a module, not a section — and it has to be reachable from `node --test`, which
// cannot load anything under this folder (React, expo-router, expo-sqlite).
//
// This block is a pure re-export so the eight screens importing from `_shared/lib` keep
// resolving. TWO NAMES CHANGED MEANING and are re-exported as the NEW thing on purpose,
// so `tsc` points at every call site instead of letting old semantics survive behind a
// familiar name:
//
//   • `SLOT_KEYS` is now the NINE built-in keys, not four.
//   • `slotForTime` now takes `SlotDefinition[]` (which carry labels and kinds) and
//     returns a `SlotDefinition | null`, not a `Record` of times and a key.
//   • `SlotKey` is now `string` — `dose_schedule.slot_key` holds built-in, `custom:<hex>`
//     and retired keys in one append-only column, so a union cannot represent it.
//   • `slotI18nKey` no longer accepts an arbitrary `SlotKey`; a custom slot has no i18n
//     key and must go through `slotLabel(def, t)`.

export {
  BUILTIN_SLOT_KEYS,
  BUILTIN_SLOT_KEYS as SLOT_KEYS,
  DEFAULT_SLOT_TIMES,
  LEGACY_SLOT_KEYS,
  MAX_CUSTOM_SLOTS,
  MAX_CUSTOM_SLOT_LABEL,
  META_CUSTOM_SLOTS_PREFIX,
  SLOT_MINUTE_STEP,
  SLOT_OWN_TIME_KEYS,
  SLOT_SETTINGS_NOTE_KEY,
  SLOT_STRINGS,
  buildSlotDefinitions,
  defaultNewCustomSlotTime,
  getCustomSlots,
  getSlotTimes,
  isBuiltinSlotKey,
  isCustomSlotKey,
  isLegacySlotKey,
  isWallClock,
  joinWallClock,
  mergeSlotTimes,
  newCustomSlotKey,
  parseCustomSlots,
  resolveSlots,
  setCustomSlots,
  setSlotTimes,
  slotDefForKey,
  slotForRow,
  slotForTime,
  slotI18nKey,
  slotLabel,
  splitWallClock,
  stepWallClock,
  validateCustomSlots,
  validateSlotTimes,
} from '@/features/slots/registry';

export type {
  BuiltinSlotKey,
  CustomSlot,
  CustomSlotIssue,
  CustomSlotsValidation,
  LegacySlotKey,
  SlotDefinition,
  SlotKey,
  SlotTimesIssue,
  SlotTimesValidation,
} from '@/features/slots/registry';

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Targets and range comparison
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The most specific target for a value.
 *
 * A context-specific target (fasting sugar) beats a general one; a general one is used
 * only when nothing context-specific exists. Returns null when the user's doctor has
 * given her no numbers at all, which is the shipping default and must stay usable —
 * every caller renders 'unknown' rather than inventing a band.
 */
export function matchTarget(
  targets: readonly TargetRange[],
  metricKey: string,
  field: TargetRange['field'],
  context: Record<string, string> | null,
): TargetRange | null {
  const candidates = targets.filter((x) => x.metricKey === metricKey && x.field === field);
  if (candidates.length === 0) return null;

  if (context) {
    const specific = candidates.find((target) => {
      if (!target.context) return false;
      return Object.entries(target.context).every(([key, value]) => context[key] === value);
    });
    if (specific) return specific;
  }
  return candidates.find((target) => !target.context) ?? null;
}

/** Where a value sits relative to a target the user's own doctor wrote down. */
export function rangeFor(target: TargetRange | null, value: number | null): StatRange {
  if (!target || value === null || !Number.isFinite(value)) return 'unknown';
  if (target.low !== null && value < target.low) return 'below';
  if (target.high !== null && value > target.high) return 'above';
  return 'in';
}

/** The provenance line every range comparison must carry. Never "set by Aarogya". */
export function targetFootnote(
  t: TranslateFn,
  target: TargetRange | null,
  formatDate: (localDate: string) => string,
): string | undefined {
  if (!target) return undefined;
  return t('reading.targetSetBy', { name: target.setByLabel, date: formatDate(target.setOn) });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Reading formatting
// ═══════════════════════════════════════════════════════════════════════════════

export function trimNumber(value: number): string {
  // 62.5 stays 62.5; 62.0 becomes 62. A trailing ".0" on a weight reads as noise.
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

/**
 * '142/88', '7.4', '62.5', 'Meter showed LO' — the value as a person would say it, unit
 * excluded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE QUALIFIER BRANCH IS NOT A REFINEMENT. IT IS THE BUG THIS FUNCTION HAD.
 *
 * This used to return `'—'` for any reading with no `v1`, and it never looked at the
 * qualifier sitting on the same row. A glucometer that prints LO stores exactly that: no
 * number, `value_qualifier = 'below_range'`, and the meter's floor in `qualifier_bound`
 * (a database trigger refuses a row carrying both — see migration v4). So the single
 * reading a doctor acts on fastest — a hypoglycaemic emergency — rendered as '— mg/dL',
 * which every reader on earth understands as "nothing was recorded".
 *
 * It did that on Today twice and on the son's remote viewer screen, which is the worst
 * place for it: he is looking at that screen precisely because he is not in the room.
 *
 * THE FALLBACK WHEN THERE IS NO TRANSLATOR IS NOT ENGLISH LEAKING INTO A HINDI UI. 'LO'
 * and 'HI' are what the DEVICE printed, in Latin letters, on a meter sold in India. They
 * are a readout, not prose — the same reason `censored.ts` calls them "the two letters the
 * meter itself displayed". Passing `t` is still preferred: it produces the fuller sentence
 * ("Meter showed LO" / "मशीन पर LO दिखा") that names where the word came from.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: print the bound. `qualifier_bound` is a limit, and a
 * limit rendered where a value goes is indistinguishable from a measurement to the next
 * person who reads it. The inequality belongs in a caption beside this, through
 * `inequalityText` in `features/reports/data/censored.ts`, which is the one place allowed
 * to turn a bound into words. See `readingDisplay` on the Today screen for the shape.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function formatReadingValue(reading: Reading, t?: TranslateFn): string {
  if (reading.valueQualifier === 'below_range' || reading.valueQualifier === 'above_range') {
    const low = reading.valueQualifier === 'below_range';
    if (t) return t(low ? 'reading.qualifierLow' : 'reading.qualifierHigh');
    return low ? 'LO' : 'HI';
  }
  if (reading.metricKey === METRIC_BP) {
    const systolic = reading.v1 === null ? '—' : trimNumber(reading.v1);
    const diastolic = reading.v2 === null ? '—' : trimNumber(reading.v2);
    return `${systolic}/${diastolic}`;
  }
  return reading.v1 === null ? '—' : trimNumber(reading.v1);
}

/**
 * The unit to print beside `formatReadingValue`, which for a censored reading is nothing.
 *
 * 'Meter showed LO mg/dL' is not a sentence. The unit belongs to a number, and the whole
 * point of a censored reading is that there is no number — it lives in the inequality
 * ('below 20 mg/dL') instead, where it modifies the bound it actually describes.
 *
 * Exists as a function rather than a note telling call sites to remember, because a call
 * site that renders a value and a unit in two different props (`StatCard`, and every
 * screen that uses it) has no natural place to keep them consistent.
 *
 * THE RULE ITSELF LIVES IN `features/reports/data/censored.ts`, not here. The OPD appendix
 * has a unit column too, it did not have this rule, and it printed
 * 'Meter showed LO (below 20 mg/dL) | mg/dL' on the doctor-facing page for exactly as long
 * as the two lived apart. One function, both surfaces.
 */
export function formatReadingUnit(reading: Reading, unit: string): string {
  return censoredUnitText(reading.valueQualifier, unit);
}

export function metricUnit(def: MetricDef | null, metricKey: string): string {
  if (def) return def.unit;
  if (metricKey === METRIC_BP) return 'mmHg';
  if (metricKey === METRIC_SUGAR) return 'mg/dL';
  if (metricKey === METRIC_WEIGHT) return 'kg';
  return '';
}

/**
 * Morning or evening, from the wall-clock time the reading carries.
 *
 * The BP chart encodes this as marker SHAPE rather than colour, so the split survives a
 * monochrome OPD printout and red/green colour deficiency alike.
 */
export function isMorningReading(localTime: string): boolean {
  const hour = Number(localTime.slice(0, 2));
  return Number.isFinite(hour) && hour < 12;
}

export function parseDecimal(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.endsWith('.')) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Dose status wording
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE WORD "MISSED" APPEARS NOWHERE, in either language.
 *
 * `no_record` means the app was told nothing — not that she failed. She may have taken
 * the tablet while the phone was charging in the next room, on a handset whose OEM had
 * already killed the alarm process. "Not recorded as taken" is the only honest sentence,
 * and Hindi gets the same care: "लिया गया दर्ज नहीं है" states the record, not the person.
 */
export const DOSE_STATUS_STRINGS: LocalStrings = {
  'dose.status.pending': { en: 'Due', hi: 'लेना है' },
  'dose.status.taken': { en: 'Taken', hi: 'ले लिया' },
  'dose.status.skipped': { en: 'Not taken', hi: 'नहीं लिया' },
  'dose.status.snoozed': { en: 'Reminding again later', hi: 'बाद में फिर याद दिलाएँगे' },
  'dose.status.cancelled': { en: 'Cancelled', hi: 'रद्द' },
  'dose.status.noRecord': { en: 'Not recorded as taken', hi: 'लिया गया दर्ज नहीं है' },
};

export function doseStatusKey(status: OccurrenceStatus): string {
  return OCCURRENCE_STATUS_COPY[status].i18nKey;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Reminder health summary
// ═══════════════════════════════════════════════════════════════════════════════

export type HealthCheckRow = {
  key: string;
  ok: boolean;
  detail: string | null;
  checkedAtEpoch: number;
};

export type ReminderHealthSummary = {
  /** True only when every stored check passed. Unknown (never run) is NOT a pass. */
  allOk: boolean;
  failed: HealthCheckRow[];
  checkedAtEpoch: number | null;
};

export async function loadReminderHealth(): Promise<ReminderHealthSummary> {
  const rows = await queryAll<{ key: string; ok: number; detail: string | null; checked_at_epoch: number }>(
    `SELECT key, ok, detail, checked_at_epoch FROM health_check_result;`,
  );
  const mapped: HealthCheckRow[] = rows.map((row) => ({
    key: row.key,
    ok: row.ok === 1,
    detail: row.detail,
    checkedAtEpoch: row.checked_at_epoch,
  }));
  const failed = mapped.filter((row) => !row.ok);
  const checkedAtEpoch = mapped.reduce<number | null>(
    (latest, row) => (latest === null || row.checkedAtEpoch > latest ? row.checkedAtEpoch : latest),
    null,
  );
  // Never run at all is reported as "not all ok" with zero failures, so the caller can
  // tell "we have not looked" apart from "we looked and it is fine".
  return { allOk: mapped.length > 0 && failed.length === 0, failed, checkedAtEpoch };
}

export async function saveHealthCheckResult(
  key: string,
  ok: boolean,
  detail: string | null,
  checkedAtEpoch: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO health_check_result(key, ok, detail, checked_at_epoch) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
                                      checked_at_epoch = excluded.checked_at_epoch;`,
    [key, ok ? 1 : 0, detail, checkedAtEpoch],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. AI key storage
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The AI key lives in SecureStore, never in `app_meta`.
 *
 * `app_meta` is inside the database file, and the database file is what the backup
 * capsule exports. A key in there would travel to whoever the capsule is shared with.
 */
const AI_KEY_STORE = 'aarogya_ai_api_key';

export async function getAiKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AI_KEY_STORE);
  } catch {
    return null;
  }
}

export async function setAiKey(value: string): Promise<void> {
  await SecureStore.setItemAsync(AI_KEY_STORE, value);
}

export async function clearAiKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AI_KEY_STORE);
  } catch {
    /* already gone */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. List and chart helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `getItemLayout` for a fixed-height row.
 *
 * Every list in this app declares one. Without it FlatList measures each row on the JS
 * thread as it scrolls, which on a 2 GB Go-class handset is the difference between a
 * list that moves and one that stutters — and a stuttering list is one this user taps
 * twice.
 */
export function fixedItemLayout(height: number) {
  return (_data: unknown, index: number) => ({ length: height, offset: height * index, index });
}

/**
 * Caps a series at `max` points by even decimation, keeping the first and last.
 *
 * Ninety points is roughly one per day of the longest period the app offers, and it is
 * also about the most an SVG chart can draw on a Go-class device without dropping
 * frames. Decimating rather than truncating keeps the shape of the whole period
 * instead of showing only its tail.
 */
export function capSeries<T>(items: readonly T[], max = 90): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) out.push(item);
  }
  const last = items[items.length - 1];
  if (last !== undefined && out[out.length - 1] !== last) out[out.length - 1] = last;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Strip / report thumbnail
// ═══════════════════════════════════════════════════════════════════════════════

export type ThumbProps = {
  uri: string | null;
  size?: number;
  /** Already translated. Describes what the picture is OF, for TalkBack. */
  label: string;
  style?: StyleProp<ImageStyle>;
};

/**
 * The photo of the strip.
 *
 * This is the single most important affordance on the medicine list for a user who
 * cannot comfortably read a 9-point drug name: "the white round one" is matchable from
 * a picture and unmatchable from text. When there is no photo the placeholder says so
 * with an icon rather than collapsing to nothing, so the row keeps its shape and the
 * list keeps its fixed height.
 */
export function Thumb({ uri, size = 72, label, style }: ThumbProps) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);

  if (!uri || failed) {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        style={{
          width: size,
          height: size,
          borderRadius: radii.md,
          borderWidth: 2,
          borderColor: colors.border,
          backgroundColor: colors.bgSunken,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="info" size={Math.round(size / 3)} color={colors.textMuted} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onError={() => setFailed(true)}
      resizeMode="cover"
      style={[
        {
          width: size,
          height: size,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.bgSunken,
        },
        style,
      ]}
    />
  );
}

/** A one-line plain caption under a chart. Never an interpretation of the data. */
export function ChartCaption({ text }: { text: string }) {
  return (
    <Text variant="caption" tone="muted" style={{ paddingTop: spacing.sm }}>
      {text}
    </Text>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Route placeholder — see the file header.
// ═══════════════════════════════════════════════════════════════════════════════

export default function SharedLibRoute() {
  return <Redirect href="/" />;
}
