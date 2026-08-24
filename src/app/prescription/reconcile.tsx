/**
 * Reconciling a new prescription against what she is already taking.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THIS IS THE MOST DANGEROUS SCREEN IN THE APP. EVERY RULE BELOW IS LOAD-BEARING.
 *
 * The failure mode is not a wrong reminder. It is a woman on cardiac medication,
 * diabetes medication and six months of TB treatment tapping one confident-looking
 * button and silently ending three of them, because a doctor wrote today's prescription
 * for the chest complaint she came in with and did not re-list the rest.
 *
 *  1. THE DIFF COMES FIRST, AND THE FOURTH GROUP IS CALLED "NOT ON THIS PRESCRIPTION".
 *     Never "to stop", never "removed", never "missing". Absence from one piece of paper
 *     is not an instruction to stop a drug, and a heading that says otherwise has already
 *     made the decision before she has read a single name.
 *
 *  2. KEEPING EVERYTHING IS THE DEFAULT, LISTED FIRST, AND PRE-SELECTED. The safe answer
 *     has to be the easy one. A screen where "keep" costs three taps and "replace" costs
 *     one is a screen that stops medicines for a living. Every per-medicine toggle starts
 *     on Keep — not "unchanged", not "inherit", Keep — and `planSupersession` treats a
 *     missing decision as Keep as well, so a dropped tap can never become a stop.
 *
 *  3. NOTHING STOPS WITHOUT ITS NAME ON SCREEN. The confirmation names every medicine
 *     that will stop and how many there are. There is no generic "Are you sure?" here,
 *     because "Are you sure?" is answered yes by a thumb and a list of four drug names is
 *     answered by a person. `planSupersession` enforces the same thing from below: a
 *     replace-all plan is REFUSED unless the caller hands back the exact list it showed.
 *
 *  4. A CRITICAL MEDICINE CAN NEVER BE STOPPED IN A GROUP. Every `criticality: 'critical'`
 *     row comes out of the bulk operation entirely and is asked about on its own, by name,
 *     one at a time. Declining one keeps it and does not cancel the rest. The feature
 *     module refuses a bulk stop containing one outright, so this screen routes those
 *     answers through the per-medicine plan instead of trying to talk it round.
 *     TB treatment interrupted by a mis-tap is drug resistance.
 *
 *  5. AN OUTCOME OF ZERO MEDICINES IS REFUSED OUTRIGHT — by the planner, and by this
 *     screen before she can even press the button. A reconciliation that ends with nothing
 *     to take is a failed scan, not a prescription, and the way out is back to the review
 *     screen rather than through this one.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { useAsync, useProfileId, useT, type LocalStrings } from '@/app/_shared/lib';
import {
  Banner,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Icon,
  Screen,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';
import { toLocalDate } from '@/lib/datetime';
import { getPrescription, type Prescription } from '@/db/repositories/prescriptions';
import { parseStoredPrescription } from '@/features/prescriptions/extract';
import {
  applySupersession,
  buildSupersessionDiff,
  loadCurrentMedicines,
  planSupersession,
  toIncoming,
  type NotOnPrescriptionRow,
  type PrescriptionDiff,
  type ThreadDecision,
} from '@/features/prescriptions/reconcile';

const STRINGS: LocalStrings = {
  'prescription.reconcile.title': { en: 'What changes?', hi: 'क्या बदल रहा है?' },
  'prescription.reconcile.subtitle': {
    en: 'This prescription, next to what you are already taking.',
    hi: 'यह पर्चा, और आपकी पहले से चल रही दवाइयाँ — दोनों साथ में।',
  },
  'prescription.reconcile.continued': {
    en: 'Continued ({{count}})',
    hi: 'पहले जैसी ही चलती रहेंगी ({{count}})',
  },
  'prescription.reconcile.changed': {
    en: 'Changed ({{count}})',
    hi: 'इस पर्चे पर अलग लिखी है ({{count}})',
  },
  'prescription.reconcile.new': { en: 'New ({{count}})', hi: 'इस पर्चे पर नई ({{count}})' },
  'prescription.reconcile.absent': {
    en: 'Not on this prescription ({{count}})',
    hi: 'इस पर्चे पर नहीं है ({{count}})',
  },
  'prescription.reconcile.absentNote': {
    en: 'A medicine missing from one piece of paper is not an instruction to stop it. Every one of these keeps going unless you say otherwise.',
    hi: 'किसी एक कागज़ पर दवाई का न होना उसे बंद करने का आदेश नहीं है। जब तक आप खुद न कहें, ये सब चलती रहेंगी।',
  },
  'prescription.reconcile.changedNote': {
    en: 'These are recorded as a change to the same medicine, so your record stays in one piece.',
    hi: 'इन्हें उसी दवाई का बदलाव मानकर दर्ज किया जाता है, ताकि आपका रिकॉर्ड टूटे नहीं।',
  },
  'prescription.reconcile.emptyGroup': { en: 'Nothing here.', hi: 'यहाँ कुछ नहीं।' },
  'prescription.reconcile.whatNow': { en: 'What would you like to do?', hi: 'अब आप क्या करना चाहेंगी?' },
  'prescription.reconcile.optionKeep': {
    en: 'Keep everything and add the new ones',
    hi: 'सब कुछ चलने दें और नई दवाइयाँ जोड़ें',
  },
  'prescription.reconcile.optionKeepHint': {
    en: 'Nothing stops. This is the safe answer.',
    hi: 'कुछ भी बंद नहीं होगा। यही सुरक्षित जवाब है।',
  },
  'prescription.reconcile.optionChoose': { en: 'Let me choose', hi: 'मैं खुद चुनूँगी' },
  'prescription.reconcile.optionChooseHint': {
    en: 'Go through them one by one. Every medicine starts on Keep.',
    hi: 'एक-एक करके देखें। हर दवाई पहले से "चलने दें" पर है।',
  },
  'prescription.reconcile.optionReplace': {
    en: 'Replace — stop anything not on this prescription',
    hi: 'बदल दें — जो इस पर्चे पर नहीं है उसे बंद कर दें',
  },
  'prescription.reconcile.optionReplaceHint': {
    en: 'This would stop {{count}} medicines. You will be shown their names first.',
    hi: 'इससे {{count}} दवाइयाँ बंद होंगी। पहले उनके नाम दिखाए जाएँगे।',
  },
  'prescription.reconcile.optionReplaceNone': {
    en: 'There is nothing that this prescription leaves out.',
    hi: 'इस पर्चे में से कोई दवाई छूटी नहीं है।',
  },
  'prescription.reconcile.chooseTitle': { en: 'Choose for each medicine', hi: 'हर दवाई के लिए चुनें' },
  'prescription.reconcile.keepIt': { en: 'Keep', hi: 'चलने दें' },
  'prescription.reconcile.stopIt': { en: 'Stop', hi: 'बंद करें' },
  'prescription.reconcile.criticalNote': {
    en: 'A very important medicine is never stopped along with others. Each one is asked about on its own, by name.',
    hi: 'बहुत ज़रूरी दवाई कभी दूसरों के साथ बंद नहीं की जाती। हर एक के बारे में नाम लेकर अलग से पूछा जाता है।',
  },
  'prescription.reconcile.stopManyTitle': {
    en: 'Stop {{count}} medicines?',
    hi: '{{count}} दवाइयाँ बंद करें?',
  },
  'prescription.reconcile.stopManyMessage': {
    en: 'This will stop {{count}} medicines: {{names}}. Their reminders stop. Everything already recorded is kept.',
    hi: 'इससे {{count}} दवाइयाँ बंद होंगी: {{names}}। इनके रिमाइंडर बंद हो जाएँगे। जो दर्ज हो चुका है वह रहेगा।',
  },
  'prescription.reconcile.stopOneTitle': { en: 'Stop {{name}}?', hi: '{{name}} बंद करें?' },
  'prescription.reconcile.stopManyConfirm': { en: 'Stop these {{count}}', hi: 'ये {{count}} बंद करें' },
  'prescription.reconcile.stopOneMessage': {
    en: 'Their reminders stop. Everything already recorded is kept.',
    hi: 'इनके रिमाइंडर बंद हो जाएँगे। जो दर्ज हो चुका है वह रहेगा।',
  },
  'prescription.reconcile.stopCriticalMessage': {
    en: '{{name}} is marked as a very important medicine, so it is asked about on its own. Its reminders stop. Everything already recorded is kept.',
    hi: '{{name}} को बहुत ज़रूरी दवाई बताया गया है, इसलिए इसके बारे में अलग से पूछा जा रहा है। इसके रिमाइंडर बंद हो जाएँगे। जो दर्ज हो चुका है वह रहेगा।',
  },
  'prescription.reconcile.stopOneConfirm': { en: 'Stop {{name}}', hi: '{{name}} बंद करें' },
  'prescription.reconcile.zeroTitle': {
    en: 'This would leave no medicines at all',
    hi: 'इससे एक भी दवाई नहीं बचेगी',
  },
  'prescription.reconcile.zeroMessage': {
    en: 'A prescription that ends with nothing to take is a photo that was not read properly. Go back and check the medicines before stopping anything.',
    hi: 'जिस पर्चे के बाद लेने को कुछ बचे ही नहीं, वह ठीक से पढ़ी न गई फोटो है। कुछ भी बंद करने से पहले वापस जाकर दवाइयाँ जाँचें।',
  },
  'prescription.reconcile.backToReview': {
    en: 'Go back and check the medicines',
    hi: 'वापस जाकर दवाइयाँ जाँचें',
  },
  'prescription.reconcile.refusedTitle': { en: 'This was not done', hi: 'यह नहीं किया गया' },
  'prescription.reconcile.stopReasonValue': {
    en: 'Not on the prescription checked on {{date}}',
    hi: '{{date}} को जाँचे गए पर्चे पर नहीं थी',
  },
  'prescription.reconcile.stoppedToast': {
    en: '{{count}} medicines stopped',
    hi: '{{count}} दवाइयाँ बंद कर दी गईं',
  },
  'prescription.reconcile.stoppedOneToast': { en: '1 medicine stopped', hi: '1 दवाई बंद कर दी गई' },
  'prescription.reconcile.keptToast': { en: 'Nothing was stopped', hi: 'कुछ भी बंद नहीं किया गया' },
  'prescription.reconcile.applyKeep': { en: 'Keep everything', hi: 'सब चलने दें' },
  'prescription.reconcile.applyChoose': { en: 'Apply what I chose', hi: 'जो मैंने चुना वह लागू करें' },
  'prescription.reconcile.applyReplace': {
    en: 'Stop {{count}} and continue',
    hi: '{{count}} बंद करें और आगे बढ़ें',
  },
  'prescription.reconcile.saveFailed': {
    // Deliberately not "nothing was stopped": the apply can fail part way, and telling her
    // nothing happened when something did is the one thing this screen must never do.
    en: 'This could not be finished. Please check your medicines list — some may already have stopped.',
    hi: 'यह पूरा नहीं हो पाया। अपनी दवाइयों की सूची देख लें — कुछ बंद हो चुकी हो सकती हैं।',
  },
  'prescription.reconcile.nothingTitle': {
    en: 'There is nothing to compare',
    hi: 'मिलाने के लिए कुछ नहीं है',
  },
  'prescription.reconcile.nothingMessage': {
    en: 'Everything you are taking is on this prescription, so there is nothing to decide here.',
    hi: 'आप जो भी ले रही हैं, वह सब इसी पर्चे पर है — इसलिए यहाँ तय करने को कुछ नहीं है।',
  },
  'prescription.reconcile.goMedicines': { en: 'Go to my medicines', hi: 'मेरी दवाइयों पर जाएँ' },
  'prescription.reconcile.veryImportant': { en: 'Very important', hi: 'बहुत ज़रूरी' },
};

type Mode = 'keep' | 'choose' | 'replace';

type Data = {
  prescription: Prescription;
  profileId: string;
  diff: PrescriptionDiff;
};

export default function PrescriptionReconcileScreen() {
  const rawId = useLocalSearchParams<{ id?: string | string[] }>().id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  const t = useT(STRINGS);
  const toast = useToast();
  const confirm = useConfirm();
  const { colors } = useTheme();
  const { formatDate } = useDateFormat();
  const profile = useProfileId();
  const profileId = profile.data;

  const [mode, setMode] = useState<Mode>('keep');
  /** Threads she has explicitly moved off Keep. Empty is the starting state, always. */
  const [markedToStop, setMarkedToStop] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const state = useAsync<Data | null>(async () => {
    if (!id || !profileId) return null;
    const prescription = await getPrescription(id);
    if (!prescription) return null;

    const parseResult = parseStoredPrescription(prescription.extraction);
    const current = await loadCurrentMedicines(profileId);
    const incoming = parseResult.ok ? toIncoming(parseResult.value) : [];
    const diff = buildSupersessionDiff(current, incoming);

    return { prescription, profileId, diff };
  }, [id, profileId]);

  const data = state.data;
  const diff = data?.diff ?? null;
  const absent = useMemo<readonly NotOnPrescriptionRow[]>(
    () => diff?.notOnThisPrescription ?? [],
    [diff],
  );

  /** What the selected mode would stop, before any confirmation has been asked for. */
  const targets = useMemo<NotOnPrescriptionRow[]>(() => {
    if (mode === 'keep') return [];
    if (mode === 'replace') return [...absent];
    return absent.filter((row) => markedToStop.includes(row.threadId));
  }, [absent, markedToStop, mode]);

  /**
   * The zero-medicine refusal, evaluated on every render rather than only on press.
   *
   * `planSupersession` is pure, so the same function that will refuse the write is used
   * to grey the button out — the refusal is never a surprise that arrives after the last
   * tap. `pick_per_medicine` is used for the preview even in replace mode, because
   * replace-all additionally refuses on unacknowledged lists and on criticals, and
   * neither of those is what this preview is asking about.
   */
  const previewRefusal = useMemo(() => {
    if (!diff) return null;
    const decisions: Record<string, ThreadDecision> = {};
    for (const row of targets) decisions[row.threadId] = 'stop';
    const result = planSupersession(diff, 'pick_per_medicine', { decisions });
    return result.ok ? null : result.refusal;
  }, [diff, targets]);

  const wouldEmpty = previewRefusal?.code === 'would_leave_no_medicines';

  const toggleStop = useCallback((threadId: string) => {
    setMarkedToStop((current) =>
      current.includes(threadId) ? current.filter((x) => x !== threadId) : [...current, threadId],
    );
  }, []);

  const apply = useCallback(async () => {
    if (!data || !diff || applying || wouldEmpty) return;
    setRefusal(null);

    if (targets.length === 0) {
      toast.show({ message: t('prescription.reconcile.keptToast'), variant: 'info' });
      router.replace('/(tabs)/medicines');
      return;
    }

    // A critical medicine is never part of a group question. It comes out of the bulk list
    // entirely and gets its own, with its own name in it.
    const criticals = targets.filter((row) => row.criticality === 'critical');
    const bulk = targets.filter((row) => row.criticality !== 'critical');
    const agreed: NotOnPrescriptionRow[] = [];

    if (bulk.length > 0) {
      const names = bulk.map((row) => row.name).join(', ');
      const ok = await confirm({
        title: t('prescription.reconcile.stopManyTitle', { count: bulk.length }),
        // Every name, in the body. The confirm dialog scrolls, so a long list is shown in
        // full rather than summarised into a number she cannot check.
        message: t('prescription.reconcile.stopManyMessage', { count: bulk.length, names }),
        confirmLabel: t('prescription.reconcile.stopManyConfirm', { count: bulk.length }),
        destructive: true,
      });
      if (!ok) return;
      agreed.push(...bulk);
    }

    for (const row of criticals) {
      const ok = await confirm({
        title: t('prescription.reconcile.stopOneTitle', { name: row.name }),
        message: t('prescription.reconcile.stopCriticalMessage', { name: row.name }),
        confirmLabel: t('prescription.reconcile.stopOneConfirm', { name: row.name }),
        destructive: true,
      });
      // Declining one keeps it and leaves the rest of the operation intact.
      if (ok) agreed.push(row);
    }

    if (agreed.length === 0) {
      toast.show({ message: t('prescription.reconcile.keptToast'), variant: 'info' });
      return;
    }

    // Replace-all is used only when the list she acknowledged is exactly the whole
    // candidate list — which is what `planSupersession` checks, and what makes that check
    // worth having. The moment a critical was asked about separately, or one was declined,
    // the honest description of what she agreed to is a per-medicine plan.
    const useReplaceAll =
      mode === 'replace' && criticals.length === 0 && agreed.length === absent.length;

    const decisions: Record<string, ThreadDecision> = {};
    for (const row of agreed) decisions[row.threadId] = 'stop';

    const planned = useReplaceAll
      ? planSupersession(diff, 'replace_all', {
          acknowledgedStopThreadIds: agreed.map((row) => row.threadId),
        })
      : planSupersession(diff, 'pick_per_medicine', { decisions });

    if (!planned.ok) {
      // The planner refused. Its message is developer-facing, so the screen renders its
      // own sentence for the one refusal a user can actually act on and a generic, honest
      // one for the rest.
      setRefusal(
        planned.refusal.code === 'would_leave_no_medicines'
          ? t('prescription.reconcile.zeroMessage')
          : t('prescription.reconcile.saveFailed'),
      );
      return;
    }

    setApplying(true);
    try {
      const today = toLocalDate();
      // A real reason, stored on the row — "stopped" with no reason is unreadable six
      // months later, and this row is what an OPD report prints from.
      const result = await applySupersession(data.profileId, planned.plan, {
        reason: t('prescription.reconcile.stopReasonValue', { date: formatDate(today) }),
        stoppedOn: today,
      });

      toast.show({
        message:
          result.stoppedThreadIds.length === 1
            ? t('prescription.reconcile.stoppedOneToast')
            : t('prescription.reconcile.stoppedToast', { count: result.stoppedThreadIds.length }),
        variant: 'success',
      });
      router.replace('/(tabs)/medicines');
    } catch {
      setRefusal(t('prescription.reconcile.saveFailed'));
    } finally {
      setApplying(false);
    }
  }, [absent.length, applying, confirm, data, diff, formatDate, mode, t, targets, toast, wouldEmpty]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/medicines');
  }, []);

  if (state.loading || profile.loading) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reconcile.title')} />
        <View style={{ gap: spacing.lg }}>
          <Skeleton height={120} label={t('a11y.loading')} />
          <Skeleton height={120} />
        </View>
      </Screen>
    );
  }

  if (!data || !diff) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reconcile.title')} onBack={leave} />
        <EmptyState
          title={t('errors.notFound')}
          actionLabel={t('prescription.reconcile.goMedicines')}
          onAction={() => router.replace('/(tabs)/medicines')}
        />
      </Screen>
    );
  }

  if (absent.length === 0) {
    return (
      <Screen>
        <ScreenHeader title={t('prescription.reconcile.title')} onBack={leave} />
        <EmptyState
          title={t('prescription.reconcile.nothingTitle')}
          message={t('prescription.reconcile.nothingMessage')}
          actionLabel={t('prescription.reconcile.goMedicines')}
          onAction={() => router.replace('/(tabs)/medicines')}
        />
      </Screen>
    );
  }

  const applyLabel =
    mode === 'keep'
      ? t('prescription.reconcile.applyKeep')
      : mode === 'choose'
        ? t('prescription.reconcile.applyChoose')
        : t('prescription.reconcile.applyReplace', { count: absent.length });

  return (
    <Screen
      background="bgSunken"
      footer={
        <Button
          title={applyLabel}
          onPress={() => void apply()}
          // Destructive treatment only where something actually stops.
          variant={targets.length > 0 ? 'destructive' : 'primary'}
          size="lg"
          fullWidth
          disabled={wouldEmpty}
          loading={applying}
        />
      }
    >
      <ScreenHeader
        title={t('prescription.reconcile.title')}
        subtitle={t('prescription.reconcile.subtitle')}
        onBack={leave}
      />

      {/* ── THE DIFF, FIRST ─────────────────────────────────────────────────── */}

      <Group
        title={t('prescription.reconcile.continued', { count: diff.continued.length })}
        empty={t('prescription.reconcile.emptyGroup')}
        names={diff.continued.map((row) => row.name)}
      />

      <Group
        title={t('prescription.reconcile.changed', { count: diff.changed.length })}
        empty={t('prescription.reconcile.emptyGroup')}
        names={diff.changed.map((row) => row.name)}
        details={diff.changed.map((row) =>
          row.changes.map((change) => `${change.from} → ${change.to}`).join(', '),
        )}
        note={diff.changed.length > 0 ? t('prescription.reconcile.changedNote') : undefined}
      />

      <Group
        title={t('prescription.reconcile.new', { count: diff.added.length })}
        empty={t('prescription.reconcile.emptyGroup')}
        names={diff.added.map((row) => row.name)}
      />

      {/* The fourth group. Its name states a fact about a piece of paper and nothing
          about what she should do. */}
      <Group
        title={t('prescription.reconcile.absent', { count: absent.length })}
        empty={t('prescription.reconcile.emptyGroup')}
        names={absent.map((row) => row.name)}
        criticalFlags={absent.map((row) => row.criticality === 'critical')}
        criticalLabel={t('prescription.reconcile.veryImportant')}
        note={t('prescription.reconcile.absentNote')}
      />

      {/* ── THEN, AND ONLY THEN, THE THREE CHOICES ──────────────────────────── */}

      <SectionHeader title={t('prescription.reconcile.whatNow')} />

      <View style={{ gap: spacing.md }}>
        <Chip
          label={t('prescription.reconcile.optionKeep')}
          selected={mode === 'keep'}
          onPress={() => setMode('keep')}
          selectionMode="single"
          accessibilityHint={t('prescription.reconcile.optionKeepHint')}
          grow
        />
        <Text variant="caption" tone="muted" style={{ paddingLeft: spacing.xxl }}>
          {t('prescription.reconcile.optionKeepHint')}
        </Text>

        <Chip
          label={t('prescription.reconcile.optionChoose')}
          selected={mode === 'choose'}
          onPress={() => setMode('choose')}
          selectionMode="single"
          accessibilityHint={t('prescription.reconcile.optionChooseHint')}
          grow
        />
        <Text variant="caption" tone="muted" style={{ paddingLeft: spacing.xxl }}>
          {t('prescription.reconcile.optionChooseHint')}
        </Text>

        <Chip
          label={t('prescription.reconcile.optionReplace')}
          selected={mode === 'replace'}
          onPress={() => setMode('replace')}
          selectionMode="single"
          accessibilityHint={t('prescription.reconcile.optionReplaceHint', { count: absent.length })}
          grow
        />
        <View style={{ flexDirection: 'row', gap: spacing.sm, paddingLeft: spacing.xxl }}>
          <Icon name="alert" size={18} color={colors.attention} />
          <Text variant="caption" tone="attention" style={{ flex: 1 }}>
            {t('prescription.reconcile.optionReplaceHint', { count: absent.length })}
          </Text>
        </View>
      </View>

      {/* ── Per-medicine, every toggle starting on Keep ─────────────────────── */}

      {mode === 'choose' ? (
        <Card style={{ marginTop: spacing.lg, gap: spacing.lg }}>
          <Text variant="label">{t('prescription.reconcile.chooseTitle')}</Text>
          <Text variant="caption" tone="muted">
            {t('prescription.reconcile.criticalNote')}
          </Text>
          <Divider />
          {/* Bounded by the number of medicines she is currently taking. */}
          {absent.map((row) => {
            const stopping = markedToStop.includes(row.threadId);
            return (
              <View key={row.threadId} style={{ gap: spacing.sm }}>
                <Text variant="body" weight="600">
                  {row.name}
                </Text>
                {row.criticality === 'critical' ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <Icon name="alert" size={18} color={colors.attention} />
                    <Text variant="caption" tone="attention">
                      {t('prescription.reconcile.veryImportant')}
                    </Text>
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', gap: spacing.md }}>
                  {/* Keep is selected from the start and stays selected until she moves
                      it — not "unchanged", not "inherit". Keep. */}
                  <Chip
                    label={t('prescription.reconcile.keepIt')}
                    selected={!stopping}
                    onPress={() => {
                      if (stopping) toggleStop(row.threadId);
                    }}
                    selectionMode="single"
                    grow
                  />
                  <Chip
                    label={t('prescription.reconcile.stopIt')}
                    selected={stopping}
                    onPress={() => {
                      if (!stopping) toggleStop(row.threadId);
                    }}
                    selectionMode="single"
                    grow
                  />
                </View>
              </View>
            );
          })}
        </Card>
      ) : null}

      {/* ── The refusals ────────────────────────────────────────────────────── */}

      {wouldEmpty ? (
        <Banner
          variant="attention"
          title={t('prescription.reconcile.zeroTitle')}
          message={t('prescription.reconcile.zeroMessage')}
          actionLabel={t('prescription.reconcile.backToReview')}
          onAction={() => router.replace(`/prescription/review?id=${data.prescription.id}`)}
          style={{ marginTop: spacing.lg }}
        />
      ) : null}

      {refusal && !wouldEmpty ? (
        <Banner
          variant="attention"
          title={t('prescription.reconcile.refusedTitle')}
          message={refusal}
          onDismiss={() => setRefusal(null)}
          style={{ marginTop: spacing.lg }}
        />
      ) : null}
    </Screen>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// One group of the diff
// ═══════════════════════════════════════════════════════════════════════════════

function Group({
  title,
  names,
  details,
  criticalFlags,
  criticalLabel,
  note,
  empty,
}: {
  title: string;
  names: readonly string[];
  details?: readonly string[];
  criticalFlags?: readonly boolean[];
  criticalLabel?: string;
  note?: string;
  empty: string;
}) {
  const { colors } = useTheme();
  return (
    <Card style={{ marginTop: spacing.lg, gap: spacing.sm }}>
      <Text variant="label" accessibilityRole="header">
        {title}
      </Text>
      <Divider style={{ marginVertical: spacing.sm }} />

      {names.length === 0 ? (
        <Text variant="body" tone="muted">
          {empty}
        </Text>
      ) : (
        // Bounded by the medicines on one prescription plus the ones she is taking.
        names.map((name, index) => {
          const detail = details?.[index];
          const isCritical = criticalFlags?.[index] === true;
          return (
            <View
              key={`${name}:${index}`}
              accessible
              accessibilityLabel={[name, detail, isCritical ? criticalLabel : null]
                .filter((part): part is string => Boolean(part))
                .join('. ')}
              style={{ paddingVertical: spacing.xs, gap: spacing.xs }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                {isCritical ? <Icon name="alert" size={18} color={colors.attention} /> : null}
                <Text variant="body" weight="600" style={{ flex: 1 }}>
                  {name}
                </Text>
              </View>
              {detail ? (
                <Text variant="caption" tone="muted">
                  {detail}
                </Text>
              ) : null}
            </View>
          );
        })
      )}

      {note ? (
        <Text variant="caption" tone="muted" style={{ paddingTop: spacing.sm }}>
          {note}
        </Text>
      ) : null}
    </Card>
  );
}
