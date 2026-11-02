import 'dart:typed_data';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/task_line.dart';
import 'package:harness/super_tabs/thread_panel.dart';

import 'super_tab_mentions_test.dart' show showView;
import 'support/super_tab_fixture.dart';

final at = DateTime.utc(2026, 11, 2, 9);

Map<String, dynamic> taskRow(
  String state, {
  String id = 'line-1',
  String? answerFor,
  String taskId = 'group-1',
  int sequence = 5,
  String? title = 'Phone Activity opens the right message',
  String? text,
}) => {
  'id': id,
  'conversationId': 'lead',
  'sequence': sequence,
  'text': text ?? 'Phone Activity opens the right message · $state',
  'createdAt': at.toIso8601String(),
  'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
  'source': {
    'kind': 'task-line',
    'taskId': taskId,
    'title': ?title,
    'state': state,
    'answerFor': ?answerFor,
  },
};

Map<String, dynamic> proposalRow() => {
  'id': 'proposal-1',
  'conversationId': 'lead',
  'thread': 'proposal-1',
  'sequence': 6,
  'text': 'Activity read fix\n\nA second line of detail the row leaves out.',
  'createdAt': at.toIso8601String(),
  'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
  'source': {'kind': 'buddy-proposal', 'personId': 'owner'},
};

ConversationServer serverWith(List<Map<String, dynamic>> rows) {
  final server = ConversationServer();
  server.state['agents'] = [
    {
      'id': 'kai',
      'name': 'Kai',
      'machineId': 'm',
      'harnessId': 'h',
      'contributorId': 'owner',
      'configuration': {'engine': 'codex'},
    },
  ];
  server.messages.addAll(rows);
  final conversations = (server.state['conversations'] as List)
      .cast<Map<String, dynamic>>();
  final lead = conversations.firstWhere((g) => g['id'] == 'lead');
  lead['lastMessageSequence'] = rows.length + 5;
  // The task a line opens.
  conversations.add({
    ...lead,
    'id': 'group-1',
    'title': 'Phone Activity opens the right message',
    'lastMessageSequence': 1,
    'leadId': null,
  });
  return server;
}

Finder get line => find.byType(SuperTabTaskLine);

void main() {
  for (final (state, word, icon) in [
    ('planned', 'planned', AppIcons.circleDashed),
    ('working', 'working', AppIcons.circleDot),
    ('review', 'in review', AppIcons.circleDot),
    ('shipped', 'shipped', AppIcons.check),
    ('stopped', 'stopped', AppIcons.circleSlash),
  ]) {
    testWidgets('a $state task is one line: its mark, name and "$word"', (
      tester,
    ) async {
      final c = await showView(tester, serverWith([taskRow(state)]));
      await c.loadMessages('lead');
      await tester.pumpAndSettle();
      expect(line, findsOneWidget);
      expect(
        find.descendant(of: line, matching: find.text(word)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: line, matching: find.byIcon(icon)),
        findsOneWidget,
      );
      expect(
        tester.getSize(line).height,
        lessThan(48),
        reason: 'one line, not a card',
      );
      // Not also drawn as a message, with its author.
      expect(find.byType(SuperTabMessageRow), findsNothing);
    });
  }

  testWidgets('the name comes from the title, not the text older apps read', (
    tester,
  ) async {
    final c = await showView(
      tester,
      serverWith([
        taskRow(
          'review',
          title: 'Offline drafts',
          text: 'Offline drafts · in review',
        ),
      ]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('Offline drafts'), findsOneWidget);
    expect(find.text('Offline drafts · in review'), findsNothing);
  });

  testWidgets('a line with no title still reads, as its text says it', (
    tester,
  ) async {
    final c = await showView(
      tester,
      serverWith([taskRow('review', title: null, text: 'Offline drafts')]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.text('Offline drafts'), findsOneWidget);
  });

  testWidgets('an edited line redraws in place at the next read', (
    tester,
  ) async {
    final server = serverWith([
      taskRow(
        'working',
        text: 'Offline drafts · working',
        title: 'Offline drafts',
      ),
    ]);
    final c = await showView(tester, server);
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: line, matching: find.text('working')),
      findsOneWidget,
    );

    // The server edits the one message, and moves the chat's reaction counter.
    server.messages.first
      ..['text'] = 'Offline drafts · in review'
      ..['source'] = {
        ...server.messages.first['source'] as Map,
        'state': 'review',
      };
    final group = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == 'lead');
    group['reactionSeq'] = ((group['reactionSeq'] as int?) ?? 0) + 1;
    await c.loadMessages('lead');
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: line, matching: find.text('in review')),
      findsOneWidget,
    );
    expect(line, findsOneWidget);
  });

  testWidgets('a task waiting on the reader says Answer', (tester) async {
    final c = await showView(
      tester,
      serverWith([taskRow('waiting', answerFor: 'owner')]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: line, matching: find.text('Answer')),
      findsOneWidget,
    );
  });

  testWidgets(
    'a task waiting on someone else never says Answer to the reader',
    (tester) async {
      final c = await showView(
        tester,
        serverWith([taskRow('waiting', answerFor: 'someone-else')]),
      );
      await c.loadMessages('lead');
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: line, matching: find.text('Answer')),
        findsNothing,
      );
      expect(
        find.descendant(of: line, matching: find.text('working')),
        findsOneWidget,
      );
    },
  );

  testWidgets('an unknown state keeps the line and says nothing it cannot', (
    tester,
  ) async {
    final c = await showView(tester, serverWith([taskRow('later')]));
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(line, findsOneWidget);
    expect(find.text('later'), findsNothing);
  });

  testWidgets('clicking a task opens its conversation on the right', (
    tester,
  ) async {
    final server = serverWith([taskRow('working')]);
    server.messages.add({
      'id': 'in-task',
      'conversationId': 'group-1',
      'sequence': 1,
      'text': 'Ready: PR #2605.',
      'createdAt': at.toIso8601String(),
      'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
    });
    final c = await showView(tester, server);
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsOneWidget);
    expect(find.text('Ready: PR #2605.'), findsOneWidget);
    // Headed as the line reads, with its mark (screen 3).
    expect(
      find.descendant(
        of: find.byType(SuperTabTaskPanel),
        matching: find.byIcon(AppIcons.circleDot),
      ),
      findsOneWidget,
    );
    // The project stays open beside it.
    expect(c.selectedId, 'lead');
    await tester.tap(find.byKey(const ValueKey('super-task-panel-close')));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsNothing);
  });

  testWidgets('the panel shows what the chat would: steps, not hidden rows', (
    tester,
  ) async {
    final server = serverWith([taskRow('review')]);
    (server.state['conversations'] as List).add({
      ...conversationFixture('step-1', 'Review'),
      'projectId': 'lead',
      'reviewOf': 'group-1',
      'step': 'Review',
      'number': 7,
      'lastMessageSequence': 1,
    });
    Map<String, dynamic> inTask(
      String id,
      String conversation,
      int sequence,
      String text, {
      Map<String, Object?> source = const {},
      String? thread,
    }) => {
      'id': id,
      'conversationId': conversation,
      'sequence': sequence,
      'thread': thread ?? id,
      'text': text,
      'createdAt': at.toIso8601String(),
      'author': {'kind': 'agent', 'id': 'kai', 'name': 'Kai'},
      'source': source,
    };
    server.messages.addAll([
      inTask('t1', 'group-1', 1, 'Ready: PR #2605.'),
      inTask(
        't2',
        'group-1',
        2,
        'Kai has gone quiet.',
        source: {'kind': 'work-stalled'},
      ),
      inTask('t3', 'group-1', 3, 'A reply in a thread.', thread: 't1'),
      inTask('v1', 'step-1', 1, 'With fixes: one Important.'),
    ]);
    final c = await showView(tester, server);
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(find.text('Ready: PR #2605.'), findsOneWidget);
    expect(find.text('With fixes: one Important.'), findsOneWidget);
    expect(find.text('Kai has gone quiet.'), findsNothing);
    expect(find.text('A reply in a thread.'), findsNothing);
  });

  testWidgets('a thread opened takes the task panel\'s place for good', (
    tester,
  ) async {
    final server = serverWith([taskRow('working'), proposalRow()]);
    final c = await showView(tester, server);
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsOneWidget);
    c.openThread('proposal-1');
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabThreadPanel), findsOneWidget);
    expect(find.byType(SuperTabTaskPanel), findsNothing);
    c.closeThread();
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsNothing);
  });

  testWidgets('on a narrow window, a click outside closes the task panel', (
    tester,
  ) async {
    final c = await showView(tester, serverWith([taskRow('working')]));
    await c.loadMessages('lead');
    await tester.binding.setSurfaceSize(const Size(900, 800));
    await tester.pumpAndSettle();
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsOneWidget);
    await tester.tapAt(const Offset(20, 400));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsNothing);
  });

  group('the panel\'s reply', () {
    final field = find.byKey(const ValueKey('super-task-reply'));
    final send = find.byKey(const ValueKey('super-task-send'));

    ConversationServer assigned() {
      final server = serverWith([taskRow('working')]);
      final task = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'group-1');
      task['agentIds'] = ['kai'];
      task['assignment'] = {'agentId': 'kai', 'status': 'working'};
      return server;
    }

    Future<SuperTabController> open(
      WidgetTester tester,
      ConversationServer server,
    ) async {
      final c = await showView(tester, server);
      await c.loadMessages('lead');
      await tester.pumpAndSettle();
      await tester.tap(line);
      await tester.pumpAndSettle();
      return c;
    }

    testWidgets('goes to the agent with the task, as a plain message', (
      tester,
    ) async {
      final server = assigned();
      await open(tester, server);
      await tester.enterText(field, 'Yes, ship it.');
      await tester.pump();
      await tester.tap(send);
      await tester.pumpAndSettle();
      final sent =
          server.posts.lastWhere(
                (p) => (p['command'] as Map?)?['type'] == 'message.send',
              )['command']
              as Map;
      expect(sent['conversationId'], 'group-1');
      expect(sent['text'], 'Yes, ship it.');
      expect(sent['replyTo'], isNull);
      expect(sent['recipientIds'], ['kai']);
      expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    });

    testWidgets('a file with no words goes too', (tester) async {
      final server = assigned();
      final c = await open(tester, server);
      c.threadAttachments('group-1', 'group-1').add([
        HarnessAttachment('a.txt', Uint8List.fromList([104, 105])),
      ]);
      await tester.pump();
      await tester.tap(send);
      await tester.pumpAndSettle();
      final sent =
          server.posts.lastWhere(
                (p) => (p['command'] as Map?)?['type'] == 'message.send',
              )['command']
              as Map;
      expect(sent['conversationId'], 'group-1');
      expect(sent['attachmentIds'], hasLength(1));
    });

    testWidgets('while something else is saving, the words stay in the box', (
      tester,
    ) async {
      final server = assigned();
      final c = await open(tester, server);
      final hold = server.holdCommands = Completer<void>();
      final other = c.command({
        'type': 'conversation.rename',
        'conversationId': 'lead',
        'title': 'x',
      });
      await tester.pump();
      await tester.enterText(field, 'Do not lose me.');
      await tester.pump();
      await tester.tap(send, warnIfMissed: false);
      await tester.pump();
      expect(
        tester.widget<TextField>(field).controller!.text,
        'Do not lose me.',
      );
      server.holdCommands = null;
      hold.complete();
      await other;
      await tester.pumpAndSettle();
      await tester.tap(send);
      await tester.pumpAndSettle();
      expect(
        server.posts.map((p) => (p['command'] as Map?)?['text']),
        contains('Do not lose me.'),
      );
    });

    testWidgets('a reply on its way shows in the panel', (tester) async {
      final server = assigned();
      await open(tester, server);
      final hold = server.holdCommands = Completer<void>();
      await tester.enterText(field, 'On its way.');
      await tester.pump();
      await tester.tap(send);
      await tester.pump();
      expect(
        find.descendant(
          of: find.byType(SuperTabTaskPanel),
          matching: find.textContaining('On its way.'),
        ),
        findsWidgets,
      );
      server.holdCommands = null;
      hold.complete();
      await tester.pumpAndSettle();
    });
  });

  testWidgets('a task the reader\'s read does not hold opens nothing', (
    tester,
  ) async {
    final c = await showView(
      tester,
      serverWith([taskRow('working', taskId: 'not-readable')]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    await tester.tap(line);
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsNothing);
  });

  testWidgets('a proposal says its goal, not the server\'s opening words', (
    tester,
  ) async {
    final c = await showView(
      tester,
      serverWith([
        {
          ...proposalRow(),
          'text':
              "Proposal from diego's Buddy, on diego's behalf.\n\n"
              'Goal: Activity read fix\nScope: The app\nPriority: high',
        },
      ]),
    );
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    expect(find.textContaining(': Activity read fix'), findsOneWidget);
    expect(find.textContaining('behalf'), findsNothing);
    expect(find.textContaining('Scope'), findsNothing);
  });

  testWidgets('a proposal is one line that opens', (tester) async {
    final c = await showView(tester, serverWith([proposalRow()]));
    await c.loadMessages('lead');
    await tester.pumpAndSettle();
    final row = find.byType(SuperTabProposalLine);
    expect(row, findsOneWidget);
    expect(tester.getSize(row).height, lessThan(48));
    expect(find.textContaining('second line of detail'), findsNothing);
    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(c.openedThread?.root, 'proposal-1');
    expect(find.textContaining('second line of detail'), findsOneWidget);
  });
}
