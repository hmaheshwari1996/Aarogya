/**
 * About.
 *
 * ─── THE HIDDEN DOOR IS GONE ──────────────────────────────────────────────────
 * Seven taps on the version number used to open `/settings/ai`. The gesture is removed,
 * and the version number is plain text again.
 *
 * The reasoning it was built on — a patient must never stumble into a page about API keys
 * while looking for her medicines — was sound, but the price was paid by the wrong person.
 * The family member who set the phone up could not find the screen either, so a key could
 * never be replaced after it was revoked, or removed by someone who had changed his mind
 * about photographs leaving the phone. Settings now carries a plainly-labelled
 * "Prescription scanning" row, and there is nothing behind it that is dangerous to open by
 * accident.
 */

import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import { Card, Screen, ScreenHeader, Text } from '@/components/ui';
import { spacing } from '@/theme';

const STRINGS: LocalStrings = {
  'about.appName': { en: 'Aarogya', hi: 'आरोग्य' },
  'about.tagline': {
    en: 'A record of your health, kept on your own phone.',
    hi: 'आपकी सेहत का रिकॉर्ड, आपके अपने फोन में।',
  },
  'about.disclaimerTitle': { en: 'What this is, and what it is not', hi: 'यह क्या है, और क्या नहीं' },
  'about.disclaimer': {
    en: 'Aarogya is a record you keep yourself. It is not a doctor, it does not make a diagnosis, and it never decides on its own whether a number is good or bad. Any target range it shows is one a person you named gave you.',
    hi: 'आरोग्य वह रिकॉर्ड है जो आप खुद रखती हैं। यह डॉक्टर नहीं है, यह कोई बीमारी नहीं बताता, और यह अपनी तरफ़ से कभी तय नहीं करता कि कोई अंक अच्छा है या बुरा। जो भी दायरा यह दिखाता है, वह आपके बताए किसी व्यक्ति का दिया हुआ है।',
  },
  'about.privacyTitle': { en: 'Where your information lives', hi: 'आपकी जानकारी कहाँ रहती है' },
  'about.privacyBody': {
    en: 'There is no account and no server. Everything you record stays in this phone until you choose to make a backup or let a family member see it.',
    hi: 'न कोई खाता है, न कोई सर्वर। आपका दर्ज किया हुआ सब कुछ इसी फोन में रहता है, जब तक आप खुद बैकअप न बनाएँ या परिवार के किसी सदस्य को देखने की इजाज़त न दें।',
  },
};

export default function AboutScreen() {
  const t = useT(STRINGS);

  const version =
    Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? t('common.unknown');
  const versionLabel = t('settings.version', { version });

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('settings.about')} onBack={() => router.back()} />

      <View style={{ gap: spacing.md }}>
        <Card>
          <View style={{ gap: spacing.sm }}>
            <Text variant="title">{t('about.appName')}</Text>
            <Text variant="body" tone="muted">
              {t('about.tagline')}
            </Text>
            {/* Plain text. Nothing here is pressable any more — see the file header. */}
            <Text variant="body" style={{ paddingVertical: spacing.sm }}>
              {versionLabel}
            </Text>
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('about.privacyTitle')}</Text>
            <Text variant="body">{t('settings.privacy')}</Text>
            <Text variant="body">{t('about.privacyBody')}</Text>
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.sm }}>
            <Text variant="label">{t('about.disclaimerTitle')}</Text>
            <Text variant="body">{t('about.disclaimer')}</Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
