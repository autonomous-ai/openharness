import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_composer.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'keymap_runtime_test.dart' show mount, native, nativeChannel;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show findField, finishFind, output;

Future<void> command(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool shift = false,
}) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
  if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyEvent(key);
  if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
}

void main() {
  for (final nativeEntry in [false, true]) {
    for (final action in [
      'pane',
      'zoomed pane',
      'waiting composer',
      'tab',
      'close pane',
      'close tab',
      'new tab',
    ]) {
      testWidgets(
        '$action owns immediate input before a frame (native=$nativeEntry)',
        (tester) async {
          final app = createApp();
          app.machineStates['m']!.nodeOnline = true;
          final keymap = MemoryKeymap();
          final firstInput = <TerminalBinaryFrame>[];
          final secondInput = <TerminalBinaryFrame>[];
          final first = app.adoptSessionForTest(terminal('a0', firstInput));
          if (action == 'waiting composer') {
            first.session!.status = TerminalSessionStatus.opening;
            app.toggleComposer(first.id);
          }
          final firstTab = app.activeSwarmId;
          final separateTabs = action == 'tab' || action == 'close tab';
          if (separateTabs) app.newSwarm();
          final second = app.adoptSessionForTest(terminal('a1', secondInput));
          final secondTab = app.activeSwarmId;
          if (nativeEntry) {
            tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
              nativeChannel,
              (_) async => null,
            );
          }
          try {
            await mount(tester, app, keymap, native: nativeEntry);
            if (action == 'zoomed pane') {
              app.toggleZoomPane();
              await tester.pump();
            }
            if (separateTabs) {
              app.selectSwarm(firstTab);
              await tester.pump();
              app.selectSwarm(secondTab);
              await tester.pump();
            }
            expect(app.focusedPane, same(second));
            final before = tester
                .stateList<TerminalViewState>(
                  find.byType(TerminalView, skipOffstage: false),
                )
                .map((state) => state.renderTerminal)
                .toList();
            final (commandId, key) = switch (action) {
              'pane' || 'zoomed pane' || 'waiting composer' => (
                'pane.focus_left',
                LogicalKeyboardKey.arrowLeft,
              ),
              'tab' => ('swarm.select_1', LogicalKeyboardKey.digit1),
              'close pane' => ('pane.close', LogicalKeyboardKey.keyW),
              'close tab' => ('swarm.close', LogicalKeyboardKey.keyW),
              _ => ('swarm.new', LogicalKeyboardKey.keyT),
            };
            if (nativeEntry) {
              await native(tester, 'keymapCommand', {'command': commandId});
            } else {
              await command(tester, key, shift: action == 'close pane');
            }
            // Both events arrive before the canvas updates its widgets.
            await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
            if (tester.testTextInput.hasAnyClients) {
              tester.testTextInput.enterText('next');
            }
            await tester.pump(const Duration(milliseconds: 10));
            expect(secondInput, isEmpty, reason: 'The old agent owns no input');
            if (action == 'new tab') {
              expect(app.panes, isEmpty);
              expect(app.swarms.first.panes, [first, second]);
              expect(app.swarms, hasLength(2));
              expect(firstInput, isEmpty);
              expect(
                tester
                    .widget<TextField>(
                      find.byKey(const ValueKey('swarm-search-input')),
                    )
                    .focusNode!
                    .hasFocus,
                isTrue,
              );
            } else if (action == 'waiting composer') {
              expect(app.focusedPane, same(first));
              expect(firstInput, isEmpty);
              await output(first.session!, 0, 'ready\r\n', keyframe: true);
              await tester.pump();
              final composer = find.descendant(
                of: find.byType(TerminalComposer),
                matching: find.byType(TextField),
              );
              expect(
                tester.widget<TextField>(composer).focusNode!.hasFocus,
                isTrue,
              );
              tester.testTextInput.enterText('Ready to continue');
              await tester.pump();
              expect(
                tester.widget<TextField>(composer).controller!.text,
                'Ready to continue',
              );
              expect(firstInput, isEmpty);
            } else {
              expect(app.focusedPane, same(first));
              expect(firstInput.expand((frame) => frame.bytes).toList(), [
                27,
                91,
                68,
                ...utf8.encode('next'),
              ]);
              expect(
                tester
                    .stateList<TerminalViewState>(
                      find.byType(TerminalView, skipOffstage: false),
                    )
                    .map((state) => state.renderTerminal),
                everyElement(isIn(before)),
                reason: 'Navigation retains existing terminal renderers',
              );
            }
          } finally {
            await tester.pumpWidget(const SizedBox());
            app.dispose();
            keymap.dispose();
            if (nativeEntry) {
              tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
                nativeChannel,
                null,
              );
            }
          }
        },
      );
    }
  }

  for (final editor in ['composer', 'Find']) {
    testWidgets(
      'returning to $editor preserves its draft and immediate input',
      (tester) async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final keymap = MemoryKeymap();
        final input = <TerminalBinaryFrame>[];
        final first = app.adoptSessionForTest(terminal('a0', input));
        app.adoptSessionForTest(terminal('a1', input));
        app.focusPane(first.id);
        if (editor == 'composer') app.toggleComposer(first.id);
        try {
          await mount(tester, app, keymap);
          if (editor == 'Find') {
            await command(tester, LogicalKeyboardKey.keyF);
            await tester.pump();
          }
          final field = editor == 'Find'
              ? findField
              : find.descendant(
                  of: find.byType(TerminalComposer),
                  matching: find.byType(TextField),
                );
          await tester.enterText(field, 'draft');
          if (editor == 'Find') await finishFind(tester);
          final controller = tester.widget<TextField>(field).controller!;
          final focus = tester.widget<TextField>(field).focusNode!;
          await command(tester, LogicalKeyboardKey.arrowRight);
          await tester.pump();
          await command(tester, LogicalKeyboardKey.arrowLeft);
          expect(focus.hasFocus, isTrue);
          expect(controller.text, 'draft');
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          expect(
            controller.selection,
            const TextSelection.collapsed(offset: 4),
          );
          const editing = TextEditingValue(
            text: 'draft 日本',
            selection: TextSelection.collapsed(offset: 8),
            composing: TextRange(start: 6, end: 8),
          );
          tester.testTextInput.updateEditingValue(editing);
          await tester.pump(const Duration(milliseconds: 10));
          expect(controller.value, editing);
          expect(focus.hasFocus, isTrue);
          expect(input, isEmpty);
        } finally {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          keymap.dispose();
        }
      },
    );
  }

  for (final change in ['destination', 'waiting composer']) {
    testWidgets('a background $change cannot take a dialog editor', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final keymap = MemoryKeymap();
      final input = <TerminalBinaryFrame>[];
      final first = app.adoptSessionForTest(terminal('a0', input));
      final secondSession = terminal('a1', input);
      final second = app.adoptSessionForTest(secondSession);
      if (change == 'waiting composer') {
        secondSession.status = TerminalSessionStatus.opening;
        app.toggleComposer(second.id);
      }
      try {
        await mount(tester, app, keymap);
        await command(tester, LogicalKeyboardKey.keyR, shift: true);
        await tester.pumpAndSettle();
        final field = tester.widget<TextField>(
          find.byKey(const Key('tab-rename-input')),
        );
        expect(field.focusNode!.hasFocus, isTrue);
        if (change == 'waiting composer') {
          await output(secondSession, 0, 'ready\r\n', keyframe: true);
          expect(secondSession.acceptsInput, isTrue);
        } else {
          app.focusPane(first.id);
        }
        await tester.idle();
        tester.testTextInput.enterText('Still editing');
        await tester.pump();
        expect(field.focusNode!.hasFocus, isTrue);
        expect(field.controller!.text, 'Still editing');
        expect(input, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        expect(
          app.focusedPane,
          same(change == 'waiting composer' ? second : first),
        );
        if (change == 'waiting composer') {
          final composer = find.descendant(
            of: find.byType(TerminalComposer),
            matching: find.byType(TextField),
          );
          expect(
            tester.widget<TextField>(composer).focusNode!.hasFocus,
            isTrue,
          );
          tester.testTextInput.enterText('Continue here');
          await tester.pumpAndSettle();
          expect(
            tester.widget<TextField>(composer).controller!.text,
            'Continue here',
          );
          expect(input, isEmpty);
        } else {
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          await tester.pump(const Duration(milliseconds: 10));
          expect(input.single.streamId, first.session!.streamId);
          await tester.pumpAndSettle();
        }
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        keymap.dispose();
      }
    });
  }
}
