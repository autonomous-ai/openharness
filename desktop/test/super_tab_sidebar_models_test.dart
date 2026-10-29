import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Models in the left sidebar, after Machines (Dee, 2026-10-29): the models
/// whose work reviewers approved most often on first review in the week the
/// right pane shows, as a bare percentage, the counts in words on hover and
/// for a screen reader. A model needs 3 first reviews to be listed.
Map<String, dynamic> model(
  String engine,
  String? model,
  String? effort, {
  required int reviewed,
  required int passed,
}) => {
  'engine': engine,
  'model': model,
  'effort': effort,
  'grid': false,
  'points': 0,
  'rank': 1,
  'shipped': {'count': 0, 'medianAttemptMs': null, 'medianRequestMs': null},
  'firstReview': {'reviewed': reviewed, 'passed': passed},
  'reviews': 0,
};

ConversationServer modelsSwarm() {
  final server = humansSwarm();
  server.leaderboard!['agents'] = <Object>[];
  server.leaderboard!['byModel'] = [
    // One model at two efforts is one row: 11 of 12.
    model('claude', 'claude-opus-5-5', 'high', reviewed: 10, passed: 9),
    model('claude', 'claude-opus-5-5', 'xhigh', reviewed: 2, passed: 2),
    model('codex', 'gpt-6.1-sol', null, reviewed: 16, passed: 13),
    model('claude', 'claude-sonnet-5-5', 'medium', reviewed: 10, passed: 7),
    model('claude', 'claude-haiku-5-5', 'low', reviewed: 4, passed: 2),
    // Too few first reviews to say anything, however good.
    model('codex', 'gpt-6.1-luna', null, reviewed: 2, passed: 2),
  ];
  return server;
}

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
  Finder row(String name) => find.byKey(ValueKey('super-model-$name'));
  Finder inRow(String name, Finder finder) =>
      find.descendant(of: row(name), matching: finder);

  testWidgets(
    'lists the top three by first-review approval after Machines, as a bare percentage',
    (tester) async {
      final controller = await show(tester, modelsSwarm());
      expect(heading, findsOneWidget);
      expect(
        tester.getTopLeft(heading).dy,
        greaterThan(tester.getTopLeft(find.text('Machines')).dy),
      );
      expect(inRow('Opus 5.5', find.text('92%')), findsOneWidget);
      expect(inRow('GPT-6.1 Sol', find.text('81%')), findsOneWidget);
      expect(inRow('Sonnet 5.5', find.text('70%')), findsOneWidget);
      // Fourth, so not shown until asked for; too few reviews, never.
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
        tester.getTopRight(find.text('92%')).dx,
        tester.getTopRight(find.text('70%')).dx,
      );
      await close(tester, controller);
    },
  );

  testWidgets('says the counts in words on hover and to a screen reader', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final controller = await show(tester, modelsSwarm());
    expect(
      find.byTooltip('11 of 12 approved on first review this week'),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel(
        'Opus 5.5: 11 of 12 approved on first review this week',
      ),
      findsOneWidget,
    );
    semantics.dispose();
    await close(tester, controller);
  });

  testWidgets('shows the whole list from its heading, and back', (
    tester,
  ) async {
    final controller = await show(tester, modelsSwarm());
    await tester.tap(
      find.descendant(of: heading, matching: find.text('Models')),
    );
    await tester.pumpAndSettle();
    expect(inRow('Haiku 5.5', find.text('50%')), findsOneWidget);
    expect(row('GPT-6.1 Luna'), findsNothing);
    await tester.tap(
      find.descendant(of: heading, matching: find.text('Models')),
    );
    await tester.pumpAndSettle();
    expect(row('Haiku 5.5'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('follows the week the right pane shows', (tester) async {
    final server = modelsSwarm();
    final controller = await show(tester, server);
    server.leaderboard!['byModel'] = [
      model('claude', 'claude-sonnet-5-5', 'high', reviewed: 4, passed: 4),
    ];
    await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    expect(row('Opus 5.5'), findsNothing);
    expect(inRow('Sonnet 5.5', find.text('100%')), findsOneWidget);
    expect(
      find.byTooltip('4 of 4 approved on first review last week'),
      findsOneWidget,
    );
    await close(tester, controller);
  });

  testWidgets('hides Models when no model has three first reviews', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['byModel'] = [
      model('claude', 'claude-opus-5-5', 'high', reviewed: 2, passed: 2),
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
    expect(find.text('92%'), findsNothing);
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
