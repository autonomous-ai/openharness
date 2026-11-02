import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/web/update/web_update_host.dart';

/// The page's own watch for a newer release (task #2185): it learns which
/// release it runs, asks the host for the one it serves now, and shows the bar
/// when they differ. Native builds never mount it.
void main() {
  late String? latest;
  var reloads = 0;
  late StreamController<void> shown;

  Future<void> mount(
    WidgetTester tester, {
    String? running = '1.3.51',
    Future<String?> Function()? readRunning,
  }) async {
    reloads = 0;
    latest = '1.3.51';
    shown = StreamController<void>.broadcast();
    addTearDown(shown.close);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: WebUpdateHost(
            readRunning: readRunning ?? () async => running,
            readLatest: () async => latest,
            reload: () => reloads++,
            every: const Duration(minutes: 5),
            pageShown: shown.stream,
            child: const Text('the app'),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  final bar = find.byKey(const ValueKey('web-update-bar'));

  testWidgets('a release out while the page is open shows the bar after the '
      'next check, and Reload reloads', (tester) async {
    await mount(tester);
    expect(bar, findsNothing);
    latest = '1.3.52';
    await tester.pump(const Duration(minutes: 5));
    expect(bar, findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('web-update-reload')));
    expect(reloads, 1);
  });

  testWidgets('the page coming back to the front checks at once', (
    tester,
  ) async {
    await mount(tester);
    latest = '1.3.52';
    shown.add(null);
    await tester.pump();
    expect(bar, findsOneWidget);
  });

  testWidgets('the same release shows nothing, however long it is open', (
    tester,
  ) async {
    await mount(tester);
    await tester.pump(const Duration(hours: 2));
    expect(bar, findsNothing);
  });

  testWidgets('a page that cannot tell its own release never shows the bar', (
    tester,
  ) async {
    await mount(tester, running: null);
    latest = '1.3.52';
    await tester.pump(const Duration(minutes: 30));
    expect(bar, findsNothing);
    expect(find.text('the app'), findsOneWidget);
  });

  testWidgets('a start-up read that fails is the same as none', (tester) async {
    await mount(tester, readRunning: () async => throw StateError('offline'));
    latest = '1.3.52';
    await tester.pump(const Duration(minutes: 30));
    expect(bar, findsNothing);
  });

  testWidgets('the app is there from the first frame, before the version is '
      'known', (tester) async {
    final slow = Completer<String?>();
    await mount(tester, readRunning: () => slow.future);
    expect(find.text('the app'), findsOneWidget);
    slow.complete('1.3.51');
    await tester.pump();
    expect(find.text('the app'), findsOneWidget);
  });
}
