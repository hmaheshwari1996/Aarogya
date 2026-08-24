/**
 * Tests for the family-sharing cryptography and the share-link grammar.
 *
 * WHAT IS BEING PROVED HERE
 *
 *   • A record sealed with the share key opens with it and with nothing else, and the row
 *     it belongs to is bound in, so the server cannot move a payload onto another row.
 *   • PADDING WORKS — two payloads of very different lengths produce ciphertext of the SAME
 *     length. Without this, an observer reads the length of every symptom note and
 *     reconstructs a diary of somebody's illness from metadata alone.
 *   • A snapshot is bound to its link id, so an operator cannot show one family another
 *     family's record by moving a blob between rows.
 *   • THE KEY IS IN THE FRAGMENT AND NOWHERE ELSE. The link is the credential in this
 *     model, and the single property that makes that safe is that everything after `#` is
 *     never transmitted. There is an explicit assertion that the part of the URL a server
 *     would receive does not contain the key.
 *   • A link parses back to exactly the two values it was built from, from a full URL, from
 *     a path, and from the hostless code — and rubbish parses to null rather than throwing.
 *   • NO LOCAL FILE PATH IS EVER SEALED. The record stream ships whole rows, so a `*_uri`
 *     column travels unless something stops it; `./redact.ts` is that something, and the
 *     tests below prove it stops a column that does not exist yet, stops the audit row that
 *     carries a path under a column called `old_value`, and stops nothing else.
 *
 * `crypto.ts`, `share.ts`, `snapshot.ts`, `outbox.ts` and `alerts.ts` all need expo or the
 * database and cannot load in this runner; every rule they depend on lives in the pure
 * modules imported below, which is why those modules exist.
 *
 * On the dynamic import: see `features/care/calendar.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const SEALED = './sealed.ts';
const LINK = './link.ts';
const REDACT = './redact.ts';
const BYTES = '../backup/bytes.ts';

const {
  bucketFor,
  openJson,
  openRecord,
  pad,
  recordAad,
  sealJson,
  sealRecord,
  snapshotAad,
  unpad,
  NONCE_BYTES,
  PAD_BUCKETS,
  SHARE_KEY_BYTES,
  TAG_BYTES,
} = (await import(SEALED)) as typeof import('./sealed');

const {
  fromBase64Url,
  isWellFormedLinkId,
  isWellFormedShareKey,
  mintLinkId,
  mintShareKey,
  parseShareLink,
  shareCode,
  shareUrl,
  toBase64Url,
  LINK_ID_BYTES,
  SHARE_PATH_PREFIX,
} = (await import(LINK)) as typeof import('./link');

const { isLocalPathColumn, stripLocalPaths } = (await import(REDACT)) as typeof import('./redact');

const { bytesToHex, bytesToUtf8, utf8Bytes } = (await import(BYTES)) as typeof import('../backup/bytes');

/** Deterministic, so a failure is reproducible rather than a once-a-week mystery. */
function fakeRandom(seed: number): (count: number) => Uint8Array {
  let state = seed >>> 0;
  return (count) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out[i] = (state >>> 24) & 0xff;
    }
    return out;
  };
}

// ── Padding ──────────────────────────────────────────────────────────────────

test('padding rounds up to the next bucket and survives a round trip', () => {
  for (const length of [0, 1, 100, 251, 252, 253, 1000]) {
    const payload = fakeRandom(3)(length);
    const padded = pad(payload);
    assert.ok(PAD_BUCKETS.includes(padded.length), `${length} → ${padded.length}`);
    assert.deepEqual(Array.from(unpad(padded)), Array.from(payload), `length ${length}`);
  }
});

test('two very different payloads produce ciphertext of the SAME length', () => {
  // The whole reason padding exists: without it the server learns how much was written,
  // which is a diary of somebody's illness reconstructed from lengths alone.
  const key = fakeRandom(4)(SHARE_KEY_BYTES);
  const random = fakeRandom(5);

  const short = sealRecord(key, utf8Bytes('120/80'), recordAad('reading:a', 1), random);
  const long = sealRecord(
    key,
    utf8Bytes('felt dizzy after the morning dose and had to sit down for a while, '.repeat(2)),
    recordAad('symptom_event:b', 2),
    random,
  );
  assert.equal(short.length, long.length);
  assert.equal(short.length, NONCE_BYTES + (PAD_BUCKETS[0] ?? 0) + TAG_BYTES);
});

test('bucketFor picks the smallest bucket that fits, and refuses anything past the largest', () => {
  assert.equal(bucketFor(1), 256);
  assert.equal(bucketFor(256), 256);
  assert.equal(bucketFor(257), 512);
  assert.throws(() => bucketFor(1_000_000), /past the largest padding bucket/);
});

// ── Sealing records ──────────────────────────────────────────────────────────

test('a sealed record opens again with the share key', () => {
  const key = fakeRandom(6)(SHARE_KEY_BYTES);
  const aad = recordAad('reading:abc', 42);
  const plaintext = utf8Bytes('a systolic of 138');

  const blob = sealRecord(key, plaintext, aad, fakeRandom(7));
  assert.deepEqual(Array.from(openRecord(key, blob, aad) ?? []), Array.from(plaintext));
});

test('a record does not open with a different share key', () => {
  // This is what rotation buys: a link holding the old key opens nothing sealed under the
  // new one, even if a row somehow survived the delete.
  const aad = recordAad('reading:abc', 1);
  const blob = sealRecord(fakeRandom(8)(SHARE_KEY_BYTES), utf8Bytes('x'), aad, fakeRandom(9));
  assert.equal(openRecord(fakeRandom(10)(SHARE_KEY_BYTES), blob, aad), null);
});

test('the server cannot move a payload onto a different row', () => {
  // row_key and lamport are associated data, so re-labelling a blob breaks its tag.
  const key = fakeRandom(11)(SHARE_KEY_BYTES);
  const blob = sealRecord(key, utf8Bytes('confidential'), recordAad('reading:one', 5), fakeRandom(12));

  assert.equal(openRecord(key, blob, recordAad('reading:two', 5)), null);
  assert.equal(openRecord(key, blob, recordAad('reading:one', 6)), null);
  assert.notEqual(openRecord(key, blob, recordAad('reading:one', 5)), null);
});

test('a tampered record is detected', () => {
  const key = fakeRandom(13)(SHARE_KEY_BYTES);
  const aad = recordAad('reading:abc', 1);
  const blob = sealRecord(key, utf8Bytes('a reading'), aad, fakeRandom(14));
  const tampered = Uint8Array.from(blob);
  tampered[40] = (tampered[40] ?? 0) ^ 0xff;
  assert.equal(openRecord(key, tampered, aad), null);
});

test('a truncated record is rejected rather than half-read', () => {
  const key = fakeRandom(15)(SHARE_KEY_BYTES);
  const aad = recordAad('reading:abc', 1);
  const blob = sealRecord(key, utf8Bytes('a reading'), aad, fakeRandom(16));
  assert.equal(openRecord(key, blob.subarray(0, blob.length - 4), aad), null);
  assert.equal(openRecord(key, blob.subarray(0, 8), aad), null);
});

test('JSON round trips through the sealed layer', () => {
  const key = fakeRandom(17)(SHARE_KEY_BYTES);
  const aad = recordAad('medicine:xyz', 9);
  const row = { id: 'xyz', name_as_written: 'मेटफॉर्मिन 500', criticality: 'standard', lamport: 9 };

  const blob = sealJson(key, row, aad, fakeRandom(18));
  assert.deepEqual(openJson<typeof row>(key, blob, aad), row);
});

test('nonces are not reused across records sealed with one key', () => {
  const key = fakeRandom(19)(SHARE_KEY_BYTES);
  const random = fakeRandom(20);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const blob = sealRecord(key, utf8Bytes(`row ${i}`), recordAad(`reading:${i}`, i), random);
    seen.add(bytesToHex(blob.subarray(0, NONCE_BYTES)));
  }
  assert.equal(seen.size, 200);
});

test('a sealed payload is opaque — the plaintext never appears in the blob', () => {
  // The one property the whole "the server only ever holds ciphertext" claim rests on.
  const key = fakeRandom(52)(SHARE_KEY_BYTES);
  const secret = 'रिफैम्पिसिन 450';
  const blob = sealRecord(key, utf8Bytes(secret), recordAad('medicine:x', 1), fakeRandom(53));
  assert.equal(bytesToUtf8(blob).includes(secret), false);
});

// ── The shared snapshot ──────────────────────────────────────────────────────

test('a snapshot is bound to its link id and cannot be moved to another', () => {
  // An operator who copied the blob from one dataset row to another would produce
  // something that fails to open, rather than showing one family another family's record.
  const key = fakeRandom(54)(SHARE_KEY_BYTES);
  const snapshot = { version: 1, patientName: 'मीना', readings: [] };

  const blob = sealJson(key, snapshot, snapshotAad('AAAAAAAAAAAAAAAAAAAAAA'), fakeRandom(55));
  assert.deepEqual(openJson(key, blob, snapshotAad('AAAAAAAAAAAAAAAAAAAAAA')), snapshot);
  assert.equal(openJson(key, blob, snapshotAad('BBBBBBBBBBBBBBBBBBBBBB')), null);
});

test('a snapshot sealed before a rotation does not open with the key after it', () => {
  const before = fakeRandom(56)(SHARE_KEY_BYTES);
  const after = fakeRandom(57)(SHARE_KEY_BYTES);
  const aad = snapshotAad('CCCCCCCCCCCCCCCCCCCCCC');
  const blob = sealJson(before, { version: 1 }, aad, fakeRandom(58));
  assert.equal(openJson(after, blob, aad), null);
});

// ── base64url ────────────────────────────────────────────────────────────────

test('base64url round trips and contains nothing a URL would mangle', () => {
  for (const seed of [60, 61, 62, 63]) {
    const bytes = fakeRandom(seed)(SHARE_KEY_BYTES);
    const encoded = toBase64Url(bytes);
    assert.equal(/[+/=]/.test(encoded), false, encoded);
    assert.equal(bytesToHex(fromBase64Url(encoded) ?? new Uint8Array()), bytesToHex(bytes));
  }
});

test('rubbish decodes to null rather than throwing', () => {
  for (const input of ['', '   ', 'not base64!!', '#####']) {
    assert.equal(fromBase64Url(input), null, JSON.stringify(input));
  }
});

// ── Minting ──────────────────────────────────────────────────────────────────

test('a minted link id is 128 bits and well formed', () => {
  const id = mintLinkId(fakeRandom(64));
  assert.equal(isWellFormedLinkId(id), true);
  assert.equal((fromBase64Url(id) ?? new Uint8Array()).length, LINK_ID_BYTES);
});

test('a minted key is 32 bytes and survives the fragment encoding', () => {
  const key = mintShareKey(fakeRandom(65));
  assert.equal(key.length, SHARE_KEY_BYTES);
  assert.equal(isWellFormedShareKey(toBase64Url(key)), true);
});

test('rotation produces a different id AND a different key', () => {
  // Belt and braces: either one alone would kill the old link, and the test says so.
  const first = { id: mintLinkId(fakeRandom(66)), key: toBase64Url(mintShareKey(fakeRandom(67))) };
  const second = { id: mintLinkId(fakeRandom(68)), key: toBase64Url(mintShareKey(fakeRandom(69))) };
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.key, second.key);
});

test('a short or malformed id is refused', () => {
  assert.equal(isWellFormedLinkId(''), false);
  assert.equal(isWellFormedLinkId('short'), false);
  assert.equal(isWellFormedLinkId('has spaces in it here'), false);
  assert.equal(isWellFormedLinkId('aarogya.github.io'), false);
});

test('a key of the wrong length is refused', () => {
  assert.equal(isWellFormedShareKey(toBase64Url(fakeRandom(70)(16))), false);
  assert.equal(isWellFormedShareKey(toBase64Url(fakeRandom(71)(64))), false);
  assert.equal(isWellFormedShareKey('not-a-key'), false);
});

// ── The link, and the fragment rule ──────────────────────────────────────────

const SAMPLE = {
  linkId: mintLinkId(fakeRandom(72)),
  keyB64url: toBase64Url(mintShareKey(fakeRandom(73))),
};

test('THE KEY IS AFTER THE HASH AND NOWHERE ELSE', () => {
  // This is the assertion the entire sharing model rests on. Everything before the `#` is
  // what a server receives; the key must not be in it, in any form, ever.
  const url = shareUrl('https://example.github.io', SAMPLE);
  const sent = url.split('#')[0] ?? '';

  assert.equal(sent.includes(SAMPLE.keyB64url), false);
  assert.equal(url.includes(`#k=${SAMPLE.keyB64url}`), true);
  // And it is not smuggled into a query string either.
  assert.equal(sent.includes('?'), false);
  assert.equal(sent, `https://example.github.io${SHARE_PATH_PREFIX}/${SAMPLE.linkId}`);
});

test('a link round trips through its own parser', () => {
  const url = shareUrl('https://example.github.io', SAMPLE);
  assert.deepEqual(parseShareLink(url), SAMPLE);
});

test('the hostless code carries exactly the same two values', () => {
  // The paste path, for a phone with no link host configured at all.
  const code = shareCode(SAMPLE);
  assert.equal(code.includes('http'), false);
  assert.deepEqual(parseShareLink(code), SAMPLE);
});

test('parsing is host-agnostic, because the viewer phone was never configured', () => {
  // Refusing a link because its host is not the one THIS build was compiled with would
  // break the ordinary case: a daughter-in-law pasting a link into a fresh install.
  for (const origin of ['https://example.github.io', 'https://someone-else.github.io']) {
    assert.deepEqual(parseShareLink(shareUrl(origin, SAMPLE)), SAMPLE);
  }
  assert.deepEqual(parseShareLink(`${SHARE_PATH_PREFIX}/${SAMPLE.linkId}#k=${SAMPLE.keyB64url}`), SAMPLE);
});

test('surrounding whitespace and a trailing newline are forgiven', () => {
  // It arrives on a clipboard, from a chat app, on a phone.
  assert.deepEqual(parseShareLink(`  ${shareCode(SAMPLE)}\n`), SAMPLE);
});

test('a link with no fragment is not a link', () => {
  // Half a link is the dangerous case: it looks right and shows nothing.
  assert.equal(parseShareLink(`https://example.github.io${SHARE_PATH_PREFIX}/${SAMPLE.linkId}`), null);
});

test('a link whose key is the wrong length is refused', () => {
  const short = toBase64Url(fakeRandom(74)(16));
  assert.equal(parseShareLink(`${SAMPLE.linkId}#k=${short}`), null);
});

test('rubbish is not a link', () => {
  for (const input of ['', 'hello there', 'https://example.com', '#k=', 'x#k=y']) {
    assert.equal(parseShareLink(input), null, JSON.stringify(input));
  }
});

// ── No local file path leaves the phone ──────────────────────────────────────
//
// The record stream ships WHOLE ROWS (`SELECT *` in ./outbox.ts), which is the right shape
// and the reason this gate has to exist: a column added to a syncing table travels unless
// something stops it. Five columns hold a path inside this install's private directory —
// the one Android renumbers on reinstall, which is why restore.ts has to rewrite every one
// of them — and the last segment of a path is frequently a name she chose.
//
// These tests are on the PURE module for the reason this file's header gives: outbox.ts
// reaches expo-sqlite and cannot be loaded here at all. What is proved is the rule; the
// wiring is two call sites, both commented, and the header of outbox.ts says a third one
// must call it too.

test('every column that names a path is dropped, and the clinical content is untouched', () => {
  const row = {
    id: 'rx1',
    profile_id: 'p1',
    image_uri: 'file:///data/user/0/in.aarogya.care/files/rx/march.jpg',
    cropped_image_uri: 'file:///data/user/0/in.aarogya.care/files/rx/march-crop.jpg',
    prescriber: 'Dr Rao',
    clinic: 'City Chest Clinic',
    prescribed_on: '2026-03-04',
    status: 'confirmed',
    lamport: 12,
  };
  const stripped = stripLocalPaths(row);

  assert.equal('image_uri' in stripped, false);
  assert.equal('cropped_image_uri' in stripped, false);
  // Everything else is the record, and the record is the entire point of syncing at all.
  assert.deepEqual(stripped, {
    id: 'rx1',
    profile_id: 'p1',
    prescriber: 'Dr Rao',
    clinic: 'City Chest Clinic',
    prescribed_on: '2026-03-04',
    status: 'confirmed',
    lamport: 12,
  });
});

test('the key is ABSENT, not null — an absent field says nothing, a null says there is no photo', () => {
  // Not pedantry, and the same distinction the schema spends two triggers enforcing between
  // `reading.v1` and `reading.qualifier_bound`: a wire format must never state a fact the
  // record does not support. There IS a photograph. It is on her phone and it is staying
  // there. It also leaves room for a later build to add a real boolean without an old
  // payload's silence being indistinguishable from a new payload's `false`.
  const stripped = stripLocalPaths({ id: 'm1', strip_photo_uri: 'file:///x/strip.jpg' });
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'strip_photo_uri'), false);
  assert.deepEqual(Object.keys(stripped), ['id']);
});

test('a *_uri column THAT DOES NOT EXIST YET is dropped, with no edit to the rule', () => {
  // THE WHOLE REASON THIS IS A PREDICATE AND NOT A LIST. A list of the five columns would
  // be correct today and wrong the first time somebody adds a sixth in a migration — and
  // wrong silently, because a leaked path is not a crash, a failing test, or anything
  // anybody on this phone can see. If this test ever fails, someone has replaced the rule
  // with a list; put the rule back.
  const stripped = stripLocalPaths({
    id: 's1',
    scan_uri: 'file:///data/user/0/in.aarogya.care/files/scan.png',
    uri: 'file:///data/user/0/in.aarogya.care/files/bare.png',
    severity: 'moderate',
  });
  assert.deepEqual(stripped, { id: 's1', severity: 'moderate' });
});

test('an audit row loses the two paths it carries under columns named old_value and new_value', () => {
  // THE SECOND DOOR, and it is the one the original review missed. `record_edit` syncs, and
  // `editSymptomEvent` writes one row per corrected field: `field` names the column and the
  // two values hold what it changed from and to, AS TEXT. So a photo correction publishes
  // two paths under column names that promise nothing at all, and no rule that looks only
  // at the row's own column names can ever see them.
  const stripped = stripLocalPaths({
    id: 'e1',
    record_kind: 'symptom_event',
    record_id: 's1',
    field: 'photo_uri',
    old_value: 'file:///data/user/0/in.aarogya.care/files/sym/old.jpg',
    new_value: 'file:///data/user/0/in.aarogya.care/files/sym/new.jpg',
    at_epoch: 1_780_000_000_000,
  });

  assert.equal('old_value' in stripped, false);
  assert.equal('new_value' in stripped, false);
  // What survives is the audit FACT — the photograph on this symptom was changed, then —
  // which is what makes a correction reviewable. Only the paths are gone.
  assert.deepEqual(stripped, {
    id: 'e1',
    record_kind: 'symptom_event',
    record_id: 's1',
    field: 'photo_uri',
    at_epoch: 1_780_000_000_000,
  });
});

test('an ordinary correction keeps both its values — the audit trail is not collateral damage', () => {
  // The rule must be exactly as wide as the leak. `edited_count` on its own is a rumour:
  // a doctor looking at a corrected 180 systolic cannot tell whether the original was 108
  // (a transposition) or 80 (a different arm). Over-stripping here would quietly turn every
  // correction back into that rumour, on the sheet she hands over.
  for (const field of ['v1', 'severity', 'note', 'at_epoch', 'symptom_key']) {
    const stripped = stripLocalPaths({
      id: 'e2',
      field,
      old_value: '108',
      new_value: '180',
    });
    assert.deepEqual(stripped, { id: 'e2', field, old_value: '108', new_value: '180' }, field);
  }
});

test('a value that merely LOOKS like a path is never touched — the NAME decides', () => {
  // Value-sniffing was rejected on purpose. The free text on these tables is
  // `symptom_event.note` and `visit_log.notes` — a patient's own account of her illness —
  // and a regex that edits those silently corrupts the record on its way to the only people
  // who might notice something is wrong. Nothing in this app may rewrite what she wrote.
  const note = 'nurse said to keep the file:///card handy, ward /data/2, felt dizzy after';
  const stripped = stripLocalPaths({ id: 's2', note, custom_label: '/storage/emulated/0' });
  assert.equal(stripped['note'], note);
  assert.equal(stripped['custom_label'], '/storage/emulated/0');
});

test('the strip never mutates the row it was given', () => {
  // `readLocalRow` hands over the row it just read out of SQLite, and a strip with a side
  // effect is a strip that eventually deletes a path from something that needed it.
  const row: Record<string, unknown> = { id: 'x', photo_uri: 'file:///a.jpg' };
  stripLocalPaths(row);
  assert.equal(row['photo_uri'], 'file:///a.jpg');
});

test('a row that carries no path at all comes back exactly as it went in', () => {
  const row = { id: 'r1', v1: 138, v2: 84, value_qualifier: 'exact', note: null, lamport: 3 };
  assert.deepEqual(stripLocalPaths(row), row);
});

test('END TO END: a sealed record built from a stripped row contains no path', () => {
  // The composition, not the rule. `sealJson` is what the drain actually calls, and this is
  // the assertion the whole change exists to be able to make.
  const key = fakeRandom(80)(SHARE_KEY_BYTES);
  const path = 'file:///data/user/0/in.aarogya.care/files/sym/lesion.jpg';
  const row = { id: 's1', profile_id: 'p1', photo_uri: path, severity: 'severe', lamport: 4 };

  const blob = sealJson(
    key,
    { op: 'upsert', table: 'symptom_event', row: stripLocalPaths(row) },
    recordAad('symptom_event:s1', 4),
    fakeRandom(81),
  );

  const opened = openJson<{ row: Record<string, unknown> }>(key, blob, recordAad('symptom_event:s1', 4));
  assert.ok(opened);
  assert.equal('photo_uri' in opened.row, false);
  assert.equal(opened.row['severity'], 'severe', 'the clinical content still travels');
  // And the path is not hiding anywhere in the JSON the seal was handed.
  assert.equal(JSON.stringify(opened).includes(path), false);
  assert.equal(JSON.stringify(opened).includes('file://'), false);
});

test('sync and restore still agree on WHICH columns hold a path', () => {
  // TWO HALVES OF ONE SET, IN TWO FEATURES THAT CANNOT IMPORT EACH OTHER'S REASONING.
  // `restore.ts` discovers URI columns from `PRAGMA table_info` so that a column added in a
  // future migration is re-pointed automatically; `isLocalPathColumn` drops the same names
  // on the way out for the same reason. If the two predicates ever diverge, one of the two
  // guarantees is quietly false and nothing else in the tree would notice.
  //
  // ASSERTED AGAINST THE SOURCE TEXT, which needs its excuse — the same one
  // `db/migrations.test.ts` gives for reading `_shared.ts`: restore.ts imports expo-sqlite
  // and expo-file-system, so `node --test` cannot load it. Reading the one line is strictly
  // weaker than importing the function and is still worth having, because the failure it
  // catches is a human editing one predicate and not the other, and that edit is visible in
  // the text. `import.meta.dirname` rather than `new URL(..., import.meta.url)`: this
  // project's `lib` includes the DOM, so the global `URL` is not Node's.
  const restore = readFileSync(join(import.meta.dirname, '..', 'backup', 'restore.ts'), 'utf8');
  assert.match(
    restore,
    /\/_uri\$\/\.test\(column\.name\)/,
    'restore.ts no longer discovers *_uri columns the way redact.ts drops them',
  );
  assert.match(
    restore,
    /column\.name !== 'uri'/,
    "restore.ts no longer treats a bare 'uri' column as a path",
  );

  // And the predicate itself, pinned by example in both directions.
  for (const name of ['image_uri', 'cropped_image_uri', 'strip_photo_uri', 'photo_uri', 'report_uri', 'uri', 'scan_uri']) {
    assert.equal(isLocalPathColumn(name), true, name);
  }
  for (const name of ['id', 'note', 'notes', 'uri_label', 'urine', 'old_value', 'field', 'clinic']) {
    assert.equal(isLocalPathColumn(name), false, name);
  }
});
