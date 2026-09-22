import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_box.dart';

/// Open a launch row through the same navigation keys as the visible menu.
Future<void> openLaunchRow(WidgetTester tester, String name) async {
  final box = tester
      .widget<NewHarnessBox>(find.byType(NewHarnessBox))
      .controller;
  expect(box.field, NewHarnessField.launch);
  final index = [
    'agent',
    'machine',
    'project',
    if (box.isGitProject) 'branch',
    if (box.canUseWorktree || box.gitError != null) 'worktree',
  ].indexOf(name);
  expect(index, greaterThanOrEqualTo(0));
  await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
  await tester.pump();
  for (var i = 0; i < index; i++) {
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
  }
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  await tester.pump();
}

/// Settings are deliberately separate from the arrow/Enter selection path.
Future<void> openAgentSetting(
  WidgetTester tester,
  String engine,
  String setting,
) async {
  final row = find.byKey(ValueKey(engine));
  await tester.ensureVisible(row);
  final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await mouse.addPointer(location: tester.getCenter(row));
  await mouse.moveTo(tester.getCenter(row));
  await tester.pump();
  await tester.tap(find.byKey(ValueKey('new-harness-settings-$engine')));
  await tester.pump();
  await tester.tap(
    find
        .ancestor(
          of: find.byKey(ValueKey(setting)),
          matching: find.byType(InkWell),
        )
        .first,
  );
  await tester.pump();
  await mouse.removePointer();
}

/// Exercises compatibility for carried tasks and advanced drafts. Task is no
/// longer a visible launch row.
Future<void> openLegacyTaskEditor(WidgetTester tester) async {
  tester
      .widget<NewHarnessBox>(find.byType(NewHarnessBox))
      .controller
      .focusField(NewHarnessField.task);
  await tester.pump();
}
