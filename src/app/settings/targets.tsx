/**
 * Target ranges.
 *
 * ─── THIS SCREEN SHIPS BLANK AND STAYS BLANK ──────────────────────────────────
 * There is no prefill here, no suggested band, no greyed-out "typical range"
 * placeholder, no example number sitting in an input waiting to be accepted. Not one.
 * A number this app puts on screen next to the word "target" is a clinical threshold the
 * app invented, and this app does not invent clinical thresholds — that rule is the
 * whole reason `target_range` ships empty and `setTarget()` refuses to default
 * `setByLabel` or `setOn`.
 *
 * So the form asks two questions that a prefill could never answer: WHO said so, and
 * WHEN. Both are mandatory, both are stored, and both are printed in the legend of every
 * chart that draws this band — so the reader can always see whose line she is looking at.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import {
  METRIC_BP,
  METRIC_SUGAR,
  METRIC_WEIGHT,
  SUGAR_CONTEXTS,
  SUGAR_CONTEXT_KEY,
  metricUnit,
  parseDecimal,
  targetFootnote,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Dialog,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  deleteTarget,
  listTargets,
  setTarget,
  updateTarget,
} from '@/db/repositories/targets';
import { useDateFormat } from '@/i18n/useDateFormat';
import { toLocalDate } from '@/lib/datetime';
import { spacing } from '@/theme';
import type { TargetRange } from '@/types';

type Slot = {
  /** Stable render key. Never stored. */
  id: string;
  metricKey: string;
  field: TargetRange['field'];
  context: Record<string, string> | null;
  metricKeyI18n: string;
  fieldKeyI18n: string;
};

/**
 * Every place a target can exist, fixed at module scope.
 *
 * Blood pressure carries two independent bands (the upper and lower numbers are set
 * separately by a doctor); blood sugar carries one per meal context, because "under 140"
 * means something completely different before a meal and two hours after one.
 */
const SLOTS: readonly Slot[] = [
  {
    id: 'bp-v1',
    metricKey: METRIC_BP,
    field: 'v1',
    context: null,
    metricKeyI18n: 'entry.bp.title',
    fieldKeyI18n: 'entry.bp.systolic',
  },
  {
    id: 'bp-v2',
    metricKey: METRIC_BP,
    field: 'v2',
    context: null,
    metricKeyI18n: 'entry.bp.title',
    fieldKeyI18n: 'entry.bp.diastolic',
  },
  ...SUGAR_CONTEXTS.map((context) => ({
    id: `sugar-${context.value}`,
    metricKey: METRIC_SUGAR,
    field: 'v1' as const,
    context: { [SUGAR_CONTEXT_KEY]: context.value },
    metricKeyI18n: 'entry.sugar.title',
    fieldKeyI18n: context.i18nKey,
  })),
  {
    id: 'weight-v1',
    metricKey: METRIC_WEIGHT,
    field: 'v1',
    context: null,
    metricKeyI18n: 'entry.weight.title',
    fieldKeyI18n: 'entry.weight.value',
  },
];

const STRINGS: LocalStrings = {
  'targets.title': {
    en: 'The range my doctor asked me to stay in',
    hi: 'वह दायरा जिसमें रहने को मेरे डॉक्टर ने कहा है',
  },
  'targets.subtitle': {
    en: 'Fill these in only if your doctor has given you numbers.',
    hi: 'ये तभी भरें जब आपके डॉक्टर ने आपको अंक दिए हों।',
  },
  'targets.appNeverSupplies': {
    en: 'Aarogya does not supply target ranges and never will. Every number on this page is one a person you name gave you, and their name and the date appear on every chart that uses it.',
    hi: 'आरोग्य खुद कोई दायरा नहीं देता और न कभी देगा। इस पन्ने का हर अंक वही है जो आपके बताए किसी व्यक्ति ने दिया है, और उनका नाम और तारीख़ हर उस चार्ट पर दिखती है जहाँ यह अंक काम आता है।',
  },
  'targets.pairPattern': { en: '{{metric}} — {{field}}', hi: '{{metric}} — {{field}}' },
  'targets.notSet': { en: 'Nothing filled in', hi: 'कुछ नहीं भरा है' },
  'targets.add': { en: 'Add the numbers', hi: 'अंक भरें' },
  'targets.between': { en: '{{low}} to {{high}} {{unit}}', hi: '{{low}} से {{high}} {{unit}}' },
  'targets.atLeast': { en: '{{low}} {{unit}} or more', hi: '{{low}} {{unit}} या उससे ज़्यादा' },
  'targets.atMost': { en: '{{high}} {{unit}} or less', hi: '{{high}} {{unit}} या उससे कम' },
  'targets.low': { en: 'Lowest number they said', hi: 'उन्होंने जो सबसे कम अंक बताया' },
  'targets.high': { en: 'Highest number they said', hi: 'उन्होंने जो सबसे ज़्यादा अंक बताया' },
  'targets.oneIsEnough': {
    en: 'You can fill in only one of the two if that is all they said.',
    hi: 'अगर उन्होंने सिर्फ़ एक ही अंक बताया है तो दोनों में से एक ही भरें।',
  },
  'targets.setBy': { en: 'Who gave you these numbers?', hi: 'ये अंक आपको किसने दिए?' },
  'targets.setByHelper': {
    en: 'A name you will recognise later — “Dr Sharma”, “the TB clinic”',
    hi: 'ऐसा नाम जो आपको बाद में याद रहे — “डॉ. शर्मा”, “टीबी क्लीनिक”',
  },
  'targets.setOn': { en: 'When did they say it?', hi: 'उन्होंने यह कब कहा?' },
  'targets.day': { en: 'Day', hi: 'दिन' },
  'targets.month': { en: 'Month', hi: 'महीना' },
  'targets.year': { en: 'Year', hi: 'साल' },
  'targets.useToday': { en: 'They said it today', hi: 'उन्होंने आज ही कहा है' },
  'targets.needNumber': {
    en: 'Please fill in at least one of the two numbers.',
    hi: 'दोनों में से कम से कम एक अंक ज़रूर भरें।',
  },
  'targets.lowAboveHigh': {
    en: 'The lower number cannot be bigger than the higher one.',
    hi: 'कम वाला अंक ज़्यादा वाले से बड़ा नहीं हो सकता।',
  },
  'targets.needName': {
    en: 'Please write who gave you these numbers. It is printed on every chart, so a chart is never a number with nobody behind it.',
    hi: 'कृपया लिखें कि ये अंक आपको किसने दिए। यह हर चार्ट पर दिखता है, ताकि कोई भी अंक बिना नाम के न रह जाए।',
  },
  'targets.needDate': {
    en: 'Please write the day, month and year they said it.',
    hi: 'कृपया वह दिन, महीना और साल लिखें जब उन्होंने यह कहा।',
  },
  'targets.dateFuture': { en: 'That day has not come yet.', hi: 'वह दिन अभी आया ही नहीं है।' },
  'targets.removeTitle': { en: 'Remove this range?', hi: 'यह दायरा हटाएँ?' },
  'targets.removeMessage': {
    en: 'Charts will stop showing a target for this until a doctor gives you numbers again. Nothing you have recorded is deleted.',
    hi: 'जब तक डॉक्टर दोबारा अंक न दें, चार्ट पर इसका कोई दायरा नहीं दिखेगा। आपका लिखा हुआ कुछ भी नहीं मिटेगा।',
  },
  'targets.saveFailed': { en: 'Could not save this range.', hi: 'यह दायरा सहेजा नहीं जा सका।' },
  'targets.removeFailed': { en: 'Could not remove this range.', hi: 'यह दायरा हटाया नहीं जा सका।' },
};

/** Exact context equality, matching the rule `target_range` itself uses. */
function sameContext(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (a === null || b === null) return a === b;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => bKeys[index] === key && a[key] === b[key]);
}

function findForSlot(targets: readonly TargetRange[], slot: Slot): TargetRange | null {
  return (
    targets.find(
      (target) =>
        target.metricKey === slot.metricKey &&
        target.field === slot.field &&
        sameContext(target.context, slot.context),
    ) ?? null
  );
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function two(value: number): string {
  return String(value).padStart(2, '0');
}

export default function TargetsScreen() {
  const t = useT(STRINGS);
  const { formatDate } = useDateFormat();
  const toast = useToast();
  const confirm = useConfirm();
  const profileState = useProfileId();
  const profileId = profileState.data;

  const [editing, setEditing] = useState<Slot | null>(null);

  const state = useAsync(async () => {
    if (!profileId) return [] as TargetRange[];
    return listTargets(profileId);
  }, [profileId]);

  const { reload } = state;
  useReloadOnFocus(reload);

  const targets = useMemo(() => state.data ?? [], [state.data]);

  const remove = useCallback(
    async (target: TargetRange) => {
      const ok = await confirm({
        title: t('targets.removeTitle'),
        message: t('targets.removeMessage'),
        confirmLabel: t('common.remove'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteTarget(target.id);
        reload();
      } catch (error) {
        console.warn('[targets] could not remove a target', error);
        toast.show({ message: t('targets.removeFailed'), variant: 'error' });
      }
    },
    [confirm, t, toast, reload],
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('targets.title')}
        subtitle={t('targets.subtitle')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        <Banner variant="info" title={t('targets.title')} message={t('targets.appNeverSupplies')} />

        {state.loading && !state.data ? (
          <>
            <Skeleton height={120} label={t('a11y.loading')} />
            <Skeleton height={120} />
          </>
        ) : null}

        {state.error ? (
          <Banner
            variant="attention"
            title={t('errors.loadFailed')}
            message={state.error.message}
            actionLabel={t('common.retry')}
            onAction={reload}
          />
        ) : null}

        {/* Eight cards fixed at module scope — a bounded render, not a query result. */}
        {state.data
          ? SLOTS.map((slot) => {
              const target = findForSlot(targets, slot);
              const unit = metricUnit(null, slot.metricKey);
              const title = t('targets.pairPattern', {
                metric: t(slot.metricKeyI18n),
                field: t(slot.fieldKeyI18n),
              });

              return (
                <Card key={slot.id}>
                  <View style={{ gap: spacing.md }}>
                    <Text variant="label">{title}</Text>

                    {target ? (
                      <>
                        <Text variant="title">
                          {target.low !== null && target.high !== null
                            ? t('targets.between', { low: target.low, high: target.high, unit })
                            : target.low !== null
                              ? t('targets.atLeast', { low: target.low, unit })
                              : t('targets.atMost', { high: target.high ?? '', unit })}
                        </Text>
                        <Text variant="caption" tone="muted">
                          {targetFootnote(t, target, formatDate) ?? ''}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: spacing.md }}>
                          <Button
                            title={t('common.change')}
                            onPress={() => setEditing(slot)}
                            variant="secondary"
                            size="md"
                            style={{ flex: 1 }}
                          />
                          <Button
                            title={t('common.remove')}
                            onPress={() => void remove(target)}
                            variant="destructive"
                            size="md"
                            style={{ flex: 1 }}
                          />
                        </View>
                      </>
                    ) : (
                      <>
                        {/* Deliberately a WORD, not a greyed-out example range. */}
                        <Text variant="body" tone="muted">
                          {t('targets.notSet')}
                        </Text>
                        <Button
                          title={t('targets.add')}
                          onPress={() => setEditing(slot)}
                          variant="secondary"
                          size="md"
                          fullWidth
                        />
                      </>
                    )}
                  </View>
                </Card>
              );
            })
          : null}
      </View>

      {editing && profileId ? (
        <TargetEditor
          // Keyed on the slot so switching cards remounts the form with empty boxes
          // rather than carrying the previous card's numbers across.
          key={editing.id}
          slot={editing}
          profileId={profileId}
          existing={findForSlot(targets, editing)}
          title={t('targets.pairPattern', {
            metric: t(editing.metricKeyI18n),
            field: t(editing.fieldKeyI18n),
          })}
          unit={metricUnit(null, editing.metricKey)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

function TargetEditor({
  slot,
  profileId,
  existing,
  title,
  unit,
  onClose,
  onSaved,
}: {
  slot: Slot;
  profileId: string;
  existing: TargetRange | null;
  title: string;
  unit: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(STRINGS);
  const toast = useToast();

  // Seeded ONLY from a row a human already wrote. A new target opens with four empty
  // boxes, and that is the entire point of this screen.
  const [low, setLow] = useState(existing?.low === null || existing === null ? '' : String(existing.low));
  const [high, setHigh] = useState(
    existing?.high === null || existing === null ? '' : String(existing.high),
  );
  const [setBy, setSetBy] = useState(existing?.setByLabel ?? '');
  const [day, setDay] = useState(existing ? existing.setOn.slice(8, 10) : '');
  const [month, setMonth] = useState(existing ? existing.setOn.slice(5, 7) : '');
  const [year, setYear] = useState(existing ? existing.setOn.slice(0, 4) : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fillToday = useCallback(() => {
    const today = toLocalDate();
    setYear(today.slice(0, 4));
    setMonth(today.slice(5, 7));
    setDay(today.slice(8, 10));
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    const lowValue = parseDecimal(low);
    const highValue = parseDecimal(high);

    if (low.trim() !== '' && lowValue === null) return setError(t('errors.invalidNumber'));
    if (high.trim() !== '' && highValue === null) return setError(t('errors.invalidNumber'));
    if (lowValue === null && highValue === null) return setError(t('targets.needNumber'));
    if (lowValue !== null && highValue !== null && lowValue > highValue) {
      return setError(t('targets.lowAboveHigh'));
    }

    const name = setBy.trim();
    if (!name) return setError(t('targets.needName'));

    const dayValue = Number(day.trim());
    const monthValue = Number(month.trim());
    const yearValue = Number(year.trim());
    const monthLength = DAYS_IN_MONTH[monthValue - 1];
    if (
      !Number.isInteger(dayValue) ||
      !Number.isInteger(monthValue) ||
      !Number.isInteger(yearValue) ||
      monthValue < 1 ||
      monthValue > 12 ||
      monthLength === undefined ||
      dayValue < 1 ||
      dayValue > monthLength ||
      yearValue < 1900 ||
      yearValue > 2400
    ) {
      return setError(t('targets.needDate'));
    }
    const setOn = `${yearValue}-${two(monthValue)}-${two(dayValue)}`;
    // A doctor cannot have set a target on a day that has not happened. Catching it here
    // keeps a mistyped year out of every chart legend this target will ever appear in.
    if (setOn > toLocalDate()) return setError(t('targets.dateFuture'));

    setSaving(true);
    try {
      if (existing) {
        await updateTarget(existing.id, {
          low: lowValue,
          high: highValue,
          setByLabel: name,
          setOn,
        });
      } else {
        await setTarget({
          profileId,
          metricKey: slot.metricKey,
          field: slot.field,
          context: slot.context,
          low: lowValue,
          high: highValue,
          setByLabel: name,
          setOn,
        });
      }
      toast.show({ message: t('common.saved'), variant: 'success' });
      onSaved();
    } catch (e) {
      console.warn('[targets] could not save a target', e);
      toast.show({ message: t('targets.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
    return undefined;
  }, [saving, low, high, setBy, day, month, year, existing, profileId, slot, t, toast, onSaved]);

  return (
    <Dialog
      visible
      title={title}
      message={t('targets.subtitle')}
      onRequestClose={onClose}
      footer={
        <View style={{ gap: spacing.md }}>
          <Button title={t('common.cancel')} onPress={onClose} variant="secondary" size="lg" fullWidth />
          <Button title={t('common.save')} onPress={() => void save()} loading={saving} size="lg" fullWidth />
        </View>
      }
    >
      <View style={{ gap: spacing.lg }}>
        <TextField
          label={`${t('targets.low')} (${unit})`}
          helper={t('targets.oneIsEnough')}
          value={low}
          onChangeText={setLow}
          keyboardType="decimal-pad"
          maxLength={6}
        />
        <TextField
          label={`${t('targets.high')} (${unit})`}
          value={high}
          onChangeText={setHigh}
          keyboardType="decimal-pad"
          maxLength={6}
        />
        <TextField
          label={t('targets.setBy')}
          helper={t('targets.setByHelper')}
          value={setBy}
          onChangeText={setSetBy}
          autoCapitalize="words"
          required
        />

        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('targets.setOn')}</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <TextField
              label={t('targets.day')}
              value={day}
              onChangeText={setDay}
              keyboardType="number-pad"
              maxLength={2}
              containerStyle={{ flex: 1 }}
            />
            <TextField
              label={t('targets.month')}
              value={month}
              onChangeText={setMonth}
              keyboardType="number-pad"
              maxLength={2}
              containerStyle={{ flex: 1 }}
            />
            <TextField
              label={t('targets.year')}
              value={year}
              onChangeText={setYear}
              keyboardType="number-pad"
              maxLength={4}
              containerStyle={{ flex: 1.4 }}
            />
          </View>
          <Button
            title={t('targets.useToday')}
            onPress={fillToday}
            variant="ghost"
            size="md"
            fullWidth
          />
        </View>

        {error ? (
          <Text variant="body" tone="destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}
