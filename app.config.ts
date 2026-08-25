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

/**
 * The shared family-sharing backend, BAKED INTO THE BUILD.
 *
 * Every install talks to the same Supabase project, so nobody is asked to paste a URL and a
 * key — an elderly patient and her daughters cannot reasonably be handed credentials, and a
 * feature that needs setup on four phones is a feature nobody turns on.
 *
 * ─── WHY SHIPPING THIS KEY IS SAFE, AND WHAT IT IS NOT ───────────────────────────────
 * There is no way to HIDE a string in a client app: anything the app can read, so can anyone
 * who unzips the APK. Obfuscating it would buy nothing but the illusion of secrecy. It is
 * shipped in the clear because it is not a secret in the first place:
 *
 *   • The PUBLISHABLE (anon) key is designed to sit in clients. It grants nothing on its own —
 *     every table is row-level-secured and filters on the `X-Share-Id` header, so a request
 *     without a share id sees zero rows.
 *   • A share id is 128 random bits, minted per profile and never published. Guessing one is
 *     the entire attack, and it is not feasible.
 *   • The relay only ever holds CIPHERTEXT. The profile key is wrapped to each member device
 *     and never leaves it, so even someone holding both the anon key and a share id gets
 *     blobs they cannot open. The encryption is the confidentiality boundary — not this key.
 *
 * The DATABASE PASSWORD is a real secret and is NOT here, is not in the repo, and never
 * reaches a device: it lives in `~/.aarogya/supabase.env` and is used only to apply schema.
 *
 * ─── HOW IT GETS IN ──────────────────────────────────────────────────────────────────
 * Injected at build time from the environment (`scripts/build-android.sh` sources
 * `~/.aarogya/supabase.env`), so the credentials are NOT committed to the repository. A build
 * without them still succeeds and simply ships with sharing unconfigured — which is why
 * `build-android.sh` warns loudly rather than failing, and why Settings can still override
 * both values at runtime for a different backend.
 */
const SUPABASE_URL = process.env.AAROGYA_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.AAROGYA_SUPABASE_ANON_KEY ?? '';

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
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    router: {},
  },
  android: {
    package: 'in.aarogya.care',
    // Bump on EVERY build you install anywhere. Android refuses an install whose
    // versionCode is not higher than the one already present, and two different APKs
    // sharing a number is how you end up unsure which one is on the phone.
    versionCode: 13,
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
