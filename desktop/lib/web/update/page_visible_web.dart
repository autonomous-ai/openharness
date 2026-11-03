import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// Tells each time the page comes back to the front: a tab left in the
/// background is where a release is missed longest, since a browser slows its
/// timers there.
Stream<void> pageShown() {
  late final StreamController<void> controller;
  late final JSFunction listener = ((web.Event _) {
    if (web.document.visibilityState == 'visible') controller.add(null);
  }).toJS;

  controller = StreamController<void>.broadcast(
    onListen: () => web.document.addEventListener('visibilitychange', listener),
    onCancel: () =>
        web.document.removeEventListener('visibilitychange', listener),
  );
  return controller.stream;
}
