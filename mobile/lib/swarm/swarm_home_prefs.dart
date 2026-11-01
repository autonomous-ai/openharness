import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'swarm_home_list.dart';

/// What the person chose for Swarm Home on this phone (Tony, 2026-10-29):
/// the projects pinned at its top ([pins]), the one Swarm it shows
/// ([swarmId]; none shows them all) and its unread filter ([unreadOnly]);
/// and when they last left the app ([seenAt]), what While you were away
/// counts from; and the projects whose
/// status card is folded ([folded]), as the desktop keeps it on its computer.
/// Neither the server nor the desktop has pins, so they stay on this phone,
/// under the account ([store]): ids and a time only, nothing read of a Swarm,
/// and at most [keptPins] pins and [keptFolds] folds. A Swarm the account no
/// longer has takes its pins, folds and choice with it ([keepOnly]).
class SwarmHomePrefs extends ChangeNotifier {
  SwarmHomePrefs({required this.accountId, this.store}) {
    unawaited(_load());
  }

  /// The most pins kept; the oldest goes first.
  static const keptPins = 50;

  /// The most folded status cards kept, as the desktop keeps
  /// (`SuperTabController.statusFoldedKept`); the oldest goes first.
  static const keptFolds = 200;

  final String accountId;

  /// Where the choices are kept; null keeps them in memory only.
  final LocalKeyValueStore? store;

  String get _key => 'swarm_home.$accountId';

  /// The projects pinned, by [swarmHomeProjectKey], oldest first.
  Set<String> get pins => Set.unmodifiable(_pins);
  final _pins = <String>{};

  /// The projects whose status card is folded, by [swarmHomeProjectKey],
  /// oldest first.
  Set<String> get folds => Set.unmodifiable(_folds);
  final _folds = <String>{};

  /// The one Swarm Home shows; null for all of them.
  String? get swarmId => _swarmId;
  String? _swarmId;

  /// Home lists only the projects with something unread or a tag waiting
  /// (the desktop's unread filter, `SuperTabController.unreadOnly`), kept on
  /// this phone as the desktop keeps it on its computer.
  bool get unreadOnly => _unreadOnly;
  bool _unreadOnly = false;

  /// When the person last left the app ([seen]); null before, as on a new
  /// phone.
  DateTime? get seenAt => _seenAt;
  DateTime? _seenAt;

  /// Something was chosen before the choices were read back: it is kept
  /// with what was read, and written only then, so as not to write over it.
  bool _touched = false;

  /// Before the choices are read back: the pins taken off and the cards
  /// unfolded meanwhile, which what is read does not bring back, and whether
  /// a Swarm was chosen to show, which stands over the one read.
  final _unpinned = <String>{}, _unfolded = <String>{};
  bool _shownChosen = false, _unreadChosen = false;

  /// The account's Swarms, as [keepOnly] last heard them; null before. What
  /// is read back is held to them too.
  Set<String>? _swarms;

  /// The choices were read back (or there is nowhere to read them from).
  bool get loaded => _loaded;
  late bool _loaded = store == null;
  bool _disposed = false;

  bool pinned(String swarmId, String projectId) =>
      _pins.contains(swarmHomeProjectKey(swarmId, projectId));

  /// Pins [projectId] of [swarmId] at Home's top ([on]), or takes it off.
  void pin(String swarmId, String projectId, bool on) {
    final key = swarmHomeProjectKey(swarmId, projectId);
    if (!_loaded) {
      if (on) {
        _unpinned.remove(key);
      } else if (_unpinned.add(key)) {
        // Read back pinned, it stays off.
        _touched = true;
      }
    }
    if (on ? !_pins.add(key) : !_pins.remove(key)) return;
    _cap();
    _changed();
  }

  /// Whether [projectId]'s status card in [swarmId] is folded to its heading.
  bool folded(String swarmId, String projectId) =>
      _folds.contains(swarmHomeProjectKey(swarmId, projectId));

  /// Folds [projectId]'s status card in [swarmId] ([on]), or opens it.
  void fold(String swarmId, String projectId, bool on) {
    final key = swarmHomeProjectKey(swarmId, projectId);
    if (!_loaded) {
      if (on) {
        _unfolded.remove(key);
      } else if (_unfolded.add(key)) {
        // Read back folded, it stays open.
        _touched = true;
      }
    }
    if (on ? !_folds.add(key) : !_folds.remove(key)) return;
    _cap();
    _changed();
  }

  /// Home shows Swarm [swarmId] alone; null shows them all.
  void show(String? swarmId) {
    if (!_loaded) {
      // Chosen, even if as it is: what is read back does not change it.
      _shownChosen = true;
      _touched = true;
    }
    if (_swarmId == swarmId) return;
    _swarmId = swarmId;
    _changed();
  }

  /// Turns the unread filter on or off ([unreadOnly]).
  void toggleUnreadOnly() {
    if (!_loaded) _unreadChosen = true;
    _unreadOnly = !_unreadOnly;
    _changed();
  }

  /// The person leaves the app at [at]: kept, the later time standing over
  /// an earlier one, and written. Home does not draw it, so it tells no
  /// one.
  void seen(DateTime at) {
    if (_disposed || !at.isAfter(_seenAt ?? DateTime(0))) return;
    _seenAt = at;
    _touched = true;
    if (_loaded) unawaited(_save());
  }

  /// The account's Swarms are [swarmIds]: the pins and the choice of any
  /// other go, from the phone too, and from what is read back after.
  void keepOnly(Set<String> swarmIds) {
    _swarms = swarmIds;
    if (_keep(swarmIds)) _changed();
  }

  /// Drops the pins, folds and choice of any Swarm but [swarmIds]; whether
  /// any went.
  bool _keep(Set<String> swarmIds) {
    final before = _pins.length + _folds.length;
    bool other(String key) => !swarmIds.contains(key.split('/').first);
    _pins.removeWhere(other);
    _folds.removeWhere(other);
    final gone = _swarmId != null && !swarmIds.contains(_swarmId);
    if (gone) _swarmId = null;
    return gone || _pins.length + _folds.length != before;
  }

  /// At most [keptPins] pins and [keptFolds] folds, the oldest going first;
  /// whether any went.
  bool _cap() {
    bool trim(Set<String> keys, int kept) {
      final over = keys.length - kept;
      if (over <= 0) return false;
      keys.removeAll(keys.take(over).toList());
      return true;
    }

    final pins = trim(_pins, keptPins);
    return trim(_folds, keptFolds) || pins;
  }

  void _changed() {
    _touched = true;
    if (_disposed) return;
    notifyListeners();
    if (_loaded) unawaited(_save());
  }

  Future<void> _load() async {
    final store = this.store;
    if (store == null) return;
    String? text;
    try {
      text = await store.read(_key);
    } catch (_) {
      // Unreadable: nothing chosen, as on a new phone.
    }
    if (_disposed) return;
    _loaded = true;
    final (pins, folds, swarmId, seenAt, unreadOnly) = text == null
        ? (const <String>[], const <String>[], null, null, false)
        : _decode(text);
    // Chosen meanwhile: the pins pinned and cards folded join those read,
    // oldest first, those taken off or opened stay so, and a Swarm chosen
    // stands.
    void merge(Set<String> keys, List<String> read, Set<String> undone) {
      final mine = [...keys];
      keys
        ..clear()
        ..addAll(read.where((key) => !undone.contains(key)))
        ..addAll(mine);
    }

    merge(_pins, pins, _unpinned);
    merge(_folds, folds, _unfolded);
    if (!_shownChosen) _swarmId = swarmId;
    if (!_unreadChosen) _unreadOnly = unreadOnly;
    // Left meanwhile: the later time stands.
    if (seenAt != null && seenAt.isAfter(_seenAt ?? DateTime(0))) {
      _seenAt = seenAt;
    }
    _unpinned.clear();
    _unfolded.clear();
    // Swarms the account lost meanwhile take what was read of them too.
    final kept = _swarms;
    final dropped = kept != null && _keep(kept);
    if (_cap() || dropped || _touched) unawaited(_save());
    notifyListeners();
  }

  /// What was kept: written before folds were, it has none; before the
  /// unread filter, it is off.
  static (List<String>, List<String>, String?, DateTime?, bool) _decode(
    String text,
  ) {
    List<String> keys(Object? list) => [
      for (final key in list is List ? list : const [])
        if (key is String && key.contains('/')) key,
    ];
    try {
      final json = jsonDecode(text);
      if (json is! Map) return (const [], const [], null, null, false);
      return (
        keys(json['pins']),
        keys(json['folded']),
        json['swarm'] is String ? json['swarm'] as String : null,
        switch (json['seen']) {
          final int ms when ms > 0 => DateTime.fromMillisecondsSinceEpoch(ms),
          _ => null,
        },
        json['unread'] == true,
      );
    } on FormatException {
      return (const [], const [], null, null, false);
    }
  }

  Future<void> _save() async {
    final store = this.store;
    if (store == null) return;
    try {
      if (_pins.isEmpty &&
          _folds.isEmpty &&
          _swarmId == null &&
          _seenAt == null &&
          !_unreadOnly) {
        await store.delete(_key);
      } else {
        await store.write(
          _key,
          jsonEncode({
            'pins': [..._pins],
            if (_folds.isNotEmpty) 'folded': [..._folds],
            'swarm': ?_swarmId,
            'seen': ?_seenAt?.millisecondsSinceEpoch,
            if (_unreadOnly) 'unread': true,
          }),
        );
      }
    } catch (_) {
      // Kept in memory; written with the next choice.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
