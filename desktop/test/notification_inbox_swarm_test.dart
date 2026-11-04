// Huy (11-04, #2792): the bell's Notifications row for a Swarm agent waiting
// on him opened nothing, like its toast: it opens the agent's terminal
// beside the chat it waits in.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/state/notification_inbox.dart';
import 'package:harness/super_tabs/workspace.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'super_tab_waiting_notice_test.dart' show waitingSwarm;

void main() {
  testWidgets('the bell\'s row for a Swarm agent opens its terminal beside '
      'the task it waits in', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = SuperTabLaunchFixture();
    final c = await waitingSwarm(f);
    final swarm = f.app.activeSwarmId;
    f.app.newSwarm();
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
    final opened = await openInboxNotification(
      f.app,
      const InboxNotification(
        machineId: 'm',
        agentId: 'native-nova',
        title: 'nova',
        detail: '',
        kind: AlertKind.needsYou,
        unavailable: null,
      ),
    );
    await tester.pumpAndSettle();
    expect(opened, isTrue);
    expect(f.app.activeSwarmId, swarm);
    expect(c.selectedId, 'task');
    expect(f.app.focusedPane?.agentId, 'native-nova');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });
}
