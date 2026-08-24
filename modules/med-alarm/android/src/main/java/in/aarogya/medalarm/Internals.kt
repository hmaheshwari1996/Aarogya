package `in`.aarogya.medalarm

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Shared constants and tiny primitives for the native alarm layer.
 *
 * ── THE ONE RULE OF THIS PACKAGE ──────────────────────────────────────────────
 * Kotlin NEVER opens the SQLite database. Two processes writing the only copy of
 * someone's health history is the worst failure this app has available to it.
 * Everything crossing the JS ↔ Kotlin boundary is a plain file in `filesDir`:
 *
 *   medalarm/horizon.json                      JS writes, Kotlin reads.  Rules, not dates.
 *   medalarm/journal/<occ>-<event>-<ms>.json   Kotlin writes, JS reads and unlinks.
 *   medalarm/armed.json                        Kotlin only. What is currently scheduled.
 *   medalarm/snoozes.json                      Kotlin only. Survives a reconcile sweep.
 *   medalarm/resolved.json                     Kotlin only. Doses already answered.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object Const {
  const val TAG = "MedAlarm"

  const val DIR = "medalarm"
  const val HORIZON_FILE = "horizon.json"
  const val ARMED_FILE = "armed.json"
  const val SNOOZE_FILE = "snoozes.json"
  const val RESOLVED_FILE = "resolved.json"
  const val JOURNAL_DIR = "journal"

  /**
   * How long an answered occurrence is remembered so a reconcile cannot resurrect it.
   *
   * Three days is generous: an occurrence id contains its own date, so once that date has
   * passed the rules can never produce it again. The window only has to outlast a
   * timezone change and a phone whose clock is wrong.
   */
  const val RESOLVED_TTL_MS = 3L * 24 * 60 * 60 * 1000

  /**
   * Broadcast actions. Fully qualified so nothing else on the device can collide,
   * and so a stray implicit broadcast can never reach us (all receivers are
   * exported=false except RescheduleReceiver, which only listens to system actions).
   */
  const val ACTION_FIRE = "in.aarogya.medalarm.FIRE"
  const val ACTION_TAKEN = "in.aarogya.medalarm.TAKEN"
  const val ACTION_SNOOZE = "in.aarogya.medalarm.SNOOZE"
  const val ACTION_DISMISS = "in.aarogya.medalarm.DISMISS"

  /** One JSON blob rather than a dozen typed extras — forward/backward tolerant. */
  const val EXTRA_SPEC = "medalarm.spec"

  /**
   * Every PendingIntent for one occurrence must differ in something
   * `Intent.filterEquals()` actually looks at. It ignores extras entirely, so the
   * variant is encoded into the intent DATA URI. Without this, arming the escalation
   * would silently REPLACE the base alarm instead of adding to it.
   */
  val VARIANTS = listOf("base", "e1", "e2", "s1", "s2", "s3")

  /** Escalation variants, in order. Two, because escalating forever is harassment. */
  val ESCALATION_VARIANTS = listOf("e1", "e2")

  /** Snooze variants, in order. After s3 the chain stops and we record that it stopped. */
  val SNOOZE_VARIANTS = listOf("s1", "s2", "s3")

  const val SNOOZE_MINUTES = 10

  /**
   * Channel id for app-health notices. The ID (and only the id) is duplicated here —
   * Kotlin cannot require() src/constants/channels.js. Channel PROPERTIES are never
   * duplicated: the channels are created once, in MainApplication.onCreate(), by
   * plugins/withNotificationChannels.js from that single source of truth. Android
   * channels are immutable after first creation, so a second creator with slightly
   * different properties would permanently win or permanently lose at random.
   */
  const val SYSTEM_CHANNEL_ID = "system_v1"

  /**
   * The one dose tier that stays a quiet, ordinary notification.
   *
   * `dose_low_v1` is the supplements/as-needed tier. Everything else — `critical` and
   * `standard` — rings like an alarm; see [AlarmSpec.ringsAsAlarm], which deliberately
   * tests for THIS id rather than listing the ids that ring, so an unrecognised channel
   * fails towards ringing. For a medicine reminder that is the correct direction to fail:
   * an unexpected alarm is visible and fixable, a silently downgraded one is neither.
   *
   * Same rule as [SYSTEM_CHANNEL_ID]: the id (and only the id) is duplicated from
   * src/constants/channels.js, because Kotlin cannot require() a JS file. Channel
   * PROPERTIES are never duplicated.
   */
  const val DOSE_LOW_CHANNEL_ID = "dose_low_v1"

  /**
   * Stable notification ids for app-health notices. Stable = a repeated failure
   * replaces the previous notice instead of stacking twenty identical warnings.
   */
  const val NOTIF_ID_HORIZON_STALE = 900_001
  const val NOTIF_ID_JOURNAL_IO = 900_002
  const val NOTIF_ID_EXACT_DEGRADED = 900_003
  const val NOTIF_ID_TEST = 900_004

  /** A horizon older than this means JS has not run in a long time. Fail loud. */
  const val HORIZON_STALE_DAYS = 20

  /** Keeps a broadcast's process alive long enough to finish disk I/O. */
  const val WAKELOCK_TIMEOUT_MS = 30_000L
}

/**
 * A single background thread for every disk write in this package.
 *
 * Serialising the journal removes intra-process write interleaving for free, and one
 * thread is ample: each record is a few hundred bytes. It is never used for anything
 * that can block indefinitely.
 */
internal object Bg {
  val exec: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "medalarm-io").apply { isDaemon = false }
  }
}

/**
 * A short, timed partial wake lock for broadcast work.
 *
 * AlarmManager holds a wake lock only for the duration of onReceive(). goAsync() keeps
 * the BROADCAST alive past that, but not necessarily the CPU: on a Doze-idle device the
 * phone can go back to sleep mid-write. The timeout is a hard ceiling so a bug can never
 * hold the CPU awake and flatten the battery — that failure mode is worse than a lost
 * journal record, because the user notices it and uninstalls.
 */
internal object Wake {
  fun acquire(ctx: android.content.Context): android.os.PowerManager.WakeLock? = try {
    val pm = ctx.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
    pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "aarogya:medalarm").apply {
      setReferenceCounted(false)
      acquire(Const.WAKELOCK_TIMEOUT_MS)
    }
  } catch (t: Throwable) {
    logw("wakelock unavailable", t)
    null
  }

  fun release(wl: android.os.PowerManager.WakeLock?) {
    try {
      if (wl != null && wl.isHeld) wl.release()
    } catch (t: Throwable) {
      logw("wakelock release failed", t)
    }
  }
}

internal object AtomicFiles {
  /**
   * Write-temp-then-rename, with an fsync in between.
   *
   * rename(2) within a directory is atomic, so a reader either sees the whole old file
   * or the whole new one — never a half-written one. The fsync matters because a phone
   * that dies mid-write can otherwise resurrect with a zero-length file that renamed
   * "successfully": the rename is ordered, the DATA is not.
   *
   * Throws IOException. Every caller must decide what a failed write means; on this
   * app a silent failure is worse than a crash, because the data lost is a dose record.
   */
  fun write(target: File, bytes: ByteArray) {
    val parent = target.parentFile ?: throw java.io.IOException("no parent for $target")
    if (!parent.exists() && !parent.mkdirs() && !parent.exists()) {
      throw java.io.IOException("could not create ${parent.absolutePath}")
    }
    // Temp file lives in the SAME directory: rename across filesystems is not atomic,
    // and cacheDir can be on a different mount than filesDir on some ROMs.
    val tmp = File(parent, ".${target.name}.tmp")
    FileOutputStream(tmp).use { fos ->
      fos.write(bytes)
      fos.flush()
      fos.fd.sync()
    }
    if (!tmp.renameTo(target)) {
      // renameTo returns false rather than throwing. Clean up so temps do not pile up.
      tmp.delete()
      throw java.io.IOException("atomic rename failed for ${target.absolutePath}")
    }
  }

  fun readText(target: File): String? = try {
    if (target.exists() && target.isFile) target.readText(Charsets.UTF_8) else null
  } catch (t: Throwable) {
    Log.w(Const.TAG, "read failed for ${target.absolutePath}", t)
    null
  }
}

internal fun logd(msg: String) {
  Log.d(Const.TAG, msg)
}

internal fun logw(msg: String, t: Throwable? = null) {
  if (t != null) Log.w(Const.TAG, msg, t) else Log.w(Const.TAG, msg)
}
