/// New project's New repository on the phone (task #3373, anh Dee 11-01 and
/// 11-05): a repository made on GitHub through the person's own sign-in, in
/// an organization the Swarm already uses, its project's Product Manager
/// started in it. The server makes it (plan
/// docs/plans/2026-11-05-new-repository-plan.md, Task 6's contract); the
/// phone names it, opens GitHub's sign-in and reads the outcome from the
/// project's `repositoryCreation` in the Swarm state it already syncs.
library;

import 'package:url_launcher/url_launcher.dart';

import 'model.dart' show superTabMap;
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// What New repository makes: [name] in the organization [owner], private
/// unless switched off.
typedef SwarmNewRepository = ({String owner, String name, bool private});

/// The address [repository] will have on GitHub.
String swarmNewRepositoryUrl(SwarmNewRepository repository) =>
    'https://github.com/${repository.owner}/${repository.name}';

// The design's failure table (docs/plans/2026-11-05-new-repository-design.md,
// F1 to F11), word for word.

/// F1: a name GitHub would refuse, said as it is typed.
const swarmRepositoryNameRule = 'Use letters, numbers, - _ or . (up to 100).';

/// F2: the name is taken in that organization.
String swarmRepositoryTaken(String owner, String name) =>
    '$owner/$name already exists. Choose another name, or pick it under '
    'Repository to use it.';

/// F3: GitHub would not let the person create one there, in its words.
String swarmRepositoryRefused(String owner, String reason) =>
    'GitHub didn’t let you create a repository in $owner: $reason. Ask an '
    'owner of $owner, or create it on GitHub and pick Enter a link.';

/// F4: Harness is not installed on that organization.
String swarmRepositoryNotInstalled(String owner) =>
    'Harness isn’t on $owner’s GitHub yet.';

/// F5: installed, but the organization has not accepted the permission.
String swarmRepositoryNotAccepted(String owner) =>
    'An owner of $owner needs to accept Harness’s new permission once: '
    'GitHub Settings → GitHub Apps → Harness.';

/// F7: made, but not yet in reach of Harness's installation.
String swarmRepositoryUnreachable(String owner, String name) =>
    '$owner/$name is made, but Harness can’t reach it yet. An owner of '
    '$owner adds it under Settings → GitHub Apps → Harness → Configure.';

/// F8: the sign-in was cancelled, or its link was too old.
const swarmRepositoryNotCreated = 'Nothing was created.';

/// F9: GitHub, or the way to it, did not answer.
const swarmRepositoryNoAnswer = 'GitHub didn’t answer. Nothing was created.';

/// Too many organization checks or requests: the server allows 30 a minute
/// per person (`RATE_LIMITED`, 429; Heron, from #3201's security reviews).
const swarmRepositoryRateLimited = 'Too many checks. Try again in a minute.';

/// Whether [failure] is the server's rate limit.
bool swarmRateLimited(SuperTabFailure failure) =>
    failure.code == 'RATE_LIMITED' || failure.statusCode == 429;

/// How long a repository may read as `creating` before it counts as stuck:
/// a server that died mid-create leaves it so (Heron, #3201's security
/// review). Try again then asks afresh, and a repository made meanwhile
/// reads as made.
const swarmRepositoryStuckAfter = Duration(minutes: 5);

/// What a create stuck in `creating` says, with Try again.
String swarmRepositoryStuck(String owner, String name) =>
    'Creating $owner/$name is taking too long. Try again.';

/// Whether a repository asked at [at] (milliseconds) and still creating at
/// [now] is stuck.
bool swarmRepositoryStuckAt(int at, DateTime now) =>
    now.millisecondsSinceEpoch - at > swarmRepositoryStuckAfter.inMilliseconds;

/// How long GitHub's sign-in link for a request lasts (the server signs it
/// for ten minutes): a request still waiting after it was not completed, and
/// nothing was made (F8).
const swarmRepositorySignInTtl = Duration(minutes: 10);

/// Whether a request asked at [at] (milliseconds) and still waiting at [now]
/// has outlived its sign-in link.
bool swarmSignInExpiredAt(int at, DateTime now) =>
    now.millisecondsSinceEpoch - at > swarmRepositorySignInTtl.inMilliseconds;

/// GitHub's sign-in did not open in the browser (Guide's review of #3204).
const swarmRepositoryOpenFailed =
    'GitHub didn’t open. Open it again to continue.';

/// An organization's check got no answer: the choice stays, to check again.
String swarmOwnerUnchecked(String owner) =>
    'Couldn’t check $owner on GitHub just now.';

/// F11: the project was deleted while the person was in GitHub. The callback
/// checks the ask is still current before it calls GitHub, so nothing was
/// made (the design's table, as #3201 has it now).
const swarmRepositoryProjectGone =
    'The project was deleted meanwhile. Nothing was created.';

final _name = RegExp(r'^[A-Za-z0-9._-]{1,100}$');
final _owner = RegExp(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$');

/// Why GitHub would refuse [name] (F1), or null when it would take it. An
/// empty name says nothing yet.
String? swarmRepositoryNameProblem(String name) {
  if (name.isEmpty) return null;
  return _name.hasMatch(name) && name != '.' && name != '..'
      ? null
      : swarmRepositoryNameRule;
}

/// Whether [owner] reads as a GitHub organization name.
bool swarmRepositoryOwnerValid(String owner) => _owner.hasMatch(owner);

/// The GitHub owners of [repositories] (links to github.com), once each in
/// their order: the organizations New repository offers, the first chosen.
List<String> swarmGitHubOwners(Iterable<String> repositories) {
  final seen = <String>{};
  return [
    for (final url in repositories)
      if (Uri.tryParse(url) case final uri?
          when uri.host.toLowerCase() == 'github.com' &&
              uri.pathSegments.isNotEmpty &&
              swarmRepositoryOwnerValid(uri.pathSegments.first) &&
              seen.add(uri.pathSegments.first.toLowerCase()))
        uri.pathSegments.first,
  ];
}

/// What the server says of an organization before sign-in (Task 6's
/// `github/owners/:owner`): `ready`, `not-installed` (with where to install
/// it), `not-accepted`, `not-configured` (no GitHub sign-in on this
/// server). Null when it could not say: a server from before New repository
/// answers 404, and the choice is not offered.
typedef SwarmOwnerCheck = ({String state, String? installUrl});

Future<SwarmOwnerCheck?> swarmCheckGitHubOwner(
  SwarmReader reader,
  String owner,
) async {
  try {
    final answer = superTabMap(
      await reader.request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/github/owners/'
            '${Uri.encodeComponent(owner)}',
      ),
    );
    final state = answer['state'];
    if (state is! String) return null;
    return (state: state, installUrl: answer['installUrl'] as String?);
  } on SuperTabFailure catch (failure) {
    // Asked too often: the choice stays, and says to wait a minute.
    if (swarmRateLimited(failure)) {
      return (state: 'rate-limited', installUrl: null);
    }
    // A server before New repository has no such route.
    if (failure.statusCode == 404) return null;
    return (state: 'unavailable', installUrl: null);
  } catch (_) {
    // No answer: kept apart from a server that cannot make one, so the
    // choice stays and can be checked again (Guide's review of #3204).
    return (state: 'unavailable', installUrl: null);
  }
}

/// The line a New repository choice cannot be used under, after its
/// organization's check: F4 or F5, or null when it is ready.
String? swarmOwnerProblem(String owner, SwarmOwnerCheck check) =>
    switch (check.state) {
      'ready' => null,
      'not-installed' => swarmRepositoryNotInstalled(owner),
      'not-accepted' => swarmRepositoryNotAccepted(owner),
      'rate-limited' => swarmRepositoryRateLimited,
      'unavailable' => swarmOwnerUnchecked(owner),
      _ => swarmRepositoryNoAnswer,
    };

/// Opens [uri] in the system browser: GitHub's sign-in, or where an app is
/// installed. Whether it opened.
Future<bool> swarmOpenInBrowser(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// How New repository opens GitHub ([swarmOpenInBrowser]); tests record it.
Future<bool> Function(Uri uri) swarmOpenGitHub = swarmOpenInBrowser;

/// New repository's request is out: GitHub's sign-in is open, and the steps
/// wait for its outcome in the Swarm state. Not a failure: the sheet shows
/// "Creating owner/name…" with Check again.
class SwarmRepositoryWaiting implements Exception {
  const SwarmRepositoryWaiting();
}

/// New repository stopped with [line], the design's words for why (F2 to F11),
/// shown as it is: the project stays, and Try again asks again.
class SwarmRepositoryFailure implements Exception {
  const SwarmRepositoryFailure(this.line);
  final String line;
  @override
  String toString() => line;
}
