/**
 * "This is what will be sent."
 *
 * ─── WHY THERE IS NO RECIPIENT ON THIS SCREEN ────────────────────────────────
 * No default recipient. No "send to my son" button. No contact picker, and no
 * READ_CONTACTS anywhere in the manifest. The only action is the system share sheet,
 * which hands the choice of who receives this entirely to the operating system's own UI.
 *
 * Two reasons, both concrete:
 *  • A health record with a pre-filled recipient is one mis-tap from going to the wrong
 *    person, and it is not a mistake that can be taken back — a WhatsApp forward lands in
 *    someone else's photo backup within seconds.
 *  • Reading her address book to save that one tap is a permanent privacy cost (every
 *    name and number this app would then hold) against a saving of about two seconds.
 *    The share sheet already knows her contacts. Aarogya does not need to.
 *
 * The screen says this out loud in one line, because a user who cannot see why the app is
 * being careful reads the extra tap as the app being clumsy.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE PREVIEW IS THE ARTEFACT, NOT A DESCRIPTION OF IT. The same `<DayCard>` component
 * that gets captured to PNG is rendered here at the screen's width, from the same
 * `DayCardData` and with the same labels. There is no second rendering path that could
 * drift from what actually leaves the phone.
 *
 * The dose words come from `doseStatusKey` and nowhere else, so a dose with nothing
 * recorded reads "not recorded as taken". The app was told nothing about that tablet; it
 * does not follow that nothing happened, and "missed" would say that it did.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { router } from 'expo-router';

import {
  Banner,
  Button,
  Card,
  EmptyState,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useToast,
} from '@/components/ui';
import {
  DOSE_STATUS_STRINGS,
  doseStatusKey,
  useAsync,
  useProfileId,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { useDateFormat } from '@/i18n/useDateFormat';
import { toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import {
  BlankCaptureError,
  DAY_CARD_PIXELS,
  DayCard,
  DayCardCaptureHost,
  collectDayCard,
  shareDayCard,
  useDayCardCapture,
  type DayCardData,
  type DayCardLabels,
  type DayCardTextLabels,
} from '@/features/reports';

const STRINGS: LocalStrings = {
  ...DOSE_STATUS_STRINGS,
  'day.title': { en: "Today's summary", hi: 'आज का हाल' },
  'day.subtitle': { en: 'This is exactly what will be sent.', hi: 'ठीक यही भेजा जाएगा।' },
  'day.youChoose': {
    en: 'You choose who receives it. Aarogya does not read your contacts and has no one saved.',
    hi: 'किसे भेजना है यह आप चुनेंगी। आरोग्य आपके संपर्क नहीं पढ़ता और उसके पास कोई नाम सेव नहीं है।',
  },
  'day.share': { en: 'Send it', hi: 'भेजें' },
  'day.shareTitle': { en: "Today's summary", hi: 'आज का हाल' },
  'day.shareFailed': { en: 'It was not sent. Please try again.', hi: 'यह भेजा नहीं जा सका। फिर कोशिश करें।' },
  'day.shareUnavailable': {
    en: 'This phone cannot open the sharing window.',
    hi: 'यह फोन भेजने वाली विंडो नहीं खोल पा रहा।',
  },
  'day.captureBlank': {
    en: 'The picture came out empty. Please try once more.',
    hi: 'तस्वीर खाली बन गई। एक बार और कोशिश करें।',
  },
  'day.buildFailed': { en: 'The summary could not be made', hi: 'यह हाल बन नहीं पाया' },
  'day.buildFailedMessage': {
    en: 'Nothing was sent. You can try again.',
    hi: 'कुछ भेजा नहीं गया। आप फिर कोशिश कर सकती हैं।',
  },
  'day.preparing': { en: 'Preparing the summary', hi: 'हाल तैयार हो रहा है' },
  'day.symptomsLabel': { en: 'How I felt', hi: 'तबीयत कैसी रही' },
  'day.nothingRecorded': {
    en: 'Nothing was recorded on this day.',
    hi: 'इस दिन कुछ भी दर्ज नहीं हुआ।',
  },
  'day.cardDisclaimer': {
    en: 'Recorded in the Aarogya app. It shows what was recorded, not what was swallowed.',
    hi: 'आरोग्य ऐप में दर्ज। इसमें वही है जो दर्ज हुआ, यह नहीं कि दवाई खाई गई या नहीं।',
  },
  // The key `DAY_CARD_CLIPBOARD_NOTICE_KEY` names. The text block is copied to the
  // clipboard because an image and a message cannot travel in one Android share intent.
  'reports.dayCard.textCopied': {
    en: 'The words are copied. After you choose a person, paste them under the picture.',
    hi: 'शब्द कॉपी हो गए हैं। जिसे भेजना है उसे चुनने के बाद, तस्वीर के नीचे पेस्ट कर दें।',
  },
};

export default function DayCardScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const { formatDate } = useDateFormat();

  const profile = useProfileId();
  const profileId = profile.data;
  const localDate = toLocalDate();

  const capture = useDayCardCapture();
  const [sharing, setSharing] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);

  const card = useAsync<DayCardData | null>(async () => {
    if (!profileId) return null;
    return collectDayCard(profileId, localDate);
  }, [profileId, localDate]);

  /**
   * The card leaves the phone for her family, not for an OPD desk, so it is written in
   * her language — unlike the doctor's report, which is English by design. The dose words
   * are resolved through `doseStatusKey` so this surface cannot drift from every other
   * place a dose status is named.
   */
  const labels = useMemo<Partial<DayCardLabels>>(
    () => ({
      bloodPressure: t('entry.bp.title'),
      bloodSugar: t('entry.sugar.title'),
      weight: t('entry.weight.title'),
      medicines: t('nav.medicines'),
      symptoms: t('day.symptomsLabel'),
      keyTaken: t(doseStatusKey('taken')),
      keyNotTaken: t(doseStatusKey('skipped')),
      keyNoRecord: t(doseStatusKey('no_record')),
      disclaimer: t('day.cardDisclaimer'),
      nothingRecorded: t('day.nothingRecorded'),
    }),
    [t],
  );

  const textLabels = useMemo<Partial<DayCardTextLabels>>(
    () => ({
      bloodPressure: t('entry.bp.title'),
      bloodSugar: t('entry.sugar.title'),
      weight: t('entry.weight.title'),
      medicines: t('nav.medicines'),
      symptoms: t('day.symptomsLabel'),
      taken: t(doseStatusKey('taken')),
      notTaken: t(doseStatusKey('skipped')),
      noRecord: t(doseStatusKey('no_record')),
      nothingRecorded: t('day.nothingRecorded'),
      disclaimer: t('day.cardDisclaimer'),
    }),
    [t],
  );

  const onPreviewLayout = useCallback((event: LayoutChangeEvent) => {
    setPreviewWidth(event.nativeEvent.layout.width);
  }, []);

  const share = useCallback(async () => {
    const data = card.data;
    if (!data) return;
    setSharing(true);
    try {
      const captured = await capture.capture(data);
      const result = await shareDayCard({
        data,
        card: captured,
        dialogTitle: t('day.shareTitle'),
        // Raised before the chooser appears — once the sheet is up, the app's own UI is
        // behind it and a toast raised then is a toast nobody reads.
        onNotice: (message) => toast.show({ message, variant: 'info' }),
        noticeMessage: t('reports.dayCard.textCopied'),
        text: { labels: textLabels },
      });
      if (!result.shared && result.reason === 'unavailable') {
        toast.show({ message: t('day.shareUnavailable'), variant: 'error' });
      }
    } catch (error) {
      // A blank capture has its own message: "try once more" is genuinely the fix, and
      // telling her the send failed would send her looking for a problem with the phone.
      const message = error instanceof BlankCaptureError ? t('day.captureBlank') : t('day.shareFailed');
      toast.show({ message, variant: 'error' });
    } finally {
      setSharing(false);
    }
  }, [capture, card.data, t, textLabels, toast]);

  const data = card.data;
  const previewHeight =
    previewWidth > 0 ? (previewWidth * DAY_CARD_PIXELS.height) / DAY_CARD_PIXELS.width : 0;

  return (
    <Screen
      background="bgSunken"
      footer={
        <Button
          title={t('day.share')}
          onPress={() => void share()}
          size="xl"
          fullWidth
          disabled={!data || capture.busy}
          loading={sharing}
        />
      }
    >
      <ScreenHeader title={t('day.title')} subtitle={t('day.subtitle')} onBack={() => router.back()} />

      <Text variant="body" tone="muted" style={{ paddingBottom: spacing.lg }}>
        {t('day.youChoose')}
      </Text>

      {profile.loading || card.loading ? (
        <Skeleton height={420} label={t('day.preparing')} />
      ) : card.error || !data ? (
        <EmptyState
          title={t('day.buildFailed')}
          message={t('day.buildFailedMessage')}
          icon="alert"
          actionLabel={t('errors.tryAgain')}
          onAction={card.reload}
        />
      ) : (
        <Card padding={spacing.sm}>
          <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.sm }}>
            {formatDate(localDate)}
          </Text>
          <View onLayout={onPreviewLayout} style={{ borderRadius: radii.md, overflow: 'hidden' }}>
            {previewWidth > 0 ? (
              <DayCard data={data} width={previewWidth} height={previewHeight} labels={labels} />
            ) : null}
          </View>
        </Card>
      )}

      {/* The capture host must live inside this screen's own tree, absolutely positioned
          and nearly transparent, or `captureRef` snapshots a view that was never drawn.
          It renders nothing at all when no capture is in flight. */}
      <DayCardCaptureHost controller={capture} labels={labels} />

      {/* Printed on the card itself and repeated here, so she has read it before sending. */}
      <Banner variant="info" title={t('report.disclaimer')} style={{ marginTop: spacing.lg }} />
    </Screen>
  );
}
