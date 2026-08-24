/**
 * One lab result.
 *
 * The photograph is the largest thing on the screen and opens bigger still, because for
 * this user the picture of the paper is more readable than any transcription of it, and
 * because it is the only part of the record that cannot have been mistyped.
 *
 * Two things this screen will not do:
 *
 *  • It will not state a reference range of its own. `ref_range_text` is what the paper
 *    printed, or the screen says the paper printed nothing.
 *  • It will not mark a value as high, low, normal or abnormal. There is no colour, no
 *    arrow and no word doing that anywhere below.
 *
 * The confirm control exists only for machine-read rows. A row typed by the person
 * holding the report is confirmed by construction, and asking her to confirm her own
 * typing would teach her to tap "confirm" without reading — which is exactly the habit
 * that makes the OCR review queue worthless.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  Banner,
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  Icon,
  PressableScale,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useAsync, useT, type LocalStrings } from '@/app/_shared/lib';
import { useI18n } from '@/i18n';
import { useDateFormat } from '@/i18n/useDateFormat';
import { addDays, toLocalDate } from '@/lib/datetime';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  confirmLabResult,
  deleteLabResult,
  getLabResult,
  listLabTestDefs,
  updateLabResult,
  type LabResult,
  type LabTestDef,
} from '@/db/repositories/labs';

const STRINGS: LocalStrings = {
  'lab.title': { en: 'Lab result', hi: 'जाँच का नतीजा' },
  'lab.photo': { en: 'Photograph of the report', hi: 'रिपोर्ट की फोटो' },
  'lab.openPhoto': { en: 'See the photograph bigger', hi: 'फोटो बड़ी करके देखें' },
  'lab.noPhoto': { en: 'No photograph was kept for this result', hi: 'इस नतीजे की कोई फोटो नहीं रखी गई' },
  'lab.value': { en: 'What the report says', hi: 'रिपोर्ट में क्या लिखा है' },
  'lab.noValue': { en: 'Nothing was typed in — the photograph has it', hi: 'कुछ लिखा नहीं गया — फोटो में है' },
  'lab.refPrinted': { en: 'The report printed this range', hi: 'रिपोर्ट पर यह सीमा छपी है' },
  'lab.refNone': {
    en: 'The report did not print a range. Aarogya does not have one of its own.',
    hi: 'रिपोर्ट पर कोई सीमा नहीं छपी थी। आरोग्य के पास अपनी कोई सीमा नहीं है।',
  },
  'lab.collectedOn': { en: 'Sample taken on {{date}}', hi: 'नमूना {{date}} को लिया गया' },
  'lab.collectedUnknown': { en: 'The date the sample was taken is not known', hi: 'नमूना कब लिया गया, यह पता नहीं' },
  'lab.labName': { en: 'Laboratory: {{name}}', hi: 'लैब: {{name}}' },
  'lab.whereFrom': { en: 'Where this came from', hi: 'यह कहाँ से आया' },
  'lab.sourceManual': { en: 'You typed this in', hi: 'यह आपने लिखा था' },
  'lab.sourceOcr': { en: 'The app read this from a photograph', hi: 'यह ऐप ने फोटो से पढ़ा है' },
  'lab.confirmedOn': {
    en: 'You checked it against the paper on {{date}}',
    hi: 'आपने इसे {{date}} को कागज़ से मिला लिया था',
  },
  'lab.notConfirmed': {
    en: 'Nobody has checked this against the paper yet',
    hi: 'अभी किसी ने इसे कागज़ से नहीं मिलाया',
  },
  'lab.confirmAction': { en: 'It matches the paper', hi: 'यह कागज़ से मिलता है' },
  'lab.confirmed': { en: 'Marked as checked', hi: 'जाँचा हुआ दर्ज कर लिया' },
  'lab.editAction': { en: 'Change what is written here', hi: 'यहाँ लिखी बात बदलें' },
  'lab.editValue': { en: 'What does the report say?', hi: 'रिपोर्ट में क्या लिखा है?' },
  'lab.editValueHelper': {
    en: 'Copy it exactly, even if it is a word like Negative.',
    hi: 'जैसा लिखा है वैसा ही लिखें, चाहे "Negative" जैसा शब्द हो।',
  },
  'lab.editUnit': { en: 'Unit', hi: 'इकाई' },
  'lab.editRef': { en: 'The range printed on the report', hi: 'रिपोर्ट पर छपी सीमा' },
  'lab.editRefHelper': {
    en: 'Only what the paper actually printed. Leave it blank if it printed nothing.',
    hi: 'सिर्फ़ वही जो कागज़ पर छपा है। कुछ न छपा हो तो खाली छोड़ें।',
  },
  'lab.editLabName': { en: 'Which laboratory?', hi: 'कौन सी लैब?' },
  'lab.dateKnown': { en: 'I know the date the sample was taken', hi: 'नमूने की तारीख़ मुझे पता है' },
  'lab.dateWithWeekday': { en: '{{weekday}}, {{date}}', hi: '{{weekday}}, {{date}}' },
  'lab.dayEarlier': { en: 'One day earlier', hi: 'एक दिन पहले' },
  'lab.dayLater': { en: 'One day later', hi: 'एक दिन बाद' },
  'lab.deleteTitle': { en: 'Remove this result?', hi: 'यह नतीजा हटा दें?' },
  'lab.deleteMessage': {
    en: 'The photograph goes with it. This cannot be undone.',
    hi: 'फोटो भी इसके साथ चली जाएगी। यह वापस नहीं आएगा।',
  },
  'lab.deleted': { en: 'The result was removed', hi: 'नतीजा हटा दिया गया' },
  'lab.gone': { en: 'This result is no longer here', hi: 'यह नतीजा अब यहाँ नहीं है' },
  'lab.goneMessage': {
    en: 'It may have been removed from another screen.',
    hi: 'शायद इसे किसी और जगह से हटा दिया गया हो।',
  },
  'lab.backToList': { en: 'Back to the reports', hi: 'रिपोर्ट की सूची पर जाएँ' },
  'lab.loading': { en: 'Opening this result', hi: 'यह नतीजा खुल रहा है' },
  'lab.valueWithUnit': { en: '{{value}} {{unit}}', hi: '{{value}} {{unit}}' },
  'lab.unnamed': { en: 'Lab report', hi: 'जाँच की रिपोर्ट' },
};

type Loaded = { result: LabResult; defs: LabTestDef[] } | null;

export default function LabResultScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const { colors } = useTheme();
  const { formatDate, formatWeekday, formatEpochDate } = useDateFormat();
  const toast = useToast();
  const confirm = useConfirm();

  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  const loaded = useAsync<Loaded>(async () => {
    if (!id) return null;
    const [result, defs] = await Promise.all([getLabResult(id), listLabTestDefs()]);
    if (!result) return null;
    return { result, defs };
  }, [id]);

  const [zoomOpen, setZoomOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [refText, setRefText] = useState('');
  const [labName, setLabName] = useState('');
  const [dateKnown, setDateKnown] = useState(false);
  const [collectedOn, setCollectedOn] = useState<string>(toLocalDate());

  const result = loaded.data?.result ?? null;

  const label = useMemo(() => {
    if (!loaded.data) return '';
    const { result: row, defs } = loaded.data;
    if (row.testKey) {
      const def = defs.find((entry) => entry.key === row.testKey);
      if (def) return lang === 'hi' ? def.labelHi : def.labelEn;
      return row.testKey;
    }
    return row.customLabel ?? t('lab.unnamed');
  }, [lang, loaded.data, t]);

  const describeDate = useCallback(
    (localDate: string, short: boolean) =>
      t('lab.dateWithWeekday', {
        weekday: formatWeekday(localDate, short),
        date: formatDate(localDate),
      }),
    [formatDate, formatWeekday, t],
  );

  const beginEdit = useCallback(() => {
    if (!result) return;
    setValue(result.valueText ?? '');
    setUnit(result.unit ?? '');
    setRefText(result.refRangeText ?? '');
    setLabName(result.labName ?? '');
    setDateKnown(result.collectedOn !== null);
    setCollectedOn(result.collectedOn ?? toLocalDate());
    setEditing(true);
  }, [result]);

  const saveEdit = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    try {
      await updateLabResult(id, {
        value: value.trim() === '' ? null : value.trim(),
        unit: unit.trim() === '' ? null : unit.trim(),
        // Transcription is correctable because it can be mistyped — never because the app
        // may supply one. Blank stays blank.
        refRangeText: refText.trim() === '' ? null : refText.trim(),
        labName: labName.trim() === '' ? null : labName.trim(),
        // An unknown collection date stays NULL. A guessed one would look like evidence
        // on the report and there is nothing behind it.
        collectedOn: dateKnown ? collectedOn : null,
      });
      setEditing(false);
      toast.show({ message: t('entry.common.savedToast'), variant: 'success' });
      loaded.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [collectedOn, dateKnown, id, labName, loaded, refText, t, toast, unit, value]);

  const markConfirmed = useCallback(async () => {
    if (!id) return;
    setBusy(true);
    try {
      await confirmLabResult(id);
      toast.show({ message: t('lab.confirmed'), variant: 'success' });
      loaded.reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [id, loaded, t, toast]);

  const remove = useCallback(async () => {
    if (!id) return;
    const ok = await confirm({
      title: t('lab.deleteTitle'),
      message: t('lab.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteLabResult(id);
      toast.show({ message: t('lab.deleted'), variant: 'success' });
      router.back();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    }
  }, [confirm, id, t, toast]);

  if (loaded.loading) {
    return (
      <Screen background="bgSunken">
        <ScreenHeader title={t('lab.title')} onBack={() => router.back()} />
        <Skeleton height={260} label={t('lab.loading')} />
      </Screen>
    );
  }

  if (!id || !result) {
    return (
      <Screen background="bgSunken">
        <ScreenHeader title={t('lab.title')} onBack={() => router.back()} />
        <EmptyState
          title={t('lab.gone')}
          message={t('lab.goneMessage')}
          actionLabel={t('lab.backToList')}
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const printedValue =
    result.valueText === null
      ? t('lab.noValue')
      : result.unit
        ? t('lab.valueWithUnit', { value: result.valueText, unit: result.unit })
        : result.valueText;

  return (
    <Screen
      background="bgSunken"
      footer={
        editing ? (
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setEditing(false)}
              variant="secondary"
              size="lg"
              style={{ flex: 1 }}
            />
            <Button
              title={t('common.save')}
              onPress={() => void saveEdit()}
              size="lg"
              style={{ flex: 1 }}
              loading={busy}
            />
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            <Button title={t('lab.editAction')} onPress={beginEdit} size="lg" fullWidth />
            <Button
              title={t('common.delete')}
              onPress={() => void remove()}
              variant="destructive"
              fullWidth
            />
          </View>
        )
      }
    >
      <ScreenHeader title={label} subtitle={t('lab.title')} onBack={() => router.back()} />

      {loaded.error ? <Banner variant="attention" title={t('errors.loadFailed')} /> : null}

      {/* ── The photograph, first and largest ─────────────────────────────────── */}
      <Card style={{ gap: spacing.md }}>
        {result.reportUri ? (
          <PressableScale
            onPress={() => setZoomOpen(true)}
            accessibilityRole="imagebutton"
            accessibilityLabel={t('lab.photo')}
            accessibilityHint={t('lab.openPhoto')}
          >
            <Image
              source={{ uri: result.reportUri }}
              resizeMode="contain"
              style={{
                width: '100%',
                height: 300,
                borderRadius: radii.md,
                backgroundColor: colors.bgSunken,
              }}
            />
          </PressableScale>
        ) : (
          <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
            <Icon name="info" size={28} color={colors.textMuted} />
            <Text variant="body" tone="muted" style={{ flex: 1 }}>
              {t('lab.noPhoto')}
            </Text>
          </View>
        )}
      </Card>

      {/* ── What the paper says ───────────────────────────────────────────────── */}
      {editing ? (
        <Card style={{ gap: spacing.lg, marginTop: spacing.lg }}>
          <TextField
            label={t('lab.editValue')}
            helper={t('lab.editValueHelper')}
            value={value}
            onChangeText={setValue}
          />
          <TextField label={t('lab.editUnit')} value={unit} onChangeText={setUnit} helper={t('common.optional')} />
          <TextField
            label={t('lab.editRef')}
            helper={t('lab.editRefHelper')}
            value={refText}
            onChangeText={setRefText}
          />
          <TextField
            label={t('lab.editLabName')}
            value={labName}
            onChangeText={setLabName}
            helper={t('common.optional')}
          />

          <View style={{ gap: spacing.sm }}>
            <Chip
              label={t('lab.dateKnown')}
              selected={dateKnown}
              onPress={() => setDateKnown((current) => !current)}
              selectionMode="multiple"
            />
            {dateKnown ? (
              <DateStepper
                value={collectedOn}
                onChange={setCollectedOn}
                display={describeDate(collectedOn, true)}
                spoken={describeDate(collectedOn, false)}
                earlierLabel={t('lab.dayEarlier')}
                laterLabel={t('lab.dayLater')}
              />
            ) : null}
          </View>
        </Card>
      ) : (
        <Card style={{ gap: spacing.md, marginTop: spacing.lg }}>
          <Text variant="caption" tone="muted">
            {t('lab.value')}
          </Text>
          <Text variant="display">{printedValue}</Text>

          <Text variant="caption" tone="muted">
            {result.refRangeText ? t('lab.refPrinted') : t('lab.refNone')}
          </Text>
          {result.refRangeText ? <Text variant="body">{result.refRangeText}</Text> : null}

          <Text variant="body" tone="muted">
            {result.collectedOn
              ? t('lab.collectedOn', { date: formatDate(result.collectedOn) })
              : t('lab.collectedUnknown')}
          </Text>
          {result.labName ? (
            <Text variant="body" tone="muted">
              {t('lab.labName', { name: result.labName })}
            </Text>
          ) : null}
        </Card>
      )}

      {/* ── Provenance ────────────────────────────────────────────────────────── */}
      <Card variant="sunken" style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <Text variant="label">{t('lab.whereFrom')}</Text>
        <Text variant="body">{t(result.source === 'ocr' ? 'lab.sourceOcr' : 'lab.sourceManual')}</Text>
        <Text variant="body" tone="muted">
          {result.confirmedAt === null
            ? t('lab.notConfirmed')
            : t('lab.confirmedOn', { date: formatEpochDate(result.confirmedAt) })}
        </Text>
        {result.confirmedAt === null && !editing ? (
          <Button
            title={t('lab.confirmAction')}
            onPress={() => void markConfirmed()}
            variant="secondary"
            fullWidth
            loading={busy}
          />
        ) : null}
      </Card>

      <Dialog
        visible={zoomOpen}
        onRequestClose={() => setZoomOpen(false)}
        scrollable={false}
        contentStyle={{ padding: spacing.sm }}
      >
        {result.reportUri ? (
          <Image
            source={{ uri: result.reportUri }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('lab.photo')}
            resizeMode="contain"
            style={{ width: '100%', height: 520, borderRadius: radii.md }}
          />
        ) : null}
      </Dialog>
    </Screen>
  );
}

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
