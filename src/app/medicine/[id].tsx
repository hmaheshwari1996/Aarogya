/**
 * One medicine, across its whole life.
 *
 * ─── THE HISTORY IS SENTENCES, NOT A DIFF ────────────────────────────────────
 * "From 4 March: 1 at each time, at 08:00 and 20:00." — that is how a person
 * describes her own treatment to a doctor, and it is the form she can read aloud in
 * an OPD queue. A side-by-side diff with `-`/`+` markers is a developer's mental
 * model of the same rows; it asks the reader to reconstruct the sentence herself,
 * and under stress she will reconstruct it wrongly.
 *
 * ─── THE MEDICINE AND ITS FREQUENCY ARE CONFIRMED SEPARATELY ─────────────────
 * "1-0-1 misread as QID" leaves the drug name perfectly correct and quadruples the
 * number of doses. So the name carries one sign-off and the frequency carries its
 * own, and the frequency's sign-off states, in literal clock times, exactly what the
 * phone is about to start doing. Two DB triggers enforce the same split below the
 * application: an unconfirmed medicine or schedule physically cannot produce a dose.
 *
 * ─── THE AS-NEEDED LOG HAS NO SUMMARY ────────────────────────────────────────
 * No rate, no average, no "usual time". Summarising as-needed use into a pattern
 * asserts that a pattern exists, and the whole point of an as-needed medicine is
 * that it does not.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  SLOT_STRINGS,
  Thumb,
  resolveSlots,
  slotForRow,
  slotLabel,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
  type SlotDefinition,
} from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Dialog,
  Divider,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useDateFormat } from '@/i18n/useDateFormat';
import { ALL_DAYS, daysBetween, toLocalDate } from '@/lib/datetime';
import {
  confirmMedicine,
  createNewVersion,
  getCurrentVersion,
  listVersions,
  stopMedicine,
} from '@/db/repositories/medicines';
import {
  confirmCurrentSchedules,
  getCurrentSchedules,
  listScheduleVersions,
} from '@/db/repositories/schedules';
import {
  getLatestCount,
  needsRefill,
  projectRunOut,
  recordCount,
  type MedicineStock,
} from '@/db/repositories/stock';
import { isPrnThread, listPrnDoses } from '@/features/dosing/prn';
import { reconcile } from '@/features/dosing/reconcile';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { DoseEvent, DoseSchedule, Medicine } from '@/types';

const STRINGS: LocalStrings = {
  ...SLOT_STRINGS,
  'medicine.currentTitle': { en: 'What you are taking now', hi: 'अभी आप क्या ले रही हैं' },
  'medicine.form': { en: 'Kind', hi: 'तरह' },
  'medicine.importance': { en: 'Importance', hi: 'ज़रूरत' },
  'medicine.timesLabel': { en: 'Times', hi: 'समय' },
  'medicine.noTimes': { en: 'No timings set yet', hi: 'अभी कोई समय तय नहीं' },
  'medicine.onlyWhenNeeded': { en: 'Only when needed, with no reminder', hi: 'सिर्फ़ ज़रूरत पड़ने पर, बिना याद दिलाए' },
  'medicine.foodLabel': { en: 'Food', hi: 'खाना' },
  'medicine.stockTitle': { en: 'Stock', hi: 'बचा हुआ सामान' },
  'medicine.stockDays': { en: '{{count}} days of stock left', hi: '{{count}} दिन का सामान बचा है' },
  // Days, not tablets — `medicines.stockLow` counts tablets and must not be reused here.
  'medicine.stockDaysLow': {
    en: 'Only {{count}} days of stock left',
    hi: 'सिर्फ़ {{count}} दिन का सामान बचा है',
  },
  'medicine.stockCount': { en: '{{count}} left', hi: '{{count}} बची हैं' },
  'medicine.stockCountedOn': { en: 'Counted on {{date}}', hi: '{{date}} को गिना गया' },
  'medicine.stockNone': { en: 'You have not counted this yet.', hi: 'आपने अभी इसे गिना नहीं है।' },
  'medicine.stockRecord': { en: 'Record a stock count', hi: 'बचा हुआ सामान गिनकर दर्ज करें' },
  'medicine.stockDialogTitle': { en: 'How many are left?', hi: 'कितनी बची हैं?' },
  'medicine.stockDialogMessage': {
    en: 'Count what is in the box and the strips. This is only used to work out when to buy more.',
    hi: 'डिब्बे और पत्तियों में जो है उसे गिनें। यह सिर्फ़ यह पता करने के लिए है कि और कब लानी हैं।',
  },
  'medicine.stockSaved': { en: 'Count saved', hi: 'गिनती सहेज ली गई' },
  'medicine.plusOne': { en: 'One more', hi: 'एक और' },
  'medicine.minusOne': { en: 'One less', hi: 'एक कम' },
  'medicine.plusTen': { en: 'Ten more', hi: 'दस और' },
  'medicine.minusTen': { en: 'Ten less', hi: 'दस कम' },

  'medicine.confirmMedicineTitle': { en: 'Please check the name', hi: 'कृपया नाम जाँच लें' },
  'medicine.confirmMedicineMessage': {
    en: 'Read the name and the strength against the strip or the prescription. Nothing is reminded until you agree.',
    hi: 'नाम और ताकत को पत्ती या पर्चे से मिलाकर पढ़ें। जब तक आप सहमत नहीं होतीं, कोई याद दिलाना शुरू नहीं होगा।',
  },
  'medicine.confirmScheduleTitle': { en: 'Please check the timings', hi: 'कृपया समय जाँच लें' },
  'medicine.confirmScheduleMessage': {
    en: 'The name being right does not make the timings right. Check these separately.',
    hi: 'नाम सही होने का मतलब यह नहीं कि समय भी सही हैं। इन्हें अलग से जाँचें।',
  },
  'medicine.willRemindEveryDay': {
    en: 'You will be reminded at {{times}}, every day.',
    hi: 'आपको हर दिन {{times}} बजे याद दिलाया जाएगा।',
  },
  'medicine.willRemindSomeDays': {
    en: 'You will be reminded at {{times}}, on {{days}}.',
    hi: 'आपको {{days}} को {{times}} बजे याद दिलाया जाएगा।',
  },
  'medicine.willNotRemind': {
    en: 'Nothing will ring for this medicine. You record it yourself when you take it.',
    hi: 'इस दवाई के लिए कुछ नहीं बजेगा। जब लें, तब आप खुद दर्ज करेंगी।',
  },
  'medicine.confirmed': { en: 'Checked by you', hi: 'आपने जाँच ली' },

  'medicine.historyTitle': { en: 'How this medicine has changed', hi: 'यह दवाई कैसे बदली' },
  'medicine.historyEmpty': {
    en: 'Nothing has changed since you added it.',
    hi: 'जोड़ने के बाद से कुछ नहीं बदला।',
  },
  'medicine.history.name': { en: 'From {{date}}: {{name}}.', hi: '{{date}} से: {{name}}।' },
  'medicine.history.schedule': {
    en: 'From {{date}}: {{quantity}}, at {{times}}.',
    hi: '{{date}} से: {{quantity}}, {{times}} बजे।',
  },
  'medicine.history.scheduleNoQuantity': {
    en: 'From {{date}}: at {{times}}.',
    hi: '{{date}} से: {{times}} बजे।',
  },
  'medicine.history.scheduleDays': {
    en: 'From {{date}}: {{quantity}}, at {{times}}, on {{days}}.',
    hi: '{{date}} से: {{quantity}}, {{days}} को {{times}} बजे।',
  },
  'medicine.history.scheduleDaysNoQuantity': {
    en: 'From {{date}}: at {{times}}, on {{days}}.',
    hi: '{{date}} से: {{days}} को {{times}} बजे।',
  },
  'medicine.history.prn': {
    en: 'From {{date}}: only when needed, with no reminder.',
    hi: '{{date}} से: सिर्फ़ ज़रूरत पड़ने पर, बिना याद दिलाए।',
  },
  'medicine.history.stopped': { en: 'Stopped on {{date}}.', hi: '{{date}} को बंद कर दी गई।' },
  'medicine.history.quantity': { en: '{{count}} at each time', hi: 'हर बार {{count}}' },

  'medicine.prnTitle': { en: 'When you took it', hi: 'आपने कब ली' },
  'medicine.prnNote': {
    en: 'Only the times you recorded, newest first. There is no average and no usual time here — putting one would suggest a pattern that as-needed medicine does not have.',
    hi: 'सिर्फ़ वे समय जो आपने दर्ज किए, नए सबसे ऊपर। यहाँ कोई औसत या "आम तौर पर" नहीं है — वैसा लिखना उस ढर्रे का इशारा करेगा जो ज़रूरत पड़ने पर ली जाने वाली दवाई में होता ही नहीं।',
  },
  'medicine.prnEmpty': { en: 'Nothing recorded yet', hi: 'अभी कुछ दर्ज नहीं है' },

  'medicine.stopped': { en: 'This medicine is stopped', hi: 'यह दवाई बंद है' },
  'medicine.stoppedMessage': {
    en: 'No reminders are set for it. Everything already recorded is kept.',
    hi: 'इसके लिए कोई याद दिलाना तय नहीं है। जो दर्ज हो चुका है वह रहेगा।',
  },
  'medicine.stopDone': { en: 'Stopped', hi: 'बंद कर दी गई' },
  'medicine.resumeDone': { en: 'Started again', hi: 'फिर से शुरू' },
  'medicine.stripPhoto': { en: 'Photo of the {{name}} strip', hi: '{{name}} की पत्ती की फोटो' },
};

/**
 * One declared height per row kind, sized for large-text mode plus the app's own
 * 1.25× scale. `getItemLayout` reads these, so a row that overflows its declared
 * height drifts every offset below it.
 */
const SECTION_HEIGHT = 72;
const NOTE_HEIGHT = 180;
const HISTORY_HEIGHT = 108;
const PRN_HEIGHT = 72;
const EMPTY_HEIGHT = 88;

type ListItem =
  | { kind: 'section'; key: string; title: string }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'history'; key: string; text: string }
  | { kind: 'prn'; key: string; text: string }
  | { kind: 'empty'; key: string; text: string };

function itemHeight(item: ListItem): number {
  switch (item.kind) {
    case 'section':
      return SECTION_HEIGHT;
    case 'note':
      return NOTE_HEIGHT;
    case 'history':
      return HISTORY_HEIGHT;
    case 'prn':
      return PRN_HEIGHT;
    default:
      return EMPTY_HEIGHT;
  }
}

type Loaded = {
  current: Medicine;
  versions: Medicine[];
  schedules: DoseSchedule[];
  scheduleVersions: DoseSchedule[];
  stock: MedicineStock | null;
  isPrn: boolean;
  prnDoses: DoseEvent[];
  /** Every slot this profile has, built-in and invented, sorted by her configured times. */
  slots: SlotDefinition[];
};

export default function MedicineDetailScreen() {
  const t = useT(STRINGS);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { colors } = useTheme();
  const { formatTime, formatDate, formatEpoch } = useDateFormat();

  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const threadId = Array.isArray(rawId) ? rawId[0] : rawId;

  const profile = useProfileId();
  const [busy, setBusy] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);
  const [stockDraft, setStockDraft] = useState(0);

  const state = useAsync<Loaded | null>(async () => {
    if (!threadId) return null;
    const current = await getCurrentVersion(threadId);
    if (!current) return null;

    const [versions, schedules, scheduleVersions, stock, prn, slots] = await Promise.all([
      listVersions(threadId),
      getCurrentSchedules(threadId),
      listScheduleVersions(threadId),
      getLatestCount(current.profileId, threadId),
      isPrnThread(threadId),
      resolveSlots(current.profileId),
    ]);

    const prnDoses = prn ? await listPrnDoses(current.profileId, threadId) : [];
    return { current, versions, schedules, scheduleVersions, stock, isPrn: prn, prnDoses, slots };
  }, [threadId]);

  useReloadOnFocus(state.reload);

  const data = state.data;

  const fixedSlots = useMemo(
    () => (data?.schedules ?? []).filter((s) => s.scheduleType === 'FIXED' && s.timeLocal),
    [data],
  );
  const times = useMemo(
    () =>
      fixedSlots
        .map((s) => s.timeLocal)
        .filter((time): time is string => time !== null)
        .sort(),
    [fixedSlots],
  );

  /**
   * "Before breakfast · 8:00 am" for each fixed dose, in clock order.
   *
   * Built from the SCHEDULE ROWS rather than from `times`, because the row carries the
   * `slot_key` it was written with and that is the only thing that can still name a dose
   * whose slot has since been retired — see `slotForRow`.
   */
  const namedTimes = useMemo(() => {
    const slots = data?.slots ?? [];
    return [...fixedSlots]
      .map((schedule) => ({ time: schedule.timeLocal, slotKey: schedule.slotKey }))
      .filter((entry): entry is { time: string; slotKey: string | null } => entry.time !== null)
      .sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1))
      .map((entry) => {
        const slot = slotForRow(slots, entry.time, entry.slotKey);
        // Slot name AND literal time — the slot name alone is not a time.
        return slot ? `${slotLabel(slot, t)} · ${formatTime(entry.time)}` : formatTime(entry.time);
      });
  }, [data, fixedSlots, formatTime, t]);
  const daysMask = fixedSlots[0]?.daysMask ?? ALL_DAYS;
  const everyDay = (daysMask & ALL_DAYS) === ALL_DAYS;

  /** The literal sentence the reminder confirmation has to state before she signs it. */
  const reminderSentence = useMemo(() => {
    if (!data) return '';
    if (data.isPrn || times.length === 0) return t('medicine.willNotRemind');
    const list = joinList(times.map(formatTime), t('common.and'));
    return everyDay
      ? t('medicine.willRemindEveryDay', { times: list })
      : t('medicine.willRemindSomeDays', {
          times: list,
          days: joinList(dayNames(daysMask, t), t('common.and')),
        });
  }, [data, times, everyDay, daysMask, formatTime, t]);

  const history = useMemo(
    () =>
      data
        ? buildHistory(data.versions, data.scheduleVersions, {
            t,
            formatDate,
            formatTime,
          })
        : [],
    [data, t, formatDate, formatTime],
  );

  const items = useMemo<ListItem[]>(() => {
    if (!data) return [];
    const out: ListItem[] = [];

    out.push({ kind: 'section', key: 'history-header', title: t('medicine.historyTitle') });
    if (history.length === 0) {
      out.push({ kind: 'empty', key: 'history-empty', text: t('medicine.historyEmpty') });
    } else {
      history.forEach((line, index) => {
        out.push({ kind: 'history', key: `history-${index}`, text: line });
      });
    }

    if (data.isPrn) {
      out.push({ kind: 'section', key: 'prn-header', title: t('medicine.prnTitle') });
      out.push({ kind: 'note', key: 'prn-note', text: t('medicine.prnNote') });
      if (data.prnDoses.length === 0) {
        out.push({ kind: 'empty', key: 'prn-empty', text: t('medicine.prnEmpty') });
      } else {
        for (const dose of data.prnDoses) {
          out.push({ kind: 'prn', key: dose.id, text: formatEpoch(dose.atEpoch) });
        }
      }
    }

    return out;
  }, [data, history, t, formatEpoch]);

  const offsets = useMemo(() => {
    const table: number[] = [];
    let running = 0;
    for (const item of items) {
      table.push(running);
      running += itemHeight(item);
    }
    return table;
  }, [items]);

  const getItemLayout = useCallback(
    (_data: ArrayLike<ListItem> | null | undefined, index: number) => {
      const item = items[index];
      return {
        length: item ? itemHeight(item) : HISTORY_HEIGHT,
        offset: offsets[index] ?? 0,
        index,
      };
    },
    [items, offsets],
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const runAction = useCallback(
    async (action: () => Promise<void>, successMessage?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
        if (successMessage) toast.show({ message: successMessage, variant: 'success' });
        state.reload();
      } catch {
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [busy, toast, state, t],
  );

  const handleConfirmMedicine = useCallback(() => {
    if (!data) return;
    void runAction(async () => {
      await confirmMedicine(data.current.id);
      // Confirming the name can make the medicine schedulable, so the alarm layer is
      // re-armed from rows that are already written and already confirmed.
      await reconcile(data.current.profileId);
    }, t('common.saved'));
  }, [data, runAction, t]);

  const handleConfirmSchedule = useCallback(() => {
    if (!data || !threadId) return;
    void runAction(async () => {
      await confirmCurrentSchedules(threadId);
      await reconcile(data.current.profileId);
    }, t('common.saved'));
  }, [data, threadId, runAction, t]);

  const handleStop = useCallback(async () => {
    if (!data || !threadId) return;
    const agreed = await confirm({
      title: t('medicines.stopTitle', { name: data.current.nameAsWritten }),
      message: t('medicines.stopMessage'),
      confirmLabel: t('medicines.stop'),
      destructive: true,
    });
    if (!agreed) return;
    void runAction(async () => {
      await stopMedicine(threadId);
      // Schedules are deliberately NOT closed here. Reconcile stops producing doses
      // the moment the medicine leaves the active set, and leaving the schedule rows
      // open is what lets "start it again" resume the same timings rather than
      // silently resuming with no reminders at all.
      await reconcile(data.current.profileId);
    }, t('medicine.stopDone'));
  }, [data, threadId, confirm, runAction, t]);

  const handleResume = useCallback(() => {
    if (!data || !threadId) return;
    void runAction(async () => {
      await createNewVersion(
        threadId,
        {},
        { confirmedByUser: true, changeKind: 'resumed', detail: data.current.nameAsWritten },
      );
      await reconcile(data.current.profileId);
    }, t('medicine.resumeDone'));
  }, [data, threadId, runAction, t]);

  const openStockDialog = useCallback(() => {
    setStockDraft(data?.stock?.quantityOnHand ?? 0);
    setStockOpen(true);
  }, [data]);

  const handleSaveStock = useCallback(() => {
    if (!data || !threadId) return;
    setStockOpen(false);
    void runAction(async () => {
      await recordCount({
        profileId: data.current.profileId,
        threadId,
        quantityOnHand: stockDraft,
      });
    }, t('medicine.stockSaved'));
  }, [data, threadId, stockDraft, runAction, t]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!threadId) {
    return (
      <Screen>
        <ScreenHeader title={t('medicines.title')} onBack={() => router.back()} />
        <EmptyState title={t('errors.notFound')} icon="alert" />
      </Screen>
    );
  }

  if (state.loading || profile.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('medicines.title')} onBack={() => router.back()} />
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={120} label={t('a11y.loading')} />
          <Skeleton height={200} />
        </View>
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen>
        <ScreenHeader title={t('medicines.title')} onBack={() => router.back()} />
        <EmptyState title={t('errors.notFound')} icon="alert" />
      </Screen>
    );
  }

  const medicine = data.current;
  const stopped = medicine.status === 'stopped';
  const medicineUnconfirmed = medicine.confirmedByUserAt === null;
  const scheduleUnconfirmed =
    data.schedules.length > 0 && data.schedules.some((s) => s.confirmedByUserAt === null);

  const stockLine = describeStock(data.stock, fixedSlots, t, formatDate);

  const header = (
    <View style={{ gap: spacing.lg, paddingBottom: spacing.lg }}>
      {stopped ? (
        <Banner variant="info" title={t('medicine.stopped')} message={t('medicine.stoppedMessage')} />
      ) : null}

      {/* Confirmations sit above everything else: while either is outstanding, this
          medicine cannot remind her of anything, and that is the most important fact
          on the screen. */}
      {medicineUnconfirmed ? (
        <Card variant="outlined">
          <Text variant="label">{t('medicine.confirmMedicineTitle')}</Text>
          <Text variant="body" tone="muted" style={{ paddingTop: spacing.sm }}>
            {t('medicine.confirmMedicineMessage')}
          </Text>
          <Text variant="body" style={{ paddingTop: spacing.sm }}>
            {t('medicines.notConfirmedWarning')}
          </Text>
          <View style={{ paddingTop: spacing.md }}>
            <Button
              title={t('medicines.confirmMedicine')}
              onPress={handleConfirmMedicine}
              variant="primary"
              size="lg"
              fullWidth
              loading={busy}
            />
          </View>
        </Card>
      ) : null}

      {scheduleUnconfirmed ? (
        <Card variant="outlined">
          <Text variant="label">{t('medicine.confirmScheduleTitle')}</Text>
          <Text variant="body" tone="muted" style={{ paddingTop: spacing.sm }}>
            {t('medicine.confirmScheduleMessage')}
          </Text>
          {/* Stated in literal clock times, next to the button that starts them. */}
          <Text variant="body" style={{ paddingTop: spacing.sm }}>
            {reminderSentence}
          </Text>
          <View style={{ paddingTop: spacing.md }}>
            <Button
              title={t('medicines.confirmSchedule')}
              onPress={handleConfirmSchedule}
              variant="primary"
              size="lg"
              fullWidth
              loading={busy}
            />
          </View>
        </Card>
      ) : null}

      {/* ── What she is taking now ───────────────────────────────────────── */}
      <Card>
        <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
          <Thumb
            uri={medicine.stripPhotoUri}
            size={88}
            label={t('medicine.stripPhoto', { name: medicine.nameAsWritten })}
          />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text variant="caption" tone="muted">
              {t('medicine.currentTitle')}
            </Text>
            <Text variant="title">{medicine.nameAsWritten}</Text>
            {medicine.strength ? <Text variant="body">{medicine.strength}</Text> : null}
          </View>
        </View>

        <Divider style={{ marginVertical: spacing.md }} />

        <DetailRow
          label={t('medicine.form')}
          value={medicine.form ? t(`medicines.form.${medicine.form}`) : t('common.unknown')}
        />
        <DetailRow
          label={t('medicine.importance')}
          value={t(`medicines.criticality.${medicine.criticality}`)}
        />
        <DetailRow
          label={t('medicine.timesLabel')}
          value={
            data.isPrn
              ? t('medicine.onlyWhenNeeded')
              : namedTimes.length === 0
                ? t('medicine.noTimes')
                : joinList(namedTimes, t('common.and'))
          }
        />
        {!data.isPrn && times.length > 0 ? (
          <DetailRow
            label={t('medicines.doseTimes')}
            value={everyDay ? t('medicines.everyDay') : joinList(dayNames(daysMask, t), t('common.and'))}
          />
        ) : null}
        {fixedSlots[0]?.foodRelation ? (
          <DetailRow
            label={t('medicine.foodLabel')}
            value={t(`medicines.food.${fixedSlots[0].foodRelation}`)}
          />
        ) : null}
        {medicine.startedOn ? (
          <DetailRow label={t('medicines.startedOn', { date: formatDate(medicine.startedOn) })} />
        ) : null}
        {!medicineUnconfirmed && !scheduleUnconfirmed ? (
          <DetailRow label={t('medicine.confirmed')} />
        ) : null}
      </Card>

      {/* ── Stock ────────────────────────────────────────────────────────── */}
      <Card>
        <Text variant="label">{t('medicine.stockTitle')}</Text>
        <Text variant="body" style={{ paddingTop: spacing.sm }}>
          {stockLine.primary}
        </Text>
        {stockLine.secondary ? (
          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xs }}>
            {stockLine.secondary}
          </Text>
        ) : null}
        <View style={{ paddingTop: spacing.md }}>
          <Button
            title={t('medicine.stockRecord')}
            onPress={openStockDialog}
            variant="secondary"
            size="md"
            fullWidth
          />
        </View>
      </Card>

      {/* ── Lifecycle ────────────────────────────────────────────────────── */}
      <Card>
        <View style={{ gap: spacing.md }}>
          {stopped ? (
            <Button
              title={t('medicines.resume')}
              onPress={handleResume}
              variant="primary"
              size="lg"
              fullWidth
              loading={busy}
            />
          ) : (
            <Button
              title={t('medicines.stop')}
              onPress={() => void handleStop()}
              variant="destructive"
              size="lg"
              fullWidth
              loading={busy}
            />
          )}
        </View>
      </Card>
    </View>
  );

  return (
    <Screen
      variant="fixed"
      background="bgSunken"
      footer={
        <Button
          title={t('medicines.changeDose')}
          onPress={() => router.push(`/medicine/schedule?threadId=${threadId}`)}
          variant="primary"
          size="lg"
          fullWidth
        />
      }
    >
      <ScreenHeader title={medicine.nameAsWritten} onBack={() => router.back()} />

      <FlatList
        style={{ flex: 1 }}
        data={items}
        keyExtractor={(item) => item.key}
        getItemLayout={getItemLayout}
        ListHeaderComponent={header}
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        renderItem={({ item }) => {
          if (item.kind === 'section') {
            return (
              <View style={{ height: SECTION_HEIGHT, justifyContent: 'center' }}>
                <SectionHeader title={item.title} style={{ paddingTop: 0, paddingBottom: 0 }} />
              </View>
            );
          }
          if (item.kind === 'note') {
            return (
              <View style={{ height: NOTE_HEIGHT, paddingBottom: spacing.md }}>
                <Text variant="caption" tone="muted" numberOfLines={6}>
                  {item.text}
                </Text>
              </View>
            );
          }
          if (item.kind === 'empty') {
            return (
              <View style={{ height: EMPTY_HEIGHT, justifyContent: 'center' }}>
                <Text variant="body" tone="muted">
                  {item.text}
                </Text>
              </View>
            );
          }
          if (item.kind === 'prn') {
            return (
              <View style={{ height: PRN_HEIGHT, justifyContent: 'center' }}>
                <View
                  accessible
                  accessibilityLabel={item.text}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
                >
                  <Icon name="clock" size={22} color={colors.textMuted} />
                  <Text variant="body" numberOfLines={1}>
                    {item.text}
                  </Text>
                </View>
              </View>
            );
          }
          return (
            <View style={{ height: HISTORY_HEIGHT, paddingBottom: spacing.sm, justifyContent: 'center' }}>
              <Card variant="sunken" padding={spacing.md}>
                <Text variant="body" numberOfLines={2}>
                  {item.text}
                </Text>
              </Card>
            </View>
          );
        }}
      />

      {/* ── Stock count dialog ───────────────────────────────────────────── */}
      <Dialog
        visible={stockOpen}
        title={t('medicine.stockDialogTitle')}
        message={t('medicine.stockDialogMessage')}
        onRequestClose={() => setStockOpen(false)}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setStockOpen(false)}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button title={t('common.save')} onPress={handleSaveStock} variant="primary" size="lg" fullWidth />
          </View>
        }
      >
        {/* Steppers rather than a keyboard: ±10 reaches a strip of thirty in three
            taps, and none of them is a 6mm key next to another 6mm key. */}
        <View style={{ gap: spacing.md, alignItems: 'center' }}>
          <Text variant="hero">{String(stockDraft)}</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <StepKey
              icon="minus"
              label={t('medicine.minusTen')}
              onPress={() => setStockDraft((value) => Math.max(0, value - 10))}
            />
            <StepKey
              icon="minus"
              label={t('medicine.minusOne')}
              onPress={() => setStockDraft((value) => Math.max(0, value - 1))}
            />
            <StepKey
              icon="plus"
              label={t('medicine.plusOne')}
              onPress={() => setStockDraft((value) => value + 1)}
            />
            <StepKey
              icon="plus"
              label={t('medicine.plusTen')}
              onPress={() => setStockDraft((value) => value + 10)}
            />
          </View>
        </View>
      </Dialog>
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Small pieces
// ═══════════════════════════════════════════════════════════════════════════════

function DetailRow({ label, value }: { label: string; value?: string }) {
  return (
    <View
      accessible
      accessibilityLabel={value ? `${label}. ${value}` : label}
      style={{ flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm }}
    >
      <Text variant="body" tone="muted" style={{ flex: 1 }}>
        {label}
      </Text>
      {value ? (
        <Text variant="body" style={{ flex: 1 }}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

function StepKey({
  icon,
  label,
  onPress,
}: {
  icon: 'plus' | 'minus';
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        minWidth: spacing.touchTarget,
        minHeight: spacing.touchTarget,
        paddingHorizontal: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: colors.bgElevated,
        gap: spacing.xs,
        flexDirection: 'row',
      }}
    >
      <Icon name={icon} size={24} color={colors.text} />
      <Text variant="caption">{label}</Text>
    </PressableScale>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════════

type Translate = (key: string, params?: Record<string, string | number>) => string;

function joinList(parts: readonly string[], and: string): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  const head = parts.slice(0, -1).join(', ');
  return `${head} ${and} ${parts[parts.length - 1] ?? ''}`;
}

function dayNames(daysMask: number, t: Translate): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < 7; bit += 1) {
    if ((daysMask & (1 << bit)) !== 0) names.push(t(`date.weekdayShort.${bit + 1}`));
  }
  return names;
}

/**
 * The version history, as dated sentences in the order they happened.
 *
 * Medicine versions and schedule versions are independent append-only chains on the
 * same thread, so both are walked and the sentences are merged by date. A change that
 * touched neither the name nor the timings produces no sentence at all — a history
 * entry that says nothing changed is noise a reader has to skip past.
 */
function buildHistory(
  versions: readonly Medicine[],
  scheduleVersions: readonly DoseSchedule[],
  deps: { t: Translate; formatDate: (date: string) => string; formatTime: (time: string) => string },
): string[] {
  const { t, formatDate, formatTime } = deps;
  const lines: { date: string; order: number; text: string }[] = [];

  let previousLabel: string | null = null;
  versions.forEach((version, index) => {
    const label = [version.nameAsWritten, version.strength].filter(Boolean).join(' ');
    if (label !== previousLabel) {
      const date = version.startedOn ?? '';
      lines.push({
        date,
        order: index,
        text: t('medicine.history.name', { date: date ? formatDate(date) : '', name: label }),
      });
      previousLabel = label;
    }
    if (version.status === 'stopped' && version.stoppedOn) {
      lines.push({
        date: version.stoppedOn,
        order: index + 1000,
        text: t('medicine.history.stopped', { date: formatDate(version.stoppedOn) }),
      });
    }
  });

  const byVersion = new Map<number, DoseSchedule[]>();
  for (const slot of scheduleVersions) {
    const bucket = byVersion.get(slot.version);
    if (bucket) bucket.push(slot);
    else byVersion.set(slot.version, [slot]);
  }

  for (const [version, slots] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
    const first = slots[0];
    if (!first) continue;
    const date = slots.reduce((earliest, slot) => (slot.startedOn < earliest ? slot.startedOn : earliest), first.startedOn);
    const shownDate = formatDate(date);

    if (slots.every((slot) => slot.scheduleType === 'PRN')) {
      lines.push({ date, order: 2000 + version, text: t('medicine.history.prn', { date: shownDate }) });
      continue;
    }

    const times = slots
      .map((slot) => slot.timeLocal)
      .filter((time): time is string => time !== null)
      .sort()
      .map(formatTime);
    if (times.length === 0) continue;

    const quantity =
      first.quantityText ??
      (first.quantityValue !== null
        ? t('medicine.history.quantity', { count: first.quantityValue })
        : null);
    const timeList = joinList(times, t('common.and'));
    const everyDay = (first.daysMask & ALL_DAYS) === ALL_DAYS;
    const days = joinList(dayNames(first.daysMask, t), t('common.and'));

    const text = everyDay
      ? quantity
        ? t('medicine.history.schedule', { date: shownDate, quantity, times: timeList })
        : t('medicine.history.scheduleNoQuantity', { date: shownDate, times: timeList })
      : quantity
        ? t('medicine.history.scheduleDays', { date: shownDate, quantity, times: timeList, days })
        : t('medicine.history.scheduleDaysNoQuantity', { date: shownDate, times: timeList, days });

    lines.push({ date, order: 2000 + version, text });
  }

  return lines
    .sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1))
    .map((line) => line.text);
}

/**
 * Days of supply left — arithmetic on a number she counted herself, never advice.
 *
 * Null out of `projectRunOut` means "we cannot say" (an as-needed medicine has no
 * daily rate), which is a different answer from "you have plenty" and is reported as
 * such rather than as a large number.
 */
function describeStock(
  stock: MedicineStock | null,
  fixedSlots: readonly DoseSchedule[],
  t: Translate,
  formatDate: (localDate: string) => string,
): { primary: string; secondary?: string } {
  if (!stock) return { primary: t('medicine.stockNone') };

  let perDay = 0;
  for (const slot of fixedSlots) {
    const days = countDays(slot.daysMask) / 7;
    perDay += days / Math.max(1, slot.intervalDays);
  }

  const projection = projectRunOut(stock.countedOn, stock.quantityOnHand, perDay);
  if (!projection) {
    // No daily rate — an as-needed medicine has none. "We cannot say when this runs
    // out" and "you have plenty" are different answers, so only the count is stated.
    return {
      primary: t('medicine.stockCount', { count: stock.quantityOnHand }),
      secondary: t('medicine.stockCountedOn', { date: formatDate(stock.countedOn) }),
    };
  }

  const today = toLocalDate();
  const daysLeft = Math.max(0, daysBetween(today, projection.runOutOn));
  const low = needsRefill(
    stock.countedOn,
    stock.quantityOnHand,
    perDay,
    stock.refillLeadDays,
    today,
  );

  return {
    primary: low
      ? t('medicine.stockDaysLow', { count: daysLeft })
      : t('medicine.stockDays', { count: daysLeft }),
    secondary: t('medicines.refillBy', { date: formatDate(projection.runOutOn) }),
  };
}

function countDays(daysMask: number): number {
  let mask = daysMask & ALL_DAYS;
  let count = 0;
  while (mask !== 0) {
    count += mask & 1;
    mask >>= 1;
  }
  return count;
}
