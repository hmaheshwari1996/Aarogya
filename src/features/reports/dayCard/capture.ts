/**
 * Turning the day card into a PNG, without getting "Failed to snapshot view tag".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR THINGS THIS FILE DOES ON PURPOSE, EACH OF WHICH IS A BUG IF DROPPED
 *
 * 1. THE HOST IS INSIDE THE CURRENT SCREEN, ABSOLUTELY POSITIONED, AT `opacity: 0.01`
 *    AND `pointerEvents="none"`.
 *
 *    Not `left: -9999`. A large negative offset is the folk remedy, and on Android it can
 *    stop the view being drawn at all when any ancestor clips its children — the capture
 *    then succeeds and returns a blank image, which is worse than failing. Near-zero
 *    opacity keeps the view in the layout and in the draw pass while making it invisible;
 *    it is not `opacity: 0` because a fully transparent view is a candidate for being
 *    skipped entirely.
 *
 * 2. `collapsable={false}` ON THE HOST AND EVERY NESTED WRAPPER.
 *
 *    React Native collapses views that have no drawing properties of their own into their
 *    parent, so the JS tag exists with no Android View behind it. `captureRef` resolves
 *    the tag, finds nothing, and throws exactly that error. `DayCard` sets it on every
 *    container it renders for the same reason.
 *
 * 3. THE CAPTURE IS GATED ON IMAGE `onLoad` PROMISES *PLUS* TWO `requestAnimationFrame`
 *    TICKS.
 *
 *    `onLayout` fires when layout is complete, which is not when content has been drawn.
 *    Under Fabric an SVG subtree — the dose dots here — and any inlined image commonly
 *    need one more frame after that before the pixels exist. Two ticks is the smallest
 *    number that is reliably after the commit AND after the following draw.
 *
 * 4. THE RESULT IS ASSERTED NON-BLANK BEFORE IT GOES ANYWHERE.
 *
 *    A 1080×1350 PNG of a real card is 60–150 KB. A blank white one compresses to a few
 *    kilobytes. A file-size floor catches the "captured too early" failure that no
 *    exception reports, and the retry costs two more frames. Handing a blank image to the
 *    share sheet means the patient sends her doctor an empty rectangle and does not find
 *    out until he says so.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { PixelRatio, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { File } from 'expo-file-system';

import type { DayCardData } from '../data/types';
import { adoptIntoExports, timestampedFileName } from '../exports/files';
import { DAY_CARD_PIXELS } from './DayCard';

/**
 * The floor, in bytes. A solid-colour PNG at this size is well under 10 KB; a card with a
 * name, a date, a rule and a dozen lines of text has never come out below about 25 KB in
 * practice. 18 KB leaves headroom for the sparsest possible real card — one reading and
 * nothing else — while still catching a blank.
 */
export const MIN_CARD_BYTES = 18_000;

/** Long enough for a slow decode, short enough not to strand the user staring at a spinner. */
const IMAGE_GATE_TIMEOUT_MS = 3_000;

export type CapturedCard = {
  uri: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
};

export class BlankCaptureError extends Error {
  constructor(readonly bytes: number) {
    super(
      `The day card came out blank (${bytes} bytes, expected at least ${MIN_CARD_BYTES}). ` +
        'The view had not drawn yet when it was captured.',
    );
    this.name = 'BlankCaptureError';
  }
}

/** One animation frame. Two of these separate a layout commit from the draw that follows. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function settleTwoFrames(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/**
 * Resolves when every registered image has reported in, or when the timeout expires.
 *
 * The timeout resolves rather than rejects: an image that never loads should degrade to a
 * card with a gap in it, not to a share button that does nothing.
 */
async function waitForImages(promises: readonly Promise<void>[]): Promise<void> {
  if (promises.length === 0) return;
  await Promise.race([
    Promise.all(promises).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, IMAGE_GATE_TIMEOUT_MS);
    }),
  ]);
}

/**
 * The logical size to render at.
 *
 * Derived from the device's pixel density so that the view's NATURAL bitmap is already
 * about 1080 px wide. `captureRef` is still given the exact output size, but resampling
 * from close to 1:1 keeps small text sharp; rendering at a fixed 360 dp on a 2x device
 * would upscale 720 px to 1080 px and visibly soften every label.
 */
export function cardLayoutSize(): { width: number; height: number } {
  const density = Math.max(1, PixelRatio.get());
  return {
    width: DAY_CARD_PIXELS.width / density,
    height: DAY_CARD_PIXELS.height / density,
  };
}

export type DayCardCaptureController = {
  pending: DayCardData | null;
  busy: boolean;
  /** Attach to the wrapper that is captured. */
  hostRef: RefObject<View | null>;
  /** Pass to `DayCard` so its images enrol in the gate. */
  registerImage: (ready: Promise<void>) => void;
  /** Mounts the card, waits for it to draw, captures it, and verifies it is not blank. */
  capture: (data: DayCardData) => Promise<CapturedCard>;
  layout: { width: number; height: number };
};

/**
 * The capture controller.
 *
 * The screen renders `<DayCardCaptureHost controller={…} />` somewhere inside its own
 * tree — see `./index.tsx` — and calls `capture(data)`. The two-step shape exists because
 * the card has to be MOUNTED to be captured, and only React can mount it.
 */
export function useDayCardCapture(): DayCardCaptureController {
  const [pending, setPending] = useState<DayCardData | null>(null);
  const [busy, setBusy] = useState(false);

  const hostRef = useRef<View | null>(null);
  const imagePromises = useRef<Promise<void>[]>([]);
  const settle = useRef<{
    resolve: (value: CapturedCard) => void;
    reject: (error: unknown) => void;
  } | null>(null);

  const registerImage = useCallback((ready: Promise<void>) => {
    imagePromises.current.push(ready);
  }, []);

  const capture = useCallback((data: DayCardData): Promise<CapturedCard> => {
    return new Promise<CapturedCard>((resolve, reject) => {
      if (settle.current) {
        reject(new Error('A day card capture is already running.'));
        return;
      }
      settle.current = { resolve, reject };
      imagePromises.current = [];
      setBusy(true);
      setPending(data);
    });
  }, []);

  useEffect(() => {
    if (pending === null) return;
    let cancelled = false;

    const run = async () => {
      try {
        // Images first, then two frames. Both, not either: the image gate says the
        // content EXISTS, the frames say it has been DRAWN.
        await waitForImages(imagePromises.current);
        await settleTwoFrames();

        let result = await captureOnce(hostRef.current, pending.localDate);
        if (result.bytes < MIN_CARD_BYTES) {
          // One retry, two more frames. The overwhelmingly common cause is a subtree that
          // committed but had not painted, and a second pair of frames fixes it.
          console.warn(
            `[reports] the day card captured at ${result.bytes} bytes; retrying after two more frames`,
          );
          await settleTwoFrames();
          result = await captureOnce(hostRef.current, pending.localDate);
        }
        if (result.bytes < MIN_CARD_BYTES) throw new BlankCaptureError(result.bytes);
        if (!cancelled) settle.current?.resolve(result);
      } catch (error) {
        if (!cancelled) settle.current?.reject(error);
      } finally {
        settle.current = null;
        imagePromises.current = [];
        if (!cancelled) {
          setPending(null);
          setBusy(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [pending]);

  return { pending, busy, hostRef, registerImage, capture, layout: cardLayoutSize() };
}

async function captureOnce(host: View | null, localDate: string): Promise<CapturedCard> {
  if (!host) {
    throw new Error('The day card host view is not mounted. Render <DayCardCaptureHost> in the screen.');
  }

  const tmpUri = await captureRef(host, {
    format: 'png',
    quality: 1,
    result: 'tmpfile',
    // The exact output size, independent of the device's density.
    width: DAY_CARD_PIXELS.width,
    height: DAY_CARD_PIXELS.height,
  });

  const fileName = timestampedFileName(`aarogya-day-${localDate}`, '.png');
  const uri = adoptIntoExports(tmpUri, fileName);
  const bytes = fileSize(uri);

  return { uri, fileName, width: DAY_CARD_PIXELS.width, height: DAY_CARD_PIXELS.height, bytes };
}

/** 0 when the file cannot be read — which the non-blank assertion then treats as a failure. */
function fileSize(uri: string): number {
  try {
    const file = new File(uri);
    return file.exists ? file.size : 0;
  } catch (error) {
    console.warn('[reports] could not stat the captured day card', error);
    return 0;
  }
}
