package ai.autonomous.harness.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Pushes from FCM (Dart: `lib/notify/push_channel.dart`; what they carry:
 * docs/design/2026-11-05-phone-push.md). They are data-only, so this draws each one itself: on the
 * channel the app's own notice of that kind uses, so one switch in the phone's Settings silences
 * both, and under the same id, so a push and the notice the running app posts for the same news
 * replace each other rather than stack.
 */
class PushService : FirebaseMessagingService() {
  // Tokens, not Installation IDs (`onRegistered`): see `pushAddress` in MainActivity.kt.
  @Suppress("OVERRIDE_DEPRECATION")
  override fun onNewToken(token: String) {
    Handler(Looper.getMainLooper()).post { tokenChanged?.invoke() }
  }

  override fun onMessageReceived(message: RemoteMessage) {
    // Signed out (or never signed in here): nothing of any account is drawn.
    if (!enabled(this)) return
    // In front, the app tells it with its own notices, which know what the person is looking at.
    if (inFront) return
    val data = message.data
    val kind = Kind.of(data["kind"]) ?: return
    val title = data["title"]
    if (title.isNullOrEmpty()) return
    val id = when (kind) {
      Kind.SWARM -> data["key"]?.let { noticeId("swarm\n$it") }
      else -> {
        val machine = data["machine"]
        val agent = data["agent"]
        if (machine.isNullOrEmpty() || agent.isNullOrEmpty()) null else noticeId("$machine\n$agent")
      }
    } ?: noticeId("push\n${message.messageId}")
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Made only when the app has not made it yet; the person's own settings for it stay.
      manager.createNotificationChannel(
        NotificationChannel(kind.channel, kind.channelName, NotificationManager.IMPORTANCE_HIGH)
          .apply { description = kind.description }
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, kind.channel)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH)
    }
    builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(data["body"] ?: "")
      .setAutoCancel(true)
      .setContentIntent(opening(id, data))
    data["subtitle"]?.takeIf { it.isNotEmpty() }?.let { builder.setSubText(it) }
    // As the app's own Swarm notice: hidden on a secure lock screen set to hide private content.
    if (kind == Kind.SWARM) builder.setVisibility(Notification.VISIBILITY_PRIVATE)
    manager.notify(id, builder.build())
  }

  /** The app, told which push was tapped: MainActivity hands [data] to Dart over `harness/push`. */
  private fun opening(id: Int, data: Map<String, String>): PendingIntent {
    val intent = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java))
      .apply {
        action = OPEN
        putExtra(DATA, Bundle().apply { for ((key, value) in data) putString(key, value) })
      }
    return PendingIntent.getActivity(
      this,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** The channels of the app's own notices (Dart: `LocalSystemNotices` in lib/notify/system_notices.dart). */
  enum class Kind(val wire: String, val channel: String, val channelName: String, val description: String) {
    SWARM(
      "swarm",
      "swarm-needs-you",
      "Swarm needs you",
      "A Swarm asks you to decide, tags you, or has work waiting on you.",
    ),
    AGENT_QUESTION(
      "agent_question",
      "agent-question",
      "Agent needs you",
      "An agent stopped to ask you something.",
    ),
    AGENT_DONE(
      "agent_done",
      "agent-done",
      "Agent finished",
      "An agent finished its turn while Harness was away.",
    );

    companion object {
      fun of(wire: String?) = entries.firstOrNull { it.wire == wire }
    }
  }

  companion object {
    /** The tap's intent action, and the extra its data rides in. */
    const val OPEN = "ai.autonomous.harness.PUSH_OPEN"
    const val DATA = "push"

    /** Whether the app is on screen (MainActivity's onResume to onPause). */
    @Volatile var inFront = false

    /** Tells Dart, on the main thread, that FCM handed the app a new token. */
    @Volatile var tokenChanged: (() -> Unit)? = null

    private const val PREFS = "harness_push"
    private const val ON = "on"

    /** Set while someone signed in here wants pushes (`harness/push` `address`), cleared by `forget`. */
    fun enabled(context: Context) =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ON, false)

    fun setEnabled(context: Context, on: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ON, on).apply()
    }

    /**
     * Dart's `noticeIdFor` and `swarmNoticeIdFor` (lib/notify/system_notices.dart): FNV-1a over the
     * UTF-16 code units, kept to 31 bits. The same text gives the same id there and here.
     */
    fun noticeId(text: String): Int {
      var hash = 0x811c9dc5L
      for (unit in text) hash = ((hash xor unit.code.toLong()) * 0x01000193L) and 0x7fffffffL
      return hash.toInt()
    }
  }
}
