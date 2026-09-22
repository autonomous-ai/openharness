import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory root;
  late String repo;
  Future<String> git(List<String> args, [String? folder]) async {
    final result = await Process.run('git', ['-C', folder ?? repo, ...args]);
    expect(result.exitCode, 0, reason: '${args.join(' ')}: ${result.stderr}');
    return (result.stdout as String).trim();
  }

  setUp(() async {
    root = await Directory.systemTemp.createTemp('harness-git-test-');
    repo = p.join(root.path, 'project with spaces');
    await Directory(p.join(repo, 'src')).create(recursive: true);
    await git(['init', '-b', 'main']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'commit.gpgsign', 'false']);
    await git(['config', 'core.hooksPath', '/dev/null']);
    await File(p.join(repo, 'src', 'value')).writeAsString('main');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial']);
    await git(['switch', '-c', 'feature']);
    await File(p.join(repo, 'src', 'value')).writeAsString('feature');
    await git(['commit', '-am', 'feature']);
    await git(['update-ref', 'refs/remotes/origin/feature', 'HEAD']);
    await git([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/feature',
    ]);
    await git(['switch', 'main']);
  });
  tearDown(() => root.delete(recursive: true));
  Future<String> worktree({
    String ref = 'refs/heads/feature',
    String? folder,
  }) => ProjectFolderRequest.worktree(folder ?? repo, branchRef: ref)
      .prepareLocal(
        projectHome: p.join(root.path, 'harnesses'),
        label: 'Codex',
        now: () => DateTime(2026, 9, 21, 12),
      );

  test(
    'local Git discovery is read only and excludes symbolic remote refs',
    () async {
      final info = GitProjectInfo.fromJson(await readLocalGitProject(repo));
      expect(info.isGit, isTrue);
      expect(info.branch, 'main');
      expect(info.branches.map((branch) => branch.name), [
        'feature',
        'main',
        'origin/feature',
      ]);
      expect(info.branches.last.remote, isTrue);
      expect(await git(['branch', '--show-current']), 'main');
      expect((await readLocalGitProject(root.path))['isGit'], false);
      expect((await readLocalGitProject('relative'))['error'], 'INVALID_PATH');
    },
  );

  test('concurrent worktrees use the selected ref, new branches, and preserve dirty source files', () async {
    await File(p.join(repo, 'src', 'value')).writeAsString('keep my work');
    final paths = await Future.wait([
      worktree(),
      worktree(ref: 'refs/remotes/origin/feature'),
    ]);
    expect(paths.toSet(), hasLength(2));
    final branches = <String>{};
    for (final path in paths) {
      expect(
        await File(p.join(path, 'src', 'value')).readAsString(),
        'feature',
      );
      final branch = await git(['branch', '--show-current'], path);
      expect(branch, startsWith('harness/'));
      branches.add(branch);
    }
    expect(branches, hasLength(2));
    expect(
      await File(p.join(repo, 'src', 'value')).readAsString(),
      'keep my work',
    );
    expect(await git(['branch', '--show-current']), 'main');
  });

  test(
    'a subfolder follows the selected branch into its new worktree',
    () async {
      final path = await worktree(folder: p.join(repo, 'src'));
      expect(await File(p.join(path, 'value')).readAsString(), 'feature');
      await Directory(p.join(repo, 'untracked')).create();
      await expectLater(
        worktree(folder: p.join(repo, 'untracked')),
        throwsA(isA<RepositoryCloneException>()),
      );
    },
  );

  test('branch switching protects dirty changes', () async {
    Future<String> switchTo(String branch) => ProjectFolderRequest.branch(
      repo,
      'refs/heads/$branch',
    ).prepareLocal(projectHome: root.path);
    expect(await switchTo('feature'), repo);
    await File(p.join(repo, 'src', 'value')).writeAsString('keep this');
    await expectLater(
      switchTo('main'),
      throwsA(isA<RepositoryCloneException>()),
    );
    expect(
      await File(p.join(repo, 'src', 'value')).readAsString(),
      'keep this',
    );
    expect(await git(['branch', '--show-current']), 'feature');
    expect(await git(['stash', 'list']), isEmpty);
    expect(await switchTo('feature'), repo);
  });

  Future<String> real(String path) => Directory(path).resolveSymbolicLinks();

  test('a branch checked out in another worktree opens there', () async {
    final other = p.join(root.path, 'other');
    await git(['worktree', 'add', other, 'feature']);
    final path = await ProjectFolderRequest.branch(
      p.join(repo, 'src'),
      'refs/heads/feature',
    ).prepareLocal(projectHome: root.path);
    expect(await real(path), await real(p.join(other, 'src')));
    expect(await git(['branch', '--show-current']), 'main');
  });

  test(
    'worktrees are named for the harness and the time, grouped by repository',
    () async {
      await git(['branch', 'harness/codex-0921-1200-2', 'main']);
      final paths = [await worktree(), await worktree()];
      final folder = p.join(
        root.path,
        'harnesses',
        'worktrees',
        'project with spaces',
      );
      expect(paths, [
        p.join(folder, 'codex-0921-1200'),
        p.join(folder, 'codex-0921-1200-3'),
      ]);
      for (final path in paths) {
        expect(
          await git(['branch', '--show-current'], path),
          'harness/${p.basename(path)}',
        );
      }
    },
  );

  test('a linked worktree reads as its repository, and new worktrees from it join that repository', () async {
    final linked = await worktree();
    final info = GitProjectInfo.fromJson(
      await readLocalGitProject(p.join(linked, 'src')),
    );
    expect(info.branch, 'harness/codex-0921-1200');
    expect(info.mainBranch, 'main');
    expect(await real(info.mainFolder!), await real(p.join(repo, 'src')));
    final branches = {for (final b in info.branches) b.name: b.worktree};
    expect(
      await real(branches['harness/codex-0921-1200']!),
      await real(linked),
    );
    expect(await real(branches['main']!), await real(repo));
    expect(branches['origin/feature'], isNull);
    expect(
      GitProjectInfo.fromJson(await readLocalGitProject(repo)).mainFolder,
      isNull,
    );
    expect(
      await worktree(folder: linked),
      p.join(
        root.path,
        'harnesses',
        'worktrees',
        'project with spaces',
        'codex-0921-1200-2',
      ),
    );
  });

  test('missing branches and revision expressions cannot silently select another commit', () async {
    for (final ref in [
      'refs/heads/missing',
      'refs/heads/main~0',
      'refs/heads/main^{commit}',
    ]) {
      await expectLater(
        worktree(ref: ref),
        throwsA(isA<RepositoryCloneException>()),
      );
    }
    final empty = await Directory(p.join(root.path, 'empty')).create();
    await git(['init', '-b', 'main'], empty.path);
    expect((await readLocalGitProject(empty.path))['isGit'], true);
    await expectLater(
      ProjectFolderRequest.worktree(empty.path)
          .prepareLocal(projectHome: root.path),
      throwsA(isA<RepositoryCloneException>()),
    );
  });
}
