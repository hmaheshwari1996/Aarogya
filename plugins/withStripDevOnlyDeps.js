const { withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Drops development-only transitive dependencies from the RELEASE classpath.
 *
 * THE PROBLEM THIS SOLVES
 *
 * `expo-dev-client` pulls in `expo-dev-launcher`, which depends on ML Kit barcode
 * scanning so the launcher can scan a QR code to attach to a dev server. Expo already
 * keeps dev-launcher's *classes* out of release builds — verified: the release APK
 * contains no `devlauncher`/`devmenu` entries.
 *
 * The native library is not so lucky. `libbarhopper_v3.so` is 4.72 MB of arm64 machine
 * code that ships inside every release APK, for a QR scanner the app never opens and
 * whose calling classes are not even present. On a 33.6 MB APK that is 14% of the
 * download, and this app is deliberately being kept small.
 *
 * Excluding the dependency from `releaseRuntimeClasspath` removes both halves. It is safe
 * precisely because the only code that referenced it is already absent from release —
 * nothing in the shipped app can call into it.
 *
 * WHY NOT JUST DROP expo-dev-client
 *
 * Because this project has a custom native module (`modules/med-alarm`), Expo Go cannot
 * run it — development needs a dev build either way, and the launcher is genuinely useful
 * for attaching to Metro. The cost is dev-time only; the fix is release-only. Keep both.
 *
 * If a QR/barcode feature is ever added to the app itself, delete this plugin — and expect
 * the APK to grow by ~4.7 MB, which will then be weight that is actually earning its place.
 */
const MARKER = '// [withStripDevOnlyDeps]';

const BLOCK = `
${MARKER} Release-only: drop ML Kit barcode scanning, pulled in transitively by
${MARKER} expo-dev-launcher. Its classes are already excluded from release builds, so the
${MARKER} 4.72 MB libbarhopper_v3.so it carries is unreachable dead weight in the APK.
configurations {
    releaseRuntimeClasspath {
        // The scanner UI must go too, not just the engine it calls. Excluding only
        // 'barcode-scanning' leaves play-services-code-scanner behind, still holding
        // references to the classes that just left — and R8 fails the build with
        // "Missing class com.google.mlkit.vision.barcode.common.Barcode".
        exclude group: 'com.google.android.gms', module: 'play-services-code-scanner'
        exclude group: 'com.google.mlkit', module: 'barcode-scanning'
        exclude group: 'com.google.mlkit', module: 'barcode-scanning-common'
        exclude group: 'com.google.android.gms', module: 'play-services-mlkit-barcode-scanning'
    }
}
`;

// Belt and braces for R8. Excluding the modules above should remove both the callers and
// the callees together, but any straggler that still *references* an ML Kit class would
// fail the build rather than warn. These are unreachable in a build with no scanner, so a
// warning is the correct outcome, not an error.
const PROGUARD_MARKER = '# [withStripDevOnlyDeps]';
const PROGUARD_BLOCK = `
${PROGUARD_MARKER} ML Kit barcode scanning is excluded from the release classpath
${PROGUARD_MARKER} (see plugins/withStripDevOnlyDeps.js). Nothing reachable calls it.
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.internal.mlkit_**
`;

module.exports = function withStripDevOnlyDeps(config) {
  const withProguard = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const rules = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro',
      );
      const existing = fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8') : '';
      if (!existing.includes(PROGUARD_MARKER)) {
        fs.writeFileSync(rules, `${existing}\n${PROGUARD_BLOCK}`);
      }
      return cfg;
    },
  ]);

  return withAppBuildGradle(withProguard, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(
        `[withStripDevOnlyDeps] expected a Groovy app/build.gradle, got ` +
          `"${cfg.modResults.language}". The anchor below assumes Groovy syntax.`,
      );
    }

    // Idempotent: prebuild can run more than once against the same file.
    if (cfg.modResults.contents.includes(MARKER)) return cfg;

    // Appending at top level is deliberate. A `configurations { }` block must not be
    // nested inside `android { }`, and appending avoids depending on any anchor string
    // in Expo's template — which is the thing that silently breaks on an SDK bump.
    cfg.modResults.contents = `${cfg.modResults.contents}\n${BLOCK}`;
    return cfg;
  });
};
