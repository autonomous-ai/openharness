import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'parts.dart';
import 'swarm_request.dart';

/// One Swarm as this phone keeps it current: a first load, then only the parts
/// that changed since its cursor (docs/design/2026-10-26-swarm-state-parts.md,
/// section 4) — the desktop's `SuperTabController` read, without its panes,
/// drafts and launches.
///
/// It reads only while [shown]: a phone pays for every read in data and
/// battery, and a Swarm nobody is looking at needs none (the web build's
/// `SuperTabReading.pausesAway`). Shown again, it reads at once.
class SwarmReader extends ChangeNotifier {
  SwarmReader({
    required this.tabId,
    required this.accountId,
    required this.request,
    this.pollInterval = const Duration(seconds: 5),
  });

  final String tabId, accountId;
  final SwarmRequest request;
  final Duration pollInterval;

  /// The Swarm as last read; null before the first read and after access ends.
  SuperTabSnapshot? snapshot;

  /// What the last read could not do, as a sentence; null once one succeeds.
  String? error;

  /// The newest change of any part, as the last read said: what tells a list
  /// this Swarm changed. -1 before the first read.
  int lastChangedAt = -1;

  /// The reader may no longer read this Swarm: it left, or was removed.
  bool accessRevoked = false;

  /// The backend needs a newer build: no read can succeed, so none is tried.
  bool updateRequired = false;

  /// True until the first read answers, either way.
  bool get loading => snapshot == null && error == null && !accessRevoked;

  SuperTabParts? _parts;
  Future<void>? _refreshing;
  Timer? _poll;
  bool _shown = false, _disposed = false;

  String get _path => '/api/super-tabs/${Uri.encodeComponent(tabId)}';

  bool get shown => _shown;

  /// On screen: reads at once and every [pollInterval] after. Off screen:
  /// reads nothing.
  set shown(bool value) {
    if (_shown == value) return;
    _shown = value;
    _poll?.cancel();
    _poll = null;
    if (value) unawaited(_tick());
  }

  Future<void> _tick() async {
    await refresh();
    if (_disposed || !_shown || updateRequired || accessRevoked) return;
    _poll?.cancel();
    _poll = Timer(pollInterval, () => unawaited(_tick()));
  }

  /// One read now, joining one under way.
  Future<void> refresh() {
    if (_disposed || accessRevoked || updateRequired) return Future.value();
    return _refreshing ??= _read().whenComplete(() => _refreshing = null);
  }

  Future<Map<String, dynamic>> _get(String path) async =>
      superTabMap(await request('GET', path));

  Future<void> _read() async {
    var changed = false;
    final failedBefore = error;
    try {
      final read = await _readParts();
      if (_disposed) return;
      final parts = _parts!;
      if (read.changed || snapshot == null) {
        final next = SuperTabSnapshot.fromJson(parts.state);
        if (next.id != tabId) {
          _parts = null;
          throw const FormatException('A different Swarm was returned.');
        }
        snapshot = next;
        changed = true;
      }
      if (lastChangedAt != parts.lastChangedAt) {
        lastChangedAt = parts.lastChangedAt;
        changed = true;
      }
      error = null;
    } on SuperTabFailure catch (failure) {
      if (_disposed) return;
      if (failure.statusCode == 426 ||
          (failure.code == 'UPDATE_REQUIRED' && failure.statusCode != 400)) {
        updateRequired = true;
        error = 'Update Harness to keep using this Swarm.';
        _poll?.cancel();
      } else if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        // Refused a first load: nothing of a Swarm it left stays on screen.
        accessRevoked = true;
        snapshot = null;
        _parts = null;
        error = failure.message;
        _poll?.cancel();
      } else {
        error = failure.message;
      }
      changed = true;
    } on FormatException catch (failure) {
      if (_disposed) return;
      error = failure.message.isEmpty
          ? 'Could not read this Swarm.'
          : failure.message;
      changed = true;
    } catch (_) {
      if (_disposed) return;
      error = 'Could not reach this Swarm. Try again.';
      changed = true;
    }
    if (changed || error != failedBefore) notifyListeners();
  }

  /// Changes since the cursor once a first load is held, else a first load. A
  /// reload answer, or a change read refused for access (the Swarm or the
  /// reader's access moved), loads in full at once.
  Future<({bool changed})> _readParts() async {
    final held = _parts;
    if (held != null) {
      try {
        final answer = await _get(
          '$_path/changes?cursor=${Uri.encodeQueryComponent(held.cursor)}',
        );
        if (answer['reload'] != true) {
          final SuperTabPartsChange change;
          try {
            change = held.apply(answer);
          } catch (_) {
            // Half merged: the next read starts again from a first load.
            if (identical(_parts, held)) _parts = null;
            rethrow;
          }
          final stale = await _refreshStale(held);
          return (changed: change.changed || stale);
        }
      } on SuperTabFailure catch (failure) {
        if (!const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) rethrow;
      }
      _parts = null;
    }
    _parts = SuperTabParts.firstLoad(await _get('$_path/parts'));
    return (changed: true);
  }

  /// A dormant stub says a held group closed, not how: its data is read again
  /// by id. Best effort: a failure leaves it as it was until the next read.
  Future<bool> _refreshStale(SuperTabParts parts) async {
    var read = false;
    for (final id in parts.staleGroups) {
      try {
        if (await _readGroup(parts, id)) {
          read = true;
        } else {
          parts.forgetStale(id);
        }
      } on SuperTabFailure {
        // Tried again at the next read.
      }
    }
    return read;
  }

  /// Reads group [id] by id into [parts], active or closed (section 4.5).
  /// False when the reader cannot read it.
  Future<bool> _readGroup(SuperTabParts parts, String id) async {
    try {
      final answer = await _get('$_path/groups/${Uri.encodeComponent(id)}');
      if (!identical(parts, _parts)) return false;
      parts.addDormant([answer['group']]);
      return true;
    } on SuperTabFailure catch (failure) {
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) return false;
      rethrow;
    }
  }

  /// Makes conversation [id] part of [snapshot]: one a first load leaves out
  /// (closed, or quiet for a day) is read by id, as a decision or a tag can
  /// point at one. False when it cannot be read.
  Future<bool> loadConversation(String id) async {
    if (snapshot?.conversation(id) != null) return true;
    final parts = _parts;
    if (parts == null) return false;
    try {
      if (!await _readGroup(parts, id)) return false;
    } on SuperTabFailure catch (failure) {
      error = failure.message;
      notifyListeners();
      return false;
    }
    if (_disposed || !identical(parts, _parts)) return false;
    snapshot = SuperTabSnapshot.fromJson(parts.state);
    notifyListeners();
    return snapshot?.conversation(id) != null;
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    super.dispose();
  }
}
