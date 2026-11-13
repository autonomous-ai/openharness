import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/shortcuts/text_editing_keys.dart';
import 'package:harness/widgets/terminal_composer.dart';

import 'keymap_host_test.dart'
    show MemoryKeymap, key, liveComposerSession, terminalKeymapHost;

/// ⌘← is "focus the pane to the left" and ⇧⌘← "move this pane", but with the
/// caret in a text field they are the line start and a selection to it. The
/// window's keymap runs before the field, so each editing key has to be given
/// back to it.
/// Offsets only: a move may leave the caret's affinity upstream or downstream.
Matcher caret(int offset) => isA<TextSelection>()
    .having((s) => s.isCollapsed, 'collapsed', true)
    .having((s) => s.baseOffset, 'offset', offset);
Matcher range(int base, int extent) => isA<TextSelection>()
    .having((s) => s.baseOffset, 'base', base)
    .having((s) => s.extentOffset, 'extent', extent);

void main() {
  const text = 'hello world there';
  final mac = TargetPlatformVariant.only(TargetPlatform.macOS);

  group('which strokes a text field keeps', () {
    KeyStroke s(String source) => KeyStroke.parse(source);
    bool keeps(String stroke, TargetPlatform platform, {bool hasText = true}) =>
        textFieldKeepsStroke(s(stroke), platform: platform, hasText: hasText);

    test('macOS word, line and text moves, with and without Shift', () {
      for (final stroke in [
        'alt+left',
        'alt+right',
        'alt+shift+left',
        'alt+shift+right',
        'cmd+left',
        'cmd+right',
        'cmd+up',
        'cmd+down',
        'cmd+shift+left',
        'cmd+shift+right',
        'cmd+shift+up',
        'cmd+shift+down',
        'alt+backspace',
        'cmd+backspace',
        'ctrl+a',
        'ctrl+e',
      ]) {
        expect(keeps(stroke, TargetPlatform.macOS), isTrue, reason: stroke);
      }
    });

    test('macOS pane and tab keys are never kept', () {
      for (final stroke in [
        'cmd+h',
        'cmd+j',
        'cmd+k',
        'cmd+l',
        'cmd+alt+left',
        'cmd+alt+right',
        'cmd+t',
        'cmd+shift+backspace',
        'ctrl+shift+a',
        'ctrl+w',
      ]) {
        expect(keeps(stroke, TargetPlatform.macOS), isFalse, reason: stroke);
      }
    });

    test('the ⌘-arrows are kept only when the box has text', () {
      for (final stroke in ['cmd+left', 'cmd+shift+down']) {
        expect(
          keeps(stroke, TargetPlatform.macOS, hasText: false),
          isFalse,
          reason: stroke,
        );
      }
      expect(keeps('alt+left', TargetPlatform.macOS, hasText: false), isTrue);
    });

    test('Ctrl+K kills the line on macOS only, and only unmodified', () {
      expect(
        textFieldKillsLine(s('ctrl+k'), platform: TargetPlatform.macOS),
        isTrue,
      );
      for (final stroke in ['cmd+k', 'ctrl+shift+k', 'ctrl+alt+k', 'k']) {
        expect(
          textFieldKillsLine(s(stroke), platform: TargetPlatform.macOS),
          isFalse,
          reason: stroke,
        );
      }
      expect(
        textFieldKillsLine(s('ctrl+k'), platform: TargetPlatform.windows),
        isFalse,
      );
    });

    test('Windows and Linux word moves, Home/End and word deletes', () {
      for (final platform in [TargetPlatform.windows, TargetPlatform.linux]) {
        for (final stroke in [
          'ctrl+left',
          'ctrl+right',
          'ctrl+shift+left',
          'home',
          'end',
          'ctrl+home',
          'ctrl+shift+end',
          'shift+home',
          'ctrl+backspace',
          'ctrl+delete',
        ]) {
          expect(keeps(stroke, platform), isTrue, reason: '$platform $stroke');
        }
        // Alt+arrows are Windows Terminal's pane keys; they stay with the app.
        for (final stroke in ['alt+left', 'alt+shift+right', 'ctrl+t']) {
          expect(keeps(stroke, platform), isFalse, reason: '$platform $stroke');
        }
      }
    });
  });

  group('the terminal composer', () {
    testWidgets('macOS editing keys reach the line', (tester) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      final session = await liveComposerSession();
      final ran = <String>[];
      await tester.pumpWidget(
        terminalKeymapHost(map, {
          'pane.focus_left': () => ran.add('focus_left'),
          'pane.move_left': () => ran.add('move_left'),
        }, TerminalComposer(session: session, focusNode: focus)),
      );
      focus.requestFocus();
      await tester.pump();
      await tester.enterText(find.byType(TextField), text);
      final field = tester
          .widget<TextField>(find.byType(TextField))
          .controller!;
      field.selection = const TextSelection.collapsed(offset: text.length);
      await tester.pump();

      await key(tester, LogicalKeyboardKey.arrowLeft, alt: true);
      expect(field.selection, caret(12));
      await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
      expect(field.selection, caret(0));
      await key(tester, LogicalKeyboardKey.arrowRight, cmd: true, shift: true);
      expect(field.selection, range(0, text.length));
      await key(tester, LogicalKeyboardKey.arrowRight, cmd: true);
      await key(tester, LogicalKeyboardKey.backspace, alt: true);
      expect(field.text, 'hello world ');
      await key(tester, LogicalKeyboardKey.keyA, ctrl: true);
      expect(field.selection, caret(0));
      field.selection = const TextSelection.collapsed(offset: 5);
      await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
      expect(field.text, 'hello');
      expect(ran, isEmpty);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      focus.dispose();
      map.dispose();
    }, variant: mac);

    testWidgets('⌘← focuses the pane when the composer is empty', (
      tester,
    ) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      final session = await liveComposerSession();
      final ran = <String>[];
      await tester.pumpWidget(
        terminalKeymapHost(map, {
          'pane.focus_left': () => ran.add('focus_left'),
        }, TerminalComposer(session: session, focusNode: focus)),
      );
      focus.requestFocus();
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
      expect(ran, ['focus_left']);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      focus.dispose();
      map.dispose();
    }, variant: mac);
  });

  group('where the field does not own the keys', () {
    Future<(MemoryKeymap, List<String>)> host(
      WidgetTester tester,
      Widget field, {
      String? bindings,
      KeymapContext? region,
      Map<String, VoidCallback>? local,
    }) async {
      final map = MemoryKeymap();
      if (bindings != null) map.apply(bindings);
      final ran = <String>[];
      Widget child = Material(child: field);
      if (region != null) {
        child = KeymapRegion(contextKind: region, actions: local, child: child);
      }
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: KeymapHost(
              keymap: map,
              enabled: () => true,
              actions: {
                'pane.focus_left': () => ran.add('pane.focus_left'),
                'pane.zoom': () => ran.add('pane.zoom'),
              },
              child: child,
            ),
          ),
        ),
      );
      await tester.pump();
      addTearDown(map.dispose);
      return (map, ran);
    }

    testWidgets('read-only text keeps the pane keys', (tester) async {
      // Selectable text is a read-only field: it has no caret to move, so ⌘←
      // is still "focus the pane to the left" and Ctrl+K is still the app's.
      final (_, ran) = await host(
        tester,
        const SelectableText(text, autofocus: true),
        bindings: '{"bindings":[{"keys":"ctrl+k","command":"pane.zoom"}]}',
      );
      await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
      await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
      expect(ran, ['pane.focus_left', 'pane.zoom']);
    }, variant: mac);

    testWidgets('Ctrl+K does not cut into text being composed', (tester) async {
      final controller = TextEditingController.fromValue(
        const TextEditingValue(
          text: 'hello world',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        ),
      );
      addTearDown(controller.dispose);
      await host(tester, TextField(controller: controller, autofocus: true));
      await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
      expect(controller.text, 'hello world');
    }, variant: mac);

    for (final kind in [KeymapContext.picker, KeymapContext.project]) {
      testWidgets('a ${kind.name} search field keeps Ctrl+K as "previous"', (
        tester,
      ) async {
        final controller = TextEditingController(text: 'draft');
        addTearDown(controller.dispose);
        var previous = 0;
        await host(
          tester,
          TextField(controller: controller, autofocus: true),
          region: kind,
          local: {'picker.previous': () => previous++},
        );
        await key(tester, LogicalKeyboardKey.keyK, ctrl: true);
        expect(previous, 1);
        expect(controller.text, 'draft');
      }, variant: mac);
    }

    testWidgets('a chord under way finishes on an editing key', (tester) async {
      final controller = TextEditingController(text: text);
      addTearDown(controller.dispose);
      final (_, ran) = await host(
        tester,
        TextField(controller: controller, autofocus: true),
        bindings: '{"bindings":[{"keys":"cmd+alt+shift+y alt+left","command":"pane.zoom"}]}',
      );
      controller.selection = const TextSelection.collapsed(offset: 17);
      await key(
        tester,
        LogicalKeyboardKey.keyY,
        cmd: true,
        alt: true,
        shift: true,
      );
      await key(tester, LogicalKeyboardKey.arrowLeft, alt: true);
      expect(ran, ['pane.zoom']);
      expect(controller.selection, caret(17), reason: 'the caret stayed');
    }, variant: mac);
  });

  testWidgets('pane and tab keys work with focus outside a text field', (
    tester,
  ) async {
    final map = MemoryKeymap();
    final ran = <String>[];
    final focus = FocusNode();
    await tester.pumpWidget(
      MaterialApp(
        home: KeymapProvider(
          keymap: map,
          child: KeymapHost(
            keymap: map,
            enabled: () => true,
            actions: {
              for (final id in [
                'pane.focus_left',
                'pane.move_left',
                'pane.focus_above',
                'swarm.next',
                'swarm.previous',
              ])
                id: () => ran.add(id),
            },
            child: Material(
              child: TextButton(
                focusNode: focus,
                autofocus: true,
                onPressed: () {},
                child: const Text('A pane'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
    await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true, shift: true);
    await key(tester, LogicalKeyboardKey.keyK, cmd: true);
    await key(tester, LogicalKeyboardKey.arrowRight, cmd: true, alt: true);
    await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true, alt: true);
    expect(ran, [
      'pane.focus_left',
      'pane.move_left',
      'pane.focus_above',
      'swarm.next',
      'swarm.previous',
    ]);
  }, variant: mac);
}
