import 'dart:math' as math;
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../analytics/analytics.dart';
import '../core/desktop_window.dart';
import '../core/harness_file_store.dart';
import '../core/project_folder.dart';
import '../core/test_run.dart';
import '../logging/debug_surface.dart';
import '../models/models_panel.dart';
import '../models/model_search_catalog.dart';
import '../widgets/resting_section.dart' show confirmSwitchAnyway;
import '../settings/settings_screen.dart';
import '../settings/settings_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../sharing/share_harness_dialog.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/status_line_style.dart';
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
import 'swarm_menu_bus.dart';
import '../state/pane_arrangement.dart';
import '../terminal/terminal_viewport.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../usage/models_menu_controller.dart';
import '../state/swarm_catalog.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../state/swarm.dart';
import '../state/workspace_status.dart';
import '../state/workspace_pull_request.dart';
import '../state/terminal_pane.dart';
import '../widgets/transient_menus.dart';
import '../widgets/layout_palette.dart';
import '../widgets/move_pane_palette.dart';
import '../widgets/engine_identity.dart';
import '../widgets/status_line.dart';
import '../widgets/workspace_status_line.dart';
import '../widgets/workspace_bar_control.dart';
import '../widgets/grid_model_picker.dart';
import '../store/store_mark.dart';
import '../store/store_screen.dart';
import '../widgets/harness_start_page.dart';
import '../widgets/machines_panel.dart';
import '../widgets/harness_session_manager.dart';
import '../widgets/onboarding_card.dart';
import '../state/toolbar_notices.dart';
import '../widgets/machine_actions.dart';
import '../widgets/rename_agent_dialog.dart';
import '../widgets/delete_agent_dialog.dart';
import '../widgets/fork_agent_dialog.dart';
import '../widgets/restart_agent_action.dart';
import '../widgets/new_agent_dialog.dart';
import '../widgets/box_chrome.dart';
import '../widgets/new_harness_form.dart';
import '../widgets/open_harness_intent.dart';
import '../widgets/pane_grid.dart';
import '../widgets/remote_folder_picker.dart';
import '../widgets/shortcuts_sheet.dart';
import '../widgets/harness_customize_pane.dart';
import '../shared/widgets/app_dialog.dart';
import '../widgets/swarm_dialogs.dart';
import '../widgets/swarm_search_input.dart';
import '../widgets/swarm_command_picker.dart';
import '../widgets/swarm_switcher.dart';
import '../widgets/swarm_resource_preview.dart';
import '../widgets/swarm_wallpaper.dart';
import '../widgets/task_palette.dart';
import '../state/command_bar.dart';
import '../state/command_bar_catalog.dart';
import '../widgets/harness_command_bar.dart';
import '../orchestrator/orchestrator_launcher.dart';
import '../orchestrator/orchestrator_workspace.dart';
import '../state/workspace_learning.dart';
import '../state/workspace_onboarding.dart';
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
    this.onboarding,
  });
  final AppNotifier notifier;
  final bool? nativeTabs;
  final SwarmProjectStore? projectStore;
  final ModelsMenuController? modelsMenu;
  final bool commandBarEnabled;
  final CommandResolver? commandResolver;
  final WorkspaceLearning? learning;
  final WorkspaceOnboarding? onboarding;
  @override
  State<SwarmScreen> createState() => _SwarmScreenState();
}

enum _NewHarnessSource { workspace, product }

/// Drafts belong to the entry's source, before the person edits its defaults.
/// Product requests also name an agent explicitly: two Store pages must never
/// resume one another's drafts. Placement remains separate, so Cmd-T and Cmd-O
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

class _SwarmScreenState extends State<SwarmScreen> {
  /// The title bar's seam: the `harness/swarm_tabs` channel on macOS — and
  /// in anything forced onto the native-tabs path, so a test can still mock
  /// the channel — and the Linux menu bar's bus here. One set of payloads
  /// out, one switch of actions back.
  late final SwarmMenuBus _menuBus = widget.nativeTabs == true
      ? SwarmMenuBus.forChannel()
      : swarmMenuBus;

  /// The tab the middle button went down on, so an up that slid onto another
  /// tab closes nothing. Null between presses.
  String? _middleDownTab;
  late final bool _native =
      widget.nativeTabs ?? (Platform.isMacOS && !kUnderTest);

  /// A menu bar is listening: AppKit's on macOS, the in-window bar on Linux.
  /// Not the same as [_native], which is whether AppKit also draws the tab
  /// strip and the title-bar buttons. On Linux Flutter still draws those, so
  /// the strip stays and only the menu state and actions cross the bus.
  late final bool _menuHost = _native || (Platform.isLinux && !kUnderTest);
  late final SwarmProjectStore _projects =
      widget.projectStore ??
      SwarmProjectStore(storage: kUnderTest ? null : HarnessFileStore.shared);
  StreamSubscription<SpokenTaskRequest>? _spokenTasks;
  StreamSubscription<void>? _modelsRequests;
  final _shellFocus = FocusNode(debugLabel: 'Swarm shell');
  final _focusedModelController = GridModelPickerController();
  MachinesPanelHandle? _machinesPanel;
  OverlayEntry? _modelsOverlay;
  VoidCallback? _unregisterModels;
  OverlayEntry? _harnessesOverlay;
  VoidCallback? _unregisterHarnesses;
  late final WorkspacePullRequest _pullRequest;
  final _toolbarNotices = ToolbarNotices();
  late final _onboarding =
      widget.onboarding ??
      WorkspaceOnboarding(storage: kUnderTest ? null : HarnessFileStore.shared);
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
  final _searchFocus = FocusNode(debugLabel: 'Search harnesses');
  // Prefix edits switch between command and resource layouts. Keep the same
  // editor mounted so its text-input connection and composition survive.
  late GlobalKey _searchInputKey;
  final _tabScroll = ScrollController();
  ({String activeId, List<String> order, double viewport, List<double> widths})?
  _tabGeometry;
  bool _tabRevealScheduled = false;
  SwarmSearchController? _search;
  OverlayEntry? _searchOverlay;
  final _resourcePreviewKey = GlobalKey();

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

  /// A folder chooser opened from the new-harness box is still waiting.
  ///
  /// The box keeps its keyboard focus while the chooser is up, so Enter on the
  /// Browse… row — or a second click — arrives here again. AppKit answers a
  /// second `beginSheetModal` by QUEUEING it behind the first, which looks
  /// exactly like a picker that refused to open.
  bool _pickingFolder = false;
  bool _newHarnessHidden = false;
  bool _routeIsCurrent = true;
  String? _linkDialogMachineId;
  String? _nativeState;
  List<Object?>? _machinesPresentation;
  ModelsMenuController? _modelsMenu;
  ModelSearchCatalog? _pickerModels;
  WorkspacePaneContext? _modelSelectionTarget;
  final _previewControls = SearchPreviewControls();
  bool _modelSearchVisible = false;
  bool _machineSearchVisible = false;
  bool _storeSearchVisible = false;
  int _pickerModalDepth = 0;
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

  Widget _startGuide() => WorkspaceWelcome(
    key: ValueKey('welcome:${app.activeSwarmId}'),
    onCommand: _runShortcut,
  );

  void _showKeyboardShortcuts() {
    if (_newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    unawaited(_dialog(() => showShortcutsSheet(context)));
  }

  @override
  void initState() {
    super.initState();
    _pullRequest = WorkspacePullRequest(app)..addListener(_statusPrefsChanged);
    _keymap.addListener(_keymapChanged);
    app.hasNavigationRail = false;
    app.railFocused = false;
    _recordNavigation();
    app.addListener(_recordNavigation);
    app.addListener(_observeLearning);
    // Its own notifier, so marking one agent does not rebuild the workspace —
    // which means the badge has to ask for its own redraw.
    app.agentUnread.addListener(_unreadChanged);
    // Coming back to the window puts the tab in front of the person again, and
    // nothing in the app necessarily changes when that happens — so it is told.
    //
    // The daemon is told too, on the way out as well as the way back: it decides
    // from `app_panes` whether a finished turn is already on screen, and that
    // roster does not change when the window slips behind a browser. Without
    // the second half the dial went quiet the first time this window lost focus
    // and stayed quiet until a pane happened to change.
    _lifecycle = AppLifecycleListener(
      onResume: () {
        app.seeWatchedAgents();
        app.announceWindowForeground();
      },
      onHide: app.announceWindowForeground,
      onInactive: app.announceWindowForeground,
      // Whether the app is in front of anyone decides whether the model surfaces refresh at all
      // (`AppNotifier.foreground`): a minimised or background window asks no daemon anything.
      onStateChange: app.appLifecycleChanged,
    );
    app.appLifecycleChanged(WidgetsBinding.instance.lifecycleState);
    // A click on a system notification does what a click on its banner does,
    // from wherever the window was: bring it forward, then open that agent.
    app.systemNotifications.onTap = (machineId, agentId) async {
      await revealWindow();
      if (!mounted) return;
      try {
        await app.revealAgentFromAlert(machineId, agentId);
      } catch (_) {
        // An agent deleted since, or a machine this window no longer reaches.
        // The window came forward, which is most of what a click asked for.
      }
    };
    app.addListener(_syncToolbarNotices);
    _toolbarNotices.addListener(_toolbarNoticesChanged);
    _onboarding.addListener(_onboardingChanged);
    _syncToolbarNotices();
    unawaited(
      _learning.load().then((_) {
        if (mounted) _observeLearning();
      }),
    );
    FocusManager.instance.addListener(_restoreEmptyFocus);
    FocusManager.instance.addListener(_syncKeyContext);
    grid.AppTheme.palette.addListener(_paletteChanged);
    terminalThemeStore.addListener(_paletteChanged);
    appearancePrefsStore.addListener(_statusPrefsChanged);
    terminalFontStore.addListener(_fontChanged);
    unawaited(_projects.load());
    unawaited(_navigation.load());
    _spokenTasks = app.spokenTasks.listen(_openSpokenTask);
    // The app's shared controller, so this menu and every pane's model picker show one reading.
    _modelsMenu = widget.modelsMenu ?? app.modelsMenu;
    app.modelManager.addListener(_modelManagerChanged);
    _modelsRequests = app.modelsRequests.listen((_) {
      if (mounted && !_modelsVisible) {
        _toggleModels(initialTab: ModelsTab.local);
      }
    });
    if (!kUnderTest) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        app.modelManager.start();
        // Subscription usage is read ahead, so opening a menu shows it without waiting.
        _modelsMenu!.start();
      });
    }
    if (_menuHost) {
      _menuBus.setHandler(_onNative);
      app.addListener(_syncNative);
      _syncNative();
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
        (_search != null ||
            _commandBarOpen ||
            _harnessesVisible ||
            _modelsVisible)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_routeIsCurrent && _pickerModalDepth == 0) {
          _closeSearch(restoreFocus: false);
          _closeCommandBar(restoreFocus: false);
          _closeModelsControls(restoreFocus: false);
          _closeHarnessControls(restoreFocus: false);
        }
      });
    }
    if (_menuHost) _syncNative();
  }

  @override
  void dispose() {
    app.removeListener(_syncToolbarNotices);
    _toolbarNotices.removeListener(_toolbarNoticesChanged);
    _toolbarNotices.dispose();
    _machinesPanel?.close(restoreFocus: false);
    _unregisterModels?.call();
    _modelsOverlay?.remove();
    _modelsOverlay?.dispose();
    _unregisterHarnesses?.call();
    _harnessesOverlay?.remove();
    _harnessesOverlay?.dispose();
    _onboarding.removeListener(_onboardingChanged);
    if (widget.onboarding == null) _onboarding.dispose();
    app.modelManager.removeListener(_modelManagerChanged);
    app.modelManager.setPanelVisible(false);
    _modelsRequests?.cancel();
    _keymap.removeListener(_keymapChanged);
    _defaultKeymap.dispose();
    grid.AppTheme.palette.removeListener(_paletteChanged);
    terminalThemeStore.removeListener(_paletteChanged);
    appearancePrefsStore.removeListener(_statusPrefsChanged);
    _pullRequest.removeListener(_statusPrefsChanged);
    _pullRequest.dispose();
    terminalFontStore.removeListener(_fontChanged);
    app.removeListener(_recordNavigation);
    app.removeListener(_observeLearning);
    app.agentUnread.removeListener(_unreadChanged);
    _lifecycle?.dispose();
    if (widget.learning == null) _learning.dispose();
    FocusManager.instance.removeListener(_restoreEmptyFocus);
    FocusManager.instance.removeListener(_syncKeyContext);
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _search?.dispose();
    _pickerModels?.dispose();
    _focusedModelController.dispose();
    _previewControls.dispose();
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
    app.systemNotifications.onTap = null;
    if (_menuHost) {
      unawaited(_menuBus.send('machinesState', {'machines': []}));
      app.removeListener(_syncNative);
      _menuBus.setHandler(null);
      unawaited(_menuBus.send('update', {'tabs': [], 'enabled': false}));
    }
    if (widget.projectStore == null) _projects.dispose();
    super.dispose();
  }

  AppKeymap? _sentKeymap;
  int? _sentKeymapVersion;
  void _syncKeymap() {
    if (!_menuHost ||
        (_sentKeymap == _keymap && _sentKeymapVersion == _keymap.version)) {
      return;
    }
    _sentKeymap = _keymap;
    _sentKeymapVersion = _keymap.version;
    unawaited(
      _menuBus.send(
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
    if (!_menuHost) return;
    final focus = FocusManager.instance.primaryFocus?.context;
    final kind = focus == null
        ? KeymapContext.workspace
        : KeymapRegion.of(focus)?.contextKind ?? KeymapContext.workspace;
    if (_nativeKeyContext == kind.name) return;
    _nativeKeyContext = kind.name;
    unawaited(_menuBus.send('keymapContext', {'context': kind.name}));
  }

  bool get _modelsVisible =>
      _modelsOverlay != null || _search?.isModelMode == true;
  bool get _machinesVisible =>
      _machinesPanel != null || _search?.isMachineMode == true;
  bool get _harnessesVisible =>
      _harnessesOverlay != null || _search?.scopePrefix.isEmpty == true;

  bool get _shortcutsEnabled =>
      mounted && _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen;

  void _runShortcut(String id) {
    _machinesPanel?.close(restoreFocus: false);
    _closeModelsControls(restoreFocus: false);
    _closeHarnessControls(restoreFocus: false);
    if (id != 'navigation.command_bar') _closeCommandBar();
    if (id == 'agent.new' && _search != null) {
      final target = _search!.targetId;
      final split = _search!.split;
      final placement = _search!.placement;
      final task = _search!.createTask;
      final selected = _search!.selected;
      final machineId =
          _search!.scopedMachineId ??
          (selected?.isMachine == true ? selected!.machineId : null);
      _closeSearch(restoreFocus: false);
      unawaited(
        _newAgent(
          machineId: machineId,
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
        id != 'harnesses.list' &&
        id != 'models.list' &&
        id != 'machines.list' &&
        id != 'machine.link' &&
        id != 'navigation.needs_input' &&
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
    if (_search?.hasPendingAction == true &&
        !app.swarms.any((swarm) => swarm.id == _search!.targetId)) {
      _search!.followRemainingWorkspace();
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

  /// Agents carrying news nobody has looked at.
  ///
  /// This is what the icon's badge counts now, and it is a wider question than
  /// [_attention]: a harness that FINISHED is also something to go and see, and
  /// the badge that only counted blocked ones said nothing at all about the
  /// work that was actually done while you were away. The panel behind the icon
  /// still separates the two — its "Needs input" tab is exactly [_attention].
  int get _unread => app.agentUnread.count;

  void _syncOnboarding() {
    final profile = app.currentUser;
    final local = app.localMachineState?.machine.machineId;
    final used = app.allPanes
        .where(
          (pane) =>
              pane.session?.acceptsInput == true &&
              pane.session?.engineId != kTerminalEngine &&
              app.stateOf(pane.machineId)?.machine.isShared == false,
        )
        .toList();
    final localModels = app.modelManager.sections
        .where((section) => section.own)
        .expand((section) => section.models)
        .map((model) => model.id)
        .toSet();
    _onboarding.sync(
      scope: app.isGuest
          ? 'local:${local ?? 'guest'}'
          : 'account:${profile?.id ?? profile?.email ?? local}',
      observed: {
        if (used.isNotEmpty) OnboardingStep.harnesses,
        if (used.any(
          (pane) => app.stateOf(pane.machineId)?.isLocalMachine == false,
        ))
          OnboardingStep.machines,
        if (used.any(
          (pane) =>
              app
                  .stateOf(pane.machineId)
                  ?.agents
                  .any(
                    (agent) =>
                        agent.id == pane.agentId &&
                        agent.gridModel != null &&
                        localModels.contains(agent.gridModel),
                  ) ==
              true,
        ))
          OnboardingStep.models,
      },
      otherComputer:
          !app.isGuest &&
          app.machineStates.values.any(
            (machine) => !machine.isLocalMachine && !machine.machine.isShared,
          ),
      modelsAvailable: app.modelManager.localModels.any(
        (model) => model.canStart || model.running,
      ),
    );
  }

  void _onboardingChanged() {
    if (!mounted) return;
    _machinesPanel?.rebuild();
    _modelsOverlay?.markNeedsBuild();
    _harnessesOverlay?.markNeedsBuild();
    if (_menuHost) _syncNative();
    setState(() {});
  }

  void _syncToolbarNotices() {
    _syncOnboarding();
    final local = app.localMachineState?.machine.machineId;
    final models = app.modelManager;
    final profile = app.currentUser;
    final scope = app.isGuest
        ? 'local:$local'
        : 'account:${profile?.id ?? profile?.email ?? local}';
    _toolbarNotices.sync(
      scope: scope,
      machines: {
        if (!app.isGuest)
          for (final machine in app.machineStates.values)
            if (!machine.isLocalMachine &&
                !machine.machine.isShared &&
                machine.needsLink &&
                machine.nodeOnline == true)
              machine.machine.machineId,
      },
      readyModels: {
        for (final model in models.localModels)
          if (local != null &&
              model.running &&
              model.operation?.started == true)
            '$local/${model.operation!.id}',
      },
      catalog: models.localModels.map((model) => model.id).toSet(),
      catalogLoaded: models.loaded,
      machinesVisible: _machinesVisible,
      modelsVisible: _modelsVisible,
    );
  }

  void _toolbarNoticesChanged() {
    if (!mounted) return;
    _modelsOverlay?.markNeedsBuild();
    if (_menuHost) _syncNative();
    setState(() {});
  }

  AppLifecycleListener? _lifecycle;

  void _unreadChanged() {
    if (!mounted) return;
    setState(() {});
    // The native titlebar draws its own badge, and its state is pushed from
    // `_syncNative` — which is subscribed to the APP, not to this notifier. A
    // mark that only called setState redrew a tab strip the native window does
    // not use, and the badge a person can actually see never moved.
    if (_menuHost) _syncNative();
  }

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

  void _statusPrefsChanged() {
    if (_menuHost) _syncNative();
    if (mounted) setState(() {});
  }

  Map<String, Object> _nativeStatusLine(
    StatusLineParts parts,
    TerminalTheme theme, {
    int segmentOffset = 0,
  }) => {
    'text': parts.text,
    'segmented': parts.style.segmented,
    'roundedSeparators': parts.style.roundedSeparators,
    'roundedStart': parts.style.roundedStart && segmentOffset == 0,
    'roundedEnd': parts.style.roundedEnd,
    'segments': [
      for (final part in statusLinePaintSegments(
        parts,
        theme,
        color: appearancePrefsStore.value.prompt.color,
        segmentOffset: segmentOffset,
      ))
        part.toJson(),
    ],
  };

  Map<StatusLineField, StatusLineLink> _contextLinks(
    WorkspacePaneContext focused,
  ) => {
    StatusLineField.machine: (
      label: 'Find harnesses on ${focused.machineName}',
      onPressed:
          _shortcutsEnabled && app.stateOf(focused.pane.machineId) != null
          ? () => _openContextResource(StatusLineField.machine, focused.pane.id)
          : null,
    ),
    if (focused.project != null)
      StatusLineField.project: (
        label:
            'Find harnesses in ${focused.projectName}\n${focused.project!.cwd}',
        onPressed: _shortcutsEnabled
            ? () =>
                  _openContextResource(StatusLineField.project, focused.pane.id)
            : null,
      ),
    if (focused.branch != null && focused.project != null)
      StatusLineField.branch: (
        label: 'Find harnesses on ${focused.branch} in ${focused.projectName}',
        onPressed: _shortcutsEnabled
            ? () =>
                  _openContextResource(StatusLineField.branch, focused.pane.id)
            : null,
      ),
  };

  void _openContextResource(StatusLineField field, int expectedPaneId) {
    if (!_shortcutsEnabled) return;
    final focused = WorkspacePaneContext.focused(app);
    if (focused == null || focused.pane.id != expectedPaneId) return;
    if (field == StatusLineField.branch && focused.branch == null) return;
    if (app.stateOf(focused.pane.machineId) == null) return;
    final group = field == StatusLineField.machine
        ? 'machine:${focused.pane.machineId}'
        : focused.project == null
        ? null
        : 'project:${focused.project!.identity(focused.pane.machineId)}';
    if (group == null) return;
    dismissTransientMenus();
    // A context link is scoped picker navigation, even if a split picker was open.
    _closeSearch(restoreFocus: false);
    _openSearch(adding: true, query: '');
    final search = _search;
    if (search == null) return;
    search.scopeToGroup(
      group,
      branch: field == StatusLineField.branch ? focused.project?.branch : null,
    );
    _focusSearch();
  }

  Future<void> _openFocusedPullRequest(String? expectedUrl) async {
    final pr = _pullRequest.value;
    if (pr == null || expectedUrl != pr.url.toString()) return;
    var opened = false;
    try {
      opened = await launchUrl(pr.url, mode: LaunchMode.externalApplication);
    } catch (_) {
      /* Show failure below. */
    }
    if (!opened && mounted) {
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('Could not open GitHub.')));
    }
  }

  void _paletteChanged() {
    _machinesPanel?.rebuild();
    _modelsOverlay?.markNeedsBuild();
    _harnessesOverlay?.markNeedsBuild();
    _searchOverlay?.markNeedsBuild();
    if (_menuHost) _syncNative();
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
    _syncMachines();
    final focused = WorkspacePaneContext.focused(app);
    final prefs = appearancePrefsStore.value.prompt;
    final parts = focused?.format(prefs);
    final links = focused == null
        ? const <StatusLineField, StatusLineLink>{}
        : _contextLinks(focused);
    final names = workspaceTabNames(app);
    final terminalTheme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final barStyle = workspaceBarTextStyle();
    final payload = {
      'enabled': _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen,
      'activeId': app.activeSwarmId,
      'palette': grid.AppTheme.palette.value.nativeColors,
      'barStyle': {
        'family': barStyle.fontFamily,
        'fallback': barStyle.fontFamilyFallback,
        'size': workspaceBarFontSize,
        'foreground': terminalTheme.foreground.toARGB32(),
        'selection': terminalTheme.selection.toARGB32(),
      },
      'focusedModel': focused == null || !modelPickerSupports(focused.engine)
          ? null
          : {
              'text': focused.provider,
              'segments': [
                {
                  'text': focused.provider,
                  'foreground': terminalTheme.foreground.toARGB32(),
                },
              ],
              'detail': [
                _canSwitchFocusedModel(focused)
                    ? 'Switch model · Subscription or local models'
                    : null,
                focused.agent?.gridModel == null
                    ? null
                    : focused.agent?.gridWebSearch?.sentence,
              ].whereType<String>().join('\n'),
              'interactive': _canSwitchFocusedModel(focused),
              'paneId': focused.pane.id,
              'agentId': focused.agentId,
            },
      'focusedContext': focused == null
          ? null
          : {
              ..._nativeStatusLine(parts!, terminalTheme),
              'detail': focused.detail,
              'interactive': false,
              'fields': [
                for (final component in parts.components)
                  {
                    ..._nativeStatusLine(
                      component.parts,
                      terminalTheme,
                      segmentOffset: component.offset,
                    ),
                    'field': component.field?.name,
                    'paneId': focused.pane.id,
                    'detail': links[component.field]?.label,
                    'interactive': links[component.field]?.onPressed != null,
                  },
              ],
            },
      'pullRequest': _pullRequest.value == null
          ? null
          : {
              ..._nativeStatusLine(
                pullRequestStatusLineParts(
                  number: _pullRequest.value!.number,
                  state: _pullRequest.value!.state,
                  style: prefs.statusStyle,
                ),
                terminalTheme,
                segmentOffset: parts?.segments.length ?? 0,
              ),
              'url': _pullRequest.value!.url.toString(),
              'detail':
                  'Open pull request #${_pullRequest.value!.number} on GitHub',
              'interactive': true,
            },
      'canReopen': app.canReopenLastClosed,
      'canFind': _canFindTerminal,
      'canClosePane': app.focusedPane != null,
      'paneActions': {
        'restartAgent': _canExecuteCommand('agent.restart'),
        'shareAgent': _canExecuteCommand('agent.share'),
        'toggleViewer': _canExecuteCommand('pane.toggle_viewer'),
        'toggleComposer': _canExecuteCommand('pane.toggle_composer'),
      },
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
      // The badge the NATIVE titlebar draws. It is a wider question than
      // `attention`, which counts only harnesses that are blocked: a harness
      // that FINISHED is also something to go and see. Sent beside the old key
      // rather than replacing it, because the native side still words its
      // accessibility value from "needs input" and an older Runner ignores a
      // key it does not know.
      'unread': _unread,
      'sessionsOpen': _harnessesVisible,
      'machinesOpen': _machinesVisible,
      'machineNotices': _toolbarNotices.machineCount,
      'modelNotices': _toolbarNotices.modelCount,
      'onboarding':
          _onboarding.next != null && _onboarding.showsDot(_onboarding.next!)
          ? _onboarding.next!.name
          : null,
      'modelsOpen': _modelsVisible,
      'localModelReady': app.modelManager.readyModel != null,
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
            'label': '${app.swarms.indexOf(swarm) + 1}:${names[swarm.id]}',
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
    unawaited(_menuBus.send('update', payload));
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
      _menuBus.send('machinesState', {
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
                    // conversation, the road ⌘P takes (`activateSwarmDestination`).
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
    if (call.method == 'focusedModel') {
      if (args['paneId'] is int) {
        final expectedPane = args['paneId'];
        final expectedAgent = args['agentId'];
        await WidgetsBinding.instance.endOfFrame;
        final focused = WorkspacePaneContext.focused(app);
        if (focused != null &&
            focused.pane.id == expectedPane &&
            focused.agentId == expectedAgent &&
            _canSwitchFocusedModel(focused)) {
          _focusedModelController.open();
        }
      }
      return;
    }
    if (call.method == 'focusedContext') {
      final field = StatusLineField.values
          .where((field) => field.name == args['field'])
          .firstOrNull;
      if (field != null && args['paneId'] is int) {
        _openContextResource(field, args['paneId'] as int);
      }
      return;
    }
    if (call.method == 'harnessControls') {
      _toggleHarnessControls();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'machineControls') {
      unawaited(_showMachinesControls());
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'modelControls') {
      _toggleModelsControls();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'linkMachine') {
      unawaited(_showMachinesControls());
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'machineList') {
      unawaited(_openMachines());
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'models') {
      _togglePaneModels();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    final nativeCommand = switch (call.method) {
      'keymapCommand' =>
        args['command'] is String ? args['command'] as String : null,
      'commands' => 'navigation.commands',
      'sessions' => 'harnesses.list',
      'newAgent' => 'agent.new',
      'newTerminal' => 'terminal.new',
      'cloneAgent' => 'agent.clone',
      'restartAgent' => 'agent.restart',
      'shareAgent' => 'agent.share',
      'toggleViewer' => 'pane.toggle_viewer',
      'toggleComposer' => 'pane.toggle_composer',
      _ => null,
    };
    if (nativeCommand != null || call.method == 'searchCommand') {
      final focus = FocusManager.instance.primaryFocus?.context;
      final region = focus == null ? null : KeymapRegion.of(focus);
      // Native menu actions must leave an input-method candidate intact even
      // when the focused picker delegates that command to the workspace.
      if (region?.composing?.call() == true) return;
      final action = region?.actions?[nativeCommand];
      if (action != null) {
        // Match keyboard dispatch: the focused picker owns its commands and
        // closes its own results before opening creation. Bypassing it stacks
        // another search or leaves the start-page dropdown under the dialog.
        action();
        if (call.method != 'keymapCommand') {
          await WidgetsBinding.instance.endOfFrame;
          if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
        }
        return;
      }
    }
    if (call.method == 'sessions') {
      _runShortcut('harnesses.list');
      await WidgetsBinding.instance.endOfFrame;
      if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
      return;
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
      case 'focusedPullRequest':
        await _openFocusedPullRequest(args['url'] as String?);
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
      case 'restartAgent':
        unawaited(_restartAgent());
      case 'shareAgent':
        if (_canExecuteCommand('agent.share')) unawaited(_shareAgent());
      case 'toggleViewer':
        if (_canExecuteCommand('pane.toggle_viewer')) _toggleFocusedViewer();
      case 'toggleComposer':
        if (_canExecuteCommand('pane.toggle_composer')) {
          app.toggleComposer(app.focusedPaneId!);
        }
      case 'runLocalModel':
        _toggleModels(initialTab: ModelsTab.local);
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
      case 'manageMachines':
        await _manageMachines();
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
        if (app.focusedPane case final pane?) unawaited(app.closePane(pane.id));
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
          'restartAgent',
          'shareAgent',
          'toggleViewer',
          'toggleComposer',
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
    if (_menuHost) _syncNative();
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
        if (_menuHost) _syncNative();
      }
    }
    if (restoreEntry) await _ensureEmptyEntry();
  }

  Future<void> _rename(String id) => _dialog(() async {
    final swarm = app.swarms.where((s) => s.id == id).firstOrNull;
    if (swarm == null) return;
    final name = await showSwarmRenameDialog(
      context,
      workspaceTabNames(app)[id] ?? swarm.name,
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

  /// ⌘⇧E — the focused pane's harness starts again where it is. Same routing
  /// as [_cloneAgent]: gated everywhere but the native menu's fallback path,
  /// which answers rather than doing nothing.
  Future<void> _restartAgent() => _dialog(() async {
    final pane = app.focusedPane;
    if (pane == null || _focusedAgent == null) {
      _showPaneActionHint('Focus a harness pane to restart it.');
      return;
    }
    if (app.stateOf(pane.machineId)?.machine.isShared != false) {
      _showPaneActionHint('Shared harnesses are view-only.');
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
  Future<void> _shareAgent() => _dialog(() async {
    final focused = WorkspacePaneContext.focused(app);
    final agent = focused?.agent;
    if (focused == null ||
        agent == null ||
        app.stateOf(focused.pane.machineId)?.machine.isShared != false) {
      return;
    }
    await showShareHarnessDialog(
      context,
      app,
      focused.pane.machineId,
      agent.id,
      agent.displayName,
    );
  });

  void _toggleFocusedViewer() {
    final focused = WorkspacePaneContext.focused(app);
    if (focused?.agentId case final id?) {
      unawaited(app.toggleViewerPane(focused!.pane.machineId, id));
    }
  }

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

  Future<void> _showMachinesControls({String? initialMachineId}) async {
    if (_machinesPanel case final panel?) {
      panel.close();
      return;
    }
    if (!_shortcutsEnabled || _newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    _onboarding.acknowledge(OnboardingStep.machines);
    final panel = openMachinesPanel(
      context,
      app,
      keymap: _keymap,
      initialMachineId: initialMachineId,
      onboarding: _onboarding,
      toolbarHeight: _native ? 0 : _tabBarHeight,
    );
    _machinesPanel = panel;
    _syncToolbarNotices();
    if (_menuHost) _syncNative();
    setState(() {});
    final destination = await panel.closed;
    if (!mounted || !identical(_machinesPanel, panel)) return;
    _machinesPanel = null;
    _syncToolbarNotices();
    if (_menuHost) _syncNative();
    setState(() {});
    // Let the removed panel release its focus before opening work.
    await WidgetsBinding.instance.endOfFrame;
    if (!mounted) return;
    final machine = destination == null ? null : app.stateOf(destination);
    if (machine != null) {
      if (machine.agents.isEmpty && !machine.machine.isShared) {
        await _newAgent(
          machineId: destination,
          placement: HarnessPlacement.currentTab,
        );
      } else {
        _openSearch(
          adding: true,
          query: '@',
          placement: HarnessPlacement.currentTab,
        );
        final machineRow = _search?.rows
            .where((row) => row.isMachine && row.machineId == destination)
            .firstOrNull;
        if (machineRow != null) _search!.submit(machineRow);
      }
    } else if (panel.restoreFocus && _shortcutsEnabled) {
      _shellFocus.requestFocus();
      final pane = app.focusedPane;
      if (pane != null) app.focusPane(pane.id, reveal: true);
      await _ensureEmptyEntry();
    }
  }

  Future<void> _openMachines({String? initialMachineId}) async {
    _onboarding.acknowledge(OnboardingStep.machines);
    _openResourcePicker('@');
    if (initialMachineId != null && _search?.isMachineMode == true) {
      final index = _search!.rows.indexWhere(
        (row) => row.machineId == initialMachineId,
      );
      if (index >= 0) _search!.move(index - _search!.cursor);
    }
  }

  void _openResourcePicker(String prefix) {
    dismissTransientMenus();
    if (_search?.scopePrefix == prefix) {
      _dismissSearch();
      return;
    }
    if (_search != null) {
      _search!.setQuery(prefix);
      _focusSearch();
    } else {
      _openSearch(adding: true, query: prefix);
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
    // A fresh launcher uses saved choices on this computer. Only an explicit
    // split inherits its source pane; changing focus never changes Cmd-N's
    // defaults.
    final focused =
        source == _NewHarnessSource.workspace && requestedSplit != null
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
        (newHarnessOpensInBox ? null : app.machineStates.keys.firstOrNull);
    final paneProject =
        projectName != null || agent == null || id != focused?.machineId
        ? null
        : machine?.projectOf(agent);
    if (id == null) {
      await _showMachinesControls();
      return;
    }
    await Future.wait([app.agentPreference.load(), app.projectHistory.load()]);
    if (!mounted || app.activeSwarmId != target) return;
    final initialFolder =
        folder ??
        paneProject?.cwd ??
        (newHarnessOpensInBox && source == _NewHarnessSource.workspace
            ? app.projectHistory.selected(id) ??
                  app.projectHistory.recent(id).firstOrNull
            : null);
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
    final inherited = agent?.engine;
    _openNewHarness(
      machineId: id,
      // ⌘⇧T is how a shell is made; New Harness from a shell means an agent.
      engine: engine ?? (isTerminalEngine(inherited) ? null : inherited),
      harnessId: engine == null ? agent?.dsh : null,
      folder: initialFolder,
      projectName: projectName,
      autoProject:
          projectName == null &&
          initialFolder == null &&
          source == _NewHarnessSource.product,
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
    String? harnessId,
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
        ((isHarnessId(origin.requestedEngine)
                ? candidate.harnessId == origin.requestedEngine
                : candidate.engine == origin.requestedEngine &&
                      candidate.harnessId == null) &&
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
                    (origin.source != _NewHarnessSource.workspace &&
                        task == null &&
                        matchesSelection(savedDraft)))
            ? savedDraft
            : null);
    if (resumed != null) _newHarnessDrafts.remove(origin);
    final box = _newHarness = NewHarnessController(
      app,
      machineId: machineId,
      engine: engine,
      harnessId: harnessId,
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
    final content = NewHarnessForm(
      controller: box,
      onCreated: () {
        _closeNewHarness(restoreFocus: false, keepDraft: false);
        unawaited(_focusCreatedPane());
      },
      onClose: () {
        final target = box.swarmId ?? app.activeSwarmId;
        _closeNewHarness();
        app.cancelSwarmDraft(target);
      },
      onBrowse: () => _browseForNewHarness(box),
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
      // Hidden, not removed, while a dialog ROUTE is up — see
      // [_withNewHarnessHidden]. The form keeps its State and its draft.
      builder: (context) => Offstage(
        offstage: _newHarnessHidden,
        child: KeymapProvider(
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
                          // Keep the workspace quiet behind the focused pane.
                          child: ColoredBox(
                            color: Colors.black.withValues(alpha: .94),
                          ),
                        ),
                      ),
                    ),
                    Positioned.fill(
                      top: _native ? 0 : _tabBarHeight,
                      child: Padding(
                        padding: EdgeInsets.symmetric(
                          horizontal: terminalCellSizeOf(context).width * 2,
                          vertical: terminalCellSizeOf(context).height,
                        ),
                        child: content,
                      ),
                    ),
                  ],
                );
              },
            ),
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

  /// Runs [show] — a dialog ROUTE — with the new-harness box out of the way.
  ///
  /// The box is an [OverlayEntry] this screen inserts itself, so it sits above
  /// every route pushed AFTERWARDS: the navigator inserts a new route directly
  /// above the previous ROUTE's entries, which is still below ours. The remote
  /// folder browser is such a route, and it opened underneath the box — nothing
  /// appeared until the box was dismissed, and then the chooser was sitting
  /// there. The chooser on this computer is an AppKit sheet in its own window
  /// and needs none of this.
  ///
  /// Hidden rather than removed: re-inserting the entry would build a second
  /// [NewHarnessForm] and lose the row, the query and the focus the person left
  /// behind.
  Future<T?> _withNewHarnessHidden<T>(Future<T?> Function() show) async {
    final entry = _newHarnessOverlay;
    if (entry == null) return show();
    _newHarnessHidden = true;
    entry.markNeedsBuild();
    try {
      return await show();
    } finally {
      _newHarnessHidden = false;
      // The box may have been closed under the dialog; the flag is reset
      // either way so the next one does not open invisible.
      _newHarnessOverlay?.markNeedsBuild();
    }
  }

  /// The Browse… row: the system's folder chooser on this computer, the
  /// folder browser on another. The box stays open behind it and takes the
  /// answer when it comes back.
  Future<void> _browseForNewHarness(NewHarnessController box) async {
    if (_pickingFolder) return;
    final previousFocus = FocusManager.instance.primaryFocus;
    final machineId = box.machineId;
    final machine = app.stateOf(machineId);
    _pickingFolder = true;
    final String? path;
    try {
      path = machine?.isLocalMachine == true
          ? await whileNativePicker(
              () => getDirectoryPath(initialDirectory: box.project.folder),
            )
          : await _withNewHarnessHidden(
              () => showRemoteFolderPicker(
                context,
                notifier: app,
                machineId: machineId,
                initialPath: box.project.folder,
                terminal: true,
              ),
            );
    } finally {
      _pickingFolder = false;
    }
    if (mounted && identical(_newHarness, box) && box.machineId == machineId) {
      if (path != null) box.setFolder(path);
      if (previousFocus?.context?.mounted == true &&
          previousFocus!.canRequestFocus) {
        previousFocus.requestFocus();
      }
    }
  }

  Future<void> _linkProfileForNewHarness(NewHarnessController box) async {
    if (box.locked || !box.supportsProfiles || _pickingFolder) return;
    final previousFocus = FocusManager.instance.primaryFocus;
    final machineId = box.machineId;
    final engine = box.engine;
    final initialPath = box.draft.profile?.path;
    final machine = app.stateOf(machineId);
    _pickingFolder = true;
    final String? path;
    try {
      path = machine?.isLocalMachine == true
          ? await whileNativePicker(
              () => getDirectoryPath(
                initialDirectory: initialPath,
                confirmButtonText: 'Link profile',
              ),
            )
          : await _withNewHarnessHidden(
              () => showRemoteFolderPicker(
                context,
                notifier: app,
                machineId: machineId,
                initialPath: initialPath,
              ),
            );
    } finally {
      _pickingFolder = false;
    }
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
      if (previous != null &&
          previous is! FocusScopeNode &&
          previous.context?.mounted == true &&
          previous.canRequestFocus) {
        previous.requestFocus();
      } else if (app.focusedPane?.session?.focusInput() != true) {
        _shellFocus.requestFocus();
      }
    }
    unawaited(_ensureEmptyEntry());
  }

  /// ⌘⇧N — another agent of the focused pane's kind, fresh conversation.
  /// No dialog, like ⌘⇧T: the answer to every question a dialog would ask is
  /// already on the source agent's frame (`AppNotifier.cloneAgent`). Reached
  /// with nothing focused only by the native menu's fallback path (no keymap
  /// region owns the focus); `_runShortcut` gates every other route.
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
    if (error != null) _showPaneActionHint(error);
  }

  /// Why a pane action did nothing, for the one route that is not gated by
  /// `_canExecuteCommand`: a native menu item clicked while no keymap region
  /// owns the focus reaches its handler directly.
  void _showPaneActionHint(String message) {
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(message)));
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
      await _showMachinesControls();
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

  Future<void> _splitAgent(PaneResizeAxis axis) async {
    final split = app.preparePaneSplit(axis);
    if (split == null) return;
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

  void _modelManagerChanged() {
    _syncToolbarNotices();
    if (_menuHost && mounted) _syncNative();
  }

  Future<void> _openModelManager() async {
    final openingPanel = _modelsOverlay;
    if (openingPanel == null) dismissTransientMenus();
    await app.modelManager.open();
    if (app.modelManager.error == null &&
        identical(_modelsOverlay, openingPanel)) {
      _closeModelsControls(restoreFocus: false);
    }
    if (app.modelManager.error case final error? when mounted) {
      if (_modelsOverlay == null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error)));
      }
    }
  }

  void _toggleModelsControls({ModelsTab initialTab = ModelsTab.all}) {
    if (_modelsOverlay != null) {
      _closeModelsControls();
      return;
    }
    if (!_shortcutsEnabled || _newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    _onboarding.acknowledge(OnboardingStep.models);
    app.modelManager.setPanelVisible(true);
    unawaited(app.modelManager.dismissIntroduction());
    unawaited(app.modelManager.refresh());
    unawaited(_modelsMenu!.refresh());
    _modelsOverlay = OverlayEntry(
      builder: (context) => LayoutBuilder(
        builder: (context, constraints) => Stack(
          children: [
            Positioned.fill(
              top: _native ? 0 : _tabBarHeight,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _closeModelsControls,
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
                          .clamp(0, 820),
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
                  ),
                  child: KeymapProvider(
                    keymap: _keymap,
                    child: ModelsPanel(
                      newModelIds: _toolbarNotices.newModelIds,
                      showOnboarding: _onboarding.next == OnboardingStep.models,
                      onDismissOnboarding: () =>
                          _onboarding.dismiss(OnboardingStep.models),
                      controller: app.modelManager,
                      subscriptions: _modelsMenu!,
                      initialTab: initialTab,
                      onClose: _closeModelsControls,
                      onManage: () => unawaited(_openModelManager()),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    Overlay.of(context).insert(_modelsOverlay!);
    _syncToolbarNotices();
    _unregisterModels = registerTransientMenu(
      () => _closeModelsControls(restoreFocus: false),
    );
    if (_menuHost) _syncNative();
    setState(() {});
  }

  void _closeModelsControls({bool restoreFocus = true}) {
    if (_modelsOverlay == null) return;
    _unregisterModels?.call();
    _unregisterModels = null;
    _modelsOverlay?.remove();
    _modelsOverlay?.dispose();
    _modelsOverlay = null;
    _syncToolbarNotices();
    app.modelManager.setPanelVisible(false);
    if (!mounted) return;
    if (_menuHost) _syncNative();
    setState(() {});
    if (restoreFocus) {
      _shellFocus.requestFocus();
      final pane = app.focusedPane;
      if (pane != null) app.focusPane(pane.id, reveal: true);
    }
  }

  void _toggleModels({ModelsTab initialTab = ModelsTab.all}) {
    _modelSelectionTarget = null;
    _search?.setModelSelection(null, null);
    _onboarding.acknowledge(OnboardingStep.models);
    _openResourcePicker(':');
    if (_search?.isModelMode == true && initialTab != ModelsTab.all) {
      _search!.setQuery(
        ':${switch (initialTab) {
          ModelsTab.local => 'local',
          ModelsTab.shared => 'shared',
          ModelsTab.apis => 'api',
          ModelsTab.subscriptions => 'subscription',
          ModelsTab.all => '',
        }}',
      );
    }
  }

  void _togglePaneModels() => _toggleModels();

  void _bindModelSelection() {
    final focused = WorkspacePaneContext.focused(app);
    if (focused == null ||
        !_canSwitchFocusedModel(focused) ||
        _modelSelectionTarget != null) {
      return;
    }
    final search = _search;
    if (search == null) return;
    _modelSelectionTarget = focused;
    search.setModelSelection(
      focused.engine,
      app.gridPictures[focused.pane.machineId],
      machineId: focused.pane.machineId,
    );
    void selectCurrent() {
      if (search.query != ':' || search.managing) return;
      final current = focused.agent?.gridModel;
      final index = search.rows.indexWhere((row) {
        final entry = search.models?.entries[row.modelId];
        return current != null
            ? entry?.gridModel?.id.toLowerCase() == current.toLowerCase()
            : entry?.subscription?['engine'] == focused.engine &&
                  search.canSelectModel(row);
      });
      if (index >= 0) search.move(index - search.cursor);
    }

    selectCurrent();
    final initialSelection = search.selected?.id;
    unawaited(
      app.readGridPicture(focused.pane.machineId).then((choices) {
        if (!mounted ||
            !identical(_search, search) ||
            !identical(_modelSelectionTarget, focused)) {
          return;
        }
        search.setModelSelection(
          focused.engine,
          choices,
          machineId: focused.pane.machineId,
        );
        if (search.selected?.id == initialSelection) selectCurrent();
      }),
    );
  }

  void _toggleHarnessControls() {
    if (_harnessesOverlay != null) {
      _closeHarnessControls();
      return;
    }
    if (!_shortcutsEnabled || _newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    _onboarding.acknowledge(OnboardingStep.harnesses);
    final overlay = Overlay.of(context);
    _harnessesOverlay = OverlayEntry(
      builder: (context) => LayoutBuilder(
        builder: (context, constraints) => Stack(
          children: [
            Positioned.fill(
              top: _native ? 0 : _tabBarHeight,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: _closeHarnessControls,
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
                    child: KeymapProvider(
                      keymap: _keymap,
                      child: HarnessSessionManager(
                        app: app,
                        introduction:
                            _onboarding.next == OnboardingStep.harnesses
                            ? OnboardingCard(
                                title: 'Run your first harness',
                                description: 'Give an agent a task. Watch it get to work.',
                                action: 'New harness',
                                onAction: () {
                                  _closeHarnessControls(restoreFocus: false);
                                  _runShortcut('agent.new');
                                },
                                onDismiss: () => _onboarding.dismiss(
                                  OnboardingStep.harnesses,
                                ),
                              )
                            : null,
                        recent: _navigation.recent,
                        onClose: _closeHarnessControls,
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
            ),
          ],
        ),
      ),
    );
    overlay.insert(_harnessesOverlay!);
    _unregisterHarnesses = registerTransientMenu(
      () => _closeHarnessControls(restoreFocus: false),
    );
    if (_menuHost) _syncNative();
    setState(() {});
  }

  void _closeHarnessControls({bool restoreFocus = true}) {
    if (_harnessesOverlay == null) return;
    _unregisterHarnesses?.call();
    _unregisterHarnesses = null;
    _harnessesOverlay?.remove();
    _harnessesOverlay?.dispose();
    _harnessesOverlay = null;
    if (!mounted) return;
    if (_menuHost) _syncNative();
    setState(() {});
    if (restoreFocus) {
      _shellFocus.requestFocus();
      final pane = app.focusedPane;
      if (pane != null) app.focusPane(pane.id, reveal: true);
    }
  }

  void _toggleSessions({SessionFilter? filter}) {
    _onboarding.acknowledge(OnboardingStep.harnesses);
    if (_search?.scopePrefix.isEmpty == true &&
        _search?.canGoBack == false &&
        _search?.activityFirst == true) {
      if (filter != null) _search!.setQuery('');
      _focusSearch();
    } else {
      _closeSearch(restoreFocus: false);
      _openSearch(adding: true, query: '');
    }
    if (_search != null && filter != null) _search!.setSessionFilter(filter);
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
    dismissTransientMenus();
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
    _searchInputKey = GlobalKey();
    _search = SwarmSearchController(
      app,
      _navigation.recent,
      projects: _projects,
      commands: _searchCommands,
      recentCommands: () => _navigation.recentCommands,
      modes: _searchModes,
      models: _pickerModels ??= ModelSearchCatalog(
        app.modelManager,
        _modelsMenu!,
      ),
      adding: adding,
      offersCreate: adding,
      offersHarnessCreate: split != null,
      activityFirst: split == null,
      selectOnEmptyQuery: split != null,
      // Results read downward from the input.
      resultsFromBottom: false,
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
    if (_search == null || _pickerModalDepth > 0) return;
    _searchFocus.requestFocus();
    if (selectAll) {
      _searchText.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _searchText.text.length,
      );
    }
  }

  void _pickerModalChanged(bool opening) {
    _pickerModalDepth += opening ? 1 : -1;
    _searchOverlay?.markNeedsBuild();
  }

  void _showSearchCommands() {
    if (_search?.setupLayout == true &&
        _search?.selected?.isCreate == false &&
        _previewControls.commands?.call().isNotEmpty == true) {
      if (_pickerModalDepth == 0) unawaited(_showResourceCommands());
      return;
    }
    if (_search == null) _openSearch(adding: true, query: '>');
    _search?.setQuery('>');
    _focusSearch();
    if (_search != null) _learning.commandSearchOpened();
  }

  Future<void> _showResourceCommands() async {
    final origin = _search!;
    final target = origin.selected?.id;
    List<SwarmDestination> commands() =>
        identical(_search, origin) && origin.selected?.id == target
        ? _previewControls.commands?.call() ?? const []
        : const [];
    final actions = SwarmSearchController(
      app,
      const [],
      commandsOnly: true,
      commands: commands,
    );
    origin.addListener(actions.refreshCommands);
    _pickerModalChanged(true);
    SwarmSearchSelection? choice;
    try {
      choice = await showAppDialog<SwarmSearchSelection>(
        context: context,
        transitionDuration: Duration.zero,
        veilBlur: 0,
        builder: (_) => KeymapProvider(
          keymap: _keymap,
          child: SwarmCommandPicker(search: actions),
        ),
      );
    } finally {
      origin.removeListener(actions.refreshCommands);
      actions.dispose();
      _pickerModalChanged(false);
    }
    if (!mounted || !identical(_search, origin)) return;
    _focusSearch();
    if (choice == null) return;
    // The target and verb must still be the ones the user chose. A lifecycle
    // update must never turn a selected Pause command into Resume, or operate
    // on a different result after inventory changes.
    final destination = choice.destination;
    if (commands().any(
      (command) =>
          command.id == destination.id && command.title == destination.title,
    )) {
      _previewControls.invoke(destination.commandId!);
    }
  }

  void _syncSearch() {
    final search = _search;
    if (search == null) return;
    if (_machineSearchVisible != search.isMachineMode) {
      _machineSearchVisible = search.isMachineMode;
      if (_machineSearchVisible) unawaited(search.refreshMachineResources());
    }
    if (_storeSearchVisible != search.isStoreMode) {
      _storeSearchVisible = search.isStoreMode;
      if (_storeSearchVisible && !kUnderTest) {
        for (final machine in app.machineStates.values) {
          if (machine.connectionStatus == ConnectionStatus.connected &&
              machine.nodeOnline != false &&
              !machine.needsLink) {
            unawaited(app.probeDsh(machine.machine.machineId));
          }
        }
      }
    }
    if (_modelSearchVisible != search.isModelMode) {
      _modelSearchVisible = search.isModelMode;
      app.modelManager.setPanelVisible(_modelSearchVisible);
      _pickerModels?.setVisible(_modelSearchVisible);
      if (_modelSearchVisible) _bindModelSelection();
      if (_modelSearchVisible && !kUnderTest) {
        unawaited(app.modelManager.refresh());
        unawaited(app.modelManager.apis.refresh());
      }
      if (_modelSearchVisible && (!kUnderTest || widget.modelsMenu != null)) {
        unawaited(_modelsMenu!.refresh());
      }
    }
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
      _syncToolbarNotices();
      if (_menuHost) _syncNative();
    }
  }

  void _closeSearch({bool restoreFocus = true}) {
    if (_search == null) return;
    _machineSearchVisible = false;
    _storeSearchVisible = false;
    // Enable the chosen terminal synchronously, before activation requests its
    // focus and before the following frame rebuilds the canvas.
    _canvasFocus.descendantsAreFocusable = true;
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _searchOverlay = null;
    _search!.removeListener(_syncSearch);
    _search!.dispose();
    _search = null;
    _modelSelectionTarget = null;
    _modelSearchVisible = false;
    app.modelManager.setPanelVisible(false);
    _pickerModels?.setVisible(false);
    _searchHeaderState = null;
    _searchText.clear();
    _syncToolbarNotices();
    if (_menuHost && mounted) _syncNative();
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
    final answering = _search?.sessionFilter == SessionFilter.needsInput;
    if (target == null) return;
    if (choice.destination.isModel &&
        _search!.canGetModel(choice.destination)) {
      await _search!.getModel(choice.destination);
      return;
    }
    if (choice.destination.isModel &&
        _search!.canSelectModel(choice.destination)) {
      final search = _search!;
      if (search.usingModelId != null) return;
      final chosenFor = _modelSelectionTarget;
      bool current() {
        final now = WorkspacePaneContext.focused(app);
        return mounted &&
            identical(_search, search) &&
            search.isModelMode &&
            chosenFor != null &&
            now != null &&
            now.pane.id == chosenFor.pane.id &&
            now.agentId == chosenFor.agentId &&
            now.pane.machineId == chosenFor.pane.machineId &&
            _canSwitchFocusedModel(now);
      }

      if (!current()) return;
      var selected = search.selectableGridModel(choice.destination);
      if (selected == null && search.canStartModelForUse(choice.destination)) {
        selected = await search.startModelForUse(
          choice.destination,
          stillCurrent: current,
        );
        if (!mounted || !current() || selected == null) return;
      }
      if (selected?.unavailable case final offline?) {
        _pickerModalChanged(true);
        bool proceed;
        try {
          proceed = await confirmSwitchAnyway(
            context,
            model: selected!.id,
            offline: offline,
          );
        } finally {
          _pickerModalChanged(false);
        }
        if (!proceed || !mounted || !current() || _search == null) return;
      }
      final now = WorkspacePaneContext.focused(app)!;
      _closeSearch();
      if (selected == null) {
        if (now.agent?.gridModel != null) {
          await app.clearAgentGrid(now.pane.machineId, now.agentId!);
        }
      } else if (selected.id != now.agent?.gridModel) {
        await app.retargetAgentToGridModel(
          now.pane.machineId,
          now.agentId!,
          selected.id,
          gridName: selected.grid,
        );
      }
      return;
    }
    if (choice.destination.isModel) return;
    if (_search!.setupLayout && choice.destination.isMachine) {
      final index = _search!.rows.indexWhere(
        (row) => row.id == choice.destination.id,
      );
      if (index >= 0) _search!.move(index - _search!.cursor);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _search?.selected?.id == choice.destination.id) {
          _previewControls.invoke('picker.focus_actions');
        }
      });
      return;
    }
    if (choice.destination.storeId case final storeId?) {
      _closeSearch(restoreFocus: false);
      app.openStore(harness: storeId);
      return;
    }
    if (choice.destination.isCreate) {
      if (_search!.isMachineMode) {
        _previewControls.invoke('picker.focus_actions');
        return;
      }
      if (_search!.isModelMode) {
        _previewControls.invoke('picker.resource_add_api');
        return;
      }
      // What was typed and found nothing is what the new harness starts on.
      final task = choice.destination.task;
      final machineId = _search!.scopedMachineId;
      _closeSearch(restoreFocus: false);
      await _newAgent(
        machineId: machineId,
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
      answering
          ? SwarmSearchSelection(choice.destination, SwarmSearchAction.open)
          : choice,
      target,
      split: split,
      placement: answering
          ? null
          : placement == HarnessPlacement.newTab &&
                targetTab?.isBlankNewTab == true
          ? HarnessPlacement.currentTab
          : placement,
    );
    if (mounted) {
      if (app.activeSwarmId != target) app.cancelSwarmDraft(target);
      await _ensureEmptyEntry();
    }
  }

  void _chooseStartSearch(SwarmSearchSelection choice) {
    final row = choice.destination;
    if (row.isCreate && row.id != kSwarmCreateRowId) {
      final prefix = row.id.substring('create:'.length);
      _openSearch(adding: true, query: prefix);
      final selection = _search?.submit();
      if (selection != null) unawaited(_chooseSearch(selection));
    } else if (row.isCreate) {
      unawaited(
        _newAgent(task: row.task, placement: HarnessPlacement.currentTab),
      );
    } else {
      unawaited(
        _activateSearch(
          choice,
          app.activeSwarmId,
          placement: HarnessPlacement.currentTab,
        ),
      );
    }
  }

  Widget _buildSearchOverlay(BuildContext context) {
    final search = _search!;
    Widget preview() => SwarmResourcePreview(
      key: _resourcePreviewKey,
      search: search,
      controls: _previewControls,
      onChoose: _chooseSearch,
      onRefocus: _focusSearch,
      onModalChanged: _pickerModalChanged,
      onCommands: _showSearchCommands,
    );
    final terminalTheme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    // Search keeps keyboard focus while commands target the selected result.
    Widget ordered(double order, Widget child) =>
        FocusTraversalOrder(order: NumericFocusOrder(order), child: child);
    final panel = Material(
      key: const ValueKey('swarm-search-results'),
      elevation: 0,
      color: terminalTheme.background,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(kTerminalCornerRadius),
        side: terminalPaneBorder(focused: true),
      ),
      clipBehavior: Clip.antiAlias,
      child: DefaultTextStyle.merge(
        style: terminalContentStyle(color: terminalTheme.foreground),
        child: FocusTraversalGroup(
          policy: OrderedTraversalPolicy(),
          // Fills its frame, as fzf does: the list takes every row the box
          // has rather than hugging its contents and leaving the rest dark.
          child: search.setupLayout
              ? SwarmSearchResults(
                  search: search,
                  onChoose: _chooseSearch,
                  onRefocus: _focusSearch,
                  terminal: true,
                  bios: true,
                  previewBuilder: preview,
                  header: Semantics(
                    label: search.hint,
                    child: ReadlineKeys(
                      controller: _searchText,
                      onChanged: search.setQuery,
                      child: SwarmSearchInput(
                        key: _searchInputKey,
                        inputKey: const ValueKey('swarm-search-input'),
                        controller: _searchText,
                        focusNode: _searchFocus,
                        search: search,
                        onClose: _dismissSearch,
                        onChanged: search.setQuery,
                        onOpen: _focusSearch,
                        terminal: true,
                        bios: true,
                        cursorWidth: 2,
                        hintText: search.hint,
                      ),
                    ),
                  ),
                )
              : Column(
                  children: [
                    if (search.title != search.placement?.title)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(14, 9, 14, 2),
                        child: Row(
                          children: [
                            Text(search.title, style: _boxCaption),
                            if (search.placement ==
                                    HarnessPlacement.currentTab ||
                                search.split != null)
                              Expanded(
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 8,
                                  ),
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
                    ordered(
                      1,
                      Semantics(
                        label: search.hint,
                        child: ReadlineKeys(
                          controller: _searchText,
                          onChanged: search.setQuery,
                          child: SwarmSearchInput(
                            key: _searchInputKey,
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
                    Expanded(
                      child: ordered(
                        2,
                        SwarmSearchResults(
                          search: search,
                          onChoose: _chooseSearch,
                          onRefocus: _focusSearch,
                          fitRows: true,
                          terminal: true,
                          previewBuilder: preview,
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
      ),
    );
    final scoped = Semantics(
      scopesRoute: true,
      namesRoute: true,
      explicitChildNodes: true,
      label: search.title,
      child: TextSelectionTheme(
        data: TextSelectionThemeData(
          cursorColor: terminalTheme.cursor,
          selectionColor: terminalTheme.selection,
          selectionHandleColor: terminalTheme.cursor,
        ),
        child: panel,
      ),
    );
    return Offstage(
      offstage: _pickerModalDepth > 0,
      child: KeymapProvider(
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
              onCommands: _showSearchCommands,
              previewControls: _previewControls,
              onRefocus: _focusSearch,
              child: scoped,
            );
            return Stack(
              children: [
                // Hiding a preview must not change which commands are available.
                Positioned.fill(
                  child: ListenableBuilder(
                    listenable: search,
                    builder: (context, _) => search.hasPreview
                        ? const SizedBox.shrink()
                        : Offstage(child: preview()),
                  ),
                ),
                // A click outside closes it. Block the dimmed workspace from
                // VoiceOver while the dialog owns the keyboard.
                Positioned.fill(
                  child: BlockSemantics(
                    child: GestureDetector(
                      key: const ValueKey('swarm-search-dismiss'),
                      behavior: HitTestBehavior.opaque,
                      onTap: _dismissSearch,
                      child: ColoredBox(
                        color: Colors.black.withValues(alpha: .94),
                      ),
                    ),
                  ),
                ),
                Positioned.fill(
                  top: _native ? 0.0 : _tabBarHeight,
                  child: Align(
                    alignment: const Alignment(0, -0.12),
                    // Big, like fzf, and FIXED: it does not grow with the
                    // results, shrink with the query, or scale with the font.
                    // Only a window too small to hold it clamps it, because
                    // the alternative is drawing off the screen.
                    child: SizedBox(
                      width: math.min(1480, constraints.maxWidth - 48),
                      height: math.min(760, constraints.maxHeight - 88),
                      child: contents,
                    ),
                  ),
                ),
              ],
            );
          },
        ),
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

  Future<void> _addAgent({String query = '#'}) async {
    if ((app.activeSwarm.isStore || app.activeSwarm.isOrchestrator) &&
        !_newTab()) {
      return;
    }
    if (_search?.changePlacement(HarnessPlacement.currentTab) == true) {
      _focusSearch();
      return;
    }
    _closeSearch(restoreFocus: false);
    _openSearch(
      adding: true,
      placement: HarnessPlacement.currentTab,
      query: query,
    );
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
    // A native chooser is modal to this window, so the palette would open
    // behind it and take neither a key nor a click. Reporting the task back as
    // cancelled is the honest answer — the dial drops its sending overlay
    // instead of leaving the words in a box nobody can reach.
    if (_spokenPaletteOpen || _dialogOpen || nativePickerOpen || !mounted) {
      spoken.cancelled();
      return;
    }
    _closeSearch();
    _spokenPaletteOpen = true;
    _closeCommandBar(restoreFocus: false);
    if (_menuHost) _syncNative();
    try {
      await revealWindow();
      if (!mounted) {
        spoken.cancelled();
        return;
      }
      await showTaskPalette(context, app, spoken: spoken);
    } finally {
      _spokenPaletteOpen = false;
      if (_menuHost && mounted) _syncNative();
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
        _machinesVisible ||
        _search != null ||
        app.isLinkPromptDismissed(machine.machine.machineId) ||
        _linkDialogMachineId != null) {
      return;
    }
    _linkDialogMachineId = machine.machine.machineId;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (mounted) {
        await _showMachinesControls(
          initialMachineId: machine.machine.machineId,
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
        unawaited(app.closePane(pane.id));
      }
    },
    ShortcutAction.newAgent: _newAgent,
    ShortcutAction.newTerminal: _newTerminal,
    ShortcutAction.cloneAgent: _cloneAgent,
    ShortcutAction.restartAgent: _restartAgent,
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
    'agent.share': _shareAgent,
    'pane.toggle_viewer': _toggleFocusedViewer,
    'pane.toggle_composer': () {
      if (app.focusedPaneId case final id?) app.toggleComposer(id);
    },
    // `agent.restart` and `agent.clone` come from `_actionHandlers` above:
    // both carry a ShortcutAction, so the loop already binds them.
    'machine.link': _showMachinesControls,
    'machines.manage': _manageMachines,
    'machines.list': _openMachines,
    'models.list': _togglePaneModels,
    'harnesses.list': _toggleSessions,
    'harnesses.manage': _toggleHarnessControls,
    'machines.connections': _showMachinesControls,
    'models.manage': _toggleModelsControls,
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
    if (id == 'agent.share' || id == 'pane.toggle_viewer') {
      final focused = WorkspacePaneContext.focused(app);
      final agent = focused?.agent;
      return focused != null &&
          agent != null &&
          app.stateOf(focused.pane.machineId)?.machine.isShared == false &&
          (id == 'agent.share' ||
              agent.viewerUrl != null ||
              agent.viewerError != null);
    }
    if (id == 'pane.toggle_composer') {
      final pane = app.focusedPane;
      final machine = pane == null ? null : app.stateOf(pane.machineId);
      return pane?.session != null &&
          machine != null &&
          !machine.isLocalMachine &&
          !machine.machine.isShared &&
          !isTerminalEngine(pane!.session!.engineId);
    }
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
      SwarmDestination(
        id: 'picker:models',
        title: ':  Models',
        detail: 'Local models, shared models, subscriptions and APIs',
        swarmId: null,
        current: false,
        pickerQuery: ': ',
      ),
      SwarmDestination(
        id: 'picker:store',
        title: '*  Store',
        detail: 'Find a harness in the Store',
        swarmId: null,
        current: false,
        pickerQuery: '* ',
      ),
      ?mode('agent.new', 'New Harness', 'agent · machine · project'),
      ?mode('app.store', 'Harness Store', 'Browse and install harnesses'),
      ?mode(
        'harnesses.list',
        'Harnesses',
        'Manage running and paused harnesses',
      ),
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
  Widget build(BuildContext context) => ListenableBuilder(
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
                    if (!_native)
                      MediaQuery.withNoTextScaling(child: _tabStrip()),
                    if (_native)
                      _focusedModelPicker(
                        WorkspacePaneContext.focused(app),
                        menuOnly: true,
                      ),
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
                                                        onNewPane: () =>
                                                            unawaited(
                                                              _addAgent(
                                                                query: '',
                                                              ),
                                                            ),
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
                                                        onResourceSearch:
                                                            (query) =>
                                                                _openSearch(
                                                                  adding: true,
                                                                  query: query,
                                                                ),
                                                        onChoose:
                                                            _chooseStartSearch,
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
  List<double> _tabWidths = [];

  void _revealSelectedTab(double viewport) {
    final previous = _tabGeometry;
    final order = app.swarms.map((tab) => tab.id).toList(growable: false);
    if (previous != null &&
        previous.activeId == app.activeSwarmId &&
        previous.viewport == viewport &&
        listEquals(previous.order, order) &&
        listEquals(previous.widths, _tabWidths)) {
      return;
    }
    _tabGeometry = (
      activeId: app.activeSwarmId,
      order: order,
      viewport: viewport,
      widths: List.of(_tabWidths),
    );
    final oldIndex = previous?.order.indexOf(previous.activeId) ?? -1;
    final wasVisible =
        _tabScroll.hasClients &&
        oldIndex >= 0 &&
        previous!.widths.take(oldIndex + 1).fold(0.0, (a, b) => a + b) >
            _tabScroll.offset &&
        previous.widths.take(oldIndex).fold(0.0, (a, b) => a + b) <
            _tabScroll.offset + previous.viewport;
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
      final left = _tabWidths.take(index).fold(0.0, (a, b) => a + b);
      final extent = _tabWidths[index];
      final right = left + extent;
      final offset =
          left < position.pixels || extent > position.viewportDimension
          ? left
          : right > position.pixels + position.viewportDimension
          ? right - position.viewportDimension
          : position.pixels;
      final target = offset.clamp(0.0, position.maxScrollExtent);
      if (target != position.pixels) _tabScroll.jumpTo(target);
    });
  }

  bool _canSwitchFocusedModel(WorkspacePaneContext focused) {
    if (!_shortcutsEnabled || !modelPickerSupports(focused.engine)) {
      return false;
    }
    final machine = app.stateOf(focused.pane.machineId);
    final agent = focused.agent;
    final owner = focused.pane.isWeb
        ? app.panes
              .where(
                (pane) =>
                    pane.machineId == focused.pane.machineId &&
                    pane.agentId == focused.agentId &&
                    !pane.isWeb,
              )
              .firstOrNull
        : focused.pane;
    return machine != null &&
        agent != null &&
        agent.terminalAvailable &&
        agent.launchState != 'failed' &&
        machine.nodeOnline != false &&
        !(machine.isLocalMachine && !machine.usesLocalTransport) &&
        !(machine.isRemote && !machine.isLocalMachine && machine.needsLink) &&
        owner?.session != null &&
        !owner!.session!.readOnly;
  }

  Widget _focusedModelPicker(
    WorkspacePaneContext? focused, {
    bool menuOnly = false,
  }) {
    if (focused == null ||
        focused.agentId == null ||
        !modelPickerSupports(focused.engine)) {
      return const SizedBox.shrink();
    }
    bool current() {
      final now = WorkspacePaneContext.focused(app);
      return now != null &&
          now.pane.id == focused.pane.id &&
          now.agentId == focused.agentId &&
          now.pane.machineId == focused.pane.machineId &&
          _canSwitchFocusedModel(now);
    }

    return GridModelPicker(
      key: ValueKey(('focused-model', focused.pane.id, focused.agentId)),
      controller: menuOnly ? _focusedModelController : null,
      menuOnly: menuOnly,
      paneHeader: true,
      enabled: _canSwitchFocusedModel(focused),
      notifier: app,
      machineId: focused.pane.machineId,
      currentModel: focused.agent?.gridModel,
      subscriptionModel: focused.agent?.modelName,
      webSearch: focused.agent?.gridWebSearch,
      engineLabel: focused.engine,
      onOpen: () {
        if (current()) _toggleModels();
      },
      onSelected: (model) {
        if (current()) {
          unawaited(
            app.retargetAgentToGridModel(
              focused.pane.machineId,
              focused.agentId!,
              model.id,
              gridName: model.grid,
            ),
          );
        }
      },
      onUseOwnLogin: () {
        if (current()) {
          unawaited(
            app.clearAgentGrid(focused.pane.machineId, focused.agentId!),
          );
        }
      },
      onRunLocalModel: () {
        if (current()) {
          unawaited(
            app.runLocalModel(context, machineId: focused.pane.machineId),
          );
        }
      },
    );
  }

  Widget _tabStrip() => LayoutBuilder(
    builder: (context, constraints) {
      final cell = workspaceBarCellSizeOf(context);
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final names = workspaceTabNames(app);
      final labels = [
        for (var index = 0; index < app.swarms.length; index++)
          '${index + 1}:${names[app.swarms[index].id]}',
      ];
      final toolHeight = workspaceBarControlHeight(context);
      final contentWidth = math.max(0.0, constraints.maxWidth - cell.width * 7);
      final tabBudget = contentWidth * .45;
      _tabWidths = [
        for (final label in labels)
          math.min(
            math.min(label.characters.length + 2, 24) * cell.width,
            tabBudget,
          ),
      ];
      final total = _tabWidths.fold(0.0, (sum, width) => sum + width);
      final tabsWidth = math.min(total, tabBudget);
      final focused = WorkspacePaneContext.focused(app);
      final prefs = appearancePrefsStore.value.prompt;
      final parts = focused?.format(prefs);
      final pr = _pullRequest.value;
      final prParts = pr == null
          ? null
          : pullRequestStatusLineParts(
              number: pr.number,
              state: pr.state,
              style: prefs.statusStyle,
            );
      final joined =
          prefs.statusStyle.segmented &&
          parts != null &&
          parts.segments.isNotEmpty &&
          prParts != null;
      final prBackground = joined
          ? statusLinePaintSegments(
              prParts,
              theme,
              color: prefs.color,
              segmentOffset: parts.segments.length,
            ).first.background
          : null;
      _revealSelectedTab(tabsWidth);
      return Material(
        key: const ValueKey('workspace-status-bar'),
        color: grid.AppPalette.swarmTabBar,
        child: SizedBox(
          height: math.max(_tabBarHeight, cell.height * 2),
          child: Row(
            children: [
              SizedBox(width: cell.width),
              SizedBox(
                width: tabsWidth,
                child: ReorderableListView.builder(
                  scrollController: _tabScroll,
                  itemExtentBuilder: (index, _) => _tabWidths[index],
                  scrollDirection: Axis.horizontal,
                  shrinkWrap: true,
                  buildDefaultDragHandles: false,
                  itemCount: app.swarms.length,
                  onReorderItem: (old, to) =>
                      app.reorderSwarm(app.swarms[old].id, to),
                  itemBuilder: (context, index) {
                    final swarm = app.swarms[index];
                    final selected = app.activeSwarmId == swarm.id;
                    return ReorderableDragStartListener(
                      key: ValueKey(swarm.id),
                      index: index,
                      child: Listener(
                        onPointerDown: (event) {
                          _middleDownTab = event.buttons == kTertiaryButton
                              ? swarm.id
                              : null;
                        },
                        onPointerUp: (event) {
                          final armed = _middleDownTab;
                          _middleDownTab = null;
                          if (armed == swarm.id) {
                            unawaited(app.closeSwarm(swarm.id));
                          }
                        },
                        child: GestureDetector(
                          onDoubleTap: () => _rename(swarm.id),
                          child: Center(
                            child: WorkspaceBarControl(
                              label: '${labels[index]}: ${swarm.name}',
                              tooltip: workspaceTabTooltip(
                                labels[index],
                                swarm.name,
                                clipped:
                                    workspaceBarTextSizeOf(
                                      context,
                                      labels[index],
                                    ).width >
                                    _tabWidths[index] - cell.width * 2,
                              ),
                              selectedBackground: grid.AppPalette.swarmWelcome,
                              selected: selected,
                              onPressed: _shortcutsEnabled
                                  ? () => app.selectSwarm(swarm.id)
                                  : null,
                              builder: (context, emphasized) => SizedBox(
                                height: double.infinity,
                                child: Padding(
                                  padding: EdgeInsets.symmetric(
                                    horizontal: cell.width,
                                  ),
                                  child: Center(
                                    child: Text(
                                      labels[index],
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      textAlign: TextAlign.center,
                                      style: workspaceBarTextStyle(
                                        color: theme.foreground,
                                        emphasized: emphasized,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              _statusToolSymbol(
                'new-tab',
                'New Tab',
                _newTab,
                '+',
                Size(cell.width * 3, toolHeight),
                theme,
                tooltip: 'New Tab ${_keymap.hint('swarm.new') ?? ''}',
              ),
              SizedBox(width: cell.width * 2),
              Expanded(
                child: Align(
                  alignment: Alignment.centerRight,
                  child: SizedBox(
                    child: SizedBox(
                      key: const ValueKey('workspace-pane-context'),
                      child: focused == null
                          ? const SizedBox.shrink()
                          : LayoutBuilder(
                              builder: (context, constraints) => Row(
                                mainAxisSize: MainAxisSize.min,
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  if (modelPickerSupports(focused.engine)) ...[
                                    ConstrainedBox(
                                      constraints: BoxConstraints(
                                        maxWidth: constraints.maxWidth * .35,
                                      ),
                                      child: _focusedModelPicker(focused),
                                    ),
                                    SizedBox(width: cell.width),
                                  ],
                                  Flexible(
                                    child: WorkspaceStatusLine(
                                      parts: parts!,
                                      links: _contextLinks(focused),
                                      color: prefs.color,
                                      nextBackground: prBackground,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                    ),
                  ),
                ),
              ),
              if (pr != null) ...[
                if (!joined) SizedBox(width: cell.width),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: contentWidth * .28),
                  child: WorkspaceBarControl(
                    key: const ValueKey('workspace-pull-request'),
                    label: '${pr.label} — Open on GitHub',
                    tooltip: 'Open pull request #${pr.number} on GitHub',
                    onPressed: _shortcutsEnabled
                        ? () => _openFocusedPullRequest(pr.url.toString())
                        : null,
                    builder: (context, emphasized) => SizedBox(
                      height: toolHeight,
                      child: Center(
                        widthFactor: 1,
                        child: StatusLine(
                          parts: prParts!,
                          workspaceBar: true,
                          emphasized: emphasized,
                          color: prefs.color,
                          segmentOffset: parts?.segments.length ?? 0,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
              SizedBox(width: cell.width),
            ],
          ),
        ),
      );
    },
  );

  Widget _statusToolSymbol(
    String id,
    String label,
    VoidCallback onPressed,
    String symbol,
    Size size,
    TerminalTheme theme, {
    String? tooltip,
  }) => WorkspaceBarControl(
    key: ValueKey('swarm-$id-button'),
    label: label,
    tooltip: tooltip ?? label,
    foreground: theme.foreground,
    onPressed: _shortcutsEnabled ? onPressed : null,
    builder: (context, emphasized) => SizedBox.fromSize(
      size: size,
      child: Center(
        child: Text(
          symbol,
          style: workspaceBarTextStyle(emphasized: emphasized),
        ),
      ),
    ),
  );
}
