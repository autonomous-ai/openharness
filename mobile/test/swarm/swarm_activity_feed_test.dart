import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_activity.dart';
import 'package:harness_mobile/swarm/swarm_activity_feed.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// Activity read from the server, as Desktop reads it (Tony, task 8a;
/// #2453): replies and reactions listed by `/activity`, read on every device
/// through `/activity/read` once Activity is left, the badge counted as
/// Desktop counts it, and a server before Activity kept on the phone's own
/// rows.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SwarmSession> start(
    FakeSwarm fake, {
    MemoryKeyValueStore? store,
    bool dispose = true,
  }) async {
    final session = SwarmSession(
      accountId: me,
      request: fake.request,
      notices: SilentSystemNotices(),
      readMarks: store ?? MemoryKeyValueStore(),
    );
    if (dispose) addTearDown(session.dispose);
    // Made before the first read, as the Activity tab's badge makes it.
    session.activity;
    await session.inbox.refresh();
    await settle();
    return session;
  }

  /// A server with Activity, whose `/activity` answers [rows] as they stand.
  FakeSwarm server(
    List<Map<String, dynamic>> Function() rows, {
    String Function()? digest,
  }) {
    final fake = activityBackend(
      page: activityPage,
      activityDigest: digest ?? () => 'digest-1',
    );
    fake.routes[activityPath] = (_) => {'items': rows(), 'more': false};
    fake.routes['$activityPath/read'] = (_) => {'marked': 1};
    return fake;
  }

  List<String> keys(SwarmActivity activity, SwarmActivityFilter filter) => [
    for (final item in activity.items(filter)) item.key,
  ];

  int lists(FakeSwarm fake) => fake.calls
      .where((c) => c.method == 'GET' && c.path == activityPath)
      .length;

  List<Map<String, dynamic>?> marks(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' && call.path == '$activityPath/read') call.body,
  ];

  /// The Swarm changes on its next read (one more decision waits), its
  /// Activity digest as [digest] says: what the phone holds moves either way.
  var round = 0;
  Future<void> swarmMoves(
    SwarmSession session,
    FakeSwarm fake,
    String Function() digest,
  ) async {
    round++;
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
      cursor: 'c${round + 2}',
      derived: {
        'decisionsWaiting': 1 + round,
        'mentionsWaiting': 1,
        'activityDigest': digest(),
      },
      lastChangedAt: 1 + round,
    );
    await session.inbox.reader(tab)!.refresh();
    await settle();
  }

  int chatReads(FakeSwarm fake) =>
      fake.paths.where((p) => p.startsWith(activityChatPath)).length;

  group('the server list', () {
    test('Replies and Reactions are the server rows, newest first, and no '
        'project chat is read for them', () async {
      final fake = server(
        () => [
          activityRow('r2', minute: 9, text: 'Merged it'),
          activityRow('x1', kind: 'reaction', emoji: 'check', minute: 8),
          activityRow('r1', minute: 3, read: true),
        ],
      );
      final session = await start(fake);
      final activity = session.activity..watch();
      addTearDown(activity.unwatch);
      await settle();

      expect(keys(activity, SwarmActivityFilter.threads), [
        'activity:$tab:r2',
        'activity:$tab:r1',
      ]);
      expect(keys(activity, SwarmActivityFilter.reactions), [
        'activity:$tab:x1',
      ]);
      expect(activity.label(SwarmActivityFilter.threads), 'Replies');
      expect(activity.count(SwarmActivityFilter.threads), 1);
      expect(activity.count(SwarmActivityFilter.reactions), 1);
      expect(chatReads(fake), 0, reason: 'the server lists them');
      final reply = activity.items(SwarmActivityFilter.threads).first;
      expect(activity.unread(reply), isTrue);
      expect(activity.handled(reply), isNull, reason: 'no phone-only mark');
    });

    test('a reply in a thread opens at its thread', () async {
      final fake = server(
        () => [activityRow('r1', threadId: 'root-1', messageId: 'reply-1')],
      );
      final session = await start(fake);
      final item = session.activity.items(SwarmActivityFilter.threads).single;
      expect(item.conversationId, leadChat);
      expect(item.messageId, 'root-1');
    });

    test('it is read again only when its digest moves', () async {
      var digest = 'digest-1';
      final fake = server(() => [activityRow('r1')], digest: () => digest);
      final session = await start(fake);
      final listed = lists(fake);
      expect(listed, 1);

      await swarmMoves(session, fake, () => digest);
      expect(lists(fake), listed, reason: 'the same digest reads nothing');

      digest = 'digest-2';
      await swarmMoves(session, fake, () => digest);
      expect(lists(fake), listed + 1);
    });
  });

  group('the badge', () {
    test('counts decisions and tags waiting and replies unread, as Desktop; '
        'reactions and work do not count', () async {
      final fake = server(
        () => [
          activityRow('r1', minute: 4),
          activityRow('r2', minute: 3),
          activityRow('r3', minute: 2, read: true),
          activityRow('x1', kind: 'reaction', emoji: 'eyes', minute: 1),
        ],
      );
      final session = await start(fake);
      // decisionsWaiting 1 + mentionsWaiting 1 + 2 replies unread.
      expect(session.activity.badge, 4);
    });

    test('a Swarm the person can no longer read counts nothing', () async {
      final fake = server(() => [activityRow('r1')]);
      final session = await start(fake);
      expect(session.activity.badge, 3);

      session.inbox.reader(tab)!.revoke();
      await settle();
      expect(session.activity.badge, 0);
      expect(session.activity.items(SwarmActivityFilter.threads), isEmpty);
    });
  });

  group('marking read', () {
    test('leaving Activity marks the rows it had open read on every device, '
        'and the badge drops', () async {
      final fake = server(
        () => [activityRow('r2', minute: 9), activityRow('r1', minute: 3)],
      );
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();
      expect(activity.badge, 4);

      activity.showing(activity.items(SwarmActivityFilter.threads));
      final row = activity.items(SwarmActivityFilter.threads).first;
      activity.unwatch();
      expect(activity.unread(row), isTrue, reason: 'bold until it is left');
      await settle();

      expect(marks(fake), [
        {'through': DateTime.utc(2026, 11, 1, 7, 9).toIso8601String()},
      ]);
      expect(activity.count(SwarmActivityFilter.threads), 0);
      final read = activity.items(SwarmActivityFilter.threads).first;
      expect(read.key, row.key);
      expect(activity.unread(read), isFalse);
      expect(activity.badge, 2);
    });

    test(
      'rows read on another device stay bold until Activity is left',
      () async {
        var read = false;
        var digest = 'digest-1';
        final fake = server(
          () => [activityRow('r1', read: read)],
          digest: () => digest,
        );
        final session = await start(fake);
        final activity = session.activity..watch();
        addTearDown(activity.unwatch);
        await settle();
        final row = activity.items(SwarmActivityFilter.threads).single;

        read = true;
        digest = 'digest-2';
        await session.inbox.reader(tab)!.refresh();
        await settle();
        final again = activity.items(SwarmActivityFilter.threads).single;
        expect(activity.waiting(again), isFalse, reason: 'read on the server');
        expect(activity.unread(again), isTrue, reason: 'still bold here');
        expect(row.key, again.key);
      },
    );

    test('a row Activity never had open is not marked read with the others: '
        'a newer reaction behind another filter stays unread', () async {
      final fake = server(
        () => [
          activityRow('x1', kind: 'reaction', emoji: 'check', minute: 9),
          activityRow('r2', minute: 6),
          activityRow('r1', minute: 3),
        ],
      );
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      // Only Replies was open.
      activity.showing(activity.items(SwarmActivityFilter.threads));
      activity.unwatch();
      await settle();

      expect(marks(fake), [
        {'through': DateTime.utc(2026, 11, 1, 7, 6).toIso8601String()},
      ]);
      expect(activity.count(SwarmActivityFilter.reactions), 1);
    });

    test('an unread row older than those open holds them all back', () async {
      final fake = server(
        () => [
          activityRow('r2', minute: 6),
          activityRow('x1', kind: 'reaction', emoji: 'check', minute: 3),
        ],
      );
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      activity.showing(activity.items(SwarmActivityFilter.threads));
      activity.unwatch();
      await settle();

      expect(marks(fake), isEmpty, reason: 'through would take x1 with it');
      expect(activity.count(SwarmActivityFilter.threads), 1);
    });

    test('leaving with nothing open marks nothing', () async {
      final fake = server(() => [activityRow('r1')]);
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();
      activity.unwatch();
      await settle();
      expect(marks(fake), isEmpty);
    });

    test(
      'a mark the server refused is unread again at the next read',
      () async {
        final fake = server(() => [activityRow('r1')]);
        fake.routes['$activityPath/read'] = (_) =>
            throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503);
        final session = await start(fake);
        final activity = session.activity..watch();
        await settle();
        activity.showing(activity.items(SwarmActivityFilter.threads));
        activity.unwatch();
        await settle();

        expect(marks(fake), hasLength(1));
        expect(
          activity.count(SwarmActivityFilter.threads),
          1,
          reason: 'read again, it is unread as the server has it',
        );
        expect(activity.badge, 3);
      },
    );
  });

  group('a server before Activity', () {
    test(
      'answering 404, it keeps the phone-built Threads and Reactions',
      () async {
        final fake = activityBackend(
          page: activityPage,
          activityDigest: () => 'digest-1',
        );
        final session = await start(fake);
        final activity = session.activity..watch();
        addTearDown(activity.unwatch);
        await settle();

        expect(lists(fake), 1);
        expect(activity.label(SwarmActivityFilter.threads), 'Threads');
        expect(keys(activity, SwarmActivityFilter.threads), [
          'thread:$tab:root-1',
          'thread:$tab:root-old',
        ]);
        expect(keys(activity, SwarmActivityFilter.reactions), [
          'reaction:$tab:mine-2',
        ]);
        expect(activity.badge, 2, reason: 'what needs the person, as before');
      },
    );

    test('sending no digest, it is never asked', () async {
      final fake = activityBackend(page: activityPage);
      final session = await start(fake);
      final activity = session.activity..watch();
      addTearDown(activity.unwatch);
      await settle();

      expect(lists(fake), 0);
      expect(keys(activity, SwarmActivityFilter.threads), [
        'thread:$tab:root-1',
        'thread:$tab:root-old',
      ]);
    });
  });

  group('the handled marks kept on the phone', () {
    final key = 'swarm_activity.$me.$tab';

    test('go once the server lists Activity: it keeps what is read', () async {
      final store = MemoryKeyValueStore();
      await store.write(
        key,
        jsonEncode({
          'marks': {'t:root-1': 12},
        }),
      );
      final session = await start(server(() => const []), store: store);
      await session.activity.watch2();
      expect(await store.read(key), isNull);
    });

    test('stay while the server has no Activity', () async {
      final store = MemoryKeyValueStore();
      await store.write(
        key,
        jsonEncode({
          'marks': {'t:root-1': 12},
        }),
      );
      final session = await start(
        activityBackend(page: activityPage, activityDigest: () => 'digest-1'),
        store: store,
      );
      await session.activity.watch2();
      expect(await store.read(key), isNotNull);
    });
  });

  group('privacy', () {
    test(
      'rows of a chat the phone does not hold — another project, a '
      'private chat, someone else\'s Buddy chat — are left out alike',
      () async {
        final fake = server(
          () => [
            activityRow('r1', minute: 5),
            activityRow('other', conversationId: 'group-elsewhere', minute: 4),
            activityRow('buddy', conversationId: 'buddy-someone', minute: 3),
          ],
        );
        final session = await start(fake);
        expect(keys(session.activity, SwarmActivityFilter.threads), [
          'activity:$tab:r1',
        ]);
        expect(session.activity.badge, 3, reason: 'only the held row counts');
      },
    );

    test(
      'access lost while a list is on its way: the answer is dropped',
      () async {
        final answer = Completer<Object?>();
        final fake = server(() => [activityRow('r1')]);
        fake.routes[activityPath] = (_) => answer.future;
        final session = await start(fake);
        final feed = SwarmActivityFeed(session.inbox.reader(tab)!);
        addTearDown(feed.dispose);
        await settle();
        expect(lists(fake), 2);

        session.inbox.reader(tab)!.revoke();
        answer.complete({
          'items': [activityRow('r1')],
          'more': false,
        });
        await settle();
        expect(feed.items, isEmpty);
        expect(feed.fromServer, isFalse);
        expect(session.activity.items(SwarmActivityFilter.threads), isEmpty);
        expect(session.activity.badge, 0);
      },
    );

    test('rows read before access was lost are cleared with it', () async {
      final fake = server(() => [activityRow('r1')]);
      final session = await start(fake);
      final feed = SwarmActivityFeed(session.inbox.reader(tab)!);
      addTearDown(feed.dispose);
      await settle();
      expect(feed.items, hasLength(1));

      session.inbox.reader(tab)!.revoke();
      await settle();
      expect(feed.items, isEmpty, reason: 'nothing of it stays on the phone');
      expect(feed.loaded, isFalse);
    });

    test(
      'a list answered after sign-out changes nothing and throws nothing',
      () async {
        final answer = Completer<Object?>();
        final fake = server(() => const []);
        fake.routes[activityPath] = (_) => answer.future;
        final session = await start(fake, dispose: false);
        final reader = session.inbox.reader(tab)!;
        final feed = SwarmActivityFeed(reader);
        final told = <int>[];
        feed.addListener(() => told.add(1));
        await settle();

        feed.dispose();
        session.dispose();
        answer.complete({
          'items': [activityRow('r1')],
          'more': false,
        });
        await settle();
        expect(feed.items, isEmpty);
        expect(told, isEmpty);
      },
    );

    test('a list asked before the Swarm was read again from nothing is not '
        'shown over the new read', () async {
      final first = Completer<Object?>(), second = Completer<Object?>();
      var calls = 0;
      var digest = 'digest-1';
      final fake = server(() => const [], digest: () => digest);
      fake.routes[activityPath] = (_) =>
          ++calls == 1 ? first.future : second.future;
      final session = await start(fake);
      // The Swarm is read again from nothing (its access moved).
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('FORBIDDEN', 'No', statusCode: 403);
      digest = 'digest-2';
      await session.inbox.reader(tab)!.refresh();
      await settle();

      first.complete({
        'items': [activityRow('stale')],
        'more': false,
      });
      await settle();
      expect(
        session.activity.items(SwarmActivityFilter.threads),
        isEmpty,
        reason: 'asked under what the phone held before',
      );

      second.complete({
        'items': [activityRow('fresh')],
        'more': false,
      });
      await settle();
      expect(keys(session.activity, SwarmActivityFilter.threads), [
        'activity:$tab:fresh',
      ]);
    });
  });

  group('reply notices', () {
    /// A reply by Mia in thread root-1 of the lead chat.
    Map<String, dynamic> mia(
      String id, {
      String kind = 'reply',
      bool read = false,
      int minute = 5,
    }) => activityRow(
      id,
      kind: kind,
      threadId: 'root-1',
      messageId: 'reply-$id',
      actor: const {'kind': 'person', 'id': 'person-mia', 'name': 'Mia'},
      emoji: kind == 'reaction' ? 'check' : null,
      text: 'sounds good, ship it',
      minute: minute,
      read: read,
    );

    test('the feed tells of each reply new since its first read and still '
        'unread, once', () async {
      var rows = [activityRow('r1', minute: 1)];
      var digest = 'digest-1';
      final fake = server(() => rows, digest: () => digest);
      final session = await start(fake);
      final told = <String>[];
      final feed = SwarmActivityFeed(session.inbox.reader(tab)!)
        ..onReply = (entry) => told.add(entry.id);
      addTearDown(feed.dispose);
      await settle();
      expect(feed.loaded, isTrue);
      expect(told, isEmpty, reason: 'what the first read lists is not news');

      rows = [mia('r2', minute: 2), ...rows];
      digest = 'digest-2';
      await swarmMoves(session, fake, () => digest);
      expect(told, ['r2']);

      rows = [
        mia('r4', read: true, minute: 4),
        mia('x1', kind: 'reaction', minute: 3),
        ...rows,
      ];
      digest = 'digest-3';
      await swarmMoves(session, fake, () => digest);
      expect(
        told,
        ['r2'],
        reason: 'the same row again, a read reply and a reaction tell nothing',
      );
    });

    /// A session whose Activity no screen has asked for, its notices kept.
    Future<(SwarmSession, _Notices)> unopened(FakeSwarm fake) async {
      final notices = _Notices();
      final session = SwarmSession(
        accountId: me,
        request: fake.request,
        notices: notices,
        readMarks: MemoryKeyValueStore(),
      );
      addTearDown(session.dispose);
      await session.inbox.refresh();
      await settle();
      return (session, notices);
    }

    test('a new unread reply posts one notice with Activity never opened, '
        'reading once per digest move; taken down once it is read', () async {
      var rows = [activityRow('r1', minute: 1)];
      var digest = 'digest-1';
      final fake = server(() => rows, digest: () => digest);
      final (session, notices) = await unopened(fake);
      expect(lists(fake), 1, reason: 'read from the session start');
      expect(notices.replies, isEmpty, reason: 'the first read is not news');

      rows = [mia('r2', minute: 2), ...rows];
      digest = 'digest-2';
      await swarmMoves(session, fake, () => digest);
      expect(lists(fake), 2);
      final notice = notices.replies.single;
      expect(notice.title, 'Mia replied in a thread');
      expect(notice.subtitle, 'Mobile');
      expect(notice.body, 'Open Harness to read it.');
      expect(notice.target, (
        swarmId: tab,
        conversationId: leadChat,
        messageId: 'reply-r2',
        decisionId: null,
      ));

      await swarmMoves(session, fake, () => digest);
      expect(lists(fake), 2, reason: 'the same digest reads nothing');
      digest = 'digest-3';
      await swarmMoves(session, fake, () => digest);
      expect(lists(fake), 3);
      expect(notices.replies, hasLength(1), reason: 'the same row again');
      expect(notices.cancelled, isEmpty);

      // Read in the thread, on this phone or another device.
      rows = [mia('r2', minute: 2, read: true), activityRow('r1', minute: 1)];
      digest = 'digest-4';
      await swarmMoves(session, fake, () => digest);
      expect(notices.cancelled, [notice.key]);
    });

    test('nothing is posted while a Swarm screen is up', () async {
      var rows = [activityRow('r1', minute: 1)];
      var digest = 'digest-1';
      final fake = server(() => rows, digest: () => digest);
      final (session, notices) = await unopened(fake);
      session.enter();

      rows = [mia('r2', minute: 2), ...rows];
      digest = 'digest-2';
      await swarmMoves(session, fake, () => digest);
      expect(notices.replies, isEmpty);
    });
  });

  group('a failed read', () {
    test('says so with no stuck loading, is not read again at every Swarm '
        'read, and Try again brings the feature back', () async {
      var fail = true;
      final fake = server(() => [activityRow('r1')]);
      fake.routes[activityPath] = (_) => fail
          ? throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503)
          : {
              'items': [activityRow('r1')],
              'more': false,
            };
      final session = await start(fake);
      final activity = session.activity..watch();
      addTearDown(activity.unwatch);
      await settle();

      expect(activity.unreadChats, isTrue);
      expect(activity.reading, isFalse, reason: 'no stuck loading');
      final asked = lists(fake);
      for (var i = 0; i < 3; i++) {
        await swarmMoves(session, fake, () => 'digest-1');
      }
      expect(lists(fake), asked, reason: 'bounded: the same digest waits');

      fail = false;
      activity.retry();
      await settle();
      expect(activity.unreadChats, isFalse);
      expect(keys(activity, SwarmActivityFilter.threads), ['activity:$tab:r1']);
      expect(activity.label(SwarmActivityFilter.threads), 'Replies');
    });

    test('a failed first read recovers when the digest moves', () async {
      var fail = true;
      var digest = 'digest-1';
      final fake = server(() => [activityRow('r1')], digest: () => digest);
      fake.routes[activityPath] = (_) => fail
          ? throw const SuperTabFailure('UNAVAILABLE', 'Down', statusCode: 503)
          : {
              'items': [activityRow('r1')],
              'more': false,
            };
      final session = await start(fake);
      expect(session.activity.items(SwarmActivityFilter.threads), isEmpty);

      fail = false;
      digest = 'digest-2';
      await session.inbox.reader(tab)!.refresh();
      await settle();
      expect(keys(session.activity, SwarmActivityFilter.threads), [
        'activity:$tab:r1',
      ]);
      expect(session.activity.badge, 3);
    });

    test('a row this build cannot read is left out, not the list', () async {
      final fake = server(
        () => [
          activityRow('r1'),
          {'id': 'broken'},
        ],
      );
      final session = await start(fake);
      expect(keys(session.activity, SwarmActivityFilter.threads), [
        'activity:$tab:r1',
      ]);
    });
  });
}

extension on SwarmActivity {
  /// In sight long enough for every read it asks to answer.
  Future<void> watch2() async {
    watch();
    await settle();
    unwatch();
    await settle();
  }
}

/// Records the Swarm notices posted and taken down.
class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];
  final cancelled = <String>[];

  /// The reply notices: not the decision and tag the fixture has waiting.
  List<SwarmNoticeMessage> get replies => [
    for (final n in shown)
      if (n.title.endsWith('replied in a thread')) n,
  ];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);

  @override
  Future<void> cancelSwarm(String key) async => cancelled.add(key);
}
