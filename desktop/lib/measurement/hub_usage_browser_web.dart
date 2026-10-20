import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// The two privacy signals, which package:web does not declare.
extension on web.Navigator {
  external bool? get globalPrivacyControl;
  external String? get doNotTrack;
}

/// Global Privacy Control and Do Not Track turn Hub counting off.
bool hubUsageAllowed() {
  final navigator = web.window.navigator;
  return navigator.globalPrivacyControl != true && navigator.doNotTrack != '1';
}

bool pageVisible() => web.document.visibilityState == 'visible';

/// To the website's own server, which strips the sign-in before the backend: no cookies, and
/// `keepalive` so a report sent as the page goes still leaves. A failed send is dropped.
void postHubUsage(String body, String? authorization) {
  final headers = web.Headers()..set('Content-Type', 'application/json');
  if (authorization != null) headers.set('Authorization', authorization);
  web.window
      .fetch(
        '/api/hub-usage'.toJS,
        web.RequestInit(
          method: 'POST',
          headers: headers,
          body: body.toJS,
          credentials: 'omit',
          cache: 'no-store',
          keepalive: true,
        ),
      )
      .toDart
      .ignore();
}

/// Calls [visibility] as the tab shows or hides and [leave] as the page goes; returns the unsubscribe.
void Function() watchPage({
  required void Function(bool visible) visibility,
  required void Function() leave,
}) {
  final onVisibility = ((web.Event _) => visibility(pageVisible())).toJS;
  final onLeave = ((web.Event _) => leave()).toJS;
  web.document.addEventListener('visibilitychange', onVisibility);
  web.window.addEventListener('pagehide', onLeave);
  return () {
    web.document.removeEventListener('visibilitychange', onVisibility);
    web.window.removeEventListener('pagehide', onLeave);
  };
}
