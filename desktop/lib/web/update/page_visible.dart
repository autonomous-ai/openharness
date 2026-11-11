/// Tells each time the page comes back to the front; a native build has no
/// page to come back (`page_visible_web.dart` is the browser's, picked by the
/// import in `web_update_host.dart`).
Stream<void> pageShown() => const Stream.empty();
