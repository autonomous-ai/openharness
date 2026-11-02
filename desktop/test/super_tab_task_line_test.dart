import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/task_line.dart';

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
    // The project stays open beside it.
    expect(c.selectedId, 'lead');
    await tester.tap(find.byKey(const ValueKey('super-task-panel-close')));
    await tester.pumpAndSettle();
    expect(find.byType(SuperTabTaskPanel), findsNothing);
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
