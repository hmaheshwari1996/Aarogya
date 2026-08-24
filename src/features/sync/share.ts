/**
 * The share link: minting it, showing it, and rotating it.
 *
 * ═══ ONE LINK PER PROFILE, AND THE LINK IS THE CREDENTIAL ═════════════════════════
 *
 * There is no invitation, no approval queue and no viewer list. The patient has ONE link.
 * She sends it to whoever she wants, however she wants — WhatsApp, a text message, reading
 * it out over the phone — and whoever holds it can read her record.
 *
 * That is a deliberate trade, and the screen that shows the link says so in those words:
 * share it the way you would share a house key. What replaces per-viewer revocation is
 * `rotateShareLink()`, which mints a new key AND a new id and deletes the old dataset, so
 * every link ever sent stops working at the same moment.
 *
 * ─── WHY BOTH HALVES ARE REPLACED ─────────────────────────────────────────────────
 * Either one alone would be enough. Changing the id leaves the old link pointing at
 * nothing; changing the key leaves it pointing at rows it cannot open. Doing both means a
 * mistake in the delete — a row missed, a policy that silently allowed it to survive — is
 * not sufficient on its own to hand somebody the record back.
 *
 * ─── THE KEY, EVERY TIME IT IS TOUCHED ────────────────────────────────────────────
 * Never logged. Never in a query string or a path segment. Never in a request body. It
 * exists in three places only: the keystore (`./crypto.ts`), the fragment of the string
 * handed to the share sheet, and the memory of the phone that opened the link.
 *
 * ─── UNCONFIGURED HOST IS NOT AN ERROR ────────────────────────────────────────────
 * `extra.inviteHost` is optional. With no host, `shareLinkUrl()` returns null and the
 * screen falls back to the hostless CODE — the same two values, pasteable into the
 * viewer's box. Nothing throws, nothing is broken, and the feature works end to end with
 * nothing hosted anywhere.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

import * as SecureStore from 'expo-secure-store';

import { createPatientClient, eq, REMOTE_TABLES } from './client';
import { getShareKey, rotateShareKey, ensureShareKey, shareKeyToFragmentValue } from './crypto';
import {
  isShareHostConfigured,
  parseShareLink,
  shareCode,
  shareOrigin,
  shareUrl,
  type ShareLinkParts,
} from './link';
import { republishRecords } from './outbox';
import { publishSnapshot } from './snapshot';

export class SyncNotConfiguredError extends Error {
  constructor() {
    super('Sharing has not been set up on this phone yet.');
    this.name = 'SyncNotConfiguredError';
  }
}

// ── The disclosure ───────────────────────────────────────────────────────────

/**
 * Shown before the rotate confirm. Not optional, not paraphrasable, not a tooltip.
 *
 * Written for someone reading it on a small screen while upset. Short sentences, no
 * conditionals, and the limitation stated BEFORE the reassurance — a reader who stops after
 * the first line should stop having read the part that is easy to get wrong.
 *
 * A public link changes the shape of the honest statement in two ways, and both are in
 * here: rotation cannot retrieve anything already fetched, decrypted, screenshotted or
 * saved to somebody's phone; and it cuts off EVERYBODY at once, because the app does not
 * know who was given the old link and cannot stop one person without stopping all of them.
 */
export const REVOKE_DISCLOSURE = {
  i18nKey: 'sharing.rotateDisclosure',
  en:
    'A new link works from now on. It cannot undo what anyone has already seen. Anything ' +
    'their phone already fetched, saved, took a picture of, or passed on to somebody else ' +
    'stays with them. And it stops everybody at the same moment — every person you sent ' +
    'the old link to will lose it, so you will have to send them the new one.',
  hi:
    'नया लिंक अब से काम करता है। जो किसी ने पहले देख लिया है, वह वापस नहीं लिया जा सकता। ' +
    'जो कुछ उनके फोन तक पहले पहुँच चुका है, सहेजा जा चुका है, जिसका स्क्रीनशॉट लिया गया है या ' +
    'जिसे आगे भेजा जा चुका है, वह उनके पास ही रहेगा। और यह सबका देखना एक साथ बंद कर देता है — ' +
    'जिन्हें भी आपने पुराना लिंक भेजा था, सबका देखना बंद हो जाएगा, इसलिए नया लिंक आपको सबको भेजना होगा।',
} as const;

// ── The patient's link ───────────────────────────────────────────────────────

export type ShareLink = ShareLinkParts & {
  /** How many times this profile has rotated. Diagnostics only. */
  readonly generation: number;
};

/** The current link, or null when sharing has never been switched on. */
export async function getShareLink(): Promise<ShareLink | null> {
  const state = await getShareKey();
  if (!state) return null;
  // The key is turned into its fragment form here and nowhere else on the read path.
  // Never log this value.
  return {
    linkId: state.linkId,
    keyB64url: shareKeyToFragmentValue(state.key),
    generation: state.generation,
  };
}

/**
 * The link, minting it on first use.
 *
 * THROWS when sync is not configured, unlike the background paths in this feature which
 * no-op. The distinction is deliberate: somebody who just opened the Sharing screen has
 * asked for something specific and is owed an answer, whereas a drain that fires on
 * app-open on a phone that never enabled sync should say nothing at all.
 */
export async function ensureShareLink(): Promise<ShareLink> {
  const client = await createPatientClient();
  if (!client) throw new SyncNotConfiguredError();

  const state = await ensureShareKey();
  // NOT awaited. The link has to be on screen immediately — a phone on a corridor
  // connection would otherwise sit on a spinner for the full request timeout before
  // showing something that was ready locally in a millisecond. `publishSnapshot` never
  // throws, so there is nothing here to catch.
  void publishSnapshot();
  return {
    linkId: state.linkId,
    keyB64url: shareKeyToFragmentValue(state.key),
    generation: state.generation,
  };
}

/**
 * The full URL, or null when no host is configured.
 *
 * Null rather than a throw, and null rather than a link against the placeholder host: a
 * broken link is far more expensive than a missing one, because it is shared once, to a
 * person who then cannot get in and has no idea why. The screen shows `shareLinkCode()`
 * instead and explains that it has to be pasted.
 */
export function shareLinkUrl(link: ShareLinkParts): string | null {
  if (!isShareHostConfigured()) return null;
  return shareUrl(shareOrigin(), link);
}

/** The hostless `<linkId>#k=<key>` form. Always available. Never logged. */
export function shareLinkCode(link: ShareLinkParts): string {
  return shareCode(link);
}

/** What the share sheet and the clipboard get: the URL when there is one, else the code. */
export function shareableText(link: ShareLinkParts): string {
  return shareLinkUrl(link) ?? shareLinkCode(link);
}

export type RotateResult = {
  readonly link: ShareLink;
  /**
   * False when the old dataset could not be deleted — the phone was offline, or the server
   * refused. The new link works either way, but until this succeeds the OLD link may still
   * open the old rows, and the screen has to say so rather than claim a clean break.
   */
  readonly oldDataRemoved: boolean;
};

/**
 * Kills every link ever shared, and issues a new one.
 *
 * THE ORDER IS THE POLICY:
 *
 *   1. DELETE the old dataset first. Doing this before the rotation means a failure
 *      anywhere later leaves the old rows gone — the safe direction. The opposite order
 *      would leave a phone that has moved on to a new key while the old rows, still
 *      openable by the old key, sit on the server that the old link points at.
 *   2. Rotate the key and the id together, in one keystore write (`./crypto.ts`).
 *   3. Re-encrypt and publish the snapshot under the new id and the new key — awaited,
 *      because it is one row and it is what the new link actually opens.
 *   4. Re-encrypt and publish the record stream the same way — NOT awaited. A family with
 *      six months of history is thousands of rows and minutes of round trips on a corridor
 *      connection, and rotation is what somebody does the moment a link has gone where it
 *      should not. Holding that button for minutes is not acceptable, and nothing reads
 *      the record stream yet.
 *
 * Steps 3 and 4 are recoverable by publishing again; step 1 is the only one that cannot be
 * undone, which is why it is the one that happens while there is still a user watching a
 * spinner.
 */
export async function rotateShareLink(): Promise<RotateResult> {
  const client = await createPatientClient();
  if (!client) throw new SyncNotConfiguredError();

  const previous = await getShareKey();
  let oldDataRemoved = true;

  if (previous) {
    // Both tables, both keyed by the OLD id. The key never appears in either filter — a
    // link id is an opaque name and is the only half of the link the server ever sees.
    const removedRecords = await client.remove(REMOTE_TABLES.record, eq('link_id', previous.linkId));
    const removedShare = await client.remove(REMOTE_TABLES.share, eq('link_id', previous.linkId));
    oldDataRemoved = removedRecords.ok && removedShare.ok;
    if (!oldDataRemoved) {
      console.warn('[sync] the old shared data could not be deleted; the old link may still work');
    }
  }

  const rotated = await rotateShareKey();
  await publishSnapshot();
  // See the header, step 4. `republishRecords` never throws, so there is nothing to catch.
  void republishRecords();

  return {
    link: {
      linkId: rotated.linkId,
      keyB64url: shareKeyToFragmentValue(rotated.key),
      generation: rotated.generation,
    },
    oldDataRemoved,
  };
}

// ── The viewer's side ────────────────────────────────────────────────────────

const VIEWER_LINK_ENTRY = 'aarogya_sync_viewer_link';

/**
 * The link this phone was given, kept in the keystore.
 *
 * It holds the key, so it belongs in `expo-secure-store` and not in `app_meta` — the same
 * reasoning that keeps the patient's own key out of the database. Never logged.
 */
export async function saveViewerLink(link: ShareLinkParts): Promise<void> {
  await SecureStore.setItemAsync(
    VIEWER_LINK_ENTRY,
    JSON.stringify({ linkId: link.linkId, keyB64url: link.keyB64url }),
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
  );
}

export async function getViewerLink(): Promise<ShareLinkParts | null> {
  try {
    const raw = await SecureStore.getItemAsync(VIEWER_LINK_ENTRY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const linkId = record['linkId'];
    const keyB64url = record['keyB64url'];
    if (typeof linkId !== 'string' || typeof keyB64url !== 'string') return null;
    return { linkId, keyB64url };
  } catch (error) {
    // The message can never carry the key: nothing here interpolates it.
    console.warn('[sync] could not read the saved link', error instanceof Error ? error.name : '');
    return null;
  }
}

export async function forgetViewerLink(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(VIEWER_LINK_ENTRY);
  } catch {
    // Nothing useful to say and nobody to say it to. The screen already moved on.
  }
}

/**
 * Reads a link a family member pasted or tapped, and remembers it.
 *
 * Returns null for anything unreadable rather than throwing, because the input is whatever
 * happened to be on somebody's clipboard.
 */
export async function acceptViewerLink(input: string): Promise<ShareLinkParts | null> {
  const parsed = parseShareLink(input);
  if (!parsed) return null;
  await saveViewerLink(parsed);
  return parsed;
}

// ── App Links ────────────────────────────────────────────────────────────────

/**
 * The Digital Asset Links file that makes the share link a VERIFIED App Link.
 *
 * Emitted as a function rather than a checked-in file because the SHA-256 fingerprint
 * belongs to the signing keystore, which is not in this repository and must not be. Host
 * the output at `https://<user>.github.io/.well-known/assetlinks.json` — note the
 * well-known path is at the SITE root, not under `/aarogya/`, which is the single most
 * common reason autoVerify silently fails.
 *
 * The template and the verification checklist are in `docs/SYNC-AND-BACKUP.md`.
 */
export function assetLinksJson(
  sha256Fingerprints: readonly string[],
  packageName = 'in.aarogya.care',
): string {
  return `${JSON.stringify(
    [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: packageName,
          sha256_cert_fingerprints: sha256Fingerprints,
        },
      },
    ],
    null,
    2,
  )}\n`;
}
