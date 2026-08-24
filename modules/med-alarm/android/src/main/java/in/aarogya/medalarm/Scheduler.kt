package `in`.aarogya.medalarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal data class ReconcileResult(
  val ok: Boolean,
  /** 'ok' | 'no_horizon' | 'stale_horizon' */
  val reason: String,
  val occurrences: Int,
  val armed: Int,
  val snoozesKept: Int,
  /** True when exact alarms are unavailable and we fell back to inexact scheduling. */
  val degradedToInexact: Boolean,
  val horizonAgeDays: Int,
  val nextTriggerAtEpoch: Long
)

/**
 * Arms and cancels the actual AlarmManager alarms.
 *
 * ── WHY setAlarmClock, EVERY TIME ─────────────────────────────────────────────
 * setAlarmClock() is the only scheduling API exempt from BOTH Doze deferral AND
 * App Standby bucket quotas. setExactAndAllowWhileIdle() is exempt from Doze but
 * still spends the bucket quota: an app in the RESTRICTED bucket — where a phone
 * that is only opened to tap "Taken" inevitably lands — gets ONE such alarm per day.
 * A four-dose regimen would deliver breakfast and nothing else, for weeks, silently.
 *
 * The same reasoning applies to escalations. Routing them through
 * setAndAllowWhileIdle() would put them under Doze's ~1-per-9-minutes throttle, which
 * is precisely the interval an escalation chain runs at, so the chain would collapse
 * into a single ping. Escalations are dose alarms. They use setAlarmClock().
 *
 * The visible price: Android shows the status-bar alarm icon and lists the next dose
 * in the clock's "next alarm" slot. That is a deliberate trade — see
 * docs/REMINDER-RELIABILITY.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object Scheduler {

  // ───────────────────────────── public surface ─────────────────────────────

  /**
   * Re-materialise from horizon.json and re-arm everything. Idempotent: running it
   * twice in a row leaves the device in the same state, because setAlarmClock() on an
   * existing PendingIntent REPLACES that alarm rather than adding a second one.
   */
  fun reconcile(ctx: Context, nowMillis: Long = System.currentTimeMillis()): ReconcileResult {
    val horizon = HorizonStore.read(ctx)
    val ageDays = HorizonStore.ageDays(horizon, nowMillis)

    if (horizon == null) {
      // Do NOT cancel what is already armed. A missing horizon means JS is broken or the
      // file was lost; the alarms already sitting in AlarmManager are the last good state
      // and are strictly better than nothing. The caller posts a loud notice instead.
      return ReconcileResult(false, "no_horizon", 0, 0, 0, false, ageDays, 0L)
    }

    // Occurrences the user has already answered. Materialisation is pure arithmetic over
    // the rules and knows nothing about them, so without this filter a "Taken" tapped at
    // 08:02 would be undone by the next reconcile: expand() regenerates the 08:15
    // escalation (still in the future) and re-arms it, and the user is chased for a dose
    // they already recorded. Pruned as it is loaded, so it cannot grow forever.
    val resolved = ResolvedStore.loadPruned(ctx, nowMillis)

    val fresh = Materializer.expand(horizon.rules, nowMillis, horizon.exceptions)
      .filterNot { resolved.containsKey(it.occId) }

    // Snoozes are NOT derivable from the rules — they exist only because a human tapped
    // "Snooze 10 min" — so they must be re-armed by hand after the cancel sweep below.
    // Without this, opening the app five minutes into a snooze would cancel the snooze
    // and the dose would simply never come back.
    val snoozes = SnoozeStore.load(ctx).filter { it.triggerAtMillis > nowMillis }
    SnoozeStore.save(ctx, snoozes)

    val toArm = fresh + snoozes
    val previous = ArmedIndex.load(ctx)

    // Sweep the UNION of what we had and what we want, across the full variant
    // cross-product, unconditionally. Cancelling only the difference would leave an
    // orphaned e2 behind when a rule's escalation list shrinks from two entries to one.
    val sweep = LinkedHashSet<String>()
    previous.forEach { sweep.add(it.occId) }
    toArm.forEach { sweep.add(it.occId) }
    val am = alarmManager(ctx)
    sweep.forEach { occId -> cancelVariants(ctx, am, occId) }

    var degraded = false
    val show = showIntent(ctx)
    for (spec in toArm) {
      if (!arm(ctx, am, spec, show)) degraded = true
    }

    ArmedIndex.save(ctx, toArm)
    if (degraded) Notifications.postExactAlarmsDegraded(ctx)

    return ReconcileResult(
      ok = true,
      reason = if (HorizonStore.isStale(horizon, nowMillis)) "stale_horizon" else "ok",
      occurrences = fresh.count { it.variant == "base" },
      armed = toArm.size,
      snoozesKept = snoozes.size,
      degradedToInexact = degraded,
      horizonAgeDays = ageDays,
      nextTriggerAtEpoch = toArm.minOfOrNull { it.triggerAtMillis } ?: 0L
    )
  }

  /** Cancels every alarm this module knows about and forgets both indexes. */
  fun cancelAll(ctx: Context) {
    // Including one that is ringing at this exact moment. This is called on profile
    // switch and logout, and a phone still ringing for a profile that is no longer
    // loaded has nothing left that can answer it.
    AlarmPlayer.stopAll()
    val am = alarmManager(ctx)
    val known = LinkedHashSet<String>()
    ArmedIndex.load(ctx).forEach { known.add(it.occId) }
    SnoozeStore.load(ctx).forEach { known.add(it.occId) }
    known.forEach { cancelVariants(ctx, am, it) }
    ArmedIndex.save(ctx, emptyList())
    SnoozeStore.save(ctx, emptyList())
    ResolvedStore.save(ctx, emptyMap())
    logd("cancelAll: swept ${known.size} occurrences")
  }

  /**
   * Cancels every remaining alarm for one occurrence — used when the dose is recorded,
   * so a "Taken" at 08:02 does not get chased by its own 08:15 escalation.
   */
  fun cancelOccurrence(ctx: Context, occId: String) {
    cancelVariants(ctx, alarmManager(ctx), occId)
    SnoozeStore.save(ctx, SnoozeStore.load(ctx).filter { it.occId != occId })
    ArmedIndex.save(ctx, ArmedIndex.load(ctx).filter { it.occId != occId })
    markResolved(ctx, occId)
  }

  /**
   * Records that this occurrence has been answered, so the next reconcile does not
   * re-materialise it from the rules. Called for "Taken" and for "Snooze" — a snooze is
   * an acknowledgement too, and its follow-up lives in the snooze store, not in the rules.
   */
  fun markResolved(ctx: Context, occId: String, nowMillis: Long = System.currentTimeMillis()) {
    val current = ResolvedStore.loadPruned(ctx, nowMillis).toMutableMap()
    current[occId] = nowMillis
    ResolvedStore.save(ctx, current)
  }

  /**
   * Cancels only the escalation variants for one occurrence. Used by Snooze: the user
   * has acknowledged the dose, so the escalation chain has done its job, but the dose
   * itself must still come back in ten minutes.
   */
  fun cancelEscalations(ctx: Context, occId: String) {
    val am = alarmManager(ctx)
    Const.ESCALATION_VARIANTS.forEach { cancelOne(ctx, am, occId, it) }
  }

  /**
   * Arms the next snooze in the chain. Returns the variant used, or null when the chain
   * is exhausted (after three snoozes we stop and record that we stopped — an infinite
   * snooze is indistinguishable from a missed dose on a report).
   */
  fun armSnooze(ctx: Context, spec: AlarmSpec, minutes: Int = Const.SNOOZE_MINUTES): String? {
    val next = nextSnoozeVariant(spec.variant) ?: return null
    val at = System.currentTimeMillis() + minutes * 60_000L
    val snoozed = spec.withVariant(next, at)

    val am = alarmManager(ctx)
    // Drop any earlier snooze for this occurrence before arming the new one, otherwise
    // a double tap would leave two live snoozes and ping twice.
    Const.SNOOZE_VARIANTS.forEach { cancelOne(ctx, am, spec.occId, it) }
    arm(ctx, am, snoozed, showIntent(ctx))

    val kept = SnoozeStore.load(ctx).filter { it.occId != spec.occId && it.triggerAtMillis > System.currentTimeMillis() }
    SnoozeStore.save(ctx, kept + snoozed)
    // Stop the rules from resurrecting the original alarm and its escalations underneath
    // the snooze; the snooze store is now the only live alarm for this occurrence.
    markResolved(ctx, spec.occId)
    return next
  }

  fun armedSpecs(ctx: Context): List<AlarmSpec> = ArmedIndex.load(ctx)

  // ───────────────────────────── arming ─────────────────────────────

  /** @return true if armed exactly, false if it had to degrade to an inexact alarm. */
  private fun arm(ctx: Context, am: AlarmManager, spec: AlarmSpec, show: PendingIntent): Boolean {
    val pi = firePendingIntent(ctx, spec.occId, spec.variant, spec)
    val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()

    if (canExact) {
      try {
        am.setAlarmClock(AlarmManager.AlarmClockInfo(spec.triggerAtMillis, show), pi)
        return true
      } catch (se: SecurityException) {
        // Permission can be revoked between the check above and this call.
        logw("setAlarmClock refused for ${spec.occId}#${spec.variant}", se)
      }
    }

    // Degraded path. On a Play build the user can revoke SCHEDULE_EXACT_ALARM; we keep
    // reminding, inexactly, and the Reminder Health Check says so out loud rather than
    // letting the app look healthy while drifting by up to fifteen minutes in Doze.
    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, spec.triggerAtMillis, pi)
    return false
  }

  // ───────────────────────────── cancelling ─────────────────────────────

  /**
   * Cancel all six variants for one occurrence, unconditionally.
   *
   * ── WHY NOT FLAG_NO_CREATE ────────────────────────────────────────────────
   * The tempting version probes with FLAG_NO_CREATE and skips the cancel when it
   * returns null. That probe answers a different question than the one being asked:
   * it reports whether a PENDING INTENT exists, not whether an ALARM is scheduled.
   * A PendingIntent stays alive after its alarm has fired, and it also survives
   * am.cancel(). So the probe reports "healthy" in exactly the two states a drift
   * detector exists to catch, and reports "nothing here" for an alarm that is very
   * much still armed if the process was restarted. Unconditional cancel + idempotent
   * re-arm is cheap (a few dozen binder calls) and cannot be wrong.
   * ─────────────────────────────────────────────────────────────────────────
   */
  private fun cancelVariants(ctx: Context, am: AlarmManager, occId: String) {
    Const.VARIANTS.forEach { cancelOne(ctx, am, occId, it) }
  }

  private fun cancelOne(ctx: Context, am: AlarmManager, occId: String, variant: String) {
    try {
      val pi = firePendingIntent(ctx, occId, variant, null)
      am.cancel(pi)
      pi.cancel()
    } catch (t: Throwable) {
      logw("cancel failed for $occId#$variant", t)
    }
  }

  // ───────────────────────────── intents ─────────────────────────────

  /**
   * The data URI is what makes two alarms for the same occurrence distinct.
   * Intent.filterEquals() — which is what AlarmManager and PendingIntent use for
   * identity — compares action, DATA, type, package, component and categories, and
   * ignores extras entirely. Two alarms differing only in their extras are the SAME
   * alarm to the system, so arming the escalation would overwrite the dose.
   *
   * occId contains colons ('<uuid>:<date>:<HH>:<MM>'), so it is percent-encoded before
   * being used as the authority; an un-encoded colon there parses as a port.
   */
  private fun variantUri(occId: String, variant: String): Uri =
    Uri.parse("medalarm://" + Uri.encode(occId) + "#" + variant)

  private fun firePendingIntent(
    ctx: Context,
    occId: String,
    variant: String,
    spec: AlarmSpec?
  ): PendingIntent {
    val i = Intent(ctx.applicationContext, DoseAlarmReceiver::class.java).apply {
      action = Const.ACTION_FIRE
      data = variantUri(occId, variant)
      spec?.writeTo(this)
    }
    // requestCode is a constant 0 on purpose: identity comes from filterEquals (i.e. the
    // data URI), and a hashed request code would only add collisions of its own.
    return PendingIntent.getBroadcast(
      ctx.applicationContext,
      0,
      i,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * What opens when the user taps the status-bar alarm icon that setAlarmClock() puts
   * there. Always non-null: the app's launcher activity when the package manager will
   * name it, and a hand-built launcher intent otherwise. A PendingIntent can be created
   * for an intent that resolves to nothing — it simply does nothing when tapped — which
   * is a better outcome than propagating a null through the alarm-arming path.
   */
  private fun showIntent(ctx: Context): PendingIntent {
    val app = ctx.applicationContext
    val launch = try {
      app.packageManager.getLaunchIntentForPackage(app.packageName)
    } catch (t: Throwable) {
      logw("launch intent lookup failed", t)
      null
    } ?: Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setPackage(app.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    return PendingIntent.getActivity(
      app,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun nextSnoozeVariant(current: String): String? {
    val idx = Const.SNOOZE_VARIANTS.indexOf(current)
    // Anything that is not already a snooze (base, e1, e2) starts the chain at s1.
    if (idx < 0) return Const.SNOOZE_VARIANTS.first()
    return Const.SNOOZE_VARIANTS.getOrNull(idx + 1)
  }

  private fun alarmManager(ctx: Context): AlarmManager =
    ctx.applicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  // ───────────────────────────── persistence ─────────────────────────────

  /**
   * What is currently armed. Kotlin-owned; JS never reads it. It exists so a cancel
   * sweep knows which occurrence ids to visit after a reboot, when the in-memory view
   * is gone, and so the health probe can report the next trigger without guessing.
   */
  private object ArmedIndex {
    fun load(ctx: Context): List<AlarmSpec> = readSpecs(File(HorizonStore.dir(ctx), Const.ARMED_FILE))
    fun save(ctx: Context, specs: List<AlarmSpec>) =
      writeSpecs(File(HorizonStore.dir(ctx), Const.ARMED_FILE), specs)
  }

  /** Live snoozes. Separate file so a reconcile sweep can restore them verbatim. */
  private object SnoozeStore {
    fun load(ctx: Context): List<AlarmSpec> = readSpecs(File(HorizonStore.dir(ctx), Const.SNOOZE_FILE))
    fun save(ctx: Context, specs: List<AlarmSpec>) =
      writeSpecs(File(HorizonStore.dir(ctx), Const.SNOOZE_FILE), specs)
  }

  /**
   * Occurrence ids the user has already answered, with the time they answered.
   *
   * This is the memory that stops pure arithmetic from undoing a human decision. It is
   * deliberately tiny and self-pruning — a map of at most a few dozen ids, none older
   * than [Const.RESOLVED_TTL_MS].
   */
  private object ResolvedStore {
    private fun file(ctx: Context) = File(HorizonStore.dir(ctx), Const.RESOLVED_FILE)

    fun loadPruned(ctx: Context, nowMillis: Long): Map<String, Long> {
      val raw = AtomicFiles.readText(file(ctx)) ?: return emptyMap()
      return try {
        val obj = JSONObject(raw).optJSONObject("resolved") ?: JSONObject()
        val kept = LinkedHashMap<String, Long>()
        val keys = obj.keys()
        while (keys.hasNext()) {
          val k = keys.next()
          val at = obj.optLong(k, 0L)
          if (nowMillis - at < Const.RESOLVED_TTL_MS) kept[k] = at
        }
        kept
      } catch (t: Throwable) {
        logw("could not read ${Const.RESOLVED_FILE}", t)
        emptyMap()
      }
    }

    fun save(ctx: Context, entries: Map<String, Long>) {
      try {
        val obj = JSONObject()
        entries.forEach { (k, v) -> obj.put(k, v) }
        AtomicFiles.write(
          file(ctx),
          JSONObject().put("resolved", obj).toString().toByteArray(Charsets.UTF_8)
        )
      } catch (t: Throwable) {
        // Losing this file re-arms an escalation for a dose already taken: annoying, not
        // dangerous. Never worth failing the surrounding write for.
        logw("could not write ${Const.RESOLVED_FILE}", t)
      }
    }
  }

  private fun readSpecs(f: File): List<AlarmSpec> {
    val raw = AtomicFiles.readText(f) ?: return emptyList()
    return try {
      val arr = JSONObject(raw).optJSONArray("specs") ?: JSONArray()
      (0 until arr.length()).mapNotNull { AlarmSpec.fromJson(arr.optJSONObject(it)?.toString()) }
    } catch (t: Throwable) {
      logw("could not read ${f.name}", t)
      emptyList()
    }
  }

  private fun writeSpecs(f: File, specs: List<AlarmSpec>) {
    try {
      val arr = JSONArray()
      specs.forEach { arr.put(JSONObject(it.toJson())) }
      val body = JSONObject().put("specs", arr).toString()
      AtomicFiles.write(f, body.toByteArray(Charsets.UTF_8))
    } catch (t: Throwable) {
      // Losing this index is survivable: the next reconcile rebuilds it from the rules.
      // It is not worth failing an alarm arm over, so it is logged and swallowed.
      logw("could not write ${f.name}", t)
    }
  }
}
