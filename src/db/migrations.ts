/**
 * Schema migrations. Append-only list — index === user_version.
 *
 * RULES (enforced by review, and by the runner in ./index.ts):
 *  1. NEVER edit an existing migration. Ever. Add a new one.
 *  2. Add-only: ADD COLUMN / CREATE TABLE / CREATE INDEX. No DROP, no destructive ALTER.
 *     ONE NARROW EXCEPTION, and it must be argued in the migration itself: a table may be
 *     dropped when it is referenced by no code AND can hold no user data in any install
 *     that will ever run the migration. Both halves are required. "We don't use it any
 *     more" is not sufficient — someone's phone may already have rows in it. See v3.
 *  3. Each migration runs inside one exclusive transaction that also sets user_version.
 *  4. A migration that must backfill an append-only table has to DROP its guard trigger,
 *     do the work, and CREATE it again — inside the same transaction. See `withTriggersOff`.
 *
 * DESIGN NOTES worth reading before changing anything:
 *
 *  • Three timestamp forms on every clinical record, because they answer different
 *    questions: `at_epoch` (ordering, arithmetic), `local_date` (grouping — never compute a
 *    date inside a WHERE clause), `local_time` (display + time-of-day analysis).
 *
 *  • Schedules store WALL CLOCK ('08:00') and never an absolute epoch. Occurrence epochs are
 *    recomputed at every reconcile. Storing a future timestamp is the bug that fires a TB
 *    alarm at 04:30 after a timezone change.
 *
 *  • `dose_event` is append-only and is the TRUTH. `dose_occurrence.status` is a derived
 *    cache recomputed by deriveStatus(events). The native alarm layer can only ever append,
 *    so an append-only truth table is the only model where Kotlin and JS cannot disagree.
 *
 *  • `medicine` AND `dose_schedule` are BOTH append-only versioned on a shared `thread_id`.
 *    Versioning the medicine while mutating its schedule silently corrupts the answer to
 *    "what was she taking in March?", which is the whole point of the OPD report.
 *
 *  • CHECK constraints sit at INSTRUMENT limits, never clinical plausibility. A glucose of
 *    18 mg/dL is a hypoglycaemic emergency, not a typo — it is the one reading a doctor
 *    would act on immediately, and it must be recordable. Plausibility is a soft UI
 *    confirmation. `value_qualifier` records a glucometer showing LO/HI, and (from v4)
 *    `qualifier_bound` records the limit it was showing LO/HI against — so "LO" can be
 *    printed as "< 20 mg/dL" without a number the meter never produced ever reaching `v1`.
 *    A trigger, not a convention, keeps those two columns from being confused.
 *
 *  • `document.owns_file` says whether removing a row must also delete the file. A row
 *    that merely INDEXES a photograph another feature owns must never unlink it; a
 *    briefcase file the app copied in for that row has no other owner and must not
 *    survive its row. The deletion is made durable through `pending_file_delete` rather
 *    than attempted inline, because "the row is gone but the bytes are not" is the one
 *    outcome an offline-only, no-cloud app cannot leave behind.
 *
 *  • Every table carries `profile_id` from v1 so multi-profile in L4 is not a migration of
 *    every row, and `updated_at_epoch` + `lamport` + `deleted_at_epoch` so L3 sync is not a
 *    schema rewrite either.
 */

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
};

/** Guard triggers that a backfill migration may need to lift. See rule 4. */
export const APPEND_ONLY_TRIGGERS = [
  'trg_dose_event_no_update',
  'trg_dose_event_no_delete',
  'trg_medicine_no_update',
  'trg_dose_schedule_no_update',
] as const;

const V1_CORE = [
  `PRAGMA foreign_keys = ON;`,

  // ── Profiles ────────────────────────────────────────────────────────────────
  `CREATE TABLE profile (
     id                TEXT PRIMARY KEY,
     display_name      TEXT NOT NULL,
     year_of_birth     INTEGER,
     sex               TEXT CHECK (sex IN ('female','male','other','unstated')),
     blood_group       TEXT,
     is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
     created_at_epoch  INTEGER NOT NULL,
     updated_at_epoch  INTEGER NOT NULL,
     lamport           INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch  INTEGER
   );`,

  // ── Condition packs ─────────────────────────────────────────────────────────
  // A condition is DATA, never code. A pack ENABLES metrics/symptoms/tests; it never
  // requires them. Disabling a pack never deletes a reading.
  `CREATE TABLE condition_pack (
     key            TEXT PRIMARY KEY,
     label_en       TEXT NOT NULL,
     label_hi       TEXT NOT NULL,
     description_en TEXT,
     sort_order     INTEGER NOT NULL DEFAULT 100
   );`,

  `CREATE TABLE profile_condition (
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     pack_key         TEXT NOT NULL REFERENCES condition_pack(key),
     started_on       TEXT,
     ended_on         TEXT,
     created_at_epoch INTEGER NOT NULL,
     PRIMARY KEY (profile_id, pack_key)
   );`,

  // ── Metric registry ─────────────────────────────────────────────────────────
  // One row per measurable thing. `schema_json` describes its fields so the UI, the
  // charts and the reports are all driven by data rather than a switch statement.
  `CREATE TABLE metric_def (
     key            TEXT PRIMARY KEY,
     label_en       TEXT NOT NULL,
     label_hi       TEXT NOT NULL,
     unit           TEXT NOT NULL,
     value_kind     TEXT NOT NULL CHECK (value_kind IN ('scalar','pair','triple','ordinal','boolean')),
     schema_json    TEXT NOT NULL,
     chart_kind     TEXT NOT NULL CHECK (chart_kind IN ('scatter','line','bar','none')),
     min_valid      REAL,
     max_valid      REAL,
     is_builtin     INTEGER NOT NULL DEFAULT 1 CHECK (is_builtin IN (0,1)),
     sort_order     INTEGER NOT NULL DEFAULT 100
   );`,

  `CREATE TABLE pack_metric (
     pack_key   TEXT NOT NULL REFERENCES condition_pack(key),
     metric_key TEXT NOT NULL REFERENCES metric_def(key),
     PRIMARY KEY (pack_key, metric_key)
   );`,

  // The user's tracked set is materialised and owned by them — toggling a pack off
  // never removes a metric they have been recording.
  `CREATE TABLE profile_metric (
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     metric_key       TEXT NOT NULL REFERENCES metric_def(key),
     enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
     sort_order       INTEGER NOT NULL DEFAULT 100,
     created_at_epoch INTEGER NOT NULL,
     PRIMARY KEY (profile_id, metric_key)
   );`,

  // ── Readings ────────────────────────────────────────────────────────────────
  // One table for every metric. v1/v2/v3 are denormalised slots described by
  // metric_def.schema_json (BP: v1=systolic, v2=diastolic, v3=pulse; glucose: v1=value).
  //
  // Bounds are INSTRUMENT limits. Do not tighten them to "normal" ranges.
  `CREATE TABLE reading (
     id                TEXT PRIMARY KEY,
     profile_id        TEXT NOT NULL REFERENCES profile(id),
     metric_key        TEXT NOT NULL REFERENCES metric_def(key),
     v1                REAL,
     v2                REAL,
     v3                REAL,
     value_qualifier   TEXT NOT NULL DEFAULT 'exact'
                         CHECK (value_qualifier IN ('exact','below_range','above_range')),
     context_json      TEXT,
     note              TEXT,
     at_epoch          INTEGER NOT NULL,
     local_date        TEXT NOT NULL,
     local_time        TEXT NOT NULL,
     tz_offset_minutes INTEGER NOT NULL,
     was_backfilled    INTEGER NOT NULL DEFAULT 0 CHECK (was_backfilled IN (0,1)),
     source            TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('manual','ocr','import','device')),
     edited_count      INTEGER NOT NULL DEFAULT 0,
     created_at_epoch  INTEGER NOT NULL,
     updated_at_epoch  INTEGER NOT NULL,
     lamport           INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch  INTEGER,
     CHECK (v1 IS NULL OR (v1 >= -1000 AND v1 <= 100000))
   );`,

  `CREATE INDEX idx_reading_profile_metric_date
     ON reading(profile_id, metric_key, local_date DESC) WHERE deleted_at_epoch IS NULL;`,
  `CREATE INDEX idx_reading_profile_epoch
     ON reading(profile_id, at_epoch DESC) WHERE deleted_at_epoch IS NULL;`,

  // Append-only audit of every correction, so `edited_count` is more than a rumour.
  `CREATE TABLE record_edit (
     id               TEXT PRIMARY KEY,
     record_kind      TEXT NOT NULL,
     record_id        TEXT NOT NULL,
     field            TEXT NOT NULL,
     old_value        TEXT,
     new_value        TEXT,
     at_epoch         INTEGER NOT NULL
   );`,
  `CREATE INDEX idx_record_edit_record ON record_edit(record_kind, record_id, at_epoch DESC);`,

  // ── Targets ─────────────────────────────────────────────────────────────────
  // SHIPS EMPTY, ALWAYS. `set_by_label` names the human and date, and is printed in
  // every chart legend. The app never seeds a clinical threshold.
  `CREATE TABLE target_range (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     metric_key       TEXT NOT NULL REFERENCES metric_def(key),
     context_json     TEXT,
     field            TEXT NOT NULL DEFAULT 'v1',
     low              REAL,
     high             REAL,
     set_by_label     TEXT NOT NULL,
     set_on           TEXT NOT NULL,
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     lamport          INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch INTEGER
   );`,
  `CREATE INDEX idx_target_profile_metric ON target_range(profile_id, metric_key)
     WHERE deleted_at_epoch IS NULL;`,
] as const;

const V1_MEDICINES = [
  // ── Prescriptions ───────────────────────────────────────────────────────────
  `CREATE TABLE prescription (
     id                 TEXT PRIMARY KEY,
     profile_id         TEXT NOT NULL REFERENCES profile(id),
     image_uri          TEXT,
     cropped_image_uri  TEXT,
     prescriber         TEXT,
     clinic             TEXT,
     prescribed_on      TEXT,
     follow_up_on       TEXT,
     follow_up_raw      TEXT,
     status             TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','extracting','extracted','confirmed','failed')),
     extraction_json    TEXT,
     extraction_error   TEXT,
     confirmed_at_epoch INTEGER,
     created_at_epoch   INTEGER NOT NULL,
     updated_at_epoch   INTEGER NOT NULL,
     lamport            INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch   INTEGER
   );`,

  // ── Medicines — APPEND-ONLY VERSIONS ────────────────────────────────────────
  // `thread_id` is the stable identity of "this drug". A dose change appends a new
  // version on the SAME thread, so adherence history stays continuous. Modelling a
  // dose change as stop+new would silently reset her TB streak.
  //
  // `confirmed_by_user_at` is the AI safety gate, enforced by trigger below: an
  // unconfirmed medicine is structurally incapable of producing a dose occurrence.
  `CREATE TABLE medicine (
     id                    TEXT PRIMARY KEY,
     thread_id             TEXT NOT NULL,
     version               INTEGER NOT NULL,
     profile_id            TEXT NOT NULL REFERENCES profile(id),
     name_as_written       TEXT NOT NULL,
     generic_guess         TEXT,
     strength              TEXT,
     form                  TEXT CHECK (form IN
                             ('tablet','capsule','syrup','injection','inhaler','drops','cream','other')),
     criticality           TEXT NOT NULL DEFAULT 'standard'
                             CHECK (criticality IN ('critical','standard','low')),
     criticality_proposed  TEXT CHECK (criticality_proposed IN ('critical','standard','low')),
     criticality_reason    TEXT,
     status                TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','stopped','superseded')),
     stop_reason           TEXT,
     started_on            TEXT,
     stopped_on            TEXT,
     source                TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
     prescription_id       TEXT REFERENCES prescription(id),
     strip_photo_uri       TEXT,
     confirmed_by_user_at  INTEGER,
     superseded_by         TEXT,
     created_at_epoch      INTEGER NOT NULL,
     updated_at_epoch      INTEGER NOT NULL,
     lamport               INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch      INTEGER,
     UNIQUE (thread_id, version)
   );`,
  `CREATE INDEX idx_medicine_profile_status ON medicine(profile_id, status)
     WHERE deleted_at_epoch IS NULL;`,
  `CREATE INDEX idx_medicine_thread ON medicine(thread_id, version DESC);`,

  // ── Schedules — ALSO APPEND-ONLY ────────────────────────────────────────────
  // WALL CLOCK ONLY. `days_mask` is a 7-bit field, bit 0 = Monday.
  // `schedule_type='PRN'` rows have no time and generate no occurrences.
  `CREATE TABLE dose_schedule (
     id                   TEXT PRIMARY KEY,
     medicine_id          TEXT NOT NULL REFERENCES medicine(id),
     thread_id            TEXT NOT NULL,
     version              INTEGER NOT NULL,
     schedule_type        TEXT NOT NULL DEFAULT 'FIXED' CHECK (schedule_type IN ('FIXED','PRN')),
     time_local           TEXT,
     slot_key             TEXT,
     days_mask            INTEGER NOT NULL DEFAULT 127 CHECK (days_mask BETWEEN 0 AND 127),
     interval_days        INTEGER NOT NULL DEFAULT 1 CHECK (interval_days >= 1),
     quantity_value       REAL,
     quantity_unit        TEXT,
     quantity_text        TEXT,
     food_relation        TEXT CHECK (food_relation IN ('before','after','with','empty','any')),
     started_on           TEXT NOT NULL,
     stopped_on           TEXT,
     confirmed_by_user_at INTEGER,
     created_at_epoch     INTEGER NOT NULL,
     updated_at_epoch     INTEGER NOT NULL,
     lamport              INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch     INTEGER,
     UNIQUE (thread_id, version, time_local)
   );`,
  `CREATE INDEX idx_schedule_medicine ON dose_schedule(medicine_id)
     WHERE deleted_at_epoch IS NULL;`,

  // ── Occurrences — DERIVED CACHE, safe to rebuild ────────────────────────────
  // id is deterministic: '<thread_id>:<local_date>:<time_local>'. Never contains a
  // colon in thread_id — ids are UUIDs, asserted at the write layer.
  `CREATE TABLE dose_occurrence (
     id                  TEXT PRIMARY KEY,
     profile_id          TEXT NOT NULL REFERENCES profile(id),
     medicine_id         TEXT NOT NULL REFERENCES medicine(id),
     thread_id           TEXT NOT NULL,
     dose_schedule_id    TEXT NOT NULL REFERENCES dose_schedule(id),
     local_date          TEXT NOT NULL,
     time_local          TEXT NOT NULL,
     scheduled_at_epoch  INTEGER NOT NULL,
     status              TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','taken','skipped','snoozed','cancelled','no_record')),
     channel_id          TEXT NOT NULL,
     created_at_epoch    INTEGER NOT NULL,
     updated_at_epoch    INTEGER NOT NULL
   );`,
  `CREATE INDEX idx_occ_profile_date ON dose_occurrence(profile_id, local_date);`,
  `CREATE INDEX idx_occ_pending ON dose_occurrence(scheduled_at_epoch)
     WHERE status IN ('pending','snoozed');`,

  // ── Dose events — APPEND-ONLY TRUTH ─────────────────────────────────────────
  // Written by the JS drain from the native journal, and by in-app taps. Never updated,
  // never deleted. `deriveStatus(events)` recomputes dose_occurrence.status from these.
  `CREATE TABLE dose_event (
     id               TEXT PRIMARY KEY,
     occurrence_id    TEXT NOT NULL,
     thread_id        TEXT NOT NULL,
     medicine_id      TEXT,
     profile_id       TEXT NOT NULL,
     event            TEXT NOT NULL CHECK (event IN
                        ('delivered','taken','skipped','snoozed','cancelled','dismissed',
                         'prn_taken','rearmed','receiver_error')),
     at_epoch         INTEGER NOT NULL,
     local_date       TEXT NOT NULL,
     payload_json     TEXT,
     origin           TEXT NOT NULL DEFAULT 'app'
                        CHECK (origin IN ('app','notification','widget','native','watchdog')),
     created_at_epoch INTEGER NOT NULL,
     lamport          INTEGER NOT NULL DEFAULT 0
   );`,
  `CREATE INDEX idx_dose_event_occ ON dose_event(occurrence_id, at_epoch);`,
  `CREATE INDEX idx_dose_event_profile_date ON dose_event(profile_id, local_date);`,

  // Events that could not be attached to a known occurrence. Quarantined rather than
  // dropped, and never allowed to block the drain queue.
  `CREATE TABLE dose_event_quarantine (
     id               TEXT PRIMARY KEY,
     raw_json         TEXT NOT NULL,
     reason           TEXT NOT NULL,
     at_epoch         INTEGER NOT NULL
   );`,

  // Prescription/medicine changes, rendered as vertical markers on the charts.
  // Never annotated, never explained — just visible on a shared date axis.
  `CREATE TABLE med_change_event (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     thread_id        TEXT,
     kind             TEXT NOT NULL CHECK (kind IN
                        ('started','stopped','dose_changed','time_changed','resumed','prescription')),
     local_date       TEXT NOT NULL,
     at_epoch         INTEGER NOT NULL,
     detail           TEXT,
     prescription_id  TEXT REFERENCES prescription(id)
   );`,
  `CREATE INDEX idx_med_change_profile_date ON med_change_event(profile_id, local_date);`,

  // ── Stock & refills ─────────────────────────────────────────────────────────
  `CREATE TABLE medicine_stock (
     id                 TEXT PRIMARY KEY,
     thread_id          TEXT NOT NULL,
     profile_id         TEXT NOT NULL REFERENCES profile(id),
     quantity_on_hand   REAL NOT NULL,
     counted_on         TEXT NOT NULL,
     unit_cost          REAL,
     refill_lead_days   INTEGER NOT NULL DEFAULT 5,
     created_at_epoch   INTEGER NOT NULL,
     updated_at_epoch   INTEGER NOT NULL,
     lamport            INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch   INTEGER
   );`,
] as const;

const V1_CARE = [
  // ── Symptoms ────────────────────────────────────────────────────────────────
  `CREATE TABLE symptom_def (
     key         TEXT PRIMARY KEY,
     label_en    TEXT NOT NULL,
     label_hi    TEXT NOT NULL,
     is_base     INTEGER NOT NULL DEFAULT 1 CHECK (is_base IN (0,1)),
     sort_order  INTEGER NOT NULL DEFAULT 100
   );`,
  `CREATE TABLE pack_symptom (
     pack_key    TEXT NOT NULL REFERENCES condition_pack(key),
     symptom_key TEXT NOT NULL REFERENCES symptom_def(key),
     PRIMARY KEY (pack_key, symptom_key)
   );`,
  `CREATE TABLE symptom_event (
     id                TEXT PRIMARY KEY,
     profile_id        TEXT NOT NULL REFERENCES profile(id),
     symptom_key       TEXT REFERENCES symptom_def(key),
     custom_label      TEXT,
     severity          TEXT CHECK (severity IN ('mild','moderate','severe')),
     note              TEXT,
     photo_uri         TEXT,
     at_epoch          INTEGER NOT NULL,
     local_date        TEXT NOT NULL,
     local_time        TEXT NOT NULL,
     tz_offset_minutes INTEGER NOT NULL,
     linked_reading_id TEXT REFERENCES reading(id),
     linked_thread_id  TEXT,
     edited_count      INTEGER NOT NULL DEFAULT 0,
     created_at_epoch  INTEGER NOT NULL,
     updated_at_epoch  INTEGER NOT NULL,
     lamport           INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch  INTEGER
   );`,
  `CREATE INDEX idx_symptom_profile_date ON symptom_event(profile_id, local_date DESC)
     WHERE deleted_at_epoch IS NULL;`,

  // ── Labs ────────────────────────────────────────────────────────────────────
  `CREATE TABLE lab_test_def (
     key        TEXT PRIMARY KEY,
     label_en   TEXT NOT NULL,
     label_hi   TEXT NOT NULL,
     unit       TEXT,
     sort_order INTEGER NOT NULL DEFAULT 100
   );`,
  `CREATE TABLE pack_lab_test (
     pack_key TEXT NOT NULL REFERENCES condition_pack(key),
     test_key TEXT NOT NULL REFERENCES lab_test_def(key),
     PRIMARY KEY (pack_key, test_key)
   );`,
  // `ref_range_text` is whatever the report itself printed — transcribed, never asserted.
  `CREATE TABLE lab_result (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     test_key         TEXT REFERENCES lab_test_def(key),
     custom_label     TEXT,
     value_text       TEXT,
     value_num        REAL,
     unit             TEXT,
     ref_range_text   TEXT,
     collected_on     TEXT,
     lab_name         TEXT,
     report_uri       TEXT,
     source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ocr')),
     confirmed_at     INTEGER,
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     lamport          INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch INTEGER
   );`,
  `CREATE INDEX idx_lab_profile_date ON lab_result(profile_id, collected_on DESC)
     WHERE deleted_at_epoch IS NULL;`,

  // ── Care calendar ───────────────────────────────────────────────────────────
  // `anchor_source` separates what the doctor WROTE from what the app INFERRED.
  // The AI may only ever populate 'transcribed' rows; every offset is ours and is
  // user-editable, because there is no evidence for a lead time on the prescription.
  `CREATE TABLE care_event (
     id                 TEXT PRIMARY KEY,
     profile_id         TEXT NOT NULL REFERENCES profile(id),
     kind               TEXT NOT NULL CHECK (kind IN
                          ('visit','book_appointment','test_book','test_do','test_collect','refill','custom')),
     title              TEXT NOT NULL,
     due_on             TEXT NOT NULL,
     anchor_event_id    TEXT,
     anchor_source      TEXT NOT NULL CHECK (anchor_source IN ('transcribed','inferred','manual')),
     offset_days        INTEGER NOT NULL DEFAULT 0,
     prescription_id    TEXT REFERENCES prescription(id),
     related_test_key   TEXT,
     related_thread_id  TEXT,
     status             TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','done','dismissed','superseded')),
     confirmed_at_epoch INTEGER,
     created_at_epoch   INTEGER NOT NULL,
     updated_at_epoch   INTEGER NOT NULL,
     lamport            INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch   INTEGER
   );`,
  `CREATE INDEX idx_care_profile_due ON care_event(profile_id, due_on)
     WHERE deleted_at_epoch IS NULL AND status = 'pending';`,

  // ── Visits ──────────────────────────────────────────────────────────────────
  `CREATE TABLE visit_log (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     visited_on       TEXT NOT NULL,
     doctor           TEXT,
     clinic           TEXT,
     notes            TEXT,
     prescription_id  TEXT REFERENCES prescription(id),
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     lamport          INTEGER NOT NULL DEFAULT 0,
     deleted_at_epoch INTEGER
   );`,
  `CREATE TABLE visit_question (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     visit_id         TEXT REFERENCES visit_log(id),
     text             TEXT NOT NULL,
     origin           TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','auto')),
     answered         INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0,1)),
     answer_text      TEXT,
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     deleted_at_epoch INTEGER
   );`,

  // ── Contacts & documents ────────────────────────────────────────────────────
  `CREATE TABLE contact (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     label            TEXT NOT NULL,
     role             TEXT,
     phone            TEXT,
     address          TEXT,
     sort_order       INTEGER NOT NULL DEFAULT 100,
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     deleted_at_epoch INTEGER
   );`,
  `CREATE TABLE document (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     kind             TEXT NOT NULL,
     title            TEXT NOT NULL,
     file_uri         TEXT NOT NULL,
     created_at_epoch INTEGER NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     deleted_at_epoch INTEGER
   );`,

  // ── Emergency card ──────────────────────────────────────────────────────────
  // Per-line opt-in. Diagnosis lines default OFF — a visible TB diagnosis on a lock
  // screen carries real consequences in India.
  `CREATE TABLE emergency_card (
     profile_id          TEXT PRIMARY KEY REFERENCES profile(id),
     show_name           INTEGER NOT NULL DEFAULT 1 CHECK (show_name IN (0,1)),
     show_age            INTEGER NOT NULL DEFAULT 1 CHECK (show_age IN (0,1)),
     show_blood_group    INTEGER NOT NULL DEFAULT 1 CHECK (show_blood_group IN (0,1)),
     show_allergies      INTEGER NOT NULL DEFAULT 1 CHECK (show_allergies IN (0,1)),
     show_medicines      INTEGER NOT NULL DEFAULT 1 CHECK (show_medicines IN (0,1)),
     show_conditions     INTEGER NOT NULL DEFAULT 0 CHECK (show_conditions IN (0,1)),
     neutral_treatment_line TEXT,
     allergies_text      TEXT,
     updated_at_epoch    INTEGER NOT NULL
   );`,
] as const;

const V1_ENGAGEMENT_SYNC = [
  // ── Streaks & badges ────────────────────────────────────────────────────────
  // Deliberately non-punitive: a break quietly restarts and `best_streak` is kept.
  // There is no "streak lost" notification and no failure state anywhere.
  // Badges are NEVER rendered on a doctor-facing report.
  `CREATE TABLE streak_state (
     profile_id        TEXT PRIMARY KEY REFERENCES profile(id),
     current_streak    INTEGER NOT NULL DEFAULT 0,
     best_streak       INTEGER NOT NULL DEFAULT 0,
     last_counted_date TEXT,
     updated_at_epoch  INTEGER NOT NULL
   );`,
  `CREATE TABLE badge (
     id               TEXT PRIMARY KEY,
     profile_id       TEXT NOT NULL REFERENCES profile(id),
     key              TEXT NOT NULL,
     earned_on        TEXT NOT NULL,
     created_at_epoch INTEGER NOT NULL,
     UNIQUE (profile_id, key)
   );`,

  // ── Reminder delivery telemetry ─────────────────────────────────────────────
  // Instrumenting the ABSENCE of delivery is what turns OEM process-killing from an
  // invisible failure into a visible one.
  `CREATE TABLE delivery_probe (
     id               TEXT PRIMARY KEY,
     occurrence_id    TEXT NOT NULL,
     expected_epoch   INTEGER NOT NULL,
     delivered_epoch  INTEGER,
     checked_epoch    INTEGER,
     created_at_epoch INTEGER NOT NULL
   );`,
  `CREATE INDEX idx_probe_undelivered ON delivery_probe(expected_epoch)
     WHERE delivered_epoch IS NULL;`,

  `CREATE TABLE health_check_result (
     key              TEXT PRIMARY KEY,
     ok               INTEGER NOT NULL CHECK (ok IN (0,1)),
     detail           TEXT,
     checked_at_epoch INTEGER NOT NULL
   );`,

  // ── L3 sync ─────────────────────────────────────────────────────────────────
  // Viewers hold a device keypair; the family key is wrapped to their public key only
  // AFTER the patient taps Approve. A leaked invite link alone is worthless.
  `CREATE TABLE viewer (
     id                 TEXT PRIMARY KEY,
     profile_id         TEXT NOT NULL REFERENCES profile(id),
     display_name       TEXT NOT NULL,
     device_label       TEXT,
     public_key         TEXT NOT NULL,
     status             TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','revoked')),
     approved_at_epoch  INTEGER,
     revoked_at_epoch   INTEGER,
     created_at_epoch   INTEGER NOT NULL,
     updated_at_epoch   INTEGER NOT NULL
   );`,
  `CREATE TABLE invite (
     id                TEXT PRIMARY KEY,
     profile_id        TEXT NOT NULL REFERENCES profile(id),
     token_hash        TEXT NOT NULL,
     label             TEXT,
     expires_at_epoch  INTEGER NOT NULL,
     attempts          INTEGER NOT NULL DEFAULT 0,
     redeemed_at_epoch INTEGER,
     created_at_epoch  INTEGER NOT NULL
   );`,
  `CREATE TABLE sync_outbox (
     id               TEXT PRIMARY KEY,
     table_name       TEXT NOT NULL,
     row_id           TEXT NOT NULL,
     op               TEXT NOT NULL CHECK (op IN ('upsert','delete')),
     lamport          INTEGER NOT NULL,
     attempts         INTEGER NOT NULL DEFAULT 0,
     last_error       TEXT,
     created_at_epoch INTEGER NOT NULL,
     UNIQUE (table_name, row_id, lamport)
   );`,
  `CREATE INDEX idx_outbox_pending ON sync_outbox(created_at_epoch);`,

  `CREATE TABLE app_meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   );`,
] as const;

const V1_TRIGGERS = [
  // ── The AI safety gate, enforced in the DATABASE, not the UI ────────────────
  // An occurrence cannot exist for a medicine a human has not confirmed, and cannot
  // exist for a schedule a human has not confirmed. Confirming the NAME is not enough:
  // "1-0-1 misread as QID" leaves the name perfectly correct and quadruples the doses,
  // so the schedule carries its own confirmation.
  `CREATE TRIGGER trg_occ_requires_confirmed_medicine
     BEFORE INSERT ON dose_occurrence
     FOR EACH ROW
     WHEN (SELECT confirmed_by_user_at FROM medicine WHERE id = NEW.medicine_id) IS NULL
     BEGIN
       SELECT RAISE(ABORT, 'refused: medicine not confirmed by a human');
     END;`,

  `CREATE TRIGGER trg_occ_requires_confirmed_schedule
     BEFORE INSERT ON dose_occurrence
     FOR EACH ROW
     WHEN (SELECT confirmed_by_user_at FROM dose_schedule WHERE id = NEW.dose_schedule_id) IS NULL
     BEGIN
       SELECT RAISE(ABORT, 'refused: dose schedule not confirmed by a human');
     END;`,

  // ── Append-only guards ──────────────────────────────────────────────────────
  // A migration that legitimately needs to backfill must DROP and re-CREATE these
  // inside its own transaction. See withTriggersOff() in ./index.ts.
  `CREATE TRIGGER trg_dose_event_no_update
     BEFORE UPDATE ON dose_event
     BEGIN SELECT RAISE(ABORT, 'dose_event is append-only'); END;`,
  `CREATE TRIGGER trg_dose_event_no_delete
     BEFORE DELETE ON dose_event
     BEGIN SELECT RAISE(ABORT, 'dose_event is append-only'); END;`,

  // Medicines and schedules may only change their lifecycle columns in place; any
  // clinical change must append a new version.
  `CREATE TRIGGER trg_medicine_no_update
     BEFORE UPDATE OF name_as_written, strength, form, thread_id, version ON medicine
     BEGIN SELECT RAISE(ABORT, 'medicine is versioned: append a new version'); END;`,
  `CREATE TRIGGER trg_dose_schedule_no_update
     BEFORE UPDATE OF time_local, quantity_value, quantity_text, days_mask, interval_days
     ON dose_schedule
     BEGIN SELECT RAISE(ABORT, 'dose_schedule is versioned: append a new version'); END;`,

  // ── Soft delete only ────────────────────────────────────────────────────────
  `CREATE TRIGGER trg_reading_no_hard_delete
     BEFORE DELETE ON reading
     BEGIN SELECT RAISE(ABORT, 'use soft delete: set deleted_at_epoch'); END;`,
  `CREATE TRIGGER trg_symptom_no_hard_delete
     BEFORE DELETE ON symptom_event
     BEGIN SELECT RAISE(ABORT, 'use soft delete: set deleted_at_epoch'); END;`,
  `CREATE TRIGGER trg_lab_no_hard_delete
     BEFORE DELETE ON lab_result
     BEGIN SELECT RAISE(ABORT, 'use soft delete: set deleted_at_epoch'); END;`,
] as const;

/**
 * v4 — symptom registry retirement + censored readings + the briefcase.
 *
 * Four features land here together, in ONE migration, because the list is append-only
 * and `index === user_version`: two authors writing v4 in parallel produce two different
 * v4s and one of them silently never runs. Everything below is add-only per rule 2.
 *
 * ── 1. THE SYMPTOM REGISTRY CAN NOW RETIRE A ROW ────────────────────────────────
 *
 * `symptom_def` is reference data written with INSERT OR IGNORE on every boot, which
 * means the seed can ADD a row but can never CHANGE one that is already on a phone.
 * That is a deliberate safety property (a shipped label cannot silently rewrite what a
 * past event says) and it is also the whole difficulty here.
 *
 * The reported problem was that "vomiting" could not be recorded. The real defect was in
 * the screen — it sliced a global list to twelve chips and never consulted the profile's
 * condition packs — but underneath it sat a data problem worth fixing at the same time:
 * `nausea_vomiting` ("Feeling sick or vomiting") merges two observations that a TB
 * patient on isoniazid and rifampicin has every reason to keep apart. Mild nausea in
 * week two is expected. Persistent vomiting is not, and it is one of the things a doctor
 * asks about by name.
 *
 * So the pair is SPLIT into `nausea` and `vomiting` (both seeded, both pure INSERT OR
 * IGNORE, no SQL here). What cannot be done by insertion is the other half:
 *
 *   • `nausea_vomiting` must stop being OFFERED, or she is choosing between three
 *     overlapping chips and the record gets worse rather than better.
 *   • It must NOT be relabelled and it must NOT be deleted. `symptom_event` stores only
 *     `symptom_key`; every label on the OPD report is resolved from `symptom_def` at read
 *     time. Rewriting the label would retroactively change what she already recorded, on
 *     the sheet a doctor reads. Deleting the row would break the foreign key and blank
 *     the entry entirely.
 *
 * `retired_at_epoch` is exactly that distinction: NULL means "offer this", non-NULL means
 * "never offer this again, and keep rendering it for the events that already point at it".
 * The reads that build a chip list filter it; the read that resolves a label does not.
 *
 * The epoch below is a FIXED constant, not `strftime('now')`, and the seed writes the
 * same number for a fresh install. A computed timestamp would tell every new phone that
 * the chip was retired on the day that phone was set up, which is not true of anything.
 *
 * ── 2. sort_order BECOMES EXPLICIT ──────────────────────────────────────────────
 *
 * The seed used to compute `sort_order` as the row's POSITION in the array times ten.
 * Inserting a symptom anywhere but the end therefore renumbered every later key — on a
 * fresh install. On a phone that already has the rows, INSERT OR IGNORE changes nothing,
 * so the two installs would order the same chips differently, silently, forever. The
 * seed now carries an explicit `sortOrder` per key and the UPDATEs below bring existing
 * phones onto the same numbering. This is the one thing in this migration that has no
 * user-visible feature attached to it and it is the one most likely to have caused a
 * confusing bug report six months from now.
 *
 * ── 3. A CENSORED READING IS AN INEQUALITY, NOT A MISSING NUMBER ────────────────
 *
 * A glucometer that prints LO is not failing. It is asserting `glucose < 20 mg/dL` — the
 * bottom of what it can quantify — and that is a measurement with real clinical content,
 * frequently the most important one in the window. Today `value_qualifier` records the
 * DIRECTION and nothing records the LIMIT, so "LO" cannot be turned back into "< 20" and
 * every chart, tile and summary drops the reading entirely.
 *
 * `qualifier_bound` stores the limit of the instrument's measuring range AS IT WAS AT
 * THE MOMENT OF ENTRY. Per-row rather than looked up at render time, for the same reason
 * `was_backfilled` is derived at write: she will replace the meter, and a LO recorded on
 * a 20-floor meter must not silently re-plot at 10 because a newer meter was configured
 * in July.
 *
 * THE TRIGGERS ARE THE POINT. "The app invented a glucose value out of a meter's limit"
 * is the single worst thing this feature could do, so it is not left to convention:
 *
 *   • an `exact` reading may not carry a bound (there is nothing to bound), and
 *   • a LO/HI reading may not carry a value in v1 (the meter never produced one).
 *
 * A refactor cannot reintroduce the fabrication, because the database refuses the write.
 * Both directions are guarded because `editReading` can change `value_qualifier` in
 * place. Only `v1` is constrained: it is the only slot any metric with a qualifier uses,
 * and inventing a rule for v2/v3 that nothing writes would be guessing.
 *
 * ── 4. THE BRIEFCASE ────────────────────────────────────────────────────────────
 *
 * `document` already existed and was already listed by a screen; it had never had a
 * single row written to it, because nothing called `addDocument`. It gains what a file
 * she chose herself needs and a photograph the app took did not: the name the file
 * arrived with, its type, its size, and — the load-bearing one — whether AAROGYA OWNS
 * THE FILE.
 *
 * That flag settles a genuine conflict. A `document` row pointing at a prescription
 * photograph must never unlink it: the row is an index entry and the photograph is the
 * only copy in existence. A briefcase document is the opposite case — the app COPIED
 * that file into its own storage when she added it, so the copy has no other owner, and
 * leaving it on disk after she taps Remove is a privacy failure in an app whose entire
 * promise is that everything stays on this phone and goes when she says it goes.
 * `owns_file` defaults to 0, so every row that exists today (none) and every row written
 * by a caller that has not thought about it keeps the old, safe behaviour.
 *
 * `pending_file_delete` is how the unlink is GUARANTEED rather than attempted. The row's
 * soft delete and the deletion request are written in ONE transaction, so a crash, a
 * battery pull or an OEM process kill between "the row is gone from the list" and "the
 * bytes are gone from the disk" leaves a durable instruction to finish the job, and the
 * sweeper that runs at boot finishes it. A repository that called unlink directly could
 * only ever try once, in a layer that cannot retry and cannot report.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────
 *
 * There is no table for the developer log. A high-churn disposable table would be
 * snapshotted before every future migration, integrity-checked on every open, would take
 * the same write lock as a dose event, and — worst — the backup capsule exports the whole
 * database with VACUUM INTO, so log lines quoting an API error would ride inside every
 * capsule the family moves around. The log is a bounded file in the CACHE directory,
 * which the capsule walker never enters. See the report accompanying this migration.
 */
const V4_SYMPTOM_REGISTRY = [
  `ALTER TABLE symptom_def ADD COLUMN retired_at_epoch INTEGER;`,

  // 2026-08-12T00:00:00Z — the day the split shipped. Identical to RETIRED_AT_EPOCH in
  // src/db/seed.ts, which writes it on a fresh install where this UPDATE matches nothing.
  `UPDATE symptom_def SET retired_at_epoch = 1786492800000 WHERE key = 'nausea_vomiting';`,

  // Explicit numbering, matching SymptomSeed.sortOrder in src/db/seed.ts exactly. One
  // statement per key rather than a CASE expression: a typo then costs one chip's
  // position instead of the whole ordering, and the diff is readable.
  `UPDATE symptom_def SET sort_order = 10  WHERE key = 'breathless';`,
  `UPDATE symptom_def SET sort_order = 20  WHERE key = 'chest_discomfort';`,
  `UPDATE symptom_def SET sort_order = 30  WHERE key = 'dizzy';`,
  `UPDATE symptom_def SET sort_order = 40  WHERE key = 'very_tired';`,
  `UPDATE symptom_def SET sort_order = 50  WHERE key = 'swollen_feet';`,
  `UPDATE symptom_def SET sort_order = 60  WHERE key = 'cough';`,
  `UPDATE symptom_def SET sort_order = 70  WHERE key = 'fever';`,
  `UPDATE symptom_def SET sort_order = 80  WHERE key = 'shaky_sweaty';`,
  `UPDATE symptom_def SET sort_order = 90  WHERE key = 'night_sweats';`,
  `UPDATE symptom_def SET sort_order = 100 WHERE key = 'blurred_vision';`,
  `UPDATE symptom_def SET sort_order = 110 WHERE key = 'numb_feet';`,
  `UPDATE symptom_def SET sort_order = 120 WHERE key = 'poor_appetite';`,
  `UPDATE symptom_def SET sort_order = 130 WHERE key = 'headache';`,
  `UPDATE symptom_def SET sort_order = 140 WHERE key = 'nausea';`,
  `UPDATE symptom_def SET sort_order = 150 WHERE key = 'vomiting';`,
  `UPDATE symptom_def SET sort_order = 160 WHERE key = 'stomach_pain';`,
  `UPDATE symptom_def SET sort_order = 170 WHERE key = 'sleep_trouble';`,
  `UPDATE symptom_def SET sort_order = 180 WHERE key = 'joint_pain';`,
  `UPDATE symptom_def SET sort_order = 190 WHERE key = 'itching';`,
  // Retired, so it renders in history and never in a chip list. Parked next to the two
  // keys that replaced it so that anything which does list it reads sensibly.
  `UPDATE symptom_def SET sort_order = 195 WHERE key = 'nausea_vomiting';`,
  `UPDATE symptom_def SET sort_order = 200 WHERE key = 'chest_pain';`,
  `UPDATE symptom_def SET sort_order = 210 WHERE key = 'palpitations';`,
  `UPDATE symptom_def SET sort_order = 220 WHERE key = 'breathless_lying';`,
  `UPDATE symptom_def SET sort_order = 230 WHERE key = 'slow_healing_wound';`,
  `UPDATE symptom_def SET sort_order = 240 WHERE key = 'blood_in_sputum';`,
  `UPDATE symptom_def SET sort_order = 250 WHERE key = 'wheeze';`,
  `UPDATE symptom_def SET sort_order = 260 WHERE key = 'yellow_eyes';`,
  `UPDATE symptom_def SET sort_order = 270 WHERE key = 'dark_urine';`,
  `UPDATE symptom_def SET sort_order = 280 WHERE key = 'unusual_bruising';`,
  `UPDATE symptom_def SET sort_order = 290 WHERE key = 'bleeding_gums';`,
  `UPDATE symptom_def SET sort_order = 300 WHERE key = 'blood_in_urine';`,
  `UPDATE symptom_def SET sort_order = 310 WHERE key = 'black_stool';`,
  `UPDATE symptom_def SET sort_order = 320 WHERE key = 'passing_less_urine';`,
  `UPDATE symptom_def SET sort_order = 330 WHERE key = 'wound_discharge';`,
  `UPDATE symptom_def SET sort_order = 340 WHERE key = 'neck_swelling';`,
  `UPDATE symptom_def SET sort_order = 350 WHERE key = 'feeling_cold';`,

  /**
   * Force the reference seed to run once more.
   *
   * `ensureRegistrySeeded()` short-circuits on a version marker in `app_meta` after its
   * first success, so on a phone that has already booted, seedReferenceData() never runs
   * again and the two NEW symptom rows this migration depends on would never be inserted.
   * Deleting the marker is the whole fix, and it is the correct one to make from here:
   * every new row in this batch is an INSERT OR IGNORE against a natural key, so a re-run
   * is free and cannot overwrite anything.
   *
   * The alternative — bumping REGISTRY_SEED_VERSION in src/app/_shared/lib.tsx — is the
   * intended mechanism and should still happen whenever seed.ts gains rows. It just
   * cannot be relied on from a migration, because it lives in a file this change does not
   * own and a forgotten bump fails silently.
   *
   * The new rows are NOT inserted here. Doing it in SQL would mean maintaining a second
   * copy of every label and every pack mapping, in a file that may never be edited again;
   * and `pack_symptom` has foreign keys into `condition_pack`, which on a FRESH install is
   * still empty at this point — ON CONFLICT resolution does not apply to foreign key
   * violations, so an INSERT OR IGNORE there would abort the migration rather than skip.
   */
  `DELETE FROM app_meta WHERE key = 'registry_seed_version';`,
] as const;

const V4_CENSORED_READINGS = [
  `ALTER TABLE reading ADD COLUMN qualifier_bound REAL;`,

  `CREATE TRIGGER trg_reading_bound_is_not_a_value_insert
     BEFORE INSERT ON reading
     FOR EACH ROW
     WHEN (NEW.value_qualifier =  'exact' AND NEW.qualifier_bound IS NOT NULL)
       OR (NEW.value_qualifier <> 'exact' AND NEW.v1 IS NOT NULL)
     BEGIN
       SELECT RAISE(ABORT,
         'a bound is not a measurement: an exact reading carries no bound, and a LO/HI reading carries no value');
     END;`,

  `CREATE TRIGGER trg_reading_bound_is_not_a_value_update
     BEFORE UPDATE ON reading
     FOR EACH ROW
     WHEN (NEW.value_qualifier =  'exact' AND NEW.qualifier_bound IS NOT NULL)
       OR (NEW.value_qualifier <> 'exact' AND NEW.v1 IS NOT NULL)
     BEGIN
       SELECT RAISE(ABORT,
         'a bound is not a measurement: an exact reading carries no bound, and a LO/HI reading carries no value');
     END;`,
] as const;

const V4_BRIEFCASE = [
  // The name the file arrived with. Kept beside `title` rather than instead of it: the
  // title is what she can read at arm's length, and 'AXIS-DISCHARGE-2024-11.pdf' is what
  // makes a file recognisable to whoever it is sent on to.
  `ALTER TABLE document ADD COLUMN original_file_name TEXT;`,
  // Carried so the share sheet hands the receiving app the right type, and so a row can
  // be told apart from an image without opening it. NULL means "we never learned".
  `ALTER TABLE document ADD COLUMN mime_type TEXT;`,
  `ALTER TABLE document ADD COLUMN size_bytes INTEGER;`,
  // 0 = this row merely POINTS AT a file some other feature owns; removing the row must
  // never unlink it. 1 = the app copied this file into its own storage for this row and
  // nothing else refers to it, so removing the row must take the bytes with it.
  `ALTER TABLE document ADD COLUMN owns_file INTEGER NOT NULL DEFAULT 0
     CHECK (owns_file IN (0,1));`,

  // The durable half of "Remove also deletes the file". Written in the same transaction
  // as the soft delete; drained by a sweeper that can retry, and that runs at boot so a
  // crash cannot strand bytes on disk. Deliberately NOT synced and NOT lamport-stamped:
  // it describes one device's filesystem and means nothing on another handset.
  `CREATE TABLE pending_file_delete (
     id                 TEXT PRIMARY KEY,
     file_uri           TEXT NOT NULL,
     reason             TEXT NOT NULL,
     requested_at_epoch INTEGER NOT NULL,
     attempts           INTEGER NOT NULL DEFAULT 0,
     last_error         TEXT
   );`,
  `CREATE INDEX idx_pending_file_delete_requested ON pending_file_delete(requested_at_epoch);`,
] as const;

/**
 * v5 — the briefcase stops travelling, and takes back what it already sent.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────
 *
 * `document` was registered in `src/db/repositories/_shared.ts` with `sync: true`, so
 * every briefcase row — `title`, `original_file_name`, `mime_type`, `size_bytes` and
 * `file_uri` — was enqueued into `sync_outbox` on every write and pushed to the sharing
 * backend by `drainOutbox`. The top of `src/app/briefcase/index.tsx` says this, above the
 * list, with no way to dismiss it:
 *
 *   "These papers live only on this phone. Aarogya keeps them here and nowhere else —
 *    not on Google, not on any cloud, not on another phone."
 *
 * The payload is sealed and the server cannot read it, which is worth saying and is not a
 * defence: the sentence says the papers are not there, not that they are there in a form
 * the operator cannot open. And whoever holds the share link CAN open it — the key rides
 * in the link's fragment — so "the name of every paper she keeps" was one forwarded
 * WhatsApp message away from an audience she never chose. `document.sync` is now false.
 *
 * ── WHY A MIGRATION IS NEEDED AT ALL ────────────────────────────────────────────
 *
 * Because the flag is read in two places and NEITHER of them is the drain:
 * `enqueueOutbox` checks it when a row is written, and `republishRecords` checks it when
 * a link is rotated. `drainOutbox` pushes whatever is sitting in `sync_outbox` without
 * consulting the registry at all. So flipping the flag alone would leave every already-
 * queued document row to go out anyway, on the next start-up, after the fix.
 *
 * Worse in the other direction: after the flip, `softDeleteRecord('document', …)` no
 * longer enqueues anything, so nothing that happens on the phone from now on will ever
 * retract a row that has ALREADY been pushed. If the retraction is not done here, it is
 * never done.
 *
 * ── WHAT THIS DOES, AND THE TWO POPULATIONS IT SPLITS ───────────────────────────
 *
 * 1. Every phone: DELETE the queued `upsert` rows for `document`. On a phone that never
 *    finished sharing setup this is the whole story — nothing was ever sent, and now
 *    nothing ever will be.
 *
 * 2. A phone that has a Supabase project configured (`app_meta.sync.supabaseUrl` is
 *    non-empty — kept by `disableSync()` precisely so it survives sharing being turned
 *    off): queue one `delete` per document row instead. The drain seals a tombstone —
 *    `{ op: 'delete', table: 'document', id }` and nothing else — and upserts it on the
 *    server's `(link_id, row_key)` primary key, which REPLACES the payload that carried
 *    the title and the filename. That is as close to unsending as a client gets.
 *
 * The condition matters. Queueing tombstones unconditionally would mean a phone that
 * uploaded nothing, then switched sharing on months later, publishing one
 * `document:<uuid>` row key per paper — a count of her documents, arriving at a server
 * that had none. The URL is the honest proxy for "this handset was ever able to upload".
 *
 * `op = 'upsert'` is deleted and `op = 'delete'` is not, in that order, so a tombstone
 * already queued by an ordinary Remove she did last week is left alone to do its job.
 *
 * ── WHAT THIS CANNOT DO, STATED PLAINLY ─────────────────────────────────────────
 *
 * A tombstone still leaves `document:<uuid>` as a row key in `sync_record`: the count of
 * her papers, and opaque ids, remain visible to anyone holding the link. Removing the row
 * outright needs an HTTP DELETE, which needs a client, a network and a live key — none of
 * which exist inside a migration, and all of which can fail on a phone that is offline
 * for a fortnight. The durable half is done here; `rotateShareLink()` already deletes the
 * whole dataset and is the complete answer for anyone who wants one. That sentence is on
 * the Sharing screen already.
 *
 * Nothing here touches a single byte of the briefcase itself. The papers, the rows and
 * the files are all exactly where they were.
 *
 * ── ON RULE 2 ───────────────────────────────────────────────────────────────────
 *
 * No schema is changed and nothing is dropped. This is DML on `sync_outbox`, a
 * bookkeeping queue holding no clinical data, in the same family as v4's
 * `DELETE FROM app_meta WHERE key = 'registry_seed_version'`. It is idempotent: the
 * tombstone ids are derived from the row ids, so a re-run inserts nothing new.
 */
const V5_BRIEFCASE_STAYS_PUT = [
  // The tombstones, FIRST — they are selected from `document`, and the delete below only
  // removes `upsert` rows, but writing them in this order means a half-applied
  // transaction can never exist in a state where the retraction was skipped. (It cannot
  // be half-applied — the runner uses one exclusive transaction — which is the belt to
  // this brace.)
  //
  // `id` is derived rather than random because a migration has no id generator and
  // because determinism is what makes the statement idempotent. `lamport` is one past the
  // shared counter; `sync_outbox` is UNIQUE(table_name, row_id, lamport) and every row id
  // here is distinct, so one number serves them all.
  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v5-retract-' || d.id,
            'document',
            d.id,
            'delete',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            -- Millis, matching nowEpoch(). A COMPUTED timestamp is right here and wrong in
            -- the symptom migration above, and the difference is what the column means:
            -- this one records when the row joined the queue, which really is now, and it
            -- is only ever read as the backoff anchor in isDue(). It is not a fact about
            -- the user that a fresh install would be told wrongly.
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM document d
      WHERE EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '')
        AND NOT EXISTS (SELECT 1 FROM sync_outbox o
                         WHERE o.table_name = 'document'
                           AND o.row_id = d.id
                           AND o.op = 'delete');`,

  // The queued content. These never reached the server on an unconfigured phone, and on a
  // configured one the tombstone above supersedes them.
  `DELETE FROM sync_outbox WHERE table_name = 'document' AND op = 'upsert';`,

  // Hand the borrowed lamport back. `bumpLamport` reads this row and adds one, so without
  // this the next write to any table is issued the same number the tombstones used. No
  // constraint would fire — (table_name, row_id) differs — but the counter's one job is
  // to be a total order, and a number shared by two rows is not one.
  //
  // Unconditional, and deliberately so: on a phone with no tombstones to number this
  // burns one value, and a GAP in a monotonic counter costs nothing at all — nothing
  // indexes it, nothing counts it, and a reader only ever sorts by it. A DUPLICATE would
  // cost the ordering. Given a choice between the two, spend the number. It is a no-op on
  // a phone that has never written a row, because there is no row here to update.
  `UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'lamport';`,
] as const;

/**
 * v6 — the record stream stops carrying local file paths, and takes back the ones it sent.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────
 *
 * `drainOutbox` and `republishRecords` in `src/features/sync/outbox.ts` build a record with
 * `SELECT *`, so every column of a syncing table travels. Five of them hold a `file://`
 * path inside this install's private data directory:
 *
 *   prescription.image_uri, prescription.cropped_image_uri, medicine.strip_photo_uri,
 *   symptom_event.photo_uri, lab_result.report_uri
 *
 * — and a sixth door nobody had noticed: `record_edit` also syncs, and it stores one row per
 * corrected field as `field` + `old_value` + `new_value` AS TEXT. Correcting a symptom's
 * photograph therefore publishes two paths under two columns whose own names promise
 * nothing (`editSymptomEvent`, src/db/repositories/symptoms.ts).
 *
 * Those tables must keep syncing — they ARE the record. The columns must not. The value is
 * useless to any receiver, because Android renumbers that directory on reinstall, which is
 * precisely why `features/backup/restore.ts` has to re-point every one of them; and the
 * last segment of a path is frequently a name she chose. The sealed snapshot already
 * refuses to carry any of this, in those words (`features/sync/snapshot.ts`, and
 * docs/SYNC-AND-BACKUP.md §17 "No photographs"). The record stream did not.
 *
 * The strip itself is `stripLocalPaths()` in `src/features/sync/redact.ts`, applied at both
 * sealing sites. It decides on the COLUMN NAME, so a `*_uri` column added in a future
 * migration is covered without anybody remembering to come back.
 *
 * ── WHY A MIGRATION IS NEEDED AS WELL ───────────────────────────────────────────
 *
 * The strip only governs what is sealed FROM NOW ON. A phone that has been sharing already
 * pushed those rows, and a row at rest on the server keeps the payload it was given until
 * something replaces it. Nothing on the phone will ever replace it on its own: a
 * prescription photographed in March is not edited again, so it is never re-enqueued, and
 * `republishRecords` only runs on a link rotation that may never happen.
 *
 * So the retraction has to be queued here, exactly as v5 queued the briefcase's — and the
 * SHAPE is the one thing that differs, because the defect is different. v5 was retracting
 * rows from a table that must not sync at all, so its retraction was a tombstone. These
 * rows must stay. Their retraction is therefore an ORDINARY UPSERT: the drain re-reads the
 * row, strips it, seals it, and upserts on the server's `(link_id, row_key)` primary key,
 * which REPLACES the payload that carried the path with one that does not. Same row, same
 * clinical content, no path. A tombstone here would delete her prescription from the
 * shared record to hide a filename, which is the cure being worse than the disease.
 *
 * ── THE FOUR WAYS THIS COULD BE WRONG, AND WHAT EACH ONE COSTS ──────────────────
 *
 * 1. RETRACTING ON A PHONE THAT NEVER UPLOADED. v5's gate is reused, and it is not
 *    cargo-culted — the argument is independently true here and slightly different. A
 *    phone with no project configured has published nothing, and a newly-configured phone
 *    publishes only what is written from then on (nothing replays history except a
 *    rotation). Queueing unconditionally would therefore mean that the first time she ever
 *    switches sharing on, months from now, forty old prescriptions upload — rows the
 *    server would otherwise never have seen, caused by the fix. `sync.supabaseUrl` being
 *    non-blank is the honest proxy for "this handset was ever able to upload"; `disableSync`
 *    keeps that value precisely so it survives sharing being turned off.
 *
 * 2. RESURRECTING A DELETED ROW. This is the one that is new in v6 and did not exist in v5,
 *    and it would be silent. `softDeleteRecord` writes `deleted_at_epoch` and queues a
 *    tombstone in ONE transaction, and the tombstone's lamport is whatever the counter said
 *    then — necessarily lower than the number borrowed below. An upsert queued here for a
 *    soft-deleted row would therefore drain AFTER its own tombstone and put the row back on
 *    the server, undeleted. Hence `deleted_at_epoch IS NULL` on every statement: a row she
 *    has removed is already retracted, by a tombstone that carries no columns at all.
 *
 * 3. MISSING A ROW. The predicate is "the path column is non-null NOW", which is exactly
 *    right only if nothing ever clears one. Nothing does — verified across the repository:
 *    every `*_uri` is written at creation or set to a new photograph, and no screen and no
 *    repository has an "unset the photo" path. If one is ever added, it will need to queue
 *    its own retraction, for the same reason this migration exists.
 *
 * 4. HANDING OUT A LAMPORT TWICE. Same borrow-one-and-give-it-back as v5, and the same
 *    reasoning: `sync_outbox` is UNIQUE(table_name, row_id, lamport) and every row id here
 *    is distinct within its table, so one number serves them all. The number is one past the
 *    shared counter, so it sorts AFTER every version of these rows a reader has already
 *    seen — which is what makes the stripped payload the last word rather than an older one
 *    replayed over a newer.
 *
 * ── ON RULE 2 ───────────────────────────────────────────────────────────────────
 *
 * No schema is changed and nothing is dropped. This is DML on `sync_outbox`, a bookkeeping
 * queue holding no clinical data — the same family as v5. Idempotent: every id is derived
 * from the row id, so a replay inserts nothing.
 *
 * ── WHAT THIS CANNOT DO ─────────────────────────────────────────────────────────
 *
 * Only a phone that comes online can retract anything, and the drain is best-effort with a
 * backoff. Until it runs, the old payload stands. `rotateShareLink()` deletes the whole
 * dataset and remains the complete answer for anyone who wants one — and it now republishes
 * a stripped stream afterwards, which it did not before.
 */
const V6_PATHS_STOP_TRAVELLING = [
  // One statement per table rather than a UNION, for v4's reason: a typo then costs one
  // table's retraction instead of all of them, and the diff is readable.
  //
  // `EXISTS (… sync.supabaseUrl …)` is repeated in each rather than hoisted, because there
  // is nowhere in a flat statement list to hoist it TO. It is the same test v5 used.
  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v6-restrip-prescription-' || r.id,
            'prescription',
            r.id,
            'upsert',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM prescription r
      WHERE r.deleted_at_epoch IS NULL
        AND (r.image_uri IS NOT NULL OR r.cropped_image_uri IS NOT NULL)
        AND EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '');`,

  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v6-restrip-medicine-' || r.id,
            'medicine',
            r.id,
            'upsert',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM medicine r
      WHERE r.deleted_at_epoch IS NULL
        AND r.strip_photo_uri IS NOT NULL
        AND EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '');`,

  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v6-restrip-symptom_event-' || r.id,
            'symptom_event',
            r.id,
            'upsert',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM symptom_event r
      WHERE r.deleted_at_epoch IS NULL
        AND r.photo_uri IS NOT NULL
        AND EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '');`,

  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v6-restrip-lab_result-' || r.id,
            'lab_result',
            r.id,
            'upsert',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM lab_result r
      WHERE r.deleted_at_epoch IS NULL
        AND r.report_uri IS NOT NULL
        AND EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '');`,

  // The audit trail. `record_edit` has no `deleted_at_epoch` — it is append-only by
  // convention and nothing ever retracts a row — so there is no tombstone here to race.
  //
  // MATCHED BY PATTERN, NOT BY A LIST OF THE FIVE NAMES, and this is the one place in the
  // migration where that is possible: `field` holds a column name as DATA, so the same rule
  // `isLocalPathColumn()` applies in TypeScript can be written in SQL. `substr(field, -4)`
  // rather than `LIKE '%\_uri' ESCAPE '\'` because `_` is a LIKE wildcard and an escape
  // clause is one more thing to get subtly wrong in a statement that runs once, unattended,
  // on somebody's only copy.
  `INSERT OR IGNORE INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     SELECT 'v6-restrip-record_edit-' || r.id,
            'record_edit',
            r.id,
            'upsert',
            COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'lamport'), 0) + 1,
            CAST(strftime('%s', 'now') AS INTEGER) * 1000
       FROM record_edit r
      WHERE (substr(r.field, -4) = '_uri' OR r.field = 'uri')
        AND EXISTS (SELECT 1 FROM app_meta
                     WHERE key = 'sync.supabaseUrl'
                       AND value IS NOT NULL
                       AND TRIM(value) <> '');`,

  // Hand the borrowed number back, exactly as v5 does and for the same reason: a gap in a
  // monotonic counter costs nothing, a duplicate costs the ordering. Unconditional, and a
  // no-op on a phone that has never written a syncable row, because there is no row here
  // to update.
  `UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'lamport';`,
] as const;

/**
 * v7 — per-day dose-time override, multiple profiles, briefcase pin, and the schema the
 * family-sharing build will need so it can ship without a second migration of `profile`.
 *
 * ADD-ONLY, one author, one transaction. Nothing here changes what the app does today: the
 * two sharing columns and the reserved membership table sit empty and unread, the pin
 * column defaults to "not pinned", and the override column defaults to NULL (= ring at the
 * schedule's own time). Behaviour arrives only when the screens that read these land.
 *
 * ── A. PER-DAY DOSE-TIME OVERRIDE (`dose_occurrence.override_time_local`) ─────────────
 *
 * "Today take the 8 am dose at 10 am, and leave the 8 am rule alone." The rule is
 * `dose_schedule` (append-only, wall clock '08:00'); the exception is ONE occurrence.
 *
 * It is a nullable column on the occurrence, NOT a new occurrence and NOT an edit to the
 * schedule, and every word of that is load-bearing:
 *
 *   • A new occurrence at 10:00 would be a SECOND dose. The occurrence id is
 *     '<thread>:<date>:<time_local>' where `time_local` is the SLOT time — so the override
 *     rides on the existing '…:08:00' row, its id and its `time_local` unchanged. There is
 *     exactly one occurrence for that dose, before and after. No double dose, by
 *     construction rather than by a guard that can be forgotten.
 *   • The occurrence's `scheduled_at_epoch` is recomputed from `override_time_local ?? time_local`
 *     — wall clock resolved at each reconcile, never a stored future epoch (the whole
 *     wall-clock design, see the header). `setOccurrenceTimeOverride` in
 *     repositories/occurrences.ts writes the column AND re-derives the epoch in one write so
 *     the day card is self-consistent before the next reconcile runs.
 *   • Editing the schedule would move EVERY future 08:00 dose. This moves one date's.
 *
 * RECONCILE MUST HONOUR IT — and this is the one place a build agent can undo the feature
 * without tripping a type. `reconcile.ts` recomputes an existing occurrence's epoch from the
 * candidate's slot time and calls `refreshOccurrence` when they differ; left as-is it would
 * reset an overridden 10:00 back to 08:00 on the very next foreground. The candidate's
 * `scheduledAtEpoch` for an occurrence that carries an override must be derived from the
 * override. Retirement is already safe: the overridden row keeps its '…:08:00' id, the
 * calendar still produces that candidate, so Rule B never sees it as stale.
 *
 * THE ALARM-LAYER GAP, STATED HONESTLY (see the report handed to the build agents). The
 * native horizon holds recurrence RULES that Kotlin expands forward on its own; a one-off
 * "this date only, 08:00 → 10:00" is not expressible as a rule. So the override reaches the
 * database, the reconcile and every in-app surface, but NOT the native alarm until Kotlin
 * learns to read a per-date exception. Shipping the column + repo + reconcile now — and the
 * Kotlin exceptions channel later — is deliberate: a half-wired alarm that rings at both
 * 08:00 and 10:00 would be the double dose this whole design exists to prevent.
 *
 * ── B. MULTIPLE PROFILES ─────────────────────────────────────────────────────────────
 *
 * Nothing schema-wise: every profile-scoped table has carried `profile_id` since v1 (see the
 * header note), and `profile` has never had a one-row constraint — it holds N rows today. The
 * active-profile pointer is an `app_meta` key (`getActiveProfileId`/`setActiveProfileId` in
 * repositories/settings.ts), device-local and unsynced, so it needs no migration. The active
 * profile is a VIEW selector only; the alarm horizon is DEVICE-scoped and rings every local
 * profile's medicines regardless of which one is on screen (see the report, R1).
 *
 * ── C. SYNC FOUNDATION (forward-compatible, no behaviour) ────────────────────────────
 *
 * Per docs/MULTI-DEVICE-SYNC-DESIGN.md §5 + LOCKED DECISIONS: a profile is the unit of
 * sharing, so it needs a stable public id (`share_id`) and a record of which device owns the
 * alarms (`owner_device_id`, the doc's "Owner"/"master"). Adding them now means the sharing
 * build never has to migrate `profile` on a phone that already holds a health record.
 *
 *   • `share_id` is UNIQUE but nullable (null until shared, and most profiles stay null).
 *     SQLite forbids a UNIQUE constraint on ALTER … ADD COLUMN, so it is a partial unique
 *     index instead — which also states the intent: uniqueness applies to the ids that exist,
 *     and any number of profiles may sit at NULL.
 *   • `profile_member` is created EMPTY and stays empty this round. Its existence now is the
 *     whole point — the reserved shape from §5 so membership has somewhere to land later. It
 *     is local-only (`sync: false` in TABLES): membership is managed by the owner, never
 *     merged. No foreign key to `profile(share_id)`: the target is nullable, the table is
 *     empty, and an FK on a reserved table is friction with nothing to protect.
 *
 * ── D. BRIEFCASE PIN (`document.is_pinned`) ──────────────────────────────────────────
 *
 * A pinned section on top of the briefcase. Defaults to 0 and is CHECK (0,1), mirroring
 * `owns_file` exactly — a row written by a caller that has never heard of pinning is simply
 * unpinned, which is the safe and obvious default. Pinning is a per-device VIEW preference,
 * so it does not travel (document stays `sync: false` regardless; see v5).
 */
const V7_PER_DAY_OVERRIDE = [
  // The one occurrence's ring time, overriding the schedule's slot time for THIS date only.
  // NULL = ring at `time_local`, the schedule's own time. 'HH:MM' wall clock, never an
  // epoch — the occurrence's `scheduled_at_epoch` is re-derived from it at every reconcile,
  // so a DST shift or a flight moves the overridden dose too instead of stranding it.
  `ALTER TABLE dose_occurrence ADD COLUMN override_time_local TEXT;`,
] as const;

const V7_MULTI_PROFILE_SYNC_FOUNDATION = [
  // The profile's stable public identity once it is shared; the rows it publishes ride under
  // this. NULL until sharing is turned on for the profile, which is the normal state.
  `ALTER TABLE profile ADD COLUMN share_id TEXT;`,
  // The device that OWNS the alarms for this profile (the design's Owner/master). NULL means
  // "this device, not yet shared". Reassignable when ownership transfers.
  `ALTER TABLE profile ADD COLUMN owner_device_id TEXT;`,
  // UNIQUE across the ids that EXIST — a partial index because (a) ALTER ADD COLUMN cannot
  // carry a UNIQUE constraint, and (b) many profiles legitimately sit at NULL and must not
  // collide there.
  `CREATE UNIQUE INDEX idx_profile_share_id ON profile(share_id) WHERE share_id IS NOT NULL;`,

  // Reserved and EMPTY this round. The membership shape from docs/MULTI-DEVICE-SYNC-DESIGN.md
  // §5, created now so the sharing build needs no `profile` migration later. Local-only
  // (TABLES: sync:false) — membership is managed by the owner, not merged between devices.
  `CREATE TABLE profile_member (
     share_id         TEXT NOT NULL,
     device_id        TEXT NOT NULL,
     public_key       TEXT,
     device_label     TEXT,
     role             TEXT,
     added_at_epoch   INTEGER,
     removed_at_epoch INTEGER,
     PRIMARY KEY (share_id, device_id)
   );`,
] as const;

const V7_BRIEFCASE_PIN = [
  // 0 = not pinned (the default a caller that never thought about pinning gets), 1 = pinned
  // to the top of the briefcase. CHECK mirrors `owns_file`; pinning is a per-device view
  // preference and does not sync.
  `ALTER TABLE document ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0
     CHECK (is_pinned IN (0,1));`,
] as const;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'v1_initial',
    statements: [...V1_CORE, ...V1_MEDICINES, ...V1_CARE, ...V1_ENGAGEMENT_SYNC, ...V1_TRIGGERS],
  },
  // v2 is a deliberate no-op that exercises the DROP/CREATE-trigger backfill path,
  // so the mechanism is proven before it is ever needed under pressure.
  {
    version: 2,
    name: 'v2_prove_trigger_lift',
    statements: [
      `INSERT OR REPLACE INTO app_meta(key, value) VALUES ('trigger_lift_drill', 'passed');`,
    ],
  },
  /**
   * v3 — remove the tables left behind by the sharing rewrite.
   *
   * Sharing originally worked by minting a single-use invite, having the viewer redeem it,
   * and having the patient approve that specific device; `viewer` held the approved devices
   * and `invite` held the outstanding tokens. That model was replaced by one rotatable
   * public link per profile, which has no device registry and no token queue — the link
   * itself is the credential and rotation is the revocation. Neither table is referenced by
   * any code any more.
   *
   * THIS IS THE RULE-2 EXCEPTION, and both halves of it hold:
   *
   *  • Referenced by no code. Verified by grep across `src/`: the words appear only in
   *    prose comments. Nothing reads, writes, or joins either table.
   *  • Can hold no user data. Sharing has never been operable in any build: it requires a
   *    Supabase project that has never been provisioned, and the invite host shipped as the
   *    literal placeholder `REPLACE-ME.github.io`, which `inviteUrl()` refused to mint links
   *    for. There is no install anywhere with a row in either table.
   *
   * Leaving them would be the riskier choice, not the safer one: an empty table that looks
   * like part of the schema is an invitation for someone to write against it later and
   * rediscover, the hard way, that nothing syncs it.
   *
   * `IF EXISTS` because a database created after this migration ships will never have had
   * them, and a migration must be safe to run against any prior version.
   */
  {
    version: 3,
    name: 'v3_drop_unused_invite_tables',
    statements: [
      `DROP TABLE IF EXISTS invite;`,
      `DROP TABLE IF EXISTS viewer;`,
    ],
  },
  {
    version: 4,
    name: 'v4_symptom_retirement_censored_readings_briefcase',
    statements: [...V4_SYMPTOM_REGISTRY, ...V4_CENSORED_READINGS, ...V4_BRIEFCASE],
  },
  {
    version: 5,
    name: 'v5_briefcase_is_not_synced',
    statements: [...V5_BRIEFCASE_STAYS_PUT],
  },
  {
    version: 6,
    name: 'v6_local_paths_do_not_travel',
    statements: [...V6_PATHS_STOP_TRAVELLING],
  },
  {
    version: 7,
    name: 'v7_override_multiprofile_pin_sync_foundation',
    statements: [
      ...V7_PER_DAY_OVERRIDE,
      ...V7_MULTI_PROFILE_SYNC_FOUNDATION,
      ...V7_BRIEFCASE_PIN,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS.length;
