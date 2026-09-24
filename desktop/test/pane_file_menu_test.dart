import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/sharing/share_harness_dialog.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <(String, Map<String, dynamic>)>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, payload));
    return {'shares': []};
  }
}

void main() {
  const channel = MethodChannel('harness/swarm_tabs');
  Future<void> send(WidgetTester tester, String action) async {
    tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(MethodCall(action)),
      (_) {},
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'File Share targets the focused harness and disables in an empty tab',
    (tester) async {
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      app.stateOf('m')!.nodeOnline = true;
      final first = app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      await mount(tester, app, nativeTabs: true);
      app.focusPane(first.id);
      await tester.pump();
      expect((updates.last['paneActions'] as Map)['shareAgent'], isTrue);
      await send(tester, 'shareAgent');
      expect(find.byType(ShareHarnessDialog), findsOneWidget);
      expect(
        connection.calls
            .where((call) => call.$1 == 'harness_share_list')
            .single
            .$2,
        {'agentId': 'a0'},
      );
      expect(
        (updates.last['paneActions'] as Map)['shareAgent'],
        isFalse,
        reason: 'A modal cannot open another share dialog.',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      app.newSwarm();
      await tester.pumpAndSettle();
      expect((updates.last['paneActions'] as Map)['shareAgent'], isFalse);
      await send(tester, 'shareAgent');
      expect(find.byType(ShareHarnessDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'View menu toggles the focused composer and the viewer of its owner',
    (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        (_) async => true,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      app.stateOf('m')!.nodeOnline = true;
      app.stateOf('m')!.agents = [
        const Agent(
          id: 'a0',
          name: 'Preview',
          engine: 'codex',
          terminalAvailable: true,
          viewerUrl: 'http://fixture.invalid/viewer',
        ),
      ];
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app, nativeTabs: true);
      await send(tester, 'toggleComposer');
      expect(pane.composerVisible, isTrue);
      expect(find.byType(TerminalComposer), findsOneWidget);
      await send(tester, 'toggleComposer');
      expect(pane.composerVisible, isFalse);
      await send(tester, 'toggleViewer');
      final viewer = app.panes.singleWhere((pane) => pane.isWeb);
      expect(viewer.ownerAgentId, 'a0');
      app.focusPane(viewer.id);
      await tester.pump();
      await send(tester, 'toggleViewer');
      expect(app.panes.where((pane) => pane.isWeb), isEmpty);
      expect(app.panes, contains(pane));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
