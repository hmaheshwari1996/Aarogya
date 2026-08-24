#!/usr/bin/env node
'use strict';

/**
 * gen-icons.js — Aarogya app iconography, generated from source with zero dependencies.
 *
 * WHY THIS EXISTS
 * ---------------
 * The four binaries Expo needs (launcher icon, adaptive foreground, splash mark,
 * notification silhouette) are all the SAME mark at different sizes, colours and
 * safe-zones. Hand-exporting them from a design tool guarantees they drift apart.
 * This script is the single source of truth: edit the geometry constants below,
 * re-run, and all four regenerate identically. It is fully deterministic and
 * idempotent — running it twice produces byte-identical files.
 *
 * WHY WE RASTERISE OURSELVES
 * --------------------------
 * `sips` only reads bitmaps, `rsvg-convert` is not installed on most machines, and
 * `qlmanage` is macOS-only and non-deterministic. So we do it in pure Node: every
 * shape is a signed-distance function (SDF), sampled on a 4x4 supersample grid per
 * pixel (16 samples => 17 clean coverage levels), then encoded as a PNG by hand.
 *
 * THE MARK
 * --------
 * A rounded-square medical cross with an ECG (heartbeat) trace running through the
 * horizontal arm. Deliberately restrained: at 48px the cross silhouette is what
 * carries recognition, and the ECG reads as a clean contrasting band through it.
 * A more detailed waveform would turn to mush at launcher size.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
// Imported explicitly rather than leaning on the Buffer global, so this file
// lints cleanly regardless of which globals the shared eslint config declares.
const { Buffer } = require('node:buffer');

// ---------------------------------------------------------------------------
// Palette (theme tokens — keep in sync with app.config.ts / the theme file)
// ---------------------------------------------------------------------------

const TEAL = [0x0e, 0x7c, 0x6b, 255]; // #0E7C6B — theme primary
const LIGHT = [0xf4, 0xf7, 0xf6, 255]; // #F4F7F6 — theme background
const WHITE = [0xff, 0xff, 0xff, 255]; // pure white, notification silhouette only
const NONE = [0, 0, 0, 0]; // fully transparent (also used as an eraser)

// ---------------------------------------------------------------------------
// Geometry, expressed once in an abstract 1000x1000 design space.
// Every target below just picks how many pixels that 1000-unit box maps onto,
// which is how the four assets stay in exact proportion to one another.
// ---------------------------------------------------------------------------

const D = 1000; // design-space edge
const C = D / 2; // design-space centre

const ARM_HALF = 140; // half-thickness of a cross arm  (arm is 280 thick)
const ARM_EXTENT = 410; // half-length of a cross arm     (cross bbox is 820)
const ARM_RADIUS = 60; // outer corner radius of the arms

const ECG_HALF_W = 33; // half stroke width of the trace (66 wide)

/**
 * The trace: a flat baseline, a small Q dip, a tall R spike, an S dip, back to
 * baseline. Amplitudes are chosen so the stroke (plus its half-width) always
 * stays inside the arm: max excursion is 78 + 33 = 111 against ARM_HALF = 140,
 * leaving ~29 units of arm on the outside of the peak. Letting the spike break
 * out of the arm would notch the cross silhouette and read as "broken" at 48px.
 */
const ECG = [
  [140, 500],
  [385, 500],
  [425, 540], // Q
  [490, 422], // R
  [555, 570], // S
  [615, 500],
  [860, 500],
];

/** Splash-only backing plate — see the SPLASH note in TARGETS. */
const PLATE_HALF = 560;
const PLATE_RADIUS = 270;

// ---------------------------------------------------------------------------
// Signed distance functions (design units; <= 0 means inside)
// ---------------------------------------------------------------------------

/** Exact outside, conservative inside — which is all the edge test below needs. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const mx = qx > 0 ? qx : 0;
  const my = qy > 0 ? qy : 0;
  const outside = Math.sqrt(mx * mx + my * my);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function sdCross(px, py) {
  const h = sdRoundRect(px, py, C, C, ARM_EXTENT, ARM_HALF, ARM_RADIUS);
  const v = sdRoundRect(px, py, C, C, ARM_HALF, ARM_EXTENT, ARM_RADIUS);
  return h < v ? h : v; // union
}

function sdPlate(px, py) {
  return sdRoundRect(px, py, C, C, PLATE_HALF, PLATE_HALF, PLATE_RADIUS);
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  let h = (pax * bax + pay * bay) / (bax * bax + bay * bay);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Distance to a polyline stroke. Taking the min over per-segment capsule
 * distances gives round joins AND round caps for free — no mitre maths, and no
 * spikes at the sharp R/S corners of the trace.
 */
function makeSdPolyline(pts, halfWidth) {
  return function sdPolyline(px, py) {
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const s = sdSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (s < d) d = s;
    }
    return d - halfWidth;
  };
}

// ---------------------------------------------------------------------------
// Rasteriser
// ---------------------------------------------------------------------------

const SS = 4; // 4x4 = 16 supersamples per edge pixel

/**
 * Layers are painted back-to-front with REPLACE semantics (not alpha-over).
 * That is what lets the notification icon punch the ECG straight through the
 * cross as real transparency simply by painting a transparent "colour".
 *
 * @param {number} size        square canvas edge in px
 * @param {number} designPx    how many px the 1000-unit design box occupies
 * @param {number[]} base      background RGBA for the whole canvas
 * @param {{sdf:Function,rgba:number[]}[]} layers
 */
function render(size, designPx, base, layers) {
  const scale = designPx / D; // px per design unit
  const origin = size / 2 - (D / 2) * scale; // px offset of design (0,0)
  const inv = 1 / scale;
  const out = new Uint8Array(size * size * 4);
  const n = layers.length;

  // A pixel only needs supersampling if some layer's boundary can pass through
  // it. |d| in px greater than half a pixel diagonal (0.7072) proves it cannot.
  const edgeBand = 0.75;

  const shade = (dx, dy) => {
    let c = base;
    for (let i = 0; i < n; i++) if (layers[i].sdf(dx, dy) <= 0) c = layers[i].rgba;
    return c;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cdx = (x + 0.5 - origin) * inv;
      const cdy = (y + 0.5 - origin) * inv;

      let uniform = true;
      for (let i = 0; i < n; i++) {
        if (Math.abs(layers[i].sdf(cdx, cdy)) * scale <= edgeBand) {
          uniform = false;
          break;
        }
      }

      const o = (y * size + x) * 4;

      if (uniform) {
        const c = shade(cdx, cdy);
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = c[3];
        continue;
      }

      // Accumulate PREMULTIPLIED so transparent samples do not drag the colour
      // toward black and leave a dark fringe on the alpha edges.
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let j = 0; j < SS; j++) {
        const dy2 = (y + (j + 0.5) / SS - origin) * inv;
        for (let i = 0; i < SS; i++) {
          const dx2 = (x + (i + 0.5) / SS - origin) * inv;
          const c = shade(dx2, dy2);
          const a = c[3];
          sr += c[0] * a;
          sg += c[1] * a;
          sb += c[2] * a;
          sa += a;
        }
      }
      if (sa === 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
      } else {
        out[o] = Math.round(sr / sa);
        out[o + 1] = Math.round(sg / sa);
        out[o + 2] = Math.round(sb / sa);
        out[o + 3] = Math.round(sa / (SS * SS));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoder (IHDR + optional PLTE/tRNS + IDAT + IEND)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Per-scanline adaptive filtering with the standard minimum-sum-of-absolute-
 * differences heuristic. On flat-colour artwork this picks filter 1/2 almost
 * everywhere and lets deflate collapse whole regions to nothing.
 */
function filterImage(data, height, stride, bpp) {
  const out = Buffer.alloc(height * (stride + 1));
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        if (f === 0) v = cur[x];
        else if (f === 1) v = cur[x] - a;
        else if (f === 2) v = cur[x] - b;
        else if (f === 3) v = cur[x] - ((a + b) >> 1);
        else v = cur[x] - paeth(a, b, c);
        v &= 0xff;
        buf[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
    prev = cur;
  }
  return out;
}

/**
 * WHY INDEXED (colour type 3): the mark uses at most three flat colours, so the
 * only distinct pixel values in the whole image are those three plus the 17
 * anti-aliasing blend levels between neighbouring pairs — comfortably under the
 * 256-entry palette limit. Indexed cuts the raw surface from 4 bytes/px to 1
 * before deflate even runs, which is the difference between a ~30 KB and a
 * ~4 KB icon. If a variant ever exceeds 256 distinct colours we transparently
 * fall back to full RGBA rather than degrading the artwork.
 */
function tryIndexed(width, height, rgba) {
  const map = new Map();
  const palette = [];
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    const key = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    let p = map.get(key);
    if (p === undefined) {
      if (palette.length >= 256) return null;
      p = palette.length;
      palette.push([r, g, b, a]);
      map.set(key, p);
    }
    indices[i] = p;
  }
  // tRNS is a prefix of the palette, so sort translucent entries to the front
  // and emit only as many alpha bytes as are actually needed.
  const order = palette.map((_, i) => i).sort((i, j) => palette[i][3] - palette[j][3]);
  const remap = new Uint8Array(palette.length);
  order.forEach((old, neu) => {
    remap[old] = neu;
  });
  for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]];
  return { palette: order.map((i) => palette[i]), indices };
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const indexed = tryIndexed(width, height, rgba);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = indexed ? 3 : 6; // colour type: 3 = indexed, 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [sig, chunk('IHDR', ihdr)];
  let raw;
  let stride;
  let bpp;

  if (indexed) {
    const plte = Buffer.alloc(indexed.palette.length * 3);
    indexed.palette.forEach((c, i) => {
      plte[i * 3] = c[0];
      plte[i * 3 + 1] = c[1];
      plte[i * 3 + 2] = c[2];
    });
    parts.push(chunk('PLTE', plte));

    let lastTranslucent = -1;
    indexed.palette.forEach((c, i) => {
      if (c[3] < 255) lastTranslucent = i;
    });
    if (lastTranslucent >= 0) {
      const trns = Buffer.alloc(lastTranslucent + 1);
      for (let i = 0; i <= lastTranslucent; i++) trns[i] = indexed.palette[i][3];
      parts.push(chunk('tRNS', trns));
    }
    raw = Buffer.from(indexed.indices.buffer, indexed.indices.byteOffset, indexed.indices.length);
    stride = width;
    bpp = 1;
  } else {
    raw = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
    stride = width * 4;
    bpp = 4;
  }

  const filtered = filterImage(raw, height, stride, bpp);
  parts.push(chunk('IDAT', zlib.deflateSync(filtered, { level: 9 })));
  parts.push(chunk('IEND', Buffer.alloc(0)));

  return {
    buffer: Buffer.concat(parts),
    mode: indexed ? `indexed(${indexed.palette.length})` : 'rgba',
  };
}

// ---------------------------------------------------------------------------
// SVG emission (provenance — the mark stays re-editable in a vector tool)
// ---------------------------------------------------------------------------

function ecgPathData() {
  return ECG.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ');
}

function crossRects(fill) {
  const hx = C - ARM_EXTENT;
  const hy = C - ARM_HALF;
  return (
    `    <rect x="${hx}" y="${hy}" width="${ARM_EXTENT * 2}" height="${ARM_HALF * 2}" rx="${ARM_RADIUS}" fill="${fill}"/>\n` +
    `    <rect x="${hy}" y="${hx}" width="${ARM_HALF * 2}" height="${ARM_EXTENT * 2}" rx="${ARM_RADIUS}" fill="${fill}"/>\n`
  );
}

function ecgStroke(stroke, width) {
  return (
    `    <path d="${ecgPathData()}" fill="none" stroke="${stroke}" stroke-width="${width}"\n` +
    `          stroke-linecap="round" stroke-linejoin="round"/>\n`
  );
}

function buildSVG(target) {
  const { size, designPx, plate, crossColor, ecgColor, ecgWidth, bg, knockout } = target;
  const s = designPx / D;
  const t = size / 2 - (D / 2) * s;
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n` +
    `  <!-- Aarogya mark. Generated by scripts/gen-icons.js — edit the geometry there. -->\n`;
  let body = '';
  if (bg) body += `  <rect width="${size}" height="${size}" fill="${bg}"/>\n`;
  body += `  <g transform="translate(${t.toFixed(4)} ${t.toFixed(4)}) scale(${s.toFixed(6)})">\n`;
  if (plate) {
    body +=
      `    <rect x="${C - PLATE_HALF}" y="${C - PLATE_HALF}" width="${PLATE_HALF * 2}" ` +
      `height="${PLATE_HALF * 2}" rx="${PLATE_RADIUS}" fill="${plate}"/>\n`;
  }
  if (knockout) {
    // The trace is a hole, not a colour — expressed as a mask so the SVG matches
    // the PNG exactly (see the notification-icon note in TARGETS).
    body =
      `  <defs>\n    <mask id="ecg">\n` +
      `      <rect width="${size}" height="${size}" fill="#000"/>\n` +
      `      <g transform="translate(${t.toFixed(4)} ${t.toFixed(4)}) scale(${s.toFixed(6)})">\n` +
      crossRects('#fff').replace(/^ {4}/gm, '        ') +
      ecgStroke('#000', ecgWidth).replace(/^ {4}/gm, '        ') +
      `      </g>\n    </mask>\n  </defs>\n` +
      `  <rect width="${size}" height="${size}" fill="${crossColor}" mask="url(#ecg)"/>\n`;
    return `${head}${body}</svg>\n`;
  }
  body += crossRects(crossColor);
  body += ecgStroke(ecgColor, ecgWidth);
  body += '  </g>\n';
  return `${head}${body}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const hex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const TARGETS = [
  {
    name: 'icon',
    size: 1024,
    // 88% of the canvas: leaves ~7% padding on each side, the usual amount for a
    // legacy square launcher icon / iOS-style tile.
    designPx: 880,
    bg: hex(LIGHT),
    baseRGBA: LIGHT,
    crossColor: hex(TEAL),
    crossRGBA: TEAL,
    ecgColor: hex(LIGHT),
    ecgRGBA: LIGHT,
    ecgWidth: ECG_HALF_W * 2,
  },
  {
    name: 'adaptive-icon',
    size: 1024,
    /**
     * ADAPTIVE SAFE ZONE. Android masks an adaptive icon to an OEM-chosen shape
     * and only the centre ~66% circle (660px of 1024) is guaranteed visible. The
     * cross's furthest point is an arm corner at radius sqrt(410^2 + 140^2) =
     * 433 design units, i.e. 0.866 of the design half-box. Solving
     * 0.866 * designPx/2 <= 330 gives designPx <= 762; we use 750 for headroom.
     *
     * Colours are INVERTED relative to icon.png because app.config.ts sets
     * adaptiveIcon.backgroundColor to the dark teal — a teal cross on teal would
     * be invisible. The trace is painted in that same teal so it reads as a
     * groove through the light cross, and so the layer still looks correct if a
     * launcher ever composites the foreground over something else.
     */
    designPx: 750,
    bg: null,
    baseRGBA: NONE,
    crossColor: hex(LIGHT),
    crossRGBA: LIGHT,
    ecgColor: hex(TEAL),
    ecgRGBA: TEAL,
    ecgWidth: ECG_HALF_W * 2,
  },
  {
    name: 'splash-logo',
    size: 512,
    designPx: 427,
    /**
     * SPLASH CONTRAST. app.config.ts uses #F4F7F6 (light) and #101614 (dark) as
     * splash backgrounds. Teal #0E7C6B scores 4.75:1 against the light one but
     * only 3.49:1 against the dark one — technically past the 3:1 large-graphic
     * floor, yet visibly murky on a near-black screen. Rather than compromise
     * the brand teal into a mid-tone that would be weak on BOTH (a lighter teal
     * such as #17A08A measures 5.5:1 dark but drops to 3.0:1 light), the mark
     * keeps the exact brand teal and sits on a light rounded-square plate. On the
     * light splash the plate is the same colour as the background and vanishes;
     * on the dark splash it becomes a 16.6:1 tile with the teal cross reading
     * 4.75:1 inside it. Correct in both themes, brand colour unmodified.
     */
    bg: null,
    baseRGBA: NONE,
    plate: hex(LIGHT),
    plateRGBA: LIGHT,
    crossColor: hex(TEAL),
    crossRGBA: TEAL,
    ecgColor: hex(LIGHT),
    ecgRGBA: LIGHT,
    ecgWidth: ECG_HALF_W * 2,
  },
  {
    name: 'notification-icon',
    size: 96,
    /**
     * WHITE-ON-TRANSPARENT ONLY. Android takes the alpha channel of a small
     * notification icon and re-tints it with the system accent at draw time; any
     * RGB information is discarded, so a coloured icon renders as a solid blob.
     * Every pixel here is therefore white with only alpha varying, and the ECG
     * trace is punched out as true transparency instead of being drawn in a
     * second colour. The stroke is widened slightly (74 vs 66) so the hole
     * survives being scaled down to 24dp in the status bar.
     *
     * Sized to 80/96 = 83% of the canvas, which puts the mark's 0.866 circum-
     * radius at 34.6px — inside the centre 75% (36px) Android expects, since it
     * adds its own padding around the glyph.
     */
    designPx: 80,
    bg: null,
    baseRGBA: NONE,
    crossColor: '#ffffff',
    crossRGBA: WHITE,
    ecgColor: null,
    ecgRGBA: NONE,
    ecgWidth: 74,
    knockout: true,
  },
];

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const OUT_DIR = path.join(__dirname, '..', 'assets', 'images');
const MAX_BYTES = 40 * 1024;

function readIHDR(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('IHDR missing');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24],
    colorType: buf[25],
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const failures = [];

  for (const t of TARGETS) {
    const layers = [];
    if (t.plateRGBA) layers.push({ sdf: sdPlate, rgba: t.plateRGBA });
    layers.push({ sdf: sdCross, rgba: t.crossRGBA });
    layers.push({ sdf: makeSdPolyline(ECG, t.ecgWidth / 2), rgba: t.ecgRGBA });

    const rgba = render(t.size, t.designPx, t.baseRGBA, layers);
    const { buffer, mode } = encodePNG(t.size, t.size, rgba);

    const pngPath = path.join(OUT_DIR, `${t.name}.png`);
    const svgPath = path.join(OUT_DIR, `${t.name}.svg`);
    fs.writeFileSync(pngPath, buffer);
    fs.writeFileSync(svgPath, buildSVG(t));

    // Verify by reading the header back off disk, not by trusting our own state.
    const back = fs.readFileSync(pngPath);
    const ihdr = readIHDR(back);
    if (ihdr.width !== t.size || ihdr.height !== t.size) {
      failures.push(`${t.name}.png: IHDR says ${ihdr.width}x${ihdr.height}, expected ${t.size}`);
    }
    if (back.length > MAX_BYTES) {
      failures.push(`${t.name}.png: ${back.length} bytes exceeds the ${MAX_BYTES} byte budget`);
    }

    const kb = (back.length / 1024).toFixed(2);
    console.log(
      `  assets/images/${t.name}.png  ${ihdr.width}x${ihdr.height}  ` +
        `${back.length} bytes (${kb} KB)  ${mode}`
    );
    console.log(`  assets/images/${t.name}.svg  ${fs.statSync(svgPath).size} bytes`);
  }

  if (failures.length) {
    console.error('\nFAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('\nAll icons generated and verified.');
}

main();
