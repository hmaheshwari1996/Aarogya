# How Aarogya's reminders actually work

Written for someone who does not write Android code. If you only read one section, read
[What we cannot promise](#what-we-cannot-promise).

The short version: on Android, an app that wants to reliably interrupt you at 08:00 has
to fight the operating system for it. Every version since 2016 has added another layer of
battery saving that stops background apps from waking up, and every Indian phone
manufacturer has added a second, undocumented layer on top of that. This document
explains which of those we beat, how, and which we cannot.

---

## The one design decision everything else follows from

Aarogya's native alarm layer never opens the database.

The app's medicine history lives in SQLite. When a reminder fires at 06:00 the app is not
running — Android starts a tiny piece of our code, shows the notification, and stops
again. If that piece of code also wrote to the database, we would have two independent
processes writing the only copy of a person's health history, and the day they overlapped
the file would be corrupt. There is no undo for that.

So the two halves talk through files instead:

| File | Written by | Read by | Contains |
|---|---|---|---|
| `medalarm/horizon.json` | the app (JS) | the alarm layer (Kotlin) | the reminder **rules** |
| `medalarm/journal/*.json` | the alarm layer | the app | one file per event: taken, snoozed, dismissed |

Two details in that table are load-bearing.

**The horizon holds rules, not dates.** It says "Metformin, 08:00, every day, since 3
March" — not a list of the next seven alarm times. An earlier design stored pre-computed
dates and had the app refresh them. But the app only runs when someone opens it, and this
product is explicitly built so that you can tap "Taken" on the notification and never open
the app at all. On day eight the list would have been empty, every reminder would have
stopped, and nothing anywhere would have said so. The alarm layer now does the calendar
arithmetic itself, forward, indefinitely. It cannot run out.

**The journal is one file per event, never one growing log.** A single shared log file
means a shared write position, and a shared write position between two processes is a
race: the app trimming the log while the alarm layer appends to it either corrupts the end
of the file or loses the last record. That last record is a "taken", and a lost "taken"
prints as a missed dose on a report a doctor reads. Separate files have nothing to race
over — the alarm layer creates, the app reads and deletes, and a crash at any moment
leaves every other record untouched.

---

## What `setAlarmClock` buys us

Android has several ways to schedule work for later. They are not equally reliable, and
the differences only show up on a real phone after a few weeks.

- **A normal alarm** is deferred while the phone is in Doze (idle, screen off, in a
  pocket overnight). It can be hours late. Useless for medicine.
- **`setExactAndAllowWhileIdle`** escapes Doze, but it is still charged against the app's
  *standby bucket* quota. Android sorts apps into buckets by how often you open them. An
  app you only ever tap a notification from — exactly this app, for exactly its target
  user — sinks to the `RESTRICTED` bucket, where the quota is **one alarm per day**. A
  four-dose regimen would deliver breakfast and silently drop the other three, every day,
  forever.
- **`setAlarmClock`** is the API the Clock app uses. It is the only one exempt from *both*
  Doze deferral *and* standby-bucket quotas. Android treats it as a user-visible alarm
  that has been promised to a human.

Every dose reminder in Aarogya uses `setAlarmClock`. So does every escalation — the
follow-up ping fifteen minutes later when nothing was recorded. Escalations are the part
most likely to be got wrong: routing them through the "cheaper" `setAndAllowWhileIdle`
would put them under Doze's throttle of roughly one wake-up per nine minutes, which is the
same interval an escalation chain runs at, so the chain would collapse into a single ping
precisely when it matters most.

### Why you see an alarm clock icon in the status bar

Because we are using the alarm-clock API honestly, Android does what it does for any
alarm: it shows the alarm icon in the status bar and lists the next dose in the clock
app's "next alarm" slot.

This is a deliberate trade and it is not a bug. The alternative is an API that is quieter
in the status bar and unreliable in a pocket. We chose the reliable one. If the icon is
ever a privacy problem for a particular user — the next-alarm text can name the medicine —
the fix is to shorten the reminder title, not to change the API.

---

## Why a dose reminder rings

A reminder that chimes once, from a phone face-down on a table in another room, has not
reminded anybody. Dose reminders in Aarogya therefore behave like an alarm clock: they
keep ringing until they are answered.

That is not something a notification can be configured to do. **An Android notification
channel plays its sound exactly once** — one alert, one tone, and there is no "keep going"
flag anywhere in the API. Getting alarm behaviour means the app has to own an audio player
and run it itself, which is what `AlarmPlayer.kt` in the native alarm layer is.

When a dose alarm fires:

- a **2-second tone loops** continuously (`assets/sounds/dose_alarm_loop.wav`, written to
  end exactly where it begins so the loop has no click at the join),
- the phone **vibrates in a repeating pattern** alongside it,
- and on `critical` and `standard` doses the **full-screen alarm screen** appears over the
  lock screen, with the medicine name and two big buttons.

The audio is tagged `USAGE_ALARM`, the same classification the Clock app uses. That is what
makes it audible on a phone set to silent and through ordinary Do Not Disturb, and it means
the sound follows the **alarm** volume slider rather than the ringer.

### Which reminders ring, and which do not

| Tier | Behaviour |
|---|---|
| `critical` | Rings. Full-screen alarm screen. |
| `standard` — **the default for every medicine** | Rings. Full-screen alarm screen. |
| `low` — supplements, as-needed | Ordinary quiet notification. No ringing, no full screen. |

**This is a deliberate reversal of how it worked before.** Until now the full-screen alarm
was reserved for `critical` medicines, and nothing looped a sound at all. Since every
medicine defaults to `standard`, that meant the alarm screen had never once been shown on a
real phone, and every reminder chimed a single time. Tested on a Xiaomi on Android 14, the
result was reported exactly as it should have been: *"notifications are coming like push
notifications only and sounding only once."* So `standard` now rings too. `low` still does
not, on purpose — an app that raises an alarm for a vitamin tablet teaches its user to
ignore alarms.

### It stops ringing after about two minutes, even if nobody answers

This limit is not a compromise, it is part of the design.

If she is out without her phone, or asleep and unwell, an alarm ringing indefinitely
flattens the battery — and a dead phone misses *every remaining dose that day*, which is
strictly worse than one unanswered reminder. On a phone left at home it is just noise in an
empty house. And a hard ceiling means that a bug anywhere in the stop path cannot produce a
device that rings forever: every other stop is a call somebody has to remember to make,
while this one is the absence of a call.

So "until taken or snoozed" means, precisely: **until answered, or until it is clear that
nobody is answering.**

When the sound stops, the notification stays, and the escalation chain carries on
untouched — the follow-up ping fifteen minutes later still rings, on its own timer.

(If several doses fall due within the same ring, each one that joins extends the deadline,
so a medicine due ninety seconds after another is not cut off after thirty seconds. A
separate five-minute ceiling caps one continuous ring however many pile onto it.)

### What stops the sound

Everything that means the reminder has been answered, all routed through one function:

- **Taken** or **Snooze**, from the notification or from the full-screen screen
- **Swiping the notification away** — the person is holding the phone and has said stop;
  the dose is still recorded as `dismissed` and the escalation still comes
- **The full-screen alarm screen closing** for any reason, including Home or the power
  button
- **The two-minute cap**
- Profile switch or logout, which cancels every alarm anyway

Two doses ringing at once are counted separately, so answering one does not silence the
other.

### It rings even when the full-screen screen cannot be shown

Android 14 made full-screen intents opt-in and denies them by default for anything that is
not a clock or a calling app; and even when granted, Android shows a heads-up notification
instead whenever the phone is unlocked and in use.

The sound is therefore started by the code that receives the alarm, **before** the
notification is posted and regardless of whether the alarm screen ever appears. Wiring it
the other way round — starting the sound from the alarm screen — would make the alarm
silent in exactly the case where the phone is already in the user's hand.

The one thing it does check first is whether the notification will actually be *visible*
(app notifications enabled, this channel not muted). A phone ringing for two minutes with
no notification is a phone with no Taken button, no Snooze button and no explanation.

### Two implementation notes worth keeping

**No foreground service.** `setAlarmClock` grants a short allowlist window in which one
could be started, and it was considered. It was not used, for two reasons. There is no
`foregroundServiceType` that honestly describes ringing an alarm — the closest,
`mediaPlayback`, would be a misdescription that Android 14's type enforcement can reject at
runtime — and a foreground service also requires its own second notification sitting next
to the dose one. Instead the ring is bounded at two minutes and the player holds a partial
wake lock tied to playback itself (`MediaPlayer.setWakeMode`), which is enough to keep a
Doze-idle CPU awake for that long and cannot be leaked, because the player releases it.

**If the process is killed mid-ring, the sound stops.** The player lives in the app
process, so a force-stop or a low-memory kill silences it immediately. That is the safe
direction to fail: a phone that goes quiet, not a phone that rings forever with no app left
to stop it. The notification survives (it belongs to the system, not to us), and so do the
armed alarms — unless the kill was a *force-stop*, which cancels every alarm the app has, as
described below.

---

## The OEM problem

Everything above is stock Android behaviour, and on a Pixel it is the whole story. On the
phones people in India actually buy, it is about half of it.

Xiaomi (MIUI/HyperOS), Oppo and Realme (ColorOS), Vivo (Funtouch/OriginOS), Huawei,
Samsung and OnePlus each ship their own battery manager that sits *above* Android's. They
maintain a private list of apps allowed to start themselves in the background —
"Autostart", "Auto-launch", "Startup manager", the name differs — and an app that is not
on that list can have its alarms dropped after a reboot, or be killed outright while
waiting.

Three things follow from this, and they are the three things worth telling a user:

**1. Swiping the app away from Recents is a force-stop.** On stock Android, swiping an app
out of the recents list just removes it from the list. On MIUI and ColorOS it terminates
the app the way the Settings screen's "Force stop" button does — and a force-stopped app
on Android has **every one of its alarms cancelled** and receives no broadcasts, including
`BOOT_COMPLETED`, until a human opens it again. The reminders do not come back on their
own. Not after an hour, not after a reboot. This is the single most common cause of "the
app just stopped reminding me", and it is invisible from inside the app.

**2. There is no API to check autostart, and no permission to request it.** None. Not
hidden, not reflective. The state lives in a database belonging to the manufacturer's own
security app. All any app can do is open that screen for you and explain what to tap,
which is what the "Fix reminders" flow does. If a screen cannot be opened — the component
names are undocumented and change between ROM versions — the app falls back to its own
settings page and says that is what happened, rather than pretending it succeeded.

**3. Battery optimisation is separate from autostart, and both matter.** Exempting Aarogya
from battery optimisation is a standard Android setting we *can* read and *can* ask for.
Autostart is not. A phone can pass one and fail the other.

---

## What the app can and cannot verify

The Reminder Health Check reports only things the platform will actually answer. It never
implies more confidence than that.

**Can check:**

- Notifications are enabled for the app at all.
- Each of the five notification channels individually — a channel the user muted six weeks
  ago is invisible from the app's own settings screen and is a common silent failure.
- Whether exact alarms are permitted (`canScheduleExactAlarms`). On the sideloaded family
  build this is always yes and cannot be revoked. On a Play build the user can turn it off,
  and then reminders degrade to approximate.
- Whether the app is exempt from battery optimisation.
- The **alarm stream volume**. The dose channels use `USAGE_ALARM`, which is why they sound
  through a phone on silent — but nothing survives the alarm volume being set to zero.
- **Do Not Disturb / Total Silence.** Ordinary DND does not block us; Total Silence does.
- The **standby bucket** the app has been sorted into.
- **Free storage.** The journal is the only durable record of a dose taken from a
  notification. On a full disk it cannot be written — so the app tells you, immediately,
  on the App Health channel, rather than quietly recording nothing for three weeks.
- How old the rules file is, and how many alarms are currently armed.

**Cannot check:**

- Whether OEM autostart is enabled. No API exists.
- Whether the manufacturer's battery manager has already killed us.
- Whether the user swiped the app from Recents ten minutes ago.
- Whether a notification was actually *seen*. A swipe-away is recorded as `dismissed`,
  which is how the catch-up card distinguishes "she saw it and swiped it away" from "it
  never arrived at all" — two opposite problems with two opposite fixes.

---

## What we cannot promise

Aarogya is a reminder, not a life-support system. It is engineered to be as close to
unmissable as a normal Android app is allowed to be, and it will still fail if:

- The phone is off, or the battery is dead.
- The user force-stopped the app, or swiped it from Recents on a ROM that treats those as
  the same thing.
- The manufacturer's battery manager killed it and autostart was never enabled.
- The phone is in Total Silence, or the alarm volume is at zero.
- The user muted the notification channel.
- Storage is completely full.

For every one of these the app fails **loudly** where it can: a notice on the App Health
channel, a red row in the Reminder Health Check. What it never does is go quiet and look
fine. Nobody should ever discover from a doctor that the reminders stopped in March.

---

## Verifying delivery yourself (adb)

You need USB debugging on and `adb` on your machine. `in.aarogya.care` is the package name.

### Is the next dose actually scheduled?

```bash
adb shell dumpsys alarm | grep -A 40 in.aarogya.care
```

Look for entries with `type=0` (`RTC_WAKEUP`) whose intents look like
`medalarm://<occurrence>#base`. Each dose has a `base` entry and one per escalation
(`e1`, `e2`). The `when=` field is the fire time.

To see just the alarm-clock registrations — the ones exempt from Doze and quotas:

```bash
adb shell dumpsys alarm | grep -i "alarm clock"
```

### Is it actually ringing, and did it stop?

```bash
adb logcat -s MedAlarm
```

A dose that rings prints `alarm ringing for <occurrence>`, and whatever ends it prints
`alarm silenced (<reason>)`. The reason names the path, which is the fastest way to tell
these apart:

| reason | what happened |
|---|---|
| `answered` | Taken, Snooze, a swipe, or the alarm screen closing |
| `timeout` | nobody answered within the two-minute cap |
| `stop_all` | profile switch, logout, or the app asking for silence |
| `player_error` | MediaPlayer failed mid-ring; the reminder is now silent |
| `start_failed` | the ring never began — look at the exception logged just above |

If a reminder arrives but nothing prints, it was not supposed to ring: either the medicine
is on the `low` tier, or notifications/the channel are switched off, which the alarm layer
treats as "there would be no Taken button, so do not ring".

Alarm stream volume is the other thing to check, and it is not visible in logcat:

```bash
adb shell dumpsys audio | grep -A 3 "STREAM_ALARM"
```

### Does it survive Doze?

```bash
# Unplug USB first — the device will not enter idle while charging.
adb shell dumpsys deviceidle force-idle

# Confirm the state (expect IDLE)
adb shell dumpsys deviceidle get deep

# ... wait for a dose to be due, or fire a test from the app ...

adb shell dumpsys deviceidle unforce
adb shell dumpsys deviceidle disable   # if you want to stop it re-entering idle
```

A `setAlarmClock` alarm fires on time in this state. If it does not, something outside
Android is killing the app — go looking at the manufacturer's battery manager.

### Does it survive the worst standby bucket?

```bash
adb shell am set-standby-bucket in.aarogya.care restricted
adb shell am get-standby-bucket in.aarogya.care   # expect 45
```

Now leave it overnight with several doses scheduled. All of them should arrive. If only
the first one does, an alarm is being scheduled with the wrong API somewhere — that is the
exact symptom the `setAlarmClock` decision above exists to prevent.

Put it back afterwards:

```bash
adb shell am set-standby-bucket in.aarogya.care active
```

### Does it come back after a reboot?

```bash
adb reboot
# wait for the device to settle, then:
adb shell dumpsys alarm | grep -A 40 in.aarogya.care
```

The alarms should be there without anyone opening the app. If they are not, check that
the boot broadcast reached us:

```bash
adb logcat -d | grep MedAlarm
```

You should see a `rearmed` journal record being written with `trigger` set to
`android.intent.action.BOOT_COMPLETED`.

### Force-stop, so you can see the failure mode for yourself

```bash
adb shell am force-stop in.aarogya.care
adb shell dumpsys alarm | grep -c in.aarogya.care   # expect 0
```

Every alarm is gone, and nothing brings them back until a human opens the app. This is
exactly what a Recents swipe does on MIUI and ColorOS, and it is why the onboarding
insists on the autostart step.

### Inspect the files the two halves share

```bash
# Requires a debuggable build.
adb shell run-as in.aarogya.care cat files/medalarm/horizon.json
adb shell run-as in.aarogya.care ls -l files/medalarm/journal/
```

A journal directory that keeps growing means the app side is not draining it. An empty
`horizon.json`, or one whose `writtenAtEpoch` is more than 20 days old, is what triggers
the "Open Aarogya to restore your reminders" notice.
