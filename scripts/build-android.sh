#!/usr/bin/env bash
#
# Build a RELEASE Android artifact for Aarogya, and then prove things about it.
#
#   scripts/build-android.sh <qa|prod> [apk|aab]
#
# WHY THIS SCRIPT EXISTS
# ──────────────────────
# Every check below exists because the corresponding failure is SILENT: the
# build succeeds, the APK installs, and the problem only appears later, on the
# one phone that holds the only copy of a person's health record.
#
#   • A debug-signed "release" APK installs and runs perfectly. It can then
#     never be updated by a properly signed build — Android refuses the upgrade
#     on a signature mismatch, and the only remaining path is uninstall, which
#     deletes the app's data directory. There is no cloud backup by design
#     (plugins/withNoBackup.js turns off Google Drive backup AND device
#     transfer), so uninstalling erases two years of readings, doses and
#     prescriptions. This is the single worst outcome in the project, and it
#     starts as a missing environment variable.
#
#   • `expo prebuild` exits 0 having done NOTHING when the working tree is
#     dirty and the prompt is declined. Gradle then cheerfully builds the
#     previous android/ folder — stale manifest, stale signing config, stale
#     versionCode — and every downstream check passes because the JS bundle is
#     rebuilt regardless. So android/ is deleted here, by us, first.
#
#   • `buildArchs: ['arm64-v8a']` in app.config.ts is not honoured on every
#     build path. A second architecture roughly doubles the native payload, so
#     the artifact is inspected rather than the config trusted.
#
#   • allowBackup="false" is applied by a config plugin. If that plugin ever
#     silently no-ops, the app builds fine and quietly uploads a family's
#     medical history to a Google account. The merged manifest is checked.
#
# Everything here verifies THE ARTIFACT, not the process that produced it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Caller's cwd, captured BEFORE anything cd's.
#
# This script deletes and regenerates android/. A shell's working directory is
# bound to the INODE, not the path, so invoking this from inside android/
# (typically .../apk/release, after fetching the last APK) leaves the caller's
# shell pointing at a directory that no longer exists — permanently, even though
# the build recreates the same path. Every later command in that shell then dies
# with "ENOENT: uv_cwd", which looks nothing like the actual cause.
INVOKED_FROM="$(pwd -P 2>/dev/null || true)"

TARGET="${1:-}"
FORMAT="${2:-apk}"

case "$TARGET" in
  qa|prod) ;;
  *) echo "usage: $0 <qa|prod> [apk|aab]" >&2; exit 2 ;;
esac
case "$FORMAT" in
  apk|aab) ;;
  *) echo "usage: $0 <qa|prod> [apk|aab]" >&2; exit 2 ;;
esac

ANDROID_DIR="$ROOT/android"

# ── Never delete the directory the caller's shell is standing in ────────────
# Checked FIRST, before anything slower, because it is the most surprising
# failure here and the cheapest to detect.
case "$INVOKED_FROM/" in
  "$ANDROID_DIR"/*)
    echo "ERROR: run this from outside android/ — you are in:" >&2
    echo "         $INVOKED_FROM" >&2
    echo "       This build deletes and regenerates android/, which would leave" >&2
    echo "       your shell with an invalid working directory (ENOENT: uv_cwd on" >&2
    echo "       every later command), permanently — even though the build" >&2
    echo "       recreates the same path, because a shell's cwd is bound to the" >&2
    echo "       inode. Run:" >&2
    echo "         cd $ROOT && npm run build:${TARGET}" >&2
    exit 1
    ;;
esac

# ── Distribution ────────────────────────────────────────────────────────────
#
# app.config.ts reads AAROGYA_DISTRIBUTION and it decides the PERMISSION SET,
# and nothing else:
#
#   personal  declares USE_EXACT_ALARM — auto-granted, not revocable by the
#             user — so a dose alarm is exact and cannot be switched off by
#             accident. Play restricts this permission to alarm-clock and
#             calendar apps, so it is only legal outside the store.
#   play      falls back to SCHEDULE_EXACT_ALARM, which the user CAN revoke, at
#             which point the scheduler degrades and the Reminder Health Check
#             starts failing loudly.
#
# Both qa and prod here are sideloaded builds for family, so both are
# 'personal'. A Play build is a different pipeline and would set this to 'play'
# explicitly. Exported as a REAL shell variable so it beats any .env file —
# dotenv never overwrites an already-set variable.
export AAROGYA_DISTRIBUTION="personal"

# ── Toolchain ───────────────────────────────────────────────────────────────
# JDK 21, resolved explicitly. Other Java repositories on this machine need
# JDK 8, and whichever one happens to be first on PATH is not a build input we
# are willing to depend on: the failure mode is a Gradle error about an
# unsupported class file version, three minutes into the build.
if [ -x /usr/libexec/java_home ]; then
  RESOLVED_JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  if [ -n "$RESOLVED_JAVA_HOME" ]; then
    JAVA_HOME="$RESOLVED_JAVA_HOME"
  fi
fi
if [ -z "${JAVA_HOME:-}" ]; then
  echo "ERROR: JDK 21 not found." >&2
  echo "       /usr/libexec/java_home -v 21 returned nothing and JAVA_HOME is unset." >&2
  echo "       Install a JDK 21 (Temurin or Corretto 21), or export JAVA_HOME." >&2
  echo "       Do NOT just rely on whatever \`java\` is on PATH — the other Java" >&2
  echo "       projects on this machine pin JDK 8." >&2
  exit 1
fi
export JAVA_HOME

JAVA_MAJOR="$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
if [ "$JAVA_MAJOR" != "21" ]; then
  echo "ERROR: JAVA_HOME points at a JDK $JAVA_MAJOR, not 21: $JAVA_HOME" >&2
  exit 1
fi

if [ -z "${ANDROID_HOME:-}" ]; then
  for candidate in "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      ANDROID_HOME="$candidate"
      break
    fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: Android SDK not found. Export ANDROID_HOME." >&2
  exit 1
fi
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

echo "▸ target       : $TARGET ($FORMAT)"
echo "▸ distribution : $AAROGYA_DISTRIBUTION"
echo "▸ JAVA_HOME    : $JAVA_HOME"
echo "▸ ANDROID_HOME : $ANDROID_HOME"

# ── Signing preflight ───────────────────────────────────────────────────────
# plugins/withReleaseSigning.js writes a NOT_WIRED marker instead of failing
# when these are absent, so a dev-client prebuild still works. That is correct
# for a dev-client and catastrophic for a release, so the release path checks
# here, before spending five minutes on a Gradle build it is going to reject.
MISSING_KEYS=""
for key in AAROGYA_KEYSTORE_PATH AAROGYA_KEYSTORE_PASSWORD AAROGYA_KEY_ALIAS AAROGYA_KEY_PASSWORD; do
  if [ -z "$(eval "printf '%s' \"\${$key:-}\"")" ]; then
    MISSING_KEYS="$MISSING_KEYS $key"
  fi
done
if [ -n "$MISSING_KEYS" ]; then
  echo "ERROR: release signing is not configured. Missing:$MISSING_KEYS" >&2
  echo "" >&2
  echo "       A build without these is signed with the shared Android debug key." >&2
  echo "       Such an APK installs and runs, and can then NEVER be updated by a" >&2
  echo "       properly signed build — the signatures do not match, so the only" >&2
  echo "       path is uninstall, which deletes the app's data directory." >&2
  echo "       This app has no cloud backup by design, so that erases the only" >&2
  echo "       copy of the health record. See docs/SIGNING.md." >&2
  exit 1
fi
if [ ! -f "${AAROGYA_KEYSTORE_PATH}" ]; then
  echo "ERROR: AAROGYA_KEYSTORE_PATH is set to '${AAROGYA_KEYSTORE_PATH}' but there is" >&2
  echo "       no file there. See docs/SIGNING.md." >&2
  exit 1
fi

cd "$ROOT"

# ── Prebuild ────────────────────────────────────────────────────────────────
# Guarded rm: this is an rm -rf on a derived path, so only delete something
# that actually looks like a generated Gradle project.
if [ -d "$ANDROID_DIR" ]; then
  if [ -f "$ANDROID_DIR/gradlew" ] && [ -f "$ANDROID_DIR/app/build.gradle" ]; then
    echo "▸ removing the previous android/ …"
    rm -rf "$ANDROID_DIR"
  else
    echo "ERROR: $ANDROID_DIR exists but does not look like a generated Expo project." >&2
    echo "       Refusing to delete it — inspect it and remove it by hand." >&2
    exit 1
  fi
fi

echo "▸ prebuild …"
# EXPO_NO_GIT_STATUS suppresses the dirty-tree prompt. It is a false alarm here:
# --clean only touches android/ and ios/, both gitignored, so it cannot destroy
# tracked work. Expo still logs that it skipped the check.
EXPO_NO_GIT_STATUS=1 npx expo prebuild --platform android --clean

# Never infer success from an exit code — see the header.
if [ ! -f "$ANDROID_DIR/app/build.gradle" ]; then
  echo "ERROR: prebuild exited without generating android/. Nothing was built." >&2
  exit 1
fi

# ── Assertions on the generated project, BEFORE the slow part ───────────────

echo "▸ checking the generated project …"

if ! grep -q '\[withReleaseSigning\]' "$ANDROID_DIR/app/build.gradle"; then
  echo "ERROR: plugins/withReleaseSigning did not run — app/build.gradle has no marker." >&2
  echo "       Check that './plugins/withReleaseSigning' is listed in app.config.ts → plugins." >&2
  exit 1
fi
if grep -q '\[withReleaseSigning\] NOT_WIRED' "$ANDROID_DIR/app/build.gradle"; then
  echo "ERROR: withReleaseSigning ran but did NOT wire a release signing config." >&2
  grep -m2 'withReleaseSigning' "$ANDROID_DIR/app/build.gradle" | sed 's/^/         /' >&2
  echo "       The resulting APK would be debug-signed. See docs/SIGNING.md." >&2
  exit 1
fi
echo "    ✓ [withReleaseSigning] WIRED"

SOURCE_MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
if ! grep -q 'android:allowBackup="false"' "$SOURCE_MANIFEST"; then
  echo "ERROR: allowBackup is not false in the generated manifest." >&2
  echo "       plugins/withNoBackup must have no-opped. Without it the health" >&2
  echo "       database is backed up to Google Drive and copied during device" >&2
  echo "       transfer, silently." >&2
  exit 1
fi
echo "    ✓ allowBackup=\"false\" in the source manifest"

# ── Alarm sounds → res/raw ──────────────────────────────────────────────────
#
# src/constants/channels.js names two sounds, and MainApplication resolves them
# with resources.getIdentifier(name, "raw", packageName). Nothing in the Expo
# pipeline copies assets/sounds/ into res/raw — `assetBundlePatterns` puts them
# in the JS asset bundle, which getIdentifier cannot see. Without this step the
# lookup returns 0 and both dose channels fall back to the system alarm tone,
# permanently: an Android channel's sound cannot be changed after creation, so
# a phone that installs a build without these files keeps the wrong tone until
# the channel id is bumped.
#
# The durable fix is a config plugin next to the other five. This copy is the
# stopgap that makes today's build correct, and the assertion below is what
# makes its absence loud rather than silent.
RAW_DIR="$ANDROID_DIR/app/src/main/res/raw"
mkdir -p "$RAW_DIR"
SOUND_COUNT=0
for sound in "$ROOT"/assets/sounds/*.wav; do
  [ -e "$sound" ] || continue
  cp "$sound" "$RAW_DIR/"
  SOUND_COUNT=$((SOUND_COUNT + 1))
done
for required in dose_critical dose_standard; do
  if [ ! -f "$RAW_DIR/$required.wav" ]; then
    echo "ERROR: assets/sounds/$required.wav is missing." >&2
    echo "       src/constants/channels.js names it; without it the channel is" >&2
    echo "       created with the system alarm tone and can never be corrected" >&2
    echo "       on that device without bumping the channel id." >&2
    echo "       Run: node scripts/gen-sounds.js" >&2
    exit 1
  fi
done
echo "    ✓ $SOUND_COUNT alarm sound(s) copied into res/raw"

# ── Build ───────────────────────────────────────────────────────────────────
cd "$ANDROID_DIR"
echo "▸ gradle …"
if [ "$FORMAT" = "aab" ]; then
  ./gradlew :app:bundleRelease
  ARTIFACT="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
  LIB_PREFIX="base/lib/"
else
  ./gradlew :app:assembleRelease
  ARTIFACT="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
  LIB_PREFIX="lib/"
fi
cd "$ROOT"

if [ ! -f "$ARTIFACT" ]; then
  echo "ERROR: expected artifact not produced: $ARTIFACT" >&2
  exit 1
fi

# ── Verify: the merged manifest ─────────────────────────────────────────────
# The source manifest was checked above; this is the one that actually shipped,
# after AGP merged in every library's manifest. A library can and does override
# application attributes.
echo
echo "▸ verifying the merged manifest …"
MERGED_MANIFEST="$(find "$ANDROID_DIR/app/build/intermediates" -name AndroidManifest.xml -path '*release*' 2>/dev/null | head -1 || true)"
if [ -z "$MERGED_MANIFEST" ]; then
  echo "ERROR: could not locate the merged manifest under app/build/intermediates." >&2
  echo "       Refusing to ship without confirming allowBackup=\"false\"." >&2
  exit 1
fi
if ! grep -q 'android:allowBackup="false"' "$MERGED_MANIFEST"; then
  echo "ERROR: allowBackup is NOT false in the merged manifest:" >&2
  echo "         $MERGED_MANIFEST" >&2
  echo "       Something re-enabled it during manifest merge. Do not distribute." >&2
  exit 1
fi
if ! grep -q 'android:dataExtractionRules=' "$MERGED_MANIFEST"; then
  echo "ERROR: dataExtractionRules missing from the merged manifest. On Android 12+" >&2
  echo "       that is the switch that actually stops cloud backup and device" >&2
  echo "       transfer; allowBackup alone is the half-fix." >&2
  exit 1
fi
echo "    ✓ allowBackup=\"false\" + dataExtractionRules in the merged manifest"

# ── Verify: the signing certificate ─────────────────────────────────────────
#
# Two different readers, because the two formats are signed differently:
#   .apk → APK Signature Scheme v2/v3, in a block outside the zip entries.
#          `keytool -printcert -jarfile` reports "Not a signed jar file" on
#          these, so it must be apksigner.
#   .aab → an ordinary jarsigner-signed JAR, which apksigner will not read.
echo
echo "▸ verifying the signing certificate …"
if [ "$FORMAT" = "aab" ]; then
  SIGNER="$("$JAVA_HOME/bin/keytool" -printcert -jarfile "$ARTIFACT" 2>/dev/null \
    | grep -m1 'Owner:' | sed 's/^[[:space:]]*Owner:[[:space:]]*//' || true)"
else
  APKSIGNER="$(ls -1 "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
  if [ -z "$APKSIGNER" ]; then
    echo "ERROR: apksigner not found under $ANDROID_HOME/build-tools/." >&2
    echo "       Install Android build-tools via the SDK Manager." >&2
    exit 1
  fi
  SIGNER="$("$APKSIGNER" verify --print-certs "$ARTIFACT" 2>/dev/null \
    | grep -m1 'Signer #1 certificate DN:' | sed 's/^.*DN: *//' || true)"
fi

if [ -z "$SIGNER" ]; then
  echo "ERROR: the artifact is UNSIGNED, or its signature could not be read." >&2
  echo "       Do not distribute." >&2
  exit 1
fi
echo "    $SIGNER"

case "$SIGNER" in
  *"CN=Android Debug"*|*"O=Android"*)
    echo "" >&2
    echo "ERROR: this $FORMAT is DEBUG-SIGNED. Do not distribute it, and do not" >&2
    echo "       sideload it over an existing install." >&2
    echo "" >&2
    echo "       A debug-signed build cannot be replaced by a properly signed one:" >&2
    echo "       Android rejects the upgrade on a signature mismatch, and the only" >&2
    echo "       way out is to uninstall — which deletes the app's data directory." >&2
    echo "       There is no cloud backup by design, so that is the entire health" >&2
    echo "       record, permanently. See docs/SIGNING.md." >&2
    exit 1
    ;;
esac
echo "    ✓ signed with a real release key (not the debug key)"

# ── Verify: architectures ───────────────────────────────────────────────────
echo
echo "▸ verifying native architectures …"
ARCHS="$(unzip -l "$ARTIFACT" 2>/dev/null \
  | awk -v prefix="$LIB_PREFIX" '$4 ~ "^"prefix { split(substr($4, length(prefix)+1), p, "/"); print p[1] }' \
  | sort -u || true)"

if [ -z "$ARCHS" ]; then
  echo "ERROR: no native libraries found under ${LIB_PREFIX} in the artifact." >&2
  echo "       A React Native build always ships libhermes/libreactnative — an" >&2
  echo "       artifact without them will not start." >&2
  exit 1
fi
echo "$ARCHS" | sed 's/^/    /'
if [ "$(echo "$ARCHS" | wc -l | tr -d ' ')" != "1" ] || [ "$ARCHS" != "arm64-v8a" ]; then
  echo "ERROR: expected arm64-v8a ONLY, got the above." >&2
  echo "       buildArchs in app.config.ts did not take effect on this build path." >&2
  echo "       A second architecture roughly doubles the native payload, which is" >&2
  echo "       the largest single lever on APK size. See docs/SIZE.md." >&2
  exit 1
fi
echo "    ✓ arm64-v8a only"

# ── Publish under an unambiguous name ───────────────────────────────────────
#
# Gradle always writes `app-release.apk`, so a QA and a Prod artifact are
# indistinguishable the moment they leave this directory. Worse, they live
# INSIDE android/, which the next build deletes — so building prod silently
# destroys the qa artifact you just made.
#
# The version is read out of the GENERATED build.gradle rather than out of
# app.config.ts, because that is what actually went into the artifact.
VERSION_NAME="$(grep -m1 'versionName' "$ANDROID_DIR/app/build.gradle" | sed -E 's/.*versionName[[:space:]]+"([^"]+)".*/\1/')"
VERSION_CODE="$(grep -m1 'versionCode' "$ANDROID_DIR/app/build.gradle" | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
: "${VERSION_NAME:=unknown}"
: "${VERSION_CODE:=0}"

OUT_DIR="$ROOT/build-output"

# aarogya-prod-v0.1.0-build1.apk
#
# The two numbers are NOT the same thing written twice, which is what the older
# `0.1.0-1` form looked like:
#
#   versionName ("0.1.0")  the human version. Free-form; what you say out loud.
#   versionCode (1)        an integer Android uses to decide what counts as an upgrade.
#                          It MUST increase on every release; a device refuses to install
#                          a build whose versionCode is not higher than the installed one.
#
# Both belong in the filename — the versionName so a human can tell builds apart, the
# versionCode because it is the number that decides whether an install will actually be
# accepted, and shipping the wrong one is a support call that starts "it says app not
# installed". The `v` and `build` labels make it obvious they measure different things.
OUT_NAME="aarogya-${TARGET}-v${VERSION_NAME}-build${VERSION_CODE}.${FORMAT}"
mkdir -p "$OUT_DIR"
cp "$ARTIFACT" "$OUT_DIR/$OUT_NAME"

# ── Size ────────────────────────────────────────────────────────────────────
BYTES="$(wc -c < "$OUT_DIR/$OUT_NAME" | tr -d ' ')"
MB="$(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b/1048576 }')"

echo
echo "▸ size: ${MB} MB (${BYTES} bytes)"
echo
echo "    largest groups (uncompressed):"
unzip -l "$ARTIFACT" 2>/dev/null \
  | awk 'NF>=4 && $1 ~ /^[0-9]+$/ {
      path = $4
      for (i = 5; i <= NF; i++) path = path " " $i
      n = split(path, parts, "/")
      group = (n > 1) ? parts[1] "/" ((n > 2 && (parts[1] == "lib" || parts[1] == "base")) ? parts[2] "/" : "") : "(root)"
      total[group] += $1
    }
    END { for (g in total) printf "%12d  %s\n", total[g], g }' \
  | sort -rn | head -10 \
  | awk '{ printf "      %8.2f MB  %s\n", $1/1048576, $2 }'

echo
echo "    largest single entries (uncompressed):"
unzip -l "$ARTIFACT" 2>/dev/null \
  | awk 'NF>=4 && $1 ~ /^[0-9]+$/ { path=$4; for (i=5;i<=NF;i++) path=path" "$i; printf "%12d  %s\n", $1, path }' \
  | sort -rn | head -12 \
  | awk '{ p=$2; for (i=3;i<=NF;i++) p=p" "$i; printf "      %8.2f MB  %s\n", $1/1048576, p }'

# ── Budget ──────────────────────────────────────────────────────────────────
# Advisory here, enforced by scripts/check-size.js so that growth is a decision
# somebody made rather than a drift nobody noticed.
if [ "$FORMAT" = "apk" ]; then
  echo
  node "$ROOT/scripts/check-size.js" "$OUT_DIR/$OUT_NAME" || SIZE_OVER=1
fi

echo
echo "✓ $TARGET $FORMAT built and verified"
echo "    version : $VERSION_NAME (versionCode $VERSION_CODE)"
echo "    dist    : $AAROGYA_DISTRIBUTION"
echo "    size    : ${MB} MB"
echo "    signer  : $SIGNER"
echo "    output  : $OUT_DIR/$OUT_NAME"
echo "    (gradle : $ARTIFACT — inside android/, deleted by the next build)"

exit "${SIZE_OVER:-0}"
