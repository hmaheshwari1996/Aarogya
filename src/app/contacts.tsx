/**
 * Contacts — the doctor, the clinic, and whoever should be called first.
 *
 * These rows are the ones that end up on the emergency card, so the list stays short and
 * ordered by hand: whoever is at the top is who a stranger reads first. There is no
 * import from the phone's address book — reading her contacts to save a few taps is a
 * privacy cost with no matching benefit, and this list is four entries long.
 *
 * A phone number is tappable and dials. It never sends anything, and this screen never
 * initiates a message on her behalf.
 */

import React, { useCallback, useState } from 'react';
import { FlatList, Linking, View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import {
  Button,
  Dialog,
  Divider,
  EmptyState,
  ListRow,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import {
  createContact,
  deleteContact,
  listContacts,
  reorderContacts,
  updateContact,
  type Contact,
} from '@/db/repositories/contacts';

import { useAsync, useProfileId, useReloadOnFocus, useT, type LocalStrings } from './_shared/lib';

const STRINGS: LocalStrings = {
  'contacts.title': { en: 'Contacts', hi: 'सम्पर्क' },
  'contacts.subtitle': {
    en: 'Doctors, the clinic, and family. The one at the top is shown first in an emergency.',
    hi: 'डॉक्टर, क्लिनिक और परिवार। सबसे ऊपर वाला आपात स्थिति में पहले दिखाया जाता है।',
  },
  'contacts.empty': { en: 'No contacts yet', hi: 'अभी कोई सम्पर्क नहीं' },
  'contacts.emptyMessage': {
    en: 'Add your doctor or a family member, and they will be one tap away.',
    hi: 'अपने डॉक्टर या परिवार के किसी सदस्य को जोड़िए, वे एक ही दबाव दूर होंगे।',
  },
  'contacts.add': { en: 'Add a contact', hi: 'सम्पर्क जोड़िए' },
  'contacts.editTitle': { en: 'Edit contact', hi: 'सम्पर्क बदलिए' },
  'contacts.addTitle': { en: 'New contact', hi: 'नया सम्पर्क' },
  'contacts.name': { en: 'Name', hi: 'नाम' },
  'contacts.namePlaceholder': { en: 'Dr Sharma', hi: 'डॉ. शर्मा' },
  'contacts.role': { en: 'Who is this?', hi: 'यह कौन हैं?' },
  'contacts.rolePlaceholder': { en: 'Heart doctor, son, clinic', hi: 'दिल के डॉक्टर, बेटा, क्लिनिक' },
  'contacts.phone': { en: 'Phone number', hi: 'फ़ोन नंबर' },
  'contacts.address': { en: 'Address', hi: 'पता' },
  'contacts.call': { en: 'Call', hi: 'फ़ोन कीजिए' },
  'contacts.moveUp': { en: 'Move up', hi: 'ऊपर कीजिए' },
  'contacts.nameRequired': { en: 'Please fill in the name.', hi: 'कृपया नाम भरिए।' },
  'contacts.deleteTitle': { en: 'Remove {{name}}?', hi: '{{name}} को हटा दें?' },
  'contacts.deleteMessage': {
    en: 'They will no longer appear here or on the emergency card.',
    hi: 'वे न यहाँ दिखेंगे और न आपातकालीन कार्ड पर।',
  },
  'contacts.saved': { en: 'Saved', hi: 'सहेज लिया' },
  'contacts.removed': { en: 'Removed', hi: 'हटा दिया गया' },
  'contacts.cannotCall': { en: 'This phone cannot make the call.', hi: 'यह फ़ोन कॉल नहीं कर सका।' },
};

const ROW_HEIGHT = 100;
const ROW_STRIDE = ROW_HEIGHT + 1;

const itemLayout = (_data: unknown, index: number) => ({
  length: ROW_HEIGHT,
  offset: ROW_STRIDE * index,
  index,
});

type Draft = {
  id: string | null;
  label: string;
  role: string;
  phone: string;
  address: string;
};

const EMPTY_DRAFT: Draft = { id: null, label: '', role: '', phone: '', address: '' };

export default function ContactsScreen() {
  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const { data: profileId } = useProfileId();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const { data, loading, reload } = useAsync(
    async () => (profileId ? listContacts(profileId) : []),
    [profileId],
  );
  useReloadOnFocus(reload);

  const save = useCallback(async () => {
    if (!draft || !profileId || saving) return;
    const label = draft.label.trim();
    if (!label) {
      setNameError(t('contacts.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const patch = {
        label,
        role: draft.role.trim() || null,
        phone: draft.phone.trim() || null,
        address: draft.address.trim() || null,
      };
      if (draft.id) await updateContact(draft.id, patch);
      else await createContact({ profileId, ...patch });
      toast.show({ message: t('contacts.saved'), variant: 'success' });
      setDraft(null);
      setNameError(undefined);
      reload();
    } finally {
      setSaving(false);
    }
  }, [draft, profileId, saving, t, toast, reload]);

  const remove = useCallback(
    async (contact: Contact) => {
      const ok = await confirm({
        title: t('contacts.deleteTitle', { name: contact.label }),
        message: t('contacts.deleteMessage'),
        confirmLabel: t('common.remove'),
        destructive: true,
      });
      if (!ok) return;
      await deleteContact(contact.id);
      toast.show({ message: t('contacts.removed'), variant: 'success' });
      setDraft(null);
      reload();
    },
    [confirm, t, toast, reload],
  );

  const moveUp = useCallback(
    async (index: number) => {
      const list = data;
      if (!profileId || !list || index <= 0) return;
      const next = [...list];
      const above = next[index - 1];
      const current = next[index];
      if (!above || !current) return;
      next[index - 1] = current;
      next[index] = above;
      // Rewritten as one ordered list rather than swapping two rows, so a crash cannot
      // leave two contacts sharing a position.
      await reorderContacts(
        profileId,
        next.map((contact) => contact.id),
      );
      reload();
    },
    [data, profileId, reload],
  );

  const call = useCallback(
    async (phone: string) => {
      const ok = await Linking.canOpenURL(`tel:${phone}`);
      if (!ok) {
        toast.show({ message: t('contacts.cannotCall'), variant: 'error' });
        return;
      }
      await Linking.openURL(`tel:${phone}`);
    },
    [toast, t],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Contact; index: number }) => (
      <View style={{ height: ROW_HEIGHT, justifyContent: 'center' }}>
        <ListRow
          title={item.label}
          subtitle={item.role ?? undefined}
          meta={item.phone ?? undefined}
          onPress={() =>
            setDraft({
              id: item.id,
              label: item.label,
              role: item.role ?? '',
              phone: item.phone ?? '',
              address: item.address ?? '',
            })
          }
          trailing={
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {/* No icon on "Move up": the icon set has no upward glyph, and a
                  repurposed chevron pointing the wrong way is worse than the plain word. */}
              {index > 0 ? (
                <Button
                  title={t('contacts.moveUp')}
                  onPress={() => void moveUp(index)}
                  variant="ghost"
                  size="md"
                />
              ) : null}
              {item.phone ? (
                <Button
                  title={t('contacts.call')}
                  onPress={() => void call(item.phone ?? '')}
                  variant="secondary"
                  size="md"
                />
              ) : null}
            </View>
          }
          showChevron={false}
        />
      </View>
    ),
    [t, moveUp, call],
  );

  return (
    <Screen
      variant="fixed"
      background="bg"
      footer={
        <Button
          title={t('contacts.add')}
          onPress={() => {
            setNameError(undefined);
            setDraft(EMPTY_DRAFT);
          }}
          size="lg"
          fullWidth
          icon="plus"
          disabled={!profileId}
        />
      }
    >
      <ScreenHeader
        title={t('contacts.title')}
        subtitle={t('contacts.subtitle')}
        onBack={() => router.back()}
      />

      {loading ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={ROW_HEIGHT} />
          <Skeleton height={ROW_HEIGHT} />
        </View>
      ) : data && data.length > 0 ? (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ItemSeparatorComponent={Divider}
          getItemLayout={itemLayout}
          persistentScrollbar
        />
      ) : (
        <EmptyState title={t('contacts.empty')} message={t('contacts.emptyMessage')} />
      )}

      <Dialog
        visible={draft !== null}
        title={draft?.id ? t('contacts.editTitle') : t('contacts.addTitle')}
        onRequestClose={() => setDraft(null)}
        dismissOnBackdrop={false}
        footer={
          <View style={{ gap: spacing.md }}>
            <Button
              title={t('common.cancel')}
              onPress={() => setDraft(null)}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={saving}
            />
            <Button
              title={t('common.save')}
              onPress={() => void save()}
              size="lg"
              fullWidth
              loading={saving}
            />
          </View>
        }
      >
        {draft ? (
          <View style={{ gap: spacing.lg }}>
            <TextField
              label={t('contacts.name')}
              placeholder={t('contacts.namePlaceholder')}
              value={draft.label}
              onChangeText={(label) => {
                setNameError(undefined);
                setDraft({ ...draft, label });
              }}
              required
              error={nameError}
            />
            <TextField
              label={t('contacts.role')}
              placeholder={t('contacts.rolePlaceholder')}
              value={draft.role}
              onChangeText={(role) => setDraft({ ...draft, role })}
            />
            <TextField
              label={t('contacts.phone')}
              value={draft.phone}
              onChangeText={(phone) => setDraft({ ...draft, phone })}
              keyboardType="phone-pad"
              helper={t('common.optional')}
            />
            <TextField
              label={t('contacts.address')}
              value={draft.address}
              onChangeText={(address) => setDraft({ ...draft, address })}
              multiline
              helper={t('common.optional')}
            />
            {draft.id ? (
              <>
                <Divider />
                <Button
                  title={t('common.remove')}
                  onPress={() => {
                    const existing = data?.find((contact) => contact.id === draft.id);
                    if (existing) void remove(existing);
                  }}
                  variant="destructive"
                  size="md"
                  fullWidth
                />
              </>
            ) : null}
          </View>
        ) : (
          <Text variant="body">{t('common.loading')}</Text>
        )}
      </Dialog>
    </Screen>
  );
}
