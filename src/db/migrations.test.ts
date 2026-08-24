/**
 * Tests for the schema itself — the migration list and the reference seed.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Every other layer of this app can be fixed in the next release. The schema cannot: a
 * migration ships once, runs once, and by the time anyone notices it was wrong it has
 * already run on the only copy of somebody's health record. So the two halves are proved
 * here against a REAL SQLite engine — `node:sqlite`, the same trick
 * `scripts/seed-dev-data.ts` uses — rather than by reading the SQL and believing it.
 *
 * WHAT IS ACTUALLY AT STAKE, IN THE ORDER IT MATTERS
 *
 *  1. THE APP MUST NOT INVENT A MEASUREMENT. v4 adds `reading.qualifier_bound`, which
 *     holds the limit a meter printed LO or HI against. It sits one column away from
 *     `v1`, which holds numbers the meter actually produced, and the difference between
 *     them is the difference between "her sugar was below 20" and "her sugar was 20".
 *     Downstream — CSV, the OPD table, any future average, a doctor's own spreadsheet —
 *     a qualifier column can be dropped and a value column cannot, so the confusion would
 *     be silent and permanent. There is a trigger. It is tested from both directions,
 *     because `editReading` can change the qualifier of a row that already has a value.
 *
 *  2. HER OWN RECORDS MUST SURVIVE THE UPGRADE UNCHANGED. `symptom_event` stores a key
 *     and nothing else; the words come from `symptom_def` at read time. Retiring the
 *     merged nausea/vomiting chip therefore has to leave that row's LABEL exactly as it
 *     was, or a symptom she logged in July silently starts saying something else on the
 *     sheet she hands her doctor in September.
 *
 *  3. TWO INSTALLS MUST AGREE. `INSERT OR IGNORE` can add a reference row but can never
 *     change one, so anything the seed computes rather than states — `sort_order` used to
 *     be the row's position in an array — diverges the moment a row is inserted in the
 *     middle: a fresh phone gets the new numbering, an existing phone keeps the old one,
 *     and the same build orders the same chips two different ways with nothing to see in
 *     the diff. The test below builds a v3 database with the OLD seed shape, upgrades it,
 *     re-seeds it, and asserts it converges byte for byte with a fresh install.
 *
 *  4. THE THING THAT WAS ACTUALLY REPORTED. A TB profile must be offered "Vomiting" — and
 *     also "blood in the sputum", "yellow eyes" and "dark urine", which the pack has
 *     always mapped and no build has ever displayed.
 *
 * On the dynamic import: Node's type-stripping loader resolves only fully-specified
 * './x.ts' paths, while this project's tsconfig does not enable
 * `allowImportingTsExtensions`. Loading through a non-literal specifier and re-typing the
 * namespace keeps both the runtime and `tsc --noEmit` happy — same trick as
 * `features/slots/registry.test.ts`.
 *
 * `migrations.ts` and `seed.ts` import nothing at all, so nothing native loads here.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MIGRATIONS_MODULE = './migrations.ts';
const SEED_MODULE = './seed.ts';

const { MIGRATIONS, LATEST_VERSION } = (await import(
  MIGRATIONS_MODULE
)) as typeof import('./migrations');

const { seedReferenceData, BASE_SYMPTOMS, PACK_SYMPTOMS_EXTRA, RETIRED_AT_EPOCH, GLUCOMETERS } =
  (await import(SEED_MODULE)) as typeof import('./seed');

// ── Harness ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Mirrors `applyMigration` in ./index.ts: one exclusive transaction per migration, and
 * `user_version` set inside it. `from` exists so a test can build an old database and
 * then upgrade it, which is the case that actually ships.
 */
function applyMigrations(db: DatabaseSync, upTo: number, from = 0): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= from || migration.version > upTo) continue;
    db.exec('BEGIN EXCLUSIVE;');
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${migration.version};`);
    db.exec('COMMIT;');
  }
}

/** `seedReferenceData` wants an async runner; node:sqlite is synchronous. */
function seedAdapter(db: DatabaseSync) {
  return {
    runAsync(sql: string, params: (string | number | null)[]): Promise<unknown> {
      db.prepare(sql).run(...params);
      return Promise.resolve(null);
    },
  };
}

function all(db: DatabaseSync, sql: string, ...params: (string | number)[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function one(db: DatabaseSync, sql: string, ...params: (string | number)[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

/** A v4 database with the reference data in it — the state a new phone boots into. */
async function freshInstall(): Promise<DatabaseSync> {
  const db = openDb();
  applyMigrations(db, LATEST_VERSION);
  await seedReferenceData(seedAdapter(db));
  return db;
}

/**
 * A database as it exists on a phone that has been in use — v3 schema, the OLD seed
 * shape (positional `sort_order`, the merged nausea/vomiting key, no retirement column),
 * a symptom she recorded against that key, and a LO glucose reading.
 */
function legacyInstall(): DatabaseSync {
  const db = openDb();
  applyMigrations(db, 3);

  const legacyKeys = [
    'breathless', 'chest_discomfort', 'dizzy', 'very_tired', 'swollen_feet', 'cough',
    'fever', 'shaky_sweaty', 'night_sweats', 'blurred_vision', 'numb_feet',
    'poor_appetite', 'headache', 'nausea_vomiting', 'stomach_pain', 'sleep_trouble',
    'joint_pain', 'itching',
    'chest_pain', 'palpitations', 'breathless_lying', 'slow_healing_wound',
    'blood_in_sputum', 'wheeze', 'yellow_eyes', 'dark_urine', 'unusual_bruising',
    'bleeding_gums', 'blood_in_urine', 'black_stool', 'passing_less_urine',
    'wound_discharge', 'neck_swelling', 'feeling_cold',
  ];
  legacyKeys.forEach((key, index) => {
    db.prepare(
      `INSERT INTO symptom_def(key, label_en, label_hi, is_base, sort_order)
       VALUES (?, ?, ?, ?, ?);`,
    ).run(key, `EN ${key}`, `HI ${key}`, index < 18 ? 1 : 0, index * 10);
  });

  db.prepare(
    `INSERT INTO condition_pack(key, label_en, label_hi, sort_order)
     VALUES ('tb', 'TB treatment', 'टीबी का इलाज', 90);`,
  ).run();
  db.prepare(`INSERT INTO pack_symptom(pack_key, symptom_key) VALUES ('tb', 'nausea_vomiting');`).run();
  db.prepare(`INSERT INTO pack_symptom(pack_key, symptom_key) VALUES ('tb', 'blood_in_sputum');`).run();
  db.prepare(`INSERT INTO pack_symptom(pack_key, symptom_key) VALUES ('tb', 'yellow_eyes');`).run();
  db.prepare(`INSERT INTO pack_symptom(pack_key, symptom_key) VALUES ('tb', 'dark_urine');`).run();

  db.prepare(
    `INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch)
     VALUES ('p1', 'Her', 1, 1);`,
  ).run();
  db.prepare(
    `INSERT INTO profile_condition(profile_id, pack_key, created_at_epoch)
     VALUES ('p1', 'tb', 1);`,
  ).run();

  // The symptom she logged before any of this changed.
  db.prepare(
    `INSERT INTO symptom_event(id, profile_id, symptom_key, severity, at_epoch, local_date,
                               local_time, tz_offset_minutes, created_at_epoch, updated_at_epoch)
     VALUES ('e1', 'p1', 'nausea_vomiting', 'moderate', 1, '2026-07-01', '09:00', 330, 1, 1);`,
  ).run();

  db.prepare(
    `INSERT INTO metric_def(key, label_en, label_hi, unit, value_kind, schema_json,
                            chart_kind, min_valid, max_valid, sort_order)
     VALUES ('blood_glucose', 'Blood sugar', 'ब्लड शुगर', 'mg/dL', 'scalar', '{}',
             'scatter', 0, 1000, 20);`,
  ).run();
  // A meter that printed LO, recorded before there was anywhere to put the limit.
  db.prepare(
    `INSERT INTO reading(id, profile_id, metric_key, v1, value_qualifier, at_epoch,
                         local_date, local_time, tz_offset_minutes, created_at_epoch,
                         updated_at_epoch)
     VALUES ('r_lo', 'p1', 'blood_glucose', NULL, 'below_range', 1, '2026-07-01',
             '07:10', 330, 1, 1);`,
  ).run();

  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('registry_seed_version', '1');`).run();
  return db;
}

// ── The list itself ──────────────────────────────────────────────────────────

test('the migration list is append-only and index === user_version', () => {
  MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.version, index + 1, `migration ${index} is numbered ${migration.version}`);
    assert.ok(migration.name.length > 0);
    assert.ok(migration.statements.length > 0, `${migration.name} has no statements`);
  });
  assert.equal(LATEST_VERSION, MIGRATIONS.length);
});

test('every migration statement is a frozen literal, not something computed at import', () => {
  // A migration whose SQL is generated from a live constant silently rewrites itself the
  // day that constant changes — and it has already run on the phones that matter.
  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      assert.equal(typeof statement, 'string');
      assert.ok(statement.trim().length > 0);
    }
  }
});

test('a fresh install applies cleanly and passes both integrity checks', async () => {
  const db = await freshInstall();
  assert.equal((one(db, 'PRAGMA user_version;') as { user_version: number }).user_version, LATEST_VERSION);
  assert.equal((one(db, 'PRAGMA integrity_check;') as { integrity_check: string }).integrity_check, 'ok');
  assert.equal(all(db, 'PRAGMA foreign_key_check;').length, 0);
  db.close();
});

test('an in-use v3 database upgrades cleanly and passes both integrity checks', () => {
  const db = legacyInstall();
  applyMigrations(db, LATEST_VERSION, 3);
  assert.equal((one(db, 'PRAGMA integrity_check;') as { integrity_check: string }).integrity_check, 'ok');
  assert.equal(all(db, 'PRAGMA foreign_key_check;').length, 0);
  db.close();
});

test('the seed still ships not one target range', async () => {
  // The single rule in seed.ts that is not negotiable. Asserted against the TABLE, not
  // against the counter the seed returns about itself.
  const db = await freshInstall();
  assert.equal((one(db, 'SELECT COUNT(*) AS n FROM target_range;') as { n: number }).n, 0);
  db.close();
});

// ── Report 4 — the symptom split ─────────────────────────────────────────────

test('a TB profile is offered Vomiting — and the three TB chips no build has ever shown', async () => {
  const db = legacyInstall();
  applyMigrations(db, LATEST_VERSION, 3);
  // The boot after the upgrade: the marker is gone, so the seed runs again.
  await seedReferenceData(seedAdapter(db));

  const chips = all(
    db,
    `SELECT key FROM symptom_def
      WHERE retired_at_epoch IS NULL
        AND (is_base = 1
             OR key IN (SELECT ps.symptom_key FROM pack_symptom ps
                          JOIN profile_condition pc ON pc.pack_key = ps.pack_key
                         WHERE pc.profile_id = ? AND pc.ended_on IS NULL))
      ORDER BY sort_order, label_en;`,
    'p1',
  ).map((row) => row['key'] as string);

  assert.ok(chips.includes('vomiting'), 'the reported defect: Vomiting must be offerable');
  assert.ok(chips.includes('nausea'));
  // Bigger than what was reported: these are mapped to the TB pack in seed.ts and were
  // unreachable in every build, because the screen sliced a global list to twelve.
  for (const key of ['blood_in_sputum', 'yellow_eyes', 'dark_urine']) {
    assert.ok(chips.includes(key), `${key} must be offerable on a TB course`);
  }
  assert.ok(!chips.includes('nausea_vomiting'), 'the merged chip must never be offered again');
  db.close();
});

test('the retired key keeps its row, its wording, and the event she recorded against it', async () => {
  const db = legacyInstall();
  const before = one(db, `SELECT label_en, label_hi FROM symptom_def WHERE key = 'nausea_vomiting';`);
  applyMigrations(db, LATEST_VERSION, 3);
  await seedReferenceData(seedAdapter(db));

  const after = one(db, `SELECT label_en, label_hi, retired_at_epoch FROM symptom_def WHERE key = 'nausea_vomiting';`);
  assert.ok(after);
  // The label is the whole point. Rewriting it would change what a symptom she logged in
  // July says on the report she hands over in September.
  assert.equal(after['label_en'], before?.['label_en']);
  assert.equal(after['label_hi'], before?.['label_hi']);
  assert.equal(after['retired_at_epoch'], RETIRED_AT_EPOCH);

  const event = one(db, `SELECT symptom_key, severity FROM symptom_event WHERE id = 'e1';`);
  assert.equal(event?.['symptom_key'], 'nausea_vomiting');
  assert.equal(event?.['severity'], 'moderate');

  db.close();
});

test('the registry read still resolves a retired key, and the chip read still hides it', async () => {
  // THE MISTAKE THIS TEST EXISTS TO CATCH. Five call sites — the Today screen, Trends,
  // the backfill editor, the visit-questions screen and features/reports/data/collect.ts,
  // which builds the OPD report and the CSV — call `listSymptomDefs()` to build a
  // key→label map for events ALREADY RECORDED, and fall back to printing the raw key
  // when the map misses. If the registry read ever starts filtering retired keys, a
  // symptom she logged in July prints on her doctor's page as `nausea_vomiting`.
  //
  // So the registry read must NOT filter, and the chip reads must. Both shapes are
  // asserted here, because getting them the wrong way round type-checks perfectly.
  const db = await freshInstall();

  const registry = all(db, `SELECT key, label_en FROM symptom_def ORDER BY sort_order, label_en;`);
  const retired = registry.find((row) => row['key'] === 'nausea_vomiting');
  assert.ok(retired, 'the registry read must still return the retired key');
  assert.equal(retired['label_en'], 'Feeling sick or vomiting', 'and its original wording');

  const offerable = all(
    db,
    `SELECT key FROM symptom_def WHERE retired_at_epoch IS NULL ORDER BY sort_order, label_en;`,
  ).map((row) => row['key'] as string);
  assert.ok(!offerable.includes('nausea_vomiting'));
  assert.equal(offerable.length, registry.length - 1);
  db.close();
});

test('a fresh install retires the merged key too — the migration is not the only path', async () => {
  // On a new phone the v4 UPDATE matches nothing, because the seed has not run yet. If
  // the seed did not carry the retirement itself, the duplicate chip would come straight
  // back on every install after this one.
  const db = await freshInstall();
  const row = one(db, `SELECT retired_at_epoch FROM symptom_def WHERE key = 'nausea_vomiting';`);
  assert.equal(row?.['retired_at_epoch'], RETIRED_AT_EPOCH);
  db.close();
});

test('an upgraded phone and a fresh install end up with identical chip ordering', async () => {
  const fresh = await freshInstall();
  const upgraded = legacyInstall();
  applyMigrations(upgraded, LATEST_VERSION, 3);
  await seedReferenceData(seedAdapter(upgraded));

  const order = (db: DatabaseSync) =>
    all(db, `SELECT key, sort_order FROM symptom_def ORDER BY sort_order, key;`)
      .map((row) => `${String(row['key'])}=${String(row['sort_order'])}`)
      .join(',');

  assert.equal(order(upgraded), order(fresh));

  // …and both agree with the source of truth, so a future edit to one list without the
  // other fails here rather than on somebody's phone.
  const declared = new Map(
    [...BASE_SYMPTOMS, ...PACK_SYMPTOMS_EXTRA].map((symptom) => [symptom.key, symptom.sortOrder]),
  );
  for (const row of all(fresh, `SELECT key, sort_order FROM symptom_def;`)) {
    assert.equal(row['sort_order'], declared.get(row['key'] as string), `sort_order for ${String(row['key'])}`);
  }
  assert.equal(declared.size, BASE_SYMPTOMS.length + PACK_SYMPTOMS_EXTRA.length, 'duplicate symptom key');

  // No two offered chips may share a position, or the grid reshuffles between visits.
  const positions = all(fresh, `SELECT sort_order FROM symptom_def WHERE retired_at_epoch IS NULL;`)
    .map((row) => row['sort_order'] as number);
  assert.equal(new Set(positions).size, positions.length, 'two chips share a sort_order');

  fresh.close();
  upgraded.close();
});

test('the upgrade clears the seed marker, or the new chips never arrive', () => {
  const db = legacyInstall();
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'registry_seed_version';`)?.['value'], '1');
  applyMigrations(db, LATEST_VERSION, 3);
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'registry_seed_version';`), undefined);
  db.close();
});

// ── Report 1 — a bound is not a measurement ──────────────────────────────────

test('a LO reading may carry a bound, and an exact reading may carry a value', async () => {
  const db = await freshInstall();
  db.prepare(`INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch) VALUES ('p1','Her',1,1);`).run();

  const insert = (id: string, v1: number | null, qualifier: string, bound: number | null) =>
    db
      .prepare(
        `INSERT INTO reading(id, profile_id, metric_key, v1, value_qualifier, qualifier_bound,
                             at_epoch, local_date, local_time, tz_offset_minutes,
                             created_at_epoch, updated_at_epoch)
         VALUES (?, 'p1', 'blood_glucose', ?, ?, ?, 1, '2026-07-01', '07:10', 330, 1, 1);`,
      )
      .run(id, v1, qualifier, bound);

  insert('ok_exact', 110, 'exact', null);
  insert('ok_lo_bounded', null, 'below_range', 20);
  insert('ok_hi_bounded', null, 'above_range', 600);
  // No meter recorded yet. Still a complete record: she saw LO, and that is the fact.
  insert('ok_lo_unbounded', null, 'below_range', null);
  // An exact reading with no number is how a note-only row already behaves; unaffected.
  insert('ok_exact_null', null, 'exact', null);

  assert.equal((one(db, `SELECT COUNT(*) AS n FROM reading;`) as { n: number }).n, 5);
  db.close();
});

test('the database refuses to let a meter limit become a measurement', async () => {
  const db = await freshInstall();
  db.prepare(`INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch) VALUES ('p1','Her',1,1);`).run();

  const insert = (id: string, v1: number | null, qualifier: string, bound: number | null) =>
    db
      .prepare(
        `INSERT INTO reading(id, profile_id, metric_key, v1, value_qualifier, qualifier_bound,
                             at_epoch, local_date, local_time, tz_offset_minutes,
                             created_at_epoch, updated_at_epoch)
         VALUES (?, 'p1', 'blood_glucose', ?, ?, ?, 1, '2026-07-01', '07:10', 330, 1, 1);`,
      )
      .run(id, v1, qualifier, bound);

  // THE ONE THAT MATTERS: writing the meter's floor into the value column, which is how
  // "her sugar was below 20" becomes "her sugar was 20" three exports downstream.
  assert.throws(() => insert('bad_1', 20, 'below_range', 20), /bound is not a measurement/);
  // A value plus a qualifier, with no bound — the same fabrication, one column short.
  assert.throws(() => insert('bad_2', 20, 'below_range', null), /bound is not a measurement/);
  // A bound on a reading that has a real number. Nothing to bound; the pair is nonsense.
  assert.throws(() => insert('bad_3', 110, 'exact', 20), /bound is not a measurement/);

  // UPDATE is guarded too. `editReading` can change a qualifier in place, so an
  // insert-only trigger would leave the whole hole open through the correction path.
  insert('lo', null, 'below_range', 20);
  assert.throws(() => db.prepare(`UPDATE reading SET v1 = 18 WHERE id = 'lo';`).run(), /bound is not a measurement/);
  insert('exact', 110, 'exact', null);
  assert.throws(() => db.prepare(`UPDATE reading SET qualifier_bound = 20 WHERE id = 'exact';`).run(), /bound is not a measurement/);
  assert.throws(
    () => db.prepare(`UPDATE reading SET value_qualifier = 'below_range' WHERE id = 'exact';`).run(),
    /bound is not a measurement/,
  );
  db.close();
});

test('the ordinary writes a reading still needs are not blocked by the new triggers', async () => {
  const db = await freshInstall();
  db.prepare(`INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch) VALUES ('p1','Her',1,1);`).run();
  db.prepare(
    `INSERT INTO reading(id, profile_id, metric_key, v1, value_qualifier, qualifier_bound,
                         at_epoch, local_date, local_time, tz_offset_minutes,
                         created_at_epoch, updated_at_epoch)
     VALUES ('lo', 'p1', 'blood_glucose', NULL, 'below_range', 20, 1, '2026-07-01', '07:10', 330, 1, 1);`,
  ).run();

  // Soft delete, lamport bump, note edit, and the correction that removes a qualifier.
  db.prepare(`UPDATE reading SET note = 'felt shaky' WHERE id = 'lo';`).run();
  db.prepare(`UPDATE reading SET lamport = 7, updated_at_epoch = 9 WHERE id = 'lo';`).run();
  db.prepare(`UPDATE reading SET value_qualifier = 'exact', qualifier_bound = NULL, v1 = 42 WHERE id = 'lo';`).run();
  db.prepare(`UPDATE reading SET deleted_at_epoch = 10 WHERE id = 'lo';`).run();
  assert.equal((one(db, `SELECT v1 FROM reading WHERE id = 'lo';`) as { v1: number }).v1, 42);
  db.close();
});

test('an existing LO reading survives the upgrade and can then be given its bound', () => {
  const db = legacyInstall();
  applyMigrations(db, LATEST_VERSION, 3);

  const row = one(db, `SELECT v1, value_qualifier, qualifier_bound FROM reading WHERE id = 'r_lo';`);
  assert.equal(row?.['v1'], null);
  assert.equal(row?.['value_qualifier'], 'below_range');
  assert.equal(row?.['qualifier_bound'], null, 'nothing may be invented for a reading taken before the meter was known');

  db.prepare(`UPDATE reading SET qualifier_bound = 20 WHERE id = 'r_lo';`).run();
  assert.equal(one(db, `SELECT qualifier_bound FROM reading WHERE id = 'r_lo';`)?.['qualifier_bound'], 20);
  db.close();
});

test('the glucometer list is a picker, not a default — and every range is the right way round', () => {
  // Nothing is preselected anywhere; this list only exists so a human confirming her
  // meter does not have to type four digits with a tremor.
  assert.ok(GLUCOMETERS.length > 0);
  const keys = new Set(GLUCOMETERS.map((meter) => meter.key));
  assert.equal(keys.size, GLUCOMETERS.length, 'duplicate glucometer key');
  for (const meter of GLUCOMETERS) {
    assert.ok(meter.label.trim().length > 0);
    assert.ok(meter.low < meter.high, `${meter.key}: low must be below high`);
    // Inside what `blood_glucose` itself can hold, or a chart arrow lands off the axis.
    assert.ok(meter.low >= 0 && meter.high <= 1000, `${meter.key}: outside the metric's own range`);
  }
});

// ── Report 6 — the briefcase ─────────────────────────────────────────────────

test('document gains what a file she chose herself needs', async () => {
  const db = await freshInstall();
  const columns = all(db, `PRAGMA table_info(document);`).map((row) => row['name'] as string);
  for (const column of ['original_file_name', 'mime_type', 'size_bytes', 'owns_file']) {
    assert.ok(columns.includes(column), `document.${column} is missing`);
  }
  db.close();
});

test('owns_file defaults to 0, so a row written by a caller that has not thought about it is safe', () => {
  const db = legacyInstall();
  applyMigrations(db, LATEST_VERSION, 3);
  db.prepare(
    `INSERT INTO document(id, profile_id, kind, title, file_uri, created_at_epoch, updated_at_epoch)
     VALUES ('d1', 'p1', 'prescription', 'Dr Rao 4 March', 'file:///rx/1.jpg', 1, 1);`,
  ).run();
  // Deleting THIS row must never unlink the file: the prescription photograph is the only
  // evidence of what the doctor actually wrote, and another table points at it too.
  assert.equal(one(db, `SELECT owns_file FROM document WHERE id = 'd1';`)?.['owns_file'], 0);
  db.close();
});

test('owns_file is 0 or 1 and nothing else', async () => {
  const db = await freshInstall();
  db.prepare(`INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch) VALUES ('p1','Her',1,1);`).run();
  db.prepare(
    `INSERT INTO document(id, profile_id, kind, title, file_uri, owns_file, created_at_epoch, updated_at_epoch)
     VALUES ('d1', 'p1', 'discharge_summary', 'Hospital paper', 'file:///b/a.pdf', 1, 1, 1);`,
  ).run();
  assert.throws(() => db.prepare(`UPDATE document SET owns_file = 2 WHERE id = 'd1';`).run(), /CHECK/);
  db.close();
});

test('the deletion queue exists, holds a request, and is not part of sync', async () => {
  const db = await freshInstall();
  db.prepare(
    `INSERT INTO pending_file_delete(id, file_uri, reason, requested_at_epoch, attempts)
     VALUES ('q1', 'file:///b/a.pdf', 'document', 5, 0);`,
  ).run();
  const row = one(db, `SELECT file_uri, attempts, last_error FROM pending_file_delete WHERE id = 'q1';`);
  assert.equal(row?.['file_uri'], 'file:///b/a.pdf');
  assert.equal(row?.['attempts'], 0);
  assert.equal(row?.['last_error'], null);

  // Hard delete is how a completed request is retired — this is one of the very few
  // tables where that is correct, because the row IS a deletion.
  db.prepare(`DELETE FROM pending_file_delete WHERE id = 'q1';`).run();
  assert.equal((one(db, `SELECT COUNT(*) AS n FROM pending_file_delete;`) as { n: number }).n, 0);
  db.close();
});

// ── Report 7 — there is deliberately no schema for the log ───────────────────

test('nothing in the schema stores developer logs', async () => {
  // The log is a bounded file in the CACHE directory, on purpose. A table would be
  // snapshotted before every future migration, integrity-checked on every open, would
  // take the same write lock as a dose event — and the backup capsule exports the whole
  // database with VACUUM INTO, so log lines quoting an API error would ride inside every
  // capsule the family passes around. If this test ever fails, read that sentence again
  // before deleting it.
  const db = await freshInstall();
  const tables = new Set(
    all(db, `SELECT name FROM sqlite_master WHERE type = 'table';`).map((row) => row['name'] as string),
  );
  // Named rather than pattern-matched: `visit_log` and `sync_outbox` are records of
  // things that happened to HER, which is exactly what belongs in the database.
  for (const name of ['app_log', 'debug_log', 'error_log', 'log_entry', 'ai_log', 'diagnostic', 'diagnostics']) {
    assert.ok(!tables.has(name), `${name} exists — the developer log must not live in the database`);
  }
  db.close();
});

// ── v5 — the briefcase stops travelling, and takes back what it already sent ──
//
// THIS MIGRATION IS DML ON A QUEUE, WHICH MAKES IT EASIER TO GET WRONG THAN A SCHEMA
// CHANGE, NOT HARDER. A `CREATE TABLE` that is wrong fails loudly on the next open. These
// three statements can be wrong in four ways that all look like success: retracting on a
// phone that never uploaded (which PUBLISHES a count of her papers to a server that had
// none), failing to retract on one that did, deleting a tombstone somebody else queued, or
// handing out a lamport number twice. Each is one test below, against a real engine.

/** A v4 database with a profile — the state a phone is in the moment before v5 runs. */
function openAtV4(): DatabaseSync {
  const db = openDb();
  applyMigrations(db, 4);
  db.prepare(
    `INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch)
     VALUES ('p1', 'Her', 1, 1);`,
  ).run();
  return db;
}

/** A briefcase row, with the fields whose NAMES were the leak: title and file name. */
function addDocument(db: DatabaseSync, id: string, title: string): void {
  db.prepare(
    `INSERT INTO document(id, profile_id, kind, title, file_uri, created_at_epoch,
                          updated_at_epoch, original_file_name, mime_type, size_bytes, owns_file)
     VALUES (?, 'p1', 'discharge_summary', ?, ?, 1, 1, ?, 'application/pdf', 900, 1);`,
  ).run(id, title, `file:///data/user/0/in.aarogya.care/files/briefcase/${id}.pdf`, `${title}.pdf`);
}

function queueOutbox(db: DatabaseSync, table: string, rowId: string, op: string, lamport: number): void {
  db.prepare(
    `INSERT INTO sync_outbox(id, table_name, row_id, op, lamport, created_at_epoch)
     VALUES (?, ?, ?, ?, ?, 100);`,
  ).run(`ob-${table}-${rowId}-${op}-${lamport}`, table, rowId, op, lamport);
}

function outboxRows(db: DatabaseSync): Row[] {
  return all(db, `SELECT id, table_name, row_id, op, lamport, created_at_epoch
                    FROM sync_outbox ORDER BY table_name, row_id;`);
}

test('v5 on a fresh install does nothing at all', async () => {
  // There are no documents and no queue, so all three statements are no-ops — including the
  // lamport bump, which has no row to update. A migration that needed a row to exist would
  // be a migration that fails on the first phone it ever runs on.
  const db = await freshInstall();
  assert.equal(outboxRows(db).length, 0);
  assert.equal(all(db, `SELECT * FROM app_meta WHERE key = 'lamport';`).length, 0);
  assert.equal(all(db, `PRAGMA foreign_key_check;`).length, 0);
  db.close();
});

test('sharing never configured: the queued briefcase rows are dropped and NO tombstone is minted', () => {
  // The population that must not publish anything. Queueing tombstones unconditionally
  // would mean this phone — which has uploaded nothing, ever — sending one
  // `document:<uuid>` row key per paper the first time somebody turns sharing on. That is
  // a count of her documents arriving at a server that had none, caused by the fix.
  const db = openAtV4();
  addDocument(db, 'd1', 'Discharge summary');
  addDocument(db, 'd2', 'TB DOTS card');
  queueOutbox(db, 'document', 'd1', 'upsert', 11);
  queueOutbox(db, 'document', 'd2', 'upsert', 12);
  // A row from a table that DOES sync, to prove the DELETE is not over-broad.
  queueOutbox(db, 'reading', 'r1', 'upsert', 13);

  applyMigrations(db, LATEST_VERSION, 4);

  assert.deepEqual(
    outboxRows(db).map((row) => [row['table_name'], row['row_id'], row['op']]),
    [['reading', 'r1', 'upsert']],
  );
  assert.equal(all(db, `SELECT * FROM document;`).length, 2, 'the papers themselves must survive');
  db.close();
});

test('a configured project: every document is retracted, and an existing tombstone is left alone', () => {
  const db = openAtV4();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', 'https://x.supabase.co');`).run();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('lamport', '40');`).run();

  addDocument(db, 'd1', 'Discharge summary'); // pushed long ago; nothing queued
  addDocument(db, 'd2', 'TB DOTS card'); // queued upsert, never sent
  addDocument(db, 'd3', 'Insurance'); // removed last week; its own tombstone is waiting
  db.prepare(`UPDATE document SET deleted_at_epoch = 5 WHERE id = 'd3';`).run();
  queueOutbox(db, 'document', 'd2', 'upsert', 21);
  queueOutbox(db, 'document', 'd3', 'delete', 22);

  applyMigrations(db, LATEST_VERSION, 4);

  const rows = outboxRows(db);
  assert.deepEqual(
    rows.map((row) => [row['row_id'], row['op']]),
    [['d1', 'delete'], ['d2', 'delete'], ['d3', 'delete']],
    'every document must end up with exactly one tombstone and no content',
  );
  // d3's tombstone is the one SHE caused; it keeps its own id and its own lamport, or the
  // migration has quietly re-dated an ordinary Remove.
  const d3 = rows.find((row) => row['row_id'] === 'd3');
  assert.equal(d3?.['id'], 'ob-document-d3-delete-22');
  assert.equal(d3?.['lamport'], 22);
  // The new ones share the one borrowed number, which is then handed back.
  assert.equal(rows.find((row) => row['row_id'] === 'd1')?.['lamport'], 41);
  assert.equal(rows.find((row) => row['row_id'] === 'd2')?.['lamport'], 41);
  assert.equal(rows.find((row) => row['row_id'] === 'd1')?.['id'], 'v5-retract-d1');
  // 42, not 41: this upgrades to LATEST, and v6 borrows a number and hands it back too. The
  // tombstones above still carry 41 — v5's number is unchanged and that is what this test is
  // about. Every migration that borrows one spends one, and a gap costs nothing.
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'lamport';`)?.['value'], '42');

  // Millis, matching nowEpoch(). Seconds here would put every tombstone in 1970 and make
  // isDue() in the drain treat it as due forever — which is harmless, and exactly the kind
  // of harmless that hides the next unit mistake.
  const at = rows[0]?.['created_at_epoch'] as number;
  assert.ok(at > 1_700_000_000_000 && at < 4_000_000_000_000, `created_at_epoch was ${at}`);

  assert.equal(all(db, `SELECT * FROM document;`).length, 3, 'the papers themselves must survive');
  db.close();
});

test('replaying v5 mints nothing new — the tombstone ids are derived, not random', () => {
  const db = openAtV4();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', 'https://x.supabase.co');`).run();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('lamport', '40');`).run();
  addDocument(db, 'd1', 'Discharge summary');
  applyMigrations(db, LATEST_VERSION, 4);
  const first = outboxRows(db);

  // The runner cannot do this — `user_version` gates it — but a hand-run recovery can, and
  // a migration that duplicates on replay is one that cannot be re-run to fix a bad boot.
  db.exec('BEGIN EXCLUSIVE;');
  for (const statement of MIGRATIONS[4]?.statements ?? []) db.exec(statement);
  db.exec('COMMIT;');

  const second = outboxRows(db);
  assert.equal(second.length, first.length, 'the replay duplicated a tombstone');
  assert.deepEqual(second.map((row) => row['id']), first.map((row) => row['id']));
  db.close();
});

test('a configured project with no lamport row yet still gets a usable tombstone', () => {
  // `bumpLamport` writes that row lazily, so a phone that has a project configured and has
  // never written a syncable row does not have one. COALESCE(...,0)+1 is why the tombstone
  // gets 1 rather than NULL — a NULL lamport would sort unpredictably in the drain's
  // ORDER BY and is NOT NULL in the schema besides.
  const db = openAtV4();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', 'https://x.supabase.co');`).run();
  addDocument(db, 'd1', 'Discharge summary');

  applyMigrations(db, LATEST_VERSION, 4);

  assert.deepEqual(
    outboxRows(db).map((row) => [row['row_id'], row['op'], row['lamport']]),
    [['d1', 'delete', 1]],
  );
  // Nothing to hand back to, and the UPDATE must not have invented the row.
  assert.equal(all(db, `SELECT * FROM app_meta WHERE key = 'lamport';`).length, 0);
  db.close();
});

test('a blank supabaseUrl is not a configured project', () => {
  // `disableSync()` keeps the URL so sharing can be turned back on, and the honest reading
  // of "this handset was ever able to upload" is a URL with something in it. Whitespace is
  // not something.
  const db = openAtV4();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', '   ');`).run();
  addDocument(db, 'd1', 'Discharge summary');
  queueOutbox(db, 'document', 'd1', 'upsert', 9);

  applyMigrations(db, LATEST_VERSION, 4);

  assert.equal(outboxRows(db).length, 0, 'a blank URL must retract nothing and publish nothing');
  db.close();
});

test('the registry and the migration still agree that the briefcase does not travel', () => {
  // The two halves of one promise, in two files that can drift: the FLAG that stops the tap
  // (`_shared.ts`) and the MIGRATION that emptied the bucket (here). Flipping the flag back
  // would make the sentence at the top of `src/app/briefcase/index.tsx` false again — "not
  // on Google, not on any cloud, not on another phone" — and nothing else in the tree would
  // notice, because the migration has already run and cannot run twice.
  //
  // ASSERTED AGAINST THE SOURCE TEXT, WHICH NEEDS ITS EXCUSE. `_shared.ts` reaches
  // `../index` and therefore `expo-sqlite`, so `node --test` cannot import it — the same
  // constraint this file's header states about `migrations.ts` importing nothing. Reading
  // the one line is uglier than reading the constant and strictly weaker, and it is still
  // worth having: the failure it catches is a human editing `sync: false` to `sync: true`,
  // and that edit is visible in the text.
  // `import.meta.dirname` rather than `new URL(..., import.meta.url)`: this project's `lib`
  // includes the DOM, so the global `URL` is not Node's `URL` and `tsc` rejects every
  // `readFileSync`/`fileURLToPath` overload even though the runtime is perfectly happy.
  const registry = readFileSync(join(import.meta.dirname, 'repositories', '_shared.ts'), 'utf8');
  const documentLine = registry
    .split('\n')
    .find((line) => /^\s*document:\s*\{/.test(line));
  assert.ok(documentLine, 'the document entry has moved; this test needs rewriting, not deleting');
  assert.match(
    documentLine,
    /sync:\s*false/,
    'document must not sync — the briefcase screen promises these papers stay on this phone',
  );

  const v5 = MIGRATIONS[4];
  assert.equal(v5?.name, 'v5_briefcase_is_not_synced');
  assert.ok(
    v5?.statements.some((statement) =>
      /DELETE FROM sync_outbox[\s\S]*document[\s\S]*upsert/.test(statement),
    ),
    'v5 must still drop the queued briefcase content',
  );
});

// ── v6 — local file paths stop travelling, and the sent ones are taken back ───
//
// Same family of risk as v5, and one hazard that is entirely new. v5 queued TOMBSTONES for
// a table that must not sync; v6 queues ORDINARY UPSERTS for tables that must, so that the
// drain re-seals each row without its path and the server's (link_id, row_key) upsert
// REPLACES the payload that carried one. Getting the retraction shape wrong here does not
// fail — it deletes a prescription from the shared record to hide a filename.
//
// The new hazard is ordering. A soft delete writes `deleted_at_epoch` and queues a tombstone
// in one transaction, at whatever the lamport counter said then; the number borrowed below is
// higher than all of them. An upsert queued for a soft-deleted row would therefore drain
// AFTER its own tombstone and put the row back on the server, undeleted. That is one test.

/** A v5 database with a profile — the state a phone is in the moment before v6 runs. */
function openAtV5(): DatabaseSync {
  const db = openDb();
  applyMigrations(db, 5);
  db.prepare(
    `INSERT INTO profile(id, display_name, created_at_epoch, updated_at_epoch)
     VALUES ('p1', 'Her', 1, 1);`,
  ).run();
  return db;
}

function configureProject(db: DatabaseSync, lamport?: number): void {
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', 'https://x.supabase.co');`).run();
  if (lamport !== undefined) {
    db.prepare(`INSERT INTO app_meta(key, value) VALUES ('lamport', ?);`).run(String(lamport));
  }
}

const PRIVATE_DIR = 'file:///data/user/0/in.aarogya.care/files';

/** One row per table that carries a path, plus the audit row that carries two. */
function addPhotographedRecords(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO prescription(id, profile_id, image_uri, cropped_image_uri, prescriber,
                              created_at_epoch, updated_at_epoch)
     VALUES ('rx1', 'p1', ?, ?, 'Dr Rao', 1, 1);`,
  ).run(`${PRIVATE_DIR}/rx/march.jpg`, `${PRIVATE_DIR}/rx/march-crop.jpg`);
  // A prescription with no photograph at all: typed in by hand. Nothing to retract.
  db.prepare(
    `INSERT INTO prescription(id, profile_id, prescriber, created_at_epoch, updated_at_epoch)
     VALUES ('rx2', 'p1', 'Dr Iyer', 1, 1);`,
  ).run();

  db.prepare(
    `INSERT INTO medicine(id, thread_id, version, profile_id, name_as_written, strip_photo_uri,
                          created_at_epoch, updated_at_epoch)
     VALUES ('m1', 't1', 1, 'p1', 'Rifampicin 450', ?, 1, 1);`,
  ).run(`${PRIVATE_DIR}/strips/m1.jpg`);
  db.prepare(
    `INSERT INTO medicine(id, thread_id, version, profile_id, name_as_written,
                          created_at_epoch, updated_at_epoch)
     VALUES ('m2', 't2', 1, 'p1', 'Metformin 500', 1, 1);`,
  ).run();

  db.prepare(
    `INSERT INTO symptom_event(id, profile_id, custom_label, photo_uri, at_epoch, local_date,
                               local_time, tz_offset_minutes, created_at_epoch, updated_at_epoch)
     VALUES ('s1', 'p1', 'rash on arm', ?, 1, '2026-07-01', '09:00', 330, 1, 1);`,
  ).run(`${PRIVATE_DIR}/sym/s1.jpg`);

  db.prepare(
    `INSERT INTO lab_result(id, profile_id, custom_label, report_uri, created_at_epoch, updated_at_epoch)
     VALUES ('l1', 'p1', 'Sputum AFB', ?, 1, 1);`,
  ).run(`${PRIVATE_DIR}/labs/l1.pdf`);

  // The second door: a photo correction, whose paths sit under `old_value`/`new_value`.
  db.prepare(
    `INSERT INTO record_edit(id, record_kind, record_id, field, old_value, new_value, at_epoch)
     VALUES ('ed1', 'symptom_event', 's1', 'photo_uri', ?, ?, 1);`,
  ).run(`${PRIVATE_DIR}/sym/old.jpg`, `${PRIVATE_DIR}/sym/s1.jpg`);
  // An ordinary correction, which must NOT be re-queued: nothing is wrong with it.
  db.prepare(
    `INSERT INTO record_edit(id, record_kind, record_id, field, old_value, new_value, at_epoch)
     VALUES ('ed2', 'reading', 'r1', 'v1', '108', '180', 1);`,
  ).run();
}

test('v6 on a fresh install does nothing at all', async () => {
  // No records, no queue, no lamport row to bump. A migration that needed a row to exist
  // would be one that fails on the first phone it ever runs on.
  const db = await freshInstall();
  assert.equal(outboxRows(db).length, 0);
  assert.equal(all(db, `SELECT * FROM app_meta WHERE key = 'lamport';`).length, 0);
  assert.equal(all(db, `PRAGMA foreign_key_check;`).length, 0);
  db.close();
});

test('sharing never configured: nothing is queued, so turning it on later publishes no history', () => {
  // The argument is v5's and it is independently true here. A phone with no project has
  // published nothing, and a newly-configured phone publishes only what is written from then
  // on — nothing replays history except a rotation. Queueing unconditionally would mean that
  // the first time she ever switches sharing on, every old prescription, strip photo and lab
  // report uploads at once. Rows the server would otherwise never have seen, caused by the fix.
  const db = openAtV5();
  addPhotographedRecords(db);
  applyMigrations(db, LATEST_VERSION, 5);

  assert.equal(outboxRows(db).length, 0);
  db.close();
});

test('a blank supabaseUrl is not a configured project', () => {
  const db = openAtV5();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', '   ');`).run();
  addPhotographedRecords(db);
  applyMigrations(db, LATEST_VERSION, 5);

  assert.equal(outboxRows(db).length, 0, 'whitespace is not a project');
  db.close();
});

test('a configured project: every row that carries a path is re-queued, and nothing else is', () => {
  const db = openAtV5();
  configureProject(db, 40);
  addPhotographedRecords(db);

  applyMigrations(db, LATEST_VERSION, 5);

  assert.deepEqual(
    outboxRows(db).map((row) => [row['table_name'], row['row_id'], row['op']]),
    [
      ['lab_result', 'l1', 'upsert'],
      ['medicine', 'm1', 'upsert'],
      ['prescription', 'rx1', 'upsert'],
      ['record_edit', 'ed1', 'upsert'],
      ['symptom_event', 's1', 'upsert'],
    ],
    'rx2, m2 and ed2 carry no path and must not be touched',
  );

  // UPSERT, never delete. A tombstone here would remove her prescription from the shared
  // record in order to hide a filename — the cure being worse than the disease.
  assert.equal(outboxRows(db).every((row) => row['op'] === 'upsert'), true);

  // One borrowed number, one past the counter, handed back afterwards. Higher than every
  // version of these rows a reader has already seen, so the stripped payload is the last
  // word rather than an older one replayed over a newer.
  assert.equal(outboxRows(db).every((row) => row['lamport'] === 41), true);
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'lamport';`)?.['value'], '41');

  // Millis, matching nowEpoch(). Seconds would put every row in 1970 — harmless, and exactly
  // the kind of harmless that hides the next unit mistake.
  const at = outboxRows(db)[0]?.['created_at_epoch'] as number;
  assert.ok(at > 1_700_000_000_000 && at < 4_000_000_000_000, `created_at_epoch was ${at}`);

  // Not one byte of her record is altered. The photographs, the rows and the paths that
  // point at them are all exactly where they were — this migration only writes to a queue.
  assert.equal(
    one(db, `SELECT image_uri FROM prescription WHERE id = 'rx1';`)?.['image_uri'],
    `${PRIVATE_DIR}/rx/march.jpg`,
  );
  assert.equal(
    one(db, `SELECT old_value FROM record_edit WHERE id = 'ed1';`)?.['old_value'],
    `${PRIVATE_DIR}/sym/old.jpg`,
  );
  db.close();
});

test('a SOFT-DELETED row is never re-queued, or the retraction would undelete it', () => {
  // THE HAZARD THAT IS NEW IN v6 AND WOULD BE SILENT. `softDeleteRecord` writes
  // `deleted_at_epoch` and queues a tombstone in ONE transaction, at the lamport of that
  // moment — necessarily lower than the number v6 borrows. An upsert queued here would drain
  // AFTER that tombstone and put the row back on the server, undeleted, to hide a filename
  // the tombstone had already removed. She deleted it. It stays deleted.
  const db = openAtV5();
  configureProject(db, 40);
  addPhotographedRecords(db);

  db.prepare(`UPDATE prescription SET deleted_at_epoch = 5 WHERE id = 'rx1';`).run();
  db.prepare(`UPDATE symptom_event SET deleted_at_epoch = 5 WHERE id = 's1';`).run();
  db.prepare(`UPDATE lab_result SET deleted_at_epoch = 5 WHERE id = 'l1';`).run();
  db.prepare(`UPDATE medicine SET deleted_at_epoch = 5 WHERE id = 'm1';`).run();
  // Her own tombstone, already queued and waiting, at a LOWER lamport than v6's.
  queueOutbox(db, 'prescription', 'rx1', 'delete', 30);

  applyMigrations(db, LATEST_VERSION, 5);

  assert.deepEqual(
    outboxRows(db).map((row) => [row['table_name'], row['row_id'], row['op'], row['lamport']]),
    [
      // Untouched: it is hers, it keeps its own lamport, and it retracts the row whole.
      ['prescription', 'rx1', 'delete', 30],
      // `record_edit` has no soft delete and nothing tombstones it, so its path still has
      // to be taken back the ordinary way.
      ['record_edit', 'ed1', 'upsert', 41],
    ],
  );
  db.close();
});

test('an audit row is matched by the SHAPE of the field name, not by a list of five columns', () => {
  // `field` holds a column name as DATA, which is the one place in this migration where the
  // same rule `isLocalPathColumn()` applies in TypeScript can be written in SQL. So a
  // `*_uri` column added in a FUTURE migration has its corrections retracted by this one
  // too, without anybody coming back to edit it.
  const db = openAtV5();
  configureProject(db, 10);
  const edit = (id: string, field: string) =>
    db
      .prepare(
        `INSERT INTO record_edit(id, record_kind, record_id, field, old_value, new_value, at_epoch)
         VALUES (?, 'symptom_event', 's1', ?, 'a', 'b', 1);`,
      )
      .run(id, field);

  edit('e_photo', 'photo_uri');
  edit('e_future', 'scan_uri'); // does not exist in any table yet
  edit('e_bare', 'uri');
  edit('e_note', 'note');
  edit('e_trap', 'urine'); // ends in 'rine', not '_uri' — a substr(-4) mistake would catch it
  edit('e_label', 'uri_label');

  applyMigrations(db, LATEST_VERSION, 5);

  assert.deepEqual(
    outboxRows(db).map((row) => row['row_id']).sort(),
    ['e_bare', 'e_future', 'e_photo'],
  );
  db.close();
});

test('replaying v6 mints nothing new — the ids are derived, not random', () => {
  const db = openAtV5();
  configureProject(db, 40);
  addPhotographedRecords(db);
  applyMigrations(db, LATEST_VERSION, 5);
  const first = outboxRows(db);
  assert.equal(first.find((row) => row['row_id'] === 'rx1')?.['id'], 'v6-restrip-prescription-rx1');

  // The runner cannot do this — `user_version` gates it — but a hand-run recovery can, and a
  // migration that duplicates on replay is one that cannot be re-run to fix a bad boot.
  db.exec('BEGIN EXCLUSIVE;');
  for (const statement of MIGRATIONS[5]?.statements ?? []) db.exec(statement);
  db.exec('COMMIT;');

  const second = outboxRows(db);
  assert.equal(second.length, first.length, 'the replay duplicated a retraction');
  assert.deepEqual(second.map((row) => row['id']), first.map((row) => row['id']));
  // The lamport was spent again, which is a gap and costs nothing. A DUPLICATE would have
  // cost the ordering; that is the trade v5 wrote down and this replays it.
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'lamport';`)?.['value'], '42');
  db.close();
});

test('a configured project with no lamport row yet still gets a usable number', () => {
  // `bumpLamport` writes that row lazily, so a phone with a project configured that has
  // never written a syncable row does not have one. COALESCE(...,0)+1 is why these get 1
  // rather than NULL — a NULL lamport sorts unpredictably in the drain's ORDER BY and is
  // NOT NULL in the schema besides.
  const db = openAtV5();
  configureProject(db);
  addPhotographedRecords(db);

  applyMigrations(db, LATEST_VERSION, 5);

  assert.equal(outboxRows(db).every((row) => row['lamport'] === 1), true);
  assert.equal(all(db, `SELECT * FROM app_meta WHERE key = 'lamport';`).length, 0, 'the UPDATE must not invent the row');
  db.close();
});

test('a v3 phone jumping straight to v6 does not hand v5 and v6 the same lamport', () => {
  // Both migrations borrow one number and hand it back, and on an upgrading phone they run
  // back to back inside the same boot. If v6 read the counter before v5's hand-back, both
  // sets of retractions would share a number, and the counter's one job is to be a total
  // order. `lamport` is deliberately not indexed and not counted, so nothing else would fail.
  const db = legacyInstall();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('sync.supabaseUrl', 'https://x.supabase.co');`).run();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('lamport', '40');`).run();
  db.prepare(
    `INSERT INTO document(id, profile_id, kind, title, file_uri, created_at_epoch, updated_at_epoch)
     VALUES ('d1', 'p1', 'discharge_summary', 'TB DOTS card', 'file:///b/a.pdf', 1, 1);`,
  ).run();
  db.prepare(
    `INSERT INTO symptom_event(id, profile_id, custom_label, photo_uri, at_epoch, local_date,
                               local_time, tz_offset_minutes, created_at_epoch, updated_at_epoch)
     VALUES ('s9', 'p1', 'rash', 'file:///x/s9.jpg', 1, '2026-07-01', '09:00', 330, 1, 1);`,
  ).run();

  applyMigrations(db, LATEST_VERSION, 3);

  const byId = new Map(outboxRows(db).map((row) => [row['row_id'] as string, row['lamport']]));
  assert.equal(byId.get('d1'), 41, "v5's tombstone");
  assert.equal(byId.get('s9'), 42, "v6's retraction must not reuse it");
  assert.equal(one(db, `SELECT value FROM app_meta WHERE key = 'lamport';`)?.['value'], '42');
  assert.equal((one(db, 'PRAGMA integrity_check;') as { integrity_check: string }).integrity_check, 'ok');
  db.close();
});

test('the strip and the migration still agree that a path does not travel', () => {
  // The two halves of one promise, in two features that can drift: the STRIP that stops the
  // tap (`features/sync/redact.ts`, wired into both sealing sites in outbox.ts) and the
  // MIGRATION that empties the bucket (here). Removing the strip would make the record
  // stream carry paths again and nothing else in the tree would notice, because this
  // migration has already run and cannot run twice.
  //
  // Asserted against the source text for the reason the briefcase test above gives:
  // `outbox.ts` reaches expo-sqlite and `node --test` cannot import it.
  const outbox = readFileSync(
    join(import.meta.dirname, '..', 'features', 'sync', 'outbox.ts'),
    'utf8',
  );
  // `row: stripLocalPaths(` rather than a bare `stripLocalPaths(`, which also matches the
  // prose in the file header. This pins the property that matters: the row handed to the
  // seal is the stripped one, at both sites.
  const sealingSites = outbox.match(/row: stripLocalPaths\(/g) ?? [];
  assert.equal(
    sealingSites.length,
    2,
    'there are exactly two places a row becomes a sealed payload, and both must strip',
  );

  const v6 = MIGRATIONS[5];
  assert.equal(v6?.name, 'v6_local_paths_do_not_travel');
  for (const table of ['prescription', 'medicine', 'symptom_event', 'lab_result', 'record_edit']) {
    assert.ok(
      v6?.statements.some((statement) => statement.includes(`'v6-restrip-${table}-'`)),
      `v6 must still retract ${table}`,
    );
  }
});
