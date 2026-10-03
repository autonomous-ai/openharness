import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/cli_login.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/auth/sign_in_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/machine_cache.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/snapshot_store.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/desk_sync.dart';
import 'package:harness_mobile/state/pane_layout_store.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/viewer/direct_auth.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/direct_link.dart';
import 'package:harness_mobile/viewer/direct_login.dart';
import 'package:harness_mobile/viewer/email_code_api.dart';
import 'package:harness_mobile/viewer/email_code_login.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';
import 'package:harness_mobile/viewer/viewer_services.dart';
import 'package:harness_mobile/ws/relay_codec.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'agent_pager_fixture.dart';
import 'viewer/fake_http.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The phone app with everything outside the process faked: the account's REST
/// API ([FakeApi]), each machine's socket ([ScriptedConn]), the sign-in
/// ([FakeSignIn], [FakeEmailLogin]) and the links to machines ([FakeLinks]).
///
/// ⚠️ **Nothing here may reach a real account, a real daemon or a real
/// `~/.harness`.** The session is kept in memory, every HTTP client answers from
/// a map ([FakeHttp]), and no [WsConn] ever dials — a [ScriptedConn] is built
/// with an address that does not resolve and never has `connect` called.

/// A machine's socket that answers each request type from [answers], and
/// remembers everything it was asked and sent.
class ScriptedConn extends PagerConn {
  ScriptedConn({this.ready = true});

  /// Whether the handshake is done — what `isReady` and `waitUntilReady` say.
  bool ready;

  /// Whether the socket has given up for good ([WsConn.isClosed]).
  bool closed = false;

  /// Request type → its reply. A type with no entry answers `{}`. Throwing
  /// stands for a refusal ([WsRequestFailure]), a timeout
  /// ([WsRequestTimeout]) or a dropped socket.
  final Map<
    String,
    FutureOr<Map<String, dynamic>> Function(Map<String, dynamic> payload)
  >
  answers = {};

  final List<(String, Map<String, dynamic>)> requests = [];
  final List<Uint8List> binaries = [];
  int redials = 0;

  /// The request types asked, in order.
  List<String> get asked => [for (final (type, _) in requests) type];

  /// The payloads of every request of [type].
  List<Map<String, dynamic>> payloadsOf(String type) => [
    for (final (asked, payload) in requests)
      if (asked == type) payload,
  ];

  @override
  bool get isReady => ready;

  @override
  bool get isClosed => closed;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {
    if (!ready) throw const WsRequestTimeout('machine_select');
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add((type, payload));
    final answer = answers[type];
    if (answer == null) return {};
    return await answer(payload);
  }

  @override
  Future<bool> sendTerminalBinary(Uint8List bytes) async {
    binaries.add(bytes);
    return true;
  }

  @override
  Future<void> forceReconnect() async => redials++;
}

/// A refusal from the machine, as `request` throws it.
WsRequestFailure refusal(String code, {String? detail}) =>
    WsRequestFailure(responseType: 'result', code: code, detail: detail);

/// The account's REST API: `/api/machines`, `/api/auth/me` and the desk.
class FakeApi extends ApiClient {
  FakeApi()
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryKeyValueStore()),
      );

  /// What `/api/machines` answers; replace to change the account, or throw
  /// from it for an account that cannot be read.
  Future<List<Machine>> Function() onMachines = () async => const [];
  int machineFetches = 0;

  Map<String, dynamic>? profile = const {
    'user': {'id': 'u1', 'email': 'pat@example.com', 'name': 'Pat'},
  };
  int profileReads = 0;

  final List<String> renamed = [];
  final List<String> deleted = [];
  Object? renameFailure;
  Object? deleteFailure;

  @override
  Future<List<Machine>> machines() {
    machineFetches++;
    return onMachines();
  }

  /// Answers `/api/auth/me` in place of [profile] when set — held open, or
  /// throwing.
  Future<Map<String, dynamic>?> Function()? onProfile;

  @override
  Future<Map<String, dynamic>?> me() async {
    profileReads++;
    final answer = onProfile;
    return answer == null ? profile : await answer();
  }

  @override
  Future<Map<String, dynamic>?> desk() async => _deskDocument;

  /// The account's tabs; null answers as a backend with no desk at all.
  List<DeskTab>? deskTabs;
  int deskRevision = 0;

  /// The desk ops this phone sent, in order.
  final List<Map<String, dynamic>> deskWrites = [];

  Map<String, dynamic>? get _deskDocument => deskTabs == null
      ? null
      : {
          'revision': deskRevision,
          'tabs': [for (final tab in deskTabs!) tab.toJson()],
        };

  @override
  Future<Map<String, dynamic>?> deskOps(List<Map<String, dynamic>> ops) async {
    final tabs = deskTabs;
    if (tabs == null) return null;
    deskWrites.addAll(ops);
    deskTabs = applyDeskOps(tabs, ops);
    deskRevision++;
    return _deskDocument;
  }

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    if (renameFailure case final failure?) throw failure;
    renamed.add('$machineId=$name');
    return name;
  }

  @override
  Future<void> deleteMachine({required String machineId}) async {
    if (deleteFailure case final failure?) throw failure;
    deleted.add(machineId);
  }
}

/// Whether the phone is signed in, as the viewer's session store would say.
class FakeSignIn implements SignInClient {
  FakeSignIn({this.signedIn = true});

  bool signedIn;

  /// Thrown by [checkStatus] when set: a session store that could not be read.
  Object? statusFailure;

  /// Held open until the test completes it.
  Completer<void>? statusGate;
  int logouts = 0;

  @override
  Future<CliAuthStatus> checkStatus() async {
    await statusGate?.future;
    if (statusFailure case final failure?) throw failure;
    return CliAuthStatus(loggedIn: signedIn);
  }

  @override
  Future<void> logout() async => logouts++;
}

/// The emailed-code and scanned-QR sign-in, with no service behind it.
class FakeEmailLogin implements EmailCodeLogin {
  final List<String> codesSent = [];
  final List<(String, String)> signIns = [];
  final List<(String, String)> scans = [];

  /// Thrown by the next sign-in when set: a wrong or expired code.
  Object? failure;

  /// Held open until the test completes it.
  Completer<void>? gate;

  @override
  DirectAuth get auth => throw UnimplementedError();

  @override
  Future<void> sendCode(String email) async => codesSent.add(email);

  @override
  Future<void> signIn({required String email, required String code}) async {
    signIns.add((email, code));
    await gate?.future;
    if (failure case final error?) throw error;
  }

  @override
  Future<void> signInWithScan(String code, {required String label}) async {
    scans.add((code, label));
    await gate?.future;
    if (failure case final error?) throw error;
  }
}

/// A viewer's services with every wire faked — see the note at the top.
class FakeViewer implements ViewerServices {
  FakeViewer(AuthSession session) : this._(session, FakeHttp({}));

  FakeViewer._(AuthSession session, this.backend)
    : keys = ViewerKeyStore(storage: MemoryKeyValueStore()),
      auth = DirectAuth(
        session: session,
        api: DirectAuthApi(config: AppConfig.dev, dio: backend.dio()),
        emailCodes: EmailCodeApi(
          config: AppConfig.dev,
          dio: FakeHttp({}).dio(),
        ),
      );

  /// The backend's auth routes, as the session's refresh reaches them. Empty,
  /// every request fails the way a dropped network does.
  final FakeHttp backend;

  @override
  final ViewerKeyStore keys;

  @override
  final DirectAuth auth;

  @override
  final FakeEmailLogin emailLogin = FakeEmailLogin();

  @override
  DirectLogin get login => throw UnimplementedError('pass a FakeSignIn');

  @override
  DirectLink get links => throw UnimplementedError('pass FakeLinks');

  @override
  RelayCodecFactory get relayCodecs =>
      (_) => throw UnimplementedError('nothing dials');

  @override
  TerminalTransportPluginFactory? get transportPlugins => null;
}

/// Links to machines, answered by the test.
class FakeLinks implements PeerLinkClient {
  CliLinkConnectResult connectResult = const CliLinkConnectResult();
  CliLinkConnectResult codeResult = const CliLinkConnectResult();
  CliLinkListResult listResult = const CliLinkListResult();
  String? unlinkError;

  final List<(String, String)> passwords = [];
  final List<(String, String, String)> codes = [];
  final List<String> unlinked = [];

  /// What each password pairing named this phone ("Dee's iPhone").
  final List<String?> labels = [];
  int lists = 0;

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
    String? label,
  }) async {
    passwords.add((machineId, password));
    labels.add(label);
    onProgress?.call('connecting');
    return connectResult;
  }

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async {
    codes.add((machineId, code, label));
    return codeResult;
  }

  @override
  Future<CliLinkListResult> list() async {
    lists++;
    return listResult;
  }

  @override
  Future<String?> unlink(String machineId) async {
    unlinked.add(machineId);
    return unlinkError;
  }
}

/// A remote machine as `/api/machines` lists it.
Machine remoteMachine(String id, {String? status = 'online', String? name}) =>
    Machine(
      machineId: id,
      authMode: MachineAuthMode.remote,
      name: name ?? 'Machine $id',
      status: status,
    );

/// An agent as a daemon sends it.
Map<String, dynamic> agentJson(
  String id, {
  String? name,
  String engine = 'claude',
  String? sessionId,
  bool terminal = true,
  String status = 'active',
  String? updatedAt,
  Map<String, dynamic>? extra,
}) => {
  'id': id,
  'name': name ?? id,
  'engine': engine,
  'sessionId': ?sessionId,
  'status': status,
  'updatedAt': ?updatedAt,
  'project': <String, dynamic>{'name': 'work', 'cwd': '/work'},
  'terminal': <String, dynamic>{'available': terminal},
  ...?extra,
};

/// What a daemon on a current CLI answers to `terminal_capabilities`.
Map<String, dynamic> capabilities({bool noTakeover = true}) => {
  'protocolVersion': 3,
  'backend': 'tmux',
  'available': true,
  'features': {
    'pasteRaw': true,
    'imagePaste': true,
    'pasteFile': true,
    'mediaPreview': true,
    'projectFolder': true,
    'noTakeover': noTakeover,
  },
};

/// Everything a [viewerApp] test reaches for.
class ViewerRig {
  ViewerRig({
    required this.app,
    required this.api,
    required this.signIn,
    required this.viewer,
    required this.links,
    required this.conns,
  });

  final AppNotifier app;
  final FakeApi api;
  final FakeSignIn signIn;
  final FakeViewer viewer;
  final FakeLinks links;

  /// One socket per machine id, made the first time the app asks for it.
  final Map<String, ScriptedConn> conns;

  ScriptedConn conn(String machineId) =>
      conns.putIfAbsent(machineId, ScriptedConn.new);
}

/// A phone app — a VIEWER, with no CLI beside it — signed out, on an account
/// whose machines [FakeApi.onMachines] lists.
///
/// [storage] is what the app keeps across launches — the layout, the last
/// agent open — held in memory. Given one, the app also keeps its machine
/// cache (in memory unless [machineCache] says otherwise) and would reach the
/// OS notification centre, which is silenced here.
ViewerRig viewerApp({
  bool signedIn = true,
  MachineCache? machineCache,
  LocalKeyValueStore? storage,
  Duration turnActivityTimeout = const Duration(seconds: 12),
}) {
  final session = AuthSession(storage: MemoryKeyValueStore());
  final viewer = FakeViewer(session);
  final signIn = FakeSignIn(signedIn: signedIn);
  final links = FakeLinks();
  final conns = <String, ScriptedConn>{};
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: session,
    configStore: null,
    cliLogin: signIn,
    peerLinks: links,
    viewer: viewer,
    paneLayoutStore: storage == null ? null : PaneLayoutStore(storage: storage),
    systemNotices: SilentSystemNotices(),
    machineCache:
        machineCache ??
        (storage == null ? null : MachineCache(store: MemorySnapshotStore())),
    turnActivityTimeout: turnActivityTimeout,
    connectionForTest: (machineId) =>
        conns.putIfAbsent(machineId, ScriptedConn.new),
  );
  final api = FakeApi();
  app.api = api;
  return ViewerRig(
    app: app,
    api: api,
    signIn: signIn,
    viewer: viewer,
    links: links,
    conns: conns,
  );
}

/// Lets every pending microtask and zero-length timer run.
Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

/// A signed-in phone whose machines — [agents]' keys — each list their agents
/// and speak the current terminal protocol, every socket up.
Future<ViewerRig> signedInWith(
  Map<String, List<String>> agents, {
  bool noTakeover = true,
  LocalKeyValueStore? storage,
  Duration turnActivityTimeout = const Duration(seconds: 12),
}) async {
  final rig = viewerApp(
    storage: storage,
    turnActivityTimeout: turnActivityTimeout,
  );
  rig.api.onMachines = () async => [
    for (final id in agents.keys) remoteMachine(id),
  ];
  for (final MapEntry(key: machineId, value: ids) in agents.entries) {
    final answers = rig.conn(machineId).answers;
    answers['agents_list'] = (_) => {
      'agents': [for (final id in ids) agentJson(id)],
    };
    answers['terminal_capabilities'] = (_) =>
        capabilities(noTakeover: noTakeover);
  }
  await rig.app.bootstrap();
  await settle();
  for (final machineId in agents.keys) {
    rig.app.connectionStatusForTest(machineId, ConnectionStatus.connected);
  }
  await settle();
  return rig;
}

var _streams = 0;

/// A stream id as a daemon mints one — the binary framing carries it as a UUID.
String newStreamId() =>
    '00000000-0000-4000-8000-${(++_streams).toString().padLeft(12, '0')}';

/// The machine answering the last open [session] sent: a stream, then its
/// first screen. Returns the stream's id.
Future<String> answerOpen(
  ViewerRig rig,
  TerminalSession session, {
  String screen = 'prompt> ',
}) async {
  final open = rig
      .conn(session.machineId)
      .opens
      .lastWhere((open) => open['agentId'] == session.agentId);
  final streamId = newStreamId();
  await rig.app.handleEventForTest(session.machineId, {
    'type': 'terminal_ready',
    'payload': {
      'requestId': open['requestId'],
      'agentId': session.agentId,
      'protocolVersion': TerminalSession.protocolVersion,
      'streamId': streamId,
    },
  });
  await rig.app.handleTerminalBinaryForTest(
    session.machineId,
    encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(utf8.encode(screen)),
        compressed: false,
        cols: 80,
        rows: 24,
      ),
    )!,
  );
  return streamId;
}

/// A person opening [agentId] on this phone, and the machine answering: the
/// session, live.
Future<TerminalSession> openAgent(
  ViewerRig rig,
  String machineId,
  String agentId,
) async {
  final opening = rig.app.selectAgent(machineId, agentId);
  await settle();
  final session = rig.app.paneOfAgent(machineId, agentId)!.session!;
  // The panel measuring itself, which is what the open waits for.
  session.reportViewport(80, 24);
  await opening;
  await answerOpen(rig, session);
  return session;
}

/// A machine event, as its socket delivers one.
Future<void> push(
  ViewerRig rig,
  String machineId,
  String type, [
  Map<String, dynamic> payload = const {},
  Map<String, dynamic> frame = const {},
]) => rig.app.handleEventForTest(machineId, {
  ...frame,
  'type': type,
  'payload': payload,
});
