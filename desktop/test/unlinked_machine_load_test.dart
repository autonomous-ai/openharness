// An unlinked machine (every dial refused NO_PEER_LINK) beside one this app reaches. Idle, it
// costs nothing but a backed-off link retry: no agents load, no console line. Linking it, or a
// person's reload, still loads its agents at once.
//
// Measured with these fakes on main before the fix (five idle minutes, browser): the link retry
// dialled 12 times and read the device list 12 times a minute; with the connect page up, whose
// watch re-reads the machine list every 4 s, the unlinked machine was also loaded 18 times a
// minute — 36 "agents_list start" / "failed: … NO_PEER_LINK" lines.
//
// On the VM: the model under test is the same in both builds, and its Desktop half needs dart:io.
@TestOn('vm')
library;

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_log.dart';
import 'package:harness/viewer/device_log_sync.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show MemoryStore;

const _reachable = Machine(
  machineId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authMode: MachineAuthMode.remote,
  name: 'Studio',
);
const _unlinked = Machine(
  machineId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  authMode: MachineAuthMode.remote,
  name: 'Box',
);

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());

  int logReads = 0;

  @override
  Future<List<Machine>> machines() async => const [_reachable, _unlinked];

  @override
  Future<DeviceLogFetched?> deviceKeys(int since, {String? self}) async {
    logReads++;
    return (acct: 'acct', head: DevLogState.empty('acct').head, entries: []);
  }

  @override
  Future<DeviceLogAppendAnswer?> appendDeviceKey(DevLogEntry entry) async =>
      (head: null, error: null);

  @override
  Future<List<Object?>?> deviceAcks(int since) async => const [];

  @override
  Future<Map<String, int>> deviceKeysSeen() async => const {};
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

/// A connection that answers: ready, with [agents] listed.
class _Live extends WsConn {
  _Live(String machineId, this.agents)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<Map<String, dynamic>> agents;

  @override
  bool get isReady => true;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list' ? {'agents': agents} : const {};

  @override
  Future<void> close() async {}
}

/// What a dial to a machine with no link does: refused at once, and closed for good.
class _Refused extends WsConn {
  _Refused()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: _unlinked.machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  bool get isClosed => true;

  @override
  Future<void> waitUntilReady({required Duration timeout}) =>
      Future.error(StateError('NO_PEER_LINK'));

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => Future.error(Exception('NO_PEER_LINK'));

  @override
  Future<void> close() async {}
}

/// One app, a browser's or Desktop's, with both machines listed and the unlinked one refused.
class _Rig {
  _Rig(this.clock, {required bool browser}) {
    final keys = ViewerKeyStore(storage: MemoryStore());
    // The reachable machine is one this browser holds a key for.
    unawaited(keys.pin(_reachable.machineId, List.filled(32, 7)));
    clock.flushMicrotasks();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: MemoryStore()),
      configStore: null,
      localCliDiscovery: browser ? null : _Discovery(),
      viewer: browser
          ? ViewerServices(
              config: AppConfig.dev,
              session: AuthSession(storage: MemoryStore()),
              keys: keys,
            )
          : null,
      connectionForTest: _dial,
    );
    app.api = api;
    app.status = AppStatus.authenticated;
    app.adoptPoolConnectionForTest(_reachable.machineId, _studio);
  }

  final FakeAsync clock;
  late final AppNotifier app;
  final api = _Api();
  final _studio = _Live(_reachable.machineId, const []);
  int dials = 0;

  /// Once set, the unlinked machine answers its next dial.
  bool linked = false;

  WsConn _dial(String machineId) {
    if (machineId == _reachable.machineId) return _studio;
    if (linked) {
      return _Live(machineId, const [
        {'id': 'a1', 'name': 'Fix checkout flow tests'},
      ]);
    }
    dials++;
    scheduleMicrotask(() {
      app.localFailureForTest(machineId, 4404, 'NO_PEER_LINK');
      app.connectionStatusForTest(machineId, ConnectionStatus.disconnected);
    });
    return _Refused();
  }

  MachineState get box => app.stateOf(_unlinked.machineId)!;

  /// Started and settled: both listed, the reachable one connected, and the other refused for
  /// long enough that it waits for a link.
  void start() {
    unawaited(app.refreshMachines());
    clock.flushMicrotasks();
    app.onMachineConnectedForTest(_reachable.machineId);
    clock.elapse(const Duration(minutes: 1));
    expect(box.needsLink, isTrue);
  }

  void dispose() {
    app.dispose();
    clock.flushMicrotasks();
  }
}

void main() {
  late List<String> lines;
  final saved = debugPrint;
  setUp(() {
    lines = [];
    debugPrint = (message, {wrapWidth}) => lines.add(message ?? '');
  });
  tearDown(() => debugPrint = saved);

  int loads() => lines
      .where((line) => line == 'agents_list start: ${_unlinked.machineId}')
      .length;

  for (final browser in [true, false]) {
    final host = browser ? 'a browser' : 'Desktop';

    test('$host: four idle minutes load nothing and print nothing', () {
      fakeAsync((clock) {
        final rig = _Rig(clock, browser: browser)..start();
        // The connect page's watch, or any other machine-list reader.
        final watch = Timer.periodic(
          const Duration(seconds: 4),
          (_) => rig.app.rereadMachines(),
        );
        lines.clear();
        final dials = rig.dials;

        clock.elapse(const Duration(minutes: 4));

        expect(loads(), 0);
        expect(lines, isEmpty);
        // The link retry alone, 30 s apart by now.
        expect(rig.dials - dials, 8);
        watch.cancel();
        rig.dispose();
      });
    });

    test('$host: linking loads its agents without a reload', () {
      fakeAsync((clock) {
        final rig = _Rig(clock, browser: browser)..start();
        expect(rig.box.agents, isEmpty);

        rig.linked = true;
        clock.elapse(const Duration(seconds: 30));
        // What the pool reports once the retry's dial has gone through.
        rig.app.connectionStatusForTest(
          _unlinked.machineId,
          ConnectionStatus.connected,
        );
        clock.flushMicrotasks();

        expect(rig.box.needsLink, isFalse);
        expect(rig.box.agentLoadStatus, AgentLoadStatus.loaded);
        expect(rig.box.agents.map((a) => a.name), ['Fix checkout flow tests']);
        rig.dispose();
      });
    });

    test('$host: a person\'s reload still asks the machine', () {
      fakeAsync((clock) {
        final rig = _Rig(clock, browser: browser)..start();
        lines.clear();

        unawaited(rig.app.reloadMachineData(_unlinked.machineId));
        clock.flushMicrotasks();

        expect(loads(), 1);
        expect(rig.box.agentLoadStatus, AgentLoadStatus.needsLink);
        rig.dispose();
      });
    });
  }

  test('a browser\'s link retry backs off to 30 s, as Desktop\'s does', () {
    fakeAsync((clock) {
      final rig = _Rig(clock, browser: true);
      unawaited(rig.app.refreshMachines());
      clock.flushMicrotasks();
      rig.app.onMachineConnectedForTest(_reachable.machineId);
      // Past the two rounds that settle a refusal against the device list.
      clock.elapse(const Duration(seconds: 16));
      expect(rig.box.needsLink, isTrue);
      final reads = rig.api.logReads;

      final at = <int>[];
      var last = rig.dials;
      for (var second = 1; second <= 100; second++) {
        clock.elapse(const Duration(seconds: 1));
        if (rig.dials != last) {
          at.add(second);
          last = rig.dials;
        }
      }

      expect(at.first, lessThanOrEqualTo(5));
      expect(
        [for (var i = 1; i < at.length; i++) at[i] - at[i - 1]],
        [10, 20, 30, 30],
      );
      // Each refusal reads the device list once, so the reads back off with it.
      expect(rig.api.logReads - reads, 5);
      rig.dispose();
    });
  });
}
