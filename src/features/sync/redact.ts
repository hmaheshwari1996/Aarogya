/**
 * The last gate a row passes before it is sealed and pushed: local file paths are removed.
 *
 * ═══ THE DEFECT THIS EXISTS TO CLOSE ══════════════════════════════════════════════
 *
 * `./outbox.ts` builds a record with `SELECT *`, so every column of a syncing table rides
 * in the record stream. Five of those columns hold a `file://` path inside THIS install's
 * private data directory:
 *
 *   prescription.image_uri, prescription.cropped_image_uri   (migrations.ts v1)
 *   medicine.strip_photo_uri
 *   symptom_event.photo_uri
 *   lab_result.report_uri
 *
 * All five tables MUST sync — a prescription, a medicine, a symptom and a lab result are
 * the record. The table is not the problem; the COLUMN is. The value is worthless to any
 * receiver (Android renumbers that directory on reinstall, which is why
 * `features/backup/restore.ts` has to re-point every one of them on restore) and it is not
 * free to send: a path's last segment is frequently a name SHE chose, and the set of paths
 * is a description of her storage layout.
 *
 * The sealed SNAPSHOT already refuses to carry them, in those words — `./snapshot.ts`,
 * "No file paths", and docs/SYNC-AND-BACKUP.md §17 "No photographs". The record stream
 * carried them anyway. This closes that gap, so the two halves of the sharing surface now
 * make the same promise.
 *
 * ═══ THE RULE: THE NAME DECIDES ═══════════════════════════════════════════════════
 *
 * The same rule, and the same sentence, as `features/devlog/redact.ts`. It is stated there
 * at length and it is worth restating in one line here, because this file is the other pipe
 * out of the phone:
 *
 *   A COLUMN NAME IS A PROMISE ABOUT WHAT THE COLUMN CAN HOLD.
 *
 * So this decides on the NAME, never on whether the value happens to look like a path. The
 * alternative — sniffing values for `file://` or `/data/` — was rejected on purpose, and
 * the reason is clinical rather than aesthetic: value-sniffing runs over free text, and the
 * free text here is `symptom_event.note` and `visit_log.notes`, which is a patient's own
 * account of her illness. A regex that edits those silently corrupts the record on its way
 * to the only people who might notice something is wrong. Nothing in this app may quietly
 * rewrite what she wrote.
 *
 * ═══ WHY THERE IS NO LIST OF COLUMNS ANYWHERE IN THIS FILE ════════════════════════
 *
 * A hard-coded list of the five names above would be correct today and wrong the first time
 * somebody adds a sixth in a migration — and wrong SILENTLY, because a leaked path is not a
 * crash, a failing test or a visible symptom. It is a value sitting in a database somebody
 * else runs.
 *
 * `restore.ts` already made this decision, in the other direction, for the same reason: it
 * discovers URI columns from `PRAGMA table_info` rather than naming them, "because the day
 * somebody adds a seventh, a hard-coded list would silently leave that one pointing at a
 * directory belonging to a previous install". This is the egress half of that argument, and
 * `isLocalPathColumn` below is deliberately THE SAME PREDICATE, so the set of columns
 * restore has to re-point and the set sync refuses to send are one set with two consumers.
 * `sync.test.ts` pins that pairing against restore.ts's own source, because the two files
 * live in different features and nothing else would notice them drifting apart.
 *
 * ═══ WHY THE KEY IS DROPPED AND NOT NULLED ════════════════════════════════════════
 *
 * `{ image_uri: null }` asserts THERE IS NO IMAGE, which is false — there is one, it is on
 * her phone, and it is staying there. An absent key asserts nothing; it says this field did
 * not travel, which is exactly what happened.
 *
 * The difference is not pedantry. It is the same distinction the schema already spends two
 * triggers enforcing between `reading.v1` and `reading.qualifier_bound`: a wire format must
 * never state a fact the record does not support. It also leaves room — a later build that
 * genuinely needs "a photograph exists" can add a boolean, and an old payload's SILENCE will
 * be distinguishable from a new payload's `false`. Nulling now would spend that.
 *
 * A boolean was considered and NOT added today. Nothing reads the record stream (docs
 * §17: "nothing reads it today"), and the reader it is being kept for is a full-history
 * viewer — which by the same design carries no photographs, so a `hasPhoto: true` would
 * render a placeholder for something the viewer can never be given. That is worse than
 * silence: it promises an affordance that does not exist, on the screen of somebody in
 * another city who cannot ask.
 *
 * PURE. No imports, no clock, no database — so `node --test` loads it directly. That is the
 * whole reason this is its own file rather than four lines inside `./outbox.ts`, which
 * reaches expo-sqlite and cannot be tested at all.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Does this column name promise a path on this handset?
 *
 * IDENTICAL, DELIBERATELY, to the predicate in `features/backup/restore.ts`'s
 * `verifyAndRepoint`. Changing one without the other is the drift the pairing test in
 * `sync.test.ts` exists to catch.
 *
 * `_path` is NOT matched, and that is a decision rather than an oversight: no column in the
 * schema is spelled that way, and adding it here alone would break the pairing — restore
 * would keep failing to re-point a hypothetical `scan_path` while sync silently dropped it,
 * which is the worst of both. If such a column is ever added, widen BOTH predicates in the
 * same change.
 */
export function isLocalPathColumn(name: string): boolean {
  return /_uri$/.test(name) || name === 'uri';
}

/**
 * The two columns of an audit row that inherit their meaning from a third.
 *
 * `record_edit` (which syncs) stores one row per corrected field: `field` names the column
 * that changed, and `old_value` / `new_value` hold what it changed from and to — AS TEXT,
 * whatever the column's type was. So editing a symptom's photograph writes
 * `field='photo_uri'` with two `file://` paths beside it, and no rule that looks only at
 * COLUMN names can ever see them: the columns are called `old_value` and `new_value`.
 *
 * See `editSymptomEvent` in `src/db/repositories/symptoms.ts`, which is the one caller that
 * can produce this today. It is a second door onto the same leak, and it was missed by the
 * review that found the first one.
 */
const AUDIT_VALUE_COLUMNS = ['old_value', 'new_value'] as const;

/** The column whose VALUE names the column the audit row is about. */
const AUDIT_FIELD_COLUMN = 'field';

/**
 * A row with every local path removed, ready to be sealed.
 *
 * Returns a NEW object; the caller's row — which is what `readLocalRow` just read out of
 * SQLite — is never mutated. Sealing is not the only thing that ever touches a row and a
 * strip with a side effect is a strip that eventually deletes a path from something that
 * needed it.
 *
 * Two rules, and the second one is why this takes a whole row rather than a list of keys:
 *
 *  1. Drop every key whose own name promises a path.
 *  2. Drop `old_value` / `new_value` when `field` NAMES a column that promises a path.
 *
 * Rule 2 is keyed on the audit SHAPE — a string `field` plus at least one of those two
 * value columns — and not on the table being called `record_edit`. A second audit table, or
 * a rename of this one, then inherits the rule instead of quietly escaping it. The shape is
 * specific enough to be safe: no other table in the schema has a `field` column at all.
 *
 * BOTH RULES ARE AUTOMATIC FOR A COLUMN THAT DOES NOT EXIST YET. A `scan_uri` added in a
 * future migration is dropped by rule 1 the first time it is written, and its corrections
 * are dropped by rule 2 the first time one is audited, with no edit to this file.
 *
 * Rows out of SQLite are flat — every value is a string, a number or null — so there is
 * nothing nested here to walk, and this does not pretend to walk one. If a JSON column ever
 * starts carrying a path inside its text, that is a producer-side bug and must be fixed at
 * the producer; see the note on `prescription.extraction_error` in the report that
 * accompanied this change.
 */
export function stripLocalPaths(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const auditField = row[AUDIT_FIELD_COLUMN];
  const isPathAudit =
    typeof auditField === 'string' &&
    isLocalPathColumn(auditField) &&
    AUDIT_VALUE_COLUMNS.some((column) => Object.prototype.hasOwnProperty.call(row, column));

  for (const [column, value] of Object.entries(row)) {
    if (isLocalPathColumn(column)) continue;
    if (isPathAudit && (AUDIT_VALUE_COLUMNS as readonly string[]).includes(column)) continue;
    out[column] = value;
  }

  return out;
}
