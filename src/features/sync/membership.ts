/**
 * The membership lifecycle: invite → join request → owner-approves-by-name → key wrapped and
 * released; and remove-member → rotate the key.
 *
 * ═══ THE KEY IS NEVER IN THE INVITE ═══════════════════════════════════════════════
 * The old public-link model carried the data key in a link fragment (`link.ts`), which leaks
 * exactly like a link. v2 does NOT: an invite carries the relay coordinates and the OWNER's
 * PUBLIC key, no data key. The invitee posts a join request with ITS public key; the owner
 * approves BY NAME and only then wraps the profile key to that specific device's public key
 * (`keywrap.ts`). A stray join request is worthless without the owner's tap — that tap is the
 * safety gate this whole flow exists to place.
 *
 * ═══ REMOVAL MEANS ROTATION ═══════════════════════════════════════════════════════
 * Removing a member cannot retract what their phone already downloaded — the honest UI says so.
 * What removal DOES do is rotate the profile key (generation G+1), wrap G+1 to every REMAINING
 * device, and deliberately NOT wrap it to the removed one. That absence IS the revocation: every
 * row written after the rotation is generation G+1 and unreadable to the removed device.
 *
 * Owner-facing calls (mint/approve/remove/changeRole) THROW on failure — their caller is a user
 * action that can be shown the error. Invitee/background calls fail soft.
 */

import * as Crypto from 'expo-crypto';

import { getMember, listActiveMembers, markMemberRemoved, setMemberRole, upsertMember, getProfileShare, setProfileShare } from '../../db/repositories/members';
import { clientFor, REMOTE_TABLES, type RemoteJoinRequest, type RemoteKeyWrap } from './client';
import { getSyncConfig, setSyncConfig, type SyncConfig } from './config';
import { getOrCreateDeviceKeyPair, getDevicePublicKeyB64, parsePublicKeyB64 } from './deviceKey';
import { sealAnon, openAnon, wrapProfileKey, unwrapProfileKey } from './keywrap';
import { mintLinkId, toBase64Url, fromBase64Url } from './link';
import { normaliseRole, type SyncRole } from './merge';
import { getProfileKey, mintProfileKey, rotateProfileKey, setProfileKey } from './profileKey';
import { publishStreamRow, pullAndApplyShare, republishProfileStream, setPullHighWaterMark } from './rowStream';
import { base64ToBytes, bytesToBase64, utf8Bytes, bytesToUtf8 } from '../backup/bytes';

const random = (count: number): Uint8Array => Crypto.getRandomBytes(count);

// ── The invite ───────────────────────────────────────────────────────────────

/**
 * What an owner hands out. Carries the relay coordinates so an UNCONFIGURED invitee can reach
 * the postbox without hardcoding anything (C4), the profile's share id, and the owner's PUBLIC
 * key so the invitee can seal its device label to it. NO profile key.
 */
export type Invite = {
  readonly url: string;
  readonly anonKey: string;
  readonly shareId: string;
  readonly ownerPubKey: string;
  /**
   * The single pasteable string an owner sends and an invitee pastes. It packs the four fields
   * above after a `#` — so the UI's "copy the whole invite, including the part after the # sign"
   * is literally true, and a half-copy fails to parse rather than half-configuring. It carries
   * NO profile key.
   */
  readonly code: string;
};

/** The invitee's three-way result — same honesty as `testSyncConnection` (config.ts). */
export type JoinRequestOutcome = 'sent' | 'invalid' | 'unreachable';

const INVITE_PREFIX = 'aarogya-invite#';

/** Pack an invite into its pasteable code. base64url so it survives every chat app intact. */
function encodeInviteCode(fields: { url: string; anonKey: string; shareId: string; ownerPubKey: string }): string {
  return `${INVITE_PREFIX}${toBase64Url(utf8Bytes(JSON.stringify(fields)))}`;
}

/** Parse a pasted code back to an invite, or null for anything malformed (→ the UI's "invalid"). */
function parseInviteCode(code: string): Invite | null {
  const trimmed = code.trim();
  const hash = trimmed.indexOf('#');
  const payload = hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytesToUtf8(bytes)) as Record<string, unknown>;
    const url = parsed['url'];
    const anonKey = parsed['anonKey'];
    const shareId = parsed['shareId'];
    const ownerPubKey = parsed['ownerPubKey'];
    if (typeof url !== 'string' || typeof anonKey !== 'string' || typeof shareId !== 'string' || typeof ownerPubKey !== 'string') {
      return null;
    }
    return { url, anonKey, shareId, ownerPubKey, code: trimmed };
  } catch {
    return null;
  }
}

/**
 * Owner action. Ensures the profile has a share id + key + owner (minting all three on first
 * share, the per-profile analogue of `ensureShareKey`) and returns an invite payload.
 */
export async function mintInvite(profileId: string): Promise<Invite> {
  const config = await getSyncConfig();
  if (!config) throw new Error('mintInvite: sharing is not configured on this device');

  const share = await getProfileShare(profileId);
  if (!share) throw new Error('mintInvite: unknown profile');

  let shareId = share.shareId;
  if (!shareId || share.ownerDeviceId === null) {
    shareId = shareId ?? mintLinkId(random);
    // Mint the profile key (generation 1) BEFORE claiming ownership, so a crash cannot leave a
    // shared profile with no key its owner holds.
    if (!(await getProfileKey(shareId))) {
      await setProfileKey(shareId, mintProfileKey(random), 1);
    }
    await setProfileShare(profileId, { shareId, ownerDeviceId: config.deviceId });
    // The owner is member #0 of its own share.
    const pair = await getOrCreateDeviceKeyPair();
    await upsertMember({
      shareId,
      deviceId: config.deviceId,
      publicKey: bytesToBase64(pair.publicKey),
      deviceLabel: config.deviceLabel,
      role: 'owner',
      addedAtEpoch: Date.now(),
    });
  }

  const fields = { url: config.url, anonKey: config.anonKey, shareId, ownerPubKey: await getDevicePublicKeyB64() };
  return { ...fields, code: encodeInviteCode(fields) };
}

// ── The join request (invitee side) ────────────────────────────────────────────

/**
 * Invitee action. Parses the pasted invite CODE, configures the relay from it if needed, ensures
 * this device's keypair, and posts a join request: its public key in the clear (safe) and its
 * device label SEALED to the owner's public key (so the relay never sees "Priya's Redmi").
 *
 * Three-way result, because the fixes are opposite: a code that will not parse is 'invalid'
 * (re-paste the whole thing); a relay that will not answer is 'unreachable' (try again online) —
 * nothing about the code has been judged there. Does NOT touch `config.role`: a device can be
 * owner of one profile and a joiner of another, and its role for THIS share is learned from the
 * sealed `member:` row after approval.
 */
export async function postJoinRequest(code: string): Promise<JoinRequestOutcome> {
  const invite = parseInviteCode(code);
  if (!invite) return 'invalid';

  const ownerPub = parsePublicKeyB64(invite.ownerPubKey);
  if (!ownerPub) return 'invalid';

  await setSyncConfig({ url: invite.url, anonKey: invite.anonKey, enabled: true });
  const config = await getSyncConfig();
  if (!config) return 'unreachable';

  const pair = await getOrCreateDeviceKeyPair();
  const labelWrap = bytesToBase64(sealAnon(ownerPub, utf8Bytes(config.deviceLabel), random));

  const client = clientFor(config, invite.shareId);
  const response = await client.upsert(
    REMOTE_TABLES.joinRequest,
    [
      {
        link_id: invite.shareId,
        device_id: config.deviceId,
        device_pubkey: bytesToBase64(pair.publicKey),
        label_wrap: labelWrap,
        requested_at_epoch: Date.now(),
      },
    ],
    'link_id,device_id',
  );
  if (response.ok) return 'sent';
  // 'offline'/'timeout' = the relay never answered, so the code is not the thing to re-check.
  return response.error.kind === 'offline' || response.error.kind === 'timeout' ? 'unreachable' : 'invalid';
}

// ── Pending requests (owner side) ───────────────────────────────────────────────

export type PendingRequest = {
  readonly deviceId: string;
  readonly devicePubKey: string;
  /** The label, opened with the owner's private key. Null if it will not open (not for us). */
  readonly label: string | null;
  readonly requestedAtEpoch: number;
};

/** Owner polls the relay for join requests on its share and opens each label BY NAME. */
export async function listPendingRequests(shareId: string): Promise<readonly PendingRequest[]> {
  const config = await getSyncConfig();
  if (!config) return [];
  const client = clientFor(config, shareId);
  const response = await client.select<RemoteJoinRequest>('sync_join_request', 'order=requested_at_epoch.asc');
  if (!response.ok) return [];

  const pair = await getOrCreateDeviceKeyPair();
  return response.data.map((r) => {
    const wrap = safeBytes(r.label_wrap);
    const opened = wrap ? openAnon(pair.secretKey, wrap) : null;
    return {
      deviceId: r.device_id,
      devicePubKey: r.device_pubkey,
      label: opened ? bytesToUtf8(opened) : null,
      requestedAtEpoch: r.requested_at_epoch,
    };
  });
}

// ── The read-model the sharing screen renders (`src/app/sharing/[id].tsx`) ──────

export type MemberView = {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly role: SyncRole;
  readonly isSelf: boolean;
};

export type JoinRequestView = {
  readonly deviceId: string;
  readonly deviceLabel: string;
};

export type ShareView = {
  /** THIS device's role for THIS profile — the whole screen keys off it. */
  readonly myRole: SyncRole;
  /** The dataset id, or '' before the first invite has minted one. */
  readonly shareId: string;
  readonly members: readonly MemberView[];
  /** Non-empty only for an owner (only an owner can approve). */
  readonly pendingRequests: readonly JoinRequestView[];
};

/**
 * Assemble everything the sharing screen shows for one profile.
 *
 * An UNSHARED profile (no share_id yet) is this device's own — it reads as owner, sole member,
 * shareId '' — so the screen shows the "invite the first person" state. Once shared, the roster
 * and (for an owner) the live pending requests are read; a non-owner sees only the roster.
 */
export async function getShareView(profileId: string): Promise<ShareView> {
  const config = await getSyncConfig();
  const thisDeviceId = config?.deviceId ?? '';
  const share = await getProfileShare(profileId);
  const shareId = share?.shareId ?? '';

  if (!shareId) {
    return {
      myRole: 'owner',
      shareId: '',
      members: [{ deviceId: thisDeviceId, deviceLabel: config?.deviceLabel ?? 'This phone', role: 'owner', isSelf: true }],
      pendingRequests: [],
    };
  }

  const myRole: SyncRole =
    share!.ownerDeviceId === thisDeviceId ? 'owner' : normaliseRole((await getMember(shareId, thisDeviceId))?.role ?? 'viewer');

  const members: MemberView[] = (await listActiveMembers(shareId)).map((m) => ({
    deviceId: m.deviceId,
    deviceLabel: m.deviceLabel ?? 'A phone',
    role: m.role,
    isSelf: m.deviceId === thisDeviceId,
  }));

  const pendingRequests: JoinRequestView[] =
    myRole === 'owner'
      ? (await listPendingRequests(shareId)).map((r) => ({ deviceId: r.deviceId, deviceLabel: r.label ?? 'A phone' }))
      : [];

  return { myRole, shareId, members, pendingRequests };
}

// ── Approve / deny (owner side) ─────────────────────────────────────────────────

/**
 * Approve a join request as a role. In one flow: wrap the CURRENT-generation key to the joining
 * device's public key, add it to the local roster, publish the sealed `member:` row so siblings
 * learn who joined, and delete the handled request. Throws if the share has no key or the
 * request's public key is malformed — the caller is an owner tap that can be told it failed.
 */
export async function approve(shareId: string, deviceId: string, role: SyncRole, devicePubKeyB64?: string): Promise<void> {
  const config = await getSyncConfig();
  if (!config) throw new Error('approve: sharing is not configured');
  const keyState = await getProfileKey(shareId);
  if (!keyState) throw new Error('approve: this device does not hold the profile key');

  // Trust the passed pubkey if given (owner already sees it in the approval prompt); otherwise
  // re-fetch it from the pending request.
  let pubB64 = devicePubKeyB64;
  let label: string | null = null;
  if (!pubB64) {
    const pending = (await listPendingRequests(shareId)).find((r) => r.deviceId === deviceId);
    if (!pending) throw new Error('approve: the join request is no longer there');
    pubB64 = pending.devicePubKey;
    label = pending.label;
  }
  const recipientPub = parsePublicKeyB64(pubB64);
  if (!recipientPub) throw new Error('approve: the joining device sent a malformed public key');

  const client = clientFor(config, shareId);

  // (a) release the wrapped key at the current generation.
  const wrap = bytesToBase64(wrapProfileKey(keyState.key, recipientPub, random));
  const wrapResponse = await client.upsert(
    REMOTE_TABLES.keyWrap,
    [{ link_id: shareId, device_id: deviceId, key_generation: keyState.generation, wrap, wrapped_at_epoch: Date.now() }],
    'link_id,device_id,key_generation',
  );
  if (!wrapResponse.ok) throw new Error('approve: could not release the key wrap');

  // (b) local roster + (c) sealed roster row for siblings.
  await upsertMember({ shareId, deviceId, publicKey: pubB64, deviceLabel: label, role, addedAtEpoch: Date.now() });
  await publishMemberRow(config, shareId, keyState.key, keyState.generation, { deviceId, role, label, publicKey: pubB64 });

  // (d) the request is handled.
  await client.remove('sync_join_request', `device_id=eq.${encodeURIComponent(deviceId)}`);
}

/** Deny a join request: just delete it. No wrap, so no key ever leaves for that device. */
export async function deny(shareId: string, deviceId: string): Promise<void> {
  const config = await getSyncConfig();
  if (!config) return;
  const client = clientFor(config, shareId);
  await client.remove('sync_join_request', `device_id=eq.${encodeURIComponent(deviceId)}`);
}

// ── Accept the wrapped key (invitee/member side, §4.2 step 4) ────────────────────

/**
 * Install the wrapped profile key the owner released — the member half of the invite handshake.
 *
 * This is the ONLY reader of `sync_key_wrap`. The owner's `approve`/`removeMember` WRITE wraps;
 * nothing consumed them until here, which meant an approved manager/viewer never obtained the key
 * (P1 had no reader end to end) and a rotation's generation-G+1 re-wrap was never picked up (every
 * remaining member froze at generation G). It SELECTs the highest-generation wrap addressed to
 * THIS device — RLS already scopes `sync_key_wrap` to this share via the X-Share-Id header — opens
 * it with the device's private key, and stores it at that generation.
 *
 * Returns true only when a generation NEWER than this device already holds was installed; the
 * caller (the app-open sweep) then leaves the follow-on pull to re-read the stream. On a fresh
 * install it resets the pull cursor so the whole stream is (re-)pulled under the key just gained;
 * after a rotation the same reset re-pulls the republished, G+1-encrypted rows that would
 * otherwise sit unread below the old high-water mark.
 *
 * Fails soft — an unconfigured phone, a network miss, or a wrap that will not open (not for us, or
 * tampered) all return false, never throw. It runs from a background pass (appOpen), not a user tap.
 */
export async function acceptProfileKeyWrap(shareId: string): Promise<boolean> {
  const config = await getSyncConfig();
  if (!config) return false;

  const current = await getProfileKey(shareId);
  const pair = await getOrCreateDeviceKeyPair();
  const client = clientFor(config, shareId);

  const response = await client.select<RemoteKeyWrap>(
    REMOTE_TABLES.keyWrap,
    `device_id=eq.${encodeURIComponent(config.deviceId)}&order=key_generation.desc&limit=1`,
  );
  if (!response.ok || response.data.length === 0) return false;

  const wrap = response.data[0]!;
  // Already hold this generation (or newer) — the common path on a settled member, every open.
  // Crucially this must NOT reset the cursor: doing so on every open would re-pull the world.
  if (current && current.generation >= wrap.key_generation) return false;

  const blob = safeBytes(wrap.wrap);
  if (!blob) return false;
  const key = unwrapProfileKey(blob, pair.secretKey);
  // null = not addressed to us, wrong length, or tampered — openAnon/the length guard already
  // said no. Never install such bytes as a key.
  if (!key) return false;

  await setProfileKey(shareId, key, wrap.key_generation);
  await setPullHighWaterMark(shareId, 0);
  return true;
}

// ── Change role / remove (owner side) ───────────────────────────────────────────

/** Change a member's role and re-publish its roster row so siblings see the new role. */
export async function changeRole(shareId: string, deviceId: string, role: SyncRole): Promise<void> {
  const config = await getSyncConfig();
  if (!config) throw new Error('changeRole: sharing is not configured');
  const keyState = await getProfileKey(shareId);
  if (!keyState) throw new Error('changeRole: this device does not hold the profile key');
  const member = await getMember(shareId, deviceId);
  await setMemberRole(shareId, deviceId, role);
  await publishMemberRow(config, shareId, keyState.key, keyState.generation, {
    deviceId,
    role,
    label: member?.deviceLabel ?? null,
    publicKey: member?.publicKey ?? null,
  });
}

/**
 * Remove a member, then rotate the key so future ciphertext is unreadable to them (§4.3).
 *
 * Order matters and is stated in the code: stamp removed → rotate → re-wrap to everyone
 * REMAINING → republish the whole stream under the new key → delete the removed device's wraps
 * and roster/device rows. The removed device keeps generation G and whatever it already fetched;
 * every row written after this is generation G+1 and dark to it.
 *
 * WHAT ROTATION DOES AND DOES NOT REVOKE — the honest boundary the UI must not overstate.
 * Rotation revokes future READ confidentiality: the removed device's generation-G key opens
 * nothing written from now on. It does NOT revoke relay ACCESS. The relay (Supabase) authorises
 * on the share id + the shared anon key alone (RLS filters `link_id = request_share_id()`, no
 * per-device auth — that is the blind-postbox design, LOCKED). Both rode in the invite, so a
 * removed device keeps the ability to WRITE and DELETE this share's ciphertext rows via raw
 * PostgREST: it can vandalise or wipe the stream (a nuisance the owner's local DB re-publishes
 * from, never a data loss on the owner) even though it can no longer READ new content. Role
 * limits (viewer read-only, manager online-only) are the same shape: enforced among cooperating
 * key-holders, not by the relay. Making removal/roles relay-ENFORCED needs per-device Supabase
 * auth or reader-verified writer signatures — neither is this round. Do not claim the removed
 * phone "can no longer touch" the data; claim only that it can no longer SEE changes.
 */
export async function removeMember(shareId: string, deviceId: string): Promise<void> {
  const config = await getSyncConfig();
  if (!config) throw new Error('removeMember: sharing is not configured');
  if (deviceId === config.deviceId) throw new Error('removeMember: an owner cannot remove itself; transfer ownership first');

  // 0. Pull first, so the local db already holds every remaining member's latest edit before we
  //    re-encrypt the whole stream from it. Skipping this could republish a stale local copy over
  //    a manager's newer row (the republish stamps fresh millis, so it would win). Best-effort:
  //    an offline owner can still rotate — it just republishes what it currently holds.
  await pullAndApplyShare(shareId);

  // 1. Stamp removed locally (the row stays — a later rotation must know NOT to re-wrap to it).
  await markMemberRemoved(shareId, deviceId, Date.now());

  // 2. New key, generation G+1.
  const rotated = await rotateProfileKey(shareId);

  // 3. Wrap G+1 to every remaining member (self included) — and to NOBODY else.
  const client = clientFor(config, shareId);
  const remaining = await listActiveMembers(shareId);
  const wraps: Record<string, unknown>[] = [];
  for (const member of remaining) {
    const pub = member.publicKey ? parsePublicKeyB64(member.publicKey) : null;
    if (!pub) continue; // a member with no stored pubkey cannot be re-wrapped here; it re-requests
    wraps.push({
      link_id: shareId,
      device_id: member.deviceId,
      key_generation: rotated.generation,
      wrap: bytesToBase64(wrapProfileKey(rotated.key, pub, random)),
      wrapped_at_epoch: Date.now(),
    });
  }
  if (wraps.length > 0) {
    const wrapResponse = await client.upsert(REMOTE_TABLES.keyWrap, wraps, 'link_id,device_id,key_generation');
    if (!wrapResponse.ok) throw new Error('removeMember: could not re-wrap the rotated key to remaining members');
  }

  // 4. Republish the whole stream re-encrypted under G+1 (so the removed device's G key is dark).
  await republishProfileStream(shareId);

  // 5. Delete the removed device's wraps and its roster/device rows.
  await client.remove('sync_key_wrap', `device_id=eq.${encodeURIComponent(deviceId)}`);
  await client.remove('sync_row', `row_key=eq.${encodeURIComponent(`member:${deviceId}`)}`);
  await client.remove('sync_row', `row_key=eq.${encodeURIComponent(`device:${deviceId}`)}`);
}

// ── The sealed roster row ───────────────────────────────────────────────────────

export type MemberRowValue = {
  readonly deviceId: string;
  readonly role: SyncRole;
  readonly label: string | null;
  readonly publicKey: string | null;
};

/** Publish one `member:<id>` row, sealed under the profile key, so siblings learn the roster. */
async function publishMemberRow(
  config: SyncConfig,
  shareId: string,
  key: Uint8Array,
  generation: number,
  value: MemberRowValue,
): Promise<void> {
  await publishStreamRow(config, shareId, key, generation, config.deviceId, `member:${value.deviceId}`, value);
}

function safeBytes(text: string): Uint8Array | null {
  try {
    return base64ToBytes(text);
  } catch {
    return null;
  }
}
