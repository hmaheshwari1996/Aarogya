package `in`.aarogya.medalarm

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * One recurrence RULE. Mirrors `AlarmRule` in src/types.ts field for field.
 *
 * Note what is NOT here: a list of dates. The horizon file carries rules, and
 * [Materializer] expands them forward on demand. A pre-computed list would need JS to
 * top it up, JS only runs when the app is foregrounded, and this app's whole point is
 * that you can tap "Taken" from the notification and never open it. A seven-day list
 * would go quiet on day eight, silently, for exactly the user it was built for.
 */
internal data class AlarmRule(
  val threadId: String,
  val medicineId: String,
  val title: String,
  val body: String,
  /** Wall clock 'HH:MM'. Never an absolute timestamp. */
  val timeLocal: String,
  /** 7-bit field, bit 0 = Monday, matching src/lib/datetime.ts dayBit(). */
  val daysMask: Int,
  val intervalDays: Int,
  val startedOn: String,
  val stoppedOn: String?,
  val channelId: String,
  val critical: Boolean,
  val escalateAfterMin: List<Int>
)

internal data class Horizon(
  val schemaVersion: Int,
  val writtenAtEpoch: Long,
  val profileId: String,
  val rules: List<AlarmRule>,
  /** Rules the parser had to drop. Non-zero is a bug in JS, and the health probe shows it. */
  val droppedRules: Int
)

/**
 * Reads and writes `filesDir/medalarm/horizon.json`.
 *
 * Tolerance policy, deliberately asymmetric:
 *  - READ tolerates anything. A corrupt file returns null, and the caller fails LOUD
 *    (a visible "open Aarogya to restore your reminders" notice), never silent.
 *  - WRITE tolerates nothing. The incoming JSON is fully parsed before it is allowed to
 *    replace a known-good file, so a bug in JS cannot destroy a working horizon.
 */
internal object HorizonStore {

  fun dir(ctx: Context): File = File(ctx.filesDir, Const.DIR).also { if (!it.exists()) it.mkdirs() }

  fun file(ctx: Context): File = File(dir(ctx), Const.HORIZON_FILE)

  /** @throws IllegalArgumentException if [json] is not a usable horizon. */
  fun write(ctx: Context, json: String) {
    val parsed = parse(json) ?: throw IllegalArgumentException("horizon JSON is not parseable")
    if (parsed.schemaVersion != 1) {
      throw IllegalArgumentException("unsupported horizon schemaVersion ${parsed.schemaVersion}")
    }
    AtomicFiles.write(file(ctx), json.toByteArray(Charsets.UTF_8))
    logd("horizon written: ${parsed.rules.size} rules, ${parsed.droppedRules} dropped")
  }

  fun read(ctx: Context): Horizon? {
    val raw = AtomicFiles.readText(file(ctx)) ?: return null
    return parse(raw)
  }

  fun parse(raw: String): Horizon? = try {
    val root = JSONObject(raw)
    val arr = root.optJSONArray("rules")
    val rules = ArrayList<AlarmRule>()
    var dropped = 0
    if (arr != null) {
      for (i in 0 until arr.length()) {
        val r = arr.optJSONObject(i)
        val rule = if (r == null) null else parseRule(r)
        if (rule == null) dropped++ else rules.add(rule)
      }
    }
    Horizon(
      schemaVersion = root.optInt("schemaVersion", 0),
      writtenAtEpoch = root.optLong("writtenAtEpoch", 0L),
      profileId = root.optString("profileId", ""),
      rules = rules,
      droppedRules = dropped
    )
  } catch (t: Throwable) {
    logw("horizon parse failed", t)
    null
  }

  private fun parseRule(o: JSONObject): AlarmRule? {
    val threadId = o.optString("threadId", "")
    val timeLocal = o.optString("timeLocal", "")
    val startedOn = o.optString("startedOn", "")
    // These three are load-bearing: without them an occurrence id cannot be formed and
    // JS could never match the journal record back to a dose. Drop the rule, count it.
    if (threadId.isEmpty() || !TIME_RE.matches(timeLocal) || !DATE_RE.matches(startedOn)) {
      logw("dropping malformed rule: thread='$threadId' time='$timeLocal' start='$startedOn'")
      return null
    }
    val stoppedRaw = o.optString("stoppedOn", "")
    val escalations = ArrayList<Int>()
    o.optJSONArray("escalateAfterMin")?.let { ea ->
      for (i in 0 until ea.length()) {
        val m = ea.optInt(i, -1)
        if (m > 0) escalations.add(m)
      }
    }
    return AlarmRule(
      threadId = threadId,
      medicineId = o.optString("medicineId", ""),
      title = o.optString("title", "Medicine reminder"),
      body = o.optString("body", ""),
      timeLocal = timeLocal,
      daysMask = o.optInt("daysMask", 127),
      intervalDays = o.optInt("intervalDays", 1),
      startedOn = startedOn,
      stoppedOn = if (DATE_RE.matches(stoppedRaw)) stoppedRaw else null,
      channelId = o.optString("channelId", "dose_standard_v1"),
      critical = o.optBoolean("critical", false),
      escalateAfterMin = escalations.sorted()
    )
  }

  /** Whole days since the horizon was written. -1 when there is no horizon at all. */
  fun ageDays(h: Horizon?, nowMillis: Long = System.currentTimeMillis()): Int {
    if (h == null || h.writtenAtEpoch <= 0L) return -1
    val delta = nowMillis - h.writtenAtEpoch
    if (delta < 0) return 0
    return TimeUnit.MILLISECONDS.toDays(delta).toInt()
  }

  fun isStale(h: Horizon?, nowMillis: Long = System.currentTimeMillis()): Boolean {
    val age = ageDays(h, nowMillis)
    return age < 0 || age > Const.HORIZON_STALE_DAYS
  }

  private val TIME_RE = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
  private val DATE_RE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
}
