/**
 * Setup step 4 — the one person to show if something goes wrong.
 *
 * One contact, not a list. A list invites her to fill it in "properly later", and later
 * never comes; one name and one number is a question she can finish in thirty seconds and
 * is already the whole of what a stranger holding her phone needs.
 *
 * The screen says out loud that nothing is sent anywhere. That sentence is not
 * reassurance-flavoured filler — a woman who has been asked for a family member's phone
 * number by half a dozen apps has good reason to assume it is about to be messaged, and
 * the honest answer here is that the number is written into the local database and shown
 * on the emergency card, and that is all that ever happens to it.
 *
 * Skippable. An emergency card with no contact is a weaker card, not a broken app.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { radii, spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { Banner, Chip, Screen, ScreenHeader, SectionHeader, Text, TextField, useToast } from '@/components/ui';
import { WizardFooter } from './_layout';
import { createContact } from '@/db/repositories/contacts';
import { resolveProfileId, useAsync, useT, type LocalStrings } from '@/app/_shared/lib';

const SETUP_STEPS = 7;

/** Shortest number worth storing. Indian mobiles are 10 digits; landlines can be 8. */
const MIN_PHONE_DIGITS = 8;

const RELATIONS = [
  { key: 'son', i18nKey: 'setup.contact.relation.son' },
  { key: 'daughter', i18nKey: 'setup.contact.relation.daughter' },
  { key: 'husband', i18nKey: 'setup.contact.relation.husband' },
  { key: 'wife', i18nKey: 'setup.contact.relation.wife' },
  { key: 'neighbour', i18nKey: 'setup.contact.relation.neighbour' },
  { key: 'doctor', i18nKey: 'setup.contact.relation.doctor' },
  { key: 'other', i18nKey: 'setup.contact.relation.other' },
] as const;

const STRINGS: LocalStrings = {
  'setup.stepOf': { en: 'Step {{step}} of {{total}}', hi: 'कुल {{total}} में से कदम {{step}}' },
  'setup.contact.title': {
    en: 'Who should we show if there is an emergency?',
    hi: 'किसी आपात स्थिति में हम किसका नाम दिखाएँ?',
  },
  'setup.contact.help': {
    en: 'This one name and number appears on your emergency card, so someone helping you knows who to call. Nothing is sent to them, and it never leaves this phone.',
    hi: 'यह एक नाम और नंबर आपके आपातकालीन कार्ड पर दिखेगा, ताकि मदद करने वाले को पता हो कि किसे फ़ोन करना है। उन्हें कुछ भेजा नहीं जाता, और यह इस फ़ोन से बाहर नहीं जाता।',
  },
  'setup.contact.name': { en: 'Their name', hi: 'उनका नाम' },
  'setup.contact.relationTitle': { en: 'Who are they to you?', hi: 'वे आपके क्या लगते हैं?' },
  'setup.contact.relation.son': { en: 'Son', hi: 'बेटा' },
  'setup.contact.relation.daughter': { en: 'Daughter', hi: 'बेटी' },
  'setup.contact.relation.husband': { en: 'Husband', hi: 'पति' },
  'setup.contact.relation.wife': { en: 'Wife', hi: 'पत्नी' },
  'setup.contact.relation.neighbour': { en: 'Neighbour', hi: 'पड़ोसी' },
  'setup.contact.relation.doctor': { en: 'Doctor', hi: 'डॉक्टर' },
  'setup.contact.relation.other': { en: 'Someone else', hi: 'कोई और' },
  'setup.contact.relationOther': { en: 'Write it in your own words', hi: 'अपने शब्दों में लिखें' },
  'setup.contact.phone': { en: 'Their phone number', hi: 'उनका फ़ोन नंबर' },
  'setup.contact.nameNeeded': {
    en: 'Please write their name, or press Skip.',
    hi: 'कृपया उनका नाम लिखें, या “छोड़ दें” दबाएँ।',
  },
  'setup.contact.phoneNeeded': {
    en: 'Please write a phone number, or press Skip.',
    hi: 'कृपया फ़ोन नंबर लिखें, या “छोड़ दें” दबाएँ।',
  },
  'setup.contact.phoneShort': {
    en: 'That number looks too short. Please check it.',
    hi: 'यह नंबर बहुत छोटा लग रहा है। कृपया एक बार जाँच लें।',
  },
  'setup.contact.skipNote': {
    en: 'You can leave this. Your emergency card will simply not show anyone to call.',
    hi: 'आप इसे छोड़ सकती हैं। तब आपके आपातकालीन कार्ड पर किसी को फ़ोन करने के लिए नाम नहीं दिखेगा।',
  },
  'setup.contact.noProfile': {
    en: 'Let us start from the first question',
    hi: 'चलिए पहले सवाल से शुरू करते हैं',
  },
  'setup.contact.noProfileMessage': {
    en: 'Aarogya does not have your name yet, so there is nothing to save this contact against.',
    hi: 'आरोग्य के पास अभी आपका नाम नहीं है, इसलिए यह संपर्क किसके लिए सहेजें यह पता नहीं है।',
  },
  'setup.contact.goBack': { en: 'Go to the first question', hi: 'पहले सवाल पर जाएँ' },
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

export default function SetupContactScreen() {
  const router = useRouter();
  const toast = useToast();
  const t = useT(STRINGS);

  const profile = useAsync(() => resolveProfileId(), []);

  const [name, setName] = useState('');
  const [relationKey, setRelationKey] = useState<string | null>(null);
  const [relationOther, setRelationOther] = useState('');
  const [phone, setPhone] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const digits = useMemo(() => phone.replace(/\D/g, ''), [phone]);

  const save = useCallback(async () => {
    const profileId = profile.data;
    if (!profileId || saving) return;

    const trimmedName = name.trim();
    const nextNameError = trimmedName === '' ? t('setup.contact.nameNeeded') : undefined;
    const nextPhoneError =
      digits.length === 0
        ? t('setup.contact.phoneNeeded')
        : digits.length < MIN_PHONE_DIGITS
          ? t('setup.contact.phoneShort')
          : undefined;
    setNameError(nextNameError);
    setPhoneError(nextPhoneError);
    if (nextNameError || nextPhoneError) return;

    // The relationship is stored as the WORD she chose, in her language, not as a key.
    // It is read off an emergency card by a stranger, so it has to be a sentence a human
    // can read, not a token a future screen has to translate back.
    const relationLabel =
      relationKey === 'other'
        ? relationOther.trim()
        : relationKey
          ? t(`setup.contact.relation.${relationKey}`)
          : '';

    setSaving(true);
    try {
      await createContact({
        profileId,
        label: trimmedName,
        role: relationLabel === '' ? null : relationLabel,
        phone: phone.trim(),
      });
      toast.show({ message: t('common.saved'), variant: 'success' });
      router.push('/setup/reminders');
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [profile.data, saving, name, digits, phone, relationKey, relationOther, router, toast, t]);

  if (!profile.loading && profile.data === null) {
    return (
      <Screen variant="scroll">
        <StepDots step={4} />
        <ScreenHeader title={t('setup.contact.title')} onBack={() => router.back()} />
        <Banner
          variant="attention"
          title={t('setup.contact.noProfile')}
          message={t('setup.contact.noProfileMessage')}
          actionLabel={t('setup.contact.goBack')}
          onAction={() => router.replace('/setup')}
        />
      </Screen>
    );
  }

  return (
    <Screen
      variant="scroll"
      footer={
        <WizardFooter
          actions={[
            {
              title: t('common.skip'),
              onPress: () => router.push('/setup/reminders'),
              variant: 'secondary',
              size: 'lg',
              disabled: saving,
            },
            {
              title: t('common.next'),
              onPress: () => void save(),
              size: 'lg',
              loading: saving,
              disabled: profile.loading,
            },
          ]}
        />
      }
    >
      <StepDots step={4} />
      <ScreenHeader
        title={t('setup.contact.title')}
        subtitle={t('setup.contact.help')}
        onBack={() => router.back()}
      />

      <TextField
        label={t('setup.contact.name')}
        value={name}
        onChangeText={(next) => {
          setName(next);
          if (nameError) setNameError(undefined);
        }}
        error={nameError}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={60}
      />

      <SectionHeader title={t('setup.contact.relationTitle')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {RELATIONS.map((relation) => (
          <Chip
            key={relation.key}
            label={t(relation.i18nKey)}
            selected={relationKey === relation.key}
            onPress={() => setRelationKey(relationKey === relation.key ? null : relation.key)}
            selectionMode="single"
          />
        ))}
      </View>

      {relationKey === 'other' ? (
        <View style={{ paddingTop: spacing.md }}>
          <TextField
            label={t('setup.contact.relationOther')}
            value={relationOther}
            onChangeText={setRelationOther}
            autoCapitalize="none"
            maxLength={40}
          />
        </View>
      ) : null}

      <View style={{ paddingTop: spacing.lg }}>
        <TextField
          label={t('setup.contact.phone')}
          value={phone}
          onChangeText={(next) => {
            setPhone(next);
            if (phoneError) setPhoneError(undefined);
          }}
          error={phoneError}
          keyboardType="phone-pad"
          autoCorrect={false}
          maxLength={20}
        />
      </View>

      <Text variant="caption" tone="muted" style={{ paddingTop: spacing.lg }}>
        {t('setup.contact.skipNote')}
      </Text>
    </Screen>
  );
}
