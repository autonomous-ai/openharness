import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_monitor_controller.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _CloseConnection extends WsConn {
  _CloseConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  late AppNotifier app;
  final closes = <Map<String, dynamic>>[];
  final activities = <String, String>{};
  final failures = <String, Map<String, dynamic>>{};
  final targetedFailures = <(String, String), Map<String, dynamic>>{};
  final requests = <String>[];
  Completer<Map<String, dynamic>>? inspecting;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type != 'agent_close') return {};
    closes.add(Map.of(payload));
    final mode = payload['mode'] as String;
    final agentId = payload['agentId'] as String;
    if (targetedFailures[(agentId, mode)] ?? failures[mode]
        case final failure?) {
      // Real WsConn throws refusals; returning a map would skip the production
      // error path and hide the bug that called every refusal a lost reply.
      throw WsRequestFailure(
        responseType: 'agent_close_result',
        code: failure['error'] as String,
        detail: failure['detail'] as String?,
        payload: failure,
      );
    }
    if (mode == 'inspect') {
      return inspecting?.future ??
          Future.value({'activity': activities[payload['agentId']] ?? 'idle'});
    }
    if (mode == 'after_task') return {'deferred': true};
    if (mode == 'cancel') return {'cancelled': true};
    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'payload': {'agentId': payload['agentId']},
    });
    return {'closed': true};
  }
}

void main() {
  late AppNotifier app;
  late _CloseConnection connection;
  Agent agent(String id, {bool started = true}) => Agent(
    id: id,
    name: 'Work $id',
    engine: 'codex',
    sessionId: started ? 'conversation-$id' : null,
    createdAt: DateTime.utc(2026, 9, 30, 12),
    closeSupported: true,
    terminalAvailable: true,
    resumeMode: 'conversation',
  );
  setUp(() {
    connection = _CloseConnection();
    app = createApp(connected: true, connectionForTest: (_) => connection);
    connection.app = app;
    app.stateOf('m')!.agents = [agent('a0'), agent('a1')];
  });
  tearDown(() => app.dispose());
  List<Object?> modes() => connection.closes.map((r) => r['mode']).toList();

  test(
    'without a close presenter an unsupported decision keeps its pane intact',
    () async {
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await app.requestClosePane(pane.id);
      expect(app.panes, [pane]);
      expect(connection.closes, isEmpty);
    },
  );

  testWidgets(
    'idle Close saves the recently closed layout despite an early deleted event',
    (tester) async {
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      unawaited(app.requestClosePane(pane.id));
      await tester.pumpAndSettle();
      expect(modes(), ['inspect', 'idle']);
      expect(app.allPanes, isEmpty);
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
        isTrue,
      );
      expect(app.closedHistory, hasLength(1));
      expect(app.canReopenLastClosed, isTrue);
      expect(find.text('Close session'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'working Close starts with Cancel focused and Enter keeps work alive',
    (tester) async {
      connection.activities['a0'] = 'working';
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      unawaited(app.requestClosePane(pane.id));
      await tester.pumpAndSettle();
      expect(find.text('1 session is still working.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Stop'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget);
      expect(find.text('Close session'), findsNothing);
      expect(find.text('Stop after finishing'), findsNothing);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
            .focusNode!
            .hasFocus,
        isTrue,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.panes, [pane]);
      expect(modes(), ['inspect']);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('closing a mixed tab saves its work and dismisses the monitor', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [
      agent('a0'),
      Agent(
        id: 'a1',
        name: harnessMonitorName,
        dsh: harnessMonitorId,
        engine: 'opencode',
        createdAt: DateTime.utc(2026, 10, 1),
        closeSupported: true,
        terminalAvailable: true,
      ),
    ];
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    final tab = app.activeSwarm;
    await mount(tester, app);
    unawaited(app.requestCloseSwarm(tab.id));
    await tester.pumpAndSettle();
    expect(app.swarms, isNot(contains(tab)));
    expect(modes(), ['inspect', 'idle']);
    expect(connection.closes.every((r) => r['agentId'] == 'a0'), isTrue);
    expect(
      app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a1').isStopped,
      isFalse,
    );
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an unused idle Companions chat closes its whole tab directly', (
    tester,
  ) async {
    app.stateOf('m')!.agents = [agent('a0', started: false)];
    final pane = app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    // Bind the live utility tab after startup's experimental-feature gate.
    final tab = app.activeSwarm
      ..kind = 'companions'
      ..name = 'companions';
    await app.requestClosePane(pane.id);
    await tester.pumpAndSettle();
    expect(modes(), ['inspect', 'idle']);
    expect(connection.closes.every((r) => r['sessionId'] == ''), isTrue);
    expect(app.swarms, isNot(contains(tab)));
    expect(app.allPanes, isEmpty);
    expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
    expect(app.closedHistory, hasLength(1));
    expect(find.widgetWithText(FilledButton, 'Stop'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  for (final entry in {
    'working': '1 session is still working.',
    'needs_input': '1 session is waiting for input.',
    'draft': '1 session has unsent text.',
    'unknown': '1 session may still be working.',
  }.entries) {
    testWidgets('${entry.key} Close sends only the reviewed action', (
      tester,
    ) async {
      connection.activities['a0'] = entry.key;
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      unawaited(app.requestClosePane(pane.id));
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget);
      expect(modes(), ['inspect']);
      await tester.tap(find.widgetWithText(FilledButton, 'Stop'));
      await tester.pumpAndSettle();
      expect(modes(), ['inspect', 'now']);
      expect(app.allPanes, isEmpty);
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
        isTrue,
      );
      expect(app.closedHistory, hasLength(1));
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('a failed disk checkpoint leaves the pane and explains why', (
    tester,
  ) async {
    connection.failures['idle'] = {
      'error': 'HISTORY_NOT_SAVED',
      'detail': 'Not enough free disk space.',
    };
    final pane = app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    unawaited(app.requestClosePane(pane.id));
    await tester.pumpAndSettle();
    expect(find.text('Not enough free disk space.'), findsOneWidget);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(app.panes, [pane]);
    expect(app.closedHistory, isEmpty);
    expect(modes(), ['inspect', 'idle']);
    expect(connection.requests, isNot(contains('agents_list')));
    await tester.pumpWidget(const SizedBox());
  });

  for (final closeTab in [false, true]) {
    testWidgets(
      'a session that starts working can still close its ${closeTab ? 'tab' : 'pane'} after review',
      (tester) async {
        connection.failures['idle'] = {
          'error': 'SESSION_NOT_IDLE',
          'activity': 'working',
        };
        final pane = app.adoptSessionForTest(terminal('a0', []));
        await mount(tester, app);
        unawaited(
          closeTab
              ? app.requestCloseSwarm(app.activeSwarmId)
              : app.requestClosePane(pane.id),
        );
        await tester.pumpAndSettle();
        expect(find.text('1 session is still working.'), findsOneWidget);
        expect(app.panes, [pane]);
        expect(modes(), ['inspect', 'idle']);
        await tester.tap(find.byKey(const Key('session-close-now')));
        await tester.pumpAndSettle();
        expect(modes(), ['inspect', 'idle', 'now']);
        expect(app.allPanes, isEmpty);
        expect(app.closedHistory, hasLength(1));
        expect(connection.requests, isNot(contains('agents_list')));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('Cancel after activity changes leaves the session running', (
    tester,
  ) async {
    connection.failures['idle'] = {
      'error': 'SESSION_NOT_IDLE',
      'activity': 'draft',
    };
    final pane = app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    unawaited(app.requestClosePane(pane.id));
    await tester.pumpAndSettle();
    expect(find.text('1 session has unsent text.'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(modes(), ['inspect', 'idle']);
    expect(app.panes, [pane]);
    expect(app.closedHistory, isEmpty);
    expect(app.stateOf('m')!.agents.first.isStopped, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'a tab switch during an idle check cannot close the newly selected tab',
    (tester) async {
      final first = app.adoptSessionForTest(terminal('a0', []));
      final original = app.activeSwarm;
      connection.inspecting = Completer();
      await mount(tester, app);
      final closing = app.requestClosePane(first.id);
      await tester.pump();
      app.newSwarm();
      final next = app.activeSwarm;
      final second = app.adoptSessionForTest(terminal('a1', []));
      connection.inspecting!.complete({'activity': 'idle'});
      await tester.pumpAndSettle();
      await closing;
      expect(app.activeSwarm, same(next));
      expect(app.panes, [second]);
      expect(app.swarms, isNot(contains(original)));
      expect(connection.closes.every((r) => r['agentId'] == 'a0'), isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('Close also removes the session from another hidden tab', (
    tester,
  ) async {
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final original = app.activeSwarm;
    app.newSwarm();
    app.activeSwarm.panes.add(pane);
    app.activeSwarm.focusedPaneId = pane.id;
    await mount(tester, app);
    await app.requestClosePane(pane.id);
    await tester.pumpAndSettle();
    expect(modes(), ['inspect', 'idle']);
    expect(app.allPanes, isEmpty);
    expect(app.swarms, isNot(contains(original)));
    expect(
      app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
      isTrue,
    );
    await tester.pumpWidget(const SizedBox());
  });

  for (final stop in [false, true]) {
    testWidgets(
      'one mixed-tab review ${stop ? 'stops' : 'keeps'} all sessions',
      (tester) async {
        app.stateOf('m')!.agents.add(agent('a2'));
        connection.activities.addAll({'a0': 'working', 'a1': 'working'});
        for (final id in ['a0', 'a1', 'a2']) {
          app.adoptSessionForTest(terminal(id, []));
        }
        final tab = app.activeSwarm;
        app.renameSwarm(tab.id, 'Release');
        await mount(tester, app);
        unawaited(app.requestCloseSwarm(tab.id));
        // Repeated Close shares the same pending review.
        unawaited(app.requestCloseSwarm(tab.id));
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsOneWidget);
        expect(find.text('2 sessions are still working.'), findsOneWidget);
        expect(
          find.text(
            'Stopping all 3 sessions will close the tab “Release”. History will be saved.',
          ),
          findsOneWidget,
        );
        for (final id in ['a0', 'a1']) {
          expect(
            find.descendant(
              of: find.byType(Dialog),
              matching: find.text('Work $id'),
            ),
            findsOneWidget,
          );
        }
        expect(modes(), ['inspect', 'inspect', 'inspect']);
        expect(find.widgetWithText(FilledButton, 'Stop'), findsOneWidget);
        await tester.tap(find.text(stop ? 'Stop' : 'Cancel'));
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing);
        if (stop) {
          expect(modes(), [
            'inspect',
            'inspect',
            'inspect',
            'now',
            'now',
            'now',
          ]);
          expect(app.allPanes, isEmpty);
          expect(app.swarms, isNot(contains(tab)));
          expect(
            app.stateOf('m')!.agents.every((agent) => agent.isStopped),
            isTrue,
          );
          expect(app.closedHistory, hasLength(1));
        } else {
          expect(app.panes, hasLength(3));
          expect(modes(), ['inspect', 'inspect', 'inspect']);
          expect(
            app.stateOf('m')!.agents.any((agent) => agent.isStopped),
            isFalse,
          );
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets('an idle tab closes every session without a prompt', (
    tester,
  ) async {
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    final tab = app.activeSwarm;
    await mount(tester, app);
    await app.requestCloseSwarm(tab.id);
    await tester.pumpAndSettle();
    expect(find.byType(Dialog), findsNothing);
    expect(modes(), ['inspect', 'inspect', 'idle', 'idle']);
    expect(app.swarms, isNot(contains(tab)));
    expect(app.allPanes, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an inspection failure stops no member of the tab', (
    tester,
  ) async {
    connection.activities['a0'] = 'working';
    connection.targetedFailures[('a1', 'inspect')] = {
      'error': 'CLOSE_UNCONFIRMED',
      'detail': 'Could not reach the machine.',
    };
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    unawaited(app.requestCloseSwarm(app.activeSwarmId));
    await tester.pumpAndSettle();
    expect(find.text('Could not reach the machine.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Stop'), findsNothing);
    expect(modes(), ['inspect', 'inspect']);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(app.panes, hasLength(2));
    expect(app.stateOf('m')!.agents.any((agent) => agent.isStopped), isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a partial failure keeps the tab and names confirmed stops', (
    tester,
  ) async {
    connection.activities.addAll({'a0': 'working', 'a1': 'working'});
    connection.targetedFailures[('a1', 'now')] = {
      'error': 'HISTORY_NOT_SAVED',
      'detail': 'Not enough free disk space.',
    };
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    final tab = app.activeSwarm;
    await mount(tester, app);
    unawaited(app.requestCloseSwarm(tab.id));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Stop'));
    await tester.pumpAndSettle();
    expect(find.text('Not enough free disk space.'), findsOneWidget);
    expect(find.text('Stopped'), findsOneWidget);
    expect(find.text('Stop not confirmed'), findsOneWidget);
    expect(find.text('The tab stays open.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Stop'), findsNothing);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(app.swarms, contains(tab));
    expect(tab.panes, hasLength(2));
    expect(
      app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
      isTrue,
    );
    expect(
      app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a1').isStopped,
      isFalse,
    );
    expect(app.closedHistory, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'new work during an idle close reviews all remaining sessions once',
    (tester) async {
      app.stateOf('m')!.agents.add(agent('a2'));
      connection.targetedFailures[('a1', 'idle')] = {
        'error': 'SESSION_NOT_IDLE',
        'activity': 'working',
      };
      for (final id in ['a0', 'a1', 'a2']) {
        app.adoptSessionForTest(terminal(id, []));
      }
      final tab = app.activeSwarm;
      app.renameSwarm(tab.id, 'Release');
      await mount(tester, app);
      unawaited(app.requestCloseSwarm(tab.id));
      await tester.pumpAndSettle();
      expect(find.text('1 session is still working.'), findsOneWidget);
      expect(
        find.text(
          'Stopping all 2 sessions will close the tab “Release”. History will be saved.',
        ),
        findsOneWidget,
      );
      expect(find.text('1 session has already closed.'), findsOneWidget);
      expect(modes(), [
        'inspect',
        'inspect',
        'inspect',
        'idle',
        'idle',
        'inspect',
      ]);
      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();
      expect(modes(), [
        'inspect',
        'inspect',
        'inspect',
        'idle',
        'idle',
        'inspect',
        'now',
        'now',
      ]);
      expect(find.byType(Dialog), findsNothing);
      expect(app.allPanes, isEmpty);
      expect(app.swarms, isNot(contains(tab)));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
