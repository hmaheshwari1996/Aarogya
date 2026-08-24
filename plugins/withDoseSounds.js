const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const { CHANNELS } = require('../src/constants/channels.js');

/**
 * Copies the dose alert sounds into `android/app/src/main/res/raw/`.
 *
 * WHY THIS PLUGIN HAS TO EXIST, and why it hard-fails rather than warning:
 *
 * The Kotlin channel creator resolves each sound with
 * `resources.getIdentifier(name, "raw", packageName)`. That looks in the compiled
 * Android resource table — NOT in the JS asset bundle. `assetBundlePatterns` in
 * app.config.ts only reaches the JS bundle, so a `.wav` sitting in `assets/sounds/`
 * is invisible to `getIdentifier` and the lookup returns 0.
 *
 * When it returns 0 the channel is created with the default system alarm tone. That
 * would be a cosmetic problem in most apps. Here it is permanent:
 *
 *   ANDROID NOTIFICATION CHANNELS ARE IMMUTABLE AFTER FIRST CREATION.
 *
 * Once a channel exists on her phone with the wrong sound, no app update can change
 * it — the only fix is bumping the channel id to `_v2`, which resets every setting
 * the user may have adjusted, or reinstalling, which erases the only copy of her
 * health history. So a missing sound file at first install is a defect that ships
 * forever. Failing the build is the cheap outcome.
 *
 * (The USAGE_ALARM routing that makes the notification audible through ringer-silent
 * is a property of the channel's audio attributes, not of the file, so that survives
 * either way — but the tone would be wrong and unchangeable.)
 */
const MARKER = 'withDoseSounds';

module.exports = function withDoseSounds(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const platformRoot = cfg.modRequest.platformProjectRoot;

      const srcDir = path.join(projectRoot, 'assets', 'sounds');
      const destDir = path.join(platformRoot, 'app', 'src', 'main', 'res', 'raw');

      // Every channel that names a sound must have that file, or the channel is
      // created wrong and stays wrong.
      const required = [...new Set(CHANNELS.map((c) => c.sound).filter(Boolean))];

      if (required.length === 0) return cfg;

      if (!fs.existsSync(srcDir)) {
        throw new Error(
          `[${MARKER}] assets/sounds/ does not exist, but ${required.length} notification ` +
            `channel(s) reference a custom sound (${required.join(', ')}). ` +
            `Android channels are immutable after first creation — shipping without these ` +
            `files would permanently give every dose reminder the wrong tone.`,
        );
      }

      fs.mkdirSync(destDir, { recursive: true });

      const missing = [];
      for (const name of required) {
        // Android resource names must be lowercase alphanumeric + underscore, and
        // `getIdentifier` is looked up WITHOUT the extension.
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
          throw new Error(
            `[${MARKER}] "${name}" is not a valid Android raw resource name. ` +
              `Use lowercase letters, digits and underscores only, starting with a letter.`,
          );
        }
        const from = path.join(srcDir, `${name}.wav`);
        if (!fs.existsSync(from)) {
          missing.push(`${name}.wav`);
          continue;
        }
        fs.copyFileSync(from, path.join(destDir, `${name}.wav`));
      }

      if (missing.length > 0) {
        throw new Error(
          `[${MARKER}] missing sound file(s) in assets/sounds/: ${missing.join(', ')}. ` +
            `These are referenced by src/constants/channels.js. Channels are immutable ` +
            `after first creation, so this cannot be corrected by a later update.`,
        );
      }

      return cfg;
    },
  ]);
};
