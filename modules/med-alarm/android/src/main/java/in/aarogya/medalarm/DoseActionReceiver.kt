package `in`.aarogya.medalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * The three things a person can do to a dose notification, handled with NO React tree
 * alive: tap Taken, tap Snooze, or swipe it away.
 *
 * This is the path the app is actually designed around — a user who taps "Taken" from
 * the shade every morning and opens the app once a month. It must work when the app has
 * never been foregrounded since boot.
 */
internal object DoseActions {

  fun taken(ctx: Context, spec: AlarmSpec, origin: String) {
    // First line of all three, on purpose. Every one of these is a person answering the
    // alarm, and the sound has to stop before anything slower happens — the call is a
    // post to the audio thread and returns immediately, so nothing here waits on it.
    AlarmPlayer.stop(spec.occId)
    Journal.write(
      ctx = ctx,
      occId = spec.occId,
      threadId = spec.threadId,
      medicineId = spec.medicineId,
      event = "taken",
      origin = origin,
      payload = JSONObject().put("variant", spec.variant).put("scheduledFor", spec.triggerAtMillis)
    )
    // Journal FIRST, then cancel. If the process dies between the two the worst outcome
    // is a duplicate ping for a dose already recorded; the reverse order risks a
    // cancelled alarm with no record, which reads as a missed dose forever.
    Scheduler.cancelOccurrence(ctx, spec.occId)
    Notifications.cancelDose(ctx, spec.occId)
  }

  fun snooze(ctx: Context, spec: AlarmSpec, origin: String, minutes: Int = Const.SNOOZE_MINUTES) {
    AlarmPlayer.stop(spec.occId)
    // The escalation chain exists to catch a dose nobody acknowledged. A snooze IS an
    // acknowledgement, so the chain stops — but the dose itself comes back.
    Scheduler.cancelEscalations(ctx, spec.occId)
    val armedVariant = Scheduler.armSnooze(ctx, spec, minutes)

    val payload = JSONObject()
      .put("minutes", minutes)
      .put("fromVariant", spec.variant)
      .put("scheduledFor", spec.triggerAtMillis)
    if (armedVariant == null) {
      // Three snoozes is the cap. An unbounded snooze chain looks like engagement and is
      // actually a dose that never happened, so we stop and say so in the record.
      payload.put("capped", true)
      Scheduler.cancelOccurrence(ctx, spec.occId)
    } else {
      payload.put("nextVariant", armedVariant)
    }

    Journal.write(
      ctx = ctx,
      occId = spec.occId,
      threadId = spec.threadId,
      medicineId = spec.medicineId,
      event = "snoozed",
      origin = origin,
      payload = payload
    )
    Notifications.cancelDose(ctx, spec.occId)
  }

  fun dismissed(ctx: Context, spec: AlarmSpec, origin: String) {
    // A swipe DOES stop the sound — the person is holding the phone and has told us to
    // stop. It deliberately does NOT cancel the escalations: a swipe is not a decision
    // about the medicine, and an escalation the user then swipes twice is far better
    // than an app that treats "got it out of my way" as "took it". So the phone goes
    // quiet now and asks again in fifteen minutes.
    AlarmPlayer.stop(spec.occId)
    Journal.write(
      ctx = ctx,
      occId = spec.occId,
      threadId = spec.threadId,
      medicineId = spec.medicineId,
      event = "dismissed",
      origin = origin,
      payload = JSONObject().put("variant", spec.variant)
    )
  }
}

class DoseActionReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    val app = context.applicationContext
    val wl = Wake.acquire(app)

    val action = intent.action
    val specJson = intent.getStringExtra(Const.EXTRA_SPEC)

    Bg.exec.execute {
      try {
        val spec = AlarmSpec.fromJson(specJson)
        if (spec == null) {
          Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "DoseActionReceiver")
              .put("reason", "missing_or_unparseable_spec")
              .put("action", action ?: "(none)")
          )
        } else when (action) {
          Const.ACTION_TAKEN -> DoseActions.taken(app, spec, "notification")
          Const.ACTION_SNOOZE -> DoseActions.snooze(app, spec, "notification")
          Const.ACTION_DISMISS -> DoseActions.dismissed(app, spec, "notification")
          else -> Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "DoseActionReceiver")
              .put("reason", "unknown_action")
              .put("action", action ?: "(none)")
          )
        }
      } catch (t: Throwable) {
        logw("DoseActionReceiver failed", t)
        try {
          Journal.writeSystem(
            app,
            "receiver_error",
            JSONObject()
              .put("where", "DoseActionReceiver")
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
