# Reading a prescription with AI

What the model is asked, what it may answer, what happens when it fails, what it costs,
and — the part worth reading first — what it is never permitted to decide.

- **Provider**: Google Gemini, `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, raw `fetch`. There is no Node SDK in React Native and none is needed.
- **Default model**: `gemini-3.6-flash`. Also selectable: `gemini-3.5-flash-lite` (cheap, printed prescriptions), `gemini-3.1-pro-preview` (slow, for a page the others struggle with).
- **Key**: `expo-secure-store`, prompted lazily on the first scan. **Never a launch blocker** — every other feature in the app works without one, and medicines can always be typed in by hand.
- **Code**: `src/features/ai/` (provider, key, image prep), `src/features/prescriptions/` (schema, prompt, extract, confirm, supersession), `src/features/care/` (calendar, refill, guards).

---

## 1. What the AI is never permitted to decide

This is the whole design in one list. Everything else in this document is mechanism.

| The AI may | The AI may never |
| --- | --- |
| Transcribe what is written on the paper | Decide what medicine anyone takes |
| Say it cannot read something | Guess a plausible drug name to fill a gap |
| Decode "1-0-1" into a structured pattern | Choose the clock times a reminder fires at |
| Report the follow-up instruction that is written | Invent a follow-up because a course is five days long |
| Report the tests that are written | Suggest a test that "would usually be done" |
| Propose a criticality tier, with a reason | Set that tier — a human confirms it |
| Report a duration as written | Flatten a tapering course into one schedule |
| — | Choose any lead time, turnaround or refill window |
| — | Comment on whether a prescription is correct, safe or complete |
| — | Create a `medicine`, `dose_schedule` or `care_event` row |

The last one is enforced by the database, not by convention. `medicine.confirmed_by_user_at`
and `dose_schedule.confirmed_by_user_at` are both `NULL` on anything the AI produced, and
`trg_occ_requires_confirmed_medicine` / `trg_occ_requires_confirmed_schedule` make an
unconfirmed row **structurally incapable** of producing a dose occurrence. Both
confirmations are separate because they fail separately: *"1-0-1 misread as QID" leaves the
drug name perfectly correct and quadruples the dose.*

**The offsets are the app's, not the model's.** The AI supplies clinical anchors — the visit
date and which tests were written. Every offset around them (book 2 days ahead, report
turnaround, refill lead) is chosen by this app, marked `anchor_source: 'inferred'`, shown
with its arithmetic, and editable. There is no evidence for a lead time anywhere on a
prescription, so a model-chosen number could never be checked against the image by the
person confirming it.

---

## 2. Privacy: the crop is the control, not an optimisation

Free-tier Gemini content may be used by Google to improve their products and may be
reviewed by humans. The top band of an Indian OPD prescription carries the patient's name,
often her age and sex, the doctor's name and registration number, and the hospital's name
and address. The lines underneath say what she is being treated for. A TB or HIV regimen
next to a full name has consequences at work and at home.

So `src/features/ai/imagePrep.ts` exports `cropToMedicineBlock()`, and it is the **only**
function that produces an uploadable image:

- Default rectangle removes the top **22%** (`HEADER_BAND_FRACTION`) — `defaultMedicineBlockRect()`.
- `runExtraction()` applies that default when the caller supplies no rectangle, so there is no path to the network that sends a whole page by omission.
- A caller may pass its own rectangle — including the whole page, which is the user's informed choice to make in the crop dialog. `includesPageHeader()` powers the warning next to that choice; it never refuses.
- The full-resolution original never leaves the device. It stays at `prescription.image_uri` and is what she re-reads when the app gets something wrong.
- Long edge ≤ **2576 px**, JPEG **q0.85**, base64 with all whitespace stripped (a newline inside `inlineData.data` is an opaque 400).
- Multi-page: the same rectangle is applied to every page by default. That is the conservative choice, and it has a real cost — a continuation sheet whose first medicine sits high on the page can lose a line. `total_medicines_counted` (§4) is the detector for that, and per-page rectangles are supported for callers that show a crop editor per page.

---

## 3. Request settings, and three things not to "fix"

```jsonc
{
  "contents": [{ "role": "user", "parts": [{ "text": "<prompt>" }, { "inlineData": { "mimeType": "image/jpeg", "data": "<base64>" } }] }],
  "generationConfig": {
    "temperature": 1.0,
    "candidateCount": 1,
    "maxOutputTokens": 32768,
    "seed": 1234567,
    "thinkingConfig": { "thinkingLevel": "high" },
    "responseMimeType": "application/json",
    "responseSchema": { /* §4 */ }
  }
}
```

1. **`temperature: 1.0`, always.** The instinct on an extraction task is to drop it to 0 for determinism. Gemini 3's documentation explicitly warns that lowering it causes looping and degraded reasoning — on a smudged handwritten line that shows up as the model repeating a drug name it already emitted. **Determinism comes from `seed`.**
2. **`thinkingLevel`, not `thinkingBudget`.** Gemini 3 replaced the token budget with a level. The old field is ignored, which looks exactly like thinking being switched off.
3. **No `anyOf`, anywhere.** The structured-output subset excludes recursive schemas and most constraint keywords, and `propertyOrdering` behaviour inside a union is undocumented. Optionality is expressed with an explicit `"unknown"` member or the value `0`.
4. **`maxOutputTokens` is a COMBINED thinking + answer budget, and 32768 is not a spend.** It was 8192, on the reasoning that 8192 was enough for ~25 medicines. Every clause of that is true about the *answer* and wrong about the *budget*: on Gemini 3 thinking and generation draw from one pot, so `thinkingLevel: "high"` on a smudged line spent the whole allowance, generation stopped at `MAX_TOKENS` with an empty text part, and the user was told to *photograph fewer lines* — which failed identically. That was the report "AI prescription scanning is not working". A cap costs nothing when unused; lowering it to save money saves nothing and reinstates the defect. If it ever happens again the app now says so in its own words: `finishReasonError()` is handed the token counts and returns **`thinking_budget_exhausted`**, a different code with a different sentence, rather than `truncated`. §11.4 is how to recognise it from the phone.

Other choices worth knowing:

- The API key travels in the `x-goog-api-key` **header**, never as `?key=` — a query parameter ends up in proxy logs and crash reports.
- `safetySettings` is deliberately **not** sent. Default thresholds are what the block-handling codes are calibrated against, and a category name that has drifted turns every scan into a hard 400 — a worse failure than the occasional block it would avoid.
- Timeout **300 s per attempt** via `AbortController` (§6a bounds the whole sequence). Not generous, measured: a 2 MB upload on a clinic-corridor connection is minutes on its own before a thinking model emits its first token. The draft row and the photograph are persisted **before** the call, so a timeout costs waiting, never data.
- The seed is fresh per attempt and recorded with the result. A stable seed would make "read it again" return the identical wrong answer.
- Free tier is roughly **15 requests/minute, 1500/day**. A user doing six scans a month is three orders of magnitude below it.

---

## 4. The schema

Authoritative source: `PRESCRIPTION_RESPONSE_SCHEMA` in `src/features/prescriptions/schema.ts`.
Every field is `required`; "not on the paper" is expressed as the string `"unknown"` or the
number `0`, never by omitting the field. Nesting stays at or under five levels.

### Prescription level

| Field | Type | Notes |
| --- | --- | --- |
| `total_medicines_counted` | INTEGER | Counted **before** transcribing. Cross-check against `medicines.length`. |
| `medicines[]` | ARRAY | See below. |
| `prescriber` | STRING | Usually `"unknown"` — the letterhead is cropped away. |
| `clinic` | STRING | Same. |
| `prescribed_on` | STRING | `YYYY-MM-DD`. DD/MM/YY is the common Indian form. |
| `prescribed_on_verbatim` | STRING | As written: `"12/8/26"`. |
| `prescribed_on_confidence` | ENUM | high / medium / low / unknown |
| `follow_up.present` | BOOLEAN | True only if actually written. |
| `follow_up.verbatim` | STRING | The words. **This is the evidence** — without it the calendar refuses the row. |
| `follow_up.absolute_date` | STRING | `YYYY-MM-DD` if a date is written. |
| `follow_up.relative_value` | NUMBER | `2` in "after 2 weeks". |
| `follow_up.relative_unit` | ENUM | day / week / month / year / unknown |
| `follow_up.confidence` | ENUM | |
| `tests_advised[]` | ARRAY | `name_as_written`, `normalised_name`, `category`, `verbatim_instruction`, `confidence`. Empty if none. |
| `non_medicine_instructions[]` | ARRAY | `text`, `kind` (diet / activity / wound_care / return_condition / other). |
| `page_notes` | STRING | About the photo: "the bottom edge is cut off", "this looks like page 2". |

`tests_advised[].category` is `routine_biochemistry | culture | histopathology | imaging |
other | unknown`. It exists **only** to pick a turnaround default (§7) — it is an
operational bucket, not a clinical classification.

### Per medicine

| Field | Type | Notes |
| --- | --- | --- |
| `name_as_written` | STRING | Including the prefix (Tab., Cap., Syp., Inj.). No spell-correction. |
| `generic_guess` | STRING | Only from a brand name actually recognised. A convenience, not a claim. |
| `strength` | STRING | With units: `"500 mg"`. |
| `form` | ENUM | tablet / capsule / syrup / injection / inhaler / drops / cream / other / unknown |
| `dose_quantity.value` | NUMBER | How much at ONE time. |
| `dose_quantity.unit` | STRING | tablet / ml / puff / drop. |
| `dose_quantity.verbatim` | STRING | `"1/2"`, `"½"`, `"1 tab"` — kept because a fraction is not the same instruction as a decimal to someone holding a strip. |
| `frequency.pattern_code` | STRING | `1-0-1`, OD, BD, TDS, QID, HS, SOS, STAT, Q6H, "alternate day", "weekly", or a combination. |
| `frequency.slot_notation` | STRING | The morning-afternoon-night form, verbatim. |
| `frequency.doses_per_day` | NUMBER | |
| `frequency.interval_days` | NUMBER | 1 daily, 2 alternate, 7 weekly. |
| `frequency.verbatim` | STRING | As written. **This is the evidence** — `propose.ts` shows no dose count without it. |
| `food_relation` | ENUM | before / after / with / empty / any / unknown. Never assumed. Silence is `unknown`, never `any`. |
| `food_relation_verbatim` | STRING | `"a/f"`, `"p/c"`, `"empty stomach"`. **This is the evidence** — a `food_relation` with nothing quoted here is read as unwritten. |
| `duration.kind` | ENUM | days / weeks / months / continue / until_review / **tapering** / unknown |
| `duration.value` | NUMBER | `5` in `"x 5 days"`. |
| `duration.verbatim` | STRING | |
| `route` | ENUM | oral / topical / inhaled / injection / ophthalmic / otic / nasal / rectal / vaginal / sublingual / other / unknown |
| `proposed_criticality` | ENUM | critical / standard / low / unknown — a proposal about **reminder loudness**. |
| `criticality_reason` | STRING | One factual sentence grounded in what is written. |
| `confidence.{name,strength,frequency,food,duration}` | ENUM | Per field. Read in ONE direction: low or unknown removes a proposal, high never earns one. |
| `needs_human_check` | BOOLEAN | True for any line with a choice between two readings. |
| `notes` | STRING | What is unclear about this line. |

### The zod pass

`parsePrescriptionExtraction()` (zod **v4**) re-reads the response and is deliberately more
tolerant than the schema is strict:

- An unrecognised enum value lands on `"unknown"` instead of discarding the other fourteen medicines.
- A number sent as a string is accepted; `0` and negatives become `null`.
- `"unknown"`, `"n/a"`, `"nil"`, `"-"`, `""` all collapse to `null`, so there is exactly one way to ask "was this written?".
- A malformed date (`2026-02-31`) becomes `null` rather than a date that round-trips into March.
- Every lenience is recorded as a `ParseWarning` the review screen can show.

**The cross-check.** `total_medicines_counted` versus `medicines.length` is the cheapest
available detector of a dropped line — the failure that is otherwise invisible, because a
list of four correct medicines looks exactly like a correct list of four. A mismatch is a
warning on the review screen, never a silent correction.

---

## 5. The prompt

Source: `PRESCRIPTION_PROMPT` in `src/features/prescriptions/prompt.ts`.
`buildPrescriptionPrompt({ todayLocalDate })` appends section 8.

> You are transcribing a photograph of a medical prescription from an Indian clinic. You are a careful transcriber. You are not a clinician, an advisor or an assistant.
>
> Return ONLY the JSON described by the response schema. No prose, no explanation, no markdown.
>
> **1. THE RULE THAT OVERRIDES EVERY OTHER RULE**
>
> If you cannot read something, say so. Write the exact string "unknown" for a text field, or 0 for a number.
>
> Never write a drug name, a strength, a frequency or a date that you inferred, completed, corrected or considered likely. A wrong medicine that looks right is the most damaging thing you can produce here: it will be shown to someone who cannot read the handwriting either, and if they accept it, this app will remind them to take it. "unknown" is always the safe answer and is never treated as a failure — a human will type in what you could not read.
>
> This applies especially when: a word is smudged, overwritten, or crossed out; a strength could be 5 mg or 50 mg; a brand name is close to another brand name you know; a line runs off the edge of the photograph; you are completing a partially visible word.
>
> Do not spell-correct drug names. Transcribe the letters that are actually there.
>
> **2. WHAT TO TRANSCRIBE** — Count the medicine lines you can see FIRST, and put that number in `total_medicines_counted`. Then transcribe them in the order they are written. If your count and your list disagree, leave them disagreeing — that mismatch is a deliberate cross-check and it is more useful than a tidy answer. […] If the paper describes a stepped-down or reducing course, set `kind` to "tapering" and transcribe the whole instruction in `verbatim`. Never flatten a taper into a single frequency. […] A tablet is not "oral" because tablets are usually swallowed. Never assume `food_relation`.
>
> **3. INDIAN DOSING SHORTHAND** — Decode the notation into the structured frequency fields. Do NOT convert it into clock times — the prescription does not say eight o'clock, and the person using this app chooses her own times later. [three-part = morning-afternoon-night; four-part = morning-afternoon-evening-night; OD/BD/TDS/QID/HS/OM/SOS/PRN/STAT; Q6H/Q8H/Q12H; alternate day → `interval_days` 2; weekly → 7] […] A two-part pattern such as "1-1" is ambiguous — some prescribers mean morning and night, others morning and afternoon. Transcribe it in `verbatim` and set `pattern_code` to "unknown".
>
> **4. FOLLOW-UP AND TESTS: ONLY IF ACTUALLY WRITTEN** — […] Never infer a follow-up from the length of a course. "x 5 days" does not mean "come back in 5 days", and turning it into one would put an appointment on someone's calendar that no doctor asked for. […] Never add a test that "would usually be done".
>
> **5. THE CRITICALITY PROPOSAL** — `proposed_criticality` decides only HOW LOUDLY this app reminds someone — whether the reminder sounds when the phone is on silent. It is not a judgement about the medicine. […] Give one short factual reason grounded in what is on the paper. If you cannot tell, use "unknown" and let a person decide.
>
> **6. WHAT YOU MUST NOT DO** — Do not comment on whether a medicine is appropriate, correct, safe, or duplicated. Do not mention interactions, side effects, contraindications or alternatives. Do not describe what a medicine is for, or what condition the patient may have. Do not add warnings, cautions or advice of any kind. Do not suggest additional medicines, tests, doses or appointments. Do not correct anything the prescriber wrote, even if you believe it is a mistake. Do not describe the patient, the doctor, or the clinic beyond the named fields. Do not add fields to the JSON, and do not write anything outside it.
>
> **7. FLAG WHAT YOU ARE UNSURE OF** — […] Use confidence honestly: "low" is useful information, a confident wrong answer is not. […] The person reading your output cannot check it against anything except the same photograph. Every "unknown" you write is a question they can answer in five seconds. Every plausible invention costs them far more.
>
> **8. TODAY'S DATE** *(appended)* — Use this for one purpose only: expanding a two-digit year, so "12/8/26" becomes 2026-08-12. Never use today's date as the prescription date, as a follow-up date, or as a substitute for a date you cannot read.

The instruction to write "unknown" rather than guess appears in three places — the rules,
every field description in the schema, and the closing reminder. The repetition is
deliberate: it is what makes the rule survive a long context.

---

## 6. Failures

Every failure path maps to exactly one code with its own sentence and its own next step.
There is no generic "something went wrong" anywhere in this pipeline — the user cannot tell
from that whether to retake the photo, turn on mobile data, wait five minutes, or give up
and type, and those are four different actions.

Source: `src/features/ai/errors.ts`. `messageKey` is `errors.ai.<code>`; the English
sentence is the fallback and the copy the key should carry.

| Code | Cause | What she is told | Next step | Retry? |
| --- | --- | --- | --- | --- |
| `no_key` | No key stored | Needs a Google AI key, or type the medicines | `add_key` | – |
| `invalid_key` | 400 mentioning a key, 401, 403 **with no reason we recognise** | The saved key was not accepted | `check_key` | – |
| `key_restricted` | 403 `reason` = `API_KEY_{ANDROID_APP,IOS_APP,HTTP_REFERRER,IP_ADDRESS}_BLOCKED` | The key is locked to one app or website; re-typing it will not change that; remove the restriction in Cloud Console | `type_manually` | – |
| `api_not_enabled` | 403 `reason` = `SERVICE_DISABLED` or `API_KEY_SERVICE_BLOCKED` | The reader is not switched on for the key's project; fixed in Cloud Console, not in the app | `type_manually` | – |
| `offline` | `fetch` rejected, not aborted | Needs the internet; your photo is saved | `check_connection` | ✓ |
| `timeout` | Our 300 s `AbortController` fired | Took too long, likely a slow connection | `retry_later` | ✓ |
| `cancelled` | Caller's `AbortSignal` fired | Reading was stopped; your photo is saved | `retry` | ✓ |
| `rate_limited` | 429, per-minute | Wait a minute and try again | `retry_later` | ✓ |
| `quota_exhausted` | 429 whose `quotaId` (or, failing that, message) names a **day** | Today's free allowance is used up | `type_manually` | – |
| `quota_zero` | 429 whose `quotaValue` is **0** | The project has no allowance at all; tomorrow is the same day; switch the API on in Cloud Console | `type_manually` | – |
| `bad_request` | 400 (our request) | A problem in the app, not your photo | `report_bug` | – |
| `model_not_found` | 404 | That reader is not available for your key | `check_key` | – |
| `server_error` | 5xx | Trouble at their end | `retry_later` | ✓ |
| `service_overloaded` | 503 | Busy right now | `retry_later` | ✓ |
| `safety_blocked_prompt` | `promptFeedback.blockReason` | It would not look at this photo; check the crop | `adjust_crop` | ✓ |
| `safety_blocked_response` | `finishReason` SAFETY / PROHIBITED_CONTENT / SPII / IMAGE_SAFETY | It stopped part-way and returned nothing | `type_manually` | – |
| `truncated` | `finishReason: MAX_TOKENS` **with an answer in hand** | Too long to read in one go; photograph fewer lines | `retake_photo` | – |
| `thinking_budget_exhausted` | `finishReason: MAX_TOKENS`, **no answer at all**, thought tokens spent | The budget went on thinking; a problem in the app, not the photo; fewer lines will not help | `report_bug` | – |
| `recitation` | `finishReason: RECITATION` | Stopped to avoid repeating memorised text | `type_manually` | – |
| `no_content` | No candidates, or no text part | Sent nothing back | `retry` | ✓ |
| `malformed_json` | Text was not JSON | Sent back something we could not understand | `retry` | ✓ |
| `schema_mismatch` | zod rejected the shape | Answer in the wrong shape; nothing was saved | `retry` | ✓ |
| `empty_result` | Valid, and empty | No medicines could be read in this photo | `retake_photo` | ✓ |
| `image_unreadable` | Crop/encode failed | This photo could not be opened | `retake_photo` | – |
| `crop_required` | No usable rectangle | Choose the part that lists the medicines | `adjust_crop` | – |
| `unknown` | Unclassified | Could not be read this time | `retry` | ✓ |

Notes on the tricky ones:

- **Neither MAX_TOKENS code is parsed.** A cut-off JSON either throws or — worse — parses into a medicine list that is silently missing its last drug.
- **MAX_TOKENS splits in two, on the token counts.** `outputTokens: 0` (and no text) with thousands of `thoughtTokens` is `thinking_budget_exhausted`: the budget went on thinking before one character of JSON existed, and *photograph fewer lines* is the instruction that makes it repeat. An answer that was produced and cut is `truncated`, where that instruction is sound. With no `usageMetadata` at all, a body carrying a fragment of an answer stays `truncated` — the blunter sentence, rather than a confident guess.
- **429 splits in three, on `details` first and the prose second.** A per-minute limit clears in a minute; a per-day limit clears tomorrow; **a `quotaValue` of 0 never clears**, because it is not an allowance that has been spent but one that does not exist (usually a project that has never had the API enabled). The free tier's 429 message says none of this — it is the generic *"You exceeded your current quota, please check your plan and billing details"* — so `details[].violations[].quotaId` and `quotaValue` decide, and the message match is kept only as the fallback for older bodies that carry no `details`.
- **403 splits in four, on `details[].reason`.** Google's own stable enum separates a key restricted to an app or website (`key_restricted`), a project with the API switched off (`api_not_enabled`), and a key that is genuinely wrong (`invalid_key`). It is read in preference to the English prose because the prose is not a contract, is not translated, and is capped at 300 characters in the log. An unrecognised `reason` falls through to `invalid_key` and is still logged, so a fault nobody has met yet is visible without the app inventing a remedy for it.
- **`model_not_found` tells the user to change a setting the app does not offer.** There is no model picker; see §11.6, item 1.
- **400 splits in two.** Google returns `INVALID_ARGUMENT` both for a malformed request (our bug) and for something that is not a key at all (a ten-second fix in Settings). `reason: API_KEY_INVALID` decides it when present, the message when not.
- **Thought parts are filtered out** before the text is parsed. Gemini 3 can return thought summaries as parts; concatenating them produces a `malformed_json` that is not malformed at all.
- **A markdown fence is stripped** defensively even though `responseMimeType` is set.
- **The failure is written to `prescription.extraction_error` as the code**, not the sentence. The sentence is presentation and will be rewritten and translated; the code is what a support conversation six months from now can match on.
- **The `detail` that travels beside it never carries a file path.** That column syncs, and the native image errors quote the URI by construction. See §11.6a.

`testKey()` (`ai/keyStore.ts`) makes one real call against `gemini-3.5-flash-lite` with no
image and a 16-token answer, so a mistyped key fails in Settings rather than in a clinic
corridor. It never writes anything — verifying and saving are separate, so a bad key cannot
replace a good one.

### 6a. Retrying — three codes, bounded, visible, cancellable

Source: `src/features/ai/retry.ts`. Applied once, in `createProvider()`, so every provider
and every caller — a scan, a key check — inherits it and no provider implements its own.

**Only three codes are retried automatically**: `service_overloaded` (503), `rate_limited`
(the per-minute 429) and `timeout`. Everything else returns the same answer the second time
and each attempt spends a request out of a free-tier allowance that does not come back until
tomorrow. Of the three codes a 429 can produce, only `rate_limited` is in that set:
`quota_exhausted` comes back tomorrow and `quota_zero` never comes back, so asking again
buys nothing but her time — and `quota_zero` is the one that looks most retryable, because
the server frequently attaches its own `RetryInfo` to it. That advice is dropped, by the
same rule that keeps a `Retry-After` off a 403. Note that `retryable` in the error table above is a different question — it is
advice to the UI about offering a *Try Again* button. `server_error` (500/502/504) is
deliberately **not** retried yet; adding it is one line, once a field report shows a 500 that
a retry cleared.

| | |
| --- | --- |
| Attempts | 3, including the first |
| Backoff | 2 s then 4 s, each multiplied by a random factor in [0.5, 1.5) |
| Server advice | `Retry-After` / `google.rpc.RetryInfo.retryDelay` wins over the curve, refused above 30 s |
| Worst case, fast 503s | ~15 s and three round trips |
| Worst case, timeout | one full 300 s attempt, then whatever the 120 s allowance leaves — **420 s ceiling**, 165 s for a key check |

The jitter is not decoration: 503s arrive in bursts, and every phone backing off by exactly
2 s comes back in the same instant.

**She can see it.** `AiRequest.onAttempt` fires before every attempt and before every wait,
with `{ phase, attempt, maxAttempts }` and, while waiting, `retryInMs` and the failure that
caused it. A retry the user cannot see is indistinguishable from a frozen screen.

**She can stop it.** `AiRequest.signal` interrupts the wait itself, not just the request, so
backing out of the screen ends the sequence within milliseconds and reports `cancelled` —
with the failure that preceded it kept in `detail`.

**The photo is encoded once.** The retry wraps one already-built `AiRequest`; every attempt
reuses the same `images` array by reference. Three attempts cost one crop, one resize and
one JPEG encode. The seed does not change either — a retry asks the same question, because
nobody answered it. Asking a *different* question is the "read it again" button, and it is
hers to press.

**No silent model fallback.** A 503 is what a real, busy model returns; a wrong model id is
a 404 with its own code and its own advice. Swapping in `flash-lite` — weaker on
handwriting, which is the entire difficulty here — to save fifteen seconds would trade a
delay she can see for an inaccuracy she cannot. The reasoning is written out over
`DEFAULT_PROVIDER_ID` in `ai/settings.ts`.

---

## 7. Where the offsets come from

`src/features/care/calendar.ts`. Anchors are transcribed; the numbers below are ours,
proposed, and editable in Settings (`care/settings.ts`, stored in `app_meta`).

| Offset | Default | Meaning |
| --- | --- | --- |
| `appointmentBookLeadDays` | 2 | Remind to book the visit this many days ahead |
| `testBookLeadDays` | 2 | Remind to book the test this many days ahead |
| `reportInHandDays` | 1 | Have the report before the visit, not on the way in |
| turnaround: routine biochemistry | 1 | |
| turnaround: culture | 3 | |
| turnaround: histopathology | 5 | |
| turnaround: imaging | 0 | Usually reported at the scan |

**These are proposed operational defaults, not clinical or laboratory standards.** They are a
starting guess at how Indian labs behave, they vary by lab and by city, and every one is
user-editable. When a user drags a date she is not correcting our error — she is supplying
information we never had.

The chain, derived backwards from the visit:

```
test_book ──(−2 d)──> test_do ──(−turnaround)──> test_collect ──(−1 d)──> visit
                                                                           │
                                                        book_appointment ──(−2 d)
```

Rules the derivation obeys:

- `addMonthsClamped` for relative follow-ups: **"review after 1 month" written on 31 January is 28 February**, not 3 March.
- **If the prescription date is illegible, propose nothing** for a relative follow-up rather than anchoring off today — that error is exactly as large as the delay between the visit and the photograph, and the result would look identical to a date the doctor gave. An *absolute* written date still works, because nothing is being counted from anywhere.
- A derived date is never proposed in the past: it is pulled forward to today and says so. A **transcribed** date is never moved, even when it has already passed.
- A test with no visit to hang off is handed back for the user to date; her date becomes a `manual` anchor and the same three offsets hang off it.

`guards.ts` then refuses anything the evidence does not support — a follow-up that appears
nowhere on the prescription, a test that was not advised, an inferred row that cannot name
its anchor, or one whose `due_on` is not `anchor + offset`. It re-derives the follow-up date
with the same function the deriver used, so the two cannot disagree. `buildConfirmModel()`
returns **transcribed** and **inferred** as separate lists so the confirm screen cannot render
them the same way.

Refills are pure arithmetic on her own count (`care/refill.ts`): quantity ÷ units per day,
floored, minus a lead time, with a warning when the run-out date falls **before the next
visit** — the most preventable adherence failure there is, and free to detect offline. The
working is returned as a string so the screen can show it.

---

## 8. What one scan costs

Measured per **single cropped page**. Actual usage is reported back in
`usageMetadata` and stored with every extraction (`_extraction.usage`), so real numbers can
be read off a device rather than estimated.

| Part | Tokens | Why |
| --- | --- | --- |
| Image | ~1,300–2,100 | Gemini tiles images at 768 px and bills ~258 tokens per tile. A 2576 px crop is 6–8 tiles. |
| Prompt | ~1,900 | §5, including the appended date section. |
| Response schema | ~1,200 | Field descriptions are part of the request. |
| **Input total** | **~4,400–5,200** | |
| Thinking | ~1,000–3,000 | `thinkingLevel: "high"`. Billed as output, reported separately. |
| Output JSON | ~900–1,400 | Five medicines with per-field confidence. |
| **Output total** | **~1,900–4,400** | |

> **Rates below are an assumption, not a quotation.** Verify against current Gemini pricing
> before quoting them to anyone. The arithmetic is what matters; substitute today's numbers.

Assuming **$0.30 / M input** and **$2.50 / M output**, and ₹88 to the dollar:

```
input   5,200 × $0.30/1,000,000 = $0.0016
output  3,000 × $2.50/1,000,000 = $0.0075
                                  ───────
per scan                          $0.0091  ≈  ₹0.80
```

- **Six scans a month ≈ ₹5.** A second page roughly doubles the image portion, not the whole.
- **On the free tier this is ₹0.** ~15 requests/minute and ~1500/day; six a month is three orders of magnitude below the ceiling — at the cost of the data-use terms in §2, which is precisely why the crop is mandatory.
- `gemini-3.5-flash-lite` is materially cheaper and is what `testKey()` uses; `thinkingLevel: "low"` roughly halves the output side.

---

## 9. The path through the code

```
capture screen ──> prescription row + photo saved          (before anything else)
      │
      ▼
runExtraction()  crop ──> resize/encode ──> Gemini ──> JSON.parse ──> zod
      │                                                                │
      │  every failure: a typed code, stored on the row, draft intact  │
      ▼                                                                ▼
prescription.extraction_json = { projection…, _raw: <verbatim>, _extraction: <provenance> }
      │
      ▼
proposeForMedicine()  a number + the paper's own words, or a reason there is none
      │
      ▼
review screen  ── she answers, per line; nothing is accepted by default ──┐
                                                                       ▼
                                              confirmExtraction()  medicine + dose_schedule
                                              both confirmed_by_user_at set, ≤ 4 doses/day
                                                                       │
                                              reconcile.ts: Continued / Changed / New /
                                              Not on this prescription — default Keep
                                                                       │
                                              care/: derive ─> guards ─> confirm screen ─> care_event
```

- **`extraction_json` holds both shapes.** A normalised projection at the top level in the app's own vocabulary, so the review screen's tolerant reader finds `medicines[]`; the model's verbatim JSON under `_raw`, so a better parser next year can re-derive from it without another photograph; provenance under `_extraction` (model id, prompt version, seed, token usage, cropped page URIs, parse warnings).
- **A proposal is not a default.** `propose.ts` turns a reading into a proposition plus the evidence for it — the words on the paper, and how sure the model said it was — and never into a value a field can be seeded with. A frequency is proposed only when every transcription of that line (`pattern_code`, `slot_notation`, `verbatim`) decodes to the *same* instruction, the model's own `doses_per_day` agrees, it is within the cap, and the model flagged nothing; otherwise a typed `FrequencyRefusal` says why, so the screen can print "the paper does not say which" rather than an empty box. Where it refuses, the fallback is exactly what shipped before it existed — she types the number — which is why this can improve on the status quo and cannot be worse than it. The food relation is gated more loosely on purpose: it is not a multiplier, and until now it reached a confirmed `dose_schedule` row *without ever being shown to her*.
- **The four-dose cap.** `MAX_AI_DOSES_PER_DAY = 4` — the highest frequency Indian shorthand expresses unambiguously (QID, 1-1-1-1). Anything above it is hourly dosing or a taper, both of which need real times from a person. A medicine over the cap is still created (she photographed it; losing it would be worse) but gets **no schedule**, so the database cannot produce an occurrence for it, and it is returned in `needsManualSchedule`.
- **Supersession never stops anything by default.** A prescription that does not mention Metformin usually means "carry on with your Metformin", not "stop it". Replace-all must enumerate exactly what stops and be handed that list back; a `critical` medicine can never be stopped by a bulk action (one at a time, with the name on screen, yes); and nothing may result in zero medicines. `Changed` stays on the **same `thread_id`** as a new version — splitting it would silently reset a TB patient's six-month adherence history on the day her dose was adjusted.

---

## 10. Tests

```bash
npm test                      # node --test, all suites
```

- `src/features/prescriptions/frequency.test.ts` — the shorthand decoder, weighted towards what it must **refuse**: "1-1" (ambiguous), tapers, Q5H, unreadable text. Plus the trap that "three times daily" must not decode as once a day.
- `src/features/prescriptions/propose.test.ts` — the proposal layer, weighted the same way and for the same reason: a withheld proposal costs one typed digit, an accepted wrong one rings four times a day. Covers each refusal (`sources_disagree`, `ambiguous_two_part`, `model_count_disagrees`, `no_evidence`, `as_needed`, `one_off`, `tapering`, `hourly`, `weekday_unspecified`, `exceeds_ai_dose_cap`), the trap that a clean `pattern_code` must not rescue words the decoder cannot corroborate, and that `BD` vs `1/2-0-1/2` is not a disagreement.
- `src/features/care/calendar.test.ts` — the derivation, the guards and the refill arithmetic: month clamping on 31 January, refusal when the prescription date is unreadable, chains per test category, clamping out of the past, and every guard refusal.
- `src/features/ai/gemini.test.ts` — HTTP status and error body → one code, one sentence, one next step.
- `src/features/ai/retry.test.ts` — the loop: what is retried, what is not, the budget, cancellation.
- `src/features/ai/observability.test.ts` — that the progress bus and the developer log are actually *published to*, rather than merely imported.
- `src/features/ai/imagePrep.test.ts` — the crop, against a stub that *applies* the geometry rather than answering fixed numbers: what `prep.page` says about a 3024×4032 photograph, and that a native failure reaches `prescription.extraction_error` with the file path removed and the diagnosis intact. Its error strings are copied from the shipped Kotlin, not invented.
- `src/features/ai/diagnosis.test.ts` — **§11 in executable form.** Drives the real provider and the real retry loop against Google's own failure bodies with a stubbed `fetch`, and asserts what a person could read off the log afterwards. **No test in it is marked `DEFECT` any more**; four were, and each now asserts the fix against the same body Google actually sends. Two of its tests read source text rather than running it, because `prescriptions/extract.ts` imports the database and cannot be loaded here: one counts the `record()` call sites in the whole AI path (thirteen) and proves every one sits behind `if (isRecording())`, the other proves the crop geometry is actually spread into the `prep.page` notes rather than merely exported.

All of these are pure — no database, no network, no clock they do not receive.

---

## 11. Reading a failed scan from the phone

For whoever set the phone up. No cable, no laptop, no adb. Everything below happens on the
device, and the whole log can be copied out of it into a chat window without carrying a
medicine name, a reading, a name, a photograph or the key — see `src/features/devlog/`.

**Nothing is recorded until the switch is on.** Turn it on *before* reproducing the fault;
the app keeps nothing retrospectively, on purpose.

### 11.1 Turning the notes on

| # | Screen | What to tap | What it says |
| --- | --- | --- | --- |
| 1 | any tab | **More** — the last tab in the bottom bar | |
| 2 | More | **Settings**, under the heading *This phone* | "Bigger text, language, reminders" |
| 3 | Settings | scroll to the very bottom — the last section is *For whoever set this up* | |
| 4 | Settings | the switch on **Keep technical notes** | off: "Off. Nothing about how the app is working is written down." |
| 5 | Settings | — | on: "On. Aarogya is noting how each step goes, so a fault can be looked at on this phone." A second row appears underneath. |
| 6 | Settings | **Developer Options** | "See the notes, and delete them" |
| 7 | Developer Options | **App Logs**, under *The notes* | "Nothing recorded yet", until something is |
| 8 | App Logs | — | the list, newest first |

The **App Logs** screen has four filter chips — **Everything**, **Prescription Scanning**,
**Rest Of The App**, **Problems Only** — and, at the bottom, **Copy All Notes** and
**Delete Logs**. **Share** is in the top right. Tapping a line opens it and shows every
field one per line, plus **Copy This Note**.

### 11.2 Reproducing a failed scan

1. Tab **Medicines** → **Scan a prescription**.
2. Photograph the pages (**Take the photo**, then **Take page 2**…, or **Choose a photo**), then **Done**.
3. On the prescription screen: **Read this with AI**.
4. The dialog **What gets sent?** opens. **Send only the medicines part** is the default and shades the band that stays on the phone; **Send the whole page** is the other choice. Then **Read it now**.
5. Watch the step line: *Getting photo 1 of 1 ready* → *Sending the photo, about 1.4 MB* → *The reader is looking at it. This is the long part.* → *Saving what came back*. If the reader is busy it says so and counts down — that is the app asking again on its own, and it is in the log as `ai.wait`.
6. When it fails, the banner reads **"Could not read this prescription. You can type the medicines yourself."** and — only while the switch is on — carries a button **See The Technical Notes**, which opens App Logs already filtered to *Prescription Scanning*.

**A key check writes notes too, and they look almost the same.** Settings →
**Prescription scanning (AI)** → **Check this key** (or **Check the saved key**) makes one
real call. Tell it apart in the log by the request line:
`modelId=gemini-3.5-flash-lite images=0 structured=false`. A scan is
`modelId=gemini-3.6-flash images=1 structured=true`. A key check is also the cheapest way
to reproduce a key fault: no photograph, one small request, and the same `ai.http` line.

### 11.3 What one scan writes

One line per step, oldest at the bottom of the screen. The names are a closed list
(`src/features/devlog/types.ts`), so six names learned once cover every scan.

| Event | Written when | What to read off it |
| --- | --- | --- |
| `run.start` | the scan begins | `runKind=scan`. Everything until `run.end` shares one run id. |
| `prep.page` | each photo cropped and encoded | `page`, `pages`, `ok`, `approxBytes`, `mimeType` — **and the rectangle**: `srcWidth`/`srcHeight` (the photograph), `cropOriginX`/`cropOriginY`/`cropWidth`/`cropHeight` (fractions of it), `droppedTopPx` (rows removed from the top, already multiplied out), `outWidth`/`outHeight` (what was actually sent), `defaultCrop`, `smallOutput`. `ok=false` with `errorCode=budget_exceeded` means later pages were **not sent**. |
| `ai.attempt` | before each try | `attempt`, `maxAttempts`, `timeoutMs`, `budgetLeftMs`. Three of these means it asked three times. |
| `ai.request` | as the request leaves | `modelId`, `thinkingLevel`, `maxOutputTokens`, `requestBytes`, and `keyPresent` / `keyLength` / `keyShape`. **Its absence is a fact** — see the `no_key` row below. |
| `ai.http` | the answer, or the lack of one | `httpStatus`, `errorCode`, `apiStatus`, **`apiReason`** — Google's own enum for the fault, which is what decided the code — plus `quotaId` / `quotaValue` on a 429, and **`apiMessage`**, Google's own words. |
| `ai.response` | a 200 body | `finishReason`, `textChars`, `promptTokens`, `outputTokens`, `thoughtTokens`. |
| `ai.parse` | the answer parsed | `topKeys`, `arrayCounts` ("medicines=7"), `empty`. A second one adds `itemsRead`, `warningCodes`, `countMismatch`. |
| `ai.wait` | between two tries | `retryInMs`, and `advised` — `true` means the *server* named the wait. |
| `ai.cancelled` | she left the screen | `where`. Not a fault. |
| `ai.outcome` | each try's verdict | `ok`, `errorCode`, `httpStatus`, `elapsedMs`. |
| `run.end` | the scan ends | `ok`, `errorCode`, `threw`. |
| `app.error` | anything uncaught, anywhere | `where`, `errorName`, `stackTop`. `errorMessage=[blocked]` is deliberate — a JS message can carry a reading (`"Blood sugar of 412 …"`) or a file she named. |

One failing scan is about fifteen lines. The ring holds 400 notes or 256 KB, newest wins.

### 11.4 What he sees → what is wrong → what fixes it

Read in this order, and it is three lines, not fifteen:

1. the **last `ai.outcome`** — `errorCode` is the diagnosis;
2. the **`ai.http`** above it — `httpStatus`, `apiReason`, `quotaValue`, and Google's own
   sentence in `apiMessage`;
3. for anything about the photograph, the **`prep.page`** line near the top — `defaultCrop`,
   `droppedTopPx`, `outWidth`/`outHeight`.

**Four rows below used to be one row each of somebody else's problem.** A daily 429 read as
a per-minute one, a thinking-eaten budget read as a long prescription, four different 403s
all saying *check the key in Settings*, and a crop that removed the medicines reading as an
unreadable photograph. Each of those had one action attached to it, the action could never
work, and taking it again *felt* like progress. They are four separate rows now, and the
field that separates each pair is named in the first column.

Every row ends in something to do. Where the something is not on the phone, the row says so
in those words rather than leaving a button to press.

| The line that decides it | What is actually wrong | What fixes it |
| --- | --- | --- |
| `ai.outcome errorCode=no_key`, and **no `ai.request` line at all** | No key is stored. Nothing was sent. | Settings → **Prescription scanning (AI)** → *Paste the key here* → **Check this key**. |
| `ai.http httpStatus=403 errorCode=key_restricted apiReason=API_KEY_ANDROID_APP_BLOCKED` (or `…HTTP_REFERRER…` / `…IP_ADDRESS…`) | The key is **correct** and carries an application restriction this app can never satisfy. | §11.5. Re-typing the key never helps. |
| `ai.http httpStatus=403 errorCode=api_not_enabled apiReason=SERVICE_DISABLED` (or `API_KEY_SERVICE_BLOCKED`) | The key is correct; the API is not switched on for its project, or the key's own API restriction excludes it. | Enable *Generative Language API* on that project, wait a few minutes, scan again. |
| `ai.http httpStatus=401`, or a 403 with `errorCode=invalid_key` | The key is genuinely wrong, revoked or deleted — Google named no reason we recognise. Read `apiReason` if there is one: an unmapped value is worth reporting. | Replace it in Settings. |
| `ai.http httpStatus=400 errorCode=invalid_key` | What is saved is not a key at all — half a paste, or a stray character. | Paste it again, whole. |
| `ai.http httpStatus=400 errorCode=bad_request` | A request Google would not accept. **This one is the app's fault**, not the photograph's. | Nothing on the phone. Report it with these lines. |
| `ai.http httpStatus=404 errorCode=model_not_found` + the `modelId` on the `ai.request` line above | That model does not exist for that key. | **Nothing on the phone.** The sentence says "pick a different one in Settings"; there is no model picker — see §11.6, item 1. It needs an app update. |
| `ai.http httpStatus=429 errorCode=quota_exhausted quotaId=…PerDay… quotaValue=`*(non-zero)* | The **daily** free allowance is gone, and it does come back. | Tomorrow, or type the medicines in. |
| `ai.http httpStatus=429 errorCode=quota_zero quotaValue=0` | The project has **no allowance at all** for this model. Waiting cannot help — there is nothing to wait for. Usually a project that has never had the API enabled, or one that needs billing details. | Google Cloud Console: enable *Generative Language API* on that project, and add billing if it asks. Tomorrow is the same day. |
| `ai.http httpStatus=429 errorCode=rate_limited` + two or three `ai.attempt` lines + `ai.wait advised=true` | The **per-minute** limit. The app already waited and asked again. | Wait a minute. Nothing to fix. |
| `ai.http httpStatus=503 errorCode=service_overloaded` three times, `ai.wait advised=false` between them | The model was busy. The app asked three times over about fifteen seconds. | Nothing. Try again in a few minutes. |
| `ai.http errorCode=timeout timeoutMs=300000` — **no `httpStatus` on the line** | Nothing came back within five minutes, three times over. A slow connection, not a refusal. | Wi-Fi, or better signal. The photo is saved. |
| `ai.http errorCode=offline errorName=TypeError` | The request never left the phone. | Mobile data or Wi-Fi on; airplane mode off. |
| `ai.outcome errorCode=thinking_budget_exhausted`, with `ai.response finishReason=MAX_TOKENS outputTokens=0 thoughtTokens=`*(thousands)* | **The budget went on thinking. The prescription is not too long.** | Nothing on the phone. The app's own fix — see §3, item 4. **Do not photograph fewer lines**; it fails identically. |
| `ai.outcome errorCode=truncated`, with `ai.response finishReason=MAX_TOKENS` and `outputTokens` / `textChars` both large | Genuinely too long — the answer was cut mid-list. | Photograph fewer lines per picture. |
| `ai.parse empty=true` (and `topKeys=` blank) | The model answered `{}`. It looked and returned nothing at all. | Retake: sharper, better light, medicine block fully in frame. |
| `ai.parse arrayCounts="medicines=0"`, `ai.outcome ok=true`, and **`prep.page defaultCrop=true`** | Nobody ever looked at the rectangle. The app's own default band removed the top `droppedTopPx` rows — on a continuation sheet, or a photo framed tightly on the list, that is where the first medicines are. **Retaking the photograph fails identically, every time.** | **Read it again, and drag the rectangle up.** Prescription → **Read this with AI** → in *What gets sent?* choose **Send the whole page** (or drag the shaded band off the medicines), then **Read it now**. |
| `ai.parse arrayCounts="medicines=0"`, `ai.outcome ok=true`, and **`prep.page defaultCrop=false`** | She chose the rectangle herself and the model still read nothing on it. This one really is the photograph. | Retake it: sharper, more light, no shadow across the page, medicine block square in the frame. |
| `prep.page smallOutput=true` (with `outWidth` / `outHeight` under 1000) | What was sent is barely more than one 768 px Gemini tile of a whole page — about ten pixels per line of handwriting. It will read nothing, and every other field on the line looks healthy. | Retake at the camera's normal resolution, or photograph half the page at a time. The app does not refuse a small photo, so nothing else will mention this. |
| second `ai.parse` with `countMismatch=true` | The model counted more medicine lines than it transcribed. | Nothing broke; the review screen warns. Compare against the paper. |
| `prep.page ok=false errorCode=image_unreadable` | The photo could not be opened, decoded or written back. The reason travels on the failure with the **file path removed** — `Could not load the image: [file omitted .jpeg]` is the whole of it, deliberately (see §11.6a). | Take it again. If it repeats on every photo, report it with this line. |
| `prep.page ok=false errorCode=crop_required` + `cropOriginY` / `cropHeight` on the same line | A screen sent a rectangle that cannot cut anything — zero height, or off the page. The numbers on the line are what it actually sent. | Nothing on the phone. This is the app's bug; report it with the `cropOriginY` and `cropHeight` values. |
| `prep.page ok=false errorCode=budget_exceeded` | Later pages were **silently not sent**. Medicines on them cannot appear. | Scan the remaining pages as a second prescription. |
| `ai.cancelled` then `ai.outcome errorCode=cancelled` | She left the screen, or pressed **Stop Reading**. | Nothing. The photo is saved. |
| `app.error` with `errorName` / `stackTop` | Something uncaught, unrelated to the network. | Copy those two fields into the report. |
| **No lines at all** | The switch was off when the scan ran — nothing is kept retrospectively. (A restart is *not* an explanation: notes are read back from disk on the next launch while the switch stays on. Turning the switch **off** does delete them, and so may Android when it reclaims cache space.) | Turn it on, then reproduce. |

### 11.5 The trap: a key restricted to Android apps

This was the failure most likely to cost an evening, because the app's own sentence pointed
the wrong way and the wrong action *feels* like progress.

**What she used to see:** "The Google AI key saved on this phone was not accepted. Check it
in Settings, or type the medicines in yourself." That is the `invalid_key` sentence, and
this fault is not `invalid_key`.

**What that invited:** deleting the key and typing it again. Then again, from a fresh copy.
Then generating a new one — which, if it is created with the same restriction, fails the
same way. None of this can ever work.

**What she sees now:** the `key_restricted` sentence — "The Google AI key on this phone is
locked to one particular app or website, so Aarogya cannot use it — typing it in again will
not change that." The key check in Settings says the same thing in its own words ("This key
cannot be used as it is") rather than offering the *copy the whole line again* advice that
belongs to a key with wrong characters. The section below is still worth reading, because
the remedy is in a browser on another device.

**What is actually happening.** An API key in Google Cloud can carry an *application
restriction*: "only Android apps with this package name and this signing certificate may
use this key". Google enforces it by reading the `X-Android-Package` and
`X-Android-Cert` headers, which are set by Google's own Android SDKs. Aarogya does not use
one — `gemini.ts` is a plain `fetch` with a single `x-goog-api-key` header — so those
headers are absent, the restriction can never be satisfied, and Google answers 403 with
*"Requests from this Android client application &lt;empty&gt; are blocked."* The characters
of the key are perfect. The key simply may not be used this way.

**How to be sure, in two lines of the log**, which have to be read together:

```
ai.request … keyPresent=true keyLength=39 keyShape=AIza
ai.http httpStatus=403 errorCode=key_restricted apiStatus=PERMISSION_DENIED
        apiReason=API_KEY_ANDROID_APP_BLOCKED
        apiMessage="Requests from this Android client application <empty> are blocked."
```

The first line says a key of the documented Google shape and the documented Google length
was sent — so "the key is mistyped" is already ruled out before the answer is read. (The
key itself is never in the log; `keyLength` and `keyShape` are all that is ever said about
it, deliberately — see `fingerprintSecret` in `devlog/redact.ts`.) The second line is
Google saying the refusal is about *where the key was used from*, not about the key.

**The fix**, in Google Cloud Console: *APIs & Services → Credentials →* the key *→
Application restrictions →* **None**. Or make a new key and leave application restrictions
unset. Then **Check this key** in Settings: it makes one real call and the log shows
`modelId=gemini-3.5-flash-lite` with no 403.

**Say the trade-off out loud**: a key with no application restriction is usable by anyone
who obtains it. It lives in `expo-secure-store` (the Android keystore), is never logged and
never put in a URL — but it is on a phone. Keep an *API restriction* on it (Generative
Language API only), set a budget alert, and do not reuse it anywhere else.

The same shape of confusion covers `API_KEY_HTTP_REFERRER_BLOCKED` (a key restricted to a
website), `API_KEY_IOS_APP_BLOCKED` and `API_KEY_IP_ADDRESS_BLOCKED`. All four are 403 /
`PERMISSION_DENIED`, all four are `key_restricted` with the same remedy, and `apiReason`
on the `ai.http` line says which one it was — a short enum that survives rewording,
translation and the log's 300-character cap, none of which `apiMessage` does.

### 11.6 What the log cannot tell him yet

Written down rather than discovered again. Each of these is pinned by a test in
`src/features/ai/diagnosis.test.ts`, and each of those tests names the assertion that must
replace it when the defect is fixed — so this section cannot go stale behind a green suite.

**Four entries have been removed from this list because they were fixed.** Three of them
were one shape rather than three bugs: a daily 429 read as a per-minute one, a thinking-eaten
budget read as a long prescription, and four flavours of 403 wearing one code — every one
decided on English prose while the answer sat in a structured field beside it, unread and
unlogged. `details[].reason`, `details[].violations[].quotaId` and `quotaValue` are now
parsed and logged, and the token counts now reach `finishReasonError()`.

The fourth was the opposite shape and is the one to watch for next: **the fact was never
written down at all.** A bad crop and an unreadable photograph both ended at `medicines=0`
because the rectangle that was sent appeared nowhere — no field to misread, no prose to
argue with, nothing. `prep.page` now carries the geometry (§11.3), and `defaultCrop` is the
single field that splits the two opposite actions.

If a fifth turns up, look for one of those two shapes first.

1. **`model_not_found` names a control that does not exist.** Its sentence is "The
   prescription reader chosen in Settings is not available for your key. Pick a different
   one in Settings." There is no model picker: `setAiModel()` and `setThinkingLevel()` in
   `ai/settings.ts` have **no caller anywhere in `src/app/`**, and the AI settings screen
   handles only the key. The model is `DEFAULT_MODEL_ID`, fixed in the build — so when
   Google retires it, every scan on every installed phone 404s, the app tells its user to
   change a setting she cannot reach, and the only remedy is a new APK. This one is not
   about the log: the log reports it perfectly (`httpStatus=404` beside the `modelId` that
   was asked for). It is the *advice* that is unactionable.
2. **The control that fixes a bad crop is named after the protection it drops.** The log now
   says `defaultCrop=true` and the table above says "drag the rectangle" — but the choice in
   the *What gets sent?* dialog reads **Send the whole page**, next to a default that reads
   *Send only the medicines part*. Someone careful enough to have chosen the safe default is
   being asked to pick the one that sounds like giving up on privacy, in order to fix a
   problem that is not about privacy at all: her medicines start higher up this page. The
   remedy is the same rectangle under a different name, and it is copy in
   `src/app/prescription/[id].tsx`, not a change to `HEADER_BAND_FRACTION` — which stays at
   0.22, because a band that is too generous sends the patient block to a human-reviewable
   free tier once, with no undo, and a band that is too aggressive costs one drag.
3. **A key that authenticates and cannot scan still reports "this key works" in one place.**
   `testKey()` treats `thinking_budget_exhausted` as proof the key is good, which it is —
   the request was authorised. Nothing in that path is asserted by a test: `keyStore.ts` has
   no suite of its own, and `CODES_THAT_PROVE_THE_KEY_WORKS` is a list whose every entry is
   an argument written in a comment. It is correct today by reading, not by gate.
4. **The log never names the Google project.** Every remedy in the 403 and `quota_zero` rows
   is "open Cloud Console and change something on *that* project" — and Google puts the
   project number in the one place the scrubber removes it from. `apiMessage` arrives as
   *"…has not been used in project 123456789012 before…"* and prints as *"…in project
   [digits omitted] before…"*, because `DIGIT_RUN` cannot tell a project number from a phone
   number or an Aadhaar, and pulling its floor down far enough to keep one would take the
   429, the 403 and the *"limit: 0"* with it. **This is working as intended and is written
   here so nobody hunts for it.** In practice it costs nothing: whoever set the key up is the
   person who created the project, and Cloud Console lists it. It would matter for somebody
   holding several.

### 11.6a Why a failure reason never carries a file path

`AiError.detail` is stored verbatim in `prescription.extraction_error`, and **that column
syncs**. `sync/redact.ts::stripLocalPaths()` drops every `*_uri` COLUMN before a row is
sealed, which is the right rule and does nothing here: the path is not in a column named
after a path, it is in the middle of a sentence in a column that has to travel. Its own
header says a path inside column text is a producer-side bug, and `ai/imagePrep.ts` is the
producer — so `describe()` there washes every foreign message through
`devlog/redact.ts::scrubText`, the same patterns the developer log uses, rather than a
second copy of them that could be widened in one place and not the other.

It matters because expo-image-manipulator's messages carry the URI *by construction*:
`ImageManipulatorExceptions.kt` builds `"Could not load the image: $image"` from
`url.toString()`, and expo-modules-core wraps it again. What reaches the column is

```
image_unreadable: Call to function 'ExpoImageManipulator.manipulate' has been rejected.
→ Caused by: Could not load the image: [file omitted .jpeg] → Caused by:
java.io.FileNotFoundException: open failed: ENOENT (No such file or directory)
```

— the diagnosis intact, the file name and the directory gone, the extension kept because
the KIND of file is diagnostic and the name is hers, and the newlines collapsed because that
string is read in a table cell. This runs **unconditionally**, not behind the developer
switch: it is protecting a synced database column, not a log line.

### 11.7 Deleting the notes

Two different intentions, two different buttons:

- **Clear the notes, keep recording** — App Logs → **Delete Logs** → the dialog *"Delete all the notes?"* names the count and size, then **Delete Logs**. Recording stays on, so a fresh reproduction starts from an empty screen. The count is the **total**, and when a filter is hiding rows the dialog says so.
- **Stop recording, and delete everything** — Settings → **Keep technical notes**, switch off → *"Stop keeping notes?"* → **Turn Off And Delete**. The notes go from memory and from disk in the same tick, the file and its directory are removed, and the *Developer Options* row disappears.

Either way, nothing else on the phone is touched. The notes live in the cache directory,
never in the health record and never in a backup capsule, and Android may clear them on its
own when it needs the room — which for a debug log is a feature, and is why the reproduction
and the reading of it should happen in one sitting.
