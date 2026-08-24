/**
 * One OPD visit — the record of it, and the questions taken into it.
 *
 * The four form fields are the boring half. The half that matters is below them: the
 * questions she prepared, each with somewhere to write down what the doctor actually
 * said. A government-hospital OPD appointment can be four minutes long, and by the time
 * she is back on the bus the answer to "should I keep taking the water tablet?" has
 * usually gone. An answer written down here is the only version of that conversation
 * that survives to the next visit.
 *
 * The date may be in the past and no validation stops that. Visits are logged after the
 * fact far more often than during, and a form that refuses yesterday is a form that
 * never gets filled in at all.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  Banner,
  Button,
  Card,
  Dialog,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
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
import { addDays, toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import {
  answerQuestion,
  createVisit,
  deleteVisit,
  getVisit,
  listQuestions,
  updateVisit,
  type VisitLog,
  type VisitQuestion,
} from '@/db/repositories/visits';

const STRINGS: LocalStrings = {
  'visit.titleNew': { en: 'A visit to the doctor', hi: 'डॉक्टर के पास जाना' },
  'visit.titleExisting': { en: 'Visit to the doctor', hi: 'डॉक्टर से मुलाक़ात' },
  'visit.subtitle': {
    en: 'Write down what happened, so the next visit starts from something.',
    hi: 'जो हुआ वह लिख लें, ताकि अगली बार बात शुरू करने के लिए कुछ हो।',
  },
  'visit.when': { en: 'Which day was it?', hi: 'किस दिन गई थीं?' },
  'visit.dateWithWeekday': { en: '{{weekday}}, {{date}}', hi: '{{weekday}}, {{date}}' },
  'visit.dayEarlier': { en: 'One day earlier', hi: 'एक दिन पहले' },
  'visit.dayLater': { en: 'One day later', hi: 'एक दिन बाद' },
  'visit.doctor': { en: "Doctor's name", hi: 'डॉक्टर का नाम' },
  'visit.clinic': { en: 'Hospital or clinic', hi: 'अस्पताल या क्लीनिक' },
  'visit.notes': { en: 'What was said', hi: 'क्या बात हुई' },
  'visit.notesHelper': {
    en: 'In your own words. Nobody else reads this unless you send it.',
    hi: 'अपने शब्दों में। जब तक आप न भेजें, इसे कोई और नहीं पढ़ता।',
  },
  'visit.questions': { en: 'Questions for this visit', hi: 'इस मुलाक़ात के लिए सवाल' },
  'visit.questionsHelperSaved': {
    en: 'Write down the answer next to each one while you still remember it.',
    hi: 'जब तक याद है, हर सवाल के आगे जवाब लिख लें।',
  },
  'visit.questionsHelperUnsaved': {
    en: 'Save this visit first, then you can attach the questions you prepared.',
    hi: 'पहले इस मुलाक़ात को सेव करें, फिर तैयार किए सवाल इससे जोड़ सकती हैं।',
  },
  'visit.prepare': { en: 'Prepare questions', hi: 'सवाल तैयार करें' },
  'visit.noQuestions': { en: 'No questions attached yet', hi: 'अभी कोई सवाल जुड़ा नहीं है' },
  'visit.writeAnswer': { en: 'Write the answer', hi: 'जवाब लिखें' },
  'visit.changeAnswer': { en: 'Change the answer', hi: 'जवाब बदलें' },
  'visit.answerTitle': { en: 'What did the doctor say?', hi: 'डॉक्टर ने क्या कहा?' },
  'visit.answerLabel': { en: 'The answer', hi: 'जवाब' },
  'visit.answerSaved': { en: 'Answer written down', hi: 'जवाब लिख लिया' },
  'visit.noAnswerYet': { en: 'No answer written down yet', hi: 'अभी कोई जवाब नहीं लिखा' },
  'visit.fromApp': { en: 'Suggested by the app', hi: 'ऐप ने सुझाया था' },
  'visit.deleteTitle': { en: 'Remove this visit?', hi: 'यह मुलाक़ात हटा दें?' },
  'visit.deleteMessage': {
    en: 'The questions you wrote are kept. Only the visit record goes.',
    hi: 'आपके लिखे सवाल रहेंगे। सिर्फ़ मुलाक़ात का रिकॉर्ड हटेगा।',
  },
  'visit.deleted': { en: 'The visit was removed', hi: 'मुलाक़ात हटा दी गई' },
  'visit.loading': { en: 'Opening this visit', hi: 'यह मुलाक़ात खुल रही है' },
};

/** Bounded by the same reasoning as the care list: one exact height, no measuring. */
function useRowHeight(): number {
  const fontSizes = useFontSizes();
  return fontSizes.md >= 20 ? 276 : 224;
}

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

export default function VisitScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const rowHeight = useRowHeight();
  const { formatDate, formatWeekday } = useDateFormat();

  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const visitId = Array.isArray(rawId) ? rawId[0] : rawId;

  const profile = useProfileId();
  const profileId = profile.data;

  const [visitedOn, setVisitedOn] = useState<string>(toLocalDate());
  const [doctor, setDoctor] = useState('');
  const [clinic, setClinic] = useState('');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [answering, setAnswering] = useState<VisitQuestion | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [answerSaving, setAnswerSaving] = useState(false);

  // Fills the form from the row exactly once per load. Doing it in an effect keyed on the
  // loaded object would fight the user: a reload triggered by returning from the question
  // screen would wipe whatever she had half-typed. Declared above the loader that calls it
  // so the loader closes over this exact function rather than a hoisted binding.
  const hydrate = useCallback((loaded: VisitLog) => {
    setVisitedOn(loaded.visitedOn);
    setDoctor(loaded.doctor ?? '');
    setClinic(loaded.clinic ?? '');
    setNotes(loaded.notes ?? '');
    setDirty(false);
  }, []);

  const visit = useAsync(async () => {
    if (!visitId) return null;
    const loaded = await getVisit(visitId);
    if (loaded) hydrate(loaded);
    return loaded;
  }, [visitId]);

  const questions = useAsync(async () => {
    if (!profileId || !visitId) return [] as VisitQuestion[];
    return listQuestions(profileId, { visitId });
  }, [profileId, visitId]);
  useReloadOnFocus(questions.reload);

  const describeDate = useCallback(
    (localDate: string, short: boolean) =>
      t('visit.dateWithWeekday', {
        weekday: formatWeekday(localDate, short),
        date: formatDate(localDate),
      }),
    [formatDate, formatWeekday, t],
  );

  const markDirty = useCallback(<T,>(setter: (value: T) => void) => {
    return (value: T) => {
      setDirty(true);
      setter(value);
    };
  }, []);

  const save = useCallback(async () => {
    if (!profileId) return;
    setSaving(true);
    try {
      const patch = {
        visitedOn,
        doctor: doctor.trim() === '' ? null : doctor.trim(),
        clinic: clinic.trim() === '' ? null : clinic.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      };
      if (visitId) {
        await updateVisit(visitId, patch);
        setDirty(false);
        toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
        visit.reload();
      } else {
        const createdId = await createVisit({ profileId, ...patch });
        setDirty(false);
        toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
        // Replaced rather than pushed: the unsaved version of this screen must not stay
        // on the stack where Back would return her to a form that no longer owns the row.
        router.replace(`/care/visit?id=${createdId}`);
      }
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [clinic, doctor, notes, profileId, t, toast, visit, visitId, visitedOn]);

  const handleBack = useCallback(async () => {
    if (dirty) {
      const leave = await confirm({
        title: t('entry.common.discardTitle'),
        message: t('entry.common.discardMessage'),
        confirmLabel: t('entry.common.discardConfirm'),
        cancelLabel: t('common.cancel'),
      });
      if (!leave) return;
    }
    router.back();
  }, [confirm, dirty, t]);

  const remove = useCallback(async () => {
    if (!visitId) return;
    const ok = await confirm({
      title: t('visit.deleteTitle'),
      message: t('visit.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteVisit(visitId);
      toast.show({ message: t('visit.deleted'), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    }
  }, [confirm, t, toast, visitId]);

  const submitAnswer = useCallback(async () => {
    const target = answering;
    const text = answerText.trim();
    if (!target || text.length === 0) return;
    setAnswerSaving(true);
    try {
      await answerQuestion(target.id, text);
      setAnswering(null);
      setAnswerText('');
      toast.show({ message: t('visit.answerSaved'), variant: 'success' });
      questions.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setAnswerSaving(false);
    }
  }, [answerText, answering, questions, t, toast]);

  const getItemLayout = useMemo(() => fixedItemLayout(rowHeight), [rowHeight]);

  const header = (
    <View style={{ gap: spacing.lg }}>
      <ScreenHeader
        title={visitId ? t('visit.titleExisting') : t('visit.titleNew')}
        subtitle={t('visit.subtitle')}
        onBack={() => void handleBack()}
      />

      {visit.error ? <Banner variant="attention" title={t('errors.loadFailed')} /> : null}

      {visitId && visit.loading ? (
        <Skeleton height={200} label={t('visit.loading')} />
      ) : (
        <Card style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('visit.when')}</Text>
            <DateStepper
              value={visitedOn}
              onChange={markDirty(setVisitedOn)}
              display={describeDate(visitedOn, true)}
              spoken={describeDate(visitedOn, false)}
              earlierLabel={t('visit.dayEarlier')}
              laterLabel={t('visit.dayLater')}
            />
          </View>

          <TextField
            label={t('visit.doctor')}
            value={doctor}
            onChangeText={markDirty(setDoctor)}
            helper={t('common.optional')}
            autoCapitalize="words"
          />
          <TextField
            label={t('visit.clinic')}
            value={clinic}
            onChangeText={markDirty(setClinic)}
            helper={t('common.optional')}
            autoCapitalize="words"
          />
          <TextField
            label={t('visit.notes')}
            value={notes}
            onChangeText={markDirty(setNotes)}
            helper={t('visit.notesHelper')}
            multiline
            autoCapitalize="sentences"
          />
        </Card>
      )}

      <SectionHeader
        title={t('visit.questions')}
        subtitle={visitId ? t('visit.questionsHelperSaved') : t('visit.questionsHelperUnsaved')}
      />

      {visitId ? (
        <Button
          title={t('visit.prepare')}
          onPress={() => router.push(`/care/questions?visitId=${visitId}`)}
          variant="secondary"
          icon="plus"
          fullWidth
        />
      ) : null}

      {visitId && !questions.loading && (questions.data ?? []).length === 0 ? (
        <Text variant="body" tone="muted" style={{ paddingTop: spacing.md }}>
          {t('visit.noQuestions')}
        </Text>
      ) : null}
    </View>
  );

  const renderQuestion = useCallback(
    ({ item }: { item: VisitQuestion }) => (
      <View style={{ height: rowHeight, paddingBottom: spacing.md }}>
        <Card style={{ flex: 1, gap: spacing.sm }}>
          <Text variant="body" weight="600" numberOfLines={2}>
            {item.text}
          </Text>

          {/* An app-composed line is always labelled. A doctor reading the list is
              entitled to know which sentences the patient actually wrote. */}
          {item.origin === 'auto' ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {t('visit.fromApp')}
            </Text>
          ) : null}

          <Text
            variant="body"
            tone={item.answered ? 'default' : 'muted'}
            numberOfLines={2}
            style={{ flex: 1 }}
          >
            {item.answered && item.answerText ? item.answerText : t('visit.noAnswerYet')}
          </Text>

          <Button
            title={item.answered ? t('visit.changeAnswer') : t('visit.writeAnswer')}
            onPress={() => {
              setAnswering(item);
              setAnswerText(item.answerText ?? '');
            }}
            variant="secondary"
            fullWidth
          />
        </Card>
      </View>
    ),
    [rowHeight, t],
  );

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('common.save')}
            onPress={() => void save()}
            size="lg"
            fullWidth
            loading={saving}
          />
          {visitId ? (
            <Button title={t('common.delete')} onPress={() => void remove()} variant="destructive" fullWidth />
          ) : null}
        </View>
      }
    >
      {/* The form is the list header so there is exactly one scroll container: a FlatList
          nested inside a ScrollView loses virtualisation entirely, which is the same as
          mapping over the array. `getItemLayout` covers the rows; it does not include the
          header's height, and nothing here scrolls to an index. */}
      <FlatList
        style={{ flex: 1 }}
        data={visitId ? (questions.data ?? []) : []}
        keyExtractor={(question) => question.id}
        renderItem={renderQuestion}
        ListHeaderComponent={header}
        getItemLayout={getItemLayout}
        initialNumToRender={4}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
      />

      <Dialog
        visible={answering !== null}
        title={t('visit.answerTitle')}
        onRequestClose={() => setAnswering(null)}
        dismissOnBackdrop={false}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setAnswering(null)}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={t('common.save')}
              onPress={() => void submitAnswer()}
              size="lg"
              fullWidth
              disabled={answerText.trim().length === 0}
              loading={answerSaving}
            />
          </View>
        }
      >
        <View style={{ gap: spacing.md }}>
          {answering ? <Text variant="body">{answering.text}</Text> : null}
          <TextField
            label={t('visit.answerLabel')}
            value={answerText}
            onChangeText={setAnswerText}
            multiline
            autoCapitalize="sentences"
          />
        </View>
      </Dialog>
    </Screen>
  );
}
