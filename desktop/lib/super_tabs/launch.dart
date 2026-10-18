import 'dart:convert';

import '../core/models.dart';
import '../state/app_state.dart';
import '../state/harness_launch_integration.dart';
import '../state/swarm.dart';
import 'controller.dart';
import 'model.dart';

/// Captures a conversation before opening New Harness. Its journal survives a
/// closed form or process; a recovered launch only reads the native receipt.
class SuperTabLaunch {
  SuperTabLaunch._(
    this.app,
    this.swarmId,
    this.accountId,
    this.key,
    this.saved,
  );
  final AppNotifier app;
  final String swarmId, accountId, key;
  final Map<String, dynamic> saved;

  static Future<HarnessLaunchIntegration> open(
    AppNotifier app,
    Swarm tab,
    String conversationId,
  ) async {
    final account = app.currentUser?.id;
    if (account == null) {
      throw const SuperTabFailure(
        'SIGNED_OUT',
        'Sign in to create a Super Tab.',
      );
    }
    final key = 'super_tab.launch.$account.${tab.id}.$conversationId';
    final raw = await app.superTabs.storage.read(key);
    if (app.currentUser?.id != account) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
    final saved = raw == null
        ? <String, dynamic>{
            'operationId': superTabOperationId(),
            'joinId': superTabOperationId(),
            'tabId': tab.superTabId,
            'conversationId': conversationId,
            'lead': tab.superTabId == null,
          }
        : superTabMap(jsonDecode(raw));
    final launch = SuperTabLaunch._(app, tab.id, account, key, saved);
    final recovering =
        saved['phase'] == 'starting' || saved['phase'] == 'joining';
    return HarnessLaunchIntegration(
      creationId: saved['creationId'] as String? ?? superTabOperationId(),
      actionLabel: saved['lead'] == true ? 'New Super Tab' : 'New Harness',
      prepare: launch.prepare,
      beforeSubmit: (machine, receipt) async {
        saved['machineId'] = machine;
        saved['creationId'] = receipt;
        saved['phase'] = 'starting';
        await launch.persist();
      },
      complete: launch.complete,
      resume: recovering ? launch.resume : null,
    )..pending = recovering;
  }

  void checkAccount() {
    if (app.currentUser?.id != accountId) {
      throw const SuperTabFailure('ACCOUNT_CHANGED', 'The account changed.');
    }
  }

  Future<void> persist() async {
    checkAccount();
    await app.superTabs.storage.write(key, jsonEncode(saved));
    checkAccount();
  }

  Future<String> prepare(String machine, String task) async {
    checkAccount();
    saved['initialMessage'] = task;
    saved['machineId'] = machine;
    await persist();
    if (saved['tabId'] == null) {
      final created = await app.superTabs.map(
        'POST',
        '/api/super-tabs',
        body: {'operationId': saved['operationId'], 'name': 'Super Tab'},
      );
      saved['tabId'] = created['id'];
      await persist();
    }
    final command = 'harness super-tab --tab ${saved['tabId']}';
    return 'You are an agent in a shared Harness Super Tab. '
        '${saved['lead'] == true ? 'You are its coordinating lead. Start by discussing the person’s request; build after they authorize it.' : 'Join the conversation before beginning the person’s request.'}\n'
        'First run `$command status`. Registration may still be finishing: if it reports AGENT_UNAVAILABLE, wait briefly and retry. '
        'Do not start work or post until it confirms your participation.\n'
        'Read the conversation: `$command messages ${saved['conversationId']}`. '
        'Post explanations, questions and results with `$command post ${saved['conversationId']} "message" UNIQUE_OPERATION_ID`. '
        'Reuse that operation ID and exact message after a lost reply. Your native terminal is not the shared conversation.\n'
        'For work groups, assignments, acceptance evidence and messages to other agents, use `$command help`. '
        'Use a group for an independently assignable outcome with acceptance checks. Reuse existing groups and agents. '
        'Engine-native helper subagents do not need a group. Questions stay in the conversation where the work happens. '
        'Report exact revisions, evidence and links appropriate to the project.\n\n'
        'The person’s request:\n${task.isEmpty ? 'Ask what they would like to work on.' : task}';
  }

  Future<void> complete(
    String machine,
    String harnessId, {
    Agent? recovered,
  }) async {
    checkAccount();
    saved['machineId'] = machine;
    saved['harnessId'] = harnessId;
    saved['phase'] = 'joining';
    final native =
        recovered ??
        app
            .stateOf(machine)
            ?.agents
            .where((a) => a.id == harnessId)
            .firstOrNull;
    if (native == null) {
      throw const SuperTabFailure(
        'AGENT_UNAVAILABLE',
        'Waiting for the new harness to appear on its machine.',
      );
    }
    saved['command'] ??= {
      'type': 'agent.add',
      'conversationId': saved['conversationId'],
      'machineId': machine,
      'harnessId': harnessId,
      'name': native.displayName,
      'lead': saved['lead'],
      'configuration': {
        'engine': native.engine ?? '',
        'model': native.modelName,
        'effort': native.modelEffort,
        'contextWindow': null,
        'engineVersion': null,
      },
      if ((saved['initialMessage'] as String? ?? '').isNotEmpty)
        'initialMessage': saved['initialMessage'],
    };
    await persist();
    final tabId = saved['tabId'] as String;
    await app.superTabs.map(
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {'operationId': saved['joinId'], 'command': saved['command']},
    );
    // Waking the exact host starts only its authorized contributions. It is
    // safe to retry, and never grants machine access to the tab's members.
    await app.superTabMachineRequest(machine, {'action': 'wake'});
    if (saved['lead'] == true) {
      final name = Swarm.titleFor(native);
      final title = name == Swarm.defaultName ? 'Super Tab' : name;
      await app.superTabs.map(
        'POST',
        '/api/super-tabs/$tabId/commands',
        body: {
          'operationId': '${saved['joinId']}-name',
          'command': {'type': 'tab.rename', 'name': title},
        },
      );
      checkAccount();
      app.bindSuperTab(swarmId, tabId, title);
    }
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    checkAccount();
    await app.superTabs.storage.delete(key);
  }

  Future<void> resume() async {
    checkAccount();
    final machine = saved['machineId'] as String;
    final native = await app.recoverSuperTabCreation(
      machine,
      saved['creationId'] as String,
    );
    await complete(machine, native.id, recovered: native);
  }
}
