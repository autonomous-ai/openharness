import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../phone/phone_sheet.dart';
import '../shared/theme/app_icon_size.dart';
import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/app_type.dart';
import 'identity.dart';
import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_style.dart';
import 'team_glance.dart';

/// Swarm inventory only: never the account's private linked-computer list.
/// Backend-filtered parts and Desktop's readingPoolOf own visibility.
class SwarmMachinesSection extends StatefulWidget {
  const SwarmMachinesSection({
    super.key,
    required this.reader,
    required this.open,
    this.swarmName,
  });
  final SwarmReader reader;
  final String? swarmName;
  final void Function(String machineId) open;

  @override
  State<SwarmMachinesSection> createState() => _SwarmMachinesSectionState();
}

class _SwarmMachinesSectionState extends State<SwarmMachinesSection> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) => _MachineRead(
    reader: widget.reader,
    builder: (context, snapshot, refreshing) {
      AppTheme.watch(context);
      final ids = <String>{
        for (final m in snapshot?.machines ?? <Map<String, dynamic>>[])
          if (m['machineId'] case final String id) id,
        for (final a in snapshot?.agents ?? <SuperTabAgent>[]) a.machineId,
      }.where((id) => snapshot!.placeOf(id) == id).toList();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            expanded: _expanded,
            child: _tap(
              key: ValueKey('swarm-machines-${widget.reader.tabId}'),
              onTap: () => setState(() => _expanded = !_expanded),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.swarmName == null
                          ? 'Machines'
                          : 'Machines · ${widget.swarmName}',
                      style: AppType.caption(color: AppPalette.textSecondary),
                    ),
                  ),
                  Icon(
                    _expanded
                        ? LucideIcons.chevronDown300
                        : LucideIcons.chevronRight300,
                    size: AppIconSize.besideText,
                    color: AppPalette.textSecondary,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            if (ids.isEmpty)
              Padding(
                padding: const EdgeInsets.all(AppSpace.m),
                child: Text(
                  widget.reader.accessRevoked
                      ? 'Access ended'
                      : snapshot == null
                      ? widget.reader.error ?? 'Reading machines…'
                      : 'No machines yet',
                  style: AppType.caption(color: AppPalette.textSecondary),
                ),
              )
            else
              for (final id in ids)
                _machineRow(
                  _MachineView(
                    snapshot!,
                    id,
                    widget.reader,
                    refreshing: refreshing,
                  ),
                ),
        ],
      );
    },
  );

  Widget _machineRow(_MachineView view) => _tap(
    key: ValueKey('swarm-machine-${widget.reader.tabId}-${view.id}'),
    onTap: () => widget.open(view.id),
    child: Row(
      children: [
        Icon(
          view.laptop ? LucideIcons.laptop300 : LucideIcons.monitor300,
          size: AppIconSize.besideText,
          color: AppPalette.textSecondary,
        ),
        const SizedBox(width: AppSpace.m),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                view.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.label(color: AppPalette.textPrimary),
              ),
              if (view.agents.isNotEmpty)
                Text(
                  '${view.agents.length} ${view.agents.length == 1 ? 'agent' : 'agents'}',
                  style: AppType.caption(color: AppPalette.textSecondary),
                ),
            ],
          ),
        ),
        if (view.owner case final owner?) ...[
          const SizedBox(width: AppSpace.s),
          SwarmAvatar(
            id: owner.id,
            name: superTabPersonName(owner.email),
            picture: owner.avatar,
            size: AppIconSize.standalone,
          ),
        ],
        const SizedBox(width: AppSpace.s),
        Semantics(
          label: view.status,
          child: Text(
            view.offline ? '○' : '●',
            style: AppType.caption(
              color: view.live ? AppPalette.online : AppPalette.textFaint,
            ),
          ),
        ),
      ],
    ),
  );
}

Widget _tap({Key? key, required VoidCallback onTap, required Widget child}) =>
    Material(
      color: Colors.transparent,
      child: InkWell(
        key: key,
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 52),
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.s),
            child: child,
          ),
        ),
      ),
    );

/// A read-only sheet that keeps following the same reader as the drawer.
Future<void> showSwarmMachine(
  BuildContext context,
  SwarmReader reader,
  String id,
) => Navigator.of(context, rootNavigator: true).push(
  phoneSheetRoute<void>(
    context,
    builder: (_) => SwarmMachineSheet(reader: reader, machineId: id),
  ),
);

class SwarmMachineSheet extends StatelessWidget {
  const SwarmMachineSheet({
    super.key,
    required this.reader,
    required this.machineId,
  });
  final SwarmReader reader;
  final String machineId;

  @override
  Widget build(BuildContext context) => _MachineRead(
    reader: reader,
    builder: (context, snapshot, refreshing) {
      AppTheme.watch(context);
      if (snapshot == null ||
          (snapshot.pool(machineId) == null &&
              !snapshot.agents.any(
                (a) => snapshot.placeOf(a.machineId) == machineId,
              ))) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(AppSpace.xl),
            child: Text(
              reader.accessRevoked
                  ? 'Access ended'
                  : 'Machine no longer available',
              style: AppType.body(color: AppPalette.textPrimary),
            ),
          ),
        );
      }
      final view = _MachineView(
        snapshot,
        machineId,
        reader,
        refreshing: refreshing,
      );
      final r = view.resources;
      final total = _number(r['memoryTotalBytes']);
      final used = _number(r['memoryUsedBytes']);
      final diskTotal =
          _number(r['projectDiskTotalBytes']) ?? _number(r['diskTotalBytes']);
      final diskFree = r['projectDiskTotalBytes'] == null
          ? _number(r['diskFreeBytes'])
          : _number(r['projectDiskFreeBytes']);
      final agents = swarmTeamGlance(snapshot).agents.where(
        (a) =>
            snapshot.placeOf(a.agent.machineId) == machineId &&
            a.agent.downSince == null,
      );
      return SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpace.screenInset),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      view.name,
                      style: AppType.heading(color: AppPalette.textPrimary),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(
                      LucideIcons.x300,
                      size: AppIconSize.standalone,
                    ),
                  ),
                ],
              ),
              _detail('Status', view.status),
              if (view.owner case final owner?)
                _detail('Owner', superTabPersonName(owner.email)),
              _heading('Hardware'),
              if (view.dim)
                _detail('Readings', 'Current readings unavailable')
              else ...[
                _detail('CPU', _percent(r['cpuPercent'])),
                _detail('GPU', _percent(r['gpuPercent'])),
                _detail(
                  'RAM',
                  total == null || used == null
                      ? 'Unavailable'
                      : '${_bytes((total - used).clamp(0, total))} free of ${_bytes(total)}',
                ),
                _detail(
                  'SSD',
                  diskFree == null
                      ? 'Unavailable'
                      : '${_bytes(diskFree)} free${diskTotal == null ? '' : ' of ${_bytes(diskTotal)}'}',
                ),
                for (final (label, field) in [
                  ('Device', 'deviceType'),
                  ('Chip', 'chip'),
                  ('System', 'os'),
                ])
                  if (r[field] case final String text) _detail(label, text),
              ],
              _heading('Model allowances'),
              if (view.dim)
                _detail('Allowances', 'Current allowances unavailable')
              else
                for (final engine in ['claude', 'codex'])
                  ..._allowance(view, engine),
              _heading('Agents'),
              if (agents.isEmpty)
                _detail('Running here', 'No agents running')
              else
                for (final a in agents)
                  _detail(
                    a.name,
                    '${a.agent.isReviewer
                        ? 'Rev'
                        : a.agent.name == 'Lead'
                        ? 'PM'
                        : 'Dev'} · ${a.label}',
                  ),
            ],
          ),
        ),
      );
    },
  );
}

Widget _heading(String title) => Padding(
  padding: const EdgeInsets.only(top: AppSpace.xl, bottom: AppSpace.s),
  child: Text(title, style: AppType.heading(color: AppPalette.textPrimary)),
);

Widget _detail(String label, String text) => Padding(
  padding: const EdgeInsets.symmetric(vertical: AppSpace.xs),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: AppType.caption(color: AppPalette.textSecondary)),
      Text(text, style: AppType.body(color: AppPalette.textPrimary)),
    ],
  ),
);

double? _number(Object? v) => v is num && v.isFinite ? v.toDouble() : null;
String _percent(Object? value) => switch (_number(value)) {
  final n? => '${n.clamp(0, 100).round()}% in use',
  null => 'Unavailable',
};
String _bytes(num bytes) =>
    '${(bytes / 1073741824).toStringAsFixed(bytes % 1073741824 == 0 ? 0 : 1)} GB';

List<Widget> _allowance(_MachineView view, String engine) {
  final quota = (view.observation['quotas'] as List? ?? [])
      .map(superTabMap)
      .where((q) => q['engine'] == engine)
      .firstOrNull;
  final windows = (quota?['windows'] as List? ?? []).map(superTabMap).toList();
  DateTime? reset(Object? raw) => raw is num
      ? DateTime.fromMillisecondsSinceEpoch(
          raw > 100000000000 ? raw.toInt() : (raw * 1000).toInt(),
        )
      : raw is String
      ? DateTime.tryParse(raw)
      : null;
  final known =
      quota?['known'] == true &&
      windows.isNotEmpty &&
      windows.every(
        (w) =>
            _number(w['usedPercent']) != null &&
            !(reset(w['resetsAt'])?.isBefore(DateTime.now()) ?? false),
      );
  final name = engine == 'claude' ? 'Claude' : 'Codex';
  if (!known) return [_detail(name, 'Allowance unavailable')];
  return [
    for (final w in windows)
      _detail(
        name,
        '${w['name'] ?? 'Allowance'}: ${(100 - _number(w['usedPercent'])!).clamp(0, 100).round()}% left'
        '${reset(w['resetsAt']) == null ? '' : '\nResets ${_resetIn(reset(w['resetsAt'])!)}'}',
      ),
  ];
}

String _resetIn(DateTime at) {
  final minutes = at.difference(DateTime.now()).inMinutes;
  return minutes <= 0
      ? 'now'
      : minutes < 60
      ? 'in ${minutes}m'
      : 'in ${minutes ~/ 60}h ${minutes % 60}m';
}

class _MachineView {
  _MachineView(
    this.snapshot,
    this.id,
    SwarmReader reader, {
    required bool refreshing,
  }) {
    final pool = snapshot.pool(id);
    agents = snapshot.agents
        .where(
          (a) => snapshot.placeOf(a.machineId) == id && a.downSince == null,
        )
        .toList();
    owner = snapshot.people
        .where(
          (p) =>
              p.id ==
              (pool?['contributorId'] ?? agents.firstOrNull?.contributorId),
        )
        .firstOrNull;
    name = pool?['name'] as String? ?? 'Unavailable machine';
    final reading = snapshot.readingPoolOf(id, reader.accountId);
    observation = superTabMap(
      reading?['observation'] ?? const <String, dynamic>{},
    );
    resources = superTabMap(
      observation['resources'] ?? const <String, dynamic>{},
    );
    final received = _number(observation['receivedAt']);
    final age = received == null
        ? null
        : DateTime.now().difference(
            DateTime.fromMillisecondsSinceEpoch(received.toInt()),
          );
    offline = age == null || age >= const Duration(seconds: 35);
    live =
        !offline &&
        age! < const Duration(seconds: 20) &&
        reader.error == null &&
        !refreshing;
    dim = offline || reader.error != null || refreshing;
    status = reader.error != null
        ? "Can't reach Harness"
        : refreshing
        ? 'Refreshing…'
        : offline
        ? 'Offline'
        : reading?['paused'] == true
        ? 'New work paused'
        : live
        ? 'Online'
        : 'Late';
  }
  final SuperTabSnapshot snapshot;
  final String id;
  late final String name, status;
  late final SuperTabPerson? owner;
  late final List<SuperTabAgent> agents;
  late final Map<String, dynamic> observation, resources;
  late final bool offline, live, dim;
  bool get laptop =>
      (resources['deviceType'] as String? ?? name).toLowerCase().contains(
        'book',
      ) ||
      name.toLowerCase().contains('laptop');
}

/// Only a clock tick is new here; all network reads remain the existing
/// changed-parts reader's. A foreground return hides pre-background readings.
class _MachineRead extends StatefulWidget {
  const _MachineRead({required this.reader, required this.builder});
  final SwarmReader reader;
  final Widget Function(BuildContext, SuperTabSnapshot?, bool) builder;
  @override
  State<_MachineRead> createState() => _MachineReadState();
}

class _MachineReadState extends State<_MachineRead>
    with WidgetsBindingObserver {
  Timer? _tick;
  int? _returnRead;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _start();
  }

  void _start() {
    _tick?.cancel();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _tick?.cancel();
    if (state == AppLifecycleState.resumed) {
      _returnRead = widget.reader.reads.value;
      _start();
      setState(() {});
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.reader, widget.reader.reads]),
    builder: (context, _) => widget.builder(
      context,
      widget.reader.accessRevoked ? null : widget.reader.snapshot,
      _returnRead != null && widget.reader.reads.value <= _returnRead!,
    ),
  );
}
