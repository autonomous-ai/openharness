import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/swarm/swarm_buddy.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_prefs.dart';
import 'package:harness_mobile/swarm/swarm_home_view.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_new_message_sheet.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_tabs.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The Buddy tab (Tony, 11-02): the person's one Buddy chat, opened at once,
/// in the state Desktop shows; their older chats read only from its ⋮.
void main() {
  const one = 'buddy-one';
  const oldMobile = 'buddy-old-mobile';
  const oldWeb = 'buddy-old-web';
  const other = 'swarm-2';
  const web = 'project-web';
  String commands(String swarm) => '/api/super-tabs/$swarm/commands';
  String messages(String chat, {String swarm = tab}) =>
      '/api/super-tabs/$swarm/conversations/$chat/messages';

  Map<String, dynamic> oneChat({
    String id = one,
    String owner = me,
    int last = 1,
  }) => {
    ...groupData(
      id,
      title: "$owner's Buddy",
      agentIds: const ['agent-wren'],
      lastMessageSequence: last,
    ),
    'kind': 'swarm-buddy',
    'buddyOwnerId': owner,
  }..remove('projectId');

  Map<String, dynamic> wren({String owner = me, String? downSince}) => {
    ...buddyData('agent-wren', owner: owner, displayName: 'Wren'),
    'buddyScope': 'swarm',
    'downSince': ?downSince,
  }..remove('projectId');

  Map<String, dynamic> webProject() => {
    'id': web,
    'name': 'Web',
    'ownerId': me,
    'leadConversationId': 'lead-web',
    'visibility': 'public',
    'members': <Object>[],
    'updateMinutes': 5,
  };

  Map<String, dynamic> line(String chat, int sequence, String text) => {
    'id': '$chat-$sequence',
    'conversationId': chat,
    'text': text,
    'sequence': sequence,
    'author': {'kind': 'agent', 'id': 'agent-wren', 'name': 'Wren'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 2, 1, sequence).toIso8601String(),
  };

  /// [swarm] of [fake]: one Buddy chat [chats] and agents [agents], over the
  /// projects Mobile (and Web) with the server's one Buddy on unless [flag] is
  /// off.
  void route(
    FakeSwarm fake, {
    String swarm = tab,
    List<Map<String, dynamic>> chats = const [],
    List<Map<String, dynamic>> agents = const [],
    List<Map<String, dynamic>> starts = const [],
    String role = 'owner',
    bool flag = true,
  }) {
    final derived = {'swarmBuddy': ?(flag ? true : null)};
    fake.routes['/api/super-tabs/$swarm/parts'] = (_) => {
      ...firstLoad(
        tabId: swarm,
        head: headData(
          id: swarm,
          projects: [
            ...(headData()['projects'] as List).cast<Map<String, dynamic>>(),
            webProject(),
          ],
        ),
        groups: [
          for (final chat in chats) chat,
          {...groupData('lead-web', title: 'Web'), 'projectId': web},
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          ...agents,
        ],
        starts: starts,
        derived: derived,
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes['/api/super-tabs/$swarm/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$swarm/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$swarm/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[commands(swarm)] = (_) => {'result': <String, dynamic>{}};
  }

  void listed(FakeSwarm fake, List<String> swarms) =>
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          for (final swarm in swarms)
            {'id': swarm, 'name': 'Swarm $swarm', 'ownerId': me},
        ],
        'next': null,
      };

  FakeSwarm backend({
    List<Map<String, dynamic>>? chats,
    List<Map<String, dynamic>>? agents,
    List<Map<String, dynamic>> starts = const [],
    String role = 'owner',
    bool flag = true,
  }) {
    final fake = FakeSwarm();
    listed(fake, [tab]);
    route(
      fake,
      chats: chats ?? [oneChat()],
      agents: agents ?? [wren()],
      starts: starts,
      role: role,
      flag: flag,
    );
    fake.routes[messages(one)] = (_) => {
      'messages': [line(one, 1, 'Hello from the one Buddy')],
      'next': null,
    };
    return fake;
  }

  Map<String, dynamic> oldChat(String id, {String? projectId, int last = 2}) =>
      {
        ...buddyChatData(id, lastMessageSequence: last),
        'projectId': projectId ?? project,
      };

  late ValueNotifier<String?> account;

  /// Long enough for a sheet or page to finish moving; a skeleton shown while
  /// something is out never settles, so this does not wait for that.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmTabsPage(),
      ),
    );
    await settle(tester);
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> openTab(WidgetTester tester) async {
    await tester.tap(key('swarm-tab-buddy'));
    await settle(tester);
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(key('swarm-buddy-menu'));
    await settle(tester);
  }

  Iterable<Map<String, dynamic>> sent(FakeSwarm fake, String type) => [
    for (final call in fake.calls)
      if (call.path.endsWith('/commands') &&
          (call.body?['command'] as Map?)?['type'] == type)
        Map<String, dynamic>.from(call.body!['command'] as Map),
  ];

  group('with the Buddy running on Desktop', () {
    testWidgets('the tab is lit, named Buddy, and its chat opens at once, with '
        'no project list and no way back', (tester) async {
      await pump(tester, backend());

      expect(key('swarm-tab-mark-buddy'), findsOneWidget);
      expect(
        tester.getSemantics(key('swarm-tab-buddy')).label,
        contains('running'),
      );
      await openTab(tester);

      expect(find.text('Hello from the one Buddy'), findsOneWidget);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Wren');
      expect(key('swarm-buddy-dot'), findsOneWidget);
      expect(key('tty-back'), findsNothing);
      expect(key('swarm-buddy-start'), findsNothing);
      expect(find.text('not started'), findsNothing);
    });

    testWidgets('a post goes to the one chat, saying the app knows one Buddy, '
        'as the desktop does', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await openTab(tester);

      await tester.enterText(find.byType(TextField), 'Are you there?');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await settle(tester);

      final post = sent(fake, 'message.send').single;
      expect(post['conversationId'], one);
      expect(post['oneBuddy'], isTrue);
    });

    testWidgets('a down Buddy dims the tab: offline with Start again', (
      tester,
    ) async {
      await pump(
        tester,
        backend(agents: [wren(downSince: '2026-11-02T01:00:00.000Z')]),
      );
      expect(
        tester.getSemantics(key('swarm-tab-buddy')).label,
        contains('offline'),
      );
      await openTab(tester);
      expect(key('swarm-buddy-offline'), findsOneWidget);
    });

    test(
      'someone else\'s Buddy, or a thread session, is never the person\'s',
      () {
        final buddies = SwarmBuddies.read({
          'agents': [
            wren(owner: 'person-ann'),
            {
              ...wren(),
              'id': 'agent-session',
              'buddySession': {'thread': 't1'},
            },
          ],
          'conversations': [oneChat(owner: 'person-ann', id: 'ann-chat')],
        }, me);
        expect(buddies.ownBuddies, isEmpty);
        expect(buddies.ownChats, isEmpty);
        expect(buddies.buddyOwners.keys, ['agent-wren', 'agent-session']);
        expect(buddies.chatOwners, {'ann-chat': 'person-ann'});
      },
    );
  });

  group('with no Buddy yet', () {
    testWidgets('the tab is not lit, and Start starts the one Buddy from the '
        'phone, naming no project', (tester) async {
      final fake = backend(agents: const []);
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [oneChat()],
          machines: [
            {
              'machineId': 'mac-1',
              'name': "Tony's Mac",
              'contributorId': me,
              'engines': ['claude'],
              'observation': {
                'receivedAt': DateTime.now().millisecondsSinceEpoch,
              },
            },
          ],
          derived: const {'swarmBuddy': true},
        ),
      };
      await pump(tester, fake);
      expect(key('swarm-tab-mark-buddy'), findsNothing);
      await openTab(tester);

      await tester.tap(key('swarm-buddy-start-button'));
      await settle(tester);

      final start = sent(fake, 'buddy.create').single;
      expect(start.containsKey('projectId'), isFalse);
      expect(start['machineId'], 'mac-1');
    });

    testWidgets('a start under way, made with no project, shows Starting', (
      tester,
    ) async {
      await pump(
        tester,
        backend(
          agents: const [],
          starts: [
            {
              'id': 's1',
              'request': {
                'buddyOf': {'personId': me},
                'buddyScope': 'swarm',
                'machineId': 'mac-1',
                'engine': 'claude',
              },
            },
          ],
        ),
      );
      await openTab(tester);
      expect(key('swarm-buddy-starting'), findsOneWidget);
    });

    testWidgets('with no chat read, it opens one on the server once, as the '
        'desktop asks for it', (tester) async {
      final fake = backend(chats: const [], agents: const []);
      fake.routes[commands(tab)] = (_) => {
        'result': {'conversationId': one},
      };
      await pump(tester, fake);
      await openTab(tester);

      final asked = sent(fake, 'buddy.chat');
      expect(asked, hasLength(1));
      expect(asked.single.containsKey('projectId'), isFalse);
      expect(fake.paths, contains(messages(one)));
    });

    testWidgets('a refused open says why, stops loading, asks once, and Try '
        'again asks again', (tester) async {
      final fake = backend(chats: const [], agents: const []);
      var refuse = true;
      fake.routes[commands(tab)] = (_) {
        if (refuse) throw const SuperTabFailure('DOWN', 'Server is down.');
        // Opened: the Swarm's next read holds it.
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
          cursor: 'c3',
          groups: [part(one, 30, oneChat())],
          derived: const {'swarmBuddy': true},
        );
        return {
          'result': {'conversationId': one},
        };
      };
      await pump(tester, fake);
      await openTab(tester);

      expect(find.text('Server is down.'), findsOneWidget);
      expect(key('swarm-buddy-loading'), findsNothing);
      expect(sent(fake, 'buddy.chat'), hasLength(1));

      refuse = false;
      await tester.tap(key('swarm-buddy-retry-open'));
      await settle(tester);

      expect(sent(fake, 'buddy.chat'), hasLength(2));
      expect(find.text('Hello from the one Buddy'), findsOneWidget);
    });

    testWidgets('a viewer with none is told so, and nothing is asked', (
      tester,
    ) async {
      final fake = backend(chats: const [], agents: const [], role: 'viewer');
      await pump(tester, fake);
      await openTab(tester);
      expect(find.text('You have no Buddy in this Swarm.'), findsOneWidget);
      expect(sent(fake, 'buddy.chat'), isEmpty);
    });
  });

  group('Old chats', () {
    FakeSwarm withOld() {
      final fake = backend(
        chats: [
          oneChat(),
          oldChat(oldMobile),
          // Nothing in it: no history to keep.
          oldChat(oldWeb, projectId: web, last: 0),
          // Someone else's: never listed.
          {
            ...buddyChatData(
              'old-ann',
              owner: 'person-ann',
              lastMessageSequence: 3,
            ),
            'projectId': project,
          },
        ],
      );
      fake.routes[messages(oldMobile)] = (_) => {
        'messages': [line(oldMobile, 2, 'From before the one Buddy')],
        'next': null,
      };
      return fake;
    }

    Future<void> openOld(WidgetTester tester) async {
      await openMenu(tester);
      await tester.tap(find.text('Old chats'));
      await settle(tester);
      await tester.tap(find.text('Mobile'));
      await settle(tester);
    }

    testWidgets('list each project with history; one opens read only, with no '
        'composer, Buddy bar or menu of its Buddy', (tester) async {
      final fake = withOld();
      await pump(tester, fake);
      await openTab(tester);
      await openMenu(tester);
      await tester.tap(find.text('Old chats'));
      await settle(tester);
      expect(find.text('Mobile'), findsOneWidget);
      expect(find.text('Web'), findsNothing);
      await tester.tap(find.text('Mobile'));
      await settle(tester);

      expect(find.text('From before the one Buddy'), findsOneWidget);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Old chat');
      expect(key('swarm-old-chat'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(key('swarm-buddy-bar'), findsNothing);
      expect(key('swarm-buddy-menu'), findsNothing);
      expect(key('tty-back'), findsOneWidget);
    });

    testWidgets('sending there is blocked: nothing reaches the server', (
      tester,
    ) async {
      final fake = withOld();
      final host = await pump(tester, fake);
      await openTab(tester);
      await openOld(tester);

      expect(find.byType(TextField), findsNothing);
      expect(key('swarm-send'), findsNothing);
      // A tap on the line offers no reply or reaction.
      await tester.tap(find.text('From before the one Buddy'));
      await settle(tester);
      expect(key('swarm-reply-$oldMobile-2'), findsNothing);
      expect(sent(fake, 'message.send'), isEmpty);
      expect(sent(fake, 'message.react'), isEmpty);
      expect(
        swarmIsOldBuddyChat(host.session!.inbox.reader(tab)!, oldMobile),
        isTrue,
      );
    });

    testWidgets('Open Buddy leads back to the one chat', (tester) async {
      await pump(tester, withOld());
      await openTab(tester);
      await openOld(tester);
      await tester.tap(key('swarm-old-chat-open-buddy'));
      await settle(tester);
      expect(find.text('Hello from the one Buddy'), findsOneWidget);
      expect(key('swarm-old-chat'), findsNothing);
      // The tab itself, not a second page of its chat over it.
      expect(key('swarm-tab-buddy'), findsOneWidget);
      expect(key('tty-back'), findsNothing);
    });

    testWidgets('an old chat\'s ⋮ is titled Old chat, not its stored title', (
      tester,
    ) async {
      await pump(tester, withOld());
      await openTab(tester);
      await openOld(tester);
      await tester.tap(key('swarm-chat-menu'));
      await settle(tester);
      expect(find.text("$me's Buddy"), findsNothing);
    });

    testWidgets('a project the person no longer reads drops off', (
      tester,
    ) async {
      final fake = backend(
        chats: [
          oneChat(),
          oldChat(oldWeb, projectId: 'project-gone'),
        ],
      );
      await pump(tester, fake);
      await openTab(tester);
      await openMenu(tester);
      expect(find.text('Old chats'), findsNothing);
    });

    testWidgets('the sheet closes when access goes while it is open', (
      tester,
    ) async {
      final host = await pump(tester, withOld());
      await openTab(tester);
      await openMenu(tester);
      await tester.tap(find.text('Old chats'));
      await settle(tester);
      expect(find.text('Mobile'), findsOneWidget);
      expect(find.text('Old chats'), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await settle(tester);

      expect(find.text('Mobile'), findsNothing);
      expect(find.text('Old chats'), findsNothing, reason: 'the sheet is gone');
    });

    testWidgets('where the server gives no one Buddy, a Buddy chat stays as '
        'it was', (tester) async {
      final host = await pump(
        tester,
        backend(chats: [oldChat(oldMobile)], flag: false),
      );
      await openTab(tester);
      final reader = host.session!.inbox.reader(tab)!;
      expect(swarmIsOldBuddyChat(reader, oldMobile), isFalse);
      expect(swarmOldBuddyChats(reader), isEmpty);
      expect(key('swarm-buddy-note'), findsOneWidget);
    });

    testWidgets('New message offers no old chat to write in', (tester) async {
      final host = await pump(tester, withOld());
      final chats = swarmNewMessageChats(
        host.session!.inbox,
        host.session!.inbox.swarms,
      ).chats;
      expect(chats.where((c) => c.chatId == oldMobile), isEmpty);
    });
  });

  group('with several Swarms', () {
    FakeSwarm two({int? mineMoved, int? otherMoved}) {
      final fake = FakeSwarm();
      listed(fake, [tab, other]);
      route(fake, chats: [oneChat()], agents: [wren()]);
      route(
        fake,
        swarm: other,
        chats: [oneChat(id: 'buddy-two')],
      );

      /// When each chat last moved is its part's own time, as the server says.
      void moved(String swarm, String chat, int? at) {
        final load = fake.routes['/api/super-tabs/$swarm/parts']!;
        fake.routes['/api/super-tabs/$swarm/parts'] = (body) async {
          final first = Map<String, dynamic>.of(
            await load(body) as Map<String, dynamic>,
          );
          first['groups'] = [
            for (final row in first['groups'] as List)
              {
                ...row as Map<String, dynamic>,
                if (row['key'] == chat) 'changedAt': ?at,
              },
          ];
          return first;
        };
      }

      moved(tab, one, mineMoved);
      moved(other, 'buddy-two', otherMoved);
      fake.routes[messages(one)] = (_) => {
        'messages': [line(one, 1, 'In the first Swarm')],
        'next': null,
      };
      fake.routes[messages('buddy-two', swarm: other)] = (_) => {
        'messages': [line('buddy-two', 1, 'In the second Swarm')],
        'next': null,
      };
      return fake;
    }

    testWidgets('opens the one whose Buddy chat moved last, and switches from '
        'the ⋮, kept for next time', (tester) async {
      final host = await pump(tester, two(mineMoved: 10, otherMoved: 20));
      await openTab(tester);
      expect(find.text('In the second Swarm'), findsOneWidget);
      expect(key('swarm-tab-mark-buddy'), findsNothing);

      await openMenu(tester);
      await tester.tap(find.text('Swarm'));
      await settle(tester);
      await tester.tap(find.text('Swarm $tab'));
      await settle(tester);

      expect(find.text('In the first Swarm'), findsOneWidget);
      expect(find.text('In the second Swarm'), findsNothing);
      expect(key('swarm-tab-mark-buddy'), findsOneWidget);
      expect(host.session!.home.buddySwarmId, tab);
    });

    testWidgets('a chat moving elsewhere does not take the tab there', (
      tester,
    ) async {
      final fake = two(mineMoved: 20, otherMoved: 10);
      final host = await pump(tester, fake);
      await openTab(tester);
      expect(find.text('In the first Swarm'), findsOneWidget);

      fake.routes['/api/super-tabs/$other/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [part('buddy-two', 30, oneChat(id: 'buddy-two'))],
        derived: const {'swarmBuddy': true},
      );
      await host.session!.inbox.reader(other)!.refresh();
      await settle(tester);

      expect(find.text('In the first Swarm'), findsOneWidget);
    });

    testWidgets('the Swarm sheet says which Swarm is shown', (tester) async {
      await pump(tester, two(mineMoved: 20, otherMoved: 10));
      await openTab(tester);
      await openMenu(tester);
      await tester.tap(find.text('Swarm'));
      await settle(tester);
      expect(find.text('current'), findsOneWidget);
    });

    testWidgets('with no choice kept, it waits for every Swarm before picking: '
        'nothing opens in the first listed', (tester) async {
      final fake = FakeSwarm();
      listed(fake, [tab, other]);
      route(fake);
      route(
        fake,
        swarm: other,
        chats: [oneChat(id: 'buddy-two')],
      );
      fake.routes[messages('buddy-two', swarm: other)] = (_) => {
        'messages': [line('buddy-two', 1, 'In the second Swarm')],
        'next': null,
      };
      final load = fake.routes['/api/super-tabs/$other/parts']!;
      final slow = Completer<void>();
      fake.routes['/api/super-tabs/$other/parts'] = (body) async {
        await slow.future;
        return load(body);
      };
      await pump(tester, fake);
      await openTab(tester);
      expect(sent(fake, 'buddy.chat'), isEmpty);
      expect(key('swarm-buddy-loading'), findsOneWidget);

      slow.complete();
      await settle(tester);

      expect(sent(fake, 'buddy.chat'), isEmpty);
      expect(find.text('In the second Swarm'), findsOneWidget);
    });

    testWidgets('with one Swarm there is no Swarm row', (tester) async {
      await pump(tester, backend());
      await openTab(tester);
      await openMenu(tester);
      expect(find.text('Swarm'), findsNothing);
    });

    testWidgets('losing the Swarm shown moves to the other, and nothing of it '
        'stays', (tester) async {
      final host = await pump(tester, two(mineMoved: 20, otherMoved: 10));
      await openTab(tester);
      expect(find.text('In the first Swarm'), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await settle(tester);

      expect(find.text('In the first Swarm'), findsNothing);
      expect(find.text('In the second Swarm'), findsOneWidget);
      expect(key('swarm-tab-mark-buddy'), findsNothing);
    });

    testWidgets('an open that answers after the person switched away changes '
        'nothing', (tester) async {
      final fake = FakeSwarm();
      listed(fake, [tab, other]);
      route(fake);
      route(
        fake,
        swarm: other,
        chats: [oneChat(id: 'buddy-two')],
      );
      fake.routes[messages('buddy-two', swarm: other)] = (_) => {
        'messages': [line('buddy-two', 1, 'In the second Swarm')],
        'next': null,
      };
      final answer = Completer<Object?>();
      fake.routes[commands(tab)] = (_) => answer.future;
      final host = await pump(tester, fake);
      host.session!.home.showBuddy(tab);
      await settle(tester);
      await openTab(tester);
      expect(sent(fake, 'buddy.chat'), hasLength(1));

      host.session!.home.showBuddy(other);
      await settle(tester);
      expect(find.text('In the second Swarm'), findsOneWidget);

      answer.complete({
        'result': {'conversationId': one},
      });
      await settle(tester);

      expect(find.text('In the second Swarm'), findsOneWidget);
      expect(fake.paths, isNot(contains(messages(one))));
    });
  });

  group('stale answers', () {
    testWidgets('an open answering once another Swarm asked for its own opens '
        'nothing there, and that Swarm is asked once', (tester) async {
      final fake = FakeSwarm();
      listed(fake, [tab, other]);
      route(fake);
      route(fake, swarm: other);
      final first = Completer<Object?>(), second = Completer<Object?>();
      fake.routes[commands(tab)] = (_) => first.future;
      fake.routes[commands(other)] = (_) => second.future;
      int asked(String swarm) => [
        for (final call in fake.calls)
          if (call.path == commands(swarm) &&
              (call.body?['command'] as Map?)?['type'] == 'buddy.chat')
            call,
      ].length;
      final host = await pump(tester, fake);
      host.session!.home.showBuddy(tab);
      await openTab(tester);
      expect(asked(tab), 1);

      host.session!.home.showBuddy(other);
      await settle(tester);
      expect(asked(other), 1);

      first.complete({
        'result': {'conversationId': one},
      });
      await settle(tester);

      expect(fake.paths, isNot(contains(messages(one))));
      expect(asked(other), 1);
      expect(key('swarm-buddy-loading'), findsOneWidget);
      second.complete({'result': <String, dynamic>{}});
      await settle(tester);
    });
  });

  group('an opened chat stays with its Swarm', () {
    testWidgets('another Swarm with none never opens it', (tester) async {
      final fake = FakeSwarm();
      listed(fake, [tab, other]);
      route(fake);
      route(fake, swarm: other);
      fake.routes[commands(tab)] = (_) => {
        'result': {'conversationId': one},
      };
      fake.routes[messages(one)] = (_) => {
        'messages': [line(one, 1, 'In the first Swarm')],
        'next': null,
      };
      final hold = Completer<Object?>();
      fake.routes[commands(other)] = (_) => hold.future;
      final host = await pump(tester, fake);
      host.session!.home.showBuddy(tab);
      await openTab(tester);
      expect(fake.paths, contains(messages(one)));

      host.session!.home.showBuddy(other);
      await settle(tester);

      expect(fake.paths, isNot(contains(messages(one, swarm: other))));
      hold.complete({'result': <String, dynamic>{}});
      await settle(tester);
    });
  });

  group('when access goes', () {
    testWidgets('while the chat is open: it closes, the dot goes, nothing of '
        'it stays', (tester) async {
      final host = await pump(tester, backend());
      await openTab(tester);
      expect(find.text('Hello from the one Buddy'), findsOneWidget);

      host.session!.inbox.reader(tab)!.revoke();
      await settle(tester);

      expect(find.text('Hello from the one Buddy'), findsNothing);
      expect(find.text('Wren'), findsNothing);
      expect(key('swarm-tab-mark-buddy'), findsNothing);
      expect(key('swarm-tab-badge-buddy'), findsNothing);
    });

    testWidgets('while an open is out: its answer is dropped', (tester) async {
      final fake = backend(chats: const [], agents: const []);
      final answer = Completer<Object?>();
      fake.routes[commands(tab)] = (_) => answer.future;
      final host = await pump(tester, fake);
      await openTab(tester);
      expect(sent(fake, 'buddy.chat'), hasLength(1));

      host.session!.inbox.reader(tab)!.revoke();
      await settle(tester);
      answer.complete({
        'result': {'conversationId': one},
      });
      await settle(tester);

      expect(fake.paths, isNot(contains(messages(one))));
      expect(find.text('Hello from the one Buddy'), findsNothing);
    });

    testWidgets('on signing out: the chat goes', (tester) async {
      await pump(tester, backend());
      await openTab(tester);
      account.value = null;
      await settle(tester);
      expect(find.text('Hello from the one Buddy'), findsNothing);
    });

    testWidgets('a menu open as the person becomes a viewer loses its write '
        'rows', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openTab(tester);
      await openMenu(tester);
      expect(find.text('Rename Buddy'), findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {
        ...changes(cursor: 'c3', derived: const {'swarmBuddy': true}),
        'members': [part(me, 9, person(me, role: 'viewer'))],
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await settle(tester);

      expect(find.text('Rename Buddy'), findsNothing);
    });
  });

  group('a failed first read', () {
    testWidgets('says so, with no stuck Loading, and once it recovers the tab '
        'is lit and its chat opens', (tester) async {
      final fake = backend();
      final good = fake.routes['/api/super-tabs/$tab/parts']!;
      var down = true;
      fake.routes['/api/super-tabs/$tab/parts'] = (body) => down
          ? throw const SuperTabFailure('DOWN', 'Down.', statusCode: 503)
          : good(body);
      final host = await pump(tester, fake);
      await openTab(tester);
      expect(key('swarm-tab-mark-buddy'), findsNothing);
      expect(key('swarm-buddy-retry-read'), findsOneWidget);
      expect(key('swarm-buddy-loading'), findsNothing);

      down = false;
      await tester.tap(key('swarm-buddy-retry-read'));
      await settle(tester);

      expect(key('swarm-tab-mark-buddy'), findsOneWidget);
      expect(find.text('Hello from the one Buddy'), findsOneWidget);
      expect(host.session!.inbox.reader(tab)!.error, isNull);
    });

    testWidgets('of the Swarm list says so with Try again', (tester) async {
      final fake = FakeSwarm();
      var down = true;
      fake.routes['/api/super-tabs/list'] = (_) => down
          ? throw const SuperTabFailure('DOWN', 'Down.', statusCode: 503)
          : {
              'tabs': [
                {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
              ],
              'next': null,
            };
      route(fake, chats: [oneChat()], agents: [wren()]);
      fake.routes[messages(one)] = (_) => {
        'messages': [line(one, 1, 'Hello from the one Buddy')],
        'next': null,
      };
      await pump(tester, fake);
      await openTab(tester);
      expect(key('swarm-buddy-retry-list'), findsOneWidget);

      down = false;
      await tester.tap(key('swarm-buddy-retry-list'));
      await settle(tester);
      expect(find.text('Hello from the one Buddy'), findsOneWidget);
    });
  });

  group('kept on the phone', () {
    test('the view Home keeps holds the one chat, the Buddy and the server\'s '
        'word, and no thread session as the Buddy', () {
      final state = <String, dynamic>{
        ...headData(),
        'swarmBuddy': true,
        'people': [person(me)],
        'agents': [
          // First, as a read may list it: kept, it would stand as the Buddy.
          {
            ...wren(),
            'id': 'agent-session',
            'buddySession': {'thread': 't1'},
          },
          wren(),
        ],
        'conversations': [oneChat()],
      };
      final snapshot = SuperTabSnapshot.fromJson(state);
      final kept = swarmHomeSwarm(
        snapshot,
        const {},
        buddies: SwarmBuddies.read(state, me),
      );
      final back = SuperTabSnapshot.fromJson(kept.state);
      final buddies = SwarmBuddies.read(kept.state, me);
      expect(back.swarmBuddy, isTrue);
      expect(back.conversation(one)!.isSwarmBuddyChat, isTrue);
      expect(buddies.ownChats[swarmBuddyKey], one);
      expect(buddies.ownBuddies[swarmBuddyKey], 'agent-wren');
    });

    test('the Swarm last used is kept per account, read back, and goes with '
        'the Swarm', () async {
      final store = MemoryKeyValueStore();
      final first = SwarmHomePrefs(accountId: me, store: store);
      await pumpEventQueue();
      first.showBuddy(other);
      await pumpEventQueue();

      final back = SwarmHomePrefs(accountId: me, store: store);
      await pumpEventQueue();
      expect(back.buddySwarmId, other);

      final someoneElse = SwarmHomePrefs(accountId: 'ann', store: store);
      await pumpEventQueue();
      expect(someoneElse.buddySwarmId, isNull);

      back.keepOnly({tab});
      expect(back.buddySwarmId, isNull);
    });

    test('Home choosing one Swarm counts as using it', () async {
      final prefs = SwarmHomePrefs(accountId: me);
      prefs.show(other);
      expect(prefs.buddySwarmId, other);
      prefs.show(null);
      expect(prefs.buddySwarmId, other);
    });

    test(
      'the Buddy tab\'s Swarm and Home\'s Sort and Filter are kept together, '
      'each chosen before the choices are back standing over what is read',
      () async {
        final store = MemoryKeyValueStore();
        final first = SwarmHomePrefs(accountId: 'me', store: store);
        await pumpEventQueue();
        first
          ..showBuddy('s1')
          ..setFilter(SwarmHomeFilter.mentions)
          ..setSort(SwarmHomeSort.newest)
          ..setUnreadsFirst(true);
        await pumpEventQueue();
        first.dispose();

        final back = SwarmHomePrefs(accountId: 'me', store: store);
        await pumpEventQueue();
        expect(back.buddySwarmId, 's1');
        expect(back.filter, SwarmHomeFilter.mentions);
        expect(back.sort, SwarmHomeSort.newest);
        expect(back.unreadsFirst, isTrue);
        back.dispose();

        final early = SwarmHomePrefs(accountId: 'me', store: store)
          ..showBuddy('s2');
        await pumpEventQueue();
        expect(early.buddySwarmId, 's2');
        expect(early.filter, SwarmHomeFilter.mentions);
        early.dispose();

        final kept = SwarmHomePrefs(accountId: 'me', store: store);
        await pumpEventQueue();
        expect(
          kept.buddySwarmId,
          's2',
          reason: 'written though nothing else moved',
        );
        kept.dispose();
      },
    );
  });
}
