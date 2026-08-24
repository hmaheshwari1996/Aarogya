/**
 * The share link: its grammar, and the rule that the key lives in the fragment.
 *
 * ═══ THE KEY IS IN THE FRAGMENT, AND THE FRAGMENT IS NEVER SENT ═══════════════════
 *
 *   https://<host>/aarogya/v/<linkId>#k=<base64url 32-byte key>
 *                              ▲                ▲
 *                              │                └─ never leaves the phone that holds it
 *                              └─ names the encrypted dataset on the server
 *
 * Everything after `#` is stripped by every HTTP client before a request is made — it is
 * not in the request line, not in a header, not in the Referer. That is what makes this a
 * "secret link": Supabase stores ciphertext and an opaque id and never sees the key, while
 * anybody holding the whole link can decrypt.
 *
 * SO THE LINK IS THE CREDENTIAL. That is the intended behaviour, not an oversight. Whoever
 * holds it can read the record; if it leaks, the answer is `rotateShareLink()`, which mints
 * a new id AND a new key and deletes the old dataset.
 *
 * THREE RULES FOR THE KEY, WHEREVER IT IS TOUCHED:
 *   1. Never logged.
 *   2. Never put in a query string or a path segment.
 *   3. Never sent in a request body.
 * Every place in this feature that handles the key repeats them, because the whole design
 * collapses the first time one of them is broken and nothing would report it.
 *
 * PURE. No storage, no network, no clock; randomness is injected. `node --test` loads this
 * file directly — see `./sync.test.ts`.
 * ══════════════════════════════════════════════════════════════════════════════════
 */

import { base64ToBytes, bytesToBase64 } from '../backup/bytes';
import { SHARE_KEY_BYTES } from './sealed';

/** The path the link is served from. Mirrored by `android.intentFilters` in app.config.ts. */
export const SHARE_PATH_PREFIX = '/aarogya/v';

// ── The host ─────────────────────────────────────────────────────────────────

/**
 * GitHub Pages, free, and an HTTPS Android App Link rather than a custom scheme.
 *
 * A `aarogya://` scheme link is not tappable in most chat apps and is trivially hijacked by
 * any other app declaring the same scheme. A verified App Link is checked against
 * `assetlinks.json` on the host, so only a build signed with the right certificate can
 * claim it — and if the app is not installed the link opens a web page that explains what
 * it is, which is the right outcome for a family member who has not installed anything yet.
 *
 * THE HOST IS OPTIONAL. Left at the placeholder, `isShareHostConfigured()` stays false and
 * the app shares the hostless code instead. Nothing throws and nothing is broken.
 */
const PLACEHOLDER_HOST = 'REPLACE-ME.github.io';

/**
 * Injected by `./config.ts`, which owns the single `expo-constants` read.
 *
 * It lives in THIS module, which imports nothing but the pure codecs, rather than in
 * `./share.ts`. `config.ts` has to import whatever holds it, and `share.ts` reaches
 * `config.ts` again through `./client` — an import cycle in which `config`'s module body
 * runs while the other file's `let` is still in its temporal dead zone, which is a
 * start-up crash that only appears once something imports the feature barrel. A leaf
 * module cannot be in that cycle.
 */
let configuredHost: string = PLACEHOLDER_HOST;

export function setShareHost(host: string | null | undefined): void {
  if (typeof host === 'string' && host.trim().length > 0) {
    configuredHost = host.trim();
  }
}

export function shareOrigin(): string {
  return `https://${configuredHost}`;
}

export function isShareHostConfigured(): boolean {
  return configuredHost !== PLACEHOLDER_HOST;
}

/**
 * 128 bits of link id.
 *
 * Not a UUID: this id is typed and read aloud far less often than it is tapped, but it does
 * end up in a URL next to a 43-character key, and 22 base64url characters keeps the whole
 * thing inside what a chat app renders as one line. It is random and opaque — it names a
 * dataset and says nothing about the family.
 */
export const LINK_ID_BYTES = 16;

/** The fragment parameter. One letter, because it is read aloud when a link is dictated. */
const KEY_PARAM = 'k';

export type ShareLinkParts = {
  readonly linkId: string;
  /**
   * The data key, base64url.
   *
   * NEVER log this, never put it in a query string, never send it in a request body.
   */
  readonly keyB64url: string;
};

// ── base64url ────────────────────────────────────────────────────────────────

/**
 * base64url, unpadded — RFC 4648 §5.
 *
 * Plain base64 cannot go in a URL: `+` and `/` are meaningful there and `=` gets
 * percent-encoded by half the chat apps a link travels through, which turns a working link
 * into one that fails to decrypt for a reason nobody can see.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Null rather than a throw: this parses attacker-supplied text from a pasted box. */
export function fromBase64Url(text: string): Uint8Array | null {
  const cleaned = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length === 0 || /[^A-Za-z0-9+/=]/.test(cleaned)) return null;
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    return base64ToBytes(padded);
  } catch {
    return null;
  }
}

// ── Minting ──────────────────────────────────────────────────────────────────

export function mintLinkId(random: (count: number) => Uint8Array): string {
  const bytes = random(LINK_ID_BYTES);
  if (bytes.length !== LINK_ID_BYTES) throw new Error('The random source returned a short link id.');
  return toBase64Url(bytes);
}

export function mintShareKey(random: (count: number) => Uint8Array): Uint8Array {
  const bytes = random(SHARE_KEY_BYTES);
  if (bytes.length !== SHARE_KEY_BYTES) throw new Error('The random source returned a short key.');
  return bytes;
}

export function isWellFormedLinkId(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function isWellFormedShareKey(keyB64url: string): boolean {
  const bytes = fromBase64Url(keyB64url);
  return bytes !== null && bytes.length === SHARE_KEY_BYTES;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * The full link. `origin` is `https://host`, with no trailing slash.
 *
 * The key goes after the `#` and nowhere else. Building this string is the ONLY place in
 * the app where the key and a URL meet.
 */
export function shareUrl(origin: string, parts: ShareLinkParts): string {
  return `${origin}${SHARE_PATH_PREFIX}/${parts.linkId}#${KEY_PARAM}=${parts.keyB64url}`;
}

/**
 * The hostless form, for a phone with no link host configured.
 *
 * `<linkId>#k=<key>` is pasteable into the viewer's box and carries exactly the same two
 * values as the URL. It exists so the feature works end to end with nothing hosted
 * anywhere — see `shareLinkUrl()` in `./share.ts`, which returns null rather than minting a
 * link that could never resolve.
 */
export function shareCode(parts: ShareLinkParts): string {
  return `${parts.linkId}#${KEY_PARAM}=${parts.keyB64url}`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Reads a link, a path, or a bare `<linkId>#k=<key>` code.
 *
 * DELIBERATELY HOST-AGNOSTIC. The patient's phone and the viewer's phone are different
 * installs and only the patient's needs a host configured, so refusing a link because its
 * host is not the one THIS build was compiled with would break the ordinary case: a
 * daughter-in-law pasting a link into a phone that has never been set up for sharing at all.
 * Nothing is trusted on the strength of the host anyway — the id names a dataset and the key
 * either decrypts it or does not.
 *
 * Returns null for anything it cannot read, and never throws.
 */
export function parseShareLink(input: string): ShareLinkParts | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const hash = trimmed.indexOf('#');
  if (hash < 0) return null;

  const before = trimmed.slice(0, hash);
  const fragment = trimmed.slice(hash + 1);

  const keyB64url = readKeyFromFragment(fragment);
  if (!keyB64url) return null;

  const linkId = readLinkId(before);
  if (!linkId) return null;

  return { linkId, keyB64url };
}

/** `k=…`, or `…&k=…`, or a bare key. Tolerant, because this is pasted by hand. */
function readKeyFromFragment(fragment: string): string | null {
  for (const part of fragment.split('&')) {
    const [name, ...rest] = part.split('=');
    if (name === KEY_PARAM && rest.length > 0) {
      const value = rest.join('=').trim();
      return isWellFormedShareKey(value) ? value : null;
    }
  }
  const bare = fragment.trim();
  return isWellFormedShareKey(bare) ? bare : null;
}

/** The last non-empty path segment, whether or not there is a scheme and host in front. */
function readLinkId(before: string): string | null {
  const withoutQuery = before.split('?')[0] ?? '';
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  const candidate = segments[segments.length - 1];
  if (!candidate) return null;
  // A scheme-only string ('https:') leaves 'https:' as the last segment; the character
  // class below rejects it, along with a host that was mistaken for an id.
  return isWellFormedLinkId(candidate) ? candidate : null;
}
