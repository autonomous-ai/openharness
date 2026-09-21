import 'support/launch_menu.dart';

import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/new_harness_box.dart';

import 'support/mixed_agents.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _CancelFolder extends FileSelectorPlatform {
  final answer = Completer<String?>();
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) => answer.future;
}

/// The box, driven through the whole screen the way a person drives it: the
/// flows where work could be lost or a key could quietly do nothing.
void main() {
  final line = find.byKey(const ValueKey('new-harness-input'));
  final box = find.byKey(const ValueKey('new-harness-box'));

  setUp(() => newHarnessOpensInBox = true);
  tearDown(() => newHarnessOpensInBox = false);

  Future<void> open(WidgetTester tester) async {
    final app = createApp();
    seedMixedAgents(app);
    app.adoptSessionForTest(terminal('a0', []));
    await app.addAgentToSwarm('m', 'a0');
    addTearDown(app.dispose);
    await mount(tester, app);
  }

  NewHarnessController creation(WidgetTester tester) =>
      tester.widget<NewHarnessBox>(find.byType(NewHarnessBox)).controller;

  Future<void> editTask(WidgetTester tester) async {
    creation(tester).focusField(NewHarnessField.task);
    await tester.pump();
  }

  Future<void> close(WidgetTester tester) async {
    for (var i = 0; box.evaluate().isNotEmpty && i < 4; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    }
    expect(box, findsNothing);
  }

  testWidgets('edited defaults survive Escape before a task is typed', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    app.adoptSessionForTest(terminal('a0', []));
    addTearDown(app.dispose);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    final creation = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    creation.focusField(NewHarnessField.agent);
    await tester.pump();
    await tester.enterText(line, 'OpenCode');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    creation.setFolder('/work/selected-before-task');
    await tester.pump();
    expect(creation.task, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await chord(tester, LogicalKeyboardKey.keyN);
    final restored = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    expect(restored.task, isEmpty);
    expect(restored.engine, 'opencode');
    expect(restored.project.folder, '/work/selected-before-task');
    expect(restored.field, NewHarnessField.launch);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('cancelling a folder browser returns to project input', (
    tester,
  ) async {
    final app = createApp();
    seedMixedAgents(app);
    app.machineStates['m']!.localOnly = true;
    app.adoptSessionForTest(terminal('a0', []));
    addTearDown(app.dispose);
    final previous = FileSelectorPlatform.instance;
    final picker = _CancelFolder();
    FileSelectorPlatform.instance = picker;
    addTearDown(() => FileSelectorPlatform.instance = previous);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    final creation = tester
        .widget<NewHarnessBox>(find.byType(NewHarnessBox))
        .controller;
    creation.focusField(NewHarnessField.project);
    creation.move(
      creation.options.indexWhere(
            (row) => row.id == NewHarnessController.browseId,
          ) -
          creation.cursor,
    );
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();
    picker.answer.complete(null);
    await tester.pumpAndSettle();
    expect(creation.field, NewHarnessField.project);
    expect(tester.widget<TextField>(line).focusNode!.hasFocus, isTrue);
    await tester.enterText(line, 'payments processing');
    await tester.pump();
    expect(creation.query, 'payments processing');
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Escape keeps what was typed for the next ⌘N', (tester) async {
    await open(tester);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    await editTask(tester);
    await tester.enterText(line, 'fix the flaky login test');
    await tester.pump();
    await close(tester);
    // Up to two thousand characters, and Escape is the most-pressed key here.
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    expect(creation(tester).task, 'fix the flaky login test');
    await editTask(tester);
    expect(
      tester.widget<TextField>(line).controller!.text,
      'fix the flaky login test',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the arrows move the caret in a task of several lines', (
    tester,
  ) async {
    await open(tester);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    await editTask(tester);
    await tester.enterText(line, 'first line\nsecond line');
    await tester.pump();
    final field = tester.widget<TextField>(line);
    expect(field.maxLines, greaterThan(1));
    field.controller!.selection = const TextSelection.collapsed(offset: 22);
    await tester.pump();
    // Matched keys are consumed by the keymap whether or not anything handles
    // them, so on the task the arrows have to be handed to the text field.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
    await tester.pump();
    expect(field.controller!.selection.baseOffset, lessThan(11));
    // Still the task, and nothing was made.
    expect(box, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('⌥↵ breaks the line in the task; it does not make the harness', (
    tester,
  ) async {
    await open(tester);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump();
    await editTask(tester);
    await tester.enterText(line, 'one');
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump();
    expect(tester.widget<TextField>(line).controller!.text, 'one\n');
    expect(box, findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('⌘N from the empty workspace picker keeps what was typed there', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    addTearDown(app.dispose);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyT);
    final start = find.byKey(const ValueKey('swarm-search-input'));
    await tester.tap(start);
    await tester.pump();
    await tester.enterText(start, 'write the docs');
    await tester.pump();
    // ⌘N used to throw this away; only the create row kept it. (The page's
    // own New Harness button is hidden while its results are showing.)
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pump(const Duration(milliseconds: 200));
    expect(box, findsOneWidget);
    expect(creation(tester).task, 'write the docs');
    expect(creation(tester).field, NewHarnessField.launch);
    expect(creation(tester).project.generated, isNotNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Tab completes an agent and Enter accepts it', (tester) async {
    await open(tester);
    await chord(tester, LogicalKeyboardKey.keyN);
    final controller = creation(tester);
    final previous = controller.engine;
    await openLaunchRow(tester, 'agent');
    await tester.pump();
    await tester.enterText(line, 'open');
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(controller.query, 'OpenCode');
    expect(controller.engine, previous);
    expect(controller.field, NewHarnessField.agent);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(controller.field, NewHarnessField.launch);
    expect(controller.engine, 'opencode');
    await close(tester);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a draft comes back once, not under every later ⌘N', (
    tester,
  ) async {
    await open(tester);
    Future<String> reopen() async {
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      await editTask(tester);
      return tester.widget<TextField>(line).controller!.text;
    }

    expect(await reopen(), isEmpty);
    await tester.enterText(line, 'for the auth project');
    await tester.pump();
    await close(tester);
    expect(await reopen(), 'for the auth project');
    // Cleared by hand and dismissed: it is gone, not resurrected.
    await tester.enterText(line, '');
    await tester.pump();
    await close(tester);
    expect(await reopen(), isEmpty);
    await close(tester);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'drafts stay with their source project and retain edited defaults',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      seedMixedAgents(app);
      final auth = app.adoptSessionForTest(terminal('a0', []));
      final docs = app.adoptSessionForTest(terminal('a2', []));
      app.focusPane(auth.id);
      await mount(tester, app);

      Future<NewHarnessController> resume() async {
        await chord(tester, LogicalKeyboardKey.keyN);
        await editTask(tester);
        return tester
            .widget<NewHarnessBox>(find.byType(NewHarnessBox))
            .controller;
      }

      Future<void> cancel() async {
        await close(tester);
      }

      var creation = await resume();
      await tester.enterText(
        line,
        '  Investigate the redirect\nDo not change code  ',
      );
      await tester.pump();
      creation.focusField(NewHarnessField.mode);
      creation.accept(
        const NewHarnessOption(id: 'readOnly', title: 'Read only'),
      );
      creation.focusField(NewHarnessField.machine);
      creation.accept(
        const NewHarnessOption(id: 'studio', title: 'iMac · Office'),
      );
      creation.setFolder('/work/isolated-auth');
      creation.focusField(NewHarnessField.task);
      await tester.pump();
      await cancel();

      // Starting in another project must never put the auth task one Return
      // away from running there. That project keeps its own in-progress task.
      app.focusPane(docs.id);
      creation = await resume();
      expect(creation.task, isEmpty);
      expect(creation.machineId, 'm');
      expect(creation.project.folder, '/work/release-notes');
      await tester.enterText(line, 'Explain the release notes');
      await tester.pump();
      await cancel();

      app.focusPane(auth.id);
      creation = await resume();
      expect(creation.task, '  Investigate the redirect\nDo not change code  ');
      expect(creation.engine, 'codex');
      expect(creation.machineId, 'studio');
      expect(creation.project.folder, '/work/isolated-auth');
      expect(creation.mode, 'readOnly');
      await cancel();

      app.focusPane(docs.id);
      creation = await resume();
      expect(creation.task, 'Explain the release notes');
      expect(creation.machineId, 'm');
      expect(creation.project.folder, '/work/release-notes');
      await cancel();
      await tester.pump(const Duration(milliseconds: 60));
      await tester.pumpWidget(const SizedBox());
    },
  );

  for (final otherMachine in [false, true]) {
    testWidgets(
      'same-project drafts are isolated across ${otherMachine ? 'machines' : 'agents'}',
      (tester) async {
        final app = createApp();
        addTearDown(app.dispose);
        seedMixedAgents(app);
        final sourceAgent = app.machineStates['m']!.agents.first;
        final machineId = otherMachine ? 'studio' : 'm';
        final agentId = otherMachine ? sourceAgent.id : 'a1';
        app.machineStates[machineId]!.agents = [
          if (!otherMachine) sourceAgent,
          Agent(
            id: agentId,
            name: 'Another feature',
            engine: sourceAgent.engine,
            terminalAvailable: true,
            project: sourceAgent.project,
          ),
        ];
        final source = app.adoptSessionForTest(terminal(sourceAgent.id, []));
        final other = app.adoptSessionForTest(
          TerminalSession(
              machineId: machineId,
              agentId: agentId,
              agentName: 'Another feature',
              engineId: 'codex',
              send: (_, _) async => true,
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'other-feature',
        );
        app.focusPane(source.id);
        await mount(tester, app);
        Future<NewHarnessController> resume() async {
          await chord(tester, LogicalKeyboardKey.keyN);
          await editTask(tester);
          return tester
              .widget<NewHarnessBox>(find.byType(NewHarnessBox))
              .controller;
        }

        Future<void> cancel() async {
          await close(tester);
        }

        var creation = await resume();
        await tester.enterText(line, 'Inspect authentication');
        await tester.pump();
        creation.focusField(NewHarnessField.mode);
        creation.accept(
          const NewHarnessOption(id: 'readOnly', title: 'Read only'),
        );
        await cancel();
        app.focusPane(other.id);
        creation = await resume();
        expect(creation.task, isEmpty);
        expect(creation.machineId, machineId);
        await tester.enterText(line, 'Update feature documentation');
        await tester.pump();
        await cancel();

        app.focusPane(source.id);
        creation = await resume();
        expect(creation.task, 'Inspect authentication');
        expect(creation.mode, 'readOnly');
        await cancel();
        // Explicit text in search starts the requested task using the source's
        // defaults, without touching another context's draft.
        await chord(tester, LogicalKeyboardKey.keyT);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          'Implement a new redirect',
        );
        await tester.pump();
        creation = await resume();
        expect(creation.task, 'Implement a new redirect');
        expect(creation.mode, 'auto');
        expect(creation.machineId, 'm');
        expect(creation.project.folder, sourceAgent.project!.cwd);
        await cancel();
        app.focusPane(other.id);
        expect((await resume()).task, 'Update feature documentation');
        await cancel();
        await tester.pump(const Duration(milliseconds: 60));
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
    'a list field chooses with Return and comes back to the launch menu',
    (tester) async {
      await open(tester);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      await openLaunchRow(tester, 'agent');
      await tester.pump();
      // The key guide keeps the same action while filtering choices.
      expect(find.textContaining('choose', findRichText: true), findsOneWidget);
      await tester.enterText(line, 'open');
      await tester.pump();
      expect(find.textContaining('choose', findRichText: true), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(box, findsOneWidget);
      expect(creation(tester).field, NewHarnessField.launch);
      expect(find.text('OpenCode'), findsWidgets);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
    },
  );
}
