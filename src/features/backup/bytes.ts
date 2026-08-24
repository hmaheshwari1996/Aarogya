/**
 * Byte plumbing for the capsule and for family sync.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Hermes has no `Buffer`, no `btoa`/`atob`, and — on the RN 0.81 builds this app ships —
 * no `TextEncoder` it can be relied on for. `src/features/reports/lib/base64.ts` already
 * carries an ENCODER for the report layer, but a capsule has to be read back as well as
 * written, and there is no decoder anywhere in the tree. Rather than reach across into a
 * module another feature owns and bolt a decoder onto it, the two crypto features carry
 * one shared copy here — `features/sync` imports this file too, deliberately, so that the
 * wire format and the capsule format can never drift apart on something as dull as a
 * padding character.
 *
 * EVERYTHING HERE IS PURE. No expo imports, no React Native imports, no clock. That is
 * load-bearing: `node --test --experimental-strip-types` can load this file directly, and
 * so can every crypto module that only imports from it.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse table. -1 for anything that is not a base64 digit. */
const B64_LOOKUP: readonly number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += B64_ALPHABET[b0 >> 2] ?? '';
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    out += b1 === undefined ? '=' : (B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '');
    out += b2 === undefined ? '=' : (B64_ALPHABET[b2 & 0x3f] ?? '');
  }
  return out;
}

/**
 * Strict on purpose: an unexpected character throws rather than being skipped.
 *
 * A capsule header that decodes "almost" is a salt that is quietly wrong, which surfaces
 * as "wrong passphrase" on a passphrase the user typed correctly — the single most
 * expensive way this code could fail.
 */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[\r\n]/g, '');
  const trimmed = clean.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));

  let outIndex = 0;
  let accumulator = 0;
  let bitsHeld = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    const digit = code < 128 ? (B64_LOOKUP[code] ?? -1) : -1;
    if (digit < 0) throw new Error(`Not base64: unexpected character at index ${i}`);
    accumulator = (accumulator << 6) | digit;
    bitsHeld += 6;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      out[outIndex] = (accumulator >> bitsHeld) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

/** UTF-8 encode without TextEncoder. Surrogate pairs are joined, so emoji survive. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }

    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 decode without TextDecoder. Invalid sequences become U+FFFD rather than throwing. */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    let codePoint: number;
    let width: number;

    if (b0 < 0x80) {
      codePoint = b0;
      width = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f;
      width = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f;
      width = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07;
      width = 4;
    } else {
      out += '�';
      i += 1;
      continue;
    }

    if (i + width > bytes.length) {
      out += '�';
      break;
    }
    let valid = true;
    for (let k = 1; k < width; k += 1) {
      const continuation = bytes[i + k] ?? 0;
      if ((continuation & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (!valid) {
      out += '�';
      i += 1;
      continue;
    }

    if (codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    } else {
      out += String.fromCharCode(codePoint);
    }
    i += width;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Big-endian uint32. Frame lengths and chunk indices both use it. */
export function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`u32 out of range: ${value}`);
  }
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('Truncated: 4 bytes of length prefix expected');
  return (
    ((bytes[offset] ?? 0) * 0x100_0000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Big-endian uint64 built from a JS number.
 *
 * Frame counters never approach 2^53, so a `number` is safe here and avoids dragging
 * BigInt into the nonce path — Hermes supports BigInt, but it is markedly slower and this
 * runs once per 256 KiB chunk.
 */
export function u64(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
 * Constant-time-ish equality.
 *
 * JS cannot promise constant time — the engine may bail out early on anything — but a
 * loop with no early return removes the trivially-timeable comparison, and every caller
 * here is comparing a value an attacker could otherwise probe one byte at a time.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace.
 *
 * This is what makes the manifest usable as associated data. `JSON.stringify` preserves
 * insertion order, so a manifest that was re-serialised by a different code path would
 * produce different bytes, a different MAC, and a capsule that refuses to open for no
 * reason a user could ever understand.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = record[key];
      // `undefined` is dropped, exactly as JSON.stringify would drop it, so an optional
      // field left unset and an optional field deleted produce identical bytes.
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}
