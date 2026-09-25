package ai.autonomous.harness.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Keeps this process out of Android's freezer while the app is in another app's shadow, so the
 * machine socket survives being switched away from.
 *
 * WHY THIS EXISTS AT ALL. A backgrounded app becomes a "cached" process, and Android freezes cached
 * processes — measured on a Pixel 8 Pro at around 30 seconds. A frozen process runs no code, so it
 * cannot answer the backend's liveness ping, and the backend drops a client that has been silent
 * past its deadline (`CLIENT_IDLE_DEADLINE_MS` in `backend/src/lib/hub.ts`). Coming back then costs
 * a full redial: socket, machine select, E2EE handshake, desk read, terminal re-attach. A process
 * holding a foreground service is not cached, so none of that happens.
 *
 * WHAT IT COSTS. A notification, for as long as the hold lasts. That is not a design choice — it is
 * the bargain Android offers for running while out of sight, and there is no version of this without
 * it. The channel is IMPORTANCE_LOW so it never makes a sound, and the hold is taken only on the way
 * out and dropped on the way back, so the notification is gone whenever the app is on screen.
 *
 * WHY THE HOLD EXPIRES. [EXTRA_LIMIT_MS] stops this outliving its purpose. The complaint it answers
 * is switching apps for a minute; a phone put in a pocket for the afternoon does not need its socket
 * held, and holding it anyway would burn the `dataSync` allowance Android 14 caps at six hours a day
 * — with the notification sitting there the whole time. Past the limit the service lets go, the app
 * is frozen like any other, and coming back costs the ordinary reconnect it always did.
 */
class AwakeService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var expiry: Runnable? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Promoted before anything else: Android gives a started service a few seconds to call this and
    // kills the app with an ANR-like crash if it does not.
    promote()
    // A second hold replaces the first one's clock rather than adding to it.
    expiry?.let(handler::removeCallbacks)
    val limitMs = intent?.getLongExtra(EXTRA_LIMIT_MS, DEFAULT_LIMIT_MS) ?: DEFAULT_LIMIT_MS
    val stop = Runnable { stopSelf() }
    expiry = stop
    handler.postDelayed(stop, limitMs)
    // Deliberately NOT sticky. Android restarting this on its own would put the notification back
    // with no app awake to release it.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    expiry?.let(handler::removeCallbacks)
    expiry = null
    super.onDestroy()
  }

  private fun promote() {
    channel()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification())
    }
  }

  private fun channel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Staying connected",
      // Low, not MIN: a MIN channel is collapsed into the status bar without a line in the shade,
      // which reads as the app hiding what it is doing. Low is silent but says so plainly.
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.description =
      "Shown while Harness holds your machine connection open in the background."
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  private fun notification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    return builder
      .setContentTitle("Harness is connected")
      .setContentText("Keeping your machine reachable while you are in another app")
      // A platform icon: the app ships no monochrome notification drawable, and a launcher mipmap
      // used here is drawn as a white blob on anything since Lollipop.
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentIntent(open)
      .setOngoing(true)
      // No timestamp: "3 minutes ago" on a notice about right now reads as a stale one.
      .setShowWhen(false)
      .build()
  }

  companion object {
    const val ACTION_HOLD = "ai.autonomous.harness.android.HOLD"
    const val EXTRA_LIMIT_MS = "limitMs"

    /** Long enough for an errand in another app, short enough not to outlive one. */
    const val DEFAULT_LIMIT_MS = 10L * 60L * 1000L

    private const val CHANNEL_ID = "harness_awake"
    private const val NOTIFICATION_ID = 0x48524E53
  }
}
