import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/widgets/swarm_switcher.dart';

class _App extends AppNotifier {
  _App() : super(config: AppConfig.dev, authSession: AuthSession(), configStore: null);

  bool loaded = false;
  @override
  bool get machineInventoryLoaded => loaded;
}

const _connectPage = Key('connect-page');

/// A host with a connect page (the browser's) shows it over the workspace
/// while no computer is connected, and never opens the machine picker unasked.
void main() {
  Future<_App> mount(
    WidgetTester tester, {
    MachineState Function(_App app)? machine,
  }) async {
    final app = _App();
    app.currentUser = const CurrentUserProfile(email: 'new@example.test');
    machine?.call(app);
    app.newSwarm(newTabPage: true);
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          chrome: WorkspaceChrome(
            leadingWidth: (_) => 0,
            leading: (_, _) => const SizedBox(),
            firstMachine: (_) => const SizedBox(key: _connectPage),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    app.loaded = true;
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    return app;
  }

  MachineState Function(_App) computer({
    bool needsLink = false,
    bool? online = true,
    ConnectionStatus status = ConnectionStatus.disconnected,
  }) => (app) {
    const machine = Machine(
      machineId: 'mac',
      name: 'Mac',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    return app.machineStates['mac'] = MachineState(machine)
      ..needsLink = needsLink
      ..nodeOnline = online
      ..connectionStatus = status;
  };

  Future<void> unmount(WidgetTester tester, _App app) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  }

  testWidgets('no computer at all: the connect page, no picker', (
    tester,
  ) async {
    final app = await mount(tester);

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.byType(SwarmSearchResults), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one waiting to be linked: the connect page, no picker', (
    tester,
  ) async {
    final app = await mount(tester, machine: computer(needsLink: true));

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.byType(SwarmSearchResults), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one coming online: no page flashes over it', (tester) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connecting),
    );

    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one connected: the workspace itself', (tester) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connected),
    );

    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });
}
