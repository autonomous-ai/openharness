import 'package:flutter_test/flutter_test.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_quiet_chat_test.dart' show project, row;

// Swarm v4 (anh Dee, 2026-11-10: v1-v3 goes): the backend still writes a note when an agent types into another's
// terminal (`terminal-input`) and when a daemon sees an agent wait at a prompt or hit a usage limit (`terminal-alert`).
// They were v3's Lead terminal notes; in v4 they are no chat row and nothing unread. A person still hears "Waiting on
// you" from their own computer, and an agent's details say until when it is limited.

Map<String, dynamic> _typed(int sequence) => row(
  'typed-$sequence',
  sequence,
  'Kai typed `y` + Enter in Pip\'s terminal',
  kind: 'terminal-input',
  source: {'agentId': 'pip', 'requestId': 'r$sequence'},
);

Map<String, dynamic> _alert(int sequence, String alert) => row(
  'alert-$sequence',
  sequence,
  alert == 'prompt'
      ? 'Pip is waiting at a prompt in its terminal.'
      : 'Pip hit a usage limit.',
  kind: 'terminal-alert',
  source: {'agentId': 'pip', 'alert': alert},
);

void main() {
  testWidgets('a terminal\'s typing and alert notes are no chat row', (
    tester,
  ) async {
    final c = await showView(
      tester,
      project([
        row('m1', 1, 'A real update'),
        _typed(2),
        _alert(3, 'prompt'),
        _alert(4, 'limit'),
        row('m5', 5, 'Next'),
      ]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('A real update'), findsOneWidget);
    expect(find.text('Next'), findsOneWidget);
    expect(find.textContaining('typed'), findsNothing);
    expect(find.textContaining('waiting at a prompt'), findsNothing);
    expect(find.textContaining('usage limit'), findsNothing);
    expect([for (final m in c.messages('lead')) m.id], ['m1', 'm5']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a chat whose only new rows are terminal notes shows as read', (
    tester,
  ) async {
    final server = project([
      row('m1', 1, 'Hello'),
      _typed(2),
      _alert(3, 'prompt'),
    ], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isFalse);
    expect(c.unreadCount(lead), 0);
  });
}
