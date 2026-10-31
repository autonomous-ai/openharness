import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/linked_tasks.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/work_details.dart';

import 'support/super_tab_fixture.dart';

Map<String, dynamic> agent(String id, String name, {String? role}) => {
  'id': id,
  'name': name,
  'displayName': name,
  'machineId': 'm',
  'harnessId': 'h-$id',
  'contributorId': 'owner',
  'configuration': {'engine': 'claude'},
  'role': ?role,
};

Map<String, dynamic> check(
  String id, {
  String? evidence,
  bool passed = false,
}) => {
  'id': id,
  'description': 'Check $id',
  'evidence': ?evidence,
  'passedBy': passed ? 'owner' : null,
};

/// Task 12 ("offline") with what links to it: [linked] tasks of its project,
/// and its agents' [messages].
ConversationServer groupServer({
  List<Map<String, dynamic>> linked = const [],
  List<(String, String)> messages = const [],
  String brief = '',
}) {
  final server = ConversationServer();
  server.state['agents'] = [
    agent('builder', 'Atlas'),
    agent('reviewer', 'Nova', role: 'reviewer'),
  ];
  final conversations = server.state['conversations'] as List;
  conversations[1]
    ..['number'] = 12
    ..['brief'] = brief
    ..['agentIds'] = ['builder', 'reviewer'];
  conversations.addAll(linked);
  for (final (author, text) in messages) {
    server.append(text, conversationId: 'offline');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': author,
      'name': author,
    };
  }
  return server;
}

/// #14 Review PR 12, one check passed, and #15 Test PR 12, two checks with one
/// failed, both linked to task 12.
final reviewAndTest = [
  {
    ...conversationFixture('review-14', 'Review PR 12'),
    'number': 14,
    'reviewOf': 'offline',
    'checks': [check('c1', evidence: 'Looks right', passed: true)],
  },
  {
    ...conversationFixture('test-15', 'Test PR 12'),
    'number': 15,
    'reviewOf': 'offline',
    'checks': [
      check('c2', evidence: 'Green', passed: true),
      check('c3', evidence: 'Login fails on Safari'),
    ],
  },
];

const mockup = '#14 Review PR 12: passed · #15 Test PR 12: 1 check failed';

Future<void> showView(WidgetTester tester, ConversationServer server) async {
  final controller = server.controller();
  addTearDown(controller.dispose);
  await controller.refresh();
  controller.select('offline');
  await controller.loadMessages('offline');
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SuperTabView(
          controller: controller,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder get linkedLine => find.byKey(const ValueKey('super-linked-line'));

void main() {
  testWidgets("lists a task's linked tasks with their checks' results", (
    tester,
  ) async {
    await showView(
      tester,
      groupServer(
        // Listed out of order: the line goes lowest number first.
        linked: [
          reviewAndTest[1],
          reviewAndTest[0],
          // Another project's task naming it, and a Buddy chat naming it: left out.
          {
            ...conversationFixture('elsewhere', 'Review elsewhere'),
            'number': 16,
            'projectId': 'other',
            'reviewOf': 'offline',
          },
          {
            ...conversationFixture('buddy-owner-lead', "owner's Buddy"),
            'kind': 'buddy',
            'buddyOwnerId': 'owner',
            'reviewOf': 'offline',
          },
        ],
        // An agent's verdict posted only in chat changes nothing.
        messages: [('reviewer', 'Ready: yes\nRevision: abcdef123')],
      ),
    );
    expect(tester.widget<Text>(linkedLine).data, mockup);
    expect(find.textContaining('Reviewer: '), findsNothing);
    expect(find.textContaining('Ready: yes on'), findsNothing);
  });

  testWidgets('no linked task, no line, whatever agents posted', (
    tester,
  ) async {
    await showView(tester, groupServer(messages: [('reviewer', 'Ready: yes')]));
    expect(linkedLine, findsNothing);
  });

  test("a linked task's state: its work, then its checks", () {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('a', 'Not begun'),
          'number': 20,
          'reviewOf': 'offline',
        },
        {
          ...conversationFixture('b', 'Under way'),
          'number': 21,
          'reviewOf': 'offline',
          'assignment': {
            'id': 'w',
            'agentId': 'reviewer',
            'status': 'needs_human',
          },
        },
        {
          ...conversationFixture('c', 'Some passed'),
          'number': 22,
          'reviewOf': 'offline',
          'checks': [
            check('x', evidence: 'ok', passed: true),
            check('y'),
            check('z'),
          ],
        },
        {
          ...conversationFixture('d', 'Two failed'),
          'number': 23,
          'reviewOf': 'offline',
          'checks': [check('p', evidence: 'no'), check('q', evidence: 'no')],
        },
      ],
    );
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(
      superTabLinkedLine(snapshot, snapshot.conversation('offline')!),
      '#20 Not begun: not started · #21 Under way: needs human · '
      '#22 Some passed: 1 of 3 checks passed · #23 Two failed: 2 checks failed',
    );
    expect(superTabLinkedLine(snapshot, snapshot.conversation('a')!), isNull);
  });

  testWidgets(
    'work details repeat the linked line and show the brief as written',
    (tester) async {
      const brief =
          'Goal: sign in with a passkey\n\nChanges: the login page\n\n'
          'Constraints: no new dependency\n\nOwns: web/login\n\n'
          'Acceptance: a passkey signs in';
      final server = groupServer(linked: reviewAndTest, brief: brief);
      final conversations = server.state['conversations'] as List;
      conversations[1]
        ..['task'] = {
          'goal': 'A different goal',
          'changes': 'x',
          'constraints': 'y',
          'owns': ['z'],
        }
        ..['checks'] = [
          {...check('k'), 'independent': true},
        ];
      final controller = server.controller();
      addTearDown(controller.dispose);
      await controller.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSuperTabWork(context, controller, 'offline'),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      expect(find.text(mockup), findsOneWidget);
      expect(find.textContaining('Goal: sign in with a passkey'), findsWidgets);
      expect(find.textContaining('A different goal'), findsNothing);
      for (final heading in ['Goal', 'Changes', 'Constraints', 'Owns']) {
        expect(find.text(heading), findsNothing);
      }
      expect(find.text('Requires an independent check.'), findsNothing);
      expect(find.textContaining('independent'), findsNothing);
    },
  );

  testWidgets('a task with no brief says so', (tester) async {
    final server = groupServer();
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showSuperTabWork(context, controller, 'offline'),
            child: const Text('Open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('This task has no description yet.'), findsOneWidget);
  });
}
