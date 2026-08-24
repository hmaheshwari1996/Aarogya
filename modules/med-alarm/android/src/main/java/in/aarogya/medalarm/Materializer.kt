package `in`.aarogya.medalarm

import android.content.Intent
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * One armed alarm. Everything the receiver needs is carried in the intent, so a dose
 * notification can be posted with no database, no React tree and no network.
 */
internal data class AlarmSpec(
  /** '<threadId>:<localDate>:<timeLocal>' — byte-identical to occurrenceId() in src/lib/ids.ts. */
  val occId: String,
  /** base | e1 | e2 | s1 | s2 | s3 */
  val variant: String,
  val triggerAtMillis: Long,
  val threadId: String,
  val medicineId: String,
  val title: String,
  val body: String,
  val channelId: String,
  val critical: Boolean,
  val localDate: String,
  val timeLocal: String
) {
  fun toJson(): String = JSONObject().apply {
    put("occId", occId)
    put("variant", variant)
    put("triggerAtMillis", triggerAtMillis)
    put("threadId", threadId)
    put("medicineId", medicineId)
    put("title", title)
    put("body", body)
    put("channelId", channelId)
    put("critical", critical)
    put("localDate", localDate)
    put("timeLocal", timeLocal)
  }.toString()

  /**
   * Does this dose ring like an alarm — looping sound, repeating vibration, full-screen
   * intent — or arrive as an ordinary notification?
   *
   * ── THIS IS A DELIBERATE REVERSAL OF THE EARLIER DEFAULT ────────────────────
   * Until now only `critical` medicines got the full-screen intent, and nothing anywhere
   * looped a sound. Every medicine defaults to the `standard` tier, so in practice
   * DoseAlarmActivity was never shown once and every reminder chimed exactly one time.
   * The owner ran that behaviour on a real Xiaomi on Android 14 and asked for alarm
   * behaviour instead: "it should come like alarms and keep on ringing until taken or
   * snoozed". So `critical` AND `standard` both ring now.
   *
   * `low` — supplements and as-needed medicines — stays a quiet notification. That tier
   * exists precisely so that not everything has to shout, and an app that alarms for a
   * vitamin D tablet teaches its user to ignore alarms.
   * ────────────────────────────────────────────────────────────────────────────
   *
   * Written as "not the quiet tier" rather than "one of the loud tiers" on purpose: an
   * unrecognised channel id then rings. See [Const.DOSE_LOW_CHANNEL_ID].
   */
  val ringsAsAlarm: Boolean
    get() = critical || channelId != Const.DOSE_LOW_CHANNEL_ID

  fun writeTo(intent: Intent): Intent = intent.putExtra(Const.EXTRA_SPEC, toJson())

  fun withVariant(v: String, triggerAt: Long): AlarmSpec =
    copy(variant = v, triggerAtMillis = triggerAt)

  companion object {
    fun fromJson(raw: String?): AlarmSpec? {
      if (raw.isNullOrEmpty()) return null
      return try {
        val o = JSONObject(raw)
        val occId = o.optString("occId", "")
        if (occId.isEmpty()) return null
        AlarmSpec(
          occId = occId,
          variant = o.optString("variant", "base"),
          triggerAtMillis = o.optLong("triggerAtMillis", 0L),
          threadId = o.optString("threadId", ""),
          medicineId = o.optString("medicineId", ""),
          title = o.optString("title", "Medicine reminder"),
          body = o.optString("body", ""),
          channelId = o.optString("channelId", "dose_standard_v1"),
          critical = o.optBoolean("critical", false),
          localDate = o.optString("localDate", ""),
          timeLocal = o.optString("timeLocal", "")
        )
      } catch (t: Throwable) {
        logw("AlarmSpec parse failed", t)
        null
      }
    }

    fun fromIntent(intent: Intent?): AlarmSpec? =
      fromJson(intent?.getStringExtra(Const.EXTRA_SPEC))
  }
}

/**
 * Expands recurrence rules into concrete occurrences.
 *
 * ── WALL CLOCK, ALWAYS ────────────────────────────────────────────────────────
 * "08:00 daily" is resolved against each local date in the DEVICE'S CURRENT default
 * timezone, at the moment we arm. It is never stored as an absolute instant and
 * carried across a timezone change — that is the bug that fires a TB reminder at
 * 04:30 after a flight. RescheduleReceiver re-runs this on TIMEZONE_CHANGED, so the
 * 08:00 dose becomes 08:00 *there*.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object Materializer {

  /**
   * Two weeks of alarms armed at a time. Long enough that a phone which never opens
   * the app still has a queue, short enough that AlarmManager is not asked to hold
   * hundreds of pending intents. Every fire re-arms nothing by itself — the boot and
   * app-foreground reconciles top it back up, and the expansion is from RULES, so
   * running out is arithmetically impossible rather than merely unlikely.
   */
  const val DEFAULT_HORIZON_DAYS = 14

  fun expand(
    rules: List<AlarmRule>,
    nowMillis: Long,
    exceptions: List<AlarmException> = emptyList(),
    horizonDays: Int = DEFAULT_HORIZON_DAYS,
    zone: ZoneId = ZoneId.systemDefault()
  ): List<AlarmSpec> {
    val out = ArrayList<AlarmSpec>()
    // Per-date ring moves, keyed exactly on the occurrence being moved. A miss (the norm)
    // leaves fireTime at the rule time, so expansion is byte-identical to before this
    // feature. A hit SHIFTS this one emission's trigger; it never adds a second spec, so a
    // moved dose cannot double-ring. The occId keeps the ORIGINAL timeLocal, so the journal
    // record still matches the occurrence a "taken" was recorded against.
    val overrideByKey = HashMap<String, String>()
    for (ex in exceptions) {
      overrideByKey["${ex.threadId}|${ex.localDate}|${ex.timeLocal}"] = ex.overrideTimeLocal
    }
    val today = java.time.Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
    val lastDay = today.plusDays(horizonDays.toLong())

    for (rule in rules) {
      val startedOn = parseDate(rule.startedOn) ?: continue
      val stoppedOn = rule.stoppedOn?.let { parseDate(it) }
      val time = parseTime(rule.timeLocal) ?: continue

      // Never look further back than today: yesterday's occurrences are already in the
      // past and would only be filtered out again below.
      var day = if (startedOn.isAfter(today)) startedOn else today

      while (!day.isAfter(lastDay)) {
        if (stoppedOn != null && day.isAfter(stoppedOn)) break
        if (fires(rule, startedOn, day)) {
          // A per-day override shifts ONLY this day's ring; the rule and every other day
          // are untouched. `fireTime` falls back to the rule time on a miss.
          val overrideTimeLocal = overrideByKey["${rule.threadId}|${day}|${rule.timeLocal}"]
          val fireTime = overrideTimeLocal?.let { parseTime(it) } ?: time
          // atZone() resolves a DST gap by moving forward to the first valid instant and
          // a DST overlap by taking the earlier offset. Both are the behaviour a person
          // expects from "my 02:30 tablet" on the two days a year it is ambiguous.
          val triggerAt = day.atTime(fireTime).atZone(zone).toInstant().toEpochMilli()
          val base = AlarmSpec(
            occId = "${rule.threadId}:${day}:${rule.timeLocal}",
            variant = "base",
            triggerAtMillis = triggerAt,
            threadId = rule.threadId,
            medicineId = rule.medicineId,
            title = rule.title,
            body = rule.body,
            channelId = rule.channelId,
            critical = rule.critical,
            localDate = day.toString(),
            timeLocal = rule.timeLocal
          )

          // Only future alarms are armed. The base can be in the past while its
          // escalation is still ahead — a reconcile at 08:05 for an 08:00 dose with a
          // +15min escalation must still arm e1. Hence each variant is tested on its
          // own trigger time, never on the base's.
          if (triggerAt > nowMillis) out.add(base)

          // Escalations are dose alarms too, not "nice to have" follow-ups, and they are
          // armed here rather than chained at fire time: a process killed between the
          // dose and its escalation must still escalate. Capped at the size of the
          // variant vocabulary, because escalating forever is harassment.
          rule.escalateAfterMin.take(Const.ESCALATION_VARIANTS.size)
            .forEachIndexed { idx, minutes ->
              val at = triggerAt + minutes * 60_000L
              if (at > nowMillis) out.add(base.withVariant(Const.ESCALATION_VARIANTS[idx], at))
            }
        }
        day = day.plusDays(1)
      }
    }
    return out.sortedBy { it.triggerAtMillis }
  }

  /** Does [rule] produce an occurrence on [day]? */
  private fun fires(rule: AlarmRule, startedOn: LocalDate, day: LocalDate): Boolean {
    if (day.isBefore(startedOn)) return false

    // A zero mask means "no day of the week is enabled", i.e. this rule can never fire.
    // No human ever means that. Treating 0 as "every day" turns a data bug into a
    // visible extra reminder instead of an invisible missing one, which is the correct
    // direction to fail for a medication reminder.
    val mask = if (rule.daysMask == 0) 127 else rule.daysMask

    // daysMask bit 0 = Monday, matching dayBit() in src/lib/datetime.ts.
    // DayOfWeek.MONDAY.value == 1, hence the -1.
    val bit = 1 shl (day.dayOfWeek.value - 1)
    if ((mask and bit) == 0) return false

    if (rule.intervalDays > 1) {
      // "Every 3 days" is counted from startedOn, not from today, so the phase of the
      // cycle survives a reboot, a reinstall and a re-materialisation.
      val delta = ChronoUnit.DAYS.between(startedOn, day)
      if (delta % rule.intervalDays != 0L) return false
    }
    return true
  }

  private fun parseDate(s: String): LocalDate? = try {
    LocalDate.parse(s)
  } catch (t: Throwable) {
    logw("bad date '$s'", t)
    null
  }

  private fun parseTime(s: String): LocalTime? = try {
    val parts = s.split(":")
    if (parts.size != 2) null else LocalTime.of(parts[0].toInt(), parts[1].toInt())
  } catch (t: Throwable) {
    logw("bad time '$s'", t)
    null
  }
}
