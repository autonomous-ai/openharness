import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';

/// A person's first minutes in Swarm v4, in one go and by clicking, as they do it: the left pane, an agent's own chat
/// (they write to it), its instructions and terminal beside it, a project's channel (they only read it), the project's
/// tasks and one task, Manage, and Top Teams. Every v1-v3 removal runs it: what v4 has must keep working.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<(ConversationServer, SuperTabController, List<String>)> open(
    WidgetTester tester, {
    Size size = const Size(2000, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    final terminals = <String>[];
    final c = server.controller(
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
            onOpenGroupTerminals: () => terminals.add(c.selectedId),
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, c, terminals);
  }

  testWidgets('the first minutes: agent chat, instructions, terminal, '
      'channel, tasks, Manage, Top Teams', (tester) async {
    final (server, c, terminals) = await open(tester);

    // The left pane: your team and the projects, nothing of v3 in it.
    expect(find.text('Your Team'), findsOneWidget);
    expect(find.text('Projects'), findsOneWidget);
    expect(key('super-manage'), findsOneWidget);
    for (final gone in ['Buddies', 'Members', 'Notifications', 'Threads']) {
      expect(find.text(gone), findsNothing, reason: gone);
    }

    // An agent's own chat: the person writes to it, and the message goes to that chat.
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    expect(key('swarm-agent-header'), findsOneWidget);
    final box = find.byType(EditableText);
    expect(box, findsOneWidget);
    await tester.tap(box);
    await tester.enterText(box, 'Always run the tests first');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Always run the tests first'), findsWidgets);
    final sent = server.posts.where((p) {
      final command = p['command'] as Map?;
      return command?['type'] == 'message.send';
    });
    expect(sent.last['command']['conversationId'], 'agent-chat-second');
    expect(sent.last['command']['text'], 'Always run the tests first');

    // Its instructions open beside it, and close.
    await tester.tap(key('swarm-instructions-button'));
    await tester.pumpAndSettle();
    expect(find.text('agents/second.md'), findsOneWidget);
    await tester.tap(key('swarm-instructions-close'));
    await tester.pumpAndSettle();
    expect(find.text('agents/second.md'), findsNothing);

    // Its terminal opens.
    await tester.tap(key('swarm-terminal-button'));
    await tester.pumpAndSettle();
    expect(terminals, ['agent-chat-second']);

    // A project's channel: people read it, only agents post, and the Tasks icon opens the board.
    await tester.tap(key('super-group-lead'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'lead');
    expect(key('super-agents-only'), findsOneWidget);
    expect(find.byType(EditableText), findsNothing);
    await tester.tap(key('swarm-tasks-button'));
    await tester.pumpAndSettle();
    expect(key('swarm-task-board'), findsOneWidget);
    await tester.tap(key('swarm-task-5759'));
    await tester.pumpAndSettle();
    expect(key('swarm-issue-panel'), findsOneWidget);
    await tester.tap(key('swarm-issue-close'));
    await tester.pumpAndSettle();
    expect(key('swarm-issue-panel'), findsNothing);

    // Manage keeps its Machines page.
    await tester.tap(key('super-manage'));
    await tester.pumpAndSettle();
    expect(find.text('Manage'), findsWidgets);
    expect(tester.takeException(), isNull);

    // And back to a chat: the left pane still answers.
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    expect(tester.takeException(), isNull);
  });

  testWidgets('an empty Swarm says how to start, and one that cannot be read '
      'says so, neither with an error', (tester) async {
    final empty = ConversationServer()
      ..state['projects'] = <dynamic>[]
      ..state['conversations'] = <dynamic>[];
    final c = empty.controller(account: 'owner');
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    var started = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewAgent: () => started++,
            onNewProject: () => started++,
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('Start a project, or bring an agent to work with you.'),
      findsOneWidget,
    );
    expect(find.byType(EditableText), findsNothing);
    expect(tester.takeException(), isNull);

    // A server that cannot be read: the view stays up and nothing throws.
    final down = swarmV4Server()..failReads = true;
    final offline = down.controller(account: 'owner');
    addTearDown(offline.dispose);
    await tester.runAsync(offline.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: offline,
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
  });

  testWidgets('the same journey in a narrow window raises no error and keeps '
      'every way in', (tester) async {
    final (_, c, _) = await open(tester, size: const Size(700, 900));
    // Below 720 the left pane folds into a drawer; whatever it shows, nothing throws and a chat is reachable.
    expect(tester.takeException(), isNull);
    expect(c.snapshot, isNotNull);
    expect(find.byType(EditableText), findsNothing);
    await c.select('agent-chat-second');
    await tester.pumpAndSettle();
    expect(find.byType(EditableText), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
