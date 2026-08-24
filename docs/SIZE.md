# Size

The app is deliberately small, and staying small is a maintained property rather than a happy
accident.

**Why it matters here specifically.** The person this app is for has a mid-range Android phone with
a few hundred megabytes free, on a metered connection, and receives the APK as a file over WhatsApp
or a cable rather than from a store. A 60 MB sideload is a real obstacle at exactly the moment
somebody is trying to help her install it. Every megabyte is also a megabyte the OEM's "storage
cleaner" is more interested in, and on MIUI/ColorOS those cleaners are the same subsystem that
force-stops apps and cancels their alarms.

**The budget is 32 MB**, enforced by `scripts/check-size.js`, which `scripts/build-android.sh` runs
at the end of every release build. Exceeding it fails the build. Raising it requires editing
`BUDGET_MB` in that script *and* adding a line to the changelog at the bottom of this page saying
what was added and why it was worth it. The budget does not stop the app growing — it makes growth a
decision somebody made on a specific day.

---

## Measured baseline

Measured 2026-08-13, `aarogya-prod-v0.1.0-build9.apk`, signed release, arm64-v8a only.

| | |
|---|---|
| **APK** | **28.39 MB** (budget 32 MB, build 9 — 3.61 MB of headroom) |
| Native libs | 16.89 MB |
| Dex | 10.07 MB (`classes.dex` 6.71 + `classes2.dex` 3.36) |
| JS bundle | 3.75 MB Hermes bytecode |
| Resources | 2.88 MB |

Largest single entries: `libreactnative.so` 5.61 MB · `index.android.bundle` 3.75 MB ·
`libhermes.so` 2.04 MB · `libexpo-sqlite.so` 1.74 MB · `libappmodules.so` 1.30 MB ·
`libexpo-modules-core.so` 1.27 MB · `libc++_shared.so` 1.23 MB.

**Build 8 → 9 cost 0.04 MB of download for 0.30 MB of bundle**, which is the shape to expect
from this app's own code and the reason the budget is stated on the compressed file. The
prescription review screen gained the proposal layer, the read-back dialog and roughly sixty
new strings in two languages; Hermes bytecode and UTF-8 prose both compress hard, so 300 KB
uncompressed landed as 41 KB in the zip. A change that moves the APK by a *tenth* of what it
moved the bundle is app code. A change that moves them together is an asset or a dependency,
and that is the one to go and look at.

Roughly 22 MB of that is the React Native runtime itself and is not reducible without
changing framework. The app's own code is the 3.45 MB bundle plus a slice of the dex.

### Changelog

**2026-08-10 — 33.60 MB → 27.61 MB (−5.99 MB, −18%).** Excluded ML Kit barcode scanning
from the release classpath (`plugins/withStripDevOnlyDeps.js`).

`expo-dev-client` → `expo-dev-launcher` depends on ML Kit so the dev launcher can scan a QR
code to attach to a Metro server. Expo already keeps dev-launcher's *classes* out of release
builds, so this looked handled — but the 4.72 MB `libbarhopper_v3.so` shipped anyway, native
code for a scanner whose callers were not even present.

Two things worth remembering from doing it:

- **Excluding a library means excluding everything that references it.** Removing
  `barcode-scanning` alone left `play-services-code-scanner` behind holding references to
  the classes that had just gone, and R8 failed with `Missing class …vision.barcode.common.Barcode`.
  The fix removes the caller too.
- **`-dontwarn` is not a fix on its own.** It would have made that R8 error disappear while
  leaving the 4.72 MB in the APK — the build would go green and nothing would have improved.
  It is kept only as a safety net for stragglers, underneath an exclusion that does the work.

The saving is larger than the native library because the scanner's Java classes left the dex
as well (`classes2.dex` 4.14 → 3.34 MB).

**If a barcode or QR feature is ever added to the app itself**, delete that plugin and expect
~6 MB back on the APK — at which point it is weight that earns its place.
> `scripts/check-size.js` prints exactly the breakdown these columns want.

| Date | Version | APK (MB) | `lib/arm64-v8a` | `assets/` (Hermes bundle) | `res/` | Notes |
|---|---|---|---|---|---|---|
| _tbd_ | 0.1.0 (1) | | | | | first measured baseline |

Re-measure on any release where a dependency changed. The interesting column is not the total — it
is which group moved.

---

## The levers actually in force

Listed in order of how much they are worth.

### 1. arm64-v8a only — by far the largest

`app.config.ts` → `expo-build-properties` → `buildArchs: ['arm64-v8a']`.

The native libraries dominate an RN payload: Hermes, the React Native core, `expo-sqlite`,
`react-native-svg`, `react-native-screens`, `react-native-gesture-handler`. Shipping a second
architecture roughly **doubles** all of it — typically 8–12 MB of pure duplication.

This is safe for the target devices. `minSdkVersion` is 26 (Android 8), and essentially every
64-bit-capable handset since ~2017 — including every Redmi and Realme model in scope — runs
`arm64-v8a`. Google Play has required a 64-bit build since 2019.

`buildArchs` is **not honoured on every build path**, so `scripts/build-android.sh` reads `lib/` out
of the finished artifact with `unzip -l` and hard-fails if anything other than `arm64-v8a` is
present. Verify the artifact; do not trust the config.

*If a genuinely 32-bit device ever needs support, add `armeabi-v7a` back and expect the APK to grow
by roughly the size of the `lib/arm64-v8a` column above.*

### 2. R8 minification + resource shrinking

```
enableMinifyInReleaseBuilds: true
enableShrinkResourcesInReleaseBuilds: true
```

Both on in `app.config.ts`. Together they strip unreachable Java/Kotlin classes and unreferenced
resources — worth several megabytes on a project with this many Expo modules, most of which the app
touches only a fraction of.

R8 in full mode is also why `plugins/withGradlePerformance.js` raises `MaxMetaspaceSize` to 1024m.
Expo's template ships 512m, which R8 exhausts on a project this size; the failure is not a clean OOM
but a dead Gradle daemon reporting "Daemon disappeared unexpectedly", which sends you looking at
dependency conflicts for an afternoon.

### 3. Hermes bytecode, not JavaScript

Default on in SDK 54 and left alone. The bundle ships as pre-compiled bytecode rather than source, so
there is no JS text in the APK and no parse cost at startup. It shows up as
`assets/index.android.bundle`, and it is the entry that actually moves when a dependency is added —
which makes it the number to watch in the baseline table.

### 4. No charting library with native code

Charts use `react-native-gifted-charts` on top of `react-native-svg`, which is already present for
icons. There is no Victory Native, no Skia, no WebView-based chart. Skia alone would add several
megabytes of native library for something an SVG polyline already does at the fidelity a
blood-pressure scatter needs.

### 5. No `@supabase/supabase-js`

There is no backend, so there is no client for one. The L3 viewer-sync design uses a keypair and
`@noble/ciphers` + `@noble/hashes` — both tiny, pure-JS, no native module — rather than a general
purpose SDK that would drag in a realtime client, a storage client and a Postgres query builder for a
feature that needs none of them.

### 6. SheetJS deliberately absent — CSV only

Exports are CSV, written by hand. SheetJS (`xlsx`) is roughly a megabyte of JavaScript, all of which
lands in the Hermes bundle, to produce a file format that every tool a doctor or a family member
actually uses — Excel, Google Sheets, LibreOffice — opens perfectly well as CSV anyway. The PDF path
uses `expo-print`, which is a system service, not a bundled renderer.

### 7. Assets are generated, not sourced

`assets/images/*.png` are produced by `scripts/gen-icons.js`: indexed-colour PNGs with a hand-rolled
encoder, **all four under 7 KB**. `assets/sounds/*.wav` are synthesised by `scripts/gen-sounds.js`,
129 KB and 215 KB. Together the entire asset directory is under 400 KB. A single stock icon set from
a design tool routinely exceeds that on its own.

There are no bundled fonts. `assets/fonts/` is empty on purpose — the system font renders Devanagari
and Latin correctly on every target device, and a bundled Noto Sans Devanagari would cost 400 KB+ to
change very little.

---

## What is NOT being done, and why

- **No app bundle / dynamic delivery for the sideload path.** An `.aab` is smaller *as delivered by
  Play*, but the sideloaded build has to be a single self-contained APK. `npm run build:prod:aab`
  exists for a Play upload; it is not the family path.
- **No ProGuard rules hand-tuning.** The default Expo/RN rules are correct and aggressive enough.
  Custom keep-rules are how a release build starts crashing in a way that never reproduces in debug.
- **No image compression pipeline.** There are no bitmap assets to compress beyond the four
  generated icons.

---

## Investigating a regression

```bash
node scripts/check-size.js build-output/aarogya-prod-0.1.0-1.apk
```

It prints the size, the uncompressed contents grouped by top-level directory (with `lib/` split by
architecture), and the largest single entries. Compare against the baseline table.

Where the growth usually is, in order of likelihood:

1. `lib/` gained an architecture → `buildArchs` did not take effect. The build script should already
   have caught this.
2. `lib/` gained a `.so` → a new dependency has native code. That is the expensive kind, and it is
   worth asking whether the feature justifies it.
3. `assets/index.android.bundle` grew → a JS dependency. Cheaper, but this is the number that creeps.
4. `res/` grew → a library brought resources that resource-shrinking could not prove were unused.

For a finer view, `$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer apk file-size` and
`apkanalyzer dex packages` will attribute the DEX side by package.

---

## Changelog

Every budget change goes here, with the reason.

| Date | Budget | Change |
|---|---|---|
| 2026-08-09 | 32 MB | Initial budget, set before the first measured build. **Tighten this to the measured baseline plus ~15% headroom once the first release build completes** — a budget well above the actual size catches nothing. |
