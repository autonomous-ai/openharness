import 'dart:convert';

import '../core/models.dart';
import '../state/app_state.dart';
import '../state/harness_attachments.dart';
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
    late final HarnessLaunchIntegration integration;
    integration = HarnessLaunchIntegration(
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
      stageAttachments: launch.stageAttachments,
      needsAttachmentReview: () => saved['filesState'] == 'sending',
      resolveAttachments: (resend) async {
        launch.checkAccount();
        saved['filesState'] = resend ? 'pending' : 'delivered';
        await launch.persist();
        await launch.resume();
      },
      resume: recovering
          ? () async {
              try {
                await launch.resume();
              } on SuperTabFailure catch (failure) {
                if (failure.code == 'CREATION_FAILED') {
                  saved.remove('phase');
                  saved.remove('creationId');
                  await launch.persist();
                  integration.pending = false;
                  integration.resume = null;
                }
                rethrow;
              }
            }
          : null,
    )..pending = recovering;
    return integration;
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
    final prompt =
        'You are an agent in a shared Harness Super Tab. '
        '${saved['lead'] == true ? 'You are its coordinating lead. Start by discussing the person’s request; build after they authorize it.' : 'Join the conversation before beginning the person’s request.'}\n'
        'First run `$command status`. Registration may still be finishing: if it reports AGENT_UNAVAILABLE, wait briefly and retry. '
        'Do not start work or post until it confirms your participation.\n'
        'Read the conversation: `$command messages ${saved['conversationId']}`. '
        'Post explanations, questions and results with `$command post ${saved['conversationId']} "message" UNIQUE_OPERATION_ID`. '
        'Reuse that operation ID and exact message after a lost reply. Your native terminal is not the shared conversation.\n'
        'If sandbox restrictions block this local Harness command, request permission to run it outside the sandbox. '
        'For work groups, assignments, acceptance evidence and messages to other agents, use `$command help`. '
        '${saved['lead'] == true ? 'Before starting or assigning work, run `$command route GROUP JSON` with your difficulty and risk assessment, then start or assign its pick with the routeDecisionId it returns. To choose otherwise, pass overrideReason. If it answers NO_CANDIDATE, tell the person in the group why, using its reasons; do not guess another machine. ' : ''}'
        'Use a group for an independently assignable outcome with acceptance checks. Reuse existing groups and agents. '
        'Engine-native helper subagents do not need a group. Questions stay in the conversation where the work happens. '
        'Report exact revisions, evidence and links appropriate to the project.\n\n'
        'The person’s request:\n${task.isEmpty ? 'Ask what they would like to work on.' : task}';
    saved['launchPrompt'] = prompt;
    await persist();
    return prompt;
  }

  Future<void> stageAttachments(
    List<HarnessAttachment> files,
    String prompt,
  ) async {
    checkAccount();
    saved['files'] = [
      for (final file in files)
        {'name': file.name, 'bytes': base64Encode(file.bytes)},
    ];
    saved['launchPrompt'] = prompt;
    saved['filesState'] = 'pending';
    await persist();
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
      'name': saved['lead'] == true ? 'Lead' : native.displayName,
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
    await app.wakeSuperTabHost(machine);
    if (saved['lead'] == true) {
      final name = Swarm.titleFor(native);
      final title =
          saved['title'] as String? ??
          (name == Swarm.defaultName ? 'Super Tab' : name);
      saved['title'] = title;
      await persist();
      await app.superTabs.map(
        'POST',
        '/api/super-tabs/$tabId/commands',
        body: {
          'operationId': '${saved['joinId']}-name',
          'command': {'type': 'tab.rename', 'name': title},
        },
      );
      checkAccount();
    }
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    checkAccount();
    final files = (saved['files'] as List? ?? []).map((value) {
      final file = superTabMap(value);
      return HarnessAttachment(
        file['name'] as String,
        base64Decode(file['bytes'] as String),
      );
    }).toList();
    if (files.isNotEmpty && saved['filesState'] != 'delivered') {
      if (saved['filesState'] == 'sending') {
        throw const SuperTabFailure(
          'FILES_UNCONFIRMED',
          'The harness started, but file delivery was interrupted. Open its terminal to check before sending the files or request again.',
        );
      }
      saved['filesState'] = 'sending';
      await persist();
      final problem = await app.deliverBackgroundAttachments(
        machineId: machine,
        agentId: harnessId,
        files: files,
        task: saved['launchPrompt'] as String,
      );
      checkAccount();
      if (problem != null) throw SuperTabFailure('FILES_UNCONFIRMED', problem);
      saved['filesState'] = 'delivered';
      saved.remove('files');
      await persist();
    }
    if (saved['lead'] == true) {
      app.bindSuperTab(swarmId, tabId, saved['title'] as String);
    }
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
