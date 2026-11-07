import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/launch.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// + New agent (task #4196, anh Dee 11-07): Cmd-N starts the agent on the
/// person's own computer, then it joins the Swarm as a Member in its own chat
/// or as the Lead of a new project.
Future<NewHarnessController> _newAgent(
  SuperTabLaunchFixture f, {
  String engine = 'claude',
}) async {
  f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
  final integration = await SuperTabLaunch.open(
    f.app,
    f.app.activeSwarm,
    'new-agent',
    newAgent: true,
  );
  final box = NewHarnessController(
    f.app,
    machineId: 'm',
    engine: engine,
    folder: '/work/project',
    task: 'Tidy the docs.',
    integration: integration,
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

  test('opens as a Member of Claude Code or Codex on own computers', () async {
    final f = SuperTabLaunchFixture();
    final box = await _newAgent(f);
    final integration = box.integration!;
    expect(integration.agentKind, 'member');
    expect(integration.ownMachinesOnly, isTrue);
    expect(integration.engines, ['claude', 'codex']);
    expect(integration.leadMachines, isNull, reason: 'Every picker stays');
    expect(box.actionLabel, 'New agent');
  });

  test('a Member opens its chat, starts here, then joins that chat', () async {
    final f = SuperTabLaunchFixture();
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);

    final chat = _commands(f).firstWhere((c) => c['type'] == 'agent.new');
    expect(chat, {
      'type': 'agent.new',
      'kind': 'regular',
      'machineId': 'm',
      'engine': 'claude',
      'name': 'Claude Code',
      'local': true,
    });
    final chatId = f.connection.server.state['conversations']
        .cast<Map>()
        .firstWhere((g) => g['kind'] == 'agent-chat')['id'] as String;
    final create = f.connection.calls
        .firstWhere((c) => c.$1 == 'agent_create')
        .$2;
    expect(create['prompt'], contains('messages $chatId'));
    expect(create['swarmRole'], 'dev');
    expect(create['cwd'] ?? create['folder'], '/work/project');
    final join = f.connection.joins.single['command'] as Map;
    expect(join, containsPair('conversationId', chatId));
    expect(join, containsPair('lead', false));
    expect(join['initialMessage'], 'Tidy the docs.');
    expect(_commands(f).where((c) => c['type'] == 'project.create'), isEmpty);
    expect(box.integration!.agentKindLocked, isTrue);
    expect(f.app.superTabs.peek(tabId)!.selectedId, chatId);
  });

  test('a Lead creates its project, starts here, then leads it', () async {
    final f = SuperTabLaunchFixture();
    final box = await _newAgent(f, engine: 'codex');
    box.setAgentKind('lead');
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);

    final types = _commands(f).map((c) => c['type']).toList();
    expect(types, containsAllInOrder(['project.create', 'agent.add']));
    expect(types, contains('project.rename'));
    expect(types, isNot(contains('agent.new')));
    final create = f.connection.calls
        .firstWhere((c) => c.$1 == 'agent_create')
        .$2;
    expect(create['swarmRole'], 'lead');
    expect(f.connection.joins.single['command'], containsPair('lead', true));
  });

  test('a lost join reply is retried as the same request, once', () async {
    final f = SuperTabLaunchFixture()..connection.loseJoin = true;
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
    expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(1));
    expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), hasLength(1));
    final joins = f.connection.joins.map((j) => j['operationId']).toSet();
    expect(joins, hasLength(1));
  });

  test('reopened after a failed start, it keeps the same chat', () async {
    final f = SuperTabLaunchFixture()..connection.failCreation = true;
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    f.connection.failCreation = false;
    final again = await _newAgent(f);
    expect(await again.create(), NewHarnessOutcome.created, reason: again.error);
    expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(1));
    expect(f.connection.joins, hasLength(1));
  });

  test('Discard of a start that never ran archives the Member’s chat', () async {
    final f = SuperTabLaunchFixture()..connection.loseCreate = true;
    f.connection.creationRecovery = (type, payload) async => {
      'creationId': payload['creationId'],
      'state': type == 'agent_create_cancel' ? 'cancelled' : 'missing',
    };
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    final chatId = f.connection.server.state['conversations']
        .cast<Map>()
        .firstWhere((g) => g['kind'] == 'agent-chat')['id'];
    final recovered = await _newAgent(f);
    expect(recovered.integration!.agentKindLocked, isTrue);
    expect(await recovered.integration!.discard!(), isNull);
    final archive = _commands(
      f,
    ).singleWhere((c) => c['type'] == 'conversation.archive');
    expect(archive, {
      'type': 'conversation.archive',
      'conversationId': chatId,
      'archived': true,
    });
  });
}
