// Where a blocked agent shows itself: the tile it is in reads its question
// from the notifier and rings itself.

import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pending_question.dart';

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'prod-mac',
  status: 'online',
);

Agent _agent(String id, String name) => Agent.fromJson({
  'id': id,
  'sessionId': 'session-$id',
  'name': name,
  'engine': 'claude',
  'status': 'active',
  'terminal': {'available': true},
});

AppNotifier notifierWithAgents(List<Agent> agents) {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  final state = MachineState(_machine)
    ..connectionStatus = ConnectionStatus.connected
    ..terminalCapabilityLoaded = true
    ..terminalCapabilityAvailable = true
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = agents;
  notifier.machines = [_machine];
  notifier.machineStates[_machine.machineId] = state;
  notifier.expandedMachines.add(_machine.machineId);
  return notifier;
}

PendingQuestion question({String agentId = 'a1'}) => PendingQuestion(
  machineId: 'm1',
  agentId: agentId,
  requestId: 'q_1',
  answerKey: 'Which colour theme do you want?',
  prompt: 'Which colour theme do you want?',
  options: const ['Blue', 'Red'],
  multi: false,
  since: DateTime.now(),
);
void main() {
  test('the tile can read a blocked agent\'s question', () {
    // The one reader. If this goes, nothing draws the ring and the whole
    // question path becomes dead weight.
    final notifier = notifierWithAgents([_agent('a1', 'payments')]);
    notifier.machineStates['m1']!.blockedAgents['a1'] = question();
    expect(notifier.questionFor('m1', 'a1'), isNotNull);
    expect(notifier.questionFor('m1', 'nobody'), isNull);
    expect(notifier.questionFor('nowhere', 'a1'), isNull);
  });
}
