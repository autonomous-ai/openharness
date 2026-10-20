import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/pane.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
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
      // Participants → Open terminal, the only way to relaunch a stopped member.
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
