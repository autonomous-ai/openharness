import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join/new_agent_dialog.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'swarm_state_test.dart' show createApp;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

/// Task #4220 (anh Dee's Buddy's review of main 0413586e, 2026-11-07): the Desktop v3 findings, each verified in the code
/// and fixed here.
Finder _key(String k) => find.byKey(ValueKey(k));

/// Whether the row under [k] reads as the open one.
bool _lit(String k) => find
    .descendant(
      of: _key(k),
      matching: find.byWidgetPredicate(
        (w) => w is Semantics && w.properties.selected == true,
      ),
    )
    .evaluate()
    .isNotEmpty;

void main() {
  /// The Desktop's view of a Swarm with one Buddy for the whole Swarm, as Swarm v3 has.
  Future<(SuperTabController, ConversationServer)> showDesktop(
    WidgetTester tester, {
    void Function(ConversationServer server)? setup,
    Widget Function(BuildContext)? rightPane,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1500, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarm()..state['swarmBuddy'] = true;
    (server.state['conversations'] as List).add({
      ...conversationFixture('swarm-buddy-owner', 'Buddy'),
      'kind': 'swarm-buddy',
      'projectId': null,
      'buddyOwnerId': 'owner',
      'agentIds': <String>[],
    });
    setup?.call(server);
    final c = server.controller(
      account: 'owner',
      initial: {
        'tabId': 'tab',
        'projectsGroupOpen': true,
        'accountId': 'owner',
        'selectedId': 'swarm-buddy-owner',
      },
    );
    await tester.runAsync(c.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            paneStore: MemoryKeyValueStore(),
            board: true,
            rightPane: rightPane,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });
    return (c, server);
  }

  // Finding 1: opening a project put its Board in the middle and selected the Buddy chat for the right side, so the
  // Buddy's row lit up and the project's did not.
  testWidgets('a project\'s row is highlighted while its Board is open, not '
      'the Buddy\'s', (tester) async {
    final (c, _) = await showDesktop(tester);
    expect(_lit('super-swarm-buddy'), isTrue);
    await tester.tap(_key('super-group-lead'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'swarm-buddy-owner');
    expect(_lit('super-group-lead'), isTrue);
    expect(_lit('super-swarm-buddy'), isFalse);
    // Choosing the Buddy again puts its chat in the middle, and its row is the lit one.
    await tester.tap(_key('super-swarm-buddy'));
    await tester.pumpAndSettle();
    expect(_lit('super-swarm-buddy'), isTrue);
    expect(_lit('super-group-lead'), isFalse);
  });

  // Finding 3: a page or Manage in the middle turned the board layout off, and the Tasks pane with it.
  testWidgets('the Tasks pane stays on the right while Decisions, the '
      'Leaderboard or Manage holds the middle', (tester) async {
    await showDesktop(
      tester,
      rightPane: (_) => const Text('Tasks pane', key: ValueKey('tasks-pane')),
    );
    final tasks = find.descendant(
      of: _key('super-right-pane'),
      matching: _key('tasks-pane'),
    );
    expect(tasks, findsOneWidget);
    for (final row in [
      'super-decisions',
      'super-leaderboard',
      'super-manage',
    ]) {
      await tester.tap(_key(row));
      await tester.pumpAndSettle();
      expect(tasks, findsOneWidget, reason: row);
    }
  });

  // Finding 6: with this computer not connected yet, the box said to wait and try again, with only Close.
  group('Connect this computer', () {
    /// The agent box opened before this computer's Harness connection is up: the app knows only another computer.
    Future<(AppNotifier, Future<Map<String, dynamic>?>)> open(
      WidgetTester tester,
    ) async {
      final server = swarm();
      final c = server.controller(account: 'owner');
      addTearDown(c.dispose);
      await tester.runAsync(c.refresh);
      final app = createApp()
        ..status = AppStatus.authenticated
        ..currentUser = const CurrentUserProfile(
          id: 'owner',
          email: 'owner@example.com',
        );
      addTearDown(app.dispose);
      late BuildContext context;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (c) {
              context = c;
              return const SizedBox();
            },
          ),
        ),
      );
      var open = true;
      final result = showSwarmNewAgentDialog(
        context,
        controller: c,
        app: app,
        isCurrent: () => open,
      );
      addTearDown(() => open = false);
      // The box's spinner never settles: pump its opening alone.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Connect this computer'), findsOneWidget);
      return (app, result);
    }

    testWidgets('the box waits, and goes on by itself once this computer '
        'connects', (tester) async {
      final (app, _) = await open(tester);
      expect(find.text('Close'), findsNothing);
      app.machineStates['m']!.localOnly = true;
      app.notifyListeners();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Connect this computer'), findsNothing);
    });

    testWidgets('Open Machines closes it and opens Machines', (tester) async {
      final (app, result) = await open(tester);
      await tester.tap(find.text('Open Machines'));
      await tester.pumpAndSettle();
      expect(find.text('Connect this computer'), findsNothing);
      expect(app.machinesRequest, isNotNull);
      expect(await result, isNull);
    });
  });
}
