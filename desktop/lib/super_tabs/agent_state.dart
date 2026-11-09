import 'dart:async';
import 'dart:math' show max;

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../core/test_run.dart';
import '../logging/app_log.dart';
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
/// Only the channels and boards of the projects the person's own agents are in are read, and only what changed: a channel
/// again when the Swarm says it moved past what was read (the messages after that mark, as the open chat reads them), a board
/// once a [boardEvery] while the Swarm is on screen. At most [maxProjects] projects, [maxPages] pages of a channel at a time.
class SwarmAgentStates extends ChangeNotifier {
  SwarmAgentStates({
    required this.controller,
    required this.github,
    String? Function(SuperTabProject project)? repositoryOf,
    this.boardEvery = const Duration(minutes: 1),
    this.settle = const Duration(milliseconds: 400),
  }) : _repositoryOf = repositoryOf ?? _recorded {
    controller.addListener(_changed);
    _changed();
  }

  final SuperTabController controller;
  final SwarmGitHub github;

  /// A project's GitHub repository (`owner/name`), or null: the one its record names unless the caller knows another.
  final String? Function(SuperTabProject project) _repositoryOf;

  /// How long a board's read stands before it is read again.
  final Duration boardEvery;

  /// How long changes are let settle before the reads they ask for are made.
  final Duration settle;

  /// The projects whose agents are read for, and the pages of a channel one run reads.
  static const maxProjects = 12, maxPages = 3;

  static String? _recorded(SuperTabProject project) =>
      SwarmGitHub.repositoryOf(project.repository?['repositoryUrl'] as String?);

  static final _freePost = RegExp(r'^\s*free\s*:', caseSensitive: false);

  /// Whether an agent's post says it is free.
  static bool isFreePost(String text) => _freePost.hasMatch(text);

  /// Whether each agent's latest post in its channel is a free one; and how far each channel was read.
  final _free = <String, bool>{};
  final _channelRead = <String, int>{};

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

  /// The state of [agent] as its row says it, or null for none.
  String? of(SuperTabAgent agent) {
    if (agent.downSince != null) return 'offline';
    final tasks = _taken[_repositories[agent.projectId]];
    final number = tasks?[(agent.displayName ?? agent.name).toLowerCase()];
    if (number != null) return 'on #$number';
    return _free[agent.id] == true ? 'free' : null;
  }

  void _changed() {
    if (_disposed) return;
    _settling ??= Timer(settle, _run);
  }

  /// The projects the person's own agents are in, the ones read for.
  List<SuperTabProject> _watched() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return const [];
    final projects = <String, SuperTabProject>{};
    for (final agent in superTabMyAgents(snapshot, controller.accountId)) {
      if (agent.buddyOf != null) continue;
      if (snapshot.projectById(agent.projectId) case final project?) {
        projects.putIfAbsent(project.id, () => project);
      }
    }
    return projects.values.take(maxProjects).toList();
  }

  Future<void> _run() async {
    _settling = null;
    if (_disposed || controller.away) return;
    if (_running) {
      _again = true;
      return;
    }
    _running = true;
    var moved = false;
    try {
      do {
        _again = false;
        final projects = _watched();
        _repositories
          ..clear()
          ..addAll({
            for (final project in projects) project.id: _repositoryOf(project),
          });
        for (final project in projects) {
          if (_disposed) return;
          moved |= await _readChannel(project);
        }
        for (final repository in {
          for (final repository in _repositories.values) ?repository,
        }) {
          if (_disposed) return;
          moved |= await _readBoard(repository);
        }
        if (projects.isNotEmpty && !_disposed && !kUnderTest) {
          // Back for the boards: nothing pushes a change of GitHub's.
          _boards?.cancel();
          _boards = Timer(boardEvery, _changed);
        }
      } while (_again && !_disposed);
    } finally {
      _running = false;
    }
    if (moved && !_disposed) notifyListeners();
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

  /// Reads the posts of [project]'s channel that came since the last read, or its latest page the first time; whether an
  /// agent's state moved.
  Future<bool> _readChannel(SuperTabProject project) async {
    final channel = project.leadConversationId;
    final group = controller.snapshot?.conversation(channel);
    if (group == null || _waiting('channel/$channel')) return false;
    final read = _channelRead[channel];
    if (read != null && group.lastMessageSequence <= read) return false;
    var moved = false;
    var upTo = read;
    try {
      for (var page = 0; page < maxPages; page++) {
        final answer = await controller.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}'
              '/conversations/${Uri.encodeComponent(channel)}/messages'
              '${upTo == null ? '' : '?after=$upTo'}',
        );
        if (_disposed) return moved;
        final rows = answer['messages'];
        final messages = [
          if (rows is List)
            for (final row in rows) SuperTabMessage.fromJson(superTabMap(row)),
        ]..sort(superTabMessageOrder);
        for (final message in messages) {
          if (message.conversationId != channel) continue;
          upTo = max(upTo ?? 0, message.sequence);
          if (!message.fromAgent) continue;
          final free = isFreePost(message.text);
          if (_free[message.authorId] != free) {
            _free[message.authorId] = free;
            moved = true;
          }
        }
        if (answer['next'] == null || messages.isEmpty) break;
      }
      // What the Swarm said of the channel counts too: a post the reader may not see moves its counter.
      _channelRead[channel] = max(upTo ?? 0, group.lastMessageSequence);
      _recovered('channel/$channel');
    } on Object catch (error) {
      _failed('channel/$channel', 'a channel', error);
    }
    return moved;
  }

  /// Reads [repository]'s taken tasks when they are older than [boardEvery]; whether they changed.
  Future<bool> _readBoard(String repository) async {
    final at = _boardRead[repository];
    if (_waiting('board/$repository') ||
        (at != null && clock.now().difference(at) < boardEvery)) {
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
    _boards?.cancel();
    super.dispose();
  }
}
