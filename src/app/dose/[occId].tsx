/**
 * One dose — the screen a 06:00 notification opens.
 *
 * This is answered by a woman who has just been woken by an alarm, without her reading
 * glasses, and it has to be answerable in one look. Everything on it is therefore either
 * the identity of the tablet (photo, name, strength, how much, when, food) or one of the
 * two answers. Nothing else is above the fold and nothing else competes for the thumb.
 *
 * THE SECONDARY ANSWER IS "NOT NOW", NOT "I DID NOT TAKE IT".
 * At 06:00 the honest thing is almost always deferral: the tablet is in the other room,
 * the tea is not made yet, she wants breakfast first. A screen whose two options are
 * "took it" and "did not take it" forces a declaration she has not made yet, and the
 * declaration it collects is false roughly as often as it is true. "Not now" records a
 * snooze — a real event, an honest one — and the deliberate "I am not taking this one"
 * stays available as a smaller, separate control for the case where she means it.
 *
 * THE EVENT IS THE TRUTH. `dose_occurrence.status` is a cache of `deriveStatus(events)`.
 * Every action below appends to `dose_event` FIRST and only then recomputes and writes
 * the cache, so a crash between the two loses a cache line and never loses the record of
 * a swallowed tablet. The reverse order can write "taken" onto a dose no event supports.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  DOSE_STATUS_STRINGS,
  SLOT_STRINGS,
  Thumb,
  doseStatusKey,
  resolveSlots,
  slotForRow,
  slotLabel,
  useAsync,
  useT,
  type LocalStrings,
  type SlotDefinition,
} from '@/app/_shared/lib';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useToast,
} from '@/components/ui';
import { useDateFormat } from '@/i18n/useDateFormat';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { DoseEvent, DoseOccurrence, DoseSchedule, Medicine, OccurrenceStatus } from '@/types';
import { appendEvent, listEventsForOccurrence } from '@/db/repositories/doseEvents';
import { getMedicine } from '@/db/repositories/medicines';
import { getOccurrence, setOccurrenceTimeOverride, setStatus } from '@/db/repositories/occurrences';
import { listProfiles } from '@/db/repositories/profiles';
import { getSchedule } from '@/db/repositories/schedules';
import { splitWallClock, stepWallClock } from '@/features/slots/registry';
import { deriveStatus, hasRecordedOutcome } from '@/features/dosing/deriveStatus';
import { stopRinging } from '@/features/dosing/medAlarm';

const STRINGS: LocalStrings = {
  ...DOSE_STATUS_STRINGS,
  ...SLOT_STRINGS,
  'dose.title': { en: 'Your medicine', hi: 'आपकी दवाई' },
  'dose.at': { en: 'At {{time}}', hi: '{{time}} बजे' },
  // The clock time stays first in English and last in Hindi because that is where each
  // language puts it; the slot name is the context, not the answer. Woken at six, what
  // she needs off this line is the number — "which of my times is this?" comes second.
  'dose.atSlot': { en: 'At {{time}}, {{slot}}', hi: '{{slot}}, {{time}} बजे' },
  'dose.stripPhoto': { en: 'Photo of the {{name}} strip', hi: '{{name}} के पत्ते की फोटो' },
  // Whose dose this is. Reminders ring for EVERY profile on the device (R1), and two people
  // can share a drug (both on a TB regimen), so a dose opened from a notification must name
  // its patient — shown only when the phone actually holds more than one profile.
  'dose.forPatient': { en: 'For {{name}}', hi: '{{name}} के लिए' },
  'dose.notTakingThis': { en: 'I am not taking this one', hi: 'यह खुराक मैं नहीं ले रही' },
  'dose.takenToast': { en: 'Written down at {{time}}', hi: '{{time}} बजे दर्ज कर लिया' },
  'dose.snoozedToast': {
    en: 'We will remind you again at {{time}}',
    hi: '{{time}} बजे फिर याद दिलाएँगे',
  },
  'dose.skippedToast': { en: 'Written down: not taken', hi: 'दर्ज कर लिया: नहीं ली' },
  'dose.alreadyAnswered': {
    en: 'This one is already written down',
    hi: 'यह पहले ही दर्ज हो चुकी है',
  },
  'dose.recordedAs': { en: '{{status}} — {{when}}', hi: '{{status}} — {{when}}' },
  'dose.changeAnswer': { en: 'I took it after all', hi: 'मैंने बाद में ले ली' },
  'dose.takenIsKept': {
    en: 'A dose written down as taken is kept. If this is wrong, tell your doctor what really happened.',
    hi: 'ले ली गई दर्ज खुराक मिटाई नहीं जाती। अगर यह गलत है तो डॉक्टर को असली बात बता दें।',
  },
  'dose.withdrawn': {
    en: 'This reminder was withdrawn when the timings changed, so there is nothing to answer.',
    hi: 'समय बदलने पर यह रिमाइंडर हटा दिया गया था, इसलिए अब कुछ करना नहीं है।',
  },
  'dose.goneMessage': {
    en: 'This reminder is no longer on the phone. Nothing you recorded has been lost.',
    hi: 'यह रिमाइंडर अब फोन में नहीं है। आपका दर्ज किया हुआ कुछ भी नहीं गया।',
  },
  'dose.goHome': { en: 'Go to Today', hi: 'आज पर जाएँ' },
  'dose.saveFailed': {
    en: 'Could not write this down. Please try once more.',
    hi: 'यह दर्ज नहीं हो पाया। एक बार फिर कोशिश करें।',
  },

  // ── Per-day time override (item 1). Everything here says "just today" out loud: moving
  //    one dose must never read as changing the medicine's schedule, or she stops trusting
  //    that her usual times are safe to leave alone. ──
  'dose.onlyToday': { en: 'Only Today', hi: 'सिर्फ़ आज' },
  'dose.changeTimeToday': { en: 'Change Time For Today', hi: 'आज के लिए समय बदलें' },
  'dose.changeAgain': { en: 'Change Again', hi: 'फिर से बदलें' },
  'dose.changeTimeHelp': {
    en: 'Moves only today’s dose. Your usual times stay the same.',
    hi: 'सिर्फ़ आज की खुराक हटती है। आपके आम समय वैसे ही रहते हैं।',
  },
  'dose.usualTime': { en: 'Usual time {{time}}', hi: 'आम समय {{time}}' },
  'dose.movedToday': { en: 'Moved to {{time}}, only today', hi: '{{time}} पर हटाई, सिर्फ़ आज' },
  'dose.saveForToday': { en: 'Save For Today', hi: 'आज के लिए रखें' },
  'dose.useUsualTime': { en: 'Use Usual Time', hi: 'आम समय पर लौटें' },
  'dose.timeChangedToast': { en: 'Just for today — {{time}}', hi: 'सिर्फ़ आज के लिए — {{time}}' },
  'dose.timeRestoredToast': {
    en: 'Back to the usual {{time}}',
    hi: 'वापस आम समय {{time}} पर',
  },
  'dose.changeTimeFailed': {
    en: 'Could not change the time. Please try once more.',
    hi: 'समय नहीं बदल पाया। एक बार फिर कोशिश करें।',
  },
  // Stepper controls — 24-hour, like the schedule editor, for the same reason: an AM/PM
  // misread on a dosing screen is a dose taken twelve hours off.
  'dose.hour': { en: 'Hour', hi: 'घंटा' },
  'dose.minute': { en: 'Minute', hi: 'मिनट' },
  'dose.hourUp': { en: 'Later by an hour', hi: 'एक घंटा आगे' },
  'dose.hourDown': { en: 'Earlier by an hour', hi: 'एक घंटा पीछे' },
  'dose.minuteUp': { en: 'Later by five minutes', hi: 'पाँच मिनट आगे' },
  'dose.minuteDown': { en: 'Earlier by five minutes', hi: 'पाँच मिनट पीछे' },
};

/** Minutes a single stepper tap moves. Matches the schedule editor's `SLOT_MINUTE_STEP`. */
const MINUTE_STEP = 5;

/** Ten minutes. Matches `reminders.snooze` — "Remind me in 10 minutes". */
const SNOOZE_MINUTES = 10;

type DoseView = {
  occurrence: DoseOccurrence;
  medicine: Medicine | null;
  schedule: DoseSchedule | null;
  events: DoseEvent[];
  /** The named slot this dose belongs to, or null when nothing on the phone names it. */
  slot: SlotDefinition | null;
  status: OccurrenceStatus;
  answered: boolean;
  /** The event that answered it, when one exists. */
  outcome: DoseEvent | null;
  /** This occurrence's OWN patient name — null on a single-profile phone, where naming a
      patient on every dose is noise. Not the active profile: a notification can open a dose
      for grandmother while mother is the viewed profile. */
  patientName: string | null;
};

export default function DoseOccurrenceScreen() {
  const rawId = useLocalSearchParams<{ occId?: string | string[] }>().occId;
  const occId = Array.isArray(rawId) ? rawId[0] : rawId;

  const t = useT(STRINGS);
  const toast = useToast();
  const { formatTime, formatEpoch } = useDateFormat();

  const [saving, setSaving] = useState<'taken' | 'snoozed' | 'skipped' | null>(null);
  const [changing, setChanging] = useState(false);

  // Per-day override editor. `draftTime` is 'HH:MM' held while the steppers move; it never
  // touches the database until Save, so backing out costs nothing.
  const [editingTime, setEditingTime] = useState(false);
  const [draftTime, setDraftTime] = useState('08:00');
  const [savingTime, setSavingTime] = useState(false);

  const state = useAsync<DoseView | null>(async () => {
    if (!occId) return null;
    const occurrence = await getOccurrence(occId);
    // A deleted profile, a reinstalled app, a stale notification from a horizon that no
    // longer exists — all land here, and all must produce a calm screen, never a crash.
    if (!occurrence) return null;

    const medicine = await getMedicine(occurrence.medicineId);
    const schedule = await getSchedule(occurrence.doseScheduleId);
    const events = await listEventsForOccurrence(occurrence.id);
    const status = deriveStatus(events, occurrence.scheduledAtEpoch, Date.now());

    // `slotForRow` is shared with `(tabs)/medicines.tsx` and `medicine/[id].tsx` so that
    // all three screens name this dose identically — see the note on it in the registry.
    const defs = await resolveSlots(occurrence.profileId);
    const slot = slotForRow(defs, occurrence.timeLocal, schedule?.slotKey ?? null);

    // Name the patient only when more than one lives on the phone. `listProfiles()` already
    // excludes archived (archive is a soft delete), so this matches ActiveProfileTag's gate.
    const profiles = await listProfiles();
    const patientName =
      profiles.length > 1
        ? (profiles.find((p) => p.id === occurrence.profileId)?.displayName ?? null)
        : null;

    const outcome =
      [...events]
        .reverse()
        .find((e) => e.event === 'taken' || e.event === 'prn_taken' || e.event === 'skipped') ??
      null;

    return {
      occurrence,
      medicine,
      schedule,
      events,
      slot,
      status,
      answered: hasRecordedOutcome(events) || status === 'cancelled',
      outcome,
      patientName,
    };
  }, [occId]);

  // `refresh` is stable (useAsync memoises it), so lifting it out here keeps the override
  // callbacks' dep arrays honest without depending on the whole changing `state` object.
  const refresh = state.refresh;

  const leave = useCallback(() => {
    // Opened from a notification there is no back stack, so falling through to the boot
    // route is the only way out that does not strand her on this screen.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const record = useCallback(
    async (
      kind: 'taken' | 'skipped' | 'snoozed',
      view: DoseView,
      payload: Record<string, unknown> | null,
    ) => {
      setSaving(kind);
      try {
        // 1. The truth, appended. Nothing may run between this and the recompute that
        //    could make the cache disagree with it for longer than one call.
        await appendEvent({
          occurrenceId: view.occurrence.id,
          threadId: view.occurrence.threadId,
          medicineId: view.occurrence.medicineId,
          profileId: view.occurrence.profileId,
          event: kind,
          payload,
          origin: 'app',
        });

        // 2. The cache, re-derived from the whole event list rather than assumed from
        //    the event we just wrote — a notification action or the native journal may
        //    have added something while this screen was open.
        const events = await listEventsForOccurrence(view.occurrence.id);
        const next = deriveStatus(events, view.occurrence.scheduledAtEpoch, Date.now());
        await setStatus(view.occurrence.id, next);

        // 3. The sound, LAST. Arriving here from the notification body rather than from
        //    one of its action buttons leaves the alarm looping behind this screen, and
        //    nothing else silences it: she taps "I took it", the record saves, and the
        //    phone goes on ringing. It is deliberately after both writes and never
        //    awaited into their failure path — stopRinging() cannot throw, and a dose
        //    must never be lost to a speaker that would not stop.
        stopRinging();

        if (kind === 'taken') {
          toast.show({ message: t('dose.takenToast', { time: formatTime(nowClock()) }), variant: 'success' });
        } else if (kind === 'snoozed') {
          const until = new Date(Date.now() + SNOOZE_MINUTES * 60_000);
          toast.show({
            message: t('dose.snoozedToast', { time: formatTime(clockOf(until)) }),
            variant: 'info',
          });
        } else {
          toast.show({ message: t('dose.skippedToast'), variant: 'info' });
        }
        leave();
      } catch {
        toast.show({ message: t('dose.saveFailed'), variant: 'error' });
      } finally {
        setSaving(null);
      }
    },
    [formatTime, leave, t, toast],
  );

  const openTimeEditor = useCallback((seed: string) => {
    setDraftTime(seed);
    setEditingTime(true);
  }, []);

  const saveOverride = useCallback(async () => {
    if (!occId) return;
    setSavingTime(true);
    try {
      // The occurrence keeps its slot-time id and `time_local`; only `override_time_local`
      // and the re-derived epoch move. reconcile honours it (see override.ts / R2), so the
      // moved dose survives the next foreground instead of snapping back to its usual time.
      await setOccurrenceTimeOverride(occId, draftTime);
      setEditingTime(false);
      // Moving the dose to later IS a deferral, so silence a ring in progress the same way
      // "Not now" does. LAST and never thrown into the failure path — the record of the move
      // matters, a speaker that rings on for another minute does not. No event is written, so
      // the dose stays pending, now at its new time.
      stopRinging();
      toast.show({
        message: t('dose.timeChangedToast', { time: formatTime(draftTime) }),
        variant: 'success',
      });
      refresh();
    } catch {
      toast.show({ message: t('dose.changeTimeFailed'), variant: 'error' });
    } finally {
      setSavingTime(false);
    }
  }, [occId, draftTime, formatTime, t, toast, refresh]);

  const restoreUsualTime = useCallback(
    async (usualTime: string) => {
      if (!occId) return;
      setSavingTime(true);
      try {
        await setOccurrenceTimeOverride(occId, null);
        setEditingTime(false);
        toast.show({
          message: t('dose.timeRestoredToast', { time: formatTime(usualTime) }),
          variant: 'info',
        });
        refresh();
      } catch {
        toast.show({ message: t('dose.changeTimeFailed'), variant: 'error' });
      } finally {
        setSavingTime(false);
      }
    },
    [occId, formatTime, t, toast, refresh],
  );

  if (state.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('dose.title')} />
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={96} width={96} label={t('a11y.loading')} />
          <Skeleton height={44} />
          <Skeleton height={28} width="60%" />
        </View>
      </Screen>
    );
  }

  const view = state.data;

  if (!view) {
    return (
      <Screen>
        <ScreenHeader title={t('dose.title')} onBack={router.canGoBack() ? leave : undefined} />
        <EmptyState
          icon="info"
          title={t('errors.notFound')}
          message={t('dose.goneMessage')}
          actionLabel={t('dose.goHome')}
          onAction={leave}
        />
      </Screen>
    );
  }

  const medicine = view.medicine;
  const name = medicine?.nameAsWritten ?? t('common.unknown');
  const quantity = quantityLabel(view.schedule);
  const foodKey = view.schedule?.foodRelation ? `medicines.food.${view.schedule.foodRelation}` : null;

  // `cancelled` is an administrative withdrawal — reconcile retires an occurrence whose
  // slot moved. There is nothing for her to answer, and asking would invite a second dose.
  const withdrawn = view.status === 'cancelled';
  const answeredTaken = view.outcome?.event === 'taken' || view.outcome?.event === 'prn_taken';
  const showActions = !withdrawn && (!view.answered || changing);

  // Per-day override. `timeLocal` is always the schedule's slot time (part of the occurrence
  // id); `overrideTimeLocal`, when set, is where this ONE dose was moved to for today only.
  // Every time shown on this screen is the EFFECTIVE one, so what she reads is where it will
  // actually ring — the slot time survives as "usual time" beneath it, never lost.
  const slotTime = view.occurrence.timeLocal;
  const overrideTime = view.occurrence.overrideTimeLocal;
  const effectiveTime = overrideTime ?? slotTime;
  // Offer the control only while the dose is still open. Moving an answered or withdrawn dose
  // has nothing to move, and `setOccurrenceTimeOverride` leaves that judgement to the screen.
  const canAdjustTime = !withdrawn && !view.answered;

  const identity = (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
        <Thumb
          uri={medicine?.stripPhotoUri ?? null}
          size={96}
          label={t('dose.stripPhoto', { name })}
        />
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text variant="display">{name}</Text>
          {medicine?.strength ? (
            <Text variant="title" tone="muted">
              {medicine.strength}
            </Text>
          ) : null}
          {/* Whose dose — only on a multi-profile phone. The word "For" carries the meaning,
              so this is not a colour-only signal. */}
          {view.patientName ? (
            <Text variant="title" tone="primary" weight="600">
              {t('dose.forPatient', { name: view.patientName })}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ gap: spacing.sm, paddingTop: spacing.lg }}>
        {quantity ? <Text variant="title">{quantity}</Text> : null}
        {/* `slotLabel`, never `t(slotI18nKey(...))` — a slot she invented herself has no
            bundle key and would print its `custom:` hex back at her. The time is the
            EFFECTIVE one: an overridden dose reads at the time it will actually ring. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm }}>
          <Text variant="title">
            {view.slot
              ? t('dose.atSlot', {
                  time: formatTime(effectiveTime),
                  slot: slotLabel(view.slot, t),
                })
              : t('dose.at', { time: formatTime(effectiveTime) })}
          </Text>
          {overrideTime ? <OnlyTodayBadge label={t('dose.onlyToday')} /> : null}
        </View>
        {/* The usual time is kept visible whenever it has been overridden, so "only today"
            is not a claim she has to take on trust — the schedule she set is right there. */}
        {overrideTime ? (
          <Text variant="label" tone="muted">
            {t('dose.usualTime', { time: formatTime(slotTime) })}
          </Text>
        ) : null}
        {foodKey ? (
          <Text variant="label" tone="muted">
            {t(foodKey)}
          </Text>
        ) : null}
      </View>
    </Card>
  );

  return (
    <Screen
      background="bgSunken"
      footer={
        showActions ? (
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('reminders.markTaken')}
              onPress={() => void record('taken', view, null)}
              variant="primary"
              size="xl"
              fullWidth
              loading={saving === 'taken'}
              disabled={saving !== null && saving !== 'taken'}
            />
            <Button
              title={t('common.notNow')}
              onPress={() =>
                void record('snoozed', view, {
                  // `untilEpoch` is what deriveStatus reads; `snoozeMinutes` is the
                  // fallback the Kotlin side writes, kept so both writers agree.
                  untilEpoch: Date.now() + SNOOZE_MINUTES * 60_000,
                  snoozeMinutes: SNOOZE_MINUTES,
                })
              }
              variant="secondary"
              size="lg"
              fullWidth
              loading={saving === 'snoozed'}
              disabled={saving !== null && saving !== 'snoozed'}
            />
          </View>
        ) : (
          <Button title={t('common.close')} onPress={leave} variant="secondary" size="lg" fullWidth />
        )
      }
    >
      <ScreenHeader title={t('dose.title')} onBack={router.canGoBack() ? leave : undefined} />

      {identity}

      {/* ── PER-DAY TIME OVERRIDE (item 1). Below the identity, above the answers: it is a
          planning action ("today, at ten") and must never sit where the thumb aims for the
          two answers. Every state says "today" out loud so it can never be mistaken for
          editing the schedule. ── */}
      {canAdjustTime ? (
        <Card style={{ marginTop: spacing.lg, gap: spacing.md }}>
          {editingTime ? (
            <>
              <Text variant="label">{t('dose.changeTimeToday')}</Text>
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <TimeStepper
                  label={t('dose.hour')}
                  value={pad2(splitWallClock(draftTime).hour)}
                  onDecrease={() => setDraftTime((c) => stepWallClock(c, -60))}
                  onIncrease={() => setDraftTime((c) => stepWallClock(c, 60))}
                  decreaseLabel={t('dose.hourDown')}
                  increaseLabel={t('dose.hourUp')}
                />
                <TimeStepper
                  label={t('dose.minute')}
                  value={pad2(splitWallClock(draftTime).minute)}
                  onDecrease={() => setDraftTime((c) => stepWallClock(c, -MINUTE_STEP))}
                  onIncrease={() => setDraftTime((c) => stepWallClock(c, MINUTE_STEP))}
                  decreaseLabel={t('dose.minuteDown')}
                  increaseLabel={t('dose.minuteUp')}
                />
              </View>
              <Text variant="body" tone="muted">
                {t('dose.changeTimeHelp')}
              </Text>
              <Button
                title={t('dose.saveForToday')}
                onPress={() => void saveOverride()}
                variant="primary"
                size="lg"
                fullWidth
                loading={savingTime}
              />
              <Button
                title={t('common.cancel')}
                onPress={() => setEditingTime(false)}
                variant="ghost"
                size="md"
                disabled={savingTime}
              />
            </>
          ) : overrideTime ? (
            <>
              <Text variant="label">{t('dose.movedToday', { time: formatTime(overrideTime) })}</Text>
              <Button
                title={t('dose.changeAgain')}
                onPress={() => openTimeEditor(effectiveTime)}
                variant="secondary"
                size="md"
                disabled={savingTime}
              />
              {/* The undo. Clearing the override rings this dose at its usual time again and
                  leaves the schedule exactly as it was — nothing about tomorrow changes. */}
              <Button
                title={t('dose.useUsualTime')}
                onPress={() => void restoreUsualTime(slotTime)}
                variant="ghost"
                size="md"
                loading={savingTime}
              />
            </>
          ) : (
            <>
              <Button
                title={t('dose.changeTimeToday')}
                onPress={() => openTimeEditor(effectiveTime)}
                variant="secondary"
                size="md"
              />
              <Text variant="body" tone="muted">
                {t('dose.changeTimeHelp')}
              </Text>
            </>
          )}
        </Card>
      ) : null}

      {withdrawn ? (
        <Card variant="sunken" style={{ marginTop: spacing.lg }}>
          <Text variant="body">{t('dose.withdrawn')}</Text>
        </Card>
      ) : null}

      {view.answered && !withdrawn ? (
        <Card variant="sunken" style={{ marginTop: spacing.lg, gap: spacing.md }}>
          <Text variant="label">{t('dose.alreadyAnswered')}</Text>
          <Text variant="body">
            {t('dose.recordedAs', {
              status: t(doseStatusKey(view.status)),
              when: view.outcome ? formatEpoch(view.outcome.atEpoch) : t('common.unknown'),
            })}
          </Text>

          {/*
            A change is offered only where an appended event can actually take effect.
            `deriveStatus` ranks taken above skipped, so "I took it after all" really does
            change the answer, while an appended "not taken" on top of a recorded "taken"
            would leave the status exactly as it was — a button that silently does nothing
            is worse than a sentence that tells her the truth.
          */}
          {answeredTaken ? (
            <Text variant="body" tone="muted">
              {t('dose.takenIsKept')}
            </Text>
          ) : changing ? null : (
            <Button
              title={t('dose.changeAnswer')}
              onPress={() => setChanging(true)}
              variant="secondary"
              size="md"
            />
          )}
        </Card>
      ) : null}

      {showActions ? (
        <View style={{ paddingTop: spacing.xl, alignItems: 'center' }}>
          {/* Deliberately a ghost control, well below the two answers: this is the rarer,
              considered "no", and it must never be reachable by the thumb that was aiming
              at "I took it". */}
          <Button
            title={t('dose.notTakingThis')}
            onPress={() => void record('skipped', view, null)}
            variant="ghost"
            size="md"
            loading={saving === 'skipped'}
            disabled={saving !== null && saving !== 'skipped'}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** Two-digit for a stepper cell. The clock reads 24-hour; `formatTime` is only for display. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The "Only Today" mark next to an overridden time.
 *
 * A WORD plus an icon, never colour alone — the app's rule for every state marker. On a
 * monochrome OPD print and for the ~8% with red/green deficiency the pill still reads.
 */
function OnlyTodayBadge({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radii.pill,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgSunken,
      }}
    >
      <Icon name="clock" size={16} color={colors.text} />
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/**
 * One hour or minute stepper — a 24-hour cell with a minus and a plus.
 *
 * Copied in spirit from `medicine/schedule.tsx`'s Stepper (not exported) for the same reason
 * it exists there: a native time picker renders 12-hour with AM/PM on several OEM skins, and
 * an AM/PM misread on a dosing screen is a dose taken twelve hours off. Steps come from
 * `stepWallClock`, so 23:55 + 5 min wraps to 00:00 rather than stranding the last five
 * minutes of the day.
 */
function TimeStepper({
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
        {/* The value is its own labelled live region: the '<label>' caption is a separate
            node, so a bare '08' reads without a unit, and stepping changed the number with
            no spoken feedback. Naming it '<label> <value>' and announcing on change means
            each +/- is heard — this is a dosing time, an off-by-hours entry matters. */}
        <Text
          variant="title"
          align="center"
          style={{ flex: 1 }}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${label} ${value}`}
        >
          {value}
        </Text>
        {key('plus', onIncrease, increaseLabel)}
      </View>
    </View>
  );
}

/** 'HH:MM' for right now, so the toast can go through `formatTime` like every other time. */
function nowClock(): string {
  return clockOf(new Date());
}

function clockOf(when: Date): string {
  const h = String(when.getHours()).padStart(2, '0');
  const m = String(when.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * How much to take, exactly as the prescription put it.
 *
 * `quantityText` wins because it is the transcription — "half tablet", "2 puffs" — and
 * the numeric pair is only ever a fallback. Nothing is invented: a schedule with no
 * quantity renders no quantity line at all rather than a guessed "1 tablet".
 */
function quantityLabel(schedule: DoseSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.quantityText) return schedule.quantityText;
  if (schedule.quantityValue === null) return null;
  return schedule.quantityUnit
    ? `${schedule.quantityValue} ${schedule.quantityUnit}`
    : String(schedule.quantityValue);
}
