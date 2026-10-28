import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_ship_row.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// A ship line as the backend posts it to the project chat
/// (`backend/src/superTabs/ship.ts` `shipNotice`), built by hand.
SuperTabMessage shipMessage({
  String id = 'ship-1',
  DateTime? at,
  Map<String, dynamic>? source,
}) => SuperTabMessage.fromJson({
  'id': id,
  'conversationId': leadChat,
  'text':
      '🎉 Shipped: Fix login, requested by person-me, built by Nova, '
      'reviewed by Rex. https://github.com/autonomous-ai/openharness/pull/12',
  'sequence': 5,
  'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
  'createdAt': (at ?? DateTime.now()).toUtc().toIso8601String(),
  'source':
      source ??
      {
        'kind': 'ship',
        'conversationId': 'g1',
        'title': 'Fix login',
        'pullRequests': ['https://github.com/autonomous-ai/openharness/pull/12'],
        'requesterId': me,
        'builderIds': ['agent-builder'],
        'reviewerIds': ['agent-reviewer'],
      },
});

void main() {
  setUp(SwarmShipRow.resetPlayed);

  group('a ship line as read', () {
    test('is a ship by its source kind alone', () {
      expect(swarmShips(shipMessage()), isTrue);
      expect(
        swarmShips(shipMessage(source: {'kind': 'message'})),
        isFalse,
      );
      expect(swarmShips(shipMessage(source: {})), isFalse);
    });

    test('reads what shipped and who asked, built and reviewed it', () {
      final ship = SwarmShip.of(shipMessage());

      expect(ship.title, 'Fix login');
      expect(ship.requesterId, me);
      expect(ship.builderIds, ['agent-builder']);
      expect(ship.reviewerIds, ['agent-reviewer']);
      expect(ship.pullRequests, [
        Uri.parse('https://github.com/autonomous-ai/openharness/pull/12'),
      ]);
    });

    test('keeps only GitHub pull requests, at most four', () {
      final ship = SwarmShip.of(
        shipMessage(
          source: {
            'kind': 'ship',
            'title': 7,
            'builderIds': ['agent-builder', 3],
            'pullRequests': [
              'https://evil.example/autonomous-ai/openharness/pull/1',
              'http://github.com/autonomous-ai/openharness/pull/2',
              'https://github.com/autonomous-ai/openharness/issues/3',
              for (var n = 10; n < 16; n++)
                'https://github.com/autonomous-ai/openharness/pull/$n',
            ],
          },
        ),
      );

      expect(ship.title, '');
      expect(ship.requesterId, isNull);
      expect(ship.builderIds, ['agent-builder']);
      expect(ship.reviewerIds, isEmpty);
      expect([for (final link in ship.pullRequests) link.pathSegments[3]], [
        '10',
        '11',
        '12',
        '13',
      ]);
    });
  });

  group('when a ship throws confetti', () {
    final now = DateTime.utc(2026, 10, 28, 3);

    test('a ship under two minutes old does, once per ship', () {
      final played = <String>{};
      final fresh = shipMessage(at: now.subtract(const Duration(seconds: 90)));

      expect(swarmShipCelebrates(fresh, now, played), isTrue);
      expect(swarmShipCelebrates(fresh, now, played), isFalse);
      expect(
        swarmShipCelebrates(shipMessage(id: 'ship-2', at: now), now, played),
        isTrue,
      );
    });

    test('an older ship, or one with no time, does not', () {
      final played = <String>{};
      expect(
        swarmShipCelebrates(
          shipMessage(at: now.subtract(const Duration(minutes: 2, seconds: 1))),
          now,
          played,
        ),
        isFalse,
      );
      final timeless = SuperTabMessage.fromJson({
        'id': 'ship-3',
        'conversationId': leadChat,
        'text': '',
        'sequence': 1,
        'author': {'kind': 'agent', 'id': 'agent-lead'},
        'source': {'kind': 'ship'},
      });
      expect(swarmShipCelebrates(timeless, now, played), isFalse);
      expect(played, isEmpty, reason: 'nothing counted as played');
    });
  });

  group('the ship row', () {
    /// The project chat's Swarm, read: the viewer asked, Nova built and Rex
    /// reviewed.
    FakeSwarm backend() => FakeSwarm()
      ..routes['/api/super-tabs/list'] = ((_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      })
      ..routes['/api/super-tabs/$tab/parts'] = ((_) => firstLoad(
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
          {...agent('agent-reviewer', displayName: 'Rex'), 'role': 'reviewer'},
        ],
      ))
      ..routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');

    Future<void> pump(
      WidgetTester tester,
      SuperTabMessage message, {
      FakeSwarm? fake,
      bool still = false,
    }) async {
      final features =
          ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: (fake ?? backend()).request,
        notices: SilentSystemNotices(),
        features: features,
      )..foreground = false;
      addTearDown(host.dispose);
      await host.session!.inbox.refresh();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: still),
            child: SwarmScope(notifier: host, child: child!),
          ),
          home: Scaffold(
            body: ListView(
              children: [
                SwarmMessageRow(
                  key: ValueKey(message.id),
                  message: message,
                  name: 'River',
                  role: 'PM',
                  mentions: SwarmMentions(const []),
                  grouped: false,
                  lit: false,
                  quote: null,
                  actions: false,
                  onTap: () {},
                  onReply: null,
                ),
              ],
            ),
          ),
        ),
      );
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder inside(Finder matching) =>
        find.descendant(of: key('swarm-ship-ship-1'), matching: matching);

    testWidgets('names what shipped and who asked, built and reviewed it', (
      tester,
    ) async {
      await pump(tester, shipMessage());
      await tester.pumpAndSettle();

      expect(inside(find.text('🎉')), findsOneWidget);
      expect(inside(find.text('Shipped: Fix login')), findsOneWidget);
      expect(inside(find.text('Requested by')), findsOneWidget);
      expect(inside(find.text('person-me')), findsOneWidget);
      expect(inside(find.text('Built by')), findsOneWidget);
      expect(inside(find.text('Nova')), findsOneWidget);
      expect(inside(find.text('Reviewed by')), findsOneWidget);
      expect(inside(find.text('Rex')), findsOneWidget);
      expect(inside(find.text('N')), findsOneWidget, reason: 'an initial');
      expect(inside(find.text('openharness · PR #12')), findsOneWidget);
      expect(
        tester.getSize(key('swarm-ship-pr-ship-1-0')).height,
        greaterThanOrEqualTo(44),
        reason: 'a thumb',
      );
      expect(
        find.text('River'),
        findsNothing,
        reason: 'a ship line is no message from its author',
      );
      expect(
        find.textContaining('requested by person-me'),
        findsNothing,
        reason: 'the card, not the plain text',
      );
    });

    testWidgets('until its Swarm is read, the title and links show alone', (
      tester,
    ) async {
      final fake = backend()..routes.remove('/api/super-tabs/$tab/parts');
      await pump(tester, shipMessage(), fake: fake);
      await tester.pumpAndSettle();

      expect(inside(find.text('Shipped: Fix login')), findsOneWidget);
      expect(inside(find.text('openharness · PR #12')), findsOneWidget);
      expect(inside(find.text('Built by')), findsNothing);
      expect(inside(find.text('Requested by')), findsNothing);
    });

    testWidgets('a fresh ship throws confetti once', (tester) async {
      await pump(tester, shipMessage());
      await tester.pump();

      expect(inside(key('swarm-ship-confetti')), findsOneWidget);
      await tester.pumpAndSettle();
      expect(key('swarm-ship-confetti'), findsNothing, reason: 'it ends');

      // The same ship drawn again, as when the chat is opened again.
      await tester.pumpWidget(const SizedBox());
      await pump(tester, shipMessage());
      await tester.pump();
      expect(key('swarm-ship-confetti'), findsNothing);
    });

    testWidgets('a ship from earlier in the history throws none', (
      tester,
    ) async {
      await pump(
        tester,
        shipMessage(at: DateTime.now().subtract(const Duration(minutes: 3))),
      );
      await tester.pump();

      expect(inside(find.text('Shipped: Fix login')), findsOneWidget);
      expect(key('swarm-ship-confetti'), findsNothing);
    });

    testWidgets('with Reduce Motion on, a fresh ship throws none', (
      tester,
    ) async {
      await pump(tester, shipMessage(), still: true);
      await tester.pump();

      expect(inside(find.text('Shipped: Fix login')), findsOneWidget);
      expect(key('swarm-ship-confetti'), findsNothing);
    });

    testWidgets('any other message is drawn as before', (tester) async {
      await pump(tester, shipMessage(source: {'kind': 'message'}));
      await tester.pumpAndSettle();

      expect(key('swarm-ship-ship-1'), findsNothing);
      expect(find.text('River'), findsOneWidget);
      expect(find.textContaining('requested by person-me'), findsOneWidget);
    });
  });
}
