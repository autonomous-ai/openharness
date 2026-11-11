import '../core/models.dart';
import '../state/app_state.dart';
import 'controller.dart';

/// The name an agent is added to the Swarm with: the name its person gave the
/// harness, else `Agent`, which the Swarm answers with a member name. Never the
/// harness's session title, which an automatic name shows instead (a terminal
/// title such as "cd /Users/…"; task #2912).
String superTabAddName(Agent native) =>
    isAutomaticHarnessName(native.name) ? 'Agent' : native.name;

Future<void> addSuperTabAgent(
  AppNotifier app,
  String tabId,
  String conversationId,
  String machineId,
  String harnessId,
) async {
  final c = await app.superTabs.open(tabId);
  await c.refresh();
  final existing = c.snapshot?.agents
      .where((a) => a.machineId == machineId && a.harnessId == harnessId)
      .firstOrNull;
  Map<String, dynamic> command;
  if (existing != null) {
    command = {
      'type': 'conversation.agent',
      'conversationId': conversationId,
      'agentId': existing.id,
      'present': true,
      'lead': false,
    };
  } else {
    final native = app
        .stateOf(machineId)
        ?.agents
        .where((a) => a.id == harnessId)
        .firstOrNull;
    if (native == null || native.engine == 'terminal') {
      throw const SuperTabFailure(
        'AGENT_UNAVAILABLE',
        'Choose a running agent.',
      );
    }
    command = {
      'type': 'agent.add',
      'conversationId': conversationId,
      'machineId': machineId,
      'harnessId': harnessId,
      'name': superTabAddName(native),
      'lead': false,
      'configuration': {
        'engine': native.engine ?? '',
        'model': native.modelName,
        'effort': native.modelEffort,
        'contextWindow': null,
        'engineVersion': null,
      },
    };
  }
  final result = await c.command(command);
  if (result == null) {
    throw SuperTabFailure(
      'ADD_FAILED',
      c.operationError ?? 'Could not add the agent.',
    );
  }
  if (existing == null) {
    await app.wakeSuperTabHost(machineId);
  }
}
