import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';

/// A conversation left open all day holds a capped tail of its messages, and
/// one left for a while holds none: neither grows with the day.
void main() {
  /// Polls [c] while [count] messages arrive in [server]'s lead chat, a
  /// batch of 50 (under a page) between polls.
  Future<void> pollThrough(
    ConversationServer server,
    SuperTabController c,
    int count,
  ) async {
    for (var sent = 0; sent < count; sent += 50) {
      for (var i = 0; i < 50; i++) {
        server.append('message');
      }
      await c.loadMessages('lead');
    }
  }

  test('2,000 messages through polls hold the latest 500, with older pages '
      'still offered', () async {
    final server = ConversationServer();
    final c = server.controller();
    await c.refresh();

    await pollThrough(server, c, 2000);

    final held = c.messages('lead').map((m) => m.sequence).toList();
    expect(held, List.generate(500, (i) => i + 1501));
    expect(c.hasOlder('lead'), isTrue);
  });

  test('scrolling up after the cut reads the rows cut, oldest kept first, and '
      'keeps them', () async {
    final server = ConversationServer();
    final c = server.controller();
    await c.refresh();
    await pollThrough(server, c, 2000);
    final reads = <String>[];
    server.onRead = reads.add;

    // The Earlier row, pressed with the list at its end.
    await c.loadMessages('lead', older: true);

    expect(
      reads.single,
      endsWith('messages?before=1501&beforeId=message-1501'),
    );
    final held = c.messages('lead').map((m) => m.sequence).toList();
    expect(held, List.generate(600, (i) => i + 1401));
    expect(c.hasOlder('lead'), isTrue);
  });

  test('a reader scrolled up keeps every row through the polls, and back at '
      'the end the next poll cuts to the latest 500', () async {
    final server = ConversationServer();
    final c = server.controller();
    await c.refresh();
    c.readingBack('lead', true);

    await pollThrough(server, c, 2000);

    expect(
      c.messages('lead').map((m) => m.sequence),
      List.generate(2000, (i) => i + 1),
    );
    expect(c.hasOlder('lead'), isFalse);

    c.readingBack('lead', false);
    await c.loadMessages('lead');

    expect(
      c.messages('lead').map((m) => m.sequence),
      List.generate(500, (i) => i + 1501),
    );
    expect(c.hasOlder('lead'), isTrue);
  });

  test('a message sent while a poll cuts shows once, newest, and leaves '
      'nothing outgoing', () async {
    final server = ConversationServer();
    Completer<void>? post;
    final c = SuperTabController(
      tabId: 'tab',
      accountId: 'owner',
      save: server.save,
      initial: const {},
      pollInterval: Duration.zero,
      request: (method, path, {body}) async {
        if (method == 'POST') await post?.future;
        return server.request(method, path, body: body);
      },
    );
    addTearDown(c.dispose);
    await c.refresh();
    await pollThrough(server, c, 500);
    c.setDraft('lead', 'Please check the arm64 build');
    post = Completer<void>();

    final sending = c.send();
    await pumpEventQueue();
    // While it is on its way, a poll brings 50 more and cuts as many.
    await pollThrough(server, c, 50);
    expect(c.messages('lead'), hasLength(500));
    final outgoing = c.outgoing('lead');
    expect(outgoing, hasLength(1));
    expect(outgoing.single.state, SuperTabOutgoingState.sending);
    expect(outgoing.single.text, 'Please check the arm64 build');
    post.complete();
    await sending;

    final held = c.messages('lead');
    expect(held.last.text, 'Please check the arm64 build');
    expect(held.where((m) => m.text == 'Please check the arm64 build'), [
      held.last,
    ]);
    expect(held, hasLength(500));
    expect(c.outgoing('lead'), isEmpty);
    expect(c.hasOlder('lead'), isTrue);
  });

  test('the view saved right after a cut draws its last page and reads on '
      'from it', () async {
    final server = ConversationServer();
    const reading = SuperTabReading(drawsSaved: true);
    final c = server.controller(reading: reading);
    addTearDown(c.dispose);
    await c.refresh();
    await pollThrough(server, c, 2000);

    final view = jsonDecode(jsonEncode(c.savedView)) as Map<String, dynamic>;
    final rows = (view['messages'] as List).cast<Map<String, dynamic>>();
    expect(rows.map((r) => r['sequence']), List.generate(100, (i) => i + 1901));
    expect(view['next'], {'sequence': 1901, 'id': 'message-1901'});

    final again = server.controller(reading: reading);
    addTearDown(again.dispose);
    again.drawSaved(view);
    expect(
      again.messages('lead').map((m) => m.sequence),
      List.generate(100, (i) => i + 1901),
    );
    expect(again.hasOlder('lead'), isTrue);

    // The Earlier row, pressed before any read has answered: the cursor is
    // the one the view saved.
    final reads = <String>[];
    server.onRead = reads.add;
    await again.loadMessages('lead', older: true);

    expect(
      reads.single,
      endsWith('messages?before=1901&beforeId=message-1901'),
    );
    expect(
      again.messages('lead').map((m) => m.sequence),
      List.generate(200, (i) => i + 1801),
    );
  });

  test('the rows kept for the saved view are cut with the messages', () async {
    final server = ConversationServer();
    final c = server.controller(
      reading: const SuperTabReading(drawsSaved: true),
    );
    addTearDown(c.dispose);
    await c.refresh();

    await pollThrough(server, c, 2000);

    expect(c.messages('lead'), hasLength(500));
    expect(c.heldRows('lead'), 500);
  });

  test('rows from where the view lays its list out are never cut', () async {
    final server = ConversationServer();
    final c = server.controller();
    await c.refresh();
    await pollThrough(server, c, 400);
    c.keepFrom('lead', c.messages('lead').firstWhere((m) => m.sequence == 301));

    await pollThrough(server, c, 600);

    // Only the 300 before it go, though 1,000 are held.
    final held = c.messages('lead').map((m) => m.sequence).toList();
    expect(held, List.generate(700, (i) => i + 301));
    expect(c.hasOlder('lead'), isTrue);

    // Moved on to the rows on screen, the next poll cuts to the cap.
    c.keepFrom('lead', c.messages('lead').firstWhere((m) => m.sequence == 990));
    await pollThrough(server, c, 50);
    expect(
      c.messages('lead').map((m) => m.sequence),
      List.generate(500, (i) => i + 551),
    );
  });

  group('a conversation left', () {
    late DateTime now;
    late ConversationServer server;
    setUp(() {
      now = DateTime.utc(2026, 10, 29, 9);
      server = ConversationServer();
      for (var i = 1; i <= 150; i++) {
        server.append('lead $i');
      }
      server.append('result', conversationId: 'offline');
    });

    Future<T> at<T>(Future<T> Function() body) =>
        withClock(Clock(() => now), body);

    test(
      '15 minutes is dropped at the next read and reads its latest page '
      'when opened again',
      () => at(() async {
        final c = server.controller();
        await c.refresh();
        await c.loadMessages('lead');
        await c.loadMessages('lead', older: true);
        expect(c.messages('lead'), hasLength(150));
        // Read to its end, as the view marks it there.
        c.markRead('lead');
        await c.select('offline');

        now = now.add(const Duration(minutes: 14));
        await c.refresh();
        expect(c.messages('lead'), hasLength(150), reason: 'not yet 15');

        now = now.add(const Duration(minutes: 1));
        await c.refresh();
        expect(c.messages('lead'), isEmpty);
        expect(c.hasOlder('lead'), isFalse);

        final reads = <String>[];
        server.onRead = reads.add;
        await c.select('lead');
        await c.loadMessages('lead');

        expect(reads.first, endsWith('/conversations/lead/messages'));
        expect(
          c.messages('lead').map((m) => m.sequence),
          List.generate(100, (i) => i + 51),
        );
        expect(c.hasOlder('lead'), isTrue);
      }),
    );

    test(
      'with unread messages held keeps them, so its count stays',
      () => at(() async {
        // The two newest are the Lead's, past the reader's read mark.
        for (final m in server.messages.where((m) => m['sequence'] >= 149)) {
          m['author'] = {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'};
        }
        final c = server.controller();
        await c.refresh();
        await c.loadMessages('lead');
        c.markRead('lead', through: 148);
        await c.select('offline');

        now = now.add(const Duration(hours: 1));
        await c.refresh();

        expect(c.unreadCount(c.snapshot!.conversation('lead')!), 2);
        expect(c.messages('lead'), hasLength(100));
      }),
    );

    test(
      'being read when its time is up keeps where earlier history continues',
      () => at(() async {
        final c = server.controller();
        await c.refresh();
        await c.loadMessages('lead');
        await c.loadMessages('lead', older: true);
        c.markRead('lead');
        await c.select('offline');
        server
          ..append('lead 151')
          ..append('lead 152');
        final hold = server.holdReads = Completer<void>();
        final reading = c.loadMessages('lead');
        server.holdReads = null;

        now = now.add(const Duration(minutes: 16));
        await c.refresh();
        hold.complete();
        await reading;

        expect(c.messages('lead'), hasLength(152));
      }),
    );

    test(
      'open is never dropped, however long it is open',
      () => at(() async {
        final c = server.controller();
        await c.refresh();
        await c.loadMessages('lead');
        await c.loadMessages('lead', older: true);
        c.markRead('lead');
        await c.select('offline');
        await c.select('lead');

        now = now.add(const Duration(hours: 3));
        await c.refresh();

        // All 150 still: dropped, the read would bring the latest 100.
        expect(c.messages('lead'), hasLength(150));
      }),
    );

    test(
      'opened again within 15 minutes starts its time over',
      () => at(() async {
        final c = server.controller();
        await c.refresh();
        await c.loadMessages('lead');
        await c.select('offline');
        now = now.add(const Duration(minutes: 10));
        await c.select('lead');
        await c.select('offline');

        now = now.add(const Duration(minutes: 10));
        await c.refresh();

        expect(c.messages('lead'), hasLength(100));
      }),
    );
  });
}
