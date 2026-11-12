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
import 'personal_agents.dart' show swarmAgentId, swarmJoinName, swarmTakenNames;

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
  late final HarnessLaunchIntegration integration;

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
    // Its person goes on in their chat with it, unless the start went on without its form: they go in when they choose
    // (anh Dee, 2026-11-10).
    final controller = await app.superTabs.open(tabId);
    await controller.refresh();
    if (!integration.inBackground) await controller.select(chatId!);
    // How long + New agent took to a running agent in its chat: the measure that warns first if it slows (task #4196).
    appLog.info(
      'super-tabs',
      'New agent running in ${DateTime.now().difference(started).inMilliseconds} ms',
    );
  }

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
      integration.name = name;
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

/// A join begun on this Desktop and not finished: what it asks the Swarm for, kept so that trying it again is the same request
/// under the same operation (the server answers an operation again only for the request it first had), so it never makes a
/// second chat, from whichever view or picker it is tried. [step] is the chat's step: `chat`, or `chat-named` once the
/// server refused the agent's own name. By Swarm and session; per app, at most [_joinsKept].
typedef _Join = ({
  String operation,
  String step,
  String name,
  bool own,
  String? model,
  String? effort,
});
final _joins = Expando<Map<(String, String, String), _Join>>();
const _joinsKept = 64;

/// The server's refusals of a name (backend superTabs/agentRename.ts).
const _nameRefusals = {
  'AGENT_NAME_TAKEN',
  'AGENT_NAME_ROLE',
  'INVALID_AGENT_NAME',
};

/// Attach, beside + in Your Team (Swarm v4, anh Dee 2026-11-09: "this is like cmd p. while + is like cmd n"), and a click on a
/// pane's row in Your Team: an agent already running on one of its person's own computers joins their team as + New agent's
/// does, with its own 1:1 chat, which opens; the chat's id is the answer. A stopped one is resumed first, in the same step
/// (anh Dee 2026-11-10). It keeps its own name (anh Dee 2026-11-10, attaching juno and pip: "they got different name?"), the
/// one its row in Your Team shows (`swarmJoinName`), unless it has none or the Swarm already uses or refuses it, or another
/// join begun here holds it, when it gets one of the Swarm's. Nothing is typed into it: it goes on with what it was doing, and its daemon tells it the team's ways
/// once it is in (cli superTabs/host.ts). A join the connection lost is tried again as the same operation, which never adds
/// it twice; one that failed is finished by the next try ([_Join]).
///
/// [name] is the name its row in Your Team showed (personal_agents.dart), which it keeps.
Future<String> swarmAttachAgent(
  AppNotifier app,
  String tabId,
  String machineId,
  Agent native, {
  String? name,
  Future<void> Function(Duration) wait = Future<void>.delayed,
}) async {
  final engine = native.engine;
  if (engine != 'claude' && engine != 'codex') {
    throw const SuperTabFailure(
      'SWARM_ENGINE',
      'Only Claude Code or Codex can join this Swarm.',
    );
  }
  final started = DateTime.now();
  if (native.isStopped) {
    final refused = await app.resumeStoppedSession(machineId, native.id);
    if (refused != null) throw SuperTabFailure('AGENT_UNAVAILABLE', refused);
  }
  final joins = _joins[app] ??= {};
  final key = (tabId, machineId, native.id);
  // The names its Swarm has, and those other joins begun here into it hold.
  Future<Set<String>> taken() async => {
    ...swarmTakenNames(await app.superTabs.readSnapshot(tabId)),
    for (final MapEntry(key: other, :value) in joins.entries)
      if (other != key && other.$1 == tabId) value.name.toLowerCase(),
  };
  // The name its row in Your Team shows, or the one that row would (personal_agents.dart), so ⌘P and a click agree.
  final seed = swarmAgentId(machineId, native.id);
  var join = joins[key];
  if (join == null) {
    final chosen = name ?? swarmJoinName(native, seed, await taken());
    join = joins[key] ??= (
      operation: superTabOperationId(),
      step: 'chat',
      name: chosen,
      own: true,
      model: native.modelName,
      effort: native.modelEffort,
    );
    if (joins.length > _joinsKept) joins.remove(joins.keys.first);
  }
  // What this try asks for: the join kept, or the one a refused name gives way to.
  var current = join;
  final creationId = current.operation;

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

  // Its session named, so a try from another view or computer of the person's finds the same chat (backend agent.new).
  Future<Map<String, dynamic>> newChat(String step) => run(step, {
    'type': 'agent.new',
    'kind': 'regular',
    'machineId': machineId,
    'harnessId': native.id,
    'engine': engine,
    'name': current.name,
    'local': true,
  });
  Map<String, dynamic> chat;
  try {
    chat = await newChat(current.step);
  } on SuperTabFailure catch (failure) {
    if (!_nameRefusals.contains(failure.code)) rethrow;
    // A name of the Swarm's refused too: the next try starts over, with a name read then.
    if (!current.own) {
      joins.remove(key);
      rethrow;
    }
    // The server refuses names Desktop cannot see (a person's here, a reserved
    // word): its own name then gives way, as an automatic one does.
    current = joins[key] = (
      operation: current.operation,
      step: 'chat-named',
      name: swarmJoinName(native, seed, {
        ...await taken(),
        current.name.toLowerCase(),
      }),
      own: false,
      model: current.model,
      effort: current.effort,
    );
    chat = await newChat(current.step);
  }
  final chatId = chat['conversationId'] as String;
  await run('join', {
    'type': 'agent.add',
    'conversationId': chatId,
    'machineId': machineId,
    'harnessId': native.id,
    'name': current.name,
    'lead': false,
    'configuration': {
      'engine': engine,
      'model': current.model,
      'effort': current.effort,
      'contextWindow': null,
      'engineVersion': null,
    },
  });
  // It is in: a later try is a new join.
  joins.remove(key);
  await app.wakeSuperTabHost(machineId);
  final controller = await app.superTabs.open(tabId);
  await controller.refresh();
  await controller.select(chatId);
  appLog.info(
    'super-tabs',
    'Agent attached in ${DateTime.now().difference(started).inMilliseconds} ms',
  );
  return chatId;
}
