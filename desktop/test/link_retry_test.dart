import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

class _Socket extends WsConn {
  _Socket()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'remote',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  int closes = 0;
  Completer<void>? closing;
  @override
  Future<void> close() async {
    closes++;
    await closing?.future;
  }
}

class _Link extends CliLink {
  final result = Completer<CliLinkConnectResult>();
  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) => result.future;
}

void main() {
  const machine = Machine(
    machineId: 'remote',
    name: 'Box',
    authMode: MachineAuthMode.remote,
  );
  late AppNotifier app;
  late _Socket socket;
  late MachineState state;
  late _Link link;
  var dials = 0;
  void setup() {
    dials = 0;
    socket = _Socket();
    link = _Link();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLink: link,
      connectionForTest: (_) {
        dials++;
        app.adoptPoolConnectionForTest('remote', socket);
        return socket;
      },
    );
    state = app.machineStates['remote'] = MachineState(machine)
      ..nodeOnline = true;
    app.machines.add(machine);
    app.adoptPoolConnectionForTest('remote', socket);
    app.localFailureForTest('remote', 4404, 'NO_PEER_LINK');
  }

  test(
    'native refused retries back off to 30 seconds and stop after linking',
    () {
      fakeAsync((clock) {
        setup();
        for (final seconds in [5, 10, 20, 30, 30]) {
          final before = dials;
          clock.elapse(Duration(seconds: seconds - 1));
          expect(dials, before);
          clock.elapse(const Duration(seconds: 1));
          expect(dials, before + 1);
        }
        expect(socket.closes, 5);
        state.needsLink = false;
        clock.elapse(const Duration(minutes: 1));
        expect(dials, 5);
        app.dispose();
        clock.flushMicrotasks();
      });
    },
  );

  for (final status in [
    ConnectionStatus.connecting,
    ConnectionStatus.reconnecting,
  ]) {
    test('a $status handshake is never closed by the link retry', () {
      fakeAsync((clock) {
        setup();
        state.connectionStatus = status;
        clock.elapse(const Duration(seconds: 35));
        expect(dials, 0);
        expect(socket.closes, 0);
        state.connectionStatus = ConnectionStatus.disconnected;
        clock.elapse(const Duration(seconds: 30));
        expect(dials, 1);
        app.dispose();
        clock.flushMicrotasks();
      });
    });
  }

  test('manual Connect bypasses backoff and is not replaced by a retry', () {
    fakeAsync((clock) {
      setup();
      final manual = app.connectTrusted(
        'remote',
        timeout: const Duration(seconds: 40),
      );
      final joined = app.connectTrusted('remote');
      expect(joined, same(manual));
      clock.flushMicrotasks();
      expect(dials, 1);
      expect(socket.closes, 1);
      clock.elapse(const Duration(seconds: 35));
      expect(dials, 1);
      expect(socket.closes, 1);
      state
        ..needsLink = false
        ..connectionStatus = ConnectionStatus.connected;
      bool? result;
      manual.then((value) => result = value);
      app.notifyListeners();
      clock.flushMicrotasks();
      expect(result, isTrue);
      app.dispose();
      clock.flushMicrotasks();
    });
  });

  test('a slow socket close is joined and cannot redial a removed machine', () {
    fakeAsync((clock) {
      setup();
      socket.closing = Completer<void>();
      clock.elapse(const Duration(seconds: 35));
      expect(socket.closes, 1);
      expect(dials, 0);
      app.machineStates.remove('remote');
      socket.closing!.complete();
      clock.flushMicrotasks();
      clock.elapse(const Duration(minutes: 1));
      expect(dials, 0);
      app.dispose();
      clock.flushMicrotasks();
    });
  });

  test('password linking owns its handshake until it finishes', () {
    fakeAsync((clock) {
      setup();
      final linking = app.connectWithPassword(
        'remote',
        'synthetic fixture password',
      );
      clock.elapse(const Duration(seconds: 35));
      expect(socket.closes, 0);
      expect(dials, 0);
      String? error;
      linking.then((value) => error = value);
      link.result.complete(
        const CliLinkConnectResult(error: 'Fixture refusal'),
      );
      clock.flushMicrotasks();
      expect(error, 'Fixture refusal');
      clock.elapse(const Duration(seconds: 30));
      expect(dials, 1);
      app.dispose();
      clock.flushMicrotasks();
    });
  });

  test('dispose stops retries and fences a pending close', () {
    fakeAsync((clock) {
      setup();
      socket.closing = Completer<void>();
      clock.elapse(const Duration(seconds: 5));
      app.dispose();
      socket.closing!.complete();
      clock.flushMicrotasks();
      clock.elapse(const Duration(minutes: 1));
      expect(dials, 0);
    });
  });
}
