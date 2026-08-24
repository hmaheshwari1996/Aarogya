package `in`.aarogya.medalarm

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * Deep links into the OEM "autostart" / "background start" screens.
 *
 * ── READ THIS BEFORE ADDING ANYTHING HERE ─────────────────────────────────────
 * There is NO Android API to read whether autostart is enabled for your app, and NO
 * permission you can request to turn it on. None. Not hidden, not reflective, not
 * @SystemApi — the state lives in a per-OEM database that ships with the ROM's own
 * security app. The only thing an app can do is *navigate the user to the screen* and
 * explain what to tap. Do not spend an afternoon looking for the getter; it does not
 * exist. This is also why the health check reports autostart as "cannot verify" rather
 * than as a pass or a fail.
 *
 * Every component below is undocumented, differs between ROM versions on the SAME
 * manufacturer, and disappears without notice. So: resolveActivity() first, try/catch
 * around the launch, and a fall back to the app's own details page, which always exists.
 * A crash here would be absurd — it is a help screen.
 *
 * Package visibility (Android 11+) means resolveActivity() returns null for a package we
 * have not declared in <queries>. plugins/withAlarmReceivers.js declares every package
 * named here; adding a candidate without adding its <queries> entry makes it silently
 * unreachable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
internal object OemSettings {

  private data class Candidate(val pkg: String, val cls: String)

  /**
   * Ordered per manufacturer. Newer ROM component first, older variant after — the
   * ColorOS pair below is the classic example: Realme and Oppo shipped the same screen
   * under two different class names in adjacent releases.
   */
  private val BY_MANUFACTURER: Map<String, List<Candidate>> = mapOf(
    // MIUI / HyperOS
    "xiaomi" to listOf(
      Candidate("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
    ),
    "redmi" to listOf(
      Candidate("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
    ),
    "poco" to listOf(
      Candidate("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
    ),
    // ColorOS (Oppo) and Realme UI
    "oppo" to listOf(
      Candidate("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
      Candidate("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
      Candidate("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
      Candidate("com.coloros.safecenter", "com.coloros.privacypermissionsentry.PermissionTopActivity")
    ),
    "realme" to listOf(
      Candidate("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
      Candidate("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
      Candidate("com.coloros.safecenter", "com.coloros.privacypermissionsentry.PermissionTopActivity")
    ),
    // Funtouch / OriginOS
    "vivo" to listOf(
      Candidate("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
      Candidate("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
      Candidate("com.iqoo.secure", "com.iqoo.secure.safeguard.PurviewTabActivity")
    ),
    "iqoo" to listOf(
      Candidate("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
      Candidate("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")
    ),
    // One UI. Samsung has no autostart list; the equivalent is per-app battery usage,
    // where "Unrestricted" is what a dose alarm needs.
    "samsung" to listOf(
      Candidate("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
      Candidate("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
      Candidate("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity")
    ),
    // EMUI / HarmonyOS
    "huawei" to listOf(
      Candidate("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
      Candidate("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
      Candidate("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
    ),
    "honor" to listOf(
      Candidate("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
      Candidate("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity")
    ),
    // OxygenOS. Recent versions are ColorOS underneath, hence both sets.
    "oneplus" to listOf(
      Candidate("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
      Candidate("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
    ),
    // Evenwell power saver, shipped on Nokia/HMD and some Asus devices.
    "nokia" to listOf(
      Candidate("com.evenwell.powersaving.g3", "com.evenwell.powersaving.g3.exception.PowerSaverExceptionActivity")
    ),
    "asus" to listOf(
      Candidate("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"),
      Candidate("com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity")
    ),
    "letv" to listOf(
      Candidate("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")
    ),
    "meizu" to listOf(
      Candidate("com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC")
    )
  )

  /**
   * @return true if an OEM-specific screen actually opened. False means the user landed
   *         on the generic app-details page instead, and the UI should say so rather
   *         than claiming success.
   */
  fun openAutostart(ctx: Context, activity: Activity?): Boolean {
    val manufacturer = (Build.MANUFACTURER ?: "").lowercase()
    val brand = (Build.BRAND ?: "").lowercase()

    val candidates = LinkedHashSet<Candidate>()
    BY_MANUFACTURER[manufacturer]?.let { candidates.addAll(it) }
    BY_MANUFACTURER[brand]?.let { candidates.addAll(it) }
    // Some devices report an unexpected MANUFACTURER (rebadged ODM hardware), so after
    // the targeted attempts we simply try everything. A resolveActivity() miss is free.
    BY_MANUFACTURER.values.forEach { candidates.addAll(it) }

    for (c in candidates) {
      if (tryStart(ctx, activity, Intent().setComponent(ComponentName(c.pkg, c.cls)))) {
        logd("opened OEM autostart screen ${c.pkg}/${c.cls}")
        return true
      }
    }

    logw("no OEM autostart screen resolved for '$manufacturer'; falling back to app details")
    openAppDetails(ctx, activity)
    return false
  }

  /**
   * Battery-optimisation exemption.
   *
   * The direct "please exempt me" dialog needs REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
   * which only the personal build declares (Play restricts it). Without the permission
   * we open the system list instead, which needs nothing and lets the user do it by hand.
   */
  fun openBatterySettings(ctx: Context, activity: Activity?) {
    val app = ctx.applicationContext
    val hasDirectRequest = try {
      app.packageManager.getPackageInfo(app.packageName, android.content.pm.PackageManager.GET_PERMISSIONS)
        .requestedPermissions
        ?.contains("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS") == true
    } catch (t: Throwable) {
      false
    }

    if (hasDirectRequest) {
      val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${app.packageName}"))
      if (tryStart(ctx, activity, direct)) return
    }
    if (tryStart(ctx, activity, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return
    openAppDetails(ctx, activity)
  }

  /** The Android 12+ "Alarms & reminders" toggle. Only meaningful on the Play build. */
  fun openExactAlarmSettings(ctx: Context, activity: Activity?) {
    val app = ctx.applicationContext
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val i = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
        .setData(Uri.parse("package:${app.packageName}"))
      if (tryStart(ctx, activity, i)) return
    }
    openAppDetails(ctx, activity)
  }

  /** Always resolvable. The last stop for every path in this file. */
  fun openAppDetails(ctx: Context, activity: Activity?) {
    val app = ctx.applicationContext
    val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      .setData(Uri.parse("package:${app.packageName}"))
    if (!tryStart(ctx, activity, i)) {
      logw("could not even open app details — giving up")
    }
  }

  private fun tryStart(ctx: Context, activity: Activity?, intent: Intent): Boolean {
    return try {
      val app = ctx.applicationContext
      // resolveActivity() before startActivity(): launching an unresolvable explicit
      // component throws ActivityNotFoundException, and these components are guesses.
      if (intent.resolveActivity(app.packageManager) == null) return false
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        // No Activity in hand (called from a background context) — a new task is required
        // or the launch is rejected outright.
        app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (t: Throwable) {
      logw("could not start ${intent.component ?: intent.action}", t)
      false
    }
  }
}
