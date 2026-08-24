/**
 * Where a broken link lands.
 *
 * The likely arrival here is not a typo in a URL — it is a notification deep link for a
 * dose whose occurrence was rebuilt by a reconcile, or a viewer invite link opened after
 * it expired. So the copy says "this is no longer here" rather than "page not found",
 * and the way out is one large button to Today rather than a back gesture she may not
 * know. Nothing on this screen implies she did something wrong.
 */

import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { Button, EmptyState, Screen } from '@/components/ui';

import { useT, type LocalStrings } from './_shared/lib';

const STRINGS: LocalStrings = {
  'notFound.title': { en: 'This is no longer here', hi: 'यह अब यहाँ नहीं है' },
  'notFound.message': {
    en: 'Whatever you tapped has moved or been removed. Everything you have recorded is safe.',
    hi: 'आपने जो दबाया वह हट चुका है या बदल गया है। आपका दर्ज किया हुआ सब कुछ सुरक्षित है।',
  },
  'notFound.goHome': { en: 'Go to Today', hi: 'आज पर जाइए' },
};

export default function NotFoundScreen() {
  const t = useT(STRINGS);

  return (
    <Screen variant="fixed" background="bg">
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.xl }}>
        <EmptyState icon="info" title={t('notFound.title')} message={t('notFound.message')} />
        <Button
          title={t('notFound.goHome')}
          onPress={() => router.replace('/(tabs)')}
          size="xl"
          fullWidth
        />
      </View>
    </Screen>
  );
}
