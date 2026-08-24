/**
 * Lab results.
 *
 * THE ONE RULE THIS SCREEN EXISTS TO KEEP: the app never asserts a reference range and
 * never marks a value as abnormal. `ref_range_text` is printed exactly as the paper
 * report printed it, or the row says the report printed nothing. This app does not know
 * the assay, the analyser, the units convention or the population the lab calibrated
 * against, and a range that looks plausible but belongs to a different method is how a
 * perfectly normal creatinine gets read as kidney failure across a kitchen table.
 *
 * There is therefore no colour, no arrow and no "high"/"low" word anywhere in this list.
 * A number, its unit, and whatever the lab itself said about it.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, View } from 'react-native';
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
  fixedItemLayout,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import { useFontSizes } from '@/theme/ThemeProvider';
import {
  listLabResults,
  listLabTestDefs,
  listUnconfirmedLabResults,
  type LabResult,
  type LabTestDef,
} from '@/db/repositories/labs';

const STRINGS: LocalStrings = {
  'labs.title': { en: 'Lab reports', hi: 'जाँच की रिपोर्ट' },
  'labs.subtitle': {
    en: 'What the laboratory printed, kept exactly as printed.',
    hi: 'लैब ने जो छापा है, वैसा का वैसा रखा गया है।',
  },
  'labs.add': { en: 'Add a lab report', hi: 'जाँच की रिपोर्ट जोड़ें' },
  'labs.empty': { en: 'No lab reports yet', hi: 'अभी कोई रिपोर्ट नहीं है' },
  'labs.emptyMessage': {
    en: 'Photograph a report and it will be kept here, even if you never type the numbers.',
    hi: 'रिपोर्ट की फोटो ले लें, वह यहाँ रहेगी — भले ही आप नंबर कभी न लिखें।',
  },
  'labs.checkThese': { en: 'Some results need checking', hi: 'कुछ नतीजे जाँचने बाकी हैं' },
  'labs.checkTheseMessage': {
    en: 'The app read {{count}} of these from a photo. Read them against the paper before you rely on them.',
    hi: 'इनमें से {{count}} ऐप ने फोटो से पढ़े हैं। भरोसा करने से पहले कागज़ से मिला लें।',
  },
  'labs.checkFirst': { en: 'Check the first one', hi: 'पहला जाँचें' },
  'labs.needsChecking': { en: 'Please check this', hi: 'यह जाँच लें' },
  'labs.groupUnchecked': { en: 'Waiting for you to check', hi: 'आपकी जाँच का इंतज़ार' },
  'labs.groupNoDate': { en: 'Date not known', hi: 'तारीख़ पता नहीं' },
  'labs.noValue': { en: 'Photograph only, no numbers typed', hi: 'सिर्फ़ फोटो, कोई नंबर नहीं लिखा' },
  'labs.refPrinted': { en: 'The report printed: {{text}}', hi: 'रिपोर्ट पर छपा है: {{text}}' },
  'labs.refNone': {
    en: 'The report did not print a range',
    hi: 'रिपोर्ट पर कोई सीमा नहीं छपी थी',
  },
  'labs.unnamed': { en: 'Lab report', hi: 'जाँच की रिपोर्ट' },
  'labs.openRow': { en: 'Open this result', hi: 'यह नतीजा खोलें' },
  'labs.loading': { en: 'Opening your reports', hi: 'आपकी रिपोर्ट खुल रही हैं' },
  'labs.valueWithUnit': { en: '{{value}} {{unit}}', hi: '{{value}} {{unit}}' },
  'labs.rowSpoken': { en: '{{label}}. {{value}}', hi: '{{label}}. {{value}}' },
};

type Item = {
  id: string;
  result: LabResult;
  /** `test_key` resolved through the registry, or her own free-text label. */
  label: string;
  /** Rendered in the row's fixed header slot when this is the first row of a group. */
  groupLabel: string | null;
  unchecked: boolean;
};

type ScreenData = {
  items: Item[];
  uncheckedCount: number;
  firstUncheckedId: string | null;
};

/** The list only ever shows this many. A lab history longer than this is a chart, not a list. */
const MAX_ROWS = 300;

export default function LabsScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const { formatDate } = useDateFormat();
  const fontSizes = useFontSizes();
  const toast = useToast();

  const profile = useProfileId();
  const profileId = profile.data;

  const labs = useAsync<ScreenData | null>(async () => {
    if (!profileId) return null;
    const [results, unconfirmed, defs] = await Promise.all([
      listLabResults(profileId, { limit: MAX_ROWS }),
      listUnconfirmedLabResults(profileId),
      listLabTestDefs(),
    ]);
    return buildItems(results, unconfirmed, defs, lang, t, formatDate);
  }, [profileId, lang, t, formatDate]);
  useReloadOnFocus(labs.reload);

  /** One height for every row; the group-label slot is always present so it never varies. */
  const rowHeight = fontSizes.md >= 20 ? 244 : 204;
  const getItemLayout = useMemo(() => fixedItemLayout(rowHeight), [rowHeight]);

  const openFirstUnchecked = useCallback(() => {
    const id = labs.data?.firstUncheckedId;
    if (!id) {
      toast.show({ message: t('errors.notFound'), variant: 'error' });
      return;
    }
    router.push(`/labs/${id}`);
  }, [labs.data?.firstUncheckedId, t, toast]);

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      const result = item.result;
      const value =
        result.valueText === null
          ? t('labs.noValue')
          : result.unit
            ? t('labs.valueWithUnit', { value: result.valueText, unit: result.unit })
            : result.valueText;

      return (
        <View style={{ height: rowHeight, paddingBottom: spacing.md }}>
          {/* Fixed-height slot, occupied or not, so grouping never changes the row height
              and `getItemLayout` stays exact. */}
          <View style={{ height: fontSizes.md >= 20 ? 40 : 34, justifyContent: 'flex-end' }}>
            {item.groupLabel ? (
              <Text variant="label" accessibilityRole="header" numberOfLines={1}>
                {item.groupLabel}
              </Text>
            ) : null}
          </View>

          <Card
            style={{ flex: 1, gap: spacing.xs }}
            onPress={() => router.push(`/labs/${result.id}`)}
            accessibilityLabel={t('labs.rowSpoken', { label: item.label, value })}
            accessibilityHint={t('labs.openRow')}
          >
            <Text variant="body" weight="600" numberOfLines={1}>
              {item.label}
            </Text>
            <Text variant="label" numberOfLines={1}>
              {value}
            </Text>

            {/* Transcription or nothing. The app has no range of its own to offer. */}
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {result.refRangeText
                ? t('labs.refPrinted', { text: result.refRangeText })
                : t('labs.refNone')}
            </Text>

            <Text variant="caption" tone="muted" numberOfLines={1}>
              {item.unchecked ? t('labs.needsChecking') : (result.labName ?? '')}
            </Text>
          </Card>
        </View>
      );
    },
    [fontSizes.md, rowHeight, t],
  );

  const items = labs.data?.items ?? [];
  const uncheckedCount = labs.data?.uncheckedCount ?? 0;

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        <Button
          title={t('labs.add')}
          onPress={() => router.push('/labs/new')}
          icon="plus"
          size="lg"
          fullWidth
        />
      }
    >
      <ScreenHeader title={t('labs.title')} subtitle={t('labs.subtitle')} onBack={() => router.back()} />

      {profile.loading || labs.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={rowHeight - spacing.md} label={t('labs.loading')} />
          <Skeleton height={rowHeight - spacing.md} />
        </View>
      ) : labs.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          actionLabel={t('errors.tryAgain')}
          onAction={labs.reload}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('labs.empty')}
          message={t('labs.emptyMessage')}
          actionLabel={t('labs.add')}
          onAction={() => router.push('/labs/new')}
        />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          initialNumToRender={5}
          windowSize={6}
          removeClippedSubviews
          ListHeaderComponent={
            uncheckedCount > 0 ? (
              <Banner
                variant="attention"
                title={t('labs.checkThese')}
                message={t('labs.checkTheseMessage', { count: uncheckedCount })}
                actionLabel={t('labs.checkFirst')}
                onAction={openFirstUnchecked}
                style={{ marginBottom: spacing.md }}
              />
            ) : null
          }
        />
      )}
    </Screen>
  );
}

function buildItems(
  results: readonly LabResult[],
  unconfirmed: readonly LabResult[],
  defs: readonly LabTestDef[],
  lang: 'en' | 'hi',
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
  formatDate: (localDate: string) => string,
): ScreenData {
  const labels = new Map(defs.map((def) => [def.key, lang === 'hi' ? def.labelHi : def.labelEn]));
  const uncheckedIds = new Set(unconfirmed.map((row) => row.id));

  const describe = (result: LabResult): string => {
    if (result.testKey) return labels.get(result.testKey) ?? result.testKey;
    return result.customLabel ?? t('labs.unnamed');
  };

  const items: Item[] = [];
  let currentGroup: string | null = null;

  const push = (result: LabResult, group: string) => {
    const isNewGroup = group !== currentGroup;
    currentGroup = group;
    items.push({
      id: result.id,
      result,
      label: describe(result),
      groupLabel: isNewGroup ? group : null,
      unchecked: uncheckedIds.has(result.id),
    });
  };

  // Machine-read rows nobody has looked at come first, in their own group. They are
  // skipped in the date groups below so a result never appears twice.
  for (const result of unconfirmed) push(result, t('labs.groupUnchecked'));

  for (const result of results) {
    if (uncheckedIds.has(result.id)) continue;
    push(result, result.collectedOn ? formatDate(result.collectedOn) : t('labs.groupNoDate'));
  }

  return {
    items,
    uncheckedCount: unconfirmed.length,
    firstUncheckedId: unconfirmed[0]?.id ?? null,
  };
}
