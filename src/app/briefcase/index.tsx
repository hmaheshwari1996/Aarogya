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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { useDateFormat } from '@/i18n/useDateFormat';
import {
  Banner,
  Button,
  Chip,
  Divider,
  EmptyState,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
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
import { sortDocuments, type BriefcaseSort } from '@/features/briefcase/sort';

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

  // ── The two sections, and the order the lower one is shown in ────────────────
  // Pinned rides at the top so the two or three papers she carries to every appointment
  // are not scrolled for. The section only appears when something is pinned — an empty
  // 'Pinned' heading over nothing is a promise the screen did not keep.
  'briefcase.pinnedSection': { en: 'Pinned', hi: 'पिन किए हुए' },
  'briefcase.allSection': { en: 'All Papers', hi: 'सभी काग़ज़' },
  'briefcase.sortLabel': { en: 'Show in Order', hi: 'इस क्रम में दिखाइए' },
  'briefcase.sortRecent': { en: 'Newest First', hi: 'नए पहले' },
  'briefcase.sortName': { en: 'By Name', hi: 'नाम से' },
  'briefcase.sortKind': { en: 'By Kind', hi: 'प्रकार से' },

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

/** The three sort orders, in the order the chips are offered. */
const SORT_OPTIONS: readonly { key: BriefcaseSort; labelKey: string }[] = [
  { key: 'recent', labelKey: 'briefcase.sortRecent' },
  { key: 'name', labelKey: 'briefcase.sortName' },
  { key: 'kind', labelKey: 'briefcase.sortKind' },
];

export default function BriefcaseScreen() {
  const t = useT(STRINGS);
  const { formatEpochDate } = useDateFormat();
  const { data: profileId } = useProfileId();

  const { data, loading, reload } = useAsync(
    async () => (profileId ? listDocuments(profileId) : []),
    [profileId],
  );
  useReloadOnFocus(reload);

  // The sort applies to the papers she is browsing; it is a view choice, kept in memory
  // and not persisted — the default (newest first) is the right answer for someone who
  // just added a discharge summary and reopened the screen to check it landed.
  const [sort, setSort] = useState<BriefcaseSort>('recent');

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

  const kindLabelOf = useCallback((kind: string) => t(kindLabelKey(kind)), [t]);

  // Two partitions of the same small set — pinned on top, everything else below — each in
  // the chosen order. A pinned paper is NOT repeated in the lower section: it moved up, it
  // did not clone. The lower section keeps the name 'All Papers' because when nothing is
  // pinned it genuinely is all of them, and when something is it reads as "the rest".
  const pinned = useMemo(
    () => sortDocuments(documents.filter((d) => d.isPinned), sort, kindLabelOf),
    [documents, sort, kindLabelOf],
  );
  const rest = useMemo(
    () => sortDocuments(documents.filter((d) => !d.isPinned), sort, kindLabelOf),
    [documents, sort, kindLabelOf],
  );

  const openDocument = useCallback((id: string) => {
    router.push(`/briefcase/${id}`);
  }, []);

  // One row element, used both in the pinned block (inside the header) and as the list's
  // renderItem, so the two sections can never drift apart in how a paper looks.
  const documentRow = useCallback(
    (item: DocumentRecord) => (
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

  const renderItem = useCallback(
    ({ item }: { item: DocumentRecord }) => documentRow(item),
    [documentRow],
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

      {/* ── Pinned ──────────────────────────────────────────────────────────────
          Rendered inside the header rather than as its own FlatList so there is only ever
          one scroller on the screen. It is not virtualised, which is fine and deliberate:
          the whole point of pinning is that the set is a handful — the papers she reaches
          for every visit — not a list that grows without bound. An empty pinned set draws
          nothing at all: no heading, no gap. */}
      {pinned.length > 0 ? (
        <View>
          <SectionHeader title={t('briefcase.pinnedSection')} />
          {pinned.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Divider /> : null}
              {documentRow(item)}
            </View>
          ))}
        </View>
      ) : null}

      {/* ── All papers, and the order to show them in ─────────────────────────────
          The header and the sort control only appear when there is something below to
          order. Chips, not a dropdown: every option stays on screen at a full 56dp target,
          which is the same reason the rest of this app never hides a choice behind a tap
          (see Chip.tsx). */}
      {rest.length > 0 ? (
        <View>
          <SectionHeader
            title={pinned.length > 0 ? t('briefcase.allSection') : t('briefcase.title')}
          />
          <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.sm }}>
            {t('briefcase.sortLabel')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {SORT_OPTIONS.map((option) => (
              <Chip
                key={option.key}
                label={t(option.labelKey)}
                selected={sort === option.key}
                onPress={() => setSort(option.key)}
              />
            ))}
          </View>
        </View>
      ) : null}
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
        data={rest}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={header}
        // `data` is only the lower section, so an empty `data` is NOT an empty screen when
        // papers are pinned — those are drawn in the header above. The real-empty state and
        // the loading skeletons are therefore gated on the TOTAL, and the all-pinned case
        // falls through to null: the pinned block is already the whole of what she has.
        ListEmptyComponent={
          loading ? (
            <View style={{ gap: spacing.md }}>
              <Skeleton height={THUMB_SIZE + spacing.xl} />
              <Skeleton height={THUMB_SIZE + spacing.xl} />
              <Skeleton height={THUMB_SIZE + spacing.xl} />
            </View>
          ) : documents.length === 0 ? (
            <EmptyState title={t('briefcase.empty')} message={t('briefcase.emptyMessage')} />
          ) : null
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
