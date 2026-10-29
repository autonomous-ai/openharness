import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

/// One member list again (Dee, 2026-10-29): Humans ranked under a heading that
/// carries the week, then the Agents with today's status line, a rank and the
/// week's points. Only the agents the board scores (the PM, Buddies) are
/// ranked; the others follow in today's order with no rank and no number.
ConversationServer membersSwarm() {
  final server = humansSwarm();
  final agents = server.state['agents'] as List;
  final lead = (agents.first as Map).cast<String, dynamic>()
    ..['machineId'] = 'studio';
  server.state['agents'] = <Object>[
    lead,
    {
      ...lead,
      'id': 'luna',
      'harnessId': 'h-luna',
      'name': 'Luna',
      'displayName': 'Luna',
      'projectId': 'lead',
    },
    {
      ...lead,
      'id': 'sparky',
      'harnessId': 'h-sparky',
      'name': 'Sparky',
      'displayName': 'Sparky',
      'buddyOf': {'personId': 'peer', 'generation': 'g'},
    },
  ];
  server.leaderboard!['agents'] = [
    {
      'agentId': 'lead-agent',
      'displayName': 'River',
      'kind': 'pm',
      'personId': null,
      'machineId': 'studio',
      'points': 212,
      'rank': 1,
      'shipped': 70,
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
    // Another agent named like one in the list is never taken for it.
    {
      'agentId': 'elsewhere',
      'displayName': 'Luna',
      'kind': 'buddy',
      'personId': 'owner',
      'machineId': 'studio',
      'points': 88,
      'rank': 3,
      'shipped': 3,
    },
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

  Finder member(String id) => find.byKey(ValueKey('super-member-$id'));
  Finder rank(String id) => find.byKey(ValueKey('super-member-rank-$id'));
  Finder points(String id) => find.byKey(ValueKey('super-member-points-$id'));
  String text(WidgetTester tester, Finder finder) =>
      tester.widget<Text>(finder).data!;

  testWidgets('shows Humans under a heading with the week, and no list pills', (
    tester,
  ) async {
    final controller = await show(tester, membersSwarm());
    for (final pill in ['humans', 'agents', 'models']) {
      expect(find.byKey(ValueKey('leaderboard-tab-$pill')), findsNothing);
    }
    expect(find.text('Humans'), findsOneWidget);
    final week = find.byKey(const ValueKey('leaderboard-week'));
    expect(week, findsOneWidget);
    // The week sits on the Humans heading's line, at its trailing edge.
    expect(
      (tester.getCenter(week).dy - tester.getCenter(find.text('Humans')).dy)
          .abs(),
      lessThan(8),
    );
    expect(
      tester.getCenter(week).dx,
      greaterThan(tester.getCenter(find.text('Humans')).dx),
    );
    // People ranked as before, then the Agents below them.
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
    'ranks the agents the board scores, with their points, and keeps their status line',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final controller = await show(tester, membersSwarm());
      expect(text(tester, rank('lead-agent')), '1');
      expect(text(tester, points('lead-agent')), '212');
      expect(find.bySemanticsLabel(RegExp(r'\b212 points')), findsOneWidget);
      // Today's one status line stays under the name.
      expect(
        find.byKey(const ValueKey('super-member-line-lead-agent')),
        findsOneWidget,
      );
      // The agents' points share the people's column.
      expect(
        tester.getTopRight(points('lead-agent')).dx,
        tester
            .getTopRight(find.byKey(const ValueKey('leaderboard-points-peer')))
            .dx,
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );

  testWidgets(
    'lists an agent without a score after the ranked ones, with no rank and no number',
    (tester) async {
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
      expect(
        tester.getTopLeft(member('luna')).dy,
        greaterThan(tester.getTopLeft(member('lead-agent')).dy),
      );
      // A Buddy is not in the Agents list, so its score shows nowhere.
      expect(member('sparky'), findsNothing);
      await close(tester, controller);
    },
  );

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
    expect(points('lead-agent'), findsOneWidget);
    server.state['projects'] = <Object>[];
    await controller.refresh();
    await tester.pumpAndSettle();
    expect(points('lead-agent'), findsNothing);
    expect(find.text('212'), findsNothing);
    expect(find.byKey(const ValueKey('leaderboard-points-peer')), findsNothing);
    await close(tester, controller);
  });
}
