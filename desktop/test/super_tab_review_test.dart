import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/review_verdict.dart';
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

/// A workgroup with a Builder, a Reviewer and (optionally) their messages.
ConversationServer groupServer({
  bool reviewer = true,
  List<(String, String)> messages = const [],
}) {
  final server = ConversationServer();
  server.state['agents'] = [
    agent('builder', 'Atlas'),
    if (reviewer) agent('reviewer', 'Nova', role: 'reviewer'),
  ];
  (server.state['conversations'] as List)[1]['agentIds'] = [
    'builder',
    if (reviewer) 'reviewer',
  ];
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

void main() {
  test('a Ready line reads as yes, no or with fixes, with its revision', () {
    expect(
      parseSuperTabVerdict('Review done.\nReady: yes\nRevision: 1a2b3c4d5e6f')
          ?.label,
      'Ready: yes on 1a2b3c4d5',
    );
    expect(
      parseSuperTabVerdict('ready: NO (head abc1234)')?.label,
      'Ready: no on abc1234',
    );
    expect(
      parseSuperTabVerdict('Ready: with fixes')?.label,
      'Ready: with fixes',
    );
    expect(parseSuperTabVerdict('Ready: maybe'), isNull);
    expect(parseSuperTabVerdict('Looks ready to me, revision 1234567'), isNull);
    expect(parseSuperTabVerdict('Not Ready: yes'), isNull);
  });

  test('an agent without a role is a Builder', () {
    expect(SuperTabAgent.fromJson(agent('a', 'A')).isReviewer, isFalse);
    expect(
      SuperTabAgent.fromJson(agent('a', 'A', role: 'reviewer')).isReviewer,
      isTrue,
    );
  });

  testWidgets('the header shows the reviewer and the latest verdict', (
    tester,
  ) async {
    await showView(
      tester,
      groupServer(
        messages: [
          ('reviewer', 'Ready: no\nRevision: aaaaaaa1'),
          ('builder', 'Fixed. Ready: yes at bbbbbbb2'),
          ('reviewer', 'Ready: with fixes\nRevision: ccccccc3'),
        ],
      ),
    );
    expect(
      find.text('Reviewer: Nova · Ready: with fixes on ccccccc3'),
      findsOneWidget,
    );
  });

  testWidgets('a reviewer who has not answered shows no verdict yet', (
    tester,
  ) async {
    await showView(tester, groupServer(messages: [('builder', 'Ready: yes')]));
    expect(find.text('Reviewer: Nova · No verdict yet'), findsOneWidget);
  });

  testWidgets('nothing is shown without a reviewer', (tester) async {
    await showView(
      tester,
      groupServer(reviewer: false, messages: [('builder', 'Ready: yes')]),
    );
    expect(find.byKey(const ValueKey('super-review-line')), findsNothing);
    expect(find.textContaining('Reviewer'), findsNothing);
  });

  testWidgets('work details repeat the reviewer line', (tester) async {
    final server = groupServer(
      messages: [('reviewer', 'Ready: yes\nRevision: abcdef123')],
    );
    final controller = server.controller();
    addTearDown(controller.dispose);
    await controller.refresh();
    await controller.loadMessages('offline');
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
    expect(
      find.text('Reviewer: Nova · Ready: yes on abcdef123'),
      findsOneWidget,
    );
  });
}
