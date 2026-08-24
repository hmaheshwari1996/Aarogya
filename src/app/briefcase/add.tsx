/**
 * Adding a paper to the briefcase.
 *
 * Three ways in, because the papers arrive three ways: the discharge summary is on the
 * desk (camera), the health card was photographed last month (photos), the hospital
 * emailed a PDF that is now in Downloads (files).
 *
 * ─── THE FILE IS COPIED AT SAVE, NOT AT PICK ──────────────────────────────────
 * She can pick, look at it, decide it is the wrong page, and pick again — and none of that
 * puts bytes on disk. Copying at pick time would leave an orphan file behind every time
 * somebody backs out of this screen: bytes nothing in the app can list, in an app whose
 * promise is that everything here is visible and removable. So the copy happens once,
 * inside Save, and if the row that should reference it fails to write, the copy is undone.
 *
 * ─── A FAILED COPY FAILS THE SAVE ─────────────────────────────────────────────
 * `persistPhoto` in `src/app/labs/new.tsx` falls back to the picker's cache URI when the
 * copy fails, on the reasoning that a fragile record beats no record. That is right there,
 * where the photo is a bonus on a row that also carries typed values. It is wrong here: a
 * briefcase row IS its file, and a row pointing into the cache directory is a discharge
 * summary Android may delete tonight — she would find out on the morning she needed it.
 * See `copyIntoBriefcase`, which is where that decision is enforced.
 *
 * ─── SIZE IS CHECKED AT PICK, NOT AT SAVE ─────────────────────────────────────
 * Refusing a 60 MB file AFTER she has typed a title and chosen a category is the version
 * of this screen that wastes her time. The check runs the moment the picker returns, and
 * the message says both numbers — what this file is, and what would fit.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Card,
  Chip,
  Divider,
  Icon,
  Screen,
  ScreenHeader,
  SectionHeader,
  Text,
  TextField,
  useToast,
} from '@/components/ui';
import { addDocument } from '@/db/repositories/contacts';

import { useProfileId, useT, type LocalStrings } from '../_shared/lib';
import {
  BRIEFCASE_KIND_ORDER,
  BRIEFCASE_SHARED_STRINGS,
  BriefcaseCopyError,
  MAX_BRIEFCASE_FILE_BYTES,
  copyIntoBriefcase,
  describeError,
  discardCopiedFile,
  fileTypeKey,
  formatBytes,
  isImageDocument,
  kindLabelKey,
  originalNameFromUri,
  suggestTitleFromName,
  type PickedFile,
} from './_lib';

/**
 * Kind and file-type labels are shared because their keys are built at runtime; everything
 * this screen names literally is declared here so `scripts/check-i18n.js` can verify it.
 * The full reasoning sits next to `BRIEFCASE_SHARED_STRINGS`.
 */
const STRINGS: LocalStrings = {
  ...BRIEFCASE_SHARED_STRINGS,

  'briefcase.addTitle': { en: 'Add a Paper', hi: 'काग़ज़ जोड़िए' },
  'briefcase.chooseHow': { en: 'Which paper?', hi: 'कौन सा काग़ज़?' },
  'briefcase.pickPrompt': {
    en: 'Photograph the paper, or choose a file that is already on this phone. Discharge summaries, insurance papers, health cards and identity papers all belong here.',
    hi: 'काग़ज़ की फोटो लीजिए, या इस फ़ोन में पहले से रखी कोई फ़ाइल चुनिए। डिस्चार्ज सारांश, बीमा के काग़ज़, हेल्थ कार्ड और पहचान के काग़ज़ — सब यहाँ रखे जा सकते हैं।',
  },
  'briefcase.takePhoto': { en: 'Take a Photo', hi: 'फोटो लीजिए' },
  'briefcase.fromPhotos': { en: 'Choose from Photos', hi: 'फ़ोटो में से चुनिए' },
  'briefcase.fromFiles': { en: 'Choose a File', hi: 'फ़ाइल चुनिए' },
  'briefcase.fromFilesHelp': {
    en: 'A PDF or a Word file that is already on this phone — in Downloads, or saved from WhatsApp.',
    hi: 'इस फ़ोन में पहले से रखी कोई PDF या वर्ड फ़ाइल — डाउनलोड में, या WhatsApp से सहेजी हुई।',
  },
  'briefcase.chooseAgain': { en: 'Choose Something Else', hi: 'कुछ और चुनिए' },
  'briefcase.chosenPicture': { en: 'The paper you chose', hi: 'आपका चुना हुआ काग़ज़' },
  'briefcase.titleLabel': { en: 'What is this paper?', hi: 'यह कौन सा काग़ज़ है?' },
  'briefcase.titleHelper': {
    en: 'A few words you will recognise later, like "Apollo discharge, November".',
    hi: 'दो-चार शब्द जो बाद में आपको पहचान में आएँ, जैसे "अपोलो डिस्चार्ज, नवंबर"।',
  },
  'briefcase.kindLabel': { en: 'What kind of paper?', hi: 'किस तरह का काग़ज़?' },
  'briefcase.saved': { en: 'Kept in the briefcase', hi: 'बस्ते में रख दिया' },
  'briefcase.detailStorage': {
    en: 'Kept on this phone only. It is included in a backup you make yourself.',
    hi: 'सिर्फ़ इसी फ़ोन में रखा है। आपके ख़ुद बनाए बैकअप में यह शामिल होता है।',
  },

  // ── When a picker will not cooperate ───────────────────────────────────────
  'briefcase.cameraBusy': {
    en: 'The camera did not open. Please try again.',
    hi: 'कैमरा नहीं खुला। फिर कोशिश करें।',
  },
  'briefcase.pickerBusy': {
    en: 'The file chooser did not open. Please try again.',
    hi: 'फ़ाइल चुनने वाला नहीं खुला। फिर कोशिश करें।',
  },
  'briefcase.pickerRefused': {
    en: 'This phone would not hand that file over. Save it into Downloads first, then choose it from there.',
    hi: 'यह फ़ोन वह फ़ाइल नहीं दे पाया। पहले उसे डाउनलोड में सहेजिए, फिर वहाँ से चुनिए।',
  },

  // ── When the file itself is the problem. One sentence per `CopyFailure`. ───
  'briefcase.tooLarge': {
    en: 'This file is {{size}}, which is more than the briefcase takes. Anything up to {{limit}} fits, and that is also what fits in a backup.',
    hi: 'यह फ़ाइल {{size}} की है, जो बस्ते की सीमा से ज़्यादा है। {{limit}} तक की फ़ाइल आ जाती है, और उतनी ही बैकअप में भी समाती है।',
  },
  'briefcase.noSpace': {
    en: 'The phone has no room left for this. Nothing was kept. Free up some space and try again.',
    hi: 'फ़ोन में इसके लिए जगह नहीं बची। कुछ नहीं रखा गया। थोड़ी जगह खाली करके फिर कोशिश करें।',
  },
  'briefcase.sourceGone': {
    en: 'That file is no longer on the phone. Please choose it again.',
    hi: 'वह फ़ाइल अब फ़ोन में नहीं है। कृपया फिर से चुनिए।',
  },
  'briefcase.copyFailed': {
    en: 'The paper could not be kept. Nothing was saved, so please try again.',
    hi: 'काग़ज़ रखा नहीं जा सका। कुछ भी सहेजा नहीं गया, कृपया फिर कोशिश करें।',
  },
};

/** Where a picked page is shown back to her. Tall enough to tell one page from another. */
const PREVIEW_HEIGHT = 240;

/** '' from a platform API means "not determined", which is not the same as a MIME type. */
function normalise(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The size on disk, when the picker did not say.
 *
 * `fileSize` is optional on an `ImagePickerAsset` and genuinely absent on some Android
 * content providers. Without it the size guard cannot run at all, so it is worth one cheap
 * stat — and a stat that throws simply leaves the size unknown rather than blocking a pick.
 */
function sizeOf(uri: string, reported: number | null): number | null {
  if (reported !== null && Number.isFinite(reported)) return reported;
  try {
    const size = new File(uri).size;
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

export default function AddToBriefcaseScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const { data: profileId } = useProfileId();

  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('discharge_summary');
  /**
   * Which picker is open, not merely "a picker is open".
   *
   * A single boolean puts the spinner on the Take a Photo button while the FILE chooser is
   * loading — the app pointing at the wrong thing, which is exactly the kind of small lie
   * that makes a slow phone feel broken.
   */
  const [busy, setBusy] = useState<'camera' | 'photos' | 'files' | null>(null);
  const [saving, setSaving] = useState(false);

  const pickedIsImage = useMemo(
    () => (picked ? isImageDocument(picked.mimeType, picked.originalFileName ?? picked.uri) : false),
    [picked],
  );

  /**
   * Accepts a pick, or refuses it with the reason.
   *
   * Refusing here rather than at Save is the whole reason the size is read this early; see
   * the file header. A refusal leaves the previous pick untouched, so backing out of an
   * oversized file does not also lose the good one she chose a minute ago.
   */
  const accept = useCallback(
    (candidate: PickedFile) => {
      if (candidate.sizeBytes !== null && candidate.sizeBytes > MAX_BRIEFCASE_FILE_BYTES) {
        toast.show({
          message: t('briefcase.tooLarge', {
            size: formatBytes(candidate.sizeBytes, t) ?? '',
            limit: formatBytes(MAX_BRIEFCASE_FILE_BYTES, t) ?? '',
          }),
          variant: 'error',
          // Two numbers and a sentence take longer than a default toast to read at 1.3×.
          duration: 8000,
        });
        return;
      }
      setPicked(candidate);
      // Suggested INTO the field, never used as the title itself: `addDocument` refuses to
      // default a title from a filename, and it is right to. She can accept it, edit it,
      // or clear it — and an empty field still blocks Save, so nothing is saved unnamed.
      const suggestion = suggestTitleFromName(candidate.originalFileName);
      if (suggestion && title.trim() === '') setTitle(suggestion);
    },
    [t, title, toast],
  );

  const takePhoto = useCallback(async () => {
    setBusy('camera');
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        toast.show({ message: t('errors.cameraDenied'), variant: 'error' });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        // Matches the lab-report screen: a 12-megapixel JPEG of an A4 page is no more
        // legible than a 0.7-quality one and is several times the storage.
        quality: 0.7,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      accept({
        uri: asset.uri,
        originalFileName: normalise(asset.fileName),
        mimeType: normalise(asset.mimeType) ?? 'image/jpeg',
        sizeBytes: sizeOf(asset.uri, asset.fileSize ?? null),
      });
    } catch {
      toast.show({ message: t('briefcase.cameraBusy'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [accept, t, toast]);

  const pickPhoto = useCallback(async () => {
    setBusy('photos');
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      accept({
        uri: asset.uri,
        originalFileName: normalise(asset.fileName),
        mimeType: normalise(asset.mimeType) ?? 'image/jpeg',
        sizeBytes: sizeOf(asset.uri, asset.fileSize ?? null),
      });
    } catch {
      toast.show({ message: t('briefcase.cameraBusy'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [accept, t, toast]);

  /**
   * The system file chooser — PDFs, Word files, anything already on the phone.
   *
   * This is `expo-file-system`'s own `pickFileAsync`, which is `ACTION_OPEN_DOCUMENT` on
   * Android. No extra package: `expo-document-picker` would be a second dependency for the
   * same system dialog, and this app counts its megabytes.
   *
   * TWO BEHAVIOURS THAT ARE NOT OBVIOUS:
   *
   *  • CANCELLING REJECTS. It does not resolve with a `canceled` flag the way
   *    `expo-image-picker` does — it throws `ERR_PICKER_CANCELLED`. Treating that as an
   *    error would put a red toast in front of her every single time she changes her mind,
   *    so it is matched first and swallowed.
   *
   *  • SOME PROVIDERS REFUSE THE PERSISTENT GRANT. The picker takes a persistable read
   *    permission on the result, and a provider that does not offer one (certain mail and
   *    cloud attachments) makes the whole call throw. There is nothing the app can do
   *    about that, so the message tells her the one thing that does work: save it into
   *    Downloads first.
   */
  const pickFile = useCallback(async () => {
    setBusy('files');
    try {
      // '*/*' rather than a filter: Android's picker takes a single MIME type, and a
      // filter of 'application/pdf' would hide the Word file she is looking for. What she
      // may keep in her own briefcase is not the app's decision.
      const result = await File.pickFileAsync(undefined, '*/*');
      const file = Array.isArray(result) ? result[0] : result;
      if (!file) return;

      const mimeType = normalise(file.type);
      const originalFileName = originalNameFromUri(file.uri);
      let sizeBytes: number | null = null;
      try {
        sizeBytes = Number.isFinite(file.size) && file.size > 0 ? file.size : null;
      } catch {
        sizeBytes = null;
      }
      accept({ uri: file.uri, originalFileName, mimeType, sizeBytes });
    } catch (error) {
      const detail = describeError(error);
      const code = (error as { code?: string } | null)?.code ?? '';
      if (code === 'ERR_PICKER_CANCELLED' || /cancel/i.test(detail)) return;
      if (/permission|security/i.test(detail)) {
        toast.show({ message: t('briefcase.pickerRefused'), variant: 'error', duration: 8000 });
        return;
      }
      toast.show({ message: t('briefcase.pickerBusy'), variant: 'error' });
    } finally {
      setBusy(null);
    }
  }, [accept, t, toast]);

  const canSave = picked !== null && title.trim().length > 0 && profileId !== null;

  const save = useCallback(async () => {
    if (!picked || !profileId || !canSave) return;
    setSaving(true);

    let copiedUri: string | null = null;
    try {
      copiedUri = await copyIntoBriefcase(picked);

      // The size AFTER the copy, because that is the file the row points at. A re-encoded
      // camera JPEG is not the size the picker reported, and the number is shown to her.
      let sizeBytes = picked.sizeBytes;
      try {
        const stored = new File(copiedUri).size;
        if (Number.isFinite(stored) && stored > 0) sizeBytes = stored;
      } catch {
        /* keep whatever the picker said */
      }

      await addDocument({
        profileId,
        kind,
        title: title.trim(),
        fileUri: copiedUri,
        originalFileName: picked.originalFileName,
        mimeType: picked.mimeType,
        sizeBytes,
        // The app copied this file in FOR this row and nothing else refers to it, which is
        // exactly what `owns_file` means — and it is what lets Remove delete the bytes
        // rather than leaving an unlistable copy of a discharge summary on the phone.
        ownsFile: true,
      });

      toast.show({ message: t('briefcase.saved'), variant: 'success' });
      router.back();
    } catch (error) {
      // The copy landed but the row did not. Undo the copy: bytes with no row are exactly
      // what this feature promises not to leave behind.
      if (copiedUri) discardCopiedFile(copiedUri);

      if (error instanceof BriefcaseCopyError) {
        const key =
          error.reason === 'too_large'
            ? 'briefcase.tooLarge'
            : error.reason === 'no_space'
              ? 'briefcase.noSpace'
              : error.reason === 'source_gone'
                ? 'briefcase.sourceGone'
                : 'briefcase.copyFailed';
        toast.show({
          message: t(key, {
            // The copy's own measurement first: a SAF provider that would not tell the
            // picker how big the file was is exactly the case that reaches 'too_large'
            // here, and "This file is , which is more than…" reads as a bug.
            size: formatBytes(error.measuredBytes ?? picked.sizeBytes, t) ?? '',
            limit: formatBytes(MAX_BRIEFCASE_FILE_BYTES, t) ?? '',
          }),
          variant: 'error',
          duration: 8000,
        });
      } else {
        console.warn('[briefcase] could not save the document row', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      }
    } finally {
      setSaving(false);
    }
  }, [canSave, kind, picked, profileId, t, title, toast]);

  return (
    <Screen
      background="bgSunken"
      footer={
        <Button
          title={t('common.save')}
          onPress={() => void save()}
          size="lg"
          fullWidth
          disabled={!canSave}
          loading={saving}
        />
      }
    >
      <ScreenHeader title={t('briefcase.addTitle')} onBack={() => router.back()} />

      {/* ── 1. Which paper ────────────────────────────────────────────────────── */}
      <SectionHeader title={t('briefcase.chooseHow')} />

      <Card style={{ gap: spacing.md }}>
        <Button
          title={t('briefcase.takePhoto')}
          onPress={() => void takePhoto()}
          size="xl"
          fullWidth
          loading={busy === 'camera'}
          disabled={busy !== null && busy !== 'camera'}
        />
        <Button
          title={t('briefcase.fromPhotos')}
          onPress={() => void pickPhoto()}
          variant="secondary"
          size="lg"
          fullWidth
          loading={busy === 'photos'}
          disabled={busy !== null && busy !== 'photos'}
        />
        <Button
          title={t('briefcase.fromFiles')}
          onPress={() => void pickFile()}
          variant="secondary"
          size="lg"
          fullWidth
          loading={busy === 'files'}
          disabled={busy !== null && busy !== 'files'}
        />
        <Text variant="caption" tone="muted">
          {t('briefcase.fromFilesHelp')}
        </Text>
      </Card>

      {/* ── 2. What was chosen ────────────────────────────────────────────────── */}
      {picked ? (
        <Card style={{ gap: spacing.md, marginTop: spacing.lg }}>
          {pickedIsImage ? (
            <Image
              source={{ uri: picked.uri }}
              accessible
              accessibilityRole="image"
              accessibilityLabel={t('briefcase.chosenPicture')}
              resizeMode="contain"
              style={{ width: '100%', height: PREVIEW_HEIGHT, borderRadius: radii.md }}
            />
          ) : (
            /* A PDF has no thumbnail the app can draw, so it is described in words —
               which is also what a screen reader gets either way. */
            <View
              accessible
              accessibilityLabel={`${t(
                fileTypeKey(picked.mimeType, picked.originalFileName ?? picked.uri),
              )}. ${picked.originalFileName ?? ''}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                padding: spacing.lg,
                borderRadius: radii.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.bgSunken,
              }}
            >
              <Icon name="info" size={32} color={colors.textMuted} />
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text variant="label">
                  {t(fileTypeKey(picked.mimeType, picked.originalFileName ?? picked.uri))}
                </Text>
                {picked.originalFileName ? (
                  <Text variant="body" tone="muted" numberOfLines={2} ellipsizeMode="middle">
                    {picked.originalFileName}
                  </Text>
                ) : null}
                {formatBytes(picked.sizeBytes, t) ? (
                  <Text variant="caption" tone="muted">
                    {formatBytes(picked.sizeBytes, t)}
                  </Text>
                ) : null}
              </View>
            </View>
          )}

          <Button
            title={t('briefcase.chooseAgain')}
            onPress={() => setPicked(null)}
            variant="ghost"
            size="md"
            fullWidth
          />
        </Card>
      ) : (
        <Banner
          variant="info"
          title={t('briefcase.chooseHow')}
          message={t('briefcase.pickPrompt')}
          style={{ marginTop: spacing.lg }}
        />
      )}

      {/* ── 3. Naming and filing it ───────────────────────────────────────────── */}
      {picked ? (
        <>
          <Divider strong style={{ marginVertical: spacing.xl }} />

          <Card style={{ gap: spacing.lg }}>
            <TextField
              label={t('briefcase.titleLabel')}
              helper={t('briefcase.titleHelper')}
              value={title}
              onChangeText={setTitle}
              autoCapitalize="sentences"
              required
            />

            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('briefcase.kindLabel')}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {BRIEFCASE_KIND_ORDER.map((value) => (
                  <Chip
                    key={value}
                    label={t(kindLabelKey(value))}
                    selected={kind === value}
                    onPress={() => setKind(value)}
                    selectionMode="single"
                  />
                ))}
              </View>
            </View>
          </Card>

          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.lg }}>
            {t('briefcase.detailStorage')}
          </Text>
        </>
      ) : null}
    </Screen>
  );
}
