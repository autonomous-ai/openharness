import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:cryptography/dart.dart' show DartSha256;
import 'package:flutter/foundation.dart';

import '../state/app_state.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
import 'controller.dart';
import 'model.dart';
import 'swarm_switcher.dart' show PersonalSwarm;

/// A person's panes as projects of their Personal Swarm (Dee, 10-30 design;
/// "build the rest, but leave the tabs", 10-31): every pane of theirs joins
/// the project of its repo, whatever tab it is in, the same repo on each of
/// their computers being one project, and a pane with no repo joins
/// # scratch. A project's [term] shows those very panes: the tab keeps them,
/// and nothing about a tab changes.
///
/// Which pane belongs where is worked out here, on the person's own Desktop,
/// from the panes it already shows. Nothing of a pane is sent anywhere: the
/// server learns only each project's name, as a private project of a Swarm
/// that has no one else in it.
///
/// Not yet: a repo that already has a team project joining that one. It
/// crosses Swarms and needs its own security review.

/// The key of the project for panes with no repo.
const kScratchRepo = 'scratch';
const kScratchProjectName = 'scratch';

/// A pane's repo as one string for every computer: the remote's host and path,
/// lower case, without scheme, user, password, port or `.git`, so
/// `git@github.com:Owner/Api.git` and `https://github.com/owner/api` are one.
/// Null for no remote, or one only this computer can reach (a folder).
String? normalizedRemote(String? remote) {
  var text = remote?.trim() ?? '';
  if (text.isEmpty) return null;
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

/// The request id a repo's project is created with: the same on every
/// computer of the person's, so the server answers each with the one project
/// (backend commands.ts `project.create`: the project's id comes from it).
String personalProjectOperation(String repo) =>
    repo == kScratchRepo ? 'personal-scratch' : 'personal-repo-${_hash(repo)}';

/// One of the person's panes, the tab it is first in, and its repo
/// ([kScratchRepo] for none).
typedef PersonalPane = ({Swarm tab, TerminalPane pane, String repo});

/// The person's own panes in their tabs, in tab order then each tab's reading
/// order, each once. Swarm tabs, viewers and panes on another person's or a
/// shared machine, or on a Harness Team account, are left out.
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
      if (!seen.add((pane.machineId, agentId))) continue;
      final agent = machine.agents.where((a) => a.id == agentId).firstOrNull;
      out.add((
        tab: tab,
        pane: pane,
        repo: normalizedRemote(agent?.project?.remote) ?? kScratchRepo,
      ));
    }
  }
  return out;
}

/// The projects made for the person's repos in their Personal Swarm, per app:
/// made once, remembered on this computer, and found again by the same
/// request on another.
class PersonalProjects extends ChangeNotifier {
  PersonalProjects._(this.app);
  static final _of = Expando<PersonalProjects>();
  static PersonalProjects of(AppNotifier app) =>
      _of[app] ??= PersonalProjects._(app);

  final AppNotifier app;

  /// The longest wait before a failed repo's project is asked for again.
  static const maxRetryWait = Duration(minutes: 5);

  /// Each account's remembered projects, one key for all their Personal
  /// Swarms: `super_tab.repos.<account>` (account_keys.dart sweeps it).
  static String storageKey(String account) => 'super_tab.repos.$account';

  /// Per account and Personal Swarm: repo to project id, null once the person
  /// deleted it (it is not made again).
  final _known = <String, Map<String, Map<String, String?>>>{};

  /// Repos renamed to their long name, per account and Swarm.
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

  /// Which repos' panes the project [projectId] shows.
  Set<String> _reposOf(String account, String swarm, String projectId) => {
    for (final MapEntry(:key, :value)
        in _known[account]?[swarm]?.entries ?? <MapEntry<String, String?>>[])
      if (value == projectId) key,
  };

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
    final repos = _reposOf(c.accountId, c.tabId, project.id);
    if (repos.isEmpty) return const [];
    return [
      for (final entry in personalPanes(app))
        if (repos.contains(entry.repo)) entry.pane,
    ];
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
    final had = _known[account]?.remove(swarm) != null;
    _renamed[account]?.remove(swarm);
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
        final projects = _projects(account, swarm);
        final repos = entry['projects'];
        if (repos is Map) {
          for (final MapEntry(:key, :value) in repos.entries) {
            if (key is String && (value == null || value is String)) {
              projects.putIfAbsent(key, () => value as String?);
            }
          }
        }
        final renamed = entry['renamed'];
        if (renamed is List) {
          ((_renamed[account] ??= {})[swarm] ??= {}).addAll(
            renamed.whereType<String>(),
          );
        }
      }
    } catch (_) {
      // Nothing kept: each project is asked for again, and the server answers
      // with the one it made.
    }
  }();

  Future<void> _save(String account) async {
    final known = _known[account] ?? const {};
    final value = jsonEncode({
      for (final MapEntry(key: swarm, value: projects) in known.entries)
        swarm: {
          'projects': projects,
          'renamed': [...?_renamed[account]?[swarm]],
        },
    });
    try {
      await app.superTabs.storage.write(storageKey(account), value);
    } catch (_) {
      // Kept for this run; the next asks the server again, which repeats.
    }
  }

  /// Makes the projects [c]'s Personal Swarm still lacks for the person's
  /// panes, one request at a time, and tells apart two repos of one name.
  /// Anything that answers after the Swarm, its access or the account
  /// changed is dropped.
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
        final projects = _projects(account, swarm);
        final wanted = {for (final p in personalPanes(app)) p.repo};
        var made = false;
        for (final repo in wanted) {
          if (projects.containsKey(repo)) continue;
          final retryAt = _retryAt['$scope/$repo'];
          if (retryAt != null && clock.now().isBefore(retryAt)) continue;
          final answer = await _create(c, repo);
          if (!eligible(c)) return;
          if (answer case (:final id)) {
            projects[repo] = id;
            made = true;
            await _save(account);
            notifyListeners();
          }
        }
        // The new projects read before two of one name are told apart.
        if (made && !await _reread(c)) return;
        if (!eligible(c)) return;
        if (await _tellApart(c) && eligible(c)) await _reread(c);
      } while (_again.contains(scope));
    } finally {
      _syncing.remove(scope);
    }
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
            // own; two of one name are told apart after ([_tellApart]).
            'name': repo == kScratchRepo ? kScratchProjectName : repoName(repo),
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
      _failed(key);
    } catch (_) {
      _failed(key);
    }
    return null;
  }

  void _failed(String key) {
    final count = _failures[key] = (_failures[key] ?? 0) + 1;
    final wait = Duration(seconds: 5 << count.clamp(1, 6));
    _retryAt[key] = clock.now().add(wait < maxRetryWait ? wait : maxRetryWait);
  }

  /// Two repos of one name, both still under it: each is renamed to its long
  /// name, once. A name the person chose stays.
  Future<bool> _tellApart(SuperTabController c) async {
    final account = c.accountId, swarm = c.tabId;
    final projects = _projects(account, swarm);
    final renamed = (_renamed[account] ??= {})[swarm] ??= {};
    final byName = <String, List<String>>{};
    for (final MapEntry(key: repo, value: id) in projects.entries) {
      if (id == null || repo == kScratchRepo) continue;
      (byName[repoName(repo)] ??= []).add(repo);
    }
    var changed = false;
    for (final repos in byName.values.where((r) => r.length > 1)) {
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
        } catch (_) {
          continue;
        }
        if (!eligible(c)) return changed;
        renamed.add(repo);
        changed = true;
        await _save(account);
      }
    }
    return changed;
  }

  @visibleForTesting
  Map<String, String?> knownForTest(String account, String swarm) =>
      Map.of(_known[account]?[swarm] ?? const {});
}
