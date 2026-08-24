/**
 * A containment wall around one piece of a screen.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A charting library that throws must degrade to "this chart could not be drawn"
 * in one card. It must never take down an app that somebody relies on to be told
 * when to take her heart medicine. That is the whole argument for this file.
 *
 * The concrete incident: `react-native-gifted-charts` declares
 * `expo-linear-gradient` an OPTIONAL peer, but its `BarChart` reaches for it, and
 * the shim throws when neither gradient package resolves. Trends was the only
 * screen importing `BarChart`, so opening that tab killed the process. One chart
 * library, one missing optional dependency, no reminders.
 *
 * ─── WHAT IT CAN AND CANNOT CATCH — READ THIS BEFORE TRUSTING IT ─────────────
 *
 * A React error boundary catches throws during RENDER, in LIFECYCLE methods, and
 * in the CONSTRUCTORS of everything below it. That is the majority of what a
 * chart library does wrong: a NaN coordinate, a zero step, an SVG path it refuses
 * to build, a sub-component reaching for a native module at first paint.
 *
 * It does NOT catch:
 *   • a throw at MODULE SCOPE of a statically imported dependency. That happens
 *     while the route module is being evaluated, before any component of ours
 *     exists, so there is no mounted boundary to catch it. The gradient incident
 *     above was exactly this shape, and the only nets under it are the root
 *     boundary in `src/app/_layout.tsx` and a dependency that is actually
 *     installed. This file narrows the blast radius of the NEXT failure; it does
 *     not retroactively make that one survivable.
 *   • anything thrown from an event handler, a timer, or a promise. Those never
 *     reach a boundary in any React version.
 *
 * ─── DESIGN NOTES ────────────────────────────────────────────────────────────
 *
 * STRINGS ARE PROPS, ALREADY TRANSLATED, AND REQUIRED. Every other primitive in
 * this folder reads `useI18n()` and looks its own keys up in the shared bundle.
 * This one cannot: the bundle is owned elsewhere, and a fallback with an English
 * literal baked into it is exactly the failure this app refuses to ship — an
 * elderly Hindi reader meeting raw English at the one moment something has
 * already gone wrong. Required props push the translation back to the caller,
 * who owns a `LocalStrings` map, and make it impossible to forget.
 *
 * THE RAW ERROR IS LOGGED, NOT SHOWN. The root boundary prints `error.message`
 * because when the whole app is down that string is the only lead anyone has.
 * Here the rest of the screen is still working, and a stack trace under a blood
 * pressure card is noise to the person reading it and alarm to nobody's benefit.
 * It goes to the console, where the son and `adb logcat` can find it — AND to the
 * developer log, where he can find it without a cable. See `componentDidCatch`.
 *
 * RESETTING. "Try again" clears the caught error and re-renders the subtree. If
 * the cause is deterministic the subtree throws again and the fallback comes
 * straight back — one cycle per press, never a loop. `resetKey` covers the more
 * common case: the input changed (a different period, a reloaded query), so what
 * failed a moment ago is not what is about to be rendered, and the fallback
 * should get out of the way without the user having to ask.
 */

import React from 'react';
import { View } from 'react-native';

import { recordAppError } from '@/features/devlog';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

export type ErrorBoundaryProps = {
  children: React.ReactNode;
  /** Already translated by the caller. What failed, in the user's own words. */
  title: string;
  /** Already translated. Says what is and is not affected — never a stack trace. */
  message: string;
  /** Already translated. The label on the reset button. */
  retryLabel: string;
  /**
   * Prefix for the console line, e.g. `trends/bp`. Not user-facing, so it is a
   * plain string on purpose — this is the one place a bare literal is correct.
   *
   * IT MUST STAY A LITERAL. It now also names the failing block in the developer
   * log, which is built to be copied out of the phone and pasted into a chat with
   * a stranger. A computed tag — a medicine name, a file name, anything read off
   * the record — would put that in the one place this app promises never to.
   * `redact.ts` washes the value on the way in, but the rule is the guarantee and
   * the scrubber is only the net.
   */
  logTag: string;
  /**
   * When this value changes, a caught error is cleared and the subtree is given
   * another chance. Pass whatever the subtree is a function of.
   */
  resetKey?: string | number;
};

type ErrorBoundaryState = { error: Error | null };

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // `componentStack` is the part that names the failing chart; `error.stack`
    // alone points at the library and not at which of six cards asked for it.
    console.warn(
      `[${this.props.logTag}] this block could not be rendered; the rest of the screen is unaffected`,
      error,
      info.componentStack,
    );

    // ── AND INTO THE DEVELOPER LOG ────────────────────────────────────────────
    //
    // This is the ONE crash class the user actually SEES: the global recorder
    // installed at boot catches what nothing else caught, but React hands a render
    // throw to this boundary instead, so `ErrorUtils` never hears about it. The
    // fallback card below therefore appeared on her phone while the log her son was
    // reading said nothing had gone wrong — the exact failure the log was added to
    // make answerable without a cable.
    //
    // `where` carries the tag, so "which of six cards" survives into a log that has
    // no component stack in it. The stack is deliberately not passed: `recordAppError`
    // keeps the first frame only, and `componentStack` is a dozen lines of layout.
    //
    // COSTS NOTHING WHEN THE TOGGLE IS OFF, and that is checked rather than assumed:
    // `recordAppError` (devlog/store.ts) returns on `if (!isRecording())` before it
    // touches the error, and `isRecording()` is a module-level boolean in
    // devlog/recorder.ts. No file is opened, no database is read, nothing is written,
    // and the "we will not store the logs at all" guarantee is untouched.
    recordAppError(error, `render:${this.props.logTag}`);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <ErrorBoundaryFallback
        title={this.props.title}
        message={this.props.message}
        retryLabel={this.props.retryLabel}
        onRetry={this.reset}
      />
    );
  }
}

/**
 * Split out as a function component purely so the fallback can use hooks — a
 * class cannot call `useTheme()`, and a fallback hard-coded to one colour scheme
 * would be unreadable in the dark mode this app is actually used in.
 *
 * Nothing here is inside an `accessible` wrapper: the message and the button must
 * be two separate TalkBack stops, or the only way out of the failure is a button
 * the screen reader never lands on.
 */
function ErrorBoundaryFallback({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View style={{ gap: spacing.md, paddingVertical: spacing.lg }}>
      {/* `attention`, never `destructive`. Nothing was lost and nothing is wrong
          with the user's health — a drawing did not happen. */}
      <Icon name="alert" size={32} color={colors.attention} strokeWidth={1.8} />
      <Text variant="label">{title}</Text>
      <Text variant="body" tone="muted">
        {message}
      </Text>
      <Button title={retryLabel} onPress={onRetry} variant="secondary" size="md" />
    </View>
  );
}

export default ErrorBoundary;
