package `in`.aarogya.medalarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Everything the Reminder Health Check screen can actually verify.
 *
 * The honesty rule for this file: report only what the platform will tell us, and never
 * imply confidence we do not have. There is no API that answers "will my 08:00 alarm
 * ring tomorrow" — this returns the handful of preconditions that, when any one of them
 * is wrong, guarantee it will not.
 */
internal object HealthProbe {

  fun probe(ctx: Context): Map<String, Any> {
    val out = LinkedHashMap<String, Any>()
    val app = ctx.applicationContext

    out["sdkInt"] = Build.VERSION.SDK_INT
    out["manufacturer"] = Build.MANUFACTURER ?: ""
    out["model"] = Build.MODEL ?: ""

    // ── notifications ─────────────────────────────────────────────────────────
    val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    out["notificationsEnabled"] = safeBool(true) { nm.areNotificationsEnabled() }

    // Per-channel importance, because a single muted channel is invisible from the app's
    // own settings screen and is one of the most common "it stopped working" causes.
    // IMPORTANCE_NONE (0) means the user turned this exact channel off.
    val channels = ArrayList<Map<String, Any>>()
    try {
      for (ch in nm.notificationChannels.orEmpty()) {
        channels.add(
          mapOf(
            "id" to (ch.id ?: ""),
            "name" to (ch.name?.toString() ?: ""),
            "importance" to ch.importance,
            "muted" to (ch.importance == NotificationManager.IMPORTANCE_NONE),
            "hasSound" to (ch.sound != null),
            "bypassDnd" to ch.canBypassDnd()
          )
        )
      }
    } catch (t: Throwable) {
      logw("channel enumeration failed", t)
    }
    out["channels"] = channels
    out["canUseFullScreenIntent"] = Notifications.canUseFullScreenIntent(app)

    // ── exact alarms ──────────────────────────────────────────────────────────
    // Personal build: USE_EXACT_ALARM is auto-granted and cannot be revoked, so this is
    // always true. Play build: SCHEDULE_EXACT_ALARM is revocable, and when it goes false
    // the scheduler degrades to inexact alarms — which the user deserves to be told.
    out["canScheduleExactAlarms"] = safeBool(true) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) true
      else (app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()
    }

    // ── battery / Doze ────────────────────────────────────────────────────────
    out["isIgnoringBatteryOptimizations"] = safeBool(false) {
      val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(app.packageName)
    }

    // ── audible-ness ──────────────────────────────────────────────────────────
    // The dose channels use USAGE_ALARM, which routes to STREAM_ALARM and therefore
    // survives ringer-silent. It does NOT survive the alarm stream being turned down to
    // zero, and nothing in the app can raise it without being obnoxious — so we detect
    // it and say so.
    try {
      val am = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val vol = am.getStreamVolume(AudioManager.STREAM_ALARM)
      out["alarmVolume"] = vol
      out["alarmVolumeMax"] = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
      out["alarmVolumeIsZero"] = vol == 0
    } catch (t: Throwable) {
      logw("alarm volume unavailable", t)
      out["alarmVolume"] = -1
      out["alarmVolumeMax"] = -1
      out["alarmVolumeIsZero"] = false
    }

    // ── Do Not Disturb / zen ──────────────────────────────────────────────────
    // INTERRUPTION_FILTER_NONE (3) is "Total Silence", which suppresses alarms too and is
    // the one DND state USAGE_ALARM cannot defeat. Read via the public API first; fall
    // back to the Settings.Global key, which some ROMs keep more accurate.
    val filter = safeInt(0) { nm.currentInterruptionFilter }
    out["interruptionFilter"] = filter
    out["zenMode"] = safeInt(-1) { Settings.Global.getInt(app.contentResolver, "zen_mode", -1) }
    out["isTotalSilence"] =
      filter == NotificationManager.INTERRUPTION_FILTER_NONE || out["zenMode"] == 2

    // ── standby bucket ────────────────────────────────────────────────────────
    // RESTRICTED (45) is where a phone that is only ever used to tap "Taken" ends up, and
    // it is the reason every dose alarm uses setAlarmClock(): that is the one API the
    // bucket quota does not apply to. Reported anyway, because it explains everything
    // else the app does slowly (journal drains, background work).
    val bucket = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      safeInt(-1) {
        (app.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager).appStandbyBucket
      }
    } else -1
    out["standbyBucket"] = bucket
    out["standbyBucketLabel"] = bucketLabel(bucket)

    // ── storage ───────────────────────────────────────────────────────────────
    // The journal is the only durable record of a dose taken from the notification. If
    // the disk is full it cannot be written, so free space is a reminder-reliability
    // number here, not a housekeeping one. Double, not Long, so the JS bridge cannot
    // lose precision on a large value.
    out["freeStorageBytes"] = safeDouble(-1.0) { app.filesDir.usableSpace.toDouble() }

    // ── horizon + armed state ─────────────────────────────────────────────────
    val horizon = HorizonStore.read(app)
    out["horizonAgeDays"] = HorizonStore.ageDays(horizon)
    out["horizonIsStale"] = HorizonStore.isStale(horizon)
    out["horizonRuleCount"] = horizon?.rules?.size ?: 0
    out["horizonDroppedRules"] = horizon?.droppedRules ?: 0
    out["horizonWrittenAtEpoch"] = (horizon?.writtenAtEpoch ?: 0L).toDouble()

    val armed = safeList { Scheduler.armedSpecs(app) }
    out["armedCount"] = armed.size
    out["armedOccurrenceCount"] = armed.map { it.occId }.distinct().size
    out["nextTriggerAtEpoch"] = (armed.minOfOrNull { it.triggerAtMillis } ?: 0L).toDouble()
    out["pendingJournalCount"] = safeInt(0) { Journal.pendingCount(app) }

    return out
  }

  private fun bucketLabel(b: Int): String = when (b) {
    10 -> "active"
    20 -> "working_set"
    30 -> "frequent"
    40 -> "rare"
    45 -> "restricted"
    50 -> "never"
    else -> "unknown"
  }

  private inline fun safeBool(fallback: Boolean, body: () -> Boolean): Boolean = try {
    body()
  } catch (t: Throwable) {
    logw("probe field failed", t); fallback
  }

  private inline fun safeInt(fallback: Int, body: () -> Int): Int = try {
    body()
  } catch (t: Throwable) {
    logw("probe field failed", t); fallback
  }

  private inline fun safeDouble(fallback: Double, body: () -> Double): Double = try {
    body()
  } catch (t: Throwable) {
    logw("probe field failed", t); fallback
  }

  private inline fun safeList(body: () -> List<AlarmSpec>): List<AlarmSpec> = try {
    body()
  } catch (t: Throwable) {
    logw("probe field failed", t); emptyList()
  }
}
