/// Where a new agent's project comes from, when it is not a folder that already exists.
///
/// ⚠️ This is the phone's HALF of the desktop's `core/project_folder.dart`. That one carries a
/// second half, `prepareLocal`, which makes the folder or clones the repository with `dart:io` and
/// hands over a real path — right for a machine the desktop is running ON, and meaningless here.
/// Every machine a phone talks to is remote, so the machine does the work and this only has to say
/// what to do. Nothing in this file touches a filesystem.
///
/// The keys travel to `cli/src/lib/projectFolder.ts`, which parses them and clones. The CLI parses
/// the URL again at its end; [GitHubRepository.parse] runs here anyway so a typo is answered on the
/// screen it was typed on rather than after a round trip.
class ProjectFolderRequest {
  /// Let the machine make a fresh project folder of its own.
  const ProjectFolderRequest.newProject() : repository = null;

  /// Let the machine clone [value] and work in the checkout.
  const ProjectFolderRequest.remote(GitHubRepository value) : repository = value;

  final GitHubRepository? repository;

  /// ⚠️ Sent INSTEAD of `cwd`, never beside it — see `AppNotifier.createAgent`. The two answer the
  /// same question, and a machine given both would have to guess which one was meant.
  Map<String, String> get payload => {
    'projectSource': repository == null ? 'new' : 'remote',
    if (repository != null) 'repositoryUrl': repository!.url,
  };
}

/// A GitHub repository named by URL — `owner/repo`, an https link, or an ssh remote.
///
/// Ported from the desktop's `core/repository_clone.dart` without the cloning it sits beside there.
class GitHubRepository {
  const GitHubRepository._(this.url, this.name);

  final String url, name;

  /// Null when [input] does not name a GitHub repository.
  ///
  /// ⚠️ Strict on purpose. The result is handed to a machine that will run `git clone` with it, so
  /// everything that could smuggle something else into that command — a userinfo, a port, a query,
  /// a fragment, a host that is not github.com — is refused rather than trimmed off and accepted.
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
