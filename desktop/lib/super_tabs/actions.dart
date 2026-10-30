import '../state/app_state.dart';
import 'controller.dart';

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
      'name': native.displayName,
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
