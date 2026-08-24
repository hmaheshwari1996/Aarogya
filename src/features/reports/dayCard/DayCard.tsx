/**
 * The day card — one day of the record, as a 1080×1350 picture for WhatsApp.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT ON IT
 *
 * No prescription photo, no lab report photo, no address, no phone number. This image is
 * built to be FORWARDED: it will land in a family group, in someone's photo backup, and
 * possibly in a group that person is in that this patient has never heard of. Everything
 * on the card is something she would say out loud to the person she is sending it to.
 *
 * No badge, no streak, no encouragement. Those belong on her own screen. A card that says
 * "14 day streak!" beside a blood pressure turns a health record into a performance she
 * has to keep up in front of her children.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS ALWAYS THE LIGHT PALETTE
 *
 * The card leaves the phone. It must look the same to whoever receives it, print legibly
 * if a relative prints it, and survive WhatsApp's JPEG re-encode — all of which favour
 * dark ink on white. Rendering it in the device's dark theme would produce a different
 * artefact for two people who tapped the same button. Tokens, not raw hex, still: the
 * light palette is imported from the theme.
 *
 * Dose marks are SHAPES, not colours: a filled dot is a dose recorded as taken, a hollow
 * dot is one with nothing recorded, a barred dot is one recorded as not taken. The key at
 * the bottom spells all three out in words.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from 'react';
import { Image, Text, View, type ImageSourcePropType } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { lightColors, radii } from '@/theme';
import type { OccurrenceStatus } from '@/types';

import { formatDateLong, formatTime } from '../lib/format';
import type { DayCardData, DayCardReading } from '../data/types';

/** The output pixel size. 4:5 is the tallest aspect WhatsApp shows without cropping. */
export const DAY_CARD_PIXELS = { width: 1080, height: 1350 } as const;

/** The design is authored in this coordinate space and scaled to the render size. */
const DESIGN = { width: 360, height: 450 } as const;

export type DayCardLabels = {
  bloodPressure: string;
  bloodSugar: string;
  weight: string;
  medicines: string;
  symptoms: string;
  keyTaken: string;
  keyNotTaken: string;
  keyNoRecord: string;
  disclaimer: string;
  nothingRecorded: string;
};

export const DEFAULT_DAY_CARD_LABELS: DayCardLabels = {
  bloodPressure: 'Blood pressure',
  bloodSugar: 'Blood sugar',
  weight: 'Weight',
  medicines: 'Medicines',
  symptoms: 'How I felt',
  keyTaken: 'recorded as taken',
  keyNotTaken: 'recorded as not taken',
  keyNoRecord: 'not recorded as taken',
  disclaimer: 'Recorded in the Aarogya app. It shows what was recorded, not what was swallowed.',
  nothingRecorded: 'Nothing was recorded on this day.',
};

export type DayCardProps = {
  data: DayCardData;
  /** Logical width in dp. Height follows the 4:5 aspect. */
  width: number;
  height: number;
  labels?: Partial<DayCardLabels>;
  /**
   * Any image the card renders reports its readiness here, and the capture waits on all
   * of them. Today the card renders none — by the policy at the top of this file — so the
   * gate resolves immediately. The wiring exists because the card is one product decision
   * away from carrying one, and a capture that fires before an image has drawn produces a
   * blank rectangle where the image should be.
   */
  registerImage?: (ready: Promise<void>) => void;
};

const MAX_MEDICINE_ROWS = 6;
const MAX_READING_ROWS = 3;
const MAX_SYMPTOM_ROWS = 3;

export function DayCard({ data, width, height, labels, registerImage }: DayCardProps) {
  const text = { ...DEFAULT_DAY_CARD_LABELS, ...labels };
  const s = width / DESIGN.width;
  const style = useMemo(() => buildStyles(s), [s]);

  const isEmpty =
    data.bloodPressure.length === 0 &&
    data.bloodSugar.length === 0 &&
    data.weight === null &&
    data.doses.length === 0 &&
    data.symptoms.length === 0 &&
    data.otherReadings.length === 0;

  return (
    // collapsable={false} on EVERY wrapper. React Native collapses views that have no
    // drawing props of their own, and a container without a backing native view is the
    // classic cause of "Failed to snapshot view tag" — the tag exists in JS and there is
    // nothing on the Android side to draw.
    <View collapsable={false} style={[style.card, { width, height }]}>
      <View collapsable={false} style={style.header}>
        <Text style={style.name} numberOfLines={1}>
          {data.patientName}
        </Text>
        <Text style={style.date}>{formatDateLong(data.localDate)}</Text>
      </View>
      <View collapsable={false} style={style.rule} />

      <View collapsable={false} style={style.body}>
        {isEmpty ? <Text style={style.empty}>{text.nothingRecorded}</Text> : null}

        <ReadingBlock title={text.bloodPressure} entries={data.bloodPressure} style={style} />
        <ReadingBlock title={text.bloodSugar} entries={data.bloodSugar} style={style} />
        {data.weight ? <ReadingBlock title={text.weight} entries={[data.weight]} style={style} /> : null}
        {data.otherReadings.slice(0, 2).map((group) => (
          <ReadingBlock key={group.label} title={group.label} entries={group.entries} style={style} />
        ))}

        {data.doses.length > 0 ? (
          <View collapsable={false} style={style.block}>
            <Text style={style.blockTitle}>{text.medicines}</Text>
            {data.doses.slice(0, MAX_MEDICINE_ROWS).map((row) => (
              <View collapsable={false} key={row.threadId} style={style.doseRow}>
                <Text style={style.doseName} numberOfLines={1}>
                  {row.strength ? `${row.medicineName} ${row.strength}` : row.medicineName}
                </Text>
                <View collapsable={false} style={style.doseMarks}>
                  {row.marks.map((mark) => (
                    <View collapsable={false} key={`${row.threadId}-${mark.timeLocal}`} style={style.doseMark}>
                      <DoseDot state={mark.state} size={12 * s} />
                      <Text style={style.doseTime}>{formatTime(mark.timeLocal)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ))}
            {data.doses.length > MAX_MEDICINE_ROWS ? (
              <Text style={style.more}>{`+${data.doses.length - MAX_MEDICINE_ROWS} more`}</Text>
            ) : null}
          </View>
        ) : null}

        {data.symptoms.length > 0 ? (
          <View collapsable={false} style={style.block}>
            <Text style={style.blockTitle}>{text.symptoms}</Text>
            {data.symptoms.slice(0, MAX_SYMPTOM_ROWS).map((symptom, index) => (
              <View collapsable={false} key={`${symptom.localTime}-${index}`} style={style.entryRow}>
                <Text style={style.entryTime}>{formatTime(symptom.localTime)}</Text>
                <Text style={style.entryValue} numberOfLines={1}>
                  {symptom.severity ? `${symptom.label} (${symptom.severity})` : symptom.label}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View collapsable={false} style={style.footer}>
        {data.doses.length > 0 ? (
          <View collapsable={false} style={style.key}>
            <KeyItem state="taken" label={text.keyTaken} style={style} scale={s} />
            <KeyItem state="skipped" label={text.keyNotTaken} style={style} scale={s} />
            <KeyItem state="no_record" label={text.keyNoRecord} style={style} scale={s} />
          </View>
        ) : null}
        <Text style={style.disclaimer}>{text.disclaimer}</Text>
      </View>

      {/* No images today — see `registerImage` in the props docblock. */}
      {IMAGE_SOURCES.map((source, index) => (
        <Image
          key={`card-image-${index}`}
          source={source}
          style={style.hiddenImage}
          onLoad={() => registerImage?.(Promise.resolve())}
          onError={() => registerImage?.(Promise.resolve())}
        />
      ))}
    </View>
  );
}

/** Empty by policy. Adding a source here automatically enrols it in the capture gate. */
const IMAGE_SOURCES: ImageSourcePropType[] = [];

type Styles = ReturnType<typeof buildStyles>;

function ReadingBlock({
  title,
  entries,
  style,
}: {
  title: string;
  entries: readonly DayCardReading[];
  style: Styles;
}) {
  if (entries.length === 0) return null;
  return (
    <View collapsable={false} style={style.block}>
      <Text style={style.blockTitle}>{title}</Text>
      {entries.slice(0, MAX_READING_ROWS).map((entry, index) => (
        <View collapsable={false} key={`${entry.localTime}-${index}`} style={style.entryRow}>
          <Text style={style.entryTime}>{formatTime(entry.localTime)}</Text>
          <Text style={style.entryValue} numberOfLines={1}>
            {`${entry.text}${entry.unit ? ` ${entry.unit}` : ''}`}
            {entry.contextLabel ? ` — ${entry.contextLabel}` : ''}
          </Text>
        </View>
      ))}
      {entries.length > MAX_READING_ROWS ? (
        <Text style={style.more}>{`+${entries.length - MAX_READING_ROWS} more`}</Text>
      ) : null}
    </View>
  );
}

/**
 * The dose mark.
 *
 * Filled circle — recorded as taken.
 * Barred circle — recorded as not taken. A real decision she made.
 * Hollow circle — nothing recorded either way. NOT a failure, and never rendered as one.
 */
function DoseDot({ state, size }: { state: OccurrenceStatus; size: number }) {
  const r = size / 2 - 1;
  const c = size / 2;
  const filled = state === 'taken';
  const barred = state === 'skipped';

  return (
    <Svg width={size} height={size} collapsable={false}>
      <Circle
        cx={c}
        cy={c}
        r={r}
        fill={filled ? lightColors.text : lightColors.bgElevated}
        stroke={lightColors.text}
        strokeWidth={1.4}
      />
      {barred ? (
        <Line x1={c - r * 0.6} y1={c} x2={c + r * 0.6} y2={c} stroke={lightColors.text} strokeWidth={1.6} />
      ) : null}
    </Svg>
  );
}

function KeyItem({
  state,
  label,
  style,
  scale,
}: {
  state: OccurrenceStatus;
  label: string;
  style: Styles;
  scale: number;
}) {
  return (
    <View collapsable={false} style={style.keyItem}>
      <DoseDot state={state} size={9 * scale} />
      <Text style={style.keyLabel}>{label}</Text>
    </View>
  );
}

function buildStyles(s: number) {
  const pad = 18 * s;
  return {
    card: {
      backgroundColor: lightColors.bgElevated,
      paddingHorizontal: pad,
      paddingTop: pad,
      paddingBottom: 12 * s,
      justifyContent: 'flex-start' as const,
    },
    header: { flexDirection: 'row' as const, alignItems: 'baseline' as const, justifyContent: 'space-between' as const },
    name: { flex: 1, fontSize: 21 * s, fontWeight: '700' as const, color: lightColors.text },
    date: { fontSize: 12 * s, color: lightColors.textMuted, marginLeft: 8 * s },
    rule: { height: 2 * s, backgroundColor: lightColors.text, marginTop: 6 * s, marginBottom: 8 * s },
    body: { flex: 1 },
    block: { marginBottom: 9 * s },
    blockTitle: {
      fontSize: 11 * s,
      fontWeight: '700' as const,
      color: lightColors.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.6 * s,
      marginBottom: 3 * s,
    },
    entryRow: { flexDirection: 'row' as const, alignItems: 'baseline' as const, marginBottom: 2 * s },
    entryTime: {
      width: 42 * s,
      fontSize: 13 * s,
      color: lightColors.textMuted,
      // Times line up in a column, so a glance down the card reads as a timeline.
      fontVariant: ['tabular-nums' as const],
    },
    entryValue: { flex: 1, fontSize: 15 * s, fontWeight: '600' as const, color: lightColors.text },
    doseRow: { marginBottom: 6 * s },
    doseName: { fontSize: 13 * s, fontWeight: '600' as const, color: lightColors.text },
    doseMarks: { flexDirection: 'row' as const, marginTop: 2 * s },
    doseMark: { alignItems: 'center' as const, marginRight: 10 * s },
    doseTime: { fontSize: 9 * s, color: lightColors.textMuted, marginTop: 1 * s },
    more: { fontSize: 10 * s, color: lightColors.textMuted, marginTop: 1 * s },
    empty: { fontSize: 14 * s, color: lightColors.textMuted, marginBottom: 8 * s },
    footer: { borderTopWidth: 1, borderTopColor: lightColors.border, paddingTop: 6 * s },
    key: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, marginBottom: 3 * s },
    keyItem: { flexDirection: 'row' as const, alignItems: 'center' as const, marginRight: 10 * s },
    keyLabel: { fontSize: 9 * s, color: lightColors.textMuted, marginLeft: 3 * s },
    disclaimer: { fontSize: 9 * s, color: lightColors.textMuted, lineHeight: 12 * s },
    hiddenImage: { width: 0, height: 0, borderRadius: radii.sm },
  };
}

export default DayCard;
