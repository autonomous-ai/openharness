import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'repository_clone.dart';

class GitBranch {
  const GitBranch(this.ref, this.name, {this.remote = false, this.worktree});
  final String ref, name;
  final bool remote;

  /// Where this local branch is checked out, when it is.
  final String? worktree;
}

class GitProjectInfo {
  const GitProjectInfo({
    this.isGit = false,
    this.branch,
    this.branches = const [],
    this.error,
    this.mainFolder,
    this.mainBranch,
  });
  factory GitProjectInfo.fromJson(Map<String, dynamic> data) => GitProjectInfo(
    isGit: data['isGit'] == true,
    branch: data['branch'] as String?,
    error: data['error'] as String?,
    mainFolder: data['mainFolder'] is String && validGitPath(data['mainFolder'])
        ? data['mainFolder'] as String
        : null,
    mainBranch: data['mainBranch'] as String?,
    branches: [
      for (final row in (data['branches'] as List? ?? const []))
        if (row is Map && row['ref'] is String && row['name'] is String)
          GitBranch(
            row['ref'] as String,
            row['name'] as String,
            remote: row['remote'] == true,
            worktree: row['worktree'] is String
                ? row['worktree'] as String
                : null,
          ),
    ],
  );
  final bool isGit;
  final String? branch, error;
  final List<GitBranch> branches;

  /// Set only for a folder inside a linked worktree: the same folder in the
  /// repository's main checkout, and the branch that checkout is on.
  final String? mainFolder, mainBranch;
}

/// One entry of `git worktree list --porcelain`. The main checkout is first.
typedef _Worktree = ({String path, String? ref, bool usable});

List<_Worktree> _parseWorktrees(String output) => [
  for (final block in output.split(RegExp(r'\n\s*\n')))
    if (block
            .split('\n')
            .where((line) => line.startsWith('worktree '))
            .firstOrNull
        case final line?)
      (
        path: line.substring('worktree '.length),
        ref: block
            .split('\n')
            .where((line) => line.startsWith('branch '))
            .firstOrNull
            ?.substring('branch '.length),
        // A bare repository has no files, and a prunable entry lost its folder.
        usable: !block
            .split('\n')
            .any((line) => line == 'bare' || line.startsWith('prunable')),
      ),
];

Future<String> _realPath(String path) async {
  try {
    return await Directory(path).resolveSymbolicLinks();
  } on FileSystemException {
    return p.normalize(path);
  }
}

/// The main checkout, when [root] is one of its linked worktrees.
Future<String?> _mainCheckout(String root, List<_Worktree> trees) async {
  if (trees.length < 2 || !trees.first.usable) return null;
  final here = await _realPath(root);
  if (await _realPath(trees.first.path) == here) return null;
  for (final tree in trees.skip(1)) {
    if (await _realPath(tree.path) == here) return trees.first.path;
  }
  return null;
}

/// `claude-0922-1136`: the harness and the local time, short enough to read as
/// a branch. The worktree's folder is named the same and nobody needs to see it.
String worktreeName(String label, DateTime at) {
  String two(int n) => n.toString().padLeft(2, '0');
  var slug = label
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  if (slug.length > 40) {
    slug = slug.substring(0, 40).replaceAll(RegExp(r'-+$'), '');
  }
  return '${slug.isEmpty ? 'harness' : slug}-${two(at.month)}${two(at.day)}-${two(at.hour)}${two(at.minute)}';
}

bool validGitPath(String path) =>
    p.isAbsolute(path) &&
    path.length <= 4096 &&
    !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path);
bool validGitRef(String ref) =>
    ref.length <= 1024 &&
    RegExp(r'^refs/(heads|remotes)/[^\s\x00-\x1f\x7f]+$').hasMatch(ref);

typedef GitProcessStarter = Future<Process> Function(
  List<String> arguments,
  Map<String, String> environment,
);

/// Listing choices never checks out a branch or fetches from a remote.
Future<Map<String, dynamic>> readLocalGitProject(
  String source, {
  GitProcessStarter? startProcess,
}) async {
  Future<({int code, String output})> git(List<String> arguments) =>
      _git(source, arguments, startProcess: startProcess);
  if (!validGitPath(source)) return {'error': 'INVALID_PATH'};
  try {
    final root = await git(['rev-parse', '--show-toplevel']);
    if (root.code != 0) {
      return root.code == 128 ? {'isGit': false} : {'error': 'GIT_UNAVAILABLE'};
    }
    final results = await Future.wait([
      git(['symbolic-ref', '--quiet', 'HEAD']),
      git([
        'for-each-ref',
        '--format=%(refname)%09%(refname:short)%09%(symref)',
        'refs/heads',
        'refs/remotes',
      ]),
      git(['worktree', 'list', '--porcelain']),
    ]);
    if (results[1].code != 0) return {'error': 'GIT_UNAVAILABLE'};
    final trees = results[2].code == 0
        ? _parseWorktrees(results[2].output)
        : const <_Worktree>[];
    final checkedOut = {
      for (final tree in trees)
        if (tree.usable && tree.ref != null) tree.ref!: tree.path,
    };
    // A worktree is a temporary folder. The launcher shows its repository.
    String? mainFolder, mainBranch;
    if (await _mainCheckout(root.output, trees) case final main?) {
      final prefix = await git(['rev-parse', '--show-prefix']);
      final relative = prefix.code == 0
          ? prefix.output.replaceFirst(RegExp(r'/$'), '')
          : '';
      mainFolder =
          relative.isNotEmpty &&
              await Directory(p.join(main, relative)).exists()
          ? p.join(main, relative)
          : main;
      mainBranch = trees.first.ref?.replaceFirst('refs/heads/', '');
    }
    return {
      'isGit': true,
      'root': root.output,
      'branch': results[0].code == 0
          ? results[0].output.replaceFirst('refs/heads/', '')
          : null,
      'mainFolder': ?mainFolder,
      'mainBranch': ?mainBranch,
      'branches': [
        for (final line in results[1].output.split('\n'))
          if (line.split('\t') case [final ref, final name, ''])
            {
              'ref': ref,
              'name': name,
              'remote': ref.startsWith('refs/remotes/'),
              'worktree': ?checkedOut[ref],
            },
      ],
    };
  } on RepositoryCloneException {
    return {'error': 'GIT_UNAVAILABLE'};
  }
}

/// Worktrees get a fresh `harness/<name>` branch, in a folder under
/// `<projectHome>/worktrees/<repository>`. With Worktree off, a branch that
/// already has a worktree opens there; otherwise only an explicitly chosen
/// local branch can switch the shared folder, using Git's normal protections.
Future<String> prepareGitProject(
  String source,
  String projectHome, {
  required bool worktree,
  String? branchRef,
  required String label,
  DateTime Function()? now,
  GitProcessStarter? startProcess,
}) async {
  Future<({int code, String output})> git(
    List<String> arguments, {
    Duration timeout = const Duration(seconds: 4),
  }) => _git(source, arguments, timeout: timeout, startProcess: startProcess);
  if (!validGitPath(source) || branchRef != null && !validGitRef(branchRef)) {
    throw const RepositoryCloneException('Choose a Git project and branch.');
  }
  final root = await git(['rev-parse', '--show-toplevel']);
  if (root.code != 0) {
    throw const RepositoryCloneException('Choose a Git working folder.');
  }
  if (branchRef != null) {
    final ref = await git(['show-ref', '--verify', '--hash', '--', branchRef]);
    if (ref.code != 0) {
      throw const RepositoryCloneException(
        'That branch is no longer available. Choose another branch.',
      );
    }
  }
  final head = await git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    '${branchRef ?? 'HEAD'}^{commit}',
  ]);
  if (head.code != 0) {
    throw const RepositoryCloneException(
      'Worktree needs a branch with at least one commit. Turn Worktree off for an empty repository.',
    );
  }
  final prefix = await git(['rev-parse', '--show-prefix']);
  if (prefix.code != 0) {
    throw const RepositoryCloneException('Could not read the project folder.');
  }
  final relative = prefix.output;
  if (relative.isNotEmpty) {
    final tree = await git([
      'cat-file',
      '-t',
      '${head.output}:${relative.replaceFirst(RegExp(r'/$'), '')}',
    ]);
    if (tree.code != 0 || tree.output != 'tree') {
      throw const RepositoryCloneException(
        'This folder is not in the selected branch. Choose the repository root.',
      );
    }
  }
  String inside(String folder) => relative.isEmpty
      ? folder
      : p.join(folder, relative.replaceFirst(RegExp(r'/$'), ''));
  final listed = await git(['worktree', 'list', '--porcelain']);
  final trees = listed.code == 0
      ? _parseWorktrees(listed.output)
      : const <_Worktree>[];
  if (!worktree) {
    if (branchRef == null || !branchRef.startsWith('refs/heads/')) {
      throw const RepositoryCloneException(
        'Choose a local branch, or turn Worktree on.',
      );
    }
    final current = await git(['symbolic-ref', '--quiet', 'HEAD']);
    if (current.code == 0 && current.output == branchRef) return source;
    // A branch that already has a worktree is worked on there: Git would
    // refuse to check it out twice, and the folder is not the person's concern.
    for (final tree in trees) {
      if (tree.usable &&
          tree.ref == branchRef &&
          await Directory(tree.path).exists()) {
        return inside(tree.path);
      }
    }
    final result = await git([
      'switch',
      '--',
      branchRef.substring('refs/heads/'.length),
    ], timeout: const Duration(minutes: 2));
    if (result.code != 0) {
      throw const RepositoryCloneException(
        'Could not switch branches. Commit or stash conflicting changes, or turn Worktree on.',
      );
    }
    return source;
  }
  // Grouped by repository, so the leaf only needs the harness and the time.
  final repository = trees.firstOrNull?.usable == true
      ? p.basename(trees.first.path)
      : p.basename(root.output);
  final taken = await git([
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/harness/',
  ]);
  final base = worktreeName(label, (now ?? DateTime.now)());
  late final String destination, branch;
  try {
    final parent = Directory(p.join(projectHome, 'worktrees', repository));
    await parent.create(recursive: true);
    for (var attempt = 1; ; attempt++) {
      if (attempt > 100) {
        throw FileSystemException('No free worktree name', parent.path);
      }
      final name = attempt == 1 ? base : '$base-$attempt';
      if (taken.output.split('\n').contains('refs/heads/harness/$name')) {
        continue;
      }
      final folder = p.join(parent.path, name);
      // Directory.create accepts an existing directory; mkdir reserves the
      // name exclusively, so concurrent starts never share a worktree.
      if ((await Process.run('mkdir', [folder])).exitCode == 0) {
        destination = folder;
        branch = 'harness/$name';
        break;
      }
      if (await FileSystemEntity.type(folder, followLinks: false) ==
          FileSystemEntityType.notFound) {
        throw FileSystemException('Could not create folder', folder);
      }
    }
  } on FileSystemException {
    throw const RepositoryCloneException(
      'Could not create a worktree folder. Check folder permissions, then retry.',
    );
  } on ProcessException {
    throw const RepositoryCloneException(
      'Could not create a worktree folder. Check folder permissions, then retry.',
    );
  }
  final result = await git([
    'worktree',
    'add',
    '-b',
    branch,
    '--',
    destination,
    head.output,
  ], timeout: const Duration(minutes: 2));
  if (result.code != 0) {
    // A partial checkout or branch stays available for recovery.
    throw RepositoryCloneException(
      'Could not create the worktree at $destination. Check Git and folder permissions, then retry.',
    );
  }
  return inside(destination);
}

Future<({int code, String output})> _git(
  String source,
  List<String> arguments, {
  Duration timeout = const Duration(seconds: 4),
  GitProcessStarter? startProcess,
}) async {
  final environment = Map<String, String>.of(Platform.environment)
    ..removeWhere(
      (key, _) => const [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_NAMESPACE',
        'GIT_PREFIX',
      ].contains(key),
    )
    ..addAll({
      'GIT_TERMINAL_PROMPT': '0',
      'GCM_INTERACTIVE': 'Never',
      'GIT_OPTIONAL_LOCKS': '0',
    });
  Process process;
  final argv = ['--no-optional-locks', '-C', source, ...arguments];
  try {
    process =
        await (startProcess?.call(argv, environment) ??
            Process.start(
              'git',
              argv,
              environment: environment,
              includeParentEnvironment: false,
            ));
  } on ProcessException {
    throw const RepositoryCloneException(
      'Git could not start. Install Git, then retry.',
    );
  }
  unawaited(process.stdin.close());
  final output = StringBuffer();
  var overflow = false;
  final outDone = Completer<void>(), errDone = Completer<void>();
  final stdout = process.stdout
      .transform(const Utf8Decoder(allowMalformed: true))
      .listen(
        (chunk) {
          if (output.length + chunk.length <= 1024 * 1024) {
            output.write(chunk);
          } else {
            overflow = true;
            process.kill(ProcessSignal.sigkill);
          }
        },
        onDone: outDone.complete,
        onError: outDone.completeError,
      );
  final stderr = process.stderr.listen(
    (_) {},
    onDone: errDone.complete,
    onError: errDone.completeError,
  );
  try {
    final results = await Future.wait<dynamic>([
      process.exitCode,
      outDone.future,
      errDone.future,
    ]).timeout(timeout);
    if (overflow) {
      throw const RepositoryCloneException(
        'This repository has too many branches to read.',
      );
    }
    return (
      code: results.first as int,
      output: output.toString().replaceFirst(RegExp(r'\r?\n$'), ''),
    );
  } on TimeoutException {
    process.kill(ProcessSignal.sigkill);
    throw const RepositoryCloneException(
      'Git took too long. Check this machine, then retry.',
    );
  } finally {
    await stdout.cancel();
    await stderr.cancel();
  }
}
