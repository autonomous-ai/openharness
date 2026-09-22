import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';
import 'package:window_manager/window_manager.dart';

import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/store/store_demo_dialog.dart';
import 'package:harness/store/store_showcase.dart';
import 'package:harness/store/store_collections.dart';
import 'package:harness/store/store_sessions.dart';

// FLUTTER_TEST=1 flutter test -d macos --no-pub \
//   --dart-define=STORE_DEMO_CHECKOUT=/absolute/path/to/openharness \
//   --dart-define=STORE_DEMO_REF=<published-commit> \
//   integration_test/store_recordings_native_test.dart
// Uses the real HTTPS recordings and WKWebView; no login, agent or user state.
void main() {
  if (!kUnderTest) throw StateError('Run with FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const checkout = String.fromEnvironment('STORE_DEMO_CHECKOUT');
  const ref = String.fromEnvironment('STORE_DEMO_REF', defaultValue: 'main');

  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1160, 900));
    await windowManager.show();
    await windowManager.focus();
  });

  testWidgets(
    'featured recording plays from its card before opening the harness',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      expect(checkout, isNotEmpty, reason: 'Pass STORE_DEMO_CHECKOUT');
      final entry = DshEntry.fromJson({
        ...jsonDecode(
          await File('$checkout/store/agents/blender/harness.json')
              .readAsString(),
        ) as Map<String, dynamic>,
        ...jsonDecode(
          await File('$checkout/store/agents/blender/store.json')
              .readAsString(),
        ) as Map<String, dynamic>,
      })!;
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: StoreSessions(
              sessions: storeRecordedSessions([entry]),
              onOpen: opened.add,
            ),
          ),
        ),
      );
      expect(find.byType(WebViewWidget), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('store-session-watch:autonomous/blender')),
      );
      await tester.pump();
      await _wait(
        tester,
        () async => find.byType(WebViewWidget).evaluate().isNotEmpty,
      );
      final controller = tester
          .widget<WebViewWidget>(find.byType(WebViewWidget))
          .platform
          .params
          .controller;
      await _wait(tester, () async {
        final state = await _video(controller);
        return state['ready'] >= 2 && state['width'] > 0 && state['time'] > 0;
      });
      final playing = await _video(controller);
      expect(playing['source'], entry.examples.first.video);
      expect(playing['paused'], false);
      expect(playing['error'], isNull);
      debugPrint('Featured Blender recording decoded: $playing');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await _wait(
        tester,
        () async => (await _video(controller))['present'] == false,
      );
      await tester.tap(
        find.byKey(const ValueKey('store-session-open:autonomous/blender')),
      );
      await tester.pumpAndSettle();
      expect(opened, ['autonomous/blender']);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      debugDefaultTargetPlatformOverride = null;
    },
  );

  testWidgets('every published recording decodes, plays and releases its media', (
    tester,
  ) async {
    // FLUTTER_TEST makes foundation use Android by default, even in a native
    // macOS fixture. WebKit needs the actual platform for its creation params.
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    expect(WebViewPlatform.instance, isNotNull);
    expect(checkout, isNotEmpty, reason: 'Pass STORE_DEMO_CHECKOUT');
    final experiences = jsonDecode(
      await File('$checkout/store/hands-on.json').readAsString(),
    ) as List<dynamic>;
    final results = <Map<String, Object?>>[];
    for (final item in experiences) {
      debugPrint('Checking recording: ${item['id']}');
      final facts = jsonDecode(
        await File('$checkout/store/agents/${item['id']}/store.json')
            .readAsString(),
      ) as Map<String, dynamic>;
      final example = StoreExample.fromJson({
        ...facts['examples'][0] as Map<String, dynamic>,
        'image': (facts['examples'][0]['image'] as String).replaceFirst(
          '/openharness/main/',
          '/openharness/$ref/',
        ),
        'video': (facts['examples'][0]['video'] as String).replaceFirst(
          '/openharness/main/',
          '/openharness/$ref/',
        ),
      })!;
      final tried = <String>[];
      final entry = DshEntry(
        id: 'autonomous/${item['id']}',
        name: item['name'] as String,
        engine: 'claude',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(32),
              child: StoreExampleFlow(
                key: ValueKey(item['id']),
                entry: entry,
                examples: [example],
                animate: false,
                onTry: tried.add,
              ),
            ),
          ),
        ),
      );
      expect(find.byType(WebViewWidget), findsNothing);
      final watch = find.byKey(const ValueKey('store-watch-demo:0'));
      await tester.ensureVisible(watch);
      await tester.tap(watch);
      await tester.pump();
      expect(find.byType(StoreDemoDialog), findsOneWidget);
      await _wait(tester, () async {
        expect(find.text('This recording could not play here.'), findsNothing);
        return find.byType(WebViewWidget).evaluate().isNotEmpty;
      });
      final controller = tester
          .widget<WebViewWidget>(find.byType(WebViewWidget))
          .platform
          .params
          .controller;
      await _wait(tester, () async {
        final state = await _video(controller);
        return state['ready'] >= 2 && state['width'] > 0 && state['time'] > 0;
      });
      final before = await _video(controller);
      await tester.pump(const Duration(milliseconds: 400));
      final playing = await _video(controller);
      expect(playing['time'], greaterThan(before['time'] as num));
      expect(playing['paused'], false);
      expect(playing['error'], isNull);
      expect(playing['source'], example.video);
      expect(playing['duration'], greaterThan(0));
      expect(playing['width'], greaterThan(0));
      expect(playing['height'], greaterThan(0));
      expect(playing['controls'], true);
      expect(find.text(example.caption!), findsNWidgets(2));
      results.add({'id': item['id'], ...playing});
      debugPrint(
        'Decoded ${item['id']}: ${playing['width']} x ${playing['height']}, ${playing['time']} s',
      );
      if (const bool.fromEnvironment('STORE_DEMO_VISUAL_REVIEW') &&
          item['id'] == 'blender') {
        await controller.runJavaScript(
          "document.querySelector('video').pause()",
        );
        debugPrint('Blender recording ready for visual review');
        await tester.pump(const Duration(seconds: 45));
      }
      // Closing must remove the native source, even if the native view survives
      // its Flutter route. This also catches audio continuing behind the page.
      await tester.tap(find.byKey(const ValueKey('store-demo-close')));
      await tester.pump(const Duration(milliseconds: 500));
      await _wait(
        tester,
        () async => (await _video(controller))['present'] == false,
      );
      expect(find.byType(StoreDemoDialog), findsNothing);
      debugPrint('Released recording: ${item['id']}');
      final tryPrompt = find.byKey(const ValueKey('store-try-prompt:0'));
      await tester.ensureVisible(tryPrompt);
      await tester.tap(tryPrompt);
      expect(tried, [example.prompt]);
      expect(tester.takeException(), isNull);
    }

    // Reopening starts a new player; Escape takes the same cleanup path.
    await tester.tap(find.byKey(const ValueKey('store-watch-demo:0')));
    await _wait(
      tester,
      () async => find.byType(WebViewWidget).evaluate().isNotEmpty,
    );
    final reopened = tester
        .widget<WebViewWidget>(find.byType(WebViewWidget))
        .platform
        .params
        .controller;
    await _wait(tester, () async => (await _video(reopened))['ready'] >= 2);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump(const Duration(milliseconds: 500));
    await _wait(
      tester,
      () async => (await _video(reopened))['present'] == false,
    );
    expect(find.byType(StoreDemoDialog), findsNothing);

    // An unavailable file must show a useful fallback rather than an empty player.
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: const Scaffold(
          body: StoreDemoDialog(
            name: 'Missing recording',
            video: 'https://raw.githubusercontent.com/autonomous-ai/openharness/main/docs/images/missing-store-demo.mp4',
          ),
        ),
      ),
    );
    await _wait(
      tester,
      () async => find
          .text('This recording could not play here.')
          .evaluate()
          .isNotEmpty,
    );
    expect(find.text('Open recording'), findsOneWidget);
    expect(find.text('Open in browser'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    final report = File(
      '$checkout/.scratch/harness-detail-evidence/native-recordings.json',
    );
    await report.parent.create(recursive: true);
    await report.writeAsString(
      const JsonEncoder.withIndent('  ').convert(results),
    );
    debugDefaultTargetPlatformOverride = null;
  });
}

Future<Map<String, dynamic>> _video(
  PlatformWebViewController controller,
) async {
  final result = await controller
      .runJavaScriptReturningResult('''
    JSON.stringify((() => {
      const v = document.querySelector('video');
      return v ? {present: true, ready: v.readyState, time: v.currentTime,
        duration: v.duration, width: v.videoWidth, height: v.videoHeight,
        paused: v.paused, source: v.currentSrc, controls: v.controls,
        error: v.error?.code ?? null} : {present: false, ready: 0};
    })())
  ''')
      .timeout(const Duration(seconds: 10));
  return jsonDecode(result as String) as Map<String, dynamic>;
}

Future<void> _wait(
  WidgetTester tester,
  Future<bool> Function() condition,
) async {
  final deadline = DateTime.now().add(const Duration(seconds: 35));
  while (DateTime.now().isBefore(deadline)) {
    if (await condition()) return;
    await tester.pump(const Duration(milliseconds: 100));
  }
  fail('Native recording did not reach the expected state within 35 seconds');
}
