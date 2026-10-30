import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Models in the left sidebar, after Machines (Dee, 2026-10-29 and 10-30):
/// every model by its exact name with its share of the agents' tasks of the
/// last 7 days, largest first, rounded so the rows add up to 100%, behind its
/// engine's icon. Its chevron collapses it like every other section; the
/// counts and first-review pass rate are in words on hover and for a screen
/// reader.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Map<String, dynamic>? initial,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1300, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial:
          initial ??
          {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
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
    matching: find.text('Models'),
  );
  Finder row(String name) => find.byKey(ValueKey('super-model-$name'));
  final rows = find.byWidgetPredicate(
    (w) =>
        w.key is ValueKey<String> &&
        (w.key! as ValueKey<String>).value.startsWith('super-model-'),
  );
  Finder inRow(String name, Finder finder) =>
      find.descendant(of: row(name), matching: finder);
  Finder mark(String name, String engine) => inRow(
    name,
    find.byWidgetPredicate((w) => w is EngineMark && w.engine == engine),
  );
  List<String> names(WidgetTester tester) {
    final found = rows.evaluate().toList()
      ..sort(
        (a, b) => tester
            .getTopLeft(find.byWidget(a.widget))
            .dy
            .compareTo(tester.getTopLeft(find.byWidget(b.widget)).dy),
      );
    return [
      for (final element in found)
        (element.widget.key! as ValueKey<String>).value.substring(
          'super-model-'.length,
        ),
    ];
  }

  testWidgets(
    'is headed Models, says on hover it is the last 7 days, and lists every model largest first after Machines',
    (tester) async {
      final controller = await show(tester, modelsSwarm());
      expect(headingText, findsOneWidget);
      expect(find.textContaining('this week'), findsNothing);
      expect(
        find.byTooltip('Share of agent work, last 7 days'),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(heading).dy,
        greaterThan(tester.getTopLeft(find.text('Machines')).dy),
      );
      // The approved mockup: 100 tasks, no Other row, nothing left out.
      expect(names(tester), [
        'Opus 5.5',
        'Sonnet 5.5',
        'Codex, model not reported',
        'GPT-6.1 Sol',
      ]);
      expect(find.text('Other'), findsNothing);
      expect(inRow('Opus 5.5', find.text('84%')), findsOneWidget);
      expect(inRow('Sonnet 5.5', find.text('11%')), findsOneWidget);
      expect(
        inRow('Codex, model not reported', find.text('3%')),
        findsOneWidget,
      );
      expect(inRow('GPT-6.1 Sol', find.text('2%')), findsOneWidget);
      // The percentages line up at their trailing edge.
      expect(
        tester.getTopRight(find.text('84%')).dx,
        tester.getTopRight(find.text('2%')).dx,
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
      ('Codex, model not reported', 'codex'),
      ('GPT-6.1 Sol', 'codex'),
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
    'says the last 7 days\' tasks and first-review pass rate on hover and to a screen reader',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, modelsSwarm());
      const opus =
          'Opus 5.5: 84 of 100 tasks in the last 7 days · 92% passed first review';
      expect(find.byTooltip(opus), findsOneWidget);
      expect(find.bySemanticsLabel(opus), findsOneWidget);
      expect(
        find.byTooltip(
          'Codex, model not reported: 3 of 100 tasks in the last 7 days · no first review yet',
        ),
        findsOneWidget,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets(
    'collapses fully from its chevron and expands again, remembered after a restart',
    (tester) async {
      final server = modelsSwarm();
      final controller = await show(tester, server);
      expect(controller.modelsGroupOpen, isTrue);
      await tester.tap(headingText);
      await tester.pumpAndSettle();
      // Collapsed: the heading stays, nothing below it.
      expect(headingText, findsOneWidget);
      expect(rows, findsNothing);
      expect(find.text('84%'), findsNothing);
      await controller.flush();
      expect(server.saved!['modelsGroupOpen'], isFalse);
      await close(tester, controller);

      final reopened = await show(tester, server, initial: server.saved);
      expect(reopened.modelsGroupOpen, isFalse);
      expect(headingText, findsOneWidget);
      expect(rows, findsNothing);
      await tester.tap(headingText);
      await tester.pumpAndSettle();
      expect(names(tester), hasLength(4));
      expect(inRow('Opus 5.5', find.text('84%')), findsOneWidget);
      await close(tester, reopened);
    },
  );

  testWidgets('rounds the shares so all rows add up to 100%', (tester) async {
    final server = modelsSwarm();
    // A third each: plain rounding says 33% three times, 99%.
    server.leaderboard!['recentModels'] = [
      recentModel('claude', 'claude-opus-5-5', attempts: 1),
      recentModel('codex', 'gpt-6.1-sol', attempts: 1),
      recentModel('claude', 'claude-sonnet-5-5', attempts: 1),
    ];
    final controller = await show(tester, server);
    // Of three alike, by name.
    expect(names(tester), ['GPT-6.1 Sol', 'Opus 5.5', 'Sonnet 5.5']);
    expect(inRow('GPT-6.1 Sol', find.text('34%')), findsOneWidget);
    expect(inRow('Opus 5.5', find.text('33%')), findsOneWidget);
    expect(inRow('Sonnet 5.5', find.text('33%')), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets('says under 1% for a model with a few tasks, never 0%', (
    tester,
  ) async {
    final server = modelsSwarm();
    // 2 of 500 tasks: 0.4%.
    server.leaderboard!['recentModels'] = [
      recentModel('claude', 'claude-opus-5-5', attempts: 498),
      recentModel('codex', 'gpt-6.1-sol', attempts: 2),
    ];
    final controller = await show(tester, server);
    expect(inRow('Opus 5.5', find.text('100%')), findsOneWidget);
    expect(inRow('GPT-6.1 Sol', find.text('<1%')), findsOneWidget);
    expect(find.text('0%'), findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'lists one model under one name, however its engine or provider spelled it',
    (tester) async {
      // Review of e4b70e9: one grid model through Claude Code and Codex drew
      // two rows with one key ("Duplicate keys found").
      final server = modelsSwarm();
      server.leaderboard!['recentModels'] = [
        recentModel('claude', 'qwen3', attempts: 3, reviewed: 4, passed: 3),
        recentModel('codex', 'qwen3', attempts: 5, reviewed: 4, passed: 4),
        recentModel('claude', 'claude-opus-5-5', attempts: 1),
        recentModel('claude', 'Claude-Opus-5.5', attempts: 1),
      ];
      final controller = await show(tester, server);
      expect(tester.takeException(), isNull);
      expect(names(tester), ['qwen3', 'Opus 5.5']);
      expect(inRow('qwen3', find.text('80%')), findsOneWidget);
      expect(inRow('Opus 5.5', find.text('20%')), findsOneWidget);
      expect(mark('qwen3', 'codex'), findsOneWidget);
      expect(
        find.byTooltip(
          'qwen3: 8 of 10 tasks in the last 7 days · 88% passed first review',
        ),
        findsOneWidget,
      );
      await close(tester, controller);
    },
  );

  testWidgets('keeps the last 7 days whichever week the right pane shows', (
    tester,
  ) async {
    final server = modelsSwarm();
    final controller = await show(tester, server);
    await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    expect(headingText, findsOneWidget);
    expect(find.textContaining('last week'), findsNothing);
    expect(inRow('Opus 5.5', find.text('84%')), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets(
    'shows the week\'s models from a server before the last 7 days, still headed Models',
    (tester) async {
      final server = modelsSwarm();
      server.leaderboard!.remove('recentModels');
      final controller = await show(tester, server);
      expect(headingText, findsOneWidget);
      expect(find.byTooltip('Share of agent work, this week'), findsOneWidget);
      // 32 tasks: Opus at two efforts as one, 14; then 9, 6 and 3; Luna ran
      // none of its own.
      expect(names(tester), [
        'Opus 5.5',
        'GPT-6.1 Sol',
        'Sonnet 5.5',
        'Haiku 5.5',
      ]);
      expect(inRow('Opus 5.5', find.text('44%')), findsOneWidget);
      expect(inRow('Haiku 5.5', find.text('9%')), findsOneWidget);
      expect(
        find.byTooltip(
          'Opus 5.5: 14 of 32 tasks this week · 92% passed first review',
        ),
        findsOneWidget,
      );
      await close(tester, controller);
    },
  );

  testWidgets('hides Models when no model ran a task in the last 7 days', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['recentModels'] = <Object>[];
    final controller = await show(tester, server);
    expect(heading, findsNothing);
    await close(tester, controller);
  });

  testWidgets('hides Models from a server before task counts', (tester) async {
    // Its rows carry first reviews but no tasks: no share to show.
    final server = modelsSwarm();
    server.leaderboard!.remove('recentModels');
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

  testWidgets(
    'shows Models once a failed first read recovers, without a stuck row',
    (tester) async {
      final server = modelsSwarm()..failLeaderboardReads = 1;
      final controller = await show(tester, server);
      expect(heading, findsNothing);
      expect(find.textContaining('Loading'), findsNothing);
      await controller.refresh();
      await tester.pump(const Duration(minutes: 5));
      await tester.pumpAndSettle();
      expect(inRow('Opus 5.5', find.text('84%')), findsOneWidget);
      await close(tester, controller);
    },
  );

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
    expect(find.text('84%'), findsNothing);
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
