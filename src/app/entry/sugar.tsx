/**
 * Recording a blood sugar.
 *
 * TWO DECISIONS THAT ARE SAFETY DECISIONS, NOT LAYOUT PREFERENCES:
 *
 *  1. THE UNIT IS A FIXED LABEL, NEVER A PICKER. India runs on mg/dL. A unit control is
 *     one accidental tap away from filing 6.2 mmol/L as 6.2 mg/dL — a number that is
 *     simultaneously catastrophic and completely plausible-looking in a chart.
 *
 *  2. THE CONTEXT IS CHOSEN BEFORE THE NUMBER. "110" means nothing on its own; fasting
 *     and two-hours-after-a-meal are different measurements, and the target rows a doctor
 *     writes down are matched on exactly this field. Asking afterwards invites "whatever
 *     is already selected", so the pad does not exist until she has answered.
 *
 * As everywhere else in this folder: pad → read-back → write, and the write is downstream
 * of `ReadBackDialog`'s `onSave` and nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * LO AND HI ARE INEQUALITIES, NOT MISSING VALUES
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * She asked for "an option to add the exact sugar reading from the device, not just high
 * or low — you can set default values for high and low to create a trend graph."
 *
 * The exact number already worked. What did not work is the second half, and the literal
 * version of it is refused: writing a made-up number into `reading.v1` so a LO can be
 * plotted would put a value the meter never produced into the same column as every value
 * it did produce. From that moment it is indistinguishable from a measurement — to the
 * CSV, to the OPD table, to any future average, and to any doctor's own spreadsheet.
 * Qualifier columns get dropped downstream; value columns do not. `createReading` refuses
 * it, and so does a database trigger, so this is not a rule that can be forgotten.
 *
 * What she actually wants is served exactly by recording the INEQUALITY. A glucometer
 * printing LO has not failed — it has asserted `glucose < 20 mg/dL`, the bottom of what
 * it can quantify, and that is frequently the loudest fact in the whole record. So:
 *
 *   • `value_qualifier` says which way, as it always did.
 *   • `qualifier_bound` says what it was measured against — derived by the repository
 *     from the meter a human recorded, never typed here, never guessed.
 *   • The read-back says the inequality out loud before anything is written: "Meter
 *     showed LO — recorded as below 20 mg/dL." She is never read back a number that
 *     looks like her reading.
 *   • With no meter recorded the reading still saves, and the read-back says "below what
 *     your meter can measure". A null bound is a complete record, not a degraded one.
 *
 * SAVING IS NEVER GATED ON THE METER BEING RECORDED. A hypoglycaemic emergency must not
 * sit behind a settings question. The write happens first; the question comes after, once,
 * as an offer.
 *
 * ── THE LO/HI BUTTONS EXIST ON BOTH STEPS, AND THAT IS THE POINT ────────────────────
 *
 * They used to live only on step 1. Step 2 is where she is standing with the meter in her
 * hand, and from step 2 the only way back was the context chip — the header's back button
 * leaves the screen and offers to discard. So the affordance was, in practice, unreachable
 * at the exact moment it was needed, which is a good way for a LO to get typed in as a
 * guessed number. Step 2 now carries it in the header, opening the same two buttons.
 *
 * ── WHAT WAS REMOVED: `sugar_low_threshold` ────────────────────────────────────────
 *
 * This screen used to read `app_meta.sugar_low_threshold`, defaulting to a hardcoded 70,
 * and open a follow-up sheet titled "This is below the number set in Settings." Three
 * things were wrong with that. Nothing ever WROTE the key, so the value was always the
 * hardcoded one. There was no Settings screen for it, so the title named a place that did
 * not exist. And a shipped 70 is an anonymous, undated, unattributable clinical threshold
 * — precisely what `scripts/check-clinical-language.js` rule 3 exists to forbid; it slipped
 * through only because the underscore in `DEFAULT_LOW_THRESHOLD` broke the word boundary.
 *
 * The follow-up survives, driven by facts the app actually has:
 *
 *   • the METER said LO or HI — an observation from the device, always available; or
 *   • the value fell outside a target A NAMED HUMAN entered, and the sheet prints that
 *     person's name and the date they said it.
 *
 * With neither, there is no sheet, because the app has no opinion to offer. Both ends are
 * treated alike now: a HI on this patient is as worth a second look as a LO, and offering
 * the same neutral follow-up states no verdict either way.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';

import { type TranslateFn } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import {
  Banner,
  Button,
  Chip,
  Dialog,
  Divider,
  EmptyState,
  NumberPad,
  ReadBackDialog,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
  type NumberPadField,
} from '@/components/ui';
import {
  METRIC_SUGAR,
  SUGAR_CONTEXTS,
  SUGAR_CONTEXT_KEY,
  ensureRegistrySeeded,
  parseDecimal,
  rangeFor,
  resolveProfileId,
  targetFootnote,
  trimNumber,
  useAsync,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { GLUCOMETERS, type GlucometerSeed } from '@/db/seed';
import { getMetricDef } from '@/db/repositories/metrics';
import {
  InstrumentBoundsError,
  applyRecordedBoundToPastReadings,
  createReading,
  listReadings,
  shouldPromptPlausibility,
  type PlausibilityWarning,
} from '@/db/repositories/readings';
import {
  boundForQualifier,
  clearInstrumentRange,
  getInstrumentRange,
  setInstrumentRange,
  type InstrumentRange,
} from '@/db/repositories/settings';
import { getTarget } from '@/db/repositories/targets';
import { toLocalDate } from '@/lib/datetime';
import type { MetricDef, ValueQualifier } from '@/types';

import {
  ENTRY_COMMON_STRINGS,
  EntryWhenBar,
  PlausibilityDialog,
  instrumentBoundsMessage,
  useEntryWhen,
} from './backfill';

const STRINGS: LocalStrings = {
  ...ENTRY_COMMON_STRINGS,
  'entry.sugar.changeContext': { en: 'Tap to change this', hi: 'बदलने के लिए दबाएँ' },
  'entry.sugar.meterWord': {
    en: 'If the meter showed a word instead of a number',
    hi: 'अगर मशीन पर नंबर की जगह कोई शब्द दिखा हो',
  },
  // A statement about the INSTRUMENT, not about her. It says what the machine can and
  // cannot do; it does not say anything about what the reading means.
  'entry.sugar.meterWordExplain': {
    en: 'LO means the sugar was below what your meter can measure. HI means it was above.',
    hi: 'LO का मतलब — शुगर मशीन की नाप से नीचे थी। HI का मतलब — मशीन की नाप से ऊपर थी।',
  },
  'entry.sugar.meterWordShort': { en: 'LO or HI', hi: 'LO या HI' },
  'entry.sugar.meterWordHint': {
    en: 'For a meter that showed a word instead of a number.',
    hi: 'जब मशीन पर नंबर की जगह कोई शब्द दिखा हो।',
  },
  'entry.sugar.padInstruction': {
    en: 'Type the number exactly as the meter shows it.',
    hi: 'मशीन पर जो नंबर दिख रहा है, ठीक वही लिखें।',
  },

  // ── The inequality, said out loud before anything is written ────────────────
  'entry.sugar.readBackQualifier': {
    en: '{{qualifier}} — recorded as {{inequality}}, {{context}}',
    hi: '{{qualifier}} — {{inequality}} के रूप में दर्ज होगा, {{context}}',
  },
  'entry.sugar.boundBelow': { en: 'below {{bound}} mg/dL', hi: '{{bound}} mg/dL से नीचे' },
  'entry.sugar.boundAbove': { en: 'above {{bound}} mg/dL', hi: '{{bound}} mg/dL से ऊपर' },
  'entry.sugar.boundUnknownBelow': {
    en: 'below what your meter can measure',
    hi: 'आपकी मशीन की नाप से नीचे',
  },
  'entry.sugar.boundUnknownAbove': {
    en: 'above what your meter can measure',
    hi: 'आपकी मशीन की नाप से ऊपर',
  },

  // ── The follow-up sheet ────────────────────────────────────────────────────
  'entry.sugar.watch.meterTitle': {
    en: 'The Meter Did Not Give A Number',
    hi: 'मशीन ने कोई नंबर नहीं दिया',
  },
  'entry.sugar.watch.targetTitle': {
    en: 'Outside Your Target Range',
    hi: 'आपके लक्ष्य से बाहर',
  },
  'entry.sugar.watch.message': {
    en: 'Your reading is saved exactly as you entered it. If you would like, you can write down how you are feeling right now, or record another reading after a while.',
    hi: 'आपकी रीडिंग जैसी लिखी थी, वैसी ही सेव हो गई है। चाहें तो अभी अपनी तबीयत लिख सकती हैं, या थोड़ी देर बाद एक और रीडिंग दर्ज कर सकती हैं।',
  },
  'entry.sugar.watch.recordFeeling': { en: 'Record how you feel', hi: 'तबीयत दर्ज करें' },
  'entry.sugar.watch.recordLater': {
    en: 'Record another reading in a while',
    hi: 'थोड़ी देर बाद एक और रीडिंग',
  },
  'entry.sugar.watch.laterToast': {
    en: 'Open Aarogya again whenever you want to record it.',
    hi: 'जब भी दर्ज करना हो, आरोग्य फिर से खोल लें।',
  },
  'entry.sugar.watch.noMeter': {
    en: 'Aarogya does not know yet what LO and HI mean on your meter, so this reading cannot be drawn on the graph. Recording your meter is what lets it appear.',
    hi: 'आरोग्य अभी नहीं जानता कि आपकी मशीन पर LO और HI का क्या मतलब है, इसलिए यह रीडिंग ग्राफ़ पर नहीं दिखाई जा सकती। मशीन दर्ज करने पर यह दिखने लगेगी।',
  },

  // ── The meter ──────────────────────────────────────────────────────────────
  'entry.sugar.meter.title': { en: 'Your Glucometer', hi: 'आपकी शुगर मशीन' },
  'entry.sugar.meter.open': { en: 'Your Glucometer', hi: 'आपकी शुगर मशीन' },
  'entry.sugar.meter.why': {
    en: 'When the meter shows LO or HI it has not given a number. Writing down which meter you use lets Aarogya record what LO and HI mean on that meter, and show those readings on the graph.',
    hi: 'जब मशीन LO या HI दिखाती है तो वह कोई नंबर नहीं देती। आप कौन सी मशीन इस्तेमाल करती हैं यह लिख देने पर आरोग्य दर्ज कर सकेगा कि उस मशीन पर LO और HI का क्या मतलब है, और वे रीडिंग ग्राफ़ पर दिखा सकेगा।',
  },
  'entry.sugar.meter.which': { en: 'Which meter do you use?', hi: 'आप कौन सी मशीन इस्तेमाल करती हैं?' },
  'entry.sugar.meter.dontKnow': { en: 'I Do Not Know', hi: 'मुझे नहीं पता' },
  'entry.sugar.meter.dontKnowNote': {
    en: 'That is a complete answer. Your LO and HI readings are still saved; they will say the meter could not give a number, without a figure beside it.',
    hi: 'यह भी पूरा जवाब है। आपकी LO और HI रीडिंग फिर भी सेव रहेंगी; उनमें लिखा रहेगा कि मशीन कोई नंबर नहीं दे पाई, बिना कोई अंक लिखे।',
  },
  'entry.sugar.meter.rangeLine': {
    en: 'Shows LO under {{low}} mg/dL and HI over {{high}} mg/dL',
    hi: '{{low}} mg/dL से नीचे LO और {{high}} mg/dL से ऊपर HI दिखाती है',
  },
  'entry.sugar.meter.checkTheBox': {
    en: 'Please check this against the back of your meter or its booklet before you save it.',
    hi: 'सेव करने से पहले इसे अपनी मशीन के पीछे या उसकी किताब से एक बार मिला लें।',
  },
  'entry.sugar.meter.setBy': { en: 'Who is writing this down?', hi: 'यह कौन लिख रहा है?' },
  'entry.sugar.meter.setByHelper': {
    en: 'Your own name, or the name of whoever is helping you.',
    hi: 'आपका अपना नाम, या जो आपकी मदद कर रहे हैं उनका नाम।',
  },
  'entry.sugar.meter.recorded': { en: 'Recorded: {{label}}', hi: 'दर्ज है: {{label}}' },
  'entry.sugar.meter.none': { en: 'No meter recorded yet', hi: 'अभी कोई मशीन दर्ज नहीं है' },
  'entry.sugar.meter.needMeter': {
    en: 'Please choose a meter, or choose "I Do Not Know".',
    hi: 'कृपया कोई मशीन चुनें, या “मुझे नहीं पता” चुनें।',
  },
  'entry.sugar.meter.needName': {
    en: 'Please write who is recording this.',
    hi: 'कृपया लिखें कि यह कौन दर्ज कर रहा है।',
  },
  'entry.sugar.meter.saveFailed': {
    en: 'Could not save the meter. Please try again.',
    hi: 'मशीन सेव नहीं हो पाई। कृपया फिर से कोशिश करें।',
  },
  'entry.sugar.meter.past.title': {
    en: 'Were Your Earlier Readings On This Meter?',
    hi: 'क्या पहले की रीडिंग इसी मशीन पर ली थीं?',
  },
  'entry.sugar.meter.past.message': {
    en: '{{count}} earlier readings say the meter showed LO or HI, with no figure beside them. If those were taken on this same meter, its range can be written against them too. Nothing you recorded changes.',
    hi: 'पहले की {{count}} रीडिंग में लिखा है कि मशीन ने LO या HI दिखाया, पर उनके साथ कोई अंक नहीं है। अगर वे इसी मशीन पर ली गई थीं, तो उनके साथ भी इसकी नाप लिखी जा सकती है। आपकी दर्ज की हुई कोई बात नहीं बदलेगी।',
  },
  'entry.sugar.meter.past.confirm': { en: 'Yes, the same meter', hi: 'हाँ, यही मशीन' },
  'entry.sugar.meter.past.done': {
    en: '{{count}} earlier readings can now be drawn on the graph.',
    hi: 'पहले की {{count}} रीडिंग अब ग्राफ़ पर दिखाई जा सकेंगी।',
  },
};

type Setup = {
  profileId: string;
  metric: MetricDef;
};

export default function SugarEntryScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const when = useEntryWhen();
  const { formatDate } = useDateFormat();

  const setup = useAsync<Setup>(async () => {
    const profileId = await resolveProfileId();
    if (!profileId) throw new Error('No profile is set up on this device yet.');

    let metric = await getMetricDef(METRIC_SUGAR);
    if (!metric) {
      await ensureRegistrySeeded();
      metric = await getMetricDef(METRIC_SUGAR);
    }
    if (!metric) throw new Error('The blood sugar metric is missing from the registry.');
    return { profileId, metric };
  }, []);

  // Loaded separately from the metric so that recording a meter mid-flow can refresh it
  // on its own, without re-running the registry read or clearing anything she has typed.
  const meterState = useAsync<InstrumentRange | null>(
    () => getInstrumentRange(METRIC_SUGAR),
    [],
  );
  const meter = meterState.data;

  const [context, setContext] = useState<string | null>(null);
  const [step, setStep] = useState<'context' | 'numbers'>('context');
  const [values, setValues] = useState<Record<string, string>>({});
  const [qualifier, setQualifier] = useState<ValueQualifier>('exact');
  /**
   * The bound that WILL be written, read at the moment she chooses LO or HI.
   *
   * Read through `boundForQualifier` — the same function `createReading` uses — rather
   * than picked off `meter` here, so the sentence in the read-back and the number in the
   * database can never come from two different rules.
   */
  const [pendingBound, setPendingBound] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<PlausibilityWarning[]>([]);
  const [showCheck, setShowCheck] = useState(false);
  const [showReadBack, setShowReadBack] = useState(false);
  const [showQualifierSheet, setShowQualifierSheet] = useState(false);
  const [watch, setWatch] = useState<WatchReason | null>(null);
  const [meterOpen, setMeterOpen] = useState(false);
  /**
   * The follow-up sheet, put down while the meter is being recorded and picked back up
   * afterwards.
   *
   * Without this the meter offer is a trap door: she taps it from the sheet, records her
   * meter, and lands back on an entry screen whose reading is already saved, with the
   * "record how you feel" offer gone and no obvious way out. The reading is safe either
   * way — this is about not stranding her.
   *
   * A ref rather than state: nothing renders from it, and it is written and read inside
   * the same handler chain, so making it state would only add a render.
   */
  const pausedWatch = useRef<WatchReason | null>(null);
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
  const dirty = context !== null || Object.keys(values).length > 0;

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

  const contextLabel = useCallback(
    (candidate: string | null): string => {
      const match = SUGAR_CONTEXTS.find((option) => option.value === candidate);
      return match ? t(match.i18nKey) : t('common.unknown');
    },
    [t],
  );

  const handleSubmit = useCallback(
    (submitted: Record<string, string>) => {
      const metric = setup.data?.metric;
      if (!metric) return;
      setValues(submitted);
      setQualifier('exact');
      setPendingBound(null);
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

  /**
   * LO / HI: the meter never gave us a number, so there is nothing to type or to
   * second-guess. What there IS is an inequality, and the bound behind it is fetched here
   * so the read-back can state it before the write rather than after.
   */
  const chooseQualifier = useCallback(async (next: ValueQualifier) => {
    setValues({});
    setQualifier(next);
    setBoundsMessage(null);
    setShowQualifierSheet(false);
    let bound: number | null = null;
    try {
      bound = await boundForQualifier(METRIC_SUGAR, next);
    } catch (error: unknown) {
      // A meter we cannot read is a bound we do not have, which is a supported state.
      // It must never stand between her and recording a LO.
      console.warn('[entry/sugar] could not read the recorded meter range', error);
    }
    if (!alive.current) return;
    setPendingBound(bound);
    setShowReadBack(true);
  }, []);

  /**
   * What, if anything, to offer after the write — and it is offered only when the app has
   * a FACT to hang it on. See the header: there is no shipped threshold any more.
   */
  const decideWatch = useCallback(
    async (profileId: string, chosenContext: string): Promise<WatchReason | null> => {
      if (qualifier !== 'exact') return { kind: 'meter', footnote: undefined };
      if (value === null) return null;
      try {
        const target = await getTarget(profileId, METRIC_SUGAR, {
          [SUGAR_CONTEXT_KEY]: chosenContext,
        });
        const where = rangeFor(target, value);
        if (where !== 'below' && where !== 'above') return null;
        return { kind: 'target', footnote: targetFootnote(t, target, formatDate) };
      } catch (error: unknown) {
        // The reading is already safely written. A failure to look up a target is not
        // worth an error message — it just means no follow-up is offered.
        console.warn('[entry/sugar] could not read the target range', error);
        return null;
      }
    },
    [qualifier, value, t, formatDate],
  );

  const save = useCallback(async () => {
    const data = setup.data;
    if (!data || !context) return;
    if (qualifier === 'exact' && value === null) return;

    setSaving(true);
    try {
      await createReading({
        profileId: data.profileId,
        metricKey: METRIC_SUGAR,
        // A censored reading carries NO value. `createReading` and a database trigger
        // both refuse the other combination; passing null here is not belt-and-braces,
        // it is the only shape that will be accepted.
        values: { v1: qualifier === 'exact' ? value : null, v2: null, v3: null },
        valueQualifier: qualifier,
        context: { [SUGAR_CONTEXT_KEY]: context },
        atEpoch: when.atEpoch,
        source: 'manual',
      });

      if (!alive.current) return;
      setShowReadBack(false);

      const reason = await decideWatch(data.profileId, context);
      if (!alive.current) return;
      if (reason) {
        // The saved toast is deliberately held back until the sheet closes: a toast
        // raised now renders BEHIND the dialog and she would never see it.
        setWatch(reason);
        return;
      }
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      leave();
    } catch (error: unknown) {
      if (!alive.current) return;
      setShowReadBack(false);
      if (error instanceof InstrumentBoundsError) {
        setBoundsMessage(instrumentBoundsMessage(t, error, t('entry.sugar.value')));
      } else {
        toast.show({ message: t('entry.common.saveFailed'), variant: 'error' });
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [setup.data, context, qualifier, value, when.atEpoch, decideWatch, toast, t, leave]);

  const closeWatch = useCallback(
    (destination: 'symptom' | 'later' | 'close') => {
      setWatch(null);
      if (destination === 'later') {
        toast.show({ message: t('entry.sugar.watch.laterToast'), variant: 'info' });
      } else {
        toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      }
      if (destination === 'symptom') {
        router.replace('/entry/symptom');
        return;
      }
      leave();
    },
    [toast, t, leave],
  );

  /**
   * After a meter is recorded, offer to attach its range to LO/HI readings saved before
   * anyone had told the app what meter she uses.
   *
   * THE QUESTION IS ASKED IN WORDS AND SHE ANSWERS IT. `applyRecordedBoundToPastReadings`
   * transcribes a human's answer; calling it without asking would be the app inventing a
   * fact about a device. Only rows with no bound are ever touched, so a reading carrying
   * an older meter's range keeps it.
   */
  const offerPastReadings = useCallback(
    async (profileId: string) => {
      try {
        // A count rather than a blind call, so the question is only asked when there is
        // something to apply it to. `listReadings` is capped; if she somehow has more
        // recent readings than the cap, the older LO/HI rows simply go unoffered this
        // time — the operation is idempotent and the offer comes round again.
        const recent = await listReadings(profileId, METRIC_SUGAR, {});
        const pending = recent.filter(
          (reading) => reading.valueQualifier !== 'exact' && reading.qualifierBound === null,
        ).length;
        if (pending === 0) return;

        const yes = await confirm({
          title: t('entry.sugar.meter.past.title'),
          message: t('entry.sugar.meter.past.message', { count: pending }),
          confirmLabel: t('entry.sugar.meter.past.confirm'),
          cancelLabel: t('common.notNow'),
        });
        if (!yes) return;

        const updated = await applyRecordedBoundToPastReadings(profileId, METRIC_SUGAR);
        if (!alive.current || updated === 0) return;
        toast.show({
          message: t('entry.sugar.meter.past.done', { count: updated }),
          variant: 'success',
        });
      } catch (error: unknown) {
        console.warn('[entry/sugar] could not update earlier readings', error);
      }
    },
    [confirm, t, toast],
  );

  /** Picks the follow-up sheet back up if recording the meter interrupted one. */
  const resumeWatch = useCallback(() => {
    const paused = pausedWatch.current;
    pausedWatch.current = null;
    if (paused) setWatch(paused);
  }, []);

  const closeMeter = useCallback(() => {
    setMeterOpen(false);
    resumeWatch();
  }, [resumeWatch]);

  const onMeterSaved = useCallback(async () => {
    setMeterOpen(false);
    meterState.reload();
    // If she is mid-entry on a LO or HI, the sentence she is about to confirm has just
    // changed from "below what your meter can measure" to a real inequality. Re-read it
    // rather than leaving a stale sentence in front of a pending write.
    if (qualifier !== 'exact') {
      try {
        const bound = await boundForQualifier(METRIC_SUGAR, qualifier);
        if (alive.current) setPendingBound(bound);
      } catch {
        // Leaving the sentence as it was is the safe failure: it under-claims.
      }
    }
    const profileId = setup.data?.profileId;
    // Awaited before the sheet comes back so the two dialogs never stack.
    if (profileId) await offerPastReadings(profileId);
    if (alive.current) resumeWatch();
  }, [meterState, qualifier, setup.data, offerPastReadings, resumeWatch]);

  // ── Loading / unusable registry ────────────────────────────────────────────
  if (setup.loading) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.sugar.title')} onBack={leave} />
        <Skeleton height={120} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (setup.error || !setup.data) {
    return (
      <Screen variant="fixed">
        <ScreenHeader title={t('entry.sugar.title')} onBack={leave} />
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
    qualifier === 'exact'
      ? t('entry.sugar.readBack', {
          value: value === null ? '' : trimNumber(value),
          context: contextLabel(context),
        })
      : t('entry.sugar.readBackQualifier', {
          qualifier:
            qualifier === 'below_range' ? t('reading.qualifierLow') : t('reading.qualifierHigh'),
          inequality: inequalityText(t, qualifier, pendingBound),
          context: contextLabel(context),
        });

  /** The two buttons, shared by step 1's section and step 2's sheet. */
  const qualifierButtons = (
    <View style={{ gap: spacing.md }}>
      <Button
        title={t('reading.qualifierLow')}
        onPress={() => void chooseQualifier('below_range')}
        variant="secondary"
        size="lg"
        fullWidth
        disabled={!context}
      />
      <Button
        title={t('reading.qualifierHigh')}
        onPress={() => void chooseQualifier('above_range')}
        variant="secondary"
        size="lg"
        fullWidth
        disabled={!context}
      />
    </View>
  );

  const meterLine = meter
    ? t('entry.sugar.meter.recorded', { label: meter.label })
    : t('entry.sugar.meter.none');

  const meterButton = (
    <View style={{ gap: spacing.sm }}>
      <Text variant="caption" tone="muted">
        {meterLine}
      </Text>
      <Button
        title={t('entry.sugar.meter.open')}
        onPress={() => {
          // Step 2 reaches this from inside the LO/HI sheet. Closing that first keeps one
          // modal on screen at a time — stacked Modals are a way to lose a dialog behind
          // another one on Android, with no way back to it.
          setShowQualifierSheet(false);
          setMeterOpen(true);
        }}
        variant="ghost"
        size="md"
        fullWidth
      />
    </View>
  );

  const readBackDialog = (
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
  );

  // Mounted only while it is open, so the title cannot flip to the other reason's wording
  // for a frame as the sheet fades out.
  const watchSheet = watch ? (
    <Dialog
      visible
      title={
        watch.kind === 'meter'
          ? t('entry.sugar.watch.meterTitle')
          : t('entry.sugar.watch.targetTitle')
      }
      message={t('entry.sugar.watch.message')}
      dismissOnBackdrop={false}
      onRequestClose={() => closeWatch('close')}
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('entry.sugar.watch.recordFeeling')}
            onPress={() => closeWatch('symptom')}
            variant="primary"
            size="lg"
            fullWidth
          />
          <Button
            title={t('entry.sugar.watch.recordLater')}
            onPress={() => closeWatch('later')}
            variant="secondary"
            size="lg"
            fullWidth
          />
          <Button
            title={t('common.close')}
            onPress={() => closeWatch('close')}
            variant="ghost"
            size="md"
            fullWidth
          />
        </View>
      }
    >
      {/* The provenance of a target is never optional: a comparison the app draws has to
          say whose number it was drawn against and when they gave it. */}
      {watch.footnote ? (
        <Text variant="caption" tone="muted">
          {watch.footnote}
        </Text>
      ) : null}

      {/* The meter offer lives in the BODY, not the footer, so the three actions she is
          most likely to want stay where they were. It appears only when the app genuinely
          cannot draw this reading — never as a nag. */}
      {watch.kind === 'meter' && !meter ? (
        <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
          <Divider />
          <Text variant="caption" tone="muted">
            {t('entry.sugar.watch.noMeter')}
          </Text>
          <Button
            title={t('entry.sugar.meter.open')}
            onPress={() => {
              pausedWatch.current = watch;
              setWatch(null);
              setMeterOpen(true);
            }}
            variant="ghost"
            size="md"
            fullWidth
          />
        </View>
      ) : null}
    </Dialog>
  ) : null;

  const meterDialog = meterOpen ? (
    <MeterDialog
      existing={meter}
      t={t}
      onClose={closeMeter}
      onSaved={() => {
        void onMeterSaved();
      }}
    />
  ) : null;

  // ── Step 1: when was it measured ──────────────────────────────────────────
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
            disabled={!context}
          />
        }
      >
        <ScreenHeader
          title={t('entry.sugar.title')}
          subtitle={t('entry.sugar.helper')}
          onBack={guardedBack}
        />
        <EntryWhenBar when={when} />

        <Text variant="label" style={{ paddingTop: spacing.lg, paddingBottom: spacing.md }}>
          {t('entry.sugar.context.label')}
        </Text>
        {/* THE CONTEXTS ARE NEVER REORDERED BY USE. Empty stomach → before a meal → two
            hours after → at bedtime → some other time is a sequence through a day, and
            "some other time" means "none of the above" and has to stay last or it starts
            catching taps that belong to a real context. The context is also the field a
            doctor's target row is matched on, so a mis-tap here is a comparison drawn
            against the wrong target. */}
        <View style={{ gap: spacing.md }}>
          {SUGAR_CONTEXTS.map((option) => (
            <Chip
              key={option.value}
              label={t(option.i18nKey)}
              selected={context === option.value}
              onPress={() => setContext(option.value)}
              selectionMode="single"
              grow
            />
          ))}
        </View>

        <Divider style={{ marginTop: spacing.xl }} />

        <Text variant="body" tone="muted" style={{ paddingTop: spacing.lg, paddingBottom: spacing.sm }}>
          {t('entry.sugar.meterWord')}
        </Text>
        <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.md }}>
          {t('entry.sugar.meterWordExplain')}
        </Text>
        {qualifierButtons}

        <View style={{ paddingTop: spacing.lg }}>{meterButton}</View>

        {readBackDialog}
        {watchSheet}
        {meterDialog}
      </Screen>
    );
  }

  // ── Step 2: the number ────────────────────────────────────────────────────
  const fields: NumberPadField[] = [
    {
      key: 'value',
      // mg/dL is drawn inside the value tile on the caption line immediately BELOW the
      // digits — see the comment on that line in `NumberPad.tsx`. It used to sit in a
      // separate row beside the context chip, where it read as a caption on the chip;
      // her note was that the unit belongs with the number, and she is right. It then
      // spent a while appended to this label as "(mg/dL)", because a single-field pad
      // never drew `unit`; that is fixed, so the label is plain again and the unit is
      // where she actually reads it.
      //
      // THE UNIT IS A LABEL AND THERE MUST NEVER BE A CONTROL HERE. See the top of the
      // file: 6.2 mmol/L filed as 6.2 mg/dL is catastrophic and looks entirely ordinary.
      label: t('entry.sugar.value'),
      unit: t('entry.sugar.unit'),
      maxDigits: 3,
    },
  ];

  return (
    <Screen variant="fixed">
      <ScreenHeader
        title={t('entry.sugar.title')}
        onBack={guardedBack}
        // In the header rather than under the pad on purpose. This step must not grow: it
        // already fills a small handset in large-text mode, and pushing the keypad off the
        // bottom to add a button is the trade that loses.
        right={
          <Button
            title={t('entry.sugar.meterWordShort')}
            accessibilityHint={t('entry.sugar.meterWordHint')}
            onPress={() => setShowQualifierSheet(true)}
            variant="secondary"
            size="md"
          />
        }
      />

      <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
        <EntryWhenBar when={when} />

        {boundsMessage ? (
          <Banner variant="attention" title={t('entry.bounds.title')} message={boundsMessage} />
        ) : null}

        <Chip
          label={contextLabel(context)}
          selected
          onPress={() => setStep('context')}
          accessibilityHint={t('entry.sugar.changeContext')}
          grow
        />
      </View>

      <NumberPad
        fields={fields}
        initialValues={values}
        instruction={t('entry.sugar.padInstruction')}
        onSubmit={handleSubmit}
      />

      <Dialog
        visible={showQualifierSheet}
        title={t('entry.sugar.meterWord')}
        message={t('entry.sugar.meterWordExplain')}
        onRequestClose={() => setShowQualifierSheet(false)}
        footer={
          <View style={{ gap: spacing.md }}>
            {qualifierButtons}
            <Button
              title={t('common.cancel')}
              onPress={() => setShowQualifierSheet(false)}
              variant="ghost"
              size="md"
              fullWidth
            />
          </View>
        }
      >
        {meterButton}
      </Dialog>

      <PlausibilityDialog
        visible={showCheck}
        warnings={warnings}
        labelFor={() => t('entry.sugar.value')}
        onCorrect={() => setShowCheck(false)}
        onConfirm={() => {
          setShowCheck(false);
          setShowReadBack(true);
        }}
      />

      {readBackDialog}
      {watchSheet}
      {meterDialog}
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The follow-up sheet's reason
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Why the sheet is being shown. There is no third member and there must not be one that
 * means "because of a number the app decided on" — see the file header.
 */
type WatchReason =
  /** The meter itself printed a word. An observation from the device. */
  | { kind: 'meter'; footnote: string | undefined }
  /** Outside a range a named human wrote down, and the footnote says who and when. */
  | { kind: 'target'; footnote: string | undefined };

/** 'below 20 mg/dL', or the honest sentence when no meter has been recorded. */
function inequalityText(
  t: TranslateFn,
  qualifier: ValueQualifier,
  bound: number | null,
): string {
  const below = qualifier === 'below_range';
  if (bound === null) {
    return below ? t('entry.sugar.boundUnknownBelow') : t('entry.sugar.boundUnknownAbove');
  }
  return below
    ? t('entry.sugar.boundBelow', { bound: trimNumber(bound) })
    : t('entry.sugar.boundAbove', { bound: trimNumber(bound) });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Recording which meter she owns
// ═══════════════════════════════════════════════════════════════════════════════

/** The "I don't know" chip is a sentinel, never a meter key. */
const DONT_KNOW = '__dont_know__';

/**
 * A fact about a device on her table, entered by a human, with that human's name on it.
 *
 * NOTHING IS PRESELECTED and nothing is inferred. The list is a convenience for someone
 * who is about to check the box her meter came in — the range is always shown back before
 * it can be saved, for exactly that reason. "I Do Not Know" is a first-class answer that
 * stores nothing, because a LO with no bound is a complete record.
 *
 * `setOn` is today, without a date picker, and that is not the same shortcut targets take.
 * A target is a thing a doctor said on some earlier day, so its date has to be asked for.
 * This is a thing she is telling the app right now, so the date it was written down IS
 * today, and inventing a form field for it would only create a way to get it wrong.
 *
 * MOUNTED ONLY WHILE IT IS OPEN, so its four pieces of state come from `useState`
 * initialisers and are thrown away on close. Keeping it mounted behind a `visible` flag
 * would need an effect to re-seed the form every time it reopened — an effect that writes
 * state during render is both a lint error here and the way a dialog ends up showing what
 * was on file two minutes ago.
 */
function MeterDialog({
  existing,
  t,
  onClose,
  onSaved,
}: {
  existing: InstrumentRange | null;
  t: TranslateFn;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();

  const [chosen, setChosen] = useState<string | null>(() => {
    if (!existing) return null;
    const match = GLUCOMETERS.find((option) => option.label === existing.label);
    return match ? match.key : null;
  });
  const [setBy, setSetBy] = useState(existing?.setByLabel ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected: GlucometerSeed | null =
    chosen === null || chosen === DONT_KNOW
      ? null
      : (GLUCOMETERS.find((option) => option.key === chosen) ?? null);

  const save = useCallback(async () => {
    if (saving) return;
    if (chosen === null) {
      setError(t('entry.sugar.meter.needMeter'));
      return;
    }

    setSaving(true);
    try {
      if (chosen === DONT_KNOW) {
        // Not an error and not a half-answer: it withdraws the range and leaves every
        // reading exactly as it was recorded, bound and all.
        await clearInstrumentRange(METRIC_SUGAR);
        toast.show({ message: t('common.saved'), variant: 'success' });
        onSaved();
        return;
      }

      const name = setBy.trim();
      if (!name) {
        setError(t('entry.sugar.meter.needName'));
        return;
      }
      const option = GLUCOMETERS.find((entry) => entry.key === chosen);
      if (!option) {
        setError(t('entry.sugar.meter.needMeter'));
        return;
      }

      await setInstrumentRange(METRIC_SUGAR, {
        label: option.label,
        low: option.low,
        high: option.high,
        setByLabel: name,
        setOn: toLocalDate(),
      });
      toast.show({ message: t('common.saved'), variant: 'success' });
      onSaved();
    } catch (caught: unknown) {
      console.warn('[entry/sugar] could not record the meter', caught);
      setError(t('entry.sugar.meter.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [saving, chosen, setBy, t, toast, onSaved]);

  return (
    <Dialog
      visible
      title={t('entry.sugar.meter.title')}
      message={t('entry.sugar.meter.why')}
      onRequestClose={onClose}
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('common.cancel')}
            onPress={onClose}
            variant="secondary"
            size="lg"
            fullWidth
          />
          <Button
            title={t('common.save')}
            onPress={() => void save()}
            loading={saving}
            size="lg"
            fullWidth
          />
        </View>
      }
    >
      <View style={{ gap: spacing.md }}>
        <Text variant="label">{t('entry.sugar.meter.which')}</Text>

        {GLUCOMETERS.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            selected={chosen === option.key}
            onPress={() => {
              setChosen(option.key);
              setError(null);
            }}
            selectionMode="single"
            grow
          />
        ))}

        <Chip
          label={t('entry.sugar.meter.dontKnow')}
          selected={chosen === DONT_KNOW}
          onPress={() => {
            setChosen(DONT_KNOW);
            setError(null);
          }}
          selectionMode="single"
          grow
        />

        {chosen === DONT_KNOW ? (
          <Text variant="caption" tone="muted">
            {t('entry.sugar.meter.dontKnowNote')}
          </Text>
        ) : null}

        {/* Shown back before it can be saved. She is confirming a printed figure, not
            trusting a list she has never seen. */}
        {selected ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="body">
              {t('entry.sugar.meter.rangeLine', {
                low: trimNumber(selected.low),
                high: trimNumber(selected.high),
              })}
            </Text>
            <Text variant="caption" tone="muted">
              {t('entry.sugar.meter.checkTheBox')}
            </Text>
            <TextField
              label={t('entry.sugar.meter.setBy')}
              helper={t('entry.sugar.meter.setByHelper')}
              value={setBy}
              onChangeText={setSetBy}
              autoCapitalize="words"
              required
            />
          </View>
        ) : null}

        {error ? (
          <Text variant="body" tone="destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}
