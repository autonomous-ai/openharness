import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/leaderboard/reader.dart';
import 'package:harness/super_tabs/visible_tick.dart';

import 'support/super_tab_fixture.dart';

// Task #2195: nothing redraws on a timer while it's off screen.

class _Panel extends StatefulWidget {
  const _Panel({required this.builds, required this.changes});
  final List<int> builds;
  final List<bool> changes;
  @override
  State<_Panel> createState() => _PanelState();
}

class _PanelState extends State<_Panel>
    with WidgetsBindingObserver, VisibleTick<_Panel> {
  @override
  void initState() {
    super.initState();
    visibleTick(const Duration(seconds: 1));
  }

  @override
  void onScreenChanged(bool onScreen) => widget.changes.add(onScreen);

  @override
  Widget build(BuildContext context) {
    widget.builds.add(1);
    return const SizedBox();
  }
}

Widget _frame(_Panel panel, {required bool on}) => Directionality(
  textDirection: TextDirection.ltr,
  child: TickerMode(enabled: on, child: panel),
);

void main() {
  testWidgets('ticks while on screen', (tester) async {
    final builds = <int>[], panel = _Panel(builds: builds, changes: []);
    await tester.pumpWidget(_frame(panel, on: true));
    builds.clear();
    await tester.pump(const Duration(seconds: 3));
    expect(builds, isNotEmpty);
  });

  testWidgets(
    'does not tick or rebuild off screen, and redraws at once on coming back',
    (tester) async {
      final builds = <int>[],
          changes = <bool>[],
          panel = _Panel(builds: builds, changes: changes);
      await tester.pumpWidget(_frame(panel, on: false));
      builds.clear();
      await tester.pump(const Duration(seconds: 5));
      await tester.pump(const Duration(seconds: 5));
      expect(builds, isEmpty);
      await tester.pumpWidget(_frame(panel, on: true));
      expect(builds, isNotEmpty);
      expect(changes.last, isTrue);
      builds.clear();
      await tester.pump(const Duration(seconds: 2));
      expect(builds, isNotEmpty);
    },
  );

  testWidgets('stops when its tab leaves the screen', (tester) async {
    final builds = <int>[],
        changes = <bool>[],
        panel = _Panel(builds: builds, changes: changes);
    await tester.pumpWidget(_frame(panel, on: true));
    await tester.pumpWidget(_frame(panel, on: false));
    expect(changes.last, isFalse);
    builds.clear();
    await tester.pump(const Duration(seconds: 5));
    expect(builds, isEmpty);
  });

  testWidgets('stops while the app is hidden, and redraws when it returns', (
    tester,
  ) async {
    final builds = <int>[],
        changes = <bool>[],
        panel = _Panel(builds: builds, changes: changes);
    await tester.pumpWidget(_frame(panel, on: true));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    expect(changes.last, isFalse);
    builds.clear();
    await tester.pump(const Duration(seconds: 5));
    expect(builds, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(changes.last, isTrue);
    expect(builds, isNotEmpty);
  });

  test('a project board reads nothing while its Swarm is away, and goes on when it returns', () async {
    final server = ConversationServer()
      ..leaderboard = {'people': const <Object>[]};
    final c = server.controller();
    addTearDown(c.dispose);
    await c.refresh();
    final board = SuperTabProjectBoard(
      c,
      every: const Duration(milliseconds: 5),
    );
    addTearDown(board.dispose);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(server.leaderboardReads, isNotEmpty);
    c.away = true;
    await Future<void>.delayed(const Duration(milliseconds: 10));
    final read = server.leaderboardReads.length;
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(server.leaderboardReads, hasLength(read));
    c.away = false;
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(server.leaderboardReads.length, greaterThan(read));
  });

  test('a project board reads at once when its Swarm returns, having missed a read', () {
    fakeAsync((async) {
      final server = ConversationServer()
        ..leaderboard = {'people': const <Object>[]};
      final c = server.controller();
      unawaited(c.refresh());
      async.flushMicrotasks();
      final board = SuperTabProjectBoard(c);
      async.flushMicrotasks();
      c.away = true;
      final read = server.leaderboardReads.length;
      async.elapse(const Duration(minutes: 6));
      expect(server.leaderboardReads, hasLength(read));
      c.away = false;
      async.flushMicrotasks();
      expect(server.leaderboardReads, hasLength(read + 1));
      c.away = true;
      c.away = false;
      async.flushMicrotasks();
      expect(
        server.leaderboardReads,
        hasLength(read + 1),
        reason: 'it missed nothing this time',
      );
      board.dispose();
      c.dispose();
    });
  });

  testWidgets('of a stack of pages, only the one showing ticks', (
    tester,
  ) async {
    final shown = <int>[], hidden = <int>[];
    Widget pages(int index) => Directionality(
      textDirection: TextDirection.ltr,
      child: SuperTabPages(
        index: index,
        children: [
          _Panel(builds: shown, changes: []),
          _Panel(builds: hidden, changes: []),
        ],
      ),
    );
    await tester.pumpWidget(pages(0));
    shown.clear();
    hidden.clear();
    await tester.pump(const Duration(seconds: 3));
    expect(shown, isNotEmpty);
    expect(hidden, isEmpty);
    await tester.pumpWidget(pages(1));
    shown.clear();
    hidden.clear();
    await tester.pump(const Duration(seconds: 3));
    expect(shown, isEmpty);
    expect(hidden, isNotEmpty);
  });

  testWidgets('leaves no timer behind when it goes', (tester) async {
    await tester.pumpWidget(_frame(_Panel(builds: [], changes: []), on: true));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 2));
  });
}
