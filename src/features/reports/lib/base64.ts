/**
 * A small, dependency-free base64 codec.
 *
 * WHY THIS EXISTS RATHER THAN `btoa`: React Native's Hermes runtime provides no
 * `btoa`/`atob` and no Node `Buffer`. The report layer needs base64 in two places that
 * both have to work offline on a Go-class device — inlining a chart as a `data:` URI,
 * and handing SheetJS bytes to `expo-file-system` — so it carries its own twenty lines
 * rather than a polyfill package.
 *
 * PURE, no runtime imports, so it stays loadable by the type-stripping test runner.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 encode without TextEncoder, which is also absent on some Hermes builds. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);

    // Surrogate pair → one code point. Devanagari sits in the BMP, but a note can
    // contain an emoji, and a half-encoded surrogate corrupts the whole file.
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

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += ALPHABET[b0 >> 2] ?? '';
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    out += b1 === undefined ? '=' : (ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '');
    out += b2 === undefined ? '=' : (ALPHABET[b2 & 0x3f] ?? '');
  }
  return out;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8Bytes(text));
}

/**
 * An SVG document as an inline `data:` URI.
 *
 * Base64 rather than percent-encoded UTF-8 on purpose: a chart legend can contain a
 * doctor's name with a comma, a hash or a quote, and every one of those needs escaping
 * inside a URI. Base64 has no such characters, so there is nothing left to get wrong.
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}
