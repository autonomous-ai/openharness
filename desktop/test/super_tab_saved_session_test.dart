import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/pane.dart';
import 'package:harness/super_tabs/saved_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/session_tail_view.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

class _HistoryConnection extends WsConn {
  _HistoryConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final requests = <(String, Map<String, dynamic>)>[];
  Completer<Map<String, dynamic>>? pending;
  Map<String, dynamic> reply = {
    'rows': [
      {
        'turn': 1,
        'ask': 'Calculate the total',
        'answer': 'The verified total is 403.',
      },
    ],
    'total': 1,
    'hasMore': false,
  };

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, Map.of(payload)));
    if (type == 'session_tail') return pending?.future ?? reply;
    return {};
  }
}

void main() {
  const stopped = Agent(
    id: 'saved',
    name: 'Multiply',
    engine: 'codex',
    sessionId: 'saved-conversation',
    status: 'stopped',
    terminalAvailable: false,
  );
  late AppNotifier app;
  late _HistoryConnection connection;
  setUp(() {
    connection = _HistoryConnection();
    app = createApp(connectionForTest: (_) => connection, connected: true);
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
    app.machineStates['m']!.agents = [stopped];
    addTearDown(app.dispose);
  });

  Future<void> pump(WidgetTester tester, {VoidCallback? resume}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabSavedSession(
            app: app,
            machineId: 'm',
            harnessId: 'saved',
            onResume: resume,
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets(
    'saved output is readable without opening a terminal or restarting an engine',
    (tester) async {
      var resumed = 0;
      await pump(tester, resume: () => resumed++);
      await tester.pumpAndSettle();
      expect(find.text('Saved conversation'), findsOneWidget);
      expect(find.text('The verified total is 403.'), findsOneWidget);
      expect(find.byType(SessionTailView), findsOneWidget);
      expect(connection.requests, hasLength(1));
      expect(connection.requests.single.$1, 'session_tail');
      expect(connection.requests.single.$2, {
        'sessionId': 'saved-conversation',
      });
      expect(resumed, 0);
      await tester.tap(find.text('Resume'));
      expect(resumed, 1);
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final unavailable in [
    'observer',
    'guest',
    'offline',
    'unsigned',
    'no session',
  ]) {
    testWidgets('does not request machine history for $unavailable', (
      tester,
    ) async {
      final machine = app.machineStates['m']!;
      switch (unavailable) {
        case 'observer':
          machine.machine = const Machine(
            machineId: 'm',
            authMode: MachineAuthMode.remote,
            isShared: true,
          );
        case 'guest':
          machine.machine = const Machine(
            machineId: 'm',
            authMode: MachineAuthMode.remote,
            machineShare: MachineShare(
              ownerName: 'Other',
              ownerEmail: 'other@example.com',
              via: 'email',
              added: true,
            ),
          );
        case 'offline':
          machine.connectionStatus = ConnectionStatus.disconnected;
        case 'unsigned':
          app.currentUser = null;
        case 'no session':
          machine.agents = [
            const Agent(
              id: 'saved',
              name: 'Multiply',
              engine: 'codex',
              status: 'stopped',
            ),
          ];
      }
      await pump(tester);
      await tester.pumpAndSettle();
      expect(connection.requests, isEmpty);
      expect(find.byType(SessionTailView), findsNothing);
      expect(
        find.text('Saved conversation is unavailable on this machine.'),
        findsOneWidget,
      );
      expect(find.text('Resume'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets(
    'a missing index is an honest stopped state without an implicit resume',
    (tester) async {
      connection.reply = {'error': 'SESSION_NOT_FOUND'};
      await pump(tester, resume: () {});
      await tester.pumpAndSettle();
      expect(
        find.text('Saved conversation is unavailable on this machine.'),
        findsOneWidget,
      );
      expect(connection.requests.map((call) => call.$1), ['session_tail']);
      expect(find.text('Resume'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a late history reply cannot cross an account change', (
    tester,
  ) async {
    connection.pending = Completer();
    await pump(tester);
    expect(connection.requests, hasLength(1));
    app.currentUser = const CurrentUserProfile(
      id: 'different',
      email: 'different@example.com',
    );
    app.machineStates['m']!.machine = const Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    app.dismissError();
    connection.pending!.complete(connection.reply);
    await tester.pumpAndSettle();
    expect(find.text('The verified total is 403.'), findsNothing);
    expect(find.byType(SessionTailView), findsNothing);
    expect(connection.requests, hasLength(1));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a Swarm keeps its retained terminal instead of fetching a conversation preview',
    (tester) async {
      final session = terminal('saved', []);
      session.terminal.write('Retained native output\r\n');
      app.adoptSessionForTest(session);
      var resumed = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperPane(
              machineId: 'm',
              harnessId: 'saved',
              title: 'Multiply',
              onResume: (_, _) => resumed++,
              child: PaneGrid(notifier: app, swarmMode: true),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byType(TerminalPanel), findsOneWidget);
      expect(find.byType(SuperTabSavedSession), findsNothing);
      expect(
        connection.requests.where((call) => call.$1 == 'session_tail'),
        isEmpty,
      );
      expect(find.text('Resume'), findsOneWidget);
      await tester.tap(find.text('Resume'));
      expect(resumed, 1);
      expect(app.panes.single.session, same(session));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
