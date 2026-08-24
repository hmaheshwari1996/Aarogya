/**
 * The briefcase — the papers she keeps, in one place.
 *
 * Discharge summaries, insurance papers, health cards, identity papers. Not readings, not
 * medicines: the things that live in a plastic folder on top of the almirah and get taken
 * to every appointment.
 *
 * ─── THE WARNING IS THE FIRST THING ON THE SCREEN, AND IT IS NOT A DISCLAIMER ──
 * It is the first thing above the papers, it cannot be dismissed, and it is written as
 * something true and useful rather than as legal cover. That ordering is the point: a
 * person adding a discharge summary here has to know, BEFORE she relies on it, that this
 * is the only copy and that uninstalling the app destroys it. It is also a promise being
 * kept — nothing here is uploaded anywhere — so it says both halves, and it ends with the
 * one thing she can actually do about it, wired to the Backup screen.
 *
 * It is `attention`, never `destructive`. The theme reserves destructive for actions that
 * delete; dressing a standing fact in the same red as the Remove button trains her to
 * ignore both. It also carries its own icon and its own words, so it survives a monochrome
 * screen and colour deficiency alike.
 *
 * ─── WHY NO `getItemLayout` ───────────────────────────────────────────────────
 * Every other list in this app declares one, and this one deliberately does not. A row's
 * height here depends on how many lines the TITLE takes, and the title is free text she
 * typed at a font scale she chose — 'Apollo discharge summary, November 2026' is two lines
 * at 1.3× and one at 1.0×. A fixed height would be a measurement the scrollbar believes
 * and the layout contradicts. FlatList still virtualises without it; it simply measures.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { useDateFormat } from '@/i18n/useDateFormat';
import {
  Banner,
  Button,
  Divider,
  EmptyState,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
} from '@/components/ui';
import { listDocuments, type DocumentRecord } from '@/db/repositories/contacts';

import {
  Thumb,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '../_shared/lib';
import {
  BRIEFCASE_SHARED_STRINGS,
  fileTypeKey,
  isImageDocument,
  kindLabelKey,
  sweepPendingFileDeletes,
} from './_lib';

/**
 * The kind and file-type labels come from `BRIEFCASE_SHARED_STRINGS` because they are
 * looked up by a key built at runtime; everything this screen names literally is declared
 * here, where `scripts/check-i18n.js` can see it. The reasoning is written out in full
 * next to that constant.
 */
const STRINGS: LocalStrings = {
  ...BRIEFCASE_SHARED_STRINGS,

  'briefcase.title': { en: 'Briefcase', hi: 'काग़ज़ों का बस्ता' },
  'briefcase.subtitle': {
    en: 'Discharge summaries, insurance papers, health cards — kept together.',
    hi: 'डिस्चार्ज सारांश, बीमा के काग़ज़, हेल्थ कार्ड — सब एक साथ।',
  },

  // ── The promise she asked to see at the top of this screen ─────────────────
  'briefcase.warningTitle': {
    en: 'These papers live only on this phone',
    hi: 'ये काग़ज़ सिर्फ़ इसी फ़ोन में रहते हैं',
  },
  'briefcase.warningMessage': {
    en: 'Aarogya keeps them here and nowhere else — not on Google, not on any cloud, not on another phone. If Aarogya is removed, or the phone is lost or wiped, these papers go with it. The paper original is still the safest copy. A backup you make yourself does carry them.',
    hi: 'आरोग्य इन्हें यहीं रखता है और कहीं नहीं — न Google पर, न किसी क्लाउड पर, न किसी दूसरे फ़ोन पर। अगर आरोग्य हटा दिया गया, या फ़ोन खो गया या साफ़ हो गया, तो ये काग़ज़ भी चले जाएँगे। असली काग़ज़ आज भी सबसे सुरक्षित नक़ल है। आपका ख़ुद बनाया बैकअप इन्हें साथ ले जाता है।',
  },
  'briefcase.warningAction': { en: 'Make a Backup', hi: 'बैकअप बनाइए' },

  // ── The list ───────────────────────────────────────────────────────────────
  'briefcase.empty': { en: 'Nothing in the briefcase yet', hi: 'बस्ते में अभी कुछ नहीं है' },
  'briefcase.emptyMessage': {
    en: 'This is where discharge summaries, insurance papers, health cards and identity papers can be kept, so they are all in one place when a doctor asks for them. Photograph a paper, or choose a file already on this phone.',
    hi: 'यहाँ डिस्चार्ज सारांश, बीमा के काग़ज़, हेल्थ कार्ड और पहचान के काग़ज़ रखे जा सकते हैं, ताकि डॉक्टर के पूछने पर सब एक जगह मिल जाएँ। काग़ज़ की फोटो लीजिए, या फ़ोन में रखी कोई फ़ाइल चुनिए।',
  },
  'briefcase.addAction': { en: 'Add a Paper', hi: 'काग़ज़ जोड़िए' },
  'briefcase.count': { en: '{{n}} kept here', hi: 'यहाँ {{n}} रखे हैं' },
  'briefcase.countOne': { en: '1 kept here', hi: 'यहाँ 1 रखा है' },
  'briefcase.addedOn': { en: 'Added {{date}}', hi: '{{date}} को जोड़ा' },
  'briefcase.rowHint': { en: 'Opens this paper', hi: 'यह काग़ज़ खोलती है' },
  'briefcase.thumbLabel': { en: 'Picture of {{title}}', hi: '{{title}} की तस्वीर' },
};

const THUMB_SIZE = 72;

function DocumentRow({
  document,
  onPress,
  title,
  subtitle,
  meta,
  thumbLabel,
  hint,
}: {
  document: DocumentRecord;
  onPress: () => void;
  /** All already translated. */
  title: string;
  subtitle: string;
  meta: string;
  thumbLabel: string;
  hint: string;
}) {
  const isImage = isImageDocument(document.mimeType, document.originalFileName ?? document.fileUri);

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      // One node, one sentence. Title / kind / date arriving as three swipes is three
      // chances to lose which paper the date belonged to.
      accessibilityLabel={`${title}. ${subtitle}. ${meta}`}
      accessibilityHint={hint}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: spacing.touchTarget,
        paddingVertical: spacing.md,
      }}
    >
      {/* A PDF is not asked to load as an image at all — `Thumb` degrades a null uri to a
          bordered icon tile, which is the same shape and costs no failed decode. */}
      <Thumb uri={isImage ? document.fileUri : null} size={THUMB_SIZE} label={thumbLabel} />

      <View style={{ flex: 1, gap: spacing.xs }}>
        {/* Two lines, then an ellipsis. A title she typed with a tremor can be very long,
            and a row that grows to eight lines pushes the next paper off the screen. */}
        <Text variant="body" weight="600" numberOfLines={2} ellipsizeMode="tail">
          {title}
        </Text>
        <Text variant="body" tone="muted" numberOfLines={1}>
          {subtitle}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </PressableScale>
  );
}

export default function BriefcaseScreen() {
  const t = useT(STRINGS);
  const { formatEpochDate } = useDateFormat();
  const { data: profileId } = useProfileId();

  const { data, loading, reload } = useAsync(
    async () => (profileId ? listDocuments(profileId) : []),
    [profileId],
  );
  useReloadOnFocus(reload);

  /**
   * Finish any unlink that was interrupted.
   *
   * `deleteDocument` writes the row removal and the deletion request in one transaction, so
   * a phone killed between "Remove" and the unlink leaves a durable instruction behind. The
   * proper home for this is one call at app start; until that lands, opening the briefcase
   * is the next best moment — it is the screen whose promise the leftover bytes break.
   */
  useEffect(() => {
    void sweepPendingFileDeletes();
  }, []);

  const documents = useMemo(() => data ?? [], [data]);

  const openDocument = useCallback((id: string) => {
    router.push(`/briefcase/${id}`);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DocumentRecord }) => (
      <DocumentRow
        document={item}
        onPress={() => openDocument(item.id)}
        title={item.title}
        subtitle={`${t(kindLabelKey(item.kind))} · ${t(
          fileTypeKey(item.mimeType, item.originalFileName ?? item.fileUri),
        )}`}
        meta={t('briefcase.addedOn', { date: formatEpochDate(item.createdAtEpoch) })}
        thumbLabel={t('briefcase.thumbLabel', { title: item.title })}
        hint={t('briefcase.rowHint')}
      />
    ),
    [formatEpochDate, openDocument, t],
  );

  /**
   * THE WARNING IS THE LIST'S HEADER, NOT A FIXED BAND ABOVE IT.
   *
   * Pinning it would look more emphatic and behave much worse: its message is four
   * sentences, and at a 1.3× font scale on a small phone four sentences plus the screen
   * header plus the Add button leave the list a strip a row and a half tall. Scrolling
   * with the list means it is unmissable on arrival — which is when it matters — and then
   * gets out of the way, while the list itself keeps its own full height and its
   * virtualisation.
   *
   * It is also inside the FlatList so it renders in the EMPTY case too. The first time she
   * opens this screen there are no documents, and that is precisely the moment before she
   * decides to trust it with the only copy of a discharge summary.
   */
  const header = (
    <View style={{ paddingBottom: spacing.lg }}>
      {/* No `onDismiss`: the condition it describes is permanently true, and a warning she
          can tap away is a warning the next person to pick up the phone never sees. */}
      <Banner
        variant="attention"
        title={t('briefcase.warningTitle')}
        message={t('briefcase.warningMessage')}
        actionLabel={t('briefcase.warningAction')}
        onAction={() => router.push('/backup')}
      />
    </View>
  );

  return (
    <Screen
      variant="fixed"
      background="bg"
      footer={
        <Button
          title={t('briefcase.addAction')}
          onPress={() => router.push('/briefcase/add')}
          size="xl"
          fullWidth
        />
      }
    >
      <ScreenHeader
        title={t('briefcase.title')}
        subtitle={t('briefcase.subtitle')}
        onBack={() => router.back()}
      />

      <FlatList
        data={documents}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <View style={{ gap: spacing.md }}>
              <Skeleton height={THUMB_SIZE + spacing.xl} />
              <Skeleton height={THUMB_SIZE + spacing.xl} />
              <Skeleton height={THUMB_SIZE + spacing.xl} />
            </View>
          ) : (
            <EmptyState title={t('briefcase.empty')} message={t('briefcase.emptyMessage')} />
          )
        }
        ListFooterComponent={
          documents.length > 0 ? (
            <Text variant="caption" tone="muted" style={{ paddingVertical: spacing.lg }}>
              {documents.length === 1
                ? t('briefcase.countOne')
                : t('briefcase.count', { n: documents.length })}
            </Text>
          ) : null
        }
        persistentScrollbar
      />
    </Screen>
  );
}
