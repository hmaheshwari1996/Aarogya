/**
 * Patients — the list of everyone whose health is kept on this phone, and the door to
 * adding, switching, renaming and archiving them.
 *
 * WHOSE RECORD IS ON SCREEN IS A SAFETY FACT, NOT A CONVENIENCE. The active patient is a
 * device-global pointer; a reading typed against the wrong one is a medical error. So the
 * patient currently being shown is marked here in words and a mark, never colour alone, and
 * the switch itself is an explicit tap on a named button in the detail screen rather than a
 * whole-row press that a tremor could trigger by accident.
 *
 * Switching the view NEVER touches reminders: the alarm horizon is device-wide (R1), so
 * every patient's doses keep ringing no matter who is on screen here.
 */

import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
} from '@/components/ui';
import { listProfiles } from '@/db/repositories/profiles';
import {
  resolveProfileId,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';

// Screen-local copy, en AND hi. Inline (not shared from _lib) because `check:i18n` looks for
// the map in the same file as the `t()` calls.
const STRINGS: LocalStrings = {
  'profiles.title': { en: 'Patients', hi: 'मरीज़' },
  'profiles.subtitle': {
    en: 'Everyone whose health you keep on this phone. Tap a patient to manage them.',
    hi: 'इस फ़ोन पर जिन-जिन का स्वास्थ्य आप रखती हैं। किसी मरीज़ को संभालने के लिए उस पर टैप करें।',
  },
  'profiles.add': { en: 'Add a Patient', hi: 'नया मरीज़ जोड़ें' },
  'profiles.showingNow': { en: 'Showing Now', hi: 'अभी दिख रहे हैं' },
  'profiles.tapToShow': { en: 'Tap to open', hi: 'खोलने के लिए टैप करें' },
  'profiles.loading': { en: 'Opening your patients', hi: 'आपके मरीज़ खुल रहे हैं' },
  'profiles.empty': { en: 'No patients yet', hi: 'अभी कोई मरीज़ नहीं' },
  'profiles.emptyMessage': {
    en: 'Add the first patient to start keeping their medicines and readings.',
    hi: 'दवाइयाँ और रीडिंग रखना शुरू करने के लिए पहला मरीज़ जोड़ें।',
  },
};

type Loaded = {
  profiles: { id: string; displayName: string }[];
  activeId: string | null;
};

export default function ProfilesScreen() {
  const t = useT(STRINGS);
  const { colors } = useTheme();

  const state = useAsync<Loaded>(async () => {
    const profiles = await listProfiles();
    const activeId = await resolveProfileId();
    return { profiles: profiles.map((p) => ({ id: p.id, displayName: p.displayName })), activeId };
  }, []);
  // Re-read on focus so a rename, an archive, or a switch made downstream is reflected the
  // moment we come back to this list.
  useReloadOnFocus(state.reload);

  const profiles = state.data?.profiles ?? [];
  const activeId = state.data?.activeId ?? null;

  return (
    <Screen
      variant="scroll"
      background="bgSunken"
      footer={
        <Button
          title={t('profiles.add')}
          onPress={() => router.push('/profiles/new')}
          icon="plus"
          size="lg"
          fullWidth
        />
      }
    >
      <ScreenHeader
        title={t('profiles.title')}
        subtitle={t('profiles.subtitle')}
        onBack={() => router.back()}
      />

      {state.loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={spacing.touchTarget + spacing.lg} label={t('profiles.loading')} />
          <Skeleton height={spacing.touchTarget + spacing.lg} />
        </View>
      ) : profiles.length === 0 ? (
        <EmptyState
          title={t('profiles.empty')}
          message={t('profiles.emptyMessage')}
          actionLabel={t('profiles.add')}
          onAction={() => router.push('/profiles/new')}
        />
      ) : (
        <View style={{ gap: spacing.md }}>
          {profiles.map((profile) => {
            const isActive = profile.id === activeId;
            return (
              <Card
                key={profile.id}
                onPress={() => router.push(`/profiles/${profile.id}`)}
                accessibilityLabel={
                  isActive
                    ? `${profile.displayName}. ${t('profiles.showingNow')}`
                    : profile.displayName
                }
                accessibilityHint={t('profiles.tapToShow')}
                style={{ gap: spacing.sm }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <Text variant="label" style={{ flex: 1 }} numberOfLines={2}>
                    {profile.displayName}
                  </Text>
                  <Icon name="chevronRight" size={24} color={colors.textMuted} />
                </View>
                {/* The active patient is marked by a check AND the words — colour is never
                    the only signal. */}
                {isActive ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <Icon name="check" size={22} color={colors.primary} strokeWidth={2.6} />
                    <Text variant="body" tone="primary" weight="600">
                      {t('profiles.showingNow')}
                    </Text>
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}
