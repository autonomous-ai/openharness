import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/pull_request_icon.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/shared/widgets/skeleton.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/tasks/task_header.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_parts_test.dart' show recorded;
import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture, inCard;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/memory_key_value_store.dart';

const _pr = 'https://github.com/autonomous-ai/openharness/pull/3464';
const _waiting = 'Waiting for the last change to be confirmed';

/// A controller whose Swarm holds task `aeef` with its pull request's card, merged or not.
SuperTabController _headerController({required bool merged}) {
  final store = MemoryKeyValueStore();
  return SuperTabController(
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
      final result = recorded('first_load');
      for (final part in (result['groups'] as List).cast<Map>()) {
        if (part['key'] != 'aeef') continue;
        (part['data'] as Map)['cards'] = {
          'pullRequests': [
            {'url': _pr, 'messageId': 'm1', if (merged) 'mergedAt': 1},
          ],
        };
      }
      return result;
    },
  );
}

Finder _prIcon(String state) => find.byWidgetPredicate(
  (w) =>
      w is SvgPicture &&
      w.bytesLoader is SvgAssetLoader &&
      (w.bytesLoader as SvgAssetLoader).assetName ==
          pullRequestIconAsset(state),
);

void main() {
  setUpAll(superTabLoadZones);
  late TasksFixture f;

  Future<void> pumpPane(WidgetTester t) => t.pumpWidget(
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

  Future<void> mount(WidgetTester t) async {
    f = TasksFixture();
    addTearDown(() => f.controller.dispose());
    await f.controller.refresh();
    await pumpPane(t);
  }

  Finder spinnerIn(Finder button) => find.descendant(
    of: button,
    matching: find.byType(CircularProgressIndicator),
  );

  testWidgets(
    'the pressed Approve spins; the other buttons say why they wait',
    (t) async {
      await mount(t);
      f.hold = Completer<void>();
      await t.tap(inCard('new', find.text('Approve')));
      await t.pump();
      expect(
        spinnerIn(inCard('new', find.byType(FilledButton))),
        findsOneWidget,
      );
      expect(spinnerIn(inCard('new', find.byType(TextButton))), findsNothing);
      expect(
        inCard('old', find.byType(CircularProgressIndicator)),
        findsNothing,
      );
      // Every disabled decision names what it waits on.
      expect(inCard('old', find.byTooltip(_waiting)), findsNWidgets(2));
      f.hold!.complete();
      await t.pumpAndSettle();
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byTooltip(_waiting), findsNothing);
    },
  );

  testWidgets('the pressed Reject spins while its rejection is confirmed', (
    t,
  ) async {
    await mount(t);
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Reject')));
    await t.pumpAndSettle();
    await t.enterText(
      find.byKey(const ValueKey('task-reject-reason')),
      'Too much scope',
    );
    await t.pump();
    await t.tap(find.text('Reject task').last);
    await t.pump();
    await t.pump(const Duration(milliseconds: 300));
    expect(spinnerIn(inCard('new', find.byType(TextButton))), findsOneWidget);
    expect(spinnerIn(inCard('new', find.byType(FilledButton))), findsNothing);
    f.hold!.complete();
    await t.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets(
    'Auto approve and Review are the app select, saying what each does',
    (t) async {
      await mount(t);
      final mode = find.byKey(const ValueKey('tasks-approval-mode'));
      expect(t.widget(mode), isA<AppSelectField<String>>());
      expect(find.byType(DropdownButton<String>), findsNothing);
      await t.tap(mode);
      await t.pumpAndSettle();
      expect(
        find.text('Tasks you ask for start without waiting for you.'),
        findsOneWidget,
      );
      expect(
        find.text(
          'Tasks you ask for wait for your Approve before work starts.',
        ),
        findsOneWidget,
      );
      await t.tap(find.text('Review').last);
      await t.pumpAndSettle();
      expect(f.commands.single, {
        'type': 'member.approvalMode',
        'mode': 'review',
      });
    },
  );

  testWidgets('loading draws skeleton cards, not words', (t) async {
    f = TasksFixture();
    addTearDown(() => f.controller.dispose());
    await pumpPane(t);
    expect(find.byType(SkeletonBlock), findsOneWidget);
    expect(find.text('Loading Tasks…'), findsNothing);
  });

  testWidgets('the empty pane says what will show there', (t) async {
    f = TasksFixture()..rows = [];
    addTearDown(() => f.controller.dispose());
    await f.controller.refresh();
    await pumpPane(t);
    expect(
      find.text('No tasks yet. Tasks your agents start or propose show here.'),
      findsOneWidget,
    );
  });

  for (final merged in [false, true]) {
    testWidgets(
      'the task header draws the ${merged ? 'merged' : 'open'} pull request icon',
      (t) async {
        final c = _headerController(merged: merged);
        addTearDown(c.dispose);
        await c.refresh();
        expect(c.snapshot?.conversation('aeef'), isNotNull);
        await t.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SuperTabTaskHeader(
                controller: c,
                task: SuperTabPersonalTask(
                  task('aeef', 1, 20)
                    ..['status'] = 'done'
                    ..['canApprove'] = false
                    ..['pullRequestUrl'] = _pr,
                ),
              ),
            ),
          ),
        );
        expect(_prIcon('Merged'), merged ? findsOneWidget : findsNothing);
        expect(_prIcon('Open'), merged ? findsNothing : findsOneWidget);
        expect(find.text('#3464'), findsOneWidget);
      },
    );
  }
}
