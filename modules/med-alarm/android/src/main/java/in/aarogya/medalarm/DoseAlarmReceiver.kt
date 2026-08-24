package `in`.aarogya.medalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * Fires one dose reminder. This runs with no Activity, no React tree and, quite often,
 * no user — at 06:00 on a phone that has been idle since midnight.
 *
 * Everything it needs is in the intent, so it touches no database and starts no JS.
 */
class DoseAlarmReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    // goAsync() BEFORE any I/O. Without it the process becomes killable the moment
    // onReceive returns, and a notification posted from a background thread after that
    // point is a coin flip.
    val pending = goAsync()
    val app = context.applicationContext
    val wl = Wake.acquire(app)

    // Read the extras here, on the receiver thread — the Intent must not be assumed
    // valid once the broadcast has been finished.
    val specJson = intent.getStringExtra(Const.EXTRA_SPEC)
    val action = intent.action ?: "(none)"

    Bg.exec.execute {
      try {
        val spec = AlarmSpec.fromJson(specJson)
        if (spec == null) {
          // An alarm fired that we cannot identify. That is a bug, and a bug that eats a
          // dose reminder must leave a trace JS can surface, not just a logcat line.
          Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "DoseAlarmReceiver")
              .put("reason", "missing_or_unparseable_spec")
              .put("action", action)
          )
        } else {
          // ── ORDERING. READ THIS BEFORE CHANGING IT. ──────────────────────────
          // The ringing is started HERE, by the receiver that fired the alarm — never by
          // DoseAlarmActivity. canUseFullScreenIntent() is false on some Android 14+
          // configurations, and even when it is true Android shows a heads-up
          // notification instead of the activity whenever the device is unlocked and in
          // use. Starting the player from the activity would therefore make the alarm
          // silent in exactly the case where the phone is already in the user's hand.
          //
          // It is started BEFORE the notification is posted, so no ordering exists in
          // which the full-screen activity can be created (and stop the sound on its way
          // out) before the sound has begun.
          //
          // And it is started only when the person will actually be able to SEE the
          // notification, because the notification carries the only Taken and Snooze
          // buttons there are. Ringing without them is two minutes of unexplained noise.
          val willRing = spec.ringsAsAlarm && Notifications.canShowDose(app, spec.channelId)
          if (willRing) AlarmPlayer.start(app, spec)

          val posted = Notifications.postDose(app, spec)
          if (willRing && !posted) {
            // Belt and braces for the case canShowDose() cannot see: notify() itself
            // failed, so there is no notification and therefore no way to answer.
            logw("notification for ${spec.occId} did not post; silencing")
            AlarmPlayer.stop(spec.occId)
          }

          Journal.write(
            ctx = app,
            occId = spec.occId,
            threadId = spec.threadId,
            medicineId = spec.medicineId,
            event = "delivered",
            origin = "native",
            payload = JSONObject()
              .put("variant", spec.variant)
              .put("scheduledFor", spec.triggerAtMillis)
              .put("critical", spec.critical)
              // Recorded so "it did not ring" can be told apart from "it did ring and she
              // did not hear it" without a device in hand. Free-form payload field; the
              // JS drain treats payload as opaque.
              .put("rang", willRing && posted)
          )
        }
      } catch (t: Throwable) {
        // The whole body is wrapped: an uncaught throw here is an ANR-adjacent crash in
        // a background process that the user never sees, and the dose vanishes silently.
        logw("DoseAlarmReceiver failed", t)
        try {
          Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "DoseAlarmReceiver")
              .put("reason", t.javaClass.simpleName)
              .put("message", t.message ?: "")
          )
        } catch (ignored: Throwable) {
          logw("could not record receiver_error", ignored)
        }
      } finally {
        Wake.release(wl)
        try {
          pending.finish()
        } catch (t: Throwable) {
          logw("PendingResult.finish failed", t)
        }
      }
    }
  }
}
