/// The browser's notifier in a browser build, none anywhere else — picked at
/// compile time, so native builds never compile `lib/web/`.
library;

export 'browser_notifier_none.dart'
    if (dart.library.js_interop) '../web/notify/browser_system_notifier.dart';
