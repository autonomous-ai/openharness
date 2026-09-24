import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../models/api_connections_panel.dart';
import '../models/model_search_catalog.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/harness_sessions.dart';
import '../state/harness_placement.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'link_machine_dialog.dart';
import 'link_machine_screen.dart';
import 'machine_actions.dart';
import 'machines_manager.dart' show showMachineRenameDialog;
import 'link_another_machine_dialog.dart';
import 'swarm_search_preview.dart';

const resourcePickerCommands = {
  'picker.resource_toggle',
  'picker.resource_more',
  'picker.resource_rename',
  'picker.resource_settings',
  'picker.resource_link',
  'picker.resource_add_api',
  'picker.resource_remove',
  'picker.resource_filter',
  'picker.resource_sort',
  'picker.refresh',
};

/// Shortcuts act on the current result without moving focus out of search.
class SearchPreviewControls {
  bool Function(String command)? dispatch;
  List<SwarmDestination> Function()? commands;
  bool invoke(String command) => dispatch?.call(command) ?? false;

  void dispose() {
    dispatch = null;
    commands = null;
  }
}

class _ResourceAction {
  const _ResourceAction(
    this.label,
    this.onPressed, {
    required this.command,
    this.hint,
  });
  final String label, command;
  final VoidCallback? onPressed;
  final String? hint;
}

/// A read-only preview; named commands operate on the selected resource.
/// All mutations use their existing controllers and account/session checks.
class SwarmResourcePreview extends StatefulWidget {
  const SwarmResourcePreview({
    super.key,
    required this.search,
    required this.controls,
    required this.onChoose,
    required this.onRefocus,
    required this.onManageModels,
    required this.onModalChanged,
    required this.onCommands,
  });
  final SwarmSearchController search;
  final SearchPreviewControls controls;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
  final Future<void> Function() onManageModels;
  final ValueChanged<bool> onModalChanged;
  final VoidCallback onCommands;

  @override
  State<SwarmResourcePreview> createState() => _SwarmResourcePreviewState();
}

class _SwarmResourcePreviewState extends State<SwarmResourcePreview> {
  AppNotifier get app => widget.search.app;
  SwarmDestination? get row => widget.search.selected;
  ModelSearchEntry? get model => widget.search.models?.entries[row?.modelId];
  final _pending = <String>{};
  final _errors = <String, String>{};

  @override
  void initState() {
    super.initState();
    widget.controls.dispatch = _dispatch;
    widget.controls.commands = _commands;
  }

  @override
  void dispose() {
    widget.controls.dispatch = null;
    widget.controls.commands = null;
    super.dispose();
  }

  bool _dispatch(String command) {
    if (command == 'picker.resource_more') {
      widget.onCommands();
      return true;
    }
    // Resolve at the key press, so a recent query/roster change cannot leave a
    // shortcut pointing at the previously rendered session or its old state.
    final action = [
      ..._actions(),
      ..._secondaryActions(),
      ..._filterActions(),
    ].where((action) => action.command == command).firstOrNull;
    if (action == null) return false;
    action.onPressed?.call();
    return true;
  }

  List<_ResourceAction> _filterActions() => [
    if (widget.search.activityFirst && widget.search.scopePrefix.isEmpty) ...[
      for (final filter in SessionFilter.values)
        _ResourceAction(
          switch (filter) {
            SessionFilter.all => 'Show all sessions',
            SessionFilter.needsInput => 'Show sessions needing input',
            SessionFilter.running => 'Show running sessions',
            SessionFilter.paused => 'Show paused sessions',
          },
          () => widget.search.setSessionFilter(filter),
          command: 'picker.filter.${filter.name}',
        ),
      for (final sort in SessionSort.values)
        _ResourceAction(
          'Sort sessions: ${sort.label}',
          () => widget.search.setSessionSort(sort),
          command: 'picker.sort.${sort.name}',
        ),
    ],
  ];

  List<SwarmDestination> _commands() => [
    for (final action in [
      ..._actions(),
      ..._secondaryActions(),
      ..._filterActions(),
    ])
      if (action.onPressed != null &&
          action.command != 'picker.accept' &&
          action.command != 'picker.resource_filter' &&
          action.command != 'picker.resource_sort')
        SwarmDestination(
          id: 'resource:${row?.id}:${action.command}',
          title:
              {
                    'picker.resource_toggle',
                    'picker.resource_rename',
                    'picker.resource_settings',
                    'picker.resource_remove',
                    'picker.resource_connect',
                  }.contains(action.command) &&
                  row?.isCreate != true &&
                  row != null
              ? '${action.label} “${row!.title}”'
              : action.label,
          detail: action.hint ?? '',
          swarmId: null,
          current: false,
          commandId: action.command,
        ),
  ];

  Future<void> _run(Future<String?> Function() action) async {
    final id = row?.id ?? widget.search.title;
    if (_pending.contains(id)) return;
    setState(() {
      _pending.add(id);
      _errors.remove(id);
    });
    String? error;
    try {
      error = await action();
    } catch (_) {
      error = 'Could not complete this action. Try again.';
    }
    if (!mounted) return;
    setState(() {
      _pending.remove(id);
      if (error != null) _errors[id] = error;
    });
  }

  Future<void> _dialog(Future<void> Function() action) async {
    widget.onModalChanged(true);
    try {
      await _run(() async {
        await action();
        return null;
      });
    } finally {
      widget.onModalChanged(false);
      if (mounted) widget.onRefocus();
    }
  }

  void _open() {
    final selected = row;
    if (selected == null) return;
    final choice = widget.search.submit(selected);
    if (choice != null) widget.onChoose(choice);
    widget.onRefocus();
  }

  HarnessSession? get _session {
    final selected = row;
    if (selected?.agentId == null) return null;
    final machine = app.stateOf(selected!.machineId!);
    final agent = machine?.agents
        .where((agent) => agent.id == selected.agentId)
        .firstOrNull;
    if (machine == null || agent == null) return null;
    return HarnessSession(
      machine: machine,
      agent: agent,
      open: app.allPanes.any(
        (pane) =>
            pane.machineId == selected.machineId && pane.agentId == agent.id,
      ),
      working: machine.processingAgentIds.contains(agent.id),
      question: machine.blockedAgents[agent.id],
    );
  }

  void _toggleHarness() {
    final session = _session;
    if (session == null || !session.canControl) return;
    final search = widget.search;
    search.holdRow(row!);
    unawaited(
      _run(() async {
        try {
          if (session.agent.isStopped) {
            return (await app.resumeAgent(
              session.machineId,
              session.agent.id,
            )).error;
          }
          return await app.pauseAgent(session.machineId, session.agent.id);
        } finally {
          search.releaseRow(session.id);
        }
      }),
    );
  }

  void _refreshModels() => unawaited(
    _run(() async {
      final catalog = widget.search.models!;
      await Future.wait([
        catalog.manager.refresh(force: true),
        catalog.manager.apis.refresh(),
        catalog.subscriptions.refresh(),
      ]);
      return catalog.manager.error ?? catalog.manager.apis.error;
    }),
  );

  List<_ResourceAction> _actions() {
    final search = widget.search;
    final selected = row;
    final busy = _pending.contains(selected?.id ?? search.title);
    if (selected?.isCreate == true) {
      return [
        _ResourceAction(
          selected!.title.replaceFirst('New ', 'Create '),
          busy ? null : _open,
          command: 'picker.accept',
        ),
        if (search.isModelMode)
          _ResourceAction(
            'Add API',
            () => _editApi(null),
            command: 'picker.resource_add_api',
          ),
      ];
    }
    if (search.isStoreMode) {
      return [
        _ResourceAction(
          'Open in Store',
          selected == null ? null : _open,
          command: 'picker.accept',
        ),
      ];
    }
    if (search.isModelMode) {
      final catalog = search.models!;
      final entry = model;
      final local = entry?.local;
      final api = entry?.api;
      return [
        if (local != null) ...[
          _ResourceAction(
            'Open Model Manager',
            busy ? null : () => unawaited(_dialog(widget.onManageModels)),
            command: 'picker.accept',
          ),
          _ResourceAction(
            catalog.manager.operationFor(local)?.active == true ||
                    catalog.manager.pendingId == local.id
                ? catalog.localStatus(local)
                : local.canStop
                ? 'Stop'
                : local.downloaded
                ? 'Start'
                : 'Download and start',
            busy ||
                    catalog.manager.busy ||
                    !catalog.manager.inventoryAvailable ||
                    (!local.canStart && !local.canStop)
                ? null
                : () => unawaited(
                    _run(() async {
                      await catalog.manager.toggle(local);
                      return catalog.manager.error;
                    }),
                  ),
            command: 'picker.resource_toggle',
            hint: local.canStop ? 'Free memory; keep the download.' : null,
          ),
        ] else if (api != null)
          _ResourceAction(
            'Edit',
            () => _editApi(api.id),
            command: 'picker.accept',
          )
        else
          _ResourceAction(
            'Open Model Manager',
            busy ? null : () => unawaited(_dialog(widget.onManageModels)),
            command: 'picker.accept',
          ),
      ];
    }
    if (selected?.isMachine == true) {
      final machine = app.stateOf(selected!.machineId!);
      if (machine == null) return [];
      return [
        _ResourceAction(
          'Open sessions on',
          busy ? null : _open,
          command: 'picker.accept',
        ),
        if (!machine.machine.isShared)
          _ResourceAction(
            'Rename',
            busy
                ? null
                : () => unawaited(
                    _dialog(
                      () => showMachineRenameDialog(
                        context,
                        app,
                        selected.machineId!,
                        machine.machine.displayName,
                      ),
                    ),
                  ),
            command: 'picker.resource_rename',
          ),
      ];
    }
    final session = _session;
    final pendingControl =
        session != null &&
        (app.pendingAgentPause(session.machineId, session.agent.id) != null ||
            app.pendingAgentStop(session.machineId, session.agent.id) != null ||
            app.restartAttempt(session.machineId, session.agent.id).busy);
    return [
      _ResourceAction(
        session?.needsInput == true
            ? 'Answer'
            : selected?.isProject == true
            ? 'Harnesses'
            : session?.agent.isStopped == true
            ? 'Resume & open'
            : 'Open',
        search.canAccept && !busy && !pendingControl ? _open : null,
        command: 'picker.accept',
      ),
      if (session != null)
        _ResourceAction(
          busy || pendingControl
              ? 'Working…'
              : session.agent.isStopped
              ? 'Resume'
              : 'Pause',
          !busy && !pendingControl && session.canControl
              ? _toggleHarness
              : null,
          command: 'picker.resource_toggle',
          hint:
              session.controlUnavailable ??
              (session.agent.resumesFreshConversation
                  ? 'Resumes as a new conversation.'
                  : null),
        ),
    ];
  }

  void _editApi(String? id) {
    final catalog = widget.search.models;
    if (catalog == null) return;
    unawaited(
      _dialog(() async {
        await showDialog<void>(
          context: context,
          builder: (context) => Dialog(
            child: SizedBox(
              width: 520,
              child: SingleChildScrollView(
                child: ApiConnectionsPanel(
                  controller: catalog.manager.apis,
                  query: '',
                  initialConnectionId: id,
                  onEditingChanged: (_) {},
                ),
              ),
            ),
          ),
        );
      }),
    );
  }

  List<_ResourceAction> _secondaryActions() {
    final search = widget.search;
    final selected = row;
    final busy = _pending.contains(selected?.id ?? search.title);
    final machine = selected?.machineId == null
        ? null
        : app.stateOf(selected!.machineId!);
    return [
      if (search.isModelMode) ...[
        _ResourceAction(
          'Refresh models',
          busy ? null : _refreshModels,
          command: 'picker.refresh',
        ),
        if (selected?.isCreate != true)
          _ResourceAction(
            'Add API connection',
            () => _editApi(null),
            command: 'picker.resource_add_api',
          ),
        if (model?.api case final api?) ...[
          _ResourceAction(
            'Edit connection',
            busy ? null : () => _editApi(api.id),
            command: 'picker.resource_settings',
          ),
          _ResourceAction(
            'Remove API connection…',
            () => unawaited(
              _dialog(() async {
                final remove = await showDialog<bool>(
                  context: context,
                  builder: (context) => AlertDialog(
                    title: Text('Remove ${api.name}?'),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: const Text('Cancel'),
                      ),
                      TextButton(
                        onPressed: () => Navigator.pop(context, true),
                        child: const Text('Remove'),
                      ),
                    ],
                  ),
                );
                if (remove == true && mounted) {
                  final controller = search.models!.manager.apis;
                  if (!await controller.remove(api.id) && mounted) {
                    setState(
                      () => _errors[selected!.id] =
                          controller.error ?? 'Could not remove API.',
                    );
                  }
                }
              }),
            ),
            command: 'picker.resource_remove',
          ),
        ],
      ] else if (selected?.isMachine == true && machine != null) ...[
        if (machine.needsLink && machine.nodeOnline != false)
          _ResourceAction(
            'Link',
            busy
                ? null
                : () => unawaited(
                    _dialog(
                      () => showLinkMachineScreenDialog(
                        context,
                        app,
                        selected!.machineId!,
                      ),
                    ),
                  ),
            command: 'picker.resource_connect',
          ),
        if (machine.isLocalMachine && !machine.machine.isShared)
          _ResourceAction(
            'Password / connection settings',
            () => unawaited(_dialog(() => showLinkMachineDialog(context, app))),
            command: 'picker.resource_settings',
          ),
        if (!machine.isLocalMachine && !machine.machine.isShared)
          _ResourceAction(
            'Remove from account…',
            () => unawaited(
              _dialog(
                () => confirmDeleteMachine(
                  context,
                  app,
                  machineId: machine.machine.machineId,
                  displayName: machine.machine.displayName,
                ),
              ),
            ),
            command: 'picker.resource_remove',
          ),
        _ResourceAction(
          'Link another machine',
          () => unawaited(
            _dialog(() => showLinkAnotherMachineDialog(context, app)),
          ),
          command: 'picker.resource_link',
        ),
        _ResourceAction(
          'Refresh machines',
          busy
              ? null
              : () => unawaited(
                  _run(() async {
                    await app.retryMachines();
                    await search.refreshMachineResources();
                    return app.machineListError;
                  }),
                ),
          command: 'picker.refresh',
        ),
      ] else if (!search.isStoreMode) ...[
        if (selected != null &&
            search.canAdd(selected) &&
            search.placement != HarnessPlacement.currentTab)
          _ResourceAction(
            'Add here',
            () => widget.onChoose(
              SwarmSearchSelection(selected, SwarmSearchAction.addHere),
            ),
            command: 'picker.add_here',
          ),
        if (search.activityFirst && search.scopePrefix.isEmpty) ...[
          _ResourceAction(
            'Filter: ${switch (search.sessionFilter) {
              SessionFilter.all => 'All',
              SessionFilter.needsInput => 'Needs input',
              SessionFilter.running => 'Running',
              SessionFilter.paused => 'Paused',
            }}',
            () => search.setSessionFilter(
              SessionFilter.values[(search.sessionFilter.index + 1) %
                  SessionFilter.values.length],
            ),
            command: 'picker.resource_filter',
          ),
          _ResourceAction(
            'Sort: ${search.sessionSort.label}',
            () => search.setSessionSort(
              SessionSort.values[(search.sessionSort.index + 1) %
                  SessionSort.values.length],
            ),
            command: 'picker.resource_sort',
          ),
        ],
      ],
    ];
  }

  Widget _modelPreview() {
    final catalog = widget.search.models!;
    final entry = model;
    if (entry == null) {
      return _details([
        catalog.manager.scanning ? 'Finding models…' : 'No matching models',
        ?catalog.manager.error,
      ]);
    }
    final local = entry.local;
    return _details([
      entry.name,
      [entry.source, entry.node].whereType<String>().join(' · '),
      '',
      entry.status,
      if (local != null) ...[
        if (local.sizeBytes case final size?)
          '${(size / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB download',
        ?local.quant,
        if (local.running && local.tokensPerSecond != null)
          '${local.tokensPerSecond!.toStringAsFixed(1)} tokens/sec',
        if (local.running &&
            local.requests != null &&
            local.windowSeconds != null)
          '${local.requests!.toInt()} requests / ${local.windowSeconds!.toInt()} sec',
        ?catalog.manager.operationFor(local)?.error,
        ?catalog.manager.error,
      ],
      if (entry.api case final api?) ...[
        api.baseUrl,
        api.keyEnv,
        'Available to harness tools on this computer.',
      ],
      if (entry.subscription case final subscription?) ...[
        if ('${subscription['account'] ?? ''}'.isNotEmpty)
          'Account ${subscription['account']}',
        ...((subscription['details'] as List?) ?? const [])
            .map((detail) => '$detail')
            .where((detail) => detail != entry.status),
      ],
    ]);
  }

  Widget _machineDetails() {
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final machine = app.stateOf(row!.machineId!);
    final online =
        machine != null &&
        machine.nodeOnline != false &&
        !machine.needsLink &&
        machine.connectionStatus == ConnectionStatus.connected;
    final resources = online
        ? widget.search.machineResources[row!.machineId]
        : null;
    final cpu = resources?.cpuPercent;
    final used = resources?.memoryUsedBytes;
    final total = resources?.memoryTotalBytes;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        cell.width * 2,
        cell.height,
        cell.width * 2,
        0,
      ),
      child: Text(
        [
          machine?.nodeOnline == false
              ? 'Offline'
              : machine?.needsLink == true
              ? 'Link required'
              : online
              ? 'Connected'
              : 'Offline',
          if (machine?.machine.isShared == true) 'View only',
          if (cpu != null) 'CPU ${cpu.round()}%',
          if (used != null && total != null)
            'RAM ${(used / (1024 * 1024 * 1024)).toStringAsFixed(1)} / ${(total / (1024 * 1024 * 1024)).toStringAsFixed(0)} GB',
        ].join(' · '),
        style: terminalContentStyle(
          color: theme.foreground.withValues(alpha: .54),
        ),
      ),
    );
  }

  Widget _details(List<String> lines) {
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return ListView(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      children: [
        for (var i = 0; i < lines.length; i++)
          if (lines[i].isEmpty)
            SizedBox(height: cell.height)
          else
            Text(
              lines[i],
              style: terminalContentStyle(
                color: i == 0
                    ? theme.foreground
                    : theme.foreground.withValues(alpha: .54),
              ),
            ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        widget.search,
        app,
        widget.search.models,
        terminalFontStore,
        grid.AppTheme.palette,
        terminalThemeStore,
      ]),
      builder: (context, _) {
        final cell = terminalCellSizeOf(context);
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_pending.contains(row?.id))
              Padding(
                padding: EdgeInsets.fromLTRB(
                  cell.width * 2,
                  cell.height,
                  cell.width * 2,
                  0,
                ),
                child: Text(
                  'Working…',
                  style: terminalContentStyle(
                    color: theme.foreground.withValues(alpha: .54),
                  ),
                ),
              ),
            if (_errors[row?.id] case final error?)
              Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: cell.width * 2,
                  vertical: cell.height,
                ),
                child: Text(
                  error,
                  style: terminalContentStyle(color: theme.yellow),
                ),
              ),
            if (row?.isMachine == true) _machineDetails(),
            Expanded(
              child: row?.isCreate == true
                  ? _details([
                      switch (widget.search.scopePrefix) {
                        '@' => 'Set up or link another computer.',
                        '#' => 'Choose a working folder for a project.',
                        ':' => 'Add a local model or connect an API.',
                        _ => 'Start a new harness.',
                      },
                      if (widget.search.isModelMode)
                        ?widget.search.models?.manager.error,
                    ])
                  : widget.search.isStoreMode
                  ? _details([
                      if (row?.storeId case final id?) ...[
                        widget.search.storeEntries[id]?.name ?? '',
                        widget.search.storeEntries[id]?.category ?? '',
                        '',
                        widget.search.storeEntries[id]?.description ?? '',
                        if (widget.search.storeEntries[id]?.author
                            case final author?)
                          'By $author',
                      ] else
                        'No matching store entries',
                    ])
                  : widget.search.isModelMode
                  ? _modelPreview()
                  : SwarmSearchPreview(
                      key: const ValueKey('swarm-search-preview'),
                      search: widget.search,
                      terminal: true,
                    ),
            ),
          ],
        );
      },
    );
  }
}
