/**
 * The named dose times — nine built-in, plus any the user invents herself.
 *
 * ─── WHY STEPPERS AND NOT THE NATIVE TIME PICKER ──────────────────────────────
 * Android's picker renders in 12-hour form on several OEM skins regardless of what the
 * app asks for, and it puts AM/PM in a small control beside a spinner. When the number
 * being set is the hour a tablet is taken, "8:00" read without its marker is a dose taken
 * twelve hours from when it was meant to be. Two ±buttons per field, and a 24-hour
 * readout that cannot be anything else, remove the ambiguity entirely — and they are
 * also far easier to hit with a tremor than a spinning wheel.
 *
 * Minutes move in fives. A doctor says "eight o'clock", never "eight-oh-seven", and five
 * taps to cross an hour is a stepper nobody uses.
 *
 * ─── WHY THE PICKERS MOVED INTO A DIALOG ──────────────────────────────────────
 * This screen used to be one card per slot, each about 200dp tall. At four slots that was
 * a scroll; at nine it is roughly 1800dp of it, and the user this app is built for cannot
 * hold "which of these have I already checked" across that much scrolling. So the nine
 * are three named groups of compact rows — name left, time right, whole row tappable —
 * and the big steppers open one slot at a time. NOTHING SHRANK: the ± buttons are still
 * 72×56, the readout is still `display`, and there is no auto-advance.
 *
 * ─── WHERE THE LAYOUT ITSELF LIVES ────────────────────────────────────────────
 * `src/features/slots/SlotEditor.tsx`, shared with `src/app/setup/slots.tsx`. Both files
 * used to carry a copy of the group cards, the row, the readout and the stepper under a
 * comment instructing the next person to keep them identical. They were not identical: the
 * two screens laid the stepper out differently, gave TalkBack two different Hindi
 * sentences for the same button, and this file's private minute arithmetic never carried
 * into the hour — "five minutes later" from 08:55 landed on 08:00. All of it now moves
 * through `stepWallClock` in the registry, which is pure and tested.
 *
 * ─── WHAT CHANGING A TIME HERE ACTUALLY DOES ──────────────────────────────────
 * It changes what the app OFFERS. It does not move an existing medicine.
 * `dose_schedule.time_local` is written from these times at the moment a medicine's
 * schedule is saved (`src/app/medicine/schedule.tsx`, `slotKeyForTime` and `times`), the
 * table is append-only (`trg_dose_schedule_no_update`), and both `buildCandidates` and
 * `buildAlarmRules` in `src/features/dosing/reconcile.ts` read `schedule.timeLocal` and
 * never consult a slot time at all. So the banner says exactly that. It used to promise
 * that every medicine at this time of day would move, which was not true, and "we told
 * her the TB dose moved and it did not" is the worst failure this screen can have.
 *
 * `reconcile` still runs after every save — the occurrence rows and the alarm horizon are
 * rebuilt from the database, and re-arming after any settings write is cheap insurance.
 *
 * ─── WHY SAVE GOES THROUGH A READ-BACK ────────────────────────────────────────
 * Every reminder in the app resolves through these nine-plus-six times, and this screen
 * writes all of them at once and then re-arms every alarm on the phone. `medicine/
 * schedule.tsx` — which decides when ONE medicine rings — already gates its write behind a
 * dialog that lists every time in clock order. This screen, which decides when ALL of them
 * ring from now on, used to write on a single tap of a button in the footer, on a screen
 * where a stray press on a row and one stepper tap is enough to move a meal by an hour
 * without anything on screen going red. The read-back lists ONLY WHAT CHANGED, in clock
 * order, before and after — a list of nine unchanged times is a list nobody reads.
 *
 * It is a `Dialog` and not the `ReadBackDialog` component on purpose: that component
 * renders ONE spoken-form sentence at `display` size, which is right for "142 over 88" and
 * wrong for a list. Everything else about the pattern is kept — the backdrop cannot
 * resolve it, "change something" sits first so the finger that lands without reading lands
 * on the harmless one, and the write happens on the far side of it and nowhere else.
 *
 * ─── CUSTOM TIMES ─────────────────────────────────────────────────────────────
 * Up to `MAX_CUSTOM_SLOTS` slots the user names herself. The label is HER text: it is
 * never translated, never passed through `t()`, and is stored trimmed. Everything about
 * what is acceptable lives in `validateCustomSlots`; this screen only turns its `reason`
 * into a sentence in her language. The copy for the naming form lives in the registry
 * (`SLOT_OWN_TIME_KEYS`), so this screen and the schedule screen cannot word the same
 * action two different ways again.
 *
 * REMOVING one is deliberately allowed rather than blocked, and the confirmation says
 * plainly what happens: nothing rings differently. A medicine keeps its own
 * `time_local`, reconcile never reads `slot_key`, so removal costs the NAME and nothing
 * else. Blocking removal would imply the opposite — that the name is what makes the
 * reminder — and that is the belief this app must not leave her holding.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import {
  BUILTIN_SLOT_KEYS,
  DEFAULT_SLOT_TIMES,
  MAX_CUSTOM_SLOTS,
  MAX_CUSTOM_SLOT_LABEL,
  SLOT_OWN_TIME_KEYS,
  defaultNewCustomSlotTime,
  getCustomSlots,
  getSlotTimes,
  isBuiltinSlotKey,
  newCustomSlotKey,
  setCustomSlots,
  setSlotTimes,
  slotI18nKey,
  stepWallClock,
  useAsync,
  useProfileId,
  useT,
  validateCustomSlots,
  validateSlotTimes,
  type BuiltinSlotKey,
  type CustomSlot,
  type CustomSlotIssue,
  type LocalStrings,
  type SlotKey,
} from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Dialog,
  Icon,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  SLOT_EDITOR_STRINGS,
  SlotGroupCards,
  SlotRow,
  SlotStepper,
  SlotTimeReadout,
  slotChangeTitle,
  slotConflictLine,
} from '@/features/slots/SlotEditor';
import { listActiveMedicines } from '@/db/repositories/medicines';
import { getCurrentSchedulesForThreads } from '@/db/repositories/schedules';
import { reconcile } from '@/features/dosing/reconcile';
import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

const STRINGS: LocalStrings = {
  // One spread, and the shared layout has every string it draws — the slot names, the
  // group headings, the row hint, the stepper wording, and the "a time of your own" copy
  // that this screen and `medicine/schedule.tsx` must word identically. See the note at
  // the top of `SlotEditor.tsx`.
  ...SLOT_EDITOR_STRINGS,
  'slots.title': { en: 'Medicine times of day', hi: 'दवाई के समय' },
  'slots.subtitle': {
    en: 'These are the times Aarogya offers you when you set up a medicine.',
    hi: 'दवाई लगाते समय आरोग्य आपको यही समय देता है।',
  },
  'slots.warningTitle': {
    en: 'These times are for medicines you set up from now on',
    hi: 'ये समय उन दवाइयों के लिए हैं जो अब से लगाई जाएँगी',
  },
  'slots.warningBody': {
    en: 'Changing a time here changes what Aarogya offers you the next time you set up a medicine. A medicine you have already set up keeps the exact time you gave it — open that medicine to move it. Anything already recorded as taken stays exactly as it is.',
    hi: 'यहाँ समय बदलने से वह समय बदलता है जो अगली बार दवाई लगाते समय आरोग्य आपको देगा। जो दवाई पहले से लगी है, वह उसी समय पर रहती है जो आपने उसे दिया था — उसे बदलने के लिए वह दवाई खोलिए। जो पहले से ली हुई दर्ज है, वह जैसी है वैसी ही रहती है।',
  },
  'slots.notAdvice': {
    en: 'These are your own timings, not a doctor’s instruction. Set them to when you really eat and sleep.',
    hi: 'ये आपके अपने समय हैं, कोई डॉक्टरी सलाह नहीं। इन्हें वैसा ही रखिए जैसे आप सचमुच खाती और सोती हैं।',
  },
  'slots.clockNote': {
    en: 'Times are shown on a 24-hour clock, so 20:00 means 8 in the evening.',
    hi: 'समय 24 घंटे की घड़ी में दिखाया जाता है, यानी 20:00 का मतलब शाम के 8 बजे।',
  },
  'slots.saved': {
    en: 'The times are saved and the reminders have been set again.',
    hi: 'समय सहेज लिए गए और रिमाइंडर दोबारा लगा दिए गए।',
  },
  'slots.saveFailed': { en: 'The times could not be saved.', hi: 'समय सहेजे नहीं जा सके।' },
  'slots.rearmFailed': {
    en: 'The times were saved, but the reminders could not be set again. Open the reminder check.',
    hi: 'समय तो सहेज लिए गए, पर रिमाइंडर दोबारा नहीं लग पाए। रिमाइंडर जाँच खोलें।',
  },

  'slots.conflictTitle': { en: 'Two times are the same', hi: 'दो समय एक जैसे हैं' },
  'slots.conflictBody': {
    en: '{{first}} and {{second}} are both set to {{time}}. One medicine cannot be reminded twice at the very same minute, so please move one of them before saving.',
    hi: '{{first}} और {{second}}, दोनों {{time}} पर लगे हैं। एक ही दवाई की याद एक ही मिनट पर दो बार नहीं दिलाई जा सकती, इसलिए सहेजने से पहले इनमें से एक को बदल दीजिए।',
  },

  // ── Custom times ──
  //
  // The form's own copy — heading, buttons, field label, helper, "you have six already" —
  // is NOT here. It lives in `SLOT_STRINGS` and is reached through `SLOT_OWN_TIME_KEYS`,
  // because `medicine/schedule.tsx` draws the same form and the two had drifted into two
  // different vocabularies for one action ('Add Your Own Time' against 'Add a time of your
  // own'). Those seven strings were also the only multi-word Title Case UI strings in the
  // app outside proper nouns — every button, tab, heading and label elsewhere, including
  // the ones a few lines up in this very file, is sentence case. They are sentence case
  // now, once, in the registry.
  'slots.customEmpty': {
    en: 'You have not added any. The nine times above suit most medicines — add your own only if you were given a time that is not there.',
    hi: 'आपने अभी कोई नहीं जोड़ा है। ऊपर के नौ समय ज़्यादातर दवाइयों के लिए ठीक रहते हैं — अपना समय तभी जोड़िए जब आपको कोई ऐसा समय दिया गया हो जो ऊपर न हो।',
  },

  // ── What validateCustomSlots refuses, said in words ──
  'slots.errLabelEmpty': {
    en: 'Please give this time a name.',
    hi: 'कृपया इस समय को कोई नाम दीजिए।',
  },
  'slots.errLabelLong': {
    en: 'The name can be at most {{max}} letters.',
    hi: 'नाम ज़्यादा से ज़्यादा {{max}} अक्षर का हो सकता है।',
  },
  // NAMES THE SLOT. It used to say "one of the times above", which was a claim the screen
  // could not always back: the reserved set included retired names the user can see
  // nowhere, so a woman typing सुबह was told the app already used that word for a time she
  // could look at nine of and not find. The reserved set is now built-ins only, and the
  // sentence points at the one it means.
  'slots.errLabelReserved': {
    en: 'Aarogya already calls the {{time}} time “{{other}}”. Please choose a different name.',
    hi: 'आरोग्य {{time}} वाले समय को पहले से “{{other}}” कहता है। कृपया कोई दूसरा नाम चुनिए।',
  },
  'slots.errTimeTaken': {
    en: '{{other}} is already at {{time}}. Please choose a different time.',
    hi: '{{other}} पहले से {{time}} पर है। कृपया कोई दूसरा समय चुनिए।',
  },
  'slots.customBlockedTitle': {
    en: 'One of your own times cannot be saved',
    hi: 'आपके अपने समयों में से एक सहेजा नहीं जा सकता',
  },
  'slots.errCustomGeneric': {
    en: 'This time could not be saved. Please check the name and the time.',
    hi: 'यह समय सहेजा नहीं जा सका। कृपया नाम और समय देख लीजिए।',
  },

  // ── Removing a custom time ──
  'slots.removeTitle': { en: 'Remove “{{label}}”?', hi: '“{{label}}” हटाएँ?' },
  'slots.removeNone': {
    en: 'No medicine is set to {{time}} at the moment. Aarogya will simply stop offering this name when you set up a medicine.',
    hi: 'अभी कोई दवाई {{time}} पर नहीं लगी है। दवाई लगाते समय आरोग्य बस यह नाम दिखाना बंद कर देगा।',
  },
  'slots.removeInUse': {
    en: '{{names}} — set to {{time}} — will still be reminded at {{time}}. Removing this name does not move or stop a single reminder. Only the name “{{label}}” goes away, and those medicines will show {{time}} instead.',
    hi: '{{names}} — जो {{time}} पर लगी है — की याद {{time}} पर ही आती रहेगी। यह नाम हटाने से कोई भी रिमाइंडर न रुकता है न बदलता है। सिर्फ़ “{{label}}” नाम चला जाएगा और उन दवाइयों पर उसकी जगह {{time}} दिखेगा।',
  },
  'slots.removeUnknown': {
    en: 'Aarogya could not check which medicines use {{time}} just now. Removing this name does not move or stop any reminder — only the name “{{label}}” goes away.',
    hi: 'आरोग्य अभी यह नहीं देख पाया कि कौन सी दवाइयाँ {{time}} पर लगी हैं। यह नाम हटाने से कोई रिमाइंडर न रुकता है न बदलता है — सिर्फ़ “{{label}}” नाम चला जाता है।',
  },
  // Sentence case, and no capital on the article. It read 'Remove The Name', which is
  // wrong under any title-case rule and doubly wrong in an app whose every other button
  // ('Try again', 'Not now', 'Correct it', 'Yes, save it') is a plain sentence.
  'slots.removeConfirm': { en: 'Remove the name', hi: 'नाम हटाएँ' },

  // ── The read-back before Save ──
  'slots.reviewTitle': { en: 'Read these changes back', hi: 'ये बदलाव पढ़ लें' },
  'slots.reviewInstruction': {
    en: 'These are the times you have changed. Read it out loud if that helps. Every reminder Aarogya sets up from now on goes by them.',
    hi: 'ये वे समय हैं जो आपने बदले हैं। पढ़कर बोल लेने से आसानी हो तो बोल लीजिए। अब से आरोग्य जो भी रिमाइंडर लगाएगा, वह इन्हीं से चलेगा।',
  },
  'slots.reviewNothing': {
    en: 'Nothing has changed. The times are exactly as they were.',
    hi: 'कुछ नहीं बदला। समय ठीक वैसे ही हैं जैसे थे।',
  },
  'slots.reviewChange': { en: 'Change something', hi: 'कुछ बदलना है' },
  // No arrow anywhere in these. TalkBack reads '→' as "right arrow" mid-sentence or drops
  // it, and the before/after relation is the entire content of the line.
  'slots.reviewMoved': { en: 'was {{from}}, now {{to}}', hi: 'पहले {{from}}, अब {{to}}' },
  'slots.reviewAdded': { en: 'new, at {{time}}', hi: 'नया, {{time}} पर' },
  // Says what a removal costs, in the read-back and not only in the confirmation she saw
  // several taps ago: the NAME goes, the minute does not, and nothing stops ringing.
  'slots.reviewRemoved': {
    en: 'removed. The name goes away; {{time}} itself does not change and nothing stops ringing.',
    hi: 'हटाया गया। नाम चला जाएगा; {{time}} वैसा ही रहेगा और कोई रिमाइंडर बंद नहीं होता।',
  },
  'slots.reviewRenamed': {
    en: 'at {{time}}, and used to be called “{{from}}”',
    hi: '{{time}} पर, और पहले इसका नाम “{{from}}” था',
  },
  'slots.reviewRenamedMoved': {
    en: 'was “{{from}}” at {{fromTime}}, now at {{toTime}}',
    hi: 'पहले “{{from}}” {{fromTime}} पर था, अब {{toTime}} पर',
  },
};

/** '<a>, <b> and <c>' — the app's own list joiner, so the conjunction is translated. */
function joinList(parts: readonly string[], and: string): string {
  if (parts.length <= 1) return parts[0] ?? '';
  const head = parts.slice(0, -1).join(', ');
  return `${head} ${and} ${parts[parts.length - 1]}`;
}

/** What is open in the picker dialog. Built-ins edit live; a custom slot edits a draft. */
type Editing =
  | { readonly kind: 'builtin'; readonly slot: BuiltinSlotKey }
  | { readonly kind: 'custom'; readonly draft: CustomSlot; readonly isNew: boolean }
  | null;

/** One line of the read-back: what it is called now, what happened to it, when it lands. */
type SlotChange = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  /** The clock time the line sorts on — the NEW one, or the old one for a removal. */
  readonly at: string;
};

export default function SlotsScreen() {
  const t = useT(STRINGS);
  const { formatTime } = useDateFormat();
  const { colors } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();
  const profileState = useProfileId();
  const profileId = profileState.data;

  const [times, setTimes] = useState<Record<BuiltinSlotKey, string>>({ ...DEFAULT_SLOT_TIMES });
  const [customs, setCustoms] = useState<CustomSlot[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  const stored = useAsync(async () => {
    if (!profileId) return null;
    const [loadedTimes, loadedCustoms] = await Promise.all([
      getSlotTimes(profileId),
      getCustomSlots(profileId),
    ]);
    return { times: loadedTimes, customs: loadedCustoms };
  }, [profileId]);

  const loaded = stored.data;
  const reloadStored = stored.reload;
  // Adopted ONCE PER LOAD, during render, and only while the user has not edited
  // anything — so a reload cannot quietly throw away four taps she has already made.
  //
  // Keyed on the identity of the loaded object rather than on `dirty`. Keying on `dirty`
  // meant that clearing the flag re-ran the adoption: a successful save sets `dirty`
  // false, which re-applied the times read at mount and snapped the screen back to the
  // 08:00 she had just moved to 07:30, while app_meta held the new value. Once a given
  // load has been adopted it is never adopted again.
  const [adoptedFrom, setAdoptedFrom] = useState<typeof loaded>(null);
  if (loaded && !dirty && adoptedFrom !== loaded) {
    setAdoptedFrom(loaded);
    setTimes(loaded.times);
    setCustoms(loaded.customs);
  }

  const adjust = useCallback((slot: BuiltinSlotKey, deltaMinutes: number) => {
    setDirty(true);
    setTimes((current) => ({
      ...current,
      [slot]: stepWallClock(current[slot], deltaMinutes),
    }));
  }, []);

  /**
   * The visible name of any slot key, built-in or custom.
   *
   * NEVER THE RAW KEY. It used to end `?? key`, which put `custom:9f3a1c02` inside a
   * sentence the user is being asked to act on — reachable whenever the clash names a
   * custom slot that is no longer in `customs` (a removal committed between this memo and
   * the banner rendering, or a blob written by some future build). A hex identity is not a
   * thing to show a patient. `atTime` is the clock time the caller already knows the key
   * sits on, which is both true and useful; `common.unknown` is the last resort, for a
   * caller that has no time either.
   *
   * A blank label falls through the same way. `validateCustomSlots` refuses an empty name,
   * so a committed slot always has one, but an empty string renders as an unnamed row and
   * TalkBack announces it as an unlabelled button.
   */
  const nameForKey = useCallback(
    (key: SlotKey, atTime?: string): string => {
      if (isBuiltinSlotKey(key)) return t(slotI18nKey(key));
      const found = customs.find((custom) => custom.key === key);
      if (found && found.label.trim() !== '') return found.label;
      return atTime === undefined ? t('common.unknown') : formatTime(atTime);
    },
    [t, customs, formatTime],
  );

  /**
   * The first pair of slots sitting on one clock time, across BOTH kinds.
   *
   * Two slots at the same minute is not cosmetic: `dose_schedule` has
   * `UNIQUE (thread_id, version, time_local)`, so a medicine ticked for both aborts its
   * own save behind a generic error on a screen that cannot explain it. Only the FIRST
   * pair is reported — fixing it re-runs this and surfaces the next, which is a shorter
   * sentence than a list and cannot leave her wondering which one she has dealt with.
   *
   * Built-ins are checked first because `validateCustomSlots` measures customs against
   * the built-in times and would otherwise report a pair that is only half the problem.
   */
  const customCheck = useMemo(() => validateCustomSlots(customs, times), [customs, times]);

  const clash = useMemo((): { first: SlotKey; second: SlotKey; time: string } | null => {
    const builtins = validateSlotTimes(times);
    if (!builtins.ok && builtins.issue.reason === 'duplicate_time') {
      const [first, second] = builtins.issue.slots;
      return { first, second, time: builtins.issue.time };
    }
    if (!customCheck.ok && customCheck.issue.reason === 'duplicate_time') {
      const offending = customs[customCheck.index];
      if (offending) {
        return { first: customCheck.issue.otherKey, second: offending.key, time: offending.time };
      }
    }
    return null;
  }, [times, customs, customCheck]);

  /** The other slot a given key collides with, for the row caption. */
  const conflictPartner = useCallback(
    (key: SlotKey): string | null => {
      if (!clash) return null;
      // Both members of a clash sit on `clash.time` by definition, so that is the right
      // fallback for either of them.
      if (key === clash.first) return nameForKey(clash.second, clash.time);
      if (key === clash.second) return nameForKey(clash.first, clash.time);
      return null;
    },
    [clash, nameForKey],
  );

  // ── Custom slots ───────────────────────────────────────────────────────────

  /** A refusal from the registry, said in the user's language. */
  const issueMessage = useCallback(
    (issue: CustomSlotIssue): string => {
      switch (issue.reason) {
        case 'label_empty':
          return t('slots.errLabelEmpty');
        case 'label_too_long':
          return t('slots.errLabelLong', { max: issue.max });
        case 'label_reserved':
          return t('slots.errLabelReserved', {
            other: t(slotI18nKey(issue.slot)),
            time: formatTime(times[issue.slot]),
          });
        case 'duplicate_time':
          return t('slots.errTimeTaken', {
            other: nameForKey(issue.otherKey, issue.time),
            time: formatTime(issue.time),
          });
        case 'too_many':
          // The same sentence the card shows when the list is full, from one place.
          return t(SLOT_OWN_TIME_KEYS.full, { max: issue.max });
        default:
          // `bad_key`, `duplicate_key`, `not_wall_clock` — all of them mean this screen
          // built something malformed, which is a bug, not a thing she can correct.
          return t('slots.errCustomGeneric');
      }
    },
    [t, nameForKey, formatTime, times],
  );

  /**
   * Anything `validateCustomSlots` refuses that is NOT a clock clash — a clash has its own
   * banner, which names both slots. This should be unreachable, because every custom slot
   * is committed through that same validator, but a blob written by some future build
   * would land here and a Save the registry will throw on must not look available. It is
   * a message rather than a boolean so the dead Save button always has a reason beside it.
   */
  const customProblem = useMemo((): string | null => {
    if (customCheck.ok || customCheck.issue.reason === 'duplicate_time') return null;
    const offending = customs[customCheck.index];
    const reason = issueMessage(customCheck.issue);
    return offending ? `${offending.label} — ${reason}` : reason;
  }, [customCheck, customs, issueMessage]);

  const blocked = clash !== null || customProblem !== null;

  const openNewCustom = useCallback(() => {
    setCustomError(null);
    setEditing({
      kind: 'custom',
      isNew: true,
      // From the registry, so this screen and `medicine/schedule.tsx` open on the same
      // minute — and so the form never opens on a time that is already taken.
      draft: { key: newCustomSlotKey(), label: '', time: defaultNewCustomSlotTime(times, customs) },
    });
  }, [times, customs]);

  const commitCustom = useCallback(() => {
    if (editing?.kind !== 'custom') return;
    const { draft, isNew } = editing;
    const proposed: CustomSlot = { ...draft, label: draft.label.trim() };
    const next = isNew
      ? [...customs, proposed]
      : customs.map((custom) => (custom.key === proposed.key ? proposed : custom));

    const check = validateCustomSlots(next, times);
    if (!check.ok) {
      setCustomError(issueMessage(check.issue));
      return;
    }
    // Stored as the validator returned them, not as they were typed: it trims, so a
    // trailing space can never reach a chip or a TalkBack label.
    setCustoms([...check.slots]);
    setDirty(true);
    setCustomError(null);
    setEditing(null);
  }, [editing, customs, times, issueMessage]);

  /**
   * Which medicines are actually reminded at this time right now.
   *
   * `listActiveMedicines` is exactly what `reconcile` schedules from, so the names shown
   * are the ones whose reminders the user is worried about. A schedule counts if it
   * carries this slot's key OR simply sits on its clock time — the key is only written
   * when the medicine was set up from the slot, and the time is what actually rings.
   */
  const medicinesAt = useCallback(
    async (slot: CustomSlot): Promise<string[]> => {
      // Throws rather than answering "none": the caller turns a failure into a message
      // that makes no claim about medicines, and "none" is a claim.
      if (!profileId) throw new Error('no profile');
      const medicines = await listActiveMedicines(profileId);
      const byThread = await getCurrentSchedulesForThreads(medicines.map((m) => m.threadId));
      const names: string[] = [];
      for (const medicine of medicines) {
        const schedules = byThread.get(medicine.threadId) ?? [];
        const uses = schedules.some(
          (schedule) =>
            schedule.scheduleType === 'FIXED' &&
            (schedule.slotKey === slot.key || schedule.timeLocal === slot.time),
        );
        if (uses) names.push(medicine.nameAsWritten);
      }
      return names;
    },
    [profileId],
  );

  const removeCustom = useCallback(
    async (slot: CustomSlot) => {
      // The STORED slot, not the one being edited: `dose_schedule` rows were written from
      // whatever was saved, so an unsaved edit would name the wrong hour in the message —
      // and the name in the question has to be the name she is looking at in the list.
      const committed = loaded?.customs.find((custom) => custom.key === slot.key) ?? slot;
      const time = formatTime(committed.time);
      const label = committed.label;

      // The picker closes BEFORE the question is asked. `useConfirm` renders its own
      // Modal at the app root, and two Modals on screen at once is a stack whose order
      // Android decides — the one case where the answer must be unmistakably on top of
      // the thing it is about. Declining reopens the picker with her draft intact.
      setEditing(null);

      let message: string;
      try {
        const names = await medicinesAt(committed);
        message =
          names.length === 0
            ? t('slots.removeNone', { time })
            : t('slots.removeInUse', {
                names: joinList(names, t('common.and')),
                time,
                label,
              });
      } catch (error) {
        // A failed lookup must not become a silent "nothing uses this". The message drops
        // the claim it can no longer make and keeps the one that is always true.
        console.warn('[slots] could not check which medicines use this time', error);
        message = t('slots.removeUnknown', { time, label });
      }

      const yes = await confirm({
        title: t('slots.removeTitle', { label }),
        message,
        confirmLabel: t('slots.removeConfirm'),
        destructive: true,
      });
      if (!yes) {
        setEditing({ kind: 'custom', isNew: false, draft: slot });
        return;
      }

      setCustoms((current) => current.filter((custom) => custom.key !== slot.key));
      setDirty(true);
      setCustomError(null);
    },
    [loaded, formatTime, medicinesAt, confirm, t],
  );

  // ── The read-back ──────────────────────────────────────────────────────────

  /**
   * Only what CHANGED, in clock order, against what is actually on disk.
   *
   * A read-back listing all fifteen times is a read-back nobody reads; the point of it is
   * that an accidental stepper tap shows up as a line that was not expected. Compared
   * against `loaded`, which is re-read after every save, so a second round of edits is
   * measured against what the first round wrote and not against what was on disk at mount.
   *
   * The `DEFAULT_SLOT_TIMES` fallback covers the sliver of time before the first read
   * lands — during which the screen genuinely is showing the defaults, so the comparison
   * still describes the rows she is looking at.
   */
  const changes = useMemo((): SlotChange[] => {
    const baseTimes = loaded?.times ?? DEFAULT_SLOT_TIMES;
    const baseCustoms = loaded?.customs ?? [];
    const out: SlotChange[] = [];

    for (const slot of BUILTIN_SLOT_KEYS) {
      const before = baseTimes[slot];
      const after = times[slot];
      if (before === after) continue;
      out.push({
        id: slot,
        name: t(slotI18nKey(slot)),
        detail: t('slots.reviewMoved', { from: formatTime(before), to: formatTime(after) }),
        at: after,
      });
    }

    const wasByKey = new Map(baseCustoms.map((custom) => [custom.key, custom]));
    for (const custom of customs) {
      const before = wasByKey.get(custom.key);
      if (!before) {
        out.push({
          id: custom.key,
          name: custom.label,
          detail: t('slots.reviewAdded', { time: formatTime(custom.time) }),
          at: custom.time,
        });
        continue;
      }
      const moved = before.time !== custom.time;
      const renamed = before.label !== custom.label;
      if (!moved && !renamed) continue;
      out.push({
        id: custom.key,
        name: custom.label,
        at: custom.time,
        detail:
          moved && renamed
            ? t('slots.reviewRenamedMoved', {
                from: before.label,
                fromTime: formatTime(before.time),
                toTime: formatTime(custom.time),
              })
            : moved
              ? t('slots.reviewMoved', {
                  from: formatTime(before.time),
                  to: formatTime(custom.time),
                })
              : t('slots.reviewRenamed', {
                  time: formatTime(custom.time),
                  from: before.label,
                }),
      });
    }

    const live = new Set(customs.map((custom) => custom.key));
    for (const before of baseCustoms) {
      if (live.has(before.key)) continue;
      out.push({
        id: before.key,
        name: before.label,
        detail: t('slots.reviewRemoved', { time: formatTime(before.time) }),
        at: before.time,
      });
    }

    // 'HH:MM' sorts correctly as text, which is the whole reason the times are stored
    // this way. Ties keep insertion order, which is the canonical slot order.
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [loaded, times, customs, t, formatTime]);

  // ── Saving ─────────────────────────────────────────────────────────────────

  const save = useCallback(async () => {
    if (!profileId || saving || blocked) return;
    setSaving(true);
    try {
      // Times first, then customs: `setCustomSlots` validates against the times ALREADY
      // STORED, so writing them the other way round would measure her new custom slot
      // against yesterday's built-in times.
      await setSlotTimes(profileId, times);
      await setCustomSlots(profileId, customs);
    } catch (error) {
      console.warn('[slots] could not save the slot times', error);
      toast.show({ message: t('slots.saveFailed'), variant: 'error' });
      setSaving(false);
      setReviewing(false);
      return;
    }

    try {
      // Saving the times only changes the numbers in app_meta. Reconcile rebuilds the
      // occurrence rows and re-publishes the alarm horizon from the database, so the
      // native layer is never left holding a plan that no longer matches what is stored.
      await reconcile(profileId);
      toast.show({ message: t('slots.saved'), variant: 'success' });
      setDirty(false);
    } catch (error) {
      console.warn('[slots] saved the times but could not re-arm', error);
      toast.show({ message: t('slots.rearmFailed'), variant: 'error' });
      setDirty(false);
    } finally {
      setSaving(false);
      setReviewing(false);
      // RE-READ WHAT WAS WRITTEN. `removeCustom` asks its destructive question about the
      // COMMITTED slot — the one `dose_schedule` rows were written from — and it reads it
      // out of `stored.data`. Without this, `stored.data` is whatever was on disk when the
      // screen mounted: move a custom slot from 15:00 to 16:00, save, then press Remove,
      // and the confirmation names 3:00 pm and looks up the medicines at 3:00 pm while the
      // slot she is actually removing is 4:00 pm. She would be answering a destructive
      // question about the wrong time. The read-back above reads the same snapshot, so it
      // would otherwise keep offering the first round of changes a second time.
      //
      // Safe against stomping unsaved work: the adoption below is keyed on the identity of
      // the loaded object AND on `dirty`, so a reload that lands after she has started
      // editing again updates the committed snapshot without touching her draft.
      reloadStored();
    }
  }, [profileId, saving, blocked, times, customs, t, toast, reloadStored]);

  const goBack = useCallback(async () => {
    if (!dirty) {
      router.back();
      return;
    }
    const leave = await confirm({
      title: t('entry.common.discardTitle'),
      message: t('entry.common.discardMessage'),
      confirmLabel: t('entry.common.discardConfirm'),
    });
    if (leave) router.back();
  }, [dirty, confirm, t]);

  // Narrowed once, here, rather than at each of the fifteen places the two dialogs reach
  // into it. `editing` is a discriminated union and every handler inside a dialog needs
  // the same guard; pulling it out keeps those handlers one line each.
  const builtinEditing = editing?.kind === 'builtin' ? editing : null;
  const customEditing = editing?.kind === 'custom' ? editing : null;

  const editingBuiltinName = builtinEditing ? t(slotI18nKey(builtinEditing.slot)) : '';
  const builtinPartner = builtinEditing ? conflictPartner(builtinEditing.slot) : null;

  return (
    <Screen
      variant="scroll"
      background="bgSunken"
      footer={
        <Button
          title={t('common.save')}
          // Opens the read-back. The write lives on the far side of it and nowhere else.
          onPress={() => setReviewing(true)}
          // Blocked while two slots share a minute: `setSlotTimes` would refuse the write
          // anyway, and a Save that fails silently is worse than one visibly waiting.
          disabled={!dirty || !profileId || blocked}
          size="xl"
          fullWidth
        />
      }
    >
      <ScreenHeader
        title={t('slots.title')}
        subtitle={t('slots.subtitle')}
        onBack={() => void goBack()}
      />

      <View style={{ gap: spacing.md }}>
        <Banner
          variant="attention"
          title={t('slots.warningTitle')}
          message={t('slots.warningBody')}
        />

        {clash ? (
          <Banner
            variant="attention"
            title={t('slots.conflictTitle')}
            message={t('slots.conflictBody', {
              first: nameForKey(clash.first, clash.time),
              second: nameForKey(clash.second, clash.time),
              time: formatTime(clash.time),
            })}
          />
        ) : null}

        {customProblem !== null ? (
          <Banner
            variant="attention"
            title={t('slots.customBlockedTitle')}
            message={customProblem}
          />
        ) : null}

        {stored.loading && !stored.data ? <Skeleton height={160} label={t('a11y.loading')} /> : null}

        <SlotGroupCards
          t={t}
          times={times}
          formatTime={formatTime}
          conflictNameFor={conflictPartner}
          onEdit={(slot) => setEditing({ kind: 'builtin', slot })}
        />

        <Card style={{ gap: spacing.xs }}>
          <Text variant="label" accessibilityRole="header">
            {t(SLOT_OWN_TIME_KEYS.title)}
          </Text>

          {customs.length === 0 ? (
            <Text variant="caption" tone="muted" style={{ paddingBottom: spacing.sm }}>
              {t('slots.customEmpty')}
            </Text>
          ) : (
            customs.map((custom, index) => (
              <View key={custom.key}>
                {index > 0 ? <View style={{ height: 1, backgroundColor: colors.border }} /> : null}
                <SlotRow
                  t={t}
                  name={nameForKey(custom.key, custom.time)}
                  time={formatTime(custom.time)}
                  conflictWith={conflictPartner(custom.key)}
                  onPress={() => {
                    setCustomError(null);
                    setEditing({ kind: 'custom', isNew: false, draft: custom });
                  }}
                />
              </View>
            ))
          )}

          {customs.length >= MAX_CUSTOM_SLOTS ? (
            <Text variant="caption" tone="muted">
              {t(SLOT_OWN_TIME_KEYS.full, { max: MAX_CUSTOM_SLOTS })}
            </Text>
          ) : (
            <Button
              title={t(SLOT_OWN_TIME_KEYS.add)}
              onPress={openNewCustom}
              variant="secondary"
              size="lg"
              icon="plus"
              fullWidth
            />
          )}
        </Card>

        <Text variant="caption" tone="muted">
          {t('slots.clockNote')}
        </Text>
        <Text variant="caption" tone="muted">
          {t('slots.notAdvice')}
        </Text>
      </View>

      {/* One built-in slot, edited live behind the dialog.

          There is no Cancel: the row behind it already shows the new time as it moves,
          and the whole screen is staged until Save, so "Done" closes a change she can
          still step back. A Cancel here would imply the rest of the screen commits. */}
      <Dialog
        visible={builtinEditing !== null}
        title={slotChangeTitle(t, editingBuiltinName)}
        onRequestClose={() => setEditing(null)}
        footer={
          <Button title={t('common.done')} onPress={() => setEditing(null)} size="lg" fullWidth />
        }
      >
        <View style={{ gap: spacing.lg }}>
          <SlotTimeReadout
            name={editingBuiltinName}
            time={builtinEditing ? formatTime(times[builtinEditing.slot]) : ''}
          />

          {builtinPartner !== null ? (
            <Text variant="body" tone="destructive">
              {slotConflictLine(t, builtinPartner)}
            </Text>
          ) : null}

          <SlotStepper
            t={t}
            slotName={editingBuiltinName}
            onShift={(delta) => builtinEditing && adjust(builtinEditing.slot, delta)}
          />
        </View>
      </Dialog>

      {/* A slot of her own. Edited as a DRAFT, because the name has to be validated
          before it joins the list — an empty or reserved label must never be committed
          and then explained afterwards. */}
      <Dialog
        visible={customEditing !== null}
        title={
          customEditing?.isNew ? t(SLOT_OWN_TIME_KEYS.newTitle) : t(SLOT_OWN_TIME_KEYS.editTitle)
        }
        onRequestClose={() => {
          setCustomError(null);
          setEditing(null);
        }}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => {
                setCustomError(null);
                setEditing(null);
              }}
              variant="secondary"
              size="lg"
              fullWidth
            />
            {customEditing && !customEditing.isNew ? (
              <Button
                title={t(SLOT_OWN_TIME_KEYS.remove)}
                onPress={() => void removeCustom(customEditing.draft)}
                variant="destructive"
                size="lg"
                fullWidth
              />
            ) : null}
            <Button
              title={
                customEditing?.isNew
                  ? t(SLOT_OWN_TIME_KEYS.addConfirm)
                  : t(SLOT_OWN_TIME_KEYS.keep)
              }
              onPress={commitCustom}
              size="lg"
              fullWidth
            />
          </View>
        }
      >
        <View style={{ gap: spacing.lg }}>
          <TextField
            label={t(SLOT_OWN_TIME_KEYS.name)}
            helper={t(SLOT_OWN_TIME_KEYS.nameHelp, { max: MAX_CUSTOM_SLOT_LABEL })}
            value={customEditing?.draft.label ?? ''}
            onChangeText={(label) => {
              setCustomError(null);
              setEditing((current) =>
                current?.kind === 'custom'
                  ? { ...current, draft: { ...current.draft, label } }
                  : current,
              );
            }}
            // Capped at the field so the length can never be a surprise at save time.
            maxLength={MAX_CUSTOM_SLOT_LABEL}
            autoCapitalize="sentences"
            returnKeyType="done"
          />

          <SlotTimeReadout
            name={customEditing?.draft.label ?? ''}
            time={customEditing ? formatTime(customEditing.draft.time) : ''}
          />

          {/* No slot name until she has typed one — the stepper falls back to the plain
              "one hour later" rather than announcing a label that starts with a colon. */}
          <SlotStepper
            t={t}
            slotName={customEditing?.draft.label ?? ''}
            onShift={(delta) => shiftDraft(setEditing, setCustomError, delta)}
          />

          {/* One error line for the whole dialog, not an outline on the name field: the
              refusal is as often about the TIME ("Evening is already at 17:00") as about
              the name, and an error hung on the wrong control sends her to fix the wrong
              thing. `alert` + words, never colour alone. */}
          {customError !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Icon name="alert" size={20} color={colors.destructive} />
              <Text variant="body" tone="destructive" style={{ flexShrink: 1 }}>
                {customError}
              </Text>
            </View>
          ) : null}
        </View>
      </Dialog>

      {/* THE READ-BACK GATE. See the file header for why this screen has one at all. */}
      <Dialog
        visible={reviewing}
        title={t('slots.reviewTitle')}
        dismissOnBackdrop={false}
        onRequestClose={() => {
          if (!saving) setReviewing(false);
        }}
        scrollable
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('slots.reviewChange')}
              onPress={() => setReviewing(false)}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={saving}
            />
            <Button
              title={t('common.save')}
              onPress={() => void save()}
              variant="primary"
              size="xl"
              fullWidth
              loading={saving}
            />
          </View>
        }
      >
        <Text variant="body" tone="muted">
          {changes.length === 0 ? t('slots.reviewNothing') : t('slots.reviewInstruction')}
        </Text>
        {changes.map((change) => (
          <View
            key={change.id}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={`${change.name}. ${change.detail}`}
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
            <Text variant="title">{change.name}</Text>
            <Text variant="body" tone="muted">
              {change.detail}
            </Text>
          </View>
        ))}
      </Dialog>
    </Screen>
  );
}

/**
 * Moves the draft custom slot's time.
 *
 * Lifted out of the component so the stepper handler is one line rather than a copy of the
 * same `current?.kind === 'custom'` narrowing at every call.
 */
function shiftDraft(
  setEditing: React.Dispatch<React.SetStateAction<Editing>>,
  setCustomError: React.Dispatch<React.SetStateAction<string | null>>,
  deltaMinutes: number,
): void {
  setCustomError(null);
  setEditing((current) =>
    current?.kind === 'custom'
      ? {
          ...current,
          draft: { ...current.draft, time: stepWallClock(current.draft.time, deltaMinutes) },
        }
      : current,
  );
}
