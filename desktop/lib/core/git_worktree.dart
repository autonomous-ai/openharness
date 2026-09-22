import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

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
    this.defaultRef,
    this.root,
  });
  factory GitProjectInfo.fromJson(Map<String, dynamic> data) => GitProjectInfo(
    isGit: data['isGit'] == true,
    branch: data['branch'] as String?,
    error: data['error'] as String?,
    mainFolder: data['mainFolder'] is String && validGitPath(data['mainFolder'])
        ? data['mainFolder'] as String
        : null,
    mainBranch: data['mainBranch'] as String?,
    defaultRef: data['defaultRef'] is String && validGitRef(data['defaultRef'])
        ? data['defaultRef'] as String
        : null,
    root: data['root'] is String && validGitPath(data['root'])
        ? data['root'] as String
        : null,
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

  /// The remote branch new work starts from by default (`origin/HEAD`), and
  /// the checkout the folder belongs to.
  final String? defaultRef, root;

  GitProjectInfo copyWith({String? branch, String? root}) => GitProjectInfo(
    isGit: isGit,
    branch: branch ?? this.branch,
    branches: branches,
    error: error,
    defaultRef: defaultRef,
    root: root ?? this.root,
  );
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

/// Two plain words for a branch nothing has named yet — plumbing, like the
/// worktree's folder: the agent or the person names the real branch when there
/// is something to push. Mirrors cli/src/lib/agentNames.ts.
const kPlaceholderAdjectives = [
  'amber', 'bold', 'brave', 'brisk', 'calm', 'clever', 'cosmic', 'crisp', //
  'dapper', 'eager', 'fancy', 'gentle', 'glad', 'golden', 'happy', 'hidden',
  'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry', 'misty', 'noble', //
  'polite', 'proud', 'quick', 'quiet', 'rapid', 'rosy', 'royal', 'rustic',
  'shiny', 'silent', 'silver', 'sleek', 'smart', 'snowy', 'solar', 'spry',
  'steady', 'sunny', 'swift', 'tidy', 'vivid', 'warm', 'witty', 'zesty',
];
const kPlaceholderNouns = [
  'badger', 'beacon', 'birch', 'bison', 'canyon', 'cedar', 'comet', 'coral',
  'crane', 'delta', 'falcon', 'fern', 'finch', 'fjord', 'fox', 'gecko', //
  'glacier', 'harbor', 'hawk', 'heron', 'ibis', 'island', 'koala', 'lagoon',
  'lark', 'lynx', 'maple', 'meadow', 'meteor', 'moose', 'nebula', 'otter', //
  'owl', 'panda', 'pebble', 'pine', 'puffin', 'quartz', 'raven', 'reef', //
  'river', 'robin', 'sparrow', 'spruce', 'tiger', 'walrus', 'willow', 'zebra',
];

/// `harness/brave-otter`: a branch name none of [taken] (branch names, with or
/// without `refs/heads/`) already uses.
String placeholderBranch(Iterable<String> taken, {Random? random}) {
  final names = {
    for (final name in taken) name.replaceFirst('refs/heads/', ''),
  };
  final pick = random ?? Random();
  String draw() =>
      'harness/${kPlaceholderAdjectives[pick.nextInt(kPlaceholderAdjectives.length)]}'
      '-${kPlaceholderNouns[pick.nextInt(kPlaceholderNouns.length)]}';
  var name = draw();
  for (var tries = 0; tries < 16 && names.contains(name); tries++) {
    name = draw();
  }
  final base = name;
  for (var suffix = 2; names.contains(name); suffix++) {
    name = '$base-$suffix';
  }
  return name;
}

/// The folder a worktree on [branch] is checked out in, under its repository:
/// the branch without Harness's prefix, `/` as `-`. Nobody needs to see it.
String worktreeFolderName(String branch) {
  final name = branch
      .replaceFirst(RegExp(r'^harness/'), '')
      .replaceAll('/', '-')
      .replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '')
      .replaceAll(RegExp(r'^[.-]+'), '');
  return name.isEmpty
      ? 'worktree'
      : name.length > 64
      ? name.substring(0, 64)
      : name;
}

/// What a typed name becomes as a branch, as editors do it: words joined by
/// `-`, and nothing `git check-ref-format` refuses. Empty when nothing is left.
String branchNameFrom(String typed) {
  var name = typed
      .trim()
      .replaceAll(RegExp(r'\s+'), '-')
      .replaceAll(RegExp(r'[\x00-\x1f\x7f~^:?*\[\\]+'), '')
      .replaceAll(RegExp(r'\.{2,}'), '.')
      .replaceAll('@{', '@')
      .replaceAll(RegExp(r'/{2,}'), '/')
      .replaceAll(RegExp(r'/[.]+'), '/')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^[-./]+'), '');
  for (var trimmed = ''; trimmed != name;) {
    trimmed = name;
    name = name.replaceAll(RegExp(r'(\.lock|[./])$'), '');
  }
  return name == '@' ? '' : name;
}

/// A name Git accepts for a new branch, checked before Git is asked.
bool plausibleBranchName(String name) =>
    name.isNotEmpty &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !RegExp(r'[\x00-\x20\x7f~^:?*\[\\]').hasMatch(name);

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
      git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    ]);
    if (results[1].code != 0) return {'error': 'GIT_UNAVAILABLE'};
    final refs = {
      for (final line in results[1].output.split('\n'))
        if (line.split('\t') case [final ref, _, '']) ref,
    };
    // Where new work starts by default: the remote's default branch, as a
    // clone names it, else its main or master.
    final defaultRef = [
      if (results[3].code == 0) results[3].output,
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
    ].where(refs.contains).firstOrNull;
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
      'defaultRef': ?defaultRef,
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

/// Worktree on: a new worktree under `<projectHome>/worktrees/<repository>`,
/// on [branchName] — created from [branchRef], or with [existingBranch] an
/// existing local branch checked out as it is. Without a name one is made up
/// (`harness/brave-otter`). A remote base is fetched first, briefly.
///
/// Worktree off: the folder on the local [branchRef]. A branch that already
/// has a worktree opens there; any other is switched to, only in a folder with
/// nothing uncommitted. With [branchName] the folder moves to that new branch,
/// made where it is now, uncommitted changes and all.
Future<String> prepareGitProject(
  String source,
  String projectHome, {
  required bool worktree,
  String? branchRef,
  String? branchName,
  bool existingBranch = false,
  Random? random,
  GitProcessStarter? startProcess,
}) async {
  Future<({int code, String output})> git(
    List<String> arguments, {
    Duration timeout = const Duration(seconds: 4),
    String? at,
  }) => _git(
    at ?? source,
    arguments,
    timeout: timeout,
    startProcess: startProcess,
  );
  if (!validGitPath(source) ||
      branchRef != null && !validGitRef(branchRef) ||
      branchName != null && !plausibleBranchName(branchName) ||
      existingBranch && branchName == null) {
    throw const RepositoryCloneException('Choose a Git project and branch.');
  }
  final root = await git(['rev-parse', '--show-toplevel']);
  if (root.code != 0) {
    throw const RepositoryCloneException('Choose a Git working folder.');
  }
  // A new branch for the folder itself: [branchRef] names it and does not exist.
  final creating = !worktree && branchName != null && !existingBranch;
  if (branchRef != null && !creating) {
    final ref = await git(['show-ref', '--verify', '--hash', '--', branchRef]);
    if (ref.code != 0) {
      throw const RepositoryCloneException(
        'That branch is no longer available. Choose another branch.',
      );
    }
  }
  // New work from a remote branch starts from where it is now, not from the
  // last fetch. Offline, slow or refused, it starts from what is here.
  final remote = worktree && !existingBranch ? _remoteBranch(branchRef) : null;
  if (remote != null) {
    try {
      await git([
        'fetch',
        '--quiet',
        '--no-tags',
        remote.remote,
        remote.refspec,
      ], timeout: const Duration(seconds: 10));
    } on RepositoryCloneException {
      // Too slow: start from the last fetch.
    }
  }
  final head = await git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    '${existingBranch
        ? 'refs/heads/$branchName'
        : creating
        ? 'HEAD'
        : branchRef ?? 'HEAD'}^{commit}',
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
  if (creating) {
    final exists = await git([
      'show-ref',
      '--verify',
      '--quiet',
      '--',
      'refs/heads/$branchName',
    ]);
    if (exists.code == 0) {
      throw RepositoryCloneException(
        'A branch named $branchName already exists. Choose it instead.',
      );
    }
    final format = await git(['check-ref-format', '--branch', branchName]);
    if (format.code != 0) {
      throw RepositoryCloneException('$branchName is not a valid branch name.');
    }
    final made = await git(['switch', '-c', branchName]);
    if (made.code != 0) {
      throw RepositoryCloneException('Could not create $branchName here.');
    }
    return source;
  }
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
    final status = await git(['status', '--porcelain']);
    if (status.code != 0 || status.output.isNotEmpty) {
      throw const RepositoryCloneException(
        'This folder has uncommitted changes. Commit or stash them before switching branches, or turn Worktree on.',
      );
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
  // Grouped by repository, so the leaf only needs the branch.
  final repository = trees.firstOrNull?.usable == true
      ? p.basename(trees.first.path)
      : p.basename(root.output);
  final locals = await git([
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
  ]);
  final taken = locals.output.split('\n').toSet();
  final branch = branchName ?? placeholderBranch(taken, random: random);
  if (existingBranch) {
    if (!taken.contains('refs/heads/$branch')) {
      throw const RepositoryCloneException(
        'That branch is no longer available. Choose another branch.',
      );
    }
    if (trees.any((tree) => tree.ref == 'refs/heads/$branch')) {
      throw RepositoryCloneException(
        '$branch is checked out in another worktree. Turn Worktree off to open it there.',
      );
    }
  } else {
    if (taken.contains('refs/heads/$branch')) {
      throw RepositoryCloneException(
        'A branch named $branch already exists. Choose another name.',
      );
    }
    final format = await git(['check-ref-format', '--branch', branch]);
    if (format.code != 0) {
      throw RepositoryCloneException('$branch is not a valid branch name.');
    }
  }
  late final String destination;
  try {
    final home = Directory(p.join(projectHome, 'worktrees'));
    final parent = Directory(p.join(home.path, repository));
    await parent.create(recursive: true);
    // Spotlight would index every checkout again.
    if (Platform.isMacOS) {
      await File(p.join(home.path, '.metadata_never_index'))
          .writeAsString('', flush: true)
          .catchError((_) => File(''));
    }
    final leaf = worktreeFolderName(branch);
    for (var attempt = 1; ; attempt++) {
      if (attempt > 100) {
        throw FileSystemException('No free worktree name', parent.path);
      }
      final folder = p.join(
        parent.path,
        attempt == 1 ? leaf : '$leaf-$attempt',
      );
      // Directory.create accepts an existing directory; mkdir reserves the
      // name exclusively, so concurrent starts never share a worktree.
      if ((await Process.run('mkdir', [folder])).exitCode == 0) {
        destination = folder;
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
  final result = await git(
    existingBranch
        ? ['worktree', 'add', '--', destination, branch]
        // A remote branch checked out under its own name tracks it; a new
        // branch from one must not, or it would push onto the base.
        : remote != null && remote.branch == branch
        ? [
            'worktree',
            'add',
            '--track',
            '-b',
            branch,
            '--',
            destination,
            branchRef!,
          ]
        : [
            'worktree',
            'add',
            '--no-track',
            '-b',
            branch,
            '--',
            destination,
            head.output,
          ],
    timeout: const Duration(minutes: 2),
  );
  if (result.code != 0) {
    // A partial checkout or branch stays available for recovery.
    throw RepositoryCloneException(
      'Could not create the worktree at $destination. Check Git and folder permissions, then retry.',
    );
  }
  await _copyIncluded(root.output, destination, startProcess);
  return inside(destination);
}

/// `refs/remotes/origin/fix/typo` → origin, fix/typo, and a refspec that
/// updates exactly that remote-tracking branch.
({String remote, String branch, String refspec})? _remoteBranch(String? ref) {
  final match = RegExp(
    r'^refs/remotes/([A-Za-z0-9._][A-Za-z0-9._-]*)/([A-Za-z0-9._][^\s]*)$',
  ).firstMatch(ref ?? '');
  if (match == null || match.group(2) == 'HEAD') return null;
  final remote = match.group(1)!, branch = match.group(2)!;
  return (
    remote: remote,
    branch: branch,
    refspec: '+refs/heads/$branch:refs/remotes/$remote/$branch',
  );
}

/// `.worktreeinclude` (gitignore syntax) in the repository names ignored files
/// a new worktree needs and Git will not bring: `.env`, local config. Only
/// files that are both listed and ignored are copied, never over one the
/// checkout has. A copy that fails leaves the worktree as Git made it.
Future<void> _copyIncluded(
  String from,
  String to,
  GitProcessStarter? startProcess,
) async {
  final include = p.join(from, '.worktreeinclude');
  try {
    if (!await File(include).exists()) return;
    Future<List<String>> list(String exclude) async {
      final out = await _git(from, [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--directory',
        exclude,
      ], startProcess: startProcess);
      return out.code == 0
          ? out.output.split('\u0000').where((e) => e.isNotEmpty).toList()
          : const [];
    }

    final listed = await list('--exclude-from=$include');
    final ignored = await list('--exclude-standard');
    bool isIgnored(String entry) => ignored.any(
      (path) => path == entry || path.endsWith('/') && entry.startsWith(path),
    );
    for (final entry in listed.where(isIgnored).take(200)) {
      final relative = entry.replaceFirst(RegExp(r'/$'), '');
      if (relative.split('/').contains('..')) continue;
      final target = p.join(to, relative);
      if (await FileSystemEntity.type(target, followLinks: false) !=
          FileSystemEntityType.notFound) {
        continue;
      }
      await Directory(p.dirname(target)).create(recursive: true);
      await Process.run('cp', [
        '-R',
        '-p',
        '--',
        p.join(from, relative),
        target,
      ]);
    }
  } on FileSystemException {
    return;
  } on ProcessException {
    return;
  } on RepositoryCloneException {
    return;
  }
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
