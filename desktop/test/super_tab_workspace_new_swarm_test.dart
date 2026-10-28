import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/super_tabs/workspaces.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  testWidgets('New Swarm in the Workspace menu starts a new Swarm there', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = SuperTabLaunchFixture()
      ..connection.workspaces = [
        {
          'id': 'w1',
          'name': 'Autonomous',
          'role': 'owner',
          'revision': 1,
          'swarms': [
            {'id': tabId, 'name': 'Company', 'member': true},
          ],
        },
        {
          'id': 'w2',
          'name': 'Acme',
          'role': 'member',
          'revision': 1,
          'swarms': [],
        },
      ];
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    var newSwarms = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: f.app,
            builder: (_, _) => SuperTabWorkspace(
              app: f.app,
              canvas: const SizedBox.expand(),
              onAddAgent: (_) {},
              onNewSwarm: () => newSwarms++,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-workspace-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New Swarm in Autonomous'));
    await tester.pumpAndSettle();
    expect(newSwarms, 1);
    expect(SwarmWorkspaces.of(f.app.superTabs).takeNewSwarmWorkspace(), 'w1');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });
}
