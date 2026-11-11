import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_mark.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Half a second of frames, for a screen that cannot settle.
Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// The [SwarmHost] a test's app is under.
SwarmHost host(WidgetTester tester) =>
    tester.widget<SwarmScope>(find.byType(SwarmScope)).notifier!;

/// Swarm's screens on the phone, over a scripted backend: what needs the
/// person first, a decision answered with one tap and Undo, a project's
/// conversations in order, and a post with a mention.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const dormant = '/api/super-tabs/$tab/groups?dormant=1&projectId=$project';

  /// One Swarm, project Mobile: work g1 (Nova needs the person), someone
  /// else's private chat, and one open decision and tag. Its closed work,
  /// g-old and older g-spike, is in no first load: the dormant list has it.
  FakeSwarm backend({String role = 'owner'}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        derived: derived,
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 4,
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'needs_human',
            lastMessageSequence: 9,
          ),
          groupData('g-busy', title: 'Sync', lastMessageSequence: 20),
          groupData(
            'g-private',
            title: 'Their chat',
            audience: ['person-other', 'person-third'],
          ),
          groupData('g-pm', title: 'me', audience: [me]),
        ],
      ),
      'members': [part(me, 1, person(me, role: role))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    final oldWork = part(
      'g-old',
      7,
      groupData('g-old', title: 'Old work', dormant: true),
    );
    fake.routes[dormant] = (_) => {
      'groups': [oldWork],
      'next': 'page-2',
    };
    fake.routes['$dormant&before=page-2'] = (_) => {
      'groups': [
        part('g-spike', 6, groupData('g-spike', title: 'Spike', dormant: true)),
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/groups/g-old'] = (_) => {
      'group': oldWork,
    };
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'askerName': 'River',
          'question': 'Ship it behind a flag?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': [
        {
          'id': 'm1',
          'projectName': 'Mobile',
          'conversationId': 'g1',
          'conversationTitle': 'Fix login',
          'messageId': 'msg-1',
          'leadName': 'River',
          'text': 'Can you check the copy?',
        },
      ],
    };
    fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'msg-lead-1',
              'conversationId': leadChat,
              'text': 'Morning: Fix login waits on you.',
              'sequence': 1,
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
              'createdAt': '2026-10-27T00:30:00.000Z',
            },
          ],
          'next': null,
        };
    fake.routes[messages] = (_) => {
      'messages': [
        {
          'id': 'msg-1',
          'conversationId': 'g1',
          'text': 'Which name should the flag have?',
          'sequence': 9,
          'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
          'createdAt': '2026-10-27T01:00:00.000Z',
        },
      ],
      'next': null,
    };
    return fake;
  }

  /// [home] under a signed-in shell's Swarm, with Swarm turned on.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake,
    Widget home, {
    void Function(String, String)? openAgent,
    bool on = true,
    bool settle = true,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {if (on) PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      // The phone's read marks: a tag counts only once they are back.
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(
          notifier: host,
          child: openAgent == null
              ? child!
              : PhoneShellScope(
                  onMachineLinked: (_) {},
                  onOpenAgent: openAgent,
                  child: child!,
                ),
        ),
        home: home,
      ),
    );
    // A skeleton breathes for as long as it shows: nothing settles under it.
    settle ? await tester.pumpAndSettle() : await frames(tester);
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// [path] answers only once the returned gate is opened.
  Completer<void> hold(FakeSwarm fake, String path) {
    final gate = Completer<void>();
    final answer = fake.routes[path]!;
    fake.routes[path] = (body) async {
      await gate.future;
      return answer(body);
    };
    return gate;
  }

  /// The change reads asked so far.
  int changeReads(FakeSwarm fake) => fake.paths
      .where((path) => path.startsWith('/api/super-tabs/$tab/changes'))
      .length;

  group('the Swarm page', () {
    testWidgets('its projects come first, under the title', (tester) async {
      // An iPhone's screen: all of Home at once.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await pump(tester, backend(), const SwarmPage());

      expect(
        tester.getTopLeft(key('swarm-title-button')).dy,
        lessThan(tester.getTopLeft(key('swarm-project-$tab-$project')).dy),
      );
      expect(
        find.text('Projects'),
        findsNothing,
        reason: 'one Swarm: no heading, the title names it',
      );

      final row = key('swarm-project-$tab-$project');
      expect(
        find.descendant(of: row, matching: find.text('@1')),
        findsNothing,
        reason: "River's task-chat tag stays on its own row",
      );
      expect(
        find.descendant(of: row, matching: find.textContaining('human')),
        findsNothing,
        reason: 'one line: who reads it is on its Team, not on Home',
      );
    });

    testWidgets('with Swarm off, says where to turn it on', (tester) async {
      await pump(tester, backend(), const SwarmPage(), on: false);

      expect(key('swarm-unavailable'), findsOneWidget);
    });
  });

  group('a project while it reads', () {
    const gone = 'This project is no longer in the Swarm.';
    const page = SwarmProjectPage(
      swarmId: tab,
      projectId: project,
    );

    /// [projectId]'s page pushed over Home, as Home opens it.
    Future<void> openFromHome(WidgetTester tester, String projectId) async {
      unawaited(
        Navigator.of(tester.element(find.byType(SwarmPage))).push(
          MaterialPageRoute<void>(
            builder: (_) => SwarmProjectPage(
              swarmId: tab,
              projectId: projectId,
            ),
          ),
        ),
      );
      await frames(tester);
    }

    testWidgets('draws its title on its way while its Swarm is read, with '
        'nothing under it, then its chat', (tester) async {
      final fake = backend();
      final read = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(tester, fake, page, settle: false);

      expect(key('swarm-project-title-loading'), findsOneWidget);
      expect(key('swarm-project-loading'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-project-loading'),
          matching: find.byType(Skeleton),
        ),
        findsNothing,
        reason: 'no team strip comes under the header',
      );
      expect(find.text(gone), findsNothing);
      expect(find.byType(SwarmConversationPage), findsNothing);

      read.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-project-loading'), findsNothing);
      expect(key('swarm-project-title-loading'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, '#Mobile');
      expect(key('swarm-project-menu'), findsOneWidget);
      expect(find.byType(SwarmConversationPage), findsOneWidget);
    });
    testWidgets('says it is no longer in the Swarm only once a read since it '
        'opened has finished without it', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      final read = hold(fake, '/api/super-tabs/$tab/changes');
      await openFromHome(tester, 'project-new');

      expect(find.text(gone), findsNothing);
      expect(key('swarm-project-loading'), findsOneWidget);

      read.complete();
      await tester.pumpAndSettle();

      expect(find.text(gone), findsOneWidget);
      expect(key('swarm-project-loading'), findsNothing);
    });

    testWidgets('a Swarm taken away says the project is gone, with nothing '
        'of it left and no rows on their way', (tester) async {
      await pump(tester, backend(), page);

      host(tester).session!.inbox.reader(tab)!.revoke();
      await frames(tester);

      expect(find.text(gone), findsOneWidget);
      expect(key('swarm-project-loading'), findsNothing);
      expect(key('swarm-project-team'), findsNothing);
      expect(key('swarm-project-tab-chat'), findsNothing);
      expect(find.byType(SwarmConversationPage), findsNothing);
    });

    testWidgets('opening it reads its Swarm once', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      final before = changeReads(fake);

      await openFromHome(tester, project);
      await tester.pumpAndSettle();

      expect(changeReads(fake), before + 1);
      expect(key('swarm-project-menu'), findsOneWidget);
    });

  });

  group('a conversation', () {
    testWidgets('posts text to the agent it mentions', (tester) async {
      final fake = backend();
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), '@');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nova').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '@Nova use beta');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'message.send',
        'conversationId': 'g1',
        'text': '@Nova use beta',
        'replyTo': null,
        'recipientIds': ['agent-builder'],
      });
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
    });

    testWidgets('a refused post says why, even before any message', (
      tester,
    ) async {
      final fake = backend();
      fake.routes[messages] = (_) => {'messages': <Object>[], 'next': null};
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure(
            'READ_ONLY',
            'This conversation is read only.',
            statusCode: 403,
          );
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'hello');
      await tester.pump();
      await tester.tap(key('swarm-send'));
      await tester.pumpAndSettle();

      expect(key('swarm-post-error'), findsOneWidget);
      expect(find.text('This conversation is read only.'), findsOneWidget);
    });

    testWidgets('a viewer reads it and cannot post', (tester) async {
      await pump(
        tester,
        backend(role: 'viewer'),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsOneWidget);
      expect(key('swarm-send'), findsNothing);
      expect(key('swarm-read-only'), findsOneWidget);
      expect(
        find.text('You can read this chat, not post in it.'),
        findsOneWidget,
      );
    });

    testWidgets('one the person can no longer read shows nothing of it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'my reply');
      expect(find.text('Which name should the flag have?'), findsOneWidget);

      // Taken out of g1: the Swarm is read again in full without it, and
      // the decision list has not caught up yet.
      final full = fake.routes['/api/super-tabs/$tab/parts']!(null)! as Map;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...full,
        'groups': [
          for (final g in full['groups'] as List)
            if ((g as Map)['key'] != 'g1') g,
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsNothing);
      expect(find.text('Ship it behind a flag?'), findsNothing);
      expect(find.text('my reply'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
    });

    testWidgets('its Swarm is read often only while the chat is on screen '
        'and Harness is in front', (tester) async {
      final host = await pump(
        tester,
        backend(),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      final reader = host.session!.inbox.reader(tab)!;
      expect(reader.shown, isFalse, reason: 'Harness is behind');

      host.foreground = true;
      expect(reader.shown, isTrue);

      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      unawaited(
        navigator.push(
          MaterialPageRoute<void>(builder: (_) => const Scaffold()),
        ),
      );
      await tester.pumpAndSettle();
      expect(reader.shown, isFalse, reason: 'another screen covers it');

      navigator.pop();
      await tester.pumpAndSettle();
      expect(reader.shown, isTrue);

      host.foreground = false;
      expect(reader.shown, isFalse);
    });

    testWidgets('a closed one opened from a notice reads its name', (
      tester,
    ) async {
      final fake = backend();
      fake.routes['/api/super-tabs/$tab/conversations/g-old/messages'] = (_) =>
          {'messages': <Object>[], 'next': null};
      await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g-old'),
      );
      await tester.pumpAndSettle();

      expect(fake.paths, contains('/api/super-tabs/$tab/groups/g-old'));
      expect(find.text('Old work'), findsOneWidget);
      expect(find.text('This chat is not open to you.'), findsNothing);
    });

    testWidgets('one in a Swarm the person left shows nothing of it', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'my reply');

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': <Object>[],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('Which name should the flag have?'), findsNothing);
      expect(find.text('my reply'), findsNothing);
      expect(find.text('This chat is not open to you.'), findsOneWidget);
    });
  });

  group("Home's Swarm mark", () {
    testWidgets('opens Swarm, with no count on it', (tester) async {
      final host = await pump(
        tester,
        backend(),
        const Scaffold(body: Center(child: SwarmMark())),
      );
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('3'), findsNothing, reason: 'three asks, no count');

      await tester.tap(key('swarm-mark'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmPage), findsOneWidget);
    });

    testWidgets('in the shell, goes back to Swarm Home rather than over it', (
      tester,
    ) async {
      var shown = 0;
      final host = await pump(
        tester,
        backend(),
        PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (_, _) {},
          onShowSwarm: () => shown++,
          child: const Scaffold(body: Center(child: SwarmMark())),
        ),
      );
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-mark'));
      await tester.pumpAndSettle();

      expect(shown, 1);
      expect(find.byType(SwarmPage), findsNothing);
    });

    testWidgets('is not there while Swarm is off', (tester) async {
      await pump(
        tester,
        backend(),
        const Scaffold(body: Center(child: SwarmMark())),
        on: false,
      );

      expect(key('swarm-mark'), findsNothing);
    });
  });
}
