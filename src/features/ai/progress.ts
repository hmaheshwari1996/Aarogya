/**
 * What the scan screen shows while she waits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A PROGRESS SIGNAL IS A CORRECTNESS FEATURE HERE, NOT A DECORATION
 *
 * A prescription scan takes up to 300 seconds per attempt and is retried automatically.
 * For most of that time the screen has nothing to say, and `retry.ts` already names the
 * consequence in its own header: a silent stretch is indistinguishable from a frozen
 * phone, and the reasonable response to a frozen phone is to kill the app — which throws
 * away the very wait that was about to succeed.
 *
 * `onAttempt` told the screen about attempts. It said nothing about the two thirds of the
 * wall clock that are cropping four photographs and pushing a megabyte up a corridor
 * connection. This module covers the whole pipeline.
 *
 * ─── HOW THE SCREEN GETS IT ──────────────────────────────────────────────────
 *
 * Two ways, and they are not alternatives — both are always live:
 *
 *   1. `subscribeAiProgress(listener)` — a module-level bus. Any screen can subscribe
 *      without threading a callback through `runExtraction`, which matters because the
 *      pieces that know the most (the image encoder, the retry loop) are the furthest
 *      from the screen. One scan at a time is the only case this app has.
 *
 *   2. `AiRequest.onProgress` — scoped to one request, for a caller that wants exactly
 *      its own events and no one else's.
 *
 * ─── THE NUMBER IS AN ESTIMATE AND SAYS SO ───────────────────────────────────
 *
 * `estimate` is a 0…1 figure for the bar. It is NOT measured: nothing in a React Native
 * `fetch` reports upload progress, and no model announces how far through an answer it
 * is. It is a position in a five-step pipeline, weighted by how long each step usually
 * takes. `determinate` tells the screen which of the two it is looking at, so a bar can
 * be a real bar while pages are being cropped and a barber-pole while the model thinks.
 *
 * It NEVER GOES BACKWARDS. A second attempt does not rewind the bar to a quarter — the
 * bar stalls where it is and the phase changes to `waiting`, which is the truth: no
 * progress is being made, and something IS still happening. A bar that rewinds reads as
 * "it gave up and started over", which is the one thing that makes people close the app.
 * The clamp lives in `publishAiProgress` so no caller has to remember it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AiErrorCode } from './errors';

export type AiProgress =
  /** Cropping, resizing and encoding one photograph. Local work, and genuinely countable. */
  | {
      readonly phase: 'preparing';
      /** 1-based. */
      readonly page: number;
      readonly pageCount: number;
      readonly estimate: number;
      readonly determinate: true;
    }
  /** The request is on its way up. No upload progress exists on this platform. */
  | {
      readonly phase: 'sending';
      readonly attempt: number;
      readonly maxAttempts: number;
      /** Total inline bytes leaving the phone. Worth showing on a metered connection. */
      readonly bytes: number;
      readonly estimate: number;
      readonly determinate: false;
    }
  /** The request is up and the model is thinking. The longest phase, and the emptiest. */
  | {
      readonly phase: 'reading';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly estimate: number;
      readonly determinate: false;
    }
  /** Between attempts. `retryInMs` is a real countdown — show it. */
  | {
      readonly phase: 'waiting';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly retryInMs: number;
      readonly lastErrorCode: AiErrorCode;
      readonly estimate: number;
      readonly determinate: false;
    }
  /** The answer arrived and is being checked and written. Fast, but not instant. */
  | { readonly phase: 'saving'; readonly estimate: number; readonly determinate: false }
  /** Terminal. `ok` false carries the code so the screen can pick its own sentence. */
  | {
      readonly phase: 'done';
      readonly ok: boolean;
      readonly errorCode: AiErrorCode | null;
      readonly estimate: 1;
      readonly determinate: true;
    };

export type AiProgressListener = (progress: AiProgress) => void;

/**
 * Where each phase sits on the bar, before the within-phase fraction is added.
 *
 * These weights are what a slow scan on a cheap phone actually spends its time on:
 * cropping four 12 MP photographs is seconds, the upload is tens of seconds on a corridor
 * connection, and a thinking model is the longest single stretch. They are honest about
 * proportion, not precise about duration, and nothing depends on them being right.
 *
 * ─── `waiting` IS EXCLUDED FROM THIS TABLE, AND THE `Exclude` IS THE POINT ────
 *
 * Every other phase answers "how far along are we". `waiting` answers "nothing is
 * happening and something still will be", which is not a position on a track. It is the
 * one phase whose whole contract (see `waitingProgress` below, and the "IT NEVER GOES
 * BACKWARDS" note in the header) is that the bar STAYS WHERE THE LAST REAL STEP LEFT IT.
 *
 * This started life as a plain `Record<AiProgress['phase'], number>` with no `waiting`
 * member — which does not compile, and was the one error standing in the way of
 * `tsc --noEmit`. The obvious repair is `waiting: 0`. That types, and it is a trap: the
 * next person to reach for `PHASE_START[progress.phase]` in a loop gets a bar that snaps
 * to the far left every time the model is asked again — precisely the "it gave up and
 * started over" rewind this module exists to prevent, reintroduced by a lookup that looks
 * total. Narrowing the key type instead makes `PHASE_START.waiting` a compile error, so
 * the invariant is enforced by the checker rather than by this paragraph.
 */
const PHASE_START: Record<Exclude<AiProgress['phase'], 'waiting'>, number> = {
  preparing: 0.02,
  sending: 0.3,
  reading: 0.45,
  saving: 0.92,
  done: 1,
};
const PREPARING_SPAN = PHASE_START.sending - PHASE_START.preparing;

// ── The bus ──────────────────────────────────────────────────────────────────

const listeners = new Set<AiProgressListener>();
let latest: AiProgress | null = null;
let highWater = 0;

/**
 * Subscribes to every scan in the app. Returns the unsubscribe.
 *
 * The current value is NOT replayed on subscribe: a screen that mounts halfway through
 * should call `currentAiProgress()` if it wants to catch up, and most will not — a scan
 * belongs to the screen that started it.
 */
export function subscribeAiProgress(listener: AiProgressListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentAiProgress(): AiProgress | null {
  return latest;
}

/**
 * Called at the start of a scan, so the bar starts at the left rather than wherever the
 * last scan left it. `runExtraction` and `testKey` both do this for their callers.
 */
export function resetAiProgress(): void {
  latest = null;
  highWater = 0;
}

/**
 * Publishes one event, after clamping the estimate so the bar cannot rewind.
 *
 * `to` is optional and is the request-scoped listener. Both it and the bus are given the
 * SAME clamped object, so a screen using one cannot see a different number from a screen
 * using the other.
 */
export function publishAiProgress(progress: AiProgress, to?: AiProgressListener): void {
  const clamped = clamp(progress);
  latest = clamped;
  try {
    to?.(clamped);
  } catch {
    // A listener is a screen. A screen mid-unmount must not take down a scan.
  }
  for (const listener of listeners) {
    try {
      listener(clamped);
    } catch {
      // As above.
    }
  }
}

function clamp(progress: AiProgress): AiProgress {
  if (progress.phase === 'done') {
    highWater = 1;
    return progress;
  }
  if (progress.estimate <= highWater) {
    return { ...progress, estimate: highWater } as AiProgress;
  }
  highWater = progress.estimate;
  return progress;
}

// ── The five constructors, so no call site has to know the weights ───────────

export function preparingProgress(page: number, pageCount: number): AiProgress {
  const total = Math.max(1, pageCount);
  const done = Math.min(Math.max(page, 1), total);
  return {
    phase: 'preparing',
    page: done,
    pageCount: total,
    estimate: PHASE_START.preparing + (PREPARING_SPAN * done) / total,
    determinate: true,
  };
}

export function sendingProgress(attempt: number, maxAttempts: number, bytes: number): AiProgress {
  return {
    phase: 'sending',
    attempt,
    maxAttempts,
    bytes,
    estimate: PHASE_START.sending,
    determinate: false,
  };
}

export function readingProgress(attempt: number, maxAttempts: number): AiProgress {
  return {
    phase: 'reading',
    attempt,
    maxAttempts,
    estimate: PHASE_START.reading,
    determinate: false,
  };
}

export function waitingProgress(
  attempt: number,
  maxAttempts: number,
  retryInMs: number,
  lastErrorCode: AiErrorCode,
): AiProgress {
  return {
    phase: 'waiting',
    attempt,
    maxAttempts,
    retryInMs,
    lastErrorCode,
    // Deliberately not advanced. Waiting is not progress, and the clamp will hold the bar
    // wherever the last real step left it.
    estimate: 0,
    determinate: false,
  };
}

export function savingProgress(): AiProgress {
  return { phase: 'saving', estimate: PHASE_START.saving, determinate: false };
}

export function doneProgress(ok: boolean, errorCode: AiErrorCode | null = null): AiProgress {
  return { phase: 'done', ok, errorCode, estimate: 1, determinate: true };
}
