/**
 * More — everything that is not a daily action.
 *
 * ─── WHY IT IS GROUPED NOW ───────────────────────────────────────────────────
 * This was one undifferentiated column of eight rows. That is the worst shape for the
 * job this screen actually does: she arrives here looking for ONE specific thing she was
 * told about — "the emergency card", "send the report to the doctor" — and an unbroken
 * list gives the eye nothing to aim at, so it is read top to bottom, every time.
 *
 * Three groups with headings turn that into two decisions instead of eight: which group,
 * then which row. The headings carry `accessibilityRole="header"`, so a TalkBack user
 * gets the same shortcut — one gesture per group rather than a swipe per row.
 *
 * Every row is still the whole width, at least 56dp tall, and says what it is in words.
 * There are still no leading icons: the shared set is navigational and holds no mark
 * that means "backup" or "contacts", and a borrowed glyph is one more thing to decode.
 *
 * ─── AND WHY IT IS NO LONGER A FlatList ──────────────────────────────────────
 * Eleven elements. Virtualisation buys nothing at that size, and the exact
 * `getItemLayout` that made the flat version cheap cannot describe a list whose rows and
 * headings are different heights — it would have been a lie the scrollbar believed.
 */

import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { spacing } from '@/theme';
import { Card, Divider, ListRow, ROW_DIVIDER_INSET, Screen, SectionHeader, Text } from '@/components/ui';

import { useT, type LocalStrings } from '../_shared/lib';

const STRINGS: LocalStrings = {
  'more.title': { en: 'More', hi: 'और' },
  'more.sectionDoctor': { en: "For a doctor's visit", hi: 'डॉक्टर की मुलाक़ात के लिए' },
  'more.sectionPeople': { en: 'People', hi: 'लोग' },
  'more.sectionPhone': { en: 'This phone', hi: 'यह फ़ोन' },
  'more.reports': { en: 'Reports for the doctor', hi: 'डॉक्टर के लिए रिपोर्ट' },
  'more.reportsSub': {
    en: 'Make a printable summary for a visit',
    hi: 'मुलाक़ात के लिए छापने लायक सार बनाइए',
  },
  'more.backup': { en: 'Backup', hi: 'बैकअप' },
  'more.backupSub': {
    en: 'Save a copy of everything, or bring one back',
    hi: 'सब कुछ की एक नक़ल रखिए, या वापस लाइए',
  },
  /**
   * Named for the screen it opens, which is the briefcase.
   *
   * It said "Documents" and opened `/documents` — an older read-only list over the SAME
   * `document` rows with no way to add anything to it. That was the shape of report 6: a
   * place papers appear and no door to put one through. Both screens ran the identical
   * `listDocuments(profileId)` with no filter, so nothing is hidden by sending this row to
   * the briefcase; everything that was on the old list is on the new one, plus the add,
   * rename, open and remove controls, plus the banner saying the files live only on this
   * phone. The wording matches the Settings row and the screen's own title deliberately —
   * one feature must not look like two.
   */
  'more.documents': { en: 'Briefcase', hi: 'काग़ज़ों का बस्ता' },
  'more.symptoms': { en: 'How I Felt', hi: 'मैंने कैसा महसूस किया' },
  'more.symptomsSub': {
    en: 'Everything you recorded feeling — remove a wrong entry',
    hi: 'आपने जो महसूस करना दर्ज किया — ग़लत बात हटाइए',
  },
  'more.documentsSub': {
    en: 'Discharge summaries, insurance papers, health cards — kept together',
    hi: 'डिस्चार्ज सारांश, बीमा के काग़ज़, हेल्थ कार्ड — सब एक साथ',
  },
  'more.contacts': { en: 'Contacts', hi: 'सम्पर्क' },
  'more.contactsSub': { en: 'Doctors, clinic and family', hi: 'डॉक्टर, क्लिनिक और परिवार' },
  'more.emergency': { en: 'Emergency card', hi: 'आपातकालीन कार्ड' },
  'more.emergencySub': {
    en: 'Choose line by line what a stranger may see',
    hi: 'एक-एक पंक्ति चुनिए जो कोई अजनबी देख सके',
  },
  'more.viewers': { en: 'Family who can see this', hi: 'परिवार जो यह देख सकता है' },
  'more.viewersSub': { en: 'You allow each person yourself', hi: 'हर व्यक्ति को आप ख़ुद इजाज़त देती हैं' },
  'more.patients': { en: 'Patients', hi: 'मरीज़' },
  'more.patientsSub': {
    en: 'Add, switch, rename or archive a patient',
    hi: 'मरीज़ जोड़ें, बदलें, नाम बदलें या संग्रह करें',
  },
  'more.settings': { en: 'Settings', hi: 'सेटिंग' },
  'more.settingsSub': { en: 'Bigger text, language, reminders', hi: 'बड़ा अक्षर, भाषा, याद दिलाना' },
  'more.about': { en: 'About Aarogya', hi: 'आरोग्य के बारे में' },
  'more.aboutSub': { en: 'Version and what this app is', hi: 'संस्करण और यह ऐप क्या है' },
  'more.privacy': {
    en: 'Everything you record stays on this phone unless you send it yourself.',
    hi: 'आपका दर्ज किया हुआ सब कुछ इसी फ़ोन में रहता है, जब तक आप ख़ुद न भेजें।',
  },
};

type MoreItem = {
  key: string;
  titleKey: string;
  subtitleKey: string;
  href: string;
};

type MoreSection = {
  key: string;
  titleKey: string;
  items: readonly MoreItem[];
};

/**
 * Grouped by the ERRAND, not by the part of the app the screen happens to live in.
 * "Documents" sits with "Reports" because both are what she reaches for the morning of
 * an appointment; "Backup" sits with "Settings" because both are housekeeping she does
 * once and forgets.
 */
const SECTIONS: readonly MoreSection[] = [
  {
    key: 'doctor',
    titleKey: 'more.sectionDoctor',
    items: [
      {
        key: 'reports',
        titleKey: 'more.reports',
        subtitleKey: 'more.reportsSub',
        href: '/report/range',
      },
      {
        key: 'documents',
        titleKey: 'more.documents',
        subtitleKey: 'more.documentsSub',
        href: '/briefcase',
      },
      {
        key: 'symptoms',
        titleKey: 'more.symptoms',
        subtitleKey: 'more.symptomsSub',
        href: '/symptoms',
      },
    ],
  },
  {
    key: 'people',
    titleKey: 'more.sectionPeople',
    items: [
      {
        key: 'contacts',
        titleKey: 'more.contacts',
        subtitleKey: 'more.contactsSub',
        href: '/contacts',
      },
      {
        key: 'emergency',
        titleKey: 'more.emergency',
        subtitleKey: 'more.emergencySub',
        href: '/settings/emergency-card',
      },
      {
        key: 'viewers',
        titleKey: 'more.viewers',
        subtitleKey: 'more.viewersSub',
        href: '/settings/viewers',
      },
    ],
  },
  {
    key: 'phone',
    titleKey: 'more.sectionPhone',
    items: [
      {
        key: 'patients',
        titleKey: 'more.patients',
        subtitleKey: 'more.patientsSub',
        href: '/profiles',
      },
      {
        key: 'settings',
        titleKey: 'more.settings',
        subtitleKey: 'more.settingsSub',
        href: '/settings',
      },
      { key: 'backup', titleKey: 'more.backup', subtitleKey: 'more.backupSub', href: '/backup' },
      { key: 'about', titleKey: 'more.about', subtitleKey: 'more.aboutSub', href: '/settings/about' },
    ],
  },
];

export default function MoreScreen() {
  const t = useT(STRINGS);

  return (
    <Screen variant="scroll" background="bgSunken">
      <View style={{ paddingTop: spacing.md }}>
        <Text variant="title" accessibilityRole="header">
          {t('more.title')}
        </Text>
      </View>

      {SECTIONS.map((section) => (
        <View key={section.key}>
          <SectionHeader title={t(section.titleKey)} />
          {/* The rows own their horizontal padding so the divider can be inset to the
              text, which is what makes a group read as one block rather than as three
              stacked bars. */}
          <Card padding={0}>
            {section.items.map((item, index) => (
              <View key={item.key}>
                {index > 0 ? <Divider inset={ROW_DIVIDER_INSET} /> : null}
                <ListRow
                  title={t(item.titleKey)}
                  subtitle={t(item.subtitleKey)}
                  onPress={() => router.push(item.href)}
                  style={{ paddingHorizontal: spacing.lg }}
                />
              </View>
            ))}
          </Card>
        </View>
      ))}

      <View style={{ paddingTop: spacing.xl }}>
        <Text variant="caption" tone="muted">
          {t('more.privacy')}
        </Text>
      </View>
    </Screen>
  );
}
