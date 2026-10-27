import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

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
    final fake = backend({'a': []});
    fake.routes['/api/super-tabs/a/parts'] = (_) => firstLoad(
      tabId: 'a',
      groups: [groupData('g1', title: 'Login', status: status)],
    );
    fake.routes['/api/super-tabs/a/changes'] = (_) => changes(
      cursor: 'c2',
      groups: [part('g1', 50, groupData('g1', title: 'Login', status: status))],
    );
    final i = inbox(fake);
    final news = <SwarmNeed>[];
    i.onArrived = news.add;
    await i.refresh();
    expect(news, isEmpty);

    status = 'needs_human';
    await i.refresh();

    expect(news.single, isA<SwarmWorkNeed>());
    await i.refresh();
    expect(news, hasLength(1), reason: 'still waiting is not news again');
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
}
