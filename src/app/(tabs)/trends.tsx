/**
 * Trends — five charts, each answering exactly one question, none of them answering
 * "is this good or bad?".
 *
 * ─── THE THREE DECISIONS THAT SHAPE EVERY CHART BELOW ─────────────────────────
 *
 * 1. BLOOD PRESSURE AND BLOOD SUGAR ARE UNCONNECTED SCATTERS, NOT LINES.
 *    A line drawn from a 96 fasting reading to a 210 after-meal reading renders a
 *    slope, and a slope is a claim: "this is going up". Those two numbers answer
 *    two different questions asked at two different moments; they are not two points
 *    on one trajectory. The same is true of a morning and an evening blood pressure.
 *    So the line thickness is zero and the stroke is painted in the card's own
 *    background colour — the markers are the entire chart.
 *
 * 2. THE MORNING/EVENING AND MEAL-CONTEXT SPLITS ARE CARRIED BY MARKER SHAPE, NEVER
 *    BY COLOUR. Roughly 8% of men have red/green deficiency (the son is a user of
 *    this app too), and the chart she will actually hand to a doctor is a monochrome
 *    OPD printout. A round mark and a square mark survive both.
 *
 * 3. A TARGET BAND IS DRAWN ONLY WHERE A NAMED HUMAN WROTE ONE DOWN. `target_range`
 *    ships empty and stays empty. Where there is no row, there is no line and the
 *    chart says so in words rather than quietly implying the reading needs no
 *    comparison. Every band that IS drawn carries the setter's name and date.
 *
 * There is deliberately NO pie chart of "in range vs out of range". That is a
 * clinical verdict rendered as geometry, and with an empty target table it would
 * ship as a blank circle anyway.
 *
 * 4. A READING THE METER REFUSED TO NUMBER IS STILL A READING. A glucometer that
 *    prints LO has asserted `sugar < 20 mg/dL` — an inequality, not a blank. This
 *    screen used to build every series with `.filter(r => r.v1 !== null)`, which
 *    deleted all of them, and then reported "No blood sugar recorded yet" over a
 *    fortnight in which she had recorded a hypoglycaemic episode. That is the app
 *    stating something false about her own record, on the screen she would open to
 *    check it.
 *
 *    They are now plotted at the limit of her meter's range, marked with the two
 *    letters the meter itself displayed — LO or HI — rather than a filled point.
 *    Shape was already spent on morning/evening and on fasting/other, and the chart
 *    library offers exactly two shapes, so the third distinction is carried by a
 *    WORD; that is the same fallback the OPD chart uses in its legend, and a word
 *    survives greyscale, colour deficiency and a fax. The mark is never joined into
 *    a line, never counted as a measurement, and the caption says in words what it
 *    means. Where her meter's range has not been recorded there is no honest place
 *    to draw one, so it is counted and declared instead — see `planSeries`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { BarChart, LineChart } from 'react-native-gifted-charts';
import type { barDataItem, lineDataItem } from 'react-native-gifted-charts';

import {
  ChartCaption,
  METRIC_BP,
  METRIC_SUGAR,
  METRIC_WEIGHT,
  capSeries,
  isMorningReading,
  matchTarget,
  metricUnit,
  targetFootnote,
  trimNumber,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { Card, Chip, EmptyState, Screen, ScreenHeader, Skeleton, Text } from '@/components/ui';
// Imported from its own module rather than the barrel: this screen does not own
// `src/components/ui/index.ts`. See that file's header for what a boundary can and
// cannot catch — in particular, NOT a throw at module scope of a static import.
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { adherenceDisclaimer, buildDayTallies, type DayTally } from '@/features/adherence';
import { longestNoRecordRun, summariseAdherence } from '@/features/adherence/compute';
import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, toLocalDate } from '@/lib/datetime';
import { capPlan, planBounds, planSeries, type SeriesPlan } from '@/features/trends/censoredSeries';
import { listReadings } from '@/db/repositories/readings';
import { listSymptomDefs, listSymptomEvents } from '@/db/repositories/symptoms';
import { listTargets } from '@/db/repositories/targets';
import { spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import type { Reading, SymptomEvent, TargetRange } from '@/types';

const STRINGS: LocalStrings = {
  'trends.title': { en: 'Trends', hi: 'रुझान' },
  'trends.subtitle': {
    en: 'Only what you have recorded. Nothing here is a judgement.',
    hi: 'सिर्फ़ वही जो आपने दर्ज किया है। यहाँ कोई राय नहीं दी गई है।',
  },
  'trends.period': { en: 'Which period?', hi: 'कौन सी अवधि?' },
  'trends.noTargetLine': {
    en: 'No target has been written down for this, so no target line is drawn.',
    hi: 'इसके लिए कोई लक्ष्य लिखा नहीं गया है, इसलिए कोई लक्ष्य-रेखा नहीं खींची गई।',
  },
  'trends.a11yChart': {
    en: '{{title}}. A chart of {{count}} recorded points over the last {{days}} days.',
    hi: '{{title}}. पिछले {{days}} दिनों के {{count}} दर्ज बिंदुओं का चार्ट।',
  },
  // Shown in place of ONE chart when the drawing code throws. It says what is safe
  // before it says what broke, because the first thing she will wonder is whether
  // her records are gone. They are not: every reading was committed to the database
  // long before this screen tried to draw it.
  'trends.chartFailed': { en: 'This chart could not be drawn', hi: 'यह चार्ट नहीं बन सका' },
  'trends.chartFailedMessage': {
    en: 'Everything you recorded is safe. The other charts on this screen still work.',
    hi: 'आपने जो कुछ दर्ज किया है वह सुरक्षित है। इस स्क्रीन के बाकी चार्ट काम कर रहे हैं।',
  },
  'trends.bp.caption': {
    en: 'Each mark is one blood pressure you recorded in the last {{days}} days. The upper and the lower number are shown separately.',
    hi: 'हर निशान पिछले {{days}} दिनों में दर्ज किया गया एक रक्तचाप है। ऊपर वाला और नीचे वाला अंक अलग-अलग दिखाए गए हैं।',
  },
  'trends.bp.legendMorning': {
    en: 'Round mark: measured before 12:00',
    hi: 'गोल निशान: 12:00 से पहले नापा गया',
  },
  'trends.bp.legendEvening': {
    en: 'Square mark: measured at 12:00 or later',
    hi: 'चौकोर निशान: 12:00 या उसके बाद नापा गया',
  },
  'trends.bp.notJoined': {
    en: 'The marks are not joined, because a morning reading and an evening reading are two separate measurements.',
    hi: 'निशान आपस में नहीं जोड़े गए हैं, क्योंकि सुबह का और शाम का नाप दो अलग-अलग माप हैं।',
  },
  'trends.bp.empty': { en: 'No blood pressure recorded yet', hi: 'अभी कोई रक्तचाप दर्ज नहीं है' },
  'trends.bp.emptyMessage': {
    en: 'Record a blood pressure and it will appear here.',
    hi: 'एक बार रक्तचाप दर्ज करें, वह यहाँ दिखने लगेगा।',
  },

  'trends.sugar.caption': {
    en: 'Each mark is one blood sugar you recorded in the last {{days}} days.',
    hi: 'हर निशान पिछले {{days}} दिनों में दर्ज की गई एक ब्लड शुगर है।',
  },
  'trends.sugar.legendFasting': {
    en: 'Square mark: measured on an empty stomach or before a meal',
    hi: 'चौकोर निशान: खाली पेट या खाने से पहले नापा गया',
  },
  'trends.sugar.legendOther': {
    en: 'Round mark: measured at any other time',
    hi: 'गोल निशान: किसी और समय नापा गया',
  },
  'trends.sugar.notJoined': {
    en: 'The marks are not joined. An empty-stomach reading and an after-meal reading answer different questions, so a line between them would mean nothing.',
    hi: 'निशान आपस में नहीं जोड़े गए हैं। खाली पेट का नाप और खाने के बाद का नाप अलग-अलग सवालों के जवाब हैं, इसलिए उनके बीच खींची गई रेखा का कोई मतलब नहीं होता।',
  },
  'trends.sugar.empty': { en: 'No blood sugar recorded yet', hi: 'अभी कोई ब्लड शुगर दर्ज नहीं है' },
  'trends.sugar.emptyMessage': {
    en: 'Record a blood sugar and it will appear here.',
    hi: 'एक बार ब्लड शुगर दर्ज करें, वह यहाँ दिखने लगेगी।',
  },

  // ── LO / HI ─────────────────────────────────────────────────────────────
  // The wording is about the METER, never about her. "The meter could not give a
  // number" is a fact about a device; "your sugar was very low" would be a verdict
  // the app has no standing to render, and the difference is the whole point.
  'trends.censored.legend': {
    en: 'LO or HI: the meter showed a word instead of a number. The mark sits at the limit of what your meter can measure ({{bound}}), and the real reading was past it.',
    hi: 'LO या HI: मीटर ने अंक की जगह शब्द दिखाया। निशान वहाँ है जहाँ तक आपका मीटर नाप सकता है ({{bound}}), और असली रीडिंग उससे आगे थी।',
  },
  'trends.censored.notAValue': {
    en: 'That mark is not a measurement. It only shows where the meter stopped reading.',
    hi: 'वह निशान कोई नाप नहीं है। वह सिर्फ़ यह बताता है कि मीटर कहाँ तक पढ़ सका।',
  },
  'trends.censored.noRange': {
    en: '{{count}} reading showed LO or HI and is not on this chart, because your meter\'s range has not been written down yet.',
    hi: '{{count}} रीडिंग में LO या HI आया था और वह इस चार्ट पर नहीं है, क्योंकि आपके मीटर की सीमा अभी लिखी नहीं गई है।',
  },
  'trends.censored.noRangePlural': {
    en: '{{count}} readings showed LO or HI and are not on this chart, because your meter\'s range has not been written down yet.',
    hi: '{{count}} रीडिंग में LO या HI आया था और वे इस चार्ट पर नहीं हैं, क्योंकि आपके मीटर की सीमा अभी लिखी नहीं गई है।',
  },
  // Shown INSTEAD of "nothing recorded yet" when the only thing in the period is a
  // LO or a HI with no meter range. The old screen said the record was empty; it
  // was not, and this is the sentence that stops it saying so.
  'trends.censored.onlyCensoredTitle': {
    en: 'Recorded, but not on this chart',
    hi: 'दर्ज है, पर इस चार्ट पर नहीं',
  },
  'trends.censored.onlyCensored': {
    en: 'Everything you recorded in this period showed LO or HI on the meter. Those readings are safe and are in your record — the chart needs to know what your meter can measure before it can place them.',
    hi: 'इस अवधि में आपने जो भी दर्ज किया उसमें मीटर पर LO या HI आया। वे रीडिंग सुरक्षित हैं और आपके रिकॉर्ड में हैं — चार्ट पर दिखाने के लिए पहले यह जानना ज़रूरी है कि आपका मीटर कहाँ तक नाप सकता है।',
  },
  'trends.a11yChartWithCensored': {
    en: '{{title}}. A chart of {{count}} recorded points over the last {{days}} days, and {{censored}} readings where the meter showed LO or HI.',
    hi: '{{title}}. पिछले {{days}} दिनों के {{count}} दर्ज बिंदुओं का चार्ट, और {{censored}} रीडिंग जिनमें मीटर ने LO या HI दिखाया।',
  },

  'trends.weight.caption': {
    en: 'Your weight over the last {{days}} days, joined in the order you recorded it.',
    hi: 'पिछले {{days}} दिनों का आपका वज़न, उसी क्रम में जोड़ा गया जिस क्रम में आपने दर्ज किया।',
  },
  'trends.weight.zeroAxis': {
    en: 'The scale starts at zero, so a small change looks small.',
    hi: 'पैमाना शून्य से शुरू होता है, इसलिए छोटा बदलाव छोटा ही दिखता है।',
  },
  'trends.weight.empty': { en: 'No weight recorded yet', hi: 'अभी कोई वज़न दर्ज नहीं है' },
  'trends.weight.emptyMessage': {
    en: 'Record your weight and it will appear here.',
    hi: 'एक बार वज़न दर्ज करें, वह यहाँ दिखने लगेगा।',
  },

  'trends.adherence.title': { en: 'Reminder record, day by day', hi: 'याद दिलाने का रिकॉर्ड, दिन-ब-दिन' },
  'trends.adherence.caption': {
    en: 'One bar for each of the last {{days}} days. The height of a bar is how many doses were recorded as taken on that day.',
    hi: 'पिछले {{days}} दिनों में हर दिन के लिए एक पट्टी। पट्टी की ऊँचाई बताती है कि उस दिन कितनी खुराकें ली गई दर्ज हुईं।',
  },
  'trends.adherence.axis': { en: 'Doses recorded as taken', hi: 'ली गई दर्ज खुराकें' },
  'trends.adherence.silentDays': {
    en: 'On {{count}} of these days nothing was recorded either way. A day with no bar is not a day with nothing taken.',
    hi: 'इनमें से {{count}} दिन ऐसे रहे जिनमें कुछ भी दर्ज नहीं हुआ। जिस दिन पट्टी नहीं है, उसका मतलब यह नहीं कि उस दिन कुछ लिया नहीं गया।',
  },
  'trends.adherence.percent': {
    en: '{{taken}} of the {{due}} doses due in this period were recorded as taken.',
    hi: 'इस अवधि में तय {{due}} खुराकों में से {{taken}} ली गई दर्ज हुईं।',
  },
  'trends.adherence.empty': { en: 'No reminder record yet', hi: 'अभी याद दिलाने का कोई रिकॉर्ड नहीं है' },
  'trends.adherence.emptyMessage': {
    en: 'Once a dose time has passed, that day will appear here.',
    hi: 'जब किसी खुराक का समय बीत जाएगा, वह दिन यहाँ दिखने लगेगा।',
  },

  'trends.symptoms.title': { en: 'What you said you were feeling', hi: 'आपने जो महसूस करना बताया' },
  'trends.symptoms.caption': {
    en: 'The six things you reported most often in the last {{days}} days, and how many times you reported each.',
    hi: 'पिछले {{days}} दिनों में आपने जो छह बातें सबसे ज़्यादा बताईं, और हर एक कितनी बार बताई।',
  },
  'trends.symptoms.onlySix': {
    en: 'Only the top six are shown, so each one stays readable.',
    hi: 'सिर्फ़ ऊपर की छह दिखाई गई हैं, ताकि हर एक पढ़ी जा सके।',
  },
  'trends.symptoms.empty': { en: 'Nothing reported yet', hi: 'अभी कुछ नहीं बताया गया' },
  'trends.symptoms.emptyMessage': {
    en: 'Record how you are feeling and it will appear here.',
    hi: 'आप कैसा महसूस कर रही हैं, यह दर्ज करें — वह यहाँ दिखेगा।',
  },
};

/** The three periods, shortest first. 90 is also `capSeries`'s natural ceiling. */
const PERIODS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIODS)[number];

const PERIOD_KEYS: Record<PeriodDays, string> = {
  7: 'reports.period.week',
  30: 'reports.period.month',
  90: 'reports.period.threeMonths',
};

const CHART_HEIGHT = 200;
/**
 * The narrowest y-axis gutter, in dp. It is a FLOOR, not the value: the real width is
 * derived from the current text size below, because in large-text mode a four-digit
 * label ("1200" on a chart with one wild glucose reading in it) is wider than 44dp and
 * the library simply overlaps it with the plot area.
 */
const Y_AXIS_LABEL_WIDTH_MIN = 44;
/** Marker geometry. Big enough to separate a circle from a square at arm's length. */
const MARKER = 12;
/**
 * Floors and fallbacks for the chart body.
 *
 * `useWindowDimensions()` can hand back 0 for a frame on some Android skins — during
 * rotation, and on the first layout after the tab is created. Zero propagates: a zero
 * width divided across 90 bars is a zero slot, and a NaN width divides into NaN. Both
 * of those reach react-native-svg as coordinates, which is the failure mode this whole
 * pass exists to remove.
 */
const MIN_CHART_WIDTH = 160;
const FALLBACK_WINDOW_WIDTH = 360;
/** Padding before the first bar and after the last, on the reminder-record chart. */
const ADHERENCE_EDGE = spacing.sm;

type TrendData = {
  bp: Reading[];
  sugar: Reading[];
  weight: Reading[];
  targets: TargetRange[];
  days: DayTally[];
  symptoms: SymptomEvent[];
  symptomLabels: Map<string, { en: string; hi: string }>;
};

export default function TrendsScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const { formatDate } = useDateFormat();
  const { width: windowWidth } = useWindowDimensions();

  const [periodDays, setPeriodDays] = useState<PeriodDays>(30);
  const profile = useProfileId();
  const profileId = profile.data;

  const trends = useAsync<TrendData | null>(async () => {
    if (!profileId) return null;
    const toDate = toLocalDate();
    const fromDate = addDays(toDate, -(periodDays - 1));
    const range = { fromDate, toDate };

    const [bp, sugar, weight, targets, days, symptoms, defs] = await Promise.all([
      listReadings(profileId, METRIC_BP, range),
      listReadings(profileId, METRIC_SUGAR, range),
      listReadings(profileId, METRIC_WEIGHT, range),
      listTargets(profileId),
      buildDayTallies(profileId, periodDays),
      listSymptomEvents(profileId, range),
      listSymptomDefs(),
    ]);

    const symptomLabels = new Map<string, { en: string; hi: string }>();
    for (const def of defs) symptomLabels.set(def.key, { en: def.labelEn, hi: def.labelHi });

    return { bp, sugar, weight, targets, days, symptoms, symptomLabels };
  }, [profileId, periodDays]);

  useReloadOnFocus(trends.reload);

  /**
   * The y-axis gutter, sized to the text actually being rendered. Roughly four
   * characters of the axis font: `fontSizes.xs` is 13 at the base scale, which lands
   * on the 44dp this screen has always used, and grows with large-text mode instead
   * of letting the numbers collide with the plot.
   */
  const yAxisLabelWidth = Math.max(Y_AXIS_LABEL_WIDTH_MIN, Math.round(fontSizes.xs * 3.4));

  /**
   * The drawable width of a chart body. Charts must never scroll sideways, so the
   * body is sized to what is already on screen and `disableScroll` is set on every
   * one of them — a chart the user has to drag is a chart she will never see the
   * right-hand half of.
   *
   * The `Number.isFinite` guard is not defensive decoration: `Math.max(160, NaN)` is
   * NaN, so without it a single bad frame from `useWindowDimensions` would be laundered
   * through the floor and into every geometry calculation below.
   */
  const usableWindowWidth =
    Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : FALLBACK_WINDOW_WIDTH;
  const chartWidth = Math.max(
    MIN_CHART_WIDTH,
    usableWindowWidth - spacing.lg * 2 - spacing.lg * 2 - yAxisLabelWidth - spacing.md,
  );

  const axisTextStyle = { color: colors.textMuted, fontSize: fontSizes.xs };

  const bpTargets = useMemo(
    () => ({
      systolic: matchTarget(trends.data?.targets ?? [], METRIC_BP, 'v1', null),
      diastolic: matchTarget(trends.data?.targets ?? [], METRIC_BP, 'v2', null),
    }),
    [trends.data],
  );
  // Deliberately the CONTEXT-FREE glucose target. A fasting-only band drawn beneath
  // after-meal marks is a wrong line under a real decision.
  const sugarTarget = useMemo(
    () => matchTarget(trends.data?.targets ?? [], METRIC_SUGAR, 'v1', null),
    [trends.data],
  );
  const weightTarget = useMemo(
    () => matchTarget(trends.data?.targets ?? [], METRIC_WEIGHT, 'v1', null),
    [trends.data],
  );

  // ── Pre-aggregation. Every series is capped and memoised: a chart that recomputes
  //    on each render is the thing that makes this screen stutter on a Go-class phone.
  //    Target bounds go into the axis calculation so a band can never fall off the top
  //    of its own chart and quietly disappear.
  const bpSeries = useMemo(
    () => buildBpSeries(trends.data?.bp ?? [], bounds([bpTargets.systolic, bpTargets.diastolic])),
    [trends.data, bpTargets],
  );
  // The LO/HI letters are drawn in the series' own colour and at the axis text size:
  // colour carries nothing here (the letters do), and matching the axis is what keeps
  // them legible when the OS font scale is at 1.3× and the app's large-text mode is on.
  const sugarCensoredStyle = useMemo(
    () => ({ color: colors.series[3] ?? colors.primary, fontSize: fontSizes.xs }),
    [colors, fontSizes],
  );
  const weightCensoredStyle = useMemo(
    () => ({ color: colors.series[5] ?? colors.primary, fontSize: fontSizes.xs }),
    [colors, fontSizes],
  );
  const sugarSeries = useMemo(
    () => buildSugarSeries(trends.data?.sugar ?? [], bounds([sugarTarget]), sugarCensoredStyle),
    [trends.data, sugarTarget, sugarCensoredStyle],
  );
  const weightSeries = useMemo(
    () => buildWeightSeries(trends.data?.weight ?? [], bounds([weightTarget]), weightCensoredStyle),
    [trends.data, weightTarget, weightCensoredStyle],
  );
  const adherence = useMemo(
    () => summariseAdherence(trends.data?.days ?? [], periodDays),
    [trends.data, periodDays],
  );
  const silentRun = useMemo(() => longestNoRecordRun(trends.data?.days ?? []), [trends.data]);
  const symptomTop = useMemo(
    () => buildSymptomTop(trends.data?.symptoms ?? [], trends.data?.symptomLabels, lang),
    [trends.data, lang],
  );
  const barColor = colors.series[0] ?? colors.primary;
  const symptomColor = colors.series[2] ?? colors.accent;

  const adherenceChart = useMemo(() => {
    const days = capSeries(trends.data?.days ?? [], 90);
    // The geometry is fitted to the space INSIDE the two edge paddings, because the
    // library's own total is `initialSpacing + endSpacing + n × (barWidth + spacing)`.
    // Fit only the bars and the last few days fall off the right-hand edge of a chart
    // that cannot be scrolled to reach them.
    const geometry = barGeometry(days.length, chartWidth - ADHERENCE_EDGE * 2);
    const bars: barDataItem[] = days.map((day) => ({
      value: day.recordedTaken,
      frontColor: barColor,
      barWidth: geometry.barWidth,
    }));
    return {
      bars,
      geometry,
      axis: buildAxis(days.map((day) => day.recordedTaken)),
      silentDays: silentDayCount(trends.data?.days ?? []),
      hasDays: (trends.data?.days.length ?? 0) > 0,
    };
  }, [trends.data, chartWidth, barColor]);

  const symptomChart = useMemo(() => {
    const labelWidth = Math.round(fontSizes.xs * 8.5);
    return {
      bars: symptomTop.map<barDataItem>((entry) => ({
        value: entry.count,
        label: entry.label,
        frontColor: symptomColor,
      })),
      axis: buildAxis(symptomTop.map((entry) => entry.count)),
      /** Room for the symptom name beside its bar, in the text size actually rendered. */
      labelWidth,
      geometry: symptomGeometry(
        symptomTop.length,
        chartWidth - yAxisLabelWidth,
        fontSizes.xs,
      ),
      /** In horizontal mode this is the VALUE axis — see the chart below. */
      valueAxis: Math.max(120, chartWidth - labelWidth - spacing.md),
    };
  }, [symptomTop, symptomColor, chartWidth, yAxisLabelWidth, fontSizes]);

  const seriesColor = (index: number): string => colors.series[index] ?? colors.primary;

  const renderReferenceLines = (targets: (TargetRange | null)[], labels: string[]) => {
    const lines = referenceLines(targets, labels);
    const [one, two, three] = lines;
    return {
      showReferenceLine1: Boolean(one),
      referenceLine1Position: one?.position ?? 0,
      referenceLine1Config: one
        ? { color: colors.borderStrong, thickness: 2, labelText: one.label, labelTextStyle: axisTextStyle }
        : undefined,
      showReferenceLine2: Boolean(two),
      referenceLine2Position: two?.position ?? 0,
      referenceLine2Config: two
        ? { color: colors.borderStrong, thickness: 2, labelText: two.label, labelTextStyle: axisTextStyle }
        : undefined,
      showReferenceLine3: Boolean(three),
      referenceLine3Position: three?.position ?? 0,
      referenceLine3Config: three
        ? { color: colors.borderStrong, thickness: 2, labelText: three.label, labelTextStyle: axisTextStyle }
        : undefined,
    };
  };

  /**
   * The one sentence a TalkBack user gets for a chart.
   *
   * It has to carry the LO/HI counts itself. `ChartCard` wraps the chart AND its captions
   * in a single `accessible` block, which collapses every descendant into this one label
   * — so a caption that explains the marks is not read out, and a summary that counts
   * only the measurements would tell a blind reader the period was empty when it was not.
   */
  const chartA11y = (title: string, measured: number, censored: CensoredCaption): string =>
    censored.drawn + censored.undrawable > 0
      ? t('trends.a11yChartWithCensored', {
          title,
          count: measured,
          censored: censored.drawn + censored.undrawable,
          days: periodDays,
        })
      : t('trends.a11yChart', { title, count: measured, days: periodDays });

  const targetNote = (targets: (TargetRange | null)[]): string[] => {
    const notes: string[] = [];
    for (const target of targets) {
      const note = targetFootnote(t, target, formatDate);
      if (note && !notes.includes(note)) notes.push(note);
    }
    return notes;
  };

  const loading = profile.loading || trends.loading;

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('trends.title')} subtitle={t('trends.subtitle')} />

      <View style={{ gap: spacing.sm, paddingBottom: spacing.lg }}>
        <Text variant="label">{t('trends.period')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {PERIODS.map((days) => (
            <Chip
              key={days}
              label={t(PERIOD_KEYS[days])}
              selected={days === periodDays}
              selectionMode="single"
              grow
              onPress={() => setPeriodDays(days)}
            />
          ))}
        </View>
      </View>

      {loading ? (
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={CHART_HEIGHT} label={t('a11y.loading')} />
          <Skeleton height={CHART_HEIGHT} />
          <Skeleton height={CHART_HEIGHT} />
        </View>
      ) : trends.error ? (
        <EmptyState title={t('errors.loadFailed')} message={t('errors.tryAgain')} icon="alert" />
      ) : (
        <View style={{ gap: spacing.lg }}>
          {/* ── Blood pressure ────────────────────────────────────────────── */}
          <ChartCard
            logTag="trends/bp"
            resetKey={periodDays}
            title={t('entry.bp.title')}
            a11yLabel={chartA11y(t('entry.bp.title'), bpSeries.systolic.length, bpSeries.censored)}
          >
            {bpSeries.systolic.length === 0 && bpSeries.censored.undrawable === 0 ? (
              <EmptyState title={t('trends.bp.empty')} message={t('trends.bp.emptyMessage')} />
            ) : bpSeries.systolic.length === 0 ? (
              <>
                <EmptyState
                  title={t('trends.censored.onlyCensoredTitle')}
                  message={t('trends.censored.onlyCensored')}
                />
                <CensoredNotes censored={bpSeries.censored} unit={metricUnit(null, METRIC_BP)} />
              </>
            ) : (
              <>
                <LineChart
                  data={bpSeries.systolic}
                  data2={bpSeries.diastolic}
                  height={CHART_HEIGHT}
                  width={chartWidth}
                  adjustToWidth
                  disableScroll
                  isAnimated={false}
                  // Zero thickness AND a stroke painted in the card's own background:
                  // two independent reasons no line can appear between two readings.
                  thickness={0}
                  thickness2={0}
                  color={colors.bgElevated}
                  color2={colors.bgElevated}
                  backgroundColor={colors.bgElevated}
                  dataPointsWidth={MARKER}
                  dataPointsHeight={MARKER}
                  dataPointsRadius={MARKER / 2}
                  dataPointsColor={seriesColor(0)}
                  dataPointsColor2={seriesColor(1)}
                  maxValue={bpSeries.axis.maxValue}
                  stepValue={bpSeries.axis.stepValue}
                  noOfSections={bpSeries.axis.noOfSections}
                  yAxisLabelWidth={yAxisLabelWidth}
                  yAxisTextStyle={axisTextStyle}
                  xAxisLabelTextStyle={axisTextStyle}
                  yAxisColor={colors.border}
                  xAxisColor={colors.border}
                  rulesColor={colors.border}
                  initialSpacing={spacing.md}
                  endSpacing={spacing.md}
                  {...renderReferenceLines(
                    [bpTargets.systolic, bpTargets.diastolic],
                    [t('entry.bp.systolic'), t('entry.bp.diastolic')],
                  )}
                />
                {/* Upper and lower are separated by POSITION first — the systolic band
                    always sits above the diastolic one — so the two colours here are
                    reinforcement, not the thing carrying the distinction. Shape is
                    already spent on morning vs evening, which genuinely interleaves. */}
                <SeriesKey
                  entries={[
                    { color: seriesColor(0), label: t('entry.bp.systolic') },
                    { color: seriesColor(1), label: t('entry.bp.diastolic') },
                  ]}
                />
                <ChartCaption text={t('trends.bp.caption', { days: periodDays })} />
                <ChartCaption text={t('trends.bp.legendMorning')} />
                <ChartCaption text={t('trends.bp.legendEvening')} />
                <ChartCaption text={t('trends.bp.notJoined')} />
                <CensoredNotes censored={bpSeries.censored} unit={metricUnit(null, METRIC_BP)} />
                <TargetLines
                  notes={targetNote([bpTargets.systolic, bpTargets.diastolic])}
                  fallback={t('trends.noTargetLine')}
                />
              </>
            )}
          </ChartCard>

          {/* ── Blood sugar ───────────────────────────────────────────────── */}
          <ChartCard
            logTag="trends/sugar"
            resetKey={periodDays}
            title={t('entry.sugar.title')}
            // The spoken summary counts BOTH kinds. It used to announce "a chart of 0
            // recorded points" over a period holding a hypoglycaemic reading, which is
            // the same false statement the empty state was making, in the one channel a
            // reader who cannot see the chart is entirely dependent on.
            a11yLabel={chartA11y(
              t('entry.sugar.title'),
              sugarSeries.points.length - sugarSeries.censored.drawn,
              sugarSeries.censored,
            )}
          >
            {/* THE EMPTY STATE IS GATED ON THE RECORD, NOT ON THE CHART. It used to be
                `points.length === 0`, which is a post-filter count — so a period holding
                nothing but LO readings produced "No blood sugar recorded yet". That is
                the app asserting something false about her own record, on the screen she
                would open to check it. Three states now: nothing recorded, something
                recorded that cannot be drawn, and a chart. */}
            {sugarSeries.points.length === 0 && sugarSeries.censored.undrawable === 0 ? (
              <EmptyState title={t('trends.sugar.empty')} message={t('trends.sugar.emptyMessage')} />
            ) : sugarSeries.points.length === 0 ? (
              <>
                <EmptyState
                  title={t('trends.censored.onlyCensoredTitle')}
                  message={t('trends.censored.onlyCensored')}
                />
                <CensoredNotes
                  censored={sugarSeries.censored}
                  unit={metricUnit(null, METRIC_SUGAR)}
                />
              </>
            ) : (
              <>
                <LineChart
                  data={sugarSeries.points}
                  height={CHART_HEIGHT}
                  width={chartWidth}
                  adjustToWidth
                  disableScroll
                  isAnimated={false}
                  thickness={0}
                  color={colors.bgElevated}
                  backgroundColor={colors.bgElevated}
                  dataPointsWidth={MARKER}
                  dataPointsHeight={MARKER}
                  dataPointsRadius={MARKER / 2}
                  dataPointsColor={seriesColor(3)}
                  maxValue={sugarSeries.axis.maxValue}
                  stepValue={sugarSeries.axis.stepValue}
                  noOfSections={sugarSeries.axis.noOfSections}
                  yAxisLabelWidth={yAxisLabelWidth}
                  yAxisTextStyle={axisTextStyle}
                  xAxisLabelTextStyle={axisTextStyle}
                  yAxisColor={colors.border}
                  xAxisColor={colors.border}
                  rulesColor={colors.border}
                  initialSpacing={spacing.md}
                  endSpacing={spacing.md}
                  {...renderReferenceLines([sugarTarget], [t('entry.sugar.value')])}
                />
                <ChartCaption text={t('trends.sugar.caption', { days: periodDays })} />
                <ChartCaption text={t('trends.sugar.legendFasting')} />
                <ChartCaption text={t('trends.sugar.legendOther')} />
                <ChartCaption text={t('trends.sugar.notJoined')} />
                <CensoredNotes
                  censored={sugarSeries.censored}
                  unit={metricUnit(null, METRIC_SUGAR)}
                />
                <TargetLines notes={targetNote([sugarTarget])} fallback={t('trends.noTargetLine')} />
              </>
            )}
          </ChartCard>

          {/* ── Reminder record ───────────────────────────────────────────── */}
          <ChartCard
            logTag="trends/adherence"
            resetKey={periodDays}
            title={t('trends.adherence.title')}
            a11yLabel={t('trends.a11yChart', {
              title: t('trends.adherence.title'),
              count: adherence.due,
              days: periodDays,
            })}
          >
            {/* `due` counts only doses whose moment has already passed. Zero means
                there is genuinely nothing to draw, whether she has no medicines yet or
                today's doses simply have not come round. */}
            {!adherenceChart.hasDays || adherence.due === 0 ? (
              <EmptyState
                title={t('trends.adherence.empty')}
                message={t('trends.adherence.emptyMessage')}
              />
            ) : (
              <>
                <BarChart
                  data={adherenceChart.bars}
                  height={CHART_HEIGHT}
                  width={chartWidth}
                  disableScroll
                  isAnimated={false}
                  barWidth={adherenceChart.geometry.barWidth}
                  spacing={adherenceChart.geometry.spacing}
                  initialSpacing={ADHERENCE_EDGE}
                  endSpacing={ADHERENCE_EDGE}
                  frontColor={barColor}
                  maxValue={adherenceChart.axis.maxValue}
                  stepValue={adherenceChart.axis.stepValue}
                  noOfSections={adherenceChart.axis.noOfSections}
                  // A dose is a whole thing. Left alone the library switches to one
                  // decimal place whenever the spread is 1 or less — which is exactly
                  // the case where nothing was recorded as taken, so the axis would
                  // read "0.0, 1.0" on the emptiest chart this screen can draw.
                  showFractionalValues={false}
                  yAxisLabelWidth={yAxisLabelWidth}
                  yAxisTextStyle={axisTextStyle}
                  xAxisLabelTextStyle={axisTextStyle}
                  yAxisColor={colors.border}
                  xAxisColor={colors.border}
                  rulesColor={colors.border}
                  backgroundColor={colors.bgElevated}
                />
                <Text variant="caption" tone="muted" style={{ paddingTop: spacing.sm }}>
                  {t('trends.adherence.axis')}
                </Text>
                <ChartCaption text={t('trends.adherence.caption', { days: periodDays })} />

                {/* The percentage is stated in words or refused in words. `summariseAdherence`
                    returns percent === null when the record has a three-day hole in it, and a
                    bar chart that implied a number the app has just refused to state would be
                    the same lie drawn instead of written. */}
                {adherence.percent === null ? (
                  <ChartCaption
                    text={t('reminders.adherence.suppressedReason', {
                      count: silentRun?.days ?? adherence.longestNoRecordRun,
                    })}
                  />
                ) : (
                  <ChartCaption
                    text={t('trends.adherence.percent', {
                      taken: adherence.recordedTaken,
                      due: adherence.due,
                    })}
                  />
                )}

                {adherenceChart.silentDays > 0 ? (
                  <ChartCaption
                    text={t('trends.adherence.silentDays', { count: adherenceChart.silentDays })}
                  />
                ) : null}

                <ChartCaption text={t('reminders.adherence.explain')} />
                {/* The canonical English sentence that travels onto the doctor-facing
                    report and every export. It is shown here as well so the wording the
                    patient sees and the wording her doctor reads can never drift apart. */}
                <Text variant="caption" tone="muted" style={{ fontSize: fontSizes.xs }}>
                  {adherenceDisclaimer()}
                </Text>
              </>
            )}
          </ChartCard>

          {/* ── Weight ────────────────────────────────────────────────────── */}
          <ChartCard
            logTag="trends/weight"
            resetKey={periodDays}
            title={t('entry.weight.title')}
            a11yLabel={chartA11y(
              t('entry.weight.title'),
              weightSeries.points.length - weightSeries.censored.drawn,
              weightSeries.censored,
            )}
          >
            {weightSeries.points.length === 0 && weightSeries.censored.undrawable === 0 ? (
              <EmptyState
                title={t('trends.weight.empty')}
                message={t('trends.weight.emptyMessage')}
              />
            ) : weightSeries.points.length === 0 ? (
              <>
                <EmptyState
                  title={t('trends.censored.onlyCensoredTitle')}
                  message={t('trends.censored.onlyCensored')}
                />
                <CensoredNotes
                  censored={weightSeries.censored}
                  unit={metricUnit(null, METRIC_WEIGHT)}
                />
              </>
            ) : (
              <>
                {/* The one metric where a line is honest: consecutive weights ARE points
                    on one trajectory, measured the same way each time. */}
                <LineChart
                  data={weightSeries.points}
                  height={CHART_HEIGHT}
                  width={chartWidth}
                  adjustToWidth
                  disableScroll
                  isAnimated={false}
                  thickness={3}
                  color={seriesColor(5)}
                  backgroundColor={colors.bgElevated}
                  dataPointsWidth={MARKER}
                  dataPointsHeight={MARKER}
                  dataPointsRadius={MARKER / 2}
                  dataPointsColor={seriesColor(5)}
                  maxValue={weightSeries.axis.maxValue}
                  stepValue={weightSeries.axis.stepValue}
                  noOfSections={weightSeries.axis.noOfSections}
                  yAxisLabelWidth={yAxisLabelWidth}
                  yAxisTextStyle={axisTextStyle}
                  xAxisLabelTextStyle={axisTextStyle}
                  yAxisColor={colors.border}
                  xAxisColor={colors.border}
                  rulesColor={colors.border}
                  initialSpacing={spacing.md}
                  endSpacing={spacing.md}
                  {...renderReferenceLines([weightTarget], [t('entry.weight.value')])}
                />
                <ChartCaption text={t('trends.weight.caption', { days: periodDays })} />
                <ChartCaption text={t('trends.weight.zeroAxis')} />
                <CensoredNotes
                  censored={weightSeries.censored}
                  unit={metricUnit(null, METRIC_WEIGHT)}
                />
                <TargetLines notes={targetNote([weightTarget])} fallback={t('trends.noTargetLine')} />
              </>
            )}
          </ChartCard>

          {/* ── Symptoms ──────────────────────────────────────────────────── */}
          <ChartCard
            logTag="trends/symptoms"
            resetKey={periodDays}
            title={t('trends.symptoms.title')}
            a11yLabel={t('trends.a11yChart', {
              title: t('trends.symptoms.title'),
              count: trends.data?.symptoms.length ?? 0,
              days: periodDays,
            })}
          >
            {symptomTop.length === 0 ? (
              <EmptyState
                title={t('trends.symptoms.empty')}
                message={t('trends.symptoms.emptyMessage')}
              />
            ) : (
              <>
                {/* Horizontal, because a symptom name is a phrase and a phrase does not fit
                    under a vertical bar at this text size.

                    IN HORIZONTAL MODE THIS LIBRARY SWAPS THE TWO SIZE PROPS. Internally it
                    does `heightFromProps = horizontal ? props.width : props.height` and the
                    mirror image for width, then rotates the whole container 90°. So `width`
                    here is the VALUE axis (how far a bar can grow) and `height` is the span
                    the bars are laid out along. `symptomGeometry` computes that span as
                    exactly `edge + n × (bar + gap) + edge`, which is the same arithmetic the
                    library uses for its own `totalWidth` — when the two disagree the last
                    bar is drawn outside a chart that cannot be scrolled to reach it. */}
                <BarChart
                  horizontal
                  data={symptomChart.bars}
                  width={symptomChart.valueAxis}
                  height={symptomChart.geometry.span}
                  barWidth={symptomChart.geometry.barWidth}
                  spacing={symptomChart.geometry.gap}
                  initialSpacing={symptomChart.geometry.edge}
                  endSpacing={symptomChart.geometry.edge}
                  disableScroll
                  isAnimated={false}
                  frontColor={symptomColor}
                  labelWidth={symptomChart.labelWidth}
                  yAxisLabelWidth={yAxisLabelWidth}
                  xAxisLabelTextStyle={axisTextStyle}
                  yAxisTextStyle={axisTextStyle}
                  yAxisColor={colors.border}
                  xAxisColor={colors.border}
                  rulesColor={colors.border}
                  backgroundColor={colors.bgElevated}
                  // The count is drawn PAST the end of the bar, so the axis has to leave
                  // room beyond the longest one — see `buildAxis`, which adds a band when
                  // the top of the scale would otherwise land exactly on the largest value.
                  showValuesAsTopLabel
                  intactTopLabel
                  topLabelTextStyle={axisTextStyle}
                  // "Reported 1.0 times" is a number that has to be decoded before it can
                  // be read. A report is a whole thing, like a dose.
                  showFractionalValues={false}
                  maxValue={symptomChart.axis.maxValue}
                  stepValue={symptomChart.axis.stepValue}
                  noOfSections={symptomChart.axis.noOfSections}
                />
                <ChartCaption text={t('trends.symptoms.caption', { days: periodDays })} />
                <ChartCaption text={t('trends.symptoms.onlySix')} />
              </>
            )}
          </ChartCard>
        </View>
      )}
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Small presentational pieces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One card, one chart, ONE ERROR BOUNDARY.
 *
 * The boundary is per card and not around the screen on purpose. Five of these six
 * charts have nothing to do with each other; a library that cannot draw a horizontal
 * bar has no business taking the blood pressure scatter down with it, and the
 * reminder record — the one chart that is genuinely about whether she is taking her
 * medicines — must survive whatever the other five do.
 *
 * The boundary sits OUTSIDE the `accessible` wrapper deliberately. That wrapper
 * collapses everything inside it into a single TalkBack stop with a fixed label
 * ("a chart of 14 recorded points"), which would be both wrong and unescapable after
 * a failure: the label would still describe a chart that is not there, and the "Try
 * again" button inside it would never receive focus.
 */
function ChartCard({
  title,
  a11yLabel,
  logTag,
  resetKey,
  children,
}: {
  title: string;
  a11yLabel: string;
  /** Console prefix identifying which chart failed. Not user-facing. */
  logTag: string;
  /** Clears a caught error when the period changes — new data, new chance. */
  resetKey: string | number;
  children: React.ReactNode;
}) {
  const t = useT(STRINGS);
  return (
    <Card>
      <Text variant="label" accessibilityRole="header">
        {title}
      </Text>
      <ErrorBoundary
        logTag={logTag}
        resetKey={resetKey}
        title={t('trends.chartFailed')}
        message={t('trends.chartFailedMessage')}
        retryLabel={t('common.retry')}
      >
        {/* The SVG itself is unreadable to TalkBack, so the block carries one spoken
            summary and the captions below it carry the meaning in words. */}
        <View
          accessible
          accessibilityLabel={a11yLabel}
          style={{ paddingTop: spacing.md, gap: spacing.xs }}
        >
          {children}
        </View>
      </ErrorBoundary>
    </Card>
  );
}

function SeriesKey({ entries }: { entries: { color: string; label: string }[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingTop: spacing.sm }}>
      {entries.map((entry) => (
        <View
          key={entry.label}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
        >
          <View
            style={{
              width: MARKER,
              height: MARKER,
              borderRadius: MARKER / 2,
              backgroundColor: entry.color,
            }}
          />
          <Text variant="caption" tone="muted">
            {entry.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What a chart says about the readings whose meter printed a word instead of a number.
 *
 * TWO SEPARATE FACTS, AND NEITHER MAY BE LEFT OUT:
 *
 *  • Marks that ARE on the chart. A reader who sees "LO" sitting at 20 has to be told
 *    that 20 is where the meter stopped reading and not something it measured. Without
 *    this line the drawing is a nicer-looking version of the same lie.
 *
 *  • Readings that are NOT on the chart, because no meter range has been recorded and
 *    there is nowhere honest to put them. Counting them out loud is what stops the
 *    screen implying the period was quieter than it was.
 *
 * Nothing here says anything about her. Every sentence is about the instrument.
 */
function CensoredNotes({ censored, unit }: { censored: CensoredCaption; unit: string }) {
  const t = useT(STRINGS);
  if (censored.drawn === 0 && censored.undrawable === 0) return null;

  const boundText = censored.bounds
    .map((bound) => `${trimNumber(bound)}${unit ? ` ${unit}` : ''}`)
    .join(' / ');

  return (
    <>
      {censored.drawn > 0 ? (
        <>
          <ChartCaption text={t('trends.censored.legend', { bound: boundText })} />
          <ChartCaption text={t('trends.censored.notAValue')} />
        </>
      ) : null}
      {censored.undrawable > 0 ? (
        <ChartCaption
          text={t(
            censored.undrawable === 1 ? 'trends.censored.noRange' : 'trends.censored.noRangePlural',
            { count: censored.undrawable },
          )}
        />
      ) : null}
    </>
  );
}

/**
 * The provenance line under a chart that has a band — or the sentence that says there
 * is no band. A comparison with nobody's name against it is the app issuing advice.
 */
function TargetLines({ notes, fallback }: { notes: string[]; fallback: string }) {
  if (notes.length === 0) return <ChartCaption text={fallback} />;
  return (
    <>
      {notes.map((note) => (
        <ChartCaption key={note} text={note} />
      ))}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pure series building
// ═══════════════════════════════════════════════════════════════════════════════

/* ── @axis-block:start ──────────────────────────────────────────────────────────
   Everything between these two markers is lifted verbatim by
   `src/app/(tabs)/trends.test.ts` and executed there — see that file's header for
   why it cannot simply import this one. Keep the region SELF-CONTAINED: no imports,
   and no reference to anything declared outside the markers. */

type Axis = { maxValue: number; stepValue: number; noOfSections: number };

/**
 * Bands on the value axis. Four labelled gridlines is about what a 200dp chart can
 * show at this text size before the numbers start touching each other.
 */
const AXIS_SECTIONS = 4;

/**
 * The largest peak the axis arithmetic will entertain, and the reason is overflow,
 * not plausibility. `stepValue * noOfSections` on a peak near Number.MAX_VALUE is
 * Infinity, and an Infinity maxValue divides every plotted point into NaN. A trillion
 * is many orders of magnitude past any reading a glucometer or a bathroom scale can
 * produce, so clamping here cannot hide real data; it only refuses to let a corrupt
 * row take the chart with it.
 */
const AXIS_PEAK_CEILING = 1e12;

/**
 * A zero-based axis with a round step.
 *
 * Zero-based on purpose. A truncated axis is the classic way to make a 0.4 kg wobble
 * look like a collapse, and this app is not allowed to make a reading look alarming.
 *
 * TWO PROPERTIES THIS FUNCTION GUARANTEES, because the chart library assumes both and
 * checks neither:
 *
 *  1. EVERY FIELD IS A FINITE, POSITIVE NUMBER. `Math.max(1, ...values)` returns NaN
 *     if a single value is NaN, and NaN propagates silently through stepValue and
 *     maxValue into the SVG coordinates. So values are filtered rather than spread —
 *     which also removes the argument-count limit that a spread of a long series
 *     carries. `stepValue` is never zero: the library divides by it.
 *
 *  2. THE TOP OF THE SCALE IS STRICTLY ABOVE THE LARGEST VALUE. `stepValue * 4` lands
 *     exactly on the peak whenever peak/4 is a round number — 4 reports of one
 *     symptom, 8 doses, a systolic of 120, all of which are ordinary. A mark sitting
 *     exactly on the top rule is drawn half outside the plot area, and the symptom
 *     chart's count label, which is drawn PAST the end of its bar, is cut off
 *     entirely. One extra band costs a little vertical scale and fixes both.
 */
function buildAxis(values: readonly number[], extra: readonly number[] = []): Axis {
  let peak = 1;
  for (const value of values) if (Number.isFinite(value) && value > peak) peak = value;
  for (const value of extra) if (Number.isFinite(value) && value > peak) peak = value;
  if (peak > AXIS_PEAK_CEILING) peak = AXIS_PEAK_CEILING;

  const rough = peak / AXIS_SECTIONS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  const stepValue = Math.max(1, Math.ceil(rough / magnitude) * magnitude);
  const noOfSections = stepValue * AXIS_SECTIONS <= peak ? AXIS_SECTIONS + 1 : AXIS_SECTIONS;

  return { maxValue: stepValue * noOfSections, stepValue, noOfSections };
}

/* ── @axis-block:end ────────────────────────────────────────────────────────── */

/** Readings come back newest-first; a chart reads left to right. */
function chronological(readings: readonly Reading[]): Reading[] {
  return [...readings].reverse();
}

/**
 * Whether a target bound can be drawn at all.
 *
 * A bound arrives from a row a human typed. Nothing downstream can plot a NaN, and a
 * zero or negative bound on a blood pressure, a glucose or a weight is not a quiet
 * "no target" — it is a row that means nothing, and drawing a line at it would put an
 * unexplained comparison under a real reading.
 *
 * The SAME predicate gates both the axis calculation and the reference lines. If they
 * ever disagreed, a bound would be drawn on a chart whose scale had never accounted
 * for it — a target line sitting off the top of its own chart.
 */
function drawableBound(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Every drawable bound of a set of targets, for the axis calculation. */
function bounds(targets: readonly (TargetRange | null)[]): number[] {
  const out: number[] = [];
  for (const target of targets) {
    if (!target) continue;
    if (drawableBound(target.low)) out.push(target.low);
    if (drawableBound(target.high)) out.push(target.high);
  }
  return out;
}

function buildBpSeries(
  readings: readonly Reading[],
  extra: number[],
): {
  systolic: lineDataItem[];
  diastolic: lineDataItem[];
  axis: Axis;
  censored: CensoredCaption;
} {
  // Both numbers or neither: the two series share one x position per index, and a
  // reading missing its lower number would silently shift every later diastolic mark
  // onto the wrong day.
  const usable = chronological(readings).filter((r) => r.v1 !== null && r.v2 !== null);
  const capped = capSeries(usable, 90);
  // A cuff has no LO/HI, so there is no entry path that produces one and none of these
  // should ever exist. They are COUNTED anyway, because the pair-completeness filter
  // above would swallow one without a word — and a reading that cannot be drawn must
  // still be declared. Two numbers are needed to draw one mark here, so there is no
  // single limit to draw it at even if a range were recorded; it goes in the undrawable
  // bucket and the caption says so.
  const censoredBp = readings.filter((r) => r.valueQualifier !== 'exact').length;

  const systolic: lineDataItem[] = [];
  const diastolic: lineDataItem[] = [];
  // BOTH series feed the axis. Scaling to the upper number alone assumes the lower one
  // is always smaller, which is true of a healthy pair and not true of a mis-keyed one
  // — and a mis-keyed 140 in the lower field would be plotted off the top of the chart,
  // where the reader cannot see the thing that would tell her it was mis-keyed.
  const scale: number[] = [];
  for (const reading of capped) {
    // SHAPE, not colour, carries morning vs evening — see the file header.
    const shape = isMorningReading(reading.localTime) ? 'circular' : 'rectangular';
    systolic.push({ value: reading.v1 ?? 0, dataPointShape: shape });
    diastolic.push({ value: reading.v2 ?? 0, dataPointShape: shape });
    scale.push(reading.v1 ?? 0, reading.v2 ?? 0);
  }

  return {
    systolic,
    diastolic,
    axis: buildAxis(scale, extra),
    censored: { drawn: 0, undrawable: censoredBp, bounds: [] },
  };
}

/** Contexts measured away from food. These get the square marker. */
const FASTING_CONTEXTS = new Set(['fasting', 'before_meal']);

/**
 * How a LO/HI mark is drawn, and why it is drawn with letters.
 *
 * `react-native-gifted-charts` offers exactly two data-point shapes, and this screen has
 * already spent both — square versus round carries fasting versus not, and morning versus
 * evening on the blood pressure chart. There is no third shape to reach for.
 *
 * `dataPointText` renders a real `react-native-svg` `<Text>` at the point, so the mark can
 * be the two letters the meter itself displayed. That is better than a third shape would
 * have been: LO needs no legend to decode, it survives greyscale and colour deficiency,
 * and it is the word she read off the device — the app is not inventing a symbol for her
 * reading, it is repeating what the machine said.
 *
 * The point itself is made invisible (radius 0, transparent fill) rather than hidden with
 * `hideDataPoint`, which suppresses the text along with the mark.
 *
 * THE TWO SHIFTS ARE NOT MAGIC NUMBERS. The library places the text at
 * `x = pointCentre − dataPointsWidth + textShiftX` and `y = pointCentre − dataPointsHeight/2
 * + textShiftY`, where the width and height are the marker box (MARKER, 12dp) and `y` is
 * an SVG BASELINE rather than a centre. So centring two characters of roughly 13dp needs
 * `+MARKER/2` horizontally, and sitting the baseline on the point needs `+MARKER/2` plus
 * about a third of the cap height vertically. Both are approximations of a text metric the
 * layer cannot measure; being a pixel out is invisible, being unlabelled is not.
 */
const CENSORED_TEXT_SHIFT_X = MARKER / 2;
const CENSORED_TEXT_SHIFT_Y = MARKER / 2 + 4;

type CensoredStyle = { color: string; fontSize: number };

function censoredItem(
  bound: number,
  direction: 'below' | 'above',
  style: CensoredStyle,
): lineDataItem {
  return {
    // The meter's limit is the POSITION of the mark and nothing else. It is not joined
    // into a line (every chart that draws these has `thickness={0}`), it is not counted
    // as a measurement anywhere, and the two letters drawn over it say what it is.
    value: bound,
    dataPointShape: 'circular',
    dataPointRadius: 0,
    dataPointColor: 'transparent',
    dataPointText: direction === 'below' ? 'LO' : 'HI',
    textColor: style.color,
    textFontSize: style.fontSize,
    textShiftX: CENSORED_TEXT_SHIFT_X,
    textShiftY: CENSORED_TEXT_SHIFT_Y,
  };
}

/** What a caption has to be able to say about a series, over and above its marks. */
type CensoredCaption = {
  /** LO/HI marks actually drawn, at a meter limit. */
  drawn: number;
  /**
   * LO/HI readings with no recorded meter range, so nothing could be drawn for them.
   *
   * This is the number that decides whether a chart with no marks on it is EMPTY or
   * merely UNDRAWABLE, and the two get different sentences. It is deliberately not "every
   * reading that failed to become a mark": a blood pressure missing its lower number is
   * an incomplete row, not a meter refusing to read, and telling her the meter showed LO
   * when it did not is the same class of false statement in the opposite direction.
   */
  undrawable: number;
  /** The distinct meter limits drawn at. Usually one; two after a change of meter. */
  bounds: number[];
};

function summarise<T>(plan: SeriesPlan<T>): CensoredCaption {
  return { drawn: plan.censoredCount, undrawable: plan.undrawableCount, bounds: planBounds(plan) };
}

function buildSugarSeries(
  readings: readonly Reading[],
  extra: number[],
  style: CensoredStyle,
): { points: lineDataItem[]; axis: Axis; censored: CensoredCaption } {
  const plan = capPlan(planSeries(chronological(readings)), 90, capSeries);

  const points: lineDataItem[] = plan.entries.map((entry) => {
    if (entry.kind === 'censored') return censoredItem(entry.value, entry.direction, style);
    const meal = entry.reading.context?.['meal'];
    return {
      value: entry.value,
      dataPointShape: meal && FASTING_CONTEXTS.has(meal) ? 'rectangular' : 'circular',
    };
  });

  return { points, axis: buildAxis(plan.scaleValues, extra), censored: summarise(plan) };
}

function buildWeightSeries(
  readings: readonly Reading[],
  extra: number[],
  style: CensoredStyle,
): { points: lineDataItem[]; axis: Axis; censored: CensoredCaption } {
  // Weight has no LO/HI entry path today — a bathroom scale that cannot read prints
  // nothing rather than a word. It goes through the same planner anyway, because the
  // column exists on every reading, and a series builder that assumes its own metric can
  // never be censored is exactly the assumption that produced this class of bug on the
  // sugar chart. If one ever arrives it is marked, not drawn as a weight nobody stood for.
  const plan = capPlan(planSeries(chronological(readings)), 90, capSeries);
  const points: lineDataItem[] = plan.entries.map((entry) =>
    entry.kind === 'censored'
      ? censoredItem(entry.value, entry.direction, style)
      : { value: entry.value },
  );
  return { points, axis: buildAxis(plan.scaleValues, extra), censored: summarise(plan) };
}

/**
 * Days where doses were due and nothing at all was recorded either way.
 *
 * The caption that reports this number says exactly that and nothing more. The app was
 * told nothing about those days; it does not follow that nothing was taken on them.
 */
function silentDayCount(days: readonly DayTally[]): number {
  return days.filter((day) => !day.isAway && day.due > 0 && day.recordedTaken + day.recordedNotTaken === 0)
    .length;
}

/** The widest a single day's bar is allowed to get, so a 7-day chart is not five slabs. */
const BAR_MAX_WIDTH = 28;
/** Share of a slot given to the bar; the rest is the gap to the next one. */
const BAR_SHARE = 0.7;

/**
 * Bar and gap for the reminder-record chart, fitted to the room actually available.
 *
 * `room` is the space INSIDE the two edge paddings, because the library's own width is
 * `initialSpacing + endSpacing + n × (barWidth + spacing)`. The previous version floored
 * both numbers and imposed a 2dp minimum bar, which made 90 days add up to 270dp inside
 * a 200dp chart on a narrow phone: the last four weeks were laid out past the right-hand
 * edge of a chart that has `disableScroll` set, so they could not be reached at all.
 *
 * Fractional widths are deliberate. A 1.6dp bar is a hairline, but a hairline in the
 * right place beats a crisp bar in a place the user cannot scroll to.
 */
function barGeometry(count: number, room: number): { barWidth: number; spacing: number } {
  const bars = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
  const usable = Number.isFinite(room) && room > 0 ? room : bars;
  const slot = usable / bars;
  // Never wider than its own slot: that is what keeps the total inside `room` even
  // when the slot is narrower than the minimum a bar would like to be.
  const barWidth = Math.min(slot, Math.max(1, Math.min(BAR_MAX_WIDTH, slot * BAR_SHARE)));
  return { barWidth, spacing: Math.max(0, slot - barWidth) };
}

/** Six, not twelve. Twelve near-zero bars at this text size is an unreadable chart. */
const SYMPTOM_TOP_N = 6;

type SymptomGeometry = { edge: number; barWidth: number; gap: number; span: number };

/**
 * Bar thickness, gap and total span for the horizontal symptom chart.
 *
 * THREE THINGS ARE TRUE AT ONCE HERE, WHICH IS WHY IT IS NOT TWO CONSTANTS:
 *
 *  • The span this returns is the `height` prop, which the library reads as the width
 *    of the bar axis, and it is computed with the library's own formula. The previous
 *    `n × (bar + gap)` left out the two edge paddings that the library adds — 40dp of
 *    bars pushed off the end of a chart that cannot scroll.
 *
 *  • It scales with the text. `bar` and `gap` were 26 and 20, which are exactly 2× and
 *    1.5× the base axis font, so at the base scale nothing here moves. In large-text
 *    mode a 26dp bar next to a 17sp label is a bar thinner than its own name.
 *
 *  • It never exceeds the budget. The whole rotated container is laid out at
 *    `span + yAxisLabelWidth` wide before the transform, so an unbounded span overflows
 *    the card sideways. Six symptoms in large-text mode want 342dp of span and there is
 *    not that much on a 450dp screen, so the bars thin out instead of falling off.
 */
function symptomGeometry(count: number, budget: number, axisFontSize: number): SymptomGeometry {
  const bars = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
  const unit = Number.isFinite(axisFontSize) && axisFontSize > 0 ? axisFontSize : 13;
  const edge = spacing.md;
  const idealBar = Math.round(unit * 2);
  const idealGap = Math.round(unit * 1.5);

  const room = Math.max(bars, (Number.isFinite(budget) ? budget : 0) - edge * 2);
  const slot = Math.min(idealBar + idealGap, room / bars);
  // The GAP gives way before the bar does. A thin bar with a generous gap around it is
  // harder to see than a full-thickness bar sitting closer to its neighbour, and the bar
  // is the thing being read. `BAR_SHARE` is the same ceiling the day chart uses, so a
  // squeezed bar never grows to fill its whole slot and lose its separation entirely.
  const barWidth = Math.min(slot, Math.max(1, Math.min(idealBar, slot * BAR_SHARE)));
  const gap = Math.max(0, slot - barWidth);

  return { edge, barWidth, gap, span: edge * 2 + bars * (barWidth + gap) };
}

type SymptomCount = { label: string; count: number };

function buildSymptomTop(
  events: readonly SymptomEvent[],
  labels: Map<string, { en: string; hi: string }> | undefined,
  lang: 'en' | 'hi',
): SymptomCount[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const known = event.symptomKey ? labels?.get(event.symptomKey) : undefined;
    const label = known ? (lang === 'hi' ? known.hi : known.en) : (event.customLabel ?? event.symptomKey);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, SYMPTOM_TOP_N);
}

/**
 * Up to three horizontal reference lines, built ONLY from targets a named human
 * entered. Each line is labelled with the field and the bound it represents, so a
 * reader never has to guess which of two lines is which.
 */
function referenceLines(
  targets: readonly (TargetRange | null)[],
  labels: readonly string[],
): { position: number; label: string }[] {
  const lines: { position: number; label: string }[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;
    const label = labels[index] ?? '';
    // `drawableBound` — the same gate the axis used. A bound the axis ignored must not
    // reach the chart as a line, or it is drawn against a scale that never allowed for it.
    if (drawableBound(target.low)) lines.push({ position: target.low, label: `${label} ${target.low}` });
    if (drawableBound(target.high)) lines.push({ position: target.high, label: `${label} ${target.high}` });
  }
  return lines.slice(0, 3);
}
