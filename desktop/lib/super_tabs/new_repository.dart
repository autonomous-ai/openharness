import 'package:flutter/foundation.dart';

import '../core/github_repository.dart';
import 'controller.dart';
import 'model.dart';

/// New Project's New Repository (task #3374; design
/// docs/plans/2026-11-05-new-repository-design.md, backend PR #3201): its
/// rules and the lines each outcome shows. The copy is the design's failure
/// table (F1 to F11), naming Desktop's own places where it names the phone's.

/// A repository to create for a new project: in organization [owner], private
/// unless the person turned it off.
@immutable
class NewRepositoryAsk {
  const NewRepositoryAsk({
    required this.owner,
    required this.name,
    this.private = true,
  });
  final String owner, name;
  final bool private;

  /// `owner/name`, as a person reads it.
  String get slug => '$owner/$name';

  @override
  bool operator ==(Object other) =>
      other is NewRepositoryAsk &&
      other.owner == owner &&
      other.name == name &&
      other.private == private;
  @override
  int get hashCode => Object.hash(owner, name, private);
}

/// GitHub's repository name rule (backend repositoryCreate.ts).
final _name = RegExp(r'^[A-Za-z0-9._-]{1,100}$');

/// An organization's login (backend repositoryCreate.ts `GITHUB_OWNER`).
final newRepositoryOwnerPattern = RegExp(
  r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$',
);

/// F1 for a [name] that breaks GitHub's rules; null for a good one, and for
/// nothing typed yet.
String? newRepositoryNameProblem(String name) =>
    name.isEmpty || newRepositoryNameUsable(name)
    ? null
    : 'Use letters, numbers, - _ or . (up to 100).';

/// Whether [name] can be a new repository's name.
bool newRepositoryNameUsable(String name) =>
    _name.hasMatch(name) && name != '.' && name != '..';

/// The GitHub organizations the Swarm already uses: the owners of its
/// projects' repositories, in the Swarm's order, each once whatever its case.
List<String> newRepositoryOwners(Iterable<SuperTabProject> projects) {
  final seen = <String>{};
  return [
    for (final project in projects)
      if (project.repository?['repositoryUrl'] case final String url)
        if (_onGitHub(url) case final owner?)
          if (seen.add(owner.toLowerCase())) owner,
  ];
}

String? _onGitHub(String url) {
  final repository = GitHubRepository.parse(url);
  if (repository == null) return null;
  return newRepositoryOwnerPattern.hasMatch(repository.owner)
      ? repository.owner
      : null;
}

/// What GitHub's sign-in made of an ask so far.
sealed class NewRepositoryOutcome {
  const NewRepositoryOutcome();
}

/// Not answered yet: the person is in GitHub, or it is being created.
class NewRepositoryWaiting extends NewRepositoryOutcome {
  const NewRepositoryWaiting();
}

/// Made on GitHub, at [repositoryUrl]. [reachable] says whether teammates'
/// agents can reach it through the Harness GitHub App (F7 when not).
class NewRepositoryCreated extends NewRepositoryOutcome {
  const NewRepositoryCreated(this.repositoryUrl, {required this.reachable});
  final String repositoryUrl;
  final bool reachable;
}

/// Not made, and why, in the line the composer shows.
class NewRepositoryFailed extends NewRepositoryOutcome {
  const NewRepositoryFailed(this.message);
  final String message;
}

/// How long the sign-in's link lasts (backend approvals.ts `STATE_TTL_MS`):
/// an ask still waiting after it was never finished in GitHub.
const kNewRepositoryLinkLife = Duration(minutes: 10);

/// How long a create may run before Try again is offered (security review of
/// #3201): the server may have stopped mid-create.
const kNewRepositoryCreateLife = Duration(minutes: 5);

const kNewRepositoryNothingCreated = 'Nothing was created.';

/// What the project's [creation] says of the ask made at [at] (ms, the
/// server's clock), read at [now]. Another ask's outcome is never this one's:
/// an older one is the state not caught up yet, a newer one replaced it.
NewRepositoryOutcome newRepositoryOutcome(
  SuperTabRepositoryCreation? creation,
  NewRepositoryAsk ask, {
  required int at,
  required DateTime now,
}) {
  final age = now.difference(DateTime.fromMillisecondsSinceEpoch(at));
  if (creation != null && creation.at > at) {
    return const NewRepositoryFailed(kNewRepositoryNothingCreated);
  }
  if (creation == null || creation.at < at || creation.state == 'waiting') {
    return age > kNewRepositoryLinkLife
        ? const NewRepositoryFailed(kNewRepositoryNothingCreated)
        : const NewRepositoryWaiting();
  }
  return switch (creation.state) {
    'created' when creation.repositoryUrl != null => NewRepositoryCreated(
      creation.repositoryUrl!,
      reachable: creation.reachable != false,
    ),
    'taken' => NewRepositoryFailed(
      '${ask.slug} already exists. Choose another name, or choose it under '
      'GitHub in Choose repo to use it.',
    ),
    'refused' => NewRepositoryFailed(
      'GitHub didn’t let you create a repository in ${ask.owner}: '
      '${_sentence(creation.reason ?? 'GitHub gave no reason.')} Ask an owner '
      'of ${ask.owner}, or create it on GitHub and paste its link under GitHub '
      'in Choose repo.',
    ),
    'cancelled' => const NewRepositoryFailed(kNewRepositoryNothingCreated),
    'creating' when age > kNewRepositoryCreateLife => NewRepositoryFailed(
      'GitHub didn’t answer in time. Try again: if ${ask.slug} was made, '
      'Harness finds it.',
    ),
    'creating' => const NewRepositoryWaiting(),
    _ => const NewRepositoryFailed(
      'GitHub didn’t answer. Nothing was created.',
    ),
  };
}

String _sentence(String text) {
  final trimmed = text.trim();
  return RegExp(r'[.!?]$').hasMatch(trimmed) ? trimmed : '$trimmed.';
}

/// F7: made, but the Harness GitHub App does not cover it yet.
String newRepositoryUnreachable(NewRepositoryAsk ask) =>
    '${ask.slug} is made, but Harness can’t reach it yet. An owner of '
    '${ask.owner} adds it under Settings → GitHub Apps → Harness → Configure.';

/// F4: Harness is not installed on [owner].
String newRepositoryNotInstalled(String owner) =>
    'Harness isn’t on $owner’s GitHub yet.';

/// F5: installed on [owner], whose owners have not accepted the permission.
String newRepositoryNotAccepted(String owner) =>
    'An owner of $owner needs to accept Harness’s new permission once: '
    'GitHub Settings → GitHub Apps → Harness.';

/// F11: the project went while its person was in GitHub.
const kNewRepositoryProjectGone =
    'The project was deleted meanwhile. Nothing was created.';

/// What Copy message gives the person to send an owner of [owner]: the
/// install for F4 (with its [installUrl]), the permission for F5.
String newRepositoryOwnerMessage(String owner, {String? installUrl}) =>
    installUrl != null
    ? 'Could you install Harness on $owner’s GitHub, so we can create '
          'repositories there? $installUrl'
    : 'Could you accept Harness’s new permission on $owner once? '
          'GitHub Settings → GitHub Apps → Harness.';

/// Whether an organization lets Harness create a repository there (backend
/// `GET /api/super-tabs/:tabId/github/owners/:owner`).
@immutable
class NewRepositoryOwnerCheck {
  const NewRepositoryOwnerCheck(this.state, {this.owner = '', this.installUrl});

  static NewRepositoryOwnerCheck read(String owner, Map<String, dynamic> row) =>
      NewRepositoryOwnerCheck(
        switch (row['state']) {
          final String state => state,
          _ => 'not-configured',
        },
        owner: owner,
        installUrl: switch (row['installUrl']) {
          final String url => url,
          _ => null,
        },
      );

  /// `ready`, `not-installed` (F4), `not-accepted` (F5) or `not-configured`
  /// (F6: this server cannot create repositories, so New Repository hides).
  final String state;
  final String owner;

  /// With `not-installed`: where an owner installs Harness.
  final String? installUrl;

  /// The line to show for it, or null when it is ready.
  String? get problem => switch (state) {
    'ready' => null,
    'not-installed' => newRepositoryNotInstalled(owner),
    'not-accepted' => newRepositoryNotAccepted(owner),
    _ => kNewRepositoryUnavailable,
  };
}

/// F6, for someone who reaches it anyway.
const kNewRepositoryUnavailable =
    'This Harness server can’t create repositories yet.';

/// An ask the server refused before any sign-in, with what an owner of the
/// organization does: [installUrl] for F4.
class NewRepositoryRefusal extends SuperTabFailure {
  const NewRepositoryRefusal(super.code, super.message, {this.installUrl});
  final String? installUrl;
}
