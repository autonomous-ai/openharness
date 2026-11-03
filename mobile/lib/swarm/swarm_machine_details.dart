import 'package:flutter/material.dart';

import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/app_type.dart';
import '../widgets/engine_identity.dart';
import 'model.dart';

/// The engines a machine's allowances are read for, Claude first (Desktop `machines.dart` `_chipEngines`).
const _engines = ['claude', 'codex'];

/// A reading this old is offline (Desktop `kSuperTabMachineOfflineAfter`).
const _offlineAfter = Duration(seconds: 35);

/// What a machine's reading says of its hardware, each figure checked as Desktop's `MachineResources.fromJson` checks
/// it: one out of range is no reading.
class SwarmMachineResources {
  const SwarmMachineResources({
    this.cpuPercent,
    this.gpuPercent,
    this.memoryUsedBytes,
    this.memoryTotalBytes,
    this.diskFreeBytes,
    this.diskTotalBytes,
    this.projectDiskFreeBytes,
    this.projectDiskTotalBytes,
    this.deviceType,
    this.chip,
    this.os,
  });

  factory SwarmMachineResources.read(Map<String, dynamic> json) {
    double? number(String key) => switch (json[key]) {
      final num v when v.isFinite && v >= 0 => v.toDouble(),
      _ => null,
    };
    String? label(String key) => switch (json[key]) {
      final String v when v.isNotEmpty && v.length <= 120 => v,
      _ => null,
    };
    final cpu = number('cpuPercent'), gpu = number('gpuPercent');
    final used = number('memoryUsedBytes'), total = number('memoryTotalBytes');
    final memory = used != null && total != null && total > 0 && used <= total;
    final free = number('diskFreeBytes'), size = number('diskTotalBytes');
    final disk = free != null && size != null && size > 0 && free <= size;
    return SwarmMachineResources(
      cpuPercent: cpu != null && cpu <= 100 ? cpu : null,
      gpuPercent: gpu != null && gpu <= 100 ? gpu : null,
      memoryUsedBytes: memory ? used : null,
      memoryTotalBytes: memory ? total : null,
      diskFreeBytes: disk ? free : null,
      diskTotalBytes: disk ? size : null,
      projectDiskFreeBytes: number('projectDiskFreeBytes'),
      projectDiskTotalBytes: number('projectDiskTotalBytes'),
      deviceType: label('deviceType'),
      chip: label('chip'),
      os: label('os'),
    );
  }

  final double? cpuPercent, gpuPercent;
  final double? memoryUsedBytes, memoryTotalBytes;
  final double? diskFreeBytes, diskTotalBytes;
  final double? projectDiskFreeBytes, projectDiskTotalBytes;
  final String? deviceType, chip, os;
}

/// One window of an allowance: its name, the share [left] (0–100), and when it resets (`resets in 2h 10m`).
typedef SwarmAllowanceWindow = ({String window, double left, String? reset});

/// One engine's allowance on a machine, as Desktop's details list it: the provider's [name] (`Claude Code`, `Codex`),
/// the share left of the window that stops work first ([figure]), and each window, the tightest first.
typedef SwarmMachineAllowance = ({
  String engine,
  String name,
  String figure,
  List<SwarmAllowanceWindow> windows,
});

/// What a machine's details say of its subscriptions (Desktop `machines.dart` `_subscriptions` and `_quotaRow`), from
/// its own pool, since a Mac's Harness Team account spends the Mac owner's subscriptions: the engines it offers (null
/// when its pool names none), and each allowance with a figure. An allowance with none is left out, as Desktop's
/// details leave it out; so is one whose window reset since a current reading.
///
/// [reading] is the pool the machine's row reads ([SuperTabSnapshot.readingPoolOf]), [readingDim] whether that reading
/// is old.
({List<String>? engines, List<SwarmMachineAllowance> allowances})
swarmMachineSubscriptions(
  SuperTabSnapshot snapshot,
  String machineId, {
  required Map<String, dynamic>? reading,
  required bool readingDim,
  required DateTime now,
}) {
  final pool =
      snapshot.pool(machineId) ?? snapshot.teamPoolOf(machineId) ?? reading;
  final observation = superTabMap(
    pool?['observation'] ?? const <String, dynamic>{},
  );
  final readAt = switch (observation['receivedAt']) {
    final num at => _epoch(at),
    _ => null,
  };
  final stale = identical(pool, reading)
      ? readingDim
      : readAt == null || now.difference(readAt) >= _offlineAfter;
  final quotas = <String, Map<String, dynamic>>{
    for (final raw in _list(observation['quotas']))
      if (superTabMap(raw)['engine'] case final String engine
          when _engines.contains(engine))
        engine: superTabMap(raw),
  };
  final configured = pool?['engines'] is List
      ? (pool!['engines'] as List).whereType<String>()
      : null;
  final readiness = observation['readiness'];
  final installed = {
    for (final raw in _list(readiness is Map ? readiness['engines'] : null))
      if (raw is Map && raw['installed'] == true) raw['engine'],
  };
  // A list that still names a retired engine (OpenCode) cannot say which of the two it offers: Claude and Codex come
  // from what it reported or has installed.
  final engines = configured?.any((e) => !_engines.contains(e)) == true
      ? [
          for (final engine in _engines)
            if (configured!.contains(engine) ||
                quotas.containsKey(engine) ||
                installed.contains(engine))
              engine,
        ]
      : configured?.where(_engines.contains).toList();
  return (
    engines: engines,
    allowances: [
      if (readAt != null)
        for (final MapEntry(key: engine, value: quota) in quotas.entries)
          ?_allowance(engine, quota, old: stale, now: now),
    ],
  );
}

/// [quota]'s allowance with its figure; null when it has none. [old]: the machine is offline, so this is its last
/// reading, whose windows may have reset since; the figures stay, as when they were read.
SwarmMachineAllowance? _allowance(
  String engine,
  Map<String, dynamic> quota, {
  required bool old,
  required DateTime now,
}) {
  final windows = [for (final raw in _list(quota['windows'])) superTabMap(raw)];
  double? used(Map<String, dynamic> w) => switch (w['usedPercent']) {
    final num v when v.isFinite => v.toDouble().clamp(0.0, 100.0),
    _ => null,
  };
  // A window without its share cannot say whether it is the one that stops work first.
  if (quota['known'] != true ||
      windows.isEmpty ||
      windows.any((w) => used(w) == null)) {
    return null;
  }
  windows.sort((a, b) => used(b)!.compareTo(used(a)!));
  if (!old &&
      windows.any((w) => _reset(w['resetsAt'])?.isBefore(now) == true)) {
    return null;
  }
  final left = 100 - used(windows.first)!;
  return (
    engine: engine,
    name: engine == 'claude' ? 'Claude Code' : 'Codex',
    figure: left > 0 && left < 1 ? '<1%' : '${left.floor()}%',
    windows: [
      for (final w in windows)
        if (w['name'] case final String name when name.isNotEmpty)
          (
            window: name,
            left: 100 - used(w)!,
            reset: switch (_reset(w['resetsAt'])) {
              final at? when at.isAfter(now) => 'resets in ${_until(at, now)}',
              _ => null,
            },
          ),
    ],
  );
}

List<Object?> _list(Object? value) => value is List ? value : const [];

/// [milliseconds] since the epoch as a time; null for one no time has.
DateTime? _epoch(num milliseconds) =>
    milliseconds.isFinite && milliseconds.abs() <= 8640000000000000
    ? DateTime.fromMillisecondsSinceEpoch(milliseconds.toInt())
    : null;

/// A window's reset, in seconds or milliseconds since the epoch, or as a date.
DateTime? _reset(Object? raw) => switch (raw) {
  final num v => _epoch(v > 100000000000 ? v : v * 1000),
  final String v => DateTime.tryParse(v),
  _ => null,
};

/// How long until [when]: `45m`, `2h 10m`, `3d`.
String _until(DateTime when, DateTime now) {
  final minutes = when.difference(now).inMinutes;
  return minutes <= 0
      ? 'now'
      : minutes < 60
      ? '${minutes}m'
      : minutes < 1440
      ? '${minutes ~/ 60}h ${minutes % 60}m'
      : '${minutes ~/ 1440}d';
}

/// A share as Desktop writes it: `80`, `62.5`.
String _share(double value) => value == value.roundToDouble()
    ? '${value.round()}'
    : value.toStringAsFixed(1);

String _percent(double value) => '${value.round()}%';

String _bytes(double value) {
  if (value == 0) return '0 GB';
  if (value < 1000000000) return '${(value / 1000000).round()} MB';
  return '${(value / 1000000000).round()} GB';
}

/// A titled group of a machine's details.
Widget swarmMachineDetailHeading(String title) => Padding(
  padding: const EdgeInsets.only(top: AppSpace.xl, bottom: AppSpace.s),
  child: Semantics(
    header: true,
    child: Text(title, style: AppType.heading(color: AppPalette.textPrimary)),
  ),
);

/// One of a machine's details: its label on the left, its value on the right. [narrow] for a short label (an
/// allowance's window), whose value takes the room.
Widget swarmMachineDetailRow(
  String label,
  String text, {
  Color? color,
  bool narrow = false,
}) => Padding(
  padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
  child: Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(
        flex: narrow ? 1 : 2,
        child: Text(
          label,
          style: AppType.caption(color: AppPalette.textSecondary),
        ),
      ),
      const SizedBox(width: AppSpace.m),
      Expanded(
        flex: 3,
        child: Text(
          text,
          textAlign: TextAlign.right,
          style: AppType.body(color: color ?? AppPalette.textPrimary),
        ),
      ),
    ],
  ),
);

/// A machine's details, as Desktop's (`desktop/lib/super_tabs/machine_details.dart` `SuperTabMachineDetails`) show
/// them, read only: who owns it and its state, its available capacity, its model allowances, and its hardware and
/// engines. Old readings are not passed in: their sections are left out.
class SwarmMachineDetails extends StatelessWidget {
  const SwarmMachineDetails({
    super.key,
    required this.name,
    required this.status,
    this.owner,
    this.resources,
    this.engines,
    this.allowances = const [],
    this.footer,
  });

  final String name, status;
  final String? owner;
  final SwarmMachineResources? resources;
  final List<String>? engines;
  final List<SwarmMachineAllowance> allowances;

  /// Below the details: what the Swarm adds about the machine ([SwarmMachineLocalModels]).
  final Widget? footer;

  /// A window's share in the footer's colours: neutral above 20%, amber to 6%, red at 5% or less.
  static Color _ink(double left) {
    final percent = left.floor();
    return percent > 20
        ? AppPalette.textPrimary
        : percent <= 5
        ? AppPalette.usageCritical
        : AppPalette.usageLow;
  }

  List<Widget> _allowance(SwarmMachineAllowance allowance) => [
    Padding(
      padding: const EdgeInsets.only(top: AppSpace.s, bottom: AppSpace.xs),
      child: Row(
        children: [
          EngineMark(engine: allowance.engine, size: 16),
          const SizedBox(width: AppSpace.s),
          Expanded(
            child: Text(
              allowance.name,
              style: AppType.label(color: AppPalette.textPrimary),
            ),
          ),
          // Without its windows the allowance's one figure stands for them.
          if (allowance.windows.isEmpty)
            Text(
              '${allowance.figure} left',
              style: AppType.body(color: AppPalette.textPrimary),
            ),
        ],
      ),
    ),
    for (final window in allowance.windows)
      swarmMachineDetailRow(
        window.window,
        ['${_share(window.left)}% left', ?window.reset].join(' · '),
        color: _ink(window.left),
        narrow: true,
      ),
  ];

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final value = resources;
    final diskTotal = value?.projectDiskTotalBytes ?? value?.diskTotalBytes;
    final diskFree = value?.projectDiskTotalBytes == null
        ? value?.diskFreeBytes
        : value?.projectDiskFreeBytes;
    final memoryFree =
        value?.memoryTotalBytes == null || value?.memoryUsedBytes == null
        ? null
        : (value!.memoryTotalBytes! - value.memoryUsedBytes!).clamp(
            0.0,
            value.memoryTotalBytes!,
          );
    String free(double used) => _percent((100 - used).clamp(0.0, 100.0));
    String capacity(double available, double? total) =>
        '${_bytes(available)}${total == null ? '' : ' of ${_bytes(total)}'}';
    final readings = [
      if (value?.cpuPercent case final cpu?) ('CPU', free(cpu)),
      if (value?.gpuPercent case final gpu?) ('GPU', free(gpu)),
      if (memoryFree != null)
        ('RAM', capacity(memoryFree, value?.memoryTotalBytes)),
      if (diskFree != null) ('SSD', capacity(diskFree, diskTotal)),
    ];
    // A Swarm's reading names no graphics card, only the busiest one's use: Desktop's Graphics row has nothing here.
    final hardware = [
      ('Computer', name),
      if (value?.deviceType case final device?) ('Device', device),
      if (value?.chip case final chip?) ('Chip', chip),
      if (value?.os case final os?) ('System', os),
      if (engines?.isNotEmpty == true)
        ('Engines', engines!.map((e) => engineIdentity(e).label).join(', ')),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (owner case final owner?) swarmMachineDetailRow('Owner', owner),
        swarmMachineDetailRow('Status', status),
        if (readings.isNotEmpty) ...[
          swarmMachineDetailHeading('Available capacity'),
          for (final (label, text) in readings)
            swarmMachineDetailRow(label, text),
        ],
        if (allowances.isNotEmpty) ...[
          swarmMachineDetailHeading('Model allowances'),
          for (final allowance in allowances) ..._allowance(allowance),
        ],
        swarmMachineDetailHeading('Details'),
        for (final (label, text) in hardware)
          swarmMachineDetailRow(label, text),
        ?footer,
      ],
    );
  }
}

/// The models part of a machine's details (Desktop `local_models.dart` `SuperTabMachineLocalModels`): what it serves
/// the Swarm now, from a fresh reading only, as the route reads it. Nothing while the Swarm's models are off.
class SwarmMachineLocalModels extends StatelessWidget {
  const SwarmMachineLocalModels({
    super.key,
    required this.snapshot,
    required this.machineId,
    this.now = DateTime.now,
  });

  final SuperTabSnapshot snapshot;
  final String machineId;
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final local = snapshot.localModels;
    if (local == null || !local.enabled) return const SizedBox.shrink();
    final pool = snapshot.pool(machineId);
    final fresh = superTabServedModels(pool, local.grid, now: now());
    final apis = <String>[], models = <String>[];
    final observed = pool?['observation'];
    for (final m in _list(observed is Map ? observed['localModels'] : null)) {
      if (m is! Map || m['grid'] != local.grid || m['model'] is! String) {
        continue;
      }
      final model = m['model'] as String;
      if (!fresh.any((f) => f.model == model)) continue;
      if (m['kind'] == 'api') {
        // An API's model without its provider's folder ("deepseek/…").
        apis.add(model.substring(model.lastIndexOf('/') + 1));
      } else {
        models.add(m['name'] is String ? m['name'] as String : model);
      }
    }
    Widget line(String label, List<String> names) => swarmMachineDetailRow(
      label,
      names.isEmpty ? 'None' : names.join(', '),
      color: names.isEmpty ? AppPalette.textSecondary : null,
    );
    return Column(
      key: ValueKey('swarm-machine-local-models-$machineId'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        swarmMachineDetailHeading('Models for this Swarm'),
        line('API models', apis),
        line('Local models', models),
      ],
    );
  }
}
