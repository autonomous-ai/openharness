import 'dart:async';
import 'dart:math' show max;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import 'controller.dart';
import 'github_issues.dart';
import 'github_pulls.dart';
import 'model.dart';
import 'my_agents.dart';

/// What each of the person's agents is doing, in a word or two on its row in Your Team (Swarm v4, tester Q1: "why do I see no
/// agent talk"), in this order:
/// - `offline`: its machine reports its session gone ([SuperTabAgent.downSince], which the Swarm already sends);
/// - `on #12`: its project's board has an open issue labelled `builder:<its name>` and `status:taken` ([SwarmGitHub.taken]);
/// - `free`: its latest post in its project's channel says `free: <its name>`, as the Swarm's basics ask of an agent with no
///   task.
/// A state not read yet, or that cannot be, shows nothing.
///
/// Read only while Your Team is open (a folded list shows no state), only for the projects the person's own agents are in
/// (at most [maxProjects]), and only what changed: a channel again when the Swarm says it moved past what was read (the posts
/// after that mark, as the open chat reads them; more than a page of them and the latest page instead), a board once a
/// [boardEvery] while the Swarm is on screen, once when it is null.
class SwarmAgentStates extends ChangeNotifier {
  SwarmAgentStates({
    required this.controller,
    required this.github,
    this.app,
    this.localRepository,
    this.boardEvery = const Duration(minutes: 1),
    this.settle = const Duration(milliseconds: 400),
  }) {
    controller.addListener(_changed);
    app?.addListener(_activity);
    _changed();
  }

  final SuperTabController controller;
  final SwarmGitHub github;

  /// The app whose computers' daemons say what an agent does now (a turn running, a question on its screen), which its row
  /// says ([rowOf]); null where there is none.
  final AppNotifier? app;

  /// The repo an agent's own pane works in, as this Desktop reads it (`github.com/owner/name`), for an agent whose project
  /// names none: in the person's Personal Swarm the server never learns it (personal_projects.dart).
  final String? Function(SuperTabAgent agent)? localRepository;

  /// How long a board's read stands before it is read again; null reads each once.
  final Duration? boardEvery;

  /// How long changes are let settle before the reads they ask for are made.
  final Duration settle;

  /// The projects whose agents are read for.
  static const maxProjects = 12;

  /// A project's GitHub repository (`owner/name`) as its record names it, or null.
  static String? _repository(SuperTabProject project) =>
      SwarmGitHub.repositoryOf(project.repository?['repositoryUrl'] as String?);

  static final _freePost = RegExp(r'^\s*free\s*:', caseSensitive: false);

  /// Whether an agent's post says it is free.
  static bool isFreePost(String text) => _freePost.hasMatch(text);

  /// `offline` for an agent whose machine reports its session gone, else null: the first of the states, which a row says even
  /// where nothing is read.
  static String? offlineOf(SuperTabAgent agent) =>
      agent.downSince == null ? null : 'offline';

  /// Whether each agent's latest post in its channel is a free one; and how far each channel was read.
  final _free = <String, bool>{};
  final _channelRead = <String, int>{};

  /// Each repository's taken tasks by agent, and when they were read; and the repository of each agent read for, worked out
  /// once a run, not once a row.
  final _taken = <String, Map<String, int>>{};
  final _repositories = <String, String?>{};

  /// Each repository's taken tasks whose pull request's checks run (the board's Checks), read with its taken tasks.
  final _building = <String, Set<int>>{};
  final _boardRead = <String, DateTime>{};

  /// Waits after a failed read, by what was read: its failures so far and when it may be asked again.
  final _failures = <String, int>{};
  final _retryAt = <String, DateTime>{};

  Timer? _settling, _boards;
  bool _running = false, _again = false, _disposed = false;

  /// Whether a read is waiting to start or going on: what a change asked for is not done yet.
  bool get busy => _settling != null || _running;

  /// What [agent]'s row says in a word or two, the first of (Swarm plan, step 1, item 1: "What Harness knows is a state
  /// anyone can see"): not running (`offline`); `starting`; waiting on its person (`needs you` to them, `waiting on its
  /// person` to anyone else: a question on its screen, or its terminal waits on their input); out of quota until a time (`limited until
  /// 15:40`, what its machine saw on its screen); `waiting on a build` (at a task whose pull request's checks run, while no turn
  /// of its runs); at a task (`on #12`); `working` (a turn runs); `free`. Idle, or nothing known, says nothing. What its computer's daemon says of it is known where [app] reads that computer; tasks and free
  /// come from [states], read while Your Team is open.
  static String? rowOf(
    SuperTabAgent agent, {
    SwarmAgentStates? states,
    AppNotifier? app,
    String? me,
    DateTime? now,
  }) {
    if (offlineOf(agent) case final offline?) return offline;
    if (app?.engineStarting(agent.machineId, agent.harnessId) ?? false) {
      return 'starting';
    }
    final activity = app == null
        ? null
        : harnessActivity(app, agent.machineId, agent.harnessId);
    if (activity == HarnessActivity.needsInput ||
        app?.questionFor(agent.machineId, agent.harnessId) != null) {
      return me != null && agent.contributorId == me
          ? 'needs you'
          : 'waiting on its person';
    }
    if (agent.limitedUntil?.toLocal() case final until?
        when until.isAfter(now ?? clock.now())) {
      String two(int n) => n.toString().padLeft(2, '0');
      return 'limited until ${two(until.hour)}:${two(until.minute)}';
    }
    if (states?.taskOf(agent) case final number?) {
      final idle =
          activity == HarnessActivity.idle || activity == HarnessActivity.done;
      return idle && states!._buildingOf(agent, number)
          ? 'waiting on a build'
          : 'on #$number';
    }
    if (activity == HarnessActivity.working) return 'working';
    return states?._free[agent.id] == true ? 'free' : null;
  }

  /// What the person's own agents' rows said when the app last changed, so a change that moves none of them redraws
  /// nothing.
  String _said = '';

  /// The app changed (a turn started or ended, a question came or went, a computer connected): the rows redraw only once
  /// what one of them says has moved. Not [AppNotifier.agentPulse], which every word an agent writes bumps.
  void _activity() {
    if (_disposed) return;
    final me = controller.accountId;
    final said = [
      for (final agent
          in controller.snapshot?.agents ?? const <SuperTabAgent>[])
        if (agent.contributorId == me)
          rowOf(agent, states: this, app: app, me: me),
    ].join('\n');
    if (said == _said) return;
    _said = said;
    notifyListeners();
  }

  /// Whether the pull request for [agent]'s task [number] has its checks running.
  bool _buildingOf(SuperTabAgent agent, int number) =>
      _building[_repositories[agent.id]]?.contains(number) ?? false;

  /// The task [agent] has taken on its project's board, by number, whether it is online or not; null for none.
  int? taskOf(SuperTabAgent agent) =>
      _taken[_repositories[agent.id]]?[(agent.displayName ?? agent.name)
          .toLowerCase()];

  void _changed() {
    if (_disposed) return;
    _settling ??= Timer(settle, _run);
  }

  /// The projects the person's own agents are in, the ones read for, and those agents by id.
  (List<SuperTabProject>, Map<String, SuperTabAgent>) _watched() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return (const [], const {});
    final projects = <String, SuperTabProject>{};
    final agents = <String, SuperTabAgent>{};
    for (final agent in superTabMyAgents(snapshot, controller.accountId)) {
      agents[agent.id] = agent;
      if (snapshot.projectById(agent.projectId) case final project?) {
        projects.putIfAbsent(project.id, () => project);
      }
    }
    return (projects.values.take(maxProjects).toList(), agents);
  }

  Future<void> _run() async {
    _settling = null;
    // A folded list shows no state, and a Swarm not on screen reads nothing: opening it again asks again.
    if (_disposed || controller.away || !controller.agentsGroupOpen) return;
    if (_running) {
      _again = true;
      return;
    }
    _running = true;
    var moved = false;
    try {
      do {
        _again = false;
        final (projects, agents) = _watched();
        final named = {
          for (final project in projects) project.id: _repository(project),
        };
        _repositories
          ..clear()
          ..addAll({
            for (final agent in agents.values)
              agent.id:
                  named[agent.projectId] ??
                  SwarmGitHub.repositoryOf(localRepository?.call(agent)),
          });
        // As many boards as projects at most: a Personal Swarm's agents name theirs one by one.
        final repositories = {
          for (final repository in _repositories.values) ?repository,
        }.take(maxProjects).toSet();
        _forget(
          agents: agents.keys.toSet(),
          channels: {for (final p in projects) p.leadConversationId},
          repositories: repositories,
        );
        for (final project in projects) {
          if (_disposed) return;
          moved |= await _readChannel(project);
        }
        for (final repository in repositories) {
          if (_disposed) return;
          moved |= await _readBoard(repository);
        }
        if (projects.isNotEmpty && !_disposed && boardEvery != null) {
          // Back for the boards: nothing pushes a change of GitHub's.
          _boards?.cancel();
          _boards = Timer(boardEvery!, _changed);
        }
      } while (_again && !_disposed);
    } finally {
      _running = false;
    }
    if (moved && !_disposed) notifyListeners();
  }

  /// What was read of an agent, a channel or a repository the person's agents are no longer in goes.
  void _forget({
    required Set<String> agents,
    required Set<String> channels,
    required Set<String> repositories,
  }) {
    bool kept(String key) => key.startsWith('channel/')
        ? channels.contains(key.substring(8))
        : repositories.contains(key.substring(6));
    _free.removeWhere((agent, _) => !agents.contains(agent));
    _channelRead.removeWhere((channel, _) => !channels.contains(channel));
    _taken.removeWhere((repository, _) => !repositories.contains(repository));
    _building.removeWhere(
      (repository, _) => !repositories.contains(repository),
    );
    _boardRead.removeWhere(
      (repository, _) => !repositories.contains(repository),
    );
    _failures.removeWhere((key, _) => !kept(key));
    _retryAt.removeWhere((key, _) => !kept(key));
  }

  bool _waiting(String key) {
    final at = _retryAt[key];
    return at != null && clock.now().isBefore(at);
  }

  void _failed(String key, String what, Object error) {
    final count = _failures[key] = (_failures[key] ?? 0) + 1;
    // 1, 2, 4 ... minutes, at most 8.
    final wait = Duration(minutes: 1 << (count - 1).clamp(0, 3));
    _retryAt[key] = clock.now().add(wait);
    // Said once for the run of failures, by its code alone: the channel's and the repo's names are the person's own.
    if (count == 1) {
      appLog.warn(
        'super-tabs',
        'Agent states: $what not read '
            '(${error is SuperTabFailure ? error.code : error.runtimeType})',
      );
    }
  }

  void _recovered(String key) {
    _failures.remove(key);
    _retryAt.remove(key);
  }

  /// Reads the posts of [project]'s channel that came since the last read, or its latest page the first time and when more
  /// than a page came; whether an agent's state moved. Only the channel's own stream counts: a reply in a thread is no
  /// agent's latest word there.
  Future<bool> _readChannel(SuperTabProject project) async {
    final channel = project.leadConversationId;
    final group = controller.snapshot?.conversation(channel);
    if (group == null || _waiting('channel/$channel')) return false;
    final read = _channelRead[channel];
    if (read != null && group.lastMessageSequence <= read) return false;
    final path =
        '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}'
        '/conversations/${Uri.encodeComponent(channel)}/messages';
    try {
      var answer = await controller.request(
        'GET',
        read == null ? path : '$path?after=$read',
      );
      // More than a page since the mark: the latest page says where they are now, as the open chat reads after a gap.
      if (read != null && answer['next'] != null) {
        answer = await controller.request('GET', path);
      }
      if (_disposed) return false;
      final rows = answer['messages'];
      final messages = [
        if (rows is List)
          for (final row in rows) SuperTabMessage.fromJson(superTabMap(row)),
      ]..sort(superTabMessageOrder);
      var moved = false;
      var upTo = read ?? 0;
      for (final message in messages) {
        if (message.conversationId != channel) continue;
        upTo = max(upTo, message.sequence);
        if (!message.fromAgent || !message.inMainStream) continue;
        final free = isFreePost(message.text);
        if (_free[message.authorId] != free) {
          _free[message.authorId] = free;
          moved = true;
        }
      }
      // What the Swarm said of the channel counts too: a post the reader may not see moves its counter.
      _channelRead[channel] = max(upTo, group.lastMessageSequence);
      _recovered('channel/$channel');
      return moved;
    } on Object catch (error) {
      _failed('channel/$channel', 'a channel', error);
      return false;
    }
  }

  /// Reads [repository]'s taken tasks when they are older than [boardEvery], and while one is taken its pull requests, for the
  /// ones whose checks run; whether they changed.
  Future<bool> _readBoard(String repository) async {
    final at = _boardRead[repository];
    final every = boardEvery;
    if (_waiting('board/$repository') ||
        (at != null && (every == null || clock.now().difference(at) < every))) {
      return false;
    }
    try {
      final taken = await github.taken(repository);
      final building = taken.isEmpty
          ? <int>{}
          : {
              for (final MapEntry(:key, :value) in (await github.pulls(
                repository,
              )).entries)
                if (value.status == SwarmPullStatus.checks) key,
            };
      if (_disposed) return false;
      _boardRead[repository] = clock.now();
      _recovered('board/$repository');
      if (mapEquals(_taken[repository], taken) &&
          setEquals(_building[repository], building)) {
        return false;
      }
      _taken[repository] = taken;
      _building[repository] = building;
      return true;
    } on Object catch (error) {
      _failed('board/$repository', 'a board', error);
      return false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_changed);
    app?.removeListener(_activity);
    _settling?.cancel();
    _settling = null;
    _boards?.cancel();
    super.dispose();
  }
}
