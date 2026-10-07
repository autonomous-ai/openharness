import 'dart:async';
import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart' show Agent;
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/agent_drag.dart' show PaneCloseButton;
import 'package:harness/widgets/desktop_workspace_tab.dart';
import 'package:harness/widgets/workspace_welcome.dart';
import 'package:xterm/xterm.dart' show TerminalView;

import 'keymap_runtime_test.dart' show native, nativeChannel;
import 'support/stop_connection.dart';
import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

class _Connection extends StopConnection {
  final creation = Completer<Map<String, dynamic>>();

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => type == 'agent_create'
      ? creation.future
      : super.request(type, payload: payload, timeout: timeout);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'closing the final pane selects its neighboring tab and persists it',
    () async {
      final store = MemoryStore();
      final app = createApp(store: store);
      addTearDown(app.dispose);
      final left = app.adoptSessionForTest(terminal('a0', []));
      final leftTab = app.activeSwarm;
      app.newSwarm(name: 'Closing');
      final closing = app.adoptSessionForTest(terminal('a1', []));
      final closingTab = app.activeSwarm;
      app.newSwarm(name: 'Working');
      final right = app.adoptSessionForTest(terminal('a2', []));
      final rightTab = app.activeSwarm;
      app.selectSwarm(closingTab.id);

      await app.closePane(closing.id);

      expect(app.swarms, [leftTab, rightTab]);
      expect(app.activeSwarm, same(rightTab));
      expect(app.focusedPane, same(right));
      expect(app.allPanes, [left, right]);
      await app.flushPaneLayout();
      final restored = createApp(store: store);
      addTearDown(restored.dispose);
      await restored.restorePaneLayoutForTest();
      expect(restored.swarms.map((tab) => tab.id), [leftTab.id, rightTab.id]);
      expect(restored.activeSwarmId, rightTab.id);
    },
  );

  test('the last tab becomes a fresh welcome and can be reopened with its name and layout', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final original = app.activeSwarm;
    app.renameSwarm(original.id, 'Project work');
    original.presets[2] = PanePreset.rows;

    await app.closePane(pane.id);

    expect(app.swarms.single.id, isNot(original.id));
    expect(app.activeSwarm.name, Swarm.defaultName);
    expect(app.activeSwarm.isEmptyStarter, isTrue);
    expect(app.closedHistory, hasLength(1));
    expect(app.reopenClosed(), isTrue);
    expect(app.swarms.single.id, original.id);
    expect(app.activeSwarm.name, 'Project work');
    expect(app.activeSwarm.presets[2], PanePreset.rows);
    expect(app.panes.single.agentId, 'a0');
  });

  test('a shared terminal stays attached when its other tab closes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final session = pane.session;
    final closing = app.activeSwarm;
    app.newSwarm(name: 'Shared work');
    await app.addAgentToSwarm('m', 'a0');
    final kept = app.activeSwarm;
    app.selectSwarm(closing.id);

    await app.closePane(pane.id);

    expect(app.swarms, [kept]);
    expect(app.panes.single, same(pane));
    expect(pane.session, same(session));
  });

  test('an owned viewer closes with the final terminal and is not restored as an empty terminal', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final closing = app.activeSwarm;
    closing.panes.add(
      TerminalPane(
        id: 900,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a0',
        url: 'http://fixture.invalid',
      ),
    );

    await app.closePane(pane.id);

    expect(app.swarms, isNot(contains(closing)));
    expect(app.allPanes, isEmpty);
    expect(app.reopenClosed(), isTrue);
    expect(app.panes.single.agentId, 'a0');
  });

  test(
    'closing one of several panes keeps the tab and its remaining work',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final first = app.adoptSessionForTest(terminal('a0', []));
      final second = app.adoptSessionForTest(terminal('a1', []));
      final tab = app.activeSwarm;

      await app.closePane(first.id);

      expect(app.swarms, [tab]);
      expect(app.panes, [second]);
      expect(app.closedHistory.single, isA<ClosedAgent>());
    },
  );

  test('an in-flight creation retains its destination after the old final pane closes', () async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final tab = app.activeSwarm;
    app.stateOf('m')!.nodeOnline = true;
    final creating = app.createAgent(
      'm',
      engine: 'codex',
      folder: '/tmp',
      swarmId: tab.id,
    );
    await Future<void>.delayed(Duration.zero);

    await app.closePane(pane.id);

    expect(app.swarms, [tab]);
    connection.creation.complete({'error': 'FIXTURE_FAILURE'});
    await creating;
  });

  group('the keyboard after the active tab closes', () {
    test('waits on the tab strip until the person goes into a pane', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final left = app.adoptSessionForTest(terminal('a0', []));
      final leftTab = app.activeSwarm;
      app.newSwarm(name: 'Closing');
      final closing = app.adoptSessionForTest(terminal('a1', []));
      app.newSwarm(name: 'Right');
      final right = app.adoptSessionForTest(terminal('a2', []));
      final extra = app.adoptSessionForTest(terminal('a3', []));
      final rightTab = app.activeSwarm;
      app.focusPane(right.id);
      app.selectSwarm(app.swarms[1].id);
      expect(app.tabStripFocused, isFalse);

      await app.closePane(closing.id);

      // The neighbour is selected and shown; no pane of it has the keys.
      expect(app.activeSwarm, same(rightTab));
      expect(app.focusedPane, same(right));
      expect(app.tabStripFocused, isTrue);
      expect(app.isPaneFocused(right.id), isFalse);
      expect(app.isPaneFocused(extra.id), isFalse);

      // ⏎ on the strip: the tab's focused pane takes the keyboard.
      final request = app.paneFocusRequest;
      app.focusFromTabStrip();
      expect(app.tabStripFocused, isFalse);
      expect(app.isPaneFocused(right.id), isTrue);
      expect(app.paneFocusRequest, request + 1);
      expect(app.paneFocusByUser, isTrue);

      // A focus-pane key goes into the grid at the pane already focused, not
      // one step past it.
      app.newSwarm(name: 'Second closing');
      final again = app.adoptSessionForTest(terminal('a4', []));
      await app.closePane(again.id);
      expect(app.tabStripFocused, isTrue);
      app.focusPaneHorizontally(1);
      expect(app.tabStripFocused, isFalse);
      expect(app.focusedPane, same(right));

      // A tab chosen is a tab to work in, as it always was.
      app.newSwarm(name: 'Third closing');
      final third = app.adoptSessionForTest(terminal('a5', []));
      await app.closePane(third.id);
      expect(app.tabStripFocused, isTrue);
      app.selectSwarm(leftTab.id);
      expect(app.tabStripFocused, isFalse);
      expect(app.isPaneFocused(left.id), isTrue);

      // A click in a tile of the tab.
      app.newSwarm(name: 'Fourth closing');
      final fourth = app.adoptSessionForTest(terminal('a6', []));
      await app.closePane(fourth.id);
      expect(app.tabStripFocused, isTrue);
      app.focusPane(app.focusedPaneId!);
      expect(app.tabStripFocused, isFalse);
    });

    test('closing the tab itself follows the same rule; a background tab, '
        'the Store or a pane with others beside it does not', () async {
      final app = createApp();
      addTearDown(app.dispose);
      final kept = app.adoptSessionForTest(terminal('a0', []));
      app.newSwarm(name: 'Background');
      app.adoptSessionForTest(terminal('a1', []));
      final background = app.activeSwarm;
      app.newSwarm(name: 'Working');
      final first = app.adoptSessionForTest(terminal('a2', []));
      final second = app.adoptSessionForTest(terminal('a3', []));
      final working = app.activeSwarm;

      await app.closePane(second.id);
      expect(app.activeSwarm, same(working));
      expect(app.tabStripFocused, isFalse, reason: 'Focus stays in the tab');
      expect(app.isPaneFocused(first.id), isTrue);

      await app.closeSwarm(background.id);
      expect(app.activeSwarm, same(working));
      expect(app.tabStripFocused, isFalse);
      expect(app.isPaneFocused(first.id), isTrue);

      // A tab with no work in it — the Store — goes back to work as before:
      // nothing was being typed into an agent there.
      app.openStore();
      expect(app.activeSwarm.isStore, isTrue);
      await app.closeSwarm(app.activeSwarmId);
      expect(app.activeSwarm, same(working));
      expect(app.tabStripFocused, isFalse);
      expect(app.isPaneFocused(first.id), isTrue);

      final requests = app.tabStripFocusRequest;
      await app.closeSwarm(working.id);
      expect(app.focusedPane, same(kept));
      expect(app.tabStripFocused, isTrue);
      expect(app.tabStripFocusRequest, requests + 1);
      expect(app.isPaneFocused(kept.id), isFalse);
    });

    test('the last tab closes into a fresh welcome, not onto the strip', () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.newSwarm(name: 'Closing');
      final closing = app.adoptSessionForTest(terminal('a1', []));
      await app.closePane(closing.id);
      expect(app.tabStripFocused, isTrue);

      // Still on the strip, the last pane closes too: the welcome is all there
      // is, and it keeps its own focus.
      await app.closePane(app.focusedPaneId!);
      expect(app.panes, isEmpty);
      expect(app.activeSwarm.isEmptyStarter, isTrue);
      expect(app.tabStripFocused, isFalse);
    });
  });

  // Every road that closes the active tab: its final pane (⌘⇧W, the pane's
  // close button, the native Close Pane menu, the viewer toggle on a tab that
  // holds only a viewer) or the tab itself (⌘W, the native tab strip).
  for (final native in [false, true]) {
    for (final road in [
      'pane shortcut',
      'pane close button',
      if (native) 'pane menu',
      if (native) 'viewer toggle',
      'tab shortcut',
      'tab strip close',
    ]) {
      testWidgets(
        'closing by $road leaves the keyboard on the tab strip until Enter '
        '(native=$native)',
        (tester) async {
          final calls = <MethodCall>[];
          final messenger = tester.binding.defaultBinaryMessenger;
          if (native) {
            messenger.setMockMethodCallHandler(nativeChannel, (call) async {
              calls.add(call);
              return null;
            });
          }
          addTearDown(
            () => messenger.setMockMethodCallHandler(nativeChannel, null),
          );
          final app = createApp();
          app.machineStates['m']!.nodeOnline = true;
          final keptInput = <TerminalBinaryFrame>[];
          final closedInput = <TerminalBinaryFrame>[];
          final kept = app.adoptSessionForTest(terminal('a0', keptInput));
          final keptTab = app.activeSwarm;
          app.newSwarm(name: 'Closing');
          final closingTab = app.activeSwarm;
          if (road == 'viewer toggle') {
            // A tab holding only a viewer, whose agent has a page to show.
            app.machineStates['m']!.agents = [...app.machineStates['m']!.agents]
              ..[1] = const Agent(
                id: 'a1',
                name: 'Agent 1',
                engine: 'codex',
                terminalAvailable: true,
                viewerUrl: 'http://127.0.0.1:4179/',
              );
            closingTab.panes.add(
              TerminalPane(
                id: 900,
                machineId: 'm',
                kind: PaneKind.web,
                ownerAgentId: 'a1',
                url: 'http://127.0.0.1:4179/',
              ),
            );
            closingTab.focusedPaneId = 900;
          } else {
            app.adoptSessionForTest(terminal('a1', closedInput));
          }
          await mount(tester, app, nativeTabs: native);

          switch (road) {
            case 'pane shortcut' when native:
              await nativeCommand(tester, 'keymapCommand', {
                'command': 'pane.close',
              });
            case 'pane shortcut':
              await chord(tester, LogicalKeyboardKey.keyW, shift: true);
            case 'pane close button':
              final mouse = await tester.createGesture(
                kind: PointerDeviceKind.mouse,
              );
              await mouse.addPointer(location: Offset.zero);
              await mouse.moveTo(
                tester.getCenter(
                  find.byKey(const ValueKey('terminal-pane-title')).first,
                ),
              );
              await tester.pump();
              final close = find.byType(PaneCloseButton).hitTestable();
              await mouse.moveTo(tester.getCenter(close));
              await tester.pump();
              await mouse.down(tester.getCenter(close));
              await mouse.up();
              await mouse.removePointer();
              await tester.pump();
            case 'pane menu':
              await nativeCommand(tester, 'closePane');
            case 'viewer toggle':
              await nativeCommand(tester, 'toggleViewer');
            case 'tab shortcut' when native:
              await nativeCommand(tester, 'keymapCommand', {
                'command': 'swarm.close',
              });
            case 'tab shortcut':
              await chord(tester, LogicalKeyboardKey.keyW);
            case 'tab strip close' when native:
              await nativeCommand(tester, 'close', {'id': closingTab.id});
            case 'tab strip close':
              final mouse = await tester.createGesture(
                kind: PointerDeviceKind.mouse,
              );
              await mouse.addPointer(location: const Offset(1200, 700));
              await mouse.moveTo(
                tester.getCenter(find.byKey(ValueKey(closingTab.id))),
              );
              await tester.pump();
              final close = find
                  .byKey(ValueKey('tab-close:${closingTab.id}'))
                  .hitTestable();
              await tester.tap(close);
              await mouse.removePointer();
              await tester.pump();
          }

          expect(app.swarms, [keptTab]);
          expect(app.focusedPane, same(kept), reason: 'The neighbour shows');
          expect(app.tabStripFocused, isTrue);
          expect(FocusManager.instance.primaryFocus?.debugLabel, 'Tab strip');
          expect(tester.testTextInput.hasAnyClients, isFalse);
          await keepTyping(tester);
          expect(keptInput, isEmpty, reason: 'No key reaches the neighbour');
          expect(closedInput, isEmpty);
          await tester.pump();
          if (native) {
            expect(lastUpdate(calls)['tabsFocused'], isTrue);
          } else {
            expect(
              stripTab(tester, keptTab.id).highlighted,
              isFalse,
              reason: 'Closing keeps the normal selected appearance',
            );
          }

          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          expect(app.tabStripFocused, isFalse);
          await keepTyping(tester);
          expect(typed(keptInput), arrowAndWord);
          expect(closedInput, isEmpty);
          await tester.pump();
          if (native) {
            expect(lastUpdate(calls)['tabsFocused'], isFalse);
          } else {
            expect(stripTab(tester, keptTab.id).highlighted, isFalse);
          }
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        },
      );
    }
  }

  testWidgets('a click in the terminal takes the keyboard from the strip', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    app.newSwarm(name: 'Closing');
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);
    expect(app.tabStripFocused, isTrue);

    await tester.tap(find.byType(TerminalView).hitTestable().first);
    await tester.pump();

    expect(app.tabStripFocused, isFalse);
    await keepTyping(tester);
    expect(typed(input), arrowAndWord);
    // Let the tap's double-tap window close before the tree goes.
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('a focus-pane key takes the keyboard from the strip', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final kept = app.adoptSessionForTest(terminal('a0', input));
    app.newSwarm(name: 'Closing');
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);
    expect(app.tabStripFocused, isTrue);

    await chord(tester, LogicalKeyboardKey.arrowLeft);

    expect(app.tabStripFocused, isFalse);
    expect(app.focusedPane, same(kept));
    await keepTyping(tester);
    expect(typed(input), arrowAndWord);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('a dialog closed over the strip gives the keyboard back to it', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    app.newSwarm(name: 'Closing');
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);
    expect(app.tabStripFocused, isTrue);

    await chord(tester, LogicalKeyboardKey.keyR, shift: true);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('tab-rename-input')), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('tab-rename-input')), findsNothing);
    expect(app.tabStripFocused, isTrue);
    expect(FocusManager.instance.primaryFocus?.debugLabel, 'Tab strip');
    await keepTyping(tester);
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('the last tab closing leaves the keyboard on the fresh welcome', (
    tester,
  ) async {
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = false);
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    app.newSwarm(name: 'Closing');
    app.adoptSessionForTest(terminal('a1', input));
    await mount(tester, app);

    // Closed twice in a row: the second close starts from the strip.
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);
    expect(app.tabStripFocused, isTrue);
    await chord(tester, LogicalKeyboardKey.keyW, shift: true);

    expect(app.panes, isEmpty);
    expect(find.byType(WorkspaceWelcome), findsOneWidget);
    expect(app.tabStripFocused, isFalse);
    final focus = FocusManager.instance.primaryFocus;
    expect(focus?.debugLabel, isNot('Tab strip'));
    expect(
      focus?.context?.findAncestorWidgetOfExactType<TerminalView>(),
      isNull,
    );
    expect(tester.testTextInput.hasAnyClients, isFalse);
    await keepTyping(tester);
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}

Future<void> nativeCommand(
  WidgetTester tester,
  String method, [
  Object? arguments,
]) async {
  // Tab actions reply after the frame that shows their result.
  var replied = false;
  final reply = native(tester, method, arguments).then((_) => replied = true);
  for (var frame = 0; frame < 5 && !replied; frame++) {
    await tester.pump();
  }
  await reply;
  await tester.pump();
}

/// What somebody still typing after the close sends: an arrow, and a word if
/// any terminal's text input is attached.
Future<void> keepTyping(WidgetTester tester) async {
  await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
  if (tester.testTextInput.hasAnyClients) {
    tester.testTextInput.enterText('next');
  }
  await tester.pump(const Duration(milliseconds: 10));
}

List<int> typed(List<TerminalBinaryFrame> input) =>
    input.expand((frame) => frame.bytes).toList();

final arrowAndWord = [27, 91, 68, ...utf8.encode('next')];

Map<Object?, Object?> lastUpdate(List<MethodCall> calls) =>
    calls.lastWhere((call) => call.method == 'update').arguments as Map;

DesktopWorkspaceTab stripTab(WidgetTester tester, String id) =>
    tester.widget<DesktopWorkspaceTab>(
      find.descendant(
        of: find.byKey(ValueKey(id)),
        matching: find.byType(DesktopWorkspaceTab),
      ),
    );
