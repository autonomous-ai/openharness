import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../analytics/analytics.dart';
import '../core/desktop_window.dart';
import '../core/harness_file_store.dart';
import '../core/project_folder.dart';
import '../core/test_run.dart';
import '../logging/debug_surface.dart';
import '../settings/settings_screen.dart';
import '../settings/settings_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_shortcuts.dart';
import '../core/models.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_host.dart';
import '../shortcuts/keymap_native.dart';
import '../shortcuts/keymap_settings.dart';
import '../state/app_state.dart';
import '../state/harness_sessions.dart';
import '../state/harness_placement.dart';
import '../state/new_harness.dart';
import '../state/pane_arrangement.dart';
import '../terminal/terminal_viewport.dart';
import '../terminal/terminal_text.dart';
import '../usage/models_menu_controller.dart';
import '../state/swarm_catalog.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../state/swarm.dart';
import '../state/terminal_pane.dart';
import '../widgets/transient_menus.dart';
import '../widgets/layout_palette.dart';
import '../widgets/move_pane_palette.dart';
import '../widgets/engine_identity.dart';
import '../store/store_mark.dart';
import '../store/store_screen.dart';
import '../widgets/harness_start_page.dart';
import '../widgets/link_machine_screen.dart';
import '../widgets/machine_actions.dart';
import '../widgets/rename_agent_dialog.dart';
import '../widgets/delete_agent_dialog.dart';
import '../widgets/fork_agent_dialog.dart';
import '../widgets/restart_agent_action.dart';
import '../widgets/machines_manager.dart';
import '../widgets/new_agent_dialog.dart';
import '../widgets/box_chrome.dart';
import '../widgets/new_harness_box.dart';
import '../widgets/open_harness_intent.dart';
import '../widgets/pane_grid.dart';
import '../widgets/pane_minimize.dart';
import '../widgets/harness_session_manager.dart';
import '../widgets/remote_folder_picker.dart';
import '../widgets/shortcuts_sheet.dart';
import '../widgets/harness_customize_pane.dart';
import '../shared/widgets/app_dialog.dart';
import '../widgets/swarm_dialogs.dart';
import '../widgets/swarm_search_input.dart';
import '../widgets/swarm_switcher.dart';
import '../widgets/swarm_wallpaper.dart';
import '../widgets/swarm_icon.dart';
import '../widgets/task_palette.dart';
import '../state/command_bar.dart';
import '../state/command_bar_catalog.dart';
import '../widgets/harness_command_bar.dart';
import '../orchestrator/orchestrator_launcher.dart';
import '../orchestrator/orchestrator_workspace.dart';
import '../state/workspace_learning.dart';
import '../widgets/workspace_quick_start.dart';
import '../widgets/workspace_start_guide.dart';
import '../widgets/workspace_welcome.dart';
import '../shortcuts/keyboard_practice.dart';
import '../widgets/agent_alert_banners.dart';

class SwarmScreen extends StatefulWidget {
  const SwarmScreen({
    super.key,
    required this.notifier,
    this.nativeTabs,
    this.projectStore,
    this.modelsMenu,
    this.commandBarEnabled = const bool.fromEnvironment(
      'JEV_COMMAND_BAR',
      defaultValue: true,
    ),
    this.commandResolver,
    this.learning,
  });
  final AppNotifier notifier;
  final bool? nativeTabs;
  final SwarmProjectStore? projectStore;
  final ModelsMenuController? modelsMenu;
  final bool commandBarEnabled;
  final CommandResolver? commandResolver;
  final WorkspaceLearning? learning;
  @override
  State<SwarmScreen> createState() => _SwarmScreenState();
}

enum _NewHarnessSource { workspace, product }

/// Drafts belong to the entry's source, before the person edits its defaults.
/// Product requests also name an agent explicitly: two Store pages must never
/// resume one another's drafts. Placement remains separate, so Cmd-T and Cmd-P
/// can resume the same workspace draft in the newly requested destination.
typedef _NewHarnessContext = ({
  _NewHarnessSource source,
  String machineId,
  String? requestedEngine,
  String? sourceAgentId,
  String? folder,
  String? projectName,
});

/// The command box's title line, a step quieter than the rows under it.
TextStyle get _boxCaption =>
    grid.AppType.monoLabel(color: kBoxFaint, fontWeight: FontWeight.w400);

class _SwarmScreenState extends State<SwarmScreen>
    with SingleTickerProviderStateMixin {
  static const _channel = MethodChannel('harness/swarm_tabs');
  late final bool _native =
      widget.nativeTabs ?? (Platform.isMacOS && !kUnderTest);
  late final SwarmProjectStore _projects =
      widget.projectStore ??
      SwarmProjectStore(storage: kUnderTest ? null : HarnessFileStore.shared);
  StreamSubscription<SpokenTaskRequest>? _spokenTasks;
  final _shellFocus = FocusNode(debugLabel: 'Swarm shell');
  final _sessionsButton = GlobalKey();
  OverlayEntry? _sessionsOverlay;
  VoidCallback? _unregisterSessions;
  late final _minimize = PaneMinimizeController(vsync: this);
  bool _closingPane = false;
  OverlayEntry? _minimizeOverlay;
  final _startSearchFocus = FocusNode(debugLabel: 'Start page search');
  final _commandFocus = FocusNode(debugLabel: 'Ask Harness');
  bool _commandBarOpen = false;
  bool _commandActionInFlight = false;
  FocusNode? _commandReturnFocus;
  bool get _hasCommandBar => widget.commandBarEnabled && app.viewer == null;
  late final _commandBar = CommandBarController(
    catalog: () => buildCommandBarCatalog(
      app,
      commands: _searchCommands(),
      runCommand: _runShortcut,
      recent: _navigation.recent,
      create: (machineId, engine, prompt) =>
          _newAgent(machineId: machineId, engine: engine, task: prompt),
    ),
    resolve:
        widget.commandResolver ??
        (request, cancel) =>
            app.api.resolveCommandBar(request, cancelToken: cancel),
  )..addListener(_commandChanged);
  final _canvasFocus = FocusNode(
    debugLabel: 'Swarm canvas',
    canRequestFocus: false,
    skipTraversal: true,
  );
  late final _navigation = SwarmNavigationHistory(
    storage: kUnderTest ? null : HarnessFileStore.shared,
  );
  final _searchCatalog = SwarmSearchCatalog();
  final _searchText = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Find a harness');
  final _tabScroll = ScrollController();
  ({String activeId, List<String> order, double viewport})? _tabGeometry;
  bool _tabRevealScheduled = false;
  SwarmSearchController? _search;
  OverlayEntry? _searchOverlay;

  /// New Harness, open in the box. Never open beside the search: they are two
  /// modes of one surface, and opening either closes the other.
  NewHarnessController? _newHarness;
  OverlayEntry? _newHarnessOverlay;

  /// Escape keeps unfinished work with the machine/project/agent it started
  /// from. Switching context must not carry a task into the wrong project or
  /// silently reset its edited permissions. These buffers live for this window.
  final _newHarnessDrafts = <_NewHarnessContext, NewHarnessDraft>{};
  _NewHarnessContext? _newHarnessContext;
  (String, bool, String, HarnessPlacement?)? _searchHeaderState;
  FocusNode? _searchReturnFocus;
  (String, bool)? _lastWorkspace;
  bool _spokenPaletteOpen = false;
  bool _dialogOpen = false;
  bool _routeIsCurrent = true;
  String? _linkDialogMachineId;
  String? _nativeState;
  List<Object?>? _machinesPresentation;
  ModelsMenuController? _modelsMenu;
  String? _modelsState;
  final _defaultKeymap = AppKeymap();
  AppKeymap? _providedKeymap;
  AppKeymap get _keymap => _providedKeymap ?? _defaultKeymap;
  String? _nativeKeyContext;
  String _pendingKeys = '';
  AppNotifier get app => widget.notifier;
  late final _learning =
      widget.learning ??
      WorkspaceLearning(storage: kUnderTest ? null : HarnessFileStore.shared);
  String? _commandCatalogMachine;
  final _newTabSources = <String, TerminalPane>{};

  Widget _startGuide() => WorkspaceWelcome(onCommand: _runShortcut);

  void _showKeyboardShortcuts() {
    if (_newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    unawaited(_dialog(() => showShortcutsSheet(context)));
  }

  @override
  void initState() {
    super.initState();
    _keymap.addListener(_keymapChanged);
    app.hasNavigationRail = false;
    app.railFocused = false;
    _recordNavigation();
    app.addListener(_recordNavigation);
    app.addListener(_observeLearning);
    unawaited(
      _learning.load().then((_) {
        if (mounted) _observeLearning();
      }),
    );
    FocusManager.instance.addListener(_restoreEmptyFocus);
    FocusManager.instance.addListener(_syncKeyContext);
    grid.AppTheme.palette.addListener(_paletteChanged);
    terminalFontStore.addListener(_fontChanged);
    unawaited(_projects.load());
    unawaited(_navigation.load());
    _spokenTasks = app.spokenTasks.listen(_openSpokenTask);
    if (_native) {
      _modelsMenu =
          widget.modelsMenu ??
          ModelsMenuController(remote: app.readRemoteUsage);
      _modelsMenu!.addListener(_syncModels);
      // Same trigger as the subscription rows: the daemon memoises its answer, so opening the menu
      // repeatedly costs nothing after the first.
      unawaited(_refreshLocalModels());
      _channel.setMethodCallHandler(_onNative);
      app.addListener(_syncNative);
      _syncNative();
      _syncModels();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final keymap = KeymapTheme.of(context);
    if (keymap != _providedKeymap) {
      _keymap.removeListener(_keymapChanged);
      _providedKeymap = keymap;
      _keymap.addListener(_keymapChanged);
    }
    _syncKeymap();
    final current = ModalRoute.isCurrentOf(context) ?? true;
    if (_routeIsCurrent == current) return;
    _routeIsCurrent = current;
    if (!current &&
        (_search != null || _commandBarOpen || _sessionsOverlay != null)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_routeIsCurrent) {
          _closeSearch(restoreFocus: false);
          _closeCommandBar(restoreFocus: false);
          _closeSessions(restoreFocus: false);
        }
      });
    }
    if (_native) _syncNative();
  }

  @override
  void dispose() {
    _unregisterSessions?.call();
    _sessionsOverlay?.remove();
    _sessionsOverlay?.dispose();
    _minimizeOverlay?.remove();
    _minimizeOverlay?.dispose();
    _minimizeOverlay = null;
    _minimize.dispose();
    _keymap.removeListener(_keymapChanged);
    _defaultKeymap.dispose();
    grid.AppTheme.palette.removeListener(_paletteChanged);
    terminalFontStore.removeListener(_fontChanged);
    app.removeListener(_recordNavigation);
    app.removeListener(_observeLearning);
    if (widget.learning == null) _learning.dispose();
    FocusManager.instance.removeListener(_restoreEmptyFocus);
    FocusManager.instance.removeListener(_syncKeyContext);
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _search?.dispose();
    _newHarnessOverlay?.remove();
    _newHarnessOverlay?.dispose();
    _newHarness?.dispose();
    _navigation.dispose();
    _searchFocus.dispose();
    _searchText.dispose();
    _tabScroll.dispose();
    _canvasFocus.dispose();
    _shellFocus.dispose();
    _startSearchFocus.dispose();
    _commandFocus.dispose();
    if (_hasCommandBar) _commandBar.dispose();
    unawaited(_spokenTasks?.cancel());
    if (_native) {
      _modelsMenu?.removeListener(_syncModels);
      if (widget.modelsMenu == null) _modelsMenu?.dispose();
      unawaited(
        _channel.invokeMethod<void>('modelsState', {'subscriptions': []}),
      );
      unawaited(_channel.invokeMethod<void>('machinesState', {'machines': []}));
      app.removeListener(_syncNative);
      _channel.setMethodCallHandler(null);
      unawaited(
        _channel.invokeMethod<void>('update', {'tabs': [], 'enabled': false}),
      );
    }
    if (widget.projectStore == null) _projects.dispose();
    super.dispose();
  }

  AppKeymap? _sentKeymap;
  int? _sentKeymapVersion;
  void _syncKeymap() {
    if (!_native ||
        (_sentKeymap == _keymap && _sentKeymapVersion == _keymap.version)) {
      return;
    }
    _sentKeymap = _keymap;
    _sentKeymapVersion = _keymap.version;
    unawaited(
      _channel.invokeMethod<void>(
        'keymapState',
        nativeKeymapSnapshot(
          _keymap,
          disabledCommands: _hasCommandBar
              ? const {}
              : const {'navigation.command_bar'},
        ),
      ),
    );
  }

  void _keymapChanged() {
    _syncKeymap();
    if (mounted) setState(() {});
    _search?.refreshCommands();
  }

  void _syncKeyContext() {
    if (!_native) return;
    final focus = FocusManager.instance.primaryFocus?.context;
    final kind = focus == null
        ? KeymapContext.workspace
        : KeymapRegion.of(focus)?.contextKind ?? KeymapContext.workspace;
    if (_nativeKeyContext == kind.name) return;
    _nativeKeyContext = kind.name;
    unawaited(
      _channel.invokeMethod<void>('keymapContext', {'context': kind.name}),
    );
  }

  bool get _shortcutsEnabled =>
      mounted && _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen;

  void _runShortcut(String id) {
    if (_sessionsOverlay != null) _closeSessions();
    if (id != 'navigation.command_bar') _closeCommandBar();
    if (id == 'agent.new' && _search != null) {
      final target = _search!.targetId;
      final split = _search!.split;
      final placement = _search!.placement;
      final task = _search!.createTask;
      _closeSearch(restoreFocus: false);
      unawaited(
        _newAgent(
          swarmId: target,
          split: split,
          placement: placement,
          task: task,
        ),
      );
      return;
    }
    if (!_canExecuteCommand(id)) return;
    if (id != 'navigation.commands' &&
        id != 'swarm.new' &&
        id != 'agent.add' &&
        id != 'agent.open') {
      _closeSearch();
    }
    _commands[id]?.call();
  }

  void _recordNavigation() {
    _navigation.record(app);
    if (_hasCommandBar && _commandBarOpen) {
      final local = app.localMachineState;
      if (local != null &&
          local.nodeOnline == true &&
          _commandCatalogMachine != local.machine.machineId) {
        _commandCatalogMachine = local.machine.machineId;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) unawaited(app.probeDsh(local.machine.machineId));
        });
      }
    }
    if (_search != null &&
        (_search!.targetId != app.activeSwarmId ||
            (_lastWorkspace?.$2 == true && app.panes.isNotEmpty))) {
      _closeSearch(restoreFocus: false);
    }
    final workspace = (app.activeSwarmId, app.panes.isEmpty);
    if (_lastWorkspace == workspace) return;
    if (_commandBarOpen && _lastWorkspace != null) {
      _closeCommandBar(restoreFocus: false);
    }
    if (_hasCommandBar &&
        _lastWorkspace != null &&
        (_commandBar.phase == CommandPhase.resolving ||
            _commandBar.phase == CommandPhase.searching)) {
      _commandBar.dismiss();
    }
    _lastWorkspace = workspace;
  }

  void _observeLearning() => _learning.observe(
    agents: app.panes
        .where((pane) => !pane.isWeb && pane.agentId != null)
        .length,
    zoomed: app.zoomedPaneId != null,
  );

  Future<void> _startQuickStart() async {
    if (_newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    String? next;
    await _dialog(() async {
      next = await showDialog<String>(
        context: context,
        builder: (context) => Dialog(
          backgroundColor: grid.AppPalette.swarmWelcome,
          insetPadding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1200, maxHeight: 800),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 8, 0),
                  child: Row(
                    children: [
                      Text('Quick Start', style: grid.AppType.heading()),
                      const Spacer(),
                      TextButton(
                        onPressed: () => Navigator.pop(context, 'tour'),
                        child: const Text('Try the keyboard tour'),
                      ),
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.pop(context),
                        icon: const Icon(Icons.close, size: 18),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: WorkspaceStartGuide(
                    onShortcuts: () => Navigator.pop(context, 'shortcuts'),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    });
    if (!mounted) return;
    if (next == 'shortcuts') _showKeyboardShortcuts();
    if (next == 'tour') {
      _learning.start();
      _observeLearning();
    }
  }

  Future<void> _practiceKeyboard() =>
      _dialog(() => showKeyboardPractice(context, keymap: _keymap));

  int get _attention =>
      harnessSessions(app).where((row) => row.needsInput).length;

  void _restoreEmptyFocus() {
    if (!mounted ||
        app.panes.isNotEmpty ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        _commandBarOpen ||
        _search != null ||
        ModalRoute.of(context)?.isCurrent == false ||
        _shellFocus.hasFocus) {
      return;
    }
    // Hiding the final terminal releases focus after its parent has rebuilt.
    // Only reclaim the route's empty scope, never another field or dialog.
    if (FocusManager.instance.primaryFocus == _shellFocus.enclosingScope) {
      _shellFocus.requestFocus();
    }
  }

  // Any retained session has a mounted terminal, including read-only/offline
  // output. Never-attached setup guides have no buffer to search.
  bool get _canFindTerminal => app.focusedPane?.session != null;

  void _fontChanged() {
    setState(() {});
    _paletteChanged();
  }

  void _paletteChanged() {
    _searchOverlay?.markNeedsBuild();
    if (_native) _syncNative();
  }

  /// The agents a tab holds, once each: a harness's viewer belongs to the agent beside it, so an
  /// agent and its pane are one agent — and one mark on the tab — not a two-pane group.
  Set<(String, String)> _tabAgents(Swarm tab) => {
    for (final pane in tab.panes)
      if ((pane.isWeb ? pane.ownerAgentId : pane.agentId) case final id?)
        (pane.machineId, id),
  };

  String? _tabEngine(Swarm tab) {
    final agents = _tabAgents(tab);
    if (agents.length != 1) return null;
    final (machineId, agentId) = agents.single;
    final terminal = tab.panes
        .where((pane) => !pane.isWeb && pane.agentId == agentId)
        .firstOrNull;
    return app
            .stateOf(machineId)
            ?.agents
            .where((agent) => agent.id == agentId)
            .firstOrNull
            ?.identityEngine ??
        terminal?.session?.engineId;
  }

  void _syncNative() {
    // ⚠️ Also from here, not only from `initState`. At init the machine list is still empty, so the
    // first read returned nothing and the Local section sat on its empty state forever. This fires
    // on every app change, throttled, so it lands as soon as a machine appears.
    unawaited(_refreshLocalModels());
    _syncMachines();
    final payload = {
      'enabled': _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen,
      'activeId': app.activeSwarmId,
      'palette': grid.AppTheme.palette.value.nativeColors,
      // The tabs wear the terminal's face at the chrome size, not its size:
      // ⌘+ and ⌘− zoom the terminal alone.
      'fontFamily': grid.AppType.monoFamily,
      'fontSize': grid.AppType.chromeSize,
      'fontFallbacks': grid.AppType.monoFallback,
      'canReopen': app.canReopenLastClosed,
      'canFind': _canFindTerminal,
      'canClosePane': app.focusedPane != null,
      'canGoBack': _navigation.canGoBack(app),
      'canGoForward': _navigation.canGoForward(app),
      'closedHistory': [
        for (final entry in closedWorkDestinations(app))
          {
            'id': entry.id,
            'title': entry.title,
            'machineName': entry.machineLabel,
            'detail': entry.detail,
            'swarm': entry.isSwarm,
            'store': entry.isStore,
            'agentCount': entry.isSwarm ? entry.members.length : 1,
            'engine': entry.isStore ? 'store' : entry.engine,
            'iconAsset': entry.isStore
                ? kStoreMarkAsset
                : engineIdentity(entry.engine).asset,
            'canReopen': app.canReopenClosed(entry.id),
          },
      ],
      'attention': _attention,
      'sessionsOpen': _sessionsOverlay != null,
      'runningSessions': harnessSessions(app)
          .where((row) => row.running)
          .length,
      'history': [
        for (final entry in _navigation.menuDestinations(app))
          {
            'id': entry.id,
            'title': entry.title,
            'machineName': entry.machineLabel,
            'detail': entry.detail,
            'swarm': entry.isSwarm,
            'store': entry.isStore,
            'agentCount': entry.isSwarm ? entry.members.length : 1,
            'engine': entry.isStore ? 'store' : entry.engine,
            'iconAsset': entry.isStore
                ? kStoreMarkAsset
                : engineIdentity(entry.engine).asset,
            'current': entry.current,
          },
      ],
      'tabs': [
        for (final swarm in app.swarms)
          {
            'id': swarm.id,
            'name': swarm.name,
            'kind': swarm.kind,
            'agentCount': _tabAgents(swarm).length,
            'engine': swarm.isStore ? 'store' : _tabEngine(swarm),
            'iconAsset': swarm.isStore
                ? kStoreMarkAsset
                : engineIdentity(_tabEngine(swarm)).asset,
            'attention': swarm.panes
                .where(
                  (p) =>
                      p.agentId != null &&
                      app.questionFor(p.machineId, p.agentId!) != null,
                )
                .length,
          },
      ],
    };
    final encoded = jsonEncode(payload);
    if (encoded == _nativeState) return;
    _nativeState = encoded;
    unawaited(_channel.invokeMethod<void>('update', payload));
  }

  void _syncMachines() {
    final openAgents = {
      for (final tab in app.swarms)
        for (final pane in tab.panes) (pane.machineId, pane.agentId),
    };
    final machines = app.machineStates.values.take(128);
    // Compare only visible values before building/encoding a potentially large
    // inventory. Tab focus, palette and attention changes use the small update
    // message; they never resend or decode every agent on the native thread.
    final presentation = <Object?>[
      for (final machine in machines) ...[
        (
          machine.machine.machineId,
          machine.machine.displayName,
          machine.machine.isShared,
          machine.machine.ownerName,
          machine.isLocalMachine,
          machine.nodeOnline,
          machine.needsLink,
          machine.agents.isNotEmpty ||
                  machine.agentLoadStatus == AgentLoadStatus.loaded
              ? machine.agents.length
              : null,
        ),
        for (final agent in machine.agents.take(512))
          (
            agent.id,
            agent.displayName,
            agent.engine,
            agent.terminalAvailable ||
                openAgents.contains((machine.machine.machineId, agent.id)),
            // Part of the row now (" · stopped", and whether it opens), so a
            // harness stopping or resuming redraws the menu like a rename does.
            agent.isStopped,
          ),
      ],
    ];
    if (listEquals(presentation, _machinesPresentation)) return;
    _machinesPresentation = presentation;
    unawaited(
      _channel.invokeMethod<void>('machinesState', {
        'machines': [
          for (final machine in machines)
            {
              'id': machine.machine.machineId,
              'name': machine.machine.displayName,
              'local': machine.isLocalMachine,
              'shared': machine.machine.isShared,
              'ownerName': machine.machine.ownerName,
              'agentCount':
                  machine.agents.isNotEmpty ||
                      machine.agentLoadStatus == AgentLoadStatus.loaded
                  ? machine.agents.length
                  : null,
              'agents': [
                for (final agent in machine.agents.take(512))
                  {
                    'id': agent.id,
                    'title': agent.displayName,
                    // Drawn as what it is: a Godogen agent wears Godogen, not
                    // the Claude Code it runs on.
                    'engine': agent.identityEngine,
                    'iconAsset': agentIdentity(agent).asset,
                    // A stopped harness opens too: choosing it resumes its
                    // conversation, the road ⌘O takes (`activateSwarmDestination`).
                    // `stopped` lets the row say so first, since that takes a
                    // moment and may ask the engine to sign in, unlike an attach.
                    'canOpen':
                        agent.terminalAvailable ||
                        agent.isStopped ||
                        openAgents.contains((
                          machine.machine.machineId,
                          agent.id,
                        )),
                    'stopped': agent.isStopped,
                  },
              ],
              // Two independent slots. `presence` is the node's own state
              // (is `harness` running/reachable?), shown after the name — a
              // definite "Online"/"Offline", or blank while unknown. `status`
              // /`linkRequired` is the trailing slot: the peer link/trust
              // between this computer and the machine. They are orthogonal, so
              // an unlinked machine whose node is up reads BOTH "Online" and
              // "Link required" instead of the link state masking presence.
              'presence': machine.nodeOnline == true
                  ? 'Online'
                  : machine.nodeOnline == false
                  ? 'Offline'
                  : '',
              'linkRequired': machine.needsLink,
              // Trailing word. Offline/Online live in `presence` now, so they
              // drop out here (the agent count fills the slot). Only the link
              // state and the still-connecting case need the trailing edge.
              'status': machine.needsLink
                  ? 'Link required'
                  : machine.nodeOnline == null
                  ? 'Connecting…'
                  : '',
            },
        ],
      }),
    );
  }

  void _syncModels() {
    final payload = {
      'subscriptions': _modelsMenu?.rows ?? [],
      // Which subscription the menu marks as the one in use. The pane in focus decides, because
      // "which account am I spending" is a question about the agent being looked at; a pane that
      // has been moved onto a Local model is on no subscription, and then nothing is marked.
      'currentEngine': _currentSubscriptionEngine(),
      // Back-compat: the own grid's models, as the native menu understood them before sections.
      'local': [
        for (final s in _localSections)
          if (s.own)
            for (final m in s.models) {'id': m.id, 'node': m.node},
      ],
      // The picker's sections, own grid first then each shared grid — what the native menu draws.
      'sections': [
        for (final s in _localSections)
          {
            'name': s.name,
            'own': s.own,
            'models': [
              for (final m in s.models) {'id': m.id, 'node': m.node},
            ],
          },
      ],
    };
    final encoded = jsonEncode(payload);
    if (encoded == _modelsState) return;
    _modelsState = encoded;
    unawaited(_channel.invokeMethod<void>('modelsState', payload));
  }

  /// The focused pane's engine while that pane runs on its own login, else null.
  String? _currentSubscriptionEngine() {
    final pane = app.focusedPane;
    if (pane == null) return null;
    final agent = app.machineStates[pane.machineId]?.agents
        .where((a) => a.id == pane.agentId)
        .firstOrNull;
    if (agent == null || agent.gridModel != null) return null;
    return agent.engine?.trim().toLowerCase();
  }

  /// What the picker's sections answer for the native Models menu.
  ///
  /// Read from a machine this window is connected to — the grid is per ACCOUNT, so any of them
  /// answers the same, and the local one is asked first because its daemon is a loopback away.
  /// Never throws and never blocks the menu: a machine that cannot answer leaves the list as it was.
  List<GridSection> _localSections = const [];

  DateTime? _localModelsAt;

  Future<void> _refreshLocalModels() async {
    final machines = app.machines
        .where((machine) => !machine.isShared)
        .toList();
    if (machines.isEmpty) return;
    // The daemon memoises its answer, so a repeat is nearly free — but this is called on every app
    // change, and an RPC per keystroke-sized notification is not free. One read per window is
    // plenty for a list that changes when someone starts or stops serving a model.
    final now = DateTime.now();
    final last = _localModelsAt;
    if (last != null && now.difference(last) < const Duration(seconds: 10)) {
      return;
    }
    _localModelsAt = now;
    final preferred = machines.firstWhere(
      (m) => app.stateOf(m.machineId)?.isLocalMachine == true,
      orElse: () => machines.first,
    );
    final answer = await app.gridModels(preferred.machineId);
    if (!mounted) return;
    final sections = _sectionsForModelMenu(answer);
    if (_sameSections(sections, _localSections)) return;
    _localSections = sections;
    _syncModels();
  }

  /// The sections the Models menu draws, matching the pane picker's own: the account's own grid
  /// first as "Local", then each shared grid that serves something. A shared grid with nothing
  /// running is not a menu a person can pick from, so it is not drawn.
  List<GridSection> _sectionsForModelMenu(GridModels answer) {
    final sections = answer.sections
        .where((s) => s.own || s.models.isNotEmpty)
        .toList();
    if (sections.any((s) => s.own)) return sections;
    return [
      GridSection(
        name: answer.gridName ?? '',
        own: true,
        models: answer.models,
      ),
      ...sections,
    ];
  }

  static bool _sameSections(List<GridSection> a, List<GridSection> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].name != b[i].name || a[i].own != b[i].own) return false;
      if (a[i].models.length != b[i].models.length) return false;
      for (var j = 0; j < a[i].models.length; j++) {
        if (a[i].models[j].id != b[i].models[j].id) return false;
      }
    }
    return true;
  }

  Future<void> _onNative(MethodCall call) async {
    if (mounted && call.method == 'keymapPending') {
      final keys = (call.arguments as Map?)?['keys'];
      if (keys is List &&
          keys.length <= 4 &&
          keys.every((key) => key is String)) {
        final pending = keys
            .map((key) => describeKeyStroke(KeyStroke.parse(key)))
            .join(' ');
        if (_pendingKeys != pending) setState(() => _pendingKeys = pending);
      }
      return;
    }
    if (!mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    final args = call.arguments is Map ? call.arguments as Map : const {};
    if (call.method == 'sessions') {
      _toggleSessions();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'modelsOpened') {
      await _modelsMenu?.refresh();
      return;
    }
    final nativeCommand = switch (call.method) {
      'keymapCommand' =>
        args['command'] is String ? args['command'] as String : null,
      'commands' => 'navigation.commands',
      'newAgent' => 'agent.new',
      'newTerminal' => 'terminal.new',
      'cloneAgent' => 'agent.clone',
      _ => null,
    };
    if (nativeCommand != null) {
      final focus = FocusManager.instance.primaryFocus?.context;
      final region = focus == null ? null : KeymapRegion.of(focus);
      final action = region?.actions?[nativeCommand];
      if (action != null) {
        // Match keyboard dispatch: the focused picker owns its commands and
        // closes its own results before opening creation. Bypassing it stacks
        // another search or leaves the start-page dropdown under the dialog.
        if (region?.composing?.call() == true) return;
        action();
        if (call.method != 'keymapCommand') {
          await WidgetsBinding.instance.endOfFrame;
          if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
        }
        return;
      }
    }
    if (call.method == 'keymapCommand' &&
        nativeCommand?.startsWith('picker.') != true) {
      if (nativeCommand != null) _runShortcut(nativeCommand);
      return;
    }
    if (call.method == 'searchCommand' || call.method == 'keymapCommand') {
      final search = _search;
      if (search == null) return;
      final command =
          const {
            'picker.next': 'next',
            'picker.previous': 'previous',
            'picker.accept': 'submit',
            'picker.add_here': 'add',
            'picker.cancel': 'close',
          }[args['command']] ??
          args['command'];
      switch (command) {
        case 'next':
          search.moveVisually(1);
        case 'previous':
          search.moveVisually(-1);
        case 'submit':
          final choice = search.submit();
          if (choice != null) await _chooseSearch(choice);
        case 'add':
          final choice = search.addHere();
          if (choice != null) await _chooseSearch(choice);
        case 'close':
          _dismissSearch();
      }
      return;
    }
    if (call.method == 'newAgent' && _search != null) {
      _runShortcut('agent.new');
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    _closeSearch(restoreFocus: false);
    // Same reason the search field closes: the titlebar is native, so a click on it is not a pointer
    // event any Flutter overlay can see itself.
    dismissTransientMenus();
    switch (call.method) {
      case 'store':
        _openStore();
      case 'new':
        _newTab();
      case 'reopen':
        app.reopenClosed();
      case 'reopenHistory':
        if (args['id'] is String) app.reopenClosed(historyId: args['id']);
      case 'historyBack':
        _stepHistory(-1);
      case 'historyForward':
        _stepHistory(1);
      case 'showHistory':
        await _showHistory();
      case 'select':
        if (args['id'] is String) app.selectSwarm(args['id']);
      case 'close':
        if (args['id'] is String) await app.closeSwarm(args['id']);
      case 'closeActive':
        await app.closeSwarm(app.activeSwarmId);
      case 'rename':
        // Acknowledge after the form opens so the titlebar can hand its native
        // keyboard focus to Flutter while the user edits the name.
        if (args['id'] is String) unawaited(_rename(args['id']));
      case 'renameActive':
        unawaited(_rename(app.activeSwarmId));
      case 'next':
        app.stepSwarm(1);
      case 'previous':
        app.stepSwarm(-1);
      case 'reorder':
        if (args['id'] is String && args['index'] is int) {
          app.reorderSwarm(args['id'], args['index']);
        }
      case 'addAgent':
        await _addAgent();
      case 'newAgent':
        unawaited(_newAgent(swarmId: app.activeSwarmId));
      case 'newTerminal':
        unawaited(_newTerminal());
      case 'cloneAgent':
        unawaited(_cloneAgent());
      case 'runLocalModel':
        // Native commands arrive above the Actions subtree. Use the same
        // product entry directly; a dialog guard would block the dock.
        Future<void> open() => app.runLocalModel(
          context,
          machineId: args['machineId'] is String
              ? args['machineId'] as String
              : null,
          onOpenHarness: newHarnessOpensInBox ? _openProduct : null,
        );
        if (newHarnessOpensInBox) {
          await open();
        } else {
          await _dialog(open);
        }
      case 'splitRight':
        unawaited(_splitAgent(PaneResizeAxis.x));
      case 'splitDown':
        unawaited(_splitAgent(PaneResizeAxis.y));
      case 'movePaneToTab':
        if (app.focusedPaneId != null) {
          _dialog(() => showMovePanePalette(context, app));
        }
      case 'zoomPane':
        app.toggleZoomPane();
      case 'pinPane':
        if (app.focusedPaneId != null) app.togglePinPane(app.focusedPaneId!);
      case 'addProject':
        await _addProject();
      case 'linkMachine':
        await _dialog(() => showSwarmLinkDialog(context, app, keymap: _keymap));
      case 'manageMachines':
        await _manageMachines();
      // BRIDGE, until the Machines menu goes: the old list, so nothing is lost
      // between this release and that one. When the menu is removed, delete
      // this case, `machines.list` below, machines_manager.dart and its test,
      // and the `machineList` action in SwarmTitlebar.swift + keymap_commands.
      case 'machineList':
        unawaited(
          _dialog(() => showMachinesManager(context, app, keymap: _keymap)),
        );
      case 'refreshMachines':
        unawaited(app.retryMachines());
      case 'machineDestination':
        final machine = args['id'] is String ? app.stateOf(args['id']) : null;
        if (machine != null) {
          _openSearch(adding: true, query: machine.machine.displayName);
        }
      case 'deleteMachine':
        final machine = args['id'] is String ? app.stateOf(args['id']) : null;
        if (machine != null && !machine.isLocalMachine) {
          unawaited(
            _dialog(
              () => confirmDeleteMachine(
                context,
                app,
                machineId: machine.machine.machineId,
                displayName: machine.machine.displayName,
                keymap: _keymap,
              ),
            ),
          );
        }
      case 'machineAgent':
        final machineId = args['machineId'], agentId = args['agentId'];
        if (machineId is String &&
            agentId is String &&
            app
                    .stateOf(machineId)
                    ?.agents
                    .any((agent) => agent.id == agentId) ==
                true) {
          final entry = swarmDestinations(app)
              .where(
                (entry) => entry.id == agentDestinationId(machineId, agentId),
              )
              .firstOrNull;
          if (entry != null) {
            _closeSearch();
            _preparePaneFocus();
            try {
              await activateSwarmDestination(
                app,
                entry,
                destinationSwarmId: app.activeSwarmId,
              );
            } on SwarmResumeFailure catch (failure) {
              _showResumeFailure(failure, target: app.activeSwarmId);
            }
          }
        }
      case 'commands':
        _showSearchCommands();
      case 'historyDestination':
        final entry = _navigation
            .menuDestinations(app)
            .where((entry) => entry.id == args['id'])
            .firstOrNull;
        if (entry != null) {
          _preparePaneFocus();
          try {
            await activateSwarmDestination(
              app,
              entry,
              destinationSwarmId: app.activeSwarmId,
            );
          } on SwarmResumeFailure catch (failure) {
            _showResumeFailure(failure, target: app.activeSwarmId);
          }
        }
      case 'closePane':
        if (app.focusedPane case final pane?) unawaited(_closePane(pane));
      case 'findTerminal':
        app.focusedPane?.session?.find(TerminalFindAction.open);
      case 'findNext':
        app.focusedPane?.session?.find(TerminalFindAction.next);
      case 'findPrevious':
        app.focusedPane?.session?.find(TerminalFindAction.previous);
      case 'notifications':
        unawaited(_notifications());
      case 'settings':
        await _settings();
      case 'customize':
        await _customize();
    }
    if (mounted &&
        const {
          'select',
          'close',
          'new',
          'rename',
          'renameActive',
          'commands',
          'notifications',
          'addAgent',
          'newAgent',
          'newTerminal',
          'cloneAgent',
          'runLocalModel',
          'manageMachines',
          'machineList',
          'deleteMachine',
          'splitRight',
          'splitDown',
          'zoomPane',
          'pinPane',
          'machineDestination',
          'machineAgent',
        }.contains(call.method)) {
      // Native tab controls wait for this reply before releasing keyboard
      // ownership. The destination's actual focus tree must be ready first.
      await WidgetsBinding.instance.endOfFrame;
      if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
    }
  }

  Future<void> _dialog(
    Future<void> Function() action, {
    bool restoreEntry = true,
  }) async {
    if (_dialogOpen || _spokenPaletteOpen || !mounted) return;
    _closeCommandBar();
    _closeSearch();
    _dialogOpen = true;
    // The route must not restore an old terminal while the destination changes
    // behind a dialog. Return input explicitly when that dialog finishes.
    _canvasFocus.descendantsAreFocusable = false;
    if (_native) _syncNative();
    try {
      await action();
    } finally {
      _dialogOpen = false;
      if (mounted) {
        _canvasFocus.descendantsAreFocusable = _search == null;
        if (_search == null &&
            ModalRoute.of(context)?.isCurrent != false &&
            app.focusedPane?.session?.focusInput() != true) {
          _shellFocus.requestFocus();
        }
        if (_native) _syncNative();
      }
    }
    if (restoreEntry) await _ensureEmptyEntry();
  }

  Future<void> _rename(String id) => _dialog(() async {
    final swarm = app.swarms.where((s) => s.id == id).firstOrNull;
    if (swarm == null) return;
    final name = await showSwarmRenameDialog(
      context,
      swarm.name,
      keymap: _keymap,
    );
    if (name != null) app.renameSwarm(id, name);
  });

  Agent? get _focusedAgent {
    final pane = app.focusedPane;
    return pane == null
        ? null
        : app
              .stateOf(pane.machineId)
              ?.agents
              .where((agent) => agent.id == pane.agentId)
              .firstOrNull;
  }

  Future<void> _editAgent({bool stop = false}) => _dialog(() async {
    final pane = app.focusedPane;
    if (pane == null) return;
    final machine = app.stateOf(pane.machineId);
    final agent = machine?.agents
        .where((agent) => agent.id == pane.agentId)
        .firstOrNull;
    if (agent == null || machine!.machine.isShared) return;
    if (stop) {
      await confirmDeleteAgent(
        context,
        app,
        pane.machineId,
        agent.id,
        agent.displayName,
        engine: agent.engine,
        keymap: _keymap,
      );
      return;
    }
    await showAgentRenameDialog(
      context,
      app,
      pane.machineId,
      agent.id,
      agent.displayName,
      keymap: _keymap,
    );
  });
  Future<void> _restartAgent() => _dialog(() async {
    final pane = app.focusedPane;
    if (pane == null ||
        _focusedAgent == null ||
        app.stateOf(pane.machineId)?.machine.isShared != false) {
      return;
    }
    await restartHarness(
      context,
      app,
      pane.machineId,
      pane.agentId!,
      keymap: _keymap,
    );
  });
  Future<void> _forkAgent() => _dialog(() async {
    final pane = app.focusedPane;
    final agent = _focusedAgent;
    if (pane == null ||
        agent == null ||
        !agent.canFork ||
        app.stateOf(pane.machineId)?.machine.isShared != false) {
      return;
    }
    await forkHarness(
      context,
      app,
      pane.machineId,
      agent.id,
      agent.displayName,
      engine: agent.engine,
      keymap: _keymap,
    );
  });
  Future<void> _customize() => _dialog(() => showHarnessCustomizePane(context));

  Future<void> _settings([SettingsSection? section]) => _dialog(
    () => showSettingsScreen(
      context,
      app,
      initialSection: section,
      source: 'swarm',
    ),
  );

  /// Settings, by section, as rows of the box: `> usage` goes straight to
  /// Settings ▸ Usage. A palette that finds a setting by name is how an editor
  /// makes a settings screen nobody has to navigate.
  static const _settingsCommand = 'settings:';

  Future<void> _manageMachines() async {
    Future<void> open() => app.manageMachines(
      context,
      onOpenHarness: newHarnessOpensInBox ? _openProduct : null,
    );
    if (newHarnessOpensInBox) {
      await open();
    } else {
      await _dialog(open);
    }
  }

  Future<void> _openProduct(String engine, String machineId, {String? task}) =>
      _newAgent(
        source: _NewHarnessSource.product,
        engine: engine,
        machineId: machineId,
        task: task,
        placement: HarnessPlacement.newTab,
      );

  Future<void> _newAgent({
    String? machineId,
    String? folder,
    String? swarmId,
    PaneSplitRequest? split,
    String? engine,
    String? projectName,
    String? task,
    HarnessPlacement? placement,
    _NewHarnessSource source = _NewHarnessSource.workspace,
  }) async {
    final search = source == _NewHarnessSource.workspace ? _search : null;
    // A pane never lands in the store tab: New Harness from there goes to
    // the empty starter tab (or a fresh one), the way New Tab does.
    placement ??= search?.placement;
    if (swarmId == null &&
        (app.activeSwarm.isStore || app.activeSwarm.isOrchestrator)) {
      placement = HarnessPlacement.newTab;
    }
    final target = swarmId ?? search?.targetId ?? app.activeSwarmId;
    final requestedSplit = split ?? search?.split;
    // ⌘N from inside the search keeps what was typed: it is what the create
    // row would have started the harness on.
    if (newHarnessOpensInBox) task ??= search?.createTask;
    if (app.activeSwarmId != target) return;
    // In the box, the new harness starts as another of the one you were in —
    // its agent, its machine, its project — the way a tmux split inherits its
    // pane and a new terminal tab opens where the last one was. The form keeps
    // what it always did: it inherits only for a split.
    final focused =
        source == _NewHarnessSource.workspace &&
            (newHarnessOpensInBox || requestedSplit != null)
        ? app.focusedPane ?? _newTabSources[target]
        : null;
    final machine = focused == null ? null : app.stateOf(focused.machineId);
    final agent = machine?.agents
        .where((agent) => agent.id == focused?.agentId)
        .firstOrNull;
    final id =
        machineId ??
        machine?.machine.machineId ??
        app.machineStates.values
            .where((machine) => machine.isLocalMachine)
            .firstOrNull
            ?.machine
            .machineId ??
        app.machineStates.keys.firstOrNull;
    final paneProject =
        projectName != null || agent == null || id != focused?.machineId
        ? null
        : machine?.projectOf(agent);
    // Another one of these: its agent, machine and folder — not its branch.
    // New Harness is new work; another agent's branch is one pick away, and
    // joins its worktree rather than being where Start begins.
    final initialFolder = folder ?? paneProject?.cwd;
    if (id == null) {
      await _dialog(
        () => showSwarmLinkDialog(context, app, keymap: _keymap),
        restoreEntry: false,
      );
      await _ensureEmptyEntry();
      return;
    }
    if (!newHarnessOpensInBox) {
      await _newAgentForm(
        machineId: id,
        folder: initialFolder,
        swarmId: target,
        split: requestedSplit,
        engine: engine,
        placement: placement,
        task: task,
      );
      return;
    }
    final inherited = agent?.identityEngine;
    _openNewHarness(
      machineId: id,
      // ⌘⇧T is how a shell is made; New Harness from a shell means an agent.
      engine: engine ?? (isTerminalEngine(inherited) ? null : inherited),
      folder: initialFolder,
      projectName: projectName,
      autoProject:
          projectName == null &&
          initialFolder == null &&
          (source == _NewHarnessSource.product || app.panes.isEmpty),
      task: task,
      draftContext: (
        source: source,
        machineId: id,
        requestedEngine: engine,
        sourceAgentId: focused?.agentId,
        folder: initialFolder,
        projectName: projectName,
      ),
      swarmId: target,
      split: requestedSplit,
      placement: placement,
    );
  }

  /// The full form, on the answers the box already holds: what the box does
  /// not do yet (an engine to install, a Git clone, a permission mode, a Codex
  /// profile) stays one key away instead of being lost.
  Future<void> _newAgentForm({
    required String machineId,
    String? engine,
    String? folder,
    ProjectFolderRequest? projectFolder,
    String? permissionMode,
    required String swarmId,
    PaneSplitRequest? split,
    HarnessPlacement? placement,
    HarnessPlacement? returnedPlacement,
    String? task,
    NewHarnessDraft? initialDraft,
    _NewHarnessContext? draftContext,
    bool returnToPrompt = false,
  }) async {
    NewHarnessDraft? returning;
    await _dialog(() async {
      final result = await showNewAgentDialog(
        context,
        app,
        machineId,
        source: 'swarm',
        initialFolder: folder,
        initialProjectFolder: projectFolder,
        initialPermissionMode: permissionMode,
        initiallyAdvanced: returnToPrompt || permissionMode != null,
        initialDraft: initialDraft,
        onBack: returnToPrompt ? (draft) => returning = draft : null,
        keymap: _keymap,
        initialEngine: engine,
        swarmId: swarmId,
        split: split,
        placement: placement,
        initialPrompt: task,
      );
      if (result == NewAgentDialogResult.created) {
        _newHarnessDrafts.remove(draftContext);
      }
    }, restoreEntry: false);
    if (mounted && returning != null && app.activeSwarmId == swarmId) {
      _openNewHarness(
        machineId: returning!.machineId,
        draft: returning,
        draftContext: draftContext,
        swarmId: swarmId,
        split: split,
        placement: returnedPlacement ?? placement,
      );
      return;
    }
    if (returning != null && draftContext != null) {
      _rememberNewHarnessDraft(draftContext, returning!);
    }
    app.cancelSwarmDraft(swarmId);
    await _ensureEmptyEntry();
  }

  void _openNewHarness({
    required String machineId,
    String? engine,
    String? folder,
    String? projectName,
    bool autoProject = false,
    String? task,
    NewHarnessDraft? draft,
    _NewHarnessContext? draftContext,
    required String swarmId,
    PaneSplitRequest? split,
    HarnessPlacement? placement,
  }) {
    // A dialog's pop future can complete before didChangeDependencies refreshes
    // the cached route flag. Its live route already owns the next prompt.
    if (!mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    final origin =
        draftContext ??
        (
          source: _NewHarnessSource.workspace,
          machineId: machineId,
          requestedEngine: engine,
          sourceAgentId: app.focusedPane?.agentId,
          folder: folder,
          projectName: projectName,
        );
    bool matchesSelection(NewHarnessDraft candidate) =>
        origin.requestedEngine == null ||
        (candidate.engine == origin.requestedEngine &&
            candidate.machineId == origin.machineId);
    final current = _newHarness;
    if (current != null) {
      // A pending receipt cannot be retargeted, even by another Store page.
      if (current.busy || current.checking || current.linkingProfile) {
        current.warn(
          current.busy || current.linkingProfile
              ? 'Finish the current action before opening another harness.'
              : 'Check the pending start before opening another harness.',
        );
        return;
      }
      if (_newHarnessContext == origin &&
          matchesSelection(current.draft) &&
          (task == null || task == current.task) &&
          current.swarmId == swarmId &&
          current.split == split &&
          current.placement == placement) {
        current.focusField(NewHarnessField.launch);
        return;
      }
      _closeNewHarness(restoreFocus: false);
    }
    if (_search != null) _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    analytics.newAgentOpened(source: 'swarm_box');
    _searchReturnFocus ??= FocusManager.instance.primaryFocus;
    if (_native) _preparePaneFocus();
    _canvasFocus.descendantsAreFocusable = false;
    _newHarnessContext = origin;
    // Consume once. Explicit text from search starts a fresh task with the
    // inherited defaults; an empty search resumes this context's whole draft.
    final savedDraft = _newHarnessDrafts[origin];
    // A lost reply always restores its exact receipt. Otherwise explicit
    // product/machine choices and freshly typed tasks win over old defaults.
    final resumed =
        draft ??
        (savedDraft != null &&
                (savedDraft.attempt?.awaitingConfirmation == true ||
                    (task == null && matchesSelection(savedDraft)))
            ? savedDraft
            : null);
    if (resumed != null) _newHarnessDrafts.remove(origin);
    final box = _newHarness = NewHarnessController(
      app,
      machineId: machineId,
      engine: engine,
      folder: folder,
      projectName: projectName,
      task: task,
      draft: resumed,
      autoProject: autoProject,
      offersStore: true,
      swarmId: swarmId,
      split: split,
      placement: placement,
    );
    final content = NewHarnessBox(
      docked: true,
      controller: box,
      onClose: () {
        final target = box.swarmId ?? app.activeSwarmId;
        _closeNewHarness();
        app.cancelSwarmDraft(target);
      },
      onCreated: () {
        _closeNewHarness(restoreFocus: false, keepDraft: false);
        unawaited(_focusCreatedPane());
      },
      onBrowse: () => unawaited(_browseForNewHarness(box)),
      onStore: _openStore,
      onLinkProfile: () => unawaited(_linkProfileForNewHarness(box)),
      onNeedsForm: () {
        if (box.busy || box.checking) {
          box.warn('Check the pending creation before changing forms.');
          return;
        }
        final draft = box.draft;
        _closeNewHarness(restoreFocus: false, keepDraft: false);
        unawaited(
          _newAgentForm(
            machineId: draft.machineId,
            initialDraft: draft,
            draftContext: origin,
            returnToPrompt: true,
            swarmId: swarmId,
            split: split,
            placement: box.effectivePlacement,
            returnedPlacement: box.placement,
          ),
        );
      },
    );
    _newHarnessOverlay = OverlayEntry(
      builder: (context) => KeymapProvider(
        keymap: _keymap,
        child: ListenableBuilder(
          listenable: box,
          builder: (context, child) => LayoutBuilder(
            builder: (context, constraints) {
              return Stack(
                children: [
                  Positioned.fill(
                    child: BlockSemantics(
                      child: GestureDetector(
                        key: const ValueKey('new-harness-dismiss'),
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          if (box.requestDismiss()) {
                            final target = box.swarmId ?? app.activeSwarmId;
                            _closeNewHarness();
                            app.cancelSwarmDraft(target);
                          }
                        },
                      ),
                    ),
                  ),
                  CommandDock(
                    topClearance: _native ? 0 : _tabBarHeight,
                    expanded: box.field == NewHarnessField.projectMenu,
                    child: content,
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
    Overlay.of(context).insert(_newHarnessOverlay!);
  }

  Future<void> _focusCreatedPane() async {
    final tab = app.activeSwarmId;
    final pane = app.focusedPane;
    // The new terminal mounted while the dock owned input. Enable its focus
    // tree, let the removed overlay settle, then hand it the text connection.
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted ||
        !_routeIsCurrent ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        _newHarness != null ||
        _search != null ||
        _commandBarOpen ||
        app.activeSwarmId != tab ||
        !identical(app.focusedPane, pane)) {
      return;
    }
    if (pane?.session?.focusInput() != true) _shellFocus.requestFocus();
    FocusManager.instance.applyFocusChangesIfNeeded();
  }

  /// The Browse… row: the system's folder chooser on this computer, the
  /// folder browser on another. The box stays open behind it and takes the
  /// answer when it comes back.
  Future<void> _browseForNewHarness(NewHarnessController box) async {
    final previousFocus = FocusManager.instance.primaryFocus;
    final machineId = box.machineId;
    final machine = app.stateOf(machineId);
    final path = machine?.isLocalMachine == true
        ? await getDirectoryPath(initialDirectory: box.project.folder)
        : await showRemoteFolderPicker(
            context,
            notifier: app,
            machineId: machineId,
            initialPath: box.project.folder,
          );
    if (mounted && identical(_newHarness, box) && box.machineId == machineId) {
      if (path != null) box.setFolder(path);
      if (previousFocus?.context?.mounted == true &&
          previousFocus!.canRequestFocus) {
        previousFocus.requestFocus();
      }
    }
  }

  Future<void> _linkProfileForNewHarness(NewHarnessController box) async {
    if (box.locked || !box.supportsProfiles) return;
    final previousFocus = FocusManager.instance.primaryFocus;
    final machineId = box.machineId;
    final engine = box.engine;
    final initialPath = box.draft.profile?.path;
    final machine = app.stateOf(machineId);
    final path = machine?.isLocalMachine == true
        ? await getDirectoryPath(
            initialDirectory: initialPath,
            confirmButtonText: 'Link profile',
          )
        : await showRemoteFolderPicker(
            context,
            notifier: app,
            machineId: machineId,
            initialPath: initialPath,
          );
    if (!mounted ||
        !identical(_newHarness, box) ||
        box.machineId != machineId ||
        box.engine != engine ||
        box.field != NewHarnessField.profile) {
      return;
    }
    if (path != null) await box.linkProfile(path);
    if (mounted &&
        identical(_newHarness, box) &&
        previousFocus?.context?.mounted == true &&
        previousFocus!.canRequestFocus) {
      previousFocus.requestFocus();
    }
  }

  void _rememberNewHarnessDraft(
    _NewHarnessContext origin,
    NewHarnessDraft draft,
  ) {
    // Choosing defaults is useful work even before the first task is typed.
    _newHarnessDrafts.remove(origin);
    _newHarnessDrafts[origin] = draft;
    while (_newHarnessDrafts.length > 32) {
      final oldest = _newHarnessDrafts.entries
          .where((entry) => entry.value.attempt?.awaitingConfirmation != true)
          .firstOrNull;
      if (oldest == null) break;
      _newHarnessDrafts.remove(oldest.key);
    }
  }

  void _closeNewHarness({bool restoreFocus = true, bool keepDraft = true}) {
    final box = _newHarness;
    if (box == null) return;
    _canvasFocus.descendantsAreFocusable = true;
    _newHarnessOverlay?.remove();
    _newHarnessOverlay?.dispose();
    _newHarnessOverlay = null;
    _newHarness = null;
    if (keepDraft && _newHarnessContext != null) {
      _rememberNewHarnessDraft(_newHarnessContext!, box.draft);
    }
    _newHarnessContext = null;
    box.dispose();
    final previous = _searchReturnFocus;
    _searchReturnFocus = null;
    if (restoreFocus) {
      // Creation can replace a picker whose editor is now detached. Its node
      // still holds a context, but cannot receive keys after cancellation.
      if (previous?.context?.mounted == true && previous!.canRequestFocus) {
        previous.requestFocus();
      } else if (app.focusedPane?.session?.focusInput() != true) {
        _shellFocus.requestFocus();
      }
    }
    unawaited(_ensureEmptyEntry());
  }

  /// ⌘⇧N — another agent of the focused pane's kind, fresh conversation.
  /// No dialog, like ⌘⇧T: the answer to every question a dialog would ask is
  /// already on the source agent's frame (`AppNotifier.cloneAgent`). The
  /// chord is gated by `_canExecuteCommand`; the File menu is not, so a click
  /// with nothing to clone from says so instead of doing nothing.
  Future<void> _cloneAgent() async {
    final pane = app.focusedPane;
    final agent = _focusedAgent;
    final String? error;
    if (pane == null || agent == null) {
      error = 'Focus an agent pane to clone it.';
    } else if (app.stateOf(pane.machineId)?.machine.isShared != false) {
      error = 'Shared agents are view-only.';
    } else {
      error = await app.cloneAgent(
        pane.machineId,
        agent.id,
        swarmId: app.activeSwarmId,
      );
    }
    if (error != null && mounted) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(error)));
    }
  }

  /// ⌘⇧T: a shell in a new tile, no dialog — the way a terminal app opens a
  /// tab. It lands on the machine the focused tile is on (this computer when
  /// nothing is focused), in the folder that tile's harness works in, else
  /// the first project any tile in this tab has, else the machine's home —
  /// which is what the daemon opens when no folder is named.
  Future<void> _newTerminal() async {
    if (app.activeSwarm.isStore) app.newSwarm();
    final target = app.activeSwarmId;
    final focused = app.focusedPane;
    final machine = focused == null
        ? app.machineStates.values
                  .where((machine) => machine.isLocalMachine)
                  .firstOrNull ??
              app.machineStates.values.firstOrNull
        : app.stateOf(focused.machineId);
    if (machine == null) {
      await _dialog(() => showSwarmLinkDialog(context, app, keymap: _keymap));
      return;
    }
    final machineId = machine.machine.machineId;
    String? folderOf(TerminalPane pane) {
      if (pane.machineId != machineId) return null;
      final agent = machine.agents
          .where((agent) => agent.id == pane.agentId)
          .firstOrNull;
      return agent == null ? null : machine.projectOf(agent)?.cwd;
    }

    final folder =
        (focused == null ? null : folderOf(focused)) ??
        app.panes.map(folderOf).whereType<String>().firstOrNull;
    final error = await app.createAgent(
      machineId,
      engine: kTerminalEngine,
      folder: folder,
      bypassPermission: false,
      swarmId: target,
    );
    if (error != null && mounted) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Future<void> _splitAgent(PaneResizeAxis axis, {int? paneId}) async {
    final split = app.preparePaneSplit(axis, paneId: paneId);
    if (split == null) return;
    if (paneId != null) app.focusPane(split.paneId);
    _openSearch(adding: true, split: split);
  }

  Future<void> _showHistory() async {
    final target = app.activeSwarmId;
    SwarmSearchSelection? selected;
    await _dialog(() async {
      selected = await showSwarmHistory(context, app, _navigation);
    });
    if (!mounted || selected == null) return;
    await _activateSearch(selected!, target);
  }

  /// A stopped harness that would not resume — from the picker, the Machines
  /// menu or History alike: the daemon's reason, and the way on, a new
  /// conversation in the same place.
  void _showResumeFailure(
    SwarmResumeFailure failure, {
    required String target,
    HarnessPlacement? placement,
  }) {
    if (!mounted) return;
    final row = failure.destination;
    final agent = app
        .stateOf(row.machineId!)
        ?.agents
        .where((agent) => agent.id == row.agentId)
        .firstOrNull;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(failure.message),
        action: SnackBarAction(
          label: 'Start New Conversation',
          onPressed: () => _openNewHarness(
            machineId: row.machineId!,
            engine: agent?.dsh ?? agent?.engine,
            folder: agent?.project?.cwd,
            swarmId: app.swarms.any((tab) => tab.id == target)
                ? target
                : app.activeSwarmId,
            placement: placement,
            task: '',
          ),
        ),
      ),
    );
  }

  Future<void> _activateSearch(
    SwarmSearchSelection selected,
    String target, {
    PaneSplitRequest? split,
    HarnessPlacement? placement,
  }) async {
    final command = selected.destination.commandId;
    if (command != null) {
      // The result list is gone before a dialog or focus-changing command runs.
      // Recheck availability: a machine or pane may have changed while typing.
      FocusManager.instance.applyFocusChangesIfNeeded();
      if (command.startsWith(_settingsCommand)) {
        final section = SettingsSection.values
            .where((s) => s.name == command.substring(_settingsCommand.length))
            .firstOrNull;
        if (_canExecuteCommand('app.settings')) {
          _navigation.rememberCommand(command);
          unawaited(_settings(section));
        }
        return;
      }
      if (_canExecuteCommand(command)) {
        _navigation.rememberCommand(command);
        _commands[command]?.call();
      }
      return;
    }
    _preparePaneFocus();
    bool opened;
    try {
      opened = await activateSwarmSearchSelection(
        app,
        selected,
        destinationSwarmId: target,
        projects: _projects.projects,
        split: split,
        placement: placement,
      );
    } on SwarmResumeFailure catch (failure) {
      _showResumeFailure(failure, target: target, placement: placement);
      return;
    }
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('That result is no longer available. Search again.'),
        ),
      );
    }
  }

  void _openStore() {
    if (!_routeIsCurrent || _dialogOpen || _spokenPaletteOpen) return;
    if (_newHarness case final box?) {
      if (box.locked) {
        box.warn('Check the pending creation before opening Harness Store.');
        return;
      }
      _closeNewHarness(restoreFocus: false);
    }
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    app.openStore();
  }

  void _toggleSessions({SessionFilter? filter}) {
    if (_sessionsOverlay != null) {
      _closeSessions(restoreFocus: filter == null);
      if (filter == null) return;
    }
    if (_newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    final overlay = Overlay.of(context);
    _sessionsOverlay = OverlayEntry(
      builder: (context) => LayoutBuilder(
        builder: (context, constraints) => Stack(
          children: [
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _closeSessions,
                child: const SizedBox.expand(),
              ),
            ),
            Positioned(
              top: (_native ? 0.0 : _tabBarHeight) + 8,
              right: 10,
              width: (constraints.maxWidth - 20).clamp(0, 640),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight:
                      (constraints.maxHeight -
                              (_native ? 0 : _tabBarHeight) -
                              20)
                          .clamp(0, 620),
                ),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: .35),
                        blurRadius: 36,
                        offset: const Offset(0, 12),
                      ),
                    ],
                    border: Border.all(
                      color: grid.AppPalette.textPrimary.withValues(alpha: .12),
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(1),
                    child: HarnessSessionManager(
                      app: app,
                      initialFilter: filter ?? SessionFilter.all,
                      recent: _navigation.recent,
                      onClose: _closeSessions,
                      onOpen: (row) async {
                        final destination = swarmDestinations(app)
                            .where((item) => item.id == row.id)
                            .firstOrNull;
                        if (destination == null) return false;
                        final opened = await activateSwarmDestination(
                          app,
                          destination,
                          destinationSwarmId: app.activeSwarmId,
                        );
                        return opened;
                      },
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    overlay.insert(_sessionsOverlay!);
    _unregisterSessions = registerTransientMenu(_closeSessions);
    if (_native) _syncNative();
    setState(() {});
  }

  void _closeSessions({bool restoreFocus = true}) {
    if (_sessionsOverlay == null) return;
    _unregisterSessions?.call();
    _unregisterSessions = null;
    _sessionsOverlay?.remove();
    _sessionsOverlay?.dispose();
    _sessionsOverlay = null;
    if (!mounted) return;
    if (_native) _syncNative();
    setState(() {});
    if (restoreFocus) {
      _shellFocus.requestFocus();
      final pane = app.focusedPane;
      if (pane != null) app.focusPane(pane.id, reveal: true);
    }
  }

  Future<void> _closePane(TerminalPane pane) async {
    if (_closingPane ||
        pane.isWeb ||
        pane.agentId == null ||
        MediaQuery.disableAnimationsOf(context) ||
        !_minimize.capture(pane)) {
      await app.closePane(pane.id);
      return;
    }
    _closingPane = true;
    final tab = app.activeSwarmId;
    final overlay = Overlay.of(context);
    final box = overlay.context.findRenderObject() as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    _minimizeOverlay = OverlayEntry(
      builder: (_) => Positioned.fromRect(
        rect: _minimize.source.shift(-origin),
        child: PaneMinimizeSnapshot(controller: _minimize),
      ),
    );
    overlay.insert(_minimizeOverlay!);
    // Close logically before the first await: the next keystroke belongs to
    // the remaining pane, even while the captured pixels are still moving.
    final closed = app.closePane(pane.id);
    try {
      Offset? target;
      if (_native) {
        final anchor = await _channel.invokeMapMethod<String, dynamic>(
          'sessionsAnchor',
        );
        if (anchor?['reduceMotion'] == true) return;
        if (anchor?['x'] is num && anchor?['y'] is num) {
          target = Offset(
            (anchor!['x'] as num).toDouble(),
            (anchor['y'] as num).toDouble(),
          );
        }
      } else {
        final button = _sessionsButton.currentContext?.findRenderObject();
        if (button is RenderBox && button.hasSize) {
          target = button.localToGlobal(button.size.center(Offset.zero));
        }
      }
      if (!mounted || app.activeSwarmId != tab) return;
      if (target != null) await _minimize.animate(target);
      if (_native && mounted && app.activeSwarmId == tab) {
        unawaited(_channel.invokeMethod<void>('sessionMinimized'));
      }
    } on TickerCanceled {
      // Disposing the window cancels motion, never the agent process.
    } on MissingPluginException {
      // The pane is already closed; only the optional animation is skipped.
    } finally {
      _closingPane = false;
      _minimizeOverlay?.remove();
      _minimizeOverlay?.dispose();
      _minimizeOverlay = null;
      if (mounted) _minimize.reset();
      await closed;
    }
  }

  void _openSearch({
    bool adding = false,
    PaneSplitRequest? split,
    String query = '',
    HarnessPlacement? placement,
  }) {
    if (_search != null ||
        !mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        !_routeIsCurrent) {
      return;
    }
    // One surface, two modes: finding closes making.
    if (_newHarness case final box?) {
      if (box.busy || box.checking) {
        box.warn('Check the pending creation before opening another picker.');
        return;
      }
      _closeNewHarness(restoreFocus: false);
    }
    _closeCommandBar();
    _searchReturnFocus ??= FocusManager.instance.primaryFocus == _searchFocus
        ? null
        : FocusManager.instance.primaryFocus;
    if (_native) _preparePaneFocus();
    // Search is an overlay, so late pane attachment needs an explicit focus
    // boundary to keep its programmatic focus request out of the picker.
    _canvasFocus.descendantsAreFocusable = false;
    _search = SwarmSearchController(
      app,
      _navigation.recent,
      projects: _projects,
      commands: _searchCommands,
      recentCommands: () => _navigation.recentCommands,
      modes: _searchModes,
      adding: adding,
      offersCreate: adding,
      resultsFromBottom: true,
      split: split,
      placement:
          placement ??
          (adding && split == null
              ? (app.activeSwarm.isStore || app.activeSwarm.isOrchestrator
                    ? HarnessPlacement.newTab
                    : HarnessPlacement.currentTab)
              : null),
      catalog: _searchCatalog,
    )..setQuery(query);
    _search!.addListener(_syncSearch);
    _searchOverlay = OverlayEntry(builder: _buildSearchOverlay);
    Overlay.of(context).insert(_searchOverlay!);
    _syncSearch();
    // The overlay and focus nodes update independently of the retained canvas.
    _focusSearch();
  }

  void _focusSearch({bool selectAll = false}) {
    if (_search == null) return;
    _searchFocus.requestFocus();
    if (selectAll) {
      _searchText.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _searchText.text.length,
      );
    }
  }

  void _showSearchCommands() {
    if (_search == null) _openSearch(adding: true, query: '>');
    _search?.setQuery('>');
    _focusSearch();
    if (_search != null) _learning.commandSearchOpened();
  }

  void _syncSearch() {
    final search = _search;
    if (search == null) return;
    if (_searchText.text != search.query) {
      _searchText.value = TextEditingValue(
        text: search.query,
        selection: TextSelection.collapsed(offset: search.query.length),
      );
    }
    // Results listen to their controller directly. Rebuilding the entire
    // overlay on every arrow also rebuilt the unchanged text editor/button.
    final header = (
      search.hint,
      search.canCreate,
      search.title,
      search.placement,
    );
    if (_searchHeaderState != header) {
      _searchHeaderState = header;
      if (search.isCommandMode) _learning.commandSearchOpened();
      _searchOverlay?.markNeedsBuild();
    }
  }

  void _closeSearch({bool restoreFocus = true}) {
    if (_search == null) return;
    // Enable the chosen terminal synchronously, before activation requests its
    // focus and before the following frame rebuilds the canvas.
    _canvasFocus.descendantsAreFocusable = true;
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _searchOverlay = null;
    _search!.removeListener(_syncSearch);
    _search!.dispose();
    _search = null;
    _searchHeaderState = null;
    _searchText.clear();
    _searchFocus.unfocus();
    final previous = _searchReturnFocus;
    _searchReturnFocus = null;
    if (restoreFocus) {
      if (previous?.context?.mounted == true && previous!.canRequestFocus) {
        previous.requestFocus();
      } else if (app.focusedPane?.session?.focusInput() != true) {
        _shellFocus.requestFocus();
      }
    }
  }

  void _dismissSearch() {
    final target = _search?.targetId;
    _closeSearch();
    if (target != null) app.cancelSwarmDraft(target);
  }

  Future<void> _ensureEmptyEntry() async {
    if (!mounted || app.panes.isNotEmpty) return;
    await WidgetsBinding.instance.endOfFrame;
    if (mounted && _shortcutsEnabled && app.panes.isEmpty) {
      _restoreEmptyFocus();
    }
  }

  Future<void> _chooseSearch(SwarmSearchSelection choice) async {
    final target = _search?.targetId;
    final split = _search?.split;
    final placement = _search?.placement;
    if (target == null) return;
    if (choice.destination.isCreate) {
      // What was typed and found nothing is what the new harness starts on.
      final task = choice.destination.task;
      _closeSearch(restoreFocus: false);
      await _newAgent(
        swarmId: target,
        split: split,
        task: task,
        placement: placement,
      );
      return;
    }
    _closeSearch(restoreFocus: choice.destination.isCommand);
    // A blank tab already supplies the destination. Pin
    // selection to that tab, including while an exact resume is still pending.
    final targetTab = app.swarms.where((tab) => tab.id == target).firstOrNull;
    await _activateSearch(
      choice,
      target,
      split: split,
      placement:
          placement == HarnessPlacement.newTab &&
              targetTab?.isBlankNewTab == true
          ? HarnessPlacement.currentTab
          : placement,
    );
    if (mounted) {
      if (app.activeSwarmId != target) app.cancelSwarmDraft(target);
      await _ensureEmptyEntry();
    }
  }

  Widget _buildSearchOverlay(BuildContext context) {
    final search = _search!;
    // Results sit above a stable input line in the workspace command dock.
    // The input is visually below results, but Tab still starts at the first
    // result rather than a cached, offscreen ListView row below the input.
    Widget ordered(double order, Widget child) =>
        FocusTraversalOrder(order: NumericFocusOrder(order), child: child);
    final panel = TerminalBox(
      key: const ValueKey('swarm-search-results'),
      docked: true,
      child: FocusTraversalGroup(
        policy: OrderedTraversalPolicy(),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (search.title != search.placement?.title)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 9, 14, 2),
                child: Row(
                  children: [
                    Text(search.title, style: _boxCaption),
                    if (search.placement == HarnessPlacement.currentTab ||
                        search.split != null)
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: Text(
                            '· ${search.targetName}',
                            key: const ValueKey('swarm-search-target'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: _boxCaption,
                          ),
                        ),
                      )
                    else
                      const Spacer(),
                    SwarmSearchCount(search: search, terminal: true),
                  ],
                ),
              ),
            Flexible(
              child: ordered(
                2,
                SwarmSearchResults(
                  search: search,
                  onChoose: _chooseSearch,
                  onRefocus: _focusSearch,
                  fitRows: true,
                  terminal: true,
                ),
              ),
            ),
            ordered(
              1,
              Semantics(
                label: search.hint,
                child: ReadlineKeys(
                  controller: _searchText,
                  onChanged: search.setQuery,
                  child: SwarmSearchInput(
                    inputKey: const ValueKey('swarm-search-input'),
                    controller: _searchText,
                    focusNode: _searchFocus,
                    search: search,
                    onClose: _dismissSearch,
                    onChanged: search.setQuery,
                    onOpen: _focusSearch,
                    height: 38,

                    terminal: true,
                    hintText: search.hint,
                  ),
                ),
              ),
            ),
            ordered(
              3,
              SwarmSearchHints(
                search: search,
                onSubmit: () {
                  final choice = search.submit();
                  if (choice != null) unawaited(_chooseSearch(choice));
                },
                onAddHere: () {
                  final choice = search.addHere();
                  if (choice != null) unawaited(_chooseSearch(choice));
                },
                onClose: _dismissSearch,
                onQuery: (text) {
                  search.setQuery(text);
                  _focusSearch();
                },
              ),
            ),
          ],
        ),
      ),
    );
    final scoped = Semantics(
      scopesRoute: true,
      namesRoute: true,
      explicitChildNodes: true,
      label: search.title,
      child: panel,
    );
    return KeymapProvider(
      keymap: _keymap,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final contents = SwarmSearchKeys(
            search: search,
            editing: _searchText,
            onChoose: _chooseSearch,
            onClose: _dismissSearch,
            onOpen: _focusSearch,
            onNewAgent: () => _runShortcut('agent.new'),
            onRefocus: _focusSearch,
            child: scoped,
          );
          return Stack(
            children: [
              // A click outside still closes it; it just no longer dims. To a
              // screen reader it IS modal: without the block, VoiceOver walks
              // straight out of the box into the panes behind it.
              Positioned.fill(
                child: BlockSemantics(
                  child: GestureDetector(
                    key: const ValueKey('swarm-search-dismiss'),
                    behavior: HitTestBehavior.opaque,
                    onTap: _dismissSearch,
                  ),
                ),
              ),
              CommandDock(
                expanded: true,
                topClearance: _native ? 0.0 : _tabBarHeight,
                child: contents,
              ),
            ],
          );
        },
      ),
    );
  }

  void _stepHistory(int direction) {
    if (direction < 0
        ? !_navigation.canGoBack(app)
        : !_navigation.canGoForward(app)) {
      return;
    }
    _preparePaneFocus();
    _navigation.step(app, direction);
  }

  void _preparePaneFocus() {
    // The closing picker otherwise restores its previous terminal, whose focus
    // callback can overwrite the chosen destination during this same frame.
    _shellFocus.requestFocus();
    FocusManager.instance.applyFocusChangesIfNeeded();
  }

  Future<void> _addAgent() async {
    if ((app.activeSwarm.isStore || app.activeSwarm.isOrchestrator) &&
        !_newTab()) {
      return;
    }
    if (_search?.changePlacement(HarnessPlacement.currentTab) == true) {
      _focusSearch();
      return;
    }
    _closeSearch(restoreFocus: false);
    _openSearch(adding: true, placement: HarnessPlacement.currentTab);
  }

  bool _newTab() {
    if (!mounted || _dialogOpen || _spokenPaletteOpen || !_routeIsCurrent) {
      return false;
    }
    if (_newHarness case final box?) {
      if (box.busy || box.checking) {
        box.warn('Check the pending creation before opening another tab.');
        return false;
      }
      if (!box.requestDismiss()) return false;
    }
    final source = app.focusedPane ?? _newTabSources[app.activeSwarmId];
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    app.newSwarm(newTabPage: true);
    _newTabSources.removeWhere(
      (id, _) => !app.swarms.any((tab) => tab.id == id),
    );
    if (source != null) _newTabSources[app.activeSwarmId] = source;
    return true;
  }

  Future<void> _addProject() => _dialog(() async {
    final project = await showSwarmProjectDialog(context, app);
    if (project != null) await _projects.add(project);
  });
  Future<void> _notifications() async {
    _toggleSessions(filter: SessionFilter.needsInput);
  }

  Future<void> _openSpokenTask(SpokenTaskRequest request) async {
    final spoken = SpokenTask(
      voiceId: request.voiceId,
      text: request.text,
      cmd: request.cmd,
      report: (voiceId, state, agentId) =>
          app.reportVoiceRoute(request.machineId, voiceId, state, agentId),
    );
    if (_spokenPaletteOpen || _dialogOpen || !mounted) {
      spoken.cancelled();
      return;
    }
    _closeSearch();
    _spokenPaletteOpen = true;
    _closeCommandBar(restoreFocus: false);
    if (_native) _syncNative();
    try {
      await revealWindow();
      if (!mounted) {
        spoken.cancelled();
        return;
      }
      await showTaskPalette(context, app, spoken: spoken);
    } finally {
      _spokenPaletteOpen = false;
      if (_native && mounted) _syncNative();
      spoken.cancelled();
    }
  }

  void _maybeLink() {
    final machine = app.stateOf(app.selectedMachineId ?? '');
    if (machine == null ||
        !machine.needsLink ||
        machine.isLocalMachine ||
        _dialogOpen ||
        _commandBarOpen ||
        _search != null ||
        app.isLinkPromptDismissed(machine.machine.machineId) ||
        _linkDialogMachineId != null) {
      return;
    }
    _linkDialogMachineId = machine.machine.machineId;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (mounted) {
        await _dialog(
          () => showLinkMachineScreenDialog(
            context,
            app,
            machine.machine.machineId,
          ),
        );
      }
      _linkDialogMachineId = null;
    });
  }

  // Keyboard actions and search commands execute the same callbacks.
  late final Map<ShortcutAction, VoidCallback> _actionHandlers = {
    ShortcutAction.newSwarm: _newTab,
    ShortcutAction.reopenClosedSwarm: app.reopenClosed,
    ShortcutAction.closeSwarm: () => app.closeSwarm(app.activeSwarmId),
    ShortcutAction.renameSwarm: () => _rename(app.activeSwarmId),
    ShortcutAction.nextSwarm: () => app.stepSwarm(1),
    ShortcutAction.previousSwarm: () => app.stepSwarm(-1),
    ShortcutAction.showSettings: _settings,
    ShortcutAction.focusPaneLeft: () => app.focusPaneHorizontally(-1),
    ShortcutAction.focusPaneRight: () => app.focusPaneHorizontally(1),
    ShortcutAction.focusPaneAbove: () => app.focusPaneVertically(-1),
    ShortcutAction.focusPaneBelow: () => app.focusPaneVertically(1),
    ShortcutAction.movePaneLeft: () => app.movePaneDirection(dx: -1, dy: 0),
    ShortcutAction.movePaneRight: () => app.movePaneDirection(dx: 1, dy: 0),
    ShortcutAction.movePaneUp: () => app.movePaneDirection(dx: 0, dy: -1),
    ShortcutAction.movePaneDown: () => app.movePaneDirection(dx: 0, dy: 1),
    ShortcutAction.nextAgent: () => _stepHistory(1),
    ShortcutAction.previousAgent: () => _stepHistory(-1),
    ShortcutAction.showHistory: _showHistory,
    ShortcutAction.findTerminal: () =>
        app.focusedPane?.session?.find(TerminalFindAction.open),
    ShortcutAction.findNext: () =>
        app.focusedPane?.session?.find(TerminalFindAction.next),
    ShortcutAction.findPrevious: () =>
        app.focusedPane?.session?.find(TerminalFindAction.previous),
    ShortcutAction.lastPane: app.focusLastPane,
    ShortcutAction.zoomPane: app.toggleZoomPane,
    ShortcutAction.showAttention: _notifications,
    ShortcutAction.addAgent: _addAgent,
    ShortcutAction.closePane: () {
      if (app.focusedPane case final pane?) {
        unawaited(_closePane(pane));
      }
    },
    ShortcutAction.newAgent: _newAgent,
    ShortcutAction.newTerminal: _newTerminal,
    ShortcutAction.cloneAgent: _cloneAgent,
    ShortcutAction.routeTask: () =>
        _dialog(() => showTaskPalette(context, app)),
    ShortcutAction.orchestrate: () =>
        _dialog(() => showOrchestratorLauncher(context, app)),
    ShortcutAction.reload: app.retryMachines,
    ShortcutAction.showLayout: () =>
        _dialog(() => showLayoutPalette(context, app)),
    ShortcutAction.movePaneToTab: () {
      if (app.focusedPaneId == null) return;
      _dialog(() => showMovePanePalette(context, app));
    },
    ShortcutAction.pinPane: () {
      if (app.focusedPaneId != null) {
        app.togglePinPane(app.focusedPaneId!);
      }
    },
    ShortcutAction.showShortcuts: _showKeyboardShortcuts,
    ShortcutAction.showDebug: () => _dialog(
      () => showSettingsScreen(
        context,
        app,
        source: 'shortcut',
        initialSection: SettingsSection.debug,
      ),
    ),
  };

  late final Map<String, VoidCallback> _commands = {
    if (_hasCommandBar) 'navigation.command_bar': _focusCommandBar,
    for (final command in harnessCommands)
      if (command.action != null && _actionHandlers.containsKey(command.action))
        command.id: _actionHandlers[command.action]!,
    for (var i = 1; i <= kTabDigitCount; i++)
      'swarm.select_$i': () => app.selectSwarmByIndex(i - 1),
    for (var i = 1; i <= 9; i++)
      'pane.focus_$i': () => app.focusPaneByIndex(i - 1),
    'navigation.commands': _showSearchCommands,
    'app.customize': () => unawaited(_customize()),
    'app.store': _openStore,
    'agent.add': _addAgent,
    if (kDebugSurfaceEnabled) 'app.onboarding_review': _newTab,
    'agent.rename': () => _editAgent(),
    'agent.stop': () => _editAgent(stop: true),
    'agent.fork': _forkAgent,
    'agent.restart': _restartAgent,
    'machine.link': () =>
        _dialog(() => showSwarmLinkDialog(context, app, keymap: _keymap)),
    'machines.manage': _manageMachines,
    'machines.list': () =>
        _dialog(() => showMachinesManager(context, app, keymap: _keymap)),
    'project.add': _addProject,
    'keyboard.open_config': () => openKeyboardConfig(context),
    'keyboard.quick_start': _startQuickStart,
    'keyboard.practice': _practiceKeyboard,
    'keyboard.pause_guide': _learning.pause,
    'pane.resize': app.beginPaneResize,
    'pane.reset_sizes': app.resetPaneSizes,
    'pane.split_right': () => _splitAgent(PaneResizeAxis.x),
    'pane.split_down': () => _splitAgent(PaneResizeAxis.y),
  };

  bool _canExecuteCommand(String id) {
    if (!_commands.containsKey(id) ||
        !_routeIsCurrent ||
        _dialogOpen ||
        _spokenPaletteOpen) {
      return false;
    }
    if (id == 'keyboard.open_config') return _keymap.store != null;
    if (id == 'keyboard.pause_guide') return _learning.active;
    if (id == 'keyboard.quick_start' ||
        id == 'keyboard.practice' ||
        id == 'app.onboarding_review') {
      return app.viewer == null;
    }
    if (id == 'agent.rename' ||
        id == 'agent.stop' ||
        id == 'agent.fork' ||
        id == 'agent.clone' ||
        id == 'agent.restart') {
      final pane = app.focusedPane;
      final machine = pane == null ? null : app.stateOf(pane.machineId);
      // Clone and restart both ask the daemon for a launch, so both need it
      // reachable; clone is not gated on `canFork` — any engine can be opened
      // again, only a fork needs the engine to carry a conversation over.
      return machine != null &&
          !machine.machine.isShared &&
          (id != 'agent.fork' || _focusedAgent?.canFork == true) &&
          (id != 'agent.clone' || _focusedAgent?.canClone == true) &&
          ((id != 'agent.restart' && id != 'agent.clone') ||
              (machine.nodeOnline != false && !machine.needsLink)) &&
          machine.agents.any((agent) => agent.id == pane!.agentId);
    }
    if (id == 'pane.layout' || id == 'task.route') return true;
    if (id.startsWith('swarm.select_')) {
      final number = int.tryParse(id.substring('swarm.select_'.length));
      return number != null && number >= 1 && number <= app.swarms.length;
    }
    if (id == 'swarm.new') return true;
    if (id == 'swarm.reopen') return app.canReopenLastClosed;
    if (id == 'swarm.next' || id == 'swarm.previous') {
      return app.swarms.length > 1;
    }
    if (id == 'navigation.back') return _navigation.canGoBack(app);
    if (id == 'navigation.forward') return _navigation.canGoForward(app);
    // Opening a terminal needs no terminal to already be there; the other
    // `terminal.*` commands are find, which does.
    if (id == 'terminal.new') return true;
    if (id.startsWith('terminal.')) return _canFindTerminal;
    if (id == 'pane.resize') {
      return app.panes.length > 1 && app.zoomedPaneId == null;
    }
    if (id == 'pane.split_right') {
      return app.preparePaneSplit(PaneResizeAxis.x) != null;
    }
    if (id == 'pane.split_down') {
      return app.preparePaneSplit(PaneResizeAxis.y) != null;
    }
    if (id == 'pane.reset_sizes') {
      return app.activeSwarm.paneSizes.keys.any(
        (key) => key.startsWith('${app.panes.length}:'),
      );
    }
    if (id.startsWith('pane.') || id == 'task.route') {
      return app.focusedPane != null;
    }
    return true;
  }

  /// What `?` lists in the box: its other modes, in the order worth learning
  /// them, each with the key that goes there directly.
  List<SwarmDestination> _searchModes() {
    SwarmDestination? mode(String id, String title, String detail) =>
        !_canExecuteCommand(id)
        ? null
        : SwarmDestination(
            id: 'command:$id',
            title: title,
            detail: detail,
            swarmId: null,
            current: false,
            commandId: id,
            shortcut: _keymap.hint(id),
            searchFields: [id, detail],
          );
    return [
      SwarmDestination(
        id: 'picker:commands',
        title: '>  Commands',
        detail: 'Run anything by name',
        swarmId: null,
        current: false,
        pickerQuery: '>',
        shortcut: _keymap.hint('navigation.commands'),
      ),
      SwarmDestination(
        id: 'picker:projects',
        title: '#  Projects',
        detail: 'Choose a project, then one of its agents',
        swarmId: null,
        current: false,
        pickerQuery: '# ',
      ),
      SwarmDestination(
        id: 'picker:machines',
        title: '@  Machines',
        detail: 'Choose a machine, then one of its agents',
        swarmId: null,
        current: false,
        pickerQuery: '@ ',
      ),
      ?mode('agent.new', 'New Harness', 'agent · machine · project'),
      ?mode('app.store', 'Harness Store', 'Browse and install harnesses'),
      ?mode('terminal.new', 'New terminal', 'A shell where you are'),
      ?mode(
        'agent.clone',
        'Clone Harness',
        'Another of this one, fresh conversation',
      ),
      ?mode('navigation.needs_input', 'Agents needing input', 'Who is waiting'),
      ?mode('navigation.history', 'History', 'Where you have been'),
      ?mode('task.route', 'Boss mode', 'Describe a task, it picks the agent'),
      ?mode('pane.layout', 'Layout', 'Arrange the panes'),
      ?mode('keyboard.help', 'Keyboard shortcuts', 'Every key'),
      ?mode('keyboard.quick_start', 'Quick start', 'Four steps into real work'),
      ?mode('keyboard.practice', 'Keyboard practice', 'Try every shortcut'),
      ?mode('keyboard.open_config', 'Edit keybindings', 'keybindings.jsonc'),
      ?mode('app.customize', 'Customize Harness', 'Prompt · colors · fonts'),
      ?mode('app.settings', 'Settings', ''),
    ];
  }

  // Compiled once, not once per command per app tick while the palette is open.
  static final _paneFocusCommand = RegExp(r'^pane\.focus_[1-9]$');

  List<SwarmDestination> _searchCommands() => [
    for (final command in harnessCommands)
      if (!command.hidden &&
          command.id != 'navigation.commands' &&
          command.id != 'navigation.command_bar' &&
          !_paneFocusCommand.hasMatch(command.id) &&
          _canExecuteCommand(command.id))
        SwarmDestination(
          id: 'command:${command.id}',
          title:
              command.id == 'agent.stop' &&
                  isTerminalEngine(_focusedAgent?.engine)
              ? 'Stop Terminal'
              : command.id == 'agent.restart' &&
                    isTerminalEngine(_focusedAgent?.engine)
              ? 'Restart Terminal'
              : command.label,
          detail: command.group.label,
          swarmId: null,
          current: false,
          commandId: command.id,
          shortcut: _keymap.hint(command.id),
          searchFields: [command.id, ...command.keywords],
        ),
    if (_canExecuteCommand('app.settings'))
      for (final group in settingsGroups)
        for (final section in group.sections)
          SwarmDestination(
            id: 'command:$_settingsCommand${section.name}',
            title: 'Settings: ${section.label}',
            detail: 'Settings',
            swarmId: null,
            current: false,
            commandId: '$_settingsCommand${section.name}',
            searchFields: ['settings', 'preferences', section.name],
          ),
  ];

  void _focusCommandBar() {
    if (_commandBarOpen) {
      _closeCommandBar();
      return;
    }
    if (_newHarness case final box?) {
      if (box.locked) {
        box.warn('Check the pending creation before opening another prompt.');
        return;
      }
      _closeNewHarness(restoreFocus: false);
    }
    _closeSearch(restoreFocus: false);
    _commandReturnFocus = FocusManager.instance.primaryFocus;
    _preparePaneFocus();
    _canvasFocus.descendantsAreFocusable = false;
    setState(() => _commandBarOpen = true);
    _recordNavigation();
    _commandFocus.requestFocus();
  }

  void _closeCommandBar({bool restoreFocus = true, bool clear = true}) {
    if (!_commandBarOpen) return;
    _canvasFocus.descendantsAreFocusable =
        _search == null &&
        _newHarness == null &&
        !_dialogOpen &&
        !_spokenPaletteOpen;
    setState(() => _commandBarOpen = false);
    if (clear) _commandBar.dismiss();
    _commandFocus.unfocus();
    final previous = _commandReturnFocus;
    _commandReturnFocus = null;
    if (restoreFocus) {
      if (previous?.context != null && previous!.canRequestFocus) {
        previous.requestFocus();
      } else if (app.focusedPane?.session?.focusInput() != true) {
        _shellFocus.requestFocus();
      }
      FocusManager.instance.applyFocusChangesIfNeeded();
    }
  }

  void _commandChanged() {
    if (!mounted) return;
    if (_commandBarOpen && _commandBar.phase == CommandPhase.executing) {
      _commandActionInFlight = true;
      _closeCommandBar(clear: false);
    } else if (_commandActionInFlight &&
        _commandBar.phase == CommandPhase.done) {
      _commandActionInFlight = false;
      final message = _commandBar.error ?? _commandBar.message;
      final goBack = _commandBar.goBack;
      if (message.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(message),
            action: goBack == null
                ? null
                : SnackBarAction(
                    label: 'Go back',
                    onPressed: () => _returnFromCommand(goBack),
                  ),
          ),
        );
      }
    }
  }

  Future<void> _returnFromCommand(Future<String?> Function() goBack) async {
    if (!mounted) return;
    String? failure;
    try {
      failure = await goBack();
    } catch (_) {
      failure = 'The previous view is no longer available.';
    }
    if (mounted && failure != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(failure)));
    }
  }

  Widget _commandPalette() => Positioned.fill(
    key: const ValueKey('jev-command-palette'),
    child: Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _closeCommandBar,
            child: const ColoredBox(color: kDialogVeilTint),
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: SingleChildScrollView(
                  child: HarnessCommandBar(
                    controller: _commandBar,
                    focusNode: _commandFocus,
                    onDismiss: _closeCommandBar,
                    onNew: _newAgent,
                    onStore: _openStore,
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => PaneMinimizeScope(
    controller: _minimize,
    close: _closePane,
    child: _buildWorkspace(context),
  );

  Widget _buildWorkspace(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, _projects, _learning]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      _maybeLink();
      if (app.panes.isEmpty) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _restoreEmptyFocus(),
        );
      }
      return Actions(
        actions: {
          if (newHarnessOpensInBox)
            OpenHarnessIntent: CallbackAction<OpenHarnessIntent>(
              onInvoke: (intent) => _openProduct(
                intent.engine,
                intent.machineId,
                task: intent.task,
              ),
            ),
        },
        child: KeymapProvider(
          keymap: _keymap,
          child: KeymapHost(
            keymap: _keymap,
            enabled: () => _shortcutsEnabled,
            canExecute: _canExecuteCommand,
            actions: {
              for (final id in _commands.keys) id: () => _runShortcut(id),
            },
            onPending: (keys) => setState(() => _pendingKeys = keys),
            child: Focus(
              focusNode: _shellFocus,
              autofocus: app.panes.isNotEmpty,
              child: Scaffold(
                backgroundColor: grid.AppPalette.swarmField,
                body: Column(
                  children: [
                    if (!_native) _tabStrip(),
                    if (_learning.active && app.viewer == null)
                      WorkspaceQuickStart(
                        learning: _learning,
                        onCommand: _runShortcut,
                        onPractice: _practiceKeyboard,
                      ),
                    if (_keymap.error != null)
                      Material(
                        color: grid.AppPalette.panelBg,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Keyboard config has an error. Using the last working shortcuts.',
                                  style: grid.AppType.body(),
                                ),
                              ),
                              TextButton(
                                onPressed: () =>
                                    _dialog(() => showShortcutsSheet(context)),
                                child: const Text('Details'),
                              ),
                            ],
                          ),
                        ),
                      ),
                    if (_pendingKeys.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 4,
                        ),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            '$_pendingKeys …  Esc to cancel',
                            style: grid.AppType.monoMeta(
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ),
                      ),
                    if (_projects.error != null || app.lastError != null)
                      Material(
                        color: grid.AppPalette.panelBg,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.info_outline,
                                size: 16,
                                color: Colors.orangeAccent,
                              ),
                              const SizedBox(width: 10),
                              Expanded(
                                child: Text(
                                  _projects.error ?? app.lastError!,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: grid.AppType.body(),
                                ),
                              ),
                              if (_projects.error == null &&
                                  app.lastErrorRetryable)
                                TextButton(
                                  onPressed: app.retryMachines,
                                  child: const Text('Retry'),
                                ),
                              IconButton(
                                onPressed: _projects.error != null
                                    ? _projects.dismissError
                                    : app.dismissError,
                                tooltip: 'Dismiss',
                                icon: const Icon(Icons.close, size: 16),
                              ),
                            ],
                          ),
                        ),
                      ),
                    Expanded(
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          if (app.panes.isEmpty &&
                              !newHarnessOpensInBox &&
                              !app.activeSwarm.isNewTabPage)
                            const RepaintBoundary(
                              key: ValueKey('harness-start-background'),
                              child: SwarmWallpaper(),
                            ),
                          // Utility tabs hide the canvas without discarding its
                          // terminal renderers, scroll positions or selections.
                          Offstage(
                            key: const ValueKey('workspace-canvas'),
                            offstage:
                                app.activeSwarm.isStore ||
                                app.activeSwarm.isOrchestrator,
                            child: ExcludeFocus(
                              excluding:
                                  app.activeSwarm.isStore ||
                                  app.activeSwarm.isOrchestrator,
                              child: Padding(
                                padding: app.panes.isEmpty
                                    ? EdgeInsets.zero
                                    : const EdgeInsets.all(kWorkspaceInset),
                                child: Focus.withExternalFocusNode(
                                  focusNode: _canvasFocus,
                                  includeSemantics: false,
                                  child: Stack(
                                    children: [
                                      Positioned.fill(
                                        child: PaneGrid(
                                          notifier: app,
                                          swarmMode: true,
                                          onSplit: (paneId, axis) =>
                                              _splitAgent(axis, paneId: paneId),
                                          empty:
                                              app.panes.isEmpty &&
                                                  !app.activeSwarm.isStore &&
                                                  !app
                                                      .activeSwarm
                                                      .isOrchestrator
                                              ? newHarnessOpensInBox ||
                                                        app
                                                            .activeSwarm
                                                            .isNewTabPage
                                                    ? _startGuide()
                                                    : HarnessStartPage(
                                                        key: ValueKey(
                                                          'harness-start:${app.activeSwarmId}',
                                                        ),
                                                        focusNode:
                                                            _startSearchFocus,
                                                        createSearch: () =>
                                                            SwarmSearchController(
                                                              app,
                                                              _navigation
                                                                  .recent,
                                                              projects:
                                                                  _projects,
                                                              commands:
                                                                  _searchCommands,
                                                              recentCommands: () =>
                                                                  _navigation
                                                                      .recentCommands,
                                                              // The first box a new
                                                              // person meets is the same
                                                              // box: its placeholder
                                                              // promises `?` and a way
                                                              // to create, so it has them.
                                                              modes:
                                                                  _searchModes,
                                                              adding: true,
                                                              offersCreate:
                                                                  true,
                                                              placement:
                                                                  HarnessPlacement
                                                                      .currentTab,
                                                              catalog:
                                                                  _searchCatalog,
                                                            ),
                                                        onNewTab: _newTab,
                                                        onNewPane: _addAgent,
                                                        onCommands:
                                                            _showSearchCommands,
                                                        onQuickStart:
                                                            _learning.offer &&
                                                                app.viewer ==
                                                                    null
                                                            ? _startQuickStart
                                                            : null,
                                                        onPractice:
                                                            app.viewer == null
                                                            ? _practiceKeyboard
                                                            : null,
                                                        onNew: () => _newAgent(
                                                          placement:
                                                              HarnessPlacement
                                                                  .currentTab,
                                                        ),
                                                        onNewWithTask: (task) =>
                                                            _newAgent(
                                                              task: task,
                                                              placement:
                                                                  HarnessPlacement
                                                                      .currentTab,
                                                            ),
                                                        onStore: _openStore,
                                                        onChoose: (selection) =>
                                                            selection
                                                                .destination
                                                                .isCreate
                                                            ? _newAgent(
                                                                task: selection
                                                                    .destination
                                                                    .task,
                                                                placement:
                                                                    HarnessPlacement
                                                                        .currentTab,
                                                              )
                                                            : _activateSearch(
                                                                selection,
                                                                app.activeSwarmId,
                                                                placement:
                                                                    HarnessPlacement
                                                                        .currentTab,
                                                              ),
                                                      )
                                              : null,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                          if (app.activeSwarm.isOrchestrator)
                            OrchestratorWorkspace(
                              key: ValueKey(
                                'orchestrator:${app.activeSwarm.orchestratorId}',
                              ),
                              notifier: app,
                              machineId: app.activeSwarm.orchestratorMachineId!,
                              projectId: app.activeSwarm.orchestratorId!,
                            ),
                          if (app.activeSwarm.isStore)
                            StoreTab(
                              key: ValueKey('store-tab:${app.activeSwarmId}'),
                              notifier: app,
                              recentHarnesses: _navigation.recent,
                              source: 'tab',
                            ),
                          if (_hasCommandBar && _commandBarOpen)
                            _commandPalette(),
                          // Last in the stack, so a banner is never painted
                          // under a pane, a tab or the palette. It takes
                          // pointers only on the banners themselves.
                          AgentAlertBanners(notifier: app),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );

  static const double _tabBarHeight = 40;
  double _tabExtent = 188;

  void _revealSelectedTab(double viewport) {
    final previous = _tabGeometry;
    final order = app.swarms.map((tab) => tab.id).toList(growable: false);
    if (previous != null &&
        previous.activeId == app.activeSwarmId &&
        previous.viewport == viewport &&
        listEquals(previous.order, order)) {
      return;
    }
    _tabGeometry = (
      activeId: app.activeSwarmId,
      order: order,
      viewport: viewport,
    );
    final oldIndex = previous?.order.indexOf(previous.activeId) ?? -1;
    final wasVisible =
        _tabScroll.hasClients &&
        oldIndex >= 0 &&
        (oldIndex + 1) * _tabExtent > _tabScroll.offset &&
        oldIndex * _tabExtent < _tabScroll.offset + previous!.viewport;
    // A selected tab follows keyboard navigation and layout changes, but
    // background agent updates must not undo deliberate strip scrolling.
    if (previous != null &&
        previous.activeId == app.activeSwarmId &&
        !wasVisible) {
      return;
    }
    if (_tabRevealScheduled) return;
    _tabRevealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _tabRevealScheduled = false;
      if (!mounted || !_tabScroll.hasClients) return;
      final index = app.swarms.indexWhere((tab) => tab.id == app.activeSwarmId);
      if (index < 0) return;
      final position = _tabScroll.position;
      final left = index * _tabExtent;
      final right = left + _tabExtent;
      final offset =
          left < position.pixels || _tabExtent > position.viewportDimension
          ? left
          : right > position.pixels + position.viewportDimension
          ? right - position.viewportDimension
          : position.pixels;
      final target = offset.clamp(0.0, position.maxScrollExtent);
      if (target != position.pixels) _tabScroll.jumpTo(target);
    });
  }

  Widget _tabStrip() => LayoutBuilder(
    builder: (context, constraints) {
      return Container(
        height: _tabBarHeight,
        color: grid.AppPalette.swarmTabBar,
        child: Row(
          children: [
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  _tabExtent = constraints.maxWidth.clamp(64, 188);
                  _revealSelectedTab(constraints.maxWidth);
                  return ReorderableListView.builder(
                    scrollController: _tabScroll,
                    itemExtent: _tabExtent,
                    scrollDirection: Axis.horizontal,
                    shrinkWrap: true,
                    buildDefaultDragHandles: false,
                    itemCount: app.swarms.length,
                    onReorderItem: (old, to) =>
                        app.reorderSwarm(app.swarms[old].id, to),
                    itemBuilder: (context, index) {
                      final swarm = app.swarms[index];
                      return ReorderableDragStartListener(
                        key: ValueKey(swarm.id),
                        index: index,
                        child: GestureDetector(
                          onDoubleTap: () => _rename(swarm.id),
                          child: _TabActionsReveal(
                            builder: (showClose) => Container(
                              width: _tabExtent - 2,
                              margin: const EdgeInsets.only(top: 4, right: 2),
                              decoration: ShapeDecoration(
                                color: app.activeSwarmId == swarm.id
                                    ? grid.AppPalette.swarmField
                                    : Colors.transparent,
                                shape: const TerminalTabBorder(),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: TextButton(
                                      onPressed: () =>
                                          app.selectSwarm(swarm.id),
                                      style: TextButton.styleFrom(
                                        shape: const RoundedRectangleBorder(
                                          borderRadius: BorderRadius.all(
                                            Radius.circular(
                                              kTerminalCornerRadius,
                                            ),
                                          ),
                                        ),
                                        animationDuration: Duration.zero,
                                        foregroundColor:
                                            app.activeSwarmId == swarm.id
                                            ? Colors.white
                                            : Colors.white70,
                                      ),
                                      child: Row(
                                        children: [
                                          if (swarm.isStore)
                                            StoreMark(
                                              key: ValueKey(
                                                'tab-store:${swarm.id}',
                                              ),
                                            )
                                          else if (_tabAgents(swarm).length ==
                                              1)
                                            EngineMark(
                                              key: ValueKey(
                                                'tab-engine:${swarm.id}',
                                              ),
                                              engine: _tabEngine(swarm),
                                              size: 16,
                                            )
                                          else if (_tabAgents(swarm).length > 1)
                                            SwarmIcon(
                                              key: ValueKey(
                                                'tab-group:${swarm.id}',
                                              ),
                                              size: 16,
                                              color: Colors.white70,
                                            )
                                          else
                                            const Icon(Icons.add, size: 16),
                                          const SizedBox(width: 8),
                                          Expanded(
                                            child: Text(
                                              swarm.name,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              // Like the native tabs.
                                              style: grid.AppType.monoLabel(
                                                color: Colors.white,
                                                fontWeight: FontWeight.w400,
                                              ),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  Opacity(
                                    key: ValueKey('tab-close:${swarm.id}'),
                                    opacity: showClose ? 1 : 0,
                                    alwaysIncludeSemantics: true,
                                    child: IconButton(
                                      onPressed: () => app.closeSwarm(swarm.id),
                                      icon: Icon(
                                        Icons.close,
                                        size: 13,
                                        semanticLabel: 'Close ${swarm.name}',
                                      ),
                                      constraints:
                                          const BoxConstraints.tightFor(
                                            width: 30,
                                            height: 30,
                                          ),
                                      padding: EdgeInsets.zero,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
            IconButton(
              key: const ValueKey('swarm-new-tab-button'),
              onPressed: _newTab,
              tooltip: 'New Tab ${_keymap.hint('swarm.new') ?? ''}'.trim(),
              icon: const Icon(Icons.add, size: 18, semanticLabel: 'New Tab'),
            ),
            IconButton(
              key: _sessionsButton,
              tooltip: 'Harness Monitor',
              onPressed: _toggleSessions,
              isSelected: _sessionsOverlay != null,
              icon: Badge(
                isLabelVisible: _attention > 0,
                backgroundColor: const Color(0xffcf4038),
                textColor: Colors.white,
                largeSize: 13,
                alignment: Alignment.topRight,
                label: Text(
                  _attention > 99 ? '99+' : '$_attention',
                  semanticsLabel:
                      '$_attention ${_attention == 1 ? 'harness needs' : 'harnesses need'} input',
                  style: const TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                child: Image.asset(
                  'assets/harnesses.png',
                  width: 24,
                  height: 24,
                  filterQuality: FilterQuality.high,
                  semanticLabel: 'Harness Monitor',
                ),
              ),
            ),
            const SizedBox(width: 6),
            Tooltip(
              message: 'Harness Store ${_keymap.hint('app.store') ?? ''}'
                  .trim(),
              child: TextButton.icon(
                key: const ValueKey('swarm-store-button'),
                onPressed: _openStore,
                style: TextButton.styleFrom(
                  foregroundColor: grid.AppPalette.swarmAccent,
                  backgroundColor: Color.alphaBlend(
                    grid.AppPalette.swarmAccent.withValues(alpha: 0.10),
                    grid.AppPalette.swarmField,
                  ),
                  overlayColor: grid.AppPalette.swarmAccent,
                  textStyle: grid.AppType.monoLabel(),
                  minimumSize: const Size(0, 28),
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  shape: StadiumBorder(
                    side: BorderSide(
                      color: grid.AppPalette.swarmAccent.withValues(
                        alpha: 0.12,
                      ),
                    ),
                  ),
                ),
                icon: const StoreMark(),
                label: const Text('Harness Store'),
              ),
            ),
            const SizedBox(width: 6),
          ],
        ),
      );
    },
  );
}

/// Hovering or focusing one tab only rebuilds its own controls.
class _TabActionsReveal extends StatefulWidget {
  const _TabActionsReveal({required this.builder});
  final Widget Function(bool visible) builder;

  @override
  State<_TabActionsReveal> createState() => _TabActionsRevealState();
}

class _TabActionsRevealState extends State<_TabActionsReveal> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Focus(
        canRequestFocus: false,
        includeSemantics: false,
        onFocusChange: (value) => setState(() => _focused = value),
        child: widget.builder(_hovered || _focused),
      ),
    );
  }
}
