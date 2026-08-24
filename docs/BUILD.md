# Building Aarogya

Android only. Expo SDK 54 / React Native 0.81.5, prebuild (CNG) — `app.config.ts` is the source of
truth and `android/` is disposable generated output.

---

## Prerequisites

| Thing | Version | Why this one |
|---|---|---|
| Node | 22.18+ or 24 | The check scripts and `scripts/seed-dev-data.ts` rely on built-in TypeScript type-stripping and `node:sqlite`. |
| **JDK 21** | exactly 21 | AGP 8.x + Gradle 8.14 need it. Other Java projects on this machine pin **JDK 8**, so the build script resolves 21 explicitly via `/usr/libexec/java_home -v 21` and refuses to run on anything else rather than trusting `PATH`. |
| Android SDK | platform 36, build-tools | `compileSdkVersion`/`targetSdkVersion` are 36 (`app.config.ts` → `expo-build-properties`). `apksigner` comes from build-tools and is used to verify the finished artifact. |
| Disk | ~6 GB free | A clean release build downloads dependencies and runs R8. On a nearly full disk Gradle fails with lock errors that read like corruption but are just `ENOSPC`. |

```bash
npm install
export ANDROID_HOME="$HOME/Library/Android/sdk"   # if not already set
```

---

## Day-to-day

```bash
npm run start          # Metro, against a dev client
npm run android        # expo run:android — debug build onto a connected device
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (flat config, see eslint.config.js)
npm run check:i18n     # en/hi key parity + report.* must be identical + t() keys resolve
npm run check:clinical # banned clinical wording, verdicts, thresholds, advice
npm run check:all      # typecheck + i18n + clinical
npm test               # node --test
```

Generate the assets (both are dependency-free and idempotent; re-running gives byte-identical
output):

```bash
node scripts/gen-icons.js    # assets/images/*.png  — icon, adaptive, splash, notification
node scripts/gen-sounds.js   # assets/sounds/*.wav  — dose_critical, dose_standard
```

Build a realistic development database and prove the dashboard queries still seek their indexes:

```bash
node scripts/seed-dev-data.ts                  # ~24 months, ~3700 doses, ~700 readings
node scripts/seed-dev-data.ts --months=48      # or more, to see where a chart falls over
```

It ends with an `EXPLAIN QUERY PLAN` pass over every dashboard query and **exits non-zero if any of
them degraded to a full table scan**. That is the check worth running after touching a `WHERE`
clause: a partial index stops matching the moment a condition changes, and the resulting scan is
invisible on eleven rows and painful on two years of them.

---

## Release builds

```bash
npm run build:qa         # → build-output/aarogya-qa-<version>-<code>.apk
npm run build:prod       # → build-output/aarogya-prod-<version>-<code>.apk
npm run build:prod:aab   # → …aab, for a Play upload
```

All three call `scripts/build-android.sh <target> <format>`.

**Set the four signing variables first** (see [SIGNING.md](./SIGNING.md)) — the script refuses to
build a release without them, before Gradle starts:

```bash
export AAROGYA_KEYSTORE_PATH="$HOME/keys/aarogya-release.jks"
export AAROGYA_KEYSTORE_PASSWORD='…'
export AAROGYA_KEY_ALIAS='aarogya'
export AAROGYA_KEY_PASSWORD='…'
```

### What the script does, and why each step is there

Every one of these guards exists because the corresponding failure is **silent** — the build
succeeds, the APK installs, and the problem surfaces later on the one phone that holds the only copy
of a person's health record.

1. **Resolves JDK 21 explicitly** and verifies the major version. Trusting `PATH` on a machine that
   also holds JDK 8 projects produces a class-file-version error three minutes into the build.

2. **Exports `AAROGYA_DISTRIBUTION=personal`**, as a real shell variable so it beats any `.env`
   (dotenv never overwrites an already-set variable). `app.config.ts` reads it and it decides the
   **permission set, and nothing else**:

   - `personal` declares `USE_EXACT_ALARM` — auto-granted, not user-revocable — so a dose alarm is
     exact and cannot be switched off by accident. Play restricts this permission to alarm-clock and
     calendar apps, so it is only legal outside the store.
   - `play` falls back to `SCHEDULE_EXACT_ALARM`, which the user **can** revoke, at which point the
     scheduler degrades to `setAndAllowWhileIdle` and the Reminder Health Check starts failing
     loudly.

   Both `qa` and `prod` here are sideloaded family builds, so both are `personal`. These two builds
   are not equally reliable, and that is a policy constraint rather than a bug.

3. **Refuses to run from inside `android/`.** The script deletes that directory, and a shell's
   working directory is bound to the inode, not the path — so deleting it out from under the caller
   strands that shell permanently with `ENOENT: uv_cwd` on every subsequent command, even though the
   build recreates the same path.

4. **Deletes `android/` itself** (guarded on `gradlew` + `app/build.gradle` actually being there)
   rather than relying on `expo prebuild --clean`. When the working tree is dirty, `expo prebuild`
   prompts, and declining makes it `return null` — **it exits 0 having done nothing**. A zero exit
   sails straight past `set -e`, and Gradle then builds the *previous* `android/`: stale manifest,
   stale versionCode, stale signing config — and every later check passes, because the JS bundle is
   rebuilt regardless. Removing the folder first turns that silent no-op into a hard failure.

5. **Asserts the `[withReleaseSigning]` marker is `WIRED`** in the generated `app/build.gradle`. The
   plugin writes `NOT_WIRED` instead of failing when the keystore variables are absent — correct for
   a dev-client, catastrophic for a release.

6. **Asserts `allowBackup="false"`** in the generated manifest before the build, and again in the
   **merged** manifest afterwards (plus `dataExtractionRules`, which is the Android 12+ switch;
   `allowBackup` alone is the half-fix). If `plugins/withNoBackup.js` ever no-ops, the app builds
   fine and quietly uploads a family's medical history to a Google account.

7. **Copies `assets/sounds/*.wav` into `res/raw/`.** `src/constants/channels.js` names two sounds and
   `MainApplication` resolves them with `resources.getIdentifier(name, "raw", packageName)`. Nothing
   in the Expo pipeline puts them there — `assetBundlePatterns` only reaches the JS asset bundle,
   which `getIdentifier` cannot see. Without this, both dose channels are created with the **system
   alarm tone**, and because an Android channel is immutable after first creation, that device keeps
   the wrong tone until the channel id is bumped from `_v1` to `_v2`.
   *This copy is a stopgap; the durable fix is a config plugin alongside the other five.*

8. **Runs `:app:assembleRelease` / `:app:bundleRelease`.**

9. **Verifies the signing certificate of the finished artifact** — `apksigner verify --print-certs`
   for an APK, `keytool -printcert -jarfile` for an AAB, because the two formats are signed
   differently and neither tool reads the other. **Any debug-signed artifact is a hard failure, APK
   or AAB.** There is no "warning, continuing" path: a debug-signed APK sideloaded over the real
   install can never be updated by a properly signed build, and the only way out is uninstall, which
   erases the health record.

10. **Asserts `lib/` contains only `arm64-v8a`**, by reading the shipped zip. `buildArchs` in
    `app.config.ts` is not honoured on every build path, and a second architecture roughly doubles
    the native payload — see [SIZE.md](./SIZE.md).

11. **Prints the size and the largest contributors**, then runs `scripts/check-size.js` against the
    stated budget.

12. **Copies the artifact to `build-output/aarogya-<target>-<version>-<versionCode>.<ext>`.** Gradle
    always writes `app-release.apk`, so a QA and a Prod artifact are indistinguishable once they
    leave the build directory — and they live *inside* `android/`, which the next build deletes, so
    building prod would otherwise destroy the qa artifact you just made.

---

## Troubleshooting

**`ERROR: JDK 21 not found`** — install Temurin or Corretto 21. Do not "fix" this by exporting a
JDK 8 `JAVA_HOME`; the version check will reject it, which is the point.

**`ERROR: release signing is not configured`** — the four `AAROGYA_*` variables are not exported in
*this* shell. See [SIGNING.md](./SIGNING.md).

**`ERROR: withReleaseSigning ran but did NOT wire a release signing config`** — the variables were
missing at *prebuild* time specifically. Export them and re-run from the top; the marker is written
during prebuild, not during the Gradle build.

**`Failed to release lock on …` / `Could not stop all services`** — almost always a full disk.
Gradle's cache-lock errors are what `ENOSPC` looks like from the outside. Check `df -h` before
believing anything about corrupted caches.

**`Daemon disappeared unexpectedly` / `Unable to find method`** — metaspace exhaustion in R8.
`plugins/withGradlePerformance.js` already raises `MaxMetaspaceSize` to 1024m for exactly this; if
you see it anyway, that plugin did not run.

**`ERROR: expected arm64-v8a ONLY`** — `buildArchs` did not take effect. Do not ship it; a second
architecture roughly doubles the native payload.

**Reminders stop after a reboot** — `plugins/withAlarmReceivers.js` did not run, or its receivers
were dropped in the manifest merge. Check `android/app/src/main/AndroidManifest.xml` for
`RescheduleReceiver` with `android:exported="true"`.
