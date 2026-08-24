#!/usr/bin/env node
'use strict';

/**
 * Generates every app icon from one mark definition.
 *
 * WHY THIS EXISTS INSTEAD OF CHECKED-IN ART
 *
 * The icons have to stay consistent across four very different targets — a full-bleed
 * launcher icon, an adaptive foreground with a safe zone, a splash mark that must read on
 * both a light and a dark background, and a monochrome notification silhouette that Android
 * tints. Drawing those by hand means four chances to drift. Here the mark is defined once,
 * as maths, and each target is a different framing of it.
 *
 * It is also dependency-free on purpose. This machine has no SVG rasteriser (`sips` cannot
 * read SVG), and adding a headless-browser or canvas dependency to render four PNGs would
 * cost more than writing the rasteriser: it is ~120 lines, and `zlib` for PNG encoding is
 * already in Node.
 *
 * THE MARK: a heart with an ECG trace cut through it.
 *
 * The heart is the implicit curve (x² + y² − 1)³ − x²y³ ≤ 0, which gives a rounder, softer
 * heart than the usual two-circles-and-a-triangle construction and needs no path maths —
 * every pixel is one inside/outside test, which is exactly what a supersampled rasteriser
 * wants. The ECG is a polyline stroked by distance-to-segment.
 *
 * The trace is a CUT-OUT, not a second colour. That is what lets the same geometry serve
 * the splash (where the background is light or dark depending on the theme) and the
 * notification icon (where Android throws away every colour and keeps only the alpha).
 * A two-colour mark would need a different file for each.
 *
 * ⚠️ THIS SCRIPT ALONE DOES NOT PRODUCE SHIPPABLE LAUNCHER ICONS.
 *
 * `icon.png` and `adaptive-icon.png` written here are MARK-ONLY INTERMEDIATES. The
 * shipped versions carry the wordmark beneath the heart, and are written by
 * `scripts/generate-wordmark.py`, which runs after this and overwrites both. Text needs a
 * TrueType rasteriser, which is exactly the dependency this file exists to avoid — so the
 * split is by responsibility: geometry here, anything carrying the WORD over there.
 *
 * Run BOTH, in order, with:   npm run gen:brand
 *
 * Running only this script leaves the launcher icons without the app's name. That is not
 * a subtle regression to spot — it is the whole reason the wordmark was added — but it is
 * silent, so it is written down here.
 *
 * `notification-icon.png` is the one launcher-adjacent output this script fully owns:
 * Android tints it and draws it at 24dp, where a word is not a word.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Theme primary, from src/theme/index.ts. Kept in step by eye — this file is run by hand.
const TEAL = [0x0e, 0x7c, 0x6b];
const WHITE = [0xff, 0xff, 0xff];

const OUT = path.join(__dirname, '..', 'assets', 'images');

// ─── PNG encoding ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param rgba Buffer of width*height*4 bytes. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline. Filtering would shrink the file further, but
  // these are flat-colour images that deflate compresses well already, and None keeps this
  // readable.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Geometry ────────────────────────────────────────────────────────────────────

/** Implicit heart. `x`,`y` in mark space, y UP. Inside when <= 0. */
function heartField(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y;
}

/**
 * The ECG trace, in mark space. A flat baseline, one downward dip, one tall spike, a small
 * rebound, then flat again — the recognisable QRS silhouette rather than a generic zigzag.
 *
 * THE ENDPOINTS ARE LOAD-BEARING. They stop at ±0.8, well inside the heart's ±1.15 waist,
 * so the cut-out never reaches the outline. An earlier version ran edge to edge and looked
 * fine at 1024px — but it severed the heart into two pieces, and at notification size the
 * hairline connections either side disappeared entirely, leaving two unrelated blobs in the
 * status bar. The silhouette has to stay one connected shape at 24dp, which is the only
 * size where this icon has a job to do.
 */
const ECG = [
  [-0.8, 0.0],
  [-0.46, 0.0],
  [-0.3, -0.2],
  [-0.12, 0.55],
  [0.04, -0.32],
  [0.2, 0.1],
  [0.36, 0.0],
  [0.8, 0.0],
];

function distanceToPolyline(x, y, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

function roundedSquareInside(x, y, half, radius) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax <= half - radius || ay <= half - radius) return ax <= half && ay <= half;
  const cx = half - radius;
  const cy = half - radius;
  return Math.hypot(ax - cx, ay - cy) <= radius;
}

// ─── Rendering ───────────────────────────────────────────────────────────────────

const SS = 4; // 4×4 supersampling. These are viewed at 48dp; aliasing shows badly there.

/**
 * @param options.scale        mark half-extent in mark-space units mapped to half the canvas
 * @param options.background   [r,g,b] full-bleed background, or null for transparent
 * @param options.heartColor   [r,g,b] the heart body
 * @param options.rounded      draw the background as a rounded square rather than full bleed
 */
function render(size, options) {
  const { scale, background, heartColor, rounded } = options;
  const out = Buffer.alloc(size * size * 4);
  const strokeHalfWidth = 0.085;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgHits = 0;
      let markHits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // Pixel centre in [-1, 1], y flipped so mark space has y pointing up.
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = -(((py + (sy + 0.5) / SS) / size) * 2 - 1);

          if (background && (!rounded || roundedSquareInside(nx, ny, 1, 0.22))) bgHits += 1;

          // Mark space: scale up, and lift slightly so the heart sits optically centred —
          // its visual mass is in the upper lobes, so geometric centring reads as too low.
          const mx = nx / scale;
          const my = (ny - 0.04 * scale) / scale;

          const inHeart = heartField(mx, my) <= 0;
          const inTrace = distanceToPolyline(mx, my, ECG) <= strokeHalfWidth;
          if (inHeart && !inTrace) markHits += 1;
        }
      }

      const samples = SS * SS;
      const bgAlpha = background ? bgHits / samples : 0;
      const markAlpha = markHits / samples;

      // Composite the mark over the background, then flatten to straight alpha.
      const alpha = Math.min(1, bgAlpha + markAlpha);
      let r;
      let g;
      let b;
      if (alpha === 0) {
        r = 0;
        g = 0;
        b = 0;
      } else {
        const mw = markAlpha;
        const bw = Math.max(0, alpha - markAlpha);
        r = (heartColor[0] * mw + (background ? background[0] : 0) * bw) / alpha;
        g = (heartColor[1] * mw + (background ? background[1] : 0) * bw) / alpha;
        b = (heartColor[2] * mw + (background ? background[2] : 0) * bw) / alpha;
      }

      const i = (py * size + px) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, out);
}

// ─── Targets ─────────────────────────────────────────────────────────────────────

const TARGETS = [
  {
    file: 'icon.png',
    size: 1024,
    // The legacy launcher icon is used as supplied on older launchers, so it draws its own
    // rounded square rather than trusting a mask that may not come.
    options: { scale: 0.62, background: TEAL, heartColor: WHITE, rounded: true },
  },
  {
    file: 'adaptive-icon.png',
    size: 1024,
    // Foreground only; app.config.ts supplies the background colour. Android crops to the
    // inner 66% for some mask shapes and animates parallax within the outer 33%, so the
    // mark is kept well inside the safe zone — anything larger loses its edges on a circle.
    options: { scale: 0.42, background: null, heartColor: WHITE, rounded: false },
  },
  {
    file: 'splash-logo.src.png',
    size: 512,
    // The BARE MARK, in white on transparent — the input to scripts/generate-wordmark.py,
    // which recolours it per theme and sets the wordmark beneath it. The shipped splash
    // assets are that script's output; this file is an intermediate and is never used
    // directly by the app. Colour here is irrelevant: only the alpha channel survives.
    options: { scale: 0.72, background: null, heartColor: TEAL, rounded: false },
  },
  {
    file: 'notification-icon.png',
    size: 96,
    // Android discards colour here and keeps only the alpha channel, tinting the result.
    // Drawing it white keeps that obvious to anyone who opens the file; the ECG cut-out is
    // what stops it collapsing into an indistinct blob at status-bar size.
    options: { scale: 0.72, background: null, heartColor: WHITE, rounded: false },
  },
];

let total = 0;
for (const target of TARGETS) {
  const png = render(target.size, target.options);
  const dest = path.join(OUT, target.file);
  fs.writeFileSync(dest, png);
  total += png.length;
  console.log(`  ${target.file.padEnd(22)} ${String(target.size).padStart(4)}px  ${(png.length / 1024).toFixed(1)} kB`);
}
console.log(`\n  ${TARGETS.length} icons, ${(total / 1024).toFixed(1)} kB total`);
