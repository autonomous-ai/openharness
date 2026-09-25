import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'support/launch_menu.dart';
import 'support/mixed_agents.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _CancelFolder extends FileSelectorPlatform {
  final answer = Completer<String?>();
  int opened = 0;
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) {
    opened++;
    return answer.future;
  }
}

void main() {
  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);
  NewHarnessController box(WidgetTester tester) =>
      tester.widget<NewHarnessForm>(find.byType(NewHarnessForm)).controller;

  testWidgets(
    'edited defaults and a carried task survive closing and reopening',
    (tester) async {
      final app = createApp();
      seedMixedAgents(app);
      app.adoptSessionForTest(terminal('a0', []));
      addTearDown(app.dispose);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await openLaunchRow(tester, 'agent');
      await typeHarnessQuery(tester, 'OpenCode');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      box(tester).task = 'Review this project';
      box(tester).setFolder('/work/selected-before-task');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.keyN);
      expect(box(tester).task, 'Review this project');
      expect(box(tester).engine, 'opencode');
      expect(box(tester).project.folder, '/work/selected-before-task');
      expect(app.panes, hasLength(1));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('cancelled native browsing returns the keys to the setup list', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    app.adoptSessionForTest(terminal('a0', []));
    addTearDown(app.dispose);
    final previous = FileSelectorPlatform.instance;
    final picker = _CancelFolder();
    FileSelectorPlatform.instance = picker;
    addTearDown(() => FileSelectorPlatform.instance = previous);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    await openLaunchRow(tester, 'project');
    final controller = box(tester);
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.existingProjectId,
          ) -
          controller.cursor,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.browseId,
          ) -
          controller.cursor,
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    FocusManager.instance.primaryFocus?.unfocus();
    picker.answer.complete(null);
    await tester.pumpAndSettle();
    expect(FocusManager.instance.primaryFocus?.debugLabel, 'new-harness-query');
    await typeHarnessQuery(tester, 'robotics');
    expect(controller.query, 'robotics');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  // The box keeps its keyboard focus while the sheet is up, so Enter on the
  // Browse… row arrives again. AppKit answers a second `beginSheetModal` by
  // queueing it behind the first: the screen does not change, and the person
  // is left pressing a key that looks like it does nothing.
  testWidgets('a second Browse… while the chooser is up opens nothing', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    app.adoptSessionForTest(terminal('a0', []));
    addTearDown(app.dispose);
    final previous = FileSelectorPlatform.instance;
    final picker = _CancelFolder();
    FileSelectorPlatform.instance = picker;
    addTearDown(() => FileSelectorPlatform.instance = previous);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    await openLaunchRow(tester, 'project');
    final controller = box(tester);
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.existingProjectId,
          ) -
          controller.cursor,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.browseId,
          ) -
          controller.cursor,
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(picker.opened, 1);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(picker.opened, 1, reason: 'one chooser, however often it is asked');
    picker.answer.complete('/work/picked');
    await tester.pumpAndSettle();
    expect(controller.project.folder, '/work/picked');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  // A remote machine has no AppKit sheet to fall back on: the chooser is a
  // DIALOG ROUTE, and the box is an overlay entry the screen inserted itself,
  // so the route lands underneath it. It used to look like Browse… did nothing
  // until the box was dismissed, and the chooser was waiting behind it.
  testWidgets('the remote folder browser opens in front of the box', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = false;
    app.gitProjectReaderForTest = (_, _) async => {'isGit': false};
    app.adoptSessionForTest(terminal('a0', []));
    addTearDown(app.dispose);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    await openLaunchRow(tester, 'project');
    final controller = box(tester);
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.existingProjectId,
          ) -
          controller.cursor,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    controller.move(
      controller.options.indexWhere(
            (row) => row.id == NewHarnessController.browseId,
          ) -
          controller.cursor,
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    await tester.pump();
    expect(find.text('Choose a folder'), findsOneWidget);
    expect(
      find.byType(NewHarnessForm),
      findsNothing,
      reason: 'the box steps aside while the chooser is up',
    );
    expect(
      find.byType(NewHarnessForm, skipOffstage: false),
      findsOneWidget,
      reason: 'hidden, not rebuilt: the draft and the focused row survive',
    );
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    await tester.pump();
    expect(find.byType(NewHarnessForm), findsOneWidget);
    expect(identical(box(tester), controller), isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('different source panes retain separate setup drafts', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    final first = app.adoptSessionForTest(terminal('a0', []));
    await app.addAgentToSwarm('m', 'a1');
    addTearDown(app.dispose);
    await mount(tester, app);
    app.focusPane(first.id);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyN);
    box(tester).setFolder('/work/first-draft');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    final other = app.panes.firstWhere((pane) => pane.agentId == 'a1');
    app.focusPane(other.id);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyN);
    expect(box(tester).project.folder, isNot('/work/first-draft'));
    box(tester).setFolder('/work/second-draft');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    app.focusPane(first.id);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyN);
    expect(box(tester).project.folder, '/work/first-draft');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
