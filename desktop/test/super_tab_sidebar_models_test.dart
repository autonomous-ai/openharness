import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/engine_identity.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Manage › Models (Quiet Swarm, screen 10b; Dee, 2026-10-29 and 10-30):
/// every model by its exact name with its share of the agents' tasks of the
/// last 7 days, largest first, rounded so the rows add up to 100%, behind its
/// engine's icon. A record with no reported model is not listed and not in
/// the shares (Scholes, 2026-11-02). The
/// counts and first-review pass rate are in words on hover and for a screen
/// reader.
void main() {
  /// Manage's Models. Its Your models action says the page is there, so that a
  /// test finding no model rows is not looking at another page.
  Future<void> openModels(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('super-manage')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('super-manage-tab-models')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('super-local-models')), findsOneWidget);
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Map<String, dynamic>? initial,
    bool openManage = true,
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
    if (openManage) await openModels(tester);
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  final heading = find.byKey(const ValueKey('super-models-heading'));
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
  // Nothing in the list, its tooltips or its words says "not reported".
  final notReported = find.byWidgetPredicate(
    (w) =>
        (w is Tooltip && (w.message ?? '').contains('not reported')) ||
        (w is Text && (w.data ?? '').contains('not reported')),
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
    'has no heading of its own under the Models tab, says on hover it is the last 7 days, and lists every model largest first',
    (tester) async {
      final controller = await show(tester, modelsSwarm());
      expect(heading, findsNothing);
      expect(find.textContaining('this week'), findsNothing);
      expect(find.byTooltip(RegExp('in the last 7 days')), findsNWidgets(3));
      // 97 tasks of named models (the fixture's 3 with no model are left
      // out): no Other row, the rest add up to 100.
      expect(names(tester), ['Opus 5.5', 'Sonnet 5.5', 'GPT-6.1 Sol']);
      expect(find.text('Other'), findsNothing);
      expect(find.textContaining('not reported'), findsNothing);
      expect(inRow('Opus 5.5', find.text('87%')), findsOneWidget);
      expect(inRow('Sonnet 5.5', find.text('11%')), findsOneWidget);
      expect(inRow('GPT-6.1 Sol', find.text('2%')), findsOneWidget);
      // The percentages line up at their trailing edge.
      expect(
        tester.getTopRight(find.text('87%')).dx,
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
      ('GPT-6.1 Sol', 'codex'),
    ]) {
      expect(mark(name, engine), findsOneWidget, reason: name);
      expect(
        tester.getTopRight(mark(name, engine)).dx,
        lessThan(tester.getTopLeft(inRow(name, find.text(name))).dx),
        reason: name,
      );
    }
    await close(tester, controller);
  });

  testWidgets(
    'says the last 7 days\' tasks and first-review pass rate on hover and to a screen reader',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, modelsSwarm());
      const opus =
          'Opus 5.5: 84 of 97 tasks in the last 7 days · 92% passed first review';
      expect(find.byTooltip(opus), findsOneWidget);
      expect(find.bySemanticsLabel(opus), findsOneWidget);
      expect(notReported, findsNothing);
      semantics.dispose();
      await close(tester, controller);
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

  testWidgets('says the same for models with as many tasks', (tester) async {
    final server = modelsSwarm();
    // 163, 1, 1 and 1 of 166: largest remainders give two of the three 1s a
    // point to reach 100; under 1% each, they all read alike.
    server.leaderboard!['recentModels'] = [
      recentModel('claude', 'claude-opus-5-5', attempts: 163),
      recentModel('claude', 'claude-sonnet-5-5', attempts: 1),
      recentModel('codex', 'gpt-6.1-sol', attempts: 1),
      recentModel('codex', 'gpt-6.1-luna', attempts: 1),
    ];
    final controller = await show(tester, server);
    expect(inRow('Opus 5.5', find.text('98%')), findsOneWidget);
    for (final name in ['Sonnet 5.5', 'GPT-6.1 Sol', 'GPT-6.1 Luna']) {
      expect(inRow(name, find.text('<1%')), findsOneWidget, reason: name);
    }
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
    // The right pane is beside the chat: pick its week, then open Manage.
    final controller = await show(tester, server, openManage: false);
    await tester.tap(find.byKey(const ValueKey('leaderboard-week')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Last week').last);
    await tester.pumpAndSettle();
    expect(server.leaderboardReads.last, contains('&week='));
    await openModels(tester);
    expect(find.textContaining('last week'), findsNothing);
    expect(inRow('Opus 5.5', find.text('87%')), findsOneWidget);
    await close(tester, controller);
  });

  testWidgets('shows the week\'s models from a server before the last 7 days', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!.remove('recentModels');
    final controller = await show(tester, server);
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
  });

  testWidgets(
    'leaves records with no reported model out of the list and the shares',
    (tester) async {
      // Records written before the 10-31 fix: Codex, and Claude, with no
      // model, in any of the shapes a server sends it.
      final server = modelsSwarm();
      server.leaderboard!['recentModels'] = [
        recentModel('claude', 'claude-opus-5-5', attempts: 1),
        recentModel('codex', null, attempts: 5, reviewed: 2, passed: 1),
        recentModel('claude', null, attempts: 7),
        recentModel('codex', '', attempts: 3),
        recentModel('codex', '  ', attempts: 4),
        recentModel('codex', 'gpt-6.1-sol', attempts: 2),
      ];
      final controller = await show(tester, server);
      expect(names(tester), ['GPT-6.1 Sol', 'Opus 5.5']);
      expect(notReported, findsNothing);
      // 1 and 2 of the 3 tasks that named a model: the rows add up to 100.
      expect(inRow('GPT-6.1 Sol', find.text('67%')), findsOneWidget);
      expect(inRow('Opus 5.5', find.text('33%')), findsOneWidget);
      expect(
        find.byTooltip(
          'Opus 5.5: 1 of 3 tasks in the last 7 days · no first review yet',
        ),
        findsOneWidget,
      );
      await close(tester, controller);
    },
  );

  testWidgets('hides Models when only records with no model ran tasks', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['recentModels'] = [
      recentModel('codex', null, attempts: 3),
      recentModel('claude', null, attempts: 9),
    ];
    final controller = await show(tester, server);
    expect(rows, findsNothing);
    expect(rows, findsNothing);
    expect(notReported, findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'leaves records with no model out of the week\'s models from a server before the last 7 days',
    (tester) async {
      final server = modelsSwarm();
      server.leaderboard!.remove('recentModels');
      (server.leaderboard!['byModel'] as List).add(
        modelScore('codex', null, null, attempts: 20),
      );
      final controller = await show(tester, server);
      // The same 32 tasks of named models as without the record.
      expect(names(tester), [
        'Opus 5.5',
        'GPT-6.1 Sol',
        'Sonnet 5.5',
        'Haiku 5.5',
      ]);
      expect(inRow('Opus 5.5', find.text('44%')), findsOneWidget);
      expect(notReported, findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('hides Models when no model ran a task in the last 7 days', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['recentModels'] = <Object>[];
    final controller = await show(tester, server);
    expect(rows, findsNothing);
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
    expect(rows, findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'shows Models once a failed first read recovers, without a stuck row',
    (tester) async {
      final server = modelsSwarm()..failLeaderboardReads = 1;
      final controller = await show(tester, server);
      expect(rows, findsNothing);
      expect(find.textContaining('Loading'), findsNothing);
      await controller.refresh();
      await tester.pump(const Duration(minutes: 5));
      await tester.pumpAndSettle();
      expect(inRow('Opus 5.5', find.text('87%')), findsOneWidget);
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
    expect(rows, findsNothing);
    expect(find.text('87%'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('shows no Models from a board answered for another project', (
    tester,
  ) async {
    final server = modelsSwarm();
    server.leaderboard!['projectId'] = 'other';
    final controller = await show(tester, server);
    expect(rows, findsNothing);
    await close(tester, controller);
  });
}
