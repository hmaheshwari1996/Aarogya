/**
 * Adding a prescription, one page at a time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO DOORS, ONE FLOW
 *
 * The camera is not where most prescriptions actually are. By the time this app is
 * installed the paper has usually already been photographed at the clinic, forwarded on
 * WhatsApp by a son, or downloaded from a hospital portal — and a screen that can only
 * shoot makes her re-photograph a photo, on a screen, at an angle, badly.
 *
 * So "Choose a photo" sits beside "Take the photo" as a peer, not as a fallback link
 * underneath it, and a chosen photo is a PAGE in exactly the same sense a shot one is: it
 * lands on the same verdict screen, it moves the same counter, and Done cannot tell them
 * apart. The only thing the source changes is the wording of the button that rejects a
 * page — "Take it again" for the camera, "Choose a different photo" for the gallery —
 * because a control that reopens the wrong picker is a control she stops trusting.
 *
 * A gallery pick may return SEVERAL photos, because a two-page prescription is two photos
 * in the gallery. They queue: the first goes to the verdict screen and the rest wait
 * behind it, and each one is still looked at individually. Nothing skips the verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT NEVER AUTO-ADVANCES, AND THAT IS THE WHOLE DESIGN
 *
 * The obvious camera flow — shoot, thumbnail slides in, camera reopens for the next page
 * — is exactly wrong here. Auto-advance means a page she has never actually looked at,
 * and a page she has never looked at is a blurred line, a thumb over the dosage column,
 * a medicine she has not checked. Every shot therefore stops dead on a large preview
 * with two answers, "Use this page" and "Take it again", and the page counter only moves
 * when she says the page is good.
 *
 * The counter is deliberately visible and literal ("Page 1 of 3"), because the second
 * failure mode of a multi-page capture is a page silently missing from the set.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "USE THIS PAGE" IS WHERE THE PHOTOGRAPH BECOMES A FILE THIS APP OWNS
 *
 * `expo-image-picker` does not hand back the photograph. It hands back a copy the picker
 * wrote into the app's CACHE directory, for the camera and the gallery alike, and Android
 * empties that directory whenever the phone is short of storage — without asking and
 * without telling us. This screen used to store that URI straight into the row, so the
 * prescription survived and the photograph did not; see the header of
 * `src/features/prescriptions/photoStore.ts` for the full account, including why the
 * backup capsule never contained a single prescription photograph either.
 *
 * So `keepPending` COPIES the photograph into app-owned storage and it is that URI, never
 * the picker's, that reaches `pages` and therefore the database.
 *
 * IT HAPPENS AT THE VERDICT AND NOT AT THE SHUTTER, deliberately:
 *
 *   • A photograph she rejects is never copied at all. A gallery pick of eight photos of
 *     which she keeps two would otherwise write eight files — on a phone short enough of
 *     space to be purging its cache in the first place, which is the whole problem.
 *   • A copy that fails is reported while she is still looking at the page, with both
 *     answers already on screen: try again, or take it again. A failure at Done, after
 *     four pages, would be a failure with nothing useful to offer.
 *   • The window it leaves open — the seconds between the picker returning and her
 *     verdict — is the shortest one available without copying photographs she throws away.
 *
 * WHAT THAT COSTS, AND WHO PAYS IT BACK: a page that is copied and then abandoned is bytes
 * on the disk that no row references. Every path this screen owns cleans up after itself —
 * a removed page, a discarded capture — and the one it cannot own, the app being killed
 * mid-capture, is named at the end of `photoStore.ts` along with the sweep that should
 * collect it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { setMetaJson, useProfileId, useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Divider,
  Screen,
  ScreenHeader,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { createPrescription } from '@/db/repositories/prescriptions';
import {
  PRESCRIPTION_PAGES_META_PREFIX,
  discardPrescriptionPhoto,
  isPrescriptionPhotoError,
  persistPrescriptionPhoto,
} from '@/features/prescriptions/photoStore';

/**
 * Where the pages after the first one live.
 *
 * `prescription` has exactly two image columns (`image_uri`, `cropped_image_uri`) and no
 * page table. Page 1 goes in `image_uri` so every other screen's thumbnail keeps working
 * unchanged, and the full ordered list is kept in `app_meta` under this prefix. It is a
 * side table in all but name, it travels inside the same database file the backup capsule
 * exports, and it costs no migration owned by another agent.
 *
 * DECLARED IN `photoStore.ts` AND RE-EXPORTED HERE, unchanged for the two screens that
 * import it from this file. The store has to read and write that key to delete a
 * prescription's photographs and to repair the ones written before it existed, and a
 * feature module that imports a screen drags React and expo-router in behind it — the same
 * reason `BRIEFCASE_DIR_NAME` lives in `features/files/sweeper.ts` and is re-exported by
 * `src/app/briefcase/_lib.tsx`.
 */
export { PRESCRIPTION_PAGES_META_PREFIX };

const STRINGS: LocalStrings = {
  'prescription.capture.instruction': {
    en: 'Add one page at a time — take a photo, or choose one already on this phone. Look at each page before you keep it.',
    hi: 'एक बार में एक पेज जोड़ें — फोटो लें, या इस फोन में पहले से मौजूद फोटो चुनें। रखने से पहले हर पेज को देख लें।',
  },
  'prescription.capture.shutterFirst': { en: 'Take the photo', hi: 'फोटो लें' },
  'prescription.capture.shutterNext': { en: 'Take page {{n}}', hi: 'पेज {{n}} की फोटो लें' },
  'prescription.capture.choosePhoto': { en: 'Choose a photo', hi: 'फोटो चुनें' },
  'prescription.capture.chooseAnother': { en: 'Choose a different photo', hi: 'दूसरी फोटो चुनें' },
  'prescription.capture.dontUsePage': { en: 'Do not use this photo', hi: 'यह फोटो न रखें' },
  'prescription.capture.moreWaiting': {
    en: '{{count}} more to look at after this one.',
    hi: 'इसके बाद {{count}} और देखनी हैं।',
  },
  'prescription.capture.checkPage': {
    en: 'Can you read this page?',
    hi: 'क्या यह पेज पढ़ा जा रहा है?',
  },
  'prescription.capture.checkPageHelp': {
    en: 'The medicine names and the timings must be sharp. If they are not, take it again.',
    hi: 'दवाइयों के नाम और समय साफ़ दिखने चाहिए। अगर नहीं दिख रहे तो फिर से फोटो लें।',
  },
  'prescription.capture.usePage': { en: 'Use this page', hi: 'यह पेज रखें' },
  'prescription.capture.pageOf': { en: 'Page {{n}} of {{total}}', hi: 'पेज {{n}}, कुल {{total}} में से' },
  'prescription.capture.newPage': { en: 'New page', hi: 'नया पेज' },
  'prescription.capture.pagesSoFar': { en: 'Pages added so far', hi: 'अब तक जोड़े गए पेज' },
  'prescription.capture.nothingYet': {
    en: 'No page has been added yet.',
    hi: 'अभी कोई पेज नहीं जोड़ा गया।',
  },
  'prescription.capture.pageLabel': { en: 'Photo of page {{n}}', hi: 'पेज {{n}} की फोटो' },
  'prescription.capture.removePage': { en: 'Remove page {{n}}', hi: 'पेज {{n}} हटाएँ' },
  'prescription.capture.removeTitle': { en: 'Remove page {{n}}?', hi: 'पेज {{n}} हटाएँ?' },
  'prescription.capture.removeMessage': {
    en: 'The photo is removed from this prescription. You can take it again.',
    hi: 'यह फोटो इस पर्चे से हट जाएगी। आप दोबारा ले सकती हैं।',
  },
  'prescription.capture.cameraFailed': {
    en: 'The camera did not open. Please try once more.',
    hi: 'कैमरा नहीं खुला। एक बार फिर कोशिश करें।',
  },
  'prescription.capture.libraryFailed': {
    en: 'Your photos did not open. Please try once more.',
    hi: 'आपकी फोटो नहीं खुलीं। एक बार फिर कोशिश करें।',
  },
  'prescription.capture.libraryDenied': {
    en: 'Aarogya is not allowed to open your photos. You can turn it on in phone settings.',
    hi: 'आरोग्य को आपकी फोटो खोलने की अनुमति नहीं है। आप इसे फोन सेटिंग में चालू कर सकती हैं।',
  },
  'prescription.capture.saveFailed': {
    en: 'The photos could not be saved. Please try once more.',
    hi: 'फोटो सेव नहीं हो पाईं। एक बार फिर कोशिश करें।',
  },
  // ── When keeping a page cannot be done ─────────────────────────────────────
  // Three sentences rather than one, because the three failures need three different
  // things from her and a single "could not save" would leave her pressing the same
  // button forever. Each one says what happened and what to do next, in that order.
  'prescription.capture.keepNoSpace': {
    en: 'There is not enough space on this phone to keep the photo. Please remove something from the phone, then press Use this page again.',
    hi: 'इस फोन में फोटो रखने के लिए जगह नहीं है। फोन से कुछ हटाएँ, फिर "यह पेज रखें" दोबारा दबाएँ।',
  },
  'prescription.capture.keepGoneCamera': {
    en: 'This photo is no longer on the phone. Please take it again.',
    hi: 'यह फोटो अब फोन में नहीं है। कृपया दोबारा फोटो लें।',
  },
  'prescription.capture.keepGoneLibrary': {
    en: 'This photo is no longer on the phone. Please choose it again.',
    hi: 'यह फोटो अब फोन में नहीं है। कृपया इसे दोबारा चुनें।',
  },
  'prescription.capture.keepFailed': {
    en: 'This page could not be kept. Please press Use this page again, or take the photo again.',
    hi: 'यह पेज रखा नहीं जा सका। "यह पेज रखें" दोबारा दबाएँ, या फिर से फोटो लें।',
  },
  'prescription.capture.noProfile': {
    en: 'Finish setting up Aarogya before adding a prescription.',
    hi: 'पर्चा जोड़ने से पहले आरोग्य की शुरुआती सेटिंग पूरी कर लें।',
  },
  'prescription.capture.doneHint': {
    en: 'Press Done when every page of the prescription has been added.',
    hi: 'जब पर्चे का हर पेज जुड़ जाए, तब Done दबाएँ।',
  },
};

/**
 * How many gallery photos one pick may return.
 *
 * A cap, not a target. Without one, a long-press "select all" in the system picker hands
 * back several hundred holiday photos and the verdict screen becomes a punishment; a
 * prescription that genuinely runs past this can simply be picked twice.
 */
const MAX_PICK_AT_ONCE = 8;

/** A photo awaiting her verdict. It is NOT a page yet, and it remembers where it came from. */
type PendingShot = { readonly uri: string; readonly source: 'camera' | 'library' };

/**
 * The one sentence for a copy that did not happen.
 *
 * `source_gone` is worded for the door the photo came through, exactly as the rejection
 * button is: telling a woman who chose a photo from her gallery to "take it again" sends
 * her to the wrong screen looking for a piece of paper she may have already given back.
 *
 * Anything that is not a `PrescriptionPhotoError` — a bug in this screen, a native module
 * that threw something unexpected — lands on the generic sentence rather than on nothing,
 * because a button that quietly does not work is the worst of the available outcomes.
 */
function keepFailureMessage(
  error: unknown,
  source: PendingShot['source'],
  t: (key: string) => string,
): string {
  if (isPrescriptionPhotoError(error)) {
    if (error.reason === 'no_space') return t('prescription.capture.keepNoSpace');
    if (error.reason === 'source_gone') {
      return source === 'camera'
        ? t('prescription.capture.keepGoneCamera')
        : t('prescription.capture.keepGoneLibrary');
    }
  }
  return t('prescription.capture.keepFailed');
}

/**
 * Which action currently owns the screen, so only that button spins.
 *
 * `keeping` is the file copy behind "Use this page" and it is its own kind rather than
 * borrowing `saving`: they sit on two different screens, and a shared flag would spin the
 * Done button on a screen that is not visible while the verdict's primary sat inert.
 */
type BusyKind = 'camera' | 'library' | 'keeping' | 'saving';

export default function PrescriptionCaptureScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const { colors } = useTheme();
  const profile = useProfileId();
  const profileId = profile.data;

  // THE ONE-TIME PHOTO REPAIR IS NOT FIRED HERE ANY MORE. It ran on this screen's mount
  // because the batch that wrote it did not own `boot()`, which made rescuing a
  // photograph conditional on her opening the one screen the bug was found on — and the
  // phones whose cache Android purges are exactly the phones nobody opens a camera screen
  // on twice. `boot()` in `src/app/index.tsx` runs it now, before the orphan sweep, on
  // every cold start. Do not add it back: it walks the store and every page list, and
  // repeating that on the mount of a screen she is about to take a photograph with is
  // disk work charged to the moment she is watching.

  /**
   * Pages she has looked at and kept. The counter is derived from this and nothing else.
   *
   * Every URI in here is a file in the app's own storage — copied by `keepPending`, never
   * one the picker handed back. Nothing else may push onto this array.
   */
  const [pages, setPages] = useState<string[]>([]);
  /** The shot waiting for her verdict. It is NOT a page yet. */
  const [pending, setPending] = useState<PendingShot | null>(null);
  /**
   * The rest of a multi-photo gallery pick, still queued behind `pending`.
   *
   * Non-empty implies `pending` is set: the queue is only ever filled alongside a first
   * pending photo, and it is drained one at a time by `advance()`.
   */
  const [queue, setQueue] = useState<string[]>([]);
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const [libraryBlocked, setLibraryBlocked] = useState(false);
  const [busy, setBusy] = useState<BusyKind | null>(null);
  /**
   * The id of the row this screen has already written, if Done got that far.
   *
   * `finish` is two writes — the row, then the page list — and only the pair is useful. A
   * failure between them used to leave a row referencing page 1 with no list beside it, and
   * a second press of Done then wrote a SECOND prescription over the same photographs. Two
   * rows sharing one set of files is the state that makes deleting either of them
   * dangerous — see guard 2 in `deletePrescriptionWithPhotos` — so the id is remembered and
   * the retry finishes the row that exists instead of minting another.
   */
  const [savedId, setSavedId] = useState<string | null>(null);

  const shoot = useCallback(async () => {
    setBusy('camera');
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        // A refusal is not a dead end: the banner below carries the sentence AND the
        // route into phone settings, because "the camera is not allowed" with no way to
        // allow it is where this user stops using the feature for good.
        setCameraBlocked(true);
        return;
      }
      setCameraBlocked(false);

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        // Below ~0.8 the dosage column on a ballpoint prescription stops being legible.
        quality: 0.85,
        exif: false,
      });
      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        toast.show({ message: t('prescription.capture.cameraFailed'), variant: 'error' });
        return;
      }
      setPending({ uri: asset.uri, source: 'camera' });
    } catch {
      toast.show({ message: t('prescription.capture.cameraFailed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [t, toast]);

  const pick = useCallback(async () => {
    setBusy('library');
    try {
      // Asked for even though Android 13+ often satisfies the system photo picker without
      // it: the point of asking is that a REFUSAL becomes a banner with a way out, rather
      // than a big button that opens nothing and explains nothing.
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setLibraryBlocked(true);
        return;
      }
      setLibraryBlocked(false);

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // 0.85, matching the camera path above, and for the reason documented there:
        // below ~0.8 the dosage column on a ballpoint prescription stops being legible.
        // A gallery photo feeds exactly the same extraction as a freshly shot one, so
        // the two paths must not disagree about how much detail is worth keeping.
        quality: 0.85,
        // A two-page prescription is two photos in the gallery, and making her come back
        // to this screen between them is how the second page goes missing.
        allowsMultipleSelection: true,
        selectionLimit: MAX_PICK_AT_ONCE,
      });
      if (result.canceled) return;

      const uris = (result.assets ?? []).map((asset) => asset.uri).filter(Boolean);
      const [first, ...rest] = uris;
      if (!first) {
        toast.show({ message: t('prescription.capture.libraryFailed'), variant: 'error' });
        return;
      }
      setPending({ uri: first, source: 'library' });
      setQueue(rest);
    } catch {
      toast.show({ message: t('prescription.capture.libraryFailed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [t, toast]);

  /** Retires the current pending photo and pulls the next queued one into its place. */
  const advance = useCallback(() => {
    const [next, ...rest] = queue;
    setQueue(rest);
    setPending(next ? { uri: next, source: 'library' } : null);
  }, [queue]);

  /**
   * She has said the page is good.
   *
   * The photograph is copied out of the picker's cache and into app-owned storage BEFORE
   * it becomes a page, and it is the copy's URI that is kept. See the header for why the
   * copy happens at this moment and not at the shutter.
   *
   * THE COUNTER MOVES ONLY ON A COPY THAT SUCCEEDED. A page in the list is a promise that
   * the photograph is on this phone and will still be there tomorrow; adding one on a
   * failed copy would keep that promise for about as long as it took her to walk out of
   * the clinic. On a failure she stays exactly where she is, with the same photograph on
   * screen and both answers still available — press it again, or take it again.
   */
  const keepPending = useCallback(async () => {
    if (!pending || busy !== null) return;
    setBusy('keeping');
    try {
      const storedUri = await persistPrescriptionPhoto(pending.uri);
      setPages((current) => [...current, storedUri]);
      advance();
    } catch (error) {
      toast.show({ message: keepFailureMessage(error, pending.source, t), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [advance, busy, pending, t, toast]);

  /**
   * She has said no to the photo on screen.
   *
   * With a queue behind it this just means "not this one" and the next queued photo comes
   * forward — reopening a picker mid-batch would throw away the photos she already chose.
   * With nothing queued it means "give me another", and it reopens whichever door this
   * photo came through.
   */
  const rejectPending = useCallback(() => {
    if (queue.length > 0) {
      advance();
      return;
    }
    const source = pending?.source ?? 'camera';
    setPending(null);
    if (source === 'camera') void shoot();
    else void pick();
  }, [advance, pending, pick, queue.length, shoot]);

  const removePage = useCallback(
    async (index: number) => {
      const target = pages[index];
      if (target === undefined) return;
      const ok = await confirm({
        title: t('prescription.capture.removeTitle', { n: index + 1 }),
        message: t('prescription.capture.removeMessage'),
        confirmLabel: t('common.remove'),
        destructive: true,
      });
      if (!ok) return;
      // Matched on the URI as well as the index. The dialog is modal so the list cannot
      // move underneath it today, and a removal that deletes the wrong photograph because
      // one day it can is not a bug anybody would find twice.
      setPages((current) => current.filter((uri, i) => !(i === index && uri === target)));
      // Unlinked directly rather than through `pending_file_delete`, and the difference is
      // that no row exists yet: the durable queue records "this path must not survive its
      // row", and there is no row to record it against. Best effort, and a file that
      // survives anyway is collected by the orphan sweep named in `photoStore.ts`.
      discardPrescriptionPhoto(target);
    },
    [confirm, pages, t],
  );

  const finish = useCallback(async () => {
    if (!profileId || pages.length === 0) return;
    setBusy('saving');
    try {
      const id = savedId ?? (await createPrescription({ profileId, imageUri: pages[0] ?? null }));
      setSavedId(id);
      await setMetaJson(`${PRESCRIPTION_PAGES_META_PREFIX}${id}`, pages);
      // replace, not push: coming back to a capture screen whose pages have already been
      // written would offer to write them a second time.
      router.replace(`/prescription/${id}`);
    } catch {
      toast.show({ message: t('prescription.capture.saveFailed'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [pages, profileId, savedId, t, toast]);

  const leave = useCallback(async () => {
    if (pages.length > 0 || pending) {
      const ok = await confirm({
        title: t('entry.common.discardTitle'),
        message: t('entry.common.discardMessage'),
        confirmLabel: t('entry.common.discardConfirm'),
        destructive: true,
      });
      if (!ok) return;
      // She has said the capture is being thrown away, so the photographs copied for it go
      // with it. Skipped when a row has already been written, because at that point the
      // files belong to a prescription that exists and deleting them would empty it.
      if (savedId === null) {
        for (const uri of pages) discardPrescriptionPhoto(uri);
      }
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [confirm, pages, pending, savedId, t]);

  // ── The verdict on one shot. Nothing else is on screen while it is open. ──────
  if (pending) {
    return (
      <Screen
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('prescription.capture.usePage')}
              onPress={() => void keepPending()}
              variant="primary"
              size="xl"
              fullWidth
              loading={busy === 'keeping'}
            />
            {/* The rejection is labelled for the door this photo came through, and for
                whether there are more behind it. A "Take it again" that reopens the
                gallery — or throws away six photos she just chose — is a lie.
                Disabled only while the copy is in flight: rejecting a photograph that is
                halfway into app storage would leave the file with nothing to reference it
                and, on a slow phone, still add the page a moment later. */}
            <Button
              title={
                queue.length > 0
                  ? t('prescription.capture.dontUsePage')
                  : pending.source === 'camera'
                    ? t('prescription.retake')
                    : t('prescription.capture.chooseAnother')
              }
              onPress={rejectPending}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={busy === 'keeping'}
            />
          </View>
        }
      >
        <ScreenHeader
          title={t('prescription.capture.checkPage')}
          subtitle={t('prescription.capture.checkPageHelp')}
        />
        <Image
          source={{ uri: pending.uri }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={t('prescription.capture.pageLabel', { n: pages.length + 1 })}
          resizeMode="contain"
          style={{
            width: '100%',
            aspectRatio: 3 / 4,
            borderRadius: radii.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bgSunken,
          }}
        />
        <Text variant="label" align="center" style={{ paddingTop: spacing.md }}>
          {t('prescription.capture.newPage')}
        </Text>
        {/* Same reason the page counter is literal: a batch that silently has more coming
            is a batch she stops halfway through, believing she is finished. */}
        {queue.length > 0 ? (
          <Text variant="body" tone="muted" align="center" style={{ paddingTop: spacing.xs }}>
            {t('prescription.capture.moreWaiting', { count: queue.length })}
          </Text>
        ) : null}
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <View style={{ gap: spacing.md }}>
          {/* Two peers, same variant and same size, stacked rather than sat side by side:
              at 1.25× text a half-width xl button wraps "Take the photo" onto three lines,
              and a control whose height depends on the font scale is the one she misses. */}
          <Button
            title={
              pages.length === 0
                ? t('prescription.capture.shutterFirst')
                : t('prescription.capture.shutterNext', { n: pages.length + 1 })
            }
            onPress={() => void shoot()}
            variant="primary"
            size="xl"
            fullWidth
            loading={busy === 'camera'}
            disabled={!profileId || (busy !== null && busy !== 'camera')}
          />
          <Button
            title={t('prescription.capture.choosePhoto')}
            onPress={() => void pick()}
            variant="primary"
            size="xl"
            fullWidth
            loading={busy === 'library'}
            disabled={!profileId || (busy !== null && busy !== 'library')}
          />
          {/* Done is always explicit. There is no page count at which the app decides
              she has finished. */}
          <Button
            title={t('common.done')}
            onPress={() => void finish()}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={pages.length === 0 || busy !== null || !profileId}
          />
        </View>
      }
    >
      <ScreenHeader
        title={t('prescription.photograph')}
        subtitle={t('prescription.capture.instruction')}
        onBack={() => void leave()}
      />

      {!profile.loading && !profileId ? (
        <Banner variant="attention" title={t('prescription.capture.noProfile')} />
      ) : null}

      {cameraBlocked ? (
        <Banner
          variant="attention"
          title={t('errors.permissionDenied')}
          message={t('errors.cameraDenied')}
          actionLabel={t('healthCheck.openSettings')}
          onAction={() => void Linking.openSettings()}
          style={{ marginBottom: spacing.lg }}
        />
      ) : null}

      {libraryBlocked ? (
        <Banner
          variant="attention"
          title={t('errors.permissionDenied')}
          message={t('prescription.capture.libraryDenied')}
          actionLabel={t('healthCheck.openSettings')}
          onAction={() => void Linking.openSettings()}
          style={{ marginBottom: spacing.lg }}
        />
      ) : null}

      <Card>
        <Text variant="label">{t('prescription.capture.pagesSoFar')}</Text>
        <Divider style={{ marginVertical: spacing.md }} />

        {pages.length === 0 ? (
          <Text variant="body" tone="muted">
            {t('prescription.capture.nothingYet')}
          </Text>
        ) : (
          <View style={{ gap: spacing.md }}>
            {/* Bounded by the number of pages she has physically photographed and kept —
                a handful, and every one of them is on screen because a page she cannot
                see is a page she cannot check. */}
            {pages.map((uri, index) => (
              <View
                key={uri}
                style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
              >
                <Image
                  source={{ uri }}
                  accessible
                  accessibilityRole="image"
                  accessibilityLabel={t('prescription.capture.pageLabel', { n: index + 1 })}
                  resizeMode="cover"
                  style={{
                    width: 72,
                    height: 96,
                    borderRadius: radii.md,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colors.bgSunken,
                  }}
                />
                <Text variant="label" style={{ flex: 1 }}>
                  {t('prescription.capture.pageOf', { n: index + 1, total: pages.length })}
                </Text>
                <Button
                  title={t('common.remove')}
                  accessibilityLabel={t('prescription.capture.removePage', { n: index + 1 })}
                  onPress={() => void removePage(index)}
                  variant="ghost"
                  size="md"
                />
              </View>
            ))}
          </View>
        )}
      </Card>

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.lg }}>
        {t('prescription.capture.doneHint')}
      </Text>
    </Screen>
  );
}
