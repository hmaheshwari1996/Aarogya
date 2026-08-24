/**
 * Settings.
 *
 * BIGGER TEXT IS THE FIRST ROW, deliberately. For this user large text is not an
 * accessibility extra parked at the bottom of a list — it is the difference between
 * reading her own blood pressure and hunting for her glasses. Anything she needs every
 * day comes before anything she needs once.
 *
 * PRESCRIPTION SCANNING IS A NORMAL ROW NOW. It used to be reachable only by tapping the
 * version number seven times on About. That hid it from the one person who needs it — the
 * family member who set the phone up, pasted a key once during setup, and later has to
 * replace it because it was revoked, or remove it because he would rather no photograph
 * ever left the phone. A gesture nobody can be told about is not a setting. The row sits
 * under "Sharing and safety" because that is what it decides: whether a photograph of a
 * prescription may leave this phone at all. It states whether a key is saved, and the
 * screen behind it explains in words what removing one does and does not stop.
 *
 * There is no light/dark switch. The phone already has one, it already works, and every
 * setting this screen does not have is a setting she cannot get lost in.
 *
 * ─── THE DEVELOPER SWITCH IS LAST, AND IT IS A REAL SETTING ──────────────────
 * It sits below About, at the very bottom, because it is the one row on this screen that
 * is not for her. It is for the person who set the phone up and now has to work out why
 * something is failing on a handset he is holding for ten minutes. It is off, it stays
 * off until somebody deliberately turns it on, and while it is off nothing is written
 * down at all — see `features/devlog`.
 *
 * Turning it OFF deletes what was recorded, and the row says so before it does it. That
 * is not tidiness: this app's entire premise is that a record of her health lives on one
 * phone and nowhere else, and a diagnostic log is a second, quieter record of the same
 * phone. "Nothing is stored unless you ask for it" has to survive being switched back off
 * or it only ever meant "nothing new".
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Switch, View } from 'react-native';
import { router } from 'expo-router';

import {
  BUILTIN_SLOT_KEYS,
  resolveSlots,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import {
  Button,
  Card,
  Chip,
  Dialog,
  Divider,
  ListRow,
  PressableScale,
  ROW_DIVIDER_INSET,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  TextField,
  useConfirm,
  useToast,
} from '@/components/ui';
import { materialiseMetricsForPack } from '@/db/repositories/metrics';
import { hasKey } from '@/features/ai/keyStore';
import {
  devLogStats,
  initDevLog,
  isDevLogEnabled,
  setDevLogEnabled,
} from '@/features/devlog';
import {
  disableCondition,
  enableCondition,
  getProfile,
  listConditionPacks,
  listProfileConditions,
  updateProfile,
  type ConditionPack,
} from '@/db/repositories/profiles';
import { useI18n } from '@/i18n';
import { toLocalDate } from '@/lib/datetime';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import type { Profile } from '@/types';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

const SEXES: readonly NonNullable<Profile['sex']>[] = ['female', 'male', 'other', 'unstated'];

const EARLIEST_BIRTH_YEAR = 1900;

/**
 * Where the papers live.
 *
 * ONE constant, because the name of this route is the only thing about the row that could
 * ever move. `src/app/briefcase/index.tsx` is the screen; the older `/documents` list is
 * the read-only ancestor it replaces. If those are ever merged, this is the single line
 * that changes and the row stays exactly as written.
 */
const BRIEFCASE_ROUTE = '/briefcase';

const STRINGS: LocalStrings = {
  'settings.slotTimes': { en: 'Medicine times of day', hi: 'दवाई के समय' },
  // This row used to name the four slots outright — "Morning, midday, evening and
  // bedtime". There are nine now, plus any she has invented, and naming them all would be
  // a paragraph under a one-line row while naming four of nine would be a lie. So it
  // counts them, and the count is read from the same registry the slots screen writes:
  // invent a tenth and this row says ten, without anybody remembering to come back here.
  //
  // No singular counterpart, unlike every other counted string in the app: there are nine
  // built-in slots and none of them can be removed, so the count is nine or more and "1
  // time of day" is a sentence this row can never say. A key that cannot be reached is a
  // key that gets translated wrong and nobody finds out.
  'settings.slotTimesHelp': { en: '{{count}} times of day', hi: 'दिन के {{count}} समय' },
  'settings.conditions': {
    en: 'What you are being treated for',
    hi: 'आपका इलाज किस चीज़ का चल रहा है',
  },
  'settings.conditionsHelp': {
    en: 'Switching one on adds the readings, symptoms and tests that go with it. Switching it off keeps everything you have already recorded.',
    hi: 'किसी को चालू करने पर उससे जुड़ी माप, तकलीफ़ें और जाँचें जुड़ जाती हैं। बंद करने पर भी आपका पहले का लिखा सब कुछ बना रहता है।',
  },
  'settings.targets': { en: 'Target ranges from your doctor', hi: 'डॉक्टर के दिए हुए दायरे' },
  'settings.targetsHelp': {
    en: 'Only the numbers a doctor gave you',
    hi: 'सिर्फ़ वे अंक जो डॉक्टर ने दिए हैं',
  },
  'settings.security': { en: 'Lock the app', hi: 'ऐप पर ताला' },
  'settings.securityHelp': {
    en: 'Ask for a fingerprint before opening',
    hi: 'खोलने से पहले फिंगरप्रिंट माँगें',
  },
  'settings.healthCheckHelp': {
    en: 'Check that your medicine reminders can reach you',
    hi: 'जाँचें कि दवाई के रिमाइंडर आप तक पहुँच पा रहे हैं',
  },
  'settings.backupHelp': { en: 'Save a copy of everything', hi: 'सब कुछ की एक कॉपी रखें' },
  'settings.viewersHelp': {
    en: 'Family members you have allowed to see this',
    hi: 'परिवार के वे लोग जिन्हें आपने देखने की इजाज़त दी है',
  },
  'settings.emergencyCardHelp': {
    en: 'What a stranger can see if you need help',
    hi: 'मदद की ज़रूरत पड़ने पर कोई अजनबी क्या देख सकता है',
  },
  'settings.aiScanning': { en: 'Prescription scanning (AI)', hi: 'नुस्खा पढ़ना (AI)' },
  'settings.aiScanningOn': {
    en: 'On — a prescription photo can fill the medicine list in',
    hi: 'चालू — नुस्खे की तस्वीर से दवाइयों की सूची भर सकती है',
  },
  'settings.aiScanningOff': {
    en: 'Off — medicines are added by hand',
    hi: 'बंद — दवाइयाँ हाथ से जोड़ी जाती हैं',
  },
  'settings.sectionYou': { en: 'Your record', hi: 'आपका रिकॉर्ड' },
  'settings.sectionSafety': { en: 'Sharing and safety', hi: 'साझा करना और सुरक्षा' },

  // Word for word the title of the screen it opens. A row that says one thing and lands
  // on a page called another is how somebody decides they tapped the wrong row.
  'settings.briefcase': { en: 'Briefcase', hi: 'काग़ज़ों का बस्ता' },
  'settings.briefcaseHelp': {
    en: 'Discharge summaries, insurance papers and health cards',
    hi: 'डिस्चार्ज सारांश, बीमा के काग़ज़ और हेल्थ कार्ड',
  },

  // ─── The developer switch, in her son's words and hers ────────────────────
  //
  // Two audiences read this row. He needs to know exactly what it does; she needs to be
  // able to read it and decide it is not for her without any worry attached. So the title
  // is plain, the subtitle states the one fact that matters in each state, and neither
  // sentence pretends the feature is more interesting than it is.
  'settings.sectionDeveloper': { en: 'For whoever set this up', hi: 'जिसने यह फ़ोन तैयार किया, उसके लिए' },
  'settings.developer': { en: 'Keep technical notes', hi: 'तकनीकी नोट रखें' },
  'settings.developerOff': {
    en: 'Off. Nothing about how the app is working is written down.',
    hi: 'बंद। ऐप कैसे चल रहा है, इसका कुछ भी नहीं लिखा जाता।',
  },
  'settings.developerOn': {
    en: 'On. Aarogya is noting how each step goes, so a fault can be looked at on this phone.',
    hi: 'चालू। आरोग्य हर चरण का हाल नोट कर रहा है, ताकि किसी गड़बड़ी को इसी फ़ोन पर देखा जा सके।',
  },
  'settings.developerOptions': { en: 'Developer Options', hi: 'डेवलपर विकल्प' },
  'settings.developerOptionsHelp': {
    en: 'See the notes, and delete them',
    hi: 'नोट देखें, और मिटाएँ',
  },
  'settings.developerOffTitle': { en: 'Stop keeping notes?', hi: 'क्या नोट रखना बंद कर दें?' },
  'settings.developerOffMessage': {
    en: 'The {{count}} notes recorded so far are deleted as well. Nothing else on this phone is touched.',
    hi: 'अब तक के {{count}} नोट भी मिट जाएँगे। फ़ोन में और कुछ नहीं छुआ जाएगा।',
  },
  'settings.developerOffConfirm': { en: 'Turn Off And Delete', hi: 'बंद करें और मिटाएँ' },
  'settings.developerFailed': {
    en: 'That switch could not be changed.',
    hi: 'वह स्विच बदला नहीं जा सका।',
  },

  'profile.name': { en: 'Name', hi: 'नाम' },
  'profile.yearOfBirth': { en: 'Year of birth', hi: 'जन्म का साल' },
  'profile.yearHelper': { en: 'Four digits, like 1958', hi: 'चार अंक, जैसे 1958' },
  'profile.sex': { en: 'Sex', hi: 'लिंग' },
  'profile.sex.female': { en: 'Woman', hi: 'महिला' },
  'profile.sex.male': { en: 'Man', hi: 'पुरुष' },
  'profile.sex.other': { en: 'Other', hi: 'अन्य' },
  'profile.sex.unstated': { en: 'Would rather not say', hi: 'नहीं बताना चाहतीं' },
  'profile.bloodGroup': { en: 'Blood group', hi: 'ब्लड ग्रुप' },
  'profile.nameRequired': { en: 'Please write a name.', hi: 'कृपया नाम लिखें।' },
  'profile.yearInvalid': {
    en: 'Please write a four-digit year, like 1958.',
    hi: 'कृपया चार अंकों का साल लिखें, जैसे 1958।',
  },
  'profile.saveFailed': { en: 'Could not save what you changed.', hi: 'आपका बदलाव सहेजा नहीं जा सका।' },
  'conditions.saveFailed': { en: 'Could not change that.', hi: 'वह बदला नहीं जा सका।' },
};

export default function SettingsScreen() {
  const t = useT(STRINGS);
  const { isLargeText, setLargeText } = useTheme();
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const profileState = useProfileId();
  const profileId = profileState.data;

  const [profileOpen, setProfileOpen] = useState(false);
  const [conditionsOpen, setConditionsOpen] = useState(false);

  const details = useAsync(async () => {
    if (!profileId) return null;
    const [profile, packs, enabled] = await Promise.all([
      getProfile(profileId),
      listConditionPacks(),
      listProfileConditions(profileId),
    ]);
    const activePacks = new Set(
      enabled.filter((row) => row.endedOn === null).map((row) => row.packKey),
    );
    return { profile, packs, activePacks };
  }, [profileId]);

  const { reload } = details;
  useReloadOnFocus(reload);

  // Loaded on its own rather than folded into `details`, which returns null when there is
  // no profile yet. Whether a key is saved is true or false regardless, and the row must
  // never read "Off" merely because the profile has not loaded.
  const aiKey = useAsync(() => hasKey(), []);
  useReloadOnFocus(aiKey.reload);

  // How many times of day this profile has, built-in plus invented. Reloaded on focus
  // because the screen this row opens is exactly where the number changes.
  //
  // With no profile it answers with the built-in count rather than waiting: nine is what a
  // profile that does not exist yet would be created with, so it is the truth rather than
  // a guess, and the row never sits on "Loading…" forever on a device mid-setup.
  const slotCount = useAsync(
    async () => (profileId ? (await resolveSlots(profileId)).length : BUILTIN_SLOT_KEYS.length),
    [profileId],
  );
  useReloadOnFocus(slotCount.reload);

  /**
   * Whether technical notes are being kept.
   *
   * `isDevLogEnabled()` reads a module-level mirror — synchronous, and the same value the
   * recorder itself checks before building a message, so this row can never say "on"
   * while nothing is being recorded.
   *
   * `initDevLog()` is what fills that mirror from the stored preference. It belongs in the
   * boot sequence and is idempotent, so calling it here is not a second mechanism: it is
   * this screen refusing to render a switch whose position it has not established. Until
   * it is wired at boot, a scan started before Settings was ever opened records nothing —
   * which is the fail-closed direction, and is reported rather than worked around here.
   */
  const devLog = useAsync(async () => {
    await initDevLog();
    return isDevLogEnabled();
  }, []);
  const { reload: reloadDevLog } = devLog;
  useReloadOnFocus(reloadDevLog);
  const developerOn = devLog.data ?? false;

  const toggleDeveloper = useCallback(
    async (next: boolean) => {
      // Turning it off deletes the notes. She is told the number before it happens, and
      // only when there is a number to lose — a confirmation over an empty log is a
      // question with one answer, which is how people learn to tap through them.
      if (!next && devLogStats().count > 0) {
        const ok = await confirm({
          title: t('settings.developerOffTitle'),
          message: t('settings.developerOffMessage', { count: devLogStats().count }),
          confirmLabel: t('settings.developerOffConfirm'),
          destructive: true,
        });
        if (!ok) return;
      }
      try {
        await setDevLogEnabled(next);
      } catch {
        toast.show({ message: t('settings.developerFailed'), variant: 'error' });
      }
      reloadDevLog();
    },
    [confirm, reloadDevLog, t, toast],
  );

  const packLabel = useCallback(
    (pack: ConditionPack) => (lang === 'hi' ? pack.labelHi : pack.labelEn),
    [lang],
  );

  const togglePack = useCallback(
    async (pack: ConditionPack, next: boolean) => {
      if (!profileId) return;
      const today = toLocalDate();
      try {
        if (next) {
          await enableCondition(profileId, pack.key, today);
          // Enabling a pack must also materialise its metrics, or the condition is on
          // and nothing new appears anywhere — which reads as the switch not working.
          await materialiseMetricsForPack(profileId, pack.key);
        } else {
          await disableCondition(profileId, pack.key, today);
        }
        reload();
      } catch (error) {
        console.warn('[settings] could not change a condition pack', error);
        toast.show({ message: t('conditions.saveFailed'), variant: 'error' });
      }
    },
    [profileId, reload, t, toast],
  );

  const profile = details.data?.profile ?? null;
  // Memoised because the `?? []` / `?? new Set()` fallbacks allocate a fresh empty value
  // on every render, which would give `activePackNames` below a new dependency each time.
  const packs = useMemo(() => details.data?.packs ?? [], [details.data]);
  const activePacks = useMemo(() => details.data?.activePacks ?? new Set<string>(), [details.data]);

  const activePackNames = useMemo(
    () =>
      packs
        .filter((pack) => activePacks.has(pack.key))
        .map(packLabel)
        .join(', '),
    [packs, activePacks, packLabel],
  );

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('settings.title')} onBack={() => router.back()} />

      <View style={{ gap: spacing.md }}>
        <Card>
          {/* First row, always. See the file header. */}
          <ToggleRow
            title={t('settings.largeText')}
            subtitle={t('settings.largeTextHelp')}
            value={isLargeText}
            onChange={setLargeText}
          />
          <Divider inset={ROW_DIVIDER_INSET} />
          <ListRow
            title={t('settings.language')}
            subtitle={lang === 'hi' ? t('settings.languageHindi') : t('settings.languageEnglish')}
            onPress={() => router.push('/settings/language')}
          />
        </Card>

        <SectionHeader title={t('settings.remindersSection')} />
        <Card>
          <ListRow
            title={t('settings.healthCheck')}
            subtitle={t('settings.healthCheckHelp')}
            onPress={() => router.push('/reminder-health')}
          />
          <Divider inset={ROW_DIVIDER_INSET} />
          {/* Like the AI row below, the subtitle waits for the real answer rather than
              guessing a number that would be wrong for anyone who has added a slot. */}
          <ListRow
            title={t('settings.slotTimes')}
            subtitle={
              slotCount.data === null
                ? t('common.loading')
                : t('settings.slotTimesHelp', { count: slotCount.data })
            }
            onPress={() => router.push('/settings/slots')}
          />
        </Card>

        <SectionHeader title={t('settings.sectionYou')} />
        <Card>
          {details.loading && !details.data ? (
            <Skeleton height={64} label={t('a11y.loading')} />
          ) : (
            <>
              <ListRow
                title={t('settings.profile')}
                subtitle={profile?.displayName ?? t('common.unknown')}
                onPress={() => setProfileOpen(true)}
                accessibilityHint={t('a11y.opensDialog')}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ListRow
                title={t('settings.conditions')}
                subtitle={activePackNames === '' ? t('common.none') : activePackNames}
                onPress={() => setConditionsOpen(true)}
                accessibilityHint={t('a11y.opensDialog')}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ListRow
                title={t('settings.targets')}
                subtitle={t('settings.targetsHelp')}
                onPress={() => router.push('/settings/targets')}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              <ListRow
                title={t('settings.emergencyCard')}
                subtitle={t('settings.emergencyCardHelp')}
                onPress={() => router.push('/settings/emergency-card')}
              />
              <Divider inset={ROW_DIVIDER_INSET} />
              {/* Her papers are part of her record, not part of sharing: nothing here
                  leaves the phone by existing. The row is a second door onto the same
                  screen the More tab opens — Settings is where somebody looks for
                  "where did I put that card", and one route means one screen to keep
                  right. */}
              <ListRow
                title={t('settings.briefcase')}
                subtitle={t('settings.briefcaseHelp')}
                onPress={() => router.push(BRIEFCASE_ROUTE)}
              />
            </>
          )}
        </Card>

        <SectionHeader title={t('settings.sectionSafety')} />
        <Card>
          <ListRow
            title={t('settings.viewers')}
            subtitle={t('settings.viewersHelp')}
            onPress={() => router.push('/settings/viewers')}
          />
          <Divider inset={ROW_DIVIDER_INSET} />
          <ListRow
            title={t('settings.security')}
            subtitle={t('settings.securityHelp')}
            onPress={() => router.push('/settings/security')}
          />
          <Divider inset={ROW_DIVIDER_INSET} />
          <ListRow
            title={t('settings.backup')}
            subtitle={t('settings.backupHelp')}
            onPress={() => router.push('/backup')}
          />
          <Divider inset={ROW_DIVIDER_INSET} />
          {/* The subtitle waits for the real answer rather than guessing "Off" — this row
              is the only place the phone tells anyone whether a prescription photograph
              can leave it. */}
          <ListRow
            title={t('settings.aiScanning')}
            subtitle={
              aiKey.data === null
                ? t('common.loading')
                : aiKey.data
                  ? t('settings.aiScanningOn')
                  : t('settings.aiScanningOff')
            }
            onPress={() => router.push('/settings/ai')}
          />
        </Card>

        <Card>
          <ListRow title={t('settings.about')} onPress={() => router.push('/settings/about')} />
        </Card>

        {/*
          LAST, AND ONE ROW DEEPER WHEN IT IS ON.

          The switch is what she reported wanting: turn it on, and exactly one extra menu
          appears underneath it. Off, this card is a single row that explains itself in
          one line and leads nowhere — nothing to get lost in, nothing being written down.

          The subtitle carries the state in words, not only in the switch position: at
          1.3× text with a tremor, "Off. Nothing … is written down." is readable from
          across the room in a way that a 40dp toggle is not, and colour and position are
          never the only signal in this app.
        */}
        <SectionHeader title={t('settings.sectionDeveloper')} />
        <Card>
          <ToggleRow
            title={t('settings.developer')}
            subtitle={developerOn ? t('settings.developerOn') : t('settings.developerOff')}
            value={developerOn}
            onChange={(next) => void toggleDeveloper(next)}
            disabled={devLog.loading && devLog.data === null}
          />
          {developerOn ? (
            <>
              <Divider inset={ROW_DIVIDER_INSET} />
              <ListRow
                title={t('settings.developerOptions')}
                subtitle={t('settings.developerOptionsHelp')}
                onPress={() => router.push('/settings/developer')}
              />
            </>
          ) : null}
        </Card>

        <Text variant="caption" tone="muted">
          {t('settings.appearance')}
        </Text>
      </View>

      <ProfileDialog
        visible={profileOpen}
        profile={profile}
        onClose={() => setProfileOpen(false)}
        onSaved={() => {
          setProfileOpen(false);
          reload();
        }}
      />

      <Dialog
        visible={conditionsOpen}
        title={t('settings.conditions')}
        message={t('settings.conditionsHelp')}
        onRequestClose={() => setConditionsOpen(false)}
        footer={
          <Button
            title={t('common.done')}
            onPress={() => setConditionsOpen(false)}
            size="lg"
            fullWidth
          />
        }
      >
        <View>
          {packs.map((pack, index) => (
            <View key={pack.key}>
              {index > 0 ? <Divider /> : null}
              <ToggleRow
                title={packLabel(pack)}
                value={activePacks.has(pack.key)}
                onChange={(next) => void togglePack(pack, next)}
              />
            </View>
          ))}
        </View>
      </Dialog>
    </Screen>
  );
}

// ── About you ────────────────────────────────────────────────────────────────

function ProfileDialog({
  visible,
  profile,
  onClose,
  onSaved,
}: {
  visible: boolean;
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(STRINGS);
  const toast = useToast();

  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [sex, setSex] = useState<Profile['sex']>(null);
  const [bloodGroup, setBloodGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The dialog is mounted permanently, so its fields are seeded from the profile the
  // first time it becomes visible rather than in an effect on every render.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  if (visible && profile && seededFor !== profile.id) {
    setSeededFor(profile.id);
    setName(profile.displayName);
    setYear(profile.yearOfBirth === null ? '' : String(profile.yearOfBirth));
    setSex(profile.sex);
    setBloodGroup(profile.bloodGroup);
    setError(null);
  }

  const save = useCallback(async () => {
    if (!profile || saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('profile.nameRequired'));
      return;
    }
    let yearOfBirth: number | null = null;
    if (year.trim() !== '') {
      const parsed = Number(year.trim());
      const thisYear = new Date().getFullYear();
      if (!Number.isInteger(parsed) || parsed < EARLIEST_BIRTH_YEAR || parsed > thisYear) {
        setError(t('profile.yearInvalid'));
        return;
      }
      yearOfBirth = parsed;
    }

    setSaving(true);
    try {
      await updateProfile(profile.id, {
        displayName: trimmedName,
        yearOfBirth,
        sex,
        bloodGroup,
      });
      toast.show({ message: t('common.saved'), variant: 'success' });
      setSeededFor(null);
      onSaved();
    } catch (e) {
      console.warn('[settings] could not save the profile', e);
      toast.show({ message: t('profile.saveFailed'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [profile, saving, name, year, sex, bloodGroup, t, toast, onSaved]);

  return (
    <Dialog
      visible={visible}
      title={t('settings.profile')}
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
          label={t('profile.name')}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          required
        />
        <TextField
          label={t('profile.yearOfBirth')}
          helper={t('profile.yearHelper')}
          value={year}
          onChangeText={setYear}
          keyboardType="number-pad"
          maxLength={4}
        />

        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('profile.sex')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {SEXES.map((option) => (
              <Chip
                key={option}
                label={t(`profile.sex.${option}`)}
                selected={sex === option}
                onPress={() => setSex(sex === option ? null : option)}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="label">{t('profile.bloodGroup')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {BLOOD_GROUPS.map((group) => (
              <Chip
                key={group}
                label={group}
                selected={bloodGroup === group}
                onPress={() => setBloodGroup(bloodGroup === group ? null : group)}
              />
            ))}
          </View>
        </View>

        {error ? (
          <Text variant="body" tone="destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

// ── A row that is a switch ───────────────────────────────────────────────────

/**
 * The whole row toggles, not just the 40dp switch at its right edge.
 *
 * The switch itself is hidden from TalkBack and from touch: the row is one control with
 * one label and one state, which is both a bigger target for a shaking hand and one
 * swipe rather than two for a screen-reader user.
 */
function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  disabled = false,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <PressableScale
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityState={{ checked: value, disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: spacing.touchTarget,
        paddingVertical: spacing.md,
        opacity: disabled ? 0.55 : 1,
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
          disabled={disabled}
          trackColor={{ false: colors.border, true: colors.primarySoft }}
          thumbColor={value ? colors.primary : colors.borderStrong}
        />
      </View>
    </PressableScale>
  );
}
