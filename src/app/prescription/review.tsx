/**
 * Checking what the model read off the paper, line by line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE DECISIONS ON THIS SCREEN ARE SAFETY DECISIONS, NOT LAYOUT PREFERENCES
 *
 * 1. THE PHOTO STAYS ON SCREEN. It occupies ~40% of the space under the header and never
 *    scrolls away, and a tap opens it full size. Checking a card against a piece of paper
 *    that is two screens up is not checking; it is remembering, and she will be doing this
 *    having just been handed four new drugs by a doctor who spoke quickly.
 *
 *    40% OF WHAT IS LEFT, NEVER 40% OF THE WINDOW, AND THE DIFFERENCE WAS THE WHOLE
 *    SCREEN. This was `height * 0.4` — a share of the WINDOW, on a screen that also pins a
 *    header, a page/collapse row, a warning and a footer. At the reference scale below
 *    those five came to 628dp inside 611dp, and the ScrollView holding the medicines is
 *    the only child of the column that can give way (`flex: 1` is `flexBasis: 0`, so it
 *    absorbs every overrun), which means it resolved to ZERO HEIGHT. She opened a fifteen-
 *    line discharge summary and saw a photograph, a warning and a dead button, with no
 *    medicine cards at all — in the state the screen ALWAYS opens in. The paper is now a
 *    percentage of the box it actually sits in and carries `flexShrink: 1` with a
 *    tap-target floor, so THE PAPER YIELDS BEFORE THE CARDS DO. See the budget below, and
 *    re-derive it when you change a number in this file.
 *
 *    IT COLLAPSES; IT NEVER HIDES. A discharge summary carries fifteen medicines and 40%
 *    of the space spent on the paper still pushes the cards into a letterbox, so there is a
 *    toggle. Collapsed still leaves a strip of the photograph on screen, still opens it
 *    full size on a tap, and puts a named control ("Show The Photo") in the row directly
 *    under it — two ways back, one tap each. AND IT OPENS EXPANDED EVERY TIME. The choice
 *    lives in component state and dies with the screen, deliberately: persisting it would
 *    let a preference set once, in a hurry, on a two-line prescription quietly govern the
 *    next fifteen-line discharge summary, which is the one that needs the paper most. The
 *    AI warning is NOT part of the collapse — see decision 3.
 *
 *    AND IT COLLAPSES ITSELF WHILE THE KEYBOARD IS UP, without touching her choice. The
 *    one field on this screen that must be typed into is the dose count, and the keyboard
 *    takes roughly 300dp from the bottom of a 873dp window while every pinned region above
 *    keeps its height. Whatever is left over then is the cards' viewport, and it is the
 *    thing being typed into: a viewport of zero cannot be scrolled to the focused input,
 *    so she would be typing the one number this whole gate exists to protect without being
 *    able to see it — or the error line under it. `keyboardUp` is OR'd with her own
 *    choice rather than written into it, so dismissing the keyboard restores exactly the
 *    state she left. `KeyboardAvoidingView` cannot help here: it is deliberately a no-op
 *    on Android (see `Screen.tsx`), and padding is not the problem — the split of a fixed
 *    column between five pinned regions is.
 *
 *    ─── THE VERTICAL BUDGET ──────────────────────────────────────────────────
 *    Measured against a 393×873dp handset at OS font scale 1.3 with the app's large-text
 *    mode OFF, the same reference `(tabs)/index.tsx` uses. EVERY LINE BOX IS THE OS SCALE
 *    APPLIED TO AN EXPLICIT `lineHeight`, NOT TO THE FONT SIZE: `label`, `body` and
 *    `caption` carry no `maxFontSizeMultiplier`, so their boxes grow the full 1.3×.
 *
 *      status inset          24
 *      footer               213.8   12 + count row 57.2 (2-line caption, 56dp ghost)
 *                                   + 8 + confirm 100.6 (xl label wraps to 2 lines:
 *                                   2×40.3 + 16 padding + 4 border) + 24 inset + 12
 *      ──────────────────────────
 *      body                 635.2   873 − 24 − 213.8
 *      less Screen padding   24
 *      ScreenHeader         133.6   12 + back 56 + 8 + title 41.6 + 16
 *      ──────────────────────────
 *      pinned block         477.6   what the photo's 40% is now taken of
 *        photo              191.0   40%
 *        page/collapse row   64     8 paddingTop + Button `md` floor 56
 *        AI warning          81.2   24 paddingVertical + 2 caption lines (28.6 each)
 *        cards viewport     141.4   ✓ scrolls, and shows a card
 *      collapsed            285.4   photo → 56 (the 12% share is below the floor)
 *
 *    At the app's large-text mode ON (1.63× effective) the footer grows to ~250 and the
 *    header to 144, leaving a pinned block of ~431: photo 172, row 64, warning 96.8,
 *    cards ~98 — thin but real, and 214 once collapsed. Under the keyboard (~300dp gone)
 *    the collapse is what keeps the number field reachable at all.
 *
 *    TWO PAGES CHANGE THE ROW, and the row is where this arithmetic breaks first: three
 *    children that cannot shrink do not fit 361dp of content width. See the note on it.
 *
 * 2. THE DOSE COUNT IS NEVER ACCEPTED BY OMISSION. Frequency is THE dangerous class of
 *    extraction error: "1-0-1" misread as QID leaves the drug name, the strength and the
 *    form all perfectly correct and quadruples the dose. Every one of those correct fields
 *    is what makes the card look right, and a tick-box next to a card that looks right is
 *    satisfied by a thumb that never read the line.
 *
 *    This screen used to answer that with an empty box she filled in herself, with the
 *    model's answer deliberately kept off the screen — "a number on screen turns typing
 *    into copying". That was right about the danger and wrong about the remedy: typing
 *    from an empty box tests her MEMORY of what the doctor said, and the paper is in her
 *    hand and photographed at the top of this screen.
 *
 *    So the number is now PROPOSED, and only where it has been corroborated:
 *    `features/prescriptions/propose.ts` withholds it unless every transcription of the
 *    line decodes to the same instruction, the model's own count agrees with them, it is
 *    inside the cap, the model did not flag the line or rate itself low, and there are
 *    WORDS to show. Those words are printed above the field — `The app read these words:
 *    "1-0-1" — find them on the photo above.` — because the proposal is only checkable if
 *    the thing it was read from is visible.
 *
 *    THAT LINE NAMES THE APP AND NOT THE PAPER, DELIBERATELY. It used to read `On the
 *    paper: "1-0-1"`, which asserts a fact this app cannot check: the quotation and the
 *    number both come from ONE response to ONE image, so a glyph the model misread
 *    produces a verbatim carrying the misreading, a code that agrees with it and a
 *    confident self-rating — and the evidence line then quotes the error back to the one
 *    person who was about to catch it, wearing the authority of the source. Corroboration
 *    catches a correct transcription NORMALISED wrong; nothing catches a shared misread.
 *    So the line says what the app did and asks her to go and look, which is the act it
 *    was always for.
 *
 *    AND IT STILL CANNOT BE ACCEPTED BY DOING NOTHING. A proposed frequency is `flagged`,
 *    and its `touched` bit is the ONE on this screen that focus does not set. It is
 *    satisfied by exactly two acts: answering the question under the evidence ("No, I
 *    Will Type It" / "Yes — Twice A Day, At 8:30 am And 8:30 pm", neither selected on
 *    arrival), or producing a number herself. Until then the confirm button is inert and
 *    the card says which line is holding it.
 *
 *    WHERE THE CORROBORATION FAILS, THE BOX IS EMPTY AND SHE TYPES — exactly the old
 *    behaviour — and the card says why in her own words ("this can mean morning and
 *    night, or morning and afternoon"). That is what makes the proposal safe to ship: a
 *    refusal costs precisely what this screen cost before it, so this can improve on the
 *    old behaviour and cannot be worse than it.
 *
 *    AND THE PRESCRIPTION IS READ BACK IN CLOCK TIMES BEFORE ANY OF IT IS WRITTEN, but
 *    only when a number came off the photograph — `anyProposalAgreed`. The honest
 *    objection to a per-card tap is habituation: fifteen agreements is a rhythm, and a
 *    rhythm is not a decision by the fourth card. Three things answer it, and the third
 *    is the one that does not depend on her attention holding. (a) The answer is a
 *    two-way question with nothing selected, so "tap the only control" is not a strategy.
 *    (b) The agreement spells the whole instruction out — count, clock times, and whether
 *    it skips days — so the tap is agreement with a stated claim. (c) The whole list is
 *    then read back as literal times, and the confirm button of that dialog sits at the
 *    BOTTOM of the list rather than pinned beneath it, so reaching it means scrolling past
 *    every line. A prescription where she typed everything gets no dialog, because nothing
 *    about it was made cheaper.
 *
 *    TWO EARLIER DEFENCES WERE WITHDRAWN, AND WHY MATTERS MORE THAN THAT THEY WERE. The
 *    first claimed the labels differ card to card because each spells its own NUMBER out.
 *    On the document this feature was built from — a discharge summary carrying HRZE plus
 *    pyridoxine plus cardiac and diabetes agents — ten of twelve lines are once daily, so
 *    ten chips read "Yes — Once A Day" in the same words in the same place: the rhythm the
 *    defence claimed to have broken. The count is the thing that repeats; the TIMES are
 *    what differ line by line, so the label carries them now. The second claimed
 *    corroboration makes proposals a minority "on a messy paper", so typing interleaves
 *    with agreeing. A hospital discharge summary is typed, not scrawled — corroboration
 *    succeeds nearly everywhere and proposals are the MAJORITY, with no typing to break
 *    the rhythm. That defence was calibrated for handwriting and the feature shipped for
 *    print, so it is gone rather than restated.
 *
 *    HER NUMBER DECIDES HOW MANY; THE PAPER ONLY EVER DECIDES WHICH. The decoded pattern
 *    is consulted for the slot layout — "1-0-1" is the breakfast and dinner doses, "HS" is
 *    bedtime and not dinner — but only when its own dose count agrees with the number now
 *    in the field. A "1-0-1" misread as QID disagrees with a "2", so its layout is thrown
 *    away along with its count, and nothing the model got wrong survives the disagreement.
 *
 *    THE SKIPPED DAY IS HELD TO A HIGHER BAR THAN THE LAYOUT, because the dose count
 *    cannot corroborate it. "Daily" and "alternate day" both decode to ONE dose, so for
 *    the once-daily majority a matching count says nothing whatever about the interval —
 *    and `intervalDays` was being adopted on that agreement alone, out of readings
 *    `propose.ts` had explicitly refused. It now needs the proposal layer to have accepted
 *    the reading outright; where it did not, the medicine goes to manual timing entry by
 *    name rather than being silently flattened to daily or silently skipping days. See
 *    `planSlots`.
 *
 * 3. LOW-CONFIDENCE FIELDS BLOCK. Every field the extractor marked `low` or `unknown` is
 *    marked with a warning icon, labelled "Suggested by the app" against "Written on the
 *    prescription", and the confirm button stays inert until she has been into every one
 *    of them. The model's own uncertainty is the best available signal for where it is
 *    wrong, so it is treated as a gate rather than as a hint.
 *
 *    THE BLOCK IS ADDRESSED, NOT JUST ANNOUNCED. One caption under a dead button ("check
 *    every marked line") is a rule, not a direction, and with fifteen medicines it names
 *    none of them. Every ticked card that fails the gate carries its own marker with the
 *    reason on it, the footer counts what is left, and a button beside the count scrolls
 *    to the first one. `blockingReason` is the single predicate behind all three plus the
 *    preview, because two copies of it are how the button and the card come to disagree.
 *
 * 4. A DRUG SHE IS ALREADY ON IS NEVER ADDED TWICE. The supersession diff runs BEFORE the
 *    confirm, so a line that matches a current thread with the same dose is shown as
 *    "already being taken" and creates nothing, and a line that matches with a DIFFERENT
 *    dose becomes version N+1 of the same thread. Creating a second active thread for the
 *    same drug is a double dose with two reminders, and it is the failure this ordering
 *    exists to prevent.
 *
 * 5. NOTHING CLINICAL REACHES A CONFIRMED ROW UNSEEN. The food relation used to: the
 *    model's `food_relation` was written straight into `dose_schedule` from
 *    `draft.parsed`, and from there it spoke in the alarm body ("on an empty stomach"), on
 *    the OPD one-pager and in the CSV, having never appeared on this screen. It is now a
 *    row of chips with the paper's own mark printed above it, and what gets written is
 *    what is selected there and nothing else — so an unproposed relation writes NULL where
 *    it used to write itself in silently. The stake is named in `features/slots/
 *    registry.ts`: before food and after food are the wrong way round for a TB drug.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Keyboard, ScrollView, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  DEFAULT_SLOT_TIMES,
  SLOT_STRINGS,
  buildSlotDefinitions,
  getMetaJson,
  resolveSlots,
  slotDefForKey,
  slotLabel,
  useAsync,
  useProfileId,
  useT,
  type LocalStrings,
  type SlotDefinition,
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
import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { Criticality } from '@/types';
import { getPrescription, type Prescription } from '@/db/repositories/prescriptions';
import { parseStoredPrescription } from '@/features/prescriptions/extract';
import {
  MAX_AI_DOSES_PER_DAY,
  confirmExtraction,
  type ConfirmResult,
  type ReviewedMedicine,
  type ReviewedSchedule,
} from '@/features/prescriptions/confirm';
import { decodeFrequency } from '@/features/prescriptions/frequency';
// The proposal layer. Every rule about WHEN a number may be offered lives there, is pure,
// and is unit-tested; this screen only renders the answer and the named reason for a
// refusal. Deciding here as well is how the screen and the tests would come to disagree
// about what "corroborated" means.
import {
  isLowConfidence,
  proposeForMedicine,
  type FoodRefusal,
  type FrequencyRefusal,
  type MedicineProposal,
  type ProposedFoodRelation,
} from '@/features/prescriptions/propose';
import {
  buildSupersessionDiff,
  loadCurrentMedicines,
  toIncoming,
  type PrescriptionDiff,
} from '@/features/prescriptions/reconcile';
// The gate and the seeding rule. They live outside `src/app/` for one reason: everything
// under it imports React Native and resolves through the `@/*` alias, so `node --test`
// cannot load a line of it — and the two lines that decide whether a proposed number
// arrives ANSWERED are the two lines in this whole feature that most need a test standing
// over them. See the header of `reviewGate.ts`.
import {
  MAX_DOSES_PER_DAY,
  blockingReason,
  firstUncheckedField,
  parseDoses,
  seedFrequency,
  type BlockReason,
  type DoseTiming,
  type FrequencyAnswer,
} from '@/features/prescriptions/reviewGate';
import { frequencyExpression, type ParsedMedicine } from '@/features/prescriptions/schema';

import { PRESCRIPTION_PAGES_META_PREFIX } from './capture';

/**
 * TITLE CASE NAMES A CONTROL; SENTENCE CASE STATES A FACT — and that is the line this map
 * follows, because "Title Case for labels" alone does not decide the cases below.
 *
 * Anything she can act on takes Title Case: buttons, chips, tabs, the screen title, and a
 * short label naming the control under it ("Before Or After Food?", "Not Ready", "Take Me
 * There"). Anything that is a whole sentence about the state of the screen keeps sentence
 * case even where it is drawn as `variant="label"` — "What the reminders will be", "Not
 * shown yet — these are not finished", "Not being added — you took the tick off these".
 * Title-Casing A Sentence Of Nine Words Reads As A Heading Nobody Wrote, and these three
 * are parallel constructions: capitalising one of them and not its two neighbours is the
 * inconsistency that is actually visible on the screen.
 *
 * `hi` never changes for this: Devanagari has no case.
 */
const STRINGS: LocalStrings = {
  ...SLOT_STRINGS,
  'prescription.review.medicineOf': {
    en: 'Medicine {{n}} of {{total}}',
    hi: 'दवाई {{n}}, कुल {{total}} में से',
  },
  'prescription.review.include': { en: 'Add this medicine', hi: 'यह दवाई जोड़ें' },
  'prescription.review.excluded': {
    en: 'Left unticked, this medicine is not added at all and gets no reminders. You can add it later from this prescription.',
    hi: 'बिना निशान लगाए यह दवाई जुड़ेगी ही नहीं और इसके रिमाइंडर भी नहीं लगेंगे। आप इसे बाद में इसी पर्चे से जोड़ सकती हैं।',
  },
  'prescription.review.checkThis': {
    en: 'Please check this against the paper',
    hi: 'इसे कागज़ से मिलाकर देखें',
  },
  'prescription.review.dosesPerDay': { en: 'How many times a day?', hi: 'दिन में कितनी बार?' },
  'prescription.review.dosesPerDayHelp': {
    en: 'Read it off the paper and type the number yourself.',
    hi: 'कागज़ से पढ़कर यह अंक खुद लिखें।',
  },
  'prescription.review.dosesPerDayHelpProposed': {
    en: 'This is what the app read. Check it against the photo above, then answer.',
    hi: 'यह ऐप का पढ़ा हुआ है। ऊपर की फोटो से मिलाकर देखें, फिर जवाब दें।',
  },
  // Said once she has agreed, so the number never sits there unattributed. It is the
  // counterpart of the rule that an edited value must stop looking like a proposal: an
  // agreed one must stop looking like something she typed.
  'prescription.review.dosesPerDayHelpAgreed': {
    en: 'You have said this matches the paper. Change it here if it does not.',
    hi: 'आपने कहा कि यह कागज़ से मिलता है। न मिलता हो तो यहीं बदल दें।',
  },
  'prescription.review.dosesPerDayInvalid': {
    en: 'Please type a number between 1 and 12.',
    hi: 'कृपया 1 से 12 के बीच का अंक लिखें।',
  },
  'prescription.review.overCap': {
    en: 'More than {{max}} times a day cannot be worked out from a photograph. This medicine will be added, and you will type its timings yourself afterwards.',
    hi: 'दिन में {{max}} बार से ज़्यादा फोटो से तय नहीं किया जा सकता। दवाई जुड़ जाएगी, पर उसके समय आपको खुद लिखने होंगे।',
  },
  'prescription.review.oneLess': { en: 'One less', hi: 'एक कम' },
  'prescription.review.oneMore': { en: 'One more', hi: 'एक ज़्यादा' },
  'prescription.review.quantity': { en: 'How much each time', hi: 'हर बार कितनी' },
  'prescription.review.remindersTitle': {
    en: 'What the reminders will be',
    hi: 'रिमाइंडर ऐसे लगेंगे',
  },
  'prescription.review.reminderLine': {
    en: '{{name}} — {{times}}, every day',
    hi: '{{name}} — {{times}}, हर दिन',
  },
  'prescription.review.reminderManual': {
    en: '{{name}} — you will type the timings yourself',
    hi: '{{name}} — समय आप खुद लिखेंगी',
  },
  'prescription.review.reminderLineAlternate': {
    en: '{{name}} — {{times}}, every second day',
    hi: '{{name}} — {{times}}, हर दूसरे दिन',
  },
  // A ticked medicine with no times is still a line in this list. `parseDoses` is null for
  // both of these, and the map below returns null on a null count — so without their own
  // sentences an as-needed painkiller and a STAT injection would be ticked, saved, and
  // reported by SILENCE in the one place that says what is about to happen.
  'prescription.review.reminderAsNeeded': {
    en: '{{name}} — only when needed, so no reminder will ring',
    hi: '{{name}} — सिर्फ़ ज़रूरत पड़ने पर, इसलिए कोई रिमाइंडर नहीं बजेगा',
  },
  'prescription.review.reminderOneOff': {
    en: '{{name}} — written down only, it was already given',
    hi: '{{name}} — सिर्फ़ दर्ज हो रही है, यह पहले ही दी जा चुकी है',
  },
  'prescription.review.reminderNoneTicked': {
    en: 'No medicine is ticked, so no reminders will be set.',
    hi: 'किसी दवाई पर निशान नहीं है, इसलिए कोई रिमाइंडर नहीं लगेगा।',
  },
  // Report 3, and the reason it is a NAMED list rather than a silent filter. An incomplete
  // medicine used to print one anonymous "Type how many times a day to see the times."
  // here, once per line — fifteen identical grey sentences directly above the confirm
  // button, naming nothing. Dropping them without saying so would be worse: she would read
  // a short, tidy list of times and confirm a prescription believing it complete.
  'prescription.review.notShownYet': {
    en: 'Not shown yet — these are not finished',
    hi: 'अभी नहीं दिख रहीं — ये पूरी नहीं हुई हैं',
  },
  'prescription.review.heldLine': { en: '{{name}} — {{reason}}', hi: '{{name}} — {{reason}}' },
  'prescription.review.unnamedLine': { en: 'Medicine {{n}}', hi: 'दवाई {{n}}' },
  // The dropped lines, named. An unticked medicine is the one thing this preview reported
  // by SILENCE — it is neither in the times nor in "Not shown yet" — and unticking is the
  // cheapest way to turn the dead confirm button on. A list she reads as complete, three
  // lines above the button that writes it, is the failure this whole card is against.
  'prescription.review.notBeingAdded': {
    en: 'Not being added — you took the tick off these',
    hi: 'ये नहीं जुड़ेंगी — इनका निशान आपने हटाया है',
  },
  'prescription.review.readBackTitle': { en: 'Read These Times Back', hi: 'ये समय पढ़ लें' },
  // "AND AT NO OTHERS" IS A CLAIM ABOUT A LIST, SO IT HAS TO NAME WHICH LIST.
  //
  // `previewBody` is built from `included`, and `included` is filtered out of `actionable`,
  // which excludes every `continued` line — the drugs this prescription writes unchanged,
  // which on a repeat discharge summary is most of it, and on this phone is the anti-TB
  // regimen. Unscoped, the last sentence she reads before the write promised a complete
  // account of when her phone will ring while the medicines already ringing were, by
  // construction, absent from the list under it. On thirteen medicines that is a false
  // statement about her morning, made in the one dialog whose entire purpose is being
  // believed — and the fix is not to weaken the claim but to say what it is about. The
  // second sentence is unconditional on purpose: it is true whether or not this
  // prescription continued anything, and a sentence that appears only sometimes is one
  // more thing for her to interpret.
  'prescription.review.readBackInstruction': {
    en: 'The reminders from this prescription will ring at the times below, and at no others. Your other medicines are not changed. The app read some of these off your photograph — please check them once more.',
    hi: 'इस पर्चे के रिमाइंडर नीचे लिखे समयों पर ही बजेंगे, किसी और समय पर नहीं। आपकी बाकी दवाइयाँ नहीं बदली गई हैं। इनमें से कुछ ऐप ने आपकी फोटो से पढ़े हैं — एक बार और देख लें।',
  },
  'prescription.review.readBackChange': { en: 'Change Something', hi: 'कुछ बदलना है' },
  'prescription.review.timesAreYours': {
    en: 'These are your own meal and bedtime timings. You can change them for any medicine afterwards.',
    hi: 'ये आपके ही खाने और सोने के समय हैं। बाद में किसी भी दवाई के लिए बदले जा सकते हैं।',
  },
  'prescription.review.timesCollapsedTitle': {
    en: 'One medicine will ring fewer times than the paper says',
    hi: 'एक दवाई पर्चे से कम बार बजेगी',
  },
  'prescription.review.timesCollapsed': {
    en: 'Two of your timings are set to the same clock time, so the dose below is given once at that time instead of twice. You can move one of them in Settings, or set that medicine’s timings yourself afterwards.',
    hi: 'आपके दो समय एक ही घड़ी के समय पर लगे हैं, इसलिए नीचे लिखी खुराक उस समय दो बार नहीं, एक ही बार दी जाएगी। सेटिंग में इनमें से एक को बदला जा सकता है, या बाद में उस दवाई के समय आप खुद तय कर सकती हैं।',
  },
  'prescription.review.timesCollapsedLine': {
    en: '{{name}} — {{first}} and {{second}} are both at {{time}}',
    hi: '{{name}} — {{first}} और {{second}}, दोनों {{time}} पर हैं',
  },
  // Report 4. What was here was a RULE — "check every marked line and type how many times
  // a day, then this button turns on" — printed once, under a button that is dead from the
  // moment the screen opens (every new line arrives ticked with nothing in its number
  // box). With fifteen medicines a rule identifies none of them. A count plus a way to get
  // there is a direction.
  'prescription.review.blockedOne': {
    en: '1 medicine is not ready yet.',
    hi: '1 दवाई अभी पूरी नहीं है।',
  },
  'prescription.review.blockedMany': {
    en: '{{count}} medicines are not ready yet.',
    hi: '{{count}} दवाइयाँ अभी पूरी नहीं हैं।',
  },
  // TWO WORDS, AND THE SHORTNESS IS LOAD-BEARING. This button shares a footer row with the
  // count, cannot shrink (see the row), and every dp it takes is a dp the count wraps into
  // — "Take Me There" cost ~194dp of 361 and pushed a one-sentence count onto three lines,
  // out of the same vertical budget the medicine cards are living on. The sentence beside
  // it already says what "there" is, so the button does not have to.
  'prescription.review.goToFirst': { en: 'Show Me', hi: 'वहाँ चलिए' },
  // What the short label leaves out, for a reader who hears the control on its own.
  'prescription.review.goToFirstA11y': {
    en: 'Show me the first medicine that is not ready',
    hi: 'पहली अधूरी दवाई दिखाइए',
  },
  'prescription.review.notReady': { en: 'Not Ready', hi: 'अभी पूरी नहीं' },
  'prescription.review.needName': {
    en: 'The name is empty. Type it off the paper, or take the tick off this medicine.',
    hi: 'नाम खाली है। कागज़ से देखकर लिखें, या इस दवाई का निशान हटा दें।',
  },
  'prescription.review.needDoses': {
    en: 'How many times a day is not filled in.',
    hi: 'दिन में कितनी बार — यह नहीं भरा गया।',
  },
  'prescription.review.needFreqAnswer': {
    en: 'The number the app read off the paper has not been answered yet.',
    hi: 'ऐप ने कागज़ से जो अंक पढ़ा, उसका जवाब अभी नहीं दिया गया।',
  },
  'prescription.review.needCheck': {
    en: 'A marked place on this card has not been looked at yet.',
    hi: 'इस कार्ड पर निशान लगी एक जगह अभी देखी नहीं गई।',
  },
  // The same block, WITH THE PLACE NAMED — used wherever `firstUncheckedField` can say
  // which one it is, which is every time except a field with no label of its own.
  //
  // THE NAME IS QUOTED AND SET OFF, RATHER THAN MADE THE SUBJECT OF THE HINDI SENTENCE.
  // "देखी" agrees with a feminine noun and the four labels it can be handed are not one
  // gender — "दवाई का नाम" is masculine, "ताकत" is feminine — so a sentence built around
  // the field name reads as broken Hindi on half the cards it appears on. The subject is
  // "यह जगह" in every one of them, and the label is an apposition beside it.
  'prescription.review.needCheckField': {
    en: '“{{field}}” has not been looked at yet.',
    hi: '“{{field}}” — यह जगह अभी देखी नहीं गई।',
  },
  'prescription.review.alreadyTaking': {
    en: 'Already being taken — nothing changes ({{count}})',
    hi: 'पहले से चल रही हैं — इनमें कुछ नहीं बदल रहा ({{count}})',
  },
  'prescription.review.alreadyTakingNote': {
    en: 'This prescription writes these the same as before, so they are left exactly as they are. Nothing is added twice.',
    hi: 'यह पर्चा इन्हें पहले जैसा ही लिखता है, इसलिए इन्हें वैसे ही रहने दिया गया है। कुछ भी दो बार नहीं जुड़ेगा।',
  },
  'prescription.review.doseChange': {
    en: 'The dose on this prescription is different from what you are taking now',
    hi: 'इस पर्चे पर लिखी खुराक आपकी अभी चल रही खुराक से अलग है',
  },
  'prescription.review.changeLine': { en: '{{field}}: {{from}} → {{to}}', hi: '{{field}}: {{from}} → {{to}}' },
  'prescription.review.sameThread': {
    en: 'This will be recorded as a change to the same medicine, so your record stays in one piece.',
    hi: 'इसे उसी दवाई का बदलाव मानकर दर्ज किया जाएगा, ताकि आपका रिकॉर्ड टूटे नहीं।',
  },
  'prescription.review.matchedOnGeneric': {
    en: 'Matched by the salt name, not the brand. Check this is the same medicine.',
    hi: 'यह नमक (साल्ट) के नाम से मिलाई गई है, ब्रांड से नहीं। देख लें कि यह वही दवाई है।',
  },
  // The way out of the "already being taken" bucket, offered only on a salt-level match.
  // It says what is true of the two medicines, not what the app should do about it — the
  // consequence (a medicine of its own, nothing stopped) is the sentence below it.
  'prescription.review.notTheSame': {
    en: 'This Is A Different Medicine',
    hi: 'यह अलग दवाई है',
  },
  'prescription.review.notTheSameA11y': {
    en: '{{name}} is a different medicine from the one it was matched to',
    hi: '{{name}} उस दवाई से अलग है जिससे इसे मिलाया गया है',
  },
  'prescription.review.promoted': {
    en: 'Moved up to the medicines above — please check it there.',
    hi: 'ऊपर दवाइयों में ले जाया गया — वहाँ देख लीजिए।',
  },
  'prescription.review.criticality': { en: 'How important is this medicine?', hi: 'यह दवाई कितनी ज़रूरी है?' },
  'prescription.review.criticalitySuggested': {
    en: 'The app thinks this one is very important. You decide.',
    hi: 'ऐप के हिसाब से यह बहुत ज़रूरी है। तय आप करेंगी।',
  },
  'prescription.review.unnamed': {
    en: 'One line could not be read at all. Its name box is empty — type it off the paper, or leave it unticked.',
    hi: 'एक पंक्ति बिल्कुल पढ़ी नहीं जा सकी। उसका नाम खाली है — कागज़ से देखकर लिख दें, या उस पर निशान न लगाएँ।',
  },
  'prescription.review.nothingFound': {
    en: 'No medicines were read from this photo',
    hi: 'इस फोटो में से कोई दवाई नहीं पढ़ी जा सकी',
  },
  'prescription.review.nothingFoundMessage': {
    en: 'You can type the medicines in yourself. Nothing is lost — the photo is saved with this prescription.',
    hi: 'आप दवाइयाँ खुद लिख सकती हैं। कुछ गया नहीं — फोटो इस पर्चे के साथ सेव है।',
  },
  'prescription.review.addManually': { en: 'Add medicines manually', hi: 'दवाइयाँ खुद लिखें' },
  'prescription.review.pageLabel': { en: 'Photo of page {{n}}', hi: 'पेज {{n}} की फोटो' },
  'prescription.review.openPhoto': { en: 'Open the photo bigger', hi: 'फोटो बड़ी करके देखें' },
  'prescription.review.nextPage': { en: 'Next page', hi: 'अगला पेज' },
  // Report 2. Both labels name the PHOTO rather than the gesture ("Collapse" / "Expand"
  // describe what the app does; "Show The Photo" describes what she gets), and the
  // collapsed strip stays tappable, so the control and the picture are two ways back.
  'prescription.review.photoHide': { en: 'Hide The Photo', hi: 'फोटो छिपाएँ' },
  'prescription.review.photoShow': { en: 'Show The Photo', hi: 'फोटो दिखाएँ' },
  'prescription.review.savedTitle': { en: 'Saved', hi: 'सेव हो गया' },
  'prescription.review.savedCount': {
    en: '{{count}} medicines are set up with reminders.',
    hi: '{{count}} दवाइयाँ रिमाइंडर के साथ लग गईं।',
  },
  'prescription.review.savedNone': {
    en: 'No medicine was added from this prescription.',
    hi: 'इस पर्चे से कोई दवाई नहीं जोड़ी गई।',
  },
  // Medicines WERE written; none of them rings. Said instead of "no medicine was added",
  // which would be false, and instead of a count of medicines "set up with reminders",
  // which would be false the other way. Each one is named under its own heading below.
  'prescription.review.savedNoneRinging': {
    en: 'No reminders were set from this prescription.',
    hi: 'इस पर्चे से कोई रिमाइंडर नहीं लगा।',
  },
  'prescription.review.savedAsNeeded': {
    en: 'On the “only when needed” list, with no reminders:',
    hi: '“सिर्फ़ ज़रूरत पड़ने पर” वाली सूची में, बिना रिमाइंडर के:',
  },
  'prescription.review.needsTimings': {
    en: 'These have no reminders yet — their timings have to be typed in:',
    hi: 'इनके रिमाइंडर अभी नहीं लगे — इनके समय लिखने बाकी हैं:',
  },
  'prescription.review.setTimings': { en: 'Set the timings', hi: 'समय लिखें' },
  // Reported apart from the list above it, because nothing is outstanding here. Putting a
  // dose she has just told the app was already given under "their timings have to be typed
  // in", beside a button that goes and asks for them, contradicts the answer she gave two
  // minutes earlier. `ManualReason` carries the difference as a code; see `confirm.ts`.
  'prescription.review.recordedOnly': {
    en: 'Written down with no reminders — you said these were already given:',
    hi: 'बिना रिमाइंडर के दर्ज हो गईं — आपने कहा कि ये पहले ही दी जा चुकी हैं:',
  },
  'prescription.review.notAdded': { en: 'Not added: {{names}}', hi: 'नहीं जोड़ी गईं: {{names}}' },
  'prescription.review.alarmsNotArmed': {
    en: 'The reminders could not be set on the phone just now. Open the reminder check in Settings.',
    hi: 'अभी फोन पर रिमाइंडर सेट नहीं हो पाए। सेटिंग में रिमाइंडर जाँच खोलें।',
  },
  'prescription.review.saveFailed': {
    en: 'The medicines could not be saved. Please try once more.',
    hi: 'दवाइयाँ सेव नहीं हो पाईं। एक बार फिर कोशिश करें।',
  },
  'prescription.review.goneMessage': {
    en: 'This prescription is no longer on the phone.',
    hi: 'यह पर्चा अब फोन में नहीं है।',
  },
  'prescription.review.field.strength': { en: 'Strength', hi: 'ताकत' },
  'prescription.review.field.frequency': { en: 'How often', hi: 'कितनी बार' },
  'prescription.review.field.interval': { en: 'Which days', hi: 'किन दिनों' },
  'prescription.review.field.food': { en: 'Food', hi: 'खाना' },
  'prescription.review.field.quantity': { en: 'How much', hi: 'कितनी' },

  // ── Report 5: the proposal, its evidence, and its refusals ─────────────────
  //
  // THE EVIDENCE LINE IS THE PRICE OF THE PRE-FILL. A number with nothing beside it can
  // only be accepted; the same number under the words it was read from can be CHECKED,
  // and the paper is photographed 200dp above it. `propose.ts` refuses to propose at all
  // when it has no words to put here, which is why this string is never optional.
  //
  // IT SAYS "THE APP READ", NOT "ON THE PAPER", AND THE DIFFERENCE IS THE WHOLE POINT OF
  // THE LINE. Every field in the response comes from one reading of one photograph: a
  // misread glyph produces a verbatim that carries the misreading, a slot notation and a
  // code that agree with it, and a confident self-rating — the ordinary outcome on a
  // PRINTED discharge summary. `propose.ts` can catch a correct transcription that was
  // normalised wrong; nothing it does can catch a misread the model made once and then
  // repeated in every field. So a line beginning "On the paper:" asserted a fact about
  // the paper that this app has no way to check, and it asserted it to the one person who
  // was about to check it — quoting the error back to her as if it were the source.
  // What is left is honest and is also a better instruction: these are the words the app
  // read, and the act being asked for is to find them on the photograph above.
  'prescription.review.onThePaper': {
    en: 'The app read these words: “{{text}}” — find them on the photo above.',
    hi: 'ऐप ने ये शब्द पढ़े: “{{text}}” — इन्हें ऊपर की फोटो में देख लें।',
  },
  // Two answers, and neither is selected when the card is drawn. A single "looks right"
  // tick has exactly one satisfying action, which is what a thumb finds on the fourth
  // card without reading the third; a question with two answers does not.
  'prescription.review.freqDecline': { en: 'No, I Will Type It', hi: 'नहीं, मैं खुद लिखूँगी' },
  //
  // THE CHIP STATES EVERYTHING THE TAP AUTHORISES, AND THAT IS WHY IT CARRIES THE TIMES.
  //
  // Two separate failures are answered by the same sentence. The first is what the tap
  // MEANS: a chip reading "Yes — Once A Day" is true of a bedtime statin and equally true
  // of the same statin moved to breakfast, and true of an every-day drug and of an
  // alternate-day one, so agreeing to it agrees to a count while the app quietly keeps the
  // slot and the interval. Anything the chip does not say is accepted by omission.
  //
  // The second is habituation, and it is worse on exactly the prescription this feature
  // was built from. HRZE, pyridoxine and most cardiac and diabetes agents are once daily,
  // so a discharge summary produces ten cards whose count is 1 — ten byte-identical chips
  // in the same position, which is the rhythm the design claims the differing labels
  // defeat. The claim only held for a messy paper with a mixture of counts. The times are
  // the thing that actually differs line by line ("8:30 am" against "10:00 pm"), so
  // putting them in the label is what makes the tenth tap a different sentence from the
  // first — and it is the same sentence the read-back will show her afterwards.
  'prescription.review.freqAgreeOne': {
    en: 'Yes — Once A Day, At {{times}}',
    hi: 'हाँ — दिन में एक बार, {{times}} पर',
  },
  'prescription.review.freqAgreeMany': {
    en: 'Yes — {{count}} Times A Day, At {{times}}',
    hi: 'हाँ — दिन में {{count}} बार, {{times}} पर',
  },
  'prescription.review.freqAgreeOneAlternate': {
    en: 'Yes — Once Every Second Day, At {{times}}',
    hi: 'हाँ — हर दूसरे दिन एक बार, {{times}} पर',
  },
  'prescription.review.freqAgreeManyAlternate': {
    en: 'Yes — {{count}} Times A Day, Every Second Day, At {{times}}',
    hi: 'हाँ — दिन में {{count}} बार, हर दूसरे दिन, {{times}} पर',
  },
  // The fallback for a rhythm that lands on no named time at all — a weekly dose, or one
  // whose interval this screen refuses to infer. Agreeing to the count is all there is to
  // agree to, and the card already says the timings will be typed in afterwards.
  'prescription.review.freqAgreeOneNoTimes': {
    en: 'Yes — Once A Day',
    hi: 'हाँ — दिन में एक बार',
  },
  'prescription.review.freqAgreeManyNoTimes': {
    en: 'Yes — {{count}} Times A Day',
    hi: 'हाँ — दिन में {{count}} बार',
  },

  // One sentence per refusal code. They are NOT interchangeable: "the paper says this is
  // only when needed" and "the app could not read it" are both "no number in the box",
  // and telling her the wrong one of the two sends her back to a prescription to look for
  // something that was never written on it.
  'prescription.review.freqNotWritten': {
    en: 'The paper does not say how often to take this.',
    hi: 'कागज़ पर यह नहीं लिखा कि यह कितनी बार लेनी है।',
  },
  'prescription.review.freqNotReadable': {
    en: 'How often to take this could not be read from the paper.',
    hi: 'कागज़ से यह नहीं पढ़ा जा सका कि यह कितनी बार लेनी है।',
  },
  'prescription.review.freqTwoPart': {
    en: 'This can mean morning and night, or morning and afternoon. The paper does not say which.',
    hi: 'इसका मतलब सुबह-रात भी हो सकता है और सुबह-दोपहर भी। कागज़ पर यह साफ़ नहीं है।',
  },
  'prescription.review.freqAsNeeded': {
    en: 'The paper says this one is taken only when needed.',
    hi: 'कागज़ पर लिखा है कि यह ज़रूरत पड़ने पर ही लेनी है।',
  },
  'prescription.review.freqOneOff': {
    en: 'The paper says this was a single dose, given once.',
    hi: 'कागज़ के हिसाब से यह सिर्फ़ एक बार की खुराक थी।',
  },
  'prescription.review.freqTapering': {
    en: 'The dose on the paper changes over the days, so one number cannot cover it.',
    hi: 'कागज़ पर खुराक दिनों के साथ बदलती है, इसलिए एक ही अंक से काम नहीं चलेगा।',
  },
  'prescription.review.freqHourly': {
    en: 'The paper gives a gap in hours, not times around meals.',
    hi: 'कागज़ पर घंटों का अंतर लिखा है, खाने के आसपास के समय नहीं।',
  },
  'prescription.review.freqSourcesDisagree': {
    en: 'The app read this line two ways that do not agree with each other.',
    hi: 'ऐप ने इस पंक्ति को दो तरह से पढ़ा और दोनों आपस में नहीं मिलते।',
  },
  'prescription.review.freqCountDisagrees': {
    en: 'The app’s own count does not match what it read off this line.',
    hi: 'ऐप की अपनी गिनती इसी पंक्ति से पढ़ी बात से नहीं मिलती।',
  },
  'prescription.review.freqWeekday': {
    en: 'The paper says once a week and does not say which day.',
    hi: 'कागज़ पर हफ़्ते में एक बार लिखा है, पर कौन-से दिन यह नहीं लिखा।',
  },
  'prescription.review.freqOverCap': {
    en: 'More than {{max}} times a day cannot be worked out from a photograph.',
    hi: 'दिन में {{max}} बार से ज़्यादा फोटो से तय नहीं किया जा सकता।',
  },
  'prescription.review.freqFlagged': {
    en: 'The app had to choose between two readings on this line.',
    hi: 'ऐप को इस पंक्ति पर दो पढ़ाइयों में से एक चुननी पड़ी।',
  },
  'prescription.review.freqLowConfidence': {
    en: 'The app was not sure how often this is taken.',
    hi: 'ऐप को पक्का नहीं था कि यह कितनी बार लेनी है।',
  },
  'prescription.review.freqNoEvidence': {
    en: 'No words from the paper were recorded for this, so no number is filled in.',
    hi: 'इसके लिए कागज़ के शब्द दर्ज नहीं हुए, इसलिए कोई अंक नहीं भरा गया।',
  },

  // ── The two refusals that are ANSWERS, and the answer each one needs ────────
  //
  // `as_needed` and `one_off` are the only refusals in that list which are facts about the
  // paper rather than doubts about the reading, and the screen used to treat all fourteen
  // the same way: an empty box, and a gate demanding a number of doses a day. So the card
  // said "the paper says this one is taken only when needed" and, two rows below, "How
  // many times a day is not filled in." Her two ways out were a number — which schedules
  // daily alarms for an SOS painkiller on a phone built so she can answer them without
  // opening the app — or taking the tick off, which records nothing. `confirm.ts` has
  // accepted `{ kind: 'prn' }` all along; only this screen never offered it.
  //
  // BOTH ARE TRANSCRIPTIONS, NOT DECISIONS. Each says back what the line above it quotes
  // from the paper, and neither is ever pre-selected — see `reviewGate.ts`. The chip is
  // Title Case because it is a control; the sentence under it is what it will do.
  'prescription.review.timingAsNeeded': { en: 'Only When Needed', hi: 'सिर्फ़ ज़रूरत पड़ने पर' },
  'prescription.review.timingAsNeededChosen': {
    en: 'No reminder will ring for this one. It goes on the “only when needed” list, and you write each dose down when you take it.',
    hi: 'इसके लिए कोई रिमाइंडर नहीं बजेगा। यह “सिर्फ़ ज़रूरत पड़ने पर” वाली सूची में जाएगी, और हर खुराक आप लेते समय दर्ज कर देंगी।',
  },
  'prescription.review.timingOneOff': {
    en: 'Already Given — Just Record It',
    hi: 'यह दी जा चुकी है — बस दर्ज कर लें',
  },
  'prescription.review.timingOneOffChosen': {
    en: 'This is written into your record with no reminders and no timings owed.',
    hi: 'यह आपके रिकॉर्ड में दर्ज हो जाएगी — न रिमाइंडर लगेंगे, न कोई समय बाकी रहेगा।',
  },
  'prescription.review.timingClearHint': {
    en: 'Press it again to type a number of times a day instead.',
    hi: 'दोबारा दबाकर इसकी जगह दिन में कितनी बार, यह अंक लिखा जा सकता है।',
  },

  // The comparison the screen never made. Once she has a number of her own and the app
  // still has one from the photograph, those are two different claims about the same line
  // and only one of them is on screen — the evidence line above quotes the words the app
  // read and says nothing about disagreeing with them. Stated as two facts, side by side,
  // with no opinion about which is right: hers is the one that will be written.
  'prescription.review.freqDisagrees': {
    en: 'The app read {{n}} times a day from those words. You have put {{m}}.',
    hi: 'ऐप ने उन शब्दों से दिन में {{n}} बार पढ़ा था। आपने {{m}} लिखा है।',
  },

  // ── The meal relation ──────────────────────────────────────────────────────
  'prescription.review.foodTitle': {
    en: 'Before Or After Food?',
    hi: 'खाने से पहले या बाद?',
  },
  'prescription.review.foodClearHint': {
    en: 'Press the chosen one again to leave this blank.',
    hi: 'चुने हुए पर दोबारा दबाकर इसे खाली छोड़ा जा सकता है।',
  },
  'prescription.review.foodNotWritten': {
    en: 'The paper says nothing about food. Leave this blank unless you know otherwise.',
    hi: 'कागज़ पर खाने के बारे में कुछ नहीं लिखा। जब तक आपको पता न हो, इसे खाली रहने दें।',
  },
  'prescription.review.foodNoEvidence': {
    en: 'No words from the paper were recorded for this, so nothing is chosen.',
    hi: 'इसके लिए कागज़ के शब्द दर्ज नहीं हुए, इसलिए कुछ नहीं चुना गया।',
  },
  'prescription.review.foodLowConfidence': {
    en: 'The app was not sure of the food mark on this line.',
    hi: 'इस पंक्ति पर खाने का निशान ऐप को पक्का समझ नहीं आया।',
  },
  // The two answers that come from READING the quoted mark rather than counting it.
  //
  // A quotation printed above a selected chip is read as the paper agreeing with the app,
  // so "empty stomach" above a ticked "After food" was the worst display on this screen:
  // it looked like corroboration and it was an inversion, on the field where the stake is
  // an anti-TB drug taken with a meal. `propose.ts` now decodes the words and refuses on a
  // contradiction, and both sentences below say the same thing in her terms — the app is
  // not sure, nothing has been chosen, the choice is hers.
  'prescription.review.foodEvidenceDisagrees': {
    en: 'The words the app read and the choice it made do not match each other, so nothing is chosen. Please read the photo and pick one.',
    hi: 'ऐप ने जो शब्द पढ़े और जो चुना, दोनों आपस में नहीं मिलते, इसलिए कुछ नहीं चुना गया। फोटो देखकर आप चुनें।',
  },
  'prescription.review.foodUnverified': {
    en: 'The app could not match these words to any of the choices below, so nothing is chosen. Please read the photo and pick one.',
    hi: 'ऐप इन शब्दों को नीचे दिए विकल्पों से नहीं मिला पाया, इसलिए कुछ नहीं चुना गया। फोटो देखकर आप चुनें।',
  },
};

/**
 * Refusal code → sentence, keyed off the exported union rather than off strings.
 *
 * `propose.ts` exports `FREQUENCY_REFUSALS` and `FOOD_REFUSALS` as unions for exactly this
 * reason: a new reason code added there stops THIS FILE compiling until somebody writes
 * the sentence for it in both languages. A `Record<string, string>` would compile happily
 * and print a dotted key path to a woman holding a prescription.
 */
const FREQUENCY_REFUSAL_KEYS: Record<FrequencyRefusal, string> = {
  not_written: 'prescription.review.freqNotWritten',
  not_readable: 'prescription.review.freqNotReadable',
  ambiguous_two_part: 'prescription.review.freqTwoPart',
  as_needed: 'prescription.review.freqAsNeeded',
  one_off: 'prescription.review.freqOneOff',
  tapering: 'prescription.review.freqTapering',
  hourly: 'prescription.review.freqHourly',
  sources_disagree: 'prescription.review.freqSourcesDisagree',
  model_count_disagrees: 'prescription.review.freqCountDisagrees',
  weekday_unspecified: 'prescription.review.freqWeekday',
  exceeds_ai_dose_cap: 'prescription.review.freqOverCap',
  flagged_by_reader: 'prescription.review.freqFlagged',
  low_confidence: 'prescription.review.freqLowConfidence',
  no_evidence: 'prescription.review.freqNoEvidence',
};

const FOOD_REFUSAL_KEYS: Record<FoodRefusal, string> = {
  not_written: 'prescription.review.foodNotWritten',
  no_evidence: 'prescription.review.foodNoEvidence',
  low_confidence: 'prescription.review.foodLowConfidence',
  evidence_disagrees: 'prescription.review.foodEvidenceDisagrees',
};

/**
 * The five relations `confirmExtraction` will accept, in the order the schedule screen
 * offers them, so the same medicine reads the same way on both screens.
 */
const FOOD_OPTIONS: readonly ProposedFoodRelation[] = ['before', 'after', 'with', 'empty', 'any'];

type DraftKind = 'continued' | 'changed' | 'new';

type Draft = {
  index: number;
  kind: DraftKind;
  parsed: ParsedMedicine;
  /** Set for a changed dose — version N+1 of the SAME thread, never a second thread. */
  supersedesThreadId: string | null;
  matchedOnGeneric: boolean;
  changes: readonly { field: string; from: string; to: string }[];
  name: string;
  strength: string;
  quantityText: string;
  /**
   * Seeded from a CORROBORATED proposal, and empty otherwise. See the file header.
   *
   * A seeded value is inert: `freqAnswer` starts at 'unanswered' and the gate refuses to
   * let a medicine through until it is not. The seed is a proposition on screen, never a
   * value on its way to a row.
   */
  dosesPerDayText: string;
  /**
   * What the corroborated reading offers for this line, and — where it offers nothing —
   * the named reason. Computed ONCE, at build time. `proposeForMedicine` is pure, so
   * recomputing it per render would be correct but pointless; computing it per render
   * from mutable draft state is how a proposal would start appearing and disappearing
   * under her hands as she edits an unrelated field.
   */
  proposal: MedicineProposal;
  /**
   * Where the number in `dosesPerDayText` stands — 'unanswered' / 'agreed' / 'own'. THE
   * START STATE IS THE WHOLE POINT, and it is stated and asserted in `reviewGate.ts`.
   */
  freqAnswer: FrequencyAnswer;
  /**
   * What KIND of instruction this line is — a count per day, as-needed, or one dose
   * already given. 'per_day' on every arrival; only she moves it, and only where the
   * paper's own words (quoted on the card) say one of the other two. See `reviewGate.ts`.
   */
  doseTiming: DoseTiming;
  /**
   * Her answer about food, and the ONLY thing `scheduleFor` will write. Null writes NULL.
   */
  foodRelation: ProposedFoodRelation | null;
  /** True until she touches the chips, so the app stops calling the answer its own. */
  foodProposed: boolean;
  criticality: Criticality;
  /** Only asked when the model proposed 'critical'. */
  offerCriticality: boolean;
  /** Field names the extractor was not sure about. Blocking. */
  flagged: string[];
  touched: Record<string, boolean>;
  include: boolean;
};

/**
 * Reason code → sentence, keyed off the exported union.
 *
 * THE PREDICATE ITSELF LIVES IN `reviewGate.ts`, and `Draft` satisfies its `ReviewLine`
 * shape structurally. It is the SINGLE predicate behind the confirm button, the per-card
 * marker, the footer count, the "take me there" jump and the preview's held list — five
 * consumers that used to be one inline `included.some(...)` and four things that did not
 * exist. Copies of it are exactly how the button stays dead while every card on screen
 * claims to be fine, which is the report that produced this work.
 *
 * A new reason code there stops THIS FILE compiling until somebody writes its sentence in
 * both languages, the same way `FREQUENCY_REFUSAL_KEYS` works.
 */
const BLOCK_REASON_KEYS: Record<BlockReason, string> = {
  name: 'prescription.review.needName',
  doses: 'prescription.review.needDoses',
  freq_unanswered: 'prescription.review.needFreqAnswer',
  unchecked: 'prescription.review.needCheck',
};

/**
 * Flagged field name → the label the card actually prints above that box.
 *
 * IT MUST BE THE CARD'S OWN WORDS, not a second vocabulary. The whole point of naming the
 * field is that she can then find it by reading down the card, and a marker that says
 * "Quantity" over a box labelled "How much each time" sends her looking for a control that
 * is not there. `name` and `strength` therefore borrow the shared bundle's field labels —
 * the same keys `DraftCard` passes to `TextField` — rather than the `review.field.*` set,
 * which exists for the supersession diff and is deliberately terser ("How much").
 *
 * Partial by construction: a flagged field with no label here falls back to the unnamed
 * sentence rather than printing a raw field key at her.
 */
const FIELD_LABEL_KEYS: Record<string, string> = {
  name: 'prescription.medicineName',
  strength: 'prescription.strength',
  quantity: 'prescription.review.quantity',
  frequency: 'prescription.review.field.frequency',
};

/**
 * The one sentence that says why a line is being held — for the card marker AND for the
 * preview's held list, so the two cannot describe the same line differently.
 *
 * `'unchecked'` is the only reason that needs the draft as well as the code, because it is
 * the only one that is about a PLACE rather than about the card. See `firstUncheckedField`.
 */
function blockSentence(
  draft: Draft,
  reason: BlockReason,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (reason === 'unchecked') {
    const field = firstUncheckedField(draft);
    const labelKey = field === null ? undefined : FIELD_LABEL_KEYS[field];
    if (labelKey !== undefined) {
      return t('prescription.review.needCheckField', { field: t(labelKey) });
    }
  }
  return t(BLOCK_REASON_KEYS[reason], { max: MAX_AI_DOSES_PER_DAY });
}

type ReviewData = {
  prescription: Prescription;
  profileId: string;
  pages: string[];
  /** Her nine built-in slots plus any she invented, already sorted by the time she set. */
  slots: SlotDefinition[];
  drafts: Draft[];
  diff: PrescriptionDiff;
  unnamedCount: number;
};

/**
 * What the preview draws on before her profile has loaded.
 *
 * The defaults, not an empty list: a first render with no slots would flash "no times" on
 * a card that is about to show four of them.
 */
const FALLBACK_SLOTS: SlotDefinition[] = buildSlotDefinitions(DEFAULT_SLOT_TIMES, []);

/**
 * The paper's share of the block it shares with the medicine cards — see decision 1 and
 * the budget in the file header.
 *
 * PERCENTAGES, AND THEY RESOLVE AGAINST THE WRAPPER, NOT THE WINDOW. `flexBasis` in a
 * column box is a height, and the wrapper's height is definite, so '40%' means 40% of what
 * is left under the header. Paired with `flexShrink: 1` and a tap-target floor it also
 * makes the PAPER the thing that yields when the window shrinks — the ScrollView is
 * `flex: 1`, which is `flexBasis: 0`, so left to itself it is the only child that gives
 * way and it gives way all the way to nothing.
 */
const PHOTO_SHARE = '40%';
const PHOTO_SHARE_COLLAPSED = '12%';
/**
 * The collapsed strip is still a control — a tap on it opens the photograph full size —
 * so it never goes below a tap target, whatever the share works out to on a short window.
 */
const PHOTO_MIN_HEIGHT = spacing.touchTarget;

export default function PrescriptionReviewScreen() {
  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  const t = useT(STRINGS);
  const toast = useToast();
  const { colors } = useTheme();
  const { formatTime } = useDateFormat();
  const { height } = useWindowDimensions();
  const profile = useProfileId();
  const profileId = profile.data;

  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  /**
   * Report 2. FALSE ON EVERY ARRIVAL, and it is a `useState` rather than an `app_meta`
   * row on purpose — see decision 1. The collapse is a thing she does while reading one
   * long line, not a standing preference about whether she wants to see the prescription.
   */
  const [photoCollapsed, setPhotoCollapsed] = useState(false);
  const [readBack, setReadBack] = useState(false);
  /**
   * Has she asked to be shown which lines are unfinished?
   *
   * FALSE ON ARRIVAL, AND THAT IS THE POINT — see the marker in `DraftCard`. Every line
   * opens blocked, so a marker drawn on arrival is drawn on every card at once and says
   * only "you have not reached this one yet", which she can see. Pressing "Take Me There"
   * is the moment it starts meaning "you left this one", so that is the moment it appears
   * — on every unfinished card, not only on the one being scrolled to, because the count
   * beside that button is a count of several and she will look for the rest.
   *
   * It never goes back to false. Having asked once, she is looking for them.
   */
  const [revealBlocks, setRevealBlocks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<ConfirmResult | null>(null);

  /**
   * Is the keyboard up? See decision 1: the paper collapses itself while it is, and
   * expands again when it goes away.
   *
   * IT IS SEPARATE FROM HER CHOICE AND IS NEVER WRITTEN INTO IT. `photoCollapsed` is what
   * she asked for and must survive the keyboard opening and closing; this is a temporary
   * fact about the window. Setting `photoCollapsed` from here would silently convert one
   * tap on the number field into a standing decision to hide the prescription.
   *
   * `keyboardDidShow`/`Hide` rather than `WillShow`: the `Will` events are iOS-only, and
   * this is an Android-only app. The listeners are removed on unmount — a listener held by
   * a screen that has gone calls `setState` on a dead component and, over a long review
   * session with repeated navigation, leaks one per visit.
   */
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  /** For the jump from the footer to the first card that is holding the button down. */
  const scrollRef = useRef<ScrollView | null>(null);
  const cardTops = useRef(new Map<number, number>());

  const state = useAsync<ReviewData | null>(async () => {
    if (!id || !profileId) return null;
    const prescription = await getPrescription(id);
    if (!prescription) return null;

    const stored = await getMetaJson<string[]>(`${PRESCRIPTION_PAGES_META_PREFIX}${id}`);
    const pages =
      stored && stored.length > 0
        ? stored.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
        : prescription.imageUri
          ? [prescription.imageUri]
          : [];

    const slots = await resolveSlots(profileId);

    // The stored envelope is re-parsed rather than re-requested: reopening a prescription
    // read yesterday must not need the network, or a doctor's waiting room becomes the
    // one place the app stops working.
    const parseResult = parseStoredPrescription(prescription.extraction);
    if (!parseResult.ok) {
      return {
        prescription,
        profileId,
        pages,
        slots,
        drafts: [],
        diff: { continued: [], changed: [], added: [], notOnThisPrescription: [] },
        unnamedCount: 0,
      };
    }

    // THE DIFF RUNS BEFORE THE CONFIRM. See decision 4 in the file header.
    const current = await loadCurrentMedicines(profileId);
    const incoming = toIncoming(parseResult.value);
    const diff = buildSupersessionDiff(current, incoming);

    return {
      prescription,
      profileId,
      pages,
      slots,
      drafts: buildDrafts(parseResult.value.medicines, diff),
      diff,
      unnamedCount: parseResult.value.medicines.filter((m) => !m.nameAsWritten).length,
    };
  }, [id, profileId]);

  // Seed the editable copy once per prescription; after that the fields own it.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const loaded = state.data;
  if (loaded && seededFor !== loaded.prescription.id) {
    setSeededFor(loaded.prescription.id);
    setDrafts(loaded.drafts);
  }

  const slots = loaded?.slots ?? FALLBACK_SLOTS;
  const list = useMemo(() => drafts ?? [], [drafts]);
  const actionable = useMemo(() => list.filter((d) => d.kind !== 'continued'), [list]);
  const continued = useMemo(() => list.filter((d) => d.kind === 'continued'), [list]);
  const included = useMemo(() => actionable.filter((d) => d.include), [actionable]);

  const patch = useCallback((index: number, change: Partial<Draft>) => {
    setDrafts((current) =>
      current === null ? current : current.map((d) => (d.index === index ? { ...d, ...change } : d)),
    );
  }, []);

  const markTouched = useCallback((index: number, field: string) => {
    setDrafts((current) =>
      current === null
        ? current
        : current.map((d) =>
            d.index === index ? { ...d, touched: { ...d.touched, [field]: true } } : d,
          ),
    );
  }, []);

  /**
   * The gate, and the two lists the preview is built from — one predicate, three answers.
   *
   * `held` carries the reason and a position number so a line with an unreadable name can
   * still be pointed at ("Medicine 4"). Both lists are derived from `blockingReason`, so
   * the button, the cards and the preview cannot disagree about what "ready" means.
   */
  const ready = useMemo(() => included.filter((d) => blockingReason(d) === null), [included]);
  /**
   * The medicines she has taken the tick OFF, by name.
   *
   * WHY AN ABSENCE NEEDS A LIST OF ITS OWN. `blockingReason` returns null for an unticked
   * line — correctly; it is not going to be created, so demanding she proof-read it would
   * be a wall between her and a decision she has already made. But `ready` and `held` are
   * both derived from `included`, so an unticked medicine used to produce no line anywhere
   * in the preview: not in the times, not in "Not shown yet". The only pre-save signal was
   * an unnamed sunken card saying some line somewhere is unticked, and the only naming
   * happened in the post-save dialog, under "Not added:".
   *
   * That matters because unticking is the CHEAPEST WAY TO TURN THE DEAD BUTTON ON. The
   * footer says one medicine is not ready and offers to take her there; the first control
   * on the card it lands on is "Add this medicine"; a reason like "a marked place on this
   * card has not been looked at yet" does not say which place. Untick, and the marker
   * disappears, the count drops and the button lights up — the visible, obvious,
   * immediately rewarded action, with the medicine then vanishing from the preview
   * altogether.
   *
   * Report 3's own principle — the one thing that must never happen is a short tidy list
   * she reads as complete — was applied to unfinished lines and not to dropped ones, and
   * an absence is the hardest thing on a screen to notice. For a four-drug TB regimen,
   * dropping one silently is monotherapy.
   */
  const excluded = useMemo(
    () =>
      actionable.flatMap((draft, position) =>
        draft.include ? [] : [{ draft, position: position + 1 }],
      ),
    [actionable],
  );
  const held = useMemo(
    () =>
      included.flatMap((draft) => {
        const reason = blockingReason(draft);
        return reason === null ? [] : [{ draft, reason, position: actionable.indexOf(draft) + 1 }];
      }),
    [included, actionable],
  );
  const blocked = held.length > 0;

  /**
   * Scroll the first unfinished card into view.
   *
   * The offsets are collected by `onLayout` on each card's wrapper, which means a card
   * that has never been laid out (far down a long list) has no entry — RN still measures
   * off-screen children of a ScrollView, so in practice it does, and the fallback is to do
   * nothing rather than to scroll somewhere arbitrary and lose her place.
   */
  /**
   * Did any number about to be written come off the photograph rather than out of her?
   *
   * THE READ-BACK IS GATED ON THIS, and the conditional is the point. The confirm button
   * is pinned in the footer, so the preview above it can be scrolled past — which was
   * survivable while every dose count had to be typed, because the number reaching a row
   * had already passed through her hands. A proposal she agreed to has not: it can be
   * accepted with one tap on a card, and fifteen of those is a rhythm. So exactly the
   * prescriptions that made confirming cheaper get one more reading, in wall-clock times,
   * on the far side of a dialog — and a prescription where she typed every number keeps
   * precisely the flow it has today, because nothing about it got easier.
   */
  const anyProposalAgreed = useMemo(
    () => ready.some((draft) => draft.freqAnswer === 'agreed'),
    [ready],
  );

  /**
   * "This is not the medicine you matched it to" — the only escape from the continued
   * bucket, and it is deliberately the ONLY one.
   *
   * Offered on a generic-matched row and nowhere else. A row matched on the written name
   * and found identical has nothing to disagree with; a row matched on the salt has the
   * app's guess in it, and until this existed that guess could only be accepted.
   *
   * IT PROMOTES TO 'new', NEVER TO 'changed'. `changed` means version N+1 of the thread it
   * was matched to, which is precisely the claim she is rejecting — writing a new dose
   * onto the wrong thread is the double-dose-with-one-history failure the diff exists to
   * prevent, pointed the other way. `new` creates its own thread and leaves the medicine
   * she is on exactly where it is; nothing is stopped, and no confirmation here can stop
   * anything. `include` goes true because a promoted line is one she has just said she
   * wants looked at, and the gate then holds it until it is finished — its seeded
   * frequency answer, flags and touched map are untouched by this, so it arrives with the
   * same unanswered proposal any other new line would have.
   */
  const promoteToNew = useCallback(
    (draft: Draft) => {
      patch(draft.index, {
        kind: 'new',
        supersedesThreadId: null,
        matchedOnGeneric: false,
        changes: [],
        include: true,
      });
      // Said out loud because the row VANISHES from where her finger is and reappears
      // above, among cards she has already scrolled past.
      toast.show({ message: t('prescription.review.promoted'), variant: 'info' });
    },
    [patch, toast, t],
  );

  const goToFirstBlocking = useCallback(() => {
    // BEFORE THE EARLY RETURNS, AND UNCONDITIONALLY. The reveal is the half of this button
    // that cannot fail: a card whose top was never recorded (it has not been laid out yet)
    // would otherwise swallow the press whole, leaving a control that visibly does nothing
    // on a screen where the confirm button is already dead.
    setRevealBlocks(true);
    const first = held[0];
    if (!first) return;
    const top = cardTops.current.get(first.draft.index);
    if (top === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, top - spacing.md), animated: true });
  }, [held]);

  /**
   * Every ticked medicine that loses a dose because two of her slots share a clock time,
   * NAMED, with the two slots that collapsed.
   *
   * Settings refuses to save such a pair and the merge now settles one out of an upgraded
   * blob, so this should only fire on times written by an older build — but when it does
   * fire it is a doctor-prescribed dose that will never be scheduled, and it used to be
   * reported as an unnamed grey caption below a list of medicines.
   *
   * Drawn from `ready` rather than from everything ticked, so it never names a medicine
   * that the preview above it is holding back — a warning about a line that is not in the
   * list is a warning she cannot place.
   */
  const collapsedTimings = useMemo(() => {
    const out: { name: string; kept: SlotDefinition; dropped: SlotDefinition }[] = [];
    for (const draft of ready) {
      // A line she has named as-needed or already-given has no slots to lose, whatever is
      // still sitting in its number box — she may have typed a count first and answered
      // afterwards, and the box is not cleared on the way out (see the chip). Reading the
      // count without reading the timing is how this would warn about two timings
      // collapsing on a medicine that is never going to be given a time at all.
      if (draft.doseTiming !== 'per_day') continue;
      const doses = parseDoses(draft.dosesPerDayText);
      if (doses === null || doses > MAX_AI_DOSES_PER_DAY) continue;
      const { chosen, collapsed } = planSlots(draft.parsed, doses, slots, intervalIsEarned(draft));
      // Zero chosen is a different story — that medicine is going to manual entry and is
      // already labelled as such. Only a partial loss means two timings sit on one minute.
      if (chosen.length === 0) continue;
      for (const pair of collapsed) out.push({ name: draft.name.trim(), ...pair });
    }
    return out;
  }, [ready, slots]);

  /**
   * The same loss, restated from what was ACTUALLY WRITTEN, for the post-save dialog.
   *
   * Read off `ConfirmResult` rather than recomputed from the drafts, because the dialog is
   * reporting a fact about rows that now exist. A slot key that no longer resolves falls
   * back to its clock time, which is always true.
   */
  const savedCollapsed = useMemo(() => {
    if (!outcome) return [];
    const name = (key: string | null, timeLocal: string): string => {
      const def = slotDefForKey(slots, key);
      return def ? slotLabel(def, t) : formatTime(timeLocal);
    };
    return [...outcome.created, ...outcome.updated].flatMap((row) =>
      row.collapsed.map((entry) => ({
        threadId: row.threadId,
        name: row.name,
        timeLocal: entry.timeLocal,
        first: name(entry.keptSlotKey, entry.timeLocal),
        second: name(entry.droppedSlotKey, entry.timeLocal),
      })),
    );
  }, [outcome, slots, t, formatTime]);

  /**
   * What was written, split by whether it will ever make a sound.
   *
   * A PRN schedule is a created row carrying `dosesPerDay: 0` — one schedule row, no time,
   * no occurrences — so a count of rows would report an as-needed painkiller as a medicine
   * "set up with reminders". `nothingWritten` is the genuinely empty case, and it has to
   * include the medicines that were created without a schedule or the dialog says nothing
   * was added above a list of the things that were.
   */
  const withReminders = useMemo(
    () =>
      [...(outcome?.created ?? []), ...(outcome?.updated ?? [])].filter(
        (row) => row.dosesPerDay > 0,
      ),
    [outcome],
  );
  const asNeededSaved = useMemo(
    () =>
      [...(outcome?.created ?? []), ...(outcome?.updated ?? [])].filter(
        (row) => row.dosesPerDay === 0,
      ),
    [outcome],
  );
  const nothingWritten =
    outcome !== null &&
    outcome.created.length === 0 &&
    outcome.updated.length === 0 &&
    outcome.needsManualSchedule.length === 0;

  /**
   * The two halves of `needsManualSchedule`, split on the reason and not on the shape.
   *
   * Both are a confirmed medicine with no schedule row. One is waiting for timings nobody
   * has typed yet; the other is a dose she said had already been given, and is finished.
   * They read as one list only if you look at the rows rather than at why they are there.
   */
  const timingsOwed = useMemo(
    () => (outcome?.needsManualSchedule ?? []).filter((row) => row.reason !== 'recorded_only'),
    [outcome],
  );
  const recordedOnly = useMemo(
    () => (outcome?.needsManualSchedule ?? []).filter((row) => row.reason === 'recorded_only'),
    [outcome],
  );

  const confirmAll = useCallback(async () => {
    const data = state.data;
    if (!data || blocked || saving) return;

    setSaving(true);
    try {
      const reviewed: ReviewedMedicine[] = actionable.map((draft) => {
        const doses = parseDoses(draft.dosesPerDayText);
        const schedule = scheduleFor(draft, doses, data.slots);
        return {
          nameAsWritten: draft.name.trim(),
          genericGuess: draft.parsed.genericGuess,
          strength: emptyToNull(draft.strength),
          form: draft.parsed.form === 'unknown' ? null : draft.parsed.form,
          // What the HUMAN chose. The model's proposal travels beside it, never as it.
          criticality: draft.criticality,
          proposedCriticality: draft.parsed.proposedCriticality,
          criticalityReason: draft.parsed.criticalityReason,
          schedule,
          confirmed: draft.include,
          supersedesThreadId: draft.supersedesThreadId,
          sourceIndex: draft.index,
        };
      });

      // `confirmExtraction` is the only path that sets the two human gates —
      // `medicine.confirmed_by_user_at` AND `dose_schedule.confirmed_by_user_at` — and it
      // sets them separately, because a checked name is not a checked frequency. It also
      // confirms the prescription row and re-arms the alarms after the commit.
      const result = await confirmExtraction({
        profileId: data.profileId,
        prescriptionId: data.prescription.id,
        medicines: reviewed,
        source: 'ai',
      });
      setReadBack(false);
      setOutcome(result);
    } catch {
      // THE DIALOG CLOSES BEFORE THE TOAST, and the order is load-bearing: the toast host
      // is an in-tree overlay, not its own Modal (see `Toast.tsx`), so a toast raised while
      // the read-back is open renders behind it. "The medicines could not be saved" is the
      // one message on this screen she cannot afford to miss — without it she is looking at
      // a dialog that did nothing and no reason why.
      setReadBack(false);
      toast.show({ message: t('prescription.review.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [actionable, blocked, saving, state.data, t, toast]);

  const continueAfterSave = useCallback(() => {
    const data = state.data;
    setOutcome(null);
    if (data && data.diff.notOnThisPrescription.length > 0) {
      // Something she is on is not on this paper. That decision is its own screen, and it
      // is never taken here.
      router.replace(`/prescription/reconcile?id=${data.prescription.id}`);
    } else {
      router.replace('/(tabs)/medicines');
    }
  }, [state.data]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  if (state.loading || profile.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reviewTitle')} />
        <Skeleton height={Math.round(height * 0.35)} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (!loaded) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reviewTitle')} onBack={leave} />
        <EmptyState
          title={t('errors.notFound')}
          message={t('prescription.review.goneMessage')}
          actionLabel={t('common.close')}
          onAction={leave}
        />
      </Screen>
    );
  }

  if (list.length === 0) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reviewTitle')} onBack={leave} />
        <EmptyState
          title={t('prescription.review.nothingFound')}
          message={t('prescription.review.nothingFoundMessage')}
          actionLabel={t('prescription.review.addManually')}
          onAction={() => router.replace(`/medicine/new?prescriptionId=${loaded.prescription.id}`)}
        />
      </Screen>
    );
  }

  /**
   * Report 2. Collapsed is a STRIP, not nothing — and this is a SHARE, not a height.
   *
   * Collapsing keeps the paper present, keeps the whole thing tappable (the zoom dialog is
   * unchanged and is still the way to read it properly), and hands the reclaimed share of
   * the pinned block to the cards for free, because the ScrollView below is `flex: 1` and
   * nothing else on this screen reads this number.
   *
   * AND THE COLLAPSED BAND CROPS RATHER THAN SHRINKS — see `photoFit` below. That is the
   * one thing "a short box letterboxes the page, it never crops it" got backwards: an
   * A4 page fitted to a 57dp-tall band by `contain` is about 40dp WIDE inside 361dp of
   * row, so nine tenths of the strip is empty sunken background and the paper is at a
   * ninth of the linear size it had expanded. Nothing on it is legible at all, which
   * makes the promise in the file header — that collapsing still leaves a strip of the
   * photograph on screen — false in the state it describes.
   *
   * A PERCENTAGE OF THE PINNED BLOCK, NOT OF THE WINDOW. `height * 0.4` measured the
   * window — including the header, this row, the warning and the footer, which together
   * are more than a third of it — so the four pinned regions overflowed the column and the
   * ScrollView, the only child that can give way, resolved to zero. See the budget in the
   * file header. The percentage resolves against the wrapper below, which is the box the
   * photo actually shares with the cards, so the arithmetic cannot drift out of date the
   * next time a row is added to it.
   */
  const photoCompact = photoCollapsed || keyboardUp;
  const photoShare = photoCompact ? PHOTO_SHARE_COLLAPSED : PHOTO_SHARE;
  /**
   * How the page is fitted into whichever of those two boxes it is in.
   *
   * EXPANDED IS `contain`, BECAUSE THE WHOLE PAGE HAS TO BE VISIBLE AT ONCE — that is what
   * decision 1 is about, and cropping a discharge summary to its middle third while she is
   * checking fifteen lines against it would defeat the point of pinning it at all.
   *
   * COLLAPSED IS `cover`, BECAUSE A STRIP OF THE PAPER AT READABLE SCALE IS WORTH MORE
   * THAN THE WHOLE PAPER AT AN UNREADABLE ONE. `contain` in a 12% band fits the page to
   * the band's HEIGHT, so a portrait page comes out roughly 40dp wide in a 361dp row: a
   * postage stamp with nothing legible on it, floating in empty background, which is not
   * the anchor the collapse was designed around. `cover` fills the row instead and shows a
   * horizontal band of the page at the same linear scale it had expanded — she can read
   * the words in it, which is the entire job of the strip. What is lost is the rest of the
   * page, and it is one tap away in two places: the strip itself opens the zoom dialog,
   * and "Show The Photo" is in the row directly beneath it.
   */
  const photoFit = photoCompact ? 'cover' : 'contain';
  const currentPage = loaded.pages[pageIndex] ?? null;
  const multiPage = loaded.pages.length > 1;

  /**
   * What will ring, and what is being held back — one element, rendered in two places.
   *
   * It is a `const` and not a component so that the card and the read-back dialog cannot
   * drift into showing different lists. Two hand-copied maps is how the dialog would end
   * up printing a medicine the card had already excluded.
   */
  const previewBody = (
    <View>
      <View style={{ gap: spacing.sm }}>
        {included.length === 0 ? (
          <Text variant="body" tone="muted">
            {t('prescription.review.reminderNoneTicked')}
          </Text>
        ) : null}

        {ready.map((draft) => {
          // THE TWO LINES THAT HAVE NO TIMES AND ARE STILL IN THIS LIST. `parseDoses` is
          // null for both — an as-needed line was never given a count — and the null return
          // three lines down would have dropped them out of the preview entirely. A ticked
          // medicine reported by silence, directly above the confirm button, is the exact
          // failure the "Not shown yet" and "Not being added" sections exist against.
          if (draft.doseTiming !== 'per_day') {
            return (
              <Text key={draft.index} variant="body">
                {t(
                  draft.doseTiming === 'as_needed'
                    ? 'prescription.review.reminderAsNeeded'
                    : 'prescription.review.reminderOneOff',
                  { name: draft.name.trim() },
                )}
              </Text>
            );
          }
          const doses = parseDoses(draft.dosesPerDayText);
          if (doses === null) return null;
          const plan = planSlots(draft.parsed, doses, slots, intervalIsEarned(draft));
          // Over the cap, or a rhythm the decoder refuses to name slots for (Q6H is
          // 00:00/06:00/12:00/18:00, not four meals; a weekly dose has no named day). All
          // of them end at manual entry, and the preview has to say so rather than print
          // an empty list of times.
          if (doses > MAX_AI_DOSES_PER_DAY || plan.chosen.length === 0) {
            return (
              <Text key={draft.index} variant="body">
                {t('prescription.review.reminderManual', { name: draft.name.trim() })}
              </Text>
            );
          }
          const times = plan.chosen.map((slot) => formatTime(slot.time));
          return (
            <Text key={draft.index} variant="body">
              {t(
                plan.intervalDays === 2
                  ? 'prescription.review.reminderLineAlternate'
                  : 'prescription.review.reminderLine',
                { name: draft.name.trim(), times: joinTimes(times, t('common.and')) },
              )}
            </Text>
          );
        })}

        {held.length > 0 ? (
          <View style={{ gap: spacing.sm, paddingTop: ready.length > 0 ? spacing.md : 0 }}>
            <Text variant="label">{t('prescription.review.notShownYet')}</Text>
            {held.map((entry) => (
              <Text key={entry.draft.index} variant="body" tone="muted">
                {t('prescription.review.heldLine', {
                  name:
                    entry.draft.name.trim().length > 0
                      ? entry.draft.name.trim()
                      : t('prescription.review.unnamedLine', { n: entry.position }),
                  reason: blockSentence(entry.draft, entry.reason, t),
                })}
              </Text>
            ))}
          </View>
        ) : null}

        {/* THE THIRD SECTION, ON THE SAME FOOTING AS THE SECOND. "Not shown yet" says a
            line is unfinished; this says a line is not coming at all. Both are things the
            preview would otherwise report by omission, and an omission directly above a
            confirm button reads as completeness. Named, because "one medicine is unticked"
            is not something she can check against the paper in her hand. It travels into
            the read-back dialog too — the same element, rendered twice. */}
        {excluded.length > 0 ? (
          <View style={{ gap: spacing.sm, paddingTop: ready.length + held.length > 0 ? spacing.md : 0 }}>
            <Text variant="label">{t('prescription.review.notBeingAdded')}</Text>
            {excluded.map((entry) => (
              <Text key={entry.draft.index} variant="body" tone="muted">
                {entry.draft.name.trim().length > 0
                  ? entry.draft.name.trim()
                  : t('prescription.review.unnamedLine', { n: entry.position })}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {/* Said out loud rather than left to be noticed. Two of her slots on the same
          clock time collapse into one dose — `confirmExtraction` merges them because
          UNIQUE(thread_id, version, time_local) would otherwise abort the whole save —
          and a preview listing one time under a medicine she just told the app to give
          twice a day is only honest if the reason is on screen next to it. It travels
          into the read-back too: a dose that quietly vanishes is the exact thing a
          read-back exists to surface. */}
      {collapsedTimings.length > 0 ? (
        <View style={{ paddingTop: spacing.md, gap: spacing.sm }}>
          <Banner
            variant="attention"
            title={t('prescription.review.timesCollapsedTitle')}
            message={t('prescription.review.timesCollapsed')}
          />
          {collapsedTimings.map((entry) => (
            <Text key={`${entry.name}-${entry.dropped.key}`} variant="body" weight="600">
              {t('prescription.review.timesCollapsedLine', {
                name: entry.name,
                first: slotLabel(entry.kept, t),
                second: slotLabel(entry.dropped, t),
                time: formatTime(entry.kept.time),
              })}
            </Text>
          ))}
        </View>
      ) : null}

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.md }}>
        {t('prescription.review.timesAreYours')}
      </Text>
    </View>
  );

  return (
    <Screen
      variant="fixed"
      footer={
        <View style={{ gap: spacing.sm }}>
          {/* Report 4. A count and a way to get there, not a rule. The icon and the word
              carry it together — the amber alone would say nothing to a monochrome eye.

              THE BUTTON IS THE THING THAT CANNOT SHRINK, SO IT IS THE THING THAT IS KEPT
              SHORT. `Button`'s outer View is `alignSelf` and nothing else, and Yoga's
              `flexShrink` default in RN is 0, so it takes its full intrinsic width out of
              361dp of footer and never gives any back; the caption is the only `flex: 1`
              child, so it absorbs the whole shortfall. At OS 1.3× "Take Me There" measured
              about 194dp and left the count 131dp — three lines where the vertical budget
              in the file header allows two, and four in large-text mode, every extra line
              coming straight out of the 141dp the medicine cards are living on. "Show Me"
              is ~120dp and puts the count back on two lines at the reference scale.

              `flexShrink: 1` and `alignSelf: 'center'` are both corrections to that same
              wrapper, and both matter at the sizes the label is NOT short enough: shrink
              lets a long Hindi label wrap inside its own 56dp-floored box instead of
              squeezing the count into a one-glyph column, and the explicit `alignSelf`
              undoes the `flex-start` the component sets, which otherwise overrides this
              row's `alignItems: 'center'` and floats the button level with the first line
              of a three-line caption. */}
          {held.length > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Icon name="alert" size={20} color={colors.attention} />
              <Text variant="caption" tone="attention" style={{ flex: 1 }}>
                {held.length === 1
                  ? t('prescription.review.blockedOne')
                  : t('prescription.review.blockedMany', { count: held.length })}
              </Text>
              <Button
                title={t('prescription.review.goToFirst')}
                accessibilityLabel={t('prescription.review.goToFirstA11y')}
                onPress={goToFirstBlocking}
                variant="ghost"
                size="md"
                style={{ flexShrink: 1, alignSelf: 'center' }}
              />
            </View>
          ) : null}
          <Button
            title={t('prescription.confirmAll')}
            onPress={() => (anyProposalAgreed ? setReadBack(true) : void confirmAll())}
            variant="primary"
            size="xl"
            fullWidth
            disabled={blocked}
            loading={saving}
          />
        </View>
      }
    >
      <ScreenHeader title={t('prescription.reviewTitle')} onBack={leave} />

      {/* THE PINNED BLOCK — the box the paper and the cards divide between them.
          It exists so that the photo's share is a share of THIS, and not of the window:
          the header is not part of what they are dividing, and neither is the footer. One
          wrapper is also the cheapest way to keep the arithmetic honest when a row is
          added here later — the share stays 40% of whatever is left. */}
      <View style={{ flex: 1 }}>
        {/* THE PAPER, PINNED. It does not scroll with the cards, and it collapses rather
            than disappearing — see decision 1. `flexShrink: 1` is what makes it, and not
            the medicine list, the thing that gives way when the window is short or the
            keyboard is up. */}
        <PressableScale
          onPress={() => setZoomed(true)}
          disabled={!currentPage}
          accessibilityRole="button"
          accessibilityLabel={t('prescription.review.openPhoto')}
          style={{
            flexBasis: photoShare,
            flexGrow: 0,
            flexShrink: 1,
            minHeight: PHOTO_MIN_HEIGHT,
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bgSunken,
            overflow: 'hidden',
          }}
        >
          {currentPage ? (
            // Decorative INSIDE the pressable: the parent already carries the role and the
            // label, and a second accessible node here would take TalkBack's focus away
            // from the control that actually does something.
            <Image
              source={{ uri: currentPage }}
              resizeMode={photoFit}
              style={{ width: '100%', height: '100%' }}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="info" size={40} color={colors.textMuted} />
            </View>
          )}
        </PressableScale>

        {/* One row, always rendered, because the collapse toggle lives in it and the page
            switcher must stay reachable while collapsed — a two-page discharge summary
            whose second page can only be reached by expanding first is a page she will not
            find.

            IT WRAPS, AND IT HAS TO. Three children, and until this row carried the collapse
            toggle only two of them were ever on it. `Button`'s outer View is `alignSelf`
            and nothing else, and Yoga's `flexShrink` default in RN is 0, so BOTH buttons
            take their full intrinsic width and neither wraps its label: at OS 1.3× on a
            393dp handset "Next Page" (~146dp) plus "Hide The Photo" (~207dp) plus two 12dp
            gaps is 377dp against 361dp of content width. The only child that could give way
            was the `flex: 1` page counter, which collapsed to nothing — "Page 1 of 3"
            wrapped into a one-glyph column — and the remaining overflow pushed the toggle
            past the right edge. In large-text mode the two labels come to ~441dp and the
            control the whole of Report 2 depends on is off the screen. A hospital discharge
            summary is multi-page by definition, which is the document this row was widened
            for. `flexWrap` puts the buttons on their own line rather than off the edge, and
            `flexShrink: 1` on each lets a long Hindi label wrap to two lines inside its own
            56dp-floored box — the shape `Button.tsx`'s wrapper View exists to make possible.
            Both are needed: wrapping alone still clips a single button that is wider than
            the row. Cost when it fires: one more line, ~56dp, out of the cards' share. */}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacing.md,
            paddingTop: spacing.sm,
          }}
        >
          {multiPage ? (
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              {t('prescription.pageOf', { n: pageIndex + 1, total: loaded.pages.length })}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {multiPage ? (
            <Button
              title={t('prescription.review.nextPage')}
              onPress={() => setPageIndex((i) => (i + 1) % loaded.pages.length)}
              variant="ghost"
              size="md"
              style={{ flexShrink: 1 }}
            />
          ) : null}
          {/* No icon, and that is a decision rather than an omission: the icon set has a
              chevron that points down and none that points up, so one of the two states
              would carry an arrow contradicting its own label. Two plain words that name
              the outcome beat a glyph that is wrong half the time.

              THE LABEL FOLLOWS HER CHOICE, NOT THE EFFECTIVE STATE. While the keyboard is
              up the paper is collapsed whatever she chose, and reading the label off that
              would make one press appear to do nothing (it would be setting a value that is
              already in force). The button is the control for the standing choice; the
              keyboard collapse reverts itself. */}
          <Button
            title={
              photoCollapsed
                ? t('prescription.review.photoShow')
                : t('prescription.review.photoHide')
            }
            onPress={() => setPhotoCollapsed((collapsed) => !collapsed)}
            variant="ghost"
            size="md"
            style={{ flexShrink: 1 }}
          />
        </View>

        {/* Pinned too. The warning is true for as long as any of these cards is on screen,
            so it stays on screen for exactly that long. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: spacing.sm,
            paddingVertical: spacing.md,
          }}
        >
          <Icon name="alert" size={22} color={colors.attention} />
          <Text variant="caption" tone="attention" style={{ flex: 1 }}>
            {t('prescription.aiWarning')}
          </Text>
        </View>

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: spacing.xl, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
          persistentScrollbar
        >
          <Text variant="body" tone="muted">
            {t('prescription.reviewInstruction')}
          </Text>

          {loaded.unnamedCount > 0 ? (
            <Card variant="sunken">
              <Text variant="body">{t('prescription.review.unnamed')}</Text>
            </Card>
          ) : null}

          {/* Bounded by the line count of one prescription. The cards are input-driven and
              cannot have a fixed row height, which is what a FlatList would need here in
              order to be an improvement rather than a regression.

              The wrapper exists only to record where each card starts, so the footer's
              "Take Me There" can land on the first unfinished one. It carries no style: a
              padded wrapper would double the gap between cards. */}
          {actionable.map((draft, position) => (
            <View
              key={draft.index}
              onLayout={(event) => {
                cardTops.current.set(draft.index, event.nativeEvent.layout.y);
              }}
            >
              <DraftCard
                draft={draft}
                position={position}
                total={actionable.length}
                slots={slots}
                onPatch={patch}
                onTouch={markTouched}
                revealBlocks={revealBlocks}
                t={t}
                formatTime={formatTime}
              />
            </View>
          ))}

          {/* ALREADY BEING TAKEN — AND THE ONE CLAIM IN IT THAT NEEDED A WAY OUT.
              This bucket has no card, no tick and no review, which is right for a line the
              diff matched by its written name and found identical. It was NOT right for a
              line matched by the SALT name: `buildSupersessionDiff` flags that match as
              weaker evidence (Glycomet → Metformin is a brand switch; it is also what a
              genuinely different drug sharing a generic looks like), `buildDrafts` carries
              the flag onto the draft, and `DraftCard` prints the warning — but a continued
              row never reaches `DraftCard`, so the one bucket that offers no way to disagree
              was also the one dropping the warning. A wrong salt-level match then adds
              nothing at all, under a heading stating that nothing needs to change.
              So: the warning is printed per row, and the row gets a control that moves it up
              into the cards as a medicine of its own. */}
          {continued.length > 0 ? (
            <Card variant="sunken" style={{ gap: spacing.sm }}>
              <Text variant="label">
                {t('prescription.review.alreadyTaking', { count: continued.length })}
              </Text>
              <Divider style={{ marginVertical: spacing.sm }} />
              {continued.map((draft) => (
                <View key={draft.index} style={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
                  <Text variant="body" weight="600">
                    {draft.name}
                  </Text>
                  {draft.matchedOnGeneric ? (
                    <View style={{ gap: spacing.sm }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                        <Icon name="alert" size={20} color={colors.attention} />
                        <Text variant="caption" tone="attention" style={{ flex: 1 }}>
                          {t('prescription.review.matchedOnGeneric')}
                        </Text>
                      </View>
                      <Button
                        title={t('prescription.review.notTheSame')}
                        onPress={() => promoteToNew(draft)}
                        variant="secondary"
                        size="md"
                        accessibilityLabel={t('prescription.review.notTheSameA11y', {
                          name: draft.name,
                        })}
                      />
                    </View>
                  ) : null}
                </View>
              ))}
              <Text variant="caption" tone="muted" style={{ paddingTop: spacing.sm }}>
                {t('prescription.review.alreadyTakingNote')}
              </Text>
            </Card>
          ) : null}

          {actionable.some((d) => !d.include) ? (
            <Card variant="sunken" style={{ gap: spacing.sm }}>
              <Text variant="body">{t('prescription.cannotScheduleUnconfirmed')}</Text>
              <Text variant="caption" tone="muted">
                {t('prescription.review.excluded')}
              </Text>
            </Card>
          ) : null}

          {/* THE PREVIEW, IN LITERAL CLOCK TIMES, DIRECTLY ABOVE THE CONFIRM. Slot names
              alone ("after breakfast") are not checkable against anything, and with nine of
              them two adjacent names read alike; "08:30 and 8:30 pm" is checkable.

              THIS IS ALSO THE SECOND READING OF THE FREQUENCY, and that is why it must keep
              printing digits. A proposal she agreed to on a card was checked in the paper's
              own notation ("1-0-1"); here the same instruction appears as four wall-clock
              times under a drug she takes twice a day. An error has to survive both forms,
              and the one that will actually wake her is this one. `propose.ts` says the same
              thing from its side: the claim that this app never picks clock times holds only
              while this list prints them.

              REPORT 3 — INCOMPLETE MEDICINES ARE NAMED, NOT PRINTED AND NOT DROPPED. This
              used to print one anonymous "Type how many times a day to see the times." per
              unfinished line, so a fifteen-line discharge summary opened with fifteen
              identical grey sentences and no names. The existing argument three lines below
              — that an over-cap or unnamed rhythm gets a NAMED sentence rather than an empty
              list of times — is right and is simply extended: a medicine with nothing to say
              yet is named too, under its own heading, with the reason it is being held. The
              one thing that must never happen is a short tidy list she reads as complete. */}
          <Card>
            <Text variant="label">{t('prescription.review.remindersTitle')}</Text>
            <Divider style={{ marginVertical: spacing.md }} />
            {previewBody}
          </Card>
        </ScrollView>
      </View>

      {/*
        THE READ-BACK GATE, and the compensation for pre-filling the dose count.

        The card asked her to check a number against the paper's own notation ("1-0-1").
        This asks her to check the same instruction in the only other form it has — the
        literal times that will wake her — and the write happens on the far side of it and
        nowhere else. Two representations of one error, and it has to survive both.

        Backdrop dismissal is off, on the same reasoning as `medicine/schedule.tsx`: a
        stray tap must not be able to resolve a decision about when a TB dose rings. The
        back button means "let me fix it", which is the safe direction.

        It appears ONLY when at least one number came from the photograph — see
        `anyProposalAgreed`. A gate that fires on every prescription is a gate she learns
        to tap through; this one fires exactly where something was made cheaper.
      */}
      <Dialog
        visible={readBack}
        title={t('prescription.review.readBackTitle')}
        dismissOnBackdrop={false}
        onRequestClose={() => {
          if (!saving) setReadBack(false);
        }}
        scrollable
        footer={
          /* THE CORRECTIVE IS THE ONLY THING PINNED, and that is the whole correction to
             this dialog. `Dialog` renders `footer` as a SIBLING BELOW the ScrollView that
             holds the body (see `Dialog.tsx`), so a pinned primary button is on screen the
             instant the dialog opens — and with fifteen medicines the times it is asking
             her to read are several screens further down. The gate that the file header
             calls "the one that does not depend on her attention holding" could be
             discharged in one tap with not a single line of the list ever rendered into
             the viewport, which made it weaker than the preview card it duplicates: at
             least that card has to be scrolled past.

             The confirm now sits at the END OF THE LIST, inside the scroll, below the last
             medicine — so reaching it IS reading past them, with no state to keep and
             nothing to get wrong. "Change Something" stays pinned because the corrective
             must be reachable from anywhere, including the top. */
          <Button
            title={t('prescription.review.readBackChange')}
            onPress={() => setReadBack(false)}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={saving}
          />
        }
      >
        <View style={{ gap: spacing.md }}>
          <Text variant="body" tone="muted">
            {t('prescription.review.readBackInstruction')}
          </Text>
          {previewBody}
          <Button
            title={t('prescription.confirmAll')}
            onPress={() => void confirmAll()}
            variant="primary"
            size="xl"
            fullWidth
            loading={saving}
          />
        </View>
      </Dialog>

      <Dialog visible={zoomed} onRequestClose={() => setZoomed(false)}>
        {currentPage ? (
          <Image
            source={{ uri: currentPage }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('prescription.review.pageLabel', { n: pageIndex + 1 })}
            resizeMode="contain"
            style={{
              width: '100%',
              height: Math.round(height * 0.6),
              backgroundColor: colors.bgSunken,
              borderRadius: radii.md,
            }}
          />
        ) : null}
      </Dialog>

      {/* What actually happened, stated line by line. A medicine that ended up without a
          schedule is named here rather than quietly appearing on the list without ever
          ringing. */}
      <Dialog
        visible={outcome !== null}
        title={t('prescription.review.savedTitle')}
        dismissOnBackdrop={false}
        footer={
          <Button
            title={t('common.continue')}
            onPress={continueAfterSave}
            variant="primary"
            size="lg"
            fullWidth
          />
        }
      >
        {outcome ? (
          <View style={{ gap: spacing.md }}>
            {/* THE COUNT IS OF MEDICINES THAT WILL RING, and an as-needed row is not one.
                `confirmExtraction` reports a PRN schedule as a created row with
                `dosesPerDay: 0` — correctly; it created one — so counting rows would have
                told her "3 medicines are set up with reminders" about a list containing an
                SOS painkiller that is deliberately never going to make a sound. Every
                medicine that was written is still named below, under the heading that says
                why it is silent. */}
            <Text variant="body">
              {withReminders.length > 0
                ? t('prescription.review.savedCount', { count: withReminders.length })
                : nothingWritten
                  ? t('prescription.review.savedNone')
                  : t('prescription.review.savedNoneRinging')}
            </Text>

            {/* SPLIT ON THE REASON CODE, NEVER ON THE DETAIL STRING. Two medicines land in
                `needsManualSchedule` with the same shape — a confirmed row and no schedule
                — and only one of them owes anything. A dose she has just told the app was
                already given, listed under "their timings have to be typed in" beside a
                button that goes and asks for them, contradicts the answer she gave on the
                card two minutes earlier. `ManualReason` carries the difference. */}
            {timingsOwed.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('prescription.review.needsTimings')}</Text>
                {timingsOwed.map((row) => (
                  <View key={row.threadId} style={{ gap: spacing.xs }}>
                    <Text variant="body" weight="600">
                      {row.name}
                    </Text>
                    <Button
                      title={t('prescription.review.setTimings')}
                      onPress={() => {
                        setOutcome(null);
                        router.replace(`/medicine/schedule?threadId=${row.threadId}`);
                      }}
                      variant="secondary"
                      size="md"
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {/* The as-needed ones, named for the same reason: they are not in the count
                above, and an absence directly under "3 medicines are set up" reads as
                completeness. No button — nothing is owed here either; the dose is written
                down from the "only when needed" screen when she takes one. */}
            {asNeededSaved.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('prescription.review.savedAsNeeded')}</Text>
                {asNeededSaved.map((row) => (
                  <Text key={row.threadId} variant="body" weight="600">
                    {row.name}
                  </Text>
                ))}
              </View>
            ) : null}

            {/* Named, and with no button under it: nothing is outstanding. Saying nothing
                at all would be worse — she ticked these lines and they are not in the
                count of medicines with reminders, so without their own heading they would
                simply be missing from the account of what just happened. */}
            {recordedOnly.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('prescription.review.recordedOnly')}</Text>
                {recordedOnly.map((row) => (
                  <Text key={row.threadId} variant="body" weight="600">
                    {row.name}
                  </Text>
                ))}
              </View>
            ) : null}

            {/* A medicine that was written with FEWER rows than she asked for. It is not
                in `needsManualSchedule` — it did get a schedule, just a short one — so
                without this the dialog counts it as fully set up and the dose that
                vanished is never mentioned again. Same correction path as a medicine with
                no schedule at all. */}
            {savedCollapsed.length > 0 ? (
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('prescription.review.timesCollapsedTitle')}</Text>
                {savedCollapsed.map((entry) => (
                  <View key={`${entry.threadId}-${entry.timeLocal}`} style={{ gap: spacing.xs }}>
                    <Text variant="body" weight="600">
                      {t('prescription.review.timesCollapsedLine', {
                        name: entry.name,
                        first: entry.first,
                        second: entry.second,
                        time: formatTime(entry.timeLocal),
                      })}
                    </Text>
                    <Button
                      title={t('prescription.review.setTimings')}
                      onPress={() => {
                        setOutcome(null);
                        router.replace(`/medicine/schedule?threadId=${entry.threadId}`);
                      }}
                      variant="secondary"
                      size="md"
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {outcome.skipped.length > 0 ? (
              <Text variant="body" tone="muted">
                {t('prescription.review.notAdded', {
                  names: outcome.skipped.map((row) => row.name).join(', '),
                })}
              </Text>
            ) : null}

            {!outcome.alarmsArmed && outcome.created.length + outcome.updated.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                <Icon name="alert" size={20} color={colors.attention} />
                <Text variant="caption" tone="attention" style={{ flex: 1 }}>
                  {t('prescription.review.alarmsNotArmed')}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </Dialog>
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// One medicine
// ═══════════════════════════════════════════════════════════════════════════════

type DraftCardProps = {
  draft: Draft;
  position: number;
  total: number;
  slots: readonly SlotDefinition[];
  onPatch: (index: number, change: Partial<Draft>) => void;
  onTouch: (index: number, field: string) => void;
  /**
   * Has she asked to be shown the unfinished lines? Set once, by the footer's jump, and
   * never unset — see the marker below. It is a screen-level fact rather than a per-card
   * one because the jump means "show me where these are", plural.
   */
  revealBlocks: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatTime: (localTime: string) => string;
};

function DraftCard({
  draft,
  position,
  total,
  slots,
  onPatch,
  onTouch,
  revealBlocks,
  t,
  formatTime,
}: DraftCardProps) {
  const { colors } = useTheme();
  const doses = parseDoses(draft.dosesPerDayText);
  const dosesTyped = draft.dosesPerDayText.trim().length > 0;
  const overCap = doses !== null && doses > MAX_AI_DOSES_PER_DAY;
  /**
   * Is this line still a number of doses a day at all?
   *
   * Everything below that reads the count reads this FIRST. The number box is not cleared
   * when she names a line as-needed — she may have typed a count before reading the line
   * above it, and clearing would throw that away if she changes her mind back — so a count
   * left sitting in the box would otherwise go on producing slot times, a per-card
   * schedule sentence and a preview line for a medicine that is never going to be given a
   * time at all.
   */
  const perDay = draft.doseTiming === 'per_day';
  // Empty whenever this card is heading for manual entry — over the cap, or a rhythm the
  // decoder will not name slots for. The per-card line below is suppressed rather than
  // printed with no times in it.
  const plan =
    !perDay || doses === null || overCap
      ? null
      : planSlots(draft.parsed, doses, slots, intervalIsEarned(draft));
  const planned = plan?.chosen ?? [];

  const blocking = blockingReason(draft);
  /**
   * Has she been INTO this card? Any focus or edit on any field sets a `touched` bit, and
   * `touched` starts empty on every draft, so a non-empty map is the closest thing this
   * screen has to "she worked on this line". It is read only to decide whether the marker
   * has anything to tell her yet — never to relax the gate, which is `blockingReason`'s
   * job alone and is unchanged by any of this.
   */
  const visited = Object.keys(draft.touched).length > 0;
  const showBlock = revealBlocks || visited;
  const { frequency: freqProposal, food: foodProposal } = draft.proposal;
  /**
   * The proposal is still on the table: she has neither agreed to it nor replaced it.
   *
   * Everything that makes a pre-filled number safe hangs off this — the question chips are
   * drawn, the helper text tells her to check the photo, and focus alone does not clear the
   * gate. Once she answers, the number is either hers or one she has said out loud matches
   * the paper, and the card stops speaking for the app.
   */
  const awaitingAnswer = freqProposal.kind === 'proposal' && draft.freqAnswer === 'unanswered';
  const freqEvidence = freqProposal.evidence.text;

  /**
   * The refusals that come with an answer of their own — null for the other twelve.
   *
   * `as_needed` and `one_off` are the only two members of `FREQUENCY_REFUSALS` that are
   * FACTS ABOUT THE PAPER rather than doubts about the reading, and they are the only two
   * for which a dose count is the wrong question. The annotation is doing real work: the
   * two refusal codes and the two `DoseTiming` kinds share their names deliberately, and
   * `DoseTiming | null` is what stops that coincidence from being quietly broken by a
   * rename on either side.
   */
  const timingAnswer: DoseTiming | null =
    freqProposal.kind === 'none' &&
    (freqProposal.reason === 'as_needed' || freqProposal.reason === 'one_off')
      ? freqProposal.reason
      : null;

  /**
   * EXACTLY WHAT AGREEING WOULD PRODUCE — computed the same way the write is.
   *
   * Not the proposal's slot keys read off directly: `planSlots` is what `scheduleFor` calls,
   * so it is the only thing entitled to say what the chip is authorising. It also collapses
   * two of her slots that share a clock time, which the proposal knows nothing about — a
   * chip promising two times where one will be written is exactly the omission this label
   * exists to close.
   */
  const agreePlan =
    freqProposal.kind === 'proposal'
      ? planSlots(draft.parsed, freqProposal.dosesPerDay, slots, true)
      : null;
  const agreeTimes = joinTimes(
    (agreePlan?.chosen ?? []).map((slot) => formatTime(slot.time)),
    t('common.and'),
  );

  const field = (name: string, label: string, value: string, onChange: (next: string) => void) => {
    const isFlagged = draft.flagged.includes(name);
    const suggested = suggestionFor(draft, name);
    return (
      <View style={{ gap: spacing.sm }}>
        {isFlagged ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Icon name="alert" size={20} color={colors.attention} />
            <View style={{ flex: 1, gap: spacing.xs }}>
              <Text variant="caption" tone="attention">
                {t('prescription.review.checkThis')}
              </Text>
              {suggested.length > 0 ? (
                <Text variant="caption" tone="muted">
                  {`${t('prescription.appSuggests')}: ${suggested}`}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}
        <TextField
          label={isFlagged ? `${label} — ${t('prescription.doctorWrote')}` : label}
          value={value}
          onChangeText={(next) => {
            onChange(next);
            onTouch(draft.index, name);
          }}
          // Focus counts as touched as well as a change: a flagged field whose suggestion
          // happens to be right cannot be "edited", and the bar this gate sets is that her
          // attention went to that specific line.
          onFocus={() => onTouch(draft.index, name)}
        />
      </View>
    );
  };

  return (
    <Card style={{ gap: spacing.lg }}>
      <Text variant="caption" tone="muted">
        {t('prescription.review.medicineOf', { n: position + 1, total })}
      </Text>

      {/* WHERE THE DEAD BUTTON GETS AN ADDRESS. It sits at the very top of the card so
          that the footer's jump lands on the reason, not above it, and it clears itself
          condition by condition as she works down — the marker disappearing IS the
          feedback that the last thing she did counted. Icon plus word, never the colour
          alone, and amber rather than red: this is an unfinished form, not a verdict.

          AND IT MEANS "YOU LEFT THIS ONE", NEVER "YOU HAVE NOT REACHED THIS ONE YET" —
          which is why `showBlock` exists and is not simply `blocking !== null`. Every line
          arrives ticked with either an unanswered proposal or an empty number box, so
          `blockingReason` is non-null for EVERY card the instant the screen opens: a
          fifteen-line discharge summary opened with fifteen amber "Not Ready" markers
          stacked under a sixteenth, the pinned AI warning. The marker whose whole job is to
          locate the three unfinished lines was therefore at maximum noise for the entire
          time she needed it, and it is the same glyph as the per-field "check this against
          the paper" warnings — so the one icon she is being trained to scan for was the one
          that is always on. By card four it is wallpaper, on a screen read with presbyopia.

          Two things turn it on, and between them they cover both meanings. A card she has
          been INTO and left unfinished shows it immediately (`visited` — any field touched
          on this card). And the footer's "Take Me There" reveals it on every unfinished
          card at once, because that jump lands on a reason that has to be there when she
          arrives. Nothing is hidden by this: the footer count is on screen from the first
          render, the confirm button is inert, and the preview's "Not shown yet" section
          names EVERY held medicine with this same sentence throughout. What is deferred is
          one redundant copy of a signal, until it can mean something. */}
      {blocking !== null && showBlock ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Icon name="alert" size={22} color={colors.attention} />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="label" tone="attention">
              {t('prescription.review.notReady')}
            </Text>
            {/* The PLACE, not just the rule. `blockSentence` names the first marked field
                she has not been into — "“How much each time” has not been looked at yet."
                — because a card at large text is taller than the window, so this marker and
                the field it is about are never on screen together. */}
            <Text variant="caption" tone="muted">
              {blockSentence(draft, blocking, t)}
            </Text>
          </View>
        </View>
      ) : null}

      {draft.kind === 'changed' ? (
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Icon name="alert" size={20} color={colors.attention} />
            <Text variant="caption" tone="attention" style={{ flex: 1 }}>
              {t('prescription.review.doseChange')}
            </Text>
          </View>
          {draft.changes.map((change) => (
            <Text key={`${change.field}:${change.to}`} variant="caption" tone="muted">
              {t('prescription.review.changeLine', {
                field: t(`prescription.review.field.${change.field}`),
                from: change.from,
                to: change.to,
              })}
            </Text>
          ))}
          <Text variant="caption" tone="muted">
            {t('prescription.review.sameThread')}
          </Text>
        </View>
      ) : null}

      {draft.matchedOnGeneric ? (
        <Text variant="caption" tone="attention">
          {t('prescription.review.matchedOnGeneric')}
        </Text>
      ) : null}

      <Chip
        label={t('prescription.review.include')}
        selected={draft.include}
        selectionMode="multiple"
        onPress={() => onPatch(draft.index, { include: !draft.include })}
        grow
      />

      {field('name', t('prescription.medicineName'), draft.name, (next) =>
        onPatch(draft.index, { name: next }),
      )}
      {field('strength', t('prescription.strength'), draft.strength, (next) =>
        onPatch(draft.index, { strength: next }),
      )}
      {field('quantity', t('prescription.review.quantity'), draft.quantityText, (next) =>
        onPatch(draft.index, { quantityText: next }),
      )}

      <Divider />

      {/* THE FREQUENCY. Read the block top to bottom and it is: what the paper says, the
          question about it, and only then the number. That order is deliberate — the
          evidence has to be read before the answer is offered, and an answer above its own
          evidence is a card she agrees with and then, maybe, checks. */}
      <View style={{ gap: spacing.md }}>
        {/* THE PAPER'S OWN CHARACTERS, never the normalised code. Printing "BD" here would
            ask her to check the app against the app; "1-0-1" is what is in her hand.
            `propose.ts` refuses to propose at all when it has nothing to put on this line,
            which is what makes the pre-filled number below defensible. */}
        {freqEvidence !== null ? (
          <Text variant="body" weight="600">
            {t('prescription.review.onThePaper', { text: freqEvidence })}
          </Text>
        ) : null}

        {/* Why there is no number in the box, in her words. Fourteen different reasons,
            fourteen different sentences: "the paper says this is only when needed" and
            "the app could not read it" are both an empty box, and the wrong one of the two
            sends her back to the prescription to look for something never written on it. */}
        {freqProposal.kind === 'none' ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Icon name="info" size={20} color={colors.textMuted} />
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              {t(FREQUENCY_REFUSAL_KEYS[freqProposal.reason], { max: MAX_AI_DOSES_PER_DAY })}
            </Text>
          </View>
        ) : null}

        {/* The old "please check this against the paper" banner still fires for a frequency
            the model rated low WITHOUT proposing anything. Where there is a proposal the
            question below IS the check, and two warnings about one field read as noise. */}
        {draft.flagged.includes('frequency') && freqProposal.kind === 'none' ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Icon name="alert" size={20} color={colors.attention} />
            <Text variant="caption" tone="attention" style={{ flex: 1 }}>
              {t('prescription.review.checkThis')}
            </Text>
          </View>
        ) : null}

        {/* TWO ANSWERS, NEITHER SELECTED WHEN THE CARD IS DRAWN.
            A single "looks right" tick has exactly one satisfying action, and that action
            is what a thumb finds on the fourth card having stopped reading at the second.
            The decline sits FIRST for the same reason `ReadBackDialog` puts "Correct it"
            first: a finger that lands without reading lands on the harmless one, and the
            harmless one here is the one that costs her typing and risks nothing.
            The agreement spells the WHOLE INSTRUCTION out — the count, the clock times it
            lands on and whether it skips days — so the tap is agreement with a stated claim
            rather than with a card that looks right, and so that ten once-daily lines on a
            discharge summary do not render ten identical chips in ten identical positions.

            STACKED, NOT SIDE BY SIDE, and that follows from the label. Two chips sharing a
            row gave the long one about half the width, which in Hindi at the largest text
            size is four wrapped lines beside two words — the shape a thumb learns to hit
            without reading. Full width each keeps the sentence on one or two lines, and the
            decline still sits first, where a finger that lands without reading lands on the
            harmless one. */}
        {freqProposal.kind === 'proposal' ? (
          <View style={{ gap: spacing.md }}>
            <Chip
              label={t('prescription.review.freqDecline')}
              selected={draft.freqAnswer === 'own'}
              selectionMode="single"
              onPress={() => {
                onPatch(draft.index, {
                  freqAnswer: 'own',
                  // The box is emptied only on the way OUT of a proposal. Pressing a chip
                  // that is already selected must not wipe a number she typed herself.
                  ...(draft.freqAnswer === 'own' ? {} : { dosesPerDayText: '' }),
                });
                onTouch(draft.index, 'frequency');
              }}
            />
            {/* NO HINT ON THIS CHIP, AND THE EVIDENCE LINE IS THE REASON. It quoted the
                whole verbatim back — `freqEvidence` IS `freqProposal.evidence.text`, so
                the hint was the sentence rendered four nodes above, read a second time.
                Nothing bounds that string: the schema asks for the frequency "exactly as
                written on the paper", and `decodeFrequency` matches its patterns anywhere
                inside one, so "1 tab to be taken twice daily after food for 6 months"
                decodes to BD, corroborates, and becomes evidence. TalkBack reaches the
                visible line first in reading order and announces it there; repeating it
                inside the chip made every proposed card say it twice. The visible line
                stays uncapped — truncating the paper's own words is the worse failure,
                because finding them on the photograph is the act being asked for. */}
            <Chip
              label={agreeLabel(t, freqProposal.dosesPerDay, agreeTimes, agreePlan?.intervalDays)}
              selected={draft.freqAnswer === 'agreed'}
              selectionMode="single"
              onPress={() => {
                onPatch(draft.index, {
                  freqAnswer: 'agreed',
                  dosesPerDayText: String(freqProposal.dosesPerDay),
                });
                onTouch(draft.index, 'frequency');
              }}
            />
          </View>
        ) : null}

        {/* THE ANSWER FOR A LINE THAT IS NOT TAKEN A NUMBER OF TIMES A DAY.
            Offered on exactly the two refusals that are FACTS ABOUT THE PAPER rather than
            doubts about the reading — "SOS" and "STAT" — and on no others. The sentence
            immediately above it is the paper's own instruction ("this one is taken only
            when needed"); until this chip existed the card printed that sentence and then
            demanded a number of doses a day underneath it, which left her two ways
            forward: a number, which schedules daily alarms for an as-needed painkiller, or
            taking the tick off, which records nothing. `confirm.ts` has accepted
            `{ kind: 'prn' }` all along — only this screen never produced one.

            IT IS NOT PRE-SELECTED AND IT IS NOT A SECOND WAY PAST THE GATE. Nothing seeds
            `doseTiming`; it is an act, exactly like agreeing to a dose count, and
            `blockingReason` still holds the line for its name and for every flagged field
            she has not visited. Pressing the chosen one again returns to a number, the
            same way the food row clears — a line answered by a mis-tap must be reversible
            without leaving the card. */}
        {timingAnswer !== null ? (
          <View style={{ gap: spacing.sm }}>
            <Chip
              label={t(
                timingAnswer === 'as_needed'
                  ? 'prescription.review.timingAsNeeded'
                  : 'prescription.review.timingOneOff',
              )}
              selected={!perDay}
              selectionMode="single"
              grow
              accessibilityHint={perDay ? undefined : t('prescription.review.timingClearHint')}
              onPress={() =>
                onPatch(draft.index, { doseTiming: perDay ? timingAnswer : 'per_day' })
              }
            />
            {/* What the tap does, said before it is taken back — the chip names the
                instruction, this names the consequence for her reminders. */}
            {!perDay ? (
              <Text variant="caption" tone="muted">
                {t(
                  draft.doseTiming === 'as_needed'
                    ? 'prescription.review.timingAsNeededChosen'
                    : 'prescription.review.timingOneOffChosen',
                )}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* The count, and everything that steps it. Hidden — not merely ignored — once she
            has said this line is not taken a number of times a day: a live number box under
            an answered "Only When Needed" invites a number that would then be the only
            thing on the card contradicting it. */}
        {perDay ? (
          <>
          <TextField
            label={t('prescription.review.dosesPerDay')}
            helper={
              awaitingAnswer
                ? t('prescription.review.dosesPerDayHelpProposed')
                : draft.freqAnswer === 'agreed'
                  ? t('prescription.review.dosesPerDayHelpAgreed')
                  : t('prescription.review.dosesPerDayHelp')
            }
            error={
              dosesTyped && doses === null ? t('prescription.review.dosesPerDayInvalid') : undefined
            }
            value={draft.dosesPerDayText}
            onChangeText={(next) => {
              // Typing is producing the number, so it ends the proposal outright. An edited
              // value must not keep wearing the app's answer.
              onPatch(draft.index, {
                dosesPerDayText: next.replace(/[^0-9]/g, ''),
                freqAnswer: 'own',
              });
              onTouch(draft.index, 'frequency');
            }}
            // FOCUS COUNTS EVERYWHERE ON THIS SCREEN EXCEPT HERE, AND ONLY WHILE A PROPOSAL
            // IS UNANSWERED. Everywhere else the bar is that her attention reached the field,
            // because a suggestion that happens to be right cannot be "edited". A pre-filled
            // number is different in exactly one way: doing nothing to it accepts it, and a
            // stray focus is doing nothing. So while the question is open, the only things
            // that clear this gate are answering it or replacing the number.
            onFocus={() => {
              if (!awaitingAnswer) onTouch(draft.index, 'frequency');
            }}
            keyboardType="number-pad"
            maxLength={2}
          />
          {/* THE APP'S NUMBER AND HERS, SIDE BY SIDE, WHENEVER THEY DIFFER.
              Once she has replaced a proposal the card holds two claims about this line and
              only one of them is on screen: the evidence line above still quotes the words
              the app read and says nothing whatever about disagreeing with them, and the
              helper text under the box changes from "you have said this matches" to "read it
              off the paper" — a difference nobody reads as a contradiction. This states both
              numbers and takes no side; hers is the one that will be written. It is also the
              marker for the stepper case below, where the change can come from a single tap
              rather than from typing. */}
          {freqProposal.kind === 'proposal' &&
          draft.freqAnswer === 'own' &&
          doses !== null &&
          doses !== freqProposal.dosesPerDay ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Icon name="info" size={20} color={colors.textMuted} />
              <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                {t('prescription.review.freqDisagrees', {
                  n: freqProposal.dosesPerDay,
                  m: doses,
                })}
              </Text>
            </View>
          ) : null}

          {/* BOTH STEPPERS ARE DEAD WHILE THE BOX HOLDS NO NUMBER, and that is the whole
              reason this row was re-examined.
              They used to be live there, and both produced '1' from empty: "One less" is
              `max(1, (doses ?? 1) - 1)` and "One more" is `min(12, (doses ?? 0) + 1)`. So
              declining a proposal — the honest, safe act the design wants to be cheap, which
              empties the box on purpose — left two adjacent buttons whose labels are
              opposites, whose effect was identical, and either of which filled the field with
              ONE and marked the answer as hers. A QID line declined and then tapped once is a
              drug written four times a day set to once, with nothing having been read and the
              gate satisfied.
              A stepper has nothing to step from an empty field. Forcing the first digit
              through the number pad is what keeps "she produced this number" true on the
              declined path, which is the entire property the decline branch exists to
              preserve. `parseDoses` is null for '0', '13' and '2.5' as well, and the field's
              own error line already says what to type.

              AND BOTH ARE DEAD WHILE THE QUESTION ABOVE THEM IS OPEN, which is the same bug
              pointing the other way. While a proposal is unanswered the box already HOLDS its
              number, so the steppers were live — and "One more" is a 56dp target sitting
              directly under the card she is reading, operated by a hand with a tremor. One
              press wrote `proposal + 1` AND `freqAnswer: 'own'` AND the touched bit, all
              three: the "Not Ready" marker cleared, the footer count dropped, and a
              corroborated "1-0-1" became three doses a day while the evidence line two rows
              above still quoted "1-0-1", unchanged and uncontradicted. The two chips exist
              precisely so that no single action can satisfy that question; a stepper 56dp
              below them satisfied it with a number nobody read. The chips are the answer to
              an open question — once it is answered, the steppers are hers again. */}
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button
              title={t('prescription.review.oneLess')}
              icon="minus"
              onPress={() => {
                if (doses === null || awaitingAnswer) return;
                onPatch(draft.index, {
                  dosesPerDayText: String(Math.max(1, doses - 1)),
                  freqAnswer: 'own',
                });
                onTouch(draft.index, 'frequency');
              }}
              variant="secondary"
              size="md"
              disabled={awaitingAnswer || doses === null || doses <= 1}
            />
            <Button
              title={t('prescription.review.oneMore')}
              icon="plus"
              onPress={() => {
                if (doses === null || awaitingAnswer) return;
                onPatch(draft.index, {
                  dosesPerDayText: String(Math.min(MAX_DOSES_PER_DAY, doses + 1)),
                  freqAnswer: 'own',
                });
                onTouch(draft.index, 'frequency');
              }}
              variant="secondary"
              size="md"
              disabled={awaitingAnswer || doses === null || doses >= MAX_DOSES_PER_DAY}
            />
          </View>

          {overCap ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Icon name="info" size={20} color={colors.textMuted} />
              <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                {t('prescription.review.overCap', { max: MAX_AI_DOSES_PER_DAY })}
              </Text>
            </View>
          ) : null}
          </>
        ) : null}
      </View>

      <Divider />

      {/* THE MEAL RELATION — DECISION 5, AND THE ONLY REASON IT IS NOT BLOCKING.
          Until this row existed the model's `food_relation` went straight from
          `draft.parsed` into a confirmed `dose_schedule` row and then spoke in the alarm
          body ("on an empty stomach"), on the OPD one-pager and in the CSV, with nobody
          having seen it. So the comparison for this half is not against a careful review,
          it is against no review, and any display is a strict improvement.

          IT DOES NOT BLOCK THE CONFIRM, deliberately. Food is a displacement, not a
          multiplier: getting "after food" wrong moves a dose, it does not double one.
          Adding a second mandatory answer per card would spend her attention on the gate
          that matters less and train the reflex that defeats the gate that matters more.

          Nothing is pre-selected unless `propose.ts` had a mark on the paper to quote —
          an enum is the cheapest thing in a model's response to invent — so an older
          extraction with no recorded evidence now writes NULL where it used to write
          itself in silently. That is the intended loss. */}
      <View style={{ gap: spacing.sm }}>
        <Text variant="label">{t('prescription.review.foodTitle')}</Text>
        {/* THE WORDS ARE SHOWN WHEREVER THERE ARE WORDS, INCLUDING WHERE THE PROPOSAL WAS
            REFUSED. A mark the app quoted and then could not use is still the mark on her
            paper, and "these words are on the line and nothing has been chosen for you" is
            a direction she can act on; the refusal sentence alone is not. What never
            happens now is a quotation sitting above a SELECTED chip that contradicts it. */}
        {foodProposal.evidence.text !== null ? (
          <Text variant="body" weight="600">
            {t('prescription.review.onThePaper', { text: foodProposal.evidence.text })}
          </Text>
        ) : null}
        {foodProposal.kind === 'proposal' ? (
          draft.foodProposed ? (
            <Text variant="caption" tone="muted">
              {t('prescription.appSuggests')}
            </Text>
          ) : null
        ) : (
          <Text variant="caption" tone="muted">
            {foodProposal.kind === 'unverified'
              ? t('prescription.review.foodUnverified')
              : t(FOOD_REFUSAL_KEYS[foodProposal.reason])}
          </Text>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {FOOD_OPTIONS.map((option) => {
            const selected = draft.foodRelation === option;
            return (
              <Chip
                key={option}
                label={t(`medicines.food.${option}`)}
                selected={selected}
                selectionMode="single"
                grow
                // Pressing the selected one again returns to blank. Without it a proposal
                // she disagrees with entirely — the paper says nothing about food and the
                // app says "before" — could be moved but never removed.
                accessibilityHint={selected ? t('prescription.review.foodClearHint') : undefined}
                onPress={() =>
                  onPatch(draft.index, {
                    foodRelation: selected ? null : option,
                    foodProposed: false,
                  })
                }
              />
            );
          })}
        </View>
      </View>

      {/* Loudness, not clinical importance — and still hers to decide. The model's
          proposal is recorded beside her answer, never as it. */}
      {draft.offerCriticality ? (
        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('prescription.review.criticality')}</Text>
          <Text variant="caption" tone="muted">
            {t('prescription.review.criticalitySuggested')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Chip
              label={t('medicines.criticality.critical')}
              selected={draft.criticality === 'critical'}
              onPress={() => onPatch(draft.index, { criticality: 'critical' })}
              selectionMode="single"
              grow
            />
            <Chip
              label={t('medicines.criticality.standard')}
              selected={draft.criticality === 'standard'}
              onPress={() => onPatch(draft.index, { criticality: 'standard' })}
              selectionMode="single"
              grow
            />
          </View>
        </View>
      ) : null}

      {/* THE CARD'S OWN SCHEDULE SENTENCE, AND WHY IT IS SILENT UNTIL SHE ANSWERS.
          `doses` is `parseDoses` of the SEEDED text, so on a proposed line `plan` and
          `planned` are non-empty from the very first render — before any act. The card
          then said two contradictory things at once: at its head, "Not Ready — the number
          the app read off the paper has not been answered yet", and at its foot,
          "Rifampicin — 8:30 am, every day", which is what a settled schedule looks like.
          The preview above the confirm button is careful never to print a line the gate is
          holding; this was the same claim, in the same words, printed anyway.
          A finished-looking plan resting on an unanswered proposition is exactly the "a
          number on screen turns typing into copying" effect the pre-fill paid for with the
          evidence line and the question. So the times appear as a CONSEQUENCE of answering
          — which also makes answering visibly produce something. */}
      {planned.length > 0 && !awaitingAnswer ? (
        <Text variant="body">
          {t(
            plan?.intervalDays === 2
              ? 'prescription.review.reminderLineAlternate'
              : 'prescription.review.reminderLine',
            {
              name: draft.name.trim(),
              times: joinTimes(
                planned.map((slot) => formatTime(slot.time)),
                t('common.and'),
              ),
            },
          )}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The whole instruction, in the thing she taps.
 *
 * WRITTEN AS SIX WHOLE SENTENCES AND NOT ASSEMBLED FROM FRAGMENTS. "Twice a day" + ", at "
 * + the times reads as English and as nothing at all in Hindi, where the postposition and
 * the word order both move. Each case is one string in both languages, and each one is a
 * literal `t('…')` call so `check:i18n` can see it — a key built from a variable would be
 * invisible to that scan, which is why `FREQUENCY_REFUSAL_KEYS` next door is a `Record`
 * keyed off an exported union rather than a switch.
 *
 * The no-times pair is the honest fallback rather than a rounding: a weekly dose, or one
 * whose interval `planSlots` refuses to infer, lands on no named time at all, and a chip
 * that names times it will not set would be a worse lie than a chip that names none.
 */
function agreeLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  dosesPerDay: number,
  times: string,
  intervalDays: number | undefined,
): string {
  const params = { count: dosesPerDay, times };
  if (times.length === 0) {
    return dosesPerDay === 1
      ? t('prescription.review.freqAgreeOneNoTimes')
      : t('prescription.review.freqAgreeManyNoTimes', params);
  }
  if (intervalDays === 2) {
    return dosesPerDay === 1
      ? t('prescription.review.freqAgreeOneAlternate', params)
      : t('prescription.review.freqAgreeManyAlternate', params);
  }
  return dosesPerDay === 1
    ? t('prescription.review.freqAgreeOne', params)
    : t('prescription.review.freqAgreeMany', params);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extraction → drafts
// ═══════════════════════════════════════════════════════════════════════════════

function buildDrafts(medicines: readonly ParsedMedicine[], diff: PrescriptionDiff): Draft[] {
  const changedByIndex = new Map(diff.changed.map((row) => [row.incomingIndex, row]));
  const continuedByIndex = new Map(diff.continued.map((row) => [row.incomingIndex, row]));

  return medicines.map((parsed, index) => {
    const changed = changedByIndex.get(index);
    const continued = continuedByIndex.get(index);
    const kind: DraftKind = changed ? 'changed' : continued ? 'continued' : 'new';
    const proposedCritical = parsed.proposedCriticality === 'critical';
    const proposal = proposeForMedicine(parsed);
    const frequency = proposal.frequency;
    const food = proposal.food;

    return {
      index,
      kind,
      parsed,
      supersedesThreadId: changed?.threadId ?? null,
      matchedOnGeneric: (changed ?? continued)?.matchedOnGeneric ?? false,
      changes: changed?.changes ?? [],
      name: parsed.nameAsWritten ?? '',
      strength: parsed.strength ?? '',
      quantityText: parsed.doseQuantity.verbatim ?? '',
      proposal,
      /**
       * THE ONE INVARIANT THIS WHOLE DESIGN RESTS ON — a number may be seeded, but
       * `freqAnswer` is 'unanswered' whenever one is — and the reason it is a call to
       * another module rather than two ternaries written here.
       *
       * Written inline, the invariant could not be tested: nothing under `src/app/` loads
       * under `node --test`, and seeding 'agreed' is perfectly well-typed, so the single
       * most dangerous edit available to this feature was the one edit no gate could see.
       * `reviewGate.test.ts` now stands over it. Do not inline this back.
       */
      ...seedFrequency(frequency),
      // Never seeded from the reading, for the same reason the dose count is never seeded
      // 'agreed': "the paper says SOS" is the app's reading of the paper, and a line that
      // arrives already answered is answered by nobody. The card offers the answer; she
      // gives it.
      doseTiming: 'per_day',
      // Selected where the paper was quoted, blank otherwise. This is the value that gets
      // written; `draft.parsed.foodRelation` no longer reaches a row on its own.
      foodRelation: food.kind === 'proposal' ? food.relation : null,
      foodProposed: food.kind === 'proposal',
      // Louder is the safe side of a loudness question, and her own answer overwrites it
      // before anything is written.
      criticality: proposedCritical ? 'critical' : 'standard',
      offerCriticality: proposedCritical,
      flagged: flaggedFields(parsed, proposal),
      touched: {},
      // A line that is already being taken unchanged creates nothing, so there is nothing
      // to tick.
      include: kind !== 'continued',
    };
  });
}

/**
 * Which fields need her eyes before this line may be confirmed.
 *
 * `unknown` counts as low, not as "fine" — `isLowConfidence` is imported from `propose.ts`
 * rather than restated, because the two copies drifting is how half the warnings would
 * quietly stop appearing. The model saying it could not tell is exactly as strong a reason
 * to look at the paper as the model saying it is unsure.
 *
 * A PROPOSED FREQUENCY IS ALWAYS FLAGGED, whatever the model thought of itself. The flag
 * is not a claim that the reading is doubtful — `propose.ts` refuses to propose anything it
 * doubts — it is what wires the pre-filled number into the gate, so a number she did not
 * produce cannot reach a schedule without an act. Note that `confidence.frequency` could
 * never have done this job: a proposal only exists when that confidence is NOT low.
 */
function flaggedFields(parsed: ParsedMedicine, proposal: MedicineProposal): string[] {
  const flagged = new Set<string>();
  if (!parsed.nameAsWritten || isLowConfidence(parsed.confidence.name)) flagged.add('name');
  if (isLowConfidence(parsed.confidence.strength) && parsed.strength) flagged.add('strength');
  if (isLowConfidence(parsed.confidence.frequency)) flagged.add('frequency');
  if (parsed.needsHumanCheck) {
    flagged.add('name');
    flagged.add('strength');
    flagged.add('quantity');
  }
  if (proposal.frequency.kind === 'proposal') flagged.add('frequency');
  return [...flagged];
}

/**
 * May this line's decoded INTERVAL be believed?
 *
 * Only where `propose.ts` accepted the whole reading — every transcription of the line
 * decoding to the same instruction, the model's own count agreeing with them, inside the
 * cap, not flagged, not rated low. A refusal means the app decided it does not trust what
 * it read; adopting the skipped days out of that same reading, because a typed dose count
 * happened to match, is trusting it anyway through a side door. See `planSlots`.
 */
function intervalIsEarned(draft: Draft): boolean {
  return draft.proposal.frequency.kind === 'proposal';
}

function suggestionFor(draft: Draft, field: string): string {
  if (field === 'name') return draft.parsed.nameAsWritten ?? '';
  if (field === 'strength') return draft.parsed.strength ?? '';
  if (field === 'quantity') return draft.parsed.doseQuantity.verbatim ?? '';
  return '';
}

function scheduleFor(
  draft: Draft,
  doses: number | null,
  slots: readonly SlotDefinition[],
): ReviewedSchedule {
  // A NUMBER NOBODY ANSWERED FOR IS NOT A SCHEDULE, and this says so structurally rather
  // than trusting the gate to have run. The gate cannot be reached with an unanswered
  // proposal today — but `confirmAll` maps over every actionable line, ticked or not, and
  // one refactor that widens what reaches this function is all it would take for a
  // proposal to become a set of times without anybody having read the paper.
  if (draft.freqAnswer === 'unanswered') {
    return { kind: 'manual_required', reason: 'the frequency read off the paper was never confirmed' };
  }
  // THE TWO ANSWERS THAT ARE NOT A COUNT, and they are checked before the count because
  // for both of them there is no count to check. Each maps onto a write `confirm.ts`
  // already had: `prn` produces a schedule row with no time and no occurrences (a
  // placeholder time there would eventually be read as a real slot and start ringing for
  // an as-needed painkiller), and `record_only` produces the medicine and no schedule at
  // all. Neither can ring, which is the property both of them are chosen for.
  if (draft.doseTiming === 'as_needed') {
    return {
      kind: 'prn',
      quantityText: emptyToNull(draft.quantityText),
      foodRelation: draft.foodRelation,
    };
  }
  if (draft.doseTiming === 'one_off') {
    return { kind: 'record_only', reason: 'she recorded this as a single dose already given' };
  }
  if (doses === null) {
    return { kind: 'manual_required', reason: 'no times were chosen on the review screen' };
  }
  if (doses > MAX_AI_DOSES_PER_DAY) {
    // Handed over deliberately rather than silently truncated. `confirmExtraction` would
    // refuse this anyway; saying so here means the reason recorded is the real one.
    return {
      kind: 'manual_required',
      reason: `${doses} doses a day is above what this app will schedule from a photograph`,
    };
  }
  const { chosen, intervalDays, handOff } = planSlots(
    draft.parsed,
    doses,
    slots,
    intervalIsEarned(draft),
  );
  if (chosen.length === 0) {
    // Reached when the decoder recognised the frequency, agreed with her dose count, and
    // still supplied no slots — Q6H is 00:00/06:00/12:00/18:00 and is not four meals, and a
    // weekly dose has no named day. The four-slot build scheduled the first against meal
    // times anyway; handing both to a person is the same answer the decoder itself gives.
    // The third case is newer and is the one that must never be silent: a reading that
    // skipped days and was never corroborated. See `planSlots`.
    return { kind: 'manual_required', reason: HAND_OFF_REASONS[handOff ?? 'no_named_slots'] };
  }
  return {
    kind: 'fixed',
    // CARRIED, NOT DROPPED. `ReviewedSchedule.intervalDays` defaults to 1 in
    // `confirmExtraction`, so leaving it out wrote an alternate-day medicine as a daily
    // one — twice the doses, with the preview above the button saying nothing was wrong,
    // because the preview never mentioned the interval either. `planSlots` only reports an
    // interval it agreed with her dose count about, on the same terms as the slot layout.
    intervalDays,
    // THE SLOT KEY IS CARRIED, NOT RECOVERED. This used to write the clock time and then
    // look the name back up by that time, which meant the decoder's reading of the paper
    // was thrown away and re-guessed from a number — and any slot the user had moved onto
    // the same minute as another one came back as the wrong name, or as no name at all.
    slots: chosen.map((slot) => ({
      timeLocal: slot.time,
      slotKey: slot.key,
      quantityText: emptyToNull(draft.quantityText),
      // HER ANSWER, NOT THE MODEL'S. This read `draft.parsed.foodRelation` straight off the
      // extraction, which meant a relation nobody had seen reached a confirmed row and then
      // the alarm body, the OPD page and the CSV. It is now whatever is selected in the food
      // row on the card, and null when nothing is.
      foodRelation: draft.foodRelation,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Times
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The layout for a dose count the paper does not confirm — one entry per count, 1 to 4.
 *
 * ASKED OF THE DECODER RATHER THAN RETYPED HERE. "TDS" and a typed "3" are the same
 * instruction arriving by two routes, and a second copy of the layout on this screen is
 * exactly how they would come to mean different times. Computed once at module load; the
 * decoder is pure and these four strings never change.
 */
const FALLBACK_SLOT_KEYS: readonly (readonly string[])[] = (['OD', 'BD', 'TDS', 'QID'] as const).map(
  (code) => decodeFrequency(code).slots.map((slot) => slot.slotKey),
);

/**
 * Which of HER named slots this medicine lands on.
 *
 * TWO INPUTS, AND ONLY ONE OF THEM CAME OFF THE PHOTOGRAPH. `doses` is the number she
 * answered for — see decision 2 in the file header — and it alone decides HOW MANY times
 * a day. The decoder's reading of the paper only ever decides WHICH slots and WHICH DAYS,
 * and only when it agrees with her about how many. That agreement is the check: a "1-0-1"
 * misread as QID disagrees with a "2", so its layout is discarded and nothing it got wrong
 * can reach a reminder.
 *
 * WEEKLY IS REFUSED RATHER THAN FLATTENED. `detectIntervalDays` returns 7 for "once a
 * week" and the decoder itself notes `weekday_unspecified`, because the paper never said
 * WHICH day. Until the interval was carried at all, that medicine was written as a daily
 * schedule — seven doses a week where the paper asked for one — so refusing the layout
 * here sends it to manual entry, where the question only she can answer belongs. Alternate
 * days (2) is different and is carried: skipping a day needs no extra fact from her.
 *
 * WHY THE PAPER IS CONSULTED FOR THE LAYOUT AT ALL. Indian shorthand is meal-linked:
 * "1-0-1" means the breakfast and dinner doses, while "HS" means bedtime, deliberately
 * hours after the meal. Sending both to a slot picked purely by dose count — which is what
 * this screen did while there were only four slots to pick from — put a bedtime statin on
 * the table at dinner. The slots the decoder names are the same nine the user configures,
 * so the reading carries straight through.
 *
 * DUPLICATE TIMES COLLAPSE, deliberately and visibly. Two slots on one clock time is two
 * `dose_schedule` rows with the same `time_local`, which `UNIQUE (thread_id, version,
 * time_local)` refuses — and the abort would roll back every other medicine in the same
 * confirmation. `confirmExtraction` merges them for exactly that reason; doing it here as
 * well is what keeps the preview showing what will actually be written, and the caller
 * compares the length against `doses` to tell her a dose collapsed.
 */
function planSlots(
  parsed: ParsedMedicine,
  doses: number,
  slots: readonly SlotDefinition[],
  intervalEarned: boolean,
): {
  chosen: SlotDefinition[];
  collapsed: { kept: SlotDefinition; dropped: SlotDefinition }[];
  /** 1 every day, 2 alternate days, 7 weekly — and anything but 1 comes with no slots. */
  intervalDays: number;
  /** Why there are no slots, when there are none. Null whenever `chosen` is non-empty. */
  handOff: HandOff | null;
} {
  const decoded = decodeFrequency(frequencyExpression(parsed));
  const agreed = decoded.recognised && decoded.dosesPerDay === doses;
  // A rhythm she has not confirmed the count of is a rhythm this screen does not use, and
  // that applies to the interval exactly as it applies to the layout.
  //
  // AND THE COUNT IS NOT ENOUGH ON ITS OWN TO EARN THE INTERVAL. This used to adopt
  // `decoded.intervalDays` whenever the dose count matched, which for a once-daily drug is
  // no check at all: "daily" and "alternate day" both decode to one dose, so a line the
  // proposal layer REFUSED — "OD alternate day", read with low confidence, no number
  // offered, she typed the 1 herself off the paper — handed its skipped day straight into
  // `dose_schedule.interval_days`. Her 1 corroborated the count and nothing else, and the
  // result was a TB drug ringing every second day, which is the resistance-generating
  // direction. `intervalEarned` is the caller's answer to "did `propose.ts` accept this
  // reading at all" (see `intervalIsEarned`), and without it the interval is neither
  // adopted NOR silently flattened
  // to daily — flattening is the same mistake pointing the other way, and doubles the
  // doses of a genuinely alternate-day medicine. It goes to a person, by name.
  const mayAdoptInterval = agreed && intervalEarned;
  if (decoded.intervalDays !== 1 && !mayAdoptInterval) {
    return {
      chosen: [],
      collapsed: [],
      intervalDays: 1,
      handOff: decoded.intervalDays === 7 ? 'weekly_unspecified' : 'interval_unconfirmed',
    };
  }
  const intervalDays = mayAdoptInterval ? decoded.intervalDays : 1;
  if (intervalDays === 7) {
    return { chosen: [], collapsed: [], intervalDays, handOff: 'weekly_unspecified' };
  }
  const keys = agreed
    ? decoded.slots.map((slot) => slot.slotKey)
    : (FALLBACK_SLOT_KEYS[doses - 1] ?? []);

  const seen = new Map<string, SlotDefinition>();
  const chosen: SlotDefinition[] = [];
  const collapsed: { kept: SlotDefinition; dropped: SlotDefinition }[] = [];
  for (const key of keys) {
    const def = slots.find((slot) => slot.key === key);
    // Unreachable while every key above is a built-in and `resolveSlots` returns all nine.
    // Skipping rather than substituting is still the safe branch: a missing slot costs one
    // dose she can add by hand, where a substituted one rings at a time nobody chose.
    if (!def) continue;
    const kept = seen.get(def.time);
    if (kept) {
      // The pair is carried, not counted. "One of these medicines will ring once instead
      // of twice" is not something she can act on; "Rifampicin — Before lunch and After
      // lunch are both at 1:30 pm" is.
      collapsed.push({ kept, dropped: def });
      continue;
    }
    seen.set(def.time, def);
    chosen.push(def);
  }
  // An empty `chosen` here is the third story: the decoder recognised the rhythm, agreed
  // about the count and still named no slot — Q6H is 00:00/06:00/12:00/18:00 and is not
  // four meals — or the dose count is above the cap and has no fallback layout.
  return { chosen, collapsed, intervalDays, handOff: chosen.length === 0 ? 'no_named_slots' : null };
}

/**
 * Why a plan ended with no times, in the words `scheduleFor` records against the row.
 *
 * Three genuinely different stories, and they must not be collapsed into "could not
 * schedule": one is a fact about the paper (it says weekly and not which day), one is a
 * fact about the READING (an interval this screen is not entitled to infer), and one is a
 * fact about the rhythm itself (real hours, not meals).
 */
type HandOff = 'weekly_unspecified' | 'interval_unconfirmed' | 'no_named_slots';

const HAND_OFF_REASONS: Record<HandOff, string> = {
  weekly_unspecified: 'this is written for one day a week and the paper does not say which',
  interval_unconfirmed:
    'the reading said this skips days and the app could not corroborate that reading',
  no_named_slots: 'this rhythm has no named slot times a photograph can supply',
};

/** '08:00 and 20:00' / '08:00, 14:00 and 20:00'. */
function joinTimes(times: string[], and: string): string {
  if (times.length === 0) return '';
  if (times.length === 1) return times[0] ?? '';
  const head = times.slice(0, -1).join(', ');
  return `${head} ${and} ${times[times.length - 1] ?? ''}`;
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
