/**
 * One prescription — the paper, its header details, and the choice of how to turn it into
 * medicines.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "READ THIS WITH AI" AND "ADD MEDICINES MANUALLY" ARE THE SAME SIZE
 *
 * Neither is the recommended path, and neither is styled as one. The model is genuinely
 * better than typing at getting fourteen drug names off a scrawled page; it is also
 * capable of turning "1-0-1" into QID while leaving the drug name perfectly correct. A
 * screen that pushes the AI path with a big primary button and hides typing in a grey
 * link is a screen that has quietly decided on her behalf which of those risks she takes.
 *
 * The one time the balance moves is when the AI path cannot work at all — no key stored,
 * or the call failed. Then typing becomes the primary, because it is at that moment the
 * only thing that can actually produce a medicine, and a disabled button with no
 * explanation is how a user concludes the app is broken.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHILE IT IS READING: ONE STORY, TOLD BY TWO SOURCES THAT ARE NOT ALLOWED TO DISAGREE
 *
 * This screen now hears about a scan from two places, and that is a hazard worth naming
 * before anyone adds a third:
 *
 *   • `onAttempt` — the retry loop, request-scoped, passed into `runExtraction`. It is
 *     the ONLY authority on waits: it fires the instant a wait begins and carries the
 *     exact delay the loop is about to sleep for.
 *   • `subscribeAiProgress` — a module-level bus (`features/ai/progress.ts`) carrying the
 *     step the pipeline has reached: preparing a page, sending, reading, saving.
 *
 * THE PRECEDENCE RULE, and it is the whole design: WHEN A WAIT IS LIVE, THE WAIT WINS.
 * The step line is hidden and the busy sentence and its countdown are all that is on
 * screen, because "the reader is looking at it" and "asking again in 12 seconds" cannot
 * both be true and the second one is the useful half. When no wait is live, the step line
 * describes where the pipeline is. Two sources, one story, and a rule that decides which
 * of them speaks rather than letting whichever rendered last win.
 *
 * THE BAR NEVER LIES AND NEVER SHOWS A PERCENTAGE. Its position is a step in a five-step
 * pipeline, weighted by how long each step usually takes — not a measurement, because
 * nothing in a React Native `fetch` reports upload progress and no model announces how far
 * through an answer it is. So it carries no number: a percentage invites arithmetic that
 * the underlying figure cannot support, and a number that creeps to 90 and stops is worse
 * than no bar at all. While a step is genuinely unmeasurable the bar also carries a moving
 * marker, which is the honest shape for "something is happening, and nobody can say how
 * much of it is left". It cannot rewind — `publishAiProgress` clamps it — so a second
 * attempt stalls the bar where it is instead of reading as "it gave up and started over".
 *
 * THE PRECEDENCE RULE REACHES THE BAR TOO, and it took a third state to honour it. A live
 * wait makes the bar `stalled`: the fill holds where the last real step left it and the
 * marker stops, because the only thing happening is the countdown underneath. The two
 * older states — a still fill for a countable step, a travelling marker for an
 * unmeasurable one — are unchanged. See `BarState` for why a boolean could not say this.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { getAiKey, getMetaJson, useAsync, useT, type LocalStrings } from '@/app/_shared/lib';
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
import { useDateFormat } from '@/i18n/useDateFormat';
import type { TranslateFn } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { hasKey } from '@/features/ai/keyStore';
import type { AiAttemptEvent } from '@/features/ai/provider';
import {
  defaultMedicineBlockRect,
  HEADER_BAND_FRACTION,
  type CropRect,
} from '@/features/ai/imagePrep';
import { resetAiProgress, subscribeAiProgress, type AiProgress } from '@/features/ai/progress';
import { isDevLogEnabled } from '@/features/devlog';
import { runExtraction } from '@/features/prescriptions/extract';
import {
  getPrescription,
  updatePrescription,
  type Prescription,
  type PrescriptionStatus,
} from '@/db/repositories/prescriptions';

import { PRESCRIPTION_PAGES_META_PREFIX } from './capture';

const STRINGS: LocalStrings = {
  'prescription.readWithAi': { en: 'Read this with AI', hi: 'यह पर्चा AI से पढ़वाएँ' },
  'prescription.addManually': { en: 'Add medicines manually', hi: 'दवाइयाँ खुद लिखें' },
  'prescription.chooseHow': {
    en: 'How would you like to add the medicines?',
    hi: 'दवाइयाँ कैसे जोड़नी हैं?',
  },
  'prescription.bothAreFine': {
    en: 'Both ways work. Whatever is added has to be checked by you before any reminder starts.',
    hi: 'दोनों तरीके ठीक हैं। जो भी जुड़े, रिमाइंडर शुरू होने से पहले आपको उसे जाँचना ही होगा।',
  },
  'prescription.aiNeedsKey': {
    en: 'Reading a prescription with AI needs a key, which is set up in Settings. Until then you can type the medicines in yourself.',
    hi: 'AI से पर्चा पढ़वाने के लिए एक की (key) चाहिए, जो सेटिंग में डाली जाती है। तब तक आप दवाइयाँ खुद लिख सकती हैं।',
  },
  'prescription.pages': { en: 'The photos', hi: 'फोटो' },
  'prescription.pageOf': { en: 'Page {{n}} of {{total}}', hi: 'पेज {{n}}, कुल {{total}} में से' },
  'prescription.pageLabel': { en: 'Photo of page {{n}}', hi: 'पेज {{n}} की फोटो' },
  'prescription.openPage': { en: 'Open page {{n}} bigger', hi: 'पेज {{n}} बड़ा करके देखें' },
  'prescription.noPages': {
    en: 'This prescription has no photo saved with it.',
    hi: 'इस पर्चे के साथ कोई फोटो सेव नहीं है।',
  },
  'prescription.details': { en: 'About this prescription', hi: 'इस पर्चे के बारे में' },
  'prescription.dateHelp': { en: 'Written as year-month-day, like 2026-08-09', hi: 'साल-महीना-दिन ऐसे लिखें: 2026-08-09' },
  'prescription.dateInvalid': {
    en: 'Please write the date as 2026-08-09, or leave it blank.',
    hi: 'तारीख ऐसे लिखें: 2026-08-09, या खाली छोड़ दें।',
  },
  'prescription.detailsSaved': { en: 'Saved', hi: 'सेव हो गया' },
  'prescription.status.label': { en: 'Where this has reached', hi: 'यह कहाँ तक पहुँचा' },
  'prescription.status.draft': {
    en: 'Photographed. Nothing has been read from it yet.',
    hi: 'फोटो ले ली गई है। अभी इसमें से कुछ पढ़ा नहीं गया।',
  },
  'prescription.status.extracted': {
    en: 'Read by the app. Waiting for you to check every line.',
    hi: 'ऐप ने पढ़ लिया है। अब आपको हर पंक्ति जाँचनी है।',
  },
  'prescription.status.confirmed': {
    en: 'You have checked this prescription.',
    hi: 'आपने यह पर्चा जाँच लिया है।',
  },
  'prescription.reviewAgain': { en: 'Check the medicines', hi: 'दवाइयाँ जाँचें' },
  'prescription.crop.title': { en: 'What gets sent?', hi: 'क्या भेजा जाएगा?' },
  'prescription.crop.explain': {
    en: 'Reading a prescription sends the photo to Google. The top of the page — your name, your age, the clinic name — does not need to go, so it stays on this phone.',
    hi: 'पर्चा पढ़वाने के लिए फोटो गूगल को भेजी जाती है। पेज का ऊपरी हिस्सा — आपका नाम, उम्र, क्लीनिक का नाम — भेजने की ज़रूरत नहीं, इसलिए वह इसी फोन में रहता है।',
  },
  'prescription.crop.medicinesOnly': {
    en: 'Send only the medicines part',
    hi: 'सिर्फ़ दवाइयों वाला हिस्सा भेजें',
  },
  'prescription.crop.wholePage': { en: 'Send the whole page', hi: 'पूरा पेज भेजें' },
  'prescription.crop.wholePageWarning': {
    en: 'The names printed at the top of the page will be sent as well.',
    hi: 'पेज के ऊपर छपे नाम भी भेजे जाएँगे।',
  },
  'prescription.crop.shaded': {
    en: 'The shaded band stays on this phone.',
    hi: 'गहरे रंग वाला हिस्सा इसी फोन में रहेगा।',
  },
  'prescription.crop.whichPage': {
    en: 'Which page has the medicines on it?',
    hi: 'दवाइयाँ किस पेज पर लिखी हैं?',
  },
  'prescription.crop.page': { en: 'Page {{n}}', hi: 'पेज {{n}}' },
  'prescription.crop.start': { en: 'Read it now', hi: 'अभी पढ़ें' },
  // ─── WHAT SHE SEES WHILE A BUSY READER IS BEING ASKED AGAIN ───────────────
  //
  // NO COUNT APPEARS IN ANY OF THESE SENTENCES, and that is not squeamishness. `maxAttempts`
  // is a policy a caller can override, the loop stops early the moment the remaining budget
  // cannot fund another attempt, and a 300-second timeout leaves room for two attempts
  // rather than three — so "2 of 3" would be a lie in three separate, ordinary situations.
  // `ai/errors.ts` reached the same conclusion for the failure copy ("a few times", never
  // "three times"); this is the same promise, made while it is still happening.
  //
  // The seconds ARE named, because unlike the attempt count they are a fact: `retryInMs` is
  // the delay `retry.ts` is about to sleep for, and rounding it up is what its own comment
  // asks for.
  'prescription.readerBusy': {
    en: 'The prescription reader is busy just now. Aarogya is waiting a moment and will ask it again on its own. Your photo is saved.',
    hi: 'पर्चा पढ़ने वाली सेवा अभी व्यस्त है। आरोग्य थोड़ा रुककर खुद ही दोबारा पूछेगा। आपकी फोटो सहेज ली गई है।',
  },
  'prescription.retryInSeconds': {
    en: 'Asking again in {{s}} seconds',
    hi: '{{s}} सेकंड में दोबारा पूछा जाएगा',
  },
  'prescription.retryInMoment': {
    en: 'Asking again in a moment',
    hi: 'बस अभी दोबारा पूछा जाएगा',
  },
  'prescription.askingAgain': {
    en: 'Asking the reader again',
    hi: 'दोबारा पूछा जा रहा है',
  },
  // ─── THE STEP LINE ────────────────────────────────────────────────────────
  //
  // Four sentences, one per step of the pipeline, each naming what is actually happening
  // to something she can picture: her photograph, the reader, the answer. None of them
  // carries a percentage or an estimate of how long is left, because the app does not know
  // either — and a wrong "about 30 seconds" is remembered long after a right one is
  // forgotten.
  //
  // The page counter is the one genuinely countable part of a scan, so it counts. The
  // upload size is named because this may be happening on a metered connection in a
  // clinic corridor, and a megabyte is a fact worth being told before it leaves.
  'prescription.stepPreparing': {
    en: 'Getting photo {{n}} of {{total}} ready',
    hi: '{{total}} में से {{n}} फोटो तैयार की जा रही है',
  },
  'prescription.stepSending': { en: 'Sending the photo', hi: 'फोटो भेजी जा रही है' },
  'prescription.stepSendingSized': {
    en: 'Sending the photo, about {{size}}',
    hi: 'फोटो भेजी जा रही है, लगभग {{size}}',
  },
  'prescription.stepReading': {
    en: 'The reader is looking at it. This is the long part.',
    hi: 'पढ़ने वाली सेवा इसे देख रही है। इसी में सबसे ज़्यादा समय लगता है।',
  },
  'prescription.stepSaving': { en: 'Saving what came back', hi: 'जो जवाब आया, वह सहेजा जा रहा है' },
  'prescription.sizeMb': { en: '{{n}} MB', hi: '{{n}} MB' },
  'prescription.sizeKb': { en: '{{n}} KB', hi: '{{n}} KB' },

  'prescription.seeNotes': { en: 'See The Technical Notes', hi: 'तकनीकी नोट देखें' },

  'prescription.stopReading': { en: 'Stop Reading', hi: 'पढ़ना रोकें' },
  'prescription.stopHint': {
    en: 'Stops asking the reader. Your photo stays saved and you can read it again later.',
    hi: 'पूछना बंद हो जाएगा। आपकी फोटो सहेजी रहेगी और आप बाद में फिर पढ़वा सकती हैं।',
  },
  'prescription.stopped': {
    en: 'Reading stopped. Your photo is saved.',
    hi: 'पढ़ना रोक दिया गया। आपकी फोटो सहेजी हुई है।',
  },
  'prescription.goneMessage': {
    en: 'This prescription is no longer on the phone. Nothing else you recorded has been lost.',
    hi: 'यह पर्चा अब फोन में नहीं है। आपका दर्ज किया हुआ बाकी कुछ भी नहीं गया।',
  },
  'prescription.goHome': { en: 'Go to Today', hi: 'आज पर जाएँ' },
};

type PageView = {
  prescription: Prescription;
  pages: string[];
  aiAvailable: boolean;
};

/**
 * What the screen keeps from the retry loop's narration.
 *
 * Deliberately NOT the `AiAttemptEvent` union itself. The events arrive several times in a
 * fifteen-second sequence and every one of them carries `attempt` and `maxAttempts`, which
 * this screen has decided (see the copy above) it must never put on screen. Storing the raw
 * event would leave those two numbers one autocomplete away from a sentence that is wrong
 * in three ordinary cases.
 *
 * `retried` is a LATCH: it goes true on the first wait and never goes back. That is what
 * keeps the announced sentence stable — see the live-region note at the render site.
 */
type ExtractionProgress = {
  /** True once the sequence has had to wait at least once. Never returns to false. */
  readonly retried: boolean;
  /** When the next attempt starts, or null while an attempt is actually in flight. */
  readonly resumesAtEpoch: number | null;
};

export default function PrescriptionDetailScreen() {
  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  const t = useT(STRINGS);
  const toast = useToast();
  const { colors } = useTheme();
  const { formatDate } = useDateFormat();

  const [prescriber, setPrescriber] = useState<string | null>(null);
  const [clinic, setClinic] = useState<string | null>(null);
  const [prescribedOn, setPrescribedOn] = useState<string | null>(null);
  const [dateError, setDateError] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [extracting, setExtractingState] = useState(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  /**
   * The pipeline step, straight off the bus. Null until the first event of a run, which
   * is the honest state while the photograph is still being cropped by a build where
   * nothing publishes `preparing` yet — the bar simply has nothing to say and says it by
   * showing an unmeasurable one rather than by inventing a step.
   */
  const [step, setStep] = useState<AiProgress | null>(null);
  const [failure, setFailure] = useState<ExtractionFailure | null>(null);
  const [zoomPage, setZoomPage] = useState<number | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [wholePage, setWholePage] = useState(false);
  const [extractPage, setExtractPage] = useState(0);

  /**
   * THE ONLY THING THAT CAN STOP THE SEQUENCE, AND THEREFORE THE SPENDING.
   *
   * A failed read is asked again automatically now, up to the policy in `ai/retry.ts`. Every
   * one of those attempts spends a request out of a FREE daily allowance which, once gone,
   * is gone until tomorrow — and the worst case is not a few seconds: a first attempt that
   * times out can burn 300 s and the allowance leaves ~120 s more, so a sequence nobody can
   * interrupt keeps spending for up to seven minutes after she has walked away.
   *
   * A ref and not state on purpose: the cleanup below and the Stop button both need the
   * CURRENT controller, and neither of them may re-run `readWithAi` by changing its
   * identity.
   */
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Cancellation is wired to BLUR, not to unmount.
   *
   * `useFocusEffect`'s cleanup fires the moment this screen stops being the one in front of
   * her. `useEffect`'s cleanup fires only when the screen is destroyed, and in a stack those
   * are not the same event: tapping "Add medicines manually" pushes `/medicine/new` ON TOP
   * of this screen, which stays mounted underneath — so an unmount-based abort would let the
   * sequence run on, invisibly, on a screen she cannot see and cannot stop. Even on a plain
   * Back the pop animation can hold the unmount for hundreds of milliseconds.
   *
   * The empty dependency list is what makes this "on every blur, whatever is running": the
   * effect is not re-created when a new extraction starts, it just aborts whatever
   * `abortRef` is holding at the moment she leaves.
   *
   * Harmless on the success path: a finished extraction pushes `/prescription/review`, which
   * blurs this screen and aborts a controller whose work is already over. Aborting a settled
   * sequence does nothing at all.
   */
  useFocusEffect(
    useCallback(
      () => () => {
        abortRef.current?.abort();
      },
      [],
    ),
  );

  /**
   * The retry loop talking to the screen. Called synchronously from inside that loop, so it
   * does exactly one `setState` and nothing else — no await, no throw. See `AiAttemptEvent`.
   */
  const onAttempt = useCallback((event: AiAttemptEvent) => {
    if (event.phase === 'waiting') {
      setProgress({ retried: true, resumesAtEpoch: Date.now() + event.retryInMs });
      // Seeded here, from the delay the loop is about to sleep for, so the first frame of the
      // wait already shows the right number rather than a stale one from the interval below.
      setSecondsLeft(Math.max(1, Math.ceil(event.retryInMs / 1000)));
      return;
    }
    // An attempt is starting: nothing is being waited for any more. `retried` is latched —
    // `attempt > 1` covers the case where a wait was skipped entirely.
    setProgress((prev) => ({
      retried: (prev?.retried ?? false) || event.attempt > 1,
      resumesAtEpoch: null,
    }));
    setSecondsLeft(null);
  }, []);

  /**
   * The pipeline talking to the screen.
   *
   * Subscribed only while a read is running, and torn down the moment it stops: the bus is
   * module-level and outlives any one screen, so a permanent subscription here would be a
   * screen quietly listening to work it is not showing.
   *
   * `waiting` is dropped on the floor deliberately. `onAttempt` below is the authority on
   * waits — it is request-scoped, it fires with the exact delay, and it already drives the
   * latch and the countdown. Accepting the bus's version too would give one fact two
   * owners, which is how the busy sentence and the step line end up disagreeing about
   * whether anything is happening.
   */
  useEffect(() => {
    if (!extracting) return;
    return subscribeAiProgress((event) => {
      if (event.phase === 'waiting') return;
      setStep(event);
    });
  }, [extracting]);

  /**
   * The countdown, and the only thing on this screen that moves once a second.
   *
   * Half-second ticks so the number shown is never more than half a second stale; rounding
   * UP, because `retry.ts` says so and because "1 second" that lasts 1.9 s reads as a stall.
   */
  const resumesAtEpoch = progress?.resumesAtEpoch ?? null;
  useEffect(() => {
    if (resumesAtEpoch === null) return;
    // The clock is read in the timer callback and never during render: `Date.now()` is an
    // impure function, and a component that reads it while rendering produces a different
    // tree every time React happens to re-render it (the lint rule that enforces this is not
    // decoration — it is the difference between a countdown and a flicker).
    const timer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((resumesAtEpoch - Date.now()) / 1000)));
    }, 500);
    return () => clearInterval(timer);
  }, [resumesAtEpoch]);

  const state = useAsync<PageView | null>(async () => {
    if (!id) return null;
    const prescription = await getPrescription(id);
    if (!prescription) return null;

    const stored = await getMetaJson<string[]>(`${PRESCRIPTION_PAGES_META_PREFIX}${id}`);
    const pages =
      stored && stored.length > 0
        ? stored.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
        : prescription.imageUri
          ? [prescription.imageUri]
          : [];

    // Two key stores exist in this codebase — the route layer's own and the AI feature's
    // per-provider one — and the settings screen may have written to either. Treating a
    // key in EITHER as "AI is available" is the safe direction: the worst case is an
    // enabled button whose call fails and offers the manual path, which is exactly what
    // the failure branch below already does.
    const aiAvailable = (await getAiKey()) !== null || (await hasKey());

    return { prescription, pages, aiAvailable };
  }, [id]);

  const prescription = state.data?.prescription ?? null;

  // Local edit state is seeded once from the row, then owned by the fields. Re-seeding on
  // every render would fight her typing.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (prescription && seededFor !== prescription.id) {
    setSeededFor(prescription.id);
    setPrescriber(prescription.prescriber ?? '');
    setClinic(prescription.clinic ?? '');
    setPrescribedOn(prescription.prescribedOn ?? '');
  }

  const saveDetails = useCallback(async () => {
    if (!id) return;
    const date = (prescribedOn ?? '').trim();
    if (date.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setDateError(true);
      return;
    }
    setDateError(false);
    setSavingDetails(true);
    try {
      await updatePrescription(id, {
        prescriber: prescriber ?? '',
        clinic: clinic ?? '',
        prescribedOn: date,
      });
      toast.show({ message: t('prescription.detailsSaved'), variant: 'success' });
      state.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSavingDetails(false);
    }
  }, [clinic, id, prescribedOn, prescriber, state, t, toast]);

  const readWithAi = useCallback(async () => {
    const view = state.data;
    if (!id || !view) return;
    const imageUri = view.pages[extractPage] ?? view.pages[0];
    if (!imageUri) return;

    setCropOpen(false);
    setFailure(null);
    setExtractingState(true);
    setProgress(null);
    setSecondsLeft(null);
    setStep(null);
    // The bar starts at the left, not where the last scan left it. `resetAiProgress` also
    // clears the high-water mark that stops the bar rewinding — without it the second scan
    // of the day would open at whatever fraction the first one reached. Idempotent, so it
    // stays correct if `runExtraction` starts calling it too.
    resetAiProgress();

    // One sequence at a time. If a previous controller is somehow still live, it belongs to
    // work nobody is watching any more, and it is spending her allowance.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // The crop is the privacy control, not an optimisation — see ai/imagePrep.ts. It is
      // REQUIRED by `runExtraction`, and the rectangle used here is the one she chose in
      // the dialog above, never one this screen picked while she was not looking.
      const crop: CropRect = wholePage
        ? { originX: 0, originY: 0, width: 1, height: 1 }
        : defaultMedicineBlockRect();

      const outcome = await runExtraction({
        prescriptionId: id,
        imageUri,
        crop,
        // Both of these are what turn a fifteen-second silence into something she can watch
        // and something she can stop. Neither changes WHAT is asked, or who decides what the
        // answer means.
        signal: controller.signal,
        onAttempt,
      });

      if (outcome.ok) {
        router.push(`/prescription/review?id=${id}`);
        return;
      }
      // SHE STOPPED IT. THAT IS NOT A FAILURE, SO NOTHING RED, NOTHING TO DISMISS.
      //
      // 'cancelled' arrives for exactly two reasons, and neither is a malfunction: she
      // pressed Stop (already acknowledged with a toast, by the handler that did it), or she
      // left the screen (in which case a banner would be waiting for her when she came back,
      // reporting a failure that never happened). `runExtraction` has already put the row
      // back the way it was, so there is nothing to say and nothing to clean up.
      if (outcome.error.code === 'cancelled') return;

      // `runExtraction` has already written the failure onto the row and returns a typed
      // error carrying the exact sentence for this failure and the one next step.
      setFailure(outcome.error);
    } catch (error) {
      setFailure({
        userMessage: t('prescription.extractionFailed'),
        messageKey: 'prescription.extractionFailed',
        detail: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      // ── ONLY THE RUN THAT STILL OWNS THE CONTROLLER TIDIES UP AFTER ITSELF ──
      //
      // `abortRef` is claimed synchronously at the top of every run, so a controller that is
      // no longer in the ref means a NEWER run has already started and this one is a
      // straggler unwinding behind it. A straggler that cleared `extracting` would take the
      // Stop button and the narration off the screen while the newer sequence is still live
      // and still spending — an idle-looking screen with a request in flight, which is the
      // silent-retry defect inverted and harder to notice.
      //
      // Not reachable through this screen today: `Button` treats `loading` as inert, so
      // "Read this with AI" cannot be pressed while `extracting` is true, and `extracting`
      // only drops in this block — which clears the ref in the same synchronous run. The
      // guard is here because that invariant lives in a component two folders away, and one
      // extra entry point (a "read it again" button on the failure banner is the obvious
      // one) is all it takes to lose it silently. Nothing can strand the screen mid-read
      // either way: whichever run owns the ref always reaches its own `finally`.
      const superseded = abortRef.current !== null && abortRef.current !== controller;
      if (abortRef.current === controller) abortRef.current = null;

      if (!superseded) {
        setExtractingState(false);
        setProgress(null);
        setSecondsLeft(null);
        setStep(null);
        state.reload();
      }
    }
  }, [extractPage, id, onAttempt, state, t, wholePage]);

  /**
   * Stop, asked for out loud.
   *
   * The toast is fired HERE rather than off the `cancelled` outcome, because only this path
   * knows she asked: the same outcome arrives when she simply walks away, and a toast that
   * chases her onto the next screen to report something she already knows is noise. The
   * sentence is about her photo, not about a failure, because nothing failed.
   */
  const stopReading = useCallback(() => {
    abortRef.current?.abort();
    toast.show({ message: t('prescription.stopped'), variant: 'info' });
  }, [t, toast]);

  const goManual = useCallback(() => {
    if (!id) return;
    router.push(`/medicine/new?prescriptionId=${id}`);
  }, [id]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  // `&& !prescription`, not the flag on its own. `state.reload()` runs at the end of every
  // extraction — including the one she stopped, which is now an ordinary thing to do — and
  // `reload()` raises `loading` again. Gating the whole screen on the flag alone replaces
  // everything in front of her, Stop button and photographs included, with three grey blocks
  // for the length of one database read, every single time she stops a reading. A skeleton
  // is for having nothing to show; refreshing something already on screen is not that.
  if (state.loading && !prescription) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.title')} />
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={140} label={t('a11y.loading')} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </View>
      </Screen>
    );
  }

  const view = state.data;
  if (!view || !prescription) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.title')} onBack={leave} />
        <EmptyState
          title={t('errors.notFound')}
          message={t('prescription.goneMessage')}
          actionLabel={t('prescription.goHome')}
          onAction={leave}
        />
      </Screen>
    );
  }

  const aiUsable = view.aiAvailable && view.pages.length > 0;
  // Typing becomes the primary only when the AI path genuinely cannot deliver.
  const manualIsPrimary = !aiUsable || failure !== null;
  const zoomUri = zoomPage === null ? null : (view.pages[zoomPage] ?? null);
  const cropPreview = view.pages[extractPage] ?? view.pages[0] ?? null;
  // The typed error carries its own i18n key; `useT` hands the key back when it is not in
  // the bundle yet, and that is the signal to fall back to the English sentence the
  // errors module was written with.
  const failureText = failure
    ? t(failure.messageKey) === failure.messageKey
      ? failure.userMessage
      : t(failure.messageKey)
    : null;

  // Read at render rather than held in state: it is a module-level mirror, it changes only
  // when somebody flips a switch on another screen, and this component re-renders when the
  // failure it decorates arrives.
  const devNotesKept = isDevLogEnabled();

  // The precedence rule from the file header, in one boolean. A wait is live whenever the
  // retry loop has told us when it resumes; while that is true nothing else narrates.
  const waitingForRetry = progress !== null && progress.resumesAtEpoch !== null;
  const stepLine = waitingForRetry ? null : stepText(t, step);

  return (
    <Screen
      footer={
        <Button
          title={t('common.save')}
          onPress={() => void saveDetails()}
          variant="secondary"
          size="lg"
          fullWidth
          loading={savingDetails}
        />
      }
    >
      <ScreenHeader
        title={t('prescription.title')}
        subtitle={
          prescription.prescribedOn ? formatDate(prescription.prescribedOn) : undefined
        }
        onBack={leave}
      />

      <Card variant="sunken" style={{ gap: spacing.sm }}>
        <Text variant="caption" tone="muted">
          {t('prescription.status.label')}
        </Text>
        <Text variant="body">{t(statusKey(prescription.status))}</Text>
      </Card>

      {prescription.status === 'extracted' ? (
        <Button
          title={t('prescription.reviewAgain')}
          onPress={() => router.push(`/prescription/review?id=${prescription.id}`)}
          variant="primary"
          size="lg"
          fullWidth
          style={{ marginTop: spacing.lg }}
        />
      ) : null}

      <SectionHeader title={t('prescription.pages')} />
      {view.pages.length === 0 ? (
        <Text variant="body" tone="muted">
          {t('prescription.noPages')}
        </Text>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
          {/* Bounded by the pages of one prescription. */}
          {view.pages.map((uri, index) => (
            <View key={uri} style={{ gap: spacing.xs }}>
              <PressableScale
                onPress={() => setZoomPage(index)}
                accessibilityRole="button"
                accessibilityLabel={t('prescription.openPage', { n: index + 1 })}
                style={{
                  width: 104,
                  height: 140,
                  borderRadius: radii.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.bgSunken,
                  overflow: 'hidden',
                }}
              >
                <Image
                  source={{ uri }}
                  resizeMode="cover"
                  style={{ width: '100%', height: '100%' }}
                />
              </PressableScale>
              <Text variant="caption" tone="muted">
                {t('prescription.pageOf', { n: index + 1, total: view.pages.length })}
              </Text>
            </View>
          ))}
        </View>
      )}

      <SectionHeader title={t('prescription.details')} />
      <View style={{ gap: spacing.lg }}>
        <TextField
          label={t('prescription.prescriber')}
          value={prescriber ?? ''}
          onChangeText={setPrescriber}
          autoCapitalize="words"
        />
        <TextField
          label={t('prescription.clinic')}
          value={clinic ?? ''}
          onChangeText={setClinic}
          autoCapitalize="words"
        />
        <TextField
          label={t('prescription.prescribedOn')}
          value={prescribedOn ?? ''}
          onChangeText={(text) => {
            setPrescribedOn(text);
            setDateError(false);
          }}
          helper={t('prescription.dateHelp')}
          error={dateError ? t('prescription.dateInvalid') : undefined}
          keyboardType="numbers-and-punctuation"
        />
      </View>

      <SectionHeader title={t('prescription.chooseHow')} subtitle={t('prescription.bothAreFine')} />

      {/* One calm sentence, in the words the errors module wrote for this exact failure,
          and the manual path immediately under it. No retry loop. */}
      {failureText ? (
        <Banner
          variant="attention"
          title={t('prescription.extractionFailed')}
          message={failureText}
          // ─── THE ONE TAP FROM "IT DID NOT WORK" TO "HERE IS WHY" ───────────
          //
          // The sentence above is the honest, calm, non-technical account, and it is the
          // right one for her. It is also, by design, the same shape for ten genuinely
          // different failures — a key restricted to Android apps, a thinking budget spent
          // before the first character of an answer, a free allowance that was zero rather
          // than merely used up. Whoever set the phone up needs the other account.
          //
          // So this appears ONLY when technical notes are being kept, which is a switch
          // somebody deliberately turned on. She never sees it, and nothing about the
          // failure copy changes.
          actionLabel={devNotesKept ? t('prescription.seeNotes') : undefined}
          onAction={devNotesKept ? () => router.push('/devlog?filter=scan') : undefined}
          style={{ marginBottom: spacing.lg }}
        />
      ) : null}

      {!view.aiAvailable ? (
        <Banner
          variant="info"
          title={t('prescription.aiNeedsKey')}
          style={{ marginBottom: spacing.lg }}
        />
      ) : null}

      {/* Same size, same width, same treatment. The only difference between them, ever,
          is which one is `primary`, and that only moves when the AI path cannot work. */}
      <View style={{ gap: spacing.md }}>
        <Button
          title={t('prescription.readWithAi')}
          // Opens the dialog that says what leaves the phone. The network is never
          // touched from a single tap on this button.
          onPress={() => setCropOpen(true)}
          variant={manualIsPrimary ? 'secondary' : 'primary'}
          size="lg"
          fullWidth
          disabled={!aiUsable}
          loading={extracting}
          accessibilityHint={extracting ? t('prescription.extracting') : undefined}
        />
        <Button
          title={t('prescription.addManually')}
          onPress={goManual}
          variant={manualIsPrimary ? 'primary' : 'secondary'}
          size="lg"
          fullWidth
        />
      </View>

      {/*
        WHILE IT IS RUNNING: ONE ANNOUNCED SENTENCE, ONE MOVING LINE, ONE WAY OUT.

        ─── WHY THE LIVE REGION HOLDS STILL ──────────────────────────────────────────
        `accessibilityLiveRegion` re-announces whenever the text inside it changes, and this
        sequence produces an event every few seconds — attempt, wait, attempt, wait. Piping
        that straight into the live region would interrupt TalkBack mid-word, four or five
        times, on a screen where she has nothing to do but wait: hostile, and it would talk
        over the Stop button she is trying to reach.

        So the announced text has exactly TWO possible values for a whole extraction:
        "Reading the prescription", and — the first time a wait happens, latched by
        `progress.retried` — the busy sentence. Two announcements per read, and the second
        one is the only news there is: the reader was busy and the app is handling it.

        The seconds tick underneath, hidden from TalkBack entirely. They exist for the eye —
        proof that something is still happening — and a screen-reader user has already been
        told everything that line would tell them, in one sentence, without a countdown
        reading itself out loud every second.
      */}
      {extracting ? (
        <View style={{ paddingTop: spacing.md, gap: spacing.md }}>
          {/*
            The bar is hidden from TalkBack, exactly like the countdown below and for the
            same reason: everything it conveys has already been said in one sentence in
            the live region, and a progress bar that announces itself on every change would
            talk over the Stop button four or five times per read. It is for the eye.
          */}
          <ProgressBar
            fraction={step?.estimate ?? 0}
            // A live wait wins over whatever phase was published last: nothing is moving,
            // the countdown below is already saying so, and a bar that sweeps while a
            // sentence names the seconds until the next attempt contradicts it. `stalled`
            // holds the fill still — see `BarState`, which is where the state this used to
            // borrow (the animated one) is explained.
            state={waitingForRetry ? 'stalled' : step?.determinate === true ? 'measured' : 'working'}
          />

          <Text variant="body" tone="muted" accessibilityLiveRegion="polite">
            {progress?.retried ? t('prescription.readerBusy') : t('prescription.extracting')}
          </Text>

          {/* The step line. Absent while a wait is live — see the precedence rule in the
              file header — and hidden from TalkBack for the same reason as the bar. */}
          {stepLine ? (
            <Text
              variant="caption"
              tone="muted"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {stepLine}
            </Text>
          ) : null}

          {/*
            The countdown. Shown while a wait is live, and — only when the pipeline has
            told us nothing at all — as the fallback narration for a second attempt that is
            already in flight. When a step line exists it says the same thing better, and
            two lines describing one attempt is exactly the duplication the precedence rule
            in the file header exists to prevent.
          */}
          {progress?.retried && (waitingForRetry || !stepLine) ? (
            <Text
              variant="body"
              tone="muted"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {secondsLeft === null
                ? t('prescription.askingAgain')
                : secondsLeft <= 1
                  ? t('prescription.retryInMoment')
                  : t('prescription.retryInSeconds', { s: secondsLeft })}
            </Text>
          ) : null}

          {/*
            The way out. `size="lg"` is 64dp, above the 56dp floor, and it is a plain
            secondary button rather than anything alarming: stopping a busy reader is an
            ordinary thing to do, not a destructive one, and her photo is already saved.
          */}
          <Button
            title={t('prescription.stopReading')}
            onPress={stopReading}
            variant="secondary"
            size="lg"
            fullWidth
            accessibilityHint={t('prescription.stopHint')}
          />
        </View>
      ) : null}

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.lg }}>
        {t('prescription.aiWarning')}
      </Text>

      <Dialog
        visible={zoomUri !== null}
        title={
          zoomPage === null
            ? undefined
            : t('prescription.pageOf', { n: zoomPage + 1, total: view.pages.length })
        }
        onRequestClose={() => setZoomPage(null)}
      >
        {zoomUri ? (
          <Image
            source={{ uri: zoomUri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('prescription.pageLabel', { n: (zoomPage ?? 0) + 1 })}
            resizeMode="contain"
            style={{
              width: '100%',
              aspectRatio: 3 / 4,
              borderRadius: radii.md,
              backgroundColor: colors.bgSunken,
            }}
          />
        ) : null}
      </Dialog>

      {/*
        WHAT LEAVES THE PHONE, DECIDED BY HER, BEFORE ANYTHING IS SENT.

        `imagePrep.ts` requires a crop rectangle and says plainly that the app never crops
        unattended. There is no drag-a-rectangle interaction here on purpose: a rectangle
        dragged with a tremor is a rectangle that cuts a dosage line in half. She gets the
        two answers that actually differ — keep the top band on the phone, or send the
        page whole — with the band shown on the photograph so the choice is visible rather
        than described.
      */}
      <Dialog
        visible={cropOpen}
        title={t('prescription.crop.title')}
        onRequestClose={() => setCropOpen(false)}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('prescription.crop.start')}
              onPress={() => void readWithAi()}
              variant="primary"
              size="lg"
              fullWidth
              loading={extracting}
            />
            <Button
              title={t('common.cancel')}
              onPress={() => setCropOpen(false)}
              variant="secondary"
              size="lg"
              fullWidth
            />
          </View>
        }
      >
        <Text variant="body">{t('prescription.crop.explain')}</Text>

        {view.pages.length > 1 ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('prescription.crop.whichPage')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {view.pages.map((uri, index) => (
                <Chip
                  key={uri}
                  label={t('prescription.crop.page', { n: index + 1 })}
                  selected={extractPage === index}
                  onPress={() => setExtractPage(index)}
                  selectionMode="single"
                />
              ))}
            </View>
          </View>
        ) : null}

        {cropPreview ? (
          <View
            style={{
              width: '100%',
              aspectRatio: 3 / 4,
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgSunken,
              overflow: 'hidden',
            }}
          >
            <Image
              source={{ uri: cropPreview }}
              resizeMode="contain"
              style={{ width: '100%', height: '100%' }}
            />
            {!wholePage ? (
              // The band that stays behind, drawn over the photograph itself.
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${Math.round(HEADER_BAND_FRACTION * 100)}%`,
                  backgroundColor: colors.overlay,
                  borderBottomWidth: 2,
                  borderBottomColor: colors.attention,
                }}
              />
            ) : null}
          </View>
        ) : null}

        <Chip
          label={t('prescription.crop.medicinesOnly')}
          selected={!wholePage}
          onPress={() => setWholePage(false)}
          selectionMode="single"
          accessibilityHint={t('prescription.crop.shaded')}
          grow
        />
        <Chip
          label={t('prescription.crop.wholePage')}
          selected={wholePage}
          onPress={() => setWholePage(true)}
          selectionMode="single"
          accessibilityHint={t('prescription.crop.wholePageWarning')}
          grow
        />

        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Icon name={wholePage ? 'alert' : 'info'} size={20} color={wholePage ? colors.attention : colors.textMuted} />
          <Text variant="caption" tone={wholePage ? 'attention' : 'muted'} style={{ flex: 1 }}>
            {wholePage ? t('prescription.crop.wholePageWarning') : t('prescription.crop.shaded')}
          </Text>
        </View>
      </Dialog>
    </Screen>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────

/** Height of the track, in dp. Thick enough to be seen at arm's length, thin enough not
 *  to look like a control she is supposed to drag. */
const TRACK_HEIGHT = 10;
/** How much of the track the moving marker covers while a step is unmeasurable. */
const MARKER_SPAN = 0.3;
/** One traverse of the track, in ms. Slow enough to read as "working", not as "hurrying". */
const MARKER_SWEEP_MS = 1400;

/**
 * What the bar is being asked to say. Three values, because there are three situations and
 * the middle one used to have to borrow the wrong half of a boolean.
 */
type BarState =
  /** A countable step (photograph 2 of 4). A still fill, and where it sits is the answer. */
  | 'measured'
  /** A step with no measurable inside. A travelling marker: nobody can say how long. */
  | 'working'
  /**
   * A live retry wait. NOTHING is happening, and the countdown beside the bar is already
   * saying so in seconds. The bar holds still at the high-water mark and grows no marker.
   */
  | 'stalled';

/**
 * A progress bar that can admit it does not know, and can admit it is not moving.
 *
 * THREE STATES, AND THE DIFFERENCE IS VISIBLE WITHOUT READING ANYTHING:
 *
 *   measured — a filled track. Something countable is happening and the fill is where in
 *              the whole job that puts us.
 *   working  — a dim ground at the same position, plus a marker that TRAVELS across the
 *              track. The marker is the whole signal: the current step has no measurable
 *              inside and nobody can say how long it will be. This is most of a scan.
 *   stalled  — the filled track again, motionless. A retry wait is live; the seconds
 *              underneath are the thing that moves, and a bar sweeping away above them
 *              would contradict a sentence that says the app is waiting.
 *
 * ─── WHY `stalled` IS NOT JUST `working` ─────────────────────────────────────
 * It used to be. `measurable` was `determinate && !waitingForRetry`, with a comment saying
 * a wait must not look like a step in progress — but of the two states that existed, the
 * unmeasurable one is the one WITH motion, so forcing it during a wait produced the busiest
 * the bar ever gets at the exact moment the screen says "Asking again in 26 seconds". (The
 * `!waitingForRetry` term was also dead: by the time a wait exists the last published phase
 * is `sending` or `reading`, both already unmeasurable.) Three states, named for what they
 * mean, so the next reader cannot make the same trade.
 *
 * ─── THE MARKER'S COLOUR IS A CONTRAST FLOOR, NOT A PREFERENCE ───────────────
 * The marker was `primarySoft` on a `bgSunken` track: 1.07:1 in light and 1.60:1 in dark,
 * against a 3:1 floor for anything non-text that carries meaning. It was therefore visible
 * ONLY where it crossed the filled portion and invisible for the rest of each traverse —
 * so during `reading`, which lasts up to 300 s and where the marker is the only thing on
 * screen that moves, the bar read as a frozen slab. A frozen phone is the thing that gets
 * the app killed mid-read; see the header of `features/ai/progress.ts`.
 *
 * So in `working` the two swap: the marker is `primary` (5.47:1 light / 9.79:1 dark on the
 * track, 5.84:1 / 6.12:1 over the ground it crosses) and the fill drops to `primarySoft`.
 * A dim static ground is a fine thing for `primarySoft` to be; it was only unusable as the
 * moving figure. Both pairs are in the contrast table in `src/theme/index.ts`.
 *
 * NO NUMBER, EVER. See the file header — the fraction is a weighted position in a
 * pipeline, not a measurement, and printing "45%" would invite arithmetic it cannot
 * support.
 *
 * DELIBERATELY RN `Animated`, NOT REANIMATED, for the same reason `Skeleton` gives: no
 * babel plugin, no class of runtime failure inside a worklet, and `translateX` runs on the
 * native driver anyway. The FILL is a plain width and is not animated — it changes four or
 * five times in a two-minute read, and a width cannot use the native driver, so animating
 * it would put work on the JS thread for a transition nobody is watching for.
 *
 * Colour carries no CLINICAL meaning here. The bar is the primary token whatever is
 * happening — there is no failure state in it, because a failure removes the bar and puts
 * a sentence in its place.
 */
function ProgressBar({ fraction, state }: { fraction: number; state: BarState }) {
  const { colors } = useTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  // Lazily-initialised state rather than a ref, for the reason `Skeleton` documents: the
  // value is read while rendering, and reading a ref during render is what React's rules
  // forbid. The setter is never called.
  const [travel] = useState(() => new Animated.Value(0));

  const moving = state === 'working';

  useEffect(() => {
    if (!moving || trackWidth === 0) return;
    travel.setValue(0);
    const animation = Animated.loop(
      Animated.timing(travel, {
        toValue: 1,
        duration: MARKER_SWEEP_MS,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    );
    animation.start();
    // A loop left running keeps the native driver awake behind a screen she has left — and
    // behind a wait, which is the state this loop must NOT survive into.
    return () => animation.stop();
  }, [moving, trackWidth, travel]);

  const markerWidth = Math.max(48, trackWidth * MARKER_SPAN);
  const clamped = Math.max(0, Math.min(1, fraction));

  return (
    <View
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: TRACK_HEIGHT,
        borderRadius: TRACK_HEIGHT / 2,
        backgroundColor: colors.bgSunken,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: TRACK_HEIGHT / 2,
          // Dim only while the marker is the figure. In `measured` and `stalled` the fill
          // IS the message and has to clear the floor against the track on its own.
          backgroundColor: moving ? colors.primarySoft : colors.primary,
        }}
      />
      {moving && trackWidth > 0 ? (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: markerWidth,
            borderRadius: TRACK_HEIGHT / 2,
            // Fully opaque, on purpose. At 0.9 the marker blends a tenth of whatever it is
            // crossing, which costs about a point of contrast on the empty track for a
            // softness nobody asked for.
            backgroundColor: colors.primary,
            transform: [
              {
                translateX: travel.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-markerWidth, trackWidth],
                }),
              },
            ],
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * The step, in a sentence, or nothing at all.
 *
 * Returns null rather than a placeholder when the pipeline has not spoken yet. An empty
 * line is better than a guessed one: the app has genuinely not been told which step it is
 * on, and the bar is already saying "working" without claiming to know how much is left.
 *
 * `done` also returns null — by the time it arrives the screen is either navigating to the
 * review or putting a failure sentence where the bar was, and a step line reading "saving"
 * underneath either of those is a leftover.
 */
function stepText(t: TranslateFn, step: AiProgress | null): string | null {
  if (!step) return null;
  switch (step.phase) {
    case 'preparing':
      return t('prescription.stepPreparing', { n: step.page, total: step.pageCount });
    case 'sending':
      return step.bytes > 0
        ? t('prescription.stepSendingSized', { size: byteText(t, step.bytes) })
        : t('prescription.stepSending');
    case 'reading':
      return t('prescription.stepReading');
    case 'saving':
      return t('prescription.stepSaving');
    case 'done':
    default:
      return null;
  }
}

/**
 * "1.4 MB" / "820 KB".
 *
 * One decimal place above a megabyte and none below it, because this number exists to let
 * someone on a metered connection decide whether to wait for the Wi-Fi — a precision of
 * kilobytes would be answering a question nobody asked.
 */
function byteText(t: TranslateFn, bytes: number): string {
  const kb = 1024;
  const mb = kb * kb;
  if (bytes >= mb) return t('prescription.sizeMb', { n: (bytes / mb).toFixed(1) });
  return t('prescription.sizeKb', { n: Math.max(1, Math.round(bytes / kb)) });
}

/** Just enough of an `AiError` to render it. Kept local so the screen owns its own copy. */
type ExtractionFailure = {
  readonly userMessage: string;
  readonly messageKey: string;
  readonly detail?: string;
};

function statusKey(status: PrescriptionStatus): string {
  switch (status) {
    case 'extracting':
      return 'prescription.extracting';
    case 'extracted':
      return 'prescription.status.extracted';
    case 'confirmed':
      return 'prescription.status.confirmed';
    case 'failed':
      return 'prescription.extractionFailed';
    case 'draft':
    default:
      return 'prescription.status.draft';
  }
}
