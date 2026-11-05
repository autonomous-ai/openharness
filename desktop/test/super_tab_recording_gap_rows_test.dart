import 'package:flutter_test/flutter_test.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'super_tab_quiet_chat_test.dart' show project, row;

// Dee, 11-05 (task #3127): #lamp-gtm showed "Nico's terminal recording was
// interrupted 4 times. Open terminal", which gives a person nothing to do. A
// terminal's recording gap is no chat row and nothing unread; the server keeps
// it for diagnosis, and a required recovery still reaches the coordinator.

const _gapText =
    'Some terminal activity could not be recorded. '
    'Check the native session for the full conversation.';
const _recoveryText =
    'Nico\'s terminal recording on "Lamp GTM" has a gap. '
    'The work was interrupted by a restart of the terminal recording.';

Map<String, dynamic> _gap(int sequence) => row(
  'gap-$sequence',
  sequence,
  _gapText,
  kind: 'native',
  source: {'phase': 'gap'},
);

Map<String, dynamic> _recovery(int sequence) => {
  ...row(
    'recovery-$sequence',
    sequence,
    _recoveryText,
    kind: 'native',
    source: {
      'phase': 'gap',
      'recovery': {'reason': 'recording_restarted', 'required': true},
    },
  ),
  'deliveries': [
    {'id': 'to-lead', 'status': 'delivered'},
  ],
};

void main() {
  testWidgets('a run of recording gaps is no chat row', (tester) async {
    final c = await showView(
      tester,
      project([
        row('m1', 1, 'A real update'),
        _gap(2),
        _gap(3),
        _recovery(4),
        _gap(5),
      ]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('A real update'), findsOneWidget);
    expect(find.textContaining('recording was interrupted'), findsNothing);
    expect(find.text('Terminal recording interrupted'), findsNothing);
    expect(find.text(_gapText), findsNothing);
    expect(find.textContaining('has a gap'), findsNothing);
    expect(find.text('Open terminal'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a chat whose only new rows are recording gaps shows as read', (
    tester,
  ) async {
    final server = project([row('m1', 1, 'Hello'), _gap(2), _gap(3)], read: 1);
    final c = server.controller();
    await c.refresh();
    addTearDown(c.dispose);
    await c.loadMessages('lead');
    final lead = c.snapshot!.conversation('lead')!;
    expect(c.unread(lead), isFalse);
    expect(c.unreadCount(lead), 0);
  });
}
