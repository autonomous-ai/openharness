import 'dart:async';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

class ModelManagerConnection extends WsConn {
  ModelManagerConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creations = <Map<String, dynamic>>[];
  Completer<void>? holdCreation;
  bool loseFirstReply = false;
  String? creationError;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'agent_create' || type == 'agent_create_status') {
      if (type == 'agent_create') creations.add(Map.of(payload));
      await holdCreation?.future;
      if (creationError != null) {
        return {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {'code': 'LAUNCH_FAILED', 'detail': creationError},
        };
      }
      if (type == 'agent_create' && loseFirstReply) {
        loseFirstReply = false;
        throw const WsRequestTimeout('agent_create');
      }
      final choice = creations.last;
      return {
        'state': 'created',
        'creationId': payload['creationId'],
        'agent': {
          'id': choice['dsh'] == null ? 'local-session' : 'manager',
          'name': choice['name'],
          'engine': 'codex',
          'dsh': choice['dsh'],
          'terminal': {'available': true},
        },
      };
    }
    return {};
  }
}

class ModelManagerTestApp extends AppNotifier {
  ModelManagerTestApp(this.connection)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => connection,
      ) {
    hasNavigationRail = false;
    const local = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'This Mac',
    );
    const remote = Machine(
      machineId: 'other',
      authMode: MachineAuthMode.remote,
      name: 'Other computer',
    );
    machines = [local, remote];
    machineStates['m'] = MachineState(local)
      ..localOnly = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    machineStates['other'] = MachineState(remote)
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }
  final ModelManagerConnection connection;
  bool installed = true;
  String? installError, probeError, resumeError;
  bool resumeThrows = false;
  int localReads = 0, resumes = 0, gridReads = 0;
  Completer<Map<String, dynamic>>? localReply;
  Completer<void>? probeReply;
  String? sendError;
  int installs = 0;
  GridModels inventory = const GridModels(gridName: 'home', models: []);
  final sent = <({String id, String machine, String task})>[];

  Map<String, dynamic> localInventory = modelInventory();
  final machineInventories = <String, Map<String, dynamic>>{};
  final inventoryReads = <String>[];
  Map<String, dynamic> inventoryFor(String machineId) =>
      machineInventories[machineId] ??
      (machineId == 'm' ? localInventory : {'models': <Object>[]});
  void setInventoryFor(String machineId, Map<String, dynamic> value) {
    if (machineId == 'm') {
      localInventory = value;
    } else {
      machineInventories[machineId] = value;
    }
  }

  final actions = <({String machine, String model, bool start})>[];
  final downloads = <({String machine, String model})>[];

  @override
  Future<Map<String, dynamic>> downloadLocalModel(
    String machineId,
    String modelId,
  ) async {
    downloads.add((machine: machineId, model: modelId));
    final inventory = inventoryFor(machineId);
    final operation = <String, dynamic>{
      'id': 'download',
      'modelId': modelId,
      'action': 'download',
      'stage': 'downloading',
      'phase': 'running',
      'progress': .42,
    };
    setInventoryFor(machineId, {
      ...inventory,
      'busy': true,
      'models': [
        for (final raw in inventory['models'] as List)
          if (raw['id'] == modelId)
            {...raw as Map<String, dynamic>, 'operation': operation}
          else
            raw,
      ],
    });
    return {'operation': operation};
  }

  bool localReadFails = false, actionReplyLost = false;
  Completer<Map<String, dynamic>>? actionReply;
  @override
  Future<Map<String, dynamic>> localModels(
    String machineId, {
    bool refresh = false,
  }) async {
    localReads++;
    inventoryReads.add(machineId);
    final held = localReply;
    if (held != null) {
      localReply = null;
      return held.future;
    }
    if (localReadFails) throw StateError('offline');
    return inventoryFor(machineId);
  }

  @override
  Future<Map<String, dynamic>> controlLocalModel(
    String machineId,
    String modelId, {
    required bool start,
  }) async {
    actions.add((machine: machineId, model: modelId, start: start));
    final inventory = inventoryFor(machineId);
    if (actionReply != null) return actionReply!.future;
    final operation = <String, dynamic>{
      'id': 'operation',
      'modelId': modelId,
      'action': start ? 'start' : 'stop',
      'stage': start ? 'downloading' : 'stopping',
      'phase': 'running',
      if (start) 'progress': .42,
    };
    setInventoryFor(machineId, {
      ...inventory,
      'busy': true,
      'models': [
        for (final raw in inventory['models'] as List)
          if (raw['id'] == modelId)
            {...raw as Map<String, dynamic>, 'operation': operation}
          else
            raw,
      ],
    });
    if (actionReplyLost) throw StateError('lost acknowledgement');
    return {'operation': operation};
  }

  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async => '/fixture/$label';
  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    await probeReply?.future;
    if (probeError != null) throw StateError(probeError!);
    stateOf(machineId)!.dsh.replace([
      DshEntry(
        id: AppNotifier.gridHarness,
        name: 'Model Manager',
        engine: 'codex',
        description: '',
        installed: installed,
      ),
    ]);
  }

  @override
  Future<String?> installDsh(String machineId, String harness) async {
    installs++;
    if (installError != null) return installError;
    installed = true;
    return null;
  }

  @override
  Future<GridModels> gridModels(String machineId) async {
    gridReads++;
    return inventory;
  }

  @override
  Future<RestartAgentResult> resumeAgent(
    String machineId,
    String agentId,
  ) async {
    resumes++;
    if (resumeThrows) throw StateError('resume unavailable');
    return RestartAgentResult(error: resumeError);
  }

  @override
  Future<String?> sendRoutedTask(
    String agentId,
    String agentMachineId,
    String text,
  ) async {
    sent.add((id: agentId, machine: agentMachineId, task: text));
    return sendError;
  }
}

Map<String, dynamic> modelInventory({String scenario = 'first'}) {
  final running = scenario == 'ready';
  return {
    'memoryBytes': 64 * 1024 * 1024 * 1024,
    'hardware': 'Apple M2 Max',
    'supportsDownload': true,
    'busy': scenario == 'downloading',
    'models': [
      {
        'id': 'qwen',
        'name': 'Qwen3.8-27B',
        'state': running ? 'running' : 'available',
        'sizeBytes': 16.2 * 1024 * 1024 * 1024,
        'canStart': !running,
        'canStop': running,
        'recommended': true,
        if (running) ...{
          'tokensPerSecond': 17.6,
          'requests': 42,
          'windowSeconds': 86400,
        },
        if (scenario == 'downloading' || running || scenario == 'error')
          'operation': {
            'id': 'operation',
            'modelId': 'qwen',
            'action': 'start',
            'stage': running ? 'verifying' : 'downloading',
            'phase': running
                ? 'done'
                : scenario == 'error'
                ? 'failed'
                : 'running',
            if (scenario == 'downloading') 'progress': .42,
            if (scenario == 'error')
              'error': 'The download stopped. Start again to resume.',
          },
      },
      {
        'id': 'gemma',
        'name': 'gemma-4-12B',
        'state': 'downloaded',
        'sizeBytes': 7.3 * 1024 * 1024 * 1024,
        'canStart': true,
      },
      {
        'id': 'qwen-small',
        'name': 'Qwen3.8-8B',
        'state': 'available',
        'sizeBytes': 4.8 * 1024 * 1024 * 1024,
        'canStart': true,
      },
      {
        'id': 'qwen-coder',
        'name': 'Qwen3-Coder-30B-A3B',
        'state': 'available',
        'sizeBytes': 18.6 * 1024 * 1024 * 1024,
        'canStart': true,
      },
      {
        'id': 'gpt-oss',
        'name': 'gpt-oss-20b',
        'state': 'available',
        'sizeBytes': 12.1 * 1024 * 1024 * 1024,
        'canStart': true,
      },
    ],
  };
}
