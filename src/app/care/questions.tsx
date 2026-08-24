/**
 * Preparing questions for an OPD visit.
 *
 * ─── WHAT THE APP IS ALLOWED TO PUT IN HER MOUTH ─────────────────────────────
 * Every suggested line below states a FACT that is already in her own record and then
 * stops. "I started Metformin on 4 August — is that still right?" is a fact plus a
 * request for confirmation. "Your sugar has been high, ask about increasing the dose"
 * would be a recommendation, and this app does not make recommendations — not on a
 * chart, not in a report, and least of all in a sentence she will read aloud to a
 * doctor who will reasonably assume she meant it herself.
 *
 * So the generator has exactly one shape: observation → question about the RECORD.
 * The word "should" appears once, in "Should I have a target range for my …?", and that
 * asks whether a number exists in her file — not what the number ought to be.
 *
 * A suggestion is NOT written to the database until she adds it. Auto-generating rows
 * she never asked for would mean either resurrecting the ones she deletes on every
 * visit to this screen, or silently building a list of app-authored questions that
 * arrives at the clinic looking like hers. Dismissals are remembered in `app_meta`, so
 * "not this one" means not ever, without a tombstone in the questions table.
 * ─────────────────────────────────────────────────────────────────────────────
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
  ListRow,
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
  getMetaJson,
  matchTarget,
  setMetaJson,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { useI18n, type TranslateFn } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, daysBetween, toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import { inTransaction } from '@/db/repositories/_shared';
import {
  addQuestion,
  attachQuestionsToVisit,
  createVisit,
  deleteQuestion,
  listQuestions,
  listVisits,
  type VisitLog,
  type VisitQuestion,
} from '@/db/repositories/visits';
import { listMetricDefs } from '@/db/repositories/metrics';
import { getLatestReading } from '@/db/repositories/readings';
import { listTargets } from '@/db/repositories/targets';
import { listCurrentMedicines } from '@/db/repositories/medicines';
import { listSymptomDefs, listSymptomEvents } from '@/db/repositories/symptoms';
import { computeAdherence } from '@/features/adherence';

const STRINGS: LocalStrings = {
  'questions.title': { en: 'Questions for the doctor', hi: 'डॉक्टर से पूछने के सवाल' },
  'questions.subtitle': {
    en: 'A written list is the difference between asking and forgetting.',
    hi: 'लिखी हुई सूची ही है जो पूछने और भूल जाने के बीच फ़र्क़ करती है।',
  },
  'questions.yourList': { en: 'Your questions', hi: 'आपके सवाल' },
  'questions.addYours': { en: 'Write a question of your own', hi: 'अपना सवाल लिखें' },
  'questions.addAction': { en: 'Add this question', hi: 'यह सवाल जोड़ें' },
  'questions.suggested': { en: 'Suggested by the app', hi: 'ऐप के सुझाए सवाल' },
  'questions.suggestedHelp': {
    en: 'Each of these repeats something already in your record. Add the ones you want.',
    hi: 'इनमें वही बातें हैं जो आपके रिकॉर्ड में पहले से हैं। जो चाहिए वही जोड़ें।',
  },
  'questions.addSuggestion': { en: 'Add', hi: 'जोड़ें' },
  'questions.dropSuggestion': { en: 'Not this one', hi: 'यह नहीं' },
  'questions.fromApp': { en: 'Suggested by the app', hi: 'ऐप ने सुझाया था' },
  'questions.fromYou': { en: 'You wrote this', hi: 'यह आपने लिखा' },
  'questions.selectHint': { en: 'Tap to choose it for a visit', hi: 'मुलाक़ात के लिए चुनने को दबाएँ' },
  'questions.empty': { en: 'No questions written down yet', hi: 'अभी कोई सवाल नहीं लिखा' },
  'questions.emptyMessage': {
    en: 'Write anything you want to remember to ask. It stays on this phone.',
    hi: 'जो भी पूछना याद रखना है, लिख लें। यह इसी फोन में रहता है।',
  },
  'questions.editTitle': { en: 'Change this question', hi: 'यह सवाल बदलें' },
  'questions.editLabel': { en: 'The question', hi: 'सवाल' },
  'questions.removeTitle': { en: 'Remove this question?', hi: 'यह सवाल हटा दें?' },
  'questions.attachToVisit': { en: 'Take these to the visit', hi: 'इन्हें मुलाक़ात में ले जाएँ' },
  'questions.chooseVisit': { en: 'Which visit?', hi: 'कौन सी मुलाक़ात?' },
  'questions.newVisit': { en: 'A new visit', hi: 'नई मुलाक़ात' },
  'questions.attached': { en: 'Added to the visit', hi: 'मुलाक़ात में जोड़ दिया' },
  'questions.selectedCount': { en: '{{count}} chosen', hi: '{{count}} चुने गए' },
  'questions.loading': { en: 'Opening your questions', hi: 'आपके सवाल खुल रहे हैं' },
  'questions.visitOn': { en: 'Visit on {{date}}', hi: '{{date}} की मुलाक़ात' },

  // The generated lines. Each states a fact from her own record and asks about the record.
  'questions.autoTarget': {
    en: 'Should I have a target range for my {{metric}}?',
    hi: 'क्या मेरे {{metric}} के लिए कोई लक्ष्य सीमा होनी चाहिए?',
  },
  'questions.autoMedicine': {
    en: 'I started {{name}} on {{date}} — is that still right?',
    hi: 'मैंने {{name}} {{date}} को शुरू की थी — क्या वह अब भी ठीक है?',
  },
  'questions.autoSymptom': {
    en: 'I have recorded {{symptom}} {{count}} times since {{date}}.',
    hi: 'मैंने {{date}} से अब तक {{symptom}} {{count}} बार दर्ज किया है।',
  },
  'questions.autoAdherence': {
    en: 'Some doses were not recorded either way between {{from}} and {{to}}.',
    hi: '{{from}} से {{to}} के बीच कुछ खुराकों के बारे में कुछ भी दर्ज नहीं हुआ।',
  },
};

/** The most suggestions ever shown at once. Past this it stops being a list she reads. */
const MAX_SUGGESTIONS = 6;

/** A symptom has to appear this often before it is worth taking to an OPD. */
const SYMPTOM_REPEAT_THRESHOLD = 3;

/** With no earlier visit on record, "since last time" means the last month. */
const DEFAULT_LOOKBACK_DAYS = 30;

const HIDDEN_SUGGESTION_PREFIX = 'care_questions_hidden:';

type Suggestion = {
  /** Stable across regenerations, so a dismissal sticks to the thing, not the wording. */
  key: string;
  text: string;
  /** True when the line came out of the adherence record, which must carry its caveat. */
  fromAdherence?: boolean;
};

type ScreenData = {
  loose: VisitQuestion[];
  visits: VisitLog[];
  suggestions: Suggestion[];
  /** True when any suggestion was derived from the reminder record. */
  hasAdherenceSuggestion: boolean;
};

export default function QuestionsScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const fontSizes = useFontSizes();
  const { colors } = useTheme();
  const { formatDate } = useDateFormat();

  const rawVisitId = useLocalSearchParams<{ visitId?: string | string[] }>().visitId;
  const visitId = Array.isArray(rawVisitId) ? rawVisitId[0] : rawVisitId;

  const profile = useProfileId();
  const profileId = profile.data;

  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editing, setEditing] = useState<VisitQuestion | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const screen = useAsync<ScreenData | null>(async () => {
    if (!profileId) return null;
    return loadScreenData(profileId, visitId, lang, t, formatDate);
  }, [profileId, visitId, lang, t, formatDate]);
  useReloadOnFocus(screen.reload);

  const loose = screen.data?.loose ?? [];
  const suggestions = screen.data?.suggestions ?? [];
  const visits = screen.data?.visits ?? [];

  const rowHeight = fontSizes.md >= 20 ? 244 : 196;
  const getItemLayout = useMemo(() => fixedItemLayout(rowHeight), [rowHeight]);

  const toggle = useCallback((id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const addOwn = useCallback(async () => {
    const text = draft.trim();
    if (!profileId || text.length === 0) return;
    setBusy(true);
    try {
      await addQuestion(profileId, text, null, 'user');
      setDraft('');
      screen.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [draft, profileId, screen, t, toast]);

  const acceptSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      if (!profileId) return;
      setBusy(true);
      try {
        await addQuestion(profileId, suggestion.text, null, 'auto');
        screen.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [profileId, screen, t, toast],
  );

  const dismissSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      if (!profileId) return;
      try {
        const key = `${HIDDEN_SUGGESTION_PREFIX}${profileId}`;
        const stored = (await getMetaJson<string[]>(key)) ?? [];
        if (!stored.includes(suggestion.key)) await setMetaJson(key, [...stored, suggestion.key]);
        screen.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      }
    },
    [profileId, screen, t, toast],
  );

  const saveEdit = useCallback(async () => {
    const target = editing;
    const text = editText.trim();
    if (!profileId || !target || text.length === 0) return;
    setBusy(true);
    try {
      // `visit_question` rows are append-only as far as the repository is concerned, so a
      // correction is a replace. Both halves go in one transaction: a crash between them
      // would leave her with a question she had only meant to reword, deleted.
      //
      // The replacement is 'user' whatever the original was. Once she has rewritten a
      // suggested line it is her sentence, and labelling it as the app's would be wrong
      // in exactly the direction that matters in front of a doctor.
      await inTransaction(async (tx) => {
        await deleteQuestion(target.id, tx);
        await addQuestion(profileId, text, null, 'user', tx);
      });
      setEditing(null);
      setEditText('');
      setSelected((current) => current.filter((entry) => entry !== target.id));
      screen.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [editText, editing, profileId, screen, t, toast]);

  const remove = useCallback(
    async (question: VisitQuestion) => {
      const ok = await confirm({
        title: t('questions.removeTitle'),
        message: question.text,
        confirmLabel: t('common.remove'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteQuestion(question.id);
        setSelected((current) => current.filter((entry) => entry !== question.id));
        screen.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      }
    },
    [confirm, screen, t, toast],
  );

  const attachTo = useCallback(
    async (targetVisitId: string) => {
      if (selected.length === 0) return;
      setBusy(true);
      try {
        await attachQuestionsToVisit(selected, targetVisitId);
        setSelected([]);
        setPickerOpen(false);
        toast.show({ message: t('questions.attached'), variant: 'success' });
        screen.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [screen, selected, t, toast],
  );

  const attachToNewVisit = useCallback(async () => {
    if (!profileId || selected.length === 0) return;
    setBusy(true);
    try {
      const createdId = await createVisit({ profileId, visitedOn: toLocalDate() });
      await attachQuestionsToVisit(selected, createdId);
      setSelected([]);
      setPickerOpen(false);
      router.push(`/care/visit?id=${createdId}`);
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [profileId, selected, t, toast]);

  const onAttachPressed = useCallback(() => {
    if (visitId) {
      void attachTo(visitId);
      return;
    }
    setPickerOpen(true);
  }, [attachTo, visitId]);

  const renderQuestion = useCallback(
    ({ item }: { item: VisitQuestion }) => {
      const isSelected = selected.includes(item.id);
      return (
        <View style={{ height: rowHeight, paddingBottom: spacing.md }}>
          <Card style={{ flex: 1, gap: spacing.sm }}>
            <PressableScale
              onPress={() => toggle(item.id)}
              accessibilityRole="checkbox"
              accessibilityLabel={item.text}
              accessibilityHint={t('questions.selectHint')}
              accessibilityState={{ checked: isSelected }}
              style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', flex: 1 }}
            >
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radii.sm,
                  borderWidth: isSelected ? 3 : 2,
                  borderColor: isSelected ? colors.primary : colors.borderStrong,
                  backgroundColor: isSelected ? colors.primarySoft : colors.bgElevated,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isSelected ? <Icon name="check" size={22} color={colors.primary} strokeWidth={2.8} /> : null}
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text variant="body" weight="600" numberOfLines={2}>
                  {item.text}
                </Text>
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {t(item.origin === 'auto' ? 'questions.fromApp' : 'questions.fromYou')}
                </Text>
              </View>
            </PressableScale>

            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Button
                title={t('common.edit')}
                onPress={() => {
                  setEditing(item);
                  setEditText(item.text);
                }}
                variant="secondary"
                style={{ flex: 1 }}
              />
              <Button
                title={t('common.remove')}
                onPress={() => void remove(item)}
                variant="secondary"
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        </View>
      );
    },
    [colors, remove, rowHeight, selected, t, toggle],
  );

  const header = (
    <View style={{ gap: spacing.md }}>
      <ScreenHeader
        title={t('questions.title')}
        subtitle={t('questions.subtitle')}
        onBack={() => router.back()}
      />

      {screen.error ? <Banner variant="attention" title={t('errors.loadFailed')} /> : null}

      <Card style={{ gap: spacing.md }}>
        <TextField
          label={t('questions.addYours')}
          value={draft}
          onChangeText={setDraft}
          multiline
          autoCapitalize="sentences"
        />
        <Button
          title={t('questions.addAction')}
          onPress={() => void addOwn()}
          icon="plus"
          fullWidth
          disabled={draft.trim().length === 0}
          loading={busy && draft.trim().length > 0}
        />
      </Card>

      {suggestions.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <SectionHeader title={t('questions.suggested')} subtitle={t('questions.suggestedHelp')} />
          {/* Bounded by MAX_SUGGESTIONS at the source, so this is never an open-ended map. */}
          {suggestions.map((suggestion) => (
            <Card key={suggestion.key} variant="outlined" style={{ gap: spacing.sm }}>
              <Text variant="body">{suggestion.text}</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  title={t('questions.addSuggestion')}
                  onPress={() => void acceptSuggestion(suggestion)}
                  style={{ flex: 1 }}
                />
                <Button
                  title={t('questions.dropSuggestion')}
                  onPress={() => void dismissSuggestion(suggestion)}
                  variant="secondary"
                  style={{ flex: 1 }}
                />
              </View>
            </Card>
          ))}
          {screen.data?.hasAdherenceSuggestion ? (
            // Anything drawn from the reminder record carries its caveat on the same
            // screen. The count is of taps in an app, not of tablets swallowed.
            <Text variant="caption" tone="muted">
              {t('reminders.adherence.explain')}
            </Text>
          ) : null}
        </View>
      ) : null}

      <SectionHeader
        title={t('questions.yourList')}
        subtitle={selected.length > 0 ? t('questions.selectedCount', { count: selected.length }) : undefined}
      />

      {screen.loading ? <Skeleton height={rowHeight} label={t('questions.loading')} /> : null}

      {!screen.loading && loose.length === 0 ? (
        <Card variant="sunken" style={{ gap: spacing.sm }}>
          <Text variant="label">{t('questions.empty')}</Text>
          <Text variant="body" tone="muted">
            {t('questions.emptyMessage')}
          </Text>
        </Card>
      ) : null}
    </View>
  );

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        <Button
          title={t('questions.attachToVisit')}
          onPress={onAttachPressed}
          size="lg"
          fullWidth
          disabled={selected.length === 0}
          loading={busy && selected.length > 0}
        />
      }
    >
      {/* One list, one fixed row height. `getItemLayout` measures rows only and does not
          account for the header's height — which is fine here because nothing on this
          screen scrolls to an index; the layout is there so the JS thread never measures
          a row while she is scrolling. */}
      <FlatList
        style={{ flex: 1 }}
        data={loose}
        keyExtractor={(question) => question.id}
        renderItem={renderQuestion}
        ListHeaderComponent={header}
        getItemLayout={getItemLayout}
        initialNumToRender={5}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
      />

      <Dialog
        visible={editing !== null}
        title={t('questions.editTitle')}
        onRequestClose={() => setEditing(null)}
        dismissOnBackdrop={false}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setEditing(null)}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={t('common.save')}
              onPress={() => void saveEdit()}
              size="lg"
              fullWidth
              disabled={editText.trim().length === 0}
              loading={busy}
            />
          </View>
        }
      >
        <TextField
          label={t('questions.editLabel')}
          value={editText}
          onChangeText={setEditText}
          multiline
          autoCapitalize="sentences"
        />
      </Dialog>

      <Dialog
        visible={pickerOpen}
        title={t('questions.chooseVisit')}
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={{ gap: spacing.sm }}>
          <Button
            title={t('questions.newVisit')}
            onPress={() => void attachToNewVisit()}
            icon="plus"
            fullWidth
          />
          {/* `loadScreenData` already caps this at RECENT_VISITS. */}
          {visits.map((entry) => (
            <ListRow
              key={entry.id}
              title={t('questions.visitOn', { date: formatDate(entry.visitedOn) })}
              subtitle={entry.doctor ?? entry.clinic ?? undefined}
              onPress={() => void attachTo(entry.id)}
            />
          ))}
        </View>
      </Dialog>
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Loading and suggestion generation
// ═══════════════════════════════════════════════════════════════════════════════

/** How many past visits the "which visit?" picker offers. Older ones are not the target. */
const RECENT_VISITS = 8;

async function loadScreenData(
  profileId: string,
  currentVisitId: string | undefined,
  lang: 'en' | 'hi',
  t: TranslateFn,
  formatDate: (localDate: string) => string,
): Promise<ScreenData> {
  const today = toLocalDate();

  const [allQuestions, loose, visits, hiddenList] = await Promise.all([
    listQuestions(profileId),
    listQuestions(profileId, { visitId: null }),
    listVisits(profileId),
    getMetaJson<string[]>(`${HIDDEN_SUGGESTION_PREFIX}${profileId}`),
  ]);

  // "Since last time" means the last visit that is not the one being prepared for —
  // otherwise opening this screen from a visit created today collapses the window to zero
  // and every suggestion silently disappears.
  const previousVisit = visits.find((visit) => visit.id !== currentVisitId);
  const since = previousVisit?.visitedOn ?? addDays(today, -DEFAULT_LOOKBACK_DAYS);

  const existingText = new Set(allQuestions.map((question) => question.text));
  const hiddenKeys = new Set(hiddenList ?? []);

  const suggestions = await buildSuggestions({
    profileId,
    since,
    today,
    lang,
    t,
    formatDate,
  });

  const filtered = suggestions
    .filter((suggestion) => !hiddenKeys.has(suggestion.key) && !existingText.has(suggestion.text))
    .slice(0, MAX_SUGGESTIONS);

  return {
    loose,
    visits: visits.slice(0, RECENT_VISITS),
    suggestions: filtered,
    hasAdherenceSuggestion: filtered.some((suggestion) => suggestion.fromAdherence === true),
  };
}

async function buildSuggestions(input: {
  profileId: string;
  since: string;
  today: string;
  lang: 'en' | 'hi';
  t: TranslateFn;
  formatDate: (localDate: string) => string;
}): Promise<Suggestion[]> {
  const { profileId, since, today, lang, t, formatDate } = input;
  const out: Suggestion[] = [];

  // 1. A metric she is recording that has no target anybody set.
  //    This asks whether a number exists in her file. It does not propose one — the app
  //    ships no thresholds and `target_range` stays empty until a named human fills it.
  try {
    const [metrics, targets] = await Promise.all([listMetricDefs(), listTargets(profileId)]);
    for (const metric of metrics) {
      const latest = await getLatestReading(profileId, metric.key);
      if (!latest) continue;
      if (matchTarget(targets, metric.key, metric.schema.primaryField, null) !== null) continue;
      out.push({
        key: `target:${metric.key}`,
        text: t('questions.autoTarget', { metric: lang === 'hi' ? metric.labelHi : metric.labelEn }),
      });
    }
  } catch {
    // A suggestion source that fails is a suggestion that is not offered. It must never
    // take down the screen she came here to type her own questions into.
  }

  // 2. A medicine that started since the last visit.
  try {
    const medicines = await listCurrentMedicines(profileId);
    for (const medicine of medicines) {
      if (!medicine.startedOn || medicine.startedOn < since) continue;
      out.push({
        key: `medicine:${medicine.threadId}`,
        text: t('questions.autoMedicine', {
          name: medicine.nameAsWritten,
          date: formatDate(medicine.startedOn),
        }),
      });
    }
  } catch {
    /* see above */
  }

  // 3. A symptom recorded three or more times in the period.
  try {
    const [events, defs] = await Promise.all([
      listSymptomEvents(profileId, { fromDate: since, toDate: today }),
      listSymptomDefs(),
    ]);
    const labels = new Map(defs.map((def) => [def.key, lang === 'hi' ? def.labelHi : def.labelEn]));
    const counts = new Map<string, { label: string; count: number }>();
    for (const event of events) {
      const identity = event.symptomKey ?? event.customLabel;
      if (!identity) continue;
      const label = event.symptomKey ? (labels.get(event.symptomKey) ?? identity) : identity;
      const existing = counts.get(identity);
      if (existing) existing.count += 1;
      else counts.set(identity, { label, count: 1 });
    }
    for (const [identity, entry] of counts) {
      if (entry.count < SYMPTOM_REPEAT_THRESHOLD) continue;
      out.push({
        key: `symptom:${identity}`,
        text: t('questions.autoSymptom', {
          symptom: entry.label,
          count: entry.count,
          date: formatDate(since),
        }),
      });
    }
  } catch {
    /* see above */
  }

  // 4. The reminder record is too thin to publish a percentage from.
  //    The line states that the record has holes. It does not say she skipped anything,
  //    because the app cannot tell a skipped dose from a phone that was switched off.
  try {
    const windowDays = Math.max(7, Math.min(90, daysBetween(since, today) + 1));
    const summary = await computeAdherence(profileId, windowDays);
    if (summary.percent === null && summary.due > 0) {
      out.push({
        key: 'adherence:incomplete',
        fromAdherence: true,
        text: t('questions.autoAdherence', {
          from: formatDate(addDays(today, -(windowDays - 1))),
          to: formatDate(today),
        }),
      });
    }
  } catch {
    /* see above */
  }

  return out;
}
