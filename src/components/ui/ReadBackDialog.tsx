/**
 * The read-back gate. MANDATORY BEFORE ANY READING IS WRITTEN.
 *
 * WHY THIS GATES THE WRITE AND IS NOT A TOAST AFTERWARDS:
 * "Saved — tap to undo" means the wrong number is already in the database. Everything
 * downstream has already seen it: the chart, the streak, the adherence window, and the
 * report she may hand to a doctor twenty minutes later. Undo depends on her noticing,
 * on the toast still being on screen, and on her knowing that the small word at the
 * bottom is a button. None of those hold for this user. So the confirmation happens
 * BEFORE the insert, and the insert is downstream of `onSave` and nothing else.
 *
 * The value is rendered at `fontSize.display` (34, or 43 in large-text mode) and phrased
 * the way a person says it out loud — "142 over 88, pulse 76" — because reading a
 * spoken sentence back catches a transposition that scanning three boxed numbers does not.
 *
 * BUTTON WORDING: "Correct" alone is genuinely ambiguous — it reads both as "this is
 * correct" and as "correct this". The i18n strings resolve it explicitly ("Correct it" /
 * "Yes, save it"), and `onCorrect` always means GO BACK AND FIX, never confirm.
 */

import React from 'react';
import { View } from 'react-native';

import { useI18n } from '@/i18n';
import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { Text } from './Text';

export type ReadBackDialogProps = {
  visible: boolean;
  /**
   * The spoken-form sentence, already composed and translated by the caller — for
   * example `t('entry.bp.readBack', { systolic, diastolic, pulse })`.
   */
  readBack: string;
  title?: string;
  instruction?: string;
  /** Secondary line: the context chip, or when the reading will be recorded for. */
  detail?: string;
  correctLabel?: string;
  saveLabel?: string;
  /** True while the write is in flight. Both buttons go inert. */
  saving?: boolean;
  /** Go back and fix the value. Never writes. */
  onCorrect: () => void;
  /** The ONLY path to the database write. */
  onSave: () => void;
  testID?: string;
};

export function ReadBackDialog({
  visible,
  readBack,
  title,
  instruction,
  detail,
  correctLabel,
  saveLabel,
  saving = false,
  onCorrect,
  onSave,
  testID,
}: ReadBackDialogProps) {
  const { colors } = useTheme();
  const { t } = useI18n();

  return (
    <Dialog
      visible={visible}
      title={title ?? t('readBack.title')}
      // A tap on the backdrop must not resolve this either way, and the hardware back
      // button means "let me fix it" — the safe direction. It is a no-op mid-save
      // rather than undefined, because Android's Modal requires the handler.
      dismissOnBackdrop={false}
      onRequestClose={() => {
        if (!saving) onCorrect();
      }}
      scrollable
      testID={testID}
      footer={
        <View style={{ gap: spacing.md }}>
          {/* Save is listed second and reads as the affirmative. Correct-it sits first
              so the finger that lands without reading lands on the harmless one. */}
          <Button
            title={correctLabel ?? t('readBack.correct')}
            onPress={onCorrect}
            variant="secondary"
            size="lg"
            fullWidth
            disabled={saving}
          />
          <Button
            title={saveLabel ?? t('readBack.save')}
            onPress={onSave}
            variant="primary"
            size="xl"
            fullWidth
            loading={saving}
          />
        </View>
      }
    >
      <View style={{ gap: spacing.md }}>
        <Text variant="body" tone="muted">
          {instruction ?? t('readBack.instruction')}
        </Text>

        <View
          style={{
            paddingVertical: spacing.lg,
            paddingHorizontal: spacing.md,
            backgroundColor: colors.bgSunken,
            borderRadius: radii.md,
            borderWidth: 2,
            borderColor: colors.borderStrong,
          }}
        >
          {/* Announced as one phrase by TalkBack rather than word by word. */}
          <Text variant="display" align="center" accessibilityLabel={readBack}>
            {readBack}
          </Text>
        </View>

        {detail ? (
          <Text variant="body" tone="muted" align="center">
            {detail}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

export default ReadBackDialog;
