#!/usr/bin/env node --experimental-strip-types
/**
 * Build a realistic development database, then prove the dashboard queries
 * still use their indexes against it.
 *
 *   node scripts/seed-dev-data.ts [out.db] [--months=24] [--seed=1]
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every screen in this app looks fine against the eleven rows you create by
 * hand while building it. The user this app is for will have two years of
 * history within two years, and the two failures that produces — a chart that
 * takes four seconds to draw on a Redmi, and a query that quietly degraded to a
 * full table scan when a WHERE clause changed — are both invisible until then.
 * So: generate the volume, and assert the plans.
 *
 * The data is deterministic (seeded PRNG), so a profiling run is comparable to
 * the last one, and re-running it does not move the numbers underneath you.
 *
 * IT IS NOT A FIXTURE FOR CORRECTNESS TESTS. It writes rows with raw SQL and
 * therefore bypasses the repository layer, which means no `sync_outbox` rows
 * and no `record_edit` audit trail. It is for volume, timing and query plans.
 *
 * WHAT IS DELIBERATELY REALISTIC
 * ──────────────────────────────
 *  • Adherence is not 100%, and the gaps are not uniform noise. There is a
 *    four-day stretch with nothing recorded (a trip), a run of evening doses
 *    confirmed the following morning, and a slow drift as the novelty of a new
 *    app wears off. A generator that produces 97% taken every day would hide
 *    the `no_record` path, which is the one the honest-adherence code exists
 *    for.
 *  • Two prescription changes land mid-history as NEW VERSIONS on the same
 *    thread_id — a dose increase and a timing change — because "what was she
 *    taking in March?" is the question the OPD report answers, and it is only
 *    answerable if the version chain is exercised.
 *  • Readings cluster: several in a week after a doctor's visit, then a fortnight
 *    of nothing. Evenly spaced readings make every chart look better than it is.
 *
 * NO TARGET RANGES ARE WRITTEN. Not here either. If you want to see a target
 * band on a chart, enter one in Settings → Targets like a human would.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Types come from an extension-less `import type`, which the compiler resolves
 * and Node erases entirely. The VALUES come from a dynamic import built at
 * runtime.
 *
 * Both halves of that are forced. Node's type-stripping loader does no
 * extension resolution, so it needs the literal `.ts`; `tsc` rejects a `.ts`
 * import specifier (TS5097) unless `allowImportingTsExtensions` is set, and
 * this file is inside the project's `tsconfig.json` include. A URL computed at
 * runtime satisfies Node and is opaque to the compiler, so `npm run typecheck`
 * stays clean without the tsconfig having to be bent around one script.
 */
import type { SeedDatabase } from '../src/db/seed';

type MigrationsModule = typeof import('../src/db/migrations');
type SeedModule = typeof import('../src/db/seed');
type SlotRegistryModule = typeof import('../src/features/slots/registry');

const { MIGRATIONS } = (await import(
  new URL('../src/db/migrations.ts', import.meta.url).href
)) as MigrationsModule;
const { seedReferenceData } = (await import(
  new URL('../src/db/seed.ts', import.meta.url).href
)) as SeedModule;
// The slot registry, so seeded `slot_key` values are the ones the app itself would write
// rather than a rule retyped in a script. Its pure half loads cleanly here: the database
// lives behind `await import` inside its function bodies, and nothing below calls those.
const { DEFAULT_SLOT_TIMES, buildSlotDefinitions, slotForTime } = (await import(
  new URL('../src/features/slots/registry.ts', import.meta.url).href
)) as SlotRegistryModule;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const positional = args.filter((a) => !a.startsWith('--'));

const OUT_FILE = path.resolve(ROOT, positional[0] ?? 'aarogya.dev.db');
const MONTHS = flag('months', 24);
const PRNG_SEED = flag('seed', 1);

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, and identical on every machine. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(PRNG_SEED);
const chance = (p: number) => random() < p;
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const intBetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

let idCounter = 0;
/** Deterministic UUID-shaped id. Must never contain ':' — occurrence ids split on it. */
const nextId = (prefix: string) => `${prefix}-${(idCounter += 1).toString(36).padStart(8, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────
// Time — fixed IST, matching how the app stores wall clock
// ─────────────────────────────────────────────────────────────────────────────

const TZ_OFFSET_MINUTES = 330; // Asia/Kolkata, +05:30. No DST, ever.

/** 'YYYY-MM-DD' for a day offset from a UTC-midnight anchor. */
function localDate(dayIndex: number, anchor: Date): string {
  const d = new Date(anchor.getTime() + dayIndex * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Epoch ms for a local date + 'HH:MM' wall clock in IST. */
function epochFor(dateStr: string, timeLocal: string): number {
  const [h = 0, m = 0] = timeLocal.split(':').map(Number);
  return Date.parse(`${dateStr}T00:00:00Z`) + (h * 60 + m - TZ_OFFSET_MINUTES) * 60_000;
}

function timeString(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Monday = bit 0, matching `dose_schedule.days_mask`. */
function weekdayBit(dateStr: string): number {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (day + 6) % 7;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────

if (fs.existsSync(OUT_FILE)) fs.rmSync(OUT_FILE);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(OUT_FILE + suffix)) fs.rmSync(OUT_FILE + suffix);
}

const db = new DatabaseSync(OUT_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

type Bind = string | number | null;

function run(sql: string, params: Bind[] = []): void {
  db.prepare(sql).run(...params);
}

/** Adapter so `seedReferenceData` can drive a synchronous node:sqlite handle. */
const seedAdapter: SeedDatabase = {
  runAsync(sql: string, params: (string | number | null)[]) {
    run(sql, params);
    return Promise.resolve(undefined);
  },
};

const started = Date.now();

// ── migrations ───────────────────────────────────────────────────────────────
for (const migration of MIGRATIONS) {
  db.exec('BEGIN EXCLUSIVE;');
  try {
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${migration.version};`);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
  }
}

// ── reference data ───────────────────────────────────────────────────────────
const counts = await seedReferenceData(seedAdapter);

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic history
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = new Date();
const ANCHOR = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()));
const TOTAL_DAYS = Math.round(MONTHS * 30.44);
const START_DAY = -TOTAL_DAYS;

const now = Date.now();
const PROFILE_ID = 'profile-dev-0001';

db.exec('BEGIN;');

run(
  `INSERT INTO profile (id, display_name, year_of_birth, sex, blood_group, is_default,
                        created_at_epoch, updated_at_epoch, lamport)
   VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0);`,
  [PROFILE_ID, 'Dev Patient', 1954, 'female', 'B+', now, now],
);

const ENABLED_PACKS = ['general', 'hypertension', 'diabetes', 'cardiac', 'thyroid'];
for (const pack of ENABLED_PACKS) {
  run(
    `INSERT INTO profile_condition (profile_id, pack_key, started_on, created_at_epoch)
     VALUES (?, ?, ?, ?);`,
    [PROFILE_ID, pack, localDate(START_DAY, ANCHOR), now],
  );
}

// The tracked metric set, materialised — the app owns it, packs only suggest it.
const trackedMetrics = ['bp', 'blood_glucose', 'weight', 'hba1c', 'spo2', 'temperature'];
trackedMetrics.forEach((metricKey, index) => {
  run(
    `INSERT INTO profile_metric (profile_id, metric_key, enabled, sort_order, created_at_epoch)
     VALUES (?, ?, 1, ?, ?);`,
    [PROFILE_ID, metricKey, index, now],
  );
});

// ── Prescriptions ────────────────────────────────────────────────────────────

type PrescriptionRow = { id: string; day: number };
const prescriptions: PrescriptionRow[] = [
  { id: nextId('rx'), day: START_DAY },
  { id: nextId('rx'), day: Math.round(START_DAY * 0.62) },
  { id: nextId('rx'), day: Math.round(START_DAY * 0.28) },
];
for (const rx of prescriptions) {
  const date = localDate(rx.day, ANCHOR);
  const epoch = epochFor(date, '11:00');
  run(
    `INSERT INTO prescription (id, profile_id, prescriber, clinic, prescribed_on, status,
                               confirmed_at_epoch, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, 0);`,
    [rx.id, PROFILE_ID, 'Dr A. Sharma', 'City Clinic', date, epoch, epoch, epoch],
  );
  run(
    `INSERT INTO med_change_event (id, profile_id, thread_id, kind, local_date, at_epoch,
                                   detail, prescription_id)
     VALUES (?, ?, NULL, 'prescription', ?, ?, ?, ?);`,
    [nextId('mce'), PROFILE_ID, date, epoch, 'New prescription recorded', rx.id],
  );
  run(
    `INSERT INTO visit_log (id, profile_id, visited_on, doctor, clinic, notes,
                            prescription_id, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0);`,
    [nextId('visit'), PROFILE_ID, date, 'Dr A. Sharma', 'City Clinic', null, rx.id, epoch, epoch],
  );
}

// ── Medicines and their version chains ───────────────────────────────────────

type MedicineVersion = {
  id: string;
  threadId: string;
  version: number;
  name: string;
  strength: string;
  criticality: 'critical' | 'standard' | 'low';
  startDay: number;
  endDay: number | null;
  /** Wall-clock times for this version. */
  times: string[];
  prescriptionId: string;
};

const t0 = START_DAY;
const tChange1 = Math.round(START_DAY * 0.62); // dose increase
const tChange2 = Math.round(START_DAY * 0.28); // timing change

const threadAmlodipine = nextId('thread');
const threadMetformin = nextId('thread');
const threadThyroxine = nextId('thread');
const threadAtorva = nextId('thread');
const threadCourse = nextId('thread');

const medicineVersions: MedicineVersion[] = [
  // Amlodipine — dose increased at month ~9. Same thread, new version.
  {
    id: nextId('med'),
    threadId: threadAmlodipine,
    version: 1,
    name: 'Amlodipine',
    strength: '5 mg',
    criticality: 'standard',
    startDay: t0,
    endDay: tChange1 - 1,
    times: ['08:00'],
    prescriptionId: prescriptions[0]!.id,
  },
  {
    id: nextId('med'),
    threadId: threadAmlodipine,
    version: 2,
    name: 'Amlodipine',
    strength: '10 mg',
    criticality: 'standard',
    startDay: tChange1,
    endDay: null,
    times: ['08:00'],
    prescriptionId: prescriptions[1]!.id,
  },
  // Metformin — evening dose moved 20:00 → 21:00 at month ~17.
  {
    id: nextId('med'),
    threadId: threadMetformin,
    version: 1,
    name: 'Metformin',
    strength: '500 mg',
    criticality: 'standard',
    startDay: t0,
    endDay: tChange2 - 1,
    times: ['08:00', '20:00'],
    prescriptionId: prescriptions[0]!.id,
  },
  {
    id: nextId('med'),
    threadId: threadMetformin,
    version: 2,
    name: 'Metformin',
    strength: '500 mg',
    criticality: 'standard',
    startDay: tChange2,
    endDay: null,
    times: ['08:00', '21:00'],
    prescriptionId: prescriptions[2]!.id,
  },
  // Thyroxine — the one that must not be forgotten, and must be taken fasting.
  {
    id: nextId('med'),
    threadId: threadThyroxine,
    version: 1,
    name: 'Thyroxine',
    strength: '50 mcg',
    criticality: 'critical',
    startDay: t0,
    endDay: null,
    times: ['07:00'],
    prescriptionId: prescriptions[0]!.id,
  },
  // Atorvastatin — low tier, so it never borrows the alarm channel.
  {
    id: nextId('med'),
    threadId: threadAtorva,
    version: 1,
    name: 'Atorvastatin',
    strength: '10 mg',
    criticality: 'low',
    startDay: t0,
    endDay: null,
    times: ['21:30'],
    prescriptionId: prescriptions[0]!.id,
  },
  // A finite course that STOPPED — exercises the stopped-medicine paths.
  {
    id: nextId('med'),
    threadId: threadCourse,
    version: 1,
    name: 'Cefixime',
    strength: '200 mg',
    criticality: 'standard',
    startDay: tChange1 + 3,
    endDay: tChange1 + 10,
    times: ['09:00', '21:00'],
    prescriptionId: prescriptions[1]!.id,
  },
];

type ScheduleRow = { id: string; medicine: MedicineVersion; time: string };
const schedules: ScheduleRow[] = [];

/**
 * `slot_key` exactly as the app would write it: the built-in slot whose DEFAULT time is
 * this one, and null when no slot names it.
 *
 * NULL IS THE POINT OF DOING IT THIS WAY. Four of the times below (07:00, 09:00, 21:00,
 * 21:30) fall between named slots, so a seeded database exercises the unnamed-slot render
 * path that a hand-made eleven-row database never does. The previous rule here bucketed
 * every time into morning/afternoon/night, which produced a database in which every row
 * had a name — and, since those three keys are now retired, one no current build writes.
 */
const SLOT_DEFS = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);
const slotKeyFor = (time: string): string | null => slotForTime(SLOT_DEFS, time)?.key ?? null;

/**
 * The RETIRED four-slot vocabulary, kept for superseded versions only.
 *
 * `dose_schedule` is append-only, so a phone upgraded from the four-slot build carries
 * rows written by it forever, and `slotDefForKey` exists to keep those rows readable. That
 * path has to be reachable on a dev handset or it is a bug report nobody can reproduce —
 * so the versions that were superseded mid-history get the keys the old build would have
 * written, and current versions get the new ones. That is also exactly the shape a real
 * upgraded install has.
 */
const legacySlotKeyFor = (time: string): string =>
  time < '12:00' ? 'morning' : time < '17:00' ? 'afternoon' : 'night';

for (const medicine of medicineVersions) {
  const startDate = localDate(medicine.startDay, ANCHOR);
  const stopDate = medicine.endDay === null ? null : localDate(medicine.endDay, ANCHOR);
  const createdAt = epochFor(startDate, '11:00');
  const status = medicine.endDay === null ? 'active' : medicine.version === 1 && medicine.threadId === threadCourse ? 'stopped' : 'superseded';

  run(
    `INSERT INTO medicine
       (id, thread_id, version, profile_id, name_as_written, generic_guess, strength, form,
        criticality, status, stop_reason, started_on, stopped_on, source, prescription_id,
        confirmed_by_user_at, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'tablet', ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 0);`,
    [
      medicine.id,
      medicine.threadId,
      medicine.version,
      PROFILE_ID,
      medicine.name,
      medicine.name.toLowerCase(),
      medicine.strength,
      medicine.criticality,
      status,
      status === 'stopped' ? 'course finished' : null,
      startDate,
      stopDate,
      medicine.prescriptionId,
      createdAt,
      createdAt,
      createdAt,
    ],
  );

  run(
    `INSERT INTO med_change_event (id, profile_id, thread_id, kind, local_date, at_epoch, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      nextId('mce'),
      PROFILE_ID,
      medicine.threadId,
      medicine.version === 1 ? 'started' : 'dose_changed',
      startDate,
      createdAt,
      `${medicine.name} ${medicine.strength}`,
    ],
  );

  for (const time of medicine.times) {
    const scheduleId = nextId('sched');
    run(
      `INSERT INTO dose_schedule
         (id, medicine_id, thread_id, version, schedule_type, time_local, slot_key, days_mask,
          interval_days, quantity_value, quantity_unit, quantity_text, food_relation,
          started_on, stopped_on, confirmed_by_user_at, created_at_epoch, updated_at_epoch, lamport)
       VALUES (?, ?, ?, ?, 'FIXED', ?, ?, 127, 1, 1, 'tablet', '1 tablet', ?, ?, ?, ?, ?, ?, 0);`,
      [
        scheduleId,
        medicine.id,
        medicine.threadId,
        medicine.version,
        time,
        status === 'superseded' ? legacySlotKeyFor(time) : slotKeyFor(time),
        medicine.name === 'Thyroxine' ? 'empty' : 'after',
        startDate,
        stopDate,
        createdAt,
        createdAt,
        createdAt,
      ],
    );
    schedules.push({ id: scheduleId, medicine, time });
  }

  // Stock, so the refill projection has something to work on.
  run(
    `INSERT INTO medicine_stock (id, thread_id, profile_id, quantity_on_hand, counted_on,
                                 unit_cost, refill_lead_days, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, ?, 5, ?, ?, 0);`,
    [nextId('stock'), medicine.threadId, PROFILE_ID, intBetween(8, 60), startDate, between(1, 12), createdAt, createdAt],
  );
}

// ── Occurrences and the append-only event log ────────────────────────────────

const CHANNEL_BY_TIER: Record<string, string> = {
  critical: 'dose_critical_v1',
  standard: 'dose_standard_v1',
  low: 'dose_low_v1',
};

/** A four-day trip with nothing recorded, roughly two-thirds of the way back. */
const TRIP_START = Math.round(START_DAY * 0.45);
const TRIP_END = TRIP_START + 4;

/** Confirmed-next-morning run — evening doses tapped late. */
const LATE_RUN_START = Math.round(START_DAY * 0.2);
const LATE_RUN_END = LATE_RUN_START + 12;

let occurrenceCount = 0;
let eventCount = 0;

for (let day = START_DAY; day <= 0; day += 1) {
  const date = localDate(day, ANCHOR);
  const bit = weekdayBit(date);

  for (const schedule of schedules) {
    const { medicine, time } = schedule;
    if (day < medicine.startDay) continue;
    if (medicine.endDay !== null && day > medicine.endDay) continue;
    void bit; // days_mask is 127 for every schedule here; kept for shape parity.

    const scheduledAt = epochFor(date, time);
    if (scheduledAt > now) continue;

    const occurrenceId = `${medicine.threadId}:${date}:${time}`;
    const channelId = CHANNEL_BY_TIER[medicine.criticality] ?? 'dose_standard_v1';

    /**
     * Adherence, shaped rather than uniform:
     *  • the trip window records nothing at all
     *  • a critical medicine is confirmed more reliably than a low-tier one
     *  • confirmation decays slowly over the first months, as novelty does
     */
    const monthsAgo = -day / 30.44;
    const noveltyBonus = Math.max(0, 0.09 - monthsAgo * 0.005);
    const tierBase = medicine.criticality === 'critical' ? 0.93 : medicine.criticality === 'low' ? 0.72 : 0.86;
    const takenProbability = Math.min(0.97, tierBase + noveltyBonus);

    let status: 'taken' | 'skipped' | 'no_record' = 'taken';
    if (day >= TRIP_START && day < TRIP_END) status = 'no_record';
    else if (chance(takenProbability)) status = 'taken';
    else if (chance(0.35)) status = 'skipped';
    else status = 'no_record';

    run(
      `INSERT INTO dose_occurrence
         (id, profile_id, medicine_id, thread_id, dose_schedule_id, local_date, time_local,
          scheduled_at_epoch, status, channel_id, created_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        occurrenceId,
        PROFILE_ID,
        medicine.id,
        medicine.threadId,
        schedule.id,
        date,
        time,
        scheduledAt,
        status,
        channelId,
        scheduledAt,
        scheduledAt,
      ],
    );
    occurrenceCount += 1;

    // The alarm fired regardless of what she did about it.
    if (status !== 'no_record' || chance(0.8)) {
      run(
        `INSERT INTO dose_event (id, occurrence_id, thread_id, medicine_id, profile_id, event,
                                 at_epoch, local_date, payload_json, origin, created_at_epoch, lamport)
         VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, NULL, 'native', ?, 0);`,
        [
          nextId('ev'),
          occurrenceId,
          medicine.threadId,
          medicine.id,
          PROFILE_ID,
          scheduledAt + intBetween(0, 40) * 1000,
          date,
          scheduledAt,
        ],
      );
      eventCount += 1;
    }

    if (status === 'no_record') continue;

    const lateRun = day >= LATE_RUN_START && day < LATE_RUN_END && time >= '20:00';
    const delayMinutes = lateRun ? intBetween(600, 780) : intBetween(1, 95);
    const actedAt = scheduledAt + delayMinutes * 60_000;
    const actedDate = localDate(
      day + (delayMinutes + Number(time.slice(0, 2)) * 60 >= 24 * 60 ? 1 : 0),
      ANCHOR,
    );

    run(
      `INSERT INTO dose_event (id, occurrence_id, thread_id, medicine_id, profile_id, event,
                               at_epoch, local_date, payload_json, origin, created_at_epoch, lamport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0);`,
      [
        nextId('ev'),
        occurrenceId,
        medicine.threadId,
        medicine.id,
        PROFILE_ID,
        status,
        actedAt,
        actedDate,
        chance(0.6) ? 'notification' : 'app',
        actedAt,
      ],
    );
    eventCount += 1;

    // Delivery telemetry — instrumenting the ABSENCE of delivery is the point.
    if (chance(0.08)) {
      run(
        `INSERT INTO delivery_probe (id, occurrence_id, expected_epoch, delivered_epoch,
                                     checked_epoch, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [nextId('probe'), occurrenceId, scheduledAt, chance(0.9) ? scheduledAt + 4000 : null, scheduledAt + 900_000, scheduledAt],
      );
    }
  }
}

// ── Readings ─────────────────────────────────────────────────────────────────

const GLUCOSE_CONTEXTS = ['fasting', 'before_meal', 'after_meal', 'bedtime', 'random'];

let readingCount = 0;

function insertReading(
  metricKey: string,
  day: number,
  hour: number,
  minute: number,
  values: [number | null, number | null, number | null],
  context: Record<string, string> | null,
): void {
  const date = localDate(day, ANCHOR);
  const time = timeString(hour, minute);
  const epoch = epochFor(date, time);
  if (epoch > now) return;
  run(
    `INSERT INTO reading
       (id, profile_id, metric_key, v1, v2, v3, value_qualifier, context_json, note,
        at_epoch, local_date, local_time, tz_offset_minutes, was_backfilled, source,
        edited_count, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, ?, 'exact', ?, NULL, ?, ?, ?, ?, ?, 'manual', 0, ?, ?, 0);`,
    [
      nextId('rd'),
      PROFILE_ID,
      metricKey,
      values[0],
      values[1],
      values[2],
      context ? JSON.stringify(context) : null,
      epoch,
      date,
      time,
      TZ_OFFSET_MINUTES,
      chance(0.06) ? 1 : 0,
      epoch,
      epoch,
    ],
  );
  readingCount += 1;
}

/**
 * Readings cluster around a visit and thin out between them, which is what
 * actually happens and what makes a 24-month chart hard to draw well.
 */
function recordingIntensity(day: number): number {
  let nearest = Infinity;
  for (const rx of prescriptions) nearest = Math.min(nearest, Math.abs(day - rx.day));
  if (nearest <= 10) return 0.85;
  if (nearest <= 30) return 0.5;
  return 0.3;
}

// Slow, plausible drifts. These are trajectories, not judgements — no line in
// this generator asserts that any value is good, bad, high or low.
let systolicBase = 148;
let weightBase = 71.5;
let hba1cBase = 8.1;

for (let day = START_DAY; day <= 0; day += 1) {
  const intensity = recordingIntensity(day);
  const inTrip = day >= TRIP_START && day < TRIP_END;

  systolicBase += between(-0.05, 0.03);
  weightBase += between(-0.02, 0.015);

  if (inTrip) continue;

  if (chance(intensity)) {
    const systolic = Math.round(systolicBase + between(-12, 12));
    const diastolic = Math.round(systolic * between(0.58, 0.66));
    const pulse = Math.round(between(58, 96));
    insertReading('bp', day, intBetween(6, 9), intBetween(0, 59), [systolic, diastolic, pulse], null);
    // A second, evening reading on some days — a real habit, and it doubles the
    // row count for the day-grouping queries.
    if (chance(0.25)) {
      insertReading(
        'bp',
        day,
        intBetween(19, 22),
        intBetween(0, 59),
        [Math.round(systolicBase + between(-10, 14)), Math.round(systolicBase * 0.62), Math.round(between(60, 92))],
        null,
      );
    }
  }

  if (chance(intensity * 0.7)) {
    const context = pick(GLUCOSE_CONTEXTS);
    const base = context === 'fasting' ? 132 : context === 'after_meal' ? 196 : 158;
    insertReading(
      'blood_glucose',
      day,
      context === 'fasting' ? intBetween(6, 8) : intBetween(10, 22),
      intBetween(0, 59),
      [Math.round(base + between(-38, 52)), null, null],
      { meal: context },
    );
  }

  if (weekdayBit(localDate(day, ANCHOR)) === 6 && chance(0.8)) {
    insertReading('weight', day, 7, intBetween(0, 30), [Number(weightBase.toFixed(1)), null, null], null);
  }

  if (chance(0.05)) {
    insertReading('spo2', day, intBetween(8, 21), intBetween(0, 59), [intBetween(93, 99), null, null], null);
  }
  if (chance(0.03)) {
    insertReading(
      'temperature',
      day,
      intBetween(8, 21),
      intBetween(0, 59),
      [Number(between(97.2, 101.4).toFixed(1)), null, null],
      null,
    );
  }
}

// Quarterly HbA1c, both as a charted metric and as a transcribed lab row.
for (let day = START_DAY; day <= 0; day += 91) {
  hba1cBase += between(-0.25, 0.12);
  const value = Number(Math.max(5, hba1cBase).toFixed(1));
  insertReading('hba1c', day, 9, 30, [value, null, null], null);
}

// ── Symptoms ─────────────────────────────────────────────────────────────────

const SYMPTOM_KEYS = [
  'very_tired',
  'dizzy',
  'headache',
  'breathless',
  'swollen_feet',
  'shaky_sweaty',
  'joint_pain',
  'sleep_trouble',
  'numb_feet',
  'blurred_vision',
];
const SEVERITIES = ['mild', 'moderate', 'severe'];

let symptomCount = 0;
for (let day = START_DAY; day <= 0; day += 1) {
  if (!chance(0.28)) continue;
  const date = localDate(day, ANCHOR);
  const time = timeString(intBetween(6, 22), intBetween(0, 59));
  const epoch = epochFor(date, time);
  if (epoch > now) continue;
  run(
    `INSERT INTO symptom_event
       (id, profile_id, symptom_key, custom_label, severity, note, photo_uri, at_epoch,
        local_date, local_time, tz_offset_minutes, linked_reading_id, linked_thread_id,
        edited_count, created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, 0);`,
    [
      nextId('sym'),
      PROFILE_ID,
      pick(SYMPTOM_KEYS),
      pick(SEVERITIES),
      epoch,
      date,
      time,
      TZ_OFFSET_MINUTES,
      epoch,
      epoch,
    ],
  );
  symptomCount += 1;
}

// ── Labs and care calendar ───────────────────────────────────────────────────

let labCount = 0;
const LAB_PLAN: { key: string; everyDays: number; unit: string | null; lo: number; hi: number }[] = [
  { key: 'hba1c', everyDays: 91, unit: '%', lo: 6.4, hi: 9.4 },
  { key: 'creatinine', everyDays: 182, unit: 'mg/dL', lo: 0.6, hi: 1.4 },
  { key: 'lipid_profile', everyDays: 365, unit: null, lo: 130, hi: 240 },
  { key: 'tsh', everyDays: 182, unit: 'µIU/mL', lo: 0.4, hi: 7.5 },
  { key: 'haemoglobin', everyDays: 182, unit: 'g/dL', lo: 10.2, hi: 13.8 },
];

for (const plan of LAB_PLAN) {
  for (let day = START_DAY; day <= 0; day += plan.everyDays) {
    const date = localDate(day, ANCHOR);
    const epoch = epochFor(date, '10:00');
    if (epoch > now) continue;
    const value = Number(between(plan.lo, plan.hi).toFixed(2));
    run(
      `INSERT INTO lab_result
         (id, profile_id, test_key, custom_label, value_text, value_num, unit, ref_range_text,
          collected_on, lab_name, report_uri, source, confirmed_at,
          created_at_epoch, updated_at_epoch, lamport)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'manual', ?, ?, ?, 0);`,
      [
        nextId('lab'),
        PROFILE_ID,
        plan.key,
        String(value),
        value,
        plan.unit,
        // Transcribed from the paper, verbatim — never supplied by the app.
        chance(0.7) ? 'as printed on the report' : null,
        date,
        'City Diagnostics',
        epoch,
        epoch,
        epoch,
      ],
    );
    labCount += 1;
  }
}

let careCount = 0;
for (const rx of prescriptions) {
  const dueDay = rx.day + 30;
  const dueOn = localDate(dueDay, ANCHOR);
  const epoch = epochFor(localDate(rx.day, ANCHOR), '11:05');
  run(
    `INSERT INTO care_event
       (id, profile_id, kind, title, due_on, anchor_event_id, anchor_source, offset_days,
        prescription_id, related_test_key, related_thread_id, status, confirmed_at_epoch,
        created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, 'visit', ?, ?, NULL, 'transcribed', 30, ?, NULL, NULL, ?, ?, ?, ?, 0);`,
    [
      nextId('care'),
      PROFILE_ID,
      'Follow-up visit',
      dueOn,
      rx.id,
      dueDay <= 0 ? 'done' : 'pending',
      dueDay <= 0 ? epoch : null,
      epoch,
      epoch,
    ],
  );
  careCount += 1;
}
// A handful of still-pending items, so the "what is coming up" query has rows.
for (let i = 1; i <= 6; i += 1) {
  const dueOn = localDate(i * 9, ANCHOR);
  run(
    `INSERT INTO care_event
       (id, profile_id, kind, title, due_on, anchor_event_id, anchor_source, offset_days,
        prescription_id, related_test_key, related_thread_id, status, confirmed_at_epoch,
        created_at_epoch, updated_at_epoch, lamport)
     VALUES (?, ?, ?, ?, ?, NULL, 'inferred', 0, NULL, ?, NULL, 'pending', NULL, ?, ?, 0);`,
    [
      nextId('care'),
      PROFILE_ID,
      pick(['test_book', 'test_do', 'refill', 'custom']),
      'Upcoming item',
      dueOn,
      pick(['hba1c', 'creatinine', null]),
      now,
      now,
    ],
  );
  careCount += 1;
}

run(
  `INSERT INTO streak_state (profile_id, current_streak, best_streak, last_counted_date, updated_at_epoch)
   VALUES (?, ?, ?, ?, ?);`,
  [PROFILE_ID, intBetween(2, 19), intBetween(20, 64), localDate(0, ANCHOR), now],
);

db.exec('COMMIT;');
db.exec('ANALYZE;');

const generatedMs = Date.now() - started;

// ─────────────────────────────────────────────────────────────────────────────
// EXPLAIN QUERY PLAN — every dashboard query must be an index seek
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the half of the script that has teeth. Generating volume only tells
// you a screen feels slow; the plan tells you WHY, and it catches the far more
// common regression — a WHERE clause gains one extra condition, the partial
// index stops matching, and a 12,000-row table starts being read end to end on
// every render. That is invisible on a developer's eleven rows and obvious on
// a two-year-old install.
//
// The assertion is: no step may be a bare table SCAN. SQLite reports either
// "SEARCH … USING INDEX/COVERING INDEX/PRIMARY KEY" (a seek) or "SCAN table"
// (a full read). A SCAN of a small, deliberately unindexed table would need an
// explicit exemption below, with a reason.

const today = localDate(0, ANCHOR);
const monthAgo = localDate(-30, ANCHOR);

type PlanCheck = { name: string; sql: string; params: Bind[]; source: string };

const PLAN_CHECKS: PlanCheck[] = [
  {
    name: "today's doses",
    source: 'repositories/occurrences.ts — listOccurrencesForDate',
    sql: `SELECT id, medicine_id, time_local, status, channel_id
            FROM dose_occurrence
           WHERE profile_id = ? AND local_date = ?
           ORDER BY time_local;`,
    params: [PROFILE_ID, today],
  },
  {
    name: 'doses awaiting a decision',
    source: 'repositories/occurrences.ts — the watchdog sweep (partial index)',
    sql: `SELECT id FROM dose_occurrence
           WHERE status IN ('pending','snoozed') AND scheduled_at_epoch <= ?;`,
    params: [now],
  },
  {
    name: 'one metric over a date range (the chart)',
    source: 'repositories/readings.ts — listReadings(metricKey, from, to)',
    sql: `SELECT id, v1, v2, v3, local_date, local_time
            FROM reading
           WHERE profile_id = ? AND metric_key = ? AND local_date BETWEEN ? AND ?
             AND deleted_at_epoch IS NULL
           ORDER BY local_date DESC;`,
    params: [PROFILE_ID, 'bp', monthAgo, today],
  },
  {
    name: 'most recent readings (the home tiles)',
    source: 'repositories/readings.ts — listRecentReadings',
    sql: `SELECT id, metric_key, v1, at_epoch FROM reading
           WHERE profile_id = ? AND deleted_at_epoch IS NULL
           ORDER BY at_epoch DESC LIMIT 20;`,
    params: [PROFILE_ID],
  },
  {
    name: 'events for one occurrence (deriveStatus)',
    source: 'repositories/doseEvents.ts — listEventsForOccurrence',
    sql: `SELECT event, at_epoch, origin FROM dose_event
           WHERE occurrence_id = ? ORDER BY at_epoch;`,
    params: [`${threadThyroxine}:${today}:07:00`],
  },
  {
    name: 'events over a date range (adherence)',
    source: 'features/adherence/compute.ts',
    sql: `SELECT event, local_date FROM dose_event
           WHERE profile_id = ? AND local_date BETWEEN ? AND ?;`,
    params: [PROFILE_ID, monthAgo, today],
  },
  {
    name: 'symptoms over a date range',
    source: 'repositories/symptoms.ts — listSymptomEvents',
    sql: `SELECT id, symptom_key, severity, local_date FROM symptom_event
           WHERE profile_id = ? AND deleted_at_epoch IS NULL AND local_date BETWEEN ? AND ?
           ORDER BY local_date DESC;`,
    params: [PROFILE_ID, monthAgo, today],
  },
  {
    name: 'lab results, newest first',
    source: 'repositories/labs.ts — listLabResults',
    sql: `SELECT id, test_key, value_num, collected_on FROM lab_result
           WHERE profile_id = ? AND deleted_at_epoch IS NULL
           ORDER BY collected_on DESC LIMIT 50;`,
    params: [PROFILE_ID],
  },
  {
    name: 'what is coming up',
    source: 'repositories/care.ts — listPendingCareEvents (partial index)',
    sql: `SELECT id, kind, title, due_on FROM care_event
           WHERE profile_id = ? AND status = 'pending' AND deleted_at_epoch IS NULL
             AND due_on <= ?
           ORDER BY due_on;`,
    params: [PROFILE_ID, localDate(60, ANCHOR)],
  },
  {
    name: 'active medicines',
    source: 'repositories/medicines.ts — listActiveMedicines (partial index)',
    sql: `SELECT id, thread_id, name_as_written, criticality FROM medicine
           WHERE profile_id = ? AND status = 'active' AND deleted_at_epoch IS NULL;`,
    params: [PROFILE_ID],
  },
  {
    name: 'latest version of one medicine thread',
    source: 'repositories/medicines.ts — getLatestVersion',
    sql: `SELECT id, version FROM medicine
           WHERE thread_id = ? ORDER BY version DESC LIMIT 1;`,
    params: [threadAmlodipine],
  },
  {
    name: 'prescription-change markers on a chart',
    source: 'features/reports/charts — med change vertical markers',
    sql: `SELECT id, kind, local_date FROM med_change_event
           WHERE profile_id = ? AND local_date BETWEEN ? AND ?;`,
    params: [PROFILE_ID, monthAgo, today],
  },
];

type PlanRow = { detail: string };

const planFailures: string[] = [];
console.log('\nquery plans');
for (const check of PLAN_CHECKS) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${check.sql}`).all(...check.params) as unknown as PlanRow[];
  const scans = rows.filter((row) => /^SCAN\b/.test(row.detail) && !/USING\s+(COVERING\s+)?INDEX/.test(row.detail));
  const usedIndex = rows.find((row) => /USING\s+(COVERING\s+)?INDEX\s+(\S+)/.exec(row.detail));
  const indexName = usedIndex ? (/USING\s+(?:COVERING\s+)?INDEX\s+(\S+)/.exec(usedIndex.detail)?.[1] ?? '') : '';

  if (scans.length > 0) {
    planFailures.push(
      `  ✗ ${check.name}\n` +
        `      ${check.source}\n` +
        rows.map((row) => `      ${row.detail}`).join('\n'),
    );
    console.log(`  ✗ ${check.name.padEnd(42)} FULL SCAN`);
  } else {
    console.log(`  ✓ ${check.name.padEnd(42)} ${indexName || 'primary key'}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const bytes = fs.statSync(OUT_FILE).size;
const rowCount = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number }).n;

console.log('\ndev database');
console.log(`  file             ${path.relative(ROOT, OUT_FILE)}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  window           ${MONTHS} months  (${TOTAL_DAYS} days), prng seed ${PRNG_SEED}`);
console.log(`  generated in     ${generatedMs} ms`);
console.log('');
console.log(`  reference data   ${counts.packs} packs, ${counts.metrics} metrics, ` +
  `${counts.symptoms} symptoms, ${counts.labTests} lab tests`);
console.log(`  target ranges    ${rowCount('target_range')}   ← must be 0, always`);
console.log('');
console.log(`  medicines        ${rowCount('medicine')} versions across ${new Set(medicineVersions.map((m) => m.threadId)).size} threads`);
console.log(`  schedules        ${rowCount('dose_schedule')}`);
console.log(`  occurrences      ${occurrenceCount}`);
console.log(`  dose events      ${eventCount}`);
console.log(`  readings         ${readingCount}`);
console.log(`  symptoms         ${symptomCount}`);
console.log(`  lab results      ${labCount}`);
console.log(`  care events      ${careCount}`);

const taken = rowCount("dose_occurrence WHERE status = 'taken'");
const skipped = rowCount("dose_occurrence WHERE status = 'skipped'");
const noRecord = rowCount("dose_occurrence WHERE status = 'no_record'");
console.log(
  `\n  recorded taken ${taken}, recorded not taken ${skipped}, no record ${noRecord} ` +
    `(${((noRecord / Math.max(1, occurrenceCount)) * 100).toFixed(1)}% of doses have no record either way)`,
);

if (rowCount('target_range') !== 0) {
  console.error('\n✗ a target range was written. That is the one thing this file must never do.');
  process.exit(1);
}

if (planFailures.length > 0) {
  console.error(`\n✗ ${planFailures.length} dashboard quer${planFailures.length === 1 ? 'y' : 'ies'} fell back to a full table scan:\n`);
  for (const failure of planFailures) console.error(failure + '\n');
  console.error('Add or fix an index in src/db/migrations.ts (append a new migration — never edit one).');
  process.exit(1);
}

console.log('\n✓ every dashboard query is an index seek');
db.close();
