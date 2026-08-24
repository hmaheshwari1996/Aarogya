/**
 * Prescription scanning — the AI key.
 *
 * ─── THIS SCREEN USED TO BE HIDDEN. IT IS NOT ANY MORE ────────────────────────
 * It was once reachable only by tapping the version number on About seven times. That
 * cost more than it bought: the person who sets this phone up is usually not the person
 * who uses it, is usually doing it once, and has no way to discover a gesture nobody told
 * him about — so a key pasted during first-run setup could never be corrected, replaced
 * after it was revoked, or removed. Settings now carries a plainly-labelled row, and the
 * first-run wizard has a step of its own (`/setup/ai-key`).
 *
 * Nothing about the page is dangerous to land on by accident: it changes one optional
 * feature, it explains in words what turning that feature off does and does not stop, and
 * every destructive action is behind a confirmation that names the consequence.
 *
 * ─── THE KEY LIVES IN SecureStore, NEVER IN app_meta ──────────────────────────
 * `app_meta` is a table inside the database file, and the database file is exactly what
 * the backup capsule exports and shares. A key stored there would travel to whoever the
 * backup travels to. `@/features/ai/keyStore` writes to expo-secure-store, which the
 * capsule does not touch.
 *
 * The key is never rendered. Only whether one exists, and its last four characters —
 * enough to tell two keys apart, not enough to use one.
 *
 * ─── VERIFY BEFORE RELYING, AND NEVER OVERWRITE A GOOD KEY WITH A BAD ONE ─────
 * `testKey()` makes one real, cheap call and writes nothing. Checking is therefore always
 * safe to do before saving, and a mistyped replacement cannot silently displace a key
 * that was working a minute ago.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';

import { useAsync, useT, type LocalStrings } from '@/app/_shared/lib';
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
import { clearApiKey, getApiKey, setApiKey, testKey } from '@/features/ai/keyStore';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

/** The page that issues the key. Opened by a button so nobody has to retype it. */
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';

const STRINGS: LocalStrings = {
  'ai.title': { en: 'Prescription scanning', hi: 'नुस्खा पढ़ना' },
  'ai.subtitle': {
    en: 'Reading a photograph of a prescription so the medicine list fills itself in. Everything else in Aarogya works without this.',
    hi: 'नुस्खे की तस्वीर पढ़कर दवाइयों की सूची अपने आप भर जाती है। आरोग्य में बाकी सब कुछ इसके बिना भी चलता है।',
  },
  'ai.keySet': { en: 'A key is saved. It ends in {{last4}}.', hi: 'एक की सहेजी हुई है। उसके आख़िरी अक्षर {{last4}} हैं।' },
  'ai.keySetDetail': {
    en: 'Prescription photographs can be read. You can check it, replace it or remove it below.',
    hi: 'नुस्खे की तस्वीरें पढ़ी जा सकती हैं। आप इसे नीचे जाँच सकती हैं, बदल सकती हैं या हटा सकती हैं।',
  },
  'ai.keyNotSet': {
    en: 'No key is saved',
    hi: 'कोई की सहेजी नहीं है',
  },
  'ai.keyNotSetDetail': {
    en: 'Prescription photographs are not read and are not sent anywhere. Medicines can be added by hand as usual.',
    hi: 'नुस्खे की तस्वीरें न पढ़ी जाती हैं, न कहीं भेजी जाती हैं। दवाइयाँ हमेशा की तरह हाथ से जोड़ी जा सकती हैं।',
  },
  'ai.getTitle': { en: 'Getting a key', hi: 'की कैसे लें' },
  'ai.getBody': {
    en: 'The key is free. Open Google AI Studio, sign in with a Google account, tap “Create API key”, copy it, and paste it below.',
    hi: 'की मुफ़्त है। गूगल AI स्टूडियो खोलें, किसी गूगल खाते से साइन इन करें, “Create API key” दबाएँ, उसे कॉपी करें और नीचे चिपकाएँ।',
  },
  'ai.open': { en: 'Open Google AI Studio', hi: 'गूगल AI स्टूडियो खोलें' },
  'ai.openFailed': {
    en: 'No browser on this phone could open that page. You can get the key on another phone or a computer and type it in here.',
    hi: 'इस फ़ोन का कोई ब्राउज़र वह पन्ना नहीं खोल सका। आप की किसी और फ़ोन या कंप्यूटर पर लेकर यहाँ लिख सकते हैं।',
  },
  'ai.keyLabel': { en: 'Paste the key here', hi: 'की यहाँ चिपकाएँ' },
  'ai.keyHelper': {
    en: 'A long line of letters and numbers. Saving replaces whatever is saved now.',
    hi: 'अक्षरों और अंकों की एक लंबी लाइन। सहेजने पर अभी सहेजी हुई की बदल जाएगी।',
  },
  'ai.paste': { en: 'Paste from clipboard', hi: 'क्लिपबोर्ड से चिपकाएँ' },
  'ai.pasteEmpty': {
    en: 'There is nothing copied to paste.',
    hi: 'चिपकाने के लिए कुछ कॉपी नहीं किया गया है।',
  },
  'ai.pasteFailed': {
    en: 'The clipboard could not be read on this phone. The key can be typed in instead.',
    hi: 'इस फ़ोन पर क्लिपबोर्ड नहीं पढ़ा जा सका। की हाथ से भी लिखी जा सकती है।',
  },
  'ai.check': { en: 'Check this key', hi: 'इस की को जाँचें' },
  'ai.checkSaved': { en: 'Check the saved key', hi: 'सहेजी हुई की जाँचें' },
  'ai.checkNeedsKey': {
    en: 'Paste a key first, then it can be checked.',
    hi: 'पहले कोई की चिपकाएँ, फिर उसे जाँचा जा सकता है।',
  },
  'ai.replace': { en: 'Replace the key', hi: 'की बदलें' },
  'ai.resultWorking': { en: 'This key works', hi: 'यह की चल रही है' },
  'ai.resultWorkingDetail': {
    en: 'A photograph of a prescription can be read.',
    hi: 'नुस्खे की तस्वीर पढ़ी जा सकती है।',
  },
  'ai.resultRejected': { en: 'Google did not accept this key', hi: 'गूगल ने यह की नहीं मानी' },
  'ai.resultRejectedDetail': {
    en: 'Usually only part of the key was copied. Copy the whole line again, or make a new key in Google AI Studio.',
    hi: 'अक्सर की का सिर्फ़ कुछ हिस्सा ही कॉपी हुआ होता है। पूरी लाइन दोबारा कॉपी करें, या गूगल AI स्टूडियो में नई की बनाएँ।',
  },
  'ai.resultCannotUse': {
    en: 'This key cannot be used as it is',
    hi: 'यह की जैसी है, वैसी इस्तेमाल नहीं हो सकती',
  },
  'ai.resultCannotUseDetail': {
    en: 'Google accepted the key itself and then refused the request — the key is locked to one app or website, or the reading service is switched off for its project, or its allowance is zero. Copying the key again cannot change any of those. They are fixed in Google Cloud Console.',
    hi: 'गूगल ने की तो मानी, पर अनुरोध ठुकरा दिया — या तो की किसी एक ऐप या वेबसाइट के लिए सीमित है, या उसके प्रोजेक्ट में पढ़ने वाली सेवा चालू नहीं है, या उसका हिस्सा शून्य है। की दोबारा कॉपी करने से इनमें से कुछ नहीं बदलेगा। ये गूगल क्लाउड कंसोल में ठीक होते हैं।',
  },
  'ai.resultNoInternet': {
    en: 'Aarogya could not reach the internet',
    hi: 'आरोग्य इंटरनेट तक नहीं पहुँच सका',
  },
  'ai.resultNoInternetDetail': {
    en: 'The key has not been checked — nothing is wrong with it yet. Turn on mobile data or Wi-Fi and check again.',
    hi: 'की जाँची नहीं जा सकी — अभी तक उसमें कोई गड़बड़ी नहीं मिली है। मोबाइल डेटा या वाई-फ़ाई चालू करके फिर से जाँचें।',
  },
  'ai.resultNoAnswer': { en: 'Google could not answer just now', hi: 'गूगल अभी जवाब नहीं दे सका' },
  'ai.resultNoAnswerDetail': {
    en: 'The key was neither accepted nor refused. Try checking again in a few minutes.',
    hi: 'की न मानी गई, न मना की गई। कुछ मिनट बाद फिर से जाँचें।',
  },
  'ai.remove': { en: 'Remove the key', hi: 'की हटाएँ' },
  'ai.removeTitle': { en: 'Remove the key?', hi: 'की हटाएँ?' },
  'ai.removeMessage': {
    en: 'Only one thing stops: a photograph of a prescription will no longer be read for you, and medicines will have to be added by hand. Nothing else changes — your medicines, reminders, readings, symptoms, reports and everything already recorded stay exactly as they are.',
    hi: 'सिर्फ़ एक चीज़ रुकेगी: नुस्खे की तस्वीर अब आपके लिए नहीं पढ़ी जाएगी, और दवाइयाँ हाथ से जोड़नी होंगी। बाकी कुछ नहीं बदलता — आपकी दवाइयाँ, याद-दिलावट, माप, तकलीफ़ें, रिपोर्ट और पहले से दर्ज सब कुछ जैसा है वैसा ही रहेगा।',
  },
  'ai.removed': { en: 'The key has been removed.', hi: 'की हटा दी गई है।' },
  'ai.needKey': { en: 'Please paste a key first.', hi: 'पहले कोई की चिपकाएँ।' },
  'ai.saveFailed': { en: 'The key could not be saved.', hi: 'की सहेजी नहीं जा सकी।' },
  'ai.whatLeavesTitle': { en: 'What leaves this phone', hi: 'इस फोन से क्या बाहर जाता है' },
  'ai.whatLeavesBody': {
    en: 'Only the photograph of the prescription, and only when someone asks for it to be read. Readings, medicines, symptoms, reports and this key never leave the phone. Nothing is ever sent in the background.',
    hi: 'सिर्फ़ नुस्खे की तस्वीर, और वह भी तभी जब कोई उसे पढ़वाने को कहे। माप, दवाइयाँ, तकलीफ़ें, रिपोर्ट और यह की — इनमें से कुछ भी फोन से बाहर नहीं जाता। पीछे-पीछे अपने आप कभी कुछ नहीं भेजा जाता।',
  },
  'ai.storedSafely': {
    en: 'The key is held in the phone’s own secure store, not in the health record file — so a backup shared with family never carries it.',
    hi: 'की फोन के अपने सुरक्षित हिस्से में रखी जाती है, सेहत के रिकॉर्ड वाली फ़ाइल में नहीं — इसलिए परिवार को दिया गया बैकअप इसे कभी साथ नहीं ले जाता।',
  },
};

/**
 * What the check found. Five values, because there are five genuinely different things
 * that can be true — and "something went wrong" is none of them. Kept deliberately in
 * step with `/setup/ai-key`, which shows the same five answers in the same words.
 */
type CheckOutcome = 'working' | 'rejected' | 'cannotBeUsed' | 'noInternet' | 'noAnswer';

/**
 * `cannotBeUsed` is separate from `rejected` because their remedies are opposites.
 *
 * `rejected` says "usually only part of the key was copied — copy the whole line again",
 * which is right when the characters are wrong. For a key that carries an app restriction,
 * a project with the API switched off, or an allowance of zero, the characters are
 * PERFECT: copying them again is the one action that provably cannot work, and it is the
 * action this screen would otherwise recommend, in bold, next to a tick-shaped promise
 * that trying again is worth doing. Every one of those three is fixed in a browser, on a
 * different device, by whoever owns the Google project.
 */
function outcomeFor(code: string): Exclude<CheckOutcome, 'working'> {
  if (code === 'key_restricted' || code === 'api_not_enabled' || code === 'quota_zero') {
    return 'cannotBeUsed';
  }
  if (code === 'invalid_key' || code === 'no_key') return 'rejected';
  if (code === 'offline' || code === 'timeout') return 'noInternet';
  return 'noAnswer';
}

export default function AiSettingsScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const { colors } = useTheme();

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);

  const state = useAsync(async () => {
    const key = await getApiKey();
    // Only the tail is kept in memory. The full key is read, measured and dropped.
    return key ? { last4: key.slice(-4) } : null;
  }, []);

  const { reload } = state;
  const hasSavedKey = state.data !== null;

  const openStudio = useCallback(async () => {
    try {
      await Linking.openURL(AI_STUDIO_URL);
    } catch {
      toast.show({ message: t('ai.openFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const copied = (await Clipboard.getStringAsync()).trim();
      if (copied === '') {
        toast.show({ message: t('ai.pasteEmpty'), variant: 'info' });
        return;
      }
      setDraft(copied);
      setError(null);
      // A pasted key has not been checked, whatever the last check said about the old one.
      setOutcome(null);
    } catch {
      toast.show({ message: t('ai.pasteFailed'), variant: 'error' });
    }
  }, [t, toast]);

  /**
   * Checks the pasted key if there is one, otherwise the key already saved.
   *
   * Writes nothing either way — which is what makes it safe to check a replacement before
   * committing to it.
   */
  const check = useCallback(async () => {
    const value = draft.trim();
    if (value === '' && !hasSavedKey) {
      toast.show({ message: t('ai.checkNeedsKey'), variant: 'info' });
      return;
    }
    setChecking(true);
    setOutcome(null);
    try {
      const result = await testKey(value === '' ? undefined : value);
      setOutcome(result.ok ? 'working' : outcomeFor(result.error.code));
    } catch (e) {
      // testKey resolves rather than throws, so this is a defect rather than a refusal.
      // It is still not a verdict about the key.
      console.warn('[ai] the key check did not complete', e);
      setOutcome('noAnswer');
    } finally {
      setChecking(false);
    }
  }, [draft, hasSavedKey, t, toast]);

  const save = useCallback(async () => {
    const value = draft.trim();
    if (!value) {
      setError(t('ai.needKey'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setApiKey(value);
      setDraft('');
      setOutcome(null);
      toast.show({ message: t('common.saved'), variant: 'success' });
      reload();
    } catch (e) {
      console.warn('[ai] could not save the key', e);
      toast.show({ message: t('ai.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [draft, t, toast, reload]);

  const remove = useCallback(async () => {
    const ok = await confirm({
      title: t('ai.removeTitle'),
      message: t('ai.removeMessage'),
      confirmLabel: t('common.remove'),
      destructive: true,
    });
    if (!ok) return;
    await clearApiKey();
    setOutcome(null);
    toast.show({ message: t('ai.removed'), variant: 'success' });
    reload();
  }, [confirm, t, toast, reload]);

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('ai.title')} subtitle={t('ai.subtitle')} onBack={() => router.back()} />

      <View style={{ gap: spacing.md }}>
        <Card>
          {state.loading && !state.data ? (
            <Skeleton height={28} label={t('a11y.loading')} />
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">
                {state.data ? t('ai.keySet', { last4: state.data.last4 }) : t('ai.keyNotSet')}
              </Text>
              <Text variant="body" tone="muted">
                {state.data ? t('ai.keySetDetail') : t('ai.keyNotSetDetail')}
              </Text>
            </View>
          )}
        </Card>

        <Card>
          <View style={{ gap: spacing.md }}>
            <Text variant="label">{t('ai.getTitle')}</Text>
            <Text variant="body">{t('ai.getBody')}</Text>
            <Button
              title={t('ai.open')}
              onPress={() => void openStudio()}
              variant="secondary"
              size="lg"
              fullWidth
            />
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.lg }}>
            <TextField
              label={t('ai.keyLabel')}
              helper={t('ai.keyHelper')}
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                setError(null);
                setOutcome(null);
              }}
              // Shown rather than dotted out, on purpose: the one failure this screen has
              // to catch is half a key pasted, and a field of dots cannot be proof-read.
              // Never autocorrected, and never offered to the keyboard's suggestion store.
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              multiline
              error={error ?? undefined}
            />
            <Button
              title={t('ai.paste')}
              onPress={() => void pasteFromClipboard()}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={draft.trim() === '' && hasSavedKey ? t('ai.checkSaved') : t('ai.check')}
              onPress={() => void check()}
              variant="secondary"
              size="lg"
              fullWidth
              loading={checking}
            />

            {outcome === 'working' ? (
              <View
                accessible
                accessibilityLabel={`${t('ai.resultWorking')}. ${t('ai.resultWorkingDetail')}`}
                style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
              >
                <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <Text variant="label">{t('ai.resultWorking')}</Text>
                  <Text variant="body" tone="muted">
                    {t('ai.resultWorkingDetail')}
                  </Text>
                </View>
              </View>
            ) : outcome === 'rejected' ? (
              <Banner
                variant="attention"
                title={t('ai.resultRejected')}
                message={t('ai.resultRejectedDetail')}
              />
            ) : outcome === 'cannotBeUsed' ? (
              <Banner
                variant="attention"
                title={t('ai.resultCannotUse')}
                message={t('ai.resultCannotUseDetail')}
              />
            ) : outcome === 'noInternet' ? (
              <Banner
                variant="attention"
                title={t('ai.resultNoInternet')}
                message={t('ai.resultNoInternetDetail')}
              />
            ) : outcome === 'noAnswer' ? (
              <Banner
                variant="info"
                title={t('ai.resultNoAnswer')}
                message={t('ai.resultNoAnswerDetail')}
              />
            ) : null}

            <Button
              title={hasSavedKey ? t('ai.replace') : t('common.save')}
              onPress={() => void save()}
              loading={saving}
              size="lg"
              fullWidth
            />
            {hasSavedKey ? (
              <Button
                title={t('ai.remove')}
                onPress={() => void remove()}
                variant="destructive"
                size="lg"
                fullWidth
              />
            ) : null}
          </View>
        </Card>

        <Banner
          variant="info"
          title={t('ai.whatLeavesTitle')}
          message={t('ai.whatLeavesBody')}
        />

        <Text variant="caption" tone="muted">
          {t('ai.storedSafely')}
        </Text>
      </View>
    </Screen>
  );
}
