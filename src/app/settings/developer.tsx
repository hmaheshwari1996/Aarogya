/**
 * Developer options — the one extra menu the switch in Settings reveals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A SCREEN BETWEEN THE SWITCH AND THE LOG
 *
 * The log itself is a dense technical list; it is the tool. This page is the part that
 * has to be said in words, once, in the app's ordinary voice: what is being written down,
 * what is deliberately not, where it sits, and what happens to it when the switch goes
 * back off. Putting those four paragraphs at the top of a scrolling log would mean they
 * are read once and then scrolled past forever.
 *
 * It also gives the switch somewhere honest to point. "Developer mode: on" with no way to
 * see what that means is the kind of setting people leave on because they are not sure
 * what turning it off would break.
 *
 * ─── THE STATE THIS PAGE MUST HANDLE, AND USUALLY IS NOT SHOWN ───────────────
 *
 * Recording off. Settings hides the row that leads here, but a route is a route: a deep
 * link, a back-stack that outlived the switch, or a phone where the boot-time read has
 * not run yet all land here with nothing being recorded. It says so plainly rather than
 * showing "0 notes", which reads as "it is on and nothing has happened" — the one wrong
 * conclusion available at that moment.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Card,
  Divider,
  ListRow,
  useToast,
  ROW_DIVIDER_INSET,
  Screen,
  ScreenHeader,
  SectionHeader,
  Text,
} from '@/components/ui';
import { devLogStats, isDevLogEnabled, subscribeDevLog } from '@/features/devlog';
import { spacing } from '@/theme';
import type { TranslateFn } from '@/i18n';

const STRINGS: LocalStrings = {
  'dev.title': { en: 'Developer Options', hi: 'डेवलपर विकल्प' },
  'dev.syncSection': { en: 'Family sharing', hi: 'परिवार के साथ साझा' },
  'dev.syncNow': { en: 'Sync Now', hi: 'अभी सिंक कीजिए' },
  'dev.syncNowHelp': {
    en: 'Send this phone’s changes and fetch everyone else’s straight away.',
    hi: 'इस फ़ोन के बदलाव भेजिए और बाकी सबके अभी ले आइए।',
  },
  'dev.syncRunning': { en: 'Syncing…', hi: 'सिंक हो रहा है…' },
  'dev.syncDone': { en: 'Sync finished', hi: 'सिंक पूरा हुआ' },
  'dev.syncBusy': { en: 'A sync is already running', hi: 'सिंक पहले से चल रहा है' },
  'dev.syncFailed': {
    en: 'Sync did not finish. Nothing on this phone has changed.',
    hi: 'सिंक पूरा नहीं हुआ। इस फ़ोन में कुछ नहीं बदला।',
  },
  'dev.subtitle': {
    en: 'Technical notes about the app itself',
    hi: 'ऐप के अपने काम-काज के तकनीकी नोट',
  },

  'dev.whatTitle': { en: 'What is being written down', hi: 'क्या लिखा जा रहा है' },
  'dev.whatBody': {
    en: 'While this is on, Aarogya keeps a short technical diary of its own plumbing: which step of a prescription scan it reached, how big the photo was, what Google answered, how long each part took.',
    hi: 'जब तक यह चालू है, आरोग्य अपने अंदरूनी काम की एक छोटी तकनीकी डायरी रखता है: नुस्खा पढ़ने में कौन-सा चरण आया, तस्वीर कितनी बड़ी थी, गूगल ने क्या जवाब दिया, हर हिस्से में कितना समय लगा।',
  },
  'dev.neverTitle': { en: 'What is never written down', hi: 'क्या कभी नहीं लिखा जाता' },
  'dev.neverBody': {
    en: 'No medicine names, no readings, no name, no photograph and no key. The notes count things and name the steps; they do not carry what the prescription said. The whole log can be handed to a stranger without telling them anything about the person using this phone.',
    hi: 'न दवाइयों के नाम, न कोई माप, न नाम, न कोई तस्वीर, न कोई की। ये नोट सिर्फ़ गिनती और चरणों के नाम रखते हैं; नुस्खे में क्या लिखा था, यह नहीं। पूरा लॉग किसी अजनबी को दे दिया जाए तो भी उसे इस फ़ोन के इस्तेमाल करने वाले के बारे में कुछ पता नहीं चलेगा।',
  },
  'dev.whereTitle': { en: 'Where they are kept', hi: 'ये कहाँ रखे जाते हैं' },
  'dev.whereBody': {
    en: 'In this phone’s temporary storage, which the phone itself may clear whenever it needs the room. They are never part of a backup, and they are never sent anywhere on their own.',
    hi: 'इसी फ़ोन की अस्थायी जगह में, जिसे ज़रूरत पड़ने पर फ़ोन खुद खाली कर सकता है। ये किसी बैकअप का हिस्सा नहीं बनते, और अपने आप कहीं नहीं भेजे जाते।',
  },
  'dev.offSwitchBody': {
    en: 'Turning the developer switch back off in Settings deletes everything recorded so far.',
    hi: 'सेटिंग में डेवलपर स्विच वापस बंद करते ही अब तक का सब कुछ मिट जाता है।',
  },

  'dev.logsSection': { en: 'The notes', hi: 'नोट' },
  'dev.logs': { en: 'App Logs', hi: 'ऐप के नोट' },
  'dev.logsEmpty': { en: 'Nothing recorded yet', hi: 'अभी कुछ दर्ज नहीं हुआ' },
  'dev.logsCount': { en: '{{count}} notes, about {{size}}', hi: '{{count}} नोट, लगभग {{size}}' },
  'dev.logsSince': { en: 'Oldest kept from {{time}}', hi: 'सबसे पुराना {{time}} से' },
  'dev.sizeBytes': { en: '{{n}} bytes', hi: '{{n}} बाइट' },
  'dev.sizeKb': { en: '{{n}} KB', hi: '{{n}} KB' },

  'dev.offTitle': { en: 'Notes are not being kept', hi: 'अभी नोट नहीं रखे जा रहे' },
  'dev.offMessage': {
    en: 'Nothing is being recorded on this phone. Turn on the developer switch at the bottom of Settings to start.',
    hi: 'इस फ़ोन पर अभी कुछ दर्ज नहीं हो रहा। शुरू करने के लिए सेटिंग में सबसे नीचे डेवलपर स्विच चालू करें।',
  },
  'dev.openSettings': { en: 'Back To Settings', hi: 'सेटिंग पर वापस' },
};

export default function DeveloperScreen() {
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const t = useT(STRINGS);

  // The same live snapshot the log screen uses, for the same reason: the count on this
  // row and the list behind it must never disagree. `devLogStats()` is a synchronous read
  // of a module-level ring, so re-reading it on every note costs nothing.
  const [stats, setStats] = useState(() => devLogStats());
  useEffect(() => subscribeDevLog(() => setStats(devLogStats())), []);

  const recording = isDevLogEnabled();

  const subtitle =
    stats.count === 0
      ? t('dev.logsEmpty')
      : t('dev.logsCount', { count: stats.count, size: sizeText(t, stats.approxBytes) });

  /**
   * A manual sync, behind the developer toggle on purpose: the app syncs on its own at boot
   * and on every foreground, so a button here is a debugging aid for whoever set the phone up
   * — not a thing the patient should ever feel she has to remember to press.
   */
  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const { syncNow } = await import('@/features/sync');
      const ran = await syncNow();
      toast.show({
        message: ran ? t('dev.syncDone') : t('dev.syncBusy'),
        variant: ran ? 'success' : 'info',
      });
    } catch {
      toast.show({ message: t('dev.syncFailed'), variant: 'error' });
    } finally {
      setSyncing(false);
    }
  }, [t, toast]);

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('dev.title')}
        subtitle={t('dev.subtitle')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        {!recording ? (
          <Banner
            variant="info"
            title={t('dev.offTitle')}
            message={t('dev.offMessage')}
            actionLabel={t('dev.openSettings')}
            onAction={() => router.back()}
          />
        ) : null}

        <SectionHeader title={t('dev.syncSection')} />
        <Card>
          <ListRow
            title={syncing ? t('dev.syncRunning') : t('dev.syncNow')}
            subtitle={t('dev.syncNowHelp')}
            disabled={syncing}
            onPress={() => void runSync()}
          />
        </Card>

        <SectionHeader title={t('dev.logsSection')} />
        <Card>
          <ListRow
            title={t('dev.logs')}
            subtitle={subtitle}
            meta={
              stats.oldestTs === null ? undefined : t('dev.logsSince', { time: clockOf(stats.oldestTs) })
            }
            onPress={() => router.push('/devlog')}
          />
        </Card>

        <Card style={{ gap: spacing.lg }}>
          <Explain title={t('dev.whatTitle')} body={t('dev.whatBody')} />
          <Divider inset={ROW_DIVIDER_INSET} />
          <Explain title={t('dev.neverTitle')} body={t('dev.neverBody')} />
          <Divider inset={ROW_DIVIDER_INSET} />
          <Explain title={t('dev.whereTitle')} body={t('dev.whereBody')} />
        </Card>

        <Text variant="caption" tone="muted">
          {t('dev.offSwitchBody')}
        </Text>
      </View>
    </Screen>
  );
}

function Explain({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label">{title}</Text>
      <Text variant="body" tone="muted">
        {body}
      </Text>
    </View>
  );
}

/** `HH:MM`, local. Same reasoning as the log screen: this is a stopwatch, not a date. */
function clockOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sizeText(t: TranslateFn, bytes: number): string {
  const kb = 1024;
  if (bytes < kb) return t('dev.sizeBytes', { n: bytes });
  return t('dev.sizeKb', { n: Math.ceil(bytes / kb) });
}
