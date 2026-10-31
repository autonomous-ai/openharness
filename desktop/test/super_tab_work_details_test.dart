import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/launch_prompt.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/work_details.dart';

import 'support/super_tab_fixture.dart';

const task = {
  'goal': 'Keep drafts',
  'changes': 'Store pending edits',
  'constraints': 'No dependencies',
  'owns': ['cli/src/superTabs', 'desktop/lib/super_tabs'],
};

void main() {
  test(
    'conversation parses an optional immutable task and accepts old rows',
    () {
      final row = conversationFixture('group', 'Drafts');
      expect(SuperTabConversation.fromJson(row).task, isNull);
      row['task'] = task;
      final parsed = SuperTabConversation.fromJson(row).task!;
      expect(parsed.goal, 'Keep drafts');
      expect(parsed.changes, 'Store pending edits');
      expect(parsed.constraints, 'No dependencies');
      expect(parsed.owns, task['owns']);
      expect(() => parsed.owns.add('other'), throwsUnsupportedError);
    },
  );

  test(
    'launch prompt points to the instructions and stays within the limit',
    () {
      for (final lead in [true, false]) {
        final prompt = superTabLaunchPrompt(
          tabId: 't' * 160,
          conversationId: 'c' * 160,
          lead: lead,
        );
        expect(prompt, contains('instructions'));
        expect(prompt, isNot(contains('swarm-lead')));
        expect(prompt, isNot(contains('swarm-dev')));
        expect(prompt.length, lessThanOrEqualTo(2000));
      }
    },
  );

  for (final structured in [true, false]) {
    testWidgets(
      'work details show the brief as written${structured ? ', never a task\'s five parts' : ''}',
      (tester) async {
        final server = ConversationServer();
        final row =
            (server.state['conversations'] as List)[1] as Map<String, dynamic>;
        row['brief'] = 'Legacy instructions';
        if (structured) row['task'] = task;
        row['checks'] = [
          {
            'id': 'check',
            'description': 'Draft survives reconnect',
            'independent': false,
            'passedBy': null,
          },
        ];
        final controller = server.controller();
        addTearDown(controller.dispose);
        await controller.refresh();
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () =>
                      showSuperTabWork(context, controller, 'offline'),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(find.text('Acceptance checks'), findsOneWidget);
        expect(find.text('Draft survives reconnect'), findsOneWidget);
        for (final heading in ['Goal', 'Changes', 'Constraints', 'Owns']) {
          expect(find.text(heading), findsNothing);
        }
        expect(find.byType(SuperTabMessageText), findsOneWidget);
        expect(
          tester
              .widget<SuperTabMessageText>(find.byType(SuperTabMessageText))
              .text,
          'Legacy instructions',
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('work details of a closed group not read yet read it by id', (
    tester,
  ) async {
    final server = ConversationServer();
    final row =
        (server.state['conversations'] as List)[1] as Map<String, dynamic>;
    // The backend writes a task's brief from its parts.
    row
      ..['archived'] = true
      ..['task'] = task
      ..['brief'] = 'Goal: Keep drafts\n\nChanges: Store pending edits';
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.snapshot!.conversation('offline'), isNull);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showSuperTabWork(context, controller, 'offline'),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('Goal'), findsNothing);
    expect(
      tester
          .widgetList<SuperTabMessageText>(find.byType(SuperTabMessageText))
          .map((widget) => widget.text),
      ['Goal: Keep drafts\n\nChanges: Store pending edits'],
    );
    expect(tester.takeException(), isNull);
  });
}
