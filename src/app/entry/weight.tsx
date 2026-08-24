/**
 * Recording a weight.
 *
 * The simplest of the four entry screens, and it follows the same rule as the other
 * three: pad → read-back → write. The read-back is not skipped because the screen is
 * simple — a transposed 65.2 into 52.6 looks entirely ordinary on a chart, and weight is
 * one of the trends a TB or cardiac review actually turns on.
 *
 * The unit is a fixed "kg". There is no unit control, here or anywhere else in the app.
 *
 * ── WHERE THE UNIT IS PRINTED, AND WHY IT MOVED ─────────────────────────────────
 *
 * It used to live in a sentence under the pad: "Type your weight in kilograms." Her note
 * was "instead of that hint, just show Kgs after the text", and she is right — a unit
 * belongs next to the number it qualifies, where it is read as part of the value, not in
 * a line of prose that has to be read separately and then remembered.
 *
 * So the sentence no longer names the unit, and the unit is drawn immediately AFTER the
 * digits — on the caption line inside the value tile, in the same box, where it reads as
 * part of the value rather than as a separate thing to remember.
 *
 * GETTING IT THERE TOOK A FIX ONE LAYER DOWN, and it is worth knowing why. `NumberPad`
 * has always taken a `unit` per field and always rendered it — but only on a field that
 * was NOT the active one, because the active field's caption line was spent on the word
 * "Typing here now". A single-field pad's only field is always the active one, so on
 * this screen and on the sugar screen that unit had never once been drawn, silently, and
 * both screens compensated by appending "(kg)" / "(mg/dL)" to the tile's LABEL instead.
 * `NumberPad` now gives the caption line to the unit whenever there is exactly one field
 * — the word has nothing to disambiguate on a single-tile pad — and both labels are
 * plain again. If that branch is ever removed, the unit disappears from both screens
 * rather than moving, so the labels would have to take it back on the same commit.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { spacing } from '@/theme';
import {
  Banner,
  EmptyState,
  NumberPad,
  ReadBackDialog,
  Screen,
  ScreenHeader,
  Skeleton,
  useConfirm,
  useToast,
  type NumberPadField,
} from '@/components/ui';
import {
  METRIC_WEIGHT,
  ensureRegistrySeeded,
  parseDecimal,
  resolveProfileId,
  trimNumber,
  useAsync,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { getMetricDef } from '@/db/repositories/metrics';
import {
  InstrumentBoundsError,
  createReading,
  shouldPromptPlausibility,
  type PlausibilityWarning,
} from '@/db/repositories/readings';
import type { MetricDef } from '@/types';

import {
  ENTRY_COMMON_STRINGS,
  EntryWhenBar,
  PlausibilityDialog,
  instrumentBoundsMessage,
  useEntryWhen,
} from './backfill';

const STRINGS: LocalStrings = {
  ...ENTRY_COMMON_STRINGS,
  // The unit is deliberately absent from this sentence — it is printed beside the number
  // instead. See the header.
  'entry.weight.padInstruction': {
    en: 'Type the number the scale shows.',
    hi: 'तराज़ू पर जो नंबर दिख रहा है, वही लिखें।',
  },
};

type Setup = { profileId: string; metric: MetricDef };

export default function WeightEntryScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const when = useEntryWhen();

  const setup = useAsync<Setup>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) throw new Error('No profile is set up on this device yet.');

    let metric = await getMetricDef(METRIC_WEIGHT);
    if (!metric) {
      await ensureRegistrySeeded();
      metric = await getMetricDef(METRIC_WEIGHT);
    }
    if (!metric) throw new Error('The weight metric is missing from the registry.');
    return { profileId, metric };
  }, []);

  const [values, setValues] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<PlausibilityWarning[]>([]);
  const [showCheck, setShowCheck] = useState(false);
  const [showReadBack, setShowReadBack] = useState(false);
  const [saving, setSaving] = useState(false);
  const [boundsMessage, setBoundsMessage] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const value = parseDecimal(values['value']);
  const dirty = Object.keys(values).length > 0;

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const guardedBack = useCallback(async () => {
    if (!dirty) {
      leave();
      return;
    }
    const go = await confirm({
      title: t('entry.common.discardTitle'),
      message: t('entry.common.discardMessage'),
      confirmLabel: t('entry.common.discardConfirm'),
    });
    if (go) leave();
  }, [dirty, confirm, t, leave]);

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        void guardedBack();
        return true;
      });
      return () => subscription.remove();
    }, [guardedBack]),
  );

  const handleSubmit = useCallback(
    (submitted: Record<string, string>) => {
      const metric = setup.data?.metric;
      if (!metric) return;
      setValues(submitted);
      setBoundsMessage(null);

      const candidate = { v1: parseDecimal(submitted['value']), v2: null, v3: null };
      const found = shouldPromptPlausibility(metric, candidate, 'exact');
      if (found.length > 0) {
        setWarnings(found);
        setShowCheck(true);
        return;
      }
      setShowReadBack(true);
    },
    [setup.data],
  );

  const save = useCallback(async () => {
    const data = setup.data;
    if (!data || value === null) return;

    setSaving(true);
    try {
      await createReading({
        profileId: data.profileId,
        metricKey: METRIC_WEIGHT,
        values: { v1: value, v2: null, v3: null },
        atEpoch: when.atEpoch,
        source: 'manual',
      });
      if (!alive.current) return;
      setShowReadBack(false);
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      leave();
    } catch (error: unknown) {
      if (!alive.current) return;
      setShowReadBack(false);
      if (error instanceof InstrumentBoundsError) {
        setBoundsMessage(instrumentBoundsMessage(t, error, t('entry.weight.value')));
      } else {
        toast.show({ message: t('entry.common.saveFailed'), variant: 'error' });
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [setup.data, value, when.atEpoch, toast, t, leave]);

  if (setup.loading) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.weight.title')} onBack={leave} />
        <Skeleton height={120} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (setup.error || !setup.data) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.weight.title')} onBack={leave} />
        <EmptyState
          title={t('errors.loadFailed')}
          message={t('errors.unexpected')}
          icon="alert"
          actionLabel={t('common.retry')}
          onAction={setup.reload}
        />
      </Screen>
    );
  }

  const fields: NumberPadField[] = [
    {
      key: 'value',
      // The label is a plain "Weight" again. `unit` below is now genuinely drawn, on the
      // caption line immediately BELOW the digits inside the same tile — see the comment
      // on that line in `NumberPad.tsx`. It used to be appended here as "(kg)" only
      // because a single-field pad spent that line on the word "Typing here now" and so
      // never drew the unit at all; that is fixed, and carrying it in both places would
      // now print the unit twice.
      label: t('entry.weight.value'),
      unit: t('entry.weight.unit'),
      maxDigits: 3,
      allowDecimal: true,
    },
  ];

  return (
    <Screen variant="fixed">
      <ScreenHeader
        title={t('entry.weight.title')}
        subtitle={t('entry.weight.helper')}
        onBack={guardedBack}
      />

      <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
        <EntryWhenBar when={when} />
        {boundsMessage ? (
          <Banner variant="attention" title={t('entry.bounds.title')} message={boundsMessage} />
        ) : null}
      </View>

      <NumberPad
        fields={fields}
        initialValues={values}
        instruction={t('entry.weight.padInstruction')}
        onSubmit={handleSubmit}
      />

      <PlausibilityDialog
        visible={showCheck}
        warnings={warnings}
        labelFor={() => t('entry.weight.value')}
        onCorrect={() => setShowCheck(false)}
        onConfirm={() => {
          setShowCheck(false);
          setShowReadBack(true);
        }}
      />

      <ReadBackDialog
        visible={showReadBack}
        readBack={t('entry.weight.readBack', { value: value === null ? '' : trimNumber(value) })}
        detail={when.readBackDetail}
        saving={saving}
        onCorrect={() => setShowReadBack(false)}
        onSave={() => {
          void save();
        }}
      />
    </Screen>
  );
}
