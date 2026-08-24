import * as Crypto from 'expo-crypto';

/**
 * Row ids are UUIDv4. This is load-bearing, not cosmetic.
 *
 * `dose_occurrence.id` is the deterministic composite '<threadId>:<localDate>:<timeLocal>',
 * and the journal drain splits it back apart on ':'. The day any id contains a colon,
 * a dose silently attaches to the wrong medicine. UUIDs cannot contain one, and
 * assertOpaqueId() makes that a runtime guarantee rather than a hope.
 */
export function newId(): string {
  return Crypto.randomUUID();
}

const OPAQUE_ID = /^[0-9a-fA-F-]{36}$/;

export function assertOpaqueId(id: string, what = 'id'): string {
  if (!OPAQUE_ID.test(id)) {
    throw new Error(`${what} must be a UUID with no separators, got: ${id}`);
  }
  return id;
}

/** Deterministic, idempotent and snooze-stable — regenerating it must never duplicate a dose. */
export function occurrenceId(threadId: string, localDate: string, timeLocal: string): string {
  assertOpaqueId(threadId, 'threadId');
  return `${threadId}:${localDate}:${timeLocal}`;
}

export function parseOccurrenceId(id: string): {
  threadId: string;
  localDate: string;
  timeLocal: string;
} | null {
  const parts = id.split(':');
  // threadId + date + HH + MM — the time itself contains a colon.
  if (parts.length !== 4) return null;
  const [threadId, localDate, hh, mm] = parts;
  if (!threadId || !localDate || !hh || !mm) return null;
  return { threadId, localDate, timeLocal: `${hh}:${mm}` };
}
