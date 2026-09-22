import 'dart:io';
import 'dart:math';

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
    String? name,
    bool existing = false,
  }) => ProjectFolderRequest.worktree(
    folder ?? repo,
    branchRef: ref,
    branchName: name,
    existingBranch: existing,
  ).prepareLocal(projectHome: p.join(root.path, 'harnesses'));
  String worktrees() =>
      p.join(root.path, 'harnesses', 'worktrees', 'project with spaces');

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
      expect(info.defaultRef, 'refs/remotes/origin/feature');
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
    await git(['checkout', '--', '.']);
    await File(p.join(repo, 'notes.txt')).writeAsString('untracked');
    await expectLater(
      switchTo('main'),
      throwsA(isA<RepositoryCloneException>()),
    );
    expect(await git(['branch', '--show-current']), 'feature');
  });

  test(
    'a new branch for the folder itself keeps its uncommitted work',
    () async {
      await File(p.join(repo, 'src', 'value')).writeAsString('in progress');
      final path = await ProjectFolderRequest.branch(
        repo,
        'refs/heads/login-fix',
        newBranch: 'login-fix',
      ).prepareLocal(projectHome: root.path);
      expect(path, repo);
      expect(await git(['branch', '--show-current']), 'login-fix');
      expect(
        await File(p.join(repo, 'src', 'value')).readAsString(),
        'in progress',
      );
      await expectLater(
        ProjectFolderRequest.branch(
          repo,
          'refs/heads/feature',
          newBranch: 'feature',
        ).prepareLocal(projectHome: root.path),
        throwsA(isA<RepositoryCloneException>()),
      );
    },
  );

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

  test('placeholder branches are two words no branch uses yet', () {
    expect(
      placeholderBranch(const [], random: _First()),
      'harness/amber-badger',
    );
    expect(
      placeholderBranch(const [
        'refs/heads/harness/amber-badger',
        'harness/amber-badger-2',
      ], random: _First()),
      'harness/amber-badger-3',
    );
    expect(worktreeFolderName('harness/brave-otter'), 'brave-otter');
    expect(worktreeFolderName('fix/login page'), 'fix-loginpage');
  });

  test('new worktrees are on a new branch, in a folder named for it, grouped by repository', () async {
    final made = [await worktree(), await worktree()];
    expect(made.toSet(), hasLength(2));
    for (final path in made) {
      final branch = await git(['branch', '--show-current'], path);
      expect(branch, matches(RegExp(r'^harness/[a-z]+-[a-z]+(-\d+)?$')));
      expect(path, p.join(worktrees(), worktreeFolderName(branch)));
      expect(
        await git(['rev-parse', 'HEAD'], path),
        await git(['rev-parse', 'feature']),
      );
    }
    final named = await worktree(name: 'fix/login');
    expect(named, p.join(worktrees(), 'fix-login'));
    expect(await git(['branch', '--show-current'], named), 'fix/login');
    await expectLater(
      worktree(name: 'fix/login'),
      throwsA(isA<RepositoryCloneException>()),
    );
    await expectLater(
      worktree(name: 'bad..name'),
      throwsA(isA<RepositoryCloneException>()),
    );
  });

  test(
    'an existing branch is checked out as it is in a new worktree, once',
    () async {
      await git(['branch', 'topic', 'main']);
      final path = await worktree(
        ref: 'refs/heads/topic',
        name: 'topic',
        existing: true,
      );
      expect(path, p.join(worktrees(), 'topic'));
      expect(await git(['branch', '--show-current'], path), 'topic');
      expect(await File(p.join(path, 'src', 'value')).readAsString(), 'main');
      await expectLater(
        worktree(ref: 'refs/heads/topic', name: 'topic', existing: true),
        throwsA(isA<RepositoryCloneException>()),
      );
    },
  );

  test('a remote base is fetched first; a remote branch is tracked under its own name', () async {
    final origin = p.join(root.path, 'origin.git');
    final upstream = p.join(root.path, 'upstream');
    await git(['clone', '--quiet', '--bare', repo, origin], root.path);
    await git(['remote', 'add', 'origin', origin]);
    await git(['fetch', '--quiet', 'origin']);
    await git(['clone', '--quiet', origin, upstream], root.path);
    for (final args in [
      ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.invalid'],
      ['config', 'commit.gpgsign', 'false'],
      ['config', 'core.hooksPath', '/dev/null'],
    ]) {
      await git(args, upstream);
    }
    await File(p.join(upstream, 'src', 'value')).writeAsString('pushed');
    await git(['commit', '-qam', 'pushed'], upstream);
    await git(['push', '--quiet', 'origin', 'main', 'main:fix/typo'], upstream);
    await git([
      'fetch',
      '--quiet',
      'origin',
      'fix/typo:refs/remotes/origin/fix/typo',
    ]);
    final fresh = await worktree(
      ref: 'refs/remotes/origin/main',
      name: 'harness/fresh',
    );
    expect(
      await File(p.join(fresh, 'src', 'value')).readAsString(),
      'pushed',
      reason: 'origin/main was fetched before the worktree started from it.',
    );
    final plain = await Process.run('git', [
      '-C',
      fresh,
      'rev-parse',
      '--abbrev-ref',
      '@{upstream}',
    ]);
    expect(
      plain.exitCode,
      isNot(0),
      reason: 'A new branch never pushes onto its base.',
    );
    final tracking = await worktree(
      ref: 'refs/remotes/origin/fix/typo',
      name: 'fix/typo',
    );
    expect(
      await git(['rev-parse', '--abbrev-ref', '@{upstream}'], tracking),
      'origin/fix/typo',
    );
  });

  test(
    'ignored files named in .worktreeinclude are copied into new worktrees',
    () async {
      await File(p.join(repo, '.gitignore'))
          .writeAsString('.env\n*.log\nlocal/\n');
      await File(p.join(repo, '.worktreeinclude'))
          .writeAsString('.env\nlocal/\n');
      await File(p.join(repo, '.env')).writeAsString('SECRET=1');
      await File(p.join(repo, 'debug.log')).writeAsString('noise');
      await Directory(p.join(repo, 'local')).create();
      await File(p.join(repo, 'local', 'settings.json')).writeAsString('{}');
      final path = await worktree();
      expect(await File(p.join(path, '.env')).readAsString(), 'SECRET=1');
      expect(
        await File(p.join(path, 'local', 'settings.json')).readAsString(),
        '{}',
      );
      expect(await File(p.join(path, 'debug.log')).exists(), false);
    },
  );

  test('a linked worktree reads as its repository, and new worktrees from it join that repository', () async {
    final linked = await worktree(name: 'harness/linked');
    final info = GitProjectInfo.fromJson(
      await readLocalGitProject(p.join(linked, 'src')),
    );
    expect(info.branch, 'harness/linked');
    expect(info.mainBranch, 'main');
    expect(await real(info.mainFolder!), await real(p.join(repo, 'src')));
    final branches = {for (final b in info.branches) b.name: b.worktree};
    expect(await real(branches['harness/linked']!), await real(linked));
    expect(await real(branches['main']!), await real(repo));
    expect(branches['origin/feature'], isNull);
    expect(
      GitProjectInfo.fromJson(await readLocalGitProject(repo)).mainFolder,
      isNull,
    );
    expect(
      await worktree(folder: linked, name: 'harness/second'),
      p.join(worktrees(), 'second'),
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

/// Always the first word of each list.
class _First implements Random {
  @override
  int nextInt(int max) => 0;
  @override
  double nextDouble() => 0;
  @override
  bool nextBool() => false;
}
