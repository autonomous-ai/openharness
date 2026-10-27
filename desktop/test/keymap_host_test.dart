import 'dart:convert';

import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/shortcuts/keymap_keyboard.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_composer.dart';

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

Future<TerminalSession> liveComposerSession() async {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  Object? requestId;
  final session = TerminalSession(
    machineId: 'fixture-machine',
    agentId: 'fixture-agent',
    agentName: 'Fixture',
    engineId: 'claude',
    client: const TerminalClientDescriptor(kind: 'desktop', name: 'Fixture'),
    send: (type, payload) async {
      if (type == 'terminal_open') requestId = payload['requestId'];
      return true;
    },
    sendBinary: (_) async => true,
  );
  await session.open(initialCols: 80, initialRows: 24);
  await session.handleFrame('terminal_ready', {
    'requestId': requestId,
    'protocolVersion': 3,
    'streamId': streamId,
    'agentId': 'fixture-agent',
  });
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(r'$ ')),
      compressed: false,
      cols: 80,
      rows: 24,
    ),
  );
  return session;
}

Widget terminalKeymapHost(
  AppKeymap map,
  Map<String, VoidCallback> actions,
  Widget child, {
  FocusNode? terminalFocusNode,
}) => MaterialApp(
  home: KeymapProvider(
    keymap: map,
    child: KeymapHost(
      keymap: map,
      enabled: () => true,
      actions: actions,
      child: KeymapRegion(
        contextKind: KeymapContext.terminal,
        terminalFocusNode: terminalFocusNode,
        child: Material(child: child),
      ),
    ),
  ),
);

void main() {
  group('native Windows terminal aliases', () {
    testWidgets('pane header buttons count as outside the terminal view', (
      tester,
    ) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      var opened = 0, closed = 0, created = 0;
      await tester.pumpWidget(
        terminalKeymapHost(
          map,
          {
            'swarm.new': () => opened++,
            'swarm.close': () => closed++,
            'agent.new': () => created++,
          },
          TextButton(
            focusNode: focus,
            autofocus: true,
            onPressed: () {},
            child: const Text('Pane action'),
          ),
        ),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyN, ctrl: true);
      expect([opened, closed, created], [1, 1, 1]);
      await tester.pumpWidget(const SizedBox());
      focus.dispose();
      map.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets('real panel renderer keeps plain Ctrl letters', (tester) async {
      final app = createApp();
      final map = MemoryKeymap();
      final session = await liveComposerSession();
      final output = <String>[];
      session.terminal.onOutput = output.add;
      var opened = 0;
      await tester.pumpWidget(
        terminalKeymapHost(map, {
          'swarm.new': () => opened++,
        }, TerminalPanel(notifier: app, session: session, focused: true)),
      );
      await tester.pump();
      tester
          .widget<TerminalView>(find.byType(TerminalView))
          .focusNode!
          .requestFocus();
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
      await key(tester, LogicalKeyboardKey.keyR, ctrl: true);
      expect(opened, 0);
      expect(output.join(), '\x14\x12');
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true, shift: true);
      expect(opened, 1);
      await tester.pumpWidget(const SizedBox());
      session.dispose();
      map.dispose();
      app.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets('Ctrl+T in the terminal view reaches the terminal', (
      tester,
    ) async {
      final map = MemoryKeymap();
      final focus = FocusNode();
      final delivered = <String>[];
      var opened = 0;
      await tester.pumpWidget(
        terminalKeymapHost(
          map,
          {'swarm.new': () => opened++},
          Focus(
            focusNode: focus,
            autofocus: true,
            onKeyEvent: (_, event) {
              if (event is KeyDownEvent) {
                final stroke = keyStrokeForEvent(event);
                if (stroke != null) delivered.add(stroke.toString());
              }
              return KeyEventResult.handled;
            },
            child: const SizedBox(width: 100, height: 100),
          ),
          terminalFocusNode: focus,
        ),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
      expect(opened, 0);
      expect(delivered, ['ctrl+t']);
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true, shift: true);
      expect(opened, 1);
      await tester.pumpWidget(const SizedBox());
      focus.dispose();
      map.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

    testWidgets(
      'Ctrl+T in the terminal composer opens a tab, Ctrl+W and Ctrl+U edit the line',
      (tester) async {
        final map = MemoryKeymap();
        final focus = FocusNode();
        final session = await liveComposerSession();
        var opened = 0, closed = 0;
        await tester.pumpWidget(
          terminalKeymapHost(map, {
            'swarm.new': () => opened++,
            'swarm.close': () => closed++,
          }, TerminalComposer(session: session, focusNode: focus)),
        );
        focus.requestFocus();
        await tester.pump();
        await tester.enterText(find.byType(TextField), 'hello world');
        await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
        expect(opened, 1);
        await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
        expect(closed, 0);
        final controller = tester
            .widget<TextField>(find.byType(TextField))
            .controller!;
        expect(controller.text, 'hello ');
        await key(tester, LogicalKeyboardKey.keyU, ctrl: true);
        expect(controller.text, isEmpty);
        controller.value = const TextEditingValue(
          text: 'draft',
          selection: TextSelection.collapsed(offset: 5),
          composing: TextRange(start: 0, end: 5),
        );
        await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
        expect(opened, 1);
        controller.clearComposing();
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        focus.dispose();
        map.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );

    testWidgets(
      'find fields inside a terminal region keep Ctrl+W app aliases',
      (tester) async {
        final map = MemoryKeymap();
        final focus = FocusNode(debugLabel: 'terminal composer');
        var opened = 0, closed = 0;
        await tester.pumpWidget(
          terminalKeymapHost(map, {
            'swarm.new': () => opened++,
            'swarm.close': () => closed++,
          }, TextField(focusNode: focus, autofocus: true)),
        );
        await tester.pump();
        await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
        await key(tester, LogicalKeyboardKey.keyW, ctrl: true);
        expect(opened, 1);
        expect(closed, 1);
        await tester.pumpWidget(const SizedBox());
        focus.dispose();
        map.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.windows),
    );

    testWidgets('a user row on Ctrl+T still runs in the terminal view', (
      tester,
    ) async {
      final map = MemoryKeymap();
      map.apply('{"bindings":[{"keys":"ctrl+t","command":"pane.zoom"}]}');
      final focus = FocusNode();
      var zoomed = 0, opened = 0;
      await tester.pumpWidget(
        terminalKeymapHost(
          map,
          {'swarm.new': () => opened++, 'pane.zoom': () => zoomed++},
          Focus(focusNode: focus, autofocus: true, child: const SizedBox()),
          terminalFocusNode: focus,
        ),
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, ctrl: true);
      expect(zoomed, 1);
      expect(opened, 0);
      await tester.pumpWidget(const SizedBox());
      focus.dispose();
      map.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.windows));
  });

  test('saved close shortcuts override the pane and tab defaults', () {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    map.apply(
      '{"bindings":[{"keys":"cmd+w","command":"pane.close"},{"keys":"cmd+shift+w","command":"swarm.close"}]}',
    );
    expect(
      map.current.match(KeymapContext.terminal, [
        KeyStroke.parse('cmd+w'),
      ]).command,
      'pane.close',
    );
    expect(
      map.current.match(KeymapContext.terminal, [
        KeyStroke.parse('cmd+shift+w'),
      ]).command,
      'swarm.close',
    );
  });
  test('the command catalog retains the current direct workspace keys', () {
    expect(harnessCommandById['harnesses.list']!.label, 'Open Harness');
    expect(harnessCommandById['agent.open']!.label, 'Open Project');
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
      ('cmd+p', 'harnesses.list'),
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
      ('cmd+shift+p', 'navigation.commands'),
      ('cmd+s', 'super_tab.new'),
      ('cmd+ctrl+s', 'app.store'),
      ('cmd+shift+s', 'agent.share'),
      ('cmd+m', 'machines.list'),
      ('cmd+i', 'models.list'),
      ('cmd+shift+l', 'pane.layout'),
      ('cmd+shift+f', 'pane.toggle_shading'),
      ('cmd+b', 'task.route'),
      ('cmd+w', 'swarm.close'),
      ('cmd+shift+w', 'pane.close'),
      ('ctrl+tab', 'swarm.next'),
      // Move Pane Up until it was retired; Chat with PM since.
      ('cmd+shift+k', 'swarm.chat_with_pm'),
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
    for (final retired in ['cmd+shift+h', 'cmd+u', 'cmd+y']) {
      expect(command(retired), isNull, reason: retired);
    }
    // ⌥⌘←/→ walk tabs, as in Safari and Chrome; ⇧⌘[ ] no longer do.
    expect(command('cmd+alt+left'), 'swarm.previous');
    expect(command('cmd+alt+right'), 'swarm.next');
    expect(command('cmd+shift+['), isNull);
    expect(command('cmd+shift+enter'), isNull);
    expect(command('cmd+alt+shift+t'), isNull);
    expect(command('ctrl+n', KeymapContext.picker), 'picker.next');
    expect(command('cmd+t', KeymapContext.picker), 'swarm.new');
    expect(command('cmd+['), 'navigation.back');
  });

  test('Models uses Cmd I and respects a saved pane shortcut', () {
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    expect(map.hint('models.list'), '⌘I');
    expect(harnessCommandById['pane.last']!.keys, isEmpty);
    map.apply('''{"bindings":[
      {"keys":"cmd+semicolon","command":"pane.last"},
      {"keys":"cmd+y","command":"models.list"}
    ]}''');
    for (final context in KeymapContext.values) {
      expect(
        map.current.match(context, [KeyStroke.parse('cmd+semicolon')]).command,
        'pane.last',
      );
      expect(
        map.current.match(context, [KeyStroke.parse('cmd+y')]).command,
        'models.list',
      );
    }
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

  testWidgets('a region keeps its own strokes from the workspace bindings', (
    tester,
  ) async {
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
              contextKind: KeymapContext.workspace,
              // An editor's ⌘T would be its own; the workspace keeps the rest.
              keeps: {KeyStroke.parse('cmd+t')},
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
    expect(searches, 0);
    expect(delivered, ['cmd+t']);
    await tester.pumpWidget(const SizedBox());
    focus.dispose();
    map.dispose();
  });

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
