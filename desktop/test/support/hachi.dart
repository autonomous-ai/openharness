import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/hachi.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'experimental_settings.dart';

/// This computer's daemon, as Hachi meets it: every harness it creates is Hachi, under the id [nextId].
class HachiConnection extends WsConn {
  HachiConnection(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creations = <Map<String, dynamic>>[];
  final requests = <({String type, Map<String, dynamic> payload})>[];
  String nextId = 'hachi-1';
  String? creationError;

  @override
  Future<void> waitUntilReady({
    Duration timeout = const Duration(seconds: 10),
  }) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type: type, payload: Map.of(payload)));
    if (type == 'agent_create' || type == 'agent_create_status') {
      if (type == 'agent_create') creations.add(Map.of(payload));
      if (creationError != null) {
        return {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {'code': 'LAUNCH_FAILED', 'detail': creationError},
        };
      }
      return {
        'state': 'created',
        'creationId': payload['creationId'],
        'agent': {
          'id': nextId,
          'name': creations.last['name'],
          'engine': creations.last['engine'],
          'dsh': creations.last['dsh'],
          'terminal': {'available': true},
        },
      };
    }
    return {};
  }
}

/// Recorded Hachi counters, by name.
class HachiMeasurement extends ProductMeasurement {
  HachiMeasurement()
    : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});
  final counted = <String>[];
  @override
  void hachiCounted(HachiMeasure measure) => counted.add(measure.wire);
}

class HachiMemory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A signed-in window on this Mac (`m`, connected) with another computer of the account, `studio`,
/// and the account's experiments in memory.
class HachiTestApp extends AppNotifier {
  HachiTestApp._(
    this.connections,
    this.measured,
    this.settings, {
    super.agentAlerts,
  }) : super(
         config: AppConfig.dev,
         authSession: AuthSession(),
         configStore: null,
         connectionForTest: (id) => connections[id]!,
         experimentalSettingsTransport: settings,
         productMeasurement: measured,
       ) {
    hasNavigationRail = false;
    const local = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'This Mac',
    );
    const studio = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'studio',
    );
    machines = [local, studio];
    machineStates['m'] = MachineState(local)
      ..localEndpoint = LocalCliEndpoint(
        computerId: 'fixture',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
      )
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    machineStates['studio'] = MachineState(studio)
      ..agentLoadStatus = AgentLoadStatus.loaded;
    currentUser = const CurrentUserProfile(id: 'u1', email: 'u1@example.test');
  }

  factory HachiTestApp({AgentAlerts? agentAlerts}) => HachiTestApp._(
    {'m': HachiConnection('m'), 'studio': HachiConnection('studio')},
    HachiMeasurement(),
    MemoryExperimentalTransport(HachiMemory()),
    agentAlerts: agentAlerts,
  );

  final Map<String, HachiConnection> connections;
  final HachiMeasurement measured;
  final MemoryExperimentalTransport settings;
  bool installed = true;

  /// The account's switch, as another window or computer would turn it: the server's answer read.
  Future<void> serverSwitch(bool on) async {
    await settings.write('u1', ExperimentalFeature.hachi, on);
    await experimentalFeatures.refresh();
  }

  /// `~/harnesses/hachi`, without the disk: a widget test's clock never finishes real I/O.
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async => '/home/test/harnesses/${request.name}';

  @override
  Future<void> probeDsh(
    String machineId, {
    bool force = false,
    bool userAction = false,
  }) async {
    stateOf(machineId)!.dsh.replace([
      DshEntry(
        id: hachiEssential.id,
        name: hachiEssential.name,
        engine: 'claude',
        description: '',
        installed: installed,
      ),
    ]);
  }
}
