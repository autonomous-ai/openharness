package ai.autonomous.harness.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Where "Continue with Google / Apple" comes back to the app on Android (Dart:
 * `lib/viewer/direct_login.dart`, `lib/viewer/sign_in_browser.dart`).
 *
 * The sign-in page runs in a Custom Tab, which is Chrome's and which this app cannot close: once the
 * redirect has reached the app's loopback listener and the session is saved, the tab's last page
 * ("Signed in to Harness") still sits over the app. Its "Back to Harness" opens
 * `ai.autonomous.harness.signin://`, which lands here.
 *
 * ⚠️ **Why a hop through here and not straight to [MainActivity].** The Custom Tab lives in
 * MainActivity's own task, ABOVE it. Started directly, MainActivity would come up as a second
 * instance — a second Flutter engine — on top of the tab. From here it is started with
 * NEW_TASK | CLEAR_TOP | SINGLE_TOP instead: NEW_TASK finds the task MainActivity already roots,
 * CLEAR_TOP finishes what is above it (the tab), and SINGLE_TOP hands the running instance the intent
 * rather than recreating it. The intent carries no data, so Flutter pushes no route. This is AppAuth's
 * redirect pattern, for a redirect this app receives on 127.0.0.1 rather than on a scheme.
 */
class SignInReturnActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startActivity(
      Intent(this, MainActivity::class.java).addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or
          Intent.FLAG_ACTIVITY_CLEAR_TOP or
          Intent.FLAG_ACTIVITY_SINGLE_TOP
      )
    )
    finish()
  }
}
