package ai.autonomous.harness.android

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
  }
}
