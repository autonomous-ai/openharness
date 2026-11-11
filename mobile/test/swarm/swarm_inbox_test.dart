import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

import 'swarm_fixture.dart';

/// The account's Swarms on the phone, each read again only when it changed.
void main() {
  Map<String, dynamic> listing(String id, String name) => {
    'id': id,
    'name': name,
    'ownerId': me,
    'paused': false,
    'lastChangedAt': 100,
  };

  /// [swarms] answer a first load each, with [groups] of their own.
  FakeSwarm backend(
    Map<String, List<Map<String, dynamic>>> swarms, {
    Map<String, Map<String, dynamic>> derived = const {},
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [for (final id in swarms.keys) listing(id, 'Swarm $id')],
      'next': null,
    };
    for (final MapEntry(key: id, value: groups) in swarms.entries) {
      fake.routes['/api/super-tabs/$id/parts'] = (_) => firstLoad(
        tabId: id,
        groups: groups,
        derived: derived[id] ?? const {},
      );
      fake.routes['/api/super-tabs/$id/changes'] = (_) =>
          changes(cursor: 'c2', derived: derived[id] ?? const {});
    }
    return fake;
  }

  SwarmInbox inbox(FakeSwarm fake) {
    final inbox = SwarmInbox(accountId: me, request: fake.request);
    addTearDown(inbox.dispose);
    return inbox;
  }

  test("lists the account's Swarms, every page of them", () async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list?after=p2'] = (_) => {
      'tabs': [listing('b', 'Beta')],
      'next': null,
    };
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [listing('a', 'Alpha')],
      'next': 'p2',
    };
    fake.routes['/api/super-tabs/a/parts'] = (_) => firstLoad(tabId: 'a');
    fake.routes['/api/super-tabs/b/parts'] = (_) => firstLoad(tabId: 'b');
    final i = inbox(fake);

    await i.refresh();

    expect([for (final s in i.swarms) s.name], ['Alpha', 'Beta']);
    expect(i.error, isNull);
  });

  test(
    'a list that repeats its cursor is refused, and the last list stays',
    () async {
      final fake = backend({'a': []});
      final i = inbox(fake);
      await i.refresh();

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [listing('z', 'Zed')],
        'next': 'loop',
      };
      fake.routes['/api/super-tabs/list?after=loop'] = (_) => {
        'tabs': <Object>[],
        'next': 'loop',
      };
      await i.refresh();

      expect([for (final s in i.swarms) s.id], ['a']);
      expect(i.error, isNotNull);
    },
  );

  test('a Swarm the person left is dropped, with all it held', () async {
    final fake = backend({
      'a': [groupData('g1', status: 'needs_human')],
      'b': [],
    });
    final i = inbox(fake);
    await i.refresh();
    expect(i.reader('a'), isNotNull);

    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [listing('b', 'Swarm b')],
      'next': null,
    };
    await i.refresh();

    expect([for (final s in i.swarms) s.id], ['b']);
    expect(i.reader('a'), isNull);
  });

  test('a Swarm its owner deleted leaves the switcher on the next read, and '
      'a row marked deleted is never listed', () async {
    final fake = backend({
      'a': [groupData('g1', status: 'needs_human')],
      'b': [],
      'c': [],
    });
    final i = inbox(fake);
    await i.refresh();
    expect([for (final s in i.swarms) s.id], ['a', 'b', 'c']);

    // Deleted: the server lists it to nobody, and its reads answer as for a
    // Swarm that does not exist.
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        listing('b', 'Swarm b'),
        {...listing('c', 'Swarm c'), 'deletedAt': 100},
      ],
      'next': null,
    };
    fake.routes.remove('/api/super-tabs/a/parts');
    fake.routes.remove('/api/super-tabs/a/changes');
    await i.refresh();

    expect([for (final s in i.swarms) s.id], ['b']);
    expect(i.reader('a'), isNull);
    expect(i.reader('c'), isNull);
  });

  test(
    'a Swarm the person left takes its chat off a screen still holding it',
    () async {
      final fake = backend({
        'a': [groupData('g1', title: 'Login', lastMessageSequence: 1)],
      });
      fake.routes['/api/super-tabs/a/conversations/g1/messages'] = (_) => {
        'messages': [
          {
            'id': 'm1',
            'conversationId': 'g1',
            'text': 'private plan',
            'sequence': 1,
            'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          },
        ],
        'next': null,
      };
      final i = inbox(fake);
      await i.refresh();
      final held = i.reader('a')!;
      final chat = SwarmConversation(held, 'g1');
      addTearDown(chat.dispose);
      await chat.load();
      chat.draft = 'my reply';
      expect(chat.messages, hasLength(1));

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await i.refresh();

      expect(held.snapshot, isNull);
      expect(chat.messages, isEmpty);
      expect(chat.draft, isEmpty);
    },
  );

  group('a poll reads a Swarm again', () {
    /// Swarms `a` and `b`, listed as last changed at [changedAt].
    FakeSwarm two(
      Map<String, int> changedAt, {
      Map<String, Map<String, dynamic>> derived = const {},
    }) {
      final fake = backend({'a': [], 'b': []}, derived: derived);
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          for (final id in ['a', 'b'])
            {...listing(id, 'Swarm $id'), 'lastChangedAt': changedAt[id]},
        ],
        'next': null,
      };
      return fake;
    }

    int changeReads(FakeSwarm fake, String id) => fake.paths
        .where((p) => p.startsWith('/api/super-tabs/$id/changes'))
        .length;

    // Every Swarm was read every 15 seconds whether it had changed or not
    // (audit of 44d284f65, swarm_inbox.dart:280).
    test('only when its listed last change moved', () async {
      final changedAt = {'a': 100, 'b': 100};
      final fake = two(changedAt);
      fake.routes['/api/super-tabs/a/changes'] = (_) =>
          changes(cursor: 'c2', lastChangedAt: 200);
      final i = inbox(fake);
      await i.refresh();
      await settle();

      changedAt['a'] = 200;
      await i.refresh();
      await settle();
      await i.refresh();
      await settle();

      expect(changeReads(fake, 'a'), 1);
      expect(changeReads(fake, 'b'), 0);
    });

    test(
      'a Swarm never changed is listed with no time, and read once',
      () async {
        final fake = two({});
        fake.routes['/api/super-tabs/a/parts'] = (_) =>
            firstLoad(tabId: 'a', lastChangedAt: 0);
        fake.routes['/api/super-tabs/a/changes'] = (_) =>
            changes(cursor: 'c2', lastChangedAt: 0);
        final i = inbox(fake);
        await i.refresh();
        await settle();

        await i.refresh();
        await settle();

        expect(changeReads(fake, 'a'), 0);
      },
    );

    test('at the next poll when its last read failed', () async {
      final fake = two({'a': 100, 'b': 100});
      var failing = true;
      final load = fake.routes['/api/super-tabs/b/parts']!;
      fake.routes['/api/super-tabs/b/parts'] = (body) => failing
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : load(body);
      final i = inbox(fake);
      await i.refresh();
      await settle();
      expect(i.reader('b')!.snapshot, isNull);

      failing = false;
      await i.refresh();
      await settle();

      expect(i.reader('b')!.snapshot, isNotNull);
    });
  });

  group('notifies only when what it shows changed', () {
    /// Swarm `a` with work in g1, whose last change moves at every list read,
    /// so every poll reads its changes; [groups] answers each.
    FakeSwarm working({List<Map<String, dynamic>> Function()? groups}) {
      final fake = backend({
        'a': [groupData('g1', title: 'Login')],
      });
      var changedAt = 100;
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {...listing('a', 'Swarm a'), 'lastChangedAt': changedAt++},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/a/changes'] = (_) =>
          changes(cursor: 'c2', groups: groups?.call() ?? const []);
      return fake;
    }

    // Every 15-second poll rebuilt Home, the drawer and Project, twice or
    // more, with nothing new (audit of 44d284f65, items 4 and 5).
    test('a poll that finds everything as it was notifies nothing', () async {
      final i = inbox(working());
      await i.refresh();
      await settle();
      var notifies = 0;
      i.addListener(() => notifies++);

      await i.refresh();
      await settle();
      await i.refresh();
      await settle();

      expect(notifies, 0);
    });

    test('a poll that changes a Swarm notifies once', () async {
      var title = 'Login';
      final i = inbox(
        working(groups: () => [part('g1', 9, groupData('g1', title: title))]),
      );
      await i.refresh();
      await settle();
      var notifies = 0;
      i.addListener(() => notifies++);

      title = 'Login on the phone';
      await i.refresh();
      await settle();

      expect(notifies, 1);
      expect(
        i.reader('a')!.snapshot!.conversation('g1')!.title,
        'Login on the phone',
      );
    });

    test('still no computer is told once', () async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
        'MACHINE_UNAVAILABLE',
        'Connect one of your computers to open Swarm.',
      );
      final i = inbox(fake);
      var notifies = 0;
      i.addListener(() => notifies++);

      await i.refresh();
      await i.refresh();
      await i.refresh();

      expect(i.noComputer, isTrue);
      expect(notifies, 1);
    });

    test('a computer back after none is told', () async {
      final fake = backend({'a': []});
      final listed = fake.routes['/api/super-tabs/list']!;
      var away = true;
      fake.routes['/api/super-tabs/list'] = (q) => away
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : listed(q);
      final i = inbox(fake);
      await i.refresh();
      var notifies = 0;
      i.addListener(() => notifies++);

      away = false;
      await i.refresh();
      await settle();

      expect(i.noComputer, isFalse);
      expect(i.loaded, isTrue);
      expect(notifies, greaterThan(0));
    });

    testWidgets('a screen over it builds once per change, not once per poll', (
      tester,
    ) async {
      final i = inbox(working());
      var builds = 0;
      await tester.pumpWidget(
        ListenableBuilder(
          listenable: i,
          builder: (_, _) {
            builds++;
            return Text(
              '${i.swarms.length}',
              textDirection: TextDirection.ltr,
            );
          },
        ),
      );
      Future<void> poll() async {
        unawaited(i.refresh());
        for (var n = 0; n < 20; n++) {
          await tester.pump();
        }
      }

      await poll();
      final afterFirst = builds;
      expect(find.text('1'), findsOneWidget);

      await poll();
      await poll();
      await poll();

      expect(builds, afterFirst);
    });
  });

  test('without a computer to ask, it says so', () async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
      'MACHINE_UNAVAILABLE',
      'Connect one of your computers to open Swarm.',
    );
    final i = inbox(fake);

    await i.refresh();

    expect(i.error, 'Connect one of your computers to open Swarm.');
    expect(i.loaded, isFalse);
  });

  // Production before Swarm v1 (2026-10-27, on the owner's iPhone): no list
  // route, so the old one-Swarm route read "list" as a Swarm's id and said
  // "This Super Tab is unavailable."
  test(
    'a server without the list says it has no Swarm on the phone yet',
    () async {
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
        'NOT_FOUND',
        'This Super Tab is unavailable.',
        statusCode: 404,
      );
      final i = inbox(fake);

      await i.refresh();

      expect(i.error, swarmServerTooOld);
      expect(i.loaded, isFalse);
    },
  );

  test('any other refusal of the list keeps its own words', () async {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
      'SWARM_MIGRATING',
      'This Swarm is being moved. Try again in a moment.',
      statusCode: 503,
    );
    final i = inbox(fake);

    await i.refresh();

    expect(i.error, 'This Swarm is being moved. Try again in a moment.');
  });

  group('a list that could not be read goes in the log', () {
    late _Log log;

    setUp(() {
      final before = appLog;
      log = _Log();
      appLog = log;
      addTearDown(() => appLog = before);
    });

    test(
      'a Swarm that could not be read, once however many reads fail',
      () async {
        final fake = backend({'a': []});
        fake.routes['/api/super-tabs/a/parts'] = (_) =>
            throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
        final i = inbox(fake);

        await i.refresh();
        final reader = i.reader('a')!;
        await reader.refresh();
        await reader.refresh();

        expect(reader.error, 'Broken');
        expect(log.events, hasLength(1));
        expect(log.events.single.level, AppLogLevel.warn);
        expect(log.events.single.message, contains('Swarm a not read: Broken'));
      },
    );

    test('what threw, with its stack, once however many polls fail, and '
        'again after a read that worked', () async {
      final fake = backend({'a': []});
      final listed = fake.routes['/api/super-tabs/list']!;
      fake.routes['/api/super-tabs/list'] = (_) =>
          throw const FormatException('Bad answer');
      final i = inbox(fake);

      await i.refresh();
      await i.refresh();

      expect(log.events, hasLength(1));
      expect(log.events.single.level, AppLogLevel.error);
      expect(log.events.single.error, isA<FormatException>());
      expect(log.events.single.stackTrace, isNotNull);

      fake.routes['/api/super-tabs/list'] = listed;
      await i.refresh();
      expect(i.error, isNull);
      expect(log.events, hasLength(1), reason: 'a read that worked');

      fake.routes['/api/super-tabs/list'] = (_) =>
          throw const FormatException('Bad answer');
      await i.refresh();
      expect(log.events, hasLength(2));
    });

    test("a server's refusal is a warning naming its code, once for the "
        'same words, again for other ones', () async {
      final fake = FakeSwarm();
      void refuse(String code, String words) =>
          fake.routes['/api/super-tabs/list'] = (_) =>
              throw SuperTabFailure(code, words, statusCode: 503);
      refuse('SWARM_MIGRATING', 'Being moved.');
      final i = inbox(fake);

      await i.refresh();
      await i.refresh();

      expect(log.events, hasLength(1));
      expect(log.events.single.level, AppLogLevel.warn);
      expect(log.events.single.message, contains('SWARM_MIGRATING 503'));

      refuse('INTERNAL', 'Broken.');
      await i.refresh();
      expect(log.events, hasLength(2));
      expect(log.events.last.message, contains('INTERNAL 503'));
    });

    test('a read that works logs nothing', () async {
      await inbox(backend({'a': []})).refresh();

      expect(log.events, isEmpty);
    });
  });

  test('without a computer it asks again within seconds, on a backoff, '
      'not at the next poll', () {
    fakeAsync((async) {
      final fake = backend({'a': []});
      final listed = fake.routes['/api/super-tabs/list']!;
      var away = true;
      fake.routes['/api/super-tabs/list'] = (q) => away
          ? throw const SuperTabFailure(
              'MACHINE_UNAVAILABLE',
              'Connect one of your computers to open Swarm.',
            )
          : listed(q);
      final i = SwarmInbox(
        accountId: me,
        request: fake.request,
        pollInterval: const Duration(seconds: 15),
      );
      int lists() => fake.paths.where((p) => p.endsWith('/list')).length;

      i.shown = true;
      async.flushMicrotasks();
      expect(i.error, 'Connect one of your computers to open Swarm.');

      // Asked again after 2, 4 and 8 seconds.
      async.elapse(const Duration(milliseconds: 14500));
      expect(lists(), 4);

      away = false;
      async.elapse(const Duration(seconds: 16));
      expect(i.loaded, isTrue);
      expect(i.error, isNull);

      // Read, it is back on the poll.
      final read = lists();
      async.elapse(const Duration(seconds: 13));
      expect(lists(), read);

      // Back in front after a while away: asked at once.
      i.shown = false;
      async.elapse(const Duration(minutes: 5));
      i.shown = true;
      async.flushMicrotasks();
      expect(lists(), read + 1);
      i.dispose();
    });
  });

  test(
    'a computer up while it has none reads at once, not at the next try',
    () {
      fakeAsync((async) {
        final fake = backend({'a': []});
        final listed = fake.routes['/api/super-tabs/list']!;
        var away = true;
        fake.routes['/api/super-tabs/list'] = (q) => away
            ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
            : listed(q);
        final i = SwarmInbox(accountId: me, request: fake.request);
        int lists() => fake.paths.where((p) => p.endsWith('/list')).length;
        i.shown = true;
        async.flushMicrotasks();
        expect(i.noComputer, isTrue);

        away = false;
        async.elapse(const Duration(milliseconds: 500));
        i.computerUp();
        async.flushMicrotasks();

        expect(lists(), 2);
        expect(i.loaded, isTrue);
        expect(i.noComputer, isFalse);

        // Back on the poll: no quick try left behind.
        async.elapse(const Duration(seconds: 14));
        expect(lists(), 2);
        i.dispose();
      });
    },
  );

  test('a computer up reads nothing while it has one, or is hidden', () {
    fakeAsync((async) {
      final fake = backend({'a': []});
      final i = SwarmInbox(accountId: me, request: fake.request);
      int lists() => fake.paths.where((p) => p.endsWith('/list')).length;

      i.computerUp();
      async.flushMicrotasks();
      expect(lists(), 0, reason: 'hidden');

      i.shown = true;
      async.flushMicrotasks();
      i.computerUp();
      async.flushMicrotasks();
      expect(lists(), 1, reason: 'it had one: the poll reads');
      i.dispose();
    });
  });

  test('while shown it reads every poll; hidden, it reads nothing', () {
    fakeAsync((async) {
      final fake = backend({'a': []});
      final i = SwarmInbox(
        accountId: me,
        request: fake.request,
        pollInterval: const Duration(seconds: 15),
      );
      int lists() => fake.paths.where((p) => p.endsWith('/list')).length;

      i.shown = true;
      async.flushMicrotasks();
      expect(lists(), 1);

      async.elapse(const Duration(seconds: 31));
      expect(lists(), 3);

      i.shown = false;
      async.elapse(const Duration(minutes: 2));
      expect(lists(), 3);
      i.dispose();
    });
  });

  test("each Swarm's reader has its read marks, kept on the phone; a move of "
      'them is told, and a Swarm off the list takes them', () async {
    final fake = backend({
      'a': [groupData('g1', lastMessageSequence: 3)],
    });
    final store = MemoryKeyValueStore();
    final i = SwarmInbox(
      accountId: me,
      request: fake.request,
      readMarks: store,
    );
    addTearDown(i.dispose);
    await i.refresh();
    await settle();
    final marks = i.reader('a')!.readMarks!;
    // The first read's marks are written a moment after it.
    await until(() => store.values['swarm_read_marks.$me.a'] != null);
    var told = 0;
    i.addListener(() => told++);

    marks.markRead('g1', 5);
    await settle();
    expect(told, greaterThan(0));

    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': <Object>[],
      'next': null,
    };
    await i.refresh();
    await settle();

    expect(i.reader('a'), isNull);
    expect(store.values['swarm_read_marks.$me.a'], isNull);
  });

  test('an inbox closing keeps its read marks: the next one, for the same '
      'account, reads what came since as unread', () async {
    const key = 'swarm_read_marks.$me.a';
    final store = MemoryKeyValueStore();
    final first = SwarmInbox(
      accountId: me,
      request: backend({
        'a': [groupData('g1', lastMessageSequence: 3)],
      }).request,
      readMarks: store,
    );
    await first.refresh();
    await settle();
    await until(() => store.values[key] != null);

    first.dispose();
    await settle();

    expect(store.values[key], isNotNull, reason: 'kept, not forgotten');
    expect(jsonDecode(store.values[key]!), {
      'marks': {'g1': 3},
    });
    final next = SwarmInbox(
      accountId: me,
      request: backend({
        'a': [groupData('g1', lastMessageSequence: 6)],
      }).request,
      readMarks: store,
    );
    addTearDown(next.dispose);
    await next.refresh();
    await settle();
    final reader = next.reader('a')!;
    await until(
      () => reader.readMarks!.unread(reader.snapshot!.conversation('g1')!),
    );

    expect(
      reader.readMarks!.unread(reader.snapshot!.conversation(leadChat)!),
      isFalse,
    );
  });
}

class _Log implements AppLog {
  final events =
      <
        ({
          AppLogLevel level,
          String message,
          Object? error,
          StackTrace? stackTrace,
        })
      >[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => events.add((
    level: level,
    message: message,
    error: error,
    stackTrace: stackTrace,
  ));
}
