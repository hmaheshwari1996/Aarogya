/**
 * As-needed medicines — a log, and only a log.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO, AND MUST NEVER BE "IMPROVED" TO DO
 *
 * It does not compute a minimum interval between doses. It does not say "you can take
 * another in 3 hours". It does not warn that a dose looks too soon, and it does not cap
 * a daily count. Every one of those is a dosing decision, and the only material this
 * screen has to make one from is a `quantity_text` string that was OCR'd off a
 * photograph of a piece of paper. A dosing decision made from that is a dosing decision
 * made on no evidence, and it would be delivered to a woman with cardiac disease,
 * diabetes and active TB in a voice she has every reason to trust.
 *
 * The honest product is: she taps, we write down that she took one and when. If she
 * wants to know whether she may take another, the person to ask is her doctor — and the
 * plain list of times below each medicine is exactly what she can show them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useState } from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';

import {
  Thumb,
  fixedItemLayout,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { Button, Card, EmptyState, Screen, ScreenHeader, Skeleton, Text, useToast } from '@/components/ui';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { Medicine } from '@/types';
import { toLocalDate } from '@/lib/datetime';
import { listActiveMedicines } from '@/db/repositories/medicines';
import { isPrnThread, listPrnDoses, logPrnDose } from '@/features/dosing/prn';

const STRINGS: LocalStrings = {
  'prn.title': { en: 'Only when needed', hi: 'सिर्फ़ ज़रूरत पड़ने पर' },
  'prn.subtitle': {
    en: 'Tap when you take one. Nothing here reminds you.',
    hi: 'जब लें तब दबा दें। यहाँ से कोई याद नहीं दिलाई जाती।',
  },
  'prn.takeNow': { en: 'I took this — now', hi: 'यह मैंने अभी ली' },
  'prn.takeNowFor': { en: 'I took {{name}} just now', hi: '{{name}} मैंने अभी ली' },
  'prn.today': { en: 'Today: {{times}}', hi: 'आज: {{times}}' },
  'prn.noneToday': { en: 'Nothing written down today', hi: 'आज कुछ दर्ज नहीं' },
  'prn.recordedAt': { en: 'Written down at {{time}}', hi: '{{time}} बजे दर्ज कर लिया' },
  'prn.saveFailed': {
    en: 'Could not write this down. Please try once more.',
    hi: 'यह दर्ज नहीं हो पाया। एक बार फिर कोशिश करें।',
  },
  'prn.empty': { en: 'No as-needed medicines', hi: 'ज़रूरत पड़ने पर ली जाने वाली कोई दवाई नहीं' },
  'prn.emptyMessage': {
    en: 'A medicine set to "only when needed" will appear here with a button to write down each dose.',
    hi: 'जिस दवाई को "सिर्फ़ ज़रूरत पड़ने पर" रखा गया है, वह यहाँ दिखेगी और हर खुराक दर्ज करने का बटन मिलेगा।',
  },
  'prn.stripPhoto': { en: 'Photo of the {{name}} strip', hi: '{{name}} के पत्ते की फोटो' },
};

type PrnRow = {
  medicine: Medicine;
  /** Today's doses, as wall-clock times, oldest first. */
  times: string[];
};

export default function PrnScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const { formatTime, formatEpochTime } = useDateFormat();
  const { isLargeText } = useTheme();

  const profile = useProfileId();
  const profileId = profile.data;
  const [busyThread, setBusyThread] = useState<string | null>(null);

  const state = useAsync<PrnRow[]>(async () => {
    if (!profileId) return [];
    const today = toLocalDate();
    const medicines = await listActiveMedicines(profileId);

    const rows: PrnRow[] = [];
    for (const medicine of medicines) {
      if (!(await isPrnThread(medicine.threadId))) continue;
      const events = await listPrnDoses(profileId, medicine.threadId, {
        fromDate: today,
        toDate: today,
      });
      // `listPrnDoses` returns newest first; the log reads more naturally forwards.
      const times = events.map((e) => formatEpochTime(e.atEpoch)).reverse();
      rows.push({ medicine, times });
    }
    return rows;
  }, [profileId, formatEpochTime]);

  const reload = state.reload;
  useReloadOnFocus(reload);

  const takeNow = useCallback(
    async (medicine: Medicine) => {
      setBusyThread(medicine.threadId);
      try {
        const result = await logPrnDose(medicine.threadId);
        const when = new Date(result.atEpoch);
        const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
        toast.show({ message: t('prn.recordedAt', { time: formatTime(clock) }), variant: 'success' });
        reload();
      } catch {
        toast.show({ message: t('prn.saveFailed'), variant: 'error' });
      } finally {
        setBusyThread(null);
      }
    },
    [formatTime, reload, t, toast],
  );

  /**
   * A fixed row height, which is what lets `getItemLayout` exist.
   *
   * The two values are measured against the tallest thing each row can hold: a 72dp
   * photo beside two lines of name, a 72dp `xl` button, and one capped line of times.
   * Large-text mode grows every one of those by 1.25×, so it gets its own number rather
   * than a scale factor that would be wrong at both ends.
   */
  const rowHeight = isLargeText ? 320 : 260;

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const loading = profile.loading || state.loading;

  return (
    <Screen variant="fixed">
      <ScreenHeader title={t('prn.title')} subtitle={t('prn.subtitle')} onBack={back} />

      {loading ? (
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={rowHeight - spacing.lg} label={t('a11y.loading')} />
          <Skeleton height={rowHeight - spacing.lg} />
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={state.data ?? []}
          keyExtractor={(item) => item.medicine.threadId}
          getItemLayout={fixedItemLayout(rowHeight)}
          initialNumToRender={4}
          windowSize={5}
          ListEmptyComponent={<EmptyState title={t('prn.empty')} message={t('prn.emptyMessage')} />}
          renderItem={({ item }) => (
            <View style={{ height: rowHeight, paddingBottom: spacing.lg }}>
              <Card style={{ flex: 1, gap: spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <Thumb
                    uri={item.medicine.stripPhotoUri}
                    size={72}
                    label={t('prn.stripPhoto', { name: item.medicine.nameAsWritten })}
                  />
                  <View style={{ flex: 1, gap: spacing.xs }}>
                    <Text variant="label" numberOfLines={1}>
                      {item.medicine.nameAsWritten}
                    </Text>
                    {item.medicine.strength ? (
                      <Text variant="body" tone="muted" numberOfLines={1}>
                        {item.medicine.strength}
                      </Text>
                    ) : null}
                  </View>
                </View>

                <Button
                  title={t('prn.takeNow')}
                  accessibilityLabel={t('prn.takeNowFor', { name: item.medicine.nameAsWritten })}
                  onPress={() => void takeNow(item.medicine)}
                  variant="primary"
                  size="xl"
                  fullWidth
                  loading={busyThread === item.medicine.threadId}
                  disabled={busyThread !== null && busyThread !== item.medicine.threadId}
                />

                {/* The log. Plain times, in the order they happened, and nothing derived
                    from them — no interval, no count against a limit, no advice. */}
                <Text variant="body" tone="muted" numberOfLines={1}>
                  {item.times.length > 0
                    ? t('prn.today', { times: item.times.join('   ') })
                    : t('prn.noneToday')}
                </Text>
              </Card>
            </View>
          )}
        />
      )}
    </Screen>
  );
}
