# Aarogya

An offline-first chronic care companion for Android. Records readings, reminds about
medicines with no network, reads a photographed prescription with AI, and turns weeks of
data into one page a doctor can absorb in a minute.

Built first for one person — an elderly woman managing cardiac disease, type-2 diabetes and
active tuberculosis at the same time — and structured from the first line so the same app
generalises to any chronic condition.

## The two constraints that shaped everything

**There is no server.** No backend to host, patch or pay for. The only network call in the
whole app is to an LLM to read a prescription photo, and it is optional — every medicine can
be entered by hand, and the app is fully usable by someone who never enters an API key.

**It is her health record.** It stays on her device unless she explicitly shares it.
`allowBackup="false"`, no Google Drive copy, no device-transfer copy. Sharing is opt-in,
per-recipient, and encrypted on her phone before anything leaves it.

## Getting started

```bash
npm install
npx expo prebuild --platform android --clean
npm run android
```

### Family sharing (optional, and not needed to start using the app)

One **shareable view link per profile**:

```
https://<host>/aarogya/v/<linkId>#k=<key>
```

Anyone holding the complete link can read her readings, medicines and symptoms. If it
leaks, **Rotate** in the app re-encrypts everything under a new key and a new id, so every
previously shared link stops working at once — at the cost of having to re-send the new one
to everybody.

The decryption key lives in the URL **fragment** (after `#`), which browsers never transmit
in a request. The server therefore holds ciphertext it cannot read, while the link itself is
the credential. That is deliberate: the link is meant to be shareable the way a house key is.

`AAROGYA_INVITE_HOST` is **optional** and buys exactly one thing — tapping the link opens the
app instead of a browser. Android verifies that by fetching a ~200-byte static
`.well-known/assetlinks.json` (a JSON file, not JavaScript) naming this app's package and
signing certificate. GitHub Pages hosts it free.

```bash
export AAROGYA_INVITE_HOST="yourname.github.io"   # or edit INVITE_HOST in app.config.ts
```

Without it, sharing still works — the viewer pastes the link or code into the app. Nothing
about recording readings, reminders or reports depends on any of this.

### The AI key

Requested during first-run setup with step-by-step instructions and a button that opens
Google AI Studio in the phone's browser — and it is **skippable**, because the app works
entirely without it (medicines can always be entered by hand). It can be added, replaced or
removed later from **Settings → Prescription scanning (AI)**, which also has a
*Check this key* button that makes one real call so you know it works before relying on it.
The key is stored in `expo-secure-store`, backed by the Android Keystore — never in the APK
and never in git.

Release build (needs the signing keystore — see `docs/SIGNING.md`):

```bash
. ~/.aarogya/keystore.env
npm run build:prod
```

Checks:

```bash
npm run check:all   # typecheck + i18n parity + clinical-language lint
npm test            # 564 unit tests
```

## Layout

| Path | What lives there |
|---|---|
| `src/app/` | 55 screens, expo-router file-based |
| `src/db/` | Schema, migration runner, 16 repositories, reference-data seed |
| `src/features/dosing/` | Reconcile, journal drain, watchdog, PRN, `deriveStatus` |
| `src/features/{adherence,streaks}/` | Honest adherence maths; non-punitive streaks |
| `src/features/{ai,prescriptions,care}/` | Gemini client, extraction, supersession, care calendar |
| `src/features/reports/` | Day card, OPD one-pager, CSV/PDF, wall chart |
| `src/features/{backup,sync}/` | Encrypted capsule; family viewers with E2E crypto |
| `modules/med-alarm/` | Local Expo module — 13 Kotlin sources owning AlarmManager |
| `plugins/` | 6 config plugins (channels, sounds, no-backup, receivers, signing, gradle) |

## Five decisions worth knowing before you change anything

**The alarm layer never opens the database.** Two processes writing the only copy of a
health history is the worst failure available here, so Kotlin and JavaScript exchange files
instead: a rules file, and one small file per event. Details in
`docs/REMINDER-RELIABILITY.md`.

**The horizon holds rules, not dates.** An earlier design pre-computed seven days of alarms
and had JavaScript top them up — but JavaScript only runs when the app is open, and the whole
product is built so she can tap *Taken* from the notification without opening it. On day 8
the list would be empty and every reminder would stop, silently. Kotlin now expands
recurrence rules forward on its own, indefinitely.

**Nothing clinical is ever overwritten.** Doses, medicines and schedules are append-only and
versioned on a stable `thread_id`. That is what lets the OPD report answer *"what was she
taking in March?"* after four prescription changes, and why a dose change keeps her adherence
history continuous instead of resetting it.

**Constraints protect integrity, never clinical plausibility.** A glucose reading of
18 mg/dL is a hypoglycaemic emergency, not a typo — it is the single reading a doctor would
act on immediately, so it must be storable. Bounds sit at instrument limits; implausibility is
a soft "did you mean?" the user can override.

**AI proposes, a human confirms — enforced in SQL.** A database trigger refuses to create a
dose occurrence for a medicine or schedule with no `confirmed_by_user_at`. Confirmation covers
the *frequency*, not just the name, because "1-0-1 misread as QID" leaves the drug name
perfectly correct and quadruples the dose.

## Language rules the build enforces

`npm run check:clinical` fails the build on these, because they are the difference between a
record and a diagnosis:

- The word **"missed"** never reaches a user-facing or printed surface. The honest phrase is
  **"not recorded as taken"** — a statement about the app's data, not about her behaviour.
- Adherence is reported in three buckets (taken / not taken / **no record**), and the
  percentage is **suppressed entirely** after three consecutive no-record days. A physician
  reading a seven-day gap in a TB patient may change treatment over an artefact the app
  manufactured.
- Clinical targets ship **blank**. Every one is entered by a human and prints the name and
  date of whoever set it.
- No risk scores, no drug-interaction checker, no symptom checker, no insulin calculator.

## Documentation

`docs/REMINDER-RELIABILITY.md` · `docs/AI-EXTRACTION.md` · `docs/REPORTS.md` ·
`docs/SYNC-AND-BACKUP.md` · `docs/BUILD.md` · `docs/SIGNING.md` · `docs/SIZE.md`

## Status

Compiles and builds a signed release APK. **Not yet verified on a physical device** — the
reminder-delivery test matrix in `docs/REMINDER-RELIABILITY.md` (Doze, standby buckets,
reboot, a 10-day untouched soak, and the silent-mode matrix on Redmi and Realme) has to be
run on the actual handset before this is trusted with anyone's medication.
