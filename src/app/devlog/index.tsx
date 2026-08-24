/**
 * The on-device log — what her son reads instead of plugging in a cable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN EXISTS AT ALL
 *
 * He reported that prescription scanning "is not working" and asked for logs he could see
 * on the phone. He is right that it is unanswerable otherwise: `features/ai/errors.ts`
 * turns ten genuinely different failures — a key restricted to Android apps, a thinking
 * budget eaten before the first character of JSON, a free-tier allowance that is zero
 * rather than merely spent — into one calm sentence each, and the fact that would tell
 * them apart is built at the failure site and then dropped. This screen is where that
 * fact now goes.
 *
 * So the tone is deliberate. A log screen in a health app can read as an apology for a
 * broken thing, or as the app being able to account for itself. This one is the second:
 * plain nouns, no exclamation, no "oops", and every action it offers actually works.
 *
 * ─── WHAT IT IS ALLOWED TO PUT ON SCREEN ─────────────────────────────────────
 *
 * Whatever `features/devlog` gives it, and nothing else. That module's redactor is the
 * boundary — field names and counts go in, values do not — and this screen must not
 * become the place that quietly widens it. Concretely:
 *
 *   • It renders `entry.fields` as they arrive. It never reaches into the database, the
 *     prescription, the profile or the key store to "enrich" a line.
 *   • Copy and Share hand over `formatEntry`/`devLogShareText`, the same text the module
 *     already considers safe to leave the phone, rather than a second formatting of the
 *     raw objects.
 *   • The one thing this screen adds is the clock, and it adds it from `entry.ts`.
 *
 * ─── WHY DELETE LIVES HERE AND NOT ONLY IN SETTINGS ──────────────────────────
 *
 * Because this is where somebody decides they are finished. He asked for a delete button
 * so he can clean up after debugging; the moment that thought occurs is while he is
 * looking at the notes, not two screens away. The size sits next to the button for the
 * same reason — "Delete Logs" means nothing until you know whether it is reclaiming four
 * kilobytes or a quarter of a megabyte.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  devLogShareText,
  devLogStats,
  flushDevLog,
  formatEntry,
  isDevLogEnabled,
  listEntries,
  purgeDevLog,
  subscribeDevLog,
  type DevLogEntry,
} from '@/features/devlog';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { TranslateFn } from '@/i18n';

const STRINGS: LocalStrings = {
  'devlog.title': { en: 'App Logs', hi: 'ऐप के नोट' },
  // Said once, at the top, in the app's ordinary voice — because a screen full of
  // `ai.http status=429` is exactly the sort of thing that makes a person wonder what
  // else the phone has been writing down about them.
  'devlog.what': {
    en: 'Technical notes about how the app itself is working. They contain no medicines, no readings and no personal details.',
    hi: 'ये नोट सिर्फ़ यह बताते हैं कि ऐप अंदर से कैसे चल रहा है। इनमें न कोई दवाई है, न कोई माप, न कोई निजी जानकारी।',
  },
  // A separate key for exactly one note rather than "{{count}} note(s)". The first note in
  // a fresh reproduction is the single most likely count this screen ever shows — he turns
  // the switch on, runs the scan once, and comes here — so "1 notes" would greet him at
  // the top of the very screen whose whole job is to look like the app can account for
  // itself. Same treatment as `briefcase.countOne`.
  'devlog.countAndSize': { en: '{{count}} notes, about {{size}}', hi: '{{count}} नोट, लगभग {{size}}' },
  'devlog.countAndSizeOne': { en: '1 note, about {{size}}', hi: '1 नोट, लगभग {{size}}' },
  'devlog.sizeBytes': { en: '{{n}} bytes', hi: '{{n}} बाइट' },
  'devlog.sizeKb': { en: '{{n}} KB', hi: '{{n}} KB' },

  'devlog.filterAll': { en: 'Everything', hi: 'सब कुछ' },
  'devlog.filterScan': { en: 'Prescription Scanning', hi: 'नुस्खा पढ़ना' },
  'devlog.filterOther': { en: 'Rest Of The App', hi: 'बाकी ऐप' },
  'devlog.filterProblems': { en: 'Problems Only', hi: 'सिर्फ़ दिक्कतें' },
  'devlog.filterLabel': { en: 'Which notes to show', hi: 'कौन से नोट दिखाएँ' },

  'devlog.levelError': { en: 'Problem', hi: 'दिक्कत' },
  'devlog.levelWarn': { en: 'Warning', hi: 'चेतावनी' },
  'devlog.runLabel': { en: 'Run {{id}}', hi: 'रन {{id}}' },
  'devlog.expandHint': { en: 'Opens the full note', hi: 'पूरा नोट खुलेगा' },
  'devlog.noFields': { en: 'This note carries no details.', hi: 'इस नोट के साथ कोई ब्यौरा नहीं है।' },

  'devlog.copyOne': { en: 'Copy This Note', hi: 'यह नोट कॉपी करें' },
  'devlog.copyAll': { en: 'Copy All Notes', hi: 'सारे नोट कॉपी करें' },
  'devlog.share': { en: 'Share', hi: 'साझा करें' },
  'devlog.copied': { en: 'Copied', hi: 'कॉपी हो गया' },
  'devlog.copyFailed': {
    en: 'The clipboard could not be written on this phone.',
    hi: 'इस फ़ोन पर क्लिपबोर्ड में नहीं लिखा जा सका।',
  },
  'devlog.shareFailed': {
    en: 'No app on this phone would take the notes. Copy them instead and paste them where you need them.',
    hi: 'इस फ़ोन का कोई ऐप ये नोट नहीं ले सका। इन्हें कॉपी करके जहाँ चाहिए वहाँ चिपका दें।',
  },

  'devlog.delete': { en: 'Delete Logs', hi: 'नोट मिटाएँ' },
  'devlog.deleteTitle': { en: 'Delete all the notes?', hi: 'क्या सारे नोट मिटा दें?' },
  'devlog.deleteMessage': {
    en: 'This clears the {{count}} notes recorded so far, about {{size}}. Recording stays on, so new notes will start collecting again straight away.',
    hi: 'अब तक के {{count}} नोट (लगभग {{size}}) मिट जाएँगे। नोट रखना चालू रहेगा, इसलिए नए नोट फिर से जमा होने लगेंगे।',
  },
  'devlog.deleteMessageOne': {
    en: 'This clears the one note recorded so far, about {{size}}. Recording stays on, so new notes will start collecting again straight away.',
    hi: 'अब तक का 1 नोट (लगभग {{size}}) मिट जाएगा। नोट रखना चालू रहेगा, इसलिए नए नोट फिर से जमा होने लगेंगे।',
  },
  // Added only when the filter is actually hiding something. Delete is not filtered — it
  // purges the whole ring and the file — so a confirm that names 187 while three rows sit
  // behind it is a number describing a set he cannot see. The count stays honest and this
  // sentence explains why it does not match the list. Deliberately carries NO number of
  // its own: one more figure to reconcile is the opposite of the fix.
  'devlog.deleteAlsoHidden': {
    en: 'That includes the notes this filter is not showing.',
    hi: 'इसमें वे नोट भी शामिल हैं जो इस छँटाई में अभी नहीं दिख रहे।',
  },
  'devlog.deleted': { en: 'The notes were deleted.', hi: 'नोट मिटा दिए गए।' },

  'devlog.empty': { en: 'No notes yet', hi: 'अभी कोई नोट नहीं' },
  'devlog.emptyMessage': {
    en: 'Nothing has been recorded since this was switched on. Try the thing that went wrong, then come back here.',
    hi: 'इसे चालू करने के बाद अभी कुछ दर्ज नहीं हुआ। जो काम बिगड़ रहा था उसे एक बार करके यहाँ वापस आइए।',
  },
  'devlog.emptyFiltered': { en: 'Nothing under this filter', hi: 'इस छँटाई में कुछ नहीं' },
  'devlog.emptyFilteredMessage': {
    en: 'There are notes, but none of this kind. Try “Everything”.',
    hi: 'नोट तो हैं, पर इस तरह के नहीं। “सब कुछ” चुनकर देखिए।',
  },
  'devlog.offTitle': { en: 'Notes are not being kept', hi: 'अभी नोट नहीं रखे जा रहे' },
  'devlog.offMessage': {
    en: 'Nothing is being recorded. Turn on the developer switch in Settings first.',
    hi: 'अभी कुछ दर्ज नहीं हो रहा। पहले सेटिंग में डेवलपर वाला स्विच चालू करें।',
  },
};

/** The four buckets the list can be narrowed to. `all` is the landing state. */
type Filter = 'all' | 'scan' | 'other' | 'problems';

const FILTERS: readonly { key: Filter; labelKey: string }[] = [
  { key: 'all', labelKey: 'devlog.filterAll' },
  { key: 'scan', labelKey: 'devlog.filterScan' },
  { key: 'other', labelKey: 'devlog.filterOther' },
  { key: 'problems', labelKey: 'devlog.filterProblems' },
];

/**
 * Whether a route parameter names a filter.
 *
 * `/devlog?filter=scan` is what the failed-scan banner links to, so somebody staring at
 * "the prescription could not be read" is one tap from the fifteen lines that say why,
 * already narrowed to the scan. An unknown or missing value falls back to everything —
 * a bad link must never produce an empty screen.
 */
function isFilter(value: unknown): value is Filter {
  return value === 'all' || value === 'scan' || value === 'other' || value === 'problems';
}

function matches(entry: DevLogEntry, filter: Filter): boolean {
  switch (filter) {
    // `image` rides with `ai` deliberately: cropping and encoding a photograph is part of
    // one scan as far as anybody debugging a scan is concerned, and splitting them would
    // hide the crop from the person looking for why the medicines were cut off.
    case 'scan':
      return entry.category === 'ai' || entry.category === 'image';
    case 'other':
      return entry.category === 'app';
    case 'problems':
      // Level alone is decided per-entry; the rest of this filter needs the whole list,
      // so `selectProblems` below does it. Keeping the loud test here means the two
      // agree on what "loud" means in exactly one place.
      return entry.level === 'error' || entry.level === 'warn';
    case 'all':
    default:
      return true;
  }
}

function isLoud(entry: DevLogEntry): boolean {
  return entry.level === 'error' || entry.level === 'warn';
}

/**
 * "Problems Only" means the failures WITH THEIR CONTEXT, not the lines tagged loud.
 *
 * ─── WHY THIS IS NOT JUST A LEVEL TEST ───────────────────────────────────────
 * The line that decides what to do about a failed scan is usually not the line that
 * failed. A scan that returns no medicines logs `ai.outcome` at `warn` — and the field
 * that says whether to drag the crop or retake the photo is `defaultCrop`, which rides
 * on `prep.page` at `debug`, several entries earlier. A level test hides it, so the one
 * chip somebody reaches for after a failure removes the answer to the question they
 * opened the screen with.
 *
 * So a run that contains anything loud shows in full. `runId` is stamped on every entry
 * by `beginRun` for exactly this — one scan is one run, and a failure is only ever
 * diagnosable as a whole.
 *
 * Entries with no `runId` (a render crash, a boot failure) are judged on their own level,
 * because there is no run to widen to.
 */
function selectProblems(entries: readonly DevLogEntry[]): DevLogEntry[] {
  const failedRuns = new Set<string>();
  for (const entry of entries) {
    if (entry.runId !== null && isLoud(entry)) failedRuns.add(entry.runId);
  }
  return entries.filter((entry) =>
    entry.runId !== null ? failedRuns.has(entry.runId) : isLoud(entry),
  );
}

/**
 * Everything the screen shows, read in one go.
 *
 * Module scope, so it is a stable reference and the subscription below needs no
 * dependency list. Both halves come from the same synchronous snapshot of the ring, so a
 * note cannot appear in the list while the count beside the delete button still says the
 * old number.
 *
 * `.slice()` is load-bearing: `listEntries()` hands back the recorder's own array, which
 * it mutates in place, so storing it directly would give React the same reference after
 * every push and nothing would re-render.
 */
function snapshot(): { entries: readonly DevLogEntry[]; count: number; bytes: number } {
  const stats = devLogStats();
  return { entries: listEntries().slice(), count: stats.count, bytes: stats.approxBytes };
}

export default function DevLogScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();

  const rawFilter = useLocalSearchParams<{ filter?: string | string[] }>().filter;
  const requested = Array.isArray(rawFilter) ? rawFilter[0] : rawFilter;

  const [state, setState] = useState(snapshot);
  const [filter, setFilter] = useState<Filter>(isFilter(requested) ? requested : 'all');
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  // Live, because a note written while this screen is open is a note he is waiting for.
  // The recorder fires on every change — a new note, a purge, the toggle flipping — and
  // the whole snapshot is re-read rather than appended to, so the two numbers and the
  // list can never drift apart.
  useEffect(() => subscribeDevLog(() => setState(snapshot())), []);

  const recording = isDevLogEnabled();

  // Newest first. He is looking for what just happened, not for how the app booted.
  const visible = (
    filter === 'problems'
      ? selectProblems(state.entries)
      : state.entries.filter((entry) => matches(entry, filter))
  )
    .slice()
    .reverse();

  const copy = useCallback(
    async (text: string) => {
      try {
        await Clipboard.setStringAsync(text);
        toast.show({ message: t('devlog.copied'), variant: 'success' });
      } catch {
        toast.show({ message: t('devlog.copyFailed'), variant: 'error' });
      }
    },
    [t, toast],
  );

  const shareAll = useCallback(async () => {
    // On disk before it leaves: the ring is written out on an idle timer, and what he
    // shares must be what he is looking at rather than what happened to be flushed.
    flushDevLog();
    try {
      await Share.share({ message: devLogShareText() });
    } catch {
      // A share sheet with nothing behind it, or a payload the OS would not carry. Copy
      // is the escape hatch and it is on the same screen, so the sentence points at it.
      toast.show({ message: t('devlog.shareFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const deleteAll = useCallback(async () => {
    // The number in the dialog is the number that is actually going: `purgeDevLog` empties
    // the ring and the file, and it has never known what the filter is set to. So the
    // count stays the TOTAL — quietly reporting the filtered count would understate a
    // destructive action — and when the filter is hiding rows, the dialog says so instead
    // of leaving him to reconcile "187" against the three lines behind it.
    const hidden = state.count - visible.length;
    const size = sizeText(t, state.bytes);
    const body =
      state.count === 1
        ? t('devlog.deleteMessageOne', { size })
        : t('devlog.deleteMessage', { count: state.count, size });
    const ok = await confirm({
      title: t('devlog.deleteTitle'),
      message: hidden > 0 ? `${body}\n\n${t('devlog.deleteAlsoHidden')}` : body,
      confirmLabel: t('devlog.delete'),
      destructive: true,
    });
    if (!ok) return;
    // Deletes the ring AND the file. Deliberately does not touch the toggle — clearing
    // the notes to start a clean reproduction is a different intention from deciding to
    // stop keeping notes, and merging them would close the feature he is in the middle of
    // using. See `purgeDevLog`.
    purgeDevLog();
    setOpenSeq(null);
    setState(snapshot());
    toast.show({ message: t('devlog.deleted'), variant: 'success' });
  }, [confirm, state.bytes, state.count, visible.length, t, toast]);

  return (
    <Screen variant="fixed" background="bg">
      <ScreenHeader
        title={t('devlog.title')}
        subtitle={
          state.count === 1
            ? t('devlog.countAndSizeOne', { size: sizeText(t, state.bytes) })
            : t('devlog.countAndSize', { count: state.count, size: sizeText(t, state.bytes) })
        }
        onBack={() => router.back()}
        right={
          <Button
            title={t('devlog.share')}
            onPress={() => void shareAll()}
            variant="ghost"
            size="md"
            disabled={state.count === 0}
          />
        }
      />

      {!recording ? (
        <Card variant="sunken" style={{ marginBottom: spacing.md, gap: spacing.xs }}>
          <Text variant="label">{t('devlog.offTitle')}</Text>
          <Text variant="body" tone="muted">
            {t('devlog.offMessage')}
          </Text>
        </Card>
      ) : null}

      {/* One sentence, and only one. The long version — where the notes sit, what happens
          to them when the switch goes off — is on Developer Options, which is the screen
          somebody reads. This is the screen somebody uses, and it needs the assurance
          without the essay: a phone full of `ai.http status=429` is exactly the sort of
          thing that makes a person wonder what else is being written down about them. */}
      <Card variant="sunken" style={{ marginBottom: spacing.md }}>
        <Text variant="body">{t('devlog.what')}</Text>
      </Card>

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('devlog.filterLabel')}
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.sm,
          marginBottom: spacing.md,
        }}
      >
        {FILTERS.map((option) => (
          <Chip
            key={option.key}
            label={t(option.labelKey)}
            selected={filter === option.key}
            onPress={() => setFilter(option.key)}
            selectionMode="single"
          />
        ))}
      </View>

      <FlatList
        // `flex: 1` and not the bare list `documents.tsx` gets away with: there are four
        // things above it here, and a virtualised list with no flex in a column measures
        // to its content and takes the last rows off the bottom of the screen instead of
        // scrolling them.
        style={{ flex: 1 }}
        data={visible}
        keyExtractor={(entry) => String(entry.seq)}
        renderItem={({ item }) => (
          <LogRow
            entry={item}
            expanded={openSeq === item.seq}
            onToggle={() => setOpenSeq(openSeq === item.seq ? null : item.seq)}
            onCopy={() => void copy(formatEntry(item))}
            t={t}
          />
        )}
        ItemSeparatorComponent={Divider}
        ListEmptyComponent={
          <EmptyState
            title={state.count === 0 ? t('devlog.empty') : t('devlog.emptyFiltered')}
            message={
              state.count === 0 ? t('devlog.emptyMessage') : t('devlog.emptyFilteredMessage')
            }
            icon="info"
          />
        }
        ListFooterComponent={
          <View style={{ gap: spacing.md, paddingTop: spacing.xl, paddingBottom: spacing.xl }}>
            {/* Equal width, stacked, both 64dp. Two actions of the same weight should not
                be two different sizes — that reads as one of them being the answer. */}
            <Button
              title={t('devlog.copyAll')}
              onPress={() => void copy(devLogShareText())}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={state.count === 0}
            />
            <Button
              title={t('devlog.delete')}
              onPress={() => void deleteAll()}
              variant="destructive"
              size="lg"
              fullWidth
              disabled={state.count === 0}
            />
          </View>
        }
        persistentScrollbar
      />
    </Screen>
  );
}

// ── One note ─────────────────────────────────────────────────────────────────

/**
 * A row, and its detail underneath when it is open.
 *
 * Collapsed it is two lines: when, what, and the first few fields — enough to recognise
 * the line without opening it. Open it is every field, one per line, plus the copy button.
 *
 * The level is carried by a WORD ("Problem", "Warning") as well as by the icon and the
 * colour, because colour is never the only signal in this app. It is drawn in the
 * attention token rather than the destructive one: `destructive` is reserved for controls
 * that destroy something, and a note describing a failure is not one.
 */
function LogRow({
  entry,
  expanded,
  onToggle,
  onCopy,
  t,
}: {
  entry: DevLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  t: TranslateFn;
}) {
  const { colors } = useTheme();
  const loud = entry.level === 'error' || entry.level === 'warn';
  const fields = Object.entries(entry.fields);
  const levelWord = entry.level === 'error' ? t('devlog.levelError') : t('devlog.levelWarn');

  return (
    <View>
      <PressableScale
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${clockOf(entry.ts)} ${entry.event}${loud ? `. ${levelWord}` : ''}`}
        accessibilityHint={t('devlog.expandHint')}
        style={{
          minHeight: spacing.touchTarget,
          paddingVertical: spacing.md,
          gap: spacing.xs,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text variant="caption" tone="muted">
            {clockOf(entry.ts)}
          </Text>
          <Text variant="body" weight="600" style={{ flex: 1 }}>
            {entry.event}
          </Text>
          {loud ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <Icon name="alert" size={18} color={colors.attention} />
              <Text variant="caption" tone="attention">
                {levelWord}
              </Text>
            </View>
          ) : null}
        </View>

        {/* The preview disappears when the note is open, rather than being repeated above
            the full field list — one line of text should not exist twice on one screen. */}
        {!expanded && fields.length > 0 ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {summarise(fields)}
          </Text>
        ) : null}
      </PressableScale>

      {expanded ? (
        <View
          style={{
            gap: spacing.sm,
            paddingBottom: spacing.lg,
            paddingLeft: spacing.md,
            borderLeftWidth: 2,
            borderLeftColor: colors.border,
            borderRadius: radii.sm,
          }}
        >
          <Text variant="caption" tone="muted">
            {new Date(entry.ts).toISOString()}
            {entry.runId ? ` · ${t('devlog.runLabel', { id: entry.runId })}` : ''}
          </Text>

          {fields.length === 0 ? (
            <Text variant="caption" tone="muted">
              {t('devlog.noFields')}
            </Text>
          ) : (
            fields.map(([name, value]) => (
              <View key={name} style={{ gap: spacing.xs }}>
                <Text variant="caption" tone="muted">
                  {name}
                </Text>
                <Text variant="body">{String(value)}</Text>
              </View>
            ))
          )}

          <Button
            title={t('devlog.copyOne')}
            onPress={onCopy}
            variant="secondary"
            size="lg"
            fullWidth
          />
        </View>
      ) : null}
    </View>
  );
}

// ── Small things ─────────────────────────────────────────────────────────────

/** `HH:MM:SS`, local. Machine-facing, so no locale formatting and no timezone guesswork. */
function clockOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The collapsed preview: the first few fields, as `name=value`.
 *
 * Capped by field COUNT rather than by characters, so a line is never cut mid-value in a
 * way that could be read as the value itself being truncated. The row's `numberOfLines`
 * does the visual trimming.
 */
function summarise(fields: readonly [string, unknown][]): string {
  return fields
    .slice(0, 4)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('  ');
}

/**
 * "31 KB" / "912 bytes".
 *
 * Rounded up so the delete button never promises to reclaim less than it does, and
 * deliberately coarse: this number exists to make a decision meaningful, not to be
 * audited.
 */
function sizeText(t: TranslateFn, bytes: number): string {
  const kb = 1024;
  if (bytes < kb) return t('devlog.sizeBytes', { n: bytes });
  return t('devlog.sizeKb', { n: Math.ceil(bytes / kb) });
}
