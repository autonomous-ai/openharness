import 'dart:async';

import '../core/models.dart';
import '../logging/app_log.dart';
import '../state/app_state.dart';
import '../state/harness_launch_integration.dart';
import '../state/swarm.dart';
import 'agent_names.dart';
import 'controller.dart';
import 'launch_prompt.dart';
import 'model.dart';

/// How long a join waits between tries: the add is one operation, so trying it again never adds the agent twice.
const swarmJoinRetries = [Duration(seconds: 1), Duration(seconds: 3)];

/// + New agent in a Swarm (Swarm v4, anh Dee 2026-11-09), in the form New Project uses. The agent gets a name (one of the
/// Swarm's, Faye, Atlas, ...), its 1:1 chat with its person opens, this computer starts it with "You are <name>." and its
/// person's request, and it joins that chat. Nothing is kept between forms: every step is one operation the server answers
/// again with its receipt, so Try again finishes a start and never makes a second agent.
HarnessLaunchIntegration swarmNewAgent(
  AppNotifier app,
  Swarm tab, {
  Future<void> Function(Duration) wait = Future<void>.delayed,
}) {
  final tabId = tab.superTabId!;
  final creationId = superTabOperationId();
  final started = DateTime.now();
  // The request the launch before Swarm v4 kept for this Swarm's + New agent, which reopened behind Check status: gone.
  if (app.currentUser?.id case final account?) {
    unawaited(
      app.superTabs.storage.delete(
        'super_tab.launch.$account.swarm:$tabId.new-agent',
      ),
    );
  }
  String? name, chatId, engine, task, machineId, harnessId;

  Future<Map<String, dynamic>> run(
    String step,
    Map<String, Object?> command,
  ) async {
    final answer = await app.superTabs.map(
      'POST',
      '/api/super-tabs/$tabId/commands',
      body: {'operationId': '$creationId-$step', 'command': command},
    );
    return superTabMap(answer['result']);
  }

  Future<void> join() async {
    final command = {
      'type': 'agent.add',
      'conversationId': chatId,
      'machineId': machineId,
      'harnessId': harnessId,
      'name': name,
      'lead': false,
      'configuration': {
        'engine': engine,
        'model': null,
        'effort': null,
        'contextWindow': null,
        'engineVersion': null,
      },
      if (task!.trim().isNotEmpty) 'initialMessage': task,
    };
    for (var attempt = 0; ; attempt++) {
      try {
        await run('join', command);
        break;
      } catch (failure) {
        // A refusal is the answer; only a lost connection or a busy server is worth another try.
        final refused =
            failure is SuperTabFailure &&
            failure.statusCode >= 400 &&
            failure.statusCode < 500;
        if (refused || attempt == swarmJoinRetries.length) rethrow;
        await wait(swarmJoinRetries[attempt]);
      }
    }
    await app.wakeSuperTabHost(machineId!);
    // Its person goes on in their chat with it.
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    await controller.select(chatId!);
    // How long + New agent took to a running agent in its chat: the measure that warns first if it slows (task #4196).
    appLog.info(
      'super-tabs',
      'New agent running in ${DateTime.now().difference(started).inMilliseconds} ms',
    );
  }

  late final HarnessLaunchIntegration integration;
  integration = HarnessLaunchIntegration(
    creationId: creationId,
    actionLabel: 'New agent',
    // A Swarm agent runs Claude Code or Codex, on its person's own computer and account.
    engines: const ['claude', 'codex'],
    ownMachinesOnly: true,
    swarmRole: 'dev',
    prepare: (machine, text, base) async {
      final snapshot = await app.superTabs.readSnapshot(tabId);
      name ??= freshAgentName([
        for (final agent in snapshot.agents) agent.displayName ?? agent.name,
      ]);
      engine = base;
      task = text;
      final chat = await run('chat', {
        'type': 'agent.new',
        'kind': 'regular',
        'machineId': machine,
        'engine': base,
        'name': name,
        'local': true,
      });
      chatId = chat['conversationId'] as String;
      return superTabLaunchPrompt(name: name, task: text);
    },
    beforeSubmit: (_, _) async {},
    complete: (machine, harness) async {
      machineId = machine;
      harnessId = harness;
      try {
        await join();
      } catch (_) {
        // The form's Try again: the same join, the agent already running.
        integration.resume = join;
        rethrow;
      }
    },
  );
  return integration;
}

/// Attach, beside + in Your Team (Swarm v4, anh Dee 2026-11-09: "this is like cmd p. while + is like cmd n"): an agent
/// already running on one of its person's own computers joins their team as + New agent's does, with its own 1:1 chat,
/// which opens. Its name is the one its person gave it, else one of the Swarm's. Nothing is typed into it: it goes on with
/// what it was doing, and its daemon tells it the team's ways once it is in (cli superTabs/host.ts). A join the connection
/// lost is tried again as the same operation, which never adds it twice.
Future<void> swarmAttachAgent(
  AppNotifier app,
  String tabId,
  String machineId,
  Agent native, {
  Future<void> Function(Duration) wait = Future<void>.delayed,
}) async {
  final engine = native.engine;
  if (engine != 'claude' && engine != 'codex') {
    throw const SuperTabFailure(
      'SWARM_ENGINE',
      'Only Claude Code or Codex can join this Swarm.',
    );
  }
  final creationId = superTabOperationId();
  final started = DateTime.now();
  final snapshot = await app.superTabs.readSnapshot(tabId);
  final name = native.nameChosen == true
      ? native.name
      : freshAgentName([
          for (final agent in snapshot.agents) agent.displayName ?? agent.name,
        ]);

  Future<Map<String, dynamic>> run(
    String step,
    Map<String, Object?> command,
  ) async {
    for (var attempt = 0; ; attempt++) {
      try {
        final answer = await app.superTabs.map(
          'POST',
          '/api/super-tabs/$tabId/commands',
          body: {'operationId': '$creationId-$step', 'command': command},
        );
        return superTabMap(answer['result']);
      } catch (failure) {
        // A refusal is the answer; only a lost connection or a busy server is worth another try.
        final refused =
            failure is SuperTabFailure &&
            failure.statusCode >= 400 &&
            failure.statusCode < 500;
        if (refused || attempt == swarmJoinRetries.length) rethrow;
        await wait(swarmJoinRetries[attempt]);
      }
    }
  }

  final chat = await run('chat', {
    'type': 'agent.new',
    'kind': 'regular',
    'machineId': machineId,
    'engine': engine,
    'name': name,
    'local': true,
  });
  final chatId = chat['conversationId'] as String;
  await run('join', {
    'type': 'agent.add',
    'conversationId': chatId,
    'machineId': machineId,
    'harnessId': native.id,
    'name': name,
    'lead': false,
    'configuration': {
      'engine': engine,
      'model': native.modelName,
      'effort': native.modelEffort,
      'contextWindow': null,
      'engineVersion': null,
    },
  });
  await app.wakeSuperTabHost(machineId);
  final controller = await app.superTabs.open(tabId);
  await controller.refresh();
  await controller.select(chatId);
  appLog.info(
    'super-tabs',
    'Agent attached in ${DateTime.now().difference(started).inMilliseconds} ms',
  );
}
