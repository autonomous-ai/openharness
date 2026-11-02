import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import 'github_repository.dart';
import 'ssh_hosts.dart';

export 'github_repository.dart';

class RepositoryCloneException implements Exception {
  const RepositoryCloneException(this.message);
  final String message;
  @override
  String toString() => message;
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
  RepositoryClone({
    GitCloneProcess? startProcess,
    GitOriginReader? readOrigin,
    SshHosts? sshHosts,
  }) : _startProcess = startProcess ?? _startGit,
       _readOrigin = readOrigin ?? readCheckoutOrigin,
       _sshHosts = sshHosts ?? SshHosts();
  final GitCloneProcess _startProcess;
  final GitOriginReader _readOrigin;
  final SshHosts _sshHosts;
  final _stagings = <Directory>[];
  Process? _process;

  /// The `~/.ssh/config` alias the clone went through, when it needed one: a
  /// second GitHub account, which later pushes from the checkout use too.
  String? clonedVia;
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
  /// (another repository, a folder of files) stays the person's, refused. An
  /// origin cloned through an SSH alias names the repository its host does.
  Future<bool> _holds(String folder, GitHubRepository repository) async {
    try {
      final origin = await _readOrigin(folder);
      if (origin == null) return false;
      // Both sides: a pasted alias names the repository its host does too.
      return await resolvedRepositoryIdentity(origin, _sshHosts.resolveHost) ==
          await resolvedRepositoryIdentity(
            repository.url,
            _sshHosts.resolveHost,
          );
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
      if (repository.alias case final alias?
          when !isGitHubHost(await _sshHosts.resolveHost(alias))) {
        throw RepositoryCloneException(
          '$alias isn\'t a GitHub host on this computer.',
        );
      }
      final checkout = await _cloneWithAccess(repository, parent);
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
      _process = null;
      await _removeStagings();
    }
  }

  /// A refused attempt's staging goes before the next one starts, so a quit
  /// mid-run leaves at most one `.harness-clone-*` behind.
  Future<void> _removeStagings() async {
    for (final staging in [..._stagings]) {
      _stagings.remove(staging);
      try {
        if (await staging.exists()) await staging.delete(recursive: true);
      } on FileSystemException {
        /* The checkout outcome remains authoritative. */
      }
    }
  }

  /// Clones through each way this computer may reach [repository] — what was
  /// pasted, the other transport, then its `~/.ssh/config` GitHub aliases —
  /// moving on only when GitHub refused access. On 2026-10-30 a developer Mac
  /// with SSH keys and no HTTPS credential failed every browser link, and its
  /// second account's repositories answered only through an alias.
  Future<String> _cloneWithAccess(
    GitHubRepository repository,
    String parent,
  ) async {
    final tried = <String>{};
    var attempts = cloneAttempts(repository, const []);
    var aliasesRead = false;
    for (var i = 0; i < attempts.length; i++) {
      final url = attempts[i];
      if (!tried.add(url)) continue;
      final checkout = await _cloneOnce(url, parent);
      if (checkout == null) await _removeStagings();
      if (checkout != null) {
        clonedVia = GitHubRepository.parse(url)?.alias;
        return checkout;
      }
      // Refused: the aliases are read only now, when they may be needed.
      if (!aliasesRead) {
        aliasesRead = true;
        attempts = cloneAttempts(repository, await _sshHosts.githubAliases());
        i = -1;
      }
    }
    throw RepositoryAccessDenied(repository);
  }

  /// One `git clone` of [url] into a fresh staging folder: the checkout, or
  /// null when GitHub refused access. Any other failure ends the clone.
  Future<String?> _cloneOnce(String url, String parent) async {
    if (_cancelled) throw const RepositoryCloneException('Clone cancelled.');
    final staging = await Directory(parent).createTemp('.harness-clone-');
    _stagings.add(staging);
    final checkout = p.join(staging.path, 'checkout');
    var timedOut = false;
    final process = _process = await _startProcess(
      ['clone', '--', url, checkout],
      {
        'GIT_TERMINAL_PROMPT': '0',
        'GCM_INTERACTIVE': 'Never',
        if (!Platform.environment.containsKey('GIT_SSH_COMMAND'))
          'GIT_SSH_COMMAND': 'ssh -oBatchMode=yes -oConnectTimeout=20',
      },
    );
    unawaited(process.stdin.close());
    if (_cancelled) process.kill();
    final deadline = Timer(const Duration(minutes: 5), () {
      timedOut = true;
      process.kill();
    });
    try {
      // Drain both streams, retaining only a bounded diagnostic for
      // classifying failures. Git URLs/credential-helper output never enter
      // the UI or logs.
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
      if (code == 0) return checkout;
      // A private repository answers "not found" to whoever cannot see it.
      if (RegExp(
        r'authentication|permission denied|could not read Username|repository not found',
        caseSensitive: false,
      ).hasMatch(diagnostic)) {
        return null;
      }
      throw const RepositoryCloneException(
        'Could not clone the repository. Check the URL and connection, then retry.',
      );
    } finally {
      deadline.cancel();
    }
  }
}

/// Every way this computer has to GitHub was refused: the repository is
/// private to accounts it is not signed in as, or does not exist.
class RepositoryAccessDenied extends RepositoryCloneException {
  RepositoryAccessDenied(GitHubRepository repository)
    : super(
        'No access to ${repository.slug} on '
        '${Platform.isMacOS ? 'this Mac' : 'this computer'}.',
      );
}
