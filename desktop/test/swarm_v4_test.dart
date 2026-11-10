import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/swarm_layout.dart';
import 'package:harness/super_tabs/agent_instructions.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/pull_chip.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/super_tabs/view.dart';

import 'package:flutter/gestures.dart';

import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';

/// Swarm v4 (anh Dee 2026-11-08), clicked through as a person does: a project's channel that only agents post in,
/// its tasks as cards that open their threads, and an agent's own chat with its instructions and terminal beside it.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<String>? terminals,
    List<List<String>>? ghCalls,
    SwarmV4Computer? computer,
    Size size = const Size(1440, 900),
    void Function(ConversationServer server)? prepare,
  }) async {
    late SuperTabController c;
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    prepare?.call(server);
    c = server.controller(
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
            // The workspace shows the selected chat's terminals beside it.
            onOpenGroupTerminals: () => terminals?.add(c.selectedId),
            machineName: (_) => 'Mac Studio',
            github: swarmV4GitHub(calls: ghCalls),
            instructions: computer?.link,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  double width(WidgetTester tester, String k) => tester.getSize(key(k)).width;

  testWidgets(
    'A project\'s menu holds only what v4 has: its settings (rename, details, delete), and no Notifications: it is agent to agent only',
    (tester) async {
      await show(tester);
      await tester.tap(key('super-project-menu'));
      await tester.pumpAndSettle();
      expect(key('super-notify-menu'), findsNothing);
      expect(find.text('Notifications'), findsNothing);
      expect(find.text('Project settings…'), findsOneWidget);
      // The v3 items are gone from v4's menu: status, the pull-request page, the instructions document, the crew, GitHub sharing.
      for (final gone in [
        'Status',
        'Pull requests',
        'Instructions',
        'Crew',
        'Sharing',
      ]) {
        expect(find.text(gone), findsNothing, reason: gone);
      }
      await tester.tap(find.text('Project settings…'));
      await tester.pumpAndSettle();
      for (final kept in [
        'Rename project',
        'Project details',
        'Delete Project',
      ]) {
        expect(find.text(kept), findsOneWidget, reason: kept);
      }
      // And the v3 rows of its settings: the rules record, who may chat, archived conversations.
      for (final gone in [
        'Project rules',
        'People',
        'Archived conversations',
      ]) {
        expect(find.text(gone), findsNothing, reason: gone);
      }
    },
  );

  testWidgets('a long message in an agent\'s chat shows whole, with no More', (
    tester,
  ) async {
    final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
        .join('\n\n');
    await show(
      tester,
      prepare: (server) {
        server.append(long, conversationId: 'agent-chat-second', agent: true);
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'second',
          'name': 'second',
        };
      },
    );
    await tester.tap(key('super-agent-second'));
    await tester.pumpAndSettle();
    expect(find.text('More'), findsNothing);
    expect(find.text('Line 1 of the plan.').hitTestable(), findsOneWidget);
    expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
  });

  testWidgets(
    'a 👀 the host left on a message draws no chip, and nothing offers a reaction',
    (tester) async {
      late String id;
      await show(
        tester,
        prepare: (server) {
          final message = server.messages.firstWhere(
            (m) => m['conversationId'] == 'agent-chat-second',
          );
          id = message['id'] as String;
          // The receipt the host's agent writes under a person's message, as the backend still sends it.
          message['reactions'] = [
            {
              'emoji': 'eyes',
              'count': 1,
              'by': [
                {'kind': 'agent', 'id': 'second'},
              ],
            },
          ];
        },
      );
      await tester.tap(key('super-agent-second'));
      await tester.pumpAndSettle();
      final row = key('super-message-$id');
      expect(row, findsOneWidget);
      // A person's mouse over the message shows the actions it offers.
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      addTearDown(mouse.removePointer);
      await mouse.moveTo(tester.getCenter(row));
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: row, matching: find.byTooltip('Copy message')),
        findsOneWidget,
      );
      expect(find.text('👀'), findsNothing);
      expect(find.byTooltip('Add reaction'), findsNothing);
    },
  );

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
      // A task's open pull request, beside its number: where it stands by the rule Harness merges by. None, no chip.
      expect(inCard(5759, find.text('#5770 Merging')), findsOneWidget);
      expect(inCard(5754, find.byType(SwarmPullChip)), findsNothing);
      expect(inCard(5760, find.byType(SwarmPullChip)), findsNothing);
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
      // Its pull request under its title, with Open.
      expect(
        find.descendant(
          of: key('swarm-issue-pull'),
          matching: find.text('#5770 Merging'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-issue-pull-open'), findsOneWidget);
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
    'a task\'s chat holds what its pull request said, in time order with its issue\'s comments, each with the PR\'s number',
    (tester) async {
      await show(tester, size: const Size(2000, 900));
      await tester.tap(key('swarm-tasks-button'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-task-5759'));
      await tester.pumpAndSettle();
      Finder inPanel(Finder f) =>
          find.descendant(of: key('swarm-issue-panel'), matching: f);
      double top(Finder f) => tester.getTopLeft(f).dy;
      final taking = inPanel(find.textContaining('taking this one'));
      final opened = inPanel(key('swarm-issue-opened-5770'));
      final line = inPanel(find.textContaining('keep the old row name too'));
      final read = inPanel(find.textContaining('READ-OK f6edb44'));
      for (final post in [taking, opened, line, read]) {
        expect(post, findsOneWidget);
      }
      // The issue's comment, then the pull request opened, its line comment and its READ-OK, as they were written.
      expect(top(taking), lessThan(top(opened)));
      expect(top(opened), lessThan(top(line)));
      expect(top(line), lessThan(top(read)));
      expect(tester.widget<Text>(opened).data, startsWith('PR #5770 opened'));
      // Each of the pull request's posts says which pull request it is on, and a line comment where.
      expect(
        inPanel(find.textContaining('PR #5770', findRichText: true)),
        findsNWidgets(3),
      );
      expect(
        inPanel(find.textContaining('rows.py, line 40', findRichText: true)),
        findsOneWidget,
      );
      // An open pull request has no merged line yet.
      expect(key('swarm-issue-merged-5770'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'its person deletes an agent: right-click, Delete, confirm, gone',
    (tester) async {
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
    expect(find.text('Open it on Mac Studio.'), findsOneWidget);
    expect(
      width(tester, 'super-right-pane'),
      moreOrLessEquals(width(tester, 'super-center-pane'), epsilon: 2),
    );
    expect(
      tester.getRect(key('swarm-instructions-close')).right,
      moreOrLessEquals(
        tester.getRect(find.byType(SwarmAgentInstructions)).right -
            SwarmLayout.barSide,
        epsilon: 1,
      ),
    );
    await tester.tap(key('swarm-instructions-close'));
    await tester.pumpAndSettle();
    expect(find.text('agents/second.md'), findsNothing);
  });

  testWidgets(
    'Instructions of an agent from before v4 are named for what its person calls it, and say where its file is',
    (tester) async {
      // A v3 PM: its harness name is Lead, its person calls it Faye, and it runs on Mac 3.
      final faye = SuperTabAgent.fromJson({
        'id': 'faye',
        'name': 'Lead',
        'displayName': 'Faye',
        'machineId': 'mac3',
        'harnessId': 'h',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      });
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SwarmAgentInstructions(
              agent: faye,
              machineName: 'Mac 3',
              onClose: () {},
            ),
          ),
        ),
      );
      expect(find.text('agents/Faye.md'), findsOneWidget);
      expect(find.text('Open it on Mac 3.'), findsOneWidget);
      expect(find.textContaining('Lead'), findsNothing);
    },
  );

  /// The first builder's chat with its Instructions open, its file as its computer holds it.
  Future<void> openInstructions(WidgetTester tester) async {
    await tester.tap(key('super-agent-first builder'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-instructions-button'));
    await tester.pumpAndSettle();
  }

  const fileKey = 'session-first builder/first builder';

  testWidgets(
    'Instructions\' Edit and × end the header at the pane\'s right edge, and so do Cancel and Save',
    (tester) async {
      final computer = SwarmV4Computer(
        files: {'session-second/Kai': 'Answer in Vietnamese.\n'},
      );
      await show(
        tester,
        computer: computer,
        // A short name makes a short title, which left the most room unused when the buttons did not take the rest.
        prepare: (server) =>
            (server.state['agents'] as List)
                    .cast<Map<String, dynamic>>()
                    .firstWhere((a) => a['id'] == 'second')['displayName'] =
                'Kai',
      );
      await tester.tap(key('super-agent-second'));
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-instructions-button'));
      await tester.pumpAndSettle();
      expect(find.text('agents/Kai.md'), findsOneWidget);
      final edge =
          tester.getRect(find.byType(SwarmAgentInstructions)).right -
          SwarmLayout.barSide;
      Rect at(String k) => tester.getRect(key(k));
      // The title takes what the buttons leave: they end at the header's own padding, not short of it.
      expect(
        at('swarm-instructions-close').right,
        moreOrLessEquals(edge, epsilon: 1),
      );
      expect(
        at('swarm-instructions-close').left -
            at('swarm-instructions-edit').right,
        lessThan(8),
      );
      expect(
        tester.getRect(find.text('agents/Kai.md')).left,
        lessThan(at('swarm-instructions-edit').left),
      );
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(
        at('swarm-instructions-close').right,
        moreOrLessEquals(edge, epsilon: 1),
      );
      expect(
        at('swarm-instructions-close').left -
            at('swarm-instructions-save').right,
        lessThan(8),
      );
      expect(
        at('swarm-instructions-save').left -
            at('swarm-instructions-cancel').right,
        lessThan(8),
      );
    },
  );

  testWidgets(
    'A very long name and a file not written yet: the title gives way, and nothing overflows on the narrowest pane there is',
    (tester) async {
      const name =
          'Second \u{2728} who owns voice, privacy, the offline queue and every lamp in lampOS, whatever it takes';
      final agent = SuperTabAgent.fromJson({
        'id': 'second',
        'name': 'second',
        'displayName': name,
        'machineId': 'host',
        'harnessId': 'session-second',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      });
      // Half of what a 1080 pixel window keeps for the chat and its pane, the least a pane opens at.
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: Align(
              alignment: Alignment.centerLeft,
              child: SizedBox(
                width: 390,
                child: SwarmAgentInstructions(
                  agent: agent,
                  machineName: 'Mac Studio',
                  onClose: () {},
                  link: SwarmV4Computer().link,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('No instructions yet'), findsOneWidget);
      final edge =
          tester.getRect(find.byType(SwarmAgentInstructions)).right -
          SwarmLayout.barSide;
      Rect at(String k) => tester.getRect(key(k));
      expect(
        tester.getRect(find.text('agents/$name.md')).right,
        lessThanOrEqualTo(at('swarm-instructions-edit').left),
      );
      expect(
        at('swarm-instructions-close').right,
        moreOrLessEquals(edge, epsilon: 1),
      );
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.text('agents/$name.md')).right,
        lessThanOrEqualTo(at('swarm-instructions-cancel').left),
      );
      expect(
        at('swarm-instructions-close').right,
        moreOrLessEquals(edge, epsilon: 1),
      );
      expect(tester.takeException(), isNull);
    },
  );

  // The way through anh Dee's screenshots (2026-11-09), walked as a person walks it at the window sizes the app is used at:
  // the project's menu, an agent's chat, its instructions. A pane beside the chat opens from 1080 pixels wide.
  for (final size in const [Size(1440, 900), Size(1024, 700), Size(700, 800)]) {
    testWidgets(
      'a person walks the menu, the chat and the instructions at ${size.width.toInt()}x${size.height.toInt()}',
      (tester) async {
        final long = [for (var i = 1; i <= 14; i++) 'Line $i of the plan.']
            .join('\n\n');
        final computer = SwarmV4Computer(
          files: {'session-second/second': 'Answer in Vietnamese.\n'},
        );
        await show(
          tester,
          size: size,
          computer: computer,
          prepare: (server) {
            server.append(
              long,
              conversationId: 'agent-chat-second',
              agent: true,
            );
            server.messages.last['author'] = {
              'kind': 'agent',
              'id': 'second',
              'name': 'second',
            };
            server.append(
              'Thanks \u{1F680} tell me when it is merged',
              conversationId: 'agent-chat-second',
            );
            // What the host's agent leaves under a person's message, as the backend still sends it.
            server.messages.last['reactions'] = [
              for (final emoji in ['eyes', 'check'])
                {
                  'emoji': emoji,
                  'count': 1,
                  'by': [
                    {'kind': 'agent', 'id': 'second'},
                  ],
                },
            ];
          },
        );
        // The project's menu holds its settings alone.
        await tester.tap(key('super-project-menu'));
        await tester.pumpAndSettle();
        expect(key('super-notify-menu'), findsNothing);
        expect(find.text('Project settings…'), findsOneWidget);
        await tester.tap(key('super-project-menu'));
        await tester.pumpAndSettle();
        expect(find.text('Project settings…'), findsNothing);
        // The agent's chat, from the list a narrow window keeps behind its button.
        if (size.width < 720) {
          await tester.tap(find.byTooltip('Conversations'));
          await tester.pumpAndSettle();
        }
        await tester.tap(key('super-agent-second'));
        await tester.pumpAndSettle();
        expect(key('swarm-agent-header'), findsOneWidget);
        // Its long answer shows whole; its person's reply has no chip under it, and no picker when the mouse is on it.
        expect(find.text('More'), findsNothing);
        expect(find.text('Line 14 of the plan.').hitTestable(), findsOneWidget);
        final reply = find.textContaining('tell me when it is merged');
        expect(reply, findsOneWidget);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        addTearDown(mouse.removePointer);
        await mouse.moveTo(tester.getCenter(reply));
        await tester.pumpAndSettle();
        expect(find.byTooltip('Copy message'), findsWidgets);
        for (final gone in ['👀', '✅']) {
          expect(find.text(gone), findsNothing, reason: gone);
        }
        expect(find.byTooltip('Add reaction'), findsNothing);
        if (size.width >= 1080) {
          // Its instructions open beside it; their buttons end the header, through clicks made faster than the view draws.
          for (var i = 0; i < 5; i++) {
            await tester.tap(key('swarm-instructions-button'));
            await tester.pump();
          }
          await tester.pumpAndSettle();
          expect(find.text('agents/second.md'), findsOneWidget);
          final edge =
              tester.getRect(find.byType(SwarmAgentInstructions)).right -
              SwarmLayout.barSide;
          expect(
            tester.getRect(key('swarm-instructions-close')).right,
            moreOrLessEquals(edge, epsilon: 1),
          );
          for (var i = 0; i < 3; i++) {
            await tester.tap(key('swarm-instructions-edit'));
            await tester.pump();
            await tester.tap(key('swarm-instructions-cancel'));
            await tester.pump();
          }
          await tester.pumpAndSettle();
          expect(find.textContaining('Answer in Vietnamese.'), findsOneWidget);
          await tester.tap(key('swarm-instructions-close'));
          await tester.pumpAndSettle();
          expect(find.text('agents/second.md'), findsNothing);
        }
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'Instructions are read from the agent\'s own computer, and its person edits and saves them there',
    (tester) async {
      final computer = SwarmV4Computer(
        files: {fileKey: 'Answer in Vietnamese.\n'},
      );
      await show(tester, computer: computer);
      await openInstructions(tester);
      expect(find.text('agents/first builder.md'), findsOneWidget);
      expect(find.textContaining('Answer in Vietnamese.'), findsOneWidget);
      // Asked of the computer the agent runs on, by its harness and the name its person calls it: not of GitHub.
      expect(computer.requests, hasLength(1));
      final (machine, type, payload) = computer.requests.single;
      expect(machine, 'host');
      expect(type, 'agent_instructions_read');
      expect(payload, {
        'agentId': 'session-first builder',
        'name': 'first builder',
      });
      expect(key('swarm-instructions-save'), findsNothing);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(key('swarm-instructions-field'))
            .controller!
            .text,
        'Answer in Vietnamese.\n',
      );
      await tester.enterText(
        key('swarm-instructions-field'),
        'Answer in Vietnamese.\nKeep posts short.\n',
      );
      await tester.pump();
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      // The save names the version it was made from, so a change since is not written over.
      final write = computer.requests.last;
      expect(write.$2, 'agent_instructions_write');
      expect(write.$3['text'], 'Answer in Vietnamese.\nKeep posts short.\n');
      expect(
        write.$3['version'],
        SwarmV4Computer.versionOf('Answer in Vietnamese.\n'),
      );
      expect(
        computer.files[fileKey],
        'Answer in Vietnamese.\nKeep posts short.\n',
      );
      expect(key('swarm-instructions-field'), findsNothing);
      expect(find.textContaining('Keep posts short.'), findsOneWidget);
      // Saved again from the version it just made.
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      await tester.enterText(
        key('swarm-instructions-field'),
        'Only Vietnamese.',
      );
      await tester.pump();
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(computer.files[fileKey], 'Only Vietnamese.');
      expect(key('swarm-instructions-field'), findsNothing);
      expect(find.text('Only Vietnamese.'), findsOneWidget);
    },
  );

  testWidgets('Cancel leaves the file as it was, and Save waits for a change', (
    tester,
  ) async {
    final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'});
    await show(tester, computer: computer);
    await openInstructions(tester);
    await tester.tap(key('swarm-instructions-edit'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<DesktopPill>(key('swarm-instructions-save')).onPressed,
      isNull,
    );
    await tester.enterText(
      key('swarm-instructions-field'),
      'Be brief. Be kind.',
    );
    await tester.pump();
    await tester.tap(key('swarm-instructions-cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Be brief.'), findsOneWidget);
    expect(computer.files[fileKey], 'Be brief.');
    expect(computer.requests.map((r) => r.$2), ['agent_instructions_read']);
  });

  testWidgets(
    'A file changed on its computer since it was read is not written over, and what was typed stays',
    (tester) async {
      final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'});
      await show(tester, computer: computer);
      await openInstructions(tester);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      await tester.enterText(
        key('swarm-instructions-field'),
        'Be brief. Be kind.',
      );
      await tester.pump();
      // The agent wrote it meanwhile.
      computer.files[fileKey] = 'Be brief. Cite sources.';
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-save-error')).data,
        'It changed on Mac Studio. Save again to replace it.',
      );
      expect(computer.files[fileKey], 'Be brief. Cite sources.');
      expect(
        tester
            .widget<TextField>(key('swarm-instructions-field'))
            .controller!
            .text,
        'Be brief. Be kind.',
      );
      // The new version was read: a second Save replaces it on purpose, from that version.
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(computer.files[fileKey], 'Be brief. Be kind.');
      expect(key('swarm-instructions-field'), findsNothing);
    },
  );

  testWidgets(
    'A text over 64 KB is refused as it is saved, counted in bytes, with nothing sent and nothing cut',
    (tester) async {
      final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'});
      await show(tester, computer: computer);
      await openInstructions(tester);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      // 40,000 characters of two bytes each: under 65,536 characters, over 65,536 bytes.
      final big = 'é' * 40000;
      await tester.enterText(key('swarm-instructions-field'), big);
      await tester.pump();
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-save-error')).data,
        'Too long to save. Keep it under 64 KB.',
      );
      expect(computer.requests.map((r) => r.$2), ['agent_instructions_read']);
      // The field kept every character the person typed.
      expect(
        tester
            .widget<TextField>(key('swarm-instructions-field'))
            .controller!
            .text,
        big,
      );
    },
  );

  testWidgets('An agent with no file yet says so, and Save makes it', (
    tester,
  ) async {
    final computer = SwarmV4Computer();
    await show(tester, computer: computer);
    await openInstructions(tester);
    expect(
      find.text(
        'No instructions yet. Tell first builder how you want it to work, and it writes them here.',
      ),
      findsOneWidget,
    );
    await tester.tap(key('swarm-instructions-edit'));
    await tester.pumpAndSettle();
    await tester.enterText(key('swarm-instructions-field'), 'Be brief.');
    await tester.pump();
    await tester.tap(key('swarm-instructions-save'));
    await tester.pumpAndSettle();
    // "No file" is version '', which only a computer that still has none accepts.
    expect(computer.requests.last.$3['version'], '');
    expect(computer.files[fileKey], 'Be brief.');
    expect(find.text('Be brief.'), findsOneWidget);
  });

  testWidgets(
    'Instructions show the agent\'s folder too, read only under its own file: Edit and Save change the agent\'s own file alone',
    (tester) async {
      // As lampOS's Faye is: no file of its own yet, and an AGENTS.md and a CLAUDE.md in its folder.
      final computer = SwarmV4Computer()
        ..shared = [
          {'name': 'AGENTS.md', 'text': 'Ship small.\nSay what you checked.'},
          {
            'name': 'CLAUDE.md',
            'text': 'Read AGENTS.md first.',
            'truncated': true,
          },
        ]
        ..skipped = [
          {'name': 'CLAUDE.local.md', 'why': 'not_text'},
        ];
      await show(tester, computer: computer);
      await openInstructions(tester);
      expect(find.text('agents/first builder.md'), findsOneWidget);
      // Nothing of its own, so no empty words: its folder's files are what there is to read.
      expect(find.textContaining('No instructions yet'), findsNothing);
      expect(find.text('AGENTS.md'), findsOneWidget);
      expect(find.text('Ship small.\nSay what you checked.'), findsOneWidget);
      expect(find.text('CLAUDE.md'), findsOneWidget);
      expect(find.text('Cut at 64 KB.'), findsOneWidget);
      expect(find.text('CLAUDE.local.md isn\'t text.'), findsOneWidget);
      // Read only: there is nothing to type into until Edit.
      final inPane = find.descendant(
        of: find.byType(SwarmAgentInstructions),
        matching: find.byType(TextField),
      );
      expect(inPane, findsNothing);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      expect(find.text('AGENTS.md'), findsNothing);
      await tester.enterText(key('swarm-instructions-field'), 'Be brief.');
      await tester.pump();
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      // Its own file was made, and only it: the request carries its text and no folder file.
      final write = computer.requests.last;
      expect(write.$2, 'agent_instructions_write');
      expect(write.$3.keys.toSet(), {'agentId', 'name', 'text', 'version'});
      expect(computer.files[fileKey], 'Be brief.');
      // Its file above, its folder's under it, as before.
      expect(find.text('Be brief.'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('Be brief.')).dy,
        lessThan(tester.getTopLeft(find.text('AGENTS.md')).dy),
      );
      expect(find.text('CLAUDE.md'), findsOneWidget);
      await tester.tap(key('swarm-instructions-close'));
      await tester.pumpAndSettle();
      expect(find.text('agents/first builder.md'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Nothing is sent when a daemon on the way would send it unsealed, and a path that is not a plain file is said',
    (tester) async {
      final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'})
        ..gate = 'UPDATE_HERE';
      await show(tester, computer: computer);
      await openInstructions(tester);
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'Update Harness on this computer.',
      );
      // The privacy rule: not one request left, read or write.
      expect(computer.requests, isEmpty);
      computer
        ..gate = null
        ..refuse = 'UNSAFE_PATH';
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'agents/first builder.md on Mac Studio isn\'t a plain file.',
      );
      computer.refuse = 'NOT_UTF8';
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'agents/first builder.md on Mac Studio isn\'t text.',
      );
    },
  );

  testWidgets(
    'A save whose answer was lost, saved again, is told changed by the computer and read as saved when the file is what was typed',
    (tester) async {
      final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'});
      await show(tester, computer: computer);
      await openInstructions(tester);
      await tester.tap(key('swarm-instructions-edit'));
      await tester.pumpAndSettle();
      await tester.enterText(
        key('swarm-instructions-field'),
        'Be brief. Be kind.',
      );
      await tester.pump();
      computer.loseNextReply = true;
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-save-error')).data,
        'Mac Studio didn\'t answer. Try again.',
      );
      expect(computer.files[fileKey], 'Be brief. Be kind.');
      // Saved again from the version it had read: the computer says it changed, and it changed to this.
      await tester.tap(key('swarm-instructions-save'));
      await tester.pumpAndSettle();
      expect(key('swarm-instructions-save-error'), findsNothing);
      expect(key('swarm-instructions-field'), findsNothing);
      expect(find.text('Be brief. Be kind.'), findsOneWidget);
    },
  );

  testWidgets(
    'A computer that cannot be asked says what to do, and Try again asks again',
    (tester) async {
      final computer = SwarmV4Computer(files: {fileKey: 'Be brief.'})
        ..refuse = 'UNSUPPORTED';
      await show(tester, computer: computer);
      await openInstructions(tester);
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'Update Harness on Mac Studio.',
      );
      expect(key('swarm-instructions-edit'), findsNothing);
      computer.refuse = 'OFFLINE';
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'Mac Studio is offline.',
      );
      computer.refuse = 'AGENT_NOT_FOUND';
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<Text>(key('swarm-instructions-error')).data,
        'first builder isn\'t running on Mac Studio.',
      );
      computer.refuse = null;
      await tester.tap(key('swarm-instructions-retry'));
      await tester.pumpAndSettle();
      expect(key('swarm-instructions-error'), findsNothing);
      expect(find.text('Be brief.'), findsOneWidget);
    },
  );

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
