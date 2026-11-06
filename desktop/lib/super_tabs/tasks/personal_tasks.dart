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
  String? get reason => json['reason'] as String?;
  Map<String, dynamic> get agent => superTabMap(json['agent']);
  String? get agentId => agent['id'] as String?;
}

/// Lives with the parts cursor and is discarded with it on access revocation.
/// No separate timer or request; overlap versions are applied once.
class SuperTabPersonalTasks {
  bool supported = false;
  String mode = 'autoApprove';
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
    }
    for (final id in value['removed'] as List? ?? const []) {
      if (id is String && _rows.remove(id) != null) changed = true;
    }
    for (final raw in value['upserts'] as List? ?? const []) {
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
    if (changed) _ordered = null;
    return changed;
  }

  Map<String, dynamic> toJson() => {
    'approvalMode': mode, 'reset': true,
    'upserts': [for (final row in rows) row.json], 'removed': <String>[],
  };
}
