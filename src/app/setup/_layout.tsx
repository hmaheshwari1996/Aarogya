/**
 * The seven-step first-run wizard.
 *
 * A plain Stack with no header of its own. Every step renders its own `ScreenHeader`,
 * whose back control is a labelled 56dp target rather than the 24dp chevron a native
 * header would hand a user with a tremor — and several steps need the header's title to
 * BE the question, which a navigation header cannot do at that size.
 *
 * The progress dots are duplicated verbatim inside each step rather than living here.
 * A component rendered by this layout would sit above the Stack in a band of its own,
 * so it could not be part of a step's scroll area, and it would have no way to know
 * which step is showing without reading the navigation state. Seven identical twelve-line
 * copies is the cheaper honesty.
 *
 * THE FOOTER IS NOT DUPLICATED, and that argument does not apply to it. `WizardFooter`
 * below is handed to `Screen`'s `footer` prop by each step, so it still renders inside
 * that step, pinned outside its scroll area — the layout is not in the way. What the
 * seven copies bought was seven chances to get the flex maths wrong in the same place,
 * and they did: every one of them wrote `style={{ flex: 1 }}` onto a Button, which is the
 * one thing that pinned the button to its minimum height and clipped a two-line label at
 * 1.25×. It is exported from here rather than from a file of its own because everything
 * in `src/app/` is a route unless it is a layout, and `_shared/lib.tsx` already had to
 * grow a placeholder redirect to be allowed to exist. One is enough.
 *
 * ORDER MATTERS AND IS NOT REORDERABLE:
 *   1 language + name + whose phone   (whose phone can end the wizard here)
 *   2 what the doctor is treating     (skippable — a pack only enables, never requires)
 *   3 dose times                      (the ONE step with no skip)
 *   4 emergency contact               (skippable)
 *   5 permission to show reminders    (skippable)
 *   6 the prescription-reading key    (skippable — nothing in the app requires one)
 *   7 the reminder check              (the last word is "does an alarm actually arrive")
 *
 * STEP 6 SITS WHERE IT DOES ON PURPOSE. It is the only step that asks the setter to leave
 * the app, sign in to something and come back, so it goes after every question that is
 * about the patient herself — abandoning it costs her nothing that has already been
 * answered. It goes BEFORE the reminder check because that check is written to be the
 * last word of the wizard, and because a key pasted after "Finish" would have no screen
 * left to land on.
 *
 * Every step commits its own answer before it navigates, so a wizard abandoned at step 4
 * leaves a usable app rather than nothing at all.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';

import { spacing } from '@/theme';
import { Button, type ButtonProps } from '@/components/ui';

/**
 * One action in the wizard's footer. Everything a Button takes except the two things
 * the footer decides for itself: how wide it is, and how it sits in the row.
 */
export type WizardAction = Omit<ButtonProps, 'fullWidth' | 'style'>;

export type WizardFooterProps = {
  /** In reading order. `row` expects exactly two; `stack` takes as many as it is given. */
  actions: readonly WizardAction[];
  /**
   * `row` — two equal halves, for the Skip / Next pair five of the steps share.
   * `stack` — full width, one under the other, for the two steps whose actions are not
   * a pair of equals and whose order carries meaning (ai-key, health).
   */
  layout?: 'row' | 'stack';
};

/**
 * The pinned footer of a wizard step. Always passed to `Screen`'s `footer` prop, which is
 * what puts it outside the scroll area and clear of the gesture bar.
 *
 * THE `flex: 1` LIVES ON THE WRAPPER VIEW, NOT ON THE BUTTON. That is the whole reason
 * this component exists rather than seven hand-written rows. A wrapper is a real flex
 * child of this row, so `flex: 1` means "half the width", which is what every call site
 * meant. On the Button it used to mean `flexBasis: 0` on the HEIGHT — see the note in
 * `components/ui/Button.tsx` — which capped the button at its minimum height and clipped
 * any label that wrapped. Nothing here sets a height: at 1.25× a two-line label makes the
 * button taller, the button makes this footer taller, and the scroll area above it gives
 * up the space.
 */
export function WizardFooter({ actions, layout = 'row' }: WizardFooterProps) {
  if (layout === 'stack') {
    return (
      <View style={{ gap: spacing.md }}>
        {actions.map((action, index) => (
          // Index keys are correct here and only here: each call site passes a literal
          // array of a fixed length, so position IS the identity.
          <Button key={index} {...action} fullWidth />
        ))}
      </View>
    );
  }

  return (
    <View style={{ flexDirection: 'row', gap: spacing.md }}>
      {actions.map((action, index) => (
        <View key={index} style={{ flex: 1 }}>
          <Button {...action} fullWidth />
        </View>
      ))}
    </View>
  );
}

export default function SetupLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Left-to-right motion is the only thing telling this user she moved FORWARD
        // through a sequence rather than sideways into an unrelated screen.
        animation: 'slide_from_right',
      }}
    />
  );
}
