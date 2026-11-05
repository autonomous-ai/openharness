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

  // Quiet project chats (Dee, 2026-10-31): a Lead started from Desktop keeps
  // progress in the status card and posts only what needs people.
  test('launch prompt keeps a Lead\'s progress in the status card, never cadence posts', () {
    final lead = superTabLaunchPrompt(
      tabId: 'tab',
      conversationId: 'lead',
      lead: true,
    );
    expect(
      lead,
      contains("Keep the project's status card current with project.report"),
    );
    expect(
      lead,
      contains(
        'Post in the Lead chat only when work merges or ships, a person must decide something new, or work is badly stuck',
      ),
    );
    expect(
      lead,
      contains('Ask a person a question once, as a decision; never repeat it.'),
    );
    for (final gone in [
      'cadence',
      'consolidate',
      'Update Lead chat',
      'progress, blockers, next steps',
    ]) {
      expect(lead, isNot(contains(gone)), reason: gone);
    }
    final builder = superTabLaunchPrompt(
      tabId: 'tab',
      conversationId: 'group',
      lead: false,
    );
    expect(builder, isNot(contains('status card')));
  });

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

  // Diego, 2026-11-03 (#2311): the Tester's failure and its evidence stay
  // shown after the Reviewer passes the same check.
  testWidgets('work details show a check one checker failed as not verified', (
    tester,
  ) async {
    final server = ConversationServer();
    final row =
        (server.state['conversations'] as List)[1] as Map<String, dynamic>;
    row['checks'] = [
      {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': 'Crashes offline',
        'passedBy': null,
        'verdicts': [
          {
            'by': 'agent:tester',
            'passed': false,
            'evidence': 'Crashes offline',
            'at': 1,
          },
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
          },
        ],
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
              onPressed: () => showSuperTabWork(context, controller, 'offline'),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('Not verified'), findsOneWidget);
    expect(find.text('Verified'), findsNothing);
    expect(
      find.byWidgetPredicate(
        (w) => w is SuperTabMessageText && w.text == 'Crashes offline',
      ),
      findsOneWidget,
    );
  });

  // Dee, #3394: a verdict counts only at the pull request head it read; the
  // check line says which head, or that a newer head made it stale.
  group('a check line names the head its verdict read', () {
    Future<void> open(WidgetTester tester, Map<String, dynamic> check) async {
      final server = ConversationServer();
      final row =
          (server.state['conversations'] as List)[1] as Map<String, dynamic>;
      row['checks'] = [check];
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
    }

    const a = 'aaaaaaa1111111111111111111111111111111aa';
    const b = 'bbbbbbb2222222222222222222222222222222bb';

    testWidgets('Yes at its head while it counts', (tester) async {
      await open(tester, {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': 'Diff reads right',
        'passedBy': 'agent:reviewer',
        'verdicts': [
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
            'pullRequest': 'https://github.com/acme/app/pull/7',
            'head': a,
            'patch': 'p1',
          },
        ],
      });
      expect(find.text('Yes at aaaaaaa'), findsOneWidget);
      expect(find.text('Verified'), findsNothing);
    });

    testWidgets('Stale once a newer head stopped it counting', (tester) async {
      await open(tester, {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': null,
        'passedBy': null,
        'verdicts': [
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
            'pullRequest': 'https://github.com/acme/app/pull/7',
            'head': a,
            'patch': 'p1',
            'stale': b,
          },
        ],
      });
      expect(
        find.text('Stale: read aaaaaaa, PR is at bbbbbbb'),
        findsOneWidget,
      );
      expect(find.text('Not verified'), findsNothing);
    });

    testWidgets('Stale when it named no head, or its PR head is not read', (
      tester,
    ) async {
      await open(tester, {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': null,
        'passedBy': null,
        'verdicts': [
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
            'pullRequest': 'https://github.com/acme/app/pull/7',
            'stale': b,
          },
          {
            'by': 'agent:tester',
            'passed': true,
            'evidence': 'Signs in',
            'at': 3,
            'pullRequest': 'https://github.com/acme/app/pull/8',
            'head': a,
            'stale': '',
          },
        ],
      });
      expect(
        find.text('Stale: read aaaaaaa, PR head not read yet'),
        findsOneWidget,
      );
    });

    testWidgets('Stale when its verdict named no head', (tester) async {
      await open(tester, {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': null,
        'passedBy': null,
        'verdicts': [
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
            'pullRequest': 'https://github.com/acme/app/pull/7',
            'stale': b,
          },
        ],
      });
      expect(
        find.text('Stale: no head named, PR is at bbbbbbb'),
        findsOneWidget,
      );
    });

    testWidgets('Verified as before for a verdict with no head', (
      tester,
    ) async {
      await open(tester, {
        'id': 'check',
        'description': 'Signs in offline',
        'independent': true,
        'evidence': 'Diff reads right',
        'passedBy': 'agent:reviewer',
        'verdicts': [
          {
            'by': 'agent:reviewer',
            'passed': true,
            'evidence': 'Diff reads right',
            'at': 2,
          },
        ],
      });
      expect(find.text('Verified'), findsOneWidget);
    });
  });
}
