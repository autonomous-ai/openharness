import 'package:web/web.dart' as web;

import 'pending_pair.dart';

/// The tab's pending machine code: taken from a `/pair#…` URL once, kept in sessionStorage so it
/// survives the SSO redirect (which returns to `/`), and dropped once consumed or stale.
class PendingPairStore {
  const PendingPairStore();

  static const _key = 'harness.pendingPair';

  /// The code this tab is holding: from the URL when it is a `/pair` link (which is then stripped
  /// from the address bar and history), else from before the sign-in redirect. Null when there is
  /// none; an expired one is still returned, so the page can say "scan it again".
  PendingPair? capture(DateTime now) {
    final fromUrl = PendingPair.fromUri(Uri.base, now);
    if (fromUrl != null) {
      _write(fromUrl.encode());
      try {
        web.window.history.replaceState(null, '', '/');
      } catch (_) {}
      return fromUrl;
    }
    return PendingPair.decode(_read());
  }

  void clear() {
    try {
      web.window.sessionStorage.removeItem(_key);
    } catch (_) {}
  }

  // Private mode may refuse storage: the code is then held for this page load only, and a sign-in
  // redirect loses it (the page says to scan again after signing in).
  String? _read() {
    try {
      return web.window.sessionStorage.getItem(_key);
    } catch (_) {
      return null;
    }
  }

  void _write(String value) {
    try {
      web.window.sessionStorage.setItem(_key, value);
    } catch (_) {}
  }
}
