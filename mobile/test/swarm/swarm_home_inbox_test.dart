import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_buddy.dart';
import 'package:harness_mobile/swarm/team_glance.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/waiting_work.dart';

import 'swarm_fixture.dart';

/// The last Home kept on the phone: drawn at once on a cold start, replaced
/// by the first read, and rid of a Swarm the moment a read says the person
/// lost it (owner, 2026-10-27).
void main() {
  /// Swarm `a`'s Home with [title] work waiting on the person, as kept.
  SwarmHomeEntry kept({String title = 'Kept work', String project = 'Mobile'}) {
    final state = SuperTabParts.firstLoad(
      firstLoad(
        tabId: 'a',
        head: headData(
          id: 'a',
          projects: [
            {
              'id': 'project-1',
              'name': project,
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
              'updateMinutes': 5,
            },
          ],
        ),
        groups: [
          {
            ...groupData('g1', title: title, status: 'needs_human'),
            'partnerId': me,
          },
        ],
      ),
    ).state;
    return (
      id: 'a',
      name: 'Swarm a',
      view: swarmHomeSwarm(
        SuperTabSnapshot.fromJson(state),
        swarmPartners(state),
      ),
    );
  }

  /// The backend of Swarm `a`, whose list waits on [listed] when given.
  FakeSwarm backend({
    Completer<Object?>? listed,
    List<Map<String, dynamic>> groups = const [],
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) =>
        listed?.future ??
        {
          'tabs': [
            {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': 100},
          ],
          'next': null,
        };
    fake.routes['/api/super-tabs/a/parts'] = (_) =>
        firstLoad(tabId: 'a', groups: groups);
    fake.routes['/api/super-tabs/a/changes'] = (_) =>
        changes(cursor: 'c2', groups: const []);
    return fake;
  }

  SwarmInbox inbox(
    FakeSwarm fake,
    SwarmHomeCache cache, {
    String account = me,
    Duration homeWait = const Duration(hours: 1),
  }) {
    final i = SwarmInbox(
      accountId: account,
      request: fake.request,
      homeCache: cache,
      homeWait: homeWait,
    );
    addTearDown(i.dispose);
    return i;
  }

  Future<List<String>> keptTitles(SwarmHomeCache cache) async => [
    for (final s in await cache.read(me) ?? const <SwarmHomeEntry>[])
      for (final c in SuperTabSnapshot.fromJson(s.view.state).conversations)
        c.title,
  ];

  test(
    'a cold start draws the Home kept before the first read answers',
    () async {
      final cache = memoryHomeCache();
      await cache.write(me, [kept()]);
      final i = inbox(backend(listed: Completer()), cache)..shown = true;

      await until(() => i.swarms.isNotEmpty);

      expect([for (final s in i.swarms) s.name], ['Swarm a']);
      expect(i.reader('a')!.snapshot!.projects.single.name, 'Mobile');
      expect(
        i.needs.whereType<SwarmWorkNeed>().single.work.conversation.title,
        'Kept work',
      );
      expect(i.loaded, isFalse);
      expect(i.asks('a')!.loading, isTrue, reason: 'its asks are not kept');
    },
  );

  test(
    "a cold start draws the person's Buddy chat from the Home kept",
    () async {
      final state = SuperTabParts.firstLoad(
        firstLoad(
          tabId: 'a',
          head: headData(id: 'a'),
          groups: [buddyChatData('buddy-me')],
          agents: [buddyData('agent-wren', displayName: 'Wren')],
        ),
      ).state;
      final cache = memoryHomeCache();
      await cache.write(me, [
        (
          id: 'a',
          name: 'Swarm a',
          view: swarmHomeSwarm(
            SuperTabSnapshot.fromJson(state),
            swarmPartners(state),
            buddies: SwarmBuddies.read(state, me),
          ),
        ),
      ]);
      final i = inbox(backend(listed: Completer()), cache)..shown = true;

      await until(() => i.swarms.isNotEmpty);

      final reader = i.reader('a')!;
      expect(swarmBuddyChat(reader, project)?.id, 'buddy-me');
      expect(swarmBuddy(reader, project)?.id, 'agent-wren');
      expect(
        swarmTeamGlance(reader.snapshot!).agents,
        isEmpty,
        reason: 'a Buddy is no one\'s team, from the Home kept too',
      );
    },
  );

  test('the first read replaces the Home kept, and is kept in turn', () async {
    final cache = memoryHomeCache();
    await cache.write(me, [kept()]);
    final i = inbox(
      backend(groups: [groupData('g2', title: 'Fresh work')]),
      cache,
    );

    await i.refresh();
    await settle();

    final titles = [
      for (final c in i.reader('a')!.snapshot!.conversations) c.title,
    ];
    expect(titles, contains('Fresh work'));
    expect(titles, isNot(contains('Kept work')));
    expect(await keptTitles(cache), contains('Fresh work'));
    expect(await keptTitles(cache), isNot(contains('Kept work')));
  });

  test('work in the Home kept is never news', () async {
    final cache = memoryHomeCache();
    await cache.write(me, [kept(title: 'Login')]);
    final listed = Completer<Object?>();
    final i = inbox(
      backend(
        listed: listed,
        groups: [
          {
            ...groupData('g1', title: 'Login', status: 'needs_human'),
            'partnerId': me,
          },
          // Waiting already at the first read, not since: no news either.
          {
            ...groupData('g2', title: 'Billing', status: 'blocked'),
            'partnerId': me,
          },
        ],
      ),
      cache,
    );
    final news = <SwarmNeed>[];
    i.onArrived = news.add;
    await until(() => i.swarms.isNotEmpty);

    listed.complete({
      'tabs': [
        {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': 100},
      ],
      'next': null,
    });
    await i.refresh();
    await settle();

    expect(i.needs.whereType<SwarmWorkNeed>(), hasLength(2));
    expect(news, isEmpty);
  });

  test('a Swarm off the list leaves the Home kept at once', () async {
    final cache = memoryHomeCache();
    final fake = backend(groups: [groupData('g2', title: 'Fresh work')]);
    final i = inbox(fake, cache);
    await i.refresh();
    await settle();
    expect(await keptTitles(cache), contains('Fresh work'));

    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': <Object>[],
      'next': null,
    };
    await i.refresh();
    await settle();

    expect(await keptTitles(cache), isEmpty);
  });

  test('a Swarm a read refuses leaves the Home kept at once', () async {
    final cache = memoryHomeCache();
    await cache.write(me, [kept()]);
    final fake = backend();
    fake.routes['/api/super-tabs/a/parts'] = (_) => throw const SuperTabFailure(
      'FORBIDDEN',
      'You left this Swarm.',
      statusCode: 403,
    );
    final i = inbox(fake, cache);

    await i.refresh();
    await settle();

    expect(i.reader('a')!.snapshot, isNull);
    expect(await keptTitles(cache), isEmpty);
  });

  test('a Swarm read again in full takes what it no longer has out of the '
      'Home kept at once', () async {
    final cache = memoryHomeCache();
    final fake = backend(
      groups: [
        groupData('g-private', title: 'Pay review', audience: [me]),
      ],
    );
    final i = inbox(fake, cache);
    await i.refresh();
    await settle();
    expect(await keptTitles(cache), contains('Pay review'));

    // Taken out of the private chat: the Swarm is read again without it.
    fake.routes['/api/super-tabs/a/parts'] = (_) => firstLoad(tabId: 'a');
    fake.routes['/api/super-tabs/a/changes'] = (_) => {'reload': true};
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': 200},
      ],
      'next': null,
    };
    await i.refresh();
    await settle();

    expect(await keptTitles(cache), isNot(contains('Pay review')));
  });

  group('any other change', () {
    /// Swarm `a` read once, then renamed by its next change read.
    Future<SwarmInbox> renamed(SwarmHomeCache cache, Duration wait) async {
      final fake = backend(groups: [groupData('g2', title: 'Fresh work')]);
      final i = inbox(fake, cache, homeWait: wait)..shown = true;
      await until(() => i.reader('a')?.generation == 1);
      await settle();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': 200},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/a/changes'] = (_) => changes(
        cursor: 'c2',
        groups: [part('g2', 9, groupData('g2', title: 'Renamed work'))],
        lastChangedAt: 200,
      );
      await i.refresh();
      await settle();
      return i;
    }

    test('is kept when Harness goes behind', () async {
      final cache = memoryHomeCache();
      final i = await renamed(cache, const Duration(hours: 1));
      expect(await keptTitles(cache), isNot(contains('Renamed work')));

      i.shown = false;

      expect(await keptTitles(cache), contains('Renamed work'));
    });

    test('is kept at once once a while has passed since the last', () async {
      final cache = memoryHomeCache();

      await renamed(cache, Duration.zero);

      expect(await keptTitles(cache), contains('Renamed work'));
    });
  });

  test("another account's Home is never drawn", () async {
    final cache = memoryHomeCache();
    await cache.write('person-other', [kept()]);
    final i = inbox(backend(listed: Completer()), cache);

    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(i.swarms, isEmpty);
    expect(i.error, isNull);
  });
}
