/**
 * Saved reports and papers — read, open, and (with a warning) export.
 *
 * ─── THE GALLERY DIALOG IS NEVER REMEMBERED ───────────────────────────────────────
 * There is no "don't ask again", no stored preference, and no first-time-only variant.
 * The full warning is shown for every single image, every single time.
 *
 * That is not caution theatre. The consequence is PER IMAGE and it is IRREVERSIBLE: the
 * moment a picture of a prescription lands in the shared gallery, whatever is syncing that
 * folder — Google Photos, Mi Cloud, a manufacturer's own backup, a chat app's media
 * scanner — may upload it, back it up, surface it in a shared album, and put it on the
 * home screen inside a photo widget. Nothing in this app can reach into any of those and
 * take it back.
 *
 * A remembered consent is consent given once for a decision made many times. She agreed
 * to export a blood-test slip in March; that is not agreement to export a TB prescription
 * in July, and in India the second one can cost someone their housing or their job. So the
 * question is asked again, in full, with Cancel first.
 * ──────────────────────────────────────────────────────────────────────────────────
 *
 * The rest of the screen is read-only in the same sense as the dashboard: a document can
 * be looked at and shared out, never renamed and never deleted. The underlying file is
 * frequently the only copy of that piece of paper in existence.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, Image, View } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { spacing, radii } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { listDocuments, type DocumentRecord } from '@/db/repositories/contacts';
import {
  Thumb,
  fixedItemLayout,
  resolveProfileId,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';

const THUMB_SIZE = 56;
const ROW_HEIGHT = 96;
const PREVIEW_HEIGHT = 320;

/** `document.kind` is free text. Only the kinds the app itself writes get a word. */
const KIND_KEYS: Readonly<Record<string, string>> = {
  prescription: 'viewer.saved.kind.prescription',
  lab_report: 'viewer.saved.kind.labReport',
  report: 'viewer.saved.kind.report',
  discharge: 'viewer.saved.kind.discharge',
  insurance: 'viewer.saved.kind.insurance',
  id: 'viewer.saved.kind.id',
};

const STRINGS: LocalStrings = {
  'viewer.saved.title': { en: 'Saved papers', hi: 'सहेजे हुए काग़ज़' },
  'viewer.saved.subtitle': {
    en: 'Everything saved in Aarogya on this phone. Tap one to look at it.',
    hi: 'इस फ़ोन पर आरोग्य में सहेजा हुआ सब कुछ। देखने के लिए किसी एक को दबाएँ।',
  },
  'viewer.saved.empty': { en: 'Nothing saved yet', hi: 'अभी कुछ सहेजा नहीं गया' },
  'viewer.saved.emptyMessage': {
    en: 'Prescriptions and reports saved in Aarogya will appear here.',
    hi: 'आरोग्य में सहेजे गए पर्चे और रिपोर्ट यहाँ दिखेंगे।',
  },
  'viewer.saved.loadFailed': {
    en: 'Could not read what is saved on this phone.',
    hi: 'इस फ़ोन पर जो सहेजा है वह पढ़ा नहीं जा सका।',
  },
  'viewer.saved.openHint': { en: 'Opens the picture', hi: 'तस्वीर खोलता है' },
  'viewer.saved.notAPicture': {
    en: 'Aarogya cannot show this one here. You can open it in another app on the phone.',
    hi: 'आरोग्य इसे यहाँ नहीं दिखा सकता। आप इसे फ़ोन के किसी दूसरे ऐप में खोल सकते हैं।',
  },
  'viewer.saved.openWith': { en: 'Open in another app', hi: 'दूसरे ऐप में खोलें' },
  'viewer.saved.openFailed': {
    en: 'No app on this phone could open it.',
    hi: 'इस फ़ोन का कोई ऐप इसे खोल नहीं सका।',
  },
  'viewer.saved.saveToGallery': { en: 'Save to the phone gallery', hi: 'फ़ोन की गैलरी में सहेजें' },
  'viewer.saved.consentTitle': {
    en: 'Put this medical picture in the gallery?',
    hi: 'क्या यह मेडिकल तस्वीर गैलरी में डालनी है?',
  },
  'viewer.saved.consentMessage': {
    en: 'The gallery is shared with every app that syncs your photos — Google Photos and Mi Cloud among them. Once this picture is in there, those apps may upload it and back it up on their own, and it can show up in shared albums and in photo widgets on the home screen.\n\nInside Aarogya it stays on this phone and goes nowhere else.\n\nThis question is asked every single time, on purpose.',
    hi: 'गैलरी हर उस ऐप के साथ साझा होती है जो आपकी फ़ोटो सिंक करता है — जैसे Google Photos और Mi Cloud। एक बार तस्वीर वहाँ चली गई तो ये ऐप उसे अपने आप अपलोड और बैकअप कर सकते हैं, और वह साझा एल्बम और होम स्क्रीन के फ़ोटो विजेट में दिख सकती है।\n\nआरोग्य के अंदर यह इसी फ़ोन पर रहती है और कहीं नहीं जाती।\n\nयह सवाल हर बार जान-बूझकर पूछा जाता है।',
  },
  'viewer.saved.saveAnyway': { en: 'Save anyway', hi: 'फिर भी सहेजें' },
  'viewer.saved.savedToast': { en: 'Saved to the gallery', hi: 'गैलरी में सहेज दिया' },
  'viewer.saved.saveFailed': {
    en: 'Could not save it to the gallery.',
    hi: 'गैलरी में सहेजा नहीं जा सका।',
  },
  'viewer.saved.permissionNeeded': {
    en: 'The phone did not allow saving to the gallery.',
    hi: 'फ़ोन ने गैलरी में सहेजने की अनुमति नहीं दी।',
  },
  'viewer.saved.picture': { en: 'Picture of {{title}}', hi: '{{title}} की तस्वीर' },
  'viewer.saved.kind.prescription': { en: 'Prescription', hi: 'पर्चा' },
  'viewer.saved.kind.labReport': { en: 'Lab report', hi: 'जाँच रिपोर्ट' },
  'viewer.saved.kind.report': { en: 'Report', hi: 'रिपोर्ट' },
  'viewer.saved.kind.discharge': { en: 'Discharge summary', hi: 'डिस्चार्ज सारांश' },
  'viewer.saved.kind.insurance': { en: 'Insurance paper', hi: 'बीमा का काग़ज़' },
  'viewer.saved.kind.id': { en: 'Identity paper', hi: 'पहचान का काग़ज़' },
};

export default function ViewerSavedScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();

  const state = useAsync<DocumentRecord[] | null>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) return null;
    return listDocuments(profileId);
  }, []);

  useReloadOnFocus(state.reload);

  const [preview, setPreview] = useState<DocumentRecord | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);

  const openPreview = useCallback((document: DocumentRecord) => {
    setPreviewBroken(false);
    setPreview(document);
  }, []);

  const openElsewhere = useCallback(
    async (document: DocumentRecord) => {
      try {
        await Sharing.shareAsync(document.fileUri, { dialogTitle: document.title });
      } catch {
        toast.show({ message: t('viewer.saved.openFailed'), variant: 'error' });
      }
    },
    [toast, t],
  );

  const saveToGallery = useCallback(
    async (document: DocumentRecord) => {
      // The preview modal is closed first: two stacked Android modals is a known way to
      // end up with a dialog nobody can dismiss, and the question below names the
      // document anyway.
      setPreview(null);

      // NOTHING ABOUT THIS ANSWER IS STORED. See the file header. `useConfirm` puts
      // Cancel first and resolves false for a backdrop tap or the hardware back button,
      // so every accidental path lands on "no".
      const agreed = await confirm({
        title: t('viewer.saved.consentTitle'),
        message: t('viewer.saved.consentMessage'),
        confirmLabel: t('viewer.saved.saveAnyway'),
        cancelLabel: t('common.cancel'),
        // `destructive` here is about the UI action, not about anything clinical: this is
        // an irreversible export of private data, in the same family as revoking a
        // viewer, and it should not look like a routine Save.
        destructive: true,
      });
      if (!agreed) return;

      try {
        // writeOnly: Aarogya never reads the gallery. It has no business enumerating her
        // photos, and asking for read access would put a Photos permission prompt in
        // front of her that the app cannot justify.
        const permission = await MediaLibrary.requestPermissionsAsync(true);
        if (!permission.granted) {
          toast.show({ message: t('viewer.saved.permissionNeeded'), variant: 'error' });
          return;
        }
        await MediaLibrary.saveToLibraryAsync(document.fileUri);
        toast.show({ message: t('viewer.saved.savedToast'), variant: 'success' });
      } catch {
        toast.show({ message: t('viewer.saved.saveFailed'), variant: 'error' });
      }
    },
    [confirm, toast, t],
  );

  const kindLabel = useCallback(
    (kind: string): string | null => {
      const key = KIND_KEYS[kind];
      return key ? t(key) : null;
    },
    [t],
  );

  if (state.loading) {
    return (
      <Screen variant="scroll">
        <ScreenHeader title={t('viewer.saved.title')} />
        <View style={{ gap: spacing.md }}>
          <Skeleton height={ROW_HEIGHT} label={t('common.loading')} />
          <Skeleton height={ROW_HEIGHT} />
          <Skeleton height={ROW_HEIGHT} />
        </View>
      </Screen>
    );
  }

  if (state.error) {
    return (
      <Screen variant="scroll">
        <ScreenHeader title={t('viewer.saved.title')} />
        <EmptyState
          icon="alert"
          title={t('errors.loadFailed')}
          message={t('viewer.saved.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={state.reload}
        />
      </Screen>
    );
  }

  const documents = state.data ?? [];

  return (
    <Screen variant="fixed" padded={false}>
      <FlatList
        style={{ flex: 1 }}
        data={documents}
        keyExtractor={(document) => document.id}
        getItemLayout={fixedItemLayout(ROW_HEIGHT)}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }}
        ListHeaderComponent={
          <ScreenHeader title={t('viewer.saved.title')} subtitle={t('viewer.saved.subtitle')} />
        }
        ListEmptyComponent={
          <EmptyState
            icon="info"
            title={t('viewer.saved.empty')}
            message={t('viewer.saved.emptyMessage')}
          />
        }
        renderItem={({ item }) => {
          const kind = kindLabel(item.kind);
          return (
            <PressableScale
              onPress={() => openPreview(item)}
              accessibilityRole="button"
              accessibilityLabel={kind ? `${item.title}. ${kind}` : item.title}
              accessibilityHint={t('viewer.saved.openHint')}
              style={{
                height: ROW_HEIGHT,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Thumb
                uri={item.fileUri}
                size={THUMB_SIZE}
                label={t('viewer.saved.picture', { title: item.title })}
              />
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text variant="body" weight="600" numberOfLines={1}>
                  {item.title}
                </Text>
                {kind ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {kind}
                  </Text>
                ) : null}
              </View>
              <Icon name="chevronRight" size={24} color={colors.textMuted} />
            </PressableScale>
          );
        }}
      />

      <Dialog
        visible={preview !== null}
        title={preview?.title}
        onRequestClose={() => setPreview(null)}
        footer={
          <View style={{ gap: spacing.md }}>
            {previewBroken ? (
              <Button
                title={t('viewer.saved.openWith')}
                onPress={() => {
                  if (preview) void openElsewhere(preview);
                }}
                variant="secondary"
                size="lg"
                fullWidth
              />
            ) : (
              <Button
                title={t('viewer.saved.saveToGallery')}
                onPress={() => {
                  if (preview) void saveToGallery(preview);
                }}
                variant="secondary"
                size="lg"
                fullWidth
              />
            )}
            <Button
              title={t('common.close')}
              onPress={() => setPreview(null)}
              size="lg"
              fullWidth
            />
          </View>
        }
      >
        {preview === null ? null : previewBroken ? (
          <Text variant="body">{t('viewer.saved.notAPicture')}</Text>
        ) : (
          <Image
            source={{ uri: preview.fileUri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('viewer.saved.picture', { title: preview.title })}
            resizeMode="contain"
            // Decided by whether the file actually decodes, not by its extension — a
            // photo copied in from another app often has no extension at all.
            onError={() => setPreviewBroken(true)}
            style={{
              width: '100%',
              height: PREVIEW_HEIGHT,
              borderRadius: radii.md,
              backgroundColor: colors.bgSunken,
            }}
          />
        )}
      </Dialog>
    </Screen>
  );
}
