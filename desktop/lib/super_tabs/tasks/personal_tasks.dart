import '../model.dart';

/// A server-filtered summary, never a local inference about who requested work.
class SuperTabPersonalTask {
  SuperTabPersonalTask(Map<String, dynamic> row) : json = Map.unmodifiable(row);
  final Map<String, dynamic> json;
  String get id => json['id'] as String;
  int get version => (json['version'] as num).toInt();
  int get at => (json['at'] as num).toInt();
  String get projectId => json['projectId'] as String? ?? '';
  String get projectName => json['projectName'] as String? ?? 'Project';
  String get title => json['title'] as String? ?? 'Task';
  String get status => json['status'] as String? ?? 'working';
  bool get suggested => json['suggested'] == true;
  bool get canApprove => json['canApprove'] == true;
  String? get reason => json['reason'] as String?;

  /// A task nobody works on yet is sent with `agent: null`: no agent, not a
  /// malformed reply (building its row threw, and a release build drew the
  /// error as a grey box over the rest of the list).
  Map<String, dynamic> get agent =>
      json['agent'] == null ? const {} : superTabMap(json['agent']);
  String? get agentId => agent['id'] as String?;

  /// The person who asked; empty from a backend before #4203.
  Map<String, dynamic> get requester =>
      json['requester'] == null ? const {} : superTabMap(json['requester']);
  String? get requesterId => requester['id'] as String?;
  String? get pullRequestUrl => json['pullRequestUrl'] as String?;

  /// A verified release holds it: its card says Shipped (task #4547).
  bool get shipped => json['shipped'] == true;
}

/// Lives with the parts cursor and is discarded with it on access revocation.
/// No separate timer or request; overlap versions are applied once.
class SuperTabPersonalTasks {
  bool supported = false;
  String mode = 'autoApprove';

  /// Where the next older page starts; null when there is none, or the backend pages nothing.
  String? olderCursor;
  final _rows = <String, SuperTabPersonalTask>{};
  final _versions = <String, int>{};
  List<SuperTabPersonalTask>? _ordered;

  List<SuperTabPersonalTask> get rows => _ordered ??= List.unmodifiable(
    _rows.values.toList()..sort((a, b) {
      final time = b.at.compareTo(a.at);
      return time == 0 ? a.id.compareTo(b.id) : time;
    }),
  );

  bool apply(Object? value) {
    if (value is! Map) return false;
    final nextMode = value['approvalMode'];
    if (nextMode != 'autoApprove' && nextMode != 'review') {
      throw const FormatException('Update Harness to read Tasks.');
    }
    var changed = !supported || mode != nextMode;
    supported = true;
    mode = nextMode as String;
    if (value['reset'] == true) {
      changed = true;
      _rows.clear();
      _versions.clear();
      olderCursor = value['olderCursor'] as String?;
    }
    for (final id in value['removed'] as List? ?? const []) {
      if (id is String && _rows.remove(id) != null) changed = true;
    }
    if (_upsert(value['upserts'])) changed = true;
    if (changed) _ordered = null;
    return changed;
  }

  /// Adds an older page, read [from] a cursor, below the rows held, and moves [olderCursor] past it. A page read
  /// before a reset moved the cursor is dropped: its range may no longer follow the rows held.
  bool applyOlder(Object? page, {required String from}) {
    if (page is! Map || olderCursor != from) return false;
    olderCursor = page['olderCursor'] as String?;
    final changed = _upsert(page['upserts']);
    if (changed) _ordered = null;
    return changed;
  }

  bool _upsert(Object? upserts) {
    var changed = false;
    for (final raw in upserts as List? ?? const []) {
      final row = superTabMap(raw);
      if (row['id'] is! String || row['version'] is! num || row['at'] is! num) {
        throw const FormatException('Could not read a task summary.');
      }
      final task = SuperTabPersonalTask(row);
      if ((_versions[task.id] ?? -1) >= task.version) continue;
      _versions[task.id] = task.version;
      _rows[task.id] = task;
      changed = true;
    }
    return changed;
  }

  /// The row of task [id], or null when the feed holds none.
  SuperTabPersonalTask? row(String id) => _rows[id];

  Map<String, int> get versions => Map.unmodifiable(_versions);

  /// Cache tombstones share the cursor's lifetime, so its overlap stays idempotent after restart.
  void restoreVersions(Object? value) {
    if (value is! Map) return;
    for (final entry in value.entries) {
      if (entry.key is String && entry.value is num) {
        final version = (entry.value as num).toInt();
        if ((_versions[entry.key] ?? -1) < version) {
          _versions[entry.key as String] = version;
        }
      }
    }
  }

  Map<String, dynamic> toJson() => {
    'approvalMode': mode,
    'reset': true,
    'upserts': [for (final row in rows) row.json],
    'removed': <String>[],
    'olderCursor': ?olderCursor,
  };
}
