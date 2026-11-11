import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';

import '../support/swarm_v4_data.dart';
import '../swarm_state_test.dart' show createApp;

/// An agent chat's Browser button (Swarm v4, Mockup 3): after Terminal, for every running agent on one of the person's own
/// machines, and one pane at a time with Info, Instructions and Terminal.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  var terminalOpen = false;

  /// This computer's view of `host`, where lampOS's agents run, with `second`'s browser as [browser], and `second` in
  /// [status], or not listed at all.
  AppNotifier app({
    AgentBrowser? browser,
    bool shared = false,
    String status = 'active',
    bool listed = true,
  }) {
    final app = createApp(connected: true);
    final machine = Machine(
      machineId: 'host',
      authMode: MachineAuthMode.remote,
      name: 'Mac Studio',
      status: 'online',
      machineShare: shared
          ? const MachineShare(
              ownerName: 'Dee',
              ownerEmail: 'dee@example.com',
              via: 'email',
              added: true,
            )
          : null,
    );
    app.machines = [machine];
    app.machineStates['host'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        if (listed)
          Agent(
            id: 'session-second',
            name: 'second',
            engine: 'claude',
            status: status,
            browser: browser,
          ),
      ];
    return app;
  }

  Future<void> show(WidgetTester tester, AppNotifier app) async {
    addTearDown(app.dispose);
    terminalOpen = false;
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = swarmV4Server();
    final controller = server.controller(
      account: 'owner',
      initial: {
        'tabId': 'tab',
        'accountId': 'owner',
        'selectedId': 'agent-chat-second',
      },
    );
    addTearDown(controller.dispose);
    await tester.runAsync(controller.refresh);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, set) => SuperTabView(
              controller: controller,
              app: app,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: swarmV4GitHub(),
              instructions: SwarmV4Computer().link,
              terminal: terminalOpen
                  ? const Center(child: Text('Terminal fixture'))
                  : null,
              onOpenGroupTerminals: () => set(() => terminalOpen = true),
              onCloseTerminal: () => set(() => terminalOpen = false),
            ),
          ),
        ),
      ),
    );
    await settle(tester);
  }

  Future<void> tap(WidgetTester tester, String k) async {
    await tester.tap(key(k));
    await settle(tester);
  }

  // The web build and Windows Desktop draw none either: `browserOffered`, in browser_requests_test.dart.
  testWidgets('every running agent on the person\'s own machines shows '
      'Browser, with or without a browser; a machine shared with them, a '
      'stopped agent and one the machine does not list show none', (
    tester,
  ) async {
    for (final browser in [null, const AgentBrowser(state: 'ready')]) {
      await show(tester, app(browser: browser));
      expect(key('swarm-browser-button'), findsOneWidget);
      expect(find.byTooltip('Browser'), findsOneWidget);
      // After Terminal.
      expect(
        tester.getRect(key('swarm-browser-button')).left,
        greaterThan(tester.getRect(key('swarm-terminal-button')).right),
      );
      await tester.pumpWidget(const SizedBox());
    }

    for (final none in [
      app(browser: const AgentBrowser(state: 'ready'), shared: true),
      app(status: 'stopped'),
      app(listed: false),
    ]) {
      await show(tester, none);
      expect(key('swarm-browser-button'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('the button\'s label is Browser, running while it is ready', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    for (final (browser, label) in [
      (null, 'Browser'),
      (const AgentBrowser(state: 'starting'), 'Browser'),
      (const AgentBrowser(state: 'failed', error: 'podman_down'), 'Browser'),
      (const AgentBrowser(state: 'ready'), 'Browser, running'),
    ]) {
      await show(tester, app(browser: browser));
      expect(
        tester.getSemantics(key('swarm-browser-button')).label,
        label,
        reason: '${browser?.state}',
      );
      await tester.pumpWidget(const SizedBox());
    }
    semantics.dispose();
  });

  testWidgets('Browser, Terminal and Instructions close each other, and Info '
      'too', (tester) async {
    // A browser with nothing turning in its panel, so every step settles.
    await show(
      tester,
      app(
        browser: const AgentBrowser(state: 'failed', error: 'podman_down'),
      ),
    );
    await tap(tester, 'swarm-browser-button');
    expect(
      find.descendant(
        of: key('super-right-pane'),
        matching: key('swarm-browser-panel'),
      ),
      findsOneWidget,
    );

    await tap(tester, 'swarm-terminal-button');
    expect(terminalOpen, isTrue);
    expect(key('swarm-browser-panel'), findsNothing);

    await tap(tester, 'swarm-browser-button');
    expect(terminalOpen, isFalse);
    expect(key('swarm-browser-panel'), findsOneWidget);

    await tap(tester, 'swarm-instructions-button');
    expect(key('swarm-browser-panel'), findsNothing);
    expect(find.text('agents/second.md'), findsOneWidget);

    await tap(tester, 'swarm-browser-button');
    expect(find.text('agents/second.md'), findsNothing);
    await tap(tester, 'swarm-info-button');
    expect(key('swarm-browser-panel'), findsNothing);
    expect(key('swarm-agent-info'), findsOneWidget);

    await tap(tester, 'swarm-browser-button');
    expect(key('swarm-agent-info'), findsNothing);
    // Its own button, and its ×, close it.
    await tap(tester, 'swarm-browser-button');
    expect(key('swarm-browser-panel'), findsNothing);
    await tap(tester, 'swarm-browser-button');
    await tap(tester, 'swarm-browser-close');
    expect(key('swarm-browser-panel'), findsNothing);
  });
}

/// Settles, and lets the read mark a chat saves 200 ms after it is read go, so no timer outlives the test.
Future<void> settle(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 300));
}
