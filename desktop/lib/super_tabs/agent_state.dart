import 'dart:async';
import 'dart:collection' show SplayTreeSet;
import 'dart:math' show max;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import 'buddy_chat.dart' show kCountCap;
import 'controller.dart';
import 'github_issues.dart';
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
/// The same reads say how many posts are new in each of those channels, for its project's row ([newIn]): the posts not the
/// person's own in the channel's own stream past their read mark (anh Dee 2026-11-09: "i dont see any agent to agent chat").
///
/// Read only while Your Team is open (a folded list shows no state), only for the projects the person's own agents are in
/// (at most [maxProjects]), and only what changed: a channel again when the Swarm says it moved past what was read (the posts
/// after that mark, as the open chat reads them; more than a page of them and the latest page instead), a board once a
/// [boardEvery] while the Swarm is on screen, once when it is null.
class SwarmAgentStates extends ChangeNotifier {
  SwarmAgentStates({
    required this.controller,
    required this.github,
    this.boardEvery = const Duration(minutes: 1),
    this.settle = const Duration(milliseconds: 400),
  }) {
    controller.addListener(_changed);
    _changed();
  }

  final SuperTabController controller;
  final SwarmGitHub github;

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

  /// Each channel's posts not the person's own, by sequence, the newest [kCountCap] of them; and where what is known of them
  /// starts: a first read, or one after a gap, has the latest page alone, so older posts are not known.
  final _others = <String, SplayTreeSet<int>>{};
  final _knownFrom = <String, int>{};

  /// Each repository's taken tasks by agent, and when they were read; and the repository of each project read for, worked out
  /// once a run, not once a row.
  final _taken = <String, Map<String, int>>{};
  final _repositories = <String, String?>{};
  final _boardRead = <String, DateTime>{};

  /// Waits after a failed read, by what was read: its failures so far and when it may be asked again.
  final _failures = <String, int>{};
  final _retryAt = <String, DateTime>{};

  Timer? _settling, _boards;
  bool _running = false, _again = false, _disposed = false;

  /// Whether a read is waiting to start or going on: what a change asked for is not done yet.
  bool get busy => _settling != null || _running;

  /// How many posts in [channel] are new to the person, past their read mark, and whether there may be more than that (the posts
  /// before what was read, or past [kCountCap]); null when the channel is not read here or none is new.
  ({int count, bool more})? newIn(String channel) {
    final others = _others[channel];
    if (others == null) return null;
    final mark = controller.readMark(channel);
    final count = others.where((sequence) => sequence > mark).length;
    if (count == 0) return null;
    final from = _knownFrom[channel];
    return (count: count, more: from != null && mark < from - 1);
  }

  /// The state of [agent] as its row says it, or null for none.
  String? of(SuperTabAgent agent) {
    if (offlineOf(agent) case final offline?) return offline;
    final tasks = _taken[_repositories[agent.projectId]];
    final number = tasks?[(agent.displayName ?? agent.name).toLowerCase()];
    if (number != null) return 'on #$number';
    return _free[agent.id] == true ? 'free' : null;
  }

  void _changed() {
    if (_disposed) return;
    _settling ??= Timer(settle, _run);
  }

  /// The projects the person's own agents are in, the ones read for, and those agents.
  (List<SuperTabProject>, Set<String>) _watched() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return (const [], const {});
    final projects = <String, SuperTabProject>{};
    final agents = <String>{};
    for (final agent in superTabMyAgents(snapshot, controller.accountId)) {
      if (agent.buddyOf != null) continue;
      agents.add(agent.id);
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
        _repositories
          ..clear()
          ..addAll({
            for (final project in projects) project.id: _repository(project),
          });
        final repositories = {
          for (final repository in _repositories.values) ?repository,
        };
        _forget(
          agents: agents,
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
    _others.removeWhere((channel, _) => !channels.contains(channel));
    _knownFrom.removeWhere((channel, _) => !channels.contains(channel));
    _taken.removeWhere((repository, _) => !repositories.contains(repository));
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
      var latest = read == null;
      // More than a page since the mark: the latest page says where they are now, as the open chat reads after a gap.
      if (read != null && answer['next'] != null) {
        answer = await controller.request('GET', path);
        latest = true;
      }
      if (_disposed) return false;
      final rows = answer['messages'];
      final messages = [
        if (rows is List)
          for (final row in rows) SuperTabMessage.fromJson(superTabMap(row)),
      ]..sort(superTabMessageOrder);
      var moved = false;
      var upTo = read ?? 0;
      final was = {...?_others[channel]};
      final others = latest
          ? (_others[channel] = SplayTreeSet<int>())
          : _others.putIfAbsent(channel, SplayTreeSet<int>.new);
      // The latest page alone: posts older than it are not known, unless it is the whole channel.
      if (latest) {
        final first = messages.firstOrNull?.sequence;
        if (answer['next'] != null && first != null) {
          _knownFrom[channel] = first;
        } else {
          _knownFrom.remove(channel);
        }
      }
      for (final message in messages) {
        if (message.conversationId != channel) continue;
        upTo = max(upTo, message.sequence);
        if (!message.inMainStream || controller.isOwn(message)) continue;
        others.add(message.sequence);
        if (!message.fromAgent) continue;
        final free = isFreePost(message.text);
        if (_free[message.authorId] != free) {
          _free[message.authorId] = free;
          moved = true;
        }
      }
      // Bounded: past the cap the row says "99+", and what is older is not known.
      while (others.length > kCountCap) {
        others.remove(others.first);
        _knownFrom[channel] = others.first;
      }
      moved |= !setEquals(was, others.toSet());
      // What the Swarm said of the channel counts too: a post the reader may not see moves its counter.
      _channelRead[channel] = max(upTo, group.lastMessageSequence);
      _recovered('channel/$channel');
      return moved;
    } on Object catch (error) {
      _failed('channel/$channel', 'a channel', error);
      return false;
    }
  }

  /// Reads [repository]'s taken tasks when they are older than [boardEvery]; whether they changed.
  Future<bool> _readBoard(String repository) async {
    final at = _boardRead[repository];
    final every = boardEvery;
    if (_waiting('board/$repository') ||
        (at != null && (every == null || clock.now().difference(at) < every))) {
      return false;
    }
    try {
      final taken = await github.taken(repository);
      if (_disposed) return false;
      _boardRead[repository] = clock.now();
      _recovered('board/$repository');
      if (mapEquals(_taken[repository], taken)) return false;
      _taken[repository] = taken;
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
    _settling?.cancel();
    _settling = null;
    _boards?.cancel();
    super.dispose();
  }
}
