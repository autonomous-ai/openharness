import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_home_tiles.dart';

/// The person's agents as a test sets them.
class _Agents extends ChangeNotifier implements SwarmAgents {
  _Agents(this.working);

  @override
  int? working;

  @override
  List<SwarmAgentRef> get agents => const [];

  var lists = 0;

  @override
  void openList(BuildContext context) => lists++;

  @override
  void open(BuildContext context, SwarmAgentRef agent) {}

  void set(int? next) {
    working = next;
    notifyListeners();
  }
}

/// Swarm Home's tiles (Slack's tile bar, 2026-11-03): While you were away,
/// Threads and Agents in one row that scrolls sideways when it does not fit.
void main() {
  final back = DateTime(2026, 11, 3, 9);
  Finder key(String value) => find.byKey(ValueKey(value));
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);

  Future<void> pump(
    WidgetTester tester,
    List<Widget> tiles, {
    double width = 390,
  }) => tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: width,
            child: SwarmHomeTiles(children: tiles),
          ),
        ),
      ),
    ),
  );

  Widget away({int? done = 34, int? needs = 4, VoidCallback? onTap}) =>
      SwarmAwayTile(
        since: back.subtract(const Duration(hours: 21)),
        back: back,
        done: done,
        needs: needs,
        onTap: onTap ?? () {},
      );

  group('While you were away', () {
    testWidgets('says how long, what was done and what needs the person', (
      tester,
    ) async {
      await pump(tester, [away()]);

      expect(inside('swarm-away', find.text('While you were away')), findsOne);
      expect(inside('swarm-away', find.text('21h')), findsOneWidget);
      expect(inside('swarm-away-done', find.text('34')), findsOneWidget);
      expect(inside('swarm-away-done', find.text('done')), findsOneWidget);
      expect(inside('swarm-away-needs', find.text('4')), findsOneWidget);
      expect(inside('swarm-away-needs', find.text('need you')), findsOne);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a figure not known yet is a skeleton, and heard as such', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, [away(done: null, needs: null)]);

      expect(inside('swarm-away-done', find.byType(SkeletonText)), findsOne);
      expect(inside('swarm-away-needs', find.byType(SkeletonText)), findsOne);
      expect(
        find.bySemanticsLabel(
          'While you were away, 21h: not known how many done, '
          'not known how many need you',
        ),
        findsOneWidget,
      );
      semantics.dispose();
    });

    testWidgets('is one button for a screen reader, and a tap opens it', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      var taps = 0;
      await pump(tester, [away(onTap: () => taps++)]);

      expect(
        find.bySemanticsLabel('While you were away, 21h: 34 done, 4 need you'),
        findsOneWidget,
      );
      await tester.tap(key('swarm-away'));
      expect(taps, 1);
      semantics.dispose();
    });
  });

  group('Agents', () {
    testWidgets('a skeleton until the computers answer, then how many work', (
      tester,
    ) async {
      final agents = _Agents(null);
      addTearDown(agents.dispose);
      await pump(tester, [SwarmAgentsTile(agents: agents, onTap: () {})]);

      expect(key('swarm-agents-loading'), findsOneWidget);

      agents.set(2);
      await tester.pump();

      expect(key('swarm-agents-loading'), findsNothing);
      expect(inside('swarm-agents-tile', find.text('2 working')), findsOne);

      agents.set(0);
      await tester.pump();

      expect(inside('swarm-agents-tile', find.text('None working')), findsOne);
    });

    testWidgets('is heard with its count, and a tap opens every agent', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final agents = _Agents(1);
      addTearDown(agents.dispose);
      var taps = 0;
      await pump(tester, [
        SwarmAgentsTile(agents: agents, onTap: () => taps++),
      ]);

      expect(find.bySemanticsLabel('Agents, 1 working'), findsOneWidget);
      await tester.tap(key('swarm-agents-tile'));
      expect(taps, 1);
      semantics.dispose();
    });
  });

  testWidgets('the row: away first and widest, the tiles as tall as each '
      'other and a thumb or more, scrolling sideways on a narrow phone', (
    tester,
  ) async {
    final agents = _Agents(1);
    addTearDown(agents.dispose);
    await pump(tester, [
      away(),
      SwarmAgentsTile(agents: agents, onTap: () {}),
    ], width: 280);

    expect(tester.takeException(), isNull, reason: 'no overflow');
    final first = tester.getRect(key('swarm-away'));
    final second = tester.getRect(key('swarm-agents-tile'));
    expect(first.left, lessThan(second.left));
    expect(first.width, greaterThan(second.width));
    expect(first.height, second.height);
    expect(first.height, greaterThanOrEqualTo(44));
    expect(second.right, greaterThan(280), reason: 'past the edge, to scroll');

    await tester.drag(key('swarm-home-tiles'), const Offset(-200, 0));
    await tester.pumpAndSettle();

    expect(
      tester.getRect(key('swarm-agents-tile')).right,
      lessThanOrEqualTo(280),
      reason: 'scrolled into sight',
    );
  });
}
