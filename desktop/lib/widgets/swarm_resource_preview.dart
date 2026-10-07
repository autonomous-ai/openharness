import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../core/test_run.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../models/api_connections_controller.dart'
    show ApiModels, contextWindowLabel;
import '../models/local_model.dart';
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
import 'desktop_chrome.dart';
import 'key_hints.dart';

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

/// A block of text a person copies as it is — a command — drawn monospace and selectable by
/// [_SwarmResourcePreviewState._details].
class _Code {
  const _Code(this.text);
  final String text;
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
    this.resourcePollInterval,
    this.onViewMachine,
  });
  final SwarmSearchController search;
  final SearchPreviewControls controls;
  final ValueChanged<SwarmSearchSelection> onChoose;
  final VoidCallback onRefocus;
  final ValueChanged<bool> onModalChanged;
  final VoidCallback onCommands;

  /// Override the resource refresh cadence for an isolated fixture. Omitted
  /// intervals poll every ten seconds in the app and stay disabled in tests.
  final Duration? resourcePollInterval;

  /// Where View takes a machine instead of scoping the picker to it, when
  /// the host composition asks for that ([WorkspaceChrome.viewMachineCloses]).
  final ValueChanged<String>? onViewMachine;

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

  bool _isOnline(MachineState machine) =>
      machine.nodeOnline != false &&
      !machine.needsLink &&
      machine.connectionStatus == ConnectionStatus.connected;

  /// Scope the picker to this machine's harnesses — the same list Enter on
  /// a project/machine group opens, so Rename/Delete are not the only doors.
  void _viewMachine() {
    final selected = row;
    if (selected == null) return;
    if (widget.onViewMachine case final view?) {
      view(selected.machineId!);
      return;
    }
    if (!widget.search.scopeToGroup(selected.id)) return;
    widget.onRefocus();
  }

  void _focusActions() {
    final selectedId = row?.id;
    if (selectedId == null) return;
    void focus({bool afterBuild = false}) {
      if (!mounted || row?.id != selectedId) return;
      final actions = _visibleActions()
          .where((a) => a.onPressed != null)
          .toList();
      final action = actions.firstOrNull;
      final node = action == null ? _actionFocus : _buttonFocus[action.command];
      // A selection can arrive immediately before Return, before its preview
      // has built these buttons. Retry once after that frame rather than
      // focusing an unattached scope and losing the first keyboard action.
      if (!afterBuild && action != null && node?.context == null) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => focus(afterBuild: true),
        );
        WidgetsBinding.instance.ensureVisualUpdate();
        return;
      }
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

  bool _traverseActions(bool forward) {
    if (row == null ||
        widget.search.showsTypeHints ||
        !widget.search.supportsPreview) {
      return false;
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
    if (next >= 0 && next < actions.length) {
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
    final interval =
        widget.resourcePollInterval ??
        (kUnderTest ? null : const Duration(seconds: 10));
    if (interval != null) {
      _resourceTimer = Timer.periodic(
        interval,
        (_) => unawaited(_readResources()),
      );
    }
  }

  SwarmPreviewScrollController _scrollController() =>
      SwarmPreviewScrollController(
        search: widget.search,
        lineHeight: () => DesktopChrome.of(context)
            ? MediaQuery.textScalerOf(context).scale(13) * 1.5
            : terminalCellSizeOf(context).height,
      );

  @override
  void didUpdateWidget(SwarmResourcePreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controls != widget.controls) {
      if (oldWidget.controls.dispatch == _dispatch) {
        oldWidget.controls.dispatch = null;
      }
      if (oldWidget.controls.commands == _commands) {
        oldWidget.controls.commands = null;
      }
      widget.controls.dispatch = _dispatch;
      widget.controls.commands = _commands;
    }
    if (oldWidget.search != widget.search) {
      oldWidget.search.removeListener(_searchChanged);
      widget.search.addListener(_searchChanged);
      _scroll.dispose();
      _scroll = _scrollController();
    }
  }

  @override
  void dispose() {
    // A new palette can register its preview before the previous overlay is
    // disposed. Only release this preview's own callbacks.
    if (widget.controls.dispatch == _dispatch) widget.controls.dispatch = null;
    if (widget.controls.commands == _commands) widget.controls.commands = null;
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
    if (widget.search.isCommandMode || widget.search.isHelpMode) {
      // Command previews are read-only. Keep Tab from stepping results or
      // focusing resource controls that are not displayed in this scope.
      return command == 'picker.complete' || command == 'picker.complete_back';
    }
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
      _addApi();
      return true;
    }
    if (command == 'picker.focus_actions') {
      _focusPane();
      return row != null;
    }
    if (_actionFocus.hasFocus &&
        (command == 'picker.next' || command == 'picker.previous')) {
      return _traverseActions(command == 'picker.next');
    }
    if (command == 'picker.cancel') {
      if (!_actionFocus.hasFocus) return false;
      widget.onRefocus();
      return true;
    }
    if (command == 'picker.accept') {
      // An empty result remains an inert picker, including the native command
      // bridge. Consume Return so it cannot escape to the workspace beneath it.
      if (row == null) return true;
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
      // Get on a model the harness can run is Get and Use in one step: the choose path, as Use is.
      if (widget.search.canSelectModel(row) ||
          widget.search.canGetModelForUse(row) ||
          widget.search.isModelDownloadsRow(row) ||
          widget.search.isGridSetupRow(row) ||
          widget.search.canExpandApi(row)) {
        _open();
        return true;
      }
      if (widget.search.isModelMode) {
        if (row != null && widget.search.canGetModel(row)) {
          final selected = row!;
          unawaited(_run(() => widget.search.getModel(selected)));
        }
        // A Jev model has nothing to Use: Enter starts one of yours that is downloaded, and copies
        // how to call one that is on a grid.
        if (row != null && widget.search.canStartJev(row)) {
          final selected = row!;
          unawaited(_run(() => widget.search.startJev(selected)));
        } else if (widget.search.models?.entries[row?.modelId] case final jev?
            when jev.isJev &&
                jev.gridModel != null &&
                !widget.search.canGetModel(row)) {
          _copyJevRequest(jev);
        }
        if (row?.isCreate == true) _addApi();
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
            SessionFilter.all => 'Show all harnesses',
            SessionFilter.needsInput => 'Show harnesses needing input',
            SessionFilter.running => 'Show running harnesses',
            SessionFilter.paused => 'Show stopped harnesses',
          },
          () => widget.search.setSessionFilter(filter),
          command: 'picker.filter.${filter.name}',
        ),
      for (final sort in SessionSort.values)
        _ResourceAction(
          'Sort harnesses: ${sort.label}',
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
                    'picker.resource_view',
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
    // A control becomes disabled while its request is running. Return to the
    // query before Flutter drops that button's focus into an unnamed scope.
    if (_actionFocus.hasFocus) widget.onRefocus();
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
    if (selected == null || selected.agentId == null) return null;
    final machine = app.stateOf(selected.machineId!);
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
    if (session.agent.isStopped) {
      _open();
      return;
    }
    final search = widget.search;
    search.holdRow(row!);
    unawaited(
      _run(() async {
        try {
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
    final desktop = DesktopChrome.of(context);
    Widget button(_ResourceAction action) {
      final node = _buttonFocus.putIfAbsent(
        action.command,
        () => FocusNode(debugLabel: action.label),
      );
      final VoidCallback? invoke = action.onPressed == null
          ? null
          : () {
              if (row?.id != target) return;
              // Resolve again so stale widgets cannot act on an old resource.
              final current = _visibleActions()
                  .where((a) => a.command == action.command)
                  .firstOrNull;
              current?.onPressed?.call();
            };
      if (desktop) {
        final shortcut = effectiveCommandHint(
          context,
          action.command,
          contextKind: KeymapContext.picker,
        );
        return Semantics(
          liveRegion: action.label == 'Working…',
          child: DesktopPill(
            key: ValueKey('resource-action:${action.command}'),
            focusNode: node,
            label: action.label,
            compact: true,
            onPressed: invoke,
            foregroundColor: action.command == 'picker.resource_remove'
                ? Theme.of(context).colorScheme.error
                : null,
            tooltip: [action.label, ?shortcut].join(' · '),
          ),
        );
      }
      return TerminalTextAction(
        key: ValueKey('resource-action:${action.command}'),
        focusNode: node,
        label: action.label,
        padding: EdgeInsets.zero,
        onPressed: invoke,
      );
    }

    final controls = Focus(
      focusNode: _actionFocus,
      onFocusChange: (focused) {
        _focusedResource = focused ? row?.id : null;
        widget.search.setManaging(focused);
      },
      child: Wrap(
        key: const ValueKey('swarm-search-resource-actions'),
        spacing: desktop ? 8 : cell.width * 2,
        runSpacing: desktop ? 8 : cell.height,
        children: [for (final action in _visibleActions()) button(action)],
      ),
    );
    void next() => _traverseActions(true);
    void previous() => _traverseActions(false);
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
    final desktop = DesktopChrome.of(context);
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
        widget.search.usingLabel ?? 'Starting…'
      else if (key('picker.accept') case final enter?
          when managing ||
              row?.isModel != true ||
              widget.search.canSelectModel(row) ||
              widget.search.canGetModel(row) ||
              widget.search.isModelDownloadsRow(row) ||
              widget.search.isGridSetupRow(row) ||
              widget.search.canExpandApi(row) ||
              widget.search.isJevRow(row))
        '$enter ${managing
            ? 'select'
            : widget.search.isJevRow(row)
            ? widget.search.actionLabel(row)
            : widget.search.canSelectModel(row)
            ? 'Use'
            : widget.search.canGetModel(row)
            ? 'Get'
            : widget.search.isModelDownloadsRow(row) || widget.search.isGridSetupRow(row) || widget.search.canExpandApi(row)
            ? widget.search.actionLabel(row)
            : _isManagement
            ? _machineSetup
                  ? 'setup'
                  : 'Manage'
            : widget.search.actionLabel(row)}',
      if (key('picker.complete') case final tab?)
        '$tab ${desktop ? 'controls' : 'pane'}',
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
        horizontal: desktop ? 18 : cell.width * 2,
        vertical: desktop ? 12 : cell.height,
      ),
      child: Text(
        hints.join('  ·  '),
        key: const ValueKey('resource-control-hints'),
        style: desktop
            ? DesktopChrome.text(size: 11, color: DesktopChrome.muted)
            : terminalContentStyle(color: theme.muted),
      ),
    );
  }

  List<_ResourceAction> _actions() {
    final search = widget.search;
    final selected = row;
    if (selected == null) return const [];
    final busy = _pending.contains(selected.id);
    if (selected.isAgentChoice) {
      return [
        _ResourceAction(
          search.actionLabel(selected),
          search.canAccept && !busy ? _open : null,
          command: 'picker.accept',
        ),
      ];
    }
    if (search.isModelDownloadsRow(selected)) {
      return [
        _ResourceAction(
          search.actionLabel(selected),
          _open,
          command: 'picker.accept',
        ),
      ];
    }
    if (search.isGridSetupRow(selected)) {
      return [
        _ResourceAction(
          search.actionLabel(selected),
          search.models!.manager.settingUpGrid || app.signingIn ? null : _open,
          command: 'picker.accept',
        ),
      ];
    }
    if (selected.isCreate) {
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
            busy ? null : _addApi,
            command: 'picker.accept',
          ),
        ];
      }
      return [
        _ResourceAction(
          selected.title.replaceFirst('New ', 'Create '),
          busy ? null : _open,
          command: 'picker.accept',
        ),
      ];
    }
    if (search.isStoreMode) {
      return [
        _ResourceAction('Open in Store', _open, command: 'picker.accept'),
      ];
    }
    if (search.isModelMode) {
      final catalog = search.models!;
      final local = model?.local;
      final api = model?.api;
      final owner = model?.controller ?? catalog.manager;
      if (model case final jev? when jev.isJev) {
        final mine = jev.local;
        final operating =
            mine != null && owner.operationFor(mine)?.active == true;
        return [
          if (mine != null && mine.canStop)
            _ResourceAction(
              'Stop',
              busy || operating || owner.busy
                  ? null
                  : () => unawaited(
                      _run(() async {
                        await owner.control(mine, 'stop');
                        return owner.error;
                      }),
                    ),
              command: 'picker.model_stop',
            )
          else if (mine != null && !mine.downloaded)
            _ResourceAction(
              'Get',
              !busy && search.canGetModel(selected)
                  ? () => unawaited(_run(() => search.getModel(selected)))
                  : null,
              command: 'picker.model_download',
            )
          else if (mine != null)
            _ResourceAction(
              'Start',
              !busy && search.canStartJev(selected)
                  ? () => unawaited(_run(() => search.startJev(selected)))
                  : null,
              command: 'picker.model_start',
            ),
          if (jev.gridModel != null)
            _ResourceAction(
              'Copy request',
              () => _copyJevRequest(jev),
              command: 'picker.accept',
            ),
        ];
      }
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
                ? !stop && (!get || search.canGetModelForUse(selected))
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
      if (model?.apiModel != null) {
        return [
          _ResourceAction(
            'Use',
            !busy && search.canSelectModel(selected) ? _open : null,
            command: 'picker.accept',
          ),
        ];
      }
      if (api != null) {
        return [
          if (search.canExpandApi(selected))
            _ResourceAction(
              search.actionLabel(selected),
              _open,
              command: 'picker.accept',
            ),
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
    if (selected.isMachine) {
      final machine = app.stateOf(selected.machineId!);
      if (machine == null) return [];
      final secondary = _secondaryActions();
      return [
        if (_isOnline(machine))
          _ResourceAction(
            'View',
            _viewMachine,
            command: 'picker.resource_view',
          ),
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
            : selected.isProject
            ? 'Harnesses'
            : 'Open',
        search.canAccept && !busy && !pendingControl ? _open : null,
        command: 'picker.accept',
      ),
      if (session != null && !session.agent.isStopped)
        _ResourceAction(
          busy || pendingControl ? 'Working…' : 'Stop',
          !busy && !pendingControl && session.canControl
              ? _toggleHarness
              : null,
          command: 'picker.resource_toggle',
          hint:
              session.controlUnavailable ??
              (session.agent.resumesFreshConversation
                  ? 'Opens as a new conversation.'
                  : null),
        ),
    ];
  }

  void _addApi() => _editApi(null);

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
    // The editor owned the keys, and a removed widget reports no focus change: hand them back to
    // the list, or arrows keep acting for a pane that is no longer there.
    widget.search.setManaging(false);
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
            _addApi,
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
              SessionFilter.paused => 'Stopped',
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
    final catalog = widget.search.models;
    if (catalog == null) return _details(['No matching models']);
    if (widget.search.isGridSetupRow(row)) {
      final manager = catalog.manager;
      final here = thisComputerName();
      // Signed out of Harness: the set-up is done with the Harness account, so this starts there.
      // What a person reads names Harness only; Grid is how it works, not what they chose.
      final signedOut = app.isGuest;
      return _details([
        'Local & shared models',
        'Download models to run on $here, and use the models other people share with you.',
        '',
        if (signedOut) ...[
          "You're using Harness on this computer only. Local and shared models belong to your "
              'Harness account, so you need to sign in to use them.',
          "Sign in opens in your browser. Setup finishes here on its own once you're signed in.",
        ] else
          "Set up gets $here ready for them with your Harness account. You won't be asked to "
              'sign in again.',
        if (manager.settingUpGrid) ...[
          '',
          'Setting up…',
        ] else if (manager.setUpWaitsForSignIn) ...[
          '',
          'Signing in… Finish in your browser, and setup continues here.',
        ] else if (!signedOut && manager.gridSetupError != null) ...[
          '',
          'Could not set up: ${manager.gridSetupError}',
        ],
      ], controls: true);
    }
    if (widget.search.isModelDownloadsRow(row)) {
      return _details(
        widget.search.modelDownloadsVisible
            ? [
                'Show fewer',
                'Keep only the catalog\'s top ${SwarmSearchController.shownDownloads} in the list.',
              ]
            : [
                'More models',
                'The rest of the models the grid catalog ranks for this machine, best first.',
              ],
        controls: true,
      );
    }
    final entry = model;
    if (entry == null) {
      return _details([
        catalog.manager.scanning ? 'Finding models…' : 'No matching models',
      ]);
    }
    final desktop = DesktopChrome.of(context);
    final cell = desktop ? const Size(8, 16) : terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final local = entry.local;
    final owner = entry.controller ?? catalog.manager;
    final operation = local == null ? null : owner.operationFor(local);
    final pending = local != null && owner.pendingId == local.id;
    final opActive = operation?.active == true;
    // API entries have their own dedicated preview; keep main's dispatch.
    if (entry.api != null) return _apiPreview(entry);
    if (entry.isJev) return _jevPreview(entry);

    String windowLabel(double? seconds) {
      if (seconds == null) return '—';
      if (seconds > 0 && seconds % 86400 == 0) {
        return '${(seconds / 86400).toInt()}d';
      }
      if (seconds > 0 && seconds % 3600 == 0) {
        return '${(seconds / 3600).toInt()}h';
      }
      return '${(seconds / 60).round()}m';
    }

    final inUse = widget.search.modelRowInUse(row!);
    // The daemon refuses a download without its size and a gigabyte to spare; say so before Get.
    final size = local?.sizeBytes, free = owner.freeDiskBytes;
    final diskShort =
        local != null &&
        !local.downloaded &&
        !pending &&
        !opActive &&
        size != null &&
        free != null &&
        size + _kGiB > free;
    // "this Mac" in a sentence, "This Mac" as a value; another machine by its name.
    final machineName =
        identical(owner, catalog.manager) &&
            (owner.machine?.isLocalMachine ?? true)
        ? thisComputerName()
        : entry.node ?? 'its machine';
    final machineTitle = machineName == thisComputerName()
        ? '${machineName[0].toUpperCase()}${machineName.substring(1)}'
        : machineName;

    // The status word is the catalog's own [localStatus] so the pane and the
    // list row can never disagree (both come from the same [_refresh] snapshot);
    // no re-derivation from a possibly-stale operation on the pane side.
    final statusWord = local != null
        ? catalog.localStatus(local, controller: owner)
        : entry.status;

    Widget labelValue(String label, String value) {
      if (desktop) return _desktopDetail(label, value);
      return Padding(
        padding: EdgeInsets.only(bottom: cell.height * .6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            SizedBox(
              width: cell.width * 9,
              child: Text(
                label,
                style: terminalContentStyle(color: theme.muted),
              ),
            ),
            Expanded(
              child: Text(
                value,
                style: terminalContentStyle(color: theme.foreground),
              ),
            ),
          ],
        ),
      );
    }

    Widget errorLine(String text) {
      return Padding(
        padding: EdgeInsets.only(top: cell.height),
        child: Text(
          text,
          style: desktop
              ? DesktopChrome.text(
                  size: 12,
                  color: Theme.of(context).colorScheme.error,
                )
              : terminalContentStyle(color: theme.yellow),
        ),
      );
    }

    return ListView(
      controller: _scroll,
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      children: [
        Text(
          entry.name,
          style: desktop
              ? DesktopChrome.text(size: 15, medium: true)
              : terminalContentStyle(color: theme.foreground)
                    .copyWith(fontWeight: FontWeight.bold),
        ),
        SizedBox(height: cell.height),
        Text(
          inUse ? '$statusWord · this harness is on it' : statusWord,
          style: desktop
              ? DesktopChrome.text(size: 12, color: DesktopChrome.muted)
              : terminalContentStyle(color: theme.foreground),
        ),
        if (widget.search.modelUseErrorId == entry.id &&
            widget.search.modelUseError != null)
          errorLine(widget.search.modelUseError!),
        SizedBox(height: cell.height),
        if (local != null) ...[
          // A model another app downloaded starts in that app, joined to the grid from there.
          if (local.app case final app?) labelValue('Runs in', app),
          // What decides between models: what it costs to get, whether it fits, how fast it answers.
          if (local.sizeBytes case final size?)
            labelValue(
              local.downloaded ? 'Size' : 'Download',
              [
                gigabytesLabel(size),
                if (!local.downloaded && owner.freeDiskBytes != null)
                  '${gigabytesLabel(owner.freeDiskBytes!)} free',
              ].join(' · '),
            ),
          if ((local.sizeBytes, owner.memoryBytes) case (
            final size?,
            final memory?,
          ))
            labelValue(
              'Memory',
              '${size <= memory ? 'fits' : 'needs ${gigabytesLabel(size)}'} · '
                  '$machineName has ${gigabytesLabel(memory)}',
            ),
          if (local.running && local.tokensPerSecond != null)
            labelValue(
              'Speed',
              '${local.tokensPerSecond!.toStringAsFixed(1)} tok/s',
            )
          else if (local.estTokS case final estimate?)
            labelValue(
              'Speed',
              '~${estimate.round()} tok/s on $machineName (estimate)',
            ),
          if (local.contextWindow case final window?)
            labelValue('Context', contextWindowLabel(window.toInt())),
          if (local.paramsB case final params?)
            labelValue(
              'Params',
              '${params == params.roundToDouble() ? params.toInt() : params}B',
            ),
          labelValue('Quant', local.quantization ?? '—'),
          labelValue('Machine', machineTitle),
          if (local.running &&
              local.requests != null &&
              local.windowSeconds != null)
            labelValue(
              'Window',
              '${local.requests!.toInt()} req / ${windowLabel(local.windowSeconds)}',
            ),
          if (local.resting)
            labelValue('State', 'Resting until your next message'),
          if (diskShort)
            errorLine('Free up disk space on $machineName to get it.')
          else if (!local.downloaded &&
              !owner.supportsDownload &&
              local.canStart &&
              !pending &&
              !opActive)
            errorLine(
              'Downloads and starts on ${entry.node ?? 'this machine'}.',
            ),
          if (_enterSentence(local) case final sentence?) ...[
            SizedBox(height: cell.height * .4),
            Text(
              sentence,
              style: desktop
                  ? DesktopChrome.text(size: 12, color: DesktopChrome.muted)
                  : terminalContentStyle(color: theme.foreground),
            ),
          ],
        ] else ...[
          if (!desktop || entry.node != null || entry.source == 'Local')
            labelValue(
              'Machine',
              entry.node ??
                  (entry.source == 'Local' ? machineTitle : entry.source),
            ),
          if (entry.subscription case final subscription?) ...[
            ...((subscription['details'] as List?) ?? const [])
                .map((d) => '$d')
                .where((d) => d != entry.status)
                .take(3)
                .map((d) => labelValue('Detail', d)),
          ],
          labelValue('Source', entry.source),
        ],
        // While Use stops the model running there, the host is busy with that stop: the hint says so.
        if (widget.search.modelUseReason(row) case final reason?
            when widget.search.usingModelId != row?.modelId &&
                reason != 'No active harness' &&
                reason != entry.status &&
                reason != 'Tools only' &&
                reason != 'Download first')
          errorLine(switch (reason) {
            'Claude only' => 'Use this subscription in a Claude harness.',
            'Codex only' => 'Use this subscription in a Codex harness.',
            'Other account' =>
              'This account is not signed in on the harness’s machine.',
            'Not serving' => 'Not serving on ${entry.node ?? 'its host'}.',
            _ => reason,
          }),
        if (entry.own && local == null && owner.scanning)
          errorLine('Finding model controls…'),
        if (!identical(owner, catalog.manager)) ...[
          if (owner.machine?.connectionStatus != ConnectionStatus.connected)
            errorLine('Connect to ${entry.node} to manage its models.')
          else if (owner.error case final err?)
            errorLine(err),
        ],
        if (operation?.error case final err?) errorLine(err),
        if (catalog.manager.error case final err?) errorLine(err),
        if (!desktop) ...[SizedBox(height: cell.height), _actionButtons()],
      ],
    );
  }

  static const _kGiB = 1024 * 1024 * 1024;

  /// What Enter does on a model of yours, in words, under its facts. Nothing when it does nothing.
  String? _enterSentence(LocalModel local) {
    final search = widget.search;
    final selected = row;
    if (selected == null || search.modelRowInUse(selected)) return null;
    // One local model runs at a time: Use and Get stop the one running, then start this one.
    final other = search.otherRunningModel(selected)?.name;
    if (search.canGetModelForUse(selected)) {
      return other == null
          ? 'Get downloads it, starts it, and moves this harness onto it.'
          : 'Get downloads it, stops $other, starts it, and moves this harness onto it.';
    }
    if (search.canGetModel(selected)) {
      return other == null
          ? 'Get downloads it.'
          : 'Get downloads it. Stop $other to run it: one local model runs at a time.';
    }
    if (search.canSelectModel(selected)) {
      return local.running
          ? 'Use moves this harness onto it.'
          : other == null
          ? 'Use starts it and moves this harness onto it.'
          : 'Use stops $other, starts this one, and moves this harness onto it.';
    }
    return null;
  }

  static const _kDetailLabelColumns = 9;

  /// A saved API, or one of its models: a summary line, then labelled facts, then what it is for.
  Widget _apiPreview(ModelSearchEntry entry) {
    final api = entry.api!;
    final listed = widget.search.models!.manager.apis.models[api.id];
    final model = entry.apiModel;
    if (model != null) {
      final reason = widget.search.modelUseReason(row);
      return _details([
        entry.name,
        [
          api.name,
          if (model.contextWindow case final window?)
            '${contextWindowLabel(window)} context',
        ].join(' · '),
        '',
        if (model.name case final name?) ('Name', name),
        ('Via', '${api.name} · ${api.host}'),
        '',
        if (reason == null)
          'Use runs this harness on it, with the key saved on '
              '${widget.search.models!.manager.apis.hostLabel}.'
        else if (reason == 'Other machine')
          'Its key is saved on ${widget.search.models!.manager.apis.hostLabel}, '
              'so only the harnesses there can run on it.'
        else
          reason,
      ], controls: true);
    }
    final count = listed?.models.length ?? 0;
    // One line for what the API is for: a harness runs on its models (Use), or harness agents call
    // it (Tools) — fal.ai, Replicate, and any API that lists no models a coding agent can run on.
    final summary = !api.servesModels || count > 0
        ? null
        : switch (listed) {
            ApiModels(loading: true) => 'Loading models…',
            ApiModels(error: _?) => 'Models unavailable',
            _ => null,
          };
    return _details([
      entry.name,
      ['API', ?summary].join(' · '),
      '',
      ('URL', api.baseUrl),
      if (count > 0)
        (
          'Use',
          'pick one of its $count ${count == 1 ? 'model' : 'models'} to run a harness on it',
        )
      else if (summary == null)
        (
          'Tools',
          'harness agents on this computer can call it with the saved key',
        ),
      if (listed?.error case final error?) ...['', error],
    ], controls: true);
  }

  /// A Jev model's pane: what it is, and how to call it — no harness runs on it.
  Widget _jevPreview(ModelSearchEntry entry) {
    final served = entry.gridModel;
    final local = entry.local;
    final catalog = widget.search.models!;
    final owner = entry.controller ?? catalog.manager;
    final grid = served?.grid ?? '';
    final state = catalog.manager.sections
        .where((section) => section.name == grid)
        .firstOrNull
        ?.state;
    final operation = local == null ? null : owner.operationFor(local);
    final here = thisComputerName();
    final machine = local != null
        ? '${here[0].toUpperCase()}${here.substring(1)}'
        : entry.node;
    return _details([
      entry.name,
      ['Jev model', ?machine, if (grid.isNotEmpty) grid].join(' · '),
      '',
      'Answers questions about a state with probabilities: a choice between named options, '
          'yes or no, or a score. It does not chat, so no harness runs on it.',
      if (local != null) ...[
        '',
        if (operation?.active == true)
          catalog.localStatus(local, controller: owner)
        else if (operation?.error case final error?)
          error
        else if (local.running)
          'Running on $here, on your grid.'
        else if (local.downloaded)
          'Downloaded. Start runs it on your grid, beside the models already running there.'
        else
          'Get downloads it${local.sizeBytes == null ? '' : ' (${gigabytesLabel(local.sizeBytes!)})'}, '
              'updates Grid\'s model engine first if it is too old to serve Jev models, and runs it '
              'on your grid, beside the models already running there.',
        '',
        if (local.sizeBytes case final size?) ('Size', gigabytesLabel(size)),
        ('Runs in', 'Grid\'s llama.cpp'),
      ],
      if (served == null)
        ...[]
      else if (served.unavailable case final away?) ...[
        '',
        '${away.machine} seems offline. It answers again when that computer is back.',
      ] else if (state == GridSectionState.asleep ||
          state == GridSectionState.waking) ...[
        '',
        'Its grid is resting. Your first request wakes it, which takes a few seconds.',
      ],
      if (served != null) ...[
        '',
        ('Model', entry.name),
        if (grid.isNotEmpty) ('Grid', grid),
        ('Endpoint', 'POST \$OPENAI_BASE_URL/systemone'),
        '',
        'Call it from a terminal:',
        _Code(jevRequest(grid, entry.name)),
        ?_messages[row!.id],
        '',
        'The first line loads this grid\'s address and key into your shell; the key is never '
            'shown here. Each question is a choice (named options), a noul (yes or no) or a score '
            '(2–10 ordered levels).',
      ],
    ], controls: true);
  }

  void _copyJevRequest(ModelSearchEntry entry) {
    final id = row?.id;
    unawaited(
      Clipboard.setData(
        ClipboardData(
          text: jevRequest(entry.gridModel?.grid ?? '', entry.name),
        ),
      ).then((_) {
        if (mounted && id != null) {
          setState(() => _messages[id] = 'Copied. Paste it into a terminal.');
        }
      }),
    );
  }

  Widget _machinePreview() {
    final machine = app.stateOf(row!.machineId!);
    if (machine == null) return _details([row!.title, 'Unavailable']);
    final resources = _isOnline(machine)
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

  Widget _desktopDetail(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: LayoutBuilder(
      builder: (context, constraints) {
        final scale = MediaQuery.textScalerOf(context).scale(12) / 12;
        final style = DesktopChrome.text(size: 12, color: DesktopChrome.muted);
        // Keep the shared label column wide enough for its longest label in
        // the actual system font, including enlarged accessibility text.
        final measure = TextPainter(
          text: TextSpan(text: 'Machine', style: style),
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
          maxLines: 1,
        )..layout();
        final labelWidth = math.max(72 * scale, measure.width + 12);
        measure.dispose();
        final labelText = Text(label, style: style);
        final valueText = Text(value, style: DesktopChrome.text(size: 12));
        return constraints.maxWidth < 260 * scale
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [labelText, const SizedBox(height: 2), valueText],
              )
            : Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: labelWidth, child: labelText),
                  Expanded(child: valueText),
                ],
              );
      },
    ),
  );

  /// The preview's lines: the first is the title, `''` is a blank row, and a `(label, value)`
  /// pair is a labelled row — [_kDetailLabelColumns] terminal columns of label.
  Widget _details(List<Object> lines, {bool controls = false}) {
    if (DesktopChrome.of(context)) {
      return ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(18),
        children: [
          for (var i = 0; i < lines.length; i++)
            switch (lines[i]) {
              '' => const SizedBox(height: 12),
              (final String label, final String value) => _desktopDetail(
                label,
                value,
              ),
              final _Code code => Container(
                margin: const EdgeInsets.only(top: 4, bottom: 4),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: DesktopChrome.field,
                  border: Border.all(color: DesktopChrome.rim),
                  borderRadius: BorderRadius.circular(
                    DesktopChrome.controlRadius,
                  ),
                ),
                child: SelectableText(
                  code.text,
                  style: DesktopChrome.text(size: 11.5)
                      .copyWith(fontFamily: grid.AppType.monoFamily),
                ),
              ),
              final line => Padding(
                padding: EdgeInsets.only(bottom: i == 0 ? 5 : 3),
                child: Text(
                  '$line',
                  style: DesktopChrome.text(
                    size: i == 0 ? 15 : 12,
                    medium: i == 0,
                    color: i == 0
                        ? DesktopChrome.foreground
                        : DesktopChrome.muted,
                  ),
                ),
              ),
            },
        ],
      );
    }
    final cell = terminalCellSizeOf(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final muted = terminalContentStyle(color: theme.muted);
    return ListView(
      controller: _scroll,
      padding: EdgeInsets.symmetric(
        horizontal: cell.width * 2,
        vertical: cell.height,
      ),
      children: [
        for (var i = 0; i < lines.length; i++)
          switch (lines[i]) {
            '' => SizedBox(height: cell.height),
            final _Code code => SelectableText(
              code.text,
              style: terminalContentStyle(color: theme.foreground),
            ),
            (final String label, final String value) => Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: cell.width * _kDetailLabelColumns,
                  child: Text(label, style: muted),
                ),
                Expanded(
                  child: Text(
                    value,
                    style: terminalContentStyle(color: theme.foreground),
                  ),
                ),
              ],
            ),
            final line => Text(
              '$line',
              style: i == 0
                  ? terminalContentStyle(color: theme.foreground)
                  : muted,
            ),
          },
        if (controls) ...[SizedBox(height: cell.height), _actionButtons()],
      ],
    );
  }

  Widget _typeHints() {
    if (DesktopChrome.of(context)) {
      return ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(18),
        children: [
          Text(
            'Find your next task',
            style: DesktopChrome.text(size: 15, medium: true),
          ),
          const SizedBox(height: 6),
          Text(
            'Search harnesses, or type a prefix to choose a category.',
            style: DesktopChrome.text(size: 12, color: DesktopChrome.muted),
          ),
          const SizedBox(height: 12),
          Wrap(
            key: const ValueKey('swarm-search-type-hints'),
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final (prefix, label) in [
                ('@', 'Machines'),
                ('#', 'Projects'),
                (':', 'Models'),
                ('*', 'Store'),
                ('>', 'Commands'),
              ])
                DesktopPill(
                  key: ValueKey('swarm-search-scope:$prefix'),
                  label: '$prefix  $label',
                  compact: true,
                  onPressed: () {
                    widget.search.setQuery('$prefix ');
                    widget.onRefocus();
                  },
                ),
            ],
          ),
        ],
      );
    }
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
                  foregroundColor: theme.muted,
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
        if (widget.search.isCommandMode || widget.search.isHelpMode) {
          return SwarmSearchPreview(
            key: const ValueKey('swarm-search-preview'),
            search: widget.search,
            terminal: true,
          );
        }
        final desktop = DesktopChrome.of(context);
        final cell = desktop ? const Size(9, 12) : terminalCellSizeOf(context);
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final showsHints = KeyHints.visibleOf(context);
        final actions = [
          if (desktop || !_isManagement)
            Padding(
              padding: EdgeInsets.fromLTRB(
                cell.width * 2,
                cell.height,
                cell.width * 2,
                // The hints line is the gap under the buttons; without it
                // they would sit on the panel's edge.
                showsHints ? 0 : cell.height,
              ),
              child: _actionButtons(),
            ),
          if (showsHints) _controlHints(),
        ];
        return LayoutBuilder(
          builder: (context, constraints) => Column(
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
                    style: desktop
                        ? DesktopChrome.text(
                            size: 12,
                            color: Theme.of(context).colorScheme.error,
                          )
                        : terminalContentStyle(color: theme.yellow),
                  ),
                ),
              if (_pending.contains(row?.id) && (!desktop || _session == null))
                Padding(
                  padding: EdgeInsets.fromLTRB(
                    cell.width * 2,
                    cell.height,
                    cell.width * 2,
                    0,
                  ),
                  child: Text(
                    'Working…',
                    style: desktop
                        ? DesktopChrome.text(
                            size: 12,
                            color: DesktopChrome.muted,
                          )
                        : terminalContentStyle(color: theme.muted),
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
                    style: desktop
                        ? DesktopChrome.text(
                            size: 12,
                            color: Theme.of(context).colorScheme.error,
                          )
                        : terminalContentStyle(color: theme.yellow),
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
                    : row?.isAgentChoice == true
                    ? _details([
                        row!.title,
                        row!.detail,
                        if (widget.search.canAccept && !row!.current) ...[
                          '',
                          'Saves the current conversation, then starts a new one in the same folder. Your panes stay in place.',
                        ],
                      ])
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
                if (desktop)
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: math.min(140, constraints.maxHeight * .55),
                    ),
                    child: SingleChildScrollView(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: actions,
                      ),
                    ),
                  )
                else
                  ...actions,
              ],
            ],
          ),
        );
      },
    );
  }
}
