/**
 * The Reminder Health Check.
 *
 * ─── WHY THIS SCREEN EXISTS ───────────────────────────────────────────────────
 * On the handsets this app runs on, a reminder that never arrives is the DEFAULT
 * failure mode, and it is SILENT. An OEM battery manager kills the process, a channel
 * gets muted from the notification shade by accident, the alarm stream sits at zero,
 * autostart was never granted — and the app looks perfectly healthy while no dose
 * reminder has fired for a week. Nobody finds out until a doctor asks.
 *
 * So this screen exists to make that silence audible. Nine preconditions, each of which
 * — when wrong — GUARANTEES a reminder cannot reach her. Not one of them proves a
 * reminder WILL arrive: there is no Android API that answers "will my 08:00 alarm ring
 * tomorrow". That is why the test-fire at the bottom is not a nicety. It is the only
 * genuine end-to-end evidence in the whole app.
 *
 * ─── WHAT THE TODAY BANNER IS ALLOWED TO SAY ──────────────────────────────────
 * The amber banner on Today reads `health_check_result` — every row of it — through
 * `loadReminderHealth()`, and lights whenever ANY row is `ok = 0`. That table is a
 * key-value store with no expiry and no schema of its own, which gives it three ways to
 * light a warning that the user can never turn off. All three were live, and all three
 * are closed here:
 *
 *   1. AN ORPHAN KEY. An earlier build of this screen wrote rows under keys this build
 *      no longer produces — `boot` and `delivery` (their strings are still sitting in
 *      src/i18n/*.json). `delivery` counted `delivery_probe` rows whose `delivered_epoch`
 *      was still NULL, and NOTHING IN THIS CODEBASE HAS EVER CALLED `markProbeDelivered`,
 *      so it failed on every phone the moment a single dose was armed. A row nobody
 *      writes any more is a row nobody can ever repair: re-running the check does not
 *      touch it, and the screen shows no card for it, so the user is told "Reminders are
 *      working" here and warned on Today at the same time. That is exactly the report
 *      that led to this rewrite. `OWNED_HEALTH_KEYS` + `pruneHealthRows` delete anything
 *      this build cannot rewrite, every single run.
 *
 *   2. A ROW THAT DISAGREES WITH ITS OWN CARD. `persistOk` used to be a free-form field
 *      set independently of `state`, and the `armed` row set it from `horizonIsStale`
 *      even while the card said "there are no medicine timings yet". Amber on Today,
 *      nothing amber here, no button to press. The field is GONE: what is stored is now
 *      derived from what is drawn — `state !== 'fail'` — so every warning on Today has a
 *      visible amber card here with a Fix button under it, always.
 *
 *   3. EVIDENCE THAT NEVER EXPIRES. "The test reminder did not arrive" is an answer about
 *      the phone as it was configured that day. Kept forever it becomes a permanent
 *      warning that no amount of fixing clears (there is no API to re-verify it — only
 *      another test), and a warning that cannot clear is a warning that gets ignored.
 *      It now expires — see EVIDENCE_WINDOW_DAYS — into an honest "that answer is too old
 *      to count, send another test", never into a silent all-clear.
 *
 * The nine settings checks need none of this: they are re-probed from the phone and
 * rewritten on every focus, so fixing one in system settings clears it on the way back.
 *
 * ─── TONE ─────────────────────────────────────────────────────────────────────
 * Everything here is amber (`colors.attention`), never red. This is the app's OWN
 * delivery failing on the phone's terms; dressing it in the same red as "delete this
 * medicine" teaches her to ignore both. And nothing on this screen may read as "you did
 * something wrong" — every single one of these is the phone getting in the way.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { router } from 'expo-router';
import * as Application from 'expo-application';

import {
  META_LAST_HEALTH_RUN,
  getMeta,
  saveHealthCheckResult,
  setMeta,
  useAsync,
  useProfileId,
  useReloadOnFocus,
  useT,
  type LocalStrings,
} from '@/app/_shared/lib';
import { getDb, queryFirst } from '@/db/repositories/_shared';
import {
  Banner,
  Button,
  Card,
  Icon,
  Screen,
  ScreenHeader,
  Skeleton,
  Text,
  useConfirm,
  useToast,
} from '@/components/ui';
import { TIER_TO_CHANNEL } from '@/constants/channels';
import { reconcile } from '@/features/dosing/reconcile';
import { useDateFormat } from '@/i18n/useDateFormat';
import { spacing } from '@/theme';
import { useTheme } from '@/theme/ThemeProvider';

import MedAlarm, { type MedAlarmHealth } from '../../modules/med-alarm';

// ── channel ids ──────────────────────────────────────────────────────────────
// `src/constants/channels.js` is the single source of truth and is deliberately CommonJS
// (the Expo config plugin reads the same file from Node). Narrowed to a plain record
// here so a renamed tier is a compile error at this call site rather than `undefined`
// silently reaching testFire().
const CHANNEL_TIERS = TIER_TO_CHANNEL as Record<string, string>;
const TEST_CHANNEL_ID: string = CHANNEL_TIERS['standard'] ?? 'dose_standard_v1';
const DOSE_CHANNEL_IDS: ReadonlySet<string> = new Set(Object.values(CHANNEL_TIERS));

/** Android's most restricted app-standby bucket. Anything else is survivable. */
const BUCKET_RESTRICTED = 45;
/** The bucket API does not exist below Android 9. Absent is a PASS, not a failure. */
const BUCKET_UNSUPPORTED = -1;

/**
 * The persisted key for the user's own answer to "did you hear that?".
 *
 * This is the only row on the screen backed by evidence rather than inference, and it is
 * the only one this screen does NOT overwrite on every run — see `TEST_HEARD` below.
 */
const TEST_HEARD_KEY = 'test_heard';
/** Recorded so the Today banner can say "reminders are not in this build" honestly. */
const NATIVE_MODULE_KEY = 'native_module';

/**
 * Every check on this screen, in the order it is drawn, and the exact set of keys the
 * check loop is allowed to write.
 *
 * This exists as a VALUE and not only as a type because it is what `pruneHealthRows`
 * deletes against. A `CheckKey` union alone is erased at compile time and cannot tell the
 * database which of its rows this build is still capable of repairing.
 */
const CHECK_KEYS = [
  'notifications',
  'exactAlarm',
  'battery',
  'autostart',
  'channelSound',
  'dnd',
  'alarmVolume',
  'standbyBucket',
  'armed',
  TEST_HEARD_KEY,
] as const;

type CheckKey = (typeof CHECK_KEYS)[number];

/**
 * Everything this build can write into `health_check_result` — and therefore everything
 * it can also CLEAR.
 *
 * Anything else in that table came from a build that no longer exists. It cannot be
 * re-probed, it has no card on this screen, and it lights the Today banner forever. See
 * point 1 of the file header: `boot` and `delivery` are the two real ones, and `delivery`
 * was stuck false on every phone that ever armed a dose.
 */
const OWNED_HEALTH_KEYS: readonly string[] = [...CHECK_KEYS, NATIVE_MODULE_KEY];

/**
 * How long a test-reminder answer counts for. FOURTEEN DAYS.
 *
 * "I did not hear it" is not a fact about the app, it is a reading of the phone's
 * configuration on the day it was taken — an OEM battery manager, a muted channel, an
 * autostart switch. All three change without telling anyone, and none of them can be
 * re-read afterwards: there is no API, which is the entire reason the manual test exists.
 * So the answer has to be given a shelf life, and the number is a trade between two
 * failures that are NOT symmetric:
 *
 *   • Too SHORT and a genuine, unfixed delivery failure goes quiet while the cause is
 *     still there. This user has active TB; a reminder that silently stops is the failure
 *     this whole screen was built to make audible.
 *   • Too LONG and a user who has already fixed the cause is shown a warning she has no
 *     way to switch off. She then learns that the amber banner means nothing — and the
 *     day it is telling the truth, she does not read it.
 *
 * Fourteen days sits between three fixed points. It is far longer than any fix-then-retest
 * loop (a trip to system settings and a second test is minutes, so nobody working the
 * problem ever has the evidence pulled out from under them). It is shorter than the
 * native side's own HORIZON_STALE_DAYS = 20, so the app never trusts an answer from the
 * user for longer than it trusts its own alarm file. And it fits inside a monthly clinic
 * cycle, so a stale warning cannot survive to the next review appointment.
 *
 * Expiry does NOT mean forgetting. The date of the answer is kept in `app_meta`, and the
 * card goes on saying it, out loud, with the test button under it.
 */
const EVIDENCE_WINDOW_DAYS = 14;
const EVIDENCE_WINDOW_MS = EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * The user's own answer to the one question the phone will not answer.
 *
 * She grants MIUI autostart, comes back, and the row still says "cannot be checked" —
 * which is TRUE and reads as broken, because she just did the thing it asked for and
 * nothing on screen acknowledged it. There is no API to consult, so the only thing that
 * can change is the record of what she says she did. It lives in `app_meta` rather than
 * `health_check_result` because it is an attestation, not a probe: nothing measured it.
 *
 * It is deliberately NOT a green tick, and it is deliberately overridden by a failed test
 * reminder — see `autostartAttested` below. Evidence beats attestation, always.
 */
const AUTOSTART_ATTESTED_KEY = 'autostart_attested_at';

/**
 * The date of a failed test that has since aged out of EVIDENCE_WINDOW_DAYS.
 *
 * Expiring the row without recording this would rewrite history — the screen would say
 * "no test reminder has been sent yet" to someone who sent one and told us it did not
 * arrive. That is a smaller lie than the permanent banner it replaces, but it is still a
 * lie, and this screen does not get to tell those. So the row leaves `health_check_result`
 * (which is what stops the banner) and the date stays here (which is what keeps the card
 * honest). Cleared by the next test of any outcome.
 */
const TEST_EXPIRED_AT_KEY = 'test_failed_expired_at';

/** How long to wait before asking. Long enough for a notification to land and be heard. */
const TEST_ANSWER_DELAY_MS = 2500;

/**
 * Deletes every `health_check_result` row this build cannot repair.
 *
 * Runs before the probe reads anything, on mount and on every focus, because both classes
 * of unclearable row have to be gone BEFORE the Today screen next reads the table:
 *
 *   • Rows under keys this build never writes (see OWNED_HEALTH_KEYS).
 *   • A FAILED test answer older than the evidence window. Only the failed one: a stale
 *     PASS lights nothing, so deleting it would buy nothing and would throw away the date
 *     the card uses to say when it last worked.
 *
 * Deliberately a hard DELETE and not an update to `ok = 1`. `loadReminderHealth()` reads
 * a missing row as "never checked", which is true; writing 1 would claim the check passed,
 * which is not. The distinction is the whole design of this screen.
 *
 * Failure is swallowed by the caller: a screen that will not render because a
 * housekeeping DELETE failed is worse than the banner it was trying to fix.
 */
async function pruneHealthRows(now: number): Promise<void> {
  const db = await getDb();

  // Placeholders are generated from a module-scope constant, never from anything the user
  // or the database supplied, and the values are bound. There is no string interpolation
  // of data here.
  const placeholders = OWNED_HEALTH_KEYS.map(() => '?').join(', ');
  await db.runAsync(
    `DELETE FROM health_check_result WHERE key NOT IN (${placeholders});`,
    [...OWNED_HEALTH_KEYS],
  );

  const cutoff = now - EVIDENCE_WINDOW_MS;
  const staleFail = await queryFirst<{ checked_at_epoch: number }>(
    `SELECT checked_at_epoch FROM health_check_result
       WHERE key = ? AND ok = 0 AND checked_at_epoch < ? LIMIT 1;`,
    [TEST_HEARD_KEY, cutoff],
  );
  if (staleFail) {
    // Order matters: remember the date first, then drop the row. A crash between the two
    // costs a remembered date, never a warning that vanishes with nothing left to explain it.
    await setMeta(TEST_EXPIRED_AT_KEY, String(staleFail.checked_at_epoch));
    await db.runAsync(
      `DELETE FROM health_check_result WHERE key = ? AND ok = 0 AND checked_at_epoch < ?;`,
      [TEST_HEARD_KEY, cutoff],
    );
  }
}

const STRINGS: LocalStrings = {
  'healthCheck.notYourFault': {
    en: 'Everything below is a setting on this phone getting in the way. None of it is something you did wrong.',
    hi: 'नीचे लिखी हर बात इस फोन की कोई सेटिंग है जो बीच में आ रही है। इनमें से कुछ भी आपकी ग़लती नहीं है।',
  },
  'healthCheck.phone': {
    en: 'Phone: {{brand}} {{model}}, Android {{sdk}}',
    hi: 'फोन: {{brand}} {{model}}, एंड्रॉयड {{sdk}}',
  },
  'healthCheck.status.ok': { en: 'Working', hi: 'ठीक है' },
  'healthCheck.status.fix': { en: 'Needs fixing', hi: 'ठीक करना है' },
  'healthCheck.status.unknown': { en: 'Cannot be checked', hi: 'जाँच नहीं सकते' },

  'healthCheck.unavailable.title': {
    en: 'The reminder part of Aarogya is not in this app',
    hi: 'इस ऐप में आरोग्य का रिमाइंडर वाला हिस्सा नहीं है',
  },
  'healthCheck.unavailable.body': {
    en: 'This copy of Aarogya was built without the reminder module, so NOTHING below could be checked. Nothing passed and nothing failed — it was simply not looked at. Ask whoever installed this app for the full version.',
    hi: 'आरोग्य की यह कॉपी रिमाइंडर वाले हिस्से के बिना बनी है, इसलिए नीचे कुछ भी जाँचा नहीं जा सका। न कुछ पास हुआ, न फेल — देखा ही नहीं गया। जिसने यह ऐप लगाया है उनसे पूरा वर्ज़न माँगें।',
  },

  'healthCheck.check.autostart.label': {
    en: 'Starting again after the phone restarts (your phone maker’s own setting)',
    hi: 'फोन दोबारा चालू होने पर अपने आप शुरू होना (आपके फोन बनाने वाले की अपनी सेटिंग)',
  },
  'healthCheck.check.autostart.unknown': {
    en: 'No app on any Android phone can read this setting, so Aarogya cannot check it — not now, not ever. On a {{brand}} phone it has to be switched on by hand, otherwise reminders stop after the phone is switched off and on again. The test at the bottom of this screen is the only way to find out.',
    hi: 'किसी भी एंड्रॉयड फोन में कोई ऐप यह सेटिंग पढ़ नहीं सकता, इसलिए आरोग्य इसे न अभी जाँच सकता है, न कभी। {{brand}} फोन में इसे हाथ से चालू करना पड़ता है, वरना फोन बंद करके चालू करने के बाद रिमाइंडर आना बंद हो जाते हैं। इस पन्ने के नीचे दी गई जाँच ही पता लगाने का एक तरीका है।',
  },
  'healthCheck.check.autostart.unknownNoBrand': {
    en: 'No app on any Android phone can read this setting, so Aarogya cannot check it — not now, not ever. On many phones it has to be switched on by hand, otherwise reminders stop after the phone is switched off and on again. The test at the bottom of this screen is the only way to find out.',
    hi: 'किसी भी एंड्रॉयड फोन में कोई ऐप यह सेटिंग पढ़ नहीं सकता, इसलिए आरोग्य इसे न अभी जाँच सकता है, न कभी। कई फोनों में इसे हाथ से चालू करना पड़ता है, वरना फोन बंद करके चालू करने के बाद रिमाइंडर आना बंद हो जाते हैं। इस पन्ने के नीचे दी गई जाँच ही पता लगाने का एक तरीका है।',
  },
  'healthCheck.check.autostart.fix': { en: 'Open this setting', hi: 'यह सेटिंग खोलें' },
  'healthCheck.check.autostart.attest': {
    en: 'I have turned it on',
    hi: 'मैंने इसे चालू कर दिया है',
  },
  'healthCheck.check.autostart.attested': {
    en: 'You told Aarogya on {{when}} that you had switched this on. Aarogya still cannot read the setting, so this is your answer, not a check. Send a test reminder below to find out whether it worked.',
    hi: 'आपने {{when}} को आरोग्य को बताया था कि आपने इसे चालू कर दिया है। आरोग्य अब भी यह सेटिंग पढ़ नहीं सकता, इसलिए यह आपका जवाब है, कोई जाँच नहीं। यह काम कर रहा है या नहीं, यह जानने के लिए नीचे जाँच वाला रिमाइंडर भेजें।',
  },
  'healthCheck.check.autostart.attestSaved': {
    en: 'Noted. Now send a test reminder to see whether it worked.',
    hi: 'दर्ज कर लिया। अब जाँच वाला रिमाइंडर भेजकर देखें कि यह काम कर रहा है या नहीं।',
  },
  'healthCheck.check.autostart.generic': {
    en: 'Your phone did not offer that screen, so the general app page opened instead. Look there for “Autostart” or “Auto launch”.',
    hi: 'आपके फोन ने वह पन्ना नहीं खोला, इसलिए ऐप का आम पन्ना खुला है। वहाँ “Autostart” या “Auto launch” ढूँढें।',
  },

  'healthCheck.check.channel.failNamed': {
    en: 'The sound for “{{name}}” has been switched off in phone settings. Android does not let Aarogya switch it back on — only you can, in phone settings.',
    hi: '“{{name}}” की आवाज़ फोन की सेटिंग में बंद कर दी गई है। एंड्रॉयड आरोग्य को इसे वापस चालू करने नहीं देता — यह सिर्फ़ आप ही फोन की सेटिंग में कर सकती हैं।',
  },

  'healthCheck.check.dnd.label': { en: 'Do Not Disturb', hi: 'परेशान न करें (Do Not Disturb)' },
  'healthCheck.check.dnd.ok': {
    en: 'Do Not Disturb is not blocking reminders.',
    hi: 'परेशान न करें रिमाइंडर को नहीं रोक रहा है।',
  },
  'healthCheck.check.dnd.fail': {
    en: 'Total Silence is switched on. It stops every sound including alarms, so a reminder will not be heard.',
    hi: 'पूरी ख़ामोशी (Total Silence) चालू है। यह अलार्म समेत हर आवाज़ रोक देती है, इसलिए रिमाइंडर सुनाई नहीं देगा।',
  },

  'healthCheck.check.volume.label': { en: 'Alarm volume', hi: 'अलार्म की आवाज़' },
  'healthCheck.check.volume.ok': {
    en: 'Alarm volume is {{value}} out of {{max}}.',
    hi: 'अलार्म की आवाज़ {{max}} में से {{value}} पर है।',
  },
  'healthCheck.check.volume.fail': {
    en: 'Alarm volume is at zero, so a reminder will arrive silently.',
    hi: 'अलार्म की आवाज़ शून्य पर है, इसलिए रिमाइंडर चुपचाप आएगा।',
  },

  'healthCheck.check.standby.label': {
    en: 'How freely the phone lets Aarogya run',
    hi: 'फोन आरोग्य को कितनी छूट देता है',
  },
  'healthCheck.check.standby.ok': {
    en: 'The phone is letting Aarogya run ({{label}}).',
    hi: 'फोन आरोग्य को चलने दे रहा है ({{label}})।',
  },
  'healthCheck.check.standby.notApplicable': {
    en: 'This version of Android does not hold apps back this way.',
    hi: 'एंड्रॉयड के इस वर्ज़न में ऐप पर इस तरह की रोक नहीं लगती।',
  },
  'healthCheck.check.standby.fail': {
    en: 'The phone has put Aarogya in its most restricted group, so reminders can be held back.',
    hi: 'फोन ने आरोग्य को सबसे ज़्यादा रोक वाले समूह में डाल दिया है, इसलिए रिमाइंडर रुक सकते हैं।',
  },

  'healthCheck.check.armed.label': {
    en: 'Reminders are actually set on the phone',
    hi: 'रिमाइंडर सच में फोन पर लगे हुए हैं',
  },
  'healthCheck.check.armed.ok': {
    en: '{{count}} reminders are set. The next one is on {{when}}.',
    hi: '{{count}} रिमाइंडर लगे हुए हैं। अगला {{when}} को है।',
  },
  'healthCheck.check.armed.noNext': {
    en: 'No next reminder time is set.',
    hi: 'अगले रिमाइंडर का कोई समय तय नहीं है।',
  },
  'healthCheck.check.armed.nothingYet': {
    en: 'There are no medicine timings yet, so there is nothing to remind you about. Once a medicine is added and its timings are confirmed, the reminders are set here.',
    hi: 'अभी दवाई का कोई समय तय नहीं है, इसलिए याद दिलाने को कुछ है ही नहीं। जब कोई दवाई जोड़कर उसके समय पक्के कर दिए जाएँगे, तब रिमाइंडर यहीं लग जाएँगे।',
  },
  'healthCheck.check.armed.noRules': {
    en: 'There are no medicine timings for the app to build reminders from.',
    hi: 'ऐप के पास दवाइयों का कोई समय नहीं है जिससे रिमाइंडर बनाए जा सकें।',
  },
  'healthCheck.check.armed.stale': {
    en: 'The reminder list was last written {{days}} days ago and needs to be set again.',
    hi: 'रिमाइंडर की सूची {{days}} दिन पहले लिखी गई थी और दोबारा लगानी होगी।',
  },
  'healthCheck.check.armed.none': {
    en: 'No reminder is set on the phone at this moment.',
    hi: 'इस समय फोन पर कोई रिमाइंडर लगा हुआ नहीं है।',
  },
  'healthCheck.check.armed.dropped': {
    en: '{{count}} of your medicine timings could not be read by the reminder part of the app. This is a fault inside Aarogya, not anything you did. Please tell whoever set this app up for you.',
    hi: 'आपकी {{count}} दवाइयों के समय रिमाइंडर वाला हिस्सा पढ़ नहीं पाया। यह आरोग्य की अपनी ख़राबी है, आपकी कोई ग़लती नहीं। जिसने यह ऐप आपके लिए लगाया है, उन्हें बताएँ।',
  },
  'healthCheck.check.armed.fix': { en: 'Set the reminders again', hi: 'रिमाइंडर दोबारा लगाएँ' },
  'healthCheck.check.armed.fixed': {
    en: 'The reminders have been set again.',
    hi: 'रिमाइंडर दोबारा लगा दिए गए हैं।',
  },
  'healthCheck.check.armed.fixFailed': {
    en: 'The reminders could not be set again.',
    hi: 'रिमाइंडर दोबारा नहीं लगाए जा सके।',
  },

  // ── the test-reminder row ──────────────────────────────────────────────────
  // This row is the visible face of the `test_heard` key. That key has always been able
  // to light the Today banner; until now it had no card, so the one warning on Today
  // backed by real evidence was the one the user could not see, read or answer.
  'healthCheck.check.test.label': {
    en: 'A real reminder actually arriving',
    hi: 'सच में एक रिमाइंडर का पहुँचना',
  },
  'healthCheck.check.test.never': {
    en: 'No test reminder has been sent from this phone yet, so nothing here has been proved either way. The test at the bottom of this screen is the only thing that can prove it.',
    hi: 'इस फोन से अभी तक कोई जाँच वाला रिमाइंडर नहीं भेजा गया है, इसलिए यहाँ कुछ भी साबित नहीं हुआ — न एक तरफ़, न दूसरी तरफ़। इस पन्ने के नीचे दी गई जाँच ही इसे साबित कर सकती है।',
  },
  'healthCheck.check.test.ok': {
    en: 'A test reminder reached this phone on {{when}}, and you said you heard it.',
    hi: '{{when}} को एक जाँच वाला रिमाइंडर इस फोन तक पहुँचा था, और आपने कहा था कि वह आपको सुनाई दिया।',
  },
  'healthCheck.check.test.stalePass': {
    en: 'The last test reminder arrived on {{when}}, which is more than {{days}} days ago. A phone setting can change on its own in that time, so it is worth sending another one.',
    hi: 'पिछला जाँच वाला रिमाइंडर {{when}} को पहुँचा था, जो {{days}} दिन से भी पहले की बात है। इतने समय में फोन की कोई सेटिंग अपने आप बदल सकती है, इसलिए एक और भेजकर देख लेना ठीक रहेगा।',
  },
  'healthCheck.check.test.fail': {
    en: 'You told Aarogya on {{when}} that a test reminder did not arrive. This is why the home screen is warning you. Sending another test that does arrive is what clears it.',
    hi: 'आपने {{when}} को आरोग्य को बताया था कि जाँच वाला रिमाइंडर नहीं पहुँचा। पहले पन्ने पर चेतावनी इसी वजह से दिख रही है। एक और जाँच वाला रिमाइंडर भेजिए और वह पहुँच जाए, तो यह हट जाएगी।',
  },
  'healthCheck.check.test.expiredFail': {
    en: 'You told Aarogya on {{when}} that a test reminder did not arrive. That was more than {{days}} days ago, so it is no longer being treated as the answer for today and the home screen has stopped warning you about it. Send another test to see where things stand now.',
    hi: 'आपने {{when}} को बताया था कि जाँच वाला रिमाइंडर नहीं पहुँचा। वह {{days}} दिन से भी पहले की बात है, इसलिए अब उसे आज का जवाब नहीं माना जा रहा और पहले पन्ने पर उसकी चेतावनी दिखनी बंद हो गई है। अभी क्या हाल है, यह देखने के लिए एक और जाँच भेजें।',
  },

  'healthCheck.recheck': { en: 'Check again', hi: 'दोबारा जाँचें' },
  'healthCheck.recheckHint': {
    en: 'Looks at every setting on this list again',
    hi: 'इस सूची की हर सेटिंग दोबारा देखता है',
  },
  'healthCheck.rechecked': { en: 'Checked again just now.', hi: 'अभी दोबारा जाँच लिया।' },

  'healthCheck.test.title': { en: 'Test it for real', hi: 'सच में जाँच कर के देखें' },
  'healthCheck.test.body': {
    en: 'This sends a real reminder to this phone right now. It is the only way to be sure the whole chain works — every check above is a guess, because no app can read your phone maker’s autostart setting.',
    hi: 'यह अभी इसी फोन पर सच में एक रिमाइंडर भेजेगा। पूरी कड़ी काम कर रही है या नहीं, पक्का करने का यही एक तरीका है — ऊपर की हर जाँच सिर्फ़ अंदाज़ा है, क्योंकि कोई भी ऐप आपके फोन बनाने वाले की अपने आप शुरू होने वाली सेटिंग नहीं पढ़ सकता।',
  },
  'healthCheck.test.fire': { en: 'Send a test reminder', hi: 'जाँच वाला रिमाइंडर भेजें' },
  'healthCheck.test.question': { en: 'Did you hear that?', hi: 'क्या आपको वह सुनाई दिया?' },
  'healthCheck.test.questionBody': {
    en: 'A reminder was just sent to this phone. Tap Yes if you heard a sound or saw it appear at the top of the screen.',
    hi: 'अभी-अभी इस फोन पर एक रिमाइंडर भेजा गया है। अगर आवाज़ सुनाई दी या ऊपर सूचना दिखी, तो “हाँ” दबाएँ।',
  },
  'healthCheck.test.heardYes': {
    en: 'Good — reminders can reach this phone.',
    hi: 'अच्छा — रिमाइंडर इस फोन तक पहुँच सकते हैं।',
  },
  'healthCheck.test.heardNoTitle': {
    en: 'The test reminder did not arrive',
    hi: 'जाँच वाला रिमाइंडर नहीं पहुँचा',
  },
  'healthCheck.test.heardNoBody': {
    en: 'Two things stop it most often: the autostart setting your phone maker controls, and the reminder sound. Both are in the list above — try those two first.',
    hi: 'सबसे ज़्यादा दो चीज़ें इसे रोकती हैं: आपके फोन बनाने वाले की अपने आप शुरू होने वाली सेटिंग, और रिमाइंडर की आवाज़। दोनों ऊपर की सूची में हैं — पहले वही दो देखें।',
  },
  'healthCheck.test.failed': {
    en: 'The test reminder could not be sent.',
    hi: 'जाँच वाला रिमाइंडर भेजा नहीं जा सका।',
  },
  'healthCheck.openFailed': {
    en: 'That settings page could not be opened on this phone.',
    hi: 'इस फोन पर वह सेटिंग का पन्ना नहीं खुल सका।',
  },
  'healthCheck.openedGeneric': {
    en: 'That exact page could not be opened, so Aarogya’s own settings page opened instead.',
    hi: 'वह ख़ास पन्ना नहीं खुल सका, इसलिए आरोग्य का अपना सेटिंग पन्ना खुल गया है।',
  },
};

/**
 * `unknown` is a first-class state, not a shade of failure. Two checks can be unknown —
 * autostart permanently, because no API reports it, and the test row until a test has
 * been sent — and pretending otherwise in either direction would be a lie: green would
 * claim a guarantee, red would claim a fault we cannot see.
 *
 * `unknown` NEVER lights the Today banner. See `persistedOk`.
 */
type CheckState = 'pass' | 'fail' | 'unknown';

/**
 * What gets stored for a check — and therefore what Today is allowed to warn about.
 *
 * DERIVED, never declared. This used to be a `persistOk` field each check set for itself,
 * and the `armed` row set it from `horizonIsStale` while its own card read "there are no
 * medicine timings yet": amber on Today, nothing amber here, no button anywhere to press.
 * Deriving it from the state that is DRAWN makes that class of bug unrepresentable — if
 * Today is warning, there is an amber card with a Fix button on this screen, always.
 */
function persistedOk(check: Check): boolean {
  return check.state !== 'fail';
}

type Check = {
  key: CheckKey;
  title: string;
  detail: string;
  state: CheckState;
  /**
   * This row's stored value is EVIDENCE the user gave us, not something the probe
   * measured, so the check loop must not overwrite it — and must not refresh its
   * timestamp, which is what the evidence window is measured from. Only `runTest` writes
   * it, and only `pruneHealthRows` expires it.
   */
  selfPersisted?: boolean;
  /**
   * Overrides the word above the detail. Set on exactly one row: the default word for
   * `unknown` is "Cannot be checked", which is true of autostart and a plain untruth
   * about the test reminder — that one CAN be checked, by pressing the button on the card
   * that would be saying it.
   */
  statusWord?: string;
  fixLabel: string;
  onFix: () => void | Promise<void>;
  /**
   * A second sentence under the detail, carrying something the USER told us rather than
   * something the phone did. Never persisted — `detail` is what the Today banner reads.
   */
  note?: string;
  /** A lesser action beside the fix. Only the uncheckable row has one. */
  secondaryLabel?: string;
  onSecondary?: () => void | Promise<void>;
  /**
   * The user has answered a question the app cannot answer itself. Drops the row out of
   * amber into neutral — it does NOT make it a tick, because nothing was verified.
   */
  attested?: boolean;
};

/** The stored answer to "did you hear that?", or null when there is none that still counts. */
type LastTest = { heard: boolean; at: number };

type Probe = {
  health: MedAlarmHealth | null;
  /**
   * Null means no test has been sent, OR the last one failed longer ago than the evidence
   * window and `pruneHealthRows` has already retired it. `expiredFailAt` tells those two
   * apart for the card; nothing else needs to.
   */
  lastTest: LastTest | null;
  /** Epoch of a failed test that has aged out. Null when there has never been one. */
  expiredFailAt: number | null;
  /** Epoch of "I have turned it on", or null when she has never said it. */
  autostartAttestedAt: number | null;
  at: number;
};

/**
 * Opens an Android settings screen by intent.
 *
 * The three-way result exists so the caller can be HONEST about where the user actually
 * landed. A fallback to the app's own settings page is useful, but telling her the Do
 * Not Disturb page opened when it did not is exactly the class of small lie this whole
 * screen is written to avoid.
 */
type OpenOutcome = 'exact' | 'fallback' | 'none';

async function openIntent(
  action: string,
  extras?: { key: string; value: string | number | boolean }[],
): Promise<OpenOutcome> {
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent(action, extras);
      return 'exact';
    } catch {
      /* falls through to the app's own settings page */
    }
  }
  try {
    await Linking.openSettings();
    return 'fallback';
  } catch {
    return 'none';
  }
}

/**
 * `setTimeout` that cannot outlive the screen, with the ref sealed inside it.
 *
 * The handle has to survive re-renders, so it has to live in a ref. But `runTest` is now
 * the test row's Fix action, which means it travels inside the `checks` array and is
 * touched by the `.map()` and `.filter()` that render it — and `react-hooks/refs` refuses,
 * correctly, to let anything reachable from render read a ref. Sealing the ref in here
 * leaves `runTest` with no ref access at all, and buys the cleanup for free: a pending
 * "did you hear that?" prompt is cancelled if she leaves the screen, rather than firing a
 * dialog at an unmounted component.
 */
function useDeferred(): (fn: () => void, delayMs: number) => void {
  const handle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (handle.current) clearTimeout(handle.current);
    },
    [],
  );
  return useCallback((fn: () => void, delayMs: number) => {
    if (handle.current) clearTimeout(handle.current);
    handle.current = setTimeout(fn, delayMs);
  }, []);
}

export default function ReminderHealthScreen() {
  const t = useT(STRINGS);
  const { formatEpoch } = useDateFormat();
  const toast = useToast();
  const confirm = useConfirm();
  const profile = useProfileId();

  const [testing, setTesting] = useState(false);
  const [testFailed, setTestFailed] = useState(false);
  const [fixingArmed, setFixingArmed] = useState(false);
  const askAfterDelay = useDeferred();

  const probe = useAsync<Probe>(async () => {
    const at = Date.now();

    // FIRST, before anything is read. Housekeeping is not allowed to take the screen down
    // — every row can still be shown and every Fix button still works without it — but it
    // has to happen before the read, or this run persists results alongside rows it was
    // supposed to have deleted and the Today banner stays lit for one more visit.
    try {
      await pruneHealthRows(at);
    } catch (error) {
      console.warn('[reminder-health] could not prune unrepairable check rows', error);
    }

    const [health, testRow, attested, expired] = await Promise.all([
      MedAlarm.probeHealth().catch(() => null),
      queryFirst<{ ok: number; checked_at_epoch: number }>(
        `SELECT ok, checked_at_epoch FROM health_check_result WHERE key = ? LIMIT 1;`,
        [TEST_HEARD_KEY],
      ).catch(() => null),
      getMeta(AUTOSTART_ATTESTED_KEY).catch(() => null),
      getMeta(TEST_EXPIRED_AT_KEY).catch(() => null),
    ]);

    // A missing row means "never tested", which is not a failure — only an explicit
    // "no, I did not hear it" is. After the prune it can also mean "the last no is older
    // than the evidence window", which is likewise not a failure we may still assert.
    const lastTest: LastTest | null = testRow
      ? { heard: testRow.ok === 1, at: testRow.checked_at_epoch }
      : null;

    // An unparseable or empty stored value degrades to "never said it", which is the
    // amber-and-ask state — never to a silent all-clear.
    const epochOrNull = (raw: string | null): number | null => {
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };

    return {
      health,
      lastTest,
      expiredFailAt: epochOrNull(expired),
      autostartAttestedAt: epochOrNull(attested),
      at,
    };
  }, []);

  const { reload } = probe;
  // EVERY row is re-probed on focus, not just on mount. Returning from the system
  // settings app — which is where all nine Fix buttons send the user — is the single
  // moment on this screen at which an answer can have changed, and a screen that only
  // probed once looks frozen at exactly that moment. `useReloadOnFocus` is
  // `useFocusEffect` underneath.
  useReloadOnFocus(reload);

  // Focus alone is not enough: the whole point of the Fix buttons is that the user
  // leaves for the system settings app and comes back, and on some OEM skins the route
  // is still mounted and focused when she returns, so no focus event fires. `active` is
  // the event that always does.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    return () => subscription.remove();
  }, [reload]);

  const health = probe.data?.health ?? null;
  const lastTest = probe.data?.lastTest ?? null;
  const expiredFailAt = probe.data?.expiredFailAt ?? null;
  // The instant this probe ran, and the clock the evidence window is measured against.
  // Zero rather than Date.now() when there is no probe yet: a fresh value on every render
  // would re-run the checks memo continuously, and there is nothing to measure until the
  // probe resolves — `checks` returns [] while `health` is null anyway.
  const at = probe.data?.at ?? 0;
  // "Not tested" and "tested too long ago" both read as OK here, because neither is a
  // claim that anything failed. The test row's own card is where that distinction is
  // spelled out and where the button that resolves it lives.
  const heardOk = lastTest === null || lastTest.heard;
  const autostartAttestedAt = probe.data?.autostartAttestedAt ?? null;
  // A test reminder that did not arrive is EVIDENCE, and it outranks what she was told to
  // expect from a settings screen. So the attestation stops counting the moment a test
  // fails, and counts again after one succeeds.
  const autostartAttested = autostartAttestedAt !== null && heardOk;

  const fixNotifications = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch {
      toast.show({ message: t('healthCheck.openFailed'), variant: 'error' });
    }
  }, [t, toast]);

  const reportOutcome = useCallback(
    (outcome: OpenOutcome) => {
      if (outcome === 'fallback') {
        toast.show({ message: t('healthCheck.openedGeneric'), variant: 'info' });
      } else if (outcome === 'none') {
        toast.show({ message: t('healthCheck.openFailed'), variant: 'error' });
      }
    },
    [t, toast],
  );

  const fixChannel = useCallback(
    async (channelId: string) => {
      const packageName = Application.applicationId;
      if (!packageName) {
        await fixNotifications();
        return;
      }
      // Deep-links to the ONE channel that is muted. The app's own notification page
      // lists five channels with near-identical names, which is where a user gives up.
      reportOutcome(
        await openIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
          { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
          { key: 'android.provider.extra.CHANNEL_ID', value: channelId },
        ]),
      );
    },
    [fixNotifications, reportOutcome],
  );

  const fixAutostart = useCallback(() => {
    const opened = MedAlarm.openOemAutostartSettings();
    if (!opened) {
      // The native side returns false when no manufacturer screen matched and it fell
      // back to the generic app-details page. Saying "opened" here would tell her she
      // has seen a setting she has not.
      toast.show({ message: t('healthCheck.check.autostart.generic'), variant: 'info' });
    }
  }, [t, toast]);

  const attestAutostart = useCallback(async () => {
    try {
      await setMeta(AUTOSTART_ATTESTED_KEY, String(Date.now()));
      toast.show({ message: t('healthCheck.check.autostart.attestSaved'), variant: 'success' });
      reload();
    } catch {
      toast.show({ message: t('errors.saveFailed'), variant: 'error' });
    }
  }, [t, toast, reload]);

  /**
   * Re-arm every alarm from the confirmed schedules.
   *
   * Every exit from here says something. A button on this screen that can be pressed and
   * produce no word at all is the exact defect this function was rewritten for: with no
   * profile loaded it used to return silently, which on the phone looked like a dead
   * button, and a dead button on the reminder screen reads as a dead app.
   */
  const fixArmed = useCallback(async () => {
    if (fixingArmed) return;
    const profileId = profile.data;
    if (!profileId) {
      toast.show({ message: t('healthCheck.check.armed.fixFailed'), variant: 'error' });
      return;
    }
    setFixingArmed(true);
    try {
      await reconcile(profileId);
      toast.show({ message: t('healthCheck.check.armed.fixed'), variant: 'success' });
      reload();
    } catch {
      toast.show({ message: t('healthCheck.check.armed.fixFailed'), variant: 'error' });
    } finally {
      setFixingArmed(false);
    }
  }, [profile.data, fixingArmed, t, toast, reload]);

  /** Where "there is nothing to remind you about yet" actually leads. */
  const goAddMedicine = useCallback(() => {
    router.push('/(tabs)/medicines');
  }, []);

  const recheck = useCallback(() => {
    reload();
    toast.show({ message: t('healthCheck.rechecked'), variant: 'info' });
  }, [reload, t, toast]);

  /**
   * Fire a real reminder and record what she says about it.
   *
   * Declared above `checks` because the test row's Fix button calls it — this is the one
   * check on the screen whose repair is not a trip to system settings, and the row that
   * lights the Today banner has to carry the button that clears it.
   */
  const runTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestFailed(false);
    try {
      await MedAlarm.testFire(TEST_CHANNEL_ID);
    } catch {
      toast.show({ message: t('healthCheck.test.failed'), variant: 'error' });
      setTesting(false);
      return;
    }

    askAfterDelay(() => {
      void (async () => {
        // Closing this without answering resolves false, i.e. "not heard". That is
        // deliberate: a false alarm costs one more test, a false pass costs a dose.
        const heard = await confirm({
          title: t('healthCheck.test.question'),
          message: t('healthCheck.test.questionBody'),
          confirmLabel: t('common.yes'),
          cancelLabel: t('common.no'),
        });
        const now = Date.now();
        try {
          await saveHealthCheckResult(TEST_HEARD_KEY, heard, null, now);
          // A fresh answer of EITHER outcome supersedes the expired one, so the card must
          // stop mentioning it. Leaving it would put a sentence about a failure from last
          // month underneath a test that just succeeded.
          await setMeta(TEST_EXPIRED_AT_KEY, '');
          // NOTE: a failed test no longer writes `ok = 0` to the `autostart` key. It used
          // to, and that was the row's only way of reaching Today — which meant the
          // warning was carried by a card permanently labelled "cannot be checked", with
          // no button that could clear it and no mention of the test that set it. The
          // verdict now lives on its own row, under its own key, with the retest button
          // on it. Autostart stays what it honestly is: unreadable.
          await setMeta(META_LAST_HEALTH_RUN, String(now));
        } catch (error) {
          console.warn('[reminder-health] could not store the test result', error);
        }
        setTestFailed(!heard);
        if (heard) toast.show({ message: t('healthCheck.test.heardYes'), variant: 'success' });
        setTesting(false);
        reload();
      })();
    }, TEST_ANSWER_DELAY_MS);
  }, [testing, confirm, t, toast, reload, askAfterDelay]);

  const checks = useMemo<Check[]>(() => {
    if (!health) return [];

    const fix = t('healthCheck.fixIt');
    const openPhoneSettings = t('healthCheck.openSettings');

    // 1 ── permission to show reminders at all
    const notifications: Check = {
      key: 'notifications',
      title: t('healthCheck.check.notifications.label'),
      state: health.notificationsEnabled ? 'pass' : 'fail',
      detail: health.notificationsEnabled
        ? t('healthCheck.check.notifications.ok')
        : t('healthCheck.check.notifications.fail'),
      fixLabel: fix,
      onFix: fixNotifications,
    };

    // 2 ── exact alarms
    const exactAlarm: Check = {
      key: 'exactAlarm',
      title: t('healthCheck.check.exactAlarm.label'),
      state: health.canScheduleExactAlarms ? 'pass' : 'fail',
      detail: health.canScheduleExactAlarms
        ? t('healthCheck.check.exactAlarm.ok')
        : t('healthCheck.check.exactAlarm.fail'),
      fixLabel: fix,
      onFix: () => MedAlarm.openExactAlarmSettings(),
    };

    // 3 ── Doze / battery optimisation
    const battery: Check = {
      key: 'battery',
      title: t('healthCheck.check.battery.label'),
      state: health.isIgnoringBatteryOptimizations ? 'pass' : 'fail',
      detail: health.isIgnoringBatteryOptimizations
        ? t('healthCheck.check.battery.ok')
        : t('healthCheck.check.battery.fail'),
      fixLabel: fix,
      onFix: () => MedAlarm.openBatterySettings(),
    };

    // 4 ── OEM autostart. PERMANENTLY UNKNOWN, ON SCREEN AND IN THE DATABASE.
    //
    // There is no Android API — public, hidden or otherwise — that reports whether a
    // manufacturer's autostart whitelist contains this app. So the row is rendered as
    // "cannot be checked", always, and never as a tick.
    //
    // It used to persist `ok = heardOk`, i.e. it stood in for the test verdict so that a
    // failed test could reach the Today banner. That is why the banner could not be
    // cleared: the row carrying the warning was the one row on the screen that is
    // permanently labelled "cannot be checked", whose Fix button opens a settings page
    // that cannot change what is stored, and whose card never mentioned the test at all.
    // A user could fix autostart, come back, and watch nothing happen — which is report 3
    // word for word. The verdict now lives on the test row, which says what it is and
    // carries the button that resolves it. `unknown` stores `ok = 1`: the app has no
    // finding here, and "no finding" is not a failure.
    //
    // "I have turned it on" is the one thing this row can honestly gain. It records HER
    // answer, drops the row out of amber, and changes nothing about the check itself:
    // the state stays `unknown`, the wording still says no app can read this setting, and
    // the note it adds points at the test reminder as the only real proof there is.
    const autostart: Check = {
      key: 'autostart',
      title: t('healthCheck.check.autostart.label'),
      state: 'unknown',
      detail: health.manufacturer
        ? t('healthCheck.check.autostart.unknown', { brand: health.manufacturer })
        : t('healthCheck.check.autostart.unknownNoBrand'),
      note:
        autostartAttested && autostartAttestedAt !== null
          ? t('healthCheck.check.autostart.attested', { when: formatEpoch(autostartAttestedAt) })
          : undefined,
      fixLabel: t('healthCheck.check.autostart.fix'),
      onFix: fixAutostart,
      secondaryLabel: autostartAttested ? undefined : t('healthCheck.check.autostart.attest'),
      onSecondary: autostartAttested ? undefined : attestAutostart,
      attested: autostartAttested,
    };

    // 5 ── a muted or silenced dose channel
    const brokenChannels = health.channels.filter(
      (channel) =>
        DOSE_CHANNEL_IDS.has(channel.id) &&
        (channel.importance === 0 || channel.muted || !channel.hasSound),
    );
    const firstBroken = brokenChannels[0];
    const channelSound: Check = {
      key: 'channelSound',
      title: t('healthCheck.check.channel.label'),
      state: firstBroken ? 'fail' : 'pass',
      detail: firstBroken
        ? brokenChannels
            .map((channel) =>
              t('healthCheck.check.channel.failNamed', { name: channel.name || channel.id }),
            )
            .join(' ')
        : t('healthCheck.check.channel.ok'),
      fixLabel: fix,
      // Deep-links to that exact channel's page. Android channels are immutable once
      // created, so this is not a setting the app can restore on her behalf — the trip
      // to system settings is the only repair there is.
      onFix: () => fixChannel(firstBroken ? firstBroken.id : TEST_CHANNEL_ID),
    };

    // 6 ── Total Silence, the one DND state USAGE_ALARM cannot defeat
    const dndOk = !health.isTotalSilence;
    const dnd: Check = {
      key: 'dnd',
      title: t('healthCheck.check.dnd.label'),
      state: dndOk ? 'pass' : 'fail',
      detail: dndOk ? t('healthCheck.check.dnd.ok') : t('healthCheck.check.dnd.fail'),
      fixLabel: openPhoneSettings,
      onFix: async () => reportOutcome(await openIntent('android.settings.ZEN_MODE_SETTINGS')),
    };

    // 7 ── alarm stream at zero
    const volumeOk = !health.alarmVolumeIsZero;
    const alarmVolume: Check = {
      key: 'alarmVolume',
      title: t('healthCheck.check.volume.label'),
      state: volumeOk ? 'pass' : 'fail',
      detail: volumeOk
        ? t('healthCheck.check.volume.ok', {
            value: health.alarmVolume,
            max: health.alarmVolumeMax,
          })
        : t('healthCheck.check.volume.fail'),
      fixLabel: openPhoneSettings,
      onFix: async () => reportOutcome(await openIntent('android.settings.SOUND_SETTINGS')),
    };

    // 8 ── app standby bucket. -1 means the API does not exist on this Android version,
    // which is a PASS: there is no restriction to be in.
    const bucketOk = health.standbyBucket !== BUCKET_RESTRICTED;
    const bucketUnsupported = health.standbyBucket === BUCKET_UNSUPPORTED;
    const standbyBucket: Check = {
      key: 'standbyBucket',
      title: t('healthCheck.check.standby.label'),
      state: bucketOk ? 'pass' : 'fail',
      detail: bucketUnsupported
        ? t('healthCheck.check.standby.notApplicable')
        : bucketOk
          ? t('healthCheck.check.standby.ok', { label: health.standbyBucketLabel })
          : t('healthCheck.check.standby.fail'),
      fixLabel: openPhoneSettings,
      onFix: () => MedAlarm.openBatterySettings(),
    };

    // 9 ── are alarms genuinely armed right now
    //
    // NOTHING SCHEDULED IS A STATE, NOT A FAULT, AND IT IS HANDLED ON PURPOSE HERE.
    // A profile with no confirmed dose schedules has nothing to deliver, so "a reminder
    // may not reach you" is not a claim this app is entitled to make about it — there is
    // no reminder. Calling it a FAILURE lights the amber banner on Today permanently for
    // anyone who tracks only readings, which is precisely how a warning stops being read.
    // Nothing to arm is reported as "nothing to check yet" and stored as a pass.
    const nothingToArm =
      health.horizonRuleCount === 0 && health.horizonDroppedRules === 0 && health.armedCount === 0;

    const armedProblems: string[] = [];
    if (!nothingToArm && health.horizonRuleCount === 0) {
      armedProblems.push(t('healthCheck.check.armed.noRules'));
    }
    // GATED ON `!nothingToArm`, and this is the second half of report 3. `horizonIsStale`
    // is true when the horizon file is older than the native side's HORIZON_STALE_DAYS —
    // AND ALSO when there is no horizon file at all (HorizonStore.ageDays returns -1 for a
    // missing file, and isStale treats a negative age as stale). A phone with no medicines
    // yet, or one whose last publishHorizon call failed, has no file. So this pushed a
    // problem, `armedOk` went false, `persistOk` went false — while the card itself read
    // "Cannot be checked · there are no medicine timings yet" and this screen's own summary
    // said "Reminders are working". Amber on Today, green here, nothing to press. An
    // absent horizon with nothing to put in it is the CORRECT state, not a stale one.
    if (!nothingToArm && health.horizonIsStale) {
      armedProblems.push(
        t('healthCheck.check.armed.stale', { days: Math.max(0, Math.round(health.horizonAgeDays)) }),
      );
    }
    if (!nothingToArm && health.armedCount === 0) {
      armedProblems.push(t('healthCheck.check.armed.none'));
    }
    if (health.horizonDroppedRules > 0) {
      // Dropped rules mean the JS side handed Kotlin something it could not parse. That
      // is our bug, and saying so plainly is the only way it ever gets reported.
      armedProblems.push(
        t('healthCheck.check.armed.dropped', { count: health.horizonDroppedRules }),
      );
    }
    const armedOk = armedProblems.length === 0;
    const armed: Check = {
      key: 'armed',
      title: t('healthCheck.check.armed.label'),
      state: nothingToArm ? 'unknown' : armedOk ? 'pass' : 'fail',
      detail: nothingToArm
        ? t('healthCheck.check.armed.nothingYet')
        : armedOk
        ? t('healthCheck.check.armed.ok', {
            count: health.armedCount,
            when:
              health.nextTriggerAtEpoch > 0
                ? formatEpoch(health.nextTriggerAtEpoch)
                : t('common.unknown'),
          })
        : [
            ...armedProblems,
            health.nextTriggerAtEpoch > 0
              ? t('healthCheck.check.armed.ok', {
                  count: health.armedCount,
                  when: formatEpoch(health.nextTriggerAtEpoch),
                })
              : t('healthCheck.check.armed.noNext'),
          ].join(' '),
      // WITH NOTHING TO ARM, "Set the reminders again" IS A LIE ABOUT WHAT THE BUTTON
      // DOES. There is no schedule to build an alarm from, so re-running reconcile
      // changes nothing on the phone and the tap looks like a dead control — which is
      // exactly what was reported from the device. The button therefore says what the
      // situation actually needs, and goes where that can be done.
      fixLabel: nothingToArm ? t('medicines.add') : t('healthCheck.check.armed.fix'),
      onFix: nothingToArm ? goAddMedicine : fixArmed,
    };

    // 10 ── the only row on this screen backed by evidence instead of inference
    //
    // Everything above is a precondition: when one of them is wrong a reminder CANNOT
    // arrive, but all nine being right proves nothing, because the one setting that most
    // often stops delivery — the manufacturer's autostart list — is unreadable by any app.
    // The test reminder is the only end-to-end proof in the app, and her answer to it is
    // the only finding here she can see change.
    //
    // Three things this row has to get right at once:
    //   • It is the ONLY thing that may light Today on the strength of a failed test. It
    //     therefore has to be visible, has to explain itself, and has to carry the button
    //     that clears it. All three were missing while `test_heard` was a keyless row.
    //   • An answer older than EVIDENCE_WINDOW_DAYS is no longer today's answer. A failed
    //     one has already left the table by the time this runs (pruneHealthRows), leaving
    //     `expiredFailAt` to say so out loud; a passing one is kept and simply softens to
    //     "worth testing again", because a stale pass warns nobody.
    //   • `selfPersisted` keeps the check loop's hands off the row. Rewriting it every
    //     focus would stamp today's date on an answer given weeks ago, and the evidence
    //     would never expire — the exact bug this row exists to end.
    const testStale = lastTest !== null && at - lastTest.at > EVIDENCE_WINDOW_MS;
    const testState: CheckState =
      lastTest === null ? 'unknown' : lastTest.heard ? (testStale ? 'unknown' : 'pass') : 'fail';
    const testDetail =
      lastTest === null
        ? expiredFailAt !== null
          ? t('healthCheck.check.test.expiredFail', {
              when: formatEpoch(expiredFailAt),
              days: EVIDENCE_WINDOW_DAYS,
            })
          : t('healthCheck.check.test.never')
        : !lastTest.heard
          ? t('healthCheck.check.test.fail', { when: formatEpoch(lastTest.at) })
          : testStale
            ? t('healthCheck.check.test.stalePass', {
                when: formatEpoch(lastTest.at),
                days: EVIDENCE_WINDOW_DAYS,
              })
            : t('healthCheck.check.test.ok', { when: formatEpoch(lastTest.at) });

    const deliveryTest: Check = {
      key: TEST_HEARD_KEY,
      title: t('healthCheck.check.test.label'),
      state: testState,
      detail: testDetail,
      selfPersisted: true,
      // Reuses the string the "last checked" line already uses, so there is one phrase in
      // the app for "nobody has looked yet" rather than two that have to stay in step.
      statusWord: testState === 'unknown' ? t('healthCheck.never') : undefined,
      fixLabel: t('healthCheck.test.fire'),
      onFix: runTest,
    };

    return [
      notifications,
      exactAlarm,
      battery,
      autostart,
      channelSound,
      dnd,
      alarmVolume,
      standbyBucket,
      armed,
      deliveryTest,
    ];
  }, [
    health,
    lastTest,
    expiredFailAt,
    at,
    autostartAttested,
    autostartAttestedAt,
    t,
    formatEpoch,
    fixNotifications,
    fixChannel,
    fixAutostart,
    attestAutostart,
    fixArmed,
    goAddMedicine,
    reportOutcome,
    runTest,
  ]);

  // Persist whatever the probe found. The Today screen's amber banner reads exactly
  // these rows, so a run that is not written is a run that never happened.
  const checkedAt = probe.data?.at ?? null;
  useEffect(() => {
    if (checkedAt === null) return;
    let cancelled = false;
    void (async () => {
      try {
        await saveHealthCheckResult(NATIVE_MODULE_KEY, health !== null, null, checkedAt);
        for (const check of checks) {
          if (cancelled) return;
          // The test row is skipped, not because its value would be wrong, but because
          // its TIMESTAMP would: rewriting it here would restamp an answer given weeks
          // ago as given today, and the evidence window would never elapse.
          if (check.selfPersisted) continue;
          // `persistedOk`, never a field of its own. What Today is told is derived from
          // what this screen draws, so the two cannot drift apart — see the file header.
          await saveHealthCheckResult(check.key, persistedOk(check), check.detail, checkedAt);
        }
        await setMeta(META_LAST_HEALTH_RUN, String(checkedAt));
      } catch (error) {
        // A failed write must not take down the screen — the user can still read every
        // row and press every Fix button.
        console.warn('[reminder-health] could not store the check results', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkedAt, checks, health]);

  const failing = checks.filter((check) => check.state === 'fail').length;
  const lastRunLabel =
    checkedAt === null ? t('healthCheck.never') : t('healthCheck.lastRun', { when: formatEpoch(checkedAt) });

  return (
    <Screen variant="scroll" background="bgSunken">
      <ScreenHeader
        title={t('healthCheck.title')}
        subtitle={t('healthCheck.subtitle')}
        onBack={() => router.back()}
      />

      {probe.loading && !probe.data ? (
        <View style={{ gap: spacing.md }}>
          <Skeleton height={96} label={t('a11y.loading')} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </View>
      ) : null}

      {probe.error ? (
        <Banner
          variant="attention"
          title={t('errors.loadFailed')}
          message={probe.error.message}
          actionLabel={t('common.retry')}
          onAction={reload}
        />
      ) : null}

      {probe.data && !health ? (
        <Banner
          variant="attention"
          title={t('healthCheck.unavailable.title')}
          message={t('healthCheck.unavailable.body')}
          actionLabel={t('common.retry')}
          onAction={reload}
        />
      ) : null}

      {health ? (
        <View style={{ gap: spacing.md }}>
          {testFailed ? (
            <Banner
              variant="attention"
              title={t('healthCheck.test.heardNoTitle')}
              message={t('healthCheck.test.heardNoBody')}
            />
          ) : null}

          <Banner
            variant={failing === 0 ? 'info' : 'attention'}
            title={failing === 0 ? t('healthCheck.allGood') : t('healthCheck.problemsFound', { count: failing })}
            message={t('healthCheck.notYourFault')}
          />

          {/* The state on this screen goes stale the instant she changes anything in
              phone settings, and focus does not always fire on an OEM skin that keeps the
              route mounted. So there is always a control that says, plainly, look again.
              It sits above the rows because that is where the reader already is when the
              rows do not match what they just did. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              flexWrap: 'wrap',
            }}
          >
            <Text variant="caption" tone="muted" style={{ flex: 1 }}>
              {lastRunLabel}
            </Text>
            <Button
              title={t('healthCheck.recheck')}
              onPress={recheck}
              variant="secondary"
              size="md"
              loading={probe.loading}
              accessibilityHint={t('healthCheck.recheckHint')}
            />
          </View>

          {/* Exactly the rows in CHECK_KEYS, fixed at module scope — not a query result —
              so this is a bounded render, not an unbounded list needing virtualisation.
              Two of them have a Fix button that works in-app rather than in system
              settings, and both need their spinner. */}
          {checks.map((check) => (
            <CheckCard
              key={check.key}
              check={check}
              busy={
                (check.key === 'armed' && fixingArmed) || (check.key === TEST_HEARD_KEY && testing)
              }
            />
          ))}

          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label">{t('healthCheck.test.title')}</Text>
              <Text variant="body">{t('healthCheck.test.body')}</Text>
              <Button
                title={t('healthCheck.test.fire')}
                onPress={runTest}
                loading={testing}
                size="lg"
                fullWidth
                accessibilityHint={t('a11y.opensDialog')}
              />
            </View>
          </Card>

          {/* For whoever is helping her over the phone: which handset, which Android. */}
          {health.manufacturer || health.model ? (
            <Text variant="caption" tone="muted">
              {t('healthCheck.phone', {
                brand: health.manufacturer,
                model: health.model,
                sdk: health.sdkInt,
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * One check. Green, amber, or — for the one row that can never be either — neutral.
 *
 * NEVER RED: this is the app's delivery failing on the phone's terms, not her mistake.
 *
 * The neutral state exists only for a row the app cannot check and the user has answered
 * herself. It is not a pass and does not carry a tick; it is the amber standing down
 * because there is nothing further to ask her for, with the words still saying that the
 * setting is unreadable and the test reminder is the only proof.
 */
function CheckCard({ check, busy }: { check: Check; busy: boolean }) {
  const { colors } = useTheme();
  const t = useT(STRINGS);

  const passing = check.state === 'pass';
  const attested = check.attested === true && !passing;

  const accent = passing ? colors.success : attested ? colors.textMuted : colors.attention;
  const statusTone = passing ? 'success' : attested ? 'muted' : 'attention';
  const statusWord =
    check.statusWord ??
    (passing
      ? t('healthCheck.status.ok')
      : check.state === 'unknown'
        ? t('healthCheck.status.unknown')
        : t('healthCheck.status.fix'));

  const spoken = [check.title, statusWord, check.detail, check.note]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  return (
    <Card>
      <View style={{ gap: spacing.md }}>
        {/* Title, status and detail are one announcement; the buttons stay their own
            focusable nodes so TalkBack can still reach them. */}
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={spoken}
          style={{ gap: spacing.sm }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Icon name={passing ? 'check' : attested ? 'info' : 'alert'} size={28} color={accent} />
            <Text variant="label" style={{ flex: 1 }}>
              {check.title}
            </Text>
          </View>
          <Text variant="caption" tone={statusTone} weight="600">
            {statusWord}
          </Text>
          <Text variant="body">{check.detail}</Text>
          {check.note ? (
            <Text variant="body" tone="muted">
              {check.note}
            </Text>
          ) : null}
        </View>

        {passing ? null : (
          <View style={{ gap: spacing.md }}>
            <Button
              title={check.fixLabel}
              onPress={() => void check.onFix()}
              variant="secondary"
              size="md"
              loading={busy}
              fullWidth
            />
            {check.secondaryLabel && check.onSecondary ? (
              <Button
                title={check.secondaryLabel}
                onPress={() => {
                  const run = check.onSecondary;
                  if (run) void run();
                }}
                variant="ghost"
                size="md"
                fullWidth
              />
            ) : null}
          </View>
        )}
      </View>
    </Card>
  );
}
