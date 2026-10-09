import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/agent_prefetch.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/bootstrap/setup_progress.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/first_arrival.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/guest_app.dart';

/// An installer that exits when the test says so.
class _MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

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
    // Each test hands out one fake installer per process the prefetch starts, in order: OpenCode's,
    // then the one npm for Codex and Claude Code.
    AgentPrefetch prefetchWith({
      required List<_Install> installs,
      List<List<String>>? runs,
      Set<String>? inPlace,
      String? node = '/rt/node-v22/bin/node',
      List<String>? lines,
      DateTime Function()? now,
    }) {
      var next = 0;
      return AgentPrefetch(
        start: (executable, arguments) async {
          runs?.add([executable, ...arguments]);
          return installs[next++];
        },
        skip: () => false,
        installed: (engine) => inPlace?.contains(engine) ?? false,
        managedNode: () => node,
        log: lines?.add ?? (_) {},
        now: now,
        nodePoll: const Duration(milliseconds: 5),
      );
    }

    test('downloads OpenCode at once, then Codex and Claude Code with one npm through Harness\'s Node', () async {
      final runs = <List<String>>[];
      final opencode = _Install();
      final npm = _Install();
      final inPlace = <String>{};
      final lines = <String>[];
      final prefetch = prefetchWith(
        installs: [opencode, npm],
        runs: runs,
        inPlace: inPlace,
        lines: lines,
      );
      prefetch.start();
      prefetch.start();
      await pumpEventQueue();
      expect(runs, hasLength(2));
      expect(runs.first, [
        '/bin/bash',
        '-c',
        'set -o pipefail; curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path; exit \$?',
        AgentPrefetch.downloadName,
      ]);
      expect(runs.last[2], contains("export PATH='/rt/node-v22/bin':"));
      expect(runs.last[2], contains('NPM_CONFIG_PREFIX="\$HOME/.local"'));
      expect(
        runs.last[2],
        contains('npm install -g @openai/codex @anthropic-ai/claude-code'),
      );
      expect(prefetch.progress.value.total, 3);
      expect(prefetch.started, isTrue);

      inPlace.add('opencode');
      opencode.finish(0, 'Installed\n');
      await pumpEventQueue();
      expect(prefetch.progress.value.done, 1);
      expect(prefetch.waitFor('opencode', const Duration(seconds: 90)), isNull);
      expect(prefetch.waitFor('codex', const Duration(seconds: 90)), isNotNull);

      inPlace.addAll(['codex', 'claude']);
      npm.finish(0);
      await prefetch.everything;
      expect(prefetch.progress.value.finished, isTrue);
      expect(lines, [
        startsWith('OpenCode downloaded during setup in '),
        startsWith('Codex and Claude Code downloaded during setup in '),
      ]);
    });

    test(
      'waits for Harness\'s Node before npm, and gives up on it after a while',
      () async {
        var node = null as String?;
        final runs = <List<String>>[];
        final opencode = _Install()..finish(0);
        final npm = _Install();
        var next = 0;
        final installs = [opencode, npm];
        final prefetch = AgentPrefetch(
          start: (executable, arguments) async {
            runs.add([executable, ...arguments]);
            return installs[next++];
          },
          skip: () => false,
          installed: (_) => false,
          managedNode: () => node,
          nodePoll: const Duration(milliseconds: 5),
        )..start();
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(runs, hasLength(1), reason: 'no npm without Node');
        node = '/rt/bin/node';
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(runs, hasLength(2));
        npm.finish(0);
        await prefetch.everything;

        final lines = <String>[];
        final never = AgentPrefetch(
          start: (_, _) async => _Install()..finish(0),
          skip: () => false,
          installed: (_) => false,
          managedNode: () => null,
          log: lines.add,
          nodePoll: const Duration(milliseconds: 5),
          nodeWait: const Duration(milliseconds: 20),
        )..start();
        await never.everything;
        expect(lines, contains(contains("Harness's Node never arrived")));
      },
    );

    // A fresh Ubuntu (2026-10-09) has no curl until setup's apt step, which waits for a password in
    // Terminal.
    test('waits for curl before OpenCode, and counts a create\'s wait from the download', () async {
      var curl = false;
      var now = DateTime(2026, 10, 9, 12);
      final runs = <List<String>>[];
      final opencode = _Install();
      final npm = _Install();
      var next = 0;
      final installs = [opencode, npm];
      final prefetch = AgentPrefetch(
        start: (executable, arguments) async {
          runs.add([executable, ...arguments]);
          return installs[next++];
        },
        skip: () => false,
        installed: (_) => false,
        managedNode: () => null,
        curl: () => curl,
        now: () => now,
        nodePoll: const Duration(milliseconds: 5),
      )..start();
      addTearDown(prefetch.close);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(runs, isEmpty, reason: 'no OpenCode without curl');
      now = now.add(const Duration(minutes: 8));
      curl = true;
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(runs, hasLength(1));
      expect(
        runs.single[2],
        contains('curl -fsSL https://opencode.ai/install'),
      );
      expect(
        prefetch.waitFor('opencode', const Duration(minutes: 1)),
        isNotNull,
        reason: 'the minutes spent waiting for curl are not the download\'s',
      );
      opencode.finish(0);

      final lines = <String>[];
      final never = AgentPrefetch(
        start: (_, _) async => _Install()..finish(0),
        skip: () => false,
        installed: (_) => false,
        managedNode: () => null,
        curl: () => false,
        log: lines.add,
        nodePoll: const Duration(milliseconds: 5),
        nodeWait: const Duration(milliseconds: 20),
      )..start();
      await never.everything;
      expect(lines, contains(contains('curl never arrived')));
    });

    // On Linux setup waits for a Terminal password, and on a first boot its apt queues behind Ubuntu's
    // own updates: a wait that ran out meanwhile left Codex and Claude Code to two npm in two panes.
    test(
      'waits for what setup brings as long as setup runs, then a while more',
      () async {
        var now = DateTime(2026, 10, 9, 12);
        final lines = <String>[];
        final prefetch = AgentPrefetch(
          start: (_, _) async => _Install()..finish(0),
          skip: () => false,
          installed: (_) => false,
          managedNode: () => null,
          log: lines.add,
          now: () => now,
          nodePoll: const Duration(milliseconds: 5),
          nodeWait: const Duration(minutes: 5),
        )..setupRunning = true;
        addTearDown(prefetch.close);
        prefetch.start();
        now = now.add(const Duration(minutes: 30));
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(lines, isNot(contains(contains('never arrived'))));
        prefetch.setupRunning = false;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(
          lines,
          isNot(contains(contains('never arrived'))),
          reason: 'five minutes from the end of setup',
        );
        now = now.add(const Duration(minutes: 6));
        await prefetch.everything;
        expect(lines, contains(contains("Harness's Node never arrived")));
      },
    );

    test('runs OpenCode once after its download, so a pane never pays its first run', () async {
      final opencode = _Install();
      final warm = _Install();
      final runs = <List<String>>[];
      var installed = false;
      final prefetch = AgentPrefetch(
        start: (executable, args) async {
          runs.add([executable, ...args]);
          return runs.length == 1 ? opencode : warm;
        },
        skip: () => false,
        installed: (engine) => engine == 'opencode' && installed,
        managedNode: () => null,
        nodeWait: Duration.zero,
        warmOpenCode: true,
      )..start();
      await pumpEventQueue();
      installed = true;
      opencode.finish(0);
      await pumpEventQueue();
      expect(runs, hasLength(2));
      expect(runs.last.first, endsWith('/.opencode/bin/opencode'));
      expect(runs.last.sublist(1), ['--version']);
      warm.finish(0);
      await prefetch.everything;
    });

    test('names each download in a marker while it runs, for a pane that opens meanwhile', () async {
      final dir = Directory.systemTemp.createTempSync('prefetch-markers-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final opencode = _Install();
      final arguments = <List<String>>[];
      final prefetch = AgentPrefetch(
        start: (_, args) async {
          arguments.add(args);
          return opencode;
        },
        skip: () => false,
        installed: (_) => false,
        managedNode: () => null,
        nodeWait: Duration.zero,
        markerDir: () => dir.path,
      )..start();
      await pumpEventQueue();
      final marker = File('${dir.path}/downloading-opencode');
      expect(marker.readAsStringSync(), '${opencode.pid}');
      // The download's name for itself, which a pane checks the pid against.
      expect(arguments.single.last, AgentPrefetch.downloadName);
      opencode.finish(0);
      await prefetch.everything;
      expect(marker.existsSync(), isFalse);
    });

    test('a create whose pane waits for the download waits only until the download runs under its marker', () async {
      final dir = Directory.systemTemp.createTempSync('prefetch-markers-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final opencode = _Install();
      final starting = Completer<Process>();
      final prefetch = AgentPrefetch(
        start: (_, _) => starting.future,
        skip: () => false,
        installed: (_) => false,
        managedNode: () => null,
        nodePoll: const Duration(milliseconds: 5),
        markerDir: () => dir.path,
      )..start();
      // Not running yet: the pane could not see it.
      final early = prefetch.waitFor(
        'opencode',
        const Duration(minutes: 10),
        paneWaits: true,
      );
      expect(early, isNotNull);
      var handedOver = false;
      unawaited(early!.then((_) => handedOver = true));
      await pumpEventQueue();
      expect(handedOver, isFalse);
      starting.complete(opencode);
      await pumpEventQueue();
      expect(handedOver, isTrue, reason: 'the marker is written');
      expect(
        prefetch.waitFor(
          'opencode',
          const Duration(minutes: 10),
          paneWaits: true,
        ),
        isNull,
      );
      // Codex and Claude Code have no marker until setup's Node is there and their npm runs.
      expect(
        prefetch.waitFor('codex', const Duration(minutes: 10), paneWaits: true),
        isNotNull,
      );
      opencode.finish(0);
    });

    test('without a marker, a create whose pane waits for the download waits for all of it', () async {
      final dir = Directory.systemTemp.createTempSync('prefetch-markers-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final notADir = File('${dir.path}/file')..writeAsStringSync('');
      final opencode = _Install();
      final prefetch = AgentPrefetch(
        start: (_, _) async => opencode,
        skip: () => false,
        installed: (_) => false,
        managedNode: () => null,
        nodeWait: Duration.zero,
        markerDir: () => '${notADir.path}/run',
      )..start();
      await pumpEventQueue();
      var done = false;
      unawaited(
        prefetch
            .waitFor('opencode', const Duration(minutes: 10), paneWaits: true)!
            .then((_) => done = true),
      );
      await pumpEventQueue();
      expect(done, isFalse);
      opencode.finish(0);
      await pumpEventQueue();
      expect(done, isTrue);
    });

    // bash 5.1 and later (Linux), dash and zsh run a `-c` script's last command in place of the
    // shell: npm under the marker's pid then no longer carries the name the pane checks it against.
    for (final shell in ['/bin/bash', '/bin/zsh']) {
      test(
        'the npm download keeps its name while it runs ($shell)',
        skip: File(shell).existsSync() ? false : 'no $shell here',
        () async {
          final dir = Directory.systemTemp.createTempSync('prefetch-shell-');
          addTearDown(() => dir.deleteSync(recursive: true));
          final bin = Directory('${dir.path}/rt/bin')
            ..createSync(recursive: true);
          File('${bin.path}/npm').writeAsStringSync('#!/bin/sh\nsleep 2\n');
          await Process.run('chmod', ['755', '${bin.path}/npm']);
          final opencode = _Install()..finish(1);
          final prefetch = AgentPrefetch(
            // OpenCode's real download is never started here; npm is the fake above.
            start: (executable, arguments) => arguments[1].contains('npm')
                ? Process.start(executable, arguments)
                : Future.value(opencode),
            skip: () => false,
            installed: (_) => false,
            managedNode: () => '${bin.path}/node',
            nodePoll: const Duration(milliseconds: 5),
            markerDir: () => '${dir.path}/run',
            shell: shell,
          )..start();
          final marker = File('${dir.path}/run/downloading-codex');
          final deadline = DateTime.now().add(const Duration(seconds: 5));
          while (!marker.existsSync() && DateTime.now().isBefore(deadline)) {
            await Future<void>.delayed(const Duration(milliseconds: 20));
          }
          final pid = marker.readAsStringSync();
          // Past the moment the shell would have replaced itself with npm, and npm's with sleep.
          await Future<void>.delayed(const Duration(milliseconds: 600));
          final ps = await Process.run('ps', ['-p', pid, '-o', 'command=']);
          expect(ps.stdout as String, contains(AgentPrefetch.downloadName));
          await prefetch.everything;
          expect(marker.existsSync(), isFalse);
        },
      );
    }

    test('starts nothing on a computer that already has an agent', () {
      var started = false;
      final prefetch = AgentPrefetch(
        start: (_, _) async {
          started = true;
          return _Install();
        },
        skip: () => true,
      )..start();
      expect(prefetch.waitFor('opencode', const Duration(seconds: 30)), isNull);
      expect(prefetch.everything, isNull);
      expect(prefetch.started, isFalse);
      expect(started, isFalse);
    });

    test('a download that leaves no agent is logged as not finished, whatever its exit code', () async {
      final lines = <String>[];
      final opencode = _Install();
      final npm = _Install();
      final prefetch = prefetchWith(installs: [opencode, npm], lines: lines);
      prefetch.start();
      await pumpEventQueue();
      opencode.finish(0, 'curl: (6) Could not resolve host\n');
      npm.finish(0);
      await prefetch.everything;
      expect(lines.first, contains('did not finish (exit 0'));
      expect(lines.first, contains('the pane installs it instead'));
    });

    test('the wait budget counts from each download\'s start, so a slow one delays one create at most', () async {
      var now = DateTime(2026, 10, 8, 12);
      final opencode = _Install();
      final npm = _Install();
      final prefetch = prefetchWith(installs: [opencode, npm], now: () => now);
      prefetch.start();
      await pumpEventQueue();
      expect(
        prefetch.waitFor('opencode', const Duration(seconds: 30)),
        isNotNull,
      );
      now = now.add(const Duration(seconds: 31));
      expect(prefetch.waitFor('opencode', const Duration(seconds: 30)), isNull);
      expect(
        prefetch.waitFor('cursor', const Duration(seconds: 30)),
        isNull,
        reason: 'never downloaded here',
      );
      opencode.finish(0);
      npm.finish(0);
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
          managedNode: () => null,
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

    Future<GuestTestApp> tourFor({required Duration nodeWait}) async {
      final app = GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCliLogin(),
        environmentProvisioner: _Provisioner(
          _review([EnvironmentPlanItem.harnessCli]),
        ),
        agentPrefetch: AgentPrefetch(
          start: (_, _) async => _Install()..finish(0),
          skip: () => false,
          installed: (_) => false,
          managedNode: () => null,
          nodePoll: const Duration(milliseconds: 10),
          nodeWait: nodeWait,
        ),
      );
      addTearDown(app.dispose);
      await app.bootstrap();
      await pumpEventQueue();
      return app;
    }

    test(
      'the tour waits for OpenCode only; Codex and Claude Code go on behind it',
      () async {
        final app = await tourFor(nodeWait: const Duration(minutes: 5));
        final downloads = app.setupDownloads.value;
        expect(
          downloads.done,
          isTrue,
          reason: 'OpenCode is in place; the other two wait in their own panes',
        );
        expect(downloads.lines, [
          'Agents: OpenCode ✓ · Codex downloading · Claude Code downloading',
        ]);
      },
    );

    test('and lets it open once they have settled', () async {
      final app = await tourFor(nodeWait: Duration.zero);
      await app.agentPrefetch!.everything;
      await pumpEventQueue();
      final downloads = app.setupDownloads.value;
      expect(downloads.done, isTrue);
      expect(downloads.lines, ['Agents: OpenCode ✓ · Codex ✓ · Claude Code ✓']);
    });

    test('a computer with nothing to download never holds the tour', () async {
      final app = GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCliLogin(),
        environmentProvisioner: _Provisioner(
          _review([EnvironmentPlanItem.harnessCli]),
        ),
        agentPrefetch: AgentPrefetch(skip: () => true),
      );
      addTearDown(app.dispose);
      await app.bootstrap();
      expect(app.setupDownloads.value, SetupDownloads.none);
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

    const apt = EnvironmentPlanItem(
      step: EnvironmentStep.tmux,
      title: 'Linux host dependencies',
      detail: 'tmux, curl',
      command: 'sudo apt-get install -y tmux curl',
      requiresTerminal: true,
    );

    // A fresh Ubuntu VM (2026-10-09) ended setup on an empty box and installed OpenCode in its first
    // pane: about 90 s to a first result, against 55 s on a Mac.
    test('a setup that needs Terminal (Linux apt) starts it too, and opens the first tab on the agents', () async {
      var started = false;
      final store = _MemoryStore();
      final app = GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FakeCliLogin(),
        paneLayoutStore: PaneLayoutStore(storage: store),
        environmentProvisioner: _Provisioner(
          _review([apt, EnvironmentPlanItem.harnessCli]),
        ),
        agentPrefetch: AgentPrefetch(
          start: (_, _) async {
            started = true;
            return _Install()..finish(0);
          },
          skip: () => false,
          managedNode: () => null,
        ),
      );
      addTearDown(app.dispose);
      await app.bootstrap();
      await pumpEventQueue();
      expect(started, isTrue);
      expect(
        app.setupTourShowing,
        isFalse,
        reason: 'the apt step is the setup screen\'s, with its Terminal',
      );
      await app.firstArrival.restore();
      expect(
        store.values[FirstArrival.key],
        'new',
        reason: 'the first tab opens on OpenCode, Codex and Claude Code',
      );
      expect(app.agentPrefetch!.setupRunning, isTrue);
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
      // Markers are written, as on a real computer: an older CLI's create still waits.
      final markers = Directory.systemTemp.createTempSync('prefetch-markers-');
      addTearDown(() => markers.deleteSync(recursive: true));
      app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => connection,
        agentPrefetch: AgentPrefetch(
          start: (_, _) async => install,
          skip: () => false,
          installed: (_) => installed,
          managedNode: () => null,
          markerDir: () => markers.path,
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

    test('a CLI whose pane waits for the download itself gets the create once the download runs under its marker', () async {
      app.machineStates['m']!.engines.replace([
        const EngineAvailability(
          engine: 'opencode',
          installed: false,
          waitsForDownload: true,
        ),
      ]);
      await app.createAgent('m', engine: 'opencode', folder: '/work');
      expect(connection.creates.single['engine'], 'opencode');
    });

    test('an agent not downloaded during setup never waits for it', () async {
      await app.createAgent('m', engine: 'cursor', folder: '/work');
      expect(connection.creates.single['engine'], 'cursor');
    });

    test('on another machine never waits for it', () async {
      machine(local: false);
      await app.createAgent('m', engine: 'opencode', folder: '/work');
      expect(connection.creates.single['engine'], 'opencode');
    });
  });
}
