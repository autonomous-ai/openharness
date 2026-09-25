import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../core/test_run.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
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
import 'machine_picker_form.dart';
import 'api_picker_form.dart';
import 'swarm_search_preview.dart';
import 'swarm_preview_scroll.dart';
import 'terminal_text_action.dart';

const resourcePickerCommands = {
  'picker.resource_toggle',
  'picker.resource_more',
  'picker.resource_rename',
  'picker.resource_settings',
  'picker.resource_connect',
  'picker.resource_link',
  'picker.resource_add_api',
  'picker.resource_remove',
  'picker.resource_filter',
  'picker.resource_sort',
  'picker.refresh',
  'picker.model_download',
  'picker.model_start',
  'picker.model_stop',
  'picker.machine_app',
  'picker.machine_cli',
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

/// Resource details and management share the picker’s keyboard and selection.
/// All mutations use their existing controllers and account/session checks.
class SwarmResourcePreview extends StatefulWidget {
  const SwarmResourcePreview({
    super.key,
    required this.search,
    required this.controls,
    required this.onChoose,
    required this.onRefocus,
    required this.onModalChanged,
    required this.onCommands,
  });
  final SwarmSearchController search;
  final SearchPreviewControls controls;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
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
  late SwarmPreviewScrollController _scroll;
  final _actionFocus = FocusNode(debugLabel: 'Resource controls');
  final _buttonFocus = <String, FocusNode>{};
  Timer? _resourceTimer;
  String? _focusedResource;
  bool _readingResources = false;
  MachinePickerFormKind? _machineForm;
  String? _formResource;
  var _formKey = GlobalKey<MachinePickerFormState>();
  final _messages = <String, String>{};
  bool _apiFormOpen = false, _apiRemoving = false;
  String? _apiResource, _apiConnectionId;
  var _apiFormKey = GlobalKey<ApiPickerFormState>();
  bool get _editingApi => _apiFormOpen && _apiResource == row?.id;

  bool get _machineSetup =>
      row?.isCreate == true && widget.search.isMachineMode;
  bool get _isManagement =>
      row?.isMachine == true || row?.isModel == true || _machineSetup;
  bool get _editingMachine => _machineForm != null && _formResource == row?.id;

  void _editMachine(MachinePickerFormKind kind) {
    setState(() {
      _formKey = GlobalKey<MachinePickerFormState>();
      _machineForm = kind;
      _formResource = row?.id;
    });
  }

  void _closeMachineForm(String? message) {
    if (!mounted) return;
    setState(() {
      if (message != null && row != null) _messages[row!.id] = message;
      _machineForm = null;
      _formResource = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusActions();
    });
  }

  void _addMachine() {
    final search = widget.search;
    search.setQuery('@');
    final index = search.rows.indexWhere((row) => row.isCreate);
    if (index >= 0) search.move(index - search.cursor);
    widget.onRefocus();
  }

  void _focusActions({bool last = false}) {
    final selectedId = row?.id;
    if (selectedId == null) return;
    void focus() {
      if (!mounted || row?.id != selectedId) return;
      final actions = _visibleActions()
          .where((a) => a.onPressed != null)
          .toList();
      final action = last ? actions.lastOrNull : actions.firstOrNull;
      final node = action == null ? _actionFocus : _buttonFocus[action.command];
      (node ?? _actionFocus).requestFocus();
      if (node?.context case final context?) Scrollable.ensureVisible(context);
    }

    if (widget.search.hasPreview) {
      focus();
    } else {
      widget.search.togglePreview();
      WidgetsBinding.instance.addPostFrameCallback((_) => focus());
    }
  }

  bool _traverseActions(bool forward, {bool stay = false}) {
    if (row == null ||
        widget.search.showsTypeHints ||
        !widget.search.supportsPreview) {
      return false;
    }
    if (!_actionFocus.hasFocus) {
      _focusActions(last: !forward);
      return true;
    }
    final actions = _visibleActions()
        .where((a) => a.onPressed != null)
        .toList();
    final index = actions.indexWhere(
      (a) => _buttonFocus[a.command]?.hasFocus == true,
    );
    final next = index < 0
        ? (forward ? 0 : actions.length - 1)
        : index + (forward ? 1 : -1);
    if (next < 0 || next >= actions.length) {
      if (!stay) widget.onRefocus();
    } else {
      final node = _buttonFocus[actions[next].command]!;
      node.requestFocus();
      if (node.context case final context?) Scrollable.ensureVisible(context);
    }
    return true;
  }

  void _searchChanged() {
    if (_apiFormOpen && _apiResource != row?.id) {
      _apiFormOpen = false;
      _apiResource = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onRefocus();
      });
    }
    if (_machineForm != null && _formResource != row?.id) {
      // A click/query change closes the old editor before any later reply.
      _machineForm = null;
      _formResource = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onRefocus();
      });
    }
    if (_actionFocus.hasFocus && _focusedResource != row?.id) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) widget.onRefocus();
      });
    }
  }

  Future<void> _readResources() async {
    if (_readingResources ||
        !widget.search.isMachineMode ||
        !app.inForeground) {
      return;
    }
    _readingResources = true;
    try {
      await widget.search.refreshMachineResources();
    } finally {
      _readingResources = false;
    }
  }

  @override
  void initState() {
    super.initState();
    _scroll = _scrollController();
    widget.controls.dispatch = _dispatch;
    widget.controls.commands = _commands;
    widget.search.addListener(_searchChanged);
    if (!kUnderTest) {
      _resourceTimer = Timer.periodic(
        const Duration(seconds: 10),
        (_) => unawaited(_readResources()),
      );
    }
  }

  SwarmPreviewScrollController _scrollController() =>
      SwarmPreviewScrollController(
        search: widget.search,
        lineHeight: () => terminalCellSizeOf(context).height,
      );

  @override
  void didUpdateWidget(SwarmResourcePreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != widget.search) {
      oldWidget.search.removeListener(_searchChanged);
      widget.search.addListener(_searchChanged);
      _scroll.dispose();
      _scroll = _scrollController();
    }
  }

  @override
  void dispose() {
    widget.controls.dispatch = null;
    widget.controls.commands = null;
    widget.search.removeListener(_searchChanged);
    _resourceTimer?.cancel();
    _actionFocus.dispose();
    for (final node in _buttonFocus.values) {
      node.dispose();
    }
    _scroll.dispose();
    super.dispose();
  }

  bool _dispatch(String command) {
    if (command == 'picker.complete' || command == 'picker.complete_back') {
      if (row == null || widget.search.showsTypeHints) return false;
      _switchPane();
      return true;
    }
    if (_editingApi &&
        widget.search.managing &&
        _apiFormKey.currentState?.handle(command) == true) {
      return true;
    }
    if (_editingMachine &&
        widget.search.managing &&
        _formKey.currentState?.handle(command) == true) {
      return true;
    }
    if (command == 'picker.resource_add_api' && widget.search.isModelMode) {
      _editApi(null);
      return true;
    }
    if (command == 'picker.focus_actions') {
      _focusPane();
      return row != null;
    }
    if (_actionFocus.hasFocus &&
        (command == 'picker.next' || command == 'picker.previous')) {
      return _traverseActions(command == 'picker.next', stay: true);
    }
    if (command == 'picker.cancel') {
      if (!_actionFocus.hasFocus) return false;
      widget.onRefocus();
      return true;
    }
    if (command == 'picker.accept') {
      if (_actionFocus.hasFocus) {
        if (_focusedResource != row?.id) {
          widget.onRefocus();
          return true;
        }
        final action = _visibleActions()
            .where((a) => _buttonFocus[a.command]?.hasFocus == true)
            .firstOrNull;
        action?.onPressed?.call();
        return true;
      }
      if (widget.search.canSelectModel(row) ||
          widget.search.isModelDownloadsRow(row)) {
        _open();
        return true;
      }
      if (widget.search.isModelMode) {
        if (row != null && widget.search.canGetModel(row)) {
          final selected = row!;
          unawaited(_run(() => widget.search.getModel(selected)));
        }
        if (row?.isCreate == true) _editApi(null);
        // Model rows perform Use/Get directly; unavailable rows stay put.
        return true;
      }
      if (_isManagement) {
        if (row?.isMachine == true && app.stateOf(row!.machineId!) == null) {
          return false;
        }
        _focusPane();
        return true;
      }
    }
    if (model?.local case final local?
        when command == 'picker.resource_toggle') {
      command = local.canStop
          ? 'picker.model_stop'
          : local.downloaded
          ? 'picker.model_start'
          : 'picker.model_download';
    }
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

  void _focusPane() {
    if (_editingApi) {
      _apiFormKey.currentState?.focus();
    } else if (_editingMachine) {
      _formKey.currentState?.focus();
    } else {
      _focusActions();
    }
  }

  void _switchPane() {
    if (widget.search.managing) {
      widget.onRefocus();
    } else {
      _focusPane();
    }
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
    for (final action in {
      for (final action in [
        ..._secondaryActions(),
        ..._filterActions(),
        ..._actions(),
      ])
        action.command: action,
    }.values)
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
        catalog.refresh(force: true),
        catalog.manager.apis.refresh(),
        catalog.subscriptions.refresh(),
      ]);
      return model?.controller?.error ??
          catalog.manager.error ??
          catalog.manager.apis.error;
    }),
  );

  void _refreshMachines() => unawaited(
    _run(() async {
      await app.retryMachines();
      await widget.search.refreshMachineResources();
      return app.machineListError;
    }),
  );

  List<_ResourceAction> _visibleActions() => [
    ..._actions(),
    if (!_isManagement && row?.isCreate != true && _commands().isNotEmpty)
      _ResourceAction(
        'Actions…',
        widget.onCommands,
        command: 'picker.resource_more',
      ),
  ];

  Widget _actionButtons() {
    final target = row?.id;
    final cell = terminalCellSizeOf(context);
    final controls = Focus(
      focusNode: _actionFocus,
      onFocusChange: (focused) {
        _focusedResource = focused ? row?.id : null;
        widget.search.setManaging(focused);
      },
      child: Wrap(
        key: const ValueKey('swarm-search-resource-actions'),
        spacing: cell.width * 2,
        runSpacing: cell.height,
        children: [
          for (final action in _visibleActions())
            TerminalTextAction(
              key: ValueKey('resource-action:${action.command}'),
              focusNode: _buttonFocus.putIfAbsent(
                action.command,
                () => FocusNode(debugLabel: action.label),
              ),
              label: action.label,
              padding: EdgeInsets.zero,
              onPressed: action.onPressed == null
                  ? null
                  : () {
                      if (row?.id != target) return;
                      // Resolve again so stale widgets cannot operate on an old resource.
                      final current = _visibleActions()
                          .where((a) => a.command == action.command)
                          .firstOrNull;
                      current?.onPressed?.call();
                    },
            ),
        ],
      ),
    );
    void next() => _traverseActions(true, stay: true);
    void previous() => _traverseActions(false, stay: true);
    if (KeymapTheme.of(context) != null) {
      return KeymapRegion(
        contextKind: KeymapContext.picker,
        actions: {
          ...?KeymapRegion.of(context)?.actions,
          'picker.next': next,
          'picker.previous': previous,
          'picker.control_next': next,
          'picker.control_previous': previous,
        },
        child: controls,
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.arrowRight): next,
        const SingleActivator(LogicalKeyboardKey.arrowDown): next,
        const SingleActivator(LogicalKeyboardKey.arrowLeft): previous,
        const SingleActivator(LogicalKeyboardKey.arrowUp): previous,
      },
      child: controls,
    );
  }

  Widget _controlHints() {
    String? key(String command) => effectiveCommandHint(
      context,
      command,
      contextKind: KeymapContext.picker,
    )?.replaceAll('⇥', 'Tab').replaceAll('↵', 'Enter');
    final managing = widget.search.managing;
    final starting =
        widget.search.usingModelId != null &&
        widget.search.usingModelId == row?.modelId;
    final hints = [
      if (managing &&
          key('picker.control_previous') != null &&
          key('picker.control_next') != null)
        '${key('picker.control_previous')}/${key('picker.control_next')} move',
      if (starting)
        'Starting…'
      else if (key('picker.accept') case final enter?
          when managing ||
              row?.isModel != true ||
              widget.search.canSelectModel(row) ||
              widget.search.canGetModel(row) ||
              widget.search.isModelDownloadsRow(row))
        '$enter ${managing
            ? 'select'
            : widget.search.canSelectModel(row)
            ? 'Use'
            : widget.search.canGetModel(row)
            ? 'Get'
            : widget.search.isModelDownloadsRow(row)
            ? widget.search.actionLabel(row)
            : _isManagement
            ? _machineSetup
                  ? 'setup'
                  : 'Manage'
            : widget.search.actionLabel(row)}',
      if (key('picker.complete') case final tab?) '$tab pane',
      if (key('picker.cancel') case final escape? when managing || starting)
        '$escape ${starting ? 'cancel' : 'back'}',
    ];
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      child: Text(
        hints.join('  ·  '),
        key: const ValueKey('resource-control-hints'),
        style: terminalContentStyle(
          color: theme.foreground.withValues(alpha: .54),
        ),
      ),
    );
  }

  List<_ResourceAction> _actions() {
    final search = widget.search;
    final selected = row;
    final busy = _pending.contains(selected?.id ?? search.title);
    if (search.isModelDownloadsRow(selected)) {
      return [
        _ResourceAction(
          search.modelDownloadsVisible ? 'Hide catalog' : 'Get models',
          _open,
          command: 'picker.accept',
        ),
      ];
    }
    if (selected?.isCreate == true) {
      if (search.isMachineMode) {
        return [
          _ResourceAction(
            'App',
            () => _editMachine(MachinePickerFormKind.app),
            command: 'picker.machine_app',
          ),
          _ResourceAction(
            'CLI',
            () => _editMachine(MachinePickerFormKind.cli),
            command: 'picker.machine_cli',
          ),
        ];
      }
      if (search.isModelMode) {
        return [
          _ResourceAction(
            'Add',
            busy ? null : () => _editApi(null),
            command: 'picker.accept',
          ),
        ];
      }
      return [
        _ResourceAction(
          selected!.title.replaceFirst('New ', 'Create '),
          busy ? null : _open,
          command: 'picker.accept',
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
      final local = model?.local;
      final api = model?.api;
      final owner = model?.controller ?? catalog.manager;
      if (local != null) {
        final enabled =
            !busy &&
            !owner.busy &&
            owner.inventoryAvailable &&
            owner.machine?.connectionStatus == ConnectionStatus.connected &&
            owner.machine?.needsLink == false &&
            (owner.targetMachineId == null ||
                owner.machine?.isOffline == false);
        final stop = local.canStop;
        final get = !stop && !local.downloaded;
        final action = stop
            ? 'stop'
            : get
            ? 'download'
            : 'start';
        return [
          _ResourceAction(
            stop
                ? 'Stop'
                : get
                ? 'Get'
                : 'Use',
            enabled &&
                    (stop ||
                        (get
                            ? local.canStart
                            : search.canSelectModel(selected)))
                ? !stop && !get
                      ? _open
                      : () => unawaited(
                          _run(() async {
                            await owner.control(
                              local,
                              get && !owner.supportsDownload ? 'start' : action,
                            );
                            return owner.error;
                          }),
                        )
                : null,
            command: 'picker.model_$action',
          ),
        ];
      }
      if (api != null) {
        return [
          _ResourceAction(
            'Edit',
            busy ? null : () => _editApi(api.id),
            command: 'picker.resource_settings',
          ),
          ..._secondaryActions().where(
            (a) => a.command == 'picker.resource_remove',
          ),
        ];
      }
      if (model?.subscription != null) {
        return [
          _ResourceAction(
            'Refresh',
            busy ? null : _refreshModels,
            command: 'picker.refresh',
          ),
        ];
      }
      return [
        _ResourceAction(
          'Use',
          !busy && search.canSelectModel(selected) ? _open : null,
          command: 'picker.accept',
        ),
      ];
    }
    if (selected?.isMachine == true) {
      final machine = app.stateOf(selected!.machineId!);
      if (machine == null) return [];
      final secondary = _secondaryActions();
      return [
        ...secondary.where((a) => a.command == 'picker.resource_connect'),
        ...secondary.where((a) => a.command == 'picker.resource_settings'),
        if (!machine.machine.isShared)
          _ResourceAction(
            'Rename',
            busy ? null : () => _editMachine(MachinePickerFormKind.rename),
            command: 'picker.resource_rename',
          ),
        ...secondary.where((a) => a.command == 'picker.resource_remove'),
        if (app.machineListError != null)
          _ResourceAction(
            'Retry',
            busy ? null : _refreshMachines,
            command: 'picker.refresh',
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

  void _editApi(String? id, {bool removing = false}) {
    final catalog = widget.search.models;
    if (catalog == null) return;
    setState(() {
      _apiFormKey = GlobalKey<ApiPickerFormState>();
      _apiResource = row?.id;
      _apiConnectionId = id;
      _apiRemoving = removing;
      _apiFormOpen = true;
    });
  }

  void _closeApiForm(String? id) {
    if (!mounted) return;
    setState(() {
      _apiFormOpen = false;
      _apiResource = null;
    });
    if (id?.isNotEmpty == true) {
      final search = widget.search;
      if (!search.rows.any((row) => row.modelId == 'model:api:$id')) {
        search.setQuery(':');
      }
      final index = search.rows.indexWhere(
        (row) => row.modelId == 'model:api:$id',
      );
      if (index >= 0) search.move(index - search.cursor);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) widget.onRefocus();
    });
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
            'Delete',
            () => _editApi(api.id, removing: true),
            command: 'picker.resource_remove',
          ),
        ],
      ] else if (selected?.isMachine == true && machine != null) ...[
        if (!machine.isLocalMachine &&
            machine.needsLink &&
            machine.nodeOnline != false)
          _ResourceAction(
            'Connect',
            busy ? null : () => _editMachine(MachinePickerFormKind.connect),
            command: 'picker.resource_connect',
          ),
        if (machine.isLocalMachine && !machine.machine.isShared)
          _ResourceAction(
            'Password',
            () => _editMachine(MachinePickerFormKind.password),
            command: 'picker.resource_settings',
          ),
        if (!machine.isLocalMachine && !machine.machine.isShared)
          _ResourceAction(
            'Delete',
            () => _editMachine(MachinePickerFormKind.delete),
            command: 'picker.resource_remove',
          ),
        _ResourceAction(
          'Add machine',
          _addMachine,
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
    if (widget.search.isModelDownloadsRow(row)) {
      return _details([
        'Get models',
        'Browse models available to download on your machines.',
      ], controls: true);
    }
    final entry = model;
    if (entry == null) {
      return _details([
        catalog.manager.scanning ? 'Finding models…' : 'No matching models',
      ]);
    }
    final local = entry.local;
    final owner = entry.controller ?? catalog.manager;
    final operation = local == null ? null : owner.operationFor(local);
    final pending = local != null && owner.pendingId == local.id;
    String window(double seconds) => seconds % 86400 == 0
        ? '${(seconds / 86400).toInt()}d'
        : seconds % 3600 == 0
        ? '${(seconds / 3600).toInt()}h'
        : '${seconds.toInt()}s';
    return _details([
      entry.name,
      if (widget.search.modelUseErrorId == entry.id)
        ?widget.search.modelUseError,
      [
        if (local == null) entry.source,
        ?entry.node,
        if (local?.sizeBytes case final size?)
          '${(size / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB',
      ].join(' · '),
      if (local != null) ...[
        if (local.running &&
            (local.tokensPerSecond != null || local.requests != null))
          [
            if (local.tokensPerSecond case final speed?)
              '${speed.toStringAsFixed(1)} tok/s',
            if (local.requests != null && local.windowSeconds != null)
              '${local.requests!.toInt()} requests / ${window(local.windowSeconds!)}',
          ].join(' · '),
        if (local.resting) 'Resting until your next message',
        if (pending || operation?.active == true || operation?.failed == true)
          catalog.localStatus(local, controller: owner),
        ?operation?.error,
        if (!local.downloaded &&
            !owner.supportsDownload &&
            local.canStart &&
            !pending &&
            operation?.active != true)
          'Downloads and starts on ${entry.node ?? 'this machine'}.',
      ] else if (entry.status != 'Available')
        entry.status,
      if (widget.search.modelUseReason(row) case final reason?
          when reason != 'No active harness' &&
              reason != entry.status &&
              reason != 'Tools only' &&
              reason != 'Download first')
        switch (reason) {
          'Claude only' => 'Use this subscription in a Claude harness.',
          'Codex only' => 'Use this subscription in a Codex harness.',
          'Other account' =>
            'This account is not signed in on the harness’s machine.',
          'Not serving' => 'Not serving on ${entry.node ?? 'its host'}.',
          _ => reason,
        },
      if (entry.own && local == null && owner.scanning)
        'Finding model controls…',
      if (!identical(owner, catalog.manager)) ...[
        if (owner.machine?.connectionStatus != ConnectionStatus.connected)
          'Connect to ${entry.node} to manage its models.'
        else
          ?owner.error,
      ],
      if (entry.api case final api?) ...[
        api.baseUrl,
        api.keyEnv,
        'Available to harness tools on this computer.',
      ],
      if (entry.subscription case final subscription?) ...[
        ...((subscription['details'] as List?) ?? const [])
            .map((detail) => '$detail')
            .where((detail) => detail != entry.status),
      ],
    ], controls: true);
  }

  Widget _machinePreview() {
    final machine = app.stateOf(row!.machineId!);
    if (machine == null) return _details([row!.title, 'Unavailable']);
    final online =
        machine.nodeOnline != false &&
        !machine.needsLink &&
        machine.connectionStatus == ConnectionStatus.connected;
    final resources = online
        ? widget.search.machineResources[row!.machineId]
        : null;
    final status = machine.nodeOnline == false
        ? 'Offline'
        : machine.needsLink
        ? 'Link required'
        : switch (machine.connectionStatus) {
            ConnectionStatus.connected => 'Connected',
            ConnectionStatus.connecting => 'Connecting',
            ConnectionStatus.reconnecting => 'Reconnecting',
            ConnectionStatus.disconnected => 'Offline',
          };
    return _details([
      row!.title,
      [
        status,
        if (machine.isLocalMachine) 'This computer',
        if (machine.machine.isShared) 'View only',
      ].join(' · '),
      '',
      if (resources?.cpuPercent case final cpu?) 'CPU ${cpu.round()}%',
      if (resources?.memoryUsedBytes != null &&
          resources?.memoryTotalBytes != null)
        'RAM ${(resources!.memoryUsedBytes! / (1024 * 1024 * 1024)).toStringAsFixed(1)} / ${(resources.memoryTotalBytes! / (1024 * 1024 * 1024)).toStringAsFixed(0)} GB',
      '${machine.agents.length} ${machine.agents.length == 1 ? 'harness' : 'harnesses'}',
      ?app.machineListError,
      ?_messages[row!.id],
    ], controls: true);
  }

  Widget _details(List<String> lines, {bool controls = false}) {
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return ListView(
      controller: _scroll,
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
        if (controls) ...[SizedBox(height: cell.height), _actionButtons()],
      ],
    );
  }

  Widget _typeHints() {
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return ListView(
      controller: _scroll,
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      children: [
        Column(
          key: const ValueKey('swarm-search-type-hints'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final (prefix, label) in [
              ('@', 'machines'),
              ('#', 'projects'),
              (':', 'models'),
              ('*', 'store'),
              ('>', 'commands'),
            ])
              TextButton(
                key: ValueKey('swarm-search-scope:$prefix'),
                onPressed: () {
                  widget.search.setQuery('$prefix ');
                  widget.onRefocus();
                },
                style: TextButton.styleFrom(
                  foregroundColor: theme.foreground.withValues(alpha: .54),
                  textStyle: terminalContentStyle(),
                  padding: EdgeInsets.zero,
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  shape: const RoundedRectangleBorder(),
                ),
                child: SizedBox(
                  height: cell.height,
                  child: Text('$prefix  $label'),
                ),
              ),
          ],
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
            if (widget.search.isModelMode &&
                widget.search.models?.manager.error != null)
              Padding(
                padding: EdgeInsets.fromLTRB(
                  cell.width * 2,
                  cell.height,
                  cell.width * 2,
                  0,
                ),
                child: Text(
                  'Local models · ${widget.search.models!.manager.error}',
                  key: const ValueKey('local-model-inventory-notice'),
                  style: terminalContentStyle(color: theme.yellow),
                ),
              ),
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
            Expanded(
              child: _editingApi
                  ? ApiPickerForm(
                      key: _apiFormKey,
                      controller: widget.search.models!.manager.apis,
                      connectionId: _apiConnectionId,
                      removing: _apiRemoving,
                      onClose: _closeApiForm,
                      onFocusChanged: widget.search.setManaging,
                      onSwitchPane: _switchPane,
                    )
                  : _editingMachine
                  ? MachinePickerForm(
                      key: _formKey,
                      app: app,
                      kind: _machineForm!,
                      machineId: row?.machineId,
                      onClose: _closeMachineForm,
                      onFocusChanged: widget.search.setManaging,
                      onSwitchPane: _switchPane,
                    )
                  : widget.search.showsTypeHints
                  ? _typeHints()
                  : row?.isCreate == true
                  ? _details([
                      ...widget.search.createDescription.split('\n'),
                    ], controls: _machineSetup)
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
                  : row?.isMachine == true
                  ? _machinePreview()
                  : widget.search.isModelMode
                  ? _modelPreview()
                  : SwarmSearchPreview(
                      key: const ValueKey('swarm-search-preview'),
                      search: widget.search,
                      terminal: true,
                    ),
            ),
            if (row != null &&
                !widget.search.showsTypeHints &&
                !_editingMachine &&
                !_editingApi) ...[
              if (!_isManagement)
                Padding(
                  padding: EdgeInsets.fromLTRB(
                    cell.width * 2,
                    cell.height,
                    cell.width * 2,
                    0,
                  ),
                  child: _actionButtons(),
                ),
              _controlHints(),
            ],
          ],
        );
      },
    );
  }
}
