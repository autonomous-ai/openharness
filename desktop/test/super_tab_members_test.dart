import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/super_tab_fixture.dart';

/// Quiet Swarm, screens 4 and 5 (Dee, 2026-11-02): the right column opens
/// only from Members, its rows are one line each, and a click opens a card.
void main() {
  Future<SuperTabController> mountView(
    WidgetTester tester,
    ConversationServer server, {
    Size size = const Size(1440, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller();
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> unmount(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  final members = find.byKey(const ValueKey('super-members-button'));
  final close = find.byKey(const ValueKey('super-members-close'));

  group('the right column', () {
    testWidgets('is closed at rest in a wide window', (tester) async {
      final c = await mountView(tester, ConversationServer());
      expect(find.byType(SuperTabRoster), findsNothing);
      expect(members, findsOneWidget);
      expect(find.byTooltip('Members'), findsOneWidget);
      await unmount(tester, c);
    });

    testWidgets('Members opens it beside the chat and its close shuts it', (
      tester,
    ) async {
      final c = await mountView(tester, ConversationServer());
      await tester.tap(members);
      await tester.pumpAndSettle();
      final roster = find.byType(SuperTabRoster);
      expect(roster, findsOneWidget);
      // Docked at the right, not a drawer over the chat.
      expect(tester.getTopRight(roster).dx, 1440);
      expect(
        find.byKey(const ValueKey('super-message-composer')),
        findsOneWidget,
      );
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(roster, findsNothing);
      // Members again opens it again.
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(roster, findsOneWidget);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(roster, findsNothing);
      await unmount(tester, c);
    });

    testWidgets('Members takes the right side from an open thread', (
      tester,
    ) async {
      final server = ConversationServer()..append('Root of a thread');
      final controller = await mountView(tester, server);
      controller.openThread(server.messages.last['id'] as String);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOneWidget);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsNothing);
      expect(find.byType(SuperTabRoster), findsOneWidget);
      // And a thread opened again takes it back.
      controller.openThread(server.messages.last['id'] as String);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('super-thread-panel')), findsOneWidget);
      expect(find.byType(SuperTabRoster), findsNothing);
      controller.closeThread();
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsNothing);
      await unmount(tester, controller);
    });

    testWidgets('a narrow window opens it as a drawer with the same close', (
      tester,
    ) async {
      final c = await mountView(
        tester,
        ConversationServer(),
        size: const Size(900, 700),
      );
      expect(find.byType(SuperTabRoster), findsNothing);
      await tester.tap(members);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsOneWidget);
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(find.byType(SuperTabRoster), findsNothing);
      await unmount(tester, c);
    });
  });

  Map<String, dynamic> score(String id, int points, int rank) => {
    'personId': id,
    'points': points,
    'rank': rank,
    'medal': null,
    'shipped': {'count': 11, 'medianAskToShipMs': null},
    'unblocked': {'count': 4, 'agentMs': 0, 'medianAnswerMs': null},
    'lent': {'machines': 1, 'agentMs': 41 * 3600000},
    'streakDays': 0,
  };

  /// A Swarm whose board sums the last 7 days ([rolling]) or, from a server
  /// before periods, this week.
  Future<RosterFixture> people(
    WidgetTester tester, {
    bool rolling = true,
    bool open = true,
  }) async {
    await tester.binding.setSurfaceSize(const Size(280, 760));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = RosterFixture();
    await f.initialize();
    addTearDown(f.dispose);
    (f.server.state['people'] as List).addAll([
      {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
      // On no board: a row with nothing under its name.
      {'id': 'tony', 'email': 'tony@example.com', 'role': 'collaborator'},
    ]);
    f.server.leaderboard = {
      'projectId': 'lead',
      'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
      if (rolling) 'period': {'name': '7d', 'start': 1, 'end': 2},
      if (rolling) 'allProjects': true,
      'people': [score('owner', 424, 1), score('dee', 339, 2)],
      'waiting': {
        'total': 1,
        'people': [
          {
            'personId': 'owner',
            'count': 1,
            'conversationIds': ['lead'],
          },
        ],
      },
    };
    await f.controller.refresh();
    if (open) await f.controller.select('lead');
    return f;
  }

  Finder person(String id) => find.byKey(ValueKey('super-person-$id'));
  final scope = find.byKey(const ValueKey('roster-scope'));

  group('People', () {
    testWidgets('the heading is the project-or-Swarm choice, beside the close', (
      tester,
    ) async {
      final f = await people(tester);
      await f.show(tester);
      expect(
        find.descendant(of: scope, matching: find.text('All projects')),
        findsOneWidget,
      );
      expect(tester.getCenter(scope).dy, tester.getCenter(close).dy);
      expect(find.text('People'), findsOneWidget);
      expect(find.text('Agents'), findsOneWidget);
      expect(find.text('Humans'), findsNothing);
      // Points are the last 7 days; no picker for the period or the week.
      expect(find.byKey(const ValueKey('leaderboard-period')), findsNothing);
      expect(find.byKey(const ValueKey('leaderboard-week')), findsNothing);
      await tester.tap(scope);
      await tester.pumpAndSettle();
      await tester.tap(find.text('This project').last);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: scope, matching: find.text('This project')),
        findsOneWidget,
      );
      expect(find.text('openharness'), findsNothing);
      await tester.tap(close);
      expect(f.closed, isTrue);
      await f.close(tester);
    });

    testWidgets('with no project open the heading reads All projects alone', (
      tester,
    ) async {
      final f = await people(tester, open: false);
      f.controller.selectedId = 'missing';
      await f.show(tester);
      expect(scope, findsNothing);
      expect(
        find.byKey(const ValueKey('super-members-heading')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-members-heading')),
          matching: find.text('All projects'),
        ),
        findsOneWidget,
      );
      expect(person('owner'), findsOneWidget);
      await f.close(tester);
    });

    testWidgets('a person row is one line: name, crown and points', (
      tester,
    ) async {
      final f = await people(tester);
      await f.show(tester);
      final row = person('owner');
      expect(
        find.descendant(of: row, matching: find.text('424')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('leaderboard-crown-owner')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('leaderboard-crown-dee')), findsNothing);
      // The numbers go on the card.
      expect(find.byKey(const ValueKey('leaderboard-meta-owner')), findsNothing);
      expect(find.textContaining('shipped'), findsNothing);
      // One line: as tall as a row with nothing under its name.
      expect(
        tester.getSize(row).height,
        tester.getSize(person('tony')).height,
      );
      expect(find.byTooltip('Points in the last 7 days'), findsWidgets);
      await f.close(tester);
    });

    testWidgets('no waiting line under People: Activity says who waits', (
      tester,
    ) async {
      final f = await people(tester);
      await f.show(tester);
      expect(find.textContaining('waiting on'), findsNothing);
      expect(find.text('Answer'), findsNothing);
      await f.close(tester);
    });

    testWidgets('a server that sums weeks shows points, this week on hover', (
      tester,
    ) async {
      final f = await people(tester, rolling: false);
      await f.show(tester);
      expect(
        find.descendant(of: person('owner'), matching: find.text('424')),
        findsOneWidget,
      );
      expect(find.byTooltip('Points this week'), findsWidgets);
      expect(find.byKey(const ValueKey('leaderboard-week')), findsNothing);
      await f.close(tester);
    });
  });
}
