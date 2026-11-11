import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/resume_agent.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

/// A machine that answers each lifecycle request from a script, and records what it was asked.
class _ResumeConn extends PagerConn {
  final List<(String, Map<String, dynamic>)> requests = [];

  static const _lifecycle = {
    'agent_resume',
    'agent_restart',
    'agent_create_status',
  };

  /// The reply to the next request; throwing stands for a reply that never arrived.
  Map<String, dynamic> Function(String type, Map<String, dynamic> payload)?
  answer;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    // The fixture's own traffic — agent lists, previews — is not what these tests are about.
    if (!_lifecycle.contains(type)) return {};
    requests.add((type, payload));
    return answer?.call(type, payload) ?? {};
  }
}

/// Tapping stopped work reopens its saved conversation — the desktop's `resumeAgent`.
void main() {
  Map<String, dynamic> agentJson({required bool stopped}) => {
    'id': 'b',
    'name': 'b',
    'engine': 'claude',
    'sessionId': 'session-b',
    'status': stopped ? 'stopped' : 'active',
    'project': <String, dynamic>{'name': 'work', 'cwd': '/work'},
    'terminal': <String, dynamic>{'available': !stopped},
  };

  AppNotifier stoppedApp(_ResumeConn conn) {
    final app = pagerApp(conn);
    final machine = app.stateOf('m')!;
    machine.agents = [
      for (final agent in machine.agents)
        agent.id == 'b' ? Agent.fromJson(agentJson(stopped: true)) : agent,
    ];
    return app;
  }

  Map<String, dynamic> created(Map<String, dynamic> payload) => {
    'creationId': payload['creationId'],
    'state': 'created',
    'resumed': true,
    'agent': agentJson(stopped: false),
  };

  test('asks the machine to RESUME, not to restart', () async {
    final conn = _ResumeConn()..answer = (_, payload) => created(payload);
    final app = stoppedApp(conn);
    addTearDown(app.dispose);

    final result = await app.resumeAgent('m', 'b');

    expect(result.error, isNull);
    final (type, payload) = conn.requests.single;
    expect(type, 'agent_resume');
    expect(payload['agentId'], 'b');
    expect(payload['creationId'], isA<String>());
    final resumed = app.stateOf('m')!.agents.firstWhere((a) => a.id == 'b');
    expect(resumed.terminalAvailable, isTrue);
    expect(resumed.sessionId, 'session-b');
  });

  test('a resume the terminal service could not take says what to do', () async {
    final conn = _ResumeConn()
      ..answer = (_, payload) => {
        'creationId': payload['creationId'],
        'state': 'failed',
        'failure': {'code': 'PTY_HOST_UNAVAILABLE', 'detail': 'harness-pty is not installed'},
      };
    final app = stoppedApp(conn);
    addTearDown(app.dispose);

    expect(
      (await app.resumeAgent('m', 'b')).error,
      'Harness could not open a terminal on this machine. Run harness start on it, then try again.',
    );
  });

  for (final (detail, expected) in [
    ('Use another engine.', 'Use another engine.'),
    ('', 'This engine cannot start on this machine. Nothing was started.'),
  ]) {
    test('a resume an engine refuses says why (detail "$detail")', () async {
      final conn = _ResumeConn()
        ..answer = (_, payload) => {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {'code': 'ENGINE_LAUNCH_REFUSED', 'detail': detail},
        };
      final app = stoppedApp(conn);
      addTearDown(app.dispose);
      expect((await app.resumeAgent('m', 'b')).error, expected);
    });
  }

  test('a lost reply is checked on the next tap, not sent again', () async {
    final conn = _ResumeConn()
      ..answer = (_, _) => throw StateError('socket dropped');
    final app = stoppedApp(conn);
    addTearDown(app.dispose);

    expect((await app.resumeAgent('m', 'b')).error, isNotNull);
    conn.answer = (_, payload) => created(payload);
    expect((await app.resumeAgent('m', 'b')).error, isNull);

    final [(firstType, first), (secondType, second)] = conn.requests;
    expect(firstType, 'agent_resume');
    expect(secondType, 'agent_create_status');
    expect(second['creationId'], first['creationId']);
    expect(second.containsKey('agentId'), isFalse);
  });

  test('a fresh session is not taken for the one that was tapped', () async {
    final conn = _ResumeConn()
      ..answer = (_, payload) => {
        ...created(payload),
        'agent': {...agentJson(stopped: false), 'sessionId': 'another'},
      };
    final app = stoppedApp(conn);
    addTearDown(app.dispose);

    expect((await app.resumeAgent('m', 'b')).error, isNotNull);
  });

  test('stopped work with no saved conversation is refused here', () async {
    final conn = _ResumeConn()..answer = (_, payload) => created(payload);
    final app = pagerApp(conn);
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!;
    machine.agents = [
      for (final agent in machine.agents)
        agent.id == 'b'
            ? Agent.fromJson({...agentJson(stopped: true)}..remove('sessionId'))
            : agent,
    ];

    expect((await app.resumeAgent('m', 'b')).error, isNotNull);
    // The machine could only answer RESUME_UNAVAILABLE, so it is not asked.
    expect(conn.requests, isEmpty);
  });

  group('an engine its machine resumes as a new conversation', () {
    AppNotifier freshApp(_ResumeConn conn) {
      final app = pagerApp(conn);
      final machine = app.stateOf('m')!;
      machine.agents = [
        for (final agent in machine.agents)
          agent.id == 'b'
              ? Agent.fromJson(
                  {...agentJson(stopped: true), 'resumeMode': 'conversation'}
                    ..remove('sessionId'),
                )
              : agent,
      ];
      return app;
    }

    test('is asked, not refused here', () async {
      final conn = _ResumeConn()..answer = (_, payload) => created(payload);
      final app = freshApp(conn);
      addTearDown(app.dispose);

      expect((await app.resumeAgent('m', 'b')).error, isNull);
      expect(conn.requests.single.$1, 'agent_resume');
    });

    test('comes back under a new session id, and that is success', () async {
      final conn = _ResumeConn()
        ..answer = (_, payload) => {
          ...created(payload),
          'resumed': false,
          'agent': {...agentJson(stopped: false), 'sessionId': 'another'},
        };
      final app = freshApp(conn);
      addTearDown(app.dispose);

      expect((await app.resumeAgent('m', 'b')).error, isNull);
    });
  });

  test('a stop pushed by the machine keeps the agent, stopped', () async {
    final app = stoppedApp(_ResumeConn());
    addTearDown(app.dispose);

    await app.handleEventForTest('m', {
      'type': 'agent_synced',
      'agentId': 'c',
      'payload': <String, dynamic>{
        'agent': <String, dynamic>{
          'id': 'c',
          'name': 'c',
          'engine': 'claude',
          'status': 'stopped',
          'project': <String, dynamic>{'name': 'work', 'cwd': '/work'},
          'terminal': <String, dynamic>{'available': false},
        },
      },
    });

    final c = app.stateOf('m')!.agents.where((a) => a.id == 'c').single;
    expect(c.isStopped, isTrue);
  });

  // What the Swarm's Open terminal reads and asks for (`PhoneShellScope`'s
  // agentStopped and onResumeAgent), on the person's own machines alone.
  group("the Swarm's resume", () {
    test('reads stopped work, and whether a resume can bring it back', () {
      final app = stoppedApp(_ResumeConn());
      addTearDown(app.dispose);

      expect(phoneAgentStopped(app, 'm', 'b'), isTrue);
      expect(phoneAgentStopped(app, 'm', 'a'), isNull, reason: 'running');
      expect(phoneAgentStopped(app, 'm', 'gone'), isNull);
      expect(phoneAgentStopped(app, 'other', 'b'), isNull);

      final machine = app.stateOf('m')!;
      machine.agents = [
        for (final agent in machine.agents)
          agent.id == 'b'
              ? Agent.fromJson(
                  {...agentJson(stopped: true)}..remove('sessionId'),
                )
              : agent,
      ];
      expect(
        phoneAgentStopped(app, 'm', 'b'),
        isFalse,
        reason: 'no saved conversation to bring back',
      );
    });

    test('never on a machine another account shares', () async {
      final conn = _ResumeConn()..answer = (_, payload) => created(payload);
      final app = stoppedApp(conn);
      addTearDown(app.dispose);
      const shared = Machine(
        machineId: 's',
        authMode: MachineAuthMode.remote,
        name: 'Ken’s Mac',
        shared: true,
      );
      app.machineStates['s'] = MachineState(shared)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agents = [Agent.fromJson(agentJson(stopped: true))];

      expect(phoneAgentStopped(app, 's', 'b'), isNull);
      expect(
        await phoneResumeAgent(app, 's', 'b'),
        'Only the person whose machine runs this agent can resume it.',
      );
      expect(conn.requests, isEmpty);
    });

    test(
      'resumes stopped work, then answers once its terminal is back',
      () async {
        final conn = _ResumeConn()..answer = (_, payload) => created(payload);
        final app = stoppedApp(conn);
        addTearDown(app.dispose);

        expect(await phoneResumeAgent(app, 'm', 'b'), isNull);
        expect(conn.requests.single.$1, 'agent_resume');
        expect(
          app.stateOf('m')!.agents.firstWhere((a) => a.id == 'b').isStopped,
          isFalse,
        );
      },
    );

    test('work no longer stopped is opened as it is, asking the machine '
        'nothing', () async {
      final conn = _ResumeConn();
      final app = stoppedApp(conn);
      addTearDown(app.dispose);

      expect(await phoneResumeAgent(app, 'm', 'a'), isNull);
      expect(conn.requests, isEmpty);
    });

    test('a harness its machine no longer lists says so', () async {
      final conn = _ResumeConn();
      final app = stoppedApp(conn);
      addTearDown(app.dispose);

      expect(
        await phoneResumeAgent(app, 'm', 'gone'),
        'This harness is no longer on Test host.',
      );
      expect(
        await phoneResumeAgent(app, 'nowhere', 'b'),
        'This harness is no longer on this machine.',
      );
      expect(conn.requests, isEmpty);
    });

    test(
      "a resume the machine refuses comes back in the machine's words",
      () async {
        final conn = _ResumeConn()
          ..answer = (_, payload) => {
            'creationId': payload['creationId'],
            'state': 'failed',
            'failure': {
              'code': 'ENGINE_LAUNCH_REFUSED',
              'detail': 'Use another engine.',
            },
          };
        final app = stoppedApp(conn);
        addTearDown(app.dispose);

        expect(await phoneResumeAgent(app, 'm', 'b'), 'Use another engine.');
      },
    );
  });
}
