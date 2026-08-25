# The capsule, and the shared link

Two features that share one property: **the plaintext never leaves the handset.** One of
them makes a file the user can survive losing her phone with. The other lets her son see
what she recorded, without a server ever being able to read it.

- **Code**: `src/features/backup/` (capsule, restore, nudge), `src/features/sync/` (link, share, snapshot, crypto, sealed, outbox, alerts, client, config).
- **Screens**: `src/app/backup.tsx`, `src/app/settings/viewers.tsx` (Sharing), `src/app/(viewer)/`.
- **Crypto**: XChaCha20-Poly1305 and scrypt from `@noble/*`. All pure JavaScript, all exercised by `node --test`.
- **Backend**: Supabase free tier, reached over plain `fetch`. Optional. The app is complete without it.

> **Read section 9 first if you read nothing else.** End-to-end encryption means there is
> no account recovery. Lost phone + no capsule = ciphertext nobody can ever decrypt,
> including us. A shared link is not a backup: it opens a snapshot, and the key that opens
> it lives on the same handset the record does.

---

## Part A — The encrypted capsule

### 1. Why it exists

Storage is local-only by design. There is no cloud copy of the record, no account, and
nothing on a server to restore from. That is the right privacy position for a health
record in India, and it has exactly one cost, which lands entirely on the user:

- A lost, stolen, drowned or factory-reset phone takes the entire history with it.
- Even the *planned* path can destroy it. The app upgrades in place only while the signing
  keystore survives. Lose the keystore and the only way to install the next build is to
  uninstall the current one — which wipes app storage.

The capsule is the answer to both, and it is only an answer if it is **one file the user
can put somewhere that is not this phone**.

### 2. What goes in, and why the media is not optional

| | |
| --- | --- |
| The database | `PRAGMA wal_checkpoint(TRUNCATE)` then **`VACUUM INTO`**. |
| The `files/` tree | Everything under the document directory except four excluded names. |

**Why `VACUUM INTO` and not a file copy.** The database runs in WAL mode. Copying
`aarogya.db`, `-wal` and `-shm` as three files can catch them mid-checkpoint, producing a
set that is individually intact and collectively inconsistent — a backup that opens fine
and is missing yesterday. `VACUUM INTO` is one statement producing one file SQLite
guarantees is consistent. `src/db/index.ts` already takes pre-migration snapshots this way.

**Why the media.** A database-only capsule restores to a schema full of `photo_uri`,
`image_uri`, `strip_photo_uri`, `report_uri` and `file_uri` strings pointing at files that
no longer exist. That is not a partial restore, it is a specific and severe one: the
prescription photograph is the only evidence of what the doctor actually wrote, which is
what the whole AI-review design depends on being able to fall back to; and the strip
photograph is what powers *"the white round one"* on the Medicines tab, which is how a
user who cannot read the pack identifies her own tablets.

**Why the tree is walked rather than read out of the database.** Reading the five URI
columns and copying exactly those files works, and quietly stops being complete the first
time somebody adds a sixth column — with the failure invisible until a restore, months
later, on a phone that no longer has the originals. `scanMediaFiles()` in
`src/features/backup/paths.ts` walks the document directory instead and excludes only:

| Excluded | Why |
| --- | --- |
| `backups/` | The capsules. Nesting one inside another doubles the file every time. |
| `dbsnapshots/` | Pre-migration copies, derived from a database that is already in here. |
| `SQLite/` | The live database and its WAL. Handled by `VACUUM INTO`, never byte-copied. |
| `aarogya-capsule-work/` | Half-written temporaries, by definition. |

The SQLite directory name is read from `SQLite.defaultDatabaseDirectory` rather than
hard-coded, because on Android it is `<filesDir>/SQLite` — *inside* the tree being walked.

### 3. File layout

```
  "AAROGYA1"                8 bytes    magic
  headerLength              4 bytes    uint32 big-endian
  header                    N bytes    canonical JSON, CLEARTEXT
  ┌ frame 0                            the manifest
  │   frameLength           4 bytes    uint32 big-endian
  │   sealed bytes                     ciphertext ‖ 16-byte Poly1305 tag
  ├ frame 1 … frame N                  the payload, in manifest entry order
  └ …
```

The header is in the clear because it **has** to be: it carries the salt and the KDF cost,
which are exactly what you need in order to try a passphrase. It is authenticated as
associated data on frame 0, so it can be read but not altered. Everything else — the
database, every photograph, the file inventory, even how many files there are — is inside
the sealed frames.

**Header** (`CapsuleHeader`):

```json
{
  "format": "aarogya.capsule",
  "v": 1,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "dkLen": 32 },
  "salt": "<base64, 32 bytes>",
  "nonceBase": "<base64, 16 bytes>",
  "chunkBytes": 262144,
  "createdAtEpoch": 1770000000000
}
```

**Manifest** (`CapsuleManifest`, frame 0):

```json
{
  "format": "aarogya.capsule.manifest",
  "v": 1,
  "createdAtEpoch": 1770000000000,
  "createdLocalDate": "2026-02-02",
  "appVersion": "0.1.0",
  "schemaUserVersion": 2,
  "profileId": "…", "profileName": "Meena",
  "documentRoot": "/data/user/0/in.aarogya.care/files",
  "entries": [
    { "kind": "database", "path": "db/aarogya.db",
      "bytes": 4194304, "sha256": "…", "firstFrame": 1, "frameCount": 16 },
    { "kind": "media", "path": "files/labs/8f2c….jpg",
      "bytes": 812345, "sha256": "…", "firstFrame": 17, "frameCount": 4 }
  ],
  "skipped": [ { "path": "files/labs/huge.jpg", "bytes": 99000000, "reason": "too_large" } ],
  "totalPlaintextBytes": 5006649
}
```

Frames are **contiguous and in entry order**; `parseManifest()` refuses a frame table with
a hole in it, refuses a capsule that does not contain exactly one database, and refuses
any path that is absolute, contains `..`, contains a backslash or contains a NUL —
because restore writes these paths to disk and a capsule can arrive from anybody.

### 4. The cryptography, and why each piece

| Choice | Instead of | Because |
| --- | --- | --- |
| `@noble/ciphers` (pure JS) | `react-native-quick-crypto` | Its own maintainers document AES-256-GCM coverage as incomplete. "Incomplete AEAD" in the one path that decides whether a health record can ever be read again is not worth a few hundred milliseconds. Pure JS also means the round trip is tested by CI, not only on a device somebody remembered to plug in. |
| XChaCha20-Poly1305 | AES-GCM | The 24-byte nonce. A capsule is hundreds of frames under one key; with a 96-bit nonce that is a birthday argument you have to think about, and with 192 bits a random base plus a counter is unarguable. ChaCha is also constant-time in pure JS. AES is not. |
| scrypt, N=2³⁵… *(2^15)*, r=8, p=1 | PBKDF2 | The attacker holds a stolen file and a GPU. scrypt's 32 MiB of memory-hardness is the only parameter that costs them more than it costs the phone. ≈1 s on a Go-class handset. |
| Manifest as associated data | Encrypt-then-list | A capsule whose payload MACs pass but whose header was swapped would restore the right bytes under the wrong description — wrong schema version, wrong profile, wrong inventory. |

**Associated data, exactly:**

```
frame 0   AAD = "aarogya.capsule.manifest.v1" ‖ SHA256(headerBytes)
frame i>0 AAD = "aarogya.capsule.chunk.v1"    ‖ SHA256(headerBytes)
                                              ‖ SHA256(manifestBytes)
                                              ‖ uint32BE(i)
```

The frame index is in there so two chunks cannot be swapped: without it, a capsule's
chunks could be reordered and every individual MAC would still verify.

**Nonces:** `nonce_i = nonceBase(16 random bytes) ‖ uint64BE(i)`. Unique by construction
for every frame under one key, and the key is unique per capsule because the salt is
random. No state to persist, nothing to get wrong on a resumed export.

**Reading side floors.** `MIN_ACCEPTED_N = 16384`. A capsule's header states its own KDF
cost, so a forged header could claim a cost of 2 and invite an offline attack that
finishes instantly. `MAX_ACCEPTED_N = 2^20` stops a hostile header asking the phone to
allocate gigabytes.

### 5. Size, memory and the caps

Frames exist because a one-shot `encrypt(wholeCapsule)` needs the whole capsule in memory
twice, plus a base64 copy to hand to the file API. On a 2 GB handset with a 200 MB record
that is not slow — it is an out-of-memory crash in the *export* path, so the user learns
her backup does not work at the moment she needs one.

| Constant | Value | Meaning |
| --- | --- | --- |
| `CHUNK_BYTES` | 256 KiB | Plaintext per frame. Peak residency stays under a megabyte; per-frame overhead (4-byte length + 16-byte tag) is under 0.01%. |
| `MAX_CAPSULE_BYTES` | 512 MiB | **Practical ceiling.** Not a format limit — a phone limit. Past this, writing takes long enough that Android may kill a backgrounded app mid-export, and a truncated file looks like a backup while being useless. Exceeding it is reported, never silently truncated. |
| `MAX_MEDIA_FILE_BYTES` | 48 MiB | One file above this is **skipped with a warning** and listed by name in `manifest.skipped`. A 100 MB video is not worth failing an entire backup over, and not worth pretending to have saved either. |

Export makes **two passes** over the files. The manifest carries a SHA-256 per file and is
sealed as frame 0, before any payload, so it must be complete before the first payload byte
is written. Hashing during the encrypting pass would mean either buffering everything
(impossible at this size) or putting the manifest at the end, where a truncated capsule
loses the very thing that would have told you it was truncated. Reading a few hundred
megabytes twice off flash costs a couple of seconds and buys a capsule that can prove what
is inside it before it starts unpacking.

The export yields to the event loop every 8 frames so the spinner keeps painting.

### 6. Restore, in the only safe order

Nothing destructive happens until everything non-destructive has already succeeded.

1. **MAC first.** Frame 0 is authenticated against the cleartext header. A wrong passphrase
   and a tampered header are both caught before a byte is written.
2. **Schema version next.** `manifest.schemaUserVersion > LATEST_VERSION` is **refused**.
   Running an old migration list over a newer schema is how you corrupt a database that was
   fine a moment ago.
3. **Unpack to staging** under `Paths.cache`. The live database is untouched. Every frame
   is verified; every file's SHA-256 is checked against the manifest.
4. **`PRAGMA integrity_check` and `PRAGMA foreign_key_check`** on the staged file.
5. **Rewrite every `*_uri` column** against this install's document directory. Android's
   per-install data directory changes on reinstall, so absolute URIs from the old install
   do not resolve here — without this step the restore "succeeds" and every prescription
   photograph is a broken image. The column list is **discovered** from `PRAGMA table_info`
   (any column matching `*_uri`), not hard-coded, so a seventh URI column added next year
   is handled on the day it ships.
6. **Swap.** The previous `aarogya.db`, `-wal` and `-shm` are moved aside into a rollback
   directory — not deleted. The staged database is copied in, the media is copied back,
   the database is reopened, and `integrity_check` runs again on the file that is now live.
   If any of that fails, the parked files go back.

The app-wide SQLite handle is closed and its module-level cache invalidated through
`__setDatabaseForTests(null)` before the swap. Without that, every repository in the app
would go on talking to a file that has just been moved out from under it.

**Typed failures.** `importCapsule` throws `RestoreError` carrying a `reason` the UI
switches on. `RESTORE_FAILURE_COPY` holds the English source string and the i18n key for
each. Every failure throws rather than resolving, because `src/app/backup.tsx` treats
resolution as success and a resolved failure there would tell the user her record had been
restored when it had not.

| `reason` | What the user is told |
| --- | --- |
| `not_a_capsule` | That file is not an Aarogya copy. |
| `wrong_passphrase` | That recovery phrase does not open this copy. |
| `no_passphrase` | This copy needs its phrase, and this phone has none saved. |
| `corrupt` | Damaged and cannot be opened. Nothing on this phone has changed. |
| `truncated` | Incomplete — it may not have finished transferring. |
| `newer_schema` | Made by a newer version of Aarogya. Update the app first. |
| `integrity_failed` | The record inside did not pass its checks, so it was not used. |
| `swap_failed` | Could not be put in place. The existing record was left as it was. |

Media that fails its checksum is **not** fatal: the file is left out, named in
`result.mediaMissing`, and `partialMedia` is set. One bad photograph does not cost a
database.

### 7. The recovery phrase

`src/app/backup.tsx` calls `exportCapsule(profileId)` with no passphrase, because asking a
62-year-old to invent and remember one on the spot produces either `1234` or an abandoned
backup. So the app generates a **recovery phrase** once:

- 24 characters from a 30-symbol alphabet — no `I`, `L`, `O`, `U`, `0` or `1` — grouped as
  `KZ7Q-M4PD-XW29-B3NF-TR6H-J8QV`. ≈117 bits. Sampled with rejection, so there is no
  modulo bias.
- Stored in `expo-secure-store` **for convenience**, and returned in `CapsuleExportResult.recoveryPhrase`
  so the UI can put it in front of the user. `recoveryPhraseIsNew` is true the first time,
  which is when to insist she writes it down rather than mention it in passing.
- Typed back in, case and dashes are ignored. A mis-transcribed `O` or `I` is **refused**,
  not silently repaired — quietly "correcting" it would turn a legible error into an
  inexplicable wrong-passphrase months later.
- A user-chosen passphrase is fully supported: pass one to `exportCapsule` and it is used
  verbatim, and nothing is stored.

**The keystore copy is a convenience, never the plan.** If the phone is gone, so is it.

### 8. The nudge

`evaluateNudge(state, now)` is pure and testable. It tracks two things separately, because
a capsule that never left the phone is not a backup — `backups/` lives in app storage,
which a factory reset, an uninstall and a dead handset all take with them.

| Level | Meaning |
| --- | --- |
| `never` | No capsule has ever been written. |
| `on_device_only` | A capsule exists and has never been shared off the phone. |
| `due` | ≥ 30 days since the newer of (written, shared). |
| `overdue` | ≥ 90 days. |
| `ok` | Nothing to say. |

`never` outranks everything and `on_device_only` outranks `due`, because a user who has
been diligently writing monthly capsules that never leave the handset has no backup at all
and needs to be told that, not congratulated on the date. Prompts are rate-limited to one
per 7 days; the **number** ("last copy: 47 days ago") is always safe to show, and a number
is a status where a banner is an interruption, and interruptions get trained away.

### 9. There is no account recovery

Stated plainly, because every other product in this category implies otherwise:

> **Lost phone + no capsule = the record is gone. Permanently.**
>
> There is no server-side copy. There is no password reset. There is no support address
> that can unlock anything. The share key exists only in that phone's keystore, and the
> capsule opens only with its passphrase. If both are gone, what remains is ciphertext that
> nobody — including whoever wrote this app — can decrypt.

This is the direct, unavoidable cost of the thing that makes the app safe to use: nobody
else can read the record either. It is not a bug to be fixed later; a "recovery" path that
worked without the user's own secret would, by definition, be a path an operator or an
attacker could also walk.

The three mitigations, in the order they matter:

1. **Write the recovery phrase down**, off the phone.
2. **Take a capsule off the phone monthly.** Section 8 is the whole reason that reminder exists.
3. **Share the link with somebody.** A phone holding the link can read the shared snapshot,
   which is a partial, read-only consolation and not a backup — it is today's picture, not
   the history, and rotating the link takes it away. Do not let it substitute for 1 and 2.

---

## Part B — The shared link

### 10. What changed, and why

The old model was an **invitation plus an approval**: a single-use 24-hour token, a viewer
device redeeming it, a pending row, and the patient tapping *Allow* before the family key
was wrapped to that device's public key. Access was per viewer and could be taken away one
viewer at a time.

The owner asked for something else, in these words:

> The view link will be publicly sharable and the user can rotate it from app if required
> to disable all old links related to his profile.

So there is now **one link per profile**. She sends it to whoever she likes, however she
likes. Whoever holds it can read the record. If it goes somewhere it should not, she
rotates — and every copy of the old link stops working at the same moment.

**This is a real trade and the app does not pretend otherwise.** What was lost: per-viewer
revocation, and the property that a leaked link was worthless on its own. What was gained:
a family member with no account, no app-store install and no setup ceremony can be shown a
record in one tap, and the patient can revoke universally without hunting through a list.
The Sharing screen states the consequence in the plainest sentence available — *anyone who
has this link can see your record; share it the way you would share a key to your house.*

**Why the invitation was never a phone number**, and still is not: Firebase Phone Auth
requires a billing card, and every SMS route in India requires TRAI DLT registration as a
principal entity, which requires a registered business with a PAN and usually a GST number.
A family health app built by one person cannot get there, and an unverified number typed
into a box is worse than nothing because it *looks* like identity. The app stores **no
phone number anywhere** and holds no CONTACTS permission.

### 11. The link

```
https://<host>/aarogya/v/<linkId>#k=<base64url 32-byte key>
                          ▲                 ▲
                          │                 └─ NEVER transmitted
                          └─ names the encrypted dataset on the server
```

**The key is in the fragment, and the fragment is never sent.** Everything after `#` is
stripped by every HTTP client before a request is made: it is not in the request line, not
in a header, not in `Referer`, and not in any server log. That single property is what
makes a public link safe to point at an end-to-end encrypted dataset — Supabase stores
ciphertext and an opaque id, and the key that opens it only ever exists on the two phones.

Three rules, repeated at every place in `src/features/sync/` that touches the key:

1. **Never logged.**
2. **Never in a query string or a path segment.**
3. **Never in a request body.**

`src/features/sync/sync.test.ts` asserts the property directly: it splits the URL at the
`#` and checks that the half a server would receive does not contain the key, and that
there is no query string to smuggle it into.

| | |
| --- | --- |
| `linkId` | 128 random bits, base64url, 22 characters. Opaque; says nothing about the family. |
| `k` | The 32-byte data key, base64url, 43 characters, fragment only. |
| Expiry | None. The link works until it is rotated. |
| Uses | Unlimited. |
| Grammar | `src/features/sync/link.ts` — pure, no storage, no network, tested. |

**The hostless code.** `extra.inviteHost` in `app.config.ts` is optional, and with no host
there is nothing to serve a web page. Rather than mint a link that can never resolve,
`shareLinkUrl()` returns **null** and the app falls back to `<linkId>#k=<key>` — the same
two values, pasted into the viewer's box. The whole feature works end to end with nothing
hosted anywhere; hosting only buys tappability.

**Parsing is deliberately host-agnostic.** The viewer's phone is a different install and
may never have been configured with a host at all, so refusing a link because its host is
not the one this build was compiled with would break the ordinary case. Nothing is trusted
on the strength of the host: the id names a dataset and the key either opens it or does
not.

### 12. Rotation

`rotateShareLink()` in `src/features/sync/share.ts`. **The order is the policy:**

1. **DELETE the old dataset** — every `sync_record` and the `sync_share` row for the old
   `link_id`. This happens *first*, so a failure anywhere later leaves the old rows gone,
   which is the safe direction.
2. **Rotate the key and the id together**, in one keystore write. They live in a single
   entry precisely so this is atomic: a crash can never leave a phone holding a new key
   that points at the old dataset.
3. **Re-encrypt and publish the snapshot** under the new id and the new key.
4. **Re-encrypt and publish the record stream** the same way, from the local database,
   which is the source of truth and still holds all of it (`republishRecords()`). This one
   runs **in the background, not awaited**: a family with six months of history is
   thousands of rows and minutes of round trips on a corridor connection, and rotation is
   what somebody does the moment a link has gone where it should not. Steps 1–3 are what
   the user is waiting for.

Both halves are replaced although either alone would be enough. Changing the id leaves the
old link pointing at nothing; changing the key leaves it pointing at rows it cannot open.
Doing both means a mistake in the delete — a row missed, an RLS policy that quietly allowed
it to survive — is not on its own sufficient to hand somebody the record back.

**When the phone is offline**, the delete cannot happen. Rotation still proceeds locally
and `RotateResult.oldDataRemoved` comes back false; the screen says so in an error-coloured
toast, because "the old link may still work until you are online" is exactly the sentence
somebody must not scroll past.

#### Turning sharing off is not rotation, and the confirm says so

*Turn sharing off* on the Sharing screen calls `disableSync()`, which writes
`sync.enabled = 0` and nothing else. It stops this phone **publishing**. It deletes
nothing, and it cannot: the delete needs a client, the client needs the config, and turning
off is what puts the config away. Anyone still holding the link goes on reading the last
published snapshot for as long as it sits in `sync_share`.

So the order matters, and the confirm gives it in the order it has to be done:

> To stop them seeing it at all, make a new link **first**: that clears away what was sent.

The project URL and the anon key are deliberately **kept** rather than cleared, so turning
sharing back on is one tap and not the whole setup again. Nothing recorded on the phone is
touched either way.

### 13. Threat model

The link **is** the credential. That is the design, not an oversight, and the honest table
looks like this:

| Attacker / event | What they get | Why |
| --- | --- | --- |
| Someone the patient sent the link to | The whole record, until rotation | This is the feature. Readings, medicines, symptoms, lab results. |
| Anyone the link is **forwarded** to | The same | The app cannot tell one holder from another. Rotation is the only answer, and it stops everybody. |
| WhatsApp chat backup on Google Drive (**not** end-to-end encrypted unless the user turned that on) | The link, therefore the record | Stated on the Sharing screen. This is the strongest argument for rotating after sharing widely. |
| A screenshot of the link, months later | The record, if it has not been rotated | There is no expiry. Rotation is the only clock. |
| Someone who guesses a link id | Nothing | 128 bits, and without the key an id opens ciphertext. |
| **The server operator, a breach, or a subpoena** | Ciphertext, row ids, lamport numbers, a link id, timestamps | The key was never uploaded. It rides in a fragment no HTTP client transmits. Payload lengths are padded to power-of-two buckets, so even "how much was written" does not leak. |
| Server modifying rows | Detected | `row_key` and `lamport` are associated data on every record; `link_id` is associated data on the snapshot. A payload cannot be moved onto another row, replayed under a different number, or copied into another family's dataset. |
| Someone who had the link before a rotation | Everything they already fetched | Stated in `REVOKE_DISCLOSURE`, verbatim, before the confirm. |

**What rotation does *not* do**, in the words the UI uses: it cannot undo what anyone has
already seen. Anything their phone already fetched, saved, took a picture of, or passed on
to somebody else stays with them. And it stops everybody at the same moment — every person
who was sent the old link loses it, so the new one has to be sent to all of them.

**What is deliberately not protected:** anyone holding the patient's unlocked phone. That
is out of scope for cryptography and is what the app-lock is for.

**The v2 family-sharing model (`sync_row`, roles, per-device key wrap) inherits the same
relay-trust boundary, and it must be stated plainly rather than implied by the role names.**

- **The relay enforces link-isolation only.** RLS filters every table on `link_id =
  request_share_id()` — a pure check on the shared `X-Share-Id` header, no per-device auth
  (the anon key is shared by design, the blind-postbox decision). So **Viewer read-only** and
  **Manager online-only** are honoured by cooperating clients, not by Supabase: any holder of
  the share id + anon key (every member, a Viewer included) *can* POST or DELETE this share's
  ciphertext rows via raw PostgREST. Confidentiality is real (it comes from the encryption);
  role *restriction* is a client-side contract.
- **Removing a member rotates the key, which revokes future READS, not relay ACCESS.** The
  removed device's old-generation key opens nothing written after the rotation — that is the
  guarantee. It does **not** lose the share id or anon key, so it retains the ability to write
  or delete this share's rows (a nuisance the owner's local DB republishes over, never a loss
  of the owner's own record). The UI must say "can no longer see changes," never "can no
  longer touch the data." Making roles/removal relay-enforced needs per-device Supabase auth
  or reader-verified writer signatures — a later round.
- **Authorship (`device_id`) is self-asserted.** Because the profile key is held by every
  member, a key-holder can seal a row stamping any `device_id` (the AAD binds it but cannot
  stop a holder *choosing* it). The owner's ring gate therefore trusts NO inbound
  confirmation stamp — any inbound medicine/schedule lands unconfirmed on the owner device
  (see `rowStream.ts`). Clinical attribution shown in the app is trusted-key-holder, not
  cryptographic, until per-writer signatures land.
- **`row_key = '<table>:<uuid>'` travels in the clear** (a reader must know which local table
  a decrypted payload belongs to). So the operator learns the *categories* present and their
  per-category row counts and cadence — how many `lab_result`/`symptom_event` rows, the tempo
  of the `dose_event` stream — without decrypting anything. Payload *lengths* are padded (§14)
  but the table prefix is not hidden; this is known, accepted metadata. Hiding it would mean
  addressing rows by an opaque per-share code instead of the table name.

### 14. Keys, and what the server stores

```
share key             32 random bytes, generated on the PATIENT's device, in the keystore,
   │                  stored in ONE entry alongside the linkId it belongs to
   ├─ record sealing  XChaCha20-Poly1305, AAD = "…record.v1" ‖ rowKey ‖ uint32BE(lamport)
   ├─ snapshot        XChaCha20-Poly1305, AAD = "…snapshot.v1" ‖ linkId
   └─ handed out      base64url, in the fragment of the link, and nowhere else
```

**There is no keyring and no per-device wrap any more.** The old design sealed the family
key to each viewer device's X25519 public key so one viewer could be removed without
disturbing the others, and devices kept eight generations so that a revocation did not cost
everybody else their history. A public link has no viewer list to remove anybody from, and
rotation re-encrypts the whole dataset, so a second generation would only ever be something
too old to open anything. `x25519.ts` and the wrap/unwrap functions were deleted rather
than left in place unused.

`generation` survives as a **rotation counter** carried on rows. It is not a key selector;
it is the cheapest way to tell from a server dump that a rotation happened.

**Why padding is not optional.** Ciphertext length is plaintext length plus a constant.
Without padding, an observer who only ever sees encrypted rows still learns: this row is a
symptom note with 300 characters of free text; this one is a bare reading; this profile
suddenly started writing much longer notes in March. That is a diary of somebody's illness
reconstructed from lengths alone.

### 15. Setting sharing up, and the Supabase schema

#### On the phone — what the person setting it up actually does

Sharing ships **off**, and until it is switched on `getSyncConfig()` returns null and every
sync path no-ops (§19). Switching it on is entirely in-app, on **Settings → Sharing**, and
that screen is the only place `setSyncConfig()` is called on the patient's side. There is
no build flag, no `.env`, and nothing to rebuild.

1. **Make the free project.** Settings → Sharing → *Open supabase.com* (the screen links to
   `https://supabase.com/dashboard`). Sign up, create a new project, any name. It is free —
   **no card, nothing to pay.** A free project gives 500 MB of Postgres and permits
   commercial use; the one catch is the 7-day inactivity pause, which the heartbeat below
   handles.
2. **Copy the two values.** In that project: **Project Settings → API**. Copy the
   **Project URL** (`https://<ref>.supabase.co`) and the key marked **`anon` `public`**.
3. **Paste them in.** Both boxes on the Sharing screen have a **Paste** button, and they
   are there because they are load-bearing: the anon key is a JWT a couple of hundred
   characters long, and a key that is 99% right fails exactly like one that is entirely
   wrong.
4. **Run the SQL below, once,** in that project's SQL editor. Skipping it is the one
   mistake that produces a *working-looking* setup: the link mints, the screen shows it,
   and everyone who opens it sees an empty page, because `sync_share` does not exist for
   the snapshot to be written into. The Sharing screen names this as step 4 for that
   reason.
5. **Test connection.** One real `GET {url}/rest/v1/`, and three answers that are
   deliberately never collapsed into "could not connect":

   | Answer | What happened | What to do |
   | --- | --- | --- |
   | **The connection works** | 2xx, and the reply was JSON | Turn sharing on |
   | **The project did not accept these** | 4xx, or a 2xx that was not JSON | Re-copy both values from Project Settings → API |
   | **Aarogya could not reach that project** | no reply, a timeout, 408/429/5xx | Turn mobile data or Wi-Fi on; the two values have **not** been judged wrong |

   `testSyncConnection()` in `src/features/sync/config.ts`. It probes the **PostgREST
   root**, not a table — a brand-new project has no `sync_record` yet, and probing one
   would answer 404 and send somebody off to re-copy two values that were correct. It also
   requires a JSON content type, because the most likely wrong URL is the dashboard address
   (`https://supabase.com/dashboard/...`), and a web page answers 200 with HTML.
6. **Turn sharing on.** A successful test is **not** required — this app is used on a
   metered and often absent connection, and somebody setting the phone up in a room with no
   signal must still be able to finish. The test is advice; the banner it leaves on screen
   is the warning.

**Every other phone in the family needs the same two values.** A link names a *dataset*,
not a *server*: `fetchSharedSnapshot()` reads `getSyncConfig()` for the project to talk to.
The viewer's side of this is the "Where to look for her record" box on
`src/app/(viewer)/link.tsx`, shown only while that phone has no project.

#### The schema

Run this once in the SQL editor of a new project. **Nothing here stores plaintext, and
nothing here can store the key.**

```sql
-- The capability the RLS policies filter on: 128 random bits naming ONE dataset, sent as
-- an X-Share-Id header by src/features/sync/client.ts. Row isolation and anti-enumeration
-- — NOT the confidentiality boundary. The encryption is that, and its key never arrives.
create or replace function public.request_share_id() returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-share-id', '')
$$;

-- ── The record stream ──────────────────────────────────────────────────────
create table public.sync_record (
  link_id          text   not null,
  row_key          text   not null,          -- '<table>:<uuid>'
  lamport          bigint not null,
  op               text   not null check (op in ('upsert','delete')),
  payload          text   not null,          -- base64: nonce ‖ ciphertext ‖ tag
  key_generation   int    not null default 1,
  updated_at_epoch bigint not null,
  primary key (link_id, row_key)
);
create index sync_record_stream on public.sync_record (link_id, lamport);

-- ── What a link actually opens ─────────────────────────────────────────────
-- One row per dataset: the whole viewer dashboard, sealed as a single blob.
create table public.sync_share (
  link_id          text primary key,
  payload          text   not null,          -- base64: nonce ‖ ciphertext ‖ tag
  key_generation   int    not null default 1,
  updated_at_epoch bigint not null
);
```

#### Row-level security

```sql
alter table public.sync_record enable row level security;
alter table public.sync_share  enable row level security;

create policy record_share on public.sync_record for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

create policy share_share on public.sync_share for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());
```

There is no `SECURITY DEFINER` function any more, and no RPC: redemption, attempt counting
and approval all belonged to the invite model and are gone with it. The client speaks
plain PostgREST — select, upsert, delete.

> **Note that a holder of a link id can also WRITE to that dataset.** RLS grants the whole
> row to whoever presents the id, and separating read from write would need a second
> secret, which the link format has no room for. It is not a confidentiality problem — a
> writer without the key can only produce blobs that fail to open, which the viewer treats
> as "this link shows nothing" — but it does mean a leaked link permits vandalism as well
> as reading. If that matters, the fix is a `select`-only policy for `anon` plus a signed
> write path; it is listed here rather than pretended away.

#### The heartbeat

A free project pauses after **7 days without database activity**, and a paused project
means a family stops receiving updates with no error anybody sees.

```sql
create extension if not exists pg_cron;

select cron.schedule(
  'aarogya-heartbeat',
  '17 3 * * *',                                    -- daily, off the hour
  $$ select count(*) from public.sync_record $$
);
```

`SyncClient.heartbeat()` does the same thing from the app side — one row, one column, no
filter to plan.

#### Retention

Nothing here prunes itself. Superseded `sync_record` rows grow forever, and 500 MB is not
infinite. Rotation is the only thing that currently deletes anything, and it deletes
everything for the old id. Add a monthly `cron.schedule` once the shape of real usage is
known.

### 16. `assetlinks.json`, and the manifest

Emitted by `assetLinksJson(fingerprints, packageName)` in `src/features/sync/share.ts`
rather than committed, because the fingerprint belongs to the signing keystore, which is
not in this repository and must not be.

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "in.aarogya.care",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
      ]
    }
  }
]
```

Get the fingerprint with:

```bash
keytool -list -v -keystore <release.keystore> -alias <alias> | grep 'SHA256:'
```

> ### ⚠ Two pieces of setup are outstanding, and both live outside `src/features/sync/`
>
> 1. **`app.config.ts` still declares `pathPrefix: '/aarogya/i'`** — the old invite path.
>    Until it is changed to **`/aarogya/v`**, a tapped share link will not open the app: it
>    will open a web page (or 404). Nothing reports this mismatch; Android simply does not
>    claim the link.
> 2. **There is no route that catches `/aarogya/v/<id>`.** Even with the manifest fixed,
>    expo-router has nothing mapped to that path, so a verified link would land on
>    `+not-found`. A screen at `src/app/aarogya/v/[id].tsx` that reads the URL (fragment
>    included) and hands it to `acceptViewerLink()` is the missing piece.
>
> **Neither is required for the feature to work.** The paste path in
> `src/app/(viewer)/link.tsx` accepts a full URL or the bare code, and is the primary path
> by design. These two items only buy tappability.

Checklist for hosting, in the order these actually go wrong:

1. **Host it at the SITE root**: `https://<user>.github.io/.well-known/assetlinks.json`,
   **not** under `/aarogya/`. This is the single most common reason `autoVerify` silently
   fails, and it fails with no error anywhere.
2. Served over HTTPS with no redirect, as `application/json`.
3. `package_name` must match `android.package` in `app.config.ts` (`in.aarogya.care`).
4. With Play App Signing, add **Play's** upload and signing certificate fingerprints too.
5. The intent filter's `host` and `pathPrefix` must agree with the configured host and
   `SHARE_PATH_PREFIX` in `src/features/sync/link.ts`.
6. Verify with `adb shell pm get-app-links in.aarogya.care` — look for `verified`.
7. GitHub Pages will 404 on `/aarogya/v/<id>` because that segment is not a real file. Ship
   a `404.html` that explains what the link is and where to get the app; that page is what
   a family member without the app installed will see, and it should read like an
   explanation rather than an error. **It must not touch the fragment** — it never receives
   it, and any script that tries to forward it is a script that leaks the key.

### 17. What the viewer actually reads

**One sealed snapshot, not a replay.** `src/features/sync/snapshot.ts` builds exactly what
the viewer dashboard renders — today's readings, today's doses, the medicines being taken,
recent lab results, and any alerts — and seals it as a single blob in `sync_share`. The
viewer fetches one row, opens it with the key from the fragment, and renders it **in
memory**. Nothing is written to the viewer's database: not a reading, not a dose, not a
medicine.

Three things fall out of that: one blob has one length, so the padding argument applies to
the whole dataset at once; the viewer needs no schema knowledge and no occurrence
generator; and rotation is cheap.

**Dose statuses are not baked in.** Doses ship as a scheduled time plus the events recorded
against them, and `deriveStatus()` runs on the viewer's own clock — so a snapshot published
at 08:00 still reads correctly at 14:00 instead of showing a frozen "Due". It still never
says "missed": that wording does not exist in `OCCURRENCE_STATUS_COPY`, and
`scripts/check-clinical-language.js` fails the build if it appears anywhere user-facing.

**No photographs.** Strip photos are `file://` paths on the patient's handset. They would
be broken images on anybody else's phone and they describe her storage layout, so the
snapshot does not carry them.

**Targets travel unresolved.** The snapshot ships every `target_range` row and the viewer
calls the same `matchTarget()` the patient's own screens use, so the two can never disagree
about which target applies to a reading. A range is only ever shown against a target a
named human entered, with that name and date under it.

**The record stream is still there** and still pushed by the outbox. It is the durable
copy and the basis of any future full-history viewer; nothing reads it today. A reader is
one line: `openJson(key, blob, recordAad(rowKey, lamport))`.

**The viewer's phone needs the project settings.** The link names a dataset, not a server.
`src/app/(viewer)/link.tsx` therefore shows the project URL and public anon key fields —
and only while that phone has no project configured. Putting the project reference in the
link itself would be an alternative; it would also make the link longer and tie every link
to one backend forever.

### 18. Outbox and alerts

**Outbox — one writer, therefore no conflict resolution.**

> The patient's device is the only writer. Viewers are read-only, by design.

That assumption is what removes vector clocks, last-write-wins arbitration and merge rules
from `src/features/sync/outbox.ts` entirely: one writer means the lamport counter is a
total order and replaying it reproduces the patient's state exactly. The reason is clinical
rather than technical — a son tapping "taken" from his office produces a row
indistinguishable from one his mother entered, and six months later a doctor reads a run of
confirmed doses that nobody can separate into observed and assumed. `src/app/(viewer)/`
therefore has no write control on it at all.

**If viewer writes are ever added, `outbox.ts` is wrong and must be rewritten first** — a
per-device id in the lamport tuple, a deterministic tie-break, a merge rule per table, and
a decision about what a viewer's write *means* on a report. None of that exists today.

Drain: 50 rows per batch, ordered by lamport, backoff doubling from 30 s to an hour, and a
12-attempt cap so one permanently-rejected row cannot wedge the queue behind it forever
(the local record is still the truth; nothing is lost).

**Alerts — two consecutive doses, any medicine.**

Not "critical medicines only". Criticality answers *how bad is missing this one*; it does
not answer the question a family actually cares about, which is *has something happened*.
Restricting the alert to the critical tier would mean a woman on three ordinary tablets
could go dark for a week without anyone hearing. One dose is noise — a phone face-down, a
nap, an alarm Doze swallowed. Two in a row is a pattern. A 90-minute grace period applies,
and any dose event at all (including `delivered` and `dismissed`) breaks the run: the
question is whether the phone is being used, not whether the tablet was swallowed.

> **A public link cannot deliver a push, and the module says so.** There is no viewer list
> any more — no account, no device registration, no phone number — so there is nothing to
> address a notification to. The feature was not dropped; it was rebuilt around what this
> model can honestly do.

What replaces the push, in order of what actually reaches a person:

1. **The WhatsApp draft**, which is the active path. `composeWhatsAppMessage()` +
   `whatsAppShareUrl()` put a message one tap away through the share sheet and the app
   **never sends it**. This is the only mechanism here that can reach somebody who is not
   already looking at their phone. The draft names no medicine, no condition and no number,
   and there is no recipient in the URL — WhatsApp's own contact picker is the consent
   surface, and the app never learns who it went to.
2. **The alert on the shared view.** `recordQuietDoseAlert()` writes the alert into
   `app_meta` on the patient's phone, capped at five and expiring after a week, and it
   rides in the next snapshot so it is the first thing at the top of the shared view the
   next time anybody opens the link. Passive, but it costs nothing.

The alert row carries a count and a time and **nothing else** — no medicine name, no
condition. The snapshot is encrypted, but this is the line most likely to be read over
somebody's shoulder.

**`REVOKE_DISCLOSURE`** is exported from `src/features/sync/share.ts` for the confirmation
dialog, and **the UI is required to show it**. It is on the Sharing screen as body text as
well as in the confirm, because somebody deciding whether to tap should be able to read it
without tapping:

> A new link works from now on. It cannot undo what anyone has already seen. Anything their
> phone already fetched, saved, took a picture of, or passed on to somebody else stays with
> them. And it stops everybody at the same moment — every person you sent the old link to
> will lose it, so you will have to send them the new one.

Every product in this space implies otherwise, because "Remove" reads like "undo". It is
not undo, and a woman rotating her link after a family argument deserves to know she will
have to re-send it to her daughter *before* she taps rather than afterwards.

### 19. Sharing is optional, and silence is the correct behaviour

L1 and L2 ship long before any of this. `getSyncConfig()` returning null is the **normal**
case, not an error case.

- Every **background** path — `drainOutbox`, `publishSnapshot`, `recordQuietDoseAlert`,
  `heartbeat`, `republishRecords` — returns quietly. No throw, no error log, nothing on
  screen.
- Every **user-initiated** path — `ensureShareLink`, `rotateShareLink` — throws a clear
  message, because somebody just pressed a button and is owed an answer.

A sharing feature that complains on a phone that never asked for it is a bug.

The project URL must be `https://`. The anon key is a public value by Supabase's design —
it identifies the project and nothing else — which is why it lives in `app_meta` rather
than the keystore. The share key, which is the one that matters, lives in
`expo-secure-store` and leaves the phone only inside a link the patient chose to send.

Both values are entered on **Settings → Sharing** and nowhere else on the patient's side;
the steps, the connection test and its three answers are in §15. "Not configured" is a
state the user can leave — a screen that explains the feature is missing and offers no way
to add it is the same as the feature not existing, which is what that screen used to be.

---

## 20. File map

| File | What lives there |
| --- | --- |
| `src/features/backup/bytes.ts` | base64/UTF-8/hex codecs, canonical JSON. Pure; shared with `sync`. |
| `src/features/backup/crypto.ts` | scrypt KDF, XChaCha20-Poly1305 seal/open, AAD construction, streamed SHA-256. Pure. |
| `src/features/backup/format.ts` | Container framing, header and manifest types, validation, path-traversal guard. Pure. |
| `src/features/backup/phrase.ts` | Recovery-phrase alphabet and normalisation. Pure. |
| `src/features/backup/passphrase.ts` | Keystore custody of the phrase. |
| `src/features/backup/paths.ts` | Media discovery, exclusions, directories. |
| `src/features/backup/capsule.ts` | `exportCapsule()`. |
| `src/features/backup/restore.ts` | `importCapsule()`, staging, verification, URI repointing, swap and rollback. |
| `src/features/backup/nudge.ts` | `evaluateNudge()` and the `app_meta` bookkeeping. |
| `src/features/sync/link.ts` | The link grammar, base64url, the host, and the fragment rule. Pure. |
| `src/features/sync/sealed.ts` | Padding buckets, record and snapshot sealing. Pure. |
| `src/features/sync/crypto.ts` | Keystore custody of the share key and its link id. |
| `src/features/sync/share.ts` | `ensureShareLink()`, `rotateShareLink()`, `REVOKE_DISCLOSURE`, the viewer's saved link, `assetLinksJson()`. |
| `src/features/sync/snapshot.ts` | What a link opens: build, publish, fetch, and the local alert list. |
| `src/features/sync/config.ts` | Settings, `testSyncConnection()`, and the "not configured" state everything checks. |
| `src/features/sync/client.ts` | Supabase REST over `fetch`. No SDK. |
| `src/features/sync/outbox.ts` | The drain, `republishRecords()`, and the single-writer assumption written down. |
| `src/features/sync/alerts.ts` | `evaluateSilence()`, the local alert, the WhatsApp fallback, and why there is no push. |
| `src/features/backup/capsule.test.ts` | Crypto round trip, AAD binding, manifest, traversal, whole-capsule read-back. |
| `src/features/sync/sync.test.ts` | Padding, record sealing, snapshot binding, the fragment rule, link parsing. |

`@supabase/supabase-js` is deliberately **not** a dependency. It is a realtime client, an
auth client, a storage client and a Postgrest client in one package, and this app uses a
fraction of one of them — on a project whose APK budget is a policy decision (arm64-only,
R8, single ABI) because the target handset has 2 GB of RAM and a metered connection.
PostgREST is a plain HTTP API and `fetch` speaks it in about 200 lines.
