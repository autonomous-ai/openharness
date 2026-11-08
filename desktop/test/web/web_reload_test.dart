@TestOn('browser')
library;

import 'dart:js_interop';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/parts/page_reload_web.dart';
import 'package:web/web.dart' as web;

/// Reload into a new release (task #2185): what an older release left in the
/// browser must not answer the reload with the old build.
void main() {
  test('Reload clears the page\'s caches, then reloads once', () async {
    await web.window.caches.open('old-release').toDart;
    final before = (await web.window.caches.keys().toDart).toDart;
    expect(before.map((name) => name.toDart), contains('old-release'));
    var reloads = 0;
    await reloadForNewVersion(reload: () => reloads++);
    expect(reloads, 1);
    // Gone by the time the call that reloads has returned.
    expect((await web.window.caches.keys().toDart).toDart, isEmpty);
  });

  test('a browser that refuses service workers and caches still reloads', () async {
    var reloads = 0;
    // A window with nothing the cleanup can use: every step fails, the reload
    // still happens.
    await reloadForNewVersion(window: _refusing(), reload: () => reloads++);
    expect(reloads, 1);
  });
}

web.Window _refusing() => ({}.jsify() as web.Window);
