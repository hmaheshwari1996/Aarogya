/**
 * Family sharing for ONE patient — the owner's control room, and the plain view a
 * manager or viewer sees of their own place in the circle.
 *
 * ─── ONE PROFILE, ONE CIRCLE (design §1, LOCKED) ──────────────────────────────
 * Sharing is per PATIENT, not per phone. This phone can be the Owner of Mother and a
 * Manager of Grandmother at the same time, so everything on this screen is scoped to the
 * one `profileId` in the route, and the role shown is THIS device's role for THIS patient.
 *
 * ─── WHAT EACH ROLE SEES, AND WHY THE OWNER SEES MORE ─────────────────────────
 * Owner  — invite people, approve or deny who asked to join BY THE NAME OF THEIR PHONE,
 *          see everyone with their role, change a role, remove someone, hand the whole
 *          thing (including who the alarm rings on) to another phone.
 * Manager — sees the record and can add to it, but ONLY WHILE ONLINE (design §3.3): the
 *          relay is a blind postbox and cannot enforce a role, so a manager who is offline
 *          is view-only by this app's own rule, and the screen says so honestly rather
 *          than letting edits pile up in a queue that a second writer would then fight.
 * Viewer — sees the record. Nothing else.
 *
 * Only the Owner's phone RINGS a dose (the Kotlin alarm layer); managers and viewers get a
 * push and never a local alarm. Changing the owner is therefore also changing which phone
 * wakes up at 2 a.m. for a TB dose — which is why that action carries the loudest words on
 * the screen and does not complete until the new phone has taken over.
 *
 * ─── THE KEY IS NEVER IN THE INVITE ───────────────────────────────────────────
 * The invite carries the relay address and the owner's public key, never the profile key.
 * The key is wrapped to a specific phone's public key and released only when the owner
 * approves that phone by name. So the invite is not a house key the way the old link was:
 * a stray copy is worthless without the owner's tap. That is the whole reason this screen
 * has an approval step and the old `settings/viewers` screen did not.
 *
 * ─── EVERYTHING THIS SCREEN CALLS LIVES IN THE SYNC FEATURE, NOT HERE ─────────
 * This file renders and confirms; it makes no crypto and holds no key. The membership and
 * owner-handoff logic is `@/features/sync/membership` and `@/features/sync/owner`. If a
 * call here has no home there yet, that is a gap to fix in the contract, not a shape to
 * invent in the UI — see the reverse-contract note at the top of those imports.
 */

import React, { useCallback, useState } from 'react';
import { Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import {
  Banner,
  Button,
  Card,
  Chip,
  Icon,
  ListRow,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useAsync, useReloadOnFocus, useT, type LocalStrings } from '@/app/_shared/lib';
import { getProfile } from '@/db/repositories/profiles';
import { isSyncConfigured, testSyncConnection, getSyncConfig, type SyncRole } from '@/features/sync/config';

// ─────────────────────────────────────────────────────────────────────────────
// THE REVERSE CONTRACT — what this UI needs from the membership/owner API.
//
// These modules are built by the sync agents to FAMILY-SHARING-CONTRACT.md §6. The
// contract names the verbs (`mintInvite`, `listPendingRequests`, `approve`, `deny`,
// `changeRole`, `removeMember`, `changeOwner`, "local profile_member reads") but does not
// pin the READ-MODEL shapes this screen renders. The names and shapes imported here ARE
// that missing half of the contract, reported alongside the screen — they are not invented
// UI types to be reconciled later; they are the surface the membership agent must satisfy.
// If the built module disagrees, the fix is to align the two to one shape, not to fork it.
// ─────────────────────────────────────────────────────────────────────────────
import {
  getShareView,
  mintInvite,
  approve,
  deny,
  changeRole,
  removeMember,
  type ShareView,
  type MemberView,
  type JoinRequestView,
  type Invite,
} from '@/features/sync/membership';
import { changeOwner } from '@/features/sync/owner';

/** The real role union — defined in `merge.ts`, re-exported from `config.ts`. Aliased here so
 *  the screen reads in role terms, and so there is ONE definition, not a parallel UI copy. */
type Role = SyncRole;
/** Roles the owner can hand out (owner is not assignable — it is transferred, not granted). */
type GrantableRole = Exclude<SyncRole, 'owner'>;

const STRINGS: LocalStrings = {
  'sharing.circle.title': { en: 'Family Sharing', hi: 'परिवार साझा' },
  'sharing.circle.loading': { en: 'Opening sharing', hi: 'साझा खुल रहा है' },

  // Not set up on this phone yet.
  'sharing.circle.setupTitle': { en: 'Set Up Sharing First', hi: 'पहले साझा सेट करें' },
  'sharing.circle.setupBody': {
    en: 'To share {{name}} with family, this phone first needs a free sharing project. Set it up once in Settings, then come back here.',
    hi: '{{name}} को परिवार के साथ साझा करने के लिए, इस फ़ोन को पहले एक मुफ़्त साझा प्रोजेक्ट चाहिए। इसे Settings में एक बार सेट करें, फिर यहाँ लौटें।',
  },
  'sharing.circle.setupOpen': { en: 'Open Sharing Settings', hi: 'साझा सेटिंग खोलें' },

  // Role banners.
  // NOTE (hi): the second-person "आप ..." strings on this screen use gender-NEUTRAL polite
  // agreement (करते/सकते हैं), NOT the app-wide feminine convention. Everywhere else the
  // subject is the patient (a woman); here it is the reader — who per the design is often the
  // son (male) or father (male). "आप ... करते हैं" is the standard polite form for any reader.
  'sharing.role.ownerTitle': { en: 'You Look After {{name}} Here', hi: 'आप यहाँ {{name}} की देखभाल करते हैं' },
  'sharing.role.ownerBody': {
    en: 'This phone rings the reminders for {{name}}. People you add see the record; only you can invite, approve, or change who is in the circle.',
    hi: 'इस फ़ोन पर {{name}} की याद-दिलावट बजती है। आप जिन्हें जोड़ते हैं वे रिकॉर्ड देख सकते हैं; केवल आप ही किसी को बुला, स्वीकृत या बदल सकते हैं।',
  },
  'sharing.role.managerTitle': { en: 'You Help With {{name}}', hi: 'आप {{name}} में मदद करते हैं' },
  'sharing.role.viewerTitle': { en: 'You Can See {{name}}', hi: 'आप {{name}} को देख सकते हैं' },
  'sharing.role.viewerBody': {
    en: 'You can see {{name}}’s record. Only the owner and managers can make changes.',
    hi: 'आप {{name}} का रिकॉर्ड देख सकते हैं। केवल प्रभारी और प्रबंधक ही बदलाव कर सकते हैं।',
  },

  // Manager online/offline write state.
  'sharing.online.checking': { en: 'Checking your connection', hi: 'आपका कनेक्शन जाँचा जा रहा है' },
  'sharing.online.canWrite': {
    en: 'You are online, so you can add and update {{name}}’s records now.',
    hi: 'आप ऑनलाइन हैं, इसलिए अभी {{name}} के रिकॉर्ड जोड़ और बदल सकते हैं।',
  },
  'sharing.online.offlineTitle': { en: 'You Are Offline Right Now', hi: 'अभी आप ऑफ़लाइन हैं' },
  'sharing.online.offlineBody': {
    en: 'You can see {{name}}’s record. You can add changes for {{name}} when you are back online.',
    hi: 'आप {{name}} का रिकॉर्ड देख सकते हैं। {{name}} के लिए बदलाव आप वापस ऑनलाइन होने पर जोड़ सकते हैं।',
  },
  'sharing.reminderNote': {
    en: 'Reminders ring on the owner’s phone. Yours shows a notification only — it will not sound the alarm.',
    hi: 'याद-दिलावट प्रभारी के फ़ोन पर बजती है। आपके फ़ोन पर केवल सूचना दिखती है — अलार्म नहीं बजेगा।',
  },

  // Invite.
  'sharing.invite.title': { en: 'Add Someone', hi: 'किसी को जोड़ें' },
  'sharing.invite.body': {
    en: 'Send this invite to a family member. When they open it and ask to join, their phone appears below for you to approve by name.',
    hi: 'यह न्योता किसी परिजन को भेजें। जब वे इसे खोलकर जुड़ने के लिए कहेंगे, उनका फ़ोन नीचे दिखेगा जिसे आप नाम से स्वीकृत कर सकते हैं।',
  },
  'sharing.invite.make': { en: 'Create Invite', hi: 'न्योता बनाएँ' },
  'sharing.invite.codeLabel': { en: 'Invite', hi: 'न्योता' },
  'sharing.invite.codeHint': {
    en: 'This invite lets a phone ASK to join. Nobody can see {{name}}’s record until you approve their phone below.',
    hi: 'यह न्योता किसी फ़ोन को जुड़ने के लिए कहने देता है। जब तक आप उनका फ़ोन नीचे स्वीकृत नहीं करते, कोई भी {{name}} का रिकॉर्ड नहीं देख सकता।',
  },
  'sharing.invite.share': { en: 'Send', hi: 'भेजें' },
  'sharing.invite.copy': { en: 'Copy', hi: 'कॉपी' },
  'sharing.invite.copied': { en: 'Invite copied', hi: 'न्योता कॉपी हुआ' },
  'sharing.invite.failed': { en: 'The invite could not be created. Please try again.', hi: 'न्योता नहीं बन सका। कृपया फिर कोशिश करें।' },

  // Join requests.
  'sharing.requests.title': { en: 'Waiting To Join', hi: 'जुड़ने के लिए प्रतीक्षारत' },
  'sharing.requests.none': { en: 'No phones are waiting to join right now.', hi: 'अभी कोई फ़ोन जुड़ने के लिए प्रतीक्षारत नहीं है।' },
  'sharing.requests.wants': {
    en: '{{device}} would like to help with {{name}}.',
    hi: '{{device}} {{name}} में मदद करना चाहता है।',
  },
  'sharing.requests.asManager': { en: 'Add As Manager', hi: 'प्रबंधक बनाएँ' },
  'sharing.requests.asViewer': { en: 'Add As Viewer', hi: 'दर्शक बनाएँ' },
  'sharing.requests.deny': { en: 'Deny', hi: 'मना करें' },
  'sharing.requests.approved': { en: '{{device}} added', hi: '{{device}} जुड़ गया' },
  'sharing.requests.denied': { en: 'Request denied', hi: 'अनुरोध अस्वीकृत' },

  // Members.
  'sharing.members.title': { en: 'People With Access', hi: 'पहुँच वाले लोग' },
  'sharing.members.you': { en: '{{device}} (this phone)', hi: '{{device}} (यह फ़ोन)' },
  'sharing.members.roleOwner': { en: 'Owner', hi: 'प्रभारी' },
  'sharing.members.roleManager': { en: 'Manager', hi: 'प्रबंधक' },
  'sharing.members.roleViewer': { en: 'Viewer', hi: 'दर्शक' },
  'sharing.members.canManage': { en: 'Sees and updates the record', hi: 'रिकॉर्ड देखता और बदलता है' },
  'sharing.members.canView': { en: 'Sees the record only', hi: 'केवल रिकॉर्ड देखता है' },
  'sharing.members.manageHint': { en: 'Tap a person to change their role or remove them.', hi: 'किसी व्यक्ति की भूमिका बदलने या हटाने के लिए उस पर टैप करें।' },
  'sharing.members.setManager': { en: 'Manager', hi: 'प्रबंधक' },
  'sharing.members.setViewer': { en: 'Viewer', hi: 'दर्शक' },
  'sharing.members.roleChanged': { en: 'Role changed', hi: 'भूमिका बदली' },

  // Remove.
  'sharing.remove.button': { en: 'Remove From Sharing', hi: 'साझा से हटाएँ' },
  'sharing.remove.title': { en: 'Remove {{device}}?', hi: '{{device}} को हटाएँ?' },
  'sharing.remove.body': {
    en: '{{device}} can no longer see changes from now on. Anything already saved stays on their phone — removing them cannot pull it back. Everyone else keeps access.',
    hi: '{{device}} अब से आगे के बदलाव नहीं देख पाएगा। जो पहले से सहेजा जा चुका है वह उनके फ़ोन पर रहता है — हटाने से वह वापस नहीं आ सकता। बाकी सबकी पहुँच बनी रहती है।',
  },
  'sharing.remove.confirm': { en: 'Remove', hi: 'हटाएँ' },
  'sharing.remove.done': { en: '{{device}} removed', hi: '{{device}} हटाया गया' },

  // Change owner.
  'sharing.owner.title': { en: 'Change Who Looks After {{name}}', hi: '{{name}} की देखभाल कौन करे, बदलें' },
  'sharing.owner.body': {
    en: 'The owner’s phone is the one that rings the reminders. You can hand that over to another phone in the circle.',
    hi: 'प्रभारी का फ़ोन वही है जिस पर याद-दिलावट बजती है। आप इसे परिवार के किसी और फ़ोन को सौंप सकते हैं।',
  },
  'sharing.owner.make': { en: 'Make Owner', hi: 'प्रभारी बनाएँ' },
  'sharing.owner.confirmTitle': { en: 'Move Reminders To {{device}}?', hi: 'याद-दिलावट {{device}} पर ले जाएँ?' },
  'sharing.owner.confirmBody': {
    en: 'The reminders for {{name}} will ring on {{device}}’s phone from now on, and this phone will stop ringing them. Both phones will be told. Until {{device}}’s phone takes over, this phone keeps ringing — so a dose is never left without an alarm.',
    hi: 'अब से {{name}} की याद-दिलावट {{device}} के फ़ोन पर बजेगी, और इस फ़ोन पर बजना रुक जाएगा। दोनों फ़ोन को बताया जाएगा। जब तक {{device}} का फ़ोन ज़िम्मा नहीं लेता, यह फ़ोन बजाता रहेगा — ताकि कोई खुराक बिना अलार्म के न छूटे।',
  },
  'sharing.owner.confirm': { en: 'Move Reminders', hi: 'याद-दिलावट ले जाएँ' },
  'sharing.owner.done': { en: 'Handing reminders to {{device}}', hi: '{{device}} को याद-दिलावट सौंपी जा रही है' },

  'sharing.loadFailed': { en: 'Sharing could not be opened. Please try again.', hi: 'साझा नहीं खुल सका। कृपया फिर कोशिश करें।' },
};

type Loaded =
  | { readonly kind: 'notfound' }
  | { readonly kind: 'unconfigured'; readonly name: string }
  | { readonly kind: 'ready'; readonly name: string; readonly view: ShareView };

export default function SharingCircleScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const t = useT(STRINGS);
  const { colors } = useTheme();
  const toast = useToast();
  const confirm = useConfirm();

  const state = useAsync<Loaded>(async () => {
    const profile = await getProfile(id);
    if (!profile) return { kind: 'notfound' };
    // Not set up on this phone at all is a DIFFERENT state from "set up, nobody added yet":
    // the first is answered in Settings, the second on this screen. Keep them apart.
    if (!(await isSyncConfigured())) return { kind: 'unconfigured', name: profile.displayName };
    const view = await getShareView(id);
    return { kind: 'ready', name: profile.displayName, view };
  }, [id]);

  // `reload` raises the skeleton (honest when the screen has nothing or errored — the retry
  // banner). `refresh` re-runs WITHOUT the skeleton, for after a mutation this screen has
  // already toasted as done, and for the focus poll — collapsing the roster to two skeleton
  // bars on every return would lose the owner's place. See the note on both in _shared/lib.
  const { reload, refresh } = state;
  // New join requests arrive on someone else's phone; the owner sees them when they come back
  // to this screen. No live polling this round — that would belong in the appOpen background.
  useReloadOnFocus(refresh);
  const data = state.data;
  const view = data?.kind === 'ready' ? data.view : null;
  const name = data && data.kind !== 'notfound' ? data.name : '';
  const role: Role | null = view ? (view.myRole as Role) : null;

  // ── The manager write-state probe (design §3.3) ────────────────────────────
  // A point-in-time reachability check, only when it can matter (a manager). Owner writes
  // offline freely; a viewer never writes. Reuses the same `testSyncConnection` the setup
  // screen uses rather than inventing a presence API — one round-trip, on load, is enough
  // to answer "can I update right now". `null` means "not applicable to this role".
  const online = useAsync<boolean | null>(async () => {
    if (role !== 'manager') return null;
    const config = await getSyncConfig();
    if (!config) return false;
    return (await testSyncConnection(config.url, config.anonKey)) === 'working';
  }, [role]);

  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [openMember, setOpenMember] = useState<string | null>(null);

  const roleLabel = useCallback(
    (r: Role): string =>
      r === 'owner'
        ? t('sharing.members.roleOwner')
        : r === 'manager'
          ? t('sharing.members.roleManager')
          : t('sharing.members.roleViewer'),
    [t],
  );

  // ── Owner actions ──────────────────────────────────────────────────────────

  const makeInvite = useCallback(async () => {
    if (!view) return;
    setBusy(true);
    try {
      setInvite(await mintInvite(id));
    } catch (error) {
      // Never carries any part of the invite — half an invite could still be a foothold.
      console.warn('[sharing] the invite could not be created', error);
      toast.show({ message: t('sharing.invite.failed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [view, id, t, toast]);

  const copyInvite = useCallback(async () => {
    if (!invite) return;
    await Clipboard.setStringAsync(invite.code);
    toast.show({ message: t('sharing.invite.copied'), variant: 'success' });
  }, [invite, t, toast]);

  const sendInvite = useCallback(async () => {
    if (!invite) return;
    await Share.share({ message: invite.code }).catch(() => undefined);
  }, [invite]);

  const onApprove = useCallback(
    async (req: JoinRequestView, grant: GrantableRole) => {
      if (!view?.shareId) return;
      setBusy(true);
      try {
        await approve(view.shareId, req.deviceId, grant);
        toast.show({ message: t('sharing.requests.approved', { device: req.deviceLabel }), variant: 'success' });
        refresh();
      } catch (error) {
        console.warn('[sharing] approve failed', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        // finally, not just catch: `refresh()` is the non-skeleton reload, so the component
        // stays mounted and `busy` persists — clearing it only on error strands every control
        // (the SECOND pending request's buttons, role chips, remove) disabled after the first
        // successful action. Same try/finally shape as makeInvite.
        setBusy(false);
      }
    },
    [view, t, toast, refresh],
  );

  const onDeny = useCallback(
    async (req: JoinRequestView) => {
      if (!view?.shareId) return;
      setBusy(true);
      try {
        await deny(view.shareId, req.deviceId);
        toast.show({ message: t('sharing.requests.denied'), variant: 'success' });
        refresh();
      } catch (error) {
        console.warn('[sharing] deny failed', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [view, t, toast, refresh],
  );

  const onChangeRole = useCallback(
    async (member: MemberView, next: GrantableRole) => {
      if (!view?.shareId || member.role === next) return;
      setBusy(true);
      try {
        await changeRole(view.shareId, member.deviceId, next);
        toast.show({ message: t('sharing.members.roleChanged'), variant: 'success' });
        refresh();
      } catch (error) {
        console.warn('[sharing] change role failed', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [view, t, toast, refresh],
  );

  const onRemove = useCallback(
    async (member: MemberView) => {
      if (!view?.shareId) return;
      // The disclosure IS the message — the two things people get wrong (it does not un-see
      // what is already saved, and it only stops THIS person) are said before the tap, never
      // after. This mirrors the sync layer's REVOKE_DISCLOSURE, kept honest for one member.
      const ok = await confirm({
        title: t('sharing.remove.title', { device: member.deviceLabel }),
        message: t('sharing.remove.body', { device: member.deviceLabel }),
        confirmLabel: t('sharing.remove.confirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      try {
        await removeMember(view.shareId, member.deviceId);
        toast.show({ message: t('sharing.remove.done', { device: member.deviceLabel }), variant: 'success' });
        setOpenMember(null);
        refresh();
      } catch (error) {
        console.warn('[sharing] remove failed', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [view, confirm, t, toast, refresh],
  );

  const onMakeOwner = useCallback(
    async (member: MemberView) => {
      if (!view?.shareId) return;
      // The loudest confirm on the screen: this moves WHICH PHONE RINGS a TB dose. The body
      // spells out the handoff, including the safe part people miss — until the new phone
      // takes over, this one keeps ringing, so a dose is never left silent in the gap.
      const ok = await confirm({
        title: t('sharing.owner.confirmTitle', { device: member.deviceLabel }),
        message: t('sharing.owner.confirmBody', { device: member.deviceLabel, name }),
        confirmLabel: t('sharing.owner.confirm'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      try {
        await changeOwner(view.shareId, member.deviceId);
        toast.show({ message: t('sharing.owner.done', { device: member.deviceLabel }), variant: 'success' });
        refresh();
      } catch (error) {
        console.warn('[sharing] change owner failed', error);
        toast.show({ message: t('errors.saveFailed'), variant: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [view, confirm, t, toast, name, refresh],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const iAmOwner = role === 'owner';
  // `?? []` on both: the membership read owns these arrays, but a UI that renders `.length`
  // and `.map` must never crash a whole screen because one field arrived undefined.
  const members: readonly MemberView[] = view?.members ?? [];
  const pendingRequests: readonly JoinRequestView[] = view?.pendingRequests ?? [];
  const otherMembers = members.filter((m: MemberView) => !m.isSelf);

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader title={t('sharing.circle.title')} subtitle={name || undefined} onBack={() => router.back()} />

      {state.loading && !data ? <Skeleton height={200} label={t('sharing.circle.loading')} /> : null}

      {state.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          message={t('sharing.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={reload}
        />
      ) : null}

      {data?.kind === 'notfound' ? <Banner variant="attention" title={t('errors.notFound')} /> : null}

      {data?.kind === 'unconfigured' ? (
        <Card>
          <View style={{ gap: spacing.md }}>
            <Text variant="label">{t('sharing.circle.setupTitle')}</Text>
            <Text variant="body" tone="muted">
              {t('sharing.circle.setupBody', { name })}
            </Text>
            <Button
              title={t('sharing.circle.setupOpen')}
              onPress={() => router.push('/settings/viewers')}
              size="lg"
              fullWidth
            />
          </View>
        </Card>
      ) : null}

      {data?.kind === 'ready' && view && role ? (
        <View style={{ gap: spacing.md }}>
          {/* ── Role banner ──────────────────────────────────────────────── */}
          {iAmOwner ? (
            <Card>
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
                <Icon name="check" size={28} color={colors.primary} strokeWidth={2.6} />
                <View style={{ flex: 1, gap: spacing.sm }}>
                  <Text variant="label">{t('sharing.role.ownerTitle', { name })}</Text>
                  <Text variant="body" tone="muted">
                    {t('sharing.role.ownerBody', { name })}
                  </Text>
                </View>
              </View>
            </Card>
          ) : role === 'manager' ? (
            <Card>
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('sharing.role.managerTitle', { name })}</Text>
                {/* Online/offline write-state — icon AND words, never colour alone. */}
                {online.loading ? (
                  <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                    <Icon name="clock" size={22} color={colors.textMuted} />
                    <Text variant="body" tone="muted">
                      {t('sharing.online.checking')}
                    </Text>
                  </View>
                ) : online.data === true ? (
                  <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
                    <Icon name="check" size={22} color={colors.success} strokeWidth={2.6} />
                    <Text variant="body" style={{ flex: 1 }}>
                      {t('sharing.online.canWrite', { name })}
                    </Text>
                  </View>
                ) : (
                  <Banner
                    variant="info"
                    title={t('sharing.online.offlineTitle')}
                    message={t('sharing.online.offlineBody', { name })}
                  />
                )}
                <Text variant="caption" tone="muted">
                  {t('sharing.reminderNote')}
                </Text>
              </View>
            </Card>
          ) : (
            <Card>
              <View style={{ gap: spacing.sm }}>
                <Text variant="label">{t('sharing.role.viewerTitle', { name })}</Text>
                <Text variant="body" tone="muted">
                  {t('sharing.role.viewerBody', { name })}
                </Text>
                <Text variant="caption" tone="muted">
                  {t('sharing.reminderNote')}
                </Text>
              </View>
            </Card>
          )}

          {/* ── Owner: invite ────────────────────────────────────────────── */}
          {iAmOwner ? (
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text variant="label">{t('sharing.invite.title')}</Text>
                <Text variant="body" tone="muted">
                  {t('sharing.invite.body')}
                </Text>

                {invite ? (
                  <View style={{ gap: spacing.md }}>
                    <Text variant="caption" tone="muted">
                      {t('sharing.invite.codeLabel')}
                    </Text>
                    <Text
                      variant="body"
                      selectable
                      accessibilityLabel={t('sharing.invite.codeLabel')}
                      style={{ paddingVertical: spacing.xs }}
                    >
                      {invite.code}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {t('sharing.invite.codeHint', { name })}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: spacing.md }}>
                      <Button
                        title={t('sharing.invite.share')}
                        onPress={() => void sendInvite()}
                        size="lg"
                        style={{ flex: 1 }}
                      />
                      <Button
                        title={t('sharing.invite.copy')}
                        onPress={() => void copyInvite()}
                        variant="secondary"
                        size="lg"
                        style={{ flex: 1 }}
                      />
                    </View>
                  </View>
                ) : (
                  <Button
                    title={t('sharing.invite.make')}
                    onPress={() => void makeInvite()}
                    size="lg"
                    loading={busy}
                    fullWidth
                  />
                )}
              </View>
            </Card>
          ) : null}

          {/* ── Owner: waiting-to-join requests ──────────────────────────── */}
          {iAmOwner ? (
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text variant="label">{t('sharing.requests.title')}</Text>
                {pendingRequests.length === 0 ? (
                  <Text variant="body" tone="muted">
                    {t('sharing.requests.none')}
                  </Text>
                ) : (
                  pendingRequests.map((req: JoinRequestView) => (
                    <View key={req.deviceId} style={{ gap: spacing.sm }}>
                      <Text variant="body">{t('sharing.requests.wants', { device: req.deviceLabel, name })}</Text>
                      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
                        <Button
                          title={t('sharing.requests.asManager')}
                          onPress={() => void onApprove(req, 'manager')}
                          size="md"
                          disabled={busy}
                        />
                        <Button
                          title={t('sharing.requests.asViewer')}
                          onPress={() => void onApprove(req, 'viewer')}
                          variant="secondary"
                          size="md"
                          disabled={busy}
                        />
                        <Button
                          title={t('sharing.requests.deny')}
                          onPress={() => void onDeny(req)}
                          variant="ghost"
                          size="md"
                          disabled={busy}
                        />
                      </View>
                    </View>
                  ))
                )}
              </View>
            </Card>
          ) : null}

          {/* ── People with access (everyone sees this; only owner acts) ─── */}
          <Card>
            <View style={{ gap: spacing.sm }}>
              <Text variant="label">{t('sharing.members.title')}</Text>
              {iAmOwner ? (
                <Text variant="caption" tone="muted">
                  {t('sharing.members.manageHint')}
                </Text>
              ) : null}

              {members.map((member: MemberView) => {
                const isOpen = openMember === member.deviceId;
                const canManage = iAmOwner && !member.isSelf && member.role !== 'owner';
                const title = member.isSelf
                  ? t('sharing.members.you', { device: member.deviceLabel })
                  : member.deviceLabel;
                const subtitle =
                  member.role === 'owner'
                    ? roleLabel('owner')
                    : `${roleLabel(member.role as Role)} · ${member.role === 'viewer' ? t('sharing.members.canView') : t('sharing.members.canManage')}`;
                return (
                  <View key={member.deviceId}>
                    <ListRow
                      title={title}
                      subtitle={subtitle}
                      leading={
                        <Icon
                          name={member.role === 'owner' ? 'check' : member.role === 'viewer' ? 'info' : 'plus'}
                          size={24}
                          color={member.role === 'owner' ? colors.primary : colors.textMuted}
                        />
                      }
                      onPress={canManage ? () => setOpenMember(isOpen ? null : member.deviceId) : undefined}
                      showChevron={canManage}
                    />
                    {canManage && isOpen ? (
                      <View style={{ gap: spacing.md, paddingVertical: spacing.md }}>
                        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                          <Chip
                            label={t('sharing.members.setManager')}
                            selected={member.role === 'manager'}
                            onPress={() => void onChangeRole(member, 'manager')}
                          />
                          <Chip
                            label={t('sharing.members.setViewer')}
                            selected={member.role === 'viewer'}
                            onPress={() => void onChangeRole(member, 'viewer')}
                          />
                        </View>
                        <Button
                          title={t('sharing.remove.button')}
                          onPress={() => void onRemove(member)}
                          variant="destructive"
                          size="lg"
                          disabled={busy}
                          fullWidth
                        />
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </Card>

          {/* ── Owner: change owner ──────────────────────────────────────── */}
          {iAmOwner && otherMembers.length > 0 ? (
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text variant="label">{t('sharing.owner.title', { name })}</Text>
                <Text variant="body" tone="muted">
                  {t('sharing.owner.body')}
                </Text>
                {otherMembers.map((member: MemberView) => (
                  <View
                    key={member.deviceId}
                    style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}
                  >
                    <Text variant="body" style={{ flex: 1 }}>
                      {member.deviceLabel}
                    </Text>
                    <Button
                      title={t('sharing.owner.make')}
                      onPress={() => void onMakeOwner(member)}
                      variant="secondary"
                      size="md"
                      disabled={busy}
                    />
                  </View>
                ))}
              </View>
            </Card>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}
