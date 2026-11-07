import 'package:harness/super_tabs/zone_time.dart';

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_chrome.dart';
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

  /// Every read of the Swarm fails, as when the backend or this computer's Harness is gone.
  bool offline = false;

  /// The server's answer to the next command: refused, as a 4xx.
  SuperTabFailure? refuse;

  /// Change reads, so a test sees the pane read its tasks again.
  int reads = 0;
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
      if (offline) {
        throw const SuperTabFailure(
          'BACKEND_UNREACHABLE',
          'Could not reach the Harness backend.',
          statusCode: 502,
        );
      }
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
        if (refuse case final refusal?) throw refusal;
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
      reads++;
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

/// The card of task [id] is quiet: one hairline at radius 10 and no shadow (#4468).
bool quietCard(WidgetTester t, String id) {
  final ink = t.widget<Ink>(inCard(id, find.byType(Ink)).first);
  final d = ink.decoration! as BoxDecoration;
  return d.borderRadius == BorderRadius.circular(10) &&
      d.border == Border.all(color: DesktopChrome.rim) &&
      (d.boxShadow ?? const []).isEmpty;
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
    expect(find.byIcon(AppIcons.lightbulb), findsNWidgets(2));
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
    expect(find.text('Accept all'), findsOneWidget);
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
      expect(inCard('new', find.text('Accept')), findsNothing);
      expect(inCard('new', find.text('Decline')), findsNothing);
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
  testWidgets(
    'the header is quiet: Tasks in semibold, the choice plain text until hover',
    (t) async {
      await mount(t);
      final title = t.widget<Text>(find.text('Tasks')).style!;
      expect(title.fontSize, 13);
      expect(title.fontWeight, FontWeight.w600);
      expect(find.byType(DropdownButton<String>), findsNothing);
      final choice = find.byKey(const ValueKey('tasks-approval-mode'));
      final label = t
          .widget<Text>(
            find.descendant(of: choice, matching: find.text('Accept all')),
          )
          .style!;
      expect(label.fontSize, 12);
      expect(label.color, DesktopChrome.muted);
      double chevron() => t
          .widget<Opacity>(
            find
                .ancestor(
                  of: find.descendant(
                    of: choice,
                    matching: find.byIcon(AppIcons.chevronDown),
                  ),
                  matching: find.byType(Opacity),
                )
                .first,
          )
          .opacity;
      final rest = t.getSize(choice);
      expect(chevron(), 0);
      final mouse = await t.createGesture(kind: PointerDeviceKind.mouse);
      addTearDown(mouse.removePointer);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(t.getCenter(choice));
      await t.pump();
      expect(chevron(), 1);
      expect(t.getSize(choice), rest);
      await mouse.moveTo(Offset.zero);
      await t.pump();
      expect(chevron(), 0);
    },
  );
  testWidgets(
    'empty means empty: no tasks, or still loading, shows only the header',
    (t) async {
      List<String> words() => [
        for (final text in t.widgetList<Text>(
          find.descendant(
            of: find.byType(SuperTabPersonalTasksPane),
            matching: find.byType(Text),
          ),
        ))
          text.data ?? '',
      ];
      Widget pane(SuperTabController c) => MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 340,
            child: SuperTabPersonalTasksPane(controller: c, onOpenTask: (_) {}),
          ),
        ),
      );
      final loading = TasksFixture();
      addTearDown(() => loading.controller.dispose());
      await t.pumpWidget(pane(loading.controller));
      expect(words(), ['Tasks']);
      final empty = TasksFixture()..rows = [];
      addTearDown(() => empty.controller.dispose());
      await empty.controller.refresh();
      await t.pumpWidget(pane(empty.controller));
      expect(words(), ['Tasks', 'Accept all']);
    },
  );
  testWidgets('mode is saved by authenticated command and server read', (
    t,
  ) async {
    await mount(t);
    await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
    await t.pumpAndSettle();
    await t.tap(find.text('Ask me').last);
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
        inCard('new', find.widgetWithText(TextButton, 'Decline')),
        findsOneWidget,
      );
      expect(
        inCard('new', find.widgetWithText(FilledButton, 'Accept')),
        findsOneWidget,
      );
      // Decline is plain text: no fill and no rim over the theme's text button (#4468).
      final reject = t
          .widget<TextButton>(
            inCard('new', find.widgetWithText(TextButton, 'Decline')),
          )
          .style!;
      expect(reject.side?.resolve({}), BorderSide.none);
      expect(reject.backgroundColor?.resolve({}), Colors.transparent);
      expect(find.text('Suggested'), findsNothing);
      await t.tap(inCard('new', find.text('Accept')));
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
    await t.tap(inCard('new', find.text('Accept')));
    await t.pump();
    await t.tap(inCard('new', find.text('Accept')));
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
    await t.tap(inCard('new', find.text('Accept')));
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.approve',
      'conversationId': 'new',
      'suggestedAgentId': null,
    });
  });
  testWidgets('rejection needs a reason and remains in the list', (t) async {
    await mount(t);
    await t.tap(inCard('new', find.text('Decline')));
    await t.pumpAndSettle();
    expect(f.commands, isEmpty);
    await t.enterText(
      find.byKey(const ValueKey('task-reject-reason')),
      'Too much scope',
    );
    await t.pump();
    await t.tap(find.text('Decline').last);
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.reject',
      'conversationId': 'new',
      'reason': 'Too much scope',
    });
    // The mark says why on hover (finding 17).
    expect(
      inCard('new', find.byTooltip('Declined: Too much scope')),
      findsOneWidget,
    );
  });
  testWidgets('retry uses the same receipt and never displays raw error', (
    t,
  ) async {
    await mount(t);
    f.fail = true;
    await t.tap(inCard('new', find.text('Accept')));
    await t.pumpAndSettle();
    expect(find.textContaining('fixture private'), findsNothing);
    // What happened and what to do, in two short sentences (anh Dee, 11-07).
    expect(find.text('Not confirmed. Retry to check.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    f.fail = false;
    await t.tap(find.text('Retry'));
    await t.pumpAndSettle();
    expect(f.operations.toSet().length, 1);
    expect(f.commands.length, 2);
  });
  testWidgets('every status shows its own word and mark (finding 4)', (
    t,
  ) async {
    const statuses = <(String, String, HarnessActivity?)>[
      ('planned', 'Planned', HarnessActivity.starting),
      ('working', 'Working', HarnessActivity.working),
      ('needs_human', 'Needs a human', HarnessActivity.needsInput),
      ('blocked', 'Stuck', null),
      ('review', 'Ready for review', HarnessActivity.needsInput),
      ('done', 'Done', HarnessActivity.done),
      ('stopped', 'Stopped', HarnessActivity.paused),
      ('cancelled', 'Cancelled', HarnessActivity.paused),
      ('reconciling', 'Checking its agent', HarnessActivity.unknown),
      ('lost', 'Agent lost', HarnessActivity.offline),
      ('proposal', 'Proposal', null),
      ('rejected', 'Declined', null),
      ('a-later-status', 'Status unavailable', HarnessActivity.unknown),
    ];
    await mount(t);
    f.rows
      ..clear()
      ..addAll([
        for (final (i, (status, _, _)) in statuses.indexed)
          {...task(status, 1, 100 - i), 'status': status, 'canApprove': false},
      ]);
    f.controller.personalTasks!.apply(feed(f.rows, reset: true));
    await t.binding.setSurfaceSize(const Size(340, 4000));
    addTearDown(() => t.binding.setSurfaceSize(null));
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabPersonalTasksPane(
            controller: f.controller,
            onOpenTask: (_) {},
          ),
        ),
      ),
    );
    await t.pump();
    for (final (status, word, activity) in statuses) {
      expect(
        inCard(status, find.byTooltip(word)),
        findsOneWidget,
        reason: status,
      );
      if (activity != null) {
        final mark = t.widget<ActivityMark>(
          inCard(status, find.byType(ActivityMark)),
        );
        expect(mark.activity, activity, reason: status);
      }
    }
    // Its own icon (task #4461): no ActivityMark, so no terminal ✗.
    expect(
      inCard('blocked', find.byIcon(AppIcons.triangleAlert)),
      findsOneWidget,
    );
  });
  group('a refused change unlocks the pane and says why (finding 3)', () {
    FilledButton approve(String id) =>
        find
                .ancestor(
                  of: inCard(id, find.text('Accept')),
                  matching: find.byType(FilledButton),
                )
                .evaluate()
                .single
                .widget
            as FilledButton;
    for (final (status, code, sentence) in [
      (409, 'CONFLICT', 'The suggested agent changed. Read the task again.'),
      (403, 'FORBIDDEN', 'You can no longer approve this task.'),
    ]) {
      testWidgets('$status: the server\'s sentence, no Retry, cards work', (
        t,
      ) async {
        await mount(t);
        f.refuse = SuperTabFailure(code, sentence, statusCode: status);
        final before = f.reads;
        await t.tap(inCard('new', find.text('Accept')));
        await t.pumpAndSettle();
        expect(find.text(sentence), findsOneWidget);
        expect(find.text('Retry'), findsNothing);
        expect(approve('old').onPressed, isNotNull);
        expect(approve('new').onPressed, isNotNull);
        expect(f.reads, greaterThan(before), reason: 'reads the task again');
        f.refuse = null;
        await t.tap(inCard('old', find.text('Accept')));
        await t.pumpAndSettle();
        expect(f.commands.length, 2);
        expect(f.operations.toSet().length, 2, reason: 'a new change');
        expect(find.text(sentence), findsNothing);
      });
    }
    testWidgets('a refused Retry of a lost answer unlocks too', (t) async {
      await mount(t);
      f.fail = true;
      await t.tap(inCard('new', find.text('Accept')));
      await t.pumpAndSettle();
      expect(find.text('Retry'), findsOneWidget);
      expect(approve('old').onPressed, isNull);
      f
        ..fail = false
        ..refuse = const SuperTabFailure(
          'CONFLICT',
          'This task is archived.',
          statusCode: 409,
        );
      await t.tap(find.text('Retry'));
      await t.pumpAndSettle();
      expect(find.text('This task is archived.'), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      expect(approve('old').onPressed, isNotNull);
    });
    testWidgets('an update required says so, with no Retry', (t) async {
      await mount(t);
      f.refuse = const SuperTabFailure(
        'UPDATE_REQUIRED',
        'fixture private payload',
        statusCode: 426,
      );
      await t.tap(inCard('new', find.text('Accept')));
      await t.pumpAndSettle();
      expect(find.text('Update Harness to change Tasks.'), findsOneWidget);
      expect(find.textContaining('fixture private'), findsNothing);
      expect(find.text('Retry'), findsNothing);
    });
    testWidgets('a refused mode change unlocks the cards', (t) async {
      await mount(t);
      f.refuse = const SuperTabFailure(
        'FORBIDDEN',
        'Only members choose how their tasks are approved.',
        statusCode: 403,
      );
      await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
      await t.pumpAndSettle();
      await t.tap(find.text('Ask me').last);
      await t.pumpAndSettle();
      expect(
        find.text('Only members choose how their tasks are approved.'),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsNothing);
      expect(approve('new').onPressed, isNotNull);
    });
  });
  // Task #4220: the controller drops a refused change, but the pane kept it, so Tasks stayed disabled and its Retry sent
  // the refused change again.
  testWidgets('a refused change says the server\'s reason and Tasks works '
      'again', (t) async {
    await mount(t);
    f.refuse = const SuperTabFailure(
      'FORBIDDEN',
      'Only the project\'s owner changes this.',
      statusCode: 403,
    );
    await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
    await t.pumpAndSettle();
    await t.tap(find.text('Ask me').last);
    await t.pumpAndSettle();
    expect(
      find.text('Only the project\'s owner changes this.'),
      findsOneWidget,
    );
    expect(find.text('Retry'), findsNothing);
    f.refuse = null;
    await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
    await t.pumpAndSettle();
    await t.tap(find.text('Ask me').last);
    await t.pumpAndSettle();
    expect(f.commands.length, 2);
    expect(f.operations.toSet().length, 2);
    expect(f.controller.personalTasks!.mode, 'review');
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
      await t.tap(inCard('new', find.text('Decline')));
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
      await t.tap(find.text('Decline').last);
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
        // A neutral grey capsule with secondary text, never the project's colour (#4468).
        expect(
          t.widget<DecoratedBox>(tag).decoration,
          isA<ShapeDecoration>()
              .having((d) => d.color, 'color', grid.AppSurface.wellFill)
              .having((d) => d.shape, 'shape', isA<StadiumBorder>()),
        );
        expect(
          t
              .widget<Text>(
                find.descendant(of: tag, matching: find.byType(Text)),
              )
              .style
              ?.color,
          DesktopChrome.muted,
        );
        expect(quietCard(t, 'new'), isTrue);
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
        expect(asked.height, 18);
        expect(agent.height, 18);
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

    testWidgets(
      'a long project name stays in its capsule and a selected card is only filled',
      (t) async {
        f = TasksFixture()
          ..rows = [
            // A project the snapshot doesn't hold shows the row's own name.
            task('new', 1, 20)
              ..['projectId'] = 'elsewhere'
              ..['projectName'] = 'A very long project name ' * 8,
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
                  selectedId: 'new',
                ),
              ),
            ),
          ),
        );
        expect(t.takeException(), isNull);
        final card = t.getRect(
          inCard('new', find.byType(SuperTabPersonalTaskCard)),
        );
        final mark = t.getRect(
          inCard('new', find.byType(SuperTabTaskStatusMark)),
        );
        expect(mark.right, lessThanOrEqualTo(card.right));
        expect(quietCard(t, 'new'), isTrue);
      },
    );
  });

  testWidgets('while a change is sent, Approve and Reject are disabled', (
    t,
  ) async {
    await mount(t);
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Accept')));
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

  // anh Dee's pick (task #4461): Proposal is a lightbulb, Rejected a thumbs-down, Failed a triangle in the error ink;
  // the check, question mark and spinner stay. No Flutter status draws an X: an X means close.
  testWidgets('each task status has its own mark and none is an X', (t) async {
    late BuildContext context;
    Future<void> show(String status) => t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (c) {
              context = c;
              return SuperTabTaskStatusMark(status);
            },
          ),
        ),
      ),
    );
    Icon? icon() => t.widgetList<Icon>(find.byType(Icon)).firstOrNull;
    await show('proposal');
    expect(icon()?.icon, AppIcons.lightbulb);
    await show('rejected');
    expect(icon()?.icon, AppIcons.thumbsDown);
    await show('blocked');
    expect(icon()?.icon, AppIcons.triangleAlert);
    expect(icon()?.color, Theme.of(context).colorScheme.error);
    expect(find.bySemanticsLabel('Stuck'), findsOneWidget);
    for (final status in [
      'proposal',
      'rejected',
      'planned',
      'working',
      'needs_human',
      'blocked',
      'review',
      'done',
      'stopped',
      'cancelled',
      'lost',
    ]) {
      await show(status);
      expect(
        {AppIcons.circleX, AppIcons.close}.contains(icon()?.icon),
        isFalse,
        reason: status,
      );
      expect(
        find.textContaining(RegExp('[✗✕×]')),
        findsNothing,
        reason: status,
      );
    }
  });
}
