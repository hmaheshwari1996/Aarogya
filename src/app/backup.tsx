/**
 * Backup — the son's screen, reachable from More.
 *
 * There is no cloud backup in this app by design, which makes the database file on this
 * handset the only copy of the record. That is a deliberate privacy position and it has
 * exactly one cost: a lost or wiped phone loses everything. This screen is how that cost
 * is paid down, and it is why "Save a copy" is the primary action and not a footnote.
 *
 * RESTORE IS THE DANGEROUS HALF. It replaces the live record, so it is confirmed by name
 * and by date, never by a generic "Are you sure?", and it is deliberately harder to reach
 * than export.
 *
 * ─── THREE DECISIONS ABOUT DELETING A COPY ────────────────────────────────────────
 *
 * 1. ONE COPY AT A TIME, NEVER A "DELETE ALL" AND NEVER MULTI-SELECT.
 *    Capsules accumulate slowly — the reminder that produces them is monthly — so the
 *    real case is five files, not five hundred, and four deliberate confirmations for
 *    four irreversible deletions is proportionate rather than a burden. A "delete all"
 *    is a single tap that removes every disaster-recovery artefact on a phone with no
 *    cloud copy, no account and no undo, which is the exact asymmetry this whole file
 *    exists to argue against. Multi-select is worse than it looks for a second reason:
 *    a batch confirmation cannot name the file and its date, so it degrades to
 *    "Delete 4 copies?" — the generic "Are you sure?" the header above rejects — and it
 *    adds a MODE to a screen that has none, which is how a thumb aimed at "Bring this
 *    copy back" lands on something else.
 *
 *    The real complaint behind "they all look the same" is not that deleting is slow. It
 *    is that a list of `aarogya-2026-08-09-1432.aarogya` is unreadable, so she cannot
 *    tell which one she wants to keep. That is fixed here by naming each row with its
 *    DATE and marking the newest, not by making bulk removal easy.
 *
 * 2. DELETE IS NOT ADJACENT TO RESTORE AND DOES NOT LOOK LIKE IT.
 *    Both are destructive, and two same-coloured buttons carrying the same warning icon,
 *    side by side, in a row that repeats five times, is a mis-tap waiting to happen — and
 *    the two mistakes are not symmetrical. So restore keeps the destructive treatment
 *    (it replaces the live record) and delete sits on its own line, in the secondary
 *    variant with a different glyph. The weight is in its confirmation instead.
 *
 * 3. THE CONFIRMATION IS SIZED TO WHAT IS ACTUALLY LOST.
 *    Deleting one of five copies changes almost nothing and is told so plainly, because a
 *    dialog that panics her every time trains her to keep files she does not want and to
 *    stop reading dialogs. Deleting the LAST copy is the one that matters and gets the
 *    longer sentence. Neither version claims anything about copies that left this phone:
 *    `recordCopyTakenOffDevice()` is never called, so the app genuinely does not know
 *    whether one did — it can only say, truthfully, that if she sent one it is untouched.
 * ──────────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';

import { spacing } from '@/theme';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  ListRow,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useDateFormat } from '@/i18n/useDateFormat';
import {
  capsuleStampFromName,
  deleteCapsule,
  exportCapsule,
  importCapsule,
  listCapsules,
  readBackupState,
  type CapsuleStamp,
} from '@/features/backup';

import { invalidateProfileCache, useAsync, useProfileId, useT, type LocalStrings } from './_shared/lib';

const STRINGS: LocalStrings = {
  'backup.title': { en: 'Backup', hi: 'बैकअप' },
  'backup.subtitle': {
    en: 'Your record lives only on this phone. A saved copy is what survives a lost or broken handset.',
    hi: 'आपका रिकॉर्ड सिर्फ़ इसी फ़ोन में है। खोए या टूटे फ़ोन के बाद सिर्फ़ रखी हुई नक़ल ही बचती है।',
  },
  // TITLE CASE NAMES A CONTROL; SENTENCE CASE STATES A FACT — the same line
  // `prescription/review.tsx` draws, and the reason four strings in this map changed case
  // when the delete button arrived. Every row here now carries three buttons, and until
  // this was settled the row read "Send this copy somewhere safe" · "Bring this copy back"
  // · "Delete This Copy": two conventions inside one repeating row, three times over, on
  // the screen whose whole job is telling near-identical rows apart. So every label that
  // names an action she can take is Title Case, and `backup.exporting` below is NOT —
  // "Making the copy" is the button reporting what it is doing, not naming what a tap
  // would do, and it is never a target while it is showing.
  'backup.export': { en: 'Save A Copy Of Everything', hi: 'सब कुछ की एक नक़ल रखिए' },
  'backup.exporting': { en: 'Making the copy', hi: 'नक़ल बन रही है' },
  'backup.exportDone': { en: 'Copy saved on this phone', hi: 'नक़ल इसी फ़ोन में रख ली गई' },
  'backup.exportFailed': {
    en: 'The copy could not be made. Nothing in your record has changed.',
    hi: 'नक़ल नहीं बन सकी। आपके रिकॉर्ड में कुछ नहीं बदला।',
  },
  'backup.share': { en: 'Send This Copy Somewhere Safe', hi: 'यह नक़ल कहीं सुरक्षित भेजिए' },
  'backup.savedCopies': { en: 'Copies on this phone', hi: 'इस फ़ोन में रखी नक़लें' },
  'backup.noCopies': { en: 'No copy has been saved yet', hi: 'अभी कोई नक़ल नहीं रखी गई' },
  'backup.noCopiesMessage': {
    en: 'Once you save a copy it will appear here, and you can send it to a computer or another phone.',
    hi: 'नक़ल रखने के बाद वह यहाँ दिखेगी, और आप उसे कंप्यूटर या दूसरे फ़ोन पर भेज सकती हैं।',
  },
  // The empty state after the last copy is deleted. "No copy has been saved yet" would be
  // a plain untruth here — she saved one and then removed it — and the difference is not
  // cosmetic: the first message says the feature is waiting to be used, this one says an
  // exposure has just been taken on. Stated once, in the same flat voice as the rest of
  // the screen, with the button that ends it already sitting three lines above. No banner,
  // no repeat, nothing to dismiss.
  'backup.noCopiesLeft': { en: 'No copy is left on this phone', hi: 'इस फ़ोन में कोई नक़ल नहीं बची' },
  'backup.noCopiesLeftMessage': {
    en: 'Your record itself is not changed and is still here. Nothing saved on this phone would now survive a lost or broken handset. If you sent a copy somewhere else, it is still where you put it.',
    hi: 'आपका रिकॉर्ड नहीं बदला, वह अभी भी यहीं है। पर इस फ़ोन में अब ऐसा कुछ नहीं रखा है जो फ़ोन खोने या टूटने पर बचे। अगर आपने कोई नक़ल कहीं और भेजी थी, तो वह वहीं है।',
  },
  'backup.restore': { en: 'Bring This Copy Back', hi: 'यह नक़ल वापस लाइए' },
  'backup.restoreTitle': { en: 'Replace everything with {{name}}?', hi: '{{name}} से सब कुछ बदल दें?' },
  'backup.restoreMessage': {
    en: 'Everything recorded on this phone will be replaced by the copy saved on {{date}}. Anything recorded since then will not be in it.',
    hi: 'इस फ़ोन का सारा दर्ज किया हुआ {{date}} को रखी नक़ल से बदल दिया जाएगा। उसके बाद का दर्ज किया हुआ उसमें नहीं होगा।',
  },
  'backup.restoreConfirm': { en: 'Replace Everything', hi: 'सब कुछ बदल दीजिए' },
  'backup.restored': { en: 'The copy has been brought back', hi: 'नक़ल वापस ले आई गई' },
  'backup.restoreFailed': {
    en: 'The copy could not be brought back. Your record has not been changed.',
    hi: 'नक़ल वापस नहीं लाई जा सकी। आपका रिकॉर्ड नहीं बदला गया।',
  },
  'backup.delete': { en: 'Delete This Copy', hi: 'यह नक़ल हटाइए' },
  'backup.deleteTitle': {
    en: 'Delete the copy from {{date}}?',
    hi: '{{date}} वाली नक़ल हटा दें?',
  },
  // Three messages, one per situation, because one message written for the worst case
  // would either frighten her out of routine tidying or fail to mention the only fact
  // that matters on the last file.
  'backup.deleteMessageOthers': {
    en: 'This removes one saved file from this phone. Your record itself is not changed, and {{count}} other copies stay here.',
    hi: 'इससे इस फ़ोन से एक रखी हुई फ़ाइल हट जाएगी। आपका रिकॉर्ड नहीं बदलेगा, और {{count}} दूसरी नक़लें यहीं रहेंगी।',
  },
  'backup.deleteMessageOneOther': {
    en: 'This removes one saved file from this phone. Your record itself is not changed, and one other copy stays here.',
    hi: 'इससे इस फ़ोन से एक रखी हुई फ़ाइल हट जाएगी। आपका रिकॉर्ड नहीं बदलेगा, और एक दूसरी नक़ल यहीं रहेगी।',
  },
  'backup.deleteMessageLast': {
    en: 'This is the only copy on this phone. Your record itself is not changed, but after this nothing here would survive a lost or broken handset. If you already sent this copy somewhere else, that one is not touched.',
    hi: 'इस फ़ोन में यही एकमात्र नक़ल है। आपका रिकॉर्ड नहीं बदलेगा, पर इसके बाद यहाँ ऐसा कुछ नहीं बचेगा जो फ़ोन खोने या टूटने पर काम आए। अगर आपने यह नक़ल पहले ही कहीं और भेज दी है, तो वह वहीं रहेगी।',
  },
  // "Keep It" rather than "Cancel": the safe answer should say what it does, so the two
  // buttons read as a choice between two outcomes rather than as do-it / escape.
  'backup.deleteCancel': { en: 'Keep It', hi: 'रहने दीजिए' },
  'backup.deleted': { en: 'The copy has been deleted', hi: 'नक़ल हटा दी गई' },
  'backup.deleteAlreadyGone': {
    en: 'That copy had already gone from this phone',
    hi: 'वह नक़ल इस फ़ोन से पहले ही जा चुकी थी',
  },
  'backup.deleteFailed': {
    en: 'The copy could not be deleted. It is still on this phone.',
    hi: 'नक़ल हटाई नहीं जा सकी। वह अभी भी इस फ़ोन में है।',
  },
  'backup.sharingUnavailable': {
    en: 'This phone has nothing to send files with.',
    hi: 'इस फ़ोन में फ़ाइल भेजने के लिए कुछ नहीं है।',
  },
  'backup.bytes': { en: '{{size}} KB', hi: '{{size}} KB' },
  'backup.metaNewest': { en: 'Newest copy · {{name}}', hi: 'सबसे नई नक़ल · {{name}}' },
  // WHAT THE ROW SAYS OUT LOUD, WITHOUT THE FILENAME.
  //
  // `ListRow` collapses its three lines into one spoken sentence by design, so the caption
  // that exists to be matched against a file manager — `aarogya-2026-08-09-1432.aarogya` —
  // was read out in full before she could reach any of the three buttons. A screen reader
  // renders that as a run of digit groups and dashes; five saved copies is five of them,
  // on the screen whose new job is choosing which file to remove. Matching a row against a
  // file manager is a LOOKING job, so the filename stays on screen and leaves the sentence.
  //
  // Two whole strings rather than one plus an appended marker: Hindi puts the marker
  // somewhere English does not, and a sentence assembled from fragments cannot be checked
  // by reading it here.
  'backup.rowA11y': {
    en: 'Copy from {{date}}, {{size}} KB',
    hi: '{{date}} वाली नक़ल, {{size}} KB',
  },
  'backup.rowA11yNewest': {
    en: 'Newest copy, from {{date}}, {{size}} KB',
    hi: 'सबसे नई नक़ल, {{date}} वाली, {{size}} KB',
  },
  // Every row carries three buttons with identical labels, so out of context — which is
  // exactly how a screen reader arrives at them — "Delete This Copy" does not say which.
  'backup.shareA11y': { en: 'Send the copy from {{date}} somewhere safe', hi: '{{date}} वाली नक़ल कहीं सुरक्षित भेजिए' },
  'backup.restoreA11y': { en: 'Bring back the copy from {{date}}', hi: '{{date}} वाली नक़ल वापस लाइए' },
  'backup.deleteA11y': { en: 'Delete the copy from {{date}}', hi: '{{date}} वाली नक़ल हटाइए' },
};

type Capsule = {
  readonly name: string;
  readonly uri: string;
  readonly sizeKb: number;
  /** Null when the file is not one of ours — a renamed capsule, or one copied back in. */
  readonly stamp: CapsuleStamp | null;
};

type BackupList = {
  readonly capsules: readonly Capsule[];
  /**
   * Whether a capsule has EVER been written on this phone, from `app_meta` rather than
   * from the directory.
   *
   * The two answer different questions and the empty state needs both: the directory says
   * what is here NOW, the meta row says what happened once. Nothing decrements the meta
   * row on delete and nothing should — it records a historical fact, and a copy she sent
   * to a computer in March still exists after the local file is removed.
   */
  readonly everSaved: boolean;
};

async function loadBackups(): Promise<BackupList> {
  const capsules = listCapsules().map((file) => ({
    name: file.name,
    uri: file.uri,
    // Floored at 1: a capsule is never really 0 KB, and "0 KB" reads as a broken file.
    sizeKb: Math.max(1, Math.round(file.bytes / 1024)),
    stamp: capsuleStampFromName(file.name),
  }));
  // Documented never to throw — a missing row, a corrupt value or a database that is not
  // open yet all present as "no backup recorded", which is the safe reading here too.
  const state = await readBackupState();
  return { capsules, everSaved: state.lastCapsuleAtEpoch !== null };
}

const ROW_HEIGHT = 88;

export default function BackupScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const dates = useDateFormat();
  const { data: profileId } = useProfileId();

  const [busy, setBusy] = useState(false);
  /**
   * Set the moment a delete succeeds and never cleared.
   *
   * `everSaved` is normally enough to tell "never had a copy" from "had one, removed it",
   * but it is false on a phone whose only capsules predate that bookkeeping. This makes
   * the honest empty state appear in the session where the deletion actually happened,
   * which is the session where it needs to be read.
   */
  const [deletedInSession, setDeletedInSession] = useState(false);
  const { data, loading, reload, refresh } = useAsync(loadBackups, []);

  const capsules = useMemo(() => data?.capsules ?? [], [data]);

  /** '9 August 2026, 14:32', falling back to the filename when the name is not ours. */
  const labelFor = useCallback(
    (capsule: Capsule): string =>
      capsule.stamp ? dates.formatDateTime(capsule.stamp.localDate, capsule.stamp.localTime) : capsule.name,
    [dates],
  );

  /**
   * Which row is genuinely the newest, by the timestamp in its own name.
   *
   * NOT just the first row. `listCapsules()` sorts by filename, which is chronological
   * only for names we wrote; a file copied in from a computer under any other name can
   * sort anywhere, and labelling it "Newest copy" would be a confident lie on the one
   * screen where she is choosing which file to keep. Unparseable names claim nothing.
   * 'YYYY-MM-DD HH:MM' compares lexicographically in chronological order.
   */
  const newestUri = useMemo(() => {
    let best: { uri: string; key: string } | null = null;
    for (const capsule of capsules) {
      if (!capsule.stamp) continue;
      const key = `${capsule.stamp.localDate} ${capsule.stamp.localTime}`;
      if (!best || key > best.key) best = { uri: capsule.uri, key };
    }
    return best?.uri ?? null;
  }, [capsules]);

  const runExport = useCallback(async () => {
    if (!profileId || busy) return;
    setBusy(true);
    try {
      await exportCapsule(profileId);
      toast.show({ message: t('backup.exportDone'), variant: 'success' });
      reload();
    } catch (error) {
      console.warn('[backup] export failed', error);
      toast.show({ message: t('backup.exportFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [profileId, busy, toast, t, reload]);

  const shareCapsule = useCallback(
    async (capsule: Capsule) => {
      if (!(await Sharing.isAvailableAsync())) {
        toast.show({ message: t('backup.sharingUnavailable'), variant: 'error' });
        return;
      }
      // The OS share sheet is the consent surface: the app never picks a destination,
      // and it never touches the address book to make picking one easier.
      await Sharing.shareAsync(capsule.uri);
    },
    [toast, t],
  );

  const restoreCapsule = useCallback(
    async (capsule: Capsule, label: string) => {
      const ok = await confirm({
        // Both slots get the readable date. The message's placeholder is literally named
        // `date` and used to be handed the FILENAME, so "the copy saved on
        // aarogya-2026-08-09-1432.aarogya" is what shipped in build 8.
        title: t('backup.restoreTitle', { name: label }),
        message: t('backup.restoreMessage', { date: label }),
        confirmLabel: t('backup.restoreConfirm'),
        destructive: true,
      });
      if (!ok) return;

      setBusy(true);
      try {
        await importCapsule(capsule.uri);
        // The restored file carries a different profile row; the memoised id would
        // otherwise point at a profile that no longer exists.
        invalidateProfileCache();
        toast.show({ message: t('backup.restored'), variant: 'success' });
        router.replace('/');
      } catch (error) {
        console.warn('[backup] restore failed', error);
        toast.show({ message: t('backup.restoreFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [confirm, t, toast],
  );

  const removeCapsule = useCallback(
    async (capsule: Capsule, label: string) => {
      const remaining = capsules.length - 1;
      const ok = await confirm({
        title: t('backup.deleteTitle', { date: label }),
        message:
          remaining <= 0
            ? t('backup.deleteMessageLast')
            : remaining === 1
              ? t('backup.deleteMessageOneOther')
              : t('backup.deleteMessageOthers', { count: remaining }),
        confirmLabel: t('backup.delete'),
        cancelLabel: t('backup.deleteCancel'),
        destructive: true,
      });
      if (!ok) return;

      // No `busy` flag: the unlink is synchronous and instant, and raising `busy` would
      // put the export button into its "Making the copy" spinner for an operation that
      // is not making anything.
      //
      // AND `refresh()`, NOT `reload()`, FOR THE SAME REASON ONE STEP FURTHER. `reload()`
      // raises `loading`, and the render below branches on `loading` before it branches on
      // `capsules.length`, so the whole Card is swapped for two skeleton bars and back:
      // deleting the fourth of five copies collapses ~900dp of list to ~180dp, the
      // ScrollView clamps her offset, and she is returned to the top of the screen with a
      // success toast over it — having to find her place again to delete the next one,
      // which is the workflow this button was asked for. The list she is looking at is
      // still true except for one row; there is nothing here to put a skeleton over.
      try {
        const outcome = deleteCapsule(capsule.uri);
        setDeletedInSession(true);
        toast.show(
          outcome === 'already_absent'
            ? { message: t('backup.deleteAlreadyGone'), variant: 'info' }
            : { message: t('backup.deleted'), variant: 'success' },
        );
        refresh();
      } catch (error) {
        console.warn('[backup] delete failed', error);
        toast.show({ message: t('backup.deleteFailed'), variant: 'error' });
        // Deliberately no re-read of any kind and no optimistic removal. The file is still
        // on disk, nothing sweeps `backups/` for orphans, and a row that vanished while its
        // file survived would leave her believing she had deleted something she had not.
      }
    },
    [capsules.length, confirm, t, toast, refresh],
  );

  const hadCopyBefore = (data?.everSaved ?? false) || deletedInSession;

  return (
    <Screen variant="scroll" background="bg">
      <ScreenHeader
        title={t('backup.title')}
        subtitle={t('backup.subtitle')}
        onBack={() => router.back()}
      />

      <Button
        title={busy ? t('backup.exporting') : t('backup.export')}
        onPress={() => void runExport()}
        size="xl"
        fullWidth
        loading={busy}
        disabled={!profileId}
      />

      <SectionHeader title={t('backup.savedCopies')} />

      {loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={ROW_HEIGHT} />
          <Skeleton height={ROW_HEIGHT} />
        </View>
      ) : capsules.length > 0 ? (
        <Card>
          {capsules.map((capsule, index) => {
            const label = labelFor(capsule);
            const isNewest = capsules.length > 1 && capsule.uri === newestUri;
            return (
              <View key={capsule.uri}>
                {index > 0 ? <Divider /> : null}
                <View style={{ minHeight: ROW_HEIGHT, justifyContent: 'center', gap: spacing.sm }}>
                  {/* The DATE is the identity; the filename drops to the caption line so a
                      row can still be matched against what a file manager shows — and is
                      left OUT of the spoken sentence for exactly that reason. See
                      `backup.rowA11y`. */}
                  <ListRow
                    title={label}
                    subtitle={t('backup.bytes', { size: capsule.sizeKb })}
                    meta={isNewest ? t('backup.metaNewest', { name: capsule.name }) : capsule.name}
                    accessibilityLabel={t(isNewest ? 'backup.rowA11yNewest' : 'backup.rowA11y', {
                      date: label,
                      size: capsule.sizeKb,
                    })}
                    showChevron={false}
                  />
                  <View style={{ flexDirection: 'row', gap: spacing.md }}>
                    <Button
                      title={t('backup.share')}
                      onPress={() => void shareCapsule(capsule)}
                      variant="secondary"
                      size="md"
                      disabled={busy}
                      accessibilityLabel={t('backup.shareA11y', { date: label })}
                      style={{ flex: 1 }}
                    />
                    <Button
                      title={t('backup.restore')}
                      onPress={() => void restoreCapsule(capsule, label)}
                      variant="destructive"
                      size="md"
                      disabled={busy}
                      accessibilityLabel={t('backup.restoreA11y', { date: label })}
                      style={{ flex: 1 }}
                    />
                  </View>
                  {/* Own line, secondary, its own glyph, and NOT full width — see decision
                      2 in the header. Every button here is still 56dp tall (`size="md"` is
                      `spacing.touchTarget`); what changes is that this one cannot be hit
                      by a thumb aiming at the destructive control above it. Disabled while
                      an export or a restore is in flight: the first is writing into this
                      directory, the second is replacing the database underneath it. */}
                  <View style={{ paddingBottom: spacing.md }}>
                    <Button
                      title={t('backup.delete')}
                      onPress={() => void removeCapsule(capsule, label)}
                      variant="secondary"
                      icon="close"
                      size="md"
                      disabled={busy}
                      accessibilityLabel={t('backup.deleteA11y', { date: label })}
                    />
                  </View>
                </View>
              </View>
            );
          })}
        </Card>
      ) : (
        <EmptyState
          title={hadCopyBefore ? t('backup.noCopiesLeft') : t('backup.noCopies')}
          message={hadCopyBefore ? t('backup.noCopiesLeftMessage') : t('backup.noCopiesMessage')}
        />
      )}

      <View style={{ paddingTop: spacing.xl }}>
        <Text variant="caption" tone="muted">
          {t('settings.privacy')}
        </Text>
      </View>
    </Screen>
  );
}
