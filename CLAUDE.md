# CLAUDE.md

Aarogya — offline-first Android chronic-care app. Expo SDK 54 / RN 0.81 / React 19 /
expo-router 6 / New Architecture / TS strict with `noUncheckedIndexedAccess`.

No server of ours, and no network until she opts in. Exactly TWO egress paths: Gemini, to
read a photographed prescription (`src/features/ai/`), and an optional Supabase project for
family sharing (`src/features/sync/`, dead until a URL and anon key are pasted into
Settings). `allowBackup="false"`, no device-transfer copy — **the phone holds the only
PLAINTEXT copy of the health record**; the capsule and the shared dataset are ciphertext she
holds the key to. That is why most rules below exist.

The user is an elderly woman in India managing cardiac disease, type-2 diabetes and **active
tuberculosis**; presbyopia, a tremor, large-text mode, reads Hindi and English. Her son built
it. Build 8 is on her phone; build 9 is built and sitting in `build-output/`, not yet
installed.

The source comments the WHY and the traps at length. Match that voice: when you write a
rule, write the failure it prevents.

## Safety rules — non-negotiable, gated by `npm run check:clinical`

- **Never diagnoses, never grades a value, never advises.** No "abnormal", "too high",
  "dangerous", "critical" (of a value), "normal range", "you should", "consult
  immediately". It prints the number.
- **"missed" never reaches a user-facing or printed surface.** The honest phrase is
  **"not recorded as taken"** — about the app's data, not her behaviour. The status is
  `no_record` (`src/features/dosing/deriveStatus.ts`).
- **Adherence is three buckets** (taken / not taken / no record) and the percentage is
  **suppressed entirely** after `NO_RECORD_RUN_SUPPRESSION_THRESHOLD = 3` consecutive
  no-record days. A doctor reading "31%" across a hole in a TB record may escalate to
  directly-observed therapy over an artefact the app manufactured.
- **Clinical targets ship blank.** `seed.ts` seeds no `target_range` row, for any metric,
  ever. A target is typed by a human and prints `set_by_label` + `set_on` in every chart
  legend. No band without a row. No threshold constant in a component.
- **Emergency values must be recordable.** CHECK constraints and `min_valid`/`max_valid`
  sit at *instrument* limits, never clinical plausibility — glucose 18 mg/dL is a
  hypoglycaemic emergency, not a typo. Implausibility is a soft, dismissible "did you
  mean?" from `softMin`/`softMax`.
- **Never red for a reading; colour is never the only signal.** Out-of-range is a hollow
  marker of the same colour plus a word. ~8% of men have red/green deficiency, OPD printers
  are monochrome, and a red number is a clinical verdict.
- **Refused permanently:** risk scores, drug-interaction checker, symptom checker,
  insulin/dose calculator, and any badge or streak on a doctor-facing surface.
- **The doctor's page is English in both languages** — every `report.*` key must be
  byte-identical in `en.json` and `hi.json`. `check:i18n` asserts it.

Escape hatch when a finding is genuinely wrong: `// clinical-language-ok: <reason>` on the
line or the line above. The reason is mandatory.

## Gates

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint
npm test                # node --test --experimental-strip-types "src/**/*.test.ts"
npm run check:i18n      # en/hi key parity + report.* byte-identity + t() keys resolve
npm run check:clinical  # the rules above, over a real tokenizer (comments exempt)
npm run check:bundle    # npx expo export — catches what tsc cannot
npm run check:all       # typecheck + check:i18n + check:clinical + check:bundle
```

**`check:all` does NOT run `lint` or `test`.** Run those separately, every time. Baseline
to hold: tsc clean, eslint 0/0, 655 tests passing, i18n 559 = 559, clinical clean.

`i18n 559 = 559` counts `src/i18n/*.json` and does NOT move when a screen gains copy —
new strings belong in that screen's `LocalStrings` map (see UI conventions). A jump in
that number means somebody put screen copy in the shared bundle.

`npm test` runs under Node's type-stripping loader, which resolves **neither the `@/*`
alias nor `expo-sqlite`** — a module that top-level-imports the db layer is unloadable in
tests. Convention: keep the deciding half pure and `await import(...)` the db half at call
time (`features/slots/registry.ts`, `features/prescriptions/confirm.ts`).

Four custom ESLint rules, each closing a hole nothing else catches: raw hex/rgb literals
banned in `src/app` + `src/components`; `Alert.alert`/`prompt` and global `alert`/`confirm`
banned there too — `useToast()` for information, `useConfirm()` for a decision; importing
`fontSize` from `@/theme` banned in screens (it is the BASE scale — use `useFontSizes()`,
or large-text mode is silently bypassed); `expo-notifications` banned project-wide, because
a second scheduler means a dose fires twice or not at all.

## The alarm layer — `modules/med-alarm/`

**Kotlin and JS never share the SQLite file.** Two processes writing the only copy of a
health history is the worst failure available. They exchange files under
`filesDir/medalarm/`: `horizon.json` (JS writes, Kotlin reads) and `journal/` — **one
complete file per event**, Kotlin writes, JS reads and unlinks. Never an append-only log: a
shared write offset between two processes is a race, and the record it drops is a `taken`
that later prints as a missed dose. Horizon tolerance is asymmetric — WRITE validates
fully before replacing a known-good file; READ tolerates anything and fails loud (stale
after `HORIZON_STALE_DAYS = 20`), never silent.

**The horizon holds recurrence RULES, not materialised dates.** `Materializer.kt` expands
them forward indefinitely on its own. A pre-computed seven-day list needs JS to top it up,
JS only runs when the app is foregrounded, and the whole product is built so she can tap
*Taken* from the notification and never open the app — so the list empties on day 8,
silently, for exactly the user it was built for.

**Schedules store wall clock (`'08:00'`), never an absolute epoch.** Occurrence epochs are
recomputed at every reconcile. A stored future timestamp is the bug that fires a TB alarm
at 04:30 after a timezone change.

In `src/features/dosing/`:

- `medAlarm.ts` — the funnel for scheduling and journal calls, and where the JS↔Kotlin
  contract is stated. Its header claims to be the only importer of the native module and is
  wrong: `reminder-health.tsx`, `setup/health.tsx` and `setup/reminders.tsx` import
  `modules/med-alarm` directly for probes. Survivable absence therefore lives at the MODULE
  boundary, not here — `modules/med-alarm/src/MedAlarm.ts` wraps `requireNativeModule()` in
  try/catch (it throws at *module scope* in Expo Go, a stale dev client or node tests, which
  is a white screen, not a missing feature) and every method no-ops with `isAvailable ===
  false`. Reminders failing is bad; refusing to record a dose because they are is worse.
- `reconcile.ts` — idempotent (occurrence ids are deterministic). **Rule A:** never
  materialise an occurrence whose moment has passed unless a row already exists. **Rule B:**
  retire stale same-day occurrences from the old slot time first, same transaction, and only
  those with nothing recorded. Window 2 days back / 14 forward — what the UI draws, not what
  the alarms depend on. **The published horizon is DEVICE-wide, never one profile's**
  (`deviceHorizon.ts`): `reconcile` does per-profile DB work but publishes the UNION of
  `buildAlarmRules` over every non-archived profile (safety rule R1), so switching the viewed
  profile cannot overwrite the file and silence another patient's TB dose. A per-day dose-time
  move lives in `dose_occurrence.override_time_local` and reaches reconcile through
  `override.ts::effectiveScheduledEpoch` (R2); the native ring still fires at the rule time
  until `Materializer.kt` learns per-date exceptions (see the note in `override.ts`).
- `journalDrain.ts` — parses, inserts and unlinks **each record independently**. One bad
  record in a batched transaction fails forever and holds every dose behind it out of the
  database; unplaceable records go to `dose_event_quarantine` and are unlinked.
- `watchdog.ts` — foreground catch-up, 15-minute grace, 7 days of history.

### Notification channels — `src/constants/channels.js`

CommonJS on purpose: read by both the runtime and `plugins/withNotificationChannels.js`,
which runs in Node at prebuild. Created exactly once, in `MainApplication.onCreate()`;
Kotlin only ever *reads* them.

- **Channels are IMMUTABLE after first creation.** To change importance, sound or DND
  behaviour you MUST bump the id (`_v1` → `_v2`). Editing in place is a no-op on every
  device that already has it.
- **Do NOT set `flags.enforceAudibility`.** It looks exactly like what "sound on silent"
  needs, and it reroutes to `STREAM_SYSTEM_ENFORCED`, which follows RING volume —
  reinstating the bug the design exists to avoid. Sound-through-silent comes from
  `USAGE_ALARM` → `STREAM_ALARM`, and nothing else.
- **A channel sound plays exactly ONCE.** No "keep ringing until answered" flag exists in
  the API. The ringing is a `MediaPlayer` the app owns — `AlarmPlayer.kt`, ~2 min, on its
  own HandlerThread. Which tiers ring is `AlarmSpec.ringsAsAlarm` in Kotlin (everything
  except `dose_low_v1`), not the channel table.
- `Notifications.canShowDose()` gates the player and **fails closed**: a looping alarm with
  no visible notification is a phone that rings for two minutes with no Taken button.

## Database — `src/db/`

`migrations.ts` is **append-only**: a migration's `version` equals its 1-based position in
`MIGRATIONS`, and `LATEST_VERSION = MIGRATIONS.length`. **Currently 7.** Never edit an
existing one. Add-only statements; the single DROP exception must be argued in the migration
and needs both halves — referenced by no code AND unable to hold user data on any install
that will run it (see v3). A backfill on an append-only table lifts its guard trigger with
`withTriggersOff()` inside the same transaction. The runner refuses a future-version
database, snapshots with `VACUUM INTO` first, wraps each migration in one exclusive
transaction that also sets `user_version`, and runs `integrity_check` + `foreign_key_check`
afterwards.

**Append-only truth, enforced by trigger:** `dose_event` (no UPDATE, no DELETE) is THE
TRUTH — the native layer can only append, which is the only model in which Kotlin and JS
cannot disagree. `medicine` and `dose_schedule` are versioned together on a shared
`thread_id` and refuse in-place UPDATE of clinical columns; versioning the medicine while
mutating its schedule corrupts the answer to "what was she taking in March?", which is the
whole point of the OPD report. `reading`, `symptom_event`, `lab_result` are soft-delete only.

**Derived caches, safe to rebuild:** `dose_occurrence.status` (from `deriveStatus(events)`),
`streak_state` and badges (recomputed from the event log, never incremented — a retro-edit
would corrupt a counter forever). `dose_event_quarantine`, `delivery_probe` and
`pending_file_delete` are device-local and never sync.

**The AI safety gate is a trigger, not a convention.**
`trg_occ_requires_confirmed_medicine` and `trg_occ_requires_confirmed_schedule` abort any
`dose_occurrence` insert whose medicine or schedule has a NULL `confirmed_by_user_at`. Both
exist because they fail separately: *"1-0-1 misread as QID" leaves the drug name perfectly
correct and quadruples the dose.*

**Censored readings.** A meter showing LO/HI is not a missing value, it is an inequality the
instrument produced. `value_qualifier` holds the direction, `qualifier_bound` the limit,
`v1` stays NULL — and `trg_reading_bound_is_not_a_value_{insert,update}` (v4) aborts a row
carrying both. The bound is **never printed as a bare number**; every surface goes through
`src/features/reports/data/censored.ts`.

`seed.ts` is idempotent `INSERT OR IGNORE`, so **adding a reference row needs no migration;
changing one does** — `INSERT OR IGNORE` cannot update a row a phone already has, and the
same build then orders the same chips two ways with nothing in the diff. `sortOrder` is an
**explicit field on every row, never the loop index**; positional renumbering is the silent
form of that bug. Metric keys (`bp`, `blood_glucose`, `weight`) are frozen — renaming one
orphans every reading recorded against it.

## What leaves the phone — `src/features/sync/`

Optional family sharing. `getSyncConfig()` returning null is the NORMAL case and every
function here must return quietly on an unconfigured phone — no throw, no log, no UI. The
server sees ciphertext, a link id, lamports and timestamps; the key rides in the link's
`#fragment`, which no HTTP client ever transmits. **The patient's device is the only
writer** — viewers are read-only, and `outbox.ts` has no conflict resolution because of it.

- **Both upload paths `SELECT *`**, so a column added anywhere starts travelling without
  anyone deciding it should. `redact.ts::stripLocalPaths()` is the one decision that has
  been made: drop every `*_uri` column before sealing, plus `record_edit`'s `old_value`/
  `new_value` when its `field` names such a column. There are exactly TWO sealing sites
  (`buildPayload`, `republish`) and both call it; a third must too, and nothing enforces it.
- **The NAME decides, never the value.** Value-sniffing for `file://` would run over
  `symptom_event.note` and `visit_log.notes` — her own account of her illness — and nothing
  in this app may quietly rewrite what she wrote.
- `isLocalPathColumn()` is deliberately the same predicate `backup/restore.ts` uses to
  re-point paths on restore, so the set restore repairs and the set sync refuses are one
  set. A test pins them against restore.ts's source. Widen both or neither.
- A key **dropped**, never nulled: `{image_uri: null}` asserts there is no image, which is
  false — it is on her phone and staying there.
- **Nothing reads the record stream yet**; the viewer renders only the sealed snapshot. Do
  not add fields for a reader that does not exist.

## Slots — `src/features/slots/registry.ts`

One source of truth for named dose times.

- `SlotKey` is deliberately `string`. **Never narrow it to a union** — `dose_schedule` is
  append-only, so historical rows carry keys no longer offered, and a union makes those rows
  unrepresentable.
- `LEGACY_SLOT_KEYS = ['morning', 'afternoon', 'night']` must stay renderable forever and
  must never appear in a picker. `'morning'` is genuinely out there on phones.
- **No two slots may share a clock time.** `dose_schedule` has
  `UNIQUE (thread_id, version, time_local)` and `dose_occurrence.id` is
  `'<thread_id>:<local_date>:<time_local>'`. Writes REFUSE a collision; reads TOLERATE one
  deterministically — a read that threw would brick the medicines list over a value already
  on disk.

Row ids are UUIDv4, enforced by `assertOpaqueId()`, because the occurrence id is split back
apart on `':'`. Any id containing a colon attaches a dose to the wrong medicine.

## AI — `src/features/ai/`

**AI proposes, a human confirms** (the trigger above). It transcribes what is on the paper
and may say it cannot read something. It never invents a drug name, never picks clock times,
never comments on whether a prescription is correct or safe, never creates a row. Offsets
(book-ahead, turnaround, refill lead) are the app's, marked `anchor_source: 'inferred'` and
shown with their arithmetic.

### What "a human confirms" means now — the frequency is PRE-FILLED

It used to mean an empty box she typed into, and that is no longer true, so read this
before changing anything in `src/features/prescriptions/`. The number is proposed; the act
is still required. Three files hold the line and they only work together:

- **`propose.ts` decides whether a number may be OFFERED at all.** A frequency is proposed
  only when every transcription of that one line (`pattern_code`, `slot_notation`,
  `verbatim`) decodes to the same instruction, the model's own `doses_per_day` agrees, it
  is within `MAX_AI_DOSES_PER_DAY`, the model flagged nothing, it did not rate itself low,
  and there are WORDS to show. Otherwise a typed `FrequencyRefusal` says why, and the
  screen falls back to exactly the empty box that shipped before — which is the property
  that makes the whole feature safe: a refusal costs one typed digit, so this can improve
  on the old behaviour and cannot be worse than it.
- **`reviewGate.ts` holds the invariant, and it lives outside `src/app/` so a test can
  reach it.** *A number may be SEEDED into the field; `freqAnswer` is `'unanswered'`
  whenever one is.* `seedFrequency` puts the proposition up, `blockingReason` refuses to
  let it through until it is answered, and `reviewGate.test.ts` pins both. The specific
  "improvement" this exists to fail is seeding `'agreed'`, or deleting `freqAnswer` and
  inferring acceptance from a non-empty box. Either turns fifteen confirmations into one
  scroll and one tap, and **neither changes a single type** — `tsc` cannot see it and the
  trigger cannot see it, because a trigger can tell a confirmation from no confirmation
  but not a considered one from a reflex one.
- **`review.tsx` renders the answer and never re-decides it.** Two chips, neither selected
  on arrival, the decline first. The agreeing chip spells out the whole instruction —
  count, clock times, whether it skips days — because on the discharge summary this was
  built from, ten of twelve lines are once daily and a chip reading only "Once A Day"
  repeats ten times in ten identical positions, which is the rhythm the two-way question
  exists to break. And the evidence line above it says **"The app read these words … find
  them on the photo"**, never "On the paper": the quotation and the number come from one
  response to one image, so corroboration detects a correct transcription NORMALISED wrong
  and nothing detects a shared misread. Claiming the paper's authority for the app's
  reading quotes the error back to the one person who was about to catch it.
  **And the whole list is read back in literal clock times before anything is written** —
  but only when at least one number came off the photograph, because a dialog that fires on
  every prescription is one she learns to tap through. Its confirm sits at the BOTTOM of the
  scrolled list, inside the body, so reaching it means scrolling past every line; only
  "Change Something" is pinned, because the corrective must be reachable from the top. That
  ordering is the one defence here that does not depend on her attention holding — do not
  "fix" it by pinning the primary button.

Two consequences worth stating separately:

- **Her number decides HOW MANY; the paper only ever decides WHICH.** The decoded pattern
  supplies the slot layout ("HS" is bedtime, not dinner) only while its own dose count
  agrees with the number now in the field. **The skipped day is held higher still** —
  "daily" and "alternate day" both decode to one dose, so a matching count corroborates an
  interval not at all. `planSlots` adopts `intervalDays` only when `propose.ts` accepted
  the reading outright; otherwise the medicine goes to manual timing entry BY NAME rather
  than being flattened to daily or silently skipping days. Flattening is the same mistake
  pointing the other way and doubles a genuinely alternate-day dose.
- **The food relation is gated more loosely on purpose, and it is now SHOWN.** It used to
  travel from `draft.parsed` into a confirmed `dose_schedule` and speak in the alarm body,
  the OPD one-pager and the CSV without ever appearing on screen. It is a row of chips with
  the paper's mark quoted above it; what is written is what is selected there and nothing
  else, so an unproposed relation writes NULL where it used to write itself in. It does not
  block the confirm — food is a displacement, not a multiplier, and a second mandatory
  answer per card spends her attention on the gate that matters less.

`DoseTiming` (`'per_day' | 'as_needed' | 'one_off'`) is the third answer to "how often".
Neither non-default value is ever seeded — naming a line as-needed is an act, exactly like
agreeing to a count — and it is the only thing that lifts the dose-count requirement.
Without it a ticked SOS painkiller could only be saved by typing a number that would then
ring every day.

Three settings people "fix" and must not:

1. **`temperature: 1.0`, always.** Gemini 3 loops and degrades at low temperature.
   Determinism comes from `seed`.
2. **`thinkingLevel`, not `thinkingBudget`.** The old field is silently ignored, which looks
   exactly like thinking being switched off.
3. **`maxOutputTokens` is a COMBINED thinking + output budget.** At 8192 high thinking spent
   the lot, generation stopped at `MAX_TOKENS` with empty text, and the user was told to
   photograph fewer lines — which failed identically. That was "AI prescription scanning is
   not working". It is 32768 now; **a cap is not a spend**. Do not lower it.

Also: no `anyOf` anywhere in the response schema. `gemini.ts` performs exactly ONE HTTP
request and *returns* failures rather than throwing; retry lives once in `provider.ts`. The
key is in `expo-secure-store` under `aarogya_ai_api_key` (shared with the settings screen),
never logged, never in a URL, and never blocks launch — the app is fully usable without one.

**Decide on the structured field, never on the prose.** Four failures used to read
identically or wrongly, and three were the same mistake: an English sentence was matched
while the answer sat unread in a field beside it. `details[].reason` (a stable SCREAMING_SNAKE
enum, shape-checked before use) splits four flavours of 403 — `key_restricted` and
`api_not_enabled` name a fix in Cloud Console, and re-typing the key is the one action that
provably cannot work. `violations[].quotaId` and `quotaValue` split a 429 three ways, and
**`quotaValue: 0` is not an allowance spent but one that does not exist** — so `quota_zero`
drops the server's own `RetryInfo`, and `quotaValueOf` refuses a non-numeric string because
`Number('')` is 0 and would tell a healthy project it has no allowance. `usageMetadata`
splits `MAX_TOKENS` in two: no answer plus thought tokens is `thinking_budget_exhausted`
(the app's fault, fewer lines will not help), an answer that was cut is `truncated`. The
fourth was the opposite shape — the fact was never written down at all: a bad crop and an
unreadable photograph both ended at `medicines=0`, so `prep.page` now carries the rectangle
and **`defaultCrop` is the field that splits two opposite actions**. Adding a code to
`AiErrorCode` without both sentences is a `check:i18n` failure, by construction.

**`AiError.detail` reaches `prescription.extraction_error`, which SYNCS.** expo-image-manipulator
quotes the file URI inside its message by construction, so `imagePrep.ts::describe()` washes
every foreign message through `devlog/redact.ts::scrubText` — reused, never re-implemented,
so widening the patterns fixes both consumers. It runs unconditionally: it protects a
database column, not a log line.

**Developer log** (`src/features/devlog/`): OFF must cost nothing and store nothing — a
module-level boolean, no await, no file, not even an empty one; turning it off deletes what
exists. Guard hot call sites with `if (isRecording())` or the argument object is allocated
regardless. **Thirteen call sites, all guarded, asserted on the SOURCE** by
`ai/diagnosis.test.ts` — six in `gemini.ts`, three in `retry.ts`, four in
`prescriptions/extract.ts` — because a missing guard costs an allocation, not a note, and no
runtime assertion can see it. Adding one is meant to fail that test once and be answered by
raising the number deliberately. Redaction is an **allow-list**: numbers and booleans pass
unless the field name is clinical, strings pass only if the name is on `TEXT_FIELDS`,
everything else is dropped by type. The name decides — `quotaValue` travels as a number
because a limit is not a measurement, while `medicinesRead: 7` is refused and is renamed
`itemsRead` at its call site instead. A medicine name is a diagnosis, and the only use of
this feature is pasting its output into a chat window.

## UI conventions

- **Theme tokens only, never a raw hex.** `spacing.touchTarget` is 56, not 44; body text
  starts at 17sp; screens use `useFontSizes()`, never the base `fontSize` table.
- **`PressableScale` renders ONE node** — an animated `Pressable`. Do not reintroduce an
  `Animated.View` wrapper: it swallows every layout style the caller passes (RN's
  `flexShrink` default is 0, and a percentage basis lands on the column axis). That is how a
  two-column tile grid became one column and a 56dp number-pad key collapsed to glyph width.
- **Title Case** for buttons, tabs, screen titles and labels.
- **New copy goes in a screen-local `LocalStrings` map, `en` AND `hi`**, consulted by
  `useT()` after the shared bundle. Never a bare literal in JSX; `src/i18n/*.json` wins the
  moment a key lands there.
- **Every file under `src/app/` needs a default export**, helpers included — expo-router
  routes all of them and warns otherwise (`src/app/_shared/lib.tsx` default-exports a
  redirect home for exactly this). Prefer putting non-screen modules outside `src/app/`.

## Build

```bash
. ~/.aarogya/keystore.env   # AAROGYA_KEYSTORE_{PATH,PASSWORD}, AAROGYA_KEY_{ALIAS,PASSWORD}
npm run build:prod          # or build:qa, or build:prod:aab
```

- **The keystore env must be sourced.** A debug-signed "release" APK installs and runs
  perfectly and can then never be upgraded — the only path left is uninstall, which deletes
  the data directory, and there is no cloud backup by design. The worst outcome in the
  project, and it starts as a missing environment variable. The script refuses without all
  four.
- **`android/` is generated and deleted per build.** `expo prebuild` exits 0 having done
  nothing when the tree is dirty and the prompt is declined, so the script deletes the
  directory itself. Never hand-edit `android/`, and never run the build from inside it.
- **Bump `versionCode` in `app.config.ts` on every build you install anywhere.** Currently
  9. Android refuses an install whose code is not higher, and two APKs sharing a number is
  how you stop knowing what is on the phone. Bump it before the build, not after: the
  artifact is named `aarogya-prod-v<version>-build<code>.apk`, so rebuilding at the old
  number overwrites the file for the build that is actually on her phone — the same
  confusion the rule exists to prevent, arriving through the back door.
- APK budget **32 MB** (`scripts/check-size.js`); build 9 is 28.39 MB, 3.61 MB of headroom.
  Raise it only with a line in `docs/SIZE.md` saying what was added and why.
- `AAROGYA_DISTRIBUTION` decides the permission set and nothing else: `personal` declares
  the non-revocable `USE_EXACT_ALARM`, `play` falls back to the revocable
  `SCHEDULE_EXACT_ALARM`. The two builds are not equally reliable; that is policy, not a bug.
- `npm run gen:brand` runs `generate-icons.js` (geometry, dependency-free) **then**
  `generate-wordmark.py` (needs Pillow), which overwrites `icon.png` and `adaptive-icon.png`
  with the wordmark lockups. Running the JS script alone leaves those two as mark-only
  intermediates — correct images, silently missing the app's name. The outputs live in
  `assets/images/` and are not gitignored; a normal build runs neither script.

## Which doc answers which question

- Why a reminder did not fire; Doze, OEM killers, the adb test matrix — `docs/REMINDER-RELIABILITY.md`
- What the model may decide; schema, prompt, failure codes, cost — `docs/AI-EXTRACTION.md`
- Day card, OPD one-pager, CSV/PDF, wall chart and their shared rules — `docs/REPORTS.md`
- Encrypted capsule, recovery phrase, family link, rotation, threat model — `docs/SYNC-AND-BACKUP.md`
- Prebuild, dev client, release pipeline, troubleshooting — `docs/BUILD.md`
- Keystore generation, backup, verifying an artifact by hand — `docs/SIGNING.md`
- What holds the APK down, and how to investigate a regression — `docs/SIZE.md`
