import 'package:flutter_test/flutter_test.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_quiet_chat_test.dart' show project, row;

// Dee, 11-05 (task #3165): #lamp-gtm showed "Lead changed the instructions for
// dee: ..." with its Removed/Added lines and "See revision N", which nobody can
// act on. The backend posts none since #3132; the ones already in chats are no
// row and nothing unread. Nothing is deleted: the instructions' History keeps
// every revision.

const _text =
    'Lead changed the instructions for dee: Routing: no Haiku.\n\n'
    'In Routing:\nRemoved: Haiku reviews.\nAdded: Opus reviews.';

Map<String, dynamic> _saved(int sequence) => row(
  'saved-$sequence',
  sequence,
  _text,
  source: {'kind': 'instructions', 'projectId': 'lead', 'revision': sequence},
);

void main() {
  testWidgets('an instruction-change post is no chat row; other posts show', (
    tester,
  ) async {
    final c = await showView(
      tester,
      project([row('m1', 1, 'A real update'), _saved(2), row('m3', 3, 'Next')]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('A real update'), findsOneWidget);
    expect(find.text('Next'), findsOneWidget);
    expect(find.textContaining('changed the instructions'), findsNothing);
    expect(find.textContaining('Removed: Haiku reviews.'), findsNothing);
    expect(find.textContaining('See revision'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the chat lists only its other posts', (tester) async {
    final c = await showView(
      tester,
      project([row('m1', 1, 'A real update'), _saved(2), _saved(3)]),
    );
    await c.loadMessages('lead');
    expect([for (final m in c.messages('lead')) m.id], ['m1']);
  });

  testWidgets('a chat whose only new rows are instruction changes shows as '
      'read', (tester) async {
    final server = project([
      row('m1', 1, 'Hello'),
      _saved(2),
      _saved(3),
    ], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isFalse);
    expect(c.unreadCount(lead), 0);
  });

  testWidgets('an instruction change beside a real post counts only the post', (
    tester,
  ) async {
    final server = project([
      row('m1', 1, 'Hello'),
      _saved(2),
      row('m3', 3, 'Real news'),
    ], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isTrue);
    expect(c.unreadCount(lead), 1);
  });
}
