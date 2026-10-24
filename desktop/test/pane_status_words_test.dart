// Pane states in words on the web (WorkspaceChrome.labelsPaneStatus, audit
// findings S3 and S4): a computer that is connecting or reconnecting, and a
// terminal this browser may only watch. Desktop keeps today's pane.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;

const _streamId = '00112233-4455-6677-8899-aabbccddeeff';

/// Agent a0's terminal past `terminal_ready` and its first keyframe, so it
/// takes keys; what it sends lands in [wire].
Future<TerminalSession> _liveSession(
  List<TerminalBinaryFrame> wire, {
  bool viewOnly = false,
}) async {
  Object? openRequestId;
  final session = TerminalSession(
    machineId: 'm',
    agentId: 'a0',
    agentName: 'Fix checkout flow tests',
    engineId: 'codex',
    readOnly: viewOnly,
    send: (type, payload) async {
      if (type == 'terminal_open') openRequestId = payload['requestId'];
      return true;
    },
    sendBinary: (frame) async {
      wire.add(frame);
      return true;
    },
  );
  await session.open(initialCols: 80, initialRows: 24);
  await session.handleFrame('terminal_ready', {
    'requestId': openRequestId,
    'protocolVersion': 3,
    'streamId': _streamId,
    'agentId': 'a0',
  });
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: _streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(r'$ ')),
      compressed: false,
      cols: 80,
      rows: 24,
    ),
  );
  return session;
}

String _typed(List<TerminalBinaryFrame> wire) => utf8.decode([
  for (final frame in wire)
    if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
]);

Future<AppNotifier> _app(
  WidgetTester tester,
  List<TerminalBinaryFrame> wire, {
  ConnectionStatus status = ConnectionStatus.connected,
  bool viewOnly = false,
}) async {
  final app = createApp(connected: true);
  app.machineStates['m']!.connectionStatus = status;
  final session = await _liveSession(wire, viewOnly: viewOnly);
  app.adoptSessionForTest(session);
  return app;
}

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app, {
  WorkspaceChrome? chrome,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1440, 900);
  addTearDown(tester.view.reset);
  final grid = PaneGrid(notifier: app, swarmMode: true);
  await tester.pumpWidget(
    MaterialApp(
      home: chrome == null
          ? grid
          : WorkspaceChromeScope(chrome: chrome, child: grid),
    ),
  );
  await tester.pump();
}

/// Takes the pane down and ends the app with its session, whose clocks would
/// otherwise outlive the test.
Future<void> _unmount(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(const SizedBox());
  app.dispose();
}

const _cursorLock = ValueKey('terminal-cursor-lock');

Terminal _terminal(AppNotifier app) => app.panes.single.session!.terminal;

TerminalView _view(WidgetTester tester) =>
    tester.widget<TerminalView>(find.byType(TerminalView));

void main() {
  testWidgets('a reconnecting computer\'s pane says so on the web', (
    tester,
  ) async {
    final app = await _app(tester, [], status: ConnectionStatus.reconnecting);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    expect(find.text('Reconnecting…'), findsWidgets);
    expect(find.textContaining('Keys typed now are not sent'), findsOneWidget);
    expect(_view(tester).readOnly, isTrue);
    await _unmount(tester, app);
  });

  testWidgets('a connecting computer\'s pane says so on the web', (
    tester,
  ) async {
    final app = await _app(tester, [], status: ConnectionStatus.connecting);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    expect(find.text('Connecting…'), findsWidgets);
    expect(_view(tester).readOnly, isTrue);
    await _unmount(tester, app);
  });

  testWidgets('Desktop keeps a reconnecting pane as it is today', (
    tester,
  ) async {
    final app = await _app(tester, [], status: ConnectionStatus.reconnecting);

    await _mount(tester, app);

    expect(find.text('Reconnecting…'), findsNothing);
    expect(find.textContaining('Keys typed now'), findsNothing);
    expect(_view(tester).readOnly, isFalse);
    await _unmount(tester, app);
  });

  testWidgets(
    'keys typed while reconnecting are dropped, later ones are sent',
    (tester) async {
      final wire = <TerminalBinaryFrame>[];
      final app = await _app(
        tester,
        wire,
        status: ConnectionStatus.reconnecting,
      );
      await _mount(tester, app, chrome: webWorkspaceChrome(app));
      await tester.tap(find.byType(TerminalView));
      // Past the terminal's double-tap window.
      await tester.pump(const Duration(milliseconds: 350));

      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 50));
      expect(_typed(wire), isEmpty);

      app.machineStates['m']!.connectionStatus = ConnectionStatus.connected;
      app.notifyListeners();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 50));

      expect(_typed(wire), '\r');
      await _unmount(tester, app);
    },
  );

  testWidgets('a view-only terminal says so on the web', (tester) async {
    final app = await _app(tester, [], viewOnly: true);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    expect(find.text('View only'), findsOneWidget);
    await _unmount(tester, app);
  });

  testWidgets('Desktop adds no words to a view-only terminal', (tester) async {
    final app = await _app(tester, [], viewOnly: true);

    await _mount(tester, app);

    expect(find.text('View only'), findsNothing);
    await _unmount(tester, app);
  });

  testWidgets('a view-only terminal on the web shows a lock, not a cursor', (
    tester,
  ) async {
    final app = await _app(tester, [], viewOnly: true);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    expect(find.byKey(_cursorLock), findsOneWidget);
    expect(_terminal(app).cursorVisibleMode, isFalse);
    await _unmount(tester, app);
  });

  testWidgets('Desktop keeps a view-only terminal\'s cursor', (tester) async {
    final app = await _app(tester, [], viewOnly: true);

    await _mount(tester, app);

    expect(find.byKey(_cursorLock), findsNothing);
    expect(_terminal(app).cursorVisibleMode, isTrue);
    await _unmount(tester, app);
  });

  testWidgets('the lock goes once the terminal can be typed into again', (
    tester,
  ) async {
    final app = await _app(tester, []);
    final session = app.panes.single.session!
      ..stageInputContext(null, watchOnly: true);
    await _mount(tester, app, chrome: webWorkspaceChrome(app));
    expect(find.byKey(_cursorLock), findsOneWidget);

    // Control comes back as a stream does: reopened, then live.
    session
      ..stageInputContext(null)
      ..status = TerminalSessionStatus.opening
      ..notifyListeners();
    await tester.pump();
    session
      ..status = TerminalSessionStatus.controlling
      ..notifyListeners();
    await tester.pump();

    expect(find.byKey(_cursorLock), findsNothing);
    expect(_terminal(app).cursorVisibleMode, isTrue);
    await _unmount(tester, app);
  });
}
