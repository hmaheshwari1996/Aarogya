/**
 * "Someone invited me" — the invitee's side of joining a shared patient.
 *
 * ─── PASTE THE INVITE, ASK TO JOIN, WAIT TO BE APPROVED BY NAME ───────────────
 * This is not the old viewer link, where whoever held the link could read the record
 * immediately. Here the invite only lets this phone ASK. Nothing is visible until the
 * owner approves THIS phone by name on their side (design §4.2). So the success state on
 * this screen is deliberately "request sent, wait" — never "you're in".
 *
 * ─── THE INVITE CARRIES THE RELAY, SO THERE IS NO URL/KEY TO PASTE ────────────
 * Unlike `(viewer)/link.tsx`, the invite embeds the relay address and public key it was
 * minted with (contract §4.2.1), so `postJoinRequest` configures this phone from the
 * invite itself. One box, not three. It carries NO profile key — that is wrapped to this
 * phone only after the owner approves.
 *
 * ─── COPY THE WHOLE THING; THE KEY IS NEVER LOGGED ────────────────────────────
 * Same two rules the old accept screen lives by: half an invite looks correct and does
 * nothing, so the failure copy says "check you copied the whole invite"; and the pasted
 * text goes straight into `postJoinRequest` — nothing here interpolates it into a log,
 * a toast, or an error.
 *
 * ─── HOW THIS SCREEN IS REACHED (a gap this round — see the reverse-contract note) ──
 * An invite opened as a link should deep-link here with `?code=`; and the patients list
 * should carry a "Join a Shared Patient" entry to reach it by hand. Both live in files
 * this UI task does not own (`app/index.tsx` routing, `app/profiles/index.tsx`); they are
 * reported, not wired here. This screen already accepts the `code` param for when they are.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { useT, type LocalStrings } from '@/app/_shared/lib';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Banner, Button, Card, Icon, Screen, ScreenHeader, Text, TextField, useToast } from '@/components/ui';

// Reverse contract — the invitee half of `@/features/sync/membership` (contract §4.2.2).
// `postJoinRequest` parses the invite, configures the relay from it if needed, ensures this
// phone's device keypair, and POSTs the join request sealed to the owner. Its three-way
// result mirrors `testSyncConnection`'s honesty, because "the invite is wrong" and "we could
// not reach the relay" call for opposite actions — re-paste, versus try again when online.
import { postJoinRequest, type JoinRequestOutcome } from '@/features/sync/membership';

const STRINGS: LocalStrings = {
  'join.title': { en: 'Join A Shared Patient', hi: 'साझा मरीज़ से जुड़ें' },
  'join.subtitle': { en: 'Paste the invite a family member sent you', hi: 'परिजन द्वारा भेजा गया न्योता पेस्ट करें' },
  'join.field': { en: 'Invite', hi: 'न्योता' },
  'join.helper': {
    en: 'Copy the whole invite, including everything after the # sign.',
    hi: 'पूरा न्योता कॉपी करें, # चिह्न के बाद का हिस्सा भी।',
  },
  'join.paste': { en: 'Paste Invite', hi: 'न्योता पेस्ट करें' },
  'join.pasteEmpty': { en: 'The clipboard is empty.', hi: 'क्लिपबोर्ड खाली है।' },
  'join.pasteFailed': { en: 'Could not read the clipboard.', hi: 'क्लिपबोर्ड नहीं पढ़ा जा सका।' },
  'join.ask': { en: 'Ask To Join', hi: 'जुड़ने के लिए कहें' },

  'join.sentTitle': { en: 'Request Sent', hi: 'अनुरोध भेजा गया' },
  'join.sentBody': {
    en: 'Ask the owner to approve this phone. Once they do, the patient will appear in your list here. You do not need to keep this screen open.',
    hi: 'प्रभारी से इस फ़ोन को स्वीकृत करने को कहें। जैसे ही वे करेंगे, मरीज़ आपकी सूची में यहाँ दिख जाएगा। इस स्क्रीन को खुला रखना ज़रूरी नहीं।',
  },
  'join.sentReminder': {
    en: 'You will get a notification for reminders. Only the owner’s phone rings the alarm.',
    hi: 'आपको याद-दिलावट की सूचना मिलेगी। अलार्म केवल प्रभारी के फ़ोन पर बजता है।',
  },
  'join.done': { en: 'Done', hi: 'हो गया' },

  'join.invalidTitle': { en: 'That Invite Did Not Work', hi: 'यह न्योता काम नहीं आया' },
  'join.invalidBody': {
    en: 'Check you copied the whole invite — including the part after the # sign — and paste it again.',
    hi: 'देखें कि आपने पूरा न्योता कॉपी किया है — # चिह्न के बाद का हिस्सा भी — और फिर से पेस्ट करें।',
  },
  'join.unreachableTitle': { en: 'Could Not Reach Sharing', hi: 'साझा तक नहीं पहुँच सके' },
  'join.unreachableBody': {
    en: 'Your phone may be offline. Turn on mobile data or Wi-Fi and try again. The invite may be fine.',
    hi: 'आपका फ़ोन ऑफ़लाइन हो सकता है। मोबाइल डेटा या वाई-फ़ाई चालू करके फिर कोशिश करें। न्योता ठीक हो सकता है।',
  },
};

export default function JoinSharedScreen() {
  const params = useLocalSearchParams<{ code?: string }>();
  const t = useT(STRINGS);
  const toast = useToast();
  const { colors } = useTheme();

  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<JoinRequestOutcome | null>(null);

  // Seed from a deep-linked invite once, during render — the field must carry it on the
  // first painted frame, and a re-render must not clobber what the user has since edited.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && typeof params.code === 'string' && params.code.length > 0) {
    setSeeded(true);
    setPasted(params.code);
  }

  const paste = useCallback(async () => {
    try {
      const copied = (await Clipboard.getStringAsync()).trim();
      if (copied === '') {
        toast.show({ message: t('join.pasteEmpty'), variant: 'info' });
        return;
      }
      setPasted(copied);
      setOutcome(null);
    } catch {
      toast.show({ message: t('join.pasteFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const ask = useCallback(async () => {
    const code = pasted.trim();
    if (code.length === 0) return;
    setBusy(true);
    setOutcome(null);
    try {
      // Never carries the pasted text into any message — half an invite is still a secret.
      setOutcome(await postJoinRequest(code));
    } catch (error) {
      console.warn('[join] the request could not be sent', error instanceof Error ? error.name : '');
      // A throw here is a defect in this app, not a verdict on the invite — "unreachable" is
      // the honest read (nothing was decided about the code), same as the setup probe.
      setOutcome('unreachable');
    } finally {
      setBusy(false);
    }
  }, [pasted]);

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('join.title')} subtitle={t('join.subtitle')} onBack={() => router.back()} />

      {outcome === 'sent' ? (
        <View style={{ gap: spacing.md }}>
          <Card>
            <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
              <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
              <View style={{ flex: 1, gap: spacing.sm }}>
                <Text variant="label">{t('join.sentTitle')}</Text>
                <Text variant="body" tone="muted">
                  {t('join.sentBody')}
                </Text>
              </View>
            </View>
          </Card>
          <Banner variant="info" title={t('join.sentReminder')} />
          <Button title={t('join.done')} onPress={() => router.back()} size="lg" fullWidth />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Card>
            <View style={{ gap: spacing.md }}>
              <TextField
                label={t('join.field')}
                helper={t('join.helper')}
                value={pasted}
                onChangeText={(next) => {
                  setPasted(next);
                  setOutcome(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                multiline
                accessibilityLabel={t('join.field')}
              />
              <Button
                title={t('join.paste')}
                onPress={() => void paste()}
                variant="secondary"
                size="lg"
                fullWidth
              />
              <Button
                title={t('join.ask')}
                onPress={() => void ask()}
                size="lg"
                loading={busy}
                disabled={pasted.trim().length === 0}
                fullWidth
              />
            </View>
          </Card>

          {outcome === 'invalid' ? (
            <Banner variant="attention" title={t('join.invalidTitle')} message={t('join.invalidBody')} />
          ) : outcome === 'unreachable' ? (
            <Banner variant="info" title={t('join.unreachableTitle')} message={t('join.unreachableBody')} />
          ) : null}
        </View>
      )}
    </Screen>
  );
}
