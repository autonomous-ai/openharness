package ai.autonomous.harness.android

import android.content.Intent
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
  override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
    super.configureFlutterEngine(flutterEngine)
    // `harness/device_name` — what this phone is called, for the far side's "took control" banner
    // (Dart: `lib/core/device_name.dart`). `name` is the one the person set under Settings ▸ About
    // ("Galaxy S23 of Hieu"); null on a ROM that keeps it, and Dart then falls back to the model.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/device_name")
      .setMethodCallHandler { call, result ->
        if (call.method != "describe") { result.notImplemented(); return@setMethodCallHandler }
        val name = try { Settings.Global.getString(contentResolver, "device_name") } catch (e: Exception) { null }
        result.success(
          mapOf(
            "name" to name,
            "model" to Build.MODEL,
            "modelCode" to Build.DEVICE,
            "manufacturer" to Build.MANUFACTURER,
          )
        )
      }

    // `harness/awake` — hold the process out of Android's freezer while the app is off screen, so
    // the machine socket is still there on the way back (Dart: `lib/core/background_hold.dart`).
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/awake")
      .setMethodCallHandler { call, result ->
        when (call.method) {
          "hold" -> result.success(hold(call.argument<Int>("limitMs")))
          "release" -> { releaseHold(); result.success(true) }
          else -> result.notImplemented()
        }
      }
  }

  /** True when the hold was taken. False is a normal answer, not an error — see below. */
  private fun hold(limitMs: Int?): Boolean {
    val intent = Intent(this, AwakeService::class.java).setAction(AwakeService.ACTION_HOLD)
    if (limitMs != null && limitMs > 0) {
      intent.putExtra(AwakeService.EXTRA_LIMIT_MS, limitMs.toLong())
    }
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
      else startService(intent)
      true
    } catch (e: Exception) {
      // ⚠️ **Swallowed on purpose, and this is the one place it can happen.** Since Android 12 a
      // foreground service may not be STARTED from the background, and the answer to "is this app
      // in the background yet" belongs to the system, not to us: Dart asks on its way out, which is
      // `onPause` — an activity still visible, and so still allowed — but a hold taken a moment too
      // late throws `ForegroundServiceStartNotAllowedException`. Losing the hold means the socket
      // drops and is redialled, which is exactly what happened before this existed. Crashing the app
      // over it would be the far worse failure.
      false
    }
  }

  // ⚠️ `stopService`, not a RELEASE intent. Sending an intent would START the service in order to
  // tell it to stop — which means a release with nothing to release leaves a service behind for a
  // moment, one that never called `startForeground`. Stopping something not running is a no-op.
  private fun releaseHold() {
    try {
      stopService(Intent(this, AwakeService::class.java))
    } catch (e: Exception) {
      // Nothing to release, or the service is already gone.
    }
  }
}
