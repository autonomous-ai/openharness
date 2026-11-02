import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import 'package:harness/agent_messages/shared_tabs.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/setup_tour.dart';
import 'package:harness/widgets/sign_in_step.dart';
import 'package:harness/ws/ws_conn.dart';

import '../test/support/capture.dart';
import '../test/support/guest_app.dart';
import '../test/swarm_state_test.dart' show MemoryStore;

/// The sign-in step and the tab row's account control in the real macOS
/// window: a computer new to Harness goes from the tour to the sign-in page,
/// and from there, after successful sign-in, to a workspace whose native
/// title bar ends in the account's initial.
///
/// Run with FLUTTER_TEST=1 (`--no-enable-impeller` on Intel). Setup, the CLI's
/// sign-in and the account are fixtures: nothing is installed, no browser
/// opens, and no real Harness home or daemon is read.
///
/// AppKit draws the tab row, so nothing here can see or press it. With
/// `HARNESS_NATIVE_DRIVER_DIR` set, a driver outside the app
/// (`tool/native_driver.py`) reads and presses the native controls through
/// accessibility and photographs this window, and this asks it to. Without
/// one — or with the screen locked, when macOS shows a driver neither the
/// controls nor the window — a press arrives as the action AppKit's row sends
/// for it, so everything on this side of the channel is still exercised, and
/// the row's own checks are `tool/check_swarm_titlebar.sh`'s.
/// `HARNESS_NATIVE_SHOTS_DIR` is where a picture goes when the window cannot
/// be photographed.
final _driverDir = Platform.environment['HARNESS_NATIVE_DRIVER_DIR'] ?? '';
final _shotsDir = Platform.environment['HARNESS_NATIVE_SHOTS_DIR'];
bool get _driven => _driverDir.isNotEmpty;
var _requests = 0;

/// One request to the driver, pumping frames while it works: a native press
/// comes back to this app as an event it has to be awake for.
Future<Map<String, dynamic>> _native(
  WidgetTester tester,
  String command, [
  String argument = '',
]) async {
  final id = (_requests++).toString().padLeft(3, '0');
  File('$_driverDir/req-$id.tmp')
      .writeAsStringSync(jsonEncode({'cmd': command, 'arg': argument}));
  File('$_driverDir/req-$id.tmp').renameSync('$_driverDir/req-$id.json');
  final answer = File('$_driverDir/res-$id.json');
  for (var i = 0; i < 400; i++) {
    await tester.pump(const Duration(milliseconds: 50));
    if (answer.existsSync()) {
      return jsonDecode(answer.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  fail('The native driver did not answer "$command $argument".');
}

Future<void> _shot(WidgetTester tester, String name) async {
  if (!_driven) {
    await captureWindow(tester, _shotsDir, '$name-flutter-only');
    return;
  }
  // What is on screen now, not a frame behind it.
  await tester.pump(const Duration(milliseconds: 250));
  final answer = await _native(tester, 'shot', name);
  if (answer['ok'] == true) return;
  // A locked or sleeping screen: macOS photographs no window then. A picture
  // is an aid, not a check, so what this app itself drew is saved instead —
  // without AppKit's title bar, which only the window's own picture has.
  debugPrint('No window screenshot for $name: $answer');
  await captureWindow(tester, _shotsDir, '$name-flutter-only');
}

/// The native buttons of this window by name, as accessibility reports them.
Future<Map<String, Map<String, dynamic>>> _nativeButtons(
  WidgetTester tester,
) async {
  final answer = await _native(tester, 'list');
  return {
    for (final button in (answer['buttons'] as List).cast<Map>())
      if ((button['label'] as String).isNotEmpty)
        button['label'] as String: {
          ...Map<String, dynamic>.from(button),
          'window': answer['window'],
        },
  };
}

/// Whether AppKit's row can be read and pressed from outside right now: a
/// driver is answering and the screen is not locked.
Future<bool> _rowReachable(WidgetTester tester) async {
  if (!_driven) return false;
  final answer = await _native(tester, 'locked');
  if (answer['locked'] == true) {
    debugPrint(
      'The screen is locked: the native row is pressed through its channel, '
      'and its geometry is not read.',
    );
    return false;
  }
  return true;
}

/// A press on [label] in AppKit's row: the real control, through
/// accessibility, when it can be reached; else [action], which is what that
/// control sends this app when it is pressed.
Future<void> _press(
  WidgetTester tester, {
  required bool reachable,
  required String label,
  required String action,
}) async {
  if (reachable) {
    final pressed = await _native(tester, 'press', label);
    expect(pressed['pressed'], isTrue, reason: '$pressed');
    return;
  }
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'harness/swarm_tabs',
    const StandardMethodCodec().encodeMethodCall(MethodCall(action)),
    (_) {},
  );
}

/// A native control's own left and right edge. Accessibility reports each
/// frame a point larger on every side than the view's.
double _left(Map button) => (button['x'] as num) + 1.0;
double _right(Map button) => (button['x'] as num) + (button['w'] as num) - 1.0;
double _width(Map button) => _right(button) - _left(button);

/// Within a point: those frames land on half points.
Matcher _about(num value) => moreOrLessEquals(value.toDouble(), epsilon: 1);

Future<void> _until(
  WidgetTester tester,
  bool Function() ready, {
  required String reason,
  Duration limit = const Duration(seconds: 15),
}) async {
  final end = DateTime.now().add(limit);
  while (!ready() && DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(ready(), isTrue, reason: reason);
}

class _Login extends CliLogin {
  bool loggedIn = false;
  final started = <SignInProvider?>[];
  var cancels = 0;
  Completer<void>? pending;

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn);

  @override
  Future<void> logout() async => loggedIn = false;

  @override
  void cancel() => cancels++;

  /// Waits like a browser that is open. It never names a page to open: this
  /// fixture must not start the computer's own browser.
  @override
  Future<void> login({
    required void Function(String) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    started.add(provider);
    final wait = pending = Completer<void>();
    await wait.future;
    loggedIn = true;
  }
}

class _Api extends ApiClient {
  _Api()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );

  @override
  Future<Map<String, dynamic>?> me() async => {
    'user': {
      'id': 'fixture',
      'name': 'Dee Example',
      'email': 'dee@example.com',
    },
  };

  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => null;
}

/// A computer whose probe finds no Harness CLI, and whose install puts it in.
class _Setup extends EnvironmentProvisioner {
  _Setup() : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final result = install
        ? EnvironmentReadiness(
            steps: {
              for (final step in EnvironmentStep.values)
                step: EnvironmentStepStatus.ready,
            },
            phase: EnvironmentSetupPhase.ready,
            mode: EnvironmentSetupMode.automatic,
          )
        : EnvironmentReadiness(
            steps: {
              EnvironmentStep.harness: EnvironmentStepStatus.failed,
              EnvironmentStep.tmux: EnvironmentStepStatus.ready,
            },
            phase: EnvironmentSetupPhase.review,
            plan: [EnvironmentPlanItem.harnessCli],
          );
    onProgress(result);
    return result;
  }
}

({GuestTestApp app, _Login cli}) _newComputer() {
  final cli = _Login();
  final app = GuestTestApp(
    config: AppConfig.dev,
    authSession: AuthSession(storage: MemoryStore()),
    configStore: null,
    cliLogin: cli,
    environmentProvisioner: _Setup(),
  )..api = _Api();
  return (app: app, cli: cli);
}

Future<void> _mount(WidgetTester tester, AppNotifier app) async {
  final projects = SwarmProjectStore();
  addTearDown(projects.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(
        authenticatedScreen: (app) => SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    ),
  );
}

/// This computer's daemon answering `agent_messages` `shares` (1c) with one
/// roster: [tabId] (set once the app exists), owned by this account and shared from this computer, with
/// [harnesses] harnesses. Everything else answers nothing.
class _SharesDaemon extends WsConn {
  _SharesDaemon({required this.harnesses})
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  String tabId = '';
  final int harnesses;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_messages' || payload['action'] != 'shares') {
      return const {};
    }
    const me = {'accountId': 'me', 'email': 'me@example.com', 'machineId': 'm'};
    return {
      'api': 2,
      'me': me,
      'rosters': [
        {
          'sharedTabId': 'st-1',
          'tabId': tabId,
          'version': 1,
          'name': 'app',
          'owner': {...me, 'machinePublicKey': 'k'},
          'leader': null,
          'members': [],
          'invites': [],
          'harnesses': [
            for (var i = 0; i < harnesses; i++)
              {
                'accountId': 'me',
                'machineId': 'm',
                'agentId': 'h$i',
                'name': 'h$i',
                'engine': 'claude',
              },
          ],
        },
      ],
      'invites': [],
      'alerts': [],
      'pending': [],
      'notices': [],
      'untrusted': [],
      'activity': [],
    };
  }
}

/// A signed-in computer whose daemon ([daemon]) is this one: a workspace
/// with one tab, "app".
class _SharedApp extends AppNotifier {
  _SharedApp(WsConn daemon)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
        configStore: null,
        connectionForTest: (_) => daemon,
      ) {
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Fixture',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..localOnly = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [const Agent(id: 'a', name: 'h0', terminalAvailable: true)];
    rememberOpenedHarness('m', 'a');
    renameSwarm(activeSwarmId, 'app');
  }
}

final _email = find.byKey(const Key('sign-in-step-email'));
final _google = find.byKey(const Key('login-continue-google'));
final _apple = find.byKey(const Key('login-continue-apple'));
final _menu = find.byKey(const ValueKey('account-menu'));

void main() {
  if (!kUnderTest) {
    throw StateError('Native sign-in fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await windowManager.ensureInitialized();
    // As the app does at launch (`configureDesktopWindow`): this is what puts
    // AppKit's tab row in the title bar. Without it the window keeps a plain
    // title bar and the row is drawn nowhere.
    await const MethodChannel('harness/swarm_tabs').invokeMethod('configure', {
      'palette': grid.AppTheme.palette.value.nativeColors,
    });
    await windowManager.setSize(const Size(1280, 800));
    if (_driven) File('$_driverDir/pid').writeAsStringSync('$pid');
  });
  setUp(() async {
    await windowManager.show();
    await windowManager.focus();
  });
  tearDownAll(() {
    if (_driven) File('$_driverDir/done').writeAsStringSync('');
  });

  testWidgets('native: the tour leads to mandatory sign-in, with cancellation '
      'and failure keeping the workspace closed', (tester) async {
    final (:app, :cli) = _newComputer();
    addTearDown(app.dispose);
    await _mount(tester, app);
    await app.bootstrap();
    await tester.pump();

    // The tour, its install line finished, promising the step and not Harness.
    expect(find.byType(SetupTour), findsOneWidget);
    final line = find.byKey(const ValueKey('tour-install-line'));
    await _until(
      tester,
      () => tester.widget<Text>(line).data == setupTourReadyLine,
      reason: 'the tour says Harness is ready',
    );
    await _shot(tester, '1-tour-ready');

    // At the end of the slide on screen, the sign-in page — not the workspace.
    await _until(
      tester,
      () => find.byType(SignInStep).evaluate().isNotEmpty,
      reason: 'the sign-in step follows the tour',
      limit: tourSlideDuration + const Duration(seconds: 6),
    );
    expect(find.byType(SetupTour), findsNothing);
    expect(find.byType(SwarmScreen), findsNothing);
    expect(find.text(signInStepTitle), findsOneWidget);
    for (final benefit in signInStepBenefits) {
      expect(find.text(benefit.line), findsOneWidget);
    }
    expect(find.text('Sign in to continue.'), findsOneWidget);
    // Email, GitHub or passkey is a button of their width under the two
    // accounts; a phone's scan and a code follow. No Skip remains.
    final google = tester.getRect(_google);
    expect(tester.getRect(_apple).left, google.left);
    expect(find.text('Skip'), findsNothing);
    expect(tester.getRect(_email).width, google.width);
    expect(
      tester.getRect(_email).top,
      greaterThan(tester.getRect(_apple).bottom),
    );
    expect(find.text('Scan with your phone'), findsOneWidget);
    expect(find.text('Sign in on another device'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await _shot(tester, '2-sign-in-page');

    // It waits for the person.
    await tester.pump(const Duration(seconds: 3));
    expect(find.byType(SignInStep), findsOneWidget);

    // Continue with Google: its words stay, and every way in stays live.
    await tester.tap(_google);
    await tester.pump(const Duration(milliseconds: 300));
    expect(cli.started, [SignInProvider.google]);
    expect(find.byType(SignInStep), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.textContaining('Waiting'), findsNothing);
    await _shot(tester, '3-sign-in-page-browser-open');
    await tester.tap(_google);
    await tester.pump(const Duration(milliseconds: 200));
    expect(cli.started, [SignInProvider.google], reason: 'not a second one');
    await tester.tap(_email);
    await tester.pump(const Duration(milliseconds: 300));
    expect(cli.started, [SignInProvider.google, null]);
    expect(cli.cancels, 1);
    expect(find.byType(SignInStep), findsOneWidget);

    // Escape and a cancelled browser flow cannot enter the workspace.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    app.cancelLogin();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SignInStep), findsOneWidget);
    expect(find.byType(SwarmScreen), findsNothing);
    expect(app.signingIn, isFalse);
    expect(cli.cancels, 2);

    // A failed attempt explains why and lets the person try again.
    await tester.tap(_email);
    await tester.pump(const Duration(milliseconds: 300));
    cli.pending!.completeError(
      StateError('The sign-in page could not be reached.'),
    );
    await _until(
      tester,
      () => find.textContaining('could not be reached').evaluate().isNotEmpty,
      reason: 'the required page shows the sign-in error',
    );
    expect(find.byType(SwarmScreen), findsNothing);
    await _shot(tester, '4-sign-in-error');

    await tester.tap(_email);
    await tester.pump(const Duration(milliseconds: 300));
    cli.pending!.complete();
    await _until(
      tester,
      () => find.byType(SwarmScreen).evaluate().isNotEmpty,
      reason: 'successful sign-in opens the workspace',
    );
    expect(find.byType(SignInStep), findsNothing);
    expect(app.signedIn, isTrue);
    expect(tester.takeException(), isNull);
    await _shot(tester, '5-workspace-after-retry');
    await tester.pumpWidget(const SizedBox());
  }, timeout: const Timeout(Duration(minutes: 3)));

  testWidgets(
    'native: signing in on the page opens the workspace signed in, and the '
    'avatar in the title bar opens its menu',
    (tester) async {
      final (:app, :cli) = _newComputer();
      addTearDown(app.dispose);
      await _mount(tester, app);
      await app.bootstrap();
      await tester.pump();
      // The slide's own six seconds are the first journey's.
      app.finishSetupTour();
      await _until(
        tester,
        () => find.byType(SignInStep).evaluate().isNotEmpty,
        reason: 'the sign-in step',
      );

      await tester.tap(_apple);
      await tester.pump(const Duration(milliseconds: 300));
      expect(cli.started, [SignInProvider.apple]);
      expect(find.byType(SignInStep), findsOneWidget);

      // The browser comes back with the account.
      cli.pending!.complete();
      await _until(
        tester,
        () => find.byType(SwarmScreen).evaluate().isNotEmpty,
        reason: 'the account opens the workspace',
      );
      expect(find.byType(SignInStep), findsNothing);
      expect(app.signedIn, isTrue);
      await _until(
        tester,
        () => app.currentUser?.email == 'dee@example.com',
        reason: 'the profile is read',
      );
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);

      final reachable = await _rowReachable(tester);
      await _shot(tester, '6-workspace-signed-in');
      if (reachable) {
        final buttons = await _nativeButtons(tester);
        expect(buttons.containsKey('Sign in'), isFalse);
        final account = buttons['Account']!;
        final store = buttons['Harness Store']!;
        final window = account['window'] as Map;
        expect(_width(account), _about(32));
        expect(account['enabled'], isTrue);
        expect(account['help'], 'Dee Example · dee@example.com');
        expect(_left(account) - _right(store), _about(8));
        expect(
          _right(account),
          _about((window['x'] as num) + (window['w'] as num) - 12),
        );
      }

      // A real press on the avatar: its menu, under the row, at the right.
      Future<void> openMenu() async {
        await _press(
          tester,
          reachable: reachable,
          label: 'Account',
          action: 'account',
        );
        await _until(
          tester,
          () => _menu.evaluate().isNotEmpty,
          reason: 'the avatar opens its menu',
        );
      }

      await openMenu();
      expect(
        find.descendant(of: _menu, matching: find.text('Dee Example')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: _menu, matching: find.text('dee@example.com')),
        findsOneWidget,
      );
      for (final row in const [
        'Add Phone',
        'Appearance',
        'Notifications',
        'Settings',
        'Sign out',
      ]) {
        // In the menu: the workspace behind it has words of its own.
        expect(
          find.descendant(of: _menu, matching: find.text(row)),
          findsOneWidget,
          reason: row,
        );
      }
      final menu = tester.getRect(_menu);
      final view = tester.view.physicalSize / tester.view.devicePixelRatio;
      expect(menu.right, greaterThan(view.width - 16));
      expect(menu.top, lessThan(24), reason: 'directly under the title bar');
      await _shot(tester, '7-account-menu');

      // Escape puts it away and opens nothing.
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await _until(tester, () => _menu.evaluate().isEmpty, reason: 'Escape');
      expect(find.byType(SettingsScreen), findsNothing);

      // Notifications: Settings, on that page.
      await openMenu();
      await tester.tap(
        find.byKey(const ValueKey('account-menu-notifications')),
      );
      await _until(
        tester,
        () => find.byType(SettingsScreen).evaluate().isNotEmpty,
        reason: 'Notifications opens Settings',
      );
      expect(_menu, findsNothing);
      expect(
        tester
            .widget<SettingsScreen>(find.byType(SettingsScreen))
            .initialSection,
        SettingsSection.notifications,
      );
      await _shot(tester, '8-notifications-from-the-menu');
      Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
      await _until(
        tester,
        () => find.byType(SettingsScreen).evaluate().isEmpty,
        reason: 'Settings closes',
      );

      // A rejected session returns to the same required page, even mid-work.
      app.expireSessionForTest(
        'Your session ended. Sign in again to continue.',
      );
      await _until(
        tester,
        () => find.byType(SignInStep).evaluate().isNotEmpty,
        reason: 'session expiry requires sign-in again',
      );
      expect(find.byType(SwarmScreen), findsNothing);
      expect(
        find.text('Your session ended. Sign in again to continue.'),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(SignInStep), findsOneWidget);
      await _shot(tester, 'session-expired');
      await tester.tap(_google);
      await tester.pump(const Duration(milliseconds: 300));
      cli.pending!.complete();
      await _until(
        tester,
        () => find.byType(SwarmScreen).evaluate().isNotEmpty,
        reason: 'signing in again restores the workspace',
      );

      // Explicit sign-out returns to the required sign-in page.
      await openMenu();
      await tester.tap(find.byKey(const ValueKey('account-menu-signOut')));
      await _until(
        tester,
        () => app.isGuest && !app.signingOut,
        reason: 'Sign out signs out',
        limit: const Duration(seconds: 20),
      );
      await _until(
        tester,
        () => find.byType(SignInStep).evaluate().isNotEmpty,
        reason: 'sign-out requires sign-in again',
      );
      await tester.pump(const Duration(milliseconds: 600));
      expect(find.byType(SwarmScreen), findsNothing);
      expect(find.text('Skip'), findsNothing);
      expect(find.text('Sign in to continue.'), findsOneWidget);
      await _shot(tester, '9-after-sign-out');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  testWidgets(
    'native: a shared tab says so on its select button — "Shared tab, 3 '
    'harnesses" — and keeps its "Select <name>" label',
    (tester) async {
      final daemon = _SharesDaemon(harnesses: 3);
      final shared = _SharedApp(daemon);
      addTearDown(shared.dispose);
      // The roster names the desk tab it shares: this app's active tab.
      daemon.tabId = shared.activeSwarmId;
      final projects = SwarmProjectStore();
      addTearDown(projects.dispose);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(
            notifier: shared,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await shared.sharedTabs.refresh();
      await _until(
        tester,
        () => shared.sharedTabs.state == SharedTabsState.ready,
        reason: 'the daemon\'s shares are read',
      );
      await tester.pump(const Duration(milliseconds: 600));
      expect(tester.takeException(), isNull);

      final reachable = await _rowReachable(tester);
      await _shot(tester, '10-shared-tab-mark');
      if (!reachable) {
        // Nothing outside the app can read AppKit's row: its help line is
        // `swarm_titlebar_checks.swift`'s then (C1), and this run checks
        // only that the app came up shared.
        debugPrint('Native row not reachable: the help line is not read.');
      } else {
        final buttons = await _nativeButtons(tester);
        final select = buttons['Select app'];
        expect(select, isNotNull, reason: '${buttons.keys}');
        expect(select!['help'], 'Shared tab, 3 harnesses');
      }
      await tester.pumpWidget(const SizedBox());
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
