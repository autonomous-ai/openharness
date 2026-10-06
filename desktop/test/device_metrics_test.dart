import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_ledger_controller.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/ws/ws_conn.dart';

import 'usage_ledger_test.dart' show FakeScanner, MemorySettings;
import 'usage_ledger_lifecycle_test.dart' show HeldScanner, tick;

class _MetricsConnection extends WsConn {
  _MetricsConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'local',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Object? session = Object();
  final frames = <Map<String, dynamic>>[];

  @override
  Object? get deviceMetricsSession => session;

  @override
  Future<bool> sendDeviceMetricsFrame(
    Object session,
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (!identical(session, this.session)) return false;
    frames.add({'type': type, 'payload': payload});
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  ({
    AppNotifier app,
    UsageLedgerController ledger,
    UsageLedgerStore store,
    _MetricsConnection connection,
  })
  fixture(LedgerScanner scanner) {
    final store = UsageLedgerStore(
      scanner: scanner,
      settings: MemorySettings(),
      snapshots: MemorySnapshotStore(),
    );
    final ledger = UsageLedgerController(stores: [store]);
    final connection = _MetricsConnection();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      usageLedger: ledger,
      connectionForTest: (_) => connection,
    )..status = AppStatus.authenticated;
    const machine = Machine(
      machineId: 'local',
      name: 'This Mac',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['local'] = MachineState(machine)..localOnly = true;
    app.ownDaemonMachineIdForTest('local');
    addTearDown(app.dispose);
    addTearDown(ledger.dispose);
    return (app: app, ledger: ledger, store: store, connection: connection);
  }

  Map<String, dynamic> command({
    String machineId = 'local',
    int? expiresAt,
  }) => {
    'requestId': 'request-one',
    'machineId': machineId,
    'schema': 1,
    'expiresAt':
        expiresAt ??
        DateTime.now().add(const Duration(seconds: 15)).millisecondsSinceEpoch,
  };
  test(
    'construction does not load, and a read never opts a provider in',
    () async {
      final scanner = FakeScanner(
        LedgerProvider.claude,
        const LedgerScanResult(),
      );
      final f = fixture(scanner);
      expect(f.ledger.loaded, false);
      expect(scanner.scans, 0);
      final reply = await f.app.metricsFromDevice('local', command());
      expect(reply, containsPair('requestId', 'request-one'));
      expect(reply?['ok'], true);
      expect(reply?['usage']['coverage'], 'unavailable');
      expect((reply?['usage'] as Map).containsKey('costUsd'), false);
      expect(scanner.scans, 0);
    },
  );
  test('wrong machine, expired request and unsigned local source are refused before loading', () async {
    final f = fixture(
      FakeScanner(LedgerProvider.claude, const LedgerScanResult()),
    );
    expect(await f.app.metricsFromDevice('remote', command()), isNull);
    expect(
      (await f.app.metricsFromDevice('local', command(expiresAt: 1)))?['ok'],
      false,
    );
    f.app.ownDaemonMachineIdForTest(null);
    expect((await f.app.metricsFromDevice('local', command()))?['ok'], false);
    expect(f.ledger.loaded, false);
  });
  test('an older daemon cannot request or receive local usage', () async {
    final f = fixture(
      FakeScanner(LedgerProvider.claude, const LedgerScanResult()),
    );
    f.connection.session = null;
    expect((await f.app.metricsFromDevice('local', command()))?['ok'], false);
    await f.app.handleEventForTest('local', {
      'type': 'dial_metrics',
      'payload': command(),
    });
    await tick();
    expect(f.ledger.loaded, false);
    expect(f.connection.frames, isEmpty);
  });
  test('an opted-in empty scan establishes zero and repeated reads reuse its cache', () async {
    final scanner = FakeScanner(
      LedgerProvider.claude,
      const LedgerScanResult(),
    );
    final f = fixture(scanner);
    await f.ledger.load();
    await f.store.setEnabled(true);
    expect(scanner.scans, 1);
    final result = await f.app.metricsFromDevice('local', command());
    expect(result?['usage']['coverage'], 'complete');
    expect(result?['usage']['costUsd'], 0);
    expect(result?['usage']['asOfMs'], isA<int>());
    await f.app.metricsFromDevice('local', command());
    expect(scanner.scans, 1);
    await f.store.setEnabled(false);
    expect(
      (await f.app.metricsFromDevice('local', command()))?['usage']['coverage'],
      'unavailable',
    );
  });
  test(
    'a pending scan does not block ordered desktop event dispatch',
    () async {
      final scanner = HeldScanner(), f = fixture(scanner);
      await f.ledger.load();
      final enabling = f.store.setEnabled(true);
      await tick();
      var dispatched = false;
      final dispatch = f.app
          .handleEventForTest('local', {
            'type': 'dial_metrics',
            'payload': command(),
          })
          .then((_) => dispatched = true);
      await tick();
      expect(dispatched, true);
      expect(scanner.replies.single.isCompleted, false);
      scanner.replies.single.complete(const LedgerScanResult());
      await enabling;
      await dispatch;
      await tick();
    },
  );
  test('shares Settings opt-in and revokes pending figures immediately on switch-off', () async {
    final scanner = HeldScanner(), f = fixture(scanner);
    await f.ledger.load();
    final enabling = f.store.setEnabled(true);
    await tick();
    expect(scanner.replies, hasLength(1));
    final reading = f.app.metricsFromDevice('local', command());
    await tick();
    await f.store.setEnabled(false);
    scanner.replies.single.complete(const LedgerScanResult());
    await enabling;
    final result = await reading;
    expect(result?['usage']['coverage'], 'unavailable');
    expect((result?['usage'] as Map).containsKey('costUsd'), false);
    expect(scanner.replies, hasLength(1));
  });
  test(
    'sign-out during a scan cannot deliver the previous session snapshot',
    () async {
      final scanner = HeldScanner(), f = fixture(scanner);
      await f.ledger.load();
      final enabling = f.store.setEnabled(true);
      await tick();
      final reading = f.app.metricsFromDevice('local', command());
      await tick();
      f.app.status = AppStatus.unauthenticated;
      scanner.replies.single.complete(const LedgerScanResult());
      await enabling;
      expect((await reading)?['ok'], false);
    },
  );
  for (final supportedAfterReconnect in [false, true]) {
    test(
      'a pending scan cannot reply on a replacement socket (capable=$supportedAfterReconnect)',
      () async {
        final scanner = HeldScanner(), f = fixture(scanner);
        await f.ledger.load();
        final enabling = f.store.setEnabled(true);
        await tick();
        final reading = f.app.metricsFromDevice('local', command());
        await f.app.handleEventForTest('local', {
          'type': 'dial_metrics',
          'payload': command(),
        });
        await tick();
        f.connection.session = supportedAfterReconnect ? Object() : null;
        scanner.replies.single.complete(const LedgerScanResult());
        await enabling;
        expect((await reading)?['ok'], false);
        await tick();
        expect(f.connection.frames, isEmpty);
      },
    );
  }
}
