import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/harness_activity.dart';
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
    testWidgets(
      'the heading is the project-or-Swarm choice, beside the close',
      (tester) async {
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
      },
    );

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
      expect(
        find.byKey(const ValueKey('leaderboard-meta-owner')),
        findsNothing,
      );
      expect(find.textContaining('shipped'), findsNothing);
      // One line: as tall as a row with nothing under its name.
      expect(tester.getSize(row).height, tester.getSize(person('tony')).height);
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

  group('Agents', () {
    /// Finn (agent-3) waits on a person, Sage (agent-1) works, Juno (agent-4)
    /// lost its task; Atlas (agent-0) and Nova (agent-2) hold none.
    Future<RosterFixture> agents(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(280, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final f = RosterFixture();
      await f.initialize();
      addTearDown(f.dispose);
      final list = f.server.state['agents'] as List;
      list.add({
        ...(list[3] as Map).cast<String, Object>(),
        'id': 'agent-4',
        'harnessId': 'a4',
        'name': 'Juno',
        'displayName': 'Juno',
        'configuration': {
          'engine': 'claude',
          'model': 'claude-opus-5-5',
          'effort': 'high',
        },
      });
      (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        {
          ...conversationFixture('ask', 'Pick a sign-in page'),
          'assignment': {'agentId': 'agent-3', 'status': 'needs_human'},
        },
        {
          ...conversationFixture('build', 'Windows credential fix'),
          'assignment': {'agentId': 'agent-1', 'status': 'working'},
        },
        {
          ...conversationFixture('gone', 'Old work'),
          'assignment': {'agentId': 'agent-4', 'status': 'lost'},
        },
      ]);
      await f.controller.refresh();
      final machine = f.app.stateOf('m')!;
      machine.agents = [
        for (final i in [0, 1, 3, 4])
          Agent(id: 'a$i', name: 'n$i', engine: 'codex'),
      ];
      machine.processingAgentIds.add('a1');
      return f;
    }

    Finder word(int i) => find.byKey(ValueKey('super-member-word-agent-$i'));
    final idle = find.byKey(const ValueKey('super-members-idle'));

    testWidgets('a row is one line: name, status word and mark', (
      tester,
    ) async {
      final f = await agents(tester);
      await f.show(tester);
      expect(f.inRow(1, find.text('Sage')), findsOneWidget);
      expect(tester.widget<Text>(word(1)).data, 'working');
      expect(tester.widget<Text>(word(3)).data, 'waiting');
      expect(tester.widget<Text>(word(4)).data, 'lost');
      expect(f.activity(tester, 1), HarnessActivity.working);
      // Role, model, effort and the task go on the card.
      expect(f.inRow(1, find.text('Dev')), findsNothing);
      expect(f.model(1), findsNothing);
      expect(f.line(1), findsNothing);
      expect(find.textContaining('Windows credential fix'), findsNothing);
      // The word sits on the name's line, before the mark.
      expect(
        tester.getCenter(word(1)).dy,
        moreOrLessEquals(
          tester.getCenter(f.inRow(1, find.text('Sage'))).dy,
          epsilon: 1,
        ),
      );
      expect(
        tester.getCenter(word(1)).dx,
        lessThan(
          tester
              .getCenter(
                f.inRow(
                  1,
                  find.byKey(const ValueKey('super-member-mark-agent-1')),
                ),
              )
              .dx,
        ),
      );
      await f.close(tester);
    });

    testWidgets('waiting first, then working; idle folds under Idle (N)', (
      tester,
    ) async {
      final f = await agents(tester);
      await f.show(tester);
      // Atlas and Nova hold no task: folded.
      expect(f.row(0), findsNothing);
      expect(f.row(2), findsNothing);
      expect(
        find.descendant(of: idle, matching: find.text('Idle (2)')),
        findsOneWidget,
      );
      final tops = [
        for (final i in [3, 1, 4]) tester.getTopLeft(f.row(i)).dy,
      ];
      expect(tops, [...tops]..sort());
      // Lost work stays above the fold.
      expect(
        tester.getTopLeft(f.row(4)).dy,
        lessThan(tester.getTopLeft(idle).dy),
      );
      await tester.tap(find.text('Idle (2)'));
      await tester.pumpAndSettle();
      expect(f.row(0), findsOneWidget);
      expect(f.row(2), findsOneWidget);
      expect(tester.widget<Text>(word(0)).data, 'idle');
      expect(
        tester.getTopLeft(f.row(0)).dy,
        greaterThan(tester.getTopLeft(idle).dy),
      );
      await tester.tap(find.text('Idle (2)'));
      await tester.pumpAndSettle();
      expect(f.row(0), findsNothing);
      await f.close(tester);
    });

    testWidgets('a click opens the agent card, not the task', (tester) async {
      final f = await agents(tester);
      await f.show(tester);
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
      expect(f.answered, isNull);
      expect(find.byKey(const ValueKey('super-agent-card')), findsOneWidget);
      await f.close(tester);
    });

    testWidgets('right-click keeps Details and Remove from Swarm', (
      tester,
    ) async {
      final f = await agents(tester);
      await f.show(tester);
      await tester.tap(f.row(1), buttons: kSecondaryMouseButton);
      await tester.pumpAndSettle();
      expect(find.text('Details'), findsOneWidget);
      expect(find.text('Remove from Swarm'), findsOneWidget);
      await tester.tapAt(Offset.zero);
      await tester.pumpAndSettle();
      await f.close(tester);
    });
  });
}
