import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:path/path.dart' as p;

void main() {
  test(
    'accepts GitHub URLs and shorthand without shell syntax or credentials',
    () {
      for (final input in [
        'owner/project',
        'https://github.com/owner/project/',
        'https://github.com/owner/project.git',
      ]) {
        final repository = GitHubRepository.parse(input)!;
        expect(repository.url, 'https://github.com/owner/project.git');
        expect(repository.name, 'project');
      }
      expect(
        GitHubRepository.parse('git@github.com:owner/project.git')!.url,
        'git@github.com:owner/project.git',
      );
      for (final input in [
        '',
        '/tmp/repo',
        '--upload-pack=bad',
        'https://user:secret@github.com/owner/repo',
        'https://github.com/owner/..',
        'https://github.com/owner/repo?token=secret',
        'https://github.com/owner/repo/tree/main',
        'ext::bad',
        'owner/repo;command',
      ]) {
        expect(GitHubRepository.parse(input), isNull, reason: input);
      }
    },
  );

  late Directory root;
  setUp(
    () async =>
        root = await Directory.systemTemp.createTemp('harness-clone-test-'),
  );
  tearDown(() async => root.delete(recursive: true));

  test('clones a real fixture and publishes a complete checkout, without network access', () async {
    final source = p.join(root.path, 'fixture.git');
    expect((await Process.run('git', ['init', '--bare', source])).exitCode, 0);
    final parent = await Directory(p.join(root.path, 'projects')).create();
    final clone = RepositoryClone(
      startProcess: (arguments, environment) {
        expect(arguments.take(3), [
          'clone',
          '--',
          'https://github.com/owner/project.git',
        ]);
        expect(environment['GIT_TERMINAL_PROMPT'], '0');
        // Substitute only the synthetic source; run the real Git clone, staging,
        // rename and cleanup logic without reaching GitHub or real credentials.
        return Process.start('git', [
          'clone',
          '--',
          source,
          arguments.last,
        ], environment: environment);
      },
    );
    final destination = await clone.run(
      GitHubRepository.parse('owner/project')!,
      parent.path,
    );
    expect(destination, p.join(parent.path, 'project'));
    expect(await Directory(p.join(destination, '.git')).exists(), isTrue);
    expect(
      (await parent.list().toList()).map((entry) => p.basename(entry.path)),
      ['project'],
    );
  });

  test('an existing destination is preserved and never starts Git', () async {
    final existing = await Directory(p.join(root.path, 'project')).create();
    final draft = File(p.join(existing.path, 'draft.txt'));
    await draft.writeAsString('keep this');
    final clone = RepositoryClone(
      startProcess: (_, _) => throw StateError('Must not start'),
    );
    await expectLater(
      clone.run(GitHubRepository.parse('owner/project')!, root.path),
      throwsA(
        isA<RepositoryCloneException>().having(
          (e) => e.message,
          'message',
          contains('already exists'),
        ),
      ),
    );
    expect(await draft.readAsString(), 'keep this');
  });

  test('knows one repository however git spells it', () {
    for (final address in [
      'https://github.com/owner/project.git',
      'https://github.com/owner/project/',
      'https://GitHub.com/Owner/Project',
      'https://x-access-token:secret@github.com/owner/project.git',
      'git@github.com:owner/project.git',
      'ssh://git@github.com:22/owner/project',
      'git://github.com/owner/project.git',
    ]) {
      expect(
        repositoryIdentity(address),
        'github.com/owner/project',
        reason: address,
      );
    }
    for (final address in ['/srv/git/project.git', 'file:///srv/project', '']) {
      expect(repositoryIdentity(address), isNull, reason: address);
    }
  });

  // PROJECT_EXISTS was 4 of 7 failed starts on Oct 18: a clone of a
  // repository already checked out where it would go was refused.
  test('a checkout of the same repository at the destination is used, never cloned again', () async {
    for (final (asked, origin) in [
      ('owner/project', 'https://github.com/owner/project.git'),
      ('git@github.com:owner/project.git', 'https://github.com/owner/project'),
      ('https://github.com/Owner/project/', 'git@github.com:owner/project.git'),
    ]) {
      final parent = await root.createTemp('parent-');
      final existing = p.join(parent.path, 'project');
      expect((await Process.run('git', ['init', '-q', existing])).exitCode, 0);
      expect(
        (await Process.run('git', [
          '-C',
          existing,
          'remote',
          'add',
          'origin',
          origin,
        ])).exitCode,
        0,
      );
      final draft = File(p.join(existing, 'draft.txt'));
      await draft.writeAsString('keep this');
      final clone = RepositoryClone(
        startProcess: (_, _) => throw StateError('Must not start'),
      );
      expect(
        await clone.run(GitHubRepository.parse(asked)!, parent.path),
        existing,
        reason: asked,
      );
      expect(await draft.readAsString(), 'keep this');
      expect(
        (await parent.list().toList()).map((entry) => p.basename(entry.path)),
        ['project'],
      );
    }
  });

  test('the same repository checked out there while cloning is used, and staging goes', () async {
    final parent = await Directory(p.join(root.path, 'projects')).create();
    final existing = p.join(parent.path, 'project');
    final clone = RepositoryClone(
      startProcess: (arguments, environment) async {
        // Another start finishes its clone of the same repository first.
        await Process.run('git', ['init', '-q', existing]);
        await Process.run('git', [
          '-C',
          existing,
          'remote',
          'add',
          'origin',
          'git@github.com:owner/project.git',
        ]);
        return Process.start('git', ['init', '-q', arguments.last]);
      },
    );
    expect(
      await clone.run(GitHubRepository.parse('owner/project')!, parent.path),
      existing,
    );
    expect(
      (await parent.list().toList()).map((entry) => p.basename(entry.path)),
      ['project'],
    );
  });

  test(
    'a checkout of another repository at the destination is still refused',
    () async {
      final existing = p.join(root.path, 'project');
      final clone = RepositoryClone(
        startProcess: (_, _) => throw StateError('Must not start'),
        readOrigin: (folder) async =>
            folder == existing ? 'https://github.com/owner/other.git' : null,
      );
      await Directory(existing).create();
      await expectLater(
        clone.run(GitHubRepository.parse('owner/project')!, root.path),
        throwsA(
          isA<RepositoryCloneException>().having(
            (e) => e.message,
            'message',
            contains('already exists'),
          ),
        ),
      );
    },
  );

  test(
    'failed Git does not leave a partial project or expose diagnostics',
    () async {
      final clone = RepositoryClone(
        startProcess: (arguments, environment) => Process.start('git', [
          'clone',
          '--',
          p.join(root.path, 'missing-secret-source'),
          arguments.last,
        ], environment: environment),
      );
      await expectLater(
        clone.run(GitHubRepository.parse('owner/project')!, root.path),
        throwsA(
          isA<RepositoryCloneException>().having(
            (e) => e.message,
            'message',
            isNot(contains('missing-secret-source')),
          ),
        ),
      );
      expect(await root.list().toList(), isEmpty);
    },
  );

  test(
    'cancelling an in-flight clone stops its process and removes staging',
    () async {
      final started = Completer<void>();
      final clone = RepositoryClone(
        startProcess: (_, _) async {
          final process = await Process.start('sleep', ['30']);
          started.complete();
          return process;
        },
      );
      final result = clone.run(
        GitHubRepository.parse('owner/project')!,
        root.path,
      );
      final expectation = expectLater(
        result,
        throwsA(
          isA<RepositoryCloneException>().having(
            (e) => e.message,
            'message',
            'Clone cancelled.',
          ),
        ),
      );
      await started.future;
      clone.cancel();
      await expectation;
      expect(await root.list().toList(), isEmpty);
    },
    skip: Platform.isWindows ? 'Uses the POSIX sleep fixture.' : false,
  );
}
