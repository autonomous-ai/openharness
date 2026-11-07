import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/live_card.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'support/stack.dart';

/// Talking with agents in a Swarm, as a person does it in the real app.
void main() {
  if (cliRoot == null) {
    test('Chat flows', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  flowTest('New agent as a Product Manager leads a new project', (
    tester,
  ) async {
    final (flow, tabId) = await _openSwarm(tester, stack);
    await flow.tap(find.text('New agent'), what: 'the left pane\'s New agent');
    await flow.tap(find.byKey(const ValueKey('new-harness-field-agent-kind')));
    await flow.tap(find.byKey(const ValueKey('new-harness-agent-kind-lead')));
    await flow.type(
      find.byKey(const ValueKey('new-harness-task')),
      'Plan the launch.',
    );
    await tester.testTextInput.receiveAction(TextInputAction.send);

    await flow.until('the new project open, led by its Product Manager', () {
      flow.refuse('no longer available');
      final swarm = flow.swarm(tabId);
      final project = swarm?.snapshot?.projectFor(swarm.selectedId);
      return project != null &&
          project.leadConversationId == swarm!.selectedId &&
          swarm.snapshot!.leadOf(project.id) != null;
    }, timeout: const Duration(seconds: 60));
    final swarm = flow.swarm(tabId)!;
    final project = swarm.snapshot!.projectFor(swarm.selectedId)!;
    await flow.see(
      find.text(project.name),
      what: 'the project in the left pane',
    );
    // Its name can arrive a read later than the project (display names).
    await flow.until('its Product Manager by name', () {
      final lead = flow.swarm(tabId)!.snapshot!.leadOf(project.id)!;
      return find.text(lead.displayName ?? lead.name).evaluate().isNotEmpty;
    });
    await flow.close();
  });

  flowTest('Cmd-N in a Swarm opens New agent', (tester) async {
    final (flow, _) = await _openSwarm(tester, stack);
    await flow.see(find.text('New agent'), what: 'the open Swarm');
    expect(find.byType(NewHarnessForm), findsNothing, reason: 'not yet open');
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);

    await flow.see(find.byType(NewHarnessForm), what: 'the New agent box');
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('new-harness-field-start')),
        matching: find.text('New agent'),
      ),
      findsOneWidget,
      reason: 'the box + New agent opens',
    );
    await flow.close();
  });

  flowTest('The agent\'s reply shows in its chat', (tester) async {
    final (flow, tabId) = await _openSwarm(tester, stack);
    final agent = await _newMember(flow, tester, tabId);

    // What the agent does: its own post, as it runs it.
    await tester.runAsync(
      () => stack.asAgent(tabId, agent.id, [
        'post',
        agent.chatId,
        'Hello from the agent',
        _operationId(),
      ]),
    );
    await flow.see(find.text('Hello from the agent'), what: 'the reply');
    await flow.close();
  });

  flowTest('A message sent in a chat shows there and reaches the Swarm', (
    tester,
  ) async {
    final (flow, tabId) = await _openSwarm(tester, stack);
    final agent = await _newMember(flow, tester, tabId);

    await flow.type(
      find.byKey(const ValueKey('super-message-composer')),
      'Ship it today.',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await flow.until(
      'the message in the chat',
      () => find.text('Ship it today.').evaluate().isNotEmpty,
    );
    await _eventually(flow, tester, 'the message on the backend', () async {
      final page = await stack.api(
        '/api/super-tabs/$tabId/conversations/${agent.chatId}/messages',
      );
      return _texts(page).contains('Ship it today.');
    });
    await flow.close();
  });

  flowTest('A task named in a chat opens to its card', (tester) async {
    final (flow, tabId) = await _openSwarm(tester, stack);
    // Setup elsewhere: the task, and a message naming it in the project chat.
    final created = (await tester.runAsync(
      () => stack.command(tabId, {
        'type': 'conversation.create',
        'title': 'Fix the sign-in page',
        'brief': 'The sign-in page loses the email on a wrong password.',
        'checks': [
          {'description': 'The email stays after a wrong password.'},
        ],
      }),
    ))!;
    final result = (created['data'] as Map)['result'] as Map;
    final number = result['number'] as int;
    final taskId = result['conversationId'] as String;
    await tester.runAsync(
      () => stack.command(tabId, {
        'type': 'message.send',
        'conversationId': 'lead',
        'text': 'Next up is #$number.',
        'replyTo': null,
        'recipientIds': <String>[],
      }),
    );
    await flow.tap(find.text('Chat'), what: 'the project\'s Chat');

    final reference = find.textRange.ofSubstring('#$number');
    await flow.see(find.textContaining('Next up is'), what: 'the message');
    await flow.until(
      '#$number as a link',
      () => reference.evaluate().isNotEmpty,
    );
    await tester.tapOnText(reference.first);
    await flow.until(
      'the task to open',
      () => flow.swarm(tabId)?.selectedId == taskId,
    );
    final card = find.byType(SuperTabLiveCard);
    await flow.see(
      find.descendant(
        of: card,
        matching: find.text('#$number Fix the sign-in page'),
      ),
      what: 'the task card',
    );
    expect(
      find.descendant(of: card, matching: find.text('Not started')),
      findsOneWidget,
    );
    await flow.close();
  });
}

String _operationId() => 'flow-${DateTime.now().microsecondsSinceEpoch}';

/// A new Swarm, open in the app.
Future<(FlowApp, String)> _openSwarm(
  WidgetTester tester,
  SwarmStack stack,
) async {
  final tabId = (await tester.runAsync(() => stack.newSwarm('Company')))!;
  final flow = await FlowApp.open(tester, stack);
  flow.app.openSuperTab(tabId, 'Company');
  return (flow, tabId);
}

/// + New agent as an Agent, through the app; its chat open.
Future<({String id, String chatId})> _newMember(
  FlowApp flow,
  WidgetTester tester,
  String tabId,
) async {
  await flow.tap(find.text('New agent'), what: 'the left pane\'s New agent');
  await flow.type(find.byKey(const ValueKey('new-harness-task')), 'Say hi.');
  await tester.testTextInput.receiveAction(TextInputAction.send);
  String? agentId;
  await flow.until('the new agent in its chat', () {
    flow.refuse('no longer available');
    final swarm = flow.swarm(tabId);
    if (swarm?.selected?.kind != 'agent-chat') return false;
    agentId = swarm!.snapshot?.agents
        .where((a) => a.chatId == swarm.selectedId)
        .firstOrNull
        ?.id;
    return agentId != null;
  }, timeout: const Duration(seconds: 60));
  return (id: agentId!, chatId: flow.swarm(tabId)!.selectedId);
}

/// Waits, pumping frames, until [check] on the backend holds.
Future<void> _eventually(
  FlowApp flow,
  WidgetTester tester,
  String what,
  Future<bool> Function() check,
) async {
  final deadline = DateTime.now().add(const Duration(seconds: 20));
  while (!(await tester.runAsync(check))!) {
    if (DateTime.now().isAfter(deadline)) fail('Timed out waiting for $what');
    await flow.until('a moment', () => true);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 200)),
    );
  }
}

List<String> _texts(Map<String, dynamic> page) {
  final data = page['data'] as Map;
  return [
    for (final m in data['messages'] as List) (m as Map)['text'] as String,
  ];
}
