import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import { APPEND_ONLY_TRIGGERS, LATEST_VERSION, MIGRATIONS } from './migrations';

const DB_NAME = 'aarogya.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Opens the database and brings it to LATEST_VERSION.
 *
 * The runner is deliberately paranoid, because this file is the ONLY copy of the
 * user's health history — there is no cloud backup by design:
 *
 *   • Refuses to open a database from a FUTURE version (an older APK must not
 *     silently downgrade-write into a newer schema).
 *   • Takes a consistent snapshot before every migration, via `VACUUM INTO`.
 *     A byte-copy of .db/-wal/-shm can capture a checkpoint mid-flight; VACUUM INTO
 *     is one statement producing one guaranteed-consistent file.
 *   • Runs each migration inside ONE exclusive transaction that also sets user_version,
 *     so a crash mid-migration rolls back completely.
 *   • Verifies integrity_check + foreign_key_check afterwards.
 */
export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;

  const handle = await SQLite.openDatabaseAsync(DB_NAME);
  await handle.execAsync('PRAGMA journal_mode = WAL;');
  await handle.execAsync('PRAGMA foreign_keys = ON;');
  await handle.execAsync('PRAGMA busy_timeout = 5000;');

  const row = await handle.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;

  if (current > LATEST_VERSION) {
    throw new Error(
      `Database is version ${current} but this build only knows ${LATEST_VERSION}. ` +
        `Refusing to open — install the newer app version instead of downgrading.`,
    );
  }

  if (current < LATEST_VERSION) {
    await snapshotBeforeMigration(handle, current);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await applyMigration(handle, migration);
    }
    await verifyIntegrity(handle);
  }

  db = handle;
  return handle;
}

async function applyMigration(handle: SQLite.SQLiteDatabase, migration: (typeof MIGRATIONS)[number]) {
  await handle.execAsync('BEGIN EXCLUSIVE;');
  try {
    for (const statement of migration.statements) {
      await handle.execAsync(statement);
    }
    await handle.execAsync(`PRAGMA user_version = ${migration.version};`);
    await handle.execAsync('COMMIT;');
  } catch (error) {
    await handle.execAsync('ROLLBACK;');
    throw new Error(
      `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${String(error)}`,
    );
  }
}

/**
 * The sanctioned way for a migration to backfill an append-only table.
 *
 * Guard triggers exist so application code can never rewrite history — but a
 * legitimate migration sometimes must. Lifting them has to happen inside the
 * migration's own transaction, and they must always go back.
 */
export async function withTriggersOff(
  handle: SQLite.SQLiteDatabase,
  work: () => Promise<void>,
): Promise<void> {
  const recreate: string[] = [];
  for (const name of APPEND_ONLY_TRIGGERS) {
    const sql = await handle.getFirstAsync<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?;`,
      [name],
    );
    if (sql?.sql) {
      recreate.push(sql.sql);
      await handle.execAsync(`DROP TRIGGER IF EXISTS ${name};`);
    }
  }
  try {
    await work();
  } finally {
    for (const sql of recreate) await handle.execAsync(`${sql};`);
  }
}

/** Consistent snapshot. Keeps the newest 3. */
async function snapshotBeforeMigration(handle: SQLite.SQLiteDatabase, fromVersion: number) {
  if (fromVersion === 0) return; // nothing to lose yet

  try {
    const dir = new Directory(Paths.document, 'dbsnapshots');
    if (!dir.exists) dir.create({ intermediates: true });

    await handle.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    const target = new File(dir, `pre-v${fromVersion}-${Date.now()}.db`);
    await handle.execAsync(`VACUUM INTO '${target.uri.replace('file://', '')}';`);

    const snapshots = dir
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.db'))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const stale of snapshots.slice(3)) stale.delete();
  } catch (error) {
    // A failed snapshot must not block the migration, but it must be loud.
    console.warn('[db] pre-migration snapshot failed', error);
  }
}

async function verifyIntegrity(handle: SQLite.SQLiteDatabase) {
  const integrity = await handle.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
  if (integrity && integrity.integrity_check !== 'ok') {
    throw new Error(`Database integrity check failed: ${integrity.integrity_check}`);
  }
  const fkViolations = await handle.getAllAsync('PRAGMA foreign_key_check;');
  if (fkViolations.length > 0) {
    console.warn('[db] foreign key violations after migration', fkViolations);
  }
}

/** Test seam — lets the unit tests inject a fake. */
export function __setDatabaseForTests(handle: SQLite.SQLiteDatabase | null) {
  db = handle;
}

export { DB_NAME };
