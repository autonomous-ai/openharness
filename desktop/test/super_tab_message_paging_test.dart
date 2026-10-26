import 'package:flutter_test/flutter_test.dart';

import 'support/super_tab_fixture.dart';

/// Older history pages by (sequence, id): messages from before the parts
/// migration can share a sequence, and a page edge inside such a run must not
/// skip any (docs/design/2026-10-26-swarm-state-parts.md, section 4.6).
void main() {
  test(
    'older pages continue after the last message read, ties included',
    () async {
      final server = ConversationServer()..messagePage = 2;
      for (final text in ['one', 'two', 'three', 'four', 'five']) {
        server.append(text);
      }
      // One old command posted three of them: they share its sequence.
      for (final m in server.messages.skip(1).take(3)) {
        m['sequence'] = 2;
      }
      final reads = <String>[];
      final paging = server.controller();
      await paging.refresh();
      expect(paging.messages('lead').map((m) => m.text), ['four', 'five']);
      expect(paging.hasOlder('lead'), isTrue);
      server.onRead = reads.add;
      await paging.loadMessages('lead', older: true);
      await paging.loadMessages('lead', older: true);
      expect(paging.hasOlder('lead'), isFalse);
      expect(paging.messages('lead').map((m) => m.text), [
        'one',
        'two',
        'three',
        'four',
        'five',
      ]);
      expect(reads.first, endsWith('messages?before=2&beforeId=message-4'));
    },
  );

  test('a new message is read after the newest one', () async {
    final server = ConversationServer()..append('one');
    final c = server.controller();
    await c.refresh();
    final reads = <String>[];
    server.onRead = reads.add;
    server.append('two');
    await c.refresh();
    expect(
      reads.where((p) => p.contains('/messages')).first,
      endsWith('messages?after=1'),
    );
    expect(c.messages('lead').map((m) => m.text), ['one', 'two']);
  });
}
