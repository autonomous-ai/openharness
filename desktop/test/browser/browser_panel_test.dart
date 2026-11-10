import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/browser/browser_availability.dart';
import 'package:harness/browser/browser_panel.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/browser/browser_setup_dialog.dart';
import 'package:harness/browser/browser_stream.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/web_pane_panel.dart';

import '../support/fake_browser_view.dart';

const _id = '0f8fad5b-d9cb-469f-a165-70867728950e';

/// Counts what the panel measures, instead of reporting it.
class _Measure extends ProductMeasurement {
  _Measure()
    : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});
  int opened = 0;
  @override
  void agentBrowserOpened() => opened++;
}

/// Faye's machine, Ken Mac, as the panel asks it: the requests it was sent, and each stream it opened with the frames
/// that stream sent.
class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        productMeasurement: _Measure(),
      ) {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Ken Mac',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }

  final asked = <String>[];
  final streams = <({BrowserStream stream, List<(String, Map)> frames})>[];
  var availability = const BrowserAvailability(BrowserAvailability.needsSetup);

  _Measure get measure => productMeasurement as _Measure;

  void browser(AgentBrowser? browser) {
    stateOf('m')!.agents = [
      Agent(id: 'a1', name: 'Faye', engine: 'claude', browser: browser),
    ];
    notifyListeners();
  }

  /// The machine's answer to the last open: the stream, or [error].
  void answer({String? error}) {
    final last = streams.last;
    last.stream.handleFrame('agent_browser_open_result', {
      'requestId': last.frames.first.$2['requestId'],
      if (error != null) 'error': error else 'streamId': _id,
    });
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

  @override
  Future<BrowserAvailability> agentBrowserAvailable(String machineId) async =>
      availability;

  @override
  Future<void> agentBrowserSetup(String machineId) async => asked.add('setup');

  @override
  Future<void> agentBrowserRetry(String machineId, String agentId) async =>
      asked.add('retry $agentId');

  @override
  Future<BrowserSettings> agentBrowserSettings(
    String machineId,
    String agentId,
  ) async => const BrowserSettings(languages: 'vi-VN, en-US');
}

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  late _App app;
  late List<FakeBrowserView> views;
  var closed = 0;
  setUp(() {
    WebPanePanel.webviewAvailableForTest = true;
    app = _App();
    views = [];
    closed = 0;
  });
  tearDown(() {
    WebPanePanel.webviewAvailableForTest = null;
    app.dispose();
  });

  Future<void> show(
    WidgetTester tester,
    AgentBrowser? browser, {
    bool thisComputer = true,
  }) async {
    app.browser(browser);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: 480,
            height: 600,
            child: BrowserPanel(
              app: app,
              machineId: 'm',
              agentId: 'a1',
              thisComputer: thisComputer,
              onClose: () => closed++,
              newView: () {
                final view = FakeBrowserView(ready: true);
                views.add(view);
                return view;
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  const ready = AgentBrowser(state: 'ready');

  /// A ready browser with its stream open and its screen showing.
  Future<void> showOpen(WidgetTester tester) async {
    await show(tester, ready);
    app.answer();
    await tester.pump();
    await tester.pump();
    expect(key('browser-screen'), findsOneWidget);
  }

  /// The machine closes the open stream with [reason].
  Future<void> closeWith(WidgetTester tester, String reason) async {
    app.streams.last.stream.handleFrame('agent_browser_close', {
      'streamId': _id,
      'reason': reason,
    });
    await tester.pump();
    await tester.pump();
  }

  testWidgets('setup shows the four progress lines, with the current step '
      'spinning and earlier ones ticked', (tester) async {
    await show(
      tester,
      const AgentBrowser(state: 'setup', step: 'starting_podman'),
    );
    for (final line in [
      'Podman installed',
      'Starting Podman…',
      'Building browser',
      'Starting browser',
    ]) {
      expect(find.text(line), findsOneWidget);
    }
    expect(find.byIcon(AppIcons.circleCheck), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byIcon(AppIcons.circle), findsNWidgets(2));
    app.browser(const AgentBrowser(state: 'setup', step: 'building'));
    await tester.pump();
    expect(find.byIcon(AppIcons.circleCheck), findsNWidgets(2));
    expect(app.streams, isEmpty);
  });

  testWidgets('starting shows "Starting browser…"', (tester) async {
    await show(tester, const AgentBrowser(state: 'starting'));
    expect(find.text('Starting browser…'), findsOneWidget);
    expect(app.streams, isEmpty);
  });

  testWidgets('each failed state shows its copy and its button from the '
      'table', (tester) async {
    const copy = {
      'podman_manual': 'Install Podman, then retry',
      'podman_old': 'Update Podman, then retry',
      'podman_memory': 'Give Podman 4 GB of memory, then retry',
      'state_unreadable': 'Browser data can\'t be read',
      'podman_down': 'Podman is not running',
      'image_failed': 'Browser image failed to build',
      'browser_stopped': 'Browser stopped',
      'profile_unwritable': 'Browser can\'t save its login',
      'proxy_failed': 'Proxy is not reachable',
      'browser_limit': 'Too many browsers on this machine',
      'device_failed': 'Device settings didn\'t apply',
    };
    for (final MapEntry(key: error, value: line) in copy.entries) {
      app.asked.clear();
      // Read as the agent frame carries it, so a state the model drops shows up here as "Browser stopped".
      await show(
        tester,
        AgentBrowser.fromJson({'state': 'failed', 'error': error})!,
      );
      expect(find.text(line), findsOneWidget, reason: error);
      if (error == 'state_unreadable') {
        expect(find.text('Retry'), findsNothing);
        continue;
      }
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(app.asked, ['retry a1'], reason: error);
    }
  });

  testWidgets('needs_setup shows Install on this computer, which opens the '
      'setup dialog; on another computer it shows "Set up Browser on Ken Mac '
      'first" and no button', (tester) async {
    const needsSetup = AgentBrowser(state: 'failed', error: 'needs_setup');
    await show(tester, needsSetup);
    expect(find.text('Browser isn\'t set up'), findsOneWidget);
    await tester.tap(find.text('Install'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Set up Browser'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(BrowserSetupPrompt),
        matching: find.widgetWithText(FilledButton, 'Install'),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(app.asked, ['setup']);

    await show(tester, needsSetup, thisComputer: false);
    expect(find.text('Set up Browser on Ken Mac first'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('podman_install_failed shows Retry on this computer only, and '
      'Retry calls agentBrowserSetup', (tester) async {
    const failed = AgentBrowser(state: 'failed', error: 'podman_install_failed');
    await show(tester, failed);
    expect(find.text('Podman didn\'t install'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pump();
    expect(app.asked, ['setup']);
    await show(tester, failed, thisComputer: false);
    expect(find.text('Podman didn\'t install'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('offline shows "Reconnect this machine to open its browser"', (
    tester,
  ) async {
    app.stateOf('m')!.nodeOnline = false;
    await show(tester, ready);
    expect(
      find.text('Reconnect this machine to open its browser'),
      findsOneWidget,
    );
    expect(app.streams, isEmpty);
  });

  testWidgets('no webview shows "This computer can\'t show the browser"', (
    tester,
  ) async {
    WebPanePanel.webviewAvailableForTest = false;
    await show(tester, ready);
    expect(find.text('This computer can\'t show the browser'), findsOneWidget);
    expect(app.streams, isEmpty);
  });

  testWidgets('ready opens a BrowserStream and closes it when the panel '
      'closes', (tester) async {
    await show(tester, ready);
    expect(app.streams.single.frames.single.$1, 'agent_browser_open');
    expect(app.streams.single.frames.single.$2['agentId'], 'a1');
    app.answer();
    await tester.pump();
    expect(key('browser-screen'), findsOneWidget);
    expect(views.single.posted.last, {'t': 'open'});
    await tester.pumpWidget(const SizedBox());
    expect(app.streams.single.frames.last.$1, 'agent_browser_close');
    expect(await app.streams.single.stream.closed, 'closed');
  });

  testWidgets('opening a stream reports agent_browser_opened once, with no '
      'other field', (tester) async {
    await show(tester, ready);
    expect(app.measure.opened, 0);
    app.answer();
    await tester.pump();
    expect(app.measure.opened, 1);
    await tester.pump();
    expect(app.measure.opened, 1);
  });

  testWidgets('a stream closed with reason rate or backlog shows "Browser is '
      'slow here"; Retry reconnects', (tester) async {
    for (final reason in ['rate', 'backlog']) {
      await showOpen(tester);
      final before = app.streams.length;
      await closeWith(tester, reason);
      expect(find.text('Browser is slow here'), findsOneWidget, reason: reason);
      expect(app.streams, hasLength(before));
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();
      expect(app.streams, hasLength(before + 1));
      app.answer();
      await tester.pump();
      expect(key('browser-screen'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('a stream closed with reason route reconnects by itself once, '
      'with no message; a second route close in a row shows "Browser lost '
      'its connection" with Retry', (tester) async {
    await showOpen(tester);
    await closeWith(tester, 'route');
    expect(app.streams, hasLength(2));
    expect(find.text('Browser lost its connection'), findsNothing);
    app.answer();
    await tester.pump();
    await tester.pump();
    await closeWith(tester, 'route');
    expect(app.streams, hasLength(2));
    expect(find.text('Browser lost its connection'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pump();
    await tester.pump();
    expect(app.streams, hasLength(3));
  });

  testWidgets('an open refused with VIEWER_LIMIT shows "Browser is open in '
      'too many places", and NOT_OWNER shows "Only its owner can open this '
      'browser"', (tester) async {
    for (final (code, line) in [
      ('VIEWER_LIMIT', 'Browser is open in too many places'),
      ('NOT_OWNER', 'Only its owner can open this browser'),
    ]) {
      await show(tester, ready);
      app.answer(error: code);
      await tester.pump();
      await tester.pump();
      expect(find.text(line), findsOneWidget, reason: code);
      expect(find.text('Retry'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('a close with reason agent, and an open refused with NOT_READY, '
      'show the agent frame\'s browser state', (tester) async {
    await showOpen(tester);
    await closeWith(tester, 'agent');
    // The frame still says ready: the browser is on its way back.
    expect(find.text('Starting browser…'), findsOneWidget);
    expect(app.streams, hasLength(1));
    app.browser(const AgentBrowser(state: 'failed', error: 'browser_stopped'));
    await tester.pump();
    expect(find.text('Browser stopped'), findsOneWidget);
    app.browser(ready);
    await tester.pump();
    await tester.pump();
    expect(app.streams, hasLength(2));
    app.answer(error: 'NOT_READY');
    await tester.pump();
    await tester.pump();
    expect(find.text('Starting browser…'), findsOneWidget);
    app.browser(const AgentBrowser(state: 'starting'));
    await tester.pump();
    app.browser(ready);
    await tester.pump();
    await tester.pump();
    expect(app.streams, hasLength(3));
  });

  testWidgets('Paste sends the clipboard\'s text to the browser, and the gear '
      'opens Browser settings, whose back returns to the screen', (
    tester,
  ) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.getData') return {'text': 'Xin chào'};
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );
    await showOpen(tester);
    await tester.tap(key('swarm-browser-paste'));
    await tester.pump();
    await tester.pump();
    expect(views.last.posted.last, {'t': 'paste', 'text': 'Xin chào'});

    await tester.tap(key('swarm-browser-settings'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Browser settings'), findsOneWidget);
    expect(key('browser-screen'), findsNothing);
    await tester.tap(key('browser-settings-back'));
    await tester.pump();
    await tester.pump();
    app.answer();
    await tester.pump();
    expect(key('browser-screen'), findsOneWidget);
  });

  testWidgets('the panel closes from its ×', (tester) async {
    await show(tester, const AgentBrowser(state: 'starting'));
    expect(find.text('Browser'), findsOneWidget);
    await tester.tap(key('swarm-browser-close'));
    expect(closed, 1);
  });
}
