/**
 * Notification channel definitions — the single source of truth.
 *
 * DELIBERATELY CommonJS. This file is read by BOTH the JS runtime and the Expo
 * config plugin (`plugins/withNotificationChannels.js`), which runs in Node during
 * `prebuild` and cannot import ESM/TS. Ported from the EasyFix app's
 * `src/constants/offerAlert.js` convention.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ANDROID CHANNELS ARE IMMUTABLE AFTER FIRST CREATION.                     │
 * │ Once a channel id exists on a device, its importance, sound and DND      │
 * │ behaviour can never be changed by the app again — only by the user, in   │
 * │ system settings. To change behaviour you MUST bump the id (`_v1`→`_v2`). │
 * │ NEVER edit a channel's properties in place and expect them to take.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * SOUND-THROUGH-SILENT MECHANISM (verified against AOSP):
 *   AudioAttributes.USAGE_ALARM → toLegacyStreamType() → STREAM_ALARM.
 *   Ringer-silent zeroes STREAM_RING and STREAM_NOTIFICATION but never STREAM_ALARM,
 *   so NotificationManagerService.playSound()'s `getStreamVolume(stream) != 0` gate passes.
 *   Separately ZenModeFiltering.isAlarm() matches on USAGE_ALARM, so DND never
 *   intercepts it, and Android 16's Notification Cooldown exempts alarms.
 *   => No ACCESS_NOTIFICATION_POLICY grant and no bypassDnd prompt is required.
 *
 * ⚠️ TRAP: do NOT set `flags.enforceAudibility = true`. It looks like exactly what
 * "sound on silent" needs, but it silently reroutes to STREAM_SYSTEM_ENFORCED, which
 * follows RING volume — permanently reintroducing the bug this design exists to avoid.
 *
 * What still defeats us (documented, not fixable): Total Silence zen mode; an
 * Android 15/16 custom Priority Mode that disallows alarms; alarm stream volume 0;
 * a user-muted channel; a force-stopped process.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ A CHANNEL SOUND PLAYS EXACTLY ONCE. THE RINGING IS NOT DEFINED HERE.     │
 * │ `sound` below is the single chime Android plays when the notification    │
 * │ is posted. There is no channel property, anywhere in the API, that means │
 * │ "keep going until answered" — an app that wants alarm behaviour has to   │
 * │ own an audio player. Aarogya's lives in the native alarm module:         │
 * │ modules/med-alarm/.../AlarmPlayer.kt, which loops ALARM_LOOP_SOUND for   │
 * │ up to ~2 minutes on the `critical` and `standard` tiers.                 │
 * │                                                                          │
 * │ Which tiers ring is decided by `AlarmSpec.ringsAsAlarm` in Kotlin, NOT   │
 * │ by this table. It is "everything except dose_low_v1".                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const USAGE_ALARM = 4;
const USAGE_NOTIFICATION = 5;
const CONTENT_TYPE_SONIFICATION = 4;

/** Android NotificationManager.IMPORTANCE_* */
const IMPORTANCE = {
  HIGH: 4,
  DEFAULT: 3,
  LOW: 2,
};

/** Android Notification.VISIBILITY_* */
const VISIBILITY = {
  PUBLIC: 1,
  PRIVATE: 0,
};

/**
 * Five channels. Criticality tiers map onto the first three; the last two are
 * non-dose traffic that must never borrow a dose channel's urgency.
 */
const CHANNELS = [
  {
    id: 'dose_critical_v1',
    name: 'Critical medicine reminders',
    description:
      'Medicines where a missed dose matters most. Sounds even when the phone is on silent.',
    importance: IMPORTANCE.HIGH,
    sound: 'dose_critical',
    usage: USAGE_ALARM,
    contentType: CONTENT_TYPE_SONIFICATION,
    bypassDnd: true,
    vibration: [0, 400, 200, 400],
    visibility: VISIBILITY.PRIVATE,
    lightColor: '#C62828',
  },
  {
    // Rings like an alarm, as of the Android-14 Xiaomi report. This tier is the DEFAULT
    // for every medicine, so a "standard" reminder is the one an ordinary user actually
    // gets — the earlier design gave the looping/full-screen treatment only to
    // `critical`, which meant in practice that nothing ever got it. See
    // docs/REMINDER-RELIABILITY.md § "Why a dose reminder rings".
    id: 'dose_standard_v1',
    name: 'Medicine reminders',
    description: 'Everyday medicine reminders. Sounds even when the phone is on silent.',
    importance: IMPORTANCE.HIGH,
    sound: 'dose_standard',
    usage: USAGE_ALARM,
    contentType: CONTENT_TYPE_SONIFICATION,
    bypassDnd: true,
    vibration: [0, 300, 200, 300],
    visibility: VISIBILITY.PRIVATE,
    lightColor: '#1565C0',
  },
  {
    // The one dose tier that stays quiet: no looping player, no full-screen intent. It
    // exists so that not everything has to shout — an app that alarms for a vitamin D
    // tablet teaches its user to ignore alarms. Kotlin tests for this exact id
    // (`Const.DOSE_LOW_CHANNEL_ID`), so renaming it makes supplements start ringing.
    id: 'dose_low_v1',
    name: 'Optional medicine reminders',
    description: 'Supplements and as-needed medicines. Follows your normal notification settings.',
    importance: IMPORTANCE.DEFAULT,
    sound: null,
    usage: USAGE_NOTIFICATION,
    contentType: CONTENT_TYPE_SONIFICATION,
    bypassDnd: false,
    vibration: [0, 200],
    visibility: VISIBILITY.PRIVATE,
    lightColor: '#2E7D32',
  },
  {
    id: 'care_v1',
    name: 'Appointments and tests',
    description: 'Doctor visits, test bookings and medicine refills.',
    importance: IMPORTANCE.DEFAULT,
    sound: null,
    usage: USAGE_NOTIFICATION,
    contentType: CONTENT_TYPE_SONIFICATION,
    bypassDnd: false,
    vibration: [0, 200],
    visibility: VISIBILITY.PRIVATE,
    lightColor: '#6A1B9A',
  },
  {
    id: 'system_v1',
    name: 'App health',
    description:
      'Warnings when reminders could not be delivered, and requests from family to view your data.',
    importance: IMPORTANCE.DEFAULT,
    sound: null,
    usage: USAGE_NOTIFICATION,
    contentType: CONTENT_TYPE_SONIFICATION,
    bypassDnd: false,
    vibration: [0, 150],
    visibility: VISIBILITY.PUBLIC,
    lightColor: '#EF6C00',
  },
];

/**
 * The looping alarm tone, by Android raw-resource name (no extension).
 *
 * NOT a channel sound, and deliberately not listed in CHANNELS: it is played by the app's
 * own MediaPlayer (AlarmPlayer.kt), not by NotificationManager, so it is subject to none
 * of the channel-immutability rules above and can be changed by an ordinary update.
 * `plugins/withAlarmReceivers.js` copies `assets/sounds/<name>.wav` into the Android raw
 * resources for it; Kotlin resolves it by this name at runtime.
 *
 * It must be seamlessly loopable — a tone that fades out at the end pulses instead of
 * ringing. `dose_critical` and `dose_standard` both fade, which is why neither is reused
 * here. See scripts/gen-sounds.js.
 */
const ALARM_LOOP_SOUND = 'dose_alarm_loop';

/** Criticality tier → channel id. The tier a medicine carries decides its channel. */
const TIER_TO_CHANNEL = {
  critical: 'dose_critical_v1',
  standard: 'dose_standard_v1',
  low: 'dose_low_v1',
};

const CHANNEL_IDS = CHANNELS.reduce((acc, c) => {
  acc[c.id] = c.id;
  return acc;
}, {});

module.exports = {
  ALARM_LOOP_SOUND,
  CHANNELS,
  CHANNEL_IDS,
  TIER_TO_CHANNEL,
  IMPORTANCE,
  VISIBILITY,
  USAGE_ALARM,
  USAGE_NOTIFICATION,
  CONTENT_TYPE_SONIFICATION,
};
