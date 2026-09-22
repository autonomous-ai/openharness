import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'project_folder.dart';
import 'repository_clone.dart';

class GitBranch {
  const GitBranch(this.ref, this.name, {this.remote = false});
  final String ref, name;
  final bool remote;
}

class GitProjectInfo {
  const GitProjectInfo({
    this.isGit = false,
    this.branch,
    this.branches = const [],
    this.error,
  });
  factory GitProjectInfo.fromJson(Map<String, dynamic> data) => GitProjectInfo(
    isGit: data['isGit'] == true,
    branch: data['branch'] as String?,
    error: data['error'] as String?,
    branches: [
      for (final row in (data['branches'] as List? ?? const []))
        if (row is Map && row['ref'] is String && row['name'] is String)
          GitBranch(
            row['ref'] as String,
            row['name'] as String,
            remote: row['remote'] == true,
          ),
    ],
  );
  final bool isGit;
  final String? branch, error;
  final List<GitBranch> branches;
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
    ]);
    if (results[1].code != 0) return {'error': 'GIT_UNAVAILABLE'};
    return {
      'isGit': true,
      'root': root.output,
      'branch': results[0].code == 0
          ? results[0].output.replaceFirst('refs/heads/', '')
          : null,
      'branches': [
        for (final line in results[1].output.split('\n'))
          if (line.split('\t') case [final ref, final name, ''])
            {
              'ref': ref,
              'name': name,
              'remote': ref.startsWith('refs/remotes/'),
            },
      ],
    };
  } on RepositoryCloneException {
    return {'error': 'GIT_UNAVAILABLE'};
  }
}

/// Worktrees get a fresh branch. With Worktree off, only an explicitly chosen
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
  if (!worktree) {
    if (branchRef == null || !branchRef.startsWith('refs/heads/')) {
      throw const RepositoryCloneException(
        'Choose a local branch, or turn Worktree on.',
      );
    }
    final current = await git(['symbolic-ref', '--quiet', 'HEAD']);
    if (current.code == 0 && current.output == branchRef) return source;
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
  final parent = Directory(p.join(projectHome, 'worktrees'));
  await parent.create(recursive: true);
  final name = projectFolderName(
    '${p.basename(root.output)}-$label',
    (now ?? DateTime.now)(),
    withSeconds: true,
  );
  final destination = await parent.createTemp('$name-');
  final branch = 'harness/${p.basename(destination.path)}';
  final result = await git([
    'worktree',
    'add',
    '-b',
    branch,
    '--',
    destination.path,
    head.output,
  ], timeout: const Duration(minutes: 2));
  if (result.code != 0) {
    // A partial checkout or branch stays available for recovery.
    throw RepositoryCloneException(
      'Could not create the worktree at ${destination.path}. Check Git and folder permissions, then retry.',
    );
  }
  return relative.isEmpty
      ? destination.path
      : p.join(destination.path, relative);
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
