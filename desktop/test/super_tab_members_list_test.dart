import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// One member list, one row shape (Dee, 2026-10-29): People under a heading
/// that carries the week, each with their points, then the Agents with their
/// status line and the tabs' status mark at the right. No ranks, and no agent
/// points even where the board scores one.
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

  Finder member(String id) => find.byKey(ValueKey('super-member-$id'));
  Finder rank(String id) => find.byKey(ValueKey('super-member-rank-$id'));
  Finder points(String id) => find.byKey(ValueKey('super-member-points-$id'));

  testWidgets('shows People under a heading with the week, and no list pills', (
    tester,
  ) async {
    final controller = await show(tester, membersSwarm());
    for (final pill in ['humans', 'agents', 'models']) {
      expect(find.byKey(ValueKey('leaderboard-tab-$pill')), findsNothing);
    }
    expect(find.text('People'), findsOneWidget);
    expect(find.text('Humans'), findsNothing);
    final week = find.byKey(const ValueKey('leaderboard-week'));
    expect(week, findsOneWidget);
    // The week sits on the People heading's line, at its trailing edge.
    expect(
      (tester.getCenter(week).dy - tester.getCenter(find.text('People')).dy)
          .abs(),
      lessThan(8),
    );
    expect(
      tester.getCenter(week).dx,
      greaterThan(tester.getCenter(find.text('People')).dx),
    );
    // People first, then the Agents below them.
    expect(find.byKey(const ValueKey('super-person-peer')), findsOneWidget);
    expect(
      tester.getTopLeft(member('lead-agent')).dy,
      greaterThan(
        tester.getTopLeft(find.byKey(const ValueKey('super-person-peer'))).dy,
      ),
    );
    await close(tester, controller);
  });

  testWidgets(
    'gives an agent the board scores no rank and no points, and keeps its status line',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, membersSwarm());
      expect(rank('lead-agent'), findsNothing);
      expect(points('lead-agent'), findsNothing);
      expect(find.text('212'), findsNothing);
      expect(find.bySemanticsLabel(RegExp(r'\b212 points')), findsNothing);
      // Nor does anyone carry a rank column.
      expect(find.byKey(const ValueKey('leaderboard-rank-peer')), findsNothing);
      // Today's one status line stays under the name.
      expect(
        find.byKey(const ValueKey('super-member-line-lead-agent')),
        findsOneWidget,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets(
    'lines up people and agents: one avatar column, one name column',
    (tester) async {
      final controller = await show(tester, membersSwarm());
      Rect avatar(Finder row) => tester.getRect(
        find.descendant(of: row, matching: find.byType(SuperTabAvatar)),
      );
      final person = avatar(find.byKey(const ValueKey('super-person-peer')));
      for (final id in ['lead-agent', 'luna']) {
        final agent = avatar(member(id));
        expect(agent.left, person.left, reason: id);
        expect(agent.width, person.width, reason: id);
      }
      expect(
        tester
            .getTopLeft(
              find.descendant(of: member('luna'), matching: find.text('Luna')),
            )
            .dx,
        tester
            .getTopLeft(
              find.descendant(
                of: find.byKey(const ValueKey('super-person-peer')),
                // The row names the person by username (dee) or, before usernames, by email prefix (Dee).
                matching: find.textContaining(RegExp('dee', caseSensitive: false)),
              ),
            )
            .dx,
      );
      await close(tester, controller);
    },
  );

  testWidgets('lists an agent without a score with no rank and no number', (
    tester,
  ) async {
    final controller = await show(tester, membersSwarm());
    expect(member('luna'), findsOneWidget);
    expect(rank('luna'), findsNothing);
    expect(points('luna'), findsNothing);
    // A score under another agent's id is not Luna's, though it bears her name.
    expect(
      find.descendant(of: member('luna'), matching: find.text('88')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey('super-member-line-luna')),
      findsOneWidget,
    );
    // A Buddy is not in the Agents list, so its score shows nowhere.
    expect(member('sparky'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('shows nothing of a board answered for another project', (
    tester,
  ) async {
    final server = membersSwarm();
    server.leaderboard!['projectId'] = 'other';
    final controller = await show(tester, server);
    expect(rank('lead-agent'), findsNothing);
    expect(points('lead-agent'), findsNothing);
    expect(find.byKey(const ValueKey('leaderboard-points-peer')), findsNothing);
    expect(find.text('212'), findsNothing);
    await close(tester, controller);
  });

  testWidgets('clears the numbers once the reader loses the project', (
    tester,
  ) async {
    final server = membersSwarm();
    final controller = await show(tester, server);
    expect(
      find.byKey(const ValueKey('leaderboard-points-peer')),
      findsOneWidget,
    );
    server.state['projects'] = <Object>[];
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(points('lead-agent'), findsNothing);
    expect(find.text('212'), findsNothing);
    expect(find.byKey(const ValueKey('leaderboard-points-peer')), findsNothing);
    await close(tester, controller);
  });

  testWidgets(
    'reads a board without agents or models as people only, with no Models',
    (tester) async {
      final server = modelsSwarm(membersSwarm());
      server.leaderboard!
        ..remove('agents')
        ..remove('byModel');
      final controller = await show(tester, server);
      expect(
        find.byKey(const ValueKey('leaderboard-points-peer')),
        findsOneWidget,
      );
      expect(points('lead-agent'), findsNothing);
      expect(rank('lead-agent'), findsNothing);
      expect(find.byKey(const ValueKey('super-models-heading')), findsNothing);
      expect(find.textContaining('Loading'), findsNothing);
      await close(tester, controller);
    },
  );

  testWidgets('holds at 200% text: names give way, numbers stay whole', (
    tester,
  ) async {
    // Both side panes show at this size only in a wide window.
    await tester.binding.setSurfaceSize(const Size(2400, 1800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = modelsSwarm(membersSwarm()).controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
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
    expect(tester.takeException(), isNull);
    for (final number in ['21', '92%']) {
      expect(find.text(number), findsOneWidget, reason: number);
      final paragraph = tester.renderObject<RenderParagraph>(find.text(number));
      expect(paragraph.didExceedMaxLines, isFalse, reason: number);
    }
    await close(tester, controller);
  });
}
