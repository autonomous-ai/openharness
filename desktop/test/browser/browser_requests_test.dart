import 'package:flutter_test/flutter_test.dart';
import 'package:harness/browser/browser_availability.dart';
import 'package:harness/browser/browser_settings.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import '../swarm_state_test.dart' show createApp;

/// A machine's daemon as the browser requests see it: each request is recorded
/// and answered by [reply], or refused by [failure].
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final requests = <({String type, Map<String, dynamic> payload})>[];
  Map<String, dynamic> reply = const {};
  Object? failure;

  @override
  bool get isReady => true;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (!type.startsWith('agent_browser') && type != 'agent_create') {
      return const {};
    }
    requests.add((type: type, payload: Map.of(payload)));
    if (failure case final failure?) throw failure;
    return reply;
  }
}

const _saved = {
  'proxy': {
    'scheme': 'socks5',
    'host': 'proxy.example',
    'port': 1080,
    'username': 'ken',
    'passwordSet': true,
  },
  'timeZone': null,
  'languages': 'vi-VN, en-US',
  'screen': '1920x1080',
  'humanInput': true,
  'humanSpeed': 'normal',
  'device': null,
};

void main() {
  late _Daemon daemon;
  late AppNotifier app;
  setUp(() {
    daemon = _Daemon();
    app = createApp(connectionForTest: (_) => daemon, connected: true);
  });
  tearDown(() => app.dispose());

  test('available reads each state, with ownMachine', () async {
    daemon.reply = {'state': 'needs_setup', 'ownMachine': true};
    final setup = await app.agentBrowserAvailable('m');
    expect(daemon.requests.single.type, 'agent_browser_available');
    expect(setup.state, BrowserAvailability.needsSetup);
    expect(setup.ownMachine, isTrue);
    for (final state in ['ready', 'stopped', 'podman_old', 'podman_memory']) {
      daemon.reply = {'state': state};
      final answer = await app.agentBrowserAvailable('m');
      expect(answer.state, state);
      expect(answer.ownMachine, isFalse);
    }
  });

  test('available maps UNSUPPORTED to unsupported, and a service error or a '
      'timeout to unavailable', () async {
    daemon.failure = const WsRequestFailure(
      responseType: 'agent_browser_available_result',
      code: 'UNSUPPORTED',
    );
    expect(
      (await app.agentBrowserAvailable('m')).state,
      BrowserAvailability.unsupported,
    );
    for (final failure in [
      const WsRequestFailure(
        responseType: 'agent_browser_available_result',
        code: 'SERVICE_UNAVAILABLE',
      ),
      const WsRequestFailure(
        responseType: 'agent_browser_available_result',
        code: 'SERVICE_FAILED',
      ),
      const WsRequestTimeout('agent_browser_available'),
    ]) {
      daemon.failure = failure;
      expect(
        (await app.agentBrowserAvailable('m')).state,
        BrowserAvailability.unavailable,
      );
    }
    // A state this build does not know is not taken for one it does.
    daemon
      ..failure = null
      ..reply = {'state': 'later_state'};
    expect(
      (await app.agentBrowserAvailable('m')).state,
      BrowserAvailability.unavailable,
    );
  });

  test('setup and retry send their requests', () async {
    daemon.reply = {'ok': true};
    await app.agentBrowserSetup('m');
    await app.agentBrowserRetry('m', 'a1');
    expect(daemon.requests.map((r) => r.type), [
      'agent_browser_setup',
      'agent_browser_retry',
    ]);
    expect(daemon.requests.map((r) => r.payload), [
      isEmpty,
      {'agentId': 'a1'},
    ]);
  });

  test('settings read the saved settings, and a save sends them and reads '
      'the answer', () async {
    daemon.reply = _saved;
    final settings = await app.agentBrowserSettings('m', 'a1');
    expect(daemon.requests.single.type, 'agent_browser_settings');
    expect(daemon.requests.single.payload, {'agentId': 'a1'});
    expect(settings.proxy!.host, 'proxy.example');
    expect(settings.proxy!.passwordSet, isTrue);
    expect(settings.timeZone, isNull);
    expect(settings.languages, 'vi-VN, en-US');

    final saved = await app.agentBrowserSettingsSave(
      'm',
      'a1',
      settings.toSave(),
    );
    final save = daemon.requests.last;
    expect(save.type, 'agent_browser_settings_save');
    expect(save.payload['agentId'], 'a1');
    expect(save.payload['settings'], settings.toSave());
    expect(saved.screen, '1920x1080');
  });

  test('a proxy test reads the address and zone, or that it failed', () async {
    const proxy = {
      'scheme': 'http',
      'host': 'proxy.example',
      'port': 8080,
      'username': '',
    };
    daemon.reply = {
      'ok': true,
      'address': '203.0.113.7',
      'timeZone': 'Asia/Ho_Chi_Minh',
    };
    final works = await app.agentBrowserProxyTest('m', 'a1', proxy);
    expect(daemon.requests.single.type, 'agent_browser_proxy_test');
    expect(daemon.requests.single.payload, {'agentId': 'a1', 'proxy': proxy});
    expect(works.ok, isTrue);
    expect(works.address, '203.0.113.7');
    expect(works.timeZone, 'Asia/Ho_Chi_Minh');
    daemon.reply = {'ok': false};
    final fails = await app.agentBrowserProxyTest('m', 'a1', proxy);
    expect(fails.ok, isFalse);
    expect(fails.address, isNull);
  });

  test('nothing is sent to a machine shared with this account, or one that '
      'is not connected', () async {
    app.machineStates['m'] =
        MachineState(
            const Machine(
              machineId: 'm',
              authMode: MachineAuthMode.remote,
              machineShare: MachineShare(
                ownerName: 'Lee',
                ownerEmail: 'lee@example.com',
                via: 'person',
                added: true,
              ),
            ),
          )
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
    await expectLater(app.agentBrowserRetry('m', 'a1'), throwsStateError);
    app.machineStates['m'] = MachineState(
      const Machine(machineId: 'm', authMode: MachineAuthMode.remote),
    )..connectionStatus = ConnectionStatus.disconnected;
    await expectLater(app.agentBrowserSettings('m', 'a1'), throwsStateError);
    expect(
      (await app.agentBrowserAvailable('m')).state,
      BrowserAvailability.unavailable,
    );
    expect(daemon.requests, isEmpty);
  });

  test('createAgent sends browser:true only when asked', () async {
    daemon.reply = {'state': 'failed'};
    await app.createAgent('m', engine: 'claude', folder: '/work');
    expect(daemon.requests.last.payload.containsKey('browser'), isFalse);
    await app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      browser: true,
    );
    expect(daemon.requests.last.payload['browser'], isTrue);
  });
}
