/**
 * When to take it.
 *
 * ─── TIMES ARE CHOSEN FROM NAMED SLOTS, NOT FROM A CLOCK ─────────────────────
 * "Before breakfast" is how she thinks about it; "08:00" is what the alarm needs and what
 * a doctor will ask her for. Every chip therefore carries BOTH — "Before breakfast · 08:00"
 * — and the literal times are repeated in the read-back that gates the save. The slot
 * times themselves are set once in Settings and every reminder in the app resolves
 * through them.
 *
 * ─── THE ESCAPE HATCH NOW HAS A NAME ON IT ───────────────────────────────────
 * "Another time" used to add a bare time — 07:15 and nothing else. A time with no name is
 * unreadable everywhere it is later shown: in this list, in the medicines list, in the OPD
 * report. So the hatch now builds a REAL custom slot (a name plus a time) which is stored
 * on the profile alongside the nine built-ins and behaves exactly like them.
 *
 * Bare times still exist, but only in one direction: a medicine saved by the shipped build
 * may already carry one, and a slot's time may have been moved in Settings after that row
 * was written. Those are seeded back in and can be removed — or given a name — but nothing
 * on this screen creates a new one. Dropping them on load would silently delete a dose from
 * a woman who opened this screen to change the days.
 *
 * ─── THE PICKER IS NOT A NATIVE ONE, AND THAT IS DELIBERATE ──────────────────
 * The hour/minute steppers show a 24-hour clock. A native picker would be less code, but
 * several Android OEM skins render it 12-hour with a small AM/PM control, and an AM/PM
 * misread on a dosing screen is a dose taken twelve hours from when it was meant to be.
 * The steppers cannot express that ambiguity.
 *
 * ─── THE NAMING FORM IS A DIALOG, AND IT WAS NOT ─────────────────────────────
 * It used to be an inline block rendered ABOVE the chosen-times list. "Give this time a
 * name" sits on a row in that list, near the bottom of a card that runs well past a
 * screenful at her text scale — so tapping it opened the form several hundred dp above the
 * viewport, and the only thing that changed where she was looking was that the list shifted
 * down. For a woman with a tremor who already doubts whether her taps register, a control
 * that appears dead is the one that gets pressed again, and again. A Dialog cannot be
 * off-screen. It is also what `settings/slots.tsx` uses for the same action, so the two
 * doors into custom-slot creation now look alike as well as behave alike.
 *
 * Its refusals are rendered INSIDE the dialog, not as toasts. The toast host is an in-tree
 * overlay by design (see the header of `components/ui/Toast.tsx`), so a toast raised while
 * a Dialog is open renders BEHIND it — the message she needs would be invisible under the
 * form that caused it. Only the success message is a toast, and by then the dialog is gone.
 *
 * ─── FIFTEEN CHIPS MEAN THE COUNT HAS TO BE SAID OUT LOUD ────────────────────
 * The shipped build offered four slots, so "how many doses a day is this?" was answered by
 * construction. Nine built-ins plus six of her own is fifteen tickable chips in a column,
 * and a resting thumb on a mis-scroll ticks two or three of them without her noticing. The
 * read-back lists the times, but a list of fifteen boxes is not a number — you have to
 * count it, and counting is exactly what a scrolling list defeats. So the COUNT is stated
 * as a number, in the preview and again in the read-back, and past `MANY_DOSES_IN_A_DAY`
 * a banner asks her to check the list. It never refuses: see that constant.
 *
 * ─── TWO SLOTS MAY NEVER LAND ON ONE CLOCK TIME ──────────────────────────────
 * `dose_schedule` has UNIQUE (thread_id, version, time_local) and `dose_occurrence.id` is
 * '<thread_id>:<local_date>:<time_local>'. With Before lunch at 13:30 and After lunch at
 * 14:00 a single stepper tap in Settings can put two slots on the same minute. Ticking both
 * would then write two rows with the same `time_local`, the constraint would abort, and the
 * entire save would roll back behind a generic "could not save". So a collision is refused
 * AT SELECTION TIME, naming both slots — see `toggleSlot` — and `chosen` is keyed by time so
 * that the INSERT is deduplicated even if a selection somehow slips past that guard.
 *
 * ─── A DOSE CHANGE APPENDS A VERSION; IT NEVER EDITS ONE ─────────────────────
 * March's schedule still says what it said in March, because "what was she taking in
 * March?" is the question the OPD report exists to answer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  DEFAULT_SLOT_TIMES,
  MAX_CUSTOM_SLOTS,
  MAX_CUSTOM_SLOT_LABEL,
  SLOT_MINUTE_STEP,
  SLOT_OWN_TIME_KEYS,
  SLOT_SETTINGS_NOTE_KEY,
  SLOT_STRINGS,
  buildSlotDefinitions,
  defaultNewCustomSlotTime,
  getCustomSlots,
  getSlotTimes,
  isWallClock,
  newCustomSlotKey,
  setCustomSlots as storeCustomSlots,
  slotDefForKey,
  slotForTime,
  slotLabel,
  splitWallClock,
  stepWallClock,
  useAsync,
  useProfileId,
  useT,
  validateCustomSlots,
  type BuiltinSlotKey,
  type CustomSlot,
  type CustomSlotIssue,
  type LocalStrings,
  type SlotDefinition,
  type SlotKey,
} from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Chip,
  Dialog,
  Divider,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useToast,
} from '@/components/ui';
import { ActiveProfileTag } from '@/app/profiles/_lib';
import { useDateFormat } from '@/i18n/useDateFormat';
import { ALL_DAYS, toLocalDate } from '@/lib/datetime';
import { getCurrentVersion } from '@/db/repositories/medicines';
import {
  confirmCurrentSchedules,
  createInitialSchedules,
  createScheduleVersion,
  getCurrentSchedules,
  type ScheduleSlot,
} from '@/db/repositories/schedules';
import { reconcile } from '@/features/dosing/reconcile';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { DoseSchedule, Medicine } from '@/types';

const STRINGS: LocalStrings = {
  ...SLOT_STRINGS,
  'schedule.title': { en: 'When to take it', hi: 'कब लेनी है' },
  'schedule.forMedicine': { en: 'For {{name}}', hi: '{{name}} के लिए' },
  'schedule.whichTimes': { en: 'At what times?', hi: 'किन समयों पर?' },
  // `schedule.slotHelp` used to live here and said "Changing them there changes every
  // reminder." It does not: `dose_schedule` is append-only and reconcile reads
  // `schedule.timeLocal`, never a slot time — so a user who moved Before breakfast to
  // 07:00 on the strength of that line would still be rung at 08:00. The truthful sentence
  // now lives once, in `SLOT_STRINGS`, beside the settings banner it has to agree with.
  'schedule.sameTime': {
    en: '{{first}} and {{second}} are both at {{time}}. Choose one of them, or change the times in your settings.',
    hi: '{{first}} और {{second}} दोनों {{time}} पर हैं। इनमें से एक चुनें, या अपनी सेटिंग में समय बदलें।',
  },
  'schedule.sameTimeTitle': { en: 'Two of your times are the same', hi: 'आपके दो समय एक जैसे हैं' },
  'schedule.sameTimeChip': { en: 'Same time as {{other}}', hi: '{{other}} के समय जैसा ही' },
  // ── The naming form's own copy is NOT here ──
  // Every word this screen and `settings/slots.tsx` both say about inventing a time —
  // the button, the two titles, the name field and its help, the confirm, the stepper
  // labels, the 24-hour note, the success line, the "you have six already" line and the
  // undo path — lives once in `SLOT_STRINGS` and is reached through `SLOT_OWN_TIME_KEYS`.
  // The two flows were written weeks apart and had drifted on all three axes at once:
  // different defaults, different wording ('Add a time of your own' here against 'Add Your
  // Own Time' there) and different casing, so the same action read as two different
  // features depending on which door she came through. Reaching those keys through the
  // constant rather than as quoted literals is load-bearing for `scripts/check-i18n.js` —
  // see the long note above the strings in the registry.
  //
  // What stays below is what only THIS screen says: the refusals (settings words its own
  // differently, because it is editing a list rather than adding to a schedule) and the
  // sentence about scope, which only matters on a screen that is otherwise about one
  // medicine.
  //
  // The truth she cannot get anywhere else on this screen: the slot is written to the
  // PROFILE, before the schedule and regardless of whether she ever saves it, and the only
  // way back is Settings. Said BEFORE she commits, next to the button that commits it —
  // saying it afterwards in a toast would be an announcement, not a choice. Paired with
  // `SLOT_OWN_TIME_KEYS.removeHint`, which is the route out in words.
  'schedule.ownTimeScope': {
    en: 'This time is added for every medicine, not only this one.',
    hi: 'यह समय हर दवाई के लिए जुड़ता है, सिर्फ़ इसी दवाई के लिए नहीं।',
  },
  'schedule.ownTimeNameNeeded': { en: 'Give this time a name first.', hi: 'पहले इस समय को नाम दें।' },
  'schedule.ownTimeNameTooLong': {
    en: 'Please keep the name under {{max}} letters.',
    hi: 'नाम {{max}} अक्षरों से छोटा रखें।',
  },
  // Names the slot it collides with. "one of the fixed times" left her scanning a list to
  // work out which — and the list she was scanning did not always contain it.
  'schedule.ownTimeNameReserved': {
    en: '"{{name}}" is already the name of the time at {{time}}. Please use a different name.',
    hi: '"{{name}}" पहले से {{time}} वाले समय का नाम है। कोई दूसरा नाम रखें।',
  },
  'schedule.ownTimeTaken': {
    en: '{{name}} is already at {{time}}. Choose a different time.',
    hi: '{{name}} पहले से {{time}} पर है। कोई दूसरा समय चुनें।',
  },
  'schedule.ownTimeTakenUnknown': {
    en: 'One of your times is already at {{time}}. Choose a different time.',
    hi: 'आपका कोई समय पहले से {{time}} पर है। कोई दूसरा समय चुनें।',
  },
  'schedule.ownTimeInvalid': { en: 'That time could not be added.', hi: 'वह समय जोड़ा नहीं जा सका।' },
  'schedule.ownTimeSaveFailed': {
    en: 'Your own time could not be saved.',
    hi: 'आपका अपना समय सहेजा नहीं जा सका।',
  },
  'schedule.removeTime': { en: 'Remove {{time}}', hi: '{{time}} हटाएँ' },
  'schedule.chosenTimes': { en: 'Times you have chosen', hi: 'आपने जो समय चुने हैं' },
  'schedule.unnamedTime': { en: 'This time has no name', hi: 'इस समय का कोई नाम नहीं है' },
  'schedule.nameThisTime': { en: 'Give this time a name', hi: 'इस समय को नाम दें' },
  'schedule.onlyWhenNeeded': { en: 'Only when needed', hi: 'सिर्फ़ ज़रूरत पड़ने पर' },
  // ── THE HINDI NOUN FOR "REMINDER" IS `रिमाइंडर`, HERE AND ON EVERY SCREEN ──
  //
  // This screen said `याद दिलाना` — a verb phrase ("to remind") pressed into service as a
  // noun, so "no reminder will ring" came out as "कोई याद दिलाना नहीं बजेगा", which reads
  // as "no to-remind will ring". `setup/slots.tsx` said the coined `याद-दिलावट`, and
  // `settings/slots.tsx` said `रिमाइंडर`. Three screens of ONE feature, three names for the
  // thing being configured: a woman going setup → schedule → settings had no way to be sure
  // they were the same thing, and this screen alone used two of them (see
  // `schedule.readBackInstruction` twenty lines down, which already said `रिमाइंडर`).
  //
  // `रिमाइंडर` is what the rest of the app overwhelmingly says and what an Indian speaker of
  // this generation says out loud. It is grammatically MASCULINE — `बजेगा`, not `बजेगी` —
  // which is what the verb here already was, so only the noun moves.
  //
  // The VERB forms are deliberately left alone. "याद कब दिलानी है" / "की याद आती रहेगी" are
  // ordinary Hindi and are not naming the feature; it is only the noun that had three names.
  'schedule.prnHelp': {
    en: 'No reminder will ring. You record it yourself on the day you take it.',
    hi: 'कोई रिमाइंडर नहीं बजेगा। जिस दिन लें, उस दिन आप खुद दर्ज करेंगी।',
  },
  'schedule.whichDays': { en: 'On which days?', hi: 'किन दिनों?' },
  'schedule.quantity': { en: 'How much each time?', hi: 'हर बार कितनी?' },
  'schedule.quantityHalf': { en: 'Half', hi: 'आधी' },
  'schedule.quantityOne': { en: 'One', hi: 'एक' },
  'schedule.quantityTwo': { en: 'Two', hi: 'दो' },
  'schedule.quantityOther': { en: 'Something else', hi: 'कुछ और' },
  'schedule.quantityOtherLabel': { en: 'Write it in your own words', hi: 'अपने शब्दों में लिखें' },
  'schedule.food': { en: 'Food', hi: 'खाना' },
  'schedule.previewTitle': { en: 'Check this before you save', hi: 'सहेजने से पहले यह जाँच लें' },
  'schedule.previewEveryDay': {
    en: 'You will be reminded at {{times}}, every day.',
    hi: 'आपको हर दिन {{times}} बजे याद दिलाया जाएगा।',
  },
  'schedule.previewSomeDays': {
    en: 'You will be reminded at {{times}}, on {{days}}.',
    hi: 'आपको {{days}} को {{times}} बजे याद दिलाया जाएगा।',
  },
  'schedule.previewPrn': {
    en: 'No reminder will ring for this medicine. It is only when needed.',
    hi: 'इस दवाई के लिए कोई रिमाइंडर नहीं बजेगा। यह सिर्फ़ ज़रूरत पड़ने पर है।',
  },
  'schedule.previewNothing': {
    en: 'Choose at least one time, or choose "Only when needed".',
    hi: 'कम से कम एक समय चुनें, या "सिर्फ़ ज़रूरत पड़ने पर" चुनें।',
  },
  // The count, as a NUMBER. The preview and the read-back both list the times, and a list
  // is the one form in which an accidental extra tick is invisible — she would have to
  // count fifteen boxes to notice, and the read-back scrolls. "Three times a day" is also
  // how the dose was said to her at the OPD, so it is the form she can check against what
  // she was told without translating anything.
  'schedule.doseCountOne': { en: 'Once a day', hi: 'दिन में एक बार' },
  'schedule.doseCountMany': { en: '{{count}} times a day', hi: 'दिन में {{count}} बार' },
  // Past `MANY_DOSES_IN_A_DAY`. It asks and it does not refuse — see the constant. The
  // wording makes no claim about what a medicine needs, because the app does not know
  // that; it describes what SHE has ticked and hands the decision back to her doctor.
  'schedule.manyTimes': {
    en: 'You have chosen {{count}} times for this one medicine',
    hi: 'आपने इसी एक दवाई के लिए {{count}} समय चुने हैं',
  },
  'schedule.manyTimesBody': {
    en: 'Please read the times once more and check each one — with so many to choose from, one is easy to tick by accident. If your doctor gave you all of them, keep them.',
    hi: 'कृपया समयों को एक बार फिर पढ़कर हर एक को जाँच लें — इतने सारे समयों में से गलती से कोई एक चुना जाना आसान है। अगर आपके डॉक्टर ने ये सभी समय दिए हैं, तो इन्हें रहने दें।',
  },
  'schedule.readBackTitle': { en: 'Read these times back', hi: 'ये समय पढ़ लें' },
  'schedule.readBackInstruction': {
    en: 'This medicine will be reminded at the times below, and at no others.',
    hi: 'इस दवाई का रिमाइंडर नीचे लिखे समयों पर ही आएगा, किसी और समय पर नहीं।',
  },
  'schedule.readBackChange': { en: 'Change something', hi: 'कुछ बदलना है' },
  'schedule.save': { en: 'Save these timings', hi: 'ये समय सहेजें' },
  'schedule.saved': { en: 'Timings saved', hi: 'समय सहेज लिए गए' },
  'schedule.changeTitle': { en: 'This is a change', hi: 'यह एक बदलाव है' },
  'schedule.noDaysChosen': {
    en: 'Choose at least one day of the week.',
    hi: 'हफ़्ते का कम से कम एक दिन चुनें।',
  },
};

const FOOD_OPTIONS: readonly NonNullable<DoseSchedule['foodRelation']>[] = [
  'before',
  'after',
  'with',
  'empty',
  'any',
];

/** Quantity chips. Anything else goes in `quantity_text` as free words. */
const QUANTITY_CHOICES: readonly { value: number; key: string }[] = [
  { value: 0.5, key: 'schedule.quantityHalf' },
  { value: 1, key: 'schedule.quantityOne' },
  { value: 2, key: 'schedule.quantityTwo' },
];

/**
 * Above this many times in one day for ONE medicine, the screen asks her to look again.
 *
 * IT IS A NOTICE, NOT A CAP, and the difference is the whole point. A cap would refuse to
 * record something a real prescription can say: a steroid taper, a hospital regimen, a
 * four-hourly antibiotic. An app that will not write down what her doctor actually told her
 * is worse than useless — it sends her back to paper for the one medicine she most needs
 * reminding about, and the app then has an incomplete picture for the OPD report as well.
 *
 * WHY SIX. Six is the top of what an outpatient regimen for a single medicine reaches in
 * ordinary use: four-times-a-day is four, six-hourly is four, and four-hourly across a
 * waking day is five or six. Seven means either something genuinely unusual — which she
 * should be able to record, and can — or the far more likely thing, a thumb resting on a
 * 106dp chip row during a scroll. Setting it lower would fire on ordinary QID prescriptions
 * and teach her to scroll past it, which is how a warning stops being one.
 *
 * DELIBERATELY NOT `MAX_AI_DOSES_PER_DAY` (features/ai/frequency.ts). That one is a hard
 * cap of four on what the AI extractor may propose from a photographed prescription,
 * because a machine reading a blurry label has no way to be sure and the cost of it
 * inventing a fifth dose is a tablet taken that was never prescribed. This is the human
 * path: she is not guessing, she is copying what she was told, and the app's job here is to
 * make the number visible, not to overrule her.
 */
const MANY_DOSES_IN_A_DAY = 6;

/** One chosen dose time, with the slot it came from — null when the time has no name. */
type ChosenTime = { time: string; def: SlotDefinition | null };

type LoadedState = {
  medicine: Medicine;
  existing: DoseSchedule[];
  slotTimes: Record<BuiltinSlotKey, string>;
  customSlots: CustomSlot[];
};

export default function ScheduleScreen() {
  const t = useT(STRINGS);
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { formatTime } = useDateFormat();

  const rawThreadId = useLocalSearchParams<{ threadId?: string | string[] }>().threadId;
  const threadId = Array.isArray(rawThreadId) ? rawThreadId[0] : rawThreadId;

  // Only used to hold the screen until the profile has resolved; every write below
  // uses the medicine's own profile id, which is the one the rows actually belong to.
  const profile = useProfileId();

  // `resolveSlots()` decomposed into its two halves on purpose. This screen can ADD a
  // custom slot, and both `validateCustomSlots` and `buildSlotDefinitions` need the built-in
  // times and the custom list as separate values — reconstructing the times out of a flat
  // `SlotDefinition[]` afterwards would be the same two reads plus a lossy round trip.
  const state = useAsync<LoadedState | null>(async () => {
    if (!threadId) return null;
    const medicine = await getCurrentVersion(threadId);
    if (!medicine) return null;
    const [existing, slotTimes, customSlots] = await Promise.all([
      getCurrentSchedules(threadId),
      getSlotTimes(medicine.profileId),
      getCustomSlots(medicine.profileId),
    ]);
    return { medicine, existing, slotTimes, customSlots };
  }, [threadId]);

  const builtinTimes = state.data?.slotTimes ?? DEFAULT_SLOT_TIMES;
  const isChange = (state.data?.existing.length ?? 0) > 0;

  const [selectedKeys, setSelectedKeys] = useState<SlotKey[]>([]);
  // Bare times with no slot behind them. Seeded from existing rows, never created here —
  // see the file header. "Other times" in the UI, `slot_key = NULL` in the database.
  const [otherTimes, setOtherTimes] = useState<string[]>([]);
  const [customSlots, setCustomSlots] = useState<readonly CustomSlot[]>([]);
  const [isPrn, setIsPrn] = useState(false);
  const [daysMask, setDaysMask] = useState(ALL_DAYS);
  const [quantityValue, setQuantityValue] = useState<number | null>(1);
  const [quantityOther, setQuantityOther] = useState(false);
  const [quantityText, setQuantityText] = useState('');
  const [foodRelation, setFoodRelation] = useState<NonNullable<DoseSchedule['foodRelation']>>('any');
  /**
   * The naming dialog: closed, or open by one of its two doors.
   *
   * `'new'` is "Add your own time" — a time she has not chosen yet, seeded from the
   * registry. `'name'` is "Give this time a name" on a row that already exists — a bare
   * time carried in from an older version of this medicine, whose minute must NOT move. The
   * two differ only in their title and their seed, but they differ in the title on purpose:
   * the dialog that opens has to be recognisable as the thing the button she pressed said
   * it would do, or the tap reads as having done something else.
   */
  const [customForm, setCustomForm] = useState<'new' | 'name' | null>(null);
  const [customLabel, setCustomLabel] = useState('');
  /**
   * `'HH:MM'`, not an hour and a minute. The steppers are `stepWallClock` from the registry,
   * which both screens now share, so 23:55 + five minutes is 00:00 rather than 23:00 — a
   * counter that wraps its minutes while pinning its hour quietly makes the last five
   * minutes of the day unreachable from either direction.
   */
  const [customTime, setCustomTime] = useState('');
  /**
   * A refusal, rendered inside the dialog and left there.
   *
   * NOT A TOAST, for two reasons. The toast host is an in-tree overlay, so anything raised
   * while this dialog is open renders behind it (see `components/ui/Toast.tsx`) — she would
   * never see it. And a refusal is not feedback on a completed action: it is a thing she has
   * to act on, and it must still be on screen while she does.
   */
  const [customError, setCustomError] = useState<string | null>(null);
  const [addingSlot, setAddingSlot] = useState(false);
  const [readBack, setReadBack] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Every slot this profile has — nine built-ins plus her own — in the order of the clock
   * SHE configured, not the order they are declared in. With fifteen possible chips the
   * only thing that can be scanned reliably is the time, so the list must run forwards.
   */
  const defs = useMemo(
    () => buildSlotDefinitions(builtinTimes, customSlots),
    [builtinTimes, customSlots],
  );

  /**
   * Seed the form from the version currently in force.
   *
   * A change screen that opens blank turns "move the evening dose half an hour" into
   * "re-enter everything", and the failure mode of re-entering everything is leaving
   * one of the times out. Seeded once per medicine, never on reload, so it can never
   * overwrite something she has already typed.
   *
   * Derived during render rather than in an effect: the seed is a pure function of the
   * loaded row, so this way the form is never painted blank for a frame before filling in.
   */
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (state.data && seededFor !== state.data.medicine.id) {
    const loaded = state.data;
    setSeededFor(loaded.medicine.id);
    setCustomSlots(loaded.customSlots);

    const existing = loaded.existing;
    if (existing.length > 0) {
      const prn = existing.every((slot) => slot.scheduleType === 'PRN');
      setIsPrn(prn);

      if (!prn) {
        // MATCHED BY TIME, NOT BY THE STORED `slot_key`. The key on the row records what
        // she chose when it was written, and a slot's time can have been moved in Settings
        // since. Re-selecting the stored key would then silently drag the dose to the new
        // time on a screen she opened to change the days; matching on the time keeps the
        // dose exactly where it is and simply loses the name, which is the safe direction.
        const seedDefs = buildSlotDefinitions(loaded.slotTimes, loaded.customSlots);
        const keys: SlotKey[] = [];
        const bare: string[] = [];
        for (const slot of existing) {
          if (slot.scheduleType !== 'FIXED' || !slot.timeLocal) continue;
          const named = slotForTime(seedDefs, slot.timeLocal);
          if (named) keys.push(named.key);
          else bare.push(slot.timeLocal);
        }
        setSelectedKeys(keys);
        setOtherTimes(bare);
      }

      const first = existing[0];
      if (first) {
        if (!prn) setDaysMask(first.daysMask);
        if (first.quantityText) {
          setQuantityOther(true);
          setQuantityText(first.quantityText);
        } else if (first.quantityValue !== null) {
          // A quantity that is not one of the chips (three tablets, say) leaves every chip
          // unselected and is carried through unchanged. Preserving her doctor's number is
          // worth more than making a chip light up.
          setQuantityValue(first.quantityValue);
        }
        setFoodRelation(first.foodRelation ?? 'any');
      }
    }
  }

  /**
   * Tick or untick one slot.
   *
   * THE COLLISION GUARD LIVES HERE, and it names both slots. Two slots on the same clock
   * time is one stepper tap away in Settings (Before lunch 13:30, After lunch 14:00), and
   * the failure it causes further down is silent: the write deduplicates by time, so she
   * would see two chips ticked and get one reminder. Told here, on the screen where she
   * ticked the second one, the message can say which two and what to do about it.
   *
   * A bare time on the same clock is ADOPTED rather than refused: the time does not move,
   * it only gains a name, which is exactly what this change is for.
   */
  const toggleSlot = useCallback(
    (def: SlotDefinition) => {
      if (selectedKeys.includes(def.key)) {
        setSelectedKeys((current) => current.filter((key) => key !== def.key));
        return;
      }

      const clash = defs.find(
        (other) =>
          other.key !== def.key && other.time === def.time && selectedKeys.includes(other.key),
      );
      if (clash) {
        toast.show({
          message: t('schedule.sameTime', {
            first: slotLabel(clash, t),
            second: slotLabel(def, t),
            time: formatTime(def.time),
          }),
          variant: 'error',
        });
        return;
      }

      setIsPrn(false);
      setOtherTimes((current) => current.filter((time) => time !== def.time));
      setSelectedKeys((current) => [...current, def.key]);
    },
    [selectedKeys, defs, toast, t, formatTime],
  );

  /**
   * The first pair of slots sitting on one clock time, if there is one.
   *
   * PERSISTENT, not a toast. This used to be reported only when she tapped the second of
   * the pair: a 4.5-second toast carrying a twenty-word Hindi sentence naming two slots
   * whose first three words are identical, after which the chip stayed unticked and looked
   * exactly like every other unticked chip. The honest reading of that is "the app ignored
   * my tap". Both slot screens already raise a Banner for the same condition; this one,
   * where the choice actually decides when a tablet rings, now does too.
   *
   * It is derived from `defs`, not from the selection, because the condition belongs to
   * her settings and is true whether or not she has ticked anything.
   */
  const timeClash = useMemo((): { first: SlotDefinition; second: SlotDefinition } | null => {
    // `defs` is sorted by time, so equal NEIGHBOURS are the only possible pair.
    const at = defs.findIndex((def, index) => index > 0 && defs[index - 1]?.time === def.time);
    const first = at > 0 ? defs[at - 1] : undefined;
    const second = at > 0 ? defs[at] : undefined;
    return first !== undefined && second !== undefined ? { first, second } : null;
  }, [defs]);

  /**
   * The slot already holding this one's minute — non-null only while that other slot is
   * ticked, which is exactly when ticking this one would abort the save.
   */
  const blockedBy = useCallback(
    (def: SlotDefinition): SlotDefinition | null => {
      if (selectedKeys.includes(def.key)) return null;
      return (
        defs.find(
          (other) =>
            other.key !== def.key && other.time === def.time && selectedKeys.includes(other.key),
        ) ?? null
      );
    },
    [defs, selectedKeys],
  );

  const toggleDay = useCallback((bit: number) => {
    setDaysMask((current) => current ^ (1 << bit));
  }, []);

  const customClock = splitWallClock(customTime);

  /**
   * Open the dialog on a time that is FREE, derived from her own day.
   *
   * It used to open on a hard-coded 09:00. If she already had something on 09:00 — one of
   * her own times, or a built-in she had moved there — the form opened ALREADY IN CONFLICT:
   * she typed a name, pressed the button, and was told the time was taken. The app had
   * pre-loaded a value that could never work and then handed her the failure, leaving her to
   * discover on her own that the steppers were the way out. `defaultNewCustomSlotTime`
   * guarantees the one property that matters — the seed is never already taken — and it is
   * the same function `settings/slots.tsx` calls, so the two doors open on the same minute.
   */
  const openNewCustomTime = useCallback(() => {
    setCustomLabel('');
    setCustomError(null);
    setCustomTime(defaultNewCustomSlotTime(builtinTimes, customSlots));
    setCustomForm('new');
  }, [builtinTimes, customSlots]);

  /**
   * Open the dialog on a time she ALREADY has, so naming it is two taps and no retyping.
   *
   * The seed is that exact minute and it must stay that minute: this row is a dose that is
   * already ringing, and the point of naming it is to give it a word, not to move it.
   */
  const nameThisTime = useCallback((time: string) => {
    setCustomLabel('');
    setCustomError(null);
    setCustomTime(time);
    setCustomForm('name');
  }, []);

  /** Never while the write is in flight — see `addCustomSlot`. */
  const closeCustomTime = useCallback(() => {
    if (addingSlot) return;
    setCustomForm(null);
    setCustomError(null);
  }, [addingSlot]);

  /**
   * Turn the name and the time in the picker into a real slot on this profile.
   *
   * IT IS SAVED TO THE PROFILE IMMEDIATELY, before the schedule itself. A `slot_key` is
   * only worth writing if something can later resolve it to a name, so the slot has to
   * exist on the profile before any row points at it. The cost is that abandoning this
   * screen leaves an unused slot behind, which is visible and removable in Settings and
   * changes no reminder — a far smaller price than a dose row naming a slot nobody has.
   *
   * THAT COST IS NOW STATED BEFORE SHE PAYS IT, in the dialog: the time is added for every
   * medicine, and the way back is Settings. It used to be said nowhere at all. She would
   * add "with tea" while setting up one tablet, decide against it, back out — and find it on
   * every medicine's picker afterwards, counting against her six, with nothing on this
   * screen admitting it had happened or hinting where it could be undone.
   *
   * Every rejection comes from `validateCustomSlots`, which is also what `setCustomSlots`
   * enforces, so the picker and the store can never disagree about what is acceptable.
   */
  const addCustomSlot = useCallback(async () => {
    const profileId = state.data?.medicine.profileId;
    if (!profileId || addingSlot) return;

    const next: CustomSlot = {
      key: newCustomSlotKey(),
      label: customLabel.trim(),
      time: customTime,
    };
    const check = validateCustomSlots([...customSlots, next], builtinTimes);
    if (!check.ok) {
      setCustomError(customSlotMessage(check.issue, defs, t, formatTime));
      return;
    }

    setAddingSlot(true);
    try {
      await storeCustomSlots(profileId, check.slots);
    } catch (error) {
      console.warn('[schedule] could not save the custom slot', error);
      // The dialog STAYS OPEN on a failure, carrying the name she typed. Closing it would
      // throw away her words and leave her to guess whether anything had happened.
      setCustomError(t('schedule.ownTimeSaveFailed'));
      return;
    } finally {
      setAddingSlot(false);
    }

    setCustomSlots(check.slots);
    setIsPrn(false);
    // Same adoption as `toggleSlot`: if she had this exact time as a bare one, it has just
    // been given the name she typed rather than being duplicated beside it.
    setOtherTimes((current) => current.filter((time) => time !== next.time));
    setSelectedKeys((current) => (current.includes(next.key) ? current : [...current, next.key]));
    setCustomLabel('');
    setCustomError(null);
    // Closed BEFORE the toast, and that ordering is the point: the toast host is an in-tree
    // overlay, so a toast raised under an open Dialog is hidden behind it.
    setCustomForm(null);
    toast.show({
      message: t(SLOT_OWN_TIME_KEYS.added, { name: next.label }),
      variant: 'success',
    });
  }, [
    state.data,
    addingSlot,
    customLabel,
    customTime,
    customSlots,
    builtinTimes,
    defs,
    toast,
    t,
    formatTime,
  ]);

  const removeTime = useCallback(
    (time: string) => {
      setSelectedKeys((current) =>
        current.filter((key) => defs.find((def) => def.key === key)?.time !== time),
      );
      setOtherTimes((current) => current.filter((item) => item !== time));
    },
    [defs],
  );

  /**
   * The times this save will write, in clock order, each with the slot it came from.
   *
   * KEYED BY TIME, AND THAT IS THE PROOF THAT THE INSERT IS SAFE. Every row written by
   * `handleSave` comes from one entry of this list, so `dose_schedule` can never receive two
   * rows with the same `time_local` for one version and `UNIQUE (thread_id, version,
   * time_local)` can never abort. `toggleSlot` is what stops the situation arising at all;
   * this is what stops it becoming a rolled-back save if it ever does.
   *
   * A built-in or custom slot wins over a bare time on the same clock, because a named time
   * is the one that can still be read six months later in the OPD report.
   */
  const chosen = useMemo<ChosenTime[]>(() => {
    if (isPrn) return [];
    const byTime = new Map<string, SlotDefinition | null>();
    for (const key of selectedKeys) {
      const def = defs.find((item) => item.key === key);
      if (!def || !isWallClock(def.time) || byTime.has(def.time)) continue;
      byTime.set(def.time, def);
    }
    for (const time of otherTimes) {
      if (!isWallClock(time) || byTime.has(time)) continue;
      byTime.set(time, null);
    }
    return [...byTime.entries()]
      .map(([time, def]) => ({ time, def }))
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }, [isPrn, selectedKeys, otherTimes, defs]);

  const dayNames = useMemo(() => selectedDayNames(daysMask, t), [daysMask, t]);
  const everyDay = (daysMask & ALL_DAYS) === ALL_DAYS;

  const preview = useMemo(() => {
    if (isPrn) return t('schedule.previewPrn');
    if (chosen.length === 0) return t('schedule.previewNothing');
    if ((daysMask & ALL_DAYS) === 0) return t('schedule.noDaysChosen');
    const list = joinList(
      chosen.map((entry) => formatTime(entry.time)),
      t('common.and'),
    );
    return everyDay
      ? t('schedule.previewEveryDay', { times: list })
      : t('schedule.previewSomeDays', { times: list, days: joinList(dayNames, t('common.and')) });
  }, [isPrn, chosen, daysMask, everyDay, dayNames, formatTime, t]);

  /**
   * How many times a day this one medicine will ring — as a NUMBER, in words she can check
   * against what the doctor said. Empty while she has chosen nothing, and while the medicine
   * is "only when needed", because neither of those rings at all.
   */
  const doseCountLine = useMemo((): string | null => {
    if (isPrn || chosen.length === 0) return null;
    return chosen.length === 1
      ? t('schedule.doseCountOne')
      : t('schedule.doseCountMany', { count: chosen.length });
  }, [isPrn, chosen, t]);

  /** See `MANY_DOSES_IN_A_DAY`. It asks; it never blocks the save. */
  const manyDoses = !isPrn && chosen.length > MANY_DOSES_IN_A_DAY;

  const canSave = isPrn || (chosen.length > 0 && (daysMask & ALL_DAYS) !== 0);

  const handleSave = useCallback(async () => {
    if (!threadId || !state.data || !canSave || saving) return;
    setSaving(true);
    try {
      const medicine = state.data.medicine;
      const startedOn = toLocalDate();
      const quantity = quantityOther ? null : quantityValue;
      const text = quantityOther ? quantityText.trim() : '';

      const slots: ScheduleSlot[] = isPrn
        ? [
            {
              timeLocal: null,
              scheduleType: 'PRN',
              quantityValue: quantity,
              quantityText: text === '' ? null : text,
              foodRelation,
            },
          ]
        : chosen.map((entry) => ({
            timeLocal: entry.time,
            // Null for a time with no slot behind it. Borrowing the name of whatever slot
            // happens to sit on that minute today would put a word in the OPD report that
            // she never chose, and that word can change the next time Settings is touched.
            slotKey: entry.def?.key ?? null,
            scheduleType: 'FIXED' as const,
            daysMask,
            quantityValue: quantity,
            quantityText: text === '' ? null : text,
            foodRelation,
          }));

      const input = {
        threadId,
        medicineId: medicine.id,
        startedOn,
        slots,
        // False here on purpose. The rows are written unconfirmed and then confirmed
        // by the explicit call below, so there is exactly one place in the codebase
        // where a human sign-off on a frequency happens.
        confirmedByUser: false,
      };

      if (state.data.existing.length === 0) await createInitialSchedules(input);
      else await createScheduleVersion(input);

      await confirmCurrentSchedules(threadId);

      // RECONCILE COMES LAST, AND ONLY AFTER THE CONFIRM.
      // `trg_occ_requires_confirmed_schedule` refuses to create a dose occurrence for
      // an unconfirmed schedule row, so a reconcile run before the confirm would walk
      // the calendar, produce nothing for this medicine, and publish an alarm horizon
      // with it missing. The alarms would then stay silent until something else
      // happened to trigger another reconcile — which, for a user who does not open
      // the app, may be never.
      await reconcile(medicine.profileId);

      setReadBack(false);
      toast.show({ message: t('schedule.saved'), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [
    threadId,
    state.data,
    canSave,
    saving,
    quantityOther,
    quantityValue,
    quantityText,
    isPrn,
    chosen,
    daysMask,
    foodRelation,
    toast,
    t,
    router,
  ]);

  if (!threadId) {
    return (
      <Screen>
        <ScreenHeader title={t('schedule.title')} onBack={() => router.back()} />
        <EmptyState title={t('errors.notFound')} icon="alert" />
      </Screen>
    );
  }

  if (state.loading || profile.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('schedule.title')} onBack={() => router.back()} />
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={72} label={t('a11y.loading')} />
          <Skeleton height={180} />
          <Skeleton height={120} />
        </View>
      </Screen>
    );
  }

  if (!state.data) {
    return (
      <Screen>
        <ScreenHeader title={t('schedule.title')} onBack={() => router.back()} />
        <EmptyState title={t('errors.notFound')} icon="alert" />
      </Screen>
    );
  }

  const customFull = customSlots.length >= MAX_CUSTOM_SLOTS;

  return (
    <Screen
      variant="scroll"
      background="bgSunken"
      footer={
        <Button
          title={t('schedule.save')}
          onPress={() => setReadBack(true)}
          variant="primary"
          size="xl"
          fullWidth
          disabled={!canSave}
        />
      }
    >
      <ScreenHeader
        title={t('schedule.title')}
        subtitle={t('schedule.forMedicine', { name: state.data.medicine.nameAsWritten })}
        onBack={() => router.back()}
      />

      {/* Whose schedule this is — the active profile is a device-global pointer a carer can
          have switched. No-ops on a single-profile install. */}
      <ActiveProfileTag />

      <View style={{ gap: spacing.lg }}>
        {isChange ? (
          <Banner
            variant="info"
            title={t('schedule.changeTitle')}
            message={t('medicines.changeDoseNotice')}
          />
        ) : null}

        {/* ── Named slots ─────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('schedule.whichTimes')}</Text>
          {/* Rendered through a constant rather than a quoted key so the sentence can live
              once, in the registry, next to the settings banner it has to agree with —
              see `SLOT_SETTINGS_NOTE_KEY`. */}
          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xs }}>
            {t(SLOT_SETTINGS_NOTE_KEY)}
          </Text>

          {/* ABOVE THE TIMES, NOT BELOW THEM. It is the one choice that makes the whole
              column irrelevant, and for this patient it is the sublingual nitrate. With
              nine built-in slots plus her own, the column below runs past a screenful at a
              large text scale; leaving this underneath it meant scrolling past every meal
              chip to reach an option she had no reason to believe was down there. */}
          <View style={{ paddingTop: spacing.md, gap: spacing.md }}>
            <Chip
              label={t('schedule.onlyWhenNeeded')}
              selected={isPrn}
              selectionMode="multiple"
              onPress={() => {
                setIsPrn((value) => !value);
                setSelectedKeys([]);
                setOtherTimes([]);
              }}
            />
            {isPrn ? (
              <Text variant="body" tone="muted">
                {t('schedule.prnHelp')}
              </Text>
            ) : null}
          </View>

          {isPrn ? null : (
            <View style={{ paddingTop: spacing.md, gap: spacing.md }}>
              <Divider strong />

              {/* Persistent, and it names both. A toast that is gone in 4.5 seconds cannot
                  carry a twenty-word Hindi sentence about two slots whose first three
                  words are identical. */}
              {timeClash ? (
                <Banner
                  variant="attention"
                  title={t('schedule.sameTimeTitle')}
                  message={t('schedule.sameTime', {
                    first: slotLabel(timeClash.first, t),
                    second: slotLabel(timeClash.second, t),
                    time: formatTime(timeClash.first.time),
                  })}
                />
              ) : null}

              {/* Above the list it is asking her to re-read, and persistent — the condition
                  is still true after four and a half seconds. Attention, not destructive:
                  nothing is wrong yet, and dressing an "are you sure" in the same red as a
                  deletion teaches her to dismiss both. */}
              {manyDoses ? (
                <Banner
                  variant="attention"
                  title={t('schedule.manyTimes', { count: chosen.length })}
                  message={t('schedule.manyTimesBody')}
                />
              ) : null}

              {/* ABOVE THE CHIPS, so ticking one has visible feedback without scrolling to
                  the far end of a column that can be fifteen items long. */}
              {chosen.length > 0 ? (
                <View style={{ gap: spacing.sm }}>
                  <Text variant="label">{t('schedule.chosenTimes')}</Text>
                  {/* The count, before the list rather than after it. Fifteen tickable chips
                      make "how many did I choose?" a question the list itself cannot answer
                      at a glance. */}
                  {doseCountLine ? <Text variant="title">{doseCountLine}</Text> : null}
                  {chosen.map((entry) => (
                    <ChosenRow
                      key={entry.time}
                      title={
                        entry.def
                          ? `${slotLabel(entry.def, t)} · ${formatTime(entry.time)}`
                          : formatTime(entry.time)
                      }
                      note={entry.def ? null : t('schedule.unnamedTime')}
                      removeLabel={t('schedule.removeTime', { time: formatTime(entry.time) })}
                      onRemove={() => removeTime(entry.time)}
                      nameLabel={entry.def || customFull ? null : t('schedule.nameThisTime')}
                      onName={() => nameThisTime(entry.time)}
                    />
                  ))}
                </View>
              ) : null}

              {/*
                ONE CHIP PER ROW, RUNNING DOWN THE CLOCK. Four chips wrapped into a tidy
                grid; fifteen wrap into a shape with no reading order, and the one thing
                that can be scanned reliably is the time — which only works if the times run
                downwards. A plain column does it: no `flexWrap`, and no `grow` either,
                because in a column container `flexGrow`/`flexBasis` size the HEIGHT. The
                chips are full width here because a column stretches its children, and they
                keep their 56dp minimum.
              */}
              <View style={{ gap: spacing.sm }}>
                {defs.map((def) => {
                  const blocking = blockedBy(def);
                  const conflict =
                    blocking === null
                      ? null
                      : t('schedule.sameTimeChip', { other: slotLabel(blocking, t) });
                  return (
                    <View key={def.key} style={{ gap: spacing.xs }}>
                      <Chip
                        // Slot name AND literal clock time, always together. With Before
                        // dinner at 20:00 and After dinner at 20:30 the name alone no
                        // longer identifies a time.
                        label={`${slotLabel(def, t)} · ${formatTime(def.time)}`}
                        selected={selectedKeys.includes(def.key)}
                        selectionMode="multiple"
                        // Marked unavailable rather than silently swallowing the tap: the
                        // other slot on this minute is already ticked, and two rows with
                        // one `time_local` abort the save on the UNIQUE constraint.
                        disabled={conflict !== null}
                        accessibilityHint={conflict ?? undefined}
                        onPress={() => toggleSlot(def)}
                      />
                      {conflict !== null ? (
                        <Text variant="caption" tone="destructive">
                          {conflict}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>

              {/* Opens the dialog rather than unfolding a block above the fold — see the
                  header. The label is the registry's, so this button and the one in
                  Settings say the same six words. */}
              <Button
                title={t(SLOT_OWN_TIME_KEYS.add)}
                onPress={openNewCustomTime}
                variant="secondary"
                size="md"
                icon="plus"
                disabled={customFull}
              />
              {customFull ? (
                <View style={{ gap: spacing.xs }}>
                  <Text variant="body" tone="muted">
                    {t(SLOT_OWN_TIME_KEYS.full, { max: MAX_CUSTOM_SLOTS })}
                  </Text>
                  {/* The way out, said where the limit is stated. Without it the six slots
                      look permanent and the button looks broken. */}
                  <Text variant="body" tone="muted">
                    {t(SLOT_OWN_TIME_KEYS.removeHint)}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </Card>

        {/* ── Days ────────────────────────────────────────────────────────── */}
        {isPrn ? null : (
          <Card>
            <Text variant="label">{t('schedule.whichDays')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md }}>
              {[0, 1, 2, 3, 4, 5, 6].map((bit) => (
                <Chip
                  key={bit}
                  label={t(`date.weekdayShort.${bit + 1}`)}
                  selected={(daysMask & (1 << bit)) !== 0}
                  selectionMode="multiple"
                  onPress={() => toggleDay(bit)}
                />
              ))}
            </View>
          </Card>
        )}

        {/* ── Quantity ────────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('schedule.quantity')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md }}>
            {QUANTITY_CHOICES.map((choice) => (
              <Chip
                key={choice.value}
                label={t(choice.key)}
                selected={!quantityOther && quantityValue === choice.value}
                selectionMode="single"
                grow
                onPress={() => {
                  setQuantityOther(false);
                  setQuantityValue(choice.value);
                }}
              />
            ))}
            <Chip
              label={t('schedule.quantityOther')}
              selected={quantityOther}
              selectionMode="single"
              grow
              onPress={() => setQuantityOther(true)}
            />
          </View>
          {quantityOther ? (
            <View style={{ paddingTop: spacing.md }}>
              <TextField
                label={t('schedule.quantityOtherLabel')}
                value={quantityText}
                onChangeText={setQuantityText}
                helper={t('common.optional')}
              />
            </View>
          ) : null}
        </Card>

        {/* ── Food ────────────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('schedule.food')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md }}>
            {FOOD_OPTIONS.map((option) => (
              <Chip
                key={option}
                label={t(`medicines.food.${option}`)}
                selected={foodRelation === option}
                selectionMode="single"
                grow
                onPress={() => setFoodRelation(option)}
              />
            ))}
          </View>
        </Card>

        {/* ── The preview she reads before anything is written ─────────────── */}
        <Card variant="outlined">
          <Text variant="label">{t('schedule.previewTitle')}</Text>
          {doseCountLine ? (
            <Text variant="title" style={{ paddingTop: spacing.sm }}>
              {doseCountLine}
            </Text>
          ) : null}
          <Text variant="body" style={{ paddingTop: spacing.sm }} accessibilityLiveRegion="polite">
            {preview}
          </Text>
        </Card>
      </View>

      {/*
        THE READ-BACK GATE. Ticking six chips scattered down a scrolling column is easy to
        get wrong and impossible to check from the chips themselves, so the times are listed
        back in clock order — name and literal time on every line — and the write happens on
        the far side of this dialog and nowhere else. Backdrop dismissal is off: a stray tap
        must not be able to resolve a decision about when a TB dose rings.
      */}
      <Dialog
        visible={readBack}
        title={t('schedule.readBackTitle')}
        dismissOnBackdrop={false}
        onRequestClose={() => {
          if (!saving) setReadBack(false);
        }}
        scrollable
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('schedule.readBackChange')}
              onPress={() => setReadBack(false)}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={saving}
            />
            <Button
              title={t('schedule.save')}
              onPress={() => void handleSave()}
              variant="primary"
              size="xl"
              fullWidth
              loading={saving}
            />
          </View>
        }
      >
        <Text variant="body" tone="muted">
          {isPrn ? t('schedule.prnHelp') : t('schedule.readBackInstruction')}
        </Text>
        {/* The count again, at the gate. She has scrolled a long way to get here and the
            boxes below scroll too; the number is the only form of this that can be checked
            without counting. */}
        {doseCountLine ? <Text variant="title">{doseCountLine}</Text> : null}
        {/* The soft confirmation. It sits INSIDE the gate she has to pass anyway rather
            than being a second dialog stacked on the first — one more "are you sure" on top
            of a read-back is a thing to dismiss, not a thing to read. Save stays enabled. */}
        {manyDoses ? (
          <Banner
            variant="attention"
            title={t('schedule.manyTimes', { count: chosen.length })}
            message={t('schedule.manyTimesBody')}
          />
        ) : null}
        {chosen.map((entry) => (
          <View
            key={entry.time}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={
              entry.def
                ? `${slotLabel(entry.def, t)}. ${formatTime(entry.time)}`
                : formatTime(entry.time)
            }
            style={{
              paddingVertical: spacing.md,
              paddingHorizontal: spacing.md,
              borderRadius: radii.md,
              borderWidth: 2,
              borderColor: colors.borderStrong,
              backgroundColor: colors.bgSunken,
              gap: spacing.xs,
            }}
          >
            <Text variant="title">{formatTime(entry.time)}</Text>
            <Text variant="body" tone="muted">
              {entry.def ? slotLabel(entry.def, t) : t('schedule.unnamedTime')}
            </Text>
          </View>
        ))}
        <Text variant="body">{preview}</Text>
      </Dialog>

      {/*
        NAMING A TIME OF HER OWN.

        A dialog, not the inline block this used to be, because the button that opens it
        lives at the bottom of a card taller than the screen and the block opened above the
        fold — see the header. Backdrop dismissal is off: this form writes to the profile,
        and a tremor is not a decision. The title matches the button she pressed.
      */}
      <Dialog
        visible={customForm !== null}
        title={
          customForm === 'name' ? t('schedule.nameThisTime') : t(SLOT_OWN_TIME_KEYS.newTitle)
        }
        dismissOnBackdrop={false}
        onRequestClose={closeCustomTime}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={closeCustomTime}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={addingSlot}
            />
            <Button
              title={t(SLOT_OWN_TIME_KEYS.addConfirm)}
              onPress={() => void addCustomSlot()}
              variant="primary"
              size="xl"
              fullWidth
              loading={addingSlot}
            />
          </View>
        }
      >
        {/* Above the field it is about, and it stays until she fixes it. `attention` and an
            icon, so it is not colour alone that says something needs attending to. */}
        {customError !== null ? <Banner variant="attention" title={customError} /> : null}

        <TextField
          label={t(SLOT_OWN_TIME_KEYS.name)}
          value={customLabel}
          onChangeText={setCustomLabel}
          helper={t(SLOT_OWN_TIME_KEYS.nameHelp, { max: MAX_CUSTOM_SLOT_LABEL })}
          maxLength={MAX_CUSTOM_SLOT_LABEL}
        />

        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <Stepper
            label={t(SLOT_OWN_TIME_KEYS.hour)}
            value={pad(customClock.hour)}
            onDecrease={() => setCustomTime((current) => stepWallClock(current, -60))}
            onIncrease={() => setCustomTime((current) => stepWallClock(current, 60))}
            decreaseLabel={t(SLOT_OWN_TIME_KEYS.hourDown)}
            increaseLabel={t(SLOT_OWN_TIME_KEYS.hourUp)}
          />
          <Stepper
            label={t(SLOT_OWN_TIME_KEYS.minute)}
            value={pad(customClock.minute)}
            onDecrease={() => setCustomTime((current) => stepWallClock(current, -SLOT_MINUTE_STEP))}
            onIncrease={() => setCustomTime((current) => stepWallClock(current, SLOT_MINUTE_STEP))}
            decreaseLabel={t(SLOT_OWN_TIME_KEYS.minuteDown)}
            increaseLabel={t(SLOT_OWN_TIME_KEYS.minuteUp)}
          />
        </View>

        {isWallClock(customTime) ? (
          <Text variant="display" align="center">
            {formatTime(customTime)}
          </Text>
        ) : null}
        <Text variant="body" tone="muted">
          {t(SLOT_OWN_TIME_KEYS.clockNote)}
        </Text>

        {/* WHAT SHE IS ACTUALLY DOING, before she does it: this is a profile-wide time, and
            the way back is Settings. Both sentences are needed — the scope without the undo
            path is a warning she can do nothing with, and the undo path without the scope
            does not explain why she would ever want it. */}
        <Banner
          variant="info"
          title={t('schedule.ownTimeScope')}
          message={t(SLOT_OWN_TIME_KEYS.removeHint)}
        />
      </Dialog>
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// One chosen time
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A full-width row rather than the wrapping pill this used to be. The pill fitted four
 * times; nine of them wrap into a shape with no reading order, and an unnamed time needs
 * room for its own "give this a name" button underneath.
 */
function ChosenRow({
  title,
  note,
  removeLabel,
  onRemove,
  nameLabel,
  onName,
}: {
  title: string;
  note: string | null;
  removeLabel: string;
  onRemove: () => void;
  nameLabel: string | null;
  onName: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View
      style={{
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.lg,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgElevated,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text variant="body">{title}</Text>
          {note ? (
            <Text variant="caption" tone="muted">
              {note}
            </Text>
          ) : null}
        </View>
        <PressableScale
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={removeLabel}
          style={{
            width: spacing.touchTarget,
            height: spacing.touchTarget,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="close" size={24} color={colors.textMuted} />
        </PressableScale>
      </View>
      {nameLabel ? (
        <Button title={nameLabel} onPress={onName} variant="secondary" size="md" fullWidth />
      ) : null}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stepper — the 24-hour escape hatch
// ═══════════════════════════════════════════════════════════════════════════════

function Stepper({
  label,
  value,
  onDecrease,
  onIncrease,
  decreaseLabel,
  increaseLabel,
}: {
  label: string;
  value: string;
  onDecrease: () => void;
  onIncrease: () => void;
  decreaseLabel: string;
  increaseLabel: string;
}) {
  const { colors } = useTheme();

  const key = (icon: 'minus' | 'plus', onPress: () => void, accessibilityLabel: string) => (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: spacing.touchTarget,
        height: spacing.touchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgElevated,
      }}
    >
      <Icon name={icon} size={26} color={colors.text} />
    </PressableScale>
  );

  return (
    <View style={{ flex: 1, gap: spacing.sm }}>
      <Text variant="caption" tone="muted" align="center">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        {key('minus', onDecrease, decreaseLabel)}
        <Text variant="title" align="center" style={{ flex: 1 }}>
          {value}
        </Text>
        {key('plus', onIncrease, increaseLabel)}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Why a custom slot was refused, in her language.
 *
 * `validateCustomSlots` returns a typed reason rather than a sentence precisely so this
 * mapping can live next to the screen that has to render it — an English string thrown from
 * the registry could not be translated at the point it is caught. `duplicate_time` names the
 * slot that is already there, because "choose a different time" without saying which time is
 * taken is an instruction she cannot follow.
 */
function customSlotMessage(
  issue: CustomSlotIssue,
  defs: readonly SlotDefinition[],
  t: (key: string, params?: Record<string, string | number>) => string,
  formatTime: (time: string) => string,
): string {
  switch (issue.reason) {
    case 'too_many':
      return t(SLOT_OWN_TIME_KEYS.full, { max: issue.max });
    case 'label_empty':
      return t('schedule.ownTimeNameNeeded');
    case 'label_too_long':
      return t('schedule.ownTimeNameTooLong', { max: issue.max });
    case 'label_reserved': {
      const owner = defs.find((def) => def.key === issue.slot);
      return t('schedule.ownTimeNameReserved', {
        name: issue.label,
        time: owner ? formatTime(owner.time) : issue.slot,
      });
    }
    case 'duplicate_time': {
      const other = slotDefForKey(defs, issue.otherKey);
      return other
        ? t('schedule.ownTimeTaken', {
            name: slotLabel(other, t),
            time: formatTime(issue.time),
          })
        : t('schedule.ownTimeTakenUnknown', { time: formatTime(issue.time) });
    }
    // `bad_key` and `duplicate_key` cannot happen from this screen — the key is freshly
    // minted — and a malformed time cannot come out of two steppers. Kept exhaustive so a
    // new reason in the registry surfaces here rather than falling through silently.
    default:
      return t('schedule.ownTimeInvalid');
  }
}

/** 'a, b and c' — the conjunction comes from the bundle, so Hindi reads naturally. */
function joinList(parts: readonly string[], and: string): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  const head = parts.slice(0, -1).join(', ');
  return `${head} ${and} ${parts[parts.length - 1] ?? ''}`;
}

function selectedDayNames(
  daysMask: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < 7; bit += 1) {
    if ((daysMask & (1 << bit)) !== 0) names.push(t(`date.weekdayShort.${bit + 1}`));
  }
  return names;
}
