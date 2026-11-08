import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
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

    // anh Dee 11-08: after Discard anyway, New agent opened on another old request, its agent kind locked.
    test('one press also clears an older request its tab kept, so neither '
        'comes back', () async {
      final f = SuperTabLaunchFixture()..connection.failCreation = true;
      final first = await _newAgent(f);
      expect(await first.create(), NewHarnessOutcome.failed);
      final storage = f.app.superTabs.storage;
      final swarmKey =
          'super_tab.launch.${f.app.currentUser!.id}.swarm:$tabId.new-agent';
      // An older Desktop kept a request of its own under the tab.
      await storage.write(perTab(f), (await storage.read(swarmKey))!);
      final recovered = await _newAgent(f);
      expect(recovered.integration!.pending, isTrue);
      expect(await recovered.discardPending(anyway: true), isNull);
      expect(await storage.read(perTab(f)), isNull);
      final fresh = await _newAgent(f);
      expect(fresh.integration!.pending, isFalse);
      expect(fresh.integration!.agentKindLocked, isFalse);
    });
  });

  // anh Dee 11-08 (Mac 3): New agent kept reopening a request that never joined, Check status could not finish it,
  // and its agent kind stayed locked. A request untouched for half an hour is dead: the form drops it, as Discard
  // anyway does, and opens fresh.
  group('a request untouched for half an hour', () {
    String swarmKey(SuperTabLaunchFixture f) =>
        'super_tab.launch.${f.app.currentUser!.id}.swarm:$tabId.new-agent';

    int minutesAgo(int minutes) => DateTime.now()
        .subtract(Duration(minutes: minutes))
        .millisecondsSinceEpoch;

    Future<void> change(
      SuperTabLaunchFixture f,
      void Function(Map<String, dynamic> saved) edit,
    ) async {
      final storage = f.app.superTabs.storage;
      final saved = jsonDecode(
        (await storage.read(swarmKey(f)))!,
      ) as Map<String, dynamic>;
      edit(saved);
      await storage.write(swarmKey(f), jsonEncode(saved));
    }

    Future<SuperTabLaunchFixture> failedStart() async {
      final f = SuperTabLaunchFixture()..connection.failCreation = true;
      final first = await _newAgent(f);
      expect(await first.create(), NewHarnessOutcome.failed);
      return f;
    }

    test('opens fresh, with its agent kind free again', () async {
      final f = await failedStart();
      await change(f, (saved) => saved['savedAt'] = minutesAgo(31));
      final fresh = await _newAgent(f);
      expect(fresh.integration!.pending, isFalse);
      expect(fresh.integration!.agentKindLocked, isFalse);
      expect(fresh.canDiscardPending, isFalse);
      expect(await f.app.superTabs.storage.read(swarmKey(f)), isNull);
    });

    test('one that never started opens fresh too, and its empty chat is '
        'archived', () async {
      final f = await failedStart();
      await change(f, (saved) {
        saved.remove('phase');
        saved['savedAt'] = minutesAgo(31);
      });
      final fresh = await _newAgent(f);
      expect(fresh.integration!.agentKindLocked, isFalse);
      expect(
        _commands(f).where((c) => c['type'] == 'conversation.archive'),
        hasLength(1),
      );
    });

    test('one an older Desktop saved goes by when its agent was asked for, '
        'or by nothing at all', () async {
      for (final asked in [minutesAgo(31), null]) {
        final f = await failedStart();
        await change(f, (saved) {
          saved.remove('savedAt');
          if (asked == null) {
            saved.remove('newAgentAt');
          } else {
            saved['newAgentAt'] = asked;
          }
        });
        final fresh = await _newAgent(f);
        expect(fresh.integration!.pending, isFalse, reason: '$asked');
        expect(fresh.integration!.agentKindLocked, isFalse, reason: '$asked');
      }
    });

    test('a request saved within it is still recovered', () async {
      final f = await failedStart();
      await change(f, (saved) => saved['savedAt'] = minutesAgo(29));
      final recovered = await _newAgent(f);
      expect(recovered.integration!.pending, isTrue);
      expect(recovered.integration!.agentKindLocked, isTrue);
    });
  });

  // Hotfix #4709 (anh Dee, Mac 3): New agent ended at "The harness started on Mac 3. Check status to add it to the
  // project." and nothing joined; Mac 3 ran no harness. A saved request whose agent is not running says so and Start
  // begins again, and an own computer added in v2 (team-account only, no checkout) takes its person's agent.
  group('a Member on a computer added in v2', () {
    void v2Computer(SuperTabLaunchFixture f) =>
        ((f.connection.server.state['machines'] ??= <dynamic>[]) as List).add({
          'machineId': 'm',
          'name': 'Mac 3',
          'contributorId': f.app.currentUser!.id,
          'teamAccountOnly': true,
          'observation': {
            'readiness': {'checkouts': <dynamic>[]},
          },
        });

    test('joins on the first try', () async {
      final f = SuperTabLaunchFixture();
      v2Computer(f);
      final box = await _newAgent(f);
      expect(await box.create(), NewHarnessOutcome.created, reason: box.error);
      final join = f.connection.joins.single['command'] as Map;
      expect(join, containsPair('machineId', 'm'));
      expect(join, containsPair('harnessId', 'native-lead'));
    });

    for (final (why, status) in [
      ('stopped on its computer', <String, dynamic>{'state': 'unavailable'}),
      (
        'listed but not running',
        <String, dynamic>{
          'state': 'created',
          'agent': {
            'id': 'native-lead',
            'name': 'Claude Code',
            'engine': 'claude',
            'status': 'stopped',
          },
        },
      ),
    ]) {
      test('a saved request whose agent $why says so, and Start starts it '
          'again', () async {
        final f = SuperTabLaunchFixture();
        v2Computer(f);
        f.connection.failJoin = const SuperTabFailure(
          'INTERNAL_ERROR',
          'An internal server error occurred',
          statusCode: 500,
        );
        final first = await _newAgent(f);
        expect(await first.create(), NewHarnessOutcome.failed);
        f.connection.creationRecovery = (type, payload) async => {
          'creationId': payload['creationId'],
          ...status,
        };
        final again = await _newAgent(f);
        expect(again.integration!.pending, isTrue);
        expect(await again.create(), NewHarnessOutcome.failed);
        expect(
          again.error,
          'The harness stopped on Test host before it joined. Press Start to '
          'try again.',
        );
        expect(again.integration!.pending, isFalse);
        expect(again.canDiscardPending, isFalse);
        expect(f.connection.joins, hasLength(1));
        f.connection.creationRecovery = null;
        expect(
          await again.create(),
          NewHarnessOutcome.created,
          reason: again.error,
        );
        expect(
          f.connection.calls.where((c) => c.$1 == 'agent_create'),
          hasLength(2),
        );
        expect(f.connection.joins, hasLength(2));
        // Its own join, never the stopped one's replayed.
        expect(
          f.connection.joins.last['operationId'],
          isNot(f.connection.joins.first['operationId']),
        );
      });
    }
  });
}
