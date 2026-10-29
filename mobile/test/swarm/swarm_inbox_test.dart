import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

import 'swarm_fixture.dart';

/// The account's Swarms on the phone, and everything they ask of the person in
/// one list: open decisions, Lead tags and work waiting on them.
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

  test('what each Swarm asks of the person is one list', () async {
    final fake = backend(
      {
        'a': [groupData('g1', title: 'Login', status: 'needs_human')],
        'b': [],
      },
      derived: {
        'b': {'decisionsWaiting': 1, 'mentionsWaiting': 0},
      },
    );
    fake.routes['/api/super-tabs/b/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'conversationId': 'g9',
          'question': 'Ship it?',
          'options': ['Yes', 'No'],
          'createdAt': '2026-10-27T01:00:00.000Z',
        },
      ],
    };
    fake.routes['/api/super-tabs/b/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final i = inbox(fake);

    await i.refresh();
    await settle();

    expect(i.needs, hasLength(2));
    expect(
      i.needs.whereType<SwarmDecisionNeed>().single.decision.question,
      'Ship it?',
    );
    expect(i.needs.whereType<SwarmDecisionNeed>().single.swarmId, 'b');
    final work = i.needs.whereType<SwarmWorkNeed>().single;
    expect(work.work.conversation.title, 'Login');
    expect(work.swarmId, 'a');
  });

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
    expect(i.needs, isEmpty);
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

  test(
    'a private question is out of the list from the moment the Swarm is '
    'read again in full, even when the new read of what waits fails',
    () async {
      const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
      final fake = backend(
        {
          'a': [
            groupData(
              'g-private',
              title: 'Pair',
              audience: [me, 'person-other'],
            ),
          ],
        },
        derived: {'a': derived},
      );
      Object? open = {
        'decisions': [
          {
            'id': 'd1',
            'conversationId': 'g-private',
            'question': 'Rotate the keys?',
            'options': ['Yes', 'No'],
          },
        ],
      };
      fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => open;
      fake.routes['/api/super-tabs/a/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      final i = inbox(fake);
      await i.refresh();
      await settle();
      expect(i.needs.whereType<SwarmDecisionNeed>(), hasLength(1));

      // Taken out of the private chat: the Swarm is read again without it,
      // and the read of what waits for the person stalls.
      fake.routes['/api/super-tabs/a/parts'] = (_) =>
          firstLoad(tabId: 'a', derived: derived);
      fake.routes['/api/super-tabs/a/changes'] = (_) => {'reload': true};
      final stalled = Completer<Object?>();
      open = stalled.future;
      await i.refresh();
      await settle();

      expect(i.needs.whereType<SwarmDecisionNeed>(), isEmpty);

      stalled.completeError(
        const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.'),
      );
      await settle();

      expect(i.needs.whereType<SwarmDecisionNeed>(), isEmpty);
    },
  );

  test('work that starts waiting after the first read is news', () async {
    var status = 'working';
    var changedAt = 100;
    final fake = backend({'a': []});
    // The status is a part: its change moves the Swarm's last change.
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {...listing('a', 'Swarm a'), 'lastChangedAt': changedAt},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/a/parts'] = (_) => firstLoad(
      tabId: 'a',
      groups: [groupData('g1', title: 'Login', status: status)],
    );
    fake.routes['/api/super-tabs/a/changes'] = (_) => changes(
      cursor: 'c2',
      groups: [part('g1', 50, groupData('g1', title: 'Login', status: status))],
      lastChangedAt: changedAt,
    );
    final i = inbox(fake);
    final news = <SwarmNeed>[];
    i.onArrived = news.add;
    await i.refresh();
    expect(news, isEmpty);

    status = 'needs_human';
    changedAt = 200;
    await i.refresh();

    expect(news.single, isA<SwarmWorkNeed>());
    await i.refresh();
    expect(news, hasLength(1), reason: 'still waiting is not news again');
  });

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

    // Decisions and tags are not parts: one answered or done on another
    // device moves no last-change time.
    test('every poll while something waits in it', () async {
      final fake = two(
        {'a': 100, 'b': 100},
        derived: {
          'a': {'decisionsWaiting': 1, 'mentionsWaiting': 0},
        },
      );
      fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'conversationId': 'g1',
            'question': 'Ship it?',
            'options': ['Yes'],
          },
        ],
      };
      final i = inbox(fake);
      await i.refresh();
      await settle();

      await i.refresh();
      await settle();
      await i.refresh();
      await settle();

      expect(changeReads(fake, 'a'), 2);
      expect(changeReads(fake, 'b'), 0);
    });

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

    test('at the next poll when its asks could not be read', () async {
      final fake = two(
        {'a': 100, 'b': 100},
        derived: {
          'a': {'decisionsWaiting': 0, 'mentionsWaiting': 1},
        },
      );
      var failing = true;
      fake.routes['/api/super-tabs/a/mentions?state=waiting'] = (_) => failing
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : {
              'mentions': [
                {
                  'id': 'm1',
                  'conversationId': 'g1',
                  'messageId': 'msg-1',
                  'text': 'Look',
                },
              ],
            };
      final i = inbox(fake);
      await i.refresh();
      await settle();
      expect(i.asks('a')!.error, isNotNull);

      failing = false;
      await i.refresh();
      await settle();

      expect(i.needs.whereType<SwarmMentionNeed>(), hasLength(1));
    });
  });

  group('notifies only when what it shows changed', () {
    /// Swarm `a` with work waiting on the person and one open decision;
    /// [groups] answers each change read.
    FakeSwarm waiting({List<Map<String, dynamic>> Function()? groups}) {
      const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
      final fake = backend(
        {
          'a': [groupData('g1', title: 'Login', status: 'needs_human')],
        },
        derived: {'a': derived},
      );
      fake.routes['/api/super-tabs/a/changes'] = (_) => changes(
        cursor: 'c2',
        groups: groups?.call() ?? const [],
        derived: derived,
      );
      fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => {
        'decisions': [
          {
            'id': 'd1',
            'conversationId': 'g1',
            'question': 'Ship it?',
            'options': ['Yes', 'No'],
          },
        ],
      };
      fake.routes['/api/super-tabs/a/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      return fake;
    }

    // Every 15-second poll rebuilt Home, the drawer and Project, twice or
    // more, with nothing new (audit of 44d284f65, items 4 and 5).
    test('a poll that finds everything as it was notifies nothing', () async {
      final i = inbox(waiting());
      await i.refresh();
      await settle();
      expect(i.needs, hasLength(2));
      final needs = i.needs;
      var notifies = 0;
      i.addListener(() => notifies++);

      await i.refresh();
      await settle();
      await i.refresh();
      await settle();

      expect(notifies, 0);
      expect(i.needs, same(needs));
    });

    test('a poll that changes a Swarm notifies once', () async {
      var title = 'Login';
      final i = inbox(
        waiting(
          groups: () => [
            part('g1', 9, groupData('g1', title: title, status: 'needs_human')),
          ],
        ),
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
        i.needs.whereType<SwarmWorkNeed>().single.work.conversation.title,
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

    test("a Swarm's asks ending their loading are told", () async {
      final fake = waiting();
      final open = Completer<Object?>();
      fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) =>
          open.future;
      final i = inbox(fake);
      await i.refresh();
      await settle();
      expect(i.asks('a')!.loading, isTrue);
      var notifies = 0;
      i.addListener(() => notifies++);

      open.complete({'decisions': <Object>[]});
      await settle();

      expect(i.asks('a')!.loading, isFalse);
      expect(notifies, 1);
    });

    // A Done or an answer waited for the poll's slowest Swarm read before
    // Home showed it: on the owner's iPhone a read takes seconds.
    test('a slow poll holds back no Done and no answer', () async {
      const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
      final fake = backend({'a': []}, derived: {'a': derived});
      var answered = false, done = false;
      fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => {
        'decisions': [
          if (!answered)
            {
              'id': 'd1',
              'conversationId': 'g1',
              'question': 'Ship it?',
              'options': ['Yes', 'No'],
            },
        ],
      };
      fake.routes['/api/super-tabs/a/mentions?state=waiting'] = (_) => {
        'mentions': [
          if (!done)
            {
              'id': 'm1',
              'conversationId': 'g1',
              'messageId': 'msg-1',
              'text': 'Can you check the copy?',
            },
        ],
      };
      final sent = Completer<void>();
      fake.routes['/api/super-tabs/a/commands'] = (body) async {
        final command = body!['command'] as Map;
        if (command['type'] == 'decision.answer') {
          await sent.future;
          answered = true;
        } else {
          done = true;
        }
        return {'result': <String, dynamic>{}};
      };
      final i = inbox(fake);
      await i.refresh();
      await settle();
      final asks = i.asks('a')!;
      expect(i.needs.whereType<SwarmMentionNeed>(), hasLength(1));
      final decision = i.needs.whereType<SwarmDecisionNeed>().single.decision;
      final read = Completer<void>();
      final changed = fake.routes['/api/super-tabs/a/changes']!;
      fake.routes['/api/super-tabs/a/changes'] = (q) async {
        await read.future;
        return changed(q);
      };
      unawaited(i.refresh());
      await settle();
      var notifies = 0;
      i.addListener(() => notifies++);

      unawaited(asks.done(asks.mentions.single));
      await settle();

      expect(i.needs.whereType<SwarmMentionNeed>(), isEmpty);

      notifies = 0;
      unawaited(asks.answer(decision, 0));
      await settle();

      expect(notifies, greaterThan(0), reason: 'its buttons wait at once');
      expect(asks.answering, contains('d1'));

      sent.complete();
      await settle();

      expect(i.needs.whereType<SwarmDecisionNeed>(), isEmpty);
      read.complete();
      await settle();
    });

    testWidgets('a screen over it builds once per change, not once per poll', (
      tester,
    ) async {
      final i = inbox(waiting());
      var builds = 0;
      await tester.pumpWidget(
        ListenableBuilder(
          listenable: i,
          builder: (_, _) {
            builds++;
            return Text('${i.needs.length}', textDirection: TextDirection.ltr);
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
      expect(find.text('2'), findsOneWidget);

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
}
