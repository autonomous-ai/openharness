import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
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
      c.select('offline');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-a'), findsNothing);
      expect(f.app.activeSwarm.panes, isEmpty);
      c.selectTerminal('offline', 'b');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-b'), findsOneWidget);
      c.select('lead');
      await tester.pumpAndSettle();
      expect(find.text('Terminal native-a'), findsOneWidget);
      expect(f.app.activeSwarm.panes, hasLength(1));
      // Native pane Close and the narrow Back action have the same personal state.
      await f.app.closePane(f.app.activeSwarm.panes.single.id);
      await tester.pumpAndSettle();
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.terminalAgent('lead'), isNull);
      expect(f.app.activeSwarm.panes, isEmpty);
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
}
