import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture, inCard;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';

/// Activity (anh Dee, 11-07, task #4689), clicked through as a person uses it: Everyone's tasks with what waits on
/// them pinned on top, Mine, Accept on a pinned card, and a card opening its task.
void main() {
  final shots = Platform.environment['HARNESS_V3_TASKS_SHOTS'];
  setUpAll(() async {
    superTabLoadZones();
    await loadCaptureFonts(shots);
  });

  Map<String, dynamic> working(String id, int at) =>
      task(id, 1, at)..addAll({'status': 'working', 'canApprove': false});

  testWidgets('switch Everyone and Mine, Accept a pinned card, open a card', (
    t,
  ) async {
    final opened = <String>[];
    // Mine: a task of the reader's agent, and two waiting on their Accept. Everyone: those, and a teammate's.
    final f = TasksFixture()
      ..rows = [task('waits-old', 1, 10), task('waits-new', 1, 30), working('mine', 20)]
      ..everyone = [
        task('waits-old', 1, 10),
        task('waits-new', 1, 30),
        working('mine', 20),
        working('teammate', 40),
      ];
    addTearDown(f.controller.dispose);
    await f.controller.refresh();
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
    List<String> order() {
      final cards = find.byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith('personal-task-') &&
            // The card's project capsule.
            (w.key! as ValueKey<String>).value != 'personal-task-tag',
      );
      final keys = [
        for (final e in cards.evaluate())
          ((e.widget.key! as ValueKey<String>).value.substring(14), t.getTopLeft(find.byWidget(e.widget)).dy),
      ]..sort((a, b) => a.$2.compareTo(b.$2));
      return [for (final k in keys) k.$1];
    }

    expect(find.text('Activity'), findsOneWidget);
    // Waiting first, oldest first, with no heading; then the rest, newest activity first.
    expect(order(), ['waits-old', 'waits-new', 'teammate', 'mine']);

    // Mine: the person icon, and the teammate's task leaves.
    final scope = find.byKey(const ValueKey('tasks-scope'));
    expect(find.descendant(of: scope, matching: find.byIcon(AppIcons.users)), findsOneWidget);
    await t.tap(scope);
    await t.pumpAndSettle();
    expect(t.widget<AppMenuItem>(find.widgetWithText(AppMenuItem, 'Everyone')).selected, isTrue);
    await t.tap(find.text('Mine'));
    await t.pumpAndSettle();
    expect(find.descendant(of: scope, matching: find.byIcon(AppIcons.user)), findsOneWidget);
    expect(order(), ['waits-old', 'waits-new', 'mine']);
    await t.tap(scope);
    await t.pumpAndSettle();
    expect(t.widget<AppMenuItem>(find.widgetWithText(AppMenuItem, 'Mine')).selected, isTrue);
    await t.tap(find.text('Everyone'));
    await t.pumpAndSettle();
    expect(order(), ['waits-old', 'waits-new', 'teammate', 'mine']);

    // Accept the card waiting longest: it starts, and leaves the top for its place by activity.
    await t.tap(inCard('waits-old', find.text('Accept')));
    await t.pumpAndSettle();
    expect(f.commands.single, {
      'type': 'task.approve',
      'conversationId': 'waits-old',
      'suggestedAgentId': '0540',
    });
    await f.controller.refresh();
    await t.pumpAndSettle();
    expect(order(), ['waits-new', 'teammate', 'mine', 'waits-old']);

    // A click on a card opens its task's chat.
    await t.tap(inCard('teammate', find.text('Task teammate')));
    await t.pump();
    expect(opened, ['teammate']);
  });

  testWidgets('a backend without Everyone lists the reader\'s tasks in both', (
    t,
  ) async {
    final f = TasksFixture()..rows = [working('mine', 20)];
    addTearDown(f.controller.dispose);
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
    expect(find.text('Task mine'), findsOneWidget);
  });

  // The approved mockups' pane, at rest and with each menu open, light and dark: written only with
  // HARNESS_V3_TASKS_SHOTS set.
  for (final brightness in Brightness.values) {
    testWidgets('Activity as the mockups draw it, in ${brightness.name}', (t) async {
      Map<String, dynamic> row(String id, int at, String project, String title, String status) => {
        ...task(id, 1, at),
        'projectId': 'p-$project',
        'projectName': project,
        'title': title,
        'status': status,
        'canApprove': status == 'proposal',
        'suggested': false,
      };
      final f = TasksFixture()
        ..rows = [row('mockups', 5, 'harness', 'Build to the approved mockups', 'proposal')]
        ..everyone = [
          row('mockups', 5, 'harness', 'Build to the approved mockups', 'proposal'),
          row('voice', 70, 'lamp', 'Fix the voice timeout on wake', 'done'),
          row('projects', 60, 'harness', 'Projects page: a list like GitHub', 'working'),
          row('wall', 50, 'pod', 'Left wall drawing for the factory', 'needs_human'),
          row('picker', 40, 'computer', 'Tidy the machine picker', 'working'),
          row('emails', 30, 'harness-gtm', 'First 10 retailer emails', 'stuck'),
          row('camera', 20, 'scout', 'Second camera angle', 'done'),
        ];
      addTearDown(f.controller.dispose);
      await f.controller.refresh();
      t.view.physicalSize = const Size(400, 900);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await t.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabPersonalTasksPane(controller: f.controller, onOpenTask: (_) {}),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'activity-${brightness.name}');
      for (final key in ['tasks-scope', 'tasks-approval-mode']) {
        await t.tap(find.byKey(ValueKey(key)));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        await captureWindow(t, shots, 'activity-$key-${brightness.name}');
        await t.tapAt(const Offset(200, 880));
        await t.pumpAndSettle();
      }
    });
  }
}
