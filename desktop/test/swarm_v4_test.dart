import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'package:flutter/gestures.dart';

import 'support/swarm_v4_data.dart';

/// Swarm v4 (anh Dee 2026-11-08), clicked through as a person does: a project's channel that only agents post in,
/// its tasks as cards that open their threads, and an agent's own chat with its instructions and terminal beside it.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<String>? terminals,
    List<List<String>>? ghCalls,
    Size size = const Size(1440, 900),
  }) async {
    late SuperTabController c;
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    c = swarmV4Server().controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
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
            // The workspace shows the selected chat's terminals beside it.
            onOpenGroupTerminals: () => terminals?.add(c.selectedId),
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(calls: ghCalls),
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  double width(WidgetTester tester, String k) => tester.getSize(key(k)).width;

  testWidgets('a project\'s channel: people read it, only agents post', (
    tester,
  ) async {
    final c = await show(tester);
    await tester.tap(key('super-group-lead'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'lead');
    expect(key('super-agents-only'), findsOneWidget);
    expect(
      find.text(
        'Only agents post here. To change what happens, talk to your agents.',
      ),
      findsOneWidget,
    );
    expect(find.byType(EditableText), findsNothing);
  });

  testWidgets(
    'Tasks is a board of the project\'s GitHub issues, read with gh; a '
    'card opens its issue beside the channel, at equal width, read-only',
    (tester) async {
      final calls = <List<String>>[];
      await show(tester, ghCalls: calls, size: const Size(2000, 900));
      await tester.tap(key('swarm-tasks-button'));
      await tester.pumpAndSettle();
      expect(key('swarm-task-board'), findsOneWidget);
      // One GraphQL read for the board, of the project's repository.
      expect(calls.first.take(2), ['api', 'graphql']);
      expect(calls.first, containsAll(['owner=autonomous-ai', 'name=lampOS']));
      Finder inBoard(Finder f) =>
          find.descendant(of: key('swarm-task-board'), matching: f);
      // Three columns: nobody has it, it is for an agent, someone is on it.
      for (final name in ['To do', 'Assigned', 'On it']) {
        expect(key('swarm-task-column-$name'), findsOneWidget);
      }
      Finder inColumn(String name, Finder f) =>
          find.descendant(of: key('swarm-task-column-$name'), matching: f);
      expect(inColumn('To do', key('swarm-task-5760')), findsOneWidget);
      expect(inColumn('Assigned', key('swarm-task-5754')), findsOneWidget);
      expect(inColumn('On it', key('swarm-task-5759')), findsOneWidget);
      // A card holds what github.com's list shows: labels in their colours, who opened it, how many comments.
      Finder inCard(int n, Finder f) =>
          find.descendant(of: key('swarm-task-$n'), matching: f);
      expect(inCard(5754, key('swarm-label-builder:seventh')), findsOneWidget);
      expect(inCard(5759, key('swarm-label-status:taken')), findsOneWidget);
      expect(
        inCard(5759, key('swarm-label-builder:first builder')),
        findsOneWidget,
      );
      expect(inCard(5754, find.textContaining('deehw')), findsOneWidget);
      expect(inCard(5759, find.textContaining('69tc')), findsOneWidget);
      expect(key('swarm-task-comments-5754'), findsOneWidget);
      expect(tester.widget<Text>(key('swarm-task-comments-5754')).data, '6');
      expect(tester.widget<Text>(key('swarm-task-comments-5759')).data, '3');
      // No comments: no count.
      expect(key('swarm-task-comments-5760'), findsNothing);
      // Each card names the agent its builder:<name> label gives it, by face.
      expect(
        inBoard(find.text('No bathroom-break reminder skill ships')),
        findsOneWidget,
      );
      expect(
        width(tester, 'super-right-pane'),
        moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
      );
      await tester.tap(key('swarm-task-5759'));
      await tester.pumpAndSettle();
      expect(key('swarm-issue-panel'), findsOneWidget);
      // Its newest comments: two of three, the rest one tap away.
      expect(
        calls.where((c) => c.contains('number=5759') && c.contains('last=30')),
        isNotEmpty,
      );
      expect(
        find.descendant(
          of: key('swarm-issue-panel'),
          matching: find.text('#5759'),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Score both rows again'), findsOneWidget);
      // Each comment is named by the agent that signed it, its GitHub account beside it.
      expect(find.textContaining('Migrate'), findsWidgets);
      expect(find.textContaining('First builder'), findsWidgets);
      expect(key('swarm-label-status:taken'), findsWidgets);
      expect(key('swarm-issue-opened'), findsOneWidget);
      expect(find.text('1 earlier comment'), findsOneWidget);
      expect(find.textContaining('lamp check'), findsNothing);
      await tester.tap(key('swarm-issue-show-earlier'));
      await tester.pumpAndSettle();
      expect(find.textContaining('lamp check'), findsOneWidget);
      expect(key('swarm-issue-earlier'), findsNothing);
      expect(
        calls.where((c) => c.contains('last=100') && c.contains('before=c1')),
        hasLength(1),
      );
      expect(key('swarm-issue-agents-only'), findsOneWidget);
      expect(key('swarm-issue-github'), findsOneWidget);
      expect(find.byType(EditableText), findsNothing);
      expect(
        width(tester, 'super-right-pane'),
        moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
      );
      await tester.tap(key('swarm-issue-close'));
      await tester.pumpAndSettle();
      expect(key('swarm-issue-panel'), findsNothing);
      expect(key('swarm-task-board'), findsOneWidget);
    },
  );

  testWidgets(
    'its person deletes an agent: right-click, Delete, confirm, gone',
    (tester) async {
      await show(tester);
      await tester.tap(key('super-agent-second'), buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(find.text('Delete second?'), findsOneWidget);
      await tester.tap(key('delete-agent-confirm'));
      await tester.pumpAndSettle();
      expect(key('super-agent-second'), findsNothing);
      expect(key('super-agent-third'), findsOneWidget);
    },
  );

  testWidgets(
    'Cancel keeps the agent, and a project\'s PM stays until its project goes',
    (tester) async {
      await show(tester);
      await tester.tap(key('super-agent-second'), buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(key('super-agent-second'), findsOneWidget);
      await tester.tap(
        key('super-agent-first builder'),
        buttons: kSecondaryButton,
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Delete the project first.'), findsOneWidget);
    },
  );

  testWidgets('an agent opens its own chat, where its person writes to it', (
    tester,
  ) async {
    final c = await show(tester);
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    expect(key('swarm-agent-header'), findsOneWidget);
    expect(find.text('Mac Studio · Claude Code'), findsOneWidget);
    expect(
      find.text('Written to agents/second.md and pushed.'),
      findsOneWidget,
    );
    expect(key('super-agents-only'), findsNothing);
    expect(find.byType(EditableText), findsOneWidget);
  });

  testWidgets('Instructions opens agents/<name>.md beside the chat, and × '
      'closes it', (tester) async {
    await show(tester);
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-instructions-button'));
    await tester.pumpAndSettle();
    expect(find.text('agents/second.md'), findsOneWidget);
    // This test's agent runs on no computer the app knows, so its file is read where it runs.
    expect(find.text('Open it on second\'s computer.'), findsOneWidget);
    expect(
      width(tester, 'super-right-pane'),
      moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
    );
    await tester.tap(key('swarm-instructions-close'));
    await tester.pumpAndSettle();
    expect(find.text('agents/second.md'), findsNothing);
  });

  testWidgets('its person renames an agent by its name in the bar', (
    tester,
  ) async {
    await show(tester);
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-agent-name'));
    await tester.pumpAndSettle();
    expect(key('agent-rename-input'), findsOneWidget);
  });

  testWidgets('Terminal opens the agent\'s terminal', (tester) async {
    final opened = <String>[];
    await show(tester, terminals: opened);
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-terminal-button'));
    await tester.pumpAndSettle();
    expect(opened, ['agent-chat-second']);
  });
}
