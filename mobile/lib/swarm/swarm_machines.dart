import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../phone/phone_sheet.dart';
import '../shared/theme/app_icon_size.dart';
import '../shared/theme/app_space.dart';
import '../shared/theme/app_theme.dart';
import '../shared/theme/app_type.dart';
import 'model.dart';
import 'swarm_buddy.dart';
import 'swarm_machine_details.dart';
import 'swarm_machine_menu.dart';
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
    this.menu,
    this.swarmName,
  });
  final SwarmReader reader;
  final String? swarmName;
  final void Function(String machineId) open;

  /// A long press on a machine: its Details / Pause / Remove menu ([showSwarmMachineMenu]); null leaves the row with
  /// its tap alone.
  final void Function(String machineId, String name)? menu;

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
    onLongPress: widget.menu == null
        ? null
        : () => widget.menu!(view.id, view.name),
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
            name: owner.shownName,
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

Widget _tap({
  Key? key,
  required VoidCallback onTap,
  VoidCallback? onLongPress,
  required Widget child,
}) => Material(
  color: Colors.transparent,
  child: InkWell(
    key: key,
    onTap: onTap,
    onLongPress: onLongPress,
    child: ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 52),
      child: Padding(padding: const EdgeInsets.all(AppSpace.s), child: child),
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
      final subscriptions = swarmMachineSubscriptions(
        snapshot,
        machineId,
        reading: view.reading,
        readingDim: view.dim,
        now: DateTime.now(),
      );
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
              SwarmMachineDetails(
                name: view.name,
                owner: view.owner?.shownName,
                status: view.details,
                // Details follow the same freshness rule as the row: old readings are not shown as current.
                resources: view.dim
                    ? null
                    : SwarmMachineResources.read(view.resources),
                engines: subscriptions.engines,
                allowances: view.dim ? const [] : subscriptions.allowances,
                footer: SwarmMachineLocalModels(
                  reader: reader,
                  machineId: machineId,
                ),
              ),
              swarmMachineDetailHeading('Agents'),
              if (agents.isEmpty)
                swarmMachineDetailRow('Running here', 'No agents running')
              else
                for (final a in agents)
                  swarmMachineDetailRow(
                    a.name,
                    '${snapshot.roleOf(a.agent.id)?.badge ?? 'Dev'} · ${a.label}',
                  ),
              SwarmMachinePauseButton(reader: reader, machineId: machineId),
            ],
          ),
        ),
      );
    },
  );
}

double? _number(Object? v) => v is num && v.isFinite ? v.toDouble() : null;

class _MachineView {
  _MachineView(
    this.snapshot,
    this.id,
    SwarmReader reader, {
    required bool refreshing,
  }) {
    final pool = snapshot.pool(id);
    agents = swarmTeamAgents(snapshot)
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
    name =
        pool?['name'] as String? ??
        // The Swarm knows no name for it, and sharing its own would be new data: it is named by its owner, as Desktop
        // names it.
        (pool == null && snapshot.teamPoolOf(id) == null && owner != null
            ? "${owner!.shownName}'s computer"
            : 'Unavailable machine');
    reading = snapshot.readingPoolOf(id, reader.accountId);
    final observation = superTabMap(
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
    final paused = reading?['paused'] == true;
    final removal = pool?['removal'];
    // What its details say of its state, in Desktop's words (`machines.dart` `_view`): late is still online there.
    details = removal is Map && removal['state'] == 'cleaning'
        ? 'Cleaning up'
        : reader.error != null
        ? "Can't reach Harness"
        : refreshing
        ? 'Refreshing…'
        : offline
        ? (paused ? 'Offline, new work paused' : 'Offline')
        : paused
        ? 'New work paused'
        : 'Online';
  }
  final SuperTabSnapshot snapshot;
  final String id;
  late final String name, status, details;
  late final SuperTabPerson? owner;
  late final List<SuperTabAgent> agents;

  /// The pool whose reading the row shows ([SuperTabSnapshot.readingPoolOf]).
  late final Map<String, dynamic>? reading;
  late final Map<String, dynamic> resources;
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
