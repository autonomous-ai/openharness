// An agent's Browser in a tile of its own, left of the agent's terminal: opened
// from the terminal's header or the command palette, closed from its own ×,
// moved and closed with the terminal, and brought back after a restart while
// the browser is on. Never in the saved layout, as no viewer is.

import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/agent_drag.dart' show PaneCloseButton;

import '../swarm_interactions_test.dart' show chord;
import '../swarm_screen_test.dart' show mount, terminal;
import '../swarm_state_test.dart' show MemoryStore, createApp;

/// What Browser does not run on: Windows Desktop offers none (spec § Desktop).
final _windows = Platform.isWindows ? 'Browser does not run on Windows' : null;

Finder _key(String key) => find.byKey(ValueKey(key));

/// [agentId]'s frame, as its machine sends it: its browser [browser], or off.
Future<void> _frame(
  AppNotifier app,
  String agentId, {
  Map<String, Object?>? browser,
  String status = 'active',
}) => app.handleEventForTest('m', {
  'type': 'agent_synced',
  'payload': {
    'agent': {
      'id': agentId,
      'name': 'Agent $agentId',
      'engine': 'codex',
      'status': status,
      'terminal': {
        'available': true,
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
      'browser': ?browser,
    },
  },
});

/// The viewers [agentId] has in [tab]: its Browser tile, here.
List<TerminalPane> _viewers(Swarm tab, String agentId) => [
  for (final pane in tab.panes)
    if (pane.isViewer && pane.ownerAgentId == agentId) pane,
];

/// The Browser button in [pane]'s header.
Finder _button(TerminalPane pane) => find.descendant(
  of: _key('pane-frame:${pane.id}'),
  matching: _key('swarm-browser-button'),
);

/// The Browser tile on screen.
Finder get _tile => _key('swarm-browser-panel');

/// The workspace, wide enough that a terminal beside a tile at 70% keeps its
/// 40 columns in the test font, so the terminal stays in the window.
Future<void> _show(WidgetTester tester, AppNotifier app) async {
  await mount(tester, app);
  tester.view.physicalSize = const Size(2400, 900);
  await tester.pump();
}

/// Lets the terminal's last resize go out, then takes the workspace down.
Future<void> _end(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pumpWidget(const SizedBox());
}

void main() {
  testWidgets(
    'the terminal\'s Browser button opens the agent\'s Browser left of it, '
    'and closes it; the tile\'s × closes it too',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final chat = app.adoptSessionForTest(terminal('a0', []));
      await _show(tester, app);
      expect(_tile, findsNothing);
      // In the header, just before the pane's ×.
      expect(
        tester.getRect(_button(chat)).right,
        lessThanOrEqualTo(
          tester
              .getRect(
                find.descendant(
                  of: _key('pane-frame:${chat.id}'),
                  matching: find.byType(PaneCloseButton),
                ),
              )
              .left,
        ),
      );

      await tester.tap(_button(chat));
      await tester.pump();
      await tester.pump();
      expect(_tile, findsOneWidget);
      // Left of its terminal, as every viewer sits, and off until its Start.
      expect(
        tester.getRect(_tile).right,
        lessThanOrEqualTo(tester.getRect(_key('pane-frame:${chat.id}')).left),
      );
      expect(find.text('A sandboxed Chrome the agent drives'), findsOneWidget);
      expect(_viewers(app.activeSwarm, 'a0'), hasLength(1));
      // The button says its tile is open.
      expect(
        tester.getSemantics(_button(chat)),
        isSemantics(isSelected: true, label: 'Browser'),
      );

      await tester.tap(_button(chat));
      await tester.pump();
      await tester.pump();
      expect(_tile, findsNothing);
      expect(_viewers(app.activeSwarm, 'a0'), isEmpty);

      await tester.tap(_button(chat));
      await tester.pump();
      await tester.pump();
      expect(_tile, findsOneWidget);
      await tester.tap(_key('swarm-browser-close'));
      await tester.pump();
      await tester.pump();
      expect(_tile, findsNothing);
      expect(app.activeSwarm.panes, [chat]);
      await _end(tester);
      semantics.dispose();
    },
    skip: _windows != null,
  );

  testWidgets('⇧⌘P Toggle Browser opens and closes the focused agent\'s '
      'Browser', (tester) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    await _show(tester, app);

    Future<void> toggle() async {
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(_key('swarm-search-input'), '> toggle browser');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
    }

    await toggle();
    expect(_tile, findsOneWidget);
    expect(_viewers(app.activeSwarm, 'a0'), hasLength(1));
    expect(app.activeSwarm.panes.last, chat);
    await toggle();
    expect(_tile, findsNothing);
    expect(app.activeSwarm.panes, [chat]);
    await _end(tester);
  }, skip: _windows != null);

  testWidgets('the tile moves to another tab with its terminal, and closes '
      'with it; it is never in the saved layout', (tester) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    final first = app.activeSwarm;
    await _show(tester, app);
    await tester.tap(_button(chat));
    await tester.pump();
    expect(_viewers(first, 'a0'), hasLength(1));
    expect(first.toJson()['panes'], hasLength(1));

    app.newSwarm();
    final second = app.activeSwarm;
    expect(
      app.movePaneToSwarm(chat.id, second.id, sourceSwarmId: first.id),
      isTrue,
    );
    await tester.pump();
    await tester.pump();
    expect(_viewers(first, 'a0'), isEmpty);
    expect(_viewers(second, 'a0'), hasLength(1));
    expect(second.panes, contains(chat));
    expect(_tile, findsOneWidget);

    await app.closePane(chat.id, swarmId: second.id);
    await tester.pump();
    await tester.pump();
    expect(app.allPanes.where((pane) => pane.ownerAgentId == 'a0'), isEmpty);
    expect(_tile, findsNothing);
    await _end(tester);
  }, skip: _windows != null);

  testWidgets('no Browser for a machine shared with this account, a stopped '
      'agent or a plain terminal', (tester) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    await _show(tester, app);
    expect(_button(chat), findsOneWidget, reason: 'its own running agent');

    await _frame(app, 'a0', status: 'stopped');
    await tester.pump();
    expect(_button(chat), findsNothing, reason: 'a stopped agent');

    await _frame(app, 'a0');
    await tester.pump();
    expect(_button(chat), findsOneWidget);

    app.machineStates['m']!.agents = [
      const Agent(
        id: 'a0',
        name: 'Agent a0',
        engine: 'terminal',
        terminalAvailable: true,
      ),
    ];
    app.notifyListeners();
    await tester.pump();
    expect(_button(chat), findsNothing, reason: 'a shell has no agent');

    const shared = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Test host',
      machineShare: MachineShare(
        ownerName: 'Ken',
        ownerEmail: 'ken@example.com',
        via: 'email',
        added: true,
      ),
    );
    app.machines = [shared];
    app.machineStates['m'] = MachineState(shared)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = const [
        Agent(
          id: 'a0',
          name: 'Agent a0',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
    app.notifyListeners();
    await tester.pump();
    expect(_button(chat), findsNothing, reason: 'another person\'s machine');
    await _end(tester);
  }, skip: _windows != null);

  testWidgets('another computer\'s agent sets up its Browser there', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    await _show(tester, app);
    await _frame(
      app,
      'a0',
      browser: {'state': 'failed', 'error': 'needs_setup'},
    );
    await tester.pump();
    await tester.pump();
    expect(_tile, findsOneWidget);
    expect(find.text('Set up Browser on Test host first'), findsOneWidget);
    expect(find.text('Install'), findsNothing);
    expect(_button(chat), findsOneWidget);
    await _end(tester);
  }, skip: _windows != null);

  // The globe made a 600-point window's header overflow its status chip.
  testWidgets('a narrow pane with a status fits the globe in its header', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    for (final width in [600.0, 640.0, 720.0]) {
      tester.view.physicalSize = Size(width, 700);
      await tester.pump();
      expect(_button(chat), findsOneWidget, reason: '$width');
      expect(tester.takeException(), isNull, reason: '$width');
    }
    await _end(tester);
  }, skip: _windows != null);

  testWidgets('Windows offers no Browser', (tester) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final chat = app.adoptSessionForTest(terminal('a0', []));
    await _show(tester, app);
    await _frame(app, 'a0', browser: {'state': 'ready'});
    await tester.pump();
    expect(_button(chat), findsNothing);
    expect(_viewers(app.activeSwarm, 'a0'), isEmpty);
    await _end(tester);
  }, skip: _windows == null);

  group('the restart rule', () {
    /// A window opening on a saved tab that shows a0 and a1, as a restart does.
    Future<AppNotifier> restart() async {
      final storage = MemoryStore();
      await PaneLayoutStore(storage: storage).saveSwarms([
        Swarm(id: 'work', name: 'Work')
          ..panes.addAll([
            TerminalPane(id: 1, machineId: 'm', agentId: 'a0'),
            TerminalPane(id: 2, machineId: 'm', agentId: 'a1'),
          ]),
      ], 'work');
      final app = createApp(store: storage, connected: true);
      addTearDown(app.dispose);
      await app.restorePaneLayoutForTest();
      return app;
    }

    test('a browser that is on brings its tile back beside its terminal; '
        'one that is off does not', () async {
      final app = await restart();
      final tab = app.activeSwarm;
      expect(tab.panes.map((pane) => pane.agentId), ['a0', 'a1']);
      await _frame(app, 'a0', browser: {'state': 'ready'});
      await _frame(app, 'a1');
      expect(_viewers(tab, 'a1'), isEmpty);
      expect(_viewers(tab, 'a0'), hasLength(1), reason: 'its browser is on');
      final browser = _viewers(tab, 'a0').single;
      expect(
        tab.panes.indexOf(browser) + 1,
        tab.panes.indexWhere((pane) => pane.agentId == 'a0'),
        reason: 'left of its terminal',
      );
      expect(
        tab.toJson()['panes'],
        hasLength(2),
        reason: 'viewers are unsaved',
      );

      // Its Stop turns the browser off and leaves the tile open, on Start.
      await _frame(app, 'a0');
      expect(_viewers(tab, 'a0'), [browser]);
    }, skip: _windows);

    test('a tile closed while its browser runs stays closed until the '
        'browser starts again', () async {
      final app = await restart();
      final tab = app.activeSwarm;
      await _frame(app, 'a0', browser: {'state': 'ready'});
      expect(_viewers(tab, 'a0'), hasLength(1));
      await app.closePane(_viewers(tab, 'a0').single.id);
      await _frame(app, 'a0', browser: {'state': 'ready'});
      expect(_viewers(tab, 'a0'), isEmpty, reason: 'closed by hand');
      // Its agent stopped, its browser with it; running again, it starts too.
      await _frame(app, 'a0', status: 'stopped');
      await _frame(app, 'a0', browser: {'state': 'starting'});
      expect(_viewers(tab, 'a0'), hasLength(1));
    }, skip: _windows);

    test('a stopped agent takes its tile down, and brings it back when it '
        'runs again', () async {
      final app = await restart();
      final tab = app.activeSwarm;
      await _frame(app, 'a1', browser: {'state': 'ready'});
      expect(_viewers(tab, 'a1'), hasLength(1));
      await _frame(app, 'a1', status: 'stopped');
      expect(_viewers(tab, 'a1'), isEmpty);
      await _frame(app, 'a1', browser: {'state': 'starting'});
      expect(_viewers(tab, 'a1'), hasLength(1));
    }, skip: _windows);
  });
}
