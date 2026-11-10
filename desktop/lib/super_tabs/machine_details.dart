import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/engine_identity.dart';
import 'detail_dialog.dart';

/// Full machine context behind the sidebar's compact, live readings.
class SuperTabMachineDetails extends StatelessWidget {
  const SuperTabMachineDetails({
    super.key,
    required this.name,
    required this.status,
    this.owner,
    this.resources,
    this.engines,
    this.footer,
  });

  final String name, status;
  final String? owner;
  final MachineResources? resources;
  final List<String>? engines;

  /// Below the details, inside the same scroll: what a Swarm adds about the machine (its local models).
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final value = resources;
    final diskTotal = value?.projectDiskTotalBytes ?? value?.diskTotalBytes;
    final diskFree = value?.projectDiskTotalBytes == null
        ? value?.diskFreeBytes
        : value?.projectDiskFreeBytes;
    final memoryFree =
        value?.memoryTotalBytes == null || value?.memoryUsedBytes == null
        ? null
        : (value!.memoryTotalBytes! - value.memoryUsedBytes!).clamp(
            0,
            value.memoryTotalBytes!,
          );
    String free(double used) => resourcePercent((100 - used).clamp(0, 100));
    String capacity(double available, double? total) =>
        '${resourceBytes(available)}${total == null ? '' : ' of ${resourceBytes(total)}'}';
    final readings = [
      if (value?.cpuPercent case final cpu?) ('CPU', free(cpu)),
      if (value?.busiestGpu?.utilizationPercent case final gpu?)
        ('GPU', free(gpu)),
      if (memoryFree != null)
        ('RAM', capacity(memoryFree.toDouble(), value?.memoryTotalBytes)),
      if (diskFree != null) ('SSD', capacity(diskFree, diskTotal)),
    ];
    final hardware = [
      ('Computer', name),
      if (value?.deviceType case final device?) ('Device', device),
      if (value?.chip case final chip?) ('Chip', chip),
      if (value?.os case final os?) ('System', os),
      for (final gpu in value?.gpus ?? const <MachineGpu>[])
        if (gpu.id != 'observed') ('Graphics', gpu.name),
      if (engines?.isNotEmpty == true)
        ('Engines', engines!.map((e) => engineIdentity(e).label).join(', ')),
    ];
    return SelectionArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (owner case final email?)
            SuperTabDetailRow(label: 'Owner', value: email),
          SuperTabDetailRow(label: 'Status', value: status),
          if (readings.isNotEmpty)
            SuperTabDetailSection(
              title: 'Available capacity',
              children: [
                for (final reading in readings)
                  SuperTabDetailRow(label: reading.$1, value: reading.$2),
              ],
            ),
          SuperTabDetailSection(
            title: 'Details',
            children: [
              for (final detail in hardware)
                SuperTabDetailRow(label: detail.$1, value: detail.$2),
            ],
          ),
          ?footer,
        ],
      ),
    );
  }
}
