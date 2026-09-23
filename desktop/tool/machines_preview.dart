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
import 'package:harness/models/local_model.dart';
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
    _publishModels();
  }

  final _models = <Map<String, dynamic>>[
    {
      'id': 'qwen3.5',
      'name': 'Qwen 3.5',
      'state': 'available',
      'canStart': true,
      'sizeBytes': 5000000000,
    },
  ];
  int _modelJob = 0;

  void _publishModels() {
    modelManager
      ..localModels = _models.map(LocalModel.fromJson).toList()
      ..loaded = true
      ..inventoryAvailable = true;
    notifyListeners();
  }

  void finishModelDownload() {
    unawaited(controlLocalModel('m', 'qwen3.5', start: true));
  }

  void discoverModel() {
    if (_models.any((m) => m['id'] == 'gemma')) return;
    _models.add({
      'id': 'gemma',
      'name': 'Gemma',
      'state': 'available',
      'canStart': true,
    });
    _publishModels();
  }

  @override
  Future<GridModels> gridModels(String machineId) async =>
      const GridModels(gridName: 'Review', models: []);

  @override
  Future<Map<String, dynamic>> localModels(
    String machineId, {
    bool refresh = false,
  }) async => {
    'models': _models,
    'memoryBytes': 32 * 1024 * 1024 * 1024,
    'hardware': 'Apple M2',
    'busy': false,
  };

  @override
  Future<Map<String, dynamic>> controlLocalModel(
    String machineId,
    String modelId, {
    required bool start,
  }) async {
    final model = _models.firstWhere((m) => m['id'] == modelId);
    final operation = <String, dynamic>{
      'id': 'review-${++_modelJob}',
      'modelId': modelId,
      'action': start ? 'start' : 'stop',
      'stage': start ? 'verifying' : 'stopping',
      'phase': 'done',
    };
    model.addAll({
      'state': start ? 'running' : 'downloaded',
      'canStart': !start,
      'canStop': start,
      'operation': operation,
    });
    _publishModels();
    return {'operation': operation};
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
        bindings: {
          const SingleActivator(LogicalKeyboardKey.f6): app.discover,
          const SingleActivator(LogicalKeyboardKey.f7): app.finishModelDownload,
          const SingleActivator(LogicalKeyboardKey.f8): app.discoverModel,
        },
        child: SwarmScreen(notifier: app, nativeTabs: true),
      ),
    ),
  );
}
