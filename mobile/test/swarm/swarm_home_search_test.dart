import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_search.dart';

/// Home's way into Search (Slack's, 2026-11-03): a pull down at the top of
/// the list, on Android's clamping list and iOS's bouncing one alike, and a
/// search field that folds away as the list scrolls.
void main() {
  Finder key(String value) => find.byKey(ValueKey(value));
  final hint = key('swarm-pull-search-hint');

  /// A list of 40 rows under [SwarmPullToSearch], scrolling as [physics].
  Future<List<int>> pumpList(
    WidgetTester tester, {
    required ScrollPhysics physics,
  }) async {
    final pulls = <int>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SwarmPullToSearch(
            onPull: () => pulls.add(1),
            child: ListView(
              key: const ValueKey('list'),
              physics: AlwaysScrollableScrollPhysics(parent: physics),
              children: [
                for (var i = 0; i < 40; i++)
                  SizedBox(height: 44, child: Text('row $i')),
              ],
            ),
          ),
        ),
      ),
    );
    return pulls;
  }

  /// A finger down on the list, [by] down, held while [held] looks, then up.
  Future<void> pull(
    WidgetTester tester,
    double by, {
    Future<void> Function()? held,
  }) async {
    final gesture = await tester.startGesture(
      tester.getCenter(key('list')) - const Offset(0, 200),
    );
    for (var moved = 0.0; moved < by; moved += 10) {
      await gesture.moveBy(const Offset(0, 10));
      await tester.pump();
    }
    await held?.call();
    await gesture.up();
    await tester.pumpAndSettle();
  }

  for (final (name, physics) in [
    ('Android, clamping', const ClampingScrollPhysics()),
    ('iOS, bouncing', const BouncingScrollPhysics()),
  ]) {
    group(name, () {
      testWidgets('a pull past the reach at the top opens Search, with a '
          'hint while it pulls', (tester) async {
        final pulls = await pumpList(tester, physics: physics);

        await pull(
          tester,
          // Bouncing gives back less than the finger moves.
          physics is BouncingScrollPhysics ? 260 : 120,
          held: () async {
            expect(hint, findsOneWidget);
            expect(find.text('Release to search'), findsOneWidget);
          },
        );

        expect(pulls, hasLength(1));
        expect(hint, findsNothing, reason: 'gone once let go');
      });

      testWidgets('a short pull opens nothing, and says to pull on', (
        tester,
      ) async {
        final pulls = await pumpList(tester, physics: physics);

        await pull(
          tester,
          30,
          held: () async =>
              expect(find.text('Pull to search'), findsOneWidget),
        );

        expect(pulls, isEmpty);
      });

      testWidgets('scrolled into the list, a pull back up to the top and past '
          'it opens nothing: the drag began in the middle', (tester) async {
        final pulls = await pumpList(tester, physics: physics);
        await tester.drag(key('list'), const Offset(0, -300));
        await tester.pumpAndSettle();
        final position = tester
            .state<ScrollableState>(find.byType(Scrollable))
            .position;
        expect(position.pixels, greaterThan(0));

        await pull(tester, 300 + 200);

        expect(pulls, isEmpty);
      });

      testWidgets('scrolling down the list opens nothing', (tester) async {
        final pulls = await pumpList(tester, physics: physics);

        await tester.fling(key('list'), const Offset(0, -400), 1500);
        await tester.pumpAndSettle();

        expect(pulls, isEmpty);
        expect(hint, findsNothing);
      });
    });
  }

  group('the search field', () {
    Future<void> pumpPill(
      WidgetTester tester, {
      required bool collapsed,
      VoidCallback? onTap,
      bool still = false,
    }) => tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: still),
          child: Scaffold(
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SwarmSearchPill(collapsed: collapsed, onTap: onTap ?? () {}),
                const Expanded(child: Text('the list')),
              ],
            ),
          ),
        ),
      ),
    );

    double height(WidgetTester tester) =>
        tester.getSize(find.byType(SwarmSearchPill)).height;

    testWidgets('open, it says what it finds, is a thumb wide button, and a '
        'tap opens Search', (tester) async {
      final semantics = tester.ensureSemantics();
      var taps = 0;
      await pumpPill(tester, collapsed: false, onTap: () => taps++);

      expect(find.text('Search chats, projects, agents'), findsOneWidget);
      expect(height(tester), SwarmSearchPill.height);
      expect(
        tester.getSize(key('swarm-search-pill')).height,
        greaterThanOrEqualTo(40),
      );
      expect(
        tester.getSemantics(key('swarm-search-pill')),
        matchesSemantics(label: 'Search', isButton: true, hasTapAction: true),
      );
      await tester.tap(key('swarm-search-pill'));
      expect(taps, 1);
      semantics.dispose();
    });

    testWidgets('folded as the list scrolls: no room, no tap, nothing heard; '
        'back at the top it opens again', (tester) async {
      final semantics = tester.ensureSemantics();
      var taps = 0;
      await pumpPill(tester, collapsed: false, onTap: () => taps++);

      await pumpPill(tester, collapsed: true, onTap: () => taps++);
      await tester.pump(const Duration(milliseconds: 90));
      final midway = height(tester);
      expect(midway, lessThan(SwarmSearchPill.height));
      expect(midway, greaterThan(0), reason: 'it folds, not jumps');
      await tester.pumpAndSettle();

      expect(height(tester), 0);
      expect(find.semantics.byLabel('Search'), findsNothing);
      await tester.tap(find.byType(SwarmSearchPill), warnIfMissed: false);
      expect(taps, 0);

      await pumpPill(tester, collapsed: false, onTap: () => taps++);
      await tester.pumpAndSettle();
      expect(height(tester), SwarmSearchPill.height);
      expect(find.semantics.byLabel('Search'), findsOne);
      semantics.dispose();
    });

    testWidgets('with animations off it folds at once', (tester) async {
      await pumpPill(tester, collapsed: false, still: true);
      await pumpPill(tester, collapsed: true, still: true);
      await tester.pump();

      expect(height(tester), 0);
    });
  });
}
