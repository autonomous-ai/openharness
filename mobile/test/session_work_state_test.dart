import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'session_git_context_test.dart';
import 'agent_pager_fixture.dart';

class WorkConnection extends PagerConn {
  final workReplies = <Completer<Map<String, dynamic>>>[];
  final workRequests = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'git_pull_request') {
      return super.request(type, payload: payload, timeout: timeout);
    }
    workRequests.add(payload);
    final reply = Completer<Map<String, dynamic>>();
    workReplies.add(reply);
    return reply.future;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late WorkConnection connection;
  late AppNotifier app;
  setUp(() {
    connection = WorkConnection();
    app = pagerApp(connection);
    app.stateOf('m')!
      ..agents = [workAgent(git: gitFixture())]
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true;
  });
  tearDown(() => app.dispose());

  test('history replies cannot cross conversation replacement or a machine reconnect', () async {
    for (final replaceMachine in [false, true]) {
      app.stateOf('m')!.agents = [workAgent(git: gitFixture())];
      final response = app.readAgentGitHistory('m', 'hn', offset: 4);
      expect(connection.workRequests.last, {
        'agentId': 'hn',
        'history': true,
        'offset': 4,
      });
      if (replaceMachine) {
        app.machineStates['m'] = MachineState(app.stateOf('m')!.machine)
          ..agents = [workAgent(git: gitFixture())];
      } else {
        app.stateOf('m')!.agents = const [
          Agent(
            id: 'hn',
            name: 'Reused slot',
            engine: 'codex',
            sessionId: 'other',
          ),
        ];
      }
      connection.workReplies.last.complete({
        'gitContext': gitFixture(),
        'history': gitFixture()['history'],
      });
      expect(await response, {'status': 'unavailable'});
    }
  });

  test(
    'out-of-order push frames preserve new context without mixing machines',
    () async {
      Map<String, dynamic> wire(int revision, String branch) => {
        'id': 'hn',
        'name': 'hn',
        'engine': 'claude',
        'sessionId': 'conversation',
        'terminal': {'available': true},
        'project': {
          'name': 'app',
          'cwd': '/silent-beacon',
          'branch': 'original',
        },
        'gitContext': {
          ...gitFixture(branch: branch),
          'version': {'epoch': 'daemon', 'revision': revision},
        },
      };
      final machine = Machine(
        machineId: 'other',
        authMode: MachineAuthMode.remote,
        name: 'Other',
      );
      app.machineStates['other'] = MachineState(machine);
      for (final target in ['m', 'other']) {
        await app.handleMachineEventForTest(target, {
          'type': 'agent_synced',
          'payload': {
            'agent': wire(
              target == 'm' ? 2 : 1,
              target == 'm' ? 'new' : 'other-work',
            ),
          },
        });
      }
      await app.handleMachineEventForTest('m', {
        'type': 'agent_synced',
        'payload': {'agent': wire(1, 'old')},
      });
      expect(app.stateOf('m')!.agents.single.displayProject!.branch, 'new');
      expect(
        app.stateOf('other')!.agents.single.displayProject!.branch,
        'other-work',
      );
    },
  );
}
