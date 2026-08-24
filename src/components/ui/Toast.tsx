/**
 * Transient messages.
 *
 * Toasts here are strictly for FEEDBACK ON AN ACTION ALREADY COMPLETED — "Saved",
 * "Could not send the report". Nothing that requires a decision goes in a toast: a
 * decision needs `useConfirm`, which cannot time out while the user is still reading it.
 *
 * The default duration is long (4.5s). The stock 2s is tuned for a reader who takes in a
 * line at a glance, and this app's primary user does not.
 *
 * Announced through `announceForAccessibility` as well as `accessibilityLiveRegion`,
 * because a live region on a view that mounts and unmounts is unreliable on Android —
 * TalkBack frequently misses the insertion.
 *
 * KNOWN LIMIT: the host is an in-tree overlay, not its own Modal, so a toast raised while
 * a Dialog is open renders behind it. That is the right trade — a Modal-hosted toast
 * swallows touches on Android — and in practice a toast follows the dialog closing.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';
import { durations, radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ToastVariant = 'success' | 'error' | 'info';

export type ToastOptions = {
  /** Already translated by the caller. */
  message: string;
  variant?: ToastVariant;
  /** Milliseconds on screen. */
  duration?: number;
};

export type ToastApi = {
  show: (options: ToastOptions) => void;
  hide: () => void;
};

const DEFAULT_DURATION = 4500;

const ToastContext = createContext<ToastApi | null>(null);

type ActiveToast = Required<Pick<ToastOptions, 'message' | 'variant'>>;

const VARIANT_ICONS: Record<ToastVariant, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  const [toast, setToast] = useState<ActiveToast | null>(null);
  /**
   * The two animation drivers live in lazily-initialised state, not in refs. The overlay's
   * style object below reads both DURING RENDER, which is exactly what React's ref rules
   * forbid — and `useRef(new Animated.Value(0))` also constructed a throwaway
   * Animated.Value on every render. `useState` with an initialiser function runs once and
   * the identity is stable for the provider's whole life, which is what the in-flight
   * `Animated.parallel` below is holding on to. Neither setter is ever called; these are
   * per-instance slots, not state.
   *
   * The host stays an in-tree overlay (see the header) — none of this changes that.
   */
  const [opacity] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(24));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: durations.normal, useNativeDriver: true }),
      Animated.timing(translateY, {
        toValue: 24,
        duration: durations.normal,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      // Only unmount if the animation ran to completion — a new toast that interrupted
      // this one has already replaced the content.
      if (finished) setToast(null);
    });
  }, [clearTimer, opacity, translateY]);

  const show = useCallback(
    ({ message, variant = 'info', duration = DEFAULT_DURATION }: ToastOptions) => {
      clearTimer();
      setToast({ message, variant });
      AccessibilityInfo.announceForAccessibility(message);
      opacity.setValue(0);
      translateY.setValue(24);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: durations.normal, useNativeDriver: true }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: durations.normal,
          useNativeDriver: true,
        }),
      ]).start();
      timerRef.current = setTimeout(hide, duration);
    },
    [clearTimer, hide, opacity, translateY],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const api = useMemo<ToastApi>(() => ({ show, hide }), [show, hide]);

  const palette = toast
    ? toast.variant === 'success'
      ? { background: colors.successSoft, border: colors.success, icon: colors.success }
      : toast.variant === 'error'
        ? { background: colors.destructiveSoft, border: colors.destructive, icon: colors.destructive }
        : { background: colors.primarySoft, border: colors.primary, icon: colors.primary }
    : null;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast && palette ? (
        <Animated.View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: spacing.lg,
            right: spacing.lg,
            bottom: insets.bottom + spacing.lg,
            opacity,
            transform: [{ translateY }],
          }}
        >
          <PressableScale
            onPress={hide}
            accessibilityRole="button"
            accessibilityLabel={toast.message}
            accessibilityHint={t('a11y.dismissMessage')}
            accessibilityLiveRegion="polite"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.lg,
              minHeight: spacing.touchTarget,
              borderRadius: radii.lg,
              borderWidth: 2,
              borderColor: palette.border,
              backgroundColor: palette.background,
            }}
          >
            {/* The icon differentiates success from error without relying on the fill. */}
            <Icon name={VARIANT_ICONS[toast.variant]} size={26} color={palette.icon} />
            <View style={{ flex: 1 }}>
              <Text variant="body">{toast.message}</Text>
            </View>
          </PressableScale>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast() was called outside <ToastProvider>. Wrap the app root in it.');
  }
  return value;
}

export default ToastProvider;
