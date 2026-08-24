/**
 * Boot.
 *
 * Everything that must be true before the app can be trusted happens here, in order,
 * and NOTHING is rendered until it has:
 *
 *   1. Decide whether technical notes are being kept, and install the global error
 *      recorder. Costs one AsyncStorage read, touches no database, and stores nothing at
 *      all unless a human turned the toggle on — and it is FIRST so that step 2 is inside
 *      the part of the launch that can be observed.
 *   2. Open the database and run migrations. This is the only copy of the record.
 *   3. Seed the metric/symptom/lab registry. `createReading()` refuses an unknown
 *      metric_key, so without this the four entry tiles cannot write anything.
 *   4. Drain the native journal. Kotlin wrote one small file per dose the user answered
 *      from a notification while the JS side was not running; those are real recorded
 *      outcomes and they must land before any screen reads a status, or Today shows a
 *      dose as un-recorded that she answered at 06:00.
 *   5. Reconcile. Re-materialises occurrences and re-arms the alarms. Idempotent.
 *   6. Route.
 *
 * The order of 4 before 5 is load-bearing: reconcile refuses to retire an occurrence
 * that carries a recorded outcome, so the journal has to be ingested first or a dose she
 * answered can be cancelled out from under her.
 *
 * The order of 1 before 2 is load-bearing for a different reason, written out beside the
 * call: a migration failure is the most valuable error this app can produce and the one it
 * was structurally incapable of recording.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Button, Icon, Screen, Skeleton, Text } from '@/components/ui';
import { openDatabase } from '@/db';
import {
  flushDevLog,
  hydrateDevLogFromMirror,
  initDevLog,
  installGlobalErrorRecorder,
  recordAppError,
} from '@/features/devlog';
import { drainJournal } from '@/features/dosing/journalDrain';
import { reconcile } from '@/features/dosing/reconcile';
import {
  sweepOrphanBriefcaseFiles,
  sweepOrphanPrescriptionPhotos,
  sweepPendingFileDeletes,
} from '@/features/files/sweeper';
import { repairPrescriptionPhotos } from '@/features/prescriptions/photoStore';
import { syncOnAppOpen } from '@/features/sync';

import {
  META_SETUP_DONE,
  ensureRegistrySeeded,
  getAppRole,
  getMeta,
  invalidateProfileCache,
  resolveProfileId,
  useAsync,
  useT,
  type LocalStrings,
} from './_shared/lib';

const STRINGS: LocalStrings = {
  'boot.preparing': { en: 'Getting things ready', hi: 'तैयारी हो रही है' },
  'boot.failedTitle': { en: 'Aarogya could not start', hi: 'आरोग्य शुरू नहीं हो सका' },
  'boot.failedMessage': {
    en: 'Nothing you recorded has been lost. Try again, and if this keeps happening, show this screen to someone who can help.',
    hi: 'आपका दर्ज किया हुआ कुछ भी नहीं गया है। दोबारा कोशिश कीजिए, और अगर यह बार-बार हो तो यह स्क्रीन किसी मदद करने वाले को दिखाइए।',
  },
};

type Destination = '/(tabs)' | '/setup' | '/(viewer)';

async function boot(): Promise<Destination> {
  // ── THE DEVELOPER LOG IS HYDRATED BEFORE ANYTHING ELSE HAPPENS ──
  //
  // `features/devlog/recorder.ts` states in its own header that boot does this. It did
  // not. The recorder keeps a synchronous `enabled` mirror of a stored preference because
  // `record()` must cost a boolean read, and hydrating that mirror is the ONLY thing that
  // fills it. Without it the mirror stayed `false` for the whole launch unless she happened
  // to open Settings, which meant the switch her son turned on yesterday recorded NOTHING
  // today — and the one thing he asked to debug, a prescription scan, is something she can
  // start without going near Settings.
  //
  // AND IT HAPPENS BEFORE `openDatabase()`, WHICH IS THE PART THAT WAS WRONG.
  //
  // The obvious place for this is next to the database, because the preference lives in an
  // `app_meta` row. That ordering silently put the most valuable errors in the app out of
  // reach of the log: opening the database runs migrations, takes a `VACUUM INTO` snapshot,
  // and then runs `integrity_check` and `foreign_key_check` over the result. Every one of
  // those can fail on a phone whose health record is the only copy in existence, and none
  // of them could ever be recorded, because the thing that decides whether to record had
  // not been allowed to run yet. `hydrateDevLogFromMirror()` reads an AsyncStorage mirror
  // of the same preference instead — no SQLite, nothing that can fail in the way we are
  // trying to observe. `initDevLog()` below still gives `app_meta` the final word.
  //
  // Awaited, because everything after this line is worth logging. It never throws (an
  // unreadable mirror leaves recording off, which is the fail-closed direction) so it
  // cannot become a reason the app will not start, and it stores nothing whatsoever unless
  // a human turned the toggle on.
  await hydrateDevLogFromMirror();

  // The "and all other error logs of app" half of the same request. Chains onto React
  // Native's global handler and always calls the previous one, so the red box in
  // development and the ErrorBoundary in production both behave exactly as before. Records
  // nothing at all while the toggle is off.
  //
  // The returned uninstaller is discarded ON PURPOSE, and that is only safe because
  // installing is idempotent (see `installGlobalErrorRecorder` in devlog/store.ts). This
  // function is re-entered every time the retry button below is pressed and on every fast
  // refresh, and before the guard existed each of those chained another handler onto the
  // last one — one crash recorded four times after three retries.
  installGlobalErrorRecorder();

  try {
    await openDatabase();
  } catch (error) {
    // The failure this whole reordering exists for: a migration that rolled back, an
    // integrity check that came back with something other than 'ok', a database from a
    // future version. The screen below shows `error.message` and can be photographed, but
    // the log is what survives to the next launch and can be shared as text — so the note
    // is written and pushed straight to disk before the throw, because nothing after this
    // line is going to get the chance.
    //
    // WORTH KNOWING: this is not the first `openDatabase()` of the process. `AppLock` in
    // _layout.tsx reads one `app_meta` row to decide whether to ask for a fingerprint, and
    // it holds `<Stack>` unmounted until that read finishes — so the migration has already
    // been attempted once, before this screen mounted. That attempt hydrates the log
    // mirror first and records its own failure as `lock/openDatabase`, so a TRANSIENT
    // failure — one that succeeds on the retry below and would otherwise be survived in
    // total silence — is in the log too. `db` is only assigned on success, so the line
    // above genuinely re-runs the whole open-and-migrate path rather than returning a
    // handle, which is why a deterministic failure arrives here as well and is worth
    // recording twice: two notes with the same message are how you tell the two apart.
    recordAppError(error, 'boot/openDatabase');
    flushDevLog();
    throw error;
  }

  // The stored preference, from the row that owns it — the authority the mirror is only a
  // cache of. Correcting one against the other is `initDevLog()`'s job, including on the
  // upgrade where the toggle was turned on by a build that had no mirror to write.
  await initDevLog();

  await ensureRegistrySeeded();

  // A failed drain must not stop the app from opening — the journal files are not
  // deleted until their transaction commits, so anything left behind is retried on the
  // next cold start rather than lost.
  try {
    await drainJournal();
  } catch (error) {
    console.warn('[boot] journal drain failed; entries stay on disk for the next start', error);
    // Console alone is a cable and a laptop away. A drain that keeps failing is a dose she
    // answered from a notification not appearing on Today, which is exactly the shape of
    // report this log exists to make answerable from the phone.
    recordAppError(error, 'boot/drainJournal');
  }

  invalidateProfileCache();
  const profileId = await resolveProfileId();
  const role = await getAppRole();

  if (role === 'viewer') return '/(viewer)';
  if (!profileId) return '/setup';

  const setupDone = (await getMeta(META_SETUP_DONE)) === '1';
  if (!setupDone) return '/setup';

  try {
    await reconcile(profileId);
  } catch (error) {
    // Reminders may now be stale, which is exactly what the Reminder Health Check is
    // for. Blocking the app on it would leave her unable to record anything at all.
    console.warn('[boot] reconcile failed; the reminder health check will surface this', error);
    recordAppError(error, 'boot/reconcile');
  }

  // Fire-and-forget, deliberately NOT awaited. Sharing is the only part of this app that
  // touches the network, and on a poor connection publishing can hang for tens of seconds.
  // Blocking first paint on it would leave her looking at a spinner because of a feature
  // she may not even use. It no-ops immediately when sharing was never configured, which is
  // every install until somebody turns it on.
  void syncOnAppOpen();

  // Finishes any file deletion that was interrupted between its transaction committing and
  // the bytes being unlinked — the app killed mid-delete, which on MIUI is routine. Also
  // fire-and-forget: the queue is empty on almost every boot, and a briefcase document she
  // removed last week must not be able to delay Today by so much as a frame. The briefcase
  // screens sweep too, so nothing waits for a boot when she is watching.
  //
  // The two orphan sweeps run BEFORE the unlink sweep, which then drains what they queued,
  // so a file stranded by a save that was killed between the copy and the row is gone in one
  // boot rather than two. They are boot-only on purpose: the briefcase screens sweep the
  // queue after a delete, but reconciling a whole directory against a whole table is a
  // start-up job, not something to do while she is looking at a list.
  //
  // The photo repair runs FIRST OF ALL FOUR, and the ordering is load-bearing in the one
  // direction that can lose a photograph. `repairPrescriptionPhotos()` copies prescription
  // pages that older builds left in the picker's cache into `Paths.document/prescriptions`
  // and only THEN re-points the rows at the copies; `sweepOrphanPrescriptionPhotos()` queues
  // for deletion every file in that directory no row claims. Sweeping first would look at a
  // store the repair had not finished re-pointing into and see freshly copied pages as
  // unclaimed — which is not an untidy directory, it is her prescription. Awaited in
  // sequence, they cannot interleave; the sweep's ten-minute age floor is the second guard.
  //
  // Why the repair is here at all: prescriptions written before the photo store existed
  // point into a directory Android empties whenever it wants the space, and there is no
  // server and no cloud copy to get that photograph back from. It was fired from the
  // capture screen's mount, which rescued a photograph only if she happened to open the
  // one screen the bug was found on — and the phones where the cache is purged are exactly
  // the phones nobody opens a camera screen on twice. It is idempotent, it never throws,
  // and on the overwhelmingly common phone it is two small reads that find nothing to do.
  void (async () => {
    await repairPrescriptionPhotos();
    await sweepOrphanBriefcaseFiles();
    await sweepOrphanPrescriptionPhotos();
    await sweepPendingFileDeletes();
  })();

  return '/(tabs)';
}

export default function BootScreen() {
  const { colors } = useTheme();
  const t = useT(STRINGS);
  const { data, error, reload } = useAsync(boot, []);
  const navigated = useRef(false);

  // `replace`, never `push`: the boot screen must not be reachable with the hardware
  // back button, or backing out of Today re-runs the whole migration path. The ref
  // makes it exactly-once even if this component re-renders mid-transition.
  useEffect(() => {
    if (!data || navigated.current) return;
    navigated.current = true;
    router.replace(data);
  }, [data]);

  const retry = useCallback(() => {
    navigated.current = false;
    reload();
  }, [reload]);

  if (error) {
    return (
      <Screen variant="scroll" background="bg">
        <View style={{ paddingTop: spacing.xxxl, gap: spacing.lg }}>
          <Icon name="alert" size={44} color={colors.attention} strokeWidth={1.8} />
          <Text variant="title" accessibilityRole="header">
            {t('boot.failedTitle')}
          </Text>
          <Text variant="body">{t('boot.failedMessage')}</Text>
          {/* Selectable so the exact message can be copied out or photographed — the
              migration guard's text names the version mismatch precisely. */}
          <Text variant="caption" tone="muted" selectable>
            {error.message}
          </Text>
          <Button title={t('common.retry')} onPress={retry} size="lg" fullWidth />
        </View>
      </Screen>
    );
  }

  return (
    <Screen variant="fixed" background="bg">
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.lg }}>
        <Skeleton label={t('boot.preparing')} height={28} width="60%" />
        <Skeleton height={20} width="85%" />
        <Skeleton height={20} width="45%" />
        <Text variant="body" tone="muted" accessibilityLiveRegion="polite">
          {t('boot.preparing')}
        </Text>
      </View>
    </Screen>
  );
}
