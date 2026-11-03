package ai.autonomous.harness.android

import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiNetworkSpecifier
import android.os.PatternMatcher
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import io.flutter.FlutterInjector
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
    // screenshot copied from the share sheet was invisible to Paste. Only `readImagePng` and
    // `hasImage` are implemented here, since nothing on the phone writes an image.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/clipboard_image")
      .setMethodCallHandler { call, result ->
        // Whether an image is there, for the key strip's `paste` (Dart:
        // `phone/terminal_key_bar.dart`), which is asked about every second while the keyboard is
        // up. Read off the clip's DESCRIPTION alone: opening the clip itself is what Android 12+
        // tells the person about, with its "pasted from your clipboard" toast.
        if (call.method == "hasImage") {
          result.success(clipboardHasImage())
          return@setMethodCallHandler
        }
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

    // `harness/app_task` — what the app asks of its own activity.
    //
    // `moveToBack`: "Exit" in the question back asks at the app's root (Dart:
    // `lib/phone/exit_app.dart`). The task goes to the background, as the system's own back does at
    // a launcher activity since Android 12, rather than being finished: the engine and its sockets
    // stay up, and opening the app again lands where it was. False when the task did not move, and
    // Dart then falls back to `SystemNavigator.pop`.
    //
    // `openSettings`: this app's App info screen, where a camera permission refused for good is
    // turned back on (Dart: `lib/core/app_settings.dart`). False when no activity takes the intent.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/app_task")
      .setMethodCallHandler { call, result ->
        when (call.method) {
          "moveToBack" -> result.success(moveTaskToBack(true))
          "openSettings" -> {
            val intent = Intent(
              Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
              Uri.fromParts("package", packageName, null),
            )
            result.success(
              try {
                startActivity(intent)
                true
              } catch (e: ActivityNotFoundException) {
                false
              }
            )
          }
          else -> result.notImplemented()
        }
      }

    // `harness/chime` — a short sound the app plays of its own (Dart: `lib/core/chime.dart`): the
    // two glass notes when a computer joins during the onboarding. `play` takes the Flutter asset's
    // name and answers whether it played.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/chime")
      .setMethodCallHandler { call, result ->
        if (call.method != "play") { result.notImplemented(); return@setMethodCallHandler }
        val asset = call.arguments as? String
        result.success(asset != null && playChime(asset))
      }

    // `harness/setup_wifi` — joining a new device's setup hotspot (Dart:
    // `lib/phone/add_device/setup_hotspot.dart`). `join` asks Android for any open Wi-Fi named
    // `Harness-…`; Android shows its own sheet listing those nearby and the person picks one.
    // The app's traffic is then bound to that Wi-Fi — it has no Internet, and Android would
    // otherwise send 10.42.0.1 over mobile data. `leave` drops it, and the phone
    // returns to its own Wi-Fi by itself.
    MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/setup_wifi")
      .setMethodCallHandler { call, result ->
        when (call.method) {
          "join" -> {
            val prefix = call.argument<String>("prefix") ?: "Harness-"
            joinSetupWifi(prefix, result)
          }
          "leave" -> { leaveSetupWifi(); result.success(true) }
          else -> result.notImplemented()
        }
      }

    // `harness/links` — the message links (`harness://swarm/<tab>/<conversation>/<message>`,
    // Desktop's Copy link to message) this phone was asked to open (Dart: `SwarmLinkChannel` in
    // `lib/swarm/swarm_message_link.dart`). Each waits here until Dart's `take` answers it, so one
    // that launched the app, or came before sign-in, waits for the signed-in screen to ask;
    // `arrived` tells a listening Dart that more wait. At most 20 wait, the newest kept.
    links = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "harness/links").also {
      it.setMethodCallHandler { call, result ->
        if (call.method != "take") { result.notImplemented(); return@setMethodCallHandler }
        result.success(ArrayList(waitingLinks))
        waitingLinks.clear()
      }
    }
    receiveLink(intent)
  }

  private var links: MethodChannel? = null
  private val waitingLinks = mutableListOf<String>()

  // singleTop: a link opened while the app runs comes here, not to a new activity.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receiveLink(intent)
  }

  private fun receiveLink(intent: Intent?) {
    if (intent == null) return
    val data = intent.data ?: return
    // Reopened from Recents, Android hands back the intent that first started the app: that link
    // was opened then.
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    if (intent.action != Intent.ACTION_VIEW || data.scheme != "harness" || data.host != "swarm") return
    waitingLinks.add(data.toString())
    while (waitingLinks.size > 20) waitingLinks.removeAt(0)
    links?.invokeMethod("arrived", null)
  }

  private var setupNetwork: ConnectivityManager.NetworkCallback? = null

  private fun joinSetupWifi(prefix: String, result: MethodChannel.Result) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { result.success(mapOf("state" to "unsupported")); return }
    leaveSetupWifi()
    val connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsidPattern(PatternMatcher(prefix, PatternMatcher.PATTERN_PREFIX))
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    val main = Handler(Looper.getMainLooper())
    var answered = false
    fun answer(value: Map<String, String?>) = main.post { if (!answered) { answered = true; result.success(value) } }
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        connectivity.bindProcessToNetwork(network)
        // The address the device's hotspot gave this phone, for the page to show it is through.
        val address = connectivity.getLinkProperties(network)?.linkAddresses
          ?.firstOrNull { it.address is Inet4Address }?.address?.hostAddress
        answer(mapOf("state" to "joined", "address" to address))
      }
      override fun onUnavailable() { setupNetwork = null; answer(mapOf("state" to "unavailable")) }
      override fun onLost(network: Network) { connectivity.bindProcessToNetwork(null) }
    }
    setupNetwork = callback
    // The sheet waits on the person; give up after two minutes.
    connectivity.requestNetwork(request, callback, 120_000)
  }

  private fun leaveSetupWifi() {
    val callback = setupNetwork ?: return
    setupNetwork = null
    val connectivity = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    connectivity.bindProcessToNetwork(null)
    try { connectivity.unregisterNetworkCallback(callback) } catch (e: IllegalArgumentException) {}
  }

  /** Plays the Flutter asset [asset] once, as a sonification — the system's own sounds' stream —
   *  and only while the ringer is on: muted means silent, and the haptic Dart plays beside it is
   *  felt either way. False when it did not play. The player lets itself go when it finishes. */
  private fun playChime(asset: String): Boolean {
    val audio = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
    if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) return false
    val key = FlutterInjector.instance().flutterLoader().getLookupKeyForAsset(asset)
    val player = MediaPlayer()
    return try {
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
      )
      // A WAV is stored uncompressed in the APK, so it opens as a descriptor into it.
      assets.openFd(key).use { fd -> player.setDataSource(fd.fileDescriptor, fd.startOffset, fd.length) }
      player.setOnCompletionListener { it.release() }
      player.setOnErrorListener { failed, _, _ -> failed.release(); true }
      player.prepare()
      player.start()
      true
    } catch (e: Exception) {
      player.release()
      false
    }
  }

  /** Whether the clipboard holds an image, from its description alone — the clip is never opened. */
  private fun clipboardHasImage(): Boolean {
    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
    val description = try { clipboard.primaryClipDescription } catch (e: Exception) { null }
    return description?.hasMimeType("image/*") == true
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
