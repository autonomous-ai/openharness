package ai.autonomous.harness.android

import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessagingService

/**
 * FCM's side of push (Dart: `lib/notify/push_channel.dart`). The server sends a notification
 * message (backend/src/push/fcm.ts): while the app is away Android draws it on the app's Swarm
 * channel, and its tap reaches MainActivity's `receivePush`; while the app is in front it comes to
 * `onMessageReceived`, which draws nothing, as the app tells it with its own notices.
 */
class PushService : FirebaseMessagingService() {
  // Tokens, not Installation IDs (`onRegistered`): see `pushAddress` in MainActivity.kt.
  @Suppress("OVERRIDE_DEPRECATION")
  override fun onNewToken(token: String) {
    Handler(Looper.getMainLooper()).post { tokenChanged?.invoke() }
  }

  companion object {
    /** The extra FCM sets on the tap of a notification it drew. */
    const val MESSAGE_ID = "google.message_id"

    /** The push's own data the server sends, and all Dart is given of a tapped push. */
    val KEYS = listOf("key", "link")

    /** Tells Dart, on the main thread, that FCM handed the app a new token. */
    @Volatile var tokenChanged: (() -> Unit)? = null
  }
}
