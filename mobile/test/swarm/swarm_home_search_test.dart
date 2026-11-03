import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_home_search.dart';

/// A way into Search from Home (Slack's, 2026-11-03): a pull down at the top
/// of the list, on Android's clamping list and iOS's bouncing one alike. The
/// other is the top bar's Search.
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
}
