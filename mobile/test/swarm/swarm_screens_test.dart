import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_mark.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import '../theme/sheet_shape.dart';

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
    testWidgets('what needs the person comes first, then its projects', (
      tester,
    ) async {
      // An iPhone's screen: all of Home at once.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await pump(tester, backend(), const SwarmPage());

      // The open decision says who asks and where in one line.
      final asks = find.textContaining('River asks you', findRichText: true);
      expect(asks, findsOneWidget);
      expect(find.text('River tagged you'), findsOneWidget);
      expect(find.text('Nova needs you'), findsOneWidget);
      expect(
        tester.getTopLeft(asks).dy,
        lessThan(tester.getTopLeft(key('swarm-project-$tab-$project')).dy),
      );
      expect(
        find.text('Projects'),
        findsOneWidget,
        reason: 'one Swarm: its projects, not its name',
      );

      await tester.tap(find.text('River tagged you'));
      await tester.pumpAndSettle();
      expect(
        find.text('Open chat'),
        findsOneWidget,
        reason: 'the Naming System: a Swarm chat, not a conversation',
      );
      expect(
        find.descendant(
          of: key('swarm-project-$tab-$project'),
          matching: find.textContaining('1\u00A0waiting', findRichText: true),
        ),
        findsOneWidget,
        reason: 'the team line',
      );
    });

    testWidgets('an answer is held for Undo, and undone is never sent', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());

      await tester.tap(key('swarm-option-d1-0'));
      await tester.pump();
      expect(find.text('Sending “Yes”'), findsOneWidget);

      await tester.tap(key('swarm-undo-d1'));
      await tester.pump(const Duration(seconds: 5));
      expect(fake.commands, isEmpty);
      expect(key('swarm-option-d1-0'), findsOneWidget);
    });

    testWidgets(
      'an answer dropped before it was sent says so, and offers the options '
      'again',
      (tester) async {
        final fake = backend();
        final host = await pump(tester, fake, const SwarmPage());
        await tester.tap(key('swarm-option-d1-0'));
        await tester.pump();
        expect(find.text('Sending “Yes”'), findsOneWidget);

        // Read again in full within the Undo window: what waits for the
        // person is read again, and that read is slow to answer.
        const decisions = '/api/super-tabs/$tab/decisions?state=open';
        final open = fake.routes[decisions]!(null);
        final stalled = Completer<Object?>();
        fake.routes[decisions] = (_) => stalled.future;
        fake.routes['/api/super-tabs/$tab/changes'] = (_) => {'reload': true};
        await host.session!.inbox.refresh();
        await tester.pump();
        expect(find.text('Sending “Yes”'), findsNothing);

        stalled.complete(open);
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();

        expect(fake.commands, isEmpty);
        expect(find.text('Not sent, choose again.'), findsOneWidget);
        expect(key('swarm-option-d1-0'), findsOneWidget);

        await tester.tap(key('swarm-option-d1-1'));
        await tester.pump();
        expect(find.text('Not sent, choose again.'), findsNothing);
        expect(find.text('Sending “No”'), findsOneWidget);
        await tester.tap(key('swarm-undo-d1'));
        await tester.pump();
      },
    );

    testWidgets('one tap answers once the Undo window has passed', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());

      await tester.tap(key('swarm-option-d1-1'));
      await tester.pump(const Duration(seconds: 2));
      expect(fake.commands, isEmpty);
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {
        'type': 'decision.answer',
        'decisionId': 'd1',
        'choice': 1,
      });
    });

    testWidgets(
      'an answer not confirmed offers only to send the same one again',
      (tester) async {
        final fake = backend();
        var lost = true;
        fake.routes['/api/super-tabs/$tab/commands'] = (_) => lost
            ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
            : {'result': <String, dynamic>{}};
        await pump(tester, fake, const SwarmPage());

        await tester.tap(key('swarm-option-d1-1'));
        await tester.pump(const Duration(seconds: 4));
        await tester.pumpAndSettle();

        expect(key('swarm-option-d1-0'), findsNothing);
        expect(key('swarm-option-d1-1'), findsNothing);
        expect(find.text('“No” is not confirmed.'), findsOneWidget);

        lost = false;
        await tester.tap(key('swarm-resend-d1'));
        await tester.pumpAndSettle();

        expect([for (final c in fake.commands) c['choice']], [1, 1]);
        final operations = {
          for (final call in fake.calls)
            if (call.method == 'POST') call.body!['operationId'],
        };
        expect(operations, hasLength(1));
      },
    );

    testWidgets('a tag is marked done from its row', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      await tester.tap(key('swarm-need-row-mention:m1'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-done-m1'));
      await tester.pumpAndSettle();

      expect(fake.commands.single, {'type': 'mention.done', 'mentionId': 'm1'});
    });

    testWidgets('Done says so at once, and the tag row goes once confirmed', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      final confirmed = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => confirmed.future;
      await tester.tap(key('swarm-need-row-mention:m1'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-done-m1'));
      await tester.pump();

      expect(find.text('Done…'), findsOneWidget);
      final tag = find.textContaining('River tagged you', findRichText: true);
      expect(tag, findsOneWidget);

      confirmed.complete({'result': <String, dynamic>{}});
      await tester.pumpAndSettle();

      expect(tag, findsNothing);
    });

    testWidgets('a Done that fails says so on its row', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      await tester.tap(key('swarm-need-row-mention:m1'));
      await tester.pumpAndSettle();

      await tester.tap(key('swarm-done-m1'));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Not marked done. Try again.'),
        findsOneWidget,
      );
      expect(
        find.textContaining('River tagged you', findRichText: true),
        findsOneWidget,
      );
      expect(key('swarm-done-m1'), findsOneWidget);
    });

    testWidgets('a need opens the conversation it was asked in', (
      tester,
    ) async {
      await pump(tester, backend(), const SwarmPage());
      await tester.tap(find.text('Nova needs you'));
      await tester.pumpAndSettle();
      expect(
        find.byType(SwarmConversationPage),
        findsNothing,
        reason: 'the first tap opens it on Home, where another was open',
      );

      // Open, it says who asks and where in one line, and that opens it.
      await tester.tap(
        find.textContaining('Nova needs you', findRichText: true),
      );
      await tester.pumpAndSettle();

      expect(find.byType(SwarmConversationPage), findsOneWidget);
      expect(find.text('Which name should the flag have?'), findsOneWidget);
    });

    testWidgets('with Swarm off, says where to turn it on', (tester) async {
      await pump(tester, backend(), const SwarmPage(), on: false);

      expect(key('swarm-unavailable'), findsOneWidget);
    });
  });

  group('a project', () {
    const page = SwarmProjectPage(swarmId: tab, projectId: project);

    /// The scrollable of the project's sheet, not the chat's under it.
    Finder sheetList() => find
        .descendant(
          of: find.byType(SwarmProjectSheet),
          matching: find.byType(Scrollable),
        )
        .first;

    Future<void> openSheet(WidgetTester tester) async {
      await tester.tap(key('swarm-team-line'));
      await tester.pumpAndSettle();
    }

    testWidgets(
      'an agent offers Open terminal with its actual machine and harness',
      (tester) async {
        final opened = <(String, String)>[];
        await pump(
          tester,
          backend(),
          page,
          openAgent: (m, a) => opened.add((m, a)),
        );
        await openSheet(tester);
        await tester.tap(key('swarm-sheet-team'));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-open-terminal-agent-builder'));
        expect(opened, [('mac-1', 'harness-agent-builder')]);
      },
    );

    testWidgets('opens on its project chat, the line under its header', (
      tester,
    ) async {
      await pump(tester, backend(), page);
      await tester.pumpAndSettle();

      const said = 'Morning: Fix login waits on you.';
      expect(find.text(said), findsOneWidget, reason: 'its project chat');
      expect(
        tester.getBottomLeft(key('swarm-team-line')).dy,
        lessThanOrEqualTo(tester.getTopLeft(find.text(said)).dy),
      );
      expect(
        find.textContaining('Lead'),
        findsNothing,
        reason: 'the Naming System: Product Manager on screen, never Lead',
      );
    });

    testWidgets('its sheet has what waits on the person, then work by '
        'latest, older folded', (tester) async {
      await pump(tester, backend(), page);
      await tester.pumpAndSettle();
      await openSheet(tester);

      double y(String k) => tester.getTopLeft(key(k)).dy;
      expect(
        y('swarm-conversation-g1'),
        lessThan(y('swarm-conversation-g-busy')),
        reason: 'what waits on the person first, then the latest activity',
      );
      expect(key('swarm-conversation-g-old'), findsNothing);
      expect(
        key('swarm-conversation-g-private'),
        findsNothing,
        reason: 'a private chat is for its people only',
      );
      expect(
        key('swarm-conversation-g-pm'),
        findsNothing,
        reason: 'Chat with PM is in the header, not listed again',
      );
      expect(
        key('swarm-conversation-$leadChat'),
        findsNothing,
        reason: 'the project chat is the screen',
      );
      expect(
        find.textContaining('Lead'),
        findsNothing,
        reason: 'the Naming System: Product Manager on screen, never Lead',
      );

      await tester.tap(key('swarm-older'));
      await tester.pumpAndSettle();
      expect(key('swarm-conversation-g-old'), findsOneWidget);
      expect(key('swarm-conversation-g-spike'), findsNothing);

      // Rows are 56 points tall: below the fold of the sheet, and built only
      // as they come into view.
      await tester.scrollUntilVisible(
        key('swarm-older-earlier'),
        200,
        scrollable: sheetList(),
      );
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-older-earlier'));
      await tester.pumpAndSettle();
      expect(key('swarm-conversation-g-spike'), findsOneWidget);
      expect(key('swarm-older-earlier'), findsNothing);
    });

    testWidgets("its sheet's Team has each agent in a word", (tester) async {
      await pump(tester, backend(), page);
      await tester.pumpAndSettle();
      await openSheet(tester);

      await tester.tap(key('swarm-sheet-team'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmProjectSheet), findsOneWidget);
      expect(key('swarm-agent-agent-builder'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-agent-agent-builder'),
          matching: find.textContaining('Waiting', findRichText: true),
        ),
        findsOneWidget,
      );
    });

    testWidgets("a pull on its sheet's work reads its Swarm once", (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake, page);
      await openSheet(tester);
      final before = changeReads(fake);

      await tester.fling(
        key('swarm-conversation-g1'),
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();

      expect(changeReads(fake), before + 1);
      expect(find.byType(SwarmProjectSheet), findsOneWidget, reason: 'open');
    });

    testWidgets('of hundreds of older chats, only those in view are built', (
      tester,
    ) async {
      final fake = backend();
      fake.routes[dormant] = (_) => {
        'groups': [
          for (var i = 0; i < 300; i++)
            part(
              'old-$i',
              100 + i,
              groupData(
                'old-$i',
                title: 'Old work $i',
                lastMessageSequence: 1000 - i,
                dormant: true,
              ),
            ),
        ],
        'next': null,
      };
      await pump(tester, fake, page);
      await openSheet(tester);
      final older = find.byWidgetPredicate(
        (widget) => switch (widget.key) {
          ValueKey(:final String value) => value.startsWith(
            'swarm-conversation-old-',
          ),
          _ => false,
        },
      );

      await tester.tap(key('swarm-older'));
      await tester.pumpAndSettle();

      expect(key('swarm-conversation-old-0'), findsOneWidget);
      expect(older.evaluate().length, lessThan(40));
      await tester.scrollUntilVisible(
        key('swarm-conversation-old-299'),
        600,
        scrollable: sheetList(),
      );
      expect(key('swarm-conversation-old-299'), findsOneWidget);
      expect(older.evaluate().length, lessThan(40));
    });
  });

  group('a project while it reads', () {
    const gone = 'This project is no longer in the Swarm.';
    const page = SwarmProjectPage(swarmId: tab, projectId: project);

    /// [projectId]'s page pushed over Home, as Home opens it.
    Future<void> openFromHome(WidgetTester tester, String projectId) async {
      unawaited(
        Navigator.of(tester.element(find.byType(SwarmPage))).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                SwarmProjectPage(swarmId: tab, projectId: projectId),
          ),
        ),
      );
      await frames(tester);
    }

    testWidgets('draws its title and the line under it on their way while '
        'its Swarm is read, then its chat', (tester) async {
      final fake = backend();
      final read = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(tester, fake, page, settle: false);

      expect(key('swarm-project-title-loading'), findsOneWidget);
      expect(key('swarm-project-loading'), findsOneWidget);
      expect(find.text(gone), findsNothing);
      expect(find.byType(SwarmConversationPage), findsNothing);

      read.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-project-loading'), findsNothing);
      expect(key('swarm-project-title-loading'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Mobile');
      expect(key('swarm-pm-chat'), findsOneWidget);
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
      expect(key('swarm-pm-chat'), findsNothing);
    });

    testWidgets('opening it reads its Swarm once', (tester) async {
      final fake = backend();
      await pump(tester, fake, const SwarmPage());
      final before = changeReads(fake);

      await openFromHome(tester, project);
      await tester.pumpAndSettle();

      expect(changeReads(fake), before + 1);
      expect(key('swarm-pm-chat'), findsOneWidget);
    });

    testWidgets('its sheet has rows on their way while the Swarm is read', (
      tester,
    ) async {
      final fake = backend();
      final read = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(
        tester,
        fake,
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showSwarmProjectSheet(
              context,
              swarmId: tab,
              projectId: project,
            ),
            child: const Text('Open'),
          ),
        ),
        settle: false,
      );

      await tester.tap(find.text('Open'));
      await frames(tester);
      expect(key('swarm-work-loading'), findsOneWidget);
      await tester.tap(key('swarm-sheet-team'));
      await frames(tester);
      expect(key('swarm-team-loading'), findsOneWidget);

      read.complete();
      await tester.pumpAndSettle();
      expect(key('swarm-team-loading'), findsNothing);
      expect(sheetTopRadius(tester), 12);
      expect(key('swarm-agent-agent-builder'), findsOneWidget);
    });

    testWidgets('a poll that changes its Swarm builds its line once, and not '
        'its chat', (tester) async {
      final fake = backend();
      await pump(tester, fake, page);
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        lastChangedAt: 200,
        derived: const {'decisionsWaiting': 1, 'mentionsWaiting': 1},
        groups: [
          part(
            'g-busy',
            30,
            groupData('g-busy', title: 'Sync again', lastMessageSequence: 21),
          ),
        ],
      );
      var lines = 0, chats = 0;
      debugOnRebuildDirtyWidget = (element, _) {
        if (element.widget is SwarmProjectStatus) lines++;
        if (element.widget is SwarmConversationPage) chats++;
      };
      addTearDown(() => debugOnRebuildDirtyWidget = null);

      // What waits is read again after the Swarm, a moment later, as it is
      // over a network.
      final asked = hold(fake, '/api/super-tabs/$tab/decisions?state=open');
      unawaited(host(tester).session!.inbox.reader(tab)!.refresh());
      await tester.pump();
      await tester.pump();
      asked.complete();
      await tester.pumpAndSettle();

      expect(
        lines,
        1,
        reason:
            'what waits on the person in its chats is read again, '
            'which moved nothing the line shows',
      );
      expect(chats, 0, reason: 'the chat follows its own messages');
      debugOnRebuildDirtyWidget = null;
      await tester.tap(key('swarm-team-line'));
      await tester.pumpAndSettle();
      expect(find.text('Sync again'), findsOneWidget);
    });

    testWidgets('a change in another Swarm does not build it', (tester) async {
      const other = 'tab-2';
      final fake = backend();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': other, 'name': 'Web Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$other/parts'] = (_) => firstLoad(
        tabId: other,
        head: headData(id: other, name: 'Web Swarm'),
      );
      fake.routes['/api/super-tabs/$other/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$other/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$other/changes'] = (_) => changes(
        cursor: 'c2',
        lastChangedAt: 200,
        groups: [
          part(
            'g-web',
            30,
            groupData('g-web', title: 'Web work', lastMessageSequence: 3),
          ),
        ],
      );
      await pump(tester, fake, page);
      // With two Swarms, the page names its own after who is in the chat.
      expect(find.text('River and everyone · Phone Swarm'), findsOneWidget);
      var builds = 0;
      debugOnRebuildDirtyWidget = (element, _) {
        if (element.widget is SwarmProjectStatus ||
            element.widget is SwarmConversationPage) {
          builds++;
        }
      };
      addTearDown(() => debugOnRebuildDirtyWidget = null);

      final web = host(tester).session!.inbox.reader(other)!;
      unawaited(web.refresh());
      await tester.pumpAndSettle();

      expect(web.snapshot!.conversation('g-web'), isNotNull);
      expect(builds, 0);
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

      await tester.tap(key('swarm-mention'));
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

    testWidgets('the decision asked in it is answered in it', (tester) async {
      await pump(
        tester,
        backend(),
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ship it behind a flag?'), findsOneWidget);
      expect(key('swarm-option-d1-0'), findsOneWidget);
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

    testWidgets('one the person can no longer read shows nothing of it, '
        'its decision included', (tester) async {
      final fake = backend();
      final host = await pump(
        tester,
        fake,
        const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'my reply');
      expect(find.text('Which name should the flag have?'), findsOneWidget);
      expect(find.text('Ship it behind a flag?'), findsOneWidget);

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
    testWidgets('counts what needs the person, and opens Swarm', (
      tester,
    ) async {
      final host = await pump(
        tester,
        backend(),
        const Scaffold(body: Center(child: SwarmMark())),
      );
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(find.text('3'), findsOneWidget);

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
