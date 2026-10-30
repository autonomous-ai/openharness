import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';

void main() {
  testWidgets(
    'roster opens another project from Devices only through current workgroup membership',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1440, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Company');
      final state = f.connection.server.state;
      state['projects'] = [
        projectFixture('lead', 'Web', 'lead'),
        projectFixture('mobile', 'Mobile', 'mobile-lead'),
      ];
      state['agents'] = [
        {
          'id': 'nova',
          'displayName': 'Nova',
          'name': 'Engineer',
          'projectId': 'mobile',
          'machineId': 'm',
          'harnessId': 'native-nova',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      final mobileLead = {
        ...conversationFixture('mobile-lead', 'Product Manager'),
        'projectId': 'mobile',
        'agentIds': ['nova'],
      };
      final mobileWork = {
        ...conversationFixture('mobile-work', 'Build the mobile app'),
        'projectId': 'mobile',
        'agentIds': ['nova'],
      };
      (state['conversations'] as List).addAll(<Map<String, dynamic>>[
        mobileLead,
        mobileWork,
      ]);
      f.app.stateOf('m')!.agents = [
        Agent.fromJson({
          'id': 'native-nova',
          'name': 'Nova',
          'engine': 'codex',
          'status': 'stopped',
          'sessionId': 'saved-nova',
          'terminal': {'available': false},
        }),
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      c.select('mobile-lead');
      c.selectDevices();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: f.app,
              builder: (_, _) => SuperTabWorkspace(
                app: f.app,
                canvas: const SizedBox.expand(),
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isTrue);
      expect(c.selectedId, 'mobile-lead');
      await tester.tap(find.byKey(const ValueKey('super-member-nova')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Open terminal'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-agent-group-mobile-work')),
      );
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isTrue);

      // Losing membership while this chooser is open cannot open a stale
      // conversation or silently substitute the agent's other workgroup.
      mobileWork['agentIds'] = <String>[];
      await c.refresh();
      await tester.pumpAndSettle();
      final open = find.byKey(const ValueKey('super-agent-group-open'));
      expect(tester.widget<FilledButton>(open).onPressed, isNull);
      await tester.tap(open);
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isTrue);
      expect(c.selectedId, 'mobile-lead');
      expect(f.app.panes.any((pane) => pane.agentId == 'native-nova'), isFalse);

      await tester.tap(
        find.byKey(const ValueKey('super-agent-group-mobile-lead')),
      );
      await tester.pumpAndSettle();
      await tester.tap(open);
      await tester.pumpAndSettle();
      expect(c.devicesSelected, isFalse);
      expect(c.selectedId, 'mobile-lead');
      expect(f.app.panes.single.agentId, 'native-nova');
      expect(c.terminalAgents('mobile-lead').single.id, 'nova');
      expect(
        f.connection.calls.where(
          (call) => call.$1 == 'agent_create' || call.$1 == 'agent_resume',
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
}
