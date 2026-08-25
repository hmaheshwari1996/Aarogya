# Multi-device shared management — design

**Status: P1 + P2 BUILT (2026-08-24); P3 send-side built, receive-side deferred; P4 not
built.** This is the answer to "how can Me, my mother and my sisters all manage my mother's
profile, and Me, my father and my mother manage my grandmother's, with reminders ringing on
one phone and a notification on all of them." The five decisions at the end are now the
LOCKED DECISIONS block; `docs/FAMILY-SHARING-CONTRACT.md` is the single source of truth for
the built behaviour and `docs/SYNC-AND-BACKUP.md` §13–15 for the threat model + schema. See
§7 for the per-phase shipped state.

It is written against what exists today (`src/features/sync/`, `docs/SYNC-AND-BACKUP.md`),
and it changes one thing the current design leans on hard, so that change is stated first.

---

## 0. The one invariant this breaks

Today: **the patient device is the only writer.** `config.ts` has exactly two roles,
`patient` and `viewer`; a viewer pulls a sealed snapshot and renders it read-only; the
outbox has no conflict resolution *because nothing else writes*. CLAUDE.md says this in as
many words.

Your requirement — "anyone can see/update" — makes every member device a writer. So the
new system needs three things the old one never did: a **merge rule** for when two people
edit the same thing, a **key shared among a set of devices** (not just handed to viewers),
and a **"who rings" rule** so a dose does not alarm on four phones at once.

The good news: the data model was already built for this even though the sync layer wasn't.
`dose_event` is append-only truth, every row carries a `lamport` clock, and the caches
(`dose_occurrence.status`, streaks) are derived and rebuildable. That is exactly the shape
that merges without a central server.

---

## 1. The unit of sharing is the PROFILE, not the phone

This is the key reframing, and it is why local multi-profile is being built first.

- A **profile** (mother, grandmother) gets a stable **share id** and its own **data key**.
- A **membership set** is per profile: `{owner, [members]}`. Mother = {you, mother,
  sisters}; grandmother = {you, father, mother}. Your phone holds *both* profiles and is a
  member of *both* sets; your sister's phone holds only the mother profile.
- A device can be **master for one profile and an ordinary member of another** at the same
  time. Master is a property of `(profile, device)`, not of the device.

So "sharing a profile" means: publish that profile's rows under its share id, wrapped to
that profile's key, and hand the key to the devices in that profile's set. Two profiles on
one phone are two independent shares that happen to live in one app.

---

## 2. The merge rule (conflict model)

Per **(table, row)**, **last-write-wins by `(lamport, device_id)`** — the row with the
higher lamport wins; ties break on the lexically-higher device id (arbitrary but total, so
every device converges on the same answer). This is the laziest rule that is actually
correct here, and it is correct because of the data shapes:

| Data | Merge | Why it is safe |
|---|---|---|
| `dose_event` (taken/snoozed) | **union** — append-only, content-addressed ids | Two phones both marking a dose taken produce the same id; the union dedupes. Nobody's "taken" is ever lost. |
| `medicine` / `dose_schedule` versions | **LWW on the thread's latest version** | These are already append-only versioned on a `thread_id`; a new version is a new row, so an edit is an insert, and "latest lamport wins" picks the most recent human decision. |
| `reading`, `symptom_event`, `document` | **LWW per row** | Independent rows; two people rarely touch the same one, and if they do the later edit wins. |
| `dose_occurrence.status`, streaks, badges | **not synced — rebuilt** | Derived caches. Each device recomputes from the merged events. |

**The one genuinely unsafe case, and the decision it forces (Decision A):** two people edit
the *same medicine's schedule* while both offline — say you set Metformin to twice daily and
your sister sets it to three times, and both sync. LWW silently keeps one and drops the
other, and for a TB or cardiac drug a silently-dropped schedule change is a wrong dose that
looks intentional. Two honest options:

- **A1 — LWW + a visible "changed by someone else" note.** Simple. The later edit wins; the
  master device shows "your sister changed Metformin's schedule on Tuesday" so a human can
  catch a bad merge. Ships fastest.
- **A2 — reminder-affecting edits are proposals the master confirms.** A member's edit to a
  *schedule or a medicine* becomes a proposal (reusing the exact "AI proposes, human
  confirms" machinery already in the app); it does not ring until the master device — the
  phone physically with the patient — accepts it. Non-reminder edits (readings, symptoms,
  documents, notes) apply immediately. Safer, slower, and it matches how the family actually
  works: the sister at the hospital records what the doctor said; the change to what *rings*
  is confirmed by whoever is with your mother.

I recommend **A2 for reminder-affecting edits, immediate for everything else.** It costs one
"pending changes" screen and it is the difference between "the app synced" and "the app
changed what my mother's medicine alarm does without anyone with her agreeing."

---

## 3. Key distribution across a per-profile device set

Each profile has a **profile data key** (symmetric, 256-bit). Every member device has a
long-lived **device keypair** (public/private, private in `expo-secure-store`, never leaves
the phone). Joining is the invite flow that already exists in skeleton, extended from
"hand a viewer the key" to "wrap the profile key to a new member":

1. The owner (you) opens the profile → "Add someone" → mints a **single-use invite** (short
   code + the profile key in the URL `#fragment`, which is never sent to the server) with a
   24-hour expiry.
2. The new device opens it, generates its keypair if it has none, and posts a **join
   request** carrying its public key and a device label ("Priya's Redmi").
3. **The owner approves on their phone, by name** — "Priya's Redmi wants to help manage
   Mother. Approve?" This is the safety gate: a leaked link is worthless without approval.
4. On approval, the profile key is **wrapped to the new device's public key** and released.
   The new device unwraps it with its private key and can now read and write that profile.

**Revocation (Decision B).** Remove a sister → she is dropped from the membership set and
future syncs exclude her, but **nothing retracts what her phone already downloaded** — the
same hard limit the current design already states for viewers. To make revocation *mean*
something you must **rotate the profile key** (re-wrap a fresh key to the remaining devices;
the removed device keeps the old key but the old ciphertext stops being updated). That is
`rotateShareLink()` generalised per profile. The decision is only *how loud* to be about the
limit: the honest UI says "Priya can no longer see changes from now on. Anything she already
saved stays on her phone." Do not claim more.

---

## 4. Master rings, everyone gets a push

**Master = the one device that owns the alarms for a profile.** By default it is the phone
the profile was created on (your mother's own phone for her profile; your phone for
grandmother's if she has none). Reassignable in the profile's settings. Exactly one master
per profile; changing it is a synced row like any other.

- **The master schedules alarms** for that profile — the existing Kotlin alarm layer, per
  profile (see the multi-profile note below). Non-master member devices **schedule nothing**
  for that profile: no local alarms, so no four-phones-ringing.
- **When a dose is due (or two consecutive are missed, or data changes), the master sends a
  content-free push** to the other members' devices. "Mother's 8 pm medicine" — the push
  carries no medical fact; the receiving phone already has the encrypted data and renders
  the detail locally. This is the "content-free ping" the original plan named.

**How the push is sent with no server (Decision C).** Two viable routes, both free:

- **C1 — Expo Push.** Each device stores its Expo push token in the encrypted stream. When
  the master's alarm fires, it does one HTTPS `POST` to `https://exp.host/--/api/v2/push/send`
  with the sibling tokens. No backend of ours — the master device is the sender. Failure
  mode: the master must be awake at dose time to send it (its own alarm wakes it, so this is
  fine for the "dose due" case) and tokens rotate (re-published on each app open).
- **C2 — a tiny Supabase Edge Function** triggered by a new row, fanning out to FCM. Needs
  the Supabase project to have functions enabled; more moving parts; survives the master
  being fully offline because the server sends it.

I recommend **C1 (Expo Push, master-sent).** It is ~40 lines, needs no server, and the case
that matters most — a dose is due — is exactly the case where the master is awake because its
own alarm just fired. The case C1 cannot cover (master phone off/dead at dose time) is a
case where the master *also* isn't ringing, so the patient beside it isn't reminded either;
that is a "the master phone died" problem, not a sync problem, and the missed-dose watchdog
already covers the after-the-fact side.

**The trap to avoid:** never let a non-master member's device schedule the alarm "as a
backup." That is how you get a dose ringing on your sister's phone in another city at 4 am.
One master, everyone else is push-only, full stop.

---

## 5. How it layers on the multi-profile work (built now)

The local multi-profile feature being built this round must lay the schema so this needs no
second migration of the profile tables. It should add, now:

- `profile.share_id TEXT` — stable, unique, null until the profile is shared. This is the id
  its rows publish under.
- `profile.master_device_id TEXT` — null (this device is master / not yet shared) until set.
- An **empty** `profile_member` table shape reserved: `(share_id, device_id, public_key,
  device_label, role, added_at, removed_at)`. Not populated until sharing ships, but its
  existence now avoids a migration later. Local-only (`sync: false`) — membership is managed,
  not merged.

Everything else profile-scoped already carries `profile_id`, so no per-feature change.

---

## 6. Safety — a remote edit must not silently change what rings

This is the whole risk of turning viewers into writers, so it gets its own rules:

1. **Reminder-affecting edits from a non-master device are proposals** (Decision A2), applied
   to the alarm layer only after the master confirms. The existing confirmed-medicine DB
   triggers stay exactly as they are — a synced schedule row still needs `confirmed_by_user_at`
   before it can generate an occurrence, and "confirmed" now means "the master accepted it."
2. **A remote device can never silence a live alarm on the master.** Marking a dose taken
   from another phone records a `dose_event` (which is truth and merges), but the master's
   ringing alarm is stopped only by the master, or by its own timeout. A sister tapping
   "taken" in another city does not stop the phone next to your mother from reminding her.
3. **Every synced edit is attributed.** `device_id` + `device_label` ride on each row, so the
   record — and the OPD report — can say who changed what. No anonymous edits to a medical
   record shared by five people.

---

## 7. Phased build — smallest shippable slice first

1. **P1 — read-only multi-viewer, per profile. BUILT.** Per-profile share id + membership
   approval; the invite → join-request → owner-approve → per-device key-wrap flow
   (`membership.ts`, `deviceKey.ts`, `keywrap.ts`, `sync_join_request` + `sync_key_wrap`).
   *Known gap (flagged, not built): the fresh-from-scratch initial join where the invitee has
   no local profile row yet — needs invitee-side pending-join persistence, an owner-side
   initial full publish incl. the `profile` identity row, and a bootstrap pull. Rewrap
   recovery for already-joined members and first-release-after-approval DO work
   (`acceptProfileKeyWrap` wired into `appOpen.ts`).*
2. **P2 — multi-writer for non-reminder data. BUILT.** Readings, symptoms, documents, notes
   writable by members; `sync_row` multi-writer stream with ms-LWW enforced by the relay
   trigger (`sync_row_lww`); union of `dose_event`; documents SYNC end-to-end. `merge.ts` +
   `rowStream.ts` + `outbox.ts`. *Known gap: `canWriteNow` (manager online-only) is
   client-side scaffolding, not yet wired to a read-only member-edit UI — see §13.*
3. **P3 — owner rings + push. SEND-SIDE BUILT, RECEIVE-SIDE DEFERRED.** Owner-only ringing
   (non-owner devices schedule nothing — `deviceHorizon.ts` `continue`s on non-owned
   profiles); content-free Expo push fan-out send path (`push.ts::sendFamilyPing`, sibling
   tokens sealed in `device:<id>` rows). **The receive path is a deliberate decision, NOT
   built** — `expo-notifications` stays banned (a second scheduler double-fires a dose); the
   recommended receive-only native FCM channel `family_ping_v1` is reserved in
   `channels.js` but not implemented. `sendFamilyPing`/token-publish are not yet wired into
   the owner's live alarm path.
4. **P4 — reminder-affecting edits as proposals** (Decision A2). NOT BUILT. This round applies
   the safe default (C2): a manager edit to a MEDICINE or SCHEDULE lands
   `confirmed_by_user_at = NULL` on the owner device (author-blind gate in `rowStream.ts`) and
   does not arm until the owner accepts it, reusing the existing confirmed-medicine DB
   triggers. Full member-proposes / owner-confirms UI is the P4 slice.

Each phase is independently useful and independently safe to ship.

---

## The five decisions for you

- **A. Conflict on a schedule edit:** A1 (last-edit-wins + a visible note) or **A2 (reminder
  edits are proposals the master confirms; everything else applies immediately)** — recommended.
- **B. Revocation loudness:** confirm you accept that removing someone stops *future* sharing
  but cannot wipe what their phone already holds — the UI will say so plainly.
- **C. Push mechanism:** **C1 (Expo Push, sent by the master, no server)** — recommended — or
  C2 (a Supabase Edge Function, survives a dead master, more setup).
- **D. Default master:** the patient's own phone when she has one, else the owner's (yours).
  Confirm, or say you want a different default.
- **E. Scope of "update":** does a member editing a *reading or a document* need any approval
  (I assume no — apply immediately), and only *reminder* edits go through the master (A2)?
  Confirm the split.

Answer these and P1 can start; P1–P2 need only A, B, E; P3 needs C, D.

---

## LOCKED DECISIONS (owner's calls — 2026-08-24)

These supersede the "five decisions" framing above where they conflict.

**Roles.** Exactly **one Owner** per profile, and any number of **Managers** (see + update)
and **Viewers** (see only). Owner = whoever created the profile on their device.

**Relay = Supabase (free), as a BLIND POSTBOX.** It holds only end-to-end-encrypted
ciphertext and never sees a name, dose, drug, or document. The **profile key stays on the
owner's device** and is wrapped to each Manager/Viewer device during the invite — it is NOT
stored on Supabase. (Recommended and taken as default; the medicine list alone reveals the
TB diagnosis, so the key must never sit where the operator can read it.) Supabase does the
key-free work: online-presence, the device + push-token registry, the invite/approve
handshake, and millisecond-timestamp ordering.

**Invites** are sent only by the Owner. A Manager/Viewer joins by the Owner's approval, and
**receives a full copy of the record on accepting** so they can view offline.

**Writes.** A Manager can add/update **only while online** (reachable relay); offline they are
view-only. This keeps offline divergence small. Every write still carries a **millisecond
modified-timestamp**; conflicts on reconnect resolve **last-write-wins by that timestamp**.
(Caveat: wall-clock LWW trusts device clocks; acceptable at this scale, and the online-only
write rule keeps concurrent offline edits rare.)

**Documents (briefcase) SYNC to all devices**, end-to-end encrypted, with the same
millisecond-timestamp LWW. (This supersedes the earlier "docs local only" note.) Managed by
Owner + Managers; Viewers see only. Contact phone numbers stay local (not synced).

**Reminders.** The **Owner device rings** the alarm (the existing Kotlin alarm layer) AND
gets a push; Managers and Viewers get **push only**, never a local alarm. One ringer, no
four-phones-at-once.

**Change owner** is supported. On transfer: the **new owner's device takes over ringing**
the alarms for that profile, the old owner's device stops scheduling them, and **both
devices are notified** that the ringing responsibility moved. The profile key is re-wrapped
so the new owner holds it.

**Merge, by data shape (unchanged from §2):** `dose_event` unions (no "taken" ever lost);
versioned medicine/schedule rows and independent rows use millisecond-timestamp LWW; derived
caches (status, streaks) rebuild locally.

---

## Updating the app without losing data (answer to "how do we update?")

**Install every new build OVER the old one. Never uninstall.** Android keeps an app's
private data across an in-place update, and the migration runner (`src/db/index.ts`) upgrades
the schema forward (v6 → v7 → …) in place: it snapshots the DB with `VACUUM INTO` first, runs
each migration in one exclusive transaction, and verifies `integrity_check` +
`foreign_key_check` after. Every reading, dose, medicine and document survives.

**The one rule that must never break: same signing key + same package name.** Every build is
signed with `~/.aarogya/keystore.env` and packaged as `in.aarogya.care`. If a build is ever
signed with a different key (or debug-signed), Android refuses the in-place update and the
only path left is uninstall → reinstall, which wipes the data directory — the exact disaster
the backup capsule exists for. Proof the signer has held: builds 6→7→8→9 installed over each
other on the phone without a signature-mismatch refusal.

**The backup/restore feature is for the OTHER case** — a lost, wiped, factory-reset, or
replaced phone — where the data directory is gone and only a capsule saved OFF the phone
(Backup → "Send this copy somewhere safe") survives. It is not needed for an ordinary update.
Prudent before a big-schema update anyway: save a copy off-device first, belt and braces.
