part of 'machines.dart';

String _machineStatusGroup(_MachineView view) => switch (view.status) {
  SuperTabMachineStatus.live => 'online',
  SuperTabMachineStatus.late => 'asleep',
  SuperTabMachineStatus.offline => 'offline',
  _ => 'unknown',
};

extension _ManageMachines on _SuperTabMachinesState {
  bool _matchesMachine(_MachineView view) =>
      (_machineFilter == 'all' ||
          _machineStatusGroup(view) == _machineFilter) &&
      '${view.name} ${view.owner?.shownName ?? ''} ${view.id}'
          .toLowerCase()
          .contains(_machineSearch.trim().toLowerCase());

  Widget _manageScreen(VoidCallback? add, DateTime? failingSince) {
    grid.AppTheme.watch(context);
    final views = _sortedViews();
    int count(String group) =>
        views.where((v) => _machineStatusGroup(v) == group).length;
    final summary =
        '${count('online')} online · ${count('asleep')} asleep · ${count('offline')} offline';
    final machines = _machines();
    return ColoredBox(
      color: MachinesStyle.background,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: MachinesStyle.headerInset,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final narrow = constraints.maxWidth < 760;
                final title = Wrap(
                  spacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text('Machines', style: MachinesStyle.title()),
                    Text(summary, style: MachinesStyle.body()),
                  ],
                );
                final actions = Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: const ValueKey('machines-search'),
                        onChanged: (value) {
                          _machineSearch = value;
                          _changed();
                        },
                        style: MachinesStyle.body(color: MachinesStyle.ink),
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
                          contentPadding: MachinesStyle.fieldPadding,
                          enabledBorder: OutlineInputBorder(
                            borderRadius: MachinesStyle.radius,
                            borderSide: BorderSide(color: MachinesStyle.line),
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
                      key: const ValueKey('super-manage-add-machine'),
                      onPressed: add,
                      style: FilledButton.styleFrom(
                        backgroundColor: MachinesStyle.accent,
                      ),
                      child: const Text('Add machine'),
                    ),
                  ],
                );
                return narrow
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [title, const SizedBox(height: 16), actions],
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
          Divider(height: 1, color: MachinesStyle.line),
          Padding(
            padding: MachinesStyle.headerInset,
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final (id, label, total) in [
                      ('all', 'All', views.length),
                      ('online', 'Online', count('online')),
                      ('asleep', 'Asleep', count('asleep')),
                      ('offline', 'Offline', count('offline')),
                      if (count('unknown') > 0)
                        ('unknown', 'Status unknown', count('unknown')),
                    ])
                      ChoiceChip(
                        key: ValueKey('machines-filter-$id'),
                        label: Text('$label $total'),
                        selected: _machineFilter == id,
                        showCheckmark: false,
                        onSelected: (_) {
                          _machineFilter = id;
                          _changed();
                        },
                        labelStyle: MachinesStyle.small(
                          color: _machineFilter == id
                              ? MachinesStyle.background
                              : MachinesStyle.metadata,
                        ),
                        selectedColor: MachinesStyle.ink,
                        backgroundColor: MachinesStyle.background,
                        side: BorderSide(color: MachinesStyle.line),
                        shape: const RoundedRectangleBorder(
                          borderRadius: MachinesStyle.pillRadius,
                        ),
                      ),
                  ],
                ),
                Text(
                  'Sorted by status, then name',
                  style: MachinesStyle.small(),
                ),
              ],
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
          Expanded(
            child: LaidOutListView(
              padding: MachinesStyle.side,
              children: [
                if (_ids.isEmpty)
                  _stateNote(MachinesStyle.headerInset)!
                else if (machines.isEmpty)
                  Padding(
                    padding: MachinesStyle.headerInset,
                    child: Text(
                      'No machines match your search and filter.',
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
    );
  }
}

/// Fixed columns in Manage; the compact sidebar keeps its separate row anatomy.
class _ManageMachineLine extends StatelessWidget {
  const _ManageMachineLine({
    required this.view,
    required this.own,
    required this.local,
    required this.now,
    required this.onMore,
  });
  final _MachineView view;
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
    final crew = view.crew;
    final awake = crew.where((a) => !a.crewAsleep && !a.crewMoving).length;
    final age = view.readingAt == null ? null : now.difference(view.readingAt!);
    final metadata = [
      local ? 'This machine' : view.owner?.shownName ?? 'Owner unavailable',
      if (local) view.id.length > 8 ? view.id.substring(0, 8) : view.id,
      if (view.problem != null)
        view.problem!
      else if (group != 'online')
        'last seen ${age == null ? 'unknown' : superTabAgo(age)}'
      else if (crew.isNotEmpty)
        '${crew.length} crew · $awake online',
    ].join(' · ');
    return Container(
      key: ValueKey('machines-line-${view.id}'),
      height: 56,
      padding: MachinesStyle.rowInset,
      decoration: BoxDecoration(
        border: own
            ? null
            : Border(bottom: BorderSide(color: MachinesStyle.line)),
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
                    Row(
                      children: [
                        Flexible(
                          child: Tooltip(
                            message: view.name,
                            child: Text(
                              superTabMachineName(view.name),
                              key: ValueKey('super-machine-name-${view.id}'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: MachinesStyle.name(own: own),
                            ),
                          ),
                        ),
                        if (own) ...[
                          const SizedBox(width: 4),
                          Container(
                            padding: MachinesStyle.chipInset,
                            decoration: BoxDecoration(
                              color: MachinesStyle.accent.withValues(
                                alpha: .15,
                              ),
                              borderRadius: MachinesStyle.radius,
                            ),
                            child: Text(
                              'OWNER',
                              style: MachinesStyle.small(
                                color: MachinesStyle.selectedInk,
                                heading: true,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                    Text(
                      metadata,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: MachinesStyle.body(),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                flex: narrow ? 2 : 5,
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Container(
                    key: ValueKey('machines-crew-${view.id}'),
                    padding: MachinesStyle.chipInset,
                    decoration: BoxDecoration(
                      color: group == 'asleep'
                          ? MachinesStyle.asleep.withValues(alpha: .12)
                          : MachinesStyle.chip,
                      borderRadius: MachinesStyle.radius,
                    ),
                    child: Text(
                      group == 'asleep' && crew.isNotEmpty
                          ? '${crew.length} asleep'
                          : '${crew.length} crew',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: MachinesStyle.small(
                        color: group == 'asleep'
                            ? MachinesStyle.asleep
                            : MachinesStyle.metadata,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: narrow ? 112 : 150,
                child: _MachineDisk(view: view),
              ),
              const SizedBox(width: 12),
              // Reserve the column even when the menu is hidden so hover never moves disk values.
              SizedBox(width: 32, child: _MachineMore(onOpen: onMore)),
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
    final total = resources?.projectDiskTotalBytes ?? resources?.diskTotalBytes;
    final free = resources?.projectDiskTotalBytes == null
        ? resources?.diskFreeBytes
        : resources?.projectDiskFreeBytes;
    final fraction = total != null && total > 0 && free != null
        ? (free / total).clamp(0.0, 1.0)
        : null;
    return Column(
      key: ValueKey('machines-disk-${view.id}'),
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          free == null ? 'Disk unavailable' : '${resourceBytes(free)} free',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: MachinesStyle.body(color: MachinesStyle.ink)
              .copyWith(fontFeatures: MachinesStyle.tabular),
        ),
        Text(
          total == null ? 'No reading' : 'of ${resourceBytes(total)}',
          style: MachinesStyle.small().copyWith(
            fontFeatures: MachinesStyle.tabular,
          ),
        ),
        const SizedBox(height: 4),
        if (fraction != null)
          LinearProgressIndicator(
            key: ValueKey('machines-disk-bar-${view.id}'),
            value: fraction,
            minHeight: 3,
            borderRadius: MachinesStyle.radius,
            color: fraction < .25 ? MachinesStyle.asleep : MachinesStyle.online,
            backgroundColor: MachinesStyle.chip,
          ),
      ],
    );
  }
}
