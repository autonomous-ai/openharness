import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import 'swarm_home_list.dart';

/// What [SwarmHomePrefs] read back.
typedef _SwarmHomeKept = ({
  List<String> pins,
  List<String> folds,
  List<String> aside,
  String? swarmId,
  DateTime? seenAt,
  SwarmHomeFilter filter,
  SwarmHomeSort sort,
  bool unreadsFirst,
  String? buddySwarm,
});

/// What the person chose for Swarm Home on this phone (Tony, 2026-10-29):
/// the projects pinned at its top ([pins]), the one Swarm it shows
/// ([swarmId]; none shows them all), its filter ([filter]) and how it sorts
/// ([sort], [unreadsFirst]);
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

  /// The most decisions set aside kept; the oldest goes first.
  static const keptAside = 200;

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

  /// The open decisions set aside in the person's Buddy chat with Not now,
  /// by [swarmHomeProjectKey] of their Swarm and id, oldest first: kept on this
  /// phone, as the desktop keeps them on its computer.
  final _aside = <String>{};

  /// The one Swarm Home shows; null for all of them.
  String? get swarmId => _swarmId;
  String? _swarmId;

  /// The Swarm the Buddy tab last showed, the person's latest pick among
  /// their Swarms there or on Home; null before they use one.
  String? get buddySwarmId => _buddySwarmId;
  String? _buddySwarmId;

  /// Which projects Home lists ([swarmHomeFiltered]), kept on this phone as
  /// the desktop keeps its unread filter on its computer.
  SwarmHomeFilter get filter => _filter;
  SwarmHomeFilter _filter = SwarmHomeFilter.all;

  /// How Home lays its projects out ([swarmHomeLists]).
  SwarmHomeSort get sort => _sort;
  SwarmHomeSort _sort = SwarmHomeSort.sections;

  /// Projects with something new come first in each list ([swarmHomeLists]).
  bool get unreadsFirst => _unreadsFirst;
  bool _unreadsFirst = false;

  /// Anything but what a new phone shows: the filter button's dot.
  bool get viewChanged =>
      _filter != SwarmHomeFilter.all ||
      _sort != SwarmHomeSort.sections ||
      _unreadsFirst;

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
  final _unpinned = <String>{}, _unfolded = <String>{}, _unaside = <String>{};
  bool _shownChosen = false,
      _filterChosen = false,
      _sortChosen = false,
      _unreadsChosen = false,
      _buddyChosen = false;

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

  /// Whether decision [id] of [swarmId] is set aside with Not now.
  bool decisionAside(String swarmId, String id) =>
      _aside.contains(swarmHomeProjectKey(swarmId, id));

  /// Sets decisions [ids] of [swarmId] aside, or shows them again.
  void setDecisionsAside(
    String swarmId,
    Iterable<String> ids, {
    required bool aside,
  }) {
    var moved = false;
    for (final id in ids) {
      final key = swarmHomeProjectKey(swarmId, id);
      if (!_loaded) {
        if (aside) {
          _unaside.remove(key);
        } else if (_unaside.add(key)) {
          _touched = true;
        }
      }
      moved |= aside ? _aside.add(key) : _aside.remove(key);
    }
    if (!moved) return;
    _cap();
    _changed();
  }

  /// Decisions [ids] of [swarmId] are answered: nothing keeps them aside.
  void forgetDecisionsAside(String swarmId, Iterable<String> ids) {
    final keys = [for (final id in ids) swarmHomeProjectKey(swarmId, id)];
    if (!keys.any(_aside.contains)) return;
    _aside.removeAll(keys);
    _changed();
  }

  /// Home shows Swarm [swarmId] alone; null shows them all.
  void show(String? swarmId) {
    if (!_loaded) {
      // Chosen, even if as it is: what is read back does not change it.
      _shownChosen = true;
      _touched = true;
    }
    final buddy = swarmId != null && swarmId != _buddySwarmId;
    if (buddy) _chooseBuddySwarm(swarmId);
    if (_swarmId == swarmId && !buddy) return;
    _swarmId = swarmId;
    _changed();
  }

  /// The Buddy tab shows Swarm [swarmId], from now on until another is used.
  void showBuddy(String swarmId) {
    if (_buddySwarmId == swarmId) return;
    _chooseBuddySwarm(swarmId);
    _changed();
  }

  void _chooseBuddySwarm(String swarmId) {
    if (!_loaded) _buddyChosen = true;
    _buddySwarmId = swarmId;
  }

  /// Home lists the projects [filter] lets through.
  void setFilter(SwarmHomeFilter filter) {
    if (!_loaded) {
      // Chosen, even if as it is: what is read back does not change it.
      _filterChosen = true;
      _touched = true;
    }
    if (_filter == filter) return;
    _filter = filter;
    _changed();
  }

  /// Home lays its projects out by [sort].
  void setSort(SwarmHomeSort sort) {
    if (!_loaded) {
      _sortChosen = true;
      _touched = true;
    }
    if (_sort == sort) return;
    _sort = sort;
    _changed();
  }

  /// Projects with something new come first ([on]), or stay in order.
  void setUnreadsFirst(bool on) {
    if (!_loaded) {
      _unreadsChosen = true;
      _touched = true;
    }
    if (_unreadsFirst == on) return;
    _unreadsFirst = on;
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
    final before = _pins.length + _folds.length + _aside.length;
    bool other(String key) => !swarmIds.contains(key.split('/').first);
    _pins.removeWhere(other);
    _folds.removeWhere(other);
    _aside.removeWhere(other);
    final gone = _swarmId != null && !swarmIds.contains(_swarmId);
    if (gone) _swarmId = null;
    final buddyGone =
        _buddySwarmId != null && !swarmIds.contains(_buddySwarmId);
    if (buddyGone) _buddySwarmId = null;
    return gone ||
        buddyGone ||
        _pins.length + _folds.length + _aside.length != before;
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

    final pins = trim(_pins, keptPins), aside = trim(_aside, keptAside);
    return trim(_folds, keptFolds) || pins || aside;
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
    final read = text == null ? _nothingKept : _decode(text);
    final (pins, folds, swarmId, seenAt) = (
      read.pins,
      read.folds,
      read.swarmId,
      read.seenAt,
    );
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
    merge(_aside, read.aside, _unaside);
    if (!_shownChosen) _swarmId = swarmId;
    if (!_filterChosen) _filter = read.filter;
    if (!_sortChosen) _sort = read.sort;
    if (!_unreadsChosen) _unreadsFirst = read.unreadsFirst;
    if (!_buddyChosen) _buddySwarmId = read.buddySwarm;
    // Left meanwhile: the later time stands.
    if (seenAt != null && seenAt.isAfter(_seenAt ?? DateTime(0))) {
      _seenAt = seenAt;
    }
    _unpinned.clear();
    _unfolded.clear();
    _unaside.clear();
    // Swarms the account lost meanwhile take what was read of them too.
    final kept = _swarms;
    final dropped = kept != null && _keep(kept);
    if (_cap() || dropped || _touched) unawaited(_save());
    notifyListeners();
  }

  /// What a new phone has.
  static const _SwarmHomeKept _nothingKept = (
    pins: [],
    folds: [],
    aside: [],
    swarmId: null,
    seenAt: null,
    filter: SwarmHomeFilter.all,
    sort: SwarmHomeSort.sections,
    unreadsFirst: false,
    buddySwarm: null,
  );

  /// What was kept: written before folds were, it has none; before the
  /// filter's menu, `unread` alone says the filter is on Unread, as it still
  /// does, so an older build reads it. A value this build does not know reads
  /// as the default.
  static _SwarmHomeKept _decode(String text) {
    List<String> keys(Object? list) => [
      for (final key in list is List ? list : const [])
        if (key is String && key.contains('/')) key,
    ];
    try {
      final json = jsonDecode(text);
      if (json is! Map) return _nothingKept;
      return (
        pins: keys(json['pins']),
        folds: keys(json['folded']),
        aside: keys(json['aside']),
        swarmId: json['swarm'] is String ? json['swarm'] as String : null,
        seenAt: switch (json['seen']) {
          final int ms when ms > 0 => DateTime.fromMillisecondsSinceEpoch(ms),
          _ => null,
        },
        filter: json['filter'] == 'mentions'
            ? SwarmHomeFilter.mentions
            : json['unread'] == true
            ? SwarmHomeFilter.unread
            : SwarmHomeFilter.all,
        sort: json['sort'] == 'newest'
            ? SwarmHomeSort.newest
            : SwarmHomeSort.sections,
        unreadsFirst: json['unreadsFirst'] == true,
        buddySwarm: json['buddySwarm'] is String
            ? json['buddySwarm'] as String
            : null,
      );
    } on FormatException {
      return _nothingKept;
    }
  }

  Future<void> _save() async {
    final store = this.store;
    if (store == null) return;
    try {
      if (_pins.isEmpty &&
          _folds.isEmpty &&
          _aside.isEmpty &&
          _swarmId == null &&
          _buddySwarmId == null &&
          _seenAt == null &&
          !viewChanged) {
        await store.delete(_key);
      } else {
        await store.write(
          _key,
          jsonEncode({
            'pins': [..._pins],
            if (_folds.isNotEmpty) 'folded': [..._folds],
            if (_aside.isNotEmpty) 'aside': [..._aside],
            'swarm': ?_swarmId,
            'buddySwarm': ?_buddySwarmId,
            'seen': ?_seenAt?.millisecondsSinceEpoch,
            if (_filter == SwarmHomeFilter.unread) 'unread': true,
            if (_filter == SwarmHomeFilter.mentions) 'filter': 'mentions',
            if (_sort == SwarmHomeSort.newest) 'sort': 'newest',
            if (_unreadsFirst) 'unreadsFirst': true,
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
