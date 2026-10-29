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
  int _read = 0;
  Timer? _timer;
  bool _disposed = false;

  /// The Monday 00:00 UTC of the week shown; null for this week.
  int? get week => _week;

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
    _timer ??= Timer.periodic(every, (_) => unawaited(refresh()));
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

  Future<void> refresh() async {
    final projectId = _projectId;
    if (projectId == null || _disposed) return;
    final read = ++_read, week = _week;
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/leaderboard'
            '?projectId=${Uri.encodeQueryComponent(projectId)}'
            '${week == null ? '' : '&week=$week'}',
      );
      if (read != _read) return;
      board = SuperTabLeaderboard.fromJson(answer);
      error = null;
    } on SuperTabFailure catch (failure) {
      if (read != _read) return;
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
    _follow();
  }

  final SuperTabController controller;
  String? _following;

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

  @override
  void dispose() {
    controller.removeListener(_follow);
    super.dispose();
  }
}
