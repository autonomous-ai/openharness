import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/swarm_v4_data.dart';

/// Swarm v4 (anh Dee 2026-11-08), clicked through as a person does: a project's channel that only agents post in,
/// its tasks as cards that open their threads, and an agent's own chat with its instructions and terminal beside it.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<String>? terminals,
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

  testWidgets('Tasks lists the channel\'s threads; a card opens its thread '
      'beside the channel, at equal width, read-only', (tester) async {
    await show(tester);
    await tester.tap(key('swarm-tasks-button'));
    await tester.pumpAndSettle();
    expect(key('swarm-task-list'), findsOneWidget);
    expect(find.text('#2191'), findsOneWidget);
    expect(find.text('#3923'), findsOneWidget);
    expect(find.text('5 replies'), findsWidgets);
    expect(
      width(tester, 'super-right-pane'),
      moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
    );
    await tester.tap(find.text('#2191'));
    await tester.pumpAndSettle();
    expect(key('super-thread-panel'), findsOneWidget);
    expect(
      find.descendant(
        of: key('super-thread-panel'),
        matching: find.text('#2191'),
      ),
      findsOneWidget,
    );
    expect(find.text('Merged #4905 in train 549.'), findsOneWidget);
    expect(key('super-thread-agents-only'), findsOneWidget);
    expect(
      width(tester, 'super-right-pane'),
      moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
    );
    await tester.tap(key('super-thread-close'));
    await tester.pumpAndSettle();
    expect(key('super-thread-panel'), findsNothing);
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
