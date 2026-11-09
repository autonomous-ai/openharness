import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/new_agent.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

/// + New agent in a Swarm (Swarm v4, anh Dee 2026-11-09): the form New Project
/// uses, started on the person's own computer, then joined to its 1:1 chat.
Future<NewHarnessController> _newAgent(SuperTabLaunchFixture f) async {
  f.connection.journaled = false;
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

  group('Attach: an agent already running joins its person\'s team', () {
    Agent running({String name = 'harness-3', bool? chosen}) => Agent(
      id: 'h1',
      name: name,
      nameChosen: chosen,
      engine: 'claude',
      modelName: 'Opus 5.5',
      modelEffort: 'high',
      terminalAvailable: true,
    );

    test(
      'opens its chat, joins it to that chat as itself, and opens it',
      () async {
        final f = SuperTabLaunchFixture();
        f.connection.journaled = false;
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
        await swarmAttachAgent(
          f.app,
          tabId,
          'm',
          running(),
          wait: (_) async {},
        );
        final chat = _commands(f).singleWhere((c) => c['type'] == 'agent.new');
        final name = chat['name'] as String;
        // An automatic name gives way to one of the Swarm's, as + New agent's.
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
        final join = f.connection.joins.single['command'] as Map;
        expect(join, containsPair('conversationId', chatId));
        expect(join, containsPair('harnessId', 'h1'));
        expect(join, containsPair('machineId', 'm'));
        expect(join, containsPair('name', name));
        expect(join, containsPair('lead', false));
        // Nothing is typed into it: it goes on with what it was doing.
        expect(join.containsKey('initialMessage'), isFalse);
        expect(join['configuration'], containsPair('engine', 'claude'));
        expect(join['configuration'], containsPair('model', 'Opus 5.5'));
        expect(join['configuration'], containsPair('effort', 'high'));
        // No session is started: it is the one already running.
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          isEmpty,
        );
        expect(f.app.superTabs.peek(tabId)!.selectedId, chatId);
      },
    );

    test('keeps the name its person gave it', () async {
      final f = SuperTabLaunchFixture();
      f.connection.journaled = false;
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      await swarmAttachAgent(
        f.app,
        tabId,
        'm',
        running(name: 'Docs bot', chosen: true),
        wait: (_) async {},
      );
      expect(
        _commands(f).singleWhere((c) => c['type'] == 'agent.new')['name'],
        'Docs bot',
      );
      expect((f.connection.joins.single['command'] as Map)['name'], 'Docs bot');
    });

    test(
      'a session of another engine is refused before anything is sent',
      () async {
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
        await expectLater(
          swarmAttachAgent(
            f.app,
            tabId,
            'm',
            const Agent(id: 'h2', name: 'shell', engine: 'terminal'),
            wait: (_) async {},
          ),
          throwsA(
            isA<SuperTabFailure>().having(
              (e) => e.code,
              'code',
              'SWARM_ENGINE',
            ),
          ),
        );
        expect(_commands(f), isEmpty);
      },
    );
  });
}
