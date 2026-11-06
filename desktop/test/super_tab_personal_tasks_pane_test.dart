import 'package:harness/super_tabs/zone_time.dart';

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/widgets/harness_activity_mark.dart';
import 'package:harness/state/harness_activity.dart';

import 'swarm_state_test.dart' show createApp;

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
    tabId: 'c51479bd73b59e58176ad9e4',
    accountId: '6a86',
    initial: {
      'tabId': 'c51479bd73b59e58176ad9e4',
      'accountId': '6a86',
      'selectedId': 'lead5701',
    },
    pollInterval: Duration.zero,
    save: (value) => store.write('controller', value.toString()),
    request: (method, path, {body}) async {
      if (path.contains('/messages')) {
        return {'messages': <dynamic>[], 'next': null};
      }
      if (method == 'POST') {
        operations.add(body!['operationId'] as String);
        final command = Map<String, dynamic>.from(body['command'] as Map);
        commands.add(command);
        await hold?.future;
        if (fail) throw StateError('fixture private payload');
        if (command['type'] == 'member.approvalMode') {
          mode = command['mode'] as String;
        }
        for (final row in rows) {
          if (row['id'] != command['conversationId']) continue;
          row['version'] = (row['version'] as int) + 1;
          if (command['type'] == 'task.approve') row['status'] = 'working';
          if (command['type'] == 'task.reject') {
            row['status'] = 'rejected';
            row['reason'] = command['reason'];
          }
          if (command['type'] == 'task.suggest') {
            row['agent'] = {'id': command['agentId'], 'name': 'Selected agent'};
          }
        }
        return {'result': <String, dynamic>{}};
      }
      final result = path.endsWith('/parts')
          ? recorded('first_load')
          : {
              'format': 2,
              'cursor': 'next',
              'epoch': 3,
              'derived': recorded('first_load')['derived'],
            };
      if (supported) {
        result['personalTasks'] = feed(
          rows,
          reset: path.endsWith('/parts'),
          mode: mode,
        );
      }
      return result;
    },
  );
}

void main() {
  setUpAll(superTabLoadZones);
  late TasksFixture f;
  Future<void> mount(WidgetTester tester) async {
    f = TasksFixture();
    addTearDown(() => f.controller.dispose());
    await f.controller.refresh();
    expect(
      f.controller.canWrite,
      isTrue,
      reason:
          "${f.controller.error}; ${f.controller.snapshot?.people.map((p) => p.id)}",
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 340,
            child: SuperTabPersonalTasksPane(
              controller: f.controller,
              onOpenTask: (_) {},
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('newest task first with project, agent and proposal mark', (
    t,
  ) async {
    await mount(t);
    expect(
      t.getTopLeft(find.text('Task new')).dy,
      lessThan(t.getTopLeft(find.text('Task old')).dy),
    );
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.byTooltip('Proposal'), findsNWidgets(2));
    expect(find.byIcon(AppIcons.circleDashed), findsNWidgets(2));
    f.rows.first['status'] = 'working';
    f.rows.first['version'] = 2;
    await f.controller.refresh();
    await t.pump();
    expect(
      find.byWidgetPredicate(
        (w) => w is ActivityMark && w.activity == HarnessActivity.working,
      ),
      findsOneWidget,
    );
    expect(find.text('Auto approve'), findsOneWidget);
  });
  testWidgets(
    'ordinary proposals open their conversation without approval controls',
    (t) async {
      await mount(t);
      final opened = <String>[];
      f.rows.last.remove('canApprove');
      f.rows.last['version'] = 2;
      await f.controller.refresh();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabPersonalTasksPane(
              controller: f.controller,
              onOpenTask: opened.add,
            ),
          ),
        ),
      );
      await t.tap(find.text('Task new'));
      await t.pump();
      expect(opened, ['new']);
      expect(find.text('Approve'), findsNothing);
      expect(find.text('Reject'), findsNothing);
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(f.commands, isEmpty);
      f.rows.last['canApprove'] = false;
      f.rows.last['version'] = 3;
      await f.controller.refresh();
      await t.pump();
      await t.tap(find.text('Task new'));
      await t.pump();
      expect(opened, ['new', 'new']);
      expect(f.commands, isEmpty);
    },
  );
  testWidgets('mode is saved by authenticated command and server read', (
    t,
  ) async {
    await mount(t);
    await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
    await t.pumpAndSettle();
    await t.tap(find.text('Review').last);
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'member.approvalMode',
      'mode': 'review',
    });
    expect(f.controller.personalTasks!.mode, 'review');
  });
  for (final mode in ['autoApprove', 'review']) {
    testWidgets('waiting task stays actionable in $mode with primary Approve', (
      t,
    ) async {
      await mount(t);
      f.mode = mode;
      await f.controller.refresh();
      await t.pump();
      await t.tap(find.text('Task new'));
      await t.pump();
      expect(find.byType(DropdownButtonFormField<String>), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Reject'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Approve'), findsOneWidget);
      expect(find.text('Waiting for you'), findsNWidgets(2));
      expect(find.text('Suggested'), findsNothing);
      await t.tap(find.text('Approve'));
      await t.pumpAndSettle();
      expect(f.commands.single, {
        'type': 'task.approve',
        'conversationId': 'new',
        'suggestedAgentId': '0540',
      });
    });
  }
  testWidgets('approve sends once while waiting and keeps the task', (t) async {
    await mount(t);
    await t.tap(find.text('Task new'));
    await t.pump();
    f.hold = Completer<void>();
    await t.tap(find.text('Approve'));
    await t.pump();
    await t.tap(find.text('Approve'));
    await t.pump();
    expect(f.commands.length, 1);
    f.hold!.complete();
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.approve',
      'conversationId': 'new',
      'suggestedAgentId': '0540',
    });
    expect(find.text('Task new'), findsOneWidget);
  });
  testWidgets('rejection needs a reason and remains in the list', (t) async {
    await mount(t);
    await t.tap(find.text('Task new'));
    await t.pump();
    await t.tap(find.text('Reject'));
    await t.pumpAndSettle();
    expect(f.commands, isEmpty);
    await t.enterText(
      find.byKey(const ValueKey('task-reject-reason')),
      'Too much scope',
    );
    await t.pump();
    await t.tap(find.text('Reject task').last);
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.reject',
      'conversationId': 'new',
      'reason': 'Too much scope',
    });
    expect(find.byTooltip('Rejected'), findsOneWidget);
  });
  testWidgets('retry uses the same receipt and never displays raw error', (
    t,
  ) async {
    await mount(t);
    await t.tap(find.text('Task new'));
    await t.pump();
    f.fail = true;
    await t.tap(find.text('Approve'));
    await t.pumpAndSettle();
    expect(find.textContaining('fixture private'), findsNothing);
    expect(find.text('Retry'), findsOneWidget);
    f.fail = false;
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    expect(f.operations.toSet().length, 1);
    expect(f.commands.length, 2);
  });
  testWidgets('old backend has no approval controls', (t) async {
    await mount(t);
    f.supported = false;
    // A fresh account-bound controller never infers capability from stored mode.
    final old = TasksFixture()..supported = false;
    addTearDown(old.controller.dispose);
    await old.controller.refresh();
    await t.pumpWidget(
      MaterialApp(
        home: SuperTabPersonalTasksPane(
          controller: old.controller,
          onOpenTask: (_) {},
        ),
      ),
    );
    expect(find.text('Update Harness to use Tasks.'), findsOneWidget);
    expect(find.byKey(const ValueKey('tasks-approval-mode')), findsNothing);
  });
  testWidgets(
    'a suggestion changed on another device replaces the displayed choice',
    (t) async {
      await mount(t);
      await t.tap(find.text('Task new'));
      await t.pump();
      final field = find.byType(DropdownButtonFormField<String>);
      expect(t.state<FormFieldState<String>>(field).value, '0540');
      f.rows.last['version'] = 2;
      f.rows.last['agent'] = {'id': '0fcb', 'name': 'River'};
      await f.controller.refresh();
      await t.pump();
      expect(t.state<FormFieldState<String>>(field).value, '0fcb');
    },
  );

  testWidgets(
    'a person can change the suggestion without approving or starting work',
    (t) async {
      await mount(t);
      await t.tap(find.text('Task new'));
      await t.pump();
      await t.tap(find.byType(DropdownButtonFormField<String>));
      await t.pumpAndSettle();
      await t.tap(find.text('River').last);
      await t.pumpAndSettle();
      expect(f.commands.single, {
        'type': 'task.suggest',
        'conversationId': 'new',
        'agentId': '0fcb',
      });
      expect(f.rows.last['status'], 'proposal');
    },
  );

  testWidgets(
    'an open rejection cannot be submitted under a replacement account',
    (t) async {
      await mount(t);
      await t.tap(find.text('Task new'));
      await t.pump();
      await t.tap(find.text('Reject'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('task-reject-reason')),
        'Decline',
      );
      await t.pump();
      final replacement = TasksFixture();
      addTearDown(replacement.controller.dispose);
      await replacement.controller.refresh();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 340,
              child: SuperTabPersonalTasksPane(
                controller: replacement.controller,
                onOpenTask: (_) {},
              ),
            ),
          ),
        ),
      );
      await t.tap(find.text('Reject task').last);
      await t.pumpAndSettle();
      expect(f.commands, isEmpty);
      expect(replacement.commands, isEmpty);
    },
  );

  testWidgets(
    'the Desktop shell defaults its right slot to Tasks and keeps chat in the middle',
    (t) async {
      await mount(t);
      final app = createApp();
      addTearDown(app.dispose);
      t.view.physicalSize = const Size(1600, 1000);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabView(
              controller: f.controller,
              app: app,
              board: true,
              machineName: (_) => 'Computer',
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              onNewSwarm: () {},
            ),
          ),
        ),
      );
      await t.pump();
      expect(find.byType(SuperTabPersonalTasksPane), findsOneWidget);
      expect(t.getSize(find.byType(SuperTabPersonalTasksPane)).width, 340);
      expect(find.byKey(const ValueKey('super-board-chat')), findsNothing);
      expect(find.text('Task new'), findsOneWidget);
    },
  );
}
