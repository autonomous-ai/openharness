import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// Reloads the page, for a part an older page can no longer download.
void reloadPage() => web.window.location.reload();

/// Reloads the page into the release the host serves now. A service worker or
/// cache an older release left in this browser would answer the reload with
/// the old build, so they go first; each step is allowed to fail, and the page
/// reloads whatever came of it. [reload] and [window] are for tests.
Future<void> reloadForNewVersion({
  void Function()? reload,
  web.Window? window,
}) async {
  final win = window ?? web.window;
  try {
    final registrations = await win.navigator.serviceWorker
        .getRegistrations()
        .toDart;
    for (final registration in registrations.toDart) {
      await registration.unregister().toDart;
    }
  } catch (_) {
    // No service workers here, or the browser refuses them.
  }
  try {
    final names = await win.caches.keys().toDart;
    for (final name in names.toDart) {
      await win.caches.delete(name.toDart).toDart;
    }
  } catch (_) {
    // No cache storage here (an insecure page), or the browser refuses it.
  }
  (reload ?? () => win.location.reload())();
}
