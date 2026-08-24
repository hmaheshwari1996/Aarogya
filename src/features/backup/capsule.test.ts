/**
 * Tests for the capsule format and its cryptography.
 *
 * WHAT IS TESTED HERE AND WHY IT IS EVERYTHING THAT MATTERS
 *
 * The capsule is the only disaster-recovery path in the product, and its failure mode is
 * uniquely cruel: an export that "worked" produces a file the user believes in for months
 * and which turns out, on the day the phone dies, not to open. There is no second chance
 * and no support channel that can help. So the properties below are checked mechanically
 * rather than by trying an export on a device and seeing a green toast:
 *
 *   • a sealed frame opens again, with the right key, and NOT with anything else
 *   • a swapped header or manifest is DETECTED, because they are associated data
 *   • the manifest survives a round trip byte-for-byte and refuses a malformed one
 *   • a manifest path with '..' in it is refused before restore ever writes a file
 *   • a whole capsule — header, manifest frame, payload frames — reads back
 *
 * `capsule.ts` and `restore.ts` themselves need expo's file and SQLite modules and cannot
 * load here, so the framing they use is exercised through `frameBytes`/`readFrameAt`,
 * which is the same code path the writer runs.
 *
 * On the dynamic import: see `features/care/calendar.test.ts` — Node's type-stripping
 * loader needs a fully-specified './x.ts' specifier, and this project does not enable
 * `allowImportingTsExtensions`.
 */

import { registerHooks } from 'node:module';
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

const BYTES = './bytes.ts';
const CRYPTO = './crypto.ts';
const FORMAT = './format.ts';
const PHRASE = './phrase.ts';

const {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  canonicalJson,
  concatBytes,
  readU32,
  u32,
  u64,
  utf8Bytes,
} = (await import(BYTES)) as typeof import('./bytes');

const {
  chunkAad,
  deriveCapsuleKey,
  frameNonce,
  manifestAad,
  open,
  seal,
  sha256Hex,
  sha256Stream,
  MIN_ACCEPTED_N,
  NONCE_BASE_BYTES,
  SALT_BYTES,
} = (await import(CRYPTO)) as typeof import('./crypto');

const {
  capsuleFileName,
  capsuleStampFromName,
  decodeHeader,
  defaultHeader,
  encodeHeader,
  encodeManifest,
  frameBytes,
  framesFor,
  isSafeRelativePath,
  parseManifest,
  readFrameAt,
  CHUNK_BYTES,
} = (await import(FORMAT)) as typeof import('./format');

const { buildRecoveryPhrase, formatPhrase, isWellFormedPhrase, normalisePhrase, PHRASE_LENGTH } =
  (await import(PHRASE)) as typeof import('./phrase');

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

/** The lowest cost the reader will accept, so the suite stays quick. */
const TEST_KDF = { name: 'scrypt', N: MIN_ACCEPTED_N, r: 8, p: 1, dkLen: 32 } as const;

// ── bytes ────────────────────────────────────────────────────────────────────

test('base64 survives a round trip, including every byte value', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(all))), Array.from(all));
});

test('base64 handles all three padding cases', () => {
  for (const length of [1, 2, 3, 4, 5, 6]) {
    const bytes = Uint8Array.from(Array.from({ length }, (_, i) => i * 37));
    assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes))), Array.from(bytes), `length ${length}`);
  }
});

test('base64 refuses a character that is not base64 rather than skipping it', () => {
  // Silently skipping would decode a corrupted salt into a plausible-looking one, and the
  // user would be told her passphrase is wrong when it is not.
  assert.throws(() => base64ToBytes('AA!A'), /Not base64/);
});

test('UTF-8 survives Devanagari and an emoji', () => {
  const text = 'मेटफॉर्मिन 500 मिग्रा 💊';
  assert.equal(bytesToUtf8(utf8Bytes(text)), text);
});

test('u32 and u64 are big-endian and round trip', () => {
  assert.deepEqual(Array.from(u32(0x01020304)), [1, 2, 3, 4]);
  assert.equal(readU32(u32(4_000_000_000), 0), 4_000_000_000);
  assert.deepEqual(Array.from(u64(1)), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(u64(256)), [0, 0, 0, 0, 0, 0, 1, 0]);
});

test('canonical JSON sorts keys, so the same manifest always produces the same bytes', () => {
  // This is what makes the manifest usable as associated data at all.
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonical JSON drops undefined exactly as JSON.stringify does', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

// ── the crypto round trip ────────────────────────────────────────────────────

test('a sealed frame opens again with the same key, nonce and associated data', async () => {
  const random = fakeRandom(1);
  const key = await deriveCapsuleKey('open sesame', random(SALT_BYTES), TEST_KDF);
  const nonce = frameNonce(random(NONCE_BASE_BYTES), 7);
  const aad = utf8Bytes('some header');
  const plaintext = utf8Bytes('the whole health record, in miniature');

  const sealed = seal(key, nonce, plaintext, aad);
  assert.notDeepEqual(Array.from(sealed), Array.from(plaintext));
  assert.deepEqual(Array.from(open(key, nonce, sealed, aad) ?? []), Array.from(plaintext));
});

test('the same passphrase and salt always derive the same key', async () => {
  const salt = fakeRandom(2)(SALT_BYTES);
  const first = await deriveCapsuleKey('a passphrase', salt, TEST_KDF);
  const second = await deriveCapsuleKey('a passphrase', salt, TEST_KDF);
  assert.equal(bytesToHex(first), bytesToHex(second));
});

test('a passphrase is normalised, so a trailing space cannot lock somebody out', async () => {
  const salt = fakeRandom(3)(SALT_BYTES);
  const plain = await deriveCapsuleKey('KZ7Q-M4PD', salt, TEST_KDF);
  const padded = await deriveCapsuleKey('  KZ7Q-M4PD  ', salt, TEST_KDF);
  assert.equal(bytesToHex(plain), bytesToHex(padded));
});

test('a different salt derives a different key from the same passphrase', async () => {
  const a = await deriveCapsuleKey('same words', fakeRandom(4)(SALT_BYTES), TEST_KDF);
  const b = await deriveCapsuleKey('same words', fakeRandom(5)(SALT_BYTES), TEST_KDF);
  assert.notEqual(bytesToHex(a), bytesToHex(b));
});

test('the wrong passphrase produces null, never a wrong answer', async () => {
  const random = fakeRandom(6);
  const salt = random(SALT_BYTES);
  const nonce = frameNonce(random(NONCE_BASE_BYTES), 0);
  const right = await deriveCapsuleKey('correct horse', salt, TEST_KDF);
  const wrong = await deriveCapsuleKey('correct hors', salt, TEST_KDF);

  const sealed = seal(right, nonce, utf8Bytes('secret'), utf8Bytes('aad'));
  assert.equal(open(wrong, nonce, sealed, utf8Bytes('aad')), null);
});

test('a single flipped bit is detected', async () => {
  const random = fakeRandom(7);
  const key = await deriveCapsuleKey('phrase', random(SALT_BYTES), TEST_KDF);
  const nonce = frameNonce(random(NONCE_BASE_BYTES), 3);
  const sealed = seal(key, nonce, utf8Bytes('a hundred readings'), utf8Bytes('aad'));

  const tampered = Uint8Array.from(sealed);
  tampered[5] = (tampered[5] ?? 0) ^ 0x01;
  assert.equal(open(key, nonce, tampered, utf8Bytes('aad')), null);
});

test('a swapped header is detected, because the manifest authenticates it', async () => {
  const random = fakeRandom(8);
  const key = await deriveCapsuleKey('phrase', random(SALT_BYTES), TEST_KDF);
  const nonce = frameNonce(random(NONCE_BASE_BYTES), 0);

  const realHeader = utf8Bytes('{"v":1,"schema":3}');
  const forgedHeader = utf8Bytes('{"v":1,"schema":9}');
  const manifest = utf8Bytes('{"entries":[]}');

  const sealed = seal(key, nonce, manifest, manifestAad(realHeader));
  assert.notEqual(open(key, nonce, sealed, manifestAad(realHeader)), null);
  assert.equal(open(key, nonce, sealed, manifestAad(forgedHeader)), null);
});

test('a swapped manifest is detected on every payload chunk', async () => {
  const random = fakeRandom(9);
  const key = await deriveCapsuleKey('phrase', random(SALT_BYTES), TEST_KDF);
  const nonceBase = random(NONCE_BASE_BYTES);
  const header = utf8Bytes('header');
  const manifest = utf8Bytes('{"entries":["a"]}');
  const forged = utf8Bytes('{"entries":["b"]}');

  const sealed = seal(key, frameNonce(nonceBase, 1), utf8Bytes('page one'), chunkAad(header, manifest, 1));
  assert.equal(open(key, frameNonce(nonceBase, 1), sealed, chunkAad(header, forged, 1)), null);
});

test('two chunks cannot be swapped, because the frame index is authenticated', async () => {
  const random = fakeRandom(10);
  const key = await deriveCapsuleKey('phrase', random(SALT_BYTES), TEST_KDF);
  const nonceBase = random(NONCE_BASE_BYTES);
  const header = utf8Bytes('header');
  const manifest = utf8Bytes('manifest');

  const first = seal(key, frameNonce(nonceBase, 1), utf8Bytes('one'), chunkAad(header, manifest, 1));
  // Reading frame 1's bytes as if they were frame 2 fails on both the nonce and the AAD.
  assert.equal(open(key, frameNonce(nonceBase, 2), first, chunkAad(header, manifest, 2)), null);
});

test('every frame gets a distinct nonce', () => {
  const base = fakeRandom(11)(NONCE_BASE_BYTES);
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(bytesToHex(frameNonce(base, i)));
  assert.equal(seen.size, 500);
});

test('streamed SHA-256 matches the one-shot digest', () => {
  const chunks = [utf8Bytes('one'), utf8Bytes('two'), utf8Bytes('three')];
  const hasher = sha256Stream();
  for (const chunk of chunks) hasher.update(chunk);
  assert.equal(hasher.hex(), sha256Hex(concatBytes(...chunks)));
});

test('a capsule refuses a scrypt cost below the floor', async () => {
  await assert.rejects(
    () => deriveCapsuleKey('x', fakeRandom(12)(SALT_BYTES), { name: 'scrypt', N: 1024, r: 8, p: 1, dkLen: 32 }),
    /Refusing scrypt/,
  );
});

test('a capsule cannot be sealed with an empty passphrase', async () => {
  await assert.rejects(() => deriveCapsuleKey('   ', fakeRandom(13)(SALT_BYTES), TEST_KDF), /empty passphrase/);
});

// ── the header and the manifest ──────────────────────────────────────────────

function sampleManifest(overrides: Record<string, unknown> = {}) {
  return {
    format: 'aarogya.capsule.manifest' as const,
    v: 1,
    createdAtEpoch: 1_770_000_000_000,
    createdLocalDate: '2026-02-02',
    appVersion: '0.1.0',
    schemaUserVersion: 2,
    profileId: 'e2f9c0f0-1111-4222-8333-444455556666',
    profileName: 'Meena',
    documentRoot: '/data/user/0/in.aarogya.care/files',
    entries: [
      { kind: 'database' as const, path: 'db/aarogya.db', bytes: 10, sha256: 'a'.repeat(64), firstFrame: 1, frameCount: 1 },
      { kind: 'media' as const, path: 'files/labs/x.jpg', bytes: 5, sha256: 'b'.repeat(64), firstFrame: 2, frameCount: 1 },
    ],
    skipped: [{ path: 'files/labs/huge.jpg', bytes: 99_000_000, reason: 'too_large' as const }],
    totalPlaintextBytes: 15,
    ...overrides,
  };
}

test('a header survives encode and decode with its exact bytes preserved', () => {
  const header = defaultHeader('c2FsdA==', 'bm9uY2U=', 1_770_000_000_000);
  const { prefix, headerBytes } = encodeHeader(header);
  const decoded = decodeHeader(concatBytes(prefix, headerBytes));

  assert.equal(decoded.header.salt, 'c2FsdA==');
  assert.equal(decoded.header.nonceBase, 'bm9uY2U=');
  assert.equal(decoded.header.chunkBytes, CHUNK_BYTES);
  // The AAD is computed over the ORIGINAL bytes, never a re-serialisation.
  assert.deepEqual(Array.from(decoded.headerBytes), Array.from(headerBytes));
});

test('a file that is not a capsule is rejected by its signature', () => {
  assert.throws(() => decodeHeader(utf8Bytes('this is a photograph, not a backup')), /wrong file signature/);
});

test('a capsule from a newer format version is refused, not guessed at', () => {
  const header = { ...defaultHeader('c2FsdA==', 'bm9uY2U=', 1), v: 99 };
  const { prefix, headerBytes } = encodeHeader(header);
  assert.throws(() => decodeHeader(concatBytes(prefix, headerBytes)), /format version 99/);
});

test('a manifest survives encode and parse', () => {
  const parsed = parseManifest(encodeManifest(sampleManifest()));
  assert.equal(parsed.profileName, 'Meena');
  assert.equal(parsed.schemaUserVersion, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0]?.path, 'db/aarogya.db');
  assert.equal(parsed.skipped[0]?.reason, 'too_large');
});

test('a manifest whose frame table has a hole is refused', () => {
  // Frames are contiguous by construction; a gap means restore would read the wrong
  // bytes into the wrong file, which every MAC would then fail on anyway — but it must
  // be caught before a single byte is written to disk.
  const broken = sampleManifest({
    entries: [
      { kind: 'database', path: 'db/aarogya.db', bytes: 10, sha256: 'a'.repeat(64), firstFrame: 1, frameCount: 1 },
      { kind: 'media', path: 'files/x.jpg', bytes: 5, sha256: 'b'.repeat(64), firstFrame: 5, frameCount: 1 },
    ],
  });
  assert.throws(() => parseManifest(encodeManifest(broken)), /not contiguous/);
});

test('a manifest with no database, or two, is refused', () => {
  const none = sampleManifest({
    entries: [
      { kind: 'media', path: 'files/x.jpg', bytes: 5, sha256: 'b'.repeat(64), firstFrame: 1, frameCount: 1 },
    ],
  });
  assert.throws(() => parseManifest(encodeManifest(none)), /exactly one database/);
});

test('a manifest entry with a bad checksum field is refused', () => {
  const broken = sampleManifest({
    entries: [
      { kind: 'database', path: 'db/aarogya.db', bytes: 10, sha256: 'not-a-hash', firstFrame: 1, frameCount: 1 },
    ],
  });
  assert.throws(() => parseManifest(encodeManifest(broken)), /no usable checksum/);
});

test('a path that escapes the document directory is refused', () => {
  // Restore writes these paths to disk, and a capsule can arrive from anybody.
  for (const path of ['../secrets', 'files/../../etc/passwd', '/absolute', 'C:\\windows', 'files\\x']) {
    assert.equal(isSafeRelativePath(path), false, path);
  }
  for (const path of ['db/aarogya.db', 'files/labs/a.jpg', 'files/a..b/c.jpg']) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test('a manifest carrying a traversal path is refused at parse time', () => {
  const hostile = sampleManifest({
    entries: [
      { kind: 'database', path: '../../aarogya.db', bytes: 1, sha256: 'a'.repeat(64), firstFrame: 1, frameCount: 1 },
    ],
  });
  assert.throws(() => parseManifest(encodeManifest(hostile)), /Unsafe capsule path/);
});

test('frame counts are exact at and around a chunk boundary', () => {
  assert.equal(framesFor(0), 0);
  assert.equal(framesFor(1), 1);
  assert.equal(framesFor(CHUNK_BYTES), 1);
  assert.equal(framesFor(CHUNK_BYTES + 1), 2);
});

test('a capsule filename carries a sortable date, which is how the UI names the copy', () => {
  const name = capsuleFileName(new Date(2026, 7, 9, 14, 32).getTime());
  assert.match(name, /^aarogya-2026-08-09-1432\.aarogya$/);
});

test('a capsule filename round-trips back to the wall clock it was written with', () => {
  // The backup screen names every row and every confirmation ("delete the copy from
  // 9 August 2026, 14:32?") from this, so a drift between the writer and the reader
  // would put one date on the row and another in the dialog that deletes it.
  const name = capsuleFileName(new Date(2026, 7, 9, 14, 32).getTime());
  assert.deepEqual(capsuleStampFromName(name), { localDate: '2026-08-09', localTime: '14:32' });
});

test('midnight survives the round trip rather than becoming 24:00 or an empty hour', () => {
  const name = capsuleFileName(new Date(2026, 0, 1, 0, 0).getTime());
  assert.equal(name, 'aarogya-2026-01-01-0000.aarogya');
  assert.deepEqual(capsuleStampFromName(name), { localDate: '2026-01-01', localTime: '00:00' });
});

test('a name that is not one of ours claims nothing instead of guessing', () => {
  // A capsule copied back from a computer, or renamed, must fall back to showing the
  // filename. A half-parsed date is worse than no date: it is a confident wrong answer
  // on the screen where she chooses which copy to delete.
  for (const name of [
    'aarogya.db',
    'backup.aarogya',
    'aarogya-2026-08-09.aarogya',
    'aarogya-2026-08-09-1432.zip',
    'aarogya-2026-08-09-1432.aarogya.bak',
    'copy of aarogya-2026-08-09-1432.aarogya',
    '',
  ]) {
    assert.equal(capsuleStampFromName(name), null, name);
  }
});

test('digits that cannot be a date are refused, not rendered', () => {
  assert.equal(capsuleStampFromName('aarogya-2026-13-09-1432.aarogya'), null);
  assert.equal(capsuleStampFromName('aarogya-2026-00-09-1432.aarogya'), null);
  assert.equal(capsuleStampFromName('aarogya-2026-08-32-1432.aarogya'), null);
  assert.equal(capsuleStampFromName('aarogya-2026-08-09-2432.aarogya'), null);
  assert.equal(capsuleStampFromName('aarogya-2026-08-09-1460.aarogya'), null);
});

test('the newest-first filename sort agrees with the parsed stamps', () => {
  // `listCapsules()` sorts by NAME and the screen marks a row "Newest copy" from the
  // parsed stamp. If those two ever disagreed, the badge would sit on the wrong row.
  const names = [
    capsuleFileName(new Date(2026, 0, 9, 9, 5).getTime()),
    capsuleFileName(new Date(2026, 7, 9, 14, 32).getTime()),
    capsuleFileName(new Date(2025, 11, 31, 23, 59).getTime()),
  ];
  const byName = [...names].sort((a, b) => b.localeCompare(a));
  const stampKey = (name: string): string => {
    const stamp = capsuleStampFromName(name);
    assert.ok(stamp, `${name} did not parse`);
    return `${stamp.localDate} ${stamp.localTime}`;
  };
  const byStamp = [...names].sort((a, b) => stampKey(b).localeCompare(stampKey(a)));
  assert.deepEqual(byName, byStamp);
});

// ── a whole capsule, end to end ──────────────────────────────────────────────

test('a complete capsule — header, manifest, payload — reads back byte for byte', async () => {
  const random = fakeRandom(42);
  const salt = random(SALT_BYTES);
  const nonceBase = random(NONCE_BASE_BYTES);
  const key = await deriveCapsuleKey('KZ7Q-M4PD-XW29-B3NF-TR6H-J8QV', salt, TEST_KDF);

  const database = utf8Bytes('SQLite format 3\u0000 … the whole record …');
  const photo = utf8Bytes('JFIF … a prescription …');

  const manifest = sampleManifest({
    entries: [
      {
        kind: 'database',
        path: 'db/aarogya.db',
        bytes: database.length,
        sha256: sha256Hex(database),
        firstFrame: 1,
        frameCount: 1,
      },
      {
        kind: 'media',
        path: 'files/prescriptions/one.jpg',
        bytes: photo.length,
        sha256: sha256Hex(photo),
        firstFrame: 2,
        frameCount: 1,
      },
    ],
    skipped: [],
    totalPlaintextBytes: database.length + photo.length,
  });

  // ── write, exactly as capsule.ts does ──
  // The header states the KDF cost that was actually used, and the reader below derives
  // its key from what the header says rather than from a compiled-in constant. That is
  // what lets a future build raise the cost without orphaning today's capsules.
  const header = {
    ...defaultHeader(bytesToBase64(salt), bytesToBase64(nonceBase), 1_770_000_000_000),
    kdf: TEST_KDF,
  };
  const { prefix, headerBytes } = encodeHeader(header);
  const manifestBytes = encodeManifest(manifest);

  const capsule = concatBytes(
    prefix,
    headerBytes,
    frameBytes(seal(key, frameNonce(nonceBase, 0), manifestBytes, manifestAad(headerBytes))),
    frameBytes(seal(key, frameNonce(nonceBase, 1), database, chunkAad(headerBytes, manifestBytes, 1))),
    frameBytes(seal(key, frameNonce(nonceBase, 2), photo, chunkAad(headerBytes, manifestBytes, 2))),
  );

  // ── read, exactly as restore.ts does ──
  const decoded = decodeHeader(capsule);
  const openedKey = await deriveCapsuleKey('KZ7Q-M4PD-XW29-B3NF-TR6H-J8QV', base64ToBytes(decoded.header.salt), decoded.header.kdf);
  const openedNonceBase = base64ToBytes(decoded.header.nonceBase);

  let offset = decoded.bodyOffset;
  const manifestFrame = readFrameAt(capsule, offset, decoded.header.chunkBytes);
  offset = manifestFrame.next;

  const openedManifestBytes = open(
    openedKey,
    frameNonce(openedNonceBase, 0),
    manifestFrame.sealed,
    manifestAad(decoded.headerBytes),
  );
  assert.notEqual(openedManifestBytes, null);
  const openedManifest = parseManifest(openedManifestBytes as Uint8Array);
  assert.equal(openedManifest.entries.length, 2);

  const recovered: Uint8Array[] = [];
  for (const entry of openedManifest.entries) {
    const frame = readFrameAt(capsule, offset, decoded.header.chunkBytes);
    offset = frame.next;
    const plain = open(
      openedKey,
      frameNonce(openedNonceBase, entry.firstFrame),
      frame.sealed,
      chunkAad(decoded.headerBytes, openedManifestBytes as Uint8Array, entry.firstFrame),
    );
    assert.notEqual(plain, null, entry.path);
    assert.equal(sha256Hex(plain as Uint8Array), entry.sha256, `${entry.path} checksum`);
    recovered.push(plain as Uint8Array);
  }

  assert.equal(offset, capsule.length, 'the capsule has no unread trailer');
  assert.equal(bytesToUtf8(recovered[0] as Uint8Array), bytesToUtf8(database));
  assert.equal(bytesToUtf8(recovered[1] as Uint8Array), bytesToUtf8(photo));
});

test('a truncated capsule is caught rather than half-restored', async () => {
  const random = fakeRandom(43);
  const salt = random(SALT_BYTES);
  const nonceBase = random(NONCE_BASE_BYTES);
  const key = await deriveCapsuleKey('phrase', salt, TEST_KDF);

  const header = { ...defaultHeader(bytesToBase64(salt), bytesToBase64(nonceBase), 1), kdf: TEST_KDF };
  const { prefix, headerBytes } = encodeHeader(header);
  const manifestBytes = encodeManifest(sampleManifest());
  const full = concatBytes(
    prefix,
    headerBytes,
    frameBytes(seal(key, frameNonce(nonceBase, 0), manifestBytes, manifestAad(headerBytes))),
  );

  const cut = full.subarray(0, full.length - 8);
  const decoded = decodeHeader(cut);
  assert.throws(() => readFrameAt(cut, decoded.bodyOffset), /truncated/i);
});

// ── the recovery phrase ──────────────────────────────────────────────────────

test('a recovery phrase is the right length and reads back in groups', () => {
  const phrase = buildRecoveryPhrase(fakeRandom(99));
  assert.equal(normalisePhrase(phrase).length, PHRASE_LENGTH);
  assert.equal(phrase.split('-').length, 6);
  assert.equal(isWellFormedPhrase(phrase), true);
});

test('a phrase typed back without dashes, in lower case, still matches', () => {
  const phrase = buildRecoveryPhrase(fakeRandom(100));
  const mangled = phrase.toLowerCase().replace(/-/g, ' ');
  assert.equal(normalisePhrase(mangled), normalisePhrase(phrase));
  assert.equal(formatPhrase(mangled), phrase);
});

test('formatting a phrase is idempotent', () => {
  const phrase = buildRecoveryPhrase(fakeRandom(101));
  assert.equal(formatPhrase(formatPhrase(phrase)), phrase);
});

test('a mis-transcribed O or I is REFUSED, not silently repaired', () => {
  // The opposite of the invite token, on purpose: a phrase that is quietly "corrected"
  // into a different phrase fails as an unexplainable wrong-passphrase months later.
  assert.equal(isWellFormedPhrase('OOOO-OOOO-OOOO-OOOO-OOOO-OOOO'), false);
  assert.equal(isWellFormedPhrase('IIII-IIII-IIII-IIII-IIII-IIII'), false);
  assert.equal(isWellFormedPhrase('ABCD-EFGH'), false);
});

test('phrase generation rejects biased bytes instead of folding them in', () => {
  // 240..255 are outside the largest multiple of 30 below 256. A biased implementation
  // would map them onto the first symbols of the alphabet; this one must skip them and
  // ask for more bytes.
  let call = 0;
  const source = (count: number): Uint8Array => {
    call += 1;
    // First batch is entirely rejectable, so the loop MUST come back for more.
    if (call === 1) return new Uint8Array(count).fill(250);
    return new Uint8Array(count).fill(0);
  };
  const phrase = buildRecoveryPhrase(source);
  assert.ok(call >= 2, 'the rejected batch was not discarded');
  assert.equal(normalisePhrase(phrase), 'A'.repeat(PHRASE_LENGTH));
});
