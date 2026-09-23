import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
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
}
