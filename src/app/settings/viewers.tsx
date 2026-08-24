/**
 * Sharing — one link, and the button that kills every copy of it.
 *
 * ─── THE LINK IS THE CREDENTIAL, AND THE SCREEN SAYS SO ───────────────────────
 * There is no approval step any more. Whoever holds this link can read the record, in
 * full, without asking anybody. That is what the owner asked for and it is a reasonable
 * thing to want — but it means the warning on this screen is not decoration, it is the
 * only thing standing between "share with my son" and "share in a family group of forty".
 * So it is a Banner, above the link, in plain words: anyone with this link can see your
 * readings, your medicines and your symptoms. Share it the way you would share a key to
 * your house.
 *
 * No euphemism, no "trusted contacts", no shield icon. Those all say "we have handled the
 * safety part", and here the user is the safety part.
 *
 * ─── ROTATION IS THE ONLY REVOCATION, AND IT IS ALL-OR-NOTHING ────────────────
 * `REVOKE_DISCLOSURE` is shown BEFORE the confirm, not after and not instead of it,
 * because the two things it says are the two things a person gets wrong: a new link does
 * not un-see anything, and it stops everybody at once rather than one person. A woman
 * rotating after a family argument needs to know she will have to re-send the link to her
 * daughter before she taps, not afterwards.
 *
 * ─── NOTHING IS EVER SHARED AUTOMATICALLY ─────────────────────────────────────
 * The link is shown, and SHE sends it. There is no code path in this file that opens the
 * share sheet without a press.
 *
 * ─── AN UNCONFIGURED PHONE GETS A WAY IN, NOT A DEAD END ──────────────────────
 * Two different "not set up" states, and they are not the same thing:
 *   • No Supabase project → nothing can be shared YET. This screen carries the whole
 *     setup: what sharing does, where the two values come from, two pasteable boxes, and
 *     one real request that says whether they work. It used to carry a sentence saying the
 *     phone "has not been given" a project and offer no way to give it one, which is the
 *     same thing as the feature not existing.
 *   • No link host → there is a link, it just has no web address. The pasteable code is
 *     shown instead, with a sentence saying what to do with it.
 *
 * ─── THE SETUP IS PASTE-FIRST, BECAUSE THE KEY IS A JWT ───────────────────────
 * A Supabase anon key is a couple of hundred characters of base64. Nobody types that on a
 * phone keyboard correctly, and a key that is 99% right fails in exactly the same way as
 * one that is entirely wrong. So both boxes have a Paste button, and "Test connection"
 * exists so a half-copied key is caught HERE rather than three days later, when somebody's
 * daughter says the link shows nothing.
 *
 * The test has THREE answers and never a generic failure, because "the project refused
 * this" and "nothing came back" call for opposite actions — re-copy the key, or turn the
 * mobile data on and stop re-copying a key that was fine all along.
 *
 * ─── TURNING IT OFF IS NOT REVOCATION, AND THE CONFIRM SAYS SO ────────────────
 * `disableSync()` stops this phone publishing. It does not delete what is already on the
 * server, and it cannot: rotation is the only thing that deletes, and rotation needs the
 * config that turning off puts away. So the confirm says to make a new link FIRST if the
 * goal is to stop people reading — in that order, before she taps, not after.
 */

import React, { useCallback, useState } from 'react';
import { Share, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';

import { useAsync, useT } from '@/app/_shared/lib';
import { useI18n } from '@/i18n';
import {
  Banner,
  Button,
  Card,
  Icon,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  disableSync,
  ensureShareLink,
  isShareHostConfigured,
  isSyncConfigured,
  normaliseUrl,
  publishSnapshot,
  rotateShareLink,
  setSyncConfig,
  shareableText,
  REVOKE_DISCLOSURE,
} from '@/features/sync';
import { testSyncConnection, type SyncProbeResult } from '@/features/sync/config';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * Where the free project is made. The dashboard rather than the marketing page, so that
 * the first thing on screen after the tap is the "New project" button she was told about.
 */
const SUPABASE_DASHBOARD_URL = 'https://supabase.com/dashboard';

type SharingState = {
  readonly configured: boolean;
  /**
   * What the share sheet and the clipboard get: a URL, or the pasteable code.
   *
   * The link's two halves are deliberately NOT held in state separately. The key would then
   * be sitting in a second place for no reason, and every future edit to this screen would
   * have one more chance to put it somewhere it must not go.
   */
  readonly text: string | null;
  /** False when no link host is configured, so there is no tappable web address. */
  readonly hosted: boolean;
  /**
   * Configured, but the link could not be prepared — a keystore that refused, most likely.
   *
   * Reported as data rather than allowed to throw, so the screen still renders the
   * CONFIGURED shell, which is what carries *Turn sharing off*. Throwing would leave a
   * phone that is sharing, cannot show what it is sharing, and offers nothing but a Retry
   * — a second dead end, on the screen whose entire defect was being one.
   */
  readonly linkFailed: boolean;
};

export default function SharingScreen() {
  const t = useT();
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { colors } = useTheme();

  /**
   * The disclosure, with the sync module's own copy as the floor.
   *
   * `t()` returns the dotted path when a key is missing, and the one screen where
   * `sharing.rotateDisclosure` must never appear as a raw key path is this one — somebody
   * is deciding whether to cut off her whole family. So the bundle is preferred and
   * `REVOKE_DISCLOSURE`, which the sync layer defines and `docs/SYNC-AND-BACKUP.md` quotes,
   * is what she reads if the string ever goes missing.
   */
  const bundledDisclosure = t('sharing.rotateDisclosure');
  const disclosure =
    bundledDisclosure === REVOKE_DISCLOSURE.i18nKey
      ? lang === 'hi'
        ? REVOKE_DISCLOSURE.hi
        : REVOKE_DISCLOSURE.en
      : bundledDisclosure;

  const [busy, setBusy] = useState(false);

  // ── Setup, shown only while this phone has no project ──────────────────────
  const [projectUrl, setProjectUrl] = useState('');
  const [anonKey, setAnonKey] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  /** Null until a test has been run. Cleared the moment either value is edited. */
  const [probe, setProbe] = useState<SyncProbeResult | null>(null);

  const state = useAsync<SharingState>(async () => {
    if (!(await isSyncConfigured())) {
      return { configured: false, text: null, hosted: false, linkFailed: false };
    }
    try {
      const link = await ensureShareLink();
      return {
        configured: true,
        text: shareableText(link),
        hosted: isShareHostConfigured(),
        linkFailed: false,
      };
    } catch (error) {
      // Never carries the link or any part of it — half a link is still a key.
      console.warn('[sharing] the link could not be prepared', error);
      return { configured: true, text: null, hosted: isShareHostConfigured(), linkFailed: true };
    }
  }, []);

  const { reload } = state;

  const copy = useCallback(async () => {
    const text = state.data?.text;
    if (!text) return;
    // The clipboard is one of the three places the key is allowed to exist. It is never
    // logged on the way there.
    await Clipboard.setStringAsync(text);
    toast.show({ message: t('sharing.copied'), variant: 'success' });
  }, [state.data, t, toast]);

  const send = useCallback(async () => {
    const text = state.data?.text;
    if (!text) return;
    // Opened only from this tap. Nothing in this file shares without a press.
    await Share.share({ message: text }).catch(() => undefined);
  }, [state.data]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const outcome = await publishSnapshot();
      toast.show({
        message: outcome.published ? t('sharing.refreshed') : t('sharing.refreshFailed'),
        variant: outcome.published ? 'success' : 'error',
      });
    } finally {
      setBusy(false);
    }
  }, [t, toast]);

  const rotate = useCallback(async () => {
    // The disclosure IS the message. It is not summarised, and the confirm cannot be
    // reached without it having been on screen.
    const ok = await confirm({
      title: t('sharing.rotateTitle'),
      message: disclosure,
      confirmLabel: t('sharing.rotateConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const result = await rotateShareLink();
      toast.show({
        // `error` for the partial case rather than something softer: the old link may
        // still open the old rows until this phone is online again, and that is exactly
        // the sentence somebody must not scroll past.
        message: result.oldDataRemoved ? t('sharing.rotated') : t('sharing.rotatePartial'),
        variant: result.oldDataRemoved ? 'success' : 'error',
      });
      reload();
    } catch (error) {
      console.warn('[sharing] the link could not be rotated', error);
      toast.show({ message: t('sharing.rotateFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [confirm, disclosure, t, toast, reload]);

  // ── Setting sharing up ─────────────────────────────────────────────────────

  const openSupabase = useCallback(async () => {
    try {
      await Linking.openURL(SUPABASE_DASHBOARD_URL);
    } catch {
      toast.show({ message: t('sharing.setup.openFailed'), variant: 'error' });
    }
  }, [t, toast]);

  /**
   * One paste handler for both boxes.
   *
   * What comes off the clipboard is never logged and never put into a toast. The project
   * URL would be harmless, but the same code path carries the anon key, and "log it, it is
   * only the URL" is how a value ends up in logcat on somebody's phone.
   */
  const pasteInto = useCallback(
    async (target: 'url' | 'key') => {
      try {
        const copied = (await Clipboard.getStringAsync()).trim();
        if (copied === '') {
          toast.show({ message: t('sharing.setup.pasteEmpty'), variant: 'info' });
          return;
        }
        if (target === 'url') {
          setProjectUrl(copied);
          setUrlError(null);
        } else {
          setAnonKey(copied);
          setKeyError(null);
        }
        // Whatever the last test said, it said it about different values.
        setProbe(null);
      } catch {
        toast.show({ message: t('sharing.setup.pasteFailed'), variant: 'error' });
      }
    },
    [t, toast],
  );

  /** Checked locally first, so an obviously wrong URL costs no request and no waiting. */
  const validate = useCallback((): boolean => {
    const urlOk = normaliseUrl(projectUrl) !== null;
    const keyOk = anonKey.trim().length > 0;
    setUrlError(urlOk ? null : t('sharing.setup.urlInvalid'));
    setKeyError(keyOk ? null : t('sharing.setup.keyRequired'));
    return urlOk && keyOk;
  }, [projectUrl, anonKey, t]);

  const test = useCallback(async () => {
    setProbe(null);
    if (!validate()) return;
    setTesting(true);
    try {
      setProbe(await testSyncConnection(projectUrl, anonKey));
    } catch (error) {
      // `testSyncConnection` resolves rather than throws, so getting here is a defect in
      // this app — and a defect here is still not a verdict about the two pasted values,
      // which is precisely what 'unreachable' says and 'rejected' would not.
      console.warn('[sharing] the connection test did not complete', error);
      setProbe('unreachable');
    } finally {
      setTesting(false);
    }
  }, [projectUrl, anonKey, validate]);

  /**
   * Turning it on does NOT require a successful test.
   *
   * This app is used on a metered and frequently absent connection, and somebody setting
   * the phone up in a room with no signal must still be able to finish. The test is
   * advice; the banner it leaves on screen is the warning.
   */
  const turnOn = useCallback(async () => {
    if (!validate()) return;
    setBusy(true);
    try {
      await setSyncConfig({ url: projectUrl, anonKey, enabled: true, role: 'patient' });
      setProjectUrl('');
      setAnonKey('');
      setProbe(null);
      toast.show({ message: t('sharing.setup.turnedOn'), variant: 'success' });
      reload();
    } catch (error) {
      // A malformed URL cannot reach here — `validate()` refuses it — and neither value is
      // ever interpolated into the message.
      console.warn('[sharing] the project settings could not be saved', error);
      toast.show({ message: t('sharing.setup.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [projectUrl, anonKey, validate, t, toast, reload]);

  const turnOff = useCallback(async () => {
    // The confirm carries the whole consequence, including the part that is easy to get
    // wrong: this stops the phone SENDING, it does not stop anybody READING.
    const ok = await confirm({
      title: t('sharing.turnOffConfirmTitle'),
      message: t('sharing.turnOffMessage'),
      confirmLabel: t('sharing.turnOffConfirm'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      await disableSync();
      toast.show({ message: t('sharing.turnedOff'), variant: 'success' });
      reload();
    } catch (error) {
      console.warn('[sharing] sharing could not be turned off', error);
      toast.show({ message: t('sharing.turnOffFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [confirm, t, toast, reload]);

  const data = state.data;

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('settings.viewers')}
        subtitle={t('sharing.subtitle')}
        onBack={() => router.back()}
      />

      {state.loading && !data ? <Skeleton height={200} label={t('a11y.loading')} /> : null}

      {state.error || data?.linkFailed ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          message={t('sharing.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={reload}
        />
      ) : null}

      {data && !data.configured ? (
        <View style={{ gap: spacing.md }}>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('sharing.notConfiguredTitle')}</Text>
              <Text variant="body" tone="muted">
                {t('sharing.notConfiguredBody')}
              </Text>
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('sharing.setup.whatTitle')}</Text>
              <Text variant="body">{t('sharing.setup.whatBody')}</Text>
            </View>
          </Card>

          {/*
            The same house-key warning the configured screen carries, shown BEFORE this is
            switched on rather than only after. It describes what turning it on means, and
            this is the moment somebody can still decide not to.
          */}
          <Banner
            variant="attention"
            title={t('sharing.warningTitle')}
            message={t('sharing.warningBody')}
          />

          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label">{t('sharing.setup.stepsTitle')}</Text>
              <Text variant="body">{t('sharing.setup.stepsCost')}</Text>
              <Text variant="body">{t('sharing.setup.step1')}</Text>
              <Text variant="body">{t('sharing.setup.step2')}</Text>
              <Text variant="body">{t('sharing.setup.step3')}</Text>
              {/*
                Step 4 is the one that is tempting to leave out and must not be. Without the
                schema the link mints, the screen shows it, and everybody who opens it sees
                an empty page — a setup that looks finished and is not.
              */}
              <Text variant="body">{t('sharing.setup.step4')}</Text>
              <Button
                title={t('sharing.setup.open')}
                onPress={() => void openSupabase()}
                variant="secondary"
                size="lg"
                accessibilityLabel={t('sharing.setup.a11yOpen')}
                fullWidth
              />
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.lg }}>
              <TextField
                label={t('sharing.setup.urlLabel')}
                helper={t('sharing.setup.urlHelper')}
                value={projectUrl}
                onChangeText={(next) => {
                  setProjectUrl(next);
                  setUrlError(null);
                  setProbe(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                keyboardType="url"
                error={urlError ?? undefined}
                accessibilityLabel={t('sharing.setup.urlLabel')}
              />
              <Button
                title={t('sharing.setup.pasteUrl')}
                onPress={() => void pasteInto('url')}
                variant="secondary"
                size="lg"
                accessibilityLabel={t('sharing.setup.pasteUrl')}
                fullWidth
              />

              <TextField
                label={t('sharing.setup.keyLabel')}
                helper={t('sharing.setup.keyHelper')}
                value={anonKey}
                onChangeText={(next) => {
                  setAnonKey(next);
                  setKeyError(null);
                  setProbe(null);
                }}
                // Shown rather than dotted out. The anon key is a public value by
                // Supabase's own design, and the failure worth catching here is half a key
                // pasted — which a field of dots cannot be proof-read for.
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                multiline
                error={keyError ?? undefined}
                accessibilityLabel={t('sharing.setup.keyLabel')}
              />
              <Button
                title={t('sharing.setup.pasteKey')}
                onPress={() => void pasteInto('key')}
                variant="secondary"
                size="lg"
                accessibilityLabel={t('sharing.setup.pasteKey')}
                fullWidth
              />

              <Button
                title={t('sharing.setup.test')}
                onPress={() => void test()}
                variant="secondary"
                size="lg"
                loading={testing}
                accessibilityLabel={t('sharing.setup.a11yTest')}
                fullWidth
              />

              {/*
                Three answers, never a fourth "something went wrong". Which one is on screen
                decides whether she goes back and re-copies a key or turns her mobile data
                on, and those are opposite actions. The working case is an icon AND a
                sentence, never colour alone.
              */}
              {probe === 'working' ? (
                <View
                  accessible
                  accessibilityLabel={`${t('sharing.setup.workingTitle')}. ${t('sharing.setup.workingBody')}`}
                  style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
                >
                  <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
                  <View style={{ flex: 1, gap: spacing.sm }}>
                    <Text variant="label">{t('sharing.setup.workingTitle')}</Text>
                    <Text variant="body" tone="muted">
                      {t('sharing.setup.workingBody')}
                    </Text>
                  </View>
                </View>
              ) : probe === 'rejected' ? (
                <Banner
                  variant="attention"
                  title={t('sharing.setup.rejectedTitle')}
                  message={t('sharing.setup.rejectedBody')}
                />
              ) : probe === 'unreachable' ? (
                <Banner
                  variant="info"
                  title={t('sharing.setup.unreachableTitle')}
                  message={t('sharing.setup.unreachableBody')}
                />
              ) : null}

              <Button
                title={t('sharing.setup.turnOn')}
                onPress={() => void turnOn()}
                size="lg"
                loading={busy}
                accessibilityLabel={t('sharing.setup.a11yTurnOn')}
                fullWidth
              />
            </View>
          </Card>

          <Banner
            variant="info"
            title={t('sharing.setup.familyTitle')}
            message={t('sharing.setup.familyBody')}
          />
        </View>
      ) : null}

      {data?.configured ? (
        <View style={{ gap: spacing.md }}>
          {/*
            Everything that needs a link lives inside this guard. TURNING SHARING OFF does
            not: a phone that is configured but could not mint its link is still publishing,
            and the one control that stops it has to stay reachable.
          */}
          {data.text ? (
            <>
              <Banner
                variant="attention"
                title={t('sharing.warningTitle')}
                message={t('sharing.warningBody')}
              />

              <Card>
                <View style={{ gap: spacing.md }}>
                  <Text variant="label">{t('sharing.linkLabel')}</Text>
                  <Text
                    variant="body"
                    selectable
                    accessibilityLabel={t('sharing.a11yLink')}
                    style={{ paddingVertical: spacing.xs }}
                  >
                    {data.text}
                  </Text>

                  {data.hosted ? null : (
                    <Text variant="caption" tone="muted">
                      {t('sharing.noHostBody')}
                    </Text>
                  )}

                  <View style={{ flexDirection: 'row', gap: spacing.md }}>
                    <Button
                      title={t('sharing.share')}
                      onPress={() => void send()}
                      size="lg"
                      accessibilityLabel={t('sharing.a11ySend')}
                      style={{ flex: 1 }}
                    />
                    <Button
                      title={t('sharing.copy')}
                      onPress={() => void copy()}
                      variant="secondary"
                      size="lg"
                      accessibilityLabel={t('sharing.a11yCopy')}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              </Card>

              <Card>
                <View style={{ gap: spacing.md }}>
                  <Text variant="label">{t('sharing.refreshTitle')}</Text>
                  <Text variant="body" tone="muted">
                    {t('sharing.refreshBody')}
                  </Text>
                  <Button
                    title={t('sharing.refresh')}
                    onPress={() => void refresh()}
                    variant="secondary"
                    size="lg"
                    loading={busy}
                    fullWidth
                  />
                </View>
              </Card>

              <Card>
                <View style={{ gap: spacing.md }}>
                  <Text variant="label">{t('sharing.rotateTitle')}</Text>
                  {/*
                    The disclosure is on the screen as well as in the confirm. Somebody
                    deciding whether to tap should be able to read it without tapping.
                  */}
                  <Text variant="body" tone="muted">
                    {disclosure}
                  </Text>
                  <Button
                    title={t('sharing.rotate')}
                    onPress={() => void rotate()}
                    variant="destructive"
                    size="lg"
                    loading={busy}
                    accessibilityLabel={t('sharing.a11yRotate')}
                    fullWidth
                  />
                </View>
              </Card>
            </>
          ) : null}

          {/*
            LAST, and below rotation on purpose. Turning off is the weaker of the two
            actions — it stops this phone talking, it does not stop anybody reading — so
            somebody who wants people to stop reading should meet "Make a new link" first.
          */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label">{t('sharing.turnOffTitle')}</Text>
              <Text variant="body" tone="muted">
                {t('sharing.turnOffBody')}
              </Text>
              <Button
                title={t('sharing.turnOff')}
                onPress={() => void turnOff()}
                variant="destructive"
                size="lg"
                loading={busy}
                accessibilityLabel={t('sharing.a11yTurnOff')}
                fullWidth
              />
            </View>
          </Card>
        </View>
      ) : null}
    </Screen>
  );
}
