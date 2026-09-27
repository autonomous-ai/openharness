import 'dart:typed_data';

import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/snapshot_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/stats/harness_stats.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';
import 'package:harness_mobile/viewer/viewer_services.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

/// Where sample mode points everything that could reach a server, should anything try: a name
/// that is reserved never to resolve (RFC 6761). Nothing in the sample is meant to get this far —
/// the machines answer in-process and [SampleApiClient] answers the rest — so this is the floor
/// under that, not the mechanism.
const sampleConfig = AppConfig(
  apiBaseUrl: 'https://sample.invalid',
  autonomousEnv: 'sample',
  localCliBaseUrl: 'http://sample.invalid',
);

/// A key-value store that forgets everything when the sample is left.
///
/// What the sample's session, links and preferences are kept in, so none of them is ever read
/// from — or written over — the real app's `~/.harness` files.
class SampleMemoryStore implements LocalKeyValueStore {
  final Map<String, String> _values = {};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

class _MemorySnapshot implements SnapshotStore {
  String? _contents;

  @override
  Future<String?> read() async => _contents;

  @override
  Future<void> write(String contents) async => _contents = contents;

  @override
  Future<void> clear() async => _contents = null;
}

/// The backend's REST calls, answered without one.
///
/// Every call the app makes of its [ApiClient] is overridden, so none of them reaches `Dio` —
/// and [sampleConfig] points `Dio` at nothing in case a call added later is not.
class SampleApiClient extends ApiClient {
  SampleApiClient({
    required super.session,
    required this.machinesOnFile,
    required this.transcribe,
  }) : super(config: sampleConfig);

  /// The sample's computers, as `/api/machines` would list them.
  final List<Machine> Function() machinesOnFile;

  /// What a voice take said — see `sample_voice.dart`.
  final Future<String> Function() transcribe;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() async => machinesOnFile();

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async => name;

  @override
  Future<void> deleteMachine({required String machineId}) async {}

  /// No desk: the sample's harnesses are in no tabs, and the phone then swipes the whole
  /// account — which is how a new account looks too.
  @override
  Future<Map<String, dynamic>?> desk() async => null;

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async =>
      null;

  @override
  Future<String> transcribeVoice(Uint8List wav, {required String lang}) =>
      transcribe();
}

/// The app's state for sample mode: the ordinary [AppNotifier], fed by machines that answer
/// in-process, with every store it keeps held in memory.
///
/// ⚠️ **No `paneLayoutStore`, on purpose.** It is what gives a notifier its files — the last
/// agent opened, the project history, search history, the machine cache — and its absence makes
/// every one of them a store that remembers for this run only. It is also what would put the
/// sample's notices in the phone's notification centre; [SilentSystemNotices] keeps them in the
/// app, as unread marks.
class SampleNotifier extends AppNotifier {
  SampleNotifier._({
    required AuthSession session,
    required ViewerServices viewer,
    required WsConn Function(String machineId) connections,
  }) : super(
         config: sampleConfig,
         authSession: session,
         configStore: null,
         viewer: viewer,
         systemNotices: SilentSystemNotices(),
         connectionForTest: connections,
       );

  factory SampleNotifier({
    required WsConn Function(String machineId) connections,
    required List<Machine> Function() machinesOnFile,
    required Future<String> Function() transcribe,
  }) {
    final storage = SampleMemoryStore();
    final session = AuthSession(storage: storage);
    final notifier = SampleNotifier._(
      session: session,
      viewer: ViewerServices(
        config: sampleConfig,
        session: session,
        keys: ViewerKeyStore(storage: storage),
      ),
      connections: connections,
    );
    notifier.api = SampleApiClient(
      session: session,
      machinesOnFile: machinesOnFile,
      transcribe: transcribe,
    );
    return notifier;
  }

  /// The sample's own counters — see [AppNotifier.stats].
  final HarnessStats _stats = HarnessStats(store: _MemorySnapshot());

  @override
  HarnessStats get stats => _stats;

  /// Tells every screen the sample's state moved.
  void changed() => notifyListeners();

  // Everything below would start real work — a sign-in, a sign-out, a fetch of the account's
  // machines, a link with a password — and the sample has none of it to do.

  @override
  Future<void> bootstrap() async {}

  @override
  Future<void> logout() async {}

  @override
  Future<void> refreshMachines() async => notifyListeners();

  @override
  Future<void> retryMachines() async => notifyListeners();

  /// The sample's computers are always reached, and their agents are already here: there is
  /// nothing to dial or re-ask when Find opens.
  @override
  Future<void> reachAllMachines() async {}

  @override
  Future<void> reloadMachineData(String machineId) async {}

  @override
  Future<String?> connectWithPassword(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
  }) async => 'Sample computers are already linked.';

  @override
  Future<String?> unlinkMachine(String machineId) async =>
      'Sample computers stay linked.';

  @override
  void dispose() {
    _stats.dispose();
    super.dispose();
  }
}
