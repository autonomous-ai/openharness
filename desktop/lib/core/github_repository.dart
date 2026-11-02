/// How a repository address reaches GitHub: the browser's HTTPS link, plain
/// SSH, or an SSH host alias from the computer's `~/.ssh/config` — a second
/// GitHub account on one computer is reached only through its alias.
enum GitHubTransport { https, ssh, alias }

/// An SSH host alias as `ssh` and `git` may be given one: it can never begin
/// with `-` and turn into an option. Mirrors cli/src/lib/githubRepository.ts.
final _alias = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$');
final _owner = RegExp(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$');
final _name = RegExp(r'^[A-Za-z0-9_.-]{1,100}$');

bool isSafeSshAlias(String alias) => _alias.hasMatch(alias);

/// Whether an SSH host name is GitHub: `ssh.github.com` is GitHub's SSH over
/// port 443, which a second account's alias behind a firewall uses.
bool isGitHubHost(String? host) =>
    host == 'github.com' || host == 'ssh.github.com';

/// One GitHub repository somebody pasted. Held to the CLI's vectors
/// (cli/src/lib/__fixtures__/github-repository-vectors.json): the daemon clones
/// another computer's harness and this app clones this computer's.
class GitHubRepository {
  const GitHubRepository._(
    this.url,
    this.owner,
    this.name,
    this.transport, [
    this.alias,
  ]);
  final String url, owner, name;
  final GitHubTransport transport;

  /// The `~/.ssh/config` host it goes through, for [GitHubTransport.alias].
  final String? alias;

  static GitHubRepository? parse(String input) {
    final text = input.trim();
    // A query, a fragment, an escape or a space is never part of a
    // repository's address, even an empty one (the shared vectors).
    if (RegExp(r'[\s?#%]').hasMatch(text)) return null;
    final scp = RegExp(r'^git@([^:/\s]+):(\S+)$').firstMatch(text);
    String path;
    String? alias;
    if (scp != null) {
      final host = scp.group(1)!;
      if (host != 'github.com') {
        if (!isSafeSshAlias(host)) return null;
        alias = host;
      }
      path = scp.group(2)!;
    } else {
      // `github.com/owner/repo` is a browser link without its scheme.
      final withScheme = text.contains('://')
          ? text
          : text.startsWith('github.com/')
          ? 'https://$text'
          : 'https://github.com/$text';
      final uri = Uri.tryParse(withScheme);
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
        !_owner.hasMatch(parts[0]) ||
        !_name.hasMatch(parts[1]) ||
        parts[1] == '.' ||
        parts[1] == '..') {
      return null;
    }
    if (scp == null) {
      return GitHubRepository._(
        'https://github.com/$path.git',
        parts[0],
        parts[1],
        GitHubTransport.https,
      );
    }
    return GitHubRepository._(
      'git@${alias ?? 'github.com'}:$path.git',
      parts[0],
      parts[1],
      alias == null ? GitHubTransport.ssh : GitHubTransport.alias,
      alias,
    );
  }

  /// `owner/repo`, as a person reads it.
  String get slug => '$owner/$name';

  /// The address to hand anyone but this computer's own git: an alias means
  /// something only in this computer's `~/.ssh/config`, so a Swarm, a cloud
  /// agent or a teammate gets the HTTPS link instead.
  String get shareableUrl =>
      alias == null ? url : 'https://github.com/$slug.git';
}

/// One repository however git spells its address: `github.com/owner/repo`
/// for `https://github.com/Owner/Repo.git/`, `git@github.com:owner/repo`,
/// `ssh://git@github.com:22/owner/repo.git` and `git://…`, credentials and
/// ports left out. Lowercased: host names are case-insensitive, and so are
/// GitHub's owner and repository names, the only host a clone is asked for.
/// Null for a local path or anything else that names no host. Mirrors
/// `repositoryIdentity` in cli/src/lib/githubRepository.ts.
String? repositoryIdentity(String address) {
  final parts = _hostAndPath(address);
  return parts == null ? null : '${parts.$1}/${parts.$2}'.toLowerCase();
}

/// [repositoryIdentity] with an SSH alias read as the host it stands for, so
/// a checkout cloned through `git@gh-work:org/repo` is the repository a
/// browser link names. [resolveHost] answers null for a host it cannot read.
Future<String?> resolvedRepositoryIdentity(
  String address,
  Future<String?> Function(String host) resolveHost,
) async {
  final parts = _hostAndPath(address);
  if (parts == null) return null;
  var host = parts.$1.toLowerCase();
  // Only ssh reads ~/.ssh/config: an https or git:// host is a real name.
  final scheme = RegExp(
    r'^([a-z][a-z0-9+.-]*)://',
    caseSensitive: false,
  ).firstMatch(address.trim())?.group(1)?.toLowerCase();
  final viaSsh =
      scheme == null ||
      scheme == 'ssh' ||
      scheme == 'git+ssh' ||
      scheme == 'ssh+git';
  if (host != 'github.com' && viaSsh && isSafeSshAlias(host)) {
    host = (await resolveHost(host))?.toLowerCase() ?? host;
  }
  if (isGitHubHost(host)) host = 'github.com';
  return '$host/${parts.$2}'.toLowerCase();
}

(String, String)? _hostAndPath(String address) {
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
  return host.isEmpty || path.isEmpty ? null : (host, path);
}

/// The most `~/.ssh/config` aliases a refused clone goes on to try: each is a
/// round trip to GitHub, and three covers every multi-account setup seen.
const maxCloneAliases = 3;

/// The addresses a clone tries, in order: what was pasted, the same
/// repository over the other transport, then the computer's GitHub [aliases].
/// A clone moves to the next only when GitHub refused access.
List<String> cloneAttempts(GitHubRepository repository, List<String> aliases) {
  final path = repository.slug;
  final https = 'https://github.com/$path.git';
  final ssh = 'git@github.com:$path.git';
  final usable = aliases
      .where((alias) => alias != 'github.com' && isSafeSshAlias(alias))
      .take(maxCloneAliases);
  // A set keeps the first of each: whatever was pasted, then the other.
  return {
    repository.url,
    https,
    ssh,
    for (final alias in usable) 'git@$alias:$path.git',
  }.toList();
}
