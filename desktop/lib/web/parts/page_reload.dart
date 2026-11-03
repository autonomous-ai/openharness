/// Reloads the page; a native build has none (`page_reload_web.dart` is the
/// browser's, picked by the import in `deferred_part.dart`).
void reloadPage() {}

/// Reloads the page into the newest release; a native build has no page.
Future<void> reloadForNewVersion() async {}
