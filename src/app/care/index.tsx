/**
 * Care queue — the appointments, tests and refills that were written down somewhere.
 *
 * THREE RULES SHAPE THIS WHOLE SCREEN, and none of them is a style preference:
 *
 *  1. EVERY CARD IS A HEDGE. "Your doctor may have asked for: …" — never "You must",
 *     never "Due". These rows come from a photograph of somebody's handwriting, read by
 *     a machine or by a tired person at an OPD counter. The sentence has to carry that
 *     uncertainty, because the alternative is the app issuing an instruction it cannot
 *     stand behind, in a voice the patient will believe is her doctor's.
 *
 *  2. NO RED, AND NO OVERDUE BADGE — EVER. A date in the past renders in the ordinary
 *     text tone with a plain date line. This user is on three chronic treatments; a
 *     phone that keeps score of what she has not done teaches her to stop opening it,
 *     and the app then knows nothing at all. What she needs is to see what was written
 *     down, not to be marked against it.
 *
 *  3. "NOT NEEDED" AND "CHANGE THE DATE" ARE SIBLINGS. Same size, same weight, side by
 *     side. Dismissing must never be harder than rescheduling: many of these rows are
 *     the app's own arithmetic, and a UI that makes "this is wrong" the small grey
 *     option is a UI that collects agreement rather than truth.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';

import {
  Banner,
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  TextField,
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
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, daysBetween, toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import type { CareEvent, CareEventKind } from '@/types';
import {
  createCareEvent,
  dismissCareEvent,
  listPendingCare,
  markCareDone,
  updateCareEvent,
} from '@/db/repositories/care';

const STRINGS: LocalStrings = {
  'care.title': { en: 'Appointments and tests', hi: 'मुलाक़ात और जाँच' },
  'care.subtitle': {
    en: 'Things that were written down for you. You can change or remove any of them.',
    hi: 'जो आपके लिए लिखा गया था। इनमें से कुछ भी आप बदल या हटा सकती हैं।',
  },
  'care.mayHaveAsked': {
    en: 'Your doctor may have asked for: {{title}}',
    hi: 'हो सकता है डॉक्टर ने यह कहा हो: {{title}}',
  },
  'care.onDate': { en: 'Written for {{date}}', hi: 'तारीख़ लिखी है: {{date}}' },
  'care.dateWithWeekday': { en: '{{weekday}}, {{date}}', hi: '{{weekday}}, {{date}}' },
  'care.sourceTranscribed': { en: 'Written on the prescription', hi: 'पर्चे पर लिखा हुआ' },
  'care.sourceInferred': {
    en: 'Worked out by the app — you can change it',
    hi: 'यह ऐप ने खुद निकाला है — आप इसे बदल सकती हैं',
  },
  'care.sourceManual': { en: 'You added this', hi: 'यह आपने जोड़ा था' },
  'care.notNeeded': { en: 'Not needed', hi: 'ज़रूरत नहीं' },
  'care.changeDate': { en: 'Change the date', hi: 'तारीख़ बदलें' },
  'care.markDone': { en: 'This is done', hi: 'यह हो गया' },
  'care.dayEarlier': { en: 'One day earlier', hi: 'एक दिन पहले' },
  'care.dayLater': { en: 'One day later', hi: 'एक दिन बाद' },
  'care.thisWeek': { en: 'This week', hi: 'इस हफ़्ते' },
  'care.later': { en: 'Later', hi: 'आगे' },
  'care.empty': { en: 'Nothing is waiting', hi: 'अभी कुछ बाकी नहीं है' },
  'care.emptyMessage': {
    en: 'Appointments and tests from a prescription appear here. You can also add one yourself.',
    hi: 'पर्चे से मिली मुलाक़ात और जाँच यहाँ दिखेंगी। आप खुद भी जोड़ सकती हैं।',
  },
  'care.addSomething': { en: 'Add something', hi: 'कुछ जोड़ें' },
  'care.addTitle': { en: 'Add to this list', hi: 'इस सूची में जोड़ें' },
  'care.addWhat': { en: 'What is it?', hi: 'यह क्या है?' },
  'care.addWhich': { en: 'What kind of thing?', hi: 'किस तरह की बात है?' },
  'care.addWhen': { en: 'For which day?', hi: 'किस दिन के लिए?' },
  'care.kindVisit': { en: 'See the doctor', hi: 'डॉक्टर से मिलना' },
  'care.kindTest': { en: 'Get a test done', hi: 'जाँच करवानी है' },
  'care.kindCollect': { en: 'Collect a report', hi: 'रिपोर्ट लेनी है' },
  'care.kindRefill': { en: 'Buy medicine', hi: 'दवाई लेनी है' },
  'care.kindOther': { en: 'Something else', hi: 'कुछ और' },
  'care.removed': { en: 'Removed from the list', hi: 'सूची से हटा दिया' },
  'care.doneToast': { en: 'Marked as done', hi: 'हो गया, दर्ज कर लिया' },
  'care.dateChanged': { en: 'The date was changed', hi: 'तारीख़ बदल दी' },
  'care.loading': { en: 'Loading your list', hi: 'आपकी सूची खुल रही है' },
};

/** Anything due within this many days sits in "This week". */
const THIS_WEEK_DAYS = 7;

type SectionKey = 'thisWeek' | 'later';

type Row =
  | { kind: 'header'; id: string; sectionKey: SectionKey }
  | { kind: 'event'; id: string; event: CareEvent };

const KINDS: readonly { value: CareEventKind; i18nKey: string }[] = [
  { value: 'visit', i18nKey: 'care.kindVisit' },
  { value: 'test_do', i18nKey: 'care.kindTest' },
  { value: 'test_collect', i18nKey: 'care.kindCollect' },
  { value: 'refill', i18nKey: 'care.kindRefill' },
  { value: 'custom', i18nKey: 'care.kindOther' },
];

function sourceKey(source: CareEvent['anchorSource']): string {
  if (source === 'transcribed') return 'care.sourceTranscribed';
  if (source === 'inferred') return 'care.sourceInferred';
  return 'care.sourceManual';
}

/**
 * A minus / date / plus stepper.
 *
 * Deliberately not a calendar grid: a month grid is 35 cells of roughly 40dp on a small
 * handset, well under this app's 56dp minimum, and the user it is built for has a
 * tremor. One day per press, with the weekday and full date spelled out between the two
 * buttons, is slower across a month and impossible to get wrong.
 */
function DateStepper({
  value,
  onChange,
  display,
  spoken,
  earlierLabel,
  laterLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Already translated. */
  display: string;
  spoken: string;
  earlierLabel: string;
  laterLabel: string;
}) {
  const { colors } = useTheme();
  const stepStyle = {
    width: spacing.touchTarget,
    height: spacing.touchTarget,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <PressableScale
        onPress={() => onChange(addDays(value, -1))}
        accessibilityRole="button"
        accessibilityLabel={earlierLabel}
        style={stepStyle}
      >
        <Icon name="minus" size={28} color={colors.primary} />
      </PressableScale>

      <View accessible accessibilityLabel={spoken} style={{ flex: 1 }}>
        <Text variant="body" weight="600" align="center" numberOfLines={1}>
          {display}
        </Text>
      </View>

      <PressableScale
        onPress={() => onChange(addDays(value, 1))}
        accessibilityRole="button"
        accessibilityLabel={laterLabel}
        style={stepStyle}
      >
        <Icon name="plus" size={28} color={colors.primary} />
      </PressableScale>
    </View>
  );
}

export default function CareScreen() {
  const t = useT(STRINGS);
  const fontSizes = useFontSizes();
  const toast = useToast();
  const { formatDate, formatWeekday } = useDateFormat();

  const profile = useProfileId();
  const profileId = profile.data;

  const care = useAsync(async () => {
    if (!profileId) return [] as CareEvent[];
    return listPendingCare(profileId);
  }, [profileId]);
  useReloadOnFocus(care.reload);

  /** Only one row's stepper is open at a time — two open steppers is two pending dates. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDate, setPendingDate] = useState<string>(toLocalDate());
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addKind, setAddKind] = useState<CareEventKind>('visit');
  const [addDate, setAddDate] = useState<string>(toLocalDate());
  const [addSaving, setAddSaving] = useState(false);

  const stepperLabels = useMemo(
    () => ({ earlier: t('care.dayEarlier'), later: t('care.dayLater') }),
    [t],
  );

  const describeDate = useCallback(
    (localDate: string, short: boolean) =>
      t('care.dateWithWeekday', {
        weekday: formatWeekday(localDate, short),
        date: formatDate(localDate),
      }),
    [formatDate, formatWeekday, t],
  );

  const rows = useMemo<Row[]>(() => {
    const events = care.data ?? [];
    const today = toLocalDate();
    const thisWeek: CareEvent[] = [];
    const later: CareEvent[] = [];
    for (const event of events) {
      // A date already past belongs with "this week", not in a bucket of its own. There
      // is no "overdue" group on this screen and there is never going to be one.
      if (daysBetween(today, event.dueOn) <= THIS_WEEK_DAYS) thisWeek.push(event);
      else later.push(event);
    }
    const out: Row[] = [];
    if (thisWeek.length > 0) {
      out.push({ kind: 'header', id: 'header-thisWeek', sectionKey: 'thisWeek' });
      for (const event of thisWeek) out.push({ kind: 'event', id: event.id, event });
    }
    if (later.length > 0) {
      out.push({ kind: 'header', id: 'header-later', sectionKey: 'later' });
      for (const event of later) out.push({ kind: 'event', id: event.id, event });
    }
    return out;
  }, [care.data]);

  /**
   * ONE height for every row, section headers included, so `getItemLayout` is exact
   * without measuring anything on the JS thread. It grows in large-text mode because the
   * two-line title and both action rows scale with it, and a list that clips its own
   * buttons at 21sp is worse than a taller one.
   */
  const rowHeight = fontSizes.md >= 20 ? 392 : 320;
  const getItemLayout = useMemo(() => fixedItemLayout(rowHeight), [rowHeight]);

  const runAction = useCallback(
    async (id: string, action: () => Promise<void>, message: string) => {
      setBusyId(id);
      try {
        await action();
        toast.show({ message, variant: 'success' });
        care.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [care, t, toast],
  );

  const saveDate = useCallback(
    async (id: string) => {
      const dueOn = pendingDate;
      setEditingId(null);
      await runAction(id, () => updateCareEvent(id, { dueOn }), t('care.dateChanged'));
    },
    [pendingDate, runAction, t],
  );

  const submitNew = useCallback(async () => {
    const title = addTitle.trim();
    if (!profileId || title.length === 0) return;
    setAddSaving(true);
    try {
      await createCareEvent({
        profileId,
        kind: addKind,
        title,
        dueOn: addDate,
        // A row she typed is 'manual' and nothing else. The repository refuses 'inferred'
        // outright, and 'transcribed' would launder her own note into evidence.
        anchorSource: 'manual',
      });
      setAddOpen(false);
      setAddTitle('');
      setAddKind('visit');
      setAddDate(toLocalDate());
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      care.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setAddSaving(false);
    }
  }, [addDate, addKind, addTitle, care, profileId, t, toast]);

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === 'header') {
        return (
          <View style={{ height: rowHeight }}>
            <SectionHeader title={t(item.sectionKey === 'thisWeek' ? 'care.thisWeek' : 'care.later')} />
          </View>
        );
      }

      const event = item.event;
      const isEditing = editingId === event.id;
      const shownDate = isEditing ? pendingDate : event.dueOn;
      const busy = busyId === event.id;

      return (
        <View style={{ height: rowHeight, paddingBottom: spacing.md }}>
          <Card style={{ flex: 1, gap: spacing.sm }}>
            <Text variant="body" numberOfLines={2}>
              {t('care.mayHaveAsked', { title: event.title })}
            </Text>

            {/* Ordinary tone, ordinary weight, whatever the date is. A past date gets no
                colour, no icon and no badge — see rule 2 in the file header. */}
            <Text variant="body" weight="600" numberOfLines={1}>
              {t('care.onDate', { date: describeDate(shownDate, true) })}
            </Text>

            {/* Provenance is not decoration. 'inferred' says out loud that the date is the
                app's own arithmetic, which is what earns the user the right to move it. */}
            <Text variant="caption" tone="muted" numberOfLines={2}>
              {t(sourceKey(event.anchorSource))}
            </Text>

            {isEditing ? (
              <>
                <DateStepper
                  value={pendingDate}
                  onChange={setPendingDate}
                  display={describeDate(pendingDate, true)}
                  spoken={describeDate(pendingDate, false)}
                  earlierLabel={stepperLabels.earlier}
                  laterLabel={stepperLabels.later}
                />
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Button
                    title={t('common.cancel')}
                    onPress={() => setEditingId(null)}
                    variant="secondary"
                    style={{ flex: 1 }}
                  />
                  <Button
                    title={t('common.save')}
                    onPress={() => void saveDate(event.id)}
                    style={{ flex: 1 }}
                  />
                </View>
              </>
            ) : (
              <>
                {/* Equal width, equal weight, one row. See rule 3 in the file header. */}
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Button
                    title={t('care.notNeeded')}
                    onPress={() =>
                      void runAction(event.id, () => dismissCareEvent(event.id), t('care.removed'))
                    }
                    variant="secondary"
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title={t('care.changeDate')}
                    onPress={() => {
                      setPendingDate(event.dueOn);
                      setEditingId(event.id);
                    }}
                    variant="secondary"
                    disabled={busy}
                    style={{ flex: 1 }}
                  />
                </View>
                <Button
                  title={t('care.markDone')}
                  onPress={() =>
                    void runAction(event.id, () => markCareDone(event.id), t('care.doneToast'))
                  }
                  loading={busy}
                  fullWidth
                />
              </>
            )}
          </Card>
        </View>
      );
    },
    [
      busyId,
      describeDate,
      editingId,
      pendingDate,
      rowHeight,
      runAction,
      saveDate,
      stepperLabels.earlier,
      stepperLabels.later,
      t,
    ],
  );

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        <Button
          title={t('care.addSomething')}
          onPress={() => setAddOpen(true)}
          icon="plus"
          size="lg"
          fullWidth
        />
      }
    >
      <ScreenHeader title={t('care.title')} subtitle={t('care.subtitle')} onBack={() => router.back()} />

      {profile.loading || care.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={rowHeight - spacing.md} label={t('care.loading')} />
          <Skeleton height={rowHeight - spacing.md} />
        </View>
      ) : care.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          actionLabel={t('errors.tryAgain')}
          onAction={care.reload}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('care.empty')}
          message={t('care.emptyMessage')}
          actionLabel={t('care.addSomething')}
          onAction={() => setAddOpen(true)}
        />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={renderRow}
          getItemLayout={getItemLayout}
          initialNumToRender={4}
          windowSize={5}
          removeClippedSubviews
        />
      )}

      <Dialog
        visible={addOpen}
        title={t('care.addTitle')}
        onRequestClose={() => setAddOpen(false)}
        dismissOnBackdrop={false}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setAddOpen(false)}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={t('common.save')}
              onPress={() => void submitNew()}
              size="lg"
              fullWidth
              disabled={addTitle.trim().length === 0}
              loading={addSaving}
            />
          </View>
        }
      >
        <View style={{ gap: spacing.lg }}>
          <TextField
            label={t('care.addWhat')}
            value={addTitle}
            onChangeText={setAddTitle}
            required
            autoCapitalize="sentences"
          />

          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('care.addWhich')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {KINDS.map((entry) => (
                <Chip
                  key={entry.value}
                  label={t(entry.i18nKey)}
                  selected={addKind === entry.value}
                  onPress={() => setAddKind(entry.value)}
                  selectionMode="single"
                  grow
                />
              ))}
            </View>
          </View>

          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('care.addWhen')}</Text>
            <DateStepper
              value={addDate}
              onChange={setAddDate}
              display={describeDate(addDate, true)}
              spoken={describeDate(addDate, false)}
              earlierLabel={stepperLabels.earlier}
              laterLabel={stepperLabels.later}
            />
          </View>
        </View>
      </Dialog>
    </Screen>
  );
}
