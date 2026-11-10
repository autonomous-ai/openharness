import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../logging/app_log.dart';
import '../controller.dart';

/// One person on the Swarm's leaderboard (docs/plans/2026-11-09-swarm-v4-leaderboard.md): how many of their agents ship, and
/// what that is worth (backend superTabs/shipping/contract.ts `ShippingBoard`).
class ShippingPerson {
  const ShippingPerson({
    required this.personId,
    required this.displayName,
    required this.agentsShipping,
    required this.level,
    required this.points,
    required this.rank,
  });

  final String personId, displayName;
  final int agentsShipping, level, rank;
  final double points;

  /// Null for a row that is not one: the board skips it, never fails on it.
  static ShippingPerson? tryParse(Object? json) {
    if (json is! Map) return null;
    final personId = json['personId'], name = json['displayName'];
    final agents = json['agentsShipping'], level = json['level'];
    final points = json['points'], rank = json['rank'];
    if (personId is! String ||
        name is! String ||
        agents is! int ||
        level is! int ||
        points is! num ||
        rank is! int) {
      return null;
    }
    return ShippingPerson(
      personId: personId,
      displayName: name,
      agentsShipping: agents,
      level: level,
      points: points.toDouble(),
      rank: rank,
    );
  }
}

/// A reading of GitHub that failed on one of the reader's own computers (its daemon told the server): the numbers there stay,
/// and the board says why to that person alone.
class ShippingFailure {
  const ShippingFailure(this.machineId, this.code);
  final String machineId, code;

  static ShippingFailure? tryParse(Object? json) =>
      json is Map && json['machineId'] is String && json['code'] is String
      ? ShippingFailure(json['machineId'] as String, json['code'] as String)
      : null;
}

/// The board of one week (its Monday 00:00 UTC), or of all time when [week] is null.
class SuperTabShipping {
  const SuperTabShipping({
    required this.week,
    required this.people,
    required this.failures,
  });

  factory SuperTabShipping.fromJson(Map<String, dynamic> json) {
    final week = json['week'];
    return SuperTabShipping(
      // All time has no week: the server says null (0 is read alike).
      week: week is int && week > 0 ? week : null,
      people: [
        for (final row in json['people'] as List? ?? const [])
          ?ShippingPerson.tryParse(row),
      ],
      failures: [
        for (final row in json['failures'] as List? ?? const [])
          ?ShippingFailure.tryParse(row),
      ],
    );
  }

  final int? week;
  final List<ShippingPerson> people;
  final List<ShippingFailure> failures;
}

/// Points as the board shows them: one decimal, as the server rounds them.
String shippingPoints(double points) => points.toStringAsFixed(1);

/// Why a reading of GitHub paused, in a few words.
String shippingFailureText(String code) => switch (code) {
  'GH_MISSING' => 'GitHub CLI missing',
  'GH_SIGNED_OUT' => 'GitHub signed out',
  'RATE_LIMITED' => 'GitHub is limiting reads',
  'TIMEOUT' => 'GitHub did not answer',
  'TOO_MANY' => 'Too many issues to read',
  _ => 'GitHub read failed',
};

/// Reads the Swarm's leaderboard (`GET .../shipping`): this week, or all time. It moves only as daemons report, every quarter
/// hour or so, so it is read when shown and then every [every] until disposed, never on every change of the Swarm. A failed
/// read keeps the last board and says why; a read that does not answer in [timeout] has failed.
class SuperTabShippingReader extends ChangeNotifier {
  SuperTabShippingReader({
    required this.tabId,
    required this.request,
    this.every = const Duration(minutes: 5),
  });

  final String tabId;
  final SuperTabRequest request;
  final Duration every;
  static const timeout = Duration(seconds: 15);

  /// The board shown: this week's, or all time's.
  SuperTabShipping? board;

  /// This week's board as last read, whichever is shown: Top Teams lists it.
  SuperTabShipping? week;
  String? error;
  bool loading = false;
  bool _allTime = false;
  int _read = 0;
  Timer? _timer;
  bool _disposed = false;

  /// Whether the board shown is all time, not this week.
  bool get allTime => _allTime;

  /// Shows the board, read now and then every [every] until disposed.
  Future<void> show() {
    _timer ??= Timer.periodic(every, (_) => unawaited(tick()));
    return refresh();
  }

  /// A timed read.
  @protected
  Future<void> tick() => refresh();

  /// Shows all time or this week. The other's numbers under this one's name would mislead, so they go until the read lands.
  Future<void> showAllTime(bool allTime) {
    if (allTime == _allTime) return Future.value();
    _allTime = allTime;
    board = null;
    error = null;
    _notify();
    return refresh();
  }

  Future<void> refresh() async {
    if (_disposed) return;
    final read = ++_read, allTime = _allTime;
    loading = true;
    _notify();
    try {
      final answer = await request(
        'GET',
        '/api/super-tabs/${Uri.encodeComponent(tabId)}/shipping${allTime ? '?all=1' : ''}',
      ).timeout(timeout);
      if (read != _read) return;
      board = SuperTabShipping.fromJson(answer);
      if (!allTime) week = board;
      error = null;
    } on SuperTabFailure catch (failure) {
      if (read != _read) return;
      // A server from before the leaderboard has none, and a Swarm the reader no longer reads is gone from them: nothing to show.
      if (failure.statusCode == 404 || failure.statusCode == 403) {
        board = null;
        week = null;
        error = null;
      } else {
        error = failure.message;
        _logFailed(failure.code);
      }
    } catch (thrown) {
      if (read != _read) return;
      error = "Couldn't read the leaderboard.";
      _logFailed('${thrown.runtimeType}');
    } finally {
      if (read == _read) loading = false;
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// By the failure's name alone: what the server or GitHub said may name the person's own work.
  void _logFailed(String name) =>
      appLog.warn('super-tabs', 'Leaderboard not read ($name)');

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// The Swarm view's leaderboard, read for its left pane's Top Teams and its Leaderboard page alike, so both show one board. A
/// Swarm that isn't showing reads nothing; one that missed a read takes it as it returns.
class SuperTabShippingBoard extends SuperTabShippingReader {
  SuperTabShippingBoard(this.controller)
    : super(tabId: controller.tabId, request: controller.request) {
    controller.machinesChanged.addListener(_returned);
    unawaited(show());
  }

  final SuperTabController controller;
  bool _missed = false;

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
    controller.machinesChanged.removeListener(_returned);
    super.dispose();
  }
}
