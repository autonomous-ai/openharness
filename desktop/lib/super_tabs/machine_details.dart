import 'package:flutter/material.dart';

import '../core/machine_resources.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import '../widgets/engine_identity.dart';
import '../widgets/workspace_subscription_usage.dart';

/// Full machine context behind the sidebar's compact, live readings.
class SuperTabMachineDetails extends StatelessWidget {
  const SuperTabMachineDetails({
    super.key,
    required this.name,
    required this.status,
    required this.accounts,
    this.owner,
    this.resources,
    this.cwd,
    this.engines,
    this.footer,
  });

  final String name, status;
  final String? owner, cwd;
  final MachineResources? resources;
  final List<String>? engines;
  final List<Map<String, Object?>> accounts;

  /// Below the details, inside the same scroll: what a Swarm adds about the machine (its local models).
  final Widget? footer;

  Widget _row(String label, String value, {required bool stacked}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: stacked
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(label, style: DesktopChrome.metadata()),
              const SizedBox(height: 2),
              Text(value, style: DesktopChrome.control()),
            ],
          )
        : Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 104,
                child: Text(label, style: DesktopChrome.metadata()),
              ),
              const SizedBox(width: 16),
              Expanded(child: Text(value, style: DesktopChrome.control())),
            ],
          ),
  );

  Widget _section(String title, List<Widget> children) => Padding(
    padding: const EdgeInsets.only(top: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: DesktopChrome.control(medium: true)),
        const SizedBox(height: 8),
        ...children,
      ],
    ),
  );

  Widget _allowance(
    WorkspaceSubscriptionAccount account,
    Map<String, Object?> row,
    bool stacked,
  ) {
    final details = (row['details'] as List? ?? const []).whereType<String>();
    final accountName = row['account'] as String?;
    final figure = Text(
      '${account.figure} left',
      style: DesktopChrome.control(
        medium: true,
        color: account.ink(DesktopChrome.foreground, DesktopChrome.surface),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              EngineMark(engine: account.engine, size: 16),
              const SizedBox(width: 8),
              Expanded(
                child: Text(account.name, style: DesktopChrome.control()),
              ),
              if (!stacked) ...[const SizedBox(width: 12), figure],
            ],
          ),
          if (stacked)
            Padding(padding: const EdgeInsets.only(top: 4), child: figure),
          if (accountName?.isNotEmpty == true)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(accountName!, style: DesktopChrome.metadata()),
            ),
          for (final detail in details)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                detail.replaceAll(' · resets in ', '\nResets in '),
                style: DesktopChrome.metadata(),
              ),
            ),
        ],
      ),
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
      if (cwd case final path?) ('Project folder', path),
      if (engines?.isNotEmpty == true)
        ('Engines', engines!.map((e) => engineIdentity(e).label).join(', ')),
    ];
    return SizedBox(
      width: 400,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final stacked =
              constraints.maxWidth < 320 ||
              MediaQuery.textScalerOf(context).scale(13) > 20;
          return DesktopPromptScrollBody(
            child: SelectionArea(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (owner case final email?)
                    _row('Owner', email, stacked: stacked),
                  _row('Status', status, stacked: stacked),
                  if (readings.isNotEmpty)
                    _section('Available capacity', [
                      for (final reading in readings)
                        _row(reading.$1, reading.$2, stacked: stacked),
                    ]),
                  if (knownAccounts.isNotEmpty)
                    _section('Model allowances', [
                      for (final entry in knownAccounts)
                        _allowance(entry.$1, entry.$2, stacked),
                    ]),
                  _section('Details', [
                    for (final detail in hardware)
                      _row(detail.$1, detail.$2, stacked: stacked),
                  ]),
                  ?footer,
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
