import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  // A Pro with a Lead of this Swarm open scrolls the Swarm's chat in the app, the way an agent screen scrolls its pane.
  testWidgets(
    'the dial scrolls the chat of the Swarm whose Lead the device has open',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      for (var i = 0; i < 60; i++) {
        server.append('message $i');
      }
      final c = server.controller();
      addTearDown(c.dispose);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      ScrollPosition position() => tester
          .widget<ListView>(
            find.byKey(const PageStorageKey('super-messages-tab-lead')),
          )
          .controller!
          .position;
      final end = position().pixels;
      expect(end, position().maxScrollExtent);
      expect(end, greaterThan(100));

      Future<void> dial(AppNotifier app, Map<String, dynamic> p) =>
          app.handleEventForTest('m', {'type': 'dial_scroll', 'payload': p});
      await dial(app, {'phase': 'down', 'dy': 0, 'superTabId': 'tab'});
      // Terminal convention: a positive dy shows earlier lines, here older messages.
      await dial(app, {'phase': 'move', 'dy': 20, 'superTabId': 'tab'});
      expect(position().pixels, end - 50);
      await dial(app, {'phase': 'move', 'dy': -8, 'superTabId': 'tab'});
      expect(position().pixels, end - 30);
      await dial(app, {'phase': 'move', 'dy': -100, 'superTabId': 'tab'});
      expect(position().pixels, end, reason: 'clamped at the newest message');
      await dial(app, {
        'phase': 'up',
        'dy': 0,
        'velocity': 0,
        'superTabId': 'tab',
      });

      // Another Swarm's scroll, or one that names none, leaves this chat alone.
      await dial(app, {'phase': 'move', 'dy': 20, 'superTabId': 'other'});
      await dial(app, {'phase': 'move', 'dy': 20});
      expect(position().pixels, end);

      // Gone from the screen, the chat no longer takes the dial.
      await tester.pumpWidget(const SizedBox());
      await dial(app, {'phase': 'move', 'dy': 20, 'superTabId': 'tab'});
    },
  );
}
