/// Optional host readings from a linked machine, never inferred from harness activity.
class MachineResources {
  const MachineResources({
    this.cpuPercent,
    this.memoryUsedBytes,
    this.memoryTotalBytes,
  });

  final double? cpuPercent, memoryUsedBytes, memoryTotalBytes;

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
    return MachineResources(
      cpuPercent: cpu != null && cpu <= 100 ? cpu : null,
      memoryUsedBytes: memoryValid ? used : null,
      memoryTotalBytes: memoryValid ? total : null,
    );
  }
}
