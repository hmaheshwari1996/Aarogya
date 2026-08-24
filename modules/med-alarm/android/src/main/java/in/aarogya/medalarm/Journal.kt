package `in`.aarogya.medalarm

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * The Kotlin → JS event channel.
 *
 * ── ONE COMPLETE FILE PER EVENT. NEVER AN APPEND-ONLY LOG. ────────────────────
 * A shared log means a shared write offset, and a shared write offset between two
 * processes means a race. JS truncating the log while Kotlin appends either corrupts
 * the tail or drops the record entirely — and the record it drops is a "taken", which
 * later prints as a missed dose on a report a doctor reads. Separate files have no
 * shared offset, so there is nothing to race on: Kotlin creates, JS reads and unlinks,
 * and a crash at any instant leaves every other record untouched.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object Journal {

  fun dir(ctx: Context): File =
    File(HorizonStore.dir(ctx), Const.JOURNAL_DIR).also { if (!it.exists()) it.mkdirs() }

  /**
   * Writes one event. Never throws.
   *
   * "Appending to a file cannot fail" is false, and on this app it is dangerously
   * false: it retains prescription and lab photos forever, so a full disk is a
   * realistic Tuesday, not a thought experiment. The entire architecture rests on this
   * write succeeding, so when it does not, the user is told — immediately, on
   * system_v1 — rather than discovering three weeks later that adherence has been
   * quietly recording nothing.
   */
  fun write(
    ctx: Context,
    occId: String,
    threadId: String,
    medicineId: String,
    event: String,
    origin: String,
    payload: JSONObject? = null,
    atEpoch: Long = System.currentTimeMillis()
  ) {
    try {
      val record = JSONObject().apply {
        put("occurrenceId", occId)
        put("threadId", threadId)
        put("medicineId", medicineId)
        put("event", event)
        put("atEpoch", atEpoch)
        put("origin", origin)
        if (payload != null) put("payload", payload)
      }
      val target = uniqueFile(dir(ctx), occId, event, atEpoch)
      AtomicFiles.write(target, record.toString().toByteArray(Charsets.UTF_8))
      logd("journal <- $event ${target.name}")
    } catch (io: IOException) {
      logw("journal write failed ($event $occId)", io)
      Notifications.postJournalWriteFailure(ctx)
    } catch (t: Throwable) {
      // SecurityException from a locked profile, OOM, anything. Same contract: be loud.
      logw("journal write failed hard ($event $occId)", t)
      Notifications.postJournalWriteFailure(ctx)
    }
  }

  /** Convenience for events with no occurrence — reboots, receiver crashes. */
  fun writeSystem(ctx: Context, event: String, payload: JSONObject? = null) {
    // A sentinel that is deliberately NOT shaped like an occurrence id, so
    // parseOccurrenceId() in JS returns null instead of inventing a thread.
    write(ctx, SYSTEM_OCC_ID, "", "", event, "native", payload)
  }

  const val SYSTEM_OCC_ID = "system"

  /**
   * Every pending record, as JSON strings.
   *
   * Each returned string is the on-disk record plus a `fileName` field. JS needs the
   * name to unlink the record after ingesting it, and injecting it at read time keeps
   * the file on disk a pure [JournalRecord] — no bookkeeping field that could ever be
   * mistaken for domain data.
   */
  fun list(ctx: Context): List<String> {
    val files = dir(ctx).listFiles() ?: return emptyList()
    return files
      .filter { it.isFile && it.name.endsWith(".json") && !it.name.startsWith(".") }
      .sortedBy { it.name }
      .mapNotNull { f ->
        val raw = AtomicFiles.readText(f) ?: return@mapNotNull null
        try {
          JSONObject(raw).put("fileName", f.name).toString()
        } catch (t: Throwable) {
          // A record that cannot be parsed can never be ingested, and leaving it on disk
          // would make the drain loop spin on it forever. Surface it as a readable
          // error record instead of deleting evidence.
          logw("unreadable journal record ${f.name}", t)
          JSONObject()
            .put("occurrenceId", SYSTEM_OCC_ID)
            .put("threadId", "")
            .put("medicineId", "")
            .put("event", "receiver_error")
            .put("atEpoch", f.lastModified())
            .put("origin", "native")
            .put("payload", JSONObject().put("reason", "unparseable_record").put("file", f.name))
            .put("fileName", f.name)
            .toString()
        }
      }
  }

  /** @return how many files were actually removed. */
  fun delete(ctx: Context, names: List<String>): Int {
    val d = dir(ctx)
    var n = 0
    for (name in names) {
      // JS supplies these names, but they arrive as strings and a traversal here would
      // let a bug delete arbitrary app files. Reject anything with a path separator.
      if (name.isEmpty() || name.contains('/') || name.contains('\\') || name.contains("..")) {
        logw("refusing to delete suspicious journal name: $name")
        continue
      }
      val f = File(d, name)
      if (f.exists() && f.parentFile?.absolutePath == d.absolutePath && f.delete()) n++
    }
    return n
  }

  fun pendingCount(ctx: Context): Int =
    dir(ctx).listFiles()?.count { it.isFile && it.name.endsWith(".json") } ?: 0

  /**
   * `<occId>-<event>-<epochMs>.json`, with colons replaced.
   *
   * Colons are legal on ext4/f2fs, which is where filesDir always lives, but they are
   * not legal everywhere an engineer will later copy this directory (`adb pull` onto a
   * Windows machine, a FAT-formatted SD card, a zip). The authoritative occurrence id
   * is inside the file; the name only has to be unique and greppable.
   */
  private fun uniqueFile(dir: File, occId: String, event: String, atEpoch: Long): File {
    val safeOcc = occId.replace(':', '_').replace(Regex("[^A-Za-z0-9_.-]"), "_")
    var stamp = atEpoch
    var f = File(dir, "$safeOcc-$event-$stamp.json")
    // Two events for the same occurrence in the same millisecond is close to impossible
    // (all writes are serialised on one thread) but a collision would silently discard
    // one of them, so step the stamp rather than overwrite.
    var guard = 0
    while (f.exists() && guard < 1000) {
      stamp++
      guard++
      f = File(dir, "$safeOcc-$event-$stamp.json")
    }
    return f
  }
}
