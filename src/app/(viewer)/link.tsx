/**
 * Opening a shared record on the family member's phone.
 *
 * ─── THE PASTE PATH IS THE PRIMARY PATH, NOT THE FALLBACK ─────────────────────
 * A tapped link only works when somebody has hosted a page and Android has verified the
 * App Link against it. That is an optional piece of setup which most installs will not
 * have, so this screen exists and works with nothing hosted anywhere: she pastes what she
 * was sent, whether that is a full https link or the bare `<id>#k=<key>` code, and both
 * parse to the same two values.
 *
 * ─── COPY THE WHOLE THING, INCLUDING THE PART AFTER THE # ─────────────────────
 * The one failure mode worth writing copy for. Some chat apps and some hands select only
 * up to the `#`, and half a link looks completely correct while opening nothing. The error
 * message says which half is missing rather than "invalid link".
 *
 * ─── THE KEY IS NEVER LOGGED ──────────────────────────────────────────────────
 * Not in a warning, not in an error, not in a toast. The pasted text goes straight into
 * `acceptViewerLink()`; nothing in this file interpolates it into anything.
 *
 * ─── WHY THE SERVER BOX IS HERE AND NOT IN A SETTINGS SCREEN ──────────────────
 * The link names a dataset; it does not say which Supabase project holds it. A viewer's
 * phone therefore needs the same project URL and public anon key the patient's phone has,
 * and this is the only screen a viewer ever sees before there is anything to look at. It
 * is shown ONLY while the phone has no project, and it says where the two values come
 * from — otherwise it is an unexplained pair of boxes in front of somebody who was told
 * "just open the link Amma sent".
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { useAsync, useT } from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Screen,
  ScreenHeader,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  acceptViewerLink,
  forgetViewerLink,
  getViewerLink,
  isSyncConfigured,
  normaliseUrl,
  setSyncConfig,
} from '@/features/sync';
import { spacing } from '@/theme';

export default function ViewerLinkScreen() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();

  const [pasted, setPasted] = useState('');
  const [projectUrl, setProjectUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [busy, setBusy] = useState(false);

  const state = useAsync<{ configured: boolean; hasLink: boolean }>(async () => {
    const [configured, link] = await Promise.all([isSyncConfigured(), getViewerLink()]);
    return { configured, hasLink: link !== null };
  }, []);

  const { reload } = state;

  const saveProject = useCallback(async () => {
    if (!normaliseUrl(projectUrl)) {
      toast.show({ message: t('viewer.server.badUrl'), variant: 'error' });
      return;
    }
    if (anonKey.trim().length === 0) {
      toast.show({ message: t('viewer.server.badKey'), variant: 'error' });
      return;
    }
    setBusy(true);
    try {
      await setSyncConfig({
        url: projectUrl,
        anonKey,
        enabled: true,
        role: 'viewer',
      });
      toast.show({ message: t('viewer.server.saved'), variant: 'success' });
      reload();
    } catch (error) {
      console.warn('[viewer] the project settings could not be saved', error);
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [projectUrl, anonKey, t, toast, reload]);

  const open = useCallback(async () => {
    setBusy(true);
    try {
      const link = await acceptViewerLink(pasted);
      if (!link) {
        toast.show({ message: t('viewer.link.badLink'), variant: 'error' });
        return;
      }
      setPasted('');
      toast.show({ message: t('viewer.link.saved'), variant: 'success' });
      // The group, not a bare '/'. Both `app/index.tsx` and `(viewer)/index.tsx` answer to
      // '/', and which one wins depends on how this screen was reached — landing on the
      // patient app's router entry is not a recoverable place for a viewer to end up.
      router.replace('/(viewer)');
    } catch (error) {
      // The message can never carry the pasted text, and therefore never the key.
      console.warn('[viewer] the link could not be saved', error instanceof Error ? error.name : '');
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [pasted, t, toast]);

  const forget = useCallback(async () => {
    const ok = await confirm({
      title: t('viewer.link.forgetTitle'),
      message: t('viewer.link.forgetMessage'),
      confirmLabel: t('viewer.link.forget'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    await forgetViewerLink();
    toast.show({ message: t('viewer.link.forgot'), variant: 'success' });
    reload();
  }, [confirm, t, toast, reload]);

  const data = state.data;

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('viewer.link.title')}
        subtitle={t('viewer.link.subtitle')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        <Card>
          <View style={{ gap: spacing.md }}>
            <TextField
              label={t('viewer.link.field')}
              helper={t('viewer.link.helper')}
              value={pasted}
              onChangeText={setPasted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              accessibilityLabel={t('viewer.link.field')}
            />
            <Button
              title={t('viewer.link.open')}
              onPress={() => void open()}
              size="lg"
              loading={busy}
              disabled={pasted.trim().length === 0}
              accessibilityLabel={t('viewer.link.a11yOpen')}
              fullWidth
            />
          </View>
        </Card>

        {data && !data.configured ? (
          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label">{t('viewer.server.title')}</Text>
              <Text variant="body" tone="muted">
                {t('viewer.server.body')}
              </Text>
              <TextField
                label={t('viewer.server.url')}
                value={projectUrl}
                onChangeText={setProjectUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel={t('viewer.server.url')}
              />
              <TextField
                label={t('viewer.server.key')}
                helper={t('viewer.server.keyHelper')}
                value={anonKey}
                onChangeText={setAnonKey}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                accessibilityLabel={t('viewer.server.key')}
              />
              <Button
                title={t('viewer.server.save')}
                onPress={() => void saveProject()}
                variant="secondary"
                size="lg"
                loading={busy}
                fullWidth
              />
            </View>
          </Card>
        ) : null}

        {data?.hasLink ? (
          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="body" tone="muted">
                {t('viewer.link.forgetBody')}
              </Text>
              <Button
                title={t('viewer.link.forget')}
                onPress={() => void forget()}
                variant="destructive"
                size="lg"
                accessibilityLabel={t('viewer.link.a11yForget')}
                fullWidth
              />
            </View>
          </Card>
        ) : null}

        <Banner variant="info" title={t('viewer.readOnly')} message={t('viewer.readOnlyMessage')} />
      </View>
    </Screen>
  );
}
