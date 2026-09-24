import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/core/models.dart';
import 'package:harness/e2ee/envelope.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  bool ready = true;
  @override
  bool get isReady => ready;
  final calls = <(String, Duration)>[];
  Map<String, dynamic> reply = {};
  Completer<Map<String, dynamic>>? pending;
  Object? failure;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, timeout));
    if (failure != null) throw failure!;
    return pending?.future ?? reply;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'readings preserve valid zero and partial data without inventing values',
    () {
      final empty = MachineResources.fromJson({});
      expect(empty.cpuPercent, isNull);
      expect(empty.memoryUsedBytes, isNull);
      final idle = MachineResources.fromJson({
        'cpuPercent': 0,
        'memoryUsedBytes': 0,
        'memoryTotalBytes': 1024,
      });
      expect(idle.cpuPercent, 0);
      expect(idle.memoryUsedBytes, 0);
      expect(idle.memoryTotalBytes, 1024);
      final partial = MachineResources.fromJson({'cpuPercent': 18.5});
      expect(partial.cpuPercent, 18.5);
      expect(partial.memoryTotalBytes, isNull);
    },
  );

  test('invalid readings stay unknown', () {
    for (final value in [-1, 101, double.nan, double.infinity, '18', null]) {
      expect(
        MachineResources.fromJson({'cpuPercent': value}).cpuPercent,
        isNull,
      );
    }
    for (final json in [
      {'memoryUsedBytes': 2, 'memoryTotalBytes': 1},
      {'memoryUsedBytes': 0, 'memoryTotalBytes': 0},
      {'memoryUsedBytes': -1, 'memoryTotalBytes': 1},
      {'memoryUsedBytes': 1, 'memoryTotalBytes': double.infinity},
      {'memoryUsedBytes': 1},
    ]) {
      final reading = MachineResources.fromJson(json);
      expect(reading.memoryUsedBytes, isNull);
      expect(reading.memoryTotalBytes, isNull);
    }
  });

  group('reading over the existing machine connection', () {
    test(
      'closing the app ignores pending stats and a closing link prompt',
      () async {
        final connection = _Connection()
          ..pending = Completer<Map<String, dynamic>>();
        final app = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          connectionForTest: (_) => connection,
        );
        app.machineStates['m'] = MachineState(
          const Machine(
            machineId: 'm',
            name: 'Fixture',
            authMode: MachineAuthMode.remote,
          ),
        )..connectionStatus = ConnectionStatus.connected;
        final read = app.readMachineResources('m');
        app.dispose();
        app.dismissLinkPrompt('m');
        connection.pending!.complete({'cpuPercent': 99});
        expect(await read, isNull);
        expect(await app.readMachineResources('m'), isNull);
        connection.close();
      },
    );
    late AppNotifier app;
    late _Connection connection;
    late MachineState machine;
    var connections = 0;
    setUp(() {
      connections = 0;
      connection = _Connection();
      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        connectionForTest: (_) {
          connections++;
          return connection;
        },
      );
      machine =
          MachineState(
              const Machine(
                machineId: 'm',
                name: 'Computer',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..nodeOnline = true
            ..connectionStatus = ConnectionStatus.connected;
      app.machineStates['m'] = machine;
    });
    tearDown(() {
      app.dispose();
      connection.close();
    });

    test('uses the encrypted RPC with a short timeout', () async {
      connection.reply = {'cpuPercent': 24};
      expect((await app.readMachineResources('m'))!.cpuPercent, 24);
      expect(connection.calls, [
        ('machine_resources', const Duration(seconds: 3)),
      ]);
      expect(encryptedDownTypes, contains('machine_resources'));
    });

    for (final change in [
      'offline',
      'unlinked',
      'disconnected',
      'removed',
      'reconnected',
    ]) {
      test(
        'ignores a delayed resource reply after the machine is $change',
        () async {
          connection.pending = Completer<Map<String, dynamic>>();
          final read = app.readMachineResources('m');
          switch (change) {
            case 'offline':
              machine.nodeOnline = false;
            case 'unlinked':
              machine.needsLink = true;
            case 'disconnected':
              machine.connectionStatus = ConnectionStatus.disconnected;
            case 'removed':
              app.machineStates.remove('m');
            case 'reconnected':
              app.onMachineConnectedForTest('m');
          }
          connection.pending!.complete({'cpuPercent': 99});
          expect(await read, isNull);
        },
      );
    }

    test('never starts a connection to missing, offline, unlinked, or shared machines', () async {
      expect(await app.readMachineResources('missing'), isNull);
      machine.nodeOnline = false;
      expect(await app.readMachineResources('m'), isNull);
      machine.nodeOnline = true;
      machine.needsLink = true;
      expect(await app.readMachineResources('m'), isNull);
      machine.needsLink = false;
      machine.connectionStatus = ConnectionStatus.disconnected;
      expect(await app.readMachineResources('m'), isNull);
      app.machineStates['m'] = MachineState(
        const Machine(
          machineId: 'm',
          name: 'Shared',
          isShared: true,
          authMode: MachineAuthMode.remote,
        ),
      )..connectionStatus = ConnectionStatus.connected;
      expect(await app.readMachineResources('m'), isNull);
      expect(connections, 0);
      expect(connection.calls, isEmpty);
    });

    test(
      'unready connections and older daemons leave readings unknown',
      () async {
        connection.ready = false;
        expect(await app.readMachineResources('m'), isNull);
        expect(connection.calls, isEmpty);
        connection.ready = true;
        connection.reply = {'error': 'UNKNOWN_TYPE'};
        expect(await app.readMachineResources('m'), isNull);
        connection.failure = TimeoutException('Older daemon');
        expect(await app.readMachineResources('m'), isNull);
      },
    );
  });
}
