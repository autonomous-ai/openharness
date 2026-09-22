import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/repository_clone.dart';

class _DiscardInput implements StreamConsumer<List<int>> {
  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.drain<void>();
  @override
  Future<void> close() async {}
}

class _GitProcess implements Process {
  _GitProcess({String output = '', int? code = 0, List<int>? bytes})
    : stdout = Stream.value(bytes ?? utf8.encode(output)) {
    if (code != null) ended.complete(code);
  }
  final ended = Completer<int>();
  final signals = <ProcessSignal>[];
  @override
  final Stream<List<int>> stdout;
  @override
  Stream<List<int>> get stderr => const Stream.empty();
  @override
  final stdin = IOSink(_DiscardInput());
  @override
  Future<int> get exitCode => ended.future;
  @override
  int get pid => 1;
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    if (!ended.isCompleted) ended.complete(-9);
    return true;
  }
}

GitProcessStarter _commands({String? fail, String prefix = ''}) =>
    (arguments, environment) async {
      final command = arguments.skip(3).join(' ');
      if (fail != null && command.startsWith(fail)) {
        return _GitProcess(code: 1);
      }
      return _GitProcess(
        output: switch (command) {
          'rev-parse --show-toplevel' => '/repo\n',
          'rev-parse --show-prefix' => prefix,
          'symbolic-ref --quiet HEAD' => 'refs/heads/main\n',
          _ => '0123456789\n',
        },
      );
    };

void main() {
  test('Git command failures stay distinct from folders without Git', () async {
    for (final code in [1, 128]) {
      expect(
        await readLocalGitProject(
          '/repo',
          startProcess: (_, _) async => _GitProcess(code: code),
        ),
        code == 128 ? {'isGit': false} : {'error': 'GIT_UNAVAILABLE'},
      );
    }
    expect(
      await readLocalGitProject(
        '/repo',
        startProcess: (_, _) => throw const ProcessException('git', []),
      ),
      {'error': 'GIT_UNAVAILABLE'},
    );
    expect(
      await readLocalGitProject(
        '/repo',
        startProcess: _commands(fail: 'for-each-ref'),
      ),
      {'error': 'GIT_UNAVAILABLE'},
    );
  });

  test(
    'Git reads receive one literal path and a noninteractive environment',
    () async {
      final calls = <List<String>>[];
      await readLocalGitProject(
        '/repo with spaces',
        startProcess: (arguments, environment) async {
          calls.add(arguments);
          expect(arguments.take(3), [
            '--no-optional-locks',
            '-C',
            '/repo with spaces',
          ]);
          expect(environment['GIT_TERMINAL_PROMPT'], '0');
          expect(environment['GIT_OPTIONAL_LOCKS'], '0');
          expect(environment['GCM_INTERACTIVE'], 'Never');
          for (final key in [
            'GIT_DIR',
            'GIT_WORK_TREE',
            'GIT_COMMON_DIR',
            'GIT_INDEX_FILE',
            'GIT_NAMESPACE',
            'GIT_PREFIX',
          ]) {
            expect(environment.containsKey(key), false);
          }
          return _GitProcess(output: '/repo with spaces\n');
        },
      );
      expect(calls, hasLength(5));
      expect(
        calls.any((args) => args.contains('switch') || args.contains('fetch')),
        false,
      );
    },
  );

  test('excessive Git output is bounded and the process is killed', () async {
    final process = _GitProcess(bytes: Uint8List(1024 * 1024 + 1));
    expect(
      await readLocalGitProject('/repo', startProcess: (_, _) async => process),
      {'error': 'GIT_UNAVAILABLE'},
    );
    expect(process.signals, [ProcessSignal.sigkill]);
  });

  test('a stalled Git read is killed at its deadline', () async {
    final process = _GitProcess(code: null);
    final result = readLocalGitProject(
      '/repo',
      startProcess: (_, _) async => process,
    );
    expect(await result, {'error': 'GIT_UNAVAILABLE'});
    expect(process.signals, [ProcessSignal.sigkill]);
  });

  test(
    'failed worktree creation leaves its allocated folder for recovery',
    () async {
      final root = await Directory.systemTemp.createTemp('git-recovery-test-');
      addTearDown(() => root.delete(recursive: true));
      await expectLater(
        prepareGitProject(
          '/repo',
          root.path,
          worktree: true,
          startProcess: _commands(fail: 'worktree add'),
        ),
        throwsA(
          isA<RepositoryCloneException>().having(
            (e) => e.message,
            'message',
            contains('Could not create the worktree at'),
          ),
        ),
      );
      final parent = Directory('${root.path}/worktrees/repo');
      expect(
        await parent.list().where((entity) => entity is Directory).length,
        1,
      );
    },
  );

  test('preparation rejects invalid sources, stale refs and unreadable project paths', () async {
    for (final (source, ref, failure) in [
      ('relative', null, null),
      ('/repo', '--help', null),
      ('/repo', null, 'rev-parse --show-toplevel'),
      ('/repo', 'refs/heads/missing', 'show-ref'),
      ('/repo', null, 'rev-parse --verify'),
      ('/repo', null, 'rev-parse --show-prefix'),
    ]) {
      await expectLater(
        prepareGitProject(
          source,
          '/unused',
          worktree: true,
          branchRef: ref,
          startProcess: _commands(fail: failure),
        ),
        throwsA(isA<RepositoryCloneException>()),
      );
    }
    await expectLater(
      prepareGitProject(
        '/repo/sub',
        '/unused',
        worktree: true,
        startProcess: _commands(prefix: 'sub/'),
      ),
      throwsA(isA<RepositoryCloneException>()),
    );
    await expectLater(
      prepareGitProject(
        '/repo',
        '/unused',
        worktree: false,
        startProcess: _commands(),
      ),
      throwsA(isA<RepositoryCloneException>()),
    );
  });
}
