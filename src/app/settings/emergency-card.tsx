/**
 * The emergency card.
 *
 * ─── EVERY LINE IS OPT-IN, ONE AT A TIME ──────────────────────────────────────
 * This is the only screen in the app designed to be read by a stranger, possibly without
 * unlocking the phone. So there is no "show my details" master switch: each line is its
 * own decision, because the calculus is different for each one. A blood group helps a
 * paramedic and tells a landlord nothing. A diagnosis is the opposite.
 *
 * ─── THE CONDITIONS LINE IS OFF BY DEFAULT AND STAYS OFF ──────────────────────
 * A visible TB diagnosis on a lock screen carries real social and employment
 * consequences in India — housing refused, work lost, a marriage called off — and none
 * of that is undone by the fact that a responder might also have found it useful. The
 * default lives in the schema (`show_conditions` = 0) and this screen never overrides it.
 * The neutral treatment line is what makes that default liveable: it carries the
 * clinically useful signal ("on long-term treatment, call this number") without naming
 * the condition to everyone else who picks up the handset.
 *
 * The medicines line is flagged in the same spirit: anyone who knows drug names can read
 * a diagnosis straight off a medicine list, so the warning is stated rather than assumed.
 */

import React, { useCallback, useState } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';

import { useAsync, useProfileId, useReloadOnFocus, useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Dialog,
  Divider,
  EmptyState,
  ListRow,
  PressableScale,
  ROW_DIVIDER_INSET,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useToast,
} from '@/components/ui';
import { createContact, listContacts, type Contact } from '@/db/repositories/contacts';
import {
  buildEmergencyCardLines,
  getOrCreateEmergencyCard,
  updateEmergencyCard,
  type EmergencyCard,
  type EmergencyCardField,
  type EmergencyCardPatch,
} from '@/db/repositories/emergency';
import { listActiveMedicines } from '@/db/repositories/medicines';
import { listConditionPacks, listProfileConditions, getProfile } from '@/db/repositories/profiles';
import { useI18n } from '@/i18n';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

const FIELD_LABEL_KEYS: Record<EmergencyCardField, string> = {
  name: 'emergency.field.name',
  age: 'emergency.field.age',
  blood_group: 'emergency.field.bloodGroup',
  allergies: 'emergency.field.allergies',
  medicines: 'emergency.field.medicines',
  conditions: 'emergency.field.conditions',
  treatment_note: 'emergency.field.treatmentNote',
};

const STRINGS: LocalStrings = {
  'emergency.subtitle': {
    en: 'This is what a stranger can see if you are unwell and cannot speak. You choose every line.',
    hi: 'अगर आपकी तबीयत बिगड़ जाए और आप बोल न पाएँ, तो कोई अजनबी यह देख सकता है। हर पंक्ति आप खुद चुनती हैं।',
  },
  'emergency.toggleTitle': { en: 'What may be shown', hi: 'क्या दिखाया जा सकता है' },
  'emergency.show.name': { en: 'Your name', hi: 'आपका नाम' },
  'emergency.show.age': { en: 'Your age', hi: 'आपकी उम्र' },
  'emergency.show.bloodGroup': { en: 'Your blood group', hi: 'आपका ब्लड ग्रुप' },
  'emergency.show.allergies': { en: 'Your allergies', hi: 'आपकी एलर्जी' },
  'emergency.show.medicines': { en: 'The medicines you take', hi: 'आप जो दवाइयाँ लेती हैं' },
  'emergency.show.conditions': {
    en: 'What you are being treated for',
    hi: 'आपका इलाज किस चीज़ का चल रहा है',
  },
  'emergency.conditionsWhy': {
    en: 'This starts off switched off, and stays off unless you switch it on yourself. A diagnosis seen on a lock screen can cost someone a home or a job, and once it has been seen it cannot be unseen.',
    hi: 'यह शुरू से बंद है और तब तक बंद ही रहेगा जब तक आप खुद इसे चालू न करें। लॉक स्क्रीन पर दिखी बीमारी किसी का घर या नौकरी छीन सकती है, और एक बार दिख जाने के बाद उसे अनदेखा नहीं किया जा सकता।',
  },
  'emergency.medicinesWhy': {
    en: 'Anyone who knows medicines can often work out the illness from their names. Worth keeping in mind here.',
    hi: 'दवाइयों को जानने वाला कोई भी व्यक्ति अकसर उनके नामों से बीमारी का अंदाज़ा लगा लेता है। यहाँ इसका ध्यान रखें।',
  },
  'emergency.treatmentLine': { en: 'A line you write yourself, instead', hi: 'इसकी जगह अपनी लिखी हुई एक पंक्ति' },
  'emergency.treatmentHelper': {
    en: 'For example: On long-term treatment — please contact the number below',
    hi: 'जैसे: लंबे इलाज पर हूँ — कृपया नीचे दिए नंबर पर संपर्क करें',
  },
  'emergency.allergies': { en: 'Allergies', hi: 'एलर्जी' },
  'emergency.allergiesHelper': {
    en: 'Medicines or foods that do not suit you',
    hi: 'वे दवाइयाँ या चीज़ें जो आपको सूट नहीं करतीं',
  },
  'emergency.preview': { en: 'What the card will show', hi: 'कार्ड पर क्या दिखेगा' },
  'emergency.previewEmpty': {
    en: 'Nothing is being shown at the moment.',
    hi: 'अभी कुछ भी नहीं दिखाया जा रहा है।',
  },
  'emergency.contacts': { en: 'Who to call', hi: 'किसे फोन करें' },
  'emergency.noContacts': { en: 'Nobody has been added yet', hi: 'अभी किसी को नहीं जोड़ा गया' },
  'emergency.noContactsMessage': {
    en: 'A card with no number on it cannot get you help. Add one person.',
    hi: 'बिना नंबर वाला कार्ड आपको मदद नहीं दिला सकता। कम से कम एक व्यक्ति जोड़ें।',
  },
  'emergency.addContact': { en: 'Add someone to call', hi: 'फोन करने के लिए किसी को जोड़ें' },
  'emergency.contactName': { en: 'Their name', hi: 'उनका नाम' },
  'emergency.contactRelation': { en: 'How they know you', hi: 'वे आपके कौन हैं' },
  'emergency.contactPhone': { en: 'Phone number', hi: 'फोन नंबर' },
  'emergency.contactNameRequired': { en: 'Please write their name.', hi: 'कृपया उनका नाम लिखें।' },
  'emergency.contactPhoneRequired': { en: 'Please write a phone number.', hi: 'कृपया फोन नंबर लिखें।' },
  'emergency.saveFailed': { en: 'That change could not be saved.', hi: 'यह बदलाव सहेजा नहीं जा सका।' },
  'emergency.field.name': { en: 'Name', hi: 'नाम' },
  'emergency.field.age': { en: 'Age', hi: 'उम्र' },
  'emergency.field.bloodGroup': { en: 'Blood group', hi: 'ब्लड ग्रुप' },
  'emergency.field.allergies': { en: 'Allergies', hi: 'एलर्जी' },
  'emergency.field.medicines': { en: 'Medicines', hi: 'दवाइयाँ' },
  'emergency.field.conditions': { en: 'Being treated for', hi: 'इलाज किस चीज़ का' },
  'emergency.field.treatmentNote': { en: 'Note', hi: 'सूचना' },
};

type Loaded = {
  card: EmergencyCard;
  name: string | null;
  age: number | null;
  bloodGroup: string | null;
  medicineNames: string[];
  conditionLabels: string[];
  contacts: Contact[];
};

export default function EmergencyCardScreen() {
  const t = useT(STRINGS);
  const { lang } = useI18n();
  const toast = useToast();
  const profileState = useProfileId();
  const profileId = profileState.data;

  const [addOpen, setAddOpen] = useState(false);
  const [treatmentLine, setTreatmentLine] = useState('');
  const [allergies, setAllergies] = useState('');
  const [textDirty, setTextDirty] = useState(false);
  const [savingText, setSavingText] = useState(false);

  const state = useAsync<Loaded | null>(async () => {
    if (!profileId) return null;
    const [card, profile, medicines, packs, conditions, contacts] = await Promise.all([
      getOrCreateEmergencyCard(profileId),
      getProfile(profileId),
      listActiveMedicines(profileId),
      listConditionPacks(),
      listProfileConditions(profileId),
      listContacts(profileId),
    ]);

    const activeKeys = new Set(
      conditions.filter((row) => row.endedOn === null).map((row) => row.packKey),
    );
    const conditionLabels = packs
      .filter((pack) => activeKeys.has(pack.key))
      .map((pack) => (lang === 'hi' ? pack.labelHi : pack.labelEn));

    const age =
      profile?.yearOfBirth != null ? new Date().getFullYear() - profile.yearOfBirth : null;

    return {
      card,
      name: profile?.displayName ?? null,
      age,
      bloodGroup: profile?.bloodGroup ?? null,
      medicineNames: medicines.map((medicine) =>
        medicine.strength ? `${medicine.nameAsWritten} ${medicine.strength}` : medicine.nameAsWritten,
      ),
      conditionLabels,
      contacts,
    };
  }, [profileId, lang]);

  const { reload } = state;
  useReloadOnFocus(reload);

  const loadedCard = state.data?.card ?? null;
  const cardId = loadedCard?.profileId ?? null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (loadedCard && cardId && seededFor !== cardId && !textDirty) {
    setSeededFor(cardId);
    setTreatmentLine(loadedCard.neutralTreatmentLine ?? '');
    setAllergies(loadedCard.allergiesText ?? '');
  }

  const patch = useCallback(
    async (values: EmergencyCardPatch) => {
      if (!profileId) return;
      try {
        await updateEmergencyCard(profileId, values);
        reload();
      } catch (error) {
        console.warn('[emergency] could not save the card', error);
        toast.show({ message: t('emergency.saveFailed'), variant: 'error' });
      }
    },
    [profileId, reload, t, toast],
  );

  const saveText = useCallback(async () => {
    if (!profileId || savingText) return;
    setSavingText(true);
    try {
      await updateEmergencyCard(profileId, {
        neutralTreatmentLine: treatmentLine.trim() === '' ? null : treatmentLine.trim(),
        allergiesText: allergies.trim() === '' ? null : allergies.trim(),
      });
      setTextDirty(false);
      toast.show({ message: t('common.saved'), variant: 'success' });
      reload();
    } catch (error) {
      console.warn('[emergency] could not save the written lines', error);
      toast.show({ message: t('emergency.saveFailed'), variant: 'error' });
    } finally {
      setSavingText(false);
    }
  }, [profileId, savingText, treatmentLine, allergies, t, toast, reload]);

  const data = state.data;
  // The preview is built by the SAME pure function the card itself uses, from the same
  // flags — so what she reads here is what a stranger reads, not an approximation of it.
  const lines = data
    ? buildEmergencyCardLines(data.card, {
        name: data.name,
        age: data.age,
        bloodGroup: data.bloodGroup,
        allergies: data.card.allergiesText,
        medicineNames: data.medicineNames,
        conditionLabels: data.conditionLabels,
      })
    : [];

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('settings.emergencyCard')}
        subtitle={t('emergency.subtitle')}
        onBack={() => router.back()}
      />

      {state.loading && !state.data ? <Skeleton height={200} label={t('a11y.loading')} /> : null}

      {state.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          message={state.error.message}
          actionLabel={t('common.retry')}
          onAction={reload}
        />
      ) : null}

      {data ? (
        <View style={{ gap: spacing.md }}>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('emergency.preview')}</Text>
              {lines.length === 0 ? (
                <Text variant="body" tone="muted">
                  {t('emergency.previewEmpty')}
                </Text>
              ) : (
                lines.map((line) => (
                  <Text key={line.field} variant="body">
                    {`${t(FIELD_LABEL_KEYS[line.field])}: ${line.value}`}
                  </Text>
                ))
              )}
            </View>
          </Card>

          <Card>
            <View>
              <Text variant="label">{t('emergency.toggleTitle')}</Text>
              <ToggleRow
                title={t('emergency.show.name')}
                value={data.card.showName}
                onChange={(next) => void patch({ showName: next })}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ToggleRow
                title={t('emergency.show.age')}
                value={data.card.showAge}
                onChange={(next) => void patch({ showAge: next })}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ToggleRow
                title={t('emergency.show.bloodGroup')}
                value={data.card.showBloodGroup}
                onChange={(next) => void patch({ showBloodGroup: next })}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ToggleRow
                title={t('emergency.show.allergies')}
                value={data.card.showAllergies}
                onChange={(next) => void patch({ showAllergies: next })}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ToggleRow
                title={t('emergency.show.medicines')}
                subtitle={t('emergency.medicinesWhy')}
                value={data.card.showMedicines}
                onChange={(next) => void patch({ showMedicines: next })}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              {/* Off by default, by schema. The sentence beside it is the reason, in her
                  own words, at the exact moment the decision is in front of her. */}
              <ToggleRow
                title={t('emergency.show.conditions')}
                subtitle={t('emergency.conditionsWhy')}
                value={data.card.showConditions}
                onChange={(next) => void patch({ showConditions: next })}
              />
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.lg }}>
              <TextField
                label={t('emergency.treatmentLine')}
                helper={t('emergency.treatmentHelper')}
                value={treatmentLine}
                onChangeText={(value) => {
                  setTreatmentLine(value);
                  setTextDirty(true);
                }}
                multiline
              />
              <TextField
                label={t('emergency.allergies')}
                helper={t('emergency.allergiesHelper')}
                value={allergies}
                onChangeText={(value) => {
                  setAllergies(value);
                  setTextDirty(true);
                }}
                multiline
              />
              <Button
                title={t('common.save')}
                onPress={() => void saveText()}
                loading={savingText}
                disabled={!textDirty}
                size="lg"
                fullWidth
              />
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label">{t('emergency.contacts')}</Text>
              {data.contacts.length === 0 ? (
                <EmptyState
                  title={t('emergency.noContacts')}
                  message={t('emergency.noContactsMessage')}
                  actionLabel={t('emergency.addContact')}
                  onAction={() => setAddOpen(true)}
                />
              ) : (
                <>
                  {/* Emergency contacts are a handful by construction — this is the
                      "who to call" list on a card a stranger reads, not a directory —
                      so it renders inline rather than in a virtualised list. Nothing is
                      ever hidden: every number she added is shown. */}
                  {data.contacts.map((contact, index) => (
                    <View key={contact.id}>
                      {index > 0 ? <Divider inset={ROW_DIVIDER_INSET} /> : null}
                      <ListRow
                        title={contact.label}
                        subtitle={contact.phone ?? t('common.unknown')}
                        meta={contact.role ?? undefined}
                        showChevron={false}
                      />
                    </View>
                  ))}
                  <Button
                    title={t('emergency.addContact')}
                    onPress={() => setAddOpen(true)}
                    variant="secondary"
                    size="md"
                    fullWidth
                  />
                </>
              )}
            </View>
          </Card>
        </View>
      ) : null}

      {profileId ? (
        <AddContactDialog
          visible={addOpen}
          profileId={profileId}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

function AddContactDialog({
  visible,
  profileId,
  onClose,
  onSaved,
}: {
  visible: boolean;
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(STRINGS);
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (saving) return;
    const name = label.trim();
    if (!name) {
      setError(t('emergency.contactNameRequired'));
      return;
    }
    const number = phone.trim();
    if (!number) {
      setError(t('emergency.contactPhoneRequired'));
      return;
    }
    setSaving(true);
    try {
      await createContact({
        profileId,
        label: name,
        role: role.trim() === '' ? null : role.trim(),
        phone: number,
      });
      setLabel('');
      setRole('');
      setPhone('');
      setError(null);
      toast.show({ message: t('common.saved'), variant: 'success' });
      onSaved();
    } catch (e) {
      console.warn('[emergency] could not add a contact', e);
      toast.show({ message: t('emergency.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [saving, label, role, phone, profileId, t, toast, onSaved]);

  return (
    <Dialog
      visible={visible}
      title={t('emergency.addContact')}
      onRequestClose={onClose}
      footer={
        <View style={{ gap: spacing.md }}>
          <Button title={t('common.cancel')} onPress={onClose} variant="secondary" size="lg" fullWidth />
          <Button title={t('common.save')} onPress={() => void save()} loading={saving} size="lg" fullWidth />
        </View>
      }
    >
      <View style={{ gap: spacing.lg }}>
        <TextField
          label={t('emergency.contactName')}
          value={label}
          onChangeText={setLabel}
          autoCapitalize="words"
          required
        />
        <TextField
          label={t('emergency.contactRelation')}
          value={role}
          onChangeText={setRole}
          autoCapitalize="sentences"
        />
        <TextField
          label={t('emergency.contactPhone')}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          required
        />
        {error ? (
          <Text variant="body" tone="destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

/** Whole-row switch. Same rationale as the one on the Settings index. */
function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const { colors } = useTheme();

  return (
    <PressableScale
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ checked: value }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: spacing.touchTarget,
        paddingVertical: spacing.md,
      }}
    >
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text variant="body" weight="600">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ false: colors.border, true: colors.primarySoft }}
          thumbColor={value ? colors.primary : colors.borderStrong}
        />
      </View>
    </PressableScale>
  );
}
