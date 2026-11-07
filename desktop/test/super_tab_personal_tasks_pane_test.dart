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

import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/task_card.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';

import 'super_tab_parts_test.dart' show recorded;
import 'super_tab_personal_tasks_test.dart' show task, feed;
import 'support/memory_key_value_store.dart';

class TasksFixture {
  final store = MemoryKeyValueStore();
  bool supported = true, fail = false;
  Completer<void>? hold;
  String mode = 'autoApprove';
  var rows = [task('old', 1, 10), task('new', 1, 20)];
  String? olderCursor;
  var olderRows = <Map<String, dynamic>>[];
  final olderReads = <String>[];
  Completer<void>? olderHold;
  bool olderFail = false;
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
      if (path.contains('/personal-tasks')) {
        olderReads.add(path);
        await olderHold?.future;
        if (olderFail) throw StateError('fixture private payload');
        return feed(olderRows, mode: mode);
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
          olderCursor: olderCursor,
        );
      }
      return result;
    },
  );
}

Finder inCard(String id, Finder f) =>
    find.descendant(of: find.byKey(ValueKey('personal-task-$id')), matching: f);

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
      expect(inCard('new', find.text('Approve')), findsNothing);
      expect(inCard('new', find.text('Reject')), findsNothing);
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
      expect(find.byType(DropdownButtonFormField<String>), findsNothing);
      expect(
        inCard('new', find.widgetWithText(TextButton, 'Reject')),
        findsOneWidget,
      );
      expect(
        inCard('new', find.widgetWithText(FilledButton, 'Approve')),
        findsOneWidget,
      );
      expect(find.text('Suggested'), findsNothing);
      await t.tap(inCard('new', find.text('Approve')));
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
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Approve')));
    await t.pump();
    await t.tap(inCard('new', find.text('Approve')));
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
  testWidgets('approve with no agent shown says none was shown', (t) async {
    await mount(t);
    f.rows.last
      ..['agent'] = null
      ..['suggested'] = false
      ..['version'] = 2;
    await f.controller.refresh();
    await t.pump();
    await t.tap(inCard('new', find.text('Approve')));
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.approve',
      'conversationId': 'new',
      'suggestedAgentId': null,
    });
  });
  testWidgets('rejection needs a reason and remains in the list', (t) async {
    await mount(t);
    await t.tap(inCard('new', find.text('Reject')));
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
    f.fail = true;
    await t.tap(inCard('new', find.text('Approve')));
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
    'an open rejection cannot be submitted under a replacement account',
    (t) async {
      await mount(t);
      await t.tap(inCard('new', find.text('Reject')));
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

  group('older tasks on scroll', () {
    Future<void> many(WidgetTester t, {String? cursor}) async {
      f = TasksFixture()
        ..rows = [for (var i = 0; i < 30; i++) task('t$i', 1, 1000 + i)]
        ..olderCursor = cursor
        ..olderRows = [task('older', 1, 5)];
      addTearDown(() => f.controller.dispose());
      await f.controller.refresh();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 340,
              height: 600,
              child: SuperTabPersonalTasksPane(
                controller: f.controller,
                onOpenTask: (_) {},
              ),
            ),
          ),
        ),
      );
    }

    Future<void> toEnd(WidgetTester t) async {
      await t.drag(find.byType(Scrollable).last, const Offset(0, -10000));
      await t.pump();
    }

    testWidgets('reaching the end reads the older page once', (t) async {
      await many(t, cursor: 'c 1');
      f.olderHold = Completer<void>();
      await toEnd(t);
      await toEnd(t);
      expect(f.olderReads, [
        '/api/super-tabs/c51479bd73b59e58176ad9e4/personal-tasks?before=c%201',
      ]);
      f.olderHold!.complete();
      await t.pumpAndSettle();
      await toEnd(t);
      expect(find.text('Task older'), findsOneWidget);
      // The page had no cursor after it: the end was reached, and nothing more is read.
      expect(f.olderReads.length, 1);
    });

    testWidgets('a feed without a cursor never reads older pages', (t) async {
      await many(t);
      await toEnd(t);
      expect(f.olderReads, isEmpty);
    });

    testWidgets('a failed older read says so and retries', (t) async {
      await many(t, cursor: 'c1');
      f.olderFail = true;
      await toEnd(t);
      await t.pumpAndSettle();
      expect(find.text('Could not load older tasks.'), findsOneWidget);
      expect(find.textContaining('fixture private'), findsNothing);
      f.olderFail = false;
      await t.tap(find.byKey(const ValueKey('tasks-older-retry')));
      await t.pumpAndSettle();
      await toEnd(t);
      expect(find.text('Task older'), findsOneWidget);
      expect(f.olderReads.length, 2);
    });
  });

  group('card', () {
    testWidgets(
      'shows the tag, a three-line title, the mark top right and two avatars without names',
      (t) async {
        f = TasksFixture()
          ..rows = [
            task('new', 1, 20)
              ..['status'] = 'working'
              ..['canApprove'] = false
              ..['title'] = 'A long task title ' * 12
              ..['requester'] = {'id': '6a86', 'name': 'Requester name'},
          ];
        addTearDown(() => f.controller.dispose());
        await f.controller.refresh();
        await t.pumpWidget(
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
        final card = find.byKey(const ValueKey('personal-task-new'));
        final tag = inCard(
          'new',
          find.byKey(const ValueKey('personal-task-tag')),
        );
        final title = inCard('new', find.textContaining('A long task title'));
        final mark = inCard(
          'new',
          find.byWidgetPredicate((w) => w is ActivityMark),
        );
        expect(t.widget<Text>(title).maxLines, 3);
        expect(
          t.widget<DecoratedBox>(tag).decoration,
          isA<BoxDecoration>().having(
            (d) => d.color,
            'color',
            superTabProjectColor('lead5701'),
          ),
        );
        // The mark sits top right: above the title, at the card's right side.
        expect(t.getRect(mark).bottom, lessThanOrEqualTo(t.getRect(title).top));
        expect(
          t.getRect(mark).right,
          closeTo(
            t
                    .getRect(
                      inCard('new', find.byType(SuperTabPersonalTaskCard)),
                    )
                    .right -
                SuperTabTaskCard.tilePadding,
            2,
          ),
        );
        // Two avatars bottom left, who asked first; no names, priority or checks.
        final avatars = inCard('new', find.byType(SuperTabAvatar));
        expect(avatars, findsNWidgets(2));
        final asked = t.getRect(avatars.at(0)),
            agent = t.getRect(avatars.at(1));
        expect(t.widget<SuperTabAvatar>(avatars.at(0)).identity, 'person:6a86');
        expect(asked.left, lessThan(agent.left));
        expect(agent.right, lessThan(t.getRect(card).center.dx));
        expect(asked.top, greaterThan(t.getRect(title).bottom));
        expect(find.text('Requester name'), findsNothing);
        expect(find.text('Old name'), findsNothing);
        expect(find.textContaining('P0'), findsNothing);
        expect(find.textContaining('/'), findsNothing);
      },
    );

    testWidgets('a waiting card opens its task too', (t) async {
      final opened = <String>[];
      await mount(t);
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 340,
              child: SuperTabPersonalTasksPane(
                controller: f.controller,
                onOpenTask: opened.add,
              ),
            ),
          ),
        ),
      );
      await t.tap(find.text('Task new'));
      await t.pump();
      expect(opened, ['new']);
      expect(f.commands, isEmpty);
    });

    test('a project keeps its colour', () {
      expect(
        superTabProjectColor('lead5701'),
        superTabProjectColor('lead5701'),
      );
      expect(
        {
          for (final id in ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
            superTabProjectColor(id),
        }.length,
        greaterThan(1),
      );
    });
  });

  testWidgets('while a change is sent, Approve and Reject are disabled', (
    t,
  ) async {
    await mount(t);
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Approve')));
    await t.pump();
    for (final id in ['new', 'old']) {
      expect(
        t.widget<FilledButton>(inCard(id, find.byType(FilledButton))).onPressed,
        isNull,
      );
      expect(
        t.widget<TextButton>(inCard(id, find.byType(TextButton))).onPressed,
        isNull,
      );
    }
    f.hold!.complete();
    await t.pumpAndSettle();
    expect(
      t
          .widget<FilledButton>(inCard('old', find.byType(FilledButton)))
          .onPressed,
      isNotNull,
    );
  });
}
