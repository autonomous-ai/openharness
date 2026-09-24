import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/shortcuts/keymap_keyboard.dart';

class MemoryKeymap extends AppKeymap {
  ResolvedKeymap map = harnessDefaultKeymap;
  @override
  ResolvedKeymap get current => map;
  void apply(String source) {
    map = ResolvedKeymap(
      harnessDefaultBindings,
      KeymapConfig.parse(source, commands: harnessCommandById.keys.toSet()),
    );
    version++;
    notifyListeners();
  }
}

Future<void> key(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool cmd = false,
  bool ctrl = false,
  bool alt = false,
  bool shift = false,
}) async {
  final mods = [
    if (cmd) LogicalKeyboardKey.metaLeft,
    if (ctrl) LogicalKeyboardKey.controlLeft,
    if (alt) LogicalKeyboardKey.altLeft,
    if (shift) LogicalKeyboardKey.shiftLeft,
  ];
  for (final modifier in mods) {
    await tester.sendKeyDownEvent(modifier);
  }
  await tester.sendKeyEvent(key);
  for (final modifier in mods.reversed) {
    await tester.sendKeyUpEvent(modifier);
  }
  await tester.pump();
}

void main() {
  test('the command catalog retains the current direct workspace keys', () {
    String? command(
      String keys, [
      KeymapContext context = KeymapContext.terminal,
    ]) => harnessDefaultKeymap
        .match(context, keys.split(' ').map(KeyStroke.parse))
        .command;
    for (final (keys, expected) in [
      ('cmd+1', 'swarm.select_1'),
      ('cmd+9', 'swarm.select_9'),
      ('cmd+t', 'swarm.new'),
      ('cmd+n', 'agent.new'),
      ('cmd+o', 'agent.open'),
      ('cmd+r', 'pane.split_right'),
      ('cmd+d', 'pane.split_down'),
      ('cmd+shift+n', 'agent.clone'),
      ('cmd+shift+e', 'agent.restart'),
      ('cmd+h', 'pane.focus_left'),
      ('cmd+j', 'pane.focus_below'),
      ('cmd+k', 'pane.focus_above'),
      ('cmd+l', 'pane.focus_right'),
      ('cmd+down', 'pane.focus_below'),
      ('cmd+up', 'pane.focus_above'),
      ('cmd+right', 'pane.focus_right'),
      ('cmd+left', 'pane.focus_left'),
      ('cmd+enter', 'pane.zoom'),
      ('cmd+p', 'navigation.commands'),
      ('cmd+shift+j', 'navigation.command_bar'),
      ('cmd+s', 'app.store'),
      ('cmd+m', 'machines.list'),
      ('cmd+i', 'models.list'),
      ('cmd+shift+l', 'pane.layout'),
      ('cmd+b', 'task.route'),
      ('cmd+shift+w', 'pane.close'),
      ('cmd+w', 'swarm.close'),
      ('ctrl+tab', 'swarm.next'),
    ]) {
      expect(command(keys), expected, reason: keys);
    }
    // Parity with the table that handles real workspace input, including all
    // alternate directions and tab/history keys.
    for (final shortcut in appShortcuts()) {
      final stroke = keyStrokeFor(
        shortcut.activator.trigger,
        command: shortcut.activator.meta,
        control: shortcut.activator.control,
        alt: shortcut.activator.alt,
        shift: shortcut.activator.shift,
      )!;
      final id = command(stroke.toString());
      expect(harnessCommandById[id]?.action, shortcut.action);
    }
    for (final retired in ['cmd+shift+h', 'cmd+shift+k', 'cmd+u']) {
      expect(command(retired), isNull, reason: retired);
    }
    expect(command('cmd+alt+left'), isNull);
    expect(command('cmd+shift+enter'), isNull);
    expect(command('ctrl+n', KeymapContext.picker), 'picker.next');
    expect(command('cmd+t', KeymapContext.picker), 'swarm.new');
    expect(command('cmd+['), 'navigation.back');
  });

  test(
    'Mac native editing and window conflicts are rejected before activation',
    () {
      for (final keys in [
        'cmd+q',
        'cmd+c',
        'cmd+alt+h',
        'cmd+equal',
        'cmd+shift+equal',
        'cmd+0',
        'cmd+minus',
        'f6 cmd+c',
      ]) {
        final map = ResolvedKeymap(
          harnessDefaultBindings,
          KeymapConfig.parse(
            '{"bindings":[{"keys":"$keys","command":"pane.focus_left"}]}',
            commands: harnessCommandById.keys.toSet(),
          ),
        );
        expect(
          () => AppKeymap.validateNativeKeys(map, macOS: true),
          throwsFormatException,
        );
        AppKeymap.validateNativeKeys(map, macOS: false);
      }
      final map = ResolvedKeymap(
        harnessDefaultBindings,
        KeymapConfig.parse(
          '{"bindings":[{"keys":"cmd+h","command":"pane.focus_left"},{"keys":"cmd+m","command":"machines.list"},{"keys":"cmd+k","command":null},{"keys":"cmd+k c","command":"pane.focus_right"}]}',
          commands: harnessCommandById.keys.toSet(),
        ),
      );
      AppKeymap.validateNativeKeys(map, macOS: true);
    },
  );

  testWidgets(
    'configured bindings dispatch before the focused owner and unbinding restores its route',
    (tester) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      final delivered = <String>[];
      var searches = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: KeymapHost(
              keymap: map,
              enabled: () => true,
              actions: {'swarm.new': () => searches++},
              child: KeymapRegion(
                contextKind: KeymapContext.terminal,
                child: Focus(
                  focusNode: focus,
                  autofocus: true,
                  onKeyEvent: (_, event) {
                    final stroke = keyStrokeForEvent(event);
                    if (event is KeyDownEvent && stroke != null) {
                      delivered.add(stroke.toString());
                    }
                    return KeyEventResult.handled;
                  },
                  child: const SizedBox(width: 100, height: 100),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(searches, 1);
      expect(delivered, isEmpty);
      await key(tester, LogicalKeyboardKey.keyB, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyC, alt: true);
      await key(tester, LogicalKeyboardKey.tab, ctrl: true);
      expect(delivered, ['ctrl+b', 'alt+c']);
      map.apply(
        '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"ctrl+o","command":"swarm.new","when":"terminal"}]}',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      await key(tester, LogicalKeyboardKey.keyO, ctrl: true);
      expect(searches, 2);
      expect(delivered.last, 'cmd+t');
      await tester.pumpWidget(const SizedBox());
      focus.dispose();
      map.dispose();
    },
  );

  testWidgets(
    'modal picker actions stay local and respect active text composition',
    (tester) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      final text = TextEditingController(text: 'draft');
      var selected = 0, swarms = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: KeymapHost(
              keymap: map,
              enabled: () => false,
              actions: {'swarm.new': () => swarms++},
              child: KeymapRegion(
                contextKind: KeymapContext.picker,
                actions: {
                  'picker.next': () => selected++,
                  'picker.accept': () => selected += 10,
                },
                child: Material(
                  child: TextField(
                    controller: text,
                    focusNode: focus,
                    autofocus: true,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
      expect(selected, 1);
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(swarms, 0);
      text.value = text.value.copyWith(
        composing: const TextRange(start: 0, end: 5),
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(selected, 1);
      text.clearComposing();
      await key(tester, LogicalKeyboardKey.enter);
      expect(selected, 11);
      expect(text.text, 'draft');
      await tester.pumpWidget(const SizedBox());
      focus.dispose();
      text.dispose();
      map.dispose();
    },
  );
}
