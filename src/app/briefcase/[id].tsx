/**
 * One paper from the briefcase — look at it, send a copy, rename it, remove it.
 *
 * ─── READING IT IS THE POINT, SO READING IT GETS A WHOLE SCREEN ───────────────
 * A photograph of an A4 discharge summary shown at 240dp is a picture OF a document, not a
 * document. For a reader with presbyopia at a 1.3× font scale it is decorative. So the
 * image opens full screen, and it magnifies in three fixed steps rather than by pinching.
 *
 * WHY STEPS AND NOT PINCH-TO-ZOOM. Pinch needs two fingers that arrive at the same moment
 * and then move apart at the same rate, which is exactly what a tremor takes away — and
 * `maximumZoomScale` on a ScrollView is iOS-only, so on this phone it would have meant
 * hand-rolling gesture handling and inertia. Two big buttons and three known steps can be
 * driven with one unsteady finger, are reachable by TalkBack, and cannot land the user in
 * a zoom state she does not know how to get out of. `Fit to Screen` is always one tap away.
 *
 * ─── A PDF LEAVES THE APP, AND THE SCREEN SAYS SO BEFORE SHE TAPS ─────────────
 * There is no PDF or Word renderer in this app and there should not be: one is measured in
 * megabytes against a 32 MB budget, for a file the phone's own viewer already opens. The
 * only way to read one is to hand a copy to another app — and that is the single moment in
 * this feature where her data leaves Aarogya. The explanation sits ABOVE the button,
 * permanently, in plain words: the other app gets its own copy and Aarogya cannot take it
 * back. The Android chooser is itself the second, deliberate step, which is why there is no
 * extra confirmation dialog stacked in front of it — a dialog before a dialog is what
 * teaches people to tap through both.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Image,
  Modal,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { useDateFormat } from '@/i18n/useDateFormat';
import {
  Banner,
  Button,
  Card,
  Dialog,
  Divider,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  deleteDocument,
  getDocument,
  setDocumentPinned,
  updateDocument,
  type DocumentRecord,
} from '@/db/repositories/contacts';

import { useAsync, useT, type LocalStrings } from '../_shared/lib';
import {
  BRIEFCASE_SHARED_STRINGS,
  fileTypeKey,
  formatBytes,
  isImageDocument,
  kindLabelKey,
  sweepPendingFileDeletes,
} from './_lib';

/**
 * Kind and file-type labels are shared because their keys are built at runtime; everything
 * this screen names literally is declared here so `scripts/check-i18n.js` can verify it.
 * The full reasoning sits next to `BRIEFCASE_SHARED_STRINGS`.
 */
const STRINGS: LocalStrings = {
  ...BRIEFCASE_SHARED_STRINGS,

  'briefcase.title': { en: 'Briefcase', hi: 'काग़ज़ों का बस्ता' },
  'briefcase.notFound': {
    en: 'This paper is no longer in the briefcase.',
    hi: 'यह काग़ज़ अब बस्ते में नहीं है।',
  },
  'briefcase.thumbLabel': { en: 'Picture of {{title}}', hi: '{{title}} की तस्वीर' },

  // ── Reading it ─────────────────────────────────────────────────────────────
  'briefcase.openBig': { en: 'See It Bigger', hi: 'बड़ा करके देखिए' },
  'briefcase.zoomIn': { en: 'Bigger', hi: 'बड़ा' },
  'briefcase.zoomOut': { en: 'Smaller', hi: 'छोटा' },
  'briefcase.missingFile': {
    en: 'The file behind this entry is not on the phone any more. The entry is kept so you know it was here.',
    hi: 'इस पंक्ति की फ़ाइल अब फ़ोन में नहीं है। यह पंक्ति इसलिए रखी है ताकि आपको पता रहे कि यह यहाँ था।',
  },

  // ── The one moment her data leaves this app ────────────────────────────────
  'briefcase.cannotShow': {
    en: 'Aarogya cannot show this kind of file itself.',
    hi: 'आरोग्य इस तरह की फ़ाइल ख़ुद नहीं दिखा सकता।',
  },
  'briefcase.handOff': {
    en: 'You can send a copy to another app on this phone that can open it. From that moment the other app has its own copy, and Aarogya cannot take it back.',
    hi: 'आप इसकी एक नक़ल इसी फ़ोन के किसी दूसरे ऐप को भेज सकती हैं जो इसे खोल सके। उसी पल दूसरे ऐप के पास अपनी नक़ल आ जाती है, और आरोग्य उसे वापस नहीं ले सकता।',
  },
  'briefcase.send': { en: 'Send a Copy to Another App', hi: 'दूसरे ऐप को नक़ल भेजिए' },
  'briefcase.sendUnavailable': {
    en: 'This phone has nothing to send files with.',
    hi: 'इस फ़ोन में फ़ाइल भेजने के लिए कुछ नहीं है।',
  },
  'briefcase.sendFailed': { en: 'The copy could not be sent.', hi: 'नक़ल भेजी नहीं जा सकी।' },

  // ── What it is ─────────────────────────────────────────────────────────────
  'briefcase.detailKind': { en: 'Kind of paper', hi: 'काग़ज़ का प्रकार' },
  'briefcase.detailAdded': { en: 'Added on', hi: 'जोड़ा गया' },
  'briefcase.detailType': { en: 'File type', hi: 'फ़ाइल का प्रकार' },
  'briefcase.detailSize': { en: 'Size', hi: 'आकार' },
  'briefcase.detailFileName': { en: 'File name', hi: 'फ़ाइल का नाम' },
  'briefcase.detailStorage': {
    en: 'Kept on this phone only. It is included in a backup you make yourself.',
    hi: 'सिर्फ़ इसी फ़ोन में रखा है। आपके ख़ुद बनाए बैकअप में यह शामिल होता है।',
  },

  // ── Keeping it to hand ─────────────────────────────────────────────────────
  // A pin is a per-DEVICE view preference, not a fact about the record: it does not sync
  // (see the `isPinned` note in contacts.ts). The word carries the meaning; no pin glyph
  // exists in the icon set and one is not worth adding for a single control.
  'briefcase.pin': { en: 'Pin to Top', hi: 'ऊपर पिन कीजिए' },
  'briefcase.unpin': { en: 'Remove the Pin', hi: 'पिन हटाइए' },
  'briefcase.pinned': { en: 'Pinned to the top', hi: 'ऊपर पिन कर दिया' },
  'briefcase.unpinned': { en: 'Pin removed', hi: 'पिन हटा दिया' },

  // ── Changing and removing ──────────────────────────────────────────────────
  'briefcase.rename': { en: 'Change the Name', hi: 'नाम बदलिए' },
  'briefcase.renameTitle': { en: 'Change the Name', hi: 'नाम बदलिए' },
  'briefcase.renamed': { en: 'Name changed', hi: 'नाम बदल दिया' },
  'briefcase.titleLabel': { en: 'What is this paper?', hi: 'यह कौन सा काग़ज़ है?' },
  'briefcase.titleHelper': {
    en: 'A few words you will recognise later, like "Apollo discharge, November".',
    hi: 'दो-चार शब्द जो बाद में आपको पहचान में आएँ, जैसे "अपोलो डिस्चार्ज, नवंबर"।',
  },
  'briefcase.remove': { en: 'Remove from Aarogya', hi: 'आरोग्य से हटाइए' },
  'briefcase.removeTitle': { en: 'Remove {{title}}?', hi: '{{title}} हटा दें?' },
  'briefcase.removeOwnedMessage': {
    en: 'The file will be deleted from this phone. Aarogya keeps no other copy, so this cannot be undone. Anything you already sent to someone stays with them.',
    hi: 'यह फ़ाइल इस फ़ोन से मिटा दी जाएगी। आरोग्य के पास कोई और नक़ल नहीं है, इसलिए यह वापस नहीं आ सकती। जो आपने पहले किसी को भेजा है वह उनके पास रहेगा।',
  },
  'briefcase.removeIndexedMessage': {
    en: 'It will no longer be listed here. The picture itself belongs to another record in Aarogya and stays there.',
    hi: 'यह यहाँ नहीं दिखेगा। तस्वीर आरोग्य के किसी और रिकॉर्ड की है और वहीं रहेगी।',
  },
  'briefcase.removed': { en: 'Removed', hi: 'हटा दिया' },
  'briefcase.removeFailed': {
    en: 'It could not be removed. Please try again.',
    hi: 'यह हटाया नहीं जा सका। कृपया फिर कोशिश करें।',
  },
};

/** Magnification steps. 1 fits the width; 3 is roughly a magnifying glass over a page. */
const ZOOM_STEPS = [1, 2, 3] as const;

/** In-page preview height. Big enough to identify the page, never big enough to read it. */
const PREVIEW_HEIGHT = 260;

/**
 * The full-screen reader.
 *
 * Nested scroll views — vertical outside, horizontal inside — because at 3× a portrait page
 * is three screens wide and about four tall, and both axes have to be reachable. The image
 * is laid out from its real aspect ratio (`Image.getSize`) so a page is never squashed;
 * until that arrives, a portrait A4 ratio is assumed, which is right for almost every
 * medical paper and wrong only for a moment.
 */
function FullScreenImage({
  uri,
  label,
  onClose,
  closeLabel,
  zoomInLabel,
  zoomOutLabel,
}: {
  uri: string;
  /** All already translated. */
  label: string;
  onClose: () => void;
  closeLabel: string;
  zoomInLabel: string;
  zoomOutLabel: string;
}) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  // A Modal draws edge to edge and `Screen`'s safe-area handling does not reach inside one,
  // so the insets are owed here directly. Without the bottom one the Close button sits on
  // MIUI's gesture bar, which is the single control this screen cannot afford to lose.
  const insets = useSafeAreaInsets();
  const [aspect, setAspect] = useState(1 / 1.414);
  const [step, setStep] = useState(0);

  React.useEffect(() => {
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setAspect(w / h);
      },
      () => {
        /* keep the A4 assumption; a broken image is handled by the caller */
      },
    );
    return () => {
      alive = false;
    };
  }, [uri]);

  const zoom = ZOOM_STEPS[step] ?? 1;
  const imageWidth = width * zoom;
  // Step 1 fits the WIDTH, not the whole page. A portrait page shrunk to fit the height
  // of a phone is a picture of a document; fitting the width makes the text as large as it
  // can be without a horizontal scroll, and the page runs on downwards the way paper does.
  const imageHeight = imageWidth / aspect;

  return (
    <Modal
      visible
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      // NOT `transparent`. A page of small print read over a dimmed screen showing through
      // it is a page with a second, competing image underneath every line — so this modal
      // is opaque, which is the default and is left as the default deliberately.
    >
      <View style={{ flex: 1, backgroundColor: colors.bgSunken }}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ minHeight: height * 0.6, paddingTop: insets.top }}
          persistentScrollbar
        >
          {/* The inner scroller is given the image's exact height rather than left to work
              it out. A horizontal ScrollView nested inside a vertical one has no bounded
              cross-axis to measure against, and "sometimes collapses to nothing" is not a
              thing to leave to chance on the screen where she reads her discharge summary. */}
          <ScrollView
            horizontal
            persistentScrollbar
            style={{ height: imageHeight }}
            contentContainerStyle={{ minWidth: width }}
          >
            <Image
              source={{ uri }}
              accessible
              accessibilityRole="image"
              accessibilityLabel={label}
              resizeMode="contain"
              style={{ width: imageWidth, height: imageHeight }}
            />
          </ScrollView>
        </ScrollView>

        {/* Two rows, not three buttons across. At a 1.3× font scale three labels in one row
            are three cramped targets for an unsteady finger; Close earns its own full-width
            row because it is the one that must never be mis-hit or missed. */}
        <View
          style={{
            gap: spacing.md,
            padding: spacing.lg,
            paddingBottom: spacing.lg + insets.bottom,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.bg,
          }}
        >
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button
              title={zoomOutLabel}
              onPress={() => setStep(Math.max(0, step - 1))}
              variant="secondary"
              size="lg"
              disabled={step === 0}
              style={{ flex: 1 }}
            />
            <Button
              title={zoomInLabel}
              onPress={() => setStep(Math.min(ZOOM_STEPS.length - 1, step + 1))}
              variant="secondary"
              size="lg"
              disabled={step >= ZOOM_STEPS.length - 1}
              style={{ flex: 1 }}
            />
          </View>
          <Button title={closeLabel} onPress={onClose} size="lg" fullWidth />
        </View>
      </View>
    </Modal>
  );
}

/** One label/value line on the detail card. */
function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label}. ${value}`} style={{ gap: spacing.xs }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body" numberOfLines={3} ellipsizeMode="middle">
        {value}
      </Text>
    </View>
  );
}

export default function BriefcaseDocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const { formatEpochDate } = useDateFormat();
  const toast = useToast();
  const confirm = useConfirm();

  const { data, loading, reload } = useAsync<DocumentRecord | null>(
    async () => (id ? getDocument(id) : null),
    [id],
  );

  const [reading, setReading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [imageBroken, setImageBroken] = useState(false);
  const [working, setWorking] = useState(false);

  const isImage = useMemo(
    () => (data ? isImageDocument(data.mimeType, data.originalFileName ?? data.fileUri) : false),
    [data],
  );

  const share = useCallback(async () => {
    if (!data) return;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        toast.show({ message: t('briefcase.sendUnavailable'), variant: 'error' });
        return;
      }
      await Sharing.shareAsync(data.fileUri, {
        // Handing over the MIME type is what makes the chooser offer a PDF reader rather
        // than a list of apps that will not open it.
        ...(data.mimeType ? { mimeType: data.mimeType } : {}),
        dialogTitle: data.title,
      });
    } catch {
      toast.show({ message: t('briefcase.sendFailed'), variant: 'error' });
    }
  }, [data, t, toast]);

  const saveRename = useCallback(async () => {
    if (!data) return;
    const next = draftTitle.trim();
    if (next.length === 0) return;
    setWorking(true);
    try {
      await updateDocument(data.id, { title: next });
      setRenaming(false);
      toast.show({ message: t('briefcase.renamed'), variant: 'success' });
      reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setWorking(false);
    }
  }, [data, draftTitle, reload, t, toast]);

  const togglePin = useCallback(async () => {
    if (!data) return;
    setWorking(true);
    try {
      await setDocumentPinned(data.id, !data.isPinned);
      toast.show({
        message: t(data.isPinned ? 'briefcase.unpinned' : 'briefcase.pinned'),
        variant: 'success',
      });
      reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setWorking(false);
    }
  }, [data, reload, t, toast]);

  const remove = useCallback(async () => {
    if (!data) return;
    const ok = await confirm({
      title: t('briefcase.removeTitle', { title: data.title }),
      // Two different truths, and the row knows which one applies. A briefcase document
      // owns its file and the bytes go; a row that merely indexes another feature's
      // photograph is only delisted. Saying "deleted from this phone" in the second case
      // would be a lie, and saying "only delisted" in the first would be a worse one.
      message: data.ownsFile
        ? t('briefcase.removeOwnedMessage')
        : t('briefcase.removeIndexedMessage'),
      confirmLabel: t('common.remove'),
      destructive: true,
    });
    if (!ok) return;

    setWorking(true);
    try {
      // Row + deletion request, in one transaction. After this returns there is no state
      // where she has been told it is gone and it is not.
      await deleteDocument(data.id);
      // And then the bytes. If this is interrupted the request survives on disk and the
      // next sweep finishes it — which is why the failure below is not reported as a
      // failed removal: the removal has already happened.
      void sweepPendingFileDeletes();
      toast.show({ message: t('briefcase.removed'), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('briefcase.removeFailed'), variant: 'error' });
    } finally {
      setWorking(false);
    }
  }, [confirm, data, t, toast]);

  if (loading) {
    return (
      <Screen background="bgSunken">
        <ScreenHeader title={t('briefcase.title')} onBack={() => router.back()} />
        <View style={{ gap: spacing.md }}>
          <Skeleton height={PREVIEW_HEIGHT} />
          <Skeleton height={spacing.touchTarget} />
          <Skeleton height={spacing.touchTarget} />
        </View>
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen background="bgSunken">
        <ScreenHeader title={t('briefcase.title')} onBack={() => router.back()} />
        <EmptyState title={t('briefcase.notFound')} />
      </Screen>
    );
  }

  const typeLabel = t(fileTypeKey(data.mimeType, data.originalFileName ?? data.fileUri));
  const sizeLabel = formatBytes(data.sizeBytes, t);

  return (
    <Screen background="bgSunken">
      <ScreenHeader
        title={data.title}
        subtitle={t(kindLabelKey(data.kind))}
        onBack={() => router.back()}
      />

      {/* ── The paper itself ──────────────────────────────────────────────────── */}
      <Card style={{ gap: spacing.md }}>
        {isImage && !imageBroken ? (
          <>
            <PressableScale
              onPress={() => setReading(true)}
              accessibilityRole="button"
              accessibilityLabel={t('briefcase.thumbLabel', { title: data.title })}
              accessibilityHint={t('briefcase.openBig')}
            >
              <Image
                source={{ uri: data.fileUri }}
                resizeMode="contain"
                onError={() => setImageBroken(true)}
                style={{
                  width: '100%',
                  height: PREVIEW_HEIGHT,
                  borderRadius: radii.md,
                  backgroundColor: colors.bgSunken,
                }}
              />
            </PressableScale>
            <Button
              title={t('briefcase.openBig')}
              onPress={() => setReading(true)}
              size="lg"
              fullWidth
            />
          </>
        ) : (
          <View
            accessible
            accessibilityLabel={`${typeLabel}${sizeLabel ? `. ${sizeLabel}` : ''}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              padding: spacing.lg,
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgSunken,
            }}
          >
            <Icon name="info" size={32} color={colors.textMuted} />
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text variant="label">{typeLabel}</Text>
              {data.originalFileName ? (
                <Text variant="body" tone="muted" numberOfLines={2} ellipsizeMode="middle">
                  {data.originalFileName}
                </Text>
              ) : null}
            </View>
          </View>
        )}

        {/* An image row whose file is gone still exists on purpose: the entry is evidence
            the paper was here, and quietly hiding it would be the app editing her record. */}
        {imageBroken ? <Banner variant="attention" title={t('briefcase.missingFile')} /> : null}

        {!isImage || imageBroken ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="body">{t('briefcase.cannotShow')}</Text>
            {/* Stated BEFORE the button, always visible, never behind a tap. */}
            <Text variant="body" tone="muted">
              {t('briefcase.handOff')}
            </Text>
          </View>
        ) : null}

        <Button
          title={t('briefcase.send')}
          onPress={() => void share()}
          variant="secondary"
          size="lg"
          fullWidth
        />
      </Card>

      {/* ── What it is ────────────────────────────────────────────────────────── */}
      <Card style={{ gap: spacing.lg, marginTop: spacing.lg }}>
        <DetailLine label={t('briefcase.detailKind')} value={t(kindLabelKey(data.kind))} />
        <DetailLine
          label={t('briefcase.detailAdded')}
          value={formatEpochDate(data.createdAtEpoch)}
        />
        <DetailLine label={t('briefcase.detailType')} value={typeLabel} />
        {sizeLabel ? <DetailLine label={t('briefcase.detailSize')} value={sizeLabel} /> : null}
        {data.originalFileName ? (
          <DetailLine label={t('briefcase.detailFileName')} value={data.originalFileName} />
        ) : null}

        <Text variant="caption" tone="muted">
          {t('briefcase.detailStorage')}
        </Text>
      </Card>

      {/* ── Changing or removing it ───────────────────────────────────────────── */}
      <Divider strong style={{ marginVertical: spacing.xl }} />

      <View style={{ gap: spacing.md }}>
        <Button
          title={t('briefcase.rename')}
          onPress={() => {
            setDraftTitle(data.title);
            setRenaming(true);
          }}
          variant="secondary"
          size="lg"
          fullWidth
        />
        <Button
          title={t(data.isPinned ? 'briefcase.unpin' : 'briefcase.pin')}
          onPress={() => void togglePin()}
          variant="secondary"
          size="lg"
          fullWidth
          disabled={working}
        />
        <Button
          title={t('briefcase.remove')}
          onPress={() => void remove()}
          variant="destructive"
          size="lg"
          fullWidth
          loading={working}
        />
      </View>

      <Dialog
        visible={renaming}
        title={t('briefcase.renameTitle')}
        onRequestClose={() => setRenaming(false)}
        // A rename is a write; a stray tap on the backdrop must not be able to commit or
        // silently discard what she just typed.
        dismissOnBackdrop={false}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.save')}
              onPress={() => void saveRename()}
              size="lg"
              fullWidth
              disabled={draftTitle.trim().length === 0}
              loading={working}
            />
            <Button
              title={t('common.cancel')}
              onPress={() => setRenaming(false)}
              variant="ghost"
              size="md"
              fullWidth
            />
          </View>
        }
      >
        <TextField
          label={t('briefcase.titleLabel')}
          helper={t('briefcase.titleHelper')}
          value={draftTitle}
          onChangeText={setDraftTitle}
          autoCapitalize="sentences"
          required
        />
      </Dialog>

      {reading && isImage && !imageBroken ? (
        <FullScreenImage
          uri={data.fileUri}
          label={t('briefcase.thumbLabel', { title: data.title })}
          onClose={() => setReading(false)}
          closeLabel={t('common.close')}
          zoomInLabel={t('briefcase.zoomIn')}
          zoomOutLabel={t('briefcase.zoomOut')}
        />
      ) : null}
    </Screen>
  );
}
