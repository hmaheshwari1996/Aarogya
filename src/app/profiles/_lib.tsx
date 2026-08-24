/**
 * Shared plumbing for the Patients screens — the switch action and the "whose record is
 * this" tag every data-entry screen should carry.
 *
 * Copy is NOT shared from here: each screen keeps its own inline `LocalStrings` map, because
 * `check:i18n` looks for the map in the same file as the `t()` calls and does not follow
 * imports. This file holds only the logic and the one shared component.
 *
 * ─── WHY THIS FILE DEFAULT-EXPORTS A REDIRECT ────────────────────────────────
 * Expo Router turns every file under the app root into a route, so a helper module warns
 * "missing the required default export" the moment anything touches it. The cheapest honest
 * answer is a real default export that sends the user home — exactly what `_shared/lib.tsx`
 * and `briefcase/_lib.tsx` do.
 */

import React from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Text } from '@/components/ui';
import { listProfiles } from '@/db/repositories/profiles';
import { setActiveProfileId } from '@/db/repositories/settings';
import {
  invalidateProfileCache,
  resolveProfileId,
  useAsync,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';

/**
 * The tag's own copy. Screen-local by convention (`src/i18n/*.json` is the shared bundle and
 * must not move for screen copy), en AND hi. Each Patients SCREEN carries its own `STRINGS`
 * map inline — `check:i18n` scans a file for a `LocalStrings` map in that same file and does
 * not follow imports, so a shared map here would read as unresolved keys on the call sites.
 */
const TAG_STRINGS: LocalStrings = {
  // Frames data entry as an act done FOR a named person, because a reading saved onto the
  // wrong patient is a medical error, not a cosmetic one.
  'profiles.recordingFor': { en: 'Recording for', hi: 'किसके लिए दर्ज कर रही हैं' },
};

/**
 * Switch which patient the whole app shows.
 *
 * Sets the device-local pointer, then invalidates the memo so every screen re-reads it on
 * focus. It does NOT touch alarms — reminders are device-wide (R1), so switching the view
 * changes only what is on screen. The caller shows the toast and navigates.
 */
export async function switchToProfile(profileId: string): Promise<void> {
  await setActiveProfileId(profileId);
  invalidateProfileCache();
}

/**
 * A tinted tag naming the patient this screen's data belongs to.
 *
 * WHY IT IS HERE, TO BE DROPPED ONTO DATA-ENTRY SCREENS: a reading typed onto the wrong
 * patient is a medical error, and the active profile is a device-global pointer a family
 * carer can have switched. So every screen that WRITES health data should say whose it is.
 *
 * It renders NOTHING on a single-patient install — the mother-only phone, and the son's
 * viewer — because there is nothing to get wrong there and a tag on every screen would be
 * noise. It reloads on focus, so it updates the instant the patient is switched.
 */
export function ActiveProfileTag({ style }: { style?: object }) {
  const t = useT(TAG_STRINGS);
  const { colors } = useTheme();

  const state = useAsync(async () => {
    const profiles = await listProfiles();
    if (profiles.length <= 1) return null;
    const activeId = await resolveProfileId();
    return profiles.find((profile) => profile.id === activeId)?.displayName ?? null;
  }, []);
  useReloadOnFocus(state.reload);

  const name = state.data;
  if (!name) return null;

  return (
    <View
      accessible
      accessibilityLabel={`${t('profiles.recordingFor')}: ${name}`}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          alignSelf: 'flex-start',
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          borderRadius: radii.pill,
          borderWidth: 2,
          borderColor: colors.primary,
          backgroundColor: colors.primarySoft,
        },
        style,
      ]}
    >
      <Text variant="caption" tone="muted">
        {t('profiles.recordingFor')}
      </Text>
      <Text variant="body" weight="600">
        {name}
      </Text>
    </View>
  );
}

export default function ProfilesLibRoute() {
  return <Redirect href="/" />;
}
