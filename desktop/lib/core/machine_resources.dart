/// Optional host readings from a linked machine, never inferred from harness activity.
class MachineResources {
  const MachineResources({
    this.cpuPercent,
    this.memoryUsedBytes,
    this.memoryTotalBytes,
    this.memoryPressure,
    this.swapUsedBytes,
    this.diskFreeBytes,
    this.diskTotalBytes,
    this.gpus = const [],
  });

  final double? cpuPercent, memoryUsedBytes, memoryTotalBytes;
  final String? memoryPressure;
  final double? swapUsedBytes, diskFreeBytes, diskTotalBytes;
  final List<MachineGpu> gpus;

  double? get memoryPercent =>
      memoryUsedBytes != null &&
          memoryTotalBytes != null &&
          memoryTotalBytes! > 0
      ? memoryUsedBytes! / memoryTotalBytes! * 100
      : null;

  MachineGpu? get busiestGpu {
    MachineGpu? result;
    for (final gpu in gpus) {
      if (gpu.utilizationPercent != null &&
          (result == null ||
              gpu.utilizationPercent! > result.utilizationPercent!)) {
        result = gpu;
      }
    }
    return result;
  }

  factory MachineResources.fromJson(Map<String, dynamic> json) {
    double? number(String key) {
      final value = json[key];
      return value is num && value.isFinite && value >= 0
          ? value.toDouble()
          : null;
    }

    final cpu = number('cpuPercent');
    final used = number('memoryUsedBytes');
    final total = number('memoryTotalBytes');
    final memoryValid =
        used != null && total != null && total > 0 && used <= total;
    final diskFree = number('diskFreeBytes'),
        diskTotal = number('diskTotalBytes');
    final diskValid =
        diskFree != null &&
        diskTotal != null &&
        diskTotal > 0 &&
        diskFree <= diskTotal;
    final pressure = json['memoryPressure'];
    return MachineResources(
      cpuPercent: cpu != null && cpu <= 100 ? cpu : null,
      memoryUsedBytes: memoryValid ? used : null,
      memoryTotalBytes: memoryValid ? total : null,
      memoryPressure: const ['normal', 'warning', 'critical'].contains(pressure)
          ? pressure as String
          : null,
      swapUsedBytes: number('swapUsedBytes'),
      diskFreeBytes: diskValid ? diskFree : null,
      diskTotalBytes: diskValid ? diskTotal : null,
      gpus: List.unmodifiable([
        if (json['gpus'] is List)
          for (final gpu in (json['gpus'] as List).take(32))
            if (gpu is Map<String, dynamic> &&
                gpu['id'] is String &&
                gpu['name'] is String)
              MachineGpu.fromJson(gpu),
      ]),
    );
  }
}

class MachineGpu {
  const MachineGpu({
    required this.id,
    required this.name,
    this.utilizationPercent,
  });
  final String id, name;
  final double? utilizationPercent;

  factory MachineGpu.fromJson(Map<String, dynamic> json) {
    final value = json['utilizationPercent'];
    return MachineGpu(
      id: json['id'] as String,
      name: json['name'] as String,
      utilizationPercent:
          value is num && value.isFinite && value >= 0 && value <= 100
          ? value.toDouble()
          : null,
    );
  }
}

String resourcePercent(double? value) =>
    value == null ? '-' : '${value.round()}%';

String resourceBytes(double? value) {
  if (value == null) return '-';
  if (value == 0) return '0 GB';
  if (value < 1000000000) return '${(value / 1000000).round()} MB';
  return '${(value / 1000000000).round()} GB';
}
