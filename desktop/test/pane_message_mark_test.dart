import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/pane_message_mark.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/terminal_panel.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

/// The pane header's Agent Messages mark (docs/design/2026-10-10-agent-messages.md,
/// "Panes"): `→ <recipient>` on the sender, `← <sender>` on the recipient, for a
/// few seconds or until that pane is focused, beside the activity mark.
Map<String, dynamic> _changed(String id, String from, String to) => {
  'type': 'messages_changed',
  'payload': {
    'tabId': 'tab',
    'messageId': id,
    'at': 1,
    'from': {'machineId': 'm', 'agentId': from},
    'to': [
      {'machineId': 'm', 'agentId': to, 'state': 'queued'},
    ],
  },
};

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('a message marks its panes for five seconds '
        '(${brightness.name})', (tester) async {
      final app = createApp(connected: true);
      final sender = terminal('a0', []), recipient = terminal('a1', []);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Column(
              children: [
                for (final session in [sender, recipient])
                  Expanded(
                    child: TerminalPanel(
                      key: ValueKey(session.agentId),
                      notifier: app,
                      session: session,
                      focused: false,
                      compactHeader: true,
                    ),
                  ),
              ],
            ),
          ),
        ),
      );
      await tester.pump();
      final panel = tester.state(find.byKey(const ValueKey('a0')));
      final mark = find.byKey(const ValueKey('pane-message-mark'));
      expect(mark, findsNothing);
      expect(find.byType(PaneMessageMarkView), findsNWidgets(2));
      final title = tester.getRect(
        find.byKey(const ValueKey('terminal-pane-title')).first,
      );

      await app.handleEventForTest('m', _changed('m0000001', 'a0', 'a1'));
      await tester.pump();
      expect(find.text('→ Agent 1'), findsOneWidget);
      expect(find.text('← Agent 0'), findsOneWidget);
      expect(
        tester.getRect(find.text('→ Agent 1')).left,
        greaterThan(title.right),
        reason: 'after the title and its activity mark',
      );
      expect(
        tester.getRect(find.byKey(const ValueKey('terminal-pane-title')).first),
        title,
      );
      expect(
        tester.state(find.byKey(const ValueKey('a0'))),
        same(panel),
        reason: 'the cached header is not rebuilt',
      );
      await tester.pump(const Duration(seconds: 4));
      expect(mark, findsNWidgets(2));
      await tester.pump(const Duration(seconds: 1, milliseconds: 100));
      expect(mark, findsNothing);
      expect(tester.takeException(), isNull);

      await app.handleEventForTest('m', {
        'type': 'messages_changed',
        'payload': {
          'limited': {'machineId': 'm', 'agentId': 'a0'},
        },
      });
      await tester.pump();
      expect(find.text('→ rate limited'), findsOneWidget);
      await tester.pump(const Duration(seconds: 61));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      sender.dispose();
      recipient.dispose();
    });
  }

  testWidgets('focusing the pane clears its mark', (tester) async {
    final app = createApp(connected: true);
    final session = terminal('a1', []);
    final pane = app.adoptSessionForTest(session);
    app.focusedPaneId = null;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TerminalPanel(
            notifier: app,
            session: session,
            focused: false,
            compactHeader: true,
          ),
        ),
      ),
    );
    await app.handleEventForTest('m', _changed('m0000002', 'a0', 'a1'));
    await tester.pump();
    expect(find.text('← Agent 0'), findsOneWidget);
    app.focusPane(pane.id);
    await tester.pump();
    expect(find.text('← Agent 0'), findsNothing);
    await tester.pump(const Duration(seconds: 61));
    await tester.pumpWidget(const SizedBox());
    // The app disposes the session it adopted.
    app.dispose();
  });
}
