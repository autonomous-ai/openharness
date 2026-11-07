import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/stack.dart';

/// Tasks as a person works them: the right pane's Tasks list, where a task
/// they asked for waits for their Approve or Reject and shows its agent's
/// status, and the project's Board, where each task is a card in its column.
void main() {
  if (cliRoot == null) {
    test('Tasks flows', () {}, skip: skipReason);
    return;
  }
  late SwarmStack stack;
  setUpAll(() async => stack = await SwarmStack.start());
  tearDownAll(() => stack.stop());

  /// A Swarm with one task the owner asked for (setup: they asked elsewhere),
  /// in [mode]; the Swarm's id and the task's.
  Future<(String, String)> swarmWithTask(
    WidgetTester tester,
    String title, {
    String mode = 'autoApprove',
  }) async => (await tester.runAsync(() async {
    final tabId = await stack.newSwarm('Company');
    if (mode != 'autoApprove') {
      await stack.command(tabId, {'type': 'member.approvalMode', 'mode': mode});
    }
    final created = await stack.command(tabId, {
      'type': 'conversation.create',
      'title': title,
      'brief': 'Bring back the draft I lost.',
      'priority': 'P2',
      'checks': <Object>[],
    });
    final result = (created['data'] as Map)['result'] as Map;
    return (tabId, result['conversationId'] as String);
  }))!;

  /// A new agent of the owner's, made with the left pane's New agent as in
  /// new_agent_flow_test.dart, so it runs on the owner's computer; its id.
  Future<String> newAgent(
    WidgetTester tester,
    FlowApp flow,
    String tabId,
  ) async {
    await flow.tap(find.text('New agent'), what: 'the left pane\'s New agent');
    await flow.type(
      find.byKey(const ValueKey('new-harness-task')),
      'Say hello.',
    );
    await tester.testTextInput.receiveAction(TextInputAction.send);
    String? agentId;
    await flow.until('the new agent to join', () {
      flow.refuse('no longer available');
      final c = flow.swarm(tabId);
      final chat = c?.selected;
      if (chat?.kind != 'agent-chat') return false;
      agentId = c!.snapshot!.agents
          .where((a) => a.chatId == chat!.id)
          .firstOrNull
          ?.id;
      return agentId != null;
    }, timeout: const Duration(seconds: 60));
    return agentId!;
  }

  /// [taskId] assigned to [agentId]: setup the PM does. Its assignment's id.
  Future<String> assign(
    WidgetTester tester,
    String tabId,
    String taskId,
    String agentId,
  ) async => (await tester.runAsync(() async {
    final assigned = await stack.command(tabId, {
      'type': 'work.assign',
      'conversationId': taskId,
      'agentId': agentId,
    });
    return ((assigned['data'] as Map)['result'] as Map)['assignmentId']
        as String;
  }))!;

  /// What the agent reports with `harness super-tab … command`.
  Future<void> report(
    WidgetTester tester,
    String tabId,
    String agentId,
    String taskId,
    String assignmentId,
    String status,
  ) => tester.runAsync(
    () => stack.asAgent(tabId, agentId, [
      'command',
      'flow-status-${DateTime.now().microsecondsSinceEpoch}',
      jsonEncode({
        'type': 'work.status',
        'conversationId': taskId,
        'assignmentId': assignmentId,
        'status': status,
        'result': 'Reported $status.',
      }),
    ]),
  );

  /// The owner's Tasks row for [taskId] as the backend sends it.
  Future<Map<String, dynamic>?> backendRow(
    WidgetTester tester,
    String tabId,
    String taskId,
  ) => tester.runAsync<Map<String, dynamic>?>(() async {
    final parts = await stack.api('/api/super-tabs/$tabId/parts');
    final tasks = (parts['data'] as Map)['personalTasks'] as Map;
    return (tasks['upserts'] as List)
        .cast<Map<String, dynamic>>()
        .where((row) => row['id'] == taskId)
        .firstOrNull;
  });

  /// [finder] inside the Tasks pane's card of [taskId].
  Finder onTasksCard(String taskId, Finder finder) => find.descendant(
    of: find.byKey(ValueKey('personal-task-$taskId')),
    matching: finder,
  );

  /// The status mark of [taskId]'s Tasks card, by the words it says.
  Finder statusMark(String taskId, String label) => onTasksCard(
    taskId,
    find.byWidgetPredicate(
      (w) => w is Tooltip && (w.message?.startsWith(label) ?? false),
    ),
  );

  /// [taskId]'s Board card in [column] ('nextUp', 'working', 'done', …).
  Finder boardCard(String taskId, String column) => find.descendant(
    of: find.byKey(ValueKey('super-tasks-column-$column')),
    matching: find.byKey(ValueKey('super-task-card-$taskId')),
  );

  /// The project's Board, from the left pane's Projects, as a person goes
  /// back to it from a chat.
  Future<void> openBoard(FlowApp flow) async {
    await flow.tap(find.byKey(const ValueKey('super-projects')));
    await flow.tap(find.byKey(const ValueKey('super-group-lead')));
    await flow.see(find.byKey(const ValueKey('super-tasks-board')));
  }

  flowTest('Approve a task waiting for you in Tasks lets it go ahead', (
    tester,
  ) async {
    final (tabId, taskId) = await swarmWithTask(
      tester,
      'Restore my draft',
      mode: 'review',
    );
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Company');
    await flow.see(statusMark(taskId, 'Proposal'));

    await flow.tap(onTasksCard(taskId, find.text('Approve')));

    await flow.until('the approved task to show Planned', () {
      flow.refuse('was refused');
      return statusMark(taskId, 'Planned').evaluate().isNotEmpty;
    });
    expect(onTasksCard(taskId, find.text('Approve')), findsNothing);
    expect(onTasksCard(taskId, find.text('Reject')), findsNothing);
    expect(boardCard(taskId, 'nextUp'), findsOneWidget);
    final row = await backendRow(tester, tabId, taskId);
    expect(row, containsPair('status', 'planned'), reason: 'the backend');
    expect(row, containsPair('canApprove', false));
    await flow.close();
  });

  flowTest('Reject a task waiting for you in Tasks, with a reason', (
    tester,
  ) async {
    final (tabId, taskId) = await swarmWithTask(
      tester,
      'Restore my draft',
      mode: 'review',
    );
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Company');
    await flow.see(statusMark(taskId, 'Proposal'));

    await flow.tap(onTasksCard(taskId, find.text('Reject')));
    await flow.type(
      find.byKey(const ValueKey('task-reject-reason')),
      'Keep this for later',
    );
    await flow.tap(find.text('Reject task'));

    await flow.until('the rejected task to show Rejected', () {
      flow.refuse('was refused');
      return statusMark(taskId, 'Rejected').evaluate().isNotEmpty;
    });
    expect(onTasksCard(taskId, find.text('Approve')), findsNothing);
    final row = await backendRow(tester, tabId, taskId);
    expect(row, containsPair('status', 'rejected'), reason: 'the backend');
    expect(row, containsPair('reason', 'Keep this for later'));
    await flow.close();
  });

  flowTest(
    'A task assigned to an agent shows Working once the agent takes it',
    (tester) async {
      final (tabId, taskId) = await swarmWithTask(tester, 'Restore my draft');
      final flow = await FlowApp.open(tester, stack);
      flow.app.openSuperTab(tabId, 'Company');
      final agentId = await newAgent(tester, flow, tabId);
      final assignmentId = await assign(tester, tabId, taskId, agentId);
      await flow.see(onTasksCard(taskId, find.text('Restore my draft')));
      expect(statusMark(taskId, 'Working'), findsNothing);

      // The agent takes it, as its harness does.
      await report(tester, tabId, agentId, taskId, assignmentId, 'working');

      await flow.see(
        statusMark(taskId, 'Working'),
        what: 'Tasks to say Working',
      );
      await openBoard(flow);
      await flow.see(boardCard(taskId, 'working'), what: 'its card in Working');
      final row = await backendRow(tester, tabId, taskId);
      expect(row, containsPair('status', 'working'), reason: 'the backend');
      expect((row!['agent'] as Map)['id'], agentId);
      await flow.close();
    },
  );

  flowTest('A task\'s card follows its agent live: in review, then Done', (
    tester,
  ) async {
    final (tabId, taskId) = await swarmWithTask(tester, 'Restore my draft');
    final flow = await FlowApp.open(tester, stack);
    flow.app.openSuperTab(tabId, 'Company');
    final agentId = await newAgent(tester, flow, tabId);
    final assignmentId = await assign(tester, tabId, taskId, agentId);
    await report(tester, tabId, agentId, taskId, assignmentId, 'working');
    await openBoard(flow);
    await flow.see(boardCard(taskId, 'working'));

    // The agent asks for review, then finishes, as its harness does; the app
    // is never reloaded.
    await report(tester, tabId, agentId, taskId, assignmentId, 'review');
    await flow.see(
      statusMark(taskId, 'Ready for review'),
      what: 'Tasks to say Ready for review',
    );
    await flow.see(
      find.descendant(
        of: boardCard(taskId, 'working'),
        matching: find.byTooltip('In review'),
      ),
      what: 'its Board card marked In review',
    );
    await report(tester, tabId, agentId, taskId, assignmentId, 'done');
    await flow.see(statusMark(taskId, 'Done'), what: 'Tasks to say Done');
    await flow.see(boardCard(taskId, 'done'), what: 'its card in Done');
    expect(boardCard(taskId, 'working'), findsNothing);
    final row = await backendRow(tester, tabId, taskId);
    expect(row, containsPair('status', 'done'), reason: 'the backend');
    await flow.close();
  });

  flowTest(
    'Board shows a task as a card in Next up, and tapping it opens the task',
    (tester) async {
      final (tabId, taskId) = await swarmWithTask(tester, 'Restore my draft');
      final flow = await FlowApp.open(tester, stack);
      flow.app.openSuperTab(tabId, 'Company');
      await flow.see(boardCard(taskId, 'nextUp'), what: 'its card in Next up');
      expect(boardCard(taskId, 'working'), findsNothing);

      await flow.tap(boardCard(taskId, 'nextUp'));

      await flow.until(
        'the task to open',
        () => flow.swarm(tabId)?.selectedId == taskId,
      );
      await flow.see(
        find.text('Bring back the draft I lost.'),
        what: 'its brief',
      );
      await flow.close();
    },
  );
}
