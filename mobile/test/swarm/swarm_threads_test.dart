import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_asks.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_threads.dart';

import 'swarm_fixture.dart';

/// The threads the reader follows in one Swarm (backend
/// read/followedThreads.ts, #2434): the Threads row and page, read as the
/// desktop's `SuperTabAttention` reads them.
void main() {
  const path = '/api/super-tabs/$tab';
  const threadsRoute = '$path/threads';

  Map<String, dynamic> row(
    String chat,
    String root, {
    int last = 3,
    int unread = 0,
    int? replies = 2,
    bool? follow,
    String text = 'Can we retry the refresh?',
    String at = '2026-11-01T01:00:00.000Z',
  }) => {
    'conversationId': chat,
    'rootId': root,
    'root': {
      'id': root,
      'sequence': 1,
      'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      'text': text,
      'createdAt': '2026-11-01T00:00:00.000Z',
    },
    'lastReplyAt': at,
    'lastReplySequence': last,
    'unreadReplies': unread,
    'replies': ?replies,
    'follow': follow,
  };

  Map<String, dynamic> reply(
    String chat,
    String id,
    int sequence,
    String root,
  ) => {
    'id': id,
    'conversationId': chat,
    'text': 'reply $id',
    'sequence': sequence,
    'thread': root,
    'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
    'createdAt': '2026-11-01T01:00:00.000Z',
  };

  Map<String, dynamic> mention(
    String id, {
    String chat = 'g1',
    String? thread,
    int? sequence,
  }) => {
    'id': id,
    'projectId': project,
    'projectName': 'Mobile',
    'conversationId': chat,
    'conversationTitle': 'Fix login',
    'messageId': 'msg-$id',
    'leadName': 'River',
    'text': 'Look',
    'createdAt': '2026-11-01T01:00:00.000Z',
    'threadId': ?thread,
    'messageSequence': ?sequence,
  };

  /// A Swarm listing chats g1 and g2 (g2 muted), its read marks and asks, and
  /// its followed threads; [clock] is what the threads' gaps are measured by.
  ({
    FakeSwarm swarm,
    SwarmReader reader,
    SwarmThreads threads,
    SwarmReadMarks marks,
    List<({String path, Object? sequence})> sent,
    void Function(Duration) tick,
    void Function(int lastChangedAt) move,
  })
  rig({
    Map<String, dynamic> threadMarks = const {},
    List<Map<String, dynamic>> mentions = const [],
  }) {
    final swarm = FakeSwarm();
    var now = DateTime(2026, 11, 1, 9);
    final derived = {
      'readMarks': {'g1': 1, 'g2': 1},
      'threadMarks': threadMarks,
      'chatSettings': {'g2': 'muted'},
      'mentionsWaiting': mentions.length,
    };
    swarm.routes['$path/parts'] = (_) => firstLoad(
      groups: [
        groupData('g1', title: 'Fix login', lastMessageSequence: 9),
        groupData('g2', title: 'API', lastMessageSequence: 9),
      ],
      derived: derived,
    );
    swarm.routes['$path/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    swarm.routes['$path/mentions'] = (_) => {'mentions': mentions};
    swarm.routes['$path/decisions'] = (_) => {'decisions': <Object>[]};
    final sent = <({String path, Object? sequence})>[];
    swarm.routes['$path/conversations/'] = (body) {
      sent.add((path: swarm.calls.last.path, sequence: body?['sequence']));
      return {'ok': true};
    };
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = SwarmReadMarks(reader, store: null);
    reader.readMarks = marks;
    final asks = SwarmAsks(reader);
    final threads = SwarmThreads(reader, asks: asks, now: () => now);
    addTearDown(() {
      threads.dispose();
      asks.dispose();
      marks.dispose();
      reader.dispose();
    });
    return (
      swarm: swarm,
      reader: reader,
      threads: threads,
      marks: marks,
      sent: sent,
      tick: (d) => now = now.add(d),
      move: (at) =>
          swarm.routes['$path/changes'] = (_) =>
              changes(cursor: 'c$at', derived: derived, lastChangedAt: at),
    );
  }

  int threadReads(FakeSwarm swarm) =>
      swarm.paths.where((p) => p == threadsRoute).length;

  /// [r]'s threads shown, as the Threads row or page would: read once.
  Future<void> show(SwarmThreads threads) async {
    threads.addListener(() {});
    await settle();
  }

  test('lists followed threads, new first, and never a chat the Swarm does '
      'not list for the reader', () async {
    final r = rig();
    r.swarm.routes[threadsRoute] = (_) => {
      'unread': [
        row('g1', 'm1', unread: 2, at: '2026-11-01T02:00:00.000Z'),
        // Another project's chat, or someone's private Buddy chat.
        row('buddy-other', 'b1', unread: 1, text: 'private plan'),
      ],
      'read': [
        row('g2', 'm5', follow: true, at: '2026-11-01T03:00:00.000Z'),
        row('elsewhere', 'e1', text: 'secret title'),
      ],
      'more': false,
    };
    await r.reader.refresh();

    await show(r.threads);

    expect([for (final t in r.threads.shown) t.key], ['g1/m1', 'g2/m5']);
    expect(r.threads.threadsUnread, isTrue);
    expect(
      r.threads.shown.map((t) => t.rootText),
      isNot(contains(anyOf('private plan', 'secret title'))),
    );
    expect(r.threads.loaded, isTrue);
    expect(r.threads.followSupported, isTrue);
  });

  test('reads only while something shows it', () async {
    final r = rig();
    r.swarm.routes[threadsRoute] = (_) => {'unread': [], 'read': []};
    await r.reader.refresh();
    r.move(200);
    await r.reader.refresh();
    await settle();

    expect(threadReads(r.swarm), 0);

    await show(r.threads);
    expect(threadReads(r.swarm), 1);
  });

  test('a server before followed threads (404) lists the inbox\'s unread '
      'threads and offers no Follow; the next visit asks again', () async {
    final r = rig();
    r.swarm.routes['$path/inbox'] = (_) => {
      'threads': [row('g1', 'm1', unread: 1, replies: null)],
    };
    await r.reader.refresh();

    await show(r.threads);

    expect(r.swarm.paths, contains('$path/inbox'));
    expect([for (final t in r.threads.shown) t.key], ['g1/m1']);
    expect(r.threads.followSupported, isFalse);
    expect(await r.threads.setFollow(r.threads.shown.single, false), isFalse);
    expect(r.swarm.paths.where((p) => p.endsWith('/follow')), isEmpty);

    // Updated since: the page opened again finds Follow.
    r.swarm.routes[threadsRoute] = (_) => {
      'unread': [row('g1', 'm1', unread: 1)],
      'read': [],
    };
    r.threads.opened();
    await settle();
    expect(r.threads.followSupported, isTrue);
    r.threads.closed();
  });

  test('a failed first read says so, never Loading, and a later read '
      'recovers with Follow', () async {
    final r = rig();
    var fail = true;
    r.swarm.routes[threadsRoute] = (_) => fail
        ? throw const SuperTabFailure('BUSY', 'Busy', statusCode: 500)
        : {
            'unread': [row('g1', 'm1', unread: 1)],
            'read': [],
          };
    // A busy server is not one before followed threads.
    r.swarm.routes['$path/inbox'] = (_) => {'threads': <Object>[]};
    await r.reader.refresh();

    await show(r.threads);
    expect(r.threads.loaded, isFalse);
    expect(r.threads.error, isNotNull);

    fail = false;
    await r.threads.load();

    expect(r.threads.error, isNull);
    expect(r.threads.loaded, isTrue);
    expect(r.threads.followSupported, isTrue);
    expect(r.threads.threadsUnread, isTrue);
  });

  test('asked too often (429), it waits before reading again', () async {
    final r = rig();
    var busy = true;
    r.swarm.routes[threadsRoute] = (_) => busy
        ? throw const SuperTabFailure('BUSY', 'Slow down', statusCode: 429)
        : {'unread': [], 'read': []};
    await r.reader.refresh();
    r.threads
      ..addListener(() {})
      ..opened();
    await settle();
    expect(threadReads(r.swarm), 1);
    expect(r.threads.error, isNotNull);

    busy = false;
    // Past the open page's gap, inside the wait.
    r.tick(SwarmThreads.openGap + const Duration(seconds: 1));
    r.move(200);
    await r.reader.refresh();
    await settle();
    expect(threadReads(r.swarm), 1, reason: 'inside the wait');

    r.tick(SwarmThreads.busyWait);
    r.move(300);
    await r.reader.refresh();
    await settle();
    expect(threadReads(r.swarm), 2, reason: 'the wait is over');
    expect(r.threads.error, isNull);
    r.threads.closed();
  });

  group('the page', () {
    test('opening shows a new thread\'s newest replies and marks it read '
        'through its last reply, once', () async {
      final r = rig(
        threadMarks: {
          'g1': {'m1': 2},
        },
      );
      r.swarm.routes[threadsRoute] = (_) => {
        'unread': [row('g1', 'm1', last: 9, unread: 7)],
        'read': [],
      };
      r.swarm.routes['$path/conversations/g1/messages?thread=m1'] = (_) => {
        'messages': [for (var s = 9; s >= 2; s--) reply('g1', 'r$s', s, 'm1')],
      };
      await r.reader.refresh();
      await settle();
      r.threads.opened();
      await settle();
      final thread = r.threads.shown.single;

      await r.threads.showReplies(thread);
      await r.threads.showReplies(thread);
      await settle();

      expect(
        [for (final m in r.threads.newReplies[thread.key]!) m.id],
        ['r5', 'r6', 'r7', 'r8', 'r9'],
      );
      expect(r.sent, [
        (path: '$path/conversations/g1/threads/m1/read', sequence: 9),
      ]);
      expect(r.marks.threadThrough('g1', 'm1'), 9);
      expect(r.threads.newCount(thread), 7, reason: 'what it had this visit');
      r.threads.closed();
    });

    test('unfollow is kept on the server, and a new reply then lists and '
        'marks nothing', () async {
      final r = rig();
      var followed = true;
      r.swarm.routes[threadsRoute] = (_) => {
        'unread': <Object>[],
        'read': [if (followed) row('g1', 'm1', follow: true)],
      };
      r.swarm.routes['$path/conversations/g1/threads/m1/follow'] = (body) {
        followed = body!['follow'] as bool;
        return {'ok': true};
      };
      await r.reader.refresh();
      r.threads.opened();
      await settle();

      expect(await r.threads.setFollow(r.threads.shown.single, false), isTrue);
      await settle();
      expect(r.swarm.calls.last.path, threadsRoute, reason: 'read again');
      expect(r.swarm.calls.firstWhere((c) => c.path.endsWith('/follow')).body, {
        'follow': false,
      });
      expect(r.threads.shown, isEmpty);

      // A new reply in it: the server lists it nowhere for this reader.
      r.tick(SwarmThreads.quietGap);
      r.move(200);
      await r.reader.refresh();
      await settle();

      expect(r.threads.shown, isEmpty);
      expect(r.threads.threadsUnread, isFalse);
      expect(r.sent, isEmpty);
      r.threads.closed();
    });

    test('replies read for a visit that is over mark nothing, the page '
        'opened again or not', () async {
      final r = rig();
      r.swarm.routes[threadsRoute] = (_) => {
        'unread': [row('g1', 'm1', last: 4, unread: 1)],
        'read': [],
      };
      final answers = <Completer<Object?>>[];
      r.swarm.routes['$path/conversations/g1/messages?thread=m1'] = (_) =>
          (answers..add(Completer())).last.future;
      await r.reader.refresh();
      r.threads.opened();
      await settle();
      final thread = r.threads.shown.single;

      final first = r.threads.showReplies(thread);
      r.threads.closed();
      r.threads.opened();
      await settle();
      final second = r.threads.showReplies(thread);
      await settle();
      answers.first.complete({
        'messages': [reply('g1', 'r4', 4, 'm1')],
      });
      await first;
      await settle();

      expect(r.sent, isEmpty, reason: 'the first visit is over');
      expect(r.threads.newReplies, isEmpty);

      r.threads.closed();
      answers.last.complete({
        'messages': [reply('g1', 'r4', 4, 'm1')],
      });
      await second;
      await settle();
      expect(r.sent, isEmpty, reason: 'closed');
    });
  });

  group('access', () {
    test('lost while the page is open: rows, replies and pending answers go, '
        'and nothing is marked', () async {
      final r = rig();
      r.swarm.routes[threadsRoute] = (_) => {
        'unread': [
          row('g1', 'm1', last: 4, unread: 1),
          row('g1', 'm2', last: 5, unread: 1),
        ],
        'read': [],
      };
      r.swarm.routes['$path/conversations/g1/messages?thread=m1'] = (_) => {
        'messages': [reply('g1', 'r4', 4, 'm1')],
      };
      final replies = Completer<Object?>();
      r.swarm.routes['$path/conversations/g1/messages?thread=m2'] = (_) =>
          replies.future;
      await r.reader.refresh();
      r.threads.opened();
      await settle();
      await r.threads.showReplies(r.threads.shown.first);
      await settle();
      final second = r.threads.shown.firstWhere((t) => t.rootId == 'm2');
      final reading = r.threads.showReplies(second);
      final list = Completer<Object?>();
      r.swarm.routes[threadsRoute] = (_) => list.future;
      final relist = r.threads.load();
      final sentBefore = r.sent.length;

      r.reader.revoke();
      replies.complete({
        'messages': [reply('g1', 'r5', 5, 'm2')],
      });
      list.complete({
        'unread': [row('g1', 'm1', unread: 1)],
        'read': [],
      });
      await reading;
      await relist;
      await settle();

      expect(r.threads.shown, isEmpty);
      expect(r.threads.newReplies, isEmpty);
      expect(r.threads.loaded, isFalse);
      expect(r.threads.threadMentions, 0);
      expect(r.sent.length, sentBefore, reason: 'no mark after access went');
      expect(await r.threads.setFollow(second, false), isFalse);
    });

    test(
      'an answer asked before who may read what changed is not shown',
      () async {
        final r = rig();
        final list = Completer<Object?>();
        r.swarm.routes[threadsRoute] = (_) => list.future;
        await r.reader.refresh();
        r.threads.addListener(() {});
        await settle();

        r.reader.generation++;
        list.complete({
          'unread': [row('g1', 'm1', unread: 1)],
          'read': [],
        });
        await settle();

        expect(r.threads.shown, isEmpty);
        expect(r.threads.loaded, isFalse);
      },
    );
  });

  group('the Threads row\'s number', () {
    test('counts tags in threads not read past, never in a muted chat, the '
        'main stream or a chat the Swarm does not list', () async {
      final r = rig(
        threadMarks: {
          'g1': {'m9': 6},
        },
        mentions: [
          mention('t1', thread: 'm1', sequence: 4),
          mention('t2', thread: 'm9', sequence: 5), // read past
          mention('t3', chat: 'g2', thread: 'm3', sequence: 7), // muted
          mention('t4', sequence: 8), // main stream
          mention('t5', chat: 'private', thread: 'p1', sequence: 9),
        ],
      );
      r.swarm.routes[threadsRoute] = (_) => {'unread': [], 'read': []};
      await r.reader.refresh();
      await settle();

      expect(r.threads.threadMentions, 1);

      r.marks.markThreadRead('g1', 'm1', 4);
      expect(r.threads.threadMentions, 0);
    });
  });
}
