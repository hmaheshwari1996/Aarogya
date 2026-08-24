package `in`.aarogya.medalarm

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings

/**
 * The thing that makes a dose reminder ring like an alarm instead of chiming once.
 *
 * ── WHY THIS FILE HAS TO EXIST AT ALL ─────────────────────────────────────────
 * A notification channel plays its sound EXACTLY ONCE. That is Android's model, not a
 * setting we forgot: `NotificationManagerService.playSound()` plays the channel tone one
 * time per alert and there is no "keep going until answered" flag anywhere in the API.
 * So a channel alone can never produce alarm behaviour, no matter how it is configured —
 * an app that wants a phone to keep ringing has to own an audio player itself.
 *
 * Reported from a real Xiaomi on Android 14: "notifications are coming like push
 * notifications only and sounding only once. It should come like alarms and keep on
 * ringing until taken or snoozed."
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── THE AUDIO ROUTING IS LOAD-BEARING ─────────────────────────────────────────
 * USAGE_ALARM + CONTENT_TYPE_SONIFICATION, and nothing else. USAGE_ALARM maps through
 * `AudioAttributes.toLegacyStreamType()` to STREAM_ALARM, which ringer-silent never
 * zeroes and which `ZenModeFiltering.isAlarm()` exempts from ordinary Do Not Disturb.
 * That is the whole mechanism by which a dose sounds on a silenced phone.
 *
 * Deliberately NOT set here, both of which look like the right answer and are not:
 *
 *   setLegacyStreamType(...)     pins the modern attributes to a legacy stream and
 *                               overrides the usage-based routing above.
 *   FLAG_AUDIBILITY_ENFORCED    reroutes to STREAM_SYSTEM_ENFORCED, which follows RING
 *                               volume — silently reintroducing the exact bug this
 *                               design exists to avoid.
 *
 * The same trap, with the same explanation, is written at the top of
 * src/constants/channels.js. Read it before changing anything in this block.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── THREADING ─────────────────────────────────────────────────────────────────
 * MediaPlayer is not thread-safe and must not be driven from the main thread (prepare()
 * reads a file; release() blocks on the media server). Every public method here posts to
 * ONE private HandlerThread, so all mutable state below is single-threaded by
 * construction and needs no locks — and no caller, receiver or Activity, ever blocks.
 * It is a separate thread from [Bg], on purpose: starting the sound must not queue behind
 * an fsync of the journal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object AlarmPlayer {

  /**
   * Raw resource name, resolved at runtime rather than as `R.raw.dose_alarm_loop`.
   *
   * The file is copied into the app's `res/raw/` at prebuild by
   * plugins/withAlarmReceivers.js. A compile-time reference would fail the build if that
   * copy had not happened yet; a runtime lookup falls back to the system alarm tone and
   * the phone still rings. Unlike a channel sound — which is frozen forever the first
   * time the channel is created — the player picks its tone up fresh on every alarm, so
   * a wrong tone here is fixable by an update and is not worth failing a build over.
   */
  private const val LOOP_RES_NAME = "dose_alarm_loop"

  /**
   * ── THE HARD TIME LIMIT. THIS IS NOT OPTIONAL. ──────────────────────────────
   * "Until taken or snoozed" has to mean "until answered OR until it is clear that
   * nobody is answering", for three separate reasons:
   *
   *  1. If she is out without her phone, or asleep and unwell, an alarm ringing
   *     indefinitely flattens the battery — and a dead phone misses every REMAINING
   *     dose today, which is a strictly worse outcome than one unanswered reminder.
   *  2. On a phone left at home it is simply noise in an empty house, for hours.
   *  3. A bug anywhere in the stop path cannot produce a device that rings forever.
   *     Every other stop is a call somebody has to remember to make; this one is the
   *     absence of a call, and absence is the failure mode we are protecting against.
   *
   * The notification stays after the sound stops, and the escalation chain (e1/e2)
   * carries on untouched — so a dose that nobody answered is still chased, quietly,
   * and then loudly again fifteen minutes later.
   * ────────────────────────────────────────────────────────────────────────────
   */
  private const val RING_TIMEOUT_MS = 120_000L

  /**
   * An absolute ceiling on ONE continuous ring, however many doses pile onto it.
   *
   * Each new occurrence that joins while the phone is already ringing extends the
   * deadline (see [armDeadline]) — otherwise a medicine due at 08:01:30 would be cut off
   * after thirty seconds by a timer armed for the 08:00 one. Extending without a ceiling
   * would let a long enough queue of staggered doses chain the ring indefinitely, which
   * is precisely what [RING_TIMEOUT_MS] exists to prevent. Five minutes bounds it.
   */
  private const val RING_CEILING_MS = 300_000L

  /**
   * `[wait, on, off]` in ms, repeated from index 0 — i.e. 900 on, 700 off, forever, until
   * something cancels it. Long pulses rather than a buzz: this is meant to be noticed
   * from another room through a bedsheet, not to feel like a phone call.
   */
  private val VIBRATION_PATTERN = longArrayOf(0L, 900L, 700L)
  private const val VIBRATION_REPEAT_FROM_INDEX = 0

  /** Started lazily so a process that never fires an alarm never pays for the thread. */
  private val handler: Handler by lazy {
    val thread = HandlerThread("medalarm-alarm")
    thread.start()
    Handler(thread.looper)
  }

  // ── state: touched ONLY on the handler thread ────────────────────────────────

  private var player: MediaPlayer? = null
  private var vibrator: Vibrator? = null

  /**
   * ── SINGLE INSTANCE BY REFERENCE COUNT, NOT BY REPLACEMENT. ─────────────────
   * Two medicines due at 08:00 are two independent alarms sharing one speaker. Replacing
   * the player on the second `start()` would restart the tone mid-note for no reason;
   * worse, it would give one shared "is anything ringing" bit, so tapping Taken on the
   * first medicine would silence the phone while the second is still unanswered.
   *
   * So the player is started when this set goes empty → non-empty and stopped when it
   * goes non-empty → empty. It is a SET keyed by occurrence id, which also makes
   * `start()` idempotent for free: an escalation re-firing the same occurrence while it
   * is already ringing adds nothing and restarts nothing.
   *
   * The failure mode of a reference count is a leaked entry that keeps the phone ringing.
   * That is exactly what [RING_TIMEOUT_MS] backstops: this set can never hold the speaker
   * for longer than the deadline, no matter how badly a caller misbehaves.
   * ────────────────────────────────────────────────────────────────────────────
   */
  private val ringingFor = LinkedHashSet<String>()

  /** elapsedRealtime, not wall clock: TIME_SET/timezone changes must not move a deadline. */
  private var ringingSinceElapsed = 0L
  private var deadlineElapsed = 0L

  private val timeoutRunnable = Runnable { silence("timeout") }

  // ── public surface ───────────────────────────────────────────────────────────

  /**
   * Begin (or join) the ring for [spec].
   *
   * Returns immediately; the audio starts on the handler thread a few milliseconds later.
   * Callers must have already decided that this dose rings ([AlarmSpec.ringsAsAlarm]) AND
   * that the person has a visible way to answer it ([Notifications.canShowDose]) — see
   * DoseAlarmReceiver, which is the only place that should be calling this.
   */
  fun start(ctx: Context, spec: AlarmSpec) {
    val app = ctx.applicationContext
    val occId = spec.occId
    handler.post {
      try {
        beginOrJoin(app, occId)
      } catch (t: Throwable) {
        // A phone that cannot ring is bad. A phone that ringing left in an unknown state
        // is worse, so any failure collapses all the way back to silent — which also
        // clears the reference set, so the next alarm gets a clean attempt.
        logw("alarm start failed for $occId", t)
        silence("start_failed")
      }
    }
  }

  /**
   * One occurrence has been answered. THE single stop entry point.
   *
   * Every path that means "answered" routes here — Taken, Snooze, the notification being
   * swiped away, the full-screen activity being finished — rather than each remembering
   * to stop the sound itself, because several call sites each remembering is how one of
   * them ends up not remembering.
   *
   * Idempotent and safe for an id that was never ringing. The speaker only goes quiet
   * when the LAST ringing occurrence has been answered.
   */
  fun stop(occId: String) {
    handler.post {
      try {
        if (ringingFor.remove(occId) && ringingFor.isEmpty()) silence("answered")
      } catch (t: Throwable) {
        logw("alarm stop failed for $occId", t)
        silence("stop_failed")
      }
    }
  }

  /** Everything quiet, whatever is ringing. Profile switch, logout, "stop it now" from JS. */
  fun stopAll() {
    handler.post {
      try {
        silence("stop_all")
      } catch (t: Throwable) {
        logw("alarm stopAll failed", t)
      }
    }
  }

  // ── handler thread only, below this line ─────────────────────────────────────

  private fun beginOrJoin(app: Context, occId: String) {
    val now = SystemClock.elapsedRealtime()
    val wasSilent = ringingFor.isEmpty()
    ringingFor.add(occId)

    if (wasSilent) {
      ringingSinceElapsed = now
      deadlineElapsed = 0L
      beginAudio(app)
      beginVibration(app)
      logd("alarm ringing for $occId")
    } else {
      logd("alarm joined by $occId (${ringingFor.size} ringing)")
    }
    armDeadline(now)
  }

  /**
   * Extends the stop-by time to `now + RING_TIMEOUT_MS`, clamped by the continuous-ring
   * ceiling, and never shortened — a second dose joining must not cut the first one's
   * remaining time.
   */
  private fun armDeadline(now: Long) {
    val ceiling = ringingSinceElapsed + RING_CEILING_MS
    val wanted = minOf(now + RING_TIMEOUT_MS, ceiling)
    val next = maxOf(deadlineElapsed, wanted)
    if (next == deadlineElapsed) return

    deadlineElapsed = next
    handler.removeCallbacks(timeoutRunnable)
    handler.postDelayed(timeoutRunnable, maxOf(0L, next - now))
  }

  private fun beginAudio(app: Context) {
    // Try the app's own loop first, then the system alarm tone. Wrong tone beats silence,
    // and a tone that will not prepare (a truncated copy, a codec the ROM dropped) is
    // otherwise indistinguishable from an alarm that never fired.
    val preferred = loopUri(app)
    if (openAndStart(app, preferred)) return

    val fallback = systemAlarmUri()
    // loopUri() already degrades to the system tone when the raw resource is absent, so
    // this guards against reporting a "fallback" that is the thing that just failed.
    if (preferred == fallback) return
    logw("dose loop would not play; falling back to the system alarm tone")
    openAndStart(app, fallback)
  }

  private fun openAndStart(app: Context, uri: Uri): Boolean {
    releasePlayer()
    val mp = MediaPlayer()
    return try {
      mp.setAudioAttributes(alarmAudioAttributes())
      mp.setDataSource(app, uri)
      // The tone is 2.0 s with a verified zero-crossing seam, so looping it is one
      // continuous sound with no click at the join. Do NOT point this at dose_critical /
      // dose_standard: those fade to silence at the end and would pulse.
      mp.isLooping = true
      // The broadcast's own wake lock is a 30 s ceiling and the ring outlasts it. This
      // ties a PARTIAL_WAKE_LOCK to playback itself — acquired by MediaPlayer on start,
      // released by it on stop/release — so a Doze-idle phone cannot suspend the CPU
      // halfway through the alarm, and no hand-managed lock can be leaked.
      mp.setWakeMode(app, PowerManager.PARTIAL_WAKE_LOCK)
      mp.setOnErrorListener { _, what, extra ->
        logw("alarm MediaPlayer error what=$what extra=$extra")
        // Posted rather than called inline: this arrives on the handler thread from
        // inside MediaPlayer, and releasing a player from its own callback is undefined.
        handler.post { silence("player_error") }
        true
      }
      mp.prepare()
      mp.start()
      player = mp
      true
    } catch (t: Throwable) {
      logw("could not start alarm audio from $uri", t)
      try {
        mp.release()
      } catch (ignored: Throwable) {
        logw("release after failed open failed", ignored)
      }
      player = null
      false
    }
  }

  private fun beginVibration(app: Context) {
    try {
      val v = vibratorOf(app) ?: return
      if (!v.hasVibrator()) return
      val effect = VibrationEffect.createWaveform(VIBRATION_PATTERN, VIBRATION_REPEAT_FROM_INDEX)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        // Same USAGE_ALARM classification as the audio: this is what keeps the buzz alive
        // under Do Not Disturb, which suppresses notification-usage vibration.
        v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
      } else {
        @Suppress("DEPRECATION")
        v.vibrate(effect, alarmAudioAttributes())
      }
      vibrator = v
    } catch (t: Throwable) {
      // A phone that will not vibrate must still ring. Never fatal to the alarm.
      logw("alarm vibration unavailable", t)
    }
  }

  /**
   * Stops everything and forgets everything. The ONLY place resources are torn down, so
   * there is exactly one code path that has to be right about releasing them.
   */
  private fun silence(reason: String) {
    handler.removeCallbacks(timeoutRunnable)
    deadlineElapsed = 0L
    ringingSinceElapsed = 0L
    ringingFor.clear()
    releasePlayer()
    releaseVibrator()
    logd("alarm silenced ($reason)")
  }

  /**
   * A leaked MediaPlayer holding the alarm stream is a phone that will not go quiet, so
   * the field is cleared FIRST: even if a call below throws, no later start can find and
   * reuse a half-dead player, and the local reference still gets released.
   */
  private fun releasePlayer() {
    val mp = player ?: return
    player = null
    try {
      mp.setOnErrorListener(null)
    } catch (t: Throwable) {
      logw("clearing MediaPlayer error listener failed", t)
    }
    try {
      if (mp.isPlaying) mp.stop()
    } catch (t: Throwable) {
      logw("MediaPlayer.stop failed", t)
    }
    try {
      mp.release()
    } catch (t: Throwable) {
      logw("MediaPlayer.release failed", t)
    }
  }

  private fun releaseVibrator() {
    val v = vibrator ?: return
    vibrator = null
    try {
      v.cancel()
    } catch (t: Throwable) {
      logw("Vibrator.cancel failed", t)
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────────

  private fun alarmAudioAttributes(): AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  private fun loopUri(app: Context): Uri {
    val id = try {
      app.resources.getIdentifier(LOOP_RES_NAME, "raw", app.packageName)
    } catch (t: Throwable) {
      logw("raw resource lookup failed", t)
      0
    }
    if (id == 0) {
      logw("raw/$LOOP_RES_NAME is missing from this build")
      return systemAlarmUri()
    }
    return Uri.parse("android.resource://${app.packageName}/$id")
  }

  /** Non-null by construction: the settings constant is a compile-time fallback. */
  private fun systemAlarmUri(): Uri = try {
    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: Settings.System.DEFAULT_ALARM_ALERT_URI
  } catch (t: Throwable) {
    logw("default alarm ringtone unavailable", t)
    Settings.System.DEFAULT_ALARM_ALERT_URI
  }

  private fun vibratorOf(app: Context): Vibrator? = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
  } catch (t: Throwable) {
    logw("vibrator unavailable", t)
    null
  }
}
