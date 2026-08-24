/**
 * Full-screen numeric entry for one to three values (blood pressure is systolic /
 * diastolic / pulse).
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THERE IS NO AUTO-ADVANCE BETWEEN FIELDS. This is the single most important
 * decision in this component, and it must not be "improved" later.
 *
 * Advancing on digit count is the obvious design and it is wrong in both directions:
 *
 *   • A 2-digit systolic — 90 is an ordinary reading, and a hypotensive 85 is one a
 *     doctor would act on — never reaches 3 digits, so the caret sits on systolic while
 *     the user types the diastolic into it. She then reads "9088" and cannot explain it.
 *
 *   • A mistyped 4th digit (1422 for 142) advances immediately and drops the stray digit
 *     into the diastolic field, which now silently holds "2". Nothing on screen says a
 *     boundary was crossed. The read-back shows "142 over 288" only if she reads it, and
 *     the digit that moved is invisible in the entry UI itself.
 *
 * Both are silent field-boundary errors, and a silent field-boundary error is the
 * highest-frequency safety defect available in this product. The fix is an explicit,
 * large `Next` button and nothing else: the user decides when a field is finished.
 *
 * Two consequences follow, and they are deliberate:
 *   • Backspace on an empty field does NOT jump to the previous field. That is
 *     auto-advance running backwards and it fails the same way.
 *   • A digit typed past `maxDigits` is REFUSED, not spilled. The pad says how many
 *     digits the box holds instead of quietly moving the digit somewhere else.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * The pad emits values and nothing more. It never writes. The parent takes the emitted
 * values to ReadBackDialog, and only a confirmed read-back reaches the database.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useFontSizes, useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type NumberPadField = {
  /** Stable key — becomes the key in the emitted values object. */
  key: string;
  /** Already translated by the caller. */
  label: string;
  unit?: string;
  /** Digits only; the decimal point does not count towards it. */
  maxDigits: number;
  allowDecimal?: boolean;
  /** An optional field may be left blank (pulse, for instance). */
  optional?: boolean;
};

export type NumberPadProps = {
  /** One to three fields. More than three does not fit at this key size, by design. */
  fields: readonly NumberPadField[];
  initialValues?: Readonly<Record<string, string>>;
  /** Already translated. Replaces the default "Type the number, then press Next." */
  instruction?: string;
  /** Label for the final button. Defaults to "Done". */
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
  testID?: string;
};

/** 72dp is the floor from the spec; 76 leaves room for the label without shrinking it. */
const KEY_MIN_HEIGHT = Math.max(spacing.touchTargetLarge, 76);

const DIGIT_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

/**
 * Placeholder for a field with nothing in it. A glyph, not a word — it needs no
 * translation, and TalkBack reads `t('numberPad.empty')` from the slot's label instead.
 */
const EMPTY_VALUE_GLYPH = '—';

export function NumberPad({
  fields,
  initialValues,
  instruction,
  submitLabel,
  onSubmit,
  testID,
}: NumberPadProps) {
  const { colors } = useTheme();
  const fontSizes = useFontSizes();
  const { t } = useI18n();

  const firstField = fields[0];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of fields) seed[field.key] = initialValues?.[field.key] ?? '';
    return seed;
  });
  const [activeKey, setActiveKey] = useState<string>(firstField?.key ?? '');

  const activeIndex = fields.findIndex((field) => field.key === activeKey);
  const activeField = activeIndex >= 0 ? fields[activeIndex] : undefined;
  const activeValue = activeField ? (values[activeField.key] ?? '') : '';

  const digitCount = activeValue.replace('.', '').length;
  const atMaxDigits = activeField ? digitCount >= activeField.maxDigits : false;

  const anyDecimalAllowed = fields.some((field) => field.allowDecimal);

  const appendDigit = useCallback(
    (digit: string) => {
      const field = activeField;
      if (!field) return;
      setValues((previous) => {
        const current = previous[field.key] ?? '';
        // Refuse rather than spill. See the header comment.
        if (current.replace('.', '').length >= field.maxDigits) return previous;
        // A leading zero on a measurement is always a mistype ("042"), so the first
        // zero is only kept when a decimal point can follow it ("0.5 kg").
        if (current === '0' && !field.allowDecimal) return { ...previous, [field.key]: digit };
        return { ...previous, [field.key]: current + digit };
      });
    },
    [activeField],
  );

  const appendDecimal = useCallback(() => {
    const field = activeField;
    if (!field?.allowDecimal) return;
    setValues((previous) => {
      const current = previous[field.key] ?? '';
      if (current.includes('.')) return previous;
      return { ...previous, [field.key]: current === '' ? '0.' : `${current}.` };
    });
  }, [activeField]);

  const backspace = useCallback(() => {
    const field = activeField;
    if (!field) return;
    setValues((previous) => {
      const current = previous[field.key] ?? '';
      // Stops at empty. It never walks back into the previous field.
      return { ...previous, [field.key]: current.slice(0, -1) };
    });
  }, [activeField]);

  const isFilled = useCallback(
    (field: NumberPadField) => {
      const raw = (values[field.key] ?? '').trim();
      // A bare "0." is not a number yet.
      return raw !== '' && raw !== '.' && !raw.endsWith('.');
    },
    [values],
  );

  const isLastField = activeIndex === fields.length - 1;

  const missingField = useMemo(
    () => fields.find((field) => !field.optional && !isFilled(field)),
    [fields, isFilled],
  );

  const canProceed = useMemo(() => {
    if (!activeField) return false;
    if (isLastField) return missingField === undefined;
    // Advancing past a blank required field is refused too — otherwise the user
    // reaches the read-back with a hole in it and has to start over.
    return activeField.optional || isFilled(activeField);
  }, [activeField, isLastField, missingField, isFilled]);

  const handleProceed = useCallback(() => {
    if (!activeField || !canProceed) return;
    if (!isLastField) {
      const nextField = fields[activeIndex + 1];
      if (nextField) setActiveKey(nextField.key);
      return;
    }
    const emitted: Record<string, string> = {};
    for (const field of fields) {
      const raw = (values[field.key] ?? '').trim();
      if (raw !== '') emitted[field.key] = raw;
    }
    onSubmit(emitted);
  }, [activeField, canProceed, isLastField, fields, activeIndex, values, onSubmit]);

  const renderKey = (
    label: string,
    onPress: () => void,
    options?: { accessibilityLabel?: string; icon?: 'backspace'; disabled?: boolean },
  ) => (
    <PressableScale
      key={label}
      onPress={onPress}
      disabled={options?.disabled}
      accessibilityRole="button"
      accessibilityLabel={options?.accessibilityLabel ?? t('a11y.digit', { digit: label })}
      accessibilityState={{ disabled: Boolean(options?.disabled) }}
      style={{
        flex: 1,
        minHeight: KEY_MIN_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 2,
        borderColor: colors.borderStrong,
        backgroundColor: options?.disabled ? colors.bgSunken : colors.bgElevated,
        opacity: options?.disabled ? 0.5 : 1,
      }}
    >
      {options?.icon === 'backspace' ? (
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <Icon name="close" size={26} color={colors.text} />
          <Text variant="caption">{t('numberPad.backspace')}</Text>
        </View>
      ) : (
        <Text
          style={{
            fontSize: fontSizes.xxl,
            lineHeight: Math.round(fontSizes.xxl * 1.2),
            fontWeight: '600',
            color: colors.text,
          }}
        >
          {label}
        </Text>
      )}
    </PressableScale>
  );

  return (
    <View style={{ flex: 1, gap: spacing.lg }} testID={testID}>
      {/* ── Value slots ──────────────────────────────────────────────────────── */}
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        {fields.map((field) => {
          const isActive = field.key === activeKey;
          const raw = values[field.key] ?? '';
          const shown = raw === '' ? EMPTY_VALUE_GLYPH : raw;

          return (
            <PressableScale
              key={field.key}
              onPress={() => setActiveKey(field.key)}
              accessibilityRole="button"
              accessibilityLabel={`${field.label}: ${raw === '' ? t('numberPad.empty') : raw}`}
              accessibilityHint={t('numberPad.tapToEdit')}
              accessibilityState={{ selected: isActive }}
              style={{
                flex: 1,
                minHeight: 112,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.md,
                borderRadius: radii.lg,
                borderWidth: isActive ? 3 : 2,
                borderColor: isActive ? colors.primary : colors.border,
                backgroundColor: isActive ? colors.primarySoft : colors.bgElevated,
                justifyContent: 'space-between',
                gap: spacing.xs,
              }}
            >
              <Text variant="caption" tone="muted" numberOfLines={2}>
                {field.label}
              </Text>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{
                  // One field gets the hero size; two or three share the row and take
                  // the display size so a 3-digit value still fits without shrinking.
                  fontSize: fields.length === 1 ? fontSizes.hero : fontSizes.display,
                  lineHeight: Math.round(
                    (fields.length === 1 ? fontSizes.hero : fontSizes.display) * 1.15,
                  ),
                  fontWeight: '700',
                  color: raw === '' ? colors.textMuted : colors.text,
                }}
              >
                {shown}
              </Text>
              {/* ── The caption line under the digits, and who gets to use it ──────
                  Each tile has exactly one line here, and two different things want it:
                  the word "Typing here now", and the unit.

                  ON A MULTI-FIELD PAD THE WORD WINS. Blood pressure is three tiles in a
                  row and the only thing distinguishing the one receiving digits is a
                  border colour — which is colour as the sole signal, against the house
                  rule, and unreadable to the person most likely to be helping her hold
                  the phone. So the active field says so in words.

                  ON A SINGLE-FIELD PAD THE UNIT WINS, because the word has nothing left
                  to say. There is no other tile to be typing into, the pad is the whole
                  screen, and "Typing here now" on the only box in view is an answer to a
                  question nobody asked. Meanwhile the unit is the thing that must be
                  read WITH the number: this app never offers a unit control, because
                  6.2 mmol/L filed as 6.2 mg/dL looks entirely ordinary and is
                  catastrophic — so the unit's whole job is to be impossible to miss at
                  the moment of typing.

                  This is what report 2 asked for — "just show Kgs after the text". It
                  had to be fixed HERE rather than on the weight screen: `unit` was being
                  passed by both single-field callers all along and this line silently
                  dropped it, every time, because a single-field pad's only field is
                  always the active one. Both screens were carrying the unit in the tile
                  LABEL as a parenthetical to compensate; with this line fixed they have
                  gone back to a plain "Weight" and "Blood sugar", which is why removing
                  this branch would quietly take the unit off both screens entirely.

                  AND THE UNIT IS DRAWN AT FULL STRENGTH, NOT MUTED. `muted` is the right
                  weight for a unit sitting on an idle tile the eye is not on; it is the
                  wrong weight for the only tile on screen, where the unit is half of the
                  value's meaning rather than a caption about it. Measured on the active
                  tile's `primarySoft` ground: `text` is 13.11:1 light / 9.57:1 dark,
                  against `textMuted` at 6.38:1 / 5.87:1 — the dark figure being a hair
                  under the 5.9:1 floor this file's own theme header claims for
                  `textMuted`. Full strength clears the app's ≥7:1 bar in both schemes,
                  and at caption size under hero-size bold digits it does not compete.
                  ────────────────────────────────────────────────────────────────── */}
              <Text
                variant="caption"
                tone={
                  fields.length === 1 ? 'default' : isActive ? 'primary' : 'muted'
                }
                numberOfLines={1}
              >
                {fields.length === 1
                  ? (field.unit ?? '')
                  : isActive
                    ? t('numberPad.editing')
                    : (field.unit ?? '')}
              </Text>
            </PressableScale>
          );
        })}
      </View>

      <Text variant="body" tone="muted">
        {instruction ?? t('numberPad.instruction')}
      </Text>

      {/* ── Keypad ───────────────────────────────────────────────────────────── */}
      <View style={{ flex: 1, gap: spacing.sm, justifyContent: 'flex-end' }}>
        {DIGIT_ROWS.map((row) => (
          <View key={row.join('')} style={{ flexDirection: 'row', gap: spacing.sm }}>
            {row.map((digit) =>
              renderKey(digit, () => appendDigit(digit), { disabled: atMaxDigits }),
            )}
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {anyDecimalAllowed
            ? renderKey('.', appendDecimal, {
                accessibilityLabel: t('a11y.decimalPoint'),
                disabled: !activeField?.allowDecimal || activeValue.includes('.'),
              })
            : // An empty spacer keeps '0' centred under '8' — muscle memory matters more
              // than filling the grid.
              <View key="spacer" style={{ flex: 1 }} />}
          {renderKey('0', () => appendDigit('0'), { disabled: atMaxDigits })}
          {renderKey('backspace', backspace, {
            accessibilityLabel: t('a11y.backspace'),
            icon: 'backspace',
            disabled: activeValue === '',
          })}
        </View>
      </View>

      {/* ── Status line + the explicit advance ───────────────────────────────── */}
      <View style={{ gap: spacing.md }}>
        {atMaxDigits && activeField ? (
          <Text variant="caption" tone="attention" accessibilityLiveRegion="polite">
            {t('numberPad.maxDigits', { count: activeField.maxDigits })}
          </Text>
        ) : !canProceed && missingField ? (
          <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
            {t('numberPad.enterValue', { label: missingField.label })}
          </Text>
        ) : null}

        <Button
          title={isLastField ? (submitLabel ?? t('numberPad.done')) : t('numberPad.next')}
          onPress={handleProceed}
          variant="primary"
          size="xl"
          fullWidth
          disabled={!canProceed}
        />
      </View>
    </View>
  );
}

export default NumberPad;
