import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/fork_connection.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ForkConnection connection;
  late AppNotifier app;
  bool disposed = false;
  setUp(() {
    connection = ForkConnection();
    app = createApp(connectionForTest: (_) => connection);
    disposed = false;
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });
  String getId() => connection.forks.last['creationId'] as String;

  test('one fork request joins across views and a completed intent cannot fork twice', () async {
    app.adoptSessionForTest(terminal('a0', []));
    final attempt = app.forkAttempt(
      'm',
      'a0',
      name: 'Separate idea',
      prompt: '  keep\n  whitespace  ',
    );
    final first = app.forkAgent('m', 'a0', attempt: attempt);
    expect(app.forkAgent('m', 'a0', attempt: attempt), same(first));
    expect(
      (await app.forkAgent('m', 'a0', name: 'Different')).error,
      contains('original fork'),
    );
    expect(connection.forks, hasLength(1));
    expect(connection.forks.single['prompt'], '  keep\n  whitespace  ');
    connection.forkReplies.single.complete(forkReceipt(getId()));
    final result = await first;
    expect(result.error, isNull);
    expect(app.panes.map((pane) => pane.agentId), ['a0', 'forked']);
    expect(app.focusedPane!.agentId, 'forked');
    expect(await app.forkAgent('m', 'a0', attempt: attempt), same(result));
    expect(connection.forks, hasLength(1));
  });

  test(
    'lost receipts only check status and preserve the returned handoff level',
    () async {
      final attempt = app.forkAttempt('m', 'a0', name: 'Separate idea');
      final first = app.forkAgent('m', 'a0', attempt: attempt);
      final id = getId();
      connection.forkReplies.single.completeError(
        const WsRequestTimeout('agent_fork'),
      );
      expect((await first).error, contains('not confirmed'));
      expect(attempt.awaitingConfirmation, isTrue);
      expect(app.forkAttempt('m', 'a0'), same(attempt));
      var check = app.forkAgent('m', 'a0', attempt: attempt);
      connection.checkReplies.last.complete({
        'creationId': id,
        'state': 'pending',
      });
      expect((await check).error, contains('still starting'));
      check = app.forkAgent('m', 'a0', attempt: attempt);
      connection.checkReplies.last.complete(forkReceipt(id, level: 'handoff'));
      expect((await check).level, 'handoff');
      expect(connection.forks, hasLength(1));
      expect(connection.checks, [
        {'creationId': id},
        {'creationId': id},
      ]);
    },
  );

  for (final state in [
    'missing',
    'unconfirmed',
    'wrong receipt',
    'malformed',
  ]) {
    test('$state never allows an implicit second fork', () async {
      final attempt = app.forkAttempt('m', 'a0', name: 'Separate idea');
      var request = app.forkAgent('m', 'a0', attempt: attempt);
      connection.forkReplies.single.complete(switch (state) {
        'wrong receipt' => forkReceipt('not-this-intent'),
        'malformed' => {'creationId': getId(), 'state': 'created', 'agent': {}},
        _ => {'creationId': getId(), 'state': state},
      });
      expect((await request).error, isNotNull);
      expect(attempt.locked, isTrue);
      request = app.forkAgent('m', 'a0', attempt: attempt);
      connection.checkReplies.last.complete({'error': 'UNKNOWN_TYPE'});
      expect((await request).error, isNotNull);
      expect(connection.forks, hasLength(1));
      expect(app.discardForkAttempt('m', 'a0', attempt), isTrue);
      final fresh = app.forkAttempt('m', 'a0', name: 'Another');
      request = app.forkAgent('m', 'a0', attempt: fresh);
      connection.forkReplies.last.complete(
        forkReceipt(getId(), agentId: 'another'),
      );
      expect((await request).error, isNull);
      expect(connection.forks, hasLength(2));
    });
  }

  test(
    'a confirmed refusal unlocks the draft and retry has a new receipt',
    () async {
      final attempt = app.forkAttempt(
        'm',
        'a0',
        name: 'Separate idea',
        prompt: 'retry me',
      );
      var request = app.forkAgent('m', 'a0', attempt: attempt);
      final id = getId();
      connection.forkReplies.single.complete({
        'creationId': id,
        'state': 'failed',
        'failure': {'code': 'BUSY', 'detail': 'Try later'},
      });
      expect((await request).error, 'Try later');
      expect(attempt.locked, isFalse);
      expect(attempt.prompt, 'retry me');
      request = app.forkAgent('m', 'a0', attempt: attempt);
      expect(getId(), isNot(id));
      connection.forkReplies.last.complete(forkReceipt(getId()));
      expect((await request).error, isNull);
    },
  );

  for (final change in ['switch', 'close', 'focus', 'full']) {
    test('a delayed fork respects its original tab after $change', () async {
      app.adoptSessionForTest(terminal('a0', []));
      final source = app.activeSwarm;
      final request = app.forkAgent('m', 'a0');
      if (change == 'close') await app.closeSwarm(source.id);
      if (change == 'switch') {
        app.newSwarm(name: 'Other work');
        app.adoptSessionForTest(terminal('a1', []));
      }
      if (change == 'focus') app.adoptSessionForTest(terminal('a1', []));
      if (change == 'full') {
        for (var i = 1; i < AppNotifier.maxPanes; i++) {
          app.adoptSessionForTest(terminal('a$i', []));
        }
      }
      final active = app.activeSwarmId;
      final focused = app.focusedPane;
      connection.forkReplies.single.complete(forkReceipt(getId()));
      final result = await request;
      expect(result.error, isNull);
      expect(app.activeSwarmId, active);
      expect(app.focusedPane, same(focused));
      if (change == 'switch' || change == 'focus') {
        expect(source.panes.any((pane) => pane.agentId == 'forked'), isTrue);
      } else {
        expect(app.allPanes.any((pane) => pane.agentId == 'forked'), isFalse);
        expect(result.notice, contains('Fork created'));
      }
    });
  }

  for (final change in ['machine', 'session', 'removed', 'dispose']) {
    test('a draft cannot start after its source changes by $change', () async {
      final attempt = app.forkAttempt('m', 'a0', name: 'Separate idea');
      if (change == 'machine') {
        app.machineStates['m'] = MachineState(app.stateOf('m')!.machine);
      }
      if (change == 'session') {
        app.stateOf('m')!.agents = [
          const Agent(
            id: 'a0',
            name: 'Replacement',
            engine: 'codex',
            sessionId: 'new',
          ),
        ];
      }
      if (change == 'removed') {
        await app.handleEventForTest('m', {
          'type': 'agent_deleted',
          'payload': {'agentId': 'a0'},
        });
      }
      if (change == 'dispose') {
        app.dispose();
        disposed = true;
      }
      expect(
        (await app.forkAgent('m', 'a0', attempt: attempt)).error,
        isNotNull,
      );
      expect(connection.forks, isEmpty);
    });
  }

  test('late fork reply cannot update a replacement machine', () async {
    final request = app.forkAgent('m', 'a0');
    final replacement = MachineState(app.stateOf('m')!.machine);
    app.machineStates['m'] = replacement;
    connection.forkReplies.single.complete(forkReceipt(getId()));
    expect((await request).error, contains('machine changed'));
    expect(replacement.agents, isEmpty);
    expect(app.allPanes, isEmpty);
  });

  for (final change in ['removed', 'recreated', 'renamed']) {
    test('a late fork receipt cannot undo a $change child', () async {
      final request = app.forkAgent('m', 'a0');
      await app.handleEventForTest('m', {
        'type': 'agent_created',
        'payload': {'agent': forkReceipt(null)['agent']},
      });
      if (change == 'renamed') {
        await app.handleEventForTest('m', {
          'type': 'agent_renamed',
          'payload': {'agentId': 'forked', 'name': 'Fresh name'},
        });
      } else {
        await app.handleEventForTest('m', {
          'type': 'agent_deleted',
          'payload': {'agentId': 'forked'},
        });
        if (change == 'recreated') {
          app
              .stateOf('m')!
              .agents
              .add(
                const Agent(
                  id: 'forked',
                  name: 'Replacement fork',
                  sessionId: 'new',
                  engine: 'codex',
                ),
              );
        }
      }
      connection.forkReplies.single.complete(forkReceipt(getId()));
      final result = await request;
      expect(result.error, isNull);
      final child = app
          .stateOf('m')!
          .agents
          .where((agent) => agent.id == 'forked')
          .firstOrNull;
      expect(child?.name, switch (change) {
        'renamed' => 'Fresh name',
        'recreated' => 'Replacement fork',
        _ => null,
      });
      if (change != 'renamed') {
        expect(result.notice, contains('has since stopped'));
        expect(app.allPanes, isEmpty);
      }
    });
  }
}
