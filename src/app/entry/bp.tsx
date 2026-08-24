/**
 * Recording a blood pressure.
 *
 * THE ORDER IS PAD → READ-BACK → WRITE, AND IT IS NOT NEGOTIABLE. Nothing on this screen
 * touches the database until `ReadBackDialog`'s `onSave` fires. There is no "saved, tap
 * to undo": by the time an undo toast is on screen the wrong number has already been seen
 * by the chart, the streak and any report she prints in the next twenty minutes.
 *
 * The soft plausibility check sits BETWEEN the pad and the read-back and is a
 * "did you mean?" only. Confirming it writes the value completely unchanged — an
 * unusual blood pressure is the one a doctor would act on first, and an app that
 * quietly refused it would have deleted the most important row it will ever hold.
 * The only hard stop is `InstrumentBoundsError`, which means no cuff on earth could
 * have produced the number; that one keeps her digits on screen and asks her to look.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { spacing } from '@/theme';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  NumberPad,
  ReadBackDialog,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
  type NumberPadField,
} from '@/components/ui';
import { ActiveProfileTag } from '@/app/profiles/_lib';
import {
  METRIC_BP,
  META_BP_STICKY,
  ensureRegistrySeeded,
  getMetaJson,
  parseDecimal,
  resolveProfileId,
  setMetaJson,
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
  'entry.bp.contextTitle': { en: 'How did you measure it?', hi: 'आपने कैसे नापा?' },
  'entry.bp.arm': { en: 'Which arm?', hi: 'कौन सा हाथ?' },
  'entry.bp.armLeft': { en: 'Left arm', hi: 'बायाँ हाथ' },
  'entry.bp.armRight': { en: 'Right arm', hi: 'दायाँ हाथ' },
  'entry.bp.posture': { en: 'Sitting or lying down?', hi: 'बैठकर या लेटकर?' },
  'entry.bp.postureSitting': { en: 'Sitting', hi: 'बैठकर' },
  'entry.bp.postureLying': { en: 'Lying down', hi: 'लेटकर' },
  'entry.bp.changeContext': { en: 'Tap to change this', hi: 'बदलने के लिए दबाएँ' },
  'entry.bp.padInstruction': {
    en: 'Type the upper number first, then press Next.',
    hi: 'पहले ऊपर वाला नंबर लिखें, फिर आगे दबाएँ।',
  },
};

type Arm = 'left' | 'right';
type Posture = 'sitting' | 'lying';
type BpContext = { arm: Arm; posture: Posture };

/** Stored keyed by profile, so a future second profile cannot inherit her arm. */
type StickyStore = Record<string, BpContext>;

const ARMS: readonly Arm[] = ['left', 'right'];
const POSTURES: readonly Posture[] = ['sitting', 'lying'];

function isArm(value: unknown): value is Arm {
  return value === 'left' || value === 'right';
}

function isPosture(value: unknown): value is Posture {
  return value === 'sitting' || value === 'lying';
}

type Setup = {
  profileId: string;
  metric: MetricDef;
  sticky: BpContext | null;
  store: StickyStore;
};

export default function BpEntryScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const when = useEntryWhen();

  const setup = useAsync<Setup>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) throw new Error('No profile is set up on this device yet.');

    let metric = await getMetricDef(METRIC_BP);
    if (!metric) {
      // A cold install can reach an entry tile before anything seeded the registry.
      // Seeding once and retrying is cheaper than a crash on the screen she came here for.
      await ensureRegistrySeeded();
      metric = await getMetricDef(METRIC_BP);
    }
    if (!metric) throw new Error('The blood pressure metric is missing from the registry.');

    const store = (await getMetaJson<StickyStore>(META_BP_STICKY)) ?? {};
    const stored = store[profileId];
    const sticky: BpContext | null =
      stored && isArm(stored.arm) && isPosture(stored.posture)
        ? { arm: stored.arm, posture: stored.posture }
        : null;
    return { profileId, metric, sticky, store };
  }, []);

  const [arm, setArm] = useState<Arm | null>(null);
  const [posture, setPosture] = useState<Posture | null>(null);
  const [step, setStep] = useState<'context' | 'numbers'>('context');
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

  // Last time's arm and posture come back prefilled, and when they do the pad is what
  // she lands on — one tap saved on every reading for the rest of the year. With nothing
  // stored yet she chooses once, explicitly, before any number is typed.
  //
  // Derived during render rather than in an effect: the seeding is a pure function of the
  // loaded row, and doing it here means the context step is never briefly rendered before
  // being replaced. Seeded once and only once — a later reload can never overwrite the arm
  // she has since changed by hand.
  const [seeded, setSeeded] = useState(false);
  const sticky = setup.data?.sticky ?? null;
  if (!seeded && setup.data) {
    setSeeded(true);
    if (sticky) {
      setArm(sticky.arm);
      setPosture(sticky.posture);
      setStep('numbers');
    }
  }

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
      // An open Dialog owns the hardware back button itself (RN's Modal intercepts it),
      // so this only ever fires for the screen underneath.
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        void guardedBack();
        return true;
      });
      return () => subscription.remove();
    }, [guardedBack]),
  );

  const readings = {
    v1: parseDecimal(values['systolic']),
    v2: parseDecimal(values['diastolic']),
    v3: parseDecimal(values['pulse']),
  };

  const handleSubmit = useCallback(
    (submitted: Record<string, string>) => {
      const metric = setup.data?.metric;
      if (!metric) return;
      setValues(submitted);
      setBoundsMessage(null);

      const candidate = {
        v1: parseDecimal(submitted['systolic']),
        v2: parseDecimal(submitted['diastolic']),
        v3: parseDecimal(submitted['pulse']),
      };
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

  const labelForSlot = useCallback(
    (slot: 'v1' | 'v2' | 'v3'): string =>
      slot === 'v1'
        ? t('entry.bp.systolic')
        : slot === 'v2'
          ? t('entry.bp.diastolic')
          : t('entry.bp.pulse'),
    [t],
  );

  const save = useCallback(async () => {
    const data = setup.data;
    if (!data || !arm || !posture) return;
    if (readings.v1 === null || readings.v2 === null) return;

    setSaving(true);
    try {
      await createReading({
        profileId: data.profileId,
        metricKey: METRIC_BP,
        values: { v1: readings.v1, v2: readings.v2, v3: readings.v3 },
        context: { arm, posture },
        atEpoch: when.atEpoch,
        source: 'manual',
      });

      // Remembering the arm must never be able to fail the reading that is already
      // written, so this is fire-and-forget with its own catch.
      void setMetaJson(META_BP_STICKY, { ...data.store, [data.profileId]: { arm, posture } }).catch(
        (error: unknown) => console.warn('[entry/bp] could not remember the arm and posture', error),
      );

      if (!alive.current) return;
      setShowReadBack(false);
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      leave();
    } catch (error: unknown) {
      if (!alive.current) return;
      setShowReadBack(false);
      if (error instanceof InstrumentBoundsError) {
        setBoundsMessage(instrumentBoundsMessage(t, error, labelForSlot(error.slot)));
      } else {
        toast.show({ message: t('entry.common.saveFailed'), variant: 'error' });
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [setup.data, arm, posture, readings.v1, readings.v2, readings.v3, when.atEpoch, toast, t, leave, labelForSlot]);

  // ── Loading / unusable registry ────────────────────────────────────────────
  if (setup.loading) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.bp.title')} onBack={leave} />
        <Skeleton height={120} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (setup.error || !setup.data) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.bp.title')} onBack={leave} />
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

  const readBack =
    readings.v3 === null
      ? t('entry.bp.readBackNoPulse', {
          systolic: readings.v1 === null ? '' : trimNumber(readings.v1),
          diastolic: readings.v2 === null ? '' : trimNumber(readings.v2),
        })
      : t('entry.bp.readBack', {
          systolic: readings.v1 === null ? '' : trimNumber(readings.v1),
          diastolic: readings.v2 === null ? '' : trimNumber(readings.v2),
          pulse: trimNumber(readings.v3),
        });

  // ── Step 1: arm and posture ───────────────────────────────────────────────
  if (step === 'context') {
    return (
      <Screen
        variant="scroll"
        footer={
          <Button
            title={t('common.continue')}
            onPress={() => setStep('numbers')}
            variant="primary"
            size="xl"
            fullWidth
            disabled={!arm || !posture}
          />
        }
      >
        <ScreenHeader
          title={t('entry.bp.title')}
          subtitle={t('entry.bp.helper')}
          onBack={guardedBack}
        />
        {/* Whose reading this is — the active profile is a device-global pointer a carer can
            have switched, and a BP filed onto the wrong patient is a medical error. Shown on
            the first step of the flow, before any number is entered. No-ops when solo. */}
        <ActiveProfileTag />
        <EntryWhenBar when={when} />

        <Text variant="label" style={{ paddingTop: spacing.lg, paddingBottom: spacing.md }}>
          {t('entry.bp.arm')}
        </Text>
        <View style={{ gap: spacing.md }}>
          {ARMS.map((option) => (
            <Chip
              key={option}
              label={option === 'left' ? t('entry.bp.armLeft') : t('entry.bp.armRight')}
              selected={arm === option}
              onPress={() => setArm(option)}
              selectionMode="single"
              grow
            />
          ))}
        </View>

        <Text variant="label" style={{ paddingTop: spacing.xl, paddingBottom: spacing.md }}>
          {t('entry.bp.posture')}
        </Text>
        <View style={{ gap: spacing.md }}>
          {POSTURES.map((option) => (
            <Chip
              key={option}
              label={option === 'sitting' ? t('entry.bp.postureSitting') : t('entry.bp.postureLying')}
              selected={posture === option}
              onPress={() => setPosture(option)}
              selectionMode="single"
              grow
            />
          ))}
        </View>
      </Screen>
    );
  }

  // ── Step 2: the numbers ───────────────────────────────────────────────────
  const fields: NumberPadField[] = [
    { key: 'systolic', label: t('entry.bp.systolic'), maxDigits: 3 },
    { key: 'diastolic', label: t('entry.bp.diastolic'), maxDigits: 3 },
    { key: 'pulse', label: t('entry.bp.pulse'), maxDigits: 3, optional: true },
  ];

  return (
    <Screen variant="fixed">
      <ScreenHeader title={t('entry.bp.title')} onBack={guardedBack} />

      <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
        <EntryWhenBar when={when} />

        {boundsMessage ? (
          <Banner variant="attention" title={t('entry.bounds.title')} message={boundsMessage} />
        ) : null}

        {/* What will be recorded, in words, above the pad — and still tappable, so a
            wrong arm is fixed before the number is typed rather than after it is filed. */}
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <Chip
            label={arm === 'right' ? t('entry.bp.armRight') : t('entry.bp.armLeft')}
            selected
            onPress={() => setStep('context')}
            accessibilityHint={t('entry.bp.changeContext')}
            grow
          />
          <Chip
            label={posture === 'lying' ? t('entry.bp.postureLying') : t('entry.bp.postureSitting')}
            selected
            onPress={() => setStep('context')}
            accessibilityHint={t('entry.bp.changeContext')}
            grow
          />
        </View>
      </View>

      {/* The pad stays mounted behind every dialog on this screen. Unmounting it would
          throw away what she typed the moment a read-back is closed. */}
      <NumberPad
        fields={fields}
        initialValues={values}
        instruction={t('entry.bp.padInstruction')}
        onSubmit={handleSubmit}
      />

      <PlausibilityDialog
        visible={showCheck}
        warnings={warnings}
        labelFor={(warning) => labelForSlot(warning.slot)}
        onCorrect={() => setShowCheck(false)}
        onConfirm={() => {
          setShowCheck(false);
          setShowReadBack(true);
        }}
      />

      <ReadBackDialog
        visible={showReadBack}
        readBack={readBack}
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
