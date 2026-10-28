import 'dart:async';

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

  test('older read during an open poll read still asks before=', () async {
    final server = ConversationServer()..messagePage = 2;
    for (final text in ['one', 'two', 'three', 'four']) {
      server.append(text);
    }
    final c = server.controller();
    await c.refresh();
    final reads = <String>[];
    server.onRead = reads.add;
    final slow = server.holdReads = Completer<void>();

    // The poll's read of new messages is open when the reader scrolls up.
    final newest = c.loadMessages('lead');
    final older = c.loadMessages('lead', older: true);
    server.holdReads = null;
    slow.complete();
    await Future.wait([newest, older]);

    expect(reads, contains(endsWith('messages?before=3&beforeId=message-3')));
    expect(c.messages('lead').map((m) => m.text), [
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  test(
    'an older page that lands while a poll reads its receipt is kept',
    () async {
      final server = ConversationServer()..messagePage = 2;
      for (final text in ['one', 'two', 'mine']) {
        server.append(text);
      }
      // The reader's own message, not yet answered: a read past it asks for
      // its receipt again.
      server.messages.last['deliveries'] = [
        {'agentId': 'lead-agent', 'status': 'delivered'},
      ];
      final c = server.controller();
      await c.refresh();
      // One page of replies: more would make the poll read the latest page.
      for (final text in ['r1', 'r2']) {
        server.append(text);
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'lead-agent',
          'name': 'Lead',
        };
      }
      final reads = <String>[];
      server.onRead = reads.add;
      final pages = server.holdReads = Completer<void>();

      var newestDone = false;
      final newest = c.loadMessages('lead').then((_) => newestDone = true);
      final older = c.loadMessages('lead', older: true);
      // Both pages go; the poll's receipt read that follows waits.
      final receipt = server.holdReads = Completer<void>();
      pages.complete();
      await older;
      await pumpEventQueue();
      expect(newestDone, isFalse, reason: 'its receipt read is still open');
      server.holdReads = null;
      receipt.complete();
      await newest;
      expect(reads.last, contains('messageId=message-3'));

      expect(c.messages('lead').map((m) => m.text), [
        'one',
        'two',
        'mine',
        'r1',
        'r2',
      ]);
    },
  );

  test(
    'returning after more than a page arrived shows the latest page at once',
    () async {
      final server = ConversationServer();
      for (var i = 1; i <= 100; i++) {
        server.append('lead $i');
      }
      server.append('result', conversationId: 'offline');
      final c = server.controller();
      await c.refresh();
      expect(c.messages('lead').last.sequence, 100);
      await c.select('offline');
      await c.loadMessages('offline');
      // Away from the conversation, 600 messages arrive.
      for (var i = 102; i <= 701; i++) {
        server.append('lead $i');
      }
      await c.refresh();

      // The one read that opening the conversation starts.
      await c.select('lead');
      await pumpEventQueue();

      final shown = c.messages('lead');
      expect(shown.last.sequence, 701);
      expect(shown, hasLength(100));
      expect(c.hasOlder('lead'), isTrue);
      // The view marks what it shows read: the newest message, nothing more.
      c.markRead('lead', through: 701);
      expect(c.unread(c.selected!), isFalse);
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
