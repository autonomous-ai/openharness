import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/agent_prefetch.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/guest_app.dart';

/// An installer that exits when the test says so.
class _Install implements Process {
  final _exit = Completer<int>();
  final _out = StreamController<List<int>>();
  final _err = StreamController<List<int>>();
  void finish(int code, [String output = '']) {
    if (_exit.isCompleted) return;
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

class _FakeCliLogin extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

/// The first call answers [first]; every later call is ready.
class _Provisioner extends EnvironmentProvisioner {
  _Provisioner(this.first) : super(isMacOS: true);
  final EnvironmentReadiness first;
  var calls = 0;
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final result = calls++ == 0
        ? first
        : EnvironmentReadiness(
            steps: {
              for (final step in EnvironmentStep.values)
                step: EnvironmentStepStatus.ready,
            },
            phase: EnvironmentSetupPhase.ready,
          );
    onProgress(result);
    return result;
  }
}

EnvironmentReadiness _review(List<EnvironmentPlanItem> plan) =>
    EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.review,
      plan: plan,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AgentPrefetch', () {
    test(
      'runs the CLI recipe once, and settles when OpenCode is in place',
      () async {
        final runs = <List<String>>[];
        final install = _Install();
        final lines = <String>[];
        var installed = false;
        final prefetch = AgentPrefetch(
          start: (executable, arguments) async {
            runs.add([executable, ...arguments]);
            return install;
          },
          skip: () => false,
          installed: () => installed,
          log: lines.add,
        );
        prefetch.start();
        prefetch.start();
        await pumpEventQueue();
        expect(runs, [
          [
            '/bin/bash',
            '-c',
            'set -o pipefail; curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path',
          ],
        ]);
        final waiting = prefetch.waitFor(const Duration(seconds: 30));
        expect(waiting, isNotNull);
        installed = true;
        install.finish(0, 'Installed\n');
        await waiting;
        await pumpEventQueue();
        expect(
          lines.single,
          startsWith('OpenCode downloaded during setup in '),
        );
        expect(prefetch.waitFor(const Duration(seconds: 30)), isNull);
      },
    );

    test('starts nothing on a computer that already has an agent', () {
      var started = false;
      final prefetch = AgentPrefetch(
        start: (_, _) async {
          started = true;
          return _Install();
        },
        skip: () => true,
      )..start();
      expect(prefetch.waitFor(const Duration(seconds: 30)), isNull);
      expect(started, isFalse);
    });

    test('a download that leaves no OpenCode is logged as not finished, whatever its exit code', () async {
      final install = _Install();
      final lines = <String>[];
      final prefetch = AgentPrefetch(
        start: (_, _) async => install,
        skip: () => false,
        installed: () => false,
        log: lines.add,
      )..start();
      final waiting = prefetch.waitFor(const Duration(seconds: 30));
      install.finish(0, 'curl: (6) Could not resolve host\n');
      await waiting;
      await pumpEventQueue();
      expect(lines.single, contains('did not finish (exit 0'));
      expect(lines.single, contains('the first harness installs it instead'));
    });

    test('the wait budget counts from the download start, so a slow download delays one create at most', () {
      var now = DateTime(2026, 10, 8, 12);
      final install = _Install();
      final prefetch = AgentPrefetch(
        start: (_, _) async => install,
        skip: () => false,
        installed: () => false,
        now: () => now,
      )..start();
      expect(prefetch.waitFor(const Duration(seconds: 30)), isNotNull);
      now = now.add(const Duration(seconds: 31));
      expect(prefetch.waitFor(const Duration(seconds: 30)), isNull);
      install.finish(0);
    });

    group('a computer that already has an agent engine', () {
      late Directory home;
      setUp(() => home = Directory.systemTemp.createTempSync('prefetch-home-'));
      tearDown(() => home.deleteSync(recursive: true));
      void touch(String path) =>
          File('${home.path}/$path')..createSync(recursive: true);

      test('a bare home has none', () {
        expect(
          AgentPrefetch.alreadyHasAnAgent(home.path, prefixes: const []),
          isFalse,
        );
      });
      for (final path in [
        '.local/bin/claude',
        '.local/bin/codex',
        '.claude/settings.json',
        '.codex/config.toml',
        '.nvm/versions/node/v22.1.0/bin/codex',
        '.opencode/bin/opencode',
        '.harness/cli/cli.js',
      ]) {
        test('~/$path counts', () {
          touch(path);
          expect(
            AgentPrefetch.alreadyHasAnAgent(home.path, prefixes: const []),
            isTrue,
          );
        });
      }
    });

    test('its recipe is the CLI recipe for OpenCode, and lands where the CLI looks for it', () {
      final cli = File('../cli/src/lib/engineInstall.ts').readAsStringSync();
      final block = cli.substring(
        cli.indexOf('  opencode: {'),
        cli.indexOf('  pi: {'),
      );
      expect(block, contains("command: '${AgentPrefetch.recipe}'"));
      expect(block, contains("'.opencode/bin/opencode'"));
    });
  });

  group('starting it', () {
    Future<bool> startedFor(List<EnvironmentPlanItem> plan) async {
      var started = false;
      final app = GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCliLogin(),
        environmentProvisioner: _Provisioner(_review(plan)),
        agentPrefetch: AgentPrefetch(
          start: (_, _) async {
            started = true;
            return _Install()..finish(0);
          },
          skip: () => false,
        ),
      );
      addTearDown(app.dispose);
      await app.bootstrap();
      await pumpEventQueue();
      return started;
    }

    test('an unattended setup installing the Harness CLI starts it', () async {
      expect(await startedFor([EnvironmentPlanItem.harnessCli]), isTrue);
    });

    test('a setup that does not install the CLI does not', () async {
      expect(
        await startedFor([
          const EnvironmentPlanItem(
            step: EnvironmentStep.tmux,
            title: 'tmux',
            detail: 'managed runtime',
            command: 'install tmux',
          ),
        ]),
        isFalse,
      );
    });

    test('a setup that needs Terminal (Linux apt) does not', () async {
      expect(
        await startedFor([
          const EnvironmentPlanItem(
            step: EnvironmentStep.tmux,
            title: 'Linux host dependencies',
            detail: 'tmux',
            command: 'sudo apt-get install -y tmux',
            requiresTerminal: true,
          ),
          EnvironmentPlanItem.harnessCli,
        ]),
        isFalse,
      );
    });
  });

  group('an OpenCode create', () {
    late _Install install;
    late _Connection connection;
    late AppNotifier app;
    var installed = false;
    void machine({required bool local}) {
      const m = Machine(
        machineId: 'm',
        authMode: MachineAuthMode.remote,
        name: 'This Mac',
      );
      app.machines = [m];
      app.machineStates['m'] = MachineState(m)
        ..localOnly = local
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
    }

    setUp(() {
      installed = false;
      install = _Install();
      connection = _Connection();
      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => connection,
        agentPrefetch: AgentPrefetch(
          start: (_, _) async => install,
          skip: () => false,
          installed: () => installed,
        ),
      );
      machine(local: true);
      app.agentPrefetch!.start();
    });
    tearDown(() {
      install.finish(0);
      app.dispose();
    });

    test('on this computer waits for the download, then is sent', () async {
      final create = app.createAgent('m', engine: 'opencode', folder: '/work');
      await pumpEventQueue();
      expect(connection.creates, isEmpty);
      installed = true;
      install.finish(0);
      await create;
      expect(connection.creates.single['engine'], 'opencode');
    });

    test('stops waiting when the budget is spent, and the next create does not wait at all', () async {
      app.agentPrefetchWait = const Duration(milliseconds: 20);
      await app.createAgent('m', engine: 'opencode', folder: '/work');
      expect(connection.creates, hasLength(1));
      await app.createAgent('m', engine: 'opencode', folder: '/work');
      expect(connection.creates, hasLength(2));
    });

    test('other agents never wait for it', () async {
      await app.createAgent('m', engine: 'claude', folder: '/work');
      expect(connection.creates.single['engine'], 'claude');
    });

    test('on another machine never waits for it', () async {
      machine(local: false);
      await app.createAgent('m', engine: 'opencode', folder: '/work');
      expect(connection.creates.single['engine'], 'opencode');
    });
  });
}
