import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'viewer_app_fixture.dart';

/// What a machine's pushes do to the phone, in the orders they can arrive in:
/// agents appearing, changing and going; turns and questions; the machine
/// itself dropping out and coming back.
void main() {
  List<String> agentIds(AppNotifier app, String machineId) => [
    for (final agent in app.stateOf(machineId)!.agents) agent.id,
  ];

  Agent agentOf(AppNotifier app, String machineId, String agentId) =>
      app.stateOf(machineId)!.agents.firstWhere((a) => a.id == agentId);

  group('agents, in whatever order they are announced', () {
    test('a created agent is one row, however often it is announced', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      for (var i = 0; i < 2; i++) {
        await push(rig, 'm', 'agent_created', {'agent': agentJson('x')});
      }

      expect(agentIds(rig.app, 'm'), ['a', 'x']);
      expect(agentOf(rig.app, 'm', 'x').terminalAvailable, isTrue);
    });

    test(
      'a created agent without its terminal is read again from the list',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final before = rig.conn('m').payloadsOf('agents_list').length;

        await push(rig, 'm', 'agent_created', {
          'agent': {'id': 'x', 'name': 'x'},
        });
        await settle();

        expect(rig.conn('m').payloadsOf('agents_list').length, before + 1);
      },
    );

    test('a sync for an agent not yet listed adds it', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'agent_synced', {'agent': agentJson('late')});

      expect(agentIds(rig.app, 'm'), ['a', 'late']);
    });

    test('a push the phone cannot read sends it back to the list', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final before = rig.conn('m').payloadsOf('agents_list').length;

      await push(rig, 'm', 'agent_synced', {
        'agent': {'name': 'no id'},
      });
      await push(rig, 'm', 'agent_synced');
      await push(rig, 'm', 'agent_created', {
        'agent': {'terminal': <String, dynamic>{}},
      });
      await push(rig, 'm', 'agent_renamed', {'agentId': 'a'});
      await push(rig, 'm', 'agent_deleted');
      await settle();

      expect(
        rig.conn('m').payloadsOf('agents_list').length,
        greaterThan(before),
      );
      expect(agentIds(rig.app, 'm'), ['a']);
    });

    test('a rename for an agent it has never heard of is dropped', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'agent_renamed', {'agentId': 'ghost', 'name': 'x'});
      await push(rig, 'm', 'agent_renamed', {'agentId': 'a', 'name': '   '});

      expect(agentIds(rig.app, 'm'), ['a']);
      expect(agentOf(rig.app, 'm', 'a').name, 'a');
    });

    test('a rename reaches the terminal showing that agent', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');

      await push(rig, 'm', 'agent_renamed', {'agentId': 'a', 'name': ' api '});

      expect(agentOf(rig.app, 'm', 'a').name, 'api');
      expect(session.agentName, 'api');
    });

    test('a delete for an agent it never had changes nothing', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'agent_deleted', {'agentId': 'ghost'});

      expect(agentIds(rig.app, 'm'), ['a']);
    });

    test(
      'a deleted agent takes its terminal, without a close to a dead stream',
      () async {
        final rig = await signedInWith({
          'm': ['a', 'b'],
        });
        addTearDown(rig.app.dispose);
        await openAgent(rig, 'm', 'a');
        final closesBefore = rig
            .conn('m')
            .frames
            .where((frame) => frame.$1 == 'terminal_close')
            .length;

        await push(rig, 'm', 'agent_deleted', {'agentId': 'a'});

        expect(agentIds(rig.app, 'm'), ['b']);
        expect(rig.app.paneOfAgent('m', 'a'), isNull);
        expect(
          rig.conn('m').frames.where((frame) => frame.$1 == 'terminal_close'),
          hasLength(closesBefore),
        );
      },
    );

    test('a delete named by session alone finds its agent', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);
      await push(rig, 'm', 'agent_synced', {
        'agent': agentJson('a', sessionId: 's-a'),
      });

      await push(rig, 'm', 'agent_deleted', {'sessionId': 's-a'});

      expect(agentIds(rig.app, 'm'), isEmpty);
    });

    test('a stopped harness the machine kept is read back, and stays on the phone', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      // What the machine lists once `a` has stopped: it kept the work, stopped.
      rig.conn('m').answers['agents_list'] = (_) => {
        'agents': [
          agentJson('a', status: 'stopped', terminal: false, sessionId: 's-a'),
          agentJson('b'),
        ],
      };

      // The daemon's `forgetSession`: the live agent goes, its work is kept.
      await push(rig, 'm', 'agent_deleted', {'agentId': 'a', 'retained': true});
      await settle();

      expect(agentIds(rig.app, 'm'), containsAll(['a', 'b']));
      expect(agentOf(rig.app, 'm', 'a').isStopped, isTrue);
    });

    test('a delete the machine did not keep is not read back', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      final before = rig.conn('m').payloadsOf('agents_list').length;

      await push(rig, 'm', 'agent_deleted', {'agentId': 'a'});
      await settle();

      expect(rig.conn('m').payloadsOf('agents_list'), hasLength(before));
      expect(agentIds(rig.app, 'm'), ['b']);
    });

    test(
      'a stop pushed as a sync keeps the row and lets go of its terminal',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await openAgent(rig, 'm', 'a');

        await push(rig, 'm', 'agent_synced', {
          'agent': agentJson('a', status: 'stopped', terminal: false),
        });

        expect(agentOf(rig.app, 'm', 'a').isStopped, isTrue);
        final pane = rig.app.paneOfAgent('m', 'a');
        expect(pane, isNotNull, reason: 'the page stays, to offer the resume');
        expect(pane!.session, isNull);
        expect(
          rig.conn('m').frames.where((frame) => frame.$1 == 'terminal_close'),
          isEmpty,
        );
      },
    );

    test('a terminal coming back re-attaches the page left waiting', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      await openAgent(rig, 'm', 'a');
      await push(rig, 'm', 'agent_synced', {
        'agent': agentJson('a', terminal: false),
      });
      final opensBefore = rig.conn('m').opens.length;

      await push(rig, 'm', 'agent_synced', {'agent': agentJson('a')});
      await settle();

      final session = rig.app.paneOfAgent('m', 'a')!.session;
      expect(session, isNotNull);
      session!.reportViewport(80, 24);
      await settle();
      expect(rig.conn('m').opens.length, opensBefore + 1);
      expect(
        rig.conn('m').opens.last['takeover'],
        isFalse,
        reason: 'nobody on this phone asked: it must not take the terminal',
      );
    });

    test(
      'a failed launch is said once, and retrying the list cannot fix it',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);
        final failed = agentJson(
          'x',
          extra: {
            'launch': {'state': 'failed', 'detail': 'codex is not installed'},
          },
        );

        await push(rig, 'm', 'agent_synced', {'agent': failed});
        expect(rig.app.lastError, 'codex is not installed');
        expect(rig.app.lastErrorRetryable, isFalse);

        rig.app.dismissError();
        await push(rig, 'm', 'agent_synced', {'agent': failed});
        expect(
          rig.app.lastError,
          isNull,
          reason: 'the same failure is not news',
        );
      },
    );
  });

  group('turns and questions', () {
    test(
      'a turn begun before its agent was listed is bound once it is',
      () async {
        final rig = await signedInWith({'m': []});
        addTearDown(rig.app.dispose);

        await push(rig, 'm', 'turn_started', {'sessionId': 's-a'});
        expect(rig.app.agentIsProcessing('m', 'a'), isFalse);

        rig.conn('m').answers['agents_list'] = (_) => {
          'agents': [agentJson('a', sessionId: 's-a')],
        };
        await rig.app.reloadMachineData('m');

        expect(rig.app.agentIsProcessing('m', 'a'), isTrue);
      },
    );

    test('a turn that ends before its agent is listed is forgotten', () async {
      final rig = await signedInWith({'m': []});
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'turn_started', {'sessionId': 's-a'});
      await push(rig, 'm', 'turn_ended', {'sessionId': 's-a'});
      rig.conn('m').answers['agents_list'] = (_) => {
        'agents': [agentJson('a', sessionId: 's-a')],
      };
      await rig.app.reloadMachineData('m');

      expect(rig.app.agentIsProcessing('m', 'a'), isFalse);
    });

    test(
      'a sync that binds the session picks up the turn waiting on it',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);

        await push(rig, 'm', 'turn_started', {'sessionId': 's-new'});
        await push(rig, 'm', 'agent_synced', {
          'agent': agentJson('a', sessionId: 's-new'),
        });

        expect(rig.app.agentIsProcessing('m', 'a'), isTrue);
      },
    );

    test(
      'a heartbeat renews a turn without redrawing, and a silent one ends',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        }, turnActivityTimeout: const Duration(milliseconds: 50));
        addTearDown(rig.app.dispose);
        await push(rig, 'm', 'turn_started', {'agentId': 'a'});
        var redraws = 0;
        rig.app.addListener(() => redraws++);

        await push(rig, 'm', 'turn_heartbeat', {'agentId': 'a'});
        expect(redraws, 0);
        expect(rig.app.agentIsProcessing('m', 'a'), isTrue);

        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(rig.app.agentIsProcessing('m', 'a'), isFalse);
        expect(redraws, 1);
      },
    );

    test('a question is held until its own close, not a stale one', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      Map<String, dynamic> question(String requestId) => {
        'agentId': 'a',
        'requestId': requestId,
        'questions': [
          {
            'q': 'Proceed?',
            'options': ['Yes', 'No'],
          },
        ],
      };

      await push(rig, 'm', 'commander_question', question('q1'));
      final asked = rig.app.questionFor('m', 'a');
      expect(asked, isNotNull);

      // Re-announced after a reconnect: the same wait, the same clock.
      await push(rig, 'm', 'commander_question', question('q1'));
      expect(rig.app.questionFor('m', 'a')!.since, asked!.since);

      await push(rig, 'm', 'commander_question_close', {
        'agentId': 'a',
        'requestId': 'q0',
      });
      expect(rig.app.questionFor('m', 'a'), isNotNull);

      await push(rig, 'm', 'commander_question_close', {
        'agentId': 'a',
        'requestId': 'q1',
      });
      expect(rig.app.questionFor('m', 'a'), isNull);
    });

    test('a question cannot outlive its turn', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      await push(rig, 'm', 'turn_started', {'agentId': 'a'});
      await push(rig, 'm', 'commander_question', {
        'agentId': 'a',
        'requestId': 'q1',
        'questions': [
          {
            'q': 'Proceed?',
            'options': ['Yes'],
          },
        ],
      });
      expect(rig.app.questionFor('m', 'a'), isNotNull);

      await push(rig, 'm', 'turn_ended', {'agentId': 'a'});

      expect(rig.app.questionFor('m', 'a'), isNull);
      expect(rig.app.agentIsProcessing('m', 'a'), isFalse);
      expect(rig.app.stateOf('m')!.agentActivityAt['a'], isNotNull);
    });
  });

  group('two machines with the same agent', () {
    test('each machine\'s pushes touch only its own', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'turn_started', {'agentId': 'a'});
      await push(rig, 'n', 'agent_renamed', {'agentId': 'a', 'name': 'other'});

      expect(rig.app.agentIsProcessing('m', 'a'), isTrue);
      expect(rig.app.agentIsProcessing('n', 'a'), isFalse);
      expect(agentOf(rig.app, 'm', 'a').name, 'a');
      expect(agentOf(rig.app, 'n', 'a').name, 'other');

      await push(rig, 'n', 'agent_deleted', {'agentId': 'a'});
      expect(agentIds(rig.app, 'm'), ['a']);
      expect(agentIds(rig.app, 'n'), isEmpty);
    });

    test('each terminal hears only its own machine\'s stream', () async {
      final rig = await signedInWith({
        'm': ['a'],
        'n': ['a'],
      });
      addTearDown(rig.app.dispose);
      final onM = await openAgent(rig, 'm', 'a');
      final onN = await openAgent(rig, 'n', 'a');
      expect(identical(onM, onN), isFalse);

      // A transport error on `m` is `m`'s alone.
      await push(rig, 'm', 'terminal_transport_error', {'code': 'gone'});

      expect(onM.status, TerminalSessionStatus.error);
      expect(onN.status, TerminalSessionStatus.controlling);
    });
  });

  group('the minute\'s safety net', () {
    test('a list that did not change redraws nothing', () async {
      final rig = await signedInWith({
        'm': ['a', 'b'],
      });
      addTearDown(rig.app.dispose);
      var redraws = 0;
      rig.app.addListener(() => redraws++);

      await rig.app.syncAgentsForTest('m');

      expect(redraws, 0);
    });

    // Each is drawn on the phone — a row's stats line, whether a stopped row
    // can be tapped, the model sheet's web-search sentence — and each changes
    // on a machine without the agent's name or state moving with it.
    for (final (field, before, after, read)
        in <
          (
            String,
            Map<String, dynamic>,
            Map<String, dynamic>,
            Object? Function(Agent),
          )
        >[
          (
            'its token count',
            {
              'tokenUsage': {'totalTokens': 100},
            },
            {
              'tokenUsage': {'totalTokens': 4200},
            },
            (a) => a.tokensUsed,
          ),
          (
            'when its tokens were counted',
            {
              'tokenUsage': {
                'totalTokens': 100,
                'updatedAt': '2026-09-27T10:00:00Z',
              },
            },
            {
              'tokenUsage': {
                'totalTokens': 100,
                'updatedAt': '2026-09-27T11:00:00Z',
              },
            },
            (a) => a.tokensUpdatedAt,
          ),
          (
            'what it has produced',
            {
              'outputStats': {'linesAdded': 1, 'linesRemoved': 0},
            },
            {
              'outputStats': {'linesAdded': 12, 'linesRemoved': 3},
            },
            (a) => a.outputStats?.linesAdded,
          ),
          (
            'how it resumes',
            {'resumeMode': 'fresh'},
            {'resumeMode': 'conversation'},
            (a) => a.resumeMode,
          ),
          (
            'whether it can search the web',
            {
              'grid': {'model': 'qwen3-coder', 'webSearch': 'on'},
            },
            {
              'grid': {'model': 'qwen3-coder', 'webSearch': 'unavailable'},
            },
            (a) => a.gridWebSearch,
          ),
        ]) {
      test('picks up a change to $field', () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        rig.conn('m').answers['agents_list'] = (_) => {
          'agents': [agentJson('a', extra: before)],
        };
        await rig.app.syncAgentsForTest('m');
        final was = read(agentOf(rig.app, 'm', 'a'));
        rig.conn('m').answers['agents_list'] = (_) => {
          'agents': [agentJson('a', extra: after)],
        };

        await rig.app.syncAgentsForTest('m');

        final now = read(agentOf(rig.app, 'm', 'a'));
        expect(was, isNotNull);
        expect(
          now,
          isNot(was),
          reason: 'a field the phone draws must not freeze at its first value',
        );
      });
    }

    test('a sync that fails for any other reason is quiet', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      rig.conn('m').answers['agents_list'] = (_) => throw StateError('dropped');
      var redraws = 0;
      rig.app.addListener(() => redraws++);

      await rig.app.syncAgentsForTest('m');
      await rig.app.syncAgentsForTest('ghost');

      expect(redraws, 0);
      expect(agentIds(rig.app, 'm'), ['a']);
      expect(rig.conn('m').redials, 0);
    });
  });

  group('a machine going away and coming back', () {
    test(
      'offline freezes its terminals and remembers the one being read',
      () async {
        final rig = await signedInWith({
          'm': ['a', 'b'],
        });
        addTearDown(rig.app.dispose);
        final session = await openAgent(rig, 'm', 'a');

        await push(rig, 'm', 'node_status', {'online': false});

        final machine = rig.app.stateOf('m')!;
        expect(machine.nodeOnline, isFalse);
        expect(machine.pendingOfflineAgentId, 'a');
        expect(session.status, TerminalSessionStatus.error);
        expect(session.errorMessage, contains('offline'));
      },
    );

    test(
      'back online, the terminal being read opens again by itself',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        final session = await openAgent(rig, 'm', 'a');
        final opens = rig.conn('m').opens.length;
        await push(rig, 'm', 'node_status', {'online': false});

        await push(rig, 'm', 'node_status', {'online': true});
        await settle();

        expect(rig.conn('m').opens.length, greaterThan(opens));
        expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
        await answerOpen(rig, session, screen: 'back');
        expect(session.status, TerminalSessionStatus.controlling);
      },
    );

    test('flapping settles on one live stream', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');

      for (var flap = 0; flap < 3; flap++) {
        await push(rig, 'm', 'node_status', {'online': false});
        await push(rig, 'm', 'node_status', {'online': true});
      }
      await settle();
      await answerOpen(rig, session);

      final machine = rig.app.stateOf('m')!;
      expect(machine.nodeOnline, isTrue);
      expect(machine.pendingOfflineAgentId, isNull);
      expect(session.status, TerminalSessionStatus.controlling);
      expect(
        rig.app.allPanes.where((pane) => pane.agentId == 'a'),
        hasLength(1),
      );
    });

    test(
      'an offline machine is polled, and taken back when the account says so',
      () async {
        final rig = await signedInWith({
          'm': ['a'],
        });
        addTearDown(rig.app.dispose);
        await openAgent(rig, 'm', 'a');
        await push(rig, 'm', 'node_status', {'online': false});

        rig.api.onMachines = () async => [
          remoteMachine('m', status: 'offline'),
        ];
        await rig.app.retryOfflineMachine('m');
        expect(rig.app.stateOf('m')!.nodeOnline, isFalse);

        rig.api.onMachines = () async => [remoteMachine('m', status: 'online')];
        await rig.app.retryOfflineMachine('m');
        expect(rig.app.stateOf('m')!.nodeOnline, isTrue);
      },
    );

    test('the phone losing its socket is not the machine going off', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');
      await push(rig, 'm', 'turn_started', {'agentId': 'a'});

      rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);

      final machine = rig.app.stateOf('m')!;
      expect(machine.nodeOnline, isTrue, reason: 'a tunnel is not a shutdown');
      expect(machine.pendingOfflineAgentId, 'a');
      expect(session.status, TerminalSessionStatus.error);
      expect(session.errorMessage, 'Connection lost. Reconnecting…');
      expect(rig.app.agentIsProcessing('m', 'a'), isFalse);
    });

    test('the socket back, the page being read opens again', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      final session = await openAgent(rig, 'm', 'a');
      final opens = rig.conn('m').opens.length;
      rig.app.connectionStatusForTest('m', ConnectionStatus.reconnecting);

      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await settle();

      expect(rig.conn('m').opens.length, greaterThan(opens));
      await answerOpen(rig, session);
      expect(session.status, TerminalSessionStatus.controlling);
      expect(rig.app.stateOf('m')!.pendingOfflineAgentId, isNull);
    });

    test('a machine the relay could not select says so', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);

      await push(rig, 'm', 'machine_select_error', {'error': 'NOT_FOUND'});

      expect(rig.app.lastError, 'Machine selection failed: NOT_FOUND');
      expect(
        rig.app.stateOf('m')!.connectionStatus,
        ConnectionStatus.disconnected,
      );
    });

    test('pushes for a machine the phone does not have are ignored', () async {
      final rig = await signedInWith({
        'm': ['a'],
      });
      addTearDown(rig.app.dispose);
      var redraws = 0;
      rig.app.addListener(() => redraws++);

      await push(rig, 'ghost', 'agent_created', {'agent': agentJson('x')});
      rig.app.connectionStatusForTest('ghost', ConnectionStatus.connected);
      await push(rig, 'm', 'desk_changed', {'revision': 3});

      expect(rig.app.stateOf('ghost'), isNull);
      expect(redraws, 0);
    });
  });
}
