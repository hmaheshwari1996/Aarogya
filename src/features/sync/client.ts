/**
 * A thin Supabase REST client over `fetch`. About 200 lines instead of a dependency.
 *
 * ─── WHY NOT `@supabase/supabase-js` ──────────────────────────────────────────────
 * The SDK is a realtime client, an auth client, a storage client and a Postgrest client in
 * one package, and this app uses a fraction of one of them: insert rows, select rows,
 * delete rows, call one function. It also drags in a WebSocket implementation and its own
 * fetch polyfill, on a project whose entire APK budget is a policy decision (arm64-only,
 * R8, single ABI) because the target handset has 2 GB of RAM and a metered connection.
 *
 * PostgREST is a plain HTTP API. `fetch` speaks it.
 *
 * ─── EVERY METHOD IS A NO-OP WHEN UNCONFIGURED ────────────────────────────────────
 * `createClient()` returns null when `getSyncConfig()` does, and every caller in this
 * feature is written to accept null and return quietly. See `./config.ts`.
 *
 * ─── WHAT THE SERVER IS ALLOWED TO SEE ────────────────────────────────────────────
 * Row ids, lamport numbers, a link id, timestamps and opaque ciphertext. No table names
 * from the local schema, no column names, no plaintext of any kind, and no phone numbers
 * — there are none to send.
 *
 * IT NEVER SEES THE KEY. The key rides in the fragment of the share link, which no HTTP
 * client ever transmits (`./link.ts`). Nothing in this file may put it in a path, a query
 * string, a header or a body, and nothing here has a reason to see it at all.
 *
 * The schema and its RLS policies are in `docs/SYNC-AND-BACKUP.md`.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import { getSyncConfig, type SyncConfig } from './config';
import { ensureShareKey, getShareKey } from './crypto';

/** Server-side table names. Deliberately unrelated to the local schema's names. */
export const REMOTE_TABLES = {
  record: 'sync_record',
  share: 'sync_share',
} as const;

/** Long enough for a corridor connection, short enough not to hold a drain open forever. */
export const REQUEST_TIMEOUT_MS = 20_000;

export type SyncClientError = {
  readonly kind: 'offline' | 'timeout' | 'http' | 'malformed';
  readonly status: number | null;
  readonly message: string;
  /** Worth trying again later. A 4xx generally is not; a 5xx or a dropped socket is. */
  readonly retryable: boolean;
};

export type SyncResponse<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: SyncClientError };

/** One encrypted row as the server stores it. */
export type RemoteRecord = {
  readonly row_key: string;
  readonly link_id: string;
  readonly lamport: number;
  /** base64 of nonce ‖ ciphertext ‖ tag. The server can do nothing with this. */
  readonly payload: string;
  readonly op: 'upsert' | 'delete';
  readonly key_generation: number;
  readonly updated_at_epoch: number;
};

/**
 * The one row a viewer reads: everything the shared view shows, sealed as a single blob.
 *
 * One row rather than a stream because a family member opening a link wants a screen, not
 * a replay — and because a single blob has a single length, which is the padding argument
 * from `./sealed.ts` applied to the whole dataset at once.
 */
export type RemoteShare = {
  readonly link_id: string;
  /** base64 of nonce ‖ ciphertext ‖ tag. Opened only by the key in the link's fragment. */
  readonly payload: string;
  readonly key_generation: number;
  readonly updated_at_epoch: number;
};

export type SyncClient = {
  readonly config: SyncConfig;
  /**
   * The dataset id from the share link. Sent as `X-Share-Id`; the RLS policies filter every
   * table on it. Null before sharing has been switched on.
   *
   * This is the ONLY half of the link the server ever sees. The key stays in the fragment.
   */
  readonly linkId: string | null;
  select<T>(table: string, query: string): Promise<SyncResponse<T[]>>;
  insert<T>(table: string, rows: readonly unknown[]): Promise<SyncResponse<T[]>>;
  upsert<T>(table: string, rows: readonly unknown[], onConflict: string): Promise<SyncResponse<T[]>>;
  patch<T>(table: string, query: string, values: Record<string, unknown>): Promise<SyncResponse<T[]>>;
  remove(table: string, query: string): Promise<SyncResponse<null>>;
  /** Cheapest possible round trip. Also what keeps a free project from pausing. */
  heartbeat(): Promise<SyncResponse<unknown[]>>;
};

/**
 * Null when sync is not configured. Callers must handle that without complaining.
 *
 * Reads this phone's own link id but never creates one — a viewer's handset gets its id
 * from the link it was given, and minting one here would produce a second, empty dataset
 * that nothing is ever published into.
 */
export async function createClient(): Promise<SyncClient | null> {
  const config = await getSyncConfig();
  if (!config) return null;
  const state = await getShareKey();
  return clientFor(config, state?.linkId ?? null);
}

/**
 * For the PATIENT's own actions, which are the only ones allowed to bring a dataset into
 * existence: showing the link for the first time, publishing, rotating.
 *
 * Every request needs the link id in a header — the RLS policies filter on it — so a client
 * built before the key exists would be rejected by the server on its first write.
 */
export async function createPatientClient(): Promise<SyncClient | null> {
  const config = await getSyncConfig();
  if (!config) return null;
  const state = await ensureShareKey();
  return clientFor(config, state.linkId);
}

/**
 * A client pointed at one dataset.
 *
 * `linkId` is passed in rather than read, because a VIEWER's client is pointed at somebody
 * else's dataset — the id out of the link she was sent, not anything stored on her phone
 * as her own.
 */
export function clientFor(config: SyncConfig, linkId: string | null = null): SyncClient {
  const base = `${config.url}/rest/v1`;

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    'Content-Type': 'application/json',
    // PostgREST needs to be told a row count is wanted, and told not to bother otherwise;
    // asking for an exact count on every request is a table scan the free tier will feel.
    Prefer: 'count=none',
    // The capability that RLS checks: 128 random bits naming one dataset. Row isolation
    // and anti-enumeration, NOT the confidentiality boundary — the encryption is that, and
    // the key it needs is never sent. See the threat model in docs/SYNC-AND-BACKUP.md.
    ...(linkId ? { 'X-Share-Id': linkId } : {}),
    ...extra,
  });

  const request = async <T>(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<SyncResponse<T>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: init.headers ?? headers(),
        body: init.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await safeText(response);
        return {
          ok: false,
          error: {
            kind: 'http',
            status: response.status,
            message: text.slice(0, 400),
            // 408, 429 and every 5xx are worth retrying. A 400 means this row will never
            // be accepted and retrying it forever would wedge the whole outbox behind it.
            retryable: response.status >= 500 || response.status === 408 || response.status === 429,
          },
        };
      }

      if (response.status === 204) return { ok: true, data: null as unknown as T };
      const text = await safeText(response);
      if (text.length === 0) return { ok: true, data: null as unknown as T };
      try {
        return { ok: true, data: JSON.parse(text) as T };
      } catch {
        return {
          ok: false,
          error: { kind: 'malformed', status: response.status, message: 'the reply was not JSON', retryable: false },
        };
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        error: {
          kind: aborted ? 'timeout' : 'offline',
          status: null,
          message: error instanceof Error ? error.message : String(error),
          // Offline is the normal state of the target user's connection, not a fault.
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    config,
    linkId,

    select<T>(table: string, query: string) {
      return request<T[]>(`/${encodeURIComponent(table)}?${query}`, { method: 'GET' });
    },

    insert<T>(table: string, rows: readonly unknown[]) {
      return request<T[]>(`/${encodeURIComponent(table)}`, {
        method: 'POST',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify(rows),
      });
    },

    upsert<T>(table: string, rows: readonly unknown[], onConflict: string) {
      return request<T[]>(`/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: 'POST',
        headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(rows),
      });
    },

    patch<T>(table: string, query: string, values: Record<string, unknown>) {
      return request<T[]>(`/${encodeURIComponent(table)}?${query}`, {
        method: 'PATCH',
        headers: headers({ Prefer: 'return=representation' }),
        body: JSON.stringify(values),
      });
    },

    remove(table: string, query: string) {
      return request<null>(`/${encodeURIComponent(table)}?${query}`, {
        method: 'DELETE',
        headers: headers({ Prefer: 'return=minimal' }),
      });
    },

    heartbeat() {
      // One row, one column, no filter to plan. Enough to count as database activity and
      // keep a free project out of its 7-day pause.
      return request<unknown[]>(`/${REMOTE_TABLES.record}?select=row_key&limit=1`, { method: 'GET' });
    },
  };
}

/**
 * PostgREST filter for one column equalling one value.
 *
 * Values are percent-encoded, so an id containing a comma or a dot cannot break out of
 * the filter grammar and turn `eq.abc` into something PostgREST reads as a list.
 */
export function eq(column: string, value: string | number): string {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
