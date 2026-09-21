import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

/// Run through scripts/test-terminal-local-e2e.sh. The fixture owns every
/// service, identity, container and tmux session and cleans them up on stdin EOF.
void main() {
  final cli = Platform.environment['HARNESS_STACK_CLI_ROOT'];
  if (cli == null) {
    test(
      'isolated local and cloud terminal stack',
      () {},
      skip: 'Run scripts/test-terminal-local-e2e.sh with Docker and tmux.',
    );
    return;
  }
  late Process fixture;
  late Map<String, dynamic> config;
  final errors = StringBuffer();
  WsConn? connection;
  TerminalSession? terminal;
  final keyframes = <TerminalBinaryFrame>[];

  Future<void> until(String label, FutureOr<bool> Function() check) async {
    final deadline = DateTime.now().add(const Duration(seconds: 25));
    while (DateTime.now().isBefore(deadline)) {
      if (await check()) return;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    fail('Timed out: $label; fixture logs: ${config['logs']}\n$errors');
  }

  setUpAll(() async {
    fixture = await Process.start(
      'node',
      ['--import', 'tsx', 'scripts/local-stack-peer.ts'],
      workingDirectory: cli,
      environment: {'HARNESS_STACK_E2E': '1'},
    );
    fixture.stderr.transform(utf8.decoder).listen(errors.write);
    final ready = Completer<Map<String, dynamic>>();
    fixture.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            try {
              final value = jsonDecode(line);
              if (value is Map<String, dynamic> &&
                  value.containsKey('localPort') &&
                  !ready.isCompleted) {
                ready.complete(value);
              }
            } on FormatException {
              /* dependency diagnostics */
            }
          },
          onDone: () {
            if (!ready.isCompleted) {
              ready.completeError(StateError('Fixture exited: $errors'));
            }
          },
        );
    config = await ready.future.timeout(const Duration(minutes: 3));
  });
  tearDownAll(() async {
    await fixture.stdin.close();
    await fixture.exitCode.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        fixture.kill();
        return -1;
      },
    );
  });
  tearDown(() async {
    await terminal?.close();
    terminal?.dispose();
    terminal = null;
    await connection?.close();
    connection = null;
  });

  Future<void> connect(String route) async {
    var connected = false;
    connection = WsConn(
      wsBaseUrl: '',
      autonomousEnv: 'prod',
      machineId: config['machineId'] as String,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: fail,
      onStatus: (status) => connected = status == ConnectionStatus.connected,
      onEvent: (event) async {
        await terminal?.handleFrame(
          event['type'] as String,
          event['payload'] as Map<String, dynamic>,
        );
      },
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse(
        route == 'local'
            ? 'ws://127.0.0.1:${config['localPort']}/api/local-ws'
            : 'ws://127.0.0.1:${config['remotePort']}',
      ),
    );
    connection!.onBinaryFrame = (bytes) async {
      final frame = decodeTerminalLocal(bytes);
      if (frame != null) {
        if (frame.kind == TerminalBinaryKind.keyframe) keyframes.add(frame);
        await terminal?.handleBinary(frame);
      }
    };
    await connection!.connect();
    await until('$route connection', () => connected);
  }

  Future<Map<String, dynamic>> rpc(
    String type, [
    Map<String, dynamic> payload = const {},
  ]) => connection!.request(
    type,
    payload: payload,
    timeout: const Duration(seconds: 30),
  );
  Future<void> attach(String agentId) async {
    terminal?.dispose();
    terminal = TerminalSession(
      machineId: config['machineId'] as String,
      agentId: agentId,
      agentName: 'stack fixture',
      engineId: 'codex',
      send: (type, payload) => connection!.sendTerminalFrame(type, payload),
      sendBinary: (frame) =>
          connection!.sendTerminalBinary(encodeTerminalLocal(frame)!),
    );
    await terminal!.open(initialCols: 90, initialRows: 28);
    await until(
      'terminal keyframe',
      () =>
          terminal!.acceptsInput &&
          terminal!.terminal.buffer.getText().contains('STACK_READY'),
    );
  }

  Future<void> echo(String text) async {
    terminal!.terminal.onOutput?.call('$text\r');
    await until(
      'typed text echoed',
      () => terminal!.terminal.buffer.getText().contains('ECHO:$text'),
    );
  }

  Future<void> restartDaemon(String route) async {
    final http = HttpClient();
    try {
      final restart = await http.postUrl(
        Uri.parse('http://127.0.0.1:${config['controlPort']}/restart'),
      );
      final response = await restart.close();
      expect(response.statusCode, 200);
      await response.drain<void>();
    } finally {
      http.close(force: true);
    }
    await connection!.close();
    await connect(route);
  }

  for (final route in ['local', 'remote']) {
    test(
      '$route create, idempotent retry, input, resize, reconnect, restart and delete',
      () async {
        await connect(route);
        final request = <String, dynamic>{
          'creationId': '$route-stack-${DateTime.now().microsecondsSinceEpoch}',
          'engine': 'codex',
          'cwd': config['workspace'],
        };
        final created = await rpc('agent_create', request);
        expect(created['state'], 'created');
        final id = (created['agent'] as Map)['id'] as String;
        final retry = await rpc('agent_create', request);
        expect(
          (retry['agent'] as Map)['id'],
          id,
          reason: 'A retry must not spawn a second agent',
        );
        expect((await rpc('agents_list'))['agents'], hasLength(1));
        await attach(id);
        await echo('hello-$route-世界');
        keyframes.clear();
        terminal!.resize(110, 33);
        await until(
          'resized keyframe',
          () => keyframes.any((frame) => frame.cols == 110 && frame.rows == 33),
        );

        // Abrupt transport loss must release the old controller's lease.
        await connection!.close();
        await connect(route);
        await attach(id);
        await echo('reconnected-$route');
        final restarted = await rpc('agent_restart', {'agentId': id});
        expect((restarted['agent'] as Map)['id'], id);
        await terminal!.close();
        await attach(id);
        await echo('restarted-$route');

        // Restart only the disposable daemon. The pane and its identity survive.
        await restartDaemon(route);
        await until('agent restored after daemon restart', () async {
          final agents = (await rpc('agents_list'))['agents'] as List;
          return agents.length == 1 && (agents.single as Map)['id'] == id;
        });
        await attach(id);
        await echo('daemon-restored-$route');
        await terminal!.close();
        expect((await rpc('agent_delete', {'agentId': id}))['deleted'], isTrue);
        await until(
          'agent deleted',
          () async => ((await rpc('agents_list'))['agents'] as List).isEmpty,
        );
      },
      timeout: const Timeout(Duration(minutes: 4)),
    );
  }
  test(
    'domain harness materializes its workspace, viewer and verdict',
    () async {
      await connect('local');
      final catalog = (await rpc('dsh_list'))['dsh'] as List;
      expect(
        catalog.any(
          (row) =>
              (row as Map)['id'] == 'fixture/example' &&
              row['installed'] == true,
        ),
        isTrue,
      );
      final created = await rpc('agent_create', {
        'creationId': 'dsh-stack-${DateTime.now().microsecondsSinceEpoch}',
        'engine': 'codex',
        'cwd': config['workspace'],
        'dsh': 'fixture/example',
      });
      final id = (created['agent'] as Map)['id'] as String;
      final project = config['workspace'] as String;
      expect(
        await File('$project/example.txt').readAsString(),
        contains('Fixture artifact'),
      );
      expect(
        await File('$project/AGENTS.md').readAsString(),
        contains('Fixture instructions'),
      );
      expect(await Link('$project/.agents/skills/example').exists(), isTrue);
      Map<String, dynamic>? harness;
      await until('domain viewer advertised', () async {
        final agent =
            ((await rpc('agents_list'))['agents'] as List).single as Map;
        harness = Map<String, dynamic>.from(agent);
        return harness!['viewerUrl'] != null;
      });
      final http = HttpClient();
      try {
        final request = await http.getUrl(
          Uri.parse(harness!['viewerUrl'] as String),
        );
        final response = await request.close();
        expect(await response.transform(utf8.decoder).join(), 'Fixture viewer');
      } finally {
        http.close(force: true);
      }
      await Directory('$project/.harness').create(recursive: true);
      await File('$project/.harness/verdict.json').writeAsString(
        jsonEncode({
          'spec': 1,
          'ready': true,
          'summary': 'Fixture checked',
          'artifact': 'example.txt',
          'findings': [],
          'phases': [
            {
              'id': 'build',
              'name': 'Build',
              'state': 'done',
              'artifact': 'example.txt',
            },
          ],
        }),
      );
      await until('verdict propagated', () async {
        final agent =
            ((await rpc('agents_list'))['agents'] as List).single as Map;
        final verdict = agent['verdict'] as Map?;
        return verdict?['ready'] == true &&
            (verdict?['phases'] as List?)?.length == 1;
      });
      await restartDaemon('local');
      await until('harness restored after daemon restart', () async {
        final agents = (await rpc('agents_list'))['agents'] as List;
        if (agents.length != 1) return false;
        final agent = agents.single as Map;
        return agent['id'] == id &&
            agent['dsh'] == 'fixture/example' &&
            agent['viewerUrl'] != null &&
            (agent['verdict'] as Map?)?['ready'] == true;
      });
      final restarted = await rpc('agent_restart', {'agentId': id});
      expect((restarted['agent'] as Map)['dsh'], 'fixture/example');
      await attach(id);
      await echo('harness-restarted');
      await terminal!.close();
      await rpc('agent_delete', {'agentId': id});
      await until(
        'harness deleted',
        () async => ((await rpc('agents_list'))['agents'] as List).isEmpty,
      );
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test('remote terminal traffic crossed the encrypted backend path', () async {
    final http = HttpClient();
    try {
      final request = await http.getUrl(
        Uri.parse('http://127.0.0.1:${config['controlPort']}/stats'),
      );
      final response = await request.close();
      final stats =
          jsonDecode(await response.transform(utf8.decoder).join()) as Map;
      expect(stats['encryptedFrames'], greaterThan(10));
    } finally {
      http.close(force: true);
    }
  });

  test('daemon restarts have no uncaught exceptions', () async {
    final log = await File('${config['logs']}/daemon.log').readAsString();
    expect(log, isNot(contains('[fatal-guard]')));
  });
}
