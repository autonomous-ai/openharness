import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';

/// Where the SSO page opens: in the app — an ASWebAuthenticationSession on iOS, a Custom Tab on
/// Android — each with the browser's own sign-ins (Safari's; the default browser's), so Google
/// offers the accounts the phone is already signed in to.
///
/// Never the Safari or Chrome app: handing the person over suspends this app, and with it the
/// loopback listener the page redirects back to (`direct_login.dart`). Nor iOS's
/// SFSafariViewController, url_launcher's in-app page there: its cookies are its own, apart from
/// Safari's, and every "Continue with Google" began on an empty Google sign-in.
///
/// ⚠️ **Android is the weak side.** A Custom Tab covers the app, the process behind it can be
/// frozen, and the redirect then finds nobody listening — the Play review's "127.0.0.1 took too
/// long to respond" (`email_code_api.dart`). And only iOS can take the page down by itself
/// ([closeSignInPage]): on Android the page's last screen goes back to the app through
/// [signInReturnUrl] instead.
///
/// [onClosed]: the person closed the page themselves — iOS's Cancel, Android's ✕ — before
/// [closeSignInPage] took it down. url_launcher says nothing of it, and the sign-in the page was
/// for waited out its five minutes behind "Waiting for Google…" and a Cancel nobody had pressed.
/// Not told once the page has been taken down, nor once another page has been opened.
///
/// Completes once the page is on its way up; throws when it cannot be shown.
Future<void> openSignInPage(Uri url, {required VoidCallback onClosed}) async {
  _stopWatching();
  final id = _pageId;
  _onClosed = onClosed;
  try {
    if (Platform.isIOS) {
      _iosPage.setMethodCallHandler(_fromIosPage);
      await _iosPage.invokeMethod<void>('open', {'id': id, 'url': '$url'});
      return;
    }
    // A Custom Tab says nothing when it is closed: the app coming back to the front is that close.
    // Not at once — a redirect that came in while the app was frozen is only taken in once it
    // runs again, and that sign-in is under way rather than closed ([DirectLogin.pageClosed]).
    _resumeWatch = AppLifecycleListener(
      onResume: () {
        _closedGrace?.cancel();
        _closedGrace = Timer(const Duration(seconds: 1), () => _closed(id));
      },
    );
    if (!await launchUrl(url, mode: LaunchMode.inAppBrowserView)) {
      throw StateError('No browser to open $url in');
    }
  } catch (_) {
    if (id == _pageId) _stopWatching();
    rethrow;
  }
}

/// Where the Custom Tab's last page sends the person back to the app on Android: the scheme
/// `SignInReturnActivity` takes (`android/app/src/main/AndroidManifest.xml`), which brings the app
/// back over the tab and takes the tab down — the one thing [closeSignInPage] cannot do there.
///
/// On iOS it is where the auth session ends (`SignInPageChannel`): the page goes there and the
/// session takes it down at once, ahead of [closeSignInPage].
const signInReturnUrl = 'ai.autonomous.harness.signin://signed-in';

/// Takes down what [openSignInPage] put up, where the platform can. Best effort.
Future<void> closeSignInPage() async {
  _stopWatching();
  try {
    if (Platform.isIOS) {
      await _iosPage.invokeMethod<void>('close');
    } else if (await supportsCloseForLaunchMode(LaunchMode.inAppBrowserView)) {
      await closeInAppWebView();
    }
  } catch (_) {}
}

/// iOS's page (`SignInPageChannel`, `ios/Runner/AppDelegate.swift`): an ASWebAuthenticationSession,
/// which url_launcher does not offer, and which says when Cancel was pressed.
const _iosPage = MethodChannel('harness/sign_in_page');

/// The page [openSignInPage] last opened; bumped when it is let go, so what its platform says
/// later is not taken for the next one's.
int _pageId = 0;
VoidCallback? _onClosed;
AppLifecycleListener? _resumeWatch;
Timer? _closedGrace;

void _stopWatching() {
  _pageId++;
  _onClosed = null;
  _resumeWatch?.dispose();
  _resumeWatch = null;
  _closedGrace?.cancel();
  _closedGrace = null;
}

Future<void> _fromIosPage(MethodCall call) async {
  if (call.method == 'closed' && call.arguments is int) {
    _closed(call.arguments as int);
  }
}

void _closed(int id) {
  final onClosed = _onClosed;
  if (id != _pageId || onClosed == null) return;
  _stopWatching();
  onClosed();
}
