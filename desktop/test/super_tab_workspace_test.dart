import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/pane.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  testWidgets(
    'a signed-in person never sees Sign in while their account is still read',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      // A restored Swarm tab draws before the account's profile has answered.
      final profile = f.app.currentUser;
      f.app.currentUser = null;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: PaneGrid(notifier: f.app, swarmMode: true),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.textContaining('Sign in'), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      f.app.currentUser = profile;
      // The account is known: the Swarm opens and reads as it always has.
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      for (
        var i = 0;
        i < 40 && find.byType(SuperTabView).evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.textContaining('Sign in'), findsNothing);
      }
      expect(find.byType(SuperTabView), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a stopped native stream keeps its Resume action after a chat round trip',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      f.connection.nativeSurface = true;
      f.app.machineStates['m']!
        ..terminalCapabilityAvailable = true
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          machineId: 'm',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        );
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.native = {
        'id': 'native-lead',
        'name': 'Lead',
        'engine': 'claude',
        'terminal': {'available': true},
      };
      f.connection.server.state['agents'] = [
        {
          'id': 'lead-agent',
          'name': 'Lead',
          'machineId': 'm',
          'harnessId': 'native-lead',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['agentIds'] = [
        'lead-agent',
      ];
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: PaneGrid(notifier: f.app, swarmMode: true),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      c.selectTerminal('lead', c.snapshot!.agents.single.id);
      for (
        var i = 0;
        i < 40 && f.app.panes.firstOrNull?.session?.streamId == null;
        i++
      ) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(f.app.panes.single.session?.streamId, isNotNull);
      c.selectTerminal('lead', null);
      await tester.pump(const Duration(milliseconds: 100));
      f.connection.native = {
        ...f.connection.native!,
        'status': 'stopped',
        'sessionId': 'saved-native',
        'terminal': {'available': false},
      };
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      tester
          .widget<SuperTabView>(find.byType(SuperTabView))
          .onChooseAgentTerminal!(c.snapshot!.agents.single);
      for (var i = 0; i < 40 && find.text('Resume').evaluate().isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_resume'),
        isEmpty,
      );
      expect(
        find.text('Resume'),
        findsOneWidget,
        reason:
            '${tester.widgetList<Text>(find.byType(Text)).map((text) => text.data).whereType<String>().join("\n")}\n${f.connection.calls}\n${f.app.panes.single.session?.status}',
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a ready replacement refreshes the terminal without changing member identity',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final member = {
        'id': 'stable-member',
        'name': 'Engineer',
        'displayName': 'Sage',
        'machineId': 'm',
        'harnessId': 'native-original',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      };
      f.connection.server.state['agents'] = [member];
      (f.connection.server.state['conversations'] as List)[0]['agentIds'] = [
        'stable-member',
      ];
      f.app.machineStates['m']!.agents = const [
        Agent(
          id: 'native-original',
          name: 'Original',
          engine: 'codex',
          terminalAvailable: true,
        ),
        Agent(
          id: 'native-replacement',
          name: 'Replacement',
          engine: 'claude',
          terminalAvailable: true,
        ),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      c.selectGroupTerminals('lead');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const Text('Native terminals'),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(f.app.panes.single.agentId, 'native-original');

      // A replacement from another client updates the binding while both
      // native inventories remain ready, with the same stable member ID.
      member['harnessId'] = 'native-replacement';
      member['configuration'] = {'engine': 'claude'};
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.snapshot!.agents.single.id, 'stable-member');
      expect(c.snapshot!.agentName('stable-member'), 'Sage');
      expect(c.selectedId, 'lead');
      expect(f.app.panes.single.agentId, 'native-replacement');
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'agent_resume' ||
              call.$1 == 'agent_create' ||
              call.$1 == 'agent_close',
        ),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'group terminals keep all members when opening one and ignore pane close',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final state = f.connection.server.state;
      state['agents'] = [
        for (final id in ['a', 'b', 'c', 'd'])
          {
            'id': id,
            'name': id,
            'machineId': 'm',
            'harnessId': 'native-$id',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
          },
      ];
      (state['conversations'] as List)[1]['agentIds'] = ['a', 'b', 'c', 'd'];
      (state['conversations'] as List)[0]['agentIds'] = ['b'];
      f.app.machineStates['m']!.agents = [
        for (final id in ['a', 'b', 'c', 'd'])
          Agent.fromJson({
            'id': 'native-$id',
            'name': id,
            'engine': 'codex',
            'status': ['c', 'd'].contains(id) ? 'stopped' : 'working',
            'terminal': {
              'available': !['c', 'd'].contains(id),
            },
          }),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      c.select('offline');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const Text('Native terminals'),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await f.app.handleMachineEventForTest('m', {
        'type': 'commander_question',
        'agentId': 'native-b',
        'payload': {
          'requestId': 'q-fixture',
          'questions': [
            {
              'key': 'confirm',
              'q': 'Use this approach?',
              'options': ['Yes', 'No'],
              'multi': false,
            },
          ],
        },
      });
      await tester.pumpAndSettle();
      await tester.tap(find.text('b needs you').first);
      await tester.pumpAndSettle();
      expect(
        f.app.activeSwarm.panes.map((p) => p.agentId),
        unorderedEquals(['native-a', 'native-b', 'native-c', 'native-d']),
      );
      await f.app.handleMachineEventForTest('m', {
        'type': 'commander_question_close',
        'agentId': 'native-b',
        'payload': {'requestId': 'q-fixture'},
      });
      await tester.pumpAndSettle();
      expect(f.app.questionFor('m', 'native-b'), isNull);
      tester
          .widget<SuperTabView>(find.byType(SuperTabView))
          .onOpenGroupTerminals!();
      await tester.pumpAndSettle();
      expect(
        f.app.activeSwarm.panes.map((p) => p.agentId),
        unorderedEquals(['native-a', 'native-b', 'native-c', 'native-d']),
      );
      await f.app.requestClosePane(
        f.app.activeSwarm.panes.firstWhere((p) => p.agentId == 'native-a').id,
      );
      await tester.pumpAndSettle();
      expect(
        f.app.activeSwarm.panes.map((p) => p.agentId),
        unorderedEquals(['native-a', 'native-b', 'native-c', 'native-d']),
      );
      expect(c.terminalAgents('offline').map((a) => a.id), [
        'a',
        'b',
        'c',
        'd',
      ]);
      expect(f.connection.calls.where((c) => c.$1 == 'agent_resume'), isEmpty);
      expect(
        f.connection.calls.where(
          (c) => c.$1 == 'agent_close' || c.$1 == 'agent_create',
        ),
        isEmpty,
      );
      // The global roster asks for context when a session belongs to more
      // than one workgroup. The needs-human action above already knew its
      // group and opened the waiting pane directly.
      tester
          .widget<SuperTabView>(find.byType(SuperTabView))
          .onChooseAgentTerminal!(c.snapshot!.agent('b')!);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-agent-group-lead')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('super-agent-group-offline')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('super-agent-group-lead')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'offline');
      expect(f.app.activeSwarm.panes, hasLength(4));
      await tester.tap(find.byKey(const ValueKey('super-agent-group-open')));
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(f.app.activeSwarm.panes.single.agentId, 'native-b');
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  for (final scenario in [
    (engine: 'codex', viewer: false, fail: false),
    (engine: 'claude', viewer: false, fail: false),
    (engine: 'codex', viewer: true, fail: false),
    (engine: 'codex', viewer: false, fail: true),
  ]) {
    testWidgets('opens a stopped member: $scenario', (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final state = f.connection.server.state;
      state['agents'] = [
        {
          'id': 'worker',
          'name': 'Multiply',
          'machineId': 'm',
          'harnessId': 'native-worker',
          'contributorId': 'owner',
          'configuration': {'engine': scenario.engine},
        },
      ];
      (state['conversations'] as List)[1]['agentIds'] = ['worker'];
      if (scenario.viewer) (state['people'] as List)[0]['role'] = 'viewer';
      f.connection.native = {
        'id': 'native-worker',
        'name': 'Multiply',
        'engine': scenario.engine,
        'sessionId': 'saved-multiply-conversation',
        'status': 'stopped',
        'terminal': {'available': false},
      };
      f.connection.failResume = scenario.fail;
      f.app.machineStates['m']!.agents = [Agent.fromJson(f.connection.native!)];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      c.select('offline');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const Text('Native terminal'),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final calls = f.connection.calls;
      // Opening a pane only navigates. Resume is a separate explicit action.
      Future<void> openTerminal() async {
        tester
            .widget<SuperTabView>(find.byType(SuperTabView))
            .onOpenTerminal(c.snapshot!.agents.single);
        await tester.pumpAndSettle();
      }

      if (!scenario.viewer) {
        // A restored or revisited selection never undoes an explicit stop.
        c.selectTerminal('offline', 'worker');
        await tester.pumpAndSettle();
        expect(calls.where((call) => call.$1 == 'agent_resume'), isEmpty);
        expect(c.terminalAgent('offline')?.id, 'worker');
        expect(f.app.activeSwarm.panes.single.agentId, 'native-worker');
      }
      await openTerminal();
      expect(calls.where((call) => call.$1 == 'agent_resume'), isEmpty);
      final superPane = tester.widget<SuperPane>(find.byType(SuperPane));
      if (scenario.viewer) {
        expect(superPane.onResume, isNull);
      } else {
        superPane.onResume!('m', 'native-worker');
        await tester.pumpAndSettle();
      }
      expect(calls.where((call) => call.$1 == 'agent_create'), isEmpty);
      expect(
        calls.where((call) => call.$1 == 'agent_resume'),
        hasLength(scenario.viewer ? 0 : 1),
      );
      if (scenario.fail) {
        expect(c.terminalAgent('offline')?.id, 'worker');
        expect(
          calls.where((call) => call.$2['action'] == 'prepareNative'),
          isEmpty,
        );
        // A failed resume leaves no native context behind on the backend.
        expect(
          calls.where(
            (call) => (call.$2['path'] as String?)?.endsWith('/native') == true,
          ),
          isEmpty,
        );
        expect(f.app.activeSwarm.panes.single.watchOnly, isTrue);
      } else {
        expect(f.app.activeSwarm.panes.single.agentId, 'native-worker');
        expect(
          f.app.stateOf('m')!.agents.single.sessionId,
          'saved-multiply-conversation',
        );
        expect(f.app.stateOf('m')!.agents.single.isStopped, scenario.viewer);
        if (!scenario.viewer) {
          expect(
            calls.indexWhere((call) => call.$1 == 'agent_resume'),
            lessThan(
              calls.indexWhere((call) => call.$2['action'] == 'prepareNative'),
            ),
          );
          await f.app.requestClosePane(f.app.activeSwarm.panes.single.id);
          await tester.pumpAndSettle();
          await openTerminal();
          expect(
            calls.where((call) => call.$1 == 'agent_resume'),
            hasLength(1),
          );
          expect(calls.where((call) => call.$1 == 'agent_close'), isEmpty);
        }
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    });
  }

  testWidgets(
    'each group restores its terminal and closing it never stops the agent',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1100, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final state = f.connection.server.state;
      state['agents'] = [
        for (final id in ['a', 'b'])
          {
            'id': id,
            'name': id,
            'machineId': 'm',
            'harnessId': 'native-$id',
            'contributorId': 'owner',
            'configuration': {'engine': 'codex'},
          },
      ];
      (state['conversations'] as List)[0]['agentIds'] = ['a'];
      (state['conversations'] as List)[1]['agentIds'] = ['b'];
      f.app.machineStates['m']!.agents = [
        for (final id in ['a', 'b'])
          Agent.fromJson({'id': 'native-$id', 'name': id, 'engine': 'codex'}),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: Text(
                  'Terminal ${f.app.activeSwarm.panes.firstOrNull?.agentId}',
                ),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      c.selectTerminal('lead', 'a');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-a'), findsOneWidget);
      final firstContext = f.app.activeSwarm.panes.single.inputContext;
      expect(firstContext, isNotNull);
      expect(
        f.connection.calls
            .where((call) => call.$2['action'] == 'prepareNative')
            .single
            .$2['contextId'],
        firstContext,
      );
      c.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-a'), findsNothing);
      expect(f.app.activeSwarm.panes, isEmpty);
      c.selectTerminal('offline', 'b');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-b'), findsOneWidget);
      expect(f.app.activeSwarm.panes.single.inputContext, isNot(firstContext));
      c.select('lead');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-a'), findsOneWidget);
      expect(f.app.activeSwarm.panes, hasLength(1));
      (state['people'] as List)[0]['role'] = 'viewer';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm.panes.single.watchOnly, isTrue);
      expect(f.app.activeSwarm.panes.single.inputContext, isNull);
      (state['people'] as List)[0]['role'] = 'owner';
      await c.refresh();
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm.panes.single.watchOnly, isFalse);
      // Individual pane close is disabled; membership owns the pane list.
      await f.app.requestClosePane(f.app.activeSwarm.panes.single.id);
      await tester.pumpAndSettle();
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.terminalAgent('lead')?.id, 'a');
      expect(f.app.activeSwarm.panes.single.agentId, 'native-a');
      final scopes = f.connection.calls
          .where(
            (call) => (call.$2['path'] as String?)?.endsWith('/native') == true,
          )
          .map((call) => (call.$2['body'] as Map)['conversationId']);
      expect(scopes, containsAll(['lead', 'offline']));
      c.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-b'), findsOneWidget);
      // Rapid navigation does not display or reattach a superseded selection.
      c.select('lead');
      c.select('offline');
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm.panes.single.agentId, 'native-b');
      (state['conversations'] as List)[1]['agentIds'] = <String>[];
      await c.refresh();
      await tester.pumpAndSettle();
      expect(f.app.activeSwarm.panes, isEmpty);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'a host recording failure leaves the conversation usable and does not stop its harness',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final state = f.connection.server.state;
      state['agents'] = [
        {
          'id': 'a',
          'name': 'Lead',
          'machineId': 'm',
          'harnessId': 'native-a',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (state['conversations'] as List)[0]['agentIds'] = ['a'];
      f.app.machineStates['m']!.agents = [
        Agent.fromJson({'id': 'native-a', 'name': 'Lead', 'engine': 'codex'}),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const Text('Native terminal'),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      c.selectTerminal('lead', 'a');
      await tester.pumpAndSettle();
      expect(find.text('Native terminal'), findsOneWidget);
      f.connection.failNative = true;
      await tester.pump(const Duration(seconds: 21));
      await tester.pumpAndSettle();
      expect(c.terminalAgent('lead')?.id, 'a');
      expect(f.app.activeSwarm.panes.single.agentId, 'native-a');
      expect(
        tester.widget<SuperPane>(find.byType(SuperPane)).failures[(
          'm',
          'native-a',
        )],
        contains('Terminal sharing paused'),
      );
      expect(f.app.activeSwarm.panes.single.watchOnly, isTrue);
      await tester.tap(find.byTooltip('Chat'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('super-message-composer')),
        findsOneWidget,
      );
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_close'),
        isEmpty,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );
}
