import 'dart:math' as math;
import 'dart:async';

import 'dart:convert';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart'
    show ValueListenable, kIsWeb, listEquals;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../core/runtime_platform.dart';
import '../analytics/analytics.dart';
import '../api/api_client.dart';
import '../core/desktop_window.dart';
import '../core/harness_file_store.dart';
import '../core/project_folder.dart';
import '../core/test_run.dart';
import '../logging/debug_surface.dart';
import '../models/api_connections_controller.dart' show agentOnApiModel;
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
import '../shared/theme/pull_request_icon.dart';
import '../shortcuts/app_shortcuts.dart';
import '../core/models.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_host.dart';
import '../shortcuts/keymap_native.dart';
import '../shortcuts/keymap_settings.dart';
import '../state/app_state.dart';
import '../state/notification_inbox.dart';
import '../widgets/notification_inbox.dart';
import '../widgets/workspace_notifications_button.dart';
import '../state/harness_sessions.dart';
import '../state/harness_activity.dart';
import '../state/harness_placement.dart';
import '../state/new_harness.dart';
import '../state/device_form.dart';
import '../state/device_finder.dart';
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
import '../widgets/add_phone_dialog.dart';
import '../widgets/layout_palette.dart';
import '../widgets/move_pane_palette.dart';
import '../widgets/engine_identity.dart';
import '../widgets/harness_activity_mark.dart';
import '../widgets/workspace_status_line.dart';
import '../widgets/workspace_pull_request_label.dart';
import '../widgets/workspace_bar_control.dart';
import '../widgets/session_work_dialog.dart';
import '../widgets/web_download_button.dart';
import '../widgets/workspace_share_button.dart';
import '../widgets/workspace_store_button.dart';
import '../widgets/grid_model_picker.dart';
import '../store/store_mark.dart';
import '../store/store_screen.dart';
import '../widgets/harness_start_page.dart';
import '../widgets/harness_session_manager.dart';
import '../widgets/onboarding_card.dart';
import '../state/toolbar_notices.dart';
import '../widgets/machine_actions.dart';
import '../widgets/rename_agent_dialog.dart';
import '../widgets/delete_agent_dialog.dart';
import '../widgets/take_over_dialog.dart';
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
import '../teams/team_workspace.dart';
import '../state/workspace_learning.dart';
import '../state/workspace_onboarding.dart';
import '../daemons/daemon_brain.dart';
import '../daemons/daemon_face.dart';
import '../daemons/companion_life.dart';
import '../daemons/companion_observers.dart';
import '../daemons/companion_publisher.dart';
import '../daemons/daemon_plate_client.dart';
import '../daemons/daemon_habits.dart';
import '../daemons/daemon_settings.dart';
import '../daemons/pair_rules_file.dart';
import '../daemons/zoo.dart';
import '../daemons/zoo_controller.dart';
import '../widgets/daemon_hatch.dart';
import '../widgets/daemon_panel.dart';
import '../widgets/daemon_slot.dart';
import '../widgets/workspace_quick_start.dart';
import '../widgets/workspace_start_guide.dart';
import '../widgets/workspace_welcome.dart';
import '../shortcuts/keyboard_practice.dart';
import '../widgets/agent_alert_banners.dart';
import '../settings/experimental_features.dart';

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
    this.zoo,
    this.zooTransport,
    this.daemonClock,
    this.daemonsPreview,
    this.experimentalFeatures,
  });
  final AppNotifier notifier;
  final bool? nativeTabs;
  final SwarmProjectStore? projectStore;
  final ModelsMenuController? modelsMenu;
  final bool commandBarEnabled;
  final CommandResolver? commandResolver;
  final WorkspaceLearning? learning;
  final WorkspaceOnboarding? onboarding;

  /// The account's zoo (daemons/README.md); tests pass their own.
  final ZooController? zoo;

  /// How an account's zoo is reached; tests fake it. Unset under test, an
  /// account has no daemons (as when `GET /api/zoo` answers 404).
  final ZooTransport? zooTransport;

  /// The daemon's clock (tests pass the fake one).
  final DateTime Function()? daemonClock;

  /// Test seam for the guest's durable local zoo. The app's experimental preview
  /// uses a separate, window-only collection and never seeds an account.
  final ValueListenable<bool>? daemonsPreview;
  final ExperimentalFeaturesStore? experimentalFeatures;
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
  static const _channel = MethodChannel('harness/swarm_tabs');

  /// The tab the middle button went down on, so an up that slid onto another
  /// tab closes nothing. Null between presses.
  String? _middleDownTab;
  late final bool _native =
      widget.nativeTabs ?? (RuntimePlatform.isMacOS && !kUnderTest);
  late final SwarmProjectStore _projects =
      widget.projectStore ??
      SwarmProjectStore(storage: kUnderTest ? null : HarnessFileStore.shared);
  StreamSubscription<SpokenTaskRequest>? _spokenTasks;
  StreamSubscription<void>? _modelsRequests;
  final _shellFocus = FocusNode(debugLabel: 'Swarm shell');

  /// Where the keyboard waits after the active tab closes
  /// ([AppNotifier.tabStripFocused]): the strip drawn here, or the native one
  /// in the title bar, which draws its selected tab as focused.
  final _tabStripFocus = FocusNode(
    debugLabel: 'Tab strip',
    skipTraversal: true,
  );
  late int _tabStripRequest;
  final _focusedModelController = GridModelPickerController();
  OverlayEntry? _modelsOverlay;
  VoidCallback? _unregisterModels;
  OverlayEntry? _harnessesOverlay;
  VoidCallback? _unregisterHarnesses;
  late final WorkspacePullRequest _pullRequest;
  final _toolbarNotices = ToolbarNotices();
  late final _onboarding =
      widget.onboarding ??
      WorkspaceOnboarding(storage: kUnderTest ? null : HarnessFileStore.shared);
  late final _zoo =
      widget.zoo ??
      ZooController(
        storage: kUnderTest ? null : HarnessFileStore.shared,
        now: widget.daemonClock,
      );
  ApiClient? _zooApi;
  ZooTransport? _apiZooTransport;
  ZooTransport? get _zooTransport {
    if (widget.zooTransport != null) return widget.zooTransport;
    if (kUnderTest) return null;
    if (!identical(_zooApi, app.api)) {
      _zooApi = app.api;
      _apiZooTransport = ApiZooTransport(app.api);
    }
    return _apiZooTransport;
  }

  late final _daemonSettings = DaemonSettings(
    storage: kUnderTest ? null : HarnessFileStore.shared,
    canPersist: () => !_zoo.isPreview,
  );
  late final _face = DaemonFace(
    _zoo,
    now: widget.daemonClock,
    settings: _daemonSettings,
  );
  late final _companion = CompanionPublisher(
    window: app.desktopWindowId,
    now: widget.daemonClock,
    send: (payload) =>
        app.viewer == null &&
        !_zoo.isPreview &&
        app.sendDaemonFrame('app_companion', payload),
  );
  Timer? _companionTimer;
  late final _companionTools = CompanionTools(_face.react);
  late final _companionPrs = CompanionPullRequests(
    sources: () => [
      for (final session in _sessions)
        if (session.open &&
            session.online &&
            !session.machine.machine.isShared &&
            session.project?.shownBranch != null)
          (
            key:
                '${session.machineId}/${session.project?.remote}/${session.project?.cwd}/${session.project?.shownBranch}',
            machine: session.machineId,
            agent: session.agent.id,
          ),
    ],
    read: app.readAgentPullRequest,
    merged: (pr) => _face.react(CompanionEvent.merged, 'merge:${pr.url.path}'),
  );
  int _companionTurn = 0;
  void _companionTool(String owner, String type, Map<String, dynamic> payload) {
    if (type == 'turn_ended') {
      if (_creatureEnabled && _face.livingTim) {
        _face.react(
          payload['failed'] == true
              ? CompanionEvent.failed
              : CompanionEvent.completed,
          'turn:${++_companionTurn}',
        );
      }
      return;
    }
    if (_creatureEnabled && _face.livingTim) {
      _companionTools.observe(owner, type, payload);
    }
  }

  final _knownCompanionPrs = <String, String>{};

  void _publishCompanion({bool force = false}) {
    if (!mounted) return;
    _companion.publish(
      _face.companionPresentation,
      scope: _accountScope,
      foreground: app.inForeground,
      force: force,
    );
  }

  Future<void> _companionAction(Map<String, dynamic> request) async {
    final id = request['requestId'];
    if (id is! String || id.length > 64) return;
    var ok = false;
    if (_creatureEnabled &&
        !_zoo.isPreview &&
        _zoo.loaded &&
        _companion.owns(request)) {
      final action = request['action'];
      if (action == 'hatch' &&
          _zoo.paired == null &&
          _zoo.readyEgg?.id == request['target'] &&
          _hatchOverlay == null &&
          _zoo.hatchingEgg == null) {
        await revealWindow();
        if (mounted &&
            _creatureEnabled &&
            _companion.owns(request) &&
            _zoo.readyEgg?.id == request['target']) {
          _hatch(_zoo.readyEgg!);
          ok = true; // Accepted; the server result drives the actual reveal.
        }
      } else if (_face.livingTim && _zoo.paired?.uid == request['target']) {
        switch (action) {
          case 'pet':
            _face.boop();
            ok = true;
          case 'nap':
            _face.nap();
            ok = true;
          case 'wake':
            _face.wake();
            ok = true;
        }
      }
    }
    if (mounted) {
      app.sendDaemonFrame('app_companion_result', {'requestId': id, 'ok': ok});
    }
  }

  void _companionReconnect() => _publishCompanion(force: true);

  void _companionPrChanged() {
    final pr = _pullRequest.value;
    if (!_creatureEnabled || !_face.livingTim || pr == null) return;
    final key = pr.url.toString();
    final before = _knownCompanionPrs[key];
    _knownCompanionPrs[key] = pr.state;
    if (_knownCompanionPrs.length > 128) {
      _knownCompanionPrs.remove(_knownCompanionPrs.keys.first);
    }
    if ((before == 'Open' || before == 'Draft') && pr.state == 'Merged') {
      _face.react(CompanionEvent.merged, 'merge:${pr.url.path}');
    }
  }

  late final ValueListenable<bool>? _daemonsPreview = widget.daemonsPreview;

  late final _experimentalFeatures =
      widget.experimentalFeatures ?? app.experimentalFeatures;

  bool get _showShareButton =>
      _experimentalFeatures.enabled(ExperimentalFeature.shareButton);

  late bool _creatureEnabled = _creatureChoice;
  bool get _creatureChoice =>
      ExperimentalFeature.focusBarCreature.available &&
      app.viewer == null &&
      _experimentalFeatures.enabled(ExperimentalFeature.focusBarCreature);
  late final _brain = DaemonBrain(
    send: _sendDaemonFrame,
    storage: kUnderTest ? null : HarnessFileStore.shared,
    now: widget.daemonClock,
  );

  /// Individuals' own plates, drawn by this computer's harnessd and asked
  /// for over its local socket (`daemon_plate_get`).
  late final _plates = DaemonPlateClient(
    send: _sendDaemonFrame,
    roster: _zoo.roster,
    now: widget.daemonClock,
  );
  final _brainSubscriptions = <StreamSubscription<Object?>>[];
  DateTime? _awaySince;
  String? _presencePair;
  String? _presenceAutonomy;
  bool? _presenceConsent;
  String? _presenceFocus;
  DaemonBrief? _lastBrief;
  StreamSubscription<int?>? _zooPushes;
  OverlayEntry? _daemonOverlay;
  OverlayEntry? _hatchOverlay;
  OverlayEntry? _daemonHintOverlay;
  Timer? _daemonHintTimer;
  bool _daemonHintPending = false;
  VoidCallback? _unregisterDaemon;
  VoidCallback? _unregisterHatch;
  bool _reduceMotion = false;
  bool? _backendWasOnline;

  /// Something was opened from Cmd-O in this window: the `find` habit.
  bool _foundSomething = false;
  String? _lastDaemonPayload;

  /// The status slot has taken its place in the bar. It waits for the first
  /// quiet moment after daemons turn on (no button held, the pointer off the
  /// bar, no input for [_slotSettle]) so tabs never move under a click.
  bool _slotShown = false;
  Timer? _slotTimer;
  DateTime? _lastWindowInput;
  bool _pointerHeld = false;
  bool _pointerOverBar = false;
  static const _slotSettle = Duration(milliseconds: 800);

  /// What [daemonCommandsActive] was last set to by this window.
  bool _daemonCommandsOn = false;
  bool _daemonSettingsLoaded = false;
  final _startSearchFocus = FocusNode(debugLabel: 'Start page search');
  final _commandFocus = FocusNode(debugLabel: 'Ask Harness');
  bool _commandBarOpen = false;
  bool _commandActionInFlight = false;
  FocusNode? _commandReturnFocus;
  bool get _hasCommandBar => widget.commandBarEnabled;
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
            app.resolveCommandBar(request, cancelToken: cancel),
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
  DeviceFinder? _searchDevice;
  final _resourcePreviewKey = GlobalKey();

  /// New Harness, open in the box. Never open beside the search: they are two
  /// modes of one surface, and opening either closes the other.
  NewHarnessController? _newHarness;
  DeviceFormPort? _newHarnessDevicePort, _deviceFormPort;
  String? _deviceFormId, _deviceFormMachine;
  String _deviceFormSurface = 'new';
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
  bool _browserMachineSetupHandled = false;
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
    // What to pick up, opened into this tab the way Cmd-P opens it: a harness
    // as itself, a conversation Harness did not start as a harness resuming it.
    app: app,
    projects: _projects.projects,
    onOpen: (row) => unawaited(
      _activateSearch(
        SwarmSearchSelection(row),
        app.activeSwarmId,
        placement: HarnessPlacement.currentTab,
      ),
    ),
  );

  void _showKeyboardShortcuts() {
    if (_newHarness?.requestDismiss() == false) return;
    _closeNewHarness(restoreFocus: false);
    unawaited(_dialog(() => showShortcutsSheet(context)));
  }

  @override
  void initState() {
    super.initState();
    app.deviceNavigationAllowed = _allowDeviceNavigation;
    app.deviceFormCommand = _deviceFormCommand;
    _pullRequest = WorkspacePullRequest(app)..addListener(_statusPrefsChanged);
    _pullRequest.addListener(_companionPrChanged);
    app.companionReconnect = _companionReconnect;
    app.companionTool = _companionTool;
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
    app.foreground.addListener(_daemonEnvironmentChanged);
    app.addListener(_syncToolbarNotices);
    _toolbarNotices.addListener(_toolbarNoticesChanged);
    _onboarding.addListener(_onboardingChanged);
    _zoo.addListener(_zooChanged);
    _face.addListener(_faceChanged);
    // A line with keys is acknowledged once it, and what its keys would do,
    // are on screen (`daemon_shown`); its keys arm a moment later.
    _face.voiceLine.addListener(_voiceChanged);
    _daemonsPreview?.addListener(_syncDaemon);
    _experimentalFeatures.addListener(_experimentalFeaturesChanged);
    app.agentPulse.addListener(_face.pulse);
    _face.dialogOpen = () =>
        _dialogOpen ||
        _spokenPaletteOpen ||
        !_routeIsCurrent ||
        _pickerModalDepth > 0 ||
        _hatchOverlay != null;
    _zooPushes = app.zooPushes.listen(_zoo.pushed);
    // The pair brain, when this computer's harnessd has one.
    _brain.addListener(_brainChanged);
    // A look at the finished-turn count clears the brain's count too.
    _face.onSeen = () => unawaited(_brain.doneSeen());
    _face.plates = _plates;
    _brainSubscriptions.addAll([
      app.daemonFrames.listen((f) {
        if (_zoo.isPreview || !_zoo.loaded) return;
        if (f.type == 'dial_companion') {
          unawaited(_companionAction(f.payload));
          return;
        }
        if (f.type == 'daemon_plate') {
          _plates.receive(f.type, f.payload);
          return;
        }
        _brain.receive(f.type, f.payload);
      }),
      // Heard, but nothing of it shows until daemons are on here.
      _brain.said.listen((say) {
        if (_zoo.loaded) _face.sayFromBrain(say);
      }),
      _brain.unsaid.listen(_face.unsay),
      _brain.errors.listen((line) {
        if (_zoo.loaded) _face.sayNote(line);
      }),
      // [g]: the brain says which harness; opening it is the window's.
      _brain.opens.listen((about) {
        if (_zoo.loaded) _openHarness(about);
      }),
      // harnessd answered DAEMONS_OFF: all of it goes.
      _brain.switchedOff.listen((_) => _zoo.switchOff()),
    ]);
    // Idle at the window is away too: harnessd hears it (a night egg's away
    // turns, and the brief on return).
    GestureBinding.instance.pointerRouter.addGlobalRoute(_notePointer);
    HardwareKeyboard.instance.addHandler(_noteKey);
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
    if (_native) {
      _channel.setMethodCallHandler(_onNative);
      app.addListener(_syncNative);
      _syncNative();
    }
    _tabStripRequest = app.tabStripFocusRequest;
    _tabStripFocus.addListener(_tabStripFocusChanged);
    app.addListener(_followTabStripFocus);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Only the one flag: depending on all of MediaQuery rebuilt the workspace
    // on every resize.
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final motionChanged = reduceMotion != _reduceMotion;
    _reduceMotion = reduceMotion;
    _daemonEnvironmentChanged();
    final keymap = KeymapTheme.of(context);
    if (keymap != _providedKeymap) {
      _keymap.removeListener(_keymapChanged);
      _providedKeymap = keymap;
      _keymap.addListener(_keymapChanged);
    }
    _syncKeymap();
    final current = ModalRoute.isCurrentOf(context) ?? true;
    if (_routeIsCurrent == current) {
      if (motionChanged && _native) _syncNative();
      return;
    }
    _routeIsCurrent = current;
    if (!current &&
        (_search != null ||
            _commandBarOpen ||
            _daemonOverlay != null ||
            _hatchOverlay != null ||
            _harnessesVisible ||
            _modelsVisible)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_routeIsCurrent && _pickerModalDepth == 0) {
          _closeSearch(restoreFocus: false);
          _closeCommandBar(restoreFocus: false);
          _closeModelsControls(restoreFocus: false);
          _closeHarnessControls(restoreFocus: false);
          _closeDaemon(restoreFocus: false);
          _closeHatch(restoreFocus: false);
        }
      });
    }
    if (_native) _syncNative();
  }

  @override
  void dispose() {
    _companion.publish(
      {'enabled': false},
      scope: _accountScope,
      foreground: false,
      force: true,
    );
    _closeDaemonHint();
    app.foreground.removeListener(_daemonEnvironmentChanged);
    if (app.deviceNavigationAllowed == _allowDeviceNavigation) {
      app.deviceNavigationAllowed = null;
    }
    if (app.deviceFormCommand == _deviceFormCommand) {
      app.deviceFormCommand = null;
    }
    app.removeListener(_syncToolbarNotices);
    _toolbarNotices.removeListener(_toolbarNoticesChanged);
    _toolbarNotices.dispose();
    HardwareKeyboard.instance.removeHandler(_noteKey);
    _daemonsPreview?.removeListener(_syncDaemon);
    _experimentalFeatures.removeListener(_experimentalFeaturesChanged);
    _slotTimer?.cancel();
    if (_daemonCommandsOn) daemonCommandsActive.value = false;
    unawaited(_zooPushes?.cancel());
    for (final subscription in _brainSubscriptions) {
      unawaited(subscription.cancel());
    }
    _brain.removeListener(_brainChanged);
    _brain.dispose();
    _plates.dispose();
    GestureBinding.instance.pointerRouter.removeGlobalRoute(_notePointer);
    _idleTimer?.cancel();
    app.agentPulse.removeListener(_face.pulse);
    _face.voiceLine.removeListener(_voiceChanged);
    _face.removeListener(_faceChanged);
    app.companionReconnect = null;
    app.companionTool = null;
    _companionPrs.dispose();
    _companionTimer?.cancel();
    _face.dispose();
    _daemonSettings.dispose();
    _zoo.removeListener(_zooChanged);
    if (widget.zoo == null) _zoo.dispose();
    _unregisterDaemon?.call();
    _daemonOverlay?.remove();
    _daemonOverlay?.dispose();
    _unregisterHatch?.call();
    _hatchOverlay?.remove();
    _hatchOverlay?.dispose();
    _dismissMachinePrompt();
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
    _pullRequest.removeListener(_companionPrChanged);
    _pullRequest.dispose();
    terminalFontStore.removeListener(_fontChanged);
    app.removeListener(_recordNavigation);
    app.removeListener(_observeLearning);
    app.removeListener(_followTabStripFocus);
    _tabStripFocus.removeListener(_tabStripFocusChanged);
    _tabStripFocus.dispose();
    app.agentUnread.removeListener(_unreadChanged);
    _lifecycle?.dispose();
    if (widget.learning == null) _learning.dispose();
    FocusManager.instance.removeListener(_restoreEmptyFocus);
    FocusManager.instance.removeListener(_syncKeyContext);
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _searchDevice?.close();
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
    if (_native) {
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
  bool? _sentDaemonCommands;
  void _syncKeymap() {
    if (!_native ||
        (_sentKeymap == _keymap &&
            _sentKeymapVersion == _keymap.version &&
            _sentDaemonCommands == daemonCommandsActive.value)) {
      return;
    }
    _sentKeymap = _keymap;
    _sentKeymapVersion = _keymap.version;
    _sentDaemonCommands = daemonCommandsActive.value;
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
    if (_native) _syncNative();
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

  bool get _modelsVisible =>
      _modelsOverlay != null || _search?.isModelMode == true;
  bool get _machinesVisible => _search?.isMachineMode == true;
  bool get _harnessesVisible =>
      _harnessesOverlay != null || _search?.scopePrefix.isEmpty == true;

  bool get _shortcutsEnabled =>
      mounted && _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen;

  bool _allowDeviceNavigation() =>
      _shortcutsEnabled &&
      ModalRoute.of(context)?.isCurrent != false &&
      _search == null &&
      !_commandBarOpen &&
      _newHarnessOverlay == null &&
      !_modelsVisible &&
      !_machinesVisible &&
      !_harnessesVisible;

  Future<Map<String, dynamic>> _deviceFormCommand(
    String machineId,
    Map<String, dynamic> command,
  ) async {
    final id = command['formId'] as String;
    final op = command['op'] as String;
    final surface =
        command['surface'] as String? ??
        (op == 'open' ? 'new' : _deviceFormSurface);
    final finding = surface == 'find';
    Map<String, dynamic> fail(String error) => {
      'ok': false,
      'active': false,
      'error': error,
    };
    if (!_shortcutsEnabled ||
        ModalRoute.of(context)?.isCurrent == false ||
        _newHarnessHidden ||
        _pickingFolder ||
        _pickerModalDepth > 0 ||
        _commandBarOpen ||
        (finding
            ? _newHarness != null ||
                  _modelsOverlay != null ||
                  _harnessesOverlay != null
            : _search != null ||
                  _modelsVisible ||
                  _machinesVisible ||
                  _harnessesVisible)) {
      return fail('Return to the active picker on desktop.');
    }
    if (op == 'open' && _deviceFormId != id) {
      final tab = app.activeSwarmId;
      if (finding) {
        if (_search == null) _openSearch();
        if (_searchDevice?.supported != true) {
          return fail('Open harness search on desktop first.');
        }
      } else if (_newHarness == null) {
        await _newAgent(
          stillCurrent: () =>
              app.inForeground &&
              _allowDeviceNavigation() &&
              app.activeSwarmId == tab &&
              DateTime.now().millisecondsSinceEpoch <
                  (command['expiresAt'] as int),
        );
      }
      // Opening loads remembered choices asynchronously. Never attach this
      // remote to a form someone else opened while that load was in flight.
      if (!mounted ||
          app.activeSwarmId != tab ||
          (finding ? _searchDevice == null : _newHarnessDevicePort == null) ||
          DateTime.now().millisecondsSinceEpoch >=
              (command['expiresAt'] as int)) {
        return fail('Open the picker again.');
      }
      _deviceFormId = id;
      _deviceFormMachine = machineId;
      _deviceFormSurface = surface;
      _deviceFormPort = finding ? _searchDevice!.port : _newHarnessDevicePort;
      await WidgetsBinding.instance.endOfFrame;
    }
    final port = _deviceFormPort;
    if (id != _deviceFormId ||
        machineId != _deviceFormMachine ||
        surface != _deviceFormSurface ||
        port == null) {
      return fail('This picker has ended. Open it again.');
    }
    if (op == 'open') return port.snapshot();
    return port.command(
      op,
      command['revision'] as int? ?? 0,
      command['delta'] as int? ?? 0,
      queryId: command['queryId'] as String?,
      text: command['text'] as String?,
    );
  }

  void _runShortcut(String id) {
    _closeDaemonHint();
    _closeDaemon(restoreFocus: false);
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
        id != 'machines.connections' &&
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

  int get _attention => _sessions.where((row) => row.needsInput).length;

  /// The bell and its list count the same current questions and unread results.
  int get _unread => notificationInbox(app).length;

  /// Whose window this is, or null while a signed-in window still waits for
  /// its profile. Syncing earlier keyed the first reads by a temporary scope
  /// and flashed another account's progress at boot.
  String? get _accountScope {
    if (app.isGuest) return 'guest';
    final profile = app.currentUser;
    if (profile == null) return null;
    return 'account:${profile.id ?? profile.email}';
  }

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
    _modelsOverlay?.markNeedsBuild();
    _harnessesOverlay?.markNeedsBuild();
    if (_native) _syncNative();
    setState(() {});
  }

  List<HarnessSession>? _sessionsThisTick;

  /// The session rows, built once per tick: the toolbar, the daemon, the
  /// attention badge and the native payload all read the same list.
  List<HarnessSession> get _sessions {
    final cached = _sessionsThisTick;
    if (cached != null) return cached;
    final rows = harnessSessions(app);
    _sessionsThisTick = rows;
    scheduleMicrotask(() => _sessionsThisTick = null);
    return rows;
  }

  void _syncDaemon() {
    _zoo.bind(
      _accountScope,
      remote: app.isGuest ? null : _zooTransport,
      enabled: app.isGuest ? _daemonsPreview?.value == true : _creatureEnabled,
    );
    _zoo.recheckIfDue();
    _face.setLiving(_creatureEnabled || _daemonsPreview?.value == true);
    _companionPrs.bind(
      enabled: _creatureEnabled && !kUnderTest && !_zoo.isPreview,
      scope: _accountScope,
    );
    if (!_creatureEnabled) _companionTools.reset();
    if (_creatureEnabled) {
      _companionTimer ??= Timer.periodic(
        const Duration(seconds: 10),
        (_) => _publishCompanion(force: true),
      );
    } else {
      _companionTimer?.cancel();
      _companionTimer = null;
    }
    _publishCompanion();
    final backendOnline = app.backendOnline;
    // A reconnect asks again, on or off.
    if (backendOnline == true && _backendWasOnline == false) _zoo.refresh();
    _backendWasOnline = backendOnline;
    if (!_zoo.loaded) return;
    final sessions = _sessions;
    final brain = _brain.state;
    String who(String engine, String machine) =>
        '${engine.isEmpty ? 'harness' : engine}@$machine';
    DaemonSubject subjectOf(HarnessSession s, {String? q}) => DaemonSubject(
      '${s.machineId}/${s.agent.id}',
      who: who(s.agent.engine ?? '', s.machine.machine.displayName),
      q: q,
      since: s.question?.since,
    );
    final byKey = {for (final s in sessions) '${s.machineId}/${s.agent.id}': s};
    final focusedPane = app.focusedPane;
    final focus = focusedPane?.agentId == null
        ? null
        : '${focusedPane!.machineId}/${focusedPane.agentId}';
    if (focus != _presenceFocus && _brain.active) {
      // The pane in front changed: the brain never speaks about it.
      _presenceFocus = focus;
      unawaited(
        _brain.focus(
          machineId: focusedPane?.machineId,
          agentId: focusedPane?.agentId,
        ),
      );
    }
    // What the window sees itself, merged with what the brain sees on every
    // machine (the same ids, so a question counts once).
    final needs = <String, DaemonSubject>{
      for (final s in sessions)
        if (s.online && s.needsInput)
          '${s.machineId}/${s.agent.id}#${s.question!.requestId}': subjectOf(
            s,
            q: s.question!.prompt,
          ),
      for (final need in brain?.needs ?? const <DaemonNeed>[])
        need.key: DaemonSubject(
          need.harness,
          who: need.machine.isEmpty ? null : who(need.engine, need.machine),
          q: need.question,
          since: need.since,
        ),
    };
    // A failure is a harness you have open that failed to start or whose last
    // turn failed. A machine asleep or out of reach is not one: it is shown
    // calmly in the panel and the face stays as it was.
    final failed = [
      for (final s in sessions)
        if (s.open &&
            s.online &&
            (s.agent.launchState == 'failed' ||
                s.machine.failedTurnAgents.contains(s.agent.id)))
          subjectOf(s),
    ];
    // Machines not there, calmly: the brain's word for each (asleep, out of
    // reach, unlinked, ...) over what the window alone can tell (offline).
    final awayByName = <String, DaemonMachine>{
      for (final s in sessions)
        if (s.open && !s.online)
          s.machine.machine.displayName: DaemonMachine(
            name: s.machine.machine.displayName,
            machineId: s.machineId,
            status: 'offline',
          ),
      for (final machine in brain?.machines ?? const <DaemonMachine>[])
        if (machine.away && !machine.local) machine.name: machine,
    };
    final away = awayByName.values.toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    final working = sessions.where((s) => s.online && s.working).length;
    final paired = _brain.paired;
    _face.sync(
      DaemonWatch(
        connected:
            _zoo.isPreview ||
            app.machineStates.values.any(
              (m) => m.connectionStatus == ConnectionStatus.connected,
            ),
        working: working > 0 || brain?.working == true,
        workingCount: working,
        needIds: needs.keys.toSet(),
        needs: needs,
        failing: failed.isNotEmpty || (brain?.failing.isNotEmpty ?? false),
        failed: failed,
        turns: {
          for (final machine in app.machineStates.values)
            machine.machine.machineId: machine.completedHarnessTurns,
        },
        fails: {
          for (final machine in app.machineStates.values)
            machine.machine.machineId: machine.failedHarnessTurns,
        },
        ended: {
          for (final machine in app.machineStates.values)
            machine.machine.machineId: [
              for (final end in machine.recentTurnEnds)
                DaemonTurnEnd(
                  byKey['${machine.machine.machineId}/${end.agentId}'] == null
                      ? DaemonSubject(
                          '${machine.machine.machineId}/${end.agentId}',
                        )
                      : subjectOf(
                          byKey['${machine.machine.machineId}/${end.agentId}']!,
                        ),
                  failed: end.failed,
                ),
            ],
        },
        idleCount: sessions
            .where((s) => s.open && s.running && !s.working && !s.needsInput)
            .length,
        focus: focus,
        away: away,
        // A proposal or a setting waiting for your yes: it asks you
        // something.
        asks: (paired ? brain!.asks.length : 0) + (brain?.confirms.length ?? 0),
        autonomy: brain?.autonomy,
        autonomyRequested: brain?.autonomyRequested,
        doneCount: paired ? brain!.doneCount : null,
        doneLast: [
          if (paired)
            for (final done in brain!.doneLast) done.line,
        ],
      ),
    );
    for (final key in observedHabits(app, found: _foundSomething)) {
      _zoo.habit(key);
    }
    if (app.inForeground) _zoo.noteDay();
    // A guest's turns earn eggs in its local zoo. Signed in, harnessd reports
    // them to the account; sending them here too would count them twice.
    if (app.isGuest || _zoo.isPreview) {
      for (final machine in app.machineStates.values) {
        final id = machine.machine.machineId;
        final seen = _zooTurnsSeen[id] ?? 0;
        _zooTurnsSeen[id] = machine.zooTurns;
        if (machine.zooTurns > seen) {
          final n = machine.zooTurns - seen;
          _zoo.recordTurns(n, machineId: id, away: _awayForNight ? n : 0);
        }
      }
    }
  }

  final _zooTurnsSeen = <String, int>{};

  void _syncToolbarNotices() {
    _syncOnboarding();
    _syncDaemon();
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
    if (_native) _syncNative();
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
    if (_native) _syncNative();
  }

  /// A closed tab left the keyboard on the tab strip. Flutter's focus moves
  /// there now, before the next frame: a key typed in between must reach
  /// neither the closed tab's terminal nor the one beside it.
  void _followTabStripFocus() {
    if (!mounted || !app.tabStripFocused) return;
    final request = app.tabStripFocusRequest;
    if (request == _tabStripRequest) return;
    _tabStripRequest = request;
    if (ModalRoute.of(context)?.isCurrent == false) return;
    _tabStripFocus.requestFocus();
    FocusManager.instance.applyFocusChangesIfNeeded();
  }

  void _tabStripFocusChanged() {
    if (!mounted) return;
    setState(() {});
    if (_native) _syncNative();
  }

  /// ⏎ on the strip goes into the selected tab. Chords are left to the keymap,
  /// so shortcuts still work here. Anything else typed — letters, arrows, Tab —
  /// was meant for the tab that closed and goes nowhere: not into the tab
  /// beside it, and not into a pane by focus traversal.
  KeyEventResult _onTabStripKey(FocusNode node, KeyEvent event) {
    if (!node.hasPrimaryFocus) return KeyEventResult.ignored;
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed ||
        keyboard.isControlPressed ||
        keyboard.isAltPressed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    // A held ⏎ enters once; its repeats are not typed into the terminal.
    if (event is KeyDownEvent &&
        (key == LogicalKeyboardKey.enter ||
            key == LogicalKeyboardKey.numpadEnter)) {
      if (app.tabStripFocused) {
        app.focusFromTabStrip();
      } else {
        _focusWorkspaceInput();
      }
    }
    return KeyEventResult.handled;
  }

  /// The keyboard back to the workspace after a picker or dialog closes: the
  /// tab strip while a closed tab left it there, else the focused pane.
  bool _focusWorkspaceInput() {
    if (app.tabStripFocused) {
      _tabStripFocus.requestFocus();
      return true;
    }
    return app.focusedPane?.session?.focusInput() == true;
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
    if (_native) _syncNative();
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
        label: focused.agent?.gitContext == null
            ? 'Find harnesses on ${focused.branch} in ${focused.projectName}'
            : 'Branches and pull requests · ${focused.branch}\n${focused.detail}',
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
    if (field == StatusLineField.branch && focused.agent?.gitContext != null) {
      unawaited(_showSessionWork(focused));
      return;
    }
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

  Future<void> _showSessionWork(WorkspacePaneContext focused) =>
      _dialog(() async {
        final agent = focused.agent;
        if (agent == null) return;
        final machineId = focused.pane.machineId;
        await showDialog<void>(
          context: context,
          builder: (_) => SessionWorkDialog(
            agent: agent,
            online: app.stateOf(machineId)?.isOffline == false,
            read: (offset) =>
                app.readAgentGitHistory(machineId, agent.id, offset: offset),
          ),
        );
      });

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
    _modelsOverlay?.markNeedsBuild();
    _harnessesOverlay?.markNeedsBuild();
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
      'reduceMotion': _reduceMotion,
      'activeId': app.activeSwarmId,
      'searchTooltip':
          'Search harnesses ${_keymap.hint('harnesses.list') ?? ''}',
      'storeTooltip': 'Harness Store ${_keymap.hint('app.store') ?? ''}',
      // The selected tab is drawn with keyboard focus: ⏎ goes into it.
      'tabsFocused': app.tabStripFocused && _tabStripFocus.hasPrimaryFocus,
      // Only once the slot is shown: until then (and whenever daemons are
      // off) native lays out the bar it had before daemons existed.
      if (_slotShown) 'daemon': _daemonPayload,
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
              'text': focused.modelLabel,
              'segments': [
                {
                  'text': focused.modelLabel,
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
              'label': _pullRequest.value!.label,
              'iconAsset': pullRequestIconAsset(_pullRequest.value!.state),
              'iconColor': pullRequestIconColor(
                _pullRequest.value!.state,
                terminalTheme,
                color: prefs.color,
              ).toARGB32(),
              'url': _pullRequest.value!.url.toString(),
              'detail': '${_pullRequest.value!.label} — Open on GitHub',
              'interactive': true,
            },
      'canReopen': app.canReopenLastClosed,
      'canFind': _canFindTerminal,
      'canClosePane': app.focusedPane != null,
      if (_showShareButton)
        'shareAction': {
          'text': WorkspaceShareButton.text,
          'label': _shareLabel(focused),
          'tooltip': _shareTooltip(focused),
          'enabled': _canExecuteCommand('agent.share'),
          'paneId': focused?.pane.id,
          'machineId': focused?.pane.machineId,
          'agentId': focused?.agentId,
          'background': WorkspaceShareButton.backgroundFor(
            _canExecuteCommand('agent.share'),
          ).toARGB32(),
          'foreground': WorkspaceShareButton.foregroundFor(
            _canExecuteCommand('agent.share'),
          ).toARGB32(),
        },
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
      // The native bell uses the same inbox count as its Flutter counterpart.
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
      'runningSessions': _sessions.where((row) => row.running).length,
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
            if (tabActivity(app, swarm) case final activity?)
              'activity': {
                'mark': activity.mark,
                'label': activity.label,
                'working': activity == HarnessActivity.working,
                'color': activityColor(
                  activity,
                  terminalTheme,
                  color: prefs.color,
                ).toARGB32(),
              },
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
    if (call.method == 'shareAgent' && args.containsKey('paneId')) {
      if (!_showShareButton) return;
      final focused = WorkspacePaneContext.focused(app);
      if (focused == null ||
          focused.pane.id != args['paneId'] ||
          focused.pane.machineId != args['machineId'] ||
          focused.agentId != args['agentId']) {
        return;
      }
    }
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
      unawaited(_openMachines());
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'modelControls') {
      _toggleModelsControls();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'daemon') {
      if (_zoo.loaded) _activateDaemon();
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    if (call.method == 'daemonLook') {
      if (!_zoo.loaded) return;
      _face.look();
      _face.seen();
      return;
    }
    if (call.method == 'daemonAnswer') {
      final key = (call.arguments as Map?)?['key'];
      if (key is String && _shortcutsEnabled && _zoo.loaded) {
        _answerDaemon(key);
      }
      return;
    }
    if (call.method == 'linkMachine') {
      unawaited(_openMachines());
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
      case 'notificationInbox':
        unawaited(_showNotificationInbox());
      case 'settings':
        await _settings();
      case 'addPhone':
        await _addPhone();
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
          'notificationInbox',
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
    if (_native) _syncNative();
    try {
      await action();
    } finally {
      _dialogOpen = false;
      if (mounted) {
        _canvasFocus.descendantsAreFocusable = _search == null;
        if (_search == null &&
            ModalRoute.of(context)?.isCurrent != false &&
            !_focusWorkspaceInput()) {
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

  String _shareLabel(WorkspacePaneContext? focused) =>
      focused?.agent == null ? 'Share' : 'Share ${focused!.agent!.displayName}';

  String _shareTooltip(WorkspacePaneContext? focused) {
    if (focused?.agent == null) return 'Focus an agent to share it';
    if (app.stateOf(focused!.pane.machineId)?.machine.isShared != false) {
      return 'Only the owner can share this agent';
    }
    return [
      _shareLabel(focused),
      _keymap.hint('agent.share'),
    ].whereType<String>().join(' · ');
  }

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
      experimentalFeatures: _experimentalFeatures,
      source: 'swarm',
    ),
  );

  /// Harness ▸ Add Phone… and `> add phone`: the QR a phone scans to sign in
  /// and pair with this computer. See `widgets/add_phone_dialog.dart`.
  Future<void> _addPhone() => _dialog(
    () => showAddPhoneDialog(
      context,
      app,
      keymap: _keymap,
      onConnectMachine: () => unawaited(_openMachines()),
      // The QR's `f`: the phone refuses a machine proving a different key.
      machineFingerprint: app.viewer == null
          ? null
          : (remote) => machineFingerprintOf(app, remote),
      // This computer's daemon keeps the group; a viewer's lives in the browser.
      // The desktop app keeps its Add Phone as it was until the harness CLI's QR work is released.
      groupMachines: null,
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

  Future<void> _openMachines({String? initialMachineId}) async {
    _browserMachineSetupHandled = true;
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
    bool Function()? stillCurrent,
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
      await _openMachines();
      return;
    }
    await Future.wait([app.agentPreference.load(), app.projectHistory.load()]);
    if (!mounted ||
        app.activeSwarmId != target ||
        stillCurrent?.call() == false) {
      return;
    }
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
      devicePort: _newHarnessDevicePort = DeviceFormPort(),
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
    _newHarnessDevicePort?.detach();
    _newHarnessDevicePort = null;
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
      } else if (!_focusWorkspaceInput()) {
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
      await _openMachines();
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
        // A conversation Harness did not start says what stopped it (open in
        // a terminal, gone); a new, empty one is not what was asked for.
        action: row.external != null
            ? null
            : SnackBarAction(
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
    TakeOver? takeOver,
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
        takeOver: takeOver,
      );
    } on SwarmResumeFailure catch (failure) {
      // Open in a terminal: ask whether to move it here — and, mid-turn,
      // whether to wait for the turn or stop it. Asked again when a turn
      // started between the question and the answer.
      final ask =
          failure.canTakeOver &&
          (takeOver == null || (takeOver == TakeOver.idle && failure.busy));
      if (ask && failure.destination.external != null) {
        TakeOver? choice;
        await _dialog(() async {
          choice = await askTakeOver(
            context,
            title: failure.destination.title,
            engine: failure.destination.external!.engine,
            busy: failure.busy,
            machine: failure.destination.machineLabel.isEmpty
                ? null
                : failure.destination.machineLabel,
            keymap: _keymap,
          );
        });
        if (choice case final choice? when mounted) {
          await _activateSearch(
            selected,
            target,
            split: split,
            placement: placement,
            takeOver: choice,
          );
        }
        return;
      }
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
    if (_native && mounted) _syncNative();
  }

  // ── the daemon (daemons/README.md) ─────────────────────────────────────────

  /// A `daemon_*` or `pair` frame to this computer's harnessd, only while
  /// daemons are on here: off (or not decided yet), nothing is sent.
  bool _sendDaemonFrame(String type, Map<String, dynamic> payload) =>
      !_zoo.isPreview && _zoo.loaded && app.sendDaemonFrame(type, payload);

  void _experimentalFeaturesChanged() {
    setState(() {});
    if (_native) _syncNative();
    final choice = _creatureChoice;
    if (_creatureEnabled == choice) return;
    final hadOverlay = _daemonOverlay != null || _hatchOverlay != null;
    _creatureEnabled = choice;
    _closeDaemonHint();
    _closeDaemon(restoreFocus: false);
    _closeHatch(restoreFocus: false);
    _face.dismissVoice();
    _brain.reset();
    _plates.reset();
    _syncDaemon();
    // A setting change must leave keyboard focus in Settings.
    if (hadOverlay && _routeIsCurrent && !_dialogOpen) _returnFocusToPane();
  }

  Map<String, Object?> get _daemonPayload {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return {
      'visible': _slotShown,
      'glyph': _face.glyph,
      // The ten cells as drawn (centred on the base sprite, a shiny `*` in
      // the gutter). Counts and progress stay out of the focus bar.
      'cell': _face.cell,
      'foreground': daemonSlotInk(_face, theme).withValues(alpha: 1).toARGB32(),
      'patch': daemonSlotPatch(_face, theme)?.toARGB32(),
      'open': _daemonOverlay != null,
      'busy': _face.revealing || _zoo.hatchingEgg != null,
      'label': _face.label,
      'detail': _face.detail,
      'tooltip': _daemonTooltip,
      // Exactly as sent, keys first: native makes the offered keys buttons,
      // once the line is armed (drawn, with its detail, a moment ago).
      'voice': _nativeVoice,
      'voiceActions': [
        for (final action in _face.voiceActions)
          {'key': action.key, 'label': action.label},
      ],
      'voiceArmed': _voiceArmed,
      'voiceColor': (_face.voiceAlert ? theme.yellow : daemonDimInk(theme))
          .toARGB32(),
    };
  }

  /// The spoken line for native: as the face shows it, with a brain line's
  /// keys first even if an older brain put them elsewhere, and the pair
  /// harness's `<nick>` before its own words.
  String? get _nativeVoice {
    final voice = _face.voice;
    if (voice == null) return null;
    final nick = _face.voiceFromPair ? daemonPairNick(_face.name) : '';
    final actions = _face.voiceActions;
    if (actions.isEmpty) return '$nick$voice';
    final split = splitDaemonKeys(voice, actions);
    return split.keys.isEmpty
        ? '$nick$voice'
        : '[${split.keys.join('/')}] $nick${split.rest}';
  }

  String get _daemonTooltip {
    if (!_zoo.isPreview) return _face.tooltip;
    return '${_face.tooltip}\nLocal preview · Settings → Experimental';
  }

  /// Whether a key on the spoken line counts yet.
  bool get _voiceArmed {
    final id = _face.voiceSayId;
    return id == null || _brain.armed(id);
  }

  String? _voiceShownFor;
  String? _detailOverlayFor;

  /// A brain line began or ended. One with keys is acknowledged to harnessd
  /// once it is on screen, and, when it carries a `detail`, once that is on
  /// screen too, in full, in a disclosure under the status line.
  void _voiceChanged() {
    final id = _face.voiceSayId;
    if (_face.voice == null || id == null) {
      _voiceShownFor = null;
      if (_detailOverlayFor != null) _closeDaemonHint();
      return;
    }
    if (id == _voiceShownFor) return;
    _voiceShownFor = id;
    if (_detailOverlayFor != null && _detailOverlayFor != id) {
      _closeDaemonHint();
    }
    final keyed = _face.voiceActions.any((a) => a.key != 'g');
    if (!keyed) return;
    final detail = _face.voiceDetail;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _face.voiceSayId != id) return;
      if (detail == null || detail.isEmpty) {
        // The line is everything its keys act on.
        _brain.shown(id);
        return;
      }
      _showVoiceDetail(id, detail);
    });
  }

  void _showVoiceDetail(String id, String detail) {
    final harness = _face.voiceHarness;
    final title = [
      if (_face.voiceFromPair) '${daemonPairNick(_face.name).trim()} asks',
      ?harness?.label,
      _face.voiceConfirm != null
          ? 'what a yes turns on'
          : id.startsWith('lesson:')
          ? 'the lesson, in full'
          : 'exactly what a key does',
    ].join(' · ');
    final shown = _showDaemonOverlay(
      key: ValueKey('daemon-detail-$id'),
      interactive: true,
      showFor: DaemonFace.voiceFor,
      child: Builder(
        builder: (context) => ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: workspaceBarCellSizeOf(context).width * 84,
          ),
          child: DaemonDetailNotice(
            title: title,
            detail: detail,
            actions: _face.voiceActions,
            onShown: () {
              if (_face.voiceSayId == id) _brain.shown(id);
            },
          ),
        ),
      ),
    );
    if (shown) _detailOverlayFor = id;
  }

  void _faceChanged() {
    _publishCompanion();
    // Two lines can read the same (the same command asked twice): the line's
    // id, not its words, decides whether it is new.
    if (mounted && _zoo.loaded) _voiceChanged();
    if (!mounted || !_native) return;
    _sendDaemonState();
  }

  /// Faces and frames repaint only the native slot; tabs and terminals stay
  /// put. Native hears nothing until the slot is shown, and one `visible:
  /// false` when it goes.
  void _sendDaemonState() {
    if (!_slotShown) {
      if (_lastDaemonPayload == null) return;
      _lastDaemonPayload = null;
      unawaited(_channel.invokeMethod<void>('daemonState', {'visible': false}));
      return;
    }
    final payload = _daemonPayload;
    final key = jsonEncode(payload);
    if (key == _lastDaemonPayload) return;
    _lastDaemonPayload = key;
    unawaited(_channel.invokeMethod<void>('daemonState', payload));
  }

  /// Opened from Cmd-O: the daemon's `find` habit.
  void _noteFound() {
    if (_foundSomething || !_zoo.loaded) return;
    _foundSomething = true;
    _syncDaemon();
  }

  bool _noteKey(KeyEvent event) {
    // Off, this is not here at all: every key goes where it went before.
    if (event is! KeyDownEvent || _zoo.daemons == DaemonsSwitch.off) {
      return false;
    }
    _noteWindowInput();
    if (!_zoo.loaded) return false;
    _noteInput();
    // ⌘⌥ plus an offered key answers the daemon's line: `[y]` is ⌘⌥Y.
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isMetaPressed &&
        keyboard.isAltPressed &&
        !keyboard.isControlPressed &&
        _face.voiceActions.isNotEmpty) {
      final label = event.logicalKey.keyLabel.toLowerCase();
      // Only a line that is armed: drawn, with what its keys do, a moment
      // ago. `[g]` opens at any time.
      if (_face.voiceActions.any((a) => a.key == label) &&
          (label == 'g' || _voiceArmed)) {
        _answerDaemon(label);
        return true;
      }
    }
    _face.noteKey(
      enter:
          event.logicalKey == LogicalKeyboardKey.enter ||
          event.logicalKey == LogicalKeyboardKey.numpadEnter,
    );
    return false;
  }

  /// Answer the daemon's spoken line with one of its offered keys: only once
  /// it is armed (`[g]` opens at any time).
  void _answerDaemon(String key) {
    final sayId = _face.voiceSayId;
    final action = _face.voiceActions.where((a) => a.key == key).firstOrNull;
    if (sayId == null || action == null) return;
    final opens = key == 'g' && _face.voiceTarget?.key != null;
    if (!opens && !_brain.armed(sayId)) return;
    _answerLine(sayId, action, _face.voiceTarget);
    _face.answered();
  }

  /// A key on a line the brain wrote (the status line's, an ask, a brief
  /// item, a confirmation): `[g]` opens the harness, which is the window's to
  /// do; a confirmation's y or n is `daemon_confirm`; any other key goes to
  /// the brain as `daemon_act`. The brain sends nothing for a line that is
  /// not armed yet.
  void _answerLine(String id, DaemonAction action, DaemonAbout? about) {
    if (action.key == 'g' && about?.key != null) {
      _openHarness(about!);
      return;
    }
    if (id.isEmpty) return;
    if (id.startsWith('confirm:')) {
      final rest = id.substring('confirm:'.length);
      final colon = rest.indexOf(':');
      if (colon <= 0) return;
      _brain.confirm(
        rest.substring(0, colon),
        rest.substring(colon + 1),
        accept: action.key == 'y',
      );
      return;
    }
    _brain.act(id, action.choice);
  }

  /// Show a harness the daemon named, wherever it is.
  void _openHarness(DaemonAbout about) {
    if (!mounted) return;
    _closeDaemon(restoreFocus: false);
    _closeDaemonHint();
    unawaited(
      app.revealAgentFromAlert(about.machineId, about.agentId).catchError((
        Object _,
      ) {
        // Gone since, or on a machine this window cannot reach.
        _face.sayNote('that harness is not here any more.');
      }),
    );
  }

  /// The pair harness on this computer (`autonomous/pair`), when known: the
  /// one a talk reached, else the one this machine lists.
  ({String machineId, String agentId})? get _pairHarness {
    final local = app.localMachineState;
    if (local == null) return null;
    final machineId = local.machine.machineId;
    final agentId =
        _brain.pairAgentId ??
        local.agents.where((a) => a.dsh == 'autonomous/pair').firstOrNull?.id;
    return agentId == null ? null : (machineId: machineId, agentId: agentId);
  }

  /// The whole conversation: the pair harness's own pane.
  void _openConversation() {
    final pair = _pairHarness;
    if (pair == null) return;
    _openHarness(DaemonAbout(pair.machineId, pair.agentId));
  }

  /// `~/.config/harness/pair.jsonc`, written with no rules when it is not
  /// there yet, opened in the editor `.jsonc` files open in.
  Future<void> _openPairRules() async {
    try {
      final file = await ensurePairRules();
      if (!await launchUrl(file.uri)) {
        throw StateError('No editor opens .jsonc files. Open ${file.path}.');
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text('Couldn’t open pair.jsonc. $error')),
        );
      }
    }
  }

  /// "Talk to daemon": the panel, with the talk box ready.
  void _talkToDaemon() {
    if (!_zoo.loaded) return;
    if (_daemonOverlay != null) _closeDaemon(restoreFocus: false);
    if (!_brain.paired) {
      _face.sayNote(
        _brain.active
            ? 'pair a daemon first: its panel has [ pair ].'
            : 'harnessd here cannot talk yet. update it.',
      );
    }
    _toggleDaemon(talk: true);
  }

  // ── idle: away at the window ───────────────────────────────────────────────

  /// No key or pointer this long, with the window in front, is away:
  /// harnessd hears `daemon_presence { active: false, awayMs }`.
  static const _idleAfter = Duration(minutes: 5);
  DateTime? _lastInput;
  DateTime? _idleSince;
  Timer? _idleTimer;

  void _notePointer(PointerEvent event) {
    // Off, this is not here at all.
    if (_zoo.daemons == DaemonsSwitch.off) return;
    if (!_slotShown) {
      // Until the slot has its place: whether a button is held and whether
      // the pointer is on the bar, so it never arrives under a click.
      _pointerHeld = event.down;
      final workspace = context.findRenderObject();
      _pointerOverBar =
          !_native &&
          event is! PointerRemovedEvent &&
          workspace is RenderBox &&
          workspace.globalToLocal(event.position).dy >=
              workspace.size.height - _statusBarHeight;
      _noteWindowInput();
    }
    if (!_zoo.loaded) return;
    if (event is PointerDownEvent ||
        event is PointerScrollEvent ||
        event is PointerHoverEvent) {
      _noteInput();
    }
  }

  /// A key or the pointer, anywhere in the window: the slot's quiet moment
  /// starts again.
  void _noteWindowInput() {
    if (_slotShown) return;
    _lastWindowInput = (widget.daemonClock ?? DateTime.now)();
    if (_zoo.loaded && _slotTimer == null) {
      _slotTimer = Timer(_slotSettle, _checkSlot);
    }
  }

  /// Show the slot once daemons are on and the window is quiet: no button
  /// held, the pointer off the bar, and no input for [_slotSettle] (at once
  /// when nothing has been touched yet). Tabs never shift under a click.
  void _checkSlot() {
    _slotTimer?.cancel();
    _slotTimer = null;
    if (!mounted || _slotShown || !_zoo.loaded) return;
    final last = _lastWindowInput;
    final quiet = last == null
        ? _slotSettle
        : (widget.daemonClock ?? DateTime.now)().difference(last);
    if (_pointerHeld || _pointerOverBar || quiet < _slotSettle) {
      _slotTimer = Timer(
        quiet < _slotSettle ? _slotSettle - quiet : _slotSettle,
        _checkSlot,
      );
      return;
    }
    _slotShown = true;
    if (_native) _syncNative();
    setState(() {});
  }

  /// Daemons came on or went off in this window.
  void _daemonsSwitched(bool on) {
    if (_daemonCommandsOn != on) {
      _daemonCommandsOn = on;
      daemonCommandsActive.value = on;
      _syncKeymap();
      _search?.refreshCommands();
    }
    if (on) {
      if (!_daemonSettingsLoaded && !_zoo.isPreview) {
        _daemonSettingsLoaded = true;
        unawaited(_daemonSettings.load());
      }
      _face.brainActive = _brain.active;
      if (_brain.active) unawaited(_sendPresence());
      _checkSlot();
    } else {
      // All of it goes: the slot, its line, the panel, a reveal, what the
      // brain said. The bar is the one it was before daemons existed.
      _slotTimer?.cancel();
      _slotTimer = null;
      _slotShown = false;
      _pointerHeld = false;
      _pointerOverBar = false;
      _lastWindowInput = null;
      _closeHatch(restoreFocus: false);
      _face.dismissVoice();
      _brain.reset();
      _plates.reset();
      if (_native) _sendDaemonState();
    }
    if (_native) _syncNative();
  }

  void _noteInput() {
    final now = (widget.daemonClock ?? DateTime.now)();
    _lastInput = now;
    if (_idleSince case final since?) {
      // Back from idle: a return, with how long.
      _idleSince = null;
      if (app.inForeground) {
        unawaited(_sendPresence(away: now.difference(since)));
      }
    }
    _idleTimer ??= Timer(_idleAfter, _checkIdle);
  }

  void _checkIdle() {
    _idleTimer = null;
    final last = _lastInput;
    if (!mounted || last == null || _idleSince != null) return;
    final now = (widget.daemonClock ?? DateTime.now)();
    final quiet = now.difference(last);
    if (quiet < _idleAfter) {
      _idleTimer = Timer(_idleAfter - quiet, _checkIdle);
      return;
    }
    // Only in front: a window behind others already said it is away.
    if (!app.inForeground || !_zoo.loaded || !_brain.active) return;
    _idleSince = last;
    unawaited(_sendPresence(idle: quiet));
  }

  /// A guest's turns that finish now finished while the person was away if
  /// the window has not been in use for `earn.night.awayMinutes`.
  bool get _awayForNight {
    final minutes = _zoo.roster.rules.earn.awayMinutes;
    final now = (widget.daemonClock ?? DateTime.now)();
    final since = _awaySince ?? _idleSince ?? _lastInput;
    return since != null &&
        (_awaySince != null || _idleSince != null) &&
        now.difference(since) >= Duration(minutes: minutes);
  }

  void _brainChanged() {
    // Heard while daemons are off (or not decided yet): nothing shows.
    if (!mounted || !_zoo.loaded) return;
    final firstHeard = !_face.brainActive && _brain.active;
    _face.brainActive = _brain.active;
    if (firstHeard) unawaited(_sendPresence());
    final brief = _brain.brief;
    if (brief != null && !identical(brief, _lastBrief)) {
      _lastBrief = brief;
      _showBrief(brief);
    }
    _daemonOverlay?.markNeedsBuild();
    _syncDaemon();
    // A line arming changes what native may click.
    _faceChanged();
    // The brain's state changing is news from agents too.
    if (_brain.state?.working == true) _face.pulse();
  }

  /// `daemon_presence`: whether you are at this window, how long you were
  /// away, and (for a guest, whose zoo is local) which daemon it pairs with.
  Future<void> _sendPresence({Duration? away, Duration? idle}) async {
    if (!_zoo.loaded || !_brain.active) return;
    // harnessd knows the pair by its species.
    final pair = app.isGuest ? _zoo.zoo.byUid(_zoo.zoo.pair)?.id : null;
    _presencePair = pair;
    final pane = app.focusedPane;
    final agentId = pane?.agentId;
    _presenceFocus = agentId == null ? null : '${pane!.machineId}/$agentId';
    _presenceAutonomy = app.isGuest ? _zoo.zoo.autonomy : null;
    _presenceConsent = app.isGuest ? _zoo.zoo.watching : null;
    await _brain.presence(
      // Idle in front of the window is away, with how long it has been.
      active: app.inForeground && idle == null,
      away: idle ?? away,
      pair: pair,
      autonomy: _presenceAutonomy,
      consent: _presenceConsent,
      focusMachineId: agentId == null ? null : pane!.machineId,
      focusAgentId: agentId,
    );
  }

  /// The brief on return: a short list under the status line, each item as
  /// sent, keys first. It stays up while its keys work (a minute) when an
  /// item has any, else 10 s; it is in the panel until the next one.
  void _showBrief(DaemonBrief brief) {
    if (!app.inForeground || (brief.line.isEmpty && brief.items.isEmpty)) {
      return;
    }
    final keyed = brief.items.any(
      (item) => item.actions.any((a) => a.key != 'g'),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _showDaemonOverlay(
        key: const ValueKey('daemon-brief'),
        interactive: true,
        showFor: keyed ? DaemonBrief.keysFor : const Duration(seconds: 10),
        child: DaemonBriefNotice(
          name: _face.name,
          brief: brief,
          live: brief.keysLive(_brain.now()),
          armed: _brain.armed,
          arming: _brain,
          onShown: _brain.shown,
          onAnswer: (id, action, about) {
            final opens = action.key == 'g' && about?.key != null;
            if (!opens && !_brain.armed(id)) return;
            _closeDaemonHint();
            _answerLine(id, action, about);
          },
        ),
      );
    });
  }

  String? _lastZooScope;
  int? _lastHabits;
  String? _lastEggId;
  bool _zooWasLoaded = false;

  void _zooChanged() {
    if (!mounted) return;
    if (!_zoo.loaded || _lastZooScope != _zoo.scope) {
      _knownCompanionPrs.clear();
      _companionTools.reset();
      _closeDaemonHint();
      _closeDaemon(restoreFocus: false);
      _lastHabits = null;
      _lastEggId = null;
      _lastZooScope = _zoo.scope;
    }
    if (_zoo.loaded) {
      final habits = _zoo.habitsCounted;
      final egg = _zoo.readyEgg;
      final beforeHatch = _zoo.zoo.daemons.isEmpty;
      if (beforeHatch &&
          _lastHabits != null &&
          (habits > _lastHabits! || (egg != null && _lastEggId == null))) {
        final scope = _zoo.scope;
        final left = _zoo.habitsNeeded - habits;
        final ready = egg != null;
        // One short, and what is left is the habit it cannot come without.
        final required = _zoo.habitsRequiredLeft.firstOrNull;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _zoo.scope != scope || _face.revealing) return;
          _showDaemonNotice(
            ready
                ? 'Your egg is ready.'
                : left <= 0
                ? 'The egg is on its way.'
                : left == 1 && required != null
                ? '${required.label}, and it hatches.'
                : left == 1
                ? 'One habit left. Something stirs.'
                : 'One step closer. $left to go.',
            action: ready ? 'hatch' : 'view',
            onAction: _activateDaemon,
            key: const ValueKey('daemon-habit-notice'),
          );
        });
      }
      _lastHabits = habits;
      _lastEggId = egg?.id;
    }
    // A guest's pair, dial and consent live in its local zoo; the brain
    // hears of a change.
    if (app.isGuest &&
        _brain.active &&
        (_zoo.zoo.byUid(_zoo.zoo.pair)?.id != _presencePair ||
            _zoo.zoo.autonomy != _presenceAutonomy ||
            _zoo.zoo.watching != _presenceConsent)) {
      _presencePair = _zoo.zoo.byUid(_zoo.zoo.pair)?.id;
      _presenceAutonomy = _zoo.zoo.autonomy;
      _presenceConsent = _zoo.zoo.watching;
      unawaited(
        _brain.guest(
          pair: _presencePair,
          autonomy: _presenceAutonomy,
          consent: _presenceConsent,
        ),
      );
    }
    if (_zoo.loaded != _zooWasLoaded) {
      _zooWasLoaded = _zoo.loaded;
      _daemonsSwitched(_zoo.loaded);
      setState(() {});
    }
    _maybeShowDaemonHint();
  }

  void _daemonEnvironmentChanged() {
    final wasForeground = _awaySince == null;
    _face.setEnvironment(
      foreground: app.inForeground,
      reduceMotion: _reduceMotion,
    );
    if (app.inForeground) {
      _maybeShowDaemonHint();
      if (!wasForeground) {
        final away = (widget.daemonClock ?? DateTime.now)().difference(
          _awaySince!,
        );
        _awaySince = null;
        unawaited(_sendPresence(away: away));
      }
    } else {
      _closeDaemonHint();
      if (wasForeground) {
        _awaySince = (widget.daemonClock ?? DateTime.now)();
        unawaited(_sendPresence());
      }
    }
  }

  void _closeDaemonHint() {
    _detailOverlayFor = null;
    _daemonHintTimer?.cancel();
    _daemonHintTimer = null;
    _daemonHintOverlay?.remove();
    _daemonHintOverlay?.dispose();
    _daemonHintOverlay = null;
  }

  /// "A daemon is inside." once per account, beside the nest, never taking
  /// focus. Scheduled from state changes, never from build().
  void _maybeShowDaemonHint() {
    if (!mounted || _daemonHintPending || !_zoo.needsHint) return;
    _daemonHintPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _daemonHintPending = false;
      if (!mounted || !_daemonNoticeAllowed || !_zoo.needsHint) return;
      if (Overlay.maybeOf(context) == null || !_zoo.acknowledgeHint()) return;
      _showDaemonNotice(
        'A daemon is inside.',
        key: const ValueKey('daemon-arrival-hint'),
      );
    });
  }

  bool get _daemonNoticeAllowed =>
      _shortcutsEnabled &&
      app.inForeground &&
      _daemonOverlay == null &&
      _hatchOverlay == null &&
      _search == null &&
      _newHarness == null &&
      !_commandBarOpen &&
      !_machinesVisible &&
      !_modelsVisible &&
      !_harnessesVisible;

  void _showDaemonNotice(
    String message, {
    required Key key,
    String? action,
    VoidCallback? onAction,
    Duration showFor = const Duration(seconds: 6),
  }) => _showDaemonOverlay(
    key: key,
    interactive: onAction != null,
    showFor: showFor,
    child: DaemonNotice(message: message, action: action, onAction: onAction),
  );

  /// A note beside the slot: it never takes focus on arrival, and takes
  /// clicks only when it has something to click.
  bool _showDaemonOverlay({
    required Key key,
    required Widget child,
    required bool interactive,
    Duration showFor = const Duration(seconds: 6),
  }) {
    if (!mounted || !_daemonNoticeAllowed) return false;
    final overlay = Overlay.maybeOf(context);
    if (overlay == null) return false;
    _closeDaemonHint();
    _daemonHintOverlay = OverlayEntry(
      builder: (context) {
        final cell = workspaceBarCellSizeOf(context);
        return Positioned(
          top: (_native ? 0.0 : _tabBarHeight) + cell.width,
          right: cell.width,
          child: IgnorePointer(
            ignoring: !interactive,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxWidth: math.max(
                  0,
                  MediaQuery.sizeOf(context).width - cell.width * 2,
                ),
              ),
              child: KeyedSubtree(key: key, child: child),
            ),
          ),
        );
      },
    );
    overlay.insert(_daemonHintOverlay!);
    _daemonHintTimer = Timer(showFor, _closeDaemonHint);
    return true;
  }

  /// A click on the status slot: a ready egg hatches; otherwise the daemon is
  /// booped and its panel opens (or closes).
  void _activateDaemon() {
    _closeDaemonHint();
    if (!_shortcutsEnabled ||
        _hatchOverlay != null ||
        _face.revealing ||
        !_zoo.loaded) {
      return;
    }
    final egg = _zoo.readyEgg;
    if (_face.def == null && egg != null) {
      _hatch(egg);
      return;
    }
    if (_daemonOverlay == null) _face.boop();
    _toggleDaemon();
  }

  void _toggleDaemon({bool talk = false}) {
    _closeDaemonHint();
    if (_daemonOverlay != null) {
      _closeDaemon();
      return;
    }
    if (!_zoo.loaded ||
        _hatchOverlay != null ||
        _newHarness?.requestDismiss() == false) {
      return;
    }
    _closeNewHarness(restoreFocus: false);
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    _preparePaneFocus();
    _daemonOverlay = OverlayEntry(
      builder: (context) => _anchoredBesideSlot(
        onBarrierTap: _closeDaemon,
        child: DaemonPanel(
          key: ValueKey(_zoo.scope),
          face: _face,
          brain: _brain.active ? _brain : null,
          onAnswer: _answerLine,
          onOpenConversation: _zoo.isPreview || _pairHarness == null
              ? null
              : _openConversation,
          onOpenRules: _zoo.isPreview
              ? null
              : () => unawaited(_openPairRules()),
          talkShortcut: _keymap.hint('app.daemon_talk'),
          focusTalk: talk,
          onClose: _closeDaemon,
          onHatch: _hatch,
          shortcut: (command) => _keymap.hint(command),
          onCommand: (command) {
            _closeDaemon(restoreFocus: false);
            _runShortcut(command);
          },
        ),
      ),
    );
    Overlay.of(context).insert(_daemonOverlay!);
    _unregisterDaemon = registerTransientMenu(
      () => _closeDaemon(restoreFocus: false),
    );
    _face.look();
    _face.seen();
    if (_native) _syncNative();
    setState(() {});
  }

  /// The panel and the hatch reveal float above the status slot, at the bottom
  /// right, with a barrier that closes them: [cells] terminal cells wide at
  /// most (the reveal is wider, for a plate's 56 columns).
  Widget _anchoredBesideSlot({
    required Widget child,
    required VoidCallback onBarrierTap,
    int cells = 46,
  }) => LayoutBuilder(
    builder: (context, constraints) {
      final top = _native ? 0.0 : _tabBarHeight;
      final bottom = _statusBarHeight;
      return Stack(
        children: [
          Positioned.fill(
            top: top,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onBarrierTap,
              child: const SizedBox.expand(),
            ),
          ),
          Positioned(
            bottom: bottom + 8,
            right: 10,
            width: (constraints.maxWidth - 20).clamp(
              0,
              terminalCellSizeOf(context).width * cells,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: (constraints.maxHeight - top - bottom - 20).clamp(
                  0,
                  720,
                ),
              ),
              child: KeymapProvider(keymap: _keymap, child: child),
            ),
          ),
        ],
      );
    },
  );

  void _closeDaemon({bool restoreFocus = true}) {
    if (_daemonOverlay == null) return;
    _unregisterDaemon?.call();
    _unregisterDaemon = null;
    _daemonOverlay?.remove();
    _daemonOverlay?.dispose();
    _daemonOverlay = null;
    if (!mounted) return;
    if (_native) _syncNative();
    setState(() {});
    if (restoreFocus) _returnFocusToPane();
  }

  void _returnFocusToPane() {
    _shellFocus.requestFocus();
    if (app.focusedPane case final pane?) {
      app.focusPane(pane.id, reveal: true);
    }
  }

  /// Open an egg. The slot keeps showing the egg, and native hears nothing of
  /// the hatchling, until the reveal has finished.
  void _hatch(ZooEgg egg) {
    if (_hatchOverlay != null || _zoo.hatchingEgg != null || !mounted) return;
    _closeDaemon(restoreFocus: false);
    _closeDaemonHint();
    _closeSearch(restoreFocus: false);
    _closeCommandBar(restoreFocus: false);
    dismissTransientMenus();
    // After the person's third hatch, any key skips to the card.
    final skippable = _zoo.zoo.daemons.length >= 3;
    // A duplicate's level-up is told against the zoo before the hatch.
    final before = _zoo.zoo;
    _face.beginReveal(kind: egg.kind);
    final result = _zoo.hatch(egg.id);
    _preparePaneFocus();
    _hatchOverlay = OverlayEntry(
      builder: (context) => _anchoredBesideSlot(
        onBarrierTap: _closeHatch,
        cells: daemonRevealCells,
        child: DaemonHatchReveal(
          roster: _zoo.roster,
          egg: egg,
          result: result,
          zoo: () => _zoo.zoo,
          reduceMotion: _reduceMotion,
          skippable: skippable,
          before: before,
          // Nobody has said yet whether it may watch: after the card, the
          // first-day screen (README, "What your daemon sees").
          needsConsent: !_zoo.isPreview && before.consent == null,
          onConsent: (watching) => _zoo.consent(watching: watching),
          onSuggest: () => _zoo.autonomy('suggest'),
          plates: _plates,
          // The name it is given at the hatch (`zoo.nickname { uid, name }`).
          onName: _zoo.nickname,
          onStage: _face.revealAt,
          onRevealed: _face.endReveal,
          onClose: _closeHatch,
        ),
      ),
    );
    Overlay.of(context).insert(_hatchOverlay!);
    _unregisterHatch = registerTransientMenu(
      () => _closeHatch(restoreFocus: false),
    );
    if (_native) _syncNative();
    setState(() {});
  }

  void _closeHatch({bool restoreFocus = true}) {
    if (_hatchOverlay == null) return;
    _unregisterHatch?.call();
    _unregisterHatch = null;
    _hatchOverlay?.remove();
    _hatchOverlay?.dispose();
    _hatchOverlay = null;
    _face.endReveal();
    if (!mounted) return;
    if (_native) _syncNative();
    setState(() {});
    if (restoreFocus) _returnFocusToPane();
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
    if (_native) _syncNative();
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
    if (_native) _syncNative();
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
    if (_native) _syncNative();
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
    if (_native) _syncNative();
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
      noteFor: _easterNote,
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
    final deviceSearch = _search!;
    _searchDevice = DeviceFinder(
      deviceSearch,
      isComposing: () =>
          _searchText.value.composing.isValid &&
          !_searchText.value.composing.isCollapsed,
      dismiss: _dismissSearch,
      choose: (choice) async {
        if (!identical(_search, deviceSearch)) return false;
        final target = deviceSearch.targetId;
        _closeSearch(restoreFocus: false);
        final destination = choice.destination;
        _preparePaneFocus();
        if (destination.hasView ||
            app.paneOfAgent(destination.machineId!, destination.agentId!) !=
                null) {
          return app.revealAgentViewFromDevice(
            destination.machineId!,
            destination.agentId!,
            swarmId: destination.swarmId,
            paneId: destination.paneId,
          );
        }
        // A missing view follows the desktop's explicit Open/Resume path.
        await _activateSearch(SwarmSearchSelection(choice.destination), target);
        final pane = app.focusedPane;
        return mounted &&
            pane?.machineId == choice.destination.machineId &&
            pane?.agentId == choice.destination.agentId;
      },
    );
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

  /// The one easter word the window knows by heart: the box answers as the
  /// old adventure did. Any easter word (the roster holds only their hashes)
  /// is sent to the zoo once.
  String? _easterNote(String query) =>
      _zoo.loaded && query.trim().toLowerCase() == classicEasterWord
      ? 'Nothing happens.'
      : null;

  void _syncSearch() {
    final search = _search;
    if (search == null) return;
    if (_zoo.loaded) {
      final word = search.query.trim().toLowerCase();
      if (word.length >= 3 && _zoo.isEasterWord(word)) _zoo.easter(word);
    }
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
      if (_native) _syncNative();
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
    _searchDevice?.close();
    _searchDevice = null;
    _search!.removeListener(_syncSearch);
    _search!.dispose();
    _search = null;
    _dismissMachinePrompt();
    _modelSelectionTarget = null;
    _modelSearchVisible = false;
    app.modelManager.setPanelVisible(false);
    _pickerModels?.setVisible(false);
    _searchHeaderState = null;
    _searchText.clear();
    _syncToolbarNotices();
    if (_native && mounted) _syncNative();
    _searchFocus.unfocus();
    final previous = _searchReturnFocus;
    _searchReturnFocus = null;
    if (restoreFocus) {
      if (previous?.context?.mounted == true && previous!.canRequestFocus) {
        previous.requestFocus();
      } else if (!_focusWorkspaceInput()) {
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
      // A saved API's model. Decided first: the rest of this branch reads "no grid model" as the
      // pane's own login, and would move the agent there.
      if (search.selectableApiModel(choice.destination) case (
        :final api,
        :final model,
      )) {
        final now = WorkspacePaneContext.focused(app)!;
        _closeSearch();
        if (!agentOnApiModel(now.agent, api, model.id)) {
          await app.retargetAgentToApiModel(
            now.pane.machineId,
            now.agentId!,
            connectionId: api.id,
            modelId: model.id,
          );
        }
        return;
      }
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
      _noteFound();
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
    if (!choice.destination.isCommand) _noteFound();
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

  Future<void> _showNotificationInbox() => _dialog(() async {
    await showNotificationInbox(
      context,
      app: app,
      topInset: _native ? 0 : _tabBarHeight,
      onOpen: (row) async {
        final destination = swarmDestinations(app)
            .where(
              (item) =>
                  item.machineId == row.machineId &&
                  item.agentId == row.agentId,
            )
            .firstOrNull;
        if (destination == null) return false;
        final readToken = app.agentUnread.readTokenFor(row.machineId, row.agentId);
        final questionId = app.questionFor(row.machineId, row.agentId)?.requestId;
        final opened = await activateSwarmDestination(
          app,
          destination,
          destinationSwarmId: app.activeSwarmId,
        );
        // Opening acknowledges this notification. Its question stays pending
        // until the daemon confirms an answer, independently of unread state.
        if (opened &&
            app.agentUnread.readTokenFor(row.machineId, row.agentId) == readToken &&
            app.questionFor(row.machineId, row.agentId)?.requestId == questionId) {
          app.readAgentNotification(row.machineId, row.agentId, readToken: readToken);
        }
        return opened;
      },
    );
  });

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
    if (kIsWeb && app.requestedMachineLink == null) {
      _maybeInitialBrowserMachines();
      return;
    }
    final machine = app.stateOf(
      app.requestedMachineLink ?? app.selectedMachineId ?? '',
    );
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
        app.acknowledgeMachineLinkRequest(machine.machine.machineId);
        await _openMachines(initialMachineId: machine.machine.machineId);
      }
      // Keep the prompt's identity until the picker closes. Otherwise Escape
      // would immediately reopen it on the next workspace update.
      if (_search?.isMachineMode != true) _linkDialogMachineId = null;
    });
  }

  bool get _hasConnectedBrowserMachine => app.machineStates.values.any(
    (machine) =>
        !machine.machine.isShared &&
        !machine.needsLink &&
        machine.nodeOnline != false &&
        machine.connectionStatus == ConnectionStatus.connected,
  );

  bool get _browserMachineSetupReady =>
      app.machineInventoryLoaded &&
      !app.machinesLoading &&
      !app.machinesAreStale &&
      app.machineListError == null &&
      !app.machineStates.values.any(
        (machine) =>
            !machine.machine.isShared &&
            !machine.needsLink &&
            machine.nodeOnline != false &&
            (machine.connectionStatus == ConnectionStatus.connecting ||
                machine.connectionStatus == ConnectionStatus.reconnecting),
      ) &&
      !_dialogOpen &&
      !_commandBarOpen &&
      !_spokenPaletteOpen &&
      _newHarness == null &&
      _search == null &&
      _routeIsCurrent;

  void _maybeInitialBrowserMachines() {
    if (_browserMachineSetupHandled) return;
    if (_hasConnectedBrowserMachine) {
      _browserMachineSetupHandled = true;
      return;
    }
    // Discovery and saved links restore asynchronously. An unlinked row must
    // not cover the workspace while another machine is still reconnecting.
    if (!_browserMachineSetupReady) return;
    _browserMachineSetupHandled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // A connection or a deliberate user action may have won this frame.
      if (!mounted ||
          _hasConnectedBrowserMachine ||
          !_browserMachineSetupReady) {
        return;
      }
      final selected = app.stateOf(app.selectedMachineId ?? '');
      unawaited(
        _openMachines(
          initialMachineId: selected?.needsLink == true
              ? selected!.machine.machineId
              : null,
        ),
      );
    });
  }

  void _dismissMachinePrompt() {
    final id = _linkDialogMachineId;
    _linkDialogMachineId = null;
    if (id != null && app.stateOf(id)?.needsLink == true) {
      app.dismissLinkPrompt(id);
    }
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
    ShortcutAction.shareAgent: _shareAgent,
    ShortcutAction.routeTask: () =>
        _dialog(() => showTaskPalette(context, app)),
    ShortcutAction.orchestrate: () =>
        _dialog(() => showOrchestratorLauncher(context, app)),
    ShortcutAction.team: () =>
        _dialog(() => showChannelWorkspace(context, app)),
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
        experimentalFeatures: _experimentalFeatures,
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
    'app.add_phone': () => unawaited(_addPhone()),
    'app.store': _openStore,
    'app.daemon': _toggleDaemon,
    'app.daemon_talk': _talkToDaemon,
    'agent.add': _addAgent,
    if (kDebugSurfaceEnabled) 'app.onboarding_review': _newTab,
    'agent.rename': () => _editAgent(),
    'agent.work': () async {
      final focused = WorkspacePaneContext.focused(app);
      if (focused != null) await _showSessionWork(focused);
    },
    'agent.stop': () => _editAgent(stop: true),
    'agent.fork': _forkAgent,
    'pane.toggle_viewer': _toggleFocusedViewer,
    'pane.toggle_composer': () {
      if (app.focusedPaneId case final id?) app.toggleComposer(id);
    },
    // `agent.restart` and `agent.clone` come from `_actionHandlers` above:
    // both carry a ShortcutAction, so the loop already binds them.
    'machine.link': _openMachines,
    'machines.manage': _manageMachines,
    'machines.list': _openMachines,
    'models.list': _togglePaneModels,
    'harnesses.list': _toggleSessions,
    'harnesses.manage': _toggleHarnessControls,
    'machines.connections': _openMachines,
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
        !harnessCommandActive(id) ||
        !_routeIsCurrent ||
        _dialogOpen ||
        _spokenPaletteOpen) {
      return false;
    }
    if (id == 'keyboard.open_config') return _keymap.store != null;
    if (id == 'agent.work') {
      return WorkspacePaneContext.focused(app)?.agent != null;
    }
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
    if (id == 'app.onboarding_review') {
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
      ?mode('app.daemon', 'Daemon', 'Your zoo · hatch · pair · nap'),
      ?mode('app.daemon_talk', 'Talk to daemon', 'Ask your paired daemon'),
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
      } else if (!_focusWorkspaceInput()) {
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
  Widget build(BuildContext context) => _buildWorkspace(context);

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
                    Focus(
                      focusNode: _tabStripFocus,
                      onKeyEvent: _onTabStripKey,
                      child: _native
                          ? const SizedBox.shrink()
                          : MediaQuery.withNoTextScaling(child: _tabStrip()),
                    ),
                    if (_learning.active)
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
                                    : const EdgeInsets.fromLTRB(
                                        kWorkspaceInset,
                                        kWorkspaceInset,
                                        kWorkspaceInset,
                                        0,
                                      ),
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
                                                            _learning.offer
                                                            ? _startQuickStart
                                                            : null,
                                                        onPractice:
                                                            _practiceKeyboard,
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
                    MediaQuery.withNoTextScaling(
                      child: _native
                          ? SizedBox(
                              key: const ValueKey('workspace-status-bar'),
                              height: _statusBarHeight,
                              child: _focusedModelPicker(
                                WorkspacePaneContext.focused(app),
                                menuOnly: true,
                              ),
                            )
                          : _statusBar(),
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
      subscriptionEffort: focused.agent?.modelEffort,
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

  // Include the pane's former bottom gutter in this row, so its controls sit
  // halfway between the pane edge and window bottom. Pane height is unchanged.
  double get _statusBarHeight =>
      workspaceBarControlHeight(context) + kWorkspaceInset;

  Widget _statusBar() => LayoutBuilder(
    builder: (context, constraints) {
      final cell = workspaceBarCellSizeOf(context);
      final focused = WorkspacePaneContext.focused(app);
      final prefs = appearancePrefsStore.value.prompt;
      final parts = focused?.format(prefs);
      final pr = _pullRequest.value;
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final joined =
          prefs.statusStyle.segmented &&
          parts != null &&
          parts.segments.isNotEmpty &&
          pr != null;
      final prBackground = !joined
          ? null
          : statusLinePaintSegments(
              pullRequestStatusLineParts(
                number: pr.number,
                state: pr.state,
                style: prefs.statusStyle,
              ),
              theme,
              color: prefs.color,
              segmentOffset: parts.segments.length,
            ).single.background;
      final available = math.max(0.0, constraints.maxWidth - cell.width * 2);
      final daemonWidth = _slotShown
          ? math.min(
              cell.width * (_face.roster.rules.statusCells + 2),
              available * .5,
            )
          : 0.0;
      final shareWidth = _showShareButton
          ? math.min(WorkspaceShareButton.widthOf(context), available * .3)
          : 0.0;
      final downloadWidth = kIsWeb ? available * .16 : 0.0;
      final modelWidth =
          math.max(
            0.0,
            available -
                daemonWidth -
                shareWidth -
                downloadWidth -
                cell.width * 5,
          ) *
          .4;
      final paneContext = Row(
        children: [
          if (focused != null)
            Flexible(
              child: WorkspaceStatusLine(
                key: const ValueKey('workspace-pane-context'),
                parts: parts!,
                links: _contextLinks(focused),
                color: prefs.color,
                nextBackground: prBackground,
              ),
            ),
          if (pr != null) ...[
            if (!joined) SizedBox(width: cell.width),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: constraints.maxWidth * .2),
              child: WorkspaceBarControl(
                key: const ValueKey('workspace-pull-request'),
                label: '${pr.label} — Open on GitHub',
                tooltip: '${pr.label} — Open on GitHub',
                onPressed: _shortcutsEnabled
                    ? () => _openFocusedPullRequest(pr.url.toString())
                    : null,
                builder: (context, emphasized) => WorkspacePullRequestLabel(
                  number: pr.number,
                  state: pr.state,
                  emphasized: emphasized,
                  color: prefs.color,
                  style: prefs.statusStyle,
                  segmentOffset: parts?.segments.length ?? 0,
                ),
              ),
            ),
          ],
        ],
      );
      return Material(
        key: const ValueKey('workspace-status-bar'),
        type: MaterialType.transparency,
        child: SizedBox(
          height: _statusBarHeight,
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: cell.width),
            child: Row(
              children: [
                Expanded(
                  child: _zoo.loaded
                      ? DaemonVoiceLine(
                          face: _face,
                          brain: _brain,
                          onAnswer: _shortcutsEnabled ? _answerDaemon : null,
                          fallback: paneContext,
                        )
                      : paneContext,
                ),
                if (kIsWeb) ...[
                  SizedBox(width: cell.width),
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: downloadWidth),
                    child: const WebDownloadButton(),
                  ),
                ],
                if (_slotShown)
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: daemonWidth),
                    child: DaemonSlotButton(
                      face: _face,
                      tooltip: () => _daemonTooltip,
                      selected: _daemonOverlay != null,
                      onPressed: _activateDaemon,
                    ),
                  ),
                if (_showShareButton) ...[
                  SizedBox(width: cell.width),
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: shareWidth),
                    child: WorkspaceShareButton(
                      key: const ValueKey('workspace-share-button'),
                      label: _shareLabel(focused),
                      tooltip: _shareTooltip(focused),
                      onPressed: _canExecuteCommand('agent.share')
                          ? () => _runShortcut('agent.share')
                          : null,
                    ),
                  ),
                ],
                if (focused != null && modelPickerSupports(focused.engine)) ...[
                  SizedBox(width: cell.width * 2),
                  ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: modelWidth),
                    child: _focusedModelPicker(focused),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    },
  );

  Widget _tabStrip() => LayoutBuilder(
    builder: (context, constraints) {
      final cell = workspaceBarCellSizeOf(context);
      final theme = terminalThemeFor(
        grid.AppTheme.palette.value,
        terminalThemeStore.value,
      );
      final names = workspaceTabNames(app);
      final activities = [for (final tab in app.swarms) tabActivity(app, tab)];
      final labels = [
        for (var index = 0; index < app.swarms.length; index++)
          '${index + 1}:${names[app.swarms[index].id]}',
      ];
      final toolHeight = workspaceBarControlHeight(context);
      final prefs = appearancePrefsStore.value.prompt;
      final storeWidth = math.min(
        WorkspaceStoreButton.widthOf(context),
        math.max(0.0, constraints.maxWidth - cell.width * 14),
      );
      final tabBudget = math.max(
        0.0,
        constraints.maxWidth - cell.width * 6 - storeWidth - cell.width * 8,
      );
      _tabWidths = [
        for (var i = 0; i < labels.length; i++)
          math.max(
            activities[i] == null ? 0 : ('${i + 1}:'.length + 4) * cell.width,
            math.min(
              math.min(
                    labels[i].characters.length +
                        2 +
                        (activities[i] == null ? 0 : 2),
                    24,
                  ) *
                  cell.width,
              tabBudget,
            ),
          ),
      ];
      final total = _tabWidths.fold(0.0, (sum, width) => sum + width);
      final tabsWidth = math.min(total, tabBudget);
      _revealSelectedTab(tabsWidth);
      return Material(
        key: const ValueKey('workspace-tab-bar'),
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
                    final activity = activities[index];
                    final nameHint = workspaceTabTooltip(
                      labels[index],
                      swarm.name,
                      clipped:
                          workspaceBarTextSizeOf(context, labels[index]).width +
                              (activity == null ? 0 : cell.width * 2) >
                          _tabWidths[index] - cell.width * 2,
                    );
                    final tabHint = [
                      ?nameHint,
                      if (activity != null) activity.label,
                    ].join('\n');
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
                              label:
                                  '${labels[index]}: ${swarm.name}${activity == null ? '' : ', ${activity.label}'}',
                              tooltip: tabHint.isEmpty ? null : tabHint,
                              selectedBackground: grid.AppPalette.swarmWelcome,
                              selected: selected,
                              highlighted:
                                  selected &&
                                  app.tabStripFocused &&
                                  _tabStripFocus.hasPrimaryFocus,
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
                                    child: activity == null
                                        ? Text(
                                            labels[index],
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            textAlign: TextAlign.center,
                                            style: workspaceBarTextStyle(
                                              color: theme.foreground,
                                              emphasized: emphasized,
                                            ),
                                          )
                                        : Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Text(
                                                '${index + 1}:',
                                                style: workspaceBarTextStyle(
                                                  color: theme.foreground,
                                                  emphasized: emphasized,
                                                ),
                                              ),
                                              Flexible(
                                                child: Text(
                                                  names[swarm.id]!,
                                                  maxLines: 1,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                  style: workspaceBarTextStyle(
                                                    color: theme.foreground,
                                                    emphasized: emphasized,
                                                  ),
                                                ),
                                              ),
                                              SizedBox(width: cell.width),
                                              ListenableBuilder(
                                                listenable: _tabScroll,
                                                builder: (context, _) {
                                                  final left = _tabWidths
                                                      .take(index)
                                                      .fold(
                                                        0.0,
                                                        (a, b) => a + b,
                                                      );
                                                  final offset =
                                                      _tabScroll.hasClients
                                                      ? _tabScroll.offset
                                                      : 0.0;
                                                  return ActivityMark(
                                                    key: ValueKey(
                                                      'tab-activity:${swarm.id}',
                                                    ),
                                                    activity: activity,
                                                    color: activityColor(
                                                      activity,
                                                      theme,
                                                      color: prefs.color,
                                                    ),
                                                    emphasized: emphasized,
                                                    tooltip: false,
                                                    visible:
                                                        left <
                                                            offset +
                                                                tabsWidth &&
                                                        left + _tabWidths[index] >
                                                            offset,
                                                  );
                                                },
                                              ),
                                            ],
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
              const Spacer(),
              WorkspaceBarControl(
                key: const ValueKey('swarm-search-button'),
                label: 'Search harnesses',
                tooltip:
                    'Search harnesses ${_keymap.hint('harnesses.list') ?? ''}',
                onPressed: _shortcutsEnabled ? _toggleSessions : null,
                builder: (context, emphasized) => SizedBox(
                  width: cell.width * 4,
                  height: toolHeight,
                  child: Icon(
                    LucideIcons.search,
                    size: 17,
                    color: theme.foreground.withValues(
                      alpha: !_shortcutsEnabled
                          ? .28
                          : emphasized
                          ? 1
                          : .75,
                    ),
                  ),
                ),
              ),
              WorkspaceNotificationsButton(
                key: const ValueKey('workspace-notifications-button'),
                count: _unread,
                foreground: theme.foreground,
                onPressed: _shortcutsEnabled ? _showNotificationInbox : null,
              ),
              WorkspaceStoreButton(
                key: const ValueKey('swarm-store-button'),
                width: storeWidth,
                tooltip: 'Harness Store ${_keymap.hint('app.store') ?? ''}',
                onPressed: _shortcutsEnabled ? _openStore : null,
              ),
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
