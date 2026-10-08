import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/agent_prefetch.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// An installer that exits when the test says so.
class _Install implements Process {
  final _exit = Completer<int>();
  final _out = StreamController<List<int>>();
  final _err = StreamController<List<int>>();
  void finish(int code, [String output = '']) {
    if (output.isNotEmpty) _out.add(utf8.encode(output));
    _out.close();
    _err.close();
    _exit.complete(code);
  }

  @override
  Future<int> get exitCode => _exit.future;
  @override
  Stream<List<int>> get stdout => _out.stream;
  @override
  Stream<List<int>> get stderr => _err.stream;
  @override
  int get pid => 1;
  @override
  IOSink get stdin => throw UnimplementedError();
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) => false;
}

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
  final creates = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type != 'agent_create') return Future.value(const {});
    creates.add(payload);
    return Future.value({
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': {
        'id': 'a${creates.length}',
        'name': 'x',
        'engine': payload['engine'],
      },
    });
  }
}

void main() {
  group('AgentPrefetch', () {
    test(
      'runs the CLI recipe for OpenCode once, and settles when it exits',
      () async {
        final runs = <List<String>>[];
        final install = _Install();
        final lines = <String>[];
        final prefetch = AgentPrefetch(
          start: (executable, arguments) async {
            runs.add([executable, ...arguments]);
            return install;
          },
          installed: () => false,
          log: lines.add,
        );
        prefetch.start();
        prefetch.start();
        expect(prefetch.pending, isNotNull);
        var settled = false;
        unawaited(prefetch.pending!.then((_) => settled = true));
        await pumpEventQueue();
        expect(runs, [
          ['/bin/bash', '-c', 'curl -fsSL https://opencode.ai/install | bash'],
        ]);
        expect(settled, isFalse);
        install.finish(0, 'Installed\n');
        await prefetch.pending;
        expect(
          lines.single,
          startsWith('OpenCode downloaded during setup in '),
        );
      },
    );

    test('starts nothing when OpenCode is already there', () {
      var started = false;
      final prefetch = AgentPrefetch(
        start: (_, _) async {
          started = true;
          return _Install();
        },
        installed: () => true,
      )..start();
      expect(prefetch.pending, isNull);
      expect(started, isFalse);
    });

    test(
      'a failed download settles too, and says the first harness installs it',
      () async {
        final install = _Install();
        final lines = <String>[];
        final prefetch = AgentPrefetch(
          start: (_, _) async => install,
          installed: () => false,
          log: lines.add,
        )..start();
        install.finish(7, 'curl: (7) Failed to connect\n');
        await prefetch.pending;
        expect(lines.single, contains('exited 7'));
        expect(lines.single, contains('the first harness installs it instead'));
      },
    );
  });

  group('an OpenCode create on this computer', () {
    late _Install install;
    late _Connection connection;
    late AppNotifier app;
    setUp(() {
      install = _Install();
      connection = _Connection();
      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => connection,
        agentPrefetch: AgentPrefetch(
          start: (_, _) async => install,
          installed: () => false,
        ),
      );
      const machine = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'This Mac',
      );
      app.machines = [machine];
      app.machineStates['m'] = MachineState(machine)
        ..localOnly = true
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      app.agentPrefetch!.start();
    });
    tearDown(() => app.dispose());

    test('waits for the download beside setup, then is sent', () async {
      final create = app.createAgent('m', engine: 'opencode', folder: '/work');
      await pumpEventQueue();
      expect(connection.creates, isEmpty);
      install.finish(0);
      await create;
      expect(connection.creates.single['engine'], 'opencode');
    });

    test(
      'stops waiting after agentPrefetchWait and lets the pane install it',
      () async {
        app.agentPrefetchWait = const Duration(milliseconds: 20);
        await app.createAgent('m', engine: 'opencode', folder: '/work');
        expect(connection.creates, hasLength(1));
        install.finish(0);
      },
    );

    test('other agents never wait for it', () async {
      await app.createAgent('m', engine: 'claude', folder: '/work');
      expect(connection.creates.single['engine'], 'claude');
      install.finish(0);
    });
  });
}
