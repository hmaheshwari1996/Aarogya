const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const { ALARM_LOOP_SOUND } = require('../src/constants/channels.js');

/**
 * Everything the native alarm layer needs from the Android project: its manifest
 * components, and the looping tone it rings.
 *
 * The components are declared here rather than in the local module's own manifest so
 * there is exactly one place that says how they are exported — two manifests describing
 * the same receiver with different android:exported values fails the merge with an error
 * that points at neither file.
 */

const RECEIVER_ALARM = 'in.aarogya.medalarm.DoseAlarmReceiver';
const RECEIVER_ACTION = 'in.aarogya.medalarm.DoseActionReceiver';
const RECEIVER_RESCHEDULE = 'in.aarogya.medalarm.RescheduleReceiver';
const ACTIVITY_FULLSCREEN = 'in.aarogya.medalarm.DoseAlarmActivity';

/**
 * Every broadcast that silently empties AlarmManager.
 *
 * QUICKBOOT_POWERON is the OEM "fast boot" variant used by Xiaomi and HTC, where the
 * device restores from a snapshot and never sends the standard BOOT_COMPLETED. Missing
 * it means alarms come back only after the next real reboot.
 */
const RESCHEDULE_ACTIONS = [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.MY_PACKAGE_REPLACED',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.intent.action.TIME_SET',
  'android.intent.action.DATE_CHANGED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
  'android.intent.action.QUICKBOOT_POWERON',
  'com.htc.intent.action.QUICKBOOT_POWERON',
];

/**
 * Android 11+ package visibility. Without these, PackageManager.resolveActivity() returns
 * null for the OEM security apps and every autostart deep link in OemSettings.kt silently
 * falls back to the generic app-details page. Keep in lockstep with OemSettings.kt.
 */
const QUERY_PACKAGES = [
  'com.miui.securitycenter',
  'com.coloros.safecenter',
  'com.oppo.safe',
  'com.vivo.permissionmanager',
  'com.iqoo.secure',
  'com.samsung.android.lool',
  'com.samsung.android.sm',
  'com.huawei.systemmanager',
  'com.oneplus.security',
  'com.evenwell.powersaving.g3',
  'com.asus.mobilemanager',
  'com.letv.android.letvsafe',
  'com.meizu.safe',
];

function receiver(name, exported, actions) {
  const node = {
    $: {
      'android:name': name,
      'android:enabled': 'true',
      'android:exported': exported ? 'true' : 'false',
    },
  };
  if (actions && actions.length) {
    node['intent-filter'] = [
      { action: actions.map((a) => ({ $: { 'android:name': a } })) },
    ];
  }
  return node;
}

function hasNamed(list, name) {
  return Array.isArray(list) && list.some((n) => n && n.$ && n.$['android:name'] === name);
}

/**
 * Copies the looping alarm tone into `android/app/src/main/res/raw/`.
 *
 * WHY IT LIVES HERE AND NOT IN withDoseSounds.js
 * ----------------------------------------------
 * withDoseSounds copies the sounds that NOTIFICATION CHANNELS name. This one is not a
 * channel sound — it is played by the app's own MediaPlayer (AlarmPlayer.kt) for as long
 * as a dose alarm is ringing. It belongs to the alarm feature, which is what this plugin
 * configures, and putting it in the channel plugin would imply a channel owns it.
 *
 * WHY IT WARNS RATHER THAN THROWS — the opposite of withDoseSounds
 * ---------------------------------------------------------------
 * withDoseSounds hard-fails on a missing file because notification channels are IMMUTABLE
 * after first creation: ship once with the wrong tone and no update can ever fix it. None
 * of that applies here. AlarmPlayer resolves this resource by name on every single alarm,
 * so a missing file means "this build rings with the system alarm tone", which a later
 * update corrects. Failing a build over a recoverable, cosmetic degradation would be the
 * wrong trade — the reminder still rings either way.
 *
 * The copy target is the APP's resources, not the module's, so that `assets/sounds/`
 * stays the single copy of this audio in the repo. A second checked-in copy inside
 * modules/med-alarm would go stale the first time scripts/gen-sounds.js regenerated the
 * originals, silently, and nothing would say so.
 */
const withAlarmLoopSound = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const from = path.join(
        cfg.modRequest.projectRoot,
        'assets',
        'sounds',
        `${ALARM_LOOP_SOUND}.wav`
      );
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'raw'
      );

      if (!/^[a-z][a-z0-9_]*$/.test(ALARM_LOOP_SOUND)) {
        // This one IS fatal: an invalid raw-resource name fails the Android resource
        // compiler with a message that names the file and not the constant behind it.
        throw new Error(
          `[withAlarmReceivers] "${ALARM_LOOP_SOUND}" is not a valid Android raw resource ` +
            'name. Use lowercase letters, digits and underscores only, starting with a letter.'
        );
      }

      if (!fs.existsSync(from)) {
        console.warn(
          `[withAlarmReceivers] ${path.relative(cfg.modRequest.projectRoot, from)} is missing. ` +
            'Dose alarms will ring with the system alarm tone instead of the app tone. ' +
            'Run `node scripts/gen-sounds.js` and re-run prebuild to fix it.'
        );
        return cfg;
      }

      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(from, path.join(destDir, `${ALARM_LOOP_SOUND}.wav`));
      return cfg;
    },
  ]);

const withAlarmManifest = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const application = manifest.application && manifest.application[0];

    if (!application) {
      // Hard throw, never a silent no-op: without these receivers the app builds fine and
      // then stops reminding after the first reboot, which nobody notices for days.
      throw new Error(
        '[withAlarmReceivers] no <application> node in AndroidManifest.xml. Refusing to ' +
          'continue — the alarm receivers would be missing and reminders would stop at ' +
          'the first reboot with no build-time signal at all.'
      );
    }

    // ── permissions ───────────────────────────────────────────────────────────
    // USE_FULL_SCREEN_INTENT is not in app.config.ts because it belongs to this feature,
    // not to the app's distribution policy. On Android 14+ it is DENIED by default for
    // anything that is not a clock or a calling app, at which point setFullScreenIntent()
    // degrades to a heads-up notification — which is why DoseAlarmActivity is gated on
    // canUseFullScreenIntent() at runtime rather than assumed.
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    if (!hasNamed(manifest['uses-permission'], 'android.permission.USE_FULL_SCREEN_INTENT')) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.USE_FULL_SCREEN_INTENT' },
      });
    }

    // ── receivers ─────────────────────────────────────────────────────────────
    application.receiver = application.receiver || [];

    if (!hasNamed(application.receiver, RECEIVER_ALARM)) {
      // exported=false: only AlarmManager, holding our own PendingIntent, can trigger it.
      application.receiver.push(receiver(RECEIVER_ALARM, false));
    }
    if (!hasNamed(application.receiver, RECEIVER_ACTION)) {
      application.receiver.push(receiver(RECEIVER_ACTION, false));
    }
    if (!hasNamed(application.receiver, RECEIVER_RESCHEDULE)) {
      // exported=true is REQUIRED here: BOOT_COMPLETED and friends are system broadcasts,
      // and a non-exported receiver simply never hears them.
      application.receiver.push(receiver(RECEIVER_RESCHEDULE, true, RESCHEDULE_ACTIONS));
    }

    // ── full-screen alarm activity ────────────────────────────────────────────
    application.activity = application.activity || [];
    if (!hasNamed(application.activity, ACTIVITY_FULLSCREEN)) {
      application.activity.push({
        $: {
          'android:name': ACTIVITY_FULLSCREEN,
          'android:exported': 'false',
          // Never in Recents: an alarm screen in the task switcher is confusing, and on
          // MIUI/ColorOS a swipe from Recents is a force-stop that cancels every alarm.
          'android:excludeFromRecents': 'true',
          // Empty affinity keeps it out of the app's main task, so dismissing the alarm
          // never takes the user's actual app session with it.
          'android:taskAffinity': '',
          // `standard`, deliberately. Two critical medicines due at 08:00 produce two
          // screens; a single-instance activity would silently replace the first one's
          // contents and one of the two doses would never be shown.
          'android:launchMode': 'standard',
          'android:showWhenLocked': 'true',
          'android:turnScreenOn': 'true',
          'android:noHistory': 'true',
          'android:screenOrientation': 'portrait',
          // Framework theme, from the med-alarm module's resources. NOT an AppCompat
          // theme — DoseAlarmActivity extends android.app.Activity so it can inflate
          // without any AndroidX machinery being initialised first.
          'android:theme': '@style/Theme.MedAlarm.DoseAlarm',
        },
      });
    }

    // ── package visibility ────────────────────────────────────────────────────
    manifest.queries = manifest.queries || [];
    let queries = manifest.queries[0];
    if (!queries) {
      queries = {};
      manifest.queries.push(queries);
    }
    queries.package = queries.package || [];
    for (const pkg of QUERY_PACKAGES) {
      if (!hasNamed(queries.package, pkg)) {
        queries.package.push({ $: { 'android:name': pkg } });
      }
    }

    return cfg;
  });

/**
 * VIBRATE and WAKE_LOCK are NOT added here — both are already in COMMON_PERMISSIONS in
 * app.config.ts, and both are load-bearing for the ringing: AlarmPlayer vibrates in a
 * repeating waveform alongside the tone, and MediaPlayer.setWakeMode() needs WAKE_LOCK to
 * keep a Doze-idle CPU awake for the length of the ring. USE_FULL_SCREEN_INTENT stays
 * below because, unlike those two, it belongs to this feature alone.
 */
const withAlarmReceivers = (config) => withAlarmManifest(withAlarmLoopSound(config));

module.exports = withAlarmReceivers;
