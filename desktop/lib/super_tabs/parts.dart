import 'package:collection/collection.dart' show DeepCollectionEquality;

import 'model.dart';

/// The response shape a Swarm read answers in (docs/design/2026-10-26-swarm-state-parts.md, section 4), mirrored by
/// hand from backend `superTabs/read/contract.ts` (final at cd004bf5c). A first load of any other format is from a
/// backend this build cannot read.
const superTabReadFormat = 2;

/// The part lists a first load and a change read carry, by their names there. The head is a single part.
const _lists = [
  'members',
  'agents',
  'groups',
  'machines',
  'starts',
  'progress',
];

/// What one change read or dormant page did to the store.
class SuperTabPartsChange {
  const SuperTabPartsChange({
    required this.changed,
    this.removedGroups = const {},
    this.dormantGroups = const {},
    this.readMarksOnly = false,
  });

  /// Some part or a derived value is new: what the screens draw may differ.
  final bool changed;

  /// Groups whose part was deleted: nothing of them stays on this device.
  final Set<String> removedGroups;

  /// Groups that left the active set: they stay readable on demand.
  final Set<String> dormantGroups;

  /// Only the reader's read marks moved: the page around the view, not what a saved view holds.
  final bool readMarksOnly;
}

/// The parts of one Swarm as this reader last saw them (section 5.1): every part by kind and key at the newest
/// version read, the values worked out at read time (`derived`), and where the next change read starts. The screens
/// keep reading the old whole-Swarm shape, which [state] builds from the parts.
class SuperTabParts {
  SuperTabParts._(
    this._head,
    this._derived, {
    required this.cursor,
    required this.epoch,
    required this.lastChangedAt,
    required this.githubApp,
  });

  /// A first load (section 4.3). Throws a [FormatException] for a response of another format.
  factory SuperTabParts.firstLoad(Map<String, dynamic> answer) {
    if (answer['format'] != superTabReadFormat) {
      throw const FormatException('Update Harness to open this Swarm.');
    }
    // Read marks are held apart from the other derived values (_readMarks).
    final derived = Map.of(superTabMap(answer['derived'] ?? const {}));
    final marks = derived.remove('readMarks');
    final parts = SuperTabParts._(
      _envelope(answer['head'], live: true),
      derived,
      cursor: _cursor(answer),
      epoch: _int(answer['epoch']),
      // Null for a Swarm with no part changed yet (contract.ts `ReadMeta`).
      lastChangedAt: _int(answer['lastChangedAt'] ?? 0),
      githubApp: answer['githubApp'] == true,
    );
    parts._seen['head'] = _int(parts._head['version']);
    for (final kind in _lists) {
      final held = parts._live[kind] = <String, Map<String, dynamic>>{};
      for (final raw in answer[kind] as List? ?? const []) {
        final part = _envelope(raw, live: true);
        held[part['key'] as String] = part;
        parts._seen['$kind:${part['key']}'] = _int(part['version']);
      }
    }
    parts._takeReadMarks(marks);
    return parts;
  }

  /// What [toJson] kept, or a [FormatException] for anything else.
  factory SuperTabParts.fromJson(Map<String, dynamic> json) {
    final parts = SuperTabParts.firstLoad(superTabMap(json['load']));
    for (final raw in json['dormant'] as List? ?? const []) {
      final part = _envelope(raw, live: true);
      parts._dormant[part['key'] as String] = part;
    }
    parts._stale.addAll(
      (json['stale'] as List? ?? const []).whereType<String>(),
    );
    final seen = json['seen'];
    if (seen is Map) {
      for (final entry in seen.entries) {
        if (entry.key is String && entry.value is num) {
          parts._seen[entry.key as String] = (entry.value as num).toInt();
        }
      }
    }
    parts._takeReadMarks(json['readMarks']);
    return parts;
  }

  /// Where the next change read starts: opaque, the server's (section 4.2).
  String cursor;

  /// The visibility epoch of the last read. The server answers a change read with a reload when it moves.
  int epoch;

  /// The newest change of any part, in epoch milliseconds (spec ruling 8): what tells a list or a cache that this
  /// Swarm changed. 0 before any part changed.
  int lastChangedAt;

  /// Whether the backend has the GitHub app, as the first load says.
  final bool githubApp;

  Map<String, dynamic> _head;
  Map<String, dynamic> _derived;
  final _live = <String, Map<String, Map<String, dynamic>>>{};

  /// Groups out of the active set whose data this reader has: read on demand, or held when they went dormant.
  final _dormant = <String, Map<String, dynamic>>{};

  /// The newest version seen of every part, deleted and dormant ones included: an older copy the overlap sends
  /// again never replaces it or brings it back (section 4.4).
  final _seen = <String, int>{};

  /// The reader's own read marks by conversation (backend readMarks.ts), the highest each read sent: a first load
  /// sends them all, a change read only those moved since its cursor.
  final _readMarks = <String, int>{};

  /// Keeps the higher of each mark in [marks] and the one held; whether any moved.
  bool _takeReadMarks(Object? marks) {
    var moved = false;
    if (marks is! Map) return moved;
    for (final MapEntry(:key, :value) in marks.entries) {
      if (key is! String || value is! num) continue;
      if ((_readMarks[key] ?? 0) >= value) continue;
      _readMarks[key] = value.toInt();
      moved = true;
    }
    return moved;
  }

  /// Dormant groups held with their data from before a stub closed them: a read by id at the stub's version is
  /// their current data.
  final _stale = <String>{};

  /// The values worked out at read time, as the last read sent them.
  Map<String, dynamic> get derived => _derived;

  /// Whether this reader holds group [groupId], active or dormant.
  bool holdsGroup(String groupId) =>
      _live['groups']?.containsKey(groupId) == true ||
      _dormant.containsKey(groupId);

  /// Dormant groups held with data from before a stub closed them, to read again by id.
  List<String> get staleGroups => _stale.toList();

  /// Keeps [groupId]'s held data as it is: it cannot be read again.
  void forgetStale(String groupId) => _stale.remove(groupId);

  /// Whether [groupId] is a dormant group this reader holds.
  bool isDormant(String groupId) => _dormant.containsKey(groupId);

  /// Merges one change read (section 4.4): a higher version wins, a tombstone removes the part, a dormant stub moves
  /// the group out of the active ones, `derived` is replaced, and the cursor moves. A reload answer is the caller's.
  SuperTabPartsChange apply(Map<String, dynamic> changes) {
    var changed = false;
    final removed = <String>{}, dormant = <String>{};
    if (changes['head'] != null) {
      final head = _envelope(changes['head'], live: true);
      if (_newer('head', head)) {
        _head = head;
        changed = true;
      }
    }
    for (final kind in _lists) {
      final held = _live.putIfAbsent(kind, () => {});
      for (final raw in changes[kind] as List? ?? const []) {
        final part = _envelope(raw, live: false);
        final key = part['key'] as String;
        if (!_newer('$kind:$key', part)) continue;
        changed = true;
        if (part['deleted'] == true) {
          held.remove(key);
          if (kind == 'groups') {
            _dormant.remove(key);
            _stale.remove(key);
            _readMarks.remove(key);
            removed.add(key);
          }
        } else if (kind == 'groups' && part['dormant'] == true) {
          final last = held.remove(key) ?? _dormant[key];
          if (last != null) {
            _stale.add(key);
            _dormant[key] = {
              ...last,
              'version': part['version'],
              'changedAt': part['changedAt'],
              'data': {...superTabMap(last['data']), 'dormant': true},
            };
          }
          dormant.add(key);
        } else {
          if (part['data'] == null) {
            throw const FormatException('A Swarm part arrived without data.');
          }
          held[key] = part;
          if (kind == 'groups') {
            _dormant.remove(key);
            _stale.remove(key);
          }
        }
      }
    }
    final derived = Map.of(superTabMap(changes['derived'] ?? const {}));
    final marksMoved = _takeReadMarks(derived.remove('readMarks'));
    if (!const DeepCollectionEquality().equals(derived, _derived)) {
      _derived = derived;
      changed = true;
    }
    cursor = _cursor(changes);
    epoch = _int(changes['epoch'] ?? epoch);
    lastChangedAt = _int(changes['lastChangedAt'] ?? lastChangedAt);
    return SuperTabPartsChange(
      changed: changed || marksMoved,
      removedGroups: removed,
      dormantGroups: dormant,
      readMarksOnly: marksMoved && !changed,
    );
  }

  /// Takes dormant groups read on demand (section 4.5): a page of the dormant list, or one group by id. Each is kept
  /// unless this reader already holds a newer version of it; one that is active here at a lower version moves out.
  SuperTabPartsChange addDormant(List groups) {
    var changed = false;
    final active = _live.putIfAbsent('groups', () => {});
    for (final raw in groups) {
      final part = _envelope(raw, live: true);
      final key = part['key'] as String;
      final current =
          _stale.contains(key) && _int(part['version']) == _seen['groups:$key'];
      if (!current && !_newer('groups:$key', part)) continue;
      _stale.remove(key);
      changed = true;
      if (superTabMap(part['data'])['dormant'] == true) {
        active.remove(key);
        _dormant[key] = part;
      } else {
        active[key] = part;
        _dormant.remove(key);
      }
    }
    return SuperTabPartsChange(changed: changed);
  }

  /// The old whole-Swarm shape (section 5.1, "Reassemble a state"), from the head, the parts and `derived`. Active
  /// groups come first in the order they were read, then the dormant groups held.
  Map<String, dynamic> get state {
    final agentsDerived = _derivedMap('agents');
    final machinesDerived = _derivedMap('machines');
    final avatars = _derivedMap('avatars');
    final state = <String, dynamic>{
      ...superTabMap(_head['data']),
      'format': superTabReadFormat,
      'people': [
        for (final p in _data('members'))
          _avatarLink(p, avatars['person:${p['id']}']),
      ],
      'agents': [
        for (final agent in _data('agents'))
          _avatarLink(
            _overlay(
              agent,
              agentsDerived[agent['id']],
              keepNull: 'workDecision',
            ),
            avatars['agent:${agent['id']}'],
          ),
      ],
      'conversations': [
        ..._data('groups'),
        for (final part in _dormant.values) superTabMap(part['data']),
      ],
      'machines': [
        for (final machine in _data('machines'))
          _overlay(machine, machinesDerived[machine['machineId']]),
      ],
      'starts': [for (final start in _data('starts')) start],
      'githubApp': githubApp,
    };
    if (_derived['otherProjectsWork'] case final List work) {
      state['otherProjectsWork'] = work;
    }
    if (_derived['mentionsWaiting'] case final num waiting) {
      state['mentionsWaiting'] = waiting.toInt();
    }
    if (_derived['mentionsDigest'] case final String digest) {
      state['mentionsDigest'] = digest;
    }
    if (_derived['decisionsWaiting'] case final num waiting) {
      state['decisionsWaiting'] = waiting.toInt();
    }
    if (_derived['decisionsDigest'] case final String digest) {
      state['decisionsDigest'] = digest;
    }
    if (_readMarks.isNotEmpty) state['readMarks'] = Map.of(_readMarks);
    return state;
  }

  /// What to keep on this device to read the same store back ([SuperTabParts.fromJson]).
  Map<String, dynamic> toJson() => {
    'load': {
      'format': superTabReadFormat,
      'cursor': cursor,
      'epoch': epoch,
      'lastChangedAt': lastChangedAt,
      'githubApp': githubApp,
      'head': _head,
      for (final kind in _lists)
        kind: (_live[kind] ?? const {}).values.toList(),
      'derived': _derived,
    },
    'dormant': _dormant.values.toList(),
    'seen': Map<String, int>.of(_seen),
    'stale': _stale.toList(),
    'readMarks': Map<String, int>.of(_readMarks),
  };

  /// [json] (from [toJson]) without what the screens never draw: agent starts carry their tasks, and project
  /// progress is never shown. A store read back from it gets them again as they change.
  static Map<String, dynamic> drawnOnly(Map<String, dynamic> json) {
    const undrawn = {'starts', 'progress'};
    final seen = json['seen'];
    return {
      ...json,
      'load': {
        ...superTabMap(json['load']),
        for (final kind in undrawn) kind: const <dynamic>[],
      },
      'seen': {
        if (seen is Map)
          for (final entry in seen.entries)
            if (!undrawn.contains((entry.key as String).split(':').first))
              entry.key: entry.value,
      },
    };
  }

  Iterable<Map<String, dynamic>> _data(String kind) =>
      (_live[kind] ?? const {}).values.map((part) => superTabMap(part['data']));

  Map<String, dynamic> _derivedMap(String name) =>
      _derived[name] is Map ? superTabMap(_derived[name]) : const {};

  /// [record] with its uploaded avatar's signed link from this read (backend avatarLinks.ts), which never stays in a part.
  static Map<String, dynamic> _avatarLink(
    Map<String, dynamic> record,
    Object? link,
  ) {
    final avatar = record['avatar'];
    final uploaded =
        link is String && avatar is Map && avatar['kind'] == 'upload';
    if (!uploaded) return record;
    return {
      ...record,
      'avatar': {...avatar, 'url': link},
    };
  }

  /// [record] with the derived values over it. A null [keepNull] value means the stored one stands.
  static Map<String, dynamic> _overlay(
    Map<String, dynamic> record,
    Object? derived, {
    String? keepNull,
  }) {
    if (derived is! Map) return record;
    final next = {...record};
    for (final entry in derived.entries) {
      if (entry.key == keepNull && entry.value == null) continue;
      next[entry.key as String] = entry.value;
    }
    return next;
  }

  /// Whether [part] is newer than what was seen of [id], recording it when it is.
  bool _newer(String id, Map<String, dynamic> part) {
    final version = _int(part['version']);
    final seen = _seen[id];
    if (seen != null && version <= seen) return false;
    _seen[id] = version;
    return true;
  }

  static Map<String, dynamic> _envelope(Object? raw, {required bool live}) {
    final part = superTabMap(raw);
    if (part['key'] is! String || part['version'] is! num) {
      throw const FormatException('Invalid Swarm part.');
    }
    if (live && part['data'] is! Map) {
      throw const FormatException('A Swarm part arrived without data.');
    }
    return part;
  }

  static String _cursor(Map<String, dynamic> answer) =>
      answer['cursor'] is String
      ? answer['cursor'] as String
      : throw const FormatException('Missing Swarm cursor.');

  static int _int(Object? value) => value is num
      ? value.toInt()
      : throw const FormatException('Invalid Swarm read.');
}
