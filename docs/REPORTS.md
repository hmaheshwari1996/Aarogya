# Reporting, export and sharing

Four artefacts, four readers.

| Artefact | Reader | Format | Built by |
| --- | --- | --- | --- |
| **Day card** | family, on WhatsApp | 1080x1350 PNG + a paired text block | `src/features/reports/dayCard/` |
| **OPD report** | the doctor, in a four-minute consultation | one A4 page + appendix, PDF | `src/features/reports/opd/` |
| **Data export** | the patient, or whoever she gives it to | CSV always, XLSX when possible | `src/features/reports/exports/` |
| **Wall chart** | the patient, on the wall by the medicine box | printable A4 landscape, PDF | `src/features/reports/wallchart/` |

Everything is built **offline**. No document in this feature references a network resource
of any kind: charts are inlined as `data:` URIs, the CSV writer has no dependencies, and
the PDF path is the Android WebView print engine.

## Shape of the code

```
src/features/reports/
|-- data/
|   |-- types.ts        pure, serialisable snapshots - the contract between DB and builders
|   `-- collect.ts      the ONLY module that touches the database
|-- lib/                escaping, English formatting, base64. No runtime imports.
|-- charts/             SVG chart + timeline builders (strings, not views)
|-- dayCard/            DayCard.tsx, capture.ts, text.ts, index.tsx
|-- opd/                buildOpdHtml.ts, adherenceSection.ts, css.ts, doseCalendar.ts, print.ts
|-- exports/            csv.ts, xlsx.ts, files.ts, share.ts, gallery.ts
`-- wallchart/          buildWallChartHtml.ts
```

Every builder is a **pure function from a snapshot to a string**. `collect.ts` does one
read pass and fills all of them. That is what makes the output reproducible, makes the
rules that could mislead a doctor unit-testable without SQLite, and keeps a month view
from becoming three independent query storms on a Go-class device.

## Rules that cut across every surface

1. **Adherence is stated honestly or not stated.** The word *missed* appears nowhere. A
   dose with nothing recorded is "not recorded as taken". A run of >= 3 silent days
   suppresses the percentage in favour of the reason (`Records incomplete for 3 days
   (2-4 Aug)`), because a run of no-record days is missing data - the phone was off, the
   OEM killed the alarm process, she was in hospital, or she took every dose and never
   opened the app. A physician who reads "31%" over a week-long hole in a TB patient's
   record may escalate to directly-observed therapy over an artefact the app manufactured.
2. **A chart draws a target band only when a `target_range` row exists**, and its legend
   names the person and the date who set it. No target -> no band, no marked values, and a
   printed line saying that nobody set one. The app never asserts a clinical threshold.
3. **Nothing encodes meaning by colour alone.** Out-of-range is a *hollow marker*, never
   red. "Recorded as not taken" is a stripe. "No record" is a dashed outline. Each is also
   a word in a key. OPD printers are monochrome and ~8% of men have red/green deficiency.
4. **No badge, streak or gamification on any doctor-facing surface**, ever.
5. **English on the doctor's page, the user's language everywhere else.** `report.*`
   translation keys are English in both language files by design; the OPD builder carries
   its own English formatting in `lib/format.ts`. The day card and the wall chart take
   translated labels from the caller and fall back to English.

## Day card

**Layout** (1080x1350, 4:5 - the tallest aspect WhatsApp shows uncropped):

```
Kamla Devi                          9 August 2026
-------------------------------------------------
BLOOD PRESSURE   08:10  142/88 mmHg, pulse 76
BLOOD SUGAR      07:55  126 mg/dL - Empty stomach
WEIGHT           06:40  61.4 kg
MEDICINES        Metformin 500 mg
                 (*)08:00   ( )20:00
HOW I FELT       16:20  Headache (mild)
-------------------------------------------------
(*) recorded as taken  (-) recorded as not taken  ( ) not recorded as taken
Recorded in the Aarogya app. It shows what was recorded, not what was swallowed.
```

**Not on it:** prescription or lab photos, address, phone number, badges, streaks. This
image is built to be forwarded; it will land in a family group and in someone's photo
backup. Everything on it is something the patient would say out loud to the person she is
sending it to.

Always rendered in the **light palette** regardless of device theme - it leaves the phone
and must look the same to whoever receives it.

### Capture (`dayCard/capture.ts`)

Four things are load-bearing, and each is a bug if dropped:

- **The host is inside the current screen, absolutely positioned, `opacity: 0.01`,
  `pointerEvents="none"`.** *Not* a large negative offset: on Android that can stop the
  view being drawn at all inside a clipping ancestor, and the capture then succeeds with a
  blank image, which is worse than failing. Not `opacity: 0` either - a fully transparent
  view is a candidate for being skipped.
- **`collapsable={false}` on the host and every nested wrapper.** React Native collapses
  views with no drawing props into their parent, leaving a JS tag with no Android View
  behind it - the classic source of `Failed to snapshot view tag`.
- **Gate on explicit image `onLoad` promises *plus* two `requestAnimationFrame` ticks.**
  `onLayout` fires when layout completes, not when content has drawn; inlined images and
  SVG under Fabric commonly need another frame. The image registry currently has zero
  entries (the card renders no images by policy) and is wired anyway, so adding one
  automatically enrols it.
- **Assert non-blankness before sharing.** A real card is 60-150 KB; a blank one
  compresses to a few KB. `MIN_CARD_BYTES = 18_000`, one retry after two more frames, then
  `BlankCaptureError`.

`react-native-view-shot` is **pinned to 5.1.1** in `package.json` (`expo.install.exclude`).
SDK 54 would install 4.0.3, which predates New Architecture support and throws
`Failed to snapshot view tag` at runtime - only when Share is tapped. Do not unpin it.

### Sharing image + text

**Android cannot share an image and text in one intent.** `ACTION_SEND` carries either
`EXTRA_STREAM` or `EXTRA_TEXT`, and WhatsApp ignores the text when a stream is present.
So `shareDayCard` does:

1. copy the text block to the clipboard,
2. raise the toast *"Text copied - paste it below the photo"* (before the sheet opens -
   once the chooser is up, the app's own UI is behind it),
3. open the share sheet with the image.

The image is designed to be **self-sufficient**, so the text is a bonus and nothing that
only exists there is allowed to matter. The text block emits no markdown characters
(`* _ ~ `` `), which WhatsApp would otherwise render as formatting.

## OPD report

### Page one, in priority order

1. **Header** - name, age (from year of birth, labelled as such), sex, conditions, period,
   and a "since last visit" delta table with the direction as a **word** (`higher` /
   `lower` / `unchanged`), never an arrow or a colour alone.
2. **Reminder record** - the adherence block. See below.
3. **Charts** - BP and sugar, chosen from the metric registry's own `sort_order` with a
   light nudge toward keys that read as blood pressure or blood sugar.
4. **Current medicines** with doses and times.
5. **Symptom timeline** - grouped by symptom, with the dates.
6. **Labs** - values exactly as the paper printed them, reference ranges transcribed only.
7. **Questions the patient wants to ask**, with app-suggested lines marked as such.

Page one is a **summary**: each section is capped (`DEFAULT_PAGE_ONE_LIMITS`) and says so.
An OPD consultation in a government hospital can be four minutes long; anything that does
not survive the first forty-five seconds belongs in the appendix.

### Appendix

Full data tables (medicines, targets, all readings, all symptoms, all labs, all
questions), then a **DOTS-style dose calendar** and a **medication timeline**, then all
scheduled doses. Tables are capped at 400 rows with a pointer to the CSV export.

The dose calendar uses five marks, because a two-state grid has nowhere to put the day the
phone was off:

| Mark | Meaning |
| --- | --- |
| `T` filled | every scheduled dose that day recorded as taken |
| `N` striped | every scheduled dose recorded as not taken |
| `.` dashed | the day passed with nothing recorded either way - **missing data** |
| `A` grey | the patient recorded being away |
| `1/2` | mixed day: recorded taken over scheduled |
| blank | nothing scheduled |

### The adherence block (`opd/adherenceSection.ts`)

Pure, unit-tested, and the only part of the report with its own test file.

- Always renders the **three-segment split**: recorded taken / recorded not taken / no
  record. Never two segments.
- When `percent` is `null`, prints `summary.suppressedReason` **instead of a number**, in
  the typographic weight the number would have had, plus a sentence explaining that a run
  of days with no entry is missing information.
- Prints `adherenceDisclaimer()` verbatim, every time. A blank disclaimer **throws** - a
  number with nothing qualifying it is the artefact this feature exists to avoid.
- Counts are still published when the percentage is not: suppression withholds the derived
  figure, not the record.
- Away days are explained on the page, so a hospital stay does not read as a gap in effort.

### Print CSS - the page-size decision

**The stylesheet owns the page. `printToFileAsync` is called with NO `width` and NO
`height`.**

```css
@page { size: A4; margin: 12mm; }
```

There are two ways to tell the Android WebView print path how big a page is - `@page` in
CSS, or `width`/`height` arguments (A4 at 72 PPI is 595x842). **Doing both double-applies
the margins**: the adapter lays out inside the page you passed, and the stylesheet insets
the content again, so 12mm becomes 24mm on one edge and the last column of every wide
table walks off the paper.

This report picks CSS. The margin belongs with the typography rather than with the call
site, a caller who forgets the numbers would silently get US Letter, and `@page` is the
only one of the two that a landscape appendix could override per page.

`printOpdPdf({ pageSize: 'native-a4' })` is the documented escape hatch for a device whose
WebView turns out to ignore `@page`. It swaps the two over - geometry from the arguments,
`@page` dropped from the stylesheet in the same call - so the two are never both in force.
It does not fire automatically: "the PDF came out the wrong size" is not something the code
can detect.

Other print rules in `opd/css.ts`:

- `thead { display: table-header-group }` - repeats header rows on every page a long table
  spills onto. The second page of a readings table without it is a wall of unlabelled
  numbers.
- `break-inside: avoid` on every section and every table row.
- `print-color-adjust: exact` - without it the print engine may drop backgrounds, which
  would erase the three-way adherence split entirely.

The wall chart uses `@page { size: A4 landscape; margin: 10mm }` and the same
no-width/height rule.

### Charts

Hand-rolled SVG strings (`charts/`), inlined as base64 `data:` URIs. Not
`react-native-gifted-charts`: that renders into a live view hierarchy, which would mean
mounting a component and screenshotting it - the same fragile capture path the day card
already pays for - and it would print at screen density rather than printer resolution.

Everything is greyscale. Meaning is carried by **shape** (circle / square / triangle /
diamond per field), **fill** (solid vs hollow) and a **word** in the legend.

One band per chart, for the metric's primary field; other fields' targets still govern
hollow markers and are printed in full in the appendix. Two overlapping shaded regions on
one greyscale axis are unreadable.

The band's attribution is **also repeated as HTML text** in a `<figcaption>` under each
chart. The chart is an image: its words are pixels, invisible to a screen reader,
unsearchable in the PDF, and gone if the image fails to decode. The line naming who set the
threshold has to survive all three.

### Readings the meter refused to number

A glucometer printing LO asserted `glucose < 20 mg/dL`, where 20 is that meter's floor. That
is an inequality with real content, not a missing value, and it is the reading a clinician
acts on first. `reading.v1` stays NULL, `reading.qualifier_bound` holds the limit, and a
database trigger refuses any row carrying both.

These readings **are drawn**, at the meter's limit, as an **open chevron** — the four closed
marker shapes belong to the four fields, and an unclosed shape cannot be misread as a point.
A dashed rule labelled `meter's limit 20` is drawn across the axis, and the legend says
*"meter showed LO/HI — drawn at its limit, not measured"*. They are never joined into a
line and never counted as measurements. A reading whose meter range was never recorded
cannot be placed on an axis at all: it is counted, named in the caption, and left off.

Two figcaption sentences exist for this, and the distinction is load-bearing: one for marks
that **are** on the chart, one for readings that are **not**. An empty state is gated on the
record, never on the post-filter mark count — "No blood sugar recorded yet" printed over a
fortnight containing a hypoglycaemic reading is the app asserting something false.

**The bound is never printed as a bare number**, anywhere. `20` in a value column is
indistinguishable from a measurement to the next reader — a spreadsheet, a script, a doctor.
Every surface goes through `features/reports/data/censored.ts`, which is the only module
allowed to turn a bound into words, so there is one place to check. No average exists
anywhere in this app, and none was added: both obvious ways to include a censored reading in
one (substitute the bound, or drop the row) bias the result in the same direction, making a
hypoglycaemic reading look milder than it was.

## Data export

### CSV - the unconditional path (`exports/csv.ts`)

Dependency-free, no runtime imports at all, unit-tested. "Give me my data" is a promise the
app has to keep on the worst day - a phone about to be wiped, a relative who does not have
this app - and a library that fails to load turns that promise into an error dialog.

- **Long format, one file per record type.** A blood pressure is one row per number, not
  one row with three columns: the next reader is a pivot table or a script, and neither
  can guess that `v2` meant diastolic.
- **`README.csv` explains every column of every file**, and is *generated from the column
  definitions* rather than maintained beside them. A data dictionary that has drifted is
  worse than none - it makes a reader confident about the wrong column.
- Includes **`was_backfilled`** and **`edited_count`** on readings (and `edited_count` on
  symptoms). `doses.csv` has no `was_backfilled` because the schema has no such flag on a
  dose record; `recorded_delay_minutes` is the honest equivalent, and README says so.
- CRLF line endings, RFC 4180 quoting, and a **UTF-8 BOM by default** - without it Excel on
  Windows reads the file as the system code page and a Hindi note becomes mojibake.
- Booleans are written as the words `yes` / `no`, not `1` / `0`.
- **Formula injection is neutralised**: a text cell beginning `= + @ TAB CR` is prefixed
  with an apostrophe. A cell that is simply a negative number (`-5`, `-0.25`) is left
  alone - mangling every negative value to defend against a formula that cannot occur in
  those columns would corrupt real data.

Files: `README`, `readings`, `doses`, `medicines`, `schedules`, `symptoms`, `labs`,
`targets`, `medicine-changes`, `visits`, `questions`, `care-plan`.

### XLSX - the nicety (`exports/xlsx.ts`)

**SheetJS caveat, written down so nobody rediscovers it:**

- SheetJS is **not on npm**. The maintained distribution moved to a tarball served from
  `cdn.sheetjs.com`; `npm i xlsx` gets an abandoned 0.18.x fork with published advisories.
  This project has deliberately **not** installed it yet.
- Its tested matrix stops at **React Native 0.79.2**. This app runs 0.81.5 on Hermes, and
  the zip writer does large typed-array work that nobody has verified on that engine. It
  may work perfectly; it may throw, return an empty string, or produce a file Excel refuses.

Therefore:

1. The module is required **lazily** (a throw at module scope would break app start-up) and
   **indirectly** - the specifier is assembled at runtime (`['x','l','s','x'].join('')`) so
   Metro's static dependency collection never sees it and **the bundle still builds when
   the package is absent**. Metro's runtime `require` rejects a non-literal specifier,
   which is exactly the failure this code absorbs.
2. Every capability is feature-detected, and the payload is checked for being a non-empty
   string (>512 bytes) before it is written. A zero-byte `.xlsx` looks to the user exactly
   like losing her data.
3. Any failure falls back to the CSV bundle - **silently for the user** (she asked for her
   data and she gets it) and **loudly in the log**, because a silent permanent fallback is
   how a feature quietly stops existing.

To enable XLSX later: add the CDN tarball to `package.json`
(`"xlsx": "https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz"`) and verify on a
real device on Hermes. No code change is needed - the loader will simply start succeeding.

### File lifecycle (`exports/files.ts`)

Generated files live in `Paths.cache/exports/`. The cache, not documents: a report is a
plaintext copy of data the database already holds, and Android reclaiming it under storage
pressure is the behaviour we want.

A file survives only if it is **both** among the newest 10 **and** younger than 24 h.
Either rule alone leaves clinical PDFs lying around - a size-only rule keeps a six-month-old
report on a phone that exports rarely, an age-only rule keeps fifty from one afternoon.

Pruning runs:

- **on start**, behind `InteractionManager.runAfterInteractions` **plus** a 4 s delay, so it
  is never on the first-paint path;
- **after each share**, but **never at the moment `shareAsync` resolves**. On Android that
  promise settles when the chooser is *displayed*; the receiving app reads the URI after
  the user picks a contact, which can be a minute later. Deleting it in between is a share
  that fails silently in someone else's app. `PRUNE_DELAY_AFTER_SHARE_MS = 90_000`,
  coalesced across repeated shares.

Call `pruneExportsOnAppStart()` once from app start-up.

### Sharing vs the gallery

**The share sheet is the default action everywhere.** `shareAsync` hands one file to one
app the user picks, through a FileProvider URI with a temporary grant. Nothing else gains
access, nothing is indexed, nothing is backed up as a side effect.

**Saving to the phone gallery is demoted behind a blocking warning that is shown every
time.** `exports/gallery.ts` exports `GALLERY_WARNING`, `GALLERY_WARNING_TITLE`,
`GALLERY_CONFIRM_LABEL` and `GALLERY_CANCEL_LABEL` for it.

Why the warning exists: **MediaStore is a global, unencrypted namespace.** The moment a
file lands in it -

- every gallery app, file manager and "cleaner" with media permission can read it, which
  applies to a photo of a lab report exactly as it applies to a holiday snap;
- Google Photos backup uploads it in the clear if it is on, and so do Mi Cloud gallery
  sync, Samsung Cloud and every OEM equivalent. On an Indian budget phone at least one of
  these is usually on and the user does not know it;
- it survives uninstalling this app.

That disclosure is irreversible in the way that matters: the copy in someone else's cloud
cannot be recalled by deleting the local file.

**There is deliberately no "don't ask again."** Consent to publish one day's summary to the
family WhatsApp is not consent to publish a TB prescription six months later, and a
remembered checkbox turns the first into the second. `saveImageToGallery` requires an
explicit `userAcceptedWarning: true` and throws without it.

Two more details: the permission request passes **`writeOnly: true`**, which keeps
`READ_MEDIA_IMAGES` out of the merged manifest and sidesteps Google Play's Photo and Video
Permissions declaration; and the image is **re-encoded before saving**, which strips every
EXIF block - an image that originated in the camera carries GPS coordinates, and publishing
a patient's home location alongside her medicine list is worse than the medicine list, and
invisible. MediaStore takes images, video and audio only, so PDFs go out through the share
sheet - which is the safer path anyway (`GALLERY_SUPPORTS_PDF = false`).

## Wall chart

Printable A4 **landscape**, split into two half-month blocks. A single 31-column grid gives
each day about 7 mm, which is narrower than the handwriting of the person it is printed for;
splitting doubles it. Rows are one per medicine per scheduled time (tick boxes, 16 pt tall),
plus taller blank rows for blood pressure, blood sugar and weight.

**Bilingual by construction**, unlike the OPD report: it lives in a house, not a consulting
room. The caller passes labels in the user's language and the English default is printed
underneath in small type, so a visiting nurse can also read it.

Paper is the ultimate offline fallback - it works when the battery is flat, when the phone
is with the son who took it to work, and after the app is uninstalled. It is also the thing
an elderly patient actually trusts, and it captures doses on days the phone was dead, which
are exactly the days that become a no-record run and suppress the adherence figure. Bring
the sheet back, backfill the ticks, and the record is whole again.

## Testing

```bash
npm test                                   # the whole suite
node --test --experimental-strip-types "src/features/reports/**/*.test.ts"
```

Two test files, chosen on the same principle as `src/features/adherence/compute.ts`: test
the pure things that quietly corrupt a record when they are wrong.

- `exports/csv.test.ts` - the CSV writer: quoting, formula guards, BOM, long format, the
  generated README covering every column, and that the word *missed* appears nowhere in the
  bundle.
- `opd/adherenceSection.test.ts` - the suppression rendering: that a null percent prints
  its reason and **no percentage anywhere a reader can see it**, that the split is always
  three-way, that the disclaimer is verbatim and a blank one throws, and that no badge,
  streak or accusation reaches the page.

Both use the dynamic-import shape from `src/features/adherence/adherence.test.ts` - Node's
type-stripping loader wants a fully specified `./x.ts`, and the tsconfig does not enable
`allowImportingTsExtensions`. Both tested modules therefore have **no runtime relative
imports**; only erased `import type`.

## Wiring a screen

```tsx
import {
  collectDayCard, collectOpdReport, collectExportData,
  useDayCardCapture, DayCardCaptureHost, shareDayCard,
  shareOpdReport, exportAndShareData, printWallChartPdf,
  pruneExportsOnAppStart, GALLERY_WARNING, saveImageToGallery,
} from '@/features/reports';

const capture = useDayCardCapture();
// ...somewhere inside the screen's own tree:
<DayCardCaptureHost controller={capture} labels={{ medicines: t('nav.medicines') }} />

// Day card
const data = await collectDayCard(profileId, todayLocalDate);
const card = await capture.capture(data);
await shareDayCard({
  data,
  card,
  dialogTitle: t('reports.share'),
  onNotice: (m) => toast.show({ message: m }),
});

// OPD report
const report = await collectOpdReport(profileId, { fromDate, toDate });
await shareOpdReport(report, t('reports.share'));

// Data export
await exportAndShareData(
  await collectExportData(profileId, { fromDate, toDate }),
  t('reports.share'),
);
```

Call `pruneExportsOnAppStart()` once at start-up.
