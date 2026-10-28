import 'dart:async';
import 'dart:isolate';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'parts.dart';
import 'swarm_request.dart';
import 'waiting_work.dart';

/// A Swarm of this many groups and agents or more is made into what the
/// screens draw off the UI isolate: on the owner's iPhone 14 a 1.3 MB Swarm took 73 to 93 ms
/// there, several frames (Mira's Profile numbers, 2026-10-27). A small one
/// takes less than sending it away does.
const swarmParseOffThreadParts = 100;

/// What the screens draw of a Swarm, worked out from its parts.
typedef _View = ({SuperTabSnapshot snapshot, Map<String, String> partners});

_View _viewOf(SuperTabParts parts) {
  final state = parts.state;
  return (
    snapshot: SuperTabSnapshot.fromJson(state),
    partners: swarmPartners(state),
  );
}

/// Whether a Swarm whose first load is [answer] is big enough to be worked
/// out off the UI isolate: its groups and agents are nearly all of it.
bool _big(Map<String, dynamic> answer) =>
    ((answer['groups'] as List?)?.length ?? 0) +
        ((answer['agents'] as List?)?.length ?? 0) >=
    swarmParseOffThreadParts;

/// [work], off the UI isolate when [big]. Top-level, so its closures carry
/// only what they are handed, never a reader.
Future<T> _offThread<T>(bool big, T Function() work) =>
    big ? Isolate.run(work) : Future.sync(work);

Future<_View> _view(SuperTabParts parts, {required bool big}) =>
    _offThread(big, () => _viewOf(parts));

Future<({SuperTabParts parts, _View view})> _load(
  Map<String, dynamic> answer,
) => _offThread(_big(answer), () {
  final parts = SuperTabParts.firstLoad(answer);
  return (parts: parts, view: _viewOf(parts));
});

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
    this.upload = refuseSwarmUpload,
    this.pollInterval = const Duration(seconds: 5),
  });

  final String tabId, accountId;
  final SwarmRequest request;

  /// Sends a chat's file to the backend ([SwarmConversation.send]).
  final SwarmUpload upload;
  final Duration pollInterval;

  /// The Swarm as last read; null before the first read and after access ends.
  SuperTabSnapshot? snapshot;

  /// Each conversation's partner, the person its work needs ([swarmPartners]).
  Map<String, String> partners = const {};

  /// What the last read could not do, as a sentence; null once one succeeds.
  String? error;

  /// The newest change of any part, as the last read said: what tells a list
  /// this Swarm changed. -1 before the first read. A move of it alone is no
  /// notify, only a [reads] count.
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

  /// Counts the first loads asked for, each told once its request is out:
  /// what is read alongside one answers no earlier than it does.
  ValueListenable<int> get firstLoads => _firstLoads;
  final _firstLoads = ValueNotifier(0);

  /// Which of [firstLoads] what this reader holds came from; 0 while it holds
  /// none.
  int get heldLoad => _heldLoad;
  int _heldLoad = 0;

  SuperTabParts? _parts;

  /// The first load held was big ([swarmParseOffThreadParts]): its changes
  /// are drawn off the UI isolate too.
  bool _bigParts = false;

  /// Counts what was drawn: one worked out off the UI isolate is not shown
  /// over one drawn meanwhile from the parts as they are now.
  int _views = 0;
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
        final views = _views;
        final view = read.view ?? await _view(parts, big: _bigParts);
        if (_disposed || accessRevoked) return;
        if (view.snapshot.id != tabId) {
          _parts = null;
          throw const FormatException('A different Swarm was returned.');
        }
        if (views == _views && identical(parts, _parts)) {
          _show(view);
          changed = true;
        }
      }
      // Moved alone, it is a change this reader cannot see: nothing to draw
      // again. What waits on it hears of it through [reads].
      lastChangedAt = parts.lastChangedAt;
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
  Future<({bool changed, _View? view})> _readParts() async {
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
          return (changed: change.changed || stale, view: null);
        }
      } on SuperTabFailure catch (failure) {
        if (!const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) rethrow;
      }
      _parts = null;
    }
    final asked = _get('$_path/parts');
    final number = ++_firstLoads.value;
    final answer = await asked;
    final load = await _load(answer);
    // Revoked meanwhile: what was read is not kept.
    if (_disposed || accessRevoked) return (changed: false, view: null);
    _parts = load.parts;
    _bigParts = _big(answer);
    _heldLoad = number;
    generation++;
    // A new store holds no closed conversations: they are read again.
    _dormantPages.clear();
    _dormantReads.clear();
    return (changed: true, view: load.view);
  }

  void _show(_View view) {
    snapshot = view.snapshot;
    partners = view.partners;
    _views++;
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
    _heldLoad = 0;
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
    _show(_viewOf(parts));
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
    if (change.changed) _show(_viewOf(parts));
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _reads.dispose();
    _firstLoads.dispose();
    super.dispose();
  }
}
