import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_launch_integration.dart'
    show kNewProjectChoice;
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
    final chatId =
        f.connection.server.state['conversations'].cast<Map>().firstWhere(
              (g) => g['kind'] == 'agent-chat',
            )['id']
            as String;
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
    expect(
      f.connection.calls.where((c) => c.$1 == 'agent_create'),
      hasLength(1),
    );
    final joins = f.connection.joins.map((j) => j['operationId']).toSet();
    expect(joins, hasLength(1));
  });

  test('reopened after a failed start, it keeps the same chat', () async {
    final f = SuperTabLaunchFixture()..connection.failCreation = true;
    final box = await _newAgent(f);
    expect(await box.create(), NewHarnessOutcome.failed);
    f.connection.failCreation = false;
    final again = await _newAgent(f);
    expect(
      await again.create(),
      NewHarnessOutcome.created,
      reason: again.error,
    );
    expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(1));
    expect(f.connection.joins, hasLength(1));
  });

  test(
    'Discard of a start that never ran archives the Member’s chat',
    () async {
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
      final archive = _commands(f)
          .singleWhere((c) => c['type'] == 'conversation.archive');
      expect(archive, {
        'type': 'conversation.archive',
        'conversationId': chatId,
        'archived': true,
      });
    },
  );

  // Task #4541 (spec 2026-11-07-members-and-leads section 1): with the Swarm's project list, Cmd-N picks a main project,
  // and the Swarm starts the agent in Harness's own folder.
  group('with the project list', () {
    Map<String, dynamic> list({String? pick = 'lamp'}) => {
      'projects': [
        {
          'id': 'lead',
          'name': 'harness',
          'about': 'The Harness app and Swarm',
          'lead': {'agentId': 'river', 'name': 'River'},
          'waiting': 12,
        },
        {'id': 'lamp', 'name': 'lamp', 'lead': null, 'waiting': 3},
      ],
      'pick': pick,
    };

    test('it is read once and the server\'s pick starts picked', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.projectList = list();
      final box = await _newAgent(f);
      expect(box.choosesProject, isTrue);
      expect(box.integration!.mainProjectId, 'lamp');
      expect(f.connection.server.projectListReads, [
        '/api/super-tabs/$tabId/project-list',
      ]);
    });

    test('a Member of the picked project is started by the Swarm, and the '
        'first message goes to its chat', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.projectList = list();
      final box = await _newAgent(f);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final start = _commands(f).singleWhere((c) => c['type'] == 'agent.new');
      expect(start, {
        'type': 'agent.new',
        'kind': 'regular',
        'machineId': 'm',
        'engine': 'claude',
        'name': 'Claude Code',
        'mainProjectId': 'lamp',
      });
      final chatId =
          f.connection.server.state['conversations'].cast<Map>().firstWhere(
                (g) => g['kind'] == 'agent-chat',
              )['id']
              as String;
      final message = _commands(f)
          .singleWhere((c) => c['type'] == 'message.send');
      expect(message['conversationId'], chatId);
      expect(message['text'], 'Tidy the docs.');
      // Harness keeps its folders: nothing starts on this computer from here.
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(f.app.superTabs.peek(tabId)!.selectedId, chatId);
    });

    test('New project makes the agent its Lead, by the name given', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.projectList = list();
      final box = await _newAgent(f, engine: 'codex');
      box.setMainProject(kNewProjectChoice);
      box.setNewProjectName('radio');
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final start = _commands(f).singleWhere((c) => c['type'] == 'agent.new');
      expect(start, containsPair('kind', 'pm'));
      expect(start, containsPair('projectName', 'radio'));
      expect(start, containsPair('engine', 'codex'));
      expect(start.containsKey('mainProjectId'), isFalse);
      expect(_commands(f).where((c) => c['type'] == 'project.create'), isEmpty);
    });

    test('a lost reply is retried as the same request, once', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server
        ..projectList = list()
        ..loseReply = true;
      final box = await _newAgent(f);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final starts = [
        for (final post in f.connection.server.posts)
          if ((post['command'] as Map)['type'] == 'agent.new')
            post['operationId'],
      ];
      expect(starts, hasLength(2));
      expect(starts.toSet(), hasLength(1));
      expect(
        _commands(f).where((c) => c['type'] == 'message.send'),
        hasLength(1),
      );
    });

    test('a list that fails says so, Retry reads it again, and New project '
        'still works', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server
        ..projectList = list()
        ..projectListStatus = 503;
      final box = await _newAgent(f);
      final integration = box.integration!;
      expect(box.choosesProject, isTrue);
      expect(integration.projectsError, 'Couldn’t load the projects.');
      expect(integration.mainProjectId, kNewProjectChoice);
      f.connection.server.projectListStatus = 0;
      await box.retryProjects();
      expect(integration.projectsError, isNull);
      expect(integration.mainProjectId, 'lamp');
    });

    test('a backend with no list keeps today\'s form', () async {
      final f = SuperTabLaunchFixture();
      final box = await _newAgent(f);
      expect(box.choosesProject, isFalse);
      expect(box.integration!.agentKind, 'member');
    });
  });

  // Hotfix #4647 (anh Dee 19:55): New agent stopped with "This project is no longer available. Discard this request,
  // then create a new project." The check before the start looked for the Member's new chat in a fresh read of the
  // Swarm, and a read can leave a quiet chat out; a Member has no project to create, either.
  group('a Member whose chat the Swarm\'s read leaves out', () {
    test('still starts and joins its chat', () async {
      final f = SuperTabLaunchFixture();
      f.connection.server.newAgentChatsDormant = true;
      final box = await _newAgent(f);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final chatId =
          f.connection.server.state['conversations'].cast<Map>().firstWhere(
                (g) => g['kind'] == 'agent-chat',
              )['id']
              as String;
      final join = f.connection.joins.single['command'] as Map;
      expect(join, containsPair('conversationId', chatId));
      expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(1));
    });

    test('a saved attempt whose chat is gone opens a fresh chat, never a dead '
        'end', () async {
      final f = SuperTabLaunchFixture()..connection.failCreation = true;
      f.connection.server.chatsGoneAreNotFound = true;
      final first = await _newAgent(f);
      expect(await first.create(), NewHarnessOutcome.failed);
      final chats = f.connection.server.state['conversations'] as List;
      chats.removeWhere((g) => (g as Map)['kind'] == 'agent-chat');
      f.connection.failCreation = false;
      final again = await _newAgent(f);
      final outcome = await again.create();
      expect(outcome, NewHarnessOutcome.created, reason: again.error);
      expect(again.error ?? '', isNot(contains('project')));
      expect(_commands(f).where((c) => c['type'] == 'agent.new'), hasLength(2));
      final chatId =
          chats.cast<Map>().firstWhere((g) => g['kind'] == 'agent-chat')['id']
              as String;
      final join = f.connection.joins.single['command'] as Map;
      expect(join, containsPair('conversationId', chatId));
    });
  });

  // anh Dee 20:00 (hotfix #4647): after the failed start, 'Remove this request?' came back until he pressed Discard
  // anyway three times. One New agent request is kept per Swarm, whichever tab opened it, and one Discard clears it.
  group('Discard', () {
    String perTab(SuperTabLaunchFixture f) =>
        'super_tab.launch.${f.app.currentUser!.id}.${f.app.activeSwarm.id}.new-agent';

    test('one press clears the request, and it never comes back', () async {
      final f = SuperTabLaunchFixture()..connection.failCreation = true;
      final first = await _newAgent(f);
      expect(await first.create(), NewHarnessOutcome.failed);
      final recovered = await _newAgent(f);
      final integration = recovered.integration!;
      expect(integration.pending, isTrue);
      expect(await recovered.discardPending(anyway: true), isNull);
      expect(recovered.discarded, isTrue);
      // A late write of the dropped request does not bring it back.
      await integration.beforeSubmit('m', 'late');
      final fresh = await _newAgent(f);
      expect(fresh.integration!.pending, isFalse);
      expect(fresh.canDiscardPending, isFalse);
    });

    test('a request a tab kept before this fix is the one request, and one '
        'press clears it', () async {
      final f = SuperTabLaunchFixture()..connection.failCreation = true;
      final first = await _newAgent(f);
      expect(await first.create(), NewHarnessOutcome.failed);
      // Move the kept request to where an older Desktop kept it, under its tab.
      final storage = f.app.superTabs.storage;
      final swarmKey =
          'super_tab.launch.${f.app.currentUser!.id}.swarm:$tabId.new-agent';
      final saved = await storage.read(swarmKey);
      expect(saved, isNotNull);
      await storage.write(perTab(f), saved!);
      await storage.delete(swarmKey);
      final recovered = await _newAgent(f);
      expect(recovered.integration!.pending, isTrue);
      expect(await recovered.discardPending(anyway: true), isNull);
      expect(await storage.read(perTab(f)), isNull);
      expect(await storage.read(swarmKey), isNull);
      final fresh = await _newAgent(f);
      expect(fresh.integration!.pending, isFalse);
    });
  });
}
