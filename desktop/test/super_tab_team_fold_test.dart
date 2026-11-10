import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/quiet_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the pictures of a long Your Team there, in both themes.
final _shots = Platform.environment['TEAM_FOLD_SHOTS'];

/// Your Team with forty agents (tester Q1's journey, 2026-11-10: at 880x560 a person scrolled past every agent to reach a
/// project): it shows eight, those with something new or on a task first, and "N more" opens the rest. Clicked through as
/// a person does.
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  /// The person's agent rows on screen, by name.
  List<String> rows() => [
    for (final row
        in find
            .byWidgetPredicate(
              (w) =>
                  w is SuperTabQuietRow &&
                  w.key is ValueKey<String> &&
                  (w.key! as ValueKey<String>).value.startsWith('super-agent-'),
            )
            .evaluate())
      (row.widget as SuperTabQuietRow).name,
  ];

  /// lampOS's Swarm with [more] more agents of the person's, `agent 01` on, each with its own chat. `agent 33`, when
  /// there is one, wrote something the person has not read.
  ConversationServer world({int more = 36}) {
    final server = swarmV4Server();
    final agents = (server.state['agents'] as List)
        .cast<Map<String, dynamic>>();
    final chats = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>();
    for (var i = 1; i <= more; i++) {
      final id = 'agent ${i.toString().padLeft(2, '0')}';
      agents.add({
        'id': id,
        'projectId': 'lead',
        'name': id,
        'displayName': id,
        'machineId': 'host',
        'harnessId': 'session-$id',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
        'kind': 'regular',
        'chatId': 'agent-chat-$id',
        'myAgent': true,
      });
      chats.add({
        ...conversationFixture('agent-chat-$id', id),
        'kind': 'agent-chat',
        'agentIds': [id],
      });
    }
    if (more >= 33) {
      server.append('Done with #12.', conversationId: 'agent-chat-agent 33');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'agent 33',
        'name': 'agent 33',
      };
    }
    return server;
  }

  /// The view settles: the agent states' reader rests, and the rows draw what it found.
  Future<void> settled(WidgetTester tester) async {
    bool busy() => switch (find.byType(ProjectSidebar).evaluate().isEmpty
        ? null
        : tester
              .widget<ProjectSidebar>(find.byType(ProjectSidebar))
              .agentStates) {
      final states? => states.busy,
      null => false,
    };
    for (var round = 0; round < 100; round++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 500));
      if (!busy()) return;
    }
    fail('the reader never rested');
  }

  Future<SuperTabController> show(
    WidgetTester tester, {
    int more = 36,
    String selected = 'lead',
    Size size = const Size(880, 560),
    Brightness brightness = Brightness.light,
  }) async {
    final c = world(more: more).controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': selected},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: createApp(),
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
          ),
        ),
      ),
    );
    await settled(tester);
    return c;
  }

  testWidgets(
    'forty agents: eight show, the one with something new among them, and Projects is in sight without scrolling',
    (tester) async {
      await show(tester);
      expect(rows(), hasLength(8));
      expect(rows(), contains('agent 33'));
      expect(find.text('32 more'), findsOneWidget);
      final projects = tester.getRect(key('project-sidebar-projects'));
      expect(projects.bottom, lessThanOrEqualTo(560));
      expect(key('super-project-lead'), findsOneWidget);
      expect(tester.getRect(key('super-project-lead')).bottom, lessThan(560));
    },
  );

  testWidgets('"32 more" opens the rest, and "Show fewer" folds them again', (
    tester,
  ) async {
    final c = await show(tester);
    await tester.tap(key('super-team-more'));
    await tester.pump(const Duration(milliseconds: 50));
    expect(c.agentsAllShown, isTrue);
    expect(rows().length, greaterThan(8));
    // Every row is there: the list scrolls to the last, and "Show fewer" under it.
    final scroll = find
        .descendant(
          of: find.byType(ProjectSidebar),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      key('super-agent-agent 36'),
      200,
      scrollable: scroll,
    );
    await tester.scrollUntilVisible(
      find.text('Show fewer'),
      200,
      scrollable: scroll,
    );
    await tester.tap(key('super-team-more'));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.drag(scroll, const Offset(0, 4000));
    await tester.pump(const Duration(milliseconds: 50));
    expect(rows(), hasLength(8));
    expect(c.agentsAllShown, isFalse);
    // The choice is kept with the reader's other folds: open again, it reads as open.
    await tester.tap(key('super-team-more'));
    await tester.pump(const Duration(milliseconds: 50));
    expect(c.savedForTest['agentsAllShown'], isTrue);
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('nine agents fold none: a fold that hides one saves no room', (
    tester,
  ) async {
    // Four agents of lampOS's and five more; the last one's chat open.
    await show(tester, more: 5, selected: 'agent-chat-agent 05');
    expect(rows(), hasLength(9));
    expect(key('super-team-more'), findsNothing);
  });

  testWidgets('the agent whose chat is open stays in sight, folded', (
    tester,
  ) async {
    await show(tester, selected: 'agent-chat-agent 30');
    expect(rows(), contains('agent 30'));
    expect(find.text('31 more'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    testWidgets('pictures: forty agents at 880x560, ${brightness.name}', (
      tester,
    ) async {
      if (_shots == null) return;
      await show(tester, brightness: brightness);
      await captureWindow(tester, _shots, 'team-fold-${brightness.name}');
      await tester.tap(key('super-team-more'));
      await tester.pump(const Duration(milliseconds: 50));
      await captureWindow(tester, _shots, 'team-open-${brightness.name}');
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
