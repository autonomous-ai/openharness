import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_activity.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// Activity, in place of Needs you (Tony's prototype C3): what the Swarms ask
/// of the person under Needs you and @, the threads they are in and the
/// reactions to what they wrote, each filter counted, and a row the person
/// acted on kept as handled.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const chatPath = activityChatPath;
  const backend = activityBackend;
  const message = activityMessage;
  const thread = activityThread;

  Future<SwarmSession> start(
    FakeSwarm fake, {
    MemoryKeyValueStore? store,
    Duration undoWindow = const Duration(milliseconds: 40),
  }) async {
    final session = SwarmSession(
      accountId: me,
      request: fake.request,
      notices: SilentSystemNotices(),
      undoWindow: undoWindow,
      readMarks: store ?? MemoryKeyValueStore(),
    );
    addTearDown(session.dispose);
    await session.inbox.refresh();
    await settle();
    return session;
  }

  List<String> keys(SwarmActivity activity, SwarmActivityFilter filter) => [
    for (final item in activity.items(filter)) item.key,
  ];

  int chatReads(FakeSwarm fake) =>
      fake.paths.where((p) => p.startsWith(chatPath)).length;

  group('Needs you and @', () {
    test('decisions and work waiting on the person, then the tags, each '
        'counted', () async {
      final session = await start(backend());
      final activity = session.activity;

      expect(keys(activity, SwarmActivityFilter.needsYou), [
        'decision:d1',
        'work:$tab:g1:attempt-g1:needs_human',
      ]);
      expect(keys(activity, SwarmActivityFilter.mentions), ['mention:m1']);
      expect(activity.count(SwarmActivityFilter.needsYou), 2);
      expect(activity.count(SwarmActivityFilter.mentions), 1);
      expect(activity.badge, 2, reason: "the tab's badge: what needs them");
    });

    test('Approve holds the recommended option for Undo, sends it, and keeps '
        'the row as handled once it is answered', () async {
      final fake = backend();
      final session = await start(fake);
      final activity = session.activity;
      final row = activity.items(SwarmActivityFilter.needsYou).first;

      activity.approve(row);
      expect(session.held(session.inbox.needs.first as dynamic), 1);
      expect(fake.commands, isEmpty, reason: 'held for Undo first');

      await until(() => fake.commands.isNotEmpty);
      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 1,
      });

      // Answered: the next read no longer has it.
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: {'decisionsWaiting': 0, 'mentionsWaiting': 1},
        lastChangedAt: 2,
      );
      await session.inbox.refresh();
      await settle();

      final handled = activity.items(SwarmActivityFilter.needsYou).last;
      expect(handled.key, 'decision:d1');
      expect(activity.handled(handled), 'Approved');
      expect(activity.count(SwarmActivityFilter.needsYou), 1);
    });

    test('an Approve undone leaves the row open and sends nothing', () async {
      final fake = backend();
      final session = await start(fake, undoWindow: const Duration(seconds: 5));
      final activity = session.activity;
      final row = activity.items(SwarmActivityFilter.needsYou).first;

      activity.approve(row);
      session.undo(session.inbox.needs.first as dynamic);
      await settle();

      expect(fake.commands, isEmpty);
      expect(activity.handled(row), isNull);
      expect(activity.count(SwarmActivityFilter.needsYou), 2);
    });

    test('only a decision can be approved', () async {
      final session = await start(backend());
      final activity = session.activity;
      final tag = activity.items(SwarmActivityFilter.mentions).single;

      expect(activity.canApprove(tag), isFalse);
      activity.approve(tag);
      await settle();
      expect(activity.handled(tag), isNull);
    });

    test('Reply marks a row handled at once, out of the count', () async {
      final session = await start(backend());
      final activity = session.activity;
      final work = activity.items(SwarmActivityFilter.needsYou).last;

      activity.replied(work);

      expect(activity.handled(work), 'Opened');
      expect(activity.count(SwarmActivityFilter.needsYou), 1);
      expect(
        activity.items(SwarmActivityFilter.needsYou).last.key,
        work.key,
        reason: 'handled rows go below the open ones',
      );
    });

    test(
      'a Swarm that leaves the list takes its rows, handled ones too',
      () async {
        final fake = backend();
        final session = await start(fake);
        final activity = session.activity;
        activity.replied(activity.items(SwarmActivityFilter.needsYou).last);

        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': <Object>[],
          'next': null,
        };
        fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
        await session.inbox.refresh();
        await settle();

        for (final filter in SwarmActivityFilter.values) {
          expect(activity.items(filter), isEmpty, reason: filter.label);
          expect(activity.count(filter), 0);
        }
      },
    );
  });

  group('Threads and Reactions', () {
    const page = activityPage;

    test('reads nothing until Activity is on screen, then each project chat '
        'once per counter', () async {
      final fake = backend(page: page);
      final session = await start(fake);
      final activity = session.activity;
      expect(chatReads(fake), 0);

      activity.watch();
      await settle();
      activity.unwatch();
      activity.watch();
      await session.inbox.refresh();
      await settle();

      expect(chatReads(fake), 1, reason: 'its counter did not move');
    });

    test(
      'a thread the person is in, with a reply since they read the chat',
      () async {
        final fake = backend(page: page);
        final session = await start(fake);
        final activity = session.activity..watch();
        await settle();

        // root-old's last reply is before the read mark; root-others is not theirs.
        expect(keys(activity, SwarmActivityFilter.threads), [
          'thread:$tab:root-1',
          'thread:$tab:root-old',
        ]);
        final open = activity.items(SwarmActivityFilter.threads).first;
        expect(activity.handled(open), isNull);
        expect(
          activity.handled(activity.items(SwarmActivityFilter.threads).last),
          'Read',
        );
        expect(activity.count(SwarmActivityFilter.threads), 1);
      },
    );

    test("a thread whose last reply is the person's own is not news", () async {
      final fake = backend(
        page: () => {
          ...page(),
          'threads': [thread('root-1', last: 12, lastByMe: true)],
        },
      );
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      expect(activity.count(SwarmActivityFilter.threads), 0);
    });

    test(
      "others' reactions to the person's own messages, never their own",
      () async {
        final store = MemoryKeyValueStore()
          // Not this phone's first Activity: nothing is taken as seen.
          ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
        final fake = backend(page: page);
        final session = await start(fake, store: store);
        final activity = session.activity..watch();
        await settle();

        final rows = activity.items(SwarmActivityFilter.reactions);
        expect([for (final r in rows) r.key], ['reaction:$tab:mine-2']);
        final reaction = rows.single as SwarmActivityReaction;
        expect(
          [for (final r in reaction.reactions) (r.emoji.glyph, r.by.length)],
          [('✅', 1)],
        );
        expect(activity.count(SwarmActivityFilter.reactions), 1);
      },
    );

    test('handled threads and reactions stay handled on this phone, until '
        'something new comes', () async {
      final store = MemoryKeyValueStore()
        ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
      var next = page();
      final fake = backend(page: () => next);
      final session = await start(fake, store: store);
      final activity = session.activity..watch();
      await settle();

      activity.replied(activity.items(SwarmActivityFilter.threads).first);
      activity.replied(activity.items(SwarmActivityFilter.reactions).single);
      await settle();
      expect(activity.count(SwarmActivityFilter.threads), 0);
      expect(activity.count(SwarmActivityFilter.reactions), 0);

      // Another phone session, the same marks.
      final again = await start(fake, store: store);
      again.activity.watch();
      await settle();
      expect(again.activity.count(SwarmActivityFilter.threads), 0);
      expect(again.activity.count(SwarmActivityFilter.reactions), 0);

      // A new reply and a new reaction: news again.
      next = {
        ...page(),
        'messages': [
          for (final m in page()['messages'] as List)
            if ((m as Map)['id'] == 'mine-2')
              message(
                'mine-2',
                5,
                mine: true,
                reactions: [
                  {
                    'emoji': 'check',
                    'by': [
                      {'kind': 'agent', 'id': 'agent-lead'},
                      {'kind': 'agent', 'id': 'agent-builder'},
                    ],
                  },
                ],
              )
            else
              m,
        ],
        'threads': [thread('root-1', last: 14)],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: {'decisionsWaiting': 1, 'mentionsWaiting': 1},
        lastChangedAt: 2,
        groups: [
          part(
            leadChat,
            9,
            groupData(
              leadChat,
              title: 'Mobile',
              agentIds: ['agent-lead'],
              leadId: 'agent-lead',
              lastMessageSequence: 14,
            ),
          ),
        ],
      );
      await again.inbox.refresh();
      await settle();
      expect(again.activity.count(SwarmActivityFilter.threads), 1);
      expect(again.activity.count(SwarmActivityFilter.reactions), 1);
    });

    test("this phone's first Activity takes the reactions already there as "
        'seen', () async {
      final fake = backend(page: page);
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      expect(activity.items(SwarmActivityFilter.reactions), hasLength(1));
      expect(activity.count(SwarmActivityFilter.reactions), 0);
    });

    test('a Swarm that leaves the list takes its marks, and what was read of '
        'its chats, off the phone', () async {
      final store = MemoryKeyValueStore()
        ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
      final fake = backend(page: page);
      final session = await start(fake, store: store);
      final activity = session.activity..watch();
      await settle();
      activity.replied(activity.items(SwarmActivityFilter.threads).first);
      await settle();
      expect(store.values['swarm_activity.$me.$tab'], contains('root-1'));
      expect(session.peeks.held, 1);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
      await session.inbox.refresh();
      await settle();

      expect(store.values.containsKey('swarm_activity.$me.$tab'), isFalse);
      expect(activity.items(SwarmActivityFilter.threads), isEmpty);
      expect(session.peeks.held, 0, reason: 'no row of it left in memory');
    });

    test('a chat that cannot be read says so, and leaves the rest', () async {
      final fake = backend();
      fake.routes[chatPath] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      expect(activity.unreadChats, isTrue);
      expect(activity.count(SwarmActivityFilter.needsYou), 2);
      expect(activity.items(SwarmActivityFilter.threads), isEmpty);
    });

    test(
      'reads while any screen shows it: the tab, and the page over Home',
      () async {
        final fake = backend(page: page);
        final session = await start(fake);
        final activity = session.activity
          ..watch()
          ..watch()
          ..unwatch();
        await settle();
        expect(activity.shown, isTrue);
        expect(chatReads(fake), 1);

        activity.unwatch();
        expect(activity.shown, isFalse);
      },
    );

    test('says it is reading the project chats until they answer', () async {
      final fake = backend();
      final gate = Completer<void>();
      fake.routes[chatPath] = (_) async {
        await gate.future;
        return {'messages': <Object>[], 'next': null};
      };
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();
      expect(activity.reading, isTrue);

      gate.complete();
      await settle();
      expect(activity.reading, isFalse);
    });

    test('Try again reads a project chat that failed', () async {
      final fake = backend();
      fake.routes[chatPath] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();
      expect(activity.unreadChats, isTrue);

      fake.routes[chatPath] = (_) => page();
      activity.retry();
      await settle();

      expect(activity.unreadChats, isFalse);
      expect(activity.items(SwarmActivityFilter.threads), isNotEmpty);
    });

    test(
      'a chat the person may not read is skipped with nothing said',
      () async {
        final fake = backend();
        fake.routes[chatPath] = (_) =>
            throw const SuperTabFailure('FORBIDDEN', 'Not yours.');
        final session = await start(fake);
        final activity = session.activity..watch();
        await settle();

        expect(activity.unreadChats, isFalse);
        expect(activity.items(SwarmActivityFilter.threads), isEmpty);
      },
    );

    test('reads only project chats: never a Buddy chat, a private chat or a '
        'task chat, however they moved', () async {
      final fake = backend(
        page: page,
        groups: [
          buddyChatData('buddy-me', lastMessageSequence: 4),
          buddyChatData(
            'buddy-theirs',
            owner: 'person-other',
            lastMessageSequence: 4,
          ),
          groupData('g-private', audience: [me], lastMessageSequence: 3),
          groupData('g-task', title: 'Task', lastMessageSequence: 9),
        ],
      );
      final session = await start(fake);
      session.activity.watch();
      await settle();

      expect(
        [
          for (final path in fake.paths)
            if (path.contains('/messages')) path,
        ],
        [chatPath],
      );
    });

    test('access lost while a project chat is being read: its answer is '
        'dropped, and nothing of the Swarm is left', () async {
      final fake = backend();
      final gate = Completer<void>();
      fake.routes[chatPath] = (_) async {
        await gate.future;
        return page();
      };
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();
      expect(activity.reading, isTrue);

      session.inbox.reader(tab)!.revoke();
      gate.complete();
      await settle();

      for (final filter in SwarmActivityFilter.values) {
        expect(activity.items(filter), isEmpty, reason: filter.label);
      }
      expect(activity.reading, isFalse);
      expect(activity.unreadChats, isFalse);
      expect(session.peeks.held, 0);
    });

    test('the same chat and agent ids in two Swarms: each read on its own, '
        'its rows under its own Swarm', () async {
      final fake = backend(page: page);
      activitySecondSwarm(fake, page: page);
      final session = await start(fake);
      final activity = session.activity..watch();
      await settle();

      expect(
        [
          for (final path in fake.paths)
            if (path.contains('/messages')) path,
        ]..sort(),
        [chatPath, '/api/super-tabs/tab-2/conversations/$leadChat/messages'],
      );
      expect(keys(activity, SwarmActivityFilter.threads)..sort(), [
        'thread:$tab:root-1',
        'thread:$tab:root-old',
        'thread:tab-2:root-1',
        'thread:tab-2:root-old',
      ]);
      activity.replied(
        activity
            .items(SwarmActivityFilter.threads)
            .firstWhere((item) => item.key == 'thread:tab-2:root-1'),
      );
      expect(
        activity.handled(
          activity
              .items(SwarmActivityFilter.threads)
              .firstWhere((item) => item.key == 'thread:$tab:root-1'),
        ),
        isNull,
        reason: "a thread opened in one Swarm is not the other's",
      );
    });
  });
}
