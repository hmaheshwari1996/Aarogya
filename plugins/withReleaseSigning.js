const fs = require('fs');
const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Wires a real release signing config into android/app/build.gradle.
 *
 * ── SECRETS ARE NEVER WRITTEN INTO THE GENERATED FILE ─────────────────────────
 * The passwords are read by GRADLE, from the environment, at build time —
 * `System.getenv(...)` — not interpolated here at prebuild time. android/ is generated
 * output that people do check in when a build breaks, and a keystore password sitting in
 * a build.gradle is a rotation event, not an inconvenience. The environment is consulted
 * twice for different reasons: here, to decide whether to wire the config at all, and at
 * build time, for the actual values.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The `[withReleaseSigning]` marker comment at the top of the file states which of the
 * two happened, so scripts/build-android.sh can assert on it and refuse to ship a
 * "release" APK that is actually signed with the shared debug key — which installs, runs,
 * and can never be updated by a properly signed build afterwards.
 */

const MARKER = '[withReleaseSigning]';

const ENV_KEYS = [
  'AAROGYA_KEYSTORE_PATH',
  'AAROGYA_KEYSTORE_PASSWORD',
  'AAROGYA_KEY_ALIAS',
  'AAROGYA_KEY_PASSWORD',
];

const SIGNING_CONFIG = `
        release {
            // Values come from the environment at BUILD time, not from prebuild. Keep
            // AAROGYA_KEYSTORE_PATH absolute, or relative to android/app/.
            storeFile file(System.getenv("AAROGYA_KEYSTORE_PATH"))
            storePassword System.getenv("AAROGYA_KEYSTORE_PASSWORD")
            keyAlias System.getenv("AAROGYA_KEY_ALIAS")
            keyPassword System.getenv("AAROGYA_KEY_PASSWORD")
            enableV1Signing true
            enableV2Signing true
        }`;

/**
 * Returns { open, close } indices of the brace-delimited block whose header starts at
 * `fromIndex`. Naive brace counting — it does not know about braces inside strings or
 * comments, which is fine for the block headers we look for in Expo's template, and any
 * surprise shows up immediately as a Gradle syntax error rather than as a silent misedit.
 */
function findBlock(src, fromIndex) {
  const open = src.indexOf('{', fromIndex);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

function findBlockByHeader(src, headerRegex, searchFrom = 0) {
  headerRegex.lastIndex = searchFrom;
  const match = headerRegex.exec(src);
  if (!match) return null;
  return findBlock(src, match.index);
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(
        `[withReleaseSigning] expected a Groovy app/build.gradle, got "${cfg.modResults.language}".`
      );
    }

    // Idempotency: prebuild may run mods more than once in a pass, and a second injection
    // would produce two `release { }` signing configs and an unhelpful Gradle error.
    if (cfg.modResults.contents.includes(MARKER)) {
      return cfg;
    }

    const missing = ENV_KEYS.filter((k) => !process.env[k]);

    if (missing.length > 0) {
      // Not an error. A dev-client or debug prebuild has no business holding the release
      // keystore. But the marker records exactly why, so the build script can fail a
      // release build here instead of shipping a debug-signed APK.
      cfg.modResults.contents =
        `// ${MARKER} NOT_WIRED — release builds will use the debug key.\n` +
        `// Missing at prebuild time: ${missing.join(', ')}\n` +
        cfg.modResults.contents;
      return cfg;
    }

    const keystorePath = process.env.AAROGYA_KEYSTORE_PATH;
    if (!fs.existsSync(keystorePath)) {
      // Fail loud: the alternative is a build that "succeeds" and then fails at the
      // signing task with a message about a missing file nobody connects to this plugin.
      throw new Error(
        `[withReleaseSigning] AAROGYA_KEYSTORE_PATH is set to "${keystorePath}" but no file ` +
          'exists there. Refusing to wire a signing config that cannot work.'
      );
    }

    let contents = cfg.modResults.contents;

    // 1. Add the release signingConfig.
    const signingConfigs = findBlockByHeader(contents, /signingConfigs\s*\{/g);
    if (!signingConfigs) {
      throw new Error(
        '[withReleaseSigning] could not find the `signingConfigs { }` block in ' +
          'android/app/build.gradle. Refusing to continue — a silently unsigned release ' +
          'build installs fine and can never be updated afterwards.'
      );
    }
    contents =
      contents.slice(0, signingConfigs.open + 1) +
      SIGNING_CONFIG +
      contents.slice(signingConfigs.open + 1);

    // 2. Point the release buildType at it. Scoped to the release block inside buildTypes
    //    so the debug block's identical line is left alone.
    const buildTypes = findBlockByHeader(contents, /buildTypes\s*\{/g);
    if (!buildTypes) {
      throw new Error(
        '[withReleaseSigning] could not find the `buildTypes { }` block in ' +
          'android/app/build.gradle.'
      );
    }
    const releaseBlock = findBlockByHeader(contents, /\brelease\s*\{/g, buildTypes.open);
    if (!releaseBlock || releaseBlock.close > buildTypes.close) {
      throw new Error(
        '[withReleaseSigning] could not find the `release { }` build type inside ' +
          '`buildTypes { }`.'
      );
    }

    const before = contents.slice(0, releaseBlock.open + 1);
    let body = contents.slice(releaseBlock.open + 1, releaseBlock.close);
    const after = contents.slice(releaseBlock.close);

    if (/signingConfig\s+signingConfigs\.debug/.test(body)) {
      body = body.replace(
        /signingConfig\s+signingConfigs\.debug/,
        'signingConfig signingConfigs.release'
      );
    } else if (!/signingConfig\s+signingConfigs\.release/.test(body)) {
      body = '\n            signingConfig signingConfigs.release' + body;
    }

    contents = before + body + after;

    cfg.modResults.contents =
      `// ${MARKER} WIRED — release signed from AAROGYA_KEYSTORE_* at build time.\n` +
      contents;

    return cfg;
  });

module.exports = withReleaseSigning;
