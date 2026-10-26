import 'dart:io';
import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/pull_requests.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:harness/ws/local_daemon_transport.dart';

import '../test/swarm_state_test.dart' show createApp;

import '../test/super_tab_pull_requests_test.dart'
    show prServer, allPrStates, prUrl;

/// Native rendering of the actual pane, with protocol fixtures and no production daemon or account writes.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  testWidgets('linked PR status, expansion and stale answers render on macOS', (
    tester,
  ) async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1100, 1100));
    await windowManager.setAlwaysOnTop(true);
    addTearDown(() => windowManager.setAlwaysOnTop(false));
    await windowManager.show();
    await windowManager.focus();
    final rows = allPrStates();
    final server = prServer(
      rows.map((r) => int.parse((r['url'] as String).split('/').last)),
    );
    final c = await tester.runAsync(() async {
      final c = server.controller();
      await c.refresh();
      return c;
    });
    var fail = false;
    final boundary = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: RepaintBoundary(
            key: boundary,
            child: Material(
              color: DesktopChrome.surface,
              child: SuperTabPullRequests(
                controller: c!,
                read: (_) async => fail ? {'error': 'TIMEOUT'} : {'rows': rows},
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Needs you 4'), findsOneWidget);
    expect(find.text('Ready to merge'), findsOneWidget);
    expect(find.text('View status on GitHub'), findsNothing);
    Future<void> shot(String name) async {
      final folder = Platform.environment['SUPER_TAB_PR_SHOTS'];
      if (folder == null) return;
      final image =
          await (boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 1);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(folder).create(recursive: true);
      await File('$folder/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    }

    await tester.runAsync(() => shot('pull-requests-all-states'));
    await tester.tap(find.text('Show 1 more'));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Closed 1'));
    await tester.tap(find.text('Closed 1'));
    await tester.pumpAndSettle();
    expect(find.byKey(ValueKey('super-pr-${prUrl(16)}')), findsOneWidget);
    await tester.runAsync(() => shot('pull-requests-expanded'));
    fail = true;
    // A new linked URL triggers a read now, without waiting a wall-clock minute.
    server.append(prUrl(18));
    await tester.runAsync(c.refresh);
    await tester.pumpAndSettle();
    expect(
      find.textContaining("GitHub didn't answer. Showing what it said"),
      findsOneWidget,
    );
    await tester.drag(find.byType(ListView), const Offset(0, 1200));
    await tester.pumpAndSettle();
    expect(find.text('Pull request 1'), findsOneWidget);
    await tester.runAsync(() => shot('pull-requests-stale'));
    final receipt = Platform.environment['SUPER_TAB_PR_REAL_RECEIPT'];
    if (receipt != null) {
      final real =
          (jsonDecode(await File(receipt).readAsString()) as Map)['rows']
              as List;
      await tester.pumpWidget(const SizedBox());
      final realServer = prServer(
        real.map((r) => int.parse((r['url'] as String).split('/').last)),
      );
      for (final message in realServer.messages) {
        message['text'] = (message['text'] as String).replaceAll(
          'github.com/o/r/',
          'github.com/autonomous-ai/openharness/',
        );
      }
      final realController = await tester.runAsync(() async {
        final c = realServer.controller();
        await c.refresh();
        return c;
      });
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: RepaintBoundary(
              key: boundary,
              child: Material(
                color: DesktopChrome.surface,
                child: SuperTabPullRequests(
                  controller: realController!,
                  read: (_) async => {'rows': real},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Merged 6'), findsOneWidget);
      expect(find.text('Nothing needs you.'), findsOneWidget);
      expect(find.text('View status on GitHub'), findsNothing);
      await tester.runAsync(() => shot('pull-requests-real-six'));
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(realController.flush);
      realController.dispose();
    }
    // Opt-in manual compatibility check, explicitly pointed at the installed CLI.
    // Normal native runs retain fixture traffic only.
    final oldSocket = Platform.environment['SUPER_TAB_PR_OLD_SOCKET'];
    final oldMachine = Platform.environment['SUPER_TAB_PR_OLD_MACHINE'];
    if (oldSocket != null && oldMachine != null) {
      await tester.pumpWidget(const SizedBox());
      final connection = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:18473',
        autonomousEnv: 'prod',
        machineId: oldMachine,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:18473/api/local-ws'),
        localTransport: LocalDaemonTransport(candidate: oldSocket),
        localToolClient: true,
      );
      await tester.runAsync(() async {
        await connection.connect();
        await connection.waitUntilReady(timeout: const Duration(seconds: 5));
      });
      final app = createApp(connectionForTest: (_) => connection);
      app.stateOf('m')!.localOnly = true;
      final oldController = await tester.runAsync(() async {
        final c = prServer([1494]).controller();
        await c.refresh();
        return c;
      });
      final answered = Completer<void>(), elapsed = Stopwatch()..start();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: RepaintBoundary(
              key: boundary,
              child: Material(
                color: DesktopChrome.surface,
                child: SuperTabPullRequests(
                  controller: oldController!,
                  app: app,
                  read: (urls) async {
                    final answer = await app.readPullRequestsStatus(urls);
                    answered.complete();
                    return answer;
                  },
                ),
              ),
            ),
          ),
        ),
      );
      await tester.runAsync(
        () => answered.future.timeout(const Duration(seconds: 5)),
      );
      await tester.pumpAndSettle();
      elapsed.stop();
      expect(find.textContaining('View status on GitHub'), findsOneWidget);
      expect(find.textContaining("GitHub didn't answer"), findsNothing);
      debugPrint(
        'Installed CLI fallback displayed in ${elapsed.elapsedMilliseconds} ms',
      );
      await tester.runAsync(() => shot('pull-requests-installed-cli-fallback'));
      await tester.pumpWidget(const SizedBox());
      oldController.dispose();
      app.dispose();
      await connection.close();
    }
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.runAsync(c.flush);
    c.dispose();
  });
}
