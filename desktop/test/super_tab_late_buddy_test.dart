import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Task #4704: opening a project's Board asks for the person's Buddy chat in the background, and when the server answered late the
/// app jumped there even if the person had since opened the project's chat or a terminal.
void main() {
  /// The Buddy chat is asked for, the reader moves on, and then the server answers.
  Future<(SuperTabController, String)> openLate(
    ConversationServer server,
    void Function(SuperTabController c) moveOn,
  ) async {
    final c = server.controller(account: 'peer');
    addTearDown(c.dispose);
    await c.refresh();
    expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNull);
    final held = server.holdCommands = Completer<void>();
    final asked = c.openBuddyChat(SuperTabController.kSwarmBuddyKey);
    await Future<void>.delayed(Duration.zero);
    moveOn(c);
    final where = c.selectedId;
    held.complete();
    server.holdCommands = null;
    await asked;
    return (c, where);
  }

  test(
    'a late answer does not pull the reader off the project chat they opened',
    () async {
      final (c, where) = await openLate(
        oneBuddySwarm(),
        (c) => c.select('lead'),
      );
      expect(where, 'lead');
      expect(c.selectedId, 'lead');
      // The chat was still made: it is there the next time they ask for it.
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNotNull);
    },
  );

  test(
    'a late answer does not pull the reader out of the terminal they opened',
    () async {
      final server = oneBuddySwarm();
      final (c, _) = await openLate(server, (c) {
        c.select('lead');
        c.selectTerminal(
          'lead',
          c.snapshot!.conversation('lead')!.agentIds.first,
        );
      });
      expect(c.selectedId, 'lead');
      expect(c.terminalAgent('lead'), isNotNull);
    },
  );

  test('an answer nobody moved away from still opens the Buddy chat', () async {
    final (c, _) = await openLate(oneBuddySwarm(), (_) {});
    expect(c.selectedId, 'swarm-buddy-peer');
  });

  testWidgets(
    'opening a Board, then the project chat, stays on the chat when the server answers',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1500, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = oneBuddySwarm();
      final c = server.controller(
        account: 'peer',
        initial: {
          'tabId': 'tab',
          'projectsGroupOpen': true,
          'accountId': 'peer',
          'selectedId': 'lead',
        },
      );
      await tester.runAsync(c.refresh);
      expect(c.buddyChat(SuperTabController.kSwarmBuddyKey), isNull);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac',
              board: true,
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
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pumpAndSettle();
      final held = server.holdCommands = Completer<void>();
      // The person opens the project: its Board shows, and the Buddy chat is asked for in the background.
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pump();
      // Then they open the project's chat before the server answers.
      await tester.tap(find.byKey(const ValueKey('super-board-tab-chat')));
      await tester.pump();
      expect(c.selectedId, 'lead');
      held.complete();
      server.holdCommands = null;
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      expect(c.selectedId, 'lead');
      expect(
        find.byKey(const ValueKey('super-board-tab-chat')),
        findsOneWidget,
      );
    },
  );
}
