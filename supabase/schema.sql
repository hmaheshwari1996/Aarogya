-- Aarogya — Supabase schema (BASELINE: the existing single-viewer share).
-- Run once per project. NOTHING here stores plaintext, and nothing here can store the key:
-- payloads are base64(nonce‖ciphertext‖tag) and the key rides only in the share link's URL
-- fragment, which no HTTP client transmits. The role/multi-writer extension is appended by
-- the family-sharing build (see the "-- v2" section it adds below this one).

-- The capability RLS filters on: 128 random bits naming ONE dataset, sent as X-Share-Id by
-- src/features/sync/client.ts. Row isolation + anti-enumeration — NOT the confidentiality
-- boundary (the encryption is, and its key never arrives here).
create or replace function public.request_share_id() returns text
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-share-id', '')
$$;

-- ── The record stream ──────────────────────────────────────────────────────
create table if not exists public.sync_record (
  link_id          text   not null,
  row_key          text   not null,          -- '<table>:<uuid>'
  lamport          bigint not null,
  op               text   not null check (op in ('upsert','delete')),
  payload          text   not null,          -- base64: nonce ‖ ciphertext ‖ tag
  key_generation   int    not null default 1,
  updated_at_epoch bigint not null,
  primary key (link_id, row_key)
);
create index if not exists sync_record_stream on public.sync_record (link_id, lamport);

-- ── What a link actually opens: one sealed snapshot blob per dataset ────────
create table if not exists public.sync_share (
  link_id          text primary key,
  payload          text   not null,          -- base64: nonce ‖ ciphertext ‖ tag
  key_generation   int    not null default 1,
  updated_at_epoch bigint not null
);

alter table public.sync_record enable row level security;
alter table public.sync_share  enable row level security;

drop policy if exists record_share on public.sync_record;
create policy record_share on public.sync_record for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

drop policy if exists share_share on public.sync_share;
create policy share_share on public.sync_share for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

-- ════════════════════════════════════════════════════════════════════════════
-- v2: family sharing (P1 + P2 of docs/MULTI-DEVICE-SYNC-DESIGN.md)
--
-- Contract: docs/FAMILY-SHARING-CONTRACT.md is the single source of truth. This
-- section is the RELAY half of it. NOTHING here is edited above this line.
--
-- What changes from the baseline, and why it needs new tables rather than edits:
--   • The baseline is SINGLE-WRITER (patient device only). v2 is MULTI-WRITER:
--     an owner plus N managers all publish rows for one profile. That needs a
--     conflict rule and a per-row modified-timestamp — the LOCKED DECISION is
--     LAST-WRITE-WINS by MILLISECOND modified-time, device_id breaking exact ties
--     (NOT lamport). The baseline `sync_record` (PK link_id,row_key, no device_id,
--     no modified-ms, no merge) cannot carry that without changing its shape, so
--     v2 adds a SIBLING stream `sync_row`. `sync_record` + `sync_share` stay as
--     they are for the legacy single-viewer share; the family build writes/reads
--     `sync_row`.
--   • Everything here is a BLIND POSTBOX row: ciphertext, a link id, a device id,
--     a public key, a millisecond number. No name, dose, drug, or document ever
--     appears in the clear. The profile key never reaches this database — it is
--     held on the owner device and WRAPPED to each member device's public key
--     (`sync_key_wrap`), openable only by that device's private key.
--   • Same RLS shape as the baseline: request_share_id() (the X-Share-Id header,
--     128 random bits) is the capability every policy filters on. It is ROW
--     ISOLATION, NOT confidentiality — the encryption is that. A holder of a
--     share's link id can write/vandalise that share's ciphertext rows; they
--     still cannot READ them without the profile key, and the owner's local DB is
--     the source of truth and can republish. The relay cannot authenticate a
--     device (the anon key is shared), so RLS can only ever filter on link_id;
--     role and removed-member enforcement are done off-relay (see the contract).

-- ── The multi-writer record stream ──────────────────────────────────────────
-- Supersedes `sync_record` for shared profiles. One row per (link_id, row_key):
-- the LWW trigger below keeps only the WINNER, so device_id is a tie-break +
-- attribution column, NOT part of the key. `modified_at_ms` is the row's LOCAL
-- edit time (its `updated_at_epoch` on the writing device) — the LWW key — and is
-- distinct from `written_at_epoch`, the relay's own arrival clock used only for
-- incremental pulls. Both are bound into the ciphertext's AAD on the client
-- (rowAad = row_key ‖ modified_at_ms ‖ device_id ‖ key_generation), so the relay
-- cannot move a payload onto another row, replay an older one under a newer
-- number, or swap its device_id.
--
-- The push-token + membership rows also live HERE, sealed under the profile key
-- (row_key 'device:<id>' and 'member:<id>'), so sibling push tokens are in the
-- encrypted stream (LOCKED) and the relay never sees an Expo token or a role.
create table if not exists public.sync_row (
  link_id          text   not null,
  row_key          text   not null,          -- '<table>:<uuid>' | 'device:<id>' | 'member:<id>'
  device_id        text   not null,          -- opaque per-handset id; LWW tie-break + attribution
  modified_at_ms   bigint not null,          -- the row's local edit time; the LWW ordering key
  op               text   not null check (op in ('upsert','delete')),
  payload          text   not null,          -- base64: nonce ‖ ciphertext ‖ tag (profile key)
  key_generation   int    not null default 1,
  written_at_epoch bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (link_id, row_key)
);
-- Incremental pull: members select rows with written_at_epoch above their last
-- high-water mark, in that order. Not the modified-ms — a late-arriving old edit
-- must still be delivered so the puller can run the SAME LWW locally.
create index if not exists sync_row_pull on public.sync_row (link_id, written_at_epoch);

-- LAST-WRITE-WINS, enforced on the relay because the LOCKED decision makes the
-- relay responsible for millisecond-timestamp ordering. PostgREST upserts as
-- INSERT … ON CONFLICT DO UPDATE; this BEFORE trigger DROPS an update whose
-- incoming (modified_at_ms, device_id) is not strictly greater than what is
-- stored — so a stale write can never clobber a fresher one, regardless of which
-- one reaches the relay first. First insert of a key always wins (nothing to beat).
create or replace function public.sync_row_lww() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.modified_at_ms < old.modified_at_ms
       or (new.modified_at_ms = old.modified_at_ms and new.device_id <= old.device_id) then
      return null;  -- ignore the stale upsert; the stored winner stands
    end if;
  end if;
  -- The relay OWNS the arrival clock. Clients never send written_at_epoch: an
  -- ON CONFLICT DO UPDATE only refreshes columns the client lists, so a client-sent
  -- value would go stale on updates and stall every puller's high-water mark. Stamping
  -- it here bumps it on the winning INSERT and the winning UPDATE alike.
  new.written_at_epoch := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;
drop trigger if exists trg_sync_row_lww on public.sync_row;
create trigger trg_sync_row_lww before insert or update on public.sync_row
  for each row execute function public.sync_row_lww();

-- ── The invite handshake: a device asks to join ─────────────────────────────
-- The invitee posts its long-lived X25519 PUBLIC key (safe — a public key reveals
-- nothing) and its device label SEALED to the owner's public key (`label_wrap`),
-- so the relay never sees "Priya's Redmi" while the owner can still open it to
-- approve BY NAME before any key is released. One pending request per device per
-- share. The owner deletes the row on approve or deny.
create table if not exists public.sync_join_request (
  link_id            text   not null,
  device_id          text   not null,
  device_pubkey      text   not null,        -- base64 X25519 public key of the joining device
  label_wrap         text   not null,        -- base64 sealed-box(deviceLabel) to the owner pubkey
  requested_at_epoch bigint not null,
  primary key (link_id, device_id)
);

-- ── The released wrapped profile key ────────────────────────────────────────
-- On approval the owner wraps the CURRENT-generation profile key to the joining
-- device's public key (anonymous X25519 sealed-box) and writes it here. Only that
-- device's private key opens `wrap`; the relay holds an opaque blob. One row per
-- (device, generation): a key ROTATION (member removed) writes a new generation
-- to every REMAINING device and simply never writes one to the removed device —
-- that absence is the whole of cryptographic revocation. Role is NOT stored here;
-- the joining device learns its role from the sealed 'member:<id>' row it pulls
-- once it has the key.
create table if not exists public.sync_key_wrap (
  link_id         text   not null,
  device_id       text   not null,
  key_generation  int    not null,
  wrap            text   not null,           -- base64: ephPub ‖ nonce ‖ ciphertext ‖ tag
  wrapped_at_epoch bigint not null,
  primary key (link_id, device_id, key_generation)
);

alter table public.sync_row          enable row level security;
alter table public.sync_join_request enable row level security;
alter table public.sync_key_wrap     enable row level security;

-- BOUNDARY (read before "tightening" these): every policy below is a pure LINK-ISOLATION
-- check on the shared X-Share-Id header — NOT authentication. The anon key is shared by every
-- member by design (blind postbox), so the relay CANNOT distinguish a viewer from a manager
-- from a removed device: role restriction (viewer read-only, manager online-only) and member
-- removal are honoured by cooperating clients only, never enforced here. Any share-id holder can
-- write or delete this share's rows via raw PostgREST. Confidentiality is the encryption's job;
-- integrity/role/removal would need per-device auth (a JWT claim) or reader-verified writer
-- signatures — neither exists this round. See docs/SYNC-AND-BACKUP.md §13 and membership.ts.
drop policy if exists row_share on public.sync_row;
create policy row_share on public.sync_row for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

drop policy if exists join_request_share on public.sync_join_request;
create policy join_request_share on public.sync_join_request for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

drop policy if exists key_wrap_share on public.sync_key_wrap;
create policy key_wrap_share on public.sync_key_wrap for all to anon
  using      (link_id = public.request_share_id())
  with check (link_id = public.request_share_id());

-- Deferred, on purpose (see contract §Push and §Deferred): no presence table and
-- no plaintext push-token registry this round. Online-ness is "the write POST
-- succeeded"; push tokens live sealed in `sync_row` ('device:<id>'). Add a
-- presence table only when green-dot presence UI is actually built (P3+).
