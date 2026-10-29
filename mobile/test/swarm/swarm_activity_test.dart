import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/swarm/swarm_activity.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// Activity, in place of Needs you (Tony's prototype C3): what the Swarms ask
/// of the person under Needs you and @, the threads they are in and the
/// reactions to what they wrote, each filter counted, and a row the person
/// acted on kept as handled.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const chatPath = '/api/super-tabs/$tab/conversations/$leadChat/messages';

  Map<String, dynamic> message(
    String id,
    int sequence, {
    String text = '',
    bool mine = false,
    String? thread,
    List<Map<String, dynamic>> reactions = const [],
  }) => {
    'id': id,
    'conversationId': leadChat,
    'text': text.isEmpty ? 'Row $id' : text,
    'sequence': sequence,
    'thread': thread ?? id,
    'author': mine
        ? {'kind': 'person', 'id': me, 'name': 'tony@example.com'}
        : {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
    'reactions': reactions,
    'createdAt': DateTime.utc(2026, 10, 29, 8, sequence).toIso8601String(),
  };

  Map<String, dynamic> thread(
    String root, {
    required int last,
    List<String> people = const [me],
    bool lastByMe = false,
  }) => {
    'id': root,
    'replies': 2,
    'lastSequence': last,
    'lastAt': DateTime.utc(2026, 10, 29, 9, last).toIso8601String(),
    'authors': [
      lastByMe
          ? {'kind': 'person', 'id': me, 'name': 'tony@example.com'}
          : {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
    ],
    'people': people,
  };

  /// One Swarm, project Mobile: decision d1 (recommending "Merge"), River's
  /// tag m1, work g1 waiting on the person, and a project chat whose newest
  /// page [page] answers. The server's read mark of that chat is [readMark].
  FakeSwarm backend({
    Map<String, dynamic> Function()? page,
    int readMark = 10,
    int chatSequence = 12,
    bool decision = true,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me, 'lastChangedAt': 1},
      ],
      'next': null,
    };
    final derived = {
      'decisionsWaiting': decision ? 1 : 0,
      'mentionsWaiting': 1,
      'readMarks': {leadChat: readMark},
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final load = firstLoad(
        derived: derived,
        lastChangedAt: 1,
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            status: 'needs_human',
            workerId: 'agent-builder',
          ),
        ],
      );
      // The project chat holds [chatSequence] rows.
      final lead = (load['groups'] as List).first as Map<String, dynamic>;
      (lead['data'] as Map<String, dynamic>)['lastMessageSequence'] =
          chatSequence;
      return load;
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived, lastChangedAt: 1);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        if (decision)
          {
            'id': 'd1',
            'projectName': 'Mobile',
            'conversationId': 'g1',
            'conversationTitle': 'Fix login',
            'askerName': 'River',
            'question': 'Approve merge: PR #2154?',
            'options': ['Wait', 'Merge'],
            'recommended': 1,
          },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': leadChat,
          'conversationTitle': 'Mobile',
          'messageId': 'msg-tag',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    fake.routes[chatPath] = (_) =>
        page?.call() ?? {'messages': <Object>[], 'next': null};
    return fake;
  }

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
    Map<String, dynamic> page() => {
      'messages': [
        message('root-1', 3, text: 'Ship the build tonight?', mine: true),
        message(
          'mine-2',
          5,
          text: 'Copy is fixed.',
          mine: true,
          reactions: [
            {
              'emoji': 'check',
              'by': [
                {'kind': 'agent', 'id': 'agent-lead'},
                {'kind': 'person', 'id': me},
              ],
            },
          ],
        ),
        message(
          'own-only',
          6,
          mine: true,
          reactions: [
            {
              'emoji': 'eyes',
              'by': [
                {'kind': 'person', 'id': me},
              ],
            },
          ],
        ),
        message('root-old', 7),
        message('root-others', 8),
      ],
      'threads': [
        thread('root-1', last: 12),
        thread('root-old', last: 9),
        thread('root-others', last: 12, people: ['person-other']),
      ],
      'next': null,
    };

    test('reads nothing until Activity is on screen, then each project chat '
        'once per counter', () async {
      final fake = backend(page: page);
      final session = await start(fake);
      final activity = session.activity;
      expect(chatReads(fake), 0);

      activity.shown = true;
      await settle();
      activity.shown = false;
      activity.shown = true;
      await session.inbox.refresh();
      await settle();

      expect(chatReads(fake), 1, reason: 'its counter did not move');
    });

    test(
      'a thread the person is in, with a reply since they read the chat',
      () async {
        final fake = backend(page: page);
        final session = await start(fake);
        final activity = session.activity..shown = true;
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
      final activity = session.activity..shown = true;
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
        final activity = session.activity..shown = true;
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
      final activity = session.activity..shown = true;
      await settle();

      activity.replied(activity.items(SwarmActivityFilter.threads).first);
      activity.replied(activity.items(SwarmActivityFilter.reactions).single);
      await settle();
      expect(activity.count(SwarmActivityFilter.threads), 0);
      expect(activity.count(SwarmActivityFilter.reactions), 0);

      // Another phone session, the same marks.
      final again = await start(fake, store: store);
      again.activity.shown = true;
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
      final activity = session.activity..shown = true;
      await settle();

      expect(activity.items(SwarmActivityFilter.reactions), hasLength(1));
      expect(activity.count(SwarmActivityFilter.reactions), 0);
    });

    test(
      'a Swarm that leaves the list takes its marks off the phone',
      () async {
        final store = MemoryKeyValueStore()
          ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
        final fake = backend(page: page);
        final session = await start(fake, store: store);
        final activity = session.activity..shown = true;
        await settle();
        activity.replied(activity.items(SwarmActivityFilter.threads).first);
        await settle();
        expect(store.values['swarm_activity.$me.$tab'], contains('root-1'));

        fake.routes['/api/super-tabs/list'] = (_) => {
          'tabs': <Object>[],
          'next': null,
        };
        fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
        await session.inbox.refresh();
        await settle();

        expect(store.values.containsKey('swarm_activity.$me.$tab'), isFalse);
        expect(activity.items(SwarmActivityFilter.threads), isEmpty);
      },
    );

    test('a chat that cannot be read says so, and leaves the rest', () async {
      final fake = backend();
      fake.routes[chatPath] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final session = await start(fake);
      final activity = session.activity..shown = true;
      await settle();

      expect(activity.unreadChats, isTrue);
      expect(activity.count(SwarmActivityFilter.needsYou), 2);
      expect(activity.items(SwarmActivityFilter.threads), isEmpty);
    });

    test(
      'a chat the person may not read is skipped with nothing said',
      () async {
        final fake = backend();
        fake.routes[chatPath] = (_) =>
            throw const SuperTabFailure('FORBIDDEN', 'Not yours.');
        final session = await start(fake);
        final activity = session.activity..shown = true;
        await settle();

        expect(activity.unreadChats, isFalse);
        expect(activity.items(SwarmActivityFilter.threads), isEmpty);
      },
    );
  });
}
