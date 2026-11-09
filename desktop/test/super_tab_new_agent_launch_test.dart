import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/new_agent.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// + New agent in a Swarm (Swarm v4, anh Dee 2026-11-09): the form New Project
/// uses, started on the person's own computer, then joined to its 1:1 chat.
Future<NewHarnessController> _newAgent(SuperTabLaunchFixture f) async {
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final box = NewHarnessController(
    f.app,
    machineId: 'm',
    engine: 'claude',
    folder: '/work/project',
    task: 'Tidy the docs.',
    integration: swarmNewAgent(f.app, f.app.activeSwarm, wait: (_) async {}),
  );
  addTearDown(box.dispose);
  await Future<void>.delayed(Duration.zero);
  return box;
}

List<Map> _commands(SuperTabLaunchFixture f) => [
  for (final post in f.connection.server.posts) post['command'] as Map,
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('offers Claude Code and Codex on the person\'s own computers', () async {
    final box = await _newAgent(SuperTabLaunchFixture());
    final integration = box.integration!;
    expect(integration.ownMachinesOnly, isTrue);
    expect(integration.engines, ['claude', 'codex']);
    expect(integration.agentKind, isNull);
    expect(integration.leadMachines, isNull);
    expect(box.actionLabel, 'New agent');
  });

  test('opens its chat, starts here as "You are <name>." and its person\'s '
      'request, joins that chat, and opens it', () async {
    final f = SuperTabLaunchFixture();
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);

    final chat = _commands(f).singleWhere((c) => c['type'] == 'agent.new');
    final name = chat['name'] as String;
    expect(agentNames, contains(name));
    expect(chat, {
      'type': 'agent.new',
      'kind': 'regular',
      'machineId': 'm',
      'engine': 'claude',
      'name': name,
      'local': true,
    });
    final chatId =
        f.connection.server.state['conversations'].cast<Map>().firstWhere(
              (g) => g['kind'] == 'agent-chat',
            )['id']
            as String;
    final create = f.connection.calls
        .singleWhere((c) => c.$1 == 'agent_create')
        .$2;
    expect(create['prompt'], 'You are $name.\n\nTidy the docs.');
    final join = f.connection.joins.single['command'] as Map;
    expect(join, containsPair('conversationId', chatId));
    expect(join, containsPair('name', name));
    expect(join, containsPair('lead', false));
    expect(join, containsPair('initialMessage', 'Tidy the docs.'));
    // Its engine is the form's: the join never waits for its computer to list
    // the new session (anh Dee's "Check status", 2026-11-09).
    expect((join['configuration'] as Map)['engine'], 'claude');
    expect(f.app.superTabs.peek(tabId)!.selectedId, chatId);
  });

  test('a lost join reply is tried again as the same request, and the agent '
      'joins once', () async {
    final f = SuperTabLaunchFixture()..connection.loseJoin = true;
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
    expect(
      f.connection.joins.map((j) => j['operationId']).toSet(),
      hasLength(1),
    );
  });

  test('a refused join says why; Try again joins the running agent, never '
      'starting a second', () async {
    final f = SuperTabLaunchFixture();
    f.connection.failJoin = const SuperTabFailure(
      'MACHINE_NOT_LISTED',
      'Add this computer to the Swarm first.',
      statusCode: 403,
    );
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.error, contains('Add this computer to the Swarm first.'));
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
    expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(1));
    expect(
      f.connection.joins.map((j) => j['operationId']).toSet(),
      hasLength(1),
    );
  });
}
