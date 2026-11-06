import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_board_fixture.dart';
import 'swarm_fixture.dart';

/// A project opens on its Board (task #3821): six columns as tabs with
/// counts, cards in each, the Needs you bar on top, a tap on a card opening
/// its chat, and the project's chat one tap away.
void main() {
  final dormant = '/api/super-tabs/$tab/groups?dormant=1&projectId=$project';
  final proposals = '/api/super-tabs/$tab/proposals?projectId=$project';

  /// One Swarm whose project Mobile has work in every column: Nova on 2156,
  /// Juno's 2160 waiting on the viewer, 2170 nobody took, 2171 done and still
  /// to merge, 2172 merged and releasing, and 2173 shipped yesterday (closed,
  /// so only the closed-work read has it); and one open proposal.

  Future<SwarmHost> pump(WidgetTester tester, FakeSwarm fake) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
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
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmProjectPage(swarmId: tab, projectId: project),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder columnTab(String name) => key('swarm-board-tab-$name');
  Finder card(String id) => key('swarm-board-card-$id');

  /// A tab of the strip: the phone's strip scrolls, so the tests that tap
  /// across the columns are given room for all six.
  Future<void> tapColumn(WidgetTester tester, String name) async {
    await tester.tap(columnTab(name));
    await tester.pumpAndSettle();
  }

  void roomForSixTabs(WidgetTester tester) {
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  String count(WidgetTester tester, String name) => tester
      .widget<Text>(
        find.descendant(
          of: key('swarm-board-tab-$name'),
          matching: find.byKey(const ValueKey('swarm-board-count')),
        ),
      )
      .data!;

  testWidgets('a project opens on its Board, with its chat one tap away', (
    tester,
  ) async {
    await pump(tester, boardBackend());

    expect(key('swarm-project-tab-board'), findsOneWidget);
    expect(key('swarm-project-tab-chat'), findsOneWidget);
    expect(key('swarm-board'), findsOneWidget);
    expect(key('swarm-project-chat-$leadChat'), findsNothing);

    await tester.tap(key('swarm-project-tab-chat'));
    await tester.pumpAndSettle();

    expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
    expect(key('swarm-board'), findsNothing);
  });

  testWidgets(
    'a link or a notice to the project\'s chat opens on its Chat tab, the Board one tap away',
    (tester) async {
      await pump(tester, boardBackend());

      unawaited(
        Navigator.of(tester.element(key('swarm-board')))
            .push(swarmChatRoute(swarmId: tab, conversationId: leadChat)),
      );
      await tester.pumpAndSettle();

      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
      expect(key('swarm-board'), findsNothing);

      await tester.tap(key('swarm-project-tab-board'));
      await tester.pumpAndSettle();

      expect(key('swarm-board'), findsOneWidget);
    },
  );

  testWidgets('the six columns are tabs with their counts', (tester) async {
    await pump(tester, boardBackend());

    for (final (name, label, n) in [
      ('proposal', 'Proposal', '1'),
      ('nextUp', 'Next up', '1'),
      ('working', 'Working', '2'),
      ('done', 'Done', '1'),
      ('merged', 'Merged', '1'),
      ('shipped', 'Shipped', '1'),
    ]) {
      expect(
        find.descendant(of: columnTab(name), matching: find.text(label)),
        findsOneWidget,
        reason: label,
      );
      expect(count(tester, name), n, reason: '$label count');
    }
  });

  testWidgets(
    'it opens on Working, and a column tab shows that column\'s cards',
    (tester) async {
      roomForSixTabs(tester);
      await pump(tester, boardBackend());

      expect(card('g1'), findsOneWidget);
      expect(card('g2'), findsOneWidget);
      expect(card('g3'), findsNothing);

      for (final (name, id) in [
        ('nextUp', 'g3'),
        ('done', 'g4'),
        ('merged', 'g5'),
        ('shipped', 'g6'),
        ('proposal', 'prop-1'),
      ]) {
        await tapColumn(tester, name);
        expect(card(id), findsOneWidget, reason: name);
        expect(card('g1'), findsNothing, reason: '$name has no Working card');
      }
    },
  );

  testWidgets('a swipe moves to the next column', (tester) async {
    await pump(tester, boardBackend());

    await tester.fling(key('swarm-board-pages'), const Offset(-400, 0), 1500);
    await tester.pumpAndSettle();

    expect(card('g4'), findsOneWidget, reason: 'Done follows Working');
  });

  testWidgets(
    'a card has its title, one quiet line, and a mark when it waits on the viewer',
    (tester) async {
      roomForSixTabs(tester);
      await pump(tester, boardBackend());

      expect(
        find.descendant(
          of: card('g1'),
          matching: find.text('#2156 Buddy chat header'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: card('g1'), matching: find.text('P1 · Nova')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: card('g2'),
          matching: find.byKey(const ValueKey('swarm-board-needs-you-mark')),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: card('g1'),
          matching: find.byKey(const ValueKey('swarm-board-needs-you-mark')),
        ),
        findsNothing,
      );

      await tapColumn(tester, 'done');
      expect(
        find.descendant(
          of: card('g4'),
          matching: find.textContaining('PR #12'),
        ),
        findsNothing,
        reason: 'a done card says it waits to merge, not its pull request',
      );
      expect(
        find.descendant(
          of: card('g4'),
          matching: find.textContaining('waiting to merge'),
        ),
        findsOneWidget,
      );

      await tapColumn(tester, 'shipped');
      expect(
        find.descendant(
          of: card('g6'),
          matching: find.textContaining('Desktop 1.3.84'),
        ),
        findsOneWidget,
      );

      await tapColumn(tester, 'proposal');
      expect(
        find.descendant(
          of: card('prop-1'),
          matching: find.text('Show the Board on the phone'),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'the Needs you bar counts what waits on the viewer and opens Activity',
    (tester) async {
      await pump(tester, boardBackend());

      expect(
        find.descendant(
          of: key('swarm-board-needs-you'),
          matching: find.text('Needs you'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: key('swarm-board-needs-you'),
          matching: find.text('1'),
        ),
        findsOneWidget,
      );

      await tester.tap(key('swarm-board-needs-you'));
      await tester.pumpAndSettle();

      expect(find.byType(SwarmActivityPage), findsOneWidget);
    },
  );

  testWidgets('a project with nothing waiting shows no Needs you bar', (
    tester,
  ) async {
    final fake = boardBackend();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [groupData('g1', title: 'Quiet', number: 1, status: 'working')],
    );
    await pump(tester, fake);

    expect(key('swarm-board-needs-you'), findsNothing);
  });

  testWidgets(
    'a tap on a task card opens its chat; a tap on a proposal opens the project chat',
    (tester) async {
      roomForSixTabs(tester);
      await pump(tester, boardBackend());

      await tester.tap(card('g1'));
      await tester.pumpAndSettle();
      final chat = tester.widget<SwarmConversationPage>(
        find.byType(SwarmConversationPage),
      );
      expect(chat.conversationId, 'g1');

      Navigator.of(tester.element(find.byType(SwarmConversationPage))).pop();
      await tester.pumpAndSettle();
      await tapColumn(tester, 'proposal');
      await tester.tap(card('prop-1'));
      await tester.pumpAndSettle();

      expect(key('swarm-project-chat-$leadChat'), findsOneWidget);
    },
  );

  testWidgets('an empty column says what it holds', (tester) async {
    roomForSixTabs(tester);
    final fake = boardBackend();
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad();
    fake.routes[proposals] = (_) => {'proposals': <Object>[]};
    fake.routes[dormant] = (_) => {'groups': <Object>[], 'next': null};
    await pump(tester, fake);

    expect(find.text('Nothing is being worked on.'), findsOneWidget);
    await tapColumn(tester, 'shipped');
    expect(find.text('Nothing has shipped this week.'), findsOneWidget);
  });

  testWidgets(
    'a read that failed is said in its column, and the others still show',
    (tester) async {
      roomForSixTabs(tester);
      await pump(tester, boardBackend(proposalsFail: true, closedFail: true));

      expect(card('g1'), findsOneWidget);
      await tapColumn(tester, 'proposal');
      expect(
        find.text('Proposals could not be read. Pull down to try again.'),
        findsOneWidget,
      );
      await tapColumn(tester, 'shipped');
      expect(
        find.text('Closed work could not be read. Pull down to try again.'),
        findsOneWidget,
      );
    },
  );
}
