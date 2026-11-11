import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_swarm.dart' show addAskingAgent;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;

void main() {
  testWidgets(
    'the Dock badge counts the agents that ask the person in their Swarms, and '
    'clears when they are read, or the workspace leaves',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final f = SuperTabLaunchFixture(local: true);
      final app = f.app;
      app.bindSuperTab(app.activeSwarmId, tabId, 'Pilot');
      app.newSwarm(name: 'Desktop');
      final c = await app.superTabs.open(tabId);
      await c.refresh();
      await mount(tester, app, nativeTabs: true);
      await tester.pump();
      expect(updates.last['dockBadge'], 0);

      final server = f.connection.server;
      addAskingAgent(server, 'kai');
      addAskingAgent(server, 'quinn');
      await tester.runAsync(c.refresh);
      await tester.pump();
      expect(updates.last['dockBadge'], 2);

      // Both chats read on another device.
      server.state['readMarks'] = {
        'owner': {
          'agent-chat-kai': server.revision,
          'agent-chat-quinn': server.revision,
        },
      };
      await tester.runAsync(c.refresh);
      await tester.pump();
      expect(updates.last['dockBadge'], 0);

      await tester.pumpWidget(const SizedBox());
      expect(updates.last['enabled'], isFalse);
      expect(updates.last['dockBadge'], isNull);
      f.dispose();
    },
  );
}
