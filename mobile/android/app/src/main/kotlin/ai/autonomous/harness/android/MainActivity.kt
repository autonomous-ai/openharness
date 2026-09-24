package ai.autonomous.harness.android

import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.io.ByteArrayOutputStream
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

    // `harness/clipboard_image` — the image on the clipboard, as PNG bytes (Dart:
    // `lib/clipboard/native_clipboard.dart`). Flutter's own clipboard reads text only, so a
    // screenshot copied from the share sheet was invisible to Paste. Only `readImagePng` is
    // implemented here, since nothing on the phone writes an image.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/clipboard_image")
      .setMethodCallHandler { call, result ->
        if (call.method != "readImagePng") { result.notImplemented(); return@setMethodCallHandler }
        val uri = clipboardImageUri()
        if (uri == null) { result.success(null); return@setMethodCallHandler }
        // Decoding and re-encoding a camera photo takes long enough to drop frames on the UI thread.
        // The worker holds the application's resolver and the main looper, never this activity, so
        // an activity destroyed mid-decode is neither leaked nor posted to.
        val resolver = applicationContext.contentResolver
        val main = Handler(Looper.getMainLooper())
        Thread {
          // From here an image IS on the clipboard, so a failure answers EMPTY bytes rather than
          // null: Dart then says the image is unreadable instead of that there is nothing to paste.
          val png = readAsPng(resolver, uri) ?: ByteArray(0)
          main.post { result.success(png) }
        }.start()
      }
  }

  /** The first image on the clipboard, or null. The description is checked before any item, so a
   *  text clip is never opened. */
  private fun clipboardImageUri(): Uri? {
    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val clip = try { clipboard.primaryClip } catch (e: Exception) { null } ?: return null
    if (!clip.description.hasMimeType("image/*")) return null
    return (0 until clip.itemCount).firstNotNullOfOrNull { clip.getItemAt(it).uri }
  }

  private companion object {
    const val DECODE_MIN_EDGE = 3200

    /** Reads the image behind [uri] as PNG bytes, or null when it cannot be opened or decoded.
     *
     *  The URI is opened ONCE and read into memory — a clipboard grant from another app is not
     *  guaranteed to serve a second stream — and both decode passes work from those bytes. The
     *  pixels are decoded at a power-of-two reduction that still leaves the long edge above
     *  [DECODE_MIN_EDGE]: Dart scales to at most 1600px again before sending (`transcodeToPng`),
     *  and a full-size photo decoded at native size is tens of megabytes of heap for nothing. */
    fun readAsPng(resolver: ContentResolver, uri: Uri): ByteArray? = try {
      val encoded = resolver.openInputStream(uri)?.use { it.readBytes() }
      if (encoded == null || encoded.isEmpty()) {
        null
      } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(encoded, 0, encoded.size, bounds)
        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longEdge / (sample * 2) >= DECODE_MIN_EDGE) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        BitmapFactory.decodeByteArray(encoded, 0, encoded.size, options)?.let { bitmap ->
          val out = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
          bitmap.recycle()
          out.toByteArray()
        }
      }
    } catch (e: Exception) {
      // A SecurityException for a clip another app no longer grants, a deleted file, a format the
      // platform cannot decode: all of them are "unreadable" to Dart, which says so.
      null
    }
  }
}
