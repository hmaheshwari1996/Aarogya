# Signing

> ## **Store the `.jks` file and its passwords in two independent off-machine locations before the first release build.**
>
> Not after. Before.
>
> Android identifies an installed app by the certificate that signed it. A build signed with a
> different key cannot update an existing install — the system rejects it as a different app from a
> different publisher. The only way to install the new build is to **uninstall the old one**, and
> uninstalling deletes the app's private data directory.
>
> For Aarogya that data directory is the entire health record: every reading, every dose, every
> prescription photo, every lab result, for as long as the app has been in use. There is no cloud
> copy. `plugins/withNoBackup.js` deliberately turns off Google Drive backup **and** device-transfer
> copying, because a family's medical history should not be sitting in a cloud account encrypted
> with a key nobody chose. That decision is correct, and it is exactly what makes the keystore
> irreplaceable.
>
> **Losing the keystore is not an inconvenience. It is the loss of the user's health history, at the
> next update, with no way back.**

---

## Generating the keystore

Once. On a machine you control. With JDK 21 — the same JDK the build uses.

```bash
JAVA_HOME="$(/usr/libexec/java_home -v 21)"

"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -storetype PKCS12 \
  -keystore ~/keys/aarogya-release.jks \
  -alias aarogya \
  -keyalg RSA -keysize 4096 \
  -validity 10950 \
  -dname "CN=Aarogya, OU=Personal, O=Aarogya, L=Bengaluru, S=Karnataka, C=IN"
```

Notes on each choice:

| Flag | Why |
|---|---|
| `-storetype PKCS12` | The industry-standard container. JKS is a proprietary legacy format and `keytool` nags about it on every use. |
| `-keysize 4096` | This key has to outlive the app. There is no rotation path for a sideloaded install. |
| `-validity 10950` | 30 years. An expired signing certificate cannot sign an update either — same failure, slower. |
| `-alias aarogya` | Must match `AAROGYA_KEY_ALIAS` exactly. A mismatched alias fails deep inside Gradle with a message about a missing key. |

`keytool` will prompt for the store password and then for the key password. **Use the same value for
both.** Gradle reads them from two separate environment variables and there is nothing to gain from
them differing, but there is plenty to lose from getting them mixed up in three years.

Verify what you made:

```bash
"$JAVA_HOME/bin/keytool" -list -v -keystore ~/keys/aarogya-release.jks
```

Record the **SHA-256 fingerprint** printed there. It is how you confirm, later, that a keystore you
found in a backup is actually the right one.

---

## Backing it up — do this now, not later

Two locations, independent of each other and of this machine. "Independent" means a disk failure, a
lost laptop, a wiped phone or one compromised account cannot take out both.

A reasonable pair:

1. An encrypted USB drive or SD card kept physically somewhere else.
2. A password manager entry, or an encrypted archive in a cloud account you control.

Each location must hold **all four** of these, together — a keystore without its password is as
useless as no keystore at all:

- [ ] the `aarogya-release.jks` file
- [ ] the store password
- [ ] the key alias (`aarogya`)
- [ ] the key password
- [ ] the SHA-256 fingerprint from `keytool -list -v`, so you can verify a restored copy

Then, before the first release build, **prove the backup works**: copy the file back from each
location to a scratch directory and run `keytool -list -v` against it with the stored password. A
backup you have never restored is a belief, not a backup.

---

## Using it

`plugins/withReleaseSigning.js` wires the signing config into `android/app/build.gradle` at prebuild
time, but it **never writes the secrets into that file**. Gradle reads them from the environment at
build time via `System.getenv(...)`. `android/` is generated output that people do check in when a
build breaks, and a password sitting in a `build.gradle` is a key-rotation event — which, for this
app, is the disaster described at the top of this page.

```bash
export AAROGYA_KEYSTORE_PATH="$HOME/keys/aarogya-release.jks"
export AAROGYA_KEYSTORE_PASSWORD='…'
export AAROGYA_KEY_ALIAS='aarogya'
export AAROGYA_KEY_PASSWORD='…'

npm run build:prod
```

Keep these out of your shell history and out of the repository. `.gitignore` excludes `*.jks`,
`*.keystore` and `.env*`, but the only reliable protection is not putting them there.

If any of the four is missing:

- `plugins/withReleaseSigning.js` writes a `[withReleaseSigning] NOT_WIRED` marker into
  `app/build.gradle` instead of failing. That is correct for a dev-client build, which has no
  business holding the release key.
- `scripts/build-android.sh` **refuses to build at all** on a release target, before Gradle starts,
  and tells you which variables are missing.
- If a debug-signed artifact somehow reaches the end of the pipeline anyway, the certificate check
  after the build hard-fails on it — APK *and* AAB. There is no "warning, continuing" path, because
  the mistake is unrecoverable once the artifact is sideloaded.

---

## Verifying a finished artifact by hand

The build script does this automatically. To check something you were handed:

```bash
# APK — signed with APK Signature Scheme v2/v3, which lives outside the zip entries.
"$ANDROID_HOME"/build-tools/*/apksigner verify --print-certs app-release.apk

# AAB — an ordinary jarsigner-signed JAR; apksigner will not read it.
"$JAVA_HOME/bin/keytool" -printcert -jarfile app-release.aab
```

`CN=Android Debug` in the output means it is debug-signed. Delete it.

Compare the SHA-256 fingerprint against the one you recorded when you created the keystore. If they
differ, the artifact cannot update the installed app.

---

## If you have already lost it

Be honest about the situation early, because the recovery has to happen **before** the phone needs
an update.

1. Do **not** uninstall anything.
2. Export the data from inside the app first — Backup → Export. That produces an encrypted archive
   the app can restore from, and it is the only thing standing between a lost keystore and a lost
   history.
3. Verify the export actually restores, on a second device or a fresh install, before touching the
   original.
4. Then, and only then, generate a new keystore, uninstall, install the new build, and restore.

Steps 2 and 3 are the whole plan. A lost keystore costs one restore cycle if there is a verified
export, and everything if there is not.

---

## The keystore that actually signs this app

Generated 2026-08-10, RSA 4096, valid 30 years (to 2056-08-02).

| | |
|---|---|
| Location | `~/.aarogya/aarogya-release.jks` — **outside the repo**, so it can never be committed |
| Credentials | `~/.aarogya/keystore.env` (mode `600`) |
| Alias | `aarogya` |
| SHA-256 | `66:57:CD:52:54:A0:06:79:B7:7F:00:E3:69:2A:33:E4:3F:82:1F:9D:08:6F:CE:03:E9:B1:FD:3D:70:66:3B:30` |

Verify any APK claims to be this app with:

```bash
apksigner verify --print-certs build-output/aarogya-prod-*.apk | grep SHA-256
```

If that fingerprint does not match the line above, the APK was signed by a different
key and **must not** be installed over an existing one — it cannot be, and attempting
it will lead to an uninstall, which erases the health record.

### ⚠️ Not yet done

The keystore currently exists in **one** place: this machine. That is one disk failure
away from the loss described at the top of this file. Copy `~/.aarogya/` to two
independent locations you control — for example an encrypted USB drive and a password
manager's secure-file store — before the first build is installed on anyone's phone.
