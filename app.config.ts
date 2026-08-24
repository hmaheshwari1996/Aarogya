import type { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * DISTRIBUTION decides the permission set, and nothing else in the app may branch on it.
 *
 *  'personal' — sideloaded APK for family. May declare USE_EXACT_ALARM, which is
 *               auto-granted and cannot be revoked by the user, so dose alarms are
 *               exact and unrevocable.
 *  'play'     — Google Play build. USE_EXACT_ALARM is restricted by policy to alarm-clock
 *               and calendar apps; a medication reminder does NOT qualify. We fall back to
 *               SCHEDULE_EXACT_ALARM, which the user can revoke — at which point
 *               canScheduleExactAlarms() goes false, the scheduler degrades to
 *               setAndAllowWhileIdle, and the Reminder Health Check fails loudly.
 *
 * These two builds are NOT equally reliable, and that is a policy constraint, not a bug.
 */
type Distribution = 'personal' | 'play';
const DISTRIBUTION: Distribution =
  (process.env.AAROGYA_DISTRIBUTION as Distribution) ?? 'personal';

/**
 * Host for family-viewer invite links (Android App Links, served free from GitHub Pages).
 *
 * SET THIS to the GitHub account that hosts the repo, e.g. `yourname.github.io`, either by
 * editing the fallback below or by exporting AAROGYA_INVITE_HOST before a build.
 *
 * It is defined once, here, and handed to the app through `extra.inviteHost` — the app must
 * never hardcode it a second time. The two used to be written separately, and they have to
 * agree exactly: Android verifies an App Link by fetching `assetlinks.json` from the host in
 * the manifest, so a link built against a different host simply opens a web page instead of
 * the app, with nothing anywhere reporting a mismatch. A single source makes that
 * impossible rather than merely unlikely.
 *
 * Invites are part of L3 (family sync), which is not configured yet, so the placeholder
 * blocks nothing today — `inviteUrl()` refuses to mint a link while it is still unset.
 */
const INVITE_HOST = process.env.AAROGYA_INVITE_HOST ?? 'REPLACE-ME.github.io';

const COMMON_PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK',
  'android.permission.CAMERA',
  'android.permission.USE_BIOMETRIC',
];

const PERSONAL_ONLY_PERMISSIONS = [
  // Auto-granted, non-revocable. Play-restricted, hence personal-build only.
  'android.permission.USE_EXACT_ALARM',
  // Lets us ask for a Doze exemption directly. Play requires a declaration and
  // rejects it for most categories, so it stays out of the Play build.
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];

const PLAY_ONLY_PERMISSIONS = [
  // User-grantable and user-revocable. The health check surfaces revocation.
  'android.permission.SCHEDULE_EXACT_ALARM',
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Aarogya',
  slug: 'aarogya',
  scheme: 'aarogya',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  assetBundlePatterns: ['**/*'],
  extra: {
    distribution: DISTRIBUTION,
    inviteHost: INVITE_HOST,
    router: {},
  },
  android: {
    package: 'in.aarogya.care',
    // Bump on EVERY build you install anywhere. Android refuses an install whose
    // versionCode is not higher than the one already present, and two different APKs
    // sharing a number is how you end up unsure which one is on the phone.
    versionCode: 10,
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      backgroundColor: '#0E7C6B',
    },
    // allowBackup=false and the dataExtractionRules are applied by
    // plugins/withNoBackup.js — Expo has no first-class config key for them.
    permissions: [
      ...COMMON_PERMISSIONS,
      ...(DISTRIBUTION === 'personal' ? PERSONAL_ONLY_PERMISSIONS : PLAY_ONLY_PERMISSIONS),
    ],
    /**
     * Expo's prebuild template adds these regardless of the `permissions` list above.
     * Nothing in this app records audio, reads audio or video, or draws over other apps.
     *
     * Stripping them is not cosmetic. A health app that asks for the microphone and
     * "display over other apps" reads as spyware to anyone who checks the permission
     * list — which is exactly the audience for an app holding someone's medical
     * history. On Play, each additional sensitive permission is also a separate
     * justification in review.
     *
     * READ_MEDIA_IMAGES deliberately stays: labs/new.tsx and medicine/new.tsx let the
     * user pick an existing photo, so it is genuinely used.
     */
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
    // Verified App Links for viewer invites. assetlinks.json is hosted free on
    // GitHub Pages; see docs/INVITE-LINKS.md.
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: INVITE_HOST, pathPrefix: '/aarogya/v' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-localization',
    'expo-secure-store',
    'expo-dev-client',
    'expo-font',
    [
      'expo-splash-screen',
      /**
       * THESE TWO VALUES ARE `lightColors.bg` AND `darkColors.bg` FROM src/theme/index.ts,
       * COPIED BY HAND. They cannot be imported: this file is evaluated by the Expo CLI in
       * plain Node, outside Metro and outside the module aliases, and the splash is baked
       * into native resources at prebuild rather than read at runtime.
       *
       * They must be re-copied whenever the palette moves. The splash is the last frame
       * before the app's own first frame, so any difference shows as a flash on every cold
       * start — which is what the old cool-grey pair (#F4F7F6 / #101614) did once the
       * palette was retuned to warm neutrals.
       */
      {
        backgroundColor: '#F3F0E9',
        image: './assets/images/splash-logo.png',
        // Wider than the bare mark was: the lockup now carries the wordmark beneath the
        // heart, so 180 would have rendered the name too small to read on a cold start.
        imageWidth: 220,
        resizeMode: 'contain',
        // A SEPARATE DARK LOCKUP, not the same file. The mark alone could be one teal
        // image on transparent — 3:1 against the dark page is fine for a graphic. A WORD
        // cannot live at 3:1, so each theme gets the wordmark in its own primary.
        dark: {
          backgroundColor: '#262220',
          image: './assets/images/splash-logo-dark.png',
          imageWidth: 220,
        },
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Aarogya needs photo access so you can attach a prescription or lab report.',
        cameraPermission: 'Aarogya needs the camera so you can photograph a prescription or lab report.',
      },
    ],
    [
      'expo-media-library',
      {
        // writeOnly keeps READ_MEDIA_IMAGES out of the manifest entirely, which
        // sidesteps Play's Photo & Video Permissions declaration.
        photosPermission: 'Aarogya needs permission to save a report image to your gallery.',
        savePhotosPermission: 'Aarogya needs permission to save a report image to your gallery.',
        isAccessMediaLocationEnabled: false,
      },
    ],
    ['expo-local-authentication', { faceIDPermission: 'Unlock Aarogya.' }],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 26,
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          /**
           * SIZE: arm64 only. This is by far the largest lever on APK size in a React
           * Native app — the native libraries (Hermes, RN core, SQLite, SVG) dominate
           * the payload, and shipping a second architecture roughly doubles them.
           *
           * Safe for the target devices: minSdkVersion is 26 (Android 8), and
           * essentially every 64-bit-capable handset since ~2017 — including every
           * Redmi/Realme model in scope — runs arm64-v8a. Google Play has required a
           * 64-bit build since 2019.
           *
           * If a genuinely 32-bit device ever needs it, add 'armeabi-v7a' back here;
           * nothing else in the project depends on this choice.
           */
          buildArchs: ['arm64-v8a'],
        },
      },
    ],
    // Must run BEFORE withNotificationChannels: the channel creator resolves these
    // sounds by resource id, and a channel created without one is wrong forever.
    './plugins/withDoseSounds',
    './plugins/withNotificationChannels',
    './plugins/withNoBackup',
    './plugins/withAlarmReceivers',
    './plugins/withGradlePerformance',
    './plugins/withStripDevOnlyDeps',
    './plugins/withReleaseSigning',
  ],
  experiments: {
    typedRoutes: true,
  },
});
