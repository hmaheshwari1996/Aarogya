/**
 * "How I felt" — the log of symptom entries, reachable from More, where a wrongly-recorded
 * one can be removed.
 *
 * The app had no per-entry surface for symptoms: they were logged from a tile and shown
 * only as an aggregate bar chart on Trends, so a mistaken entry — the wrong symptom, the
 * wrong day, a note meant for a different one — could never be taken back, and it then rode
 * into the OPD report a doctor reads. This screen is the smallest thing that fixes that:
 * the entries she made, newest first, each removable by name and date.
 *
 * DELETE IS SOFT AND CONFIRMED. `deleteSymptomEvent` sets `deleted_at_epoch`; every read
 * already filters it, so a removed entry leaves the lists, the trends chart and the report
 * at once and does not come back. The confirmation names the symptom and its date rather
 * than a generic "Are you sure?", because the whole reason to delete one is that another
 * looks like it.
 */

import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';

import { spacing } from '@/theme';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import {
  deleteSymptomEvent,
  listSymptomDefs,
  listSymptomEvents,
} from '@/db/repositories/symptoms';
import type { SymptomEvent } from '@/types';

import { useAsync, useProfileId, useT, type LocalStrings } from './_shared/lib';

const STRINGS: LocalStrings = {
  'symptoms.title': { en: 'How I Felt', hi: 'मैंने कैसा महसूस किया' },
  'symptoms.subtitle': {
    en: 'Everything you have recorded, newest first. Remove anything you noted by mistake.',
    hi: 'आपका दर्ज किया हुआ सब कुछ, नया सबसे ऊपर। ग़लती से लिखा कुछ हो तो हटा दीजिए।',
  },
  'symptoms.empty': { en: 'Nothing recorded yet', hi: 'अभी कुछ दर्ज नहीं है' },
  'symptoms.emptyMessage': {
    en: 'When you record how you feel, each entry appears here.',
    hi: 'जब आप अपनी तबीयत दर्ज करेंगी, हर बात यहाँ दिखेगी।',
  },
  'symptoms.delete': { en: 'Delete', hi: 'हटाइए' },
  'symptoms.deleteTitle': { en: 'Delete this entry?', hi: 'यह बात हटाएँ?' },
  'symptoms.deleteMessage': {
    en: '“{{label}}” recorded on {{date}} will be removed from your record and from the report. This cannot be undone.',
    hi: '{{date}} को दर्ज “{{label}}” आपके रिकॉर्ड और रिपोर्ट से हट जाएगी। यह वापस नहीं आ सकती।',
  },
  'symptoms.deleteConfirm': { en: 'Delete It', hi: 'हटा दीजिए' },
  'symptoms.deleteKeep': { en: 'Keep It', hi: 'रहने दीजिए' },
  'symptoms.deleted': { en: 'Entry removed', hi: 'बात हटा दी गई' },
  'symptoms.deleteFailed': {
    en: 'The entry could not be removed. Nothing has changed.',
    hi: 'बात हटाई नहीं जा सकी। कुछ नहीं बदला।',
  },
  'symptoms.severity.mild': { en: 'Mild', hi: 'हल्का' },
  'symptoms.severity.moderate': { en: 'Moderate', hi: 'मध्यम' },
  'symptoms.severity.severe': { en: 'Severe', hi: 'तेज़' },
  'symptoms.unnamed': { en: 'Symptom', hi: 'लक्षण' },
};

/** Not a chart, so the whole history is fine to show; a cap keeps a heavy logger bounded. */
const HISTORY_LIMIT = 300;

type Row = {
  event: SymptomEvent;
  label: string;
};

type ScreenData = {
  rows: Row[];
};

export default function SymptomsScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const { formatDate } = useDateFormat();
  const confirm = useConfirm();
  const toast = useToast();

  const profile = useProfileId();
  const profileId = profile.data;

  const state = useAsync<ScreenData | null>(async () => {
    if (!profileId) return null;
    const [events, defs] = await Promise.all([
      listSymptomEvents(profileId, { limit: HISTORY_LIMIT }),
      listSymptomDefs(),
    ]);
    const labels = new Map(defs.map((d) => [d.key, { en: d.labelEn, hi: d.labelHi }] as const));
    const rows = events.map((event) => {
      const named = event.symptomKey ? labels.get(event.symptomKey) : undefined;
      const label =
        (named ? named[lang] : undefined) ?? event.customLabel ?? t('symptoms.unnamed');
      return { event, label };
    });
    return { rows };
  }, [profileId, lang]);

  const remove = useCallback(
    async (row: Row) => {
      const ok = await confirm({
        title: t('symptoms.deleteTitle'),
        message: t('symptoms.deleteMessage', {
          label: row.label,
          date: formatDate(row.event.localDate),
        }),
        confirmLabel: t('symptoms.deleteConfirm'),
        cancelLabel: t('symptoms.deleteKeep'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteSymptomEvent(row.event.id);
        toast.show({ message: t('symptoms.deleted'), variant: 'success' });
        state.reload();
      } catch {
        toast.show({ message: t('symptoms.deleteFailed'), variant: 'error' });
      }
    },
    [confirm, formatDate, t, toast, state],
  );

  const severityWord = useCallback(
    (severity: SymptomEvent['severity']): string | null =>
      severity ? t(`symptoms.severity.${severity}`) : null,
    [t],
  );

  const body = useMemo(() => {
    if (state.loading) {
      return (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </View>
      );
    }
    const rows = state.data?.rows ?? [];
    if (rows.length === 0) {
      return <EmptyState title={t('symptoms.empty')} message={t('symptoms.emptyMessage')} />;
    }
    return (
      <View style={{ gap: spacing.md }}>
        {rows.map((row) => {
          const severity = severityWord(row.event.severity);
          const when = `${formatDate(row.event.localDate)} · ${row.event.localTime}`;
          return (
            <Card key={row.event.id} style={{ gap: spacing.sm }}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: spacing.md,
                }}
              >
                <View style={{ flex: 1, gap: spacing.xs }}>
                  <Text variant="label">{row.label}</Text>
                  <Text variant="caption" tone="muted">
                    {severity ? `${when} · ${severity}` : when}
                  </Text>
                </View>
                <Button
                  title={t('symptoms.delete')}
                  variant="secondary"
                  onPress={() => remove(row)}
                  accessibilityHint={t('symptoms.deleteMessage', {
                    label: row.label,
                    date: formatDate(row.event.localDate),
                  })}
                />
              </View>
              {row.event.note ? (
                <Text variant="body">{`“${row.event.note}”`}</Text>
              ) : null}
            </Card>
          );
        })}
      </View>
    );
  }, [state.loading, state.data, t, formatDate, remove, severityWord]);

  return (
    <Screen variant="scroll">
      <ScreenHeader title={t('symptoms.title')} subtitle={t('symptoms.subtitle')} />
      {body}
    </Screen>
  );
}
