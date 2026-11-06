import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'super_tab_parts_test.dart' show recorded;
import 'super_tab_personal_tasks_test.dart' show task, feed;
import 'support/memory_key_value_store.dart';

class TasksFixture {
  final store = MemoryKeyValueStore();
  bool supported = true, fail = false;
  Completer<void>? hold;
  String mode = 'autoApprove';
  final rows = [task('old', 1, 10), task('new', 1, 20)];
  final commands = <Map<String, dynamic>>[];
  final operations = <String>[];
  late final controller = SuperTabController(
    tabId: 'c51479bd73b59e58176ad9e4', accountId: '6a86', pollInterval: Duration.zero,
    save: (value) => store.write('controller', value.toString()),
    request: (method, path, {body}) async {
      if (method == 'POST') {
        operations.add(body!['operationId'] as String);
        final command = Map<String, dynamic>.from(body['command'] as Map);
        commands.add(command);
        await hold?.future;
        if (fail) throw StateError('fixture private payload');
        if (command['type'] == 'member.approvalMode') mode = command['mode'] as String;
        for (final row in rows) {
          if (row['id'] != command['conversationId']) continue;
          row['version'] = (row['version'] as int) + 1;
          if (command['type'] == 'task.approve') row['status'] = 'working';
          if (command['type'] == 'task.reject') { row['status'] = 'rejected'; row['reason'] = command['reason']; }
          if (command['type'] == 'task.suggest') row['agent'] = {'id': command['agentId'], 'name': 'Selected agent'};
        }
        return {'result': <String, dynamic>{}};
      }
      final result = path.endsWith('/parts') ? recorded('first_load') : {
        'format': 2, 'cursor': 'next', 'epoch': 3,
        'derived': recorded('first_load')['derived'],
      };
      if (supported) result['personalTasks'] = feed(rows, reset: path.endsWith('/parts'), mode: mode);
      return result;
    },
  );
}
void main() {
  late TasksFixture f;
  Future<void> mount(WidgetTester tester) async {
    f = TasksFixture();
    addTearDown(() => f.controller.dispose());
    await f.controller.refresh();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: SizedBox(width: 340,
      child: SuperTabPersonalTasksPane(controller: f.controller, onOpenTask: (_) {})))));
  }
  testWidgets('newest task first with project, agent and proposal mark', (t) async {
    await mount(t);
    expect(t.getTopLeft(find.text('Task new')).dy, lessThan(t.getTopLeft(find.text('Task old')).dy));
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.byTooltip('Proposal'), findsNWidgets(2));
    expect(find.text('Auto approve'), findsOneWidget);
  });
  testWidgets('mode is saved by authenticated command and server read', (t) async {
    await mount(t);
    await t.tap(find.byKey(const ValueKey('tasks-approval-mode'))); await t.pumpAndSettle();
    await t.tap(find.text('Review').last); await t.pumpAndSettle();
    expect(f.commands.single, {'type': 'member.approvalMode', 'mode': 'review'});
    expect(f.controller.personalTasks!.mode, 'review');
  });
  testWidgets('approve sends once while waiting and keeps the task', (t) async {
    await mount(t); await t.tap(find.text('Task new')); await t.pump();
    f.hold = Completer<void>();
    await t.tap(find.text('Approve')); await t.pump();
    await t.tap(find.text('Approve')); await t.pump();
    expect(f.commands.length, 1);
    f.hold!.complete(); await t.pumpAndSettle();
    expect(f.commands.single, {'type': 'task.approve', 'conversationId': 'new'});
    expect(find.text('Task new'), findsOneWidget);
  });
  testWidgets('rejection needs a reason and remains in the list', (t) async {
    await mount(t); await t.tap(find.text('Task new')); await t.pump();
    await t.tap(find.text('Reject')); await t.pumpAndSettle();
    expect(f.commands, isEmpty);
    await t.enterText(find.byKey(const ValueKey('task-reject-reason')), 'Too much scope');
    await t.tap(find.text('Reject task')); await t.pumpAndSettle();
    expect(f.commands.single, {'type': 'task.reject', 'conversationId': 'new', 'reason': 'Too much scope'});
    expect(find.byTooltip('Rejected'), findsOneWidget);
  });
  testWidgets('retry uses the same receipt and never displays raw error', (t) async {
    await mount(t); await t.tap(find.text('Task new')); await t.pump();
    f.fail = true; await t.tap(find.text('Approve')); await t.pumpAndSettle();
    expect(find.textContaining('fixture private'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
    f.fail = false; await t.tap(find.text('Retry')); await t.pumpAndSettle();
    expect(f.operations.toSet().length, 1);
    expect(f.commands.length, 2);
  });
  testWidgets('old backend has no approval controls', (t) async {
    await mount(t); f.supported = false;
    // A fresh account-bound controller never infers capability from stored mode.
    final old = TasksFixture()..supported = false;
    addTearDown(old.controller.dispose); await old.controller.refresh();
    await t.pumpWidget(MaterialApp(home: SuperTabPersonalTasksPane(controller: old.controller, onOpenTask: (_) {})));
    expect(find.text('Update Harness to use Tasks.'), findsOneWidget);
    expect(find.byKey(const ValueKey('tasks-approval-mode')), findsNothing);
  });
}
