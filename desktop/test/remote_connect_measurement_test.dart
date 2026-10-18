import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// Records each measured connection and how it ended, instead of reporting it.
class _Recorder extends ProductMeasurement {
  _Recorder() : super(surface: 'desktop', automatic: false, sendSetup: (_) async => {});

  final started = <String>[];
  final ended = <String>[];
  final healthCounts = <ProductHealthMeasure>[];

  @override
  bool get healthEnabled => true;
  @override
  bool get sharing => true;
  @override
  void health(ProductHealthMeasure measure) => healthCounts.add(measure);

  @override
  void Function(ProductOutcome) begin(ProductFlow flow) {
    started.add(flow.name);
    return (outcome) => ended.add('${flow.name}:${outcome.name}');
  }
}

/// A daemon that answers every request with nothing: connecting loads the machine's data.
class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'remote',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {};

  int forceReconnects = 0;

  /// What the redial reports through the pool, played by the test.
  void Function()? onForceReconnect;

  @override
  Future<void> forceReconnect() async {
    forceReconnects++;
    onForceReconnect?.call();
  }
}

/// A remote machine that is not linked is redialled every five seconds by the
/// link retry, and its daemon refuses each dial at once (4404 NO_PEER_LINK).
/// Measured per tick, that read as ~720 failed connections an hour per unlinked
/// machine: prod's first day showed 1,197 of 1,233 remote connects "failed",
/// almost all under a second. One refusal is one failed connection.
void main() {
  late AppNotifier app;
  late _Recorder usage;
  late _Daemon daemon;
  const mid = 'remote';

  setUp(() {
    usage = _Recorder();
    daemon = _Daemon();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      productMeasurement: usage,
      connectionForTest: (_) => daemon,
    );
    const machine = Machine(
      machineId: mid,
      name: 'Box',
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    app.machineStates[mid] = MachineState(machine)..nodeOnline = true;
    // Connections are measured only for a signed-in account.
    app
      ..status = AppStatus.authenticated
      ..currentUser = const CurrentUserProfile(id: 'u1', email: 'u1@example.test');
    app.notifyListeners();
  });

  tearDown(() => app.dispose());

  test('a machine refused for want of a link counts one failure, not one per retry', () {
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    // WsConn reports the refusal before the close (WsConn._onDone).
    app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
    app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    expect(usage.ended, ['connectAuto:failed', 'remoteConnect:failed']);

    // Three link-retry ticks: closeMachine, then a dial refused again.
    for (var tick = 0; tick < 3; tick++) {
      app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
      app.connectionStatusForTest(mid, ConnectionStatus.connecting);
      app.localFailureForTest(mid, 4404, 'NO_PEER_LINK');
      app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    }
    expect(usage.ended, ['connectAuto:failed', 'remoteConnect:failed']);
    expect(usage.healthCounts.where((m) => m == ProductHealthMeasure.connectErrorUnlinked), hasLength(1));

    // Linked: the next dial is measured again, and succeeds.
    app.stateOf(mid)!.needsLink = false;
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.connected);
    expect(usage.ended, ['connectAuto:failed', 'remoteConnect:failed', 'connectAuto:ok', 'remoteConnect:ok']);
  });

  test('an ordinary offline machine still counts each dial that ends', () {
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
    app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
    app.connectionStatusForTest(mid, ConnectionStatus.disconnected);
    app.connectionStatusForTest(mid, ConnectionStatus.connecting);
    app.connectionStatusForTest(mid, ConnectionStatus.connected);
    expect(usage.ended.where((event) => event.startsWith('remoteConnect:')),
        ['remoteConnect:failed', 'remoteConnect:ok']);
  });

  // #1378's dead panes redial their machine's link when an open goes unanswered. Each redial took a
  // connected link to `connecting` and was counted as a new remote_connect.
  test(
    'a forced redial of a connected machine is not a new connection',
    () async {
      app.connectionStatusForTest(mid, ConnectionStatus.connecting);
      app.connectionStatusForTest(mid, ConnectionStatus.connected);
      usage.started.clear();
      // WsConn.forceReconnect drops the link and dials it again from the first attempt.
      daemon.onForceReconnect = () {
        app.connectionStatusForTest(mid, ConnectionStatus.connecting);
        app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
        app.connectionStatusForTest(mid, ConnectionStatus.connected);
      };
      await app.forceRedialForTest(mid);
      daemon.onForceReconnect = null;

      expect(daemon.forceReconnects, 1);
      expect(usage.started, isEmpty);

      // A socket that drops and is dialled back is measured as before.
      app.connectionStatusForTest(mid, ConnectionStatus.reconnecting);
      app.connectionStatusForTest(mid, ConnectionStatus.connected);
      expect(usage.started, ['connectAuto', 'remoteConnect']);
      expect(usage.ended.where((event) => event.startsWith('remoteConnect:')), [
        'remoteConnect:ok',
        'remoteConnect:ok',
      ]);
    },
  );

  test('a machine is redialled at most once in the window', () async {
    var now = Duration.zero;
    app.redialClock = () => now;

    await app.forceRedialForTest(mid);
    now += const Duration(seconds: 29);
    await app.forceRedialForTest(mid);
    expect(daemon.forceReconnects, 1);

    now += const Duration(seconds: 1);
    await app.forceRedialForTest(mid);
    expect(daemon.forceReconnects, 2);
  });

  // A real pool, because what a replaced socket reports is the pool's to deliver or drop: Connect
  // closes the socket the app is redialling, and the pool stops listening to it first
  // (WsPool.connFor's ownsMachine), so the close never ends the attempt as failed.
  test('Connect while the app is redialling neither fails nor restarts the attempt', () async {
    final pooledUsage = _Recorder();
    final pooled = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      productMeasurement: pooledUsage,
    );
    addTearDown(pooled.dispose);
    const machine = Machine(
      machineId: mid,
      name: 'Box',
      authMode: MachineAuthMode.remote,
    );
    pooled.machines.add(machine);
    pooled.machineStates[mid] = MachineState(machine)..nodeOnline = true;
    pooled
      ..status = AppStatus.authenticated
      ..currentUser = const CurrentUserProfile(
        id: 'u1',
        email: 'u1@example.test',
      );
    pooled.notifyListeners();
    // This computer's daemon, at a loopback port nothing listens on (1): every dial is refused.
    pooled.ownDaemonMachineIdForTest('this-computer');
    // Any socket makes the pool; this one is never dialled.
    pooled.adoptPoolConnectionForTest('unused', _Daemon());

    // The first dial is refused and the socket goes on redialling on its own.
    expect(
      await pooled.connectTrusted(
        mid,
        timeout: const Duration(milliseconds: 300),
      ),
      isFalse,
    );
    for (var wait = 0; wait < 50; wait++) {
      if (pooled.stateOf(mid)!.connectionStatus ==
          ConnectionStatus.reconnecting) {
        break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(
      pooled.stateOf(mid)!.connectionStatus,
      ConnectionStatus.reconnecting,
    );
    // Connect again, mid-redial: the socket is closed and replaced.
    expect(
      await pooled.connectTrusted(
        mid,
        timeout: const Duration(milliseconds: 300),
      ),
      isFalse,
    );

    expect(
      pooledUsage.started.where((flow) => flow == 'remoteConnect'),
      hasLength(1),
    );
    expect(
      pooledUsage.ended.where((event) => event.startsWith('remoteConnect:')),
      isEmpty,
    );
  });
}
