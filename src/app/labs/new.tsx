/**
 * Adding a lab report — THE PHOTOGRAPH IS THE PRIMARY ACTION, AND THAT IS THE WHOLE
 * DESIGN.
 *
 * A picture of the paper is a complete, valid lab record. It is legible, it is
 * transcription-error-free, it takes one tap, and a doctor can read it across a desk. A
 * form that opens with twelve empty number fields is a form that gets abandoned at field
 * three, and an abandoned form stores nothing at all — so the app ends up with neither
 * the numbers nor the picture.
 *
 * Everything below the divider is therefore optional and says so. If she photographs the
 * report and presses Save, one row is written carrying the photo and no value, and that
 * row is a real record: `value_text` NULL is honest, and the image is still there when
 * somebody wants the numbers off it.
 *
 * `ref_range_text` is not asked for here. It is transcription, it belongs beside the
 * paper, and it is editable on the result's own screen — and the app will never fill it
 * in on its own.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';

import {
  Banner,
  Button,
  Card,
  Chip,
  Divider,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  SectionHeader,
  Text,
  TextField,
  useToast,
} from '@/components/ui';
import { ActiveProfileTag } from '@/app/profiles/_lib';
import { useAsync, useT, useProfileId, type LocalStrings } from '@/app/_shared/lib';
import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, toLocalDate } from '@/lib/datetime';
import { newId } from '@/lib/ids';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { inTransaction } from '@/db/repositories/_shared';
import { createLabResult, listLabTestDefs, type LabTestDef } from '@/db/repositories/labs';

const STRINGS: LocalStrings = {
  'labsNew.title': { en: 'Add a lab report', hi: 'जाँच की रिपोर्ट जोड़ें' },
  'labsNew.photograph': { en: 'Photograph the report', hi: 'रिपोर्ट की फोटो लें' },
  'labsNew.fromGallery': { en: 'Use a photo already on the phone', hi: 'फोन में रखी फोटो लें' },
  'labsNew.retake': { en: 'Take the photo again', hi: 'फिर से फोटो लें' },
  'labsNew.photoIsEnough': {
    en: 'The photograph on its own is enough. You do not have to type anything.',
    hi: 'सिर्फ़ फोटो ही काफ़ी है। कुछ भी लिखना ज़रूरी नहीं।',
  },
  'labsNew.photoTaken': { en: 'Photograph of the report', hi: 'रिपोर्ट की फोटो' },
  'labsNew.typeSection': { en: 'You can also type the numbers', hi: 'चाहें तो नंबर भी लिख सकती हैं' },
  'labsNew.typeSectionHelp': {
    en: 'Only if you want to. Typed numbers can be drawn on a chart later.',
    hi: 'सिर्फ़ अगर आप चाहें। लिखे हुए नंबर बाद में ग्राफ़ में दिख सकते हैं।',
  },
  'labsNew.whichTests': { en: 'Which tests are on the report?', hi: 'रिपोर्ट में कौन सी जाँचें हैं?' },
  'labsNew.otherTest': { en: 'Something else', hi: 'कोई और जाँच' },
  'labsNew.testName': { en: 'Name of the test', hi: 'जाँच का नाम' },
  'labsNew.value': { en: 'What does it say?', hi: 'उसमें क्या लिखा है?' },
  'labsNew.valueHelper': {
    en: 'Copy it exactly, even if it is a word like Negative.',
    hi: 'जैसा लिखा है वैसा ही लिखें, चाहे "Negative" जैसा शब्द हो।',
  },
  'labsNew.unit': { en: 'Unit', hi: 'इकाई' },
  'labsNew.removeRow': { en: 'Remove this test', hi: 'यह जाँच हटाएँ' },
  'labsNew.labName': { en: 'Which laboratory?', hi: 'कौन सी लैब?' },
  'labsNew.collectedOn': { en: 'When was the sample taken?', hi: 'नमूना कब लिया गया था?' },
  'labsNew.dateWithWeekday': { en: '{{weekday}}, {{date}}', hi: '{{weekday}}, {{date}}' },
  'labsNew.dayEarlier': { en: 'One day earlier', hi: 'एक दिन पहले' },
  'labsNew.dayLater': { en: 'One day later', hi: 'एक दिन बाद' },
  'labsNew.nothingYet': {
    en: 'Take a photograph, or type at least one value, and then save.',
    hi: 'फोटो लें, या कम से कम एक नंबर लिखें, फिर सेव करें।',
  },
  'labsNew.tooManyRows': {
    en: 'You can type up to {{count}} tests here. Anything else is on the photograph.',
    hi: 'यहाँ ज़्यादा से ज़्यादा {{count}} जाँचें लिख सकती हैं। बाकी फोटो में तो है ही।',
  },
  'labsNew.reportPhoto': { en: 'Lab report', hi: 'जाँच की रिपोर्ट' },
  'labsNew.cameraBusy': { en: 'The camera did not open. Please try again.', hi: 'कैमरा नहीं खुला। फिर कोशिश करें।' },
};

/** More than this and she should be photographing the page, not retyping it. */
const MAX_VALUE_ROWS = 15;

type ValueRow = {
  key: string;
  /** A registry test, or null for something she names herself. */
  testKey: string | null;
  /** Only used when `testKey` is null. */
  customLabel: string;
  value: string;
  unit: string;
};

function DateStepper({
  value,
  onChange,
  display,
  spoken,
  earlierLabel,
  laterLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Already translated. */
  display: string;
  spoken: string;
  earlierLabel: string;
  laterLabel: string;
}) {
  const { colors } = useTheme();
  const stepStyle = {
    width: spacing.touchTarget,
    height: spacing.touchTarget,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <PressableScale
        onPress={() => onChange(addDays(value, -1))}
        accessibilityRole="button"
        accessibilityLabel={earlierLabel}
        style={stepStyle}
      >
        <Icon name="minus" size={28} color={colors.primary} />
      </PressableScale>
      <View accessible accessibilityLabel={spoken} style={{ flex: 1 }}>
        <Text variant="body" weight="600" align="center" numberOfLines={1}>
          {display}
        </Text>
      </View>
      <PressableScale
        onPress={() => onChange(addDays(value, 1))}
        accessibilityRole="button"
        accessibilityLabel={laterLabel}
        style={stepStyle}
      >
        <Icon name="plus" size={28} color={colors.primary} />
      </PressableScale>
    </View>
  );
}

/**
 * Copies the picked image out of the picker's cache and into the app's document
 * directory.
 *
 * The URI `expo-image-picker` hands back lives in the cache directory, which Android is
 * free to empty whenever storage runs low. On the 2 GB handsets this app targets that is
 * not hypothetical — and the file it would delete is, for a photo-only row, the entire
 * lab result. Returns the original URI if the copy fails, because a fragile record still
 * beats no record.
 */
function persistPhoto(sourceUri: string): string {
  try {
    const source = new File(sourceUri);
    const directory = new Directory(Paths.document, 'labs');
    if (!directory.exists) directory.create();
    const extension = source.extension && source.extension.length > 1 ? source.extension : '.jpg';
    const destination = new File(directory, `${newId()}${extension}`);
    source.copy(destination);
    return destination.uri;
  } catch (error) {
    console.warn('[labs] could not copy the report photo out of the cache', error);
    return sourceUri;
  }
}

export default function NewLabScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const { formatDate, formatWeekday } = useDateFormat();
  const toast = useToast();

  const profile = useProfileId();
  const profileId = profile.data;

  const defs = useAsync(async () => listLabTestDefs(), []);

  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [labName, setLabName] = useState('');
  const [collectedOn, setCollectedOn] = useState<string>(toLocalDate());
  const [rows, setRows] = useState<readonly ValueRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);

  const describeDate = useCallback(
    (localDate: string, short: boolean) =>
      t('labsNew.dateWithWeekday', {
        weekday: formatWeekday(localDate, short),
        date: formatDate(localDate),
      }),
    [formatDate, formatWeekday, t],
  );

  const labelFor = useCallback(
    (def: LabTestDef) => (lang === 'hi' ? def.labelHi : def.labelEn),
    [lang],
  );

  const takePhoto = useCallback(async () => {
    setPickerBusy(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        toast.show({ message: t('errors.cameraDenied'), variant: 'error' });
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        // Not 1.0: a 12-megapixel JPEG of an A4 page is unreadable-large on a Go-class
        // phone's storage and no more legible than a 0.7-quality one.
        quality: 0.7,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      setPhotoUri(persistPhoto(asset.uri));
    } catch {
      toast.show({ message: t('labsNew.cameraBusy'), variant: 'error' });
    } finally {
      setPickerBusy(false);
    }
  }, [t, toast]);

  const pickPhoto = useCallback(async () => {
    setPickerBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      setPhotoUri(persistPhoto(asset.uri));
    } catch {
      toast.show({ message: t('labsNew.cameraBusy'), variant: 'error' });
    } finally {
      setPickerBusy(false);
    }
  }, [t, toast]);

  const toggleTest = useCallback((def: LabTestDef) => {
    setRows((current) => {
      const existing = current.find((row) => row.testKey === def.key);
      if (existing) return current.filter((row) => row.key !== existing.key);
      if (current.length >= MAX_VALUE_ROWS) return current;
      return [
        ...current,
        { key: newId(), testKey: def.key, customLabel: '', value: '', unit: def.unit ?? '' },
      ];
    });
  }, []);

  const addCustomRow = useCallback(() => {
    setRows((current) =>
      current.length >= MAX_VALUE_ROWS
        ? current
        : [...current, { key: newId(), testKey: null, customLabel: '', value: '', unit: '' }],
    );
  }, []);

  const patchRow = useCallback((key: string, patch: Partial<ValueRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  }, []);

  const filledRows = useMemo(
    () =>
      rows.filter(
        (row) => row.value.trim().length > 0 && (row.testKey !== null || row.customLabel.trim().length > 0),
      ),
    [rows],
  );

  const canSave = photoUri !== null || filledRows.length > 0;

  const save = useCallback(async () => {
    if (!profileId || !canSave) return;
    setSaving(true);
    try {
      const shared = {
        profileId,
        collectedOn,
        labName: labName.trim() === '' ? null : labName.trim(),
        reportUri: photoUri,
        // Typed by the person holding the paper, so it is confirmed by construction.
        // Nothing on this screen is machine-read.
        source: 'manual' as const,
      };

      // One transaction for the whole report: a half-written set of values is worse than
      // none, because the missing half is invisible on the list afterwards.
      await inTransaction(async (tx) => {
        if (filledRows.length === 0) {
          // Photo only. `value` is left undefined so `value_text` stays NULL — "we have a
          // picture and no transcription" is a truthful row, and a placeholder value
          // would not be.
          await createLabResult({ ...shared, customLabel: t('labsNew.reportPhoto') }, tx);
          return;
        }
        for (const row of filledRows) {
          const identity =
            row.testKey !== null
              ? ({ testKey: row.testKey } as const)
              : ({ customLabel: row.customLabel.trim() } as const);
          await createLabResult(
            {
              ...shared,
              ...identity,
              value: row.value.trim(),
              unit: row.unit.trim() === '' ? null : row.unit.trim(),
            },
            tx,
          );
        }
      });

      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [canSave, collectedOn, filledRows, labName, photoUri, profileId, t, toast]);

  const testDefs = defs.data ?? [];

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
      <ScreenHeader title={t('labsNew.title')} onBack={() => router.back()} />

      {/* Whose lab this is — the active profile is a device-global pointer a carer can have
          switched. No-ops on a single-profile install. */}
      <ActiveProfileTag />

      {/* ── The primary action, above everything else on the screen ───────────── */}
      <Card style={{ gap: spacing.md }}>
        <Button
          title={photoUri ? t('labsNew.retake') : t('labsNew.photograph')}
          onPress={() => void takePhoto()}
          size="xl"
          fullWidth
          loading={pickerBusy}
        />
        <Button
          title={t('labsNew.fromGallery')}
          onPress={() => void pickPhoto()}
          variant="secondary"
          fullWidth
          disabled={pickerBusy}
        />

        {photoUri ? (
          <Image
            source={{ uri: photoUri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('labsNew.photoTaken')}
            resizeMode="contain"
            style={{ width: '100%', height: 220, borderRadius: radii.md }}
          />
        ) : null}

        <Text variant="body" tone="muted">
          {t('labsNew.photoIsEnough')}
        </Text>
      </Card>

      {!canSave ? (
        <Banner variant="info" title={t('labsNew.nothingYet')} style={{ marginTop: spacing.lg }} />
      ) : null}

      <Divider strong style={{ marginVertical: spacing.xl }} />

      {/* ── Everything below here is optional ─────────────────────────────────── */}
      <SectionHeader title={t('labsNew.typeSection')} subtitle={t('labsNew.typeSectionHelp')} />

      <Card style={{ gap: spacing.lg }}>
        <TextField
          label={t('labsNew.labName')}
          value={labName}
          onChangeText={setLabName}
          helper={t('common.optional')}
          autoCapitalize="words"
        />

        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('labsNew.collectedOn')}</Text>
          <DateStepper
            value={collectedOn}
            onChange={setCollectedOn}
            display={describeDate(collectedOn, true)}
            spoken={describeDate(collectedOn, false)}
            earlierLabel={t('labsNew.dayEarlier')}
            laterLabel={t('labsNew.dayLater')}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('labsNew.whichTests')}</Text>
          {/* `lab_test_def` is shipped reference data — thirteen rows, not user content. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {testDefs.map((def) => (
              <Chip
                key={def.key}
                label={labelFor(def)}
                selected={rows.some((row) => row.testKey === def.key)}
                onPress={() => toggleTest(def)}
                selectionMode="multiple"
              />
            ))}
            <Chip
              label={t('labsNew.otherTest')}
              selected={false}
              onPress={addCustomRow}
              selectionMode="multiple"
            />
          </View>
        </View>
      </Card>

      {rows.length >= MAX_VALUE_ROWS ? (
        <Banner
          variant="info"
          title={t('labsNew.tooManyRows', { count: MAX_VALUE_ROWS })}
          style={{ marginTop: spacing.lg }}
        />
      ) : null}

      {/* Capped at MAX_VALUE_ROWS by every path that can add one, so this is bounded. */}
      {rows.map((row) => {
        const def = testDefs.find((entry) => entry.key === row.testKey);
        return (
          <Card key={row.key} style={{ gap: spacing.md, marginTop: spacing.lg }}>
            {def ? (
              <Text variant="label">{labelFor(def)}</Text>
            ) : (
              <TextField
                label={t('labsNew.testName')}
                value={row.customLabel}
                onChangeText={(text) => patchRow(row.key, { customLabel: text })}
                autoCapitalize="words"
              />
            )}

            <TextField
              label={t('labsNew.value')}
              helper={t('labsNew.valueHelper')}
              value={row.value}
              onChangeText={(text) => patchRow(row.key, { value: text })}
            />

            <TextField
              label={t('labsNew.unit')}
              value={row.unit}
              onChangeText={(text) => patchRow(row.key, { unit: text })}
              helper={t('common.optional')}
            />

            <Button
              title={t('labsNew.removeRow')}
              onPress={() => removeRow(row.key)}
              variant="secondary"
              fullWidth
            />
          </Card>
        );
      })}
    </Screen>
  );
}
