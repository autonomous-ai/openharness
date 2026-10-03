/// Optional process readings from the session's owning machine. Unknown is
/// never zero; memory is resident bytes including child processes, not private
/// physical RAM. CPU is interval use, with 100% representing one core.
class HarnessResources {
  const HarnessResources({
    this.memoryBytes,
    this.cpuPercent,
    this.processCount,
    this.gpuPercent,
    this.workspaceBytes,
    this.workspacePath,
  });
  final double? memoryBytes, cpuPercent;
  final int? processCount;
  final double? gpuPercent, workspaceBytes;
  final String? workspacePath;

  factory HarnessResources.fromJson(Map<String, dynamic> json) {
    double? number(String key) {
      final value = json[key];
      return value is num && value.isFinite && value >= 0
          ? value.toDouble()
          : null;
    }

    final count = json['processCount'];
    return HarnessResources(
      memoryBytes: number('memoryBytes'),
      cpuPercent: number('cpuPercent'),
      processCount: count is int && count >= 0 ? count : null,
      gpuPercent: number('gpuPercent'),
      workspaceBytes: number('workspaceBytes'),
      workspacePath: json['workspacePath'] is String
          ? json['workspacePath'] as String
          : null,
    );
  }

  String get label =>
      '${formatHarnessMemory(memoryBytes)} RAM · ${cpuPercent == null ? '—' : cpuPercent!.toStringAsFixed(1)}% CPU';
  static const explanation =
      'RAM includes child processes and may include shared memory. CPU: 100% is one core. Unavailable readings show —.';
}

class MachineHarnessResources {
  const MachineHarnessResources({
    required this.sampledAt,
    required this.agents,
    this.shared = const [],
  });
  final DateTime sampledAt;
  final Map<String, HarnessResources> agents;
  final List<(Set<String>, HarnessResources)> shared;

  static MachineHarnessResources? parse(Object? value) {
    if (value is! Map ||
        value['sampledAt'] is! String ||
        value['agents'] is! List) {
      return null;
    }
    final time = DateTime.tryParse(value['sampledAt'] as String);
    if (time == null) return null;
    final rows = <String, HarnessResources>{};
    for (final row in value['agents'] as List) {
      if (row is Map<String, dynamic> && row['agentId'] is String) {
        rows[row['agentId'] as String] = HarnessResources.fromJson(row);
      }
    }
    return MachineHarnessResources(
      sampledAt: time,
      agents: Map.unmodifiable(rows),
      shared: List.unmodifiable([
        if (value['shared'] is List)
          for (final row in value['shared'] as List)
            if (row is Map<String, dynamic> &&
                row['kind'] == 'codex' &&
                row['agentIds'] is List)
              (
                (row['agentIds'] as List).whereType<String>().toSet(),
                HarnessResources.fromJson(row),
              ),
      ]),
    );
  }
}

String formatHarnessMemory(double? bytes) {
  if (bytes == null) return '—';
  // Decimal units match the GB and MB labels (not GiB / MiB).
  return bytes >= 1e9
      ? '${(bytes / 1e9).toStringAsFixed(1)} GB'
      : '${(bytes / 1e6).toStringAsFixed(0)} MB';
}
