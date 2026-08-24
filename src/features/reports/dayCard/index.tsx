/**
 * The day-card feature, assembled: the off-screen host, and the share flow.
 *
 * THE SHARE FLOW IS THREE STEPS AND THE ORDER MATTERS:
 *
 *   1. copy the text block to the clipboard,
 *   2. tell the user it is there and what to do with it,
 *   3. open the share sheet with the image.
 *
 * The notice comes BEFORE the sheet, because once the chooser is up the app's own UI is
 * behind it and a toast raised then is a toast nobody sees. See `./text.ts` for why the
 * two cannot travel in one intent.
 */

import React from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import type { DayCardData } from '../data/types';
import { MIME, shareFile, type ShareOutcome } from '../exports/share';
import { DayCard, type DayCardLabels } from './DayCard';
import type { CapturedCard, DayCardCaptureController } from './capture';
import { buildDayCardText, DAY_CARD_CLIPBOARD_NOTICE, type BuildDayCardTextOptions } from './text';

export { DayCard, DAY_CARD_PIXELS, DEFAULT_DAY_CARD_LABELS } from './DayCard';
export type { DayCardLabels, DayCardProps } from './DayCard';
export {
  BlankCaptureError,
  MIN_CARD_BYTES,
  cardLayoutSize,
  useDayCardCapture,
} from './capture';
export type { CapturedCard, DayCardCaptureController } from './capture';
export {
  buildDayCardText,
  DAY_CARD_CLIPBOARD_NOTICE,
  DAY_CARD_CLIPBOARD_NOTICE_KEY,
  DEFAULT_DAY_CARD_TEXT_LABELS,
} from './text';
export type { BuildDayCardTextOptions, DayCardTextLabels } from './text';

export type DayCardCaptureHostProps = {
  controller: DayCardCaptureController;
  labels?: Partial<DayCardLabels>;
};

/**
 * Renders the card off-screen while a capture is in flight, and nothing at all otherwise.
 *
 * Place it INSIDE the screen's own tree — not in a Modal, not in a portal. The whole
 * point of the arrangement is that the card participates in the current screen's layout
 * and draw pass; a host that is not in the tree is a host that is not drawn.
 *
 * `opacity: 0.01` and `pointerEvents="none"`, never a large negative offset, and
 * `collapsable={false}` on both wrappers. See the header of `./capture.ts` for both.
 */
export function DayCardCaptureHost({ controller, labels }: DayCardCaptureHostProps) {
  const { pending, hostRef, registerImage, layout } = controller;
  if (!pending) return null;

  return (
    <View
      collapsable={false}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', top: 0, left: 0, opacity: 0.01 }}
    >
      <View collapsable={false} ref={hostRef} style={{ width: layout.width, height: layout.height }}>
        <DayCard
          data={pending}
          width={layout.width}
          height={layout.height}
          {...(labels ? { labels } : {})}
          registerImage={registerImage}
        />
      </View>
    </View>
  );
}

export type ShareDayCardInput = {
  data: DayCardData;
  card: CapturedCard;
  /** Shown as the Android chooser title. Translate before passing. */
  dialogTitle: string;
  /** Raise a toast. Called BEFORE the share sheet opens. */
  onNotice: (message: string) => void;
  /** Translate `DAY_CARD_CLIPBOARD_NOTICE` and pass it; the English text is the default. */
  noticeMessage?: string;
  text?: BuildDayCardTextOptions;
};

export type ShareDayCardResult = ShareOutcome & { textCopied: boolean };

export async function shareDayCard(input: ShareDayCardInput): Promise<ShareDayCardResult> {
  const block = buildDayCardText(input.data, input.text ?? {});

  let textCopied = false;
  try {
    textCopied = await Clipboard.setStringAsync(block);
  } catch (error) {
    // A clipboard failure must not stop the share. The image is self-sufficient, which
    // is the entire reason it was designed that way.
    console.warn('[reports] could not copy the day card text to the clipboard', error);
  }

  if (textCopied) input.onNotice(input.noticeMessage ?? DAY_CARD_CLIPBOARD_NOTICE);

  const outcome = await shareFile({
    uri: input.card.uri,
    mimeType: MIME.png,
    dialogTitle: input.dialogTitle,
  });

  return { ...outcome, textCopied };
}
