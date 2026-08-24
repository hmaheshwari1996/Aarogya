package `in`.aarogya.medalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * Everything that silently empties AlarmManager, in one place.
 *
 *  BOOT_COMPLETED      the alarm table does not survive a reboot
 *  MY_PACKAGE_REPLACED an app update clears every alarm the old version set
 *  TIMEZONE_CHANGED    "08:00" must mean 08:00 where the phone now is
 *  TIME_SET            a manual clock change moves every wall-clock schedule
 *  DATE_CHANGED        midnight rolled over; top the 14-day window back up
 *  SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED
 *                      the user just granted (or revoked) exact alarms; everything
 *                      armed under the old permission must be re-armed under the new one
 *
 * Re-materialising from RULES is what makes this safe. If horizon.json held pre-computed
 * dates, a boot on day nine would restore an empty list and every reminder would stop
 * with no error anywhere.
 */
class RescheduleReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    val app = context.applicationContext
    val wl = Wake.acquire(app)
    val action = intent.action ?: "(none)"

    Bg.exec.execute {
      try {
        val horizon = HorizonStore.read(app)
        val unusable = horizon == null
        val stale = HorizonStore.isStale(horizon)

        // A stale horizon is still better than no horizon: the rules from three weeks ago
        // are almost certainly still the right rules. Re-arm from whatever we have AND
        // warn — never one or the other.
        val result = if (horizon != null) {
          Scheduler.reconcile(app)
        } else {
          null
        }

        Journal.writeSystem(
          app,
          "rearmed",
          JSONObject()
            .put("trigger", action)
            .put("armed", result?.armed ?: 0)
            .put("occurrences", result?.occurrences ?: 0)
            .put("horizonAgeDays", HorizonStore.ageDays(horizon))
            .put("degradedToInexact", result?.degradedToInexact ?: false)
        )

        if (unusable || stale) {
          // FAIL LOUD. The alternative — a phone that quietly stops reminding — is the
          // single worst outcome this module can produce, because nothing about it looks
          // broken from the outside. One notification, on system_v1, with a stable id so
          // repeated boots replace it instead of stacking.
          logw("horizon unusable=$unusable stale=$stale after $action")
          Notifications.postHorizonUnusable(app)
        }
      } catch (t: Throwable) {
        logw("RescheduleReceiver failed after $action", t)
        try {
          Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "RescheduleReceiver")
              .put("trigger", action)
              .put("reason", t.javaClass.simpleName)
              .put("message", t.message ?: "")
          )
          Notifications.postHorizonUnusable(app)
        } catch (ignored: Throwable) {
          logw("could not record reschedule failure", ignored)
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
