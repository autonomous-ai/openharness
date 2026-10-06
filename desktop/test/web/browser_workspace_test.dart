@TestOn('browser')
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/core/viewer_mode.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/grid_pictures.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/web_download_button.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:web/web.dart' as web;

class _StartupApp extends AppNotifier {
  _StartupApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  bool inventoryLoaded = false;
  @override
  bool get machineInventoryLoaded => inventoryLoaded;
}

MachineState _startupMachine(
  _StartupApp app,
  String id, {
  ConnectionStatus status = ConnectionStatus.disconnected,
  bool needsLink = false,
}) {
  final machine = Machine(
    machineId: id,
    name: id,
    authMode: MachineAuthMode.remote,
  );
  app.machines.add(machine);
  final state = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = status
    ..needsLink = needsLink;
  app.machineStates[id] = state;
  return state;
}

Future<void> _mountStartup(
  WidgetTester tester,
  _StartupApp app, {
  bool web = false,
}) async {
  app.currentUser = const CurrentUserProfile(email: 'browser@example.test');
  final selected = app.selectedMachineId;
  app.newSwarm(newTabPage: true);
  app.selectedMachineId = selected;
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        chrome: web ? webWorkspaceChrome(app) : null,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pump();
}

void main() {
  testWidgets('a connected machine keeps the startup picker closed', (
    tester,
  ) async {
    final app = _StartupApp()..inventoryLoaded = true;
    _startupMachine(app, 'Unlinked machine', needsLink: true);
    final connected = _startupMachine(
      app,
      'Saved machine',
      status: ConnectionStatus.connected,
    );
    app.selectedMachineId = 'Unlinked machine';
    await _mountStartup(tester, app);
    final picker = find.byType(SwarmSearchResults);
    expect(picker, findsNothing);

    // A later network interruption must not turn into a surprise startup dialog.
    connected.connectionStatus = ConnectionStatus.disconnected;
    connected.nodeOnline = false;
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 200));
    expect(picker, findsNothing);

    // Deliberately selecting an unlinked machine still opens its setup.
    connected.connectionStatus = ConnectionStatus.connected;
    connected.nodeOnline = true;
    app.showMachinePane('Unlinked machine');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(picker, findsOneWidget);
    expect(
      tester.widget<SwarmSearchResults>(picker).search.selected?.machineId,
      'Unlinked machine',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    app.notifyListeners();
    await tester.pump();
    expect(picker, findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  for (final pending in [
    ConnectionStatus.connecting,
    ConnectionStatus.reconnecting,
  ]) {
    testWidgets('startup waits for a saved machine that is $pending', (
      tester,
    ) async {
      final app = _StartupApp()..inventoryLoaded = true;
      _startupMachine(app, 'Unlinked machine', needsLink: true);
      final saved = _startupMachine(app, 'Saved machine', status: pending);
      app.selectedMachineId = 'Unlinked machine';
      await _mountStartup(tester, app);
      expect(find.byType(SwarmSearchResults), findsNothing);
      saved.connectionStatus = ConnectionStatus.connected;
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(SwarmSearchResults), findsNothing);

      await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyM);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
      await tester.pump(const Duration(milliseconds: 200));
      expect(
        tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search
            .scopePrefix,
        '@',
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    });
  }

  group('a browser with no computer connected', () {
    Future<void> settle(WidgetTester tester, _StartupApp app) async {
      app.inventoryLoaded = true;
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
    }

    Future<void> unmount(WidgetTester tester, _StartupApp app) async {
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    }

    testWidgets('says how to connect one, not a search box', (tester) async {
      final app = _StartupApp();
      await _mountStartup(tester, app, web: true);
      await settle(tester, app);

      expect(find.byType(SwarmSearchResults), findsNothing);
      expect(find.text('Connect a computer'), findsOneWidget);
      expect(find.text('Download app'), findsWidgets);
      expect(find.text('harness login'), findsOneWidget);
      await unmount(tester, app);
    });

    testWidgets('one waiting to be linked connects from the same page', (
      tester,
    ) async {
      final app = _StartupApp();
      _startupMachine(app, 'server', needsLink: true);
      await _mountStartup(tester, app, web: true);
      await settle(tester, app);

      expect(find.byType(SwarmSearchResults), findsNothing);
      expect(find.text('Connect your computer'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Connect'), findsOneWidget);
      await unmount(tester, app);
    });
  });

  testWidgets('first visit offers machines once after discovery is complete', (
    tester,
  ) async {
    final app = _StartupApp();
    await _mountStartup(tester, app);
    final picker = find.byType(SwarmSearchResults);
    expect(picker, findsNothing);
    app.inventoryLoaded = true;
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(picker, findsOneWidget);
    expect(
      tester.widget<SwarmSearchResults>(picker).search.rows.last.title,
      'Add machine',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 200));
    expect(picker, findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets('startup offers machines when saved connections are offline', (
    tester,
  ) async {
    final app = _StartupApp()..inventoryLoaded = true;
    final machine = _startupMachine(app, 'Offline machine');
    machine.nodeOnline = false;
    app.selectedMachineId = machine.machine.machineId;
    await _mountStartup(tester, app);
    expect(find.byType(SwarmSearchResults), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  test(
    'a late model response cannot cross an account change in JavaScript',
    () {
      final pictures = GridPictures();
      addTearDown(pictures.dispose);
      final response = GridModels.fromReply({'models': []});
      pictures.adopt('machine', response);
      final oldEpoch = pictures.epochOf('machine');
      pictures.clear();
      expect(pictures.adopt('machine', response, ifEpoch: oldEpoch), isFalse);
      expect(pictures['machine'], isNull);
    },
  );

  test(
    'browser persists preferences and credentials across tab storage loss',
    () async {
      final store = HarnessFileStore.shared;
      const pref = 'test_browser_preference',
          credential = 'auth_test_browser_token';
      addTearDown(() async {
        await store.delete(pref);
        await store.delete(credential);
      });
      await store.write(pref, 'large');
      await store.write(credential, 'synthetic');
      expect(await store.readMany([pref, credential]), {
        pref: 'large',
        credential: 'synthetic',
      });
      expect(web.window.localStorage.getItem('harness.web.v1.$pref'), 'large');
      expect(
        web.window.localStorage.getItem('harness.web.v1.$credential'),
        'synthetic',
      );
      expect(
        web.window.sessionStorage.getItem('harness.web.v1.$credential'),
        isNull,
      );
      expect(await HarnessFileStore().read(credential), 'synthetic');
      await store.delete(credential);
      expect(await store.read(credential), isNull);
    },
  );

  testWidgets('the desktop workspace and command picker mount in the browser', (
    tester,
  ) async {
    expect(
      kUnderTest,
      isTrue,
      reason: 'Run with --dart-define=HARNESS_TEST=true',
    );
    expect(kViewerMode, isTrue);
    expect(hasManagedWindow, isFalse);
    expect(
      TerminalFontChoice.defaultForPlatform,
      TerminalFontChoice.robotoMono,
    );
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
      ..newSwarm(newTabPage: true);
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(notifier: app),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Harness like a boss.'), findsOneWidget);
    expect(find.byType(WebDownloadButton), findsOneWidget);
    expect(tester.takeException(), isNull);
    final tabs = app.swarms.length;
    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyT);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump(const Duration(milliseconds: 200));
    expect(app.swarms.length, tabs + 1);
    const modifier = LogicalKeyboardKey.altLeft;
    await tester.sendKeyDownEvent(modifier);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyP);
    await tester.sendKeyUpEvent(modifier);
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const ValueKey('swarm-search-input')), findsOneWidget);
    expect(find.textContaining('No harnesses yet.'), findsOneWidget);
    expect(find.textContaining('This tab is full'), findsNothing);
    expect(tester.takeException(), isNull);
    tester.view.physicalSize = const Size(390, 844);
    await tester.pump(const Duration(milliseconds: 100));
    final download = tester.getRect(find.byType(WebDownloadButton));
    expect(download.right, lessThanOrEqualTo(390));
    expect(download.top, greaterThanOrEqualTo(0));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets(
    'machine commands and link requests use the same browser picker',
    (tester) async {
      final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession())
        ..currentUser = const CurrentUserProfile(email: 'browser@example.test')
        ..newSwarm(newTabPage: true);
      const machine = Machine(
        machineId: 'browser-fixture',
        name: 'Studio machine',
        authMode: MachineAuthMode.remote,
      );
      app.machines = [machine];
      app.machineStates[machine.machineId] = MachineState(machine)
        ..nodeOnline = true
        ..needsLink = true
        ..agentLoadStatus = AgentLoadStatus.needsLink;
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: SwarmScreen(notifier: app),
        ),
      );
      await tester.pump(const Duration(milliseconds: 200));
      final input = find.byKey(const ValueKey('swarm-search-input'));
      Future<void> machinesShortcut() async {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyM);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump(const Duration(milliseconds: 200));
      }

      void expectMachines() {
        final search = tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search;
        expect(search.scopePrefix, '@');
        expect(search.rows.map((row) => row.title), contains('Studio machine'));
        expect(search.rows.last.title, 'Add machine');
        expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
        expect(find.text('Starting Harness…'), findsNothing);
      }

      for (final command in [
        'Machine connection settings',
        'Connect another machine',
      ]) {
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.keyP);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.enterText(input, '> $command');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump(const Duration(milliseconds: 200));
        expectMachines();
        await machinesShortcut();
        expect(input, findsNothing);
        await machinesShortcut();
        expectMachines();
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
      }

      // A selected unlinked machine must use that picker too, and closing it
      // must stay dismissed until the user deliberately revisits the machine.
      app.showMachinePane(machine.machineId);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expectMachines();
      expect(
        tester
            .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
            .search
            .selected
            ?.machineId,
        machine.machineId,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      app.notifyListeners();
      await tester.pump(const Duration(milliseconds: 200));
      expect(input, findsNothing);
      expect(app.isLinkPromptDismissed(machine.machineId), isTrue);
      app.showMachinePane(machine.machineId);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump();
      expectMachines();
      await tester.tap(
        find.byKey(const ValueKey('resource-action:picker.resource_connect')),
      );
      await tester.pump();
      expect(
        find.byKey(const ValueKey('remote-password-connect-field')),
        findsOneWidget,
      );
      expect(input, findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );

  testWidgets(
    'web landing keeps a large sign-in action and download visible on a phone',
    (tester) async {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
      );
      tester.view.physicalSize = const Size(390, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: LoginScreen(notifier: app),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final download = tester.getRect(find.byType(WebDownloadButton));
      // Both ways in, each a thumb's target, inside the phone's width.
      for (final provider in ['Google', 'Apple']) {
        final signIn = tester.getRect(
          find.widgetWithText(FilledButton, 'Continue with $provider'),
        );
        expect(download.bottom, lessThan(signIn.top));
        expect(signIn.right, lessThanOrEqualTo(390));
        expect(signIn.height, greaterThanOrEqualTo(56));
        expect(
          find.text('Continue with $provider').hitTestable(),
          findsOneWidget,
        );
      }
      expect(download.right, lessThanOrEqualTo(390));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );
}
