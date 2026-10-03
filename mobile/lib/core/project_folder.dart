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
  const ProjectFolderRequest.newProject()
    : repository = null,
      gitSource = null,
      branchRef = null,
      branchName = null,
      existingBranch = false,
      placeholder = false,
      createsWorktree = false,
      suggestedName = null;

  /// A fresh project named after its first [task] (openharness#94): the machine makes
  /// `~/harnesses/robot-noi-chuyen-voi-gemini`, and numbers it past one that exists. A task with
  /// no words to name it by leaves the name to the machine, as [ProjectFolderRequest.newProject].
  ProjectFolderRequest.forTask(String task)
    : repository = null,
      gitSource = null,
      branchRef = null,
      branchName = null,
      existingBranch = false,
      placeholder = false,
      createsWorktree = false,
      suggestedName = taskProjectSlug(task);

  /// Let the machine clone [value] and work in the checkout.
  const ProjectFolderRequest.remote(GitHubRepository value)
    : repository = value,
      gitSource = null,
      branchRef = null,
      branchName = null,
      existingBranch = false,
      placeholder = false,
      createsWorktree = false,
      suggestedName = null;

  /// A new worktree of the repository at [source], on [branchName]: created
  /// from [branchRef], or with [existingBranch] that local branch checked out
  /// as it is. Without a name the machine makes one up.
  ///
  /// ⚠️ [placeholder] says the name was MADE UP here rather than typed, so the
  /// machine may replace it with the session's own name once the engine reports
  /// one. A name a person typed is theirs and is never replaced.
  const ProjectFolderRequest.worktree(
    String source, {
    this.branchRef,
    this.branchName,
    this.existingBranch = false,
    this.placeholder = false,
  }) : gitSource = source,
       createsWorktree = true,
       repository = null,
       suggestedName = null;

  /// The folder at [source] itself on [ref], or with [newBranch] on that new
  /// branch, made where the folder is now.
  ///
  /// ⚠️ [ref] then names the NEW branch, so a daemon too old to make one
  /// refuses the request rather than quietly starting the harness on the old
  /// branch — which is the one outcome nobody could see had happened.
  const ProjectFolderRequest.branch(
    String source,
    String ref, {
    String? newBranch,
  }) : gitSource = source,
       branchRef = ref,
       branchName = newBranch,
       existingBranch = false,
       placeholder = false,
       createsWorktree = false,
       repository = null,
       suggestedName = null;

  final GitHubRepository? repository;

  /// The folder a fresh project is named after its first task, or null to leave the name to the
  /// machine (engine and time).
  final String? suggestedName;

  /// The existing checkout a branch or worktree is taken from. Null for the two
  /// sources that have no repository yet.
  final String? gitSource;

  /// What to start from, and what to call the branch that starts there.
  final String? branchRef, branchName;

  final bool createsWorktree, existingBranch, placeholder;

  /// ⚠️ Sent INSTEAD of `cwd`, never beside it — see `AppNotifier.createAgent`. The two answer the
  /// same question, and a machine given both would have to guess which one was meant.
  ///
  /// The keys are the desktop's, byte for byte (`core/project_folder.dart`
  /// there): the same CLI parses both, and a phone inventing its own spelling
  /// would be a second dialect to keep in step.
  Map<String, String> get payload => {
    'projectSource': gitSource != null
        ? (createsWorktree ? 'worktree' : 'branch')
        : repository == null
        ? 'new'
        : 'remote',
    'gitSource': ?gitSource,
    'branchRef': ?branchRef,
    // A daemon that predates these names the worktree's branch itself.
    'branchName': ?branchName,
    if (existingBranch) 'branchMode': 'existing',
    if (placeholder) 'branchMode': 'placeholder',
    if (repository != null) 'repositoryUrl': repository!.url,
    // A made-up name: the machine numbers it past a folder that exists rather than refusing it. A
    // daemon that predates `projectNameMode` refuses a taken name instead; one that predates
    // `projectName` names the folder itself.
    'projectName': ?suggestedName,
    if (suggestedName != null) 'projectNameMode': 'suggested',
  };
}

/// How many of a first task's words name the project and the agent. The desktop's
/// `core/project_folder.dart` holds the same rule; the two apps name the same task the same way.
const _taskNameWords = 6;

/// The first line of [task], cut to its first few words — what a project named after its task, and
/// the agent in it, are called ("Robot nói chuyện với Gemini"). Null when the task has no letters or
/// digits to name anything by.
String? taskProjectTitle(String task) {
  final line = task
      .trim()
      .split('\n')
      .first
      .split(RegExp(r'\s+'))
      .where((word) => word.isNotEmpty)
      .take(_taskNameWords)
      .join(' ');
  if (!RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(line)) return null;
  return line.length > 60 ? line.substring(0, 60).trimRight() : line;
}

/// The folder a project named after [task] gets: lowercase words joined by dashes, accents folded
/// (`robot-noi-chuyen-voi-gemini`). Null when nothing usable is left.
String? taskProjectSlug(String task) {
  final title = taskProjectTitle(task);
  if (title == null) return null;
  final slug = foldDiacritics(title)
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  if (slug.isEmpty) return null;
  return slug.length > 48
      ? slug.substring(0, 48).replaceAll(RegExp(r'-+$'), '')
      : slug;
}

/// [text] with Latin letters' accents removed: Vietnamese (`đ` included), French, German,
/// Spanish, Portuguese and the like. Other scripts pass through untouched.
String foldDiacritics(String text) {
  final out = StringBuffer();
  for (final rune in text.runes) {
    final char = String.fromCharCode(rune);
    out.write(_folds[char] ?? char);
  }
  return out.toString();
}

final Map<String, String> _folds = () {
  const groups = {
    'a': 'àáảãạăằắẳẵặâầấẩẫậäåā',
    'A': 'ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÄÅĀ',
    'e': 'èéẻẽẹêềếểễệëē',
    'E': 'ÈÉẺẼẸÊỀẾỂỄỆËĒ',
    'i': 'ìíỉĩịïī',
    'I': 'ÌÍỈĨỊÏĪ',
    'o': 'òóỏõọôồốổỗộơờớởỡợöøō',
    'O': 'ÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÖØŌ',
    'u': 'ùúủũụưừứửữựüū',
    'U': 'ÙÚỦŨỤƯỪỨỬỮỰÜŪ',
    'y': 'ỳýỷỹỵÿ',
    'Y': 'ỲÝỶỸỴŸ',
    'd': 'đ',
    'D': 'Đ',
    'c': 'ç',
    'C': 'Ç',
    'n': 'ñ',
    'N': 'Ñ',
    'ss': 'ß',
  };
  return {
    for (final MapEntry(key: base, value: letters) in groups.entries)
      for (final letter in letters.runes) String.fromCharCode(letter): base,
  };
}();

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
