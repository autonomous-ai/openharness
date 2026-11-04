import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:path/path.dart' as p;

import 'swarm_state_test.dart' show createApp;

/// A fresh form starts from the branch the project itself calls its default:
/// real Git repositories, read by the real reader, shown to the real form.
/// octocat/Hello-World is on master: the form refused it until a branch was
/// chosen by hand, and a repository on develop quietly started from main.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory root;
  late AppNotifier app;

  Future<void> git(String at, List<String> arguments) async {
    final result = await Process.run('git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-C',
      at,
      ...arguments,
    ]);
    if (result.exitCode != 0) {
      throw StateError('git $arguments: ${result.stderr}');
    }
  }

  Future<String> repository(
    String head, {
    List<String> others = const [],
  }) async {
    final path = p.join(root.path, 'origin');
    await Directory(path).create();
    await git(path, ['init', '-b', head]);
    await git(path, ['commit', '--allow-empty', '-m', 'first']);
    for (final other in others) {
      await git(path, ['branch', other]);
    }
    return path;
  }

  Future<String> cloneOf(String origin) async {
    final clone = p.join(root.path, 'clone');
    await git(root.path, ['clone', '--', origin, clone]);
    return clone;
  }

  Future<NewHarnessController> form(String folder) async {
    app.gitProjectReaderForTest = (_, path) => readLocalGitProject(path);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: 'codex',
      folder: folder,
    )..useDesktopChoices(true);
    addTearDown(box.dispose);
    for (var i = 0; i < 400 && (box.checkingGit || !box.isGitProject); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(box.isGitProject, isTrue, reason: 'the project was never read');
    return box;
  }

  setUp(() async {
    root = await Directory.systemTemp.createTemp('default-branch-');
    root = Directory(await root.resolveSymbolicLinks());
    app = createApp(connected: true);
    addTearDown(app.dispose);
  });
  tearDown(() => root.delete(recursive: true));

  void startsFrom(NewHarnessController box, String ref, String label) {
    expect(box.branchRef, ref);
    expect(box.branchLabel, label);
    expect(box.requiredChoice, isNull);
  }

  test('a clone on main starts from main', () async {
    final box = await form(await cloneOf(await repository('main')));
    startsFrom(box, 'refs/heads/main', 'main');
  });

  test('a clone on master starts from master', () async {
    final box = await form(await cloneOf(await repository('master')));
    startsFrom(box, 'refs/heads/master', 'master');
  });

  test('so it does with Worktree off', () async {
    final box = await form(await cloneOf(await repository('master')));
    box.toggleWorktree();
    expect(box.worktree, isFalse);
    startsFrom(box, 'refs/heads/master', 'master');
  });

  test('a clone on an unusual default starts from it', () async {
    final box = await form(await cloneOf(await repository('trunk')));
    startsFrom(box, 'refs/heads/trunk', 'trunk');
  });

  test('the default wins over a main beside it', () async {
    final clone = await cloneOf(await repository('develop', others: ['main']));
    final box = await form(clone);
    startsFrom(box, 'refs/heads/develop', 'develop');
  });

  test('a clone whose origin/HEAD is gone starts where it is', () async {
    final clone = await cloneOf(await repository('master'));
    await git(clone, ['remote', 'set-head', 'origin', '--delete']);
    final box = await form(clone);
    startsFrom(box, 'refs/heads/master', 'master');
  });

  test('a repository with no remote starts where it is', () async {
    final box = await form(await repository('master'));
    startsFrom(box, 'refs/heads/master', 'master');
  });

  test('main still leads when nothing names a default', () async {
    final path = await repository('feature', others: ['main']);
    final box = await form(path);
    startsFrom(box, 'refs/heads/main', 'main');
  });

  test('a detached repository with no default still asks', () async {
    final path = await repository('feature');
    await git(path, ['checkout', '--detach']);
    final box = await form(path);
    expect(box.branchRef, isNull);
    expect(box.branchLabel, 'default · unavailable');
    expect(
      box.requiredChoice?.message,
      'This project has no default branch. Choose a branch.',
    );
    expect(box.requiredChoice?.field, NewHarnessField.branch);
  });
}
