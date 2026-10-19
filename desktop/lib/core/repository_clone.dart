import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

class GitHubRepository {
  const GitHubRepository._(this.url, this.name);
  final String url, name;

  static GitHubRepository? parse(String input) {
    final text = input.trim();
    final ssh = text.startsWith('git@github.com:');
    String path;
    if (ssh) {
      path = text.substring('git@github.com:'.length);
    } else {
      final uri = Uri.tryParse(
        text.contains('://') ? text : 'https://github.com/$text',
      );
      if (uri == null ||
          uri.scheme != 'https' ||
          uri.host != 'github.com' ||
          uri.userInfo.isNotEmpty ||
          uri.hasPort ||
          uri.hasQuery ||
          uri.hasFragment) {
        return null;
      }
      path = uri.path.replaceFirst(RegExp(r'^/'), '');
    }
    path = path
        .replaceFirst(RegExp(r'/$'), '')
        .replaceFirst(RegExp(r'\.git$'), '');
    final parts = path.split('/');
    if (parts.length != 2 ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$').hasMatch(parts[0]) ||
        !RegExp(r'^[A-Za-z0-9_.-]{1,100}$').hasMatch(parts[1]) ||
        parts[1] == '.' ||
        parts[1] == '..') {
      return null;
    }
    return GitHubRepository._(
      ssh ? 'git@github.com:$path.git' : 'https://github.com/$path.git',
      parts[1],
    );
  }
}

class RepositoryCloneException implements Exception {
  const RepositoryCloneException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One repository however git spells its address: `github.com/owner/repo`
/// for `https://github.com/Owner/Repo.git/`, `git@github.com:owner/repo`,
/// `ssh://git@github.com:22/owner/repo.git` and `git://…`, credentials and
/// ports left out. Lowercased: host names are case-insensitive, and so are
/// GitHub's owner and repository names, the only host a clone is asked for.
/// Null for a local path or anything else that names no host. Mirrors
/// `repositoryIdentity` in cli/src/lib/projectFolder.ts.
String? repositoryIdentity(String address) {
  final raw = address.trim();
  String host, path;
  // scp-like `[user@]host:path`: no scheme, and no slash before its colon.
  final scp = raw.contains('://')
      ? null
      : RegExp(r'^(?:[^@/\s]+@)?([^:/\s]+):(\S+)$').firstMatch(raw);
  if (scp != null) {
    host = scp.group(1)!;
    path = scp.group(2)!;
  } else {
    final uri = Uri.tryParse(raw);
    const schemes = {'https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'};
    if (uri == null || !schemes.contains(uri.scheme.toLowerCase())) {
      return null;
    }
    host = uri.host;
    path = uri.path;
  }
  path = path
      .replaceFirst(RegExp(r'^/+'), '')
      .replaceFirst(RegExp(r'/+$'), '')
      .replaceFirst(RegExp(r'\.git$', caseSensitive: false), '');
  return host.isEmpty || path.isEmpty ? null : '$host/$path'.toLowerCase();
}

typedef GitCloneProcess = Future<Process> Function(
  List<String> arguments,
  Map<String, String> environment,
);

/// The `origin` of the checkout at a folder, or null when the folder is not
/// itself one or git cannot say.
typedef GitOriginReader = Future<String?> Function(String folder);

/// Clones into a private staging directory. Existing working folders are never
/// removed, and a failed/cancelled clone leaves no partial project. One that
/// is already a checkout of the same repository is that project, and is used
/// rather than refused.
class RepositoryClone {
  RepositoryClone({GitCloneProcess? startProcess, GitOriginReader? readOrigin})
    : _startProcess = startProcess ?? _startGit,
      _readOrigin = readOrigin ?? readCheckoutOrigin;
  final GitCloneProcess _startProcess;
  final GitOriginReader _readOrigin;
  Process? _process;
  bool _cancelled = false;
  bool _started = false;

  static Future<Process> _startGit(
    List<String> arguments,
    Map<String, String> environment,
  ) => Process.start('git', arguments, environment: environment);

  /// `git remote get-url origin` in [folder], bounded: `.git` is looked for
  /// before git runs (on a Mac without the Command Line Tools `git` is Apple's
  /// stub, which opens an install dialog), git may not look above [folder]
  /// (GIT_CEILING_DIRECTORIES), and it gets four seconds, as the CLI's do.
  static Future<String?> readCheckoutOrigin(String folder) async {
    if (await FileSystemEntity.type(
          p.join(folder, '.git'),
          followLinks: false,
        ) ==
        FileSystemEntityType.notFound) {
      return null;
    }
    final Process process;
    try {
      process = await Process.start(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-C',
          folder,
          'remote',
          'get-url',
          'origin',
        ],
        environment: {
          'GIT_TERMINAL_PROMPT': '0',
          'GCM_INTERACTIVE': 'Never',
          'GIT_OPTIONAL_LOCKS': '0',
          'GIT_CEILING_DIRECTORIES': p.dirname(folder),
        },
      );
    } on ProcessException {
      return null;
    }
    unawaited(process.stdin.close());
    final output = process.stdout
        .transform(const Utf8Decoder(allowMalformed: true))
        .join();
    unawaited(process.stderr.drain<void>());
    try {
      final code = await process.exitCode.timeout(const Duration(seconds: 4));
      final origin = (await output).trim();
      return code == 0 && origin.isNotEmpty ? origin : null;
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      return null;
    }
  }

  /// Whether [folder] is a checkout of [repository]: anything else there
  /// (another repository, a folder of files) stays the person's, refused.
  Future<bool> _holds(String folder, GitHubRepository repository) async {
    try {
      final origin = await _readOrigin(folder);
      return origin != null &&
          repositoryIdentity(origin) == repositoryIdentity(repository.url);
    } catch (_) {
      return false;
    }
  }

  void cancel() {
    _cancelled = true;
    _process?.kill();
  }

  Future<String> run(GitHubRepository repository, String parent) async {
    if (_started) throw StateError('A clone can only be started once.');
    _started = true;
    Directory? staging;
    Timer? deadline;
    var timedOut = false;
    try {
      if (!p.isAbsolute(parent) || !await Directory(parent).exists()) {
        throw const RepositoryCloneException(
          'Choose an existing destination folder.',
        );
      }
      final destination = p.join(parent, repository.name);
      if (await FileSystemEntity.type(destination, followLinks: false) !=
          FileSystemEntityType.notFound) {
        // The repository asked for, already checked out there: started in,
        // never cloned again, as a machine's own clone now is
        // (cli/src/lib/projectFolder.ts). Refusing it failed the start for
        // asking twice; PROJECT_EXISTS was 4 of 7 failed starts on Oct 18.
        if (await _holds(destination, repository)) return destination;
        throw RepositoryCloneException(
          '“${repository.name}” already exists here. Choose another destination, or open that folder.',
        );
      }
      if (_cancelled) throw const RepositoryCloneException('Clone cancelled.');
      staging = await Directory(parent).createTemp('.harness-clone-');
      final checkout = p.join(staging.path, 'checkout');
      final process = _process = await _startProcess(
        ['clone', '--', repository.url, checkout],
        {
          'GIT_TERMINAL_PROMPT': '0',
          'GCM_INTERACTIVE': 'Never',
          if (!Platform.environment.containsKey('GIT_SSH_COMMAND'))
            'GIT_SSH_COMMAND': 'ssh -oBatchMode=yes -oConnectTimeout=20',
        },
      );
      unawaited(process.stdin.close());
      if (_cancelled) process.kill();
      deadline = Timer(const Duration(minutes: 5), () {
        timedOut = true;
        process.kill();
      });
      // Drain both streams, retaining only a bounded diagnostic for classifying
      // failures. Git URLs/credential-helper output never enter the UI or logs.
      final output = process.stdout.drain<void>();
      var diagnostic = '';
      final errors = process.stderr
          .transform(const Utf8Decoder(allowMalformed: true))
          .forEach((chunk) {
            if (diagnostic.length < 8192) {
              diagnostic += chunk.substring(
                0,
                chunk.length.clamp(0, 8192 - diagnostic.length),
              );
            }
          });
      final code = await process.exitCode;
      await output;
      await errors;
      if (_cancelled) throw const RepositoryCloneException('Clone cancelled.');
      if (timedOut) {
        throw const RepositoryCloneException(
          'Cloning took too long. Check the connection and retry.',
        );
      }
      if (code != 0) {
        if (RegExp(
          r'authentication|permission denied|could not read Username|repository not found',
          caseSensitive: false,
        ).hasMatch(diagnostic)) {
          throw const RepositoryCloneException(
            'Could not access this repository. Check the URL and your GitHub access on this computer.',
          );
        }
        throw const RepositoryCloneException(
          'Could not clone the repository. Check the URL and connection, then retry.',
        );
      }
      if (await FileSystemEntity.type(destination, followLinks: false) !=
          FileSystemEntityType.notFound) {
        // Another start cloned the same repository meanwhile: that one is
        // kept and this staging goes (below).
        if (await _holds(destination, repository)) return destination;
        throw RepositoryCloneException(
          '“${repository.name}” was created while cloning. Choose another destination.',
        );
      }
      await Directory(checkout).rename(destination);
      return destination;
    } on ProcessException {
      throw const RepositoryCloneException(
        'Git could not start. Install Git on this computer, then retry.',
      );
    } on FileSystemException {
      throw const RepositoryCloneException(
        'Could not write to this destination. Choose a folder you can edit.',
      );
    } finally {
      deadline?.cancel();
      _process = null;
      if (staging != null) {
        try {
          if (await staging.exists()) await staging.delete(recursive: true);
        } on FileSystemException {
          /* The checkout outcome remains authoritative. */
        }
      }
    }
  }
}
