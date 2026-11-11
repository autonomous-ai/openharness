import 'package:flutter_test/flutter_test.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_quiet_chat_test.dart' show project, row;

// Ken, 11-04 (task #2849): the project chat showed a row "Terminal input ·
// session opened by ken15@…" carrying the whole hourly cleanup prompt typed
// into the PM's terminal. What was typed into an agent's terminal is no chat
// row; the terminal's answer still is.

const _prompt = 'Run the hourly cleanup: archive finished groups.';
const _answer = 'Cleanup done: 3 groups archived.';

Map<String, dynamic> _typed(int sequence) => row(
  'typed',
  sequence,
  _prompt,
  kind: 'native',
  source: {
    'phase': 'prompt',
    'operator': {'name': 'ken15@autonomous.ai'},
  },
);

Map<String, dynamic> _answered(int sequence) =>
    row('answered', sequence, _answer, kind: 'native');

void main() {
  testWidgets('a terminal\'s prompt is no chat row; its answer still is', (
    tester,
  ) async {
    final c = await showView(tester, project([_typed(1), _answered(2)]));
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text(_prompt), findsNothing);
    expect(find.textContaining('Terminal input'), findsNothing);
    expect(find.text(_answer), findsOneWidget);
    expect(find.text('Terminal answer'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a terminal\'s prompt counts as nothing unread; its answer '
      'counts', (tester) async {
    final server = project([
      row('m1', 1, 'Hello'),
      _typed(2),
      _answered(3),
    ], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isTrue);
    expect(c.unreadCount(lead), 1);
  });

  testWidgets('a chat whose only new row is a terminal\'s prompt shows as '
      'read', (tester) async {
    final server = project([row('m1', 1, 'Hello'), _typed(2)], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isFalse);
    expect(c.unreadCount(lead), 0);
  });

  test('reading to the last row drawn reads a terminal\'s prompt after it '
      'too, so other devices show the chat read', () async {
    final server = project([row('m1', 1, 'Hello'), _typed(2)]);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    c.markRead('lead', through: 1);
    expect(c.readMark('lead'), 2);
  });
}
