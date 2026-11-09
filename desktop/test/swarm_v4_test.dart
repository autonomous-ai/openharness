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
  }) async {
    late SuperTabController c;
    await tester.binding.setSurfaceSize(const Size(1440, 900));
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

  testWidgets('Tasks lists the project\'s GitHub issues, read with gh; a card '
      'opens its issue beside the channel, at equal width, read-only', (
    tester,
  ) async {
    final calls = <List<String>>[];
    await show(tester, ghCalls: calls);
    await tester.tap(key('swarm-tasks-button'));
    await tester.pumpAndSettle();
    expect(key('swarm-task-list'), findsOneWidget);
    expect(calls.first.take(4), [
      'issue',
      'list',
      '--repo',
      'autonomous-ai/lampOS',
    ]);
    // Newest activity first: #5759 moved last.
    expect(
      tester.getTopLeft(find.text('#5759')).dy,
      lessThan(tester.getTopLeft(find.text('#5754')).dy),
    );
    expect(find.text('No bathroom-break reminder skill ships'), findsOneWidget);
    Finder inList(Finder f) =>
        find.descendant(of: key('swarm-task-list'), matching: f);
    expect(inList(find.textContaining('On it')), findsOneWidget);
    // Each card names the agent its builder:<name> label gives it.
    expect(inList(find.text('seventh')), findsOneWidget);
    expect(
      width(tester, 'super-right-pane'),
      moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
    );
    await tester.tap(find.text('#5759'));
    await tester.pumpAndSettle();
    expect(key('swarm-issue-panel'), findsOneWidget);
    expect(calls.last.take(3), ['issue', 'view', '5759']);
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
    expect(key('swarm-task-list'), findsOneWidget);
  });

  testWidgets('its person deletes an agent: right-click, Delete, confirm, gone', (
    tester,
  ) async {
    final c = await show(tester);
    // Its chat is the one open, as it is when a person deletes the agent they are talking to.
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    await tester.tap(key('super-agent-second'), buttons: kSecondaryButton);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Delete second?'), findsOneWidget);
    await tester.tap(key('delete-agent-confirm'));
    await tester.pumpAndSettle();
    expect(key('super-agent-second'), findsNothing);
    expect(key('super-agent-third'), findsOneWidget);
    // The view leaves the deleted agent's chat for another agent's.
    expect(c.selectedId, isNot('agent-chat-second'));
    expect(c.selectedId, startsWith('agent-chat-'));
    expect(find.text('Mac Studio · Claude Code'), findsOneWidget);
    // The read mark saves 200 ms after a chat is read.
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('Cancel keeps the agent, and a project\'s PM stays until its project goes', (
    tester,
  ) async {
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
  });

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
