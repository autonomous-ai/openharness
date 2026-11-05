import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/threads_page.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm, unreadThread;
import 'support/super_tab_fixture.dart';

// Task #2996 (anh Dee, 11-05): Threads is Slack's Threads view, one scrolling page of cards, newest activity first. A card
// shows its project and subject, who is in it, the root in full, Show N more replies, the last two replies under a New
// line, and a reply box with Also send.
final _now = DateTime(2026, 11, 5, 9, 30);

Finder _key(String key) => find.byKey(ValueKey(key));

Map<String, String> _author(String who) => switch (who) {
  'Kestrel' => {
    'kind': 'agent',
    'id': 'kestrel',
    'name': 'Builder',
    'displayName': 'Kestrel',
  },
  _ => {'kind': 'person', 'id': who.toLowerCase(), 'name': who},
};

/// A thread in [conversationId]: its root by [by], then [replies] (who, what),
/// as the backend keeps them. Returns the root's id.
String _thread(
  ConversationServer server,
  String root, {
  String conversationId = 'lead',
  String by = 'Darren',
  List<(String, String)> replies = const [],
}) {
  server.append(root, conversationId: conversationId);
  final id = server.messages.last['id'] as String;
  server.messages.last['author'] = _author(by);
  for (final (who, text) in replies) {
    server.append(text, conversationId: conversationId);
    server.messages.last
      ..['thread'] = id
      ..['author'] = _author(who);
  }
  return id;
}

/// The followed row the server lists for [root], its newest reply at [at].
Map<String, dynamic> _followed(
  ConversationServer server,
  String root, {
  String conversationId = 'lead',
  int unread = 0,
  DateTime? at,
}) {
  final thread = server.messages.where((m) => m['thread'] == root).toList();
  return unreadThread(root)
    ..['conversationId'] = conversationId
    ..['root'] = {
      ...(unreadThread(root)['root'] as Map),
      'author': thread.first['author'],
      'text': thread.first['text'],
    }
    ..['replies'] = thread.length - 1
    ..['unreadReplies'] = unread
    ..['lastReplySequence'] = thread.last['sequence']
    ..['lastReplyAt'] = (at ?? _now).toUtc().toIso8601String();
}

/// A thread the reader read, with no messages the server holds: its card
/// draws the preview the list carries.
Map<String, dynamic> _readOnly(String root, DateTime at) =>
    unreadThread(root, text: 'Read root $root')
      ..['unreadReplies'] = 0
      ..['replies'] = 1
      ..['lastReplyAt'] = at.toUtc().toIso8601String();

Future<SuperTabActivity> _loaded(
  WidgetTester tester,
  ConversationServer server,
) async => (await tester.runAsync(() => load(server)))!;

/// Lets the server's answers arrive, then draws them.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pumpAndSettle();
  }
}

Future<List<(String, String)>> _show(
  WidgetTester tester,
  SuperTabActivity activity, {
  double height = 1400,
}) async {
  await tester.binding.setSurfaceSize(Size(900, height));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final opened = <(String, String)>[];
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SuperTabThreadsPage(
          activity: activity,
          onOpenThread: (conversation, root) =>
              opened.add((conversation, root)),
          message: (m) => Text(m.text),
          now: () => _now,
        ),
      ),
    ),
  );
  await _settle(tester);
  return opened;
}

double _top(WidgetTester tester, Finder f) => tester.getTopLeft(f).dy;

/// The thread reads made for [root] so far.
int _threadReads(List<String> reads, String root) =>
    reads.where((p) => p.contains('thread=$root')).length;

void main() {
  testWidgets('cards list unread threads first, newest activity first, then '
      'the read ones', (tester) async {
    final server = swarm();
    final older = _thread(server, 'Older unread', replies: [('Kestrel', 'a')]);
    final newer = _thread(server, 'Newer unread', replies: [('Kestrel', 'b')]);
    server.followedThreads = {
      'unread': [
        _followed(
          server,
          older,
          unread: 1,
          at: _now.subtract(const Duration(hours: 2)),
        ),
        _followed(
          server,
          newer,
          unread: 1,
          at: _now.subtract(const Duration(hours: 1)),
        ),
      ],
      'read': [_readOnly('read-1', _now.subtract(const Duration(minutes: 5)))],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      final a = _key('super-thread-card:lead/$newer');
      final b = _key('super-thread-card:lead/$older');
      final c = _key('super-thread-card:offline/read-1');
      for (final f in [a, b, c]) {
        expect(f, findsOneWidget);
      }
      expect(_top(tester, a), lessThan(_top(tester, b)));
      expect(_top(tester, b), lessThan(_top(tester, c)));
      // A thread the server holds no messages of shows the root it listed.
      expect(find.text('Read root read-1'), findsOneWidget);
    });
  });

  testWidgets('a card shows its project and subject, who is in it, the root in '
      'full, Show 4 more replies and the last two replies under a New line', (
    tester,
  ) async {
    final server = swarm();
    const root =
        'Proposal words check: three tightenings\n\nProposals feel like bots. '
        'Post the owner\'s own words, or the one line they okayed, and never '
        'a fragment of something else they said.';
    final id = _thread(
      server,
      root,
      replies: [
        for (var i = 1; i <= 4; i++) ('Kestrel', 'Earlier reply $i'),
        ('Larch', 'Ready to merge, both reviews Yes'),
        ('Kestrel', 'Merged, ships in the next release'),
      ],
    );
    server.followedThreads = {
      'unread': [_followed(server, id, unread: 2)],
      'read': [],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      final card = _key('super-thread-card:lead/$id');
      Finder inCard(Finder f) => find.descendant(of: card, matching: f);
      expect(
        inCard(find.text('# web-project · Proposal words check')),
        findsOneWidget,
      );
      expect(inCard(find.text('Darren, Kestrel and Larch')), findsOneWidget);
      expect(inCard(find.text(root)), findsOneWidget);
      expect(inCard(find.text('Show 4 more replies')), findsOneWidget);
      expect(inCard(find.text('Earlier reply 4')), findsNothing);
      final fifth = inCard(find.text('Ready to merge, both reviews Yes'));
      final sixth = inCard(find.text('Merged, ships in the next release'));
      expect(fifth, findsOneWidget);
      expect(sixth, findsOneWidget);
      final line = _key('super-thread-card-new:lead/$id');
      expect(line, findsOneWidget);
      expect(inCard(find.text('New')), findsOneWidget);
      expect(_top(tester, inCard(find.text(root))), lessThan(_top(tester, line)));
      expect(_top(tester, line), lessThan(_top(tester, fifth)));
    });
  });

  testWidgets('the title and Show more open the thread beside its chat', (
    tester,
  ) async {
    final server = swarm();
    final id = _thread(
      server,
      'Law firm list A',
      replies: [for (var i = 0; i < 3; i++) ('Kestrel', 'Reply $i')],
    );
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id)],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      final opened = await _show(tester, await _loaded(tester, server));
      await tester.tap(_key('super-thread-card-title:lead/$id'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Show 1 more reply'));
      await tester.pumpAndSettle();
      expect(opened, [('lead', id), ('lead', id)]);
      // A read thread has no New line.
      expect(_key('super-thread-card-new:lead/$id'), findsNothing);
    });
  });

  testWidgets('a reply from a card goes to its own thread, with Also send to '
      '#web-project, while another thread is open beside the chat', (
    tester,
  ) async {
    final server = swarm();
    final id = _thread(server, 'Card thread', replies: [('Kestrel', 'One')]);
    final other = _thread(
      server,
      'Open elsewhere',
      conversationId: 'offline',
      replies: [('Kestrel', 'Two')],
    );
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id)],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      final activity = await _loaded(tester, server);
      final c = activity.controller
        ..select('offline')
        ..openThread(other);
      await _show(tester, activity);
      final key = 'lead/$id';
      expect(find.text('Also send to #web-project'), findsOneWidget);
      await tester.enterText(
        _key('super-thread-card-field:$key'),
        'From the card',
      );
      await tester.tap(_key('super-thread-card-also:$key'));
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(_key('super-thread-card-send:$key'));
        await Future<void>.delayed(const Duration(milliseconds: 80));
      });
      await _settle(tester);
      final sent = server.messages.last;
      expect(sent['text'], 'From the card');
      expect(sent['conversationId'], 'lead');
      expect(sent['replyTo'], id);
      expect(sent['thread'], id);
      expect(sent['alsoInChat'], true);
      // The box is free for the next one; the open thread stays open.
      expect(
        tester
            .widget<TextField>(
              find.descendant(
                of: _key('super-thread-card-field:$key'),
                matching: find.byType(TextField),
              ),
            )
            .controller!
            .text,
        isEmpty,
      );
      expect(c.openedThread?.root, other);
    });
  });

  testWidgets('a thread in a chat that is no project chat also sends to the '
      'main chat', (tester) async {
    final server = swarm();
    final id = _thread(
      server,
      'Task thread',
      conversationId: 'offline',
      replies: [('Kestrel', 'One')],
    );
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id, conversationId: 'offline')],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      expect(find.text('Also send to the main chat'), findsOneWidget);
    });
  });

  testWidgets('a card shown marks its thread read, and its New line stays '
      'for the visit', (tester) async {
    final server = swarm();
    final id = _thread(
      server,
      'Unread thread',
      replies: [('Kestrel', 'One'), ('Larch', 'Two')],
    );
    final row = _followed(server, id, unread: 2);
    server.followedThreads = {
      'unread': [row],
      'read': [],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      expect(
        server.threadMarkPosts.where((p) => p['root'] == id),
        contains(
          allOf(
            containsPair('conversationId', 'lead'),
            containsPair('sequence', row['lastReplySequence']),
          ),
        ),
      );
      expect(_key('super-thread-card-new:lead/$id'), findsOneWidget);
    });
  });

  testWidgets('a failed thread read says so, and Retry reads it again', (
    tester,
  ) async {
    final server = swarm();
    final id = _thread(server, 'Flaky thread', replies: [('Kestrel', 'One')]);
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id)],
      'more': false,
    };
    var fail = true;
    server.onRead = (path) {
      if (fail && path.contains('thread=$id')) {
        throw StateError('Offline');
      }
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      final card = _key('super-thread-card:lead/$id');
      expect(
        find.descendant(
          of: card,
          matching: find.text('Could not load this thread.'),
        ),
        findsOneWidget,
      );
      fail = false;
      await tester.tap(_key('super-thread-card-retry:lead/$id'));
      await _settle(tester);
      expect(find.text('Could not load this thread.'), findsNothing);
      expect(find.text('One'), findsOneWidget);
    });
  });

  testWidgets('a card reads its thread once while nothing moves, and again '
      'when a reply comes', (tester) async {
    final server = swarm();
    final id = _thread(server, 'Quiet thread', replies: [('Kestrel', 'One')]);
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id)],
      'more': false,
    };
    final reads = <String>[];
    server.onRead = reads.add;
    await withClock(Clock.fixed(_now), () async {
      final activity = await _loaded(tester, server);
      await _show(tester, activity);
      expect(_threadReads(reads, id), 1);
      await tester.runAsync(activity.attention.load);
      await _settle(tester);
      expect(_threadReads(reads, id), 1);
      // A new reply moves the thread's newest reply: the card reads again.
      server.append('Two', conversationId: 'lead');
      server.messages.last
        ..['thread'] = id
        ..['author'] = _author('Larch');
      server.followedThreads = {
        'unread': [_followed(server, id, unread: 1)],
        'read': [],
        'more': false,
      };
      await tester.runAsync(activity.attention.load);
      await _settle(tester);
      expect(_threadReads(reads, id), 2);
      expect(find.text('Two'), findsOneWidget);
    });
  });

  testWidgets('a thread can be unfollowed from its card', (tester) async {
    final server = swarm();
    final id = _thread(server, 'Followed', replies: [('Kestrel', 'One')]);
    server.followedThreads = {
      'unread': [],
      'read': [_followed(server, id)],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      await tester.runAsync(() async {
        await tester.tap(_key('super-thread-card-unfollow:lead/$id'));
        await Future<void>.delayed(const Duration(milliseconds: 80));
      });
      await tester.pumpAndSettle();
      expect(server.followPosts.single['follow'], false);
      expect(server.followPosts.single['root'], id);
    });
  });

  testWidgets('a thread in a chat the reader no longer has is not listed', (
    tester,
  ) async {
    final server = swarm();
    server.followedThreads = {
      'unread': [unreadThread('gone')..['conversationId'] = 'not-theirs'],
      'read': [],
      'more': false,
    };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      expect(_key('super-thread-card:not-theirs/gone'), findsNothing);
      expect(find.text('No threads yet'), findsOneWidget);
    });
  });

  // Ported from Activity's Threads tab (super_tab_activity_threads_all_test.dart).
  testWidgets('no thread at all says so', (tester) async {
    final server = swarm();
    server.followedThreads = {'unread': [], 'read': [], 'more': false};
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      expect(find.text('No threads yet'), findsOneWidget);
    });
  });

  testWidgets('it asks for 50 read threads, and 50 more at the end only while '
      'there are more', (tester) async {
    final server = swarm();
    final fifty = [
      for (var i = 0; i < 50; i++)
        _readOnly('read-$i', DateTime(2026, 11, 4).subtract(Duration(minutes: i))),
    ];
    server.followedThreads = {'unread': [], 'read': fifty, 'more': true};
    final list = find.descendant(
      of: _key('super-threads-list'),
      matching: find.byType(Scrollable),
    );
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server), height: 900);
      expect(
        server.threadListReads.where((p) => p.contains('/threads')).last,
        endsWith('/threads?read=50'),
      );
      expect(_key('super-threads-more'), findsNothing);
      server.followedThreads = {
        'unread': [],
        'read': [
          ...fifty,
          for (var i = 50; i < 60; i++)
            _readOnly(
              'read-$i',
              DateTime(2026, 11, 3).subtract(Duration(minutes: i)),
            ),
        ],
        'more': false,
      };
      await tester.scrollUntilVisible(
        _key('super-thread-card:offline/read-49'),
        600,
        scrollable: list,
      );
      await _settle(tester);
      expect(
        server.threadListReads.where((p) => p.contains('/threads')).last,
        endsWith('/threads?read=100'),
      );
      await tester.scrollUntilVisible(
        _key('super-thread-card:offline/read-59'),
        600,
        scrollable: list,
      );
      final reads = server.threadListReads.length;
      expect(_key('super-threads-more'), findsNothing);
      await _settle(tester);
      expect(server.threadListReads.length, reads);
    });
  });

  testWidgets('a server before paging still lists its read threads', (
    tester,
  ) async {
    final server = swarm()
      ..refuseThreadsRead = true
      ..followedThreads = {
        'unread': [],
        'read': [_readOnly('read-1', DateTime(2026, 11, 4, 16, 42))],
        'more': true,
      };
    await withClock(Clock.fixed(_now), () async {
      await _show(tester, await _loaded(tester, server));
      expect(_key('super-thread-card:offline/read-1'), findsOneWidget);
      expect(_key('super-threads-more'), findsNothing);
    });
  });

  testWidgets('only the open page asks for read pages, and closing it starts '
      'over', (tester) async {
    final server = swarm();
    server.followedThreads = {
      'unread': [],
      'read': [
        for (var i = 0; i < 50; i++)
          _readOnly(
            'read-$i',
            DateTime(2026, 11, 4).subtract(Duration(minutes: i)),
          ),
      ],
      'more': true,
    };
    String last() =>
        server.threadListReads.where((p) => p.contains('/threads')).last;
    await withClock(Clock.fixed(_now), () async {
      final activity = await _loaded(tester, server);
      expect(last(), endsWith('/threads'));
      await _show(tester, activity, height: 900);
      expect(last(), endsWith('/threads?read=50'));
      await tester.runAsync(activity.attention.readMore);
      expect(last(), endsWith('/threads?read=100'));
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      await tester.runAsync(activity.attention.load);
      expect(last(), endsWith('/threads'));
      await _show(tester, activity, height: 900);
      expect(last(), endsWith('/threads?read=50'));
    });
  });
}
