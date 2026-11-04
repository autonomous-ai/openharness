import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';

import 'support/super_tab_fixture.dart';

/// Task #2911: a jump reads the window around its time in one request, the
/// chat reads pages both ways only as asked, and the rows held stay near 300.
void main() {
  final now = DateTime.now();
  final weekAgo = DateTime(now.year, now.month, now.day - 7);

  /// The Lead chat with [count] messages over two weeks to now, everything
  /// read, its latest page held; [reads] collects each messages read after.
  Future<(SuperTabController, ConversationServer, List<String>)> chat({
    int count = 2000,
  }) async {
    final server = ConversationServer();
    final start = now.subtract(const Duration(days: 14));
    final step = const Duration(days: 14).inSeconds ~/ count;
    for (var i = 1; i <= count; i++) {
      server.append('Update $i');
      server.messages.last['createdAt'] = start
          .add(Duration(seconds: step * i))
          .toUtc()
          .toIso8601String();
    }
    server.markReadElsewhere('lead', count);
    final c = server.controller();
    await c.refresh();
    await c.loadMessages('lead');
    final reads = <String>[];
    server.onRead = reads.add;
    addTearDown(c.dispose);
    return (c, server, reads);
  }

  String firstFrom(ConversationServer server, DateTime from) =>
      server.messages.firstWhere(
            (m) => !DateTime.parse(m['createdAt'] as String).isBefore(from),
          )['id']
          as String;

  test(
    'a jump a week back is one read, and holds the rows around it',
    () async {
      final (c, server, reads) = await chat();
      final target = await c.jumpTo('lead', weekAgo);
      expect(reads, hasLength(1));
      expect(reads.single, contains('at=${weekAgo.millisecondsSinceEpoch}'));
      expect(target, firstFrom(server, weekAgo));
      final held = c.messages('lead');
      expect(held, hasLength(200));
      expect(held.indexWhere((m) => m.id == target), 100);
      expect(c.hasOlder('lead'), isTrue);
      expect(c.hasNewer('lead'), isTrue);
    },
  );

  test('the very beginning lands on the first message, one read', () async {
    final (c, server, reads) = await chat();
    final target = await c.jumpTo('lead', null);
    expect(reads.single, contains('at=0'));
    expect(target, server.messages.first['id']);
    expect(c.hasOlder('lead'), isFalse);
  });

  test('scrolling down reads one newer page a time, to the live end', () async {
    final (c, server, reads) = await chat();
    await c.jumpTo('lead', weekAgo);
    reads.clear();
    await c.loadNewer('lead');
    expect(reads, hasLength(1));
    expect(reads.single, contains('after='));
    expect(c.messages('lead').length, lessThanOrEqualTo(300));
    var pages = 1;
    while (c.hasNewer('lead') && pages < 30) {
      await c.loadNewer('lead');
      pages++;
      expect(c.messages('lead').length, lessThanOrEqualTo(300));
    }
    expect(c.hasNewer('lead'), isFalse);
    expect(c.messages('lead').last.id, server.messages.last['id']);
    // The rows dropped above are read again by scrolling up.
    expect(c.hasOlder('lead'), isTrue);
    expect(reads, hasLength(pages));
  });

  test(
    'scrolling up past 300 rows drops the newest, which wait below',
    () async {
      final (c, _, _) = await chat();
      final target = await c.jumpTo('lead', weekAgo);
      for (var page = 0; page < 4; page++) {
        await c.loadMessages('lead', older: true);
        expect(c.messages('lead').length, lessThanOrEqualTo(300));
      }
      expect(c.messages('lead').any((m) => m.id == target), isFalse);
      expect(c.hasNewer('lead'), isTrue);
      expect(c.hasOlder('lead'), isTrue);
    },
  );

  test('Jump to latest after a jump is one read, at the live end', () async {
    final (c, server, reads) = await chat();
    await c.jumpTo('lead', weekAgo);
    reads.clear();
    await c.showLatest('lead');
    expect(reads, hasLength(1));
    expect(c.messages('lead').last.id, server.messages.last['id']);
    expect(c.hasNewer('lead'), isFalse);
  });
}
