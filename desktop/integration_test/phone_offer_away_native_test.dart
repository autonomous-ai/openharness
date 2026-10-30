import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_session.dart';

import '../test/support/capture.dart';
import '../test/swarm_state_test.dart' show MemoryStore;

/// The Add Phone card after time away, in the real macOS window: a person leaves the window, one of
/// their harnesses finishes (or waits on them), and they come back 5 minutes or more later
/// (docs/design/2026-10-20-desktop-phone-conversion.md).
///
/// Run with FLUTTER_TEST=1. The account, its devices and the harnesses are fixtures: nothing reaches
/// the daemon or the backend (both point at a closed port), no notification is posted and no sound
/// plays. `HARNESS_PHONE_OFFER_SHOTS_DIR` is where the window's pictures go; AppKit's title bar is not
/// in them, as everything else Flutter draws is.
final _shotsDir = Platform.environment['HARNESS_PHONE_OFFER_SHOTS_DIR'];

/// Nothing listens there: a request this fixture did not answer itself is refused at once.
const _nowhere = AppConfig(
  apiBaseUrl: 'http://127.0.0.1:9',
  autonomousEnv: 'test',
  localCliBaseUrl: 'http://127.0.0.1:9',
);

/// An account with this computer on it and no phone or browser.
class _NoPhoneApi extends ApiClient {
  _NoPhoneApi() : super(config: _nowhere, session: AuthSession());

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => {
    'members': [
      {
        'pub': 'pub-this-mac',
        'label': 'This Mac',
        'kind': 'machine',
        'addedAt': 1,
        'fingerprint': 'fp',
        'self': true,
      },
    ],
  };
}

void main() {
  if (!kUnderTest) throw StateError('Use FLUTTER_TEST=1 with this fixture.');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1280, 800));
    await windowManager.show();
    await windowManager.focus();
  });

  late DateTime now;
  late AppLifecycleState state;

  /// A signed-in computer at work: two harnesses open side by side, the window in front.
  AppNotifier working() {
    now = DateTime.utc(2026, 10, 20, 9);
    state = AppLifecycleState.resumed;
    final app =
        AppNotifier(
            config: _nowhere,
            authSession: AuthSession(),
            configStore: null,
            paneLayoutStore: PaneLayoutStore(storage: MemoryStore()),
            systemNotifications: SystemNotifications(
              notifier: const NoSystemNotifier(),
            ),
            alerts: AlertSounds(
              store: alertSoundStore,
              channel: const MethodChannel('phone-offer-fixture/quiet'),
            ),
          )
          ..hasNavigationRail = false
          ..status = AppStatus.authenticated
          ..signedIn = true
          ..api = _NoPhoneApi()
          ..phoneOfferClock = (() => now)
          ..lifecycle = (() => state);
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'MacBook Pro',
    );
    app.machines = [machine];
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent(
          id: 'a0',
          name: 'Refactor auth flow',
          engine: 'codex',
          terminalAvailable: true,
        ),
        Agent(
          id: 'a1',
          name: 'Write release notes',
          engine: 'claude',
          terminalAvailable: true,
        ),
      ];
    for (final agent in app.machineStates['m']!.agents) {
      app.adoptSessionForTest(
        TerminalSession(
            machineId: 'm',
            agentId: agent.id,
            agentName: agent.name,
            engineId: agent.engine,
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-${agent.id}',
      );
    }
    return app;
  }

  Future<void> mount(
    WidgetTester tester,
    AppNotifier app,
    Brightness brightness,
  ) async {
    grid.AppTheme.palette.value = brightness == Brightness.light
        ? HarnessPalette.paper
        : HarnessPalette.graphite;
    grid.AppTheme.brightness.value = brightness;
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (_, child) => grid.BrightnessScope(child: child!),
        home: SwarmScreen(notifier: app, projectStore: SwarmProjectStore()),
      ),
    );
    await settle(tester);
  }

  /// The window leaves the front, as the workspace's lifecycle listener reports it.
  void leave(AppNotifier app) {
    state = AppLifecycleState.inactive;
    app.appLifecycleChanged(AppLifecycleState.inactive);
  }

  /// Back in front, [after] it left.
  Future<void> back(
    WidgetTester tester,
    AppNotifier app,
    Duration after,
  ) async {
    now = now.add(after);
    state = AppLifecycleState.resumed;
    app.appLifecycleChanged(AppLifecycleState.resumed);
    await settle(tester);
  }

  testWidgets('returning account gets a card, never a dialog', (tester) async {
    final app = working()
      ..currentUser = const CurrentUserProfile(id: 'returning', email: 'fixture@example.test');
    addTearDown(app.dispose);
    await app.offerPhoneForTest(atLaunch: true);
    await mount(tester, app, Brightness.dark);
    expect(find.byKey(const Key('phone-offer-card')), findsOneWidget);
    expect(find.byKey(const Key('add-phone-close')), findsNothing);
    await captureWindow(tester, _shotsDir, '0-returning-card');
    await tester.tap(find.byKey(const Key('phone-offer-dismiss')));
    await settle(tester);
    expect(app.phoneOfferShowing, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a harness finished while the person was away', (tester) async {
    final app = working();
    addTearDown(app.dispose);
    await mount(tester, app, Brightness.dark);
    expect(find.byKey(const Key('phone-offer-card')), findsNothing);
    await captureWindow(tester, _shotsDir, '1-working-no-card');

    leave(app);
    now = now.add(const Duration(minutes: 2));
    await app.handleMachineEventForTest('m', {
      'type': 'turn_summary',
      'agentId': 'a0',
      'payload': {
        'agentId': 'a0',
        'notification': {'id': 'n1', 'kind': 'done'},
      },
    });
    // Back 23 minutes after leaving: 21 minutes after the harness finished.
    await back(tester, app, const Duration(minutes: 21));
    expect(find.byKey(const Key('phone-offer-card')), findsOneWidget);
    expect(
      find.text('Refactor auth flow finished 21\u00A0min ago.'),
      findsOneWidget,
    );
    expect(
      find.text('Know the moment it’s done, on your phone.'),
      findsOneWidget,
    );
    await captureWindow(tester, _shotsDir, '2-back-finished-dark');

    await tester.tap(find.byKey(const Key('phone-offer-dismiss')));
    await settle(tester);
    expect(find.byKey(const Key('phone-offer-card')), findsNothing);
    await captureWindow(tester, _shotsDir, '3-after-dismiss');

    // Put away for good: the next time away offers nothing.
    leave(app);
    await app.handleMachineEventForTest('m', {
      'type': 'turn_summary',
      'agentId': 'a0',
      'payload': {
        'agentId': 'a0',
        'notification': {'id': 'n2', 'kind': 'done'},
      },
    });
    await back(tester, app, const Duration(minutes: 30));
    expect(find.byKey(const Key('phone-offer-card')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a harness waited on the person while they were away', (
    tester,
  ) async {
    for (final brightness in [Brightness.dark, Brightness.light]) {
      final app = working();
      await mount(tester, app, brightness);
      leave(app);
      now = now.add(const Duration(minutes: 3));
      await app.handleMachineEventForTest('m', {
        'type': 'commander_question',
        'agentId': 'a1',
        'payload': {
          'requestId': 'q1',
          'questions': [
            {
              'key': 'Ship it?',
              'q': 'Ship it?',
              'options': ['Yes', 'No'],
            },
          ],
        },
      });
      await back(tester, app, const Duration(minutes: 18));
      expect(
        find.text('Write release notes waited 18\u00A0min for you.'),
        findsOneWidget,
      );
      expect(find.text('Answer from your phone next time.'), findsOneWidget);
      await captureWindow(
        tester,
        _shotsDir,
        '4-back-waited-${brightness.name}',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      app.dispose();
    }
  });
}

/// Frames for what just changed, and the async work behind it (the device list read).
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
