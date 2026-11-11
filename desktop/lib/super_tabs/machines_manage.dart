part of 'machines.dart';

String _machineStatusGroup(_MachineView view) => switch (view.status) {
  SuperTabMachineStatus.live => 'online',
  SuperTabMachineStatus.late => 'asleep',
  SuperTabMachineStatus.offline => 'offline',
  _ => 'unknown',
};

Object _machineLayout(List<_MachineView> views) {
  final counts = <String, int>{};
  for (final view in views) {
    final group = _machineStatusGroup(view);
    counts.update(group, (value) => value + 1, ifAbsent: () => 1);
  }
  return (
    counts['online'] ?? 0,
    counts['asleep'] ?? 0,
    counts['offline'] ?? 0,
    counts['unknown'] ?? 0,
    Object.hashAll(views.map((v) => (v.name, v.owner?.shownName))),
  );
}

extension _ManageMachines on _SuperTabMachinesState {
  bool _matchesMachine(_MachineView view) =>
      // What a row shows: its name and its owner.
      '${view.name} ${view.owner?.shownName ?? ''}'.toLowerCase().contains(
        _machineSearch.trim().toLowerCase(),
      );

  Widget _manageScreen(VoidCallback? add) {
    grid.AppTheme.watch(context);
    final views = _sortedViews();
    _manageLayoutDrawn = _machineLayout(views);
    final names = <String, int>{};
    for (final view in views) {
      names.update(
        superTabMachineName(view.name),
        (n) => n + 1,
        ifAbsent: () => 1,
      );
    }
    _manageNames = {
      for (final view in views)
        view.id: names[superTabMachineName(view.name)]! > 1
            ? '${superTabMachineName(view.name)} · ${view.owner?.shownName ?? view.id}'
            : superTabMachineName(view.name),
    };
    int count(String group) =>
        views.where((v) => _machineStatusGroup(v) == group).length;
    // The counts a person acts on; a count at 0 is left out.
    final summary = [
      for (final (group, word) in [
        ('online', 'online'),
        ('asleep', 'asleep'),
        ('unknown', 'status unknown'),
        ('offline', 'offline'),
      ])
        if (count(group) case final n when n > 0) '$n $word',
    ].join(' · ');
    final machines = _machines(views);
    return ColoredBox(
      // The Swarm's one ground (design system, Swarm elements, One surface).
      color: grid.AppPalette.swarmField,
      child: LayoutBuilder(
        builder: (context, page) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // In a short window or at a large text size the header scrolls on its own within half the page, so the
            // machines below it always keep room.
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: page.maxHeight / 2),
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: MachinesStyle.toolbarInset,
                      child: LayoutBuilder(
                        builder: (context, constraints) {
                          // A larger text size needs the room sooner: search and Add machine go under the counts.
                          final narrow =
                              constraints.maxWidth <
                              MediaQuery.textScalerOf(context).scale(760);
                          // The Machines tab above names the page: the counts alone.
                          final title = Text(
                            summary,
                            key: const ValueKey('machines-summary'),
                            style: DesktopChrome.metadata(),
                          );
                          final actions = SizedBox(
                            height: 36,
                            child: Row(
                              children: [
                                Expanded(
                                  child: TextField(
                                    key: const ValueKey('machines-search'),
                                    onChanged: (value) {
                                      _machineSearch = value;
                                      _changed();
                                    },
                                    style: MachinesStyle.body(
                                      color: grid.AppPalette.textPrimary,
                                    ),
                                    decoration: InputDecoration(
                                      hintText: 'Search machines',
                                      hintStyle: MachinesStyle.body(
                                        color: MachinesStyle.label,
                                      ),
                                      prefixIcon: Icon(
                                        AppIcons.search,
                                        size: 16,
                                        color: MachinesStyle.label,
                                      ),
                                      filled: true,
                                      fillColor: MachinesStyle.field,
                                      isDense: true,
                                      contentPadding:
                                          MachinesStyle.fieldPadding,
                                      enabledBorder: OutlineInputBorder(
                                        borderRadius: MachinesStyle.radius,
                                        borderSide: BorderSide(
                                          color: MachinesStyle.line,
                                        ),
                                      ),
                                      focusedBorder: OutlineInputBorder(
                                        borderRadius: MachinesStyle.radius,
                                        borderSide: BorderSide(
                                          color: MachinesStyle.accent,
                                          width: 2,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                FilledButton(
                                  key: const ValueKey(
                                    'super-manage-add-machine',
                                  ),
                                  onPressed: add,
                                  // The app's one blue action, a capsule (design system, Geometry).
                                  style: FilledButton.styleFrom(
                                    shape: const StadiumBorder(),
                                  ),
                                  child: const Text('Add machine'),
                                ),
                              ],
                            ),
                          );
                          return narrow
                              ? Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    if (summary.isNotEmpty) ...[
                                      title,
                                      const SizedBox(height: 16),
                                    ],
                                    actions,
                                  ],
                                )
                              : Row(
                                  children: [
                                    Expanded(child: title),
                                    const SizedBox(width: 16),
                                    SizedBox(width: 320, child: actions),
                                  ],
                                );
                        },
                      ),
                    ),
                    if (c.backendUnreachable)
                      Padding(
                        padding: MachinesStyle.side,
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                "Couldn't refresh machines. Showing last known readings.",
                                style: MachinesStyle.body(),
                              ),
                            ),
                            TextButton(
                              onPressed: () => unawaited(c.refresh()),
                              child: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: LaidOutListView(
                padding: MachinesStyle.side,
                children: [
                  if (_ids.isEmpty)
                    _stateNote()!
                  else if (machines.isEmpty)
                    Padding(
                      padding: MachinesStyle.headerInset,
                      child: Text(
                        'No machine matches.',
                        style: MachinesStyle.body(),
                      ),
                    )
                  else
                    ...machines,
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One machine's line in Manage, in fixed columns.
class _ManageMachineLine extends StatelessWidget {
  const _ManageMachineLine({
    required this.view,
    required this.name,
    required this.own,
    required this.local,
    required this.now,
    required this.onMore,
  });
  final _MachineView view;
  final String name;
  final bool own, local;
  final DateTime now;
  final Future<void> Function(Offset) onMore;

  @override
  Widget build(BuildContext context) {
    final group = _machineStatusGroup(view);
    final color = switch (group) {
      'online' => MachinesStyle.online,
      'asleep' => MachinesStyle.asleep,
      _ => MachinesStyle.offline,
    };
    final age = view.readingAt == null ? null : now.difference(view.readingAt!);
    final metadata = [
      local ? 'This machine' : view.owner?.shownName ?? 'Owner unavailable',
      // Removed from the Swarm: its folders are being deleted (Remove from Swarm).
      if (view.cleaning)
        'Cleaning up'
      else if (group != 'online')
        'last seen ${age == null ? 'unknown' : superTabAgo(age)}',
    ].join(' · ');
    return Container(
      key: ValueKey('machines-line-${view.id}'),
      // 56pt at the normal text size; a larger text size grows the row with its two lines.
      height: MediaQuery.textScalerOf(context).scale(56),
      padding: MachinesStyle.rowInset,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: MachinesStyle.line)),
        borderRadius: MachinesStyle.radius,
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final narrow = constraints.maxWidth < 640;
          return Row(
            children: [
              SizedBox(
                width: 20,
                child: Center(
                  child: Container(
                    key: ValueKey('machines-dot-${view.id}'),
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color,
                      boxShadow: group == 'online'
                          ? [
                              BoxShadow(
                                color: color.withValues(alpha: .18),
                                spreadRadius: 3,
                              ),
                            ]
                          : null,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 5,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Tooltip(
                      message: view.name,
                      child: Text(
                        name,
                        key: ValueKey('super-machine-name-${view.id}'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: MachinesStyle.name(),
                      ),
                    ),
                    Text(
                      metadata,
                      key: ValueKey('machines-metadata-${view.id}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: MachinesStyle.body(),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              // Every row the same width, so the figures stay aligned; a larger text size widens them all alike.
              SizedBox(
                width: MediaQuery.textScalerOf(context)
                    .scale(narrow ? 112 : 150),
                child: _MachineDisk(view: view),
              ),
              const SizedBox(width: 12),
              // Reserve the column even when the menu is hidden so hover never moves disk values.
              SizedBox(
                width: 32,
                child: _MachineMore(
                  key: ValueKey('super-machine-more-${view.id}'),
                  onOpen: onMore,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _MachineDisk extends StatelessWidget {
  const _MachineDisk({required this.view});
  final _MachineView view;

  @override
  Widget build(BuildContext context) {
    final resources = view.resources;
    final free = resources?.projectDiskTotalBytes == null
        ? resources?.diskFreeBytes
        : resources?.projectDiskFreeBytes;
    // What is free, the one figure that decides where an agent goes; nothing when there is no reading.
    return Align(
      key: ValueKey('machines-disk-${view.id}'),
      alignment: Alignment.centerRight,
      child: free == null
          ? null
          : Text(
              '${resourceBytes(free)} free',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(color: grid.AppPalette.textFaint)
                  .copyWith(fontFeatures: MachinesStyle.tabular),
            ),
    );
  }
}
