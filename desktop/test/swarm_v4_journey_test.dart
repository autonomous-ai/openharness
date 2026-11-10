import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
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
    (server.state['people'] as List).add({
      'id': 'dee',
      'email': 'dee@example.com',
      'role': 'collaborator',
    });
    server.leaderboard = {
      'projectId': 'lead',
      'week': 0,
      'people': [
        {'personId': 'dee', 'points': 120, 'rank': 1},
        {'personId': 'owner', 'points': 12, 'rank': 2},
      ],
    };
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

    // Top Teams folds; a person in it opens the whole board.
    expect(key('super-human-dee'), findsNothing);
    await tester.tap(key('project-sidebar-humans'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-human-dee'));
    await tester.pumpAndSettle();
    expect(find.text('Leaderboard'), findsWidgets);
    expect(tester.takeException(), isNull);

    // Manage: Machines, Models, Devices and Swarm, each opening; no v3 Backlog or Scorecard, no crew on a machine.
    await tester.tap(key('super-manage'));
    await tester.pumpAndSettle();
    expect(find.text('Manage'), findsWidgets);
    for (final gone in ['backlog', 'scorecard']) {
      expect(key('super-manage-tab-$gone'), findsNothing, reason: gone);
    }
    expect(find.textContaining('crew'), findsNothing);
    for (final tab in ['models', 'swarm', 'machines']) {
      await tester.tap(key('super-manage-tab-$tab'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: tab);
    }
    expect(find.textContaining('crew'), findsNothing);

    // And back to a chat: the left pane still answers.
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'an agent waiting on its person is answered in its own chat: '
    'neither the project channel nor the task chat takes the person\'s words',
    (tester) async {
      final (server, c, _) = await open(tester);
      // A task chat from before v4: its agent asked its person a question, which is the only thing waiting.
      (server.state['conversations'] as List).add({
        ...conversationFixture('task-chat', 'Which build?'),
        'projectId': 'lead',
        'number': 7,
        'task': {
          'goal': 'Which build?',
          'changes': '',
          'constraints': '',
          'owns': <String>[],
        },
        'agentIds': ['second'],
        'assignment': {
          'id': 'work-7',
          'agentId': 'second',
          'status': 'needs_human',
          'askedOf': 'owner',
          'result': 'Which build do you want?',
        },
      });
      server.append('Which build do you want?', conversationId: 'task-chat');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'second',
        'name': 'second',
      };
      await tester.runAsync(c.refresh);
      await c.select('task-chat');
      await tester.pumpAndSettle();
      // The task chat is read here, with a way to the question and none to answer in it.
      expect(key('super-agents-only'), findsOneWidget);
      expect(find.byType(EditableText), findsNothing);
      expect(key('super-needs-human-second'), findsOneWidget);
      // The channel is the same.
      await c.select('lead');
      await tester.pumpAndSettle();
      expect(key('super-agents-only'), findsOneWidget);
      expect(find.byType(EditableText), findsNothing);
      // The answer goes to the agent's own chat, from the left pane.
      await tester.tap(key('super-agent-second'));
      await tester.pumpAndSettle();
      final box = find.byType(EditableText);
      expect(box, findsOneWidget);
      await tester.tap(box);
      await tester.enterText(box, 'The arm64 one');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      final sent = [
        for (final post in server.posts)
          if ((post['command'] as Map?)?['type'] == 'message.send')
            post['command'] as Map,
      ];
      expect(sent, isNotEmpty);
      expect(
        sent.map((m) => m['conversationId']),
        everyElement('agent-chat-second'),
        reason: 'no message of a person reaches the channel or a task chat',
      );
      expect(sent.single['text'], 'The arm64 one');
      // The read marks' save is on its way: let it land.
      await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets(
    'a Buddy chat from before v4 stays out of the left pane and of '
    'Option+Shift+Down, and a thread reply offers Also send, no New session',
    (tester) async {
      final (server, c, _) = await open(tester);
      // The person's Buddy chat in the project, unread, on a server that still offers thread sessions.
      server.state['threadSessions'] = true;
      server.state['sessionsFromChat'] = true;
      (server.state['conversations'] as List).add({
        ...conversationFixture('buddy-owner-lead', "owner's Buddy"),
        'projectId': 'lead',
        'kind': 'buddy',
        'buddyOwnerId': 'owner',
      });
      server.append('Your Buddy is ready', conversationId: 'buddy-owner-lead');
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': 'second',
        'name': 'second',
      };
      (server.state['conversations'] as List)
              .cast<Map>()
              .last['lastMessageSequence'] =
          1;
      server.append('Ship the build?', conversationId: 'agent-chat-second');
      final root = server.messages.last['id'] as String;
      await tester.runAsync(c.refresh);
      await tester.pumpAndSettle();

      expect(find.text("owner's Buddy"), findsNothing);
      expect(superTabSidebarOrder(c), isNot(contains('buddy-owner-lead')));
      // Option+Shift+Down goes to the next unread chat the left pane lists: never the Buddy chat.
      await tester.tap(key('super-group-lead'));
      await tester.pumpAndSettle();
      for (var i = 0; i < 3; i++) {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pumpAndSettle();
        expect(c.selectedId, isNot('buddy-owner-lead'));
      }

      // A thread in the agent's own chat: its reply box has Also send and nothing of a Buddy session.
      await tester.tap(key('super-agent-second'));
      await tester.pumpAndSettle();
      c.openThread(root);
      await tester.pumpAndSettle();
      expect(key('super-thread-composer'), findsOneWidget);
      expect(key('super-thread-also-send'), findsOneWidget);
      expect(key('super-thread-new-session'), findsNothing);
      await tester.enterText(key('super-thread-composer'), 'Yes, ship it');
      await tester.pump();
      await tester.tap(key('super-thread-send'));
      await tester.pumpAndSettle();
      final reply = server.posts
          .map((p) => p['command'] as Map)
          .lastWhere((m) => m['type'] == 'message.send');
      expect(reply['conversationId'], 'agent-chat-second');
      expect(reply['replyTo'], root);
      expect(reply.containsKey('newSession'), isFalse);
      expect(tester.takeException(), isNull);
      // The read marks' save is on its way: let it land.
      await tester.pump(const Duration(seconds: 1));
    },
  );

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
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(offline.error, isNotNull);
    expect(find.text(offline.error!), findsWidgets);
  });

  testWidgets('in a narrow window the left pane is a drawer, and an agent '
      'opens from it', (tester) async {
    final (_, c, _) = await open(tester, size: const Size(700, 900));
    expect(tester.takeException(), isNull);
    expect(find.byType(EditableText), findsNothing);
    await tester.tap(find.byTooltip('Conversations'));
    await tester.pumpAndSettle();
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'agent-chat-second');
    expect(find.byType(EditableText), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
