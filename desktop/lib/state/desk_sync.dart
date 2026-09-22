/// The desk: the account's tabs, the same on every computer.
///
/// The backend holds one document per user — `{ revision, tabs[] }`, each tab
/// `{ id, name, nameIsCustom?, panes: [{machineId, agentId}] }` — and changes it
/// through small idempotent ops (backend `lib/desk.ts` is the authority; the
/// copy of its rules here is for optimistic re-application only). This file is
/// the pure half: what a tab looks like on the wire, how two snapshots differ
/// as ops, and how ops apply to a snapshot. `AppNotifier` owns the other half —
/// turning `swarms` into a snapshot and a snapshot back into `swarms`.
///
/// What is NOT on the desk, by decision (owner, 2026-09-21): the active tab,
/// focus, zoom, pinned slots, presets, pane sizes, composer visibility, drafts,
/// Recently Closed, the Store tab and orchestrator tabs. Windows differ.
library;

import 'dart:math';

class DeskPaneRef {
  const DeskPaneRef({required this.machineId, required this.agentId});
  final String machineId;
  final String agentId;

  String get key => '$machineId\u0000$agentId';

  Map<String, dynamic> toJson() => {'machineId': machineId, 'agentId': agentId};

  static DeskPaneRef? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final machineId = raw['machineId'];
    final agentId = raw['agentId'];
    if (machineId is! String || machineId.isEmpty) return null;
    if (agentId is! String || agentId.isEmpty) return null;
    return DeskPaneRef(machineId: machineId, agentId: agentId);
  }

  @override
  bool operator ==(Object other) =>
      other is DeskPaneRef &&
      other.machineId == machineId &&
      other.agentId == agentId;

  @override
  int get hashCode => Object.hash(machineId, agentId);
}

/// How a tab's tiles are laid out, the same on every computer (owner,
/// 2026-09-22: "máy kia không có layout"). `presets` is pane count → the named
/// shape's id; `sizes` is the window's arrangement keys → tiles as fractions of
/// the canvas, which is what lets a window of any size draw them. Kept as the
/// wire's JSON: the window turns it into `presets`/`paneSizes` and back.
class DeskLayout {
  const DeskLayout({this.presets = const {}, this.sizes = const {}});
  final Map<String, String> presets;
  final Map<String, List<List<double>>> sizes;

  bool get isEmpty => presets.isEmpty && sizes.isEmpty;

  Map<String, dynamic> toJson() => {
    if (presets.isNotEmpty) 'presets': Map<String, String>.from(presets),
    if (sizes.isNotEmpty)
      'sizes': {
        for (final e in sizes.entries)
          e.key: [
            for (final tile in e.value) [...tile],
          ],
      },
  };

  static DeskLayout? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final presets = <String, String>{};
    if (raw['presets'] is Map) {
      for (final e in (raw['presets'] as Map).entries) {
        if (e.key is String && e.value is String) presets[e.key] = e.value;
      }
    }
    final sizes = <String, List<List<double>>>{};
    if (raw['sizes'] is Map) {
      for (final e in (raw['sizes'] as Map).entries) {
        if (e.key is! String || e.value is! List) continue;
        final tiles = <List<double>>[];
        for (final tile in e.value as List) {
          if (tile is! List || tile.length != 4 || tile.any((v) => v is! num)) {
            tiles.clear();
            break;
          }
          tiles.add([for (final v in tile) (v as num).toDouble()]);
        }
        if (tiles.isNotEmpty) sizes[e.key] = tiles;
      }
    }
    return DeskLayout(presets: presets, sizes: sizes);
  }

  /// The comparison the diff makes: the JSON, key order fixed.
  String get fingerprint => _canonical(toJson());

  static String _canonical(Object? value) {
    if (value is Map) {
      final keys = value.keys.map((k) => k.toString()).toList()..sort();
      return '{${keys.map((k) => '$k:${_canonical(value[k])}').join(',')}}';
    }
    if (value is List) return '[${value.map(_canonical).join(',')}]';
    return '$value';
  }
}

class DeskTab {
  const DeskTab({
    required this.id,
    required this.name,
    this.nameIsCustom = false,
    this.panes = const [],
    this.layout,
  });
  final String id;
  final String name;
  final bool nameIsCustom;
  final List<DeskPaneRef> panes;
  final DeskLayout? layout;

  DeskTab copyWith({
    String? name,
    bool? nameIsCustom,
    List<DeskPaneRef>? panes,
    DeskLayout? layout,
  }) => DeskTab(
    id: id,
    name: name ?? this.name,
    nameIsCustom: nameIsCustom ?? this.nameIsCustom,
    panes: panes ?? this.panes,
    layout: layout ?? this.layout,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    if (nameIsCustom) 'nameIsCustom': true,
    'panes': [for (final p in panes) p.toJson()],
    if (layout != null && !layout!.isEmpty) 'layout': layout!.toJson(),
  };

  static DeskTab? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final name = raw['name'];
    if (id is! String || id.isEmpty || name is! String) return null;
    final panes = <DeskPaneRef>[];
    final seen = <String>{};
    if (raw['panes'] is List) {
      for (final item in raw['panes'] as List) {
        final pane = DeskPaneRef.fromJson(item);
        if (pane != null && seen.add(pane.key)) panes.add(pane);
      }
    }
    return DeskTab(
      id: id,
      name: name,
      nameIsCustom: raw['nameIsCustom'] == true,
      panes: panes,
      layout: DeskLayout.fromJson(raw['layout']),
    );
  }
}

String _layoutFingerprint(DeskLayout? layout) =>
    layout == null || layout.isEmpty ? '' : layout.fingerprint;

class DeskDoc {
  const DeskDoc({required this.revision, required this.tabs});
  final int revision;
  final List<DeskTab> tabs;

  static DeskDoc? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final revision = raw['revision'];
    if (revision is! int) return null;
    final tabs = <DeskTab>[];
    final seen = <String>{};
    if (raw['tabs'] is List) {
      for (final item in raw['tabs'] as List) {
        final tab = DeskTab.fromJson(item);
        if (tab != null && seen.add(tab.id)) tabs.add(tab);
      }
    }
    return DeskDoc(revision: revision, tabs: tabs);
  }
}

/// A desk id: a tab that has been on the desk (or is bound for it) carries a
/// random 128-bit id, never the per-window `swarm-N` two computers would both
/// mint. `isDeskId` is how a restored layout from before the desk is told apart.
String newDeskId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

final _deskIdShape = RegExp(r'^[0-9a-f]{32}$');
bool isDeskId(String id) => _deskIdShape.hasMatch(id);

/// The ops that turn [before] into [after], in an order the backend applies
/// left to right: closes first, then creates, then renames and pane changes,
/// then order. Names are compared only where the person named the tab —
/// a derived name is each window's own to derive.
List<Map<String, dynamic>> deskDiff(List<DeskTab> before, List<DeskTab> after) {
  final ops = <Map<String, dynamic>>[];
  final beforeById = {for (final t in before) t.id: t};
  final afterById = {for (final t in after) t.id: t};

  for (final old in before) {
    if (!afterById.containsKey(old.id)) {
      ops.add({'op': 'tab.close', 'id': old.id});
    }
  }
  for (var i = 0; i < after.length; i++) {
    final tab = after[i];
    if (beforeById.containsKey(tab.id)) continue;
    ops.add({
      'op': 'tab.create',
      'id': tab.id,
      'name': tab.name,
      if (tab.nameIsCustom) 'nameIsCustom': true,
      'index': i,
    });
    for (var j = 0; j < tab.panes.length; j++) {
      ops.add({
        'op': 'pane.add',
        'tabId': tab.id,
        ...tab.panes[j].toJson(),
        'index': j,
      });
    }
    if (tab.layout != null && !tab.layout!.isEmpty) {
      ops.add({
        'op': 'tab.layout',
        'id': tab.id,
        'layout': tab.layout!.toJson(),
      });
    }
  }
  for (final tab in after) {
    final old = beforeById[tab.id];
    if (old == null) continue;
    if (tab.nameIsCustom && (tab.name != old.name || !old.nameIsCustom)) {
      ops.add({
        'op': 'tab.rename',
        'id': tab.id,
        'name': tab.name,
        'nameIsCustom': true,
      });
    }
    // The layout travels whole: one drag on this computer is the layout on the others.
    if (_layoutFingerprint(tab.layout) != _layoutFingerprint(old.layout)) {
      ops.add({
        'op': 'tab.layout',
        'id': tab.id,
        'layout': (tab.layout ?? const DeskLayout()).toJson(),
      });
    }
    final oldKeys = old.panes.map((p) => p.key).toSet();
    final newKeys = tab.panes.map((p) => p.key).toSet();
    for (final p in old.panes) {
      if (!newKeys.contains(p.key)) {
        ops.add({'op': 'pane.remove', 'tabId': tab.id, ...p.toJson()});
      }
    }
    for (var j = 0; j < tab.panes.length; j++) {
      final p = tab.panes[j];
      if (!oldKeys.contains(p.key)) {
        ops.add({'op': 'pane.add', 'tabId': tab.id, ...p.toJson(), 'index': j});
      }
    }
    // Order among the panes both sides have: move the ones out of place.
    final kept = old.panes
        .where((p) => newKeys.contains(p.key))
        .map((p) => p.key)
        .toList();
    final wanted = tab.panes
        .where((p) => oldKeys.contains(p.key))
        .map((p) => p.key)
        .toList();
    if (!_sameOrder(kept, wanted)) {
      for (var j = 0; j < tab.panes.length; j++) {
        if (oldKeys.contains(tab.panes[j].key)) {
          ops.add({
            'op': 'pane.move',
            'tabId': tab.id,
            ...tab.panes[j].toJson(),
            'index': j,
          });
        }
      }
    }
  }
  // Tab order, over the tabs both sides have.
  final keptTabs = before
      .where((t) => afterById.containsKey(t.id))
      .map((t) => t.id)
      .toList();
  final wantedTabs = after
      .where((t) => beforeById.containsKey(t.id))
      .map((t) => t.id)
      .toList();
  if (!_sameOrder(keptTabs, wantedTabs)) {
    for (var i = 0; i < after.length; i++) {
      if (beforeById.containsKey(after[i].id)) {
        ops.add({'op': 'tab.move', 'id': after[i].id, 'index': i});
      }
    }
  }
  return ops;
}

bool _sameOrder(List<String> a, List<String> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// The backend's rules, replayed here so a window can lay its unacknowledged
/// ops over a document that arrived meanwhile. Idempotent; an op on a tab
/// that is gone changes nothing.
List<DeskTab> applyDeskOps(List<DeskTab> tabs, List<Map<String, dynamic>> ops) {
  var next = [
    for (final t in tabs) t.copyWith(panes: [...t.panes]),
  ];
  int at(String id) => next.indexWhere((t) => t.id == id);
  int clamp(Object? index, int length) =>
      index is int ? index.clamp(0, length) : length;
  for (final op in ops) {
    switch (op['op']) {
      case 'tab.create':
        final id = op['id'] as String;
        if (at(id) >= 0) break;
        next.insert(
          clamp(op['index'], next.length),
          DeskTab(
            id: id,
            name: op['name'] as String,
            nameIsCustom: op['nameIsCustom'] == true,
            panes: [],
          ),
        );
      case 'tab.close':
        final i = at(op['id'] as String);
        if (i >= 0) next.removeAt(i);
      case 'tab.rename':
        final i = at(op['id'] as String);
        if (i < 0) break;
        next[i] = next[i].copyWith(
          name: op['name'] as String,
          nameIsCustom: op['nameIsCustom'] == true || next[i].nameIsCustom,
        );
      case 'tab.move':
        final i = at(op['id'] as String);
        if (i < 0) break;
        final tab = next.removeAt(i);
        next.insert(clamp(op['index'], next.length), tab);
      case 'pane.add':
        final i = at(op['tabId'] as String);
        if (i < 0) break;
        final pane = DeskPaneRef.fromJson(op);
        if (pane == null || next[i].panes.contains(pane)) break;
        next[i].panes.insert(clamp(op['index'], next[i].panes.length), pane);
      case 'pane.remove':
        final i = at(op['tabId'] as String);
        if (i < 0) break;
        final pane = DeskPaneRef.fromJson(op);
        if (pane != null) next[i].panes.remove(pane);
      case 'pane.move':
        final i = at(op['tabId'] as String);
        if (i < 0) break;
        final pane = DeskPaneRef.fromJson(op);
        if (pane == null) break;
        final j = next[i].panes.indexOf(pane);
        if (j < 0) break;
        next[i].panes.removeAt(j);
        next[i].panes.insert(clamp(op['index'], next[i].panes.length), pane);
      case 'tab.layout':
        final i = at(op['id'] as String);
        if (i < 0) break;
        next[i] = next[i].copyWith(
          layout: DeskLayout.fromJson(op['layout']) ?? const DeskLayout(),
        );
      case 'seed':
        for (final raw in (op['tabs'] as List? ?? const [])) {
          final tab = DeskTab.fromJson(raw);
          if (tab == null || at(tab.id) >= 0) continue;
          next.add(tab.copyWith(panes: [...tab.panes]));
        }
    }
  }
  return next;
}

/// What a window holds about its sync with the desk: the last snapshot it and
/// the desk agreed on, the ops it has sent that the desk has not yet answered,
/// and the desk's revision as last heard.
class DeskSyncState {
  int revision = 0;
  List<DeskTab> synced = const [];
  final List<Map<String, dynamic>> pending = [];
  bool enabled = false;
  bool inFlight = false;
  int failures = 0;

  void reset() {
    revision = 0;
    synced = const [];
    pending.clear();
    enabled = false;
    inFlight = false;
    failures = 0;
  }
}
