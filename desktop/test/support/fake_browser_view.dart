import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:harness/browser/browser_view.dart';

/// The Browser page as the host sees it: what the host posted, and what the page says. With [ready], it says it
/// loaded as soon as someone listens, as the real page does once the webview has it.
class FakeBrowserView implements BrowserView {
  FakeBrowserView({this.ready = false});
  final bool ready;
  final posted = <Map<String, Object?>>[];
  late final _messages = StreamController<Map<String, Object?>>.broadcast(
    onListen: () {
      if (ready) scheduleMicrotask(() => say({'t': 'ready'}));
    },
  );

  void say(Map<String, Object?> message) => _messages.add(message);

  @override
  void post(Map<String, Object?> message) => posted.add(message);

  @override
  Stream<Map<String, Object?>> get messages => _messages.stream;

  @override
  Widget build(BuildContext context) =>
      const SizedBox.expand(key: ValueKey('browser-screen'));
}
