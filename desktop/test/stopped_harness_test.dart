import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';

import 'support/restart_connection.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppNotifier app;
  late RestartConnection connection;
  var disposed = false;
  const stopped = Agent(
    id: 'saved',
    name: 'Saved work',
    engine: 'codex',
    sessionId: 'original-conversation',
    status: 'stopped',
    project: AgentProject(name: 'Project', cwd: '/work/project'),
  );
  setUp(() {
    disposed = false;
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
    app.machineStates['m']!.agents.add(stopped);
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });

  SwarmDestination row() =>
      swarmDestinations(app).firstWhere((row) => row.agentId == stopped.id);

  test('stopped harnesses remain searchable alongside live ones', () {
    final rows = swarmDestinations(app);
    expect(rows.any((row) => row.agentId == 'a0'), isTrue);
    expect(row().detail, isNot(contains('Stopped')));
    expect(row().terminalDetail, isNot(contains('Stopped')));
    expect(row().promptContext?.leading, isNot('Stopped'));
    expect(SwarmSearchController.action(row()), 'Open Harness');
    final picker = SwarmSearchController(app, const [], adding: true);
    addTearDown(picker.dispose);
    expect(
      picker.actionLabel(row()),
      picker.actionLabel(rows.firstWhere((row) => row.agentId == 'a0')),
    );
    expect(rankSwarmDestinations(rows, 'saved').single.agentId, 'saved');
    expect(app.allPanes, isEmpty);
    expect(connection.requests, isEmpty);
  });

  test(
    'a retained stop refreshes the saved row after closing its live view',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>();
      await app.handleEventForTest('m', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'a0', 'retained': true},
      });
      connection.inventory!.complete({
        'agents': [
          {
            'id': 'a0',
            'name': 'Stopped now',
            'engine': 'codex',
            'sessionId': 'original-conversation',
            'status': 'stopped',
            'terminal': {'available': false},
          },
        ],
      });
      await Future<void>.delayed(Duration.zero);
      expect(app.stateOf('m')!.agents.single.isStopped, isTrue);
      expect(swarmDestinations(app).any((row) => row.agentId == 'a0'), isTrue);
      expect(app.allPanes, isEmpty);
    },
  );

  for (final placement in HarnessPlacement.values) {
    test('Enter resumes directly before opening ${placement.name}', () async {
      final target = app.activeSwarmId;
      final opening = activateSwarmSearchSelection(
        app,
        SwarmSearchSelection(row()),
        destinationSwarmId: target,
        placement: placement,
      );
      expect(connection.requests, hasLength(1));
      final request = connection.requests.single;
      expect(connection.types, ['agent_resume']);
      expect(request['agentId'], 'saved');
      expect(app.allPanes, isEmpty);
      connection.restartReplies.single.complete(
        restartReceipt(
          request['creationId'] as String,
          agentId: 'saved',
          sessionId: 'original-conversation',
        ),
      );
      expect(await opening, isTrue);
      expect(app.allPanes.single.agentId, 'saved');
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'saved').isStopped,
        isFalse,
      );
    });
  }

  test(
    'a failed resume retains saved work and allocates no empty tab',
    () async {
      final tabs = app.swarms.length;
      final opening = activateSwarmSearchSelection(
        app,
        SwarmSearchSelection(row()),
        destinationSwarmId: app.activeSwarmId,
        placement: HarnessPlacement.newTab,
      );
      final refusal = expectLater(opening, throwsA(isA<SwarmResumeFailure>()));
      connection.restartReplies.single.complete({
        'creationId': connection.requests.single['creationId'],
        'state': 'failed',
        'failure': {
          'code': 'RESUME_UNAVAILABLE',
          'detail': 'Conversation missing',
        },
      });
      await refusal;
      expect(app.swarms, hasLength(tabs));
      expect(app.allPanes, isEmpty);
      expect(row().agentId, 'saved');
      expect(connection.requests, hasLength(1));
    },
  );

  test(
    'Enter on a running harness attaches without a restart request',
    () async {
      final active = swarmDestinations(app)
          .firstWhere((row) => row.agentId == 'a0');
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(active),
          destinationSwarmId: app.activeSwarmId,
          placement: HarnessPlacement.currentTab,
        ),
        isTrue,
      );
      expect(app.allPanes.single.agentId, 'a0');
      expect(connection.requests, isEmpty);
    },
  );

  test(
    'repeated Enter joins one request; a lost reply checks its receipt',
    () async {
      final first = app.resumeAgent('m', 'saved');
      final second = app.resumeAgent('m', 'saved');
      expect(identical(first, second), isTrue);
      expect(connection.types, ['agent_resume']);
      final creationId = connection.requests.single['creationId'];
      connection.restartReplies.single.completeError(
        Exception('lost response'),
      );
      expect((await first).error, isNotNull);
      final checking = app.resumeAgent('m', 'saved');
      expect(connection.types, ['agent_resume']);
      expect(connection.checks, hasLength(1));
      expect(connection.checks.single['creationId'], creationId);
      connection.checkReplies.single.complete(
        restartReceipt(
          creationId as String,
          agentId: 'saved',
          sessionId: 'original-conversation',
        ),
      );
      expect((await checking).error, isNull);
    },
  );

  test('native login or hook review is visible while conversation confirmation is pending', () async {
    final opening = activateSwarmSearchSelection(
      app,
      SwarmSearchSelection(row()),
      destinationSwarmId: app.activeSwarmId,
      placement: HarnessPlacement.currentTab,
    );
    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'payload': {
        'agent': {
          'id': 'saved',
          'name': 'Saved work',
          'engine': 'codex',
          'sessionId': 'original-conversation',
          'launch': {'state': 'starting'},
          'terminal': {'available': true},
        },
      },
    });
    expect(await opening, isTrue);
    expect(app.allPanes.single.agentId, 'saved');
    expect(connection.restartReplies.single.isCompleted, isFalse);
    connection.restartReplies.single.complete(
      restartReceipt(
        connection.requests.single['creationId'] as String,
        agentId: 'saved',
        sessionId: 'original-conversation',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(connection.types, ['agent_resume']);
  });

  test(
    'a different conversation push cannot open an unconfirmed resume',
    () async {
      final opening = activateSwarmSearchSelection(
        app,
        SwarmSearchSelection(row()),
        destinationSwarmId: app.activeSwarmId,
        placement: HarnessPlacement.newTab,
      );
      final failed = expectLater(opening, throwsA(isA<SwarmResumeFailure>()));
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'saved',
            'name': 'Different work',
            'engine': 'codex',
            'sessionId': 'other-conversation',
            'launch': {'state': 'starting'},
            'terminal': {'available': true},
          },
        },
      });
      expect(app.allPanes, isEmpty);
      connection.restartReplies.single.complete({
        'creationId': connection.requests.single['creationId'],
        'state': 'failed',
        'failure': {'code': 'RESUME_SESSION_MISMATCH'},
      });
      await failed;
      expect(app.allPanes, isEmpty);
    },
  );

  test('never accepts a fresh conversation as a successful resume', () async {
    final opening = app.resumeAgent('m', 'saved');
    connection.restartReplies.single.complete(
      restartReceipt(
        connection.requests.single['creationId'] as String,
        agentId: 'saved',
        sessionId: 'unexpected-conversation',
      ),
    );
    expect((await opening).error, isNotNull);
    expect(
      app.stateOf('m')!.agents.firstWhere((a) => a.id == 'saved').sessionId,
      'original-conversation',
    );
    expect(app.allPanes, isEmpty);
  });

  test(
    'retained-session pushes preserve existing pane intent and searchability',
    () async {
      await app.handleEventForTest('m', {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'saved',
            'name': 'Saved work',
            'engine': 'codex',
            'sessionId': 'original-conversation',
            'status': 'stopped',
            'terminal': {'available': false},
          },
        },
      });
      expect(row().agentId, 'saved');
      expect(connection.requests, isEmpty);
    },
  );

  for (final key in [LogicalKeyboardKey.keyO, LogicalKeyboardKey.keyT]) {
    testWidgets(
      '${key.keyLabel} opens retained work with Enter and preserves other panes',
      (tester) async {
        final existing = app.adoptSessionForTest(terminal('a0', []));
        final originalTab = app.activeSwarmId;
        await mount(tester, app);
        await chord(tester, key);
        if (key == LogicalKeyboardKey.keyT) {
          await chord(tester, LogicalKeyboardKey.keyO);
        }
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'Saved work',
        );
        await tester.pump();
        expect(find.textContaining('Stopped'), findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(connection.types, ['agent_resume']);
        expect(find.byType(AlertDialog), findsNothing);
        connection.restartReplies.single.complete(
          restartReceipt(
            connection.requests.single['creationId'] as String,
            agentId: 'saved',
            sessionId: 'original-conversation',
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(app.allPanes.any((pane) => pane.agentId == 'saved'), isTrue);
        expect(app.allPanes.contains(existing), isTrue);
        expect(
          app.activeSwarmId == originalTab,
          key == LogicalKeyboardKey.keyO,
        );
        expect(connection.types, ['agent_resume']);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        disposed = true;
      },
    );
  }

  testWidgets('Enter submits resume immediately with no confirmation dialog', (
    tester,
  ) async {
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyT);
    await chord(tester, LogicalKeyboardKey.keyO);
    await tester.pump();
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      'Saved work',
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(connection.types, ['agent_resume']);
    expect(find.byType(AlertDialog), findsNothing);
    connection.restartReplies.single.complete({
      'creationId': connection.requests.single['creationId'],
      'state': 'failed',
      'failure': {
        'code': 'RESUME_UNAVAILABLE',
        'detail': 'Conversation missing',
      },
    });
    await tester.pump();
    expect(find.text('Conversation missing'), findsOneWidget);
    expect(find.text('Start New Conversation'), findsOneWidget);
    expect(app.allPanes, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
}
