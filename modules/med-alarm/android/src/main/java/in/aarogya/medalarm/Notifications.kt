package `in`.aarogya.medalarm

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Builds and posts every notification this module produces.
 *
 * ── CHANNELS ARE NOT CREATED HERE ─────────────────────────────────────────────
 * They are created exactly once, in MainApplication.onCreate(), by
 * plugins/withNotificationChannels.js, from src/constants/channels.js. Android
 * channels are IMMUTABLE after first creation, so a second creator with even slightly
 * different properties permanently wins or permanently loses depending on which ran
 * first on that device — an unfixable, per-device coin flip. This file therefore only
 * ever *reads* channels; [resolveChannel] degrades if one is missing rather than
 * inventing one.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object Notifications {

  /**
   * A user can delete a channel from system settings on some ROMs, and a notification
   * posted to a channel id that does not exist is dropped by the system with only a
   * logcat line. Falling back to system_v1 keeps the reminder visible (wrong sound is
   * survivable; invisible is not) and the health probe reports the missing channel.
   */
  fun resolveChannel(ctx: Context, wanted: String): String {
    return try {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      when {
        nm.getNotificationChannel(wanted) != null -> wanted
        nm.getNotificationChannel(Const.SYSTEM_CHANNEL_ID) != null -> {
          logw("channel '$wanted' missing; falling back to ${Const.SYSTEM_CHANNEL_ID}")
          Const.SYSTEM_CHANNEL_ID
        }
        else -> wanted
      }
    } catch (t: Throwable) {
      logw("channel lookup failed", t)
      wanted
    }
  }

  /** Stable per occurrence, so an escalation UPDATES the dose notification, not stacks it. */
  fun notificationId(occId: String): Int = occId.hashCode()

  /**
   * Is there any point ringing? i.e. will a notification posted on [channelId] actually
   * be VISIBLE to the person, so that they have a way to answer it?
   *
   * This gates the alarm player, and it is the reason it gates it: a looping alarm with
   * no notification is a phone that rings for two minutes with no Taken button, no
   * Snooze button and no explanation. `notify()` does not fail in either of the cases
   * that produce that — an app-level notification block, or this exact channel muted to
   * IMPORTANCE_NONE — it simply succeeds and shows nothing. So both are checked here.
   *
   * Fails closed. If we cannot tell, we do not ring.
   */
  fun canShowDose(ctx: Context, channelId: String): Boolean = try {
    if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) {
      false
    } else {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = nm.getNotificationChannel(resolveChannel(ctx, channelId))
      // A null channel is not a mute: resolveChannel has already degraded to system_v1,
      // and HealthProbe reports the missing channel to the UI.
      ch == null || ch.importance != NotificationManager.IMPORTANCE_NONE
    }
  } catch (t: Throwable) {
    logw("canShowDose($channelId) failed", t)
    false
  }

  /** @return true if the notification was actually handed to the system. */
  fun postDose(ctx: Context, spec: AlarmSpec): Boolean {
    val channelId = resolveChannel(ctx, spec.channelId)
    val builder = NotificationCompat.Builder(ctx, channelId)
      .setSmallIcon(R.drawable.ic_med_alarm)
      .setContentTitle(spec.title)
      .setContentText(spec.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(spec.body))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setWhen(spec.triggerAtMillis)
      .setShowWhen(true)
      // false: an escalation must re-alert. The whole point of e1/e2 is a second sound.
      .setOnlyAlertOnce(false)
      // Dismissible on purpose — a swipe is data (see the delete intent below).
      .setOngoing(false)
      .setAutoCancel(true)
      // A swipe-away writes a `dismissed` record. Without it a dismissal is invisible,
      // and the catch-up card cannot tell "she saw it and swiped it away" from "it never
      // arrived" — which are opposite problems with opposite fixes.
      .setDeleteIntent(actionIntent(ctx, spec, Const.ACTION_DISMISS, "dismiss"))
      .addAction(
        R.drawable.ic_med_alarm,
        ctx.getString(R.string.med_alarm_action_taken),
        actionIntent(ctx, spec, Const.ACTION_TAKEN, "taken")
      )
      .addAction(
        R.drawable.ic_med_alarm,
        ctx.getString(R.string.med_alarm_action_snooze, Const.SNOOZE_MINUTES),
        actionIntent(ctx, spec, Const.ACTION_SNOOZE, "snooze")
      )

    // Set only when it exists — the app's launcher activity is normally resolvable, but
    // a null here would be passed straight into an androidx builder whose nullability
    // contract has changed between releases.
    openAppIntent(ctx, spec)?.let { builder.setContentIntent(it) }

    if (spec.ringsAsAlarm && canUseFullScreenIntent(ctx)) {
      // ── WAS `spec.critical`. CHANGED ON PURPOSE. ────────────────────────────
      // Gating this on `critical` meant it never fired: every medicine defaults to the
      // `standard` tier, so DoseAlarmActivity — which is fully written and has been in
      // the build all along — had not been shown once on a real device. `critical` and
      // `standard` now both get it; `low` still does not. See [AlarmSpec.ringsAsAlarm]
      // and docs/REMINDER-RELIABILITY.md.
      //
      // `true` = show the activity even if the device is unlocked and in use; for a dose
      // that is due, an interruption is the intent.
      //
      // Note what this does NOT control: the ringing. The looping sound is started by
      // DoseAlarmReceiver, not by this activity, precisely because
      // canUseFullScreenIntent() is false on some Android 14+ configurations and because
      // Android substitutes a heads-up notification whenever the phone is unlocked and
      // in use. Tying the sound to the activity would make the alarm silent in exactly
      // the case where the phone is already in the user's hand.
      builder.setFullScreenIntent(fullScreenIntent(ctx, spec), true)
    }

    // On API 33+ this is a no-op without POST_NOTIFICATIONS. We cannot request a runtime
    // permission from a broadcast receiver; HealthProbe reports the denial to the UI,
    // which is where a human can act on it.
    return safeNotify(ctx, notificationId(spec.occId), builder)
  }

  fun cancelDose(ctx: Context, occId: String) {
    try {
      NotificationManagerCompat.from(ctx).cancel(notificationId(occId))
    } catch (t: Throwable) {
      logw("cancel notification failed for $occId", t)
    }
  }

  fun postTest(ctx: Context, channelId: String) {
    val builder = NotificationCompat.Builder(ctx, resolveChannel(ctx, channelId))
      .setSmallIcon(R.drawable.ic_med_alarm)
      .setContentTitle(ctx.getString(R.string.med_alarm_test_title))
      .setContentText(ctx.getString(R.string.med_alarm_test_body))
      .setStyle(NotificationCompat.BigTextStyle().bigText(ctx.getString(R.string.med_alarm_test_body)))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setAutoCancel(true)
    safeNotify(ctx, Const.NOTIF_ID_TEST, builder)
  }

  fun postHorizonUnusable(ctx: Context) = postSystemNotice(
    ctx,
    Const.NOTIF_ID_HORIZON_STALE,
    ctx.getString(R.string.med_alarm_notice_horizon_title),
    ctx.getString(R.string.med_alarm_notice_horizon_body)
  )

  fun postJournalWriteFailure(ctx: Context) = postSystemNotice(
    ctx,
    Const.NOTIF_ID_JOURNAL_IO,
    ctx.getString(R.string.med_alarm_notice_journal_title),
    ctx.getString(R.string.med_alarm_notice_journal_body)
  )

  fun postExactAlarmsDegraded(ctx: Context) = postSystemNotice(
    ctx,
    Const.NOTIF_ID_EXACT_DEGRADED,
    ctx.getString(R.string.med_alarm_notice_exact_title),
    ctx.getString(R.string.med_alarm_notice_exact_body)
  )

  private fun postSystemNotice(ctx: Context, id: Int, title: String, body: String) {
    val builder = NotificationCompat.Builder(ctx, resolveChannel(ctx, Const.SYSTEM_CHANNEL_ID))
      .setSmallIcon(R.drawable.ic_med_alarm)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_ERROR)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setAutoCancel(true)
    openAppIntent(ctx, null)?.let { builder.setContentIntent(it) }
    safeNotify(ctx, id, builder)
  }

  /** @return true if the system accepted the notification. */
  private fun safeNotify(ctx: Context, id: Int, builder: NotificationCompat.Builder): Boolean =
    try {
      NotificationManagerCompat.from(ctx).notify(id, builder.build())
      true
    } catch (sec: SecurityException) {
      // POST_NOTIFICATIONS denied on API 33+.
      logw("notify($id) denied", sec)
      false
    } catch (t: Throwable) {
      logw("notify($id) failed", t)
      false
    }

  // ───────────────────────────── intents ─────────────────────────────

  /**
   * Per-occurrence data URI on every action intent.
   *
   * Intent.filterEquals() ignores extras, so without the occurrence in the URI, the
   * "Taken" button of every dose in the app would share ONE PendingIntent — and
   * FLAG_UPDATE_CURRENT would silently repoint yesterday's still-visible notification
   * at today's dose.
   */
  private fun actionIntent(
    ctx: Context,
    spec: AlarmSpec,
    action: String,
    tag: String
  ): PendingIntent {
    val i = Intent(ctx.applicationContext, DoseActionReceiver::class.java).apply {
      this.action = action
      data = Uri.parse("medalarm://" + Uri.encode(spec.occId) + "#" + tag)
      spec.writeTo(this)
    }
    return PendingIntent.getBroadcast(
      ctx.applicationContext,
      0,
      i,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * Content tap → an Activity, directly.
   *
   * Android 16 forbids a BroadcastReceiver started from a notification tap from calling
   * startActivity(). A "receiver hop" (tap → receiver → startActivity) therefore does
   * nothing at all on new devices, and nothing is worse than a wrong screen because the
   * user assumes the tap was recorded. PendingIntent.getActivity() has no such problem.
   */
  private fun openAppIntent(ctx: Context, spec: AlarmSpec?): PendingIntent? {
    val app = ctx.applicationContext
    val deepLink = spec?.let {
      Intent(Intent.ACTION_VIEW, Uri.parse("aarogya://dose?occ=" + Uri.encode(it.occId))).apply {
        setPackage(app.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
    }
    val intent = when {
      deepLink != null && deepLink.resolveActivity(app.packageManager) != null -> deepLink
      else -> app.packageManager.getLaunchIntentForPackage(app.packageName)
        ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } ?: return null

    return try {
      PendingIntent.getActivity(
        app,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } catch (t: Throwable) {
      logw("content intent unavailable", t)
      null
    }
  }

  private fun fullScreenIntent(ctx: Context, spec: AlarmSpec): PendingIntent {
    val i = Intent(ctx.applicationContext, DoseAlarmActivity::class.java).apply {
      action = Const.ACTION_FIRE
      data = Uri.parse("medalarm://" + Uri.encode(spec.occId) + "#fullscreen")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      spec.writeTo(this)
    }
    return PendingIntent.getActivity(
      ctx.applicationContext,
      0,
      i,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * Android 14 made full-screen intents opt-in for apps that are not alarm clocks or
   * calling apps: the permission is declared but DENIED by default, and
   * setFullScreenIntent() then silently degrades to a heads-up notification. We check
   * first so the caller's behaviour is predictable rather than platform-dependent.
   */
  fun canUseFullScreenIntent(ctx: Context): Boolean = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.canUseFullScreenIntent()
    } else {
      true
    }
  } catch (t: Throwable) {
    logw("canUseFullScreenIntent failed", t)
    false
  }
}
