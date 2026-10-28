import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/status_line_style.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/workspace_subscription_usage.dart';
import 'detail_dialog.dart';

/// Full machine context behind the sidebar's compact, live readings.
class SuperTabMachineDetails extends StatelessWidget {
  const SuperTabMachineDetails({
    super.key,
    required this.name,
    required this.status,
    required this.accounts,
    this.owner,
    this.resources,
    this.engines,
    this.footer,
  });

  final String name, status;
  final String? owner;
  final MachineResources? resources;
  final List<String>? engines;
  final List<Map<String, Object?>> accounts;

  /// Below the details, inside the same scroll: what a Swarm adds about the machine (its local models).
  final Widget? footer;

  Widget _allowance(
    WorkspaceSubscriptionAccount account,
    Map<String, Object?> row,
  ) {
    final windows = superTabAllowanceWindows(
      (row['details'] as List? ?? const []).whereType<String>(),
    );
    final accountName = row['account'] as String?;
    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              EngineMark(engine: account.engine, size: 16),
              const SizedBox(width: 8),
              Text(account.name, style: DesktopChrome.control(medium: true)),
              if (accountName?.isNotEmpty == true) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    accountName!,
                    style: DesktopChrome.metadata(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ] else
                const Spacer(),
              // Without its windows the account's one figure stands for them.
              if (windows.isEmpty) ...[
                const SizedBox(width: 12),
                Text(
                  '${account.figure} left',
                  style: DesktopChrome.control(
                    color: account.ink(
                      DesktopChrome.foreground,
                      DesktopChrome.surface,
                    ),
                  ),
                ),
              ],
            ],
          ),
          for (final window in windows)
            SuperTabDetailRow(
              label: window.window,
              value: [window.left, ?window.reset].join(' · '),
              valueStyle: DesktopChrome.control(color: _ink(window.left)),
            ),
        ],
      ),
    );
  }

  /// A window's share in the footer's colours: neutral above 20%, amber to 6%, red at 5% or less.
  static Color _ink(String left) {
    final percent = int.tryParse(left.split('%').first) ?? 100;
    return statusLineInkOnSurface(
      percent > 20
          ? DesktopChrome.foreground
          : percent <= 5
          ? grid.AppPalette.usageCritical
          : grid.AppPalette.usageLow,
      DesktopChrome.surface,
    );
  }

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
    final knownAccounts = [
      for (final row in accounts)
        for (final account in WorkspaceSubscriptionUsage.fromRows([
          row,
        ]).accounts)
          if (account.figure != '—') (account, row),
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
          if (knownAccounts.isNotEmpty)
            SuperTabDetailSection(
              title: 'Model allowances',
              children: [
                for (final entry in knownAccounts)
                  _allowance(entry.$1, entry.$2),
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

/// One window of an allowance: its name, the share left, and when it resets.
typedef SuperTabAllowanceWindow = ({String window, String left, String? reset});

/// An allowance's windows from its detail lines, in either format: another machine's
/// (`5-hour: 44% remaining · resets in 2h 10m`) or this computer's (`5-hour — 44% remaining · resets in 2h 10m`, after
/// a `Limiting window:` line, which the windows themselves already say). Other lines are left out.
List<SuperTabAllowanceWindow> superTabAllowanceWindows(Iterable<String> lines) {
  final window = RegExp(r'^(.+?)(?: — |: )(\S+%) remaining(?: · (resets in .+))?$');
  return [
    for (final line in lines)
      if (!line.startsWith('Limiting window: '))
        if (window.firstMatch(line) case final match?)
          (
            window: match.group(1)!,
            left: '${match.group(2)} left',
            reset: match.group(3),
          ),
  ];
}
