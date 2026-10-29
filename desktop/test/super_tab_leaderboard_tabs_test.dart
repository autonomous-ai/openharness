import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/leaderboard/worker_rows.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Agents and Models beside Humans on the leaderboard (Dee, 2026-10-29):
/// "permanent and temp workers, just like humans". Agents are the PM and the
/// Buddies by name; Models are the Builders and Reviewers by what they ran on,
/// never by agent. Both keep the one-number rows and the crown.
ConversationServer tabsSwarm({bool empty = false}) {
  final server = humansSwarm();
  final agents = server.state['agents'] as List;
  (agents.first as Map)['machineId'] = 'studio';
  server.state['agents'] = <Object>[
    ...agents,
    <String, dynamic>{
      ...(agents.first as Map).cast<String, dynamic>(),
      'id': 'sparky',
      'harnessId': 'h-sparky',
      'name': 'Sparky',
      'displayName': 'Sparky',
      'buddyOf': {'personId': 'peer', 'generation': 'g'},
    },
  ];
  server.leaderboard!['agents'] = empty
      ? <Map<String, dynamic>>[]
      : [
          {
            'agentId': 'lead-agent',
            'displayName': 'River',
            'kind': 'pm',
            'personId': null,
            'machineId': 'studio',
            'points': 36,
            'rank': 1,
            'shipped': 12,
          },
          {
            'agentId': 'sparky',
            'displayName': 'Sparky',
            'kind': 'buddy',
            'personId': 'peer',
            'machineId': 'studio',
            'points': 12,
            'rank': 2,
            'shipped': 4,
          },
        ];
  Map<String, dynamic> model(
    String engine,
    String? model,
    String? effort,
    int points,
    int rank, {
    int shipped = 0,
    int? attemptMs,
    int? requestMs,
    int reviewed = 0,
    int passed = 0,
    int reviews = 0,
  }) => {
    'engine': engine,
    'model': model,
    'effort': effort,
    'grid': false,
    'points': points,
    'rank': rank,
    'shipped': {
      'count': shipped,
      'medianAttemptMs': attemptMs,
      'medianRequestMs': requestMs,
    },
    'firstReview': {'reviewed': reviewed, 'passed': passed},
    'reviews': reviews,
  };
  server.leaderboard!['byModel'] = empty
      ? <Map<String, dynamic>>[]
      : [
          model(
            'claude',
            'opus',
            'high',
            93,
            1,
            shipped: 31,
            attemptMs: 47 * 60000,
            requestMs: 3 * 3600000,
            reviewed: 34,
            passed: 28,
          ),
          model('codex', 'gpt-5.5', null, 52, 2, shipped: 17),
          model('codex', 'gpt-5.5', 'medium', 5, 3, reviews: 5),
        ];
  return server;
}

void main() {
  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1300, 900));
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

  Finder tab(String name) => find.byKey(ValueKey('leaderboard-tab-$name'));
  Finder row(String id) => find.byKey(ValueKey('leaderboard-row-$id'));
  Finder inRow(String id, Finder finder) =>
      find.descendant(of: row(id), matching: finder);
  Future<void> open(WidgetTester tester, String name) async {
    await tester.ensureVisible(tab(name));
    await tester.tap(tab(name));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'offers Humans, Agents and Models beside the week, Humans first',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, tabsSwarm());
      for (final name in ['humans', 'agents', 'models']) {
        expect(tab(name), findsOneWidget, reason: name);
      }
      expect(tester.getSemantics(tab('humans')), isSemantics(isSelected: true));
      expect(find.byKey(const ValueKey('super-person-peer')), findsOneWidget);
      await open(tester, 'agents');
      expect(find.byKey(const ValueKey('super-person-peer')), findsNothing);
      expect(row('agent-lead-agent'), findsOneWidget);
      expect(tester.getSemantics(tab('agents')), isSemantics(isSelected: true));
      // The week stays where it was.
      expect(find.byKey(const ValueKey('leaderboard-week')), findsOneWidget);
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets(
    'lists the PM and Buddies by name: role, what they shipped, one number, a crown for #1',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, tabsSwarm());
      await open(tester, 'agents');
      expect(
        inRow('agent-lead-agent', find.textContaining('River')),
        findsOneWidget,
      );
      expect(
        inRow('agent-lead-agent', find.textContaining('PM · Mac Studio')),
        findsOneWidget,
      );
      expect(
        inRow('agent-lead-agent', find.text('12 shipped')),
        findsOneWidget,
      );
      expect(inRow('agent-lead-agent', find.text('36')), findsOneWidget);
      expect(
        inRow('agent-sparky', find.textContaining('Buddy · ken.tran')),
        findsNothing,
      );
      expect(
        inRow('agent-sparky', find.textContaining('Buddy · dee')),
        findsOneWidget,
      );
      expect(
        inRow('agent-sparky', find.text('4 proposals shipped')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('leaderboard-crown-agent-lead-agent')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('leaderboard-crown-agent-sparky')),
        findsNothing,
      );
      expect(
        find.bySemanticsLabel(RegExp('Number one this week')),
        findsOneWidget,
      );
      // The points share one right-aligned column.
      expect(
        tester.getTopRight(inRow('agent-lead-agent', find.text('36'))).dx,
        tester.getTopRight(inRow('agent-sparky', find.text('12'))).dx,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets(
    'lists models by what they ran on, never an agent\'s name, with their numbers in words',
    (tester) async {
      final controller = await show(tester, tabsSwarm());
      await open(tester, 'models');
      final opus = 'model-claude-opus-high', codex = 'model-codex-gpt-5.5-';
      final reviewer = 'model-codex-gpt-5.5-medium';
      expect(inRow(opus, find.textContaining('Opus · high')), findsOneWidget);
      // What fits of the line, whole items from its start; all of it on hover.
      const line = '31 shipped · 82% passed first review · 47 min to ship';
      final shown = tester
          .widget<Text>(
            find.descendant(
              of: find.byKey(ValueKey('leaderboard-numbers-$opus')),
              matching: find.byType(Text),
            ),
          )
          .data!;
      expect(shown, startsWith('31 shipped'));
      expect(
        shown == line || line.substring(shown.length).startsWith(' · '),
        isTrue,
        reason: shown,
      );
      expect(inRow(opus, find.text('93')), findsOneWidget);
      expect(inRow(codex, find.textContaining('GPT-5.5')), findsOneWidget);
      expect(inRow(codex, find.text('17 shipped')), findsOneWidget);
      expect(
        inRow(reviewer, find.textContaining('GPT-5.5 · medium')),
        findsOneWidget,
      );
      expect(inRow(reviewer, find.text('5 reviews')), findsOneWidget);
      // The time from the request's first attempt is on hover.
      expect(
        find.byTooltip(
          '31 shipped · 28 of 34 passed first review · 47 min from the shipping attempt, 3 h from the first',
        ),
        findsOneWidget,
      );
      expect(find.byKey(ValueKey('leaderboard-crown-$opus')), findsOneWidget);
      // Workers are never named: no agent's name in the list.
      for (final id in [opus, codex, reviewer]) {
        expect(inRow(id, find.textContaining('River')), findsNothing);
      }
      expect(
        tester.getTopRight(inRow(opus, find.text('93'))).dx,
        tester.getTopRight(inRow(reviewer, find.text('5'))).dx,
      );
      await close(tester, controller);
    },
  );

  testWidgets('says so when no agent or model has anything this week', (
    tester,
  ) async {
    final controller = await show(tester, tabsSwarm(empty: true));
    await open(tester, 'agents');
    expect(find.text('No PM or Buddy in this project yet'), findsOneWidget);
    await open(tester, 'models');
    expect(find.text('No model worked this week'), findsOneWidget);
    await close(tester, controller);
  });

  test('writes a model\'s numbers in words, a share as a whole percent, zeros left out', () {
    SuperTabModelScore score(Map<String, dynamic> extra) =>
        SuperTabModelScore.fromJson({
          'engine': 'claude',
          'model': 'opus',
          ...extra,
        });
    final opus = score({
      'shipped': {
        'count': 31,
        'medianAttemptMs': 47 * 60000,
        'medianRequestMs': 3 * 3600000,
      },
      'firstReview': {'reviewed': 34, 'passed': 28},
    });
    expect(leaderboardModelNumbers(opus), [
      '31 shipped',
      '82% passed first review',
      '47 min to ship',
    ]);
    expect(leaderboardModelNumbers(opus, full: true), [
      '31 shipped',
      '28 of 34 passed first review',
      '47 min from the shipping attempt, 3 h from the first',
    ]);
    expect(leaderboardModelNumbers(score({'reviews': 1})), ['1 review']);
    expect(leaderboardModelNumbers(score({})), isEmpty);
  });
}
