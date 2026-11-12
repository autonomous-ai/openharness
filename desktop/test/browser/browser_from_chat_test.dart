import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/browser/browser_availability.dart';
import 'package:harness/browser/browser_setup_dialog.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/web_pane_panel.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../support/fake_webview.dart';
import '../support/swarm_v4_data.dart';
import 'browser_button_test.dart' show settle;

const _streamId = '0f8fad5b-d9cb-469f-a165-70867728950e';

/// Mac Studio, where lampOS's agent second runs, as its person's Desktop asks it: each Start and Stop it was sent, and
/// each stream it opened. [refusal] is what it answers Start and Stop with.
class _App extends AppNotifier {
  _App({bool thisComputer = true})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    const machine = Machine(
      machineId: 'host',
      authMode: MachineAuthMode.remote,
      name: 'Mac Studio',
      status: 'online',
    );
    machines = [machine];
    machineStates['host'] = MachineState(machine)
      ..localOnly = thisComputer
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    browser(null);
  }

  final asked = <String>[];
  final streams = <({BrowserStream stream, List<(String, Map)> frames})>[];
  Object? refusal;

  /// The agent frame's browser, as the machine sends it.
  void browser(AgentBrowser? browser) {
    stateOf('host')!.agents = [
      Agent(
        id: 'session-second',
        name: 'second',
        engine: 'claude',
        browser: browser,
      ),
    ];
    notifyListeners();
  }

  /// The machine opens the last stream it was asked for.
  void answer() {
    final last = streams.last;
    last.stream.handleFrame('agent_browser_open_result', {
      'requestId': last.frames.first.$2['requestId'],
      'streamId': _streamId,
    });
  }

  @override
  Future<void> agentBrowserStart(String machineId, String agentId) async {
    asked.add('start $machineId/$agentId');
    if (refusal case final refusal?) throw refusal;
  }

  @override
  Future<void> agentBrowserStop(String machineId, String agentId) async {
    asked.add('stop $machineId/$agentId');
    if (refusal case final refusal?) throw refusal;
  }

  @override
  Future<BrowserAvailability> agentBrowserAvailable(String machineId) async =>
      const BrowserAvailability(BrowserAvailability.needsSetup);

  @override
  Future<void> agentBrowserSetup(String machineId) async =>
      asked.add('setup $machineId');

  @override
  BrowserStream browserStream(String machineId, String agentId) {
    final frames = <(String, Map)>[];
    final stream = BrowserStream(
      machineId: machineId,
      agentId: agentId,
      send: (type, payload) async {
        frames.add((type, Map.of(payload)));
        return true;
      },
      sendBinary: (_) async => true,
    );
    streams.add((stream: stream, frames: frames));
    return stream;
  }
}

/// The Browser page in a webview with no native view: it says it loaded as soon as its channel is there.
class _Webviews extends FakeWebViewPlatform {
  @override
  PlatformWebViewController createPlatformWebViewController(
    PlatformWebViewControllerCreationParams params,
  ) {
    final controller = _Page(params, this);
    controllers.add(controller);
    return controller;
  }
}

class _Page extends FakeWebViewController {
  _Page(super.params, super.platform);

  @override
  Future<void> addJavaScriptChannel(JavaScriptChannelParams channel) async =>
      channel.onMessageReceived(
        const JavaScriptMessage(message: '{"t":"ready"}'),
      );

  @override
  Future<void> loadHtmlString(String html, {String? baseUrl}) async {}
}

/// A person in their chat with second, on the Desktop: the Browser button after Terminal, and its panel beside the chat.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  setUp(() {
    final previous = WebViewPlatform.instance;
    WebViewPlatform.instance = _Webviews();
    WebPanePanel.webviewAvailableForTest = true;
    addTearDown(() {
      WebPanePanel.webviewAvailableForTest = null;
      if (previous != null) WebViewPlatform.instance = previous;
    });
  });

  Future<_App> show(WidgetTester tester, {bool thisComputer = true}) async {
    final app = _App(thisComputer: thisComputer);
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = swarmV4Server().controller(
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
          // As the workspace hosts it: the view is built again on every change of the app.
          body: ListenableBuilder(
            listenable: app,
            builder: (context, _) => SuperTabView(
              controller: controller,
              app: app,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: swarmV4GitHub(),
              instructions: SwarmV4Computer().link,
            ),
          ),
        ),
      ),
    );
    await settle(tester);
    return app;
  }

  Future<void> tap(WidgetTester tester, String k) async {
    await tester.tap(key(k));
    await settle(tester);
  }

  Future<void> frame(
    WidgetTester tester,
    _App app,
    AgentBrowser? browser,
  ) async {
    app.browser(browser);
    await tester.pump();
    await tester.pump();
  }

  const off = 'A sandboxed Chrome the agent drives';
  final screen = key('fake-webview');
  const ready = AgentBrowser(state: 'ready');
  Finder running() => find.bySemanticsLabel('Browser, running');

  testWidgets('an agent with no browser: Browser is there; pressing it shows '
      'off; Start sends the request; the frame turns starting, then ready and '
      'the screen shows; the button shows running; Stop sends the request; '
      'the frame loses its browser and the panel shows off', (tester) async {
    final semantics = tester.ensureSemantics();
    final app = await show(tester);
    expect(key('swarm-browser-button'), findsOneWidget);
    expect(running(), findsNothing);

    await tap(tester, 'swarm-browser-button');
    expect(find.text(off), findsOneWidget);
    expect(key('swarm-browser-stop'), findsNothing);
    await tap(tester, 'swarm-browser-start');
    expect(app.asked, ['start host/session-second']);

    await frame(tester, app, const AgentBrowser(state: 'starting'));
    expect(find.text(off), findsNothing);
    expect(find.text('Starting browser…'), findsOneWidget);
    expect(key('swarm-browser-stop'), findsOneWidget);

    await frame(tester, app, ready);
    app.answer();
    await tester.pump();
    await tester.pump();
    expect(screen, findsOneWidget);
    expect(running(), findsOneWidget);

    await tester.tap(key('swarm-browser-stop'));
    await tester.pump();
    expect(app.asked, [
      'start host/session-second',
      'stop host/session-second',
    ]);
    await frame(tester, app, null);
    expect(screen, findsNothing);
    expect(find.text(off), findsOneWidget);
    expect(key('swarm-browser-stop'), findsNothing);
    expect(running(), findsNothing);
    // The stream ended with the browser.
    expect(app.streams.single.frames.last.$1, 'agent_browser_close');
    semantics.dispose();
  });

  testWidgets('started from the person\'s other Desktop: the frame turns '
      'ready, the panel stays closed, the button shows running; pressing it '
      'shows the screen', (tester) async {
    final semantics = tester.ensureSemantics();
    final app = await show(tester);
    await frame(tester, app, ready);
    expect(key('swarm-browser-panel'), findsNothing);
    expect(running(), findsOneWidget);
    expect(app.streams, isEmpty);

    await tester.tap(key('swarm-browser-button'));
    await tester.pump();
    await tester.pump();
    app.answer();
    await tester.pump();
    await tester.pump();
    expect(screen, findsOneWidget);
    expect(app.asked, isEmpty);
    semantics.dispose();
    // Opening a pane beside a chat is saved with the chat's view 200 ms later (controller.dart showBeside).
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('needs setup: Start, then Install on this computer opens Set up '
      'Browser; from another computer the line says where', (tester) async {
    var app = await show(tester);
    await tap(tester, 'swarm-browser-button');
    await tap(tester, 'swarm-browser-start');
    await frame(
      tester,
      app,
      const AgentBrowser(state: 'failed', error: 'needs_setup'),
    );
    expect(find.text('Browser isn\'t set up'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Install'));
    await settle(tester);
    expect(find.byType(BrowserSetupPrompt), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(BrowserSetupPrompt),
        matching: find.widgetWithText(FilledButton, 'Install'),
      ),
    );
    await settle(tester);
    expect(app.asked, ['start host/session-second', 'setup host']);

    await tester.pumpWidget(const SizedBox());
    app = await show(tester, thisComputer: false);
    await tap(tester, 'swarm-browser-button');
    await tap(tester, 'swarm-browser-start');
    await frame(
      tester,
      app,
      const AgentBrowser(state: 'failed', error: 'needs_setup'),
    );
    expect(find.text('Set up Browser on Mac Studio first'), findsOneWidget);
    expect(find.text('Install'), findsNothing);
  });

  for (final (name, code, line) in [
    ('an older CLI', 'UNSUPPORTED', 'Update Harness on Mac Studio first'),
    (
      'a Windows machine',
      'NOT_ON_WINDOWS',
      'Browser doesn\'t run on Windows yet',
    ),
    ('a guest', 'NOT_OWNER', 'Only its owner can open this browser'),
    (
      'any other refusal',
      'NOT_RUNNING',
      'Browser isn\'t available on Mac Studio right now',
    ),
  ]) {
    testWidgets('$name: Start shows "$line"', (tester) async {
      final app = await show(tester);
      app.refusal = WsRequestFailure(
        responseType: 'agent_browser_start_result',
        code: code,
      );
      await tap(tester, 'swarm-browser-button');
      await tap(tester, 'swarm-browser-start');
      expect(find.text(line), findsOneWidget);
      expect(find.text(off), findsOneWidget);
    });
  }

  testWidgets('Stop turns a failed browser off', (tester) async {
    final app = await show(tester);
    await frame(
      tester,
      app,
      const AgentBrowser(state: 'failed', error: 'podman_down'),
    );
    await tap(tester, 'swarm-browser-button');
    expect(find.text('Podman is not running'), findsOneWidget);
    // Its spinner turns until the machine says the browser is off.
    await tester.tap(key('swarm-browser-stop'));
    await tester.pump();
    await tester.pump();
    expect(app.asked, ['stop host/session-second']);
    expect(find.text('Stopping browser…'), findsOneWidget);
    await frame(tester, app, null);
    expect(find.text('Podman is not running'), findsNothing);
    expect(find.text(off), findsOneWidget);
  });

  testWidgets('closing the panel sends no request', (tester) async {
    final app = await show(tester);
    await frame(tester, app, ready);
    await tester.tap(key('swarm-browser-button'));
    await tester.pump();
    await tester.pump();
    app.answer();
    await tester.pump();
    await tester.pump();
    expect(screen, findsOneWidget);
    await tap(tester, 'swarm-browser-close');
    expect(key('swarm-browser-panel'), findsNothing);
    await tap(tester, 'swarm-browser-button');
    await tap(tester, 'swarm-browser-button');
    expect(app.asked, isEmpty);
    // Only the stream it showed ended.
    expect(app.streams.first.frames.last.$1, 'agent_browser_close');
  });
}
