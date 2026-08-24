package `in`.aarogya.medalarm

import android.app.Activity
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal class MedAlarmException(message: String) : CodedException(message)

/**
 * The JS-facing surface of the native alarm layer.
 *
 * ── WHAT THIS MODULE DELIBERATELY CANNOT DO ───────────────────────────────────
 * It cannot open the database. Not "does not" — the code to do it does not exist
 * anywhere in this package. Two processes writing the only copy of someone's health
 * history is the worst failure available to this app, and the cheapest way to guarantee
 * it never happens is to never write the code. Everything crosses the boundary as files:
 * JS writes horizon.json, Kotlin writes journal records, and neither ever holds the
 * other's lock.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Disk-touching functions are AsyncFunction: they are fast, but "fast" on a Go-class
 * phone with a full flash chip is not the same as "instant", and blocking the JS thread
 * on an fsync would stutter the UI at exactly the moment the user is editing a schedule.
 */
class MedAlarmModule : Module() {

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw MedAlarmException("No Android context available")

  private val activity: Activity?
    get() = appContext.activityProvider?.currentActivity

  override fun definition() = ModuleDefinition {
    Name("MedAlarm")

    /**
     * Replace the rules file. The JSON is fully parsed before it is allowed to overwrite
     * the existing horizon, so a bug in JS cannot destroy a working schedule — it fails
     * here, loudly, with the old file intact.
     */
    AsyncFunction("writeHorizon") { json: String ->
      try {
        HorizonStore.write(context, json)
      } catch (t: Throwable) {
        throw MedAlarmException("writeHorizon failed: ${t.message}")
      }
    }

    /**
     * Re-materialise from the rules and re-arm. Safe to call as often as you like —
     * setAlarmClock() on an existing PendingIntent replaces that alarm rather than
     * adding a second one, so this is idempotent by construction.
     */
    AsyncFunction("reconcileNow") { ->
      try {
        val r = Scheduler.reconcile(context)
        mapOf(
          "ok" to r.ok,
          "reason" to r.reason,
          "occurrences" to r.occurrences,
          "armed" to r.armed,
          "snoozesKept" to r.snoozesKept,
          "degradedToInexact" to r.degradedToInexact,
          "horizonAgeDays" to r.horizonAgeDays,
          "nextTriggerAtEpoch" to r.nextTriggerAtEpoch.toDouble()
        )
      } catch (t: Throwable) {
        throw MedAlarmException("reconcileNow failed: ${t.message}")
      }
    }

    /** Cancels every alarm this module knows about. Used on profile switch and logout. */
    AsyncFunction("cancelAll") { ->
      try {
        Scheduler.cancelAll(context)
      } catch (t: Throwable) {
        throw MedAlarmException("cancelAll failed: ${t.message}")
      }
    }

    /**
     * Every pending journal record, as JSON strings. Each carries an extra `fileName`
     * field, which is what [deleteJournalEntries] expects back — records are only
     * unlinked after JS has committed them, so a crash mid-drain replays rather than
     * loses.
     */
    AsyncFunction("readJournal") { ->
      try {
        Journal.list(context)
      } catch (t: Throwable) {
        throw MedAlarmException("readJournal failed: ${t.message}")
      }
    }

    AsyncFunction("deleteJournalEntries") { names: List<String> ->
      try {
        Journal.delete(context, names)
      } catch (t: Throwable) {
        throw MedAlarmException("deleteJournalEntries failed: ${t.message}")
      }
    }

    /** Everything the platform will actually tell us about whether reminders can work. */
    AsyncFunction("probeHealth") { ->
      try {
        HealthProbe.probe(context)
      } catch (t: Throwable) {
        throw MedAlarmException("probeHealth failed: ${t.message}")
      }
    }

    /**
     * Opens the OEM autostart screen. Returns false when no OEM-specific screen could be
     * resolved and the user was sent to the generic app-details page instead — the UI
     * must say which happened rather than claiming the setting was reached.
     */
    Function("openOemAutostartSettings") { ->
      OemSettings.openAutostart(context, activity)
    }

    Function("openBatterySettings") { ->
      OemSettings.openBatterySettings(context, activity)
    }

    Function("openExactAlarmSettings") { ->
      OemSettings.openExactAlarmSettings(context, activity)
    }

    /**
     * Silences a ringing dose alarm from inside the app.
     *
     * The notification's own Taken/Snooze/swipe paths already stop the sound natively,
     * and so does the full-screen screen — this exists for the one path that does not go
     * through either: the user taps the notification body, lands in the app, and records
     * the dose on the dose screen while the phone is still ringing behind it.
     *
     * `Function`, not `AsyncFunction`: it posts to the audio thread and returns, and
     * making the caller await a promise before the phone goes quiet would be absurd.
     */
    Function("stopRinging") { ->
      AlarmPlayer.stopAll()
    }

    /**
     * Posts a notification on [channelId] immediately. This is how a user finds out that
     * they muted the channel six weeks ago, without waiting for a real dose to be missed.
     * Writes nothing to the journal — a test must never look like an adherence event.
     */
    AsyncFunction("testFire") { channelId: String ->
      try {
        Notifications.postTest(context, channelId)
      } catch (t: Throwable) {
        throw MedAlarmException("testFire failed: ${t.message}")
      }
    }
  }
}
