// A harness's viewer tile: opened to the left of its agent's terminal when the
// agent's frame names a viewer, navigated when that URL changes, left closed
// once the person closes it, and taken down with the agent.

import 'dart:async';

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/core/runtime_platform.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_monitor_controller.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/web_pane_panel.dart';
import 'package:harness/widgets/pane_menu.dart';
import 'package:harness/widgets/transient_menus.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import 'support/fake_webview.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Map<String, dynamic> _frame(
  String id, {
  bool terminalAvailable = true,
  String? viewerUrl,
  String? viewerError,
  String? viewerName,
  Map<String, dynamic>? verdict,
  String dsh = 'autonomous/autonomous-circuit',
}) => {
  'id': id,
  'name': 'Agent $id',
  'engine': 'claude',
  'dsh': dsh,
  'dshName': 'Autonomous Circuit',
  'viewerUrl': ?viewerUrl,
  'viewerError': ?viewerError,
  'viewerName': ?viewerName,
  'verdict': ?verdict,
  'terminal': {
    'available': terminalAvailable,
    if (terminalAvailable)
      'runtimes': [
        {'backend': 'tmux', 'paneId': '%1'},
      ],
  },
};

Future<void> _synced(
  AppNotifier app,
  String id, {
  bool terminalAvailable = true,
  String? viewerUrl,
  String? viewerError,
  String? viewerName,
  Map<String, dynamic>? verdict,
  String? dsh,
}) => app.handleEventForTest('m', {
  'type': 'agent_synced',
  'payload': {
    'agent': _frame(
      id,
      terminalAvailable: terminalAvailable,
      viewerUrl: viewerUrl,
      viewerError: viewerError,
      viewerName: viewerName,
      verdict: verdict,
      dsh: dsh ?? 'autonomous/autonomous-circuit',
    ),
  },
});

List<TerminalPane> _viewers(AppNotifier app) =>
    app.panes.where((pane) => pane.isWeb).toList();

void main() {
  test('a transient terminal-unavailable sync retains the terminal pane until deletion', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(
      terminal('a0', <TerminalBinaryFrame>[]),
    );

    await _synced(app, 'a0', terminalAvailable: false);

    expect(app.panes, [pane]);
    expect(
      app
          .stateOf('m')!
          .agents
          .firstWhere((agent) => agent.id == 'a0')
          .terminalAvailable,
      isFalse,
    );

    await _synced(app, 'a0');
    expect(app.panes, [pane]);
    expect(
      app
          .stateOf('m')!
          .agents
          .firstWhere((agent) => agent.id == 'a0')
          .terminalAvailable,
      isTrue,
    );

    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'agentId': 'a0',
      'payload': {'agentId': 'a0'},
    });
    expect(app.panes, isEmpty);
  });

  testWidgets(
    'remote viewer update guidance can be dismissed and recovers to a forwarded URL',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', <TerminalBinaryFrame>[]));
      await mount(tester, app);
      const error = 'Update Harness on the remote machine to show its viewer.';
      await _synced(app, 'a0', viewerError: error);
      await tester.pump();
      expect(find.text(error), findsOneWidget);
      expect(_viewers(app).single.url, isNull);
      await app.closePane(_viewers(app).single.id);
      await _synced(app, 'a0', viewerError: error);
      expect(_viewers(app), isEmpty);
      await app.toggleViewerPane('m', 'a0');
      expect(_viewers(app).single.viewerError, error);
      await _synced(
        app,
        'a0',
        viewerUrl: 'http://127.0.0.1:4180/__harness_viewer/token?path=%2F',
      );
      await tester.pump();
      expect(find.text(error), findsNothing);
      expect(_viewers(app).single.viewerError, isNull);
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
    },
  );

  test('a viewer opens to the left of its agent and follows the URL', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final first = app.adoptSessionForTest(terminal('a0', input));
    final second = app.adoptSessionForTest(terminal('a1', input));
    app.focusPane(first.id);

    // A frame with no viewer opens nothing.
    await _synced(app, 'a0');
    expect(_viewers(app), isEmpty);

    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    expect(viewer.ownerAgentId, 'a0');
    expect(viewer.agentId, isNull, reason: 'a viewer is not the agent\'s tile');
    expect(viewer.url, 'http://127.0.0.1:4179/');
    expect(app.panes.map((p) => p.id), [viewer.id, first.id, second.id]);
    expect(app.focusedPaneId, first.id, reason: 'never steals focus');
    expect(
      app.activeSwarm.paneSizes['2:manual'],
      isNull,
      reason: 'three tiles: the grid decides, not the harness split',
    );

    // The same URL again is nothing new; a different one navigates in place.
    var updates = 0;
    app.addListener(() => updates++);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app).single.id, viewer.id);
    expect(
      updates,
      0,
      reason: 'an unchanged viewer must not repaint the workspace',
    );
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/?file=a.step');
    expect(_viewers(app).single.id, viewer.id);
    expect(_viewers(app).single.url, 'http://127.0.0.1:4179/?file=a.step');
    expect(app.panes.length, 3);

    // A frame that drops the viewer takes the tile down.
    await _synced(app, 'a0');
    expect(_viewers(app), isEmpty);
    expect(app.panes.map((p) => p.id), [first.id, second.id]);
  });

  test('alone with its terminal, the viewer takes 70 percent', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final terminalPane = app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    expect(app.panes.map((p) => p.id), [viewer.id, terminalPane.id]);
    final split = app.activeSwarm.paneSizes['2:manual'];
    expect(split, isNotNull);
    expect(split!.tiles.map((t) => t.left), [0, .7]);
    expect(split.tiles.map((t) => t.right), [.7, 1]);
    expect(split.tiles.map((t) => t.height), [1, 1]);
    // The viewer going away takes the pair's layout with it, the way any
    // removal does; a new viewer starts the split afresh.
    await _synced(app, 'a0');
    expect(app.activeSwarm.paneSizes['2:manual'], isNull);
    expect(app.panes.map((p) => p.id), [terminalPane.id]);
  });

  test('a pair the user sized by hand keeps its sizes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final theirs = PaneArrangement(const [
      Rect.fromLTRB(0, 0, 0.5, 1),
      Rect.fromLTRB(0.5, 0, 1, 1),
    ]);
    app.activeSwarm.savePaneSizes('2:manual', theirs);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    expect(app.activeSwarm.paneSizes['2:manual'], same(theirs));
  });

  test(
    'the viewer is beside the terminal in every tab that shows it',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final input = <TerminalBinaryFrame>[];
      final first = app.adoptSessionForTest(terminal('a0', input));
      final one = app.activeSwarm;
      app.newSwarm(name: 'Second');
      final second = app.adoptSessionForTest(terminal('a0', input));
      final two = app.activeSwarm;
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      expect(app.allPanes.where((p) => p.isWeb), hasLength(2));
      expect(one.panes.map((p) => p.isWeb), [true, false]);
      expect(two.panes.map((p) => p.isWeb), [true, false]);
      expect(one.panes.last, same(first));
      expect(two.panes.last, same(second));
      // A tab that loses the terminal loses the viewer on the next frame; the
      // other tab keeps its pair.
      two.remove(second);
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      expect(two.panes, isEmpty);
      expect(one.panes.map((p) => p.isWeb), [true, false]);
    },
  );

  test('closing the terminal by hand takes its viewer with it', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final terminalPane = app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    await app.closePane(terminalPane.id);
    expect(app.panes, isEmpty);
    // Not a dismissal: the next open of the agent brings the viewer back.
    app.adoptSessionForTest(terminal('a0', input));
    var updates = 0;
    app.addListener(() => updates++);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    expect(
      updates,
      greaterThan(0),
      reason: 'restoring a viewer is a visible change',
    );
  });

  test('the header control hides the viewer and brings it back', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.viewerPaneShown('m', 'a0'), isTrue);
    await app.toggleViewerPane('m', 'a0');
    expect(app.viewerPaneShown('m', 'a0'), isFalse);
    // Hidden is a dismissal: the same page does not creep back on a frame.
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.viewerPaneShown('m', 'a0'), isFalse);
    await app.toggleViewerPane('m', 'a0');
    expect(app.viewerPaneShown('m', 'a0'), isTrue);
    expect(app.panes.map((p) => p.isWeb), [true, false]);
  });

  test('a viewer closed by hand stays closed until the URL changes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    await app.closePane(viewer.id);
    expect(_viewers(app), isEmpty);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), isEmpty, reason: 'the same page does not pop back');
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4180/');
    expect(_viewers(app).single.url, 'http://127.0.0.1:4180/');
  });

  test('a viewer is never persisted, and goes with its agent', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    final saved = app.activeSwarm.toJson();
    expect((saved['panes'] as List).length, 1);
    expect(saved.toString(), isNot(contains('4179')));

    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'agentId': 'a0',
      'payload': {'agentId': 'a0'},
    });
    expect(app.panes, isEmpty);
  });

  test('a viewer waits for a terminal tile to hang beside', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.panes, isEmpty, reason: 'no terminal on any desk');
    await app.addAgentToSwarm('m', 'a0');
    expect(app.panes.map((p) => p.isWeb), [true, false]);
  });

  testWidgets(
    'Linux viewer hides beneath dialogs and returns after dismissal',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', <TerminalBinaryFrame>[]));
      await mount(tester, app);
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      await tester.pump();
      final context = tester.element(find.byType(WebPanePanel));
      final placeholder = find.byKey(const ValueKey('web-pane-placeholder'));
      expect(placeholder, findsOneWidget);
      final dialog = showDialog<void>(
        context: context,
        builder: (_) => const AlertDialog(title: Text('Close tab?')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Close tab?'), findsOneWidget);
      if (RuntimePlatform.isLinux) {
        expect(placeholder, findsNothing);
        expect(
          find.byKey(
            const ValueKey('web-pane-placeholder'),
            skipOffstage: false,
          ),
          findsNothing,
        );
      }
      Navigator.of(tester.element(find.text('Close tab?'))).pop();
      await dialog;
      await tester.pumpAndSettle();
      expect(placeholder, findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the tile renders a header and, under test, the URL in words', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await mount(tester, app);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    await tester.pump();
    expect(WebPanePanel.webviewAvailable, isFalse);
    expect(find.byType(WebPanePanel), findsOneWidget);
    if (RuntimePlatform.isLinux) {
      // The native GTK overlay hides itself under any rounded ancestor clip.
      expect(
        find.ancestor(
          of: find.byType(WebPanePanel),
          matching: find.byType(ClipRRect),
        ),
        findsNothing,
      );
      expect(
        find.ancestor(
          of: find.byType(WebPanePanel),
          matching: find.byType(ClipRect),
        ),
        findsWidgets,
      );
    }

    expect(find.byKey(const ValueKey('web-pane-placeholder')), findsOneWidget);
    expect(find.textContaining('http://127.0.0.1:4179/'), findsOneWidget);
    // With no embedded webview the page opens in the browser instead
    // (openharness#108 — a Linux desktop, or WSLg, has none today).
    final opened = <Uri>[];
    final previousOpener = browserOpener;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => browserOpener = previousOpener);
    await tester.tap(find.byKey(const ValueKey('web-pane-open-in-browser')));
    await tester.pump();
    expect(opened, [Uri.parse('http://127.0.0.1:4179/')]);
    // Its own close control, and no way to end an agent from it.
    final closeViewer = find.byTooltip(RegExp(r'^Close viewer(?: · .+)?$'));
    expect(closeViewer, findsOneWidget);
    // Stop remains a command, not a pane-header control. Viewer visibility
    // is also available through View and command search.
    expect(find.byTooltip('Stop Harness'), findsNothing);
    expect(
      find.descendant(
        of: find.byType(WebPanePanel),
        matching: find.byTooltip('Stop Harness'),
      ),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('pane-status')), findsNothing);
    await _synced(
      app,
      'a0',
      viewerUrl: 'http://127.0.0.1:4179/',
      verdict: {
        'ready': false,
        'warnings': 1,
        'phases': [
          {'name': 'Build', 'state': 'done'},
          {'name': 'Checks', 'state': 'active'},
        ],
      },
    );
    await tester.pump();
    // One status in the viewer's title, and nothing on the terminal's: the
    // phase under way here, since the deck is neither ready nor failing.
    final viewerHeader = find.ancestor(
      of: closeViewer,
      matching: find.byType(WebPanePanel),
    );
    expect(
      find.descendant(
        of: viewerHeader,
        matching: find.byKey(const ValueKey('pane-status')),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('pane-status')), findsOneWidget);
    expect(find.text('Checks'), findsOneWidget);
    expect(find.text('Build'), findsNothing);
    expect(find.text('1 warning'), findsNothing, reason: 'the phase wins');
    expect(find.textContaining('·  Viewer'), findsNothing);
    await tester.tap(closeViewer);
    await tester.pumpAndSettle();
    expect(_viewers(app), isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'the viewer is called what it is, not the harness again — the harness name moves to the tooltip',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      await mount(tester, app);
      await _synced(
        app,
        'a0',
        viewerUrl: 'http://127.0.0.1:4179/',
        viewerName: '3D Viewer',
      );
      await tester.pump();
      final header = find.byType(WebPanePanel);
      expect(
        find.descendant(of: header, matching: find.text('3D Viewer')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: header, matching: find.text('Agent a0')),
        findsNothing,
      );
      expect(
        find.descendant(
          of: header,
          matching: find.byTooltip('Agent a0\nhttp://127.0.0.1:4179/'),
        ),
        findsOneWidget,
      );
      // A daemon that predates viewerName: the harness's name and Viewer.
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      await tester.pump();
      expect(
        find.descendant(
          of: header,
          matching: find.text('Autonomous Circuit Viewer'),
        ),
        findsOneWidget,
      );
      // Let the terminal's batched resize run out.
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  testWidgets(
    'a working agent\'s viewer says Working, keeps the last check for its tooltip, and goes back when the turn ends',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      await mount(tester, app);
      await _synced(
        app,
        'a0',
        viewerUrl: 'http://127.0.0.1:4179/',
        verdict: {'ready': true, 'summary': 'deck.pdf · 5 slides'},
      );
      await tester.pump();
      final status = find.byKey(const ValueKey('pane-status'));
      expect(
        find.descendant(of: status, matching: find.text('Ready')),
        findsOneWidget,
      );

      Future<void> turn(String type) => app.handleEventForTest('m', {
        'type': type,
        'agentId': 'a0',
        'payload': {'agentId': 'a0'},
      });
      await turn('turn_started');
      await tester.pump();
      expect(
        find.descendant(of: status, matching: find.text('Working')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: status, matching: find.text('Ready')),
        findsNothing,
      );
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is Tooltip &&
              widget.message ==
                  'The agent is working · last check: deck.pdf · 5 slides',
        ),
        findsOneWidget,
      );

      await turn('turn_ended');
      await tester.pump();
      expect(
        find.descendant(of: status, matching: find.text('Ready')),
        findsOneWidget,
      );
      // Let the tile's working ring wind down.
      await tester.pump(const Duration(milliseconds: 300));
      expect(tester.takeException(), isNull);
    },
  );

  group('with a webview', () {
    late FakeWebViewPlatform platform;
    setUp(() {
      final previous = WebViewPlatform.instance;
      platform = FakeWebViewPlatform();
      WebViewPlatform.instance = platform;
      WebPanePanel.webviewAvailableForTest = true;
      addTearDown(() {
        WebPanePanel.webviewAvailableForTest = null;
        if (previous != null) WebViewPlatform.instance = previous;
      });
    });

    Future<AppNotifier> open(
      WidgetTester tester, {
      String? dsh,
      String url = 'http://127.0.0.1:4179/',
    }) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.stateOf('m')!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', <TerminalBinaryFrame>[]));
      await mount(tester, app);
      await _synced(app, 'a0', viewerUrl: url, dsh: dsh);
      await tester.pump();
      return app;
    }

    testWidgets('Linux pane menu detaches the viewer and restores its page', (
      tester,
    ) async {
      await open(tester);
      final controller = platform.controllers.single;
      controller.delegate!.onPageFinished!(controller.loads.single.toString());
      await tester.pump();
      final initialLoads = controller.loads.length;
      final context = tester.element(find.byType(WebPanePanel));
      final menu = showPaneMenu<String>(
        context: context,
        position: const RelativeRect.fromLTRB(20, 100, 20, 0),
        children: (close) => [
          paneMenuItem(
            onTap: () => close('keep'),
            child: const Text('Keep viewer open'),
          ),
        ],
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('pane-menu-surface')), findsOneWidget);
      expect(transientMenusVisible.value, isTrue);
      if (RuntimePlatform.isLinux) {
        expect(find.byKey(const ValueKey('fake-webview')), findsNothing);
      }
      await tester.tap(find.text('Keep viewer open'));
      expect(await menu, 'keep');
      await tester.pumpAndSettle();
      expect(transientMenusVisible.value, isFalse);
      expect(find.byKey(const ValueKey('fake-webview')), findsOneWidget);
      expect(platform.controllers, [controller]);
      expect(controller.loads, hasLength(initialLoads));
      expect(tester.takeException(), isNull);
    });

    testWidgets('Linux dialogs and routes preserve the loaded controller', (
      tester,
    ) async {
      await open(tester);
      final controller = platform.controllers.single;
      controller.delegate!.onPageFinished!(controller.loads.single.toString());
      await tester.pump();
      final initialLoads = controller.loads.length;
      final context = tester.element(find.byType(WebPanePanel));
      final navigator = Navigator.of(context);
      final dialog = showDialog<void>(
        context: context,
        builder: (_) => const AlertDialog(title: Text('Close tab?')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Close tab?'), findsOneWidget);
      if (RuntimePlatform.isLinux) {
        expect(find.byKey(const ValueKey('fake-webview')), findsNothing);
      }
      navigator.pop();
      await dialog;
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('fake-webview')), findsOneWidget);
      final route = navigator.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Other page')),
        ),
      );
      await tester.pumpAndSettle();
      navigator.pop();
      await route;
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('fake-webview')), findsOneWidget);
      expect(platform.controllers, [controller]);
      expect(controller.loads, hasLength(initialLoads));
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'Harness Monitor loads its page once, though the tile rebuilds while its channel is added',
      (tester) async {
        final gate = platform.channelGate = Completer<void>();
        final app = await open(tester, dsh: harnessMonitorId);
        final controller = platform.controllers.single;
        // The workspace repaints before the native channel call returns.
        app.notifyListeners();
        await tester.pump();
        gate.complete();
        await tester.pump();

        // A second load cancelled the first (-999), and that read as a failed viewer load.
        expect(controller.loads, [Uri.parse('http://127.0.0.1:4179/')]);
        // Let the terminal's batched resize run out.
        await tester.pump(const Duration(milliseconds: 300));
      },
    );

    testWidgets(
      'Harness Monitor is told when it is out of sight, so its page stops reading the fleet',
      (tester) async {
        final app = await open(tester, dsh: harnessMonitorId);
        final controller = platform.controllers.single;
        const url = 'http://127.0.0.1:4179/';
        controller.delegate!
          ..onPageStarted!(url)
          ..onPageFinished!(url);
        await tester.pump();
        // What the page last heard: `data-host-visible` on its root, then the event it listens for.
        bool? told() {
          for (final script in controller.scripts.reversed) {
            final match = RegExp(
              r"dataset\.hostVisible='(true|false)';document\.dispatchEvent\(new Event\('harness-host-visibility'\)\)",
            ).firstMatch(script);
            if (match != null) return match[1] == 'true';
          }
          return null;
        }

        expect(told(), isTrue, reason: 'a page that loads in front is told so');
        final monitorTab = app.activeSwarm.id;

        app.newSwarm(name: 'Other');
        await tester.pump();
        expect(told(), isFalse, reason: 'another tab in front');

        app.selectSwarm(monitorTab);
        await tester.pump();
        expect(told(), isTrue);

        app.appLifecycleChanged(AppLifecycleState.inactive);
        await tester.pump();
        expect(
          told(),
          isTrue,
          reason: 'a window behind another app can still be seen',
        );
        app.appLifecycleChanged(AppLifecycleState.hidden);
        await tester.pump();
        expect(told(), isFalse, reason: 'a minimised or hidden window cannot');
        app.appLifecycleChanged(AppLifecycleState.resumed);
        await tester.pump();
        expect(told(), isTrue);

        final stamps = controller.scripts.length;
        app.notifyListeners();
        await tester.pump();
        expect(
          controller.scripts,
          hasLength(stamps),
          reason: 'nothing new to say, nothing said',
        );

        // A reload is a new page: it hears where it stands.
        controller.delegate!
          ..onPageStarted!(url)
          ..onPageFinished!(url);
        await tester.pump();
        expect(controller.scripts.length, greaterThan(stamps));
        expect(told(), isTrue);
        await tester.pump(const Duration(milliseconds: 300));
      },
    );

    testWidgets(
      "closing the Monitor's tab takes its page down, and with it the page's connection",
      (tester) async {
        final app = await open(tester, dsh: harnessMonitorId);
        expect(find.byKey(const ValueKey('fake-webview')), findsOneWidget);
        final tab = app.activeSwarm;
        unawaited(app.requestCloseSwarm(tab.id));
        await tester.pumpAndSettle();
        expect(app.swarms, isNot(contains(tab)));
        expect(find.byType(WebPanePanel), findsNothing);
        expect(find.byKey(const ValueKey('fake-webview')), findsNothing);
        expect(
          app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').isStopped,
          isFalse,
          reason: 'its assistant stays for the next open',
        );
      },
    );

    testWidgets('a viewer other than the Monitor is not told anything', (
      tester,
    ) async {
      final app = await open(tester);
      final controller = platform.controllers.single;
      const url = 'http://127.0.0.1:4179/';
      controller.delegate!
        ..onPageStarted!(url)
        ..onPageFinished!(url);
      await tester.pump();
      app.newSwarm(name: 'Other');
      await tester.pump();
      expect(
        controller.scripts.where((s) => s.contains('hostVisible')),
        isEmpty,
      );
      await tester.pump(const Duration(milliseconds: 300));
    });

    testWidgets(
      'a viewer that refuses is tried again by itself; a cancelled navigation shows nothing',
      (tester) async {
        await open(tester);
        final controller = platform.controllers.single;
        final delegate = controller.delegate!;
        const url = 'http://127.0.0.1:4179/';
        expect(controller.loads, [Uri.parse(url)]);

        delegate.onPageStarted!(url);
        delegate.onWebResourceError!(
          const WebResourceError(
            errorCode: -999,
            description: 'cancelled',
            isForMainFrame: true,
            url: url,
          ),
        );
        await tester.pump();
        expect(find.byKey(const ValueKey('web-pane-waiting')), findsNothing);

        delegate.onWebResourceError!(
          const WebResourceError(
            errorCode: -1004,
            description: 'Could not connect to the server.',
            isForMainFrame: true,
            url: url,
          ),
        );
        await tester.pump();
        expect(find.byKey(const ValueKey('web-pane-waiting')), findsOneWidget);
        expect(find.text('Could not connect to the server.'), findsOneWidget);

        await tester.pump(const Duration(seconds: 1));
        expect(controller.loads, [Uri.parse(url), Uri.parse(url)]);

        delegate.onPageStarted!(url);
        delegate.onPageFinished!(url);
        await tester.pump();
        expect(find.byKey(const ValueKey('web-pane-waiting')), findsNothing);
        await tester.pump(const Duration(milliseconds: 300));
      },
    );

    testWidgets(
      "Reload loads the pane's address, never the webview's own reload",
      (tester) async {
        await open(tester);
        final controller = platform.controllers.single;
        const url = 'http://127.0.0.1:4179/';
        controller.delegate!
          ..onPageStarted!(url)
          ..onPageFinished!(url);
        await tester.pump();

        await tester.tap(find.byTooltip(RegExp(r'^Reload viewer(?: · .+)?$')));
        await tester.pump();

        expect(controller.reloads, 0);
        expect(controller.loads, [Uri.parse(url), Uri.parse(url)]);
        await tester.pump(const Duration(milliseconds: 300));
      },
    );
  });
}
