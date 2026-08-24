/**
 * Documents — the photographs and files kept alongside the record.
 *
 * Prescription pages, lab report photographs, anything the son has attached. The list is
 * a picture list rather than a filename list on purpose: a filename like
 * `IMG_20260304_113522.jpg` tells this user nothing, and the thumbnail tells her
 * everything. The title sits next to it for the son and for TalkBack.
 *
 * Nothing here writes to the shared gallery. Exporting a medical image to the gallery is
 * a decision with real consequences — Google Photos and Mi Cloud sync that folder — and
 * it lives behind its own blocking dialog on the viewer's saved-items screen.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';

import { spacing } from '@/theme';
import {
  Button,
  Dialog,
  Divider,
  EmptyState,
  ListRow,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  deleteDocument,
  listDocuments,
  type DocumentRecord,
} from '@/db/repositories/contacts';

import { Thumb, useAsync, useProfileId, useReloadOnFocus, useT, type LocalStrings } from './_shared/lib';

const STRINGS: LocalStrings = {
  'documents.title': { en: 'Documents', hi: 'काग़ज़ात' },
  'documents.subtitle': {
    en: 'Everything you have photographed or saved, in one place.',
    hi: 'आपकी खींची या रखी हुई हर चीज़, एक जगह पर।',
  },
  'documents.empty': { en: 'Nothing saved yet', hi: 'अभी कुछ नहीं रखा है' },
  'documents.emptyMessage': {
    en: 'Photographs of prescriptions and lab reports will appear here once you take them.',
    hi: 'पर्चों और जाँच रिपोर्टों की तस्वीरें लेने के बाद यहाँ दिखेंगी।',
  },
  'documents.open': { en: 'Open', hi: 'खोलिए' },
  'documents.send': { en: 'Send a copy', hi: 'एक नक़ल भेजिए' },
  'documents.remove': { en: 'Remove from Aarogya', hi: 'आरोग्य से हटाइए' },
  'documents.removeTitle': { en: 'Remove {{title}}?', hi: '{{title}} हटा दें?' },
  'documents.removeMessage': {
    en: 'It will no longer be listed here. Anything you already sent to someone stays with them.',
    hi: 'यह यहाँ नहीं दिखेगा। जो आपने पहले किसी को भेजा है वह उनके पास रहेगा।',
  },
  'documents.removed': { en: 'Removed', hi: 'हटा दिया गया' },
  'documents.sharingUnavailable': {
    en: 'This phone has nothing to send files with.',
    hi: 'इस फ़ोन में फ़ाइल भेजने के लिए कुछ नहीं है।',
  },
  'documents.thumbLabel': { en: 'Picture of {{title}}', hi: '{{title}} की तस्वीर' },
  'documents.kind.prescription': { en: 'Prescription', hi: 'पर्चा' },
  'documents.kind.lab': { en: 'Lab report', hi: 'जाँच रिपोर्ट' },
  'documents.kind.other': { en: 'Saved file', hi: 'रखी हुई फ़ाइल' },
};

/** Thumbnail (72) + two text lines + padding, held constant so getItemLayout is exact. */
const ROW_HEIGHT = 104;
const ROW_STRIDE = ROW_HEIGHT + 1;

const itemLayout = (_data: unknown, index: number) => ({
  length: ROW_HEIGHT,
  offset: ROW_STRIDE * index,
  index,
});

/** `document.kind` is free text by schema, so unknown values fall back rather than fail. */
function kindKey(kind: string): string {
  if (kind === 'prescription') return 'documents.kind.prescription';
  if (kind === 'lab_report' || kind === 'lab') return 'documents.kind.lab';
  return 'documents.kind.other';
}

export default function DocumentsScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const { data: profileId } = useProfileId();
  const [preview, setPreview] = useState<DocumentRecord | null>(null);

  const { data, loading, reload } = useAsync(
    async () => (profileId ? listDocuments(profileId) : []),
    [profileId],
  );
  useReloadOnFocus(reload);

  const share = useCallback(
    async (document: DocumentRecord) => {
      if (!(await Sharing.isAvailableAsync())) {
        toast.show({ message: t('documents.sharingUnavailable'), variant: 'error' });
        return;
      }
      await Sharing.shareAsync(document.fileUri);
    },
    [toast, t],
  );

  const remove = useCallback(
    async (document: DocumentRecord) => {
      const ok = await confirm({
        title: t('documents.removeTitle', { title: document.title }),
        message: t('documents.removeMessage'),
        confirmLabel: t('common.remove'),
        destructive: true,
      });
      if (!ok) return;
      await deleteDocument(document.id);
      toast.show({ message: t('documents.removed'), variant: 'success' });
      setPreview(null);
      reload();
    },
    [confirm, t, toast, reload],
  );

  const renderItem = useCallback(
    ({ item }: { item: DocumentRecord }) => (
      <View style={{ height: ROW_HEIGHT, justifyContent: 'center' }}>
        <ListRow
          title={item.title}
          subtitle={t(kindKey(item.kind))}
          leading={
            <Thumb
              uri={item.fileUri}
              size={72}
              label={t('documents.thumbLabel', { title: item.title })}
            />
          }
          onPress={() => setPreview(item)}
        />
      </View>
    ),
    [t],
  );

  return (
    <Screen variant="fixed" background="bg">
      <ScreenHeader
        title={t('documents.title')}
        subtitle={t('documents.subtitle')}
        onBack={() => router.back()}
      />

      {loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={ROW_HEIGHT} />
          <Skeleton height={ROW_HEIGHT} />
          <Skeleton height={ROW_HEIGHT} />
        </View>
      ) : data && data.length > 0 ? (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={Divider}
          getItemLayout={itemLayout}
          persistentScrollbar
        />
      ) : (
        <EmptyState title={t('documents.empty')} message={t('documents.emptyMessage')} />
      )}

      <Dialog
        visible={preview !== null}
        title={preview?.title}
        onRequestClose={() => setPreview(null)}
        footer={
          preview ? (
            <View style={{ gap: spacing.md }}>
              <Button
                title={t('documents.send')}
                onPress={() => void share(preview)}
                variant="secondary"
                size="lg"
                fullWidth
              />
              <Button
                title={t('documents.remove')}
                onPress={() => void remove(preview)}
                variant="destructive"
                size="md"
                fullWidth
              />
              <Button
                title={t('common.close')}
                onPress={() => setPreview(null)}
                variant="ghost"
                size="md"
                fullWidth
              />
            </View>
          ) : undefined
        }
      >
        {preview ? (
          <View style={{ gap: spacing.md, alignItems: 'center' }}>
            {/* Large enough to actually read a printed line off the paper. */}
            <Thumb
              uri={preview.fileUri}
              size={280}
              label={t('documents.thumbLabel', { title: preview.title })}
            />
            <Text variant="caption" tone="muted">
              {t(kindKey(preview.kind))}
            </Text>
          </View>
        ) : null}
      </Dialog>
    </Screen>
  );
}
