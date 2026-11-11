import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:cryptography/dart.dart' show DartSha256;
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
import 'controller.dart';
import 'github_issues.dart' show SwarmGitHub;
import 'model.dart';
import 'my_agents.dart';
import 'swarm_switcher.dart' show PersonalSwarm;

/// A person's repos as the projects of their Personal Swarm (Swarm v4, anh Dee 2026-11-09): every pane of theirs in a
/// checkout joins the project of its repo, whatever tab it is in, the same repo on each of their computers being one
/// project, and each project's Tasks board reads that repo's GitHub issues (`SuperTabProject.githubRepository`). A pane with
/// no repo is in no project: it stays in Your Team (personal_agents.dart).
///
/// Which pane belongs where is worked out here, on the person's own Desktop, from the panes it already shows. Nothing of
/// a pane is sent anywhere: the server learns each project's name and, for a repo on GitHub, its `owner/name`
/// (`project.github`), which every computer of theirs then reads its Tasks board from. Which project a repo has is asked
/// of the server, never kept on a computer: the same request on every computer answers the one project.
///
/// The projects v3 made for a tab's panes with no repo ("one", "two") go: each this computer made is closed on the server
/// once (backend commands.ts `project.closeTab`: deleted when none of its chats has a message, else kept read-only and
/// out of the list).

/// The form an agent reports its project's remote in: `host[:port]/owner/repo`
/// with no scheme, user or `.git` (the CLI's `canonicalRepository`, and
/// `canonicalGitRemote` for this computer's own reading). Every real remote
/// arrives so, a clone through an SSH host alias too: its host is the alias,
/// often with no dot (`gh-work/acme/api`, `Host gh-work`, task #2476). A host
/// is two or more letters, digits, dots, hyphens or underscores, starting and
/// ending with a letter or digit (the CLI's `safeSshAlias`), so a folder path
/// (`/srv/api`, `./api`, `C:\api`, `C:/api`) never is one.
final _canonicalRemote = RegExp(
  r'^[a-z0-9][a-z0-9._-]*[a-z0-9](?::\d+)?/\S+$',
  caseSensitive: false,
);

/// A pane's repo as one string for every computer: the remote's host and path,
/// lower case, without scheme, user, password, port or `.git`, so
/// `git@github.com:Owner/Api.git`, `https://github.com/owner/api` and the
/// `github.com/owner/api` an agent reports are one.
/// Null for no remote, or one only this computer can reach (a folder).
String? normalizedRemote(String? remote) {
  var text = remote?.trim() ?? '';
  if (text.isEmpty) return null;
  if (_canonicalRemote.hasMatch(text)) text = 'https://$text';
  String? host, path;
  final url = RegExp(
    r'^([a-z][a-z0-9+.-]*)://(.*)$',
    caseSensitive: false,
  ).firstMatch(text);
  if (url != null) {
    if (url.group(1)!.toLowerCase() == 'file') return null;
    final rest = url.group(2)!;
    final slash = rest.indexOf('/');
    if (slash <= 0) return null;
    var authority = rest.substring(0, slash);
    authority = authority.substring(authority.lastIndexOf('@') + 1);
    host = authority.replaceFirst(RegExp(r':\d*$'), '');
    path = rest.substring(slash + 1);
  } else {
    // scp-like `user@host:owner/repo`; a path (`/x`, `./x`, `C:\x`) is no remote.
    final scp = RegExp(r'^(?:[^@/\\]+@)?([^:/\\]+):(?!//)(.+)$')
        .firstMatch(text);
    if (scp == null || scp.group(1)!.length < 2) return null;
    host = scp.group(1);
    path = scp.group(2);
  }
  final parts = path!
      .replaceFirst(RegExp(r'\.git/*$', caseSensitive: false), '')
      .split('/')
      .where((p) => p.isNotEmpty && p != '.' && p != '..')
      .toList();
  if (host == null || host.isEmpty || parts.isEmpty) return null;
  return [host, ...parts].join('/').toLowerCase();
}

/// The repo's own name: `github.com/owner/api` is `api`.
String repoName(String repo) => repo.split('/').last;

/// The name that tells two repos of one name apart: `api (owner/api)`.
String repoLongName(String repo) {
  final parts = repo.split('/');
  final tail = parts.length > 2 ? parts.sublist(parts.length - 2) : parts;
  return '${repoName(repo)} (${tail.join('/')})';
}

String _hash(String text) => const DartSha256()
    .hashSync(utf8.encode(text))
    .bytes
    .map((b) => b.toRadixString(16).padLeft(2, '0'))
    .join()
    .substring(0, 24);

/// The request id a repo's project is created with: the same on every computer of the person's, so the server answers
/// each with the one project (backend commands.ts `project.create`: the project's id comes from it). The URL is not in it.
String personalProjectOperation(String repo) => 'personal-repo-${_hash(repo)}';

/// The request id v3 made desk tab [tabId]'s project with: the server closes a project only for the request that made it
/// (backend commands.ts `closingTabProject`).
String _tabOperation(String tabId) => 'personal-tab-${_hash(tabId)}';

/// What this computer kept of v3's tab projects: `tab:<desk tab id>` beside the repos.
const _tabPrefix = 'tab:';

/// One of the person's panes in a checkout, the tab it is first in, and its repo ([normalizedRemote]).
typedef PersonalPane = ({Swarm tab, TerminalPane pane, String repo});

/// The person's own panes in a checkout of a repo, in tab order then each tab's reading order, each once. Swarm tabs,
/// viewers, panes with no repo and panes on another person's or a shared machine, or on a Harness Team account, are left
/// out.
List<PersonalPane> personalPanes(AppNotifier app) {
  final seen = <(String, String)>{};
  final out = <PersonalPane>[];
  for (final tab in app.swarms) {
    if (tab.isSuperTab || tab.isUtility) continue;
    for (final pane in tab.panesInReadingOrder) {
      final agentId = pane.agentId;
      if (agentId == null || pane.isViewer) continue;
      final machine = app.stateOf(pane.machineId);
      if (machine == null ||
          machine.belongsToOtherAccount ||
          machine.machine.isTeamAccount) {
        continue;
      }
      final project = machine.agents
          .where((a) => a.id == agentId)
          .firstOrNull
          ?.project;
      // The repo an SSH alias stands for first, so a clone through `Host gh-work` and one straight from GitHub are one
      // (task #2476).
      final repo =
          normalizedRemote(project?.repository) ??
          normalizedRemote(project?.remote);
      if (repo == null || !seen.add((pane.machineId, agentId))) continue;
      out.add((tab: tab, pane: pane, repo: repo));
    }
  }
  return out;
}

/// The projects made for the person's repos in their Personal Swarm, per app:
/// made once and found again by the same request, on every computer and after
/// every restart, or by the GitHub repository the project names.
class PersonalProjects extends ChangeNotifier {
  PersonalProjects._(this.app);
  static final _of = Expando<PersonalProjects>();
  static PersonalProjects of(AppNotifier app) =>
      _of[app] ??= PersonalProjects._(app);

  final AppNotifier app;

  /// The longest wait before a failed request is asked again.
  static const maxRetryWait = Duration(minutes: 5);

  /// Each account's v3 tab projects not closed yet, one key for all their
  /// Personal Swarms: `super_tab.repos.<account>` (account_keys.dart sweeps it).
  /// The repos' projects it held before 2026-11-12 are read no more.
  static String storageKey(String account) => 'super_tab.repos.$account';

  /// Per account and Personal Swarm, for this run: repo to project id, null once
  /// the person deleted it (it is not asked for again this run).
  final _known = <String, Map<String, Map<String, String?>>>{};

  /// Per account and Personal Swarm: the repos whose project this run made, which two repos of one name tell apart.
  final _made = <String, Set<String>>{};

  /// Per account and Personal Swarm: the repos whose GitHub repository the server refused to take: not asked again.
  final _unnamed = <String, Set<String>>{};

  /// Accounts whose kept record still holds the repos' projects from before 2026-11-12: written again without them.
  final _stale = <String>{};

  /// Per account and Personal Swarm: v3's tab projects not closed yet, desk tab id to project id.
  final _tabs = <String, Map<String, Map<String, String>>>{};

  /// Repos renamed to their long name, per account and Swarm, this run: a name the person chose since stays.
  final _renamed = <String, Map<String, Set<String>>>{};
  final _loads = <String, Future<void>>{};
  final _syncing = <String>{};
  final _again = <String>{};
  final _failures = <String, int>{};
  final _retryAt = <String, DateTime>{};

  /// The Personal Swarm [c] reads, while it is the signed-in person's alone
  /// with no one else in it. Never a team Swarm.
  bool eligible(SuperTabController c) {
    final account = app.currentUser?.id;
    final snapshot = c.snapshot;
    return account != null &&
        c.accountId == account &&
        !c.accessRevoked &&
        snapshot != null &&
        identical(app.superTabs.peek(c.tabId), c) &&
        PersonalSwarm.of(app).id == c.tabId &&
        snapshot.ownerId == account &&
        snapshot.people.every((p) => p.id == account);
  }

  Map<String, String?> _projects(String account, String swarm) =>
      (_known[account] ??= {})[swarm] ??= {};

  /// The id of [repo]'s project in [c], the server's own (backend `project.create`: the Swarm, its person and the request),
  /// so every computer of theirs knows it without asking.
  static String projectIdOf(SuperTabController c, String repo) => stableId([
    c.tabId,
    'person:${c.accountId}',
    personalProjectOperation(repo),
  ]);

  /// [repo]'s `owner/name` when it is on GitHub, else null: what a project's `githubRepository` holds.
  static String? gitHubName(String repo) => SwarmGitHub.repositoryOf(repo);

  /// The repos the person's panes and their agents in [c] work in: an agent started in the Swarm has no pane in a tab.
  Set<String> _repos(SuperTabController c) => {
    for (final pane in personalPanes(app)) pane.repo,
    for (final agent in superTabMyAgents(c.snapshot!, c.accountId))
      ?agentRepository(c, agent),
  };

  /// The repo agent [agent] of [c]'s own pane works in (`github.com/owner/name`): where its tasks are, since the project
  /// it is in, Your Team's, names none. Null outside the person's Personal Swarm, or for a session in no repo.
  String? agentRepository(SuperTabController c, SuperTabAgent agent) {
    if (!eligible(c)) return null;
    final machine = app.stateOf(agent.machineId);
    if (machine == null ||
        machine.belongsToOtherAccount ||
        machine.machine.isTeamAccount) {
      return null;
    }
    final project = machine.agents
        .where((a) => a.id == agent.harnessId)
        .firstOrNull
        ?.project;
    return normalizedRemote(project?.repository) ??
        normalizedRemote(project?.remote);
  }

  /// The panes project [conversationId] of [c] shows behind [term], in their
  /// tabs' order: its lead conversation in the person's own Personal Swarm,
  /// else none. The very panes the tabs hold.
  List<TerminalPane> panesFor(SuperTabController c, String conversationId) {
    if (!eligible(c)) {
      if (c.accessRevoked) _forget(c.accountId, c.tabId);
      return const [];
    }
    final snapshot = c.snapshot!;
    if (!snapshot.isProjectLead(conversationId)) return const [];
    final project = snapshot.projectFor(conversationId);
    if (project == null) return const [];
    return [
      for (final entry in personalPanes(app))
        if (projectIdOf(c, entry.repo) == project.id) entry.pane,
    ];
  }

  /// Whether project [projectId] of [c] leaves the project list (Huy, 11-05,
  /// task #3042): one made for the person's panes, with none of them open
  /// now. Nothing about it changes on the server, so its chat is there when a
  /// pane of it opens again. Never while a machine holding one of their panes
  /// has not said what runs there yet: that pane may be this project's.
  bool hidden(SuperTabController c, String projectId) =>
      hiddenIn(c).contains(projectId);

  /// Every project of [c] that leaves the project list now ([hidden]), in
  /// one walk of the person's panes, so the list asks once per draw, not once
  /// per row (ENGINEERING §4, review of #3073): a project made for panes
  /// whose repos have none of them open, the same answer as [panesFor] being
  /// empty for it.
  ///
  /// A repo's project is known by its id ([projectIdOf]): those of this run's repos, and on any computer one that names its
  /// GitHub repository.
  Set<String> hiddenIn(SuperTabController c) {
    if (!eligible(c) || _unresolvedPanes(app)) return const {};
    final snapshot = c.snapshot!;
    final shown = {for (final repo in _repos(c)) projectIdOf(c, repo)};
    final made = {
      ...?_known[c.accountId]?[c.tabId]?.values.nonNulls,
      for (final project in snapshot.projects)
        if (project.githubRepository case final name?
            when projectIdOf(c, 'github.com/${name.toLowerCase()}') ==
                project.id)
          project.id,
    };
    return {
      for (final id in made)
        if (!shown.contains(id) && snapshot.projectById(id) != null) id,
    };
  }

  /// The projects of [c] the list never shows, even while open: v3's tab projects, whether or not their close is through
  /// ([_closeTabs]).
  Set<String> unlistedIn(SuperTabController c) {
    if (!eligible(c)) return const {};
    return {...?_tabs[c.accountId]?[c.tabId]?.values};
  }

  /// A pane of the person's on a machine that has not listed its agents yet.
  static bool _unresolvedPanes(AppNotifier app) {
    for (final tab in app.swarms) {
      if (tab.isSuperTab || tab.isUtility) continue;
      for (final pane in tab.panes) {
        if (pane.agentId == null || pane.isViewer) continue;
        final machine = app.stateOf(pane.machineId);
        if (machine == null ||
            machine.belongsToOtherAccount ||
            machine.machine.isTeamAccount) {
          continue;
        }
        if (!machine.agentsListedOnce &&
            machine.agentLoadStatus != AgentLoadStatus.loaded) {
          return true;
        }
      }
    }
    return false;
  }

  /// The tab all of [panes] come from, when they are exactly its panes: its
  /// split sizes are theirs.
  Swarm? soleTab(List<TerminalPane> panes) {
    if (panes.isEmpty) return null;
    final entries = personalPanes(app);
    final tabs = {
      for (final pane in panes)
        entries.where((e) => identical(e.pane, pane)).firstOrNull?.tab,
    };
    if (tabs.length != 1) return null;
    final tab = tabs.single;
    if (tab == null || tab.panes.length != panes.length) return null;
    final ordered = tab.panesInReadingOrder;
    for (var i = 0; i < panes.length; i++) {
      if (!identical(ordered[i], panes[i])) return null;
    }
    return tab;
  }

  /// Personal lost: what this computer kept of its projects goes.
  void _forget(String account, String swarm) {
    final had =
        (_known[account]?.remove(swarm) != null) |
        (_tabs[account]?.remove(swarm) != null);
    _renamed[account]?.remove(swarm);
    _made.remove('$account/$swarm');
    _unnamed.remove('$account/$swarm');
    // Called while a view builds: saved after, and no one is told now.
    if (had) unawaited(_save(account));
  }

  Future<void> _load(String account) => _loads[account] ??= () async {
    try {
      final raw = await app.superTabs.storage.read(storageKey(account));
      if (raw == null || raw.isEmpty) return;
      final saved = jsonDecode(raw);
      if (saved is! Map) return;
      for (final MapEntry(key: swarm, value: entry) in saved.entries) {
        if (swarm is! String || entry is! Map) continue;
        final repos = entry['projects'];
        if (repos is! Map) continue;
        for (final MapEntry(:key, :value) in repos.entries) {
          if (key is String && key.startsWith(_tabPrefix) && value is String) {
            ((_tabs[account] ??= {})[swarm] ??= {}).putIfAbsent(
              key.substring(_tabPrefix.length),
              () => value,
            );
          } else {
            _stale.add(account);
          }
        }
        if (entry.containsKey('renamed')) _stale.add(account);
      }
      if (_stale.remove(account)) await _save(account);
    } catch (_) {
      // Nothing kept: the desk's own tabs are found again by their request.
    }
  }();

  Future<void> _save(String account) async {
    final tabs = _tabs[account] ?? const {};
    final value = jsonEncode({
      for (final MapEntry(key: swarm, value: kept) in tabs.entries)
        swarm: {
          'projects': {
            for (final MapEntry(:key, :value) in kept.entries)
              '$_tabPrefix$key': value,
          },
        },
    });
    try {
      await app.superTabs.storage.write(storageKey(account), value);
    } catch (_) {
      // Kept for this run; the next finds the desk's tabs again by their request.
    }
  }

  /// Makes the projects [c]'s Personal Swarm still lacks for the person's
  /// repos, one request at a time, tells apart two repos of one name, and
  /// closes v3's tab projects. Anything that answers after the Swarm, its
  /// access or the account changed is dropped.
  Future<void> sync(SuperTabController c) async {
    if (!eligible(c)) {
      if (c.accessRevoked) _forget(c.accountId, c.tabId);
      return;
    }
    final account = c.accountId, swarm = c.tabId;
    final scope = '$account/$swarm';
    if (!_syncing.add(scope)) {
      _again.add(scope);
      return;
    }
    try {
      await _load(account);
      do {
        _again.remove(scope);
        if (!eligible(c)) return;
        if (await _closeTabs(c) && eligible(c)) await _reread(c);
        if (!eligible(c)) return;
        final projects = _projects(account, swarm);
        final wanted = _repos(c);
        var made = false;
        for (final repo in wanted) {
          if (projects.containsKey(repo)) continue;
          // There already, made by this computer or another: known by its id, with no request.
          if (c.snapshot?.projectById(projectIdOf(c, repo)) case final known?) {
            projects[repo] = known.id;
            notifyListeners();
            continue;
          }
          final retryAt = _retryAt['$scope/$repo'];
          if (retryAt != null && clock.now().isBefore(retryAt)) continue;
          final answer = await _create(c, repo);
          if (!eligible(c)) return;
          if (answer case (:final id)) {
            projects[repo] = id;
            if (id != null) (_made[scope] ??= {}).add(repo);
            made = true;
            notifyListeners();
          }
        }
        // The new projects read before two of one name are told apart.
        if (made && !await _reread(c)) return;
        if (!eligible(c)) return;
        final named = await _nameGitHub(c);
        if (!eligible(c)) return;
        if ((await _tellApart(c) || named) && eligible(c)) await _reread(c);
      } while (_again.contains(scope));
    } finally {
      _syncing.remove(scope);
    }
  }

  /// Tells the server the GitHub repository of each of [c]'s repo projects that does not name it yet (backend
  /// `project.github`), once a request: what every computer's Tasks board then reads. Whether any was set.
  Future<bool> _nameGitHub(SuperTabController c) async {
    final scope = '${c.accountId}/${c.tabId}';
    var named = false;
    for (final MapEntry(key: repo, value: id) in _projects(
      c.accountId,
      c.tabId,
    ).entries.toList()) {
      final name = gitHubName(repo);
      final project = id == null ? null : c.snapshot?.projectById(id);
      // One whose record names its address already has its board; one the server refused stays refused.
      if (name == null ||
          project == null ||
          project.githubRepository != null ||
          project.repository?['repositoryUrl'] != null ||
          (_unnamed[scope]?.contains(repo) ?? false)) {
        continue;
      }
      final key = '$scope/$repo/github';
      final retryAt = _retryAt[key];
      if (retryAt != null && clock.now().isBefore(retryAt)) continue;
      try {
        await c.request(
          'POST',
          '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/commands',
          body: {
            'operationId': 'personal-github-${_hash(repo)}',
            'command': {
              'type': 'project.github',
              'projectId': project.id,
              'repository': name,
            },
          },
        );
        _failures.remove(key);
        _retryAt.remove(key);
        named = true;
      } on SuperTabFailure catch (failure) {
        // A refusal is the answer: asked no more. A lost connection or a busy server is asked again.
        if (failure.statusCode >= 400 && failure.statusCode < 500) {
          (_unnamed[scope] ??= {}).add(repo);
          appLog.warn(
            'super-tabs',
            'Personal project repository refused (${failure.code})',
          );
        } else {
          _failed(key, 'repository', failure);
        }
      } catch (error) {
        _failed(key, 'repository', error);
      }
      if (!eligible(c)) return named;
    }
    return named;
  }

  /// Reads [c] again; false when that failed (the next change asks again).
  Future<bool> _reread(SuperTabController c) async {
    try {
      await c.refresh();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Creates (or finds again) [repo]'s project: its id, null once the person
  /// deleted it, or nothing on a failure, asked again after a wait that
  /// doubles up to [maxRetryWait] when the Swarm next changes.
  Future<({String? id})?> _create(SuperTabController c, String repo) async {
    final key = '${c.accountId}/${c.tabId}/$repo';
    try {
      final answer = await c.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/commands',
        body: {
          'operationId': personalProjectOperation(repo),
          'command': {
            'type': 'project.create',
            // Every computer sends the same request, so the name is the repo's
            // own; two repos of one name are told apart after ([_tellApart]).
            'name': repoName(repo),
            'visibility': 'private',
            'brief': '',
          },
        },
      );
      final id = superTabMap(answer['result'])['projectId'];
      if (id is! String || id.isEmpty) throw const FormatException();
      _failures.remove(key);
      _retryAt.remove(key);
      return (id: id);
    } on SuperTabFailure catch (failure) {
      // Deleted by the person: kept deleted (backend store.ts answers a
      // repeated create of a deleted project so).
      if (failure.code == 'NOT_FOUND' &&
          failure.message.contains('deleted') &&
          eligible(c)) {
        return (id: null);
      }
      _failed(key, 'create', failure);
    } catch (error) {
      _failed(key, 'create', error);
    }
    return null;
  }

  /// v3's tab projects still to close in [c], desk tab id to project id: those this computer kept, and those of the desk's
  /// tabs now, found by the id the server made each with (backend `project.create`: the Swarm, its person and the request),
  /// so one another computer made is found too.
  Map<String, String> _tabProjects(SuperTabController c) {
    final kept = (_tabs[c.accountId] ??= {})[c.tabId] ??= {};
    final snapshot = c.snapshot;
    if (snapshot == null) return kept;
    for (final tab in app.swarms) {
      if (tab.isSuperTab || tab.isUtility || kept.containsKey(tab.id)) continue;
      final id = stableId([
        c.tabId,
        'person:${c.accountId}',
        _tabOperation(tab.id),
      ]);
      if (snapshot.projectById(id) != null) kept[tab.id] = id;
    }
    return kept;
  }

  /// Closes each of v3's tab projects ([_tabProjects]), once: gone from the server, or kept read-only when one of its
  /// chats has a message (backend `project.closeTab`). One the server no longer lists, or will not close as a tab's, is
  /// forgotten. One with an agent in it waits: a close would take its agents out of the Swarm. A failure waits as a
  /// refused create does; whether any closed.
  ///
  /// Compatibility with v3's tab projects only: goes once Desktops older than 2026-11-10 can no longer make one
  /// (2026-12-10).
  Future<bool> _closeTabs(SuperTabController c) async {
    final tabs = _tabProjects(c);
    if (tabs.isEmpty) return false;
    var changed = false;
    for (final MapEntry(key: tab, value: id) in tabs.entries.toList()) {
      final key = '${c.accountId}/${c.tabId}/$_tabPrefix$tab';
      final retryAt = _retryAt[key];
      if (retryAt != null && clock.now().isBefore(retryAt)) continue;
      final project = c.snapshot?.projectById(id);
      if (project != null && !project.archived) {
        if (c.snapshot!.agents.any((a) => a.projectId == id)) continue;
        try {
          await c.request(
            'POST',
            '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/commands',
            body: {
              'operationId': 'personal-tab-close-${_hash(tab)}',
              'command': {
                'type': 'project.closeTab',
                'projectId': id,
                'tabOperation': _tabOperation(tab),
              },
            },
          );
          changed = true;
        } on SuperTabFailure catch (failure) {
          if (failure.code != 'NOT_FOUND') {
            _failed(key, 'close', failure);
            continue;
          }
        } catch (error) {
          _failed(key, 'close', error);
          continue;
        }
        if (!eligible(c)) return changed;
      }
      _failures.remove(key);
      _retryAt.remove(key);
      tabs.remove(tab);
      await _save(c.accountId);
    }
    return changed;
  }

  /// What a failure is called in the log: its code, or its kind.
  static String _codeOf(Object error) =>
      error is SuperTabFailure ? error.code : '${error.runtimeType}';

  /// Waits before [key] is asked again, and says why in the log: the
  /// failure's code, never the repo's or the tab's name (AGENTS.md standards 6
  /// and 7).
  void _failed(String key, String what, Object error) {
    final count = _failures[key] = (_failures[key] ?? 0) + 1;
    final wait = Duration(seconds: 5 << count.clamp(1, 6));
    final next = wait < maxRetryWait ? wait : maxRetryWait;
    _retryAt[key] = clock.now().add(next);
    appLog.warn(
      'super-tabs',
      'Personal project $what refused (${_codeOf(error)}); asked again in ${next.inSeconds} s',
    );
  }

  /// Two repos of one name, both still under it, one of them made this run: each is renamed to its long name, once. A
  /// name the person chose stays.
  Future<bool> _tellApart(SuperTabController c) async {
    final account = c.accountId, swarm = c.tabId;
    final projects = _projects(account, swarm);
    final renamed = (_renamed[account] ??= {})[swarm] ??= {};
    final byName = <String, List<String>>{};
    for (final MapEntry(key: repo, value: id) in projects.entries) {
      if (id == null) continue;
      (byName[repoName(repo)] ??= []).add(repo);
    }
    var changed = false;
    // Only when one of them was made this run: a name the person chose for one since, even the repo's own, stays.
    final made = _made['$account/$swarm'] ?? const <String>{};
    for (final repos in byName.values.where(
      (r) => r.length > 1 && r.any(made.contains),
    )) {
      for (final repo in repos) {
        if (renamed.contains(repo)) continue;
        final id = projects[repo]!;
        final project = c.snapshot?.projectById(id);
        if (project == null || project.name != repoName(repo)) continue;
        try {
          await c.request(
            'POST',
            '/api/super-tabs/${Uri.encodeComponent(swarm)}/commands',
            body: {
              'operationId': 'personal-rename-${_hash(repo)}',
              'command': {
                'type': 'project.rename',
                'projectId': id,
                'name': repoLongName(repo),
              },
            },
          );
        } catch (error) {
          // Asked again on the next sync; said in the log by its code alone.
          appLog.warn(
            'super-tabs',
            'Personal project rename refused (${_codeOf(error)})',
          );
          continue;
        }
        if (!eligible(c)) return changed;
        renamed.add(repo);
        changed = true;
      }
    }
    return changed;
  }

  @visibleForTesting
  Map<String, String?> knownForTest(String account, String swarm) =>
      Map.of(_known[account]?[swarm] ?? const {});
}
