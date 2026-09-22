import 'dart:convert';

import 'package:collection/collection.dart' show compareNatural;
import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/models.dart';
import 'app_state.dart';

class SwarmAgentRef {
  const SwarmAgentRef(this.machine, this.agent);
  final MachineState machine;
  final Agent agent;
  String get machineId => machine.machine.machineId;
  AgentProject? get project => machine.projectOf(agent);
  String get searchText => [
    agent.displayName,
    agent.engine,
    machine.machine.displayName,
    project?.label,
    project?.name,
    project?.branch,
    project?.cwd,
  ].whereType<String>().join(' ').toLowerCase();
}

List<SwarmAgentRef> swarmAgents(AppNotifier app, [String query = '']) {
  final terms = query
      .trim()
      .toLowerCase()
      .split(RegExp(r'\s+'))
      .where((t) => t.isNotEmpty);
  final agents = [
    for (final machine in app.machineStates.values)
      for (final agent in machine.agents) SwarmAgentRef(machine, agent),
  ];
  // Catalog/group construction needs identities, not searchable strings.
  // Avoid formatting every agent's metadata just to accept an empty query.
  if (terms.isEmpty) return agents;
  return agents
      .where((entry) => terms.every(entry.searchText.contains))
      .toList();
}

class SavedSwarmProject {
  const SavedSwarmProject({
    required this.machineId,
    required this.path,
    required this.name,
    this.members = const [],
  });
  final String machineId;
  final String path;
  final String name;

  /// Explicit membership also works with daemons that predate project metadata.
  final List<({String machineId, String agentId})> members;
  String get id => '$machineId\u0000$path';
  Map<String, Object> toJson() => {
    'machineId': machineId,
    'path': path,
    'name': name,
    if (members.isNotEmpty)
      'members': [
        for (final member in members)
          {'machineId': member.machineId, 'agentId': member.agentId},
      ],
  };
}

class SwarmProjectGroup {
  SwarmProjectGroup({required this.id, required String name, this.saved})
    : _discoveredName = name;
  final String id;
  final String _discoveredName;
  // An explicitly saved folder is the user's choice of project identity/name.
  // Discovery order across checkouts must not hide it under another folder name.
  String get name => saved?.name ?? _discoveredName;
  SavedSwarmProject? saved;
  final List<SwarmAgentRef> agents = [];
}

/// Repositories group across machines only when the owning CLI reports the same
/// canonical remote. Same-named folders/branches never establish that identity.
List<SwarmProjectGroup> swarmProjects(
  AppNotifier app,
  List<SavedSwarmProject> saved,
) {
  final groups = <String, SwarmProjectGroup>{};
  final folders = <String, String>{};
  final agents = swarmAgents(app);
  final byId = {
    for (final a in agents) (machineId: a.machineId, agentId: a.agent.id): a,
  };
  for (final entry in agents) {
    final project = entry.project;
    if (project == null) continue;
    final id = project.identity(entry.machineId);
    final group = groups.putIfAbsent(
      id,
      () => SwarmProjectGroup(id: id, name: project.label),
    );
    group.agents.add(entry);
    folders['${entry.machineId}\u0000${project.cwd}'] = id;
    if (project.root != null) {
      folders['${entry.machineId}\u0000${project.root}'] = id;
    }
  }
  for (final item in saved) {
    final id = folders[item.id] ?? 'folder:${item.machineId}:${item.path}';
    final group = groups.putIfAbsent(
      id,
      () => SwarmProjectGroup(id: id, name: item.name),
    );
    group.saved = item;
    for (final member in item.members) {
      final agent = byId[member];
      if (agent != null && !group.agents.contains(agent)) {
        group.agents.add(agent);
      }
    }
  }
  return groups.values.toList()..sort(
    (a, b) => compareNatural(a.name.toLowerCase(), b.name.toLowerCase()),
  );
}

class SwarmProjectStore extends ChangeNotifier {
  SwarmProjectStore({this.storage});
  final LocalKeyValueStore? storage;
  final List<SavedSwarmProject> projects = [];
  bool _disposed = false;
  bool _loaded = false;
  Future<void>? _loadFuture;
  Future<void> _writeTail = Future.value();
  String? error;

  Future<void> load() {
    if (_loaded || _disposed) return Future.value();
    return _loadFuture ??= _read().whenComplete(() => _loadFuture = null);
  }

  Future<void> _read() async {
    try {
      final raw = await storage?.read('swarm_projects_v1');
      if (_disposed) return;
      final rows = raw == null ? const [] : jsonDecode(raw);
      if (rows is! List) throw const FormatException('Invalid project catalog');
      final loaded = <SavedSwarmProject>[];
      for (final row in rows.take(256)) {
        if (row is! Map ||
            row['machineId'] is! String ||
            row['path'] is! String ||
            row['name'] is! String) {
          continue;
        }
        final item = SavedSwarmProject(
          machineId: row['machineId'],
          path: row['path'],
          name: row['name'],
          members: {
            if (row['members'] is List)
              for (final member in (row['members'] as List).take(256))
                if (member is Map &&
                    member['machineId'] is String &&
                    member['agentId'] is String &&
                    (member['machineId'] as String).isNotEmpty &&
                    (member['agentId'] as String).isNotEmpty)
                  (
                    machineId: member['machineId'] as String,
                    agentId: member['agentId'] as String,
                  ),
          }.toList(growable: false),
        );
        if (item.path.isEmpty ||
            item.name.isEmpty ||
            loaded.any((p) => p.id == item.id)) {
          continue;
        }
        loaded.add(item);
      }
      projects
        ..clear()
        ..addAll(loaded);
      _loaded = true;
      error = null;
    } catch (_) {
      if (_disposed) return;
      error = 'Could not load saved projects. Add the project again to retry.';
    }
    notifyListeners();
  }

  Future<bool> add(SavedSwarmProject project) {
    final operation = _writeTail.then((_) async {
      await load();
      if (_disposed || !_loaded) return false;
      final next = [
        for (final item in projects)
          if (item.id != project.id) item,
        project,
      ];
      if (next.length > 256) {
        error = 'The project list is full.';
        notifyListeners();
        return false;
      }
      try {
        await storage?.write(
          'swarm_projects_v1',
          jsonEncode(next.map((p) => p.toJson()).toList()),
        );
      } catch (_) {
        if (_disposed) return false;
        error = 'Could not save this project. Add it again to retry.';
        notifyListeners();
        return false;
      }
      if (_disposed) return false;
      projects
        ..clear()
        ..addAll(next);
      error = null;
      notifyListeners();
      return true;
    });
    _writeTail = operation.then((_) {});
    return operation;
  }

  void dismissError() {
    error = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
