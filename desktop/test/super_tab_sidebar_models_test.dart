import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Models in the left sidebar, after Machines (Dee, 2026-10-29): each model's
/// share of the tasks of the week the right pane shows, rounded so the rows
/// add up to 100%, behind its engine's icon; the counts and its first-review
/// pass rate in words on hover and for a screen reader.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  final heading = find.byKey(const ValueKey('super-models-heading'));
  final headingText = find.descendant(
    of: heading,
    matching: find.text('Models · this week'),
  );
  Finder row(String name) => find.byKey(ValueKey('super-model-$name'));
  Finder inRow(String name, Finder finder) =>
      find.descendant(of: row(name), matching: finder);
  Finder mark(String name, String engine) => inRow(
    name,
    find.byWidgetPredicate((w) => w is EngineMark && w.engine == engine),
  );

  testWidgets(
    'lists the top three by share of the week\'s tasks after Machines',
    (tester) async {
      final controller = await show(tester, modelsSwarm());
      expect(headingText, findsOneWidget);
      expect(
        tester.getTopLeft(heading).dy,
        greaterThan(tester.getTopLeft(find.text('Machines')).dy),
      );
      // 32 tasks: 14, 9, 6 and 3 of them, 43.75, 28.1, 18.75 and 9.4%.
      expect(inRow('Opus 5.5', find.text('44%')), findsOneWidget);
      expect(inRow('GPT-6.1 Sol', find.text('28%')), findsOneWidget);
      expect(inRow('Sonnet 5.5', find.text('19%')), findsOneWidget);
      // Fourth, so not shown until asked for; no task of its own, never.
      expect(row('Haiku 5.5'), findsNothing);
      expect(row('GPT-6.1 Luna'), findsNothing);
      final top = tester.getTopLeft(row('Opus 5.5')).dy;
      final second = tester.getTopLeft(row('GPT-6.1 Sol')).dy;
      expect(top, lessThan(second));
      expect(second, lessThan(tester.getTopLeft(row('Sonnet 5.5')).dy));
      // No effort split, no rank, no other number.
      expect(find.textContaining('Opus 5.5 ·'), findsNothing);
      // The percentages line up at their trailing edge.
      expect(
        tester.getTopRight(find.text('44%')).dx,
        tester.getTopRight(find.text('19%')).dx,
      );
      await close(tester, controller);
    },
  );

  testWidgets('puts its engine\'s icon before each model\'s name', (
    tester,
  ) async {
    final controller = await show(tester, modelsSwarm());
    for (final (name, engine) in [
      ('Opus 5.5', 'claude'),
      ('GPT-6.1 Sol', 'codex'),
      ('Sonnet 5.5', 'claude'),
    ]) {
      expect(mark(name, engine), findsOneWidget, reason: name);
      expect(
        tester.getTopRight(mark(name, engine)).dx,
        lessThan(tester.getTopLeft(inRow(name, find.text(name))).dx),
        reason: name,
      );
    }
    // In the sidebar's icon column: under the channel marks' column.
    expect(
      tester.getCenter(mark('Opus 5.5', 'claude')).dx,
      closeTo(tester.getCenter(find.text('#').first).dx, 1),
    );
    await close(tester, controller);
  });

  testWidgets(
    'says the tasks and first-review pass rate on hover and to a screen reader',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, modelsSwarm());
      const opus =
          'Opus 5.5: 14 of 32 tasks this week · 92% passed first review';
      expect(find.byTooltip(opus), findsOneWidget);
      expect(find.bySemanticsLabel(opus), findsOneWidget);
      expect(
        find.byTooltip(
          'GPT-6.1 Sol: 9 of 32 tasks this week · 75% passed first review',
        ),
        findsOneWidget,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets('shows the whole list from its heading, and back', (
    tester,
  ) async {
    final controller = await show(tester, modelsSwarm());
    await tester.tap(headingText);
    await tester.pumpAndSettle();
    expect(inRow('Haiku 5.5', find.text('9%')), findsOneWidget);
    expect(mark('Haiku 5.5', 'claude'), findsOneWidget);
    // Not reviewed yet: says so rather than a pass rate.
    expect(
      find.byTooltip(
        'Haiku 5.5: 3 of 32 tasks this week · no first review yet',
      ),
      findsOneWidget,
    );
    expect(row('GPT-6.1 Luna'), findsNothing);
    await tester.tap(headingText);
    await tester.pumpAndSettle();
    expect(row('Haiku 5.5'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('rounds the shares so all rows add up to 100%', (tester) async {
    final server = modelsSwarm();
    // A third each: plain rounding says 33% three times, 99%.
    server.leaderboard!['byModel'] = [
      modelScore('claude', 'claude-opus-5-5', 'high', attempts: 1),
      modelScore('codex', 'gpt-6.1-sol', null, attempts: 1),
      modelScore('claude', 'claude-sonnet-5-5', 'high', attempts: 1),
    ];
    final controller = await show(tester, server);
    // Of three alike, by name.
    expect(inRow('GPT-6.1 Sol', find.text('34%')), findsOneWidget);
    expect(inRow('Opus 5.5', find.text('33%')), findsOneWidget);
    expect(inRow('Sonnet 5.5', find.text('33%')), findsOneWidget);
    expect(
      tester.getTopLeft(row('GPT-6.1 Sol')).dy,
      lessThan(tester.getTopLeft(row('Opus 5.5')).dy),
    );
    await close(tester, controller);
  });

  testWidgets('follows the week the right pane shows', (tester) async {
    final server = modelsSwarm();
    final controller = await show(tester, server);
    server.leaderboard!['byModel'] = [
      modelScore(
        'claude',
        'claude-sonnet-5-5',
        'high',
        attempts: 4,
        reviewed: 4,
        passed: 4,
      ),
    ];
    await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    expect(
      find.descendant(of: heading, matching: find.text('Models · last week')),
      findsOneWidget,
    );
    expect(row('Opus 5.5'), findsNothing);
    expect(inRow('Sonnet 5.5', find.text('100%')), findsOneWidget);
    expect(
      find.byTooltip(
        'Sonnet 5.5: 4 of 4 tasks last week · 100% passed first review',
      ),
      findsOneWidget,
    );
    await close(tester, controller);
  });

  testWidgets(
    'lists a model run through two engines once, behind the engine that ran most of it',
    (tester) async {
      // Review of e4b70e9: one grid model through Claude Code and Codex drew
      // two rows with one key ("Duplicate keys found").
      final server = modelsSwarm();
      server.leaderboard!['byModel'] = [
        modelScore(
          'claude',
          'qwen3',
          'high',
          attempts: 3,
          reviewed: 4,
          passed: 3,
        ),
        modelScore('codex', 'qwen3', null, attempts: 5, reviewed: 4, passed: 4),
      ];
      final controller = await show(tester, server);
      expect(tester.takeException(), isNull);
      expect(row('qwen3'), findsOneWidget);
      expect(inRow('qwen3', find.text('100%')), findsOneWidget);
      expect(mark('qwen3', 'codex'), findsOneWidget);
      expect(
        find.byTooltip(
          'qwen3: 8 of 8 tasks this week · 88% passed first review',
        ),
        findsOneWidget,
      );
      await close(tester, controller);
    },
  );

  testWidgets('hides Models when no model ran a task this week', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['byModel'] = [
      modelScore('codex', 'gpt-6.1-luna', null, attempts: 0, reviews: 3),
    ];
    final controller = await show(tester, server);
    expect(heading, findsNothing);
    await close(tester, controller);
  });

  testWidgets('hides Models from a server before task counts', (tester) async {
    // Its rows carry first reviews but no tasks: no share to show.
    final server = modelsSwarm();
    server.leaderboard!['byModel'] = [
      modelScore(
        'claude',
        'claude-opus-5-5',
        'high',
        attempts: null,
        reviewed: 5,
        passed: 5,
      ),
    ];
    final controller = await show(tester, server);
    expect(heading, findsNothing);
    await close(tester, controller);
  });

  testWidgets('clears Models once the reader loses the project', (
    tester,
  ) async {
    final server = modelsSwarm();
    final controller = await show(tester, server);
    expect(row('Opus 5.5'), findsOneWidget);
    server.state['projects'] = <Object>[];
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(heading, findsNothing);
    expect(find.text('44%'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('shows no Models from a board answered for another project', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['projectId'] = 'other';
    final controller = await show(tester, server);
    expect(heading, findsNothing);
    await close(tester, controller);
  });
}
