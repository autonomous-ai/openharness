import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/sections/shortcuts_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/shortcuts_list.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:xterm/xterm.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

const nativeChannel = MethodChannel('harness/swarm_tabs');

Future<void> mount(
  WidgetTester tester,
  AppNotifier app,
  AppKeymap keymap, {
  bool native = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final projects = SwarmProjectStore();
  addTearDown(projects.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (_, child) => KeymapProvider(keymap: keymap, child: child!),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: native,
        projectStore: projects,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> native(WidgetTester tester, String method, [Object? arguments]) {
  final done = Completer<void>();
  tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    nativeChannel.name,
    const StandardMethodCodec().encodeMethodCall(MethodCall(method, arguments)),
    (_) => done.complete(),
  );
  return done.future;
}

Future<void> tabToResult(WidgetTester tester, {String? id}) async {
  ListTile? focusedResult() => FocusManager.instance.primaryFocus?.context
      ?.findAncestorWidgetOfExactType<ListTile>();
  bool reached() => id == null
      ? focusedResult() != null
      : focusedResult()?.key == ValueKey(id);
  for (var i = 0; i < 16 && !reached(); i++) {
    await key(tester, LogicalKeyboardKey.tab);
  }
  expect(reached(), isTrue, reason: 'The result is reachable with Tab');
}

void main() {
  for (final remapped in [false, true]) {
    testWidgets(
      'the configured Layout key cycles choices and returns to latest output (remapped=$remapped)',
      (tester) async {
        final app = createApp();
        final map = MemoryKeymap();
        if (remapped) {
          map.apply('''{"bindings":[
            {"keys":"cmd+shift+l","command":null},
            {"keys":"cmd+y","command":"pane.layout"}
          ]}''');
        }
        final firstInput = <TerminalBinaryFrame>[];
        final secondInput = <TerminalBinaryFrame>[];
        final first = terminal('a0', firstInput);
        final second = terminal('a1', secondInput);
        app.adoptSessionForTest(first);
        final focused = app.adoptSessionForTest(second);
        await mount(tester, app, map);
        for (final session in [first, second]) {
          session.terminal.write(
            List.generate(200, (i) => 'Output $i\r\n').join(),
          );
        }
        await tester.pump();
        final views = tester
            .widgetList<TerminalView>(find.byType(TerminalView))
            .toList();
        for (final view in views) {
          expect(
            view.scrollController!.position.maxScrollExtent,
            greaterThan(0),
          );
          view.scrollController!.jumpTo(0);
        }
        await tester.pump();
        final before = app.presetFor(2);
        final shortcut = remapped
            ? LogicalKeyboardKey.keyY
            : LogicalKeyboardKey.keyL;
        await key(tester, shortcut, cmd: true, shift: !remapped);
        await tester.pumpAndSettle();
        if (remapped) {
          await key(tester, LogicalKeyboardKey.keyL, cmd: true, shift: true);
        }
        // Fast repeated chords can arrive before the next rendered frame.
        await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
        if (!remapped) {
          await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        }
        await tester.sendKeyEvent(shortcut);
        await tester.sendKeyEvent(shortcut);
        await tester.sendKeyEvent(shortcut);
        if (!remapped) {
          await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        }
        await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
        await tester.pump();
        expect(find.byType(Dialog), findsOneWidget);
        expect(app.presetFor(2), before);
        expect(app.focusedPane, same(focused));
        for (final view in views) {
          expect(view.scrollController!.offset, 0);
        }
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(app.presetFor(2), PanePreset.rows);
        expect(find.byType(Dialog), findsNothing);
        for (final view in views) {
          expect(
            view.scrollController!.offset,
            view.scrollController!.position.maxScrollExtent,
          );
        }
        expect(firstInput, isEmpty);
        expect(secondInput, isEmpty);
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(firstInput, isEmpty);
        expect(secondInput.single.bytes, [27, 91, 68]);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  testWidgets('modified layout digits do not confirm a shape', (tester) async {
    final app = createApp();
    final map = MemoryKeymap();
    app.adoptSessionForTest(terminal('a0', []));
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app, map);
    final before = app.presetFor(2);
    await key(tester, LogicalKeyboardKey.keyL, cmd: true, shift: true);
    await tester.pumpAndSettle();
    for (final modifier in ['cmd', 'ctrl', 'alt', 'shift']) {
      await key(
        tester,
        LogicalKeyboardKey.digit3,
        cmd: modifier == 'cmd',
        ctrl: modifier == 'ctrl',
        alt: modifier == 'alt',
        shift: modifier == 'shift',
      );
      expect(find.byType(Dialog), findsOneWidget);
      expect(app.presetFor(2), before);
    }
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });

  testWidgets('Command-T opens New Tab and Command-Shift-L opens Layout', (
    tester,
  ) async {
    final app = createApp();
    final map = MemoryKeymap();
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final focused = app.adoptSessionForTest(terminal('a1', input));
    final original = app.activeSwarm;
    await mount(tester, app, map);
    await key(tester, LogicalKeyboardKey.keyL, cmd: true, shift: true);
    await tester.pumpAndSettle();
    expect(find.text('Layout · 2 panes'), findsOneWidget);
    expect(app.focusedPane, same(focused));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    await key(tester, LogicalKeyboardKey.keyT, cmd: true);
    expect(app.swarms, hasLength(2));
    expect(app.activeSwarm, isNot(same(original)));
    expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
    await key(tester, LogicalKeyboardKey.keyO, cmd: true);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('swarm-search-input')))
          .focusNode!
          .hasPrimaryFocus,
      isTrue,
    );
    expect(find.byType(SwarmSearchResults), findsOneWidget);
    expect(original.panes.last, same(focused));
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });

  for (final nativeTabs in [false, true]) {
    testWidgets(
      'Command-number selects tabs and preserves pane focus (native=$nativeTabs)',
      (tester) async {
        final app = createApp();
        final map = MemoryKeymap();
        final input = <TerminalBinaryFrame>[];
        final firstLeft = app.adoptSessionForTest(terminal('a0', input));
        final firstRight = app.adoptSessionForTest(terminal('a1', input));
        final firstTab = app.activeSwarm;
        app.newSwarm();
        final secondLeft = app.adoptSessionForTest(terminal('a2', input));
        final secondRight = app.adoptSessionForTest(terminal('a3', input));
        final secondTab = app.activeSwarm;
        app.newSwarm();
        final emptyTab = app.activeSwarm;
        if (nativeTabs) {
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            nativeChannel,
            (_) async => null,
          );
          addTearDown(
            () => tester.binding.defaultBinaryMessenger
                .setMockMethodCallHandler(nativeChannel, null),
          );
        }
        await mount(tester, app, map, native: nativeTabs);
        Future<void> select(int number) async {
          if (nativeTabs) {
            await native(tester, 'keymapCommand', {
              'command': 'swarm.select_$number',
            });
          } else {
            await key(
              tester,
              LogicalKeyboardKey(LogicalKeyboardKey.digit1.keyId + number - 1),
              cmd: true,
            );
          }
          await tester.pump(const Duration(milliseconds: 100));
        }

        await select(1);
        expect(app.activeSwarm, same(firstTab));
        expect(app.focusedPaneId, firstRight.id);
        await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
        expect(app.focusedPaneId, firstLeft.id);
        await select(2);
        expect(app.activeSwarm, same(secondTab));
        expect(app.focusedPaneId, secondRight.id);
        await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
        expect(app.focusedPaneId, secondLeft.id);
        await select(1);
        expect(app.focusedPaneId, firstLeft.id);
        await select(9);
        expect(
          app.activeSwarm,
          same(firstTab),
          reason: 'A missing tab number is a no-op',
        );
        app.reorderSwarm(secondTab.id, 0);
        await select(1);
        expect(app.activeSwarm, same(secondTab));
        expect(app.focusedPaneId, secondLeft.id);
        expect(firstTab.panes, [firstLeft, firstRight]);
        expect(secondTab.panes, [secondLeft, secondRight]);
        expect(emptyTab.panes, isEmpty);
        expect(
          input,
          isEmpty,
          reason: 'App navigation never reaches terminal input',
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
        await tester.pump();
        expect(input.single.bytes, [27, 91, 68]);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  testWidgets(
    'remaps, unbinding and sequences control the actual focused agent without leaking input',
    (tester) async {
      final map = MemoryKeymap();
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final firstInput = <TerminalBinaryFrame>[],
          secondInput = <TerminalBinaryFrame>[];
      final first = app.adoptSessionForTest(terminal('a0', firstInput));
      final second = app.adoptSessionForTest(terminal('a1', secondInput));
      await mount(tester, app, map);
      await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
      expect(app.focusedPaneId, first.id);
      await key(tester, LogicalKeyboardKey.arrowRight, cmd: true);
      expect(app.focusedPaneId, second.id);
      map.apply('''{"bindings":[
      {"keys":"cmd+left","command":null,"when":"terminal"},
      {"keys":"ctrl+g","command":"pane.focus_left","when":"terminal"},
      {"keys":"cmd+k","command":null},
      {"keys":"cmd+k n","command":"pane.focus_right"}
    ]}''');
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowLeft, cmd: true);
      expect(
        app.focusedPaneId,
        second.id,
        reason: 'No hardcoded arrow fallback',
      );
      await key(tester, LogicalKeyboardKey.keyG, ctrl: true);
      expect(app.focusedPaneId, first.id);
      expect(firstInput, isEmpty);
      expect(secondInput, isEmpty);
      await key(tester, LogicalKeyboardKey.keyK, cmd: true);
      expect(find.text('⌘K …  Esc to cancel'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.arrowDown);
      expect(find.text('⌘K …  Esc to cancel'), findsNothing);
      expect(
        firstInput,
        isEmpty,
        reason: 'A failed sequence is never agent input',
      );
      await key(tester, LogicalKeyboardKey.keyK, cmd: true);
      await key(tester, LogicalKeyboardKey.keyN);
      expect(app.focusedPaneId, second.id);
      await key(tester, LogicalKeyboardKey.arrowLeft);
      expect(secondInput.single.bytes, [27, 91, 68]);
      expect(firstInput, isEmpty);
      map.apply(
        '{"bindings":[{"keys":"ctrl+g","command":null,"when":"terminal"}]}',
      );
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyG, ctrl: true);
      expect(secondInput.last.bytes, [
        7,
      ], reason: 'Unbinding restores the original agent input route');
      expect(app.panes, [first, second]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    },
  );

  for (final inline in [false, true]) {
    testWidgets(
      'configured picker actions and hints stay in ${inline ? 'start-page' : 'Open Harness'} search',
      (tester) async {
        final map = MemoryKeymap()
          ..apply('''{"bindings":[
        {"keys":"down","command":null,"when":"picker"},
        {"keys":"ctrl+j","command":"picker.previous","when":"picker"},
        {"keys":"enter","command":null,"when":"picker"},
        {"keys":"alt+enter","command":"picker.accept","when":"picker"}
      ]}''');
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final frames = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', frames));
        app.newSwarm();
        final addingTo = app.activeSwarmId;
        await mount(tester, app, map);
        final input = find.byKey(
          ValueKey(inline ? 'harness-start-search' : 'swarm-search-input'),
        );
        if (inline) {
          await tester.tap(input);
        } else {
          await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        }
        await tester.enterText(input, 'Agent');
        await tester.pump();
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        final initial = search.cursor;
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(search.cursor, initial);
        await key(tester, LogicalKeyboardKey.keyJ, ctrl: true);
        expect(
          search.cursor,
          inline ? (initial - 1) % search.rows.length : initial + 1,
        );
        await tester.enterText(input, 'Agent 0');
        await tester.pump();
        expect(
          find.byKey(const ValueKey('swarm-search-preview')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('swarm-search-preview-toggle')),
          findsNothing,
        );
        await key(tester, LogicalKeyboardKey.enter);
        expect(find.byType(SwarmSearchResults), findsOneWidget);
        expect(frames, isEmpty);
        await key(tester, LogicalKeyboardKey.enter, alt: true);
        expect(app.activeSwarmId, addingTo);
        expect(app.focusedPane, same(pane));
        expect(find.byType(SwarmSearchResults), findsNothing);
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(frames.single.bytes, [27, 91, 68]);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  testWidgets('start-page picker honors remapped navigation and command mode', (
    tester,
  ) async {
    final map = MemoryKeymap()
      ..apply('''{"bindings":[
        {"keys":"down","command":null,"when":"picker"},
        {"keys":"enter","command":null,"when":"picker"},
        {"keys":"ctrl+g","command":"picker.next","when":"picker"},
        {"keys":"alt+enter","command":"picker.accept","when":"picker"},
        {"keys":"cmd+d","command":"navigation.commands","when":"picker"}
      ]}''');
    final app = createApp();
    await mount(tester, app, map);
    final initialId = app.activeSwarmId;
    final field = find.byKey(const ValueKey('harness-start-search'));
    expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
    await tester.tap(field);
    await tester.pump();
    expect(tester.widget<TextField>(field).focusNode!.hasPrimaryFocus, isTrue);
    final search = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    final cursor = search.cursor;
    await key(tester, LogicalKeyboardKey.arrowDown);
    await key(tester, LogicalKeyboardKey.enter);
    expect(search.cursor, cursor);
    expect(app.activeSwarmId, initialId);
    expect(app.panes, isEmpty);
    await key(tester, LogicalKeyboardKey.keyG, ctrl: true);
    expect(search.cursor, (cursor + 1) % search.rows.length);
    await key(tester, LogicalKeyboardKey.keyD, cmd: true);
    final commands = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    expect(commands.isCommandMode, isTrue);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('swarm-search-input')))
          .controller!
          .text,
      '> ',
    );
    await key(tester, LogicalKeyboardKey.escape);
    expect(field, findsOneWidget);
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    await key(tester, LogicalKeyboardKey.keyP, cmd: true);
    final modal = find.byKey(const ValueKey('swarm-search-input'));
    expect(tester.widget<TextField>(modal).focusNode!.hasFocus, isTrue);
    expect(tester.widget<TextField>(modal).controller!.text, isEmpty);
    expect(app.panes, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
    map.dispose();
  });

  testWidgets(
    'native buttons leave all search editing in Flutter during refresh',
    (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        nativeChannel,
        (call) async {
          calls.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeChannel,
          null,
        ),
      );
      final map = MemoryKeymap();
      final app = createApp();
      await mount(tester, app, map, native: true);
      calls.clear();
      final field = find.byKey(const ValueKey('harness-start-search'));
      await tester.tap(field);
      await tester.pump();
      for (final query in ['w', 'wo', 'wor', 'work', 'work 木']) {
        await tester.enterText(field, query);
        app.renameSwarm(app.activeSwarmId, 'Background $query');
      }
      await tester.pump();
      expect(
        calls.where((c) => c.method == 'searchState'),
        isEmpty,
        reason:
            'Typing and discovery do not need a reverse-channel field update',
      );
      for (final query in ['>', '> s', '> se', '> set']) {
        await tester.enterText(field, query);
        app.renameSwarm(app.activeSwarmId, 'Background $query');
      }
      map.apply(
        '{"bindings":[{"keys":"down","command":null,"when":"picker"}]}',
      );
      await tester.pump();
      expect(
        calls
            .where((c) => c.method == 'searchState')
            .map((c) => c.arguments)
            .toList(),
        isEmpty,
      );
      await tester.enterText(field, 'Agent 木');
      final editing = tester.widget<TextField>(field).controller!;
      editing.value = editing.value.copyWith(
        composing: const TextRange(start: 6, end: 7),
      );
      final composing = editing.value;
      await tester.pump();
      for (final command in ['commands', 'newAgent']) {
        final opening = native(tester, command);
        await tester.pump();
        await opening;
        expect(editing.value, composing);
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
        expect(find.byType(SwarmSearchResults), findsOneWidget);
      }
      editing.clearComposing();
      await tester.enterText(field, 'Agent');
      await tester.pump();
      await tabToResult(tester);
      calls.clear();
      final opening = native(tester, 'commands');
      await tester.pump();
      await opening;
      await tester.pump();
      expect(
        calls
            .where((c) => c.method == 'searchState')
            .map((c) => c.arguments)
            .toList(),
        isEmpty,
        reason: 'Native chrome never mirrors the Flutter query',
      );
      final commandField = find.byKey(const ValueKey('swarm-search-input'));
      expect(commandField, findsOneWidget);
      expect(tester.widget<TextField>(commandField).controller!.text, '> ');
      expect(
        tester.widget<TextField>(commandField).focusNode!.hasPrimaryFocus,
        isTrue,
      );
      expect(
        tester.widget<TextField>(commandField).decoration!.hintText,
        'Search commands…',
      );
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(SwarmSearchResults), findsNothing);
      expect(field, findsOneWidget);
      expect(tester.widget<TextField>(field).controller!.text, 'Agent');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    },
  );

  for (final (fromMenu, resultFocused) in [
    (false, false),
    (true, false),
    (false, true),
    (true, true),
  ]) {
    testWidgets(
      'New closes inline search before opening its form (native=$fromMenu, result focused=$resultFocused)',
      (tester) async {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeChannel,
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            nativeChannel,
            null,
          ),
        );
        final app = createApp();
        final map = MemoryKeymap();
        await mount(tester, app, map, native: fromMenu);
        final field = find.byKey(const ValueKey('harness-start-search'));
        await tester.tap(field);
        await tester.enterText(field, 'Agent 12');
        await tester.pump();
        expect(find.byType(SwarmSearchResults), findsOneWidget);
        if (resultFocused) {
          await tabToResult(tester);
        }
        if (fromMenu) {
          final opening = native(tester, 'newAgent');
          await tester.pump();
          await opening;
        } else {
          await key(tester, LogicalKeyboardKey.keyN, cmd: true);
        }
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(find.byType(SwarmSearchResults), findsNothing);
        // The form opens with focus on its agent bar, and Escape there still
        // closes the form.
        expect(
          tester
              .widget<AgentPicker>(find.byType(AgentPicker))
              .focusNode!
              .hasPrimaryFocus,
          isTrue,
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isFalse);
        expect(tester.widget<TextField>(field).controller!.text, 'Agent 12');
        expect(app.panes, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  for (final inline in [false, true]) {
    testWidgets(
      'focused results share picker selection and configured keys (inline=$inline)',
      (tester) async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        final firstInput = <TerminalBinaryFrame>[];
        final secondInput = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', firstInput));
        final second = app.adoptSessionForTest(terminal('a1', secondInput));
        app.newSwarm();
        final target = app.activeSwarmId;
        final map = MemoryKeymap()
          ..apply('''{"bindings":[
            {"keys":"down","command":null,"when":"picker"},
            {"keys":"ctrl+g","command":"picker.next","when":"picker"},
            {"keys":"enter","command":null,"when":"picker"},
            {"keys":"alt+enter","command":"picker.accept","when":"picker"}
          ]}''');
        await mount(tester, app, map);
        final field = find.byKey(
          ValueKey(inline ? 'harness-start-search' : 'swarm-search-input'),
        );
        if (inline) {
          await tester.tap(field);
        } else {
          await key(tester, LogicalKeyboardKey.keyP, cmd: true);
        }
        await tester.enterText(field, 'Agent');
        await tester.pump();
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        final secondRow = search.rows.firstWhere((row) => row.agentId == 'a1');
        await tabToResult(tester, id: secondRow.id);
        expect(search.selected, same(secondRow));
        final next =
            search.rows[inline
                ? (search.cursor + 1) % search.rows.length
                : (search.cursor - 1).clamp(0, search.rows.length - 1)];
        await key(tester, LogicalKeyboardKey.arrowDown);
        expect(search.selected, same(secondRow));
        await key(tester, LogicalKeyboardKey.keyG, ctrl: true);
        expect(search.selected, same(next));
        expect(
          tester.widget<TextField>(field).focusNode!.hasPrimaryFocus,
          isTrue,
        );
        await tabToResult(tester, id: secondRow.id);
        expect(search.selected, same(secondRow));
        await key(tester, LogicalKeyboardKey.enter);
        expect(find.byType(SwarmSearchResults), findsOneWidget);
        expect(app.activeSwarm.panes, isEmpty);
        await key(tester, LogicalKeyboardKey.enter, alt: true);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(app.activeSwarmId, target);
        expect(app.focusedPane, same(second));
        expect(firstInput, isEmpty);
        expect(secondInput, isEmpty);
        await key(tester, LogicalKeyboardKey.arrowLeft);
        expect(firstInput, isEmpty);
        expect(secondInput.single.bytes, [27, 91, 68]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  testWidgets(
    'terminal IME composition keeps its keys before workspace dispatch',
    (tester) async {
      final map = MemoryKeymap();
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final frames = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', frames));
      await mount(tester, app, map);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: '木',
          selection: TextSelection.collapsed(offset: 1),
          composing: TextRange(start: 0, end: 1),
        ),
      );
      await tester.pump();
      expect(
        tester.state<TerminalViewState>(find.byType(TerminalView)).isComposing,
        isTrue,
      );
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(app.swarms, hasLength(1));
      expect(frames, isEmpty);
      tester.testTextInput.updateEditingValue(TextEditingValue.empty);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.keyT, cmd: true);
      expect(app.swarms, hasLength(2));
      expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    },
  );

  testWidgets(
    'native commands and snapshots use the same configured workspace actions',
    (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        nativeChannel,
        (call) async {
          calls.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeChannel,
          null,
        ),
      );
      final map = MemoryKeymap();
      final app = createApp();
      final pane = app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app, map, native: true);
      expect(calls.where((c) => c.method == 'keymapState'), hasLength(1));
      map.apply(
        '{"bindings":[{"keys":"cmd+t","command":null},{"keys":"cmd+o","command":"swarm.new"}]}',
      );
      await tester.pump();
      final snapshot =
          calls.lastWhere((c) => c.method == 'keymapState').arguments as Map;
      final picker = (snapshot['contexts'] as Map)['picker'] as List;
      expect(
        picker.any((row) => (row['keys'] as List).contains('cmd+t')),
        isFalse,
      );
      expect(
        picker.any(
          (row) =>
              row['command'] == 'swarm.new' &&
              (row['keys'] as List).contains('cmd+o'),
        ),
        isTrue,
      );
      await native(tester, 'keymapCommand', {'command': 'swarm.new'});
      await tester.pump();
      final field = find.byKey(const ValueKey('swarm-search-input'));
      expect(field, findsNothing);
      await native(tester, 'keymapCommand', {'command': 'agent.open'});
      await tester.pump();
      await tester.tap(field);
      await tester.enterText(field, 'Agent 0');
      await tester.pump();
      expect(find.byType(SwarmSearchResults), findsOneWidget);
      await native(tester, 'keymapCommand', {'command': 'picker.accept'});
      await tester.pump();
      expect(find.byType(SwarmSearchResults), findsNothing);
      expect(app.focusedPane, same(pane));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      map.dispose();
    },
  );

  testWidgets(
    'shortcut help reflects current overrides, context and unbound commands',
    (tester) async {
      final map = MemoryKeymap();
      late BuildContext helpContext;
      await tester.pumpWidget(
        MaterialApp(
          home: KeymapProvider(
            keymap: map,
            child: Builder(
              builder: (context) {
                helpContext = context;
                return const Scaffold(body: ShortcutsSection());
              },
            ),
          ),
        ),
      );
      var rows = effectiveShortcutRows(helpContext, KeymapContext.workspace);
      final searchLabel = rows
          .firstWhere((row) => row.chords.any((keys) => keys.join() == '⌘T'))
          .label;
      map.apply('''{"bindings":[
      {"keys":"cmd+t","command":null},
      {"keys":"cmd+o","command":"swarm.new"},
      {"keys":"cmd+s","command":null,"when":"terminal"}
    ]}''');
      await tester.pump();
      rows = effectiveShortcutRows(helpContext, KeymapContext.workspace);
      expect(rows.firstWhere((r) => r.label == searchLabel).chords, [
        ['⌘', 'O'],
      ]);
      expect(
        rows.any((r) => r.chords.any((keys) => keys.join() == '⌘T')),
        isFalse,
      );
      final terminalRows = effectiveShortcutRows(
        helpContext,
        KeymapContext.terminal,
      );
      expect(terminalRows.where((r) => r.chords.isEmpty), isNotEmpty);
      expect(find.byType(ShortcutsDeck), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      map.dispose();
    },
  );
}
