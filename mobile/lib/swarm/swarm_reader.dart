import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'parts.dart';
import 'swarm_request.dart';
import 'waiting_work.dart';

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

  /// Each conversation's partner, the person its work needs ([swarmPartners]).
  Map<String, String> partners = const {};

  /// What the last read could not do, as a sentence; null once one succeeds.
  String? error;

  /// The newest change of any part, as the last read said: what tells a list
  /// this Swarm changed. -1 before the first read.
  int lastChangedAt = -1;

  /// The reader may no longer read this Swarm: it left, or was removed.
  bool accessRevoked = false;

  /// Moves each time what this reader holds is read again from nothing (a
  /// first load) or taken away: an answer asked for under an earlier one may
  /// carry what the reader can no longer see, and is not applied.
  int generation = 0;

  /// The backend needs a newer build: no read can succeed, so none is tried.
  bool updateRequired = false;

  /// True until the first read answers, either way.
  bool get loading => snapshot == null && error == null && !accessRevoked;

  /// Counts the reads that answered, changed or not: what tells a read that
  /// failed beside this one to try again, where the Swarm itself stays as it
  /// was and so tells nothing.
  ValueListenable<int> get reads => _reads;
  final _reads = ValueNotifier(0);

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
      if (_disposed || accessRevoked) return;
      final parts = _parts!;
      if (read.changed || snapshot == null) {
        final state = parts.state;
        final next = SuperTabSnapshot.fromJson(state);
        if (next.id != tabId) {
          _parts = null;
          throw const FormatException('A different Swarm was returned.');
        }
        snapshot = next;
        partners = swarmPartners(state);
        changed = true;
      }
      if (lastChangedAt != parts.lastChangedAt) {
        lastChangedAt = parts.lastChangedAt;
        changed = true;
      }
      error = null;
      _reads.value++;
    } on SuperTabFailure catch (failure) {
      if (_disposed || accessRevoked) return;
      if (failure.statusCode == 426 ||
          (failure.code == 'UPDATE_REQUIRED' && failure.statusCode != 400)) {
        updateRequired = true;
        error = 'Update Harness to keep using this Swarm.';
        _poll?.cancel();
      } else if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        // Refused a first load: nothing of a Swarm it left stays on screen.
        _forget();
        error = failure.message;
      } else {
        error = failure.message;
      }
      changed = true;
    } on FormatException catch (failure) {
      if (_disposed || accessRevoked) return;
      error = failure.message.isEmpty
          ? 'Could not read this Swarm.'
          : failure.message;
      changed = true;
    } catch (_) {
      if (_disposed || accessRevoked) return;
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
    final load = await _get('$_path/parts');
    // Revoked meanwhile: what was read is not kept.
    if (_disposed || accessRevoked) return (changed: false);
    _parts = SuperTabParts.firstLoad(load);
    generation++;
    // A new store holds no closed conversations: they are read again.
    _dormantPages.clear();
    _dormantReads.clear();
    return (changed: true);
  }

  /// The reader may no longer read this Swarm — a first load was refused, or
  /// it left the account's list: nothing read of it stays, and it reads no
  /// more. Its listeners hear of it, so a screen holding it lets go too.
  void revoke() {
    if (_disposed || accessRevoked) return;
    _forget();
    error = null;
    notifyListeners();
  }

  void _forget() {
    accessRevoked = true;
    snapshot = null;
    partners = const {};
    _parts = null;
    generation++;
    _dormantPages.clear();
    _dormantReads.clear();
    _poll?.cancel();
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
  /// point at one. False when the reader cannot read it; a read that failed
  /// throws, as it says nothing of whether it could.
  Future<bool> loadConversation(String id) async {
    if (snapshot?.conversation(id) != null) return true;
    if (_parts == null) {
      await refresh();
      if (snapshot?.conversation(id) != null) return true;
    }
    if (_disposed || accessRevoked) return false;
    final parts = _parts;
    if (parts == null) {
      throw SuperTabFailure(
        'UNAVAILABLE',
        error ?? 'Could not read this Swarm.',
      );
    }
    final bool readable;
    try {
      readable = await _readGroup(parts, id);
    } on SuperTabFailure catch (failure) {
      if (!_disposed) {
        error = failure.message;
        notifyListeners();
      }
      rethrow;
    }
    if (_disposed || accessRevoked) return false;
    // Read again from nothing meanwhile: that read is the one to ask.
    if (!identical(parts, _parts)) return loadConversation(id);
    if (!readable) return false;
    final state = parts.state;
    snapshot = SuperTabSnapshot.fromJson(state);
    partners = swarmPartners(state);
    notifyListeners();
    return snapshot?.conversation(id) != null;
  }

  /// Each project's closed conversations as read: where the next earlier
  /// page starts, null when there is none. A project not here is not read.
  final _dormantPages = <String, String?>{};
  final _dormantReads = <String, Future<void>>{};

  /// Whether [projectId]'s closed conversations have been read.
  bool dormantLoaded(String projectId) => _dormantPages.containsKey(projectId);

  /// Whether a read of [projectId]'s closed conversations is under way.
  bool dormantLoading(String projectId) => _dormantReads.containsKey(projectId);

  /// Whether [projectId] has closed conversations older than those read.
  bool hasEarlierDormant(String projectId) => _dormantPages[projectId] != null;

  /// Reads [projectId]'s closed conversations (archived, or quiet for a day),
  /// which no first load has, newest first and a page at a time (section
  /// 4.5): the first page once, [earlier] the next. Joins a read under way;
  /// a read that failed throws, and asking again reads again — the desktop's
  /// `loadDormant`.
  Future<void> loadDormant(String projectId, {bool earlier = false}) {
    if (_disposed || accessRevoked || _parts == null) return Future.value();
    if (_dormantReads[projectId] case final reading?) return reading;
    if (earlier ? !hasEarlierDormant(projectId) : dormantLoaded(projectId)) {
      return Future.value();
    }
    late final Future<void> reading;
    reading = _readDormant(projectId, earlier).whenComplete(() {
      if (identical(_dormantReads[projectId], reading)) {
        _dormantReads.remove(projectId);
      }
      if (!_disposed) notifyListeners();
    });
    _dormantReads[projectId] = reading;
    notifyListeners();
    return reading;
  }

  Future<void> _readDormant(String projectId, bool earlier) async {
    final parts = _parts!;
    final before = earlier ? _dormantPages[projectId] : null;
    final answer = await _get(
      '$_path/groups?dormant=1&projectId=${Uri.encodeQueryComponent(projectId)}'
      '${before == null ? '' : '&before=${Uri.encodeQueryComponent(before)}'}',
    );
    // Read again from nothing meanwhile: this page is of the parts before.
    if (_disposed || accessRevoked || !identical(parts, _parts)) return;
    final change = parts.addDormant(answer['groups'] as List);
    _dormantPages[projectId] = answer['next'] as String?;
    if (change.changed) {
      final state = parts.state;
      snapshot = SuperTabSnapshot.fromJson(state);
      partners = swarmPartners(state);
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _reads.dispose();
    super.dispose();
  }
}
