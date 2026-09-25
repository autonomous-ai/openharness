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
    /** The long edge a clipboard image leaves here at, at most: `_preferredMaxEdge` in Dart's
     *  `lib/terminal/image_transcode.dart`, which every picture is scaled to before it is sent. */
    const val MAX_EDGE = 1600

    /** Reads the image behind [uri] as PNG bytes no longer than [MAX_EDGE] on either edge, or null
     *  when it cannot be opened or decoded.
     *
     *  The URI is opened ONCE and read into memory — a clipboard grant from another app is not
     *  guaranteed to serve a second stream — and both decode passes work from those bytes.
     *
     *  ⚠️ **Scaled HERE, not left to Dart.** PNG is lossless, so a 4000x3000 photo at full size is
     *  20–40 MB of PNG, all of it copied over the method channel only for `transcodeToPng` to
     *  throw most of it away. The pixels are decoded at the largest power-of-two reduction that
     *  keeps the long edge at or above [MAX_EDGE] (so a 12MP photo is never rasterised whole), then
     *  scaled the rest of the way, so what crosses the channel is the size Dart would send anyway
     *  and its transcode finds nothing left to shrink. Not the original encoded bytes instead:
     *  `readImagePng` promises PNG, and the terminal panel's ⌘V sends what it returns as-is. */
    fun readAsPng(resolver: ContentResolver, uri: Uri): ByteArray? = try {
      val encoded = resolver.openInputStream(uri)?.use { it.readBytes() }
      if (encoded == null || encoded.isEmpty()) {
        null
      } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(encoded, 0, encoded.size, bounds)
        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longEdge / (sample * 2) >= MAX_EDGE) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        BitmapFactory.decodeByteArray(encoded, 0, encoded.size, options)?.let { decoded ->
          val bitmap = scaledToMaxEdge(decoded)
          if (bitmap !== decoded) decoded.recycle()
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

    /** [bitmap] itself when it already fits [MAX_EDGE], else a copy scaled down to it with the
     *  aspect kept. */
    fun scaledToMaxEdge(bitmap: Bitmap): Bitmap {
      val longEdge = maxOf(bitmap.width, bitmap.height)
      if (longEdge <= MAX_EDGE) return bitmap
      val scale = MAX_EDGE.toFloat() / longEdge
      val width = (bitmap.width * scale).toInt().coerceAtLeast(1)
      val height = (bitmap.height * scale).toInt().coerceAtLeast(1)
      return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }
  }
}
