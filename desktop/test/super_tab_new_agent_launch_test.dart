import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/agent_names.dart';
import 'package:harness/super_tabs/controller.dart' show SuperTabFailure;
import 'package:harness/super_tabs/new_agent.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture, tabId;
import 'swarm_state_test.dart' show MemoryStore;

/// This computer, with no Podman. Every request is recorded, and the Browser requests are answered as its daemon would.
class _NoPodman extends SuperTabFixtureConnection {
  _NoPodman(MemoryStore store) : super(store, local: true);

  @override
  bool get isReady => true;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final answer = await super.request(
      type,
      payload: payload,
      timeout: timeout,
    );
    return type == 'agent_browser_available'
        ? {'state': 'needs_setup'}
        : answer;
  }
}

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
    expect(integration.offersBrowser, isTrue);
    expect(integration.engines, ['claude', 'codex']);
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

  testWidgets(
    'Start with needs_setup opens the dialog; Cancel creates nothing; '
    'Install calls agentBrowserSetup and creates the agent with '
    'browser:true',
    (tester) async {
      final f = SuperTabLaunchFixture(connectionFactory: _NoPodman.new);
      final box = (await tester.runAsync(() => _newAgent(f)))!;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1200,
              height: 800,
              child: NewHarnessForm(
                controller: box,
                desktop: true,
                onClose: () {},
                onCreated: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('new-harness-field-browser')));
      await tester.pump();
      final start = find.byKey(const ValueKey('new-harness-field-start'));
      await tester.tap(start);
      await tester.pump();
      expect(find.text('Set up Browser'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pump();
      expect(find.text('Set up Browser'), findsNothing);
      final asked = f.connection.calls.map((c) => c.$1);
      expect(asked, isNot(contains('agent_browser_setup')));
      expect(asked, isNot(contains('agent_create')));
      expect(_commands(f), isEmpty);

      await tester.tap(start);
      await tester.pump();
      await tester.tap(find.text('Install'));
      for (var i = 0; i < 20; i++) {
        await tester.pump();
      }
      expect(
        f.connection.calls.where((c) => c.$1 == 'agent_browser_setup'),
        hasLength(1),
      );
      final create = f.connection.calls.singleWhere(
        (c) => c.$1 == 'agent_create',
      );
      expect(create.$2['browser'], isTrue);
      expect(find.text('Set up Browser'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      f.dispose();
      await tester.pump(const Duration(seconds: 1));
    },
  );

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

    // anh Dee 2026-11-10, attaching juno and pip: "they got different name?"
    test('keeps the name it was started with', () async {
      final f = SuperTabLaunchFixture();
      f.connection.journaled = false;
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      await swarmAttachAgent(
        f.app,
        tabId,
        'm',
        running(name: 'juno', chosen: false),
        wait: (_) async {},
      );
      expect(
        _commands(f).singleWhere((c) => c['type'] == 'agent.new')['name'],
        'juno',
      );
      expect((f.connection.joins.single['command'] as Map)['name'], 'juno');
    });

    test('a name the Swarm already uses gives way to one of its own', () async {
      final f = SuperTabLaunchFixture();
      f.connection.journaled = false;
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      (f.connection.server.state['agents'] as List).add({
        'id': 'other',
        'machineId': 'm2',
        'harnessId': 'other-harness',
        'name': 'Juno',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      });
      await swarmAttachAgent(
        f.app,
        tabId,
        'm',
        running(name: 'juno'),
        wait: (_) async {},
      );
      final name = _commands(f)
          .singleWhere((c) => c['type'] == 'agent.new')['name'];
      expect(agentNames, contains(name));
      expect(name, isNot('Juno'));
      expect((f.connection.joins.single['command'] as Map)['name'], name);
    });

    test('a name the server refuses gives way to one of its own', () async {
      final f = SuperTabLaunchFixture();
      f.connection.journaled = false;
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      f.connection.failNew = const SuperTabFailure(
        'AGENT_NAME_TAKEN',
        'juno is taken in this Swarm. Choose another.',
        statusCode: 409,
      );
      await swarmAttachAgent(
        f.app,
        tabId,
        'm',
        running(name: 'juno'),
        wait: (_) async {},
      );
      final name = _commands(f)
          .singleWhere((c) => c['type'] == 'agent.new')['name'];
      expect(agentNames, contains(name));
      expect((f.connection.joins.single['command'] as Map)['name'], name);
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
