/**
 * The report a doctor reads.
 *
 * THREE PRESETS BEFORE ANY DATE PICKER. Almost every OPD visit wants "the last month" or
 * "the last three months", and a two-ended date picker as the first thing on the screen is
 * a wall — two controls, a dozen taps, and a real chance of producing an empty range by
 * accident. The custom picker is still here, one tap down, for the visit that genuinely
 * needs a particular span.
 *
 * THE REPORT IS WRITTEN IN ENGLISH WHATEVER THE APP'S LANGUAGE. That is a product
 * decision recorded in `src/i18n/index.ts`: the UI is bilingual, the printout is not,
 * because the page has to be readable by any doctor at any OPD — including one who reads
 * no Hindi. The screen says so before she generates anything, and `reports.readyMessage`
 * repeats it at the moment the file exists.
 *
 * The spreadsheet is deliberately the smaller, plainer control. It is for her son and a
 * laptop, not for the consultation; putting it beside the report at equal weight would
 * invite handing a doctor a file he cannot open on a hospital desktop.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import {
  Button,
  Card,
  Chip,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Text,
  useToast,
} from '@/components/ui';
import { useProfileId, useT, type LocalStrings } from '@/app/_shared/lib';
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, addMonthsClamped, toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { adherenceDisclaimer } from '@/features/adherence';
import {
  collectExportData,
  collectOpdReport,
  printOpdPdf,
  writeSpreadsheetExport,
  type OpdReportData,
  type PageOneLimits,
} from '@/features/reports';

const STRINGS: LocalStrings = {
  'range.title': { en: 'A report for the doctor', hi: 'डॉक्टर के लिए रिपोर्ट' },
  'range.subtitle': {
    en: 'Choose how far back it should go, then make it.',
    hi: 'कितने पीछे तक का हो, यह चुनें और बना लें।',
  },
  'range.chooseDates': { en: 'Choose dates myself', hi: 'तारीखें खुद चुनूँगी' },
  'range.from': { en: 'From', hi: 'इस दिन से' },
  'range.to': { en: 'To', hi: 'इस दिन तक' },
  'range.dateWithWeekday': { en: '{{weekday}}, {{date}}', hi: '{{weekday}}, {{date}}' },
  'range.dayEarlier': { en: 'One day earlier', hi: 'एक दिन पहले' },
  'range.dayLater': { en: 'One day later', hi: 'एक दिन बाद' },
  'range.covering': { en: 'The report will cover {{range}}', hi: 'रिपोर्ट में {{range}} का ब्यौरा होगा' },
  'range.whatToInclude': { en: 'What should be on the first page?', hi: 'पहले पन्ने पर क्या-क्या हो?' },
  'range.firstPageOnly': {
    en: 'These choose what goes on the first page. The full tables at the back of the report are always included.',
    hi: 'ये सिर्फ़ पहला पन्ना तय करते हैं। रिपोर्ट के आख़िर में पूरी तालिकाएँ हमेशा रहती हैं।',
  },
  'range.adherenceAlways': {
    en: 'The one-line reminder summary always stays on the report, together with the note below that says what it can and cannot mean.',
    hi: 'रिमाइंडर का एक लाइन का हिसाब रिपोर्ट पर हमेशा रहता है, और उसके साथ नीचे लिखी बात भी — कि उसका क्या मतलब है और क्या नहीं।',
  },
  'range.englishNote': {
    en: 'The report itself is written in English, so any doctor can read it.',
    hi: 'रिपोर्ट खुद अंग्रेज़ी में लिखी जाती है, ताकि कोई भी डॉक्टर उसे पढ़ सके।',
  },
  'range.makePdf': { en: 'Make the report', hi: 'रिपोर्ट बनाएँ' },
  'range.makeCsv': { en: 'A spreadsheet file instead', hi: 'इसकी जगह स्प्रेडशीट फ़ाइल' },
  'range.csvHelp': {
    en: 'For someone who wants the numbers in a spreadsheet. Not for the doctor.',
    hi: 'जिन्हें नंबर स्प्रेडशीट में चाहिए उनके लिए। डॉक्टर के लिए नहीं।',
  },
  'range.csvMultiple': {
    en: '{{count}} files were written. The one you are looking at lists the others.',
    hi: '{{count}} फ़ाइलें बनी हैं। जो आप देख रही हैं उसमें बाकी की सूची है।',
  },
  'range.failed': {
    en: 'The report could not be made. Please try again.',
    hi: 'रिपोर्ट नहीं बन पाई। फिर कोशिश करें।',
  },
  'range.badRange': {
    en: 'The first date is after the second one. Please check them.',
    hi: 'पहली तारीख़ दूसरी के बाद की है। कृपया जाँच लें।',
  },
};

type Preset = 'week' | 'month' | 'threeMonths' | 'custom';

function DateStepper({
  value,
  onChange,
  display,
  spoken,
  earlierLabel,
  laterLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Already translated. */
  display: string;
  spoken: string;
  earlierLabel: string;
  laterLabel: string;
}) {
  const { colors } = useTheme();
  const stepStyle = {
    width: spacing.touchTarget,
    height: spacing.touchTarget,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <PressableScale
        onPress={() => onChange(addDays(value, -1))}
        accessibilityRole="button"
        accessibilityLabel={earlierLabel}
        style={stepStyle}
      >
        <Icon name="minus" size={28} color={colors.primary} />
      </PressableScale>
      <View accessible accessibilityLabel={spoken} style={{ flex: 1 }}>
        <Text variant="body" weight="600" align="center" numberOfLines={1}>
          {display}
        </Text>
      </View>
      <PressableScale
        onPress={() => onChange(addDays(value, 1))}
        accessibilityRole="button"
        accessibilityLabel={laterLabel}
        style={stepStyle}
      >
        <Icon name="plus" size={28} color={colors.primary} />
      </PressableScale>
    </View>
  );
}

export default function RangeReportScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const { formatDate, formatWeekday, formatDateRange } = useDateFormat();

  const profile = useProfileId();
  const profileId = profile.data;

  const today = toLocalDate();
  const [preset, setPreset] = useState<Preset>('month');
  const [customFrom, setCustomFrom] = useState<string>(addDays(today, -29));
  const [customTo, setCustomTo] = useState<string>(today);

  const [includeCharts, setIncludeCharts] = useState(true);
  const [includeMedicines, setIncludeMedicines] = useState(true);
  const [includeAdherence, setIncludeAdherence] = useState(true);
  const [includeSymptoms, setIncludeSymptoms] = useState(true);

  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);

  const range = useMemo(() => {
    if (preset === 'week') return { fromDate: addDays(today, -6), toDate: today };
    if (preset === 'month') return { fromDate: addDays(today, -29), toDate: today };
    if (preset === 'threeMonths') {
      // Calendar months, clamped: three months back from 31 May is 28/29 February, not a
      // 90-day approximation that lands mid-week and reads as an arbitrary date.
      return { fromDate: addDays(addMonthsClamped(today, -3), 1), toDate: today };
    }
    return { fromDate: customFrom, toDate: customTo };
  }, [customFrom, customTo, preset, today]);

  const describeDate = useCallback(
    (localDate: string, short: boolean) =>
      t('range.dateWithWeekday', {
        weekday: formatWeekday(localDate, short),
        date: formatDate(localDate),
      }),
    [formatDate, formatWeekday, t],
  );

  /**
   * The toggles trim PAGE ONE. They do not delete anything from the record.
   *
   * `PageOneLimits` caps how many charts, medicines and symptom groups reach the summary
   * page; the appendix at the back still carries every row. That distinction is the whole
   * reason the toggles are implemented this way rather than by blanking the collected
   * data: a report that says "None reported in this period" because she chose a shorter
   * first page would be the app making a false statement to a doctor.
   *
   * The adherence headline is the one block that cannot be dropped, so its toggle removes
   * the secondary window table instead and the screen says so. The figure keeps its
   * disclaimer either way.
   */
  const shapeReport = useCallback(
    (data: OpdReportData): { data: OpdReportData; limits: Partial<PageOneLimits> } => {
      const limits: Partial<PageOneLimits> = {};
      if (!includeCharts) limits.charts = 0;
      if (!includeMedicines) limits.medicines = 0;
      if (!includeSymptoms) limits.symptoms = 0;
      return {
        data: includeAdherence ? data : { ...data, adherenceWindows: [] },
        limits,
      };
    },
    [includeAdherence, includeCharts, includeMedicines, includeSymptoms],
  );

  const makePdf = useCallback(async () => {
    if (!profileId) return;
    setBusy('pdf');
    try {
      const collected = await collectOpdReport(profileId, range);
      const shaped = shapeReport(collected);
      const pdf = await printOpdPdf(shaped.data, { build: { limits: shaped.limits } });
      toast.show({ message: t('reports.readyMessage'), variant: 'success' });
      router.push(`/report/preview?uri=${encodeURIComponent(pdf.uri)}&kind=pdf`);
    } catch {
      toast.show({ message: t('range.failed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [profileId, range, shapeReport, t, toast]);

  const makeCsv = useCallback(async () => {
    if (!profileId) return;
    setBusy('csv');
    try {
      const data = await collectExportData(profileId, range);
      // `preferXlsx: false` because this control says "a spreadsheet file" and CSV is the
      // format that opens everywhere without a library being present on the phone.
      const outcome = await writeSpreadsheetExport(data, { preferXlsx: false });
      const first = outcome.files[0];
      if (!first) throw new Error('The export produced no files');
      if (outcome.files.length > 1) {
        toast.show({ message: t('range.csvMultiple', { count: outcome.files.length }), variant: 'info' });
      }
      router.push(`/report/preview?uri=${encodeURIComponent(first.uri)}&kind=csv`);
    } catch {
      toast.show({ message: t('range.failed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [profileId, range, t, toast]);

  const generate = useCallback(
    (kind: 'pdf' | 'csv') => {
      if (range.fromDate > range.toDate) {
        toast.show({ message: t('range.badRange'), variant: 'error' });
        return;
      }
      void (kind === 'pdf' ? makePdf() : makeCsv());
    },
    [makeCsv, makePdf, range.fromDate, range.toDate, t, toast],
  );

  return (
    <Screen
      background="bgSunken"
      footer={
        <View style={{ gap: spacing.md }}>
          <Button
            title={t('range.makePdf')}
            onPress={() => generate('pdf')}
            size="xl"
            fullWidth
            loading={busy === 'pdf'}
            disabled={busy !== null}
          />
          <Button
            title={t('range.makeCsv')}
            onPress={() => generate('csv')}
            variant="ghost"
            fullWidth
            loading={busy === 'csv'}
            disabled={busy !== null}
          />
        </View>
      }
    >
      <ScreenHeader title={t('range.title')} subtitle={t('range.subtitle')} onBack={() => router.back()} />

      {/* ── The three presets, before any date control ────────────────────────── */}
      <Card style={{ gap: spacing.sm }}>
        <Text variant="label">{t('reports.period.label')}</Text>
        <Chip
          label={t('reports.period.week')}
          selected={preset === 'week'}
          onPress={() => setPreset('week')}
          grow
        />
        <Chip
          label={t('reports.period.month')}
          selected={preset === 'month'}
          onPress={() => setPreset('month')}
          grow
        />
        <Chip
          label={t('reports.period.threeMonths')}
          selected={preset === 'threeMonths'}
          onPress={() => setPreset('threeMonths')}
          grow
        />
        <Chip
          label={t('range.chooseDates')}
          selected={preset === 'custom'}
          onPress={() => setPreset('custom')}
          grow
        />

        {preset === 'custom' ? (
          <View style={{ gap: spacing.md, paddingTop: spacing.sm }}>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('range.from')}</Text>
              <DateStepper
                value={customFrom}
                onChange={setCustomFrom}
                display={describeDate(customFrom, true)}
                spoken={describeDate(customFrom, false)}
                earlierLabel={t('range.dayEarlier')}
                laterLabel={t('range.dayLater')}
              />
            </View>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('range.to')}</Text>
              <DateStepper
                value={customTo}
                onChange={setCustomTo}
                display={describeDate(customTo, true)}
                spoken={describeDate(customTo, false)}
                earlierLabel={t('range.dayEarlier')}
                laterLabel={t('range.dayLater')}
              />
            </View>
          </View>
        ) : null}

        <Text variant="body" tone="muted">
          {t('range.covering', { range: formatDateRange(range.fromDate, range.toDate) })}
        </Text>
      </Card>

      {/* ── What goes on page one ─────────────────────────────────────────────── */}
      <SectionHeader title={t('range.whatToInclude')} subtitle={t('range.firstPageOnly')} />

      <Card style={{ gap: spacing.sm }}>
        <Chip
          label={t('reports.includeCharts')}
          selected={includeCharts}
          onPress={() => setIncludeCharts((value) => !value)}
          selectionMode="multiple"
          grow
        />
        <Chip
          label={t('reports.includeMedicines')}
          selected={includeMedicines}
          onPress={() => setIncludeMedicines((value) => !value)}
          selectionMode="multiple"
          grow
        />
        <Chip
          label={t('reports.includeAdherence')}
          selected={includeAdherence}
          onPress={() => setIncludeAdherence((value) => !value)}
          selectionMode="multiple"
          grow
        />

        <Text variant="caption" tone="muted">
          {t('range.adherenceAlways')}
        </Text>
        {/* Verbatim, in English, because this is the exact sentence the report prints under
            every adherence figure — and she should have read it before her doctor does. */}
        <Text variant="caption" tone="muted">
          {adherenceDisclaimer()}
        </Text>
        <Text variant="caption" tone="muted">
          {t('reminders.adherence.explain')}
        </Text>

        <Chip
          label={t('reports.includeSymptoms')}
          selected={includeSymptoms}
          onPress={() => setIncludeSymptoms((value) => !value)}
          selectionMode="multiple"
          grow
        />
      </Card>

      <Text variant="body" tone="muted" style={{ paddingTop: spacing.lg }}>
        {t('range.englishNote')}
      </Text>
      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.sm }}>
        {t('range.csvHelp')}
      </Text>
    </Screen>
  );
}
