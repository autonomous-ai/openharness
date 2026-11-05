import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/task_card.dart';
import 'package:harness/super_tabs/tasks_view.dart';
import 'package:harness/widgets/harness_activity_mark.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final _now = DateTime(2026, 11, 4, 9);

Finder _card(String id) => find.byKey(ValueKey('super-task-card-$id'));
Finder _mark(String id) =>
    find.descendant(of: _card(id), matching: find.byType(ActivityMark));

Future<SuperTabController> _show(
  WidgetTester tester,
  ConversationServer server, {
  bool list = false,
  bool reduceMotion = true,
  Set<String> asking = const {},
}) async {
  await tester.binding.setSurfaceSize(const Size(1600, 1200));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final controller = server.controller();
  addTearDown(controller.dispose);
  await controller.refresh();
  final storage = MemoryKeyValueStore();
  if (list) await storage.setString('super-tasks-layout', 'list');
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: Scaffold(
        body: SuperTabTasksView(
          controller: controller,
          project: controller.snapshot!.projects.single,
          storage: storage,
          needsHuman: (task) => asking.contains(task.id) ? 1 : 0,
          onOpenTask: (_) {},
          onOpenProposal: (_) {},
          now: () => _now,
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  return controller;
}

ConversationServer _server(Map<String, dynamic> task) {
  final server = tasksServer(empty: true);
  (server.state['conversations'] as List).add(task);
  return server;
}

void main() {
  for (final list in [false, true]) {
    final layout = list ? 'List' : 'Board';
    for (final (status, liveness, merged, activity)
        in <(String?, Map<String, dynamic>?, bool, HarnessActivity)>[
          (null, null, false, HarnessActivity.starting),
          ('working', null, false, HarnessActivity.working),
          (
            'needs_human',
            {'state': 'waiting', 'why': 'person', 'personId': 'tony'},
            false,
            HarnessActivity.needsInput,
          ),
          ('review', null, false, HarnessActivity.needsInput),
          ('done', null, false, HarnessActivity.needsInput),
          ('blocked', null, false, HarnessActivity.offline),
          ('lost', null, false, HarnessActivity.offline),
          (
            'working',
            {'state': 'orphaned', 'why': 'agent'},
            false,
            HarnessActivity.offline,
          ),
          (
            'working',
            {'state': 'waiting', 'why': 'queued'},
            false,
            HarnessActivity.starting,
          ),
          ('failed', null, false, HarnessActivity.failed),
          ('done', null, true, HarnessActivity.done),
        ]) {
      testWidgets('$layout $status $liveness merged=$merged uses $activity', (
        tester,
      ) async {
        await _show(
          tester,
          _server(
            taskFixture(
              'task',
              'A task',
              30,
              status: status,
              liveness: liveness,
              merged: merged,
              pullRequest: merged ? 3007 : null,
              shippedAt: merged ? _now : null,
            ),
          ),
          list: list,
        );
        expect(_mark('task'), findsOneWidget);
        expect(tester.widget<ActivityMark>(_mark('task')).activity, activity);
        expect(
          find.descendant(
            of: _mark('task'),
            matching: find.text(activity.mark),
          ),
          findsOneWidget,
        );
        expect(find.textContaining('Needs you'), findsNothing);
        await tester.pumpWidget(const SizedBox());
      });
    }

    testWidgets('$layout reader attention is ? with Needs you in caption', (
      tester,
    ) async {
      await _show(
        tester,
        _server(
          taskFixture(
            'task',
            'Shipped asks for a check',
            31,
            status: 'done',
            merged: true,
            pullRequest: 3007,
            shippedAt: _now,
          ),
        ),
        list: list,
        asking: {'task'},
      );
      expect(
        tester.widget<ActivityMark>(_mark('task')).activity,
        HarnessActivity.needsInput,
      );
      final card = tester.widget<SuperTabTaskCard>(_card('task'));
      expect(card.caption, contains('Needs you'));
      expect(
        find.descendant(of: _card('task'), matching: find.text('Needs you')),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('$layout shipped missing agent is omitted, known agent stays', (
      tester,
    ) async {
      final server = _server(
        taskFixture(
          'missing',
          'Missing agent',
          32,
          status: 'done',
          agent: 'gone',
          merged: true,
          pullRequest: 3007,
          shippedAt: _now,
        ),
      );
      (server.state['conversations'] as List).add(
        taskFixture(
          'known',
          'Known agent',
          33,
          status: 'done',
          merged: true,
          pullRequest: 3008,
          shippedAt: _now,
        ),
      );
      await _show(tester, server, list: list);
      expect(find.textContaining('Agent unavailable'), findsNothing);
      expect(
        tester.widget<SuperTabTaskCard>(_card('known')).caption,
        contains('Finch2'),
      );
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('unread is bold without dots and mark stays top right', (
    tester,
  ) async {
    final server = _server(
      taskFixture(
        'task',
        'A long unread title that wraps over several lines of the tile',
        34,
      ),
    );
    final task = (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .last;
    task['lastMessageSequence'] = 10;
    await _show(tester, server);
    final card = tester.widget<SuperTabTaskCard>(_card('task'));
    expect(card.unread, isTrue);
    final title = find.descendant(
      of: _card('task'),
      matching: find.text(card.title),
    );
    expect(
      tester.widget<Text>(title).style!.fontWeight!.value,
      greaterThanOrEqualTo(FontWeight.w600.value),
    );
    final circles = find.descendant(
      of: _card('task'),
      matching: find.byWidgetPredicate(
        (widget) =>
            widget is DecoratedBox &&
            widget.decoration is ShapeDecoration &&
            (widget.decoration as ShapeDecoration).shape is CircleBorder,
      ),
    );
    expect(circles, findsNothing);
    expect(tester.getTopLeft(_mark('task')).dy, tester.getTopLeft(title).dy);
    expect(
      tester.getTopLeft(_mark('task')).dx,
      greaterThan(tester.getTopLeft(title).dx),
    );
    await tester.pumpWidget(const SizedBox());
  });

  for (final reduceMotion in [false, true]) {
    testWidgets(
      'working mark ${reduceMotion ? 'freezes' : 'spins'} with Reduce Motion=$reduceMotion',
      (tester) async {
        await _show(
          tester,
          _server(taskFixture('task', 'Working', 35, status: 'working')),
          reduceMotion: reduceMotion,
        );
        final text = find.descendant(
          of: _mark('task'),
          matching: find.byType(Text),
        );
        expect(text, findsOneWidget);
        final before = tester.widget<Text>(text).data;
        await tester.pump(activityFrameInterval);
        final after = tester.widget<Text>(text).data;
        expect(after, reduceMotion ? before : isNot(before));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
