/**
 * Setup step 6 — the key that lets a photograph of a prescription fill itself in.
 *
 * ─── THIS STEP IS A GIFT, NOT A GATE ──────────────────────────────────────────
 * Nothing downstream requires a key. Medicines can always be typed in by hand, and every
 * other part of Aarogya — doses, readings, symptoms, reports, reminders — never touches
 * it. A first-run screen that a non-technical user cannot get past is where an app gets
 * uninstalled, so:
 *
 *   • Continue is NEVER conditional on a key being present, valid, or checked.
 *   • Skip is the same size and the same width as Continue, and says in words that the
 *     key can be added later from Settings.
 *   • Nothing on this screen is marked required, and no field shows an error for being
 *     empty.
 *
 * ─── WHY THE STEPS ARE SPELLED OUT AND THE LINK IS A BUTTON ───────────────────
 * The person setting this phone up is often not the person who will use it, and is often
 * doing it once, standing up, on a borrowed handset. "Get an API key from Google AI
 * Studio" is an instruction only somebody who has already done it can follow. So the
 * screen numbers the five taps, opens the page itself rather than printing a URL to
 * retype, and offers a clipboard button — a Google key is 39 characters of mixed-case
 * letters, digits, hyphens and underscores, and typing one on a phone keyboard is how a
 * working key becomes a rejected one.
 *
 * ─── THE CHECK ANSWERS ONE OF THREE QUESTIONS, NEVER "SOMETHING WENT WRONG" ───
 * `testKey()` makes one real, cheap call. Its three answers — this works / Google refused
 * this / we could not reach the internet — are three completely different next actions
 * (carry on, re-copy the key, turn on data). A fourth, honest, outcome exists for the
 * case where Google answered but could not say either way (busy, out of daily allowance):
 * claiming the key is good or bad there would be a guess.
 *
 * The key is written to the phone's own secure store by `setApiKey`, never to `app_meta`
 * — `app_meta` lives inside the database file, which is exactly what the backup capsule
 * exports and shares.
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Card,
  Icon,
  Screen,
  ScreenHeader,
  Text,
  TextField,
  useToast,
} from '@/components/ui';
import { WizardFooter } from './_layout';
import { setApiKey, testKey } from '@/features/ai/keyStore';
import { useT, type LocalStrings } from '@/app/_shared/lib';

const SETUP_STEPS = 7;

/** The page that issues the key. Opened by a button so nobody has to retype it. */
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.aiKey.title': {
    en: 'Let a prescription fill itself in',
    hi: 'नुस्खे को खुद भर जाने दें',
  },
  'setup.aiKey.why': {
    en: 'Aarogya can read a photograph of your prescription and put the medicines and their times into the app for you, instead of you typing eight medicines and fourteen dose times by hand. To do that it needs a key from Google.',
    hi: 'आरोग्य आपके नुस्खे की तस्वीर पढ़कर दवाइयाँ और उनके समय खुद ऐप में डाल सकता है — आपको आठ दवाइयाँ और चौदह समय हाथ से टाइप नहीं करने पड़ेंगे। इसके लिए उसे गूगल की एक “की” चाहिए।',
  },
  'setup.aiKey.free': {
    en: 'The key is free, and it is kept only on this phone.',
    hi: 'यह की मुफ़्त है, और सिर्फ़ इसी फ़ोन में रखी जाती है।',
  },
  'setup.aiKey.howTitle': { en: 'How to get one, on this phone', hi: 'इसी फ़ोन पर की कैसे लें' },
  'setup.aiKey.step1': {
    en: 'Tap the button below. It opens Google AI Studio in your browser.',
    hi: 'नीचे वाला बटन दबाएँ। इससे ब्राउज़र में गूगल AI स्टूडियो खुल जाएगा।',
  },
  'setup.aiKey.step2': {
    en: 'Sign in with a Google account.',
    hi: 'किसी गूगल खाते से साइन इन करें।',
  },
  'setup.aiKey.step3': {
    en: 'Tap “Create API key”.',
    hi: '“Create API key” दबाएँ।',
  },
  'setup.aiKey.step4': { en: 'Copy the key.', hi: 'की को कॉपी करें।' },
  'setup.aiKey.step5': {
    en: 'Come back here and paste it below.',
    hi: 'यहाँ वापस आकर उसे नीचे चिपकाएँ।',
  },
  'setup.aiKey.open': { en: 'Open Google AI Studio', hi: 'गूगल AI स्टूडियो खोलें' },
  'setup.aiKey.openFailed': {
    en: 'No browser on this phone could open that page. You can get the key on another phone or a computer and type it in here.',
    hi: 'इस फ़ोन का कोई ब्राउज़र वह पन्ना नहीं खोल सका। आप की किसी और फ़ोन या कंप्यूटर पर लेकर यहाँ लिख सकते हैं।',
  },
  'setup.aiKey.keyLabel': { en: 'Paste the key here', hi: 'की यहाँ चिपकाएँ' },
  'setup.aiKey.keyHelper': {
    en: 'A long line of letters and numbers. Nothing is sent anywhere until you ask for a prescription to be read.',
    hi: 'अक्षरों और अंकों की एक लंबी लाइन। जब तक आप नुस्खा पढ़वाने को नहीं कहतीं, कुछ भी कहीं नहीं भेजा जाता।',
  },
  'setup.aiKey.paste': { en: 'Paste from clipboard', hi: 'क्लिपबोर्ड से चिपकाएँ' },
  'setup.aiKey.pasteEmpty': {
    en: 'There is nothing copied to paste.',
    hi: 'चिपकाने के लिए कुछ कॉपी नहीं किया गया है।',
  },
  'setup.aiKey.pasteFailed': {
    en: 'The clipboard could not be read on this phone. The key can be typed in instead.',
    hi: 'इस फ़ोन पर क्लिपबोर्ड नहीं पढ़ा जा सका। की हाथ से भी लिखी जा सकती है।',
  },
  'setup.aiKey.check': { en: 'Check this key', hi: 'इस की को जाँचें' },
  'setup.aiKey.checkNeedsKey': {
    en: 'Paste the key first, then it can be checked.',
    hi: 'पहले की चिपकाएँ, फिर उसे जाँचा जा सकता है।',
  },
  'setup.aiKey.resultWorking': { en: 'This key works', hi: 'यह की चल रही है' },
  'setup.aiKey.resultWorkingDetail': {
    en: 'Press Continue and a photograph of a prescription can be read from now on.',
    hi: '“आगे बढ़ें” दबाएँ — अब से नुस्खे की तस्वीर पढ़ी जा सकेगी।',
  },
  'setup.aiKey.resultRejected': { en: 'Google did not accept this key', hi: 'गूगल ने यह की नहीं मानी' },
  'setup.aiKey.resultRejectedDetail': {
    en: 'Usually only part of the key was copied. Copy the whole line again, or make a new key in Google AI Studio.',
    hi: 'अक्सर की का सिर्फ़ कुछ हिस्सा ही कॉपी हुआ होता है। पूरी लाइन दोबारा कॉपी करें, या गूगल AI स्टूडियो में नई की बनाएँ।',
  },
  'setup.aiKey.resultCannotUse': {
    en: 'This key cannot be used as it is',
    hi: 'यह की जैसी है, वैसी इस्तेमाल नहीं हो सकती',
  },
  'setup.aiKey.resultCannotUseDetail': {
    en: 'Google accepted the key itself and then refused the request — the key is locked to one app or website, or the reading service is switched off for its project, or its allowance is zero. Copying the key again cannot change any of those. They are fixed in Google Cloud Console.',
    hi: 'गूगल ने की तो मानी, पर अनुरोध ठुकरा दिया — या तो की किसी एक ऐप या वेबसाइट के लिए सीमित है, या उसके प्रोजेक्ट में पढ़ने वाली सेवा चालू नहीं है, या उसका हिस्सा शून्य है। की दोबारा कॉपी करने से इनमें से कुछ नहीं बदलेगा। ये गूगल क्लाउड कंसोल में ठीक होते हैं।',
  },
  'setup.aiKey.resultNoInternet': {
    en: 'Aarogya could not reach the internet',
    hi: 'आरोग्य इंटरनेट तक नहीं पहुँच सका',
  },
  'setup.aiKey.resultNoInternetDetail': {
    en: 'The key has not been checked — nothing is wrong with it yet. Turn on mobile data or Wi-Fi and check again.',
    hi: 'की जाँची नहीं जा सकी — अभी तक उसमें कोई गड़बड़ी नहीं मिली है। मोबाइल डेटा या वाई-फ़ाई चालू करके फिर से जाँचें।',
  },
  'setup.aiKey.resultNoAnswer': { en: 'Google could not answer just now', hi: 'गूगल अभी जवाब नहीं दे सका' },
  'setup.aiKey.resultNoAnswerDetail': {
    en: 'The key was neither accepted nor refused. You can save it and check again in a few minutes.',
    hi: 'की न मानी गई, न मना की गई। आप इसे सहेजकर कुछ मिनट बाद फिर से जाँच सकती हैं।',
  },
  'setup.aiKey.privacyTitle': { en: 'The key stays on this phone', hi: 'की इसी फ़ोन में रहती है' },
  'setup.aiKey.privacyBody': {
    en: 'It is held in the phone’s own secure store, not in your health record, so a backup you share with family never carries it. Only the photograph of a prescription ever leaves this phone, and only when someone asks for it to be read.',
    hi: 'यह फ़ोन के अपने सुरक्षित हिस्से में रहती है, आपके सेहत रिकॉर्ड में नहीं — इसलिए परिवार को दिया गया बैकअप इसे कभी साथ नहीं ले जाता। इस फ़ोन से सिर्फ़ नुस्खे की तस्वीर बाहर जाती है, और वह भी तभी जब कोई उसे पढ़वाने को कहे।',
  },
  'setup.aiKey.skip': { en: 'Skip — I’ll add it later', hi: 'रहने दें — बाद में जोड़ूँगी' },
  'setup.aiKey.skipNote': {
    en: 'You can skip this. Medicines can always be added by hand, and the key can be added any time from Settings. Nothing else in Aarogya needs it.',
    hi: 'आप इसे छोड़ सकती हैं। दवाइयाँ हमेशा हाथ से जोड़ी जा सकती हैं, और की सेटिंग से कभी भी जोड़ी जा सकती है। आरोग्य में बाकी किसी चीज़ को इसकी ज़रूरत नहीं।',
  },
  'setup.aiKey.saveFailed': {
    en: 'The key could not be saved on this phone. You can carry on without it and add it later from Settings.',
    hi: 'की इस फ़ोन में सहेजी नहीं जा सकी। आप इसके बिना आगे बढ़ सकती हैं और बाद में सेटिंग से जोड़ सकती हैं।',
  },
};

/**
 * Seven dots, filled up to the step showing. Duplicated verbatim in every setup step —
 * see the note in `_layout.tsx`. Keep the copies identical.
 */
function StepDots({ step }: { step: number }) {
  const { colors } = useTheme();
  const t = useT(STRINGS);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('setup.stepOf', { step, total: SETUP_STEPS })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: spacing.md }}
    >
      {Array.from({ length: SETUP_STEPS }, (_, index) => (
        <View
          key={index}
          style={{
            width: index + 1 === step ? 32 : 14,
            height: 14,
            borderRadius: radii.pill,
            borderWidth: 2,
            borderColor: index < step ? colors.primary : colors.borderStrong,
            backgroundColor: index < step ? colors.primary : colors.bg,
          }}
        />
      ))}
    </View>
  );
}

/** One numbered instruction. The numeral is a landmark, so it does not ride the font scale. */
function HowToStep({ index, text }: { index: number; text: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${index}. ${text}`}
      style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: radii.pill,
          backgroundColor: colors.primarySoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text variant="body" tone="primary" weight="600">
          {String(index)}
        </Text>
      </View>
      <View style={{ flex: 1, paddingTop: spacing.xs }}>
        <Text variant="body">{text}</Text>
      </View>
    </View>
  );
}

/**
 * What the check found. Five values, because there are five genuinely different things
 * that can be true — and "something went wrong" is none of them.
 */
type CheckOutcome = 'working' | 'rejected' | 'cannotBeUsed' | 'noInternet' | 'noAnswer';

/**
 * Maps a key-test failure onto the outcome the user can act on.
 *
 * `invalid_key` is a verdict about the CHARACTERS of the key, and its remedy is to copy
 * them again. Network codes mean the key was never shown to anybody. Everything else —
 * busy, over the daily allowance, a fault at Google's end — reached Google without
 * producing an answer either way, and saying so is more useful than picking a side.
 *
 * `cannotBeUsed` is the fourth thing, and it exists because the first sentence above is
 * actively harmful when it is wrong. A key restricted to an Android app, a project with
 * the API switched off, and an allowance of zero all have perfect characters — so "copy
 * the whole line again" is an instruction that can be followed all evening and cannot
 * succeed. Each of them is fixed in Google Cloud Console, by whoever owns the project.
 */
function outcomeFor(code: string): Exclude<CheckOutcome, 'working'> {
  if (code === 'key_restricted' || code === 'api_not_enabled' || code === 'quota_zero') {
    return 'cannotBeUsed';
  }
  if (code === 'invalid_key' || code === 'no_key') return 'rejected';
  if (code === 'offline' || code === 'timeout') return 'noInternet';
  return 'noAnswer';
}

export default function SetupAiKeyScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);
  const { colors } = useTheme();

  const [draft, setDraft] = useState('');
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const openStudio = useCallback(async () => {
    try {
      await Linking.openURL(AI_STUDIO_URL);
    } catch {
      // A handset with no browser at all is rare but real — a wiped Go-class device, or
      // one where the browser has been disabled by a work profile. It must not crash the
      // step; it must say what to do instead.
      toast.show({ message: t('setup.aiKey.openFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const copied = (await Clipboard.getStringAsync()).trim();
      if (copied === '') {
        toast.show({ message: t('setup.aiKey.pasteEmpty'), variant: 'info' });
        return;
      }
      setDraft(copied);
      // A pasted key has not been checked, whatever the last check said about the old one.
      setOutcome(null);
    } catch {
      toast.show({ message: t('setup.aiKey.pasteFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const check = useCallback(async () => {
    const value = draft.trim();
    if (value === '') {
      toast.show({ message: t('setup.aiKey.checkNeedsKey'), variant: 'info' });
      return;
    }
    setChecking(true);
    setOutcome(null);
    try {
      // Verified BEFORE it is saved, and nothing is written either way — so a bad key
      // pasted over a good one cannot replace it.
      const result = await testKey(value);
      setOutcome(result.ok ? 'working' : outcomeFor(result.error.code));
    } catch (error) {
      // testKey resolves rather than throws, so this is a defect rather than a refusal.
      // It is still not a verdict about her key.
      console.warn('[setup/ai-key] the key check did not complete', error);
      setOutcome('noAnswer');
    } finally {
      setChecking(false);
    }
  }, [draft, t, toast]);

  /**
   * Continue. Saves the key if one has been pasted, and moves on either way.
   *
   * A key that could not be saved is reported and then stepped past: refusing to advance
   * would strand her on a screen she was told she could skip.
   */
  const goOn = useCallback(async () => {
    if (saving) return;
    const value = draft.trim();
    if (value === '') {
      router.push('/setup/health');
      return;
    }
    setSaving(true);
    try {
      await setApiKey(value);
    } catch (error) {
      console.warn('[setup/ai-key] could not save the key', error);
      toast.show({ message: t('setup.aiKey.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
    router.push('/setup/health');
  }, [saving, draft, router, t, toast]);

  return (
    <Screen
      variant="scroll"
      footer={
        // Stacked, not side by side: Continue comes first because this step's actions are
        // not a pair of equals. The skip below it is the SAME SIZE and the same width — a
        // skip in small grey text is where a first run gets abandoned instead of
        // finished, and this step is genuinely optional. See the file header.
        <WizardFooter
          layout="stack"
          actions={[
            {
              title: t('common.continue'),
              onPress: () => void goOn(),
              size: 'lg',
              loading: saving,
            },
            {
              title: t('setup.aiKey.skip'),
              onPress: () => router.push('/setup/health'),
              variant: 'secondary',
              size: 'lg',
              disabled: saving,
            },
          ]}
        />
      }
    >
      <StepDots step={6} />
      <ScreenHeader
        title={t('setup.aiKey.title')}
        subtitle={t('setup.aiKey.why')}
        onBack={() => router.back()}
      />

      <View style={{ gap: spacing.md }}>
        <Text variant="body" weight="600">
          {t('setup.aiKey.free')}
        </Text>

        <Card>
          <View style={{ gap: spacing.lg }}>
            <Text variant="label">{t('setup.aiKey.howTitle')}</Text>
            {/* Written out one by one rather than mapped over an index, so every key is a
                static literal that `scripts/check-i18n.js` can actually resolve. */}
            <HowToStep index={1} text={t('setup.aiKey.step1')} />
            <HowToStep index={2} text={t('setup.aiKey.step2')} />
            <HowToStep index={3} text={t('setup.aiKey.step3')} />
            <HowToStep index={4} text={t('setup.aiKey.step4')} />
            <HowToStep index={5} text={t('setup.aiKey.step5')} />
            <Button
              title={t('setup.aiKey.open')}
              onPress={() => void openStudio()}
              size="xl"
              fullWidth
            />
          </View>
        </Card>

        <Card>
          <View style={{ gap: spacing.lg }}>
            <TextField
              label={t('setup.aiKey.keyLabel')}
              helper={t('setup.aiKey.keyHelper')}
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                setOutcome(null);
              }}
              // Shown rather than dotted out, on purpose: the one failure this step has to
              // catch is half a key pasted, and a field of dots cannot be proof-read.
              // Never autocorrected into something else, and never offered to the
              // keyboard's own suggestion store.
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              multiline
            />
            <Button
              title={t('setup.aiKey.paste')}
              onPress={() => void pasteFromClipboard()}
              variant="secondary"
              size="lg"
              fullWidth
            />
            <Button
              title={t('setup.aiKey.check')}
              onPress={() => void check()}
              variant="secondary"
              size="lg"
              fullWidth
              loading={checking}
            />

            {outcome === 'working' ? (
              <View
                accessible
                accessibilityLabel={`${t('setup.aiKey.resultWorking')}. ${t('setup.aiKey.resultWorkingDetail')}`}
                style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}
              >
                <Icon name="check" size={30} color={colors.success} strokeWidth={2.6} />
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <Text variant="label">{t('setup.aiKey.resultWorking')}</Text>
                  <Text variant="body" tone="muted">
                    {t('setup.aiKey.resultWorkingDetail')}
                  </Text>
                </View>
              </View>
            ) : outcome === 'rejected' ? (
              <Banner
                variant="attention"
                title={t('setup.aiKey.resultRejected')}
                message={t('setup.aiKey.resultRejectedDetail')}
              />
            ) : outcome === 'cannotBeUsed' ? (
              <Banner
                variant="attention"
                title={t('setup.aiKey.resultCannotUse')}
                message={t('setup.aiKey.resultCannotUseDetail')}
              />
            ) : outcome === 'noInternet' ? (
              <Banner
                variant="attention"
                title={t('setup.aiKey.resultNoInternet')}
                message={t('setup.aiKey.resultNoInternetDetail')}
              />
            ) : outcome === 'noAnswer' ? (
              <Banner
                variant="info"
                title={t('setup.aiKey.resultNoAnswer')}
                message={t('setup.aiKey.resultNoAnswerDetail')}
              />
            ) : null}
          </View>
        </Card>

        <Banner
          variant="info"
          title={t('setup.aiKey.privacyTitle')}
          message={t('setup.aiKey.privacyBody')}
        />
      </View>

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.xl }}>
        {t('setup.aiKey.skipNote')}
      </Text>
    </Screen>
  );
}
