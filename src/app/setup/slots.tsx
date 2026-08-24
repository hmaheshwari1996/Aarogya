/**
 * Setup step 3 — the nine dose times.
 *
 * THIS IS THE ONE STEP WITH NO SKIP, and the screen says so in one calm line rather than
 * hiding the fact. Every reminder in the app resolves through these wall-clock times: a
 * schedule row is "before breakfast", and "before breakfast" is whatever is set here.
 * Skipping would not mean "no times", it would mean "our defaults, silently" — which is
 * how a TB dose ends up ringing at 08:00 for a woman who has taken it at 06:00 with her
 * tea every day for four months.
 *
 * ─── WHY THIS IS A LIST OF ROWS AND NOT NINE STEPPER CARDS ────────────────────
 * It used to be four cards, each with a big readout and four ± buttons — about 200dp of
 * screen per slot. Nine of those is roughly 1800dp of vertical scroll on the one step the
 * wizard will not let the user past, and the person being asked to scroll it is elderly,
 * on three chronic treatments, and has not yet seen anything the app can do for her.
 *
 * So the nine live in three named groups of compact rows: name on the left, the time on
 * the right, the whole row a target. The fast path — which is most people, because the
 * defaults are ordinary Indian mealtimes — is READ THREE CARDS AND TAP NEXT, with no
 * picker touched at all. Tapping a row opens the same big steppers this screen has always
 * used, one slot at a time, in a dialog. NOTHING SHRANK: the ± buttons are still at least
 * 56dp, the readout is still `display`, and there is no auto-advance anywhere.
 *
 * ─── WHERE THE LAYOUT ITSELF LIVES ────────────────────────────────────────────
 * `src/features/slots/SlotEditor.tsx`. The three group cards, the row, the big readout and
 * the ± stepper are ONE implementation shared with `src/app/settings/slots.tsx`. This file
 * used to carry its own copy under a comment telling the next person to keep the two
 * identical, and they were not: different stepper layout, different TalkBack wording, and
 * a settings-only minute bug. A comment cannot hold two files together; one component can.
 *
 * The times are WALL CLOCK and stay wall clock. They are never converted to an epoch
 * here; `setSlotTimes` validates the HH:MM shape and refuses anything else, because the
 * Kotlin parser drops a malformed rule rather than guessing, and a dropped rule is a
 * dose that never rings. Moving one goes through `stepWallClock` in the registry, which is
 * pure, tested and wraps at midnight.
 *
 * 24-hour, both languages, Latin digits. There is no 12-hour option and there must never
 * be one: "8:00" with the am/pm marker missed is a dose taken twelve hours out.
 *
 * TWO SLOTS ON THE SAME CLOCK TIME BLOCKS `Next`, and the banner names both of them. It
 * is one stepper tap away — Before lunch at 13:30 is thirty minutes from After lunch at
 * 14:00 — and `dose_schedule` has `UNIQUE (thread_id, version, time_local)`, so a medicine
 * ticked for both would abort its own save behind a generic error much later, on a screen
 * that cannot explain what went wrong. See `validateSlotTimes` in the slot registry.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Dialog,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useToast,
} from '@/components/ui';
import {
  SLOT_EDITOR_STRINGS,
  SlotGroupCards,
  SlotStepper,
  SlotTimeReadout,
  slotChangeTitle,
  slotConflictLine,
} from '@/features/slots/SlotEditor';
import { WizardFooter } from './_layout';
import {
  DEFAULT_SLOT_TIMES,
  getSlotTimes,
  resolveProfileId,
  setSlotTimes,
  slotI18nKey,
  stepWallClock,
  useAsync,
  useT,
  validateSlotTimes,
  type BuiltinSlotKey,
  type LocalStrings,
} from '@/app/_shared/lib';

const SETUP_STEPS = 7;

const STRINGS: LocalStrings = {
  // One spread, and the shared layout has every string it draws — the slot names, the
  // group headings, the row hint, the stepper wording. See the note at the top of
  // `SlotEditor.tsx`: those components take `t` from this screen, so this line is what
  // makes them speak.
  ...SLOT_EDITOR_STRINGS,
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.slots.title': {
    en: 'When do you usually take your medicines?',
    hi: 'आप आमतौर पर दवाइयाँ कब लेती हैं?',
  },
  /**
   * ONE SENTENCE ABOVE THE FOLD. The rest is `setup.slots.whyMore`, below the three cards.
   *
   * This is step 3 of 7 and the only one with no Skip. The long version — three sentences,
   * 226 characters in Hindi — wrapped to about ten lines at a large text scale, under a
   * title that wraps to two, which on a 360×800 phone put NOT ONE TIME above the fold. The
   * user had to scroll past an explanation to discover that the step she cannot skip is
   * about times at all. The promise about Settings and the not-advice note are still on the
   * screen; they are simply not standing between her and the thing she came to read.
   *
   * ─── THE HINDI WORD FOR "REMINDER" IS `रिमाइंडर` ─────────────────────────────
   * It said `याद-दिलावट`. `दिलावट` is a coined nominalisation — no Hindi speaker says it,
   * and a native reader parses it as a typo or as machine translation, on the one step of
   * setup she is not allowed to skip. Worse, the three screens of this one feature had
   * three different names for the thing being configured: `याद-दिलावट` here, `रिमाइंडर` in
   * `settings/slots.tsx`, `याद दिलाना` in `medicine/schedule.tsx`. A woman going
   * setup → schedule → settings could not be sure they were the same thing.
   *
   * `रिमाइंडर` is what the rest of the app already says (77 occurrences against a handful),
   * and it is what an Indian speaker of this generation actually says out loud — the
   * English word has been ordinary Hindi for thirty years. It is grammatically MASCULINE,
   * so the verbs agree accordingly (`चलता है`, not `चलती है`).
   */
  'setup.slots.why': {
    en: 'Every reminder goes by these times. Most people just tap Next.',
    hi: 'हर रिमाइंडर इन्हीं समयों से चलता है। ज़्यादातर लोग बस आगे बढ़ जाती हैं।',
  },
  'setup.slots.whyMore': {
    en: 'This is the one step Aarogya cannot skip, because every reminder resolves through these times. You can change any of them later in Settings.',
    hi: 'यही एक कदम है जिसे आरोग्य छोड़ नहीं सकता, क्योंकि हर रिमाइंडर इन्हीं समयों से तय होता है। बाद में आप इनमें से कोई भी समय सेटिंग में बदल सकती हैं।',
  },
  'setup.slots.notAdvice': {
    en: 'These are your own timings, not a doctor’s instruction. Set them to when you really eat and sleep — Aarogya only uses them to know when to remind you.',
    hi: 'ये आपके अपने समय हैं, कोई डॉक्टरी सलाह नहीं। इन्हें वैसा ही रखिए जैसे आप सचमुच खाती और सोती हैं — आरोग्य इनका इस्तेमाल सिर्फ़ यह जानने के लिए करता है कि याद कब दिलानी है।',
  },
  'setup.slots.noProfile': {
    en: 'Let us start from the first question',
    hi: 'चलिए पहले सवाल से शुरू करते हैं',
  },
  'setup.slots.noProfileMessage': {
    en: 'Aarogya does not have your name yet, so there is nothing to save these times against.',
    hi: 'आरोग्य के पास अभी आपका नाम नहीं है, इसलिए ये समय किसके लिए सहेजें यह पता नहीं है।',
  },
  'setup.slots.goBack': { en: 'Go to the first question', hi: 'पहले सवाल पर जाएँ' },

  // ── The clash. `slots.conflictBody` is the only one of these that differs from the
  //    settings screen's copy, because this screen's blocked action is Next, not Save. ──
  'slots.conflictTitle': { en: 'Two times are the same', hi: 'दो समय एक जैसे हैं' },
  'slots.conflictBody': {
    en: '{{first}} and {{second}} are both set to {{time}}. One medicine cannot be reminded twice at the very same minute, so please move one of them before going on.',
    hi: '{{first}} और {{second}}, दोनों {{time}} पर लगे हैं। एक ही दवाई की याद एक ही मिनट पर दो बार नहीं दिलाई जा सकती, इसलिए आगे बढ़ने से पहले इनमें से एक को बदल दीजिए।',
  },
  'slots.clockNote': {
    en: 'Times are shown on a 24-hour clock, so 20:00 means 8 in the evening.',
    hi: 'समय 24 घंटे की घड़ी में दिखाया जाता है, यानी 20:00 का मतलब शाम के 8 बजे।',
  },
};

/**
 * Seven dots, filled up to the step showing. Duplicated verbatim in every setup step —
 * see the note in `_layout.tsx`. Keep the copies identical.
 */
function StepDots({ step }: { step: number }) {
  const { colors } = useTheme();
  const t = useT(STRINGS);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('setup.stepOf', { step, total: SETUP_STEPS })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.md }}
    >
      {Array.from({ length: SETUP_STEPS }, (_, index) => (
        <View
          key={index}
          style={{
            width: index + 1 === step ? 32 : 14,
            height: 14,
            borderRadius: radii.pill,
            borderWidth: 2,
            borderColor: index < step ? colors.primary : colors.borderStrong,
            backgroundColor: index < step ? colors.primary : colors.bg,
          }}
        />
      ))}
    </View>
  );
}

export default function SetupSlotsScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);
  const { formatTime } = useDateFormat();

  const state = useAsync(async () => {
    const profileId = await resolveProfileId();
    const times = profileId ? await getSlotTimes(profileId) : { ...DEFAULT_SLOT_TIMES };
    return { profileId, times };
  }, []);

  const [times, setTimes] = useState<Record<BuiltinSlotKey, string>>({ ...DEFAULT_SLOT_TIMES });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<BuiltinSlotKey | null>(null);

  // Seeded during render, once per load, so the times are already the stored ones on the
  // first painted frame rather than the defaults for a frame and then hers.
  const [seededFrom, setSeededFrom] = useState<typeof state.data>(null);
  if (state.data && state.data !== seededFrom) {
    setSeededFrom(state.data);
    setTimes(state.data.times);
  }

  const profileId = state.data?.profileId ?? null;

  const shift = useCallback((slot: BuiltinSlotKey, deltaMinutes: number) => {
    setTimes((current) => ({ ...current, [slot]: stepWallClock(current[slot], deltaMinutes) }));
  }, []);

  /**
   * The first clash, if there is one. Only the FIRST is reported: fixing it re-runs this
   * and surfaces the next, which is a shorter sentence to read than a list and cannot
   * leave her wondering which of three pairs she has already dealt with.
   */
  const clash = useMemo(() => {
    const check = validateSlotTimes(times);
    if (check.ok) return null;
    return check.issue.reason === 'duplicate_time' ? check.issue : null;
  }, [times]);

  /** The other slot a given slot collides with, for the row caption and the dialog. */
  const conflictPartner = useCallback(
    (slot: BuiltinSlotKey): BuiltinSlotKey | null => {
      if (!clash) return null;
      const [first, second] = clash.slots;
      if (slot === first) return second;
      if (slot === second) return first;
      return null;
    },
    [clash],
  );

  /** The same, as the name the user reads — what the shared row and dialog both want. */
  const conflictNameFor = useCallback(
    (slot: BuiltinSlotKey): string | null => {
      const partner = conflictPartner(slot);
      return partner === null ? null : t(slotI18nKey(partner));
    },
    [conflictPartner, t],
  );

  const save = useCallback(async () => {
    if (!profileId || saving || clash) return;
    setSaving(true);
    try {
      await setSlotTimes(profileId, times);
      router.push('/setup/contact');
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [profileId, saving, clash, times, router, toast, t]);

  if (!state.loading && profileId === null) {
    return (
      <Screen variant="scroll">
        <StepDots step={3} />
        <ScreenHeader title={t('setup.slots.title')} onBack={() => router.back()} />
        <Banner
          variant="attention"
          title={t('setup.slots.noProfile')}
          message={t('setup.slots.noProfileMessage')}
          actionLabel={t('setup.slots.goBack')}
          onAction={() => router.replace('/setup')}
        />
      </Screen>
    );
  }

  const editingName = editing === null ? '' : t(slotI18nKey(editing));
  const editingPartnerName = editing === null ? null : conflictNameFor(editing);

  return (
    <Screen
      variant="scroll"
      background="bgSunken"
      footer={
        // No Skip here, deliberately. See the file header. One action in the row simply
        // takes the whole width. `Next` also goes inert while two slots share a time —
        // the write would be refused by `setSlotTimes` anyway, and a button that fails
        // silently is worse than one that is visibly waiting for something.
        <WizardFooter
          actions={[
            {
              title: t('common.next'),
              onPress: () => void save(),
              size: 'lg',
              loading: saving,
              disabled: state.loading || clash !== null,
            },
          ]}
        />
      }
    >
      <StepDots step={3} />
      <ScreenHeader
        title={t('setup.slots.title')}
        subtitle={t('setup.slots.why')}
        onBack={() => router.back()}
      />

      {state.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={200} label={t('common.loading')} />
          <Skeleton height={200} />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          {clash ? (
            <Banner
              variant="attention"
              title={t('slots.conflictTitle')}
              message={t('slots.conflictBody', {
                first: t(slotI18nKey(clash.slots[0])),
                second: t(slotI18nKey(clash.slots[1])),
                time: formatTime(clash.time),
              })}
            />
          ) : null}

          <SlotGroupCards
            t={t}
            times={times}
            formatTime={formatTime}
            conflictNameFor={conflictNameFor}
            onEdit={setEditing}
          />

          {/* The rest of the explanation, BELOW the cards. It is worth saying and it is
              not worth putting between her and the first time on the screen. */}
          <Text variant="caption" tone="muted">
            {t('setup.slots.whyMore')}
          </Text>
          <Text variant="caption" tone="muted">
            {t('slots.clockNote')}
          </Text>
          <Text variant="caption" tone="muted">
            {t('setup.slots.notAdvice')}
          </Text>
        </View>
      )}

      {/* One slot, edited live behind the dialog.

          There is no Cancel. The row behind it already shows the new time as it moves, and
          the whole screen is staged until `Next`, so "Done" closes a change she can still
          undo by stepping back. A Cancel here would imply the rest of the screen commits,
          which it does not. */}
      <Dialog
        visible={editing !== null}
        title={slotChangeTitle(t, editingName)}
        onRequestClose={() => setEditing(null)}
        footer={
          <Button title={t('common.done')} onPress={() => setEditing(null)} size="lg" fullWidth />
        }
      >
        <View style={{ gap: spacing.lg }}>
          <SlotTimeReadout
            name={editingName}
            time={editing === null ? '' : formatTime(times[editing])}
          />

          {editingPartnerName !== null ? (
            <Text variant="body" tone="destructive">
              {slotConflictLine(t, editingPartnerName)}
            </Text>
          ) : null}

          <SlotStepper
            t={t}
            slotName={editingName}
            onShift={(delta) => {
              if (editing !== null) shift(editing, delta);
            }}
          />
        </View>
      </Dialog>
    </Screen>
  );
}
