/**
 * Recording how she is feeling.
 *
 * THREE TAPS: a symptom, how strong it is, and Save. Everything else on this screen is
 * optional and stays out of the way until it is asked for.
 *
 * Two decisions worth stating:
 *
 *  • SEVERITY DOES NOT BLOCK THE SAVE. The column is nullable and the screen keeps it
 *    that way. A recorded symptom with no severity is worth a great deal more to the
 *    doctor reading the OPD sheet than a symptom she abandoned because the app would not
 *    let her past a question she did not want to answer.
 *
 *  • THE READ-BACK IS STILL MANDATORY. This row is printed on the report a doctor reads,
 *    and "Strong chest discomfort" recorded when she meant "mild" is a consultation that
 *    goes somewhere else. Confirmation before the write, never a toast after it.
 *
 * ── WHAT WAS WRONG WITH THIS SCREEN, AND IT WAS WORSE THAN REPORTED ──────────────
 *
 * The report was "there should be an option to select vomiting as well". There already
 * was one — `nausea_vomiting`, "Feeling sick or vomiting" — and she could not see it,
 * because this screen asked the registry for EVERY symptom in the app, sorted globally,
 * and then took the first twelve. That merged chip ranked fourteenth.
 *
 * The same slice hid something far more serious. Every pack-specific symptom sorts after
 * every base symptom, so NO pack symptom had ever been reachable in any build ever
 * shipped. On an active TB course that means "blood in the sputum", "yellow eyes" and
 * "dark urine" — the three the TB pack exists to offer, and the ones a doctor asks about
 * by name — could not be recorded at all.
 *
 * So three things changed together:
 *
 *   1. `listSymptomDefsForProfile()` replaces `listSymptomDefs()`. It returns the base
 *      symptoms plus the symptoms of the packs this profile actually has switched on, and
 *      it excludes retired keys. `listSymptomDefs()` is the REGISTRY read and still
 *      returns retired keys on purpose — five other screens and the OPD report use it to
 *      resolve what a recorded event SAYS, and filtering there would print the raw string
 *      `nausea_vomiting` on a doctor's page.
 *
 *   2. THE SLICE IS GONE AND NOTHING REPLACED IT. Not a fold either: every chip this
 *      profile can record is on the screen. `listSymptomDefsForProfile` has no limit
 *      parameter and nobody may add one. The list is long — twenty-six rows on a profile
 *      carrying three condition packs — and that is the correct trade, because the whole
 *      defect here was a symptom the app knew about and she could not reach.
 *
 *   3. `nausea` and `vomiting` are now separate chips (migration v4 + the seed). On
 *      isoniazid and rifampicin the two observations do different work, and one merged
 *      chip means the record cannot tell them apart afterwards. The old key was RETIRED,
 *      never relabelled — labels are resolved from `symptom_def` at read time, so
 *      relabelling would have rewritten what she recorded in July on the page her doctor
 *      reads in September.
 *
 * ── THE ORDER OF THE CHIPS ───────────────────────────────────────────────────────
 *
 * She also asked for the ones she picks most to sit at the top. The list is now 26 rows
 * on her profile, so that request is real — but a list that re-sorts itself destroys the
 * muscle memory that makes it fast for someone with a tremor at 1.3x font scale. See
 * `src/features/frequency` for the whole argument. In short: a few clearly-dominant chips
 * are PINNED into a band at the top, in the canonical clinical order rather than in count
 * order, and everything else stays exactly where it has always been. The order is
 * computed ONCE, inside the setup block below, and never again while the screen is open.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { useI18n } from '@/i18n';
import { spacing } from '@/theme';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ReadBackDialog,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  ensureRegistrySeeded,
  resolveProfileId,
  useAsync,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { BASE_SYMPTOMS } from '@/db/seed';
import {
  countSymptomUsage,
  listSymptomDefsForProfile,
  logSymptom,
  type Severity,
} from '@/db/repositories/symptoms';
import { pinMostUsed } from '@/features/frequency';
import { addDays, toLocalDate } from '@/lib/datetime';

import { ENTRY_COMMON_STRINGS, EntryWhenBar, useEntryWhen } from './backfill';

const STRINGS: LocalStrings = {
  ...ENTRY_COMMON_STRINGS,
  'entry.symptom.changeChoice': { en: 'Choose something else', hi: 'कुछ और चुनें' },
  'entry.symptom.severityOptional': {
    en: 'You can leave this and still save.',
    hi: 'इसे छोड़कर भी सेव कर सकती हैं।',
  },
  'entry.symptom.mostRecorded': {
    en: 'What You Record Most Often',
    hi: 'जो आप सबसे ज़्यादा दर्ज करती हैं',
  },
  'entry.symptom.everythingElse': { en: 'Everything Else', hi: 'बाकी सब' },
};

/** The custom-text chip is a sentinel, never a symptom key. */
const OTHER = '__other__';

/**
 * Usage is counted over the last quarter, not over all time.
 *
 * A six-month TB course changes what a person records: the cough of month one is not the
 * joint pain of month five. A lifetime count would keep month one pinned to the top of
 * the screen until the course ended. A quarter is long enough to accumulate a real count
 * and short enough to be about now.
 */
const USAGE_WINDOW_DAYS = 90;

type SymptomOption = { key: string; labelEn: string; labelHi: string };

type Setup = {
  profileId: string;
  /** A small band of clearly-dominant chips, in canonical order. Often empty. */
  pinned: SymptomOption[];
  /** Everything else, in the canonical clinical order. */
  rest: SymptomOption[];
};

const SEVERITIES: readonly Severity[] = ['mild', 'moderate', 'severe'];

export default function SymptomEntryScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const when = useEntryWhen();

  const setup = useAsync<Setup>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) throw new Error('No profile is set up on this device yet.');

    let defs = await listSymptomDefsForProfile(profileId);
    if (defs.length === 0) {
      await ensureRegistrySeeded();
      defs = await listSymptomDefsForProfile(profileId);
    }

    // The seed is the fallback rather than an empty screen: the chips are the whole
    // interaction, and a registry that has not been written yet must not be able to turn
    // this into a screen with nothing to tap.
    //
    // It is BASE-ONLY by necessity, and that is a real limitation worth naming: pack
    // membership lives in `pack_symptom`, so a fallback assembled without the database
    // cannot know this profile is on the TB pack. It is the degraded path for a broken
    // registry, not a second implementation of the chip list.
    const options: SymptomOption[] =
      defs.length > 0
        ? defs.map((def) => ({ key: def.key, labelEn: def.labelEn, labelHi: def.labelHi }))
        : BASE_SYMPTOMS.filter((seed) => seed.retiredAtEpoch === undefined).map((seed) => ({
            key: seed.key,
            labelEn: seed.labelEn,
            labelHi: seed.labelHi,
          }));

    // Counted from `symptom_event` rather than kept in a counter column, and used for
    // NOTHING but the order of the chips. It never reaches a report or an export: "she
    // tapped this nine times" is not a clinical observation about anyone.
    const usage = await countSymptomUsage(profileId, {
      sinceDate: addDays(toLocalDate(), -USAGE_WINDOW_DAYS),
    });

    const ordered = pinMostUsed(
      options,
      (option) => option.key,
      usage.map((row) => ({ key: row.symptomKey, count: row.count })),
    );
    return { profileId, pinned: [...ordered.pinned], rest: [...ordered.rest] };
  }, []);

  const [choice, setChoice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [customLabel, setCustomLabel] = useState('');
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [showReadBack, setShowReadBack] = useState(false);
  const [saving, setSaving] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pinned = useMemo(() => setup.data?.pinned ?? [], [setup.data]);
  const rest = useMemo(() => setup.data?.rest ?? [], [setup.data]);
  /** Only for resolving a key back to its labels. Never rendered in this order. */
  const allOptions = useMemo(() => [...pinned, ...rest], [pinned, rest]);

  const labelFor = useCallback(
    (option: SymptomOption): string => (lang === 'hi' ? option.labelHi : option.labelEn),
    [lang],
  );

  const chosenOption = allOptions.find((option) => option.key === choice) ?? null;
  const trimmedCustom = customLabel.trim();
  const isOther = choice === OTHER;
  const canSave = isOther ? trimmedCustom.length > 0 : chosenOption !== null;

  const symptomName = isOther ? trimmedCustom : chosenOption ? labelFor(chosenOption) : '';

  const dirty = choice !== null || trimmedCustom.length > 0 || note.trim().length > 0;

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

  const pick = useCallback((key: string) => {
    setChoice(key);
    // Folding the list down is what makes this three taps: severity and Save land on
    // screen together instead of twenty-six rows below the one she just chose.
    setExpanded(false);
  }, []);

  const save = useCallback(async () => {
    const data = setup.data;
    if (!data || !canSave) return;

    setSaving(true);
    try {
      const common = {
        profileId: data.profileId,
        severity,
        note: note.trim().length > 0 ? note.trim() : null,
        // Undefined means "now"; a backfilled symptom carries the epoch the backfill
        // screen chose, never a fabricated one.
        at: when.atEpoch === undefined ? undefined : new Date(when.atEpoch),
      };
      // Exactly one identity reaches the repository — it refuses both and neither.
      if (isOther) await logSymptom({ ...common, customLabel: trimmedCustom });
      else if (chosenOption) await logSymptom({ ...common, symptomKey: chosenOption.key });
      else return;
      if (!alive.current) return;
      setShowReadBack(false);
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      leave();
    } catch (error: unknown) {
      console.warn('[entry/symptom] could not record the symptom', error);
      if (!alive.current) return;
      setShowReadBack(false);
      toast.show({ message: t('entry.common.saveFailed'), variant: 'error' });
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [
    setup.data,
    canSave,
    severity,
    note,
    when.atEpoch,
    isOther,
    trimmedCustom,
    chosenOption,
    toast,
    t,
    leave,
  ]);

  if (setup.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('entry.symptom.title')} onBack={leave} />
        <Skeleton height={160} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (setup.error || !setup.data) {
    return (
      <Screen>
        <ScreenHeader title={t('entry.symptom.title')} onBack={leave} />
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

  const readBack = severity
    ? t('entry.symptom.readBack', {
        symptom: symptomName,
        severity: t(`entry.symptom.severity.${severity}`),
      })
    : t('entry.symptom.readBackNoSeverity', { symptom: symptomName });

  const showList = expanded || choice === null;

  const renderChip = (option: SymptomOption) => (
    <Chip
      key={option.key}
      label={labelFor(option)}
      selected={choice === option.key}
      onPress={() => pick(option.key)}
      selectionMode="single"
      grow
    />
  );

  return (
    <Screen
      footer={
        <Button
          title={t('common.save')}
          onPress={() => setShowReadBack(true)}
          variant="primary"
          size="xl"
          fullWidth
          disabled={!canSave}
        />
      }
    >
      <ScreenHeader title={t('entry.symptom.title')} onBack={guardedBack} />
      <EntryWhenBar when={when} />

      <Text variant="label" style={{ paddingTop: spacing.lg, paddingBottom: spacing.md }}>
        {t('entry.symptom.whichSymptom')}
      </Text>

      <View style={{ gap: spacing.md }}>
        {showList ? (
          <>
            {/* The band renders only when something genuinely dominates. On a new phone,
                and on any phone where her taps are spread evenly, there is no band and no
                heading — the screen is exactly the canonical list. */}
            {pinned.length > 0 ? (
              <>
                <Text variant="caption" tone="muted">
                  {t('entry.symptom.mostRecorded')}
                </Text>
                {pinned.map(renderChip)}
                <Divider style={{ marginVertical: spacing.sm }} />
                <Text variant="caption" tone="muted">
                  {t('entry.symptom.everythingElse')}
                </Text>
              </>
            ) : null}

            {/* EVERY CHIP IS ON THE SCREEN. There is no fold and no "show more", and that
                is a deliberate reversal of the first attempt at this fix: a fold at eight
                rows would have put "Vomiting" — the chip she wrote in to ask for — behind
                a tap, which is the reported bug again in a softer form. The list is long
                on a profile with three condition packs, and the cost of that length is a
                scroll before her FIRST tap only: the band above puts what she actually
                records within reach on every later visit, and the whole list folds down to
                her choice the moment she makes one. */}
            {rest.map(renderChip)}

            <Divider style={{ marginVertical: spacing.sm }} />
            <Chip
              label={t('entry.symptom.other')}
              selected={isOther}
              onPress={() => pick(OTHER)}
              selectionMode="single"
              grow
            />
          </>
        ) : (
          <>
            <Chip
              label={
                isOther
                  ? t('entry.symptom.other')
                  : chosenOption
                    ? labelFor(chosenOption)
                    : t('common.unknown')
              }
              selected
              onPress={() => setExpanded(true)}
              accessibilityHint={t('entry.symptom.changeChoice')}
              grow
            />
            <Button
              title={t('entry.symptom.changeChoice')}
              onPress={() => setExpanded(true)}
              variant="ghost"
              size="md"
            />
          </>
        )}
      </View>

      {isOther ? (
        <View style={{ paddingTop: spacing.lg }}>
          <TextField
            label={t('entry.symptom.otherLabel')}
            value={customLabel}
            onChangeText={setCustomLabel}
            required
            autoFocus
          />
        </View>
      ) : null}

      <Text variant="label" style={{ paddingTop: spacing.xl, paddingBottom: spacing.sm }}>
        {t('entry.symptom.severity.label')}
      </Text>
      <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.md }}>
        {t('entry.symptom.severityOptional')}
      </Text>
      {/* SEVERITY IS NEVER REORDERED BY USE. mild → moderate → severe is an ordinal
          scale: the order IS the information, and sorting it by how often each was
          picked would turn a scale into a jumble. Same rule as the dose slots, the
          quantity chips and the report periods. */}
      <View style={{ gap: spacing.md }}>
        {SEVERITIES.map((option) => (
          <Chip
            key={option}
            label={t(`entry.symptom.severity.${option}`)}
            selected={severity === option}
            // Tapping the chosen severity again clears it — severity is optional, so
            // there has to be a way back out of an answer given by mistake.
            onPress={() => setSeverity((current) => (current === option ? null : option))}
            selectionMode="single"
            grow
          />
        ))}
      </View>

      <View style={{ paddingTop: spacing.xl, gap: spacing.md }}>
        {noteOpen ? (
          <TextField
            label={t('entry.common.note')}
            value={note}
            onChangeText={setNote}
            placeholder={t('entry.common.notePlaceholder')}
            multiline
          />
        ) : (
          <Button
            title={t('entry.common.addNote')}
            onPress={() => setNoteOpen(true)}
            variant="secondary"
            size="md"
            icon="plus"
          />
        )}
      </View>

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
