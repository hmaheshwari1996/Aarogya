/**
 * The generated file, before anything is done with it.
 *
 * NOTHING ON THIS SCREEN HAPPENS ON ITS OWN. The report is not shared, not printed and
 * not copied anywhere until she presses one of the three buttons. A screen that opened
 * the share sheet automatically would mean the only way to look at what was produced is
 * to first be asked who to send it to — the wrong order for a document carrying a
 * person's medications, measurements and symptoms.
 *
 * "Save to the phone" is the demoted option, and for an image it is gated behind a
 * blocking warning that is shown every single time with no "don't ask again". The
 * asymmetry is deliberate and belongs to `features/reports/exports/gallery.ts`: sharing
 * reaches one person, while the gallery reaches every photo app, every file manager and
 * every cloud backup on the phone — and a backed-up copy outlives both the file and the
 * app. For a PDF or a spreadsheet the gallery is not even applicable, so those go through
 * Android's own folder picker, which grants access to exactly the folder she chooses.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Print from 'expo-print';
import { File } from 'expo-file-system';
import { StorageAccessFramework, writeAsStringAsync } from 'expo-file-system/legacy';

import {
  Banner,
  Button,
  Card,
  EmptyState,
  Icon,
  Screen,
  ScreenHeader,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useT, type LocalStrings } from '@/app/_shared/lib';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { MIME, saveImageToGallery, shareFile } from '@/features/reports';

const STRINGS: LocalStrings = {
  'preview.title': { en: 'Your report', hi: 'आपकी रिपोर्ट' },
  'preview.subtitle': {
    en: 'Nothing is sent until you choose to send it.',
    hi: 'जब तक आप न भेजें, कुछ भी नहीं भेजा जाता।',
  },
  'preview.gone': { en: 'That file is no longer here', hi: 'वह फ़ाइल अब यहाँ नहीं है' },
  'preview.goneMessage': { en: 'You can make the report again.', hi: 'आप रिपोर्ट दोबारा बना सकती हैं।' },
  'preview.makeAgain': { en: 'Make it again', hi: 'दोबारा बनाएँ' },
  'preview.fileName': { en: 'File: {{name}}', hi: 'फ़ाइल: {{name}}' },
  'preview.fileSize': { en: 'Size: {{size}}', hi: 'आकार: {{size}}' },
  'preview.kb': { en: '{{value}} KB', hi: '{{value}} KB' },
  'preview.mb': { en: '{{value}} MB', hi: '{{value}} MB' },
  'preview.pdfCard': { en: 'A printable report', hi: 'छापने लायक रिपोर्ट' },
  'preview.csvCard': { en: 'A spreadsheet file', hi: 'स्प्रेडशीट फ़ाइल' },
  'preview.imageAlt': { en: 'The report', hi: 'रिपोर्ट' },
  'preview.cannotShow': {
    en: 'This file cannot be shown on the screen, but it is ready to send, print or save.',
    hi: 'यह फ़ाइल स्क्रीन पर नहीं दिखाई जा सकती, पर भेजने, छापने या सेव करने के लिए तैयार है।',
  },
  'preview.saved': { en: 'Saved to the phone', hi: 'फोन में सेव हो गई' },
  'preview.saveFailed': { en: 'It could not be saved.', hi: 'यह सेव नहीं हो पाई।' },
  'preview.printFailed': { en: 'It could not be printed.', hi: 'यह छप नहीं पाई।' },
  'preview.shareUnavailable': {
    en: 'This phone cannot open the sharing window.',
    hi: 'यह फोन भेजने वाली विंडो नहीं खोल पा रहा।',
  },
  'preview.noFolder': {
    en: 'No folder was chosen, so nothing was saved.',
    hi: 'कोई फ़ोल्डर नहीं चुना गया, इसलिए कुछ सेव नहीं हुआ।',
  },
  // A faithful translation of GALLERY_WARNING / GALLERY_WARNING_TITLE from
  // features/reports/exports/gallery.ts. That module requires the warning to be shown
  // every time with an explicit yes and no "don't show this again" — showing it only in
  // English to a Hindi reader would satisfy the letter of that rule and none of its point.
  'preview.galleryTitle': {
    en: 'Saving to the phone gallery makes this readable by other apps',
    hi: 'गैलरी में सेव करने पर इसे दूसरी ऐप भी पढ़ सकेंगी',
  },
  'preview.galleryWarning': {
    en:
      'Anything saved to the gallery can be opened by every photo app, file manager and cloud backup on this phone.\n\n' +
      'If photo backup is switched on, a copy is uploaded to the internet and stays there even if you delete it here.\n\n' +
      'It also stays on the phone after Aarogya is removed.\n\n' +
      'Sending it directly to one person with the Send button is safer: only that person receives it.',
    hi:
      'गैलरी में सेव की गई कोई भी चीज़ इस फोन की हर फोटो ऐप, फ़ाइल मैनेजर और क्लाउड बैकअप खोल सकता है।\n\n' +
      'अगर फोटो बैकअप चालू है, तो एक कॉपी इंटरनेट पर चली जाएगी और यहाँ से हटाने पर भी वहाँ बनी रहेगी।\n\n' +
      'आरोग्य हटा देने के बाद भी यह फोन में रहेगी।\n\n' +
      'भेजें बटन से सीधे एक ही व्यक्ति को भेजना ज़्यादा सुरक्षित है: सिर्फ़ वही व्यक्ति इसे पाएगा।',
  },
  'preview.gallerySaveAnyway': { en: 'Save to the gallery anyway', hi: 'फिर भी गैलरी में सेव करें' },
  'preview.gallerySendInstead': { en: 'Send it instead', hi: 'इसकी जगह भेज दें' },
  'preview.galleryDenied': {
    en: 'Permission to save pictures was not given, so nothing was saved.',
    hi: 'तस्वीर सेव करने की अनुमति नहीं मिली, इसलिए कुछ सेव नहीं हुआ।',
  },
};

type Kind = 'pdf' | 'csv' | 'image';

const MIME_FOR: Readonly<Record<Kind, string>> = {
  pdf: MIME.pdf,
  csv: MIME.csv,
  image: MIME.png,
};

function readKind(raw: string | string[] | undefined): Kind {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === 'csv') return 'csv';
  if (value === 'image') return 'image';
  return 'pdf';
}

function formatSize(
  bytes: number,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  if (bytes >= 1024 * 1024) return t('preview.mb', { value: (bytes / (1024 * 1024)).toFixed(1) });
  return t('preview.kb', { value: Math.max(1, Math.round(bytes / 1024)) });
}

export default function ReportPreviewScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();

  const params = useLocalSearchParams<{ uri?: string | string[]; kind?: string | string[] }>();
  const rawUri = Array.isArray(params.uri) ? params.uri[0] : params.uri;
  const uri = rawUri ? decodeURIComponent(rawUri) : undefined;
  const kind = readKind(params.kind);

  const [busy, setBusy] = useState<'share' | 'print' | 'save' | null>(null);

  /**
   * Read once, synchronously. `exists` and `size` are properties on the new file API
   * rather than promises, so there is no loading state to get wrong — and a file already
   * swept out of the exports folder shows the honest "no longer here" screen instead of a
   * Send button that fails when pressed.
   */
  const info = useMemo(() => {
    if (!uri) return null;
    try {
      const file = new File(uri);
      if (!file.exists) return null;
      return { name: file.name, size: file.size };
    } catch {
      return null;
    }
  }, [uri]);

  const share = useCallback(async () => {
    if (!uri) return;
    setBusy('share');
    try {
      // The OS sheet owns the recipient. This app has no contacts and no default.
      const outcome = await shareFile({
        uri,
        mimeType: MIME_FOR[kind],
        dialogTitle: t('reports.share'),
      });
      if (!outcome.shared) {
        const message =
          outcome.reason === 'unavailable' ? t('preview.shareUnavailable') : t('reports.shareFailed');
        toast.show({ message, variant: 'error' });
      }
    } finally {
      setBusy(null);
    }
  }, [kind, t, toast, uri]);

  const print = useCallback(async () => {
    if (!uri) return;
    setBusy('print');
    try {
      await Print.printAsync({ uri });
    } catch {
      toast.show({ message: t('preview.printFailed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [t, toast, uri]);

  const saveImage = useCallback(async () => {
    if (!uri) return;
    // Shown every time, with two buttons that do not both read like agreement, and no way
    // to switch it off. Required by `saveImageToGallery`, which refuses to run without it.
    const accepted = await confirm({
      title: t('preview.galleryTitle'),
      message: t('preview.galleryWarning'),
      confirmLabel: t('preview.gallerySaveAnyway'),
      cancelLabel: t('preview.gallerySendInstead'),
      destructive: true,
    });
    if (!accepted) return;

    const outcome = await saveImageToGallery(uri, { userAcceptedWarning: true });
    if (outcome.saved) {
      toast.show({ message: t('preview.saved'), variant: 'success' });
      return;
    }
    toast.show({
      message: outcome.reason === 'permission-denied' ? t('preview.galleryDenied') : t('preview.saveFailed'),
      variant: 'error',
    });
  }, [confirm, t, toast, uri]);

  const saveDocument = useCallback(async () => {
    if (!uri || !info) return;
    // A PDF or a spreadsheet is not gallery media (`GALLERY_SUPPORTS_PDF` is false).
    // Android's folder picker lets her put it where she will find it again and grants this
    // app access to exactly that one folder rather than to her storage.
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) {
      toast.show({ message: t('preview.noFolder'), variant: 'error' });
      return;
    }
    const target = await StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      info.name,
      MIME_FOR[kind],
    );
    const contents = await new File(uri).base64();
    await writeAsStringAsync(target, contents, { encoding: 'base64' });
    toast.show({ message: t('preview.saved'), variant: 'success' });
  }, [info, kind, t, toast, uri]);

  const save = useCallback(async () => {
    setBusy('save');
    try {
      await (kind === 'image' ? saveImage() : saveDocument());
    } catch {
      toast.show({ message: t('preview.saveFailed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [kind, saveDocument, saveImage, t, toast]);

  if (!uri || !info) {
    return (
      <Screen background="bgSunken">
        <ScreenHeader title={t('preview.title')} onBack={() => router.back()} />
        <EmptyState
          title={t('preview.gone')}
          message={t('preview.goneMessage')}
          icon="alert"
          actionLabel={t('preview.makeAgain')}
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <Screen
      background="bgSunken"
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('reports.share')}
            onPress={() => void share()}
            size="xl"
            fullWidth
            loading={busy === 'share'}
            disabled={busy !== null}
          />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            {kind === 'csv' ? null : (
              <Button
                title={t('reports.print')}
                onPress={() => void print()}
                variant="secondary"
                style={{ flex: 1 }}
                loading={busy === 'print'}
                disabled={busy !== null}
              />
            )}
            <Button
              title={t('reports.saveToPhone')}
              onPress={() => void save()}
              variant="secondary"
              style={{ flex: 1 }}
              loading={busy === 'save'}
              disabled={busy !== null}
            />
          </View>
        </View>
      }
    >
      <ScreenHeader title={t('preview.title')} subtitle={t('preview.subtitle')} onBack={() => router.back()} />

      {kind === 'image' ? (
        <Card>
          <Image
            source={{ uri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('preview.imageAlt')}
            resizeMode="contain"
            style={{
              width: '100%',
              height: 520,
              borderRadius: radii.md,
              backgroundColor: colors.bgSunken,
            }}
          />
        </Card>
      ) : (
        <Card style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
            <Icon name="info" size={32} color={colors.primary} />
            <Text variant="label" style={{ flex: 1 }}>
              {t(kind === 'csv' ? 'preview.csvCard' : 'preview.pdfCard')}
            </Text>
          </View>
          <Text variant="body">{t('preview.fileName', { name: info.name })}</Text>
          <Text variant="body">{t('preview.fileSize', { size: formatSize(info.size, t) })}</Text>
          <Text variant="body" tone="muted">
            {t('preview.cannotShow')}
          </Text>
        </Card>
      )}

      {/* The report itself carries this line. It is repeated here so that whoever is
          holding the phone has read it before the file leaves. */}
      <Banner variant="info" title={t('report.disclaimer')} style={{ marginTop: spacing.lg }} />
    </Screen>
  );
}
