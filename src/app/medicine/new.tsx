/**
 * Add a medicine — step one of two.
 *
 * The screen finishes by routing STRAIGHT to `/medicine/schedule`, and it uses
 * `replace` to get there. A medicine with no schedule produces no occurrences, no
 * reminders and no adherence record; it exists in the database and does nothing. So
 * "saved" is not a stopping point here, and going back must not land the user on a
 * form that has already been submitted.
 *
 * The strip photo is optional and offered hard. For a user who cannot comfortably
 * read a 9-point drug name it is the only identifier that works at arm's length,
 * which is why the reason is written on the screen rather than assumed.
 *
 * `confirmedByUser: true` is correct here and only here: a person typed these words.
 * The AI extraction path passes false and its rows stay unschedulable until someone
 * reads them.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { Thumb, useProfileId, useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Chip,
  EmptyState,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import { ActiveProfileTag } from '@/app/profiles/_lib';
import { createMedicine } from '@/db/repositories/medicines';
import { spacing } from '@/theme';
import type { Criticality, Medicine } from '@/types';

const STRINGS: LocalStrings = {
  'new.title': { en: 'Add a medicine', hi: 'दवाई जोड़ें' },
  'new.subtitle': {
    en: 'Step 1 of 2. Next you will set the timings.',
    hi: 'दो में से पहला कदम। आगे आप समय तय करेंगी।',
  },
  'new.nameHelper': {
    en: 'Copy it exactly as it is written on the strip or the prescription.',
    hi: 'पत्ती या पर्चे पर जैसा लिखा है, हूबहू वैसा ही लिखें।',
  },
  'new.nameRequired': {
    en: 'Please write the name of the medicine.',
    hi: 'कृपया दवाई का नाम लिखें।',
  },
  'new.strengthHelper': {
    en: 'For example 500 mg. Leave it blank if you are not sure.',
    hi: 'जैसे 500 mg। पक्का न पता हो तो खाली छोड़ दें।',
  },
  'new.formLabel': { en: 'What kind of medicine is it?', hi: 'यह किस तरह की दवाई है?' },
  'new.photoTitle': { en: 'Photo of the strip', hi: 'पत्ती की फोटो' },
  'new.photoWhy': {
    en: 'A photo lets you recognise the medicine by looking at it, without reading the name.',
    hi: 'फोटो होने पर आप दवाई देखकर पहचान सकती हैं, नाम पढ़े बिना।',
  },
  'new.takePhoto': { en: 'Take a photo', hi: 'फोटो लें' },
  'new.choosePhoto': { en: 'Choose from the phone', hi: 'फोन से चुनें' },
  'new.removePhoto': { en: 'Remove the photo', hi: 'फोटो हटाएँ' },
  'new.photoLabel': { en: 'The strip photo you chose', hi: 'आपने चुनी हुई पत्ती की फोटो' },
  'new.libraryDenied': {
    en: 'Photos are not allowed. You can turn this on in phone settings.',
    hi: 'फोटो देखने की इजाज़त नहीं है। आप इसे फोन की सेटिंग में चालू कर सकती हैं।',
  },
  'new.fromPrescription': {
    en: 'Linked to the prescription',
    hi: 'पर्चे से जुड़ी हुई',
  },
  'new.fromPrescriptionMessage': {
    en: 'This medicine will be kept with the prescription you photographed.',
    hi: 'यह दवाई उस पर्चे के साथ रखी जाएगी जिसकी आपने फोटो ली थी।',
  },
  'new.continue': { en: 'Next: set the timings', hi: 'आगे: समय तय करें' },
};

const FORMS: readonly string[] = [
  'tablet',
  'capsule',
  'syrup',
  'injection',
  'inhaler',
  'drops',
  'cream',
  'other',
];

const CRITICALITIES: readonly Criticality[] = ['critical', 'standard', 'low'];

/** Compressed enough for a 2 GB device to hold a hundred of them, sharp enough to read a strip. */
const PHOTO_QUALITY = 0.6;

export default function NewMedicineScreen() {
  const t = useT(STRINGS);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const rawPrescriptionId = useLocalSearchParams<{ prescriptionId?: string | string[] }>()
    .prescriptionId;
  const prescriptionId = Array.isArray(rawPrescriptionId) ? rawPrescriptionId[0] : rawPrescriptionId;

  const profile = useProfileId();
  const profileId = profile.data;

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [strength, setStrength] = useState('');
  const [form, setForm] = useState<string | null>('tablet');
  const [criticality, setCriticality] = useState<Criticality>('standard');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = name.trim() !== '' || strength.trim() !== '' || photoUri !== null;

  const handleBack = useCallback(async () => {
    if (!dirty) {
      router.back();
      return;
    }
    const leave = await confirm({
      title: t('entry.common.discardTitle'),
      message: t('entry.common.discardMessage'),
      confirmLabel: t('entry.common.discardConfirm'),
      destructive: true,
    });
    if (leave) router.back();
  }, [dirty, confirm, router, t]);

  const takePhoto = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        toast.show({ message: t('errors.cameraDenied'), variant: 'error' });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: PHOTO_QUALITY,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) setPhotoUri(asset.uri);
    } catch {
      toast.show({ message: t('errors.generic'), variant: 'error' });
    }
  }, [toast, t]);

  const choosePhoto = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        toast.show({ message: t('new.libraryDenied'), variant: 'error' });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        quality: PHOTO_QUALITY,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset) setPhotoUri(asset.uri);
    } catch {
      toast.show({ message: t('errors.generic'), variant: 'error' });
    }
  }, [toast, t]);

  const handleSave = useCallback(async () => {
    if (saving || !profileId) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setNameError(t('new.nameRequired'));
      return;
    }
    setNameError(undefined);
    setSaving(true);
    try {
      const { threadId } = await createMedicine({
        profileId,
        nameAsWritten: trimmed,
        strength: strength.trim() === '' ? null : strength.trim(),
        form: form as Medicine['form'],
        criticality,
        stripPhotoUri: photoUri,
        prescriptionId: prescriptionId ?? null,
        source: 'manual',
        // A person typed this, on this screen, just now.
        confirmedByUser: true,
      });
      // `replace`, not `push`: the medicine is not finished until it has timings, and
      // going back from the timings screen must not return to a submitted form.
      router.replace(`/medicine/schedule?threadId=${threadId}`);
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      setSaving(false);
    }
  }, [saving, profileId, name, strength, form, criticality, photoUri, prescriptionId, router, toast, t]);

  if (profile.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('new.title')} onBack={() => router.back()} />
        <Skeleton height={200} label={t('a11y.loading')} />
      </Screen>
    );
  }

  if (!profileId) {
    return (
      <Screen>
        <ScreenHeader title={t('new.title')} onBack={() => router.back()} />
        <EmptyState title={t('errors.notFound')} icon="alert" />
      </Screen>
    );
  }

  return (
    <Screen
      variant="scroll"
      background="bgSunken"
      footer={
        <Button
          title={t('new.continue')}
          onPress={handleSave}
          variant="primary"
          size="xl"
          fullWidth
          loading={saving}
        />
      }
    >
      <ScreenHeader title={t('new.title')} subtitle={t('new.subtitle')} onBack={handleBack} />

      {/* Whose medicine this is — the active profile is a device-global pointer a carer can
          have switched. No-ops on a single-profile install. */}
      <ActiveProfileTag />

      <View style={{ gap: spacing.lg }}>
        {prescriptionId ? (
          <Banner
            variant="info"
            title={t('new.fromPrescription')}
            message={t('new.fromPrescriptionMessage')}
          />
        ) : null}

        <Card>
          <View style={{ gap: spacing.lg }}>
            <TextField
              label={t('prescription.medicineName')}
              value={name}
              onChangeText={(value) => {
                setName(value);
                if (nameError) setNameError(undefined);
              }}
              helper={t('new.nameHelper')}
              error={nameError}
              required
              autoCapitalize="words"
              autoCorrect={false}
            />
            <TextField
              label={t('medicines.strength')}
              value={strength}
              onChangeText={setStrength}
              helper={t('new.strengthHelper')}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </Card>

        {/* ── Form ────────────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('new.formLabel')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md }}>
            {FORMS.map((option) => (
              <Chip
                key={option}
                label={t(`medicines.form.${option}`)}
                selected={form === option}
                selectionMode="single"
                grow
                onPress={() => setForm(option)}
              />
            ))}
          </View>
        </Card>

        {/* ── Criticality ─────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('medicines.criticality.label')}</Text>
          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xs }}>
            {t('medicines.criticalityHelp')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.md }}>
            {CRITICALITIES.map((option) => (
              <Chip
                key={option}
                label={t(`medicines.criticality.${option}`)}
                selected={criticality === option}
                selectionMode="single"
                grow
                onPress={() => setCriticality(option)}
              />
            ))}
          </View>
        </Card>

        {/* ── Strip photo ─────────────────────────────────────────────────── */}
        <Card>
          <Text variant="label">{t('new.photoTitle')}</Text>
          <Text variant="body" tone="muted" style={{ paddingTop: spacing.xs }}>
            {t('new.photoWhy')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.md, paddingTop: spacing.md, alignItems: 'center' }}>
            <Thumb uri={photoUri} size={88} label={t('new.photoLabel')} />
            <View style={{ flex: 1, gap: spacing.sm }}>
              <Button title={t('new.takePhoto')} onPress={takePhoto} variant="secondary" size="md" fullWidth />
              <Button
                title={t('new.choosePhoto')}
                onPress={choosePhoto}
                variant="secondary"
                size="md"
                fullWidth
              />
              {photoUri ? (
                <Button
                  title={t('new.removePhoto')}
                  onPress={() => setPhotoUri(null)}
                  variant="ghost"
                  size="md"
                  fullWidth
                />
              ) : null}
            </View>
          </View>
          <Text variant="caption" tone="muted" style={{ paddingTop: spacing.md }}>
            {t('common.optional')}
          </Text>
        </Card>
      </View>
    </Screen>
  );
}
