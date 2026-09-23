/// Interactive review of the real Machines UI with disposable, in-memory data.
/// Build this entrypoint, then launch with FLUTTER_TEST=1. Never used in releases.
/// Start with MACHINES_PREVIEW_EMPTY=1 or MACHINES_PREVIEW_GUEST=1 to review first use.
/// F6 simulates discovery of a second computer; its fixture password is `123456`.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/desktop_window.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:window_manager/window_manager.dart';

import '../test/support/machine_api.dart';
import '../test/support/mixed_agents.dart';
import '../test/support/password_cli.dart';

class _Cli extends PasswordCli {
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async {
    onProgress?.call('exchanging');
    await Future<void>.delayed(const Duration(seconds: 2));
    return password == '123456'
        ? CliLinkConnectResult(linkedMachineId: machineId)
        : const CliLinkConnectResult(error: 'Incorrect password. Try again.');
  }

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async {
    await Future<void>.delayed(const Duration(seconds: 2));
    return super.setRemotePassword(password);
  }
}

class _App extends AppNotifier {
  _App(_Cli cli)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLink: cli,
        peerLinks: cli,
      ) {
    api = MachineApi();
    hasNavigationRail = false;
    currentUser = const CurrentUserProfile(email: 'review@example.test');
    seedMixedAgents(this);
    stateOf('m')!.localOnly = true;
    if (Platform.environment['MACHINES_PREVIEW_EMPTY'] == '1') {
      machineStates.removeWhere((id, _) => id != 'm');
      stateOf('m')!.agents = [];
    } else {
      discover();
    }
    signedIn = Platform.environment['MACHINES_PREVIEW_GUEST'] != '1';
    machines = machineStates.values.map((m) => m.machine).toList();
  }

  void discover() {
    machineStates['mini'] =
        MachineState(
            const Machine(
              machineId: 'mini',
              name: 'Mac mini',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..nodeOnline = true
          ..needsLink = true
          ..agentLoadStatus = AgentLoadStatus.needsLink;
    machines = machineStates.values.map((m) => m.machine).toList();
    notifyListeners();
  }

  @override
  Future<MachineResources?> readMachineResources(String id) async =>
      MachineResources(
        cpuPercent: id == 'm' ? 18 : 42,
        memoryUsedBytes: (id == 'm' ? 12 : 24) * 1024.0 * 1024 * 1024,
        memoryTotalBytes: (id == 'm' ? 32 : 64) * 1024.0 * 1024 * 1024,
      );

  @override
  Future<void> retryMachines() async => notifyListeners();

  @override
  Future<void> login() async {
    await Future<void>.delayed(const Duration(seconds: 1));
    signedIn = true;
    notifyListeners();
  }

  @override
  Future<String?> connectWithPassword(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
  }) async {
    final error = await super.connectWithPassword(
      machineId,
      password,
      onProgress: onProgress,
    );
    if (error == null) {
      stateOf(machineId)!
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      notifyListeners();
    }
    return error;
  }
}

Future<void> main() async {
  if (!kUnderTest) throw StateError('Preview requires FLUTTER_TEST=1.');
  WidgetsFlutterBinding.ensureInitialized();
  newHarnessOpensInBox = true;
  final app = _App(_Cli());
  await configureDesktopWindow();
  await windowManager.setTitle(
    Platform.environment['MACHINES_PREVIEW_TITLE'] ?? 'Machines review',
  );
  runApp(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: CallbackShortcuts(
        bindings: {const SingleActivator(LogicalKeyboardKey.f6): app.discover},
        child: SwarmScreen(notifier: app, nativeTabs: true),
      ),
    ),
  );
}
