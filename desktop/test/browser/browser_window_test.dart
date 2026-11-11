import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/browser/browser_panel.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/native_webview_host.dart';
import 'package:harness/widgets/web_pane_panel.dart';
import 'package:webview_flutter_platform_interface/webview_flutter_platform_interface.dart';

import '../support/fake_webview.dart';
import '../support/swarm_v4_data.dart';
import 'browser_button_test.dart' show settle;

const _streamId = '0f8fad5b-d9cb-469f-a165-70867728950e';

/// Mac Studio, where lampOS's agent second runs: each window size it was asked for, answered with [answer] (the size
/// as it set it), and each stream it opened.
class _App extends AppNotifier {
  _App()
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
      ..localOnly = true
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    browser(null);
  }

  final windows = <(int, int)>[];
  ({int width, int height})? Function(int width, int height) answer = (
    width,
    height,
  ) => (width: width, height: height);
  final streams = <({BrowserStream stream, List<(String, Map)> frames})>[];

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
  void open() {
    final last = streams.last;
    last.stream.handleFrame('agent_browser_open_result', {
      'requestId': last.frames.first.$2['requestId'],
      'streamId': _streamId,
    });
  }

  @override
  Future<({int width, int height})?> agentBrowserWindow(
    String machineId,
    String agentId,
    int width,
    int height,
  ) async {
    windows.add((width, height));
    return answer(width, height);
  }

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

/// A person with second's Browser open beside its chat, resizing the Desktop's window: Chrome's window follows.
void main() {
  Finder key(String k) => find.byKey(ValueKey(k));
  late _Webviews webviews;

  setUp(() {
    final previous = WebViewPlatform.instance;
    WebViewPlatform.instance = webviews = _Webviews();
    WebPanePanel.webviewAvailableForTest = true;
    addTearDown(() {
      WebPanePanel.webviewAvailableForTest = null;
      if (previous != null) WebViewPlatform.instance = previous;
    });
  });

  /// The window messages the page was told.
  List<(int, int)> told() => [
    for (final controller in webviews.controllers)
      for (final script in controller.scripts)
        if (RegExp(r'^window\.harnessBrowserReceive\((.*)\)$')
                .firstMatch(script)
            case final match?)
          if (jsonDecode(match.group(1)!) case {
            't': 'window',
            'width': final int width,
            'height': final int height,
          })
            (width, height),
  ];

  /// The panel's screen area, in logical pixels, rounded.
  (int, int) screenSize(WidgetTester tester) {
    final size = tester.getSize(find.byType(NativeWebViewHost));
    return (size.width.round(), size.height.round());
  }

  Future<_App> show(WidgetTester tester, {AgentBrowser? browser}) async {
    final app = _App()..browser(browser);
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

  /// Opens the panel on a ready browser, and the machine opens its stream.
  Future<_App> openReady(WidgetTester tester) async {
    final app = await show(tester, browser: const AgentBrowser(state: 'ready'));
    await tester.tap(key('swarm-browser-button'));
    await tester.pump();
    await tester.pump();
    app.open();
    await tester.pump();
    await tester.pump();
    return app;
  }

  Future<void> resize(WidgetTester tester, Size size) async {
    await tester.binding.setSurfaceSize(size);
    await tester.pump();
  }

  testWidgets('opening the panel on a ready browser sends one window request '
      'with the panel\'s size, and the page is told the size the machine '
      'set', (tester) async {
    final app = await show(tester, browser: const AgentBrowser(state: 'ready'));
    app.answer = (_, _) => (width: 1024, height: 768);
    await tester.tap(key('swarm-browser-button'));
    await tester.pump();
    await tester.pump();
    // Nothing is asked before the stream opens.
    expect(app.windows, isEmpty);
    app.open();
    await tester.pump();
    await tester.pump();
    expect(app.windows, [screenSize(tester)]);
    expect(told(), [(1024, 768)]);
    // Nothing more while the panel keeps its size.
    await tester.pump(BrowserPanel.windowSettle * 2);
    expect(app.windows, hasLength(1));
  });

  testWidgets('resizing in steps sends one request, 300 ms after the last '
      'step', (tester) async {
    final app = await openReady(tester);
    expect(app.windows, hasLength(1));
    for (final size in const [
      Size(1360, 900),
      Size(1280, 860),
      Size(1200, 800),
    ]) {
      await resize(tester, size);
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(app.windows, hasLength(1));
    await tester.pump(
      BrowserPanel.windowSettle - const Duration(milliseconds: 101),
    );
    expect(app.windows, hasLength(1));
    await tester.pump(const Duration(milliseconds: 1));
    expect(app.windows, hasLength(2));
    expect(app.windows.last, screenSize(tester));
    expect(told().last, screenSize(tester));

    // Back to the size last sent: nothing is asked.
    await resize(tester, const Size(1260, 860));
    await tester.pump(const Duration(milliseconds: 50));
    await resize(tester, const Size(1200, 800));
    await tester.pump(BrowserPanel.windowSettle);
    expect(app.windows, hasLength(2));
  });

  testWidgets('closing the panel sends none', (tester) async {
    final app = await openReady(tester);
    await resize(tester, const Size(1300, 860));
    await tester.tap(key('swarm-browser-close'));
    // The click's frame, within the 300 ms.
    await tester.pump();
    await tester.pump(BrowserPanel.windowSettle * 2);
    expect(key('swarm-browser-panel'), findsNothing);
    expect(app.windows, hasLength(1));
  });

  testWidgets('a machine that cannot size it (null) leaves the page scaling, '
      'and the next resize asks again', (tester) async {
    final app = await show(tester, browser: const AgentBrowser(state: 'ready'));
    app.answer = (_, _) => null;
    await tester.tap(key('swarm-browser-button'));
    await tester.pump();
    await tester.pump();
    app.open();
    await tester.pump();
    await tester.pump();
    expect(app.windows, hasLength(1));
    expect(told(), isEmpty);

    app.answer = (width, height) => (width: width, height: height);
    await resize(tester, const Size(1300, 860));
    await tester.pump(BrowserPanel.windowSettle);
    expect(app.windows, hasLength(2));
    expect(told(), [screenSize(tester)]);
  });

  testWidgets('no request while the browser starts or is off', (tester) async {
    final app = await show(tester);
    await tester.tap(key('swarm-browser-button'));
    await settle(tester);
    await resize(tester, const Size(1300, 860));
    await tester.pump(BrowserPanel.windowSettle);
    app.browser(const AgentBrowser(state: 'starting'));
    await tester.pump();
    await resize(tester, const Size(1200, 800));
    await tester.pump(BrowserPanel.windowSettle);
    expect(find.text('Starting browser…'), findsOneWidget);
    expect(app.windows, isEmpty);
    expect(told(), isEmpty);
  });
}
