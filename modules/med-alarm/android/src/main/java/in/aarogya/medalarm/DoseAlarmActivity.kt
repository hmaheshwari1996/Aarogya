package `in`.aarogya.medalarm

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView

/**
 * The full-screen alarm, for every dose that rings — `critical` and `standard`.
 *
 * ── IT DOES NOT MAKE THE SOUND ────────────────────────────────────────────────
 * [AlarmPlayer] is started by [DoseAlarmReceiver] before this activity can exist, and it
 * keeps ringing whether or not this screen is ever shown. That matters because Android 14
 * denies USE_FULL_SCREEN_INTENT by default and, even when it is granted, substitutes a
 * heads-up notification whenever the phone is unlocked and in use. If the ringing lived
 * here, the alarm would be silent in precisely the case where the phone is in the user's
 * hand. This activity only ever STOPS the sound — through [DoseActions], like every other
 * answer, and once more in [onDestroy] as the catch-all for "this screen went away".
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── NO REACT NATIVE HERE. ON PURPOSE. ─────────────────────────────────────────
 * A full-screen intent fires when the phone is locked and the screen is off, from a
 * process that has usually been dead for hours. Routing that through the RN bridge means
 * SoLoader, the JS bundle, Hermes, the React tree and the router all cold-starting behind
 * a lock screen — several seconds of blank white while an insulin reminder is supposedly
 * on screen. Some of those seconds land after the user has already picked the phone up
 * and put it down again.
 *
 * So this Activity is plain Kotlin over a plain XML layout: it inflates in milliseconds,
 * needs nothing initialised, and its two buttons write to the SAME journal path the
 * notification actions use ([DoseActions]), so a dose recorded here is indistinguishable
 * from one recorded anywhere else.
 *
 * It is only reached when [Notifications.canUseFullScreenIntent] is true. When Android 14+
 * denies the permission, setFullScreenIntent() degrades to a heads-up notification and
 * this class is simply never launched — the reminder still arrives, and still rings.
 *
 * Declared `standard` launch mode (see plugins/withAlarmReceivers.js), so two medicines
 * due at the same minute produce two screens rather than one screen that silently
 * replaces the other's contents. [AlarmPlayer] reference-counts by occurrence for the
 * same reason: answering one of those two must not silence the other.
 * ─────────────────────────────────────────────────────────────────────────────
 */
class DoseAlarmActivity : Activity() {

  private var spec: AlarmSpec? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    showOverLockScreen()
    setContentView(R.layout.med_alarm_activity_dose)

    val s = AlarmSpec.fromIntent(intent)
    spec = s

    val titleView = findViewById<TextView>(R.id.med_alarm_title)
    val bodyView = findViewById<TextView>(R.id.med_alarm_body)
    val timeView = findViewById<TextView>(R.id.med_alarm_time)
    val takenButton = findViewById<Button>(R.id.med_alarm_taken)
    val snoozeButton = findViewById<Button>(R.id.med_alarm_snooze)

    snoozeButton.text = getString(R.string.med_alarm_action_snooze, Const.SNOOZE_MINUTES)

    if (s == null) {
      // Should be unreachable — but a full-screen activity with no content, sitting over
      // the lock screen with no way to dismiss it, is the worst possible bug to ship.
      titleView.text = getString(R.string.med_alarm_unknown_title)
      bodyView.text = getString(R.string.med_alarm_unknown_body)
      timeView.text = ""
      takenButton.setOnClickListener { finish() }
      snoozeButton.setOnClickListener { finish() }
      return
    }

    titleView.text = s.title
    bodyView.text = s.body
    timeView.text = s.timeLocal

    takenButton.setOnClickListener {
      // Dismiss the screen immediately and do the disk work on the shared IO thread. The
      // person has answered; making them watch a spinner while a 200-byte file is
      // fsynced would be gratuitous, and the write is already crash-safe on its own.
      Bg.exec.execute { DoseActions.taken(applicationContext, s, "native") }
      finish()
    }

    snoozeButton.setOnClickListener {
      Bg.exec.execute { DoseActions.snooze(applicationContext, s, "native") }
      finish()
    }
  }

  /**
   * The three things that make an alarm screen appear on a locked, sleeping phone.
   * setShowWhenLocked/setTurnScreenOn arrived in API 27; on API 26 the equivalent window
   * flags are the only option (they are deprecated later, hence the split).
   */
  private fun showOverLockScreen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      )
    }
    // Keeps the screen on while the alarm is up. Released automatically on finish().
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  /**
   * Back must not silently dismiss a critical dose without leaving a trace. Treating it
   * as a dismissal (rather than ignoring it, or trapping the user) keeps the "she saw it"
   * signal that the catch-up card depends on.
   */
  @Deprecated("Framework callback deprecated in API 33; the AndroidX predictive-back API is not available in a plain android.app.Activity")
  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    val s = spec
    if (s != null) Bg.exec.execute { DoseActions.dismissed(applicationContext, s, "native") }
    super.onBackPressed()
  }

  /**
   * The catch-all stop.
   *
   * The three deliberate exits (Taken, Snooze, Back) already stop the sound through
   * [DoseActions]. This covers the ones that are not decisions about the medicine: Home,
   * the power button, `android:noHistory` finishing the activity when it leaves the
   * foreground. In all of them the person is holding the phone and has moved away from
   * this screen, so leaving it ringing at them would be indefensible — and unlike the
   * three above, none of them is an outcome worth writing to the journal.
   *
   * Idempotent, so the double call on the Taken/Snooze/Back paths costs nothing.
   */
  override fun onDestroy() {
    spec?.let { AlarmPlayer.stop(it.occId) }
    super.onDestroy()
  }
}
