/**
 * The viewer variant — what the son's phone runs.
 *
 * TWO TABS, AND NO THIRD. The patient app has four; this one has Dashboard and Saved,
 * because everything else in the app is a way to WRITE a clinical row and a viewer does
 * not write clinical rows. That is not a permissions convenience, it is the point: a dose
 * marked "taken" by somebody who was not in the room, stored in the same column and
 * printed in the same report as one she confirmed herself, is a corrupted record — and
 * the person who suffers for it is the patient, at the OPD, months later.
 *
 * The guard is structural rather than defensive. There is no link from anywhere in this
 * folder to `/entry/*`, `/dose/*`, `/prescription/*` or `/settings/ai`, so there is no
 * route interception to get wrong, nothing to forget when a new screen is added to the
 * patient app, and no half-open screen that renders its buttons and then refuses them.
 *
 * The role is read once, at first launch, and stored in `app_meta` under META_ROLE; the
 * root layout is what routes here. Setup never runs again on this phone.
 */

import React from 'react';
import { Tabs } from 'expo-router';

import { spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';
import { Icon } from '@/components/ui';
import { useT, type LocalStrings } from '@/app/_shared/lib';

const STRINGS: LocalStrings = {
  'viewer.nav.dashboard': { en: 'Dashboard', hi: 'हाल-चाल' },
  'viewer.nav.saved': { en: 'Saved', hi: 'सहेजे हुए' },
};

export default function ViewerLayout() {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const t = useT(STRINGS);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          // Taller than the platform default so the label has room at 1.25× text and
          // the target stays comfortably above 56dp with a tremor.
          height: spacing.touchTargetLarge + spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.sm,
        },
        tabBarLabelStyle: {
          fontSize: fontSizes.sm,
          lineHeight: Math.round(fontSizes.sm * 1.4),
          fontWeight: '600',
        },
        tabBarAllowFontScaling: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('viewer.nav.dashboard'),
          // The icon is decorative; the label under it is what carries the meaning.
          tabBarIcon: ({ color }) => <Icon name="clock" size={26} color={color} />,
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: t('viewer.nav.saved'),
          tabBarIcon: ({ color }) => <Icon name="info" size={26} color={color} />,
        }}
      />
      {/*
        `href: null` keeps it OFF the tab bar without keeping it out of the router. Pasting
        a link is something a family member does once, from the empty dashboard; a third
        tab for it would sit there forever afterwards, permanently offering to replace the
        record she is looking at.
      */}
      <Tabs.Screen name="link" options={{ href: null }} />
    </Tabs>
  );
}
