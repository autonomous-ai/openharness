import 'package:harness/widgets/swarm_switcher.dart';
import 'package:flutter/services.dart';

import 'swarm_interactions_test.dart' show chord;

import 'package:harness/state/swarm_navigation.dart';
import 'package:flutter/material.dart';
import 'package:harness/widgets/swarm_project_agents.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;

void main() {
  testWidgets(
    'project membership includes an older remote daemon and survives reopening',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final app = createApp();
      app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
        computerId: 'local',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
        agentProjects: const {
          'a0': AgentProject(name: 'Solid', cwd: '/work/workshop'),
          'a1': AgentProject(name: 'Solid', cwd: '/work/workshop'),
        },
      );
      app.machineStates['remote'] =
          MachineState(
              const Machine(
                machineId: 'remote',
                name: 'iMac Home',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..agents = [
              const Agent(
                id: 'chess',
                name: 'Chess Set',
                terminalAvailable: true,
              ),
              const Agent(
                id: 'unrelated',
                name: 'Other work',
                terminalAvailable: true,
              ),
            ];
      final memory = MemoryStore();
      final projects = SwarmProjectStore(storage: memory);
      await projects.load();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final editing = showSwarmProjectAgents(
        tester.element(find.byType(SwarmScreen)),
        app,
        swarmProjects(app, projects.projects).single,
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byWidgetPredicate(
          (w) =>
              w is TextField &&
              w.decoration?.hintText == 'Find a harness or machine',
        ),
        'Chess Set',
      );
      await tester.pump();
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Chess Set'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final saved = await editing;
      expect(saved, isNotNull);
      await projects.add(saved!);
      final restored = SwarmProjectStore(storage: memory);
      await restored.load();
      final group = swarmProjects(app, restored.projects).single;
      expect(group.agents.map((a) => a.agent.id), ['a0', 'a1', 'chess']);
      expect(
        app.panes,
        isEmpty,
        reason:
            'Editing project membership does not attach or take over terminals',
      );
      await chord(tester, LogicalKeyboardKey.keyP);
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Solid',
      );
      await tester.pump();
      expect(
        tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search
            .rows
            .where((row) => row.isProject),
        isEmpty,
      );
      await tester.tap(
        find.byKey(ValueKey(agentDestinationId('remote', 'chess'))),
      );
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.panes.map((p) => (p.machineId, p.agentId)), [
        ('remote', 'chess'),
      ]);
      expect(app.panes.single.machineId, 'remote');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
      restored.dispose();
    },
  );
}
