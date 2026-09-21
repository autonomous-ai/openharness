import 'dart:io';

import 'package:url_launcher/url_launcher.dart';

/// Where the SSO page opens: the system browser, as it always has — except on a phone.
///
/// There, handing the person to Safari or Chrome suspends this app and with it the loopback
/// listener the page redirects back to, so the page opens in-app (SFSafariViewController on iOS,
/// a Custom Tab on Android), where the app keeps running, and [closeSignInPage] takes it down
/// once the redirect lands.
///
/// ⚠️ Unverified on a device: the SSO page's Google button opens a popup, and whether an in-app
/// browser view lets that popup post back to its opener is exactly what the first run on a phone
/// has to answer.
Future<bool> openSignInPage(Uri url) => launchUrl(
  url,
  mode: Platform.isIOS || Platform.isAndroid
      ? LaunchMode.inAppBrowserView
      : LaunchMode.externalApplication,
);

Future<void> closeSignInPage() async {
  if (Platform.isIOS || Platform.isAndroid) await closeInAppWebView();
}
