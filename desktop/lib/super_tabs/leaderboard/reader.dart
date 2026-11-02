import 'dart:async';

import 'package:flutter/foundation.dart';

import '../controller.dart';
import 'model.dart';

/// Reads one project's leaderboard while Humans are shown, and again every
/// [every]: the board sums a week, so it moves slowly. A failed refresh keeps
/// the last board and says why.
class SuperTabLeaderboardReader extends ChangeNotifier {
  SuperTabLeaderboardReader({
    required this.tabId,
    required this.request,
    this.every = const Duration(minutes: 1),
  });

  final String tabId;
  final SuperTabRequest request;
  final Duration every;

  SuperTabLeaderboard? board;
  String? error;
  String? _projectId;
  int? _week;
  String _period = leaderboardDefaultPeriod;
  bool _weeksOnly = false;
  bool _allProjects = true;
  int _read = 0;
  Timer? _timer;
  bool _disposed = false;

  /// The Monday 00:00 UTC of the week shown; null for this week.
  int? get week => _week;

  /// The rolling period shown; null while the server only sums weeks (a
  /// server before periods), which keeps the week menu. Told once per reader:
  /// a server that is upgraded later is seen on the next launch.
  String? get period => _weeksOnly ? null : _period;

  /// Sums every project the reader may read, or only the one shown: the
  /// roster's scope, All projects by default. A server before periods sums
  /// only the one shown.
  Future<void> showAllProjects(bool allProjects) {
    if (allProjects == _allProjects) return Future.value();
    _allProjects = allProjects;
    // Whole-Swarm numbers under one project's name would mislead, and its
    // list of people would say who is in the project.
    board = null;
    _notify();
    return refresh();
  }

  /// Shows another rolling period.
  Future<void> showPeriod(String period) {
    if (period == _period) return Future.value();
    _period = period;
    // Another period's numbers under this one's name would mislead.
    board = null;
    _notify();
    return refresh();
  }

  /// Shows another week, null for this one.
  Future<void> showWeek(int? week) {
    if (week == _week) return Future.value();
    _week = week;
    // Another week's numbers under this week's name would mislead until the read lands.
    board = null;
    _notify();
    return refresh();
  }

  /// Shows [projectId]'s board, read now and then every [every].
  Future<void> show(String projectId) {
    if (projectId != _projectId) {
      _projectId = projectId;
      board = null;
      error = null;
    }
    _timer ??= Timer.periodic(every, (_) => unawaited(tick()));
    return refresh();
  }

  /// Forgets the board: no project is open, or the reader lost it. A read in
  /// flight is dropped, so its answer never shows.
  void clear() {
    _projectId = null;
    _read++;
    board = null;
    error = null;
    hide();
    _notify();
  }

  /// Stops the refresh while Humans are not shown; the board stays.
  void hide() {
    _timer?.cancel();
    _timer = null;
  }

  /// A timed read. A reader that is off screen skips it.
  @protected
  Future<void> tick() => refresh();

  Future<void> refresh() async {
    final projectId = _projectId;
    if (projectId == null || _disposed) return;
    final read = ++_read, week = _week, period = this.period;
    final allProjects = _allProjects;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/leaderboard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}'
            '${period != null
                ? '&period=$period${allProjects ? '&scope=all' : ''}'
                : week == null
                ? ''
                : '&week=$week'}',
      );
      if (read != _read) return;
      board = SuperTabLeaderboard.fromJson(answer);
      if (board!.period == null) _weeksOnly = true;
      error = null;
    } on SuperTabFailure catch (failure) {
      if (read != _read) return;
      // A server before periods refuses the question, and only that one: any
      // other failure, however early, leaves the periods on for the next read.
      if (failure.statusCode == 400 && period != null) {
        _weeksOnly = true;
        return refresh();
      }
      // A server from before the leaderboard has none: Humans just list names.
      // A project the reader may no longer read is forgotten alike, its
      // numbers and the server's words about it.
      if (failure.statusCode == 404 || failure.statusCode == 403) {
        board = null;
        error = null;
      } else {
        error = failure.message;
      }
    } catch (_) {
      if (read != _read) return;
      error = "Couldn't read the leaderboard.";
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// The board of the open conversation's project, read once for the right
/// pane's members and the sidebar's Models, so both show one project and one
/// week. No project open, or the project gone from the Swarm the reader
/// sees, clears it.
class SuperTabProjectBoard extends SuperTabLeaderboardReader {
  /// The board moves only as work ships, is answered or runs: every five
  /// minutes is fresh enough, and keeps every open window's reads rare.
  SuperTabProjectBoard(
    this.controller, {
    super.every = const Duration(minutes: 5),
  }) : super(tabId: controller.tabId, request: controller.request) {
    controller.addListener(_follow);
    controller.machinesChanged.addListener(_returned);
    _follow();
  }

  final SuperTabController controller;
  String? _following;
  bool _missed = false;

  /// The project whose board this is; null while none is open.
  String? get projectId => _following;

  void _follow() {
    final projectId = controller.snapshot
        ?.projectFor(controller.selectedId)
        ?.id;
    if (projectId == _following) return;
    _following = projectId;
    if (projectId == null) {
      clear();
    } else {
      unawaited(show(projectId));
    }
  }

  /// A Swarm that isn't showing reads no board. One that missed a read takes it as it returns.
  @override
  Future<void> tick() {
    if (!controller.away) return refresh();
    _missed = true;
    return Future.value();
  }

  void _returned() {
    if (!_missed || controller.away) return;
    _missed = false;
    unawaited(refresh());
  }

  @override
  void dispose() {
    controller.removeListener(_follow);
    controller.machinesChanged.removeListener(_returned);
    super.dispose();
  }
}
