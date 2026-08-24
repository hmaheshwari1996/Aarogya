/**
 * Add a patient — a name, then straight into the SHARED setup flow.
 *
 * Reuses `/setup/conditions` rather than duplicating the condition-pack picker: the new
 * patient is created here, made the active (viewed) profile, and setup continues against her
 * because every setup step resolves the active profile. Entering the wizard at the conditions
 * step skips "whose phone is this" and the name — those are answered here — and everything
 * downstream already commits its own answer before it navigates, so an abandoned add still
 * leaves a usable extra patient.
 *
 * Created as NON-default on purpose: adding grandmother must not demote mother as the profile
 * the app falls back to. The new patient becomes ACTIVE (what is on screen), which is a
 * separate thing from default (the fallback).
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { Button, Screen, ScreenHeader, TextField, useToast } from '@/components/ui';
import { createProfile } from '@/db/repositories/profiles';
import { useT, type LocalStrings } from '@/app/_shared/lib';
import { switchToProfile } from './_lib';

// Screen-local copy, en AND hi. Inline (not shared from _lib) because `check:i18n` looks for
// the map in the same file as the `t()` calls.
const STRINGS: LocalStrings = {
  'profiles.newTitle': { en: 'Add a Patient', hi: 'नया मरीज़ जोड़ें' },
  'profiles.newNameLabel': { en: 'Patient’s name', hi: 'मरीज़ का नाम' },
  'profiles.newNameHelper': {
    en: 'Whose health this is. Next you’ll choose what their doctor is treating them for.',
    hi: 'यह किसका स्वास्थ्य है। आगे आप चुनेंगी कि उनका डॉक्टर किस चीज़ का इलाज कर रहा है।',
  },
  'profiles.create': { en: 'Continue', hi: 'आगे बढ़ें' },
};

export default function NewProfileScreen() {
  const t = useT(STRINGS);
  const toast = useToast();

  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const create = useCallback(async () => {
    const displayName = name.trim();
    if (!displayName || saving) return;
    setSaving(true);
    try {
      const id = await createProfile({ displayName, isDefault: false });
      // Make the new patient the one on screen, then continue setup against her.
      await switchToProfile(id);
      router.replace('/setup/conditions');
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      setSaving(false);
    }
  }, [name, saving, toast, t]);

  const canContinue = name.trim() !== '';

  return (
    <Screen
      variant="scroll"
      footer={
        <Button
          title={t('profiles.create')}
          onPress={() => void create()}
          size="lg"
          fullWidth
          loading={saving}
          disabled={!canContinue}
        />
      }
    >
      <ScreenHeader title={t('profiles.newTitle')} onBack={() => router.back()} />

      <View style={{ gap: spacing.md }}>
        <TextField
          label={t('profiles.newNameLabel')}
          helper={t('profiles.newNameHelper')}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={60}
          returnKeyType="done"
          onSubmitEditing={() => void create()}
        />
      </View>
    </Screen>
  );
}
