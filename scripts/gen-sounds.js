#!/usr/bin/env node
'use strict';

/**
 * gen-sounds.js — Aarogya dose-reminder chimes, generated from source, zero deps.
 *
 * OUTPUT
 *   assets/sounds/dose_critical.wav   1.5 s
 *   assets/sounds/dose_standard.wav   2.5 s
 *   Both 44100 Hz, 16-bit, mono PCM, canonical 44-byte RIFF/WAVE header.
 *
 * THE FILENAMES ARE LOAD-BEARING. src/constants/channels.js names these sounds
 * `dose_critical` / `dose_standard`, and at runtime they are resolved with
 * resources.getIdentifier(name, "raw", packageName) after Expo copies
 * assets/sounds/* into android/app/src/main/res/raw/. Android raw-resource names
 * must be lowercase alphanumeric + underscore, and the resource name is the
 * filename minus extension — so renaming either file silently breaks the channel
 * sound (Android falls back to the default notification tone and, because
 * channels are immutable after first creation, you cannot fix it in place).
 *
 * WHY SINES AND NOT SQUARE/SAW
 * ----------------------------
 * This fires next to an elderly patient several times a day, so the design goal
 * is "warm and noticeable", never "startling". A square or saw wave carries the
 * full odd/all harmonic series with 1/n rolloff — that harsh, buzzy edge is
 * exactly what triggers a startle response, and on a small phone speaker the
 * high partials are the ones that survive, so it also sounds cheap. Instead each
 * note is a fundamental plus two or three quiet harmonics at hand-picked
 * amplitudes, which gives a soft struck-bell timbre.
 *
 * Two further deliberate choices for older ears:
 *  - Register. Presbycusis attacks high frequencies first, so the fundamentals
 *    sit in the 520-990 Hz range, well inside a comfortably audible band, rather
 *    than the 2-4 kHz sparkle a "modern" UI chime would use.
 *  - Envelopes. Every partial gets a raised-cosine attack (8-14 ms — long enough
 *    that there is no click, short enough that it still sounds like a chime) and
 *    an exponential decay, with the higher partials decaying faster than the
 *    fundamental the way a real struck bar does.
 *
 * Both files end with a short raised-cosine fade so the last sample is exactly
 * zero and the file cannot click if a channel ever loops it.
 */

const fs = require('node:fs');
const path = require('node:path');
// Imported explicitly rather than leaning on the Buffer global, so this file
// lints cleanly regardless of which globals the shared eslint config declares.
const { Buffer } = require('node:buffer');

const SAMPLE_RATE = 44100;
const BITS = 16;
const CHANNELS = 1;
const MAX_BYTES = 250 * 1024;

/** Peak-normalisation target. -3 dBFS leaves headroom for device EQ/limiting. */
// -0.7, not -3. The reported complaint was "the alarm sound is not loud"; -3 dBFS threw
// away 3 dB of ceiling for headroom this signal chain does not need — nothing downstream
// sums two of these together.
const TARGET_DBFS = -0.7;

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Adds one struck-bell note into a float buffer.
 *
 * @param {Float64Array} buf
 * @param {number} startSec  when the note begins
 * @param {number} freq      fundamental in Hz
 * @param {number} amp       relative amplitude before normalisation
 * @param {number} attack    raised-cosine attack in seconds (never < 0.005)
 * @param {number} tau       decay time constant of the fundamental, seconds
 * @param {number[]} partials amplitude of harmonic n (index 0 => fundamental)
 */
function addNote(buf, startSec, freq, amp, attack, tau, partials, wrap = false) {
  const start = Math.round(startSec * SAMPLE_RATE);
  // Run each partial until it is ~-80 dB down, or to the end of the buffer.
  const life = Math.ceil((attack + tau * 9.2) * SAMPLE_RATE);
  // `wrap` lets a note's decay tail spill past the end of the buffer and land back at
  // the beginning. That is what makes a looping file seamless: MediaPlayer restarts at
  // sample 0 with no gap, and the tail of the last stroke is already sitting there to
  // meet it. Fading out instead would put an audible hole at every loop point — which
  // in an alarm reads as the sound having stopped.
  const end = wrap ? start + life : Math.min(buf.length, start + life);

  for (let p = 0; p < partials.length; p++) {
    const pAmp = partials[p];
    if (pAmp === 0) continue;
    const n = p + 1;
    const w = 2 * Math.PI * freq * n;
    // Higher partials die away sooner — this is what stops the tail turning
    // into a thin whistle and is most of what makes it read as "warm".
    const pTau = tau / (1 + 0.35 * p);

    for (let i = start; i < end; i++) {
      const t = (i - start) / SAMPLE_RATE;
      const a = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : 1;
      const target = wrap ? i % buf.length : i;
      buf[target] += amp * pAmp * a * Math.exp(-t / pTau) * Math.sin(w * t);
    }
  }
}

/**
 * Crossfades a loop's tail into its own head so the join is continuous.
 *
 * Quantising the tones to whole cycles makes the SINE phase line up, but not the
 * ENVELOPE: at the last sample four strokes are decaying, and at the first sample those
 * same tails are joined by a new stroke whose attack starts from zero. That mismatch
 * measured 6.3% of full scale — small, but it recurs on every single loop, and a click
 * once every two seconds is precisely the texture that makes an alarm feel broken.
 *
 * A short raised-cosine crossfade removes it by construction rather than by tuning.
 * 12 ms is long enough to be inaudible as a fade and short enough not to swallow a stroke.
 */
function sealLoop(buf, sec) {
  const n = Math.min(buf.length >> 2, Math.round(sec * SAMPLE_RATE));
  if (n < 2) return;
  // The join is buf[len-1] -> buf[0], so buf[0] is what the tail has to arrive at.
  // An earlier version blended the tail toward buf[i] — the sample i places INTO the
  // file, not the one it follows — which left the last sample matching buf[n-1] and
  // made the step thirteen times worse. Ramp toward the actual neighbour.
  const target = buf[0];
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / (n - 1)); // 0 at the start, exactly 1 at the end
    buf[buf.length - n + i] = buf[buf.length - n + i] * (1 - w) + target * w;
  }
}

/** Raised-cosine fade to true silence over the final `sec` seconds. */
function fadeOut(buf, sec) {
  const n = Math.min(buf.length, Math.round(sec * SAMPLE_RATE));
  for (let i = 0; i < n; i++) {
    const k = i / n; // 0 at the start of the fade, 1 at the very end
    buf[buf.length - n + i] *= 0.5 + 0.5 * Math.cos(Math.PI * k);
  }
  buf[buf.length - 1] = 0;
}

/**
 * Soft saturation, applied before normalising. THIS is what makes the tone louder, and
 * the reason is worth stating because raising the peak alone does almost nothing here.
 *
 * Perceived loudness tracks RMS, not peak. A struck bell decays exponentially, so it
 * spends most of its length near silence: the shipped tones measured -3 dBFS peak but
 * only -13 dBFS RMS, a 10 dB crest factor. Normalising to 0 dBFS would have bought 3 dB
 * and left the sound essentially as quiet as before.
 *
 * `tanh` with a pre-gain lifts the quiet decay far more than the loud attack — it
 * compresses the crest — and the gentle odd harmonics it adds land in the 1-3 kHz band,
 * which is where a phone's tiny speaker is most efficient and where alerting is most
 * effective. The result is markedly louder from the same speaker at the same volume
 * setting, without becoming the harsh buzz this file's header rightly refuses.
 *
 * @param {number} drive  pre-gain into the saturator. 1 = no change; 3-5 is audible
 *                        thickening; beyond ~8 it starts to sound like distortion.
 */
function softSaturate(buf, drive) {
  const norm = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) / norm;
}

function peakNormalise(buf, dbfs) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  if (peak === 0) return 0;
  const target = Math.pow(10, dbfs / 20);
  const g = target / peak;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return target;
}

// ---------------------------------------------------------------------------
// WAV container (canonical 44-byte header)
// ---------------------------------------------------------------------------

function encodeWAV(samples) {
  const bytesPerSample = BITS / 8;
  const dataSize = samples.length * bytesPerSample * CHANNELS;
  const out = Buffer.alloc(44 + dataSize);

  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + dataSize, 4); // file size - 8
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16); // PCM fmt chunk size
  out.writeUInt16LE(1, 20); // audioFormat = 1 (PCM)
  out.writeUInt16LE(CHANNELS, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28); // byte rate
  out.writeUInt16LE(CHANNELS * bytesPerSample, 32); // block align
  out.writeUInt16LE(BITS, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    let v = Math.round(samples[i] * 32767);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, 44 + i * 2);
  }
  return out;
}

function parseWAV(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') throw new Error('not RIFF');
  if (buf.subarray(8, 12).toString('latin1') !== 'WAVE') throw new Error('not WAVE');
  if (buf.subarray(12, 16).toString('latin1') !== 'fmt ') throw new Error('fmt not first');
  if (buf.subarray(36, 40).toString('latin1') !== 'data') throw new Error('non-canonical header');
  const format = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  return {
    format,
    channels,
    rate,
    bits,
    dataSize,
    frames: dataSize / (channels * (bits / 8)),
    seconds: dataSize / (rate * channels * (bits / 8)),
    riffSize: buf.readUInt32LE(4),
  };
}

// ---------------------------------------------------------------------------
// The two chimes
// ---------------------------------------------------------------------------

/**
 * STANDARD — 2.5 s. A single rising two-tone: C5 (523.25 Hz) then G5 (783.99 Hz),
 * a perfect fifth. The second note enters at 0.42 s, while the first is still
 * ringing at roughly half amplitude, so the two overlap into one consonant chord
 * rather than reading as two separate beeps. Long tau, mild partials => soft.
 *
 * The second note's amplitude is 0.55, not 1.0, precisely BECAUSE of that
 * overlap: it lands on top of the first note's tail and the two sum, so equal
 * amplitudes would make the second stroke ~1.5x the first and the chime would
 * lurch. 0.55 puts the two local peaks within 6% of each other.
 */
function buildStandard() {
  const dur = 2.5;
  const buf = new Float64Array(Math.round(dur * SAMPLE_RATE));
  const partials = [1.0, 0.3, 0.12, 0.05];

  addNote(buf, 0.0, 523.25, 1.0, 0.014, 0.7, partials);
  addNote(buf, 0.42, 783.99, 0.55, 0.014, 0.7, partials);

  softSaturate(buf, 1.8);
  peakNormalise(buf, TARGET_DBFS);
  fadeOut(buf, 0.15);
  return buf;
}

/**
 * CRITICAL — 1.5 s. The same interval a fifth higher (E5 659.25 -> B5 987.77) so
 * it is marginally brighter and cuts through better, repeated as three quick
 * pulses at 0.00 / 0.40 / 0.80 s. Repetition, not loudness or harshness, is what
 * makes it more insistent: tau drops to 0.30 s so the pulses stay separate
 * instead of smearing, and the partials are only slightly stronger than the
 * standard tone's. Still a sine chime — nothing here is buzzy.
 */
function buildCritical() {
  const dur = 1.5;
  const buf = new Float64Array(Math.round(dur * SAMPLE_RATE));
  const partials = [1.0, 0.38, 0.18, 0.08];

  for (const t0 of [0.0, 0.4, 0.8]) {
    addNote(buf, t0, 659.25, 1.0, 0.008, 0.3, partials);
    // 0.55, not 1.0 — same summing argument as buildStandard(), and here the two
    // notes are only 110 ms apart so the overlap is even heavier.
    addNote(buf, t0 + 0.11, 987.77, 0.55, 0.008, 0.3, partials);
  }

  softSaturate(buf, 2.1);
  peakNormalise(buf, TARGET_DBFS);
  fadeOut(buf, 0.12);
  return buf;
}

/**
 * ALARM LOOP — 2.0 s, and it must tile against itself with no seam.
 *
 * This is the file the native alarm player loops while a dose reminder is ringing, so it
 * is heard not once but dozens of times in a row. Two consequences drive every choice:
 *
 *  - NO fadeOut. A fade would drop to silence and then jump back to a full-amplitude
 *    attack, and a listener reads that hole as the alarm having stopped. Instead every
 *    stroke is rendered with `wrap`, so the tail that runs past 2.0 s lands back at the
 *    start and is already ringing when the file restarts.
 *  - The length is an exact multiple of the 0.5 s stroke period, so the rhythm continues
 *    across the loop point rather than stuttering.
 *
 * Four strokes at 0.5 s rather than the critical tone's three at 0.4 s: a touch more space
 * between them survives repetition for minutes without becoming a drill, which matters when
 * the thing it is waking is an elderly patient rather than a teenager.
 */
function buildAlarmLoop() {
  const dur = 2.0;
  const buf = new Float64Array(Math.round(dur * SAMPLE_RATE));
  const partials = [1.0, 0.42, 0.2, 0.09];

  // Quantised to a multiple of 1/dur, so a WHOLE number of cycles fits the loop and the
  // sine phase at the last sample continues into the first. Un-quantised (659.25 Hz in
  // 2.0 s is 1318.5 cycles) the waveform arrives at the seam half a cycle out and the
  // join steps — a faint but repeating click, once every two seconds, forever. The shift
  // is 0.25 Hz and 0.23 Hz: far below the ~5 Hz that is audible as a pitch change here.
  const cycle = (hz) => Math.round(hz * dur) / dur;
  const low = cycle(659.25);
  const high = cycle(987.77);

  for (const t0 of [0.0, 0.5, 1.0, 1.5]) {
    addNote(buf, t0, low, 1.0, 0.008, 0.34, partials, true);
    addNote(buf, t0 + 0.11, high, 0.55, 0.008, 0.34, partials, true);
  }

  softSaturate(buf, 2.3);
  sealLoop(buf, 0.012);
  peakNormalise(buf, TARGET_DBFS);
  return buf;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const OUT_DIR = path.join(__dirname, '..', 'assets', 'sounds');

const SOUNDS = [
  { name: 'dose_critical', seconds: 1.5, build: buildCritical },
  { name: 'dose_standard', seconds: 2.5, build: buildStandard },
  // Looped by the native alarm player for as long as a dose reminder is ringing.
  { name: 'dose_alarm_loop', seconds: 2.0, build: buildAlarmLoop, loop: true },
];

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const failures = [];

  for (const s of SOUNDS) {
    const samples = s.build();
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));

    const file = path.join(OUT_DIR, `${s.name}.wav`);
    fs.writeFileSync(file, encodeWAV(samples));

    // Verify by re-parsing the header off disk rather than trusting our own state.
    const back = fs.readFileSync(file);
    const h = parseWAV(back);

    if (h.format !== 1) failures.push(`${s.name}.wav: audioFormat ${h.format}, expected 1 (PCM)`);
    if (h.channels !== 1) failures.push(`${s.name}.wav: ${h.channels} channels, expected mono`);
    if (h.rate !== 44100) failures.push(`${s.name}.wav: ${h.rate} Hz, expected 44100`);
    if (h.bits !== 16) failures.push(`${s.name}.wav: ${h.bits}-bit, expected 16`);
    if (h.riffSize !== back.length - 8) failures.push(`${s.name}.wav: RIFF size mismatch`);
    if (Math.abs(h.seconds - s.seconds) > 0.001) {
      failures.push(`${s.name}.wav: ${h.seconds.toFixed(4)} s, expected ${s.seconds} s`);
    }
    if (back.length > MAX_BYTES) {
      failures.push(`${s.name}.wav: ${back.length} bytes exceeds the ${MAX_BYTES} byte budget`);
    }
    if (s.loop) {
      // A LOOP MUST NOT END AT ZERO. Silence at the join is the hole the wrap-around
      // rendering exists to remove — so the check is continuity, not silence: the step
      // from the last sample to the first has to be small enough to be inaudible.
      // 2% of full scale is well under the ~-34 dBFS a click would need to register
      // against a tone sitting at -0.7.
      const step = Math.abs(back.readInt16LE(44) - back.readInt16LE(back.length - 2));
      if (step > 0.02 * 32767) {
        failures.push(
          `${s.name}.wav: loop seam steps by ${step} (${((100 * step) / 32767).toFixed(1)}% FS) — it will click once per loop`,
        );
      }
    } else if (back.readInt16LE(44) !== 0 || back.readInt16LE(back.length - 2) !== 0) {
      failures.push(`${s.name}.wav: does not start and end at zero — it will click`);
    }

    const dbfs = 20 * Math.log10(peak);
    console.log(
      `  assets/sounds/${s.name}.wav  ${h.seconds.toFixed(3)}s  ${h.rate} Hz  ` +
        `${h.bits}-bit ${h.channels === 1 ? 'mono' : `${h.channels}ch`}  ` +
        `${h.frames} frames  ${back.length} bytes (${(back.length / 1024).toFixed(1)} KB)  ` +
        `peak ${dbfs.toFixed(2)} dBFS`
    );
  }

  if (failures.length) {
    console.error('\nFAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('\nAll sounds generated and verified.');
}

main();
