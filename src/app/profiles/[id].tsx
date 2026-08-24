/**
 * One patient — switch to them, rename them, or archive them.
 *
 * SWITCHING IS AN EXPLICIT, NAMED TAP. The whole app reads and writes whichever patient is
 * active, so making a patient active is a deliberate button press with the consequence spelt
 * out, never a side effect of opening this screen. It changes the VIEW only; reminders are
 * device-wide (R1) and keep ringing for everyone regardless.
 *
 * ARCHIVING IS PROTECTED LIKE DELETING A BACKUP. The row holds a health record, so archive is
 * a soft delete behind a destructive confirm; it refuses the last patient (that would strand
 * the app on no profile) and, when it archived the one on screen, hands the view to the
 * promoted default so the pointer is never left dangling.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Icon,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  archiveProfile,
  getDefaultProfile,
  getProfile,
  renameProfile,
} from '@/db/repositories/profiles';
import { resolveProfileId, useAsync, useT, type LocalStrings } from '@/app/_shared/lib';
import { publishDeviceHorizon } from '@/features/dosing/deviceHorizon';
import { switchToProfile } from './_lib';

// Screen-local copy, en AND hi. Inline (not shared from _lib) because `check:i18n` looks for
// the map in the same file as the `t()` calls.
const STRINGS: LocalStrings = {
  'profiles.detailTitle': { en: 'Patient', hi: 'मरीज़' },
  'profiles.loading': { en: 'Opening your patients', hi: 'आपके मरीज़ खुल रहे हैं' },
  'profiles.showingNow': { en: 'Showing Now', hi: 'अभी दिख रहे हैं' },
  'profiles.show': { en: 'Show This Patient', hi: 'यह मरीज़ दिखाएँ' },
  'profiles.showHint': {
    en: 'Every screen will show and record this patient’s health until you switch.',
    hi: 'जब तक आप बदलती नहीं, हर स्क्रीन इसी मरीज़ का स्वास्थ्य दिखाएगी और दर्ज करेगी।',
  },
  'profiles.rename': { en: 'Rename', hi: 'नाम बदलें' },
  'profiles.nameLabel': { en: 'Name', hi: 'नाम' },
  'profiles.save': { en: 'Save', hi: 'सहेजें' },
  'profiles.archive': { en: 'Archive This Patient', hi: 'यह मरीज़ संग्रह करें' },
  'profiles.archiveHint': {
    en: 'Archiving hides a patient and stops their reminders. Nothing they recorded is deleted, and it cannot be done to the last patient.',
    hi: 'संग्रह करने से मरीज़ छुप जाता है और उनकी याद-दिलावट रुक जाती है। उनका दर्ज किया कुछ भी मिटता नहीं, और आख़िरी मरीज़ के साथ यह नहीं हो सकता।',
  },
  'profiles.archiveConfirmTitle': { en: 'Archive {{name}}?', hi: '{{name}} को संग्रह करें?' },
  'profiles.archiveConfirmBody': {
    en: 'Their reminders will stop and they will be hidden from every screen. Everything they recorded is kept, and you can add them again later.',
    hi: 'उनकी याद-दिलावट रुक जाएगी और वे हर स्क्रीन से छुप जाएँगे। उनका दर्ज किया सब कुछ रखा जाता है, और आप उन्हें बाद में फिर जोड़ सकती हैं।',
  },
  'profiles.archiveConfirm': { en: 'Archive', hi: 'संग्रह करें' },
  'profiles.archived': { en: '{{name}} archived', hi: '{{name}} संग्रहित' },
  'profiles.archiveBlocked': {
    en: 'This is the only patient. Add another before archiving this one.',
    hi: 'यह अकेला मरीज़ है। इसे संग्रह करने से पहले कोई और जोड़ें।',
  },
  'profiles.switched': { en: 'Now showing {{name}}', hi: 'अब {{name}} दिख रहे हैं' },
};

type Loaded = {
  id: string;
  displayName: string;
  isActive: boolean;
};

export default function ProfileDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();

  const state = useAsync<Loaded | null>(async () => {
    if (!id) return null;
    const [profile, activeId] = await Promise.all([getProfile(id), resolveProfileId()]);
    if (!profile) return null;
    return { id: profile.id, displayName: profile.displayName, isActive: profile.id === activeId };
  }, [id]);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Seed the rename field once per load, during render — the field must carry her current
  // name on the first painted frame, and reloading must not clobber what she has since typed.
  const [seededFrom, setSeededFrom] = useState<Loaded | null>(null);
  if (state.data && state.data !== seededFrom) {
    setSeededFrom(state.data);
    setName(state.data.displayName);
  }

  const data = state.data;
  const reload = state.reload; // stable across renders; `state` itself is a fresh object each render
  const trimmed = name.trim();
  const renameDirty = data !== null && trimmed !== '' && trimmed !== data.displayName;

  const save = useCallback(async () => {
    if (!data || busy || !renameDirty) return;
    setBusy(true);
    try {
      await renameProfile(data.id, trimmed);
      toast.show({ message: t('common.saved'), variant: 'success' });
      reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [data, busy, renameDirty, trimmed, toast, t, reload]);

  const show = useCallback(async () => {
    if (!data || busy) return;
    setBusy(true);
    try {
      await switchToProfile(data.id);
      toast.show({ message: t('profiles.switched', { name: data.displayName }), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      setBusy(false);
    }
  }, [data, busy, toast, t]);

  const archive = useCallback(async () => {
    if (!data || busy) return;
    const ok = await confirm({
      title: t('profiles.archiveConfirmTitle', { name: data.displayName }),
      message: t('profiles.archiveConfirmBody'),
      confirmLabel: t('profiles.archiveConfirm'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await archiveProfile(data.id);
      // Archiving the viewed patient leaves the active pointer dangling; hand the view to the
      // default archiveProfile just promoted, so the app never resolves to an archived id.
      const fallback = await getDefaultProfile();
      if (fallback) await switchToProfile(fallback.id);
      // Drop her rules from the DEVICE horizon NOW, so her reminders stop as this confirm
      // promised — the horizon unions only non-archived profiles (R1), so a re-publish after
      // the soft delete simply omits her. Without this, nothing re-publishes until the next
      // boot or medicine-edit reconcile, and her alarms would keep ringing until then. This is
      // the archive mirror of the create path, where adding a medicine reconciles and arms the
      // new profile. Fire-and-forget and swallowed on purpose: the archive is already
      // committed, and a horizon hiccup must never turn a done deed into a "save failed".
      void publishDeviceHorizon().catch(() => {});
      toast.show({ message: t('profiles.archived', { name: data.displayName }), variant: 'success' });
      router.back();
    } catch (error) {
      // planProfileArchive throws when this is the only live patient — a real, expected block,
      // not a save failure. Everything else is unexpected.
      const message = error instanceof Error && /only patient/.test(error.message)
        ? t('profiles.archiveBlocked')
        : t('errors.saveFailed');
      toast.show({ message, variant: 'error' });
      setBusy(false);
    }
  }, [data, busy, confirm, toast, t]);

  return (
    <Screen variant="scroll">
      <ScreenHeader title={t('profiles.detailTitle')} onBack={() => router.back()} />

      {state.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={spacing.touchTarget} label={t('profiles.loading')} />
          <Skeleton height={spacing.touchTarget} />
        </View>
      ) : !data ? (
        <Banner variant="attention" title={t('errors.notFound')} />
      ) : (
        <View style={{ gap: spacing.xl }}>
          {/* Show / already-showing */}
          {data.isActive ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Icon name="check" size={24} color={colors.primary} strokeWidth={2.6} />
              <Text variant="label" tone="primary">
                {t('profiles.showingNow')}
              </Text>
            </View>
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Button
                title={t('profiles.show')}
                onPress={() => void show()}
                size="lg"
                fullWidth
                loading={busy}
              />
              <Text variant="caption" tone="muted">
                {t('profiles.showHint')}
              </Text>
            </View>
          )}

          {/* Rename */}
          <View style={{ gap: spacing.md }}>
            <Text variant="label">{t('profiles.rename')}</Text>
            <TextField
              label={t('profiles.nameLabel')}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
            />
            <Button
              title={t('profiles.save')}
              onPress={() => void save()}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={!renameDirty || busy}
            />
          </View>

          {/* Archive */}
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('profiles.archive')}
              onPress={() => void archive()}
              variant="destructive"
              size="lg"
              fullWidth
              disabled={busy}
            />
            <Text variant="caption" tone="muted">
              {t('profiles.archiveHint')}
            </Text>
          </View>
        </View>
      )}
    </Screen>
  );
}
