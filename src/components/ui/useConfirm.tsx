/**
 * Promise-based confirmation.
 *
 * THE APP NEVER CALLS `Alert.alert` OR `confirm()`. Three reasons, in order of weight:
 *
 *  1. A system alert ignores the theme AND ignores large-text mode. The one dialog that
 *     asks "stop this medicine?" would render at 16sp for a user who has told the app
 *     twice that she cannot read 16sp.
 *  2. Its button order and styling are decided by the OEM, so the destructive action
 *     lands under a different finger on different phones.
 *  3. `Alert.alert` is callback-shaped, which pushes every caller into nested closures
 *     around an await-shaped decision.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (await confirm({ title: t('medicines.stopTitle', { name }), destructive: true })) { … }
 */

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { View } from 'react-native';

import { useI18n } from '@/i18n';
import { spacing } from '@/theme';

import { Button } from './Button';
import { Dialog } from './Dialog';

export type ConfirmOptions = {
  /** Already translated by the caller. */
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the destructive variant, with its warning icon. */
  destructive?: boolean;
};

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

type PendingConfirm = { options: ConfirmOptions };

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Held in a ref, not in state: settling the promise must not depend on a render
  // having happened, and a stale resolver would hang the caller's await forever.
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(result);
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A confirm raised while one is already open resolves the older one false
        // rather than orphaning its promise.
        const previous = resolverRef.current;
        if (previous) previous(false);
        resolverRef.current = resolve;
        setPending({ options });
      }),
    [],
  );

  const options = pending?.options;

  return (
    // `confirm` is already stable across renders, so it is the context value directly.
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        visible={pending !== null}
        title={options?.title}
        message={options?.message}
        // Both the backdrop and hardware back resolve false — the safe answer.
        dismissOnBackdrop
        onRequestClose={() => settle(false)}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={options?.cancelLabel ?? t('common.cancel')}
              onPress={() => settle(false)}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={options?.confirmLabel ?? t('common.confirm')}
              onPress={() => settle(true)}
              variant={options?.destructive ? 'destructive' : 'primary'}
              size="lg"
              fullWidth
            />
          </View>
        }
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const value = useContext(ConfirmContext);
  if (!value) {
    throw new Error('useConfirm() was called outside <ConfirmProvider>. Wrap the app root in it.');
  }
  return value;
}

export default useConfirm;
