/**
 * Push — the SEND side, built fully. A plain `fetch` to Expo's relay, no backend of ours.
 *
 * ═══ ONE RINGER, EVERYONE GETS A PUSH ═════════════════════════════════════════════
 * The OWNER device rings (the Kotlin alarm layer) AND is a push target; managers/viewers get
 * push ONLY, never a local alarm (C3). When the owner's alarm fires, it POSTs a CONTENT-FREE
 * ping to sibling device tokens — the receiving phone already holds the encrypted record and
 * renders detail locally, so NO medical fact ever rides in the payload. A drug name in a push
 * title is a diagnosis on a lock screen.
 *
 * ═══ NO SECRET, EVER (C4) ═════════════════════════════════════════════════════════
 * Expo's push relay needs no auth header to SEND, which is exactly why the send side is built
 * against it: FCM HTTP v1 would need a service-account credential = a secret in the app. Sibling
 * tokens live SEALED in the `sync_row` stream (`device:<id>` rows), so the relay never sees an
 * Expo token (a stable per-device tracker + spam vector) and only key-holders can read them.
 *
 * ═══ THE RECEIVE SIDE IS NOT HERE (F5) ════════════════════════════════════════════
 * `expo-notifications` stays BANNED (a second scheduler double-fires a dose). The receive path
 * is a decision, recommended as a native receive-only FCM channel `family_ping_v1`, and is NOT
 * built this round. `src/constants/channels.js` reserves the id.
 *
 * `sendFamilyPing` is a pure fetch (global `fetch`, stubbed in `push.test.ts`); the token
 * publish/gather helpers are device-gated (they reach the stream + secure store).
 */

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Expo caps a single send at 100 messages. */
const MAX_BATCH = 100;

export type PushTarget = { readonly expoPushToken: string };

export type FamilyPing = {
  /** A NAME or COUNT at most — e.g. "Mother's medicine". NEVER a drug, dose, or reading. */
  readonly titleKey: string;
  /** The receive-only channel the heads-up shows on (see F5 / channels.js). */
  readonly channelId: string;
};

export type PingResult = { readonly sent: number; readonly invalidTokens: readonly string[] };

/**
 * POST a content-free ping to every target token, in batches of 100.
 *
 * Returns how many were accepted and which tokens the relay says are dead
 * (`DeviceNotRegistered` / `InvalidCredentials`), so the caller can prune that device's
 * `device:<id>` row. NEVER throws — a failed ping is logged and dropped by the caller (this must
 * never break the owner's alarm path). The payload carries `title` + `channelId` and NOTHING
 * that names a medicine.
 */
export async function sendFamilyPing(
  targets: readonly PushTarget[],
  ping: FamilyPing,
  now: number = Date.now(),
): Promise<PingResult> {
  void now; // reserved for future de-dupe of rapid re-pings; the payload is timeless on purpose
  const tokens = targets.map((t) => t.expoPushToken).filter((t) => typeof t === 'string' && t.length > 0);
  if (tokens.length === 0) return { sent: 0, invalidTokens: [] };

  let sent = 0;
  const invalidTokens: string[] = [];

  for (let start = 0; start < tokens.length; start += MAX_BATCH) {
    const batch = tokens.slice(start, start + MAX_BATCH);
    const messages = batch.map((to) => ({
      to,
      title: ping.titleKey,
      channelId: ping.channelId,
      priority: 'high' as const,
      // No `body` field: the alert is content-free. `sound: null` because the RECEIVER never
      // rings an alarm — only the owner's Kotlin layer does (C3); this is a quiet heads-up.
      sound: null,
    }));

    let receipts: PushReceipt[];
    try {
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!response.ok) continue; // a 5xx/429 from Expo: drop this batch, the alarm still rang locally
      const parsed = (await response.json()) as { data?: PushReceipt[] };
      receipts = Array.isArray(parsed.data) ? parsed.data : [];
    } catch {
      continue; // offline / dropped socket — the ping is best-effort, never a throw
    }

    receipts.forEach((receipt, index) => {
      const token = batch[index];
      if (!token) return;
      if (receipt.status === 'ok') {
        sent += 1;
      } else if (isDeadToken(receipt)) {
        invalidTokens.push(token);
      }
    });
  }

  return { sent, invalidTokens };
}

type PushReceipt = {
  status?: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};

/** A token the relay says will never deliver again — prune its device row. */
function isDeadToken(receipt: PushReceipt): boolean {
  const code = receipt.details?.error;
  if (code === 'DeviceNotRegistered' || code === 'InvalidCredentials') return true;
  // Older receipts put the code only in the message.
  const message = receipt.message ?? '';
  return message.includes('DeviceNotRegistered') || message.includes('InvalidCredentials');
}

// ── Device-token publish / gather (device-gated) ────────────────────────────────

export type DeviceRowValue = {
  readonly deviceId: string;
  readonly label: string | null;
  /** The Expo push token this device is reachable at. Re-published each app-open (tokens rotate). */
  readonly expoPushToken: string;
};

/**
 * Publish THIS device's `device:<id>` row (token + label) into a share's stream, sealed under
 * the profile key. Call on each app-open for every share this device is a member of, so sibling
 * owners can reach it. Returns false quietly when unconfigured / not a member / no token.
 */
export async function publishDeviceToken(shareId: string, expoPushToken: string): Promise<boolean> {
  if (!expoPushToken) return false;
  const [{ getSyncConfig }, { getProfileKey }, { publishStreamRow }] = await Promise.all([
    import('./config'),
    import('./profileKey'),
    import('./rowStream'),
  ]);
  const config = await getSyncConfig();
  if (!config) return false;
  const keyState = await getProfileKey(shareId);
  if (!keyState) return false;
  const value: DeviceRowValue = { deviceId: config.deviceId, label: config.deviceLabel, expoPushToken };
  return publishStreamRow(config, shareId, keyState.key, keyState.generation, config.deviceId, `device:${config.deviceId}`, value);
}

/**
 * Owner reads sibling push tokens from the decrypted `device:` rows of a share (this device
 * excluded — the owner rings, it does not push itself). Device-gated: reaches the stream + key.
 */
export async function gatherPushTargets(shareId: string): Promise<readonly PushTarget[]> {
  const [{ getSyncConfig }, { getProfileKey }, { readStreamRowsByPrefix }] = await Promise.all([
    import('./config'),
    import('./profileKey'),
    import('./rowStream'),
  ]);
  const config = await getSyncConfig();
  if (!config) return [];
  const keyState = await getProfileKey(shareId);
  if (!keyState) return [];
  const rows = await readStreamRowsByPrefix<DeviceRowValue>(shareId, 'device:', keyState.key);
  return rows
    .filter((r) => r.deviceId !== config.deviceId && typeof r.expoPushToken === 'string' && r.expoPushToken.length > 0)
    .map((r) => ({ expoPushToken: r.expoPushToken }));
}
