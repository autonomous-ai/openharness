import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
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
import 'support/real_fonts.dart';

const taskHeaderPr = 'https://github.com/autonomous-ai/openharness/pull/3464';
const _waiting = 'Waiting for the last change to be confirmed';

/// A controller whose Swarm holds task `aeef` with its pull request's card, merged or not.
SuperTabController taskHeaderController({required bool merged}) {
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
            {'url': taskHeaderPr, 'messageId': 'm1', if (merged) 'mergedAt': 1},
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
  setUpAll(() async {
    await loadRealFonts();
    await superTabLoadZones();
  });
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

  testWidgets('the pressed Accept spins; the other buttons say why they wait', (
    t,
  ) async {
    await mount(t);
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Accept')));
    await t.pump();
    expect(spinnerIn(inCard('new', find.byType(FilledButton))), findsOneWidget);
    expect(spinnerIn(inCard('new', find.byType(TextButton))), findsNothing);
    expect(inCard('old', find.byType(CircularProgressIndicator)), findsNothing);
    // Every disabled decision names what it waits on.
    expect(inCard('old', find.byTooltip(_waiting)), findsNWidgets(2));
    f.hold!.complete();
    await t.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byTooltip(_waiting), findsNothing);
  });

  testWidgets('the pressed Decline spins while its decline is confirmed', (
    t,
  ) async {
    await mount(t);
    f.hold = Completer<void>();
    await t.tap(inCard('new', find.text('Decline')));
    await t.pumpAndSettle();
    await t.enterText(
      find.byKey(const ValueKey('task-reject-reason')),
      'Too much scope',
    );
    await t.pump();
    await t.tap(find.text('Decline').last);
    await t.pump();
    await t.pump(const Duration(milliseconds: 300));
    expect(spinnerIn(inCard('new', find.byType(TextButton))), findsOneWidget);
    expect(spinnerIn(inCard('new', find.byType(FilledButton))), findsNothing);
    f.hold!.complete();
    await t.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets(
    'Accept all and Ask me are the app dropdown, plain until hover, saying what each does',
    (t) async {
      await mount(t);
      final mode = find.byKey(const ValueKey('tasks-approval-mode'));
      // Plain text at rest (#4468); the menu is the app's one dropdown (#3532).
      expect(find.byType(AppSelectField<String>), findsNothing);
      expect(find.byType(DropdownButton<String>), findsNothing);
      await t.tap(mode);
      await t.pumpAndSettle();
      // Each says what it does, whole, in the pane's 340.
      for (final detail in [
        'Your tasks start right away.',
        'Your tasks wait for you to accept them.',
      ]) {
        expect(
          t.renderObject<RenderParagraph>(find.text(detail)).didExceedMaxLines,
          isFalse,
          reason: detail,
        );
      }
      await t.tap(find.text('Ask me').last);
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

  // Empty means empty (anh Dee, 11-07; #4468): no words under the header.
  testWidgets('the empty pane shows nothing under its header', (t) async {
    f = TasksFixture()..rows = [];
    addTearDown(() => f.controller.dispose());
    await f.controller.refresh();
    await pumpPane(t);
    expect(find.textContaining('No tasks yet'), findsNothing);
    expect(find.byType(SkeletonBlock), findsNothing);
  });

  for (final merged in [false, true]) {
    testWidgets(
      'the task header draws the ${merged ? 'merged' : 'open'} pull request icon',
      (t) async {
        final c = taskHeaderController(merged: merged);
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
                    ..['pullRequestUrl'] = taskHeaderPr,
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
