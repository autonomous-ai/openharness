import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/laid_out_list.dart';

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
          .widget<ScrollView>(
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

  // A Lead swipe on the device selects another conversation: a fling still running from the last one stops, it never scrolls the new chat.
  testWidgets(
    'a running fling stops when the Swarm selects another conversation',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      for (var i = 0; i < 60; i++) {
        server.append('lead $i');
        server.append('offline $i', conversationId: 'offline');
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
      Future<void> dial(Map<String, dynamic> p) => app.handleEventForTest('m', {
        'type': 'dial_scroll',
        'payload': {...p, 'superTabId': 'tab'},
      });
      await dial({'phase': 'down', 'dy': 0});
      await dial({'phase': 'move', 'dy': 20});
      await dial({'phase': 'up', 'dy': 0, 'velocity': 2000});
      c.select('offline');
      await tester.pumpAndSettle();
      ScrollPosition position() => tester
          .widget<ScrollView>(
            find.byKey(const PageStorageKey('super-messages-tab-offline')),
          )
          .controller!
          .position;
      final shown = position().pixels;
      expect(shown, position().maxScrollExtent);
      // Inertia reads the wall clock: let it pass, then pump the timers a fling would run on.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        position().pixels,
        shown,
        reason: 'the old fling does not move the new chat',
      );
    },
  );

  // A thread open beside the chat is what the dial's thread face shows: the dial scrolls the thread, never the chat behind it
  // (Diego, 2026-11-04).
  testWidgets(
    'with a thread open, the dial scrolls the thread and leaves the chat',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer()..threads = true;
      for (var i = 0; i < 60; i++) {
        server.append('message $i');
      }
      for (var i = 1; i <= 40; i++) {
        server.append('Reply $i: a long enough answer to fill the pane.');
        server.messages.last
          ..['thread'] = 'message-1'
          ..['replyTo'] = 'message-1';
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
      c.openThread('message-1');
      await tester.pumpAndSettle();
      ScrollPosition chat() => tester
          .widget<ScrollView>(
            find.byKey(const PageStorageKey('super-messages-tab-lead')),
          )
          .controller!
          .position;
      ScrollPosition thread() => tester
          .widget<ListView>(
            find.descendant(
              of: find.byKey(const ValueKey('super-thread-panel')),
              matching: find.byType(LaidOutListView),
            ),
          )
          .controller!
          .position;
      final chatAt = chat().pixels, threadEnd = thread().pixels;
      expect(threadEnd, greaterThan(100));

      Future<void> dial(Map<String, dynamic> p) => app.handleEventForTest('m', {
        'type': 'dial_scroll',
        'payload': {...p, 'superTabId': 'tab'},
      });
      await dial({'phase': 'down', 'dy': 0});
      await dial({'phase': 'move', 'dy': 20});
      expect(thread().pixels, threadEnd - 50);
      expect(chat().pixels, chatAt, reason: 'the chat behind the thread stays');

      // Closed, the thread gives the dial back to the chat.
      c.closeThread();
      await tester.pumpAndSettle();
      final back = chat().pixels;
      await dial({'phase': 'move', 'dy': 20});
      expect(chat().pixels, back - 50);
      await dial({'phase': 'up', 'dy': 0, 'velocity': 0});
      await tester.pumpWidget(const SizedBox());
    },
  );
}
