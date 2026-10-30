// The web reads and writes Swarm chats straight from the backend
// (docs/specs/2026-10-30-web-swarm-direct.md): with no machine of the
// person's at all, the Swarm list, a project chat and the Buddy chat load and
// send; with one connected, its socket still tells the browser what changed,
// and the read it starts goes direct too. Native Desktop is unchanged.
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

const _tab = '0123456789abcdef01234567';
const _buddyChat = 'buddy-owner-lead';

/// The backend, as the browser's own sign-in reaches it: each Swarm call is
/// answered by [server] inside the backend's `{success, data|error}` envelope.
class _Backend extends ApiClient {
  _Backend(this.server)
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  final ConversationServer server;
  final calls = <String>[];

  @override
  Future<Response<dynamic>> superTabCall(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    calls.add('$method $path');
    final options = RequestOptions(path: path, method: method);
    try {
      final data = await server.request(method, path, body: body);
      return Response(
        requestOptions: options,
        statusCode: 200,
        data: {'success': true, 'data': data},
      );
    } on SuperTabFailure catch (failure) {
      return Response(
        requestOptions: options,
        statusCode: failure.statusCode == 0 ? 400 : failure.statusCode,
        data: {
          'success': false,
          'error': {'code': failure.code, 'message': failure.message},
        },
      );
    }
  }
}

/// One of the person's machines: records what it is asked, and answers a
/// relayed Swarm call as its daemon would.
class _Machine extends WsConn {
  _Machine(String id, this.server)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final ConversationServer server;
  final asked = <Map<String, dynamic>>[];

  /// Never answers in time, as a machine on a slow link.
  bool slow = false;
  @override
  bool get isReady => true;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'super_tabs') asked.add(payload);
    if (slow) throw WsRequestTimeout(type);
    if (type == 'super_tabs' && payload['action'] == 'backend') {
      return {
        'ok': true,
        'value': await server.request(
          payload['method'] as String,
          payload['path'] as String,
          body: payload['body'] as Map<String, dynamic>?,
        ),
      };
    }
    return {};
  }
}

Future<void> _until(bool Function() done, {String? what}) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (!done()) {
    if (DateTime.now().isAfter(deadline)) fail('timed out waiting: $what');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  late ConversationServer server;
  late _Backend backend;
  late Map<String, _Machine> machines;
  late AppNotifier app;

  setUp(() {
    server = buddySwarm()..state['id'] = _tab;
    giveBuddy(
      server,
      person: 'owner',
      machineId: 'studio',
      machineOwnerId: 'owner',
    );
    backend = _Backend(server);
    machines = {};
    final session = AuthSession(storage: MemoryStore());
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: session,
      configStore: null,
      viewer: ViewerServices(
        config: AppConfig.dev,
        session: session,
        keys: ViewerKeyStore(storage: MemoryStore()),
      ),
      connectionForTest: (id) => machines[id]!,
    );
    app.api = backend;
    app.currentUser = const CurrentUserProfile(
      id: 'owner',
      email: 'owner@example.com',
    );
  });
  tearDown(() => app.dispose());

  void connectMachine(String id, {bool online = true, String? kind}) {
    machines[id] = _Machine(id, server);
    app.machineStates[id] =
        MachineState(
            Machine(
              machineId: id,
              authMode: MachineAuthMode.remote,
              name: 'Studio',
              sessionKind: kind,
            ),
          )
          ..connectionStatus = online
              ? ConnectionStatus.connected
              : ConnectionStatus.disconnected
          ..nodeOnline = online;
  }

  Future<SuperTabFailure> machineRefusal(String id) async {
    try {
      await app.superTabMachineRequest(id, {
        'action': 'prepareContribution',
        'tabId': _tab,
        'scope': 'swarm',
        'operationId': 'setup-1',
      });
    } on SuperTabFailure catch (failure) {
      return failure;
    }
    fail('expected a SuperTabFailure');
  }

  test('with no machine at all, the Swarm list, a project chat and the Buddy '
      'chat load and send straight from the backend', () async {
    expect(app.machineStates, isEmpty);
    await app.superTabs.refreshTabs();
    expect(app.superTabs.discoveryError, isNull);
    expect(backend.calls, contains(startsWith('GET /api/super-tabs/list')));

    final c = await app.superTabs.open(_tab);
    await c.refresh();
    expect(c.error, isNull);
    expect(c.snapshot, isNotNull);
    expect(c.snapshot!.conversation(_buddyChat), isNotNull);

    expect(await c.select(_buddyChat), isTrue);
    expect(c.error, isNull);
    c.setDraft(_buddyChat, 'Hello from the phone');
    final sent = await c.send();
    expect(sent, isNotNull);
    expect(c.error, isNull);
    expect(
      server.messages.where((m) => m['text'] == 'Hello from the phone'),
      hasLength(1),
    );
    expect(backend.calls, contains('POST /api/super-tabs/$_tab/commands'));
  });

  test('with a machine connected, nothing goes through it: its push still '
      'starts a read, and that read is direct', () async {
    connectMachine('studio');
    app.superTabs.show(_tab);
    final c = await app.superTabs.open(_tab);
    await c.refresh();
    expect(c.error, isNull);
    final before = backend.calls.length;

    server.append('A change on the server');
    await app.handleEventForTest('studio', {
      'type': 'swarm_changed',
      'payload': {
        'tabId': _tab,
        'lastChangedAt': DateTime.now().millisecondsSinceEpoch,
        'parts': ['main'],
      },
    });
    await _until(
      () => backend.calls.length > before,
      what: 'a read after the push',
    );
    expect(
      machines['studio']!.asked.where((p) => p['action'] == 'backend'),
      isEmpty,
    );
  });

  group('an action that needs a machine says why it cannot run', () {
    test('the machine is offline', () async {
      connectMachine('studio', online: false);
      final failure = await machineRefusal('studio');
      expect(failure.code, 'MACHINE_UNAVAILABLE');
      expect(
        failure.message,
        'Studio is offline. Open Harness on it, then try again.',
      );
      expect(machines['studio']!.asked, isEmpty);
    });

    test('the machine runs a Harness Team account', () async {
      connectMachine('studio', kind: 'team');
      final failure = await machineRefusal('studio');
      expect(failure.code, 'MACHINE_UNAVAILABLE');
      expect(
        failure.message,
        'Studio runs Swarm agents for a Harness Team account, so it cannot '
        'do this for you. Use another of your machines.',
      );
      expect(machines['studio']!.asked, isEmpty);
    });

    test('the machine does not answer in time', () async {
      connectMachine('studio');
      machines['studio']!.slow = true;
      final failure = await machineRefusal('studio');
      expect(failure.code, 'MACHINE_SLOW');
      expect(
        failure.message,
        'Studio is taking too long to answer. Its connection may be slow. '
        'Try again.',
      );
    });
  });
}
