# Family sharing — the build contract (P1 + P2)

**Status: contract, not built.** This is the single source of truth the build agents
implement against. It is the buildable form of the LOCKED DECISIONS in
`docs/MULTI-DEVICE-SYNC-DESIGN.md` (owner's calls, 2026-08-24). Where this doc and the
pre-locked "five decisions" framing in that file disagree, the LOCKED DECISIONS win and
this doc follows them.

This system is tightly coupled — crypto ↔ sync ↔ RLS ↔ UI — so **divergence here is the
main failure mode**. If you are about to implement a piece and this doc is silent or wrong,
stop and fix the doc first; do not invent a second answer in code.

It EXTENDS `src/features/sync/**` and the baseline `supabase/schema.sql`. It does not
replace them. Read `crypto.ts`, `sealed.ts`, `link.ts`, `share.ts`, `client.ts`,
`outbox.ts`, `snapshot.ts`, `config.ts` and the baseline schema before writing anything.

---

## 0. What is true today, and the one invariant this breaks

Today the app is **single-writer**: the patient device is the only writer; `config.ts` has
two roles (`patient`, `viewer`); a viewer pulls one sealed **snapshot** (`sync_share`) and
renders it read-only; `outbox.ts` has no conflict resolution *because nothing else writes*;
and the record stream (`sync_record`) is **written but never read** — "the viewer renders
only the sealed snapshot" (CLAUDE.md). The key is one symmetric key per *phone*, carried in
a link **fragment**.

v2 turns every member device into a writer of one **profile**. That forces four things the
old design never had, and each is a section below:

1. a **per-profile key WRAPPED to each member device** (not carried in a link fragment) — §2
2. a **merge rule** for concurrent edits — §3
3. **roles** and an **invite → request → approve → key-wrap** handshake — §4
4. a **ring-owner** rule and a **push** path so a dose does not alarm on four phones — §5

The data model was already built for this: `dose_event` is append-only truth,
`medicine`/`dose_schedule` are versioned on a `thread_id`, and the caches
(`dose_occurrence.status`, streaks) are derived and rebuildable. That is exactly the shape
that merges without a central server.

### The hard constraints this contract keeps (from the task brief)

- **C1** `expo-notifications` stays BANNED (a second scheduler fires a dose twice or not at
  all). The push **SEND** side is built this round (a plain `fetch`). The push **RECEIVE**
  side is a *decision*, recommended in §5, **not built** this round.
- **C2** A remote edit must not silently change what the owner phone RINGS. Manager edits to
  a **medicine or a dose_schedule** do not arm on the owner until the owner accepts them,
  via the existing `confirmed_by_user_at` gate and the `trg_occ_requires_confirmed_*`
  triggers, **which stay intact**. A remote device can never silence a live ring.
- **C3** The device horizon (`deviceHorizon.ts`, R1) and the per-day override (Materializer
  exceptions / `override.ts`, R2) keep working. A non-owner device schedules **no** alarms
  for a profile it does not own.
- **C4** The Supabase URL/key are NEVER hardcoded (pasted into Settings, `config.ts`). No
  secret in the repo or bundle. **The profile key never reaches Supabase.**

---

## 1. The unit of sharing is the PROFILE

- A **profile** (mother, grandmother) has a stable **share id** (`profile.share_id`, already
  reserved by migration v7) and its own **profile key** (symmetric, 256-bit).
- A **membership set** is per profile: exactly one **Owner** (the creator's device) + N
  **Managers** + N **Viewers**. Your phone can be Owner of mother's profile and a Manager of
  grandmother's *at the same time*: a role is a property of `(profile, device)`, not of the
  device (`profile.owner_device_id`, already reserved by v7).
- Two profiles on one phone are two independent shares that happen to live in one app. Every
  profile-scoped table already carries `profile_id`, so no per-feature schema change.

The v7 migration already added `profile.share_id`, `profile.owner_device_id`, the partial
unique index on `share_id`, and the **empty** local `profile_member` table with exactly the
columns v2 needs (`share_id, device_id, public_key, device_label, role, added_at_epoch,
removed_at_epoch`). **v2 needs no new *local* migration for those shapes** — it populates
them. (If v2 needs any new local column, it is migration **v8**, append-only, one author —
but design to avoid it.)

---

## 2. Crypto (the crown jewel)

> A bug here leaks a TB diagnosis or makes data unrecoverable. **Reuse `@noble/*`. Never
> invent crypto.** Every function below fails SOFT on the read path (returns `null`) and
> only throws on an explicit user action that can be told it failed.

### 2.0 Primitives — name them exactly

| Purpose | Primitive | Package | Status |
|---|---|---|---|
| Record/snapshot AEAD | `xchacha20poly1305` | `@noble/ciphers/chacha.js` | already a dep, already used in `sealed.ts` |
| Key-wrap KDF | `hkdf` + `sha256` | `@noble/hashes/hkdf.js`, `@noble/hashes/sha2.js` | already a dep |
| Device keypair + ECDH | `x25519` (`getPublicKey`, `getSharedSecret`, `utils.randomSecretKey`) | **`@noble/curves/ed25519.js`** | **ONE new dependency — see flag F1** |
| CSPRNG | `Crypto.getRandomBytes` | `expo-crypto` | already a dep |
| Private key storage | `SecureStore` (`AFTER_FIRST_UNLOCK`) | `expo-secure-store` | already a dep |

Byte helpers already exist in `src/features/backup/bytes.ts`: `bytesToBase64`,
`base64ToBytes`, `concatBytes`, `u32`, `readU32`, `u64`, `utf8Bytes`, `bytesToUtf8`. Use
them; do not re-implement.

> **FLAG F1 — one new dependency.** `@noble/curves` is not currently installed (the old
> `x25519.ts` wrap module was *deleted* when the design moved to a public-link key — see
> `docs/SYNC-AND-BACKUP.md`). Wrapping a key **to a device's public key** is inherently
> asymmetric and there is no X25519 in Hermes/stdlib, so this dep is unavoidable. It is the
> same vendor family already trusted (`@noble/ciphers`, `@noble/hashes`), tiny (tens of KB —
> the APK has 3.61 MB of headroom), and audited. Add it, add a line to `docs/SIZE.md`, and
> confirm the exact v2 subpath at install (`@noble/curves/ed25519.js` exports `x25519` in
> 2.x). **Do not** reach for `tweetnacl`/`libsodium` — a second crypto vendor is the thing
> to avoid.

### 2.1 Device keypair — new file `src/features/sync/deviceKey.ts`

Long-lived per handset. The private key is minted on the device, lives in
`expo-secure-store` under `aarogya_sync_device_key`, and **never leaves the phone** — not in
a link, not in a request, not in a log.

```ts
export type DeviceKeyPair = { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array };

/** Loads the keypair, minting it on first use. secretKey never leaves this module + the store. */
export async function getOrCreateDeviceKeyPair(): Promise<DeviceKeyPair>;
/** The public half, base64, safe to publish (join request, `member:` rows). */
export async function getDevicePublicKeyB64(): Promise<string>;
/** Wipes the keypair. Sign-out / "forget this device". */
export async function forgetDeviceKeyPair(): Promise<void>;
```

Mint with `x25519.utils.randomSecretKey()` then `x25519.getPublicKey(sk)`. The `device_id`
that pairs with this key is the existing `sync.deviceId` in `config.ts` (a minted UUID, not
a hardware id — keep it that way, the reason is in `config.ts`).

### 2.2 Profile key — new file `src/features/sync/profileKey.ts`

One symmetric key per profile, plus a `generation` counter (how many times the profile's key
has rotated). It replaces the single global share key in `crypto.ts` for shared profiles.
Held only by devices that have been granted it (owner always; managers/viewers after
approval). In `expo-secure-store` under `aarogya_profile_key_<shareId>`.

```ts
export type ProfileKeyState = { readonly key: Uint8Array; readonly generation: number };

/** 32 random bytes. Owner-only; reuses mintShareKey(random) from ./link. */
export function mintProfileKey(random: RandomSource): Uint8Array;

export async function getProfileKey(shareId: string): Promise<ProfileKeyState | null>;
/** Owner mints on first share; members store the unwrapped key on accept. */
export async function setProfileKey(shareId: string, key: Uint8Array, generation: number): Promise<void>;
/** Owner-only: new key, generation+1, in one store write (atomic, like rotateShareKey). */
export async function rotateProfileKey(shareId: string): Promise<ProfileKeyState>;
export async function forgetProfileKey(shareId: string): Promise<void>;
```

Storing `{key, generation}` together is what makes rotation atomic — a crash can never leave
a phone holding a new key that points at the old generation (the least debuggable failure
this feature could have; the same reasoning `crypto.ts` already states for the link pair).

### 2.3 Key wrap — new file `src/features/sync/keywrap.ts`

An **anonymous X25519 sealed-box** (the libsodium `crypto_box_seal` construction, rebuilt on
noble). Used twice: to wrap the profile key to a member device (`sync_key_wrap.wrap`), and to
seal a device label to the owner's key in a join request (`sync_join_request.label_wrap`). ONE
primitive, two callers.

```ts
/** Seal arbitrary bytes so ONLY the holder of recipientPub's private key can open them. */
export function sealAnon(
  recipientPub: Uint8Array,
  plaintext: Uint8Array,
  random: RandomSource,
): Uint8Array; // returns ephPub(32) ‖ nonce(24) ‖ ciphertext ‖ tag(16)

/** Null on any failure — wrong key, tampered blob, truncated blob are all "no". */
export function openAnon(recipientSecret: Uint8Array, blob: Uint8Array): Uint8Array | null;

/** The profile-key case. Thin wrappers so callers read intent, not crypto. */
export function wrapProfileKey(profileKey: Uint8Array, recipientPub: Uint8Array, random: RandomSource): Uint8Array;
export function unwrapProfileKey(blob: Uint8Array, recipientSecret: Uint8Array): Uint8Array | null; // must assert length === SHARE_KEY_BYTES
```

**The construction, exactly** (do not deviate — a home-grown variation is inventing crypto):

- **seal:** ephemeral keypair `(e, E) = x25519.randomSecretKey()/getPublicKey`; shared
  secret `s = x25519.getSharedSecret(e, recipientPub)`; wrap key
  `wk = hkdf(sha256, s, /*salt*/ undefined, /*info*/ "aarogya.sync.keywrap.v1" ‖ E ‖ recipientPub, 32)`;
  `nonce = random(24)`; body = `xchacha20poly1305(wk, nonce, /*aad*/ E ‖ recipientPub).encrypt(plaintext)`;
  output `concatBytes(E, nonce, body)`.
- **open:** read `E` (first 32 bytes) and `nonce` (next 24); `s = x25519.getSharedSecret(recipientSecret, E)`;
  same `wk`; `xchacha20poly1305(wk, nonce, E ‖ recipientPub).decrypt(body)`; return, or `null` on throw.

This is a **pure** module (randomness injected), so `node --test` loads it directly. It ships
with `keywrap.test.ts`: round-trip; a wrong recipient key returns `null`; a flipped byte
returns `null`; the profile-key length is asserted on unwrap.

### 2.4 The millisecond timestamp — the LWW source

Per LOCKED: LWW is by **millisecond modified-time**, NOT lamport. The source is `Date.now()`
on the writing device, already stamped as every syncable row's `updated_at_epoch` by the
repository layer (`_shared.ts`). v2 carries **that** value (the human-edit time) into
`sync_row.modified_at_ms`. Define one helper and use it nowhere else as a clock:

```ts
export const nowMs = (): number => Date.now();
```

> **FLAG F2 — LOCKED forces wall-clock LWW.** This trusts device clocks. A phone with a
> badly-wrong clock can win or lose a merge it should not. Accepted at this scale by the
> owner, and the "managers write only while online" rule (§3.3) keeps concurrent offline
> edits rare. **Ties on the exact same millisecond break on `device_id` (lexically higher
> wins)** — arbitrary but total, so every device converges. This mirrors design §2's
> tie-break, restated for ms instead of lamport.

---

## 3. The sync protocol (multi-writer)

### 3.1 Sealing a row

A row is sealed exactly as today (`sealJson` in `sealed.ts`, XChaCha20-Poly1305 under the
**profile key**), but the v2 stream binds a **new AAD** so the relay cannot tamper with the
plaintext ordering columns it can see:

```ts
// New, alongside recordAad(). Do NOT change recordAad — the baseline sync_record stream
// still uses it. rowAad binds the columns the relay stores in the clear for sync_row.
export function rowAad(rowKey: string, modifiedAtMs: number, deviceId: string, keyGeneration: number): Uint8Array;
//   = concat(utf8("aarogya.sync.row.v1"), utf8(rowKey), u64(modifiedAtMs), utf8(deviceId), u32(keyGeneration))
```

`lamport` is **retired from the v2 stream** (replaced by `modified_at_ms`). Local rows keep
their `lamport` column — harmless, still used by the legacy `sync_record` path and by the
outbox's within-device ordering.

### 3.2 The multi-writer merge

Per **(table, row)**, **last-write-wins by `(modified_at_ms, device_id)`**, enforced in
**two** places — and both must use the identical comparator, or two devices disagree on the
winner:

1. **On the relay** — the `trg_sync_row_lww` trigger (schema v2) drops any upsert whose
   incoming `(modified_at_ms, device_id)` is not strictly greater than the stored row. This
   is why `sync_row`'s PK is `(link_id, row_key)` with a single winner, not a per-device row:
   LOCKED makes the relay responsible for "millisecond-timestamp ordering", so the relay
   holds the winner and the puller does not have to merge N per-device copies.
2. **On the puller** — when applying a pulled row, a device compares the incoming
   `(modified_at_ms, device_id)` against its own local row and **only overwrites if strictly
   newer**. Needed because a device can hold a locally-newer edit than the relay's winner at
   pull time.

Merge, **by data shape** (unchanged intent from design §2 / LOCKED, restated for ms):

| Data | Merge | Why it is safe |
|---|---|---|
| `dose_event` | **union** | Ids are deterministic and DISTINCT per real event, so two devices marking the *same* occurrence taken write the *same* `row_key` (idempotent dedupe) and two *different* events write *different* `row_key`s (both survive). `deriveStatus` unions all events for an occurrence. LWW never drops a real "taken". |
| `medicine` / `dose_schedule` | **LWW on the latest version** | Append-only versioned on `thread_id`; an edit is a new-row INSERT, so "newest ms wins" picks the most recent human decision. **But see C2 (§3.4): a manager's version does not ARM on the owner until confirmed.** |
| `reading`, `symptom_event`, `lab_result`, `care_event`, `visit_log`, `document`, notes | **LWW per row** | Independent rows; two people rarely touch the same one; the later ms wins. Documents ride E2E — §3.5. |
| `dose_occurrence.status`, `streak_state`, badges | **not synced — rebuilt** | Derived caches; each device recomputes from the merged events. (`dose_occurrence.sync=false`, `streak_state.sync=false` already.) |

The **owner publishes** by draining its outbox into `sync_row` (each pushed row carries
`device_id`, `modified_at_ms = row.updated_at_epoch`, `key_generation`; **never
`written_at_epoch` — the relay stamps that itself** in the LWW trigger, because it is the
relay's arrival clock and a client value would stall pulls on updates). The relay trigger
keeps the winner. **Members pull** `sync_row where link_id = ? and written_at_epoch > <hwm>
order by written_at_epoch`, decrypt with the profile key, and apply with the puller-side LWW
+ the C2 gate. First accept is a **full pull** (no high-water mark) → the "full copy for
offline viewing" LOCKED promises. Store the high-water mark per share in `app_meta`
(`sync.pull_hwm.<shareId>`).

> This is the reader the record stream never had. CLAUDE.md's "nothing reads the record
> stream yet; do not add fields for a reader that does not exist" is **retired by this
> contract** — v2 IS that reader. The apply layer is new work; see §6.

### 3.3 A manager writes ONLY while online

LOCKED: a Manager can add/update **only while the relay is reachable**; offline they are
view-only. This keeps offline divergence small (the reason the wall-clock LWW in F2 is
acceptable). Enforcement is **client-side** (the relay is blind and cannot enforce a role):

```ts
// Gate every write to a SHARED profile at the repository/action layer.
// online = a successful relay round-trip is currently believed possible.
export function canWriteNow(role: SyncRole, online: boolean): boolean; //  owner → always; manager → online; viewer → never
```

- **Owner** writes offline freely (it is the source of truth and the ringer).
- **Manager** offline: the write UI is disabled with an honest line ("You can add changes for
  <name> when you are back online."). "Online" is not a presence table — it is "the last
  relay call did not fail offline/timeout"; the `SyncClientError.kind` already distinguishes
  `offline`/`timeout` from `http`. A manager write is committed locally AND pushed in the
  same action while online; if the push fails offline mid-action, the local write is rolled
  back (a manager must not accumulate an offline queue — that is what this rule prevents).
- **Viewer** never writes. (See F3 — role is not a cryptographic boundary against a
  key-holder.)

### 3.4 C2 — a manager's reminder-affecting edit does not silently change what rings

The danger is a manager editing a **medicine** or a **dose_schedule** (what the owner phone
rings). The safe default this round:

- Manager edits to **reading / symptom / lab / document / note / visit** → **apply
  immediately** on every device, no gate. None of these ring.
- Manager edits to **medicine / dose_schedule** → they SYNC (they are append-only new
  versions), but when the **owner device applies** an incoming `medicine`/`dose_schedule`
  version authored by a **non-owner device**, it **lands with `confirmed_by_user_at = NULL`**
  (the owner's apply path clears/never-trusts the incoming stamp for these two tables). The
  existing DB triggers `trg_occ_requires_confirmed_medicine` and
  `trg_occ_requires_confirmed_schedule` then **refuse to generate any `dose_occurrence`**
  from it — so it does not ring — until the owner accepts it in a "Pending changes" review,
  reusing the existing *AI-proposes / human-confirms* machinery (`reviewGate.ts` pattern).
  Accepting stamps `confirmed_by_user_at`; the horizon then picks it up on the next reconcile.

> **The triggers MUST remain intact.** They are the enforcement, not the UI. A manager cannot
> forge confirmation because the *owner's* apply path is what clears the stamp for these two
> tables. Do not add a code path that trusts an inbound `confirmed_by_user_at` for
> `medicine`/`dose_schedule` from a non-owner device.

- **A remote device can never silence a live ring.** Marking a dose taken from a sibling
  writes a `dose_event` (truth; unions; updates derived status). It does **not** reach the
  owner's Kotlin `AlarmPlayer` (a non-owner runs no alarm layer at all — C3), so the ~2-min
  MediaPlayer ring on the owner stops only on the owner tapping *Taken* locally or on its own
  timeout. State this in the apply layer: **inbound sync never calls into `modules/med-alarm`.**

### 3.5 Documents ride E2E

LOCKED supersedes the old "documents local only" note: the **briefcase SYNCS to all devices**,
E2E-encrypted, with the same ms-LWW. Managed by Owner + Managers; Viewers see only.

- `document.sync` flips **false → true** for shared profiles (migration **v8**, append-only —
  this is the one likely new local migration). The `stripLocalPaths()` redaction in
  `redact.ts` still runs: `file_uri` and any `*_uri` column is DROPPED before sealing (a
  local path is worthless on another handset and describes this one's storage).
- The **file bytes** themselves are NOT in `sync_row` (padding buckets top out at 128 KiB;
  photos do not travel this path). This round syncs the document **metadata rows** (title,
  kind, dates, pin state stays local). Syncing the encrypted *file blobs* to Supabase Storage
  is out of scope — **FLAG F4**: a manager on another phone sees the document exists and its
  title, not the scan, until file-blob sync is built. Say so in the UI, do not imply the file
  is there.
- **Contact phone numbers stay local** (`contact` rows: the `phone` field is not synced).
  LOCKED. Keep them out of the stream; if `contact.sync` is on for names, the phone column is
  stripped like a `*_uri` column (add it to the strip predicate — widen `redact.ts` and its
  restore-parity test together, per CLAUDE.md).

---

## 4. Roles and membership

### 4.1 Roles

`SyncRole` in `config.ts` extends from `'patient' | 'viewer'` to
**`'owner' | 'manager' | 'viewer'`**. Map legacy values on read (`'patient' → 'owner'`) and
keep the column tolerant (never narrow the stored string — an old phone carries `'patient'`).

| Capability | Owner | Manager | Viewer |
|---|---|---|---|
| See the record (full offline copy) | ✅ | ✅ | ✅ |
| Add / edit non-reminder data | ✅ | ✅ online only | ❌ |
| Add / edit medicine / schedule | ✅ (arms directly) | ✅ online → **owner-pending** (§3.4) | ❌ |
| Holds the profile key | ✅ (mints it) | ✅ (wrapped) | ✅ (wrapped) |
| Rings the alarm (Kotlin) | ✅ | ❌ push only | ❌ push only |
| Sends the push | ✅ | ❌ | ❌ |
| Invite / approve / deny / change role / remove | ✅ | ❌ | ❌ |
| Change owner | ✅ (initiates) | ❌ | ❌ |

> **FLAG F3 — role is not a cryptographic boundary against a key-holder.** LOCKED gives
> managers and viewers the *full profile key* (for offline view). So a viewer running a
> modified client could technically POST rows — the relay is blind and cannot stop it, and
> the profile key decrypts/encrypts either way. Role is **client-enforced and socially
> trusted among key-holders**. The only *cryptographic* boundaries are: (1) non-holders and
> the relay operator see nothing; (2) a **removed** member cannot read data written after the
> key rotation. Do NOT write copy claiming a viewer is prevented from writing — it is trusted
> not to, the same trust the current public link already places in whoever holds it.

### 4.2 Invite → request → approve → key-wrap

The key is **never** carried in an invite fragment (that is the old public-link model, which
leaks like a link). It is wrapped to a specific device's public key and released only on
approval.

1. **Invite (owner).** Owner opens the profile → "Add Someone". If `share_id` is null, mint
   it (per-profile analogue of `ensureShareKey`) and `owner_device_id = this device`. Produce
   an invite payload carrying **`{ url, anonKey, shareId, ownerPubKey }`** — the relay
   coordinates + the owner's device public key, **no profile key**. Delivered out-of-band
   (share sheet / QR / dictated code, reusing the `link.ts` hostless-code shape). The
   `url`/`anonKey` let an unconfigured invitee reach the relay without hardcoding (C4).
2. **Request (invitee).** The invitee's app configures the relay if needed, ensures its
   device keypair (§2.1), and POSTs to `sync_join_request`:
   `{ link_id: shareId, device_id, device_pubkey, label_wrap: sealAnon(ownerPubKey, deviceLabel), requested_at_epoch }`.
   The label is sealed so the relay never sees "Priya's Redmi"; the pubkey is public and safe.
3. **Approve (owner), BY NAME.** Owner polls `sync_join_request` for its share(s), `openAnon`s
   each `label_wrap` with its device private key, and shows "Priya's Redmi wants to help
   manage Mother — Approve as Manager / Approve as Viewer / Deny." **This is the safety gate:
   a stray join request is worthless without the owner's tap.** On approve-as-role, in one
   flow: (a) `wrapProfileKey(currentKey, device_pubkey)` → write `sync_key_wrap
   (link_id, device_id, key_generation, wrap, wrapped_at_epoch)`; (b) upsert the local
   `profile_member` row (role, public_key, device_label, added_at_epoch); (c) publish the
   sealed roster row `member:<device_id>` into `sync_row` (so other members learn who joined
   and their role); (d) delete the handled `sync_join_request` row. On deny: just delete the
   request — no wrap.
4. **Accept (invitee).** The invitee polls `sync_key_wrap` for `(link_id, its device_id)`;
   when a wrap appears, `unwrapProfileKey` with its private key → `setProfileKey(shareId, …)`.
   Then: a **full pull** of `sync_row` (the offline copy), learn its **role** from the sealed
   `member:<id>` row, and publish its own `device:<device_id>` row (Expo push token + label,
   §5) into the stream.

### 4.3 Remove a member → rotate the key

Removing a member stops **future** sharing but **cannot** retract what their phone already
downloaded — the honest UI says exactly that (reuse `REVOKE_DISCLOSURE`'s tone in
`share.ts`; the phrase is "…can no longer see changes from now on. Anything already saved
stays on their phone."). To make removal *mean* something, **rotate the profile key**:

1. Stamp local `profile_member.removed_at_epoch` for the removed device.
2. `rotateProfileKey(shareId)` → generation **G+1**.
3. Wrap G+1 to **every remaining** member device (+ owner) → `sync_key_wrap` rows at
   generation G+1. **Do not** write a G+1 wrap for the removed device — that absence *is* the
   revocation.
4. **Republish** the whole `sync_row` stream re-encrypted under the new key at generation G+1
   (the per-profile generalisation of `republishRecords()` in `outbox.ts`), then delete the
   removed device's `sync_key_wrap` rows and its `member:`/`device:` rows.

The removed device keeps generation G's key and whatever it already fetched, but every row
written after the rotation is generation G+1 and unreadable to it. This is `rotateShareLink`
generalised per profile, with **per-device re-wrap** instead of a new link fragment.

### 4.4 Change owner → ring handoff + notify

LOCKED: change-owner is supported; on transfer the new owner's device takes over ringing, the
old owner's device stops scheduling, and **both** devices are notified.

1. Current owner initiates (the new owner is already a member and already holds the current
   profile key wrap, so no re-wrap is needed to *read*; ownership is about *ringing* and
   *key-holding authority*, not read access).
2. Owner writes `profile.owner_device_id = newDeviceId` locally and publishes it (an encrypted
   `owner:<shareId>` row, or update the `member:` rows — pick one and state it in code; LWW by
   ms like any row).
3. **The new owner's device, on learning it is owner, must ACKNOWLEDGE before the ring moves.**
   On ack: it adds the profile to its owned set (so `deviceHorizon`/`reconcile` schedule its
   alarms — §C3/§5), becomes the push-sender, and posts an ack row. Only then does the **old
   owner** drop the profile from its owned set and stop scheduling. Both devices show a
   notification: "Ringing for Mother has moved to <device>."

> The two-step (initiate → new-owner ack, then old-owner steps down) is deliberate: a dropped
> transfer must never leave a window where **nobody** rings a TB dose. Until ack, the old
> owner keeps ringing.

---

## 5. Push (SEND built; RECEIVE decided, not built)

**One ringer, everyone gets a push.** The **owner device rings** (existing Kotlin alarm
layer) AND is a push target; managers/viewers get **push only**, never a local alarm.

### 5.1 Token storage — in the encrypted stream

Each device publishes its **Expo push token** + label as a sealed `device:<device_id>` row in
`sync_row` (under the profile key). So sibling tokens live in the **encrypted stream**
(LOCKED), the relay never sees an Expo token (which is otherwise a stable per-device tracker
+ a spam vector), and only key-holders can read them. **No plaintext push-token table** —
this is a deliberate deviation from the doc's "device + push-token registry" wording, for the
privacy reason just stated. Re-publish the token on each app-open (Expo tokens rotate).

### 5.2 The SEND side — build this round, fully

A plain `fetch`, ~40 lines, no backend of ours. New file
`src/features/sync/push.ts`:

```ts
export type PushTarget = { readonly expoPushToken: string };

/**
 * Owner-only. When the owner's alarm fires (or a quiet-dose alert, or a data change),
 * read sibling device tokens from the decrypted 'device:<id>' rows and POST a CONTENT-FREE
 * ping to Expo. NO medical fact in the payload — the receiving phone already holds the
 * encrypted data and renders detail locally (same rule the old content-free alert followed).
 */
export async function sendFamilyPing(
  targets: readonly PushTarget[],
  ping: { readonly titleKey: string; readonly channelId: string }, // e.g. "Mother's medicine" — a NAME/COUNT at most, never a drug
  now?: number,
): Promise<{ readonly sent: number; readonly invalidTokens: readonly string[] }>;
```

- POST `https://exp.host/--/api/v2/push/send`, `Content-Type: application/json`, body an
  array of messages `{ to, title, channelId, priority: 'high', sound: null }` (≤100 per
  call; batch). **No `body` field carrying a drug/dose.** No auth header — Expo Push needs
  none for send; **no secret** (C4).
- Parse the receipt array for `DeviceNotRegistered`/`InvalidCredentials`; return those tokens
  as `invalidTokens` so the caller prunes that device's `device:<id>` row.
- Fires from the owner's alarm path (its own alarm has already woken it — the one case that
  matters, "a dose is due", is exactly when the owner is awake). Never throws into the alarm
  path; a failed ping is logged and dropped.
- **C3 holds:** only the owner sends and only the owner rings. A non-owner device schedules
  no alarms and sends no pushes for a profile it does not own. `deviceHorizon.ts` /
  `reconcile.ts` change their profile set from *"every non-archived profile"* to *"every
  non-archived profile this device OWNS"* — `owner_device_id IS NULL OR owner_device_id =
  thisDeviceId`. The R1 device-wide union and the R2 per-day override are otherwise unchanged.

### 5.3 The RECEIVE side — recommended, NOT built (C1)

> **FLAG F5 — the receive path is a DECISION, and `expo-notifications` stays banned.** Do NOT
> add `expo-notifications` to satisfy the receive side this round.

The problem: `expo-notifications` is banned because it is a **second scheduler** — its mere
presence invites someone to schedule a dose through it, tripping the exact double-fire the
ban prevents. And obtaining an Expo push *token* normally also rides on `expo-notifications`.

**Recommended (Option A): a narrow native, receive-only FCM path in the existing Kotlin
module.** No new scheduler surface at all.

- **Token:** a tiny native method fetches the raw FCM token
  (`FirebaseMessaging.getInstance().token`), then a plain `fetch` to Expo's
  `getExpoPushToken` endpoint (FCM token + `projectId`, no secret) mints the `ExpoPushToken`
  the send side needs. No `expo-notifications`.
- **Receive:** a native `onMessageReceived` shows a **display-only** heads-up notification on
  a **new receive-only channel `family_ping_v1`** (importance DEFAULT, **`ringsAsAlarm =
  false`**, ordinary sound, **no** `USAGE_ALARM`, **no** MediaPlayer). It writes **no**
  `horizon.json`, appends **no** journal record, and calls **nothing** in the dose scheduler.
  It is a notification, full stop.
- Why not bare FCM for send too: FCM HTTP v1 needs a service-account credential = a secret in
  the app = violates C4. Expo Push relay needs no secret for send, which is why the SEND side
  is built against it now.

**Option B (rejected for this round): a Supabase Edge Function** fanning out to FCM on a new
row. Survives a fully-offline owner, but adds a server component (more moving parts, an FCM
server credential to hold) and the case it uniquely covers — owner phone dead at dose time —
is a case where the owner *also* isn't ringing, so the patient beside it isn't reminded
either; the missed-dose watchdog already covers the after-the-fact side. Not worth the
server this round.

> This is **device-gated** and cannot be unit-verified — see §7. Build A behind the same
> survivable-absence boundary the alarm module already uses (`requireNativeModule` in
> try/catch, `isAvailable === false` no-ops), so an Expo Go / node-test / stale-dev-client
> run degrades to "no push", never a crash.

---

## 6. What each build agent implements, and where

Files are **new** unless marked *(edit)*. Keep the `getSyncConfig() === null → silent no-op`
contract on every background path (`config.ts`).

### Crypto (owns the crown jewel; build first, others depend on it)
- `src/features/sync/deviceKey.ts` — `getOrCreateDeviceKeyPair`, `getDevicePublicKeyB64`,
  `forgetDeviceKeyPair`.
- `src/features/sync/profileKey.ts` — `mintProfileKey`, `getProfileKey`, `setProfileKey`,
  `rotateProfileKey`, `forgetProfileKey`.
- `src/features/sync/keywrap.ts` — `sealAnon`, `openAnon`, `wrapProfileKey`,
  `unwrapProfileKey`. **Pure** — ships `keywrap.test.ts` (round-trip, wrong-key null,
  tamper null, length assert).
- `src/features/sync/sealed.ts` *(edit)* — add `rowAad(rowKey, modifiedAtMs, deviceId,
  keyGeneration)`. Do NOT touch `recordAad`.
- `package.json` *(edit)* + `docs/SIZE.md` *(edit)* — add `@noble/curves` (F1).

### Relay client + stream
- `supabase/schema.sql` — **done** in this change (the v2 section: `sync_row` + LWW trigger,
  `sync_join_request`, `sync_key_wrap`, RLS on each). A human applies it; do not touch the
  live DB.
- `src/features/sync/config.ts` *(edit)* — `SyncRole = 'owner'|'manager'|'viewer'` (+ legacy
  map); `canWriteNow(role, online)`.
- `src/features/sync/rowStream.ts` — `sealRowPayload(rowKey, op, modifiedAtMs, deviceId,
  keyGeneration, value, profileKey)`; `pullRows(shareId, sinceHwm)`; `applyPulledRow(...)`
  (puller-side LWW + the C2 confirmed-gate for `medicine`/`dose_schedule` from non-owner +
  "never call into `modules/med-alarm`"). Reuse `clientFor(config, shareId)` from `client.ts`
  for the per-profile `X-Share-Id`.
- `src/features/sync/outbox.ts` *(edit)* — for shared profiles, target `sync_row` carrying
  `device_id` + `modified_at_ms = row.updated_at_epoch`. Keep `stripLocalPaths()` on every
  seal site (there are now THREE — the two existing + `sealRowPayload`; nothing enforces it,
  the reason is on `sealRecordPayload`).

### Membership + lifecycle
- `src/features/sync/membership.ts` — `mintInvite(profileId)`, `postJoinRequest(invite)`,
  `listPendingRequests(shareId)`, `approve(shareId, deviceId, role)`, `deny(...)`,
  `changeRole(...)`, `removeMember(...)` (→ `rotateProfileKey` + republish), plus the local
  `profile_member` reads/writes. Uses `keywrap`, `profileKey`, `rowStream`.
- `src/features/sync/owner.ts` — `changeOwner(shareId, newDeviceId)` (initiate),
  `acknowledgeOwnership(shareId)` (new owner), the ring handoff + both-device notify.
- `src/features/dosing/deviceHorizon.ts` *(edit)* + `reconcile.ts` *(edit)* — the owned-profile
  filter (§5.2). This is the whole of C3.

### Push
- `src/features/sync/push.ts` — `sendFamilyPing` (SEND, built fully). Ships `push.test.ts`
  (payload is content-free; token batching; invalid-token parsing) — the network call itself
  is mocked; real delivery is device-gated (§7).
- Receive path: **not built** (F5). Leave a `docs`-linked TODO + the `family_ping_v1` channel
  id reserved in `src/constants/channels.js` *(edit, additive)* so the native side has a
  target when it is built.

### UI (theme tokens only; 56dp; Title Case; `useToast`/`useConfirm`, never `alert`;
new copy in screen-local `LocalStrings` en+hi)
- Owner: a members screen — pending join requests (approve-by-name / deny), member list with
  roles (change role / remove with the honest rotation disclosure), change-owner. Extend
  `src/app/settings/viewers.tsx` or a sibling.
- Owner: a "Pending changes" review for C2 reminder-affecting manager edits (reuse the
  `reviewGate.ts` chip pattern).
- Member: an "Add Someone invited me" accept flow; role-appropriate write affordances
  (manager write disabled offline with the honest line).

### Exports
- `src/features/sync/index.ts` *(edit)* — export the new public surface; keep the "three
  rules" header accurate.

---

## 7. What cannot be unit-verified (device-gated) — say so, don't fake it

Every non-trivial branch leaves a runnable check, but these are cross-device / native and a
green unit suite does **not** prove them. Each needs a **two-phone manual pass**; note it in
the PR, do not claim coverage a `node --test` run cannot give:

- **Cross-device merge / LWW convergence.** Two phones editing the same reading; the later ms
  wins on both. Unit-testable in *part* (the comparator, the apply function against a fake
  pool), but the relay trigger + real round-trip is device-gated. Test the comparator purely;
  manual-pass the end to end.
- **RLS enforcement.** That `request_share_id()` actually isolates one share from another,
  and that a wrong `X-Share-Id` returns nothing, is a property of the *applied* schema on the
  live project, not of any TS. Verify by hand against the project (a click-path, not raw SQL
  in the app).
- **Key wrap across devices.** `keywrap.test.ts` proves the math on one process; that device
  A can wrap to device B's real published pubkey and B can unwrap is device-gated.
- **Push delivery.** `push.test.ts` proves the payload shape and token handling; that a ping
  actually reaches a sibling phone and shows on `family_ping_v1` **without** scheduling a dose
  is device-gated (and the receive side is not even built — F5).
- **Ring ownership / handoff.** That exactly one phone rings, that a non-owner rings nothing,
  and that change-owner moves the ring with no gap, is the C3 property and is device-gated.

---

## 8. Every LOCKED DECISION that forced a choice here

| LOCKED decision | Where it forced this contract |
|---|---|
| One Owner + N Managers + N Viewers | §4.1 role table; `SyncRole` extension; capability matrix |
| Relay = blind postbox, key never on Supabase | §2 (key wrapped per device, never in a fragment or a column); every v2 table stores only ciphertext/public data; F3 |
| Invites by Owner only; approve-by-name; full copy on accept | §4.2 (invite carries no key; owner unwraps the label to approve; accept = key-unwrap + full pull) |
| Manager writes only while online; ms-timestamp LWW | §3.2 (LWW by `(modified_at_ms, device_id)`, not lamport — F2), §3.3 (`canWriteNow`) |
| Documents SYNC E2E, same ms-LWW; contact phones stay local | §3.5 (document `sync` flip = migration v8; file blobs deferred F4; phone column stripped) |
| Owner rings + push; managers/viewers push only | §5 (owner-only send; C3 owned-profile horizon filter) |
| Change owner: ring handoff + notify both | §4.4 (initiate → new-owner ack → old-owner steps down; no ring gap) |
| Merge by data shape (`dose_event` unions; rows LWW; caches rebuild) | §3.2 merge table |
| Relay does ms-timestamp ordering | §3.2 (the relay-side `trg_sync_row_lww` trigger; why `sync_row` PK is single-winner, not per-device) |

## 9. Open flags, collected

- **F1** — one new dep `@noble/curves` (x25519). Unavoidable for wrap-to-pubkey; add + note in `docs/SIZE.md`.
- **F2** — LOCKED forces wall-clock LWW (trusts device clocks); tie-break on `device_id`.
- **F3** — role is client-enforced/trusted among key-holders, not a crypto boundary; only non-holders and removed-post-rotation members are cryptographically excluded.
- **F4** — document *file blobs* are not synced this round (metadata only); the UI must not imply the file is on a sibling phone.
- **F5** — push RECEIVE path is a decision (recommended: native receive-only FCM channel `family_ping_v1`), NOT built; `expo-notifications` stays banned.
- **RLS honesty** — a holder of a share's `link_id` can write/vandalise (not read) its
  ciphertext; the relay cannot authenticate a device, so RLS filters on `link_id` only.
  Rotation + republish recovers; treat the link id like a house key.
