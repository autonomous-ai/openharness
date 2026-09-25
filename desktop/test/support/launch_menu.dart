import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

bool harnessChoicesActive(WidgetTester tester) {
  final choices = find.byKey(const ValueKey('new-harness-choices'));
  return choices.evaluate().isNotEmpty &&
      tester.widget<Semantics>(choices).properties.focused == true;
}

/// Open a launch row through the same navigation keys as the visible menu.
Future<void> openLaunchRow(WidgetTester tester, String name) async {
  await focusLaunchRow(tester, name);
  if (name != 'start' && name != 'create' && name != 'machine') {
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
  }
}

/// Focus a visible field without opening its list or changing its value.
Future<void> focusLaunchRow(WidgetTester tester, String name) async {
  final target = switch (name) {
    'create' => 'start',
    'mode' => 'approvals',
    'harness' => 'agent',
    _ => name,
  };
  for (var i = 0; i < 5 && harnessChoicesActive(tester); i++) {
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
  }
  if (target == 'machine') {
    // Existing project-flow tests use this to choose the folder's machine.
    // The direct Machine row is exercised separately in the grid tests.
    await openLaunchRow(tester, 'project');
    await tester.tap(
      find.byKey(const ValueKey('new-harness-option-project:existing')),
    );
    await tester.pumpAndSettle();
    return;
  }
  final row = find.byKey(ValueKey('new-harness-field-$target'));
  if (row.evaluate().isEmpty &&
      {
        'model',
        'branch',
        'worktree',
        'approvals',
        'profile',
      }.contains(target)) {
    await openLaunchRow(tester, 'advanced');
  }
  for (var i = 0; i < 12; i++) {
    if (tester.widget<Semantics>(row).properties.selected == true) break;
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
  }
  expect(tester.widget<Semantics>(row).properties.selected, isTrue);
  await tester.pumpAndSettle();
}

/// Settings are deliberately separate from the arrow/Enter selection path.
Future<void> openAgentSetting(
  WidgetTester tester,
  String engine,
  String setting,
) async {
  await openLaunchRow(
    tester,
    setting == NewHarnessController.permissionsId ? 'approvals' : 'profile',
  );
}

/// Exercises compatibility for carried tasks and advanced drafts. Task is no
/// longer a visible launch row.
Future<void> openLegacyTaskEditor(WidgetTester tester) async {
  tester
      .widget<NewHarnessForm>(find.byType(NewHarnessForm))
      .controller
      .focusField(NewHarnessField.task);
  await tester.pump();
}

/// Edit the setup field through Flutter's text input connection.
Future<void> typeHarnessQuery(WidgetTester tester, String text) async {
  final input = find.byKey(const ValueKey('new-harness-query'));
  if (input.evaluate().isEmpty) {
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
  }
  await tester.enterText(input, text);
  await tester.pump();
}

Future<void> startHarness(WidgetTester tester) async {
  await openLaunchRow(tester, 'start');
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  await tester.pump();
}

/// Accept the open list, or explicitly navigate to the setup launch action.
/// Other screens keep their normal Return behavior.
Future<void> acceptSetupOrSearch(WidgetTester tester) async {
  if (find.byType(NewHarnessForm).evaluate().isNotEmpty &&
      !harnessChoicesActive(tester)) {
    await openLaunchRow(tester, 'start');
  }
  await tester.sendKeyEvent(LogicalKeyboardKey.enter);
  await tester.pump();
}
