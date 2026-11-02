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

// Every linked task is a step, named by its title (Ken, 2026-11-02).
const mockup = 'Review PR 12: passed · Test PR 12: 1 check failed';

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
      'Not begun: not started · Under way (Nova): needs human · '
      'Some passed: 1 of 3 checks passed · Two failed: 2 checks failed',
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

  // Task steps design (Ken, 2026-11-02: one pull request showed as three tasks). A step sits on its task's row, by its own
  // name and agent; a linked task from before steps reads as before.
  test("a task's steps line names each step and its agent", () {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('copy', 'Copy'),
          'number': 30,
          'reviewOf': 'offline',
          'step': 'Copy',
          'assignment': {'id': 'w1', 'agentId': 'builder', 'status': 'done'},
        },
        {
          ...conversationFixture('design', 'Thiết kế "v2"'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Thiết kế "v2"',
          'assignment': {
            'id': 'w2',
            'agentId': 'reviewer',
            'status': 'working',
          },
        },
        {
          ...conversationFixture('old', 'Review PR 12'),
          'number': 20,
          'reviewOf': 'offline',
        },
      ],
    );
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(snapshot.conversation('copy')!.step, 'Copy');
    expect(superTabIsStep(snapshot.conversation('copy')!), isTrue);
    // Named or not, a linked task is a step (Ken, 2026-11-02).
    expect(superTabIsStep(snapshot.conversation('old')!), isTrue);
    expect(
      superTabLinkedLine(snapshot, snapshot.conversation('offline')!),
      'Review PR 12: not started · Copy (Atlas): done · '
      'Thiết kế "v2" (Nova): working',
    );
  });

  test('the sidebar lists no step as a task of its own', () {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('copy', 'Copy'),
          'number': 30,
          'reviewOf': 'offline',
          'step': 'Copy',
        },
        {
          ...conversationFixture('old', 'Review PR 12'),
          'number': 20,
          'reviewOf': 'offline',
        },
      ],
    );
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    final listed = superTabListedWork(snapshot.conversations).map((g) => g.id);
    // A linked task opened without a step name is a step too (Ken, 2026-11-02).
    expect(listed, isNot(contains('old')));
    expect(listed, isNot(contains('copy')));
  });

  // Task steps design: a task's chat shows its steps' rows by time, each
  // with its step's name beside the author.
  testWidgets("a task's chat shows its steps' rows with the step's name", (
    tester,
  ) async {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('design', 'Design'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Design',
          'agentIds': ['reviewer'],
        },
      ],
      messages: [('builder', 'Draft is up')],
    );
    server.append('Two findings on the draft', conversationId: 'design');
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'reviewer',
      'name': 'Nova',
    };
    await showView(tester, server);
    expect(find.textContaining('Two findings on the draft'), findsOneWidget);
    expect(find.textContaining('Nova · Design'), findsOneWidget);
  });

  // Final review, finding 4: each conversation numbers its own messages, so a
  // step's row last in the task's chat must not move the task's read mark
  // (markRead keeps it within the task's own loaded rows).
  testWidgets("a step's row last in the chat leaves the task's read mark on "
      "the task's own newest row", (tester) async {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('design', 'Design'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Design',
          'agentIds': ['reviewer'],
        },
      ],
      messages: [for (var i = 0; i < 40; i++) ('builder', 'Line $i')],
    );
    final taskLast = server.messages.last['sequence'] as int;
    server.append('Step row', conversationId: 'design');
    server.messages.last
      ..['sequence'] = taskLast + 5
      ..['createdAt'] = '2026-10-18T00:05:00Z';
    await showView(tester, server);
    await tester.pumpAndSettle();
    // Read back, then down to the end: reaching the end marks the chat read.
    final list = find.byType(Scrollable).first;
    await tester.drag(list, const Offset(0, 600));
    await tester.pumpAndSettle();
    await tester.drag(list, const Offset(0, -3000));
    await tester.pumpAndSettle();
    final marks = server.readMarkPosts.where(
      (m) => m['conversationId'] == 'offline',
    );
    expect(marks, isNotEmpty);
    expect(marks.last['sequence'], taskLast);
  });

  // Final review, minor 8: the open task's reads read each step again only
  // when the Swarm says it moved past the rows held.
  test("a task's reads skip a step that has nothing new", () async {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('design', 'Design'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Design',
        },
      ],
    );
    server.append('Step row', conversationId: 'design');
    final paths = <String>[];
    server.onRead = paths.add;
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    controller.select('offline');
    await controller.loadMessages('offline');
    await Future<void>.delayed(Duration.zero);
    int stepReads() =>
        paths.where((p) => p.contains('/conversations/design/messages')).length;
    final first = stepReads();
    expect(first, 1);
    await controller.loadMessages('offline');
    await Future<void>.delayed(Duration.zero);
    expect(stepReads(), first);
    server.append('Another step row', conversationId: 'design');
    await controller.refresh();
    await controller.loadMessages('offline');
    await Future<void>.delayed(Duration.zero);
    expect(stepReads(), first + 1);
  });

  // Final review, finding 4: the New messages line is placed by the task's
  // own sequences; a step's row, numbered in its own conversation, is not
  // where it goes.
  testWidgets("a task's New messages line ignores its steps' sequences", (
    tester,
  ) async {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('design', 'Design'),
          'number': 31,
          'reviewOf': 'offline',
          'step': 'Design',
        },
      ],
      messages: [for (var i = 1; i <= 6; i++) ('builder', 'Line $i')],
    );
    final read =
        (server.messages.where((m) => m['text'] == 'Line 4').single['sequence']
            as int);
    server.markReadElsewhere('offline', read);
    server.append('Early step row', conversationId: 'design');
    server.messages.last
      ..['sequence'] = 999
      ..['createdAt'] = '2026-10-17T23:00:00Z';
    await showView(tester, server);
    const line = ValueKey('super-new-messages-line');
    expect(find.byKey(line), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(line)).dy,
      greaterThan(tester.getTopLeft(find.textContaining('Line 4')).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(line)).dy,
      lessThan(tester.getTopLeft(find.textContaining('Line 5')).dy),
    );
  });

  // Ken, 2026-11-02: every linked task is a step, named or not.
  test('a linked task with no step name is a step, named by its title', () {
    final server = groupServer(
      linked: [
        {
          ...conversationFixture('old', 'Test: PR #2514'),
          'number': 20,
          'reviewOf': 'offline',
          'assignment': {'id': 'w', 'agentId': 'reviewer', 'status': 'working'},
        },
      ],
    );
    final snapshot = SuperTabSnapshot.fromJson(server.state);
    expect(superTabIsStep(snapshot.conversation('old')!), isTrue);
    expect(
      superTabListedWork(snapshot.conversations).map((g) => g.id),
      isNot(contains('old')),
    );
    expect(
      superTabLinkedLine(snapshot, snapshot.conversation('offline')!),
      'Test: PR #2514 (Nova): working',
    );
  });
}
