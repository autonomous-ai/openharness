package ai.autonomous.harness.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * FCM's service (task #2905). A push the server sends for a thread reply or a tag is a notification Android draws by
 * itself while the app is closed; one that arrives while the app is in front comes to [onMessageReceived] instead and is
 * drawn by nobody, since the app's own notices decide there. A new token goes to Dart.
 */
class PushService : FirebaseMessagingService() {
  override fun onNewToken(token: String) = PushChannel.tokenChanged(token)
}

/**
 * `harness/push` (Dart: `lib/notify/push_registration.dart`): `token` (`{platform: android, token}`, or null on a build
 * without Firebase), `delivered` (the tag of each of our pushes still shown, the notice's key) and `launchLink` (the
 * `link` of the push whose tap launched the app, held until asked). Dart is told `token` when FCM hands out a new one and
 * `opened` (`{link}`) when a push is tapped while it listens.
 */
object PushChannel {
  /** The channel of the app's Swarm notices (flutter_local_notifications' `swarm-needs-you` in system_notices.dart). */
  private const val SWARM_CHANNEL = "swarm-needs-you"

  private val main = Handler(Looper.getMainLooper())
  private var channel: MethodChannel? = null
  private var launchLink: String? = null
  private var listening = false

  fun attach(context: Context, messenger: BinaryMessenger) {
    // Made here as well, so a push that comes before the app's first Swarm notice lands in it, not in "Miscellaneous".
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val notices = context.getSystemService(NotificationManager::class.java)
      if (notices.getNotificationChannel(SWARM_CHANNEL) == null) {
        notices.createNotificationChannel(NotificationChannel(SWARM_CHANNEL, "Swarm needs you", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "A Swarm asks you to decide, tags you, or has work waiting on you."
          lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
        })
      }
    }
    channel = MethodChannel(messenger, "harness/push").also {
      it.setMethodCallHandler { call, result ->
        when (call.method) {
          "token" -> token(result)
          "delivered" -> result.success(
            context.getSystemService(NotificationManager::class.java).activeNotifications
              .mapNotNull { shown -> shown.tag?.takeIf { tag -> tag.startsWith("reply:") || tag.startsWith("mention:") } }
          )
          "launchLink" -> {
            listening = true
            result.success(launchLink)
            launchLink = null
          }
          else -> result.notImplemented()
        }
      }
    }
  }

  private fun token(result: MethodChannel.Result) {
    val messaging = try {
      FirebaseMessaging.getInstance()
    } catch (e: IllegalStateException) {
      // No google-services.json in this build (app/build.gradle.kts): no Firebase app, so no push.
      Log.w("push", "no Firebase app in this build: push is off")
      result.success(null)
      return
    }
    messaging.token.addOnCompleteListener { task ->
      if (task.isSuccessful) {
        result.success(mapOf("platform" to "android", "token" to task.result))
      } else {
        Log.w("push", "no FCM token", task.exception)
        result.success(null)
      }
    }
  }

  fun tokenChanged(token: String) {
    main.post { channel?.invokeMethod("token", mapOf("platform" to "android", "token" to token)) }
  }

  /** A tapped push opens the app with its data as extras. */
  fun tapped(intent: Intent?) {
    val link = intent?.getStringExtra("link") ?: return
    // Reopened from Recents, Android hands back the intent that first started the app: that push was opened then.
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
    intent.removeExtra("link")
    if (listening) channel?.invokeMethod("opened", mapOf("link" to link)) else launchLink = link
  }
}
